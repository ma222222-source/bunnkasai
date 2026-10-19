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
// 日本時間の0時の前40分か（予約は「きょうの時刻」だけ。そのあいだは、数分後・数十分後の時刻が日をまたぐ。日付の変わり目に流すと落ちていた）
const nearMidnight = () => { const d = new Date(Date.now() + 9 * 3600000); return 24 * 60 - (d.getUTCHours() * 60 + d.getUTCMinutes()) < 40; };

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
  // 入ったときの印（own-in）は 0.9秒で外れる。PC が重いと見のがすので、付いた瞬間を画面の中で覚えておく
  await page.addInitScript(() => { window.__sawOwnIn = false; setInterval(() => { const m = document.querySelector('#own-main'); if (m && m.classList.contains('own-in')) window.__sawOwnIn = true; }, 20); });
  await ownerLogin(page, origin);
  // 入ったとき：札が順に出る（終わったら印を外す）
  await expect.poll(() => page.evaluate(() => window.__sawOwnIn), { timeout: 5000 }).toBe(true);
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
  // 準備：印刷するもの6つ（絵つき）。地図の割り当てに入って、やめると「準備」に戻る
  await page.locator('#owntab-setup').click();
  // 共用ICONのSVG（ic-svg）と、直接置いたSVG（ic）のどちらも、実際の絵があることを確かめる。
  const links = await page.evaluate(() => [...document.querySelectorAll('#ownpane-setup .own-links a.btn')].map(a => ({ href: a.getAttribute('href'), ic: !!a.querySelector('svg') })));
  expect(links.map(l => l.href)).toEqual(['?mode=qr', '?mode=staffqr', '?mode=pamphlet', '?mode=print', '?mode=report', '?mode=board']);
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
  await expect(V.page.locator('#banner-lucky')).toHaveAttribute('data-flash', /.+/);                       // v228：帯が見えているときは、帯を光らせる（同じ文の吹き出しは重ねない）
  await expect(V.page.locator('#toast')).not.toContainText('ラッキーブース：');
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
  // スタンプが足りない人・スタンプなしの人：演出も札も出ない。サーバーには聞きに行かず、あと何個で入れるかを言う（v222）
  const asked = [];
  for (const d of [L, N]) d.page.on('request', r => { if (/[?&]win=/.test(r.url())) asked.push(r.url()); });
  await L.page.evaluate(() => sync(false));
  await expect(L.page.locator('#toast')).toContainText('スタンプをあつめると', { timeout: 15000 });
  await expect(L.page.locator('#toast')).toContainText('3個以上の人が対象');
  await expect(L.page.locator('#toast')).toContainText('あと2個');
  await N.page.evaluate(() => sync(false));
  await expect(N.page.locator('#toast')).toContainText('あと3個', { timeout: 15000 });
  for (const d of [L, N]) { await expect(d.page.locator('#lfx')).toHaveCount(0); await expect(d.page.locator('#win-card')).toHaveCount(0); }
  expect(asked).toEqual([]);
  // 当たった番号は、ほかの人の画面のどこにも届いていない
  expect(await L.page.evaluate(() => JSON.stringify(S.live) + document.body.innerText)).not.toContain('WWWW');
  // もう一度：1個以上から1人。前に当たった人（W）は選ばないので、L が当たる。W は「はずれ」で、前の当たりの札は消える
  await page.locator('#own-draw-min [data-v="1"]').click();
  accept(page);
  await page.locator('#own-draw-go').click();
  await expect(page.locator('#own-draw-res li b')).toHaveText('LLLL-5678', { timeout: 10000 });
  await L.page.evaluate(() => sync(false));
  await expect(L.page.locator('#lfx.win')).toBeVisible({ timeout: 15000 });
  await L.page.locator('#lfx [data-fx="close"]').click();
  await W.page.evaluate(() => sync(false));
  await expect(W.page.locator('#toast')).toContainText('はずれ', { timeout: 15000 });
  await expect(W.page.locator('#win-card')).toHaveCount(0, { timeout: 10000 });
  // 当たりの表示を消す → 当たった人の画面からも消える
  await L.page.locator('#nav button[data-view="stamp"]').click();
  await expect(L.page.locator('#win-card')).toBeVisible();
  accept(page);
  await page.locator('#own-draw-clear').click();
  await expect(page.locator('#own-draw-res li')).toHaveCount(0, { timeout: 10000 });
  await L.page.evaluate(() => sync(false));
  await expect(L.page.locator('#win-card')).toHaveCount(0, { timeout: 10000 });
  expect(werr).toEqual([]);
  await W.ctx.close(); await L.ctx.close(); await N.ctx.close();
  expect(errors).toEqual([]);
});

/* ---------------- v220：司令塔とイベントの仕上げ ---------------- */
test('司令塔（v220）：入口は、パスキーが無いあいだ 持ち主パスワードが主役（押せないボタンを上に置かない）。登録があれば、顔認証・指紋が主役', async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  await page.goto(origin + '/?mode=owner');
  await expect(page.locator('#own-pw')).toBeVisible();
  await expect(page.locator('#own-passkey-note')).toContainText('「準備」で登録できます');
  await expect(page.locator('#own-passkey')).toBeHidden();
  await expect(page.locator('#own-gate .own-or')).toBeHidden();
  await expect(page.locator('#own-login')).not.toHaveClass(/ghost/);
  // 登録がある（公開の鍵がサーバーにある）とき
  g.__props.OWNER_KEYS = JSON.stringify([{ id: 'abc', x: 'AA', y: 'BB', label: 'スマホ', at: new Date().toISOString(), n: 0 }]);
  await page.reload();
  await expect(page.locator('#own-passkey')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#own-passkey')).toBeEnabled();
  await expect(page.locator('#own-gate .own-or')).toBeVisible();
  await expect(page.locator('#own-login')).toHaveClass(/ghost/);
  // 画面の上から：顔認証 → または → 持ち主パスワード
  const y = await page.evaluate(() => ['#own-passkey', '#own-gate .own-or', '#own-pw', '#own-login'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().top)));
  expect(y.slice().sort((a, b) => a - b)).toEqual(y);
  expect(errors).toEqual([]);
});

test('イベント（v220）：近道・あと何文字・空いているブースのおすすめ・抽選の前に対象の人数（引かずに数える）。出している状態は緑の字', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  const now = Date.now();
  // 空いているブース3つ（待ち 0・1・2）と、混んでいるブース
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '1F-03', wait: 2 });
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '2F-12', wait: 0 });
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '1F-05', wait: 1 });
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '1F-02', wait: 30 });
  ['AAAA1111', 'BBBB2222'].forEach(c => g.__post({ action: 'ledger', cid: c, ev: ['1F-02', '1F-03', '2F-12'].map(id => ({ t: 's', id, at: now })) }));
  g.__post({ action: 'ledger', cid: 'CCCC3333', ev: [{ t: 's', id: '1F-02', at: now }] });
  await bridge(page, g);
  await page.setViewportSize({ width: 390, height: 844 });               // 近道は、スマホの幅で出る（広い画面は3枚が横に並ぶ）
  await ownerLogin(page, origin, 'event');
  await expect(page.locator('#own-head-sub')).toHaveText(/^いま \d\d:\d\d$/);
  // 近道：押すと、その札が見える所まで動く
  await expect(page.locator('#own-jump button')).toHaveCount(3);
  await page.locator('#own-jump [data-ev="draw"]').click();
  await expect.poll(async () => { const b = await page.locator('#own-ev-draw').boundingBox(); return b && b.y > 60 && b.y < 420; }, { timeout: 8000 }).toBe(true);
  // あと何文字
  const len = page.locator('#own-show-len');
  await expect(len).toHaveText('見出し あと30文字・ひとこと あと80文字');
  await page.locator('#own-show-title').fill('あ'.repeat(26));
  await expect(len).toContainText('見出し あと4文字');
  await expect(len).toHaveAttribute('data-low', '1');
  await page.locator('#own-show-tpl .chip').first().click();
  await expect(len).toContainText('見出し あと19文字');
  // 空いているブースのおすすめ：待ちの少ない順に3つ。押すと、下の欄に入る
  const sug = page.locator('#own-lucky-sug button');
  await expect(sug).toHaveCount(3);
  expect(await sug.evaluateAll(els => els.map(e => e.dataset.id))).toEqual(['2F-12', '1F-05', '1F-03']);
  await sug.nth(1).click();
  await expect(page.locator('#own-lucky-booth')).toHaveValue('1F-05');
  // 抽選の前：いまの対象の人数（引かずに数える）
  const elig = page.locator('#own-draw-elig');
  await expect(elig).toContainText('いま対象の人：2人', { timeout: 10000 });
  await page.locator('#own-draw-min [data-v="1"]').click();
  await expect(elig).toContainText('いま対象の人：3人', { timeout: 10000 });
  await expect(elig).toContainText('1個以上');
  expect(g.__props.LIVE).toBeUndefined();                                  // 数えただけ。当たりは引いていない
  await page.locator('#own-draw-min [data-v="3"]').click();
  await expect(elig).toContainText('2人', { timeout: 10000 });
  // 引いたあとは、当たった人をのぞいた人数。「もう一度 入れる」で戻る
  accept(page);
  await page.locator('#own-draw-go').click();
  await expect(page.locator('#own-draw-res li')).toHaveCount(1, { timeout: 10000 });
  await expect(elig).toContainText('いま対象の人：1人', { timeout: 10000 });
  await page.locator('#own-draw-again').check();
  await expect(elig).toContainText('いま対象の人：2人', { timeout: 10000 });
  // 出している状態：緑の字（赤＝エラーに見えない）。近道にも点
  await expect(page.locator('#own-draw-now')).toHaveAttribute('data-on', '1');
  const col = await page.evaluate(() => {
    const p = document.createElement('i'); document.body.appendChild(p);
    p.style.color = 'var(--free)'; const free = getComputedStyle(p).color;
    p.style.color = 'var(--accent)'; const accent = getComputedStyle(p).color; p.remove();
    return { now: getComputedStyle(document.querySelector('#own-draw-now')).color, free, accent };
  });
  expect(col.now).toBe(col.free);
  expect(col.now).not.toBe(col.accent);
  await expect(page.locator('#own-jump [data-ev="draw"]')).toHaveAttribute('data-on', '1');
  expect(await page.locator('#own-jump [data-ev="show"]').getAttribute('data-on')).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('司令塔（v220）：本部は「お知らせ」がいちばん上で、開いている。準備の札は短い言い方で、半端な1枚は横いっぱい', async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  await ownerLogin(page, origin, 'hq');
  const order = await page.evaluate(() => [...document.querySelectorAll('#ownpane-hq > *')].map(e => e.id || e.className));
  expect(order[0]).toBe('notice-card');
  expect(order[order.length - 1]).toBe('chk-card');
  expect(order.indexOf('stale-card')).toBeLessThan(order.indexOf('chk-card'));
  await expect(page.locator('#notice-text')).toBeVisible();                 // 押さなくても、文面の欄が見えている
  await expect(page.locator('#notice-send')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });             // スマホの幅では2列（広い画面は3列）
  await page.locator('#owntab-setup').click();
  const links = await page.evaluate(() => {
    const box = document.querySelector('#ownpane-setup .own-links').getBoundingClientRect();
    return [...document.querySelectorAll('#ownpane-setup .own-links a.btn')].map(a => ({ t: a.textContent.trim(), w: Math.round(a.getBoundingClientRect().width), full: Math.round(box.width), lines: Math.round(a.getBoundingClientRect().height) }));
  });
  expect(links.map(l => l.t)).toEqual(['QRの印刷シート', 'ブース担当者用QR・手順を印刷', '三つ折りパンフレット', '配布用の紙マップ', '混雑の振り返り', '本部モニタ（大画面）']);
  expect(links[5].w).toBeLessThan(links[5].full / 2 + 2);                  // v240：6枚なので2列が3段
  expect(links[0].w).toBeLessThan(links[0].full / 2 + 2);
  await expect(page.locator('#ownpane-setup .setup-card > summary')).toHaveText('地図でブースを割り当てる');
  expect(errors).toEqual([]);
});

/* ---------------- v221：イベントを 係員・本部モニタ・ブースの詳細にも／ようすから止める・操作の記録・渡した印・のばす ---------------- */
test('イベント（v221）：ラッキーブースは、係員の画面・本部モニタ・ブースの詳細にも出る。司令塔で「＋5分 のばす」（来場者に、もう一度は知らせない）・終わる1分前の知らせ・ようすから止める・さいきんの操作', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  // 係員・本部モニタ・来場者
  const A = await device(browser, g);
  await A.page.addInitScript(() => localStorage.setItem('kuroko_adm_mode', JSON.stringify('flat')));
  await staffLogin(A.page, origin, PASS);
  await expect(A.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await expect(A.page.locator('#adm-live')).toBeHidden();
  const B = await device(browser, g);
  await B.page.setViewportSize({ width: 1366, height: 768 });
  await B.page.goto(origin + '/?mode=board');
  await loaded(B.page);
  await expect(B.page.locator('#board-live')).toBeHidden();
  const V = await visitor(browser, g);
  await V.page.goto(origin + '/?tab=map');
  await loaded(V.page);
  // 司令塔：ラッキーブースをはじめる（10分）
  await ownerLogin(page, origin, 'event');
  await expect(page.locator('#own-lucky-more')).toBeHidden();
  await page.locator('#own-lucky-booth').selectOption('1F-02');
  accept(page);
  await page.locator('#own-lucky-start').click();
  await expect(page.locator('#own-lucky-now')).toContainText('光らせています', { timeout: 10000 });
  await expect(page.locator('#own-lucky-more')).toBeVisible();
  const id0 = g.__get().live.lucky.id, until0 = g.__get().live.lucky.until;
  // 係員の画面：知らせと、そのブースのカードの輪
  await A.page.evaluate(() => sync(false));
  await expect(A.page.locator('#adm-live')).toBeVisible({ timeout: 10000 });
  await expect(A.page.locator('#adm-live')).toContainText('ラッキーブース中：旋盤の加工実演');
  await expect(A.page.locator('#adm-live')).toContainText('人が増えます');
  expect(await A.page.evaluate(() => getComputedStyle(document.querySelector('.adm-booth[data-id="1F-02"]')).outlineColor)).toBe('rgb(217, 165, 20)');
  await expect(A.page.locator('#lfx')).toHaveCount(0);
  await expect(A.page.locator('#banner-lucky')).toBeHidden();                  // 来場者むけの帯は、係員の画面には出さない
  // 本部モニタ
  await B.page.evaluate(() => sync(false));
  await expect(B.page.locator('#board-live')).toBeVisible({ timeout: 10000 });
  await expect(B.page.locator('#board-live')).toContainText('ラッキーブース：旋盤の加工実演');
  // 来場者：ブースの詳細にも札
  await V.page.evaluate(() => sync(false));
  await expect(V.page.locator('#banner-lucky')).toBeVisible({ timeout: 10000 });
  await expect(V.page.locator('#banner-lucky')).toHaveAttribute('data-flash', /.+/);                       // v228：帯が見えているときは、帯を光らせる（同じ文の吹き出しは重ねない）
  await expect(V.page.locator('#toast')).not.toContainText('ラッキーブース：');
  await V.page.locator('#banner-lucky-go').click();
  await expect(V.page.locator('.bsh-head h2')).toHaveText('旋盤の加工実演', { timeout: 10000 });
  expect(await V.page.evaluate(() => getComputedStyle(document.querySelector('#bsh .bsh-tags'), '::after').content)).toContain('ラッキーブース');
  await V.page.locator('#bsh-x').click();
  await V.page.evaluate(() => openSheet('1F-03'));
  await expect(V.page.locator('.bsh-head h2')).not.toHaveText('旋盤の加工実演');
  expect(await V.page.evaluate(() => getComputedStyle(document.querySelector('#bsh .bsh-tags'), '::after').content)).not.toContain('ラッキーブース');
  await V.page.locator('#bsh-x').click();
  // ＋5分 のばす：終わりの時刻だけ のびる。番号は同じなので、来場者に もう一度は知らせない
  await V.page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await page.locator('#own-lucky-more').click();
  await expect(page.locator('#toast')).toContainText('5分のばしました', { timeout: 10000 });
  expect(g.__get().live.lucky.id).toBe(id0);
  expect(g.__get().live.lucky.until - until0).toBe(5 * 60000);
  await V.page.evaluate(() => sync(false));
  await expect(V.page.locator('#banner-lucky')).toContainText(/あと1[45]分/, { timeout: 10000 });
  expect(await V.page.locator('#toast').textContent()).toBe('');
  // 終わる1分前：司令塔に知らせ（1回だけ）。「5分のばす」で のばせる
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; OWN.state.live.lucky.until = Date.now() + 50000; clearTimeout(OWN.timer); renderOwnLive(); });
  await expect(page.locator('#toast')).toContainText('あと1分で終わります');
  await expect(page.locator('#toast .toast-act')).toHaveText('5分のばす');
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; renderOwnLive(); });
  expect(await page.locator('#toast').textContent()).toBe('');
  // ようす：出しているものを、その場で止める
  await page.evaluate(() => ownRefresh(true));
  await page.locator('#owntab-home').click();
  await expect(page.locator('#own-now li')).toHaveCount(1);
  accept(page);
  await page.locator('#own-now [data-stop="lucky"]').click();
  await expect(page.locator('#own-now')).toContainText('何も出していません', { timeout: 10000 });
  expect(g.__get().live.lucky).toBeUndefined();
  // お知らせ・一斉お知らせも、ようすから消せる
  g.__post({ action: 'notice', token: await page.evaluate(() => ownToken()), text: '落とし物があります', level: 'info' });
  g.__post({ action: 'owner_show', token: await page.evaluate(() => ownToken()), title: 'まもなく開場' });
  await page.evaluate(async () => { await sync(false); await ownRefresh(true); });
  await expect(page.locator('#own-now li')).toHaveCount(2, { timeout: 10000 });
  accept(page);
  await page.locator('#own-now [data-stop="show"]').click();
  await expect(page.locator('#own-now li')).toHaveCount(1, { timeout: 10000 });
  expect(g.__get().live.show).toBeUndefined();
  accept(page);
  await page.locator('#own-now [data-stop="notice"]').click();
  await expect(page.locator('#own-now')).toContainText('何も出していません', { timeout: 10000 });
  expect(g.__get().notice).toBeNull();
  // さいきんの操作：新しい順
  const log = page.locator('#own-log li');
  await expect(page.locator('#own-log-card')).toBeVisible();
  await expect(log.first()).toContainText('一斉お知らせを消した');
  await expect(page.locator('#own-log')).toContainText('ラッキーブースを 5分 のばした');
  await expect(page.locator('#own-log')).toContainText('ラッキーブース：旋盤の加工実演（10分）');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // 係員の画面・本部モニタからも消える
  await A.page.evaluate(() => sync(false));
  await expect(A.page.locator('#adm-live')).toBeHidden({ timeout: 10000 });
  await B.page.evaluate(() => sync(false));
  await expect(B.page.locator('#board-live')).toBeHidden({ timeout: 10000 });
  await A.ctx.close(); await B.ctx.close(); await V.ctx.close();
  expect(errors).toEqual([]);
});

test('抽選（v221）：当たった人に「渡した」の印を付けられる。開き直しても残る。新しい抽選では、付いていない。係員の画面の下は、線で区切ってある', async ({ page, browser, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  const now = Date.now();
  ['AAAA1111', 'BBBB2222', 'CCCC3333'].forEach(c => g.__post({ action: 'ledger', cid: c, ev: ['1F-02', '1F-03', '2F-12'].map(id => ({ t: 's', id, at: now })) }));
  await bridge(page, g);
  await ownerLogin(page, origin, 'event');
  await page.locator('#own-draw-n [data-v="3"]').click();
  accept(page);
  await page.locator('#own-draw-go').click();
  const rows = page.locator('#own-draw-res li');
  await expect(rows).toHaveCount(3, { timeout: 10000 });
  await expect(rows.nth(1).locator('[data-given]')).toHaveAttribute('aria-pressed', 'false');
  await rows.nth(1).locator('[data-given]').click();
  await expect(rows.nth(1)).toHaveClass(/given/);
  await expect(rows.nth(1).locator('[data-given]')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(1).locator('[data-given]')).toContainText('✓');
  await expect(rows.nth(0)).not.toHaveClass(/given/);
  // この端末に覚えるのは「何番目か」だけ（スタンプ番号は覚えない）
  const saved = await page.evaluate(() => localStorage.getItem('kuroko_own_given'));
  expect(JSON.parse(saved).i).toEqual([1]);
  expect(/[A-Z]{4}\d{4}/.test(saved)).toBe(false);
  // 開き直しても残る。もう一度押すと外れる
  await page.reload();
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  await expect(rows.nth(1)).toHaveClass(/given/);
  await rows.nth(1).locator('[data-given]').click();
  await expect(rows.nth(1)).not.toHaveClass(/given/);
  await rows.nth(0).locator('[data-given]').click();
  // 新しい抽選（前に当たった人も入れる）では、印は付いていない
  await page.locator('#own-draw-again').check();
  accept(page);
  await page.locator('#own-draw-go').click();
  await expect(page.locator('#toast')).toContainText('抽選しました', { timeout: 10000 });
  await expect(page.locator('#own-draw-res li.given')).toHaveCount(0);
  // 係員の画面の下：ログアウトと司令塔への入口。上と線で区切り、説明は読める大きさ
  const A = await device(browser, g);
  await staffLogin(A.page, origin, PASS);
  await expect(A.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  const foot = await A.page.evaluate(() => { const f = document.querySelector('.adm-foot'), cs = getComputedStyle(f), h = getComputedStyle(f.querySelector('.adm-hint'));
    return { line: parseFloat(cs.borderTopWidth), hint: parseFloat(h.fontSize), btn: [...f.querySelectorAll('button')].map(b => b.offsetHeight) }; });
  expect(foot.line).toBeGreaterThanOrEqual(1);
  expect(foot.hint).toBeGreaterThanOrEqual(11);
  expect(Math.min(...foot.btn)).toBeGreaterThanOrEqual(44);
  await A.ctx.close();
  expect(errors).toEqual([]);
});

/* ---------------- v222：司令塔の PC の並び・さっき出した見出し ---------------- */
test('司令塔（v222）：PC の広い画面では、イベントの3枚・本部・係員・準備が横に並ぶ（近道は出さない）。スマホの幅では縦に並ぶ。さっき出した見出しを、もう一度使える', async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  ['aaaa1111aaaa', 'bbbb2222bbbb'].forEach(cid => g.__post({ action: 'verify', pass: PASS, cid }));
  await bridge(page, g);
  await page.setViewportSize({ width: 1366, height: 768 });
  await ownerLogin(page, origin, 'event');
  const tops = sel => page.evaluate(s => [...document.querySelectorAll(s)].filter(e => e.offsetParent).map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.width)]; }), sel);
  // タブを押した直後は、入りの動き（下から 12px・0.28秒）の途中で位置が動く。動きが終わってから測る（GitHub で1回失敗した）
  // （位置が止まって見えても、動きの終わり際は 1回の間に 1px も動かないので、動きそのものが終わるのを待つ。くり返しの動き＝点の点滅は数えない）
  const settled = async sel => {
    await page.waitForFunction(() => document.getAnimations().filter(an => an.playState === 'running' && isFinite(an.effect.getComputedTiming().endTime)).length === 0, null, { timeout: 5000 });
    return tops(sel);
  };
  // イベント：3枚が同じ高さから始まり、左から順に並ぶ。近道は出さない
  let c = await settled('#ownpane-event .own-ev');
  expect(c.length).toBe(3);
  expect(Math.max(...c.map(x => x[0])) - Math.min(...c.map(x => x[0]))).toBeLessThanOrEqual(1);
  expect(c[0][1] < c[1][1] && c[1][1] < c[2][1]).toBe(true);
  await expect(page.locator('#own-jump')).toBeHidden();
  // 本部：お知らせ（左）と、止まっているブース（右）
  await page.locator('#owntab-hq').click();
  const n = (await settled('#notice-card'))[0], st = (await settled('#stale-card'))[0];
  expect(Math.abs(n[0] - st[0])).toBeLessThanOrEqual(1);
  expect(n[1]).toBeLessThan(st[1]);
  // 係員：パスワード（左）と、入れる端末（右）
  await page.locator('#owntab-staff').click();
  c = await settled('#ownpane-staff > .card');
  expect(c.length).toBe(2);
  expect(Math.abs(c[0][0] - c[1][0])).toBeLessThanOrEqual(1);
  // 準備：2列
  await page.locator('#owntab-setup').click();
  c = await settled('#ownpane-setup > .card, #ownpane-setup > details');
  expect(new Set(c.map(x => x[1])).size).toBe(2);
  for (const w of [1366, 960]) {
    await page.setViewportSize({ width: w, height: 768 });
    for (const t of ['home', 'event', 'hq', 'staff', 'setup']) {
      await page.locator('#owntab-' + t).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), w + ' ' + t).toBeLessThanOrEqual(0);
      // 中の部品が、札からはみ出していない
      const out = await page.evaluate(() => [...document.querySelectorAll('#own-main .own-pane.on .card')].filter(card => card.offsetParent).flatMap(card => {
        const a = card.getBoundingClientRect();
        return [...card.querySelectorAll('button, input, select, .seg')].filter(e => e.offsetParent && e.getBoundingClientRect().right > a.right + 0.5).map(e => (e.id || e.textContent.trim().slice(0, 10)));
      }));
      expect(out, w + ' ' + t).toEqual([]);
    }
  }
  // スマホの幅：縦に並ぶ。近道が出る
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#owntab-event').click();
  c = await settled('#ownpane-event .own-ev');
  expect(c[0][0] < c[1][0] && c[1][0] < c[2][0]).toBe(true);
  await expect(page.locator('#own-jump')).toBeVisible();
  // さっき出した見出し：出すと、次からは押すだけで欄に入る
  await expect(page.locator('#own-show-recent')).toBeHidden();
  await page.locator('#own-show-title').fill('まもなくステージ発表！');
  await page.locator('#own-show-text').fill('第一体育館へどうぞ');
  accept(page);
  await page.locator('#own-show-send').click();
  await expect(page.locator('#own-show-now')).toContainText('出しています', { timeout: 10000 });
  const recent = page.locator('#own-show-recent button');
  await expect(recent).toHaveCount(1);
  await expect(recent).toHaveText('まもなくステージ発表！');
  await expect(page.locator('#own-show-title')).toHaveValue('');
  await recent.click();
  await expect(page.locator('#own-show-title')).toHaveValue('まもなくステージ発表！');
  await expect(page.locator('#own-show-text')).toHaveValue('第一体育館へどうぞ');
  await expect(page.locator('#own-show-len')).toContainText('見出し あと19文字');
  expect(errors).toEqual([]);
});

/* ---------------- v223：抽選を係員・本部モニタにも／受け取りの場所／演出を選ぶ／ラッキーブースの効果／使い分けの案内 ---------------- */
test('イベント（v223）：一斉お知らせを「しずかに」（紙ふぶきなし）で出せる。抽選は、係員の画面・本部モニタにも出て、当たった人には受け取りの場所（受付なら地図のボタン）。ラッキーブースの効果・使い分けの案内', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  const now = Date.now();
  g.__post({ action: 'ledger', cid: 'WWWW1234', ev: ['1F-02', '1F-03', '2F-12'].map(id => ({ t: 's', id, at: now })) });
  await bridge(page, g);
  const A = await device(browser, g);
  await staffLogin(A.page, origin, PASS);
  await expect(A.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  const B = await device(browser, g);
  await B.page.setViewportSize({ width: 1366, height: 768 });
  await B.page.goto(origin + '/?mode=board');
  await loaded(B.page);
  const W = await visitor(browser, g, 'WWWW1234', ['1F-02', '1F-03', '2F-12']);
  const werr = watchErrors(W.page);
  await W.page.goto(origin + '/?tab=map');
  await loaded(W.page);
  await W.page.evaluate(() => { liveDrawCheck.wait = 0; });
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerLogin(page, origin, 'event');
  // 使い分けの案内：文の中の言葉を押すと、その画面へ
  await page.locator('#own-ev-show .own-link[data-ogo="hq"]').click();
  await expect(page.locator('#owntab-hq')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#notice-card')).toContainText('消すまで出ます');
  await page.locator('#notice-card .own-link[data-ogo="event"]').click();
  await expect(page.locator('#owntab-event')).toHaveAttribute('aria-selected', 'true');
  // 演出：しずかに → 試すと、紙ふぶきが出ない
  await expect(page.locator('#own-show-fx')).toBeVisible();
  await page.locator('#own-show-title').fill('落とし物が届いています');
  await page.locator('#own-show-fx [data-v="calm"]').click();
  await expect(page.locator('#own-show-fx [aria-pressed="true"]')).toHaveText('しずかに');
  await page.locator('#own-show-try').click();
  await expect(page.locator('#lfx.calm .lfx-title')).toHaveText('落とし物が届いています');
  await page.waitForTimeout(700);
  await expect(page.locator('.confetti')).toHaveCount(0);
  await page.locator('#lfx [data-fx="close"]').click();
  // 出す → 来場者にも、しずかに出る。出しているあいだ、ボタンは「新しく出す」
  await expect(page.locator('#own-show-send')).toHaveText('全員に出す');
  accept(page);
  await page.locator('#own-show-send').click();
  await expect(page.locator('#own-show-now')).toContainText('出しています', { timeout: 10000 });
  await expect(page.locator('#own-show-send')).toHaveText('新しく出す');
  expect(g.__get().live.show.fx).toBe('calm');
  await W.page.evaluate(() => sync(false));
  await expect(W.page.locator('#lfx.calm')).toBeVisible({ timeout: 10000 });
  await W.page.waitForTimeout(700);
  await expect(W.page.locator('.confetti')).toHaveCount(0);
  await W.page.locator('#lfx [data-fx="close"]').click();
  // 抽選（受け取りの場所は、はじめは受付）
  await expect(page.locator('#own-draw-place')).toHaveValue('受付（南棟昇降口）');
  accept(page);
  await page.locator('#own-draw-go').click();
  await expect(page.locator('#own-draw-res li b')).toHaveText('WWWW-1234', { timeout: 10000 });
  // 当たった人：受け取りの場所と、地図のボタン
  await W.page.evaluate(() => sync(false));
  await expect(W.page.locator('#lfx.win')).toBeVisible({ timeout: 15000 });
  await expect(W.page.locator('#lfx .lfx-text')).toHaveText('受付（南棟昇降口）で、この画面を見せてください');
  await expect(W.page.locator('#lfx .lfx-go')).toContainText('を地図で見る');
  await W.page.locator('#lfx .lfx-go').click();
  await expect(W.page.locator('#lfx')).toHaveCount(0);
  await expect(W.page.locator('.bsh-head h2')).toContainText('受付', { timeout: 10000 });
  await W.page.locator('#bsh-x').click();
  await W.page.locator('#nav button[data-view="stamp"]').click();
  await expect(W.page.locator('#win-card')).toContainText('受付（南棟昇降口）で、この画面を見せてください');
  await W.page.locator('#win-card .win-go').click();
  await expect(W.page.locator('.bsh-head h2')).toContainText('受付', { timeout: 10000 });
  await W.page.locator('#bsh-x').click();
  // 係員の画面・本部モニタにも、抽選があったこと
  await A.page.evaluate(() => sync(false));
  await expect(A.page.locator('#adm-live')).toContainText('スタンプの抽選がありました（1人が当たり）', { timeout: 10000 });
  await expect(A.page.locator('#adm-live')).toContainText('受付（南棟昇降口）');
  expect(await A.page.locator('#adm-live').textContent()).not.toContain('WWWW');       // 当たった番号は、係員の画面には出ない
  await B.page.evaluate(() => sync(false));
  await expect(B.page.locator('#board-live')).toContainText('抽選：1人が当たり', { timeout: 10000 });
  // 受け取りの場所を変えて、もう一度（受付でなければ、地図のボタンは出さない）
  await page.locator('#own-draw-place').fill('2階 生徒会室');
  await page.locator('#own-draw-again').check();
  accept(page);
  await page.locator('#own-draw-go').click();
  await expect(page.locator('#toast')).toContainText('抽選しました', { timeout: 10000 });
  await W.page.evaluate(() => sync(false));
  await expect(W.page.locator('#lfx.win .lfx-text')).toHaveText('2階 生徒会室で、この画面を見せてください', { timeout: 15000 });
  await expect(W.page.locator('#lfx .lfx-go')).toHaveCount(0);
  await W.page.locator('#lfx [data-fx="close"]').click();
  await W.page.locator('#nav button[data-view="stamp"]').click();
  await expect(W.page.locator('#win-card')).toContainText('2階 生徒会室');
  await expect(W.page.locator('#win-card .win-go')).toHaveCount(0);
  // ラッキーブースの効果：始めてから、そのブースでスタンプを押した人の数
  await page.locator('#own-lucky-booth').selectOption('1F-05');
  accept(page);
  await page.locator('#own-lucky-start').click();
  await expect(page.locator('#own-lucky-now')).toContainText('この間のスタンプ 0人', { timeout: 10000 });
  g.__post({ action: 'ledger', cid: 'NEWW0001', ev: [{ t: 's', id: '1F-05', at: Date.now() + 500 }] });
  for (const k of [...g.__cache.keys()]) if (k.startsWith('lks_')) g.__cache.delete(k);
  await page.evaluate(() => ownRefresh(true));
  await expect(page.locator('#own-lucky-now')).toContainText('この間のスタンプ 1人', { timeout: 10000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(werr).toEqual([]);
  await A.ctx.close(); await B.ctx.close(); await W.ctx.close();
  expect(errors).toEqual([]);
});

/* ---------------- v224：一斉お知らせの予約・タイムテーブルから・入力中の見本 ---------------- */
test('イベント（v224）：一斉お知らせを時刻で予約できる（ようすにも出て、取り消せる）。時刻が来たら来場者に出る。タイムテーブルから1回で入る。入力中の見本', async ({ page, browser, baseURL }) => {
  test.skip(nearMidnight(), '日本時間の0時の前40分は、予約の時刻が日をまたぐので飛ばす（予約はきょうの時刻だけ）');
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  const V = await visitor(browser, g);
  await V.page.goto(origin + '/?tab=map');
  await loaded(V.page);
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerLogin(page, origin, 'event');
  // 入力中の見本
  const prev = page.locator('#own-show-prev');
  await expect(prev.locator('.op-t')).toHaveText('見出し');
  await page.locator('#own-show-title').fill('まもなく最終入場');
  await page.locator('#own-show-text').fill('14:00からです');
  await expect(prev.locator('.op-t')).toHaveText('まもなく最終入場');
  await expect(prev.locator('.op-x')).toHaveText('14:00からです');
  await page.locator('#own-show-fx [data-v="calm"]').click();
  await expect(prev).toHaveClass(/calm/);
  await expect(prev.locator('.op-fx')).toContainText('しずかに');
  // 過ぎた時刻は受け付けない
  await expect(page.locator('#own-sched-row')).toBeVisible();
  await page.locator('#own-show-at').fill('00:00');
  await page.locator('#own-show-sched').click();
  await expect(page.locator('#toast')).toContainText('過ぎています');
  // 3分後に予約
  const hm = await page.evaluate(() => { const d = new Date(nowMs() + 3 * 60000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); });
  await page.locator('#own-show-at').fill(hm);
  accept(page);
  await page.locator('#own-show-sched').click();
  await expect(page.locator('#toast')).toContainText(hm + ' に予約しました', { timeout: 10000 });
  await expect(page.locator('#own-sched li')).toHaveCount(1);
  await expect(page.locator('#own-sched li b')).toHaveText(hm);
  await expect(page.locator('#own-sched li span')).toContainText('しずかに');
  await expect(page.locator('#own-show-title')).toHaveValue('');
  expect(JSON.parse(g.__props.LIVE_SCHED).sched.length).toBe(1);
  // 来場者には、まだ何も出ない
  await V.page.evaluate(() => sync(false));
  await V.page.waitForTimeout(500);
  await expect(V.page.locator('#lfx')).toHaveCount(0);
  // ようすにも出る
  await page.locator('#owntab-home').click();
  await expect(page.locator('#own-now')).toContainText('予約 ' + hm);
  // 時刻が来た（サーバーの予約の時刻を、いまにする）→ 来場者に出る。しずかに
  const o = JSON.parse(g.__props.LIVE_SCHED); o.sched[0].at = Date.now() - 1000; g.__props.LIVE_SCHED = JSON.stringify(o);
  g.clearCache_();
  await V.page.evaluate(() => sync(false));
  await expect(V.page.locator('#lfx.calm .lfx-title')).toHaveText('まもなく最終入場', { timeout: 10000 });
  await V.page.locator('#lfx [data-fx="close"]').click();
  // ようすから取り消す
  await page.locator('#owntab-event').click();
  await page.locator('#own-show-title').fill('あとで出すもの');
  const hm2 = await page.evaluate(() => { const d = new Date(nowMs() + 10 * 60000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); });
  await page.locator('#own-show-at').fill(hm2);
  accept(page);
  await page.locator('#own-show-sched').click();
  await expect(page.locator('#own-sched li')).toHaveCount(1, { timeout: 10000 });
  await page.locator('#owntab-home').click();
  accept(page);
  await page.locator('#own-now [data-stop^="sched:"]').click();
  await expect(page.locator('#toast')).toContainText('予約を取り消しました', { timeout: 10000 });
  expect(JSON.parse(g.__props.LIVE_SCHED).sched.filter(x => x.at > Date.now())).toEqual([]);
  // タイムテーブルから：きょうの、これからの行が出る。押すと、見出し・ひとこと・5分前の時刻が入る
  await page.locator('#owntab-event').click();
  const ttHm = await page.evaluate(() => {
    const d = new Date(nowMs() + 30 * 60000), today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    CONFIG.INFO.timetable = [['00:01', 'もう終わった行', '', today], [h, 'ステージ発表', '', today], [h, '別の日の行', '', '2001-01-01']];
    renderOwnLive();
    const e = new Date(d.getTime() - 5 * 60000);
    return { h, at: String(e.getHours()).padStart(2, '0') + ':' + String(e.getMinutes()).padStart(2, '0') };
  });
  const tt = page.locator('#own-show-tt button');
  await expect(tt).toHaveCount(1);
  await expect(tt).toHaveText(ttHm.h + ' ステージ発表');
  await tt.click();
  await expect(page.locator('#own-show-title')).toHaveValue('まもなく「ステージ発表」');
  await expect(page.locator('#own-show-text')).toHaveValue(ttHm.h + 'からです');
  await expect(page.locator('#own-show-at')).toHaveValue(ttHm.at);
  await expect(prev.locator('.op-t')).toHaveText('まもなく「ステージ発表」');
  // 予約すると、その行は「予約ずみ」で押せない（同じ知らせを2回予約しない）
  accept(page);
  await page.locator('#own-show-sched').click();
  await expect(page.locator('#own-sched li')).toHaveCount(1, { timeout: 10000 });
  await expect(tt).toBeDisabled();
  await expect(tt).toContainText('予約ずみ');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await V.ctx.close();
  expect(errors).toEqual([]);
});

/* ---------------- v225：ようすの移り変わりと混んでいるブース・数字が動く・取り直す・ラッキーブースの予約・本部モニタの線・振り返り ---------------- */
test('司令塔（v225）：ようすに「いま混んでいるブース」と「この3時間の混み具合」。数字が動く・取り直すボタン。ラッキーブースを時刻で予約（本部モニタに残りの線）。振り返りに、その日の司令塔の操作', async ({ page, browser, baseURL }) => {
  test.skip(nearMidnight(), '日本時間の0時の前40分は、予約の時刻が日をまたぐので飛ばす（予約はきょうの時刻だけ）');
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '1F-02', wait: 25 });
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '1F-03', wait: 18 });
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '2F-12', wait: 8 });
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '1F-05', wait: 1 });
  g.__post({ action: 'visitor', pass: PASS, cid: 'aaaa1111aaaa', n: 10, uid: 'v225a' });
  await bridge(page, g);
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerLogin(page, origin, '');
  // いま混んでいるブース：混雑 → やや混雑、待ちの多い順
  const busy = page.locator('#own-busy li');
  await expect(busy).toHaveCount(3);
  await expect(busy.nth(0)).toContainText('25人');
  await expect(busy.nth(0)).toContainText('旋盤の加工実演');
  await expect(busy.nth(1)).toContainText('18人');
  await expect(busy.nth(2)).toContainText('8人');
  await expect(busy.nth(2)).toHaveAttribute('data-lv', '1');
  // この3時間の混み具合：推移があれば出る（ここでは 30分前の記録を足して見る）
  await page.evaluate(() => {
    const d = new Date(nowMs() - 30 * 60000), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    S.booths.slice(0, 6).forEach((b, i) => { b.history = [{ t: hm, lv: i < 3 ? 2 : 1 }]; });
    renderOwnLive();
  });
  const trend = page.locator('#own-tiles .own-trend i');
  await expect(trend).toHaveCount(12);
  const hs = await trend.evaluateAll(els => els.map(i => Math.round(i.querySelector('b').getBoundingClientRect().height + i.querySelector('u').getBoundingClientRect().height)));
  expect(hs[0]).toBe(0);                                   // 3時間前は記録なし
  // グラフは札の幅いっぱい（札の中で縮んで、幅0になっていたことがある）・数字は大きい字のまま（説明文の小さい字が当たっていた）
  const box = await page.evaluate(() => { const t = document.querySelector('#own-tiles .own-trend'), tile = t.closest('.own-tile');
    return { w: t.getBoundingClientRect().width, full: tile.clientWidth, fs: parseFloat(getComputedStyle(document.querySelector('#own-tiles [data-n="vis"]')).fontSize) }; });
  expect(box.w).toBeGreaterThan(box.full * 0.8);
  expect(box.fs).toBeGreaterThanOrEqual(22);
  expect(hs[10]).toBeGreaterThan(0);                       // 30分前より後
  await expect(page.locator('#own-tiles .own-trend-ax')).toContainText('いま');
  // 数字が動く：来場者が増えたら、前の数から新しい数へ
  await expect(page.locator('#own-tiles [data-n="vis"]')).toHaveText('10');
  g.__post({ action: 'visitor', pass: PASS, cid: 'aaaa1111aaaa', n: 40, uid: 'v225b' });
  // 取り直すボタン（待たずに取り直す）
  await page.locator('#own-reload').click();
  await expect(page.locator('#own-tiles [data-n="vis"]')).toHaveText('50', { timeout: 10000 });
  await expect(page.locator('#own-reload')).not.toHaveClass(/busy/, { timeout: 10000 });
  // ラッキーブースを時刻で予約
  await page.locator('#owntab-event').click();
  await expect(page.locator('#own-lucky-sched-row')).toBeVisible();
  await page.locator('#own-lucky-booth').selectOption('1F-05');
  await page.locator('#own-lucky-min [data-v="15"]').click();
  const hm = await page.evaluate(() => { const d = new Date(nowMs() + 3 * 60000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); });
  await page.locator('#own-lucky-at').fill(hm);
  accept(page);
  await page.locator('#own-lucky-schedbtn').click();
  await expect(page.locator('#toast')).toContainText(hm + ' からのラッキーブースを予約しました', { timeout: 10000 });
  await expect(page.locator('#own-lucky-sched li')).toHaveCount(1);
  await expect(page.locator('#own-lucky-sched li')).toContainText('（15分）');
  await page.locator('#owntab-home').click();
  await expect(page.locator('#own-now')).toContainText('予約 ' + hm);
  await expect(page.locator('#own-now')).toContainText('ラッキーブース：');
  // 時刻が来た → 本部モニタに、ラッキーブースと残りの線
  const o = JSON.parse(g.__props.LIVE); o.luckySched[0].at = Date.now() - 5 * 60000; o.luckySched[0].until = Date.now() + 10 * 60000; g.__props.LIVE = JSON.stringify(o);
  g.clearCache_();
  const B = await device(browser, g);
  await B.page.setViewportSize({ width: 1366, height: 768 });
  await B.page.goto(origin + '/?mode=board');
  await loaded(B.page);
  await B.page.evaluate(() => sync(false));
  await expect(B.page.locator('#board-live')).toBeVisible({ timeout: 10000 });
  const bar = await B.page.evaluate(() => { const b = document.querySelector('#board-live'), i = b.querySelector('.lk-bar'); return { lk: parseFloat(getComputedStyle(b).getPropertyValue('--lk')), w: i.getBoundingClientRect().width, full: b.getBoundingClientRect().width }; });
  expect(bar.lk).toBeGreaterThan(0.55);
  expect(bar.lk).toBeLessThan(0.75);
  await B.ctx.close();
  // 取り消し（ようすから）は、出ているものではなく これからの予約だけ。いまは出ている
  await page.evaluate(() => ownRefresh(true));
  await expect(page.locator('#own-now')).toContainText('ラッキーブース', { timeout: 10000 });
  // 振り返り：その日の司令塔の操作
  await page.goto(origin + '/?mode=report');
  await expect(page.locator('.rep-ev li').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rep-ev')).toContainText('ラッキーブースを予約');
  await expect(page.locator('.rep-ev li time').first()).toHaveText(/^\d\d:\d\d$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

/* ---------------- v226：キーボード・読み上げ ---------------- */
test('司令塔（v226）：入ったらフォーカスは選んでいるタブ。タブは矢印キー・Home・End で移れる（選んでいないタブは Tab で飛ばす）。数字の意味を読み上げる。見出し・グラフの説明。係員のタブも矢印キーで', async ({ page, browser, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  g.__post({ action: 'update', pass: PASS, cid: 'aaaa1111aaaa', id: '1F-02', wait: 25 });
  await bridge(page, g);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/?mode=owner');
  await page.locator('#own-pw').fill(OWNER);
  await page.locator('#own-pw').press('Enter');
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  // 入ったら、フォーカスは選んでいるタブ（押した「入る」は消えている）
  await expect(page.locator('#owntab-home')).toBeFocused();
  const tabIdx = () => page.evaluate(() => [...document.querySelectorAll('.own-tabs [role="tab"]')].map(t => t.tabIndex));
  expect(await tabIdx()).toEqual([0, -1, -1, -1, -1]);
  // 矢印キー → 次のタブを開く。End → 最後。Home → 最初。左の端から ← → 最後へ回る
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#owntab-event')).toBeFocused();
  await expect(page.locator('#owntab-event')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ownpane-event')).toBeVisible();
  expect(await tabIdx()).toEqual([-1, 0, -1, -1, -1]);
  await page.keyboard.press('End');
  await expect(page.locator('#owntab-setup')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(page.locator('#owntab-home')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#owntab-setup')).toBeFocused();
  // 数字の意味（本部に、止まっているブースの数）
  const stale = await page.evaluate(() => S.booths.filter(b => isVenue(b) && lvOf(b).lv !== 3 && elapsedMin(b) >= CONFIG.ADMIN_WARN_MIN).length);
  await expect(page.locator('#owntab-hq')).toHaveAttribute('aria-label', `本部（更新が止まっているブース ${stale}件）`);
  await expect(page.locator('#owntab-staff')).toHaveAttribute('aria-label', '係員');
  // 札の見出しは、見出しとして読める
  expect(await page.evaluate(() => [...document.querySelectorAll('#v-owner .card-t')].every(e => e.getAttribute('role') === 'heading' && e.getAttribute('aria-level') === '3'))).toBe(true);
  // 3時間のグラフの説明（時刻ごとの数）
  await page.evaluate(() => { const d = new Date(nowMs() - 30 * 60000), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); S.booths.slice(0, 4).forEach(b => { b.history = [{ t: hm, lv: 2 }]; }); renderOwnLive(); });
  await expect(page.locator('#own-tiles .own-trend')).toHaveAttribute('aria-label', /^この3時間の混み具合：.*いま 混雑\d+・やや混雑\d+$/);
  // 係員のタブも、矢印キーで
  const A = await device(browser, g);
  await staffLogin(A.page, origin, PASS);
  await expect(A.page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await A.page.locator('#admtab-update').click();
  await A.page.locator('#admtab-update').focus();
  await A.page.keyboard.press('ArrowRight');
  await expect(A.page.locator('#admtab-recept')).toBeFocused();
  await expect(A.page.locator('#admtab-recept')).toHaveAttribute('aria-selected', 'true');
  await expect(A.page.locator('#admpane-recept')).toBeVisible();
  expect(await A.page.evaluate(() => [...document.querySelectorAll('.adm-tabs [role="tab"]')].map(t => t.tabIndex))).toEqual([-1, 0]);
  await A.ctx.close();
  expect(errors).toEqual([]);
});

/* ---------------- v227：置きっぱなしの司令塔・予約の1分前 ---------------- */
test('司令塔（v227）：20分 操作が無ければ取り直しを止める（「再開する」で戻る）。予約した一斉お知らせが出る1分前に知らせる（取り消せる）', async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const { g, origin } = server(baseURL);
  await bridge(page, g);
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerLogin(page, origin, '');
  let polls = 0;
  page.on('request', r => { if (/"action":"owner_state"/.test(r.postData() || '')) polls++; });
  // 21分前に触ったことにする → 取り直しを止め、知らせを出す
  await page.evaluate(() => { OWN.touchAt = Date.now() - 21 * 60000; renderOwner(); });
  await expect(page.locator('#own-idle')).toBeVisible();
  expect(await page.evaluate(() => OWN.timer)).toBeTruthy();
  polls = 0;
  await page.waitForTimeout(9000);
  expect(polls).toBe(0);                                                    // 8秒ごとの取り直しが止まっている
  await page.locator('#own-idle-go').click();
  await expect(page.locator('#own-idle')).toBeHidden();
  await expect.poll(() => polls, { timeout: 10000 }).toBeGreaterThan(0);
  // 予約の1分前：知らせ（取り消すボタンつき）。1件に1回
  const at = Date.now() + 45000;
  g.__post({ action: 'owner_show', token: await page.evaluate(() => ownToken()), title: 'まもなく最終入場', at: at + 10000 });
  await page.evaluate(() => ownRefresh(true));
  await expect(page.locator('#toast')).toContainText('一斉お知らせ「まもなく最終入場」が出ます', { timeout: 10000 });
  await expect(page.locator('#toast .toast-act')).toHaveText('取り消す');
  accept(page);
  await page.locator('#toast .toast-act').click();
  await expect.poll(() => (JSON.parse(g.__props.LIVE_SCHED || '{"sched":[]}').sched || []).length, { timeout: 10000 }).toBe(0);
  expect(errors).toEqual([]);
});
