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
  const g = fresh();
  g.__get();
  g.__post({ action: 'notice', pass: PASS, cid: 'c1', text: '雨のため屋外は中止', level: 'info' });
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

  const g = fresh({ ADMIN_PASS: 'abcd12345' });                  // 9文字
  g.__post({ action: 'notice', pass: 'abcd12345', cid: 'c', text: 'テストです', level: 'alert' });
  // シートから1件消し、1件足す（R8 との食い違い）
  g.__post({ action: 'remove', pass: 'abcd12345', cid: 'c', id: '1F-02' });
  g.__post({ action: 'upsert', pass: 'abcd12345', cid: 'c', id: '3F-09', name: '追加', category: '展示', floor: 3 });
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
  const g = fresh();
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
  const b = g.__post({ action: 'bulk', pass: PASS, cid: 'c1', status: '準備中' });
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
  const g = fresh();
  const err = b => g.__post(b).error;
  assert.match(err({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03', wait: 5000 }), /^bad wait: .*0〜999/);
  assert.match(err({ action: 'update', pass: PASS, cid: 'c1', wait: 3 }), /^bad request: .*id/);
  assert.match(err({ action: 'update', pass: PASS, cid: 'c1', id: '1F-03' }), /^bad request: .*空いています/);
  assert.match(err({ action: 'upsert', pass: PASS, cid: 'c1', id: '=1+1', name: 'x' }), /^bad request: .*1F-02/);
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
