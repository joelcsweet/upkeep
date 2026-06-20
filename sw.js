const CACHE = 'upkeep-v4';
const PRECACHE = [
  '/upkeep/',
  '/upkeep/index.html',
  'https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600;8..60,700&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Let Firebase/Firestore requests go straight to network
  if (e.request.url.includes('firestore') || e.request.url.includes('firebase')) return;
  if (e.request.method !== 'GET') return;

  const isHTML = e.request.mode === 'navigate' || e.request.url.endsWith('/') || e.request.url.endsWith('.html');

  if (isHTML) {
    // Network-first: always try for the latest app code, fall back to cache offline
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('/upkeep/')))
    );
    return;
  }

  // Cache-first for static assets (fonts, icons)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
