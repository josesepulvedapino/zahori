# Changelog

## 0.1.0 (2026-07-09)

Initial release.

- **Engine**: deterministic profile runtime on Playwright that navigates, dismisses consent overlays (multi-language), presses play (common web players + generic affordances, across iframes), sniffs HLS/DASH/MP4/audio from network traffic, and returns the stream URL with replay headers. Runs headless (chromium headless shell, installed Chrome as fallback); page-initiated popups are blocked.
- **Profiles**: declarative JSON (Zod-validated) describing how to open one site; project-local (`.zahori/profiles`) and global (`~/.zahori/profiles`) storage; anchored host matching; built-in generic profile so any URL works with zero config.
- **HLS extras**: master-playlist audio-rendition parsing and language selection (exact / mapped / fallback / default), live-vs-VOD detection, DRM detection with explicit refusal.
- **Oracle**: ffmpeg decode probe + volume measurement + manifest sanity (segment count, plausible duration, expected-duration cross-check), with silence-tolerant retry windows.
- **MCP server** (`zahori mcp`): agent-native site learning via `zahori_get`, `zahori_probe`, `zahori_test_profile`, `zahori_save_profile`, `zahori_validate`, `zahori_list_profiles`.
- **Headless discovery** (`zahori discover` / `zahori heal`): BYO-key model loop (Anthropic / OpenAI / Ollama / OpenAI-compatible) that proposes profiles, deterministic-first; every proposal is executed and graded by the oracle before being saved.
- **CLI**: `get` (with `--json`, `--download`, `--audio`, `--validate`, `--lang`, `--headful`), `discover`, `heal`, `profiles`, `mcp`.
