import type { AudioMatch } from './hls.js';

/** Container/protocol of a captured stream. */
export type StreamKind = 'hls' | 'dash' | 'mp4' | 'audio';

/** A resolved stream, re-derived fresh on every run. */
export interface StreamResult {
  /** The media URL. May be short-lived (signed/expiring); fetch it immediately, never cache it. */
  url: string;
  kind: StreamKind;
  /** true = live/ongoing, false = VOD, undefined = unknown. */
  live: boolean | undefined;
  /**
   * Headers to replay when fetching the URL. Many servers 403 without the
   * original Referer/Origin/User-Agent/Cookie. Always pass these to ffmpeg/fetch.
   */
  headers: Record<string, string>;
  /** id of the profile that produced this result ('generic' = built-in flow). */
  profileId: string;
  /** All candidates captured, for debugging. */
  candidates: string[];
  /**
   * Present when an audio rendition was selected out of a master playlist
   * (multilingual streams). matchedBy says how confident the match is:
   * 'exact'/'mapped' honored the requested language; 'fallback'/'default'/'first'
   * mean the requested language wasn't available.
   */
  audio?: {
    language: string;
    name: string;
    matchedBy: AudioMatch;
  };
}

export interface ResolveOptions {
  /** Max time to spend driving the page before giving up (ms). */
  timeoutMs?: number;
  /** Show the browser window instead of running headless. */
  headful?: boolean;
  /** Extra profile directories to load beyond the user/project ones. */
  profileDirs?: string[];
  /** Force a specific saved profile id (skip matching). */
  profileId?: string;
  /**
   * Preferred audio language (ISO code, e.g. "es") for multilingual streams.
   * Overrides the profile's pick.audioLanguage.
   */
  audioLanguage?: string;
}

export class NoStreamError extends Error {
  constructor(public url: string, public profileId: string) {
    super(
      profileId === 'generic'
        ? `No stream captured for: ${url}`
        : `Profile "${profileId}" ran but captured no stream for: ${url}`,
    );
    this.name = 'NoStreamError';
  }
}

export class DrmError extends Error {
  constructor(public url: string) {
    super(`Refusing: stream appears to be DRM-protected (Widevine/PlayReady/FairPlay): ${url}`);
    this.name = 'DrmError';
  }
}
