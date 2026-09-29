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

for (const m of ['print', 'board', 'check']) {
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
  await page.locator('#pw').fill('test-password-1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await ready(page);
  for (const tab of ['update', 'recept', 'hq', 'setup']) {
    await page.locator(`[data-tab="${tab}"]`).first().click();
    await page.waitForTimeout(300);
  }
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
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
});
