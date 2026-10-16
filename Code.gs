/* 黒工文化祭 校内マップ — サーバー側 (Google Apps Script)
   GAS-2026-09-28c
   2026-09-28c: スタンプの控えは、足す行があるときだけシートを開く（送り直しを速く）。
   2026-09-28b: 配信キャッシュを60秒に（書き込み・シートの手直し onEdit で即座に捨てる）。
   2026-09-28a: 版の番号（serverVersion）を返す。係員画面で貼り替え忘れを見分ける。
   2026-09-27a: 作り直しの途中で書き込みがあった結果で、控えを古い内容に差し替えない。
   2026-09-26c: 地図の再構築を係員のロックから切り離した（ピーク時の busy 連鎖）。つなぐ操作は写し終えてから付け替える。
                交換はロック内で確定してから放す。係員の入力は数式として解釈させない。
   2026-09-26b: 番号の統合（旧番号→新番号）・台帳の読み出しキャッシュ・追記の上限。
                振り返りのスタンプ数は取った時刻で重複を除いて数える。
   2026-09-26a: スタンプ番号（8文字）で台帳を引けるようにした。端末の中身をまるごと受け取り、
                台帳の中身を返す（別のアプリで集めた分も1往復で揃う）。控えの読み出しをまとめて1回に。
   2026-09-21a: ADMIN_PASS は8文字以上でないと受け付けない。
                cid を毎回変える総当たりを、全体の失敗数で捕まえて遅らせる
                （正しいパスワードは遅らせも止めもしない）。
   2026-09-20a: writeBooth_ が id〜wait の全列を書き戻しており、
                係員の更新と先生のシート編集が重なると name / category / floor / note が
                「読んだ時点の値」で上書きされて消えていた。
                status / time / wait の3列だけを書くようにした。 */
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

// スプレッドシートのIDはコードに書かない（公開リポジトリにそのまま載ってしまうため）。
// このスクリプトはシートに紐づいている（拡張機能 → Apps Script から開いたもの）ので、
// ふだんは getActiveSpreadsheet() だけで開ける。
// 別のシートを指したいときだけ、プロジェクトの設定 → スクリプト プロパティに
// SPREADSHEET_ID を入れる。入っていなくても動く。
function spreadsheetId_() {
  try { return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || ''; }
  catch (e) { return ''; }
}

var SHEET_MAIN     = 'ブース';
var SHEET_LOG      = '履歴';
var SHEET_NOTICE   = 'お知らせ';
var SHEET_VISITORS = '来場者';
/** この Code.gs の版。係員画面が「サーバーが古いまま」を見分けるのに使う（貼り替えたら新バージョンでデプロイ） */
var GAS_VERSION = '2026-10-16a';
var SHEET_LEDGER   = 'スタンプ記録';     // 来場者のスタンプ獲得・お菓子交換の控え（消さない）
var SHEET_ALIAS    = 'スタンプ番号の統合'; // 番号をつないだ記録（旧番号→新番号）。旧番号で開いても新番号に乗り換える
var SHEET_LOG_ARC  = '履歴_保管';        // 履歴シートから移した古い行（消さずにここへ移す）
var SHEET_REMOVED  = '削除したブース';   // 地図から外したブース行の控え
var SHEET_NOTICE_LOG = 'お知らせ履歴';  // 出したお知らせの控え

var CACHE_KEY = 'payload_v3';
var CACHE_BAK = 'payload_v3_bak';   // 再構築中に返す少し古い控え
// 地図データの配信キャッシュ。係員の更新・お知らせ・受付・割り当ては書いた瞬間に捨てる（clearCache_）ので、
// 長くしても古い状況は出ない。15秒だと来場者1人（20秒間隔）の取得は毎回作り直し（本番実測 +2〜3秒）になっていた。
// シートを手で直したときも onEdit で捨てる
var CACHE_SEC = 60;
var BACKUP_SEC = 300;
var CACHE_BUILDING = 'payload_v3_building';   // 再構築中の印（10秒で自然に消える）
var CACHE_GEN = 'payload_v3_gen';             // 書き込みのたびに変わる番号
var CACHE_BAK_AT = 'payload_v3_bak_at';       // 控えを作った時刻
// v213（GAS 2026-10-13a）：推移（履歴シートの直近3時間）と来場者数の集計は、配信データとは別に覚えておく。
// 係員の更新のたびに配信データは作り直すが、そのたびに履歴 6000 行・来場者の全行を読み直していた（作り直しの時間の大半）。
// 推移は 90 秒おくれてよい（混み具合・待ち人数そのものは、これまでどおり更新の直後に出る）
var CACHE_HIST = 'hist_v1';
var HIST_CACHE_SEC = 90;
var CACHE_VIS = 'vis_v1_';                    // うしろに日付（日付が変わったら数え直す）
var VIS_CACHE_SEC = 120;
// 1回の送信で受ける大きさの上限（文字数）。正しい送信でいちばん大きいのはスタンプの控え（400件で約3万字）
var POST_MAX_CHARS = 120000;

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

// dept … 出し物をしている科（機械科・電子機械科など）。棟と科が違う部屋（製図室の電子機械科 Em④ など）でも
//        科の絞り込みで正しく出すため。空でもよい（そのときは棟で判定する）
var HEADERS = ['id', 'name', 'status', 'time', 'category', 'floor', 'note', 'wait', 'image', 'dept'];

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
    // 見出しは大文字小文字を区別しない（「ID」を別物と見て空の id 列を足すと、
    // エラーも出ずにブース0件になり原因が分からなくなる）
    var head = main.getRange(1, 1, 1, Math.max(main.getLastColumn(), 1)).getValues()[0]
                   .map(function (h) { return String(h).trim().toLowerCase(); });
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
        .requireValueInList(['0', '1', '2', '3'], true).setAllowInvalid(false).build());
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
  var advice = [];      // 直さなくても動くが、本番前に見ておきたいこと（v152）

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
  } else if (PropertiesService.getScriptProperties().getProperty('ADMIN_PASS').length < 12) {
    advice.push('係員パスワードは8〜11文字です。本番前に英数字12文字以上へ変えるのがおすすめです（変えたら係員に伝える）');
  }
  // 出しっぱなしのお知らせ。テストで出したものが本番の全員の画面に残る事故を防ぐ
  try {
    var nt = readNotice_();
    if (nt) advice.push('いまお知らせが全員の画面に出ています：「' + nt.text + '」（' + (nt.level === 'alert' ? '重要' : 'ふつう')
      + '）。テストの残りなら係員画面の「お知らせ」で消してください');
  } catch (eN) {}
  // 当日の負荷対策の状態
  try {
    var warm = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'warmCache'; });
    advice.push(warm ? '先読み（warmCache）：1分ごとに動いています（文化祭が終わったら removeWarmTrigger）'
                     : '先読み（warmCache）：止まっています（当日の前日に installWarmTrigger を1回実行すると、混んだときに速くなります）');
  } catch (eT) {}
  advice.push('自動更新の間隔（POLL_SEC）：' + (pollSec_() ? pollSec_() + '秒' : '画面の設定のまま（変わったかを3〜6秒ごとに確かめ、変わったときだけ取り直す。POLL_SEC を入れると、この確かめを止めて、その秒数ごとの取り直しだけにする）'));
  try {
    var ce = clientErrorsToday_();
    if (ce) advice.push('端末で起きたエラー：今日 ' + ce + '件（「' + SHEET_CLIENT_ERR + '」シート。同じものが多ければ不具合の手がかり）');
  } catch (eCE) {}
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
    // R8 の一覧（R8_BOOTHS）とシートの食い違い。QR を刷るのは一覧のブースなので、シートに無いと
    // 刷った QR を読んでも「見つかりません」になる
    var inSheet = {};
    rows.forEach(function (r) { var v = String(r[idx['id']] || '').trim(); if (v) inSheet[v] = true; });
    var r8 = {};
    R8_BOOTHS.forEach(function (b) { r8[b[0]] = true; });
    var lack = Object.keys(r8).filter(function (k) { return !inSheet[k]; });
    var extra = Object.keys(inSheet).filter(function (k) { return !r8[k]; });
    if (lack.length) problems.push('R8 の一覧にあるのにシートに無いブース：' + lack.join('・') + '（setupR8 を実行すると足されます）');
    if (extra.length) advice.push('R8 の一覧に無いブースがシートにあります：' + extra.join('・') + '（意図して足したものなら問題ありません）');
    rows.forEach(function (r, i) {
      var line = 'A' + (i + 2) + ': ';
      var id = String(r[idx['id']] || '').trim();
      if (!id) { problems.push(line + 'id が空です'); return; }
      if (seen[id]) problems.push(line + 'id「' + id + '」が重複しています');
      seen[id] = true;
      if (!String(r[idx['name']] || '').trim()) problems.push(line + 'name が空です');
      // v213：長すぎる名前・メモは、画面では途中で切って「…」を付ける。気づかないまま当日を迎えないように知らせる
      if (String(r[idx['name']] || '').trim().length > 40) advice.push(line + 'name が40字を超えています（画面では40字で切れて「…」が付きます）');
      if (idx['note'] != null && String(r[idx['note']] || '').trim().length > 120) advice.push(line + 'note が120字を超えています（画面では120字で切れます）');
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
  // 【v152】バイトで数える。以前は文字数で数えていたため、日本語（1文字3バイト）の分を最大3分の1に見誤っていた
  var size = 0;
  try { size = bytes_(JSON.stringify(buildPayload_())); } catch (e) {}
  if (size > 80000) problems.push('配信データが大きすぎます（' + Math.round(size / 1024)
    + 'KB）。メモや画像URLを短くしてください');

  var msg = (problems.length
    ? '要確認 ' + problems.length + '件\n・' + problems.join('\n・')
    : '問題は見つかりませんでした。')
    + tail + '\n配信データの大きさ：' + Math.round(size / 1024) + 'KB（上限のめやす 80KB）'
    + (advice.length ? '\n\n【参考】\n・' + advice.join('\n・') : '');
  Logger.log(msg);
  return msg;
}

/** 階の読み取り。0=屋外／1F／2F／3F。それ以外は 1 とみなす */
function floorOf_(v) {
  var n = Number(v);
  return [0, 1, 2, 3].indexOf(n) >= 0 ? n : 1;
}

/**
 * R8（令和8年度）黒工祭のブース一覧。[部屋ID, ブース名, 分類, 科, メモ]
 * 出典：R8 黒工祭企画内容一覧（9/7 黒工祭総務）と R8 黒工祭校舎平面図の赤字（Em① M② など）。
 * 部屋IDは 部屋ID一覧.xlsx と index.html の FLOOR_PLAN。1F-60・1F-61・2F-28 は R8 で足した場所。
 * 変更は setupR8() を実行し直せば反映される（混雑状況・待ち人数は消えない）。
 */
var R8_BOOTHS = [
  ["1F-48", "受付（南棟昇降口）", "受付", "", "一般の方の受付。来賓の方は本館玄関の来賓受付へ"],
  ["1F-01", "アームロボット・ライントレーサー", "展示", "電子機械科", "Em① アームロボットの実演、ライントレーサー、シーケンス制御（FA実習室）"],
  ["1F-14", "LED点滅装置と単軸テーブル", "展示", "電子機械科", "Em② LED点滅装置と単軸テーブルの展示（電気実習室）"],
  ["1F-24", "NC旋盤の実演", "展示", "電子機械科", "Em③ NC旋盤の実演（制御実習室）"],
  ["1F-17", "3D CADと3Dプリンタ", "体験", "電子機械科", "Em④ 3D CADの演習と3Dプリンタの実演（製図室）"],
  ["1F-02", "旋盤の加工実演", "展示", "機械科", "M① 旋盤の加工実演（機械加工室）"],
  ["1F-03", "マシニングセンタでプレート製作", "展示", "機械科", "M② マシニングセンターによるプレートの製作（計測実習室）"],
  ["1F-05", "溶接実演とバーベキューコンロ製作", "展示", "機械科", "M③ 溶接実演とバーベキューコンロの製作（溶接実習室）"],
  ["1F-07", "エンジンの分解・組立", "展示", "機械科", "M④ エンジンの分解・組立（原動機実験室）"],
  ["1F-08", "ミニ工場見学", "体験", "材料技術科", "Z① 旋盤・NCフライス盤を使って製作（切削加工室）"],
  ["1F-19", "化学縁日", "体験", "材料技術科", "Z② 液体窒素を使った実験ほか（セラミック室）"],
  ["1F-21", "射出成形・キーホルダー製作", "体験", "材料技術科", "Z③ 射出成形機の運転、プラ板キーホルダー・黒工キーホルダーの製作と配布（高分子材料室）"],
  ["1F-25", "鉄筋の引張試験", "展示", "土木科", "C① 鉄筋の引張試験（材料試験室）"],
  ["1F-60", "建設機材の運転体験", "体験", "土木科", "C② 屋外特設会場。雨天中止・小雨決行"],
  ["1F-38", "ドローンの操縦体験", "体験", "土木科", "C③ ドローンの操縦体験（測量実習室）"],
  ["1F-29", "電気のつくりかた・電磁石つり", "体験", "電気科", "E① 各種発電の原理／E② 電気で磁石をつくって釣りしよう／E④ シーケンスってなに？（工作工事実習室）"],
  ["1F-30", "電気工事体験", "体験", "電気科", "E③ 配線結線、ものづくりコンテストの実演（製図実習室）"],
  ["1F-39", "電気工事業組合の展示", "展示", "電気科", "E⑤ 電気工事業組合の展示（自動制御実習室）"],
  ["2F-12", "電子科を知ろう！", "展示", "電子科", "EL① 電子科の学習と進路の紹介（計測実習室）"],
  ["2F-13", "電子科を知ろう！（電子計算機室）", "展示", "電子科", "EL① 電子科の学習と進路の紹介（電子計算機室）"],
  ["2F-14", "専攻科の紹介・レーザー加工", "体験", "専攻科", "S① 紹介映像、実習装置の展示と体験、岩手大学・デンソー岩手での作品展示、レーザー加工機でコースター製作"],
  ["2F-21", "修了研究・グループ研究の作品", "展示", "専攻科", "S② 修了研究作品・グループ研究作品の展示（専攻科2年HR）"],
  ["1F-11", "大会・技能検定の課題紹介", "展示", "専攻科", "S③ 若年者ものづくり競技会の課題、技能検定2級の課題、数値制御工作機械の作品"],
  ["1F-33", "カラダ探し（電子機械科3年）", "体験", "電子機械科", "電子機械科3年のクラス企画"],
  ["1F-34", "めんずお茶会クラブ（機械科3年）", "食べ物", "機械科", "機械科3年のクラス企画"],
  ["1F-35", "メイド喫茶・カジノ（電子科3年）", "食べ物", "電子科", "電子科3年「推進力」メイド喫茶、ベイブレード広場、カジノ"],
  ["1F-36", "コスプレ喫茶（土木科3年）", "食べ物", "土木科", "土木科3年のクラス企画。コスプレ喫茶、フォトスポット"],
  ["2F-17", "新科紹介", "展示", "", ""],
  ["2F-18", "無線の世界を体験しよう（無線部）", "体験", "", "無線・フィギュア展示、ドローン体験など"],
  ["2F-19", "水泳部", "展示", "", "動画放映、用具・部の歴史の展示"],
  ["2F-20", "写真部", "展示", "", "フォトスポット、ストリートスナップ、写真展示"],
  ["2F-28", "美術・家庭科の作品展示", "展示", "", "2階廊下。美術の授業作品（てぬぐい）、ファスナーポーチ・ホームプロジェクト、美術部の作品"],
  ["1F-50", "射的・仮装シールラリー（生徒会）", "体験", "", "10月24日（土）のみ（DXルーム）"],
  ["1F-49", "PTA母親委員会", "展示", "", "内容は決まりしだいお知らせします（選択3）"],
  ["1F-42", "ステージ（第一体育館）", "イベント", "", "カラオケ大会（1日目・生徒会）、吹奏楽部「一心同音」（23日のみ）、1学年音楽選択者による合唱"],
  ["1F-57", "飲食ブース（第二体育館）", "食べ物", "", "飲食はここで。キッチンカーは第二体育館の前"],
  ["1F-61", "キッチンカー", "食べ物", "", "業者による販売。食べる場所は第二体育館の飲食ブース"],
  ["1F-58", "記念館公開（同窓会）", "展示", "", "黒工の資料展示"],
  ["2F-06", "企業ブース（電子機2教室）", "展示", "", "各企業の紹介と製品の展示"],
  ["2F-07", "企業ブース（機械2教室）", "展示", "", "各企業の紹介と製品の展示"],
  ["2F-08", "企業ブース（材料2教室）", "展示", "", "各企業の紹介と製品の展示"],
  ["2F-09", "企業ブース（土木2教室）", "展示", "", "各企業の紹介と製品の展示"],
  ["3F-01", "企業ブース（電子機1教室）", "展示", "", "各企業の紹介と製品の展示"],
  ["3F-02", "企業ブース（機械1教室）", "展示", "", "各企業の紹介と製品の展示"],
  ["3F-03", "企業ブース（材料1教室）", "展示", "", "各企業の紹介と製品の展示"],
  ["3F-04", "企業ブース（土木1教室）", "展示", "", "各企業の紹介と製品の展示"]
];

/** ブースの初期データ。空のシートに R8 の一覧を入れる（既にデータがあれば何もしない） */
function seedBooths() {
  var sh = sheet_(SHEET_MAIN);
  if (sh.getLastRow() >= 2) {
    Logger.log('既にデータがあります。中止しました。R8 の一覧に合わせるなら setupR8() を実行してください');
    return;
  }
  setupR8_(false);
}

/**
 * R8 の一覧に合わせる（足りないブースを足し、名前・分類・科・メモを一覧どおりにする）。
 * 状態・時刻・待ち人数は触らないので、当日に実行しても混雑表示は消えない。
 * 一覧に無いブース（試しに作った 1〜8 など）は残す。消すなら setupR8AndArchiveOthers()。
 */
function setupR8() { return setupR8_(false); }
/** setupR8 に加えて、一覧に無いブースを「削除したブース」シートへ移す（行の中身は控えに残る） */
function setupR8AndArchiveOthers() { return setupR8_(true); }

function setupR8_(archive) {
  migrate();   // dept 列など、足りない列を先に作る
  var res = withLock_(function () {
    var sh = sheet_(SHEET_MAIN);
    var idx = headerIndex_(sh);
    requireCols_(idx, ['id', 'name', 'status', 'time']);
    var width = sh.getLastColumn();
    var last = sh.getLastRow();
    var rows = last >= 2 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
    var head = sh.getRange(1, 1, 1, width).getValues()[0];
    var idOf = function (r) { return String(r[idx['id']] == null ? '' : r[idx['id']]).trim(); };
    var byId = {};
    rows.forEach(function (r) { var id = idOf(r); if (id && !byId[id]) byId[id] = r; });

    var want = {}, out = [], added = 0, updated = 0;
    R8_BOOTHS.forEach(function (b) {
      var id = b[0];
      if (want[id]) return;             // 一覧の重複は最初の1件だけ
      want[id] = true;
      var row = byId[id];
      if (row) updated++;
      else {
        row = []; for (var k = 0; k < width; k++) row.push('');
        added++;
      }
      row[idx['id']] = id;
      row[idx['name']] = safeText_(cut_(b[1], 40));
      if (idx['category'] != null) row[idx['category']] = safeText_(cut_(b[2], 20));
      if (idx['floor'] != null) row[idx['floor']] = floorOf_(id.charAt(0));
      if (idx['note'] != null) row[idx['note']] = safeText_(cut_(b[4], 120));
      if (idx['dept'] != null) row[idx['dept']] = safeText_(cut_(b[3], 12));
      out.push(row);
    });
    // 一覧に無い行（空行は捨てる）
    var others = rows.filter(function (r) { var id = idOf(r); return id && !want[id]; });
    if (archive) {
      others.forEach(function (r) {
        appendTo_(SHEET_REMOVED, ['removedAt'].concat(head),
          [new Date()].concat(r.map(function (v) { return typeof v === 'string' ? safeText_(v) : v; })));
      });
    } else {
      out = out.concat(others);
    }
    // 一覧の順に並べ直して一度に書く（1行ずつ書くと遅く、途中で係員の更新と交互になる）
    var need = 1 + out.length - sh.getMaxRows();
    if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
    if (out.length) sh.getRange(2, 1, out.length, width).setValues(out);
    var extra = rows.length - out.length;
    if (extra > 0) sh.deleteRows(2 + out.length, extra);
    SpreadsheetApp.flush();
    clearCache_();
    return { added: added, updated: updated,
             kept: archive ? 0 : others.length, archived: archive ? others.length : 0,
             otherIds: others.map(idOf) };
  });
  Logger.log('R8 の一覧に合わせました：追加 ' + res.added + ' 件／更新 ' + res.updated + ' 件'
    + (res.archived ? '／一覧に無い ' + res.archived + ' 件を「' + SHEET_REMOVED + '」へ移しました' : '')
    + (res.kept ? '／一覧に無いブースが ' + res.kept + ' 件残っています（' + res.otherIds.join(', ')
       + '）。消すなら setupR8AndArchiveOthers() を実行' : ''));
  return res;
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
  if (!ss) { var id = spreadsheetId_(); if (id) ss = SpreadsheetApp.openById(id); }
  if (!ss) throw new Error('スプレッドシートを開けません。Apps Script はスプレッドシートの'
    + '「拡張機能 → Apps Script」から開いてください');
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
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    // 「10:30」とだけ打つと、シートは 1899-12-30 10:30 の日付として持つ。今日のその時刻に読み替える
    if (v.getFullYear() < 1900) return todayAt_(Utilities.formatDate(v, TZ, 'HH:mm:ss'));
    return v;
  }
  if (typeof v === 'number') {                          // 書式が「数値」のセル（シリアル値）
    if (!isFinite(v) || v <= 0) return null;
    if (v < 1) return todayAt_(Utilities.formatDate(new Date(Math.round(v * 864e5)), 'UTC', 'HH:mm:ss'));   // 時刻だけ
    return new Date(Math.round((v - 25569) * 864e5) - 9 * 3600e3);   // 日本時間として読む
  }
  var t = String(v == null ? '' : v).trim();
  if (!t) return null;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return todayAt_(t);   // 「10:30」＝今日のその時刻
  // ISO形式（2026-09-23T01:30:00.000Z）はそのまま読む。「-」を「/」にすると壊れる
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    var di = new Date(t);
    return isNaN(di.getTime()) ? null : di;
  }
  // 「9/23 10:30」のように年がないと 2001年として読まれる。今年を補う
  if (/^\d{1,2}[\/\-]\d{1,2}(\s|$)/.test(t)) t = Utilities.formatDate(new Date(), TZ, 'yyyy') + '/' + t;
  var m = t.replace(/-/g, '/').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    // 日本時間として組み立てる（スクリプトのタイムゾーン設定に左右されない）
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 9 * 3600e3;
    return new Date(ms);
  }
  var d2 = new Date(t.replace(/-/g, '/'));
  return isNaN(d2.getTime()) ? null : d2;
}

/** 日本時間の「今日」の指定時刻（'HH:mm' / 'HH:mm:ss'）。スクリプトのタイムゾーンに依存しない */
function todayAt_(hms) {
  var p = String(hms).split(':');
  var ymd = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd').split('-');
  return new Date(Date.UTC(+ymd[0], +ymd[1] - 1, +ymd[2], +p[0], +p[1], +(p[2] || 0)) - 9 * 3600e3);
}

/** 全角数字・「5人」なども数値として拾う。数にできなければ null */
function toNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var t = String(v == null ? '' : v).trim()
    .replace(/[０-９．－]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  if (v instanceof Date) return null;                  // 日付に化けたセルは人数ではない
  // 最初に出てくる数だけを使う。「10〜15人」を 1015 と読まないように
  var m = t.replace(/(\d),(?=\d{3}(\D|$))/g, '$1').match(/-?\d+(\.\d+)?/);   // 「1,200」は1200
  if (!m) return null;
  var n = Number(m[0]);
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
  // 大文字小文字は区別しない。同じ見出しが2つあれば左を使う
  // （右に空の列を足されて、本物のメモが消えて見える事故を防ぐ）
  head.forEach(function (h, i) {
    var k = String(h).trim().toLowerCase();
    if (k && idx[k] == null) idx[k] = i;
  });
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
// パスワードの最短長。
// 失敗回数は端末(cid)ごとに数えているが、cid は送る側が自由に決められる。
// 毎回ちがう cid を送れば端末ごとの制限は素通りになり、4桁なら1万通りを
// 並列で数分〜数十分で試し切れてしまう。GAS の同時実行の上で回数制限を
// 工夫しても、4桁を守りきることはできない。守れるのは「長さ」だけ。
var PASS_MIN_LEN = 8;
// 全体での失敗が急に増えたときだけ、失敗した試行を遅らせる。
// 正しいパスワードは遅らせも止めもしないので、正しい係員が締め出されることはない。
var GLOBAL_FAIL_WINDOW_SEC = 60;
var GLOBAL_FAIL_SLOW_AT    = 20;

/**
 * 失敗回数は端末ごとに数える。
 * 全員で1つのカウンタを共有していると、パスワードを変えた直後に
 * 数人が古い値で試すだけで合計10回に達し、正しい係員まで90秒締め出されていた。
 * （わざと外し続ければ誰でも全係員を止められる状態でもあった）
 */
function checkPass_(pass, cid, login, who) {
  var real = PropertiesService.getScriptProperties().getProperty('ADMIN_PASS');
  if (!real) throw new Error('サーバー側にパスワードが未設定です');
  // 短いパスワードは総当たりで破られる。設定し直すまで受け付けない
  //（本番前のログインで必ず気づけるよう、正しい値を入れても通さない）
  if (String(real).length < PASS_MIN_LEN) {
    throw new Error('weak: サーバー側のパスワードが短すぎます。スクリプトプロパティの ADMIN_PASS を '
      + PASS_MIN_LEN + '文字以上に変えてください');
  }

  var key = 'pwf_' + String(cid || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get(key) || 0);
  if (fails >= LOGIN_MAX_FAILS) throw new Error('locked: 何度も違っています。しばらく待ってからお試しください');

  if (String(pass || '') !== real) {
    cache.put(key, String(fails + 1), LOGIN_LOCK_SEC);
    // 全体の失敗回数も数える。cid を毎回変えて総当たりされると
    // 端末ごとの数えは0のままなので、ここでしか気づけない
    var gAll = Number(cache.get('pwf__all') || 0) + 1;
    cache.put('pwf__all', String(gAll), GLOBAL_FAIL_WINDOW_SEC);
    // 初回から待たせると、打ち間違いのたびに実行枠を長く占有してしまう。
    // 全体の失敗が急増しているときだけ、失敗した試行を長めに待たせる
    var wait = Math.min(150 * fails, 1000);
    if (gAll >= GLOBAL_FAIL_SLOW_AT) wait = Math.max(wait, 2500);
    Utilities.sleep(wait);
    throw new Error('unauthorized');
  }
  if (fails) cache.remove(key);
  // v216：パスワードが合ったあとで、この端末が入ってよいかを確かめる（司令塔の「端末ごとの承認」「止める」）。
  // 承認制が切（はじめの状態）のあいだは、止めた端末のほかは、今までどおり通る
  deviceGate_(cid, !!login, who);
}

/* ============================== GET ============================== */
function doGet(e) {
  // ?report=1 で当日の振り返りデータを返す（?date=YYYY-MM-DD で日付指定）
  var param = (e && e.parameter) || {};
  // v236：?gen=1 … 「変わったか」だけを返す（キャッシュの番号を読むだけ。シートもプロパティも読まない）。
  // 端末は数秒ごとにこれを聞き、番号が変わったときだけ本体を取りに来る（GAS は端末へ送り届けられないので、これでリアルタイムに近づける）
  if (param.gen) {
    var gn = '';
    try { gn = CacheService.getScriptCache().get(CACHE_GEN) || ''; } catch (eG) {}
    return json_({ ok: true, gen: gn, serverVersion: GAS_VERSION });
  }
  // ?ledger=端末番号 … その端末のスタンプ記録を返す（別のブラウザ・機種への引き継ぎ用）
  if (param.ledger) {
    try {
      return json_(readLedger_(String(param.ledger)));
    } catch (errL) {
      return json_({ ok: false, error: String(errL.message || errL) });
    }
  }
  // ?win=抽選の番号&cid=スタンプ番号 … その番号が、いまの抽選に当たっているか（v219）。
  // 当たった番号そのものは、だれにも返さない（番号が分かると、スタンプをつないで横取りできるため）
  if (param.win) {
    try {
      return json_(liveWin_(String(param.win), String(param.cid || '')));
    } catch (errW) {
      return json_({ ok: false, error: String(errW.message || errW) });
    }
  }
  if (param.report === '1') {
    try {
      // 日付は YYYY-MM-DD だけ受け付ける（任意の文字列でキャッシュを素通りされないように）
      if (param.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(param.date))) {
        return json_({ ok: false, error: '日付は YYYY-MM-DD の形で指定してください' });
      }
      var key = 'report_' + (param.date || 'today');
      var c = CacheService.getScriptCache();
      var cached = c.get(key);
      if (cached) return ContentService.createTextOutput(cached)
        .setMimeType(ContentService.MimeType.JSON);
      var body = JSON.stringify(buildReport_(param.date));
      try { c.put(key, body, 60); } catch (eC) {}      // 大きすぎて置けなくても結果は返す
      return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return json_({ ok: false, error: String(err.message || err) });
    }
  }

  // キャッシュが切れた瞬間、そこに来たリクエストが全部シートを読みに行くと
  // 同時実行の上限(30)を超えて全員が失敗する（昼のピークで起きる）。
  // 再構築は1本だけにして、他は少し古い控えをすぐ返す。
  // 【係員の書き込みと同じロックは使わない】ピークは係員の更新が数秒おきに来るので、
  // 同じロックだと「再構築できない→控えも無い→8秒待つ」来場者が積み上がり、
  // 係員の送信まで busy で弾かれていた。「作っている最中」の印はキャッシュに置く。
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(CACHE_KEY);
    if (hit) return out_(hit);
    var bak = cache.get(CACHE_BAK);
    if (bak && cache.get(CACHE_BUILDING)) return out_(bak);   // 誰かが作っている最中。数秒古いだけなので待たずに返す
    return out_(buildAndCache_(cache, CACHE_SEC));
  } catch (err) {
    // 障害時も、直前の控えがあればそれを返す（画面が真っさらになるより良い）
    try {
      var last = CacheService.getScriptCache().get(CACHE_BAK);
      if (last) return out_(last);
    } catch (e2) {}
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/**
 * 表示用データを作ってキャッシュに置き、JSON文字列を返す。
 * 来場者の GET と、定期実行の warmCache の両方から使う。
 * ttl … 本体キャッシュの秒数（定期実行は次の実行まで切れないよう長めに置く）
 */
function buildAndCache_(cache, ttl) {
  // v224：予約した一斉お知らせが、時刻どおりに出るように（覚えておく時間を、次の予約の時刻までにする）
  try { ttl = Math.max(1, Math.min(ttl, liveNextDueSec_())); } catch (eT) {}
  try { cache.put(CACHE_BUILDING, '1', 10); } catch (eB) {}
  // 作っている間に係員の更新が入ったら、作った結果はキャッシュに置かない（古い内容を15秒焼き付けない）
  var gen0 = cache.get(CACHE_GEN) || '';
  var data = buildPayload_();
  data.gen = gen0;                                // v236：この中身を作ったときの番号（端末が ?gen=1 の答えと比べる）
  var payload = JSON.stringify(data);
  // 1件100KB（バイト）を超えると put が失敗する。日本語は1文字3バイトなので文字数では測れない。
  // まず推移を半分の点数に間引き、それでも大きければ推移を外す
  var LIMIT = 98000;
  if (bytes_(payload) > LIMIT) {
    data.booths.forEach(function (b) { b.history = (b.history || []).filter(function (_, i, a) { return (a.length - 1 - i) % 2 === 0; }); });
    payload = JSON.stringify(data);
  }
  if (bytes_(payload) > LIMIT) {
    data.booths.forEach(function (b) { b.history = []; });
    payload = JSON.stringify(data);
  }
  // 置けなかったとしても、作った結果は必ず返す（ここで投げると全員に「失敗」が返る）
  try {
    // 控えは常に新しくする（書き込みが続いても、控えが古いまま止まらないように）。
    // 本体のキャッシュは、作っている間に書き込みが無かったときだけ置く
    // 作っている間に書き込みがあった結果は、読んだ時点より前の内容かもしれない。
    // 控えは「書き込みが無かった」か「控えが30秒以上古い」ときだけ差し替える
    // （書き込みが続いても控えが古いまま止まらず、かつ直前の更新を古い内容で上書きしない）
    var same = (cache.get(CACHE_GEN) || '') === gen0;
    var bakAt = Number(cache.get(CACHE_BAK_AT) || 0);
    if (same || Date.now() - bakAt > 30000) {
      cache.put(CACHE_BAK, payload, BACKUP_SEC);
      cache.put(CACHE_BAK_AT, String(Date.now()), BACKUP_SEC);
    }
    if (same) cache.put(CACHE_KEY, payload, ttl);
    cache.remove(CACHE_BUILDING);
  } catch (eC) { console.warn('cache put failed: ' + bytes_(payload) + ' bytes'); }
  return payload;
}

/**
 * 画面の自動更新の間隔（秒）を、画面を配り直さずに延ばすためのつまみ。
 * スクリプトプロパティ POLL_SEC に 10〜120 の数を入れると、全員の端末がそれより速くは取りに来なくなる。
 * 当日 GAS が重い（「混み合っています」が続く）ときに 40 などへ上げる。空なら画面の設定のまま。
 */
function pollSec_() {
  try {
    var v = Number(PropertiesService.getScriptProperties().getProperty('POLL_SEC') || 0);
    return (v >= 10 && v <= 120) ? Math.round(v) : 0;
  } catch (e) { return 0; }
}

/**
 * 定期実行：表示用データを先に作ってキャッシュに置いておく。
 * キャッシュが切れた直後に来た来場者がシートの読み込み（数秒）を待たずに済む。
 * installWarmTrigger() を1回実行すると1分ごとに動く。開催時間外は何もしない（実行時間の節約）。
 */
var WARM_FROM_HOUR = 8;    // この時刻から
var WARM_TO_HOUR = 16;     // この時刻まで（この時は含まない）
function warmCache() {
  var h = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  if (h < WARM_FROM_HOUR || h >= WARM_TO_HOUR) return;
  var cache = CacheService.getScriptCache();
  if (cache.get(CACHE_BUILDING)) return;              // 来場者のリクエストが作っている最中
  // 次の実行（約1分後）まで切れないよう、本体は90秒置く。係員の更新は clearCache_ で即座に消えるので古くならない
  buildAndCache_(cache, 90);
}
/** warmCache を1分ごとに動かす（2回実行しても2本にはならない） */
function installWarmTrigger() {
  removeWarmTrigger();
  ScriptApp.newTrigger('warmCache').timeBased().everyMinutes(1).create();
  Logger.log('warmCache を1分ごとに実行するようにしました（' + WARM_FROM_HOUR + '時〜' + WARM_TO_HOUR + '時だけ動きます）');
}
/** 文化祭が終わったら実行する */
function removeWarmTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'warmCache') { ScriptApp.deleteTrigger(t); n++; }
  });
  if (n) Logger.log('warmCache の定期実行を ' + n + ' 本止めました');
}

/** UTF-8 でのバイト数 */
function bytes_(s) { return unescape(encodeURIComponent(String(s))).length; }

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
  var lastTs = 0;

  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var hist = historyCached_();
    rows.forEach(function (r) {
      var id = String(r[idx['id']] == null ? '' : r[idx['id']]).trim();
      if (!id) return;

      var ts = toDate_(r[idx['time']]);
      var iso = ts ? ts.toISOString() : null;
      // いちばん新しい更新の時刻（5分以上先の時刻＝打ち間違いは数えない）
      if (ts && ts.getTime() - now <= 5 * 60000 && ts.getTime() > lastTs) lastTs = ts.getTime();
      var status = String(r[idx['status']] || '').trim();
      if (status && !isStatus_(status)) status = '';   // 「閉鎖中」など想定外の値は「情報なし」扱い
      // 空セルは「人数が分からない」。Number('') は 0 になってしまうので先に弾く
      var wn = idx['wait'] != null ? toNum_(r[idx['wait']]) : null;
      var wait = (wn !== null && wn >= 0) ? Math.round(Math.min(wn, 999)) : null;

      // 更新が途絶えたブースは「情報なし」として返す。
      // 「準備中」は意図して設定した状態なので対象外。
      var stale = false;
      if (status && status !== '準備中') {
        // 未来の時刻（打ち間違い）は一日中「最新」に見えてしまうので、5分以上先なら古い扱い
        if (!ts || now - ts.getTime() > staleMs || ts.getTime() - now > 5 * 60000) {
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
        dept: idx['dept'] != null ? cut_(r[idx['dept']], 12) : '',
        history: hist[id] || []
      });
    });
  }

  return {
    ok: true,
    serverVersion: GAS_VERSION,        // 画面側で「Code.gs を貼り替えたか」を確かめるため
    updatedAt: new Date().toISOString(),
    // v213：係の人がいちばん最近に更新した時刻。updatedAt は「この返事を作った時刻」なので、
    // 画面の「係の人の更新 ◯分前」に使うと、だれも更新していなくても、いつも「たった今」と出ていた
    lastUpdate: lastTs ? new Date(lastTs).toISOString() : null,
    staleMinutes: STALE_MINUTES,
    waitThresholds: { warn: WAIT_WARN, busy: WAIT_BUSY },
    pollSec: pollSec_(),
    notice: readNotice_(),
    live: livePublic_(),               // v219：司令塔が起こしたイベント（一斉お知らせ・ラッキーブース・抽選）。無ければ {}
    visitors: readVisitors_(),
    booths: booths
  };
}

/**
 * 受付でカウントした当日の来場者数。
 * 加算・減算の履歴として持つ（打ち間違いを引き算で戻せるようにするため）。
 */
function readVisitors_(fresh) {
  var tz = TZ;   // シートのロケールに引きずられない
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  // v213：数えた結果を2分おぼえておく（受付が押したとき・シートを手で直したときは数え直す）。
  // 以前は、配信データを作り直すたびに来場者シートの全行を読んでいた
  var vKey = CACHE_VIS + today, vc = null;
  try { vc = CacheService.getScriptCache(); } catch (eVc) { vc = null; }
  if (!fresh && vc) {
    try { var vHit = vc.get(vKey); if (vHit) return JSON.parse(vHit); } catch (eVh) {}
  }
  var out = readVisitorsSheet_(today, tz);
  if (vc) { try { vc.put(vKey, JSON.stringify(out), VIS_CACHE_SEC); } catch (eVp) {} }
  return out;
}
function readVisitorsSheet_(today, tz) {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_VISITORS);
  if (!sh || sh.getLastRow() < 2) return { today: 0, updatedAt: null };
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
 * v213：推移は 90 秒おぼえておく。履歴シートの 6000 行を読むのは、配信データを作り直す時間の大半。
 * 混み合う時間は係員の更新が数秒おきに来て、そのたびに作り直しになるので、ここを読まずに済むと作り直しが速く終わる。
 * 置けない（大きすぎる・キャッシュの障害）ときは、これまでどおり毎回読む
 */
function historyCached_() {
  var c = null;
  try { c = CacheService.getScriptCache(); var hit = c.get(CACHE_HIST); if (hit) return JSON.parse(hit); } catch (e) {}
  var h = buildHistory_();
  try { var t = JSON.stringify(h); if (c && bytes_(t) < 95000) c.put(CACHE_HIST, t, HIST_CACHE_SEC); } catch (e2) {}
  return h;
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
  // 3時間分を確実に含める。150ブースが5分おきに更新すると3時間で約5400行になる
  var take = Math.min(6000, last - 1);
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
    // 空欄は「人数不明」。Number('') は 0 になり「0人」と出てしまう
    var w = cols >= 4 && r[3] !== '' && r[3] != null ? Number(r[3]) : NaN;
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
  // 古い行は「履歴_保管」へ移してあるので、振り返りはそちらも合わせて読む（1日目の記録を失わない）
  var arcSh = ss.getSheetByName(SHEET_LOG_ARC);
  if (arcSh && arcSh.getLastRow() >= 2) {
    rows = arcSh.getRange(2, 1, arcSh.getLastRow() - 1, 4).getValues().concat(rows);
  }
  var day = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };

  var entries = [], seenLog = {};
  rows.forEach(function (r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(ts.getTime())) return;
    // 保管へ移す途中で止まると、同じ行が両方のシートに残る。同じ行は1回と数える
    var lk = ts.getTime() + '|' + String(r[1]).trim() + '|' + String(r[2]).trim() + '|' + r[3];
    if (seenLog[lk]) return;
    seenLog[lk] = 1;
    var lv = statusLevel_(String(r[2]).trim());
    if (lv === undefined) return;
    entries.push({ ts: ts, id: String(r[1]).trim(), lv: lv,
                   w: (r[3] === '' || r[3] == null) ? NaN : Number(r[3]), d: day(ts) });
  });
  if (!entries.length) return empty;
  // 履歴シートを手で並べ替えられても正しく集計できるよう、時刻順にそろえる
  entries.sort(function (a, b) { return a.ts - b.ts; });

  var target = dateStr || entries[entries.length - 1].d;
  entries = entries.filter(function (x) { return x.d === target; });
  if (!entries.length) return empty;

  // 時間バケットを作る
  var msBucket = REPORT_BUCKET_MIN * 60000;
  var floorTo = function (t) { return Math.floor(t / msBucket) * msBucket; };
  // 履歴は追記順だが、念のため最小・最大から範囲を決める
  var times = entries.map(function (x) { return x.ts.getTime(); });
  // 受付のカウントは最初の更新より前（開場直後）から始まることがある。
  // 範囲に含めないと、合計には入るのにグラフに出ない人数ができる
  var visRows = [];
  var vsh = ss.getSheetByName(SHEET_VISITORS);
  if (vsh && vsh.getLastRow() >= 2) {
    vsh.getRange(2, 1, vsh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
      if (isNaN(ts.getTime()) || day(ts) !== target) return;
      var d = Number(r[1]);
      if (isNaN(d)) return;
      visRows.push({ t: ts.getTime(), d: d });
      times.push(ts.getTime());
    });
  }
  var t0 = floorTo(Math.min.apply(null, times));
  var t1 = floorTo(Math.max.apply(null, times));
  var buckets = [];
  for (var t = t0; t <= t1; t += msBucket) buckets.push(t);
  var labels = buckets.map(function (t) { return Utilities.formatDate(new Date(t), tz, 'HH:mm'); });

  // ブースごとに、各バケットの「最後に記録された状態」を採用する
  var per = {};
  var nUpd = {};
  entries.forEach(function (x) {
    if (!x.id) return;
    var b = floorTo(x.ts.getTime());
    (per[x.id] = per[x.id] || {})[b] = { lv: x.lv, w: isNaN(x.w) ? null : x.w };
    nUpd[x.id] = (nUpd[x.id] || 0) + 1;            // 同じ15分に3回更新したら3回と数える
  });

  var ids = order.filter(function (id) { return per[id]; });
  Object.keys(per).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });

  var booths = ids.map(function (id) {
    var series = [], waits = [], last = null, busy = 0, cnt = 0;
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
      updates: nUpd[id] || 0
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
  visRows.forEach(function (v) {
    visTotal += v.d;
    var i = Math.round((floorTo(v.t) - t0) / msBucket);
    vis[Math.min(Math.max(i, 0), vis.length - 1)] += v.d;
  });

  var peak = overall.reduce(function (a, x) { return x.busy > a.busy ? x : a; }, overall[0]);
  var busiest = booths.slice().sort(function (a, b) { return b.busyMinutes - a.busyMinutes; })[0];
  // 一度も混雑しなかった日に「最も混んだ時間＝開始時刻」「0分のブース」と出さない
  if (peak && !peak.busy) peak = null;
  if (busiest && !busiest.busyMinutes) busiest = null;
  var totalUpdates = booths.reduce(function (s, b) { return s + b.updates; }, 0);

  // スタンプの控えから、その日にスタンプが押された数（＝QRを読んで来た人の数）をブースごとに数える
  var stampBy = {}, stampTotal = 0, stampPeople = {};
  var lg = ss.getSheetByName(SHEET_LEDGER);
  if (lg && lg.getLastRow() >= 2) {
    // 数えるのは「スタンプを取った時刻（at）」のある行だけ。同じブース×同じ時刻の行は1回と数える。
    // 番号をつないだ・旧版から引っ越した・同時に2回送った、で同じスタンプの行が複数できるため
    var seen = {};
    lg.getRange(2, 1, lg.getLastRow() - 1, 5).getValues().forEach(function (r) {
      if (r[2] !== 's' || !r[4]) return;
      var ts = r[4] instanceof Date ? r[4] : new Date(r[4]);
      if (isNaN(ts.getTime()) || day(ts) !== target) return;
      var id = String(r[3]), key = id + '|' + ts.getTime();
      if (seen[key]) return;
      seen[key] = 1;
      stampBy[id] = (stampBy[id] || 0) + 1; stampTotal++; stampPeople[r[1]] = 1;
    });
  }
  booths.forEach(function (b) { b.stamps = stampBy[b.id] || 0; });
  var topStamp = booths.slice().sort(function (a, b) { return b.stamps - a.stamps; })[0];
  if (topStamp && !topStamp.stamps) topStamp = null;

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
      openLabel: labels[0] + '〜' + labels[labels.length - 1],
      stampsTotal: stampTotal,
      stampPeople: Object.keys(stampPeople).length,
      topStampBooth: topStamp ? topStamp.name : null,
      topStampCount: topStamp ? topStamp.stamps : 0
    },
    events: reportEvents_(target)       // v225：その日の司令塔の操作（一斉お知らせ・ラッキーブース・抽選 など）
  };
}
/** v225：振り返りに出す、その日の司令塔の操作（時刻の早い順・80件まで）。パスワード・スタンプ番号は、もともと記録に入れていない */
function reportEvents_(target) {
  try {
    var sh = ss_().getSheetByName('司令塔の記録');
    if (!sh || sh.getLastRow() < 2) return [];
    var out = [];
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      var d = r[0] instanceof Date ? r[0] : new Date(r[0]);
      if (isNaN(d.getTime()) || Utilities.formatDate(d, TZ, 'yyyy-MM-dd') !== target) return;
      out.push({ t: Utilities.formatDate(d, TZ, 'HH:mm'), what: cut_(String(r[1] == null ? '' : r[1]).replace(/^'/, ''), 80) });
    });
    return out.slice(-80);
  } catch (e) { return []; }
}

/* ============================== POST ============================== */
function doPost(e) {
  var body;
  var rawBody = (e && e.postData && e.postData.contents) || '{}';
  // v213：とても大きい送信は、読む前に断る（いたずらで実行時間を使わせない）
  if (String(rawBody).length > POST_MAX_CHARS) {
    return json_({ ok: false, error: 'too large: 送る中身が大きすぎます', status: 'error' });
  }
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    return json_({ ok: false, error: 'invalid json' });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json_({ ok: false, error: 'invalid json' });
  }

  try {
    var action = body.action || 'update';

    // v216：司令塔（持ち主だけ）。係員のパスワードとは別の入り方なので、先に分ける
    if (String(action).indexOf('owner_') === 0) {
      return json_(ownerApi_(String(action), body));
    }

    if (action === 'verify') {
      checkPass_(body.pass, body.cid, true, body.who);      // ログイン：端末を記録する（承認制のときは、許可を待つ）
      return json_({ ok: true });
    }

    // 来場者のスタンプの控え。端末の保存が消えても、ここから戻せるようにする。
    // パスワードは要らない（来場者の端末から送る）。追記だけで、既存の行は触らない
    if (action === 'ledger') {
      return json_(appendLedger_(body));
    }
    // お菓子の交換。同じスタンプを別のブラウザで二重に使えないよう、サーバーの控えで確かめる
    if (action === 'redeem') {
      return json_(redeemLedger_(body));
    }
    // 端末で起きたエラーの記録（v156）。パスワードは要らない。いたずらで埋められないよう1分あたりの件数に上限
    if (action === 'clientlog') {
      return json_(appendClientLog_(body));
    }

    if (action === 'update') {
      checkPass_(body.pass, body.cid);
      if (!body.id) throw new Error('bad request: ブースの id がありません');

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
          if (!isFinite(wn) || wn < 0 || wn > 999) throw new Error('bad wait: 待ち人数は 0〜999 の数にしてください');
          wait = Math.round(wn);
        }
      }

      // 人数が来ていてステータス指定が無ければ、人数から自動判定する
      var status = isStatus_(body.status) ? String(body.status) : null;
      if (!status && wait !== null && wait !== undefined) status = statusFromWait_(wait);
      if (!status) throw new Error('bad request: 状態（' + STATUS_LIST.join('／') + '）か待ち人数を送ってください');

      var n = writeBooth_([String(body.id).trim()], status, wait);
      if (!n) throw new Error('該当するIDがありません: ' + body.id);
      return json_({ ok: true, status: 'success', appliedStatus: status, updated: n });
    }

    // ---------------------------------------------------------------
    // ブースそのものの追加・書き換え・削除。
    // 画面の地図から部屋をおして割り当てるために足した口。既存の update とは
    // 別なので、この版を貼っていなくても従来の動作は一切変わらない
    // （新しい口だけが「不明な操作」で失敗する）。
    // ---------------------------------------------------------------
    if (action === 'upsert') {
      ownerOnly_(body);                            // v219：ブースの追加・書き換えは、司令塔（持ち主）だけ
      var uid = cleanBoothId_(body.id);            // 部屋ID（例 1F-02）の形だけ受ける（数式や巨大な文字列を入れさせない）
      if (!uid) throw new Error('bad request: 部屋ID（例 1F-02）の形が違います');
      return json_(upsertBooth_(uid, body));
    }

    if (action === 'remove') {
      ownerOnly_(body);
      var rid = String(body.id || '').trim();
      if (!rid) throw new Error('bad request: ブースの id がありません');
      return json_({ ok: true, removed: removeBooth_(rid) });
    }

    // 本部からその場でお知らせを出す。スプレッドシートを開かずに流せるようにする。
    // 落とし物・ステージ開始・雨天対応など、当日は「すぐ出す」ことに価値がある
    if (action === 'notice') {
      ownerOnly_(body);                            // v219：お知らせは、司令塔（持ち主）だけ
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
        nt.getRange(2, 1, 1, 3).setValues([[safeText_(text), level, text ? true : false]]);
        // 上書きで前のお知らせが消えるので、出した内容はすべて控えに残す
        appendTo_(SHEET_NOTICE_LOG, ['timestamp', 'text', 'level'], [new Date(), safeText_(text || '（取り消し）'), level]);
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
      if (isNaN(n) || n === 0 || Math.abs(n) > 1000) throw new Error('bad count: 人数は 1〜1000（引くときは −1〜−1000）にしてください');
      // uid … 押した1回ごとの番号。電波が悪くて送り直しても、同じ番号は2回数えない
      var vuid = String(body.uid || '').replace(/[^0-9a-z_-]/gi, '').slice(0, 40);
      var dup = false;
      // 受付が2台で同時に押すと、同じ行番号を計算して片方が消えていた
      withLock_(function () {
        var vs = ss_().getSheetByName(SHEET_VISITORS);
        if (!vs) {
          vs = ss_().insertSheet(SHEET_VISITORS);
          vs.getRange(1, 1, 1, 4).setValues([['timestamp', 'delta', 'memo', 'uid']]).setFontWeight('bold');
        }
        if (vuid && vs.getLastRow() >= 2 &&
            vs.getRange(2, 4, vs.getLastRow() - 1, 1).createTextFinder(vuid).matchEntireCell(true).findNext()) {
          dup = true;
          return;
        }
        vs.appendRow([new Date(), n, safeText_(cut_(body.memo, 100)), vuid]);
        SpreadsheetApp.flush();
        clearCache_();
      });
      return json_({ ok: true, status: 'success', duplicate: dup, visitors: readVisitors_(true) });
    }

    if (action === 'bulk') {
      ownerOnly_(body);                            // v219：開場・閉場の一括は、司令塔（持ち主）だけ
      var st = isStatus_(body.status) ? String(body.status) : '空いています';
      var cnt = writeBooth_(null, st, 0);
      return json_({ ok: true, status: 'success', updated: cnt });
    }

    throw new Error('unknown action: この操作（' + cut_(action, 20) + '）は、このサーバーの版（' + GAS_VERSION + '）にはありません');
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), status: 'error' });
  }
}

/**
 * ids が null なら全ブース。status と wait をまとめて書き、履歴に記録する。
 * wait: undefined = 触らない / null = 消す / 数値 = その値にする
 * @return {number} 更新した行数
 */
/**
 * ブースを1件、追加または書き換える。地図の部屋をおして割り当てるための入口。
 * 渡されたキーだけを書き、渡していない列には触らない（人数や状態を巻き戻さない）。
 * @param {string} id 部屋ID（例 1F-02）
 * @param {Object} b  name / category / floor / note のうち変えたいものだけ
 */
function upsertBooth_(id, b) {
  return withLock_(function () {
    var sh = sheet_(SHEET_MAIN);
    var idx = headerIndex_(sh);
    requireCols_(idx, ['id', 'name', 'status', 'time']);
    var last = sh.getLastRow();
    var width = sh.getLastColumn();
    var rows = last >= 2 ? sh.getRange(2, 1, last - 1, width).getValues() : [];

    var at = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idx['id']] == null ? '' : rows[i][idx['id']]).trim() === id) { at = i; break; }
    }

    var row;
    if (at >= 0) { row = rows[at]; }
    else { row = []; for (var k = 0; k < width; k++) row.push(''); }

    row[idx['id']] = id;
    if ('name'     in b && idx['name']     != null) row[idx['name']]     = safeText_(cut_(String(b.name || ''), 40));
    if ('category' in b && idx['category'] != null) row[idx['category']] = safeText_(cut_(String(b.category || ''), 20));
    if ('note'     in b && idx['note']     != null) row[idx['note']]     = safeText_(cut_(String(b.note || ''), 120));
    if ('floor'    in b && idx['floor']    != null) row[idx['floor']]    = floorOf_(b.floor);
    if ('dept'     in b && idx['dept']     != null) row[idx['dept']]     = safeText_(cut_(String(b.dept || ''), 12));

    // 新しく作った行は「まだ状況が入っていない」状態にしておく。
    // 適当な状態を入れると、係員が触っていないのに空き表示になってしまう
    if (at < 0) {
      if (idx['status'] != null) row[idx['status']] = '';
      if (idx['time']   != null) row[idx['time']]   = '';
      if (idx['wait']   != null) row[idx['wait']]   = '';
    }

    if (at >= 0) sh.getRange(2 + at, 1, 1, width).setValues([row]);
    else         sh.getRange(last + 1, 1, 1, width).setValues([row]);

    SpreadsheetApp.flush();
    clearCache_();
    return { ok: true, id: id, created: at < 0 };
  });
}

/** ブースを1件消す。行ごと消すので、あとから見て残骸が残らない */
function removeBooth_(id) {
  return withLock_(function () {
    var sh = sheet_(SHEET_MAIN);
    var idx = headerIndex_(sh);
    requireCols_(idx, ['id']);
    var last = sh.getLastRow();
    if (last < 2) return 0;
    var ids = sh.getRange(2, idx['id'] + 1, last - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0] == null ? '' : ids[i][0]).trim() === id) {
        // 消す前に行の中身を控えに移す（間違えて外したときに戻せるように）
        var width = sh.getLastColumn();
        var head = sh.getRange(1, 1, 1, width).getValues()[0];
        var row = sh.getRange(2 + i, 1, 1, width).getValues()[0];
        // 読んでから消すまでの間に行が並べ替えられていたら、別のブースを消してしまう。消す直前に確かめる
        if (String(row[idx['id']] == null ? '' : row[idx['id']]).trim() !== id) throw new Error('busy: 表が並べ替えられました。もう一度おしてください');
        appendTo_(SHEET_REMOVED, ['removedAt'].concat(head), [new Date()].concat(row.map(function (v) { return typeof v === 'string' ? safeText_(v) : v; })));
        sh.deleteRow(2 + i);
        SpreadsheetApp.flush();
        clearCache_();
        return 1;
      }
    }
    return 0;
  });
}

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
    // まとめて読み、メモリ上で直し、列ごとに1回で書き戻す。
    //
    // 【1〜8列をまとめて書き戻してはいけない】
    // 列は id / name / status / time / category / floor / note / wait / image。
    // 範囲でまとめて書くと、name・category・floor・note まで
    // 「読んだ時点の値」で上書きしてしまう。
    // 先生がブラウザでブース名やメモを直している最中に係員が送信すると、
    // その編集が黙って消える。当日は更新が数秒おきに走るので必ず起きる。
    // このスクリプトが持ち主である status / time / wait の3列だけを書く。
    var rows = last - 1;
    var idVals = sh.getRange(2, idCol, rows, 1).getValues();
    var stVals = sh.getRange(2, stCol, rows, 1).getValues();
    var tmVals = sh.getRange(2, tmCol, rows, 1).getValues();
    var wtVals = wtCol ? sh.getRange(2, wtCol, rows, 1).getValues() : null;
    var now = new Date();
    var logs = [];
    var updated = 0;
    var hitRows = [];

    for (var i = 0; i < rows; i++) {
      var id = String(idVals[i][0] == null ? '' : idVals[i][0]).trim();
      if (!id) continue;
      if (ids && ids.indexOf(id) === -1) continue;
      stVals[i][0] = status;
      tmVals[i][0] = now;
      if (wtVals && wait !== undefined) wtVals[i][0] = (wait === null ? '' : wait);
      logs.push([now, id, status, (wait === null || wait === undefined) ? '' : wait]);
      hitRows.push(i);
      updated++;
    }
    if (!updated) return 0;

    if (hitRows.length === 1) {
      // v213：1つのブースの更新（ほとんどがこれ）は、その行のセルだけを書く。
      // 以前は status・time・wait の列を、全部の行ぶん書き戻していた。読んでから書くまでのあいだに、
      // 先生がほかのブースの状態を手で直していると、その直しを「読んだ時点の値」で消していた
      var rr = hitRows[0] + 2;
      if (tmCol === stCol + 1) sh.getRange(rr, stCol, 1, 2).setValues([[status, now]]);   // 列がとなりなら1回で
      else { sh.getRange(rr, stCol).setValue(status); sh.getRange(rr, tmCol).setValue(now); }
      if (wtVals && wait !== undefined) sh.getRange(rr, wtCol).setValue(wait === null ? '' : wait);
    } else {
      sh.getRange(2, stCol, rows, 1).setValues(stVals);
      sh.getRange(2, tmCol, rows, 1).setValues(tmVals);
      if (wtVals && wait !== undefined) sh.getRange(2, wtCol, rows, 1).setValues(wtVals);
    }
    appendLogs_(logs);
    SpreadsheetApp.flush();      // 確定してからキャッシュを捨てる
    clearCache_();
    return updated;
  });
}

/**
 * 配信用キャッシュを捨てる。控え（CACHE_BAK）は残す：再構築の1〜2秒のあいだ、
 * 来場者に「少し古い控え」を返して待たせないため。控えが返るのは再構築中だけなので、
 * 古い内容が返り続けることはない。書き込みの番号も変え、作りかけの古い結果を置かせない。
 */
/**
 * スプレッドシートを手で直したとき（先生がブース名やメモを書き換えた等）に、配信キャッシュを捨てる。
 * スプレッドシートに付いたスクリプト（拡張機能 → Apps Script）なら自動で動く（設定は要らない）。
 */
function onEdit(e) {
  try { clearCache_(true); } catch (err) {}
}
/** @param {boolean} [all] 推移・来場者数の覚え書きも捨てる（シートを手で直したとき。どのシートを直したか分からないので全部） */
function clearCache_(all) {
  try {
    var c = CacheService.getScriptCache();
    c.put(CACHE_GEN, String(Date.now()) + Math.random().toString(36).slice(2, 6), 3600);
    c.remove(CACHE_KEY);
    if (all) {
      c.remove(CACHE_HIST);
      c.remove(CACHE_VIS + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
    }
  } catch (e) {}
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
  // 履歴シートは画面の推移表示のために毎回読むので、長くなりすぎると重くなる。
  // 以前は古い行を消していたが、それでは1日目の記録（振り返りレポートの元）が失われる。
  // 消さずに「履歴_保管」へ移してから、元のシートから外す。
  if (last > 10000) {
    var move = last - 8000;
    var old = sh.getRange(2, 1, move, 4).getValues();
    var arc = ss.getSheetByName(SHEET_LOG_ARC);
    if (!arc) {
      arc = ss.insertSheet(SHEET_LOG_ARC);
      arc.getRange(1, 1, 1, 4).setValues([['timestamp', 'id', 'status', 'wait']]).setFontWeight('bold');
    }
    arc.getRange(arc.getLastRow() + 1, 1, old.length, 4).setValues(old);
    SpreadsheetApp.flush();                 // 控えを確定させてから消す
    sh.deleteRows(2, move);
  }
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


/* ====================== 端末のエラー記録（v156） ====================== */
var SHEET_CLIENT_ERR = 'エラー記録';
var CLIENT_LOG_RATE_MAX = 60;     // 全員合計で1分あたりに書く行の上限
function appendClientLog_(body) {
  var rc = CacheService.getScriptCache(), rk = 'clog_rate_' + Math.floor(Date.now() / 60000);
  var used = Number(rc.get(rk) || 0);
  if (used >= CLIENT_LOG_RATE_MAX) return { ok: true, skipped: true };
  try { rc.put(rk, String(used + 1), 120); } catch (eR) {}
  appendTo_(SHEET_CLIENT_ERR, ['timestamp', 'build', 'view', 'msg', 'src', 'line', 'ua'], [
    new Date(), safeText_(cut_(body.build, 20)), safeText_(cut_(body.view, 12)), safeText_(cut_(body.msg, 300)),
    safeText_(cut_(body.src, 80)), Math.max(0, Math.min(1e7, Math.round(Number(body.line) || 0))), safeText_(cut_(body.ua, 160))
  ]);
  return { ok: true };
}
/** 今日の端末エラーの件数（validate 用） */
function clientErrorsToday_() {
  var sh = ss_().getSheetByName(SHEET_CLIENT_ERR);
  if (!sh || sh.getLastRow() < 2) return 0;
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().filter(function (r) {
    var d = r[0] instanceof Date ? r[0] : new Date(r[0]);
    return !isNaN(d.getTime()) && Utilities.formatDate(d, TZ, 'yyyy-MM-dd') === today;
  }).length;
}

/* ====================== スタンプの控え（来場者） ======================
   スタンプは来場者の端末に保存するが、端末の保存は消えることがある
   （ブラウザの掃除・容量不足・別のブラウザで開いた等）。サーバーにも控えを残し、
   ・引き継ぎ用のリンクから別のブラウザ・機種へ戻せるようにする
   ・お菓子の交換を控えで確かめ、同じスタンプを別のブラウザで二重に使えないようにする
   ・どのブースに何人来たか（スタンプ数）を振り返りに使えるようにする
   行は追記だけ。消さない。列：timestamp / cid / type(s=獲得, r=交換) / id / at(端末時刻)
   ================================================================= */
var LEDGER_HEAD = ['timestamp', 'cid', 'type', 'id', 'at'];
var LEDGER_RATE_MAX = 3000;      // 全員合計で1分あたりに追記する行の上限
var LEDGER_PER_CID_MAX = 800;    // 1つの番号が持てる記録の上限

function cleanCid_(v) {
  var c = String(v == null ? '' : v).trim();
  // 8文字の「スタンプ番号」（v123〜）と、旧版の端末番号（12〜40文字）の両方を受ける
  if (!/^[a-z0-9]{6,40}$/i.test(c)) throw new Error('bad cid: スタンプ番号の形が違います');
  return c;
}
function cleanBoothId_(v) {
  var c = String(v == null ? '' : v).trim();
  if (!/^[0-9A-Za-z_-]{1,24}$/.test(c)) return '';
  return c;
}
function ledgerSheet_() {
  // 番号とブースidは文字のまま持つ（「2345E678」のような番号が数値に化けないように）
  return sheetOrCreate_(SHEET_LEDGER, LEDGER_HEAD, ['B:B', 'D:D']);
}
/* ---- 番号の統合（旧番号→新番号）と、台帳の読み出しキャッシュ ---- */
var LEDGER_CACHE_SEC = 120;
/** 統合されていれば行き先の番号を返す（最大5段たどる） */
function resolveCid_(cid) {
  var cache = CacheService.getScriptCache();
  var cur = cid;
  for (var i = 0; i < 5; i++) {
    var k = 'al_' + cur, hit = cache.get(k), to = null;
    if (hit != null) to = hit === '-' ? null : hit;
    else {
      var sh = ss_().getSheetByName(SHEET_ALIAS);
      if (sh && sh.getLastRow() >= 2) {
        var f = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(cur).matchCase(true).matchEntireCell(true).findNext();
        if (f) to = String(sh.getRange(f.getRow(), 2).getValue() || '') || null;
      }
      try { cache.put(k, to || '-', 600); } catch (eC) {}
    }
    if (!to || to === cur || to === cid) break;
    cur = to;
  }
  return cur;
}
function addAlias_(from, to) {
  if (!from || !to || from === to || resolveCid_(to) === from) return;   // 輪になる付け替えはしない
  appendTo_(SHEET_ALIAS, ['from', 'to', 'timestamp'], [from, to, new Date()], ['A:B']);
  try { CacheService.getScriptCache().put('al_' + from, to, 600); } catch (eC) {}
}
function ledgerCacheGet_(cid) {
  try { var v = CacheService.getScriptCache().get('lg_' + cid); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function ledgerCachePut_(cid, l) {
  try { CacheService.getScriptCache().put('lg_' + cid, JSON.stringify({ stamps: l.stamps, spent: l.spent }), LEDGER_CACHE_SEC); } catch (e) {}
}
/**
 * シートを取る。無ければ見出しつきで作る。textCols の列（'A:A' など）は文字のまま持たせる。
 * 同時に2本が作ろうとすると insertSheet が「同じ名前がある」で失敗するので、そのときは取り直す。
 */
function sheetOrCreate_(name, head, textCols) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  try {
    sh = ss.insertSheet(name);
  } catch (e) {
    sh = ss.getSheetByName(name);
    if (sh) return sh;
    throw e;
  }
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  (textCols || []).forEach(function (a1) { try { sh.getRange(a1).setNumberFormat('@'); } catch (eF) {} });
  return sh;
}
/** 指定のシートに1行足す（無ければ見出しつきで作る） */
function appendTo_(name, head, row, textCols) {
  sheetOrCreate_(name, head, textCols).appendRow(row);
}
/** 人が入れた文字を、シートに数式として解釈させない（先頭が = + - @ なら ' を付ける。読み出すと ' は付かない） */
function safeText_(v) {
  var t = String(v == null ? '' : v);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}
/**
 * その番号の控えを読む。{stamps:[id...], spent:[id...]}
 * fresh=false なら2分間のキャッシュを使う（開くたびの読み出しでシート全体を探さない）。
 * 交換の確認のように取りこぼしが許されない場面では fresh=true でシートから読む。
 */
function ledgerOf_(cid, fresh) {
  if (!fresh) { var c = ledgerCacheGet_(cid); if (c) return c; }
  var l = ledgerRead_(cid);
  ledgerCachePut_(cid, l);
  return l;
}
function ledgerRead_(cid) {
  var sh = ledgerSheet_();
  var last = sh.getLastRow();
  var stamps = [], spent = [], seenS = {}, seenR = {};
  if (last < 2) return { stamps: stamps, spent: spent };
  var hits = sh.getRange(2, 2, last - 1, 1).createTextFinder(cid).matchCase(true).matchEntireCell(true).findAll();
  if (!hits.length) return { stamps: stamps, spent: spent };
  var rows = hits.map(function (rg) { return rg.getRow(); });
  var take = function (t, id) {
    id = String(id);
    if (t === 's' && !seenS[id]) { seenS[id] = 1; stamps.push(id); }
    if (t === 'r' && !seenR[id]) { seenR[id] = 1; spent.push(id); }
  };
  // 見つかった行を「近いものどうし」まとめて読む。1行ずつ読むと1回50ms前後、
  // 最初から最後までを1回で読むと、1日じゅう回った人ほどシート全体を読むことになる
  rows.sort(function (a, b) { return a - b; });
  var groups = [], g = [rows[0], rows[0]];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i] - g[1] <= 300) g[1] = rows[i]; else { groups.push(g); g = [rows[i], rows[i]]; }
  }
  groups.push(g);
  groups.forEach(function (gr) {
    var block = sh.getRange(gr[0], 2, gr[1] - gr[0] + 1, 3).getValues();
    rows.forEach(function (row) {
      if (row < gr[0] || row > gr[1]) return;
      var r = block[row - gr[0]];
      if (String(r[0]) === cid) take(r[1], r[2]);
    });
  });
  return { stamps: stamps, spent: spent };
}
function readLedger_(cidRaw) {
  var cid = resolveCid_(cleanCid_(cidRaw));
  var l = ledgerOf_(cid);
  return { ok: true, sv: GAS_VERSION, cid: cid, stamps: l.stamps, spent: l.spent };
}
/**
 * 端末からの控えを追記する。ev: [{t:'s'|'r', id, at}]
 * ロックは取らない（係員の更新を待たせないため）。appendRow は1行ずつ確定する。
 * 同じ端末・同じスタンプの「獲得」は1回だけ記録する。
 */
function appendLedger_(body) {
  var cid = resolveCid_(cleanCid_(body.cid));
  var own = Array.isArray(body.ev) ? body.ev.slice(0, 400) : [];   // 端末の中身をまるごと送ってくる（最大 ブース数×2）
  // いたずらでシートを埋められないよう、全体で1分あたりの追記行数に上限を置く
  // （当日のピークでも数百行/分。旧版からの移行が重なっても収まる値）。
  // 番号の付け替えより先に確かめる（付け替えたあとで断ると、旧番号の記録が行き場を失う）
  var rc = CacheService.getScriptCache(), rk = 'ledger_rate_' + Math.floor(Date.now() / 60000);
  var used = Number(rc.get(rk) || 0);
  if (used > LEDGER_RATE_MAX) throw new Error('busy: 混み合っています');
  var from = '';
  try { from = body.from ? cleanCid_(body.from) : ''; } catch (eF) { from = ''; }
  var res;
  if (from) {
    // 「つなぐ」で番号を乗り換えた端末から：旧番号の台帳を新番号へ写してから、旧番号→新番号の付け替えを残す。
    // 写し終える前に付け替えると、途中で失敗したとき旧番号の記録（交換済みを含む）が行き場を失う。
    // 2本が同時に付け替えると行き先が割れるので、ここだけはロックの中で行う（つなぐ操作はまれ）。
    res = withLock_(function () {
      var to = resolveCid_(cid), fr = resolveCid_(from);
      if (!fr || fr === to) return appendEvents_(to, own);
      var fl = ledgerOf_(fr, true);
      var copies = fl.stamps.map(function (x) { return { t: 's', id: x }; })
        .concat(fl.spent.map(function (x) { return { t: 'r', id: x }; }));
      var r = appendEvents_(to, copies.concat(own), true);
      SpreadsheetApp.flush();
      addAlias_(fr, to);
      return r;
    });
  } else {
    res = appendEvents_(cid, own);
  }
  if (res.added) { try { rc.put(rk, String(used + res.added), 120); } catch (eR) {} }
  return res;
}
/**
 * 1つの番号の台帳に、まだ無い行だけを足す。
 * @param {boolean} [fresh] キャッシュを使わずシートから読む（付け替えのとき）
 */
function appendEvents_(cid, ev, fresh) {
  var have = ledgerOf_(cid, !!fresh);
  if (!ev.length) return { ok: true, cid: cid, added: 0, stamps: have.stamps, spent: have.spent };
  // シートは足す行があるときだけ開く。同じ中身の送り直し（大半）はキャッシュだけで返せる
  // （スプレッドシートを開くだけで1〜2秒かかり、本番のスタンプ保存が約5秒になっていた）
  var sh = null;
  var hs = {}, hr = {};
  have.stamps.forEach(function (x) { hs[x] = 1; });
  have.spent.forEach(function (x) { hr[x] = 1; });
  var added = 0;
  ev.forEach(function (e) {
    var id = cleanBoothId_(e && e.id);
    var t = e && e.t === 'r' ? 'r' : 's';
    if (!id) return;
    if (have.stamps.length + have.spent.length >= LEDGER_PER_CID_MAX) return;
    if (t === 's' && hs[id]) return;
    if (t === 'r' && hr[id]) return;
    // at はスタンプを取った時刻（端末から）。無いもの＝別の番号からの写しは空欄にする
    // （振り返りでは at のある行だけを、ブース×時刻で重複を除いて数える）
    var n = Number(e.at), at = n > 1.6e12 && n < Date.now() + 864e5 ? new Date(n) : '';
    if (!sh) sh = ledgerSheet_();
    sh.appendRow([new Date(), cid, t, id, at]);
    if (t === 's') { hs[id] = 1; have.stamps.push(id); } else { hr[id] = 1; have.spent.push(id); }
    added++;
  });
  if (added) ledgerCachePut_(cid, have);
  // 台帳の中身をそのまま返す。送った側はこれを足し込めば、別のアプリで増えた分も1往復で揃う。
  // cid は統合後の番号（旧番号で送ってきた端末は、これを見て乗り換える）
  return { ok: true, cid: cid, added: added, stamps: have.stamps, spent: have.spent };
}
/**
 * お菓子の交換。ids のどれかがすでに交換済みなら断る（別のブラウザ・機種での二重交換を防ぐ）。
 * 同じ端末が同時に2回送っても二重にならないよう、ここだけはロックを取る（交換は回数が少ない）。
 */
function redeemLedger_(body) {
  var cid = resolveCid_(cleanCid_(body.cid));
  var ids = (Array.isArray(body.ids) ? body.ids : []).map(cleanBoothId_).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 20);
  if (!ids.length) throw new Error('bad request: 交換するスタンプがありません');
  return withLock_(function () {
    var have = ledgerOf_(cid, true);                 // 二重交換の判定はキャッシュを使わない
    var used = ids.filter(function (id) { return have.spent.indexOf(id) >= 0; });
    if (used.length) return { ok: false, error: 'already', used: used, spent: have.spent };
    var sh = ledgerSheet_();
    var now = new Date();
    ids.forEach(function (id) {
      // 獲得の控えが届いていなかった分も、ここで一緒に残す（交換したのに獲得の記録が無い、を作らない）
      if (have.stamps.indexOf(id) < 0) sh.appendRow([now, cid, 's', id, '']);
      sh.appendRow([now, cid, 'r', id, now]);
      if (have.stamps.indexOf(id) < 0) have.stamps.push(id);
    });
    have.spent = have.spent.concat(ids);
    SpreadsheetApp.flush();                      // ロックを放す前に確定（次の交換の判定に必ず見えるように）
    ledgerCachePut_(cid, have);
    return { ok: true, cid: cid, spent: have.spent };
  });
}

/* ====================== 司令塔：パスキー（WebAuthn）の確かめ ======================
   スマホ・PC の顔認証や指紋（パスキー）は、端末の中の秘密の鍵で「署名」を作って送ってくる。
   サーバーは、登録のときに受け取った「公開の鍵」で、その署名が本物かを確かめる。
   顔や指紋のデータそのものは端末から出ない（サーバーには届かない）。
   Apps Script には署名を確かめる部品が無いので、ここに P-256（ES256）の確かめを書く。
   ================================================================================= */
var P256_ = (function () {
  var p = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  var n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  var b = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
  var gx = BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
  var gy = BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');
  var Z = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), THREE = BigInt(3), FOUR = BigInt(4), EIGHT = BigInt(8);
  function mod(a, m) { var r = a % m; return r < Z ? r + m : r; }
  /** 逆数（拡張ユークリッド） */
  function inv(a, m) {
    var lm = ONE, hm = Z, low = mod(a, m), high = m;
    if (low === Z) throw new Error('no inverse');
    while (low > ONE) {
      var q = high / low;
      var nm = hm - lm * q, nw = high - low * q;
      hm = lm; high = low; lm = nm; low = nw;
    }
    return mod(lm, m);
  }
  /** 曲線の上の点か（y^2 = x^3 - 3x + b） */
  function onCurve(x, y) {
    if (x < Z || x >= p || y < Z || y >= p) return false;
    return mod(y * y - (x * x * x - THREE * x + b), p) === Z;
  }
  // ヤコビ座標（X, Y, Z）。無限遠点は Z = 0
  function dbl(P) {
    var X = P[0], Y = P[1], Zc = P[2];
    if (Zc === Z || Y === Z) return [Z, ONE, Z];
    var YY = mod(Y * Y, p), S = mod(FOUR * X * YY, p);
    var ZZ = mod(Zc * Zc, p);
    var M = mod(THREE * (X - ZZ) * (X + ZZ), p);              // a = -3 のときの式
    var X3 = mod(M * M - TWO * S, p);
    var Y3 = mod(M * (S - X3) - EIGHT * YY * YY, p);
    var Z3 = mod(TWO * Y * Zc, p);
    return [X3, Y3, Z3];
  }
  function add(P, Q) {
    if (P[2] === Z) return Q;
    if (Q[2] === Z) return P;
    var Z1Z1 = mod(P[2] * P[2], p), Z2Z2 = mod(Q[2] * Q[2], p);
    var U1 = mod(P[0] * Z2Z2, p), U2 = mod(Q[0] * Z1Z1, p);
    var S1 = mod(P[1] * Q[2] * Z2Z2, p), S2 = mod(Q[1] * P[2] * Z1Z1, p);
    if (U1 === U2) return S1 === S2 ? dbl(P) : [Z, ONE, Z];
    var H = mod(U2 - U1, p), R = mod(S2 - S1, p);
    var HH = mod(H * H, p), HHH = mod(H * HH, p), V = mod(U1 * HH, p);
    var X3 = mod(R * R - HHH - TWO * V, p);
    var Y3 = mod(R * (V - X3) - S1 * HHH, p);
    var Z3 = mod(H * P[2] * Q[2], p);
    return [X3, Y3, Z3];
  }
  /** u1·G + u2·Q（2つの掛け算を1回の繰り返しで） */
  function mul2(u1, u2, Q) {
    var G = [gx, gy, ONE], GQ = add(G, Q), R = [Z, ONE, Z];
    for (var i = 255; i >= 0; i--) {
      R = dbl(R);
      var b1 = (u1 >> BigInt(i)) & ONE, b2 = (u2 >> BigInt(i)) & ONE;
      if (b1 === ONE && b2 === ONE) R = add(R, GQ);
      else if (b1 === ONE) R = add(R, G);
      else if (b2 === ONE) R = add(R, Q);
    }
    return R;
  }
  function bytesToBig(bytes) {
    var h = '';
    for (var i = 0; i < bytes.length; i++) { var v = bytes[i] & 255; h += (v < 16 ? '0' : '') + v.toString(16); }
    return h ? BigInt('0x' + h) : Z;
  }
  /**
   * 署名の確かめ。hash は SHA-256 の32バイト、r・s は署名の2つの数、x・y は公開の鍵（どれも BigInt。hash だけバイトの並び）。
   * 少しでも合わなければ false（例外は投げない）
   */
  function verify(hash, r, s, x, y) {
    try {
      if (r <= Z || r >= n || s <= Z || s >= n) return false;
      if (!onCurve(x, y)) return false;
      var e = bytesToBig(hash);
      var w = inv(s, n);
      var u1 = mod(e * w, n), u2 = mod(r * w, n);
      var R = mul2(u1, u2, [x, y, ONE]);
      if (R[2] === Z) return false;
      var zi = inv(R[2], p);
      var ax = mod(R[0] * zi * zi, p);
      return mod(ax, n) === r;
    } catch (err) { return false; }
  }
  return { verify: verify, bytesToBig: bytesToBig, onCurve: onCurve };
})();

/** バイトの並び（符号つき・符号なしのどちらでも）を 0〜255 の配列にそろえる */
function ubytes_(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(a[i] & 255); return o; }
function sha256_(bytes) {
  var signed = bytes.map(function (v) { return v > 127 ? v - 256 : v; });
  return ubytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, signed));
}
function b64uToBytes_(s) {
  s = String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
  while (s.length % 4) s += '=';
  return ubytes_(Utilities.base64DecodeWebSafe(s));
}
function bytesToB64u_(b) {
  return Utilities.base64EncodeWebSafe(b.map(function (v) { return v > 127 ? v - 256 : v; })).replace(/=+$/, '');
}
function bytesToText_(b) {
  // clientDataJSON は UTF-8。中身は英数字と記号だけ（JSON）なので、そのまま文字にできる
  var s = '';
  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
}
function bytesEq_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= (a[i] ^ b[i]);
  return d === 0;
}

/**
 * CBOR（パスキーの登録の返事の形）を読む。登録の返事に出てくる型だけ：整数・バイトの並び・文字・配列・連想配列・真偽。
 * @return {{v:*, pos:number}} 読んだ値と、次の位置
 */
function cborRead_(b, pos, depth) {
  depth = depth || 0;
  if (depth > 8) throw new Error('cbor too deep');
  if (pos >= b.length) throw new Error('cbor short');
  var ib = b[pos++], major = ib >> 5, ai = ib & 31, val;
  if (ai < 24) val = ai;
  else if (ai === 24) { val = b[pos]; pos += 1; }
  else if (ai === 25) { val = (b[pos] << 8) | b[pos + 1]; pos += 2; }
  else if (ai === 26) { val = ((b[pos] * 16777216) + (b[pos + 1] << 16) + (b[pos + 2] << 8) + b[pos + 3]); pos += 4; }
  else throw new Error('cbor unsupported length');
  if (pos > b.length) throw new Error('cbor short');
  if (major === 0) return { v: val, pos: pos };
  if (major === 1) return { v: -1 - val, pos: pos };
  if (major === 2 || major === 3) {
    if (pos + val > b.length || val > 4096) throw new Error('cbor short');
    var chunk = b.slice(pos, pos + val);
    return { v: major === 2 ? chunk : bytesToText_(chunk), pos: pos + val };
  }
  if (major === 4) {
    if (val > 64) throw new Error('cbor too long');
    var arr = [];
    for (var i = 0; i < val; i++) { var r = cborRead_(b, pos, depth + 1); arr.push(r.v); pos = r.pos; }
    return { v: arr, pos: pos };
  }
  if (major === 5) {
    if (val > 64) throw new Error('cbor too long');
    var obj = {};
    for (var j = 0; j < val; j++) {
      var k = cborRead_(b, pos, depth + 1); pos = k.pos;
      var v2 = cborRead_(b, pos, depth + 1); pos = v2.pos;
      obj[String(k.v)] = v2.v;
    }
    return { v: obj, pos: pos };
  }
  if (major === 7 && (ai === 20 || ai === 21 || ai === 22)) return { v: ai === 21 ? true : ai === 20 ? false : null, pos: pos };
  throw new Error('cbor unsupported type');
}

/**
 * 認証器のデータ（authenticatorData）を読む。
 * 先頭32バイト＝サイトの名前のハッシュ、1バイト＝旗（UP=触った・UV=本人を確かめた・AT=鍵つき）、4バイト＝使った回数。
 * 登録のときは、そのあとに 鍵のID と 公開の鍵（COSE）が続く
 */
function parseAuthData_(ad) {
  if (!ad || ad.length < 37) throw new Error('authData short');
  var out = { rpIdHash: ad.slice(0, 32), flags: ad[32],
    signCount: (ad[33] * 16777216) + (ad[34] << 16) + (ad[35] << 8) + ad[36] };
  out.up = !!(out.flags & 1); out.uv = !!(out.flags & 4); out.at = !!(out.flags & 64);
  if (out.at) {
    if (ad.length < 55) throw new Error('authData short');
    var len = (ad[53] << 8) | ad[54];
    if (len < 1 || len > 1023 || ad.length < 55 + len) throw new Error('credId length');
    out.credId = ad.slice(55, 55 + len);
    var key = cborRead_(ad, 55 + len).v;
    // ES256（P-256）の鍵だけ受ける：kty=2(EC2)・alg=-7(ES256)・crv=1(P-256)
    if (!key || key['1'] !== 2 || key['3'] !== -7 || key['-1'] !== 1) throw new Error('unsupported key');
    var x = key['-2'], y = key['-3'];
    if (!x || !y || x.length !== 32 || y.length !== 32) throw new Error('bad key');
    out.x = x; out.y = y;
    if (!P256_.onCurve(P256_.bytesToBig(x), P256_.bytesToBig(y))) throw new Error('bad key');
  }
  return out;
}

/** 署名（DER 形式：30 len 02 len r 02 len s）から r・s を取り出す */
function derToRS_(sig) {
  var i = 0;
  if (sig[i++] !== 0x30) throw new Error('bad sig');
  var l = sig[i++];
  if (l & 0x80) { var nb = l & 0x7f; if (nb > 2) throw new Error('bad sig'); l = 0; while (nb--) l = (l << 8) | sig[i++]; }
  if (i + l !== sig.length) throw new Error('bad sig');
  function readInt() {
    if (sig[i++] !== 0x02) throw new Error('bad sig');
    var n2 = sig[i++];
    if (n2 < 1 || n2 > 33 || i + n2 > sig.length) throw new Error('bad sig');
    var v = sig.slice(i, i + n2); i += n2;
    return P256_.bytesToBig(v);
  }
  var r = readInt(), s = readInt();
  if (i !== sig.length) throw new Error('bad sig');
  return { r: r, s: s };
}

/**
 * ブラウザが作る clientDataJSON を確かめる：種類（登録／ログイン）・こちらが出した合言葉（challenge）・サイトの場所（origin）
 * @return {Object} 中身
 */
function checkClientData_(cdBytes, type, challengeB64u, origins) {
  var cd;
  try { cd = JSON.parse(bytesToText_(cdBytes)); } catch (e) { throw new Error('bad clientData'); }
  if (!cd || cd.type !== type) throw new Error('bad clientData type');
  if (String(cd.challenge || '').replace(/=+$/, '') !== challengeB64u) throw new Error('bad challenge');
  if (origins.indexOf(String(cd.origin)) < 0) throw new Error('bad origin: ' + String(cd.origin).slice(0, 60));
  if (cd.crossOrigin === true) throw new Error('bad origin');
  return cd;
}

/**
 * パスキーの登録の返事を確かめて、覚えておく鍵を返す。
 * 鍵の出どころの証明（attestation）は確かめない（登録できるのは、持ち主パスワードで入った人だけ）
 */
function webauthnRegister_(resp, challengeB64u, rpId, origins) {
  checkClientData_(b64uToBytes_(resp.clientDataJSON), 'webauthn.create', challengeB64u, origins);
  var att = cborRead_(b64uToBytes_(resp.attestationObject), 0).v;
  if (!att || !att.authData) throw new Error('bad attestation');
  var ad = parseAuthData_(att.authData);
  if (!bytesEq_(ad.rpIdHash, sha256_(ubytes_(Utilities.newBlob(rpId).getBytes())))) throw new Error('bad rpId');
  if (!ad.up || !ad.uv) throw new Error('user not verified');        // 端末で本人を確かめた（顔・指紋・画面ロック）ことを求める
  if (!ad.at || !ad.credId) throw new Error('no key');
  return { id: bytesToB64u_(ad.credId), x: bytesToB64u_(ad.x), y: bytesToB64u_(ad.y), n: ad.signCount };
}

/**
 * パスキーでのログインの返事を確かめる。key は登録のときに覚えた鍵（{id,x,y,n}）。
 * @return {number} 新しい「使った回数」
 */
function webauthnAssert_(resp, key, challengeB64u, rpId, origins) {
  var cdBytes = b64uToBytes_(resp.clientDataJSON);
  checkClientData_(cdBytes, 'webauthn.get', challengeB64u, origins);
  var adBytes = b64uToBytes_(resp.authenticatorData);
  var ad = parseAuthData_(adBytes.slice(0, 37));
  if (!bytesEq_(ad.rpIdHash, sha256_(ubytes_(Utilities.newBlob(rpId).getBytes())))) throw new Error('bad rpId');
  if (!ad.up || !ad.uv) throw new Error('user not verified');
  var rs = derToRS_(b64uToBytes_(resp.signature));
  var signed = adBytes.concat(sha256_(cdBytes));
  var ok = P256_.verify(sha256_(signed), rs.r, rs.s, P256_.bytesToBig(b64uToBytes_(key.x)), P256_.bytesToBig(b64uToBytes_(key.y)));
  if (!ok) throw new Error('bad signature');
  // 使った回数が戻っていたら、鍵が写し取られた疑い（回数を数えない認証器は、いつも 0）
  if ((ad.signCount || key.n) && ad.signCount <= (key.n || 0)) throw new Error('bad counter');
  return ad.signCount;
}

/* ====================== 司令塔（持ち主だけが入れる管理） ======================
   v216（GAS 2026-10-14a）。ユーザーの依頼：「管理画面の中に司令塔を置いて、だれが入れるかを決めたり、
   管理画面のパスワードを変えたりしたい。自分しか入れないように、顔認証などで」。

   ・入り方：持ち主パスワード（スクリプトプロパティ OWNER_PASS。12文字以上。係員のパスワードと別のもの）か、
     登録したパスキー（スマホ・PC の顔認証・指紋）。パスキーの登録は、持ち主パスワードで入ったあとにだけできる。
   ・できること：係員のパスワード（ADMIN_PASS）を変える／端末ごとの承認制の入・切／端末の許可・停止／パスキーの登録・削除。
   ・今までの入り方は変えない：承認制は、はじめは「切」。切のあいだは、共通のパスワードだけで入れる（止めた端末だけ入れない）。
   ・OWNER_PASS が無いあいだは、司令塔はどの操作も受け付けない（だれも入れない）。
   ================================================================================= */
var OWNER_MIN_LEN = 12;
var OWNER_SESSION_SEC = 1800;        // 司令塔に入っていられる時間（使うたびに延びる）
var OWNER_MAX_FAILS = 5;             // 端末ごと。これだけ続けて違うと、しばらく受け付けない
var OWNER_LOCK_SEC = 300;
var OWNER_KEYS_MAX = 6;              // 登録できるパスキーの数
var OWNER_ORIGIN_DEFAULT = 'https://ma222222-source.github.io';   // 公開しているサイト（パスキーは、ここで作った署名だけ受ける）
var SHEET_DEVICES = '係員の端末';
var DEVICE_HEAD = ['cid', 'status', 'label', 'first', 'last', 'code'];
var DEVICE_MAX = 300;
var DEVICE_CACHE_SEC = 21600;

function props_() { return PropertiesService.getScriptProperties(); }
function textBytes_(s) { return ubytes_(Utilities.newBlob(String(s)).getBytes()); }
function hexOf_(bytes) { var h = ''; for (var i = 0; i < bytes.length; i++) h += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return h; }
/** 推測できない合言葉（UUID 2つぶん＝約244ビット） */
function randToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase(); }
/** 長さが同じなら、どこが違っても同じ時間で比べる */
function safeEq_(a, b) {
  a = String(a); b = String(b);
  var d = a.length ^ b.length;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  return d === 0;
}
/** パスキーの署名を受けるサイト。テスト用に OWNER_ORIGINS（カンマ区切り）で変えられる。ふだんは公開のサイトだけ */
function ownerOrigins_() {
  var v = String(props_().getProperty('OWNER_ORIGINS') || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return /^https?:\/\/[A-Za-z0-9.:-]+$/.test(x); });
  return v.length ? v : [OWNER_ORIGIN_DEFAULT];
}
function rpIdOf_(origin) { return String(origin).replace(/^https?:\/\//, '').replace(/[:\/].*$/, ''); }

/* ---- 持ち主パスワード ---- */
function ownerPassState_() {
  var real = props_().getProperty('OWNER_PASS');
  if (!real) return 'unset';
  if (String(real).length < OWNER_MIN_LEN) return 'weak';
  if (safeEq_(real, props_().getProperty('ADMIN_PASS') || '')) return 'same';
  return 'ok';
}
function ownerPassCheck_(pass, cid) {
  var st = ownerPassState_();
  if (st === 'unset') throw new Error('owner unset: 持ち主パスワードが、まだ決まっていません。Apps Script の「プロジェクトの設定 → スクリプト プロパティ」に OWNER_PASS（' + OWNER_MIN_LEN + '文字以上）を足してください');
  if (st === 'weak') throw new Error('owner weak: 持ち主パスワード（OWNER_PASS）が短すぎます。' + OWNER_MIN_LEN + '文字以上にしてください');
  if (st === 'same') throw new Error('owner weak: 持ち主パスワード（OWNER_PASS）を、係員のパスワードと同じにしないでください');
  var cache = CacheService.getScriptCache();
  var key = 'owf_' + String(cid || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  var fails = Number(cache.get(key) || 0);
  if (fails >= OWNER_MAX_FAILS) throw new Error('locked: 何度も違っています。5分ほど待ってからお試しください');
  if (!safeEq_(String(pass == null ? '' : pass), props_().getProperty('OWNER_PASS'))) {
    cache.put(key, String(fails + 1), OWNER_LOCK_SEC);
    var all = Number(cache.get('owf__all') || 0) + 1;
    cache.put('owf__all', String(all), 60);
    Utilities.sleep(all >= 15 ? 2500 : Math.min(300 * (fails + 1), 1500));
    throw new Error('unauthorized');
  }
  if (fails) cache.remove(key);
}

/* ---- 司令塔に入っている印（セッション） ---- */
function ownerSessionKey_(token) { return 'own_' + hexOf_(sha256_(textBytes_(token))); }
function ownerSessionNew_() {
  var t = randToken_();
  CacheService.getScriptCache().put(ownerSessionKey_(t), '1', OWNER_SESSION_SEC);
  return t;
}
function ownerNeed_(token) {
  var t = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(t)) throw new Error('owner session: 司令塔に入り直してください');
  if (ownerPassState_() !== 'ok') throw new Error('owner session: 司令塔に入り直してください');     // 持ち主パスワードを消したら、入っていた人も出す
  var c = CacheService.getScriptCache(), k = ownerSessionKey_(t);
  if (!c.get(k)) throw new Error('owner session: 司令塔に入り直してください');
  c.put(k, '1', OWNER_SESSION_SEC);
}

/* ---- パスキー ---- */
function ownerKeys_() {
  try { var a = JSON.parse(props_().getProperty('OWNER_KEYS') || '[]'); return Array.isArray(a) ? a.filter(function (k) { return k && k.id && k.x && k.y; }) : []; } catch (e) { return []; }
}
function ownerKeysSave_(a) { props_().setProperty('OWNER_KEYS', JSON.stringify(a)); }
function ownerKeysPublic_() {
  return ownerKeys_().map(function (k) { return { id: k.id, label: k.label || '', at: k.at || '' }; });
}
/** 1回だけ使える合言葉（challenge）を出す。2分で消える */
function ownerChallengeNew_(kind) {
  var ch = bytesToB64u_(sha256_(textBytes_(randToken_())));
  var id = randToken_().slice(0, 24);
  CacheService.getScriptCache().put('och_' + kind + '_' + id, ch, 120);
  return { ch: ch, chId: id };
}
function ownerChallengeTake_(kind, id) {
  var c = CacheService.getScriptCache(), k = 'och_' + kind + '_' + String(id || '').replace(/[^a-f0-9]/g, '').slice(0, 24);
  var ch = c.get(k);
  if (!ch) throw new Error('bad challenge: 時間切れです。もう一度お試しください');
  c.remove(k);
  return ch;
}

/* ---- 端末（だれが入れるか） ---- */
/** 承認制の入・切と、切り替えの番号（番号が変わると、覚えていた端末の状態を読み直す） */
function approvalState_() {
  var v = String(props_().getProperty('APPROVAL') || '').split(':');
  return { on: v[0] === 'on', gen: Number(v[1]) || 0 };
}
function approvalSave_(on, gen) { props_().setProperty('APPROVAL', (on ? 'on' : 'off') + ':' + gen); }
function devSheet_() { return sheetOrCreate_(SHEET_DEVICES, DEVICE_HEAD, ['A:A', 'F:F']); }
/** 画面に出す短い番号（4文字）。待っている端末と、司令塔の一覧を見比べるためのもの */
function devCode_(cid) { return hexOf_(sha256_(textBytes_('dev:' + cid)).slice(0, 2)).toUpperCase(); }
function devRow_(sh, cid) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var f = sh.getRange(2, 1, last - 1, 1).createTextFinder(cid).matchCase(true).matchEntireCell(true).findNext();
  return f ? f.getRow() : 0;
}
/**
 * 端末を記録して、いまの状態を返す。はじめて見る端末は、承認制が入なら wait（待ち）、切なら seen（入ったことがある）。
 * @param {boolean} touch 最後に使った時刻も書く（ログインのとき）
 */
function devRecord_(cid, on, touch, who) {
  return withLock_(function () {
    var sh = devSheet_(), row = devRow_(sh, cid), now = new Date();
    if (!row) {
      var st0 = on ? 'wait' : 'seen';
      if (sh.getLastRow() - 1 >= DEVICE_MAX) {
        // 一覧がいっぱい。承認制が切のあいだは、記録しないだけで通す（一覧を埋められても、係員が入れなくならないように）
        if (!on) return st0;
        throw new Error('busy: 端末の数が上限です。司令塔で使っていない端末を消してください');
      }
      sh.appendRow([cid, st0, safeText_(cut_(who, 20)), now, now, devCode_(cid)]);
      return st0;
    }
    var vals = sh.getRange(row, 1, 1, 5).getValues()[0];
    var st = String(vals[1] || 'seen');
    if (on && st === 'seen') { st = 'wait'; sh.getRange(row, 2).setValue(st); }      // 承認制にしたあとで来た、まだ許可していない端末
    if (touch) sh.getRange(row, 5).setValue(now);
    if (who && !String(vals[2] || '').trim()) sh.getRange(row, 3).setValue(safeText_(cut_(who, 20)));
    return st;
  });
}
/**
 * 係員のパスワードが合ったあとに呼ぶ。この端末が入ってよいかを確かめる。
 * 承認制が切：止めた端末（no）だけ入れない。入：許可した端末（ok）だけ入れる。
 * @param {boolean} login ログインのとき（端末を記録し、最後に使った時刻を書く）
 */
function deviceGate_(cidRaw, login, who) {
  var cid = String(cidRaw == null ? '' : cidRaw);
  var ap = approvalState_();
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(cid)) {
    // 端末の番号が無い・短い（とても古い版の画面・手で送った通信）。切のあいだは、今までどおり通す
    if (ap.on) throw new Error('denied: 端末の番号がありません。ページを開き直してください');
    return;
  }
  var cache = CacheService.getScriptCache(), ck = 'dv' + ap.gen + '_' + cid;
  var st = login ? null : cache.get(ck);
  if (st == null) {
    st = devRecord_(cid, ap.on, !!login, who);
    try { cache.put(ck, st, st === 'wait' ? 5 : DEVICE_CACHE_SEC); } catch (e) {}
  }
  if (st === 'no') throw new Error('denied: この端末は、司令塔で止められています');
  if (ap.on && st !== 'ok') throw new Error('pending:' + devCode_(cid) + ': この端末は、まだ許可されていません');
}
function devList_() {
  var sh = ss_().getSheetByName(SHEET_DEVICES);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().map(function (r) {
    var cid = String(r[0] || '');
    if (!cid) return null;
    var f = toDate_(r[3]), l = toDate_(r[4]);
    return { cid: cid, st: String(r[1] || 'seen'), label: cut_(r[2], 20), first: f ? f.toISOString() : null, last: l ? l.toISOString() : null, code: String(r[5] || devCode_(cid)) };
  }).filter(function (x) { return x; });
}

/** 司令塔のいまの様子（画面に出すもの）。パスワードそのものは返さない */
function ownerStateOut_() {
  var ap = approvalState_();
  var ap0 = props_().getProperty('ADMIN_PASS') || '';
  return { ok: true, approval: ap.on, devices: devList_(), keys: ownerKeysPublic_(),
    passLen: ap0.length, passAt: props_().getProperty('ADMIN_PASS_AT') || '',
    live: liveOwner_(),
    log: ownerLog_(),                  // v221：さいきんの操作（新しい順に8件）
    rpId: rpIdOf_(ownerOrigins_()[0]), sessionSec: OWNER_SESSION_SEC, sv: GAS_VERSION };
}

/* =====================================================================
   v219：本部・準備の操作は、司令塔（持ち主）だけ ／ 司令塔だけが起こせるイベント
   ・お知らせ（notice）・開場と閉場の一括（bulk）・ブースの追加と削除（upsert・remove）は、
     係員のパスワードでは通さない。司令塔に入っている印（token）が要る。
   ・イベントは、スクリプトプロパティ LIVE に1つにまとめて持つ（シートは使わない。読むのが速い）。
       show  … 演出つきの一斉お知らせ（見出し・文。出してから LIVE_SHOW_SEC 秒のあいだ、開いた人に1回ずつ出る）
       lucky … ラッキーブース（選んだブースが、決めた時間だけ地図と一覧で光る）
       draw  … スタンプの抽選（当たった番号は LIVE の中だけ。来場者には「抽選があった」ことだけ返し、
               自分が当たったかは ?win= で自分の番号を出して聞く）
   ===================================================================== */
var LIVE_SHOW_SEC = 180;
var LIVE_DRAW_MIN = 30;          // 当たりの表示を出しておく時間（分）
var LIVE_PAST_MAX = 200;
var LIVE_PLACE_DEFAULT = '受付（南棟昇降口）';
var LIVE_SCHED_MAX = 20;          // v224：一斉お知らせの予約の数         // その日に当たった番号を覚えておく数（同じ人が何度も当たらないように）

function ownerOnly_(body) {
  if (body && body.token) { ownerNeed_(body.token); return; }
  throw new Error('owner only: この操作は、司令塔（持ち主）からだけ行えます');
}
/*
 * v227：イベントの記憶は、3つのスクリプトプロパティに分けて持つ。Apps Script のプロパティは1件 9KB までで、
 * 予約（見出し・ひとことは日本語で1文字3バイト）を20件入れると、1つにまとめたままでは上限に当たり、司令塔の操作が失敗した。
 *   LIVE       … いま出しているもの（show・lucky・draw など）と、ラッキーブースの予約（luckySched。10件で 1KB ほど）
 *   LIVE_SCHED … 一斉お知らせの予約（sched。見出しとひとことが長いと、20件で 8KB ほどになる）
 *   LIVE_PAST  … その日に当たった番号（同じ人が何度も当たらないように）
 * 読むときは1つにまとめて返す。前の版の LIVE（全部入り）も、そのまま読める（書くときに分ける）
 */
var LIVE_PROP_MAX = 8800;
function liveRead_() {
  var p = props_(), o = {};
  try { var a = JSON.parse(p.getProperty('LIVE') || '{}'); if (a && typeof a === 'object' && !Array.isArray(a)) o = a; } catch (e) {}
  try {
    var sc = JSON.parse(p.getProperty('LIVE_SCHED') || 'null');
    if (sc && typeof sc === 'object' && Array.isArray(sc.sched)) o.sched = sc.sched;
  } catch (e2) {}
  try { var pa = JSON.parse(p.getProperty('LIVE_PAST') || 'null'); if (pa && typeof pa === 'object' && pa.day) o.past = pa; } catch (e3) {}
  return o;
}
function liveSave_(o) {
  var main = {};
  Object.keys(o).forEach(function (k) { if (k !== 'sched' && k !== 'past') main[k] = o[k]; });
  var parts = [
    ['LIVE', JSON.stringify(main), 'イベントの記録が大きすぎます。当たりの表示などを消してから、もう一度お試しください'],
    ['LIVE_SCHED', JSON.stringify({ sched: o.sched || [] }), '予約が多すぎます（文の長い予約を、いくつか取り消してください）'],
    ['LIVE_PAST', JSON.stringify(o.past || null), '当たった人の記録が大きすぎます']
  ];
  // 書く前に、全部の大きさを確かめる（途中まで書いて、残りが上限で失敗する、を起こさない）
  parts.forEach(function (x) { if (bytes_(x[1]) > LIVE_PROP_MAX) throw new Error('bad request: ' + x[2]); });
  var p = props_();
  parts.forEach(function (x) { p.setProperty(x[0], x[1]); });
}
function liveId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
/** 来場者に返す分。終わったものは入れない。当たった番号は入れない */
/**
 * v224：いまの一斉お知らせ。すぐに出したもの（show）と、時刻が来た予約（sched）のうち、出ている時間内でいちばん新しいもの。
 * 予約は、時刻が来ても LIVE を書きかえない（来場者の GET では書かない・ロックを取らない）。時刻で見分けるだけ
 */
function liveShowNow_(o, now) {
  var cand = [];
  if (o.show && o.show.until > now) cand.push(o.show);
  (Array.isArray(o.sched) ? o.sched : []).forEach(function (x) {
    if (x && x.at <= now && x.at + LIVE_SHOW_SEC * 1000 > now) cand.push({ id: x.id, title: x.title, text: x.text, fx: x.fx, at: x.at, until: x.at + LIVE_SHOW_SEC * 1000 });
  });
  cand.sort(function (a, b) { return b.at - a.at; });
  return cand[0] || null;
}
/**
 * v225：いまのラッキーブース。すぐに始めたもの（lucky）と、時刻が来た予約（luckySched）のうち、時間内で始まりがいちばん新しいもの。
 * 予約は { id, booth, at, until }。時刻が来ても書きかえない（時刻で見分けるだけ）。src は 'now' か 'sched'
 */
function liveLuckyNow_(o, now) {
  var cand = [];
  if (o.lucky && o.lucky.until > now) cand.push({ x: o.lucky, src: 'now' });
  (Array.isArray(o.luckySched) ? o.luckySched : []).forEach(function (x) { if (x && x.at <= now && x.until > now) cand.push({ x: x, src: 'sched' }); });
  cand.sort(function (a, b) { return b.x.at - a.x.at; });
  return cand[0] || null;
}
/** v224：次の予約の時刻まで、あと何秒か（予約が無ければ Infinity）。配る中身を覚えておく時間を、これより長くしない */
function liveNextDueSec_() {
  var now = Date.now(), o = liveRead_(), best = Infinity;
  (Array.isArray(o.sched) ? o.sched : []).forEach(function (x) { if (x && x.at > now) best = Math.min(best, Math.ceil((x.at - now) / 1000)); });
  (Array.isArray(o.luckySched) ? o.luckySched : []).forEach(function (x) { if (x && x.at > now) best = Math.min(best, Math.ceil((x.at - now) / 1000)); });   // v225
  return best;
}
function livePublic_() {
  var o = liveRead_(), now = Date.now(), out = {};
  var sh = liveShowNow_(o, now);
  if (sh) out.show = { id: sh.id, title: sh.title, text: sh.text, fx: sh.fx === 'calm' ? 'calm' : 'party', at: sh.at, until: sh.until };
  var lk = liveLuckyNow_(o, now);     // v225：予約で始まったものも
  if (lk) out.lucky = { id: lk.x.id, booth: lk.x.booth, at: lk.x.at, until: lk.x.until };
  if (o.draw && o.draw.until > now) out.draw = { id: o.draw.id, at: o.draw.at, until: o.draw.until, min: o.draw.min, n: (o.draw.winners || []).length,
    place: o.draw.place || LIVE_PLACE_DEFAULT };
  return out;
}
/** 司令塔に返す分（当たった番号つき） */
function liveOwner_() {
  var o = liveRead_(), now = Date.now(), out = livePublic_();
  if (out.draw) { out.draw.winners = o.draw.winners || []; out.draw.elig = o.draw.elig || 0; }
  if (out.lucky) out.lucky.stamps = luckyStamps_(out.lucky);    // v223：始めてから、そのブースでスタンプを押した人の数
  // v225：これからのラッキーブースの予約
  out.luckySched = (Array.isArray(o.luckySched) ? o.luckySched : []).filter(function (x) { return x && x.at > now; })
    .sort(function (a, b) { return a.at - b.at; })
    .map(function (x) { return { id: x.id, booth: x.booth, at: x.at, until: x.until }; });
  // v224：これからの予約（時刻の早い順。来場者には返さない）
  out.sched = (Array.isArray(o.sched) ? o.sched : []).filter(function (x) { return x && x.at > now; })
    .sort(function (a, b) { return a.at - b.at; })
    .map(function (x) { return { id: x.id, title: x.title, text: x.text, fx: x.fx, at: x.at }; });
  out.now = now;
  return out;
}
/** その番号が、いまの抽選に当たっているか */
function liveWin_(idRaw, cidRaw) {
  var cid = resolveCid_(cleanCid_(cidRaw));
  var d = liveRead_().draw;
  var live = !!(d && d.until > Date.now() && d.id === String(idRaw));
  var hit = live && (d.winners || []).some(function (w) { return w.cid === cid; });
  return { ok: true, sv: GAS_VERSION, id: live ? d.id : '', win: !!hit };
}
/** 日付（日本時間）の文字。抽選は、その日に押されたスタンプだけを数える */
function liveDay_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
/**
 * 抽選。その日にスタンプを min 個以上あつめた番号から、n 人を選ぶ。
 * 番号をつないだ人（旧 → 新）は、新しい番号にまとめて数える。exclude の番号は選ばない。
 */
function drawPick_(min, n, exclude) {
  var sh = ledgerSheet_(), last = sh.getLastRow();
  if (last < 2) return { winners: [], elig: 0 };
  var alias = {}, as = ss_().getSheetByName(SHEET_ALIAS);
  if (as && as.getLastRow() >= 2) {
    as.getRange(2, 1, as.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0] && r[1]) alias[String(r[0])] = String(r[1]); });
  }
  var res = function (c) { for (var i = 0; i < 5 && alias[c] && alias[c] !== c; i++) c = alias[c]; return c; };
  var today = liveDay_(new Date()), by = {};
  sh.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) {
    if (r[2] !== 's' || !r[1]) return;
    var when = r[4] ? (r[4] instanceof Date ? r[4] : new Date(r[4])) : (r[0] instanceof Date ? r[0] : new Date(r[0]));
    if (isNaN(when.getTime()) || liveDay_(when) !== today) return;
    var c = res(String(r[1]));
    (by[c] = by[c] || {})[String(r[3])] = 1;
  });
  var pool = Object.keys(by).filter(function (c) { return Object.keys(by[c]).length >= min && !exclude[c]; });
  var elig = pool.length, winners = [];
  while (winners.length < n && pool.length) {
    var c1 = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    winners.push({ cid: c1, stamps: Object.keys(by[c1]).length });
  }
  return { winners: winners, elig: elig };
}
/**
 * v223：ラッキーブースを始めてから、そのブースでスタンプを押した人の数（効果が見えるように）。
 * 控えのシートを全部読むので、20秒おぼえておく（司令塔は8秒ごとに取り直す）。
 */
function luckyStamps_(lk) {
  if (!lk || !lk.id) return 0;
  var c = CacheService.getScriptCache(), k = 'lks_' + lk.id, hit = null;
  try { hit = c.get(k); } catch (e0) {}
  if (hit != null) return Number(hit) || 0;
  var n = 0;
  try {
    var sh = ledgerSheet_(), last = sh.getLastRow();
    if (last >= 2) {
      var seen = {};
      sh.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) {
        if (r[2] !== 's' || !r[1] || String(r[3]) !== lk.booth) return;
        var when = r[4] ? (r[4] instanceof Date ? r[4] : new Date(r[4])) : (r[0] instanceof Date ? r[0] : new Date(r[0]));
        if (isNaN(when.getTime()) || when.getTime() < lk.at) return;
        seen[String(r[1])] = 1;
      });
      n = Object.keys(seen).length;
    }
  } catch (e1) { n = 0; }
  try { c.put(k, String(n), 20); } catch (e2) {}
  return n;
}
/** v221：司令塔の記録の、新しい方から8件（いつ・何をしたか。パスワードやスタンプ番号は、もともと記録に入れていない） */
function ownerLog_() {
  try {
    var sh = ss_().getSheetByName('司令塔の記録');
    if (!sh || sh.getLastRow() < 2) return [];
    var n = Math.min(8, sh.getLastRow() - 1);
    return sh.getRange(sh.getLastRow() - n + 1, 1, n, 2).getValues().map(function (r) {
      var d = r[0] instanceof Date ? r[0] : new Date(r[0]);
      return { t: isNaN(d.getTime()) ? '' : d.toISOString(), what: cut_(String(r[1] == null ? '' : r[1]), 80) };
    }).reverse();
  } catch (e) { return []; }
}
function liveLog_(what) {
  try { appendTo_('司令塔の記録', ['timestamp', 'what'], [new Date(), safeText_(what)]); } catch (eW) {}
}
/** 司令塔のイベントの操作（ownerApi_ から。入っている印は確かめ済み） */
function liveApi_(action, body) {
  if (action === 'owner_show') {
    var title = cut_(String(body.title == null ? '' : body.title).trim(), 30);
    var text = cut_(String(body.text == null ? '' : body.text).trim(), 80);
    if (!title) throw new Error('bad request: 見出しを入れてください');
    // v224：時刻を決めて出す（予約）。at はミリ秒。30秒より先〜24時間以内
    if (body.at != null) {
      var at = Math.round(Number(body.at)), nowS = Date.now();
      if (!isFinite(at)) throw new Error('bad request: 時刻の形が違います');
      if (at < nowS + 30000) throw new Error('bad request: その時刻は過ぎています（30秒より先の時刻にしてください）');
      if (at > nowS + 24 * 3600000) throw new Error('bad request: 予約できるのは、24時間先までです');
      return withLock_(function () {
        var oS = liveRead_(), nS = Date.now();
        var list = (Array.isArray(oS.sched) ? oS.sched : []).filter(function (x) { return x && x.at > nS - 3600000; });   // 1時間より前のものは片づける
        if (list.filter(function (x) { return x.at > nS; }).length >= LIVE_SCHED_MAX) throw new Error('bad request: 予約は ' + LIVE_SCHED_MAX + '件までです');
        list.push({ id: liveId_(), title: title, text: text, fx: body.calm === true ? 'calm' : 'party', at: at });
        list.sort(function (a, b) { return a.at - b.at; });
        oS.sched = list;
        liveSave_(oS);
        liveLog_('一斉お知らせを予約（' + Utilities.formatDate(new Date(at), TZ, 'HH:mm') + '）：' + title);
        clearCache_();
        return ownerStateOut_();
      });
    }
    return withLock_(function () {
      var o = liveRead_(), now = Date.now();
      // v223：演出。calm＝しずかに（紙ふぶきなし。落とし物・注意の知らせ用）／それ以外＝お祝い
      o.show = { id: liveId_(), title: title, text: text, fx: body.calm === true ? 'calm' : 'party', at: now, until: now + LIVE_SHOW_SEC * 1000 };
      liveSave_(o);
      liveLog_('一斉お知らせ：' + title + (text ? '／' + text : ''));
      clearCache_();
      return ownerStateOut_();
    });
  }
  if (action === 'owner_lucky') {
    // v221：のばす（extend：分）。番号 id はそのまま（来場者に、もう一度は知らせない）。いまから 60分より先へは のばさない
    if (body.extend != null) {
      var ext = Math.round(Number(body.extend));
      if (!isFinite(ext) || ext < 1 || ext > 30) throw new Error('bad request: のばす時間は 1〜30分にしてください');
      return withLock_(function () {
        var oE = liveRead_(), nowE = Date.now();
        var curE = liveLuckyNow_(oE, nowE);              // v225：予約で始まったものも、のばせる
        if (!curE) throw new Error('bad request: いま、ラッキーブースは出ていません');
        curE.x.until = Math.min(curE.x.until + ext * 60000, nowE + 60 * 60000);
        liveSave_(oE);
        liveLog_('ラッキーブースを ' + ext + '分 のばした');
        clearCache_();
        return ownerStateOut_();
      });
    }
    var booth = cleanBoothId_(body.booth);
    var minutes = Math.round(Number(body.minutes));
    if (body.booth && !booth) throw new Error('bad request: ブースの id の形が違います');
    if (booth && (!isFinite(minutes) || minutes < 3 || minutes > 60)) throw new Error('bad request: 時間は 3〜60分にしてください');
    // v225：時刻を決めて始める（予約）。at はミリ秒。30秒より先〜24時間以内・10件まで
    var lat = body.at != null ? Math.round(Number(body.at)) : null;
    if (lat != null) {
      if (!booth) throw new Error('bad request: ブースをえらんでください');
      if (!isFinite(lat)) throw new Error('bad request: 時刻の形が違います');
      if (lat < Date.now() + 30000) throw new Error('bad request: その時刻は過ぎています（30秒より先の時刻にしてください）');
      if (lat > Date.now() + 24 * 3600000) throw new Error('bad request: 予約できるのは、24時間先までです');
    }
    return withLock_(function () {
      var o = liveRead_(), now = Date.now();
      if (!booth) {
        delete o.lucky;
        // v225：予約で始まって、いま出ているものも終わらせる（これからの予約は残す）
        if (Array.isArray(o.luckySched)) o.luckySched = o.luckySched.filter(function (x) { return x && x.at > now; });
        liveLog_('ラッキーブースを終わらせた');
      }
      else {
        // シートにあるブースだけ（無い番号を光らせない）
        var sh = sheet_(SHEET_MAIN), idx = headerIndex_(sh), nm = '';
        if (sh.getLastRow() >= 2) {
          sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r) {
            if (String(r[idx['id']]).trim() === booth) nm = String(r[idx['name']] || booth);
          });
        }
        if (!nm) throw new Error('bad request: そのブースは、シートにありません');
        if (lat != null) {
          var ls = (Array.isArray(o.luckySched) ? o.luckySched : []).filter(function (x) { return x && x.until > now; });
          if (ls.filter(function (x) { return x.at > now; }).length >= 10) throw new Error('bad request: ラッキーブースの予約は 10件までです');
          ls.push({ id: liveId_(), booth: booth, at: lat, until: lat + minutes * 60000 });
          ls.sort(function (a, b) { return a.at - b.at; });
          o.luckySched = ls;
          liveLog_('ラッキーブースを予約（' + Utilities.formatDate(new Date(lat), TZ, 'HH:mm') + '）：' + nm + '（' + minutes + '分）');
        } else {
          o.lucky = { id: liveId_(), booth: booth, at: now, until: now + minutes * 60000 };
          liveLog_('ラッキーブース：' + nm + '（' + minutes + '分）');
        }
      }
      liveSave_(o);
      clearCache_();
      return ownerStateOut_();
    });
  }
  if (action === 'owner_draw') {
    var min = Math.round(Number(body.min)), n = Math.round(Number(body.n));
    if (!isFinite(min) || min < 1 || min > 60) throw new Error('bad request: スタンプの数は 1〜60 にしてください');
    if (!isFinite(n) || n < 1 || n > 10) throw new Error('bad request: 当たりの人数は 1〜10 にしてください');
    // v220：引く前の下見（dry）。いま条件に合う人が何人いるかだけを返す。当たりは引かない・何も書かない
    if (body.dry === true) {
      var oD = liveRead_(), dayD = liveDay_(new Date());
      var pastD = (oD.past && oD.past.day === dayD && Array.isArray(oD.past.cids)) ? oD.past.cids : [];
      var exD = {};
      if (body.again !== true) pastD.forEach(function (c) { exD[c] = 1; });
      return { ok: true, dry: true, min: min, elig: drawPick_(min, 0, exD).elig, sv: GAS_VERSION };
    }
    return withLock_(function () {
      var o = liveRead_(), now = Date.now(), today = liveDay_(new Date());
      var past = (o.past && o.past.day === today && Array.isArray(o.past.cids)) ? o.past.cids : [];
      var ex = {};
      if (body.again !== true) past.forEach(function (c) { ex[c] = 1; });
      var pick = drawPick_(min, n, ex);
      if (!pick.winners.length) {
        throw new Error('bad request: 当たりを引ける人がいません（きょうスタンプを ' + min + '個以上あつめた人：' + pick.elig + '人）');
      }
      // v223：受け取りの場所（当たった人の画面に出す。はじめは受付）
      var place = cut_(String(body.place == null ? '' : body.place).trim(), 20) || LIVE_PLACE_DEFAULT;
      o.draw = { id: liveId_(), at: now, until: now + LIVE_DRAW_MIN * 60000, min: min, winners: pick.winners, elig: pick.elig, place: place };
      pick.winners.forEach(function (w) { if (past.indexOf(w.cid) < 0) past.push(w.cid); });
      o.past = { day: today, cids: past.slice(-LIVE_PAST_MAX) };
      liveSave_(o);
      // 記録には、番号そのものは残さない（人数だけ）
      liveLog_('抽選：' + pick.winners.length + '人が当たり（' + min + '個以上の人 ' + pick.elig + '人から）');
      clearCache_();
      return ownerStateOut_();
    });
  }
  if (action === 'owner_sched_del') {
    var sid = String(body.id || '');
    return withLock_(function () {
      var oD = liveRead_(), before = (oD.sched || []).length + (oD.luckySched || []).length;
      oD.sched = (Array.isArray(oD.sched) ? oD.sched : []).filter(function (x) { return x && x.id !== sid; });
      oD.luckySched = (Array.isArray(oD.luckySched) ? oD.luckySched : []).filter(function (x) { return x && x.id !== sid; });   // v225
      if (oD.sched.length + oD.luckySched.length === before) throw new Error('bad request: その予約は見つかりません（もう出たか、取り消しずみです）');
      liveSave_(oD);
      liveLog_('一斉お知らせの予約を取り消した');
      clearCache_();
      return ownerStateOut_();
    });
  }
  if (action === 'owner_live_clear') {
    var what = String(body.what || '');
    if (['show', 'lucky', 'draw'].indexOf(what) < 0) throw new Error('bad request: 消すものが違います');
    return withLock_(function () {
      var o = liveRead_();
      delete o[what];
      // v224：時刻が来て出ている予約も消す（これからの予約は残す）
      if (what === 'show' && Array.isArray(o.sched)) { var nC = Date.now(); o.sched = o.sched.filter(function (x) { return x && x.at > nC; }); }
      liveSave_(o);
      liveLog_({ show: '一斉お知らせ', lucky: 'ラッキーブース', draw: '抽選の当たりの表示' }[what] + 'を消した');
      clearCache_();
      return ownerStateOut_();
    });
  }
  return null;
}

/** 司令塔の操作の入口（doPost から） */
function ownerApi_(action, body) {
  // 入る前でも呼べるもの
  if (action === 'owner_info') {
    // 司令塔が使えるか（持ち主パスワードが決まっているか）と、パスキーの有無だけ。中身は出さない
    var stI = ownerPassState_();
    return { ok: true, ready: stI === 'ok', why: stI === 'ok' ? '' : stI, hasKeys: stI === 'ok' && ownerKeys_().length > 0, sv: GAS_VERSION };
  }
  if (action === 'owner_login') {
    ownerPassCheck_(body.opass, body.cid);
    return { ok: true, token: ownerSessionNew_(), state: ownerStateOut_() };
  }
  if (action === 'owner_ch') {
    if (ownerPassState_() !== 'ok') throw new Error('owner unset: 司令塔は、まだ使えません');
    var keys = ownerKeys_();
    if (!keys.length) throw new Error('owner nokeys: パスキーが、まだ登録されていません。持ち主パスワードで入って、登録してください');
    var c1 = ownerChallengeNew_('get');
    return { ok: true, ch: c1.ch, chId: c1.chId, rpId: rpIdOf_(ownerOrigins_()[0]), ids: keys.map(function (k) { return k.id; }) };
  }
  if (action === 'owner_assert') {
    if (ownerPassState_() !== 'ok') throw new Error('owner unset: 司令塔は、まだ使えません');
    var chA = ownerChallengeTake_('get', body.chId);
    var all = ownerKeys_(), idA = String(body.id || '').replace(/=+$/, '');
    var key = null;
    for (var i = 0; i < all.length; i++) if (all[i].id === idA) key = all[i];
    if (!key) throw new Error('unauthorized');
    var origins = ownerOrigins_();
    try {
      key.n = webauthnAssert_(body, key, chA, rpIdOf_(origins[0]), origins);
    } catch (eA) {
      throw new Error('unauthorized');           // 何が合わなかったかは、外に教えない
    }
    key.used = new Date().toISOString();
    ownerKeysSave_(all);
    return { ok: true, token: ownerSessionNew_(), state: ownerStateOut_() };
  }

  // ここから下は、司令塔に入っている人だけ
  ownerNeed_(body.token);
  if (action === 'owner_state') return ownerStateOut_();
  if (action === 'owner_logout') {
    try { CacheService.getScriptCache().remove(ownerSessionKey_(String(body.token))); } catch (eL) {}
    return { ok: true };
  }
  if (action === 'owner_set_pass') {
    var np = String(body.pass == null ? '' : body.pass);
    if (np !== np.trim() || /[　！-～]/.test(np)) throw new Error('bad pass: 前後の空白・全角の文字は使えません');
    if (np.length < PASS_MIN_LEN || np.length > 64) throw new Error('bad pass: ' + PASS_MIN_LEN + '〜64文字にしてください');
    if (safeEq_(np, props_().getProperty('OWNER_PASS') || '')) throw new Error('bad pass: 持ち主パスワードと同じものは使えません');
    props_().setProperty('ADMIN_PASS', np);
    props_().setProperty('ADMIN_PASS_AT', new Date().toISOString());
    // 変えた記録（だれが・いつ、は残すが、パスワードそのものは残さない）
    try { appendTo_('司令塔の記録', ['timestamp', 'what'], [new Date(), '係員のパスワードを変えた（' + np.length + '文字）']); } catch (eW) {}
    return ownerStateOut_();
  }
  if (action === 'owner_mode') {
    var apM = approvalState_(), want = body.on === true;
    return withLock_(function () {
      if (want && body.keep === true) {
        // いま入ったことがある端末（seen）は、そのまま許可にする（承認制にした瞬間に、当番の係員を締め出さない）
        var sh = devSheet_(), last = sh.getLastRow();
        if (last >= 2) {
          var st = sh.getRange(2, 2, last - 1, 1).getValues();
          var ch2 = false;
          st.forEach(function (r) { if (String(r[0] || 'seen') === 'seen') { r[0] = 'ok'; ch2 = true; } });
          if (ch2) sh.getRange(2, 2, last - 1, 1).setValues(st);
        }
      }
      SpreadsheetApp.flush();
      approvalSave_(want, apM.gen + 1);
      try { appendTo_('司令塔の記録', ['timestamp', 'what'], [new Date(), '端末の承認制を' + (want ? '入' : '切') + 'にした']); } catch (eW2) {}
      return ownerStateOut_();
    });
  }
  if (action === 'owner_dev') {
    var cid = String(body.cid || ''), to = String(body.st || '');
    if (!/^[A-Za-z0-9_-]{12,40}$/.test(cid)) throw new Error('bad request: 端末の番号が違います');
    if (['ok', 'no', 'del', 'label'].indexOf(to) < 0) throw new Error('bad request: 操作が違います');
    return withLock_(function () {
      var sh = devSheet_(), row = devRow_(sh, cid);
      if (!row) throw new Error('bad request: その端末は一覧にありません');
      var apD = approvalState_(), ck = 'dv' + apD.gen + '_' + cid, c = CacheService.getScriptCache();
      if (to === 'del') { sh.deleteRow(row); c.remove(ck); }
      else if (to === 'label') sh.getRange(row, 3).setValue(safeText_(cut_(body.label, 20)));
      else { sh.getRange(row, 2).setValue(to); try { c.put(ck, to, DEVICE_CACHE_SEC); } catch (eC) {} }
      SpreadsheetApp.flush();
      return ownerStateOut_();
    });
  }
  if (action === 'owner_reg_ch') {
    var keysR = ownerKeys_();
    if (keysR.length >= OWNER_KEYS_MAX) throw new Error('bad request: パスキーは' + OWNER_KEYS_MAX + '個までです。使っていないものを消してください');
    var c2 = ownerChallengeNew_('create');
    return { ok: true, ch: c2.ch, chId: c2.chId, rpId: rpIdOf_(ownerOrigins_()[0]), exclude: keysR.map(function (k) { return k.id; }) };
  }
  if (action === 'owner_reg') {
    var chR = ownerChallengeTake_('create', body.chId);
    var originsR = ownerOrigins_();
    var nk = webauthnRegister_(body, chR, rpIdOf_(originsR[0]), originsR);
    var cur = ownerKeys_();
    if (cur.length >= OWNER_KEYS_MAX) throw new Error('bad request: パスキーは' + OWNER_KEYS_MAX + '個までです');
    if (cur.some(function (k) { return k.id === nk.id; })) throw new Error('bad request: この端末は、もう登録されています');
    nk.label = cut_(body.label, 20) || 'パスキー';
    nk.at = new Date().toISOString();
    cur.push(nk);
    ownerKeysSave_(cur);
    try { appendTo_('司令塔の記録', ['timestamp', 'what'], [new Date(), safeText_('パスキーを登録した（' + nk.label + '）')]); } catch (eW3) {}
    return ownerStateOut_();
  }
  if (action === 'owner_key_del') {
    var idD = String(body.id || '');
    var left = ownerKeys_().filter(function (k) { return k.id !== idD; });
    ownerKeysSave_(left);
    return ownerStateOut_();
  }
  // v219：司令塔だけのイベント
  var lv = liveApi_(action, body);
  if (lv) return lv;
  throw new Error('unknown action: この操作（' + cut_(action, 20) + '）は、このサーバーの版（' + GAS_VERSION + '）にはありません');
}
