# agentic-browser-mcp

**English** | [中文](./README.zh-CN.md)

A standalone **MCP server** that gives any MCP client (Codex, Claude, Grok, Cursor, …) browser automation on top of **Playwright**. Drive a real, already-logged-in Chrome through the Chrome DevTools Protocol — share cookies and sessions across agents. The goal: **every MCP client you use drives the same browser**, with the login state intact.

## Features

- **11 tools**: `browser_session`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_storage`, `browser_console`, `browser_wait_human`, `browser_screenshot`, `browser_close`
- **Two session modes**:
  - `real` — `connectOverCDP` to an existing Chrome on port `9222` (reuse your logged-in profile: cookies, sessions, 2FA)
  - `isolated` — `launchPersistentContext` with an independent profile (headed/headless)
- **Auto-launch Chrome**: if port 9222 is down, the server spawns your Chrome starter script and waits for it — no manual browser launch needed.
- **Element Ref targeting** (Cursor-style): `snapshot` numbers every interactive element with a stable `ref` (`e1`, `e2`, …) and returns lines like `- [ref=e3] button "Sign in"`; `click`/`type` target by `ref` for precision, or fall back to `role` + `name`. It pierces open shadow roots, maps native tags to implicit ARIA roles (`<a>`→`link`, `<select>`→`combobox`, …), and filters out hidden elements via `checkVisibility()` + non-zero size. **Default returns only in-viewport elements** (`mode=all` for everything) — big token savings on complex pages.
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

### Reusing your daily browser's login state

Chrome 136+ **silently ignores `--remote-debugging-port` on the default profile** (security hardening against infostealers), so the dedicated Chrome must use a separate `user-data-dir` and starts with no logins. To make it **carry all the logins from your daily Chrome** (Gmail, GitHub, internal SaaS, …), run the sync script:

```bash
# With the dedicated Chrome stopped (and daily Chrome idle or closed):
./scripts/sync-profile.sh
```

It copies `Cookies` / `Login Data` / `Web Data` / `Local State` from your default profile into the dedicated one — on Linux, the GNOME keyring key is shared per-user, so encrypted cookies decrypt transparently. Re-run it whenever you log in to a new site in your daily Chrome. See [`docs/agent-guide.md`](./docs/agent-guide.md), section "Reuse your daily logins", for details.

## Tools

| Tool | Description |
|---|---|
| `browser_session` | Start/switch a session (`real` / `isolated`, `headless`, `incognito`). No args = ensure default `real`. |
| `browser_navigate` | Open a URL. |
| `browser_snapshot` | List interactive elements with `ref` numbers, e.g. `- [ref=e3] button "Sign in"`. Default `mode=viewport` (in-viewport only, saves tokens); `mode=all` returns everything. Use `ref` for `click`/`type`. |
| `browser_click` | Click by `ref` (preferred, e.g. `e3`) or `role` (+`name`). `ref` is validated (`^e\d+$`) and checked for exactly one match (0=stale, >1=duplicate → re-snapshot). |
| `browser_type` | Fill an input by `ref` (preferred) or `role` (+`name`). Same ref validation as `click`. |
| `browser_eval` | Run a JS expression in the page (read DOM/storage/fire requests). |
| `browser_storage` | Read `cookies` / `localStorage` / `sessionStorage`. |
| `browser_console` | Read buffered console logs (optional `level` filter). |
| `browser_wait_human` | For CAPTCHAs/manual steps — returns a prompt; the calling agent pauses and waits for the user. |
| `browser_screenshot` | Save a PNG to disk. |
| `browser_close` | Close the current session (`real` only disconnects CDP, never kills your Chrome). |

## Element targeting (ref)

Every `browser_snapshot` injects a script that scans the page for interactive elements (links, buttons, inputs, `[role]`s, `[contenteditable]`, `[tabindex]`, …) and **pierces open shadow roots**. Each surviving element gets a short `ref` id (`e1`, `e2`, …) via a `data-agent-ref` attribute. The returned text looks like:

```
- [ref=e1] link "Docs"
- [ref=e2] searchbox "Search"
- [ref=e3] button "Sign in"
```

### Visibility & viewport filtering

An element is included only if it passes **both** checks:

1. **Visible** — `el.checkVisibility({ checkOpacity, checkVisibilityCSS, contentVisibilityAuto })` (falling back to `computed visibility !== 'hidden'` on old browsers) **and** a non-zero bounding rect. This filters `display:none`, `visibility:hidden`, `opacity:0`, `0×0`, and parent-hidden elements — the old `offsetParent` check missed these (e.g. DuckDuckGo's hidden `<input type=radio opacity:0 rect=0×0>` that broke `fill`).
2. **In viewport** (default `mode=viewport`) — `rect` intersects the viewport. Pass `mode=all` to include off-screen elements too. On a complex page this cuts the snapshot from ~150 elements to ~10, saving ~90% tokens.

### Role mapping

Native tags are mapped to their **implicit ARIA role** so the output matches what Playwright's `getByRole()` expects for the fallback path: `<a href>`→`link`, `<button>`/`<summary>`→`button`, `<textarea>`/text `<input>`→`textbox`, `<input type=search>`→`searchbox`, `checkbox`/`radio`, `<select>`→`combobox`. Explicit `role=` attributes always win.

### Using refs

```
click   { ref: "e3" }                         # precise — the exact element snapshotted
click   { role: "button", name: "Sign in" }   # fallback when you have no ref
type    { ref: "e2", text: "playwright" }
```

`ref` is validated against `^e\d+$` and the locator is checked for **exactly one match**: 0 → "stale ref, re-snapshot"; >1 → "duplicate ref, re-snapshot" (a snapshot-internal error).

> **Refs are ephemeral.** Each `snapshot` renumbers elements from scratch (clearing old `data-agent-ref` attrs, including inside shadow roots), so a `ref` is only valid until the next `snapshot`. If the page changes (navigation, dynamic content), re-run `snapshot` before acting. Output is truncated on whole-line boundaries with a `…[共 N 项，返回 M 项]` summary.

## Notes

📖 **Helping a user set up this MCP?** Read [`docs/agent-guide.md`](./docs/agent-guide.md) — environment discovery, install, per-client config (Codex/Claude Desktop/Cursor), Chrome setup, verification, and common pitfalls.

🆚 **How does this compare to the official `@playwright/mcp`?** See [`docs/vs-playwright-mcp.md`](./docs/vs-playwright-mcp.md) — same Playwright underneath, different trade-offs (login-state reuse, token-efficient snapshots, auto-launched Chrome, Chinese-first tool descriptions).

- **`browser_wait_human`**: this server has no GUI/TUI. It returns a text prompt; the client agent is expected to surface it and wait for the user to reply.
- **Session sharing**: multiple MCP clients connecting to the same server share one Playwright session (and thus one Chrome). Tool calls are serialized to prevent races.
- **Resource cleanup**: on `stdin` EOF, transport close, or `SIGINT`/`SIGTERM`, the server disposes the session (with a 3s timeout fallback) — `isolated` browsers won't be orphaned.

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:9222` / Chrome not running** — In `real` mode the server probes port 9222 via a raw TCP connection (`node:net`, **not** `fetch` — `fetch` honors `http_proxy`/`https_proxy` and would route the localhost probe to your HTTP proxy, falsely reporting the port down). If down, it auto-spawns `$CHROME_STARTER` (default `~/.pi/agent/start-agent-chrome.sh`) and polls for up to 20s. On Linux it uses `bash -c 'nohup … &'` (`spawn(…, {detached:true})` fails to start Chrome in this env); on Windows it spawns `chrome.exe` directly. If auto-launch still fails, start Chrome manually via the script above.
- **`fill: Timeout … element is not visible`** — You likely clicked/typed a hidden element (e.g. a `0×0`/`opacity:0` decorative control). Re-run `snapshot`; the visibility filter should now exclude it. If a genuinely visible element still fails, its ref may be stale — re-snapshot.
- **`ref=eN 未命中` (stale ref)** — The page changed since the last `snapshot` (navigation, dynamic content, element removed/re-rendered). Re-run `snapshot` and use the new ref.
- **`ref=eN 命中 N 个` (duplicate ref)** — A snapshot-internal error (refs should be unique). Re-snapshot; if it persists, file an issue.
- **Snapshot too noisy / too many elements** — You're probably on `mode=all`. The default is `mode=viewport` (in-viewport only). Scroll then re-snapshot, or stay on the default.
- **Does `browser_close()` kill my real Chrome?** — No. Under `connectOverCDP`, `browser.close()` only drops the CDP connection; the real Chrome process and its tabs survive (verified). It's safe to call.
- **`CSS is not defined`** — (Fixed in newer versions.) The Node-side tool handler must not use browser globals like `CSS`/`document`; only code inside `page.evaluate()` runs in the browser.

## License

MIT
