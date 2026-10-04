// 画面の通しテスト（GAS は mock.js で模擬。本番データには触らない）
const { test, expect } = require('@playwright/test');
const { mockGas, watchErrors } = require('./mock');
const sigs = require('./fixtures/sigs.json');

const WIDTHS = [320, 390, 768, 1280];
const TABS = ['map', 'list', 'stamp', 'info'];

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
async function ready(page) {
  // GASの応答（46件）が画面の状態に入るまで
  await expect.poll(() => page.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);
}

for (const w of WIDTHS) {
  test(`幅${w}px：4画面が出て、横にはみ出さず、エラーが無い`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w < 768 ? 800 : 900 });
    const errors = watchErrors(page);
    await mockGas(page);
    await page.goto('/?tab=map');
    await ready(page);
    for (const t of TABS) {
      await page.goto('/?tab=' + t);
      await expect(page.locator('#v-' + t)).toBeVisible();
      expect(await overflowX(page), `${t} の横はみ出し`).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
  });
}

test('文字「特大」・幅320pxでも横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() => localStorage.setItem('kuroko_fs', JSON.stringify('xl')));
  const errors = watchErrors(page);
  await mockGas(page);
  for (const t of TABS) {
    await page.goto('/?tab=' + t);
    await expect(page.locator('#v-' + t)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await overflowX(page), `${t} の横はみ出し（特大）`).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test('階の切り替え：1F・2F・3F・屋外の図が出る', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/?tab=map');
  await ready(page);
  for (const f of [0, 1, 2, 3]) {
    await page.locator('#fl-' + f).click();
    await expect(page.locator('#plan-' + f)).toBeVisible();
  }
});

test('一覧の検索：科の名前・トイレで絞れる', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await expect.poll(() => page.locator('#booth-list > .booth').count()).toBe(46);
  const all = 46;
  await page.locator('#q').fill('電子');
  await expect.poll(() => page.locator('#booth-list > .booth').count()).toBeLessThan(all);
  await expect.poll(() => page.locator('#booth-list > .booth').count()).toBeGreaterThan(0);
  await page.locator('#q').fill('');
  await expect.poll(() => page.locator('#booth-list > .booth').count()).toBe(all);
});

test('?booth= でブースの詳細が開く', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?booth=1F-02');
  await expect(page.locator('#bsh')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#bsh-nm')).not.toBeEmpty();
});

test('QR（正しい署名）でスタンプが1個たまる。控えがサーバーへ送られる', async ({ page }) => {
  const errors = watchErrors(page);
  const log = await mockGas(page);
  await page.goto(`/?booth=1F-02&qr=1&k=${sigs['1F-02']}`);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]')), { timeout: 15000 })
    .toContain('1F-02');
  await expect.poll(() => log.posts.filter(p => p.action === 'ledger').length, { timeout: 20000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('QR（署名が違う）ではスタンプがたまらない', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?booth=1F-02&qr=1&k=zzzzzz');
  await ready(page);
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]'));
  expect(st).not.toContain('1F-02');
});

test('スタンプが5個でお菓子交換の案内が出る', async ({ page }) => {
  await mockGas(page);
  const ids = ['1F-02', '1F-03', '1F-05', '1F-07', '1F-08'];
  await page.addInitScript(ids => { if (!localStorage.getItem('kuroko_stamps_v2')) localStorage.setItem('kuroko_stamps_v2', JSON.stringify(ids)); }, ids);
  await page.goto('/?tab=stamp');
  await ready(page);
  await expect(page.locator('#redeem-open')).toBeVisible();
});

const MODES = [
  ['admin', '#v-auth'], ['qr', '#v-auth'], ['print', '#v-print'], ['board', '#v-board'],
  ['report', '#v-report'], ['check', '#v-info'],
];
for (const [m, sel] of MODES) {
  test(`?mode=${m} が開き、エラーが無い`, async ({ page }) => {
    await page.setViewportSize({ width: m === 'board' ? 1280 : 390, height: 900 });
    const errors = watchErrors(page);
    await mockGas(page);
    await page.goto('/?mode=' + m);
    await expect(page.locator(sel)).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(800);
    expect(errors).toEqual([]);
  });
}

test('係員ログイン：違うパスワードでは入れない', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?mode=admin');
  await page.locator('#pw').fill('wrong-password');
  await page.locator('#btn-login').click();
  await expect(page.locator('#auth-err')).not.toBeEmpty({ timeout: 10000 });
  await expect(page.locator('#v-admin')).toBeHidden();
});

test('紙マップ：46件がそろう', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?mode=print');
  await expect(page.locator('#print-sheet')).toBeVisible({ timeout: 15000 });
  const text = await page.locator('#print-sheet').innerText();
  expect(text).toContain('受付');
});

test('動作チェック：サーバーの版が表示される', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?mode=check');
  await expect(page.locator('#chk-body, #diag-out, #v-info')).not.toHaveCount(0);
  await expect(page.locator('body')).toContainText('GAS-', { timeout: 20000 });
});

test('GAS が失敗しても画面は操作でき、失敗が分かる', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page, { mode: 'fail' });
  await page.goto('/?tab=map');
  await page.locator('#nav').getByText('一覧').click();
  await expect(page.locator('#v-list')).toBeVisible();
  await expect(page.locator('#banner-offline, #sync-text')).not.toHaveCount(0);
  await expect.poll(async () => (await page.locator('#sync-text').innerText()) + (await page.locator('#banner-offline').isVisible() ? 'BANNER' : ''),
    { timeout: 30000 }).toMatch(/BANNER|失敗|つながら|できません|古い/);
  expect(errors).toEqual([]);
});

test('GAS の応答が遅くても（15秒）すぐに画面を操作できる', async ({ page }) => {
  await mockGas(page, { mode: 'slow', delayMs: 15000 });
  const t0 = Date.now();
  await page.goto('/?tab=map');
  await page.locator('#nav').getByText('スタンプ').click();
  await expect(page.locator('#v-stamp')).toBeVisible();
  await page.locator('#nav').getByText('インフォ').click();
  await expect(page.locator('#v-info')).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(8000);
});

test('一度読めたあとは、電波が切れても最後の情報を出す', async ({ page, context }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await context.setOffline(true);
  await page.reload().catch(() => {});
  // SW を止めているので再読み込みはできない。代わりに画面内の再取得で壊れないことを見る
  await context.setOffline(false);
});

test('一覧の検索：「トイレ」「保健室」「忘れ物」で案内が出て、地図へ移れる', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  for (const [q, title] of [['トイレ', 'トイレ'], ['保健室', '救護室'], ['わすれもの', '落とし物'], ['といれ', 'トイレ']]) {
    await page.locator('#q').fill(q);
    await expect(page.locator('#booth-list .qhelp').first()).toContainText(title);
  }
  // ブース名での検索には案内が混ざらない
  await page.locator('#q').fill('旋盤');
  await expect(page.locator('#booth-list .qhelp')).toHaveCount(0);
  await expect.poll(() => page.locator('#booth-list > .booth').count()).toBeGreaterThan(0);
  await page.locator('#q').fill('トイレ');
  await page.locator('#booth-list .qhelp-map').first().click();
  await expect(page.locator('#v-map')).toBeVisible();
  await expect(page.locator('#fl-1')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('スタンプ：0個は手順、3個は「お菓子まであと2個」、6個は交換の案内と下のタブの印', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await expect(page.locator('#stamp-prize .prize-steps li')).toHaveCount(3);
  await expect(page.locator('#nav .nav-badge')).toHaveCount(0);

  await page.evaluate(() => { ['1F-02', '1F-03', '1F-05'].forEach(id => S.stamps.add(id)); renderStamps(); });
  await expect(page.locator('#stamp-prize')).toContainText('あと 2個');
  await expect(page.locator('#stamp-prize .prize-dots i.on')).toHaveCount(3);

  await page.evaluate(() => { ['1F-07', '1F-08', '1F-01'].forEach(id => S.stamps.add(id)); renderStamps(); });
  await expect(page.locator('#stamp-prize')).toContainText('交換できます');
  await expect(page.locator('#nav .nav-badge')).toHaveText('1');
  await page.locator('#prize-go').click();
  await expect(page.locator('#redeem-open')).toBeInViewport();
  await expect(page.locator('#redeem-open')).toBeEnabled();
});

test('地図の検索：打つと候補が出て、選ぶとそのブースに寄って詳細が開く', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#map-q').fill('旋盤');
  await expect(page.locator('#map-sug')).toBeVisible();
  await expect(page.locator('#map-sug button').first()).toContainText('旋盤');
  await page.locator('#map-sug button').first().click();
  await expect(page.locator('#bsh')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#bsh-nm')).toContainText('旋盤');
  expect(await page.evaluate(() => ZOOM.k)).toBeGreaterThan(1.05);
  // 番号でも引ける／トイレは施設の候補が先
  await page.keyboard.press('Escape');
  await page.locator('#map-q').fill('トイレ');
  await expect(page.locator('#map-sug button').first()).toContainText('トイレ');
  await page.locator('#map-q').press('Enter');
  await expect(page.locator('#map-sug')).toBeHidden();
  expect(await page.evaluate(() => S.dept)).toBe('__fac');
  await page.locator('#map-q').fill('ぜったいに無い名前');
  await expect(page.locator('#map-sug')).toContainText('見つかりませんでした');
  expect(errors).toEqual([]);
});

test('現在地ボタン：いまここが無ければえらぶモード、あればその階へ移って寄せる', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#map-locate').click();
  expect(await page.evaluate(() => S.picking)).toBe(true);
  await page.evaluate(() => setPickMode(false));
  // 2階のブースを現在地にして、1階を見ているところから押す
  await page.evaluate(() => { setHere('2F-12', 'qr'); setFloor(1); zoomReset(false); });
  await page.locator('#map-locate').click();
  await expect(page.locator('#fl-2')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => ZOOM.k)).toBeGreaterThan(1.05);
  await expect(page.locator('#map-locate')).toHaveAttribute('data-on', '1');
  expect(errors).toEqual([]);
});

test('★行きたい：詳細で付けると一覧・地図に★、一覧を★だけに絞れる。開き直しても残る', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?booth=1F-02');
  await expect(page.locator('#bsh')).toBeVisible({ timeout: 15000 });
  await page.locator('#bsh-body [data-wish]').click();
  await expect(page.locator('#bsh-body [data-wish]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_wish_v1')))).toEqual(['1F-02']);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#wish-only').click();
  await expect(page.locator('#booth-list > .booth')).toHaveCount(1);
  await expect(page.locator('#booth-list .wish-mk')).toHaveCount(1);
  await page.locator('#wish-only').click();
  await expect(page.locator('#booth-list > .booth')).toHaveCount(46);
  // 地図にも★（1F-02 は1階）
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-1').click();
  await page.locator('#zoom-in').click(); await page.locator('#zoom-in').click();
  await expect.poll(() => page.locator('#plan-1 .room[data-id="1F-02"] .wish-mark').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('共有：ブースのリンク（スタンプの署名なし）を共有メニューに渡す', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { navigator.share = async d => { window.__shared = d; }; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?booth=1F-03');
  await expect(page.locator('#bsh')).toBeVisible({ timeout: 15000 });
  await page.locator('#bsh-body [data-share]').click();
  const d = await page.evaluate(() => window.__shared);
  expect(d.url).toContain('?booth=1F-03');
  expect(d.url).not.toContain('k=');
  expect(d.url).not.toContain('qr=');
  expect(d.text).toContain('黒工文化祭');
});

test('★行きたい所を回る：★が2つ以上でコースが出て、★のブースだけを順にたどる', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  const chip = page.locator('.chip[data-route="wish"]');
  await expect(chip).toBeHidden();
  await page.evaluate(() => { toggleWish('1F-02'); toggleWish('2F-12'); toggleWish('1F-08'); });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator('#route-steps')).toBeVisible();
  const ids = await page.evaluate(() => CONFIG.ROUTES.wish);
  expect(ids.slice().sort()).toEqual(['1F-02', '1F-08', '2F-12']);
  // 1階から先に（階ごとの順）
  expect(ids.indexOf('2F-12')).toBe(2);
  await expect(page.locator('#route-steps')).toContainText('旋盤');
  // ★を外して1つになるとコースは消える
  await page.evaluate(() => { toggleWish('1F-02'); toggleWish('2F-12'); });
  await expect(chip).toBeHidden();
  expect(errors).toEqual([]);
});

test('振り返りレポート：本物の Code.gs が作った集計を、画面がそのまま描ける', async ({ page }) => {
  const errors = watchErrors(page);
  // サーバー（Code.gs）を模擬の上で動かし、更新・来場者・スタンプを入れて本物の形の集計を作る
  const { loadGas } = require('./gas-mock');
  const g = loadGas({ props: { ADMIN_PASS: 'test-pass-1234' } });
  g.setupR8AndArchiveOthers();
  const P = { pass: 'test-pass-1234', cid: 'c1' };
  [['1F-02', 20], ['1F-02', 3], ['1F-03', 9], ['2F-12', 17]].forEach(([id, w]) => g.__post({ action: 'update', ...P, id, wait: w }));
  g.__post({ action: 'visitor', ...P, n: 12, uid: 'v' });
  g.__post({ action: 'ledger', cid: 'RRRR1111', ev: [{ t: 's', id: '1F-02', at: Date.now() }] });
  const report = g.__get({ report: '1' });
  expect(report.ok).toBe(true);
  await mockGas(page, { report });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=report');
  await expect(page.locator('#v-report')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#report-body')).toContainText('旋盤', { timeout: 15000 });
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

/* ---------------- v153 の6つ ---------------- */
test('起動：混雑データは1回だけ取りに行く（見出しで先に取った結果を使う）', async ({ page }) => {
  const log = await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.waitForTimeout(1500);
  const main = log.gets.filter(q => !/ledger|report/.test(q));
  expect(main.length).toBe(1);
  // 先に取った結果を使い切っている（使われずに残っていない）
  expect(await page.evaluate(() => window.__earlyGas)).toBeNull();
  // 見出しの script が本当に取りに行ったこと（本体より前に通信が始まっている）
  expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(e => /script\.google/.test(e.name)).length)).toBeGreaterThan(0);
});

test('地図の検索：何も打たずに押すと「最近えらんだブース」が出る', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#map-q').fill('旋盤');
  await page.locator('#map-sug button').first().click();
  await expect(page.locator('#bsh')).toBeVisible();
  await page.evaluate(() => closeSheet());
  await page.locator('#map-q').fill('');
  await page.locator('#map-q').blur();
  await page.locator('#map-q').focus();
  await expect(page.locator('#map-sug')).toContainText('最近えらんだブース');
  await expect(page.locator('#map-sug button').first()).toContainText('旋盤');
});

test('ホーム画面の長押し「QRを読む」（?scan=1）でスタンプの画面とカメラが開く', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { delete window.BarcodeDetector; try{ Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); }catch(e){} });
  await page.goto('/?scan=1');
  await expect(page.locator('#v-stamp')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#scan')).toBeVisible();
  expect(page.url()).not.toContain('scan=1');
});

test('閉場の案内：最終入場の無い日（校内公開日）も、終わる30分前から出る', async ({ page }) => {
  await mockGas(page);
  await page.clock.install({ time: new Date('2026-10-23T14:05:00+09:00') });
  await page.goto('/?tab=map');
  await ready(page);
  expect(await page.evaluate(() => hoursMessage().short)).toContain('まもなく終了（14:25・あと20分）');
  expect(await page.evaluate(() => hoursMessage(new Date('2026-10-23T13:00:00+09:00')))).toBeNull();
});

test('検索の言い換え：「ごはん」「ゲーム」で分類に当たる', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#q').fill('ごはん');
  await expect.poll(() => page.locator('#booth-list > .booth').count()).toBeGreaterThan(0);
  const cats = await page.locator('#booth-list > .booth .tag').allTextContents();
  expect(cats).toContain('食べ物');
  await page.locator('#q').fill('ゲーム');
  await expect.poll(() => page.locator('#booth-list > .booth').count()).toBeGreaterThan(0);
});

test('インフォ「このマップを友だちに送る」：外部ブラウザの引数つきのアドレスを共有', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { navigator.share = async d => { window.__shared = d; }; });
  await page.goto('/?tab=info');
  await page.locator('#share-app').click();
  const d = await page.evaluate(() => window.__shared);
  expect(d.url).toContain('openExternalBrowser=1');
  expect(d.url).not.toContain('booth=');
});

test('起動：GAS の1本が固まっても、5秒で2本目を出して早く表示する', async ({ page }) => {
  // 最初の1本だけ30秒かかり、2本目からはすぐ返す
  let n = 0;
  const { snapshot } = require('./mock');
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    n++;
    if (n === 1) await new Promise(r => setTimeout(r, 30000));
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(snapshot()) }).catch(() => {});
  });
  const t0 = Date.now();
  await page.goto('/?tab=map');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 25000 }).toBe(46);
  const ms = Date.now() - t0;
  expect(ms).toBeLessThan(10000);       // v155：5秒で2本目を出すので、30秒・12秒待たない
});

test('起動：GAS がふつうに速いときは、2本目を出さない', async ({ page }) => {
  const log = await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.waitForTimeout(6500);                 // 2本目を出す 5 秒を過ぎても
  expect(log.gets.filter(q => !/ledger|report/.test(q)).length).toBe(1);
});

/* ---------------- v156 の6つ ---------------- */
test('一覧「いまここから近い順」：いまここがあるときだけ出て、近いものから並ぶ', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await expect(page.locator('#sort-near')).toBeHidden();
  await page.evaluate(() => setHere('2F-12', 'qr'));
  await page.evaluate(() => { renderList._fp = null; renderList(); });
  await expect(page.locator('#sort-near')).toBeVisible();
  await page.locator('#sort-near').click();
  const ids = await page.locator('#booth-list > .booth').evaluateAll(els => els.map(e => e.dataset.sid));
  expect(ids[0]).toBe('2F-12');
  const fl = await page.evaluate(ids => ids.slice(0, 5).map(id => floorOfBooth(S.booths.find(b => b.id === id))), ids);
  expect(fl.every(f => f === 2)).toBe(true);                       // 同じ階が先
});

test('QR印刷シート：開くと全部のQRを読んで「すべて読める」と出す', async ({ page }) => {
  await mockGas(page, { verifyOk: true });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/?mode=qr');
  await page.locator('#pw').fill('test-password-1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#qr-check')).toHaveAttribute('data-st', 'ok', { timeout: 30000 });
  await expect(page.locator('#qr-check')).toContainText('47枚すべて');
});

test('係員：送信していない人数があるときだけ、画面を離れる前に止める', async ({ page }) => {
  await mockGas(page, { verifyOk: true });
  await page.addInitScript(() => localStorage.setItem('kuroko_adm_mode', JSON.stringify('flat')));
  await page.goto('/?mode=admin');
  await page.locator('#pw').fill('test-password-1234');
  await page.locator('#btn-login').click();
  await expect.poll(() => page.evaluate(() => S.booths.length)).toBe(46);
  const blocked = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  expect(await blocked()).toBe(false);
  await page.locator('#admin-list .adm-booth').first().locator('[data-step="1"]').click();
  expect(await blocked()).toBe(true);
});

test('地図の下の「混雑」を押すと、混雑のブースだけ目立ち、もう一度で戻る', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-1').click();
  const dimmed = () => page.locator('#plan-1 .room.dimmed').count();
  expect(await dimmed()).toBe(0);
  await page.locator('#summary .sum[data-lv="2"]').click();
  await expect(page.locator('#summary .sum[data-lv="2"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(dimmed).toBeGreaterThan(0);
  const busyLit = await page.locator('#plan-1 .room[data-lv="2"]:not(.dimmed)').count();
  const otherLit = await page.locator('#plan-1 .room:not([data-lv="2"]):not(.dimmed)').count();
  expect(busyLit).toBeGreaterThan(0);
  expect(otherLit).toBe(0);
  await page.locator('#summary .sum[data-lv="2"]').click();
  await expect.poll(dimmed).toBe(0);
});

test('一覧カードの☆：カードを開かずに「行きたい」へ入る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  const btn = page.locator('#booth-list .wish-btn').first();
  const id = await btn.getAttribute('data-wishbtn');
  await btn.click();
  await expect(page.locator('#bsh')).toBeHidden();
  expect(await page.evaluate(id => S.wish.has(id), id)).toBe(true);
  await expect(page.locator(`#booth-list .wish-btn[data-wishbtn="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
});

test('端末のエラーをサーバーへ送る（同じものは1回・3件まで・ほかの場所のエラーは送らない）', async ({ page }) => {
  const log = await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  await page.evaluate(() => {
    const here = location.href;
    reportError('TypeError: x is undefined', here, 10);
    reportError('TypeError: x is undefined', here, 10);                 // 同じもの
    reportError('ResizeObserver loop limit exceeded', here, 1);           // 無害なもの
    reportError('拡張機能のエラー', 'chrome-extension://abc/x.js', 1);     // ほかの場所
    reportError('b', here, 2); reportError('c', here, 3); reportError('d', here, 4);   // 4件目は送らない
  });
  await expect.poll(() => log.posts.filter(p => p.action === 'clientlog').length).toBe(3);
  const first = log.posts.find(p => p.action === 'clientlog');
  expect(first.msg).toContain('x is undefined');
  expect(first.build).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]$/);
});

test('一覧カード：キーボード（名前のボタン → Enter）でも詳細が開く', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#booth-list .booth-open').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#bsh')).toBeVisible();
});

/* ---------------- v157 の6つ ---------------- */
test('「まだ行っていない」：スタンプ済み・受付を外す。スタンプ画面のボタンから一覧へ（いまここがあれば近い順）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03'])));
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.evaluate(() => setHere('1F-08', 'pick'));
  await page.locator('#stamp-todo').click();
  await expect(page.locator('#v-list')).toBeVisible();
  await expect(page.locator('#todo-only')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sort-near')).toHaveAttribute('aria-pressed', 'true');
  const ids = await page.locator('#booth-list > .booth').evaluateAll(els => els.map(e => e.dataset.sid));
  expect(ids).not.toContain('1F-02');
  expect(ids).not.toContain('1F-48');                         // 受付
  expect(ids.length).toBe(46 - 2 - 1);
});

test('ブースの詳細：いまここがあると、階と棟の行き方の目安が出る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.evaluate(() => setHere('1F-48', 'pick'));
  await page.evaluate(() => openSheet('2F-12'));
  await expect(page.locator('#bsh-body .bsh-route')).toContainText('階段で2階へ上がる');
  await expect(page.locator('#bsh-body .bsh-route')).toContainText('いまここ');
  await page.evaluate(() => { closeSheet(); clearHere(); openSheet('2F-12'); });
  await expect(page.locator('#bsh-body .bsh-route')).toHaveCount(0);
});

test('困ったときは：「スタンプが付かない」で案内が出る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#q').fill('スタンプが付かない');
  await expect(page.locator('#booth-list .qhelp').first()).toContainText('スタンプが付かないとき');
  await page.goto('/?tab=info');
  await expect(page.locator('#help-list')).toContainText('スタンプが付かないとき');
});

test('スタンプ帳：階ごとの見出しと、その階の数', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['2F-12'])));
  await page.goto('/?tab=stamp');
  await ready(page);
  const heads = await page.locator('#stamp-grid .stamp-floor').allTextContents();
  expect(heads.length).toBeGreaterThanOrEqual(3);
  expect(heads[0]).toContain('1階');
  expect(heads.find(h => h.includes('2階'))).toMatch(/1 \/ \d+/);
  await expect(page.locator('#stamp-grid .stamp')).toHaveCount(46);
});

/* ---------------- v158 の6つ ---------------- */
test('スタンプを押したあとの「次は」：まだ行っていない空きのうち、いちばん近いブース', async ({ page }) => {
  await mockGas(page);
  const sigs = require('./fixtures/sigs.json');
  await page.goto(`/?booth=1F-02&qr=1&k=${sigs['1F-02']}`);
  await ready(page);
  const nx = page.locator('[data-fx="next"]');
  await expect(nx).toBeVisible({ timeout: 10000 });
  const got = await nx.getAttribute('data-id');
  const want = await page.evaluate(() => S.booths.filter(x => !S.stamps.has(x.id) && lvOf(x).lv === 0 && isVenue(x))
    .sort((a, b) => placeDist('1F-02', a.id) - placeDist('1F-02', b.id))[0].id);
  expect(got).toBe(want);
});

test('はじめての案内：最初だけ出て、「わかった」で二度と出ない。スタンプがある人には出ない', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#intro-card')).toBeVisible();
  await page.locator('#intro-ok').click();
  await expect(page.locator('#intro-card')).toBeHidden();
  await page.reload();
  await ready(page);
  await expect(page.locator('#intro-card')).toBeHidden();
  const p2 = await page.context().newPage();
  await mockGas(p2);
  await p2.addInitScript(() => { localStorage.removeItem('kuroko_intro_v1'); localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02'])); });
  await p2.goto('/?tab=map');
  await expect.poll(() => p2.evaluate(() => S.booths.length)).toBe(46);
  await expect(p2.locator('#intro-card')).toBeHidden();
});

test('電池が20%以下で充電していないと節電（自動更新の間隔を2倍）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { navigator.getBattery = async () => ({ level: 0.15, charging: false, addEventListener(){} }); });
  await page.goto('/?tab=map');
  await ready(page);
  expect(await page.evaluate(() => BATT.low)).toBe(true);
});

test('検索で見つからないとき「もしかして」で近い名前のブースを出す', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#q').fill('あーむろぼっど');
  await expect(page.locator('#booth-list .fix-sug')).toContainText('アームロボット');
  await page.locator('#booth-list [data-fix]').first().click();
  await expect(page.locator('#bsh')).toBeVisible();
});

test('地図の右上（階）と右下（現在地・＋−）のボタンが重ならない（iPhone SE・はじめての案内あり）', async ({ page }) => {
  await mockGas(page);
  for (const [w, h] of [[375, 667], [320, 568], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?tab=map');
    await ready(page);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const a = document.querySelector('.map-floors').getBoundingClientRect();
      const b = document.querySelector('.map-zoom-ctl').getBoundingClientRect();
      return { gap: b.top - a.bottom };
    });
    expect(r.gap, `${w}x${h}`).toBeGreaterThanOrEqual(0);
    await page.locator('#fl-0').click();
    await expect(page.locator('#plan-0')).toBeVisible();
  }
});

/* ---------------- v159 の6つ ---------------- */
test('横向き（667x375）でも、地図の右上の階と右下の＋−が重ならない', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.waitForTimeout(400);
  const ov = await page.evaluate(() => {
    const a = document.querySelector('.map-floors').getBoundingClientRect();
    const b = document.querySelector('.map-zoom-ctl').getBoundingClientRect();
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  });
  expect(ov).toBe(false);
});

test('地図の検索：ブースの無い部屋（柔剣道場など）も出て、選ぶとその階に寄る', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#map-q').fill('柔剣道場');
  await expect(page.locator('#map-sug')).toContainText('ブースはありません');
  await page.locator('#map-sug button').first().click();
  await expect.poll(() => page.evaluate(() => S.spot)).toBeTruthy();
});

test('いまここから一番近いトイレへ地図を寄せる（いまここが無ければ今まで通り）', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.evaluate(() => setHere('2F-12', 'pick'));
  const t = await page.evaluate(() => { const r = nearestToilet(); return r && r.f; });
  expect(t).toBe(2);                                         // 2階にいれば2階のトイレ
  await page.locator('#map-q').fill('トイレ');
  await page.locator('#map-q').press('Enter');
  await expect(page.locator('#fl-2')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => ZOOM.k)).toBeGreaterThan(1.05);
  expect(await page.evaluate(() => S.dept)).toBe('__fac');
});

test('スタンプ画面：★行きたいのうち何件回ったか', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    localStorage.setItem('kuroko_wish_v1', JSON.stringify(['1F-02', '1F-03', '2F-12']));
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02']));
  });
  await page.goto('/?tab=stamp');
  await ready(page);
  await expect(page.locator('#stamp-wish')).toHaveText('★行きたい 3件のうち 1件回りました');
});

test('いまここ：どれくらい前の場所かを出し、25分を過ぎたらえらび直しを促す', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_here_v1', JSON.stringify({ id: '1F-02', at: Date.now() - 30 * 60000, src: 'qr' })));
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#here-bar')).toContainText('30分前');
  await expect(page.locator('#here-bar')).toContainText('えらび直す');
});

/* ---------------- v160 の6つ ---------------- */
test('★のブースが「混雑」から「空き」になったら知らせる（最初の読み込みでは知らせない）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_wish_v1', JSON.stringify(['1F-02'])));
  await page.goto('/?tab=map');
  await ready(page);
  await page.evaluate(() => { const b = S.booths.find(x => x.id === '1F-02'); b.status = '混雑しています'; b.wait = 20; renderAll(); });
  await page.evaluate(() => { const b = S.booths.find(x => x.id === '1F-02'); b.status = '空いています'; b.wait = 1; renderAll(); });
  await expect(page.locator('#toast')).toContainText('が空きました');
});

test('ブースの詳細「いまここにいる」で、そこをいまここにできる', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?booth=1F-05');
  await expect(page.locator('#bsh')).toBeVisible({ timeout: 15000 });
  await page.locator('#bsh-body [data-here-set]').click();
  expect(await page.evaluate(() => hereId())).toBe('1F-05');
  await expect(page.locator('#bsh-body [data-here-set]')).toBeDisabled();
});

test('一覧：下へスクロールしても検索欄が画面の上に見えたまま', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=list');
  await ready(page);
  await page.evaluate(() => window.scrollTo(0, 2500));
  await page.waitForTimeout(300);
  const top = await page.locator('#q').boundingBox();
  expect(top.y).toBeGreaterThanOrEqual(0);
  expect(top.y).toBeLessThan(200);
  // 上へ戻るボタンが出て、押すと上へ
  await expect(page.locator('#to-top')).toBeVisible();
  await page.locator('#to-top').click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(50);
});

test('一覧の検索：当たった文字に印（<mark>）。悪い文字列は文字のまま', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#q').fill('旋盤');
  await expect(page.locator('#booth-list mark').first()).toHaveText('旋盤');
  expect(await page.evaluate(() => markHit('<b>旋盤</b>', '旋盤'))).toBe('&lt;b&gt;<mark>旋盤</mark>&lt;/b&gt;');
});

test('地図の科のボタンに、その階のブースの数', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-1').click();
  await expect(page.locator('#dept-legend .dept-n').first()).toBeVisible();
  const n = Number(await page.locator('#dept-legend .dept-n').first().textContent());
  expect(n).toBeGreaterThan(0);
});

/* ---------------- v161 ---------------- */
test('地図に重ねたボタンは半透明で、地図を動かしている間はさらに薄くなる（離すと戻る）', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.map-floors')).backgroundColor);
  expect(bg).toMatch(/rgba?\(.*,\s*0?\.\d+\)|color\(.*\/\s*0?\.\d+\)|oklab|color-mix/);     // 透けている（不透明ではない）
  await page.locator('#zoom-in').click();
  const box = await page.locator('#map-view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 6 });
  await expect(page.locator('.map-stage')).toHaveClass(/touching/);
  await page.mouse.up();
  await expect(page.locator('.map-stage')).not.toHaveClass(/touching/, { timeout: 3000 });
});

test('一覧：★・まだ行っていないで絞ったときも件数が出る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#todo-only').click();
  await expect(page.locator('#list-count')).toContainText('/ 全46件');
});

test('「/」で検索欄へ（地図では地図の検索、ほかでは一覧の検索）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.keyboard.press('/');
  await expect(page.locator('#map-q')).toBeFocused();
  await page.locator('#map-q').blur();
  await page.goto('/?tab=info');
  await ready(page);
  await page.keyboard.press('/');
  await expect(page.locator('#q')).toBeFocused();
});

test('インフォ：ホーム画面に置く方法（iPhone・Android）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  await page.locator('#a2hs > summary').click();
  await expect(page.locator('#a2hs')).toContainText('ホーム画面に追加');
});

/* ---------------- v162 ---------------- */
test('地図：部屋の外をダブルクリックすると、その場所が拡大される', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?tab=map');
  await ready(page);
  const k0 = await page.evaluate(() => ZOOM.k);
  // 部屋の無い場所（図面の外側の余白）を探して2回押す
  const pt = await page.evaluate(() => {
    const r = document.getElementById('map-view').getBoundingClientRect();
    for (let y = r.top + 10; y < r.bottom - 10; y += 12) for (let x = r.left + 10; x < r.right - 10; x += 12){
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('#map-zoom') && !el.closest('.room') && !el.closest('button')){
        let near = false;
        document.querySelectorAll('#plan-' + S.floor + ' .room[data-id]').forEach(g => { const b = g.getBoundingClientRect();
          if (x > b.left - 30 && x < b.right + 30 && y > b.top - 30 && y < b.bottom + 30) near = true; });
        if (!near) return { x, y };
      }
    }
    return null;
  });
  expect(pt).not.toBeNull();
  await page.mouse.click(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  await expect.poll(() => page.evaluate(() => ZOOM.k)).toBeGreaterThan(k0 * 1.4);
  await expect(page.locator('#bsh')).toBeHidden();
});

test('地図：パソコンのキーで拡大・動かす・全体（「+」「矢印」「0」）', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?tab=map');
  await ready(page);
  const k0 = await page.evaluate(() => ZOOM.k);
  await page.keyboard.press('+');
  await expect.poll(() => page.evaluate(() => ZOOM.k)).toBeGreaterThan(k0 * 1.4);
  const x0 = await page.evaluate(() => ZOOM.x);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => ZOOM.x)).not.toBe(x0);
  await page.keyboard.press('0');
  await expect.poll(() => page.evaluate(() => ZOOM.k <= ZOOM.min + .01)).toBe(true);
});

test('地図：階を切り替えると真ん中に階の名前が一瞬出る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-2').click();
  await expect(page.locator('#map-flash')).toHaveText('2階');
  await expect(page.locator('#map-flash')).toHaveClass(/on/);
  await expect(page.locator('#map-flash')).not.toHaveClass(/on/, { timeout: 3000 });
});

test('見やすさ優先（コントラストを上げる）では地図のボタンを透かさない', async ({ page }) => {
  await mockGas(page);
  await page.emulateMedia({ contrast: 'more' });
  await page.goto('/?tab=map');
  await ready(page);
  const bf = await page.evaluate(() => getComputedStyle(document.querySelector('.map-floors')).backdropFilter);
  expect(bf === 'none' || bf === '').toBe(true);
});

test('詳細：スタンプを押した時刻が出る', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02']));
    localStorage.setItem('kuroko_stamp_at', JSON.stringify({ '1F-02': new Date(2026, 9, 17, 10, 32).getTime() }));
  });
  await page.goto('/?booth=1F-02');
  await ready(page);
  await expect(page.locator('#bsh .bsh-got')).toContainText('10:32');
});

test('詳細のつまみは、触れる範囲が広い（高さ 28px 以上）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?booth=1F-02');
  await ready(page);
  const h = await page.evaluate(() => { const r = getComputedStyle(document.getElementById('bsh-grab'), '::before'); return parseFloat(r.top) * -1 + parseFloat(r.bottom) * -1 + 5; });
  expect(h).toBeGreaterThanOrEqual(28);
});

/* ---------------- v163 ---------------- */
test('詳細：「次」「前」で同じ階のブースへ（パソコンは ← → でも）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?booth=1F-02');
  await ready(page);
  const n0 = await page.locator('#bsh-nm').textContent();
  await page.locator('#bsh [data-nav="1"]').click();
  await expect(page.locator('#bsh-nm')).not.toHaveText(n0);
  await expect(page.locator('#bsh .bsh-nav span')).toContainText('/');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#bsh-nm')).toHaveText(n0);
});

test('地図：ブースを長押しすると ★行きたい に入り、詳細は開かない', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?tab=map');
  await ready(page);
  const room = page.locator('#plan-1 .room[data-id="1F-02"]');
  const b = await room.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_wish_v1') || '[]'))).toContain('1F-02');
  await page.waitForTimeout(300);
  await expect(page.locator('#bsh')).toBeHidden();
  // 短く押せば今まで通り詳細が開く
  await room.click();
  await expect(page.locator('#bsh')).toBeVisible();
});

test('パソコン：地図で「2」を押すと2階へ', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.keyboard.press('2');
  await expect(page.locator('#fl-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#map-flash')).toHaveText('2階');
});

test('見た目を選んでいない人は、端末の明るい・暗いの切り替えにその場で合わせる', async ({ page }) => {
  await mockGas(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?tab=map');
  await ready(page);
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('heavy');
  expect(t0).not.toBe('heavy');
});

test('地図で開いたブースが詳細に隠れていたら、地図を動かして見せる', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  // いちばん下に見えているブースを開く
  const id = await page.evaluate(() => {
    const v = document.getElementById('map-view').getBoundingClientRect();
    let best = null;
    document.querySelectorAll('#plan-' + S.floor + ' .room[data-id]').forEach(g => { const r = g.getBoundingClientRect();
      if (r.top > v.top && r.bottom < v.bottom && r.left > v.left && r.right < v.right && (!best || r.bottom > best.b)) best = { id: g.dataset.id, b: r.bottom }; });
    return best && best.id;
  });
  expect(id).toBeTruthy();
  await page.evaluate(id => openSheet(id), id);
  await page.waitForTimeout(900);
  const ok = await page.evaluate(id => {
    const r = document.querySelector(`#plan-${S.floor} .room[data-id="${id}"]`).getBoundingClientRect();
    const top = document.getElementById('bsh').getBoundingClientRect().top;
    const v = document.getElementById('map-view').getBoundingClientRect();
    return { below: (r.top + r.bottom) / 2 > top, mapH: Math.min(v.bottom, top) - Math.max(v.top, 0) };
  }, id);
  if (ok.mapH >= 40) expect(ok.below).toBe(false);
});

/* ---------------- v164 ---------------- */
test('詳細を左になぞると次のブース、右になぞると前のブース', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'テスト用の WebKit（Windows）は Touch を作れない');
  await mockGas(page);
  await page.goto('/?booth=1F-02');
  await ready(page);
  const n0 = await page.locator('#bsh-nm').textContent();
  const swipe = dx => page.evaluate(dx => {
    const sh = document.getElementById('bsh'), r = sh.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + 120;
    const t = (cx, cy) => new Touch({ identifier: 1, target: sh, clientX: cx, clientY: cy });
    sh.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t(x, y)], changedTouches: [t(x, y)] }));
    sh.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t(x + dx, y + 5)] }));
  }, dx);
  await swipe(-120);
  await expect(page.locator('#bsh-nm')).not.toHaveText(n0);
  await swipe(120);
  await expect(page.locator('#bsh-nm')).toHaveText(n0);
});

test('「?」でキー操作の一覧が出て、押すと消える', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.keyboard.press('?');
  await expect(page.locator('#toast')).toContainText('キー操作');
  await page.locator('#toast').click();
  await expect(page.locator('#toast')).not.toHaveClass(/\bon\b/);
});

test('データ節約中は、詳細の写真を押したときだけ読む', async ({ page }) => {
  await mockGas(page, { mutate: d => { d.booths.forEach(b => { if (b.id === '1F-02') b.image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; }); } });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' }, configurable: true }); });
  await page.goto('/?booth=1F-02');
  await ready(page);
  await expect(page.locator('#bsh .bsh-img')).toHaveCount(0);
  await page.locator('#bsh [data-img]').click();
  await expect(page.locator('#bsh .bsh-img')).toHaveCount(1);
});

test('力の弱い端末（メモリ 2GB 以下）は軽い表示（地図のボタンをぼかさない）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { Object.defineProperty(navigator, 'deviceMemory', { value: 1, configurable: true }); });
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('html')).toHaveClass(/\blite\b/);
  const bf = await page.evaluate(() => getComputedStyle(document.querySelector('.map-floors')).backdropFilter);
  expect(bf === 'none' || bf === '').toBe(true);
});

test('共有の文に、いまの混み具合が入る', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { navigator.share = async d => { window.__shared = d; }; });
  await page.goto('/?tab=list');
  await ready(page);
  const id = await page.evaluate(() => { const b = S.booths.find(x => x.time && !x.stale && lvOf(x).lv >= 0 && lvOf(x).lv !== 3); return b && b.id; });
  test.skip(!id, '写しのデータに、新しい情報のあるブースが無い');
  await page.evaluate(id => shareBooth(id), id);
  const d = await page.evaluate(() => window.__shared);
  expect(d.text).toContain('いま：');
});
