import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchBrowser, newBrowserContext } from './browser.js';
import { kindFromUrl, kindFromContentType } from './classify.js';
import { GENERIC_PROFILE, parseProfile, type Profile } from './profile.js';
import { runProfile, runProfileOnPage } from './runtime.js';
import { validate, type OracleOptions, type OracleResult } from './oracle.js';
import { userProfileDir } from './loader.js';
import type { StreamKind, StreamResult } from './types.js';

/**
 * The discovery primitives are the shared ground the intelligence layers stand
 * on. Both drive them identically:
 *   - a coding agent (via the MCP server), using its own model
 *   - the headless loop (via a BYO-key model), for unattended runs
 *
 * probe() gathers everything needed to author a profile for a new site.
 * testProfile() runs a candidate profile and grades it with the oracle.
 * saveProfile() persists a working profile so later runs are instant and free.
 *
 * The intelligence only proposes profiles; these primitives execute and verify
 * them deterministically. That objective loop (propose -> run -> oracle) is what
 * makes unattended repair trustworthy.
 */

/** A media request seen while probing, before any profile filtered it. */
export interface ProbeCandidate {
  url: string;
  kind: StreamKind;
  /** How it was detected: by URL extension or by response content-type. */
  via: 'url' | 'content-type';
  /** Header names present on the request that are useful to replay. */
  replayableHeaders: string[];
}

/** A clickable element that might start playback or dismiss an overlay. */
export interface ElementHint {
  frameUrl: string;
  tag: string;
  /** A stable-ish CSS selector to reach it. */
  selector: string;
  text: string;
  reason: string;
}

/** Everything an intelligence layer needs to author a profile for a URL. */
export interface ProbeResult {
  url: string;
  /** The result of just running the built-in generic flow, if it worked. */
  generic?: StreamResult;
  genericError?: string;
  /** All media-ish requests seen during the generic run (unfiltered). */
  candidates: ProbeCandidate[];
  /** iframes on the page (players usually live in one). */
  frames: string[];
  /** Play/overlay affordances found in the DOM, across all frames. */
  elements: ElementHint[];
  /** Free-form notes to help a model reason about the page. */
  hints: string[];
}

const MEDIA_HINT = /\.(m3u8|mpd|mp4|m4v|m4a|mp3|aac|ts)(\?|$)|manifest|playlist|playmanifest|\/hls\/|\/dash\//i;

/**
 * Open the page, run the generic flow, and collect structured context: which
 * media requests fired, which iframes exist, and which elements look like play
 * or consent controls. Never throws for a missing stream; a probe of a page
 * with no stream is still useful signal for the model.
 */
export async function probe(
  url: string,
  opts: { timeoutMs?: number | undefined; headful?: boolean | undefined } = {},
): Promise<ProbeResult> {
  const browser = await launchBrowser(opts.headful ?? false);
  const seen = new Map<string, ProbeCandidate>();
  const record = (u: string, kind: StreamKind, via: ProbeCandidate['via'], headerNames: string[]) => {
    if (!seen.has(u)) seen.set(u, { url: u, kind, via, replayableHeaders: headerNames });
  };

  try {
    const ctx = await newBrowserContext(browser);
    const page = await ctx.newPage();

    page.on('request', (req) => {
      const u = req.url();
      const kind = kindFromUrl(u);
      if (!kind && !MEDIA_HINT.test(u)) return;
      const names = Object.keys(req.headers()).filter((h) =>
        ['referer', 'origin', 'user-agent', 'cookie', 'authorization'].includes(h.toLowerCase()),
      );
      record(u, kind ?? 'hls', 'url', names);
    });
    page.on('response', (res) => {
      const u = res.url();
      if (kindFromUrl(u)) return;
      const kind = kindFromContentType(res.headers()['content-type']);
      if (!kind) return;
      record(u, kind, 'content-type', ['referer', 'origin', 'user-agent']);
    });

    // Run the generic flow on THIS page, so the listeners above see every
    // request it triggers and the frame/element census reflects the real page.
    let generic: StreamResult | undefined;
    let genericError: string | undefined;
    try {
      generic = await runProfileOnPage(page, GENERIC_PROFILE, url, {
        timeoutMs: opts.timeoutMs,
      });
    } catch (e) {
      genericError = (e as Error).message;
    }

    const frames = page.frames().map((f) => f.url()).filter((u) => u && u !== 'about:blank');
    const elements = await collectElementHints(page);

    const hints: string[] = [];
    if (generic) hints.push(`Generic flow already resolved a ${generic.kind} stream.`);
    if (!generic && seen.size > 0) hints.push('Media requests fired but the generic pick failed; a targeted sniff/pick may be needed.');
    if (!generic && seen.size === 0 && frames.length > 0) hints.push('No media requests; the player likely needs a click inside an iframe first.');
    if (frames.length > 0) hints.push(`${frames.length} iframe(s) present.`);

    return {
      url,
      ...(generic ? { generic } : {}),
      ...(genericError ? { genericError } : {}),
      candidates: [...seen.values()],
      frames: [...new Set(frames)],
      elements,
      hints,
    };
  } finally {
    await browser.close();
  }
}

/** Walk every frame and surface elements that look like play or consent controls. */
async function collectElementHints(page: Page): Promise<ElementHint[]> {
  const out: ElementHint[] = [];
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => {
        const hits: { tag: string; selector: string; text: string; reason: string }[] = [];
        const sel = (el: Element): string => {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const cls = (el.getAttribute('class') || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((c) => `.${CSS.escape(c)}`)
            .join('');
          return el.tagName.toLowerCase() + cls;
        };
        const looksPlay = /play|reproduc|watch|ver\b|listen|escuch/i;
        const looksConsent = /accept|agree|consent|cookie|aceptar|acepto|zustimm|accepter/i;
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], video, audio, [class*="play" i], [aria-label]'));
        for (const el of nodes.slice(0, 400)) {
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 60);
          const tag = el.tagName.toLowerCase();
          if (tag === 'video' || tag === 'audio') {
            hits.push({ tag, selector: tag, text: label, reason: 'media element' });
          } else if (looksPlay.test(label) || looksPlay.test(el.className?.toString?.() || '')) {
            hits.push({ tag, selector: sel(el), text: label, reason: 'looks like play' });
          } else if (looksConsent.test(label)) {
            hits.push({ tag, selector: sel(el), text: label, reason: 'looks like consent' });
          }
          if (hits.length >= 25) break;
        }
        return hits;
      })
      .catch(() => [] as { tag: string; selector: string; text: string; reason: string }[]);
    for (const h of found) out.push({ frameUrl: frame.url(), ...h });
  }
  return out;
}

/** Grade of a candidate profile: did it produce a stream the oracle trusts? */
export interface ProfileTest {
  ok: boolean;
  result?: StreamResult;
  verdict?: OracleResult;
  error?: string;
}

/**
 * Run a candidate profile against a URL and grade the result with the oracle.
 * This is the objective judge the intelligence loop iterates against: ok=true
 * only when a stream was captured AND the oracle says it is real media.
 */
export async function testProfile(
  profile: Profile,
  url: string,
  opts: {
    timeoutMs?: number | undefined;
    headful?: boolean | undefined;
    oracle?: OracleOptions | undefined;
    skipOracle?: boolean | undefined;
  } = {},
): Promise<ProfileTest> {
  let result: StreamResult;
  try {
    result = await runProfile(parseProfile(profile), url, {
      timeoutMs: opts.timeoutMs,
      headful: opts.headful,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (opts.skipOracle) return { ok: true, result };
  const verdict = await validate(result, opts.oracle);
  return { ok: verdict.verdict === 'pass', result, verdict };
}

/** Write a profile to a directory as `<id>.json`, creating the directory. */
export async function saveProfile(profile: Profile, dir: string): Promise<string> {
  const parsed = parseProfile(profile);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${parsed.id}.json`);
  await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return path;
}

/**
 * Default place to save a learned profile. Prefers the current project so the
 * profile is committed and travels to production and teammates; the global dir
 * is only the fallback for one-off use outside any project.
 */
export function defaultSaveDir(opts: { project?: boolean } = {}): string {
  if (opts.project === false) return userProfileDir();
  return join(process.cwd(), '.zahori', 'profiles');
}

/** Derive a stable profile id from a URL's hostname (e.g. "tv-example-org"). */
export function profileIdFromUrl(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep raw */
  }
  return host.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'site';
}

/**
 * Anchored match pattern for a URL's host (subdomain-tolerant, www stripped).
 * Anchoring matters: an unanchored "acme\.example" would also match
 * "https://evil.example/?ref=acme.example".
 */
export function hostPattern(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep raw */
  }
  const escaped = host.replace(/^www\./, '').replace(/[.\\+*?^$()[\]{}|]/g, '\\$&');
  return `^https?://([^/]*\\.)?${escaped}([/:?#]|$)`;
}
