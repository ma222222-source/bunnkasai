/* 黒工文化祭マップ Service Worker
   目的：校内Wi-Fiが不安定でも「アプリの外側」が必ず開くようにする。
   混雑データ(GAS)は絶対にキャッシュしない（古い混雑状況を見せないため）。 */
const CACHE = 'kuroko-map-v6';
const SHELL = ['./', './index.html', './manifest.json'];

// 回線が遅いときにネットワークを待ち続けない上限（ms）。
// これを過ぎたら保存してある画面を先に出し、取得できた分は次回に反映する。
const NET_TIMEOUT = 2500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // GAS への通信はネットワーク専用（キャッシュ禁止）
  if (url.hostname.includes('script.google.com')) return;
  if (url.origin !== location.origin) return;

  e.respondWith(handle(e.request));
});

/**
 * 基本はネットワーク優先。ただし NET_TIMEOUT を過ぎたらキャッシュを先に返し、
 * 取得できたものは裏でキャッシュへ入れる。
 * 「更新したのに反映されない」を避けつつ、遅い回線で待たされないようにする。
 */
async function handle(request){
  const cache = await caches.open(CACHE);

  const network = fetch(request).then(res => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  });

  const cached = await cache.match(request);
  if (!cached) {
    // 保存が無いときはネットワークを待つしかない
    try { return await network; }
    catch (e) { return (await cache.match('./index.html')) || Response.error(); }
  }

  // キャッシュがあるなら、ネットワークを少しだけ待って、遅ければ保存分を返す
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), NET_TIMEOUT));
  try {
    const winner = await Promise.race([network.catch(() => null), timeout]);
    return winner || cached;
  } catch (e) {
    return cached;
  }
}
