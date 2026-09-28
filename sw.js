const CACHE = "smartcup-hq-v15";
const FILES = ["./", "./index.html", "./hq-firebase.js", "./hq-wild.js", "./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.indexOf("smartcup-hq-") === 0 && k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  /* always ask the server first (no-cache skips the browser's 10-minute copy); the cache is only for offline */
  e.respondWith(fetch(e.request.url, {cache:"no-cache", credentials:"same-origin"}).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, {ignoreSearch:true})));
});
