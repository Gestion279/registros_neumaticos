// Service worker: permite instalar la app y abrirla aunque la red falle.
// Los datos (Supabase) nunca se guardan en caché: siempre se piden en vivo.
const VERSION = 'v3';
const CACHE = `neumaticos-${VERSION}`;
const SHELL = [
  '/',
  '/css/styles.css',
  '/js/config.js',
  '/js/app.js',
  '/js/pwa.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Supabase, CDNs y fuentes: directo a la red

  // Páginas: primero la red (así cada deploy se ve al instante), caché si no hay conexión.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone(); // se clona ANTES de devolverla al navegador
          caches.open(CACHE).then((c) => c.put('/', copia));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Archivos estáticos: responde con caché y actualiza en segundo plano.
  e.respondWith(
    caches.match(req).then((cached) => {
      const red = fetch(req).then((res) => {
        if (res.ok) {
          const copia = res.clone(); // se clona ANTES de devolverla al navegador
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      }).catch(() => cached);
      return cached || red;
    })
  );
});
