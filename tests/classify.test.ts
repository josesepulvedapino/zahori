import { describe, expect, it } from 'vitest';
import { analyzeManifest, kindFromContentType, kindFromUrl } from '../src/classify.js';

describe('kindFromUrl', () => {
  it('classifies by extension, ignoring query strings', () => {
    expect(kindFromUrl('https://x.com/master.m3u8?token=abc')).toBe('hls');
    expect(kindFromUrl('https://x.com/manifest.mpd')).toBe('dash');
    expect(kindFromUrl('https://x.com/video.mp4')).toBe('mp4');
    expect(kindFromUrl('https://x.com/audio.mp3')).toBe('audio');
    expect(kindFromUrl('https://x.com/page.html')).toBeUndefined();
  });
});

describe('kindFromContentType', () => {
  it('classifies by mime', () => {
    expect(kindFromContentType('application/vnd.apple.mpegurl')).toBe('hls');
    expect(kindFromContentType('application/x-mpegURL; charset=utf-8')).toBe('hls');
    expect(kindFromContentType('application/dash+xml')).toBe('dash');
    expect(kindFromContentType('video/mp4')).toBe('mp4');
    expect(kindFromContentType('audio/aac')).toBe('audio');
    expect(kindFromContentType('text/html')).toBeUndefined();
    expect(kindFromContentType(undefined)).toBeUndefined();
  });
});

describe('analyzeManifest (HLS)', () => {
  it('detects a master playlist', () => {
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'v0.m3u8'].join('\n');
    const facts = analyzeManifest(master, 'hls');
    expect(facts.isMaster).toBe(true);
    expect(facts.live).toBeUndefined();
  });

  it('detects VOD via ENDLIST and counts segments', () => {
    const vod = ['#EXTM3U', '#EXTINF:6.0,', 's1.ts', '#EXTINF:6.0,', 's2.ts', '#EXT-X-ENDLIST'].join('\n');
    const facts = analyzeManifest(vod, 'hls');
    expect(facts.live).toBe(false);
    expect(facts.segmentCount).toBe(2);
  });

  it('detects live when ENDLIST is absent', () => {
    const live = ['#EXTM3U', '#EXTINF:6.0,', 's1.ts', '#EXTINF:6.0,', 's2.ts'].join('\n');
    expect(analyzeManifest(live, 'hls').live).toBe(true);
  });

  it('flags DRM markers', () => {
    const drm = ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"', '#EXTINF:6.0,', 's1.ts'].join('\n');
    expect(analyzeManifest(drm, 'hls').drm).toBe(true);
  });
});

describe('analyzeManifest (DASH)', () => {
  it('classifies dynamic as live and static as VOD', () => {
    expect(analyzeManifest('<MPD type="dynamic"></MPD>', 'dash').live).toBe(true);
    expect(analyzeManifest('<MPD type="static"></MPD>', 'dash').live).toBe(false);
  });

  it('flags ContentProtection as DRM', () => {
    const mpd = '<MPD type="static"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></MPD>';
    expect(analyzeManifest(mpd, 'dash').drm).toBe(true);
  });
});
