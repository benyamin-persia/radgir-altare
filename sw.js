/**
 * Basic service worker for offline caching.
 */

const CACHE_VERSION = 'radgir-static-v57-approx-noaddr';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles.css',
  '/pwa.js',
  '/script.js',
  '/analytics.js',
  '/auth.js',
  '/navigation.js',
  '/theme.js',
  '/i18n.js',
  '/translations.js',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/map-listings.js',
  '/views.js',
  '/router.js',
  '/login.html',
  '/register.html',
  '/dashboard.html',
  '/about-contact.html',
  '/create-person.html',
  '/create-person.js',
  '/listing-editor.html',
  '/listing-editor.js',
  '/almighty-portal.html',
  '/almighty-portal.js',
  '/forgot-password.html',
  '/reset-password.html',
  '/verify-email.html',
  '/await-verification.html'
];

self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Install event fired - Pre-caching static assets');
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activate event fired');
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
  console.log('[ServiceWorker] Activation complete - Claiming clients');
});

/** Network-first for HTML shells; never reject the FetchEvent (avoids console TypeError). */
async function networkFirstHtml(request) {
  try {
    const response = await fetch(request);
    const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
    const shouldSkipCache = cacheControl.includes('no-store');
    if (response.ok && !shouldSkipCache) {
      const cache = await caches.open(CACHE_VERSION);
      // Cache under pathname key so /?person=... still hit / offline
      const url = new URL(request.url);
      const cacheKey = url.pathname === '/' ? '/' : request;
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (_) {
    const cached = (await caches.match(request))
      || (await caches.match('/'))
      || (await caches.match('/index.html'));
    if (cached) return cached;
    return new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/** Network-first for JS/CSS with offline cache fallback. */
async function networkFirstAsset(request) {
  try {
    const response = await fetch(request);
    const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
    const shouldSkipCache = cacheControl.includes('no-store');
    if (response.ok && !shouldSkipCache) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

/** Cache-first for secondary assets; always catch network failures. */
async function cacheFirstSafe(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (!isSameOrigin || url.pathname.startsWith('/api/')) {
    return; // Let the browser handle API + cross-origin (don't intercept)
  }

  const isCoreAsset = /\.(html|js|css)$/i.test(url.pathname);
  // Deep links like /?person=ID sometimes arrive without mode=navigate — still treat as HTML shell
  const isAppShell = url.pathname === '/' || url.pathname === '/index.html'
    || request.mode === 'navigate'
    || request.destination === 'document';

  if (isAppShell) {
    event.respondWith(networkFirstHtml(request));
    return;
  }

  if (isCoreAsset) {
    event.respondWith(networkFirstAsset(request));
    return;
  }

  event.respondWith(cacheFirstSafe(request));
});
