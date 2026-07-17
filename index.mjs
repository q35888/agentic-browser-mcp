#!/usr/bin/env node
/**
 * agentic-browser-mcp — Pi 浏览器能力的独立 MCP server。
 *
 * 逻辑与 pi 扩展 ~/.pi/agent/extensions/browser-tool.ts 对齐(单一行为基准),
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
import { createConnection } from "node:net";

const AGENT_DIR = join(os.homedir(), ".pi", "agent");
const ISOLATED_PROFILE = join(AGENT_DIR, "bw-mcp-profile");
const CDP_ENDPOINT = "http://127.0.0.1:9222";
const CHROME_STARTER = join(AGENT_DIR, "start-agent-chrome.sh");

// Windows: 自动查找系统 Chrome，CDP 模式专用 profile
const IS_WIN = process.platform === "win32";
const CDP_PROFILE = join(AGENT_DIR, "chrome-cdp-profile");
const CHROME_CANDIDATES_WIN = [
  join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const SNAPSHOT_MAX_CHARS = 12000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const CHROME_BOOT_TIMEOUT_MS = 20000; // 自动拉起 Chrome 的最长等待

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

// 探测 9222 是否在听。用 TCP 连接(不走 HTTP 代理环境变量,避免 undici fetch
// 读 http_proxy 把 127.0.0.1:9222 发给代理 7897 导致误判)。
function chromeUp() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port: 9222 }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(1500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function spawnStarter() {
  // Windows: 直接 spawn chrome.exe（无 bash/nohup）
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
      ["-c", `nohup ${JSON.stringify(CHROME_STARTER)} > /tmp/agentic-browser-mcp-chrome.log 2>&1 &`],
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
  try {
    s.page.on("console", (m) => push(m.type(), m.text()));
    s.page.on("pageerror", (e) => push("error", String(e)));
  } catch {
    /* ignore */
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
    await s.dispose();
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
          "专用 Chrome(9222)未启动且自动拉起失败。请手动执行 ~/.pi/agent/start-agent-chrome.sh",
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
    return s;
  });
  syncTabCount();
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

  // content helpers —— 错误用 isError:true,让 MCP client(Codex)正确识别失败
  const ok = (t) => ({ content: [{ type: "text", text: t + tabHint() }] });
  const err = (prefix, e) => ({
    content: [{ type: "text", text: `${prefix}: ${e?.message ?? e}` }],
    isError: true,
  });

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
      return err(`浏览器会话失败\n提示: 请确认专用 Chrome 已启动(~/.pi/agent/start-agent-chrome.sh)且 9222 在听`, e);
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
        ? await ensureSession({ profile: params.profile, headless: params.headless, force: true })
        : await ensureSession();
      await s.page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return ok(toText({ ok: true, url: tryUrl(s.page), title: await tryTitle(s.page) }));
    } catch (e) {
      return err("导航失败", e);
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
     return err("snapshot 失败", e);
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
   if (!params.ref && !params.role) return err("参数缺失", new Error("必须提供 ref 或 role"));
   if (params.ref && !/^e\d+$/.test(params.ref)) return err("ref 非法", new Error(`ref 必须形如 e3，收到 ${params.ref}`));
   try {
     const s = await ensureSession();
     let loc;
     if (params.ref) {
       const sel = `[data-agent-ref="${params.ref}"]`;
       const cnt = await s.page.locator(sel).count();
       if (cnt === 0) return err("ref 失效", new Error(`ref=${params.ref} 未命中（页面可能已变化），请重新 snapshot`));
       if (cnt > 1) return err("ref 重复", new Error(`ref=${params.ref} 命中 ${cnt} 个（快照内部错误），请重新 snapshot`));
       loc = s.page.locator(sel).first();
     } else {
       loc = locateByRole(s.page, params.role || "", params.name);
     }
     await loc.click({ timeout: 10000 });
     return ok(`已点击 ${params.ref ? `ref=${params.ref}` : `${params.role}${params.name ? ` "${params.name}"` : ''}`}`);
   } catch (e) {
     return err("点击失败", e);
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
   if (!params.ref && !params.role) return err("参数缺失", new Error("必须提供 ref 或 role"));
   if (params.ref && !/^e\d+$/.test(params.ref)) return err("ref 非法", new Error(`ref 必须形如 e3，收到 ${params.ref}`));
   try {
     const s = await ensureSession();
     let loc;
     if (params.ref) {
       const sel = `[data-agent-ref="${params.ref}"]`;
       const cnt = await s.page.locator(sel).count();
       if (cnt === 0) return err("ref 失效", new Error(`ref=${params.ref} 未命中（页面可能已变化），请重新 snapshot`));
       if (cnt > 1) return err("ref 重复", new Error(`ref=${params.ref} 命中 ${cnt} 个（快照内部错误），请重新 snapshot`));
       loc = s.page.locator(sel).first();
     } else {
       loc = locateByRole(s.page, params.role || "", params.name);
     }
     await loc.fill(params.text, { timeout: 10000 });
     return ok(`已在 ${params.ref ? `ref=${params.ref}` : `${params.role}${params.name ? ` "${params.name}"` : ''}`} 输入 ${JSON.stringify(params.text)}`);
   } catch (e) {
     return err("输入失败", e);
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
      const result = await s.page.evaluate(params.code);
      return ok(toText(result));
    } catch (e) {
      return err("eval 失败", e);
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
      return err("storage 失败", e);
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
      return err("console 失败", e);
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
      const url = tryUrl(s.page);
      return ok(
        `🔒 需要人工操作:${params.reason}\n当前页面:${url || "(未知)"}\n` +
          `请在浏览器里操作完,然后回到调用方终端回复『继续』。`,
      );
    } catch (e) {
      return err("wait_human 失败", e);
    }
  });

  // 10. screenshot
  server.registerTool("browser_screenshot", {
    description: "截图存为文件(配角:非多模态模型不解读,主要给人看)。默认存 ~/.pi/agent/bw-shots/。",
    inputSchema: { fullPage: z.boolean().optional().describe("是否整页截图") },
  }, async (params) => {
    try {
      const s = await ensureSession();
      const dir = join(AGENT_DIR, "bw-shots");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `shot-${Date.now()}.png`);
      await s.page.screenshot({ path: file, fullPage: !!params.fullPage });
      return ok(`截图已存:${file}`);
    } catch (e) {
      return err("screenshot 失败", e);
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
