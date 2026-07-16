# AI Agent 操作指南:agentic-browser-mcp

> 本文档面向**调用这套浏览器工具的 AI agent**(Codex / Claude / pi / 任意 MCP client)。读完你应能高效、可靠地完成浏览器自动化任务。

## 核心工作流(最重要)

```
navigate → snapshot → (找目标元素的 ref) → click/type → snapshot(确认结果) → ...
```

**铁律:操作前先 snapshot,操作后确认。** 不要凭记忆或猜测操作页面元素。

---

## 1. 工具速查

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `browser_session` | 切换会话 | `profile`: `real`(默认,用你登录态)/ `isolated`(干净 profile) |
| `browser_navigate` | 打开 URL | `url` |
| `browser_snapshot` | 拿元素列表 + ref | `mode`: `viewport`(默认)/ `all` |
| `browser_click` | 点击 | `ref`(首选)或 `role`+`name` |
| `browser_type` | 输入 | `ref` 或 `role`+`name` + `text` |
| `browser_eval` | 跑 JS 读页面状态 | `code`(表达式,非箭头函数) |
| `browser_storage` | 读 cookie/storage | `type`: `cookies`/`localStorage`/`sessionStorage` |
| `browser_console` | 读 console 日志 | `level`(可选) |
| `browser_wait_human` | 验证码等需人工时 | `reason` |
| `browser_screenshot` | 截图存盘(给自己/人看) | `fullPage` |
| `browser_close` | 关会话 | — |

---

## 2. ref 定位:首选方式

`snapshot` 返回形如:
```
- [ref=e1] link "Docs"
- [ref=e2] searchbox "Search"
- [ref=e3] button "Sign in"
```

然后:
```
type  { ref: "e2", text: "playwright" }
click { ref: "e3" }
```

**为什么用 ref:**
- 精确:ref 是 snapshot 那一刻绑定到具体 DOM 元素的(`data-agent-ref` 属性),不会误中同名元素。
- 自带校验:ref 会用 `^e\d+$` 校验,并检查**恰好命中 1 个**。命中 0 个 → 页面变了,重新 snapshot;命中多个 → 快照内部错误,重新 snapshot。

**ref 的生命周期(必须记住):**
- ref **只在下一次 snapshot 之前有效**。每次 snapshot 会清除所有旧 ref 并重新编号。
- **页面一旦变化(导航、点击触发的动态加载、AJAX 更新),立刻重新 snapshot**,不要复用旧 ref。
- 跨 snapshot 用旧 ref → 你会点错元素或报"ref 失效"。

---

## 3. role + name 回退:没有 ref 时

当你没 snapshot、或不想 snapshot 时,可用:
```
click { role: "button", name: "Sign in" }
type  { role: "textbox", name: "Email", text: "a@b.com" }
```

**role 用隐式 ARIA role,不是原生标签名:**
| 看到的元素 | role |
|---|---|
| `<a href>` | `link` |
| `<button>` / `<summary>` | `button` |
| `<input type=text>` / `<textarea>` | `textbox` |
| `<input type=search>` | `searchbox` |
| `<input type=checkbox>` | `checkbox` |
| `<input type=radio>` | `radio` |
| `<select>` | `combobox` |

⚠️ **role+name 是模糊匹配**(name 子串),同名多个元素时可能命中第一个非预期元素。**优先用 ref**;role+name 只在确实没有 ref 时用。

---

## 4. mode:viewport vs all

- **`mode=viewport`(默认)**:只返回当前视口内可见的元素。复杂页面能从 ~150 个降到 ~10 个,**省 ~90% token**、降低误选噪声。**默认就用这个,不要无脑 all。**
- **`mode=all`**:返回页面全部可交互元素(含需滚动才能看到的)。当目标元素在视口外、或你要通览全页时用。

**滚动到目标后再 snapshot** 是常见手法:目标进了视口,viewport 模式就能抓到它。

---

## 5. 判断元素是否"可操作"

`snapshot` 已经过滤掉这些**不可操作**的元素,所以**列表里出现的元素都能点/能输入**:
- `display:none` / `visibility:hidden` / `opacity:0` / `0×0` 尺寸
- 被父元素隐藏的
- `aria-hidden="true"`

如果你在 snapshot 里**没看到**你以为该有的元素,可能它当时隐藏着(如折叠菜单、未展开的下拉)。先点开触发它的元素,再 snapshot。

---

## 6. 典型任务模板

### 填表 + 提交
```
1. navigate { url: "https://example.com/login" }
2. snapshot { }                          # 默认 viewport
3. type  { ref: "<邮箱框 ref>", text: "user@example.com" }
4. type  { ref: "<密码框 ref>", text: "..." }
5. click { ref: "<提交按钮 ref>" }
6. snapshot { }                          # 确认登录后页面 / 报错
```

### 搜索
```
1. navigate { url: "https://duckduckgo.com" }
2. snapshot { }
3. type  { ref: "<搜索框 ref>", text: "query" }
4. click { ref: "<搜索按钮 ref>" }       # 或按回车:eval { code: "...press Enter" }
5. 等结果加载后 snapshot
```

### 需要滚动找元素
```
1. snapshot { }                          # 先看视口内有没有
2. 没有 → eval { code: "window.scrollBy(0, 800)" } 滚动
3. snapshot { }                          # 再看
```

### 处理验证码
```
1. 操作到验证码步骤
2. wait_human { reason: "请完成验证码" }  # 暂停,等用户在浏览器里搞定
3. 用户回复后继续 snapshot
```

---

## 7. 失败处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `ref=eN 未命中` | 页面变了,ref 失效 | 重新 snapshot,用新 ref |
| `ref=eN 命中 N 个` | 快照内部错误(本不该发生) | 重新 snapshot;持续则提 issue |
| `fill: Timeout … not visible` | 元素隐藏/被遮挡 | 重新 snapshot 确认它在列表里;可能要先滚动/展开 |
| `ECONNREFUSED 9222` | Chrome 没开 | server 会自动拉起;仍失败则提示用户手动开 Chrome |
| 点击后没反应 | 异步加载/需要等待 | `eval` 轮询等待,或 sleep 后 snapshot |

---

## 8. 辅助利器:`browser_eval`

`eval` 跑在**浏览器里**,能用 `document`/`CSS`/`fetch` 等。适合:
- 读页面状态:`eval { code: "document.title" }`、`location.href`
- 滚动:`window.scrollBy(0, 500)`
- 等待条件:`JSON.stringify({ready: document.querySelector('#result') !== null})`
- 读数据:`JSON.stringify([...document.querySelectorAll('.item')].map(e=>e.textContent))`

⚠️ eval 里**别做破坏性操作**(删数据、提交表单),除非任务明确要求。优先用 click/type 这种可观测的操作。

---

## 9. 禁忌(别这么做)

- ❌ **跨 snapshot 用旧 ref** —— 会点错或失效。页面变了立刻重新 snapshot。
- ❌ **无脑 `mode=all`** —— 浪费 token、增加误选。默认 viewport,需要时才 all。
- ❌ **不 snapshot 就瞎点** —— 容易点错元素。先看清楚再操作。
- ❌ **操作后不确认** —— 点完/输完要 snapshot 或 eval 确认结果,别假设成功。
- ❌ **一次做太多步不检查** —— 复杂任务分阶段,每阶段 snapshot 确认。
- ❌ **在 eval 里硬编码 CSS selector 做主要操作** —— 易碎。主要操作用 ref。

---

## 10. 检查清单(每次任务前)

- [ ] 目标元素在最近的 snapshot 里吗?不在就先操作让它出现(展开/滚动),再 snapshot。
- [ ] 我用的 ref 是当前这次 snapshot 的吗?(不是上次的)
- [ ] 操作完我会 snapshot/eval 确认吗?
- [ ] 这个页面需要登录态吗?需要则用 `real` 模式(已登录的 Chrome),别用 `isolated`。

按这套来,你就能稳、准、省地完成绝大多数浏览器任务。
