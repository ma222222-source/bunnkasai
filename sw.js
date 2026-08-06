/* 黒工文化祭マップ Service Worker
   目的：校内Wi-Fiが不安定でも「アプリの外側」が必ず開くようにする。
   混雑データ(GAS)は絶対にキャッシュしない（古い混雑状況を見せないため）。 */
const CACHE = 'kuroko-map-v36';
const SHELL = ['./', './index.html', './manifest.json'];

// 回線が遅いときにネットワークを待ち続けない上限（ms）。
// これを過ぎたら保存してある画面を先に出し、取得できた分は次回に反映する。
const NET_TIMEOUT = 2500;

self.addEventListener('install', e => {
  // addAll は1つでも404だと全体が失敗し、SWがインストールされない＝オフライン対応が
  // まるごと効かなくなる（manifest.json のアップロード漏れで実際に起きうる）。
  // 1件ずつ入れて、取れなかったものは諦める。index.html だけは必須。
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => cache.add(u).catch(() => {})));
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

  e.respondWith(handle(e.request));
});

/** アプリ本体（HTML）かどうか。中身の差分を見る対象をここだけに絞る。 */
function isShell(request){
  if (request.mode === 'navigate') return true;
  const p = new URL(request.url).pathname;
  return p.endsWith('/') || p.endsWith('.html');
}

/** 開いている画面すべてに「新しい版が届いた」と伝える。 */
async function notifyUpdated(){
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c => c.postMessage({ type: 'app-updated' }));
}

/**
 * 基本はネットワーク優先。ただし NET_TIMEOUT を過ぎたらキャッシュを先に返し、
 * 取得できたものは裏でキャッシュへ入れる。
 * 「更新したのに反映されない」を避けつつ、遅い回線で待たされないようにする。
 *
 * さらに、キャッシュを先に返したあとで新しいHTMLが届いた場合は
 * 画面側へ通知する（利用者が古い画面のまま気づかない状態を作らない）。
 */
async function handle(request){
  const cache = await caches.open(CACHE);
  const shell = isShell(request);

  const cached = await cache.match(request);
  // 差分比較用に、返す前の中身を控えておく（HTMLのときだけ）
  let prevText = null;
  if (shell && cached){
    try{ prevText = await cached.clone().text(); }catch(e){ prevText = null; }
  }

  let servedCache = false;

  const network = fetch(request).then(async res => {
    if (!res || !res.ok) return res;
    try{
      if (shell){
        const text = await res.clone().text();
        await cache.put(request, res.clone());
        if (servedCache && prevText !== null && text !== prevText) notifyUpdated();
      }else{
        await cache.put(request, res.clone());
      }
    }catch(e){ /* 保存に失敗しても表示は続ける */ }
    return res;
  });

  if (!cached) {
    // 保存が無いときはネットワークを待つしかない
    try { return await network; }
    catch (e) { return (await cache.match('./index.html')) || Response.error(); }
  }

  // キャッシュがあるなら、ネットワークを少しだけ待って、遅ければ保存分を返す
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), NET_TIMEOUT));
  try {
    const winner = await Promise.race([network.catch(() => null), timeout]);
    if (winner) return winner;
    servedCache = true;
    return cached;
  } catch (e) {
    servedCache = true;
    return cached;
  }
}
