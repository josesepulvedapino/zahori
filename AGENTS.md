# zahori: guide for coding agents

TypeScript ESM library + CLI (Node ≥ 20, pnpm). Finds the media stream behind a web page with a real browser (Playwright), declarative site profiles, and an ffmpeg oracle.

## Commands

```bash
pnpm install
pnpm typecheck    # tsc --noEmit (strict)
pnpm test         # unit tests, fast, no browser
pnpm build        # tsup → dist/ (required before test:e2e)
pnpm test:e2e     # hermetic: headless Chrome vs a local fixture server + MCP protocol smoke
```

Always run `pnpm typecheck && pnpm test` after changes; run `pnpm build && pnpm test:e2e` when touching `src/runtime.ts`, `src/discover.ts`, `src/browser.ts` or `src/mcp.ts`.

## Design rules (do not break)

- **Profiles are data, not code.** The engine interprets them deterministically; no AI at runtime.
- **Models propose, the oracle disposes.** Nothing is saved unless the oracle passes it.
- **Never store a stream URL.** Profiles describe how to re-derive it; resolved URLs may be signed/expiring.
- **Refuse DRM.** `DrmError` on Widevine/PlayReady/FairPlay markers is intentional and must stay.
- Version lives only in `package.json` (`src/version.ts` reads it); never hardcode it elsewhere.
- Public API surface is `src/index.ts`; anything exported there is a semver commitment.

## Layout

`src/runtime.ts` engine · `src/profile.ts` schema + generic profile · `src/oracle.ts` ffmpeg validation · `src/discover.ts` probe/test/save primitives · `src/ai/` BYO-key loop · `src/mcp.ts` MCP server · `src/cli.ts` CLI · `tests/` unit · `tests/e2e/` browser + MCP suites.
