# agentic-browser-mcp

A standalone **MCP server** that gives any MCP client (Codex, Claude, etc.) browser automation via **Playwright**. Drive a real, already-logged-in Chrome through the Chrome DevTools Protocol — share cookies and sessions across agents.

Originally extracted from the [pi coding agent](https://pi.dev)'s browser extension, now a standalone server so **Codex / pi / any MCP client** can all use the same browser.

## Features

- **11 tools**: `browser_session`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_storage`, `browser_console`, `browser_wait_human`, `browser_screenshot`, `browser_close`
- **Two session modes**:
  - `real` — `connectOverCDP` to an existing Chrome on port `9222` (reuse your logged-in profile: cookies, sessions, 2FA)
  - `isolated` — `launchPersistentContext` with an independent profile (headed/headless)
- **Auto-launch Chrome**: if port 9222 is down, the server spawns your Chrome starter script and waits for it — no manual browser launch needed.
- **Stable element targeting**: `snapshot` returns an ARIA accessibility tree (YAML); `click`/`type` target by `role` + `name` — no fragile ref/snapshot layers.
- **Transports**: `stdio` (default, for Codex-style spawn) and `http` (stateless streamable, `--transport http --port 9223`).

## Requirements

- Node.js ≥ 18
- Playwright-compatible Chrome/Chromium installed (`google-chrome-stable` works)
- For `real` mode: a Chrome instance running with `--remote-debugging-port=9222` and a dedicated `user-data-dir` (see [Start Chrome with CDP](#start-chrome-with-cdp))

## Install

```bash
git clone https://github.com/q35888/agentic-browser-mcp.git
cd agentic-browser-mcp
npm install
```

## Configure your MCP client

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.agentic-browser]
type = "stdio"
command = "/usr/bin/node"
args = [ "/path/to/agentic-browser-mcp/index.mjs" ]
```

### Any MCP client (stdio)

Spawn `node /path/to/agentic-browser-mcp/index.mjs` over stdio — standard MCP `initialize` → `tools/list` → `tools/call`.

### HTTP mode (long-running single instance)

```bash
node index.mjs --transport http --port 9223
# POST MCP requests to http://127.0.0.1:9223/mcp
```

## Start Chrome with CDP (for `real` mode)

Chrome 150+ requires a non-default user-data-dir for remote debugging. Example starter script:

```bash
#!/usr/bin/env bash
PROFILE="$HOME/.agentic-browser-chrome-profile"
mkdir -p "$PROFILE"
# Fill in graphics session env if spawning from a non-graphical context
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
exec google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  "$@"
```

> `--ozone-platform=wayland` is important when Chrome is spawned from a background process: otherwise Chrome's platform heuristic picks X11 and fails with `Missing X server / Authorization required`. Adjust for your display server (X11 users: drop the flag and ensure `DISPLAY`/`XAUTHORITY` are set).

If you don't start Chrome manually, the server will try to launch `$HOME/.pi/agent/start-agent-chrome.sh` automatically (override `CHROME_STARTER` in `index.mjs` to point at your own script).

## Tools

| Tool | Description |
|---|---|
| `browser_session` | Start/switch a session (`real` / `isolated`, `headless`, `incognito`). No args = ensure default `real`. |
| `browser_navigate` | Open a URL. |
| `browser_snapshot` | Return the page's ARIA tree (YAML). Use `role`+`name` for `click`/`type`. |
| `browser_click` | Click an element by `role` (+`name`). |
| `browser_type` | Fill an input by `role` (+`name`). |
| `browser_eval` | Run a JS expression in the page (read DOM/storage/fire requests). |
| `browser_storage` | Read `cookies` / `localStorage` / `sessionStorage`. |
| `browser_console` | Read buffered console logs (optional `level` filter). |
| `browser_wait_human` | For CAPTCHAs/manual steps — returns a prompt; the calling agent pauses and waits for the user. |
| `browser_screenshot` | Save a PNG to disk. |
| `browser_close` | Close the current session (`real` only disconnects CDP, never kills your Chrome). |

## Notes

- **`browser_wait_human`**: this server has no GUI/TUI. It returns a text prompt; the client agent is expected to surface it and wait for the user to reply.
- **Session sharing**: multiple MCP clients connecting to the same server share one Playwright session (and thus one Chrome). Tool calls are serialized to prevent races.
- **Resource cleanup**: on `stdin` EOF, transport close, or `SIGINT`/`SIGTERM`, the server disposes the session (with a 3s timeout fallback) — `isolated` browsers won't be orphaned.

## License

MIT
