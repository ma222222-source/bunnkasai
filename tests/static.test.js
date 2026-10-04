/*
 * ブラウザを使わないテスト（数秒で終わる）。
 * - 構文：index.html の script・sw.js・Code.gs・manifest.json・appsscript.json
 * - 版の整合：BUILD の形式、sw.js の CACHE、GAS_VERSION ≧ GAS_MIN
 * - 互換性の番人：刷った QR の署名（sigOf）と localStorage のキー名が変わっていないこと
 *   （変わると来場者のスタンプが消える・刷ったQRが無効になる。RULES.md §2）
 * - R8 のブース：Code.gs の R8_BOOTHS が46件・重複なし・すべて地図（FLOOR_PLAN）に部屋がある
 * - GAS の防御：safeText_ が数式を無効にする、cut_ が長さを切る
 *
 * 使い方：cd tests && npm test（または node static.test.js）
 * 署名の控えを作り直す（STAMP_KEY を意図して変えたときだけ）：node static.test.js --update-sigs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const sw = read('sw.js');
const gs = read('Code.gs');

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  NG   ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

/* ---------- 構文 ---------- */
test('index.html の script に構文エラーが無い', () => {
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/application\/(ld\+)?json/.test(m[1])) { JSON.parse(m[2]); continue; }
    new vm.Script(m[2], { filename: 'index.html#script' + n++ });
  }
  assert.ok(n >= 1, 'script が見つからない');
});
test('sw.js・Code.gs に構文エラーが無い', () => {
  new vm.Script(sw, { filename: 'sw.js' });
  new vm.Script(gs, { filename: 'Code.gs' });
});
test('manifest.json・appsscript.json が JSON として読める', () => {
  JSON.parse(read('manifest.json'));
  JSON.parse(read('appsscript.json'));
});
test('見出しで先に取りに行く GAS の URL が CONFIG.GAS_URL と同じ（v153）', () => {
  const cfg = (html.match(/GAS_URL: '([^']+)'/) || [])[1];
  const early = (html.match(/var u = '(https:\/\/script\.google\.com\/macros\/s\/[^']+)'/) || [])[1];
  assert.ok(cfg && early, 'どちらかが見つからない');
  assert.strictEqual(early, cfg);
});
test('manifest の shortcuts（ホーム画面の長押し）が今の画面の引数を指している', () => {
  const m = JSON.parse(read('manifest.json'));
  const urls = (m.shortcuts || []).map(x => x.url);
  assert.ok(urls.some(u => u.includes('scan=1')) && urls.some(u => u.includes('tab=stamp')), urls.join(','));
});
test('外部の script / CDN を読み込んでいない（RULES.md §3）', () => {
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html), '外部 script がある');
});

/* ---------- 版 ---------- */
const BUILD = (html.match(/BUILD:\s*'([^']+)'/) || [])[1];
const GAS_MIN = (html.match(/GAS_MIN:\s*'([^']+)'/) || [])[1];
const CACHE = (sw.match(/const CACHE = '([^']+)'/) || [])[1];
const GAS_VERSION = (gs.match(/var GAS_VERSION = '([^']+)'/) || [])[1];
test('版の形式（BUILD・CACHE・GAS_VERSION）', () => {
  assert.match(BUILD || '', /^\d{4}-\d{2}-\d{2}[a-z]$/, 'BUILD: ' + BUILD);
  assert.match(CACHE || '', /^kuroko-map-v\d+$/, 'CACHE: ' + CACHE);
  assert.match(GAS_VERSION || '', /^\d{4}-\d{2}-\d{2}[a-z]$/, 'GAS_VERSION: ' + GAS_VERSION);
});
test('Code.gs の GAS_VERSION が画面の前提（GAS_MIN）以上', () => {
  assert.ok(GAS_VERSION >= GAS_MIN, `GAS_VERSION ${GAS_VERSION} < GAS_MIN ${GAS_MIN}`);
});
test('PROGRESS.md に今の BUILD と CACHE が書かれている', () => {
  const p = read('PROGRESS.md');
  assert.ok(p.includes(BUILD), 'PROGRESS.md に BUILD ' + BUILD + ' が無い');
  assert.ok(p.includes(CACHE.replace('kuroko-map-', '')) || p.includes(CACHE), 'PROGRESS.md に ' + CACHE + ' が無い');
});

/* ---------- 互換性の番人 ---------- */
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' が見つからない');
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(name + ' の終わりが見つからない');
}
const STAMP_KEY = (html.match(/STAMP_KEY:\s*'([^']*)'/) || [])[1];
const sigCtx = vm.createContext({ CONFIG: { STAMP_KEY } });
vm.runInContext(extractFn(html, 'hash32') + '\n' + extractFn(html, 'sigOf'), sigCtx);

// R8_BOOTHS を Code.gs から取り出す（GAS の関数は動かさない）
const gsCtx = vm.createContext({});
vm.runInContext(gs.match(/var R8_BOOTHS = \[[\s\S]*?\n\];/)[0] + '\nthis.R8_BOOTHS = R8_BOOTHS;', gsCtx);
const R8 = gsCtx.R8_BOOTHS;

const SIG_FILE = path.join(__dirname, 'fixtures', 'sigs.json');
const sigsNow = {};
for (const id of [...new Set(R8.map(b => b[0]))].sort()) sigsNow[id] = sigCtx.sigOf(id);
if (process.argv.includes('--update-sigs') || !fs.existsSync(SIG_FILE)) {
  fs.writeFileSync(SIG_FILE, JSON.stringify(sigsNow, null, 1) + '\n');
  console.log('  （署名の控えを書き出しました：' + path.relative(ROOT, SIG_FILE) + '）');
}
test('刷ったQRの署名（STAMP_KEY・sigOf）が変わっていない', () => {
  const saved = JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'));
  for (const [id, s] of Object.entries(saved)) assert.strictEqual(sigCtx.sigOf(id), s, id + ' の署名が変わった');
});

// 来場者の端末に残っているキー。名前を変えるとスタンプ・引き継ぎが消える
const KEYS = ['kuroko_sid', 'kuroko_stamps_v2', 'kuroko_spent_v1', 'kuroko_cid', 'kuroko_unsent',
  'kuroko_here_v1', 'kuroko_cache_v2', 'kuroko_stamp_at', 'kuroko_joined', 'kuroko_join_from',
  'kuroko_migrated', 'kuroko_pushed_fp', 'kuroko_fs', 'kuroko_theme', 'kuroko_sound'];
test('localStorage のキー名が残っている', () => {
  for (const k of KEYS) assert.ok(html.includes("'" + k) || html.includes('"' + k) || html.includes(k), k + ' が無い');
});
test('QR の URL の形（?booth=…&qr=1&k=…）を読む処理が残っている', () => {
  assert.ok(/qr/.test(html) && /get\(['"]k['"]\)/.test(html), 'k パラメータを読んでいない');
});

/* ---------- R8 のブース ---------- */
test('R8_BOOTHS が46件・id の重複なし', () => {
  const ids = R8.map(b => b[0]);
  assert.strictEqual(ids.length, 46, '件数 ' + ids.length);
  assert.strictEqual(new Set(ids).size, ids.length, '重複あり');
});
test('R8 のブースがすべて地図（FLOOR_PLAN）の部屋にある', () => {
  const missing = R8.map(b => b[0]).filter(id => !html.includes('"id":"' + id + '"'));
  assert.strictEqual(missing.length, 0, '地図に無い：' + missing.join(', '));
});

/* ---------- GAS の防御 ---------- */
const defCtx = vm.createContext({});
vm.runInContext(extractFn(gs, 'safeText_') + '\n' + extractFn(gs, 'cut_'), defCtx);
test('safeText_ が数式の先頭文字（= + - @）を無効にする', () => {
  for (const s of ['=IMPORTXML("x")', '+1', '-1+2', '@A1']) {
    const out = String(defCtx.safeText_(s));
    assert.ok(!/^[=+\-@]/.test(out), s + ' → ' + out);
  }
  assert.strictEqual(defCtx.safeText_('ふつうの文'), 'ふつうの文');
});
test('cut_ が長さを切る（切ったら末尾に…）', () => {
  assert.strictEqual(defCtx.cut_('あいうえおかきくけこ', 3), 'あいう…');
  assert.strictEqual(defCtx.cut_(null, 3), '');
});

test('index.html の静的な id が重複していない（getElementById が別の要素を拾わないように）', () => {
  const ids = {};
  for (const m of html.matchAll(/\sid="([A-Za-z][\w:-]*)"/g)) ids[m[1]] = (ids[m[1]] || 0) + 1;
  const dup = Object.keys(ids).filter(k => ids[k] > 1);
  assert.deepStrictEqual(dup, [], '重複：' + dup.join(', '));
});

console.log(`\nstatic: ${passed} ok / ${failed} NG（BUILD ${BUILD}・${CACHE}・GAS ${GAS_VERSION}）`);
process.exit(failed ? 1 : 0);
