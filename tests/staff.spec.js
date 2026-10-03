// 係員コンソール：少ない操作で更新でき、送ったものが正しい形で GAS に届く。送れなかったら端末に残して再送する
const { test, expect } = require('@playwright/test');
const { mockGas, watchErrors } = require('./mock');

async function login(page, opt = {}) {
  const log = await mockGas(page, { verifyOk: true, ...opt });
  // 既定は「科・場所ごと」（閉じたまとめ）。カードを直接押すテストは「古い順（全部）」で見る
  if (!opt.grouped) await page.addInitScript(() => localStorage.setItem('kuroko_adm_mode', JSON.stringify('flat')));
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

test('更新の画面：科・場所ごとにまとまり、開くとカードが出る。開いた状態は自動同期・開き直しでも残る', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, { grouped: true });
  await page.locator('#adm-mode [data-m="dept"]').click();          // 科ごとで確かめる（既定は階ごと）
  const grps = page.locator('#admin-list .adm-grp');
  await expect.poll(() => grps.count()).toBeGreaterThan(5);
  // はじめは全部閉じている（46件が一度に並ばない）
  await expect(page.locator('#admin-list .adm-booth:visible')).toHaveCount(0);
  await expect(grps.first().locator('.g-n')).toContainText('件');
  const second = grps.nth(1);
  const key = await second.getAttribute('data-g');
  await second.locator('summary').click();
  await expect(second.locator('.adm-booth').first()).toBeVisible();
  const n = await second.locator('.adm-booth').count();
  expect(n).toBeGreaterThan(0);
  // 自動同期（描き直し）でも閉じない
  await page.evaluate(() => renderAdmin());
  await expect(page.locator(`.adm-grp[data-g="${key}"]`)).toHaveAttribute('open', '');
  // 開き直しても開いたまま
  await page.reload();
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator(`.adm-grp[data-g="${key}"]`)).toHaveAttribute('open', '', { timeout: 10000 });
  // 「古い順（全部）」に切り替えるとまとめずに並ぶ
  await page.locator('#adm-mode [data-m="flat"]').click();
  await expect(page.locator('#admin-list .adm-grp')).toHaveCount(0);
  await expect(page.locator('#admin-list > .adm-booth')).toHaveCount(46);
  expect(errors).toEqual([]);
});

test('担当ブースえらび：科・場所を押すとそのブースが開き、「ぜんぶ」で科ごと担当にできる', async ({ page }) => {
  await login(page, { grouped: true });
  const g = page.locator('#assign-chips .as-grp').nth(2);
  await expect(page.locator('#assign-chips .as-chip')).toHaveCount(0);          // はじめはブースを並べない
  await g.click();
  await expect(page.locator('#assign-chips .as-sub .as-chip').first()).toBeVisible();
  const n = await page.locator('#assign-chips .as-sub .as-chip').count();
  await page.locator('#assign-chips [data-asall]').click();
  expect(await page.evaluate(() => S.assigned.size)).toBe(n);
  // 担当が数件なら、まとめずにそのカードだけ並ぶ
  await expect(page.locator('#admin-list > .adm-booth')).toHaveCount(n);
  // 検索するとブースがそのまま出る
  await page.locator('#assign-chips [data-as="__all"]').click();
  await page.locator('#assign-q').fill('旋盤');
  await page.locator('#assign-q').dispatchEvent('input');
  await expect(page.locator('#assign-chips .as-chip').first()).toContainText('旋盤');
});

test('まとめ方：既定は「階ごと」（中は科の小見出し）、「科ごと」に切り替えられ、選んだ方を覚える', async ({ page }) => {
  await login(page, { grouped: true });
  const labels = () => page.locator('#admin-list .adm-grp .g-nm').allTextContents();
  await expect.poll(labels).toEqual(expect.arrayContaining(['1階', '2階', '3階']));
  const g1 = page.locator('#admin-list .adm-grp').first();
  await g1.locator('summary').click();
  await expect(g1.locator('.adm-sub').first()).toBeVisible();                 // 階の中は科で区切る
  expect(await g1.locator('.adm-sub').count()).toBeGreaterThan(1);
  // 担当えらびも階で出る
  await expect(page.locator('#assign-chips .as-grp').first()).toContainText('1階');
  // 科ごとへ
  await page.locator('#adm-mode [data-m="dept"]').click();
  await expect.poll(labels).toEqual(expect.arrayContaining(['電子機械科', '機械科', '電子科']));
  await expect(page.locator('#admin-list .adm-sub')).toHaveCount(0);
  await expect(page.locator('#assign-chips .as-grp').first()).toContainText('科');
  await page.reload();
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('#adm-mode [data-m="dept"]')).toHaveAttribute('aria-pressed', 'true');
});

test('係員カード：人数を変えると「送ると：やや混雑・およそ◯分待ち」がその場で出る', async ({ page }) => {
  await login(page);
  const card = page.locator('#admin-list .adm-booth').first();
  for (let i = 0; i < 6; i++) await card.locator('[data-step="1"]').click();
  await expect(card.locator('.adm-preview')).toContainText('送ると：');
  const n = Number(await card.locator('.adm-wait-n').textContent());
  const th = await page.evaluate(() => S.waitTh);
  const expectLv = n >= th.busy ? '混雑' : n >= th.warn ? 'やや混雑' : '空き';
  await expect(card.locator('.adm-preview')).toContainText(expectLv);
});

test('本部：お知らせのひな形を押すと欄に入る（そのまま出さない）', async ({ page }) => {
  const log = await login(page);
  await page.locator('[data-tab="hq"]').first().click();
  await page.locator('#notice-card > summary').click();              // お知らせの欄は畳んである
  await page.locator('#notice-tpl [data-tpl]').first().click();
  await expect(page.locator('#notice-text')).toHaveValue(/落とし物/);
  expect(log.posts.filter(p => p.action === 'notice').length).toBe(0);
});

test('本部「更新が止まっているブース」：長い順に出て、押すとそのブースの更新カードへ', async ({ page }) => {
  await login(page, { grouped: true });
  await page.locator('[data-tab="hq"]').first().click();
  const items = page.locator('#stale-list [data-goto]');
  await expect.poll(() => items.count()).toBeGreaterThan(0);
  const id = await items.first().getAttribute('data-goto');
  await items.first().click();
  await expect(page.locator('#admpane-update')).toBeVisible();
  await expect(page.locator(`#admin-list .adm-booth[data-id="${id}"]`)).toBeVisible();
});
