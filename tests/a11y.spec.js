// アクセシビリティの自動点検（axe-core。WCAG 2 A/AA）。色の差（コントラスト）・名前の無いボタンなどを見つける。
// 重大（serious / critical）が1つでもあれば落とす。2つのテーマ（ふつう・暗い）で、来場者の主な画面を見る。
// 除外：meta-viewport（地図のピンチ拡大とページの拡大がぶつかるため user-scalable=no は方針。文字は「特大」で大きくできる）
//       本部ボードの戻るボタン（大画面で校内図を隠さないよう、わざと薄くしている。近づくと濃くなる）
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockGas } = require('./mock');

const CASES = [
  ['マップ', '/?tab=map'], ['一覧', '/?tab=list'], ['スタンプ', '/?tab=stamp'], ['インフォ', '/?tab=info'],
  ['ブースの詳細', '/?booth=1F-02'],
  ['地図の検索', '/?tab=map', async p => { await p.locator('#map-q').fill('でんし'); await p.waitForTimeout(300); }],
  ['スタンプ5個', '/?tab=stamp', null, ['1F-02', '1F-03', '1F-05', '1F-07', '1F-08']],
  ['QRの案内', '/?tab=stamp', async p => { await p.addScriptTag({ content: 'delete window.BarcodeDetector' }); await p.locator('#stamp-scan').click(); await p.waitForTimeout(400); }],
  ['紙マップ', '/?mode=print'], ['本部ボード', '/?mode=board'], ['係員ログイン', '/?mode=admin'],
];

for (const theme of ['paper', 'heavy']) {
  for (const [name, url, act, stamps] of CASES) {
    test(`a11y（${theme === 'heavy' ? '暗い' : 'ふつう'}）：${name}`, async ({ page }) => {
      await page.setViewportSize({ width: name === '本部ボード' ? 1280 : 390, height: 844 });
      await page.addInitScript(([th, st]) => {
        localStorage.setItem('kuroko_theme', JSON.stringify(th));
        if (st) localStorage.setItem('kuroko_stamps_v2', JSON.stringify(st));
      }, [theme, stamps]);
      await mockGas(page);
      await page.goto(url);
      await expect.poll(() => page.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);
      await page.waitForTimeout(name === '本部ボード' ? 3000 : 900);   // 画面の出る動きが終わってから測る
      if (act) await act(page);
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['meta-viewport'])
        .exclude('body.board-mode #staff-back')
        .analyze();
      const bad = r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
        .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' / ')}`);
      expect(bad).toEqual([]);
    });
  }
}

/* ---------------- v226：司令塔（入口・5枚）と、来場者の当たりの札・一斉お知らせ ---------------- */
// 司令塔はサーバーの返事が要るので、模擬の返事ではなく Code.gs をそのまま動かす（tests/gas-mock.js）。パスワードはテスト用
const { loadGas } = require('./gas-mock');
for (const theme of ['paper', 'heavy']) {
  test(`a11y（${theme === 'heavy' ? '暗い' : 'ふつう'}）：司令塔の入口と5枚（イベントを出しているとき）・当たりの札・一斉お知らせ`, async ({ page, browser, baseURL }) => {
    test.setTimeout(120000);
    const PASS = 'test-password-1234', OWNER = 'owner-himitsu-123456';
    const origin = baseURL.replace('127.0.0.1', 'localhost');
    const g = loadGas({ props: { ADMIN_PASS: PASS, OWNER_PASS: OWNER, OWNER_ORIGINS: origin } });
    g.setupR8AndArchiveOthers();
    g.__post({ action: 'verify', pass: PASS, cid: 'bbbb2222bbbb' });
    g.__post({ action: 'ledger', cid: 'AAAA1111', ev: ['1F-02', '1F-03', '2F-12'].map(id => ({ t: 's', id, at: Date.now() })) });
    const bridge = async t => t.route(/script\.google(usercontent)?\.com\//, async route => {
      const req = route.request();
      const body = req.method() === 'POST' ? g.doPost({ postData: { contents: req.postData() || '{}' } }).getContent() : g.doGet({ parameter: Object.fromEntries(new URL(req.url()).searchParams) }).getContent();
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body });
    });
    const axe = async (p, name) => {
      await p.waitForTimeout(800);
      const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa']).disableRules(['meta-viewport']).analyze();
      return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${name} ${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' / ')}`);
    };
    await bridge(page);
    await page.addInitScript(th => localStorage.setItem('kuroko_theme', JSON.stringify(th)), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/?mode=owner');
    await expect(page.locator('#own-pw')).toBeVisible({ timeout: 15000 });
    const bad = [...await axe(page, '入口')];
    await page.locator('#own-pw').fill(OWNER);
    await page.locator('#own-login').click();
    await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
    page.on('dialog', d => d.accept());
    await page.locator('#owntab-event').click();
    await page.locator('#own-lucky-booth').selectOption('1F-05');
    await page.locator('#own-lucky-start').click();
    await expect(page.locator('#own-lucky-now')).toContainText('光らせています', { timeout: 10000 });
    await page.locator('#own-draw-min [data-v="1"]').click();
    await page.locator('#own-draw-go').click();
    await expect(page.locator('#own-draw-res li')).toHaveCount(1, { timeout: 10000 });
    for (const t of ['home', 'event', 'hq', 'staff', 'setup']) {
      await page.locator('#owntab-' + t).click();
      bad.push(...await axe(page, t));
    }
    // 来場者：当たりの札・一斉お知らせ（しずかに）
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await bridge(ctx);
    const v = await ctx.newPage();
    await v.addInitScript(th => { localStorage.setItem('kuroko_theme', JSON.stringify(th)); localStorage.setItem('kuroko_intro_v1', '1'); }, theme);
    await v.goto(origin + '/?tab=stamp');
    await expect.poll(() => v.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);
    await v.evaluate(() => { localStorage.setItem('kuroko_live_win', JSON.stringify({ id: S.live && S.live.draw ? S.live.draw.id : 'x', until: Date.now() + 600000, place: '受付（南棟昇降口）' })); renderWin(); });
    bad.push(...await axe(v, '当たりの札'));
    await v.evaluate(() => showLiveFx('show', 'まもなく開場', 'ゆっくりどうぞ', true, 'calm'));
    bad.push(...await axe(v, '一斉お知らせ'));
    await ctx.close();
    expect(bad).toEqual([]);
  });
}
