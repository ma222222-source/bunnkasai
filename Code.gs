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

var SHEET_MAIN     = 'ブース';
var SHEET_LOG      = '履歴';
var SHEET_NOTICE   = 'お知らせ';
var SHEET_VISITORS = '来場者';

var CACHE_KEY = 'payload_v3';
var CACHE_BAK = 'payload_v3_bak';   // 再構築中に返す少し古い控え
var CACHE_SEC = 15;                 // 画面は20秒間隔なので15秒でも体感は変わらない
var BACKUP_SEC = 300;

// 日付の境目は必ず日本時間で決める。
// シートのロケールが米国のままだと、13時や16時に「今日」が切り替わり
// 来場者カウンタが祭りの最中に 0 に戻る。
var TZ = 'Asia/Tokyo';

// スプレッドシートを開く処理は重い。1リクエスト内では1回だけにする
var SS_CACHE_ = null;

var HISTORY_POINTS = 12;                        // 1ブースあたり返す推移の点数
var HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000;     // 履歴をさかのぼる範囲

// これを過ぎたら「情報なし」として返す。係員の更新忘れ対策の要
var STALE_MINUTES = 45;

// 待ち人数からステータスを決める閾値（人）
var WAIT_WARN = 6;    // これ以上で「やや混雑」
var WAIT_BUSY = 16;   // これ以上で「混雑しています」

var HEADERS = ['id', 'name', 'status', 'time', 'category', 'floor', 'note', 'wait', 'image'];

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

  if (!ss.getSheetByName(SHEET_VISITORS)) {
    ss.insertSheet(SHEET_VISITORS).getRange(1, 1, 1, 3)
      .setValues([['timestamp', 'delta', 'memo']]).setFontWeight('bold');
    log.push('来場者シートを作成');
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

  // タイムゾーンがずれていると、来場者カウンタが当日の途中で 0 に戻る
  try {
    var stz = ss_().getSpreadsheetTimeZone();
    if (stz !== TZ) problems.push('スプレッドシートのタイムゾーンが ' + stz
      + ' です。ファイル → 設定 → タイムゾーン を「(GMT+09:00) 東京」にしてください');
    if (Session.getScriptTimeZone() !== TZ) problems.push('スクリプトのタイムゾーンが '
      + Session.getScriptTimeZone() + ' です。プロジェクトの設定で東京にしてください');
  } catch (e) {}

  if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PASS')) {
    problems.push('係員パスワード(ADMIN_PASS)が未設定です');
  } else if (PropertiesService.getScriptProperties().getProperty('ADMIN_PASS').length < 8) {
    problems.push('係員パスワードが短すぎます（英数字12文字以上を推奨）');
  }
  // 必須の列と、無くても動く列を分けて扱う（image などは任意）
  var REQUIRED = ['id', 'name', 'status', 'time'];
  var missingOptional = [];
  HEADERS.forEach(function (h) {
    if (idx[h] != null) return;
    if (REQUIRED.indexOf(h) >= 0) problems.push('列「' + h + '」がありません（必須）');
    else missingOptional.push(h);
  });

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
      // 部屋IDは 1F-02 / 0F-01 / 1X-05 の形。違っていても動くが、地図には載らない
      if (!/^[0-3][FX]-\d{2}$/.test(id)) {
        problems.push(line + 'id「' + id + '」は部屋IDの形ではありません（例 1F-02）。'
          + '一覧には出ますが地図には載りません');
      }
      if (idx['floor'] != null) {
        var f = Number(r[idx['floor']]);
        if ([0, 1, 2, 3].indexOf(f) < 0) {
          problems.push(line + 'floor は 0（屋外）／1／2／3 のどれかにしてください');
        }
      }
    });
  }

  var tail = missingOptional.length
    ? '\n（任意の列が未作成：' + missingOptional.join('・') + ' — migrate を実行すると追加されます）'
    : '';
  // 配信データの大きさも見ておく。100KB を超えるとキャッシュが効かなくなり、
  // 原因不明のまま当日ずっと重くなる
  var size = 0;
  try { size = JSON.stringify(buildPayload_()).length; } catch (e) {}
  if (size > 80000) problems.push('配信データが大きすぎます（' + Math.round(size / 1024)
    + 'KB）。メモや画像URLを短くしてください');

  Logger.log((problems.length
    ? '要確認 ' + problems.length + '件\n・' + problems.join('\n・')
    : '問題は見つかりませんでした。')
    + tail + '\n配信データの大きさ：' + Math.round(size / 1024) + 'KB（上限のめやす 80KB）');
}

/** 階の読み取り。0=屋外／1F／2F／3F。それ以外は 1 とみなす */
function floorOf_(v) {
  var n = Number(v);
  return [0, 1, 2, 3].indexOf(n) >= 0 ? n : 1;
}

/** ブースの初期データを流し込む。既にデータがあれば何もしない */
function seedBooths() {
  var sh = sheet_(SHEET_MAIN);
  if (sh.getLastRow() >= 2) {
    Logger.log('既にデータがあります。中止しました。');
    return;
  }
  // 部屋IDは 部屋ID一覧.xlsx を参照（1F-02 = 機械加工実習室 など）
  var rows = [
    ['1F-32', '受付・本部',        '準備中', '', '受付',     1, 'パンフ配布中', 0],
    ['1F-01', '電子機械科 展示',   '準備中', '', '展示',     1, '', 0],
    ['1F-02', '機械科 実演',       '準備中', '', '展示',     1, '', 0],
    ['1F-33', '材料技術科 展示',   '準備中', '', '展示',     1, '', 0],
    ['1F-38', '土木科 体験',       '準備中', '', '体験',     1, '', 0],
    ['1F-42', '体育館ステージ',    '準備中', '', 'イベント', 1, '12:00 ステージ発表', 0],
    ['2F-24', '図書室 古本市',     '準備中', '', '展示',     2, '', 0],
    ['3F-12', 'CAI教室 体験',      '準備中', '', '体験',     3, '', 0],
    ['0F-01', 'ふれあい広場 屋台', '準備中', '', '食べ物',   0, '', 0]
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
  if (SS_CACHE_) return SS_CACHE_;
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (!ss) throw new Error('スプレッドシートを開けません。SPREADSHEET_ID を確認してください');
  SS_CACHE_ = ss;
  return ss;
}

/** 書き込み系をまとめて直列化する。来場者カウントとお知らせも必ずこれを通す */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('busy: 混み合っています。少し待ってもう一度押してください');
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * セルの値を日付にする。
 * 先生が時刻列を手で「10:30」と打ち直しても、そのブースだけ「情報なし」に
 * 落ちないようにする（実際に起きやすい操作）。
 */
function toDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var t = String(v == null ? '' : v).trim();
  if (!t) return null;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {          // 「10:30」＝今日のその時刻
    var p = t.split(':'), d = new Date();
    d.setHours(Number(p[0]), Number(p[1]), Number(p[2] || 0), 0);
    return d;
  }
  var d2 = new Date(t.replace(/-/g, '/'));
  return isNaN(d2.getTime()) ? null : d2;
}

/** 全角数字・「5人」なども数値として拾う。数にできなければ null */
function toNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var t = String(v == null ? '' : v).trim()
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[^0-9.\-]/g, '');
  if (t === '') return null;
  var n = Number(t);
  return isFinite(n) ? n : null;
}

/** 長すぎる文字列を切る。キャッシュ(1件100KB)を超えると全体が遅くなる */
function cut_(v, n) {
  var t = String(v == null ? '' : v).trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** ステータスの検証。`in` はプロトタイプ（toString など）も通してしまう */
var STATUS_LIST = ['空いています', 'やや混雑', '混雑しています', '準備中'];
function isStatus_(v) { return STATUS_LIST.indexOf(String(v)) >= 0; }
function statusLevel_(v) {
  return Object.prototype.hasOwnProperty.call(STATUS_LEVEL, v) ? STATUS_LEVEL[v] : undefined;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」が見つかりません。migrate を実行してください');
  return sh;
}

function headerIndex_(sh) {
  var lc = sh.getLastColumn();
  if (lc < 1) throw new Error('「' + sh.getName() + '」シートが空です。migrate を実行してください');
  var head = sh.getRange(1, 1, 1, lc).getValues()[0];
  var idx = {};
  head.forEach(function (h, i) { idx[String(h).trim()] = i; });
  return idx;
}

/**
 * 必須の見出しが揃っているか確認する。
 * 1行目を消す・「id」を「ID」に直す、といった操作をされると
 * 例外も出ないまま全行が無視され、「ブース0件」になって原因が分からなくなる。
 */
function requireCols_(idx, cols) {
  var miss = [];
  cols.forEach(function (c) { if (idx[c] == null) miss.push(c); });
  if (miss.length) {
    throw new Error('「' + SHEET_MAIN + '」シートの1行目（見出し）が違います。'
      + miss.join('・') + ' がありません。1行目は ' + HEADERS.join(' / ') + ' にしてください');
  }
}

// 総当たり対策。連続で外し続けたら一定時間だけ受け付けない
var LOGIN_MAX_FAILS = 10;
var LOGIN_LOCK_SEC  = 90;

/**
 * 失敗回数は端末ごとに数える。
 * 全員で1つのカウンタを共有していると、パスワードを変えた直後に
 * 数人が古い値で試すだけで合計10回に達し、正しい係員まで90秒締め出されていた。
 * （わざと外し続ければ誰でも全係員を止められる状態でもあった）
 */
function checkPass_(pass, cid) {
  var real = PropertiesService.getScriptProperties().getProperty('ADMIN_PASS');
  if (!real) throw new Error('サーバー側にパスワードが未設定です');

  var key = 'pwf_' + String(cid || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get(key) || 0);
  if (fails >= LOGIN_MAX_FAILS) throw new Error('locked: 何度も違っています。しばらく待ってからお試しください');

  if (String(pass || '') !== real) {
    cache.put(key, String(fails + 1), LOGIN_LOCK_SEC);
    // 初回から待たせると、打ち間違いのたびに実行枠を長く占有してしまう
    Utilities.sleep(Math.min(150 * fails, 1000));
    throw new Error('unauthorized');
  }
  if (fails) cache.remove(key);
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

  // キャッシュが切れた瞬間、そこに来たリクエストが全部シートを読みに行くと
  // 同時実行の上限(30)を超えて全員が失敗する（昼のピークで起きる）。
  // 再構築は1本だけにして、他は少し古い控えをすぐ返す。
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(CACHE_KEY);
    if (hit) return out_(hit);

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(0)) {                       // 誰かが作っている最中
      var bak = cache.get(CACHE_BAK);
      if (bak) return out_(bak);                  // 数秒古いだけなので待たずに返す
      if (!lock.tryLock(8000)) return out_(cache.get(CACHE_BAK) || JSON.stringify(
        { ok: false, error: 'busy' }));
    }
    try {
      hit = cache.get(CACHE_KEY);                 // 待っている間に出来ていることがある
      if (hit) return out_(hit);
      var payload = JSON.stringify(buildPayload_());
      // 1件100KBを超えると put が失敗し、以後ずっとキャッシュ無しで走ってしまう
      if (payload.length > 90000) {
        var slim = buildPayload_();
        slim.booths.forEach(function (b) { b.history = []; });
        payload = JSON.stringify(slim);
      }
      cache.put(CACHE_KEY, payload, CACHE_SEC);
      cache.put(CACHE_BAK, payload, BACKUP_SEC);
      return out_(payload);
    } finally { try { lock.releaseLock(); } catch (e) {} }
  } catch (err) {
    // 障害時も、直前の控えがあればそれを返す（画面が真っさらになるより良い）
    try {
      var last = CacheService.getScriptCache().get(CACHE_BAK);
      if (last) return out_(last);
    } catch (e2) {}
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function out_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function buildPayload_() {
  var sh = sheet_(SHEET_MAIN);
  var idx = headerIndex_(sh);
  requireCols_(idx, ['id', 'name', 'status', 'time']);
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

      var ts = toDate_(r[idx['time']]);
      var iso = ts ? ts.toISOString() : null;
      var status = String(r[idx['status']] || '').trim();
      // 空セルは「人数が分からない」。Number('') は 0 になってしまうので先に弾く
      var wn = idx['wait'] != null ? toNum_(r[idx['wait']]) : null;
      var wait = (wn !== null && wn >= 0) ? Math.round(Math.min(wn, 999)) : null;

      // 更新が途絶えたブースは「情報なし」として返す。
      // 「準備中」は意図して設定した状態なので対象外。
      var stale = false;
      if (status && status !== '準備中') {
        if (!ts || now - ts.getTime() > staleMs) {
          stale = true; status = ''; wait = null;
        }
      }

      booths.push({
        id: id,
        name: cut_(r[idx['name']], 40),
        status: status,
        stale: stale,
        wait: wait,
        time: iso,
        category: idx['category'] != null ? String(r[idx['category']] || 'その他').trim() : 'その他',
        floor: idx['floor'] != null ? floorOf_(r[idx['floor']]) : 1,
        note: idx['note'] != null ? cut_(r[idx['note']], 120) : '',
        image: idx['image'] != null ? cut_(r[idx['image']], 300) : '',
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
    visitors: readVisitors_(),
    booths: booths
  };
}

/**
 * 受付でカウントした当日の来場者数。
 * 加算・減算の履歴として持つ（打ち間違いを引き算で戻せるようにするため）。
 */
function readVisitors_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_VISITORS);
  if (!sh || sh.getLastRow() < 2) return { today: 0, updatedAt: null };
  var tz = TZ;   // シートのロケールに引きずられない
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  var total = 0, last = null;
  rows.forEach(function (r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(ts.getTime())) return;
    if (Utilities.formatDate(ts, tz, 'yyyy-MM-dd') !== today) return;
    var d = Number(r[1]);
    if (isNaN(d)) return;
    total += d;
    last = ts;
  });
  return { today: total, updatedAt: last ? last.toISOString() : null };
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
  var tz = TZ;   // 表示・集計の基準は常に日本時間
  var grouped = {};

  rows.forEach(function (r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(ts.getTime()) || ts.getTime() < since) return;
    var id = String(r[1]).trim();
    var lv = statusLevel_(String(r[2]).trim());
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
  var tz = TZ;   // 表示・集計の基準は常に日本時間
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
                buckets: [], booths: [], overall: [],
                visitors: { total: 0, series: [] }, summary: null };
  if (!log || log.getLastRow() < 2) return empty;

  var rows = log.getRange(2, 1, log.getLastRow() - 1, Math.max(log.getLastColumn(), 3)).getValues();
  var day = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };

  var entries = [];
  rows.forEach(function (r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(ts.getTime())) return;
    var lv = statusLevel_(String(r[2]).trim());
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

  // 来場者の入りを同じ時間バケットで集計する
  var vis = new Array(buckets.length).fill(0);
  var visTotal = 0;
  var vsh = ss.getSheetByName(SHEET_VISITORS);
  if (vsh && vsh.getLastRow() >= 2) {
    vsh.getRange(2, 1, vsh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
      if (isNaN(ts.getTime()) || day(ts) !== target) return;
      var d = Number(r[1]);
      if (isNaN(d)) return;
      visTotal += d;
      var i = Math.round((floorTo(ts.getTime()) - t0) / msBucket);
      if (i >= 0 && i < vis.length) vis[i] += d;
    });
  }

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
    visitors: { total: visTotal, series: vis },
    summary: {
      peakTime: peak ? peak.t : null,
      peakBusyCount: peak ? peak.busy : 0,
      busiestBooth: busiest ? busiest.name : null,
      busiestMinutes: busiest ? busiest.busyMinutes : 0,
      totalUpdates: totalUpdates,
      visitorsTotal: visTotal,
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
      checkPass_(body.pass, body.cid);
      return json_({ ok: true });
    }

    if (action === 'update') {
      checkPass_(body.pass, body.cid);
      if (!body.id) throw new Error('bad request');

      // wait の3状態を区別する：
      //   キーが無い        … 人数列を触らない
      //   null / 空文字     … 人数を消す（3段階ボタンだけで更新したとき）
      //   数値              … その人数にする
      var wait;
      if ('wait' in body) {
        if (body.wait === null || body.wait === '') {
          wait = null;
        } else {
          var wn = Number(body.wait);
          // 1e999 は Infinity になり isNaN を通り抜けてしまう。上限も決めておく
          if (!isFinite(wn) || wn < 0 || wn > 999) throw new Error('bad wait');
          wait = Math.round(wn);
        }
      }

      // 人数が来ていてステータス指定が無ければ、人数から自動判定する
      var status = isStatus_(body.status) ? String(body.status) : null;
      if (!status && wait !== null && wait !== undefined) status = statusFromWait_(wait);
      if (!status) throw new Error('bad request');

      var n = writeBooth_([String(body.id).trim()], status, wait);
      if (!n) throw new Error('該当するIDがありません: ' + body.id);
      return json_({ ok: true, status: 'success', appliedStatus: status, updated: n });
    }

    // 本部からその場でお知らせを出す。スプレッドシートを開かずに流せるようにする。
    // 落とし物・ステージ開始・雨天対応など、当日は「すぐ出す」ことに価値がある
    if (action === 'notice') {
      checkPass_(body.pass, body.cid);
      var text = String(body.text || '').trim().slice(0, 200);
      var level = body.level === 'alert' ? 'alert' : 'info';
      // 本部の2人が同時に流すと、先に出した方が黙って消えていた
      withLock_(function () {
        var nt = ss_().getSheetByName(SHEET_NOTICE);
        if (!nt) {
          nt = ss_().insertSheet(SHEET_NOTICE);
          nt.getRange(1, 1, 1, 3).setValues([['text', 'level', 'enabled']]).setFontWeight('bold');
        }
        if (nt.getLastRow() < 2) nt.getRange(2, 1, 1, 3).setValues([['', 'info', false]]);
        nt.getRange(2, 1, 1, 3).setValues([[text, level, text ? true : false]]);
        // 書き込みを確定させてからキャッシュを消す。
        // 逆にすると、確定前の内容が新しいキャッシュとして焼き付いてしまう
        SpreadsheetApp.flush();
        clearCache_();
      });
      return json_({ ok: true, status: 'success', notice: readNotice_() });
    }

    if (action === 'visitor') {
      checkPass_(body.pass, body.cid);
      var n = Math.round(Number(body.n));
      if (isNaN(n) || n === 0 || Math.abs(n) > 1000) throw new Error('bad count');
      // 受付が2台で同時に押すと、同じ行番号を計算して片方が消えていた
      withLock_(function () {
        var vs = ss_().getSheetByName(SHEET_VISITORS);
        if (!vs) {
          vs = ss_().insertSheet(SHEET_VISITORS);
          vs.getRange(1, 1, 1, 3).setValues([['timestamp', 'delta', 'memo']]).setFontWeight('bold');
        }
        vs.appendRow([new Date(), n, cut_(body.memo, 100)]);
        SpreadsheetApp.flush();
        clearCache_();
      });
      return json_({ ok: true, status: 'success', visitors: readVisitors_() });
    }

    if (action === 'bulk') {
      checkPass_(body.pass, body.cid);
      var st = isStatus_(body.status) ? String(body.status) : '空いています';
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
  return withLock_(function () {
    var sh = sheet_(SHEET_MAIN);
    var idx = headerIndex_(sh);
    requireCols_(idx, ['id', 'status', 'time']);
    var last = sh.getLastRow();
    if (last < 2) return 0;

    var idCol = idx['id'] + 1, stCol = idx['status'] + 1, tmCol = idx['time'] + 1;
    var wtCol = idx['wait'] != null ? idx['wait'] + 1 : null;

    // セルを1つずつ書くと、20件の一括更新で60回の書き込みになり、
    // その間ずっと他の係員がロック待ちで弾かれる（開場・閉場の直後に必ず起きる）。
    // まとめて読み、メモリ上で直し、1回で書き戻す。
    var width = Math.max(idCol, stCol, tmCol, wtCol || 0);
    var block = sh.getRange(2, 1, last - 1, width).getValues();
    var now = new Date();
    var logs = [];
    var updated = 0;

    for (var i = 0; i < block.length; i++) {
      var id = String(block[i][idCol - 1] == null ? '' : block[i][idCol - 1]).trim();
      if (!id) continue;
      if (ids && ids.indexOf(id) === -1) continue;
      block[i][stCol - 1] = status;
      block[i][tmCol - 1] = now;
      if (wtCol && wait !== undefined) block[i][wtCol - 1] = (wait === null ? '' : wait);
      logs.push([now, id, status, (wait === null || wait === undefined) ? '' : wait]);
      updated++;
    }
    if (!updated) return 0;

    sh.getRange(2, 1, block.length, width).setValues(block);
    appendLogs_(logs);
    SpreadsheetApp.flush();      // 確定してからキャッシュを捨てる
    clearCache_();
    return updated;
  });
}

/** 配信用キャッシュを捨てる。控えも一緒に消さないと古い方が返り続ける */
function clearCache_() {
  try { CacheService.getScriptCache().removeAll([CACHE_KEY, CACHE_BAK]); } catch (e) {}
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
  // 削除はロックを握ったまま走る重い処理。閾値を上げすぎず、一度に減らしすぎない
  if (last > 10000) sh.deleteRows(2, last - 8000);
}

/**
 * 来場者シートは毎リクエスト全行を読むので、年々増えると全体が重くなる。
 * 履歴と同じように古い行を捨てる（当日分は必ず残る量にしてある）。
 */
function trimVisitors_() {
  var sh = ss_().getSheetByName(SHEET_VISITORS);
  if (!sh) return;
  var last = sh.getLastRow();
  if (last > 5000) sh.deleteRows(2, last - 4000);
}

/* ====================== 任意：定時リセット用 ======================
   時間主導型トリガー（毎日 8:00 など）に resetDaily を設定すると、
   前日の状態が残ったまま当日を迎えるのを防げる。
   ================================================================= */
function resetDaily() {
  writeBooth_(null, '準備中', 0);
}
