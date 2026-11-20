import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';

// Installable / offline layer.
//
// Two halves. The static half pins the manifest, the precache list and the
// "never cache personal data" rule, because those are cheap to regress and
// expensive to notice. The browser half drives a real headless Chromium through
// the whole lifecycle: a worker registers and precaches, a *genuinely* offline
// reload still paints the shell, a missing shell falls back to /offline.html,
// an install prompt yields a dismissible banner, and the maskable icon keeps
// its mark inside the safe zone.

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = path.join(ROOT, 'public');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('public/manifest.webmanifest'));
const SW = read('public/sw.js');
const PWA = read('public/pwa.js');
const CSS = read('public/pwa.css');
const OFFLINE = read('public/offline.html');
const INDEX = read('public/index.html');

const SHELL = ['/app.css', '/rooms.css', '/fonts.css', '/app.js', '/rooms.js', '/media-session.js', '/playback.js',
  '/audio-session.js',
  '/pwa.css', '/pwa.js', '/manifest.webmanifest', '/offline.html',
  '/fonts/inter-latin.woff2', '/fonts/inter-latin-ext.woff2'];
// Must match pwa.js's STORM_KEY: the test arms the guard the page reads, so a
// rename in the product renames the test (and vice versa) through this line.
const STORM_KEY = (PWA.match(/const STORM_KEY = '([^']+)'/) || [])[1];
// Must match pwa.js's RELEASE_AT_KEY: the cross-tab marker a releasing tab
// writes and every other tab reads before deciding it may reload itself.
const RELEASE_KEY = (PWA.match(/const RELEASE_AT_KEY = '([^']+)'/) || [])[1];

/** PNG header: width/height live in the IHDR chunk, at bytes 16 and 20. */
function pngInfo(file) {
  const buf = fs.readFileSync(path.join(PUB, file));
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

const precacheList = () => {
  const block = SW.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js has no PRECACHE array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

// ── manifest ──────────────────────────────────────────────────────────────

test('manifest is branded sonora, not a placeholder', () => {
  assert.equal(manifest.name, 'sonora');
  assert.equal(manifest.short_name, 'sonora');
  assert.ok(manifest.description.length >= 60, 'description should explain the product');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'any');
  assert.equal(manifest.lang, 'en');
  assert.equal(manifest.background_color, '#111215');
  assert.equal(manifest.theme_color, '#111215');
  assert.ok(Array.isArray(manifest.categories) && manifest.categories.includes('music'));

  // display_override must not silently drop the standalone experience.
  assert.ok(Array.isArray(manifest.display_override));
  assert.equal(manifest.display_override[0], 'standalone');
  assert.ok(manifest.display_override.includes('minimal-ui'));
});

test('manifest icons cover Android, iOS and maskable at their real sizes', () => {
  const icons = manifest.icons;
  assert.ok(Array.isArray(icons) && icons.length >= 4);

  const find = (size, purpose) => icons.find(
    (icon) => icon.sizes === size && (icon.purpose ?? 'any').split(' ').includes(purpose),
  );

  const any192 = find('192x192', 'any');
  const any512 = find('512x512', 'any');
  const maskable = find('512x512', 'maskable');
  assert.ok(any192, 'no 192x192 "any" icon');
  assert.ok(any512, 'no 512x512 "any" icon');
  assert.ok(maskable, 'no 512x512 maskable icon (Lighthouse installability needs one)');

  // An apple-touch icon: either in the manifest or still linked from the HTML.
  const apple = icons.find((icon) => icon.sizes === '180x180') ?? { src: '/icons/icon-180.png' };
  assert.ok(fs.existsSync(path.join(PUB, apple.src)), `missing ${apple.src}`);

  for (const icon of icons) {
    assert.ok(icon.src.startsWith('/icons/'), `icon outside /icons/: ${icon.src}`);
    assert.ok(icon.type?.startsWith('image/'), `icon without a type: ${icon.src}`);
    const file = icon.src.replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(PUB, file)), `manifest promises a missing file: ${icon.src}`);
    if (icon.sizes === 'any') continue; // the SVG scales
    const [w, h] = icon.sizes.split('x').map(Number);
    const real = pngInfo(file);
    assert.deepEqual({ w: real.width, h: real.height }, { w, h }, `${icon.src} is not ${icon.sizes}`);
    assert.ok(real.bytes > 512, `${icon.src} is a stub, not a render`);
  }

  assert.match(INDEX, /rel="apple-touch-icon"[^>]*icon-180\.png/, 'apple-touch-icon link missing');
  assert.match(INDEX, /rel="manifest" href="\/manifest\.webmanifest"/);
});

test('screenshots are only listed when the files actually exist', () => {
  // A richer install UI (Chrome's app menu) can only show screenshots that are
  // really there, at the size the manifest claims.
  assert.equal(manifest.screenshots?.length, 2, 'the manifest lists no screenshots');
  const forms = manifest.screenshots.map((shot) => shot.form_factor).sort();
  assert.deepEqual(forms, ['narrow', 'wide']);
  for (const shot of manifest.screenshots) {
    assert.equal(shot.type, 'image/png');
    assert.ok(shot.label, `${shot.src} needs a label for the install UI`);
    const file = shot.src.replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(PUB, file)), `manifest lists a missing screenshot: ${shot.src}`);
    const [w, h] = shot.sizes.split('x').map(Number);
    const real = pngInfo(file);
    assert.deepEqual({ w: real.width, h: real.height }, { w, h }, `${shot.src} is not ${shot.sizes}`);
  }
});

test('manifest shortcuts land on real in-app destinations', () => {
  const shortcuts = manifest.shortcuts ?? [];
  assert.equal(shortcuts.length, 4);
  const names = shortcuts.map((s) => s.name);
  assert.deepEqual(names, ['Discover', 'Search', 'Liked songs', 'Radio']);
  for (const shortcut of shortcuts) {
    assert.ok(shortcut.url.startsWith('/'), `${shortcut.name} is not same-origin`);
    assert.match(shortcut.url, /[?&](page|collection)=/, `${shortcut.name} has no destination`);
    assert.ok(shortcut.description, `${shortcut.name} needs a description`);
  }
});

test('each shortcut has its own 96px launcher icon', () => {
  // Every shortcut used to carry /icons/icon-96.png, so a launcher menu showed
  // the same brand mark four times and said nothing about where each one goes.
  const sources = new Set();
  for (const shortcut of manifest.shortcuts) {
    const icon = shortcut.icons?.[0];
    assert.ok(icon, `${shortcut.name} has no launcher icon`);
    assert.equal(icon.sizes, '96x96');
    assert.equal(icon.type, 'image/png');
    assert.ok(!sources.has(icon.src), `${shortcut.name} reuses ${icon.src}`);
    sources.add(icon.src);
    const real = pngInfo(icon.src.replace(/^\//, ''));
    assert.deepEqual([real.width, real.height], [96, 96], `${icon.src} is not 96x96`);
    assert.ok(real.bytes > 512, `${icon.src} is a stub, not a render`);
  }
  assert.equal(sources.size, 4, 'the shortcuts do not have four distinct icons');
  // And the generator can rebuild them; a hand-dropped PNG would rot silently.
  const generator = read('scripts/make-icons.js');
  for (const name of ['wave', 'search', 'heart', 'radio']) {
    assert.match(generator, new RegExp(`shortcuts/${name}\\.svg`), `make-icons.js does not render ${name}`);
  }
});

// ── service worker ────────────────────────────────────────────────────────

test('service worker precaches the whole shell', () => {
  const list = precacheList();
  for (const url of ['/', ...SHELL]) {
    assert.ok(list.includes(url), `PRECACHE is missing ${url}`);
  }
  // Every published bitmap is part of the shell: a shortcut or an install
  // prompt must not be the first thing to discover a missing icon. The *.svg
  // files are design sources; only icon.svg is referenced at runtime.
  // icon-512-transparent.png is the one exception: it is kept on disk as a
  // design asset but referenced by nothing (manifest, HTML or CSS), so
  // precaching it would only spend install time and storage on a dead file.
  const published = fs.readdirSync(path.join(PUB, 'icons'))
    .filter((file) => (file.endsWith('.png') && file !== 'icon-512-transparent.png') || file === 'icon.svg');
  for (const file of published) {
    assert.ok(list.includes(`/icons/${file}`), `PRECACHE is missing /icons/${file}`);
  }
  // And every precached URL is a real file, or the install fails at runtime.
  for (const url of list) {
    const file = url === '/' ? 'index.html' : url.replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(PUB, file)), `PRECACHE lists a 404: ${url}`);
  }
  // The html document must be cached as '/' — that is what offline navigations
  // match against.
  assert.ok(list.includes('/'));
});

test('every module app.js imports is precached, or the offline shell is dead', () => {
  // The shell boots from cache, so a static import that is not in PRECACHE
  // fails *inside* the module graph: index.html and app.js are served from
  // cache, the import 404s, and the app never runs. This is the one class of
  // precache bug that a "does it paint" test cannot see.
  const list = precacheList();
  const app = read('public/app.js');
  const imports = [...app.matchAll(/^import\s[^'"]*['"](\.\/[^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 3, 'app.js lost its static imports');
  for (const specifier of imports) {
    const url = `/${specifier.replace(/^\.\//, '')}`;
    assert.ok(list.includes(url), `PRECACHE is missing ${url}, which app.js imports`);
  }
});

const requiredList = () => {
  const block = SW.match(/const REQUIRED_SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js does not declare which shell entries are required');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

test('install refuses a shell with a hole in the boot set', () => {
  // Only ['/', '/app.js', '/app.css'] used to be required. app.js imports four
  // modules and index.html loads four stylesheets, so one flaky 500 during
  // install produced an "installed" PWA that was a blank shell offline, until
  // a new VERSION shipped. The whole boot set is now mandatory.
  const required = requiredList();
  for (const url of ['/', '/offline.html', '/app.js', '/app.css', '/fonts.css', '/pwa.css', '/pwa.js']) {
    assert.ok(required.includes(url), `REQUIRED_SHELL is missing ${url}`);
  }
  for (const specifier of read('public/app.js').matchAll(/^import\s[^'"]*['"](\.\/[^'"]+)['"]/gm)) {
    const url = `/${specifier[1].replace(/^\.\//, '')}`;
    assert.ok(required.includes(url), `REQUIRED_SHELL is missing the imported module ${url}`);
  }
  for (const href of INDEX.matchAll(/<link rel="stylesheet" href="(\/[^"]+)"/g)) {
    // notifications.css is deliberately best-effort in sw.js: it is cosmetic,
    // and one eviction of it must not turn every navigation into /offline.html.
    // Every stylesheet the app cannot paint without is still required.
    if (href[1] === '/notifications.css') continue;
    assert.ok(required.includes(href[1]), `REQUIRED_SHELL is missing the stylesheet ${href[1]}`);
  }
  assert.match(SW, /if \(missing\.length\)[\s\S]*?throw new Error/, 'install must fail, not accept, a missing boot file');
  // A failed install must clean up only what *it* created. Installing into the
  // live shell cache meant one flaky 500 during a deploy deleted the running
  // worker's whole offline app; install now stages into its own cache and
  // activate promotes a complete one over the shell.
  assert.match(SW, /const STAGING_CACHE = `\$\{SHELL_CACHE\}-next`/, 'install must stage into its own cache');
  assert.match(SW, /caches\.delete\(STAGING_CACHE\)/, 'a failed install must clean up its staging cache');
  assert.match(SW, /requiredComplete\(\)/, 'activate must drop a shell that is missing boot files');
});

test('a gateway 5xx is treated as a network failure, never as the app', () => {
  // A down tunnel answers with Cloudflare's 502 page. The offline fallback only
  // ran when fetch() *rejected*, so that HTML was served as the document (and
  // handed to the JS/CSS parsers) while a complete shell sat in the cache.
  assert.match(SW, /const failedServer = \(response\) => !response \|\| response\.status >= 500/);
  const networkFirst = SW.slice(SW.indexOf('async function networkFirst'), SW.indexOf('/**\n * Serve what we have'));
  assert.match(networkFirst, /failedServer\(response\)/, 'networkFirst returns a 5xx as success');
  assert.ok(networkFirst.indexOf('failedServer') < networkFirst.indexOf('catch'), 'the 5xx check must be inside the try');
  const navigation = SW.slice(SW.indexOf('async function navigationResponse'), SW.indexOf('// ── routing'));
  assert.match(navigation, /failedServer\(response\)/, 'navigationResponse returns a 5xx as the document');
  assert.doesNotMatch(SW, /if \(response\) return response/, 'the old unconditional pass-through is back');
});

test('an /index.html navigation is the app root, not a dead deep link', () => {
  assert.match(SW, /pathname === '\/' \|\| pathname === '\/index\.html'/);
});

test('a cache write failure cannot turn a good response into a 503', () => {
  // SE-03: `update` used to resolve *through* cache.put(), so a quota error
  // discarded the freshly fetched response and answered 503 Offline.
  const swr = SW.slice(SW.indexOf('function staleWhileRevalidate'), SW.indexOf('// Which fallback document'));
  assert.match(swr, /response\.clone\(\)/, 'the cached copy must be cloned, not the response itself');
  assert.match(swr, /catch[\s\S]*caches\.delete\(RUNTIME_CACHE\)/, 'quota pressure must drop the runtime cache');
  // The read is runtime-first; otherwise caches.match() always finds the shell
  // copy and a revalidated font/icon can never win.
  assert.match(swr, /caches\.open\(RUNTIME_CACHE\)[\s\S]*?cache\.match\(request\)/);
  assert.match(swr, /shellMatch\(request\)/, 'the shell fallback for a cold offline load is missing');
  // And shell-owned entries are not duplicated into the runtime cache.
  assert.match(swr, /if \(!\(await shellMatch\(request\)\)\)/);
});

test('service worker is versioned and cleans up old caches', () => {
  assert.match(SW, /const VERSION = '[^']+';/);
  assert.match(SW, /`sonora-shell-\$\{VERSION\}`/);
  assert.match(SW, /`sonora-runtime-\$\{VERSION\}`/);
  assert.match(SW, /caches\.keys\(\)/);
  assert.match(SW, /caches\.delete\(key\)/);
  assert.match(SW, /self\.clients\.claim\(\)/);
  assert.match(SW, /navigationPreload\.enable\(\)/);
  assert.match(SW, /const RUNTIME_MAX = \d+;/);
  assert.match(SW, /keys\.length - RUNTIME_MAX/);
});

test('the activate sweep deletes only strictly older sonora caches, never a rollback target', () => {
  // A rolled-back sw.js (older VERSION) used to sweep the *newer* worker's
  // complete caches away, so a re-deploy had to re-precache everything while
  // offline users lost the shell. The sweep must compare versions and keep
  // both unparsable names (not ours to judge) and newer ones.
  const activate = SW.slice(SW.indexOf("addEventListener('activate'"), SW.indexOf("addEventListener('message'"));
  assert.match(SW, /const versionOf = \(name\) =>/, 'no version parser: the sweep cannot compare');
  assert.match(activate, /versionOf\(key\)/, 'activate never calls versionOf');
  assert.match(activate, /version < THIS_VERSION/, 'the sweep does not require strictly-older');
  assert.doesNotMatch(
    activate,
    /\.filter\(\(key\) => key !== SHELL_CACHE && key !== RUNTIME_CACHE\)\s*\.map\(/,
    'the sweep still deletes every cache that is not its own',
  );
});

test('promoteStagedShell survives a per-key write failure without a silent mixed shell', () => {
  // One failed live.put used to abort the whole promote: some URLs new, some
  // old, stale entries never removed, and requiredComplete() still said
  // "complete" because it only checks URL presence.
  const promote = SW.slice(SW.indexOf('async function promoteStagedShell'), SW.indexOf('// ── activate'));
  assert.match(promote, /failed\.push\(key\.url\)/, 'a failed promote key is not collected');
  assert.match(promote, /if \(failed\.length\)/, 'collecting failures without acting on them');
  assert.match(promote, /live\.delete\('\/'\)/, 'a mixed shell is not demoted to the offline page');
  // Promote-then-delete-stale order: the cache is never momentarily empty.
  assert.ok(
    promote.indexOf('await live.delete(key)') > -1
      && promote.indexOf('await live.delete(key)') < promote.indexOf("live.delete('/')"),
    'the stale-entry sweep must run before the incomplete-shell demotion',
  );
});

test('networkFirst matches the exact URL before ignoreSearch, and only without a query', () => {
  // ignoreSearch answered /app.js?v=2 with the cached /app.js v1 bytes — fine
  // while no shell URL carries a query, a silent stale-code bug the day one does.
  const nf = SW.slice(SW.indexOf('async function networkFirst'), SW.indexOf('/**\n * Serve what we have'));
  assert.ok(
    nf.indexOf('cacheName: SHELL_CACHE }') > -1 && nf.indexOf('cacheName: SHELL_CACHE }') < nf.indexOf('ignoreSearch: true'),
    'the exact match is not tried before ignoreSearch',
  );
  assert.match(nf, /!new URL\(request\.url\)\.search/, 'ignoreSearch may run for a URL that has a query string');
});

test('buildId self-fetch is bounded by a timeout', () => {
  // A TCP-open-no-data stall (exactly what flaky tunnels do) hung the install
  // event forever: no installed state, no update pill, no error.
  const buildId = SW.slice(SW.indexOf('function buildId'), SW.indexOf('// What a document needs'));
  assert.match(buildId, /AbortSignal\.timeout\(\d+\)/, 'buildId fetch has no deadline');
});

test('a no-store document is never written into the shell', () => {
  // The comment claimed the guard gated "anything written"; it only gated the
  // runtime cache. refreshShellDocument wrote whatever the server said.
  const refresh = SW.slice(SW.indexOf('async function refreshShellDocument'), SW.indexOf('// ── install'));
  assert.match(refresh, /NO_STORE\.test\(response\.headers\.get\('cache-control'\)/, 'no no-store check before the shell write');
  assert.ok(
    refresh.indexOf('NO_STORE.test') < refresh.indexOf('cache.put', refresh.indexOf('NO_STORE.test')),
    'the no-store check runs after the put',
  );
});

test('runtime cache hits refresh their recency, and shell-owned assets update online', () => {
  // Eviction was FIFO by insertion: a hot share card could be evicted while
  // stale entries survived. And shell-owned icons/fonts were pinned to
  // install-time bytes forever, even online.
  const swr = SW.slice(SW.indexOf('function staleWhileRevalidate'), SW.indexOf('// Which fallback document'));
  assert.match(swr, /await cache\.put\(request, runtime\.clone\(\)\)/, 'a runtime hit does not re-insert (no LRU bump)');
  assert.match(swr, /keys\.length - RUNTIME_MAX/);
  assert.match(
    swr,
    /caches\.open\(SHELL_CACHE\)[\s\S]{0,160}shell\.put\(request, response\.clone\(\)\)/,
    'a revalidated shell-owned icon/font is never written back to the shell',
  );
});

test('a notification click that cannot focus a window tries the next one', () => {
  // focus() failing still posted the route to an invisible client and
  // returned: the user tapped a release and nothing happened.
  const click = SW.slice(SW.indexOf("addEventListener('notificationclick'"), SW.indexOf('// ── strategies'));
  assert.doesNotMatch(click, /await client\.focus\(\)\.catch\(\(\) => \{\}\)/, 'a failed focus is still treated as success');
  assert.match(click, /focus\(\)[\s\S]{0,80}continue/, 'no fallthrough to the next window/openWindow');
});

test('listen pages are precached best-effort but never required', () => {
  // /l/<code> guest rooms had no offline story: a blip left a play button that
  // does nothing. The scripts are precached; the HTML route stays network-first
  // (it is server-rendered per room); a missing listen.js must not fail the
  // app's own install.
  const list = precacheList();
  for (const url of ['/listen.js', '/listen-venue.js']) {
    assert.ok(list.includes(url), `PRECACHE is missing ${url} (guest rooms have no offline story)`);
  }
  const required = requiredList();
  for (const url of ['/listen.js', '/listen-venue.js']) {
    assert.ok(!required.includes(url), `${url} is required: a missing guest script bricks the app install`);
  }
});

test('the launcher shortcut icons are precached best-effort, never required', () => {
  // A phone that installs sonora and goes offline the first time it opens the
  // launcher menu drew four blank tiles: the shortcut icons are in the manifest
  // and nowhere in the shell. They belong in the install, and they belong in it
  // as *optional* entries — a cosmetic bitmap must never be able to refuse an
  // install the way a boot module can.
  const block = SW.match(/const PRECACHE_OPTIONAL = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js has no PRECACHE_OPTIONAL list');
  const optional = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const required = requiredList();
  const wanted = (manifest.shortcuts ?? []).flatMap((s) => (s.icons ?? []).map((i) => i.src));
  assert.equal(wanted.length, 4, 'the manifest lost a shortcut icon');
  for (const url of wanted) {
    assert.ok(optional.includes(url), `PRECACHE_OPTIONAL is missing ${url} (an offline launcher tile has no icon)`);
    assert.ok(!required.includes(url), `${url} is required: one missing tile would refuse the whole install`);
    assert.ok(fs.existsSync(path.join(PUB, url.replace(/^\//, ''))),
      `PRECACHE_OPTIONAL lists a 404: ${url} — every install would spend a request on it`);
  }
  // Fetched one URL at a time, each failure swallowed: `addAll` would let the
  // first 404 reject the batch and leave the other three uncached.
  assert.match(SW, /PRECACHE_OPTIONAL\.map\(async \(url\) => \{[\s\S]{0,400}?catch/,
    'the optional list is not fetched per-URL with its own failure path');
  assert.doesNotMatch(SW, /cache\.addAll\(PRECACHE_OPTIONAL/,
    'addAll on the optional list is all-or-nothing, which is the bug this list exists to avoid');
});

test('service worker never caches API responses, streams or non-GET', () => {
  assert.match(SW, /request\.method !== 'GET'\) return/);
  assert.match(SW, /\^\\\/api\\\//);
  assert.match(SW, /\^\\\/stream\\\//);
  assert.match(SW, /\^\\\/audio\\\//);
  // The exclusion has to run before respondWith, otherwise a cached /api/ can
  // still win a race. Verified at runtime too, in the browser test below.
  const guard = SW.indexOf("request.method !== 'GET'");
  const firstRespond = SW.indexOf('event.respondWith');
  assert.ok(guard > -1 && guard < firstRespond, 'the GET/API guard runs after respondWith');
});

test('a new worker waits for the page instead of swapping mid-track', () => {
  const install = SW.slice(SW.indexOf("addEventListener('install'"), SW.indexOf("addEventListener('activate'"));
  assert.doesNotMatch(install, /skipWaiting/, 'install must not skipWaiting on its own');
  assert.match(SW, /SKIP_WAITING/);
  assert.match(SW, /self\.skipWaiting\(\)/);
  // Network-first for navigations and code, so no deploy can be masked.
  assert.match(SW, /request\.mode === 'navigate'/);
  assert.match(SW, /networkFirst/);
  assert.match(SW, /preloadResponse/);
});

// ── pwa.js ────────────────────────────────────────────────────────────────

test('pwa.js registers the worker and exposes no globals', () => {
  assert.match(PWA, /navigator\.serviceWorker\.register\('\/sw\.js'/);
  assert.match(PWA, /SKIP_WAITING/);
  assert.match(PWA, /beforeinstallprompt/);
  assert.match(PWA, /display-mode: standalone/);
  assert.match(PWA, /navigator\.standalone/);
  assert.match(PWA, /controllerchange/);
  assert.doesNotMatch(PWA, /from '\.\/app\.js'/);
  assert.doesNotMatch(PWA, /^\s*window\.[\w$]+\s*=/m, 'pwa.js assigned a global');
  assert.doesNotMatch(PWA, /^\s*globalThis\.[\w$]+\s*=/m, 'pwa.js assigned a global');
  // The whole UI is namespaced, so it can never collide with app.css.
  for (const cls of ['pwa-stack', 'pwa-pill', 'pwa-banner', 'pwa-sheet']) {
    assert.ok(PWA.includes(cls), `pwa.js never renders .${cls}`);
  }
  assert.match(PWA, /role', 'status'/);
  assert.match(PWA, /aria-modal/);
  assert.match(PWA, /Escape/);
});

test('the install offer snoozes for 14 days, not forever', () => {
  assert.match(PWA, /sonora\.pwa\.install-snoozed-until/);
  assert.match(PWA, /14 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(PWA, /localStorage\.setItem\(SNOOZE_KEY/);
});

test('a declined update is remembered for that build, not for every launch', () => {
  // The update pill used to reappear on every cold launch until it was tapped
  // (the × was per-session). The worker reports its build; "not now" is stored
  // against that build, and the declined build is applied while backgrounded so
  // the next launch is quietly the new version.
  //
  // The identity is the worker's real build (a hash of sw.js), not the
  // hand-maintained VERSION: editing sw.js without bumping VERSION used to look
  // like "the same build" and the update shipped invisibly to anyone who had
  // once dismissed it.
  assert.match(PWA, /const UPDATE_SNOOZE_KEY = 'sonora\.pwa\.update-snoozed-build'/);
  assert.match(PWA, /const buildIdentity = \(\{ build, version \}\) => build \|\| version \|\| UNKNOWN_BUILD/);
  assert.match(PWA, /declineUpdate\(build\)/);
  assert.match(PWA, /activateWhenHidden\(registration\.waiting\)/);
  assert.match(PWA, /type: 'GET_VERSION'/);
  assert.match(SW, /GET_VERSION[\s\S]*?version: VERSION, build:/, 'the worker must answer with both version and build');
  assert.match(SW, /event\.ports\[0\]\.postMessage/, 'the worker cannot answer the version request');
  // A genuinely different build still gets its own offer.
  assert.match(PWA, /build === declinedUpdate\(\)/);
  // And a handshake that times out must still remember the dismissal, or the
  // pill nags on every cold launch — the exact bug the key exists to stop.
  assert.match(PWA, /declineUpdate\(build \|\| UNKNOWN_BUILD\)|UNKNOWN_BUILD/, 'a timed-out handshake must still snooze');
});

test('iPadOS is detected as iOS Safari, and the explainer is an answer', () => {
  // iPadOS reports a desktop "Macintosh" UA, so offerIosInstall() never ran.
  assert.match(PWA, /navigator\.platform === 'MacIntel' && \(navigator\.maxTouchPoints \?\? 0\) > 1/);
  assert.match(PWA, /isIpadOs\(\) \|\| \/iP\(hone\|ad\|od\)\//);
  // Closing the "How" sheet with "Got it" used to show the card again next launch.
  const done = PWA.slice(PWA.indexOf("querySelector('.pwa-sheet-done')"));
  assert.match(done.slice(0, 260), /snooze\(\)/, 'Got it does not snooze the install offer');
});

test('the offline pill also reacts to an unreachable origin, not just navigator.onLine', () => {
  // Wi-Fi up + tunnel down is this project's own deployment: onLine is true and
  // the only signal is failed traffic. Two consecutive failures are required so
  // one aborted cover cannot raise a false offline state.
  //
  // There used to be a second signalling path — modules dispatching
  // `sonora:reachable` / `sonora:unreachable` — that nothing ever dispatched. It
  // is gone; reachability is decided here, from real traffic.
  assert.doesNotMatch(PWA, /sonora:(?:un)?reachable/, 'the dead event contract must be gone, not half-wired');
  assert.match(PWA, /markUnreachable/);
  assert.match(PWA, /reachFailures < 2/);
  assert.match(PWA, /PerformanceObserver/);
  assert.match(PWA, /entry\.responseStatus/);
  assert.match(PWA, /if \(status >= 500\) markUnreachable\(\)/);
  assert.match(PWA, /media\.error\?\.code === 2/);
});

test('the shell cache is protected with a persistence grant', () => {
  // The shell cache *is* the app; eviction under storage pressure leaves an
  // installed app with nothing to boot from and no way to fix it from inside.
  assert.match(PWA, /navigator\.storage\?\.persist\?\.\(\)/);
});

/** The body of the first @media block whose prelude contains `query`. */
function mediaBlock(css, query) {
  const start = css.indexOf(query);
  assert.ok(start > -1, `pwa.css has no "${query}" block`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced "${query}" block in pwa.css`);
}

test('the install offer is made on desktop too, as a notice instead of a card', () => {
  // Windows and macOS install PWAs from Chromium as well — an installed sonora
  // there gets a Start-menu entry, a frameless window and an offline shell. The
  // offer must therefore not be gated on phone widths; only its *shape* is.
  assert.match(PWA, /const DESKTOP_QUERY = '\(min-width: 1081px\)'/,
    'the desktop breakpoint must be stated once, next to the CSS one');
  assert.match(PWA, /function installNotice/);
  assert.match(PWA, /function offerInstall/);
  assert.match(PWA, /showPill\('install'/);
  assert.match(PWA, /function reflowInstall/);

  // The regression this guards: pwa.css used to hide .pwa-banner above 1080px,
  // which silently removed the only install surface those browsers offer.
  const desktop = mediaBlock(CSS, '(min-width: 1081px)');
  assert.doesNotMatch(desktop, /pwa-banner[^{]*\{[^}]*display:\s*none/,
    'the desktop block hides the install offer again');
  assert.doesNotMatch(desktop, /pwa-pill[^{]*\{[^}]*display:\s*none/,
    'the desktop block hides the install notice');
  // ...and the notice is styled, not a bare pill.
  assert.match(CSS, /\.pwa-pill\[data-kind="install"\] \.pwa-pill-action \{[^}]*background/);
});

test('pwa.css keeps the chrome above the player and honours insets', () => {
  // Measured placement wins; the calc() is the no-measurement fallback.
  assert.match(CSS, /\.pwa-stack\s*\{[\s\S]*?bottom: var\(--pwa-bottom, calc\(99px \+ env\(safe-area-inset-bottom, 0px\)\)\)/);
  assert.match(CSS, /@media \(max-width: 650px\)[\s\S]*?bottom: var\(--pwa-bottom, calc\(148px \+ env\(safe-area-inset-bottom, 0px\)\)\)/);
  assert.match(PWA, /--pwa-bottom/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(CSS, /focus-visible/);
  assert.match(CSS, /\.pwa-sheet-backdrop\[hidden\]/);
  assert.match(CSS, /min-height: 44px/);
  // Nothing here may restyle the app: every selector is scoped to a .pwa-*
  // class. (`.pwa-banner-btn.primary` is fine; a bare `.primary` is not.)
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...stripped.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].map((m) => m[1].trim());
  assert.ok(rules.length > 20, 'pwa.css lost its rules');
  for (const rule of rules) {
    if (!rule || rule.startsWith('@')) continue; // @media / @keyframes preludes
    for (const part of rule.split(',')) {
      const selector = part.trim();
      if (!selector) continue;
      if (/^(from|to|\d+(\.\d+)?%)$/.test(selector)) continue; // keyframe stops
      if (selector.startsWith(':')) continue; // :root, ::selection
      assert.match(selector, /^\.pwa-/, `pwa.css styles a non-namespaced selector: ${selector}`);
    }
  }
});

test('index.html asks for the pwa assets', () => {
  assert.match(INDEX, /<link rel="stylesheet" href="\/pwa\.css">/);
  assert.match(INDEX, /<script type="module" src="\/pwa\.js"><\/script>/);
});

// ── offline page ──────────────────────────────────────────────────────────

test('offline page is self-contained, branded and recoverable', () => {
  assert.match(OFFLINE, /<title>sonora — offline<\/title>/);
  assert.match(OFFLINE, /sonora/);
  assert.match(OFFLINE, /id="retry"/);
  assert.match(OFFLINE, /<a class="reload" href="\/">Reload sonora<\/a>/);
  assert.match(OFFLINE, /env\(safe-area-inset-bottom/);
  assert.match(OFFLINE, /prefers-reduced-motion/);
  assert.match(OFFLINE, /name="theme-color" content="#111215"/);
  // No external anything: this page loads when the network is gone.
  assert.doesNotMatch(OFFLINE, /<script[^>]+src=/);
  assert.doesNotMatch(OFFLINE, /<link[^>]+stylesheet/);
  assert.doesNotMatch(OFFLINE, /(?:src|href)="https?:/);
  // And no recursion into the worker that served it.
  assert.doesNotMatch(OFFLINE, /serviceWorker/);
});

test('the offline page distinguishes an unreachable server from an offline device', () => {
  // The page is served by the worker whenever the origin does not answer — which
  // includes "the phone is online and sonora is down". Telling that user to
  // "check your network" sends them looking in the wrong place.
  assert.match(OFFLINE, /server isn't answering/);
  assert.doesNotMatch(OFFLINE, /Check your network/);
  // Heading still names the non-connection (test/android-pwa.test.js pins it).
  assert.match(OFFLINE, /<h1>No connection/i);
});

test('the offline page says it is retrying instead of reloading silently', () => {
  assert.match(OFFLINE, /retry\.disabled = true/);
  assert.match(OFFLINE, /Retrying…/);
  assert.match(OFFLINE, /location\.reload\(\)/);
});

test('the offline page leaves by itself when the connection comes back', () => {
  // Nothing on this page polls, and the worker serves it for "the origin did
  // not answer", so a page that only offered a button sat there claiming there
  // was no connection while the connection was back.
  assert.match(OFFLINE, /addEventListener\('online'/,
    'the offline page does not listen for the connection returning');
  assert.match(OFFLINE, /addEventListener\('online'[\s\S]{0,200}location\.reload\(\)/,
    'the online listener must reload, and the reload is the whole recovery');
  assert.match(OFFLINE, /navigator\.onLine/,
    'a reload while still offline only serves this page again');
});

test('index.html explains a dead script instead of showing a blank app forever', () => {
  // With scripting off, or with app.js unable to resolve out of a half-evicted
  // shell, this document painted a header, a player bar and an empty page root
  // — and never said why.
  assert.match(INDEX, /<noscript>/);
  assert.match(INDEX, /needs JavaScript/);
  // The watchdog: inline (it must run when nothing else can), 5 s, and a banner
  // that carries the reload itself rather than depending on app.js for it.
  assert.match(INDEX, /id="boot-recovery"/);
  assert.match(INDEX, /id="boot-recovery"[\s\S]{0,400}role="alert"/);
  assert.match(INDEX, /setTimeout\(function \(\) \{[\s\S]{0,200}\}, 5000\)/,
    'the boot watchdog is not a 5 s timer');
  assert.match(INDEX, /<a href="\/" id="boot-recovery-reload"/,
    'the recovery banner needs a reload that works with scripting already broken');
  // The page that *does* boot must clear it, or every slow boot grows a banner.
  const APP = read('public/app.js');
  assert.match(APP, /document\.documentElement\.dataset\.sonoraBooted = '1'/);
  assert.match(APP, /clearTimeout\(window\.__sonoraBootWatch\)/);
});

test('install copy promises the shell, never offline playback', () => {
  // The shell opens with no network; nothing plays until the origin can reach
  // YouTube (docs/pwa-device-audit.md §3.2). "works offline" claimed otherwise.
  assert.ok(!PWA.includes('one tap away, works offline'), 'the iOS offer promises offline playback');
  assert.ok(!PWA.includes('full screen, works offline'), 'the desktop notice promises offline playback');
  assert.match(PWA, /offline app shell/);
});

test('the conventional favicon.ico is served, not a 404', async () => {
  // Pages without a <link rel="icon"> (offline.html) make browsers request
  // /favicon.ico by convention; a missing one is a 404 in every log.
  const file = path.join(PUB, 'favicon.ico');
  assert.ok(fs.existsSync(file), 'no public/favicon.ico: /favicon.ico is a 404 by convention');
  const real = pngInfo('favicon.ico'); // PNG bytes in an .ico are accepted by browsers
  assert.deepEqual([real.width, real.height], [192, 192]);
  const response = await fetch(`${BASE}/favicon.ico`);
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, real.bytes);
});

test('a shortcut tapped while the app runs focuses it instead of reloading', () => {
  // navigate-existing reloads the document — which stops the music — for a tap
  // that only meant "show me Search". focus-existing focuses the live window,
  // and pwa.js re-reads a query string that arrives without a page load.
  assert.equal(manifest.launch_handler?.client_mode, 'focus-existing');
  assert.match(PWA, /function honourShortcutAgain/);
  assert.match(PWA, /addEventListener\('focus', honourShortcutAgain\)/);
  assert.match(PWA, /addEventListener\('pageshow', honourShortcutAgain\)/);
});

test('an update released by another tab may not auto-reload this one', () => {
  // Cross-tab consent: sessionStorage is per tab, so the storm guard cannot see
  // a sibling's Refresh. The release marker is shared and time-limited.
  assert.equal(RELEASE_KEY, 'sonora-update-release-at');
  assert.match(PWA, /function releasedElsewhere/);
  assert.match(PWA, /localStorage\.setItem\(RELEASE_AT_KEY/);
  assert.match(PWA, /autoReloadBlocked = true/);
  assert.match(PWA, /stormBooted \|\| autoReloadBlocked/);
  // One binding of the stale reload, however many takeovers arrive.
  assert.match(PWA, /if \(!staleWired\)/);
  assert.match(PWA, /staleController = false;/, 'reloadOnce does not clear the stale flag');
});

// ── real browser ──────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-'));
let server;
let browser;
let iosBrowser;
let desktopBrowser;
let updateBrowser;
let gatewayBrowser;
let PORT;
let BASE;
let DEBUG_PORT;
let cdp;

/**
 * A second, independent CDP session on the browser. The helper (rightly) does
 * not expose raw protocol access, and offline emulation needs two things it
 * cannot give: Network.emulateNetworkConditions on the page *and* on the
 * worker, because a service worker's fetch is not covered by the page's
 * conditions. Emulating only the page would leave the worker online and the
 * "offline" test would prove nothing.
 */
async function rawSession(port, match) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const attach = async (targetId) => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    return (method, params) => send(method, params, sessionId);
  };

  let pageSession = null;
  for (let i = 0; i < 100 && !pageSession; i++) {
    const { targetInfos } = await send('Target.getTargets');
    const target = targetInfos.find(match);
    if (target) pageSession = await attach(target.targetId);
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (!pageSession) throw new Error('no page target matched');
  await pageSession('Network.enable');

  return {
    async offline(value) {
      await pageSession('Network.emulateNetworkConditions', {
        offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      // The worker owns its own network conditions.
      const { targetInfos } = await send('Target.getTargets');
      const worker = targetInfos.find((t) => t.type === 'service_worker');
      if (!worker) return false;
      if (!this.workerSession) await this.attachWorker(worker.targetId);
      await this.workerSession('Network.emulateNetworkConditions', {
        offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      return true;
    },
    async attachWorker(targetId) {
      this.workerSession = await attach(targetId);
      await this.workerSession('Network.enable');
    },
    async swTarget(matchWorker) {
      const { targetInfos } = await send('Target.getTargets');
      return targetInfos.find(matchWorker) ?? null;
    },
    /** Chrome's own installability verdict for this page. */
    async installability() {
      const { installabilityErrors } = await pageSession('Page.getInstallabilityErrors');
      return installabilityErrors ?? [];
    },
    /** Emulated media features (display-mode, colour scheme) for this page. */
    async media(features) {
      await pageSession('Emulation.setEmulatedMedia', { features });
    },
    /** Emulate a phone viewport *without* forcing display-mode: standalone. */
    async viewport({ width, height, top = 0, bottom = 0 }) {
      await pageSession('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height,
      });
      await pageSession('Emulation.setSafeAreaInsetsOverride', {
        insets: { top, topMax: top, bottom, bottomMax: bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 },
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}


/**
 * A pass-through proxy in front of the test server that can serve /sw.js with a
 * different VERSION. This is the only way to produce a *genuine* service worker
 * update without editing the repo mid-run: the browser byte-compares /sw.js,
 * sees a new build, and installs it into the waiting state that the Refresh
 * pill exists for.
 */
function updateProxy(upstream) {
  const target = new URL(upstream);
  let version = 'v1';
  // A down tunnel does not refuse the connection: it answers with its own HTML
  // and a 502. That is the case the worker used to hand straight to the page.
  let gatewayDown = false;
  const server = http.createServer((req, res) => {
    if (gatewayDown && req.url.split('?')[0] !== '/sw.js') {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>502 Bad gateway</title>'
        + '<h1>Error 502</h1><p>cloudflared can not reach the origin</p>');
      return;
    }
    const proxyReq = http.request({
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      // Forward cookie/accept etc. Host must be the upstream's own.
      headers: { ...req.headers, host: target.host },
      agent: false,
    }, (up) => {
      if (req.url.split('?')[0] === '/sw.js') {
        const chunks = [];
        up.on('data', (chunk) => chunks.push(chunk));
        up.on('end', () => {
          const source = Buffer.concat(chunks).toString('utf8')
            .replace(/const VERSION = '[^']+';/, `const VERSION = '${version}';`);
          res.writeHead(up.statusCode ?? 200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-cache',
            'content-length': Buffer.byteLength(source),
          });
          res.end(source);
        });
        return;
      }
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    proxyReq.on('error', () => { try { res.writeHead(502); res.end('proxy error'); } catch {} });
    req.pipe(proxyReq);
  });
  return {
    listen: (port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    setVersion: (next) => { version = next; },
    setGatewayDown: (next) => { gatewayDown = next; },
    close: () => server.close(),
  };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SONORA_DB: path.join(TMP, 'test.db'),
      SONORA_AUDIO_DIR: path.join(TMP, 'audio'),
      SONORA_SECRET: 'pwa-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error(`server did not start:\n${logs.join('')}`);

  if (CHROME) {
    DEBUG_PORT = await freePort();
    browser = await launch(DEBUG_PORT);
  }
});

after(() => {
  browser?.close();
  iosBrowser?.close();
  desktopBrowser?.close();
  updateBrowser?.close();
  gatewayBrowser?.close();
  cdp?.close();
  server?.kill('SIGTERM');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const shellPaths = `(async () => {
  const names = await caches.keys();
  const shell = names.find((name) => name.startsWith('sonora-shell'));
  if (!shell) return null;
  return (await (await caches.open(shell)).keys()).map((request) => new URL(request.url).pathname);
})()`;

test('the worker registers, activates and precaches the shell', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.goto(`${BASE}/`);
  cdp = await rawSession(DEBUG_PORT, (target) => target.type === 'page' && target.url.startsWith(BASE));

  await browser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
  await browser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
  await browser.waitFor(`${shellPaths}
    .then((paths) => !!paths && paths.includes('/') && paths.includes('/app.js') && paths.includes('/pwa.js') && paths.includes('/offline.html'))`, 30000);

  const paths = await browser.eval(shellPaths);
  for (const url of ['/', ...SHELL]) assert.ok(paths.includes(url), `not precached: ${url}`);

  const meta = await browser.eval(`(async () => {
    const response = await fetch('/manifest.webmanifest');
    return {
      href: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      type: response.headers.get('content-type'),
      body: await response.json(),
    };
  })()`);
  assert.equal(meta.href, '/manifest.webmanifest');
  assert.match(meta.type, /manifest\+json/);
  assert.equal(meta.body.name, 'sonora');

  // Chrome's own verdict, not ours: it parses the manifest, checks the icons,
  // the display mode and the worker, and would list every reason it refuses to
  // install. An empty array is what "installable" actually means.
  const installability = await cdp.installability();
  assert.deepEqual(installability, [], `Chrome refuses to install the app: ${JSON.stringify(installability)}`);
});

test('an offline reload paints the shell, not a browser error', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // Navigate before creating the session: rawSession polls for a page target
  // at BASE, which only exists once some page has been there (an isolated
  // --test-name-pattern run starts on about:blank).
  await browser.goto(`${BASE}/`);
  const session = cdp ?? await rawSession(DEBUG_PORT, (target) => target.type === 'page' && target.url.startsWith(BASE));
  cdp = session;
  // The premise is an installed worker with a complete cached shell; in an
  // isolated run nothing installed one yet.
  await browser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
  await browser.waitFor(`${shellPaths}.then((paths) => !!paths && paths.includes('/') && paths.includes('/app.js'))`, 30000);

  const workerOffline = await session.offline(true);
  assert.ok(workerOffline, 'no service_worker target found — cannot emulate a real offline device');

  try {
    await browser.goto(`${BASE}/`);
    const state = await browser.eval(`(() => {
      const pill = document.querySelector('.pwa-pill[data-kind="offline"]');
      const player = document.querySelector('.player');
      const rect = (el) => el ? el.getBoundingClientRect() : null;
      const p = rect(pill);
      const pl = rect(player);
      return {
        online: navigator.onLine,
        title: document.title,
        app: !!document.querySelector('.app'),
        chromeError: /ERR_INTERNET_DISCONNECTED|No internet/.test(document.body.innerText || ''),
        pill: pill ? pill.textContent : null,
        pillRect: p ? { top: p.top, bottom: p.bottom, left: p.left, right: p.right } : null,
        playerRect: pl ? { top: pl.top } : null,
        vh: innerHeight,
        vw: innerWidth,
      };
    })()`);

    assert.equal(state.online, false, 'the page should know it is offline');
    assert.equal(state.app, true, 'the cached shell did not render');
    assert.equal(state.chromeError, false, 'Chromium rendered its own network error page');
    assert.match(state.title, /sonora/);
    assert.match(state.pill ?? '', /offline/i, 'no offline pill was announced');
    assert.ok(state.pillRect, 'the offline pill has no box');
    // The pill has to sit above the mini player and inside the viewport.
    assert.ok(state.pillRect.bottom <= state.playerRect.top,
      `pill ends at ${state.pillRect.bottom}px, over the player starting at ${state.playerRect.top}px`);
    assert.ok(state.pillRect.top >= 0 && state.pillRect.left >= 0 && state.pillRect.right <= state.vw,
      'offline pill is clipped by the viewport');

    // The shell is not the document alone: app.js is an ES module graph, and a
    // static import that is not in PRECACHE fails *after* the page paints — the
    // app then never boots while every "does it render" check still passes. A
    // dynamic import is the honest witness: it resolves for a module the worker
    // served from the cache and rejects for one it had to answer with its 503.
    // (Resource Timing cannot tell the two apart: a 503 is still an entry.)
    const graph = await browser.eval(`(async () => {
      const out = {};
      for (const url of ['/app.js', '/audio-session.js', '/media-session.js', '/playback.js', '/rooms.js']) {
        out[url] = await import(url).then(() => true).catch(() => false);
      }
      return out;
    })()`);
    for (const [url, ok] of Object.entries(graph)) {
      assert.equal(ok, true, `${url} did not load offline: the app.js module graph is broken`);
    }
  } finally {
    // Coming back online recovers by itself.
    await session.offline(false).catch(() => {});
  }
  await browser.eval(`window.dispatchEvent(new Event('online'))`);
  await browser.waitFor(`!document.querySelector('.pwa-pill[data-kind="offline"]')`, 6000);
});

test('with no cached shell the worker serves the branded offline page', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // Navigate first: rawSession polls for a page target at BASE (isolated runs
  // start on about:blank). This test's premise is an installed worker whose
  // shell already cached '/'; wait for it rather than depending on a previous
  // test's side effects.
  await browser.goto(`${BASE}/`);
  const session = cdp ?? await rawSession(DEBUG_PORT, (target) => target.type === 'page' && target.url.startsWith(BASE));
  cdp = session;
  await browser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
  await browser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
  await browser.waitFor(`${shellPaths}.then((paths) => !!paths && paths.includes('/') && paths.includes('/offline.html'))`, 30000);

  // Simulate a shell that never finished installing (or was evicted).
  await browser.eval(`(async () => {
    const shell = (await caches.keys()).find((name) => name.startsWith('sonora-shell'));
    return shell ? (await caches.open(shell)).delete('/') : false;
  })()`);

  await session.offline(true);
  try {
    await browser.goto(`${BASE}/`);
    const state = await browser.eval(`({
      retry: !!document.getElementById('retry'),
      app: !!document.querySelector('.app'),
      text: (document.body.innerText || '').toLowerCase(),
      reload: document.querySelector('a.reload')?.getAttribute('href'),
      title: document.title,
    })`);
    assert.equal(state.retry, true, 'offline page has no Retry button');
    assert.equal(state.app, false, 'served the app shell even though it is not cached');
    assert.match(state.text, /offline|connection/);
    assert.equal(state.reload, '/');
    assert.match(state.title, /offline/);
  } finally {
    await session.offline(false).catch(() => {});
  }

  // The test above deleted '/' from the shell cache to simulate a missing
  // shell; put it back (we are online again) so the navigation test below
  // exercises the worker's fallback *routing*, not an empty cache.
  await browser.eval(`(async () => {
    const shell = (await caches.keys()).find((name) => name.startsWith('sonora-shell'));
    if (shell && !(await (await caches.open(shell)).match('/'))) {
      await (await caches.open(shell)).add('/');
    }
    return true;
  })()`);
});

test('offline deep links get the offline page, the app root gets the shell', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // Navigate before creating the session (isolated runs start on about:blank),
  // so rawSession always finds a page target at BASE.
  await browser.goto(`${BASE}/`);
  const session = cdp ?? await rawSession(DEBUG_PORT, (target) => target.type === 'page' && target.url.startsWith(BASE));
  cdp = session;

  // This test's premise is an *installed* worker with a cached shell; in an
  // isolated name-pattern run nothing has installed one yet. Wait for it here
  // rather than depending on a previous test's side effects.
  await browser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
  await browser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
  await browser.waitFor(`${shellPaths}.then((paths) => !!paths && paths.includes('/') && paths.includes('/offline.html'))`, 30000);

  await session.offline(true);
  try {
    // /l/<code> is a real server route (Listen Together guest page), not an app
    // hash route. The cached shell cannot render it, so the worker must answer
    // with the self-explanatory offline page rather than the signed-in app.
    await browser.goto(`${BASE}/l/xyz`);
    const link = await browser.eval(`({
      retry: !!document.getElementById('retry'),
      app: !!document.querySelector('.app'),
      title: document.title,
    })`);
    assert.equal(link.app, false, 'an offline /l/<code> deep link was served the app shell');
    assert.equal(link.retry, true, 'an offline /l/<code> deep link did not get the offline page');
    assert.match(link.title, /offline/);

    // The app root is the offline app itself: the cached shell (plus the offline
    // pill pwa.js raises) is still the right answer there.
    await browser.goto(`${BASE}/`);
    const root = await browser.eval(`({
      app: !!document.querySelector('.app'),
      title: document.title,
    })`);
    assert.equal(root.app, true, 'an offline / was not served the cached shell');
    assert.match(root.title, /sonora/);

    // /index.html is the same document as '/', not a deep link: a bookmark or a
    // QR code that spells it out must still get the app offline.
    await browser.goto(`${BASE}/index.html`);
    const spelled = await browser.eval(`({
      app: !!document.querySelector('.app'),
      retry: !!document.getElementById('retry'),
      title: document.title,
    })`);
    assert.equal(spelled.app, true, 'an offline /index.html got the offline page instead of the app');
    assert.equal(spelled.retry, false, 'an offline /index.html was treated as a deep link');
  } finally {
    await session.offline(false).catch(() => {});
  }
});

test('a gateway 502 falls back to the cached shell, not Cloudflare', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  const proxyPort = await freePort();
  const proxy = updateProxy(BASE);
  await proxy.listen(proxyPort);
  const origin = `http://127.0.0.1:${proxyPort}`;

  // A separate profile: its cache/origin must not disturb the offline tests.
  gatewayBrowser = await launch(await freePort());
  try {
    await gatewayBrowser.goto(`${origin}/`);
    await gatewayBrowser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
    await gatewayBrowser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
    await gatewayBrowser.waitFor(`${shellPaths}.then((paths) => !!paths
      && paths.includes('/app.js') && paths.includes('/rooms.js') && paths.includes('/offline.html'))`, 30000);

    // The tunnel is down: it answers, it does not refuse the connection.
    proxy.setGatewayDown(true);

    await gatewayBrowser.goto(`${origin}/`);
    const state = await gatewayBrowser.eval(`(() => ({
      title: document.title,
      app: !!document.querySelector('.app'),
      chromeError: /can not reach the origin|502 Bad gateway/i.test(document.body.innerText || ''),
      offlinePage: !!document.getElementById('retry'),
    }))()`);
    assert.equal(state.app, true, 'the 502 page was served instead of the cached shell');
    assert.equal(state.chromeError, false, "Cloudflare's error page reached the listener");
    assert.match(state.title, /sonora/);
    assert.equal(state.offlinePage, false, 'the app root got offline.html instead of the app');

    // A 502 must not be handed to the module graph either: script requests are
    // network-first, and a `text/html` 502 to the module loader is fatal.
    const graph = await gatewayBrowser.eval(`(async () => {
      const out = {};
      for (const url of ['/app.js', '/rooms.js', '/media-session.js', '/audio-session.js', '/playback.js']) {
        out[url] = await import(url).then(() => true).catch(() => false);
      }
      return out;
    })()`);
    for (const [url, ok] of Object.entries(graph)) {
      assert.equal(ok, true, `${url} was served the gateway's 502 body`);
    }

    // Deep links cannot be rendered by the cached shell, so the honest answer
    // there is the offline page (not the signed-in app pretending to be a room).
    await gatewayBrowser.goto(`${origin}/l/xyz`);
    const deep = await gatewayBrowser.eval(`({
      retry: !!document.getElementById('retry'),
      app: !!document.querySelector('.app'),
      title: document.title,
    })`);
    assert.equal(deep.retry, true, 'an offline deep link did not get the offline page');
    assert.equal(deep.app, false, 'an offline deep link was served the app shell');
    assert.match(deep.title, /offline/);
  } finally {
    proxy.setGatewayDown(false);
    proxy.close();
  }
});

test('the worker caches no API responses or media', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  const caches_ = await browser.eval(`(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      const requests = await (await caches.open(name)).keys();
      out.push({ name, paths: requests.map((request) => new URL(request.url).pathname) });
    }
    return out;
  })()`);
  assert.ok(caches_.length > 0, 'no caches at all');
  assert.ok(caches_.some((cache) => /^sonora-shell-v\d+$/.test(cache.name)), 'shell cache is not versioned');
  const leaked = caches_.flatMap((cache) => cache.paths.filter(
    (url) => /^\/(api|stream|audio)\//.test(url),
  ));
  assert.deepEqual(leaked, [], `personal or ranged responses were cached: ${leaked.join(', ')}`);
});

test('the install banner appears, stays clear of the player, and snoozes', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await browser.goto(`${BASE}/`);
  const session = cdp ?? await rawSession(DEBUG_PORT, (target) => target.type === 'page' && target.url.startsWith(BASE));
  cdp = session;

  await session.viewport({ width: 390, height: 844, top: 59, bottom: 34 });
  await new Promise((r) => setTimeout(r, 120));

  await browser.eval(`(() => {
    localStorage.removeItem('sonora.pwa.install-snoozed-until');
    // Chromium may have fired its own, real beforeinstallprompt already; drop
    // whatever it produced so this test exercises the synthetic event.
    document.querySelector('.pwa-banner')?.remove();
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => ({ outcome: 'accepted' });
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(event);
    return true;
  })()`);

  await browser.waitFor(`!!document.querySelector('.pwa-banner')`, 5000);
  const shown = await browser.eval(`(() => {
    const banner = document.querySelector('.pwa-banner');
    const player = document.querySelector('.player');
    const b = banner.getBoundingClientRect();
    return {
      title: banner.querySelector('.pwa-banner-title')?.textContent,
      text: banner.textContent,
      buttons: [...banner.querySelectorAll('button')].map((button) => button.textContent),
      role: banner.getAttribute('role'),
      labelledby: banner.getAttribute('aria-labelledby'),
      banner: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
      playerTop: player.getBoundingClientRect().top,
      vw: innerWidth,
      vh: innerHeight,
    };
  })()`);

  assert.equal(shown.title, 'Install sonora');
  assert.match(shown.text, /Home Screen|home screen/);
  assert.deepEqual(shown.buttons, ['Install', 'Not now']);
  assert.equal(shown.role, 'group');
  assert.equal(shown.labelledby, 'pwa-install-title');
  assert.ok(shown.banner.bottom <= shown.playerTop,
    `banner ends at ${shown.banner.bottom}px, over the player at ${shown.playerTop}px`);
  assert.ok(shown.banner.left >= 0 && shown.banner.right <= shown.vw, 'banner overflows the phone');
  assert.ok(shown.banner.top >= 0 && shown.banner.bottom <= shown.vh, 'banner is off screen');

  // Dismiss: gone immediately, and quiet for two weeks.
  await browser.eval(`document.querySelector('.pwa-banner .pwa-banner-btn.ghost').click()`);
  await browser.waitFor(`!document.querySelector('.pwa-banner')`, 3000);

  const snoozeUntil = await browser.eval(`Number(localStorage.getItem('sonora.pwa.install-snoozed-until'))`);
  const days = (snoozeUntil - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days < 14.1, `snooze is ${days.toFixed(2)} days, expected 14`);

  // A page load during the snooze must not ask again.
  await browser.eval(`(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => ({ outcome: 'dismissed' });
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(event);
    return true;
  })()`);
  // The banner is deliberately delayed after beforeinstallprompt, so wait past
  // that delay before concluding it stayed away.
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(await browser.eval(`!!document.querySelector('.pwa-banner')`), false,
    'the banner ignored its own snooze');

  // Installed (standalone) builds must never nag: no banner even with a fresh
  // beforeinstallprompt and no snooze in storage. (CDP's display-mode emulation
  // is inert for this target, so the media query is what gets stubbed.)
  await browser.eval(`(() => {
    const real = window.matchMedia.bind(window);
    window.__realMatchMedia = real;
    window.matchMedia = (query) => {
      // double backslash: this runs inside a template literal
      if (!/display-mode:\\s*standalone/.test(query)) return real(query);
      return {
        matches: true, media: query, onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent() { return false; },
      };
    };
    localStorage.removeItem('sonora.pwa.install-snoozed-until');
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => ({ outcome: 'accepted' });
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
    return window.matchMedia('(display-mode: standalone)').matches;
  })()`);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(await browser.eval(`!!document.querySelector('.pwa-banner')`), false,
    'the install banner appeared inside a standalone window');
  await browser.eval(`(() => { window.matchMedia = window.__realMatchMedia; delete window.__realMatchMedia; return true; })()`);
});

// A separate browser: this test needs the *real* Chromium install event out of
// the way (it fires at an unpredictable moment and would re-offer mid-assertion)
// while still letting a synthetic one through, so the init script below tags and
// swallows by turn.
test('a desktop window gets a one-line install notice, and Install is one tap', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  desktopBrowser = await launch(await freePort());
  await desktopBrowser.addInitScript(`
    window.addEventListener('beforeinstallprompt', (event) => {
      if (!event.__synthetic) event.stopImmediatePropagation();
    }, true);
  `);
  await desktopBrowser.viewport({ width: 1440, height: 900 });
  await desktopBrowser.goto(`${BASE}/`);

  // The offer is announced, not thrown at the first paint, and Windows/macOS
  // copy talks about the desktop, not a home screen.
  const fire = (outcome) => desktopBrowser.eval(`(() => {
    window.__prompted = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.__synthetic = true;
    event.prompt = async () => { window.__prompted++; return { outcome: '${outcome}' }; };
    event.userChoice = Promise.resolve({ outcome: '${outcome}' });
    window.dispatchEvent(event);
    return true;
  })()`);

  await fire('accepted');
  await desktopBrowser.waitFor(`!!document.querySelector('.pwa-pill[data-kind="install"]')`, 6000);

  const shown = await desktopBrowser.eval(`(() => {
    const pill = document.querySelector('.pwa-pill[data-kind="install"]');
    const action = pill.querySelector('.pwa-pill-action');
    const p = pill.getBoundingClientRect();
    const a = action.getBoundingClientRect();
    return {
      text: pill.textContent,
      action: action.textContent,
      role: pill.getAttribute('role'),
      card: !!document.querySelector('.pwa-banner'),
      box: { top: p.top, bottom: p.bottom, left: p.left, right: p.right },
      actionBox: { width: a.width, height: a.height },
      playerTop: document.querySelector('.player').getBoundingClientRect().top,
      vw: innerWidth,
      vh: innerHeight,
    };
  })()`);

  assert.equal(shown.card, false, 'desktop rendered the phone card after all');
  assert.match(shown.text, /desktop/, 'the desktop copy still talks about a home screen');
  assert.equal(shown.action, 'Install');
  assert.equal(shown.role, 'status');
  // One line, above the player, inside the window — and a real tap target.
  assert.ok(shown.box.bottom <= shown.playerTop,
    `notice ends at ${shown.box.bottom}px, over the player at ${shown.playerTop}px`);
  assert.ok(shown.box.top >= 0 && shown.box.left >= 0 && shown.box.right <= shown.vw,
    'the install notice is clipped by the window');
  assert.ok(shown.actionBox.height >= 32 && shown.actionBox.width >= 44,
    `Install is ${shown.actionBox.width}x${shown.actionBox.height}px`);

  // Install is the one tap the whole notice exists for.
  await desktopBrowser.eval(`document.querySelector('.pwa-pill[data-kind="install"] .pwa-pill-action').click()`);
  await desktopBrowser.waitFor(`window.__prompted === 1`, 4000);
  await desktopBrowser.waitFor(`!document.querySelector('.pwa-pill[data-kind="install"]')`, 4000);

  // The shape follows the window: narrowing past the sidebar breakpoint turns
  // the same offer into the phone card, and widening turns it back. Neither
  // direction snoozes anything.
  await fire('dismissed');
  await desktopBrowser.waitFor(`!!document.querySelector('.pwa-pill[data-kind="install"]')`, 6000);

  await desktopBrowser.viewport({ width: 700, height: 900 });
  await desktopBrowser.waitFor(`!!document.querySelector('.pwa-banner')`, 4000);
  assert.equal(await desktopBrowser.eval(`!!document.querySelector('.pwa-pill[data-kind="install"]')`), false,
    'the notice survived the window becoming narrow');

  await desktopBrowser.viewport({ width: 1440, height: 900 });
  await desktopBrowser.waitFor(`!!document.querySelector('.pwa-pill[data-kind="install"]')`, 4000);
  assert.equal(await desktopBrowser.eval(`!!document.querySelector('.pwa-banner')`), false,
    'the card survived the window becoming wide');

  // × is this notice's "Not now": two weeks of quiet, like the card's.
  await desktopBrowser.eval(`document.querySelector('.pwa-pill[data-kind="install"] .pwa-pill-dismiss').click()`);
  await desktopBrowser.waitFor(`!document.querySelector('.pwa-pill[data-kind="install"]')`, 3000);
  const until = await desktopBrowser.eval(`Number(localStorage.getItem('sonora.pwa.install-snoozed-until'))`);
  const days = (until - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days < 14.1, `snooze is ${days.toFixed(2)} days, expected 14`);

  // And a page load during the snooze stays quiet.
  await fire('accepted');
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(await desktopBrowser.eval(
    `!!document.querySelector('.pwa-pill[data-kind="install"], .pwa-banner')`), false,
  'the desktop notice ignored its own snooze');
});

test('a manifest shortcut lands on the page it names', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // The app routes in memory, so the shortcut's ?page= is translated by pwa.js
  // into the same click a user would make. Sign in first (this server has its
  // own throwaway database) so the nav actually renders.
  await browser.eval(`fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
  }).then((response) => response.ok)`);

  await browser.goto(`${BASE}/?page=search`);
  // Judge the *settled* app, not the first frame: the shortcut is consumed
  // while app.js is still booting, and it used to replace the URL with the bare
  // pathname — which discarded the `#/search` route the click had just pushed,
  // so boot's own route read found nothing and landed on Home a beat later.
  // Waiting only for a transient `.active` passed straight through that bug.
  await browser.waitFor(`!!document.getElementById('primary-search')`, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const landed = await browser.eval(`({
    path: location.pathname, search: location.search, hash: location.hash,
    input: !!document.getElementById('primary-search'), title: document.title,
  })`);
  assert.equal(landed.input, true, `the shortcut did not open Search (at ${landed.hash}: ${landed.title})`);
  assert.equal(landed.hash, '#/search', 'the shortcut discarded the route it produced');
  assert.match(landed.title, /^Search/);
  assert.equal(landed.path, '/');
  assert.equal(landed.search, '', 'the shortcut left its query string on the URL');
});

test('a collection shortcut lands on the collection it names', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await browser.eval(`fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
  }).then((response) => response.ok)`);

  await browser.goto(`${BASE}/?collection=liked`);
  await browser.waitFor(`location.hash === '#/c/liked'`, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const landed = await browser.eval(`({ hash: location.hash, search: location.search,
    title: document.title, home: !!document.querySelector('.mobile-nav button[data-page="home"].active') })`);
  assert.equal(landed.hash, '#/c/liked', 'the collection shortcut opened the wrong page');
  assert.match(landed.title, /liked/i);
  assert.equal(landed.home, false);
  assert.equal(landed.search, '');
});

test('an idle page takes a waiting update itself; a playing one is asked', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  const proxyPort = await freePort();
  const proxy = updateProxy(BASE);
  await proxy.listen(proxyPort);
  const origin = `http://127.0.0.1:${proxyPort}`;

  // A separate profile: this worker's lifecycle must not disturb the one the
  // offline tests above depend on.
  updateBrowser = await launch(await freePort());
  try {
    await updateBrowser.goto(`${origin}/`);
    await updateBrowser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
    await updateBrowser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
    await updateBrowser.waitFor(`${shellPaths}.then((paths) => !!paths && paths.includes('/'))`, 30000);

    // Ship a new build. The page is idle (visible, nothing playing), so it must
    // accept the update by itself and reload — no pill, no tap. Three rounds of
    // device reports arrived from phones still running replaced builds because
    // the pill waited for a tap that never came.
    proxy.setVersion('v9');
    await updateBrowser.eval(`window.__beforeUpdate = true`);
    await updateBrowser.eval(`navigator.serviceWorker.getRegistration().then((registration) => registration.update())`);
    // A `window` marker disappears the moment the old document is replaced, which
    // is well before the new one has parsed: the assertions below read `#audio`
    // and the player, so wait for the document they actually need. (Under load
    // this ran against a partially parsed page and `Object.defineProperty` got a
    // null element.)
    await updateBrowser.waitFor(`window.__beforeUpdate === undefined`, 30000);
    await updateBrowser.waitFor(
      `document.readyState === 'complete' && !!document.getElementById('audio')`, 20_000,
    );

    const after = await updateBrowser.eval(`(async () => ({
      caches: await caches.keys(),
      controlled: !!navigator.serviceWorker.controller,
      pill: !!document.querySelector('.pwa-pill[data-kind="update"]'),
    }))()`);
    assert.ok(after.caches.includes('sonora-shell-v9'), `new worker not active: ${after.caches.join(', ')}`);
    assert.ok(!after.caches.includes('sonora-shell-v1'), 'the old shell cache was not cleaned up');
    assert.equal(after.controlled, true);
    assert.equal(after.pill, false, 'the update pill survived the reload');

    // While music is playing the page must NOT reload under the listener: the
    // pill appears instead, and the tap stays the listener's decision.
    await updateBrowser.eval(`(() => {
      const a = document.getElementById('audio');
      Object.defineProperty(a, 'paused', { configurable: true, get: () => false });
      return true;
    })()`);
    proxy.setVersion('v10');
    await updateBrowser.eval(`navigator.serviceWorker.getRegistration().then((registration) => registration.update())`);
    await updateBrowser.waitFor(`!!document.querySelector('.pwa-pill[data-kind="update"]')`, 20000);
    const pill = await updateBrowser.eval(`(() => {
      const el = document.querySelector('.pwa-pill[data-kind="update"]');
      return {
        text: el.textContent,
        action: el.querySelector('.pwa-pill-action')?.textContent,
        role: el.getAttribute('role'),
      };
    })()`);
    assert.match(pill.text, /New version available/);
    assert.equal(pill.action, 'Refresh');
    assert.equal(pill.role, 'status', 'the update notice is not announced');
    await updateBrowser.eval(`window.__beforeUpdate2 = true`);
    await updateBrowser.eval(`document.querySelector('.pwa-pill[data-kind="update"] .pwa-pill-action').click()`);
    await updateBrowser.waitFor(`window.__beforeUpdate2 === undefined`, 20000);
    await updateBrowser.waitFor(
      `document.readyState === 'complete' && !!document.getElementById('audio')`, 20_000,
    );
    const after2 = await updateBrowser.eval(`(async () => ({ caches: await caches.keys() }))()`);
    assert.ok(after2.caches.includes('sonora-shell-v10'), `tap did not reach v10: ${after2.caches.join(', ')}`);
  } finally {
    await updateBrowser?.close(); updateBrowser = null;
    proxy.close();
  }
});

test('a transient pause while playing does not reload the page under the song', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // The device failure this pins: iOS emits pause/play blips during the audio
  // session resume handshake, and an auto-accept that acted on the blip
  // reloaded the page under a song that was audibly playing — the Now Playing
  // widget cycling and the app coming up blank. A play() inside the idle
  // window must cancel the pending acceptance.
  const proxyPort = await freePort();
  const proxy = updateProxy(BASE);
  await proxy.listen(proxyPort);
  const origin = `http://127.0.0.1:${proxyPort}`;

  updateBrowser = await launch(await freePort());
  try {
    await updateBrowser.goto(`${origin}/`);
    await updateBrowser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
    await updateBrowser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
    await updateBrowser.waitFor(`${shellPaths}.then((paths) => !!paths && paths.includes('/'))`, 30000);

    // Playing, then a pause blip, then playing again — all before the settled
    // idle window can elapse.
    await updateBrowser.eval(`(() => {
      const a = document.getElementById('audio');
      let paused = false;
      Object.defineProperty(a, 'paused', { configurable: true, get: () => paused });
      window.__setPaused = (v) => { paused = v; a.dispatchEvent(new Event(v ? 'pause' : 'play')); };
      window.__stillHere = true;
      return true;
    })()`);
    proxy.setVersion('v11');
    await updateBrowser.eval(`navigator.serviceWorker.getRegistration().then((registration) => registration.update())`);
    await new Promise((r) => setTimeout(r, 1500));
    await updateBrowser.eval(`window.__setPaused(true)`);   // the blip
    await new Promise((r) => setTimeout(r, 1200));
    await updateBrowser.eval(`window.__setPaused(false)`);  // resume before 5 s settle
    await new Promise((r) => setTimeout(r, 6000));          // longer than the idle window
    const alive = await updateBrowser.eval(`window.__stillHere === true`);
    assert.equal(alive, true, 'the page reloaded during a transient pause');
  } finally {
    await updateBrowser?.close(); updateBrowser = null;
    proxy.close();
  }
});

test('a page that booted from an update reload never auto-reloads again', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // The other half of the storm: if SKIP_WAITING/claim races leave a waiting
  // worker visible to the freshly reloaded page, accepting again would bounce
  // the listener through load after load. One automatic reload per storm is
  // the ceiling; after that only the pill (a human tap) can reload.
  const proxyPort = await freePort();
  const proxy = updateProxy(BASE);
  await proxy.listen(proxyPort);
  const origin = `http://127.0.0.1:${proxyPort}`;

  updateBrowser = await launch(await freePort());
  try {
    await updateBrowser.goto(`${origin}/`);
    await updateBrowser.waitFor(`navigator.serviceWorker.ready.then(() => true)`, 20000);
    await updateBrowser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
    await updateBrowser.waitFor(`${shellPaths}.then((paths) => !!paths && paths.includes('/'))`, 30000);
    // Mark this page as the product of an update reload that happened seconds
    // ago — exactly the state of a page inside a reload chain.
    await updateBrowser.eval(`sessionStorage.setItem('${STORM_KEY}', String(Date.now()))`);
    await updateBrowser.goto(`${origin}/?storm=1`);
    await updateBrowser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
    await updateBrowser.eval(`window.__stillHere2 = true`);
    proxy.setVersion('v12');
    await updateBrowser.eval(`navigator.serviceWorker.getRegistration().then((registration) => registration.update())`);
    await new Promise((r) => setTimeout(r, 9000)); // well past any idle window
    const alive = await updateBrowser.eval(`window.__stillHere2 === true`);
    assert.equal(alive, true, 'a storm-booted page auto-reloaded again');
  } finally {
    await updateBrowser?.close(); updateBrowser = null;
    proxy.close();
  }
});

test('a takeover another tab released offers the pill but reloads nothing', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // The multi-tab bug: tab B taps Refresh, its SKIP_WAITING activates the worker
  // and the browser claims tab A too. A's controllerchange carries
  // acceptingUpdate === false, and the storm guard is sessionStorage — per tab —
  // so A used to decide it was stale and auto-reload itself, stopping music it
  // never asked to stop. The release marker is the shared signal that this
  // takeover belongs to someone else. This test dispatches the same
  // controllerchange the browser would, with the marker a releasing sibling
  // leaves behind, and watches the real idle window.
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`navigator.serviceWorker.controller !== null`, 20000);
  assert.ok(RELEASE_KEY, 'pwa.js has no cross-tab release key');
  try {
    // Give wireUpdates time to attach its listener after the worker registers.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await browser.eval(`(() => {
      localStorage.setItem('${RELEASE_KEY}', String(Date.now()));
      sessionStorage.removeItem('${STORM_KEY}');
      window.__aliveAcrossRelease = true;
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
      return true;
    })()`);
    // The stale document is still offered the fix...
    await browser.waitFor(`!!document.querySelector('.pwa-pill[data-kind="reload"]')`, 5000);
    // ...but must not take it itself: STABLE_IDLE_MS plus slack.
    await new Promise((resolve) => setTimeout(resolve, 7000));
    const state = await browser.eval(`({
      alive: window.__aliveAcrossRelease === true,
      pill: !!document.querySelector('.pwa-pill[data-kind="reload"]'),
    })`);
    assert.equal(state.alive, true, 'a takeover another tab released auto-reloaded this page');
    assert.equal(state.pill, true, 'the page kept stale code and stopped offering the reload');
  } finally {
    await browser.eval(`localStorage.removeItem('${RELEASE_KEY}')`).catch(() => {});
    // Leave a clean document for the tests after this one.
    await browser.goto(`${BASE}/`).catch(() => {});
  }
});

test('icons are real bitmaps and the maskable mark stays in the safe zone', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  const icons = await browser.eval(`(async () => {
    const files = ['/icons/icon-96.png', '/icons/icon-180.png', '/icons/icon-192.png',
      '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/icon-512-transparent.png'];
    const out = {};
    for (const file of files) {
      const img = new Image();
      img.src = file;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      out[file] = {
        w: img.naturalWidth,
        h: img.naturalHeight,
        corner: px(2, 2),
        middle: px(img.naturalWidth >> 1, img.naturalHeight >> 1),
      };
    }
    return out;
  })()`);

  const expected = {
    '/icons/icon-96.png': 96,
    '/icons/icon-180.png': 180,
    '/icons/icon-192.png': 192,
    '/icons/icon-512.png': 512,
    '/icons/icon-maskable-512.png': 512,
    '/icons/icon-512-transparent.png': 512,
  };
  for (const [file, size] of Object.entries(expected)) {
    assert.equal(icons[file].w, size, `${file} width`);
    assert.equal(icons[file].h, size, `${file} height`);
  }

  // The rounded plate has transparent corners; apple-touch must not (iOS
  // composites transparency onto black).
  assert.equal(icons['/icons/icon-192.png'].corner[3], 0, 'the rounded icon has no transparency');
  assert.equal(icons['/icons/icon-512.png'].corner[3], 0, 'the rounded icon has no transparency');
  assert.equal(icons['/icons/icon-180.png'].corner[3], 255, 'apple-touch-icon is transparent');
  assert.equal(icons['/icons/icon-maskable-512.png'].corner[3], 255, 'maskable icon is transparent');
  // The plate is coral, not the old purple placeholder.
  const [r, g, b] = icons['/icons/icon-192.png'].middle;
  assert.ok(r > 235 && g > 120 && g < 185 && b > 90 && b < 165,
    `icon centre is rgb(${r},${g},${b}), expected coral`);

  const zone = await browser.eval(`(async () => {
    const img = new Image();
    img.src = '/icons/icon-maskable-512.png';
    await img.decode();
    const n = img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, n, n);
    const luma = (x, y) => { const i = (y * n + x) * 4;
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; };
    const alpha = (x, y) => data[(y * n + x) * 4 + 3];

    // Chrome's maskable safe zone: the centre circle, radius 40% of the icon.
    const safe = n * 0.4;
    let outside = 0, transparent = 0, samples = 0;
    for (let radius = Math.ceil(safe) + 2; radius < n / 2; radius += 3) {
      for (let angle = 0; angle < 360; angle += 5) {
        const x = Math.round(n / 2 + Math.cos(angle * Math.PI / 180) * radius);
        const y = Math.round(n / 2 + Math.sin(angle * Math.PI / 180) * radius);
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        samples++;
        if (luma(x, y) < 110) outside++;
        if (alpha(x, y) < 250) transparent++;
      }
    }
    let inkInside = 0;
    for (let x = Math.round(n * 0.3); x < n * 0.7; x++) {
      if (luma(x, n / 2) < 110) inkInside++;
    }
    return { n, safe, samples, outside, transparent, inkInside };
  })()`);

  assert.ok(zone.samples > 1000, 'not enough samples to trust the check');
  assert.equal(zone.outside, 0, `${zone.outside} mark pixels sit outside the r=${zone.safe} safe zone`);
  assert.equal(zone.transparent, 0, 'the maskable background is not opaque');
  assert.ok(zone.inkInside > 20, 'the maskable icon has no visible mark');

  // Four shortcuts, four different glyphs: the launcher menu must say where each
  // one goes, not repeat the same brand mark four times.
  const glyphs = await browser.eval(`(async () => {
    const files = ['/icons/shortcuts/wave.png', '/icons/shortcuts/search.png',
      '/icons/shortcuts/heart.png', '/icons/shortcuts/radio.png'];
    const out = {};
    for (const file of files) {
      const img = new Image();
      img.src = file;
      await img.decode();
      const n = img.naturalWidth;
      const canvas = document.createElement('canvas');
      canvas.width = n;
      canvas.height = n;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, n, n);
      let ink = 0;
      let signature = '';
      for (let y = 0; y < n; y += 4) {
        for (let x = 0; x < n; x += 4) {
          const i = (y * n + x) * 4;
          const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          if (luma < 110) { ink++; signature += '1'; } else signature += '0';
        }
      }
      out[file] = { ink, signature };
    }
    return out;
  })()`);
  const signatures = new Set();
  for (const [file, glyph] of Object.entries(glyphs)) {
    assert.ok(glyph.ink > 20, `${file} has no visible glyph`);
    signatures.add(glyph.signature);
  }
  assert.equal(signatures.size, 4, 'the shortcut icons draw the same glyph');
});

test('a shortcut query handed to the running window is honoured without a reload', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // launch_handler: focus-existing focuses the live window instead of loading a
  // document, so pwa.js's init-time read of location.search cannot be the only
  // one. The listener here is the fallback for a query that lands by focus.
  await browser.eval(`fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
  }).then((response) => response.ok)`);
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('[data-page="search"]')`, 15_000);
  await browser.eval(`(() => {
    window.__focusAlive = true;
    history.replaceState(null, '', '/?page=search');
    window.dispatchEvent(new Event('focus'));
    return true;
  })()`);
  await browser.waitFor(`location.hash === '#/search'`, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const landed = await browser.eval(`({
    alive: window.__focusAlive === true,
    hash: location.hash,
    search: location.search,
    input: !!document.getElementById('primary-search'),
  })`);
  assert.equal(landed.alive, true, 'a focus-launched shortcut reloaded the document (and stopped the music)');
  assert.equal(landed.hash, '#/search');
  assert.equal(landed.search, '', 'the focus-launched shortcut left its query string behind');
  assert.equal(landed.input, true, 'the focus-launched shortcut did not open Search');
});

test('the offline page retry button says it is retrying', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.goto(`${BASE}/offline.html`);
  const state = await browser.eval(`(() => {
    window.__retryProbe = true;
    const button = document.getElementById('retry');
    button.click();
    return { disabled: button.disabled, label: button.textContent };
  })()`);
  assert.equal(state.disabled, true, 'the retry button stays enabled while the reload is in flight');
  assert.match(state.label, /Retrying/);
  // It really reloads: the probe is gone once the fresh document is up.
  await browser.waitFor(`window.__retryProbe === undefined`, 5000);
});

// The iOS hint is a separate browser because it needs an iPhone user agent
// before the first document loads, and that must not leak into the other tests.
test('iOS Safari offers a Home Screen sheet that is keyboard operable', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  iosBrowser = await launch(await freePort());
  await iosBrowser.addInitScript(`
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    });
    // Headless Chromium considers this app installable and fires a real
    // beforeinstallprompt; on iOS that event does not exist, so swallow it and
    // let the Safari path be the only thing under test.
    window.addEventListener('beforeinstallprompt', (event) => event.stopImmediatePropagation(), true);
  `);
  await iosBrowser.goto(`${BASE}/`);
  await iosBrowser.eval(`localStorage.removeItem('sonora.pwa.install-snoozed-until')`);

  // The banner waits for an interaction (or six seconds), never the first paint.
  await new Promise((r) => setTimeout(r, 2700));
  await iosBrowser.eval(`window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await iosBrowser.waitFor(`!!document.querySelector('.pwa-banner')`, 5000);

  const text = await iosBrowser.eval(`document.querySelector('.pwa-banner').textContent`);
  assert.match(text, /Home Screen/);
  assert.deepEqual(
    await iosBrowser.eval(`[...document.querySelectorAll('.pwa-banner button')].map((b) => b.textContent)`),
    ['How', 'Not now'],
  );

  // "How" opens the sheet and moves focus into it.
  await iosBrowser.eval(`document.querySelector('.pwa-banner .pwa-banner-btn.primary').click()`);
  await iosBrowser.waitFor(`!!document.querySelector('.pwa-sheet')`, 3000);
  const sheet = await iosBrowser.eval(`(() => {
    const dialog = document.querySelector('.pwa-sheet');
    return {
      role: dialog.getAttribute('role'),
      modal: dialog.getAttribute('aria-modal'),
      title: document.getElementById('pwa-sheet-title')?.textContent,
      focus: document.activeElement?.className,
      backdrop: !!document.querySelector('.pwa-sheet-backdrop'),
      steps: dialog.querySelectorAll('.pwa-step').length,
    };
  })()`);
  assert.equal(sheet.role, 'dialog');
  assert.equal(sheet.modal, 'true');
  assert.match(sheet.title, /Add sonora to your Home Screen/);
  assert.equal(sheet.steps, 3);
  assert.match(sheet.focus, /pwa-sheet-close/, 'focus did not move into the dialog');

  // Escape closes it and returns focus to the button that opened it.
  await iosBrowser.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await iosBrowser.waitFor(`!document.querySelector('.pwa-sheet')`, 3000);
  const returned = await iosBrowser.eval(`({
    focus: document.activeElement?.textContent,
    sheet: !!document.querySelector('.pwa-sheet'),
  })`);
  assert.equal(returned.sheet, false);
  assert.equal(returned.focus, 'How', 'focus was not restored to the trigger');

  // And the banner still snoozes like the Chromium one.
  await iosBrowser.eval(`document.querySelector('.pwa-banner .pwa-banner-btn.ghost').click()`);
  await iosBrowser.waitFor(`!document.querySelector('.pwa-banner')`, 3000);
  const until = await iosBrowser.eval(`Number(localStorage.getItem('sonora.pwa.install-snoozed-until'))`);
  assert.ok(until > Date.now() + 13 * 86_400_000);
});

test('the offline page reloads itself the moment the connection returns', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.goto(`${BASE}/offline.html`);
  // A marker on `window` cannot survive a document load, so its disappearance
  // is the proof that the `online` event really reloaded the page (and not
  // that something merely repainted).
  await browser.eval(`(() => { window.__offlineDoc = true; return true; })()`);
  await browser.eval(`window.dispatchEvent(new Event('online'))`);
  await browser.waitFor(`window.__offlineDoc === undefined`, 10_000);
  const after = await browser.eval(`({
    title: document.title,
    retry: !!document.getElementById('retry'),
  })`);
  assert.match(after.title, /offline|sonora/i, 'the reload landed on a real document');
  assert.equal(after.retry, true, 'and it is the same offline page (this origin is still answering)');
});

test('a boot whose module never loads says so instead of showing a blank app', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // A fresh profile, so /app.js is a real network request (no worker, no HTTP
  // cache), and that request is refused: the document paints its skeleton and
  // nothing else ever runs. This is the state a half-evicted offline cache
  // leaves a phone in.
  const dead = await launch(await freePort());
  try {
    await dead.send('Network.enable');
    await dead.send('Network.setBlockedURLs', { urls: ['*app.js*'] });
    await dead.goto(`${BASE}/`);
    await dead.waitFor(`document.getElementById('boot-recovery')?.hidden === false`, 20_000);
    const banner = await dead.eval(`(() => {
      const box = document.getElementById('boot-recovery');
      return {
        text: box.textContent.replace(/\\s+/g, ' ').trim(),
        role: box.getAttribute('role'),
        reload: document.getElementById('boot-recovery-reload')?.getAttribute('href'),
        app: !!document.querySelector('#mobile-nav button'),
      };
    })()`);
    assert.match(banner.text, /did not finish loading/i, 'the banner names the failure');
    assert.equal(banner.role, 'alert', 'it is announced, not just drawn');
    assert.equal(banner.reload, '/', 'and it carries a reload that needs no script');
    assert.equal(banner.app, false, 'the module really did not run');
  } finally {
    dead.close();
  }
});

test('a browser that refuses localStorage still boots and can sign out', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // Safari private mode (and a blocked-cookies profile) throws on every write
  // to localStorage. Every write in the app is already wrapped; this is the
  // behavioural proof, because the failure mode is silent — one unwrapped
  // removeItem in the sign-out path and the user is left signed in with the
  // next account's settings in place, or a click that does nothing at all.
  const priv = await launch(await freePort());
  try {
    await priv.addInitScript(`
      for (const method of ['setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function () {
          if (this === window.localStorage) {
            const err = new Error('QuotaExceededError: storage is disabled');
            err.name = 'QuotaExceededError';
            throw err;
          }
          return original.apply(this, arguments);
        };
      }
    `);
    await priv.goto(`${BASE}/`);
    const status = await priv.eval(`fetch('/api/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
    assert.equal(status, 200, 'this profile can sign in');
    await priv.goto(`${BASE}/?priv=${Date.now()}`);
    await priv.waitFor(`!!document.querySelector('#mobile-nav button')
      && document.getElementById('auth-overlay').hidden === true`, 20_000);
    assert.equal(await priv.eval(`document.getElementById('auth-overlay').hidden`), true,
      'the app boots with a storage that throws on every write');

    // Sign out through the real button: the account-scoped cleanup runs before
    // the reload, and a throw there would leave the marker (and this page) up.
    await priv.eval(`(() => { window.__beforeSignOut = true; return true; })()`);
    await priv.eval(`document.querySelector('[data-action="logout"]').click()`);
    await priv.waitFor(`window.__beforeSignOut === undefined`, 15_000);
    await priv.waitFor(`document.getElementById('auth-overlay').hidden === false`, 15_000);
    const after = await priv.eval(`({
      overlay: document.getElementById('auth-overlay').hidden,
      form: !!document.getElementById('auth-form'),
      nav: !!document.querySelector('#mobile-nav button'),
    })`);
    assert.equal(after.overlay, false, 'the reload did not land on the sign-in screen');
    assert.equal(after.form, true, 'and the sign-in form is painted');
    assert.equal(after.nav, false, 'a signed-out page must not paint the signed-in navigation');
  } finally {
    priv.close();
  }
});

// The browser lane above must actually run on a machine that claims to be a
// browser-capable test host. A Chrome-less box silently skips 15+ tests while
// reporting the file green — this is the machine-level assertion that keeps
// that from lying: found-but-not-launched is a failure, not a skip, and an
// explicit CHROME_BIN likewise means "this host promised a browser".
test('the browser lane really ran (or the host said so honestly)', () => {
  if (browser) return;
  if (CHROME) {
    throw new Error(`CHROME was found (${CHROME}) but the browser did not launch — the browser lane above skipped silently`);
  }
  t: {
    // No browser anywhere: only acceptable when the host never promised one.
    if (!process.env.CI && !process.env.CHROME_BIN) return;
    throw new Error('CI/CHROME_BIN declared a browser-capable host but no Chromium was found or launched');
  }
});
