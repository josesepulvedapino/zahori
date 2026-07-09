# Profiles

A profile is a JSON file that tells zahori how to open one site and find its stream. You don't need one for most pages; the built-in generic flow handles them. Save a profile after solving a stubborn site once, and every later run on it is instant and deterministic.

A profile stores *how to re-derive* the stream, never the stream URL. That's why it keeps working when the URL is signed or expires: each run re-opens the page and captures a fresh one.

## A minimal example

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

Open tv.example.org, close the cookie banner, click the start button, and keep the HLS URL containing `/live/`.

## Where they live

zahori loads profiles from these directories, later ones winning on an id clash:

1. `~/.zahori/profiles/`: global, per machine.
2. `<project>/.zahori/profiles/`: per project. Commit these so they travel to production and teammates.

Each file is `<id>.json`.

## How one gets chosen

On `resolve(url)`, zahori keeps the saved profile whose `match` hits the URL, highest `priority` first. No match falls back to the generic flow. Force one with `--profile <id>`.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | | Stable id and filename. |
| `match` | yes | | URL regex patterns. Matches if any one hits. |
| `name` | no | `""` | Human label. |
| `priority` | no | `0` | Higher wins when several match. The generic flow is `-100`. |
| `steps` | no | `[]` | Ordered page actions (below). |
| `sniff` | no | see below | How to spot the media request. |
| `pick` | no | see below | How to choose among candidates. |
| `notes` | no | | Free text, ignored by the engine. |

The library exports `hostPattern(url)` to build a correct `match` pattern for a host.

## steps

Actions run in order. zahori clicks inside iframes on its own, so prefer `play` and `dismissOverlays` with empty selector lists unless a probe shows you need a specific control.

**goto**: navigate.
```json
{ "action": "goto", "waitUntil": "domcontentloaded" }
```
`url` defaults to the input URL. `waitUntil` is `load`, `domcontentloaded`, or `networkidle`.

**dismissOverlays**: close consent/cookie/age banners. Empty list uses the built-in multi-language set.
```json
{ "action": "dismissOverlays", "selectors": [] }
```

**play**: click the play control and nudge every `<video>`/`<audio>`. Empty list uses the built-in set (video.js, JW Player, Plyr, Kaltura, Flowplayer, generic).
```json
{ "action": "play", "selectors": [] }
```

**click**: click one selector, waited for across all frames.
```json
{ "action": "click", "selector": ".broadcast-start", "optional": false }
```
`optional: true` means the profile won't fail if the element is missing.

**waitFor**: wait for a selector and/or a fixed delay.
```json
{ "action": "waitFor", "selector": ".player-ready", "ms": 2000 }
```

**scroll**: some players lazy-load on scroll.
```json
{ "action": "scroll", "to": "bottom" }
```

**eval**: run JavaScript in the page. Advanced, and only in profiles you trust.
```json
{ "action": "eval", "script": "document.querySelector('video')?.play()" }
```

Empty `steps` runs a default of `goto` then `play`.

## sniff

```json
{
  "kinds": ["hls"],
  "urlPattern": "/live/",
  "urlExclude": "(advert|analytics|beacon)",
  "replayHeaders": ["referer", "origin", "user-agent", "cookie"]
}
```

| Field | Default | Meaning |
|---|---|---|
| `kinds` | `["hls","dash","mp4"]` | Accepted container types, in priority order. Add `audio` for audio-only. |
| `urlPattern` | | The media URL must match this regex. |
| `urlExclude` | | The media URL must not match this regex. |
| `replayHeaders` | `referer, origin, user-agent, cookie` | Headers carried into the result so the URL replays without a 403. |

Reach for `urlPattern` only when several media requests compete.

## pick

```json
{
  "variant": "master",
  "order": "first",
  "audioLanguage": "es",
  "languageMap": { "es": "spa" },
  "audioLanguageFallbacks": ["mul", "und"]
}
```

| Field | Default | Meaning |
|---|---|---|
| `variant` | `master` | For an HLS master: `master`, `highest`, `lowest`, or `audio-only`. |
| `order` | `first` | Keep the first or last matching capture. |
| `audioLanguage` | | Preferred audio for a multilingual master. `--lang` overrides per run. |
| `languageMap` | `{}` | Map ISO codes to a site's own LANGUAGE codes. |
| `audioLanguageFallbacks` | `[]` | LANGUAGE codes to try in order when the preferred one is absent. |

Audio picks in this order: exact ISO match (`es` also matches `es-ES`), the mapped code, each fallback, the `DEFAULT=YES` track, then the first track. The result says which rule matched.

## Creating one

**By hand.** Write `<id>.json`. Start from `zahori get <url> --json` to see the candidates and headers.

**With the AI loop.** `zahori discover <url>` proposes, tests against the oracle, and saves the first profile that passes.

**With your agent.** Over MCP, your agent runs `zahori_probe`, drafts a profile, calls `zahori_test_profile` until it passes, then `zahori_save_profile`. No API key. See [mcp.md](./mcp.md).

Always test before trusting:

```bash
zahori get https://tv.example.org/session/42 --profile tv-example-org --validate
```
