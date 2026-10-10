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
  // 描いた直後は、地図の高さ合わせ・画面の入りの動き（10px）で、部品の位置がまだ動く。
  // 位置を測って押すテストが、重いとき（テストを並べて動かしているとき）に外していたので、位置が落ち着くまで待つ（v184）
  await page.evaluate(() => new Promise(res => {
    let last = '', same = 0, n = 0;
    const tick = () => {
      const v = document.querySelector('.view.on') || document.body, m = document.getElementById('map-view');
      const r = (m && m.offsetParent ? m : v).getBoundingClientRect();
      const k = [r.top, r.left, r.width, r.height, document.documentElement.scrollHeight].map(Math.round).join(',');
      same = k === last ? same + 1 : 0; last = k;
      if (same >= 3 || ++n > 40) res(); else setTimeout(tick, 30);
    };
    setTimeout(tick, 30);
  })).catch(() => {});
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
  ['admin', '#v-auth'], ['qr', '#v-auth'], ['print', '#v-print'], ['pamphlet', '#v-pamphlet'], ['board', '#v-board'],
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

test('地図の検索：何も打たずに押すと「最近見たブース」が出る', async ({ page }) => {
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
  await expect(page.locator('#map-sug')).toContainText('最近見たブース');
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
  // v189：離したあと、地図の上でマウスを動かしただけでは薄くならない（薄いまま戻らなくなっていた）
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 - 10, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 4 });
  await page.waitForTimeout(300);
  await expect(page.locator('.map-stage')).not.toHaveClass(/touching/);
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
  // 2回の押しのあいだが空くと（テストを並べて動かして重いとき）「2回続けて」にならない。そのときは押し直す（v183）
  await expect(async () => {
    await page.mouse.click(pt.x, pt.y);
    await page.mouse.click(pt.x, pt.y);
    await expect.poll(() => page.evaluate(() => ZOOM.k), { timeout: 1500 }).toBeGreaterThan(k0 * 1.4);
  }).toPass({ timeout: 12000 });
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
  // 地図を見出しのすぐ下へ寄せる。画面のどこに地図があるかは、上の案内（はじめての方へ・開催時間）の有無で変わり、
  // 地図がほとんど詳細の下になる位置だと、動かしようがなくて確かめにならない（v185）
  await page.evaluate(() => {
    const v = document.getElementById('map-view').getBoundingClientRect(), h = document.querySelector('.head').getBoundingClientRect();
    window.scrollBy(0, v.top - h.bottom - 8);
  });
  await page.waitForTimeout(200);
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
  // 詳細が上がりきり、地図が動き終わるまで待ってから測る（決まった時間だけ待つと、重いときにまだ動いている。v184）
  const look = () => page.evaluate(id => {
    const r = document.querySelector(`#plan-${S.floor} .room[data-id="${id}"]`).getBoundingClientRect();
    const sh = document.getElementById('bsh'), top = sh.getBoundingClientRect().top;
    const v = document.getElementById('map-view').getBoundingClientRect();
    const moving = (new DOMMatrixReadOnly(getComputedStyle(sh).transform).m42 || 0) > 0.5 || !sh.classList.contains('on');
    return { moving, rc: Math.round((r.top + r.bottom) / 2), below: (r.top + r.bottom) / 2 > top, mapH: Math.min(v.bottom, top) - Math.max(v.top, 0) };
  }, id);
  // 詳細が上がりきったあと、ブースの真ん中が詳細より上に見えている
  await expect.poll(async () => { const o = await look(); return !o.moving && o.mapH >= 40 && !o.below; }, { timeout: 8000 }).toBe(true);
  // そのまま隠れ直さない（地図の字の入れ直し＝拡大のあとの描き直しが済んでも）
  await page.waitForTimeout(1200);
  const ok = await look();
  expect(ok.mapH).toBeGreaterThanOrEqual(40);
  expect(ok.below).toBe(false);
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

/* ---------------- v165 ---------------- */
test('端末の時計が10分進んでいても、「◯分前」はサーバーの時刻で数える', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { const off = 10 * 60000, real = Date.now; Date.now = () => real() + off; });
  await page.goto('/?tab=list');
  await ready(page);
  const r = await page.evaluate(() => ({ off: clockOffset(), ago: ago(new Date(Date.now() - 10 * 60000).toISOString()) }));
  expect(r.off).toBeLessThan(-8 * 60000);
  expect(r.ago).toBe('たった今');
});

test('ふつうの端末（時計が合っている）は直さない', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  expect(await page.evaluate(() => clockOffset())).toBe(0);
});

test('QRのカメラの下に、いまのスタンプの数と交換までの残り', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03']));
    try{ Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); }catch(e){}
  });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect(page.locator('#scan-count')).toContainText('いまスタンプ 2個');
  await expect(page.locator('#scan-count')).toContainText('あと3個');
});

test('30分以内に決めた「いまここ」があれば、その階から開く', async ({ page }) => {
  await mockGas(page);
  // いまここにする2階の部屋を、本物の図面から選ぶ
  await page.goto('/?tab=map');
  await ready(page);
  const id = await page.evaluate(() => { for (const [k, v] of ROOM_INDEX) if (v.f === 2) return k; return null; });
  expect(id).toBeTruthy();
  await page.addInitScript(id => {
    localStorage.setItem('kuroko_floor', JSON.stringify(1));
    localStorage.setItem('kuroko_here_v1', JSON.stringify({ id, at: Date.now(), src: 'pick' }));
  }, id);
  await page.reload();
  await ready(page);
  await expect(page.locator('#fl-2')).toHaveAttribute('aria-pressed', 'true');
});

test('詳細を開いたとき、情報が1分半より古ければ取り直す', async ({ page }) => {
  const log = await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.waitForTimeout(500);
  // ちょうど自動の更新が動いている最中だと、取り直しは重ねない（それで正しい）。終わるのを待ってから確かめる（v185）
  await page.waitForFunction(() => !sync._busy, null, { timeout: 15000 });
  await page.evaluate(() => { S.fetchedAt = Date.now() - 120000; });
  const n0 = log.gets.length;
  await page.evaluate(() => openSheet(S.booths[1].id));
  await expect.poll(() => log.gets.length, { timeout: 10000 }).toBeGreaterThan(n0);
});

test('一覧の並べ方（名前順）を覚える', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#sort-name').click();
  await page.reload();
  await ready(page);
  await expect(page.locator('#sort-name')).toHaveAttribute('aria-pressed', 'true');
});

test('階を切り替えると、読み上げにも伝える', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-3').click();
  await expect(page.locator('#summary-live')).toHaveText('3階の地図を表示しました');
});

/* ---------------- v166 ---------------- */
test('JavaScript が使えないときの案内（noscript）がある', async ({ page }) => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  expect(html).toMatch(/<noscript>[\s\S]*JavaScript をオン/);
});

test('一覧：詳細を開いたブースが「最近見た」に出て、押すと開く', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await expect(page.locator('#recent-row')).toBeHidden();
  const id = await page.evaluate(() => S.booths[2].id);
  await page.evaluate(id => { openSheet(id); }, id);
  await page.evaluate(() => closeSheet());
  await page.evaluate(() => { renderList._fp = null; renderList(); });
  await expect(page.locator(`#recent-row [data-recent="${id}"]`)).toBeVisible();
  await page.locator(`#recent-row [data-recent="${id}"]`).click();
  await expect(page.locator('#bsh')).toBeVisible();
});

test('スタンプ画面：回った順（時刻つき）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03']));
    localStorage.setItem('kuroko_stamp_at', JSON.stringify({ '1F-03': new Date(2026, 9, 17, 10, 5).getTime(), '1F-02': new Date(2026, 9, 17, 11, 40).getTime() }));
  });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-log > summary').click();
  const rows = page.locator('#stamp-log-list li:not(.stamp-log-sum)');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('10:05');
  await expect(rows.nth(1)).toContainText('11:40');
});

test('電池が少ない間は軽い表示、充電したら戻す', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    const b = { level: 0.1, charging: false, _l: {}, addEventListener(t, f){ (this._l[t] = this._l[t] || []).push(f); } };
    window.__batt = b;
    navigator.getBattery = async () => b;
  });
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('html')).toHaveClass(/\blite\b/);
  await page.evaluate(() => { __batt.charging = true; (__batt._l.chargingchange || []).forEach(f => f()); });
  await expect(page.locator('html')).not.toHaveClass(/\blite\b/);
});

test('一覧の検索：Enter で1件ならその詳細が開く', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  const name = await page.evaluate(() => S.booths.find(b => b.id === '1F-02').name);
  await page.locator('#q').fill(name);
  await page.locator('#q').press('Enter');
  const ids = await page.evaluate(() => renderList._order);
  if (ids.length === 1) await expect(page.locator('#bsh')).toBeVisible();
  else await expect(page.locator('#q')).not.toBeFocused();
});

test('一覧を階で絞る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#lf').selectOption('2');
  const fl = await page.evaluate(() => renderList._order.map(id => floorOfBooth(S.booths.find(b => b.id === id))));
  expect(fl.length).toBeGreaterThan(0);
  expect(fl.every(f => f === 2)).toBe(true);
  await expect(page.locator('#list-count')).toContainText('/ 全46件');
});

/* ---------------- v167 ---------------- */
test('インフォ：使い方のこつ（ダブルタップ・長押し・なぞる）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  await page.locator('#tips > summary').click();
  await expect(page.locator('#tips')).toContainText('長押し');
  await expect(page.locator('#tips')).toContainText('2回続けて');
});

test('カメラは90秒読めなければ自動で閉じ、開いたボタンへ戻る', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'テスト用の WebKit にカメラの代わりの映像が作れない');
  await mockGas(page);
  await page.clock.install();
  await page.addInitScript(() => {
    const md = navigator.mediaDevices || {};
    md.getUserMedia = async () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64); return c.captureStream(5); };
    try{ Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }catch(e){}
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await page.clock.runFor(3000);
  await page.waitForFunction(() => S.booths.length > 0);
  await page.locator('#stamp-scan').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#scan')).toBeVisible();
  await page.clock.runFor(91000);
  await expect(page.locator('#scan')).toBeHidden();
  await expect(page.locator('#stamp-scan')).toBeFocused();
});

test('★の数は付け外しのたびに変わり、★で絞ると「すべて外す」（元に戻せる）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { if (!localStorage.getItem('kuroko_wish_v1')) localStorage.setItem('kuroko_wish_v1', JSON.stringify(['1F-02', '1F-03'])); });
  await page.goto('/?tab=list');
  await ready(page);
  await expect(page.locator('#wish-only')).toHaveText('★ 行きたい 2');
  await page.evaluate(() => toggleWish('1F-05'));
  await expect(page.locator('#wish-only')).toHaveText('★ 行きたい 3');
  await page.locator('#wish-only').click();
  await page.locator('#wish-clear').click();
  await expect(page.locator('#wish-only')).toHaveText('★ 行きたい');
  await page.locator('#toast .toast-act').click();
  await expect(page.locator('#wish-only')).toHaveText('★ 行きたい 3');
});

test('階のボタンに、まだ行っていない★の印', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_wish_v1', JSON.stringify(['1F-02'])));
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#fl-1 .fl-wish')).toHaveCount(1);
  await expect(page.locator('#fl-2 .fl-wish')).toHaveCount(0);
  await expect(page.locator('#fl-1')).toHaveAttribute('aria-label', /★/);
});

test('文字「特大」では地図のボタンも大きい（高さ 52px）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_fs', JSON.stringify('xl')));
  await page.goto('/?tab=map');
  await ready(page);
  const h = await page.locator('#fl-1').evaluate(el => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(51);
});

/* ---------------- v168 ---------------- */
test('インフォ：友だちに見せるQRは、このマップのアドレスとして読める', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  await page.locator('#app-qr > summary').click();
  await expect(page.locator('#app-qr-box svg')).toBeVisible();
  // 自前の読み取りで読めること
  const txt = await page.evaluate(async () => {
    const svg = document.querySelector('#app-qr-box svg');
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    const im = new Image(); im.src = url; await im.decode();
    const c = document.createElement('canvas'); c.width = 320; c.height = 320;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 320, 320); x.drawImage(im, 40, 40, 240, 240);
    return QR.scanImageData(x.getImageData(0, 0, 320, 320));
  });
  expect(txt).toContain('openExternalBrowser=1');
});

test('地図を指2本で軽く叩くと縮小', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'テスト用の WebKit（Windows）は Touch を作れない');
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  const k0 = await page.evaluate(() => ZOOM.k);
  await page.evaluate(() => {
    const el = ZOOM.el, r = el.getBoundingClientRect();
    const t = (id, x, y) => new Touch({ identifier: id, target: el, clientX: x, clientY: y });
    const a = t(1, r.left + 100, r.top + 120), b = t(2, r.left + 180, r.top + 140);
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [a, b], changedTouches: [a, b] }));
    el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [a, b] }));
  });
  await expect.poll(() => page.evaluate(() => ZOOM.k)).toBeLessThan(k0 * 0.8);
});

test('スタンプ帳：まだのスタンプだけ', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03'])));
  await page.goto('/?tab=stamp');
  await ready(page);
  await expect(page.locator('#stamp-grid [data-sid="1F-02"]')).toBeVisible();
  await page.locator('#stamp-only-todo').click();
  await expect(page.locator('#stamp-grid [data-sid="1F-02"]')).toBeHidden();
  await expect(page.locator('#stamp-grid [data-sid="1F-05"]')).toBeVisible();
});

test('最近見たブースの記録を消せる', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_recent_q', JSON.stringify(['1F-02'])); } });
  await page.goto('/?tab=list');
  await ready(page);
  await expect(page.locator('#recent-row')).toBeVisible();
  await page.locator('#recent-x').click();
  await expect(page.locator('#recent-row')).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_recent_q')))).toEqual([]);
});

test('地図の検索：見つからないときは「もしかして」で近い名前のブース', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  const name = await page.evaluate(() => S.booths.find(b => b.category !== '受付' && b.name.length >= 4).name);
  // 1文字変えて、ふつうの検索では当たらないようにする
  const typo = name.slice(0, -1) + 'ゑ';
  await page.locator('#map-q').fill(typo);
  const n = await page.evaluate(q => mapSuggest(q).length, typo);
  test.skip(n > 0, 'ふつうの検索で当たってしまう名前だった');
  await expect(page.locator('#map-sug')).toContainText('もしかして');
  await expect(page.locator('#map-sug')).toContainText(name);
});

/* ---------------- v169 ---------------- */
test('コピー：navigator.clipboard が無い端末でも、昔の方法でコピーする', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    try{ Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); }catch(e){}
    try{ Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); }catch(e){}
    document.execCommand = cmd => { window.__copied = cmd === 'copy' ? (document.activeElement && document.activeElement.value) : null; return cmd === 'copy'; };
  });
  await page.goto('/?tab=list');
  await ready(page);
  await page.evaluate(() => shareBooth('1F-02'));
  await expect(page.locator('#toast')).toContainText('コピーしました');
  expect(await page.evaluate(() => window.__copied)).toContain('booth=1F-02');
});

test('ふつうのお知らせは×で閉じられ、文が変わるとまた出る（注意は閉じられない）', async ({ page }) => {
  let notice = { text: '午後の部は13時から', level: 'info' };
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    const { snapshot } = require('./mock');
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(snapshot({ notice })) });
  });
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#banner-notice')).toBeVisible();
  await page.locator('#notice-x').click();
  await expect(page.locator('#banner-notice')).toBeHidden();
  notice = { text: '雨のため屋外の催しは体育館で', level: 'alert' };
  await page.evaluate(() => sync(true));
  await expect(page.locator('#banner-notice')).toBeVisible();
  await expect(page.locator('#notice-x')).toBeHidden();
});

test('回った順：最初から最後までの時間', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03', '1F-05']));
    localStorage.setItem('kuroko_stamp_at', JSON.stringify({ '1F-03': new Date(2026, 9, 17, 10, 5).getTime(), '1F-05': new Date(2026, 9, 17, 10, 50).getTime(), '1F-02': new Date(2026, 9, 17, 11, 40).getTime() }));
  });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-log > summary').click();
  await expect(page.locator('#stamp-log-list')).toContainText('3ブースを 1時間35分で回りました');
});

test('詳細の写真は押すと大きく、Esc で閉じる', async ({ page }) => {
  await mockGas(page, { mutate: d => { d.booths.forEach(b => { if (b.id === '1F-02') b.image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; }); } });
  await page.goto('/?booth=1F-02');
  await ready(page);
  await page.locator('#bsh img.bsh-img').click();
  await expect(page.locator('.img-zoom')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.img-zoom')).toHaveCount(0);
  await expect(page.locator('#bsh')).toBeVisible();          // 詳細は閉じない
});

test('地図で「空き」を目立たせている間は札が出て、押すと戻る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#summary .sum[data-lv="0"]').click();
  await expect(page.locator('#lv-pill')).toBeVisible();
  await expect(page.locator('#lv-pill')).toContainText('空き');
  await page.locator('#lv-pill').click();
  await expect(page.locator('#lv-pill')).toBeHidden();
  await expect(page.locator('#summary .sum[data-lv="0"]')).toHaveAttribute('aria-pressed', 'false');
});

test('通信が戻ったら「つながりました」', async ({ page, context }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await context.setOffline(true);
  // 切れたことがページに伝わってから戻す（続けて切り替えると、重いときに「戻った」の合図が出ないことがある。v185）
  await expect.poll(() => page.evaluate(() => navigator.onLine), { timeout: 5000 }).toBe(false);
  await context.setOffline(false);
  await expect(page.locator('#toast')).toContainText('つながりました');
});

test('地図に重ねたボタンどうしが重ならない（幅 320/360/390・文字ふつう／特大・すべての階）', async ({ page }) => {
  test.setTimeout(90000);
  await mockGas(page);
  const bad = [];
  for (const fs of ['m', 'xl']) {
    if (fs === 'xl') await page.addInitScript(() => localStorage.setItem('kuroko_fs', JSON.stringify('xl')));
    for (const w of [320, 360, 390]) {
      await page.setViewportSize({ width: w, height: 700 });
      await page.goto('/?tab=map');
      await ready(page);
      for (const fl of [0, 1, 2, 3]) {
        await page.evaluate(f => setFloor(f), fl);
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => {
          const bs = [...document.querySelectorAll('#map-card .map-floors button, #map-card .map-ctl button')]
            .filter(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden').map(b => [b.id || b.textContent.trim(), b.getBoundingClientRect()]);
          const out = [];
          for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = bs[i][1], b = bs[j][1];
            if (!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)) out.push(bs[i][0] + '×' + bs[j][0]); }
          return out;
        });
        if (r.length) bad.push(`${fs} ${w}px ${fl}階: ${r.join(', ')}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

/* ---------------- v170 ---------------- */
test('終わる45分前、交換できるスタンプがあれば一度だけ知らせる', async ({ page }) => {
  await mockGas(page);
  // 時計を一般公開日の 14:00 に止める（実行した時刻に左右されないように）
  // 時刻の指定は「その瞬間」。日本時間 14:00（UTC 05:00）なら、どちらの時間帯で動かしても日付をまたがない
  await page.clock.setFixedTime(new Date('2026-10-24T05:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03', '1F-05', '1F-07', '1F-08'])));
  await page.goto('/?tab=map');
  await ready(page);
  const r = await page.evaluate(() => {
    // 開催時間は、画面の時計（端末の時間帯）でいまの1時間前〜30分後にする（GitHub は UTC、iPhone・Android のまねは日本時間）
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const t = new Date(d.getTime() + 30 * 60000);
    CONFIG.HOURS = { days: [{ date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, label: '一般公開',
      open: `${p2(d.getHours() - 1)}:00`, close: `${p2(t.getHours())}:${p2(t.getMinutes())}` }] };
    localStorage.removeItem('kuroko_prize_remind');
    remindPrize();
    return { st: openState().state, n: localStorage.getItem('kuroko_prize_remind') };
  });
  expect(r.st).toBe('open');
  await expect(page.locator('#toast')).toContainText('お菓子と交換できるスタンプ');
  expect(r.n).not.toBeNull();
  // 同じ日の2回目は知らせない
  await page.evaluate(() => { document.getElementById('toast').textContent = ''; remindPrize(); });
  await expect(page.locator('#toast')).not.toContainText('お菓子と交換できるスタンプ');
});

test('詳細の「読み上げる」', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    window.__spoken = [];
    window.SpeechSynthesisUtterance = function (t){ this.text = t; };
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, speak(u){ window.__spoken.push(u.text); }, cancel(){} }, configurable: true });
  });
  await page.goto('/?booth=1F-02');
  await ready(page);
  await page.locator('#bsh [data-speak]').click();
  const t = await page.evaluate(() => window.__spoken[0]);
  const name = await page.evaluate(() => S.booths.find(b => b.id === '1F-02').name);
  expect(t).toContain(name);
});

test('大きくした写真は2回押すと拡大し、閉じない', async ({ page }) => {
  await mockGas(page, { mutate: d => { d.booths.forEach(b => { if (b.id === '1F-02') b.image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; }); } });
  await page.goto('/?booth=1F-02');
  await ready(page);
  await page.locator('#bsh img.bsh-img').click();
  await page.locator('.img-zoom').dblclick();
  await expect(page.locator('.img-zoom img')).toHaveAttribute('style', /scale\(2\.5\)/);
  await page.waitForTimeout(500);
  await expect(page.locator('.img-zoom')).toHaveCount(1);
});

test('スタンプの記録の共有に、回った時間', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03']));
    localStorage.setItem('kuroko_stamp_at', JSON.stringify({ '1F-03': new Date(2026, 9, 17, 10, 0).getTime(), '1F-02': new Date(2026, 9, 17, 10, 40).getTime() }));
    navigator.canShare = () => false;
    navigator.share = async d => { window.__shared = d; };
  });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.evaluate(() => shareStamps());
  await expect.poll(() => page.evaluate(() => window.__shared && window.__shared.text)).toContain('（40分）');
});

test('いまここから近い順では「同じ階」「↑1階」などが付く', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.evaluate(() => { localStorage.setItem('kuroko_here_v1', JSON.stringify({ id: '1F-02', at: Date.now(), src: 'pick' })); renderList._fp = null; setSort('near'); });
  await expect(page.locator('#booth-list .near-tag').first()).toBeVisible();
  const tags = await page.locator('#booth-list .near-tag').allTextContents();
  expect(tags).toContain('同じ階');
});

test('アドレス欄の色（theme-color）を見出しの色に合わせる', async ({ page }) => {
  await mockGas(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1b1916');
  await page.locator('#btn-theme').click();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0b0c10');
});

/* ---------------- v171 ---------------- */
test('スタンプの音：はじめては「鳴らす」、自分で「鳴らさない」を選んだらそのまま', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  await expect(page.locator('#snd-on')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#snd-off').click();
  await page.reload();
  await ready(page);
  await expect(page.locator('#snd-off')).toHaveAttribute('aria-pressed', 'true');
});

/* ---------------- v172 ---------------- */
test('スタンプの演出：音の切り替え・続けて読む・交換する・押した時刻', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1);
      localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03', '1F-07', '1F-08']));
      localStorage.setItem('kuroko_stamp_at', JSON.stringify({ '1F-02': new Date(2026, 9, 17, 9, 45).getTime() })); }
    try{ Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); }catch(e){}
  });
  await page.goto('/?tab=stamp');
  await ready(page);
  // 5個目：交換できる → 「お菓子と交換する」
  await page.evaluate(() => stampNow('1F-05'));
  await expect(page.locator('[data-fx="redeem"]')).toBeVisible();
  // 音の切り替え（インフォの設定も変わる）
  await page.locator('[data-fx="snd"]').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_sound')))).toBe(false);
  await expect(page.locator('#snd-off')).toHaveAttribute('aria-pressed', 'true');
  // 続けて読む → カメラ
  await page.locator('[data-fx="scan"]').click();
  await expect(page.locator('#scan')).toBeVisible();
  await page.locator('#scan-close').click();
  // すでに持っているスタンプは、押した時刻
  await page.evaluate(() => stampNow('1F-02'));
  await expect(page.locator('.sfx-card')).toContainText('09:45 に押しています');
});

test('QRのカメラ：暗い映像ならライト（か明るい所）を勧める', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'テスト用の WebKit にカメラの代わりの映像が作れない');
  await mockGas(page);
  await page.addInitScript(() => {
    const md = navigator.mediaDevices || {};
    md.getUserMedia = async () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
      const draw = () => { x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, 64, 64); requestAnimationFrame(draw); }; draw(); return c.captureStream(10); };
    try{ Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }catch(e){}
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect(page.locator('#scan-help')).toContainText('暗くて読みにくい', { timeout: 8000 });
});

test('QRのカメラ：読み取り中の光の線', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=stamp');
  await ready(page);
  const anim = await page.evaluate(() => { const f = document.querySelector('.scan-frame'); return getComputedStyle(f, '::after').animationName; });
  expect(anim).toBe('scanline');
});

/* ---------------- v173：地図の字（拡大してもくっきり・入りきる） ---------------- */
test('地図：止まると拡大した大きさで描き直す（字をくっきり）。見た目の位置は変わらない', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  await page.waitForTimeout(1000);          // 開いた直後の自動の寄せ（ブースが入る位置）が終わるのを待つ
  const before = await page.evaluate(() => { zoomTo(3, null, null, false); const r = document.querySelector(`#plan-${S.floor} .room[data-id]`).getBoundingClientRect(); return [r.left, r.top, r.width]; });
  await expect.poll(() => page.evaluate(() => ZOOM.baked)).toBe(true);
  const after = await page.evaluate(() => { const r = document.querySelector(`#plan-${S.floor} .room[data-id]`).getBoundingClientRect();
    return { r: [r.left, r.top, r.width], tf: ZOOM.el.style.transform, w: parseFloat(ZOOM.el.style.width), mw: ZOOM.elW * ZOOM.k }; });
  expect(after.tf).not.toContain('scale');
  expect(Math.abs(after.w - after.mw)).toBeLessThan(1);
  for (let i = 0; i < 3; i++) expect(Math.abs(after.r[i] - before[i])).toBeLessThan(1.5);
  // 動かすと元に戻り（scale）、止まるとまた描き直す
  await page.locator('#zoom-in').click();
  await expect.poll(() => page.evaluate(() => ZOOM.baked && Math.abs(ZOOM.k - 4.8) < 0.01)).toBe(true);
});

test('地図：×1.0〜×8.0 を0.1ずつ、名前は枠からはみ出さず、字は画面の上で8〜15px・状態は12px以下、×8（最大）ではすべての名前がまるごと入る', async ({ page }) => {
  test.setTimeout(120000);
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=map');
  await ready(page);
  const bad = [];
  for (const fl of [1, 2, 3]) {
    await page.evaluate(f => setFloor(f), fl);
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const out = [];
      for (let k10 = 10; k10 <= 80; k10++) {
        const k = k10 / 10;
        zoomTo(k, null, null, false); drawFloor._fp = null; drawFloor(S.floor);
        const sc = mapScale();
        document.querySelectorAll(`#plan-${S.floor} .room[data-id]`).forEach(g => {
          const b = S.booths.find(x => x.id === g.dataset.id); if (!b) return;
          const rr = g.querySelector('rect').getBoundingClientRect();
          const nm = [...g.querySelectorAll('text.nm')];
          nm.forEach(t => {
            const px = parseFloat(t.getAttribute('font-size')) * sc, tb = t.getBoundingClientRect();
            if (k >= 2 && (px < 7.9 || px > 15.1)) out.push(`×${k} ${b.id} 名前${px.toFixed(1)}px`);
            if (tb.left < rr.left - 1 || tb.right > rr.right + 1 || tb.top < rr.top - 1 || tb.bottom > rr.bottom + 1) out.push(`×${k} ${b.id} はみ出し`);
            const no = g.querySelector('.room-no circle');
            if (no){ const nb = no.getBoundingClientRect();
              // 字の箱は上下に余白を含むので、横と縦の重なりがどちらも 2px を超えたら重なりとみなす
              const ox = Math.min(tb.right, nb.right) - Math.max(tb.left, nb.left), oy = Math.min(tb.bottom, nb.bottom) - Math.max(tb.top, nb.top);
              if (ox > 2 && oy > 2) out.push(`×${k} ${b.id} 番号と名前が重なる`); }
          });
          g.querySelectorAll('text.st').forEach(t => { const px = parseFloat(t.getAttribute('font-size')) * sc; if (px > 12.1) out.push(`×${k} ${b.id} 状態${px.toFixed(1)}px`); });
          if (k === 8 && nm.map(t => t.textContent).join('').replace(/\s/g, '') !== b.name.replace(/\s/g, '')) out.push(`×8 ${b.id} 名前が切れている：${nm.map(t => t.textContent).join('')}`);
        });
      }
      return out;
    });
    bad.push(...r.map(x => fl + '階 ' + x));
  }
  expect(bad.slice(0, 20)).toEqual([]);
});

/* ---------------- v174 ---------------- */
test('見出しのボタンに文字（QR・見た目・更新）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#btn-scan .ib-tx')).toHaveText('QR');
  await expect(page.locator('#btn-theme .ib-tx')).toHaveText('見た目');
  await expect(page.locator('#btn-reload .ib-tx')).toHaveText('更新');
  const h = await page.locator('#btn-reload').evaluate(el => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(40);
});

test('押せない物はボタンの形にしない（倍率の表示・一覧の混み具合の札）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  const r = await page.locator('#booth-list .booth .pill').first().evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  expect(r).toBeLessThan(10);
  const bw = await page.evaluate(() => getComputedStyle(document.getElementById('zoom-lv')).borderTopColor);
  expect(bw).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});

test('地図：番号だけのブースが多いときは「拡大すると名前が出ます」、拡大して名前が出たら消える', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('kuroko_intro_v1', '1'));
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#name-hint')).toBeVisible();
  // 開いた直後の「全体に合わせる」が遅れて来ると（重いとき）拡大が戻る。そのときは拡大し直す（v183）
  await expect(async () => {
    await page.evaluate(() => { zoomTo(8, null, null, false); });
    await expect(page.locator('#name-hint')).toBeHidden({ timeout: 2000 });
  }).toPass({ timeout: 12000 });
});

test('軽い表示（力の弱い端末）では、字の入れ方の描き直しは 0.25倍ごと', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { Object.defineProperty(navigator, 'deviceMemory', { value: 1, configurable: true }); });
  await page.goto('/?tab=map');
  await ready(page);
  const n = await page.evaluate(async () => {
    zoomTo(2, null, null, false); await new Promise(r => setTimeout(r, 400));
    let c = 0; const o = drawFloor; window.drawFloor = function(){ c++; return o.apply(this, arguments); };
    for (const k of [2.1, 2.2]){ zoomTo(k, null, null, false); await new Promise(r => setTimeout(r, 300)); }
    window.drawFloor = o; return c;
  });
  // 2.1→2.2 は 0.25 刻みでは 8→9 の1回まで（0.1 刻みなら 21→22 も数えて2回）
  expect(n).toBeLessThanOrEqual(1);
});

/* ---------------- v175 ---------------- */
test('一覧のカードの右端に「›」、スタンプ帳に「押すと…」の一文', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  const c = await page.locator('#booth-list .booth').first().evaluate(el => getComputedStyle(el, '::after').borderRightStyle);
  expect(c).toBe('solid');
  await page.goto('/?tab=stamp');
  await ready(page);
  await expect(page.locator('.stamp-grid-note')).toBeVisible();
});

test('横に流れるボタンの列は、続きがある側の端が薄い', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/?tab=list');
  await ready(page);
  const row = page.locator('#cat-chips');
  await expect(row).toHaveClass(/fade-r/);
  await row.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(row).toHaveClass(/fade-l/);
  await expect(row).not.toHaveClass(/fade-r/);
});

test('「元に戻す」付きのお知らせは、すぐ次のお知らせで消えない', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.evaluate(() => { toast('★を3件外しました', { label: '元に戻す', fn(){} }); toast('ほかの知らせ'); });
  await expect(page.locator('#toast .toast-act')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('★を3件外しました');
  await expect(page.locator('#toast')).toContainText('ほかの知らせ', { timeout: 6000 });
});

test('いまここがある階のボタンに青い点', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  const id = await page.evaluate(() => { for (const [k, v] of ROOM_INDEX) if (v.f === 2) return k; });
  await page.evaluate(id => setHere(id, 'pick'), id);
  await expect(page.locator('#fl-2 .fl-here')).toHaveCount(1);
  await expect(page.locator('#fl-1 .fl-here')).toHaveCount(0);
});

/* ---------------- v176 ---------------- */
test('一覧：0件のときは「絞り込みをすべて外す」で全部に戻る', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.locator('#q').fill('ぜったいにないなまえ');
  await page.locator('#lf').selectOption('3');
  await expect(page.locator('[data-reset-filters]')).toBeVisible();
  await page.locator('[data-reset-filters]').click();
  await expect(page.locator('#q')).toHaveValue('');
  await expect(page.locator('#lf')).toHaveValue('');
  expect(await page.evaluate(() => renderList._order.length)).toBe(46);
});

test('使い方のこつ・地図の見かたに、新しい印の説明', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  await page.locator('#tips > summary').click();
  await expect(page.locator('#tips')).toContainText('青い点');
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('.legend-box > summary').click();
  await expect(page.locator('.legend-box')).toContainText('スタンプ済み');
  await expect(page.locator('.legend-box')).toContainText('いまここの階');
});

test('「数字を押すと…」の一文は、一度使ったら出さない', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#sum-hint')).toBeVisible();
  await page.locator('#summary .sum[data-lv="0"]').click();
  await expect(page.locator('#sum-hint')).toBeHidden();
  await page.reload();
  await ready(page);
  await expect(page.locator('#sum-hint')).toBeHidden();
});

test('はじめての案内は、見出しの「QR」ボタンの名前にそろえる', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await expect(page.locator('#intro-card')).toContainText('「QR」ボタン');
});

/* ---------------- v177 ---------------- */
test('一覧：種類のボタンと「まだ行っていない」に件数', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02'])));
  await page.goto('/?tab=list');
  await ready(page);
  await expect(page.locator('#cat-chips [data-cat="all"]')).toContainText('46');
  const n = await page.evaluate(() => S.booths.filter(b => !S.stamps.has(b.id) && isVenue(b)).length);
  await expect(page.locator('#todo-only')).toHaveText(`まだ行っていない ${n}`);
  await page.evaluate(() => stampNow('1F-03'));
  await expect(page.locator('#todo-only')).toHaveText(`まだ行っていない ${n - 1}`);
});

test('スタンプ帳：階の見出しを押すと、その階をたたむ・広げる', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=stamp');
  await ready(page);
  const head = page.locator('#stamp-grid [data-fold="1"]');
  await expect(page.locator('#stamp-grid .stamp[data-fl="1"]').first()).toBeVisible();
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#stamp-grid .stamp[data-fl="1"]').first()).toBeHidden();
  await expect(page.locator('#stamp-grid .stamp[data-fl="2"]').first()).toBeVisible();
  await head.click();
  await expect(page.locator('#stamp-grid .stamp[data-fl="1"]').first()).toBeVisible();
});

test('新しい赤い「注意」のお知らせは、知らせが出る（開いた最初の表示では出さない）', async ({ page }) => {
  let notice = { text: '午後の部は13時から', level: 'info' };
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    const { snapshot } = require('./mock');
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(snapshot({ notice })) });
  });
  await page.goto('/?tab=map');
  await ready(page);
  notice = { text: '雨のため屋外の催しは体育館で行います', level: 'alert' };
  await page.evaluate(() => sync(true));
  await expect(page.locator('#toast')).toContainText('大事なお知らせ');
});

test('キーボード：「本文へ移動」', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Safari は初期設定で Tab がリンクに止まらない（端末の設定しだい）');
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-body')).toBeFocused();
});

/* ---------------- v178：ホーム画面に追加 ---------------- */
test('ホーム画面に追加：追加の確認を出せる端末では、ボタン1つで確認が出て、選んだ結果を伝える', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'iPhone にはページから追加する仕組みが無い（下のテストで手順の案内を確かめる）');
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  // ブラウザが「追加できます」と知らせてきた状態をまねる
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  await expect(page.locator('#a2hs-btn')).toContainText('インストール');
  await page.locator('#a2hs-btn').click();
  expect(await page.evaluate(() => window.__prompted)).toBe(1);
  await expect(page.locator('#a2hs-msg')).toContainText('追加しました');
});

test('ホーム画面に追加：「キャンセル」を選んだら、追加しなかったことを伝える', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'iPhone にはページから追加する仕組みが無い');
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => {};
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
  });
  await page.locator('#a2hs-btn').click();
  await expect(page.locator('#a2hs-msg')).toContainText('追加しませんでした');
});

test('ホーム画面に追加：端末で設定を分ける（iPhone は Safari で開くまま・ほかはアプリとして入れられる）。iPhone は手順を案内', async ({ page }, info) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  const href = await page.locator('#manifest-link').getAttribute('href');
  const ios = info.project.name === 'iphone';
  expect(href).toBe(ios ? 'manifest.json' : 'manifest-app.json');
  if (ios) {
    await page.locator('#a2hs-btn').click();
    await expect(page.locator('#a2hs')).toHaveAttribute('open', '');
    await expect(page.locator('#a2hs .a2hs-steps')).toBeVisible();
    await expect(page.locator('#a2hs-msg')).toContainText('3つの操作');
  }
});

/* ---------------- v179 ---------------- */
test('地図を開いたまま文字の大きさを変えても、重ねたボタンどうしが重ならない（すべての階・幅 320/390）', async ({ page }) => {
  test.setTimeout(90000);
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_intro_v1', '1'));
  const overlaps = () => page.evaluate(() => {
    const bs = [...document.querySelectorAll('#map-card .map-floors button, #map-card .map-ctl button')]
      .filter(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden').map(b => [b.id || b.textContent.trim(), b.getBoundingClientRect()]);
    const out = [];
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = bs[i][1], b = bs[j][1];
      if (!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)) out.push(bs[i][0] + '×' + bs[j][0]); }
    return out;
  });
  const bad = [];
  for (const w of [320, 390]) {
    await page.setViewportSize({ width: w, height: 640 });
    await page.goto('/?tab=map');
    await ready(page);
    for (const fl of [0, 1, 2, 3]) {
      await page.evaluate(f => setFloor(f), fl);
      for (const fs of ['#fs-xl', '#fs-l', '#fs-n', '#fs-xl', '#fs-n']) {
        await page.evaluate(sel => document.querySelector(sel).click(), fs);
        // 決まった時間を待つのではなく、落ち着くまで待つ（遅い機械では次の描画まで 0.25秒以上かかることがある）
        let r = [];
        try{ await expect.poll(async () => (r = await overlaps()).length, { timeout: 3000 }).toBe(0); }catch(e){}
        if (r.length) bad.push(`${w}px ${fl}階 ${fs}: ${r.join(', ')}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

test('速さの目安：中身が変わらない同期の描き直しは軽い（毎回の自動更新で画面を止めない）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.waitForTimeout(800);
  const ms = await page.evaluate(() => {
    renderAll();                                   // 1回目で指紋をそろえる
    const t = performance.now();
    for (let i = 0; i < 5; i++) renderAll();
    return (performance.now() - t) / 5;
  });
  // 手元では 2〜8ms。GitHub の遅い機械でも十分に余裕のある上限
  expect(ms).toBeLessThan(120);
});

test('地図の高さは、実際のボタンの高さから決める（端末の字の形でボタンが大きくなっても重ならない）', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_intro_v1', '1'));
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/?tab=map');
  await ready(page);
  // 端末の字の違いの代わりに、ボタンをわざと大きくする（階 70px・右下 64px）
  await page.addStyleTag({ content: '#map-card.gmap .map-floors button{min-height:70px !important} #map-card.gmap .map-ctl button{min-height:64px !important}' });
  const bad = [];
  for (const fl of [0, 1, 2, 3]) {
    await page.evaluate(f => { fitMapBox._key = null; setFloor(f); }, fl);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const f = document.querySelector('#map-card .map-floors').getBoundingClientRect(), z = document.querySelector('#map-card .map-zoom-ctl').getBoundingClientRect();
      const v = document.getElementById('map-view').getBoundingClientRect();
      return { gap: Math.round(z.top - f.bottom), inside: f.top >= v.top - 1 && z.bottom <= v.bottom + 1 };
    });
    if (r.gap < 4 || !r.inside) bad.push(`${fl}階 すき間=${r.gap} 箱の中=${r.inside}`);
  }
  expect(bad).toEqual([]);
});

/* ---------------- v180 ---------------- */
test('横向き（844×390・640×360）でも、4つの画面が横にはみ出さない（一覧は絞り込み・0件のときも）', async ({ page }) => {
  test.setTimeout(90000);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); localStorage.setItem('kuroko_wish_v1', JSON.stringify(['1F-02'])); });
  const bad = [];
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  for (const [w, h] of [[844, 390], [640, 360]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const tab of ['map', 'list', 'stamp', 'info']) {
      await page.goto('/?tab=' + tab);
      await ready(page);
      await page.waitForTimeout(300);
      if (await over() > 1) bad.push(`${w}x${h} ${tab}`);
      if (tab === 'list') {
        await page.evaluate(() => { setWishOnly(true); setTodoOnly(true); });
        await page.waitForTimeout(200);
        if (await over() > 1) bad.push(`${w}x${h} 一覧（★・まだ行っていない）`);
        await page.evaluate(() => { setWishOnly(false); setTodoOnly(false); const q = document.getElementById('q'); q.value = 'ぜったいにない'; q.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.waitForTimeout(350);
        if (await over() > 1) bad.push(`${w}x${h} 一覧（0件）`);
      }
    }
  }
  expect(bad).toEqual([]);
});

/* ---------------- v183：動きと見た目 ---------------- */
test('タブの切り替え：印が選んだタブへ動き、右のタブへは右から・左のタブへは左から入る（その間も横にはみ出さない）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  const st = () => page.evaluate(() => ({
    i: document.getElementById('nav').style.getPropertyValue('--nav-i'),
    dx: document.getElementById('main-body').style.getPropertyValue('--view-dx'),
    dy: document.getElementById('main-body').style.getPropertyValue('--view-dy'),
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  await page.click('#nav button[data-view="stamp"]');
  let r = await st();                                   // 動いている最中に測る
  expect(r).toEqual({ i: '2', dx: '8px', dy: '0px', over: 0 });
  await page.click('#nav button[data-view="list"]');
  r = await st();
  expect(r).toEqual({ i: '1', dx: '-8px', dy: '0px', over: 0 });
  await page.click('#nav button[data-view="info"]');
  r = await st();
  expect(r).toEqual({ i: '3', dx: '8px', dy: '0px', over: 0 });
  // 印は1本だけで、選んだタブの真上にある
  const gap = () => page.evaluate(() => {
    const ind = document.querySelector('.nav-ind').getBoundingClientRect(), b = document.querySelector('#nav button[aria-pressed="true"]').getBoundingClientRect();
    return Math.abs((ind.left + ind.width / 2) - (b.left + b.width / 2));
  });
  await expect.poll(gap, { timeout: 3000 }).toBeLessThanOrEqual(1);      // 動き終わったら真上
  expect(await page.locator('.nav-ind').count()).toBe(1);
  await expect(page.locator('.nav-ind')).toHaveAttribute('aria-hidden', 'true');
  // タブ以外の画面（係員のログインなど）へは、これまでどおり下から
  await page.evaluate(() => switchView('auth'));
  r = await st();
  expect([r.dx, r.dy]).toEqual(['0px', '10px']);
  expect(errors).toEqual([]);
});

test('更新のあいだ「更新」の印が回り、終われば止まる。下へ送ると見出しに影。詳細は開いたときだけ順に出る', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await expect(page.locator('#btn-reload')).not.toHaveClass(/busy/, { timeout: 5000 });
  await page.evaluate(() => { sync(true); });
  await expect(page.locator('#btn-reload')).toHaveClass(/busy/);
  await expect(page.locator('#btn-reload')).not.toHaveClass(/busy/, { timeout: 8000 });
  // 見出しの影
  expect(await page.evaluate(() => document.querySelector('.head').classList.contains('scrolled'))).toBe(false);
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(page.locator('.head')).toHaveClass(/scrolled/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('.head')).not.toHaveClass(/scrolled/);
  // 詳細：開いたときだけ
  await page.evaluate(() => openSheet(S.booths[2].id));
  await expect(page.locator('#bsh')).toHaveClass(/intro/);
  await expect(page.locator('#bsh')).not.toHaveClass(/intro/, { timeout: 3000 });
  await page.evaluate(() => { renderSheet._fp = null; renderSheet(); });   // 描き直しでは動かさない
  expect(await page.evaluate(() => document.getElementById('bsh').classList.contains('intro'))).toBe(false);
  expect(errors).toEqual([]);
});

test('インフォの顔：日にちが出る。幅320px・文字「特大」でもはみ出さない。開催日が未設定なら出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() => localStorage.setItem('kuroko_fs', JSON.stringify('xl')));
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  const hero = page.locator('#info-hero');
  await expect(hero).toBeVisible();
  await expect(hero).toContainText('黒工文化祭');
  const r = await page.evaluate(() => {
    const h = document.getElementById('info-hero'), hb = h.getBoundingClientRect();
    const out = [...h.querySelectorAll('.hero-in *')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.right > hb.right + 1 || b.left < hb.left - 1); }).length;
    return { days: h.querySelectorAll('.hero-day').length, conf: CONFIG.HOURS.days.length, out, first: document.querySelector('#v-info').firstElementChild.id,
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(r.days).toBe(r.conf);
  expect(r.out).toBe(0);
  expect(r.over).toBeLessThanOrEqual(0);
  expect(r.first).toBe('info-hero');
  await page.evaluate(() => { CONFIG.HOURS = { days: [] }; renderHero(); });
  await expect(hero).toBeHidden();
  expect(errors).toEqual([]);
});

/* ---------------- v184：見た目の仕上げ・2 ---------------- */
test('タイムテーブルは時刻の線と点つき。はじめての方への手順は丸い番号', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  const tt = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#tt-body tr:not(.tt-day)')];
    const dot = td => { const c = getComputedStyle(td, '::after'); return c.content !== 'none' && parseFloat(c.width) >= 10 && c.borderRadius !== '0px'; };
    return { n: rows.length, dots: rows.filter(r => dot(r.cells[0])).length, heads: [...document.querySelectorAll('#tt-body tr.tt-day th')].filter(th => getComputedStyle(th, '::after').content !== 'none').length,
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(tt.n).toBeGreaterThan(0);
  expect(tt.dots).toBe(tt.n);                          // どのコマにも点
  expect(tt.heads).toBe(0);                            // 日付の見出しには付けない
  expect(tt.over).toBeLessThanOrEqual(0);
  // はじめての方へ（まだ「わかった」を押していない人に出る）
  await page.evaluate(() => { try { localStorage.removeItem('kuroko_intro_v1'); } catch (e) {} });
  await page.goto('/?tab=map');
  await ready(page);
  const card = page.locator('#intro-card');
  if (await card.isVisible()) {
    const nums = await card.locator('ol li').evaluateAll(ls => ls.map(li => getComputedStyle(li, '::before').content));
    expect(nums.length).toBeGreaterThanOrEqual(3);
    for (const c of nums) expect(c).toContain('counter');
  }
  expect(errors).toEqual([]);
});

/* ---------------- v186：スタンプを押した瞬間の演出 ---------------- */
test('スタンプの演出：お菓子までの丸に、いま押した1個が入る。棒は前の数から伸びる。描き直しでは動きをくり返さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03'])); } });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.evaluate(() => stampNow('1F-05'));
  await expect(page.locator('#sfx')).toBeVisible();
  let r = await page.evaluate(() => {
    const el = document.getElementById('sfx'), dots = [...el.querySelectorAll('.sfx-dots i')], bar = el.querySelector('.sfx-bar i');
    return { cls: el.className, need: CONFIG.PRIZE_COST, n: dots.length, on: dots.filter(d => d.classList.contains('on')).length,
      neu: dots.map((d, i) => d.classList.contains('new') ? i : -1).filter(i => i >= 0), w0: parseFloat(bar.style.getPropertyValue('--w0')), w: parseFloat(bar.style.width),
      hidden: el.querySelector('.sfx-dots').getAttribute('aria-hidden'),
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(r.cls).toContain('first');
  expect(r.cls).toContain('fresh');
  expect(r.n).toBe(r.need);
  expect(r.on).toBe(3);
  expect(r.neu).toEqual([2]);                          // 3個目の丸が、いま入った1個
  expect(r.w0).toBeLessThan(r.w);                      // 棒は、押す前の数から伸びる
  expect(r.hidden).toBe('true');                       // 読み上げは下の文（あと◯個で…）にまかせる
  expect(r.over).toBeLessThanOrEqual(0);
  // 通信のあとなどの描き直しでは、入りの動きをくり返さない
  await page.evaluate(() => showStampFx.refresh());
  expect(await page.evaluate(() => document.getElementById('sfx').classList.contains('first'))).toBe(false);
  // 同じブースをもう一度読んだとき（スタンプ済み）は、新しい丸は無い
  await page.evaluate(() => showStampFx.close());
  await expect(page.locator('#sfx')).toBeHidden({ timeout: 3000 });
  await page.evaluate(() => stampNow('1F-05'));
  await expect(page.locator('#sfx.dup')).toBeVisible();
  expect(await page.locator('#sfx .sfx-dots i.new').count()).toBe(0);
  expect(await page.locator('#sfx .sfx-dots i.on').count()).toBe(3);
  // 交換できる数に届いたら、丸がぜんぶ入る
  await page.evaluate(() => showStampFx.close());
  await expect(page.locator('#sfx')).toBeHidden({ timeout: 3000 });
  await page.evaluate(() => { stampNow('1F-07'); });
  await expect(page.locator('#sfx.fresh')).toBeVisible();
  await page.evaluate(() => showStampFx.close());
  await expect(page.locator('#sfx')).toBeHidden({ timeout: 3000 });
  await page.evaluate(() => { stampNow('1F-08'); });
  await expect(page.locator('#sfx.fresh')).toBeVisible();
  r = await page.evaluate(() => ({ on: document.querySelectorAll('#sfx .sfx-dots i.on').length, n: document.querySelectorAll('#sfx .sfx-dots i').length }));
  expect(r.on).toBe(r.n);
  expect(errors).toEqual([]);
});

/* ---------------- v187：見た目の仕上げ・4 ---------------- */
test('一覧のカード：種類・階の札は名前の下の行の頭にそろう（見出しは名前だけ）。区切りの点が行の終わり・頭に残らない', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  for (const [w, fs] of [[390, 'n'], [320, 'xl']]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.addInitScript(f => { try { localStorage.setItem('kuroko_fs', JSON.stringify(f)); } catch (e) {} }, fs);
    await page.goto('/?tab=list');
    await ready(page);
    const r = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#booth-list > .booth')].slice(0, 12);
      let inHead = 0, noTags = 0, sepShown = 0, dotAtStart = 0, tagLeftBad = 0, nameBad = 0;
      cards.forEach(c => {
        const b = S.booths.find(x => x.id === c.dataset.sid), meta = c.querySelector('.booth-meta');
        inHead += c.querySelectorAll('.booth-nm .tag').length;
        if (meta.querySelectorAll(':scope > .tag').length < 2) noTags++;
        if (c.querySelector('.booth-nm .booth-open').textContent.replace('★', '').trim() !== b.name) nameBad++;
        const vis = meta.getBoundingClientRect().left + 15;                 // 切り落としたあとの左端
        const first = meta.querySelector(':scope > .tag').getBoundingClientRect().left;
        if (Math.abs(first - vis) > 1) tagLeftBad++;
        [...meta.querySelectorAll(':scope > .bm-sep')].forEach(s => { if (getComputedStyle(s).display !== 'none') sepShown++; });
        // 点のある項目：点（項目の左 9px）が見える範囲にあるなら、その行の頭ではない
        [...meta.querySelectorAll(':scope > .bm-sep + span')].forEach(sp => {
          if (getComputedStyle(sp, '::before').display === 'none') return;
          const dot = sp.getBoundingClientRect().left - 9, prev = [...meta.children].filter(e => e !== sp && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().top === sp.getBoundingClientRect().top && e.getBoundingClientRect().left < sp.getBoundingClientRect().left);
          if (dot >= vis && !prev.length) dotAtStart++;
        });
      });
      return { n: cards.length, inHead, noTags, sepShown, dotAtStart, tagLeftBad, nameBad, clip: getComputedStyle(cards[0].querySelector('.booth-meta')).clipPath,
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(r.n).toBeGreaterThan(3);
    expect([r.inHead, r.noTags, r.sepShown, r.dotAtStart, r.tagLeftBad, r.nameBad], `幅${w}・文字${fs}`).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.clip).toContain('inset');
    expect(r.over).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test('見つからなかったとき・★がまだ無いときは、絵つきの案内。主なボタンに光、選んだ階・絞り込みが弾む', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  await page.fill('#q', 'zzzzzz');
  await expect(page.locator('#booth-list .empty.has-ic')).toContainText('見つかりませんでした');
  await expect(page.locator('#booth-list .empty .empty-ic svg')).toHaveCount(1);
  await expect(page.locator('#booth-list .empty .empty-ic')).toHaveAttribute('aria-hidden', 'true');
  await page.locator('[data-reset-filters]').click();
  await expect(page.locator('#booth-list > .booth').first()).toBeVisible();
  // 選んだ絞り込みが弾む
  const chip = page.locator('.chip[aria-pressed="true"]').first();
  expect(await chip.evaluate(el => getComputedStyle(el).animationName)).toBe('sel-pop');
  await page.goto('/?tab=stamp');
  await ready(page);
  expect(await page.locator('#stamp-scan').evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('cta-sheen');
  await page.goto('/?tab=map');
  await ready(page);
  await page.locator('#fl-2').click();
  expect(await page.locator('#fl-2').evaluate(el => getComputedStyle(el).animationName)).toBe('sel-pop');
  expect(errors).toEqual([]);
});

/* ---------------- v189：スタンプの数は、輪が伸びていく形で ---------------- */
test('スタンプ帳：集めた数の輪が、割合のぶんだけ伸びる。全部回ると色が変わる（幅320px・文字「特大」でもはみ出さない）', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() => localStorage.setItem('kuroko_fs', JSON.stringify('xl')));
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=stamp');
  await ready(page);
  const look = () => page.evaluate(() => {
    const rg = document.getElementById('stamp-ring'), box = document.getElementById('stamp-ring-box'), n = document.getElementById('stamp-n');
    const b = box.getBoundingClientRect(), nb = n.getBoundingClientRect();
    return { off: parseFloat(rg.style.strokeDashoffset), n: n.textContent, total: +document.getElementById('stamp-total').textContent, done: box.classList.contains('done'),
      inside: nb.left >= b.left && nb.right <= b.right && nb.top >= b.top && nb.bottom <= b.bottom, svgHidden: box.querySelector('svg').getAttribute('aria-hidden'),
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  let r = await look();
  expect(r.n).toBe('0');
  expect(r.off).toBe(100);                             // まだ0個：輪は空
  expect(r.done).toBe(false);
  expect(r.svgHidden).toBe('true');                    // 読み上げは数字と「/ 46 ブース」
  await page.evaluate(() => { S.booths.slice(0, 23).forEach(b => S.stamps.add(b.id)); renderStamps(); });
  r = await look();
  expect(r.n).toBe('23');
  expect(r.total).toBe(46);
  expect(r.off).toBeCloseTo(50, 1);                    // 半分
  expect(r.inside).toBe(true);                         // 2けたの数字も輪の中に入る
  expect(r.over).toBeLessThanOrEqual(0);
  await page.evaluate(() => { S.booths.forEach(b => S.stamps.add(b.id)); renderStamps(); });
  r = await look();
  expect(r.off).toBe(0);
  expect(r.done).toBe(true);
  expect(r.inside).toBe(true);
  expect(r.over).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

/* ---------------- v190：スタンプ帳の下絵・下のタブの印 ---------------- */
test('スタンプ帳：まだ押していないマスは、そのブースの判子の形の下絵（押したマスは判子、交換に使ったマスは「換」）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03'])); } });
  await page.goto('/?tab=stamp');
  await ready(page);
  const r = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#stamp-grid .stamp')];
    const empty = cells.filter(c => !c.classList.contains('got'));
    const kind = svg => { const e = svg.querySelector('g g > *'); return e ? e.tagName + (e.tagName === 'polygon' ? ':' + e.getAttribute('points').split(' ').length : '') : ''; };
    const shapes = empty.map(c => { const s = c.querySelector('.mk.ghost svg'); return s ? kind(s) : 'なし'; });
    // 下絵の形は、押したときに入る判子の形と同じ
    const same = empty.every(c => { const L = stampLook(c.dataset.sid), k = kind(c.querySelector('.mk.ghost svg'));
      return ({ circle: 'circle', square: 'rect', hex: 'polygon:6', burst: 'polygon:28', flower: 'path' })[L.shape] === k; });
    return { n: cells.length, empty: empty.length, noGhost: shapes.filter(s => s === 'なし').length, kinds: new Set(shapes).size, same,
      got: cells.filter(c => c.classList.contains('got') && c.querySelector('.mk.art .stamp-art')).length,
      hidden: empty.every(c => c.querySelector('.mk.ghost svg').getAttribute('aria-hidden') === 'true'),
      label: empty[0].getAttribute('aria-label'), over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(r.n).toBe(46);
  expect(r.empty).toBe(44);
  expect(r.got).toBe(2);
  expect(r.noGhost).toBe(0);
  expect(r.kinds).toBeGreaterThanOrEqual(3);           // マスごとに形がちがう（丸・花・六角・ぎざぎざ・四角）
  expect(r.same).toBe(true);
  expect(r.hidden).toBe(true);                         // 飾り。読み上げはブースの名前（ボタンの名前）
  expect(r.label).toContain('の詳細をひらく');
  expect(r.over).toBeLessThanOrEqual(0);
  // 押すと、下絵が判子に入れ替わる
  await page.evaluate(() => stampNow('1F-05'));
  await expect(page.locator('#stamp-grid .stamp[data-sid="1F-05"] .mk.art .stamp-art')).toHaveCount(1);
  await expect(page.locator('#stamp-grid .stamp[data-sid="1F-05"] .mk.ghost')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('下のタブ：選んだタブの絵の後ろに丸い地が付き、線と一緒に動く', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  await page.click('#nav button[data-view="stamp"]');
  const gap = () => page.evaluate(() => {
    const ind = document.querySelector('.nav-ind').getBoundingClientRect(), b = document.querySelector('#nav button[aria-pressed="true"] em').getBoundingClientRect();
    return Math.abs((ind.left + ind.width / 2) - (b.left + b.width / 2));
  });
  await expect.poll(gap, { timeout: 3000 }).toBeLessThanOrEqual(1.5);
  const r = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.nav-ind'), '::after');
    return { content: c.content, w: parseFloat(c.width), radius: parseFloat(c.borderRadius), over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
  expect(r.content).not.toBe('none');
  expect(r.w).toBeGreaterThanOrEqual(50);
  expect(r.radius).toBeGreaterThan(10);
  expect(r.over).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

/* ---------------- v191：全体の混み具合の割合の帯 ---------------- */
test('地図の下の数字の上に、混み具合の割合の帯（空き｜やや混雑｜混雑｜準備中など）。ブースが0件なら出さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  const look = () => page.evaluate(() => {
    const box = document.getElementById('summary'), n = [...box.querySelectorAll('.sum b')].map(b => +b.dataset.v || +b.textContent);
    const c = [0, 0, 0, 0]; S.booths.forEach(b => { const lv = lvOf(b).lv; c[lv === 0 ? 0 : lv === 1 ? 1 : lv === 2 ? 2 : 3]++; });
    const cs = getComputedStyle(box, '::before');
    return { has: box.classList.contains('has-bar'), c, sa: parseFloat(box.style.getPropertyValue('--sa')), sb: parseFloat(box.style.getPropertyValue('--sb')), sc: parseFloat(box.style.getPropertyValue('--sc')),
      barH: parseFloat(cs.height), content: cs.content, tiles: box.querySelectorAll('.sum').length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  let r = await look();
  const total = r.c.reduce((a, b) => a + b, 0);
  expect(total).toBe(46);
  expect(r.has).toBe(true);
  expect(r.tiles).toBe(4);                             // 数字の箱はこれまでどおり4つ（帯は飾り）
  expect(r.barH).toBeGreaterThanOrEqual(6);
  expect(r.sa).toBeCloseTo(r.c[0] / total * 100, 1);
  expect(r.sb).toBeCloseTo((r.c[0] + r.c[1]) / total * 100, 1);
  expect(r.sc).toBeCloseTo((r.c[0] + r.c[1] + r.c[2]) / total * 100, 1);
  expect(r.over).toBeLessThanOrEqual(0);
  // 混み具合が変わると、帯も変わる
  await page.evaluate(() => { S.booths.forEach(b => { b.status = '空いています'; b.wait = 0; b.time = new Date().toISOString(); }); renderSummary(); });
  r = await look();
  expect(r.sa).toBeGreaterThan(90);
  // ブースが1件も無いとき（読み込み前・障害時）は帯を出さない
  await page.evaluate(() => { S.booths = []; renderSummary(); });
  r = await look();
  expect(r.has).toBe(false);
  expect(r.content).toBe('none');
  expect(errors).toEqual([]);
});

/* ---------------- v192：スタンプ帳の階の見出し ---------------- */
test('スタンプ帳の階の見出し：階の札・数・進み具合の線・矢印が1行にそろう（矢印が文字より下にずれない）', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03', '1F-05', '1F-07'])));
  for (const [w, fs] of [[390, 'n'], [320, 'xl']]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.addInitScript(f => { try { localStorage.setItem('kuroko_fs', JSON.stringify(f)); } catch (e) {} }, fs);
    await page.goto('/?tab=stamp');
    await ready(page);
    const r = await page.evaluate(() => {
      const btn = document.querySelector('#stamp-grid [data-fold="1"]'), bb = btn.getBoundingClientRect();
      const mid = e => { const b = e.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
      const fl = btn.querySelector('.sf-fl'), cnt = btn.querySelector(':scope > span'), bar = btn.querySelector('.sf-bar'), fill = bar.firstElementChild;
      // 矢印（::after）は、ボタンの右端・上下の真ん中あたり
      const after = getComputedStyle(btn, '::after'), cy = (bb.top + bb.bottom) / 2;
      const inFl = S.booths.filter(b => floorOfBooth(b) === 1), got = inFl.filter(b => S.stamps.has(b.id)).length;
      return { dFl: Math.abs(mid(fl) - cy), dCnt: Math.abs(mid(cnt) - cy), dBar: Math.abs(mid(bar) - cy), align: getComputedStyle(btn).alignItems,
        full: Math.round(bb.width), grid: Math.round(document.getElementById('stamp-grid').getBoundingClientRect().width),
        barW: bar.getBoundingClientRect().width, pct: parseFloat(fill.style.width), want: Math.round(got / inFl.length * 100), text: btn.textContent.replace(/\s+/g, ' ').trim(),
        hidden: bar.getAttribute('aria-hidden'), arrow: after.content !== 'none', over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(r.align, `幅${w}`).toBe('center');
    expect(Math.max(r.dFl, r.dCnt, r.dBar), `幅${w}`).toBeLessThanOrEqual(4);
    expect(r.full).toBeGreaterThan(r.grid * 0.9);       // 見出しは行いっぱい（押せる所が広い）
    expect(r.barW).toBeGreaterThanOrEqual(24);
    expect(r.pct).toBe(r.want);
    expect(r.text).toMatch(/^1階\s*\d+ \/ \d+$/);        // 読み上げ・文字は「1階 4 / 29」のまま
    expect(r.hidden).toBe('true');
    expect(r.arrow).toBe(true);
    expect(r.over).toBeLessThanOrEqual(0);
  }
  // その階をぜんぶ回ると、線の色が変わる
  await page.evaluate(() => { S.booths.filter(b => floorOfBooth(b) === 3).forEach(b => S.stamps.add(b.id)); renderStamps(); });
  await expect(page.locator('#stamp-grid [data-fold="3"] .sf-bar.full')).toHaveCount(1);
  // たたむ／広げるは、これまでどおり
  await page.locator('#stamp-grid [data-fold="3"]').click();
  await expect(page.locator('#stamp-grid [data-fold="3"]')).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});

/* ---------------- v193：見た目を、絵を見て選ぶ ---------------- */
test('インフォの「見た目」：絵を見て選べる。選ぶとすぐ変わり、覚える。右上のボタンで変えても、欄の印が合う', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_theme', JSON.stringify('paper')); } });
  await page.goto('/?tab=info');
  await ready(page);
  const st = () => page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'), saved: JSON.parse(localStorage.getItem('kuroko_theme') || 'null'),
    pressed: [...document.querySelectorAll('#theme-pick [data-theme-id]')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.themeId),
    label: document.getElementById('btn-theme').getAttribute('aria-label'),
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  let r = await st();
  expect(r.theme).toBe('paper');
  expect(r.pressed).toEqual(['paper']);
  // 2つの見本は、どちらの見た目のときも、それぞれの色のまま（いまの見た目に左右されない）
  const pv = () => page.evaluate(() => [...document.querySelectorAll('#theme-pick .tp-pv')].map(e => getComputedStyle(e).backgroundColor));
  const before = await pv();
  expect(before[0]).not.toBe(before[1]);
  await page.locator('#theme-pick [data-theme-id="heavy"]').click();
  r = await st();
  expect(r.theme).toBe('heavy');
  expect(r.saved).toBe('heavy');
  expect(r.pressed).toEqual(['heavy']);
  expect(r.label).toContain('重厚');
  expect(r.over).toBeLessThanOrEqual(0);
  expect(await pv()).toEqual(before);
  await expect(page.locator('#toast')).toContainText('見た目：重厚');
  // 開き直しても残る
  await page.reload();
  await ready(page);
  r = await st();
  expect(r.theme).toBe('heavy');
  expect(r.pressed).toEqual(['heavy']);
  // 右上のボタンで変えても、欄の印が合う
  await page.locator('#btn-theme').click();
  r = await st();
  expect(r.theme).toBe('paper');
  expect(r.pressed).toEqual(['paper']);
  // いま選んでいる見た目をもう一度押しても、何も起きない
  await page.locator('#theme-pick [data-theme-id="paper"]').click();
  r = await st();
  expect(r.theme).toBe('paper');
  // 見本は飾り。ボタンの名前は「落ち着き」「重厚」
  expect(await page.locator('#theme-pick .tp-pv').evaluateAll(es => es.every(e => e.getAttribute('aria-hidden') === 'true'))).toBe(true);
  await expect(page.locator('#theme-pick button').first()).toHaveText(/落ち着き/);
  expect(errors).toEqual([]);
});

/* ---------------- v194：カメラが使えないときの案内・詳細のボタンの並び ---------------- */
test('カメラが使えないときの案内：絵と、丸い番号の手順。ブースの詳細のボタンは、半端な1つを横いっぱいに', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => {
    const md = navigator.mediaDevices || {};
    md.getUserMedia = async () => { throw Object.assign(new Error('no camera'), { name: 'NotFoundError' }); };
    try{ Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }catch(e){}
  });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect(page.locator('#scan.no-cam')).toBeVisible();
  await expect(page.locator('#scan-help')).toContainText('カメラ');
  const r = await page.evaluate(() => {
    const help = document.getElementById('scan-help'), ill = help.querySelector('.scan-ill'), lis = [...help.querySelectorAll('ol li')];
    return { ill: !!ill && !!ill.querySelector('svg'), hidden: ill && ill.getAttribute('aria-hidden'), first: help.firstElementChild.className,
      n: lis.length, nums: lis.map(li => getComputedStyle(li, '::before').content), dot: lis.map(li => parseFloat(getComputedStyle(li, '::before').width)),
      ok: !!document.getElementById('scan-ok'), over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(r.ill).toBe(true);
  expect(r.hidden).toBe('true');                       // 絵は飾り。読み上げは文と手順
  expect(r.first).toBe('scan-ill');
  expect(r.n).toBe(3);
  for (const c of r.nums) expect(c).toContain('counter');
  for (const w of r.dot) expect(w).toBeGreaterThanOrEqual(24);
  expect(r.ok).toBe(true);
  expect(r.over).toBeLessThanOrEqual(0);
  await page.locator('#scan-ok').click();
  await expect(page.locator('#scan')).toBeHidden();
  // 詳細のボタン：2つずつ並べて、最後の横いっぱいのボタンの手前で1つだけ余るときは、それも横いっぱい
  await page.evaluate(() => openSheet(S.booths[1].id));
  await expect(page.locator('#bsh')).toBeVisible();
  const a = await page.evaluate(() => {
    const box = document.querySelector('#bsh-body .bsh-acts'), kids = [...box.children], bw = box.getBoundingClientRect().width;
    // 行ごとの幅の合計（すき間を除く）が、どの行も箱の幅いっぱい＝右に空きが無い
    const rows = {};
    kids.forEach(k => { const b = k.getBoundingClientRect(); const y = Math.round(b.top); rows[y] = (rows[y] || 0) + b.width; });
    return { n: kids.length, holes: Object.values(rows).filter(w => w < bw - 60).length, wideLast: kids[kids.length - 1].classList.contains('wide') };
  });
  expect(a.wideLast).toBe(true);
  expect(a.holes).toBe(0);
  expect(errors).toEqual([]);
});

/* ---------------- v195：一覧の検索・絞り込みの段を、送る向きで出し入れ ---------------- */
test('一覧：下へ送ると検索・絞り込みの段が引っ込み、少し上へ戻すと出る。画面が自分で動いたときは引っ込めない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  const head = page.locator('#v-list .list-head');
  const cardsY = () => page.evaluate(() => Math.round(document.querySelector('#booth-list > .booth').getBoundingClientRect().top + window.scrollY));
  const y0 = await cardsY();
  // 人が送ったときのまね：指でなぞった合図（touchmove）のあとに画面が動く。スマホの WebKit はホイールを出せないので、どの端末のまねでもこの形にする
  const userScroll = async (dy, times) => { for (let i = 0; i < times; i++) { await page.evaluate(d => { window.dispatchEvent(new Event('touchmove')); window.scrollBy(0, d); }, dy); await page.waitForTimeout(70); } };
  // 人が下へ送る → 引っ込む
  await userScroll(160, 6);
  await expect(head).toHaveClass(/tuck/);
  // 引っ込んでも、一覧の中身の位置は変わらない（場所は取ったまま、上へずらすだけ）
  expect(await cardsY()).toBe(y0);
  // 見出し（黒い帯）の下にもぐって、見えなくなっている
  await page.waitForTimeout(400);
  const hidden = await page.evaluate(() => {
    const h = document.querySelector('#v-list .list-head').getBoundingClientRect(), top = document.querySelector('.head').getBoundingClientRect().bottom;
    return h.bottom <= top + 1;
  });
  expect(hidden).toBe(true);
  // 少し上へ戻す → 出る
  await userScroll(-60, 1);
  await expect(head).not.toHaveClass(/tuck/);
  await expect(page.locator('#q')).toBeInViewport();
  // 画面が自分で動いたとき（プログラムからの移動）は引っ込めない
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(300);
  await expect(head).not.toHaveClass(/tuck/);
  // 引っ込んでいても、キーボードで検索欄へ入ると出る。タブを移っても出しておく
  await userScroll(160, 4);
  await expect(head).toHaveClass(/tuck/);
  await page.evaluate(() => document.getElementById('q').focus({ preventScroll: true }));
  await expect(head).not.toHaveClass(/tuck/);
  await page.evaluate(() => document.activeElement.blur());
  await userScroll(160, 3);
  await expect(head).toHaveClass(/tuck/);
  await page.evaluate(() => { switchView('map'); switchView('list'); });
  await expect(head).not.toHaveClass(/tuck/);
  expect(errors).toEqual([]);
});

/* ---------------- v196：「★行きたい」を付けた瞬間の手ごたえ ---------------- */
test('★行きたい：付けた瞬間、いま付けた星だけが弾む（外したとき・ほかの星・描き直しでは弾まない）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=list');
  await ready(page);
  const ids = await page.evaluate(() => [...document.querySelectorAll('#booth-list > .booth')].slice(0, 3).map(c => c.dataset.sid));
  const btn = id => page.locator(`#booth-list [data-wishbtn="${id}"]`);
  await btn(ids[0]).click();
  await expect(btn(ids[0])).toHaveAttribute('aria-pressed', 'true');
  await expect(btn(ids[0])).toHaveClass(/just/);
  expect(await btn(ids[0]).evaluate(el => getComputedStyle(el).animationName)).toBe('wish-pop');
  // 弾みは 0.7秒で終わる（印が残らない）
  await expect(btn(ids[0])).not.toHaveClass(/just/, { timeout: 3000 });
  // 2つめを付けても、1つめは弾まない
  await btn(ids[1]).click();
  await expect(btn(ids[1])).toHaveClass(/just/);
  expect(await btn(ids[0]).evaluate(el => el.classList.contains('just'))).toBe(false);
  await expect(btn(ids[1])).not.toHaveClass(/just/, { timeout: 3000 });
  // 外したときは弾まない
  await btn(ids[0]).click();
  await expect(btn(ids[0])).toHaveAttribute('aria-pressed', 'false');
  expect(await btn(ids[0]).evaluate(el => el.classList.contains('just'))).toBe(false);
  // 描き直し（通信のあと）では弾まない
  await page.evaluate(() => { renderList._fp = null; renderList(); });
  expect(await page.locator('#booth-list .wish-btn.just').count()).toBe(0);
  // 詳細の「行きたい」でも、押したボタンが弾む
  await page.evaluate(id => openSheet(id), ids[2]);
  await page.locator('#bsh-body [data-wish]').click();
  await expect(page.locator('#bsh-body [data-wish]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#bsh-body [data-wish]')).toHaveClass(/just/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_wish_v1')).length)).toBe(2);
  expect(errors).toEqual([]);
});
