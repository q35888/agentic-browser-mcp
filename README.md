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

### Path configuration (env vars)

All paths go through env vars with defaults that fall back to the Pi env layout. To deploy on a different device/path, set one or more env vars:

| Env var | Default | Purpose |
|---|---|---|
| `AGENT_BROWSER_DIR` | `~/.pi/agent` | Root dir; other paths derive from this |
| `AGENT_BROWSER_CHROME_STARTER` | `<AGENT_BROWSER_DIR>/start-agent-chrome.sh` | Chrome launch script |
| `AGENT_BROWSER_CDP_PROFILE` | `<AGENT_BROWSER_DIR>/chrome-cdp-profile` | CDP-mode profile dir |
| `AGENT_BROWSER_ISOLATED_PROFILE` | `<AGENT_BROWSER_DIR>/bw-mcp-profile` | Isolated-mode profile dir |
| `AGENT_BROWSER_LOG_FILE` | `os.tmpdir()/agentic-browser-mcp-chrome.log` | Chrome startup log |
| `AGENT_BROWSER_CDP_PORT` | `9222` | Chrome DevTools Protocol port |

Override examples:

```bash
# Change only the root (others follow)
AGENT_BROWSER_DIR=/data/my-agent node index.mjs

# Fine-grained control
AGENT_BROWSER_CHROME_STARTER=/opt/chrome/launch.sh \
AGENT_BROWSER_CDP_PROFILE=/opt/chrome/profiles/logged-in \
node index.mjs
```

All paths in error messages and tool descriptions are dynamic — no hardcoded `~/.pi/agent`.

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
# ⚠️ Profile path is controlled by AGENT_BROWSER_CDP_PROFILE (default: $HOME/.pi/agent/chrome-cdp-profile).
# No logins? Run sync-profile.sh once to copy them from your daily Chrome.
# Check if a profile has a site's login:
#    strings <profile>/Default/Cookies | grep -i <domain>   # hits = cookies present
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

If you don't start Chrome manually, the server auto-launches: first tries the `AGENT_BROWSER_CHROME_STARTER` script (default `$HOME/.pi/agent/start-agent-chrome.sh`); **if absent, falls back to a builtin direct spawn** (cross-platform chrome lookup, zero external deps). To customize, set `AGENT_BROWSER_CHROME_STARTER` to your own script.

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
| `browser_navigate` | Opens a URL. Passing `profile` explicitly only reconnects CDP when profile differs from current session (passing the default `"real"` no longer triggers a needless reconnect). |
| `browser_snapshot` | Lists interactive elements with `ref` ids. Default `mode=viewport` (only in-viewport, saves tokens); `mode=all` returns all. **`refreshActivePage` runs before every tool call** — newly opened tabs (`<a target="_blank"`> / `window.open()`) are automatically followed. |
| `browser_click` | Click by `ref` (preferred, e.g. `e3`) or `role` (+`name`). `ref` is validated (`^e\d+$`) and checked for exactly one match (0=stale, >1=duplicate → re-snapshot). |
| `browser_type` | Fill an input by `ref` (preferred) or `role` (+`name`). Same ref validation as `click`. |
| `browser_eval` | Run a JS expression in the page (read DOM/storage/fire requests). |
| `browser_storage` | Read `cookies` / `localStorage` / `sessionStorage`. |
| `browser_console` | Reads buffered console logs (optional `level` filter). Listener is bound on `context.on("page")`, so console logs from newly opened tabs are also collected. |
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

📌 **Multi-tab behavior** — Every tool call runs `refreshActivePage(s)` first, switching `s.page` to the last entry of `context.pages()`. This means:
- ✅ `click <a target="_blank">`, `window.open()`, `browser_navigate` opening a new tab → subsequent operations auto-follow the new tab
- ❌ **Manual tab switching in Chrome UI is NOT tracked** (Playwright CDP exposes no stable "focused tab" API)
- ❌ Closing the last tab → falls back to the second-to-last; closing all tabs → error, rebuild via `browser_session`
- Fallback: use `browser_eval` to call `chrome.tabs.update({active: true})`

📖 **Helping a user set up this MCP?** Read [`docs/agent-guide.md`](./docs/agent-guide.md) — environment discovery, install, per-client config (Codex/Claude Desktop/Cursor), Chrome setup, verification, and common pitfalls.

🆚 **How does this compare to the official `@playwright/mcp`?** See [`docs/vs-playwright-mcp.md`](./docs/vs-playwright-mcp.md) — same Playwright underneath, different trade-offs (login-state reuse, token-efficient snapshots, auto-launched Chrome, Chinese-first tool descriptions).

- **`browser_wait_human`**: this server has no GUI/TUI. It returns a text prompt; the client agent is expected to surface it and wait for the user to reply.
- **Session sharing**: multiple MCP clients connecting to the same server share one Playwright session (and thus one Chrome). Tool calls are serialized to prevent races.
- **Resource cleanup**: on `stdin` EOF, transport close, or `SIGINT`/`SIGTERM`, the server disposes the session (with a 3s timeout fallback) — `isolated` browsers won't be orphaned.

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:9222` / Chrome not running** — In `real` mode the server probes 9222 via `node:http.get /json/version` (`agent:false` explicitly bypasses `http_proxy`/`https_proxy`, avoiding false "port closed" when your proxy would intercept the localhost probe). **Probing TCP alone is not enough** — Chrome startup order is TCP first → then DevTools HTTP → then `/json/version` responds; checking only TCP causes a race (TCP up but `connectOverCDP` immediately throws). So it waits for `/json/version` 200. If closed, it calls `spawnStarter()`: tries the `AGENT_BROWSER_CHROME_STARTER` script first (if it exists); **otherwise builtin-direct-spawns chrome** — cross-platform executable lookup (Linux `/usr/bin/google-chrome-stable` etc, Windows `Program Files`, macOS `/Applications/Google Chrome.app`), using `detached:true` + `--remote-debugging-port=${CDP_PORT}` + `--user-data-dir=${CDP_PROFILE}`. Polls for up to 20s. If auto-start still fails, launch Chrome manually.
- **`fill: Timeout … element is not visible`** — You likely clicked/typed a hidden element (e.g. a `0×0`/`opacity:0` decorative control). Re-run `snapshot`; the visibility filter should now exclude it. If a genuinely visible element still fails, its ref may be stale — re-snapshot.
- **`ref=eN 未命中` (stale ref)** — The page changed since the last `snapshot` (navigation, dynamic content, element removed/re-rendered). Re-run `snapshot` and use the new ref.
- **`ref=eN 命中 N 个` (duplicate ref)** — A snapshot-internal error (refs should be unique). Re-snapshot; if it persists, file an issue.
- **Snapshot too noisy / too many elements** — You're probably on `mode=all`. The default is `mode=viewport` (in-viewport only). Scroll then re-snapshot, or stay on the default.
- **Does `browser_close()` kill my real Chrome?** — No. Under `connectOverCDP`, `browser.close()` only drops the CDP connection; the real Chrome process and its tabs survive (verified). It's safe to call.
- **`CSS is not defined`** — (Fixed in newer versions.) The Node-side tool handler must not use browser globals like `CSS`/`document`; only code inside `page.evaluate()` runs in the browser.

## License

MIT
