// Service Worker para PWA — Plan Cloud
// Estrategia: cache-first para assets estáticos, network-first para datos de Supabase.

const CACHE_NAME = 'plan-cloud-v14';
const STATIC_ASSETS = [
  './index.html',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Install: precachear los assets estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: limpiar caches viejas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: estrategia híbrida
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Llamadas a Supabase (datos dinámicos): network-only, fallback cero
  if (url.hostname.endsWith('supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Resto: cache-first, fallback a network, fallback a cache stale
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Solo cachear GETs exitosos
        if (event.request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('./plan-cloud.html'));
    })
  );
});
