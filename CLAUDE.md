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
  - `static.test.js`：構文、版の整合（GAS_VERSION ≧ GAS_MIN、PROGRESS.md に今の版）、**刷ったQRの署名の控え（`fixtures/sigs.json`）**、localStorage のキー名、R8 の46件が地図にあるか、GAS の数式注入対策
  - `hardening.spec.js`：XSS（悪い文字列を全画面・係員画面に流す）、地図の押しやすさ、Service Worker でのオフライン
  - `staff.spec.js`：係員の待ち人数・混雑度の送信、送れなかった更新の再送
  - `a11y.spec.js`：アクセシビリティ（axe-core、WCAG 2 A/AA）。ふつう・暗いの2テーマ×主な11画面で重大な違反0
  - `scan.spec.js`：QRを読むカメラ（BarcodeDetector とカメラを差し替えて、読めばスタンプが付く・ほかのQRは付かない・iPhone 向けの案内）
  - `app.spec.js`：幅 320/390/768/1280px と文字「特大」で横はみ出し・コンソールのエラー、4画面、階の切り替え、検索、`?booth=`、QR のスタンプ（正しい署名・違う署名）、5個で交換の案内、`?mode=` の6画面、係員ログインの拒否、GAS の失敗・遅延
- GAS は `tests/mock.js` が模擬する（`fixtures/booths.json` は本番の応答の写し）。本番のシートには届かない
- スクリーンショット：`SHOTS=shots npx playwright test shots.spec.js`（`tests/shots/` は GitHub に上げない）
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
