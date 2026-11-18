// Bookshelf service worker: keeps the app shell available so the installed app opens even
// when the local server is stopped (books live in IndexedDB; narration needs the server).
const VERSION = "bookshelf-v1";
const SHELL = [
  "/", "/manifest.webmanifest", "/styles/app.css",
  "/js/ui-controller.js", "/js/reader-view.js", "/js/library-view.js", "/js/tts-engine.js",
  "/js/book-parser.js", "/js/storage.js", "/js/text-utils.js",
  "/vendor/jszip.min.js", "/vendor/pdfjs/pdf.min.mjs", "/vendor/pdfjs/pdf.worker.min.mjs",
  "/assets/icon.svg", "/assets/icons/icon-192.png", "/assets/icons/icon-512.png",
  "/assets/fonts/eb-garamond-latin-400-normal.woff2", "/assets/fonts/literata-latin-400-normal.woff2",
  "/assets/fonts/inter-latin-400-normal.woff2",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Live data is never cached: speech, the Books folder, health checks, the sample book.
  if (/^\/(api|books|samples)\//.test(url.pathname)) return;
  // Network first (so updates show up immediately), cache as the offline fallback.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        caches.open(VERSION).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    } catch {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === "navigate") return caches.match("/");
      return Response.error();
    }
  })());
});
