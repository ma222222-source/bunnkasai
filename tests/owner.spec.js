// 司令塔（持ち主だけ）の画面テスト（v216）。
// サーバーは模擬の返事ではなく、Code.gs をそのまま動かす（tests/gas-mock.js）。画面 → 通信 → Code.gs の確かめ、までを通しで見る。
// パスキー（顔認証・指紋）は、Chromium の「仮の認証器」（CDP の WebAuthn）で本物と同じ署名を作らせる。
// パスキーは 127.0.0.1 のような数字のアドレスでは使えないので、同じサーバーを localhost で開く。
// ここに出てくるパスワードは、どれもテスト用（本物ではない）
const { test, expect } = require('@playwright/test');
const { loadGas } = require('./gas-mock');
const { watchErrors } = require('./mock');

const PASS = 'test-password-1234';
const OWNER = 'owner-himitsu-123456';

/** Code.gs を動かす環境（46ブース入り）と、画面を開くアドレス */
function server(baseURL, props) {
  const origin = baseURL.replace('127.0.0.1', 'localhost');
  const g = loadGas({ props: Object.assign({ ADMIN_PASS: PASS, OWNER_PASS: OWNER, OWNER_ORIGINS: origin }, props || {}) });
  g.setupR8AndArchiveOthers();
  return { g, origin };
}
/** 画面からの通信を、Code.gs（g）へつなぐ */
async function bridge(target, g) {
  await target.route(/script\.google(usercontent)?\.com\//, async route => {
    const req = route.request();
    const headers = { 'access-control-allow-origin': '*' };
    let body;
    if (req.method() === 'POST') body = g.doPost({ postData: { contents: req.postData() || '{}' } }).getContent();
    else body = g.doGet({ parameter: Object.fromEntries(new URL(req.url()).searchParams) }).getContent();
    return route.fulfill({ status: 200, headers, contentType: 'application/json', body });
  });
}
/** 新しい端末（別の保存領域）で画面を開く */
async function device(browser, g) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await bridge(ctx, g);
  const page = await ctx.newPage();
  return { ctx, page };
}
async function staffLogin(page, origin, pass) {
  await page.goto(origin + '/?mode=admin');
  await page.locator('#pw').fill(pass);
  await page.locator('#btn-login').click();
}
/** 司令塔に入る。tab：入ったあとに開く画面（係員＝パスワードと端末。'' なら、はじめの「ようす」のまま） */
async function ownerLogin(page, origin, tab = 'staff') {
  await page.goto(origin + '/?mode=owner');
  await page.locator('#own-pw').fill(OWNER);
  await page.locator('#own-login').click();
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  if (tab) await page.locator('#owntab-' + tab).click();
}
const accept = page => page.once('dialog', d => d.accept());

test('司令塔：持ち主パスワードが決まっていないあいだは入れない（何をすればよいかを出す）。係員の入り方は今までどおり', async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL, { OWNER_PASS: '' });
  await bridge(page, g);
  await page.goto(origin + '/?mode=owner');
  await expect(page.locator('#v-owner')).toBeVisible();
  await expect(page.locator('#own-setup')).toContainText('OWNER_PASS');
  await expect(page.locator('#own-passkey')).toBeDisabled();
  await page.locator('#own-pw').fill('nanika-nagai-pass-1');
  await page.locator('#own-login').click();
  await expect(page.locator('#own-err')).toContainText('OWNER_PASS');
  await expect(page.locator('#own-main')).toBeHidden();
  // 係員は、今までどおり入れる
  await staffLogin(page, origin, PASS);
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  // 係員の画面の下から、司令塔を開ける
  await page.locator('#btn-open-owner').click();
  await expect(page.locator('#v-owner')).toBeVisible();
  expect(errors).toEqual([]);
});

test('司令塔：持ち主パスワードで入り、係員のパスワードを変える。変えた瞬間から、古いパスワードでは入れない', async ({ page, browser, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  await page.goto(origin + '/?mode=owner');
  // 係員のパスワードでは入れない
  await page.locator('#own-pw').fill(PASS);
  await page.locator('#own-login').click();
  await expect(page.locator('#own-err')).toContainText('入れませんでした');
  await expect(page.locator('#own-main')).toBeHidden();
  // 持ち主パスワードで入る。欄は空に戻る。パスワードそのものは画面のどこにも出ない
  await page.locator('#own-pw').fill(OWNER);
  await page.locator('#own-pw').press('Enter');
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#own-gate')).toBeHidden();
  await page.locator('#owntab-staff').click();
  await expect(page.locator('#own-pass-now')).toContainText(PASS.length + '文字');
  expect(await page.locator('#own-pw').inputValue()).toBe('');
  expect(await page.evaluate(([a, b]) => document.body.innerText.includes(a) || document.body.innerText.includes(b), [PASS, OWNER])).toBe(false);
  // 2つの欄が違う → 変えない
  const NEW = 'atarashii-pass-2026';
  await page.locator('#own-np').fill(NEW);
  await page.locator('#own-np2').fill(NEW + 'x');
  await page.locator('#own-setpass').click();
  await expect(page.locator('#toast')).toContainText('同じではありません');
  expect(g.__props.ADMIN_PASS).toBe(PASS);
  // そろえて、確かめの窓で「はい」→ 変わる
  await page.locator('#own-np2').fill(NEW);
  accept(page);
  await page.locator('#own-setpass').click();
  await expect(page.locator('#toast')).toContainText('変えました');
  await expect(page.locator('#own-pass-now')).toContainText(NEW.length + '文字');
  expect(g.__props.ADMIN_PASS).toBe(NEW);
  expect(await page.locator('#own-np').inputValue()).toBe('');
  // 別の端末の係員：古いパスワードは通らない。新しいパスワードで入れる
  const d = await device(browser, g);
  await staffLogin(d.page, origin, PASS);
  await expect(d.page.locator('#auth-err')).toContainText('パスワードが違います');
  await d.page.locator('#pw').fill(NEW);
  await d.page.locator('#btn-login').click();
  await expect(d.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await d.ctx.close();
  // 開き直しても、入ったまま（このタブの中だけ覚えている）。出ると、入口に戻る
  await page.reload();
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  await page.locator('#own-logout').click();
  await expect(page.locator('#own-gate')).toBeVisible();
  await expect(page.locator('#own-main')).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem('kuroko_owner'))).toBeNull();
  expect(errors).toEqual([]);
});

test('司令塔：入れる端末を決める。「許可した端末だけ」にすると、新しい端末は番号を出して待ち、許可すると自動で入る。止めると使えなくなる', async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  // 端末A：いままでどおり入っている係員
  const A = await device(browser, g);
  await staffLogin(A.page, origin, PASS);
  await expect(A.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  // 持ち主：一覧に A が出ている（切のあいだは「入れます」）
  await ownerLogin(page, origin);
  await expect(page.locator('#own-devs .own-dev')).toHaveCount(1);
  await expect(page.locator('#own-devs .own-dev .od-st')).toHaveText('入れます');
  await expect(page.locator('#own-dev-sum')).toHaveText('1台：入れます 1');          // v217：端末の数のまとめ
  await expect(page.locator('#own-mode-off')).toHaveAttribute('aria-pressed', 'true');
  // 「許可した端末だけ」に。いま入っている A は、そのまま入れる
  accept(page);
  await page.locator('#own-mode-on').click();
  await expect(page.locator('#own-mode-on')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#own-devs .own-dev .od-st')).toHaveText('許可しています');
  await expect(page.locator('#own-dev-sum')).toHaveText('1台：許可しています 1');
  await A.page.evaluate(() => localStorage.setItem('kuroko_adm_mode', JSON.stringify('flat')));
  await A.page.reload();
  await expect(A.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await A.page.locator('.seg button', { hasText: '古い順' }).click();
  const cardA = A.page.locator('#admin-list .adm-booth').first();
  await cardA.locator('[data-step="5"]').click();
  await cardA.locator('.send').click();
  await expect(A.page.locator('#toast')).toContainText('→');
  // 端末B：パスワードは合っているが、まだ許可されていない → 番号を出して待つ
  const B = await device(browser, g);
  await staffLogin(B.page, origin, PASS);
  await expect(B.page.locator('#auth-wait')).toBeVisible({ timeout: 10000 });
  const code = (await B.page.locator('#auth-wait-code').textContent()).trim();
  expect(code).toMatch(/^[0-9A-F]{4}$/);
  await expect(B.page.locator('#v-admin')).toBeHidden();
  await expect(B.page.locator('#btn-login')).toBeHidden();
  await B.page.locator('#auth-who').fill('でんしか たろう');
  // 持ち主：待っている端末が、同じ番号で一覧の先頭に出る（8秒ごとに取り直す。ここでは待たずに取り直す）
  await page.evaluate(() => ownRefresh(true));
  const waitRow = page.locator('#own-devs .own-dev[data-st="wait"]');
  await expect(waitRow).toHaveCount(1);
  await expect(waitRow.locator('.od-code')).toHaveText(code);
  // v217：開いているあいだに来た「許可待ち」は、知らせが出る（一覧を見張っていなくてよい）。まとめの先頭にも出る
  await expect(page.locator('#toast')).toHaveText(`端末 ${code} が、許可を待っています`);
  await expect(waitRow.locator('.od-when')).toContainText('許可を求めた');           // まだ入っていないので「最後に入った」とは言わない
  await expect(page.locator('#own-dev-sum')).toHaveText('2台：許可を待っています 1・許可しています 1');
  // 同じ端末について、取り直すたびに何度も知らせない
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; return ownRefresh(true); });
  expect(await page.locator('#toast').textContent()).toBe('');
  await expect(page.locator('#own-devs .own-dev').first()).toHaveAttribute('data-st', 'wait');
  await waitRow.locator('[data-dev="ok"]').click();
  await expect(page.locator('#own-devs .own-dev[data-st="wait"]')).toHaveCount(0);
  // 端末B：6秒ごとに確かめているので、自動で入る
  await expect(B.page.locator('#v-admin')).toBeVisible({ timeout: 20000 });
  await expect(B.page.locator('#toast')).toContainText('許可されました');
  // 持ち主：B を止める → B が次に送ると、ログインの画面に戻されて理由が出る
  await page.evaluate(() => ownRefresh(true));
  const rowB = page.locator('#own-devs .own-dev', { has: page.locator('.od-code', { hasText: code }) });
  await expect(rowB.locator('.od-label')).toHaveText('でんしか たろう');     // 待っているあいだに書いた名前
  await rowB.locator('[data-dev="no"]').click();
  await expect(rowB.locator('.od-st')).toHaveText('止めています');
  await expect(page.locator('#own-dev-sum')).toHaveText('2台：許可しています 1・止めています 1');
  await B.page.evaluate(() => localStorage.setItem('kuroko_adm_mode', JSON.stringify('flat')));
  await B.page.locator('.seg button', { hasText: '古い順' }).click();
  const cardB = B.page.locator('#admin-list .adm-booth').first();
  await cardB.locator('[data-step="1"]').click();
  await cardB.locator('.send').click();
  await expect(B.page.locator('#v-auth')).toBeVisible({ timeout: 10000 });
  await expect(B.page.locator('#auth-err')).toContainText('止められています');
  // 「パスワードを知っている人」に戻す → 新しい端末Cは、パスワードだけで入れる。止めた B は入れない
  accept(page);
  await page.locator('#own-mode-off').click();
  await expect(page.locator('#own-mode-off')).toHaveAttribute('aria-pressed', 'true');
  const C = await device(browser, g);
  await staffLogin(C.page, origin, PASS);
  await expect(C.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await B.page.locator('#pw').fill(PASS);
  await B.page.locator('#btn-login').click();
  await expect(B.page.locator('#auth-err')).toContainText('止められています');
  await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
  expect(errors).toEqual([]);
});

test('司令塔：パスキー（顔認証・指紋）を登録して、次からはそれで入る。本人の確かめができない端末・消したあとは入れない', async ({ page, baseURL, browserName }) => {
  test.skip(browserName !== 'chromium', '仮の認証器は Chromium だけ');
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  // 仮の認証器（スマホの顔認証・指紋のまね。本人の確かめ＝あり）
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  // はじめは登録が無い：「顔認証・指紋で入る」は押せない
  await page.goto(origin + '/?mode=owner');
  await expect(page.locator('#own-passkey')).toBeDisabled();
  await expect(page.locator('#own-passkey-note')).toContainText('まだ登録されていません');
  // 持ち主パスワードで入って、この端末を登録する
  await page.locator('#own-pw').fill(OWNER);
  await page.locator('#own-login').click();
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  await page.locator('#owntab-setup').click();
  await page.locator('#own-key-label').fill('わたしのスマホ');
  await page.locator('#own-reg').click();
  await expect(page.locator('#own-keys .own-key')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('#own-keys .own-key')).toContainText('わたしのスマホ');
  await expect(page.locator('#toast')).toContainText('登録しました');
  const keys = JSON.parse(g.__props.OWNER_KEYS);
  expect(keys.length).toBe(1);
  expect(keys[0].x && keys[0].y && keys[0].id).toBeTruthy();
  // 出て、顔認証・指紋で入る（持ち主パスワードは打たない）
  await page.locator('#own-logout').click();
  await expect(page.locator('#own-gate')).toBeVisible();
  await expect(page.locator('#own-passkey')).toBeEnabled({ timeout: 10000 });
  await page.locator('#own-passkey').click();
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 15000 });
  expect(await page.locator('#own-pw').inputValue()).toBe('');
  // 本人の確かめができない（顔・指紋が通らない）端末では入れない
  await page.locator('#own-logout').click();
  await expect(page.locator('#own-passkey')).toBeEnabled({ timeout: 10000 });
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await page.locator('#own-passkey').click();
  await expect(page.locator('#own-err')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#own-main')).toBeHidden();
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
  // サーバーが覚えている鍵を別のものにすり替える（＝別の端末の署名）→ 入れない
  const saved = g.__props.OWNER_KEYS;
  const other = JSON.parse(saved); other[0].x = other[0].y;
  g.__props.OWNER_KEYS = JSON.stringify(other);
  await page.locator('#own-passkey').click();
  await expect(page.locator('#own-err')).toContainText('入れませんでした', { timeout: 15000 });
  await expect(page.locator('#own-main')).toBeHidden();
  g.__props.OWNER_KEYS = saved;
  // 正しい鍵に戻せば入れる。消すと、もう入れない
  await page.locator('#own-passkey').click();
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 15000 });
  accept(page);
  await page.locator('#own-keys [data-key-del]').click();
  await expect(page.locator('#own-keys .own-key')).toHaveCount(0);
  await page.locator('#own-logout').click();
  await expect(page.locator('#own-passkey')).toBeDisabled({ timeout: 10000 });
  expect(errors).toEqual([]);
});

test('司令塔：入っている印が切れたら、入口に戻す（中身は残さない）。幅320pxでも横にはみ出さない', async ({ page, baseURL }) => {
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  await page.setViewportSize({ width: 320, height: 640 });
  await ownerLogin(page, origin);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // サーバー側で印を消す（30分たった・別の所で出た、のまね）
  for (const k of [...g.__cache.keys()]) if (k.startsWith('own_')) g.__cache.delete(k);
  await page.evaluate(() => ownRefresh(false));
  await expect(page.locator('#own-gate')).toBeVisible();
  await expect(page.locator('#own-main')).toBeHidden();
  await expect(page.locator('#own-err')).toContainText('入り直して');
  expect(await page.evaluate(() => sessionStorage.getItem('kuroko_owner'))).toBeNull();
  // 押す所は 44px 以上
  const small = await page.evaluate(() => [...document.querySelectorAll('#v-owner button, #v-owner input')].filter(el => el.offsetParent && el.getBoundingClientRect().height < 43.5).map(el => el.id || el.textContent.trim()));
  expect(small).toEqual([]);
});

/* ---------------- v217：司令塔の仕上げ ---------------- */
test('司令塔（v217）：新しいパスワードを打っている途中に、あと何文字か・2つの欄が同じかが分かる。欄の中の文字は切れない', async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerLogin(page, origin);
  const hint = page.locator('#own-np-hint');
  await expect(hint).toContainText('8〜64文字');
  // 欄の中の案内（placeholder）が、欄の幅に収まる（「新しいパスワード（8文字以」で切れていた）
  const fit = await page.evaluate(() => ['#own-np', '#own-np2', '#own-pw', '#own-key-label'].map(sel => {
    const el = document.querySelector(sel), cs = getComputedStyle(el);
    const sp = document.createElement('span');
    sp.textContent = el.placeholder;
    sp.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
    document.body.appendChild(sp);
    const w = sp.getBoundingClientRect().width; sp.remove();
    return { sel, w: Math.round(w), room: Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) };
  }));
  // #own-pw は入口の欄（いまは隠れていて幅 0）なので、見えている欄だけを見る
  fit.filter(f => f.room > 0).forEach(f => expect(f.w, JSON.stringify(f)).toBeLessThanOrEqual(f.room));
  expect(fit.filter(f => f.room > 0).length).toBeGreaterThanOrEqual(2);
  // 打っている途中
  await page.locator('#own-np').fill('abc');
  await expect(hint).toHaveText('あと 5文字（いま 3文字）');
  await expect(hint).toHaveAttribute('data-ok', '0');
  await page.locator('#own-np').fill('ＡＢＣabcde123');
  await expect(hint).toContainText('全角');
  await page.locator('#own-np').fill(' abcdefgh12');
  await expect(hint).toContainText('空白');
  const NEW = 'atarashii-pass-2026';
  await page.locator('#own-np').fill(NEW);
  await expect(hint).toContainText(NEW.length + '文字。下の欄にも');
  await page.locator('#own-np2').fill(NEW.slice(0, 5));
  await expect(hint).toContainText('まだ同じではありません');
  await page.locator('#own-np2').fill(NEW);
  await expect(hint).toContainText('2つの欄が同じです');
  await expect(hint).toHaveAttribute('data-ok', '1');
  // 手がかりの判定は、サーバーの決まりと同じ（全角・前後の空白は、サーバーも断る）
  const token = await page.evaluate(() => sessionStorage.getItem('kuroko_owner'));
  const srv = p => g.__post({ action: 'owner_set_pass', token, pass: p });
  expect(String(srv('ＡＢＣabcde123').error)).toContain('全角');
  expect(String(srv(' abcdefgh12').error)).toContain('空白');
  expect(String(srv('abc').error)).toContain('8〜64文字');
  expect(g.__props.ADMIN_PASS).toBe(PASS);
  // 変えたあとは、はじめの案内に戻る
  accept(page);
  await page.locator('#own-setpass').click();
  await expect(page.locator('#toast')).toContainText('変えました');
  await expect(hint).toContainText('8〜64文字');
  expect(await hint.getAttribute('data-ok')).toBeNull();
  expect(g.__props.ADMIN_PASS).toBe(NEW);
  // 出る所の下に、自動で出ることの案内
  await expect(page.locator('#own-main .own-foot')).toContainText('司令塔から出る');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

/* ---------------- v218：司令塔の手ごたえ ---------------- */
test('司令塔（v218）：一覧は、変わっていなければ描き直さない。押したボタンは返事まで「…」で、重ねて送らない。変わった行が光る。入ったときに札が順に出る', async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  ['aaaa1111aaaa', 'bbbb2222bbbb'].forEach(cid => g.__post({ action: 'verify', pass: PASS, cid }));
  await bridge(page, g);
  // 端末の操作と、入・切の切り替えだけ、返事を遅らせる（本番の GAS は 1〜3秒かかる）
  const sent = [];
  let slow = 900;
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    const body = route.request().postData() || '';
    const m = /"action":"(owner_dev|owner_mode)"/.exec(body);
    if (m) { sent.push(m[1]); await new Promise(r => setTimeout(r, slow)); }
    return route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerLogin(page, origin);
  // 入ったとき：札が順に出る（終わったら印を外す）
  expect(await page.evaluate(() => document.querySelector('#own-main').classList.contains('own-in'))).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelector('#own-main').classList.contains('own-in')), { timeout: 5000 }).toBe(false);
  await expect(page.locator('#own-devs .own-dev')).toHaveCount(2);
  // 取り直しても、中身が同じなら作り直さない（押そうとしたボタンが入れ替わらない・フォーカスが飛ばない）
  const first = page.locator('#own-devs .own-dev').first();
  await first.locator('[data-dev="label"]').focus();
  await page.evaluate(() => { document.querySelector('#own-devs .own-dev').__mark = 1; });
  await page.evaluate(() => ownRefresh(true));
  await page.evaluate(() => ownRefresh(true));
  expect(await page.evaluate(() => document.querySelector('#own-devs .own-dev').__mark)).toBe(1);
  await expect(first.locator('[data-dev="label"]')).toBeFocused();
  // 「止める」を押す → 返事が来るまで、そのボタンは「…」、その行のほかのボタンは押せない。重ねて押しても1回しか送らない
  const cid = await first.getAttribute('data-cid');
  const row = page.locator(`#own-devs .own-dev[data-cid="${cid}"]`);
  await row.locator('[data-dev="no"]').click();
  await expect(row).toHaveClass(/busy/);
  await expect(row.locator('[data-dev="no"]')).toHaveClass(/ing/);
  await expect(row.locator('[data-dev="no"]')).toBeDisabled();
  await expect(row.locator('[data-dev="del"]')).toBeDisabled();
  await page.evaluate(c => { ownDevAct(c, 'no'); ownDevAct(c, 'ok'); }, cid);        // 重ねて呼んでも送らない
  await page.locator('#own-devs .own-dev').nth(1).locator('[data-dev="no"]').click();  // ほかの行も、返事を待つ
  await expect(row.locator('.od-st')).toHaveText('止めています', { timeout: 10000 });
  await expect(row).toHaveClass(/changed/);                    // 変わった行が光る
  await expect(row).not.toHaveClass(/busy/);
  expect(sent.filter(a => a === 'owner_dev').length).toBe(1);
  await expect(page.locator('#own-dev-sum')).toHaveText('2台：入れます 1・止めています 1');
  await expect(row).not.toHaveClass(/changed/, { timeout: 5000 });
  // 入・切の切り替え：返事が来るまで「切り替えています…」で、押せない
  accept(page);
  await page.locator('#own-mode-on').click();
  await expect(page.locator('.own-seg')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#own-mode-note')).toHaveText('切り替えています…');
  await expect(page.locator('#own-mode-on')).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
  await expect(page.locator('.own-seg')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#own-mode-note')).toContainText('許可する');
  // 送れなかったとき：ボタンは元に戻る（「…」のまま固まらない）
  slow = 0;
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    if (/"action":"owner_dev"/.test(route.request().postData() || '')) return route.abort();
    return route.fallback();
  });
  const row2 = page.locator('#own-devs .own-dev').filter({ hasNot: page.locator(`[data-cid="${cid}"]`) }).last();
  await page.locator(`#own-devs .own-dev:not([data-cid="${cid}"]) [data-dev="no"]`).click();
  await expect(page.locator('#toast')).toContainText('通信', { timeout: 10000 });
  await expect(page.locator('#own-devs .own-dev.busy')).toHaveCount(0);
  await expect(page.locator(`#own-devs .own-dev:not([data-cid="${cid}"]) [data-dev="no"]`)).toBeEnabled();
  expect(errors.filter(e => !/Failed to load resource|net::ERR_FAILED/.test(e))).toEqual([]);
});

/* ---------------- v219：司令塔の作り直し（5枚・本部と準備を移す）と、司令塔だけのイベント ---------------- */
/** 来場者の端末（スタンプ番号とスタンプを持たせる） */
async function visitor(browser, g, sid, stamps) {
  const d = await device(browser, g);
  await d.page.addInitScript(([sid, stamps]) => {
    localStorage.setItem('kuroko_intro_v1', '1');
    if (sid) localStorage.setItem('kuroko_sid', JSON.stringify(sid));
    if (stamps && !localStorage.getItem('kuroko_stamps_v2')) localStorage.setItem('kuroko_stamps_v2', JSON.stringify(stamps));
  }, [sid || '', stamps || null]);
  return d;
}
const loaded = page => expect.poll(() => page.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);

test('司令塔（v219）：5枚のタブ。本部（お知らせ・開場と閉場）と準備（地図の割り当て・印刷物）は司令塔の中だけ。係員の画面は 更新・受付 の2枚で、係員のパスワードでは出せない', async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  g.__post({ action: 'visitor', pass: PASS, cid: 'aaaa1111aaaa', n: 7, uid: 'v219' });
  await bridge(page, g);
  // 係員の画面：2枚だけ。本部・準備の部品は無い。出る所と、司令塔への入口は下にある
  const A = await device(browser, g);
  await staffLogin(A.page, origin, PASS);
  await expect(A.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await expect(A.page.locator('.adm-tabs button')).toHaveCount(2);
  expect(await A.page.evaluate(() => ['#notice-card', '#btn-bulk', '#btn-edit-map', '#chk-card', '#stale-card'].filter(s => document.querySelector('#v-admin ' + s)))).toEqual([]);
  await expect(A.page.locator('#btn-logout')).toBeVisible();
  await expect(A.page.locator('#btn-open-owner')).toBeVisible();
  // 係員のパスワードでは、お知らせも一括も出せない（画面を通さずに送っても、サーバーが断る）
  const denied = await A.page.evaluate(async () => {
    const out = [];
    for (const body of [{ action: 'notice', text: 'いたずら', level: 'alert' }, { action: 'bulk', status: '準備中' }]) {
      try { await api({ body: Object.assign({ pass: pw() }, body) }); out.push('ok'); } catch (e) { out.push(String(e.message)); }
    }
    return out;
  });
  denied.forEach(m => expect(m).toMatch(/^owner only/));
  expect(g.__get().notice).toBeNull();
  // 司令塔：はじめは「ようす」。来場者の数・止まっているブースの数・混み具合が出る
  await ownerLogin(page, origin, '');
  await expect(page.locator('.own-tabs button')).toHaveCount(5);
  await expect(page.locator('#owntab-home')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#own-tiles .own-tile').first()).toContainText('7');
  const stale = await page.evaluate(() => S.booths.filter(b => isVenue(b) && lvOf(b).lv !== 3 && elapsedMin(b) >= CONFIG.ADMIN_WARN_MIN).length);
  await expect(page.locator('#own-tiles [data-ogo="hq"] b')).toContainText(String(stale));
  await expect(page.locator('#owntab-hq-n')).toHaveText(String(stale));
  await expect(page.locator('#own-tiles .own-mix-lg')).toContainText('情報なし');
  await expect(page.locator('#own-now')).toContainText('何も出していません');
  // どのタブも：その1枚だけが見える・幅 320px で横にはみ出さない・押す所は 44px 以上
  await page.setViewportSize({ width: 320, height: 640 });
  for (const t of ['home', 'event', 'hq', 'staff', 'setup']) {
    await page.locator('#owntab-' + t).click();
    await expect(page.locator('#ownpane-' + t)).toBeVisible();
    const m = await page.evaluate(() => ({
      panes: [...document.querySelectorAll('.own-pane')].filter(p => p.offsetParent).length,
      over: document.documentElement.scrollWidth - innerWidth,
      small: [...document.querySelectorAll('#own-main button, #own-main input:not([type=checkbox]), #own-main select, #own-main a.btn, #own-main summary')]
        .filter(el => el.offsetParent && el.offsetHeight < 43.5).map(el => (el.id || el.textContent.trim().slice(0, 12)) + ' ' + el.offsetHeight) }));   // 押したときの動き（少し縮む）に左右されないよう、並べたときの高さで見る
    expect(m.panes, t).toBe(1);
    expect(m.over, t).toBeLessThanOrEqual(0);
    expect(m.small, t).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // ようすの札を押すと、その画面へ
  await page.locator('#owntab-home').click();
  await page.locator('#own-tiles [data-ogo="hq"]').click();
  await expect(page.locator('#owntab-hq')).toHaveAttribute('aria-selected', 'true');
  // 本部：お知らせを出す（司令塔に入っている印で送る。係員のパスワードは送らない）
  const sent = [];
  page.on('request', r => { const b = r.postData() || ''; if (/"action":"(notice|bulk)"/.test(b)) sent.push(JSON.parse(b)); });
  await page.locator('#notice-card > summary').click();
  await page.locator('#notice-text').fill('12:00 から体育館でステージ発表があります');
  await page.locator('#notice-send').click();
  await expect(page.locator('#toast')).toContainText('お知らせを出しました', { timeout: 10000 });
  expect(g.__get().notice.text).toBe('12:00 から体育館でステージ発表があります');
  expect(sent[0].token).toMatch(/^[a-f0-9]{64}$/);
  expect(sent[0].pass).toBeUndefined();
  await page.locator('#owntab-home').click();
  await expect(page.locator('#own-now')).toContainText('12:00 から体育館');
  // 閉場：全ブースを「準備中」に
  await page.locator('#owntab-hq').click();
  accept(page);
  await page.locator('#btn-bulk-close').click();
  await expect(page.locator('#toast')).toContainText('準備中', { timeout: 10000 });
  expect(g.__get().booths.every(b => b.status === '準備中')).toBe(true);
  // 準備：印刷するもの5つ（絵つき）。地図の割り当てに入って、やめると「準備」に戻る
  await page.locator('#owntab-setup').click();
  const links = await page.evaluate(() => [...document.querySelectorAll('#ownpane-setup .own-links a.btn')].map(a => ({ href: a.getAttribute('href'), ic: !!a.querySelector('svg.ic') })));
  expect(links.map(l => l.href)).toEqual(['?mode=qr', '?mode=pamphlet', '?mode=print', '?mode=report', '?mode=board']);
  expect(links.every(l => l.ic)).toBe(true);
  await page.locator('#ownpane-setup .setup-card > summary').click();
  await page.locator('#btn-edit-map').click();
  await expect(page.locator('#edit-bar')).toBeVisible();
  await expect(page.locator('#v-map')).toBeVisible();
  await page.locator('#edit-off').click();
  await expect(page.locator('#ownpane-setup')).toBeVisible({ timeout: 10000 });
  // QR の印刷シート：司令塔に入っていれば開ける。戻り口は「← 司令塔」
  await page.locator('#ownpane-setup .own-links a[href="?mode=qr"]').click();
  await expect(page.locator('#v-qr')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#staff-back-btn')).toHaveText('← 司令塔');
  await expect(page.locator('#staff-jump button')).toHaveCount(5);
  await page.locator('#staff-back-btn').click();
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#owntab-setup')).toHaveAttribute('aria-selected', 'true');     // 前に開いていた所へ
  // 係員だけの端末には、印刷物への近道は出ない
  await A.page.goto(origin + '/?mode=report');
  await expect(A.page.locator('#staff-back-btn')).toHaveText('← 係員画面');
  await expect(A.page.locator('#staff-jump button')).toHaveCount(0);
  await A.ctx.close();
  expect(errors).toEqual([]);
});

test('イベント（v219）：演出つきの一斉お知らせ。「この端末で試す」は送らない。出すと、来場者の画面に1回だけ出る（係員の画面・本部モニタには出ない）。打った文字はタグにしない', async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  await ownerLogin(page, origin, 'event');
  // 見出しが無ければ出さない
  await page.locator('#own-show-send').click();
  await expect(page.locator('#toast')).toContainText('見出しを入れてください');
  // ひな形 → この端末で試す（だれにも送らない）
  await page.locator('#own-show-tpl .chip').first().click();
  await expect(page.locator('#own-show-title')).toHaveValue('まもなくステージ発表！');
  await page.locator('#own-show-try').click();
  await expect(page.locator('#lfx .lfx-title')).toHaveText('まもなくステージ発表！');
  await expect(page.locator('#lfx .sfx-kicker')).toContainText('ためし');
  expect(g.__props.LIVE).toBeUndefined();
  await page.locator('#lfx [data-fx="close"]').click();
  await expect(page.locator('#lfx')).toHaveCount(0);
  // 全員に出す
  await page.locator('#own-show-title').fill('A<b id="xss1">太字</b>');
  await page.locator('#own-show-text').fill('<img src=x onerror="window.__xss=1">第一体育館へ');
  accept(page);
  await page.locator('#own-show-send').click();
  await expect(page.locator('#own-show-now')).toContainText('出しています', { timeout: 10000 });
  await expect(page.locator('#own-ev-show')).toHaveAttribute('data-live', '1');
  await expect(page.locator('#owntab-event-n')).toHaveText('1');
  await expect(page.locator('#own-show-title')).toHaveValue('');
  // 司令塔の画面には、演出は出ない
  await page.evaluate(() => sync(false));
  await expect(page.locator('#lfx')).toHaveCount(0);
  // 来場者：開くと出る。文字はそのまま（タグにならない）
  const V = await visitor(browser, g);
  const verr = watchErrors(V.page);
  await V.page.goto(origin + '/?tab=map');
  await expect(V.page.locator('#lfx')).toBeVisible({ timeout: 15000 });
  await expect(V.page.locator('#lfx .sfx-kicker')).toHaveText('本部から');
  await expect(V.page.locator('#lfx .lfx-title')).toHaveText('A<b id="xss1">太字</b>');
  await expect(V.page.locator('#lfx .lfx-text')).toContainText('第一体育館へ');
  expect(await V.page.evaluate(() => !!document.querySelector('#xss1') || !!window.__xss || !!document.querySelector('#lfx img'))).toBe(false);
  await expect(V.page.locator('#lfx [data-fx="close"]')).toBeFocused();
  await V.page.keyboard.press('Escape');
  await expect(V.page.locator('#lfx')).toHaveCount(0);
  // 同じお知らせは、開き直しても もう出ない
  await V.page.reload();
  await loaded(V.page);
  await V.page.waitForTimeout(600);
  await expect(V.page.locator('#lfx')).toHaveCount(0);
  // もう一度出すと（番号が変わる）、また出る
  await page.locator('#own-show-title').fill('ただいま開場しました！');
  accept(page);
  await page.locator('#own-show-send').click();
  await expect(page.locator('#own-show-now')).toContainText('ただいま開場', { timeout: 10000 });
  await V.page.evaluate(() => sync(false));
  await expect(V.page.locator('#lfx .lfx-title')).toHaveText('ただいま開場しました！', { timeout: 10000 });
  await V.page.locator('#lfx [data-fx="close"]').click();
  expect(verr).toEqual([]);
  await V.ctx.close();
  // 本部モニタ・係員の画面には出ない
  const B = await visitor(browser, g);
  await B.page.goto(origin + '/?mode=board');
  await B.page.waitForTimeout(1500);
  await expect(B.page.locator('#lfx')).toHaveCount(0);
  await staffLogin(B.page, origin, PASS);
  await expect(B.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await B.page.waitForTimeout(800);
  await expect(B.page.locator('#lfx')).toHaveCount(0);
  await B.ctx.close();
  expect(errors).toEqual([]);
});

test('イベント（v219）：ラッキーブース。来場者の画面に帯が出て、地図と一覧で光る。「見る」でそのブースが開く。終わらせる・時間が来ると消える', async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  const V = await visitor(browser, g);
  const verr = watchErrors(V.page);
  await V.page.goto(origin + '/?tab=map');
  await loaded(V.page);
  await expect(V.page.locator('#banner-lucky')).toBeHidden();
  await ownerLogin(page, origin, 'event');
  // えらばないと始められない
  await page.locator('#own-lucky-start').click();
  await expect(page.locator('#toast')).toContainText('ブースをえらんでください');
  expect(await page.locator('#own-lucky-booth option').count()).toBeGreaterThan(40);
  await page.locator('#own-lucky-booth').selectOption('1F-02');
  await page.locator('#own-lucky-min [data-v="5"]').click();
  await expect(page.locator('#own-lucky-min [data-v="5"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#own-lucky-min [aria-pressed="true"]')).toHaveCount(1);
  accept(page);
  await page.locator('#own-lucky-start').click();
  await expect(page.locator('#own-lucky-now')).toContainText('光らせています：旋盤の加工実演', { timeout: 10000 });
  await expect(page.locator('#own-lucky-end')).toBeVisible();
  expect(g.__get().live.lucky.booth).toBe('1F-02');
  // 来場者：次の同期で、帯と知らせが出る
  await V.page.evaluate(() => sync(false));
  const bn = V.page.locator('#banner-lucky');
  await expect(bn).toBeVisible({ timeout: 10000 });
  await expect(bn).toContainText('旋盤の加工実演');
  await expect(bn).toContainText(/ラッキーブース・あと[45]分/);
  await expect(V.page.locator('#toast')).toContainText('ラッキーブース：旋盤の加工実演');
  // 地図の部屋と、一覧の札が光る
  const glow = await V.page.evaluate(() => {
    const f = document.querySelector('.room[data-id="1F-02"] .fill'), o = document.querySelector('.room[data-id="1F-03"] .fill');
    return { stroke: f ? getComputedStyle(f).stroke : '', other: o ? getComputedStyle(o).stroke : '' };
  });
  expect(glow.stroke).toBe('rgb(217, 165, 20)');
  expect(glow.other).not.toBe('rgb(217, 165, 20)');
  // 「見る」→ そのブースの詳細
  await V.page.locator('#banner-lucky-go').click();
  await expect(V.page.locator('.bsh-head h2')).toHaveText('旋盤の加工実演', { timeout: 10000 });
  await V.page.locator('#bsh-x').click();
  await V.page.locator('#nav button[data-view="list"]').click();
  await expect(bn).toBeVisible();
  expect(await V.page.evaluate(() => { const el = document.getElementById('booth-1F-02'); return el ? getComputedStyle(el).outlineColor : ''; })).toBe('rgb(217, 165, 20)');
  expect(await V.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // 時間が来たら、次の同期を待たずに消える
  await V.page.evaluate(() => { S.live.lucky.until = Date.now() + 1200; renderLive(); });
  await expect(bn).toBeHidden({ timeout: 8000 });
  expect(await V.page.evaluate(() => document.getElementById('lucky-style').textContent)).toBe('');
  // 持ち主が終わらせる
  await V.page.evaluate(() => sync(false));
  await expect(bn).toBeVisible({ timeout: 10000 });
  accept(page);
  await page.locator('#own-lucky-end').click();
  await expect(page.locator('#own-lucky-now')).toHaveText('', { timeout: 10000 });
  await expect(page.locator('#own-lucky-end')).toBeHidden();
  await V.page.evaluate(() => sync(false));
  await expect(bn).toBeHidden({ timeout: 10000 });
  expect(verr).toEqual([]);
  await V.ctx.close();
  expect(errors).toEqual([]);
});

test('イベント（v219）：スタンプの抽選。当たった人の画面にだけ「当たり」と自分のスタンプ番号が出て、司令塔の番号と同じ。はずれ・スタンプなしの人には出ない。消すと、当たった人の画面からも消える', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  const now = Date.now();
  // 当たる人（3個）・はずれる人（1個）・スタンプなしの人
  g.__post({ action: 'ledger', cid: 'WWWW1234', ev: ['1F-02', '1F-03', '2F-12'].map(id => ({ t: 's', id, at: now })) });
  g.__post({ action: 'ledger', cid: 'LLLL5678', ev: [{ t: 's', id: '1F-02', at: now }] });
  const W = await visitor(browser, g, 'WWWW1234', ['1F-02', '1F-03', '2F-12']);
  const L = await visitor(browser, g, 'LLLL5678', ['1F-02']);
  const N = await visitor(browser, g);
  const werr = watchErrors(W.page);
  for (const d of [W, L, N]) { await d.page.goto(origin + '/?tab=map'); await loaded(d.page); await d.page.evaluate(() => { liveDrawCheck.wait = 0; }); }
  await ownerLogin(page, origin, 'event');
  // 条件に合う人がいない
  await page.locator('#own-draw-min [data-v="10"]').click();
  accept(page);
  await page.locator('#own-draw-go').click();
  await expect(page.locator('#toast')).toContainText('当たりを引ける人がいません', { timeout: 10000 });
  await expect(page.locator('#own-draw-res li')).toHaveCount(0);
  // 3個以上から1人
  await page.locator('#own-draw-min [data-v="3"]').click();
  accept(page);
  await page.locator('#own-draw-go').click();
  await expect(page.locator('#own-draw-res li')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('#own-draw-res li b')).toHaveText('WWWW-1234');
  await expect(page.locator('#own-draw-now')).toContainText('1人が当たり');
  await expect(page.locator('#own-draw-clear')).toBeVisible();
  // 当たった人：演出と、自分のスタンプ番号
  await W.page.evaluate(() => sync(false));
  await expect(W.page.locator('#lfx.win')).toBeVisible({ timeout: 15000 });
  await expect(W.page.locator('#lfx .lfx-title')).toHaveText('当たり！');
  await expect(W.page.locator('#lfx .lfx-sid b')).toHaveText('WWWW-1234');
  await W.page.locator('#lfx [data-fx="close"]').click();
  // スタンプの画面に、札が残る。開き直しても残る（演出は、もう出ない）
  await W.page.locator('#nav button[data-view="stamp"]').click();
  await expect(W.page.locator('#win-card')).toBeVisible();
  await expect(W.page.locator('#win-card .sid')).toHaveText('WWWW-1234');
  await W.page.reload();
  await loaded(W.page);
  await W.page.locator('#nav button[data-view="stamp"]').click();
  await expect(W.page.locator('#win-card')).toBeVisible();
  await expect(W.page.locator('#lfx')).toHaveCount(0);
  // はずれの人・スタンプなしの人：演出も札も出ない（ひとこと知らせるだけ）
  await L.page.evaluate(() => sync(false));
  await expect(L.page.locator('#toast')).toContainText('はずれ', { timeout: 15000 });
  await N.page.evaluate(() => sync(false));
  await expect(N.page.locator('#toast')).toContainText('スタンプをあつめると', { timeout: 15000 });
  for (const d of [L, N]) { await expect(d.page.locator('#lfx')).toHaveCount(0); await expect(d.page.locator('#win-card')).toHaveCount(0); }
  // 当たった番号は、ほかの人の画面のどこにも届いていない
  expect(await L.page.evaluate(() => JSON.stringify(S.live) + document.body.innerText)).not.toContain('WWWW');
  // 当たりの表示を消す → 当たった人の画面からも消える
  accept(page);
  await page.locator('#own-draw-clear').click();
  await expect(page.locator('#own-draw-res li')).toHaveCount(0, { timeout: 10000 });
  await W.page.evaluate(() => sync(false));
  await expect(W.page.locator('#win-card')).toHaveCount(0, { timeout: 10000 });
  expect(werr).toEqual([]);
  await W.ctx.close(); await L.ctx.close(); await N.ctx.close();
  expect(errors).toEqual([]);
});
