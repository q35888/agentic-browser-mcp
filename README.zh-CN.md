# agentic-browser-mcp

[English](./README.md) | **中文**

一个独立的 **MCP server**,让任意 MCP client(Codex、Claude 等)通过 **Playwright** 拥有浏览器自动化能力。通过 Chrome DevTools Protocol 驱动一个真实的、**已登录**的 Chrome——在多个 agent 之间共享 cookie 和会话。

最初从 [pi coding agent](https://pi.dev) 的浏览器扩展中抽取,现在做成独立 server,让 **Codex / pi / 任意 MCP client** 都能用同一个浏览器。

## 特性

- **11 个工具**:`browser_session`、`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_eval`、`browser_storage`、`browser_console`、`browser_wait_human`、`browser_screenshot`、`browser_close`
- **两种会话模式**:
  - `real` —— `connectOverCDP` 连接 9222 端口上已有的 Chrome(复用登录态:cookie、session、2FA)
  - `isolated` —— `launchPersistentContext` 用独立 profile(有头/无头)
- **自动拉起 Chrome**:9222 端口不通时,server 会自动 spawn 你的 Chrome 启动脚本并等待就绪——无需手动开浏览器。
- **Element Ref 定位**(借鉴 Cursor):`snapshot` 给每个可交互元素分配一个稳定的 `ref`(`e1`、`e2`、…),返回形如 `- [ref=e3] button "Sign in"` 的列表;`click`/`type` 优先用 `ref` 精确定位,也可回退到 `role` + `name`。穿透 open shadow root,把原生标签映射成隐式 ARIA role(`<a>`→`link`、`<select>`→`combobox` 等),用 `checkVisibility()` + 非零尺寸过滤隐藏元素。**默认只返回视口内元素**(`mode=all` 返回全部)——复杂页面大幅省 token。
- **两种传输**:`stdio`(默认,适合 Codex 式 spawn)和 `http`(无状态流式,`--transport http --port 9223`)。

## 环境要求

- Node.js ≥ 18
- 已装 Playwright 兼容的 Chrome/Chromium(`google-chrome-stable` 即可)
- `real` 模式:一个用 `--remote-debugging-port=9222` 和独立 `user-data-dir` 启动的 Chrome(见[用 CDP 启动 Chrome](#用-cdp-启动-chromereal-模式))

## 安装

```bash
git clone https://github.com/q35888/agentic-browser-mcp.git
cd agentic-browser-mcp
npm install
```

## 配置你的 MCP client

### Codex(`~/.codex/config.toml`)

```toml
[mcp_servers.agentic-browser]
type = "stdio"
command = "/usr/bin/node"
args = [ "/path/to/agentic-browser-mcp/index.mjs" ]
```

### 任意 MCP client(stdio)

spawn `node /path/to/agentic-browser-mcp/index.mjs`,走标准 stdio,按 MCP 协议:`initialize` → `tools/list` → `tools/call`。

### HTTP 模式(长驻单实例)

```bash
node index.mjs --transport http --port 9223
# 向 http://127.0.0.1:9223/mcp POST MCP 请求
```

## 用 CDP 启动 Chrome(`real` 模式)

Chrome 150+ 做远程调试需要非默认的 user-data-dir。示例启动脚本:

```bash
#!/usr/bin/env bash
PROFILE="$HOME/.agentic-browser-chrome-profile"
mkdir -p "$PROFILE"
# 从非图形环境 spawn 时,补上图形会话环境变量
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
exec google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  "$@"
```

> 从后台进程 spawn Chrome 时,`--ozone-platform=wayland` 很关键:否则 Chrome 的平台启发式会选 X11,报 `Missing X server / Authorization required` 失败。按你的显示服务器调整(X11 用户:去掉该 flag,确保 `DISPLAY`/`XAUTHORITY` 已设)。

如果你不手动启动 Chrome,server 会尝试自动拉起 `$HOME/.pi/agent/start-agent-chrome.sh`(在 `index.mjs` 里改 `CHROME_STARTER` 指向你的脚本)。

## 工具一览

| 工具 | 说明 |
|---|---|
| `browser_session` | 启动/切换会话(`real`/`isolated`、`headless`、`incognito`)。无参 = 确保默认 `real`。 |
| `browser_navigate` | 打开 URL。 |
| `browser_snapshot` | 列出带 `ref` 编号的可交互元素,如 `- [ref=e3] button "Sign in"`。默认 `mode=viewport`(只视口内,省 token);`mode=all` 返回全部。用 `ref` 做 `click`/`type`。 |
| `browser_click` | 用 `ref` 点击(首选,如 `e3`),或 `role`(+`name`)。`ref` 会校验 `^e\d+$` 并检查恰好命中 1 个(0=失效,>1=重复 → 重新 snapshot)。 |
| `browser_type` | 用 `ref` 输入(首选),或 `role`(+`name`)。校验同 `click`。 |
| `browser_eval` | 在页面执行 JS 表达式(读 DOM/storage/发请求)。 |
| `browser_storage` | 读 `cookies` / `localStorage` / `sessionStorage`。 |
| `browser_console` | 读缓冲的 console 日志(可选 `level` 过滤)。 |
| `browser_wait_human` | 验证码/需人工步骤时——返回一个提示;调用方的 agent 暂停等用户回复。 |
| `browser_screenshot` | 截图存成 PNG。 |
| `browser_close` | 关闭当前会话(`real` 只断开 CDP,绝不杀真实 Chrome)。 |

## Element 定位(ref)

每次 `browser_snapshot` 会注入一段脚本,扫描页面可交互元素(链接、按钮、输入框、`[role]`、`[contenteditable]`、`[tabindex]` 等),并**穿透 open shadow root**。每个存活的元素通过 `data-agent-ref` 属性拿到一个短 `ref` id(`e1`、`e2`、…)。返回文本形如:

```
- [ref=e1] link "Docs"
- [ref=e2] searchbox "Search"
- [ref=e3] button "Sign in"
```

### 可见性与视口过滤

元素必须**同时**通过两项检查才会出现:

1. **可见** —— `el.checkVisibility({ checkOpacity, checkVisibilityCSS, contentVisibilityAuto })`(旧浏览器回退到 `computed visibility !== 'hidden'`)**且**边界矩形非零尺寸。这会过滤 `display:none`、`visibility:hidden`、`opacity:0`、`0×0`、以及被父元素隐藏的元素——旧的 `offsetParent` 检查会漏掉这些(例如 DuckDuckGo 那个 `<input type=radio opacity:0 rect=0×0>` 隐藏控件曾导致 `fill` 失败)。
2. **在视口内**(默认 `mode=viewport`)——`rect` 与视口相交。传 `mode=all` 可包含视口外元素。复杂页面能把快照从 ~150 个降到 ~10 个,省 ~90% token。

### Role 映射

原生标签会被映射成**隐式 ARIA role**,让输出与 Playwright `getByRole()` 在回退路径上对齐:`<a href>`→`link`、`<button>`/`<summary>`→`button`、`<textarea>`/文本 `<input>`→`textbox`、`<input type=search>`→`searchbox`、`checkbox`/`radio`、`<select>`→`combobox`。显式 `role=` 属性优先。

### 使用 ref

```
click   { ref: "e3" }                         # 精确——snapshot 那一刻的元素
click   { role: "button", name: "Sign in" }   # 没有 ref 时的回退
type    { ref: "e2", text: "playwright" }
```

`ref` 会用 `^e\d+$` 校验,并检查 locator **恰好命中 1 个**:0 → "ref 失效,重新 snapshot";>1 → "ref 重复,重新 snapshot"(快照内部错误)。

> **ref 是临时的。** 每次 `snapshot` 都从头重新编号(清除旧的 `data-agent-ref` 属性,包括 shadow root 内的),所以 `ref` 只在下一次 `snapshot` 之前有效。页面变化(导航、动态内容)后,先重新 `snapshot` 再操作。输出按整行边界截断,并附 `…[共 N 项,返回 M 项]` 统计。

## 给 AI Agent 的操作指南

用这套工具的 AI agent,请务必阅读 [`docs/agent-guide.md`](./docs/agent-guide.md)——里面有 ref 工作流、何时用 viewport/all、失败处理等最佳实践。

## 备注

- **`browser_wait_human`**:本 server 无 GUI/TUI。它返回一个文本提示;client agent 应将其呈现给用户并等待回复。
- **会话共享**:多个 MCP client 连同一个 server 时共享同一个 Playwright 会话(即同一个 Chrome)。工具调用串行化以防竞态。
- **资源清理**:在 `stdin` EOF、transport 关闭、或 `SIGINT`/`SIGTERM` 时,server 会释放会话(3s 超时兜底)——`isolated` 浏览器不会成为孤儿。

## 故障排查

- **`ECONNREFUSED 127.0.0.1:9222` / Chrome 没开** —— `real` 模式下,server 用原始 TCP 连接(`node:net`,**不是** `fetch`——`fetch` 会遵守 `http_proxy`/`https_proxy`,把 localhost 探测发到你的 HTTP 代理,从而误报端口不通)探测 9222。不通则自动 spawn `$CHROME_STARTER`(默认 `~/.pi/agent/start-agent-chrome.sh`)并轮询最多 20s。Linux 下用 `bash -c 'nohup … &'`(本环境下 `spawn(…, {detached:true})` 起不来 Chrome);Windows 下直接 spawn `chrome.exe`。自动拉起仍失败,就用手动脚本启动。
- **`fill: Timeout … element is not visible`** —— 你可能点/输入了一个隐藏元素(如 `0×0`/`opacity:0` 的装饰性控件)。重新 `snapshot`,可见性过滤器现在应能排除它。若确实可见的元素仍失败,可能是 ref 失效——重新 snapshot。
- **`ref=eN 未命中`(ref 失效)** —— 上次 `snapshot` 后页面变了(导航、动态内容、元素被移除/重渲染)。重新 `snapshot`,用新 ref。
- **`ref=eN 命中 N 个`(ref 重复)** —— 快照内部错误(ref 本应唯一)。重新 snapshot;若持续出现,提 issue。
- **快照太吵 / 元素太多** —— 你可能用了 `mode=all`。默认是 `mode=viewport`(只视口内)。滚动后重新 snapshot,或保持默认。
- **`browser_close()` 会杀我的真实 Chrome 吗?** —— 不会。在 `connectOverCDP` 下,`browser.close()` 只断开 CDP 连接,真实 Chrome 进程及其标签页都还在(已验证)。可以放心调用。
- **`CSS is not defined`** —— (新版已修复。)Node 侧的工具处理函数不能用 `CSS`/`document` 等浏览器全局对象;只有 `page.evaluate()` 里的代码才跑在浏览器中。

## 许可

MIT
