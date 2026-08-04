/**
 * 黒工文化祭 混雑状況API v2
 * =============================================================================
 * 旧版からの変更点（重要）
 *  1. 管理者パスワードをクライアントから削除し、スクリプトプロパティで保持
 *     → 書き込みには毎回パスワード照合。誰でも書き換えられる状態を解消
 *  2. CacheService で GET を 8 秒キャッシュ
 *     → 来場者300人が20秒間隔でポーリングしても GAS の実行上限に当たらない
 *  3. LockService で同時更新の競合を防止
 *  4. 履歴シートに変更を記録し、GET で直近の推移を返す
 *     → フロント側のダミー混雑グラフを実データに置き換え
 *  5. bulk（一括リセット）をサーバー側1リクエストで処理
 *     → 旧版の「ブース数だけ直列POST」を解消
 *
 * セットアップ手順は SETUP.md を参照。
 * =============================================================================
 */

var SHEET_MAIN = 'ブース';
var SHEET_LOG  = '履歴';
var CACHE_KEY  = 'payload_v2';
var CACHE_SEC  = 8;
var HISTORY_POINTS = 12;      // 1ブースあたり返す推移の点数
var HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000;

var STATUS_LEVEL = {
  '空いています': 0,
  'やや混雑': 1,
  '混雑しています': 2,
  '準備中': 3
};

/* ========================== 初期セットアップ ========================== */
/**
 * エディタ上で一度だけ実行する。
 * 引数は使わず、下の PASSWORD を書き換えてから実行 → 実行後は行を消してよい。
 */
function setup() {
  var PASSWORD = '0623';
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASS', PASSWORD);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var main = ss.getSheetByName(SHEET_MAIN);
  if (!main) {
    main = ss.insertSheet(SHEET_MAIN);
    main.getRange(1, 1, 1, 7)
        .setValues([['id', 'name', 'status', 'time', 'category', 'floor', 'note']])
        .setFontWeight('bold');
  }
  if (!ss.getSheetByName(SHEET_LOG)) {
    ss.insertSheet(SHEET_LOG)
      .getRange(1, 1, 1, 3)
      .setValues([['timestamp', 'id', 'status']])
      .setFontWeight('bold');
  }
  Logger.log('セットアップ完了。setup() 内のパスワード文字列は消してください。');
}

/* ============================== 共通 ============================== */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」が見つかりません');
  return sh;
}

function headerIndex_(sh) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  head.forEach(function (h, i) { idx[String(h).trim()] = i; });
  return idx;
}

function checkPass_(pass) {
  var real = PropertiesService.getScriptProperties().getProperty('ADMIN_PASS');
  if (!real) throw new Error('サーバー側にパスワードが未設定です（setup を実行してください）');
  if (String(pass || '') !== real) {
    Utilities.sleep(700);           // 総当たり対策の簡易ディレイ
    throw new Error('unauthorized');
  }
}

/* ============================== GET ============================== */
function doGet() {
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(CACHE_KEY);
    if (hit) return ContentService.createTextOutput(hit)
      .setMimeType(ContentService.MimeType.JSON);

    var payload = JSON.stringify(buildPayload_());
    cache.put(CACHE_KEY, payload, CACHE_SEC);
    return ContentService.createTextOutput(payload)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function buildPayload_() {
  var sh = sheet_(SHEET_MAIN);
  var idx = headerIndex_(sh);
  var last = sh.getLastRow();
  var booths = [];

  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var hist = buildHistory_();
    rows.forEach(function (r) {
      var id = String(r[idx['id']] == null ? '' : r[idx['id']]).trim();
      if (!id) return;
      var t = r[idx['time']];
      booths.push({
        id: id,
        name: String(r[idx['name']] || '').trim(),
        status: String(r[idx['status']] || '').trim(),
        time: t instanceof Date ? t.toISOString() : (t ? String(t) : null),
        category: idx['category'] != null ? String(r[idx['category']] || 'その他').trim() : 'その他',
        floor: idx['floor'] != null ? (Number(r[idx['floor']]) === 2 ? 2 : 1) : 1,
        note: idx['note'] != null ? String(r[idx['note']] || '').trim() : '',
        history: hist[id] || []
      });
    });
  }

  return { ok: true, updatedAt: new Date().toISOString(), booths: booths };
}

/**
 * 履歴シートの末尾から直近3時間分を読み、ブースごとに最大12点へ間引く。
 * シートが無い／空の場合は空オブジェクトを返す（フロントは「蓄積中」と表示）。
 */
function buildHistory_() {
  var out = {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) return out;

  var last = sh.getLastRow();
  if (last < 2) return out;

  var take = Math.min(600, last - 1);
  var rows = sh.getRange(last - take + 1, 1, take, 3).getValues();
  var since = Date.now() - HISTORY_WINDOW_MS;
  var tz = ss.getSpreadsheetTimeZone();
  var grouped = {};

  rows.forEach(function (r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(ts.getTime()) || ts.getTime() < since) return;
    var id = String(r[1]).trim();
    var lv = STATUS_LEVEL[String(r[2]).trim()];
    if (!id || lv === undefined || lv === 3) return;
    (grouped[id] = grouped[id] || []).push({
      t: Utilities.formatDate(ts, tz, 'HH:mm'),
      lv: lv
    });
  });

  Object.keys(grouped).forEach(function (id) {
    var arr = grouped[id];
    if (arr.length <= HISTORY_POINTS) { out[id] = arr; return; }
    // 均等に間引いて HISTORY_POINTS 点にする
    var step = arr.length / HISTORY_POINTS;
    var picked = [];
    for (var i = 0; i < HISTORY_POINTS; i++) picked.push(arr[Math.floor(i * step)]);
    picked[HISTORY_POINTS - 1] = arr[arr.length - 1];
    out[id] = picked;
  });

  return out;
}

/* ============================== POST ============================== */
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'invalid json' });
  }

  try {
    var action = body.action || 'update';   // 旧クライアント互換：action 省略時は update

    if (action === 'verify') {
      checkPass_(body.pass);
      return json_({ ok: true });
    }

    if (action === 'update') {
      checkPass_(body.pass);
      if (!body.id || !(body.status in STATUS_LEVEL)) throw new Error('bad request');
      var n = writeStatus_([String(body.id).trim()], String(body.status));
      if (!n) throw new Error('該当するIDがありません: ' + body.id);
      return json_({ ok: true, status: 'success', updated: n });
    }

    if (action === 'bulk') {
      checkPass_(body.pass);
      var st = body.status && (body.status in STATUS_LEVEL) ? String(body.status) : '空いています';
      var cnt = writeStatus_(null, st);
      return json_({ ok: true, status: 'success', updated: cnt });
    }

    throw new Error('unknown action');
  } catch (err) {
    var msg = String(err.message || err);
    return json_({ ok: false, error: msg, status: 'error' });
  }
}

/**
 * ids が null なら全ブース。書き込みと履歴記録をまとめて行う。
 * @return {number} 更新した行数
 */
function writeStatus_(ids, status) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('サーバーが混み合っています。もう一度お試しください');

  try {
    var sh = sheet_(SHEET_MAIN);
    var idx = headerIndex_(sh);
    var last = sh.getLastRow();
    if (last < 2) return 0;

    var idCol = idx['id'] + 1, stCol = idx['status'] + 1, tmCol = idx['time'] + 1;
    var idVals = sh.getRange(2, idCol, last - 1, 1).getValues();
    var now = new Date();
    var logs = [];
    var updated = 0;

    for (var i = 0; i < idVals.length; i++) {
      var id = String(idVals[i][0]).trim();
      if (!id) continue;
      if (ids && ids.indexOf(id) === -1) continue;
      sh.getRange(i + 2, stCol).setValue(status);
      sh.getRange(i + 2, tmCol).setValue(now);
      logs.push([now, id, status]);
      updated++;
    }

    if (logs.length) appendLogs_(logs);
    CacheService.getScriptCache().remove(CACHE_KEY);   // 即時反映
    SpreadsheetApp.flush();
    return updated;
  } finally {
    lock.releaseLock();
  }
}

function appendLogs_(logs) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_LOG);
    sh.getRange(1, 1, 1, 3).setValues([['timestamp', 'id', 'status']]).setFontWeight('bold');
  }
  sh.getRange(sh.getLastRow() + 1, 1, logs.length, 3).setValues(logs);

  // 行が増えすぎたら古い方を削除（10000行上限）
  var last = sh.getLastRow();
  if (last > 10000) sh.deleteRows(2, last - 8000);
}

/* ====================== 任意：定時リセット用 ======================
   トリガーで毎朝実行すると、前日の状態が残るのを防げる。
   時間主導型トリガー（毎日 8:00 など）に resetDaily を設定。
   ================================================================= */
function resetDaily() {
  writeStatus_(null, '準備中');
}
