const { fillStaffName, enterStaff } = require('./staff-name-helper');
// v240：ブース専用QR → ログイン → そのブースだけを更新。印刷物も実際に読んで確かめる。
const { test, expect } = require('@playwright/test');
const { mockGas, watchErrors } = require('./mock');
const { loadGas } = require('./gas-mock');
const PASS = 'test-password-1234', OWNER = 'test-owner-123456';

async function bridge(page, props = {}) {
  const g = loadGas({ props: { ADMIN_PASS: PASS, OWNER_PASS: OWNER, ...props } });
  g.setupR8AndArchiveOthers();
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    const r = route.request();
    const text = r.method() === 'POST'
      ? g.doPost({ postData: { contents: r.postData() || '{}' } }).getContent()
      : g.doGet({ parameter: Object.fromEntries(new URL(r.url()).searchParams) }).getContent();
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: text });
  });
  return g;
}
async function login(page) {

  await enterStaff(page);
  await expect(page.locator('#v-admin')).toBeVisible();
}
async function ownerPrint(page) {
  await bridge(page);
  await page.goto('/?mode=owner');
  await page.locator('#own-pw').fill(OWNER);
  await page.locator('#own-login').click();
  await expect(page.locator('#own-main')).toBeVisible();
  await page.locator('#owntab-setup').click();
  await page.locator('#ownpane-setup a[href="?mode=staffqr"]').click();
  await expect(page.locator('#v-staffqr')).toBeVisible();
  await expect(page.locator('#staff-qr-pages .staff-sheet')).toHaveCount(46);
  await expect(page.locator('#btn-staff-print')).toBeEnabled({ timeout: 20000 });
}
const pages = buf => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

test('専用QR：探さず担当1件に入り、保存済みの別担当・受付タブに影響されず、正しい部屋IDで送信する', async ({ page }) => {
  const errors = watchErrors(page), log = await mockGas(page, { verifyOk: true });
  await page.addInitScript(() => {
    localStorage.setItem('kuroko_assigned_v2', JSON.stringify(['1F-05', '2F-12']));
    localStorage.setItem('kuroko_adm_tab', 'recept');
  });
  await page.goto('/?mode=admin&staffBooth=1F-02&openExternalBrowser=1');
  await expect(page.locator('#auth-booth')).toContainText('旋盤の加工実演');
  await expect(page.locator('#v-admin')).toBeVisible();
  await expect(page.locator('#auth-name-entry')).toBeHidden();
  expect(log.posts.find(p=>p.action==='staff_enter').who).toMatch(/^QR 1F-02 · [A-Z0-9]{4}$/);
  await expect(page.locator('#admpane-update')).toBeVisible();
  await expect(page.locator('#admin-list .adm-booth')).toHaveCount(1);
  const card = page.locator('#admin-list .adm-booth');
  await expect(card).toHaveAttribute('data-id', '1F-02');
  await expect(page.locator('#assign-q')).toBeHidden();
  await expect(page.locator('#assign-chips button')).toHaveCount(0);
  const before = Number(await card.locator('.adm-wait-n').textContent());
  await card.locator('[data-step="1"]').click();
  await card.locator('.send').click();
  await expect.poll(() => log.posts.filter(x => x.id === '1F-02' && x.wait === before + 1).length).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_assigned_v2')))).toEqual(['1F-05', '2F-12']);
  expect(await page.evaluate(() => [...S.stamps])).toEqual([]);
  expect(errors).toEqual([]);
});

test('専用QR：ログイン済みでも読み直したブース1件へ切り替わり、再読み込みと戻るでも担当が残る', async ({ page }) => {
  await mockGas(page, { verifyOk: true });
  await page.goto('/?mode=admin&staffBooth=1F-02');
  await login(page);
  await page.goto('/?mode=admin&staffBooth=1F-05');
  await expect(page.locator('#v-admin')).toBeVisible();
  await expect(page.locator('#admin-list .adm-booth')).toHaveCount(1);
  await expect(page.locator('#admin-list .adm-booth')).toHaveAttribute('data-id', '1F-05');
  await page.reload();
  await expect(page.locator('#admin-list .adm-booth')).toHaveCount(1);
  await expect(page.locator('#admin-list .adm-booth')).toHaveAttribute('data-id', '1F-05');
  await page.evaluate(() => { switchView('map'); });
  await page.goBack();
  await expect(page.locator('#admin-list .adm-booth')).toHaveCount(1);
  await expect(page.locator('#admin-list .adm-booth')).toHaveAttribute('data-id', '1F-05');
});

test('専用QR：不明・空の部屋IDでは別のブースを出さず、本部へ確認を案内する', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page, { verifyOk: true });
  for (const id of ['', '<img src=x onerror=alert(1)>']) {
    await page.goto('/?mode=admin&staffBooth=' + encodeURIComponent(id));
    if (await page.locator('#v-auth').isVisible()) await login(page);
    await expect(page.locator('#adm-booth-target')).toContainText('見つかりません');
    await expect(page.locator('#admin-list .adm-booth')).toHaveCount(0);
    await expect(page.locator('#adm-booth-target img')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('専用QR：ブース一覧の到着がログインより遅れても、対象1件だけが開く', async ({ page }) => {
  await mockGas(page, { verifyOk: true });
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    if (route.request().method() === 'GET') await new Promise(r => setTimeout(r, 1100));
    await route.fallback();
  });
  await page.goto('/?mode=admin&staffBooth=1F-02');
  await login(page);
  await expect(page.locator('#admin-list .adm-booth')).toHaveCount(1);
  await expect(page.locator('#admin-list .adm-booth')).toHaveAttribute('data-id', '1F-02');
});

test('専用QR：端末の許可待ちから本部が許可したあとも、自分のブースだけを表示する', async ({ page }) => {
  const g = await bridge(page);
  const call = body => JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  const token = call({ action: 'owner_login', opass: OWNER }).token;
  expect(call({ action: 'owner_mode', token, on: true }).ok).toBe(true);
  await page.goto('/?mode=admin&staffBooth=1F-02');

  await enterStaff(page);
  await expect(page.locator('#auth-wait')).toBeVisible();
  const state = call({ action: 'owner_state', token });
  const pending = state.devices.find(d => d.st === 'wait');
  expect(pending).toBeTruthy();
  expect(call({ action: 'owner_dev', token, cid: pending.cid, st: 'ok' }).ok).toBe(true);
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#admin-list .adm-booth')).toHaveCount(1);
  await expect(page.locator('#admin-list .adm-booth')).toHaveAttribute('data-id', '1F-02');
});

test('印刷への入口：司令塔の準備に置き、係員のパスワードだけでは印刷画面に入れない', async ({ page }) => {
  await bridge(page);
  await page.goto('/?mode=admin');
  await login(page);
  await expect(page.locator('#v-admin a[href="?mode=staffqr"]')).toHaveCount(0);
  await page.goto('/?mode=staffqr');
  await expect(page.locator('#own-gate')).toBeVisible();
  await expect(page.locator('#v-staffqr')).toBeHidden();
  await page.locator('#own-pw').fill(OWNER);
  await page.locator('#own-login').click();
  await expect(page.locator('#v-staffqr')).toBeVisible();
  await expect(page.locator('#staff-back-btn')).toHaveText('← 司令塔');
});

test('印刷QR：全46枚を読み取り、公式URL・担当IDだけを含み、パスワード・スタンプの引数を含まない', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', '印刷の全件検証はPCで実行');
  await ownerPrint(page);
  const r = await page.evaluate(async () => {
    const ids = [], bad = [];
    for (const card of document.querySelectorAll('.staff-sheet')) {
      const svg = card.querySelector('svg').outerHTML;
      const im = await new Promise(resolve => { const i = new Image(); i.onload = () => resolve(i); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const c = document.createElement('canvas'); c.width = c.height = 320;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 320, 320); x.drawImage(im, 40, 40, 240, 240);
      const decoded = QR.scanImageData(x.getImageData(0, 0, 320, 320));
      if (!decoded) { bad.push(card.dataset.staffId); continue; }
      const u = new URL(decoded);
      if (u.origin !== 'https://ma222222-source.github.io' || u.pathname !== '/bunnkasai/' || u.searchParams.get('mode') !== 'admin' || u.searchParams.get('openExternalBrowser') !== '1' || u.searchParams.size !== 3) bad.push(decoded);
      if (u.searchParams.get('staffBooth') !== card.dataset.staffId) bad.push('担当違い');
      ids.push(u.searchParams.get('staffBooth'));
    }
    return { ids, bad, expected: S.booths.map(b => b.id) };
  });
  expect(r.bad).toEqual([]);
  expect(r.ids.sort()).toEqual(r.expected.sort());
  await expect(page.locator('#staff-qr-pages')).not.toContainText(PASS);
  await expect(page.locator('#staff-qr-pages')).not.toContainText(OWNER);
});

test('A4印刷：46ブースが46ページに収まり、QR48mm・切れやはみ出しなし。1ブースだけなら1ページ', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'PDFはChromiumで生成');
  await ownerPrint(page);
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 718, height: 1047 });
  const over = await page.evaluate(() => [...document.querySelectorAll('.staff-sheet')].filter(c => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map(c => c.dataset.staffId));
  expect(over).toEqual([]);
  const minQrMm = await page.evaluate(() => Math.min(...[...document.querySelectorAll('.staff-sheet-qr svg')].map(s => s.getBoundingClientRect().width / (96 / 25.4))));
  expect(minQrMm).toBeGreaterThanOrEqual(47.9);
  const all = await page.pdf({ format: 'A4', printBackground: true });
  expect(pages(all)).toBe(46);
  await page.emulateMedia({ media: 'screen' });
  await page.locator('#staff-print-select').selectOption('1F-02');
  await expect(page.locator('.staff-sheet')).toHaveCount(1);
  await expect(page.locator('#btn-staff-print')).toBeEnabled();
  await page.evaluate(() => { window.print = () => { window.__staffPrint = true; }; });
  await page.locator('#btn-staff-print').click();
  expect(await page.evaluate(() => window.__staffPrint)).toBe(true);
  await page.emulateMedia({ media: 'print' });
  const one = await page.pdf({ format: 'A4', printBackground: true });
  expect(pages(one)).toBe(1);
  await page.emulateMedia({ media: 'screen' });
  await page.locator('#staff-print-select').selectOption('');
  await expect(page.locator('.staff-sheet')).toHaveCount(46);
});
