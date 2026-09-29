// 係員コンソール：少ない操作で更新でき、送ったものが正しい形で GAS に届く。送れなかったら端末に残して再送する
const { test, expect } = require('@playwright/test');
const { mockGas, watchErrors } = require('./mock');

async function login(page, opt = {}) {
  const log = await mockGas(page, { verifyOk: true, ...opt });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?mode=admin');
  await page.locator('#pw').fill('test-password-1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  return log;
}
const updates = log => log.posts.filter(p => p.action === 'update' || p.action === 'upsert' || (!p.action && p.id) || p.updates || p.id);

test('待ち人数：＋5・＋1 → 送信 で、そのブースの人数が GAS に届く', async ({ page }) => {
  const errors = watchErrors(page);
  const log = await login(page);
  const card = page.locator('#admin-list .adm-booth').first();
  const id = await card.getAttribute('data-id');
  await card.locator('[data-step="5"]').click();
  await card.locator('[data-step="1"]').click();
  await expect(card.locator('.adm-wait-n')).toHaveText('6');
  await card.locator('.send').click();
  await expect.poll(() => JSON.stringify(log.posts), { timeout: 15000 }).toContain(id);
  const sent = log.posts.filter(p => JSON.stringify(p).includes(id));
  expect(JSON.stringify(sent)).toMatch(/"wait":6|"wait":"6"/);
  // パスワードは送るが、画面・URL には残さない
  expect(page.url()).not.toContain('test-password');
  expect(errors).toEqual([]);
});

test('混雑度：「混雑」を1回押すだけで送られる', async ({ page }) => {
  const log = await login(page);
  const card = page.locator('#admin-list .adm-booth').nth(1);
  const id = await card.getAttribute('data-id');
  const before = log.posts.length;
  await card.locator('.adm-btns [data-key="混雑しています"]').click();
  await expect.poll(() => log.posts.slice(before).some(p => JSON.stringify(p).includes(id) && JSON.stringify(p).includes('混雑しています')),
    { timeout: 15000 }).toBe(true);
});

test('送れなかった更新は端末に残り、電波が戻ると自動で送られる', async ({ page }) => {
  const log = await login(page, { failPosts: true });
  const card = page.locator('#admin-list .adm-booth').nth(2);
  const id = await card.getAttribute('data-id');
  await card.locator('.adm-btns [data-key="やや混雑"]').click();
  // 未送信として端末に残る
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kuroko_unsent') || ''), { timeout: 20000 }).toContain(id);
  // 復旧 → 再送されて未送信が空になる
  log.failPosts = false;
  const okBefore = log.posts.length;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kuroko_unsent') || ''), { timeout: 60000 }).not.toContain(id);
  expect(log.posts.slice(okBefore).some(p => JSON.stringify(p).includes(id))).toBe(true);
});
