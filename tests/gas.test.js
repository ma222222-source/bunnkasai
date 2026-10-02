// サーバー（Code.gs）のテスト。Google の代わりに tests/gas-mock.js の模擬で、Code.gs をそのまま動かす。
// 本番のスプレッドシート・GAS には一切つながらない。
// 使い方：cd tests && node --test gas.test.js（npm test にも入っている）
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGas } = require('./gas-mock');

const PASS = 'test-pass-1234';
/** 46ブースが入った新しい環境 */
function fresh(props) {
  const g = loadGas({ props: Object.assign({ ADMIN_PASS: PASS }, props || {}) });
  g.setupR8AndArchiveOthers();
  return g;
}
const booth = (g, id) => g.__get().booths.find(b => b.id === id);
const rowOf = (g, id) => {
  const sh = g.__ss.getSheetByName('ブース');
  const head = sh.data[0].map(h => String(h).toLowerCase());
  const r = sh.data.find((row, i) => i > 0 && String(row[head.indexOf('id')]) === id);
  return r ? Object.fromEntries(head.map((h, i) => [h, r[i]])) : null;
};

test('セットアップ：R8 の46件が入り、GET で返る（版・しきい値・ブースの形）', () => {
  const g = fresh();
  const r = g.__get();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.serverVersion, g.GAS_VERSION);
  assert.strictEqual(r.booths.length, 46);
  assert.deepStrictEqual(r.waitThresholds, { warn: g.WAIT_WARN, busy: g.WAIT_BUSY });
  const b = r.booths.find(x => x.id === '1F-02');
  assert.ok(b && b.name && b.category);
  assert.strictEqual(b.status, '');                 // 係員が触るまでは「情報なし」
  assert.strictEqual(r.notice, null);
});

test('GET はキャッシュから返し、係員の更新でキャッシュが捨てられる', () => {
  const g = fresh();
  g.__get();
  assert.ok(g.__cache.get(g.CACHE_KEY), '1回目でキャッシュに置く');
  // シートを直接書き換えても、キャッシュがあるうちは同じ内容が返る
  const sh = g.__ss.getSheetByName('ブース');
  const nameCol = sh.data[0].indexOf('name');
  sh.data[1][nameCol] = '書き換えた名前';
  assert.notStrictEqual(g.__get().booths[0].name, '書き換えた名前');
  // 係員の更新（書き込み）でキャッシュが捨てられ、次の GET で新しい内容になる
  const r = g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-02', wait: 3 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(g.__get().booths[0].name, '書き換えた名前');
});

test('係員の更新：人数から状態を自動で決め、時刻・履歴を書く', () => {
  const g = fresh();
  const cases = [[0, '空いています'], [g.WAIT_WARN - 1, '空いています'], [g.WAIT_WARN, 'やや混雑'], [g.WAIT_BUSY, '混雑しています']];
  for (const [w, st] of cases) {
    const r = g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: w });
    assert.strictEqual(r.appliedStatus, st, `wait=${w}`);
    const b = booth(g, '1F-03');
    assert.strictEqual(b.status, st);
    assert.strictEqual(b.wait, w);
    assert.ok(b.time);
  }
  const log = g.__ss.getSheetByName('履歴');
  assert.strictEqual(log.getLastRow() - 1, cases.length, '1回ごとに履歴へ1行');
  // 状態だけ指定（人数のキーなし）は人数を触らない
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', status: '準備中' });
  assert.strictEqual(booth(g, '1F-03').status, '準備中');
  assert.strictEqual(booth(g, '1F-03').wait, g.WAIT_BUSY);
});

test('係員の更新：名前やメモの列には触らない（先生の手直しを消さない）', () => {
  const g = fresh();
  const before = rowOf(g, '1F-05');
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-05', wait: 9 });
  const after = rowOf(g, '1F-05');
  for (const k of ['name', 'category', 'floor', 'note', 'dept']) assert.strictEqual(after[k], before[k], k);
});

test('係員の更新：不正な人数・状態・ID は断る', () => {
  const g = fresh();
  for (const w of [-1, 1000, '1e999', 'abc']) {
    const r = g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-02', wait: w });
    assert.strictEqual(r.ok, false, `wait=${w}`);
  }
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-02', status: '閉鎖中' }).ok, false);
  assert.match(g.__post({ action: 'update', pass: PASS, cid: 'c1', id: 'ZZ-99', wait: 1 }).error, /該当するID/);
  assert.strictEqual(g.__post({ action: 'nope', pass: PASS }).ok, false);
  assert.strictEqual(JSON.parse(g.doPost({ postData: { contents: '{壊れた' } }).getContent()).error, 'invalid json');
});

test('パスワード：違えば断る・短い設定は通さない・端末ごとに10回でしばらく締め出す', () => {
  const g = fresh();
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: 'c1' }).ok, true);
  assert.strictEqual(g.__post({ action: 'verify', pass: 'wrong', cid: 'c1' }).error, 'unauthorized');
  assert.strictEqual(g.__post({ action: 'update', pass: 'wrong', cid: 'c1', id: '1F-02', wait: 1 }).error, 'unauthorized');
  for (let i = 0; i < 10; i++) g.__post({ action: 'verify', pass: 'x', cid: 'bad' });
  assert.match(g.__post({ action: 'verify', pass: PASS, cid: 'bad' }).error, /^locked/);
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: 'good' }).ok, true, 'ほかの端末は締め出さない');
  const weak = fresh({ ADMIN_PASS: '1234' });
  assert.match(weak.__post({ action: 'verify', pass: '1234', cid: 'c' }).error, /^weak/);
  const none = loadGas({});
  assert.strictEqual(none.__post({ action: 'verify', pass: 'x', cid: 'c' }).ok, false);
});

test('古い更新は「情報なし」で返す（45分）。準備中はそのまま', () => {
  const g = fresh();
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-07', wait: 3 });
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-08', status: '準備中' });
  const sh = g.__ss.getSheetByName('ブース');
  const head = sh.data[0];
  const old = new Date(Date.now() - (g.STALE_MINUTES + 5) * 60000);
  sh.data.forEach((row, i) => { if (i && ['1F-07', '1F-08'].includes(row[head.indexOf('id')])) row[head.indexOf('time')] = old; });
  g.clearCache_();
  const b7 = booth(g, '1F-07'), b8 = booth(g, '1F-08');
  assert.strictEqual(b7.stale, true);
  assert.strictEqual(b7.status, '');
  assert.strictEqual(b7.wait, null);
  assert.strictEqual(b8.status, '準備中');
});

test('お知らせ：出す・消す。数式は文字のまま入れる。控えに残る', () => {
  const g = fresh();
  const r = g.__post({ action: 'notice', pass: PASS, cid: 'c1', text: '=IMPORTXML("http://x")', level: 'alert' });
  assert.strictEqual(r.ok, true);
  const nt = g.__ss.getSheetByName('お知らせ');
  assert.ok(String(nt.cell(2, 1)).startsWith("'="), 'シートでは数式にならない');
  assert.deepStrictEqual(g.__get().notice.level, 'alert');
  g.__post({ action: 'notice', pass: PASS, cid: 'c1', text: '' });
  assert.strictEqual(g.__get().notice, null);
  assert.strictEqual(g.__ss.getSheetByName('お知らせ履歴').getLastRow() - 1, 2);
});

test('来場者カウント：足し引き・同じ押下（uid）は2回数えない', () => {
  const g = fresh();
  g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 3, uid: 'u1' });
  const dup = g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 3, uid: 'u1' });
  assert.strictEqual(dup.duplicate, true);
  g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: -1, uid: 'u2' });
  assert.strictEqual(g.__get().visitors.today, 2);
  assert.strictEqual(g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 0 }).ok, false);
});

test('ブースの追加・書き換え・削除：数式を無効にし、消した行は控えに移す', () => {
  const g = fresh();
  const r = g.__post({ action: 'upsert', pass: PASS, cid: 'c1', id: '3F-09', name: '+SUM(A1)', category: '展示', floor: 3 });
  assert.strictEqual(r.created, true);
  assert.ok(String(rowOf(g, '3F-09').name).startsWith("'+"));
  assert.strictEqual(g.__post({ action: 'upsert', pass: PASS, cid: 'c1', id: '=bad id', name: 'x' }).ok, false);
  assert.strictEqual(g.__post({ action: 'remove', pass: PASS, cid: 'c1', id: '3F-09' }).removed, 1);
  assert.strictEqual(rowOf(g, '3F-09'), null);
  assert.strictEqual(g.__ss.getSheetByName('削除したブース').getLastRow() >= 2, true);
});

test('一括（開場・閉場）：全ブースの状態を変える', () => {
  const g = fresh();
  const r = g.__post({ action: 'bulk', pass: PASS, cid: 'c1', status: '準備中' });
  assert.strictEqual(r.updated, 46);
  assert.ok(g.__get().booths.every(b => b.status === '準備中'));
});

test('スタンプの控え：追記・同じ獲得は1回・読み出し', () => {
  const g = fresh();
  const cid = 'ABCD2345';
  const r1 = g.__post({ action: 'ledger', cid, ev: [{ t: 's', id: '1F-02', at: Date.now() }, { t: 's', id: '1F-03', at: Date.now() }] });
  assert.strictEqual(r1.added, 2);
  const r2 = g.__post({ action: 'ledger', cid, ev: [{ t: 's', id: '1F-02' }, { t: 's', id: '1F-05' }] });
  assert.strictEqual(r2.added, 1, '同じスタンプは2回記録しない');
  const l = g.__get({ ledger: cid });
  assert.deepStrictEqual(l.stamps.slice().sort(), ['1F-02', '1F-03', '1F-05']);
  assert.strictEqual(g.__post({ action: 'ledger', cid: 'x!', ev: [] }).ok, false, '番号の形が違えば断る');
  assert.strictEqual(g.__post({ action: 'ledger', cid, ev: [{ t: 's', id: '=HACK()' }] }).added, 0, 'ブースidの形でなければ入れない');
});

test('お菓子の交換：同じスタンプでの二重交換を断る（別の端末・つないだ番号でも）', () => {
  const g = fresh();
  const a = 'AAAA1111', b = 'BBBB2222';
  g.__post({ action: 'ledger', cid: a, ev: ['1F-02', '1F-03', '1F-05', '1F-07', '1F-08'].map(id => ({ t: 's', id })) });
  const ok = g.__post({ action: 'redeem', cid: a, ids: ['1F-02', '1F-03', '1F-05', '1F-07', '1F-08'] });
  assert.strictEqual(ok.ok, true);
  const again = g.__post({ action: 'redeem', cid: a, ids: ['1F-02', '1F-03', '1F-05', '1F-07', '1F-08'] });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.error, 'already');
  // 別の番号 b から a へ「つなぐ」と、b で交換しようとしても a の交換済みが見える
  g.__post({ action: 'ledger', cid: b, from: a, ev: [] });
  const viaB = g.__post({ action: 'redeem', cid: a, ids: ['1F-02'] });
  assert.strictEqual(viaB.error, 'already');
  const lb = g.__get({ ledger: b });
  assert.ok(lb.spent.includes('1F-02'), 'つないだ先にも交換済みが写っている');
  assert.strictEqual(g.__post({ action: 'redeem', cid: a, ids: [] }).ok, false);
});

test('見出しの大文字・小文字は区別しない（「ID」と書かれても読める）', () => {
  const g = fresh();
  const sh = g.__ss.getSheetByName('ブース');
  sh.data[0][sh.data[0].indexOf('id')] = 'ID';
  g.clearCache_();
  assert.strictEqual(g.__get().booths.length, 46);
});

test('見出しの id が消えていたら、分かる言葉で知らせる', () => {
  const g = fresh();
  const sh = g.__ss.getSheetByName('ブース');
  sh.data[0][sh.data[0].indexOf('id')] = 'ばんごう';
  g.clearCache_(); g.__cache.clear();
  const r = g.__get();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /見出し/);
});

test('GAS_VERSION は画面の前提（index.html の GAS_MIN）以上', () => {
  const g = loadGas({});
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const min = (html.match(/GAS_MIN:\s*'([^']+)'/) || [])[1];
  assert.ok(g.GAS_VERSION >= min, `${g.GAS_VERSION} < ${min}`);
});
