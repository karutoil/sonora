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
// Bump VERSION whenever the shell list or strategy changes: it is what names
// the caches, even though the browser only byte-compares this file.
//
// Which is why VERSION is *not* the identity of a build. It is
// hand-maintained: changing a strategy, a comment or a URL without bumping it
// still produces a genuinely new worker (the browser compares bytes) and the
// same `sonora-shell-vNN` cache name. pwa.js remembers a "not now" against the
// build a worker reports, so the worker reports one — a hash of its own bytes,
// which changes exactly when the browser decides this is a new build (see
// buildId()).
const VERSION = 'v28';
const SHELL_CACHE = `sonora-shell-${VERSION}`;
const RUNTIME_CACHE = `sonora-runtime-${VERSION}`;
// Install precaches into this cache; activate promotes it into SHELL_CACHE.
// Nothing writes to the live shell cache while installing: see the install
// handler for the deploy that made that non-negotiable.
const STAGING_CACHE = `${SHELL_CACHE}-next`;
// Every cache this worker owns is named `sonora-<kind>-v<N>` (staging adds
// `-next`). The number is read back out so activate can tell a *previous*
// version's cache — garbage once this worker holds a complete shell — from a
// *newer* one, which is not this worker's to remove: a rollback of this file (an
// older sw.js activating) used to delete every cache that was not its own,
// including the newer worker's complete shell. A name that does not parse is
// never deleted; it may not be ours at all.
const OWN_CACHE = /^sonora-(?:shell|runtime)-v(\d+)(?:-next)?$/;
const versionOf = (name) => {
  const match = OWN_CACHE.exec(name);
  return match ? Number(match[1]) : null;
};
const THIS_VERSION = versionOf(SHELL_CACHE);
// Fonts and icons are the only same-origin responses that reach the runtime
// cache (see STALE_WHILE_REVALIDATE). 60 entries is a few MB at most and keeps
// the origin's storage quota in no danger.
const RUNTIME_MAX = 60;
// A runtime copy of an image or a font is a convenience, not a source of truth.
// Past this age the network copy wins whenever there is one — an icon swapped
// server-side used to be shadowed by the first copy this cache ever wrote, and
// the 60-entry cap could take weeks to evict it. The origin's own `Date` header
// is the clock: no per-entry bookkeeping of ours to lose.
const RUNTIME_FRESH_MS = 24 * 60 * 60 * 1000;

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
  '/audio-session.js',
  '/playback.js',
  '/queue-stream.js',
  '/pwa.js',
  '/notifications.js',
  '/notifications.css',
  // The guest pages under /l/ are server-rendered documents and are deliberately
  // not precached (they name a code that only the server can resolve), but the
  // scripts they load are: without them an offline /l/<code> paints its play
  // button and the tap does nothing, because the module resolves to no cache.
  // Best-effort like notifications.* — a missing listen.js must never fail the
  // install of the app itself, which is why neither is in REQUIRED_SHELL.
  '/listen.js',
  '/listen-venue.js',
  '/manifest.webmanifest',
  // latin-ext is declared by fonts.css with its own unicode-range, so any
  // title containing e.g. Motley Crüe or Polish/Czech characters pulls this
  // file; without it here the glyph would silently fall back offline and the
  // worker would answer the request with a 503.
  '/fonts/inter-latin.woff2',
  '/fonts/inter-latin-ext.woff2',
  '/icons/icon.svg',
  '/icons/icon-96.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

// The four launcher-shortcut tiles from manifest.webmanifest.
//
// Fetched at install like the rest of the shell, but deliberately *not* in
// PRECACHE and not in REQUIRED_SHELL: a shortcut's icon is drawn by the OS, and
// the only thing a missing one costs is a blank tile in the launcher menu of a
// phone that is offline the first time it opens it. A required entry, by
// contrast, refuses the whole install when it 404s after a rename — a cosmetic
// bitmap must not be able to do that (the same reasoning as notifications.* and
// listen.js). One list, one best-effort pass, each URL on its own.
const PRECACHE_OPTIONAL = [
  '/icons/shortcuts/wave.png',
  '/icons/shortcuts/search.png',
  '/icons/shortcuts/heart.png',
  '/icons/shortcuts/radio.png',
];

// The boot set. Anything here missing from the shell means the app cannot
// start offline: index.html paints, then the module graph (or a stylesheet)
// fails to resolve and nothing else happens — no nav, no player, no offline
// page. Install must refuse that rather than ship a half-cached shell.
//
// The same set is re-checked at activate *and* on every offline navigation,
// because a shell that was complete at install can lose entries later — Cache
// Storage is evicted piecemeal under storage pressure, routinely on iOS — and
// the honest answer then is the branded /offline.html, not a blank app.
//
// app.js statically imports rooms.js, media-session.js, audio-session.js,
// playback.js and queue-stream.js; pwa.js is the update/offline chrome. Fonts,
// icons and notifications.* may be absent without making the app unusable, so
// they stay best-effort — notifications.css included: the document only *links*
// it, so losing it costs styles, while a required entry turned one iOS eviction
// of a cosmetic stylesheet into /offline.html for every navigation. It stays in
// PRECACHE: fetched at install, just not fatal when it later goes missing.
const REQUIRED_SHELL = [
  '/',
  '/offline.html',
  '/app.css',
  '/rooms.css',
  '/fonts.css',
  '/pwa.css',
  '/app.js',
  '/rooms.js',
  '/media-session.js',
  '/audio-session.js',
  '/playback.js',
  '/queue-stream.js',
  '/pwa.js',
];

// Requests that must reach the server untouched. `/api/` covers every data and
// media route the app actually has (/api/stream/<id> included); `/stream/` and
// `/audio/` are kept as a guard for direct media paths so a future route can
// never be swallowed by a cache.
const NEVER_INTERCEPT = [/^\/api\//, /^\/stream\//, /^\/audio\//];

// Fonts and icons: static, versioned by URL, and a stale copy is never wrong
// for long. Everything else is network-first.
const STALE_WHILE_REVALIDATE = new Set(['font', 'image']);

// Cache Storage is not obliged to honour `cache-control` — a response the server
// marked `no-store` lands on disk anyway — so the one directive that means "this
// is not yours to keep" is checked by hand before anything is written: the
// stale-while-revalidate write below and the shell document refresh. The one
// exemption is install's `cache.add` of PRECACHE, whose URLs are this app's own
// fixed shell files and are never gated on anything.
const NO_STORE = /no-store/i;

/** When the origin produced a response, by its own `Date` header. */
const servedAt = (response) => {
  const date = Date.parse(response?.headers.get('date') || '');
  return Number.isFinite(date) ? date : 0;
};

const offlineResponse = () =>
  new Response('Offline', {
    status: 503,
    statusText: 'Offline',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

/** A gateway/origin failure is not an answer the app can use. */
const failedServer = (response) => !response || response.status >= 500;

const shellMatch = (request) => caches.match(request, { cacheName: SHELL_CACHE });

const requiredComplete = async () => {
  const cache = await caches.open(SHELL_CACHE);
  const keys = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
  return REQUIRED_SHELL.every((url) => keys.has(url));
};

/**
 * The build this worker is, as a short hash of its own bytes.
 *
 * The browser's identity for a worker is the bytes of sw.js, so a hash of those
 * bytes is the only build identity that cannot drift from it: a comment, a URL
 * or a strategy change that skipped the VERSION bump still changes it, which
 * used to make pwa.js treat a genuinely new build as "the one I already
 * declined". One same-origin GET per worker lifetime (memoised).
 *
 * It never rejects: 'unknown' is the honest answer when the script cannot be
 * fetched, and because it is still a plain string pwa.js can remember a
 * decline against it instead of nagging on every cold launch. That includes a
 * fetch that *stalls*: with no deadline a half-open connection (a tunnel that
 * accepted the socket and stopped talking) held install open forever, and a
 * worker that never installs is a PWA that never updates.
 */
let buildPromise = null;
function buildId() {
  buildPromise ??= (async () => {
    try {
      const response = await fetch(self.location.href, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return 'unknown';
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      return [...new Uint8Array(digest).slice(0, 8)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return 'unknown';
    }
  })();
  return buildPromise;
}

// What a document needs before it can boot: its stylesheets and its module
// scripts. Only the document's own references are checked — the modules' static
// imports are pinned by REQUIRED_SHELL, and a stale app.js still imports exactly
// what it always did, which is what keeps the old modules in the cache a
// consistent set.
const DOCUMENT_ASSET_PATTERNS = [
  /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi,
  /<script[^>]+type=["']module["'][^>]*src=["']([^"']+)["']/gi,
];

const documentAssets = (html) => {
  const found = new Set();
  for (const pattern of DOCUMENT_ASSET_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      try {
        const url = new URL(match[1], self.registration.scope);
        if (url.origin === self.location.origin) found.add(url.pathname);
      } catch { /* a malformed href is the document's problem, not the shell's */ }
    }
  }
  return [...found];
};

// The document is re-read at most this often: a navigation is the only moment
// it can be noticed to have changed, and re-fetching it on every tap would be
// paying for the same answer twice.
const SHELL_REFRESH_MS = 10 * 60 * 1000;
let lastShellRefresh = 0;

/**
 * Replace the cached `/` with the document the origin just served.
 *
 * The shell used to be a frozen install-time snapshot: nothing but a byte change
 * in this file (and therefore a whole new install) ever refreshed it, so a user
 * who is mostly offline could run last month's index.html indefinitely — and an
 * index.html that names a stylesheet or module the cache does not have is the
 * difference between a booting shell and a white page once the cache is all
 * there is.
 *
 * Two cheap guards keep this from ever making the cache worse. Never refresh a
 * shell whose boot set is already incomplete, and never cache a document whose
 * own stylesheet/script URLs are not all in the shell: index.html v2 in front of
 * app.js v1 is the one mixture that cannot boot offline.
 */
async function refreshShellDocument(response) {
  const now = Date.now();
  if (now - lastShellRefresh < SHELL_REFRESH_MS) return;
  lastShellRefresh = now;
  try {
    // The document is the largest thing the shell holds and the one a `no-store`
    // answer ("this page is not yours to keep") must never replace: without this
    // check the guard comment above was true of one writer out of two.
    if (NO_STORE.test(response.headers.get('cache-control') || '')) return;
    const copy = response.clone();
    const html = await response.text();
    const cache = await caches.open(SHELL_CACHE);
    const have = new Set((await cache.keys()).map((key) => new URL(key.url).pathname));
    if (!REQUIRED_SHELL.every((url) => have.has(url))) return;
    if (documentAssets(html).some((path) => !have.has(path))) return;
    await cache.put('/', copy);
  } catch {
    // A refresh is an optimisation; it must never fail a navigation.
  }
}

// ── install ────────────────────────────────────────────────────────────────
// No skipWaiting() here on purpose. A new worker waits until the page says so,
// so a deploy can never swap the app out from under a playing track; pwa.js
// offers a "Refresh" pill and posts SKIP_WAITING when it is tapped.
//
// Precache into STAGING_CACHE, never into SHELL_CACHE. A deploy that edits this
// file without bumping VERSION installs against the very cache the *live*
// worker is serving from, one URL at a time — so a single failed fetch (a 502
// mid-deploy, a tunnel that drops) used to delete that cache entire, including
// `/` and `/offline.html`, and leave the running worker with no shell. Online
// nothing looked wrong, because everything is network-first; the damage only
// showed the next time the phone was offline, as a white page reading "Offline",
// until some later install happened to succeed. Staging keeps the live shell
// byte-identical until activate promotes a complete one over it.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STAGING_CACHE);
    // Keyed by URL, not by PRECACHE position. `results[PRECACHE.indexOf(url)]`
    // answered `results[-1]` — undefined, therefore "missing" — for anything in
    // REQUIRED_SHELL but not in PRECACHE, so following the comment above and
    // tightening REQUIRED_SHELL made *every* install fail: no worker, no
    // beforeinstallprompt, no install offer, silently.
    const results = new Map(await Promise.all(PRECACHE.map(async (url) => {
      try {
        // cache:'reload' bypasses the HTTP cache so an install never bakes in
        // a revalidated-but-stale copy of the shell.
        await cache.add(new Request(url, { cache: 'reload' }));
        return [url, true];
      } catch {
        return [url, false];
      }
    })));
    const missing = REQUIRED_SHELL.filter((url) => !results.get(url));
    if (missing.length) {
      // Drop the staging cache only: it is this install's own garbage. The live
      // shell belongs to the worker that is still answering from it, and a
      // failed install has no right to touch it.
      await caches.delete(STAGING_CACHE).catch(() => {});
      throw new Error(`sonora: precache failed for ${missing.join(', ')}`);
    }
    // Learn the build id now, while the network is warm and an install is
    // allowed to take a moment: it is the identity pwa.js shows a prompt for.
    await buildId();
    // Optional extras, and after the check above: a slow or missing icon can
    // neither fail this install nor delay the answer to "is the boot set here".
    await Promise.all(PRECACHE_OPTIONAL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch {
        // A blank tile in an offline launcher menu, nothing more.
      }
    }));
  })());
});

/**
 * Move the install's staging cache into the live shell name, and report whether
 * this worker now owns a complete shell.
 *
 * Cache Storage has no rename, so this copies. Entries the new build has are
 * written over the old ones first and only then are entries it dropped removed,
 * so the cache is never momentarily empty; and running it from activate means it
 * only ever happens when this worker is the one that will answer requests.
 *
 * A single refused write is not allowed to abandon the rest. It used to: one
 * `live.put` that threw (quota, a `Vary: *` key, a body already read) skipped
 * every entry after it *and* the stale sweep, leaving the live shell a mixture
 * of two builds — which `requiredComplete()` happily called complete, because
 * every boot path was present, just not from the same build. So each key is
 * promoted on its own, failures are counted, and a shell that is only partly
 * this build drops its document entry: an offline navigation then takes the
 * honest /offline.html path instead of painting a mixture that cannot boot.
 */
async function promoteStagedShell() {
  const staged = await caches.open(STAGING_CACHE);
  const stagedKeys = await staged.keys();
  if (stagedKeys.length) {
    const live = await caches.open(SHELL_CACHE);
    const keep = new Set(stagedKeys.map((key) => key.url));
    const failed = [];
    for (const key of stagedKeys) {
      try {
        const response = await staged.match(key);
        if (response) await live.put(key, response);
        else failed.push(key.url);
      } catch {
        failed.push(key.url);
      }
    }
    for (const key of await live.keys()) {
      if (!keep.has(key.url)) await live.delete(key).catch(() => {});
    }
    await caches.delete(STAGING_CACHE).catch(() => {});
    if (failed.length) {
      await live.delete('/').catch(() => {});
      console.warn(`sonora: shell promote failed for ${failed.join(', ')}`);
    }
  }
  // The answer the caller needs is "is there a shell here", not "did anything
  // throw" — that is what decides whether an older cache may be deleted.
  return requiredComplete();
}

// ── activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Promote before the cleanup below, which would otherwise delete the staging
    // cache as an unknown one. If promotion did not leave a complete shell the
    // sweep is skipped: this worker cannot serve from the previous version's
    // cache (different name), but a rollback of sw.js can, and a stale shell is
    // recoverable where no shell is not.
    const promoted = await promoteStagedShell().catch(() => false);
    if (promoted) {
      // Only caches this worker can prove are *older* than itself. Deleting
      // everything not named shell/runtime meant a rollback (an older sw.js
      // activating over a newer one) wiped the newer shell, the newer runtime
      // cache and its staging mid-install, leaving the newer worker — still the
      // one the browser will hand requests to next launch — with nothing.
      // A cache whose name does not parse is not touched either: it may not be
      // ours, and a stray entry is cheaper than a deleted one.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .filter((key) => {
            const version = versionOf(key);
            return version !== null && THIS_VERSION !== null && version < THIS_VERSION;
          })
          .map((key) => caches.delete(key)),
      );
    }
    // Belt and braces for an old or evicted shell: if the boot set is
    // incomplete, remove the document entry so an offline navigation falls
    // through to /offline.html instead of painting index.html and dying in the
    // module graph. The rest of the cache (including offline.html) is kept.
    if (!(await requiredComplete().catch(() => false))) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.delete('/').catch(() => {});
    }
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
  if (data === 'SKIP_WAITING' || data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  // pwa.js asks a waiting worker which build it is, so a "not now" answer can
  // be remembered for that exact build instead of every cold launch. Both
  // identities are reported: VERSION names the caches, and the build id is what
  // the browser would call a new build (a hash of this file's bytes). The build
  // is the one pwa.js may key a decline on — VERSION alone lies whenever an edit
  // skipped the bump.
  if (data?.type === 'GET_VERSION') {
    event.waitUntil((async () => {
      const message = { type: 'sonora:version', version: VERSION, build: await buildId() };
      if (event.ports?.[0]) event.ports[0].postMessage(message);
      else event.source?.postMessage(message);
    })());
  }
});

// ── notification clicks ────────────────────────────────────────────────────
// A release alert is only useful if tapping it lands on the release. The
// notification carries `data.url` as an in-app route ('#/c/aMPR…'), which is a
// fragment: openWindow('#/c/aMPR…') would open a *blank* page with no app in
// it. So the route is resolved against the worker's own scope and the result
// is a real document URL. An already-open sonora *app* window is preferred over
// a new tab — the app is a player, not a document — and it moves its own router
// when told which route was tapped. "App window" means pathname '/': the room
// and share pages under /l/ and /t/ are same-origin but run different scripts
// (or none), so they cannot open a route and must not be mistaken for the app.
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
      let clientUrl;
      try { clientUrl = new URL(client.url); } catch { continue; }
      if (clientUrl.origin !== new URL(target).origin) continue;
      // Only the app itself can act on `sonora:open-url`: notifications.js owns
      // that listener, and it is loaded by index.html alone. A `/l/<code>`
      // Listen Together tab runs listen.js and a `/t/<id>` share page runs no
      // script at all, so focusing one of those shows the tab, drops the
      // message and loses the release the user just tapped for — with two
      // windows open it was not even deterministic which. Those get a real
      // navigation in an app window instead.
      if (clientUrl.pathname !== '/') continue;
      // A focus() that rejects means this window is not actually on screen (a
      // frozen tab, a window on another desktop): posting the route to it and
      // returning dropped the tap into a client nobody could see, and
      // openWindow was never reached. Only the window that came forward gets
      // the message; the rest of the loop and openWindow remain the fallback.
      if (!(await client.focus().then(() => true, () => false))) continue;
      // The page applies the fragment itself; a client cannot be navigated to a
      // hash route from here without reloading the whole app.
      client.postMessage({ type: 'sonora:open-url', url: route || '/' });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// ── strategies ─────────────────────────────────────────────────────────────

/**
 * Network first; the cached copy is only for when the network genuinely fails.
 * A 5xx is a failure too: a tunnel's "502 can't reach the origin" page handed
 * to the script/style parser is worse than last week's cached copy, and it is
 * exactly what the installed app sees while the origin restarts.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (failedServer(response)) throw new Error(`sonora: ${response.status}`);
    return response;
  } catch {
    // The exact URL first. `ignoreSearch` alone answered a request for
    // `/app.js?v=2` with the cached `/app.js?v=1` — a different URL, and for a
    // versioned asset the wrong one. The search-less match stays as the last
    // resort for a URL that has no query string at all (a future cache keyed by
    // `?v=…` would still answer a bare request), and only after the exact match
    // missed: it can never shadow a real hit.
    const hit = await caches.match(request, { cacheName: SHELL_CACHE });
    if (hit) return hit;
    if (!new URL(request.url).search) {
      const loose = await caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true });
      if (loose) return loose;
    }
    return offlineResponse();
  }
}

/**
 * Serve what we have, refresh in the background, keep the runtime cache small.
 *
 * The response handed to the page is independent of the cache write: a
 * QuotaExceededError (or a `Vary: *` refusal) must never turn a perfectly good
 * fetch into a 503. On quota pressure the runtime cache is dropped — it only
 * holds fonts and icons, and the shell still has the boot-critical ones.
 *
 * Nothing is written that the server refused to have stored, and a runtime copy
 * stops winning once it is older than RUNTIME_FRESH_MS: between the two, a
 * replaced icon or share card used to be shadowed by the first copy this cache
 * ever made, on disk, for as long as the 60-entry cap took to reach it. A
 * shell-owned icon or font is refreshed *in the shell* instead — it is never
 * duplicated into the runtime cache, and the serve path reads the shell copy
 * before the network answer (see below).
 */
function staleWhileRevalidate(event) {
  const { request } = event;
  const update = (async () => {
    let response;
    try {
      response = await fetch(request);
    } catch {
      return null;
    }
    if (failedServer(response) || !response.ok) return response;
    if (NO_STORE.test(response.headers.get('cache-control') || '')) return response;
    try {
      // What the shell already owns is refreshed in the shell, not the runtime
      // cache: caches.match() would always find the shell copy first, so a
      // runtime copy of an icon or font is dead weight — and because the serve
      // path hands out the shell copy before it waits for the network, that dead
      // weight meant a shell-owned icon or font *never* updated online. Writing
      // the fresh copy over the shell entry costs no round trip on this load
      // (the shell still answers it) and is what the next load, online or
      // offline, sees. That is the trade-off: a half-second-old icon here
      // against one that never changed again.
      if (!(await shellMatch(request))) {
        const cache = await caches.open(RUNTIME_CACHE);
        const copy = response.clone();
        try {
          await cache.put(request, copy);
        } catch {
          await caches.delete(RUNTIME_CACHE).catch(() => {});
          return response;
        }
        const keys = await cache.keys();
        for (let i = 0; i < keys.length - RUNTIME_MAX; i++) await cache.delete(keys[i]);
      } else {
        const shell = await caches.open(SHELL_CACHE);
        await shell.put(request, response.clone());
      }
    } catch {
      // Storage failures are never allowed to fail the request.
    }
    return response;
  })();
  // Keep the worker alive for the revalidation even when the cached copy wins.
  event.waitUntil(update.catch(() => {}));

  return (async () => {
    // Read the runtime copy first so a revalidated font can actually win, then
    // the shell for a cold offline load (never after a round trip: the shell is
    // the boot path and must not wait on the network), then the live fetch.
    const runtime = await caches.open(RUNTIME_CACHE).then((cache) => cache.match(request)).catch(() => null);
    if (runtime && Date.now() - servedAt(runtime) < RUNTIME_FRESH_MS) {
      // Bump the entry. Cache Storage records no "last used", so the trim below
      // evicted by insertion order: an icon on every page load aged out ahead of
      // one requested once a week. Re-putting the same response replaces its
      // record, which moves it to the end of the key list — that *is* the LRU,
      // with no bookkeeping of ours to lose.
      event.waitUntil((async () => {
        try {
          const cache = await caches.open(RUNTIME_CACHE);
          await cache.put(request, runtime.clone());
        } catch {
          // A lost bump means a shorter cache life, never a failed request.
        }
      })());
      return runtime;
    }
    const shell = await shellMatch(request).catch(() => null);
    if (shell) return shell;
    const live = await update;
    if (live && !failedServer(live)) return live;
    // An old runtime copy still beats a 503: the user gets yesterday's icon
    // rather than no icon at all.
    if (runtime) return runtime;
    return offlineResponse();
  })();
}

/**
 * The document from the network, or null if the network did not produce a
 * usable one.
 *
 * Navigation preload fetches the document in parallel with the worker boot,
 * which is the difference between an instant shell and a double RTT on a phone
 * behind a tunnel — but a preload answer is not automatically the answer. A *5xx*
 * preload was returned as final: a container restart or a tunnel 502 is a
 * one-shot answer, the plain fetch a moment later usually gets the real document,
 * and without that retry the user sat on the cached shell being told they were
 * offline until they happened to navigate again. A *rejected* preload is the
 * other case — the network is gone — where a second attempt only delays the
 * cached shell that is about to answer anyway.
 */
async function fetchDocument(event) {
  if (event.preloadResponse) {
    let preloaded = null;
    let rejected = false;
    try {
      preloaded = await event.preloadResponse;
    } catch {
      rejected = true;
    }
    if (preloaded && !failedServer(preloaded)) return preloaded;
    if (rejected) return null;
  }
  try {
    return await fetch(event.request);
  } catch {
    return null;
  }
}

// Which fallback document a failed navigation deserves depends on where it was
// going. The app root ('/') is the offline app itself — the cached shell plus
// the offline pill pwa.js shows — so the shell is the right answer there. Any
// other same-origin path is a real server route (/l/<code> guest rooms,
// /t/<id> share pages) that the cached shell cannot render: serving the
// signed-in app for it would make a dead deep link look like it "worked" while
// hiding the room or track it named. Those get the self-explanatory
// /offline.html instead.
async function navigationResponse(event) {
  const { pathname } = new URL(event.request.url);
  // /index.html is the same document as '/', and a bookmark or QR code may use
  // it. Keep both on the app-root branch.
  const appRoot = pathname === '/' || pathname === '/index.html';
  const response = await fetchDocument(event);
  if (response && !failedServer(response)) {
    // A real answer from the origin is the only chance to notice that the shell
    // document changed: nothing else refreshes it short of a whole new install.
    // The refresh outlives this response. `clone()` is the only thing here that
    // can throw (a disturbed body); waitUntil does not, so there is nothing to
    // catch around it.
    if (appRoot) {
      let copy = null;
      try { copy = response.clone(); } catch { /* an uncloneable document is not a refresh */ }
      if (copy) event.waitUntil(refreshShellDocument(copy));
    }
    return response;
  }
  if (!appRoot) {
    const offline = await shellMatch('/offline.html');
    if (offline) return offline;
    return offlineResponse();
  }
  // The boot set is checked here too, not only at activate. Cache Storage can
  // lose entries long after install — piecemeal eviction under storage pressure
  // is routine on iOS — and the cached '/' is then a document whose module graph
  // no longer resolves: index.html paints, then nothing happens. No nav, no
  // player, no message. /offline.html at least explains itself and offers Retry,
  // which is the honest answer to an unrecoverable shell.
  if (await requiredComplete().catch(() => false)) {
    const shell = await shellMatch('/');
    if (shell) return shell;
  }
  const offline = await shellMatch('/offline.html');
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