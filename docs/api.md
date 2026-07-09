# Library API

```bash
npm install zahori
```

ESM only, Node 20+. Full TypeScript types ship with the package.

## resolve

```ts
import { resolve } from 'zahori';

const stream = await resolve(url, {
  audioLanguage: 'es', // optional
  profileId: 'tv-example-org', // optional, force a profile
  timeoutMs: 45000, // optional
  headful: false, // optional
});
```

Returns a `StreamResult`:

```ts
interface StreamResult {
  url: string;            // the media URL, re-derived fresh each run
  kind: 'hls' | 'dash' | 'mp4' | 'audio';
  live: boolean | undefined;
  headers: Record<string, string>; // replay these when fetching
  profileId: string;      // which profile produced it ('generic' = built-in)
  candidates: string[];   // everything captured, for debugging
  audio?: { language: string; name: string; matchedBy: string };
}
```

Throws `NoStreamError` if nothing is captured, `DrmError` if the stream is protected.

## download

```ts
import { download } from 'zahori';

await download(stream, 'session.mp4');
await download(stream, 'audio.m4a', { audioOnly: true });
```

Records with ffmpeg, replaying `stream.headers`. For a live stream it records until the stream ends or the process is stopped.

## validate

```ts
import { validate } from 'zahori';

const v = await validate(stream);
// v.verdict: 'pass' | 'fail' | 'inconclusive'
// v.reason:  human-readable explanation
// v.signals: decoded, maxVolumeDb, manifest facts, ...
```

The oracle. Needs ffmpeg on the PATH (or pass `ffmpegPath`). See how it decides in the [project README](../README.md#the-oracle).

## Bring your own browser

For sites behind a login, run zahori inside a Playwright context you own:

```ts
import { runProfileOnPage, GENERIC_PROFILE } from 'zahori';

const ctx = await browser.newContext({ storageState: 'auth.json' });
const page = await ctx.newPage();
const stream = await runProfileOnPage(page, GENERIC_PROFILE, url);
// page stays open; you close it
```

## Discovery primitives

The building blocks behind `discover` and the MCP server. Use them to build your own learning loop.

```ts
import { probe, testProfile, saveProfile, loadProfiles } from 'zahori';

const p = await probe(url);              // media requests, iframes, play/consent elements
const t = await testProfile(profile, url); // run a candidate, grade it with the oracle
if (t.ok) await saveProfile(profile, dir);
const all = await loadProfiles();        // everything saved on this machine + project
```

## Model-assisted (BYO-key)

```ts
import { discoverProfile, healProfile } from 'zahori';

const r = await discoverProfile(url, {
  model: 'anthropic:claude-sonnet-5', // or openai:, ollama:, compat:
  maxRounds: 3,
  onProgress: (msg) => console.error(msg),
});
// r.ok, r.profile, r.savedTo, r.rounds (each attempt with its oracle verdict)
```

`healProfile(brokenProfile, url, opts)` repairs a profile that stopped working.

## Full export list

| Export | Kind |
|---|---|
| `resolve`, `findProfile` | resolve a stream / find its profile |
| `download` | record with ffmpeg |
| `validate` | oracle |
| `runProfile`, `runProfileOnPage` | execute a profile |
| `probe`, `testProfile`, `saveProfile`, `loadProfiles`, `defaultSaveDir` | discovery primitives |
| `discoverProfile`, `healProfile` | model-assisted learn / repair |
| `parseProfile`, `profileMatches`, `GENERIC_PROFILE`, `hostPattern`, `profileIdFromUrl` | profile helpers |
| `analyzeManifest`, `parseAudioTracks`, `selectAudioTrack`, `resolveUri` | HLS/manifest helpers |
| `launchBrowser`, `newBrowserContext` | browser helpers |
| `NoStreamError`, `DrmError` | error types |
| `VERSION` | package version string |

Types: `StreamResult`, `StreamKind`, `ResolveOptions`, `Profile`, `Step`, `SniffRule`, `PickRule`, `OracleResult`, `ProbeResult`, `DiscoverResult`, and more, all exported.
