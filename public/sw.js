// GroundLink Service Worker
// Caches the shell so the app loads instantly even on flaky signal.
// Does NOT cache map tiles or Firebase — those always come live.

const CACHE = 'groundlink-v1';
const SHELL = [
  '/',
  '/index.html',
  'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css',
  'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go network-first for Firebase, Mapbox tiles, and API calls
  const isLive =
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('mapbox.com') ||
    url.pathname.startsWith('/v4/') ||
    url.pathname.startsWith('/events/');

  if (isLive) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for shell assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
