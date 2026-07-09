import { z } from 'zod';

/**
 * A profile describes how to open one specific site: which page actions start
 * playback, and how to recognize the media request in the network traffic.
 * Profiles are data, not code; the engine interprets them deterministically,
 * with no AI involved.
 *
 * zahori needs no profile for most URLs: the engine's built-in generic flow
 * (GENERIC_PROFILE below) works out of the box on any page. A profile is what
 * gets saved on the user's machine after a tricky site is solved once, so every
 * later run on that site is instant and free. zahori ships zero profiles.
 *
 * A profile stores *how to re-derive* the stream on every run (so signed or
 * expiring URLs are never a problem), never the stream URL itself.
 */

/** A single action taken in the page before/while the stream is sniffed. */
export const Step = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('goto'),
    /** Optional override; defaults to the input URL. */
    url: z.string().optional(),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('domcontentloaded'),
  }),
  z.object({
    action: z.literal('waitFor'),
    /** CSS selector to wait for, or a millisecond delay. */
    selector: z.string().optional(),
    ms: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal('click'),
    selector: z.string(),
    /** Don't fail the profile if the element isn't there (e.g. optional overlay). */
    optional: z.boolean().default(false),
  }),
  z.object({
    /** Dismiss common consent/cookie/age overlays by trying a list of selectors. */
    action: z.literal('dismissOverlays'),
    selectors: z.array(z.string()).default([]),
  }),
  z.object({
    /** Click the most likely play affordance so the player starts loading media. */
    action: z.literal('play'),
    selectors: z.array(z.string()).default([]),
  }),
  z.object({
    action: z.literal('scroll'),
    to: z.enum(['bottom', 'top']).default('bottom'),
  }),
  z.object({
    /** Run arbitrary in-page JS and use its return value later. Advanced/rare. */
    action: z.literal('eval'),
    script: z.string(),
  }),
]);
export type Step = z.infer<typeof Step>;

/** How to recognize the media request among all network traffic. */
export const SniffRule = z.object({
  /** Container types to accept, in priority order. */
  kinds: z.array(z.enum(['hls', 'dash', 'mp4', 'audio'])).default(['hls', 'dash', 'mp4']),
  /** Regex the request URL must match (in addition to the extension heuristics). */
  urlPattern: z.string().optional(),
  /** Regex the URL must NOT match (ads, beacons, thumbnails). */
  urlExclude: z.string().optional(),
  /** Request headers to carry into the returned result for replay (Referer/Origin/etc). */
  replayHeaders: z.array(z.string()).default(['referer', 'origin', 'user-agent', 'cookie']),
});
export type SniffRule = z.infer<typeof SniffRule>;

/** When several candidates are captured, how to choose one. */
export const PickRule = z.object({
  /** For HLS master playlists: which variant to select. */
  variant: z.enum(['master', 'highest', 'lowest', 'audio-only']).default('master'),
  /** Prefer the first or the last matching capture when several arrive. */
  order: z.enum(['first', 'last']).default('first'),
  /**
   * Preferred audio language (ISO code, e.g. "es") when the master playlist
   * carries one #EXT-X-MEDIA audio rendition per language. Callers can override
   * it per run. When set, the engine resolves the matching rendition instead of
   * returning the master.
   */
  audioLanguage: z.string().optional(),
  /**
   * Map from ISO codes to a site's own LANGUAGE codes. Some players label
   * renditions with non-standard codes; this lets a caller keep asking for
   * standard codes everywhere.
   */
  languageMap: z.record(z.string()).default({}),
  /** Extra LANGUAGE codes to try, in order, when the preferred one isn't found. */
  audioLanguageFallbacks: z.array(z.string()).default([]),
});
export type PickRule = z.infer<typeof PickRule>;

export const Profile = z.object({
  /** Profile format version, for forward-compat. */
  v: z.literal(1).default(1),
  /** Stable id, usually derived from the site's hostname. */
  id: z.string().min(1),
  /** Human label. */
  name: z.string().default(''),
  /**
   * URL patterns this profile handles. A URL matches if ANY pattern matches.
   * Patterns are matched against the full URL as regex (anchored loosely).
   */
  match: z.array(z.string()).min(1),
  /**
   * When several profiles match a URL, the highest priority wins. Site profiles
   * use the default 0; the built-in catch-all uses a negative value.
   */
  priority: z.number().int().default(0),
  /** Ordered actions to trigger playback. */
  steps: z.array(Step).default([]),
  /** How to identify the media request. */
  sniff: SniffRule.default({}),
  /** How to pick among candidates. */
  pick: PickRule.default({}),
  /** Free-form notes (not used by the engine). */
  notes: z.string().optional(),
});
export type Profile = z.infer<typeof Profile>;

/** Parse and validate an unknown object into a Profile, filling defaults. */
export function parseProfile(input: unknown): Profile {
  return Profile.parse(input);
}

/** Does this profile apply to the given URL? */
export function profileMatches(profile: Profile, url: string): boolean {
  return profile.match.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(url);
    } catch {
      return false;
    }
  });
}

/**
 * The engine's built-in behavior, expressed in the same structure it executes:
 * open the page, clear overlays, press play, sniff the network. This runs for
 * any URL that has no saved profile, which is why zahori works out of the box.
 */
export const GENERIC_PROFILE: Profile = parseProfile({
  id: 'generic',
  name: 'Built-in generic flow',
  match: ['^https?://'],
  priority: -100,
  steps: [
    { action: 'goto', waitUntil: 'domcontentloaded' },
    { action: 'dismissOverlays', selectors: [] },
    { action: 'play', selectors: [] },
    { action: 'waitFor', ms: 4000 },
  ],
  sniff: {
    kinds: ['hls', 'dash', 'mp4'],
    urlExclude: '(/ads?[/.?-]|advert|analytics|beacon|thumbnail|/vast|doubleclick|googlesyndication)',
    replayHeaders: ['referer', 'origin', 'user-agent', 'cookie'],
  },
});
