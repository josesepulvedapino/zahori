# Contributing to zahori

## Dev setup

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm typecheck    # tsc --noEmit
pnpm test         # unit tests (fast, no browser)
pnpm test:e2e     # end-to-end: launches headless Chrome against a local fixture server (no internet)
pnpm test:all     # both
```

The e2e suite is hermetic: it spins up a local HTTP server that serves a fake player page and HLS manifests, and drives the full engine against it. It needs a Chromium browser (your installed Chrome works; otherwise `npx playwright install chromium`). It does not need ffmpeg.

## Project layout

| Path | What lives there |
|---|---|
| `src/runtime.ts` | The engine: executes a profile against a page, sniffs the network |
| `src/profile.ts` | Profile schema (Zod) + the built-in generic profile |
| `src/oracle.ts` | ffmpeg-based validation of resolved streams |
| `src/discover.ts` | Discovery primitives: probe / testProfile / saveProfile |
| `src/ai/` | BYO-key model loop (discover/heal) and model resolution |
| `src/mcp.ts` | MCP server exposing the discovery primitives to coding agents |
| `src/cli.ts` | The `zahori` CLI |
| `tests/` | Unit tests; `tests/e2e/` is the hermetic browser suite |

Design rules worth keeping:

- **Profiles are data, not code.** The engine interprets them deterministically; no AI at runtime.
- **Models propose, the oracle disposes.** Nothing gets saved unless the oracle passes it.
- **Never store a stream URL.** Profiles describe how to re-derive it.
- **Refuse DRM.** Always.

## Releasing

Versioning follows [SemVer](https://semver.org). While on `0.x`, minor bumps may include breaking changes; `1.0.0` marks API stability.

1. Update `CHANGELOG.md`: add a section for the new version with today's date.
2. `pnpm version patch` (or `minor` / `major`): bumps `package.json` and creates the `vX.Y.Z` git tag.
3. `git push && git push --tags`.
4. `gh release create vX.Y.Z --title vX.Y.Z --notes "<changelog section>"` to publish a GitHub Release.
5. `pnpm publish`: `prepublishOnly` runs typecheck + tests + build automatically before anything is uploaded.

The version in `package.json` is the single source of truth; the CLI (`--version`) and the MCP server read it at runtime. SemVer: on `0.x`, minor bumps may break; `1.0.0` marks API stability.
