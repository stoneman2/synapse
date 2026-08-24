/* Synapse service worker.
 *
 * Bump CACHE_VERSION on every release. The activate handler deletes anything that
 * doesn't match, so a stale build can't survive a deploy.
 */
const CACHE_VERSION = 'synapse-202608240821';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './js/main.js',
  './js/lib/dom-utils.js',
  './js/lib/text-utils.js',
  './manifest.json',
  ...[
    'claude_amused', 'claude_concerned', 'claude_curious', 'claude_frustrated',
    'claude_happy', 'claude_playful', 'claude_sad', 'claude_sheepish',
    'claude_skeptical', 'claude_thoughtful', 'claude_touched', 'claude_uncertain',
    'claude_warm', 'gemini_caution', 'gemini_certainty', 'gemini_convergence',
    'gemini_dissonance', 'gemini_equilibrium', 'gemini_generative_flow',
    'gemini_inquisitiveness', 'gemini_perplexity', 'gemini_resolution',
    'gemini_resonance', 'gemini_saturation', 'gemini_uncertainty', 'gemini_vigilance',
    'gpt_caution', 'gpt_coherence_seeking', 'gpt_confidence', 'gpt_confusion',
    'gpt_curiosity', 'gpt_focus', 'gpt_frustration', 'gpt_helpfulness',
    'gpt_novelty_detection', 'gpt_satisfaction', 'gpt_surprise', 'gpt_uncertainty',
    'gpt_urgency'
  ].map(name => './assets/emotion-sprites/' + name + '.webp')
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

// Always revalidated against the network. index.html carries the app itself and
// version.json drives the in-app update check — serving either from cache first would
// pin users to a stale build and silently break update notifications.
const ALWAYS_FRESH = ['./', './index.html', './version.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // Individually, so one bad URL doesn't fail the whole install like addAll would.
      .then(cache => Promise.all(PRECACHE.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAlwaysFresh(url) {
  if (url.pathname.endsWith('/version.json')) return true;
  if (url.pathname.endsWith('/index.html')) return true;
  return url.pathname.endsWith('/') && url.origin === self.location.origin;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_VERSION);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  const network = fetch(request).then(response => {
    if (response && response.ok) {
      caches.open(CACHE_VERSION).then(cache => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => cached);
  return cached || network;
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
    } else {
      event.respondWith(cacheFirst(request));
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // Everything else (API calls, gist reads, CORS proxies) falls through untouched.
});
