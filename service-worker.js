/* ============================================================
   Service Worker — caches the app shell so the PWA loads offline.
   The app shell is served stale-while-revalidate: the cached copy
   loads instantly (and works offline) while a fresh copy is fetched
   in the background, so a new deploy is picked up automatically on
   the next launch — no manual CACHE_VERSION bump required. When the
   main code (app.js) changes, clients are messaged so they can offer
   an immediate reload. (CACHE_VERSION is still bumped occasionally to
   purge the cache namespace.)
   ============================================================ */
const CACHE_VERSION = "ptw-v25";
// Full URL of the main app code — a change here triggers the update prompt.
const CORE_URL = new URL("./app.js", self.location).href;
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

  // App shell + same-origin: stale-while-revalidate. Serve the cached copy
  // immediately (fast + offline), refresh it from the network in the background,
  // and — when the main code changes — tell open clients so they can reload.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const network = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          if (req.url === CORE_URL && hit) {
            const oldTag = hit.headers.get("etag"), newTag = res.headers.get("etag");
            if (oldTag && newTag && oldTag !== newTag) {
              self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ type: "UPDATE_READY" })));
            }
          }
          return res;
        }).catch(() => hit || caches.match("./index.html"));
        return hit || network;
      })
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
