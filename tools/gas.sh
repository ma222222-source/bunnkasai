#!/usr/bin/env bash
# GAS（Apps Script）とのやりとりを1か所にまとめたもの。clasp を直接たたかず、これを使う。
#
#   bash tools/gas.sh check    Code.gs の構文チェック（GAS には触らない）
#   bash tools/gas.sh backup   いま GAS にあるコードを gas-backup/<日時>/ に保存
#   bash tools/gas.sh diff     GAS のコードと手元の Code.gs の差分
#   bash tools/gas.sh status   push したら何が送られるかの確認（送らない）
#   bash tools/gas.sh push     backup → check → GAS のエディタのコードを置き換える   ※ユーザーの承認後
#   bash tools/gas.sh deploy "説明"
#                              push → 版を作る → 本番のデプロイ（サイトが呼ぶURL）を新しい版に  ※ユーザーの承認後
#
# なぜこうしているか：
# - GAS 側のファイル名は「コード」。clasp push はプロジェクトを丸ごと置き換えるので、
#   Code.gs のまま送ると「コード」が消えて「Code」ができる。送る直前に .gas-build/コード.js へ写して名前をそろえる
# - index.html などサイトのファイルを GAS に送らないよう、.gas-build には Code.gs と appsscript.json しか入れない
# - 本番のデプロイID は index.html の CONFIG に書かれている URL から取る（2か所に書いて食い違うのを防ぐ）
# - 接続情報 .clasp.json と認証 ~/.clasprc.json は GitHub に上げない（.gitignore）
set -euo pipefail
cd "$(dirname "$0")/.."

GAS_NAME='コード'

need_clasp() {
  command -v clasp >/dev/null || { echo 'clasp がありません：npm install -g @google/clasp' >&2; exit 1; }
  [ -f .clasp.json ] || { echo '.clasp.json がありません（CLAUDE.md の「GAS（clasp）」を参照）' >&2; exit 1; }
}

script_id() { node -e "process.stdout.write(require('./.clasp.json').scriptId)"; }

prod_deployment() {
  grep -o 'script.google.com/macros/s/[A-Za-z0-9_-]*' index.html | head -1 | sed 's#.*/s/##'
}

check() {
  node -e "new (require('vm').Script)(require('fs').readFileSync('Code.gs','utf8'),{filename:'Code.gs'})"
  node -e "JSON.parse(require('fs').readFileSync('appsscript.json','utf8'))"
  echo "check OK（GAS_VERSION $(grep -o "GAS_VERSION = '[^']*'" Code.gs | cut -d"'" -f2)）"
}

backup() {
  need_clasp
  # 親フォルダの .clasp.json を拾わないよう、控え専用の接続ファイルで pull する
  local dir="gas-backup/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  printf '{"scriptId":"%s","rootDir":"%s"}\n' "$(script_id)" "${dir#gas-backup/}" > "$dir.clasp.json"
  clasp -P "$dir.clasp.json" pull >/dev/null
  rm -f "$dir.clasp.json"
  echo "backup: $dir（GAS_VERSION $(grep -ho "GAS_VERSION = '[^']*'" "$dir"/*.js | cut -d"'" -f2)）" >&2
  echo "$dir"
}

build() {
  rm -rf .gas-build && mkdir -p .gas-build
  cp Code.gs ".gas-build/$GAS_NAME.js"
  cp appsscript.json .gas-build/
}

cmd="${1:-}"; shift || true
case "$cmd" in
  check) check ;;
  backup) backup >/dev/null ;;
  diff)
    dir=$(backup)
    diff <(tr -d '\r' < "$dir/$GAS_NAME.js") <(tr -d '\r' < Code.gs) && echo '差分なし' || true ;;
  status) need_clasp; build; clasp status ;;
  push)
    need_clasp; check; backup >/dev/null; build
    clasp push
    echo 'push 済み：エディタのコードが変わった（サイトが使う本番のデプロイはまだ前の版）' ;;
  deploy)
    desc="${1:?deploy には説明が要ります（例：v138 GAS-2026-09-30a）}"
    need_clasp; check; backup >/dev/null; build
    clasp push
    ver=$(clasp create-version "$desc" | grep -o '[0-9]\+' | tail -1)
    dep=$(prod_deployment)
    clasp update-deployment "$dep" -V "$ver" -d "$desc"
    echo "deploy 済み：版 $ver を本番のデプロイ $dep に。?mode=check で「サーバーの版」を確かめる" ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
