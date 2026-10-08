// 本物のタップ・なぞり・キーでのでたらめ操作（v180）。
// monkey.spec.js は関数を直接呼ぶ。こちらは、見えている「押せる物」やでたらめな場所を実際に押し、
// なぞり、長押しし、キーを打ち、「戻る」「進む」を押す。来場者の画面と係員の画面（模擬のサーバー）の両方。
// これで見つけて v180 で直した：横向きで一覧・係員の画面が 4px 横にはみ出す、ログイン後の「戻る」でパスワードの画面が出る。
// もっと回すとき：SEEDS=1,2,3,4,5,6 STEPS=300 npx playwright test monkey-tap.spec.js
//               係員の画面：START="/?mode=admin" STAFF=1 SEEDS=... npx playwright test monkey-tap.spec.js
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');
const SEEDS = (process.env.SEEDS || '5,9').split(',').map(Number);
const STEPS = Number(process.env.STEPS || 150);
const ENV_START = process.env.START || '';
const RUNS = ENV_START ? SEEDS.map(seed => ({ seed, START: ENV_START, STAFF: process.env.STAFF === '1' }))
  : SEEDS.map(seed => ({ seed, START: '/?tab=map', STAFF: false })).concat([{ seed: 2, START: '/?mode=admin', STAFF: true }]);
for (const { seed, START, STAFF } of RUNS) {
  test(`本物のタップ・なぞり・キーででたらめに操作しても、エラーが出ず画面が崩れない（${STAFF ? '係員の画面' : '来場者の画面'}・種 ${seed}）`, async ({ page, context }) => {
    test.setTimeout(420000);
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message + ' @ ' + ((e.stack || '').split('\n')[1] || '').trim()));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|status of 4/.test(m.text())) errs.push('console: ' + m.text()); });
    page.on('dialog', d => d.dismiss().catch(() => {}));
    await mockGas(page, { verifyOk: STAFF });
    // 外へ出るリンク・印刷・共有は止める
    await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost|script\.google)/, r => r.abort());
    await page.addInitScript(seed => {
      try{ localStorage.setItem('kuroko_intro_v1', '1'); }catch(e){}   // アプリの外の白紙ページでは保存領域に触れない
      let x = seed * 2654435761 % 2147483647; Math.random = () => { x = (x * 48271) % 2147483647; return x / 2147483647; };
      window.print = () => {}; window.open = () => null;
      try{ navigator.share = async () => {}; }catch(e){}
    }, seed);
    await page.goto(START);
    if (STAFF) { await page.locator('#pw').fill('test-password-1234'); await page.locator('#btn-login').click(); }
    await page.waitForFunction(() => typeof S !== 'undefined' && S.booths.length > 0);
    let s = seed * 7919; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
    const log = []; const bad = [];
    const vp = () => page.viewportSize();
    const acts = [
      // 見えている「押せる物」をでたらめに1つ押す（いちばん多く）
      ['el', 10, async () => {
        const r = await page.evaluate(n => {
          const els = [...document.querySelectorAll('button, [role="button"], a[href], summary, input, select, .room[data-id], [tabindex="0"]')].filter(e => {
            if (e.disabled) return false; const b = e.getBoundingClientRect();
            if (b.width < 4 || b.height < 4 || b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) return false;
            const st = getComputedStyle(e); if (st.visibility === 'hidden' || st.pointerEvents === 'none') return false;
            if (e.tagName === 'A' && /^https?:/.test(e.getAttribute('href') || '') ) return false;
            if (/hard-reload|btn-hard|pam-reset|adm-logout|btn-logout/.test(e.id || '')) return false;
            return true; });
          if (!els.length) return null;
          const e = els[n % els.length], b = e.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2, d: (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className).split(' ')[0]) + ' ' + (e.textContent || '').trim().slice(0, 10) };
        }, rnd(100000));
        if (!r) { log.push('el none'); return; }
        log.push('tap ' + r.d);
        await page.mouse.click(Math.max(1, Math.min(vp().width - 1, r.x)), Math.max(1, Math.min(vp().height - 1, r.y)));
      }],
      ['xy', 3, async () => { const x = 5 + rnd(vp().width - 10), y = 5 + rnd(vp().height - 10); log.push(`xy ${x},${y}`); await page.mouse.click(x, y); }],
      ['dbl', 1, async () => { const x = 5 + rnd(vp().width - 10), y = 80 + rnd(vp().height - 160); log.push(`dbl ${x},${y}`); await page.mouse.click(x, y); await page.mouse.click(x, y); }],
      ['drag', 2, async () => { const x = 40 + rnd(vp().width - 80), y = 120 + rnd(vp().height - 240); const dx = rnd(300) - 150, dy = rnd(300) - 150; log.push(`drag ${x},${y}→${dx},${dy}`);
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up(); }],
      ['long', 1, async () => { const x = 40 + rnd(vp().width - 80), y = 120 + rnd(vp().height - 240); log.push(`long ${x},${y}`); await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); }],
      ['wheel', 2, async () => { const dy = (rnd(2) ? 1 : -1) * (100 + rnd(900)); log.push('wheel ' + dy); await page.mouse.move(vp().width / 2, vp().height / 2); await page.mouse.wheel(0, dy); }],
      ['key', 3, async () => { const k = ['Escape', 'Tab', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '/', '?', '0', '1', '2', '3', '4', '+', '-', ' ', 'Shift+Tab', 'Backspace'][rnd(19)]; log.push('key ' + k); await page.keyboard.press(k); }],
      ['type', 1, async () => { const t = ['電子', 'a', '12', 'といれ', '企業 3', '<x>'][rnd(6)]; log.push('type ' + t); await page.keyboard.type(t); }],
      ['back', 1, async () => { log.push('back'); await page.evaluate(() => { if (history.state) history.back(); }); }],
      ['fwd', 1, async () => { log.push('fwd'); await page.evaluate(() => history.forward()); }],
      ['resize', 1, async () => { const w = [320, 360, 390, 430, 844, 768, 1100][rnd(7)], h = w === 844 ? 390 : [640, 740, 844][rnd(3)]; log.push('resize ' + w + 'x' + h); await page.setViewportSize({ width: w, height: h }); }],
      ['wait', 1, async () => { log.push('wait'); await page.waitForTimeout(600); }],
    ];
    const bag = []; acts.forEach(a => { for (let i = 0; i < a[1]; i++) bag.push(a[2]); });
    for (let i = 0; i < STEPS; i++) {
      try { await bag[rnd(bag.length)](); } catch (e) { log.push('ERR ' + String(e).slice(0, 80)); }
      // ページを離れていたら戻る（別のページ・白紙）
      const u = page.url();
      if (!/^http:\/\/127\.0\.0\.1:\d+\/(index\.html)?(\?|#|$)/.test(u)) { log.push('left ' + u.slice(0, 60)); errs.length = errs.filter(e => !/localStorage/.test(e)).length; await page.goto(START); }
      try { await page.waitForFunction(() => typeof S !== 'undefined' && document.readyState === 'complete', null, { timeout: 15000 }); } catch (e) { log.push('S待ち失敗'); }
      if (i % 5 === 4) {
        await page.waitForTimeout(500);
        let r;
        try {
          r = await page.evaluate(() => {
            if (typeof S === 'undefined') return ['S が無い'];
            const out = [];
            const z = ZOOM;
            if (![z.k, z.x, z.y].every(isFinite)) out.push('ZOOM NaN ' + [z.k, z.x, z.y]);
            if (document.documentElement.scrollWidth > innerWidth + 2 && ['report', 'board', 'print', 'pamphlet', 'qr', 'admin'].indexOf(S.view) < 0) out.push('横はみ出し ' + document.documentElement.scrollWidth + '>' + innerWidth + ' view=' + S.view);
            if (S.sheetId && document.getElementById('bsh').hidden) out.push('sheetId あるのに hidden');
            const scanOpen = !document.getElementById('scan').classList.contains('hide');
            if (!S.sheetId && !scanOpen && document.documentElement.classList.contains('sheet-open')) out.push('sheet-open が残っている（画面が動かせない）');
            const on = [...document.querySelectorAll('.view.on')].map(v => v.id); if (on.length !== 1) out.push('view.on=' + on.join(','));
            if (on.length === 1 && on[0] !== 'v-' + S.view) out.push('S.view=' + S.view + ' だが出ているのは ' + on[0]);
            if (document.body.innerText.trim().length < 20) out.push('真っ白');
            // 何かの幕が残って操作できなくなっていないか
            const cover = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
            if (cover && cover.classList && cover.classList.contains('bsh-back') && !S.sheetId) out.push('幕（bsh-back）が残っている');
            if (document.querySelectorAll('.img-zoom').length > 1) out.push('img-zoom が複数');
            if (document.querySelectorAll('.sfx').length > 1) out.push('演出が複数');
            if (S.view === 'map' && !S.edit && !S.picking){
              const v = document.getElementById('map-view').getBoundingClientRect();
              if (v.height < 100) out.push('地図が低い ' + Math.round(v.height));
              if (z.baked && /scale/.test(z.el.style.transform)) out.push('baked なのに scale');
              const vis = [...document.querySelectorAll('svg.plan')].filter(x => !x.classList.contains('hide')).length; if (vis !== 1) out.push('出ている図が ' + vis);
              const bs = [...document.querySelectorAll('#map-card .map-floors button, #map-card .map-ctl button')].filter(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden').map(b => [b.id || b.textContent.trim().slice(0, 4), b.getBoundingClientRect()]);
              for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++){ const A = bs[a][1], B = bs[b][1];
                if (!(A.right <= B.left || A.left >= B.right || A.bottom <= B.top || A.top >= B.bottom)) out.push('ボタン重なり ' + bs[a][0] + '×' + bs[b][0]); }
              if (out.some(x => /重なり/.test(x))) out.push(`[${innerWidth}x${innerHeight} fs=${document.documentElement.getAttribute('data-fs')} floor=${S.floor} 箱=${Math.round(v.height)}]`);
            }
            return out;
          });
        } catch (e) { r = ['evaluate 失敗 ' + String(e).slice(0, 80)]; }
        if (r.length) { bad.push(`#${i} [${log.slice(-7).join(' > ')}] ` + r.join(' / ')); if (bad.length > 5) break; }
      }
    }
    expect([...new Set(errs)].map(e => e.slice(0, 300)).concat(errs.length ? ['直前の操作: ' + log.slice(-10).join(' > ').slice(0, 500)] : [])).toEqual([]);
    expect(bad.map(e => e.slice(0, 420))).toEqual([]);
  });
}
