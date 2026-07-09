# MCP

zahori is an MCP server, so a coding agent can teach it a site using the subscription you already have, with no API key. The agent probes a page, drafts a profile, tests it against the oracle, and saves it when it passes.

The server sends its workflow instructions to the agent during the handshake, so it behaves the same in every client.

## Add it to your client

Most clients take this config:

```json
{
  "mcpServers": {
    "zahori": { "command": "npx", "args": ["-y", "zahori", "mcp"] }
  }
}
```

| Client | Where |
|---|---|
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| VS Code / Copilot | `.vscode/mcp.json`, under `"servers"` instead of `"mcpServers"` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Claude Code | `claude mcp add zahori -- npx -y zahori mcp` |
| Codex CLI | `codex mcp add zahori -- npx -y zahori mcp` |
| Gemini CLI | `gemini mcp add zahori npx -y zahori mcp` |
| Claude Desktop | `claude_desktop_config.json` |

## Tools

| Tool | What it does |
|---|---|
| `zahori_get` | Resolve the stream behind a page. The fast path. |
| `zahori_probe` | Report media requests, iframes, and play/consent elements for a page. |
| `zahori_test_profile` | Run a candidate profile and grade it with the oracle. |
| `zahori_save_profile` | Persist a profile (project by default, or global). |
| `zahori_validate` | Run the oracle on a resolved stream. |
| `zahori_list_profiles` | List saved profiles. |

## The loop

Ask your agent something like *"figure out the stream on https://tricky.example.org and save a profile."* It will:

1. `zahori_get` first. If it resolves, done.
2. Otherwise `zahori_probe` to see what the page does.
3. Draft a profile and `zahori_test_profile`. Iterate until `ok: true`.
4. `zahori_save_profile`.

The agent supplies the reasoning; zahori executes and verifies. A profile is only saved after the oracle passes it, so nothing unchecked survives. Profile format is in [profiles.md](./profiles.md).
