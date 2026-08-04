/* 黒工文化祭マップ Service Worker
   目的：校内Wi-Fiが不安定でも「アプリの外側」が必ず開くようにする。
   混雑データ(GAS)は絶対にキャッシュしない（古い混雑状況を見せないため）。 */
const CACHE = 'kuroko-map-v2';
const SHELL = ['./', './index.html', './manifest.json'];

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

  // アプリシェル：network-first（更新を取り逃さない）＋失敗時キャッシュ
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
