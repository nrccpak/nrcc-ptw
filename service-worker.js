/* ============================================================
   Service Worker — caches the app shell so the PWA loads offline.
   Bump CACHE_VERSION whenever you change app files, so devices
   pick up the new version on next launch.
   ============================================================ */
const CACHE_VERSION = "ptw-v22";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (e) => {
  // Cache each shell file independently. addAll() rejects the whole batch if any
  // single file 404s — a missing icon would then silently disable offline mode.
  // add().catch() per-file keeps the install (and offline support) resilient.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(APP_SHELL.map((url) =>
      cache.add(url).catch((err) => console.warn("SW: could not cache", url, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache Firestore/Auth API traffic — the SDK handles offline itself.
  if (url.hostname.includes("googleapis.com") ||
      url.hostname.includes("firebaseio.com") ||
      url.hostname.includes("identitytoolkit") ||
      url.hostname.includes("firestore")) {
    return; // let the network/SDK handle it
  }

  // App shell + same-origin: cache-first.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match("./index.html")))
    );
    return;
  }

  // CDN assets (Firebase SDK, fonts): stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
