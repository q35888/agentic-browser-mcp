const { chromium } = require('playwright');
(async () => {
    const ctx = await chromium.launchPersistentContext(
        'C:\\Users\\zhi\\.pi\\agent\\bw-test-profile',
        { headless: true, channel: 'chrome' }
    );
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.setContent(`
        <html><body>
            <input type="text" placeholder="Search" aria-label="Search box">
            <button>Submit</button>
            <!-- 关键:按钮【自身】position:fixed,模拟真实悬浮按钮(6.3 豁免点) -->
            <button style="position:fixed;bottom:10px;right:10px">Fixed Btn</button>
            <button style="position:sticky;top:0">Sticky Btn</button>
            <div style="display:none"><button>Invisible</button></div>
            <a href="#" aria-hidden="true">Hidden</a>
        </body></html>
    `);

    // Run the exact same snapshot logic from index.mjs
    const MAX = 12000;
    const result = await page.evaluate((maxChars) => {
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
        document.querySelectorAll('[data-agent-ref]').forEach(el => el.removeAttribute('data-agent-ref'));
        const els = deepQuery(document, sel).filter(el =>
            el.getAttribute('aria-hidden') !== 'true' &&
            (el.offsetParent !== null || getComputedStyle(el).position === 'fixed' || getComputedStyle(el).position === 'sticky'));
        const lines = els.map((el, i) => {
            const ref = 'e' + (i + 1);
            el.setAttribute('data-agent-ref', ref);
            const role = el.getAttribute('role') || el.tagName.toLowerCase();
            const name = (el.getAttribute('aria-label') ||
                el.textContent?.trim()?.slice(0, 80) ||
                el.placeholder || el.title || '').slice(0, 80);
            const pos = getComputedStyle(el).position;
            return `- [ref=${ref}] ${role}${name ? ` "${name}"` : ''} (pos:${pos})`;
        });
        return lines.join('\n');
    }, MAX);

    console.log("=== SNAPSHOT ===");
    console.log(result);
    console.log("\n=== CHECKS ===");

    // 断言基于元素【可被分配 ref 且出现在输出里】,而非 pos 标签(fixed 元素 pos 才是 fixed)
    const checks = [];
    checks.push(['Fixed element visible (自身 position:fixed)', result.includes('Fixed Btn')]);
    checks.push(['Sticky element visible (自身 position:sticky)', result.includes('Sticky Btn')]);
    checks.push(['display:none filtered', !result.includes('Invisible')]);
    checks.push(['aria-hidden filtered', !result.includes('Hidden')]);

    let allPass = true;
    for (const [name, pass] of checks) {
        console.log(`${name}: ${pass ? 'PASS' : 'FAIL'}`);
        if (!pass) allPass = false;
    }

    // Click by ref only(验证 6.1:schema 已放行后,ref 单参点击能命中)
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