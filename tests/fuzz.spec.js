// サーバーの返事が変な形のとき（v180）。
// 係の人の打ち間違い・シートの列の入れ替わり・通信の途中切れなどで、返事が想定と違う形になっても、
// 来場者の画面と印刷の画面が、エラー・真っ白・横はみ出しにならないことを確かめる。
// 種ごとに壊し方が違う（12種類：0件／156件／名前／待ち・状態／時刻／階・種類／推移・メモ・画像／ID／お知らせ・設定／欄の欠け／配列でない／全部でたらめ）
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');
const SEEDS = (process.env.SEEDS || '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number);

function mutator(seed) {
  let s = seed * 104729; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const pick = a => a[rnd(a.length)];
  const WEIRD = [null, undefined, '', ' ', 0, -1, 1e9, NaN, '12', 'abc', true, [], {}, '　', '🎉🎉🎉', 'あ'.repeat(300), '<b>x</b>', '2026-13-45', 'Invalid Date', 3.7, '−5', '０'];
  const notes = [];
  const mut = d => {
    const kind = seed % 12;
    const B = d.booths;
    const each = (p, f) => B.forEach((b, i) => { if (rnd(100) < p) f(b, i); });
    if (kind === 0) { d.booths = []; notes.push('0件'); }
    else if (kind === 1) { const extra = []; for (let i = 0; i < 110; i++) { const b = JSON.parse(JSON.stringify(B[i % B.length])); b.id = 'X-' + i; b.name = '追加' + i; extra.push(b); } d.booths = B.concat(extra); notes.push('156件（図面に無いID 110件）'); }
    else if (kind === 2) { each(40, b => { b.name = pick(WEIRD); }); notes.push('名前が変'); }
    else if (kind === 3) { each(50, b => { b.wait = pick(WEIRD); b.status = pick(['空いています', 'やや混雑', '混雑', '準備中', '', '???', null, 5, {}]); }); notes.push('待ち・状態が変'); }
    else if (kind === 4) { each(50, b => { b.time = pick(WEIRD); b.stale = pick([true, false, null, 'yes', 1]); }); d.updatedAt = pick(WEIRD); notes.push('時刻が変'); }
    else if (kind === 5) { each(50, b => { b.floor = pick([0, 1, 2, 3, 4, 9, -1, '2', '２階', null, 'B1', 1.5]); b.category = pick(WEIRD); }); notes.push('階・種類が変'); }
    else if (kind === 6) { each(60, b => { b.history = pick([null, 'x', [], [null], [{}], [{ lv: 'a', t: null, w: {} }], [{ lv: 9, t: '99:99', w: -3 }], Array(500).fill({ lv: 1, t: '10:00', w: 2 })]); b.note = pick(WEIRD); b.image = pick([null, 5, 'javascript:alert(1)', 'http://x/y.png', 'data:text/html,<script>1</script>', '//evil', 'あ'.repeat(400)]); b.dept = pick(WEIRD); }); notes.push('推移・メモ・画像・科が変'); }
    else if (kind === 7) { each(30, (b, i) => { b.id = pick([B[0].id, '', null, 12, 'a b', '../x', 'ID' + 'x'.repeat(60), '1F-02 ', '１Ｆ－０２']); }); notes.push('ID が重複・変'); }
    else if (kind === 8) { d.notice = pick([5, 'text', { text: null, level: 'alert' }, { text: 'あ'.repeat(3000), level: 'x' }, { text: 12, level: null }, []]); d.visitors = pick([null, 5, { today: 'x', updatedAt: 'y' }, { today: -5 }, []]); d.waitThresholds = pick([null, 'x', { warn: 'a', busy: null }, { warn: 50, busy: 3 }, []]); d.pollSec = pick(WEIRD); d.staleMinutes = pick(WEIRD); d.serverVersion = pick(WEIRD); notes.push('お知らせ・来場者・設定が変'); }
    else if (kind === 9) { each(100, b => { Object.keys(b).forEach(k => { if (k !== 'id' && rnd(100) < 35) delete b[k]; }); }); notes.push('欄が欠けている'); }
    else if (kind === 10) { d.booths = pick([null, 'x', 5, {}, [null, 5, 'x', {}, []]]); notes.push('booths が配列でない・中身が変'); }
    else { each(100, b => { Object.keys(b).forEach(k => { if (rnd(100) < 25) b[k] = pick(WEIRD); }); }); notes.push('ぜんぶの欄をでたらめに'); }
  };
  mut.notes = notes;
  return mut;
}

for (const seed of SEEDS) {
  test('サーバーの返事が変な形でも、エラー・真っ白・横はみ出しにならない（種 ' + seed + '）', async ({ page }) => {
    test.setTimeout(120000);
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message + ' @ ' + ((e.stack || '').split('\n')[1] || '').trim()));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|status of 4/.test(m.text())) errs.push('console: ' + m.text()); });
    const mut = mutator(seed);
    await mockGas(page, { mutate: mut });
    await page.addInitScript(() => { localStorage.setItem('kuroko_intro_v1', '1'); });
    const steps = [];
    const visit = async (url, f) => {
      steps.push(url);
      await page.goto(url);
      await page.waitForTimeout(1300);
      if (f) { try { await f(); } catch (e) { errs.push('step: ' + url + ' ' + String(e).slice(0, 160)); } }
      const o = await page.evaluate(() => ({ over: document.documentElement.scrollWidth > innerWidth + 2, n: (typeof S !== 'undefined' && S.booths) ? S.booths.length : -1, blank: document.body.innerText.trim().length < 20 }));
      if (o.over) errs.push('横はみ出し: ' + url);
      if (o.blank) errs.push('真っ白: ' + url);
    };
    await page.setViewportSize({ width: 390, height: 800 });
    await visit('/?tab=map', async () => {
      await page.evaluate(() => { for (const f of [0, 1, 2, 3]) setFloor(f); zoomTo(3, null, null, false); drawFloor._fp = null; drawFloor(S.floor); if (S.booths[0]) openSheet(S.booths[0].id); if (S.booths[1]) sheetStep(1); closeSheet(); });
    });
    await visit('/?tab=list', async () => {
      await page.evaluate(() => { setSort('name'); setSort('free'); setTodoOnly(true); setTodoOnly(false); const q = document.getElementById('q'); q.value = '電'; q.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.waitForTimeout(300);
    });
    await visit('/?tab=stamp', async () => { await page.evaluate(() => { if (S.booths[2] && S.booths[2].id) { stampNow(S.booths[2].id); } }); await page.waitForTimeout(400); });
    await visit('/?tab=info');
    await page.setViewportSize({ width: 1100, height: 900 });
    await visit('/?mode=print');
    await visit('/?mode=pamphlet');
    await visit('/?mode=board');
    await visit('/?mode=report');
    expect([...new Set(errs)].map(e => e.slice(0, 300)).concat(errs.length ? ['壊し方: ' + mut.notes[0]] : [])).toEqual([]);
  });
}
