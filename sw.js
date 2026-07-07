// Service Worker for บทสวดมนต์ PWA
// Version: Update this to force cache refresh
const CACHE_VERSION = 'v1.6.2';
const CACHE_NAME = `chanting-cache-${CACHE_VERSION}`;

// Files to cache — use relative paths so it works on subpath hosting (GitHub Pages)
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './assets/buddha-hero.png',
  'https://fonts.googleapis.com/css2?family=Noto+Serif+Thai:wght@300;400;500;600;700&family=Prompt:wght@300;400;500;600&family=Instrument+Serif:ital@0;1&display=swap'
];

// Install event - cache essential files
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing version ${CACHE_VERSION}`);
  
  // Skip waiting to activate immediately
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching app shell');
        return cache.addAll(urlsToCache);
      })
      .catch((err) => {
        console.error('[SW] Cache failed:', err);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating version ${CACHE_VERSION}`);
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Delete old caches that don't match current version
          if (cacheName !== CACHE_NAME && cacheName.startsWith('chanting-cache-')) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Take control of all pages immediately
      return self.clients.claim();
    })
  );
});

// Fetch event - Network First strategy for HTML, Cache First for assets
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }
  
  // Skip cross-origin requests except fonts
  if (requestUrl.origin !== location.origin && 
      !requestUrl.hostname.includes('fonts.googleapis.com') &&
      !requestUrl.hostname.includes('fonts.gstatic.com')) {
    return;
  }
  
  // For HTML files - Network First (always get fresh content)
  if (event.request.mode === 'navigate' || 
      requestUrl.pathname.endsWith('.html') ||
      requestUrl.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Only cache successful HTML responses. Caching 404/redirect fallback pages
          // can make broken or moved document links appear to open the main page.
          if (response && response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache if offline
          return caches.match(event.request);
        })
    );
    return;
  }
  
  // For other assets - Stale While Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Update cache with fresh response
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Network failed, return nothing (cached response will be used)
        return null;
      });
      
      // Return cached response immediately, update in background
      return cachedResponse || fetchPromise;
    })
  );
});

// Listen for skip waiting message from client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skip waiting requested');
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});

// Notify clients about updates
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_UPDATE') {
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'UPDATE_AVAILABLE',
          version: CACHE_VERSION
        });
      });
    });
  }
});
