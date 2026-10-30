/* Service worker de codex-web-v4.
 *
 * Criterio: la red siempre manda. La cache existe solo para que la aplicacion
 * abra sin conexion, nunca para servir una version vieja cuando hay red.
 * Las respuestas de /api/ no se cachean jamas: son estado vivo.
 */
const CACHE = 'v4-shell-v23';
const SHELL = ['/', '/style.css', '/app.js', '/robot.js', '/faces.js', '/voz.js', '/manifest.webmanifest',
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

/* ------------------------------------------------------- notificaciones ---
 * Esto corre aunque la aplicacion este cerrada y el telefono bloqueado: el
 * service worker lo despierta el servicio de push del navegador.
 */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }

  const opciones = {
    body: d.cuerpo || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    // Reemplaza el aviso anterior del mismo especialista en vez de apilar
    // uno por turno, que con trece especialistas seria inmanejable.
    tag: d.etiqueta || 'v4',
    renotify: true,
    vibrate: d.urgente ? [120, 60, 120, 60, 120] : [80, 40, 80],
    data: { agente: d.agente || null },
    actions: d.agente ? [{ action: 'abrir', title: 'Ver respuesta' }] : []
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(d.titulo || 'codex-web-v4', opciones);
    // El contador del icono: cuantos especialistas tienen algo sin revisar.
    if (typeof d.insignia === 'number' && 'setAppBadge' in navigator) {
      try {
        if (d.insignia > 0) await navigator.setAppBadge(d.insignia);
        else await navigator.clearAppBadge();
      } catch { /* el sistema puede no admitirlo */ }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const agente = event.notification.data && event.notification.data.agente;
  const destino = agente ? `/?agente=${encodeURIComponent(agente)}` : '/';

  // Si ya hay una ventana abierta se reutiliza, en vez de abrir otra encima.
  event.waitUntil((async () => {
    const clientes = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientes) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if (agente) c.postMessage({ tipo: 'abrir-agente', agente });
        return;
      }
    }
    await self.clients.openWindow(destino);
  })());
});
