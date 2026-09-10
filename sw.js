/* Punkto – Service Worker (App-Button: installierbar + offline-fähig)
   Marker: pk-appbtn-sw-1
   WICHTIG: Bei JEDEM Deploy, der HTML/JS/CSS/Icons ändert, CACHE-Version erhöhen
   (sonst liefert der Offline-Cache alte Inhalte aus -> neuer Inline-Code greift nicht).
   NICHT vorgecacht wird betreiber.html (bewusst network-first, kein Shell-Asset).

   Grundsätze (bewusst konservativ, damit Login/Datenabruf NIE leiden):
   - Nur GET wird behandelt; POST (Edge Functions an Supabase) bleibt komplett unangetastet.
   - Fremde Herkunft (Supabase, Open Food Facts) wird NIE abgefangen -> geht immer ins Netz.
   - Dokumente (HTML): Netz zuerst -> live bleibt frisch; offline Rückfall auf den Cache.
   - Statische Assets (CSS/JS/Icons/Manifest): Cache zuerst -> schnell; sonst Netz + nachlegen. */

const CACHE = "pk-app-v15";   // <-- bei jedem Asset-/Code-Deploy die Zahl erhöhen (v2, v3, ...)
const SHELL = [
  "./anmelden.html",
  "./app.html",
  "./konto.html",
  "./manifest.webmanifest",
  "./assets/punkto.css",
  "./assets/pk-app.js",
  "./assets/pk-engine.js",
  "./assets/pk-store.js",
  "./assets/pk-ocr.js",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon.svg"
];
/* Hinweis: Die schweren OCR-Ressourcen unter ./assets/ocr/ (Tesseract-WASM +
   traineddata, ~10 MB) werden BEWUSST nicht vorgecacht. Sie landen beim ersten
   (Online-)Gebrauch über den Cache-first-Zweig unten automatisch im Cache und
   sind danach offline verfügbar. */

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // best effort: ein einzelner Fehlschlag (z. B. 404) darf die Installation nicht kippen
      Promise.allSettled(SHELL.map((u) => cache.add(u)))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                 // Datenabruf/Metering (POST) unangetastet lassen

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;  // Supabase & externe Ziele -> direkt ins Netz

  const accept = req.headers.get("accept") || "";
  const isDoc = req.mode === "navigate" || accept.includes("text/html");

  if (isDoc) {
    // Netz zuerst; bei Erfolg Kopie in den Cache; offline -> Cache (Query ignorieren) -> Shell
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then((m) => m || caches.match("./anmelden.html"))
        )
    );
    return;
  }

  // Statische Assets: Cache zuerst, sonst Netz und nachlegen
  event.respondWith(
    caches.match(req).then((m) => {
      if (m) return m;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
