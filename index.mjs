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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const AGENT_DIR = join(os.homedir(), ".pi", "agent");
const ISOLATED_PROFILE = join(AGENT_DIR, "bw-mcp-profile");
const CDP_ENDPOINT = "http://127.0.0.1:9222";
const CHROME_STARTER = join(AGENT_DIR, "start-agent-chrome.sh");
const SNAPSHOT_MAX_CHARS = 12000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const CHROME_BOOT_TIMEOUT_MS = 20000; // 自动拉起 Chrome 的最长等待

// ===== 会话管理(与 browser-tool.ts 同构) =====
// 模块级单例:跨 MCP 请求/transport 共享同一个 Playwright 会话(=同一个 Chrome)。
// 用串行锁保护,防止 http 并发请求时 ensureSession/dispose 竞态。

let current = null;
let chain = Promise.resolve();
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
  const ok = (t) => ({ content: [{ type: "text", text: t }] });
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
    description: "返回页面 ARIA 无障碍树(YAML 文本,带 role+name)。据此调 click/type 时提供 role+name。",
  }, async () => {
    try {
      const s = await ensureSession();
      let t = await s.page.locator("body").ariaSnapshot();
      if (t.length > SNAPSHOT_MAX_CHARS) t = t.slice(0, SNAPSHOT_MAX_CHARS) + "\n…[截断,缩小操作范围或滚动后再 snapshot]";
      return ok(t);
    } catch (e) {
      return err("snapshot 失败", e);
    }
  });

  // 4. click
  server.registerTool("browser_click", {
    description: "点击页面元素,用 snapshot 里的 role(+name) 定位。",
    inputSchema: {
      role: z.string().describe("元素 role,见 snapshot 输出(如 link/button/textbox)"),
      name: z.string().optional().describe("元素的可访问名称(accessible name)"),
    },
  }, async (params) => {
    try {
      const s = await ensureSession();
      const loc = locateByRole(s.page, params.role, params.name);
      await loc.click({ timeout: 10000 });
      return ok(`已点击 ${params.role}${params.name ? ` "${params.name}"` : ""}`);
    } catch (e) {
      return err("点击失败", e);
    }
  });

  // 5. type
  server.registerTool("browser_type", {
    description: "在输入框(role 通常 textbox)输入文本,用 role+name 定位。",
    inputSchema: {
      role: z.string().describe("元素 role(通常 textbox/searchbox/combobox)"),
      name: z.string().optional().describe("输入框的可访问名称"),
      text: z.string().describe("要输入的文本"),
    },
  }, async (params) => {
    try {
      const s = await ensureSession();
      const loc = locateByRole(s.page, params.role, params.name);
      await loc.fill(params.text, { timeout: 10000 });
      return ok(`已在 ${params.role}${params.name ? ` "${params.name}"` : ""} 输入 ${JSON.stringify(params.text)}`);
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
    // 读 body
    const chunks = [];
    for await (const c of req) chunks.push(c);
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
