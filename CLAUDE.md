# CLAUDE.md — Claude Code 用の作業ルール

このリポジトリ（https://github.com/ma222222-source/bunnkasai）は黒工文化祭の校内マップ。
仕様・開発ルール・進み具合の正本は **`SPEC.md` → `RULES.md` → `PROGRESS.md`**（この順に読む）。
このファイルは、それに加えて Claude Code が GitHub と直接やりとりするときのルール。RULES.md と食い違ったら、GitHub 操作についてはこのファイルを優先する。

## 作業を始めるとき

1. `git fetch origin` で GitHub の最新を確かめ、`git status` で今のブランチと未コミットの変更を見る
2. ローカルの main が遅れていて、未コミットの変更が無ければ `git merge --ff-only origin/main` で追いつく。食い違い（分岐）があれば止めてユーザーに聞く
3. `SPEC.md` `RULES.md` `PROGRESS.md` を読み、RULES.md §0 の版の一致（`CONFIG.BUILD`・`sw.js` の `CACHE`・`GAS_VERSION`）を確かめる
4. ユーザーの PC の `Downloads\bunnkasai-vNNN-deploy\` に GitHub より新しい版があることがある。どれが最新かを確かめてから直す

## ブランチとプッシュ

- 作業は必ず作業用ブランチで行う（名前は `claude/<内容>`、例 `claude/v138-fix-header`）
- 作業用ブランチへのコミットとプッシュ（`git push -u origin <branch>`）は確認なしで自動で行ってよい
- **main への直接プッシュ・マージ（PR のマージを含む）は、必ずユーザーの承認を得てから**
- **強制プッシュ（`--force` / `--force-with-lease`）は禁止**。履歴の書き換え（rebase・amend で公開済みのコミットを変える）もしない
- 既存の未コミット変更を勝手に破棄しない（`reset --hard`・`checkout -- .`・`clean` などは使わない）。必要なら別ブランチか stash に退避してユーザーに伝える
- コミットメッセージは日本語で「何を・なぜ」を1行目に。版を上げたら版番号も入れる（例：`v138: ヘッダーの表示を直す`）

## 変更・テスト・記録

- 既存の機能やデータを勝手に消さない（詳細は RULES.md §2）
- コードを直したら可能な範囲で自動テストする。最低限：
  - `node` で `Code.gs`・`sw.js`・`index.html` 内の script の構文チェック
  - プレビュー（`.claude/launch.json` の `map-test`、`python -m http.server 8731`）で4画面の表示・コンソールのエラー0・幅390pxで横はみ出し0・`?mode=admin` のログイン画面（RULES.md §8）
  - 本番のシートに書き込む確認は、ユーザーの許可を取ってから
- 版を上げるルール（RULES.md §4）を守る
- 作業に応じて `PROGRESS.md`（毎回：変更履歴に1行）と `SPEC.md`（仕様を変えたとき）を更新する

## 機密情報

- APIキー・パスワード・トークン・`ADMIN_PASS`・`SPREADSHEET_ID` の値をコミットしない。コミット前に差分を確かめる
- 認証が必要なときだけユーザーに操作を頼む（`gh auth login` など）。認証情報を受け取らない

## 報告

作業が終わったら、GitHub への保存結果（ブランチ名・コミット・PR の URL）と、ユーザーがやること（main へのマージの承認、GAS の再デプロイなど）を短く報告する。
