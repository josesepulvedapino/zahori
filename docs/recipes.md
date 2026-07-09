# Recipes

Short, practical patterns. All use placeholder URLs.

## Transcribe a meeting

Resolve the stream, pull the audio, feed it to Whisper.

```bash
zahori get https://example.org/session --audio session.m4a
whisper session.m4a --model small --output_format srt
```

In a pipeline, keep the URL and headers and hand them to ffmpeg yourself:

```ts
import { resolve } from 'zahori';
import { spawn } from 'node:child_process';

const s = await resolve('https://example.org/session');
const headers = Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
spawn('ffmpeg', ['-headers', headers, '-i', s.url, '-vn', 'audio.m4a']);
```

## Record a live stream

`download` runs until the live stream ends or you stop the process.

```bash
zahori get https://example.org/live --download live.mp4
```

## Pick a language from a multilingual feed

```bash
zahori get https://example.org/plenary --lang es --json
```

If the site labels tracks with non-standard codes, save a profile with a `languageMap` (see [profiles.md](./profiles.md#pick)).

## Use it as a fallback resolver

If you already have a purpose-built scraper, call zahori only when yours fails to find the stream. zahori's generic flow and `heal` loop absorb site changes without a code change on your side.

```ts
import { resolve, NoStreamError } from 'zahori';

async function findStream(url: string) {
  try {
    return await myScraper(url);      // your fast, site-specific path
  } catch {
    return await resolve(url);        // zahori as the resilient fallback
  }
}
```

## Check a stream is real before archiving

```bash
zahori get https://example.org/live --validate
```

Or in code, so you never archive a slate or an ad:

```ts
import { resolve, validate } from 'zahori';

const s = await resolve(url);
const v = await validate(s);
if (v.verdict !== 'pass') throw new Error(`not real media: ${v.reason}`);
```

## Keep learned profiles in your repo

Save to the project so profiles travel to production and teammates:

```bash
zahori discover https://example.org/live   # writes .zahori/profiles/example-org.json
git add .zahori/profiles && git commit -m "learn example.org"
```
