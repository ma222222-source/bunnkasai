// 長い時間開きっぱなしにしたとき（v182）。
// 文化祭の日は朝から開きっぱなしの端末が多い（受付のボード・係員・来場者）。時計を早送りして2時間ぶんの自動更新を回し
//（返事の中身は毎回変える。ときどきタブ・階・拡大・詳細も触る）、画面の部品・イベントの登録・メモリ・端末の保存が増え続けないことを確かめる。
// もっと長く：HOURS=6 npx playwright test leak.spec.js（手元で 6時間ぶんを確かめた：要素 7458→7572・メモリ 2.9→3.5MB）
const { test, expect } = require('@playwright/test');
const { snapshot } = require('./mock');
test('2時間ぶん開きっぱなしでも、画面の部品・メモリ・保存が増え続けない', async ({ page, context }) => {
  test.setTimeout(900000);
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  let n = 0;
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    n++;
    const req = route.request();
    if (req.method() === 'POST') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    // 返すたびに中身を変える（毎回どこかのブースの人数・状態が変わる。ときどきお知らせも変わる）
    const d = snapshot({ notice: n % 40 < 20 ? null : { text: 'お知らせ ' + Math.floor(n / 40), level: n % 80 < 40 ? 'info' : 'alert' } });
    d.booths.forEach((b, i) => { if (b.status) { b.wait = (i * 3 + n * 7 + (i % 5) * n) % 28; b.status = ['空いています', 'やや混雑', '混雑しています', '準備中'][(i + Math.floor(n / 3)) % 4]; } });
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(d) });
  });
  await page.addInitScript(() => { try { localStorage.setItem('kuroko_intro_v1', '1'); localStorage.setItem('kuroko_wish_v1', JSON.stringify(['1F-02', '1F-05', '2F-01'])); } catch (e) {} });
  await page.clock.install({ time: new Date('2026-10-24T09:30:00+09:00') });
  await page.goto('/?tab=' + (process.env.TAB || 'map'));
  await page.waitForFunction(() => typeof S !== 'undefined' && S.booths.length > 0);
  const c = await context.newCDPSession(page);
  const measure = async label => {
    await c.send('HeapProfiler.collectGarbage'); await c.send('HeapProfiler.collectGarbage');
    const dom = await c.send('Memory.getDOMCounters');
    const heap = await c.send('Runtime.getHeapUsage');
    const extra = await page.evaluate(() => ({ els: document.querySelectorAll('*').length, body: document.body.children.length, styles: document.querySelectorAll('style').length,
      keys: Object.keys(localStorage).length, lsBytes: Object.keys(localStorage).reduce((t, k) => t + (localStorage.getItem(k) || '').length, 0),
      hist: (S.booths[5] && S.booths[5].history || []).length, changedAt: S.changedAt ? S.changedAt.size : -1, prevLv: S.prevLv ? S.prevLv.size : -1 }));
    const row = { label, req: n, nodes: dom.nodes, listeners: dom.jsEventListeners, heapMB: +(heap.usedSize / 1048576).toFixed(1), ...extra };
    if (process.env.TRACE) console.log(JSON.stringify(row));
    return row;
  };
  const hours = Number(process.env.HOURS || 2);
  const stepsPerHour = 180;        // 20秒ずつ
  const rows = [];
  for (let h = 0; h <= hours; h++) {
    if (h > 0) {
      for (let i = 0; i < stepsPerHour; i++) {
        await page.clock.runFor(20000);
        // 人がときどき触る（触らないと自動更新の間隔が広がる）：タブを替える・詳細を開く・階を替える
        if (i % 15 === 7) await page.evaluate(i => { try { markActive(); const v = ['map', 'list', 'stamp', 'info', 'map'][i % 5]; switchView(v); if (v === 'map') { setFloor([1, 2, 3, 0][i % 4]); zoomTo(1 + (i % 6), null, null, false); } if (i % 30 === 7 && S.booths[i % 46]) { openSheet(S.booths[i % 46].id); closeSheet(); } } catch (e) { console.error(e); } }, i + h * 7);
      }
    }
    rows.push(await measure(h + '時間'));
  }
  const a = rows[1], z = rows[rows.length - 1];
  const msg = `1時間→${hours}時間：要素 ${a.nodes}→${z.nodes}　リスナー ${a.listeners}→${z.listeners}　メモリ ${a.heapMB}→${z.heapMB}MB　保存 ${a.lsBytes}→${z.lsBytes}字`;
  expect(errs).toEqual([]);
  // 測るたびに少し上下する（片付けのタイミング）ので、はっきり増え続けたときだけ失敗にする
  expect(z.nodes, msg).toBeLessThan(a.nodes * 1.3 + 500);
  expect(z.listeners, msg).toBeLessThan(a.listeners * 3 + 300);
  expect(z.heapMB, msg).toBeLessThan(Math.max(30, a.heapMB * 4));
  expect(z.lsBytes, msg).toBeLessThan(a.lsBytes * 1.5 + 2000);
  expect(z.req, '自動更新が止まっていない').toBeGreaterThan(a.req + 20);
});
