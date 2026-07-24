// PWA用の最小Service Worker（アプリシェルをキャッシュしてインストール可能にする）
const CACHE = 'attendance-v7';
const ASSETS = [
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // GASなど外部への通信はキャッシュせず素通し
  if (url.origin !== self.location.origin) return;

  // ネットワーク優先（取れたら最新をキャッシュに保存）。
  // 修正版をアップロードしたとき、古い画面が残り続けるのを防ぐため。
  // 圏外・オフライン時のみキャッシュを使う。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
