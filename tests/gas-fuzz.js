'use strict';
// サーバー（Code.gs）に、でたらめな送信を大量に送るための道具（v181）。gas.test.js から使う。
// 公開アドレスなので、誰でも何でも送れる。確かめること：
//   fuzzPosts ：落ちない・返事はいつも JSON で ok（真偽）が付く・パスワードなしではシート（ブース・お知らせ・来場者）が変わらない
//   fuzzLedger：スタンプの控え・お菓子の交換・番号をつなぐ、が「あるべき状態」（小さな手本）といつも一致する（二重交換・取りこぼしなし）
// 本物の Google にはつながらない（gas-mock.js の模擬）
const { loadGas } = require('./gas-mock');

function fuzzPosts(SEED, N) {
const PASS = 'test-pass-1234';
let s = SEED * 6700417; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
const pick = a => a[rnd(a.length)];
const W = [null, undefined, '', ' ', 0, -1, 1e9, 1e999, NaN, '12', 'abc', true, false, [], {}, [1, 2], { a: 1 }, '　', '🎉', 'あ'.repeat(5000), '=1+1', '+SUM(A1)', '@x', '-5', '<b>', '../x', '1F-02', 'ZZ-99', "';--", '\n\r\t', '\u0000', { toString: 1 }, [[[]]], '2026-13-45', 1.5, '１Ｆ－０２'];
const ACT = ['update', 'verify', 'upsert', 'remove', 'notice', 'visitor', 'bulk', 'ledger', 'redeem', 'clientlog', 'nope', '', null, 5, 'UPDATE', 'ledger ', '__proto__', 'constructor'];
const KEYS = ['id', 'wait', 'status', 'name', 'note', 'category', 'floor', 'image', 'dept', 'text', 'level', 'n', 'uid', 'cid', 'ev', 'ids', 'from', 'msg', 'ua', 'build', 'updates', 'at', 'pass', '__proto__', 'constructor', 'length'];
function body(auth) {
  const b = {};
  b.action = rnd(10) < 8 ? pick(ACT.slice(0, 11)) : pick(ACT);
  const nk = rnd(8);
  for (let i = 0; i < nk; i++) { const k = pick(KEYS); try { b[k] = rnd(3) ? pick(W) : pick(['1F-02', '1F-03', 3, '空いています', 'c' + rnd(50), [{ t: 's', id: '1F-02' }, { t: 'r', id: pick(W) }, pick(W)], ['1F-02', pick(W)]]); } catch (e) {} }
  if (auth) b.pass = PASS; else if (rnd(3) === 0) b.pass = pick(W);
  if (rnd(2)) b.cid = pick(['c1', 'c2', 'abcdefgh12345678', pick(W)]);
  return b;
}
const g = loadGas({ props: { ADMIN_PASS: PASS } });
g.setupR8AndArchiveOthers();
const snap = () => JSON.stringify(['ブース', 'お知らせ', '来場者'].map(n => { const sh = g.__ss.getSheetByName(n); return sh ? sh.data : null; }));
const rows = n => { const sh = g.__ss.getSheetByName(n); return sh ? sh.getLastRow() : 0; };
const problems = {}; const add = (k, ex) => { (problems[k] = problems[k] || []).push(ex); };
let before = snap();
for (let i = 0; i < N; i++) {
  const auth = rnd(4) === 0;
  const mode = rnd(10);
  let out, label;
  try {
    if (mode === 0) {       // 生の POST（JSON でないもの・型の違うもの）
      const raw = pick(['', 'null', '[]', '5', '"x"', '{', '{"action":"update"', 'true', '[{"action":"ledger"}]', '{"action":{"a":1}}', 'あ'.repeat(20000), '{"__proto__":{"x":1},"action":"verify"}']);
      label = 'raw ' + raw.slice(0, 40);
      out = g.doPost(pick([{ postData: { contents: raw } }, { postData: null }, {}, null, { postData: { contents: null } }, { postData: { contents: 5 } }]) && { postData: { contents: raw } });
    } else if (mode === 1) { // GET
      const p = {}; const nk = rnd(4);
      for (let k = 0; k < nk; k++) p[pick(['ledger', 'report', 'cid', 'mode', 'pass', 'date', 'x', 'callback'])] = pick(W.filter(x => typeof x === 'string').concat(['abcdefgh12345678', '1', 'c1']));
      label = 'GET ' + JSON.stringify(p).slice(0, 80);
      out = g.doGet(pick([{ parameter: p }, { parameter: p }, {}, { parameter: null }]));
    } else {
      const b = body(auth);
      label = 'POST ' + JSON.stringify(b).slice(0, 160);
      out = g.doPost({ postData: { contents: JSON.stringify(b) } });
      if (!auth) {
        const after = snap();
        // パスワードなしで変わってよいのは、何も無い（ブース・お知らせ・来場者は変わらない）
        if (after !== before && !(b.pass === PASS)) add('パスワードなしでシートが変わった', label);
        before = after;
      } else before = snap();
    }
    let j;
    try { j = JSON.parse(out.getContent()); } catch (e) { add('返事が JSON でない', label + ' → ' + String(out && out.getContent && out.getContent()).slice(0, 80)); continue; }
    if (mode !== 1 && (j === null || typeof j !== 'object' || typeof j.ok !== 'boolean')) add('返事に ok が無い', label + ' → ' + JSON.stringify(j).slice(0, 100));
  } catch (e) { add('例外で落ちた', label + ' → ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ').slice(0, 220)); }
}
// 配信データは、でたらめな送信のあとも正しい形か
try { const r = g.__get(); if (!(r.ok === true && Array.isArray(r.booths) && r.booths.length > 0)) add('最後の GET が壊れた', JSON.stringify(r).slice(0, 120)); } catch (e) { add('最後の GET が例外', String(e).slice(0, 200)); }
return { problems, rows: { ledger: rows('スタンプ記録'), err: rows('エラー記録') } };
}

// スタンプの控え・交換・番号をつなぐ、を乱数で何千回も行い、「あるべき状態」（下の小さな手本）とサーバーの返事を比べる
function fuzzLedger(SEED, N) {
let s = SEED * 6700417; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
const CIDS = Array.from({ length: 12 }, (_, i) => 'CID' + String(10000 + i));
const IDS = ['1F-02', '1F-03', '1F-05', '1F-07', '1F-08', '2F-01', '2F-02', '3F-01', 'X_9', 'a-b'];
const g = loadGas({ props: { ADMIN_PASS: 'test-pass-1234' } });
g.setupR8AndArchiveOthers();
const alias = {}; const st = {};
const res = c => { let n = 0; while (alias[c] && n++ < 50) c = alias[c]; return c; };
const of = c => (st[c] = st[c] || { s: new Set(), r: new Set() });
const bad = []; const add = (k, d) => { if (bad.length < 12) bad.push(k + '：' + d); };
const eq = (a, set) => a.length === set.size && a.every(x => set.has(x));
for (let i = 0; i < N; i++) {
  const op = rnd(10), cid = CIDS[rnd(CIDS.length)];
  try {
    if (op <= 4) {
      const ev = []; const n = rnd(5);
      for (let k = 0; k < n; k++) ev.push({ t: rnd(6) ? 's' : 'r', id: IDS[rnd(IDS.length)] });
      const body = { action: 'ledger', cid, ev };
      let from = null;
      if (rnd(8) === 0) { from = CIDS[rnd(CIDS.length)]; body.from = from; }
      const r = g.__post(body);
      if (!r.ok) { add('ledger が断られた', JSON.stringify(body).slice(0, 120) + ' → ' + JSON.stringify(r).slice(0, 100)); continue; }
      const to = res(cid);
      if (from) { const fr = res(from); if (fr !== to) { of(fr).s.forEach(x => of(to).s.add(x)); of(fr).r.forEach(x => of(to).r.add(x)); alias[fr] = to; } }
      ev.forEach(e => (e.t === 's' ? of(to).s : of(to).r).add(e.id));
      if (r.cid !== to) add('返ってきた番号が違う', `${cid} → ${r.cid}（あるべき ${to}）`);
      if (Array.isArray(r.stamps) && !eq(r.stamps, of(to).s)) add('ledger の返事のスタンプが違う', `#${i} ${to} 返事=${r.stamps.slice().sort()} あるべき=${[...of(to).s].sort()}`);
      if (Array.isArray(r.spent) && !eq(r.spent, of(to).r)) add('ledger の返事の交換済みが違う', `#${i} ${to} 返事=${r.spent.slice().sort()} あるべき=${[...of(to).r].sort()}`);
    } else if (op <= 6) {
      const ids = []; const n = 1 + rnd(4);
      for (let k = 0; k < n; k++) { const id = IDS[rnd(IDS.length)]; if (ids.indexOf(id) < 0) ids.push(id); }
      const r = g.__post({ action: 'redeem', cid, ids });
      const to = res(cid); const used = ids.filter(x => of(to).r.has(x));
      if (used.length) { if (r.ok !== false || r.error !== 'already') add('二重交換が通った', `#${i} ${to} ${ids} 交換済み=${used} → ${JSON.stringify(r).slice(0, 100)}`); }
      else { if (r.ok !== true) add('交換が断られた', `#${i} ${to} ${ids} → ${JSON.stringify(r).slice(0, 100)}`); ids.forEach(x => { of(to).s.add(x); of(to).r.add(x); }); }
    } else {
      const r = g.__get({ ledger: cid }); const to = res(cid);
      if (!r.ok) { add('読み出しが断られた', cid + ' → ' + JSON.stringify(r).slice(0, 100)); continue; }
      if (r.cid !== to) add('読み出しの番号が違う', `${cid} → ${r.cid}（あるべき ${to}）`);
      if (!eq(r.stamps, of(to).s)) add('読み出しのスタンプが違う', `#${i} ${cid}→${to} 返事=${r.stamps.slice().sort()} あるべき=${[...of(to).s].sort()}`);
      if (!eq(r.spent, of(to).r)) add('読み出しの交換済みが違う', `#${i} ${cid}→${to} 返事=${r.spent.slice().sort()} あるべき=${[...of(to).r].sort()}`);
    }
  } catch (e) { add('例外', String(e && e.stack || e).split('\n').slice(0, 2).join(' | ').slice(0, 200)); }
}
return { bad, merged: Object.keys(alias).length };
}

module.exports = { fuzzPosts, fuzzLedger };
