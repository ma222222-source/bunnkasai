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

test('名前登録：パスワード欄がなく、空の名前は送信せず、名前だけで入れる',async({page,context})=>{
 const errors=watchErrors(page),{posts,g}=await server(context);await page.goto('/?mode=admin');await expect(page.locator('#auth-pw-row')).toBeHidden();
 await page.locator('#btn-login').click();await expect(page.locator('#auth-err')).toContainText('お名前');await expect(page.locator('#auth-who')).toBeFocused();expect(posts.filter(p=>p.action==='staff_enter')).toHaveLength(0);
 await page.locator('#auth-who').fill('   ');await page.locator('#btn-login').click();expect(posts.filter(p=>p.action==='staff_enter')).toHaveLength(0);
 await page.locator('#auth-who').fill('受付 山田');await page.locator('#btn-login').click();await expect(page.locator('#v-admin')).toBeVisible();expect(g.devList_()[0].label).toBe('受付 山田');expect(posts.filter(p=>p.action==='staff_enter').every(p=>!p.pass)).toBe(true);expect(errors).toEqual([]);
});

test('名前登録：初回の名前が司令塔に出て、再入室・別タブでも名前を聞き直さない', async ({ page, context }) => {
  const errors = watchErrors(page), { g, posts } = await server(context);
  await page.goto('/?mode=admin');
  await page.locator('#auth-who').fill('受付 山田');

  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible();
  expect(g.devList_()).toHaveLength(1);
  expect(g.devList_()[0].label).toBe('受付 山田');
  await page.locator('#btn-logout').click();
  const again = await context.newPage();
  await again.goto('/?mode=admin');
  await expect(again.locator('#auth-name-entry')).toBeHidden();
  await expect(again.locator('#auth-name-value')).toHaveText('受付 山田');


  await expect(again.locator('#v-admin')).toBeVisible();
  await again.reload();
  await expect(again.locator('#v-admin')).toBeVisible();
  expect(g.devList_()).toHaveLength(1);
  expect(posts.filter(p => p.action === 'staff_enter').every(p => p.who === '受付 山田')).toBe(true);
  const tower = await owner(context);
  await expect(tower.locator('#own-devs .od-label')).toHaveText('受付 山田');
  expect(errors).toEqual([]);
});

test('専用QR：登録済みの名前を保ち、再読み込み後も入力せず承認を待てる', async ({ page, context }) => {
  const errors = watchErrors(page);
  await server(context, true);
  await page.addInitScript(()=>localStorage.setItem('kuroko_staff_name',JSON.stringify('機械科 佐藤')));
  await page.goto('/?mode=admin&staffBooth=1F-02');
  await expect(page.locator('#auth-wait')).toBeVisible();
  await page.reload();
  await expect(page.locator('#auth-wait')).toBeVisible();
  await expect(page.locator('#auth-name-entry')).toBeHidden();
  await expect(page.locator('#auth-name-value')).toHaveText('機械科 佐藤');
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

  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('名前を保存できません');
  expect(errors).toEqual([]);
});

test('名前登録：以前のパスワードが残る端末も、名前だけで新しい入室に切り替わる',async({page,context})=>{
 const errors=watchErrors(page),{g,posts}=await server(context);await page.addInitScript(()=>sessionStorage.setItem('kuroko_pw','old-password-1234'));await page.goto('/?mode=admin');await expect(page.locator('#auth-pw-row')).toBeHidden();await page.locator('#auth-who').fill('電子科 高橋');await page.locator('#btn-login').click();await expect(page.locator('#v-admin')).toBeVisible();expect(await page.evaluate(()=>sessionStorage.getItem('kuroko_pw'))).toMatch(/^staff_[a-f0-9]{64}$/);expect(g.devList_()[0].label).toBe('電子科 高橋');expect(posts.filter(p=>p.action==='staff_enter').every(p=>!p.pass)).toBe(true);expect(errors).toEqual([]);
});

test('入室の期限切れ：名前の再入力なしで入室を取り直し、更新を1回だけ確定する',async({page,context})=>{
 const {g,posts}=await server(context);await page.goto('/?mode=admin&staffBooth=1F-02');await expect(page.locator('#v-admin')).toBeVisible();const token=await page.evaluate(()=>pw());g.__cache.delete(g.staffSessionKey_(token));const c=page.locator('#admin-list .adm-booth');const before=Number(await c.locator('.adm-wait-n').textContent());await c.locator('[data-step="1"]').click();await c.locator('.send').click();await expect.poll(()=>g.__get().booths.find(b=>b.id==='1F-02').wait).toBe(before+1);expect(posts.filter(p=>p.action==='staff_enter')).toHaveLength(2);expect(posts.filter(p=>p.action==='update')).toHaveLength(2);expect(await page.evaluate(()=>pw())).not.toBe(token);await expect(page.locator('#v-admin')).toBeVisible();
});

test('専用QR：初回も入力・クリックなしで開き、別の専用QRの担当だけ切り替える',async({page,context})=>{
 const {g,posts}=await server(context);await page.goto('/?mode=admin&staffBooth=1F-02');await expect(page.locator('#v-admin')).toBeVisible();await expect(page.locator('#auth-name-entry')).toBeHidden();const who=g.devList_()[0].label;expect(who).toMatch(/^QR 1F-02 · [A-Z0-9]{4}$/);expect(await page.evaluate(()=>loadStr('kuroko_staff_name'))).toBeNull();await page.goto('/?mode=admin&staffBooth=1F-05');await expect(page.locator('#admin-list .adm-booth')).toHaveAttribute('data-id','1F-05');expect(g.devList_()[0].label).toBe(who);expect(await page.evaluate(()=>staffName())).toBe(who.replace('1F-02','1F-05'));expect(posts.filter(p=>p.action==='staff_enter').at(-1).who).toBe(who.replace('1F-02','1F-05'));expect(g.devList_()).toHaveLength(1);expect(posts.filter(p=>p.action==='staff_enter').every(p=>!p.pass)).toBe(true);const tower=await owner(context);await expect(tower.locator('#own-devs .od-label')).toHaveText(who);
});

test('専用QR：名前を保存できない端末でも入力を求めず、停止された端末は通さない',async({page,context})=>{
 const {g,posts}=await server(context);await page.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='kuroko_staff_name')throw Error('denied');return set.call(this,k,v)}});await page.goto('/?mode=admin&staffBooth=1F-02');await expect(page.locator('#v-admin')).toBeVisible();const cid=posts.find(p=>p.action==='staff_enter').cid;const token=g.__post({action:'owner_login',opass:OWNER}).token;expect(g.__post({action:'owner_dev',token,cid,st:'no'}).ok).toBe(true);await page.reload();await expect(page.locator('#v-admin')).toBeHidden();await expect(page.locator('#auth-err')).toContainText('本部');await expect(page.locator('#auth-name-entry')).toBeHidden();
});
