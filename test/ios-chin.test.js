import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';

// The iOS home-screen "chin".
//
// Installed to the iOS home screen (apple-mobile-web-app-capable, i.e.
// navigator.standalone === true) WebKit can report a *layout viewport* that is
// shorter than the physical screen. The safe-area strip it refuses to hand back
// becomes a dead band under the last row — under the bottom nav on a phone,
// which reads as a big chin dodging the home indicator / search bar.
//
// The bug is a disagreement between two numbers: `100dvh` (and innerHeight)
// come back short by env(safe-area-inset-top), while `screen.height` stays
// honest. So the fix publishes screen.height as `--app-h` from a boot script and
// `.app` prefers it. Two things have to hold:
//   1. `.app` is exactly as tall as the screen, and the document still never
//      scrolls.
//   2. The extra height must not let the nav slide under the home indicator,
//      and must not apply where the shortfall is not a safe-area strip — Safari
//      (browser chrome owns that space), an open keyboard, or a resized window.
//
// Guarding the fix is as important as the fix: a wrong override is a worse bug
// than a chin, so every "do not touch it" case is tested too.

const ROOT = new URL('..', import.meta.url).pathname;
const CSS = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const OFFLINE = fs.readFileSync(path.join(ROOT, 'public/offline.html'), 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-chin-'));

let server;
let browser;
let BASE;

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(TMP, 'test.db'), SONORA_AUDIO_DIR: path.join(TMP, 'audio'),
      SONORA_SECRET: 'chin-secret', SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
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
  if (CHROME) browser = await launch(await freePort());
});

after(() => {
  browser?.close();
  server?.kill('SIGTERM');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ── the boot script ───────────────────────────────────────────────────────

const bootScript = (source) => source.match(/<script>\/\* --app-h[\s\S]*?<\/script>/)?.[0];

test('both documents boot the same --app-h script, before any stylesheet', () => {
  const app = bootScript(HTML);
  const offline = bootScript(OFFLINE);
  assert.ok(app, 'index.html has no --app-h boot script');
  assert.equal(offline, app, 'offline.html drifted from index.html; keep the two copies identical');
  // Inline and before the CSS: it must run before the first paint, or the chin
  // is visible for a frame and the layout is measured wrong.
  assert.ok(HTML.indexOf(app) < HTML.indexOf('<link rel="stylesheet" href="/app.css">'),
    'the boot script must precede app.css');
  assert.doesNotMatch(app, /src=/, 'the boot script must be inline: a request can be offline or blocked');
});

test('.app takes its height from --app-h, with 100dvh as the fallback', () => {
  const app = CSS.match(/\n\.app\{[^}]*\}/g)?.at(-1) ?? '';
  assert.match(app, /height:var\(--app-h,100dvh\)/,
    '.app must prefer --app-h and fall back to 100dvh');
});

// ── real browser ──────────────────────────────────────────────────────────

/**
 * Pretend to be iOS. Chromium cannot be made to under-report its own viewport,
 * so the *viewport* half of the bug is emulated with device metrics (see the
 * tests below) and this supplies the other half: the honest screen and the
 * `navigator.standalone` flag that only a home-screen app has.
 *
 * Returns a disposer — Chromium keeps init scripts for the life of the page, so
 * every test removes its own rather than leaking emulation into the next.
 */
async function installIos({ screenWidth, screenHeight, standalone = true }) {
  return browser.addInitScript(`
    Object.defineProperty(Navigator.prototype, 'standalone', { get: () => ${standalone}, configurable: true });
    Object.defineProperty(Screen.prototype, 'height', { get: () => ${screenHeight}, configurable: true });
    Object.defineProperty(Screen.prototype, 'width', { get: () => ${screenWidth}, configurable: true });
  `);
}

const geometry = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
  };
  const probe = (prop) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(' + prop + ',0px)';
    document.body.appendChild(d);
    const h = Math.round(d.getBoundingClientRect().height);
    d.remove();
    return h;
  };
  return {
    screenH: screen.height,
    innerH: window.innerHeight,
    root: box('html'),
    body: box('body'),
    appH: box('.app'),
    nav: box('.mobile-nav'),
    navBtn: box('.mobile-nav button'),
    player: box('.player'),
    overlay: (() => {
      const el = document.querySelector('#auth-overlay');
      if (!el) return null;
      const wasHidden = el.hidden;
      el.hidden = false;
      const r = el.getBoundingClientRect();
      const box = { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
      el.hidden = wasHidden;
      return box;
    })(),
    sab: probe('safe-area-inset-bottom'),
    appVar: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
    docOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  };
})()`;

/** Log in once per test, then reload so the app boots authenticated. */
async function loginAndOpen(viewport) {
  await browser.iphone(viewport);
  await browser.goto(`${BASE}/`);
  await browser.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name:'toil',passphrase:'hunter2hunter2'})}).then(r=>r.status)`);
  await browser.goto(`${BASE}/`);
  await browser.iphone(viewport);
  await browser.waitFor(`!!document.querySelector('.mobile-nav button')`);
  await new Promise((r) => setTimeout(r, 250));
}

// The measured WebKit behaviour (bugs.webkit.org 254868): a phone with a 59px
// island reports a layout viewport 59px short; a classic phone with a 20px
// status bar reports 20px short. screen.height is correct in both cases.
const DEVICES = [
  { name: 'iPhone 15 Pro (59px short)', screenWidth: 393, screenHeight: 852, short: 59,
    insets: { width: 393, height: 852, top: 59, bottom: 34 } },
  { name: 'iPhone SE (20px short)', screenWidth: 375, screenHeight: 667, short: 20,
    insets: { width: 375, height: 667, top: 20, bottom: 0 } },
];

for (const d of DEVICES) {
  test(`${d.name}: the shell fills the screen instead of leaving a chin`, async (t) => {
    if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

    t.after(await installIos(d));
    // The layout viewport is short, the screen is not. That disagreement is the
    // whole bug, reproduced exactly.
    const reported = { ...d.insets, height: d.screenHeight - d.short };
    await loginAndOpen(reported);

    // ── cold start: the viewport is short, the shell is not ───────────────
    const cold = await browser.eval(geometry);
    const limit = d.screenHeight - d.insets.bottom;

    assert.equal(cold.screenH, d.screenHeight, 'test setup: screen.height must report the real screen');
    assert.equal(cold.sab, d.insets.bottom, 'test setup: the browser must report the emulated bottom inset');
    assert.equal(cold.innerH, d.screenHeight - d.short, 'test setup: the layout viewport must be the short one');

    // The regression: before the fix .app was as tall as the *reported*
    // viewport, so it stopped `short` px above the screen and the gap showed.
    assert.equal(cold.appH.height, d.screenHeight,
      `.app is ${cold.appH.height}px tall on an ${d.screenHeight}px screen: a ${d.screenHeight - cold.appH.height}px chin`);

    // A taller .app inside a `height:100%` root chain is simply clipped back to
    // the short viewport, which looks exactly like the chin. The root elements
    // have to grow with it — this is the bug that survived the first attempt.
    assert.equal(cold.root.height, d.screenHeight,
      `html is ${cold.root.height}px tall and clips the shell at the reported viewport`);
    assert.equal(cold.body.height, d.screenHeight,
      `body is ${cold.body.height}px tall and clips the shell at the reported viewport`);

    // The shell now asks for more than the short viewport, and that overflow is
    // the signal WebKit acts on: it re-measures and grows the viewport to fit.
    assert.equal(cold.docOverflow, d.short,
      'the shell must overflow the under-reported viewport, which is what makes WebKit re-measure');

    // ── docked: WebKit has re-measured, the viewport is the screen ────────
    // Emulate that recalculation (it is a viewport change, so this also
    // exercises the boot script's resize re-sync).
    await browser.iphone(d.insets);
    await new Promise((r) => setTimeout(r, 200));

    const m = await browser.eval(geometry);
    assert.equal(m.innerH, d.screenHeight, 'the viewport must end up as tall as the screen');
    assert.equal(m.appH.height, d.screenHeight, 'the shell fills the screen');
    assert.equal(m.appH.bottom, d.screenHeight, 'the shell reaches the bottom of the screen');
    assert.equal(m.docOverflow, 0, 'the document must not scroll: iOS rubber-banding shifts the whole UI');

    // Filling the screen must not have been done by letting the last row slide
    // under the home indicator, and the rows must stay flush with each other.
    assert.equal(m.nav.bottom, d.screenHeight, 'the nav paints into the safe area, it does not stop short of it');
    assert.ok(m.navBtn.bottom <= limit,
      `nav label ends at ${m.navBtn.bottom}px, past the home indicator limit ${limit}px`);
    assert.equal(m.player.bottom, m.nav.top, 'the player bar and the nav must stay flush');

    // Full-screen sheets are fixed insets, so they meet the same short viewport.
    // #auth-overlay is hidden once signed in, and a hidden box measures 0.
    assert.equal(m.overlay.height, d.screenHeight, 'a full-screen overlay must also reach the screen bottom');
  });
}

test('when the shell still cannot reach the bottom, the app says so with numbers', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // The fallback for a device this fix does not cover: a labelled gap can be
  // finished in one screenshot, a silent one costs another round trip. The pill
  // must appear exactly when the shell is clipped and never otherwise.
  t.after(await installIos({ screenWidth: 393, screenHeight: 852 }));
  await loginAndOpen({ width: 393, height: 852, top: 59, bottom: 34 });

  const clean = await browser.eval(`!!document.querySelector('.pwa-pill[data-kind="chin"]')`);
  assert.equal(clean, false, 'a shell that reaches the bottom must not raise the self-check');

  // Now reproduce the clipped case: the root chain capped at the short viewport.
  const pill = await browser.eval(`(async () => {
    const style = document.createElement('style');
    style.textContent = 'html,body{height:793px!important}';
    document.head.append(style);
    window.dispatchEvent(new Event('resize'));
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector('.pwa-pill[data-kind="chin"]');
      if (el) return el.querySelector('.pwa-pill-text').textContent;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  })()`);
  assert.ok(pill, 'a clipped shell must raise the self-check pill');
  assert.match(pill, /\b793px of 852px\b/, `the pill must report both heights, got: ${pill}`);
  assert.match(pill, /\b59px short\b/, `the pill must report the shortfall, got: ${pill}`);
});

test('the self-check is iOS-standalone only', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // Everywhere else screen.height is the display, not this window, so the check
  // would fire on healthy Android and split-screen layouts. It must stay quiet.
  t.after(await installIos({ screenWidth: 393, screenHeight: 852, standalone: false }));
  await loginAndOpen({ width: 393, height: 852, top: 59, bottom: 34 });

  const raised = await browser.eval(`(async () => {
    const style = document.createElement('style');
    style.textContent = 'html,body{height:700px!important}';
    document.head.append(style);
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 300));
    return !!document.querySelector('.pwa-pill[data-kind="chin"]');
  })()`);
  assert.equal(raised, false, 'only an installed iOS app may raise the self-check');
});

test('Safari is untouched: browser chrome owns that space', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // Same short viewport, but not an installed app. In Safari 100dvh is the
  // correct unit — the toolbar really does cover the difference.
  t.after(await installIos({ screenWidth: 393, screenHeight: 852, standalone: false }));
  await loginAndOpen({ width: 393, height: 852, top: 59, bottom: 34 });

  const m = await browser.eval(geometry);
  assert.equal(m.appVar, '', 'Safari must not get the installed-app height override');
  assert.equal(m.appH.height, 852, 'the shell still fills the viewport exactly');
  assert.equal(m.docOverflow, 0, 'the document must not scroll');
});

test('a keyboard-sized shortfall is not mistaken for a chin', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // iOS shrinks only the *visual* viewport when the keyboard opens. Lifting the
  // shell to screen.height then would push the bottom nav under the keyboard.
  t.after(await installIos({ screenWidth: 393, screenHeight: 852 }));
  await loginAndOpen({ width: 393, height: 852, top: 59, bottom: 34 });

  const res = await browser.eval(`(async () => {
    const root = document.documentElement;
    const before = getComputedStyle(root).getPropertyValue('--app-h').trim();
    const beforeH = Math.round(document.querySelector('.app').getBoundingClientRect().height);
    // Pretend the keyboard opened: only visualViewport.height collapses.
    Object.defineProperty(window.visualViewport, 'height', { get: () => 500, configurable: true });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 80));
    return {
      before, beforeH,
      during: getComputedStyle(root).getPropertyValue('--app-h').trim(),
      duringH: Math.round(document.querySelector('.app').getBoundingClientRect().height),
    };
  })()`);

  // A healthy viewport needs no correction: the shell is already the full height
  // (100vh == 100dvh here), so the keyboard must not change it.
  assert.equal(res.beforeH, 852, 'the shell fills the screen before the keyboard opens');
  assert.equal(res.during, '100vh', 'an open keyboard must not be treated as a chin');
  assert.equal(res.duringH, 852, 'an open keyboard must not resize the shell');
});

test('a shortfall that is not a safe-area strip is left alone', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  // iPad multitasking, a floating window, an embedded webview: all report a
  // viewport far shorter than the screen. Lifting the shell to screen.height
  // there would paint it off the bottom of the window, so the guard refuses.
  t.after(await installIos({ screenWidth: 1024, screenHeight: 1366 }));
  await loginAndOpen({ width: 1024, height: 700, top: 0, bottom: 20 });

  const m = await browser.eval(geometry);
  // 100vh, not screen.height: the 666px gap is a window, not a safe-area strip.
  assert.equal(m.appVar, '100vh', 'a 666px shortfall must not be treated as a chin');
  assert.equal(m.appH.height, 700, 'the shell keeps filling the viewport it was given');
  assert.equal(m.root.height, 700, 'the root chain keeps filling the viewport it was given');
  assert.equal(m.docOverflow, 0, 'the document must not scroll');
});
