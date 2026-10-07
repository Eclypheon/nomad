/* ==========================================================================
   Nomad Service Worker — PWA Offline Caching & Installability
   ========================================================================== */

const CACHE_NAME = 'nomad-pwa-v4';
const STATIC_ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'auth.js',
  'pocketbase-config.js',
  'manifest.webmanifest',
  'backends/pocketbase-adapter.js',
  'backends/vendor/pocketbase.umd.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'data/trip.json',
  'data/itinerary.json',
  'data/accommodation.json',
  'data/expenses.json',
  'data/packing.json',
  'data/recommendations.json',
  'data/decisions.json',
  'data/travellers.json'
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Some non-critical assets failed to precache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evt) => {
  const req = evt.request;
  const url = new URL(req.url);

  // Skip non-GET requests and backend API requests from caching
  if (req.method !== 'GET' || url.pathname.includes('/api/')) {
    return;
  }

  // Navigation requests: Network-first, fallback to cached index.html
  if (req.mode === 'navigate') {
    evt.respondWith(
      fetch(req).catch(() => caches.match('./') || caches.match('index.html'))
    );
    return;
  }

  // Stale-While-Revalidate for app assets
  evt.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
