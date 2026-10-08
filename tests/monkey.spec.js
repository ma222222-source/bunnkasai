// でたらめ操作のテスト（v179）。
// 階・拡大・タブ・詳細・検索・絞り込み・★・スタンプ・いまここ・画面の大きさ・文字の大きさ・見た目…を、
// 種を決めた乱数で次々に操作し、エラーが出ないこと・画面が崩れないことを確かめる。
// 「開いた直後」だけを見るテストでは見つからない、操作の組み合わせで起きる不具合を拾う
//（例：開いたまま文字を特大に変えると地図のボタンが重なる ← これで見つけて v179 で直した）。
// 種が同じなら毎回同じ流れになる。失敗したら、出てきた「直前の操作」をたどれば再現できる。
// もっと回すとき：SEEDS=1,2,3,4,5,6 STEPS=300 npx playwright test monkey.spec.js
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');
const SEEDS = (process.env.SEEDS || '3,11').split(',').map(Number);
const STEPS = Number(process.env.STEPS || 160);
for (const seed of SEEDS) {
  test('でたらめに操作しても、エラーが出ず画面が崩れない（種 ' + seed + '）', async ({ page }) => {
    test.setTimeout(300000);
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message + ' @ ' + (e.stack || '').split('\n')[1]));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console: ' + m.text()); });
    await mockGas(page);
    await page.addInitScript(seed => { try{ localStorage.setItem('kuroko_intro_v1', '1'); }catch(e){}   // アプリの外の白紙ページでは保存領域に触れない
      let x = seed * 2654435761 % 2147483647; Math.random = () => { x = (x * 48271) % 2147483647; return x / 2147483647; }; }, seed);
    await page.goto('/?tab=map');
    await page.waitForFunction(() => typeof S !== 'undefined' && S.booths.length > 0);
    let s = seed * 7919; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
    const log = [];
    const bad = [];
    const acts = {
      tab: async () => { const v = ['map', 'list', 'stamp', 'info'][rnd(4)]; log.push('tab ' + v); await page.evaluate(v => switchView(v), v); },
      floor: async () => { const f = rnd(4); log.push('floor ' + f); await page.evaluate(f => { if (S.view === 'map') setFloor(f); }, f); },
      zoom: async () => { const k = 1 + rnd(71) / 10; log.push('zoom ' + k); await page.evaluate(k => { if (S.view === 'map') zoomTo(k, 100 + Math.random() * 150, 300 + Math.random() * 200, Math.random() < .5); }, k); },
      pan: async () => { log.push('pan'); await page.evaluate(() => { if (S.view === 'map'){ ZOOM.x += Math.random() * 400 - 200; ZOOM.y += Math.random() * 400 - 200; zoomApply(false); } }); },
      sheet: async () => { const i = rnd(46); log.push('sheet ' + i); await page.evaluate(i => openSheet(S.booths[i].id), i); },
      step: async () => { log.push('step'); await page.evaluate(() => { if (S.sheetId) sheetStep(Math.random() < .5 ? 1 : -1); }); },
      close: async () => { log.push('close'); await page.evaluate(() => { if (S.sheetId) closeSheet(); }); },
      wish: async () => { const i = rnd(46); log.push('wish ' + i); await page.evaluate(i => toggleWish(S.booths[i].id), i); },
      stamp: async () => { const i = rnd(46); log.push('stamp ' + i); await page.evaluate(i => { stampNow(S.booths[i].id); }, i); await page.waitForTimeout(250); await page.evaluate(() => { if (showStampFx.close) showStampFx.close(); }); },
      search: async () => { const q = ['電子', '', 'トイレ', 'ぜったいない', '3', '企業 機械'][rnd(6)]; log.push('search ' + q); await page.evaluate(q => { const el = document.getElementById('q'); el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); }, q); },
      filter: async () => { log.push('filter'); await page.evaluate(() => { const r = Math.random(); if (r < .25) setWishOnly(!S.wishOnly); else if (r < .5) setTodoOnly(!S.todoOnly); else if (r < .75){ const lf = document.getElementById('lf'); lf.value = ['', '1', '2', '3', '0'][Math.floor(Math.random() * 5)]; lf.dispatchEvent(new Event('change')); } else setSort(['free', 'name', 'near'][Math.floor(Math.random() * 3)]); }); },
      here: async () => { const i = rnd(46); log.push('here ' + i); await page.evaluate(i => setHere(S.booths[i].id, 'pick'), i); },
      lv: async () => { log.push('lv'); await page.evaluate(() => { const el = document.querySelectorAll('#summary .sum')[Math.floor(Math.random() * 4)]; if (el) el.click(); }); },
      resize: async () => { const w = [320, 360, 390, 430, 844, 768][rnd(6)], h = w === 844 ? 390 : [640, 740, 844][rnd(3)]; log.push('resize ' + w + 'x' + h); await page.setViewportSize({ width: w, height: h }); },
      theme: async () => { log.push('theme'); await page.evaluate(() => document.getElementById('btn-theme').click()); },
      fs: async () => { log.push('fs'); await page.evaluate(() => { const b = ['#fs-n', '#fs-l', '#fs-xl'][Math.floor(Math.random() * 3)]; const el = document.querySelector(b); if (el) el.click(); }); },
      sync: async () => { log.push('sync'); await page.evaluate(() => sync(false)); },
      wait: async () => { log.push('wait'); await page.waitForTimeout(500); },
      route: async () => { log.push('route'); await page.evaluate(() => { const c = document.querySelectorAll('[data-route]'); const el = c[Math.floor(Math.random() * c.length)]; if (el && el.offsetParent) el.click(); }); },
    };
    const names = Object.keys(acts);
    for (let i = 0; i < STEPS; i++) {
      await acts[names[rnd(names.length)]]();
      if (i % 4 === 3) {
        await page.waitForTimeout(Number(process.env.SETTLE || 500));   // 画面の大きさを変えた直後などの途中の一瞬は見ない
        const r = await page.evaluate(() => {
          const out = [];
          const z = ZOOM;
          if (![z.k, z.x, z.y].every(isFinite)) out.push('ZOOM NaN ' + [z.k, z.x, z.y]);
          if (z.k < z.min - .01 || z.k > z.max + .01) out.push('ZOOM range ' + z.k);
          if (document.documentElement.scrollWidth > innerWidth + 2) out.push('横はみ出し ' + document.documentElement.scrollWidth + '>' + innerWidth + ' view=' + S.view);
          if (S.sheetId && document.getElementById('bsh').hidden) out.push('sheetId あるのに hidden');
          if (!S.sheetId && document.documentElement.classList.contains('sheet-open') && document.getElementById('scan').classList.contains('hide')) out.push('sheet-open が残っている');
          const on = [...document.querySelectorAll('.view.on')].map(v => v.id); if (on.length !== 1) out.push('view.on=' + on.join(','));
          if (S.view === 'map'){
            const v = document.getElementById('map-view').getBoundingClientRect();
            if (v.height < 100) out.push('地図が低い ' + Math.round(v.height));
            const el = z.el.getBoundingClientRect();
            if (z.baked && /scale/.test(z.el.style.transform)) out.push('baked なのに scale');
            if (!z.baked && z.el.style.width) out.push('baked でないのに幅が残る ' + z.el.style.width);
            if (el.width >= v.width - 1 && (el.left > v.left + 2 || el.right < v.right - 2)) out.push('地図の横に空白 ' + [Math.round(el.left - v.left), Math.round(v.right - el.right)]);
            const vis = [...document.querySelectorAll('svg.plan')].filter(x => !x.classList.contains('hide')).length; if (vis !== 1) out.push('出ている図が ' + vis);
            // 重ねたボタンどうしの重なり
            const bs = [...document.querySelectorAll('#map-card .map-floors button, #map-card .map-ctl button')].filter(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden').map(b => [b.id || b.textContent.trim().slice(0, 4), b.getBoundingClientRect()]);
            for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++){ const A = bs[a][1], B = bs[b][1];
              if (!(A.right <= B.left || A.left >= B.right || A.bottom <= B.top || A.top >= B.bottom)) out.push('ボタン重なり ' + bs[a][0] + '×' + bs[b][0]); }
            if (out.some(x => /重なり/.test(x))) out.push(`[${innerWidth}x${innerHeight} fs=${document.documentElement.getAttribute('data-fs')} floor=${S.floor} 箱=${Math.round(v.height)} styleH=${document.getElementById('map-view').style.height} k=${z.k.toFixed(2)} baked=${!!z.baked} mNat=${Math.round(z.mNat)} mH=${Math.round(z.mH)} route=${S.route} key=${fitMapBox._key}]`);
          }
          return out;
        });
        if (r.length) { bad.push(`#${i} [${log.slice(-6).join(' > ')}] ` + r.join(' / ')); if (bad.length > 6) break; }
      }
    }
    expect(errs.map(e => e.slice(0, 300)).concat(errs.length ? ['直前の操作: ' + log.slice(-8).join(' > ')] : [])).toEqual([]);
    expect(bad.map(e => e.slice(0, 400))).toEqual([]);
  });
}
