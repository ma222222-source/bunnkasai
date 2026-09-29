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
var GAS_VERSION = '2026-09-29a';
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
function checkPass_(pass, cid) {
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
}

/* ============================== GET ============================== */
function doGet(e) {
  // ?report=1 で当日の振り返りデータを返す（?date=YYYY-MM-DD で日付指定）
  var param = (e && e.parameter) || {};
  // ?ledger=端末番号 … その端末のスタンプ記録を返す（別のブラウザ・機種への引き継ぎ用）
  if (param.ledger) {
    try {
      return json_(readLedger_(String(param.ledger)));
    } catch (errL) {
      return json_({ ok: false, error: String(errL.message || errL) });
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
  try { cache.put(CACHE_BUILDING, '1', 10); } catch (eB) {}
  // 作っている間に係員の更新が入ったら、作った結果はキャッシュに置かない（古い内容を15秒焼き付けない）
  var gen0 = cache.get(CACHE_GEN) || '';
  var data = buildPayload_();
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

  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var hist = buildHistory_();
    rows.forEach(function (r) {
      var id = String(r[idx['id']] == null ? '' : r[idx['id']]).trim();
      if (!id) return;

      var ts = toDate_(r[idx['time']]);
      var iso = ts ? ts.toISOString() : null;
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
    staleMinutes: STALE_MINUTES,
    waitThresholds: { warn: WAIT_WARN, busy: WAIT_BUSY },
    pollSec: pollSec_(),
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

    // 来場者のスタンプの控え。端末の保存が消えても、ここから戻せるようにする。
    // パスワードは要らない（来場者の端末から送る）。追記だけで、既存の行は触らない
    if (action === 'ledger') {
      return json_(appendLedger_(body));
    }
    // お菓子の交換。同じスタンプを別のブラウザで二重に使えないよう、サーバーの控えで確かめる
    if (action === 'redeem') {
      return json_(redeemLedger_(body));
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

    // ---------------------------------------------------------------
    // ブースそのものの追加・書き換え・削除。
    // 画面の地図から部屋をおして割り当てるために足した口。既存の update とは
    // 別なので、この版を貼っていなくても従来の動作は一切変わらない
    // （新しい口だけが「不明な操作」で失敗する）。
    // ---------------------------------------------------------------
    if (action === 'upsert') {
      checkPass_(body.pass, body.cid);
      var uid = cleanBoothId_(body.id);            // 部屋ID（例 1F-02）の形だけ受ける（数式や巨大な文字列を入れさせない）
      if (!uid) throw new Error('bad request');
      return json_(upsertBooth_(uid, body));
    }

    if (action === 'remove') {
      checkPass_(body.pass, body.cid);
      var rid = String(body.id || '').trim();
      if (!rid) throw new Error('bad request');
      return json_({ ok: true, removed: removeBooth_(rid) });
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
      if (isNaN(n) || n === 0 || Math.abs(n) > 1000) throw new Error('bad count');
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
      return json_({ ok: true, status: 'success', duplicate: dup, visitors: readVisitors_() });
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

    for (var i = 0; i < rows; i++) {
      var id = String(idVals[i][0] == null ? '' : idVals[i][0]).trim();
      if (!id) continue;
      if (ids && ids.indexOf(id) === -1) continue;
      stVals[i][0] = status;
      tmVals[i][0] = now;
      if (wtVals && wait !== undefined) wtVals[i][0] = (wait === null ? '' : wait);
      logs.push([now, id, status, (wait === null || wait === undefined) ? '' : wait]);
      updated++;
    }
    if (!updated) return 0;

    sh.getRange(2, stCol, rows, 1).setValues(stVals);
    sh.getRange(2, tmCol, rows, 1).setValues(tmVals);
    if (wtVals && wait !== undefined) sh.getRange(2, wtCol, rows, 1).setValues(wtVals);
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
  try { clearCache_(); } catch (err) {}
}
function clearCache_() {
  try {
    var c = CacheService.getScriptCache();
    c.put(CACHE_GEN, String(Date.now()) + Math.random().toString(36).slice(2, 6), 3600);
    c.remove(CACHE_KEY);
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
  if (!/^[a-z0-9]{6,40}$/i.test(c)) throw new Error('bad cid');
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
  if (!ids.length) throw new Error('bad request');
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
