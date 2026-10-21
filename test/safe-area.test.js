import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';

// iOS standalone (home-screen) safe areas.
//
// index.html asks for `viewport-fit=cover` + `black-translucent`, so on iOS the
// page paints edge to edge and the top ~59pt of it sits *behind* the status bar
// and Dynamic Island. That is only correct if every edge-hugging region offsets
// itself by env(safe-area-inset-*). It didn't: the top bar, the now-playing
// sheet's close button and the bottom nav were all drawn under the hardware —
// the close button disappeared behind the island and the sheet's artwork was
// pushed up out of reach. These tests pin the CSS contract *and* drive a real
// browser with real insets, because a static grep cannot see a layout bug.

const ROOT = new URL('..', import.meta.url).pathname;
const CSS = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-safe-'));

let server;
let browser;
let PORT;
let BASE;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: path.join(TMP, 'test.db'), SONORA_AUDIO_DIR: path.join(TMP, 'audio'),
      SONORA_SECRET: 'safe-secret', SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
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

// The devices that matter: two notched iPhones, one classic, one Android.
const DEVICES = [
  { name: 'iPhone 15 Pro', width: 393, height: 852, top: 59, bottom: 34 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, top: 59, bottom: 34 },
  { name: 'iPhone SE', width: 375, height: 667, top: 20, bottom: 0 },
];

// ── static contract ───────────────────────────────────────────────────────
// These run first and need no browser, so a broken stylesheet fails fast with
// a readable message instead of a geometry dump.

test('viewport opts into edge-to-edge layout with a translucent status bar', () => {
  assert.match(HTML, /name="viewport"[^>]*viewport-fit=cover/,
    'without viewport-fit=cover the insets stay 0 and every rule below is inert');
  assert.match(HTML, /apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/);
});

test('safe-area insets are exposed as custom properties', () => {
  assert.match(CSS, /--sat:\s*env\(safe-area-inset-top/, 'missing --sat');
  assert.match(CSS, /--sab:\s*env\(safe-area-inset-bottom/, 'missing --sab');
});

test('the shell offsets itself by the insets instead of painting under them', () => {
  const app = CSS.match(/\n\.app\{[^}]*\}/g)?.at(-1) ?? '';
  assert.match(app, /padding:\s*var\(--sat\)/, '.app must clear the top inset');
  assert.match(app, /calc\(87px \+ var\(--sab\)\)/, 'desktop player row must grow by the bottom inset');
  assert.match(CSS, /\.mobile-nav\{[^}]*height:calc\(67px \+ var\(--sab\)\)/,
    'the mobile nav row must grow by the bottom inset');
});

test('the now-playing sheet keeps its close button clear of the island', () => {
  assert.match(CSS, /\.now-modal \.modal-close\{[^}]*top:calc\(12px \+ var\(--sat\)\)/,
    'close button must be offset by the top inset');
  assert.match(CSS, /\.now-modal\{padding:calc\(64px \+ var\(--sat\)\)/,
    'the full-screen sheet must pad by the real inset, not a guessed value');
});

test('focusing a field cannot leave the window scrolled (iOS keyboard shift)', () => {
  const JS = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(JS, /function pinWindowScroll\(\)/, 'missing the window-scroll pin');
  assert.match(JS, /addEventListener\('focusin'/, 'must react to a field gaining focus');
  assert.match(JS, /addEventListener\('focusout'/, 'must react to the keyboard closing');
});

for (const d of DEVICES) {
  test(`${d.name}: nothing is painted under the notch or home indicator`, async (t) => {
    if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

    await browser.iphone(d);
    await browser.goto(`${BASE}/`);
    // log in, then reload so the app boots authenticated
    await browser.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({name:'toil',passphrase:'hunter2hunter2'})}).then(r=>r.status)`);
    await browser.goto(`${BASE}/`);
    await browser.iphone(d);
    // Device metrics are applied asynchronously by CDP; wait until the mobile
    // layout is actually live (the nav is display:none above 650px, so a
    // zero-height button means "still measuring the old viewport").
    await browser.waitFor(`!!document.querySelector('.mobile-nav button')`);
    await browser.waitFor(
      `document.querySelector('.mobile-nav button').getBoundingClientRect().height > 20
        && Math.abs(document.querySelector('.app').getBoundingClientRect().height - innerHeight) < 1`,
    );

    const m = await browser.eval(`(() => {
      const R = (s) => { const el = document.querySelector(s); if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
      const probe = (prop) => { const p = document.createElement('div');
        p.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(' + prop + ')';
        document.body.appendChild(p); const h = p.getBoundingClientRect().height; p.remove(); return h; };
      return {
        sat: probe('safe-area-inset-top'), sab: probe('safe-area-inset-bottom'),
        standalone: matchMedia('(display-mode:standalone)').matches,
        innerH: innerHeight,
        appH: Math.round(document.querySelector('.app').getBoundingClientRect().height),
        brand: R('.topbar-left'), navBtn: R('.mobile-nav button'),
        docOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      };
    })()`);

    assert.equal(m.sat, d.top, 'browser must report the emulated top inset to CSS');
    assert.equal(m.sab, d.bottom, 'browser must report the emulated bottom inset to CSS');
    assert.equal(m.appH, m.innerH, 'the shell still fills the screen exactly (no gap, no overflow)');
    assert.equal(m.docOverflow, 0, 'the document must not scroll: iOS rubber-banding shifts the UI');

    // The regression: these were 18px/0px from the top, i.e. under the island.
    assert.ok(m.brand.top >= m.sat,
      `top bar starts at ${m.brand.top}px but the notch ends at ${m.sat}px`);
    assert.ok(m.navBtn.bottom <= m.innerH - m.sab + 0.5,
      `nav label ends at ${m.navBtn.bottom}px, past the home indicator limit ${m.innerH - m.sab}px`);
  });

  test(`${d.name}: the now-playing sheet is fully visible and dismissable`, async (t) => {
    if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

    // Same viewport-settled guard as above: measure the sheet only once the
    // emulated device metrics are applied.
    await browser.waitFor(
      `document.querySelector('.mobile-nav button')?.getBoundingClientRect().height > 20
        || innerWidth > 650`,
    );

    // Inject the sheet's real markup; it normally only appears once a track plays.
    await browser.eval(`(() => {
      document.getElementById('now-content').innerHTML = \`
        <button class="modal-close" aria-label="Close player"></button>
        <div class="modal-cover" style="background:#333"></div>
        <div class="modal-content"><span class="eyebrow">NOW PLAYING</span><h2>Creep</h2>
          <p class="byline">Radiohead</p>
          <div class="modal-tabs"><button class="active">Live lyrics</button><button>About</button></div>
          <div class="lyric-lines"><div class="plain">When you were here before\\nYou're just like an angel</div></div>
          <div class="modal-progress"><div class="timebar"><span>0:00</span>
            <input class="range" type="range" style="--percent:0%"><span>3:56</span></div></div>
          <div class="modal-controls"><button class="icon-btn"></button><button class="icon-btn"></button>
            <button class="big-play"></button><button class="icon-btn"></button><button class="icon-btn"></button>
          </div></div>\`;
      const m = document.getElementById('now-content');
      document.getElementById('now-overlay').hidden = false;
      m.scrollTop = 0;
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 250));

    const s = await browser.eval(`(() => {
      const m = document.getElementById('now-content');
      const R = (sel) => { const r = m.querySelector(sel).getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      return { vh: innerHeight, close: R('.modal-close'), cover: R('.modal-cover'),
        controls: R('.modal-controls'), overflow: m.scrollHeight - m.clientHeight };
    })()`);

    assert.ok(s.close.top >= d.top && s.close.bottom <= s.vh,
      `close button spans ${s.close.top}-${s.close.bottom}px, under the notch ending at ${d.top}px`);
    assert.ok(s.close.bottom <= s.cover.top + 0.5,
      `close button overlaps the artwork (ends ${s.close.bottom}, art starts ${s.cover.top})`);
    assert.ok(s.cover.top >= d.top, `artwork top ${s.cover.top}px is under the notch`);
    assert.ok(s.controls.bottom <= s.vh,
      `playback controls end at ${s.controls.bottom}px, below the fold (${s.vh}px)`);
  });

  test(`${d.name}: the window stays pinned at scroll 0 when a field is focused`, async (t) => {
    if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

    const pinned = await browser.eval(`(async () => {
      document.getElementById('now-overlay').hidden = true;
      // A scrolled window is what iOS leaves behind after the keyboard closes;
      // reproduce it, then focus a field and see whether the app puts it back.
      window.scrollTo(0, 40);
      const before = window.scrollY;
      const input = document.createElement('input');
      input.style.cssText = 'position:fixed;bottom:4px;left:4px;width:80px';
      document.body.appendChild(input);
      input.focus();
      await new Promise((r) => setTimeout(r, 60));
      const after = window.scrollY;
      input.blur();
      input.remove();
      return { before, after };
    })()`);

    // The document must not be scrollable at all; the guard is the belt to that
    // braces (iOS can shift the visual viewport even when it is).
    assert.equal(pinned.after, 0,
      `window was left at scrollY=${pinned.after} after focusing a field (was ${pinned.before})`);
  });
}
