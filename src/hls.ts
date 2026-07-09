/**
 * HLS master-playlist audio rendition parsing and selection.
 *
 * Multilingual players expose one
 * audio rendition per language via #EXT-X-MEDIA:TYPE=AUDIO. Which rendition
 * to pick is recipe data: many sites label tracks with non-standard LANGUAGE
 * codes (ISO 639-3 private-use ranges, house conventions), so recipes can map
 * ISO codes to whatever the site actually uses.
 */

export interface AudioTrack {
  /** Value of the LANGUAGE attribute ('' if absent). */
  language: string;
  /** Value of the NAME attribute, falling back to the language code. */
  name: string;
  /** Rendition URI, possibly relative to the master playlist URL. */
  uri: string;
  isDefault: boolean;
}

/** How the returned track was chosen, most to least specific. */
export type AudioMatch = 'exact' | 'mapped' | 'fallback' | 'default' | 'first';

export interface SelectedAudio {
  track: AudioTrack;
  matchedBy: AudioMatch;
}

/** Parse the audio renditions out of an HLS master playlist. */
export function parseAudioTracks(masterText: string): AudioTrack[] {
  const tracks: AudioTrack[] = [];
  for (const raw of masterText.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('#EXT-X-MEDIA:') || !line.includes('TYPE=AUDIO')) continue;
    const uri = /URI="([^"]+)"/.exec(line)?.[1];
    if (!uri) continue;
    const language = /LANGUAGE="([^"]+)"/.exec(line)?.[1] ?? '';
    const name = /NAME="([^"]+)"/.exec(line)?.[1] ?? language;
    tracks.push({ language, name, uri, isDefault: /DEFAULT=YES/.test(line) });
  }
  return tracks;
}

/** Resolve a rendition URI (absolute, root-relative or relative) against the master URL. */
export function resolveUri(masterUrl: string, uri: string): string {
  return new URL(uri, masterUrl).toString();
}

export interface AudioWanted {
  /** Preferred language, usually an ISO code ("es", "en"). */
  language?: string | undefined;
  /** Map from ISO codes to the site's own LANGUAGE codes. */
  languageMap?: Record<string, string> | undefined;
  /** Extra LANGUAGE codes to try, in order, when the preferred one isn't there. */
  fallbacks?: string[] | undefined;
}

/**
 * Choose an audio rendition. Order: exact language match (with locale-prefix
 * tolerance, so "es" matches "es-ES"), the site-specific mapped code, each
 * fallback code, the DEFAULT=YES track, and finally the first track.
 */
export function selectAudioTrack(tracks: AudioTrack[], wanted: AudioWanted = {}): SelectedAudio | undefined {
  if (tracks.length === 0) return undefined;

  const lang = wanted.language?.toLowerCase();
  if (lang) {
    const exact =
      tracks.find((t) => t.language.toLowerCase() === lang) ??
      tracks.find((t) => t.language.toLowerCase().startsWith(`${lang}-`));
    if (exact) return { track: exact, matchedBy: 'exact' };

    const mapped = wanted.languageMap?.[lang];
    if (mapped) {
      const track = tracks.find((t) => t.language.toLowerCase() === mapped.toLowerCase());
      if (track) return { track, matchedBy: 'mapped' };
    }
  }

  for (const code of wanted.fallbacks ?? []) {
    const track = tracks.find((t) => t.language.toLowerCase() === code.toLowerCase());
    if (track) return { track, matchedBy: 'fallback' };
  }

  const def = tracks.find((t) => t.isDefault);
  if (def) return { track: def, matchedBy: 'default' };
  return { track: tracks[0]!, matchedBy: 'first' };
}
