/* Synapse service worker.
 *
 * Generated release stamps are kept in sync by build.py.
 */
const CACHE_VERSION = 'synapse-20261111071320';

const PRECACHE = [
  './',
  './index.html',
  './styles.css?v=20261111071320',
  './js/main.js?v=20261111071320',
  './js/lib/dom-utils.js?v=20261111071320',
  './js/lib/text-utils.js?v=20261111071320',
  './manifest.json'
];

// Third-party assets the app needs to render properly. Without these cached, offline
// mode loses syntax highlighting, math, diagrams, and the webfont. All four hosts send
// CORS headers, so these are normal (non-opaque) cacheable responses.
const CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

const STATIC_PATHS = new Set(PRECACHE.map(path => new URL(path, self.location).pathname));
const SPRITE_PATH = new URL('./assets/emotion-sprites/', self.location).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE.map(path => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => /^synapse-\d+$/.test(k) && k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAlwaysFresh(url) {
  if (url.pathname.endsWith('/index.html')) return true;
  return url.pathname.endsWith('/') && url.origin === self.location.origin;
}

function isStaticAsset(url) {
  return url.origin === self.location.origin &&
    (STATIC_PATHS.has(url.pathname) || url.pathname.startsWith(SPRITE_PATH));
}

function appFileResponse(response) {
  // The browser can separately memory-cache imported modules after the worker
  // returns them. Do not forward a host's immutable/max-age policy for app code.
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  // fetch() exposes a decoded body, not the host's compressed wire bytes.
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    // Bypass the HTTP cache too: a network request can otherwise return an old
    // app file for months when a host sends a long max-age.
    const response = await fetch(request, { cache: 'no-store' });
    if (response.status >= 500) {
      const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return appFileResponse(cached);
    }
    if (response && response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch (e) {
        console.warn('Synapse cache write failed:', e);
      }
    }
    return appFileResponse(response);
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return appFileResponse(cached);
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    try {
      await cache.put(request, response.clone());
    } catch (e) {
      console.warn('Synapse cache write failed:', e);
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Never touch anything but plain GETs. The app POSTs to whatever LLM endpoint the
  // user configured, and those must reach the network untouched and uncached.
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    // Version checks must fail honestly offline, not report cached metadata.
    if (url.pathname.endsWith('/version.json')) {
      event.respondWith(fetch(request, { cache: 'no-store' }));
    } else if (isAlwaysFresh(url) || request.mode === 'navigate' || (isStaticAsset(url) && !url.pathname.startsWith(SPRITE_PATH))) {
      event.respondWith(networkFirst(request));
    } else if (isStaticAsset(url)) {
      event.respondWith(cacheFirst(request));
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
  // Everything else (API calls, gist reads, CORS proxies) falls through untouched.
});
