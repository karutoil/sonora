import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { ROOT, VIEW, INIT_SCRIPT, startServer, withPage } from './helpers/ux.js';

// The notification bell, driven in a real browser.
//
// The follow/poll routes touch YouTube (a sweep is one catalogue page fetch per
// followed artist), so this suite never asks the server for them: `window.fetch`
// is patched before app.js and notifications.js run, `/api/notifications*` and
// `/api/follows` answer from fixtures, and everything else falls through to the
// shared UX fixtures (which keep the app's own boot off the network too).
//
// The OS-notification half is tested by replacing both delivery paths —
// `Notification` and the service worker registration's `showNotification` —
// with recorders, because "did the browser show a notification" is not
// observable from inside the page any other way.

const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

const T0 = Date.now();
const iso = (msAgo) => new Date(T0 - msAgo).toISOString();

const ITEM_A = {
  id: 2,
  kind: 'release',
  title: 'Fixture Album One',
  body: 'Fixture Artist One released an album',
  thumb: null,
  url: '#/c/aMPRuxFixtureAlbum01',
  artistId: 'UCuxFixtureArtist000000',
  artistName: 'Fixture Artist One',
  videoId: null,
  createdAt: iso(3_600_000), // 1h ago
  readAt: null,
};

const ITEM_B = {
  id: 1,
  kind: 'track',
  title: 'Fixture Video',
  body: 'Fixture Artist One released a video',
  thumb: null,
  url: '#/t/uxVid0000001',
  artistId: 'UCuxFixtureArtist000000',
  artistName: 'Fixture Artist One',
  videoId: 'uxVid0000001',
  createdAt: iso(2 * 86_400_000), // 2d ago
  readAt: null,
};

const ITEMS = [ITEM_A, ITEM_B];

const NEW_ITEM = {
  id: 3,
  kind: 'release',
  title: 'Brand New Single',
  body: 'Fixture Artist One released a single',
  thumb: null,
  url: '#/c/aMPRuxFixtureSingle1',
  artistId: 'UCuxFixtureArtist000000',
  artistName: 'Fixture Artist One',
  videoId: null,
  createdAt: iso(5_000),
  readAt: null,
};

// ── in-page instrumentation ───────────────────────────────────────────────

/**
 * Runs before every document load, after the shared UX fixtures (so it wraps
 * them). It installs the notification fixtures, the OS-notification recorders
 * and an error recorder, and exposes a control surface on `window.__notif` that
 * the assertions drive (`items`, `unread`, `calls`, `shown`).
 */
function notifInit(config) {
  const rec = {
    items: config.items ?? [],
    unread: config.unread ?? 0,
    permission: config.permission ?? 'default',
    calls: { list: 0, read: [], readAll: 0, check: 0 },
    shown: [],
    permissionRequests: 0,
    errors: [],
  };
  window.__notif = rec;

  // The preferences the module reads, and a clean "never announced anything"
  // bookmark, so the first poll always baselines.
  try {
    localStorage.setItem('sonora.prefs', JSON.stringify(config.prefs ?? {}));
    localStorage.removeItem('sonora.notifSeen');
  } catch {}

  // The signed-out boot: the feed answers 401 (an expired or revoked session),
  // which is the state the module has to back off from without throwing.
  rec.unauthorized = config.unauthorized === true;

  const realError = console.error.bind(console);
  console.error = (...args) => {
    rec.errors.push(args.map((a) => (a && a.message) || String(a)).join(' '));
    realError(...args);
  };
  window.addEventListener('error', (e) => rec.errors.push(`window.error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => {
    rec.errors.push(`unhandledrejection: ${e.reason?.message ?? String(e.reason)}`);
  });

  // Both delivery paths the module can take, recorded rather than shown.
  class RecorderNotification {
    constructor(title, options) {
      rec.shown.push({ via: 'constructor', title, ...(options ?? {}) });
      this.title = title;
    }
    close() {}
    static requestPermission() {
      rec.permissionRequests += 1;
      if (rec.permission !== 'denied') rec.permission = 'granted';
      return Promise.resolve(rec.permission);
    }
  }
  Object.defineProperty(RecorderNotification, 'permission', { get: () => rec.permission });
  window.Notification = RecorderNotification;

  const fakeRegistration = {
    showNotification(title, options) {
      rec.shown.push({ via: 'serviceWorker', title, ...(options ?? {}) });
      return Promise.resolve();
    },
    getNotifications: () => Promise.resolve([]),
  };
  try {
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      configurable: true,
      get: () => Promise.resolve(fakeRegistration),
    });
  } catch {}

  const inner = window.fetch.bind(window);
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
    let url;
    try { url = new URL(raw, location.href); } catch { return inner(input, init); }
    const p = url.pathname;
    const method = String(
      (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET',
    ).toUpperCase();

    if (p === '/api/notifications' && method === 'GET') {
      rec.calls.list += 1;
      if (rec.unauthorized) return json({ error: 'Sign in first.' }, 401);
      return json({ items: rec.items, unread: rec.unread });
    }
    if (p === '/api/notifications/read' && method === 'POST') {
      const body = JSON.parse((init && init.body) || '{}');
      rec.calls.read.push(body.ids ?? []);
      const ids = new Set(body.ids ?? []);
      rec.items = rec.items.map((row) => (ids.has(row.id) ? { ...row, readAt: new Date().toISOString() } : row));
      rec.unread = rec.items.filter((row) => !row.readAt).length;
      return json({ unread: rec.unread });
    }
    if (p === '/api/notifications/read-all' && method === 'POST') {
      rec.calls.readAll += 1;
      rec.items = rec.items.map((row) => ({ ...row, readAt: row.readAt || new Date().toISOString() }));
      rec.unread = 0;
      return json({ unread: 0 });
    }
    if (p === '/api/notifications/check' && method === 'POST') {
      rec.calls.check += 1;
      return json({ created: 0, unread: rec.unread, throttled: true });
    }
    if (p === '/api/follows' && method === 'GET') {
      return json({ items: config.follows ?? [] });
    }
    return inner(input, init);
  };
}

const notifInitSrc = (config) => `(${notifInit.toString()})(${JSON.stringify(config)})`;

// ── harness ───────────────────────────────────────────────────────────────

let server;
let browser;
let BASE;

before(async () => {
  server = await startServer();
  BASE = server.base;
  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.addInitScript(INIT_SCRIPT);
  await browser.viewport(VIEW.mobile390);
  await browser.goto(`${BASE}/`);
  const status = await browser.eval(`fetch('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
  assert.equal(status, 200, 'browser login with toil/hunter2hunter2 failed');
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
});

after(async () => {
  browser?.close();
  await server?.stop();
});

function needBrowser(t) {
  if (browser) return true;
  t.skip(CHROME
    ? 'Chromium did not launch; set CHROME_BIN=/usr/bin/chromium and re-run'
    : 'no Chromium found; set CHROME_BIN=/usr/bin/chromium to run this suite');
  return false;
}

/** Boot a fresh document with these notification fixtures, then run `fn`. */
async function boot(t, config, fn) {
  if (!needBrowser(t)) return;
  const dispose = await browser.addInitScript(notifInitSrc(config));
  try {
    await withPage(browser, BASE, { viewport: config.viewport ?? VIEW.mobile390 }, fn);
  } finally {
    await dispose();
  }
}

const PANEL_OPEN = `(() => { const p = document.getElementById('notif-panel'); return !!p && !p.hidden; })()`;
const PANEL_CLOSED = `(() => { const p = document.getElementById('notif-panel'); return !!p && p.hidden; })()`;

async function openPanel() {
  await browser.eval(`document.querySelector('[data-action="notifications"]').click()`);
  await browser.waitFor(PANEL_OPEN, 4000);
}

/** One poll, then let the (async) alert path settle. */
const pollAndSettle = `(async () => {
  await window.__sonoraNotifications.refresh();
  await new Promise((resolve) => setTimeout(resolve, 120));
  return window.__notif.shown.length;
})()`;

// ── the bell ──────────────────────────────────────────────────────────────

test('the bell shows the dot, a numeric badge and the unread count', async (t) => {
  await boot(t, { items: ITEMS, unread: 2 }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);

    const bell = await browser.eval(`(() => {
      const b = document.querySelector('[data-action="notifications"]');
      const dot = b.querySelector('.notification-dot');
      const badge = b.querySelector('.notif-badge');
      return {
        dotHidden: dot ? dot.hidden : null,
        badgeText: badge ? badge.textContent.trim() : null,
        badgeHidden: badge ? badge.hidden : null,
        label: b.getAttribute('aria-label'),
        haspopup: b.getAttribute('aria-haspopup'),
        expanded: b.getAttribute('aria-expanded'),
      };
    })()`);

    assert.equal(bell.dotHidden, false, 'the dot must be visible while there are unread rows');
    assert.equal(bell.badgeHidden, false, 'the count badge must be visible while there are unread rows');
    assert.equal(bell.badgeText, '2', `the badge should read the unread count, got ${JSON.stringify(bell.badgeText)}`);
    assert.match(bell.label ?? '', /2 unread/,
      `the bell's aria-label must carry the count, got ${JSON.stringify(bell.label)}`);
    assert.equal(bell.haspopup, 'dialog', 'the bell opens a dialog and should say so');
    assert.equal(bell.expanded, 'false', 'the bell starts collapsed');
  });
});

test('a large unread count is capped at 9+', async (t) => {
  await boot(t, { items: ITEMS, unread: 12 }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    const badge = await browser.eval(`document.querySelector('.notif-badge').textContent.trim()`);
    assert.equal(badge, '9+', `a two-digit count must read 9+, got ${JSON.stringify(badge)}`);
  });
});

// ── the panel ─────────────────────────────────────────────────────────────

test('the bell opens a dialog listing every row with its unread accent', async (t) => {
  await boot(t, { items: ITEMS, unread: 2 }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    await openPanel();

    const panel = await browser.eval(`(() => {
      const p = document.getElementById('notif-panel');
      const items = [...p.querySelectorAll('.notif-item')];
      return {
        role: p.getAttribute('role'),
        modal: p.getAttribute('aria-modal'),
        labelledby: p.getAttribute('aria-labelledby'),
        heading: p.querySelector('.notif-heading')?.textContent.trim() ?? null,
        expanded: document.querySelector('[data-action="notifications"]').getAttribute('aria-expanded'),
        backdropShown: !document.querySelector('.notif-backdrop').hidden,
        items: items.map((el) => ({
          text: el.innerText.replace(/\\s+/g, ' ').trim(),
          unread: el.classList.contains('is-unread'),
          tag: el.tagName,
        })),
        focused: document.activeElement === p || p.contains(document.activeElement),
      };
    })()`);

    assert.equal(panel.role, 'dialog', 'the panel must be a dialog');
    assert.equal(panel.modal, 'true', 'on a phone the panel is a modal bottom sheet');
    assert.equal(panel.labelledby, 'notif-heading', 'the dialog must be labelled by its heading');
    assert.equal(panel.heading, 'Notifications');
    assert.equal(panel.expanded, 'true', 'opening the panel must flip aria-expanded');
    assert.equal(panel.backdropShown, true, 'a bottom sheet needs its backdrop');
    assert.equal(panel.items.length, 2, `expected both fixture rows, got ${panel.items.length}`);
    assert.ok(panel.items.every((row) => row.tag === 'BUTTON'), 'every row must be a real button');
    assert.ok(panel.items.every((row) => row.unread), 'both fixture rows are unread and must be styled so');
    assert.match(panel.items[0].text, /Fixture Album One/, `first row text: ${JSON.stringify(panel.items[0].text)}`);
    assert.match(panel.items[0].text, /1h/, 'the row must carry a relative time');
    assert.match(panel.items[1].text, /2d/, 'the older row must read in days');
    assert.ok(panel.focused, 'focus must move into the dialog when it opens');
  });
});

test('on a desktop the panel is a non-modal popover under the bell', async (t) => {
  await boot(t, { items: ITEMS, unread: 2, viewport: VIEW.desktop }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    await openPanel();

    const shape = await browser.eval(`(() => {
      const p = document.getElementById('notif-panel');
      const bell = document.querySelector('[data-action="notifications"]').getBoundingClientRect();
      const box = p.getBoundingClientRect();
      return {
        modal: p.getAttribute('aria-modal'),
        backdropHidden: document.querySelector('.notif-backdrop').hidden,
        below: Math.round(box.top - bell.bottom),
        overlapsBell: box.top < bell.bottom - 1,
        insideViewport: box.left >= 0 && box.right <= innerWidth + 0.5,
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
      };
    })()`);

    assert.equal(shape.modal, 'false', 'a popover is not modal');
    assert.equal(shape.backdropHidden, true, 'a popover does not dim the app behind it');
    assert.ok(!shape.overlapsBell, 'the popover must sit under the bell, not over it');
    assert.ok(shape.below >= 0 && shape.below <= 24,
      `the popover should hug the bell (gap ${shape.below}px)`);
    assert.ok(shape.insideViewport, 'the popover must stay inside the viewport');
    assert.equal(shape.docScrollWidth, shape.docClientWidth, 'the popover must not create horizontal overflow');
  });
});

test('Escape closes the panel and returns focus to the bell', async (t) => {
  await boot(t, { items: ITEMS, unread: 2 }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    await browser.eval(`document.querySelector('[data-action="notifications"]').focus()`);
    await openPanel();

    await browser.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true }))`);
    await browser.waitFor(PANEL_CLOSED, 4000);

    const after = await browser.eval(`(() => {
      const b = document.querySelector('[data-action="notifications"]');
      return {
        focused: document.activeElement === b,
        expanded: b.getAttribute('aria-expanded'),
        backdropHidden: document.querySelector('.notif-backdrop').hidden,
      };
    })()`);

    assert.equal(after.focused, true, 'focus must return to the bell that opened the panel');
    assert.equal(after.expanded, 'false', 'closing must collapse aria-expanded');
    assert.equal(after.backdropHidden, true, 'the backdrop must go with the sheet');
  });
});

test('a row marks itself read, closes the panel and follows the server route', async (t) => {
  await boot(t, { items: ITEMS, unread: 2 }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    await openPanel();

    await browser.eval(`document.querySelectorAll('#notif-panel .notif-item')[0].click()`);
    await browser.waitFor(PANEL_CLOSED, 4000);
    await browser.waitFor(`window.__notif.calls.read.length > 0`, 4000);

    const result = await browser.eval(`({
      read: window.__notif.calls.read,
      hash: location.hash,
      dotHidden: document.querySelector('.notification-dot').hidden,
      badge: document.querySelector('.notif-badge').textContent.trim(),
      unread: window.__notif.unread,
    })`);

    assert.deepEqual(result.read.at(-1), [ITEM_A.id],
      `tapping a row must POST its id to /api/notifications/read, got ${JSON.stringify(result.read)}`);
    assert.equal(result.hash, ITEM_A.url,
      `tapping a row must navigate to the server's own route, got ${JSON.stringify(result.hash)}`);
    assert.equal(result.dotHidden, false, 'one unread row is left, so the dot stays');
    assert.equal(result.badge, '1', `the badge should drop to 1, got ${JSON.stringify(result.badge)}`);
    assert.equal(result.unread, 1, 'the fixture server should now hold one unread row');
  });
});

test('"Mark all read" posts read-all and clears the dot', async (t) => {
  await boot(t, { items: ITEMS, unread: 2 }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    await openPanel();

    await browser.eval(`document.querySelector('#notif-panel [data-notif="read-all"]').click()`);
    await browser.waitFor(`document.querySelector('.notification-dot').hidden`, 4000);

    const after = await browser.eval(`({
      readAll: window.__notif.calls.readAll,
      badgeHidden: document.querySelector('.notif-badge').hidden,
      label: document.querySelector('[data-action="notifications"]').getAttribute('aria-label'),
      unreadRows: document.querySelectorAll('#notif-panel .notif-item.is-unread').length,
      buttonDisabled: document.querySelector('#notif-panel [data-notif="read-all"]').disabled,
      panelOpen: !document.getElementById('notif-panel').hidden,
    })`);

    assert.equal(after.readAll, 1, 'marking everything read must reach the server exactly once');
    assert.equal(after.badgeHidden, true, 'the badge goes away with the last unread row');
    assert.equal(after.label, 'Notifications', `the label should lose the count, got ${JSON.stringify(after.label)}`);
    assert.equal(after.unreadRows, 0, 'no row may keep its unread accent');
    assert.equal(after.buttonDisabled, true, 'with nothing unread the action is disabled');
    assert.equal(after.panelOpen, true, 'marking read is not a reason to close the panel');
  });
});

test('an empty feed explains what the bell is for', async (t) => {
  await boot(t, { items: [], unread: 0 }, async () => {
    await browser.waitFor(`window.__notif.calls.list > 0`, 6000);
    await openPanel();

    const empty = await browser.eval(`(() => {
      const el = document.querySelector('#notif-panel .notif-empty');
      return {
        text: el ? el.innerText.replace(/\\s+/g, ' ').trim() : null,
        dotHidden: document.querySelector('.notification-dot').hidden,
        badgeHidden: document.querySelector('.notif-badge').hidden,
        readAllDisabled: document.querySelector('#notif-panel [data-notif="read-all"]').disabled,
      };
    })()`);

    assert.ok(empty.text, 'an empty feed must render its empty state, not a blank panel');
    assert.match(empty.text, /Nothing new\./, `empty state text: ${JSON.stringify(empty.text)}`);
    assert.match(empty.text, /Follow an artist and you will hear about their releases here\./,
      `empty state must point at the next action, got ${JSON.stringify(empty.text)}`);
    assert.equal(empty.dotHidden, true, 'no unread rows, no dot');
    assert.equal(empty.badgeHidden, true, 'no unread rows, no badge');
    assert.equal(empty.readAllDisabled, true, 'nothing to mark read');
  });
});

// ── desktop / PWA alerts ──────────────────────────────────────────────────

test('with desktop alerts off, a new row never reaches the OS', async (t) => {
  await boot(t, { items: ITEMS, unread: 2, prefs: { desktopAlerts: false }, permission: 'granted' }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);

    const result = await browser.eval(`(async () => {
      window.__notif.items = ${JSON.stringify([NEW_ITEM, ...ITEMS])};
      window.__notif.unread = 3;
      const shown = await (${pollAndSettle});
      return { shown, polls: window.__notif.calls.list, seen: localStorage.getItem('sonora.notifSeen') };
    })()`);

    assert.ok(result.polls >= 2, `the poll must have run again (polls=${result.polls})`);
    assert.equal(result.shown, 0,
      'a new row must not become an OS notification while the preference is off');
    // The bookmark still moves: turning alerts on later must not replay history.
    assert.equal(result.seen, String(NEW_ITEM.id),
      `the highest seen id must advance regardless of the preference, got ${JSON.stringify(result.seen)}`);
  });
});

test('with desktop alerts on, a new row alerts exactly once', async (t) => {
  await boot(t, { items: ITEMS, unread: 2, prefs: { desktopAlerts: true }, permission: 'granted' }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);

    const first = await browser.eval(`(async () => {
      window.__notif.items = ${JSON.stringify([NEW_ITEM, ...ITEMS])};
      window.__notif.unread = 3;
      const shown = await (${pollAndSettle});
      return { shown, calls: window.__notif.shown.slice() };
    })()`);

    assert.equal(first.shown, 1,
      `one new row must produce exactly one OS notification, got ${JSON.stringify(first.calls)}`);
    const alert = first.calls[0];
    assert.equal(alert.via, 'serviceWorker',
      'with a service worker available the alert must go through registration.showNotification');
    assert.equal(alert.title, NEW_ITEM.title, `the alert title comes from the row, got ${JSON.stringify(alert.title)}`);
    assert.equal(alert.tag, `sonora-${NEW_ITEM.id}`, 'the tag must be per row id so the OS can group it');
    assert.equal(alert.data?.url, NEW_ITEM.url, 'the alert must carry the route it opens');

    // The same feed again: the id is already announced, so nothing is shown.
    const second = await browser.eval(`(async () => {
      const shown = await (${pollAndSettle});
      return { shown, calls: window.__notif.shown.length };
    })()`);
    assert.equal(second.shown, 1,
      `a re-poll of the same row must not alert again (${second.calls} notifications shown)`);
  });
});

test('permission is only requested from the settings event, never on boot', async (t) => {
  await boot(t, { items: ITEMS, unread: 2, prefs: { desktopAlerts: false }, permission: 'default' }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    assert.equal(await browser.eval(`window.__notif.permissionRequests`), 0,
      'booting the app must not ask for notification permission');

    // The panel offers the affordance while the browser has not decided.
    await openPanel();
    const offer = await browser.eval(`(() => {
      const btn = document.querySelector('#notif-panel [data-notif="enable-alerts"]');
      return { present: !!btn, label: btn ? btn.textContent.trim() : null };
    })()`);
    assert.equal(offer.present, true, 'the panel must offer "Enable alerts" while permission is undecided');
    assert.equal(offer.label, 'Enable alerts');

    // The settings toggle is the documented gesture: app.js dispatches it.
    await browser.eval(`document.dispatchEvent(new CustomEvent('sonora:pref-change', {
      detail: { key: 'desktopAlerts', value: true } }))`);
    await browser.waitFor(`window.__notif.permissionRequests > 0`, 3000);
    assert.equal(await browser.eval(`window.__notif.permission`), 'granted');
  });
});

test('a denied permission is explained in the panel instead of failing silently', async (t) => {
  await boot(t, { items: ITEMS, unread: 2, prefs: { desktopAlerts: true }, permission: 'denied' }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);
    await openPanel();
    const note = await browser.eval(
      `document.querySelector('#notif-panel .notif-note')?.innerText.replace(/\\s+/g, ' ').trim() ?? null`,
    );
    assert.match(note ?? '', /Desktop alerts are blocked in this browser — the bell still works/,
      `a denied permission must be said out loud, got ${JSON.stringify(note)}`);
  });
});

test('a 401 stops the polling quietly, and the tab picks the feed up again', async (t) => {
  await boot(t, { items: ITEMS, unread: 2, unauthorized: true }, async () => {
    await browser.waitFor(`window.__notif.calls.list > 0`, 6000);
    // Give the module a beat: a 401 must not be retried in a loop.
    await browser.eval(`new Promise((r) => setTimeout(r, 500))`);

    const before = await browser.eval(`({
      polls: window.__notif.calls.list,
      dotHidden: document.querySelector('.notification-dot').hidden,
      badgeHidden: document.querySelector('.notif-badge').hidden,
      errors: window.__notif.errors.slice(),
    })`);
    assert.equal(before.polls, 1,
      `an unauthenticated feed must be asked for once, not retried (${before.polls} requests)`);
    assert.equal(before.dotHidden, true, 'a tab that cannot read the feed must not claim unread rows');
    assert.equal(before.badgeHidden, true, 'and it must not show a count');
    assert.deepEqual(before.errors, [],
      `a 401 is an expected answer, not a console error:\n${before.errors.join('\n')}`);

    // Coming back to the tab is the documented retry: once the session works
    // again, the same tab picks the feed up without a reload.
    await browser.eval(`window.__notif.unauthorized = false`);
    await browser.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);

    const after = await browser.eval(`({
      polls: window.__notif.calls.list,
      badge: document.querySelector('.notif-badge').textContent.trim(),
      label: document.querySelector('[data-action="notifications"]').getAttribute('aria-label'),
    })`);
    assert.ok(after.polls > before.polls, 'returning to the tab must re-poll');
    assert.equal(after.badge, '2', 'and it must show what it found');
    assert.match(after.label ?? '', /2 unread/);
  });
});

// ── the quiet console and the narrow viewport ─────────────────────────────

test('the panel fits a 390px phone and the console stays quiet', async (t) => {
  await boot(t, { items: ITEMS, unread: 2 }, async () => {
    await browser.waitFor(`!document.querySelector('.notification-dot').hidden`, 6000);

    const probe = `(() => {
      const p = document.getElementById('notif-panel');
      const box = p && !p.hidden ? p.getBoundingClientRect() : null;
      return {
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        panel: box ? { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) } : null,
      };
    })()`;

    const closed = await browser.eval(probe);
    assert.equal(closed.docScrollWidth, closed.docClientWidth,
      `the closed shell must not scroll sideways (${closed.docScrollWidth} > ${closed.docClientWidth})`);

    await openPanel();
    await browser.eval(`new Promise((r) => setTimeout(r, 260))`); // let the sheet finish sliding
    const open = await browser.eval(probe);

    assert.equal(open.docScrollWidth, open.docClientWidth,
      `the open sheet must not scroll sideways (${open.docScrollWidth} > ${open.docClientWidth})`);
    assert.ok(open.panel, 'the sheet must be visible while measuring');
    assert.ok(open.panel.left >= 0 && open.panel.right <= closed.docClientWidth,
      `the sheet must stay inside the viewport, got ${JSON.stringify(open.panel)}`);

    const errors = await browser.eval(`window.__notif.errors.slice()`);
    assert.deepEqual(errors, [], `the console must stay quiet:\n${errors.join('\n')}`);
  });
});

// ── the service worker side of an alert ───────────────────────────────────

test('sw.js answers a notification click by focusing the app, not a blank tab', () => {
  assert.match(SW, /addEventListener\('notificationclick'/, 'the worker must handle notification clicks');
  assert.match(SW, /notification\?\.close\(\)/, 'the tapped notification must be dismissed');
  assert.match(SW, /clients\.matchAll\(\s*\{\s*type:\s*'window',\s*includeUncontrolled:\s*true\s*\}/,
    'an already-open window must be found, including one this worker does not control');
  assert.match(SW, /postMessage\(\{\s*type:\s*'sonora:open-url'/, 'the open window must be told which route to show');
  assert.match(SW, /clients\.openWindow\(/, 'with no window open, the app is opened');
  // A bare fragment would open a blank page: the route is resolved against the
  // worker's scope, which is the app root.
  assert.match(SW, /new URL\(route \|\| '\/', self\.registration\.scope\)/,
    'data.url must be resolved against the app root before openWindow');
  assert.doesNotMatch(SW, /addEventListener\('push'/, 'sonora has no push service; alerts are shown by the page');
});

test('the shell precaches the notification module and is versioned past v6', () => {
  const block = SW.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js has no PRECACHE array');
  const list = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const url of ['/notifications.js', '/notifications.css']) {
    assert.ok(list.includes(url), `PRECACHE is missing ${url}`);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', url.replace(/^\//, ''))),
      `PRECACHE lists ${url}, which does not exist — the install would fail`);
  }
  const version = SW.match(/const VERSION = '([^']+)';/)?.[1];
  assert.equal(version, 'v7', `the shell list changed, so VERSION must move to v7 (got ${version})`);
});

test('index.html loads the notification module and its stylesheet', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/notifications\.css">/,
    'the panel stylesheet must be linked');
  assert.match(html, /<script type="module" src="\/notifications\.js"><\/script>/,
    'the module must be loaded as a module script');
  // The stylesheet order is a contract (app.css then the feature sheets); the
  // new sheet goes last so it can override, never be overridden.
  assert.ok(html.indexOf('/app.css') < html.indexOf('/notifications.css'),
    'notifications.css must load after app.css');
  assert.match(html, /data-action="notifications"[\s\S]{0,220}class="notification-dot"/,
    'the bell keeps its .notification-dot hook');
  // index.html and offline.html must keep a byte-identical --app-h boot script.
  const bootScript = html.match(/<script>\/\* --app-h[\s\S]*?<\/script>/)?.[0];
  const offline = fs.readFileSync(path.join(ROOT, 'public/offline.html'), 'utf8');
  assert.equal(bootScript, offline.match(/<script>\/\* --app-h[\s\S]*?<\/script>/)?.[0],
    'the --app-h boot script must stay identical in index.html and offline.html');
});
