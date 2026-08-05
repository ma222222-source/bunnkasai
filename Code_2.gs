/**
 * 黒工文化祭 混雑状況API v3
 * =============================================================================
 * v3 の追加点
 *  1. 待ち人数（wait列）に対応。人数からステータスを自動判定
 *  2. 一定時間更新がないブースは「情報なし」として返す（古い情報を見せない）
 *  3. 本部からのお知らせシートに対応
 *  4. 履歴に待ち人数も記録
 *
 * 貼り付け手順：エディタで Ctrl+A → このファイルの全文を貼り付け → 保存
 *   → 関数 migrate を1回実行 → デプロイを管理 → 新バージョン
 * パスワードはコードに書きません（プロジェクトの設定 → スクリプトプロパティ）。
 * =============================================================================
 */

// スプレッドシートのID（URLの /d/ と /edit の間）
var SPREADSHEET_ID = '1TEoB1b5sn6qGBdtg5NHg2w2CoKdq0W9ob1C_k9s5HA8';

var SHEET_MAIN   = 'ブース';
var SHEET_LOG    = '履歴';
var SHEET_NOTICE = 'お知らせ';

var CACHE_KEY = 'payload_v3';
var CACHE_SEC = 8;

var HISTORY_POINTS = 12;                        // 1ブースあたり返す推移の点数
var HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000;     // 履歴をさかのぼる範囲

// これを過ぎたら「情報なし」として返す。係員の更新忘れ対策の要
var STALE_MINUTES = 45;

// 待ち人数からステータスを決める閾値（人）
var WAIT_WARN = 6;    // これ以上で「やや混雑」
var WAIT_BUSY = 16;   // これ以上で「混雑しています」

var HEADERS = ['id', 'name', 'status', 'time', 'category', 'floor', 'note', 'wait'];

var STATUS_LEVEL = {
  '空いています': 0,
  'やや混雑': 1,
  '混雑しています': 2,
  '準備中': 3
};

function statusFromWait_(n) {
  if (n >= WAIT_BUSY) return '混雑しています';
  if (n >= WAIT_WARN) return 'やや混雑';
  return '空いています';
}

/* ========================== セットアップ / 移行 ========================== */
/**
 * 初回セットアップと、v2からの移行を兼ねる。何度実行しても安全。
 *  - シートが無ければ作る
 *  - ブースシートに wait 列が無ければ追加する
 *  - お知らせシートが無ければ作る
 * パスワードはここでは設定しない（スクリプトプロパティで管理）。
 */
function migrate() {
  var ss = ss_();
  var log = [];

  var main = ss.getSheetByName(SHEET_MAIN);
  if (!main) {
    main = ss.insertSheet(SHEET_MAIN);
    main.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    log.push('ブースシートを作成');
  } else {
    var head = main.getRange(1, 1, 1, Math.max(main.getLastColumn(), 1)).getValues()[0]
                   .map(function (h) { return String(h).trim(); });
    HEADERS.forEach(function (h) {
      if (head.indexOf(h) === -1) {
        main.getRange(1, head.length + 1).setValue(h).setFontWeight('bold');
        head.push(h);
        log.push('列「' + h + '」を追加');
      }
    });
  }

  if (!ss.getSheetByName(SHEET_LOG)) {
    ss.insertSheet(SHEET_LOG).getRange(1, 1, 1, 4)
      .setValues([['timestamp', 'id', 'status', 'wait']]).setFontWeight('bold');
    log.push('履歴シートを作成');
  }

  var nt = ss.getSheetByName(SHEET_NOTICE);
  if (!nt) {
    nt = ss.insertSheet(SHEET_NOTICE);
    nt.getRange(1, 1, 1, 3).setValues([['message', 'level', 'enabled']]).setFontWeight('bold');
    nt.getRange(2, 1, 1, 3).setValues([['', 'info', false]]);
    nt.getRange('A4').setValue(
      '↑ A2 に本文を書いて C2 に TRUE を入れると、全員の画面上部に表示されます。' +
      ' B2 は info（青）か alert（赤）。消すときは C2 を FALSE に。');
    log.push('お知らせシートを作成');
  }

  applySheetGuards_(main);
  log.push('入力規則を設定');

  CacheService.getScriptCache().remove(CACHE_KEY);
  Logger.log(log.length ? log.join(' / ') : '変更はありませんでした（すでに最新の構成です）');
}

/**
 * シートを直接編集したときに壊れないようにする。
 *  - status 列をプルダウンにして、決められた4つ以外を入れられなくする
 *  - floor 列を 1/2 のプルダウンに
 *  - status に色を付けて、シート上でも状況が分かるようにする
 */
function applySheetGuards_(sh) {
  var idx = headerIndex_(sh);
  var rows = Math.max(sh.getMaxRows() - 1, 1);

  var statusCol = idx['status'] + 1;
  var stRange = sh.getRange(2, statusCol, rows, 1);
  stRange.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['空いています', 'やや混雑', '混雑しています', '準備中'], true)
      .setAllowInvalid(false)
      .setHelpText('この4つから選んでください')
      .build());

  if (idx['floor'] != null) {
    sh.getRange(2, idx['floor'] + 1, rows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['1', '2'], true).setAllowInvalid(false).build());
  }

  // 既存の条件付き書式を作り直す（重複して積み上がらないように）
  var colors = [['空いています', '#d9ead3'], ['やや混雑', '#fff2cc'],
                ['混雑しています', '#f4cccc'], ['準備中', '#e0e0e0']];
  var rules = sh.getConditionalFormatRules().filter(function (r) {
    var rs = r.getRanges();
    return !(rs.length === 1 && rs[0].getColumn() === statusCol);
  });
  colors.forEach(function (c) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(c[0]).setBackground(c[1]).setRanges([stRange]).build());
  });
  sh.setConditionalFormatRules(rules);
}

/**
 * 当日前の点検用。おかしなデータを洗い出して実行ログに出す。
 * 何も変更しないので安心して実行できる。
 */
function validate() {
  var sh = sheet_(SHEET_MAIN);
  var idx = headerIndex_(sh);
  var last = sh.getLastRow();
  var problems = [];

  if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PASS')) {
    problems.push('係員パスワード(ADMIN_PASS)が未設定です');
  } else if (PropertiesService.getScriptProperties().getProperty('ADMIN_PASS').length < 8) {
    problems.push('係員パスワードが短すぎます（英数字12文字以上を推奨）');
  }
  HEADERS.forEach(function (h) { if (idx[h] == null) problems.push('列「' + h + '」がありません'); });

  if (last < 2) {
    problems.push('ブースが1件も登録されていません');
  } else {
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var seen = {};
    rows.forEach(function (r, i) {
      var line = 'A' + (i + 2) + ': ';
      var id = String(r[idx['id']] || '').trim();
      if (!id) { problems.push(line + 'id が空です'); return; }
      if (seen[id]) problems.push(line + 'id「' + id + '」が重複しています');
      seen[id] = true;
      if (!String(r[idx['name']] || '').trim()) problems.push(line + 'name が空です');
      var st = String(r[idx['status']] || '').trim();
      if (st && !(st in STATUS_LEVEL)) problems.push(line + 'status「' + st + '」は使えません');
      if (idx['floor'] != null) {
        var f = Number(r[idx['floor']]);
        if (f !== 1 && f !== 2) problems.push(line + 'floor は 1 か 2 にしてください');
      }
    });
  }

  Logger.log(problems.length
    ? '要確認 ' + problems.length + '件\n・' + problems.join('\n・')
    : '問題は見つかりませんでした。');
}

/** ブースの初期データを流し込む。既にデータがあれば何もしない */
function seedBooths() {
  var sh = sheet_(SHEET_MAIN);
  if (sh.getLastRow() >= 2) {
    Logger.log('既にデータがあります。中止しました。');
    return;
  }
  var rows = [
    ['1', '電子科',          '準備中', '', '展示',     1, '', 0],
    ['2', '電気科',          '準備中', '', '展示',     1, '', 0],
    ['3', '機械科',          '準備中', '', '展示',     1, '', 0],
    ['4', '受付・本部・M科', '準備中', '', '受付',     1, 'パンフ配布中', 0],
    ['5', '土木/建築',       '準備中', '', '展示',     1, '', 0],
    ['6', '商業/工経',       '準備中', '', '展示',     1, '', 0],
    ['7', '実習棟群',        '準備中', '', '食べ物',   1, '', 0],
    ['8', '体育館イベント',  '準備中', '', 'イベント', 1, '', 0]
  ];
  sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  Logger.log('ブース ' + rows.length + '件を登録しました。');
}

/* ============================== 共通 ============================== */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 紐づけの有無にかかわらず対象スプレッドシートを取得する */
function ss_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (!ss) throw new Error('スプレッドシートを開けません。SPREADSHEET_ID を確認してください');
  return ss;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」が見つかりません。migrate を実行してください');
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
  if (!real) throw new Error('サーバー側にパスワードが未設定です');
  if (String(pass || '') !== real) {
    Utilities.sleep(700);           // 総当たり対策の簡易ディレイ
    throw new Error('unauthorized');
  }
}

/* ============================== GET ============================== */
function doGet(e) {
  // ?report=1 で当日の振り返りデータを返す（?date=YYYY-MM-DD で日付指定）
  var param = (e && e.parameter) || {};
  if (param.report === '1') {
    try {
      var key = 'report_' + (param.date || 'today');
      var c = CacheService.getScriptCache();
      var cached = c.get(key);
      if (cached) return ContentService.createTextOutput(cached)
        .setMimeType(ContentService.MimeType.JSON);
      var body = JSON.stringify(buildReport_(param.date));
      c.put(key, body, 60);
      return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return json_({ ok: false, error: String(err.message || err) });
    }
  }

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
  var staleMs = STALE_MINUTES * 60 * 1000;
  var now = Date.now();

  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var hist = buildHistory_();
    rows.forEach(function (r) {
      var id = String(r[idx['id']] == null ? '' : r[idx['id']]).trim();
      if (!id) return;

      var t = r[idx['time']];
      var ts = t instanceof Date ? t : (t ? new Date(t) : null);
      var iso = ts && !isNaN(ts.getTime()) ? ts.toISOString() : null;
      var status = String(r[idx['status']] || '').trim();
      // 空セルは「人数が分からない」。Number('') は 0 になってしまうので先に弾く
      var waitCell = idx['wait'] != null ? r[idx['wait']] : '';
      var wait = null;
      if (waitCell !== '' && waitCell !== null && waitCell !== undefined) {
        var wn = Number(waitCell);
        if (!isNaN(wn) && wn >= 0) wait = Math.round(wn);
      }

      // 更新が途絶えたブースは「情報なし」として返す。
      // 「準備中」は意図して設定した状態なので対象外。
      var stale = false;
      if (status && status !== '準備中') {
        if (!ts || isNaN(ts.getTime()) || now - ts.getTime() > staleMs) {
          stale = true; status = ''; wait = null;
        }
      }

      booths.push({
        id: id,
        name: String(r[idx['name']] || '').trim(),
        status: status,
        stale: stale,
        wait: wait,
        time: iso,
        category: idx['category'] != null ? String(r[idx['category']] || 'その他').trim() : 'その他',
        floor: idx['floor'] != null ? (Number(r[idx['floor']]) === 2 ? 2 : 1) : 1,
        note: idx['note'] != null ? String(r[idx['note']] || '').trim() : '',
        history: hist[id] || []
      });
    });
  }

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    staleMinutes: STALE_MINUTES,
    waitThresholds: { warn: WAIT_WARN, busy: WAIT_BUSY },
    notice: readNotice_(),
    booths: booths
  };
}

/** お知らせシートの2行目を読む。enabled が真でなければ null */
function readNotice_() {
  var sh = ss_().getSheetByName(SHEET_NOTICE);
  if (!sh || sh.getLastRow() < 2) return null;
  var r = sh.getRange(2, 1, 1, 3).getValues()[0];
  var msg = String(r[0] || '').trim();
  var on = r[2] === true || String(r[2]).toUpperCase() === 'TRUE';
  if (!msg || !on) return null;
  var level = String(r[1] || 'info').trim().toLowerCase();
  return { text: msg, level: level === 'alert' ? 'alert' : 'info' };
}

/**
 * 履歴シートの末尾から直近3時間分を読み、ブースごとに最大12点へ間引く。
 */
function buildHistory_() {
  var out = {};
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) return out;

  var last = sh.getLastRow();
  if (last < 2) return out;

  var cols = Math.max(sh.getLastColumn(), 3);
  var take = Math.min(600, last - 1);
  var rows = sh.getRange(last - take + 1, 1, take, cols).getValues();
  var since = Date.now() - HISTORY_WINDOW_MS;
  var tz = ss.getSpreadsheetTimeZone();
  var grouped = {};

  rows.forEach(function (r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(ts.getTime()) || ts.getTime() < since) return;
    var id = String(r[1]).trim();
    var lv = STATUS_LEVEL[String(r[2]).trim()];
    if (!id || lv === undefined || lv === 3) return;
    var w = cols >= 4 ? Number(r[3]) : NaN;
    (grouped[id] = grouped[id] || []).push({
      t: Utilities.formatDate(ts, tz, 'HH:mm'),
      lv: lv,
      w: isNaN(w) ? null : w
    });
  });

  Object.keys(grouped).forEach(function (id) {
    var arr = grouped[id];
    if (arr.length <= HISTORY_POINTS) { out[id] = arr; return; }
    var step = arr.length / HISTORY_POINTS;
    var picked = [];
    for (var i = 0; i < HISTORY_POINTS; i++) picked.push(arr[Math.floor(i * step)]);
    picked[HISTORY_POINTS - 1] = arr[arr.length - 1];
    out[id] = picked;
  });

  return out;
}

/* ============================== 振り返りレポート ============================== */
var REPORT_BUCKET_MIN = 15;   // 何分刻みで集計するか

/**
 * 履歴シートから1日分の混雑推移を集計する。
 * @param {string=} dateStr 'YYYY-MM-DD'。省略時は履歴の最終日
 * @return {Object}
 */
function buildReport_(dateStr) {
  var ss = ss_();
  var tz = ss.getSpreadsheetTimeZone();
  var log = ss.getSheetByName(SHEET_LOG);
  var names = {};
  var order = [];
  var msh = sheet_(SHEET_MAIN);
  var midx = headerIndex_(msh);
  if (msh.getLastRow() >= 2) {
    msh.getRange(2, 1, msh.getLastRow() - 1, msh.getLastColumn()).getValues().forEach(function (r) {
      var id = String(r[midx['id']] || '').trim();
      if (!id) return;
      names[id] = String(r[midx['name']] || '').trim() || id;
      order.push(id);
    });
  }

  var empty = { ok: true, generatedAt: new Date().toISOString(), date: dateStr || null,
                buckets: [], booths: [], overall: [], summary: null };
  if (!log || log.getLastRow() < 2) return empty;

  var rows = log.getRange(2, 1, log.getLastRow() - 1, Math.max(log.getLastColumn(), 3)).getValues();
  var day = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };

  var entries = [];
  rows.forEach(function (r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(ts.getTime())) return;
    var lv = STATUS_LEVEL[String(r[2]).trim()];
    if (lv === undefined) return;
    entries.push({ ts: ts, id: String(r[1]).trim(), lv: lv,
                   w: Number(r[3]), d: day(ts) });
  });
  if (!entries.length) return empty;

  var target = dateStr || entries[entries.length - 1].d;
  entries = entries.filter(function (x) { return x.d === target; });
  if (!entries.length) return empty;

  // 時間バケットを作る
  var msBucket = REPORT_BUCKET_MIN * 60000;
  var floorTo = function (t) { return Math.floor(t / msBucket) * msBucket; };
  // 履歴は追記順だが、念のため最小・最大から範囲を決める
  var times = entries.map(function (x) { return x.ts.getTime(); });
  var t0 = floorTo(Math.min.apply(null, times));
  var t1 = floorTo(Math.max.apply(null, times));
  var buckets = [];
  for (var t = t0; t <= t1; t += msBucket) buckets.push(t);
  var labels = buckets.map(function (t) { return Utilities.formatDate(new Date(t), tz, 'HH:mm'); });

  // ブースごとに、各バケットの「最後に記録された状態」を採用する
  var per = {};
  entries.forEach(function (x) {
    if (!x.id) return;
    var b = floorTo(x.ts.getTime());
    (per[x.id] = per[x.id] || {})[b] = { lv: x.lv, w: isNaN(x.w) ? null : x.w };
  });

  var ids = order.filter(function (id) { return per[id]; });
  Object.keys(per).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });

  var booths = ids.map(function (id) {
    var series = [], waits = [], last = null, busy = 0;
    buckets.forEach(function (t) {
      var v = per[id][t];
      if (v) { last = v; }                       // 記録がないバケットは直前の状態が続いたとみなす
      series.push(last ? last.lv : null);
      if (last && last.w != null) waits.push(last.w);
      if (last && last.lv === 2) busy += REPORT_BUCKET_MIN;
    });
    return {
      id: id, name: names[id] || id, series: series,
      maxWait: waits.length ? Math.max.apply(null, waits) : null,
      avgWait: waits.length ? Math.round(waits.reduce(function (s, v) { return s + v; }, 0) / waits.length) : null,
      busyMinutes: busy,
      updates: Object.keys(per[id]).length
    };
  });

  // 全体の推移
  var overall = buckets.map(function (t, i) {
    var c = [0, 0, 0, 0];
    booths.forEach(function (b) {
      var lv = b.series[i];
      if (lv === null || lv === undefined) return;
      c[lv]++;
    });
    return { t: labels[i], free: c[0], warn: c[1], busy: c[2], prep: c[3] };
  });

  var peak = overall.reduce(function (a, x) { return x.busy > a.busy ? x : a; }, overall[0]);
  var busiest = booths.slice().sort(function (a, b) { return b.busyMinutes - a.busyMinutes; })[0];
  var totalUpdates = booths.reduce(function (s, b) { return s + b.updates; }, 0);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    date: target,
    bucketMinutes: REPORT_BUCKET_MIN,
    buckets: labels,
    booths: booths,
    overall: overall,
    summary: {
      peakTime: peak ? peak.t : null,
      peakBusyCount: peak ? peak.busy : 0,
      busiestBooth: busiest ? busiest.name : null,
      busiestMinutes: busiest ? busiest.busyMinutes : 0,
      totalUpdates: totalUpdates,
      openLabel: labels[0] + '〜' + labels[labels.length - 1]
    }
  };
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
    var action = body.action || 'update';

    if (action === 'verify') {
      checkPass_(body.pass);
      return json_({ ok: true });
    }

    if (action === 'update') {
      checkPass_(body.pass);
      if (!body.id) throw new Error('bad request');

      // wait の3状態を区別する：
      //   キーが無い        … 人数列を触らない
      //   null / 空文字     … 人数を消す（3段階ボタンだけで更新したとき）
      //   数値              … その人数にする
      var wait;
      if ('wait' in body) {
        wait = (body.wait === null || body.wait === '') ? null
             : Math.max(0, Math.round(Number(body.wait)));
        if (wait !== null && isNaN(wait)) throw new Error('bad wait');
      }

      // 人数が来ていてステータス指定が無ければ、人数から自動判定する
      var status = body.status && (body.status in STATUS_LEVEL) ? String(body.status) : null;
      if (!status && wait !== null && wait !== undefined) status = statusFromWait_(wait);
      if (!status) throw new Error('bad request');

      var n = writeBooth_([String(body.id).trim()], status, wait);
      if (!n) throw new Error('該当するIDがありません: ' + body.id);
      return json_({ ok: true, status: 'success', appliedStatus: status, updated: n });
    }

    if (action === 'bulk') {
      checkPass_(body.pass);
      var st = body.status && (body.status in STATUS_LEVEL) ? String(body.status) : '空いています';
      var cnt = writeBooth_(null, st, 0);
      return json_({ ok: true, status: 'success', updated: cnt });
    }

    throw new Error('unknown action');
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), status: 'error' });
  }
}

/**
 * ids が null なら全ブース。status と wait をまとめて書き、履歴に記録する。
 * wait: undefined = 触らない / null = 消す / 数値 = その値にする
 * @return {number} 更新した行数
 */
function writeBooth_(ids, status, wait) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('サーバーが混み合っています。もう一度お試しください');

  try {
    var sh = sheet_(SHEET_MAIN);
    var idx = headerIndex_(sh);
    var last = sh.getLastRow();
    if (last < 2) return 0;

    var idCol = idx['id'] + 1, stCol = idx['status'] + 1, tmCol = idx['time'] + 1;
    var wtCol = idx['wait'] != null ? idx['wait'] + 1 : null;

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
      if (wtCol && wait !== undefined) sh.getRange(i + 2, wtCol).setValue(wait === null ? '' : wait);
      logs.push([now, id, status, (wait === null || wait === undefined) ? '' : wait]);
      updated++;
    }

    if (logs.length) appendLogs_(logs);
    CacheService.getScriptCache().remove(CACHE_KEY);
    SpreadsheetApp.flush();
    return updated;
  } finally {
    lock.releaseLock();
  }
}

function appendLogs_(logs) {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_LOG);
    sh.getRange(1, 1, 1, 4).setValues([['timestamp', 'id', 'status', 'wait']]).setFontWeight('bold');
  }
  sh.getRange(sh.getLastRow() + 1, 1, logs.length, 4).setValues(logs);

  var last = sh.getLastRow();
  if (last > 10000) sh.deleteRows(2, last - 8000);
}

/* ====================== 任意：定時リセット用 ======================
   時間主導型トリガー（毎日 8:00 など）に resetDaily を設定すると、
   前日の状態が残ったまま当日を迎えるのを防げる。
   ================================================================= */
function resetDaily() {
  writeBooth_(null, '準備中', 0);
}
