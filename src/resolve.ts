import { loadProfiles } from './loader.js';
import { GENERIC_PROFILE, profileMatches, type Profile } from './profile.js';
import { runProfile } from './runtime.js';
import type { ResolveOptions, StreamResult } from './types.js';

/**
 * Find the saved profile that applies to a URL, if any. Highest priority wins.
 * Returns undefined when no saved profile matches; resolve() then falls back
 * to the engine's built-in generic flow.
 */
export async function findProfile(url: string, opts: ResolveOptions = {}): Promise<Profile | undefined> {
  const profiles = await loadProfiles(opts.profileDirs ?? []);
  if (opts.profileId) {
    const forced = profiles.find((p) => p.id === opts.profileId);
    if (!forced) throw new Error(`No saved profile with id "${opts.profileId}"`);
    return forced;
  }
  return profiles
    .filter((p) => profileMatches(p, url))
    .sort((a, b) => b.priority - a.priority)[0];
}

/**
 * Resolve the media stream behind a URL. Uses the matching saved profile when
 * one exists, otherwise the built-in generic flow, so any URL is fair game.
 * The stream is re-derived fresh on every run (safe for signed/expiring URLs).
 *
 * The returned URL may be short-lived; fetch it immediately, never cache it.
 */
export async function resolve(url: string, opts: ResolveOptions = {}): Promise<StreamResult> {
  const profile = (await findProfile(url, opts)) ?? GENERIC_PROFILE;
  return runProfile(profile, url, {
    timeoutMs: opts.timeoutMs,
    headful: opts.headful,
    audioLanguage: opts.audioLanguage,
  });
}
