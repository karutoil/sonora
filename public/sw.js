// sonora service worker — an installable shell that is never a stale app.
//
// The rule this file exists to protect: network-first for anything that carries
// behaviour (navigations, JS, CSS). A cache-first shell once shipped a cached
// app.js that called an endpoint the server had already removed — the app
// looked deployed but ran last week's logic. So when the network answers, the
// network wins; the cache is only a lifeboat for the offline case.
//
// The other rule: never touch data. /api/ (likes, playlists, now-playing),
// /stream/ and /audio/ are personal or ranged media; a service worker in the
// middle of a range request breaks seeking, and a cached /api/likes would show
// one account's library to the next person on the device.
//
// Bump VERSION whenever the shell list or strategy changes. The browser
// byte-compares this file, so editing it is what triggers an update.
const VERSION = 'v7';
const SHELL_CACHE = `sonora-shell-${VERSION}`;
const RUNTIME_CACHE = `sonora-runtime-${VERSION}`;
// Fonts and artwork are the only things that accumulate. 60 entries is a few
// MB at most and keeps the origin's storage quota in no danger.
const RUNTIME_MAX = 60;

// Everything needed to paint the app from cold: the document, its styles and
// modules, the install metadata and the icon set. Pre-cached at install so the
// first offline load does not depend on what happened to be visited before.
const PRECACHE = [
  '/',
  '/offline.html',
  '/app.css',
  '/rooms.css',
  '/fonts.css',
  '/pwa.css',
  '/app.js',
  '/rooms.js',
  '/media-session.js',
  '/playback.js',
  '/pwa.js',
  '/notifications.js',
  '/notifications.css',
  '/manifest.webmanifest',
  '/fonts/inter-latin.woff2',
  '/icons/icon.svg',
  '/icons/icon-96.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon-512-transparent.png',
];

// Requests that must reach the server untouched.
const NEVER_INTERCEPT = [/^\/api\//, /^\/stream\//, /^\/audio\//];

// Fonts and artwork: static, versioned by URL, and a stale copy is never
// wrong for long. Everything else is network-first.
const STALE_WHILE_REVALIDATE = new Set(['font', 'image']);

const offlineResponse = () =>
  new Response('Offline', {
    status: 503,
    statusText: 'Offline',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

// ── install ────────────────────────────────────────────────────────────────
// No skipWaiting() here on purpose. A new worker waits until the page says so,
// so a deploy can never swap the app out from under a playing track; pwa.js
// offers a "Refresh" pill and posts SKIP_WAITING when it is tapped.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const results = await Promise.all(PRECACHE.map(async (url) => {
      try {
        // cache:'reload' bypasses the HTTP cache so an install never bakes in
        // a revalidated-but-stale copy of the shell.
        await cache.add(new Request(url, { cache: 'reload' }));
        return true;
      } catch {
        return false;
      }
    }));
    // A partially cached shell is a half-drawn app offline. Refuse to install
    // rather than ship that, but tolerate a missing decorative asset.
    const CORE = ['/', '/app.js', '/app.css'];
    const missing = CORE.filter((url) => !results[PRECACHE.indexOf(url)]);
    if (missing.length) throw new Error(`sonora: precache failed for ${missing.join(', ')}`);
  })());
});

// ── activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key)),
    );
    // Navigation preload fetches the document in parallel with the worker
    // boot, which is the difference between an instant shell and a double RTT
    // on a phone behind a tunnel. It only applies to navigations.
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── notification clicks ────────────────────────────────────────────────────
// A release alert is only useful if tapping it lands on the release. The
// notification carries `data.url` as an in-app route ('#/c/aMPR…'), which is a
// fragment: openWindow('#/c/aMPR…') would open a *blank* page with no app in
// it. So the route is resolved against the worker's own scope and the result
// is a real document URL. An already-open sonora window is preferred over a
// new tab — the app is a player, not a document — and it moves its own router
// when told which route was tapped.
//
// There is deliberately no `push` listener: sonora has no push service (that
// would need VAPID keys and a subscription store), so the server sweeps the
// followed artists on a timer and the page asks for the feed. An OS
// notification is shown by the page through `registration.showNotification`,
// which is why this handler only has to deal with the click.
self.addEventListener('notificationclick', (event) => {
  const data = event.notification?.data ?? {};
  const route = typeof data.url === 'string' ? data.url.trim() : '';
  event.notification?.close();

  let target;
  try {
    // Absolute URLs (never produced by our own server) are honoured; a bare
    // '#/artist/UC…' resolves to '<origin>/#/artist/UC…'.
    target = new URL(route || '/', self.registration.scope).href;
  } catch {
    target = self.registration.scope;
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      let sameOrigin = false;
      try { sameOrigin = new URL(client.url).origin === new URL(target).origin; } catch {}
      if (!sameOrigin) continue;
      await client.focus().catch(() => {});
      // The page applies the fragment itself; a client cannot be navigated to a
      // hash route from here without reloading the whole app.
      client.postMessage({ type: 'sonora:open-url', url: route || '/' });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// ── strategies ─────────────────────────────────────────────────────────────

/** Network first; the cached copy is only for when the network genuinely fails. */
async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch {
    const hit = await caches.match(request, { ignoreSearch: true });
    return hit || offlineResponse();
  }
}

/** Serve what we have, refresh in the background, keep the runtime cache small. */
function staleWhileRevalidate(event) {
  const { request } = event;
  const update = fetch(request).then(async (response) => {
    if (response.ok && response.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - RUNTIME_MAX; i++) await cache.delete(keys[i]);
    }
    return response;
  });
  // Keep the worker alive for the revalidation even when the cached copy wins.
  event.waitUntil(update.catch(() => {}));

  return (async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    return (await update.catch(() => null)) || offlineResponse();
  })();
}

/** A navigation: preload/network, else the precached shell, else /offline.html. */
async function navigationResponse(event) {
  try {
    const response = (await event.preloadResponse) || (await fetch(event.request));
    if (response) return response;
  } catch {
    // fall through to the shell
  }
  const shell = await caches.match('/', { cacheName: SHELL_CACHE });
  if (shell) return shell;
  const offline = await caches.match('/offline.html', { cacheName: SHELL_CACHE });
  if (offline) return offline;
  return offlineResponse();
}

// ── routing ────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Non-GET is never cached and never intercepted (range requests, likes,
  // playlist writes). Same for anything off-origin.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_INTERCEPT.some((pattern) => pattern.test(url.pathname))) return;

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(navigationResponse(event));
    return;
  }

  if (STALE_WHILE_REVALIDATE.has(request.destination)) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }

  // Scripts, styles, the manifest and anything unknown: never stale. The
  // cache may only answer when the fetch above genuinely fails.
  event.respondWith(networkFirst(request));
});
