/* 黒工文化祭マップ Service Worker
   目的：校内Wi-Fiが不安定でも「アプリの外側」が必ず開くようにする。
   混雑データ(GAS)は絶対にキャッシュしない（古い混雑状況を見せないため）。 */
const CACHE = 'kuroko-map-v189';
// 画面は SHELL_KEY（./index.html）1つにまとめて保存する。
// './' も入れると同じHTMLが別の控えとして2つ残り、使われない方が約400KBを占める。
const SHELL = ['./index.html', './manifest.json', './manifest-app.json', './apple-touch-icon.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];


self.addEventListener('install', e => {
  // addAll は1つでも404だと全体が失敗し、SWがインストールされない＝オフライン対応が
  // まるごと効かなくなる（manifest.json のアップロード漏れで実際に起きうる）。
  // 1件ずつ入れて、取れなかったものは諦める。index.html だけは必須。
  // 【v143】ふつうに取ると、ブラウザと GitHub Pages の配信サーバーの控え（最大10分）から
  // 「1つ前の版」の index.html が返り、新しい版の SW が古い画面を保存してしまっていた
  // （公開して2回開き直しても前の版のままだった）。版ごとに違う引数を付けて取り、控えを通さない
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => freshFetch(u, CACHE)
      .then(res => (res && res.ok) ? cache.put(new URL(u, self.location.href).href, res) : null)
      .catch(() => {})));
    if (!(await cache.match('./index.html'))) {
      try { await cache.add('./index.html'); } catch (err) { /* 次回の取得に任せる */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 画面側から「今すぐ切り替えて」と言われたときのため（更新バーの再読み込み用）
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // GAS への通信はネットワーク専用（キャッシュ禁止）
  if (url.hostname.includes('script.google.com')) return;
  if (url.origin !== location.origin) return;

  e.respondWith(handle(e.request, e));
});

/**
 * 控え（ブラウザの HTTP キャッシュ・配信サーバー）を通さずに取る。
 * GitHub Pages は同じ URL を最大10分控えるので、引数（tag）を変えて別の URL として取る。
 * 引数が違っても中身は同じファイル（静的配信なので引数は無視される）
 */
function freshFetch(u, tag){
  const url = new URL(u, self.location.href);
  url.searchParams.set('sw', tag);
  return fetch(new Request(url.href, { cache: 'reload' }));
}

/**
 * アプリ本体（このマップの画面）かどうか。中身の差分を見る対象をここだけに絞る。
 * v179：本体は「フォルダの入口（./）」と「index.html」だけ。以前は「ページを開く操作すべて」と「.html で終わるものすべて」を
 * 本体とみなしていたので、同じ場所に別のページ（例：omikuji.html）を置くと、一度マップを開いた端末では
 * そのページの代わりにマップが出ていた。
 */
const SCOPE_PATH = new URL('./', self.location.href).pathname;
function isShell(request){
  const p = new URL(request.url).pathname;
  return p === SCOPE_PATH || p === SCOPE_PATH + 'index.html';
}

/**
 * アプリ本体は、引数が違っても中身は同じ1枚。
 * ブースのQRは ?booth=1F-02&qr=1&k=... のように毎回ちがうURLになるので、
 * URLそのままを鍵にしていると
 *   ・読み取ったQRの数だけ同じ436KBの控えが増える
 *   ・初めてのURLは「控えなし」扱いになり、回線が細いときに
 *     2.5秒で切り上げられず、白い画面のまま待たされる
 * という状態になっていた。本体はいつも同じ鍵で出し入れする。
 */
const SHELL_KEY = new URL('./index.html', self.location.href).href;

/** 開いている画面すべてに「新しい版が届いた」と伝える。 */
async function notifyUpdated(){
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c => c.postMessage({ type: 'app-updated' }));
}

/**
 * 保存してある分をすぐ返し、裏で取り直して保存を新しくする（stale-while-revalidate）。
 * 以前はネットワーク優先で、取得した本文をすべて読み終えて保存してから返していたため
 * 流し読みができず、細い回線では 2.5秒の打ち切りまで毎回白い画面で待たされていた
 * （2回目以降の方が初回より遅い）。
 * 中身が変わっていたら画面側へ知らせ、「新しい版があります」のバーから切り替えてもらう。
 * 保存が無い（初回）ときだけネットワークを待つ。
 */
async function handle(request, event){
  const cache = await caches.open(CACHE);
  const shell = isShell(request);
  // v179：このマップ以外のページ（同じ場所に置いた別の .html）は、いつも新しいものを取りに行く。
  // 取れないとき（圏外）だけ、前に開いたときの控えを出す。マップの画面で代用はしない
  if (!shell && request.mode === 'navigate'){
    try{
      const res = await fetch(request);
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    }catch(e){
      return (await cache.match(request)) || Response.error();
    }
  }
  const key = shell ? SHELL_KEY : request;
  const cached = await cache.match(key);

  const refresh = (async () => {
    try{
      // 本体は1分ごとに変わる引数を付けて取る（配信サーバーの10分の控えを避ける。1分なら負荷も増えない）
      const res = shell ? await freshFetch('./index.html', 'm' + Math.floor(Date.now() / 60000))
                        : await fetch(request, { cache: 'no-cache' });
      if (!res || !res.ok) return res;
      if (shell && cached){
        const [a, b] = await Promise.all([res.clone().text(), cached.clone().text()]);
        await cache.put(key, res.clone());
        if (a !== b) notifyUpdated();
      } else {
        await cache.put(key, res.clone());
      }
      return res;
    }catch(e){ return null; }
  })();

  if (cached){
    if (event && event.waitUntil) event.waitUntil(refresh);
    return cached;
  }
  // 保存が無いときはネットワークを待つしかない（取れなければ本体の控えで代用）
  const res = await refresh;
  if (res) return res;
  return (shell ? await cache.match(SHELL_KEY) : null) || Response.error();
}
