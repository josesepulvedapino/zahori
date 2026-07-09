import { type Page, type Request, type Response } from 'playwright';
import type { Profile, Step, SniffRule } from './profile.js';
import { launchBrowser, newBrowserContext } from './browser.js';
import { kindFromUrl, kindFromContentType, analyzeManifest, type ManifestFacts } from './classify.js';
import { parseAudioTracks, resolveUri, selectAudioTrack } from './hls.js';
import { DrmError, NoStreamError, type StreamKind, type StreamResult } from './types.js';

interface Candidate {
  url: string;
  kind: StreamKind;
  headers: Record<string, string>;
}

const DEFAULT_TIMEOUT = 45_000;

export const DEFAULT_OVERLAY_SELECTORS = [
  // Consent-management platforms (cover a large share of the web).
  '#onetrust-accept-btn-handler',
  '#didomi-notice-agree-button',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  '#truste-consent-button',
  '.fc-cta-consent',
  // Generic cookie banners, several languages.
  '[id*="cookie" i] button',
  '[class*="cookie" i] button',
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
  'button:has-text("Aceptar")',
  'button:has-text("Agree")',
  'button:has-text("I agree")',
  'button:has-text("Accepter")',
  'button:has-text("Akzeptieren")',
  'button:has-text("Zustimmen")',
  '[aria-label*="close" i]',
];

export const DEFAULT_PLAY_SELECTORS = [
  // Big-play buttons of the common web players.
  '.vjs-big-play-button', // video.js (also Brightcove)
  '.jw-display-icon-container', // JW Player
  '.jw-icon-display',
  '.plyr__control--overlaid', // Plyr
  '.mejs__overlay-button', // MediaElement.js
  '.fp-play', // Flowplayer
  '.largePlayBtn', // Kaltura (legacy)
  '.playkit-pre-playback-play-button', // Kaltura (playkit)
  '.flowplayer .fp-ui',
  // Generic affordances, several languages.
  'button[aria-label*="play" i]',
  'button[aria-label*="reproducir" i]',
  'button[title*="play" i]',
  '[class*="play-button" i]',
  '[class*="btn-play" i]',
  'video',
];

function pickHeaders(req: Request, wanted: string[]): Record<string, string> {
  const all = req.headers();
  const out: Record<string, string> = {};
  for (const h of wanted) {
    const v = all[h.toLowerCase()];
    if (v) out[h] = v;
  }
  return out;
}

function matchesSniff(url: string, kind: StreamKind, sniff: SniffRule): boolean {
  if (!sniff.kinds.includes(kind)) return false;
  if (sniff.urlExclude && new RegExp(sniff.urlExclude, 'i').test(url)) return false;
  if (sniff.urlPattern && !new RegExp(sniff.urlPattern, 'i').test(url)) return false;
  return true;
}

/**
 * Click the selector in the first frame (main page or any iframe) where it is
 * visible right now. Web players often live inside embed iframes,
 * so a main-frame-only click misses them entirely. Existence is checked
 * instantly per frame (no per-frame waiting), so long selector lists stay fast.
 */
async function clickInAnyFrame(page: Page, selector: string, clickTimeoutMs = 2_000): Promise<boolean> {
  for (const frame of page.frames()) {
    const el = await frame.$(selector).catch(() => null);
    if (!el) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const ok = await el.click({ timeout: clickTimeoutMs }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  return false;
}

/** Like clickInAnyFrame, but polls until the element shows up or time runs out. */
async function waitAndClickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await clickInAnyFrame(page, selector)) return true;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return false;
}

/** Programmatically start every <video>/<audio> element, in every frame. */
async function nudgeAutoplay(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        for (const el of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
          el.muted = true;
          void el.play().catch(() => {});
        }
      })
      .catch(() => {});
  }
}

/** Poll every frame for the selector until it exists or time runs out. */
async function waitForInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames()) {
      const el = await frame.$(selector).catch(() => null);
      if (el) return true;
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return false;
}

async function runStep(page: Page, step: Step, inputUrl: string, deadline: number): Promise<void> {
  const remaining = Math.max(1_000, deadline - Date.now());
  switch (step.action) {
    case 'goto':
      await page.goto(step.url ?? inputUrl, { waitUntil: step.waitUntil, timeout: remaining });
      break;
    case 'waitFor':
      if (step.selector) await waitForInAnyFrame(page, step.selector, remaining);
      if (step.ms) await page.waitForTimeout(step.ms);
      break;
    case 'click':
      if (!(await waitAndClickInAnyFrame(page, step.selector, Math.min(8_000, remaining))) && !step.optional) {
        throw new Error(`click: selector not found in any frame: ${step.selector}`);
      }
      break;
    case 'dismissOverlays': {
      const selectors = step.selectors.length ? step.selectors : DEFAULT_OVERLAY_SELECTORS;
      for (const sel of selectors) {
        await clickInAnyFrame(page, sel);
      }
      break;
    }
    case 'play': {
      const selectors = step.selectors.length ? step.selectors : DEFAULT_PLAY_SELECTORS;
      for (const sel of selectors) {
        if (await clickInAnyFrame(page, sel)) break;
      }
      // Belt and braces: some players only start via the media element API.
      await nudgeAutoplay(page);
      break;
    }
    case 'scroll':
      await page.evaluate((to) => window.scrollTo(0, to === 'bottom' ? document.body.scrollHeight : 0), step.to);
      break;
    case 'eval':
      await page.evaluate(step.script).catch(() => {});
      break;
  }
}

/**
 * Execute a profile against a URL and return the resolved stream. The network
 * sniff runs on every invocation, so signed/expiring URLs are always fresh.
 */
export interface RunOptions {
  timeoutMs?: number | undefined;
  headful?: boolean | undefined;
  /** Preferred audio language; overrides the profile's pick.audioLanguage. */
  audioLanguage?: string | undefined;
}

export async function runProfile(
  profile: Profile,
  inputUrl: string,
  opts: RunOptions = {},
): Promise<StreamResult> {
  const browser = await launchBrowser(opts.headful ?? false);
  try {
    const ctx = await newBrowserContext(browser);
    const page = await ctx.newPage();
    return await runProfileOnPage(page, profile, inputUrl, opts);
  } finally {
    await browser.close();
  }
}

/**
 * Like runProfile, but drives a page the caller already owns (bring-your-own
 * browser). This is how probe() observes the traffic its own page triggers, and
 * how embedders run zahori inside an authenticated Playwright context (e.g. a
 * context with storage state for sites behind a login). The page is left open
 * for the caller; the sniffing listeners are removed before returning.
 */
export async function runProfileOnPage(
  page: Page,
  profile: Profile,
  inputUrl: string,
  opts: RunOptions = {},
): Promise<StreamResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const candidates: Candidate[] = [];

  const onRequest = (req: Request) => {
    const url = req.url();
    const kind = kindFromUrl(url);
    if (!kind) return;
    if (!matchesSniff(url, kind, profile.sniff)) return;
    candidates.push({ url, kind, headers: pickHeaders(req, profile.sniff.replayHeaders) });
  };
  // Some players expose the manifest only via the response content-type.
  const onResponse = (res: Response) => {
    const url = res.url();
    if (kindFromUrl(url)) return; // already handled by extension
    const kind = kindFromContentType(res.headers()['content-type']);
    if (!kind || !matchesSniff(url, kind, profile.sniff)) return;
    candidates.push({ url, kind, headers: pickHeaders(res.request(), profile.sniff.replayHeaders) });
  };

  try {
    page.on('request', onRequest);
    page.on('response', onResponse);

    const steps: Step[] = profile.steps.length
      ? profile.steps
      : [{ action: 'goto', waitUntil: 'domcontentloaded' } as Step, { action: 'play', selectors: [] } as Step];

    const deadline = Date.now() + timeout;
    for (const step of steps) {
      if (Date.now() > deadline) break;
      await runStep(page, step, inputUrl, deadline);
    }

    // Give late-loading players time to fire the media request, re-nudging
    // playback halfway through in case the player attached listeners late.
    const waitBudget = Math.max(8_000, deadline - Date.now());
    const waitStart = Date.now();
    let nudged = false;
    while (candidates.length === 0 && Date.now() - waitStart < waitBudget) {
      await page.waitForTimeout(500);
      if (!nudged && Date.now() - waitStart > waitBudget / 2) {
        nudged = true;
        await nudgeAutoplay(page);
      }
    }

    if (candidates.length === 0) throw new NoStreamError(inputUrl, profile.id);

    // Let sibling requests (master vs rendition, alt kinds) land before picking.
    await page.waitForTimeout(1_500);

    const chosen = pickCandidate(candidates, profile);
    const { facts, text } = await analyzeCandidate(page, chosen);
    if (facts.drm) throw new DrmError(chosen.url);

    let url = chosen.url;
    let live = facts.live;
    let audio: StreamResult['audio'];

    // Multilingual masters: swap the master for the requested audio rendition.
    const wantedLanguage = opts.audioLanguage ?? profile.pick.audioLanguage;
    const wantsAudioRendition =
      wantedLanguage !== undefined ||
      profile.pick.audioLanguageFallbacks.length > 0 ||
      profile.pick.variant === 'audio-only';
    if (chosen.kind === 'hls' && facts.isMaster && wantsAudioRendition && text) {
      const selected = selectAudioTrack(parseAudioTracks(text), {
        language: wantedLanguage,
        languageMap: profile.pick.languageMap,
        fallbacks: profile.pick.audioLanguageFallbacks,
      });
      if (selected) {
        url = resolveUri(chosen.url, selected.track.uri);
        audio = {
          language: selected.track.language,
          name: selected.track.name,
          matchedBy: selected.matchedBy,
        };
        // The master can't tell live vs VOD; the media playlist can.
        const rendition = await fetchTextInPage(page, url);
        if (rendition) {
          const renditionFacts = analyzeManifest(rendition, 'hls');
          if (renditionFacts.drm) throw new DrmError(url);
          live = renditionFacts.live;
        }
      }
    }

    return {
      url,
      kind: chosen.kind,
      live,
      headers: chosen.headers,
      profileId: profile.id,
      candidates: candidates.map((c) => c.url),
      ...(audio ? { audio } : {}),
    };
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

function pickCandidate(candidates: Candidate[], profile: Profile): Candidate {
  const byPriority = [...profile.sniff.kinds];
  const sorted = [...candidates].sort((a, b) => byPriority.indexOf(a.kind) - byPriority.indexOf(b.kind));
  const preferred = sorted.filter((c) => c.kind === sorted[0]!.kind);
  return profile.pick.order === 'last' ? preferred[preferred.length - 1]! : preferred[0]!;
}

/** Fetch a URL from inside the page (so its cookies/referer apply). */
async function fetchTextInPage(page: Page, url: string): Promise<string | undefined> {
  try {
    return await page.evaluate(async (u) => {
      const r = await fetch(u);
      return await r.text();
    }, url);
  } catch {
    return undefined;
  }
}

/** Fetch the chosen manifest inside the browser (so headers/cookies apply) and analyze it. */
async function analyzeCandidate(
  page: Page,
  chosen: Candidate,
): Promise<{ facts: ManifestFacts; text: string | undefined }> {
  if (chosen.kind === 'mp4' || chosen.kind === 'audio') {
    return { facts: { live: false, isMaster: false, drm: false, segmentCount: 0 }, text: undefined };
  }
  const text = await fetchTextInPage(page, chosen.url);
  if (text === undefined) {
    return { facts: { live: undefined, isMaster: false, drm: false, segmentCount: 0 }, text: undefined };
  }
  return { facts: analyzeManifest(text, chosen.kind), text };
}
