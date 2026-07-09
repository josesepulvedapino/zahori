import type { StreamKind } from './types.js';

/** DRM signals that mean we must refuse (we never touch protected content). */
const DRM_MARKERS = [
  '#EXT-X-KEY:METHOD=SAMPLE-AES', // FairPlay
  'com.apple.streamingkeydelivery',
  'com.widevine',
  'com.microsoft.playready',
  'urn:mpeg:dash:mp4protection',
  'ContentProtection',
  'cenc:',
];

/** Guess the stream kind from a URL alone (used while sniffing network requests). */
export function kindFromUrl(url: string): StreamKind | undefined {
  const u = url.split('?')[0]?.toLowerCase() ?? '';
  if (u.endsWith('.m3u8')) return 'hls';
  if (u.endsWith('.mpd')) return 'dash';
  if (u.endsWith('.mp4') || u.endsWith('.m4v')) return 'mp4';
  if (u.endsWith('.m4a') || u.endsWith('.mp3') || u.endsWith('.aac')) return 'audio';
  return undefined;
}

/** Guess kind from a response content-type header. */
export function kindFromContentType(contentType: string | undefined): StreamKind | undefined {
  if (!contentType) return undefined;
  const ct = contentType.toLowerCase();
  if (ct.includes('mpegurl')) return 'hls'; // application/vnd.apple.mpegurl, application/x-mpegurl
  if (ct.includes('dash+xml')) return 'dash';
  if (ct.includes('video/mp4')) return 'mp4';
  if (ct.includes('audio/')) return 'audio';
  return undefined;
}

export interface ManifestFacts {
  /** true = live, false = VOD, undefined = can't tell. */
  live: boolean | undefined;
  /** true if the manifest is an HLS master (has variant streams). */
  isMaster: boolean;
  /** true if DRM protection markers were found. */
  drm: boolean;
  /** Number of media segments (VOD only; 0 if unknown). */
  segmentCount: number;
}

/**
 * Inspect the text of an HLS (.m3u8) or DASH (.mpd) manifest to learn whether
 * it is live vs VOD, a master vs media playlist, DRM-protected, and how many
 * segments it has (a sanity signal for the oracle: a real session has many).
 */
export function analyzeManifest(text: string, kind: StreamKind): ManifestFacts {
  const drm = DRM_MARKERS.some((m) => text.includes(m));

  if (kind === 'dash') {
    // DASH: live streams use type="dynamic"; VOD uses type="static".
    const isDynamic = /type\s*=\s*"dynamic"/i.test(text);
    const isStatic = /type\s*=\s*"static"/i.test(text);
    return {
      live: isDynamic ? true : isStatic ? false : undefined,
      isMaster: /<AdaptationSet/i.test(text),
      drm,
      segmentCount: (text.match(/<S[ \/>]/g) ?? []).length,
    };
  }

  // HLS.
  const isMaster = text.includes('#EXT-X-STREAM-INF');
  if (isMaster) {
    return { live: undefined, isMaster: true, drm, segmentCount: 0 };
  }
  // Media playlist: VOD ends with #EXT-X-ENDLIST; live doesn't.
  const hasEndList = text.includes('#EXT-X-ENDLIST');
  const playlistType = /#EXT-X-PLAYLIST-TYPE:\s*(VOD|EVENT)/i.exec(text)?.[1]?.toUpperCase();
  const segmentCount = (text.match(/#EXTINF:/g) ?? []).length;
  const live = hasEndList || playlistType === 'VOD' ? false : true;
  return { live, isMaster: false, drm, segmentCount };
}
