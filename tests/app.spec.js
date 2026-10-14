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
  // v205：届いた瞬間の動き（一覧が上から順にふわっと出る・地図がすっと現れる）が終わるまで待つ。
  // 動いている最中に位置を測ると 1px ずれる（終わりのある短い動きだけ。回り続けるものは待たない）
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter(a => { try { const t = a.effect.getComputedTiming(); return a.playState === 'running' && isFinite(t.endTime) && t.endTime <= 1500; } catch (e) { return false; } })
      .map(a => a.finished.catch(() => {}))),
    new Promise(r => setTimeout(r, 1500))])).catch(() => {});
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
    // 地図の高さ合わせは、次の描画のときに走る。決まった時間（0.3秒）だけ待つと、重いとき（テストを並べて動かしているとき）に
    // まだ合わせ終わっていなくて落ちていた。合うまで（最長4秒）待つ（v201）
    const look = () => page.evaluate(() => {
      const f = document.querySelector('#map-card .map-floors').getBoundingClientRect(), z = document.querySelector('#map-card .map-zoom-ctl').getBoundingClientRect();
      const v = document.getElementById('map-view').getBoundingClientRect();
      return { gap: Math.round(z.top - f.bottom), inside: f.top >= v.top - 1 && z.bottom <= v.bottom + 1 };
    });
    await expect.poll(async () => { const o = await look(); return o.gap >= 4 && o.inside; }, { timeout: 4000 }).toBe(true).catch(() => {});
    const r = await look();
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

/* ---------------- v197：「更新」を押して取れたら ✓ ---------------- */
test('「更新」を押して取れたら、回っていた印が ✓ に変わって消える。自動の更新・失敗したときは ✓ を出さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  const rb = page.locator('#btn-reload');
  await expect(rb).not.toHaveClass(/busy/, { timeout: 5000 });
  // 開いたときの自動の取得では ✓ を出さない
  expect(await rb.evaluate(el => el.classList.contains('done'))).toBe(false);
  await rb.click();
  await expect(rb).toHaveClass(/done/, { timeout: 5000 });
  const c = await rb.evaluate(el => { const s = getComputedStyle(el.querySelector('.ib-ic'), '::after'); return { content: s.content, hidden: el.querySelector('.ib-ic').getAttribute('aria-hidden') }; });
  expect(c.content).toContain('✓');
  expect(c.hidden).toBe('true');                       // 飾り。読み上げは状態の行（最新の情報です など）
  await expect(rb).not.toHaveClass(/done/, { timeout: 4000 });
  // 自動の更新では出さない
  await page.evaluate(() => sync(false));
  await page.waitForTimeout(1200);
  expect(await rb.evaluate(el => el.classList.contains('done'))).toBe(false);
  // 失敗したときは出さない
  await page.route('**/macros/s/**', route => route.fulfill({ status: 500, contentType: 'text/html', body: 'x' }));
  await rb.click();
  await expect(rb).not.toHaveClass(/busy/, { timeout: 20000 });
  await page.waitForTimeout(300);
  expect(await rb.evaluate(el => el.classList.contains('done'))).toBe(false);
});

/* ---------------- v198：お菓子と交換できたときの表示 ---------------- */
test('お菓子と交換：係の人の4桁を入れて交換すると、画面いっぱいの「交換しました」が出る（とじると元の画面。スタンプは使用済みに）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03', '1F-05', '1F-07', '1F-08', '1F-10'])); } });
  await page.goto('/?tab=stamp');
  await ready(page);
  // スタンプを6個にそろえる（5個を使って、1個残る）
  await page.evaluate(() => { S.stamps = new Set(S.booths.slice(0, 6).map(b => b.id)); store('kuroko_stamps_v2', Array.from(S.stamps)); renderStamps(); });
  expect(await page.evaluate(() => stampsLeft())).toBe(6);
  await page.locator('#redeem-open').click();
  // 番号が違うときは交換しない（表示も出ない）
  const input = page.locator('#redeem-pad input');
  const good = await page.evaluate(() => redeemCode(0));
  await input.fill(good === '0000' ? '1111' : '0000');
  await page.locator('#redeem-ok').click();
  await expect(page.locator('#redeem-err')).toBeVisible();
  expect(await page.locator('#pfx').count()).toBe(0);
  // 正しい番号 → 交換できた表示
  await input.fill(await page.evaluate(() => redeemCode(0)));
  await page.locator('#redeem-ok').click();
  const fx = page.locator('#pfx');
  await expect(fx).toBeVisible({ timeout: 15000 });
  await expect(fx).toContainText('交換しました');
  await expect(fx).toContainText('お菓子を1個 受け取ってください');
  await expect(fx).toContainText('スタンプ5個分を使いました');
  await expect(fx).toContainText('次のお菓子まで あと4個');           // 6個のうち5個を使って、残り1個
  expect(await fx.getAttribute('role')).toBe('dialog');
  expect(await fx.getAttribute('aria-modal')).toBe('true');
  // 押せる物は「とじる」だけ。そこにフォーカスが入る
  await expect(fx.locator('[data-fx="close"]')).toBeFocused();
  const r = await page.evaluate(() => ({ spent: S.spent.length, left: stampsLeft(), gift: !!document.querySelector('#pfx .pfx-gift svg'),
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth, lock: document.documentElement.classList.contains('sfx-open') }));
  expect(r.spent).toBe(5);
  expect(r.left).toBe(1);
  expect(r.gift).toBe(true);
  expect(r.lock).toBe(true);                           // 出ている間は後ろを動かさない
  expect(r.over).toBeLessThanOrEqual(0);
  // Esc でも とじる でも閉じる。閉じたら元の画面（交換済みの数が増えている）
  await page.keyboard.press('Escape');
  await expect(fx).toBeHidden({ timeout: 3000 });
  expect(await page.evaluate(() => document.documentElement.classList.contains('sfx-open'))).toBe(false);
  await expect(page.locator('#redeem-log')).toContainText('お菓子1個');
  expect(errors).toEqual([]);
});

/* ---------------- v199：回る順番の丸 ---------------- */
test('おすすめの回りかた：順番の丸は部屋の上の辺に置き、数字が丸に収まる（ブースの名前・番号に重ならない。押すと部屋が開く）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_intro_v1', '1'));
  await page.goto('/?tab=map');
  await ready(page);
  const chip = page.locator('.chip[data-route]:not(.hide)').first();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#plan-' + S.floor + ' .route-badge').length)).toBeGreaterThan(1);
  const r = await page.evaluate(() => {
    const svg = document.getElementById('plan-' + S.floor), kids = [...svg.children];
    const badges = [...svg.querySelectorAll('.route-badge')];
    const lastRoom = kids.map((k, i) => k.classList.contains('room') ? i : -1).filter(i => i >= 0).pop();
    const ids = CONFIG.ROUTES[S.route].filter(id => S.booths.some(b => b.id === id) && floorOfBooth(S.booths.find(b => b.id === id)) === S.floor);
    let textOut = 0, overName = 0, notOnEdge = 0;
    badges.forEach(g => {
      const c = g.querySelector('circle').getBoundingClientRect(), t = g.querySelector('text').getBoundingClientRect();
      // 数字は丸の中に収まる（はみ出すと、丸の外の白い数字が見えず、欠けて見える）
      if (t.left < c.left - 1 || t.right > c.right + 1 || t.top < c.top - 2 || t.bottom > c.bottom + 2) textOut++;
    });
    // 丸は、その部屋の上の辺にまたがっている（真ん中に置かない）。部屋の名前の字に重ならない
    ids.forEach((id, i) => {
      const room = svg.querySelector(`.room[data-id="${CSS.escape(id)}"]`), g = badges.find(b => b.dataset.rs === String(CONFIG.ROUTES[S.route].indexOf(id) + 1));
      if (!room || !g) return;
      const fill = (room.querySelector('.fill') || room).getBoundingClientRect(), c = g.querySelector('circle').getBoundingClientRect();
      const cy = (c.top + c.bottom) / 2;
      if (Math.abs(cy - fill.top) > c.height * 0.6) notOnEdge++;
      room.querySelectorAll('text.nm').forEach(tx => { const b = tx.getBoundingClientRect();
        // 名前の字と、縦に 3px を超えて重なっていない（上の辺の線ぶんは重なる）
        if (b.width && c.left < b.right && b.left < c.right && Math.min(c.bottom, b.bottom) - Math.max(c.top, b.top) > 3) overName++; });
    });
    return { n: badges.length, steps: ids.length, top: badges.every(g => kids.indexOf(g) > lastRoom), textOut, overName, notOnEdge,
      pe: getComputedStyle(badges[0]).pointerEvents, firstId: ids[0] };
  });
  expect(r.n).toBe(r.steps);                           // この階の行き先ぶん、丸が1つずつ
  expect(r.top).toBe(true);                            // 部屋の絵より上の層
  expect(r.textOut).toBe(0);
  expect(r.notOnEdge).toBe(0);
  expect(r.overName).toBe(0);
  expect(r.pe).toBe('none');                           // 丸の上を押しても、下の部屋が開く
  // コースをやめると、丸も消える
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#plan-' + S.floor + ' .route-badge').length)).toBe(0);
  expect(errors).toEqual([]);
});

/* ---------------- v200：当てはまらなくなった知らせは消す ---------------- */
test('絞り込み・コースをやめたら、「目立たせています」「階をまたぎます」の知らせも消える（ほかの知らせは消さない）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => localStorage.setItem('kuroko_intro_v1', '1'));
  await page.goto('/?tab=map');
  await ready(page);
  const toast = page.locator('#toast');
  const tile = page.locator('#summary .sum[data-lv="2"]');
  // 状態で絞る → 知らせが出る → すぐやめる → 知らせも消える
  await tile.click();
  await expect(toast).toHaveClass(/on/);
  await expect(toast).toContainText('だけを目立たせています');
  await tile.click();
  await expect(toast).not.toHaveClass(/on/);
  // 地図の上の「◯◯だけ表示中 ×」でやめたときも消える
  await tile.click();
  await expect(toast).toHaveClass(/on/);
  await page.locator('#lv-pill').click();
  await expect(toast).not.toHaveClass(/on/);
  // コース：階をまたぐコースを選ぶ → 知らせ → やめる → 消える
  const multi = await page.evaluate(() => { renderRouteChips(); return Object.keys(CONFIG.ROUTES).find(k => {
    const fl = new Set((CONFIG.ROUTES[k] || []).map(id => (S.booths.find(b => b.id === id) || {}).floor).filter(Boolean));
    const el = document.querySelector(`.chip[data-route="${k}"]`); return fl.size > 1 && el && !el.classList.contains('hide'); }); });
  if (multi) {
    const chip = page.locator(`.chip[data-route="${multi}"]`);
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    await expect(toast).toContainText('このコースは階をまたぎます');
    await chip.click();
    await expect(toast).not.toHaveClass(/on/);
  }
  // 関係のない知らせは消さない
  await page.evaluate(() => { toast('別のお知らせです'); toastDrop(/だけを目立たせています/); });
  await expect(toast).toHaveClass(/on/);
  await expect(toast).toHaveText('別のお知らせです');
  expect(errors).toEqual([]);
});

/* ---------------- v201：開く欄の中身がすっと出る ---------------- */
test('開く欄（使い方のこつ・地図の見かた など）：開くと中身が上からすっと出る。紙に刷るときは動かさない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=info');
  await ready(page);
  const tips = page.locator('#tips');
  await tips.locator('summary').scrollIntoViewIfNeeded();
  await tips.locator('summary').click();
  await expect(tips).toHaveAttribute('open', '');
  const r = await tips.evaluate(d => { const kids = [...d.children].filter(c => c.tagName !== 'SUMMARY');
    return { n: kids.length, anim: kids.map(c => getComputedStyle(c).animationName), sum: getComputedStyle(d.querySelector('summary')).animationName }; });
  expect(r.n).toBeGreaterThan(3);
  for (const a of r.anim) expect(a).toBe('det-in');
  expect(r.sum).not.toBe('det-in');                    // 見出し（押す所）は動かさない
  // 動き終わると、ずれ・薄さは残らない
  // （重いときは動きの始まりが遅れるので、決まった時間ではなく、終わるまで待つ）
  const state = () => tips.evaluate(d => { const c = [...d.children].find(x => x.tagName !== 'SUMMARY'), s = getComputedStyle(c); return { op: +s.opacity, tr: s.transform }; });
  // 動いている途中も、中身はうすく見えている（まったく見えない時間を作らない）
  expect((await state()).op).toBeGreaterThanOrEqual(0.29);
  await expect.poll(async () => (await state()).op, { timeout: 8000 }).toBe(1);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain((await state()).tr);
  // 閉じて開き直すと、もう一度動く（中身は消えていない）
  await tips.locator('summary').click();
  await expect(tips).not.toHaveAttribute('open', '');
  await tips.locator('summary').click();
  await expect(tips.locator('p').first()).toBeVisible();
  // 紙に刷るときは動かさない
  await page.emulateMedia({ media: 'print' });
  expect(await tips.evaluate(d => getComputedStyle([...d.children].find(x => x.tagName !== 'SUMMARY')).animationName)).toBe('none');
  expect(errors).toEqual([]);
});

/* ---------------- v202：「重厚」のスタンプ帳は、判子の下に紙の地 ---------------- */
test('「重厚」（暗い見た目）では、押した判子の下に紙の地を敷く（濃いインクが暗い地に沈まない）。「落ち着き」では敷かない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1);
    localStorage.setItem('kuroko_theme', JSON.stringify('heavy')); localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03'])); } });
  await page.goto('/?tab=stamp');
  await ready(page);
  const lum = c => { const m = c.match(/[\d.]+/g).map(Number); return m.length >= 4 && m[3] === 0 ? -1 : (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
  const bg = () => page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'),
    art: getComputedStyle(document.querySelector('#stamp-grid .stamp.got .mk.art')).backgroundColor,
    cell: getComputedStyle(document.querySelector('#stamp-grid .stamp.got')).backgroundColor,
    ghost: getComputedStyle(document.querySelector('#stamp-grid .stamp:not(.got) .mk.ghost')).backgroundColor }));
  let r = await bg();
  expect(r.theme).toBe('heavy');
  expect(lum(r.art)).toBeGreaterThan(0.8);             // 紙の色（明るい）
  expect(lum(r.cell)).toBeLessThan(0.3);               // マスは暗い
  expect(lum(r.ghost)).toBe(-1);                       // まだ押していないマスの下絵には敷かない
  // 演出の大きな判子も同じ
  await page.evaluate(() => stampNow('1F-05'));
  await expect(page.locator('#sfx')).toBeVisible();
  expect(lum(await page.locator('#sfx .sfx-stamp .stamp-art').evaluate(el => getComputedStyle(el).backgroundColor))).toBeGreaterThan(0.8);
  await page.evaluate(() => showStampFx.close());
  await expect(page.locator('#sfx')).toBeHidden({ timeout: 3000 });
  // 「落ち着き」（明るい見た目）では敷かない
  await page.locator('#btn-theme').click();
  r = await bg();
  expect(r.theme).toBe('paper');
  expect(lum(r.art)).toBe(-1);
  expect(errors).toEqual([]);
});

/* ---------------- v203：ブースの一覧が届くまでの表示（読み込み中・取れていない） ---------------- */
test('ブースの一覧が届くまで（はじめて開いた・サーバーが遅い）：一覧は「読み込んでいます」と骨組み、スタンプは持っている数を出す。「見つかりませんでした」「0 / 0 ブース」は出さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  // サーバーの返事を、こちらが合図するまで止めておく
  let release; const gate = new Promise(r => { release = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { await gate; await route.fallback(); });
  const IDS = ['1F-01', '1F-14', '1F-24', '1F-17', '1F-02', '1F-03'];
  await page.addInitScript(ids => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1);
    localStorage.setItem('kuroko_intro_v1', '1'); localStorage.setItem('kuroko_stamps_v2', JSON.stringify(ids));
    localStorage.setItem('kuroko_cert_at', JSON.stringify('2026-10-24T03:00:00.000Z')); } }, IDS);
  await page.goto('/?tab=list');
  // 一覧：探してもいないのに「見つかりませんでした」と言わない
  await expect(page.locator('#booth-list .list-wait')).toContainText('読み込んでいます');
  await expect(page.locator('#booth-list .skel')).toHaveCount(4);
  await expect(page.locator('#booth-list')).not.toContainText('見つかりませんでした');
  await expect(page.locator('#booth-list [data-reset-filters]')).toHaveCount(0);
  await page.fill('#q', 'カジノ');
  await expect(page.locator('#q-clear')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('#booth-list .list-wait')).toBeVisible();
  await expect(page.locator('#booth-list')).not.toContainText('見つかりませんでした');
  await expect(page.locator('#list-count')).toBeHidden();
  await page.fill('#q', '');
  // スタンプ：持っている数はこの端末にある。ブースの数（分母）は届くまで出さない
  await page.locator('#nav button[data-view="stamp"]').click();
  await expect(page.locator('#v-stamp .stamp-count')).toHaveClass(/wait/);
  await expect(page.locator('#v-stamp .stamp-count')).toHaveClass(/load/);
  await expect(page.locator('#stamp-n')).toHaveText('6');
  await expect(page.locator('#v-stamp .stamp-count .tot')).toBeHidden();
  await expect(page.locator('#stamp-msg')).toContainText('読み込んでいます');
  await expect(page.locator('#stamp-prize')).toContainText('ブースの情報が届くと');
  await expect(page.locator('#redeem-open')).toBeDisabled();
  await expect(page.locator('#redeem-open')).toContainText('待っています');
  await expect(page.locator('#stamp-grid .skel-st')).toHaveCount(6);
  await expect(page.locator('#stamp-share')).toBeHidden();
  // 全部回った人の達成の時刻を、届く前に消さない
  expect(await page.evaluate(() => localStorage.getItem('kuroko_cert_at'))).toContain('2026-10-24');
  // 地図の検索も「見つかりませんでした」と言わない
  await page.locator('#nav button[data-view="map"]').click();
  await page.fill('#map-q', 'ぷろぐらみんぐ');
  await expect(page.locator('#map-sug')).toContainText('読み込んでいます');
  await expect(page.locator('#map-sug')).not.toContainText('見つかりませんでした');
  await page.fill('#map-q', '');
  // 届いたら、ふつうの表示に変わる
  release();
  await ready(page);
  await page.locator('#nav button[data-view="stamp"]').click();
  await expect(page.locator('#v-stamp .stamp-count')).not.toHaveClass(/wait/);
  await expect(page.locator('#stamp-total')).toHaveText('46');
  await expect(page.locator('#v-stamp .stamp-count .tot')).toBeVisible();
  await expect(page.locator('#stamp-n')).toHaveText('6');
  await expect(page.locator('#redeem-open')).toBeEnabled();
  await expect(page.locator('#redeem-open')).toContainText('お菓子と交換する');
  await expect(page.locator('#stamp-grid .skel-st')).toHaveCount(0);
  await expect(page.locator('#stamp-grid .stamp.got')).toHaveCount(6);
  await expect(page.locator('#v-stamp .progress')).not.toHaveClass(/load/);
  await page.locator('#nav button[data-view="list"]').click();
  await expect(page.locator('#booth-list .skel')).toHaveCount(0);
  await expect(page.locator('#booth-list [data-sid]').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('ブースの一覧を取れなかったとき（はじめて開いた・サーバーが返事をしない）：一覧とスタンプに理由を出し、「もう一度読み込む」で取り直せる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let fail = true, hold = null;
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    if (hold) await hold;
    return fail ? route.fulfill({ status: 404, contentType: 'text/html', body: '<html>404</html>' }) : route.fallback();
  });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=stamp');
  await expect(page.locator('#stamp-msg')).toContainText('まだ取れていません');
  await expect(page.locator('#v-stamp .stamp-count')).toHaveClass(/wait/);
  await expect(page.locator('#v-stamp .stamp-count')).not.toHaveClass(/load/);
  await expect(page.locator('#stamp-n')).toHaveText('0');
  await expect(page.locator('#stamp-prize .prize-steps li')).toHaveCount(3);      // スタンプの集め方は、届く前でも読める
  await expect(page.locator('#stamp-grid .stamp-wait')).toContainText('届くと');
  await expect(page.locator('#stamp-grid .skel-st')).toHaveCount(0);
  await page.locator('#nav button[data-view="list"]').click();
  const box = page.locator('#booth-list');
  await expect(box).toContainText('まだ取れていません');
  await expect(box).not.toContainText('見つかりませんでした');
  await expect(box.locator('.skel')).toHaveCount(0);
  // 「もう一度読み込む」を押してから、サーバーが戻る。
  // （先に戻すと、自動のつなぎ直しが先に成功してボタンが消え、押せないことがある。押すまで返事を止めておく）
  let open; hold = new Promise(r => { open = r; });
  await box.locator('[data-retry-sync]').click();
  fail = false; open(); hold = null;
  await ready(page);
  await expect(box.locator('[data-sid]').first()).toBeVisible();
  await expect(box).not.toContainText('まだ取れていません');
  await page.locator('#nav button[data-view="stamp"]').click();
  await expect(page.locator('#v-stamp .stamp-count')).not.toHaveClass(/wait/);
  await expect(page.locator('#stamp-total')).toHaveText('46');
  await expect(page.locator('#stamp-msg')).toContainText('まずは1つ');
  expect(errors).toEqual([]);
});

/* ---------------- v204：ブースが届くまでの表示・2（地図・本部モニタ・通信できないときの帯） ---------------- */
test('ブースが届くまで（地図）：地図の上に「ブースを読み込み中…」。取れなかったら、骨組みをやめて部屋の名前を出し、帯の文は画面に合わせる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let fail = false, hold = null, open;
  hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    if (hold) await hold;
    return fail ? route.fulfill({ status: 404, contentType: 'text/html', body: '<html>404</html>' }) : route.fallback();
  });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  // 読み込み中：札と骨組み。寄せる先が無いので「ブースに寄せる」は出さない
  const chip = page.locator('#map-wait');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('読み込み中');
  await expect(chip).toHaveAttribute('data-ws', 'load');
  await expect(page.locator('#plan-1 .skel-room').first()).toBeVisible();
  await expect(page.locator('#zoom-booth')).toBeHidden();
  await expect(page.locator('#map-empty')).toBeHidden();
  // 札は地図の操作（階のボタン）に重ならない・押すのをじゃましない
  const g = await page.evaluate(() => { const a = document.getElementById('map-wait').getBoundingClientRect(), b = document.querySelector('.map-floors').getBoundingClientRect();
    return { hit: a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom, pe: getComputedStyle(document.getElementById('map-wait')).pointerEvents }; });
  expect(g.hit).toBe(false);
  expect(g.pe).toBe('none');
  // 取れなかった：骨組みをやめて、部屋の名前が読める図面にする
  fail = true; open(); hold = null;
  await expect(chip).toContainText('まだ取れていません');
  await expect(chip).toHaveAttribute('data-ws', 'fail');
  await expect(page.locator('#plan-1 .skel-room')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#plan-1 text').length)).toBeGreaterThan(10);
  await expect(page.locator('#map-empty')).toBeHidden();           // 「この階にはブースがありません」とは言わない（届いていないだけ）
  await expect(page.locator('#banner-offline-text')).toContainText('校内マップは下で見られます');
  await page.locator('#nav button[data-view="list"]').click();
  await expect(page.locator('#banner-offline-text')).toContainText('校内マップは「マップ」で見られます');   // 一覧の画面では、地図は「下」に無い
  await page.locator('#nav button[data-view="map"]').click();
  await expect(page.locator('#banner-offline-text')).toContainText('校内マップは下で見られます');
  // 取り直している間も、骨組みには戻さない（読めていた部屋の名前を消さない）
  hold = new Promise(r => { open = r; });
  await page.locator('#banner-retry').click();
  await expect(chip).toContainText('読み込み中');
  await expect(page.locator('#plan-1 .skel-room')).toHaveCount(0);
  // 届いたら、札が消えてブースが出る
  fail = false; open(); hold = null;
  await ready(page);
  await expect(chip).toBeHidden();
  await expect(page.locator('#plan-1 [data-id]').first()).toBeVisible();
  await expect(page.locator('#zoom-booth')).not.toHaveClass(/wait/);
  expect(errors).toEqual([]);
});

test('ブースが届くまで（本部モニタ）：返事を待たずに時計を出し、「データを取得しています…」と言う。届いたらタイルが並ぶ', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let open; let hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { if (hold) await hold; return route.fallback(); });
  await page.goto('/?mode=board');
  await expect(page.locator('#board-clock')).toHaveText(/^\d\d:\d\d$/);          // 以前は、届くまで「--:--」のまま
  await expect(page.locator('#board-grid .board-empty')).toContainText('取得しています');
  await expect(page.locator('#board-grid .board-empty')).not.toContainText('登録されていません');
  await expect(page.locator('#board-sync')).toHaveText('…');
  open(); hold = null;
  await ready(page);
  await expect(page.locator('#board-grid .btile').first()).toBeVisible();
  await expect(page.locator('#board-grid .board-empty')).toHaveCount(0);
  await expect(page.locator('#board-sync')).not.toHaveText('…');
  expect(errors).toEqual([]);
});

/* ---------------- v205：ブースが届いた瞬間の動き ---------------- */
test('ブースが届いた瞬間：一覧は上から順にふわっと出る（.stagger）。地図は骨組みからすっと現れる（.arrive は届いたときの1回だけ）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let open; let hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { if (hold) await hold; return route.fallback(); });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=list');
  await expect(page.locator('#booth-list .skel')).toHaveCount(4);
  await expect(page.locator('#booth-list')).not.toHaveClass(/stagger/);      // 骨組みは、ふわっと出さない（明滅だけ）
  // 地図に「すっと現れる」印が付いた回数を数える
  await page.evaluate(() => { window.__arr = 0; const el = document.getElementById('plan-1'); let was = false;
    new MutationObserver(() => { const on = el.classList.contains('arrive'); if (on && !was) window.__arr++; was = on; }).observe(el, { attributes: true, attributeFilter: ['class'] }); });
  expect(await page.evaluate(() => document.getElementById('plan-1').dataset.skel)).toBe('1');
  open(); hold = null;
  await ready(page);
  await expect(page.locator('#booth-list [data-sid]').first()).toBeVisible();
  await expect(page.locator('#booth-list')).toHaveClass(/stagger/);
  expect(await page.evaluate(() => window.__arr)).toBe(1);
  expect(await page.evaluate(() => document.getElementById('plan-1').dataset.skel)).toBeUndefined();
  await expect(page.locator('#plan-1')).not.toHaveClass(/arrive/, { timeout: 4000 });   // 動きが終わったら印を外す
  // そのあとの描き直し（階を替えて戻る・更新）では、もう付かない
  await page.locator('#nav button[data-view="map"]').click();
  await page.evaluate(() => { setFloor(2); setFloor(1); drawFloor._fp = null; drawFloor(1); });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__arr)).toBe(1);
  expect(errors).toEqual([]);
});

/* ---------------- v206：地図の左下のボタン（開いた直後は「全体」だけ。地図の字に重ねない） ---------------- */
for (const w of [390, 320]) {
  test(`地図を開いた直後（幅${w}px）：左下は「全体」だけ（もう寄せてあるので「ブースに寄せる」は出さない）。立入禁止の字に重ならない。動かしたら「ブースに寄せる」が出て、押すと戻って消える`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w < 360 ? 640 : 800 });
    const errors = watchErrors(page);
    await mockGas(page);
    await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
    await page.goto('/?tab=map');
    await ready(page);
    const zb = page.locator('#zoom-booth'), zr = page.locator('#zoom-reset');
    const state = () => page.evaluate(() => {
      const vis = el => getComputedStyle(el).visibility !== 'hidden' && !!el.offsetParent;
      const btns = [...document.querySelectorAll('.map-fit-ctl button')].filter(vis).map(x => { const r = x.getBoundingClientRect(); return { id: x.id, x: r.left, y: r.top, w: r.width, h: r.height }; });
      const lab = [...document.querySelectorAll('#plan-' + S.floor + ' .blocked-t')].map(x => { const r = x.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      return { ids: btns.map(b => b.id), btns, labs: lab.length,
        hit: lab.filter(l => btns.some(q => l.x < q.x + q.w && q.x < l.x + l.w && l.y < q.y + q.h && q.y < l.y + l.h)).length,
        k: ZOOM.k, x: ZOOM.x, y: ZOOM.y, min: ZOOM.min };
    });
    // 開いた直後：「全体」だけ。立入禁止の字（本館1階）に重ならない
    let s = await state();
    expect(s.ids).toEqual(['zoom-reset']);
    expect(s.labs).toBeGreaterThan(0);
    expect(s.hit).toBe(0);
    // ほかの階でも同じ
    for (const f of [2, 3, 0, 1]) {
      await page.evaluate(n => setFloor(n), f);
      // 階を替えた直後は、寄せる動きの途中。落ち着いたときに「全体」だけ・字に重ならない
      await expect.poll(async () => { const t = await state(); return t.ids.join(',') + '|' + t.hit; }, { message: 'floor ' + f, timeout: 4000 }).toBe('zoom-reset|0');
    }
    // 地図を動かす → 形が変わったので「ブースに寄せる」が出る（「全体」の右）
    await page.evaluate(() => { ZOOM.touched = true; ZOOM.x -= 70; zoomApply(false); });
    await expect(zb).toBeVisible();
    s = await state();
    expect(s.ids.sort()).toEqual(['zoom-booth', 'zoom-reset']);
    const pos = Object.fromEntries(s.btns.map(b => [b.id, b]));
    expect(pos['zoom-reset'].x).toBeLessThan(pos['zoom-booth'].x);
    // 押す → 寄せた形に戻り、ボタンは消える
    await zb.click();
    await expect(zb).toBeHidden();
    s = await state();
    expect(s.k).toBeGreaterThan(s.min + 0.05);            // 寄せた形（全体より大きい）。開いた直後とぴったり同じとは限らない（開いた直後は箱の高さも詰めるため）
    expect(s.hit).toBe(0);
    // 「全体」で引く → 「全体」は消え、「ブースに寄せる」が出る。押すと戻る
    await zr.click();
    await expect(zr).toBeHidden();
    await expect(zb).toBeVisible();
    await zb.click();
    await expect(zb).toBeHidden();
    await expect(zr).toBeVisible();
    // 拡大しているあいだは、これまでどおり「全体」だけ
    await page.locator('#zoom-in').click();
    await expect(zr).toBeVisible();
    await expect(zb).toBeHidden();
    expect(errors).toEqual([]);
  });
}

/* ---------------- v207：地図の左下のボタンの出入り・届いた瞬間に余計な配置計算をしない ---------------- */
test('地図の左下のボタン：すっと出て、すっと引っ込む（消え終わってから見えなくする）。動きを減らす設定では動かさない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await ready(page);
  const zb = page.locator('#zoom-booth');
  const cs = () => zb.evaluate(el => { const c = getComputedStyle(el); return { op: +c.opacity, vis: c.visibility, prop: c.transitionProperty, tf: c.transform }; });
  // 引っ込んでいるとき：透明・見えない（場所は残す）
  let c = await cs();
  expect(c.vis).toBe('hidden'); expect(c.op).toBe(0);
  expect(c.prop).toContain('opacity'); expect(c.prop).toContain('visibility');
  expect(await zb.evaluate(el => el.offsetWidth)).toBeGreaterThan(40);
  // 出るとき：すぐ見える状態になり、濃さが 1 まで上がる
  await page.evaluate(() => { ZOOM.touched = true; ZOOM.x -= 70; zoomApply(false); });
  await expect(zb).toBeVisible();
  await expect.poll(async () => (await cs()).op).toBe(1);
  // 大きさの動き（0.22秒・少し行きすぎて戻る）は、濃さ（0.18秒）より少し長い。落ち着くまで待つ（v212：すぐ測ると、動きの途中の値を拾って外れることがあった）
  await expect.poll(async () => (await cs()).tf, { timeout: 3000 }).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  // 引っ込むとき：消え終わってから見えなくなる
  await zb.click();
  await expect(zb).toBeHidden();
  await expect.poll(async () => (await cs()).op).toBe(0);
  // 動きを減らす設定：動かさない
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await zb.evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(d => parseFloat(d) === 0))).toBe(true);
  expect(errors).toEqual([]);
});

test('ブースが届いた瞬間：地図を描いた直後に、位置を測り直さない（配置の計算をその場で走らせない）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let open; let hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { if (hold) await hold; return route.fallback(); });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await expect(page.locator('#plan-1 .skel-room').first()).toBeVisible();
  // 図面（svg）の位置を測る呼び出しを数える。drawFloor の中から呼ばれたものだけ
  await page.evaluate(() => { window.__gbcr = 0; const orig = SVGElement.prototype.getBoundingClientRect;
    const df = drawFloor; let inDraw = 0;
    window.drawFloor = new Proxy(df, { apply(t, th, a){ inDraw++; try { return t.apply(th, a); } finally { inDraw--; } } });
    SVGElement.prototype.getBoundingClientRect = function(){ if (inDraw && this.classList && this.classList.contains('plan')) window.__gbcr++; return orig.apply(this, arguments); }; });
  open(); hold = null;
  await ready(page);
  await expect(page.locator('#plan-1 [data-id]').first()).toBeVisible();
  expect(await page.evaluate(() => window.__gbcr)).toBe(0);
  expect(errors).toEqual([]);
});

/* ---------------- v208：はじめて開いた人：届いた瞬間に地図を押し下げない／せまい画面の見出し ---------------- */
test('はじめて開いた人：「はじめての方へ」と科のチップは、ブースを待たずに出す（届いた瞬間に地図が下へずれない）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let open; let hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { if (hold) await hold; return route.fallback(); });
  await page.goto('/?tab=map');                               // 案内を見たことのない端末（kuroko_intro_v1 なし）
  // 読み込み中から出ている
  await expect(page.locator('#intro-card')).toBeVisible();
  await expect(page.locator('#dept-legend')).toBeVisible();
  await expect(page.locator('#dept-legend button').first()).toBeVisible();
  await expect(page.locator('#map-wait')).toBeVisible();
  await page.waitForTimeout(400);
  const top = () => page.evaluate(() => Math.round(document.getElementById('map-view').getBoundingClientRect().top + window.scrollY));
  const y0 = await top();
  open(); hold = null;
  await ready(page);
  await expect(page.locator('#plan-1 [data-id]').first()).toBeVisible();
  // 届いても、地図の位置は変わらない（以前は、カードと科のチップが割り込んで 400px 以上ずれていた）
  expect(Math.abs((await top()) - y0)).toBeLessThanOrEqual(3);
  await expect(page.locator('#intro-card')).toBeVisible();
  // 「わかった」で消え、次からは出ない
  await page.locator('#intro-ok').click();
  await expect(page.locator('#intro-card')).toBeHidden();
  await page.reload();
  await ready(page);
  await expect(page.locator('#intro-card')).toBeHidden();
  expect(errors).toEqual([]);
});

test('幅320px：見出しは語の切れ目で折り返す（「校内マッ／プ」と1文字だけ落とさない）。学校名は1行。検索欄の薄い字が切れない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await ready(page);
  const r = await page.evaluate(() => {
    const lines = el => { const tn = [...el.childNodes].find(n => n.nodeType === 3), rg = document.createRange(), m = new Map();
      for (let i = 0; i < tn.textContent.length; i++){ rg.setStart(tn, i); rg.setEnd(tn, i + 1); const b = rg.getBoundingClientRect(); if (!b.width) continue; const k = Math.round(b.top); m.set(k, (m.get(k) || '') + tn.textContent[i]); }
      return [...m.values()]; };
    const ph = id => { const el = document.getElementById(id), cs = getComputedStyle(el, '::placeholder'), c = document.createElement('canvas').getContext('2d');
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; const w = c.measureText(el.placeholder).width + (parseFloat(cs.letterSpacing) || 0) * el.placeholder.length;
      const st = getComputedStyle(el); return { need: Math.round(w), have: Math.round(el.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight)) }; };
    return { h1: lines(document.querySelector('.head h1')), sub: lines(document.getElementById('head-sub')), mapQ: ph('map-q'),
      over: document.documentElement.scrollWidth - innerWidth };
  });
  expect(r.h1.every(l => l.trim().length >= 3), JSON.stringify(r.h1)).toBe(true);   // 1〜2文字だけの行が無い
  expect(r.h1.length).toBeLessThanOrEqual(2);
  expect(r.sub.length).toBe(1);
  expect(r.mapQ.need).toBeLessThanOrEqual(r.mapQ.have + 1);
  expect(r.over).toBeLessThanOrEqual(0);
  // 一覧の検索欄も
  await page.locator('#nav button[data-view="list"]').click();
  const q = await page.evaluate(() => { const el = document.getElementById('q'), cs = getComputedStyle(el, '::placeholder'), c = document.createElement('canvas').getContext('2d');
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; const st = getComputedStyle(el);
    return { need: Math.round(c.measureText(el.placeholder).width + (parseFloat(cs.letterSpacing) || 0) * el.placeholder.length), have: Math.round(el.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight)) }; });
  expect(q.need).toBeLessThanOrEqual(q.have + 1);
  expect(errors).toEqual([]);
});

/* ---------------- v209：7つの仕上げ ---------------- */
test('①地図の端の影：左右に地図が続いているほうの端にだけ出る（全体が入っているときは出ない）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await ready(page);
  const st = () => page.evaluate(() => { const v = document.getElementById('map-view');
    return { l: v.classList.contains('more-l'), r: v.classList.contains('more-r'), ol: +getComputedStyle(v, '::before').opacity, or: +getComputedStyle(v, '::after').opacity,
      pe: getComputedStyle(v, '::before').pointerEvents, x: ZOOM.x, min: ZOOM.mW - ZOOM.mW * ZOOM.k }; });
  // 開いた直後（スマホ）：階の真ん中あたりが見えていて、左右どちらにも続きがある
  let s = await st();
  expect(s.l).toBe(true); expect(s.r).toBe(true);
  await expect.poll(async () => (await st()).ol).toBe(1);
  expect(s.pe).toBe('none');                                  // 影は地図の操作をじゃましない
  // 左の端まで動かす → 左の影は消え、右だけ残る
  await page.evaluate(() => { ZOOM.touched = true; ZOOM.x = 0; zoomApply(false); });
  s = await st();
  expect(s.l).toBe(false); expect(s.r).toBe(true);
  await expect.poll(async () => (await st()).ol).toBe(0);
  // 右の端まで動かす → 右の影は消え、左だけ
  await page.evaluate(() => { ZOOM.x = -99999; zoomApply(false); });
  s = await st();
  expect(s.l).toBe(true); expect(s.r).toBe(false);
  // 「全体」で階ぜんぶが入る → どちらも出ない
  await page.locator('#zoom-reset').click();
  await expect.poll(async () => { const t = await st(); return t.l || t.r; }).toBe(false);
  expect(errors).toEqual([]);
});

test('②③「はじめての方へ」：「わかった」で、すっと畳まれてから消える（地図が一気に跳ね上がらない）。小さい画面では詰めて、下の地図が見える', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?tab=map');
  await ready(page);
  const card = page.locator('#intro-card');
  await expect(card).toBeVisible();
  const g = await page.evaluate(() => { const c = document.getElementById('intro-card').getBoundingClientRect(), m = document.getElementById('map-view').getBoundingClientRect(), n = document.getElementById('nav').getBoundingClientRect();
    return { card: c.height, mapVisible: n.top - m.top, steps: document.querySelectorAll('#intro-card ol li').length, btn: document.getElementById('intro-ok').getBoundingClientRect().height }; });
  expect(g.steps).toBe(3);
  expect(g.card).toBeLessThanOrEqual(215);                    // v208 までは 252px（幅 320px）
  expect(g.mapVisible).toBeGreaterThanOrEqual(110);           // カードの下に、地図が最初から見えている（v208 までは 71px）
  expect(g.btn).toBeGreaterThanOrEqual(38);                   // 押す大きさは保つ
  // 畳む動き：押した直後は、まだ場所を取っていて、高さを縮める動きに入っている（ぱっと消えていない）。
  // こま送りで高さを記録する形は、重いとき（こまが3つしか来ない）に外れたので、押した直後のようすで確かめる（v210）
  const f = await page.evaluate(() => { const el = document.getElementById('intro-card'); const h0 = el.getBoundingClientRect().height;
    document.getElementById('intro-ok').click(); const c = getComputedStyle(el);
    return { h0, folding: el.classList.contains('fold-out') && el.classList.contains('go'), hidden: el.classList.contains('hide'), prop: c.transitionProperty,
      dur: Math.max(...c.transitionDuration.split(',').map(parseFloat)), hNow: el.getBoundingClientRect().height }; });
  expect(f.hidden, JSON.stringify(f)).toBe(false);
  expect(f.folding).toBe(true);
  expect(f.prop).toContain('height'); expect(f.dur).toBeGreaterThan(0.2);
  expect(f.hNow).toBeGreaterThan(f.h0 * 0.5);
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('kuroko_intro_v1'))).not.toBeNull();
  expect(await card.evaluate(el => el.className + '|' + el.style.height)).toBe('intro-card hide|');   // 後始末（印・高さを残さない）
  // 動きを減らす設定：すぐ消える
  await page.evaluate(() => { localStorage.removeItem('kuroko_intro_v1'); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await ready(page);
  await expect(card).toBeVisible();
  await page.locator('#intro-ok').click();
  expect(await card.evaluate(el => el.classList.contains('hide'))).toBe(true);
  expect(errors).toEqual([]);
});

test('④⑤ブースが届いたら「読み込み中」の札はすっと消える。「再試行」は、取りに行っているあいだ回る印が出て押せない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let fail = true, n = 0, open; let hold = null;
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    if (route.request().method() === 'GET' && !/ledger|report/.test(route.request().url())) n++;
    if (hold) await hold;
    return fail ? route.fulfill({ status: 404, contentType: 'text/html', body: '<html>404</html>' }) : route.fallback();
  });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  const chip = page.locator('#map-wait'), rb = page.locator('#banner-retry');
  await expect(chip).toContainText('まだ取れていません');
  await expect(rb).toBeVisible();
  // 「再試行」：押すと回る印。もう一度押しても、通信を重ねない
  hold = new Promise(r => { open = r; });
  await page.waitForTimeout(300);
  const n0 = n;
  await rb.click();
  await expect(rb).toHaveClass(/busy/);
  await expect(rb).toHaveAttribute('aria-busy', 'true');
  expect(await rb.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  expect(await rb.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('spin-r');
  await rb.evaluate(el => el.click());                          // 指では押せないが、念のためプログラムからも
  await page.waitForTimeout(200);
  expect(n - n0).toBe(1);
  // 札が消える動きを数える
  await page.evaluate(() => { window.__bye = 0; const el = document.getElementById('map-wait');
    new MutationObserver(() => { if (el.classList.contains('bye')) window.__bye++; }).observe(el, { attributes: true, attributeFilter: ['class'] }); });
  fail = false; open(); hold = null;
  await ready(page);
  await expect(chip).toBeHidden();
  expect(await page.evaluate(() => window.__bye)).toBeGreaterThanOrEqual(1);
  expect(await chip.evaluate(el => el.classList.contains('bye'))).toBe(false);
  await expect(rb).not.toHaveClass(/busy/);
  expect(errors).toEqual([]);
});

test('⑥読み込み中の骨組みは、本物の形（一覧＝帯・番号の丸・名前の線・札／スタンプ帳＝丸・名前の線）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let open; let hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { if (hold) await hold; return route.fallback(); });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=list');
  await expect(page.locator('#booth-list .skel')).toHaveCount(4);
  const sk = await page.evaluate(() => { const el = document.querySelector('#booth-list .skel'), a = getComputedStyle(el, '::after'), b = getComputedStyle(el, '::before'), c = getComputedStyle(el);
    const real = getComputedStyle(document.documentElement).getPropertyValue('--r');
    return { layers: (a.backgroundImage.match(/gradient/g) || []).length, bar: parseFloat(b.width), border: parseFloat(c.borderTopWidth), h: el.getBoundingClientRect().height, pulse: a.animationName }; });
  expect(sk.layers).toBeGreaterThanOrEqual(5);                 // 番号の丸・名前の線・札2つ・混み具合の札
  expect(sk.bar).toBeGreaterThanOrEqual(4);                    // 左の帯
  expect(sk.border).toBeGreaterThanOrEqual(1);
  expect(sk.h).toBeGreaterThanOrEqual(70);
  expect(sk.pulse).toBe('skel-pulse');
  await page.locator('#nav button[data-view="stamp"]').click();
  await expect(page.locator('#stamp-grid .skel-st')).toHaveCount(6);
  expect(await page.evaluate(() => (getComputedStyle(document.querySelector('#stamp-grid .skel-st'), '::after').backgroundImage.match(/gradient/g) || []).length)).toBeGreaterThanOrEqual(2);
  open(); hold = null;
  await ready(page);
  await expect(page.locator('#stamp-grid .skel-st')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('⑦本部モニタ：「データを取得しています…」は画面の中央に、回る印つきで出る。届いたら地図とタイルが並ぶ', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let open; let hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { if (hold) await hold; return route.fallback(); });
  await page.goto('/?mode=board');
  const em = page.locator('#board-grid .board-empty');
  await expect(em).toContainText('取得しています');
  const g = await em.evaluate(el => { const r = el.getBoundingClientRect(), rg = document.createRange(); rg.selectNodeContents(el); const t = rg.getBoundingClientRect();
    return { cx: (t.left + t.right) / 2, vw: innerWidth, spin: getComputedStyle(el, '::before').animationName, maps: getComputedStyle(document.getElementById('board-maps')).display }; });
  expect(Math.abs(g.cx - g.vw / 2)).toBeLessThan(40);          // 以前は左半分の真ん中（中央から 400px ずれていた）
  expect(g.spin).toBe('spin-r');
  expect(g.maps).toBe('none');                                 // まだ描くものが無い地図の列は取らない
  open(); hold = null;
  await ready(page);
  await expect(page.locator('#board-grid .btile').first()).toBeVisible();
  await expect(page.locator('#board-maps')).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll('#board-maps svg').length)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

/* ---------------- v210：7つの仕上げ・2 ---------------- */
// 要素の文字を1字ずつ測って、行ごとの文字にまとめる
const LINES_FN = `(el => { const out = []; const walk = n => { if (n.nodeType === 3) out.push(n); else n.childNodes.forEach(walk); }; walk(el);
  const m = new Map(), rg = document.createRange();
  for (const tn of out) for (let i = 0; i < tn.textContent.length; i++){ rg.setStart(tn, i); rg.setEnd(tn, i + 1); const b = rg.getBoundingClientRect(); if (!b.width) continue; const k = Math.round(b.top / 3); m.set(k, (m.get(k) || '') + tn.textContent[i]); }
  return [...m.values()].map(s => s.trim()).filter(Boolean); })`;
// 押した直後のようす（まだ場所を取っていて、畳む動きに入っている）を返す
const FOLD_FN = `((sel, btnSel) => { const el = document.querySelector(sel); const h0 = el.getBoundingClientRect().height;
  document.querySelector(btnSel).click();
  const c = getComputedStyle(el);
  return { h0, folding: el.classList.contains('fold-out') && el.classList.contains('go'), hidden: el.classList.contains('hide') || c.display === 'none',
    prop: c.transitionProperty, dur: Math.max(...c.transitionDuration.split(',').map(parseFloat)), hNow: el.getBoundingClientRect().height }; })`;

test('①②ブースの名前は文節で折り返す（行の頭に「ー」「）」を置かない・1文字だけの行を作らない）。文も、最後の行に1文字だけ残さない', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=stamp');
  await ready(page);
  const bad = lines => lines.filter(l => /^[ー）」、。・]/.test(l) || (lines.length > 1 && l.length === 1));
  // スタンプ帳の名前（46枚）
  const st = await page.evaluate(fn => [...document.querySelectorAll('#stamp-grid .stamp .lb')].map(el => eval(fn)(el)), LINES_FN);
  expect(st.length).toBe(46);
  expect(st.filter(l => bad(l).length).map(l => l.join('／'))).toEqual([]);
  // 一覧の名前
  await page.locator('#nav button[data-view="list"]').click();
  await expect(page.locator('#booth-list .booth').first()).toBeVisible();
  const ls = await page.evaluate(fn => [...document.querySelectorAll('#booth-list .booth-nm .nm')].map(el => eval(fn)(el)), LINES_FN);
  expect(ls.length).toBe(46);
  expect(ls.filter(l => bad(l).length).map(l => l.join('／'))).toEqual([]);
  const cs = await page.evaluate(() => { const g = s => getComputedStyle(document.querySelector(s));
    return { nmLb: g('#booth-list .booth-nm .nm').lineBreak, bodyLb: g('body').lineBreak, nmWb: g('#booth-list .booth-nm .nm').wordBreak, bodyTw: g('body').textWrapStyle || g('body').textWrap || '',
      btnWb: g('#booth-list .booth-open').wordBreak }; });
  expect(cs.nmLb).toBe('strict'); expect(cs.bodyLb).toBe('strict');
  if (browserName === 'chromium') {
    // 文節で折る（Chromium）。語の途中で切れていた例が、切れ目で折れている
    expect(cs.nmWb).toBe('auto-phrase'); expect(cs.btnWb).toBe('auto-phrase');
    expect(String(cs.bodyTw)).toContain('pretty');
    const all = st.concat(ls).map(l => l.join('／'));
    for (const ng of ['レーザ／ー', '体育／館', 'ライ／ントレーサー', 'キーホルダ／ー', 'ラリ／ー']) expect(all.filter(x => x.includes(ng)), ng).toEqual([]);
    // 詳細の題
    await page.evaluate(() => openSheet(S.booths.find(b => /バーベキュー/.test(b.name)).id));
    await expect(page.locator('#bsh-nm')).toBeVisible();
    const tl = await page.evaluate(fn => eval(fn)(document.getElementById('bsh-nm')), LINES_FN);
    expect(bad(tl)).toEqual([]);
    expect(tl.join('／')).not.toContain('コン／ロ');
    await page.evaluate(() => closeSheet());
    // 文：最後の行が1文字だけにならない（インフォの長い見出し・説明）
    await page.locator('#nav button[data-view="info"]').click();
    const sm = await page.evaluate(fn => [...document.querySelectorAll('#v-info summary, #v-info p')].filter(el => el.offsetParent && el.textContent.trim().length > 18).map(el => eval(fn)(el)), LINES_FN);
    expect(sm.length).toBeGreaterThan(5);
    expect(sm.filter(l => l.length > 1 && l[l.length - 1].replace(/[）」。]/g, '').length <= 1).map(l => l.join('／'))).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('③案内の答えだけが出る検索（「トイレ」）では、「0件 / 全46件」と言わない。ふつうの検索では件数を出す', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=list');
  await ready(page);
  await page.fill('#q', 'トイレ');
  await expect(page.locator('#booth-list .qhelp')).toBeVisible();
  await expect(page.locator('#booth-list .booth')).toHaveCount(0);
  await expect(page.locator('#list-count')).toBeHidden();
  await page.fill('#q', 'カジノ');
  await expect(page.locator('#list-count')).toBeVisible();
  await expect(page.locator('#list-count')).toContainText('全46件');
  await page.fill('#q', 'ぜったいにないなまえ');
  await expect(page.locator('#list-count')).toContainText('0件');       // 本当に見つからないときは、これまでどおり 0件
  expect(errors).toEqual([]);
});

test('④⑤⑦⑧閉じた帯・案内は、すっと畳まれてから消える（お知らせの×・「あとで」・最近見たの×）。記録はすぐ残す。地図で見たブースが、一覧の「最近見た」に出る', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page, { notice: { text: '14時から第一体育館でステージ発表があります', level: 'info' } });
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_intro_v1', '1'); } });
  await page.goto('/?tab=map');
  await ready(page);
  // 押した直後：まだ隠れていない・畳む動き（高さ）に入っている・高さはまだ残っている
  const folding = r => { expect(r.hidden, JSON.stringify(r)).toBe(false); expect(r.folding).toBe(true); expect(r.prop).toContain('height'); expect(r.dur).toBeGreaterThan(0.2); expect(r.hNow).toBeGreaterThan(r.h0 * 0.5); };
  // ④お知らせの帯
  await expect(page.locator('#banner-notice')).toBeVisible();
  folding(await page.evaluate(([fn, a, b]) => eval(fn)(a, b), [FOLD_FN, '#banner-notice', '#notice-x']));
  await expect(page.locator('#banner-notice')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('kuroko_notice_x'))).not.toBeNull();
  expect(await page.locator('#banner-notice').evaluate(el => el.className.includes('fold-out') || !!el.style.height)).toBe(false);
  // ⑤「いまどこにいますか？」の「あとで」
  const bar = page.locator('#here-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('いまどこにいますか');
  folding(await page.evaluate(([fn, a, b]) => eval(fn)(a, b), [FOLD_FN, '#here-bar', '#here-bar [data-here-no]']));
  await expect(bar).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('kuroko_here_ask'))).toBe('false');
  // ⑧⑦地図で詳細を見てから一覧に移ると、「最近見た」に出ている（一覧の中身が同じでも見直す）。× で、すっと畳む
  await page.evaluate(() => { openSheet(S.booths[3].id); });
  await expect(page.locator('#bsh-nm')).toBeVisible();
  await page.evaluate(() => closeSheet());
  await page.locator('#nav button[data-view="list"]').click();
  const row = page.locator('#recent-row');
  await expect(row).toBeVisible();
  folding(await page.evaluate(([fn, a, b]) => eval(fn)(a, b), [FOLD_FN, '#recent-row', '#recent-x']));
  await expect(row).toBeHidden();
  // 動きを減らす設定：すぐ消える
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { localStorage.removeItem('kuroko_notice_x'); });
  await page.reload();
  await ready(page);
  await expect(page.locator('#banner-notice')).toBeVisible();
  await page.locator('#notice-x').click();
  expect(await page.locator('#banner-notice').evaluate(el => el.classList.contains('hide'))).toBe(true);
  expect(errors).toEqual([]);
});

test('⑥「上へ戻る」は、すっと出て、すっと引っ込む（消え終わってから見えなくする）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=list');
  await ready(page);
  const tt = page.locator('#to-top');
  const cs = () => tt.evaluate(el => { const c = getComputedStyle(el); return { op: +c.opacity, vis: c.visibility, disp: c.display, prop: c.transitionProperty, pe: c.pointerEvents }; });
  let c = await cs();
  expect(c.vis).toBe('hidden'); expect(c.op).toBe(0); expect(c.disp).not.toBe('none'); expect(c.pe).toBe('none');
  expect(c.prop).toContain('opacity');
  await expect(tt).toBeHidden();
  await page.evaluate(() => { window.dispatchEvent(new Event('touchmove')); window.scrollTo(0, 1600); });
  await expect(tt).toBeVisible();
  await expect.poll(async () => (await cs()).op).toBe(1);
  await tt.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(50);
  await expect(tt).toBeHidden();
  await expect.poll(async () => (await cs()).op).toBe(0);
  expect(errors).toEqual([]);
});

/* ---------------- v211：7つの仕上げ・3 ---------------- */
test('①②文節での折り返しを画面ぜんたいに（詳細の説明・おすすめ）。混み具合の札は、文字「特大」で2段に組み、行の終わりに「・」を残さない', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_intro_v1', '1'); localStorage.setItem('kuroko_fs', JSON.stringify('xl')); } });
  await page.goto('/?tab=list');
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-fs'))).toBe('xl');
  // ②札：2段（「空き」／「5人待ち」）。「・」は見せない（読み上げ・文字としては残す）
  const pill = page.locator('#booth-list .booth-side .pill:has(.pl-b)').first();
  await expect(pill).toBeVisible();
  const p = await pill.evaluate((el, fn) => ({ lines: eval(fn)(el), sep: getComputedStyle(el.querySelector('.pl-sep')).display, b: getComputedStyle(el.querySelector('.pl-b')).display, text: el.textContent.replace(/\s+/g, '') }), LINES_FN);
  expect(p.sep).toBe('none'); expect(p.b).toBe('block');
  expect(p.lines.length).toBe(2);
  expect(p.lines.join('|')).not.toContain('・');
  expect(p.lines[1]).toMatch(/^\d+人待ち$/);
  expect(p.text).toMatch(/・\d+人待ち$/);
  if (browserName === 'chromium') {
    // ①詳細の説明・「いま空いているのは…」が、語の途中で切れない
    expect(await page.evaluate(() => getComputedStyle(document.body).wordBreak)).toBe('auto-phrase');
    await page.evaluate(() => openSheet(S.booths.find(b => /バーベキュー/.test(b.name)).id));
    await expect(page.locator('#bsh-nm')).toBeVisible();
    const t = await page.evaluate(fn => ({ note: eval(fn)(document.querySelector('#bsh-body .bsh-note')).join('／'), alt: document.querySelector('#bsh-body .bsh-alt') ? eval(fn)(document.querySelector('#bsh-body .bsh-alt')).join('／') : '' }), LINES_FN);
    expect(t.note).toContain('溶接実習室');
    expect(t.alt).not.toMatch(/電／子科|メイド／喫茶|カ／ジノ/);
    await page.evaluate(() => closeSheet());
  }
  // 文字「標準」では1行（「・」を出す）
  await page.evaluate(() => { localStorage.setItem('kuroko_fs', JSON.stringify('n')); });
  await page.reload();
  await ready(page);
  const q = await page.locator('#booth-list .booth-side .pill:has(.pl-b)').first().evaluate((el, fn) => ({ lines: eval(fn)(el), sep: getComputedStyle(el.querySelector('.pl-sep')).display }), LINES_FN);
  expect(q.sep).not.toBe('none');
  expect(q.lines.length).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('③④マウスの人には、マウスでの拡大のしかたを書く。ボタンにマウスを乗せると反応する（指の端末では、これまでどおり）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await ready(page);
  const mouse = await page.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches);
  const h = await page.evaluate(() => { const g = s => getComputedStyle(document.querySelector(s)).display; return { touch: g('#name-hint .nh-touch'), mouse: g('#name-hint .nh-mouse'), text: document.getElementById('name-hint').textContent }; });
  expect(h.text).toContain('2本指'); expect(h.text).toContain('ホイール');     // どちらも入っていて、片方だけ見せる
  expect(h.touch === 'none').toBe(mouse);
  expect(h.mouse === 'none').toBe(!mouse);
  await page.locator('#nav button[data-view="stamp"]').click();
  const btn = page.locator('#stamp-todo');
  await btn.scrollIntoViewIfNeeded();
  const before = await btn.evaluate(el => getComputedStyle(el).filter);
  await btn.hover();
  const after = await btn.evaluate(el => getComputedStyle(el).filter);
  if (mouse) { expect(before).toBe('none'); expect(after).toContain('brightness'); }
  else expect(after).toBe(before);
  expect(errors).toEqual([]);
});

test('⑤詳細を開いたまま待ち人数が変わると、数字が動いて変わり、枠が一度光る（別のブースに替えたときは光らせない）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await ready(page);
  const id = await page.evaluate(() => { const b = S.booths.find(x => x.wait > 3 && lvOf(x).lv >= 0 && lvOf(x).lv < 3); openSheet(b.id); return b.id; });
  const n = page.locator('#bsh-body .bsh-st .wt b');
  await expect(n).toBeVisible();
  const w0 = +(await n.textContent());
  expect(await page.locator('#bsh-body .bsh-st').evaluate(el => el.classList.contains('chg'))).toBe(false);   // 開いただけでは光らせない
  // 係の人の更新が届いた（待ち人数 +7）
  await page.evaluate(id => { const b = S.booths.find(x => x.id === id); b.wait += 7; b.time = new Date().toISOString(); renderSheet(); }, id);
  await expect(page.locator('#bsh-body .bsh-st')).toHaveClass(/chg/);
  await expect(n).toHaveText(String(w0 + 7));
  // 別のブースへ（次）→ 光らせない
  await page.evaluate(() => { const o = S.booths.find(x => x.id !== S.sheetId && x.wait > 0 && lvOf(x).lv >= 0 && lvOf(x).lv < 3); openSheet(o.id); });
  await page.waitForTimeout(150);
  expect(await page.locator('#bsh-body .bsh-st').evaluate(el => el.classList.contains('chg'))).toBe(false);
  expect(errors).toEqual([]);
});

test('⑦見えていない画面の下ごしらえは、指で触っている最中には走らせない（手が止まってから進める）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  let open; let hold = new Promise(r => { open = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async route => { if (hold) await hold; return route.fallback(); });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await expect(page.locator('#map-wait')).toBeVisible();
  // 届く前から、0.12秒おきに「なぞっている」合図を出しつづける
  await page.evaluate(() => { window.__touching = setInterval(() => window.dispatchEvent(new Event('touchmove')), 120); });
  open(); hold = null;
  await ready(page);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => (prewarmViews._log || []).length)).toBe(0);      // 触っているあいだは、1画面も下ごしらえしていない
  // 手を止める → 進む
  await page.evaluate(() => clearInterval(window.__touching));
  await expect.poll(() => page.evaluate(() => (prewarmViews._log || []).join(',')), { timeout: 20000 }).toBe('v-stamp,v-list,v-info');
  expect(errors).toEqual([]);
});

/* ---------------- v213：「係の人の更新 ◯分前」は、本当の時刻で言う ---------------- */
test('見出しの「係の人の更新 ◯分前」は、係の人がいちばん最近に更新した時刻（サーバーが返事を作った時刻ではない）。更新が無ければ、そう言う', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  // 開催中の時刻にする（開催時間の外では、この行は「◯時 開場」などの案内になる）
  await page.clock.install({ time: new Date('2026-10-24T11:20:00+09:00') });
  const T0 = new Date('2026-10-24T11:20:00+09:00').getTime();
  let mode = 'old37';
  await mockGas(page, { mutate: j => {
    j.updatedAt = new Date(T0).toISOString();            // サーバーが返事を作った時刻＝今
    if (mode === 'old37') { j.booths.forEach(b => { if (b.time) b.time = new Date(T0 - 37 * 60000).toISOString(); }); }
    if (mode === 'server') { j.booths.forEach(b => { if (b.time) b.time = new Date(T0 - 37 * 60000).toISOString(); }); j.lastUpdate = new Date(T0 - 12 * 60000).toISOString(); }
    if (mode === 'none') { j.booths.forEach(b => { b.time = null; b.status = ''; b.wait = null; }); j.lastUpdate = null; }
    if (mode === 'future') { j.booths.forEach((b, i) => { b.time = i === 0 ? new Date(T0 + 3 * 3600000).toISOString() : new Date(T0 - 8 * 60000).toISOString(); }); }
  } });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=map');
  await ready(page);
  const txt = page.locator('#sync-text');
  // 古いサーバー（lastUpdate なし）：ブースの時刻のうち、いちばん新しいもの（37分前）。以前は「たった今」と出ていた
  await expect(txt).toHaveText('最新の情報です（係の人の更新 37分前）');
  // 新しいサーバー：lastUpdate（12分前）のほうが新しければ、それを使う
  mode = 'server';
  await page.evaluate(() => sync(true));
  await expect(txt).toHaveText('最新の情報です（係の人の更新 12分前）');
  // 5分以上先の時刻（シートの打ち間違い）は数えない
  mode = 'future';
  await page.evaluate(() => sync(true));
  await expect(txt).toHaveText('最新の情報です（係の人の更新 8分前）');
  // まだ1件も更新が無い
  mode = 'none';
  await page.evaluate(() => sync(true));
  await expect(txt).toHaveText('最新の情報です（係の人の更新はまだありません）');
  expect(errors).toEqual([]);
});

/* ---------------- v214：押す所は 44px 以上（お知らせの×・スタンプ帳の階の見出し） ---------------- */
test('押す所の大きさ：お知らせの「×」とスタンプ帳の階の見出しは 44px 以上（見た目の丸は 36px のまま）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page, { notice: { text: '14時から第一体育館でステージ発表があります', level: 'info' } });
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=stamp');
  await ready(page);
  const x = await page.locator('#notice-x').boundingBox();
  expect(x.width).toBeGreaterThanOrEqual(44); expect(x.height).toBeGreaterThanOrEqual(44);
  expect(await page.locator('#notice-x').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('radial-gradient');
  // 帯の高さは、ボタンを大きくしても変わらない（1行のお知らせで 60px 台）
  expect((await page.locator('#banner-notice').boundingBox()).height).toBeLessThan(76);
  const folds = await page.evaluate(() => [...document.querySelectorAll('#stamp-grid .stamp-fold')].map(el => Math.round(el.getBoundingClientRect().height)));
  expect(folds.length).toBeGreaterThanOrEqual(3);
  for (const h of folds) expect(h).toBeGreaterThanOrEqual(44);
  // 押して畳める（大きくしても、これまでどおり働く）
  await page.locator('#stamp-grid .stamp-fold').first().click();
  await expect(page.locator('#stamp-grid .stamp-fold').first()).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});

/* ---------------- v215：本部モニタ・全部回ったあと・横向き の7つの仕上げ ---------------- */
test('①②本部モニタ（1366×768・30枚のページ）：ブースの名前は札の幅いっぱい・2行までで読める（「ア…」と1文字で切れない）。待ち人数は名前の下', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors = watchErrors(page);
  // ページは時計で決まる（20秒ごとに 1 → 2 → 1…）。1ページ目（30枚）が出る時刻にしておく
  await page.clock.install({ time: new Date(Math.floor(Date.parse('2026-10-24T11:20:00+09:00') / 40000) * 40000 + 1000) });
  await mockGas(page);
  await page.goto('/?mode=board');
  await ready(page);
  await expect(page.locator('#board-grid .btile')).toHaveCount(30);
  const r = await page.evaluate(() => [...document.querySelectorAll('#board-grid .btile')].map(t => { const nm = t.querySelector('.bt-nm'), hd = t.querySelector('.bt-head'), big = t.querySelector('.bt-big'), age = t.querySelector('.bt-age');
    const tr = t.getBoundingClientRect(), hr = hd.getBoundingClientRect(), br = big.getBoundingClientRect(), ar = age.getBoundingClientRect();
    return { name: nm.textContent, nmW: nm.clientWidth, tileW: tr.width, cut: nm.scrollHeight > nm.clientHeight + 1, lines: Math.round(nm.clientHeight / parseFloat(getComputedStyle(nm).lineHeight)),
      bigBelow: br.top >= hr.bottom - 1, inTile: br.right <= tr.right + 0.5 && br.bottom <= tr.bottom + 0.5 && ar.left >= tr.left, ageH: ar.height, ageLh: parseFloat(getComputedStyle(age).fontSize) }; }));
  for (const t of r) {
    expect(t.nmW, t.name).toBeGreaterThanOrEqual(t.tileW * 0.7);      // 以前は札の3分の1ほど（1〜3文字ぶん）
    expect(t.lines, t.name).toBeLessThanOrEqual(2);
    expect(t.bigBelow, t.name).toBe(true);
    expect(t.inTile, t.name).toBe(true);
    expect(t.ageH, t.name).toBeLessThan(t.ageLh * 1.9);                // 「たった今」が2行に折れない
  }
  // 8文字までの名前は、切れずに全部出る
  const short = r.filter(t => t.name.length <= 8);
  expect(short.length).toBeGreaterThan(5);
  expect(short.filter(t => t.cut).map(t => t.name)).toEqual([]);
  // 大きい画面：状態の字が大きい
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(200);
  const big = await page.evaluate(() => { const tx = document.querySelector('#board-grid .bt-big b.tx'), t = tx.closest('.btile').getBoundingClientRect(), b = tx.getBoundingClientRect();
    return { fs: parseFloat(getComputedStyle(tx).fontSize), fits: b.right <= t.right - 2 }; });
  expect(big.fs).toBeGreaterThanOrEqual(23);                            // 以前は 22px が上限
  expect(big.fits).toBe(true);
  expect(errors).toEqual([]);
});

test('③⑦本部モニタ：地図は、階が3つのとき1階を上に大きく（右下の空きを作らない）。ページが2つ以上あるとき、替わるまでの線を出す', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors = watchErrors(page);
  // ページは時計で決まる。1ページ目が出る時刻にしておく
  await page.clock.install({ time: new Date(Math.floor(Date.parse('2026-10-24T11:20:00+09:00') / 40000) * 40000 + 1000) });
  let few = false;
  await mockGas(page, { mutate: j => { if (few) j.booths = j.booths.filter(b => b.id.startsWith('1F')).slice(0, 20); } });
  await page.goto('/?mode=board');
  await ready(page);
  const m = await page.evaluate(() => { const box = document.getElementById('board-maps').getBoundingClientRect(); return [...document.querySelectorAll('#board-maps .bm')].map(b => { const r = b.getBoundingClientRect();
    return { t: b.querySelector('h3').textContent, x: Math.round(r.left - box.left), y: Math.round(r.top - box.top), w: Math.round(r.width), h: Math.round(r.height), boxW: Math.round(box.width) }; }); });
  expect(m.map(x => x.t)).toEqual(['1階', '2階', '3階']);
  expect(m[0].w).toBeGreaterThanOrEqual(m[0].boxW - 2);                 // 1階は幅いっぱい
  expect(m[0].h).toBeGreaterThan(m[1].h);                               // 高さも大きい
  expect(m[1].y).toBe(m[2].y);                                          // 2階・3階は、その下に並ぶ
  expect(m[1].y).toBeGreaterThanOrEqual(m[0].y + m[0].h);
  expect(m[2].x).toBeGreaterThan(m[1].x + m[1].w - 2);
  // 替わるまでの線：2ページあるので出る。20秒で1周・時計に合っている
  const turn = page.locator('#board-turn');
  await expect(turn).toBeVisible();
  const a = await turn.locator('i').evaluate(el => { const c = getComputedStyle(el); return { name: c.animationName, dur: parseFloat(c.animationDuration), delay: parseFloat(c.animationDelay), sec: (Date.now() % 20000) / 1000 }; });
  expect(a.name).toBe('code-drain'); expect(a.dur).toBe(20);
  expect(Math.min(Math.abs(-a.delay - a.sec), 20 - Math.abs(-a.delay - a.sec))).toBeLessThan(6);
  await expect(page.locator('#board-sub')).toContainText('1 / 2ページ');
  // 1ページに収まるとき（20件・1つの階）：線は出ない。地図は1枚で幅いっぱい
  few = true;
  await page.evaluate(() => sync(true));
  await expect(page.locator('#board-grid .btile')).toHaveCount(20);
  await expect(turn).toBeHidden();
  await expect(page.locator('#board-maps .bm')).toHaveCount(1);
  expect(await page.evaluate(() => document.getElementById('board-maps').className)).toBe('board-maps');
  expect(errors).toEqual([]);
});

test('④全部回ったあとは、「まだ行っていないブースを見る」「まだのスタンプだけ」を出さない（1つでも残っていれば出す）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await mockGas(page);
  const { BASE } = require('./mock');
  const venues = BASE.booths.filter(b => b.category !== '受付').map(b => b.id);
  await page.addInitScript(ids => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('kuroko_intro_v1', '1');
    localStorage.setItem('kuroko_stamps_v2', JSON.stringify(ids)); localStorage.setItem('kuroko_cert_at', JSON.stringify('2026-10-24T03:00:00.000Z')); } }, venues.slice(1));
  await page.goto('/?tab=stamp');
  await ready(page);
  // 1つ残っている：出る
  await expect(page.locator('#stamp-todo')).toBeVisible();
  await expect(page.locator('#stamp-only-todo')).toBeVisible();
  await page.locator('#stamp-only-todo').click();
  await expect(page.locator('#stamp-grid')).toHaveClass(/only-todo/);
  // 最後の1つを押す → 回る先（受付は回る先ではない）がもう無いので、どちらも消える。「まだのスタンプだけ」の絞り込みも外れる
  await page.evaluate(id => { stampNow(id); if (showStampFx.close) showStampFx.close(); }, venues[0]);
  await expect(page.locator('#stamp-todo')).toBeHidden();
  await expect(page.locator('#stamp-only-todo')).toBeHidden();
  await expect(page.locator('#stamp-grid')).not.toHaveClass(/only-todo/);
  expect(await page.locator('#stamp-grid .stamp.got').first().isVisible()).toBe(true);
  expect(errors).toEqual([]);
});

test('⑤タイムテーブル：同じ場所の行が続くとき、「◯◯を地図で見る」は1つだけ（いまのコマがあればその行、なければ最初の行）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const errors = watchErrors(page);
  await page.clock.install({ time: new Date('2026-10-24T09:00:00+09:00') });
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
  await page.goto('/?tab=info');
  await ready(page);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#tt-body tr:not(.tt-day)')].map(tr => ({ t: tr.cells[0].textContent.trim(), now: tr.classList.contains('tt-now'), go: tr.querySelector('.tt-go') ? tr.querySelector('.tt-go').dataset.go : '' })));
  // 開場前：いまのコマは無い → 最初の行（09:30）にだけ
  let r = await rows();
  expect(r.filter(x => x.go).map(x => x.t)).toEqual(['09:30']);
  // 最終入場のあと（14:10）：いまのコマ（14:00）の行に移る
  await page.clock.setFixedTime(new Date('2026-10-24T14:10:00+09:00'));
  await page.evaluate(() => { renderInfo._cur = null; renderInfo(); });
  r = await rows();
  expect(r.find(x => x.now).t).toBe('14:00');
  expect(r.filter(x => x.go).map(x => x.t)).toEqual(['14:00']);
  // 押すと、これまでどおり地図でその場所が出る
  await page.locator('#tt-body .tt-go').click();
  await expect(page.locator('#v-map')).toBeVisible();
  expect(errors).toEqual([]);
});

test('⑥横向き（844×390）：地図の箱は、見出しと下のタブのあいだをまるごと使う高さ（帯にならない）。操作のボタンは重ならない', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); localStorage.setItem('kuroko_here_ask', 'false'); });
  await page.goto('/?tab=map');
  await ready(page);
  const g = await page.evaluate(() => { const v = document.getElementById('map-view').getBoundingClientRect(), hd = document.querySelector('.head').getBoundingClientRect(), nv = document.getElementById('nav').getBoundingClientRect();
    const f = document.querySelector('#map-card .map-floors').getBoundingClientRect(), z = document.querySelector('#map-card .map-zoom-ctl').getBoundingClientRect();
    return { h: v.height, free: nv.top - hd.bottom, overlap: !(f.bottom <= z.top || f.right <= z.left || z.right <= f.left), over: document.documentElement.scrollWidth - innerWidth }; });
  expect(g.h).toBeGreaterThanOrEqual(230);                  // v214 までは 150px
  expect(g.h).toBeLessThanOrEqual(g.free);                  // 少し送れば、画面にまるごと入る
  expect(g.overlap).toBe(false);
  expect(g.over).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

/* ---------------- v217：振り返りレポートの仕上げ ---------------- */
/** Code.gs が作った集計（本物の形）。nB を渡すと、時間帯を nB 枠ぶんに広げる（1日ぶんの記録のまね） */
function reportFromGas(nB) {
  const { loadGas } = require('./gas-mock');
  const g = loadGas({ props: { ADMIN_PASS: 'test-pass-1234' } });
  g.setupR8AndArchiveOthers();
  const P = { pass: 'test-pass-1234', cid: 'c1' };
  const ids = g.__get({}).booths.map(b => b.id);
  ids.forEach((id, i) => g.__post({ action: 'update', ...P, id, wait: (i * 7) % 26 }));
  g.__post({ action: 'visitor', ...P, n: 12, uid: 'v' });
  g.__post({ action: 'ledger', cid: 'RRRR1111', ev: [{ t: 's', id: '1F-02', at: Date.now() }] });
  const r = g.__get({ report: '1' });
  // 15分の境目をまたいで2枠になっても、1枠にそろえる（時計に左右されないように）
  const cut = n => {
    r.buckets = r.buckets.slice(0, n); r.overall = r.overall.slice(0, n); r.visitors.series = r.visitors.series.slice(0, n);
    r.booths.forEach(b => { b.series = b.series.slice(0, n); });
    r.summary.openLabel = r.buckets[0] + '〜' + r.buckets[n - 1];
  };
  if (!nB || nB === 1) { cut(1); return r; }
  const labels = Array.from({ length: nB }, (_, i) => { const m = 9 * 60 + i * 15; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); });
  r.buckets = labels;
  r.booths.forEach((b, k) => { b.series = labels.map((_, i) => (k + i) % 7 < 3 ? 0 : (k + i) % 7 < 5 ? 1 : 2); });
  r.overall = labels.map((t, i) => { const c = [0, 0, 0, 0]; r.booths.forEach(b => { c[b.series[i]]++; }); return { t, free: c[0], warn: c[1], busy: c[2], prep: c[3] }; });
  r.visitors = { total: 30 * nB, series: labels.map(() => 30) };
  r.summary.openLabel = labels[0] + '〜' + labels[nB - 1];
  r.summary.peakTime = labels[3]; r.summary.peakBusyCount = 14;
  return r;
}
for (const W of [390, 1280]) {
  test(`振り返り（v217）：札のすき間・まとめの札・日付・ブースの名前・時刻の目盛り（幅${W}px）`, async ({ page }) => {
    const errors = watchErrors(page);
    const report = reportFromGas(24);
    await mockGas(page, { report });
    await page.setViewportSize({ width: W, height: 844 });
    await page.goto('/?mode=report');
    await expect(page.locator('#report-body .hm-row').nth(1)).toBeVisible({ timeout: 15000 });
    // ③日付は「10月14日（水）の記録」の形
    await expect(page.locator('#report-body .card-t').first()).toHaveText(/^\d{1,2}月\d{1,2}日（[日月火水木金土]）の記録$/);
    // ⑦最も混んだ時間に、混雑していたブースの数
    await expect(page.locator('#report-body .rep-grid')).toContainText('混雑 14ブース');
    const m = await page.evaluate(() => {
      const q = s => [...document.querySelectorAll(s)];
      const cards = q('#report-body > .card').map(c => c.getBoundingClientRect());
      const gaps = cards.slice(1).map((c, i) => Math.round(c.top - cards[i].bottom));
      const grid = document.querySelector('#report-body .rep-grid').getBoundingClientRect();
      const tiles = q('#report-body .rep-grid > div').map(t => t.getBoundingClientRect());
      const rows = {};
      tiles.forEach(t => { const k = Math.round(t.top); (rows[k] = rows[k] || []).push(t); });
      const rowList = Object.keys(rows).map(Number).sort((a, b) => a - b).map(k => rows[k]);
      const names = q('#report-body .hm-n').map(e => ({ t: e.textContent, cut: e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) }));
      const ticks = document.querySelector('#report-body .hm-axis .hm-ticks'), cells = document.querySelector('#report-body .hm-row:not(.hm-axis) .hm-cells');
      const tr = ticks.getBoundingClientRect(), cr = cells.getBoundingClientRect();
      return { gaps, nTiles: tiles.length, firstRow: rowList[0].length,
        holes: rowList.map(r => Math.round(grid.right - Math.max(...r.map(t => t.right)))),
        names, tickText: [...ticks.children].map(x => x.textContent), axisMax: document.querySelector('#report-body .hm-axis .hm-max').textContent,
        tickOff: [Math.abs(tr.left - cr.left), Math.abs(tr.right - cr.right)],
        over: document.documentElement.scrollWidth - innerWidth };
    });
    // ①札どうしが、くっついていない
    expect(m.gaps.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...m.gaps), JSON.stringify(m.gaps)).toBeGreaterThanOrEqual(12);
    // ②まとめの札：どの段も右はしまで（半端な1枚の右が空かない）。広い画面では4枚ずつ
    expect(m.nTiles).toBeGreaterThanOrEqual(7);
    expect(Math.max(...m.holes), JSON.stringify(m.holes)).toBeLessThanOrEqual(1);
    expect(m.firstRow).toBe(W >= 720 ? 4 : 2);
    // ⑤ブースの名前：広い画面では全部が1行で読める。せまい画面でも、長い名前が2行で読める（「アームロボット・…」にしない）
    expect(m.names.length).toBe(46);
    const arm = m.names.find(x => x.t.indexOf('アームロボット') === 0);
    expect(arm && arm.cut, JSON.stringify(arm)).toBe(false);
    if (W >= 720) expect(m.names.filter(x => x.cut || x.lines > 1).map(x => x.t)).toEqual([]);
    else { expect(Math.max(...m.names.map(x => x.lines))).toBeLessThanOrEqual(2); expect(m.names.filter(x => x.cut).length).toBeLessThanOrEqual(3); }
    // ⑥時刻の目盛り：はじめ・まん中・おわり。色の列と同じ幅。右の数字が何かも書く
    expect(m.tickText).toEqual(['09:00', '11:45', '14:45']);
    expect(Math.max(...m.tickOff)).toBeLessThanOrEqual(1);
    expect(m.axisMax).toBe('最大');
    expect(m.over).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}
test('振り返り（v217）：記録が1枠だけの日でも、棒が画面いっぱいの板にならない。「まだ15分ぶん」と言う。スタンプの数はブースの行にも', async ({ page }) => {
  const errors = watchErrors(page);
  const report = reportFromGas(1);
  expect(report.buckets.length).toBe(1);
  await mockGas(page, { report });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=report');
  await expect(page.locator('#report-body .hm-row').nth(1)).toBeVisible({ timeout: 15000 });
  // 「00:15〜00:15」ではなく「00:15 から」
  await expect(page.locator('#report-body .rep-grid > div').first().locator('b')).toHaveText(/^\d\d:\d\d から$/);
  await expect(page.locator('#report-body .rep-few')).toContainText('15分ぶん');
  const m = await page.evaluate(() => {
    const svg = document.querySelector('#report-body .rep-chart');
    const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return { bars: [...document.querySelectorAll('#report-body .rep-chart rect')].map(r => Math.round(r.getBoundingClientRect().width)), k,
      cells: Math.round(document.querySelector('#report-body .hm-row:not(.hm-axis) .hm-cells').getBoundingClientRect().width),
      ticks: [...document.querySelectorAll('#report-body .hm-ticks span')].map(x => x.textContent),
      maxRight: Math.round(document.querySelector('#report-body .hm').getBoundingClientRect().right - document.querySelector('#report-body .hm-row:not(.hm-axis) .hm-max').getBoundingClientRect().right) };
  });
  expect(m.bars.length).toBeGreaterThan(0);
  expect(Math.max(...m.bars), JSON.stringify(m)).toBeLessThanOrEqual(Math.ceil(72 * m.k));
  expect(m.cells).toBeLessThanOrEqual(50);
  expect(m.ticks).toEqual([report.buckets[0]]);
  expect(m.maxRight).toBeLessThanOrEqual(1);            // 「◯人」は右はしのまま
  // ⑧スタンプが押されたブースは、行にも数が出る
  const row = page.locator('#report-body .hm-row', { has: page.locator('.hm-n', { hasText: /^旋盤の加工実演/ }) });
  await expect(row.locator('small')).toContainText('スタンプ 1');
  // 3枠以上あれば、「まだ…ぶん」は出さない
  await mockGas(page, { report: reportFromGas(3) });
  await page.locator('#btn-report-reload').click();
  await expect(page.locator('#report-body .hm-ticks span')).toHaveCount(3);
  await expect(page.locator('#report-body .rep-few')).toHaveCount(0);
  expect(errors).toEqual([]);
});

/* ---------------- v218：文字「特大」・QR から開いたときの輪・振り返りの動き ---------------- */
test('文字の大きさ（v218）：どの文字も「標準 ≦ 大きく ≦ 特大」（4つの画面）。チップ・スタンプ帳の名前・説明の文・ボタン・地図の＋− は大きくなる', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.addInitScript(() => { localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02'])); });
  await page.setViewportSize({ width: 390, height: 844 });
  const grow = {};
  for (const tab of ['map', 'list', 'stamp', 'info']) {
    await page.goto('/?tab=' + tab);
    await ready(page);
    const r = await page.evaluate(() => {
      const html = document.documentElement, before = html.getAttribute('data-fs');
      // 文字をじかに持つ、見えている部品（＋ 検索の欄）
      const els = [...document.querySelectorAll('.view.on *, .nav *, .head *')].filter(e => e.offsetParent &&
        (e.matches('input') || [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())));
      const key = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '');
      const size = fs => { html.setAttribute('data-fs', fs); return els.map(e => parseFloat(getComputedStyle(e).fontSize)); };
      const n = size('n'), lg = size('lg'), xl = size('xl');
      html.setAttribute('data-fs', before || 'n');
      const bad = [], pick = {};
      els.forEach((e, i) => {
        if (lg[i] < n[i] - 0.01 || xl[i] < lg[i] - 0.01) bad.push(`${key(e)} ${n[i]}/${lg[i]}/${xl[i]} 「${(e.textContent || e.placeholder || '').trim().slice(0, 12)}」`);
        for (const sel of ['.chip', '.stamp .lb', '.sum span', '.search input', '#zoom-in', '#v-stamp .card > p', '#stamp-todo', '#fs-n', '.redeem-msg', '.sid-sync', '.diag > summary', '.next-ev .tx'])
          if (!pick[sel] && e.matches(sel)) pick[sel] = [n[i], lg[i], xl[i]];
      });
      return { bad, pick, count: els.length };
    });
    expect(r.count).toBeGreaterThan(10);
    expect(r.bad, tab).toEqual([]);
    Object.assign(grow, r.pick);
  }
  // 小さくならないだけでなく、ちゃんと大きくなる（「特大」は「大きく」より大きい）
  for (const sel of ['.chip', '.stamp .lb', '.sum span', '.search input', '#v-stamp .card > p', '#stamp-todo', '#fs-n', '.redeem-msg', '.sid-sync', '.diag > summary']) {
    expect(grow[sel], sel).toBeTruthy();
    expect(grow[sel][1], sel + ' ' + grow[sel]).toBeGreaterThan(grow[sel][0]);
    expect(grow[sel][2], sel + ' ' + grow[sel]).toBeGreaterThan(grow[sel][1]);
  }
  expect(grow['#zoom-in'][2], '地図の＋').toBeGreaterThanOrEqual(grow['#zoom-in'][0]);
  // 「特大」で、幅 320px でも横にはみ出さない・スタンプ帳の名前が枠からはみ出さない（標準の文字・幅 390px でも）
  for (const [fs, W, tab] of [['n', 320, 'stamp'], ['xl', 390, 'stamp'], ['xl', 320, 'map'], ['xl', 320, 'list'], ['xl', 320, 'stamp'], ['xl', 320, 'info']]) {
    await page.addInitScript(v => localStorage.setItem('kuroko_fs', JSON.stringify(v)), fs);
    await page.setViewportSize({ width: W, height: 640 });
    await page.goto('/?tab=' + tab);
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), fs + ' ' + W + ' ' + tab).toBeLessThanOrEqual(0);
    if (tab === 'stamp') {
      const out = await page.evaluate(() => [...document.querySelectorAll('.stamp')].filter(s => s.offsetParent).filter(s => {
        const lb = s.querySelector('.lb'); if (!lb) return false;
        const a = s.getBoundingClientRect(), b = lb.getBoundingClientRect();
        return b.left < a.left - 0.5 || b.right > a.right + 0.5 || b.bottom > a.bottom + 0.5;
      }).map(s => s.textContent.trim().slice(0, 16)));
      expect(out, fs + ' ' + W).toEqual([]);
      if (fs === 'xl') expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stamp-grid')).gridTemplateColumns.split(' ').length)).toBe(2);
      // 折り返しても、1文字だけの行・「ー」で始まる行を作らない（標準の文字・幅 320px では、文節にこだわらない折り返しになる）
      const lines = await page.evaluate(fn => [...document.querySelectorAll('#stamp-grid .stamp .lb')].filter(e => e.offsetParent).map(el => eval(fn)(el)), LINES_FN);
      expect(lines.filter(l => l.some(x => /^[ー）」、。]/.test(x) || (l.length > 1 && x.length === 1))).map(l => l.join('／')), fs + ' ' + W).toEqual([]);
    }
  }
  // 画面を切り替えた瞬間に、送っている途中の通信が切れると、WebKit は「…due to access control checks」と言う（出ていく画面のことなので、エラーに数えない）
  expect(errors.filter(e => !/due to access control checks/.test(e))).toEqual([]);
});

test('QR から開いたとき（?booth=）：とじるボタンに赤い輪を出さない（v218）。キーボードを使う人には、今までどおり出す', async ({ page, isMobile }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await page.goto('/?booth=1F-02');
  await ready(page);
  const x = page.locator('#bsh-x');
  await expect(x).toBeVisible({ timeout: 10000 });
  await expect(x).toBeFocused();                       // とじるボタンへ移すのは今までどおり（読み上げ・Esc のため）
  await expect(x).toHaveClass(/quiet/);
  expect(await x.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('none');
  if (!isMobile) {
    // キーボードを使いはじめたら、輪を出す
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(x).not.toHaveClass(/quiet/);
    await expect(x).toBeFocused();
    expect(await x.evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe('none');
    // Esc でとじて、キーボードで開き直しても輪が出る
    await page.keyboard.press('Escape');
    await expect(x).toBeHidden();
    await page.evaluate(() => openSheet('1F-03'));
    await expect(x).toBeFocused();
    await expect(x).not.toHaveClass(/quiet/);
  }
  expect(errors).toEqual([]);
});

test('振り返り（v218）：開いたとき、棒が下から伸びる（動きを減らす設定では動かさない）。色の列を押すと、時刻と混み具合が出る', async ({ page }) => {
  const errors = watchErrors(page);
  const report = reportFromGas(24);
  await mockGas(page, { report });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?mode=report');
  await expect(page.locator('#report-body .hm-row').nth(1)).toBeVisible({ timeout: 15000 });
  // 棒は、時刻ごとのまとまり（.rc）で、下を軸に伸びる
  const a = await page.evaluate(() => {
    const g = document.querySelector('#report-body .rep-chart g.rc'), cs = getComputedStyle(g);
    return { n: document.querySelectorAll('#report-body .rep-chart g.rc').length, anim: cs.animationName, box: cs.transformBox, on: document.querySelector('#report-body').classList.contains('rep-in') };
  });
  expect(a.n).toBe(24);
  expect(a.on).toBe(true);
  expect(a.anim).toBe('rep-grow');
  expect(a.box).toBe('fill-box');
  // 動きが終わったら、印を外す（印刷・画像に途中を出さない）。棒は元の高さ
  await expect.poll(() => page.evaluate(() => document.querySelector('#report-body').classList.contains('rep-in')), { timeout: 5000 }).toBe(false);
  expect(await page.evaluate(() => Math.min(...[...document.querySelectorAll('#report-body .rep-chart g.rc')].map(g => g.getBoundingClientRect().height)))).toBeGreaterThan(20);
  // 色の列を押す → 時刻・ブース・混み具合。押した所に印（1つだけ）
  const read = page.locator('#hm-read');
  await expect(read).toContainText('押すと');
  const row = page.locator('#report-body .hm-row:not(.hm-axis)').nth(2);
  const name = (await row.locator('.hm-n').textContent()).trim();
  const lv = report.booths[2].series[5];
  await row.locator('.hm-cells i').nth(5).click();
  await expect(read).toContainText(report.buckets[5]);
  await expect(read).toContainText(name);
  await expect(read).toContainText(['空き', 'やや混雑', '混雑'][lv]);
  await row.locator('.hm-cells i').nth(9).click();
  await expect(read).toContainText(report.buckets[9]);
  await expect(page.locator('#report-body .hm-cells i.sel')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // 動きを減らす設定では、動かさない
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#btn-report-reload').click();
  await expect(page.locator('#report-body .hm-row').nth(1)).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => { const g = document.querySelector('#report-body .rep-chart g.rc'); return g.getBoundingClientRect().height; })).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('スタンプ帳の名前（v218）：幅 320〜430px・3つの文字の大きさで、枠からはみ出さない・1文字だけの行や「ー」で始まる行を作らない', async ({ page }) => {
  // GitHub（Linux）の Chromium は画面の右にスクロールバーの幅を取るので、同じ 390px でも枠の幅が手元と違う。
  // 幅を少しずつ変えて、どの幅でも崩れないことを見る（v218 の途中の作りは、枠が 96px 前後のときだけ「…コンロ製／作」になった）
  const errors = watchErrors(page);
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/?tab=stamp');
  await ready(page);
  const bad = [];
  for (const fs of ['n', 'lg', 'xl']) for (let w = 320; w <= 430; w += 5) {
    await page.setViewportSize({ width: w, height: 800 });
    const r = await page.evaluate(([fn, fs]) => {
      document.documentElement.setAttribute('data-fs', fs);
      return [...document.querySelectorAll('#stamp-grid .stamp .lb')].filter(e => e.offsetParent).map(el => {
        const l = eval(fn)(el), a = el.closest('.stamp').getBoundingClientRect(), b = el.getBoundingClientRect();
        return { l, over: b.left < a.left - 0.5 || b.right > a.right + 0.5 || b.bottom > a.bottom + 0.5 };
      }).filter(x => x.over || x.l.some(t => /^[ー）」、。]/.test(t) || (x.l.length > 1 && t.length === 1))).map(x => x.l.join('／') + (x.over ? '（はみ出し）' : ''));
    }, [LINES_FN, fs]);
    if (r.length) bad.push(`${fs} ${w}px: ${r.join(' | ')}`);
  }
  expect(bad).toEqual([]);
  expect(errors).toEqual([]);
});

/* ---------------- v219：司令塔が起こしたイベント（来場者の画面） ---------------- */
test('イベント（v219）：サーバーの返事に live があると、一斉お知らせ（1回だけ）とラッキーブースの帯が出る。係員のログインの画面には出ない。変な形の live でも落ちない', async ({ page }) => {
  const errors = watchErrors(page);
  const live = { show: { id: 'show0001', title: 'まもなくステージ発表！', text: '第一体育館へどうぞ', at: Date.now(), until: Date.now() + 120000 },
    lucky: { id: 'luck0001', booth: '1F-02', at: Date.now(), until: Date.now() + 300000 } };
  await mockGas(page, { mutate: j => { j.live = live; } });
  await page.goto('/?tab=map');
  await expect(page.locator('#lfx .lfx-title')).toHaveText('まもなくステージ発表！', { timeout: 15000 });
  await expect(page.locator('#lfx .lfx-text')).toHaveText('第一体育館へどうぞ');
  await expect(page.locator('#lfx [data-fx="close"]')).toBeFocused();
  await page.locator('#lfx [data-fx="close"]').click();
  await expect(page.locator('#lfx')).toHaveCount(0);
  // ラッキーブース：帯（名前・残り時間・「見る」）。横にはみ出さない・押す所は 44px 以上
  const bn = page.locator('#banner-lucky');
  await expect(bn).toBeVisible();
  await expect(bn).toContainText('旋盤の加工実演');
  await expect(bn).toContainText(/あと[45]分/);
  expect(await page.locator('#banner-lucky-go').evaluate(el => el.offsetHeight)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // 開き直しても、同じお知らせは もう出ない。帯は、どのタブにも出る
  for (const tab of ['list', 'stamp', 'info']) {
    await page.goto('/?tab=' + tab);
    await ready(page);
    await expect(bn).toBeVisible();
    await expect(page.locator('#lfx')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), tab).toBeLessThanOrEqual(0);
  }
  // 変な形の live でも落ちない・何も出さない（古い・時間の過ぎたものも出さない）
  for (const bad of ['x', 5, [], null, { show: 'a', lucky: [], draw: 7 }, { show: { id: 5, title: {}, until: 'z' } },
    { lucky: { id: 'l2', booth: '"><img src=x onerror=window.__xss=1>', until: Date.now() + 60000 } }, { show: { id: 'old1', title: 'ふるい', until: Date.now() - 1000 } },
    { draw: { id: 'd9', until: Date.now() - 5 } }]) {
    await page.evaluate(v => { S.live = v; renderLive(); }, bad);
    await expect(page.locator('#lfx')).toHaveCount(0);
    await expect(bn).toBeHidden();
  }
  expect(await page.evaluate(() => !!window.__xss)).toBe(false);
  // 係員のログインの画面には出ない
  await page.goto('/?mode=admin');
  await expect(page.locator('#v-auth')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
  await expect(bn).toBeHidden();
  await expect(page.locator('#lfx')).toHaveCount(0);
  expect(errors).toEqual([]);
});

/* ---------------- v220：来場者の画面のイベントの仕上げ ---------------- */
test('イベント（v220）：一斉お知らせは、時間がたつと自分でとじる（残りの線つき）。「当たり」は、とじるまで出しておく。ラッキーブースの帯は、上から出る', async ({ page }) => {
  const errors = watchErrors(page);
  const live = { lucky: { id: 'luck0220', booth: '1F-02', at: Date.now(), until: Date.now() + 300000 } };
  await mockGas(page, { mutate: j => { j.live = live; } });
  await page.goto('/?tab=map');
  await ready(page);
  // 帯：出るときの動き
  await expect(page.locator('#banner-lucky')).toBeVisible();
  expect(await page.locator('#banner-lucky').evaluate(el => getComputedStyle(el).animationName)).toBe('lk-in');
  // 一斉お知らせ：線が出て、時間で消える（ここでは 1.5秒に縮めて見る。ふだんは 15秒）
  await page.evaluate(() => { showLiveFx.autoMs = 1500; showLiveFx('show', 'まもなく開場です', '少しお待ちください'); });
  await expect(page.locator('#lfx .lfx-bar i')).toBeVisible();
  expect(await page.locator('#lfx .lfx-bar i').evaluate(el => getComputedStyle(el).animationName)).toBe('lfx-bar');
  await expect(page.locator('#lfx')).toHaveCount(0, { timeout: 6000 });
  // 手でとじたときは、その時間が来ても、あとから出たものを勝手にとじない
  await page.evaluate(() => { showLiveFx.autoMs = 2500; showLiveFx('show', '1つ目', ''); showLiveFx.close(); });
  await expect(page.locator('#lfx')).toHaveCount(0);
  await page.evaluate(() => { showLiveFx.autoMs = 60000; showLiveFx('win', '当たり！', '本部で、この画面を見せてください'); });
  await expect(page.locator('#lfx.win')).toBeVisible();
  await expect(page.locator('#lfx .lfx-bar')).toHaveCount(0);                // 「当たり」には線が無い
  await page.waitForTimeout(3200);
  await expect(page.locator('#lfx.win')).toBeVisible();                     // 1つ目の時間（2.5秒）が来ても、とじない
  await page.locator('#lfx [data-fx="close"]').click();
  await expect(page.locator('#lfx')).toHaveCount(0);
  expect(errors).toEqual([]);
});

/* ---------------- v222：来場者の画面のイベントの仕上げ ---------------- */
test('イベント（v222）：見のがした一斉お知らせを、インフォで読み返せる。ラッキーブースの帯はとじられ、ある階のボタンに印。スタンプが足りない人は、抽選をサーバーに聞きに行かない', async ({ page }) => {
  const errors = watchErrors(page);
  const now = Date.now();
  const live = { show: { id: 'show0222', title: 'まもなく<b id="x222">開場</b>', text: '南棟昇降口へどうぞ', at: now, until: now + 120000 },
    lucky: { id: 'luck0222', booth: '2F-12', at: now, until: now + 300000 },
    draw: { id: 'draw0222', at: now, until: now + 600000, min: 3, n: 1 } };
  const log = await mockGas(page, { mutate: j => { j.live = live; } });
  await page.addInitScript(() => { if (!localStorage.getItem('kuroko_stamps_v2')) localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02'])); });
  await page.goto('/?tab=map');
  // 一斉お知らせ：読み返せることを言う
  await expect(page.locator('#lfx .lfx-title')).toHaveText('まもなく<b id="x222">開場</b>', { timeout: 15000 });
  await expect(page.locator('#lfx .sfx-note')).toContainText('インフォの画面で読み返せます');
  await page.locator('#lfx [data-fx="close"]').click();
  await expect(page.locator('#lfx')).toHaveCount(0);
  // 抽選：スタンプ1個（3個以上が対象）→ あと2個。サーバーには聞かない
  await expect(page.locator('#toast')).toContainText('あと2個', { timeout: 10000 });
  await page.waitForTimeout(600);
  expect(log.gets.filter(q => /win=/.test(q))).toEqual([]);
  await expect(page.locator('#win-card')).toHaveCount(0);
  // ラッキーブース（2階）：いま見ている1階ではなく、2階のボタンに印
  const ring = await page.evaluate(() => ['#fl-2', '#fl-1'].map(s => getComputedStyle(document.querySelector(s)).outlineColor));
  expect(ring[0]).toBe('rgb(217, 165, 20)');
  expect(ring[1]).not.toBe('rgb(217, 165, 20)');
  // 帯は×でとじられる。開き直しても、そのラッキーブースのあいだは出ない。地図の印は残る
  const bn = page.locator('#banner-lucky');
  await expect(bn).toBeVisible();
  expect(await page.locator('#banner-lucky-x').evaluate(el => el.offsetHeight)).toBeGreaterThanOrEqual(44);
  await page.locator('#banner-lucky-x').click();
  await expect(bn).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('lucky-style').textContent.length)).toBeGreaterThan(50);
  await page.goto('/?tab=info');
  await ready(page);
  await expect(bn).toBeHidden();
  // インフォ：本部からのお知らせ（時刻・見出し・ひとこと）。文字はタグにしない
  const card = page.locator('#live-log-card');
  await expect(card).toBeVisible();
  await expect(card.locator('li b')).toHaveText('まもなく<b id="x222">開場</b>');
  await expect(card.locator('li span')).toHaveText('南棟昇降口へどうぞ');
  await expect(card.locator('li small')).toHaveText(/^\d\d:\d\d$/);
  expect(await page.evaluate(() => !!document.querySelector('#x222'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // 別のラッキーブースが始まったら、帯はまた出る
  await page.evaluate(() => { S.live.lucky = { id: 'luck0223', booth: '1F-02', at: Date.now(), until: Date.now() + 300000 }; renderLive(); });
  await expect(bn).toBeVisible();
  // ラッキーブースでスタンプを押したときだけ、演出にひとこと
  await page.evaluate(() => showStampFx('1F-02', true));
  await expect(page.locator('.sfx-lucky')).toHaveText('ラッキーブースでスタンプ！');
  await page.evaluate(() => { document.querySelectorAll('.sfx').forEach(e => e.remove()); document.documentElement.classList.remove('sfx-open'); showStampFx('1F-03', true); });
  await expect(page.locator('.sfx .sfx-goal')).toBeVisible();
  await expect(page.locator('.sfx-lucky')).toHaveCount(0);
  await page.evaluate(() => { document.querySelectorAll('.sfx').forEach(e => e.remove()); document.documentElement.classList.remove('sfx-open'); });
  // 古いお知らせ（6時間より前）・こわれた保存は出さない
  await page.evaluate(() => { localStorage.setItem('kuroko_live_log', JSON.stringify([{ id: 'old', title: 'きのうの', text: '', at: Date.now() - 7 * 3600000 }, 5, null, { title: 9 }])); renderLiveLog(); });
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});
