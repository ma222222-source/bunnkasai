# CLAUDE.md — Claude Code 用の作業ルール

このリポジトリ（https://github.com/ma222222-source/bunnkasai）は黒工文化祭の校内マップ。
仕様・開発ルール・進み具合の正本は **`SPEC.md` → `RULES.md` → `PROGRESS.md`**（この順に読む）。
このファイルは、それに加えて Claude Code が GitHub・GAS と直接やりとりするときのルール。RULES.md と食い違ったら、GitHub・GAS の操作についてはこのファイルを優先する。

## 自動運用（2026-09-29 ユーザーが許可）

ユーザーが「改善して」「次」などと言ったら、次を**確認なしで一続きに**行う。

1. GitHub と GAS の最新を取る（`git fetch`、`bash tools/gas.sh diff`）。衝突・食い違いがあれば止めて報告
2. 作業用ブランチ（`claude/<内容>`）で直す。版を上げる（RULES.md §4）
3. テスト：`cd tests && npm test`（静的テスト＋画面テスト）。必要ならスクリーンショットで目視
4. `SPEC.md`・`RULES.md`・`PROGRESS.md`・このファイルを実装に合わせて直す
5. コミット → 作業用ブランチへプッシュ → PR → GitHub Actions のテストが通ったら **main へマージ**（GitHub Pages が公開する）
6. `Code.gs` を変えたときは `bash tools/gas.sh deploy "vNNN GAS-YYYY-MM-DDx"`（既存の本番デプロイを新しい版に。URL は変えない）
7. 公開の確認：公開URLの `BUILD`、GAS の `serverVersion`、`?mode=check`
8. 問題があれば安全に戻せる範囲で直す（直しも同じ手順で）。日本語で結果と公開中の版を報告する

**止める条件（自動で進めない）**

- テストが1つでも失敗したら、本番（main・GAS の deploy）に反映しない
- 本番に出したあと重大な問題が見つかったら、新しい更新を止めてユーザーに報告する
- 次は自動の対象外。必ずユーザーに聞く：データの削除、シートの初期化・行の移動（`setupR8AndArchiveOthers` など）、認証設定（`ADMIN_PASS`・共有設定・デプロイのアクセス権）の変更、本番のシートに書き込むテスト
- 公開URL（GitHub Pages）と GAS の本番デプロイID は変えない。新しいデプロイは作らない
- スタンプ・QR・部屋ID・localStorage のキー名・URL の形の互換性を壊さない（`tests/static.test.js` が見張っている）
- Claude Code の自動モードの安全チェックがマージ・デプロイを止めたときは、回り道をせず、ユーザーに実行するコマンドを伝える（許可ルールを足すのはユーザー）

## 作業を始めるとき

1. `git fetch origin` で GitHub の最新を確かめ、`git status` で今のブランチと未コミットの変更を見る
2. ローカルの main が遅れていて、未コミットの変更が無ければ `git merge --ff-only origin/main` で追いつく。食い違い（分岐）があれば止めてユーザーに聞く
3. `SPEC.md` `RULES.md` `PROGRESS.md` を読み、RULES.md §0 の版の一致（`CONFIG.BUILD`・`sw.js` の `CACHE`・`GAS_VERSION`）を確かめる
4. ユーザーの PC の `Downloads\bunnkasai-vNNN-deploy\` に GitHub より新しい版があることがある（ほかの AI が作ったもの）。どれが最新かを確かめてから直し、古いファイルで上書きしない

## ブランチとプッシュ

- 作業は必ず作業用ブランチで行う（名前は `claude/<内容>`、例 `claude/v139-fix-header`）
- 作業用ブランチへのコミットとプッシュ（`git push -u origin <branch>`）は確認なしでよい
- main へのマージは上の「自動運用」の条件（テストが通っていること）を満たしたときだけ。`gh pr merge <番号> --merge`
- **強制プッシュ（`--force` / `--force-with-lease`）は禁止**。公開済みのコミットを書き換えない（rebase・amend をしない）
- 既存の未コミット変更を勝手に破棄しない（`reset --hard`・`checkout -- .`・`clean` などは使わない）。必要なら別ブランチか stash に退避してユーザーに伝える
- コミットメッセージは日本語で「何を・なぜ」を1行目に。版を上げたら版番号も入れる（例：`v138: …`）

## テスト（tests/）

- `cd tests && npm install`（初回だけ）→ `npm test`
  - `static.test.js`：構文、版の整合（GAS_VERSION ≧ GAS_MIN、PROGRESS.md に今の版）、**刷ったQRの署名の控え（`fixtures/sigs.json`）**、localStorage のキー名、R8 の46件が地図にあるか、GAS の数式注入対策、index.html の id の重複なし
  - `hardening.spec.js`：XSS（悪い文字列を全画面・係員画面に流す）、地図の押しやすさ、Service Worker でのオフライン、SW が同じ場所の別のページ（`tests/fixtures/other-page.html`）を置き換えないこと、Chromium の判定でホーム画面に追加できる条件
  - `staff.spec.js`：係員の待ち人数・混雑度の送信、送れなかった更新の再送、科・場所ごとのまとめ（開く・覚える・古い順）、担当ブースえらび（科→ブース・ぜんぶ）
  - `gas.test.js`（Node、`gas-mock.js`）：**サーバー（Code.gs）をそのまま動かす**。スプレッドシート・キャッシュ・ロック等は模擬。セットアップ46件、GET とキャッシュ、係員の更新（人数→状態・名前の列を触らない・不正値）、パスワード（締め出し・短い設定）、45分で情報なし、お知らせ、来場者、ブースの追加・削除、一括、スタンプの控え、二重交換の防止（つないだ番号も）、見出しの扱い、端末のエラー記録（clientlog）、振り返りレポートの集計、ピーク時のキャッシュ（作成中は控えを返す・作成中に更新が入ったら置かない・障害時は控え）。Code.gs を直したら必ず通す。`gas-fuzz.js` のでたらめな送信（落ちない・返事は JSON・パスワードなしではシートが変わらない）と、スタンプの控え・交換・番号をつなぐ操作を手本と比べるテストも入っている。`app.spec.js` には Code.gs が作ったレポートを画面に描かせるテストもある
  - `print.spec.js`：印刷物の番人。QR印刷シートを本番のアドレスで作り、47枚すべてを自前の読み取りで読む（ブース・署名・外部ブラウザの引数、小さく刷っても読める）。紙マップ A4 2ページ、QRシート 9ページ以内（PDF にして数える）。QRシートは1ページ6枚の箱・はみ出しなし・QR 43mm 以上、1枚だけ刷る。三つ折りパンフレット（`?mode=pamphlet`）は A4 横 2ページ・面の幅 97/100/100mm・はみ出しなし・仮の文字や説明が紙に出ない・校長と生徒会長のあいさつの欄（空でも刷る）・`docs/pamphlet.pdf` が A4 横 2ページ
  - `monkey.spec.js`：でたらめ操作（種つき乱数で階・拡大・タブ・詳細・検索・絞り込み・★・スタンプ・画面や文字の大きさを次々に操作）。エラーと崩れ（横はみ出し・地図のボタンの重なり・拡大の値）が無いこと。操作の組み合わせで起きる不具合を拾う。もっと回すとき：`SEEDS=1,2,3,4,5,6 STEPS=300 npx playwright test monkey.spec.js`
  - `monkey-tap.spec.js`：本物のタップ・なぞり・長押し・キー・戻る／進むでのでたらめ操作（来場者の画面と、模擬のサーバーにつないだ係員の画面）。係員の画面を多く回すとき：`START="/?mode=admin" STAFF=1 SEEDS=1,2,3,4 STEPS=300 npx playwright test monkey-tap.spec.js`
  - `fuzz.spec.js`：サーバーの返事が変な形（0件・156件・でたらめな値・欄の欠け・配列でない など12種類）でも、来場者の画面と印刷の画面がエラー・真っ白・横はみ出しにならないこと
  - `store.spec.js`：端末の保存（localStorage）がでたらめな形でも開ける・QR のスタンプが付く（係員の画面まで）。起動に失敗したときの「直して開き直す」（本体の案内・本体に頼らない最後の砦）でスタンプが残ること
  - `net.spec.js`：通信がでたらめ（404・500・HTML・こわれた JSON・null・通信断 など）でも、ブースが消えず・通信が戻れば立ち直り・スタンプの控えがサーバーに届くこと（時計を早送り）
  - `tabs-app.spec.js`：同じ端末でタブを2つ開いても、★・スタンプ・いまここ・設定が消えず、もう片方にその場で伝わること（iPhone・Android のまねでも）
  - `time.spec.js`：時計を開催の前日〜次の日まで30分ずつ動かして、エラー・変な文字が出ないこと、時刻ごとの案内（開場前・開催中・最終入場・終了・次の日）。開催日はテストの中で決める
  - `leak.spec.js`：2時間ぶん開きっぱなし（時計を早送り）でも、画面の部品・メモリ・保存が増え続けないこと。もっと長く：`HOURS=6 npx playwright test leak.spec.js`
  - `a11y.spec.js`：アクセシビリティ（axe-core、WCAG 2 A/AA）。ふつう・暗いの2テーマ×主な11画面で重大な違反0
  - `scan.spec.js`：QRを読むカメラ（BarcodeDetector あり・なし（自前の読み取り）の両方で読めばスタンプが付く・ほかのQRは付かない・カメラが無い／許可しないときの案内）、自前の読み取りの精度（誤り訂正・回転・斜め・遠近・ぼけ・雑音・遠く）
  - `app.spec.js`：幅 320/390/768/1280px と文字「特大」で横はみ出し・コンソールのエラー、4画面、階の切り替え、検索、`?booth=`、QR のスタンプ（正しい署名・違う署名）、5個で交換の案内、`?mode=` の6画面、係員ログインの拒否、GAS の失敗・遅延
  - `app.spec.js`・`scan.spec.js` は iPhone 13（WebKit）・Pixel 7（Android の Chrome）のまねでも動く（`playwright.config.js` の projects `iphone`・`android`）。Windows の WebKit はカメラの映像を作れないので、映像を使う3件は WebKit では飛ばす
- GAS は `tests/mock.js` が模擬する（`fixtures/booths.json` は本番の応答の写し）。本番のシートには届かない
- スクリーンショット：`SHOTS=shots npx playwright test shots.spec.js`（`tests/shots/` は GitHub に上げない）
- 三つ折りパンフレットの PDF：`cd tests && npm run pamphlet`（`make-pamphlet.js`）。本番のブースの一覧を読んで `docs/pamphlet.pdf` を作り直す（読むだけ。シートには書かない）。`-- --mock` で手元の写し。ブースの名前・数やタイムテーブルを変えたら作り直してコミットする。画面で書いた文字（あいさつなど）はその端末にしか無いので、PDF に入れるときは `CONFIG.PAMPHLET` に書く
- `STAMP_KEY` を意図して変えたときだけ `node static.test.js --update-sigs`（刷ったQRが全部無効になるので、ふつうはしない）
- GitHub Actions（`.github/workflows/test.yml`）が push・PR ごとに同じテストを動かす

## GAS（Apps Script）— clasp で更新する

`Code.gs` は Apps Script にも置かれている。clasp（Google 公式の CLI、`npm install -g @google/clasp`）で更新する。**clasp を直接たたかず `bash tools/gas.sh <コマンド>` を使う。**

| コマンド | 何をするか |
|---|---|
| `check` | `Code.gs`・`appsscript.json` の構文チェック |
| `backup` | いま GAS にあるコードを `gas-backup/<日時>/` に保存 |
| `diff` | GAS のコードと手元の `Code.gs` の差分（先に backup する） |
| `status` | push したら送られるファイルの確認（送らない） |
| `push` | backup → check → GAS のエディタのコードを置き換える。サイトが呼ぶ本番のデプロイは版で固定なので来場者には影響しない（エディタから動かす関数とトリガーは新しいコードで動く） |
| `deploy "説明"` | push → 版を作る → 本番のデプロイを新しい版に（URL は変わらない） |

- 本番のデプロイID は `index.html` の `CONFIG` の URL から取る（別に書かない）
- `tools/gas.sh` は送る前に改行を LF にそろえる（CRLF の appsscript.json だと clasp が「Skipping push.」で黙って送らない）。送られなかったら止まる（古い中身で版を作らない）。「Script is already up to date.」は変更なしの意味で正常
- GAS 側のファイル名は `コード`。`tools/gas.sh` が送る直前に `.gas-build/コード.js` に写す。clasp push はプロジェクトを丸ごと置き換えるので、`.gas-build` を通さずに push しない
- `setupR8AndArchiveOthers` など本番のシートを書き換える関数は自動で動かさない（ユーザーに頼む）
- デプロイ後は `?mode=check` の「サーバーの版」で確かめる。`Code.gs` を変えたら `GAS_VERSION` を上げる（RULES.md §4）
- Apps Script API がオフだと push できない：https://script.google.com/home/usersettings でオン

接続の準備（このPCでは済み。別のPCで始めるときだけ）：

1. https://script.google.com/home/usersettings で「Google Apps Script API」をオン
2. `clasp login`（ユーザーがブラウザで許可する。認証は `~/.clasprc.json` に入り、リポジトリには入らない）
3. リポジトリ直下に `.clasp.json` を作る：`{"scriptId":"<スクリプトID>","rootDir":".gas-build"}`。スクリプトIDは Apps Script の URL の `/projects/` と `/edit` の間。`.clasp.json` は `.gitignore` 済み
4. `bash tools/gas.sh diff` でつながることを確かめる

## 機密情報

- APIキー・パスワード・トークン・`ADMIN_PASS`・`SPREADSHEET_ID` の値をコミットしない。コミット前に差分を確かめる
- スプレッドシートID をリポジトリに書かない（RULES.md §6）。`gas-backup/`・`.clasp.json`・`.gas-build/` は GitHub に上げない
- 認証が必要なときだけユーザーに操作を頼む（`gh auth login`・`clasp login` など）。認証情報を受け取らない

## 報告

作業が終わったら、日本語で短く：調べて分かった版、直したこと、テスト結果と未確認のこと、副作用、ブランチ・コミット・PR、GAS の更新の有無、公開中の版、ユーザーに頼むこと。
