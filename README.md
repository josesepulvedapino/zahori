<div align="center">

# zahori

**Find the media stream behind any web page.**

[![CI](https://github.com/josesepulvedapino/zahori/actions/workflows/ci.yml/badge.svg)](https://github.com/josesepulvedapino/zahori/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/zahori.svg)](https://www.npmjs.com/package/zahori)
[![node](https://img.shields.io/node/v/zahori.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A real browser opens the page, dismisses the overlays, presses play, and watches the network until the media request appears. You get the stream URL (HLS, DASH, MP4 or audio) plus the headers needed to replay it.

</div>

```bash
$ npx zahori get https://example.org/live
https://cdn.example.org/hls/live/master.m3u8
```

No per-site configuration. No extractor to wait for. If a browser can play it, zahori can find it.

## Table of contents

- [Features](#features)
- [Why zahori](#why-zahori)
- [Install](#install)
- [CLI](#cli)
- [Library](#library)
- [Profiles: how zahori learns a site](#profiles-how-zahori-learns-a-site)
- [Teaching zahori a site](#teaching-zahori-a-site)
- [The oracle](#the-oracle)
- [Responsible use](#responsible-use)
- [API](#api)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Works on any URL, out of the box.** A built-in generic flow handles most pages with zero config.
- **Real browser engine.** Playwright drives a headless browser in the background; consent banners, play buttons and iframe players are handled automatically, in several languages.
- **Replay headers included.** Referer/Origin/UA/Cookie are captured from the real request, so ffmpeg and friends don't get 403'd.
- **HLS-aware.** Master vs media playlists, live vs VOD detection, and audio-rendition selection by language for multilingual streams.
- **Learnable.** Tricky sites become a small JSON *profile*, saved once, deterministic forever.
- **Agent-native (MCP).** Your coding agent can probe a site, author a profile, test it and save it.
- **Self-healing.** `zahori heal` repairs a profile when the site changes, using a BYO-key model, verified by an objective oracle before anything is saved.
- **DRM-refusing by design.** Protected content is detected and rejected, always.

## Why zahori

The long tail of the web streams through embedded players that no downloader knows: local TV and radio stations, live event pages, small video portals. [yt-dlp](https://github.com/yt-dlp/yt-dlp) is superb for the big platforms it curates extractors for. But the long tail has no extractor, and hand-writing one per site doesn't scale.

| | yt-dlp | zahori |
|---|---|---|
| Coverage | ~1,800 curated sites | any page a browser can open |
| Method | per-site extractor code | real browser + network sniffing |
| New site | wait for a maintainer | works generically, or learn it in minutes |
| Site changed | extractor breaks until patched | `zahori heal` repairs the profile |

They are complementary: use yt-dlp for YouTube, use zahori for the page nobody wrote an extractor for.

## Install

```bash
npm install -g zahori   # CLI
npm install zahori      # library
```

**Requirements**

| | |
|---|---|
| Node | ≥ 20 |
| Browser | run `npx playwright install chromium --only-shell` once; otherwise your installed Google Chrome is used |
| ffmpeg | optional, only for `--validate`, `--download` and the discovery oracle |

> **pnpm users:** pnpm blocks dependency build scripts by default, so Playwright won't auto-download a browser. Run the `playwright install` line above once, or your system Chrome is used as a fallback.

## CLI

```bash
# Resolve the stream URL behind a page (URL to stdout, everything else to stderr)
zahori get https://tv.example.org/live

# Full result as JSON: url, kind, live/VOD, replay headers, all candidates
zahori get https://tv.example.org/live --json

# Prefer an audio language on multilingual streams
zahori get https://tv.example.eu/live --lang es

# Record it (replays the captured headers; needs ffmpeg)
zahori get https://tv.example.org/live --download session.mp4
zahori get https://tv.example.org/live --audio session.m4a

# Check the stream is real media, not a bumper or geo-block slate
zahori get https://tv.example.org/live --validate

# Watch the browser work
zahori get https://tv.example.org/live --headful
```

The `--json` output looks like this:

```bash
$ zahori get https://example.org/watch --json
{
  "url": "https://cdn.example.org/hls/master.m3u8",
  "kind": "hls",
  "headers": {
    "referer": "https://example.org/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/150.0.0.0 Safari/537.36"
  },
  "profileId": "generic",
  "candidates": [
    "https://cdn.example.org/hls/master.m3u8",
    "https://cdn.example.org/hls/720p/index.m3u8",
    "https://cdn.example.org/hls/1080p/index.m3u8"
  ]
}
```

> Resolved URLs are often signed and short-lived. zahori re-derives the stream fresh on every run, so use the URL immediately and never store it.

## Library

```ts
import { resolve } from 'zahori';

const stream = await resolve('https://tv.example.org/live', {
  audioLanguage: 'es', // optional, for multilingual masters
});

stream.url;     // the media URL
stream.kind;    // 'hls' | 'dash' | 'mp4' | 'audio'
stream.live;    // true = live, false = VOD, undefined = unknown
stream.headers; // Referer/Origin/UA/Cookie to replay (many CDNs 403 without them)
```

Pass `stream.headers` to whatever fetches the URL. With ffmpeg:

```ts
import { download } from 'zahori';
await download(stream, 'session.mp4');
```

Errors are typed: `NoStreamError` (nothing captured) and `DrmError` (protected content, refused).

### Bring your own browser

For sites behind a login, drive zahori inside a Playwright context you control (e.g. one with storage state):

```ts
import { runProfileOnPage, GENERIC_PROFILE } from 'zahori';

const ctx = await browser.newContext({ storageState: 'auth.json' });
const page = await ctx.newPage();
const stream = await runProfileOnPage(page, GENERIC_PROFILE, url);
```

## Profiles: how zahori learns a site

zahori ships **zero site knowledge**. Most pages resolve with the built-in generic flow. When one doesn't, the fix is a *profile*: a small JSON file describing how to open that site (which elements to click, how to recognize the media request, which candidate to pick). Profiles are data, not code; the engine interprets them deterministically, with no AI at runtime.

```json
{
  "id": "tv-example-org",
  "match": ["^https?://([^/]*\\.)?tv\\.example\\.org([/:?#]|$)"],
  "steps": [
    { "action": "goto" },
    { "action": "dismissOverlays", "selectors": [] },
    { "action": "click", "selector": ".broadcast-start" }
  ],
  "sniff": { "kinds": ["hls"], "urlPattern": "/live/" }
}
```

Profiles live in `.zahori/profiles/` in your project (commit them, so they travel to production and teammates) or `~/.zahori/profiles/` globally. A profile stores *how to re-derive* the stream, never a stream URL, so signed or expiring URLs are never a problem.

## Teaching zahori a site

### With your coding agent (MCP)

zahori is an MCP server: any MCP-capable agent can probe a site, propose a profile, test it against the oracle, and save it when it passes, using the subscription you already have and no API key. The server sends its workflow instructions to the agent during the protocol handshake, so this works the same in every client.

Most clients take the standard config:

```json
{
  "mcpServers": {
    "zahori": { "command": "npx", "args": ["-y", "zahori", "mcp"] }
  }
}
```

| Client | Setup |
|---|---|
| Cursor | add the block above to `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`) |
| VS Code / Copilot | `.vscode/mcp.json`, under a `"servers"` key instead of `"mcpServers"` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Claude Code | `claude mcp add zahori -- npx -y zahori mcp` |
| Codex CLI | `codex mcp add zahori -- npx -y zahori mcp` |
| Gemini CLI | `gemini mcp add zahori npx -y zahori mcp` |
| Claude Desktop | add the block above to `claude_desktop_config.json` |

Then ask: *"figure out the stream on https://tricky.example.org and save a profile"*. Tools exposed: `zahori_get`, `zahori_probe`, `zahori_test_profile`, `zahori_save_profile`, `zahori_validate`, `zahori_list_profiles`.

### Headless, with your own key

For unattended pipelines (cron, CI), zahori can drive a model itself. It always tries the free deterministic path first and only spends tokens when that fails:

```bash
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY, or a local Ollama
zahori discover https://tricky.example.org --model anthropic:claude-sonnet-5
zahori heal     https://tricky.example.org   # when a saved profile stops working
```

Model specs: `anthropic:<model>`, `openai:<model>`, `ollama:<model>`, `compat:<model>` (any OpenAI-compatible endpoint), or set `ZAHORI_MODEL` once. The model only *proposes* profiles; the engine runs each proposal and the oracle grades it, so nothing unverified is ever saved.

## The oracle

"Did anything download" is a weak test: it blesses ad bumpers, hold music and geo-block slates. The oracle combines stronger signals before trusting a stream.

- **Decode probe.** ffmpeg decodes a bounded window and measures volume.
- **Manifest sanity.** A real session has many segments; a slate has four.
- **Silence tolerance.** A silent window triggers a second probe further in (silence can be a legitimate recess), and silence alone never fails a stream.
- **Loud failures.** 403/401 responses are reported as header problems, not mysteries.

Verdicts are `pass`, `fail` or `inconclusive`; discovery only saves profiles the oracle passes.

## Responsible use

zahori is built for **publicly accessible, unprotected streams**: pages that already play for any visitor in a normal browser. It resolves what the browser already plays; it does not break into anything.

**By design, zahori refuses DRM.** Widevine, PlayReady and FairPlay markers are detected in the manifest and rejected with an explicit `DrmError`. It never attempts to bypass encryption or access controls; this is a hard line, not a setting.

**The safe perimeter.** The clearest ground is open HLS/DASH that a site serves to every visitor, used for lawful purposes such as archiving, accessibility, transcription and research. A few things worth knowing before you point it somewhere:

- **"Public" is not "public domain."** A stream being freely viewable does not make it freely reusable; some sites license their audiovisual output under separate terms. Check the site's reuse terms.
- **DRM-free is not the same as unprotected in law.** In some jurisdictions, circumventing even a lightweight token or signature scheme can raise anti-circumvention questions (US DMCA §1201). zahori stays on the safe side by refusing DRM and never defeating access gates. Keep it that way.
- **In the EU**, text-and-data-mining exceptions (DSM Directive Arts. 3 and 4) allow reproduction of lawfully accessible works unless the rightsholder has opted out in a machine-readable way. Respect opt-outs.

You are responsible for complying with the terms of service, copyright, and local law of the sites you use it on. When in doubt, prefer content that is explicitly open, and ask the institution.

## API

| Export | What it does |
|---|---|
| `resolve(url, opts?)` | Resolve the stream behind a page (profile or generic flow) |
| `validate(stream, opts?)` | Oracle: is this real media? |
| `download(stream, path, opts?)` | Record with ffmpeg, replaying headers |
| `probe(url, opts?)` | Structured page census for authoring profiles |
| `testProfile(profile, url, opts?)` | Run a candidate profile and grade it |
| `saveProfile(profile, dir)` / `loadProfiles()` | Persist / load profiles |
| `discoverProfile(url, opts?)` / `healProfile(profile, url, opts?)` | Model-assisted learn / repair |
| `runProfile(profile, url, opts?)` / `runProfileOnPage(page, ...)` | Execute a profile (own browser / yours) |
| `hostPattern(url)` / `profileIdFromUrl(url)` | Helpers for authoring profiles |

Full TypeScript types ship with the package.

## Documentation

Full guides live in [`docs/`](./docs):

- [CLI](./docs/cli.md): every command and flag
- [Library API](./docs/api.md): exported functions and types
- [Profiles](./docs/profiles.md): the JSON format for teaching zahori a site
- [MCP](./docs/mcp.md): using zahori from a coding agent
- [Recipes](./docs/recipes.md): end-to-end examples

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup, test suites and release process.

## License

[MIT](./LICENSE) © Jose Sepulveda
