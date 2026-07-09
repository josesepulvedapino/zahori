# CLI

```bash
npm install -g zahori
```

Five commands: `get`, `discover`, `heal`, `mcp`, `profiles`. Run `zahori <command> --help` for the flags.

## get

Resolve the stream behind a page.

```bash
zahori get <url> [options]
```

The stream URL goes to stdout. Everything else (notes, errors, progress) goes to stderr, so `get` composes in pipes:

```bash
zahori get https://example.org/live | xargs -I{} ffmpeg -i {} out.mp4
```

| Flag | Effect |
|---|---|
| `--json` | Print the full result (url, kind, live, headers, candidates) instead of just the URL. |
| `--download <file>` | Record the stream to a file. Needs ffmpeg. |
| `--audio <file>` | Record audio only. Needs ffmpeg. |
| `--validate` | Run the ffmpeg oracle and print the verdict. |
| `--profile <id>` | Force a saved profile instead of auto-matching. |
| `--lang <code>` | Preferred audio language for multilingual streams (e.g. `es`). |
| `--headful` | Show the browser window. |
| `--timeout <ms>` | Page timeout in milliseconds. |

Examples:

```bash
# Just the URL
zahori get https://example.org/live

# Full detail
zahori get https://example.org/live --json

# Record, replaying the captured headers
zahori get https://example.org/live --download session.mp4

# Spanish audio from a multilingual master
zahori get https://example.org/plenary --lang es
```

## discover

Learn a profile for a new site. Tries the free deterministic path first, then a BYO-key model.

```bash
zahori discover <url> [--model <spec>] [--rounds <n>] [--no-save] [--global] [--headful]
```

| Flag | Effect |
|---|---|
| `--model <spec>` | `anthropic:<model>`, `openai:<model>`, `ollama:<model>`, or `compat:<model>`. Defaults to `ZAHORI_MODEL` or whichever API key is set. |
| `--rounds <n>` | Max model attempts before giving up. |
| `--no-save` | Print the profile but do not write it. |
| `--global` | Save to `~/.zahori` instead of the project. |
| `--headful` | Show the browser window. |

Progress prints to stderr; the learned profile prints to stdout. See [profiles.md](./profiles.md) for the format and [mcp.md](./mcp.md) for the no-API-key path through your agent.

## heal

Repair a saved profile that stopped working. Re-tests the current profile first (the site may have recovered), then asks the model, seeding it with the profile that used to work.

```bash
zahori heal <url> [--profile <id>] [--model <spec>] [--rounds <n>] [--no-save] [--headful]
```

## mcp

Start the MCP server on stdio, for coding agents.

```bash
zahori mcp
```

You rarely run this by hand. Your agent launches it. See [mcp.md](./mcp.md).

## profiles

List the profiles saved on this machine and in the current project.

```bash
zahori profiles
```

## Exit codes

`0` on success. `1` on failure (no stream, DRM refused, or a config error). Error messages go to stderr.
