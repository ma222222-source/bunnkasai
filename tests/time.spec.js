// 時刻をずらしたとき（v182）。
// 開催の前日から終わった次の日まで、時計を30分ずつ動かして、開場前・開催中・最終入場・終了・翌日の案内が
// その時刻に合っていること、どの時刻でもエラーや変な文字（NaN・マイナスの分 など）が出ないことを確かめる。
// 開催日は、このテストの中で決める（校内公開日 10/23 10:00〜14:25、一般公開日 10/24 9:30〜14:30・最終入場 14:00）。
// 本番の CONFIG.HOURS を変えても、このテストは変わらない
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');

const HOURS = { days: [
  { date: '2026-10-23', open: '10:00', close: '14:25', label: '校内公開日' },
  { date: '2026-10-24', open: '09:30', close: '14:30', last: '14:00', label: '一般公開日' },
] };
const at = s => new Date(s + ':00+09:00');

async function open(page) {
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await mockGas(page);
  await page.addInitScript(h => {
    try { localStorage.setItem('kuroko_intro_v1', '1'); localStorage.setItem('kuroko_stamps_v2', JSON.stringify(['1F-02', '1F-03', '1F-05', '1F-07', '1F-08'])); } catch (e) {}
    window.__HOURS = h;
  }, HOURS);
  await page.clock.install({ time: at('2026-10-22T00:00') });
  await page.goto('/?tab=map');
  await page.waitForFunction(() => typeof S !== 'undefined' && S.booths.length > 0);
  await page.evaluate(() => { CONFIG.HOURS = window.__HOURS; });
  return errs;
}
/** その時刻にして描き直し、画面に出ている案内を集める */
async function lookAt(page, when) {
  await page.clock.setFixedTime(when);
  return page.evaluate(() => {
    const out = {};
    try {
      const now = new Date().toISOString();
      S.updatedAt = now; S.fetchedAt = Date.now(); S.booths.forEach(b => { if (b.time) b.time = now; });
      renderAll(); renderInfo(); switchView('info'); switchView('map');
      const vis = id => { const e = document.getElementById(id); return e && !e.classList.contains('hide') ? e.innerText.replace(/\s+/g, ' ').trim() : ''; };
      const hm = hoursMessage();
      out.state = openState().state; out.short = hm ? hm.short : ''; out.banner = vis('banner-hours');
      out.sync = document.getElementById('sync-text').textContent;
      out.bad = (document.body.innerText.match(/NaN|undefined|Invalid Date|あと-\d|-\d+分/g) || []).slice(0, 3).join(',');
    } catch (e) { out.err = String(e && e.stack || e).split('\n').slice(0, 2).join(' | '); }
    return out;
  });
}

test('開催の前日〜次の日を30分ずつ：どの時刻でもエラー・変な文字が出ない', async ({ page }) => {
  test.setTimeout(180000);
  const errs = await open(page);
  for (let t = at('2026-10-22T06:00').getTime(); t <= at('2026-10-25T20:00').getTime(); t += 30 * 60000) {
    const r = await lookAt(page, new Date(t));
    const label = new Date(t + 9 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
    if (r.err) errs.push(label + ' ' + r.err);
    if (r.bad) errs.push(label + ' 変な文字：' + r.bad);
  }
  expect(errs.slice(0, 10)).toEqual([]);
});

test('時刻ごとの案内：前日・開場前・開催中・最終入場の前後・終了・次の日', async ({ page }) => {
  const errs = await open(page);
  let r = await lookAt(page, at('2026-10-22T12:00'));           // 前日
  expect(r.state).toBe('otherday');
  expect(r.short).toContain('一般公開は 10月24日');
  r = await lookAt(page, at('2026-10-23T09:00'));               // 校内公開日の開場前
  expect(r.state).toBe('before');
  expect(r.short).toContain('10:00 開場');
  expect(r.banner).toContain('校内公開日');
  // 一般の方が「今日来られる」と読まないよう、一般公開の日も並べて出す（v182）
  expect(r.banner).toContain('一般公開は 10月24日');
  r = await lookAt(page, at('2026-10-23T12:00'));               // 開催中は、開催時間の案内ではなく更新の状況
  expect(r.state).toBe('open');
  expect(r.short).toBe('');
  expect(r.banner).toBe('');
  expect(r.sync).toContain('最新の情報');
  r = await lookAt(page, at('2026-10-23T14:10'));               // 終わる30分前から
  expect(r.short).toContain('まもなく終了');
  r = await lookAt(page, at('2026-10-23T15:00'));
  expect(r.state).toBe('after');
  expect(r.short).toContain('本日は終了しました');
  r = await lookAt(page, at('2026-10-24T09:00'));               // 一般公開日の開場前（一般公開の日の案内は足さない）
  expect(r.state).toBe('before');
  expect(r.banner).toContain('09:30 開場');
  expect(r.banner).not.toContain('一般公開は');
  r = await lookAt(page, at('2026-10-24T13:45'));               // 最終入場の30分前から
  expect(r.short).toContain('最終入場は 14:00');
  r = await lookAt(page, at('2026-10-24T14:10'));
  expect(r.short).toContain('最終入場（14:00）を過ぎました');
  r = await lookAt(page, at('2026-10-24T15:00'));
  expect(r.state).toBe('after');
  r = await lookAt(page, at('2026-10-25T10:00'));               // 終わった次の日
  expect(r.state).toBe('otherday');
  expect(r.short).toContain('今年の文化祭は終了しました');
  expect(errs).toEqual([]);
});
