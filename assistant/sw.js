/* Synapse service worker.
 *
 * Bump CACHE_VERSION on every release.
 */
const CACHE_VERSION = 'synapse-202608251606';

const PRECACHE = [
  './',
  './index.html',
  './styles.css?v=202608251606',
  './js/main.js?v=202608251606',
  './js/lib/dom-utils.js',
  './js/lib/text-utils.js',
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
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('synapse-') && k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAlwaysFresh(url) {
  if (url.pathname.endsWith('/version.json')) return true;
  if (url.pathname.endsWith('/index.html')) return true;
  return url.pathname.endsWith('/') && url.origin === self.location.origin;
}

function isStaticAsset(url) {
  return url.origin === self.location.origin &&
    (STATIC_PATHS.has(url.pathname) || url.pathname.startsWith(SPRITE_PATH));
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      try {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put(request, response.clone());
      } catch (e) {
        console.warn('Synapse cache write failed:', e);
      }
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    try {
      const cache = await caches.open(CACHE_VERSION);
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
    if (isAlwaysFresh(url) || request.mode === 'navigate') {
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
