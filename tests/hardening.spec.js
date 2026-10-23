const { fillStaffName, enterStaff } = require('./staff-name-helper');
// 本番の事故を防ぐためのテスト：悪い文字列（XSS）、小さいブースの押しやすさ、電波が切れたとき
const { test, expect } = require('@playwright/test');
const { mockGas, watchErrors } = require('./mock');

async function ready(page) {
  await expect.poll(() => page.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);
}

/* ---------- XSS：シートに悪い文字列が入っても、画面でスクリプトとして動かない ---------- */
const EVIL = '<img src=x onerror="window.__xss=(window.__xss||0)+1"><script>window.__xss=99</script>';
function poison(j) {
  j.notice = { text: EVIL, level: 'alert' };
  j.booths.forEach((b, i) => {
    if (i % 3 === 0) b.name = b.name + EVIL;
    if (i % 3 === 1) b.note = EVIL + '"><svg onload="window.__xss=1">';
    if (i % 5 === 0) b.category = '展示' + EVIL;
    if (i % 7 === 0) b.image = 'javascript:window.__xss=7';
    if (i % 11 === 0) b.dept = '"><b onmouseover=window.__xss=1>';
  });
}

test('XSS：ブース名・メモ・分類・画像・お知らせに悪い文字列が入っても動かない（来場者の画面）', async ({ page }) => {
  await mockGas(page, { mutate: poison });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const t of ['map', 'list', 'stamp', 'info']) {
    await page.goto('/?tab=' + t);
    await ready(page);
    await page.waitForTimeout(300);
  }
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#booth-list .booth').first().click();
  await expect(page.locator('#bsh')).toBeVisible();
  await page.locator('#q').fill('img');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

for (const m of ['print', 'pamphlet', 'board', 'check']) {
  test(`XSS：?mode=${m} でも動かない`, async ({ page }) => {
    await mockGas(page, { mutate: poison });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/?mode=' + m);
    await ready(page);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
}

test('XSS：係員コンソール（ログイン後）でも動かない', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page, { mutate: poison, verifyOk: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?mode=admin');

  await enterStaff(page);
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await ready(page);
  for (const tab of ['update', 'recept']) {
    await page.locator(`[data-tab="${tab}"]`).first().click();
    await page.waitForTimeout(300);
  }
  // v219：本部・準備は司令塔へ移った。司令塔の5枚も、悪い文字列（ブースの名前・端末の名前・パスキーの名前・イベントの見出し）で見る
  const bad = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  const st = { ok: true, approval: true, passLen: 18, passAt: '', sv: '2026-10-14b',
    devices: [{ cid: 'devaaaaaaaaaaaa01', st: 'wait', code: 'AB12', label: bad, last: new Date().toISOString() }],
    keys: [{ id: 'k1', label: bad, at: new Date().toISOString() }],
    live: { show: { id: 's1', title: bad, text: bad, at: Date.now(), until: Date.now() + 60000 },
      lucky: { id: 'l1', booth: '1F-02', at: Date.now(), until: Date.now() + 60000 },
      draw: { id: 'd1', at: Date.now(), until: Date.now() + 60000, min: 3, elig: 2, winners: [{ cid: bad, stamps: 3 }] } } };
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    if (/"action":"owner_/.test(route.request().postData() || '')) {
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json',
        body: JSON.stringify(Object.assign({ token: 'a'.repeat(64), state: st }, st)) });
    }
    return route.fallback();
  });
  await page.evaluate(() => { sessionStorage.setItem('kuroko_owner', 'a'.repeat(64)); return openOwner(); });
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  for (const tab of ['home', 'event', 'hq', 'staff', 'setup']) {
    await page.locator('#owntab-' + tab).click();
    await page.waitForTimeout(300);
  }
  await expect(page.locator('#own-draw-res li')).toHaveCount(1);        // 当たりの一覧まで描いている
  // 来場者むけの演出も、悪い文字列で
  await page.evaluate(([t]) => showLiveFx('show', t, t, true), [bad]);
  await expect(page.locator('#lfx .lfx-title')).toHaveText(bad);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.evaluate(() => document.querySelectorAll('#own-main img, #lfx img, #own-main script, #lfx script').length)).toBe(0);
  expect(errors).toEqual([]);
});

/* ---------- 地図：小さいブースの近くを押しても開く ---------- */
test('地図：小さいブースのすぐ外を押しても、そのブースが開く', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-1').click();
  await page.waitForTimeout(500);
  // いちばん小さいブースを選び、その左6pxの点（ほかの部屋に入っていない所）を押す
  const pick = await page.evaluate(() => {
    const rooms = [...document.querySelectorAll('#plan-1 .room[data-id]')].map(g => ({ g, r: g.getBoundingClientRect() }))
      .filter(x => x.r.width > 0);
    rooms.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
    for (const { g, r } of rooms) {
      for (const [x, y] of [[r.left - 6, r.top + r.height / 2], [r.right + 6, r.top + r.height / 2],
                            [r.left + r.width / 2, r.top - 6], [r.left + r.width / 2, r.bottom + 6]]) {
        if (x < 5 || y < 5 || x > innerWidth - 5 || y > innerHeight - 90) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || !el.closest('#map-view, .map-view, #plan-1') || el.closest('.room[data-id]')) continue;
        // ほかのブースの方が近くないこと
        const near = rooms.filter(o => o.g !== g).some(o => {
          const dx = Math.max(o.r.left - x, 0, x - o.r.right), dy = Math.max(o.r.top - y, 0, y - o.r.bottom);
          return Math.hypot(dx, dy) <= 6;
        });
        if (near) continue;
        return { id: g.dataset.id, x, y, w: r.width, h: r.height };
      }
    }
    return null;
  });
  expect(pick, '押し試せる小さいブースが見つからない').not.toBeNull();
  await page.mouse.click(pick.x, pick.y);
  await expect(page.locator('#bsh')).toBeVisible();
  const name = await page.evaluate(id => S.booths.find(b => b.id === id).name, pick.id);
  await expect(page.locator('#bsh-nm')).toContainText(name.slice(0, 6));
});

test('地図：何もない所（ブースから遠い所）を押しても何も開かない', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-1').click();
  await page.waitForTimeout(500);
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#plan-1').getBoundingClientRect();
    const rooms = [...document.querySelectorAll('#plan-1 .room[data-id]')].map(g => g.getBoundingClientRect());
    for (let y = svg.top + 10; y < Math.min(svg.bottom, innerHeight - 100); y += 7) {
      for (let x = svg.left + 10; x < svg.right - 10; x += 7) {
        const far = rooms.every(r => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)) > 30);
        if (far) return { x, y };
      }
    }
    return null;
  });
  expect(pt).not.toBeNull();
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  await expect(page.locator('#bsh')).toBeHidden();
});

/* ---------- 電波が切れたとき（Service Worker を動かす） ---------- */
test.describe('オフライン（Service Worker あり）', () => {
  test.use({ serviceWorkers: 'allow' });
  test('一度開いたあとは、電波が切れても画面と最後の混雑情報が出る', async ({ page, context }) => {
    await mockGas(context);
    await page.goto('/?tab=list');
    await ready(page);
    // SW が画面を控えるまで待つ
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(async () => {
      const keys = await caches.keys();
      for (const k of keys) { if (await (await caches.open(k)).match('./index.html')) return true; }
      return false;
    }), { timeout: 15000 }).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#v-list')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
    await expect(page.locator('#booth-list .booth').first()).toBeVisible();
    await context.setOffline(false);
  });

  test('新しい版の SW は、配信の控えを通さずに（引数つきで）画面を取る', async ({ page, context }) => {
    await mockGas(context);
    const shellReqs = [];
    context.on('request', r => { const u = new URL(r.url()); if (u.pathname.endsWith('/index.html') && u.searchParams.get('sw')) shellReqs.push(u.searchParams.get('sw')); });
    await page.goto('/?tab=map');
    await ready(page);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    // インストール時：版の名前つき
    const ver = await page.evaluate(() => fetch('sw.js').then(r => r.text()).then(t => t.match(/const CACHE = '([^']+)'/)[1]));
    await expect.poll(() => shellReqs).toContain(ver);
    // 開き直すと：1分ごとの引数つきで取り直す
    await page.reload();
    await expect.poll(() => shellReqs.some(t => /^m\d+$/.test(t)), { timeout: 10000 }).toBe(true);
  });
});

/* ---------------- v179 ---------------- */
test.describe('Service Worker：ほかのページ・アプリとして入れる条件（v179）', () => {
  test.use({ serviceWorkers: 'allow' });

  test('同じ場所の別のページ（.html）を、マップの画面で置き換えない', async ({ page, context }) => {
    await mockGas(context);
    await page.goto('/?tab=map');
    await ready(page);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15000 }).toBe(true);
    await page.goto('/tests/fixtures/other-page.html');
    await expect(page.locator('#other')).toHaveText('別のページ');
    expect(await page.title()).toContain('別のページ');
    // マップ本体は今まで通り（引数つきでも本体として出る）
    await page.goto('/index.html?tab=list');
    await ready(page);
    await expect(page.locator('#v-list')).toBeVisible();
  });

  test('ブラウザ（Chromium）の判定で、ホーム画面に追加できる条件を満たしている', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium の判定を使う');
    await mockGas(context);
    await page.goto('/index.html');
    await ready(page);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    const c = await context.newCDPSession(page);
    const m = await c.send('Page.getAppManifest');
    expect(m.url).toContain('manifest-app.json');
    expect(m.errors).toEqual([]);
    await expect.poll(async () => (await c.send('Page.getInstallabilityErrors')).installabilityErrors, { timeout: 15000 }).toEqual([]);
  });
});
