import { generateObject } from 'ai';
import { z } from 'zod';
import { GENERIC_PROFILE, PickRule, SniffRule, Step, parseProfile, type Profile } from '../profile.js';
import {
  probe,
  testProfile,
  saveProfile,
  defaultSaveDir,
  profileIdFromUrl,
  hostPattern,
  type ProbeResult,
  type ProfileTest,
} from '../discover.js';
import { resolveModel, describeModel } from './model.js';
import type { OracleOptions } from '../oracle.js';

/**
 * The headless intelligence loop: for unattended runs (cron/CI) with no coding
 * agent in the loop, zahori drives a BYO-key model itself. The model only
 * *proposes* profiles; the deterministic engine runs each one and the oracle
 * grades it. The first proposal the oracle trusts wins and is saved.
 *
 * Strategy is deterministic-first: a profile seeded from the built-in generic
 * flow is tried before spending a single token. The model is asked only when
 * the free path fails, and each ask carries the prior failures so it converges.
 */

const Proposal = z.object({
  reason: z.string().describe('One sentence: why these steps/sniff/pick should capture the real media.'),
  steps: z.array(Step).describe('Ordered page actions to trigger playback.'),
  sniff: SniffRule.describe('How to recognize the media request among all network traffic.'),
  pick: PickRule.describe('How to choose among captured candidates.'),
});
type Proposal = z.infer<typeof Proposal>;

export interface DiscoverOptions {
  /** Model spec ("anthropic:claude-sonnet-5", "openai:gpt-5.4", "ollama:llama3.1"). */
  model?: string;
  /** How many times to ask the model before giving up. */
  maxRounds?: number;
  timeoutMs?: number;
  headful?: boolean;
  oracle?: OracleOptions;
  /** false = don't save; true = default project dir; string = explicit dir. */
  save?: boolean | string;
  onProgress?: (msg: string) => void;
}

export interface RoundLog {
  source: 'generic-seed' | 'existing-profile' | 'model';
  reason: string;
  ok: boolean;
  detail: string;
}

export interface DiscoverResult {
  ok: boolean;
  profile?: Profile;
  savedTo?: string;
  rounds: RoundLog[];
  probe: ProbeResult;
}

/** A profile that pins the built-in generic behavior to this specific host. */
function seedFromGeneric(url: string, probeResult: ProbeResult): Profile {
  const id = profileIdFromUrl(url);
  const kind = probeResult.generic?.kind;
  return parseProfile({
    id,
    name: id,
    match: [hostPattern(url)],
    steps: GENERIC_PROFILE.steps,
    sniff: kind ? { kinds: [kind] } : {},
    pick: {},
  });
}

function progress(opts: DiscoverOptions, msg: string): void {
  opts.onProgress?.(msg);
}

async function persist(profile: Profile, opts: DiscoverOptions): Promise<string | undefined> {
  if (opts.save === false) return undefined;
  const dir = typeof opts.save === 'string' ? opts.save : defaultSaveDir();
  return saveProfile(profile, dir);
}

function summarizeTest(t: ProfileTest): string {
  if (t.ok) return `pass (${t.verdict?.reason ?? 'oracle ok'})`;
  if (t.error) return `error: ${t.error}`;
  return `rejected: ${t.verdict?.reason ?? 'no verdict'}`;
}

/** Build the context block the model reasons over. */
function probeBrief(p: ProbeResult): string {
  const lines: string[] = [];
  lines.push(`URL: ${p.url}`);
  if (p.generic) lines.push(`Generic flow captured: ${p.generic.kind} ${p.generic.url}`);
  if (p.genericError) lines.push(`Generic flow error: ${p.genericError}`);
  lines.push(`Media-ish requests seen (${p.candidates.length}):`);
  for (const c of p.candidates.slice(0, 25)) lines.push(`  - [${c.kind}/${c.via}] ${c.url}`);
  if (p.frames.length) {
    lines.push(`Iframes (${p.frames.length}):`);
    for (const f of p.frames.slice(0, 10)) lines.push(`  - ${f}`);
  }
  if (p.elements.length) {
    lines.push(`Play/consent elements:`);
    for (const e of p.elements.slice(0, 20)) lines.push(`  - [${e.reason}] ${e.selector} "${e.text}" (frame ${e.frameUrl})`);
  }
  if (p.hints.length) lines.push(`Hints: ${p.hints.join(' ')}`);
  return lines.join('\n');
}

const SYSTEM = `You are zahori's site-learning engine. You output a "profile": a small, declarative description of how to reveal the media stream behind a web player, so a deterministic runtime can replay it forever with no AI.

A profile has three parts:
- steps: ordered browser actions (goto, dismissOverlays, click, play, waitFor, scroll, eval). The runtime clicks inside iframes automatically, so prefer generic 'play' and 'dismissOverlays' with empty selectors unless the probe shows a specific control is needed.
- sniff: how to recognize the media request. kinds is the container priority (hls/dash/mp4/audio). urlPattern restricts to matching URLs; urlExclude drops ads/beacons/thumbnails. Keep replayHeaders (referer/origin/user-agent/cookie).
- pick: which candidate to keep. variant=master returns the HLS master.

Rules:
- Never target DRM-protected content.
- Re-derive the stream via actions; never hardcode a signed/expiring media URL.
- Prefer the smallest steps that work. Use urlPattern only when several media requests compete.
- Base every choice on the probe evidence you are given.`;

/**
 * Learn a profile for a URL. Tries a generic-seeded profile first (free), then
 * asks the model up to maxRounds times, testing every candidate against the
 * oracle. Returns the first profile the oracle trusts.
 */
export async function discoverProfile(url: string, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const rounds: RoundLog[] = [];

  progress(opts, `probing ${url}`);
  const probeResult = await probe(url, { timeoutMs: opts.timeoutMs, headful: opts.headful });

  // Deterministic-first: try the generic-seeded profile before any token spend.
  const seed = seedFromGeneric(url, probeResult);
  progress(opts, 'testing generic-seeded profile');
  const seedTest = await testProfile(seed, url, {
    timeoutMs: opts.timeoutMs,
    headful: opts.headful,
    oracle: opts.oracle,
  });
  rounds.push({ source: 'generic-seed', reason: 'built-in flow pinned to host', ok: seedTest.ok, detail: summarizeTest(seedTest) });
  if (seedTest.ok) {
    const savedTo = await persist(seed, opts);
    return { ok: true, profile: seed, ...(savedTo ? { savedTo } : {}), rounds, probe: probeResult };
  }

  return runModelRounds(url, probeResult, seed, rounds, maxRounds, opts, undefined);
}

export interface HealOptions extends DiscoverOptions {}

/**
 * Repair a broken profile for a URL. Re-tests it first (the site may have
 * recovered), then asks the model, seeding it with the profile that used to
 * work so it edits rather than starts from scratch.
 */
export async function healProfile(broken: Profile, url: string, opts: HealOptions = {}): Promise<DiscoverResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const rounds: RoundLog[] = [];

  progress(opts, `re-testing existing profile "${broken.id}"`);
  const asIs = await testProfile(broken, url, { timeoutMs: opts.timeoutMs, headful: opts.headful, oracle: opts.oracle });
  rounds.push({ source: 'existing-profile', reason: 'current profile, unchanged', ok: asIs.ok, detail: summarizeTest(asIs) });
  if (asIs.ok) {
    return { ok: true, profile: broken, rounds, probe: { url, candidates: [], frames: [], elements: [], hints: ['profile still works'] } };
  }

  progress(opts, `probing ${url}`);
  const probeResult = await probe(url, { timeoutMs: opts.timeoutMs, headful: opts.headful });
  return runModelRounds(url, probeResult, broken, rounds, maxRounds, opts, broken);
}

/** Shared model-proposal loop used by both discover and heal. */
async function runModelRounds(
  url: string,
  probeResult: ProbeResult,
  base: Profile,
  rounds: RoundLog[],
  maxRounds: number,
  opts: DiscoverOptions,
  seedProfile: Profile | undefined,
): Promise<DiscoverResult> {
  const model = resolveModel(opts.model);
  progress(opts, `asking ${describeModel(opts.model)} (up to ${maxRounds} rounds)`);

  const failures: string[] = rounds.filter((r) => !r.ok).map((r) => `- ${r.source}: ${r.detail}`);
  const brief = probeBrief(probeResult);
  const seedBlock = seedProfile
    ? `\n\nThe profile that used to work (repair it, don't start over):\n${JSON.stringify(
        { steps: seedProfile.steps, sniff: seedProfile.sniff, pick: seedProfile.pick },
        null,
        2,
      )}`
    : '';

  for (let round = 1; round <= maxRounds; round++) {
    const prompt = `${brief}${seedBlock}\n\nAttempts so far that FAILED:\n${
      failures.length ? failures.join('\n') : '(none yet)'
    }\n\nPropose a profile (steps, sniff, pick) that captures the real media stream.`;

    let proposal: Proposal;
    try {
      const { object } = await generateObject({ model, schema: Proposal, system: SYSTEM, prompt });
      proposal = object;
    } catch (e) {
      rounds.push({ source: 'model', reason: 'generation failed', ok: false, detail: (e as Error).message });
      break;
    }

    const candidate = parseProfile({
      id: base.id,
      name: base.name || base.id,
      match: base.match,
      priority: base.priority,
      steps: proposal.steps,
      sniff: proposal.sniff,
      pick: proposal.pick,
      notes: proposal.reason,
    });

    progress(opts, `round ${round}: testing model proposal`);
    const test = await testProfile(candidate, url, { timeoutMs: opts.timeoutMs, headful: opts.headful, oracle: opts.oracle });
    const detail = summarizeTest(test);
    rounds.push({ source: 'model', reason: proposal.reason, ok: test.ok, detail });
    failures.push(`- round ${round}: ${proposal.reason} => ${detail}`);

    if (test.ok) {
      const savedTo = await persist(candidate, opts);
      return { ok: true, profile: candidate, ...(savedTo ? { savedTo } : {}), rounds, probe: probeResult };
    }
  }

  return { ok: false, rounds, probe: probeResult };
}
