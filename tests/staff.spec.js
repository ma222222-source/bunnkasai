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
/** 司令塔に入った状態にして、tab の画面を開く（サーバーは模擬。司令塔の操作にだけ、決まった返事を返す） */
async function ownerIn(page, tab) {
  const st = { ok: true, approval: false, devices: [], keys: [], passLen: 18, passAt: '', live: {}, sv: '2026-10-14b' };
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    if (/"action":"owner_/.test(route.request().postData() || '')) {
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json',
        body: JSON.stringify(Object.assign({ token: 'a'.repeat(64), state: st }, st)) });
    }
    return route.fallback();
  });
  await page.evaluate(() => { sessionStorage.setItem('kuroko_owner', 'a'.repeat(64)); return openOwner(); });
  await expect(page.locator('#own-main')).toBeVisible({ timeout: 10000 });
  await page.locator('#owntab-' + tab).click();
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
  await ownerIn(page, 'hq');                                          // お知らせの欄は、はじめから開いている（v220）
  await page.locator('#notice-tpl [data-tpl]').first().click();
  await expect(page.locator('#notice-text')).toHaveValue(/落とし物/);
  expect(log.posts.filter(p => p.action === 'notice').length).toBe(0);
});

test('本部「更新が止まっているブース」：長い順に出て、押すとそのブースの更新カードへ', async ({ page }) => {
  await login(page, { grouped: true });
  await ownerIn(page, 'hq');
  const items = page.locator('#stale-list [data-goto]');
  await expect.poll(() => items.count()).toBeGreaterThan(0);
  const id = await items.first().getAttribute('data-goto');
  await items.first().click();
  await expect(page.locator('#admpane-update')).toBeVisible();
  await expect(page.locator(`#admin-list .adm-booth[data-id="${id}"]`)).toBeVisible();
});

test('係員：1分以内にほかの端末の更新があったブースを送ると知らせる（送信はする）', async ({ page }) => {
  const log = await login(page, { mutate: j => { j.booths.forEach(b => { b.status = '空いています'; b.wait = 1; b.time = new Date(Date.now() - 20000).toISOString(); }); } });
  const card = page.locator('#admin-list .adm-booth').first();
  const id = await card.getAttribute('data-id');
  await card.locator('[data-step="1"]').click();
  await card.locator('.send').click();
  await expect(page.locator(`.adm-booth[data-id="${id}"] .adm-preview`)).toContainText('ほかの端末からも更新');
  await expect.poll(() => log.posts.some(p => p.action === 'update' && p.id === id)).toBe(true);
});

/* ---------------- v180 ---------------- */
test('ログインしたあとブラウザの「戻る」を押しても、パスワードの画面は出ない', async ({ page }) => {
  await mockGas(page, { verifyOk: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await page.goto('/?mode=admin');
  await page.locator('#pw').fill('test-password-1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => history.back());
  await page.waitForTimeout(500);
  await expect(page.locator('#v-auth')).toBeHidden();
  await expect(page.locator('#v-admin')).toBeVisible();
  // 進んでも同じ
  await page.evaluate(() => history.forward());
  await page.waitForTimeout(400);
  await expect(page.locator('#v-auth')).toBeHidden();
});

test('横向き（高さの低い画面）でも、ログインの画面・係員の画面が横にはみ出さない', async ({ page }) => {
  await mockGas(page, { verifyOk: true });
  for (const [w, h] of [[844, 390], [640, 360]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?mode=admin');
    await expect(page.locator('#v-auth, #v-admin').first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${w}x${h} ログイン`).toBeLessThanOrEqual(1);
  }
});

/* ---------------- v211：パソコンの幅では2列（待ち人数の −＋ が画面の両端に離れない） ---------------- */
test('係員の画面：パソコンの幅（900px 以上）ではブースを2列に並べる。スマホの幅では1列のまま', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const geo = () => page.evaluate(() => { const cs = [...document.querySelectorAll('#admin-list .adm-booth')].slice(0, 3).map(c => c.getBoundingClientRect());
    const st = document.querySelector('#admin-list .adm-booth').querySelectorAll('.adm-wait .step'), a = st[0].getBoundingClientRect(), z = st[st.length - 1].getBoundingClientRect();
    return { tops: cs.map(r => Math.round(r.top)), lefts: cs.map(r => Math.round(r.left)), w: Math.round(cs[0].width), span: Math.round(z.right - a.left), over: document.documentElement.scrollWidth - innerWidth }; });
  // スマホ：1列
  let g = await geo();
  expect(g.lefts[0]).toBe(g.lefts[1]);
  expect(g.tops[1]).toBeGreaterThan(g.tops[0]);
  // パソコン：2列。−5 から ＋5 までの幅が、画面の半分ほどに収まる
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(200);
  g = await geo();
  expect(g.tops[0]).toBe(g.tops[1]);
  expect(g.lefts[1]).toBeGreaterThan(g.lefts[0] + 300);
  expect(g.tops[2]).toBeGreaterThan(g.tops[0]);
  expect(g.span).toBeLessThan(560);                         // 1列のときは 1000px 以上に広がっていた
  expect(g.over).toBeLessThanOrEqual(0);
  // 2列でも、押して送れる
  const card = page.locator('#admin-list .adm-booth').nth(1);
  await card.locator('[data-step="1"]').click();
  await expect(card.locator('.adm-wait-n')).toHaveText('1');
  expect(errors).toEqual([]);
});

/* ---------------- v213：サーバーが「受け取れない」と返した更新は、送り直しの列に残さない ---------------- */
test('係員の更新：サーバーが「この中身は受け取れない」と返したら、元に戻して理由を出す（「電波が戻ったら送ります」と持ち続けない）。通信の失敗は、これまでどおり持っておく', async ({ page }) => {
  const errors = watchErrors(page);
  const log = await login(page);
  let reject = 'bad wait: 待ち人数は 0〜999 の数にしてください';
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    const req = route.request();
    if (req.method() !== 'POST' || !reject) return route.fallback();
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (e) {}
    if (b.action === 'verify' || b.action === 'ledger' || b.action === 'clientlog') return route.fallback();
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ ok: false, error: reject, status: 'error' }) });
  });
  const card = page.locator('#admin-list .adm-booth').first();
  const id = await card.getAttribute('data-id');
  await card.locator('[data-step="5"]').click();
  await card.locator('.send').click();
  // 理由が日本語で出る（先頭の合図「bad wait:」は見せない）
  await expect(page.locator('#toast')).toContainText('送れませんでした：待ち人数は 0〜999');
  await expect(page.locator('#toast')).not.toContainText('bad wait');
  // 送り直しの列に残っていない・「未送信」の印も付かない
  expect(await page.evaluate(id => ({ unsent: id in S.unsent, saved: JSON.stringify(load('kuroko_unsent', {})).includes(id) }), id)).toEqual({ unsent: false, saved: false });
  await expect(page.locator(`#admin-list .adm-booth[data-id="${id}"]`)).not.toHaveClass(/unsent/);
  // そのブースがもう無い、と返ったときも同じ
  reject = '該当するIDがありません: ' + id;
  const card2 = page.locator(`#admin-list .adm-booth[data-id="${id}"]`);
  await card2.locator('[data-step="1"]').click();
  await card2.locator('.send').click();
  await expect(page.locator('#toast')).toContainText('送れませんでした：該当するIDがありません');
  expect(await page.evaluate(id => id in S.unsent, id)).toBe(false);
  // サーバーが混んでいる（busy）ときは、これまでどおり持っておいて送り直す
  reject = 'busy: 混み合っています。少し待ってもう一度押してください';
  await card2.locator('[data-step="1"]').click();
  await card2.locator('.send').click();
  await expect(page.locator('#toast')).toContainText('混み合っています');
  expect(await page.evaluate(id => id in S.unsent, id)).toBe(true);
  expect(errors).toEqual([]);
});

/* ---------------- v214：係員の画面の7つの仕上げ ---------------- */
test('①②ログイン：「表示する」で打った字を見られる。全角が入っていたら知らせ、1押しで半角に直せる。入れたあとは欄を空にして隠す', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page, { verifyOk: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?mode=admin');
  const pwEl = page.locator('#pw'), show = page.locator('#pw-show'), zen = page.locator('#pw-zen');
  await expect(pwEl).toHaveAttribute('type', 'password');
  await expect(zen).toBeHidden();
  // 「表示する」→ 字が見える。もう一度で隠れる
  await pwEl.fill('Abc-1234');
  await show.click();
  await expect(pwEl).toHaveAttribute('type', 'text');
  await expect(show).toHaveAttribute('aria-pressed', 'true');
  await expect(show).toHaveText('かくす');
  await show.click();
  await expect(pwEl).toHaveAttribute('type', 'password');
  await expect(show).toHaveText('表示する');
  // ボタンは欄の中の右。押す大きさ 44px 以上。字と重ならない
  const g = await page.evaluate(() => { const a = document.getElementById('pw').getBoundingClientRect(), b = document.getElementById('pw-show').getBoundingClientRect();
    return { in: b.left >= a.left && b.right <= a.right + 1 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1, h: b.height, w: b.width, pad: parseFloat(getComputedStyle(document.getElementById('pw')).paddingRight) }; });
  expect(g.in).toBe(true); expect(g.h).toBeGreaterThanOrEqual(44); expect(g.pad).toBeGreaterThanOrEqual(g.w);
  // 全角：知らせが出る → 「半角に直す」
  await pwEl.fill('ｔｅｓｔ－ｐａｓｓｗｏｒｄ－１２３４');
  await expect(zen).toBeVisible();
  await expect(zen).toContainText('全角');
  await page.locator('#pw-zen-fix').click();
  await expect(pwEl).toHaveValue('test-password-1234');
  await expect(zen).toBeHidden();
  // 日本語の字（ひらがな・漢字）は、全角の知らせの対象にしない（英数字・記号だけ）
  await pwEl.fill('あいう漢字');
  await expect(zen).toBeHidden();
  // ログインできたら、欄は空・隠す状態に戻る
  await pwEl.fill('test-password-1234');
  await show.click();
  await page.locator('#btn-login').click();
  await expect(page.locator('#v-admin')).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => ({ v: document.getElementById('pw').value, t: document.getElementById('pw').type, s: document.getElementById('pw-show').getAttribute('aria-pressed') }))).toEqual({ v: '', t: 'password', s: 'false' });
  expect(errors).toEqual([]);
});

test('①ログイン：パスワードが違うときは、確かめる点（表示する・大文字小文字・全角）も言う', async ({ page }) => {
  await mockGas(page, { verifyOk: false });
  // 本番のサーバーと同じ返事（unauthorized）にする
  await page.route(/script\.google(usercontent)?\.com\//, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unauthorized', status: 'error' }) })
    : route.fallback());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?mode=admin');
  await page.locator('#pw').fill('chigau-pass-0000');
  await page.locator('#btn-login').click();
  await expect(page.locator('#auth-err')).toContainText('パスワードが違います');
  await expect(page.locator('#auth-err')).toContainText('表示する');
  await expect(page.locator('#auth-err')).toContainText('全角');
});

test('③お菓子の交換コード：あと何秒で変わるかの線が時計に合っている。毎分0秒に番号が変わる（15秒おくれない）', async ({ page }) => {
  const errors = watchErrors(page);
  await page.clock.install({ time: new Date('2026-10-24T11:20:42+09:00') });        // 分の 42秒
  await login(page);
  await page.locator('#admtab-recept').click();
  const code = page.locator('#adm-code');
  await expect(code).toHaveText(/^\d{4}$/);
  const c0 = await code.textContent();
  // 線：60秒で1周。いま 42〜45秒あたり
  const bar = await page.locator('#code-left').evaluate(el => { const cs = getComputedStyle(el); return { name: cs.animationName, dur: parseFloat(cs.animationDuration), delay: parseFloat(cs.animationDelay), sec: (Date.now() % 60000) / 1000 }; });
  expect(bar.name).toBe('code-drain'); expect(bar.dur).toBe(60);
  expect(Math.abs(-bar.delay - bar.sec)).toBeLessThan(6);
  expect(-bar.delay).toBeGreaterThan(40);
  // 番号は、時計から作った番号と同じ
  expect(c0).toBe(await page.evaluate(() => redeemCode()));
  // 分が変わる（21:00）→ すぐ変わる
  const left = await page.evaluate(() => 60000 - (Date.now() % 60000));
  await page.clock.runFor(left + 400);
  const c1 = await page.evaluate(() => redeemCode());
  await expect(code).toHaveText(c1);
  const d1 = await page.locator('#code-left').evaluate(el => parseFloat(getComputedStyle(el).animationDelay));
  expect(-d1).toBeLessThan(3);                                 // 線は、はじめ（満ちた状態）に戻っている
  expect(errors).toEqual([]);
});

test('④準備の画面のボタンは、どれにも絵が付き、間隔がそろっている', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await ownerIn(page, 'setup');
  const r = await page.evaluate(() => { const els = [...document.querySelectorAll('#ownpane-setup .own-links > a.btn')];
    const rs = els.map(e => e.getBoundingClientRect());
    const tops = [...new Set(rs.map(x => Math.round(x.top)))].sort((a, b) => a - b);
    return { n: els.length, icons: els.map(e => !!e.querySelector('svg.ic')), h: rs.map(x => Math.round(x.height)), gaps: tops.slice(1).map((t, i) => t - tops[i]) }; });
  expect(r.n).toBe(5);
  expect(r.icons).toEqual([true, true, true, true, true]);
  expect(Math.min(...r.h)).toBeGreaterThanOrEqual(44);
  expect(new Set(r.gaps).size, JSON.stringify(r)).toBe(1);           // 段の間隔がそろっている（以前は、三つ折りパンフレットの下だけ広かった）
  expect(errors).toEqual([]);
});

test('⑥⑦本部：止まっているブースが全部で何件か（出すのは5件だけ）と、いちばん新しい更新を出す', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await ownerIn(page, 'hq');
  const sum = page.locator('#stale-sum');
  await expect(sum).toBeVisible();
  const total = await page.evaluate(() => S.booths.filter(b => isVenue(b) && lvOf(b).lv !== 3 && elapsedMin(b) >= CONFIG.ADMIN_WARN_MIN).length);
  expect(total).toBeGreaterThan(5);
  await expect(sum).toContainText(total + '件');
  await expect(sum).toContainText('長い順に5件を表示');
  await expect(page.locator('#stale-list li')).toHaveCount(5);
  await expect(sum).toContainText('いちばん新しい更新：たった今');
  // 1つ更新すると、数が減る
  await page.evaluate(() => { const b = S.booths.filter(x => isVenue(x) && lvOf(x).lv !== 3 && elapsedMin(x) >= CONFIG.ADMIN_WARN_MIN)[0]; b.status = '空いています'; b.time = new Date().toISOString(); b.stale = false; renderAdmin(); });
  await expect(sum).toContainText((total - 1) + '件');
  // だれも更新していないとき
  await page.evaluate(() => { S.lastUpdate = null; S.booths.forEach(b => { b.time = null; b.status = ''; }); renderStaleList._fp = null; renderAdmin(); });
  await expect(sum).toContainText('まだ、どのブースも更新されていません');
  expect(errors).toEqual([]);
});

/* ---------------- v230：係員の画面の仕上げ ---------------- */
test('係員の画面（v230）：階のボタンが1列・検索欄は左寄せ・送る前の色の印・長い名前は2行・0人の「−」は薄い・状態のボタンの色の線', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // ①「すべて表示・1階・2階・3階」が1列に並ぶ（階のボタンに空の丸を置かない）
  const rowOf = () => page.evaluate(() => Array.from(document.querySelectorAll('#assign-chips > .chip')).map(el => Math.round(el.getBoundingClientRect().top)));
  expect((await rowOf()).length).toBe(4);
  await expect.poll(async () => new Set(await rowOf()).size, { message: JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('#assign-chips > .chip')).map(el => [el.textContent.trim(), Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().top)]))) }).toBe(1);
  expect(await page.locator('#assign-chips .as-grp i').count()).toBe(0);
  // ②担当ブースの検索欄は左寄せ・ふつうの字の間
  expect(await page.locator('#assign-q').evaluate(el => [getComputedStyle(el).textAlign, getComputedStyle(el).letterSpacing])).toEqual(['left', 'normal']);
  const card = page.locator('#admin-list .adm-booth').first();
  // ⑤0人のときの「−」は薄い。1人にすると戻る
  const op = () => card.locator('[data-step="-1"]').evaluate(el => Number(getComputedStyle(el).opacity));
  expect(await op()).toBeLessThan(0.5);
  await card.locator('[data-step="1"]').click();
  expect(await op()).toBe(1);
  // ③送る前の色の印：人数で 空き → やや混雑 → 混雑
  const pv = card.locator('.adm-preview');
  await expect(pv).toHaveAttribute('data-lv', '0');
  await card.locator('[data-step="5"]').click();
  await expect(pv).toHaveAttribute('data-lv', '1');
  await card.locator('[data-step="5"]').click();
  await card.locator('[data-step="5"]').click();
  await expect(pv).toHaveAttribute('data-lv', '2');
  expect(await pv.evaluate(el => getComputedStyle(el, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  // ⑥状態のボタンに、その色の線
  const sh = await card.locator('.adm-btns button').evaluateAll(els => els.map(el => getComputedStyle(el).boxShadow));
  expect(sh.every(x => /inset/.test(x))).toBe(true);
  expect(new Set(sh).size).toBe(3);
  // ④長いブース名は2行まで（1行で「…」にしない）。どのカードも名前が切れていない
  const cut = await page.evaluate(() => Array.from(document.querySelectorAll('#admin-list .adm-nm')).filter(el => el.scrollHeight > el.clientHeight + 2).map(el => el.textContent));
  expect(cut).toEqual([]);
  const tall = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('#admin-list .adm-nm')).map(el => Math.round(el.getBoundingClientRect().height))));
  expect(tall).toBeGreaterThan(20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
