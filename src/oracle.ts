import { spawn } from 'node:child_process';
import { analyzeManifest } from './classify.js';
import { parseAudioTracks, resolveUri } from './hls.js';
import type { StreamResult } from './types.js';

/**
 * The oracle decides whether a resolved stream is *actually* the media we want.
 * It is the trust basis for unattended recipe generation/repair, so it combines
 * several signals instead of a naive "did anything download":
 *
 *  - decode probe: ffmpeg decodes a bounded window and measures volume
 *  - manifest sanity: a real session has many segments and plausible duration,
 *    a bumper/slate has a handful
 *  - expected duration: optional cross-check against what the caller knows
 *  - silence handling: silence can be a legitimate recess, so a silent window
 *    triggers a second probe further in before giving up
 *
 * A weak oracle (e.g. "any audio = pass") blesses ad rolls, hold music and
 * geo-block slates, and rejects real recesses. Every probe is bounded with -t.
 */

export type Verdict = 'pass' | 'fail' | 'inconclusive';

export interface OracleSignals {
  /** true if the media decoded at all. */
  decoded: boolean;
  /** Peak volume in dB (-91 ≈ digital silence). undefined if not measured. */
  maxVolumeDb: number | undefined;
  /** Mean volume in dB across the sampled window. */
  meanVolumeDb: number | undefined;
  /** true if the server rejected the request (403/401). */
  forbidden: boolean;
  /** Manifest facts, when the stream is HLS/DASH and the manifest was readable. */
  manifest?: {
    live: boolean | undefined;
    segmentCount: number;
    /** Total duration in seconds summed from the playlist (VOD only, 0 if unknown). */
    durationSec: number;
  };
}

export interface OracleResult {
  verdict: Verdict;
  signals: OracleSignals;
  reason: string;
  /** @deprecated kept for convenience; same as signals.maxVolumeDb. */
  maxVolumeDb: number | undefined;
  /** @deprecated kept for convenience; same as signals.decoded. */
  decoded: boolean;
}

export interface OracleOptions {
  /** Seconds of media to sample per probe window. */
  sampleSeconds?: number;
  /** Seconds into the stream to start sampling (skip silent heads/bumpers). */
  seekSeconds?: number;
  /** Absolute wall-clock cap for each ffmpeg probe (ms). */
  timeoutMs?: number;
  /** Path to the ffmpeg binary. */
  ffmpegPath?: string;
  /**
   * Minimum plausible VOD duration in seconds. Shorter manifests read as
   * bumpers/slates and come back inconclusive. Set 0 to disable.
   */
  minDurationSec?: number;
  /**
   * When the caller knows how long the media should be, a manifest that
   * deviates more than 25% fails (wrong asset).
   */
  expectedDurationSec?: number;
}

function headerArgs(headers: Record<string, string>): string[] {
  const lines = Object.entries(headers)
    .filter(([k]) => k.toLowerCase() !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}`);
  const args: string[] = [];
  const ua = headers['user-agent'] ?? headers['User-Agent'];
  if (ua) args.push('-user_agent', ua);
  if (lines.length) args.push('-headers', lines.join('\r\n') + '\r\n');
  return args;
}

interface ProbeOutcome {
  decoded: boolean;
  maxVolumeDb: number | undefined;
  meanVolumeDb: number | undefined;
  forbidden: boolean;
  spawnFailed: boolean;
  timedOut: boolean;
}

/** Decode [seek, seek+sample] with ffmpeg and measure volume. */
async function probeWindow(
  stream: StreamResult,
  seek: number,
  sample: number,
  timeoutMs: number,
  ffmpeg: string,
): Promise<ProbeOutcome> {
  const args = [
    '-hide_banner',
    '-nostats',
    ...headerArgs(stream.headers),
    '-ss',
    String(seek),
    '-i',
    stream.url,
    '-t',
    String(sample),
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ];

  let stderr = '';
  let timedOut = false;

  const code = await new Promise<number | null>((resolveCode) => {
    // windowsHide: never flash a console window when run from a GUI/cron context.
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolveCode(null);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolveCode(c);
    });
  });

  const maxVolumeDb = numberFrom(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i, stderr);
  const meanVolumeDb = numberFrom(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i, stderr);
  return {
    decoded: /Duration:|Stream #\d|Output #0|size=/.test(stderr) || maxVolumeDb !== undefined,
    maxVolumeDb,
    meanVolumeDb,
    forbidden: /HTTP error 40[13]|403 Forbidden|401 Unauthorized/i.test(stderr),
    spawnFailed: code === null && !timedOut,
    timedOut,
  };
}

function numberFrom(re: RegExp, text: string): number | undefined {
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Fetch the playlist with the replay headers and derive sanity facts. Follows
 * one level of indirection: a master playlist is resolved to its first audio
 * rendition or variant so segment math runs on a media playlist.
 */
async function manifestSignals(stream: StreamResult): Promise<OracleSignals['manifest'] | undefined> {
  if (stream.kind !== 'hls' && stream.kind !== 'dash') return undefined;
  const text = await fetchText(stream.url, stream.headers);
  if (text === undefined) return undefined;

  let facts = analyzeManifest(text, stream.kind);
  let durationSec = stream.kind === 'hls' ? sumExtinf(text) : 0;

  if (stream.kind === 'hls' && facts.isMaster) {
    const child = parseAudioTracks(text)[0]?.uri ?? firstVariantUri(text);
    if (child) {
      const childText = await fetchText(resolveUri(stream.url, child), stream.headers);
      if (childText !== undefined) {
        facts = analyzeManifest(childText, 'hls');
        durationSec = sumExtinf(childText);
      }
    }
  }

  return { live: facts.live, segmentCount: facts.segmentCount, durationSec: Math.round(durationSec) };
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string | undefined> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

function sumExtinf(playlist: string): number {
  let total = 0;
  for (const m of playlist.matchAll(/#EXTINF:\s*(\d+(?:\.\d+)?)/g)) total += Number(m[1]);
  return total;
}

function firstVariantUri(master: string): string | undefined {
  const lines = master.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#EXT-X-STREAM-INF')) {
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) return next;
    }
  }
  return undefined;
}

/**
 * Validate a stream by combining the decode probe with manifest sanity.
 * Header replay is mandatory: many servers 403 without the original
 * Referer/Origin.
 */
export async function validate(stream: StreamResult, opts: OracleOptions = {}): Promise<OracleResult> {
  const sample = opts.sampleSeconds ?? 12;
  const seek = opts.seekSeconds ?? 8;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
  const minDuration = opts.minDurationSec ?? 60;

  const manifest = await manifestSignals(stream);

  const result = (verdict: Verdict, probe: Partial<ProbeOutcome>, reason: string): OracleResult => {
    const signals: OracleSignals = {
      decoded: probe.decoded ?? false,
      maxVolumeDb: probe.maxVolumeDb,
      meanVolumeDb: probe.meanVolumeDb,
      forbidden: probe.forbidden ?? false,
      ...(manifest ? { manifest } : {}),
    };
    return { verdict, signals, reason, maxVolumeDb: signals.maxVolumeDb, decoded: signals.decoded };
  };

  // Manifest sanity comes first: no point decoding the wrong asset.
  if (manifest && opts.expectedDurationSec && manifest.durationSec > 0 && manifest.live === false) {
    const ratio = manifest.durationSec / opts.expectedDurationSec;
    if (ratio < 0.75 || ratio > 1.25) {
      return result(
        'fail',
        {},
        `manifest duration ${manifest.durationSec}s deviates from expected ${opts.expectedDurationSec}s`,
      );
    }
  }

  const probe = await probeWindow(stream, seek, sample, timeoutMs, ffmpeg);

  if (probe.spawnFailed) {
    return result('inconclusive', probe, 'ffmpeg not found or failed to spawn');
  }
  if (probe.forbidden) {
    return result('fail', probe, 'server rejected the request (403/401); headers may be insufficient');
  }
  if (!probe.decoded) {
    return result('fail', probe, probe.timedOut ? 'probe timed out with no decodable media' : 'no decodable media');
  }

  // Decoded, but a real session shouldn't look like a 20-second bumper.
  if (manifest && manifest.live === false && minDuration > 0 && manifest.durationSec > 0 && manifest.durationSec < minDuration) {
    return result(
      'inconclusive',
      probe,
      `decodes but VOD manifest is only ${manifest.durationSec}s, looks like a bumper/slate, not a session`,
    );
  }

  if (probe.maxVolumeDb === undefined) {
    return result('inconclusive', probe, 'decoded but could not measure volume');
  }

  // Near-digital-silence: could be a legitimate recess. Try one window further
  // in before answering, then stay inconclusive (never fail on silence alone).
  if (probe.maxVolumeDb <= -70) {
    const canRetryDeeper = manifest?.live !== false || (manifest?.durationSec ?? 0) > seek + 120 + sample;
    if (canRetryDeeper) {
      const retry = await probeWindow(stream, seek + 120, sample, timeoutMs, ffmpeg);
      if (retry.decoded && retry.maxVolumeDb !== undefined && retry.maxVolumeDb > -70) {
        return result('pass', retry, 'first window silent (recess?) but a later window has real audio');
      }
    }
    return result('inconclusive', probe, 'decoded but effectively silent (recess?); sample another window');
  }

  // A lone blip in an otherwise silent window is not evidence of real content.
  if (probe.meanVolumeDb !== undefined && probe.meanVolumeDb <= -60) {
    return result('inconclusive', probe, 'decoded but the window is mostly silence; sample another window');
  }

  return result('pass', probe, 'decoded audio with real signal');
}
