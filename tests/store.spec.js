// 端末に保存したデータ（localStorage）が変な形のとき（v181）。
// スタンプ・設定・控えなど、このアプリが端末に保存している値を、でたらめな値（数字だけ・配列のはずがオブジェクト・途中で切れた文字 など）に
// してから開き、来場者の画面・QR のスタンプ・係員の画面が、エラー・真っ白にならず、QR を読めばスタンプが保存されることを確かめる。
// v181 より前は、たとえばスタンプの保存先に数字が入っているだけで起動の途中で止まり、保存を消すまで開けなかった。
// 下のほうに、それでも起動に失敗したときの「直して開き直す」（本体の案内と、本体に頼らない最後の砦）のテスト
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');
const SEEDS = (process.env.SEEDS || '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number);
const KEYS = ['kuroko_sid', 'kuroko_spent_v1', 'kuroko_stamps_v2', 'kuroko_pushed_fp', 'kuroko_cid', 'kuroko_vis_q', 'kuroko_migrated', 'kuroko_join_from', 'kuroko_unsent',
  'kuroko_pamphlet_v1', 'kuroko_wish_v1', 'kuroko_sound', 'kuroko_recent_q', 'kuroko_joined', 'kuroko_here_v1', 'kuroko_cert_at', 'kuroko_cache_v2', 'kuroko_theme',
  'kuroko_sum_used', 'kuroko_stamp_at', 'kuroko_pushed_at', 'kuroko_intro_v1', 'kuroko_assigned_v2', 'kuroko_zoom_hint', 'kuroko_sort', 'kuroko_prize_remind', 'kuroko_notice_x',
  'kuroko_installed', 'kuroko_here_ask', 'kuroko_fs', 'kuroko_floor', 'kuroko_drafts', 'kuroko_adm_tab', 'kuroko_adm_open', 'kuroko_adm_mode', 'kuroko_pulled_at', 'kuroko_ledger_q',
  'kuroko_stamps', 'kuroko_stamps_v1', 'kuroko_chk_1'];
const RAW = ['', ' ', 'null', 'undefined', 'true', 'false', '0', '-1', '1e999', '12', '"abc"', '"1F-02"', '[]', '{}', '[null]', '[1,2,3]', '["1F-02","1F-03",null,5,{}]', '{"a":1}', '{"id":null}', '{"id":"1F-02","at":"x"}',
  '{"id":"1F-02","at":99999999999999}', '[[]]', '[{}]', '{"1F-02":"x","1F-03":null}', '{', '[1,', 'NaN', '"', 'あいう', '<script>', '{"booths":null}', '{"booths":"x","updatedAt":5}', '{"booths":[null,5,{}],"notice":7}',
  '"' + 'x'.repeat(5000) + '"', '[' + Array(400).fill('"1F-02"').join(',') + ']', '{"__proto__":{"x":1}}', '"n"', '"xl"', '"heavy"', '"name"', '9', '"flat"'];
for (const seed of SEEDS) {
  test('端末の保存が変な形でも開ける・QRのスタンプが付く（種 ' + seed + '）', async ({ page }) => {
    test.setTimeout(120000);
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message + ' @ ' + ((e.stack || '').split('\n')[1] || '').trim()));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|status of 4/.test(m.text())) errs.push('console: ' + m.text()); });
    await mockGas(page, { verifyOk: true });
    let s = seed * 15485863; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
    // 種が 1〜4 のときは「全部のキーを同じ種類の値」に、ほかはキーごとにばらばら
    const data = {};
    KEYS.forEach(k => { if (seed <= 4 || rnd(100) < 70) data[k] = seed <= 4 ? RAW[(seed * 7 + rnd(3)) % RAW.length] : RAW[rnd(RAW.length)]; });
    await page.addInitScript(d => { try { if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); Object.keys(d).forEach(k => localStorage.setItem(k, d[k])); } } catch (e) {} }, data);
    const check = async label => {
      await page.waitForTimeout(1200);
      const o = await page.evaluate(() => ({ S: typeof S !== 'undefined', n: (typeof S !== 'undefined' && S.booths) ? S.booths.length : -1, blank: document.body.innerText.trim().length < 20,
        over: document.documentElement.scrollWidth > innerWidth + 2, on: [...document.querySelectorAll('.view.on')].map(v => v.id).join(',') }));
      if (!o.S) errs.push(label + ': アプリが動いていない');
      if (o.blank) errs.push(label + ': 真っ白');
      if (o.over) errs.push(label + ': 横はみ出し');
      if (!o.on) errs.push(label + ': どの画面も出ていない');
      if (o.n === 0) errs.push(label + ': ブースが0件（通信は成功しているのに）');
    };
    await page.setViewportSize({ width: 390, height: 800 });
    for (const tab of ['map', 'list', 'stamp', 'info']) {
      await page.goto('/?tab=' + tab); await check(tab);
      try { await page.evaluate(() => { if (S.booths[0]) { openSheet(S.booths[0].id); closeSheet(); } }); } catch (e) { errs.push(tab + ' 詳細: ' + String(e).slice(0, 150)); }
    }
    // QR でスタンプ
    const k = await page.evaluate(() => typeof sigOf === 'function' ? sigOf('1F-05') : '');
    await page.goto(`/?booth=1F-05&qr=1&k=${k}`); await check('QR');
    const got = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]'); } catch (e) { return 'parse失敗'; } });
    if (!(Array.isArray(got) && got.includes('1F-05'))) errs.push('QRを読んだのにスタンプが保存されていない: ' + JSON.stringify(got).slice(0, 80));
    await page.goto('/?mode=check'); await check('check');
    await page.goto('/?mode=admin'); await check('auth');
    try {
      await page.locator('#pw').fill('test-password-1234'); await page.locator('#btn-login').click();
      await page.waitForFunction(() => S.view === 'admin', null, { timeout: 10000 });
      for (const t of ['update', 'recept', 'hq', 'prep']) { await page.evaluate(t => { setAdmTab(t); renderAdmin(); }, t); await page.waitForTimeout(250); }
      await check('admin');
      // 人数を数えて送る・来場者を足す
      await page.evaluate(() => { setAdmTab('update'); renderAdmin(); const c = document.querySelector('#admin-list .adm-booth [data-step="1"]'); if (c) c.click(); const s2 = document.querySelector('#admin-list .adm-booth .send'); if (s2) s2.click(); try{ addVisitors(1); }catch(e){ console.error(e); } });
      await page.waitForTimeout(800);
      for (const m of ['qr', 'report', 'board']) { await page.goto('/?mode=' + m); await check(m); }
    } catch (e) { errs.push('係員: ' + String(e).slice(0, 200)); }
    expect([...new Set(errs)].map(e => e.slice(0, 300)).concat(errs.length ? ['保存していた値: ' + JSON.stringify(data).slice(0, 600)] : [])).toEqual([]);
  });
}

test('起動の途中でエラーになったら「直して開き直す」が出て、押すと開ける。集めたスタンプは残り、設定は初めに戻る', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__broke')) return;
    sessionStorage.setItem('__broke', '1');
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03', 5, null]));
    localStorage.setItem('kuroko_spent_v1', JSON.stringify(['1F-02']));
    localStorage.setItem('kuroko_fs', JSON.stringify('xl'));
    localStorage.setItem('kuroko_cache_v2', '{"booths":"こわれた控え"}');
    // 1回目だけ、起動の途中（init の中で最初に画面の描き直しを予約する所）でエラーを起こす
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = function(){ window.requestAnimationFrame = raf; throw new Error('わざと起こしたエラー'); };
  });
  await page.goto('/?tab=stamp');
  const btn = page.locator('main button', { hasText: '直して開き直す' });
  await expect(btn).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#boot-rescue')).toHaveCount(0);       // 本体が案内を出したときは、最後の砦は出ない
  await btn.click();
  await expect.poll(() => page.evaluate(() => typeof S !== 'undefined' && window.__booted === true && S.booths.length).catch(() => 'まだ'), { timeout: 20000 }).toBe(46);
  const st = await page.evaluate(() => ({ stamps: JSON.parse(localStorage.getItem('kuroko_stamps_v2')), spent: JSON.parse(localStorage.getItem('kuroko_spent_v1')), fs: localStorage.getItem('kuroko_fs') }));
  expect(st.stamps).toEqual(['1F-02', '1F-03']);
  expect(st.spent).toEqual(['1F-02']);
  expect(st.fs).toBeNull();
});

test('本体のプログラムがまるごと動かなかったときも、最後の砦が「直して開き直す」を出し、押すと開ける', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__broke')) return;
    sessionStorage.setItem('__broke', '1');
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-07']));
    // 1回目だけ、本体のプログラムが最初の1行目から動かないようにする（同じ名前を先に取っておく）
    Object.defineProperty(window, 'CONFIG', { value: 1, configurable: false });
  });
  await page.goto('/?tab=map');
  await expect(page.locator('#boot-rescue-btn')).toBeVisible({ timeout: 15000 });
  await page.locator('#boot-rescue-btn').click();
  await expect.poll(() => page.evaluate(() => typeof S !== 'undefined' && window.__booted === true && S.booths.length).catch(() => 'まだ'), { timeout: 20000 }).toBe(46);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2')))).toEqual(['1F-07']);
  await expect(page.locator('#boot-rescue')).toHaveCount(0);
});

test('ふつうに開けたときは、最後の砦は出ない', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await expect.poll(() => page.evaluate(() => typeof S !== 'undefined' && S.booths.length), { timeout: 15000 }).toBe(46);
  await page.waitForTimeout(5000);
  await expect(page.locator('#boot-rescue')).toHaveCount(0);
  expect(await page.evaluate(() => window.__booted)).toBe(true);
});
