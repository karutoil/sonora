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
  '/pwa.css', '/pwa.js', '/manifest.webmanifest', '/offline.html', '/fonts/inter-latin.woff2'];

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
  for (const shot of manifest.screenshots ?? []) {
    assert.ok(fs.existsSync(path.join(PUB, shot.src)), `manifest lists a missing screenshot: ${shot.src}`);
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

// ── service worker ────────────────────────────────────────────────────────

test('service worker precaches the whole shell', () => {
  const list = precacheList();
  for (const url of ['/', ...SHELL]) {
    assert.ok(list.includes(url), `PRECACHE is missing ${url}`);
  }
  // Every published bitmap is part of the shell: a shortcut or an install
  // prompt must not be the first thing to discover a missing icon. The *.svg
  // files are design sources; only icon.svg is referenced at runtime.
  const published = fs.readdirSync(path.join(PUB, 'icons'))
    .filter((file) => file.endsWith('.png') || file === 'icon.svg');
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

// ── real browser ──────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-'));
let server;
let browser;
let iosBrowser;
let desktopBrowser;
let updateBrowser;
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
  const server = http.createServer((req, res) => {
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
  const session = cdp ?? await rawSession(DEBUG_PORT, (target) => target.type === 'page' && target.url.startsWith(BASE));
  cdp = session;

  const workerOffline = await session.offline(true);
  assert.ok(workerOffline, 'no service_worker target found — cannot emulate a real offline device');

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

  // Coming back online recovers by itself.
  await session.offline(false);
  await browser.eval(`window.dispatchEvent(new Event('online'))`);
  await browser.waitFor(`!document.querySelector('.pwa-pill[data-kind="offline"]')`, 6000);
});

test('with no cached shell the worker serves the branded offline page', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  const session = cdp;

  // Simulate a shell that never finished installing (or was evicted).
  await browser.eval(`(async () => {
    const shell = (await caches.keys()).find((name) => name.startsWith('sonora-shell'));
    return shell ? (await caches.open(shell)).delete('/') : false;
  })()`);

  await session.offline(true);
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

  await session.offline(false);
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
  const session = cdp;

  await browser.goto(`${BASE}/`);
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
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  }).then((response) => response.ok)`);

  await browser.goto(`${BASE}/?page=search`);
  await browser.waitFor(`(() => {
    const button = document.querySelector('[data-page="search"]');
    return !!button && (button.matches('.active, [aria-current="page"]') || button.getAttribute('aria-current') === 'page');
  })()`, 15000);
  assert.equal(await browser.eval(`location.pathname`), '/');
});

test('a waiting worker offers Refresh, and the tap reloads into the new build', async (t) => {
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

    // Ship a new build.
    proxy.setVersion('v7');
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

    // Tap Refresh. The worker is released, the page reloads once, and the new
    // cache version proves the new build actually took over.
    await updateBrowser.eval(`window.__beforeUpdate = true`);
    await updateBrowser.eval(`document.querySelector('.pwa-pill[data-kind="update"] .pwa-pill-action').click()`);
    await updateBrowser.waitFor(`window.__beforeUpdate === undefined`, 20000);

    const after = await updateBrowser.eval(`(async () => ({
      caches: await caches.keys(),
      controlled: !!navigator.serviceWorker.controller,
      pill: !!document.querySelector('.pwa-pill[data-kind="update"]'),
    }))()`);
    assert.ok(after.caches.includes('sonora-shell-v7'), `new worker not active: ${after.caches.join(', ')}`);
    assert.ok(!after.caches.includes('sonora-shell-v1'), 'the old shell cache was not cleaned up');
    assert.equal(after.controlled, true);
    assert.equal(after.pill, false, 'the update pill survived the reload');
  } finally {
    proxy.close();
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
