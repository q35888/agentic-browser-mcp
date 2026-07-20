#!/usr/bin/env node
/**
 * agentic-browser-mcp — Pi 浏览器能力的独立 MCP server。
 *
 * 逻辑与 pi 扩展的 browser-tool.ts 对齐(单一行为基准,原路径 ~/.pi/agent/extensions/),
 * 但脱离 pi 进程,以 MCP server 形式供 Codex / pi / 任意 MCP client 连接。
 *
 * 后端:Playwright 1.61
 *   - real:     connectOverCDP("http://127.0.0.1:9222"),复用专用 Chrome(登录态)
 *   - isolated: launchPersistentContext(独立 profile,channel=chrome)
 *
 * 传输:
 *   - stdio(默认,Codex 标准 spawn 方式)
 *   - http  (--transport http --port 9223,stateless streamable,常驻单实例)
 *
 * 与 pi 扩展的差异:
 *   - wait_human:无 pi TUI(ctx.ui.input/notify),退化为纯文本往返 ——
 *     返回提示文本,客户端模型自行暂停等待用户。
 *   - 无 live tick / renderCall / spinner(MCP 协议不带 UI 渲染)。
 *
 * API 注记:MCP SDK registerTool(name, config, cb) 为三参数,
 *   zod schema 必须放进 config.inputSchema。
 *   http 模式按官方 stateless 模式:每个请求 new McpServer + new transport,
 *   res.on('close') 时清理;底层 Playwright session 跨请求共享(模块级 current)。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { z } from "zod";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as http from "node:http";

// ===== 路径配置: 环境变量优先,默认值兜底(向后兼容 Pi 环境) =====
// 覆盖示例: AGENT_BROWSER_DIR=/data/my-agent node index.mjs
// 细分覆盖(可选): AGENT_BROWSER_CHROME_STARTER / AGENT_BROWSER_CDP_PROFILE
//                  AGENT_BROWSER_ISOLATED_PROFILE / AGENT_BROWSER_LOG_FILE
const AGENT_DIR = process.env.AGENT_BROWSER_DIR ?? join(os.homedir(), ".pi", "agent");
const ISOLATED_PROFILE = process.env.AGENT_BROWSER_ISOLATED_PROFILE ?? join(AGENT_DIR, "bw-mcp-profile");
const CDP_ENDPOINT = "http://127.0.0.1:9222";
const CHROME_STARTER = process.env.AGENT_BROWSER_CHROME_STARTER ?? join(AGENT_DIR, "start-agent-chrome.sh");

// Windows: 自动查找系统 Chrome，CDP 模式专用 profile
const IS_WIN = process.platform === "win32";
const CDP_PROFILE = process.env.AGENT_BROWSER_CDP_PROFILE ?? join(AGENT_DIR, "chrome-cdp-profile");
// Chrome 启动日志路径
const CHROME_LOG_FILE = process.env.AGENT_BROWSER_LOG_FILE ?? join(os.tmpdir(), "agentic-browser-mcp-chrome.log");
const CHROME_CANDIDATES_WIN = [
  join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const SNAPSHOT_MAX_CHARS = 12000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const CHROME_BOOT_TIMEOUT_MS = 20000; // 自动拉起 Chrome 的最长等待
const DISPOSE_TIMEOUT_MS = 5000; // safeDispose 运行时路径超时兜底

// ===== 会话管理(与 browser-tool.ts 同构) =====
// 模块级单例:跨 MCP 请求/transport 共享同一个 Playwright 会话(=同一个 Chrome)。
// 用串行锁保护,防止 http 并发请求时 ensureSession/dispose 竞态。

let current = null;
let chain = Promise.resolve();
// 上次告知 AI 的标签页数(检测新增 tab 并提示,防 real 模式 tab 无限堆积)
let lastTabCount = 0;
function serialize(fn) {
  const run = chain.then(fn, fn); // 无论上一次成败都继续
  chain = run.catch(() => {});
  return run;
}

// ===== 自动拉起专用 Chrome =====
// real 模式需要 9222 在听;AI 不该要求用户手动开 Chrome。
// 探测 9222,不通就 detached spawn start-agent-chrome.sh,轮询等待它起来。

// 探测 9222 的 DevTools HTTP 服务是否就绪。
// 必须 HTTP GET /json/version 拿到 200,而不是 TCP 连通——chrome 启动时序是
// 先开 TCP → 再起 DevTools HTTP → 再能响应 /json/version,只验证 TCP 会造成
// 时序竞态(TCP 通但 connectOverCDP 立即抛错)。
// 用 node:http + agent:false 显式不走 http_proxy 环境变量。
function chromeUp() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: 9222, path: "/json/version", agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function spawnStarter() {
  // Windows: 直接 spawn chrome.exe（无 bash/nohup）
  if (IS_WIN) {
    try {
      const exe = CHROME_CANDIDATES_WIN.find((p) => existsSync(p));
      if (!exe) return false;
      const child = spawn(
        exe,
        ["--remote-debugging-port=9222", `--user-data-dir=${CDP_PROFILE}`, "--no-first-run", "--no-default-browser-check"],
        { stdio: "ignore", detached: true },
      );
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  // 用 nohup + shell 后台(detached:true 在本环境下 Chrome 起不来)。
  // bash -c "nohup ... &" 让 Chrome 脱离 node 进程独立长驻。
  try {
    const child = spawn(
      "bash",
      ["-c", `nohup ${JSON.stringify(CHROME_STARTER)} > ${JSON.stringify(CHROME_LOG_FILE)} 2>&1 &`],
      { stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureChromeUp() {
  if (await chromeUp()) return true;
  spawnStarter();
  const deadline = Date.now() + CHROME_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await chromeUp()) return true;
  }
  return false;
}

// 绑当前 page + 监听后续新 tab(opened via target="_blank" / window.open() / 手动)
// 都写入同一个 consoleBuffer,避免新 tab 的日志丢失。
function attachConsoleListener(s) {
  s.consoleBuffer = [];
  const push = (type, text) => {
    try {
      s.consoleBuffer.push({ type, text, ts: Date.now() });
      if (s.consoleBuffer.length > 500) s.consoleBuffer.shift();
    } catch {
      /* never crash */
    }
  };
  const bindPage = (page) => {
    try {
      page.on("console", (m) => push(m.type(), m.text()));
      page.on("pageerror", (e) => push("error", String(e)));
    } catch {
      /* ignore */
    }
  };
  try {
    bindPage(s.page);
    // 后续打开的 tab 也绑,不漏 console
    s.context.on("page", bindPage);
  } catch {
    /* ignore */
  }
}

// 刷新"当前活动 page":s.page 原本指向 session 建立时的 tab,但用户/AI 后续
// 可能打开/切换 tab。这里把 s.page 切到 context 里最后活动的 page。
// 当 s.page 已关闭或不再是最后一个 page 时自动切换。
// 各工具调用前先 refreshActivePage(s) 一次,保证操作的是用户当前看到的页面。
function refreshActivePage(s) {
  try {
    const pages = s.context.pages();
    if (pages.length === 0) return s.page;
    const last = pages[pages.length - 1];
    if (!s.page || s.page.isClosed?.() || s.page !== last) {
      s.page = last;
    }
    return s.page;
  } catch {
    return s.page;
  }
}

// 同步当前 tab 数到 lastTabCount(建/切会话时调,建立基准避免误报)
function syncTabCount() {
  try { lastTabCount = current?.context?.pages?.()?.length ?? 0; } catch { lastTabCount = 0; }
}

// 工具返回前调:tab 数比上次多则返回追加提示串,否则同步计数后返回空串
function tabHint() {
  try {
    const n = current?.context?.pages?.()?.length ?? 0;
    if (n > lastTabCount) {
      const added = n - lastTabCount;
      lastTabCount = n;
      const tip = n >= 6 ? "（标签页偏多,可用 browser_eval 执行 close() 关闭多余的）" : "";
      return `\n\n📌 新增 ${added} 个标签页,当前共打开 ${n} 个${tip}。`;
    }
    lastTabCount = n; // 关 tab 也同步,避免下次误报
    return "";
  } catch { return ""; }
}

function sameProfile(s, profile, incognito) {
  if (s.type !== profile) return false;
  return !incognito;
}

async function safeDispose(s) {
  try {
    // 运行时路径加超时兜底,防 chrome 崩了 Playwright browser.close() 挂住
    // 整个 serialize chain,导致 MCP server 假死。
    // 进程退出路径在 shutdown() 里已有 Promise.race(timeout=3000),这里补运行时。
    await Promise.race([
      s.dispose(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("dispose timeout")), DISPOSE_TIMEOUT_MS)),
    ]);
  } catch {
    /* ignore */
  }
}

function isAlive(s) {
  try {
    if (s.type === "real") return s.browser?.isConnected?.() === true;
    return !s.page?.isClosed?.();
  } catch {
    return false;
  }
}

async function ensureSession(opts = {}) {
  // 在串行锁内执行,防止并发竞态
  return serialize(async () => {
    const profile = opts.profile ?? "real";
    if (current && !isAlive(current)) {
      await safeDispose(current);
      current = null;
    }
    if (current && !opts.force && sameProfile(current, profile, opts.incognito)) {
      return current;
    }
    if (current) {
      await safeDispose(current);
      current = null;
    }

    if (profile === "real") {
      // 自动拉起专用 Chrome(AI 不该要求用户手动开)。
      // ensureChromeUp 探测 9222,不通就 spawn start-agent-chrome.sh 并轮询等待。
      const up = await ensureChromeUp();
      if (!up) {
        throw new Error(
          `专用 Chrome(9222)未启动且自动拉起失败。请手动执行 ${CHROME_STARTER}`,
        );
      }
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      const s = {
        type: "real",
        browser,
        context,
        page,
        consoleBuffer: [],
        dispose: async () => {
          try {
            await browser.close();
          } catch {
            /* connectOverCDP 的 close 只断开 CDP 连接,不关真实 Chrome */
          }
        },
      };
      attachConsoleListener(s);
      current = s;
      syncTabCount(); // 新建/切换 real 会话时同步 tab 计数基准
      return s;
    }

    // isolated
    mkdirSync(ISOLATED_PROFILE, { recursive: true });
    const headless = opts.headless ?? false;
    const context = await chromium.launchPersistentContext(ISOLATED_PROFILE, {
      headless,
      channel: "chrome",
      args: opts.incognito ? ["--incognito"] : [],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const s = {
      type: "isolated",
      browser: context,
      context,
      page,
      consoleBuffer: [],
      dispose: async () => {
        try {
          await context.close();
        } catch {
          /* ignore */
        }
      },
    };
    attachConsoleListener(s);
    current = s;
    syncTabCount(); // 新建/切换 isolated 会话时同步 tab 计数基准
    return s;
  });
}

function tryUrl(page) {
  try {
    return page.url();
  } catch {
    return "";
  }
}
async function tryTitle(page) {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

function toText(obj) {
  if (obj === undefined) return "(undefined)";
  if (obj === null) return "(null)";
  try {
    if (typeof obj === "string") return obj;
    const s = JSON.stringify(obj);
    return s === undefined ? String(obj) : s;
  } catch {
    return String(obj);
  }
}

function locateByRole(page, role, name) {
  const loc = page.getByRole(role, name ? { name, exact: false } : undefined);
  return loc.first();
}

// ===== 工具工厂:http 模式每个请求 new 一个 server,工具定义集中在此 =====

function createServer() {
  const server = new McpServer({ name: "agentic-browser-mcp", version: "0.1.0" });

  // content helpers —— 错误用 isError:true,让 MCP client(Codex)正确识别失败。
  // err(prefix, e, hint?) 输出格式: "<prefix>: <msg>\n→ <hint>"
  // hint 是给 AI 的下一步建议(可执行动作),让 AI 能从错误中恢复而不是卡住。
  const ok = (t) => ({ content: [{ type: "text", text: t + tabHint() }] });
  const err = (prefix, e, hint) => {
    const msg = e?.message ?? String(e);
    const text = hint ? `${prefix}: ${msg}\n→ ${hint}` : `${prefix}: ${msg}`;
    return { content: [{ type: "text", text }], isError: true };
  };

  // 1. session
  server.registerTool("browser_session", {
    description:
      "切换/启动浏览器会话。profile: real(连专用 profile Chrome,已登录态) | isolated(独立 profile);headless 仅 isolated 生效;incognito 临时无痕。不传参数=确保默认 real 会话。",
    inputSchema: {
      profile: z.enum(["real", "isolated"]).optional(),
      headless: z.boolean().optional(),
      incognito: z.boolean().optional(),
    },
  }, async (params) => {
    try {
      const s = await ensureSession({
        profile: params.profile,
        headless: params.headless,
        incognito: params.incognito,
        force: params.profile !== undefined,
      });
      return ok(toText({ ok: true, type: s.type, url: tryUrl(s.page), title: await tryTitle(s.page) }));
    } catch (e) {
      return err(
        "浏览器会话失败",
        e,
        `检查步骤: 1) curl http://127.0.0.1:9222/json/version 看是否返回 200; 2) 不通则手动执行 ${CHROME_STARTER}; 3) 若需特定登录态,检查 ${CHROME_STARTER} 脚本里的 --user-data-dir 指向哪个 profile,换成带登录态的; 4) 判断 profile 是否带某站登录: strings <profile>/Default/Cookies | grep -i <domain>; 5) Chrome 起来后重试 browser_session`,
      );
    }
  });

  // 2. navigate
  server.registerTool("browser_navigate", {
    description: "打开 URL。可顺便切会话(未指定 profile 则用当前/默认 real)。",
    inputSchema: {
      url: z.string().describe("要打开的 URL"),
      profile: z.enum(["real", "isolated"]).optional(),
      headless: z.boolean().optional(),
    },
  }, async (params) => {
    try {
      const s = params.profile
        ? await ensureSession({
            profile: params.profile,
            headless: params.headless,
            // 只有 profile 与当前会话不同才真的 force 切换,
            // 避免传默认值 "real" 也触发无谓的断开+重连 CDP。
            force: current ? !sameProfile(current, params.profile, false) : true,
          })
        : await ensureSession();
      refreshActivePage(s);
      await s.page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return ok(toText({ ok: true, url: tryUrl(s.page), title: await tryTitle(s.page) }));
    } catch (e) {
      return err(
        "导航失败",
        e,
        "常见原因: 1) URL 格式错误(应带 http:// 或 https://); 2) Chrome 未启动(先调 browser_session); 3) 目标站点需要登录态但当前 profile 没登录(切到带登录态的 profile,或先 browser_navigate 到登录页手动登录); 4) 网络问题(检查 --proxy-server 是否可达); 排查: 用 browser_eval 执行 location.href 看当前页,或 browser_console 看 error 级日志",
      );
    }
  });

 // 3. snapshot
 server.registerTool("browser_snapshot", {
   description: "返回页面可交互元素快照(带 ref 编号)。默认只返回视口内可操作元素;mode=all 返回全部。据此调 click/type 时提供 ref 优先定位,也可 role+name fallback。",
   inputSchema: {
     mode: z.enum(["viewport", "all"]).optional().describe("viewport=只返回当前视口内可交互元素(默认,省 token);all=返回全部(含视口外,需滚动才能操作)"),
   },
 }, async (params) => {
   try {
     const s = await ensureSession();
     refreshActivePage(s);
     const mode = params?.mode ?? "viewport";
     // 注入 JS：扫描可交互元素 + 分配 data-agent-ref（借鉴 Cursor Element Ref 系统）
     const t = await s.page.evaluate(({ maxChars, mode }) => {
       const sel = [
         'input','textarea','select','button','a[href]',
         '[role="button"]','[role="link"]','[role="textbox"]',
         '[role="checkbox"]','[role="radio"]','[role="combobox"]',
         '[role="listbox"]','[role="menuitem"]','[role="menuitemcheckbox"]',
         '[role="menuitemradio"]','[role="option"]','[role="slider"]',
         '[role="spinbutton"]','[role="switch"]','[role="tab"]',
         '[role="treeitem"]','[role="searchbox"]',
         '[contenteditable="true"]','summary',
         '[tabindex]:not([tabindex="-1"])',
       ].join(',');
       // 穿透 open shadow root
       function deepQuery(root, s) {
         const out = [...root.querySelectorAll(s)];
         for (const el of root.querySelectorAll('*')) {
           if (el.shadowRoot) out.push(...deepQuery(el.shadowRoot, s));
         }
         return out;
       }
       // 隐式 ARIA role 映射（让输出的 role 与 Playwright getByRole 的 fallback 一致）
       function implicitRole(el) {
         const r = el.getAttribute('role');
         if (r) return r;
         const t = el.tagName.toLowerCase();
         if (t === 'a' && el.hasAttribute('href')) return 'link';
         if (t === 'button' || t === 'summary') return 'button';
         if (t === 'textarea') return 'textbox';
         if (t === 'input') {
           const ty = (el.getAttribute('type') || 'text').toLowerCase();
           return ({checkbox:'checkbox', radio:'radio', search:'searchbox'})[ty] || 'textbox';
         }
         if (t === 'select') return 'combobox';
         return t;
       }
       // 清理旧 ref（穿透 shadow root，避免旧 ref 残留与新编号冲突）
       deepQuery(document, '[data-agent-ref]').forEach(el => el.removeAttribute('data-agent-ref'));
       // 可见性 + 视口过滤
       const els = deepQuery(document, sel).filter(el => {
         if (el.getAttribute('aria-hidden') === 'true') return false;
         const cs = getComputedStyle(el);
         const rect = el.getBoundingClientRect();
         const visible =
           (el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) ?? cs.visibility !== 'hidden')
           && rect.width > 0 && rect.height > 0;
         if (!visible) return false;
         if (mode === 'viewport') {
           return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
         }
         return true;
       });
       const lines = els.map((el, i) => {
         const ref = 'e' + (i + 1);
         el.setAttribute('data-agent-ref', ref);
         const role = implicitRole(el);
         const name = (el.getAttribute('aria-label') ||
           el.getAttribute('aria-labelledby') ||
           el.textContent?.trim()?.slice(0, 80) ||
           el.placeholder || el.title || '').slice(0, 80);
         return `- [ref=${ref}] ${role}${name ? ` "${name}"` : ''}`;
       });
       // 整行截断（不切掅单行）+ 统计
       let text = '', shown = 0;
       for (const ln of lines) {
         if (text.length + ln.length + 1 > maxChars) break;
         text += (text ? '\n' : '') + ln;
         shown++;
       }
       const total = lines.length;
       if (shown < total) text += `\n…[共 ${total} 项，已返回前 ${shown} 项；mode=all 或滚动后重 snapshot 看更多]`;
       return text || '(无可交互元素)';
     }, { maxChars: SNAPSHOT_MAX_CHARS, mode });
     return ok(t);
   } catch (e) {
     return err(
       "snapshot 失败",
       e,
       "常见原因: 1) Chrome 未启动(先调 browser_session); 2) 页面还没加载完(等几秒或先 browser_navigate 到目标 URL); 3) 页面是 about:blank 或 chrome:// 内部页(这些页面 DOM 可交互元素少,属正常); 排查: 用 browser_eval 执行 document.readyState 看加载状态",
     );
   }
 });

 // 4. click
 server.registerTool("browser_click", {
   description: "点击页面元素。优先用 snapshot 返回的 ref 定位(如 e3),也可用 role+name fallback。",
   inputSchema: {
     ref: z.string().optional().describe("snapshot 返回的元素 ref(如 e3),优先使用"),
     role: z.string().optional().describe("元素 role(ref 未提供时使用,见 snapshot 输出)"),
     name: z.string().optional().describe("元素的可访问名称(accessible name)"),
   },
 }, async (params) => {
   if (!params.ref && !params.role) return err(
     "参数缺失",
     new Error("必须提供 ref 或 role"),
     `正确用法: 先 browser_snapshot 拿到元素列表,然后用 ref 精确定位(如 click({ref: 'e3'})),或用 role+name 回退(如 click({role: 'button', name: 'Sign in'}))`,
   );
   if (params.ref && !/^e\d+$/.test(params.ref)) return err(
     "ref 非法",
     new Error(`ref 必须形如 e3,收到 ${params.ref}`),
     "ref 格式: e + 数字(如 e1, e2, e3),来自最近一次 browser_snapshot 的输出。不要自己编造 ref,也不要用 CSS 选择器或 xpath",
   );
   try {
     const s = await ensureSession();
     refreshActivePage(s);
     let loc;
     if (params.ref) {
       const sel = `[data-agent-ref="${params.ref}"]`;
       const cnt = await s.page.locator(sel).count();
       if (cnt === 0) return err(
         "ref 失效",
         new Error(`ref=${params.ref} 未命中`),
         "原因: 上次 snapshot 后页面变了(导航/动态渲染/元素被移除)。恢复: 重新调 browser_snapshot 获取新 ref 列表,然后用新 ref 重试 click",
       );
       if (cnt > 1) return err(
         "ref 重复",
         new Error(`ref=${params.ref} 命中 ${cnt} 个(快照内部错误)`),
         "这不应发生,可能是页面被多次渲染。恢复: 重新调 browser_snapshot(ref 会重新分配),若持续出现请提 issue",
       );
       loc = s.page.locator(sel).first();
     } else {
       loc = locateByRole(s.page, params.role || "", params.name);
     }
     await loc.click({ timeout: 10000 });
     return ok(`已点击 ${params.ref ? `ref=${params.ref}` : `${params.role}${params.name ? ` "${params.name}"` : ''}`}`);
   } catch (e) {
     return err(
       "点击失败",
       e,
       "常见原因: 1) 元素被遮挡(用 browser_eval 滚动到元素: el.scrollIntoView()); 2) 元素在 iframe 里(snapshot 默认不穿透 closed shadow root,改用 browser_eval 直接操作); 3) 元素需要先 hover(用 browser_eval 触发 mouseenter); 4) 是 SPA 动态加载的元素(等加载完再 snapshot)",
     );
   }
 });

 // 5. type
 server.registerTool("browser_type", {
   description: "在输入框输入文本。优先用 snapshot 返回的 ref 定位(如 e3),也可用 role+name fallback。",
   inputSchema: {
     ref: z.string().optional().describe("snapshot 返回的元素 ref(如 e3),优先使用"),
     role: z.string().optional().describe("元素 role(ref 未提供时使用,通常 textbox/searchbox/combobox)"),
     name: z.string().optional().describe("输入框的可访问名称"),
     text: z.string().describe("要输入的文本"),
   },
 }, async (params) => {
   if (!params.ref && !params.role) return err(
     "参数缺失",
     new Error("必须提供 ref 或 role"),
     `正确用法: 先 browser_snapshot 拿到输入框的 ref(通常是 textbox/searchbox/combobox role),然后用 type({ref: 'e2', text: '要输入的内容'})`,
   );
   if (params.ref && !/^e\d+$/.test(params.ref)) return err(
     "ref 非法",
     new Error(`ref 必须形如 e3,收到 ${params.ref}`),
     "ref 格式: e + 数字(如 e1, e2, e3),来自最近一次 browser_snapshot 的输出",
   );
   try {
     const s = await ensureSession();
     refreshActivePage(s);
     let loc;
     if (params.ref) {
       const sel = `[data-agent-ref="${params.ref}"]`;
       const cnt = await s.page.locator(sel).count();
       if (cnt === 0) return err(
         "ref 失效",
         new Error(`ref=${params.ref} 未命中`),
         "原因: 上次 snapshot 后页面变了。恢复: 重新调 browser_snapshot 获取新 ref,然后用新 ref 重试 type",
       );
       if (cnt > 1) return err(
         "ref 重复",
         new Error(`ref=${params.ref} 命中 ${cnt} 个(快照内部错误)`),
         "这不应发生。恢复: 重新调 browser_snapshot,若持续出现请提 issue",
       );
       loc = s.page.locator(sel).first();
     } else {
       loc = locateByRole(s.page, params.role || "", params.name);
     }
     await loc.fill(params.text, { timeout: 10000 });
     return ok(`已在 ${params.ref ? `ref=${params.ref}` : `${params.role}${params.name ? ` "${params.name}"` : ''}`} 输入 ${JSON.stringify(params.text)}`);
   } catch (e) {
     return err(
       "输入失败",
       e,
       "常见原因: 1) 元素不是 input/textarea/contenteditable(用 browser_eval 检查 el.tagName); 2) 元素是 readonly/disabled(检查 el.readOnly / el.disabled); 3) 被 SPA 框架接管(React/Vue 需要触发原生 input 事件,改用 browser_eval: el.value=\"...\"; el.dispatchEvent(new Event('input', {bubbles:true}))",
     );
   }
 });

  // 6. eval
  server.registerTool("browser_eval", {
    description:
      "在页面执行 JS 表达式(=F12 控制台输入,如 document.title / JSON.stringify({...}) / 1+1 / location.href),返回结果。传表达式,不是箭头函数。可读 DOM/storage/发请求。",
    inputSchema: { code: z.string().describe("要执行的 JS 表达式/语句") },
  }, async (params) => {
    try {
      const s = await ensureSession();
      refreshActivePage(s);
      const result = await s.page.evaluate(params.code);
      return ok(toText(result));
    } catch (e) {
      return err(
        "eval 失败",
        e,
        "注意: code 参数是 JS 表达式(不是箭头函数),直接在页面执行。错误示例: '=> 1+1' 错(不要箭头函数); 正确: '1+1' 或 'document.title'。要执行多行语句用 IIFE: '(async () => { ... })()'。循环引用的对象会被 JSON.stringify 转成 '[object Object]'",
      );
    }
  });

  // 7. storage
  server.registerTool("browser_storage", {
    description: "读取存储(F12 Application)。type: cookies|localStorage|sessionStorage。",
    inputSchema: {
      type: z.enum(["cookies", "localStorage", "sessionStorage"]),
      url: z.string().optional().describe("读 cookies 时限定 URL"),
    },
  }, async (params) => {
    try {
      const s = await ensureSession();
      refreshActivePage(s);
      let result;
      if (params.type === "cookies") {
        result = await s.context.cookies(params.url);
      } else {
        result = await s.page.evaluate((t) => {
          const st = t === "localStorage" ? localStorage : sessionStorage;
          return Object.fromEntries(Object.entries(st));
        }, params.type);
      }
      return ok(toText(result));
    } catch (e) {
      return err(
        "storage 失败",
        e,
        "type 参数必须是 cookies / localStorage / sessionStorage 之一。读 cookies 时若指定 url,需是完整 URL(含协议)。localStorage/sessionStorage 在跨域页面访问会被浏览器同源策略拦截,确保 browser_navigate 到目标域后再读",
      );
    }
  });

  // 8. console
  server.registerTool("browser_console", {
    description: "读取累积的 console 日志(F12 Console)。可选 level 过滤。会话启动起开始记录。",
    inputSchema: { level: z.enum(["error", "warning", "log", "info"]).optional() },
  }, async (params) => {
    try {
      const s = await ensureSession();
      let buf = s.consoleBuffer;
      if (params.level) buf = buf.filter((e) => e.type === params.level);
      const entries = buf.slice(-100);
      return ok(toText(entries));
    } catch (e) {
      return err(
        "console 失败",
        e,
        "console buffer 在 session 建立后开始记录。若没记录到,可能: 1) 当前页面没产生 console 输出; 2) 监听器绑在 session 建立时的 page(现已修复为绑 context,新 tab 也能收集); 3) 想看实时日志,用 browser_eval 直接劫持 console.log",
      );
    }
  });

  // 9. wait_human —— MCP server 无 TUI,退化为纯文本往返
  server.registerTool("browser_wait_human", {
    description:
      "遇到验证码/登录等需人工操作时调用。MCP server 无 GUI,本工具返回当前页面 URL 和需要人工操作的说明;调用方(Codex 等)应在终端暂停,提示用户去浏览器手动操作,完成后回复继续。",
    inputSchema: { reason: z.string().describe("需要人工做什么(如:过验证码)") },
  }, async (params) => {
    try {
      const s = await ensureSession();
      refreshActivePage(s);
      const url = tryUrl(s.page);
      return ok(
        `🔒 需要人工操作:${params.reason}\n当前页面:${url || "(未知)"}\n` +
          `请在浏览器里操作完,然后回到调用方终端回复『继续』。`,
      );
    } catch (e) {
      return err(
        "wait_human 失败",
        e,
        "wait_human 用于验证码/2FA/登录等需人工介入的场景。它返回当前 URL 和操作说明给 AI,AI 应把提示转达给用户并暂停。若 Chrome 不可达,先 browser_session 重建会话",
      );
    }
  });

  // 10. screenshot
  server.registerTool("browser_screenshot", {
    description: `截图存为文件(配角:非多模态模型不解读,主要给人看)。默认存 ${join(AGENT_DIR, "bw-shots")}/。`,
    inputSchema: { fullPage: z.boolean().optional().describe("是否整页截图") },
  }, async (params) => {
    try {
      const s = await ensureSession();
      refreshActivePage(s);
      const dir = join(AGENT_DIR, "bw-shots");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `shot-${Date.now()}.png`);
      await s.page.screenshot({ path: file, fullPage: !!params.fullPage });
      return ok(`截图已存:${file}`);
    } catch (e) {
      return err(
        "screenshot 失败",
        e,
        `截图存到 ${join(AGENT_DIR, "bw-shots")}/shot-<timestamp>.png。失败原因通常是页面还没加载完或 Chrome 崩了。注意: 非多模态模型无法解读截图内容,建议改用 browser_snapshot 拿 DOM 文本`,
      );
    }
  });

  // 11. close
  server.registerTool("browser_close", {
    description:
      "显式关闭当前浏览器会话,释放资源(real 断开 CDP 连接,不关真实 Chrome;isolated 关闭浏览器进程)。下次工具调用会自动重建。",
  }, async () => {
    const was = current ? current.type : "(无)";
    await serialize(async () => {
      if (current) {
        await safeDispose(current);
        current = null;
      }
    });
    lastTabCount = 0;
    return ok(`已关闭 ${was} 会话,资源已释放`);
  });

  return server;
}

// ===== 进程退出清理(带超时兜底,防 Playwright close 卡死) =====
async function cleanup() {
  await serialize(async () => {
    if (current) {
      await safeDispose(current);
      current = null;
    }
  });
}
async function shutdown(code = 0) {
  try {
    await Promise.race([
      cleanup(),
      new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
    ]);
  } catch {
    /* ignore */
  }
  process.exit(code);
}

// stdin EOF:StdioServerTransport 只监听 data/error,client 关 stdin 不会触发 onclose。
// 补这个监听,防 isolated 浏览器变孤儿。
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));
process.once("beforeExit", () => void cleanup());
// 信号:第一次优雅退出(带超时兜底);后续信号兜底强退
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
  process.once(sig, () => void shutdown(0));
  // 第二次同信号:跳过清理直接退
  process.on(sig, () => process.exit(130));
}

// ===== 启动 =====
function parseArgs() {
  const args = process.argv.slice(2);
  let transport = "stdio";
  let port = 9223;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transport" && args[i + 1] === "http") transport = "http";
    if (args[i] === "--port") port = parseInt(args[i + 1], 10) || port;
  }
  return { transport, port };
}

async function runStdio() {
  const server = createServer();
  const t = new StdioServerTransport();
  // transport 关闭(client 主动断)时也触发退出清理
  t.onclose = () => void shutdown(0);
  await server.connect(t);
  console.error("[agentic-browser-mcp] stdio server ready");
}

async function runHttp(port) {
  // stateless streamable:每个 POST 请求 new server + new transport,
  // res.on('close') 时清理。底层 Playwright session 跨请求共享。
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { createServer: createHttp } = await import("node:http");

  const httpServer = createHttp(async (req, res) => {
    const u = new URL(req.url || "", `http://localhost`);
    if (u.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Not found. Use /mcp" }, id: null }));
      return;
    }
    // stateless 模式:GET/DELETE 返回 405(规范要求)
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless: POST only)" }, id: null }));
      return;
    }
    // 读 body(限制 8MB,防超大 POST 导致 OOM)
    const MAX_BODY = 8 * 1024 * 1024;
    const chunks = [];
    let bodyLen = 0;
    for await (const c of req) {
      bodyLen += c.length;
      if (bodyLen > MAX_BODY) {
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Request body too large (max 8MB)" }, id: null }));
        return;
      }
      chunks.push(c);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }
    // 每请求 new server + transport
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("[agentic-browser-mcp] http handle error:", e?.message || e);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e?.message || e) }, id: null }));
      }
    }
    // 请求关闭即清理(防 transport/SSE 流泄漏)
    res.on("close", () => {
      try { transport.close(); } catch {}
      try { server.close(); } catch {}
    });
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`[agentic-browser-mcp] http server ready on http://127.0.0.1:${port}/mcp (stateless)`);
  });
}

// main
const { transport, port } = parseArgs();
if (transport === "http") {
  runHttp(port).catch((e) => {
    console.error("[agentic-browser-mcp] fatal:", e);
    process.exit(1);
  });
} else {
  runStdio().catch((e) => {
    console.error("[agentic-browser-mcp] fatal:", e);
    process.exit(1);
  });
}
