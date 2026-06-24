// GroundLink Service Worker
// index.html: network-first, 5 minute cache max
// Mapbox libraries: cache-first (they never change)
// Firebase + map tiles: always network

// Cache name auto-versions from the ?v=<build> query the page registers us with, so every
// deploy gets a brand-new cache and the activate handler purges all the old ones. This is
// what stops an installed PWA from getting stuck on an old build.
const SW_V = (function(){ try { return new URL(self.location).searchParams.get('v') || '11'; } catch (e) { return '11'; } })();
const CACHE = 'groundlink-' + SW_V;
const NAV_TIMEOUT_MS = 3500; // fall back to the cached page if the network is slower than this
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

const CACHE_FOREVER = [
  'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css',
  'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js'
];

const ALWAYS_NETWORK = [
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com',
  'mapbox.com'  // tiles and API calls — not the library files above
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CACHE_FOREVER)
        // Also precache the home page so there's always an offline fallback.
        .then(() => c.add(new Request('/', { cache: 'reload' })).catch(function(){})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Let the page tell a waiting worker to take over immediately (used by the in-app updater).
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const href = e.request.url;

  // Offline-downloaded map tiles (USGS National Map) — serve from the offline-tiles
  // cache first so a downloaded hunting area works with NO signal; otherwise fall
  // through to the network (un-downloaded areas still load online).
  if (url.hostname.indexOf('basemap.nationalmap.gov') !== -1) {
    e.respondWith(
      caches.open('gl-offline-tiles').then(function(c) {
        return c.match(e.request).then(function(hit) { return hit || fetch(e.request); });
      })
    );
    return;
  }

  // Mapbox libraries — cache forever, they never change
  if (CACHE_FOREVER.includes(href)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // Firebase, map tiles, API — always network, no caching
  if (ALWAYS_NETWORK.some(h => url.hostname.includes(h))) {
    e.respondWith(fetch(e.request));
    return;
  }

  // The app page itself (navigation) — NETWORK-FIRST with no-store so a good connection
  // always loads the latest build, but with a TIMEOUT: if the network is slow or down,
  // fall back to the cached page within a few seconds instead of hanging forever (so the
  // app still opens on poor service; live data fills in once signal returns).
  if (e.request.mode === 'navigate') {
    e.respondWith((async function() {
      var cached = await caches.match('/');
      try {
        var resp = await Promise.race([
          fetch(e.request, { cache: 'no-store' }),
          new Promise(function(_, reject) { setTimeout(function() { reject(new Error('slow-network')); }, NAV_TIMEOUT_MS); })
        ]);
        try { var clone = resp.clone(); caches.open(CACHE).then(function(c) { c.put('/', clone); }).catch(function(){}); } catch (e2) {}
        return resp;
      } catch (err) {
        // Slow or no network — use the cached page if we have one, else a last-ditch fetch.
        return cached || fetch(e.request);
      }
    })());
    return;
  }

  // Other same-origin assets — network-first, 5 min cache fallback
  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Store with a timestamp header so we can check age
        const clone = response.clone();
        caches.open(CACHE).then(c => {
          // Wrap response with a custom header to track cache time
          const headers = new Headers(clone.headers);
          headers.append('sw-cached-at', Date.now().toString());
          clone.blob().then(body => {
            c.put(e.request, new Response(body, {
              status: clone.status,
              statusText: clone.statusText,
              headers
            }));
          });
        });
        return response;
      })
      .catch(async () => {
        // Network failed — serve from cache if not too old
        const cached = await caches.match(e.request);
        if (!cached) return new Response('Offline — no cached version available', { status: 503 });
        const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0');
        if (Date.now() - cachedAt > MAX_AGE_MS) {
          // Cache is stale but we have no network — serve it anyway with a warning
          console.warn('Serving stale cache (>5min) due to no network');
        }
        return cached;
      })
  );
});

// ── Web Push — shows a notification even when the app is closed ──────
// The server (server.js /push) sends these via VAPID to each member's
// subscription. iOS only delivers them to an installed home-screen PWA.
self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (err) { try { data = { title: 'GroundLink', body: e.data.text() }; } catch (e2) {} }

  var isSOS = data.type === 'sos';
  var title = data.title || 'GroundLink';
  var opts = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: (data.type || 'groundlink') + (data.group ? '-' + data.group : ''),
    renotify: true,
    requireInteraction: isSOS,
    vibrate: isSOS ? [200, 100, 200, 100, 200] : [100, 50, 100],
    data: { url: data.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) {
          c.focus();
          if (url && url !== '/' && 'navigate' in c) { try { c.navigate(url); } catch (e2) {} }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
