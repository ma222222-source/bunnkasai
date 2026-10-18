// v239：通信の返事と、画面に出す「確認した時刻」を切り分ける。
// GAS はすべて模擬し、本番には送らない。
const { test, expect } = require('@playwright/test');
const { mockGas, watchErrors } = require('./mock');
const { loadGas } = require('./gas-mock');

async function openLive(page, getGen = () => 'g1') {
  const errors = watchErrors(page);
  await mockGas(page, { gen: getGen, mutate: j => { j.serverVersion = '2026-10-16a'; j.gen = getGen(); } });
  await page.addInitScript(() => localStorage.setItem('kuroko_intro_v1', '1'));
  await page.goto('/?tab=list');
  await expect.poll(() => page.evaluate(() => typeof S !== 'undefined' && S.booths.length === 46 && !sync._busy)).toBe(true);
  // 自動の取り直しが、わざと遅らせた返事や20秒前の情報を上書きしないようにする。
  await page.evaluate(() => {
    clearTimeout(S.timer); clearTimeout(GEN.t);
    window.schedule = () => {}; window.genSchedule = () => {};
    window.hoursMessage = () => null;
    S.fetchedAt = Date.now() - 20000; GEN.at = 0;
    renderSyncState(); renderSyncSec();
  });
  return errors;
}

test('通信確認（v239）：HTTPエラー・不正な返事で「確認した時刻」を新しくしない', async ({ page }) => {
  const errors = await openLive(page);
  let reply;
  await page.route(/gen=1/, r => r.fulfill({ contentType: 'application/json', ...reply }));
  for (const response of [
    { status: 500, body: '{"ok":true,"gen":"g1"}' },
    { status: 200, body: '{"ok":false,"gen":"g1"}' },
    { status: 200, body: '{}' },
    { status: 200, body: '{"ok":true,"gen":"   "}' },
    { status: 200, body: '{"ok":true,"gen":123}' },
    { status: 200, body: '{broken' },
  ]) {
    reply = response;
    await page.evaluate(() => genCheck());
    expect(await page.evaluate(() => GEN.at), JSON.stringify(response)).toBe(0);
    expect(await page.evaluate(() => GEN.fail)).toBeGreaterThan(0);
    expect(await page.evaluate(() => S.booths.length)).toBe(46);
    await page.evaluate(() => renderSyncSec());
    await expect(page.locator('#sync-sec')).not.toHaveText('・0秒前に確認');
  }
  expect(errors).toEqual([]);
});

test('通信確認（v239）：変化の通知だけでは古い情報を確認済みにせず、本体が届いてから最新にする', async ({ page }) => {
  let generation = 'g1';
  const errors = await openLive(page, () => generation);
  let release, started = false;
  const gate = new Promise(r => { release = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async r => {
    const u = new URL(r.request().url());
    if (u.searchParams.has('gen')) return r.fulfill({ json: { ok: true, gen: generation } });
    if (r.request().method() === 'GET' && !u.searchParams.has('ledger')) {
      started = true; await gate;
    }
    return r.fallback();
  });
  generation = 'g2';
  try {
    await page.evaluate(() => genCheck());
    await expect.poll(() => started).toBe(true);
    expect(await page.evaluate(() => S.gen)).toBe('g1');
    expect(await page.evaluate(() => GEN.at)).toBe(0);
    expect(await page.evaluate(() => chkAgo())).not.toBe('・確認 0秒前');
  } finally { release(); }
  await expect.poll(() => page.evaluate(() => S.gen)).toBe('g2');
  expect(await page.evaluate(() => chkAgo())).toMatch(/^・確認 [0-3]秒前$/);
  expect(errors).toEqual([]);
});

test('通信確認（v239）：重なった確認は1本にまとめ、正常な「変化なし」で確認時刻を進める', async ({ page }) => {
  const errors = await openLive(page);
  let requests = 0, replyGen = 'g1';
  await page.route(/gen=1/, async r => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 100));
    return r.fulfill({ json: { ok: true, gen: replyGen } });
  });
  await page.evaluate(() => Promise.all([genCheck(), genCheck(), genCheck()]));
  expect(requests).toBe(1);
  await page.evaluate(() => renderSyncSec());
  await expect(page.locator('#sync-sec')).toHaveText(/^・[0-3]秒前に確認$/);
  // Code.gs は、番号のキャッシュが切れると空文字を返す。本体と同じ空文字なら正常な「変化なし」。
  replyGen = '';
  await page.evaluate(() => { S.gen = ''; GEN.at = 0; });
  await page.evaluate(() => genCheck());
  expect(await page.evaluate(() => GEN.at)).toBeGreaterThan(0);
  expect(await page.evaluate(() => GEN.fail)).toBe(0);
  expect(errors).toEqual([]);
});

test('通信確認（v239）：手動で最新にした後に古い確認が届いても、余計な取り直しをしない', async ({ page }) => {
  let generation = 'g1', fullRequests = 0;
  const errors = await openLive(page, () => generation);
  let release, started = false;
  const gate = new Promise(r => { release = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async r => {
    const u = new URL(r.request().url());
    if (u.searchParams.has('gen')) {
      started = true; await gate;
      try { return await r.fulfill({ json: { ok: true, gen: 'g1' } }); } catch (_) { return; }
    }
    if (r.request().method() === 'GET' && !u.searchParams.has('ledger')) fullRequests++;
    return r.fallback();
  });
  await page.evaluate(() => { window.__genTask = genCheck(); });
  await expect.poll(() => started).toBe(true);
  generation = 'g2';
  try { await page.evaluate(() => sync(true)); } finally { release(); }
  await page.evaluate(() => window.__genTask);
  expect(await page.evaluate(() => S.gen)).toBe('g2');
  expect(await page.evaluate(() => GEN.at)).toBe(0);
  expect(fullRequests).toBe(1);
  expect(errors).toEqual([]);
});

test('通信確認（v239）：別のアプリへ移ったら確認中の通信を止め、見ていない画面を確認済みにしない', async ({ page }) => {
  const errors = await openLive(page);
  let release, started = false;
  const gate = new Promise(r => { release = r; });
  await page.route(/gen=1/, async r => {
    started = true; await gate;
    try { await r.fulfill({ json: { ok: true, gen: 'g1' } }); } catch (_) {}
  });
  await page.evaluate(() => { window.__genTask = genCheck(); });
  await expect.poll(() => started).toBe(true);
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => !!GEN.busy)).toBe(false);
  } finally { release(); }
  await page.evaluate(() => window.__genTask);
  expect(await page.evaluate(() => GEN.at)).toBe(0);
  expect(errors).toEqual([]);
});

test('通信確認（v239）：圏外になったらすぐ知らせ、地図・ブース・スタンプを保ち、復帰後に最新へ戻る', async ({ page, context }) => {
  const errors = await openLive(page);
  await page.evaluate(() => { S.stamps.add('1F-02'); store('kuroko_stamps_v2', Array.from(S.stamps)); openSheet('1F-02'); });
  await context.setOffline(true);
  await expect(page.locator('#banner-offline')).toBeVisible();
  await expect(page.locator('#sync-text')).toContainText('つながっていません');
  await expect(page.locator('#sync-sec')).toBeEmpty();
  await expect(page.locator('#sync-dot')).not.toHaveClass(/\blive\b/);
  await expect(page.locator('#bsh .chk')).toBeEmpty();
  expect(await page.evaluate(() => S.booths.length)).toBe(46);
  expect(await page.evaluate(() => S.stamps.has('1F-02'))).toBe(true);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => S.online && !sync._busy)).toBe(true);
  await expect(page.locator('#banner-offline')).toBeHidden();
  expect(await page.evaluate(() => S.stamps.has('1F-02'))).toBe(true);
  expect(errors).toEqual([]);
});

test('通信確認（v239）：取得中に圏外から戻り、前の取得が失敗しても、そのあと自動で取り直す', async ({ page, context }) => {
  let generation = 'g1', fullRequests = 0, release;
  const errors = await openLive(page, () => generation);
  const gate = new Promise(r => { release = r; });
  await page.route(/script\.google(usercontent)?\.com\//, async r => {
    const u = new URL(r.request().url());
    if (r.request().method() === 'GET' && !u.searchParams.has('gen') && !u.searchParams.has('ledger')) {
      fullRequests++;
      if (fullRequests === 1) {
        await gate;
        try { return await r.fulfill({ json: { ok: false, error: '圏外になる前の取得が失敗' } }); } catch (_) { return; }
      }
    }
    return r.fallback();
  });
  await page.evaluate(() => { window.__fullTask = sync(false); });
  await expect.poll(() => fullRequests).toBe(1);
  try {
    await context.setOffline(true);
    generation = 'g2';
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => S.reconnectAt > 0)).toBe(true);
  } finally { release(); }
  await page.evaluate(() => window.__fullTask);
  await expect.poll(() => page.evaluate(() => S.online && S.gen === 'g2'), { timeout: 10000 }).toBe(true);
  expect(fullRequests).toBe(2);
  expect(errors).toEqual([]);
});

test('通信確認（v239）：本物のGASの処理で、変化したブースを1往復で画面に反映する', async ({ page }) => {
  const errors = watchErrors(page), requests = [];
  const g = loadGas({ props: { ADMIN_PASS: 'test-pass-1234' } });
  g.setupR8AndArchiveOthers();
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    const req = route.request(), param = Object.fromEntries(new URL(req.url()).searchParams);
    if (req.method() === 'GET' && !param.ledger && !param.win) requests.push(param);
    if (param.gen) await new Promise(r => setTimeout(r, 120));
    const body = req.method() === 'POST'
      ? g.doPost({ postData: { contents: req.postData() || '{}' } }).getContent()
      : g.doGet({ parameter: param }).getContent();
    return route.fulfill({ contentType: 'application/json', body });
  });
  await page.addInitScript(() => localStorage.setItem('kuroko_intro_v1', '1'));
  await page.goto('/?tab=list');
  await expect.poll(() => page.evaluate(() => typeof S !== 'undefined' && S.booths.length === 46 && !sync._busy)).toBe(true);
  await page.evaluate(() => {
    clearTimeout(S.timer); clearTimeout(GEN.t);
    window.schedule = () => {}; window.genSchedule = () => {};
  });
  requests.length = 0;
  g.__post({ action: 'update', pass: 'test-pass-1234', cid: 'aaaa1111aaaa', id: '1F-02', wait: 11 });
  await page.evaluate(() => genCheck());
  await expect(page.locator('[id="booth-1F-02"] .pl-b')).toHaveText('11人待ち');
  expect(requests).toHaveLength(1);
  expect(requests[0].gen).toBe('1');
  expect(typeof requests[0].since).toBe('string');
  expect(await page.evaluate(() => S.gen)).toBe(g.__get({ gen: '1' }).gen);
  // 次は変化なし。本体の取り込みや一覧の作り直しは不要。
  await page.evaluate(() => { window.__keptCard = document.getElementById('booth-1F-02'); });
  await page.evaluate(() => genCheck());
  expect(await page.evaluate(() => window.__keptCard === document.getElementById('booth-1F-02'))).toBe(true);
  expect(errors).toEqual([]);
});

test('通信確認（v239）：直前に確認できた情報は詳細を開いても取り直さず、操作を再開したらすぐ軽く確認する', async ({ page }) => {
  const errors = await openLive(page);
  const requests = [];
  await page.route(/script\.google(usercontent)?\.com\//, r => {
    const p = Object.fromEntries(new URL(r.request().url()).searchParams);
    if (r.request().method() === 'GET' && !p.ledger && !p.win) requests.push(p);
    return r.fallback();
  });
  await page.evaluate(() => {
    S.fetchedAt = Date.now() - 22000; GEN.at = Date.now();
    openSheet('1F-02');
  });
  await expect(page.locator('#bsh')).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.evaluate(() => { GEN.at = Date.now() - 22000; S.activeAt = Date.now() - 60000; });
  await page.keyboard.press('Shift');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].gen).toBe('1');
  await expect.poll(() => page.evaluate(() => Date.now() - GEN.at < 3000)).toBe(true);
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
});
