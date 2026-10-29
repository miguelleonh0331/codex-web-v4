/* Service worker de codex-web-v4.
 *
 * Criterio: la red siempre manda. La cache existe solo para que la aplicacion
 * abra sin conexion, nunca para servir una version vieja cuando hay red.
 * Las respuestas de /api/ no se cachean jamas: son estado vivo.
 */
const CACHE = 'v4-shell-v6';
const SHELL = ['/', '/style.css', '/app.js', '/robot.js', '/faces.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/maskable-192.png', '/icons/maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => { /* si algo falla, seguimos */ }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // El estado de los agentes nunca se sirve desde cache.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res && res.ok) {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copia)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cacheada = await caches.match(request, { ignoreSearch: true });
      if (cacheada) return cacheada;
      if (request.mode === 'navigate') {
        const inicio = await caches.match('/', { ignoreSearch: true });
        if (inicio) return inicio;
      }
      throw err;
    }
  })());
});
