# agentic-browser-mcp vs 官方 `@playwright/mcp`

> 同样的 Playwright 引擎，不同的取舍。本文说清楚两边各自适合什么场景，方便你选。

## 一句话差异

官方 `@playwright/mcp` 是 **Playwright 官方维护、工具最全** 的通用方案，每次起新浏览器 context；agentic-browser-mcp 是 **能复用你已登录 Chrome** 的轻量方案，工具更少但更省 token、对中文 LLM 更友好。

底层都是 Playwright，差别在「**连谁的浏览器**」「**给 LLM 看什么**」「**有多少工具**」三件事上。

---

## 核心差异速查

| 维度 | agentic-browser-mcp | `@playwright/mcp` |
|---|---|---|
| **能复用已登录 Chrome** | ✅ `real` 模式连 9222，cookie/session/2FA 全保留 | ❌ 每次新 context，登录态从零开始 |
| **Chrome 自动拉起** | ✅ 9222 不通自动 spawn 启动脚本 | ✅ 自带 isolated context |
| **工具数量** | 11 | 24 |
| **snapshot token 占用** | 低（默认只视口内 + 整行截断）| 中（完整 accessibility tree）|
| **工具描述语言** | 中文优先 | 英文 |
| **浏览器内核** | Chromium only | Chromium / Firefox / WebKit |
| **穿透 Shadow DOM** | ✅ | ✅ |
| **多 tab 管理** | ❌（需用 `browser_eval` 拼 JS）| ✅ `browser_tabs` |
| **高级交互（drag/hover/file_upload/dialog/select）** | ❌ | ✅ |
| **跑任意 Playwright 代码** | ❌（`browser_eval` 只在页面里跑 JS）| ✅ `browser_run_code_unsafe` |
| **运行时依赖** | 3 个（SDK + Playwright + Zod）| Playwright 全家桶 |
| **维护方** | 个人项目 | Microsoft / Playwright 团队 |

---

## agentic-browser-mcp 的优势

### 1. 复用已登录 Chrome（最大差异）

这是官方 `@playwright/mcp` 做不到的核心能力。

`real` 模式通过 `chromium.connectOverCDP("http://127.0.0.1:9222")` 连接你已经在用的专用 Chrome——**你在浏览器里登过什么，agent 就能直接访问什么**：SaaS 后台、付费订阅内容、带 2FA 的账号、企业内网……

官方 `@playwright/mcp` 默认每次 `browser_navigate` 都在 isolated context 里，cookie/storage 都是空的。要登录只能让 agent 自己输用户名密码（很多场景过不了验证码 / SSO），或者写脚本手动 `storageState` 注入——都很笨重。

**实际场景**：让 agent 帮你查 GitHub 上某个私有仓库的 CI 失败原因、抓 Notion 工作区数据、操作公司 OA 系统——agentic-browser-mcp 直接能干，官方的得先折腾登录态。

> ⚠️ **Chrome 136+ 安全限制**：Chrome 136 起，`--remote-debugging-port` 在**默认 user-data-dir 下会被静默忽略**（防 infostealer）。所以专用 Chrome 必须用独立 profile。要让这个独立 profile **带上你日常浏览器的所有登录态**，项目自带 `scripts/sync-profile.sh`——一键把日常 profile 的 `Cookies` / `Login Data` / `Web Data` / `Local State` 同步到专用 profile（Linux 同用户 GNOME keyring 共享加密 key，cookie 可直接解密）。日常 Chrome 登录新站后跑一次 `sync-profile.sh`，下次 agent 拉起专用 Chrome 即带上新登录态。

### 2. Chrome 自动拉起——不劳烦用户

`ensureChromeUp()` 探测 CDP 端口（默认 9222）不通时调 `spawnStarter()`：优先用 `AGENT_BROWSER_CHROME_STARTER` 脚本（兼容 Pi 环境），不存在则**内置直接 spawn chrome**（跨平台查找可执行文件，换机零依赖），轮询最多 20 秒等它起来。

探测方式是 HTTP `GET /json/version`（不是裸 TCP —— 避免 chrome 启动时序竞态：TCP 先通、DevTools HTTP 还没起来）。用 `node:http` + `agent:false` 显式不走 `http_proxy`，避开代理把 localhost 探测劫持的坑。

### 3. 省 token 的 snapshot 设计

默认 `mode=viewport` 只返回**视口内**可交互元素——复杂页面从 ~150 项降到 ~10 项，**省 ~90% token**。要全量就 `mode=all`。

输出按**整行边界**截断（不切断单行），末尾附 `…[共 N 项，已返回前 M 项]` 统计，让 LLM 知道还有多少没返回。

对比官方的 accessibility snapshot——返回完整的 ARIA 树，准确但量大，对 token 敏感的场景（比如长链路 agent 任务）会爆。

### 4. 工具描述中文优先，中文 LLM 受益

11 个工具的 `description` 全部用中文写，参数说明也是中文。对**用中文 prompt 的 LLM**（GLM / Qwen / Kimi / DeepSeek 等）来说，语义匹配更准——LLM 在 tools 列表里找「读 cookies」时，中文描述直接命中。

英文模型（GPT / Claude / Grok）用也没问题，只是收益没那么明显。

### 5. real 模式不杀真实 Chrome

`browser_close` 在 `connectOverCDP` 下只断 CDP 连接，**真实 Chrome 进程和所有标签页都保留**（代码注释明确标注，已验证）。你可以放心让 agent 关 session，不会丢自己手动开的页面。

### 6. 轻量

3 个运行时依赖（MCP SDK + Playwright + Zod），单文件 712 行实现全部 11 个工具。整个项目源码读一遍 10 分钟。审计、二次开发、内嵌进自己的工具链都简单。

---

## 诚实的劣势

### 1. 工具更少

官方 `@playwright/mcp` 有 24 个工具，含一些 agentic-browser-mcp **没有的**：

- `browser_drag`（拖拽）
- `browser_hover`（悬停——触发菜单/tooltip 必需）
- `browser_file_upload`（文件上传 input）
- `browser_handle_dialog`（alert/confirm/prompt 弹窗）
- `browser_select_option`（`<select>` 下拉）
- `browser_tabs`（多 tab 管理）
- `browser_fill_form`（一次填多个表单字段）
- `browser_run_code_unsafe`（直接跑 Playwright 代码，相当于 RCE 能力）

agentic-browser-mcp 缺这些时只能 `browser_eval` 注入 JS 拼——能干，但啰嗦，而且 `eval` 只在页面里跑、不能调 Playwright API。

### 2. 生态和长期维护

- 官方由 Microsoft / Playwright 团队长期维护，跟 Playwright 版本同步更新。
- agentic-browser-mcp 是个人项目，v0.1.0，更新节奏取决于作者。生产场景用要自己 fork 备份。

### 3. 浏览器只支持 Chromium

官方 `@playwright/mcp` 通过 `--browser` 切 Firefox / WebKit 做跨浏览器测试。agentic-browser-mcp 写死 Chromium（real 模式必须 Chrome，isolated 也是 `channel: "chrome"`）。要做 Safari/Firefox 兼容性测试的不行。

### 4. snapshot 是自实现的，不是规范 accessibility tree

官方 `browser_snapshot` 用 Playwright 的 accessibility tree（基于 ARIA 标准），结构和读屏软件一致。

agentic-browser-mcp 是自己写 JS 扫 DOM + 26 个选择器 + 隐式 role 映射——实战足够（穿透 shadow root、过滤隐藏元素都做了），但不是规范 ARIA 树，某些复杂组件（如 ARIA grid、composite widgets）的层级表达不如官方准确。

### 5. real 模式需要预先配 Chrome 启动方式 + sync 登录态

虽然有自动拉起兜底，但首次配置要让 Chrome 用 `--remote-debugging-port=9222` + 独立 `user-data-dir` 启动，Wayland 还得加 `--ozone-platform=wayland`——对新手是个门槛。并且因为 Chrome 136+ 的安全限制（见上文），独立 profile 默认是空的，要复用日常登录还得跑一次 `scripts/sync-profile.sh`。官方 isolated 模式零配置，但代价是每次都从零开始登录。

---

## 怎么选

**选 agentic-browser-mcp，如果：**

- 要操作**需要登录**的网站（私仓、SaaS 后台、OA、订阅内容）
- 主力是中文 LLM（GLM / Qwen / Kimi / DeepSeek 等）
- token 敏感（长链路 agent 任务、context 紧张）
- 想让多个 MCP client（Grok + Codex + Cursor）共享同一个登录态浏览器
- 喜欢小而精的代码，能自己改

**选官方 `@playwright/mcp`，如果：**

- 操作公开网站，不需要登录态
- 要用 drag / hover / file_upload / dialog / 多 tab / 下拉 这些高级交互
- 要做跨浏览器测试（Firefox / WebKit）
- 团队偏好有官方背书的成熟生态
- 需要 `browser_run_code_unsafe` 这种"任意 Playwright 代码"的灵活度

**两个一起用也行**——MCP 协议支持同时连多个 server。isolated 任务交给官方的，real-mode 登录态任务交给 agentic-browser-mcp，互补。

---

## 实战对照：同一个任务两边怎么写

任务：**登录已配置 2FA 的 GitHub，读 notifications 列表第一条标题**。

### 官方 `@playwright/mcp`（做不到登录态复用）

```
browser_navigate { url: "https://github.com/login" }
browser_snapshot          # → 看到登录表单
browser_type { target: "用户名框", text: "你的用户名" }
browser_type { target: "密码框", text: "你的密码" }
browser_click  { target: "Sign in" }
# 2FA 页面来了——卡住。要么手动处理，要么放弃。
```

### agentic-browser-mcp（real 模式，已登录）

```
browser_navigate { url: "https://github.com/notifications" }
browser_snapshot          # → 直接看到通知列表,因为 cookie 还在
browser_eval   { code: "document.querySelector('.notifications-list item')?.innerText" }
```

两步搞定，不用碰登录表单，不过 2FA。这是 real 模式真正的价值。
