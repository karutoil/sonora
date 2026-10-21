import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import {
  SHOTS, VIEW, INIT_SCRIPT,
  startServer, seedPlaylist, seedPlayerState, withPage, nav,
} from './helpers/ux.js';

// Queue behaviour in a real browser: drag and keyboard reordering, "Add to
// queue", and the off-by-default "queue the rest of the list" preference.
//
// Everything is driven through the DOM of a real Chromium against a temp DB, so
// a green run means the gesture actually moved `state.queue`, the session was
// actually persisted, and the preference actually changed what got queued. No
// YouTube and no network: the audio element never loads (see helpers/ux.js).
//
// A drag is dispatched as real PointerEvents in page JS (pointerdown on the
// grip, several pointermove, pointerup), which is exactly what the app's
// document-level pointer listeners see from a mouse or a finger.

let server;
let browser;
let BASE;
let PLAYLIST;   // the helper's one-track playlist
let THREE;      // a three-track playlist, so "the whole list" means something

// Fixture tracks the seeded queue is built from. Ids are 11 base64url
// characters because the server validates them.
const TRACKS = [
  { videoId: 'qUXt0000001', title: 'Queue Fixture One', channel: 'Queue Fixture Channel', durationS: 201 },
  { videoId: 'qUXt0000002', title: 'Queue Fixture Two', channel: 'Queue Fixture Channel', durationS: 202 },
  { videoId: 'qUXt0000003', title: 'Queue Fixture Three', channel: 'Queue Fixture Channel', durationS: 203 },
];

async function loginCookie() {
  // /api/auth/login is rate limited to 10 a minute per IP, so log in once and
  // reuse the cookie: the seeding below and the session read-backs share it.
  if (loginCookie.cached) return loginCookie.cached;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie') ?? '';
  if (!raw) throw new Error(`login returned no session cookie (${res.status})`);
  loginCookie.cached = raw.split(';')[0];
  return loginCookie.cached;
}

/** Write the shared session (what `seedPlayerState` does, with our one cookie). */
async function putNow({ tracks, ...rest }) {
  const cookie = await loginCookie();
  const res = await fetch(`${BASE}/api/now`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    // The API calls the queue `queue`; the GET calls it `tracks`.
    body: JSON.stringify({ ...rest, queue: tracks ?? [], takeover: true }),
  });
  if (!res.ok) throw new Error(`now seed failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** A playlist with real, ordered tracks (the helper seeds only one). */
async function seedMultiTrackPlaylist(title, tracks) {
  const cookie = await loginCookie();
  const create = await fetch(`${BASE}/api/playlists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title, description: 'Seeded by test/queue.test.js' }),
  });
  if (!create.ok) throw new Error(`playlist create failed: ${create.status}`);
  const { playlist } = await create.json();
  for (const t of tracks) {
    const add = await fetch(`${BASE}/api/playlists/${playlist.id}/tracks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(t),
    });
    if (!add.ok) throw new Error(`playlist track failed: ${add.status} ${await add.text()}`);
  }
  const full = await fetch(`${BASE}/api/playlists/${playlist.id}`, { headers: { cookie } });
  const { playlist: withTracks } = await full.json();
  return { id: playlist.id, title, tracks: withTracks.tracks };
}

/** The persisted session, read back with a fresh login cookie. */
async function fetchNow() {
  const cookie = await loginCookie();
  const res = await fetch(`${BASE}/api/now`, { headers: { cookie } });
  return res.json();
}

/** Put the shared session into a known state before a page boots. */
/**
 * Put the shared session into a known state before a page boots.
 *
 * The previous page is parked first: navigating away hides it, and the app
 * saves its session on `visibilitychange` (public/app.js), so that write would
 * otherwise land *after* this seed and undo it. The seed is then read back and
 * retried until it sticks.
 */
async function seedQueue(tracks = TRACKS, index = 0) {
  await browser.goto('about:blank');
  const want = tracks.map((t) => t.videoId).join();
  for (let i = 0; i < 8; i++) {
    await putNow({ tracks, index, positionMs: 0, source: 'home', deviceId: 'queue-fixture-device' });
    await new Promise((r) => setTimeout(r, 120));
    const now = await fetchNow();
    if ((now.state?.tracks ?? []).map((t) => t.videoId).join() === want
      && Number(now.state?.index ?? -1) === index) return;
  }
  throw new Error(`could not seed the queue with ${want}`);
}

/** Wait until a collection page has painted its real rows (not a skeleton). */
async function waitForRows(count = 1) {
  await browser.waitFor(`document.querySelectorAll('#page-root .track-row[data-track]').length
    >= ${Number(count)}`, 8000);
}

/** Click a track row and wait until it is the song the player shows. */
async function playRow(rowIndex, expectedTitle) {
  // A collection route paints a skeleton first, so wait for the real rows.
  await waitForRows(rowIndex + 1);
  const clicked = await browser.eval(`(() => {
    const rows = document.querySelectorAll('#page-root .track-row[data-track]');
    const row = rows[${Number(rowIndex)}];
    if (!row) return false;
    row.click();
    return true;
  })()`);
  assert.ok(clicked, `the page rendered no track row at index ${rowIndex}`);
  await browser.waitFor(`document.querySelector('#player .player-song-meta strong')?.textContent.trim()
    === ${JSON.stringify(expectedTitle)}`, 6000);
}

before(async () => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  server = await startServer();
  BASE = server.base;
  const seed = await seedPlaylist(BASE);
  PLAYLIST = { id: seed.id, title: seed.title, track: seed.tracks[0] };
  THREE = await seedMultiTrackPlaylist('Queue Fixture List', TRACKS);
  assert.equal(THREE.tracks.length, 3, 'the three-track fixture playlist did not keep its tracks');
  await seedPlayerState(BASE, {
    tracks: TRACKS, index: 0, positionMs: 0, source: 'home', deviceId: 'queue-fixture-device',
  });

  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.addInitScript(INIT_SCRIPT);
  await browser.viewport(VIEW.desktop);
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
    : 'no Chromium found; set CHROME_BIN=/usr/bin/chromium to run the queue suite');
  return false;
}

// ── in-page helpers ──────────────────────────────────────────────────────

/** Open the queue drawer from whichever trigger the shell renders. */
async function openDrawer() {
  // The rail is painted by `render()` after the page body, so on a cold boot the
  // trigger can be a frame late. Wait for the real condition instead of
  // assuming the shell is fully painted.
  await browser.waitFor(`!!document.querySelector('#rail-content [data-action="queue"], #player [data-action="queue"]')`, 8000)
    .catch(() => {});
  const ok = await browser.eval(`(() => {
    const el = document.querySelector('#rail-content [data-action="queue"], #player [data-action="queue"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  assert.ok(ok, 'no queue trigger (data-action="queue") in the player or the rail');
  await browser.waitFor(`!document.getElementById('drawer-overlay').hidden
    && document.querySelectorAll('#queue-drawer [data-queue-row]').length > 0`, 5000);
}

async function closeDrawer() {
  await browser.eval(`document.querySelector('#queue-drawer [data-action="close-drawer"]')?.click()`);
  await browser.waitFor(`document.getElementById('drawer-overlay').hidden`, 3000).catch(() => {});
}

/**
 * Re-open the drawer until `expr` (evaluated in the page) holds.
 *
 * Opening the drawer always repaints it from `state.queue`, and the click that
 * started a track is handled asynchronously, so a drawer opened too early can
 * show the queue from before that click. Re-opening is the honest way to wait
 * for the state to settle without guessing at timings.
 */
async function openDrawerUntil(expr, timeout = 6000) {
  const deadline = Date.now() + timeout;
  do {
    await openDrawer();
    if (await browser.eval(expr)) return true;
    await closeDrawer();
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  await openDrawer();
  return false;
}

/** Titles in the order the drawer renders them, top to bottom. */
async function drawerOrder() {
  return browser.eval(`[...document.querySelectorAll('#queue-drawer [data-queue-row]')]
    .map((r) => r.querySelector('.queue-text strong').textContent.trim())`);
}

/** `state.queue` order, read back through the drawer's row indices. */
async function drawerIndexOrder() {
  return browser.eval(`[...document.querySelectorAll('#queue-drawer [data-queue-row]')]
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
    .map((r) => r.dataset.video)`);
}

/** The drawer's visual `data-index` sequence (the current row first). */
async function drawerSlots() {
  return browser.eval(`[...document.querySelectorAll('#queue-drawer [data-queue-row]')]
    .map((r) => Number(r.dataset.index))`);
}

/** Resume the restored session, which claims the session for this device. */
async function resumePlayback() {
  const ok = await browser.eval(`(() => {
    const btn = document.querySelector('#player [data-action="playpause"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
  assert.ok(ok, 'the player rendered no play button — was a session restored?');
  await browser.waitFor(`document.querySelector('#player').classList.contains('is-playing')`, 3000);
}

/**
 * Drag the row with `videoId` down over the row `rowsDown` slots below it, using
 * real PointerEvents with clientX/clientY on the grip.
 */
async function dragRow(videoId, rowsDown, scope = '#queue-drawer') {
  return browser.eval(`(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(scope)} + ' [data-queue-row]')];
    const row = rows.find((r) => r.dataset.video === ${JSON.stringify(videoId)});
    if (!row) return { ok: false, why: 'row not found' };
    const grip = row.querySelector('[data-queue-grip]');
    if (!grip) return { ok: false, why: 'no grip' };
    const from = grip.getBoundingClientRect();
    const x = from.left + from.width / 2;
    const y = from.top + from.height / 2;
    const target = rows[rows.indexOf(row) + ${Number(rowsDown)}];
    if (!target) return { ok: false, why: 'no target row below' };
    const box = target.getBoundingClientRect();
    const endY = box.top + box.height * 0.75;
    const fire = (type, cy) => grip.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 1,
      pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: x, clientY: cy,
    }));
    fire('pointerdown', y);
    // Several moves: the first crosses the drag threshold, the rest track the
    // finger across the row it will be dropped on.
    for (let i = 1; i <= 6; i++) fire('pointermove', y + (endY - y) * (i / 6));
    fire('pointerup', endY);
    return { ok: true };
  })()`);
}

/** Alt+ArrowUp/Down on the focused row (or its grip). */
async function altArrow(videoId, direction = 'down') {
  return browser.eval(`(() => {
    const row = document.querySelector('#queue-drawer [data-queue-row][data-video="${videoId}"]');
    if (!row) return false;
    const grip = row.querySelector('[data-queue-grip]') ?? row.querySelector('[data-action="play-track"]');
    grip.focus({ focusVisible: true });
    grip.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(direction === 'down' ? 'ArrowDown' : 'ArrowUp')},
      code: ${JSON.stringify(direction === 'down' ? 'ArrowDown' : 'ArrowUp')},
      altKey: true, bubbles: true, cancelable: true,
    }));
    return true;
  })()`);
}

// ── (a) the drawer lists the seeded queue ────────────────────────────────

test('a: the queue drawer lists the seeded queue, current track first, with a reorder grip', async (t) => {
  if (!needBrowser(t)) return;
  await seedQueue();

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    await openDrawer();
    const order = await drawerOrder();
    assert.deepEqual(order, TRACKS.map((x) => x.title),
      `the drawer must list the seeded queue in order, got ${JSON.stringify(order)}`);
    assert.equal(await browser.eval(`document.querySelector('#queue-drawer .queue-row.current .queue-mini')
      .getAttribute('data-id')`), TRACKS[0].videoId,
    'the playing track must be the drawer\'s current row');

    // A play target plus a separate grip: no control inside a control, and the
    // grip is named after the track it moves and big enough to hit.
    const shape = await browser.eval(`(() => {
      const row = document.querySelector('#queue-drawer [data-queue-row]');
      const play = row.querySelector('[data-action="play-track"]');
      const grip = row.querySelector('[data-queue-grip]');
      const g = grip?.getBoundingClientRect();
      return {
        nested: play ? play.querySelectorAll('button, input, a[href]').length : -1,
        gripInPlay: Boolean(grip && play?.contains(grip)),
        keepsClasses: Boolean(row.querySelector('.queue-mini'))
          && Boolean(row.querySelector('.queue-mini .queue-text strong'))
          && Boolean(row.querySelector('.queue-mini .duration')),
        label: grip?.getAttribute('aria-label'),
        w: g ? Math.round(g.width) : 0,
        h: g ? Math.round(g.height) : 0,
      };
    })()`);
    assert.equal(shape.nested, 0, 'the play button must not contain another interactive element');
    assert.equal(shape.gripInPlay, false, 'the grip must be a sibling of the play button, not nested in it');
    assert.ok(shape.keepsClasses, '.queue-mini > .queue-text > .duration must survive the row restructure');
    assert.equal(shape.label, `Reorder ${TRACKS[0].title}`, 'the grip needs an aria-label naming the track');
    assert.ok(shape.w >= 44 && shape.h >= 44, `the grip must be a 44x44 touch target, got ${shape.w}x${shape.h}`);

    assert.deepEqual(await ctx.errors(), [], 'the queue drawer logged console errors');
  });
});

// ── (b) pointer drag reorders ────────────────────────────────────────────

test('b: dragging a row reorders the queue, keeps the song playing, and persists', async (t) => {
  if (!needBrowser(t)) return;
  await seedQueue();

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    await resumePlayback();
    const playingBefore = await browser.eval(
      `document.querySelector('#player .player-song-meta strong')?.textContent.trim()`,
    );
    assert.equal(playingBefore, TRACKS[0].title, 'the seeded track is not the one playing');
    await openDrawer();
    assert.deepEqual(await drawerOrder(), TRACKS.map((x) => x.title), 'unexpected starting order');

    // Drag the second row down past the third.
    const drag = await dragRow(TRACKS[1].videoId, 1);
    assert.ok(drag.ok, `the drag could not be started: ${drag.why}`);
    await browser.waitFor(`(() => {
      const rows = [...document.querySelectorAll('#queue-drawer [data-queue-row]')];
      return rows[2]?.dataset.video === ${JSON.stringify(TRACKS[1].videoId)};
    })()`, 4000).catch(() => {});

    const after = await drawerOrder();
    assert.deepEqual(after, [TRACKS[0].title, TRACKS[2].title, TRACKS[1].title],
      `a drag must move the row one slot down; the drawer shows ${JSON.stringify(after)}`);
    assert.deepEqual(await drawerIndexOrder(),
      [TRACKS[0].videoId, TRACKS[2].videoId, TRACKS[1].videoId],
      'the queue itself must hold the new order');

    // The playing song is unchanged and still the drawer's current row.
    assert.equal(await browser.eval(
      `document.querySelector('#player .player-song-meta strong')?.textContent.trim()`,
    ), playingBefore, 'reordering must not change what is playing');
    assert.equal(await browser.eval(`document.querySelector('#queue-drawer .queue-row.current')?.dataset.video`),
      TRACKS[0].videoId, 'the current row must follow the song, not the position');

    // The reorder reached the session (debounced, so poll).
    let persisted = null;
    for (let i = 0; i < 24; i++) {
      const now = await fetchNow();
      const ids = (now.state?.tracks ?? []).map((x) => x.videoId);
      if (ids.join() === [TRACKS[0].videoId, TRACKS[2].videoId, TRACKS[1].videoId].join()) {
        persisted = now.state;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(persisted, 'the reordered queue was never persisted to /api/now');
    assert.equal(persisted.tracks[persisted.index].videoId, TRACKS[0].videoId,
      'the persisted index must still point at the song that is playing');

    // Moving the row that *is* playing keeps it playing.
    const currentDrag = await dragRow(TRACKS[0].videoId, 1);
    assert.ok(currentDrag.ok, `dragging the playing row failed: ${currentDrag.why}`);
    await browser.waitFor(`(() => {
      const rows = [...document.querySelectorAll('#queue-drawer [data-queue-row]')];
      return rows[0]?.dataset.video === ${JSON.stringify(TRACKS[0].videoId)}
        && rows[0]?.dataset.index !== '0';
    })()`, 4000).catch(() => {});
    assert.equal(await browser.eval(
      `document.querySelector('#player .player-song-meta strong')?.textContent.trim()`,
    ), playingBefore, 'moving the playing row must not change the song');
    assert.equal(await browser.eval(`document.querySelector('#queue-drawer .queue-row.current')?.dataset.video`),
      TRACKS[0].videoId, 'the playing row must still be marked current after it moved');

    assert.deepEqual(await ctx.errors(), [], 'dragging a queue row logged console errors');
  });
});

// ── (c) keyboard reorder ─────────────────────────────────────────────────

test('c: Alt+ArrowDown moves the focused row, announces it and keeps focus', async (t) => {
  if (!needBrowser(t)) return;
  await seedQueue();

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    await resumePlayback();
    await openDrawer();
    const before = await drawerOrder();
    assert.deepEqual(before, TRACKS.map((x) => x.title), 'unexpected starting order');

    const sent = await altArrow(TRACKS[1].videoId, 'down');
    assert.ok(sent, 'the second queue row was not rendered');
    await browser.waitFor(`(() => {
      const rows = [...document.querySelectorAll('#queue-drawer [data-queue-row]')];
      return rows[2]?.dataset.video === ${JSON.stringify(TRACKS[1].videoId)};
    })()`, 4000).catch(() => {});

    const after = await drawerOrder();
    assert.deepEqual(after, [before[0], before[2], before[1]],
      `Alt+ArrowDown must move the row one slot down, got ${JSON.stringify(after)}`);
    assert.deepEqual(await drawerIndexOrder(),
      [TRACKS[0].videoId, TRACKS[2].videoId, TRACKS[1].videoId],
      'the queue itself must hold the new order');

    // Not silent: a toast says where it went. (The toast is written after the
    // reorder, and focus is restored a frame later, so both are awaited rather
    // than read on the next statement: a fixed sleep here was the one flaky
    // assertion in this file.)
    await browser.waitFor(`/Moved to position \\d+ of \\d+/
      .test(document.getElementById('toast-text').textContent)`, 4000);
    const toast = await browser.eval(`document.getElementById('toast-text').textContent.trim()`);
    assert.match(toast, /Moved to position \d+ of \d+/,
      `the move was not announced (toast: ${JSON.stringify(toast)})`);

    // The keyboard user keeps their place.
    await browser.waitFor(`(() => {
      const row = document.activeElement.closest?.('[data-queue-row]');
      return row?.dataset.video === ${JSON.stringify(TRACKS[1].videoId)}
        && document.activeElement.hasAttribute('data-queue-grip');
    })()`, 4000).catch(() => {});
    const focused = await browser.eval(`(() => {
      const row = document.activeElement.closest?.('[data-queue-row]');
      return { video: row?.dataset.video ?? null, grip: document.activeElement.hasAttribute('data-queue-grip') };
    })()`);
    assert.equal(focused.video, TRACKS[1].videoId, 'focus must stay on the row that moved');
    assert.equal(focused.grip, true, 'focus must stay on the grip it was on');

    // Plain arrows keep scrolling: no Alt, no reorder.
    const unchanged = await browser.eval(`(() => {
      const snapshot = () => [...document.querySelectorAll('#queue-drawer [data-queue-row]')]
        .map((r) => r.dataset.video).join();
      const was = snapshot();
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
      return was === snapshot();
    })()`);
    assert.ok(unchanged, 'a plain ArrowDown must not reorder the queue (it scrolls)');

    // Moving the first row up is a no-op, and it says so instead of doing nothing.
    await altArrow(TRACKS[0].videoId, 'up');
    assert.match(await browser.eval(`document.getElementById('toast-text').textContent.trim()`),
      /Already at the top of the queue/, 'moving past the top must be announced, not silent');

    assert.deepEqual(await ctx.errors(), [], 'keyboard reordering logged console errors');
  });
});

// ── (d) "Add to queue" ───────────────────────────────────────────────────

test('d: the track menu offers "Add to queue", appends once, and persists', async (t) => {
  if (!needBrowser(t)) return;
  await seedQueue();

  await withPage(browser, BASE, {
    viewport: VIEW.desktop, page: 'playlist', playlistId: PLAYLIST.id,
  }, async (ctx) => {
    await resumePlayback();
    await openDrawer();
    const seeded = await drawerOrder();
    assert.equal(seeded.length, 3, 'the seeded queue is not the three fixture tracks');
    await closeDrawer();

    // The seeded playlist's own track is not one of the three queue fixtures.
    const opened = await browser.eval(`(() => {
      const row = document.querySelector('#page-root .track-row[data-track="${PLAYLIST.track.videoId}"]');
      const more = row?.querySelector('[data-action="track-menu"]');
      if (!more) return null;
      more.click();
      return row.dataset.track;
    })()`);
    assert.ok(opened, 'no track row menu button was rendered on the playlist page');
    await browser.waitFor(`!document.getElementById('context-menu').hidden`, 3000);

    const items = await browser.eval(`[...document.querySelectorAll('#context-menu button')]
      .map((b) => b.textContent.trim())`);
    assert.ok(items.includes('Add to queue'),
      `the track menu must offer "Add to queue", it has ${JSON.stringify(items)}`);
    assert.ok(items.includes('Play next'), 'the existing "Play next" item must stay');

    const clicked = await browser.eval(`(() => {
      const btn = [...document.querySelectorAll('#context-menu button')]
        .find((b) => b.textContent.trim() === 'Add to queue');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    assert.ok(clicked, 'the "Add to queue" menu item was not clickable');
    await browser.waitFor(`document.getElementById('context-menu').hidden`, 3000).catch(() => {});

    await openDrawer();
    const grown = await drawerOrder();
    assert.equal(grown.length, seeded.length + 1,
      `"Add to queue" must append exactly one row (${seeded.length} → ${grown.length})`);
    assert.equal(grown.at(-1), PLAYLIST.track.title,
      `the appended row must be the chosen track, got ${JSON.stringify(grown.at(-1))}`);

    // Persisted: the appended track is the last entry of the session queue.
    let persisted = null;
    for (let i = 0; i < 24; i++) {
      const now = await fetchNow();
      const ids = (now.state?.tracks ?? []).map((x) => x.videoId);
      if (ids.at(-1) === PLAYLIST.track.videoId) { persisted = now.state; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(persisted, 'the appended track was never persisted to /api/now');
    assert.equal(new Set(persisted.tracks.map((x) => x.videoId)).size, persisted.tracks.length,
      'the queue must not contain duplicates');

    // Adding the same song again says so instead of duplicating it.
    await closeDrawer();
    await browser.eval(`(() => {
      const row = document.querySelector('#page-root .track-row[data-track="${PLAYLIST.track.videoId}"]');
      row?.querySelector('[data-action="track-menu"]')?.click();
    })()`);
    await browser.waitFor(`!document.getElementById('context-menu').hidden`, 3000);
    await browser.eval(`[...document.querySelectorAll('#context-menu button')]
      .find((b) => b.textContent.trim() === 'Add to queue').click()`);
    assert.equal(await browser.eval(`document.getElementById('toast-text').textContent.trim()`),
      'Already in the queue', 'adding the same song twice must say so, not duplicate it');
    await openDrawer();
    assert.equal((await drawerOrder()).length, grown.length,
      'adding the same song twice must not grow the queue');

    assert.deepEqual(await ctx.errors(), [], 'adding to the queue logged console errors');
  });
});

// ── (e) the queueFillList preference ─────────────────────────────────────

test('e: with queueFillList off, starting a song does not refill the queue', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    // Off by default: no stored preference record at all.
    await browser.eval(`localStorage.removeItem('sonora.prefs')`);
    await ctx.goto();
    assert.equal(await browser.eval(`localStorage.getItem('sonora.prefs')`), null,
      'a fresh boot must not write a preferences record');

    // A one-track playlist: with the preference off the queue is just that song.
    await nav(browser, 'playlist', { playlistId: PLAYLIST.id });
    await playRow(0, PLAYLIST.track.title);
    const single = await openDrawerUntil(`document.querySelectorAll('#queue-drawer [data-queue-row]').length === 1
      && document.querySelector('#queue-drawer .queue-text strong')?.textContent.trim()
        === ${JSON.stringify(PLAYLIST.track.title)}`);
    assert.ok(single, 'the one-track queue never appeared in the drawer');
    assert.deepEqual(await drawerOrder(), [PLAYLIST.track.title],
      'with the preference off, starting one song must leave a one-track queue');
    await closeDrawer();

    // And from a longer list the clicked song keeps its own position: the queue
    // is the list in its displayed order, nothing is rotated or re-anchored.
    await nav(browser, 'playlist', { playlistId: THREE.id });
    await playRow(1, TRACKS[1].title);
    const listed = await openDrawerUntil(`document.querySelectorAll('#queue-drawer [data-queue-row]').length === 3
      && [...document.querySelectorAll('#queue-drawer [data-queue-row]')]
        .map((r) => Number(r.dataset.index)).join() === '1,2,0'`);
    assert.ok(listed, 'the queue never became the list anchored on the clicked song');
    assert.deepEqual(await drawerIndexOrder(), TRACKS.map((x) => x.videoId),
      'the queue must be the whole list in its own order');
    assert.deepEqual(await drawerSlots(), [1, 2, 0],
      'the clicked song must keep its position in the list (index 1), so the drawer starts there');
    assert.ok(await browser.eval(`[...document.querySelectorAll('#queue-drawer .eyebrow')]
      .some((e) => e.textContent.trim() === 'Earlier')`),
    'with the preference off the tracks before the clicked one are "Earlier", not "up next"');

    assert.deepEqual(await ctx.errors(), [], 'playing from a playlist logged console errors');
  });
});

test('e: queueFillList is a real settings toggle that queues the whole list', async (t) => {
  if (!needBrowser(t)) return;
  // The queue holds nothing but the song about to be started, which is exactly
  // the situation the preference is about.
  await seedQueue([TRACKS[1]], 0);

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    await browser.eval(`localStorage.removeItem('sonora.prefs')`);
    await ctx.goto();

    // Turn it on through the settings sheet, like a person would.
    await browser.eval(`document.querySelector('#profile-button').click()`);
    await browser.waitFor(`!document.querySelector('#profile-menu').hidden`, 3000);
    const opened = await browser.eval(`(() => {
      const btn = document.querySelector('#profile-menu [data-action="settings"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    assert.ok(opened, 'the account menu has no Settings item (data-action="settings")');
    await browser.waitFor(`!document.getElementById('form-overlay').hidden
      && !!document.querySelector('#form-content [data-pref="queueFillList"]')`, 3000);

    // The sheet is data-driven: every key of PREF_META / PREF_DEFAULTS renders,
    // so a new preference needs no edit here.
    const rows = await browser.eval(`[...document.querySelectorAll('#form-content [data-pref]')]
      .map((i) => i.dataset.pref)`);
    assert.deepEqual(rows.sort(), ['desktopAlerts', 'queueFillList'],
      `the settings sheet must render one row per known preference, got ${JSON.stringify(rows)}`);

    const shape = await browser.eval(`(() => {
      const input = document.querySelector('#form-content [data-pref="queueFillList"]');
      const label = input.closest('label');
      const box = label?.getBoundingClientRect();
      return {
        checked: input.checked,
        type: input.type,
        label: label?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
        h: box ? Math.round(box.height) : 0,
      };
    })()`);
    assert.equal(shape.type, 'checkbox', 'a preference must be a real checkbox');
    assert.equal(shape.checked, false, 'queueFillList must be off by default');
    assert.match(shape.label, /Queue the rest of the list when I start a song/,
      `the toggle needs its visible label, got ${JSON.stringify(shape.label)}`);
    assert.match(shape.label, /Starting a song with nothing else queued/,
      'the toggle needs its one-line explanation');
    assert.ok(shape.h >= 44, `the preference row must be a touch target, got ${shape.h}px tall`);

    // Every preference change is announced as `sonora:pref-change`, and the
    // permission prompt is never app.js's job: the module that owns desktop
    // alerts asks, on this event and on the user's gesture. The request is
    // therefore attributed by its stack rather than by counting — one request
    // from /notifications.js is the design, one from /app.js is the bug.
    await browser.eval(`(() => {
      window.__prefEvents = [];
      document.addEventListener('sonora:pref-change', (e) => window.__prefEvents.push(e.detail));
      window.__permStacks = [];
      if (window.Notification?.requestPermission) {
        const real = Notification.requestPermission.bind(Notification);
        Notification.requestPermission = (...a) => {
          window.__permStacks.push(new Error('permission request').stack || '');
          return real(...a);
        };
      }
    })()`);
    assert.deepEqual(await browser.eval(`window.__permStacks.slice()`), [],
      'no permission prompt may be raised while the sheet is merely open');

    await browser.eval(`document.querySelector('#form-content [data-pref="desktopAlerts"]').click()`);
    const alertsEvent = await browser.eval(`window.__prefEvents.at(-1)`);
    assert.deepEqual(alertsEvent, { key: 'desktopAlerts', value: true },
      `turning desktop alerts on must dispatch sonora:pref-change, got ${JSON.stringify(alertsEvent)}`);
    assert.equal(await browser.eval(`JSON.parse(localStorage.getItem('sonora.prefs')).desktopAlerts`), true,
      'desktopAlerts must persist like any other preference');
    assert.equal(await browser.eval(`window.__permStacks.length`), 1,
      'turning desktop alerts on must ask for permission exactly once');
    const permStacks = await browser.eval(`window.__permStacks.slice()`);
    // The *caller* is what matters: app.js dispatches the event synchronously,
    // so it is legitimately lower in the stack. The frame that actually calls
    // requestPermission must be the notifications module, never app.js itself.
    const callers = permStacks.map((s) => String(s).split('\n')
      // The first frame is the recording wrapper itself, so the first frame that
      // names a module is the real caller.
      .find((line) => /\/\w[\w.-]*\.js:\d+/.test(line)) ?? '');
    assert.ok(callers.every((line) => /\/notifications\.js/.test(line)),
      `the prompt must be raised by notifications.js, got:\n${permStacks.join('\n---\n')}`);
    await browser.eval(`document.querySelector('#form-content [data-pref="desktopAlerts"]').click()`);
    assert.deepEqual(await browser.eval(`window.__prefEvents.at(-1)`), { key: 'desktopAlerts', value: false },
      'turning it off must dispatch the same event');

    await browser.eval(`document.querySelector('#form-content [data-pref="queueFillList"]').click()`);
    assert.deepEqual(await browser.eval(`window.__prefEvents.at(-1)`), { key: 'queueFillList', value: true },
      'every preference change must dispatch sonora:pref-change');
    assert.equal(await browser.eval(`JSON.parse(localStorage.getItem('sonora.prefs')).queueFillList`), true,
      'toggling must persist immediately');
    assert.equal(await browser.eval(`document.getElementById('form-overlay').hidden`), false,
      'toggling a preference must not close the sheet');
    assert.equal(await browser.eval(`document.querySelector('#form-content [data-pref="queueFillList"]').checked`), true,
      'the sheet must reflect the new value');
    // Escape still closes the sheet (it is an ordinary overlay).
    await browser.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await browser.waitFor(`document.getElementById('form-overlay').hidden`, 3000).catch(() => {});
    assert.equal(await browser.eval(`document.getElementById('form-overlay').hidden`), true,
      'Escape must close the settings sheet');

    // Start the second song of the list: the queue must become the whole list
    // rotated to start at that song, so nothing sits "Earlier".
    await nav(browser, 'playlist', { playlistId: THREE.id });
    await waitForRows(3);
    const rowIds = await browser.eval(`[...document.querySelectorAll('#page-root .track-row[data-track]')]
      .map((r) => r.dataset.track)`);
    assert.deepEqual(rowIds, TRACKS.map((x) => x.videoId), 'the playlist page did not render the fixture list');
    await playRow(1, TRACKS[1].title);
    const filled = await openDrawerUntil(`document.querySelectorAll('#queue-drawer [data-queue-row]').length === 3
      && [...document.querySelectorAll('#queue-drawer [data-queue-row]')]
        .map((r) => Number(r.dataset.index)).join() === '0,1,2'`);
    assert.ok(filled, 'the queue never became the whole list starting at the chosen song');

    assert.deepEqual(await drawerIndexOrder(),
      [TRACKS[1].videoId, TRACKS[2].videoId, TRACKS[0].videoId],
      'the whole list must be queued, starting at the chosen song and then following the list order');
    assert.deepEqual(await drawerSlots(), [0, 1, 2],
      'with the preference on the queue starts at the chosen song (index 0), so the drawer is ascending');
    assert.deepEqual(await drawerOrder(), [TRACKS[1].title, TRACKS[2].title, TRACKS[0].title],
      'the queue must start with the chosen song and then follow the list order');
    assert.ok(await browser.eval(`![...document.querySelectorAll('#queue-drawer .eyebrow')]
      .some((e) => e.textContent.trim() === 'Earlier')`),
    'with the preference on nothing is "Earlier": the rest of the list is up next');
    assert.equal(await browser.eval(`document.querySelector('#player .player-song-meta strong').textContent.trim()`),
      TRACKS[1].title, 'the chosen song must be the one that starts');
    assert.equal(new Set(await drawerIndexOrder()).size, 3, 'the chosen song must not be duplicated');

    assert.deepEqual(await ctx.errors(), [], 'the queueFillList preference logged console errors');
  });
});

// ── (f) a room owns the queue ────────────────────────────────────────────

test('f: in a room the shared queue cannot be dragged, and the grip says why', async (t) => {
  if (!needBrowser(t)) return;
  await seedQueue();

  const cookie = await loginCookie();
  const created = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ visibility: 'public', control: 'everyone', queue: TRACKS, index: 0, playing: false }),
  });
  if (!created.ok) assert.fail(`room create failed: ${created.status} ${await created.text()}`);
  const room = await created.json();

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    // The browser remembers its room in localStorage and re-attaches on boot.
    await browser.eval(`localStorage.setItem('sonora.room', JSON.stringify({ code: ${JSON.stringify(room.code)}, at: Date.now() }))`);
    await ctx.goto();
    await browser.waitFor(`!document.getElementById('room-pill').hidden`, 10_000);
    await openDrawer();

    const grips = await browser.eval(`[...document.querySelectorAll('#queue-drawer [data-queue-grip]')]
      .map((g) => ({ disabled: g.disabled, label: g.getAttribute('aria-label'), title: g.getAttribute('title') }))`);
    assert.ok(grips.length > 0, 'the drawer must still list the shared queue');
    assert.ok(grips.every((g) => g.disabled),
      'in a room the reorder grip must be disabled: the server owns the order');
    assert.match(String(grips[0].label), /room/i,
      `the disabled grip must explain itself, got ${JSON.stringify(grips[0].label)}`);

    // A drag on the shared queue must do nothing at all.
    const before = await drawerOrder();
    const dragged = await dragRow(TRACKS[0].videoId, 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await drawerOrder(), before,
      `a drag must not reorder the shared room queue (started: ${dragged.ok}, ${dragged.why ?? ''})`);

    // "Add to queue" belongs to the room as well: the shared queue must grow on
    // the server, not only in this tab.
    await closeDrawer();
    await nav(browser, 'playlist', { playlistId: PLAYLIST.id });
    await waitForRows(1);
    await browser.eval(`document.querySelector('#page-root .track-row[data-track] [data-action="track-menu"]').click()`);
    await browser.waitFor(`!document.getElementById('context-menu').hidden`, 3000);
    await browser.eval(`[...document.querySelectorAll('#context-menu button')]
      .find((b) => b.textContent.trim() === 'Add to queue').click()`);
    let shared = null;
    for (let i = 0; i < 24; i++) {
      const res = await fetch(`${BASE}/api/rooms/${room.code}/state`, { headers: { cookie } });
      const snap = await res.json().catch(() => null);
      const ids = (snap?.queue ?? []).map((x) => x.videoId);
      if (ids.includes(PLAYLIST.track.videoId)) { shared = ids; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(shared, 'in a room "Add to queue" must reach the shared queue, not just this tab');
    assert.equal(shared.length, TRACKS.length + 1, `the shared queue must have grown by one: ${JSON.stringify(shared)}`);

    await browser.eval(`localStorage.removeItem('sonora.room')`);
    assert.deepEqual(await ctx.errors(), [], 'opening the queue in a room logged console errors');
  });
});

// ── (g) the now-playing sheet's queue tab is reorderable too ─────────────

test('g: the now-playing sheet\'s Up next tab can be dragged as well', async (t) => {
  if (!needBrowser(t)) return;
  await seedQueue();

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    await resumePlayback();
    await browser.eval(`document.querySelector('#player [data-action="nowplaying"]').click()`);
    await browser.waitFor(`!document.getElementById('now-overlay').hidden`, 5000);
    await browser.eval(`document.querySelector('#now-content [data-overlay-tab="queue"]').click()`);
    await browser.waitFor(`document.querySelectorAll('#now-content .np-next [data-queue-row]').length === 2`, 5000);

    const order = () => browser.eval(`[...document.querySelectorAll('#now-content .np-next [data-queue-row]')]
      .map((r) => r.dataset.video)`);
    assert.deepEqual(await order(), [TRACKS[1].videoId, TRACKS[2].videoId],
      'the Up next tab must list what follows the playing track');

    const drag = await dragRow(TRACKS[1].videoId, 1, '#now-content .np-next');
    assert.ok(drag.ok, `the sheet drag could not be started: ${drag.why}`);
    await browser.waitFor(`(() => {
      const rows = [...document.querySelectorAll('#now-content .np-next [data-queue-row]')];
      return rows[0]?.dataset.video === ${JSON.stringify(TRACKS[2].videoId)};
    })()`, 4000).catch(() => {});
    assert.deepEqual(await order(), [TRACKS[2].videoId, TRACKS[1].videoId],
      'dragging in the sheet must reorder the queue');
    assert.equal(await browser.eval(`document.querySelector('#player .player-song-meta strong').textContent.trim()`),
      TRACKS[0].title, 'reordering from the sheet must not change what is playing');

    // The drawer shows the same queue, in the same new order.
    await browser.eval(`document.querySelector('#now-content [data-action="close-overlay"]').click()`);
    await browser.waitFor(`document.getElementById('now-overlay').hidden`, 3000).catch(() => {});
    await openDrawer();
    assert.deepEqual(await drawerIndexOrder(),
      [TRACKS[0].videoId, TRACKS[2].videoId, TRACKS[1].videoId],
      'both surfaces must render the same reordered queue');

    assert.deepEqual(await ctx.errors(), [], 'dragging in the now-playing sheet logged console errors');
  });
});

// ── (h) a re-render in the middle of a drag ──────────────────────────────

test('h: the drawer re-rendering mid-drag does not lose the drag or throw', async (t) => {
  if (!needBrowser(t)) return;
  await seedQueue();

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    await resumePlayback();
    await openDrawer();

    const fire = (type, videoId, clientY) => `(() => {
      const row = document.querySelector('#queue-drawer [data-queue-row][data-video="${videoId}"]');
      const grip = row?.querySelector('[data-queue-grip]');
      if (!grip) return null;
      const box = grip.getBoundingClientRect();
      const ev = new PointerEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true, composed: true, pointerId: 7,
        pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: box.left + box.width / 2, clientY: ${clientY},
      });
      grip.dispatchEvent(ev);
      return true;
    })()`;

    const start = await browser.eval(`(() => {
      const row = document.querySelector('#queue-drawer [data-queue-row][data-video="${TRACKS[1].videoId}"]');
      const grip = row.querySelector('[data-queue-grip]');
      const box = grip.getBoundingClientRect();
      const y = box.top + box.height / 2;
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
        pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: box.left + box.width / 2, clientY: y }));
      grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true,
        pointerId: 7, pointerType: 'mouse', isPrimary: true, buttons: 1,
        clientX: box.left + box.width / 2, clientY: y + 20 }));
      return { y, dragging: !!document.querySelector('#queue-drawer .queue-row.dragging') };
    })()`);
    assert.ok(start.dragging, 'the drag never started');

    // The app repaints the drawer under the finger (updatePlayer does this on
    // every playback change). The drag must survive it.
    await browser.eval(`document.querySelector('#rail-content [data-action="queue"]').click()`);
    assert.equal(await browser.eval(`document.querySelectorAll('#queue-drawer .queue-row.dragging').length`), 1,
      'the re-rendered drawer must still mark the row as being dragged');

    const finish = await browser.eval(`(() => {
      const row = document.querySelector('#queue-drawer [data-queue-row][data-video="${TRACKS[1].videoId}"]');
      const grip = row?.querySelector('[data-queue-grip]');
      if (!grip) return 'no row after re-render';
      const box = grip.getBoundingClientRect();
      const x = box.left + box.width / 2;
      // Over the row *below* it, past its midpoint: one slot down.
      const below = row.nextElementSibling?.getBoundingClientRect();
      if (!below) return 'no row below';
      const down = below.top + below.height * 0.75;
      grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true,
        pointerId: 7, pointerType: 'mouse', isPrimary: true, buttons: 1, clientX: x, clientY: down }));
      grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true,
        pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: down }));
      return true;
    })()`);
    assert.equal(finish, true, `the drag was lost after the re-render: ${finish}`);

    await browser.waitFor(`(() => {
      const rows = [...document.querySelectorAll('#queue-drawer [data-queue-row]')];
      return rows[2]?.dataset.video === ${JSON.stringify(TRACKS[1].videoId)};
    })()`, 4000).catch(() => {});
    assert.deepEqual(await drawerOrder(), [TRACKS[0].title, TRACKS[2].title, TRACKS[1].title],
      'a drag interrupted by a re-render must still commit where the finger let go');
    assert.deepEqual(await ctx.errors(), [], 'a re-render during a drag threw');
  });
});
