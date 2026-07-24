// PWA用の最小Service Worker（アプリシェルをキャッシュしてインストール可能にする）
const CACHE = 'attendance-v1';
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
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
