# AI Agent 操作指南:帮用户配置 agentic-browser-mcp

> 本文档面向 **AI agent**(Codex / Claude / pi / 任意助手)。你的任务是**帮用户把这个 MCP server 安装并配置到他使用的 MCP client 里**,让它能正常驱动浏览器。读完你应能端到端完成一次配置。

## 核心流程

```
摸清环境 → 装依赖 → 写配置 → 配 Chrome(如需 real 模式)→ 验证 → 收尾
```

**铁律:每一步都验证再进入下一步。** 不要把所有配置写完才一起测——出问题很难定位。

---

## 1. 先摸清环境(别假设)

动手前先问清/查清四件事:

| 要搞清的 | 怎么查 | 为什么重要 |
|---|---|---|
| **用户用哪个 MCP client** | 直接问:Codex / Claude Desktop / Cursor / 其他? | 不同 client 配置文件路径和格式不同 |
| **操作系统** | `uname -a`(Linux)/ 看路径风格(`C:\` = Windows) | Chrome 启动方式、配置路径、spawn 方式都不同 |
| **Node.js ≥ 18?** | `node --version` | 硬性依赖,没有要先装 |
| **Chrome 装了没** | Linux: `which google-chrome-stable`;Windows: 找 `chrome.exe` | `real` 模式和 `isolated` 模式都需要 |

```bash
# 一条命令摸清 Linux 环境
node --version; which google-chrome-stable || which google-chrome || echo "Chrome 未装"
```

---

## 2. 安装依赖

```bash
git clone https://github.com/q35888/agentic-browser-mcp.git
cd agentic-browser-mcp
npm install
```

验证安装成功:
```bash
node --check index.mjs && echo "✅ 代码 OK"
ls node_modules/playwright >/dev/null 2>&1 && echo "✅ 依赖 OK"
```

**记下 `index.mjs` 的绝对路径**,配置里要用:
```bash
pwd              # 假设是 /home/user/agentic-browser-mcp
# 则 index.mjs 路径 = /home/user/agentic-browser-mcp/index.mjs
```

---

## 3. 写配置(按 client 分)

### 3.1 Codex(`~/.codex/config.toml`)

```toml
[mcp_servers.agentic-browser]
type = "stdio"
command = "/usr/bin/node"
args = [ "/绝对路径/agentic-browser-mcp/index.mjs" ]
```

> ⚠️ **用 cc-switch 管理 Codex 配置的用户注意**:config.toml 的 `[mcp_servers.*]` 段**真相来源是 cc-switch 的 SQLite db**(`~/.cc-switch/cc-switch.db` 的 `mcp_servers` 表)。直接改 config.toml 会被 cc-switch 切换 provider 时覆盖。正确做法:① 在 cc-switch GUI 里加(最稳);② 或停掉 cc-switch(`pkill -x cc-switch`)后用 python 改 db,再重启 cc-switch。

### 3.2 Claude Desktop

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "node",
      "args": ["/绝对路径/agentic-browser-mcp/index.mjs"]
    }
  }
}
```
改完**完全重启 Claude Desktop**(不是刷新)。

### 3.3 Cursor

`Settings → MCP → Add MCP Server`,或编辑 `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "node",
      "args": ["/绝对路径/agentic-browser-mcp/index.mjs"]
    }
  }
}
```

### 3.4 通用 stdio(任意 MCP client)

只要 client 能 spawn 进程、走 stdin/stdout。本质:
```bash
node /绝对路径/agentic-browser-mcp/index.mjs
```
然后按标准 MCP 协议:`initialize` → `tools/list` → `tools/call`。

### 3.5 HTTP 模式(长驻单实例,多 client 共享)

先启动 server:
```bash
node /绝对路径/agentic-browser-mcp/index.mjs --transport http --port 9223
```
然后 client 向 `http://127.0.0.1:9223/mcp` POST MCP 请求。适合多个 client 共享同一个浏览器会话。

---

## 4. 配置 Chrome(`real` 模式需要)

`real` 模式复用用户**已登录**的 Chrome(登录态、cookie、2FA),需要 Chrome 用 `--remote-debugging-port=9222` + 独立 `user-data-dir` 启动。

### 4.1 写启动脚本

**Linux:**
```bash
#!/usr/bin/env bash
PROFILE="$HOME/.agentic-browser-chrome-profile"
mkdir -p "$PROFILE"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
exec google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  "$@"
```

> `--ozone-platform=wayland` 在 Wayland 上从后台进程拉起 Chrome 时必需,否则报 `Missing X server / Authorization required`。X11 用户去掉该 flag,确保 `DISPLAY`/`XAUTHORITY` 已设。

**Windows:**
```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.agentic-browser-chrome-profile"
```

### 4.3 复用日常浏览器的登录态(重要,Chrome 136+)

**坑点**:Chrome 136+ 出于安全考虑(防 infostealer 盗 cookie),**禁止默认 profile 开 `--remote-debugging-port`**。你直接让日常 Chrome 加这个 flag,端口不会监听——命令行不会报错,但连不上。

所以专用 Chrome 必须用独立 `user-data-dir`,默认带的是空登录态。但这违背了"real 模式"的初衷:用户要的是 agent 能操作自己**已经登录**的那些站。

**解决方案**:用项目自带的 `scripts/sync-profile.sh`,把日常 profile 的认证文件拷贝到专用 profile。

```bash
# 1. 确认专用 Chrome 没在跑(脚本会自动 kill 占 9222 的进程)
# 2. 强烈建议先关闭日常 Chrome(否则 cookie 可能不是最新写盘的)
# 3. 在项目根目录运行:
./scripts/sync-profile.sh
```

脚本做的事:
- 自动 kill 占 9222 端口的 Chrome
- 拷贝 `Cookies` / `Login Data` / `Login Data For Account` / `Web Data` / `Local State`
- 清理 `SingletonLock` 等锁文件
- 备份目标 profile 原文件到 `<专用 profile>/.sync-backup/<时间戳>/`

**为什么 Linux 上能直接解密**:Chrome 在 Linux 用 GNOME keyring 存 cookie 加密 key,key 绑定**用户 session** 而非 profile 路径。同一用户跑的两个 profile 共享同一把 key,所以 cookie 文件直接拷过去就能解密。macOS Keychain 同理。Windows DPAPI 绑定用户,也能用。

**首次配置后**:专用 Chrome 拉起时已带上日常浏览器的所有登录态(Gmail、GitHub、SaaS 后台等)。以后日常 Chrome 新登录了站,**再跑一次 `sync-profile.sh` 同步即可**。

---

### 4.2 不想手动写?用内置自动拉起

**好消息:server 本身会自动拉起 Chrome。** CDP 端口(默认 9222)不通时,spawnStarter 会按优先级尝试:
1. 如果 `AGENT_BROWSER_CHROME_STARTER` 脚本(或默认 `~/.pi/agent/start-agent-chrome.sh`)存在 → 用它(兼容 Pi 环境/自定义脚本)
2. 否则内置直接 spawn chrome —— 跨平台查找 chrome 可执行文件(Linux `/usr/bin/google-chrome-stable`、Windows `Program Files`、macOS `/Applications/Google Chrome.app`),用 `--remote-debugging-port` + `--user-data-dir=$CDP_PROFILE` 启动,**不依赖任何外部脚本,换机即可用**

所以用户即使不手动开 Chrome、也没有 `start-agent-chrome.sh`,server 也能自启。**自定义启动方式**:设环境变量 `AGENT_BROWSER_CHROME_STARTER` 指向自己的脚本。

---

## 5. 验证配置(关键,别跳过)

### 5.1 先单独跑 server,确认能启动
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | \
  timeout 5 node /绝对路径/agentic-browser-mcp/index.mjs 2>&1 | head
```
能看到 `result` 含 `serverInfo` = 启动成功。报错则按报错修(常见:依赖没装、node 版本低)。

### 5.2 验证 tools/list(11 个工具)
```bash
# 接上一条,再发一条 tools/list(同 stdio 会话)
# 或在 client 里确认 agentic-browser 出现在工具列表
```
应看到 `browser_session`、`browser_navigate`、`browser_snapshot` 等 11 个工具。

### 5.3 真实调用一次(端到端)
让 client 调:
```
browser_session { }              # 启 real 会话(自动拉起 Chrome)
browser_navigate { url: "https://example.com" }
browser_snapshot { }             # 应返回 - [ref=e1] ... 列表
```
snapshot 返回元素列表 = 配置完全成功。

### 5.4 如果用 http 模式
```bash
# 启动
node /绝对路径/agentic-browser-mcp/index.mjs --transport http --port 9223 &
# 验证端口
curl -s http://127.0.0.1:9223/mcp -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
```

---

## 6. 常见坑(配置失败先查这些)

| 症状 | 原因 | 解法 |
|---|---|---|
| Chrome 启动了但 9222 连不上 / 端口不监听 | Chrome 136+ 安全限制:默认 profile 下 `--remote-debugging-port` 被静默忽略 | 必须用独立 `--user-data-dir`;若要复用日常登录,跑 `./scripts/sync-profile.sh` |
| client 报 `connection closed` / 连不上 | 配置路径写错、node 找不到 | 用绝对路径;`command` 用 `/usr/bin/node` 全路径;手动跑一遍 server 确认能启 |
| Codex 配置改了不生效 / 切 provider 后没了 | cc-switch 从 db 覆盖 config.toml | 在 cc-switch GUI 加,或停掉 cc-switch 改 db |
| server 报 `ECONNREFUSED 127.0.0.1:9222` | Chrome 没开 | server 会自动拉起;仍失败提示用户手动开;**别用 fetch 探测**(会被 http_proxy 劫持) |
| Chrome 启动报 `Missing X server` | Wayland 下没指定平台 | 启动脚本加 `--ozone-platform=wayland` |
| 9222 探测明明开着却误报不通 | `http_proxy` 环境变量让 fetch 把 localhost 发给代理 | server 用 `node:http` + `agent:false` 探测 `/json/version`,显式不走代理;别换成裸 fetch |
| `CSS is not defined` | Node 端用了浏览器全局 | 只在 `page.evaluate()` 里用 CSS/document |
| 依赖装不上 | 网络问题 | 挂代理:`npm config set proxy http://127.0.0.1:7897` |
| Windows 下 Chrome 起不来 | `detached:true` spawn 在某些环境失效 | 用 `chrome.exe` 直接 spawn |

---

## 7. 收尾检查清单

配置完逐项确认:
- [ ] `node --version` ≥ 18
- [ ] `npm install` 成功,`node_modules/playwright` 存在
- [ ] `index.mjs` 绝对路径已填进配置(不是相对路径)
- [ ] client 里能看到 11 个 browser_* 工具
- [ ] 调 `browser_session` 能启会话(Chrome 自动拉起或已开)
- [ ] 调 `browser_navigate` + `browser_snapshot` 能返回元素列表
- [ ] **`real` 模式用户的登录态保留**(登录了某个站,navigate 过去还是登录态)

全绿 = 配置完成,告诉用户可以用了。

---

## 8. 给用户的一句话说明(配置完发给他)

> 已配置好 agentic-browser-mCP。`real` 模式会复用你登录过的 Chrome(登录态都保留),9222 没开它会自动拉起。下次 client 启动就能用 `browser_snapshot`(看页面元素)+ `browser_click`/`browser_type`(ref 操作)等 11 个浏览器工具。
