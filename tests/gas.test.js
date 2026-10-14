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
  const g = freshOwner();
  const r = g.__post({ action: 'notice', token: ownerIn(g), text: '=IMPORTXML("http://x")', level: 'alert' });
  assert.strictEqual(r.ok, true);
  const nt = g.__ss.getSheetByName('お知らせ');
  assert.ok(String(nt.cell(2, 1)).startsWith("'="), 'シートでは数式にならない');
  assert.deepStrictEqual(g.__get().notice.level, 'alert');
  g.__post({ action: 'notice', token: ownerIn(g), text: '' });
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
  const g = freshOwner();
  const r = g.__post({ action: 'upsert', token: ownerIn(g), id: '3F-09', name: '+SUM(A1)', category: '展示', floor: 3 });
  assert.strictEqual(r.created, true);
  assert.ok(String(rowOf(g, '3F-09').name).startsWith("'+"));
  assert.strictEqual(g.__post({ action: 'upsert', token: ownerIn(g), id: '=bad id', name: 'x' }).ok, false);
  assert.strictEqual(g.__post({ action: 'remove', token: ownerIn(g), id: '3F-09' }).removed, 1);
  assert.strictEqual(rowOf(g, '3F-09'), null);
  assert.strictEqual(g.__ss.getSheetByName('削除したブース').getLastRow() >= 2, true);
});

test('一括（開場・閉場）：全ブースの状態を変える', () => {
  const g = freshOwner();
  const r = g.__post({ action: 'bulk', token: ownerIn(g), status: '準備中' });
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

/* ---------------- v152：振り返りレポートとピーク時のキャッシュ ---------------- */

test('振り返りレポート：その日の更新・来場者・スタンプを集計する（日付の形も確かめる）', () => {
  const g = fresh();
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-02', wait: 20 });   // 混雑
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-02', wait: 2 });
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 8 });
  g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 5, uid: 'v1' });
  const now = Date.now();
  g.__post({ action: 'ledger', cid: 'PPPP1111', ev: [{ t: 's', id: '1F-02', at: now }, { t: 's', id: '1F-03', at: now }] });
  g.__post({ action: 'ledger', cid: 'QQQQ2222', ev: [{ t: 's', id: '1F-02', at: now + 1 }] });
  const r = g.__get({ report: '1' });
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.ok(r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  assert.ok(r.buckets.length >= 1);
  const b2 = r.booths.find(b => b.id === '1F-02');
  assert.ok(b2, '更新したブースが入る');
  assert.strictEqual(b2.updates, 2);
  assert.strictEqual(b2.stamps, 2);
  assert.strictEqual(r.summary.stampsTotal, 3);
  assert.strictEqual(r.summary.stampPeople, 2);
  assert.strictEqual(r.summary.topStampBooth, b2.name);
  assert.strictEqual(r.summary.visitorsTotal, 5);
  assert.strictEqual(r.summary.totalUpdates, 3);
  // 日付の形が違えば断る（任意の文字でキャッシュを素通りさせない）
  assert.strictEqual(g.__get({ report: '1', date: 'x' }).ok, false);
  // 記録の無い日は空で返す（壊れない）
  const e = g.__get({ report: '1', date: '2020-01-01' });
  assert.strictEqual(e.ok, true);
  assert.deepStrictEqual(e.booths, []);
});

test('振り返りレポート：まだ何も更新が無くても壊れない', () => {
  const g = fresh();
  const r = g.__get({ report: '1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.booths, []);
});

test('ピーク時：作っている最中に来たアクセスには、少し古い控えをすぐ返す', () => {
  const g = fresh();
  g.__get();                                      // 控え（CACHE_BAK）ができる
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-02', wait: 1 });   // 本体のキャッシュが捨てられる
  g.__cache.set(g.CACHE_BUILDING, '1');           // 誰かが作っている最中
  let built = 0;
  const orig = g.buildPayload_;
  g.buildPayload_ = function () { built++; return orig(); };
  const r = g.__get();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(built, 0, '作っている最中は作り直さず控えを返す');
  assert.strictEqual(r.booths.find(b => b.id === '1F-02').wait, null, '控えは更新前の内容');
  g.__cache.delete(g.CACHE_BUILDING);
  assert.strictEqual(g.__get().booths.find(b => b.id === '1F-02').wait, 1, '作り終われば新しい内容');
});

test('ピーク時：作っている間に係員の更新が入ったら、作った結果を本体のキャッシュに置かない', () => {
  const g = fresh();
  const orig = g.buildPayload_;
  let once = true;
  g.buildPayload_ = function () {
    const d = orig();
    // 作っている間に、別の係員が更新した（書き込みの番号が変わる）
    if (once){ once = false; g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 4 }); }
    return d;
  };
  g.__cache.delete(g.CACHE_KEY);
  g.__get();
  assert.strictEqual(g.__cache.get(g.CACHE_KEY), undefined, '古いかもしれない結果は置かない');
  g.buildPayload_ = orig;
  assert.strictEqual(g.__get().booths.find(b => b.id === '1F-03').wait, 4);
});

test('障害時：シートが読めなくても、直前の控えがあればそれを返す', () => {
  const g = fresh();
  g.__get();
  g.__cache.delete(g.CACHE_KEY);
  g.buildPayload_ = () => { throw new Error('Service Spreadsheets timed out'); };
  const r = g.__get();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.booths.length, 46);
});

test('お知らせ・来場者の書き込みもキャッシュを捨てる（すぐ画面に出る）', () => {
  const g = freshOwner();
  g.__get();
  g.__post({ action: 'notice', token: ownerIn(g), text: '雨のため屋外は中止', level: 'info' });
  assert.strictEqual(g.__get().notice.text, '雨のため屋外は中止');
  g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 2, uid: 'x1' });
  assert.strictEqual(g.__get().visitors.today, 2);
});

/* ---------------- v152：本番前の点検（validate） ---------------- */
test('validate：問題なしのときと、出しっぱなしのお知らせ・短めのパスワード・R8との食い違い・タイムゾーンを知らせる', () => {
  const ok = fresh({ ADMIN_PASS: 'long-enough-pass-1' });
  const m0 = ok.validate();
  assert.match(m0, /問題は見つかりませんでした/);
  assert.match(m0, /先読み（warmCache）：止まっています/);
  assert.doesNotMatch(m0, /パスワード/);

  const g = freshOwner({ ADMIN_PASS: 'abcd12345' });                  // 9文字
  g.__post({ action: 'notice', token: ownerIn(g), text: 'テストです', level: 'alert' });
  // シートから1件消し、1件足す（R8 との食い違い）
  g.__post({ action: 'remove', token: ownerIn(g), id: '1F-02' });
  g.__post({ action: 'upsert', token: ownerIn(g), id: '3F-09', name: '追加', category: '展示', floor: 3 });
  g.__ss.getSpreadsheetTimeZone = () => 'America/New_York';
  const m = g.validate();
  assert.match(m, /要確認/);
  assert.match(m, /R8 の一覧にあるのにシートに無いブース：1F-02/);
  assert.match(m, /タイムゾーンが America\/New_York/);
  assert.match(m, /R8 の一覧に無いブースがシートにあります：3F-09/);
  assert.match(m, /お知らせが全員の画面に出ています：「テストです」（重要）/);
  assert.match(m, /8〜11文字/);
});

test('validate：配信データの大きさはバイトで数える（日本語は1文字3バイト）', () => {
  const g = fresh();
  const sh = g.__ss.getSheetByName('ブース');
  const noteCol = sh.data[0].indexOf('note');
  // メモに日本語を詰めて、文字数では 80000 未満・バイトでは 80000 超にする
  sh.data.forEach((row, i) => { if (i) row[noteCol] = 'あ'.repeat(120); });
  const nameCol = sh.data[0].indexOf('name');
  sh.data.forEach((row, i) => { if (i) row[nameCol] = 'い'.repeat(40); });
  for (let i = 0; i < 400; i++) sh.data.push(['9F-' + i, 'う'.repeat(40), '', '', 'ふつう', 1, 'え'.repeat(120)]);
  g.clearCache_();
  const bytes = g.bytes_(JSON.stringify(g.buildPayload_()));
  const chars = JSON.stringify(g.buildPayload_()).length;
  assert.ok(chars < bytes, '日本語ぶんバイトの方が大きい');
  const m = g.validate();
  if (bytes > 80000) assert.match(m, /配信データが大きすぎます/);
  assert.match(m, new RegExp('配信データの大きさ：' + Math.round(bytes / 1024) + 'KB'));
});

test('端末のエラー記録（clientlog）：パスワードなしで1行書く・数式は無効・1分あたりの上限・validate に件数', () => {
  const g = fresh();
  const r = g.__post({ action: 'clientlog', msg: '=HYPERLINK("x")', src: 'index.html', line: 123, build: '2026-10-04d', view: 'map', ua: 'iPhone' });
  assert.strictEqual(r.ok, true);
  const sh = g.__ss.getSheetByName('エラー記録');
  assert.strictEqual(sh.getLastRow(), 2);
  assert.ok(String(sh.cell(2, 4)).startsWith("'="), '数式にならない');
  for (let i = 0; i < 80; i++) g.__post({ action: 'clientlog', msg: 'x' + i });
  assert.ok(sh.getLastRow() - 1 <= g.CLIENT_LOG_RATE_MAX, '1分あたりの上限');
  assert.match(g.validate(), /端末で起きたエラー：今日 \d+件/);
});

/* ---------------- v181：でたらめな送信 ---------------- */
const { fuzzPosts, fuzzLedger } = require('./gas-fuzz');

test('でたらめな送信（3000回×2通り）：落ちない・返事はいつも JSON・パスワードなしではシートが変わらない', () => {
  for (const seed of [1, 2]) {
    const r = fuzzPosts(seed, 3000);
    const msg = Object.keys(r.problems).map(k => `${k}：${r.problems[k].length}件 例）${r.problems[k][0]}`).join(' ／ ');
    assert.deepStrictEqual(Object.keys(r.problems), [], msg);
    assert.ok(r.rows.err <= 61 * 3, 'エラー記録の行数は1分あたりの上限で抑えられる');
  }
});

test('スタンプの控え・交換・番号をつなぐ（乱数で3000回×2通り）：あるべき状態といつも一致（二重交換・取りこぼしなし）', () => {
  for (const seed of [1, 2]) {
    const r = fuzzLedger(seed, 3000);
    assert.deepStrictEqual(r.bad, [], r.bad.join(' ／ '));
    assert.ok(r.merged > 0, '番号をつなぐ操作も入っている');
  }
});

/* ---------------- v213（GAS 2026-10-13a）：サーバーの7つの改善 ---------------- */
/** シートの読み書きを数える（どの範囲を、何行ぶん触ったか） */
function spy(g, name) {
  const sh = g.__ss.getSheetByName(name);
  const log = { reads: [], writes: [] };
  if (!sh) return log;
  const orig = sh.getRange.bind(sh);
  sh.getRange = (a, b, c, d) => {
    const rg = orig(a, b, c, d);
    if (typeof a === 'string') return rg;
    const gv = rg.getValues.bind(rg), sv = rg.setValues.bind(rg), s1 = rg.setValue.bind(rg);
    rg.getValues = () => { log.reads.push([a, b, c || 1, d || 1]); return gv(); };
    rg.setValues = v => { log.writes.push([a, b, c || 1, d || 1]); return sv(v); };
    rg.setValue = v => { log.writes.push([a, b, 1, 1]); return s1(v); };
    return rg;
  };
  return log;
}

test('①推移（履歴）は90秒おぼえておく：係員の更新のたびに履歴シートを読み直さない。手で直したら（onEdit）読み直す', () => {
  const g = fresh();
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 3 });
  const log = spy(g, '履歴');
  const r1 = g.__get();
  assert.strictEqual(log.reads.length, 1, '1回目は履歴シートを読む');
  assert.strictEqual(r1.booths.find(b => b.id === '1F-03').history.length, 1);
  assert.ok(g.__cache.get(g.CACHE_HIST), '推移を覚えた');
  // 係員の更新 → 配信データは作り直すが、履歴シートは読まない（推移は覚えたものを使う）
  for (let i = 0; i < 5; i++) {
    g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-05', wait: 10 + i });
    const r = g.__get();
    assert.strictEqual(r.booths.find(b => b.id === '1F-05').wait, 10 + i, '待ち人数そのものは、更新の直後に出る');
  }
  assert.strictEqual(log.reads.length, 1, '5回作り直しても、履歴シートは読み直していない');
  // シートを手で直した（onEdit）→ 覚えたものを捨てて、読み直す
  g.onEdit({});
  assert.strictEqual(g.__cache.get(g.CACHE_HIST) || null, null);
  const r2 = g.__get();
  assert.strictEqual(log.reads.length, 2);
  assert.strictEqual(r2.booths.find(b => b.id === '1F-05').history.length, 5);
  // キャッシュが壊れていても、落ちずに読み直す
  g.__cache.set(g.CACHE_HIST, '{壊れた');
  g.__cache.delete(g.CACHE_KEY);
  assert.strictEqual(g.__get().ok, true);
});

test('②来場者数は2分おぼえておく：配信データを作り直すたびに全行を読まない。受付が押したら・手で直したら数え直す', () => {
  const g = fresh();
  g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 3, uid: 'u1' });
  const log = spy(g, '来場者');
  const reads2 = () => log.reads.filter(r => r[3] === 2).length;      // 集計の読み（2列ぶん）
  assert.strictEqual(g.__get().visitors.today, 3);
  const n0 = reads2();
  for (let i = 0; i < 4; i++) { g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-05', wait: i }); assert.strictEqual(g.__get().visitors.today, 3); }
  assert.strictEqual(reads2(), n0, '係員の更新で作り直しても、来場者シートは数え直さない');
  // 受付が押した → すぐ数え直した値が返り、次の GET にも出る
  const r = g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 2, uid: 'u2' });
  assert.strictEqual(r.visitors.today, 5);
  assert.strictEqual(g.__get().visitors.today, 5);
  // シートを手で直した（打ち間違いを消した）→ onEdit で数え直す
  const sh = g.__ss.getSheetByName('来場者');
  sh.data[sh.getLastRow() - 1][1] = 20;
  g.onEdit({});
  assert.strictEqual(g.__get().visitors.today, 23);
});

test('③1つのブースの更新は、その行だけを書く（ほかの行を書き戻さない）。列の並びが違っても・一括のときも正しい', () => {
  const g = freshOwner();
  const sh = g.__ss.getSheetByName('ブース');
  const head = sh.data[0].map(h => String(h).toLowerCase());
  const rowIdx = sh.data.findIndex((r, i) => i > 0 && String(r[head.indexOf('id')]) === '1F-03') + 1;
  const log = spy(g, 'ブース');
  const r = g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 7 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  // 書いたのは、その行だけ（status と time はとなりの列なので1回・wait で1回）
  assert.ok(log.writes.length >= 1 && log.writes.length <= 3, JSON.stringify(log.writes));
  for (const w of log.writes) { assert.strictEqual(w[0], rowIdx, '書いた行'); assert.strictEqual(w[2], 1, '1行ぶんだけ'); }
  const row = rowOf(g, '1F-03');
  assert.strictEqual(row.status, 'やや混雑'); assert.strictEqual(row.wait, 7); assert.ok(row.time instanceof Date);
  // 待ち人数を消す（3段階のボタンだけで更新）
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', status: '空いています', wait: null });
  assert.strictEqual(rowOf(g, '1F-03').wait, '');
  assert.strictEqual(rowOf(g, '1F-03').status, '空いています');
  // ほかの行は触っていない
  assert.strictEqual(rowOf(g, '1F-05').status, '');
  // 一括（全部のブース）は、これまでどおり列でまとめて書く
  log.writes.length = 0;
  const b = g.__post({ action: 'bulk', token: ownerIn(g), status: '準備中' });
  assert.strictEqual(b.updated, 46);
  assert.ok(log.writes.some(w => w[2] === 46), '一括は列ごとに1回');
  assert.strictEqual(rowOf(g, '1F-05').status, '準備中');
  // 列の並びが違う（time が status のとなりでない）シートでも、正しい列に書く
  const g2 = fresh();
  const sh2 = g2.__ss.getSheetByName('ブース');
  const h2 = sh2.data[0].map(h => String(h).toLowerCase()), ti = h2.indexOf('time'), ni = h2.indexOf('note');
  sh2.data.forEach(rw => { while (rw.length <= Math.max(ti, ni)) rw.push(''); const t = rw[ti]; rw[ti] = rw[ni]; rw[ni] = t; });   // time と note の列を入れ替える
  const r2 = g2.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 20 });
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  const row2 = rowOf(g2, '1F-03');
  assert.strictEqual(row2.status, '混雑しています'); assert.ok(row2.time instanceof Date); assert.strictEqual(row2.wait, 20);
  assert.ok(!(row2.note instanceof Date), 'note の列に時刻を書いていない');
  assert.strictEqual(booth(g2, '1F-03').wait, 20);
});

test('④lastUpdate：係の人がいちばん最近に更新した時刻を返す（だれも更新していなければ null。updatedAt とは別）', () => {
  const g = fresh();
  const r0 = g.__get();
  assert.strictEqual(r0.lastUpdate, null);
  assert.ok(r0.updatedAt);
  g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 3 });
  const r1 = g.__get();
  assert.ok(r1.lastUpdate, 'ある');
  assert.strictEqual(r1.lastUpdate, r1.booths.find(b => b.id === '1F-03').time);
  // 40分前の更新だけのとき：updatedAt は今、lastUpdate は40分前
  const sh = g.__ss.getSheetByName('ブース');
  const head = sh.data[0].map(h => String(h).toLowerCase());
  const row = sh.data.find((rw, i) => i > 0 && String(rw[head.indexOf('id')]) === '1F-03');
  row[head.indexOf('time')] = new Date(Date.now() - 40 * 60000);
  g.onEdit({});
  const r2 = g.__get();
  assert.ok(Math.abs(Date.now() - Date.parse(r2.updatedAt)) < 5000);
  assert.ok(Math.abs(Date.now() - 40 * 60000 - Date.parse(r2.lastUpdate)) < 5000);
  // 打ち間違いの未来の時刻（5分以上先）は数えない
  row[head.indexOf('time')] = new Date(Date.now() + 3 * 3600000);
  g.onEdit({});
  assert.strictEqual(g.__get().lastUpdate, null);
});

test('⑤エラーの文：先頭の合図（英語）はそのまま、うしろに何を直せばよいかを日本語で付ける', () => {
  const g = freshOwner();
  const err = b => g.__post(b).error;
  assert.match(err({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 5000 }), /^bad wait: .*0〜999/);
  assert.match(err({ action: 'update', pass: PASS, cid: 'c1', wait: 3 }), /^bad request: .*id/);
  assert.match(err({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03' }), /^bad request: .*空いています/);
  assert.match(err({ action: 'upsert', token: ownerIn(g), id: '=1+1', name: 'x' }), /^bad request: .*1F-02/);
  assert.match(err({ action: 'visitor', pass: PASS, cid: 'c1', n: 0 }), /^bad count: /);
  assert.match(err({ action: 'なにか', pass: PASS }), /^unknown action: .*2026-/);
  assert.match(err({ action: 'ledger', cid: '!!', ev: [] }), /^bad cid: /);
  assert.match(err({ action: 'redeem', cid: 'abcd1234', ids: [] }), /^bad request: /);
  // 画面が見分けに使っている合図は変わっていない
  assert.strictEqual(err({ action: 'update', pass: 'ちがう', cid: 'c9', id: '1F-03', wait: 1 }), 'unauthorized');
  assert.strictEqual(JSON.parse(g.doPost({ postData: { contents: '{壊れた' } }).getContent()).error, 'invalid json');
  // 中身が入れ物（{…}）でない送信も、落ちずに断る
  for (const c of ['null', '7', '"x"', '[1,2]']) assert.strictEqual(JSON.parse(g.doPost({ postData: { contents: c } }).getContent()).ok, false, c);
});

test('⑥とても大きい送信は、読む前に断る（正しい送信でいちばん大きいスタンプの控え 400件は通る）', () => {
  const g = fresh();
  const big = JSON.stringify({ action: 'clientlog', msg: 'x'.repeat(g.POST_MAX_CHARS + 10) });
  const r = JSON.parse(g.doPost({ postData: { contents: big } }).getContent());
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /^too large/);
  assert.strictEqual(g.__ss.getSheetByName('エラー記録'), null, 'シートには何も書いていない');
  // スタンプの控え：400件（上限いっぱい）でも通る
  const ev = Array.from({ length: 400 }, (_, i) => ({ t: 's', id: 'X' + String(i).padStart(3, '0'), at: Date.now() - i * 1000 }));
  const body = JSON.stringify({ action: 'ledger', cid: 'abcd1234', ev });
  assert.ok(body.length < g.POST_MAX_CHARS, '400件は上限より小さい（' + body.length + '字）');
  const ok = JSON.parse(g.doPost({ postData: { contents: body } }).getContent());
  assert.strictEqual(ok.ok, true, JSON.stringify(ok).slice(0, 200));
  assert.strictEqual(ok.added, 400);
});

test('⑦validate：長すぎて画面で切れる名前・メモを知らせる（直さなくても動くので「参考」に出す）', () => {
  const g = fresh();
  assert.doesNotMatch(g.validate(), /40字を超えています/);
  const sh = g.__ss.getSheetByName('ブース');
  const head = sh.data[0].map(h => String(h).toLowerCase());
  sh.data[1][head.indexOf('name')] = 'とても長いブースの名前'.repeat(5);       // 55字
  sh.data[2][head.indexOf('note')] = 'メモ'.repeat(70);                        // 140字
  const m = g.validate();
  assert.match(m, /A2: name が40字を超えています/);
  assert.match(m, /A3: note が120字を超えています/);
  assert.ok(m.indexOf('【参考】') >= 0 && m.indexOf('【参考】') < m.indexOf('A2: name が40字'), '参考の欄に出る');
  // 画面に出る名前は、これまでどおり40字で切れる
  g.onEdit({});
  assert.strictEqual(g.__get().booths.find(b => b.name.startsWith('とても長い')).name.length, 41);
});

/* ---------------- v216（GAS 2026-10-14a）：司令塔（持ち主だけ）— 持ち主パスワード・パスキー・端末の承認・係員のパスワードの変更 ---------------- */
const nodeCrypto = require('crypto');
const OWNER = 'owner-himitsu-123456';                          // テスト用の持ち主パスワード（本物ではない）
const ORIGIN_T = 'http://localhost:4173';
const DEV_A = 'devaaaaaaaaaaaa01', DEV_B = 'devbbbbbbbbbbbb02', DEV_C = 'devcccccccccccc03';
const freshOwner = props => fresh(Object.assign({ OWNER_PASS: OWNER, OWNER_ORIGINS: ORIGIN_T }, props || {}));
const ownerIn = g => { const r = g.__post({ action: 'owner_login', opass: OWNER, cid: DEV_A }); assert.strictEqual(r.ok, true, JSON.stringify(r)); return r.token; };
const b64uT = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** パスキーを持った端末のまね（Node の暗号で、本物の認証器と同じ形の返事を作る） */
function fakeAuthenticator(rp, origin) {
  const sha = b => nodeCrypto.createHash('sha256').update(b).digest();
  const cborEnc = v => {
    const head = (major, len) => len < 24 ? Buffer.from([(major << 5) | len]) : len < 256 ? Buffer.from([(major << 5) | 24, len]) : Buffer.from([(major << 5) | 25, len >> 8, len & 255]);
    if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
    if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
    return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEnc(k), cborEnc(x)])]);
  };
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = nodeCrypto.randomBytes(20);
  let count = 0;
  const authData = (flags, withKey) => {
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++count);
    const base = Buffer.concat([sha(Buffer.from(rp)), Buffer.from([flags]), cnt]);
    if (!withKey) return base;
    const cose = cborEnc(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
    return Buffer.concat([base, nodeCrypto.randomBytes(16), len, credId, cose]);
  };
  return {
    id: b64uT(credId),
    create(ch, o = {}) {
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ch, origin: o.origin || origin, crossOrigin: false }));
      const att = cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(o.flags == null ? 0x45 : o.flags, true)]]));
      return { clientDataJSON: b64uT(cd), attestationObject: b64uT(att) };
    },
    get(ch, o = {}) {
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ch, origin: o.origin || origin, crossOrigin: false }));
      const ad = authData(o.flags == null ? 0x05 : o.flags, false);
      const sig = nodeCrypto.sign('sha256', Buffer.concat([ad, sha(cd)]), o.key || privateKey);
      return { id: b64uT(credId), clientDataJSON: b64uT(cd), authenticatorData: b64uT(ad), signature: b64uT(sig) };
    },
  };
}

test('司令塔：持ち主パスワード（OWNER_PASS）が無い・短い・係員のパスワードと同じ、のあいだは、だれも入れない', () => {
  for (const [props, why] of [[{}, 'unset'], [{ OWNER_PASS: 'mijikai' }, 'weak'], [{ OWNER_PASS: PASS }, 'same']]) {
    const g = fresh(props);
    const info = g.__post({ action: 'owner_info' });
    assert.deepStrictEqual([info.ok, info.ready, info.why, info.hasKeys], [true, false, why, false]);
    const r = g.__post({ action: 'owner_login', opass: props.OWNER_PASS || '', cid: DEV_A });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /^owner (unset|weak): /);
    assert.strictEqual(g.__post({ action: 'owner_ch' }).ok, false);
    for (const a of ['owner_state', 'owner_set_pass', 'owner_mode', 'owner_dev', 'owner_reg_ch', 'owner_reg', 'owner_key_del'])
      assert.match(g.__post({ action: a, token: 'a'.repeat(64), pass: 'atarashii-pass-1', on: true }).error, /^owner session/, a);
    // 係員の入り方は、今までどおり
    assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: DEV_B }).ok, true);
  }
});

test('司令塔：持ち主パスワードで入る。違えば入れず、5回つづくと止まる。入った印が無い・違う操作は受けない。返事にパスワードは入れない', () => {
  const g = freshOwner();
  assert.strictEqual(g.__post({ action: 'owner_info' }).ready, true);
  assert.strictEqual(g.__post({ action: 'owner_login', opass: PASS, cid: DEV_A }).error, 'unauthorized');       // 係員のパスワードでは入れない
  const token = ownerIn(g);
  assert.match(token, /^[a-f0-9]{64}$/);
  const st = g.__post({ action: 'owner_state', token });
  assert.strictEqual(st.ok, true);
  assert.deepStrictEqual([st.approval, st.devices.length, st.keys.length, st.passLen], [false, 0, 0, PASS.length]);
  const all = JSON.stringify(st) + JSON.stringify(g.__post({ action: 'owner_login', opass: OWNER, cid: DEV_A }));
  assert.ok(!all.includes(PASS) && !all.includes(OWNER), '返事にパスワードそのものが入っていない');
  // 印が無い・でたらめ・出たあと
  assert.match(g.__post({ action: 'owner_state' }).error, /^owner session/);
  assert.match(g.__post({ action: 'owner_state', token: 'b'.repeat(64) }).error, /^owner session/);
  assert.match(g.__post({ action: 'owner_state', token: { $ne: 1 } }).error, /^owner session/);
  assert.strictEqual(g.__post({ action: 'owner_logout', token }).ok, true);
  assert.match(g.__post({ action: 'owner_state', token }).error, /^owner session/);
  // 5回つづけて違う → その端末は止まる（正しくても入れない）。ほかの端末は入れる
  for (let i = 0; i < 5; i++) assert.strictEqual(g.__post({ action: 'owner_login', opass: 'chigau-' + i, cid: DEV_B }).error, 'unauthorized');
  assert.match(g.__post({ action: 'owner_login', opass: OWNER, cid: DEV_B }).error, /^locked/);
  assert.strictEqual(g.__post({ action: 'owner_login', opass: OWNER, cid: DEV_C }).ok, true);
  // 知らない操作
  assert.match(g.__post({ action: 'owner_nanika', token: ownerIn(g) }).error, /^unknown action/);
});

test('司令塔：係員のパスワードを変える。変えた瞬間から古いものは通らない。短い・全角・持ち主と同じものは断る。記録にパスワードは残さない', () => {
  const g = freshOwner();
  const token = ownerIn(g);
  const NEW = 'atarashii-pass-2026';
  for (const [bad, re] of [['short', /bad pass/], ['ｚｅｎｋａｋｕ－ｐａｓｓ', /bad pass/], [' mae-ni-kuuhaku-12', /bad pass/], [OWNER, /bad pass/], ['x'.repeat(65), /bad pass/]])
    assert.match(g.__post({ action: 'owner_set_pass', token, pass: bad }).error, re, bad);
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 1 }).ok, true);
  const r = g.__post({ action: 'owner_set_pass', token, pass: NEW });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.passLen, NEW.length);
  assert.ok(r.passAt);
  assert.ok(!JSON.stringify(r).includes(NEW));
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 2 }).error, 'unauthorized');   // 古いパスワード
  assert.strictEqual(g.__post({ action: 'update', pass: NEW, cid: DEV_B, id: '1F-03', wait: 2 }).ok, true);
  assert.strictEqual(g.__post({ action: 'verify', pass: NEW, cid: DEV_C }).ok, true);
  // 係員のパスワードでは、司令塔の操作はできない
  assert.match(g.__post({ action: 'owner_set_pass', pass: 'nottori-pass-9999', token: NEW }).error, /^owner session/);
  const log = JSON.stringify(g.__ss.getSheetByName('司令塔の記録').data);
  assert.ok(log.includes('係員のパスワードを変えた') && !log.includes(NEW) && !log.includes(PASS));
});

test('司令塔：端末（承認制が切＝はじめの状態）。入った端末が一覧に出る。止めた端末だけ入れない。とても古い画面（端末の番号なし）は今までどおり', () => {
  const g = freshOwner();
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: DEV_A, who: '受付のiPad' }).ok, true);
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: DEV_B }).ok, true);
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 1 }).ok, true);           // 短い番号（古い画面）
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, id: '1F-03', wait: 1 }).ok, true);                      // 番号なし
  assert.strictEqual(g.__post({ action: 'verify', pass: 'chigau', cid: DEV_C }).error, 'unauthorized');              // パスワードが違う端末は、一覧に入れない
  const token = ownerIn(g);
  let st = g.__post({ action: 'owner_state', token });
  assert.deepStrictEqual(st.devices.map(d => [d.cid, d.st, d.label]), [[DEV_A, 'seen', '受付のiPad'], [DEV_B, 'seen', '']]);
  assert.match(st.devices[0].code, /^[0-9A-F]{4}$/);
  assert.ok(st.devices[0].last);
  // 止める → その端末だけ入れない（ログインも、更新も）
  st = g.__post({ action: 'owner_dev', token, cid: DEV_B, st: 'no' });
  assert.strictEqual(st.devices[1].st, 'no');
  assert.match(g.__post({ action: 'verify', pass: PASS, cid: DEV_B }).error, /^denied: /);
  assert.match(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 5 }).error, /^denied: /);
  assert.strictEqual(rowOf(g, '1F-03').wait, 1, '止めた端末の更新は、シートに入っていない');
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_A, id: '1F-03', wait: 6 }).ok, true);
  // 戻す・名前を付ける・消す
  g.__post({ action: 'owner_dev', token, cid: DEV_B, st: 'ok' });
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 7 }).ok, true);
  st = g.__post({ action: 'owner_dev', token, cid: DEV_B, st: 'label', label: '=電子科A' });
  assert.strictEqual(st.devices[1].label.replace(/^'/, ''), '=電子科A');      // 本物のシートは、読むとき先頭の ' を外す（模擬は付いたまま）
  assert.ok(String(g.__ss.getSheetByName('係員の端末').cell(3, 3)).startsWith("'="), 'シートでは数式にならない');
  st = g.__post({ action: 'owner_dev', token, cid: DEV_A, st: 'del' });
  assert.deepStrictEqual(st.devices.map(d => d.cid), [DEV_B]);
  assert.match(g.__post({ action: 'owner_dev', token, cid: DEV_C, st: 'ok' }).error, /^bad request/);
  assert.match(g.__post({ action: 'owner_dev', token, cid: DEV_B, st: 'admin' }).error, /^bad request/);
});

test('司令塔：端末の承認制を入れる。入ったことがある端末はそのまま（締め出さない）、新しい端末は許可を待つ。許可・切に戻す', () => {
  const g = freshOwner();
  g.__post({ action: 'verify', pass: PASS, cid: DEV_A });
  const token = ownerIn(g);
  let st = g.__post({ action: 'owner_mode', token, on: true, keep: true });
  assert.strictEqual(st.approval, true);
  assert.deepStrictEqual(st.devices.map(d => [d.cid, d.st]), [[DEV_A, 'ok']]);
  // 当番の端末：そのまま使える
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_A, id: '1F-03', wait: 3 }).ok, true);
  // 新しい端末：パスワードが合っていても、許可を待つ。番号（4文字）が返る
  const p = g.__post({ action: 'verify', pass: PASS, cid: DEV_B, who: 'でんしか たろう' });
  assert.strictEqual(p.ok, false);
  const m = /^pending:([0-9A-F]{4}): /.exec(p.error);
  assert.ok(m, p.error);
  assert.match(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 9 }).error, /^pending:/);
  assert.strictEqual(rowOf(g, '1F-03').wait, 3);
  // パスワードが違えば、待ちの一覧にも入らない
  assert.strictEqual(g.__post({ action: 'verify', pass: 'chigau', cid: DEV_C }).error, 'unauthorized');
  st = g.__post({ action: 'owner_state', token });
  assert.deepStrictEqual(st.devices.map(d => [d.cid, d.st]), [[DEV_A, 'ok'], [DEV_B, 'wait']]);
  assert.strictEqual(st.devices[1].code, m[1]);                 // 待っている画面に出る番号と、一覧の番号が同じ
  assert.strictEqual(st.devices[1].label, 'でんしか たろう');
  // 端末の番号が無い送信は、承認制のあいだは受けない
  assert.match(g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 9 }).error, /^denied: /);
  // 許可する → 入れる
  g.__post({ action: 'owner_dev', token, cid: DEV_B, st: 'ok' });
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: DEV_B }).ok, true);
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 4 }).ok, true);
  // 止める → 入れない。承認制を切に戻しても、止めた端末は入れない。ほかは、また共通のパスワードだけで入れる
  g.__post({ action: 'owner_dev', token, cid: DEV_B, st: 'no' });
  assert.match(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 5 }).error, /^denied: /);
  st = g.__post({ action: 'owner_mode', token, on: false });
  assert.strictEqual(st.approval, false);
  assert.match(g.__post({ action: 'verify', pass: PASS, cid: DEV_B }).error, /^denied: /);
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: DEV_C }).ok, true);
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 8 }).ok, true);
  // keep なしで入れる：入ったことがある端末（seen）も、許可を待つ
  st = g.__post({ action: 'owner_mode', token, on: true });
  assert.match(g.__post({ action: 'verify', pass: PASS, cid: DEV_C }).error, /^pending:/);
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_A, id: '1F-03', wait: 2 }).ok, true);   // 前に許可した端末は、そのまま
});

test('司令塔：パスキー（顔認証・指紋）の登録とログイン。登録は入っている人だけ。署名が違う・使い回し・別のサイト・別の鍵は通らない', () => {
  const g = freshOwner();
  const A = fakeAuthenticator('localhost', ORIGIN_T);
  // まだ登録が無い
  assert.match(g.__post({ action: 'owner_ch' }).error, /^owner nokeys/);
  // 登録は、司令塔に入っている人だけ
  assert.match(g.__post({ action: 'owner_reg_ch' }).error, /^owner session/);
  const token = ownerIn(g);
  const rc = g.__post({ action: 'owner_reg_ch', token });
  assert.strictEqual(rc.rpId, 'localhost');
  // 別のサイトで作った返事・本人の確かめなし は登録できない
  assert.strictEqual(g.__post(Object.assign({ action: 'owner_reg', token, chId: rc.chId, label: 'x' }, A.create(rc.ch, { origin: 'https://evil.example' }))).ok, false);
  const rc2 = g.__post({ action: 'owner_reg_ch', token });
  assert.strictEqual(g.__post(Object.assign({ action: 'owner_reg', token, chId: rc2.chId }, A.create(rc2.ch, { flags: 0x41 }))).ok, false);
  const rc3 = g.__post({ action: 'owner_reg_ch', token });
  const reg = g.__post(Object.assign({ action: 'owner_reg', token, chId: rc3.chId, label: 'わたしの iPhone' }, A.create(rc3.ch)));
  assert.strictEqual(reg.ok, true, JSON.stringify(reg));
  assert.deepStrictEqual(reg.keys.map(k => [k.id, k.label]), [[A.id, 'わたしの iPhone']]);
  assert.ok(!JSON.stringify(reg).includes('"x"'), '返事に鍵の中身を入れない');
  // 同じ合言葉は2回使えない
  assert.match(g.__post(Object.assign({ action: 'owner_reg', token, chId: rc3.chId }, A.create(rc3.ch))).error, /^bad challenge/);
  assert.strictEqual(g.__post({ action: 'owner_info' }).hasKeys, true);
  // ログイン
  const ch = g.__post({ action: 'owner_ch' });
  assert.deepStrictEqual(ch.ids, [A.id]);
  const resp = A.get(ch.ch);
  const ok = g.__post(Object.assign({ action: 'owner_assert', chId: ch.chId }, resp));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(g.__post({ action: 'owner_state', token: ok.token }).ok, true);
  // 同じ返事の使い回し（合言葉は1回だけ）
  assert.strictEqual(g.__post(Object.assign({ action: 'owner_assert', chId: ch.chId }, resp)).ok, false);
  // 通らないもの：別の鍵での署名・別のサイト・本人の確かめなし・知らない鍵のID・こわれた中身
  const B = fakeAuthenticator('localhost', ORIGIN_T);
  const tries = [
    c => Object.assign(B.get(c.ch), { id: A.id }),
    c => A.get(c.ch, { origin: 'https://evil.example' }),
    c => A.get(c.ch, { flags: 0x01 }),
    c => Object.assign(A.get(c.ch), { id: B.id }),
    c => Object.assign(A.get(c.ch), { signature: 'AAAA' }),
    c => Object.assign(A.get(c.ch), { authenticatorData: '' }),
    c => ({ id: A.id }),
  ];
  for (const [i, mk] of tries.entries()) {
    const c = g.__post({ action: 'owner_ch' });
    const r = g.__post(Object.assign({ action: 'owner_assert', chId: c.chId }, mk(c)));
    assert.strictEqual(r.ok, false, '通ってはいけない ' + i);
    assert.strictEqual(r.error, 'unauthorized', '何が合わなかったかは教えない ' + i);
    assert.ok(!r.token);
  }
  // そのあとも、正しい端末は入れる（回数が進んでいる）
  const c9 = g.__post({ action: 'owner_ch' });
  assert.strictEqual(g.__post(Object.assign({ action: 'owner_assert', chId: c9.chId }, A.get(c9.ch))).ok, true);
  // 消すと、入れない
  const left = g.__post({ action: 'owner_key_del', token, id: A.id });
  assert.strictEqual(left.keys.length, 0);
  assert.match(g.__post({ action: 'owner_ch' }).error, /^owner nokeys/);
  // 持ち主パスワードを消す（プロパティから外す）と、入っていた印も使えなくなる
  g.__props.OWNER_PASS = '';
  assert.match(g.__post({ action: 'owner_state', token }).error, /^owner session/);
});

test('司令塔：でたらめな送信（2000回）で落ちない・入れない・係員のパスワードや承認の設定が変わらない', () => {
  const g = freshOwner();
  let s = 12345; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const acts = ['owner_info', 'owner_login', 'owner_ch', 'owner_assert', 'owner_state', 'owner_set_pass', 'owner_mode', 'owner_dev', 'owner_reg_ch', 'owner_reg', 'owner_key_del', 'owner_logout', 'owner_x'];
  const junk = () => [null, 0, 1, true, '', 'a', 'a'.repeat(64), '{}', [], {}, { a: 1 }, 'ｚ', -1, 1e9, nodeCrypto.randomBytes(rnd(40)).toString('base64url')][rnd(15)];
  for (let i = 0; i < 2000; i++) {
    const body = { action: acts[rnd(acts.length)] };
    for (const k of ['token', 'opass', 'cid', 'pass', 'on', 'keep', 'st', 'id', 'chId', 'clientDataJSON', 'authenticatorData', 'attestationObject', 'signature', 'label']) if (rnd(3)) body[k] = junk();
    const out = g.doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
    const r = JSON.parse(out);
    assert.ok(r && typeof r === 'object', out.slice(0, 80));
    assert.ok(!r.token, '入れてはいけない：' + JSON.stringify(body).slice(0, 120));
    if (body.action !== 'owner_info') assert.strictEqual(r.ok, false, JSON.stringify(body).slice(0, 120) + ' → ' + out.slice(0, 120));
  }
  assert.strictEqual(g.__props.ADMIN_PASS, PASS);
  assert.ok(!g.__props.APPROVAL && !g.__props.OWNER_KEYS);
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: DEV_A }).ok, true);
});

test('司令塔：端末の一覧がいっぱいでも、承認制が切のあいだは係員が入れる（記録しないだけ）。承認制のときは、消すまで新しい端末を受けない', () => {
  const g = freshOwner();
  const sh0 = (g.__post({ action: 'verify', pass: PASS, cid: DEV_A }), g.__ss.getSheetByName('係員の端末'));
  for (let i = 0; i < g.DEVICE_MAX; i++) sh0.appendRow(['fill' + String(i).padStart(12, '0'), 'seen', '', new Date(), new Date(), 'FFFF']);
  const n0 = sh0.getLastRow();
  assert.strictEqual(g.__post({ action: 'verify', pass: PASS, cid: DEV_B }).ok, true);
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_B, id: '1F-03', wait: 2 }).ok, true);
  assert.strictEqual(sh0.getLastRow(), n0, '一覧は増えていない');
  const token = ownerIn(g);
  g.__post({ action: 'owner_mode', token, on: true, keep: true });
  assert.match(g.__post({ action: 'verify', pass: PASS, cid: DEV_C }).error, /^busy: /);
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: DEV_A, id: '1F-03', wait: 3 }).ok, true);   // 許可ずみの端末は使える
});

/* ---------------- v219：本部・準備の操作は持ち主だけ ／ 司令塔だけのイベント ---------------- */
test('v219：お知らせ・一括・ブースの追加と削除は、係員のパスワードでは通らない（司令塔に入っている印が要る）。更新・受付は今までどおり', () => {
  const g = freshOwner();
  const before = JSON.stringify(g.__ss.getSheetByName('混雑状況') ? g.__ss.getSheetByName('混雑状況').data : g.__get().booths);
  for (const body of [
    { action: 'notice', text: 'いたずら', level: 'alert' }, { action: 'bulk', status: '準備中' },
    { action: 'upsert', id: '3F-09', name: 'にせもの', category: '展示', floor: 3 }, { action: 'remove', id: '1F-02' }]) {
    const r = g.__post(Object.assign({ pass: PASS, cid: 'c1' }, body));
    assert.strictEqual(r.ok, false, body.action);
    assert.match(r.error, /^owner only: .*司令塔/, body.action);
    // にせの印・形の合わない印でも通らない
    assert.match(g.__post(Object.assign({ token: 'a'.repeat(64) }, body)).error, /^owner session/, body.action);
    assert.match(g.__post(Object.assign({ pass: PASS, token: 'x' }, body)).error, /^owner session/, body.action);
  }
  assert.strictEqual(g.__get().notice, null);
  assert.strictEqual(booth(g, '1F-02').name, '旋盤の加工実演');
  assert.strictEqual(g.__get().booths.length, 46);
  assert.strictEqual(JSON.stringify(g.__ss.getSheetByName('混雑状況') ? g.__ss.getSheetByName('混雑状況').data : g.__get().booths), before);
  // 係員のパスワードで、更新と受付はできる
  assert.strictEqual(g.__post({ action: 'update', pass: PASS, cid: 'c1', id: '1F-02', wait: 3 }).ok, true);
  assert.strictEqual(g.__post({ action: 'visitor', pass: PASS, cid: 'c1', n: 1, uid: 'u219' }).ok, true);
  // 司令塔から出たあとの印は使えない
  const t = ownerIn(g);
  assert.strictEqual(g.__post({ action: 'notice', token: t, text: '本部から', level: 'info' }).ok, true);
  g.__post({ action: 'owner_logout', token: t });
  assert.match(g.__post({ action: 'notice', token: t, text: 'もう一度' }).error, /^owner session/);
  assert.strictEqual(g.__get().notice.text, '本部から');
  // 持ち主パスワードが無い環境では、だれも出せない
  const g0 = fresh();
  assert.match(g0.__post({ action: 'notice', pass: PASS, cid: 'c1', text: 'x' }).error, /^owner only/);
});

test('v219 イベント：演出つきの一斉お知らせ。出すと来場者への返事（live.show）に入り、時間がたつと消える。司令塔の印が要る', () => {
  const g = freshOwner();
  const T = { token: ownerIn(g) };
  assert.deepStrictEqual(g.__get().live, {});
  assert.match(g.__post({ action: 'owner_show', title: 'x' }).error, /^owner session/);
  assert.match(g.__post({ action: 'owner_show', ...T, title: '  ' }).error, /^bad request: .*見出し/);
  const r = g.__post({ action: 'owner_show', ...T, title: 'まもなくステージ発表！', text: '<b>第一体育館</b>へどうぞ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.live.show.title, 'まもなくステージ発表！');
  const pub = g.__get().live.show;
  assert.strictEqual(pub.title, 'まもなくステージ発表！');
  assert.strictEqual(pub.text, '<b>第一体育館</b>へどうぞ');           // 文字のまま返す（画面の側で、文字として出す）
  assert.ok(pub.until - pub.at >= 60000 && /^[a-f0-9]{12}$/.test(pub.id));
  // 長すぎる見出し・文は切る
  const long = g.__post({ action: 'owner_show', ...T, title: 'あ'.repeat(99), text: 'い'.repeat(300) });
  assert.ok(long.live.show.title.length <= 31 && long.live.show.text.length <= 81);
  assert.notStrictEqual(long.live.show.id, pub.id, '出すたびに番号が変わる（画面は、番号が変わったら もう一度出す）');
  // 時間がたったら、返事から消える
  const o = JSON.parse(g.__props.LIVE); o.show.until = Date.now() - 1000; g.__props.LIVE = JSON.stringify(o);
  g.clearCache_();
  assert.deepStrictEqual(g.__get().live, {});
  // 消す
  g.__post({ action: 'owner_show', ...T, title: 'もう一度' });
  assert.strictEqual(g.__post({ action: 'owner_live_clear', ...T, what: 'show' }).live.show, undefined);
  assert.deepStrictEqual(g.__get().live, {});
  assert.match(g.__post({ action: 'owner_live_clear', ...T, what: 'なにか' }).error, /^bad request/);
  // 記録に残る
  assert.match(JSON.stringify(g.__ss.getSheetByName('司令塔の記録').data), /一斉お知らせ：まもなくステージ発表/);
});

test('v219 イベント：ラッキーブース。シートにあるブースを 3〜60分。終わらせられる', () => {
  const g = freshOwner();
  const T = { token: ownerIn(g) };
  assert.match(g.__post({ action: 'owner_lucky', ...T, booth: '9F-99', minutes: 10 }).error, /^bad request: .*シートにありません/);
  assert.match(g.__post({ action: 'owner_lucky', ...T, booth: '=1+1', minutes: 10 }).error, /^bad request/);
  assert.match(g.__post({ action: 'owner_lucky', ...T, booth: '1F-02', minutes: 999 }).error, /^bad request: .*3〜60分/);
  assert.match(g.__post({ action: 'owner_lucky', pass: PASS, booth: '1F-02', minutes: 10 }).error, /^owner session/);
  const t0 = Date.now();
  const r = g.__post({ action: 'owner_lucky', ...T, booth: '1F-02', minutes: 10 });
  assert.strictEqual(r.live.lucky.booth, '1F-02');
  const pub = g.__get().live.lucky;
  assert.strictEqual(pub.booth, '1F-02');
  assert.ok(Math.abs(pub.until - t0 - 600000) < 5000);
  // 別のブースに替える（番号が変わる）
  const r2 = g.__post({ action: 'owner_lucky', ...T, booth: '2F-12', minutes: 5 });
  assert.strictEqual(g.__get().live.lucky.booth, '2F-12');
  assert.notStrictEqual(r2.live.lucky.id, r.live.lucky.id);
  // 終わらせる
  assert.strictEqual(g.__post({ action: 'owner_lucky', ...T, booth: '' }).live.lucky, undefined);
  assert.deepStrictEqual(g.__get().live, {});
});

test('v219 イベント：スタンプの抽選。きょう決めた数以上あつめた人から選ぶ。当たった番号は来場者への返事に入れず、自分の番号で聞いた人にだけ答える', () => {
  const g = freshOwner();
  const T = { token: ownerIn(g) };
  const now = Date.now();
  const give = (cid, ids, at) => g.__post({ action: 'ledger', cid, ev: ids.map(id => ({ t: 's', id, at: at || now })) });
  const A = ['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444', 'EEEE5555'];
  A.forEach(c => give(c, ['1F-02', '1F-03', '2F-12']));          // 3個の人が5人
  give('FFFF6666', ['1F-02']);                                    // 1個の人
  give('GGGG7777', ['1F-02', '1F-03', '2F-12', '1F-05'], now - 2 * 86400000);   // おとといの4個（きょうの分ではない）
  // だれも条件に合わない
  assert.match(g.__post({ action: 'owner_draw', ...T, min: 10, n: 1 }).error, /^bad request: .*当たりを引ける人がいません.*0人/);
  assert.match(g.__post({ action: 'owner_draw', ...T, min: 0, n: 1 }).error, /^bad request/);
  assert.match(g.__post({ action: 'owner_draw', ...T, min: 3, n: 99 }).error, /^bad request/);
  assert.match(g.__post({ action: 'owner_draw', pass: PASS, min: 3, n: 1 }).error, /^owner session/);
  // 3個以上から2人
  const r = g.__post({ action: 'owner_draw', ...T, min: 3, n: 2 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const d = r.live.draw;
  assert.strictEqual(d.winners.length, 2);
  assert.strictEqual(d.elig, 5);
  d.winners.forEach(w => { assert.ok(A.includes(w.cid), w.cid); assert.strictEqual(w.stamps, 3); });
  assert.notStrictEqual(d.winners[0].cid, d.winners[1].cid);
  // 来場者への返事：抽選があったことと人数だけ。番号は、どこにも入っていない
  const pubText = JSON.stringify(g.__get());
  const pub = JSON.parse(pubText).live.draw;
  assert.deepStrictEqual(Object.keys(pub).sort(), ['at', 'id', 'min', 'n', 'until']);
  assert.strictEqual(pub.n, 2);
  for (const w of d.winners) assert.ok(!pubText.includes(w.cid), '当たった番号が、来場者への返事に入っている');
  // 自分の番号で聞くと、当たりかどうかが分かる
  const w0 = d.winners[0].cid, lose = A.find(c => !d.winners.some(w => w.cid === c));
  assert.strictEqual(g.__get({ win: d.id, cid: w0 }).win, true);
  assert.strictEqual(g.__get({ win: d.id, cid: lose }).win, false);
  assert.strictEqual(g.__get({ win: d.id, cid: 'FFFF6666' }).win, false);
  assert.strictEqual(g.__get({ win: 'chigau-bangou', cid: w0 }).win, false, '前の抽選の番号では当たりにならない');
  assert.strictEqual(g.__get({ win: d.id, cid: '!!' }).ok, false);
  assert.strictEqual(g.__get({ win: d.id }).ok, false);
  // 記録には、番号そのものは残さない
  const log = JSON.stringify(g.__ss.getSheetByName('司令塔の記録').data);
  assert.match(log, /抽選：2人が当たり/);
  for (const w of d.winners) assert.ok(!log.includes(w.cid));
  // もう一度引くと、前に当たった人は選ばない（残りの3人から）
  const r2 = g.__post({ action: 'owner_draw', ...T, min: 3, n: 5 });
  assert.strictEqual(r2.live.draw.winners.length, 3);
  assert.strictEqual(r2.live.draw.elig, 3);
  r2.live.draw.winners.forEach(w => assert.ok(!d.winners.some(x => x.cid === w.cid)));
  assert.strictEqual(g.__get({ win: d.id, cid: w0 }).win, false, '新しい抽選に替わったら、前の当たりは出さない');
  // 全員当たったあと：もう引けない。「前に当たった人も入れる」（again）なら引ける
  assert.match(g.__post({ action: 'owner_draw', ...T, min: 3, n: 1 }).error, /当たりを引ける人がいません/);
  assert.strictEqual(g.__post({ action: 'owner_draw', ...T, min: 3, n: 1, again: true }).live.draw.winners.length, 1);
  // 番号をつないだ人は、新しい番号にまとめて数える（旧 2個 ＋ 新 1個 ＝ 3個）。旧い番号で聞いても当たりが分かる
  const g2 = freshOwner();
  const T2 = { token: ownerIn(g2) };
  g2.__post({ action: 'ledger', cid: 'OLDD0001', ev: [{ t: 's', id: '1F-02', at: now }, { t: 's', id: '1F-03', at: now }] });
  g2.__post({ action: 'ledger', cid: 'NEWW0001', from: 'OLDD0001', ev: [{ t: 's', id: '2F-12', at: now }] });
  const r3 = g2.__post({ action: 'owner_draw', ...T2, min: 3, n: 3 });
  assert.deepStrictEqual(r3.live.draw.winners.map(w => w.cid), ['NEWW0001']);
  assert.strictEqual(g2.__get({ win: r3.live.draw.id, cid: 'OLDD0001' }).win, true);
  // 当たりの表示を消す
  assert.strictEqual(g2.__post({ action: 'owner_live_clear', ...T2, what: 'draw' }).live.draw, undefined);
  assert.strictEqual(g2.__get({ win: r3.live.draw.id, cid: 'NEWW0001' }).win, false);
});

/* ---------------- v220：抽選の前の下見 ---------------- */
test('v220 抽選の下見（dry）：いまの対象の人数だけを返す。当たりは引かない・何も書かない・司令塔の印が要る', () => {
  const g = freshOwner();
  const T = { token: ownerIn(g) };
  const now = Date.now();
  ['AAAA1111', 'BBBB2222'].forEach(c => g.__post({ action: 'ledger', cid: c, ev: ['1F-02', '1F-03', '2F-12'].map(id => ({ t: 's', id, at: now })) }));
  g.__post({ action: 'ledger', cid: 'CCCC3333', ev: [{ t: 's', id: '1F-02', at: now }] });
  const logRows = () => { const sh = g.__ss.getSheetByName('司令塔の記録'); return sh ? sh.getLastRow() : 0; };
  const rows0 = logRows();
  const d3 = g.__post({ action: 'owner_draw', ...T, min: 3, n: 1, dry: true });
  assert.deepStrictEqual([d3.ok, d3.dry, d3.elig, d3.min], [true, true, 2, 3]);
  assert.strictEqual(d3.live, undefined, '下見の返事に、司令塔の状態（当たった番号）は入れない');
  assert.strictEqual(g.__post({ action: 'owner_draw', ...T, min: 1, n: 1, dry: true }).elig, 3);
  assert.strictEqual(g.__post({ action: 'owner_draw', ...T, min: 10, n: 1, dry: true }).elig, 0, '0人でもエラーにしない');
  assert.strictEqual(g.__props.LIVE, undefined, '何も書いていない');
  assert.strictEqual(logRows(), rows0, '記録も増えない');
  assert.deepStrictEqual(g.__get().live, {});
  assert.match(g.__post({ action: 'owner_draw', pass: PASS, min: 3, n: 1, dry: true }).error, /^owner session/);
  assert.match(g.__post({ action: 'owner_draw', ...T, min: 0, n: 1, dry: true }).error, /^bad request/);
  // 本当に引いたあと：前に当たった人をのぞいた人数。again なら入れた人数
  const w = g.__post({ action: 'owner_draw', ...T, min: 3, n: 1 }).live.draw.winners[0].cid;
  assert.strictEqual(g.__post({ action: 'owner_draw', ...T, min: 3, n: 1, dry: true }).elig, 1);
  assert.strictEqual(g.__post({ action: 'owner_draw', ...T, min: 3, n: 1, dry: true, again: true }).elig, 2);
  assert.strictEqual(JSON.parse(g.__props.LIVE).draw.winners[0].cid, w, '下見で、当たりは変わらない');
});

/* ---------------- v221：ラッキーブースをのばす／さいきんの操作 ---------------- */
test('v221 ラッキーブースをのばす（extend）：番号 id はそのまま、終わりの時刻だけ のびる。いまから60分より先へは のばさない。出ていないときは断る', () => {
  const g = freshOwner();
  const T = { token: ownerIn(g) };
  assert.match(g.__post({ action: 'owner_lucky', ...T, extend: 5 }).error, /^bad request: .*出ていません/);
  const a = g.__post({ action: 'owner_lucky', ...T, booth: '1F-02', minutes: 10 }).live.lucky;
  const b = g.__post({ action: 'owner_lucky', ...T, extend: 5 }).live.lucky;
  assert.strictEqual(b.id, a.id, '番号は変えない（来場者に、もう一度は知らせない）');
  assert.strictEqual(b.booth, '1F-02');
  assert.strictEqual(b.until - a.until, 5 * 60000);
  assert.strictEqual(g.__get().live.lucky.until, b.until, '来場者への返事にも、のびた時刻');
  assert.match(g.__post({ action: 'owner_lucky', ...T, extend: 0 }).error, /^bad request: .*1〜30分/);
  assert.match(g.__post({ action: 'owner_lucky', ...T, extend: 99 }).error, /^bad request/);
  assert.match(g.__post({ action: 'owner_lucky', pass: PASS, extend: 5 }).error, /^owner session/);
  // 何度のばしても、いまから60分より先へは行かない
  let last = b;
  for (let i = 0; i < 5; i++) last = g.__post({ action: 'owner_lucky', ...T, extend: 30 }).live.lucky;
  assert.ok(last.until - Date.now() <= 60 * 60000 + 2000, String(last.until - Date.now()));
  assert.ok(last.until - Date.now() > 55 * 60000);
  // 終わらせたあとは、のばせない
  g.__post({ action: 'owner_lucky', ...T, booth: '' });
  assert.match(g.__post({ action: 'owner_lucky', ...T, extend: 5 }).error, /出ていません/);
});

test('v221 さいきんの操作（log）：司令塔の状態に、新しい順に8件まで。番号・パスワードは入らない', () => {
  const g = freshOwner();
  const T = { token: ownerIn(g) };
  assert.deepStrictEqual(g.__post({ action: 'owner_state', ...T }).log, []);
  g.__post({ action: 'owner_show', ...T, title: 'ひとつめ' });
  g.__post({ action: 'owner_lucky', ...T, booth: '1F-02', minutes: 10 });
  g.__post({ action: 'owner_lucky', ...T, extend: 5 });
  const NEWPASS = 'atarashii-pass-2026';
  g.__post({ action: 'owner_set_pass', ...T, pass: NEWPASS });
  g.__post({ action: 'ledger', cid: 'AAAA1111', ev: [{ t: 's', id: '1F-02', at: Date.now() }] });
  const st = g.__post({ action: 'owner_draw', ...T, min: 1, n: 1 });
  const log = st.log;
  assert.strictEqual(log.length, 5);
  assert.match(log[0].what, /^抽選：1人が当たり/);                 // 新しいものが先
  assert.match(log[4].what, /^一斉お知らせ：ひとつめ/);
  assert.ok(log.every(x => !isNaN(Date.parse(x.t))));
  const text = JSON.stringify(log);
  assert.ok(!text.includes('AAAA1111') && !text.includes(NEWPASS) && !text.includes(OWNER));
  // 8件まで
  for (let i = 0; i < 9; i++) g.__post({ action: 'owner_show', ...T, title: 'お知らせ' + i });
  const log2 = g.__post({ action: 'owner_state', ...T }).log;
  assert.strictEqual(log2.length, 8);
  assert.match(log2[0].what, /お知らせ8/);
  // 司令塔に入っていない人には返さない
  assert.match(g.__post({ action: 'owner_state', pass: PASS }).error, /^owner session/);
});
