import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe, testProfile } from '../../src/discover.js';
import { resolve } from '../../src/resolve.js';
import { runProfile, runProfileOnPage } from '../../src/runtime.js';
import { parseProfile, GENERIC_PROFILE } from '../../src/profile.js';
import { launchBrowser, newBrowserContext } from '../../src/browser.js';
import { NoStreamError, DrmError } from '../../src/types.js';

/**
 * Hermetic end-to-end suite: a local HTTP server plays the role of a site with
 * an embedded player. No internet, no real sites, no ffmpeg; this exercises
 * the full engine path (navigate, dismiss overlays, press play, sniff the
 * network, analyze the manifest) against fixtures we fully control.
 */

const TEST_TIMEOUT = 120_000;

const vodPlaylist = (segments: number) =>
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...Array.from({ length: segments }, (_, i) => `#EXTINF:6.0,\nseg${i}.ts`),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",LANGUAGE="es",DEFAULT=NO,URI="audio_es.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio_en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"',
  'video.m3u8',
  '',
].join('\n');

const DRM_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fake-key"',
  '#EXTINF:6.0,',
  'seg0.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

/** A page with a consent banner and a play button, like much of the real web. */
const playerPage = (manifestPath: string, playButtonClass = 'play-button') => `<!doctype html>
<html>
  <body>
    <div id="cookie-banner" style="position:fixed;inset:0;background:#0008">
      <button onclick="document.getElementById('cookie-banner').remove()">Accept</button>
    </div>
    <button class="${playButtonClass}" onclick="fetch('${manifestPath}')">▶ Play</button>
  </body>
</html>`;

const ROUTES: Record<string, { type: string; body: string }> = {
  '/vod.html': { type: 'text/html', body: playerPage('/media/vod.m3u8') },
  '/iframe.html': {
    type: 'text/html',
    body: '<!doctype html><html><body><h1>Embedding page</h1><iframe src="/vod.html" width="640" height="360"></iframe></body></html>',
  },
  '/master.html': { type: 'text/html', body: playerPage('/media/master.m3u8') },
  '/drm.html': { type: 'text/html', body: playerPage('/media/drm.m3u8') },
  '/custom.html': { type: 'text/html', body: playerPage('/media/vod.m3u8', 'start-broadcast') },
  '/empty.html': { type: 'text/html', body: '<!doctype html><html><body><p>No player here.</p></body></html>' },
  // An ad-laden site: the play click fires a popunder before starting playback.
  '/popunder.html': {
    type: 'text/html',
    body: `<!doctype html><html><body>
      <button class="play-button" onclick="window.open('/ad.html', '_blank'); fetch('/media/vod.m3u8')">▶ Play</button>
    </body></html>`,
  },
  '/ad.html': { type: 'text/html', body: '<!doctype html><html><body><h1>ad</h1></body></html>' },
  '/media/vod.m3u8': { type: 'application/vnd.apple.mpegurl', body: vodPlaylist(12) },
  '/media/master.m3u8': { type: 'application/vnd.apple.mpegurl', body: MASTER_PLAYLIST },
  '/media/audio_es.m3u8': { type: 'application/vnd.apple.mpegurl', body: vodPlaylist(12) },
  '/media/audio_en.m3u8': { type: 'application/vnd.apple.mpegurl', body: vodPlaylist(12) },
  '/media/drm.m3u8': { type: 'application/vnd.apple.mpegurl', body: DRM_PLAYLIST },
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = ROUTES[(req.url ?? '').split('?')[0] ?? ''];
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': route.type }).end(route.body);
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
});

describe('generic flow (no profile)', () => {
  it(
    'dismisses the consent banner, presses play, and captures the VOD stream',
    async () => {
      const result = await resolve(`${base}/vod.html`);
      expect(result.url).toBe(`${base}/media/vod.m3u8`);
      expect(result.kind).toBe('hls');
      expect(result.live).toBe(false);
      expect(result.profileId).toBe('generic');
      expect(result.headers['user-agent']).toBeDefined();
    },
    TEST_TIMEOUT,
  );

  it(
    'finds the player inside an iframe',
    async () => {
      const result = await resolve(`${base}/iframe.html`);
      expect(result.url).toBe(`${base}/media/vod.m3u8`);
      expect(result.kind).toBe('hls');
    },
    TEST_TIMEOUT,
  );

  it(
    'selects the requested audio rendition from a multilingual master',
    async () => {
      const result = await resolve(`${base}/master.html`, { audioLanguage: 'es' });
      expect(result.url).toBe(`${base}/media/audio_es.m3u8`);
      expect(result.audio).toMatchObject({ language: 'es', name: 'Español', matchedBy: 'exact' });
      expect(result.live).toBe(false);
      expect(result.candidates).toContain(`${base}/media/master.m3u8`);
    },
    TEST_TIMEOUT,
  );

  it(
    'refuses DRM-protected streams',
    async () => {
      await expect(resolve(`${base}/drm.html`)).rejects.toThrow(DrmError);
    },
    TEST_TIMEOUT,
  );

  it(
    'throws NoStreamError on a page with no media',
    async () => {
      await expect(resolve(`${base}/empty.html`, { timeoutMs: 6_000 })).rejects.toThrow(NoStreamError);
    },
    TEST_TIMEOUT,
  );
});

describe('saved profiles', () => {
  it(
    'a click step reaches a play control the generic selectors miss',
    async () => {
      const profile = parseProfile({
        id: 'custom-site',
        match: ['127\\.0\\.0\\.1'],
        steps: [
          { action: 'goto' },
          { action: 'dismissOverlays', selectors: [] },
          { action: 'click', selector: '.start-broadcast' },
        ],
        sniff: { kinds: ['hls'], urlPattern: '/media/' },
      });
      const result = await runProfile(profile, `${base}/custom.html`);
      expect(result.url).toBe(`${base}/media/vod.m3u8`);
      expect(result.profileId).toBe('custom-site');
    },
    TEST_TIMEOUT,
  );

  it(
    'testProfile grades a working profile ok (oracle skipped: no ffmpeg needed)',
    async () => {
      const profile = parseProfile({
        id: 'custom-site',
        match: ['127\\.0\\.0\\.1'],
        steps: [
          { action: 'goto' },
          { action: 'dismissOverlays', selectors: [] },
          { action: 'click', selector: '.start-broadcast' },
        ],
        sniff: { kinds: ['hls'] },
      });
      const test = await testProfile(profile, `${base}/custom.html`, { skipOracle: true });
      expect(test.ok).toBe(true);
      expect(test.result?.url).toBe(`${base}/media/vod.m3u8`);
    },
    TEST_TIMEOUT,
  );
});

describe('popup blocking', () => {
  it(
    'a popunder fired by the play click never becomes a page, and the stream still resolves',
    async () => {
      const browser = await launchBrowser(false);
      try {
        const ctx = await newBrowserContext(browser);
        const page = await ctx.newPage();
        const result = await runProfileOnPage(page, GENERIC_PROFILE, `${base}/popunder.html`);
        expect(result.url).toBe(`${base}/media/vod.m3u8`);
        // Give any would-be popup time to materialize before counting pages.
        await page.waitForTimeout(1_000);
        expect(ctx.pages()).toHaveLength(1);
      } finally {
        await browser.close();
      }
    },
    TEST_TIMEOUT,
  );
});

describe('probe', () => {
  it(
    'sees the traffic its own page triggers and censuses the page',
    async () => {
      const p = await probe(`${base}/vod.html`);
      expect(p.generic?.url).toBe(`${base}/media/vod.m3u8`);
      expect(p.candidates.map((c) => c.url)).toContain(`${base}/media/vod.m3u8`);
      expect(p.elements.some((e) => e.reason === 'looks like play')).toBe(true);
      expect(p.hints.join(' ')).toContain('Generic flow already resolved');
    },
    TEST_TIMEOUT,
  );
});
