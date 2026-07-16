# agentic-browser-mcp

A standalone **MCP server** that gives any MCP client (Codex, Claude, etc.) browser automation via **Playwright**. Drive a real, already-logged-in Chrome through the Chrome DevTools Protocol — share cookies and sessions across agents.

Originally extracted from the [pi coding agent](https://pi.dev)'s browser extension, now a standalone server so **Codex / pi / any MCP client** can all use the same browser.

## Features

- **11 tools**: `browser_session`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_storage`, `browser_console`, `browser_wait_human`, `browser_screenshot`, `browser_close`
- **Two session modes**:
  - `real` — `connectOverCDP` to an existing Chrome on port `9222` (reuse your logged-in profile: cookies, sessions, 2FA)
  - `isolated` — `launchPersistentContext` with an independent profile (headed/headless)
- **Auto-launch Chrome**: if port 9222 is down, the server spawns your Chrome starter script and waits for it — no manual browser launch needed.
- **Element Ref targeting** (Cursor-style): `snapshot` numbers every interactive element with a stable `ref` (`e1`, `e2`, …) and returns lines like `- [ref=e3] button "Sign in"`; `click`/`type` target by `ref` for precision, or fall back to `role` + `name`. It pierces open shadow roots and skips `aria-hidden`/off-screen elements — no fragile selector guessing.
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
| `browser_snapshot` | Return interactive elements with `ref` numbers, e.g. `- [ref=e3] button "Sign in"`. Use `ref` for `click`/`type`. |
| `browser_click` | Click by `ref` (preferred, e.g. `e3`) or `role` (+`name`). |
| `browser_type` | Fill an input by `ref` (preferred) or `role` (+`name`). |
| `browser_eval` | Run a JS expression in the page (read DOM/storage/fire requests). |
| `browser_storage` | Read `cookies` / `localStorage` / `sessionStorage`. |
| `browser_console` | Read buffered console logs (optional `level` filter). |
| `browser_wait_human` | For CAPTCHAs/manual steps — returns a prompt; the calling agent pauses and waits for the user. |
| `browser_screenshot` | Save a PNG to disk. |
| `browser_close` | Close the current session (`real` only disconnects CDP, never kills your Chrome). |

## Element targeting (ref)

Every `browser_snapshot` injects a script that scans the page for interactive elements (links, buttons, inputs, `[role]`s, `[contenteditable]`, `[tabindex]`, …), **pierces open shadow roots**, and assigns each visible element a short `ref` id (`e1`, `e2`, …) via a `data-agent-ref` attribute. Elements that are `aria-hidden` or off-screen are filtered out. The returned text looks like:

```
- [ref=e1] link "Docs"
- [ref=e2] searchbox "Search"
- [ref=e3] button "Sign in"
```

Then call `click` / `type` with that `ref`:

```
click   { ref: "e3" }                         # precise — the exact element snapshotted
click   { role: "button", name: "Sign in" }   # fallback when you have no ref
type    { ref: "e2", text: "playwright" }
```

> **Refs are ephemeral.** Each `snapshot` renumbers elements from scratch, so a `ref` is only valid until the next `snapshot`. If the page changes (navigation, dynamic content, new elements), re-run `snapshot` before clicking. Old `data-agent-ref` attributes are cleared on every snapshot.

## Notes

- **`browser_wait_human`**: this server has no GUI/TUI. It returns a text prompt; the client agent is expected to surface it and wait for the user to reply.
- **Session sharing**: multiple MCP clients connecting to the same server share one Playwright session (and thus one Chrome). Tool calls are serialized to prevent races.
- **Resource cleanup**: on `stdin` EOF, transport close, or `SIGINT`/`SIGTERM`, the server disposes the session (with a 3s timeout fallback) — `isolated` browsers won't be orphaned.

## License

MIT
