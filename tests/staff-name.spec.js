const { test, expect } = require('@playwright/test');
const { loadGas } = require('./gas-mock');
const { watchErrors } = require('./mock');
const PASS = 'staff-name-test-1234', OWNER = 'owner-name-test-1234';

async function server(context, approval = false) {
  const g = loadGas({ props: { ADMIN_PASS: PASS, OWNER_PASS: OWNER } }), posts = [];
  g.setupR8AndArchiveOthers();
  if (approval) g.approvalSave_(true, 1);
  await context.route(/script\.google(usercontent)?\.com\//, async route => {
    const request = route.request();
    let text;
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}'); posts.push(body);
      text = g.doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
    } else text = g.doGet({ parameter: Object.fromEntries(new URL(request.url()).searchParams) }).getContent();
    await route.fulfill({ contentType: 'application/json', body: text });
  });
  return { g, posts };
}
async function owner(context) {
  const page = await context.newPage();
  await page.goto('/?mode=owner');
  await page.locator('#own-pw').fill(OWNER);
  await page.locator('#own-login').click();
  await expect(page.locator('#own-main')).toBeVisible();
  await page.locator('#owntab-staff').click();
  return page;
}

test('名前登録：空欄では送信せず、パスワードが違う場合は名前を保存しない', async ({ page, context }) => {
  const errors = watchErrors(page), { posts } = await server(context);
  await page.goto('/?mode=admin');
  await page.locator('#pw').fill('wrong-password');
  await page.locator('#btn-login').click();
  await expect(page.locator('#auth-err')).toContainText('お名前');
  await expect(page.locator('#auth-who')).toBeFocused();
  expect(posts.filter(p => p.action === 'verify')).toHaveLength(0);
  await page.locator('#auth-who').fill('   ');
  await page.locator('#btn-login').click();
  expect(posts.filter(p => p.action === 'verify')).toHaveLength(0);
  await page.locator('#auth-who').fill('受付 山田');
  await page.locator('#btn-login').click();
  await expect(page.locator('#auth-err')).toContainText('パスワードが違います');
  expect(await page.evaluate(() => localStorage.getItem('kuroko_staff_name'))).toBeNull();
  expect(errors).toEqual([]);
});

test('名前登録：初回の名前が司令塔に出て、再入室・別タブでも名前を聞き直さない', async ({ page, context }) => {
  const errors = watchErrors(page), { g, posts } = await server(context);
  await page.goto('/?mode=admin');
  await page.locator('#auth-who').fill('受付 山田');
  await page.locator('#pw').fill(PASS);
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible();
  expect(g.devList_()).toHaveLength(1);
  expect(g.devList_()[0].label).toBe('受付 山田');
  await page.locator('#btn-logout').click();
  const again = await context.newPage();
  await again.goto('/?mode=admin');
  await expect(again.locator('#auth-name-entry')).toBeHidden();
  await expect(again.locator('#auth-name-value')).toHaveText('受付 山田');
  await again.locator('#pw').fill(PASS);
  await again.locator('#btn-login').click();
  await expect(again.locator('#v-admin')).toBeVisible();
  await again.reload();
  await expect(again.locator('#v-admin')).toBeVisible();
  expect(g.devList_()).toHaveLength(1);
  expect(posts.filter(p => p.action === 'verify').every(p => p.who === '受付 山田')).toBe(true);
  const tower = await owner(context);
  await expect(tower.locator('#own-devs .od-label')).toHaveText('受付 山田');
  expect(errors).toEqual([]);
});

test('名前登録：許可待ちでも名前を保存し、再読み込み後は入力せず承認を待てる', async ({ page, context }) => {
  const errors = watchErrors(page);
  await server(context, true);
  await page.goto('/?mode=admin&staffBooth=1F-02');
  await page.locator('#auth-who').fill('機械科 佐藤');
  await page.locator('#pw').fill(PASS);
  await page.locator('#btn-login').click();
  await expect(page.locator('#auth-wait')).toBeVisible();
  await page.reload();
  await expect(page.locator('#auth-name-entry')).toBeHidden();
  await expect(page.locator('#auth-name-value')).toHaveText('機械科 佐藤');
  await page.locator('#pw').fill(PASS);
  await page.locator('#btn-login').click();
  await expect(page.locator('#auth-wait')).toBeVisible();
  const tower = await owner(context);
  await expect(tower.locator('#own-devs .od-label')).toHaveText('機械科 佐藤');
  await tower.locator('#own-devs [data-dev="ok"]').click();
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#adm-booth-target')).toContainText('旋盤');
  expect(errors).toEqual([]);
});

test('名前登録：以前からログイン中の名前なし端末は、名前だけ登録して入れる', async ({ page, context }) => {
  const errors = watchErrors(page), { g } = await server(context);
  await page.addInitScript(pass => sessionStorage.setItem('kuroko_pw', pass), PASS);
  await page.goto('/?mode=admin');
  await expect(page.locator('#auth-name-entry')).toBeVisible();
  await expect(page.locator('#auth-pw-row')).toBeHidden();
  await page.locator('#auth-who').fill('電子科 高橋');
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible();
  expect(g.devList_()[0].label).toBe('電子科 高橋');
  await page.reload();
  await expect(page.locator('#v-admin')).toBeVisible();
  expect(errors).toEqual([]);
});

test('名前登録：名前の保存が拒否されても入室でき、次回の再入力が必要と伝える', async ({ page, context }) => {
  const errors = watchErrors(page);
  await server(context);
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'kuroko_staff_name') throw new DOMException('blocked', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await page.goto('/?mode=admin');
  await page.locator('#auth-who').fill('受付 山田');
  await page.locator('#pw').fill(PASS);
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('名前を保存できません');
  expect(errors).toEqual([]);
});

test('名前登録：以前のパスワードが残る端末でも、現在のパスワードを入力し直せる', async ({ page, context }) => {
  const errors = watchErrors(page), { g } = await server(context);
  await page.addInitScript(() => sessionStorage.setItem('kuroko_pw', 'old-password-1234'));
  await page.goto('/?mode=admin');
  await expect(page.locator('#auth-pw-row')).toBeHidden();
  await page.locator('#auth-who').fill('電子科 高橋');
  await page.locator('#btn-login').click();
  await expect(page.locator('#auth-err')).toContainText('パスワードが違います');
  await expect(page.locator('#auth-pw-row')).toBeVisible();
  await expect(page.locator('#pw')).toBeFocused();
  expect(await page.evaluate(() => sessionStorage.getItem('kuroko_pw'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('kuroko_staff_name'))).toBeNull();
  await page.locator('#pw').fill(PASS);
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible();
  expect(g.devList_()[0].label).toBe('電子科 高橋');
  expect(errors).toEqual([]);
});
