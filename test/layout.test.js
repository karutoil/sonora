import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';

// Two layout guarantees that are easy to break and invisible in a diff:
//
//  1. A sprite icon must be *scaled* into its box. Every <symbol> draws in a
//     24x24 space; if the outer <svg> omits `viewBox`, Chromium renders the art
//     at 1:1 and clips anything outside the CSS box. That silently ate the tips
//     of every icon below 24px — the spark lost a point, the monitor lost its
//     stand, the key lost its teeth. Nothing errors; it just looks wrong.
//  2. The account page's vertical rhythm is a grid gap. If the wrapper class is
//     missing, the pills sit on top of the cards and the danger card butts
//     against the grid.
//
// Both are asserted from computed geometry, so they hold for any future markup
// that keeps the same contract.

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-layout-'));

let proc;
let browser;
let BASE;

before(async () => {
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(DIR, 'layout.db'),
      SONORA_AUDIO_DIR: path.join(DIR, 'audio'),
      SONORA_SECRET: 'layout-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn',
      SONORA_POT_PROVIDER: '',
      SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      const h = r.ok ? await r.json() : null;
      if (h?.pid === proc.pid) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (CHROME) {
    browser = await launch(await freePort());
  }
});

after(() => {
  browser?.close();
  proc?.kill('SIGTERM');
  try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

function need(t) {
  if (browser) return true;
  t.skip(CHROME ? 'Chromium did not launch' : 'no Chromium; set CHROME_BIN=/usr/bin/chromium');
  return false;
}

// `getScreenCTM().a` is the horizontal scale applied to the referenced symbol
// content. For a 24-unit viewBox in a W-wide box it must be W/24; a value of 1
// means the art is being drawn unscaled and therefore clipped.
const ICON_PROBE = `(() => {
  const bad = [];
  let checked = 0;
  for (const svg of document.querySelectorAll('svg.ico')) {
    const use = svg.querySelector('use');
    if (!use) continue;
    const r = svg.getBoundingClientRect();
    if (!r.width) continue; // hidden (a closed sheet, an inactive nav item)
    const scale = use.getScreenCTM().a;
    checked++;
    if (Math.abs(scale * 24 - r.width) > 0.75) {
      bad.push({ icon: use.getAttribute('href'), box: Math.round(r.width),
        scale: +scale.toFixed(3), expected: +(r.width / 24).toFixed(3) });
    }
  }
  return { checked, bad };
})()`;

test('on the sign-in screen every sprite icon is scaled into its box', async (t) => {
  if (!need(t)) return;
  await browser.viewport({ width: 1440, height: 900 });
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
  await browser.waitFor(`!document.getElementById('auth-passkey').hidden`, 10_000);

  const { checked, bad } = await browser.eval(ICON_PROBE);
  assert.ok(checked >= 5, `expected the login screen's icons, found ${checked}`);
  assert.deepEqual(bad, [], 'sprite icons must be scaled, not clipped at 1:1');
});

test('every icon in the signed-in app is scaled into its box', async (t) => {
  if (!need(t)) return;
  await browser.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name:'toil',passphrase:'hunter2hunter2',remember:true,deviceId:'ic'})}).then(r=>r.status)`);
  for (const page of ['home', 'library', 'security', 'admin']) {
    await browser.goto(`${BASE}/#/${page}`);
    await browser.waitFor(`!!document.querySelector('#page-root .page-title, #page-root .sec-card')`, 20_000);
    await new Promise((r) => setTimeout(r, 250));
    const { bad, checked } = await browser.eval(ICON_PROBE);
    assert.ok(checked > 8, `${page}: expected icons, saw ${checked}`);
    assert.deepEqual(bad, [], `${page} has clipped icons`);
  }
});

test('the account page keeps a uniform gap between its blocks', async (t) => {
  if (!need(t)) return;
  await browser.goto(`${BASE}/#/security`);
  await browser.waitFor(`!!document.querySelector('.security-page .sec-row')`, 20_000);
  await new Promise((r) => setTimeout(r, 300));

  const geo = await browser.eval(`(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null;
      const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width }; };
    return {
      head: box('.security-page .page-head'),
      column: box('.security-page'),
      pills: box('.security-page .security-session'),
      grid: box('.security-page .security-grid'),
      danger: box('.security-page .sec-danger'),
      page: box('#page-root'),
      gutter: parseFloat(getComputedStyle(document.getElementById('page-root')).paddingLeft),
    };
  })()`);

  for (const key of ['head', 'pills', 'grid', 'danger']) {
    assert.ok(geo[key], `missing block: ${key}`);
  }
  const gap = (a, b) => Math.round(b.top - a.bottom);
  // 16px grid gap, with a pixel of rounding tolerance in either direction.
  for (const [name, value] of [['head→pills', gap(geo.head, geo.pills)],
    ['pills→grid', gap(geo.pills, geo.grid)],
    ['grid→danger', gap(geo.grid, geo.danger)]]) {
    assert.ok(value >= 14 && value <= 18, `${name} gap is ${value}px, expected ~16px`);
  }
  // The column never escapes the page's gutters. The gutter is read from the
  // page itself: it is a responsive custom property, not a literal 28.
  assert.ok(geo.grid.left >= Math.round(geo.page.left + geo.gutter) - 1, 'grid starts inside the gutter');
  assert.ok(geo.grid.right <= Math.round(geo.page.right - geo.gutter) + 1, 'grid ends inside the gutter');
});

test('the two-card grid collapses when the content box is narrow, not when the window is', async (t) => {
  if (!need(t)) return;
  // A 1290px window still shows a 218px sidebar, so the content is ~742px wide.
  // A viewport breakpoint would keep two 363px cards and crush the rows; the
  // auto-fit grid must instead drop to one card per row somewhere below that.
  await browser.viewport({ width: 1024, height: 800 });
  await browser.goto(`${BASE}/#/security`);
  await browser.waitFor(`!!document.querySelector('.security-page .sec-row')`, 20_000);
  await new Promise((r) => setTimeout(r, 300));

  const widths = await browser.eval(`(() => {
    const cards = [...document.querySelectorAll('.security-grid > .sec-card')];
    return cards.map((c) => Math.round(c.getBoundingClientRect().width));
  })()`);
  assert.equal(widths.length, 2);
  // Either the two cards sit side by side with real room, or auto-fit has
  // stacked them. What must never happen is two 360px cards with rows of
  // wrapped text inside them.
  assert.ok(widths.every((w) => w >= 400), `cards are too narrow: ${widths.join(' / ')}`);
});

test('a settings page keeps a reading measure on a 1080p and a 1440p screen', async (t) => {
  if (!need(t)) return;
  // Left to the 1600px page cap the cards reach 750px, and every device row
  // strands its actions ~550px from the name while the danger rows put their
  // buttons 1300px from their copy. Those are the two things a wide screen
  // exposes, so both are asserted at both sizes.
  for (const [width, height] of [[1920, 1080], [2560, 1440]]) {
    await browser.viewport({ width, height });
    await browser.goto(`${BASE}/#/security`);
    await browser.waitFor(`!!document.querySelector('.security-page .sec-row')`, 25_000);
    await new Promise((r) => setTimeout(r, 300));

    const g = await browser.eval(`(() => {
      const b = (sel) => { const el = document.querySelector(sel); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), right: Math.round(r.right) }; };
      const cards = [...document.querySelectorAll('.security-grid > .sec-card')].map((c) => {
        const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; });
      return {
        column: b('.security-page'),
        danger: b('.sec-danger'),
        dangerText: b('.sec-danger-item span'),
        dangerBtn: b('.sec-danger-item .play-btn'),
        cards,
      };
    })()`);

    const where = `${width}x${height}`;
    assert.ok(g.column.w <= 1200, `${where}: settings column is ${g.column.w}px, expected a <=1200 measure`);
    assert.ok(g.column.w >= 1100, `${where}: settings column collapsed to ${g.column.w}px`);
    assert.equal(g.cards.length, 2);
    assert.ok(g.cards.every((c) => c.w >= 480), `${where}: cards are ${g.cards.map((c) => c.w)}px`);
    assert.equal(g.cards[0].y, g.cards[1].y, `${where}: the two cards are not side by side`);
    // The danger card spans the column; its buttons stay inside it rather than
    // being flung at the viewport edge.
    assert.equal(g.danger.w, g.column.w, `${where}: danger card does not span the column`);
    assert.ok(g.dangerBtn.right <= g.danger.x + g.danger.w, `${where}: the danger button escapes its card`);
    assert.ok(g.dangerBtn.x - g.dangerText.x < 1000,
      `${where}: the danger button is ${g.dangerBtn.x - g.dangerText.x}px from its copy`);
  }
});

test('the sign-in button is on screen on a short phone', async (t) => {
  if (!need(t)) return;
  // The P0 this pins: the auth overlay used to be a fixed 100dvh box with
  // overflow:hidden, and the stacked pitch+form was 120-220px taller. On an
  // iPhone SE/8 (and many Androids) #auth-submit sat below the screen with no
  // way to scroll to it, so the app could not be signed into at all.
  for (const [width, height] of [[320, 568], [360, 640], [375, 667], [390, 664]]) {
    await browser.eval(`fetch('/api/auth/logout',{method:'POST'}).then(r=>r.status)`).catch(() => {});
    await browser.viewport({ width, height, mobile: true });
    await browser.goto(`${BASE}/`);
    await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
    await new Promise((r) => setTimeout(r, 200));

    const m = await browser.eval(`(() => {
      const R = (sel) => { const el = document.querySelector(sel); if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      const overlay = document.getElementById('auth-overlay');
      return {
        vh: innerHeight, vw: innerWidth,
        submit: R('#auth-submit'),
        pitch: getComputedStyle(document.querySelector('.auth-pitch')).display,
        overflowY: getComputedStyle(overlay).overflowY,
        scrollable: overlay.scrollHeight - overlay.clientHeight,
        shell: R('.auth-shell'),
        footer: R('.auth-foot'),
      };
    })()`);

    const where = `${width}x${height}`;
    assert.ok(m.submit, 'the sign-in button is missing');
    assert.ok(m.submit.bottom <= m.vh + 0.5,
      `${where}: #auth-submit ends at ${m.submit.bottom}px, below the ${m.vh}px viewport`);
    assert.ok(m.submit.top >= 0, `${where}: #auth-submit starts above the viewport`);
    assert.ok(m.submit.left >= 0 && m.submit.right <= m.vw + 0.5,
      `${where}: #auth-submit (${m.submit.left}-${m.submit.right}) is outside the ${m.vw}px viewport`);

    // The pitch is decoration and must not push the form off a short screen.
    assert.equal(m.pitch, 'none', `${where}: the auth pitch still takes space above the form`);
    // And the overlay is a scroll container, so an error message, a passkey
    // hint or a larger font can never leave anything unreachable.
    assert.equal(m.overflowY, 'auto', `${where}: the auth overlay cannot scroll`);
    if (m.shell.bottom > m.vh + 0.5) {
      assert.ok(m.scrollable > 0, `${where}: the shell is taller than the viewport but the overlay does not scroll`);
    }
    assert.ok(m.footer, `${where}: the sign-in footer disappeared`);
  }

  // A short *desktop* window hides the decorative pitch too; the form must then
  // take the whole card instead of sitting in column one of a two-column grid.
  await browser.eval(`fetch('/api/auth/logout',{method:'POST'}).then(r=>r.status)`).catch(() => {});
  await browser.viewport({ width: 1024, height: 700 });
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
  const desktop = await browser.eval(`(() => {
    const shell = document.querySelector('.auth-shell');
    const w = (sel) => document.querySelector(sel).getBoundingClientRect().width;
    const submit = document.getElementById('auth-submit').getBoundingClientRect();
    return { shell: shell.clientWidth, panel: w('.auth-panel'), submitBottom: submit.bottom, vh: innerHeight };
  })()`);
  assert.ok(desktop.panel >= desktop.shell - 1,
    `a short desktop window left the form in ${desktop.panel}px of a ${desktop.shell}px card`);
  assert.ok(desktop.submitBottom <= desktop.vh, 'a short desktop window pushed the button off screen');
});

// A fixed-size tile whose only child is an icon must centre it on both axes.
// `.auth-point-ico` failed this: a broader `.auth-points span{display:block}`
// (written for the copy column) also matched the icon span, and being one
// element more specific it won — the tile silently became `display:block`,
// `place-items:center` stopped applying, and every icon sat 7px above centre.
const TILE_PROBE = (sels) => `(() => {
  const out = [];
  for (const sel of ${JSON.stringify(sels)}) {
    for (const host of document.querySelectorAll(sel)) {
      const svg = host.querySelector('svg');
      if (!svg) continue;
      const b = host.getBoundingClientRect(), r = svg.getBoundingClientRect();
      if (!b.width || !r.width) continue;
      out.push({ sel, display: getComputedStyle(host).display,
        offX: +(r.left - b.left - (b.width - r.width) / 2).toFixed(2),
        offY: +(r.top - b.top - (b.height - r.height) / 2).toFixed(2) });
    }
  }
  return out;
})()`;

test('a lone icon sits dead centre in its tile, on both axes', async (t) => {
  if (!need(t)) return;
  // Earlier tests leave the browser signed in; this one needs the sign-in screen.
  await browser.eval(`fetch('/api/auth/logout',{method:'POST'}).then(r=>r.status)`).catch(() => {});
  await browser.viewport({ width: 1440, height: 900 });
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
  await browser.waitFor(`!document.getElementById('auth-passkey').hidden`, 10_000);

  const boxes = await browser.eval(TILE_PROBE(['.auth-point-ico', '.auth-reveal', '.auth-remember-box', '.brand-logo']));
  assert.ok(boxes.length >= 6, `expected the login tiles, saw ${boxes.length}`);
  for (const b of boxes) {
    assert.equal(b.display, 'grid', `${b.sel} is display:${b.display}, so place-items cannot centre it`);
    assert.ok(Math.abs(b.offX) <= 0.5 && Math.abs(b.offY) <= 0.5,
      `${b.sel} icon is off-centre by (${b.offX}, ${b.offY})px`);
  }
});

test('the signed-in chrome keeps its icons centred too', async (t) => {
  if (!need(t)) return;
  await browser.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name:'toil',passphrase:'hunter2hunter2',remember:true,deviceId:'ct'})}).then(r=>r.status)`);
  await browser.goto(`${BASE}/#/security`);
  await browser.waitFor(`!!document.querySelector('.sec-row')`, 20_000);
  const boxes = await browser.eval(TILE_PROBE(['.sec-ico', '.icon-btn', '.auth-reveal']));
  assert.ok(boxes.length >= 6, `expected chrome tiles, saw ${boxes.length}`);
  for (const b of boxes) {
    assert.ok(Math.abs(b.offX) <= 0.5 && Math.abs(b.offY) <= 0.5,
      `${b.sel} icon is off-centre by (${b.offX}, ${b.offY})px`);
  }
});

test('the login glyphs are drawn centred in the 24-unit sprite space', async (t) => {
  if (!need(t)) return;
  await browser.eval(`fetch('/api/auth/logout',{method:'POST'}).then(r=>r.status)`).catch(() => {});
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
  // Centring the <svg> is not enough if the glyph inside the viewBox is drawn
  // off-centre: the monitor's body+stand box sat one unit low, so its ink
  // rendered 0.75px below the middle of its tile.
  const inks = await browser.eval(`(() => {
    const NS = 'http://www.w3.org/2000/svg';
    const host = document.createElementNS(NS, 'svg');
    host.setAttribute('viewBox', '0 0 24 24');
    host.style.cssText = 'position:fixed;width:24px;height:24px;top:0;left:0';
    document.body.appendChild(host);
    const out = {};
    for (const id of ['i-spark', 'i-device', 'i-key', 'i-wave', 'i-eye', 'i-check']) {
      const u = document.createElementNS(NS, 'use');
      u.setAttribute('href', '#' + id);
      host.appendChild(u);
      const bb = u.getBBox();
      out[id] = { cx: +(bb.x + bb.width / 2).toFixed(2), cy: +(bb.y + bb.height / 2).toFixed(2) };
      host.removeChild(u);
    }
    host.remove();
    return out;
  })()`);
  assert.ok(Object.keys(inks).length === 6);
  for (const [id, c] of Object.entries(inks)) {
    assert.ok(Math.abs(c.cx - 12) <= 0.6 && Math.abs(c.cy - 12) <= 0.6,
      `${id} ink centre is (${c.cx}, ${c.cy}), not (12, 12)`);
  }
});
