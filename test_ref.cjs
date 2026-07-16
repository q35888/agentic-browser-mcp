const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');
(async () => {
    const ctx = await chromium.launchPersistentContext(
        path.join(os.homedir(), '.pi', 'agent', 'bw-test-profile'),
        { headless: true, channel: 'chrome' }
    );
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.setContent(`
        <html><body>
            <a href="#" id="lnk">Docs</a>
            <input type="text" id="q" placeholder="Search" aria-label="Search box">
            <input type="checkbox" id="cb">remember
            <input type="radio" id="rd">
            <select id="sl"><option>a</option></select>
            <textarea id="ta"></textarea>
            <button id="submit">Submit</button>
            <!-- 自身 position:fixed -->
            <button style="position:fixed;bottom:10px;right:10px">Fixed Btn</button>
            <button style="position:sticky;top:0">Sticky Btn</button>
            <!-- 各类隐藏:都应被过滤 -->
            <div style="display:none"><button>ParentHidden</button></div>
            <a href="#" aria-hidden="true">AriaHidden</a>
            <input type="text" style="opacity:0" aria-label="OpacityZero">
            <!-- 真正零尺寸:去掉 button 默认 padding/border/box-sizing 干扰 -->
            <button style="width:0;height:0;padding:0;border:0;box-sizing:border-box;overflow:hidden">ZeroSize</button>
            <input type="text" style="visibility:hidden" aria-label="VisHidden">
            <!-- 视口外:width/height>0 但在屏幕外 -->
            <button style="position:absolute;left:-9999px;top:-9999px">Offscreen</button>
            <!-- open shadow root 内的可交互元素 -->
            <div id="host"></div>
            <script>
                const h = document.getElementById('host');
                h.attachShadow({mode:'open'}).innerHTML = '<button id="shadow-btn">ShadowBtn</button>';
            </script>
        </body></html>
    `);

    // 与 index.mjs / browser-tool.ts 完全一致的注入逻辑(mode=all 测全量过滤,不看视口)
    async function snapshot(mode) {
        return page.evaluate(({ maxChars, mode }) => {
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
            function deepQuery(root, s) {
                const out = [...root.querySelectorAll(s)];
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) out.push(...deepQuery(el.shadowRoot, s));
                }
                return out;
            }
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
            deepQuery(document, '[data-agent-ref]').forEach(el => el.removeAttribute('data-agent-ref'));
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
                const name = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
                    el.textContent?.trim()?.slice(0, 80) || el.placeholder || el.title || '').slice(0, 80);
                return `- [ref=${ref}] ${role}${name ? ` "${name}"` : ''}`;
            });
            return lines.join('\n');
        }, { maxChars: 12000, mode });
    }

    const allResult = await snapshot('all');
    console.log("=== SNAPSHOT (mode=all) ===");
    console.log(allResult);
    console.log("\n=== CHECKS ===");

    const checks = [];
    // 可见性过滤
    checks.push(['opacity:0 filtered', !allResult.includes('OpacityZero')]);
    checks.push(['0x0 size filtered', !allResult.includes('ZeroSize')]);
    checks.push(['visibility:hidden filtered', !allResult.includes('VisHidden')]);
    checks.push(['parent display:none filtered', !allResult.includes('ParentHidden')]);
    checks.push(['aria-hidden filtered', !allResult.includes('AriaHidden')]);
    // fixed/sticky 保留
    checks.push(['fixed element kept', allResult.includes('Fixed Btn')]);
    checks.push(['sticky element kept', allResult.includes('Sticky Btn')]);
    // role 映射(原生标签 → 隐式 ARIA role)
    checks.push(['<a href> → role link', /\[ref=e\d+\] link "Docs"/.test(allResult)]);
    checks.push(['text input → role textbox', /\[ref=e\d+\] textbox "Search box"/.test(allResult)]);
    checks.push(['checkbox → role checkbox', /\[ref=e\d+\] checkbox/.test(allResult)]);
    checks.push(['radio → role radio', /\[ref=e\d+\] radio/.test(allResult)]);
    checks.push(['select → role combobox', /\[ref=e\d+\] combobox/.test(allResult)]);
    checks.push(['textarea → role textbox', /\[ref=e\d+\] textbox/.test(allResult)]);
    // shadow DOM
    checks.push(['shadow DOM button found', allResult.includes('ShadowBtn')]);

    let allPass = true;
    for (const [name, pass] of checks) {
        console.log(`${name}: ${pass ? 'PASS' : 'FAIL'}`);
        if (!pass) allPass = false;
    }

    // shadow DOM 旧 ref 清理:第二次 snapshot 不应残留旧 ref 重复
    const r2 = await snapshot('all');
    const refCount = (r2.match(/data-agent-ref|\[ref=e1\]/g) || []).length;
    // e1 应只出现一次(旧 ref 被清理,重新从 e1 编号)
    const e1Count = (r2.match(/ref=e1\]/g) || []).length;
    console.log(`shadow ref cleanup (e1 出现 ${e1Count} 次, 应为 1): ${e1Count === 1 ? 'PASS' : 'FAIL'}`);
    if (e1Count !== 1) allPass = false;

    // viewport 模式:Offscreen 按钮应被过滤(width/height>0 但在屏外)
    const vpResult = await snapshot('viewport');
    console.log(`viewport mode filters offscreen: ${!vpResult.includes('Offscreen') ? 'PASS' : 'FAIL'}`);
    if (vpResult.includes('Offscreen')) allPass = false;

    // ref-only click(命中数=1 才可点)
    try {
        const btn = page.locator('[data-agent-ref="e1"]').first();
        await btn.click({ timeout: 5000 });
        console.log('ref-only click: PASS');
    } catch (e) {
        console.log('ref-only click: FAIL (' + e.message + ')');
        allPass = false;
    }

    await ctx.close();
    if (allPass) {
        console.log("\n=== ALL TESTS PASSED ===");
        process.exit(0);
    } else {
        console.log("\n=== SOME TESTS FAILED ===");
        process.exit(1);
    }
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
