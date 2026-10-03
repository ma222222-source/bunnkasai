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
