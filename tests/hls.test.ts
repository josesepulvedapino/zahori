import { describe, expect, it } from 'vitest';
import { parseAudioTracks, resolveUri, selectAudioTrack } from '../src/hls.js';

// A synthetic HLS master in the standard #EXT-X-MEDIA format. The LANGUAGE
// codes here are made up on purpose ("zza"/"zzb") to exercise the code-mapping
// path without baking any real site's conventions into the test suite.
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="zzb",NAME="English",DEFAULT=YES,URI="audio_en/index.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="zza",NAME="Original",DEFAULT=NO,URI="audio_orig/index.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="fr-FR",NAME="French",DEFAULT=NO,URI="/root/audio_fr.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="CC",URI="subs.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"',
  'video/index.m3u8',
].join('\n');

describe('parseAudioTracks', () => {
  it('parses audio renditions and ignores subtitles/variants', () => {
    const tracks = parseAudioTracks(MASTER);
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toEqual({
      language: 'zzb',
      name: 'English',
      uri: 'audio_en/index.m3u8',
      isDefault: true,
    });
    expect(tracks[1]!.language).toBe('zza');
    expect(tracks[2]!.isDefault).toBe(false);
  });

  it('returns empty for a master without audio renditions', () => {
    expect(parseAudioTracks('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8')).toEqual([]);
  });
});

describe('selectAudioTrack', () => {
  const tracks = parseAudioTracks(MASTER);

  it('matches the exact language code', () => {
    const sel = selectAudioTrack(tracks, { language: 'zza' });
    expect(sel?.track.name).toBe('Original');
    expect(sel?.matchedBy).toBe('exact');
  });

  it('tolerates locale suffixes ("fr" matches "fr-FR")', () => {
    const sel = selectAudioTrack(tracks, { language: 'fr' });
    expect(sel?.track.name).toBe('French');
    expect(sel?.matchedBy).toBe('exact');
  });

  it('maps standard ISO codes to a site\'s own codes', () => {
    const sel = selectAudioTrack(tracks, { language: 'es', languageMap: { es: 'zza' } });
    expect(sel?.track.name).toBe('Original');
    expect(sel?.matchedBy).toBe('mapped');
  });

  it('walks the fallback list in order', () => {
    const sel = selectAudioTrack(tracks, { language: 'de', fallbacks: ['nope', 'zza'] });
    expect(sel?.track.name).toBe('Original');
    expect(sel?.matchedBy).toBe('fallback');
  });

  it('falls back to the DEFAULT=YES track', () => {
    const sel = selectAudioTrack(tracks, { language: 'de' });
    expect(sel?.track.name).toBe('English');
    expect(sel?.matchedBy).toBe('default');
  });

  it('falls back to the first track when nothing else applies', () => {
    const noDefault = tracks.map((t) => ({ ...t, isDefault: false }));
    const sel = selectAudioTrack(noDefault, {});
    expect(sel?.track.name).toBe('English');
    expect(sel?.matchedBy).toBe('first');
  });

  it('returns undefined when there are no tracks', () => {
    expect(selectAudioTrack([], { language: 'es' })).toBeUndefined();
  });
});

describe('resolveUri', () => {
  const master = 'https://cdn.example.com/live/master.m3u8?sig=1';

  it('keeps absolute URIs', () => {
    expect(resolveUri(master, 'https://other.com/a.m3u8')).toBe('https://other.com/a.m3u8');
  });

  it('resolves root-relative URIs against the host', () => {
    expect(resolveUri(master, '/root/audio_fr.m3u8')).toBe('https://cdn.example.com/root/audio_fr.m3u8');
  });

  it('resolves relative URIs against the master directory', () => {
    expect(resolveUri(master, 'audio_orig/index.m3u8')).toBe('https://cdn.example.com/live/audio_orig/index.m3u8');
  });
});
