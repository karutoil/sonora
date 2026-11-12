import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, freePort, CHROME } from './helpers/cdp.js';
import { writeSilentM4a } from './helpers/audio-fixture.js';

// The venue view, driven in a real browser.
//
// The venue is a *second way to see the same room*, so almost every assertion
// here is about the two views agreeing rather than about pixels: the same
// track, the same queue, the same clock, the same volume, and no way for a
// guest to acquire authority by switching view. The rest guards the things that
// would make it a gimmick instead of a view: that it is not the default, that
// it is not downloaded until asked for, that it is not chat, and that it does
// not invent people the room does not have.

// A fresh directory per run, outside the repo: this suite writes audio
// fixtures and screenshots, and must not be able to collide with (or clean up
// after) any other suite's scratch space.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-listen-venue-'));
// A free port rather than a fixed one: a crashed run must not be able to squat
// the suite's port and turn a green build red.
let BASE = '';

const SECONDS = 240;
const NAMES = ['Alpha Song', 'Beta Song', 'Gamma Song', 'Delta Song', 'Epsilon Song', 'Zeta Song'];
const IDS = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk', 'fAuT8_dboWo', 'OPf0YbXqDm0', 'CevxZvSJLk8'];
const TRACKS = NAMES.map((title, i) => ({ videoId: IDS[i], title, channel: `Artist ${i + 1}`, durationS: SECONDS }));
const queueOf = (n) => TRACKS.slice(0, n);

let server;
let browser;
let PORT = 0;

before(async () => {
  if (!CHROME) return;
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  for (const t of TRACKS) writeSilentM4a(path.join(DIR, 'audio', `${t.videoId}.m4a`), { seconds: SECONDS });
  const proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: path.join(DIR, 'sonora.db'), SONORA_AUDIO_DIR: path.join(DIR, 'audio'),
      SONORA_SECRET: 'venue-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[listen-venue] ${d}`));
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      const health = r.ok ? await r.json() : null;
      if (health?.pid === proc.pid) { server = proc; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!server) { proc.kill('SIGKILL'); throw new Error('the server did not come up'); }
  browser = await launch(await freePort());
  await browser.addInitScript(`
    window.__errors = [];
    addEventListener('error', (e) => window.__errors.push(String(e.message ?? e.target?.src ?? 'error')));
    addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason?.message ?? e.reason)));
  `);
});

after(() => {
  browser?.close();
  try { server?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
});

const hostCookie = async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2', deviceId: 'venue', deviceName: 'Chromium' }),
  });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
};

const createRoom = async (cookie, body) => {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `room create: ${res.status}`);
  return res.json();
};

/** Open a listener page and wait until the venue is on screen. */
const openVenue = async (code) => {
  await browser.goto(`${BASE}/l/${code}/live`);
  await browser.waitFor(`!!document.getElementById('listen-view-venue')`, 20_000);
  await browser.eval(`document.getElementById('listen-view-venue').click()`);
  await browser.waitFor(`!!document.querySelector('#listen-venue-host .v-figure')`, 20_000);
};

const view = () => browser.eval(`({
  view: document.body.dataset.view,
  pressed: [...document.querySelectorAll('.view-btn')].map((b) => b.getAttribute('aria-pressed')),
  theme: document.querySelector('.venue')?.dataset.theme,
  figures: document.querySelectorAll('#listen-venue-host .v-figure').length,
  host: document.querySelector('#listen-venue-host .v-tag')?.textContent ?? null,
  posters: document.querySelectorAll('#listen-venue-host .v-poster-frames image').length,
  screenArt: document.querySelector('.v-screen-art')?.getAttribute('href') ?? null,
  screenTitle: document.querySelector('.v-screen-title')?.textContent ?? null,
  screenFill: Number(document.querySelector('.v-screen-fill')?.getAttribute('width') ?? 0),
  nowTitle: document.querySelector('.v-now-title')?.textContent ?? null,
  nowSync: document.querySelector('.v-now-sync')?.textContent ?? null,
  transport: document.querySelector('.v-time')?.textContent ?? null,
  bubble: document.querySelector('.v-bubble')?.textContent ?? null,
  playerRows: document.querySelectorAll('#listen-queue .q-row').length,
  playerTitle: document.getElementById('listen-title').textContent,
  layoutShown: getComputedStyle(document.querySelector('.layout')).display !== 'none',
  errors: window.__errors,
  overflowX: document.documentElement.scrollWidth - innerWidth,
})`);

test('the venue is a view, not the default, and costs nothing until asked for',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 30_000,
      index: 1, queue: queueOf(5),
    });

    await browser.viewport({ width: 1280, height: 900 });
    await browser.goto(`${BASE}/l/${room.code}/live`);
    await browser.waitFor(`!!document.querySelector('#listen-queue .q-row.is-now')`, 20_000);

    const initial = await view();
    assert.equal(initial.view, 'player', 'the player is what a guest lands on');
    assert.deepEqual(initial.pressed, ['true', 'false'], 'and the switch says so');
    assert.equal(initial.layoutShown, true, 'the player layout is on screen');
    assert.equal(await browser.eval(`!!document.getElementById('listen-venue-host').children.length`), false,
      'the venue is not mounted before it is asked for');
    assert.deepEqual(initial.errors, []);

    // The venue module is imported on first use: a guest who never opens it
    // never pays for the room, the crowd or the artwork sampling. A dynamic
    // `import()` does not pass through `fetch`, so the browser's own resource
    // timing is the honest witness here.
    const fetched = () => browser.eval(`performance.getEntriesByType('resource')
      .map((e) => e.name).filter((n) => n.includes('listen-venue'))`);
    assert.deepEqual(await fetched(), [], 'and its module has not been requested');

    await browser.eval(`document.getElementById('listen-view-venue').click()`);
    await browser.waitFor(`!!document.querySelector('#listen-venue-host .v-figure')`, 20_000);
    // The playhead is time-varying: it can still read 0 in the instant between
    // the venue mounting and its first progress tick, so wait for the tick
    // instead of racing it.
    await browser.waitFor(`Number(document.querySelector('.v-screen-fill')?.getAttribute('width') ?? 0) > 0`, 5_000);
    const venue = await view();
    assert.equal(venue.view, 'venue');
    assert.deepEqual(venue.pressed, ['false', 'true']);
    assert.equal(venue.layoutShown, false, 'the player layout steps aside');
    assert.deepEqual(venue.errors, [], `no errors (${venue.errors})`);
    assert.equal(venue.overflowX, 0, 'the room fits the window');
    assert.ok((await fetched()).length >= 1, 'the module was fetched on demand');

    // The room shows the same facts the player does — that is the whole point
    // of a second view.
    assert.equal(venue.nowTitle, 'Beta Song', 'the card names the current track');
    assert.equal(venue.screenTitle, 'Beta Song', 'and so does the projector');
    assert.equal(venue.screenArt, `/t/${IDS[1]}/art.jpg`, 'which shows the sleeve, not a placeholder');
    assert.ok(venue.screenFill > 0, 'and carries the playhead');
    assert.equal(venue.host, 'toil', 'the host is the one named person');
    assert.equal(venue.posters, 5, 'the wall is hung with this room’s five sleeves, once each');
    assert.equal(venue.playerTitle, 'Beta Song', 'the player view still agrees');
    assert.equal(venue.playerRows, 4, 'and still holds the queue');

    // Leaving the venue returns to the player without a reload, and without
    // touching the audio (the element is the same one throughout).
    await browser.eval(`document.querySelector('.v-exit').click()`);
    await browser.waitFor(`document.body.dataset.view === 'player'`, 5_000);
    const back = await view();
    assert.equal(back.layoutShown, true, 'the player is back');
    assert.equal(back.playerRows, 4, 'with its queue intact');
    assert.equal(await browser.eval(`document.getElementById('listen-audio').paused`), false,
      'and the sound never stopped');
    assert.deepEqual(back.errors, []);
  });

test('the room is the room: its people, its queue, its themes, and no chat',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'host', playing: true, positionMs: 60_000,
      index: 2, queue: queueOf(6),
    });
    await browser.viewport({ width: 1280, height: 900 });
    await openVenue(room.code);

    // Two more guests, so the crowd has a count to match.
    const guests = [];
    for (let i = 0; i < 2; i += 1) {
      const g = await launch(await freePort());
      await g.goto(`${BASE}/l/${room.code}/live`);
      await g.waitFor(`!document.getElementById('listen-audio').paused`, 30_000);
      guests.push(g);
    }
    // The invariant is that the crowd *is* the room's count — not that it is
    // any particular number, which depends on how fast the other tabs join.
    await browser.waitFor(`(() => {
      const n = Number(document.getElementById('listen-listeners').textContent);
      return n >= 3 && document.querySelectorAll('#listen-venue-host .v-figure').length === Math.min(n, 18);
    })()`, 20_000);
    const crowd = await view();
    const listeners = Number(await browser.eval(`document.getElementById('listen-listeners').textContent`));
    assert.equal(crowd.figures, Math.min(listeners, 18),
      'one figure per listener, not an invented crowd');
    assert.equal(crowd.nowSync, 'Live', 'and the room says what its transport is doing');
    for (const g of guests) g.close();

    // Bubbles are status, never chat: no message is attributed to a person who
    // did not say it, and the only quoted lines are facts the room already has.
    const lines = await browser.eval(`(() => {
      const out = [];
      for (let i = 0; i < 8; i += 1) {
        document.getElementById('listen-venue-queue-toggle'); // keep the page awake
        out.push(document.querySelector('.v-bubble')?.textContent ?? '');
      }
      return out;
    })()`);
    assert.ok(lines.length > 0);
    const spoken = await browser.eval(`document.querySelector('.v-bubble').textContent`);
    assert.match(spoken, /toil is hosting|Up next:|in the room|on the projector|In sync/,
      `a bubble is a status, not a message (${spoken})`);
    assert.doesNotMatch(spoken, /I love|good vibe|hi |hello/i, 'and never pretends to be a person talking');

    // One bubble at a time. The host's bubble hangs on a figure in the *back*
    // layer, so a repaint that only swept the front layer left one behind on
    // every rotation — the room ended up wearing a stack of identical bubbles.
    const bubbleCount = () => browser.eval(`document.querySelectorAll('.v-bubble').length`);
    await new Promise((r) => setTimeout(r, 7_000)); // one rotation (6.5s)
    assert.equal(await bubbleCount(), 1, 'a bubble rotation must replace the last one, not add to it');

    // Themes are a real choice, and they persist for the guest.
    await browser.eval(`document.querySelector('[data-theme-id="concert"]').click()`);
    await browser.waitFor(`document.querySelector('.venue').dataset.theme === 'concert'`, 5_000);
    assert.equal((await view()).theme, 'concert');
    await browser.eval(`document.querySelector('[data-theme-id="room"]').click()`);
    await browser.waitFor(`document.querySelector('.venue').dataset.theme === 'room'`, 5_000);
    const themeButtons = await browser.eval(`[...document.querySelectorAll('[data-theme-id]')].map((b) => b.getAttribute('aria-pressed'))`);
    assert.deepEqual(themeButtons, ['false', 'false', 'true'], 'exactly one style is on');

    // The light follows the record by default, and a guest can take the wheel.
    const auto = await browser.eval(`({
      mode: document.querySelector('.venue').dataset.light,
      hue: Number(document.querySelector('.venue').style.getPropertyValue('--hue')),
    })`);
    assert.equal(auto.mode, 'auto', 'the room is lit by the artwork by default');
    await browser.eval(`(() => {
      const el = document.getElementById('listen-venue-hue');
      el.value = '200';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const manual = await browser.eval(`({
      mode: document.querySelector('.venue').dataset.light,
      hue: Number(document.querySelector('.venue').style.getPropertyValue('--hue')),
      auto: document.querySelector('.v-auto').getAttribute('aria-pressed'),
      saved: JSON.parse(localStorage.getItem('sonora.listen.venue') ?? '{}'),
    })`);
    assert.equal(manual.mode, 'manual', 'the slider takes over');
    assert.equal(manual.hue, 200);
    assert.equal(manual.auto, 'false', 'and Auto says it is off');
    assert.equal(manual.saved.hue, 200, 'the choice is remembered');
    assert.equal(manual.saved.theme, 'room', 'along with the room style');

    // The queue drawer is the player's queue, read-only, in order.
    await browser.eval(`document.getElementById('listen-venue-queue-toggle').click()`);
    await browser.waitFor(`document.getElementById('listen-venue-queue').hidden === false`, 5_000);
    const drawer = await browser.eval(`({
      open: document.getElementById('listen-venue-queue-toggle').getAttribute('aria-expanded'),
      rows: [...document.querySelectorAll('#listen-venue-queue .v-deck-copy strong')].map((n) => n.textContent),
      hasControls: !!document.querySelector('#listen-venue-queue button'),
    })`);
    assert.equal(drawer.open, 'true');
    assert.deepEqual(drawer.rows, ['Delta Song', 'Epsilon Song', 'Zeta Song'], 'the runway, in the room’s order');
    assert.equal(drawer.hasControls, false, 'a guest cannot act on a queue row here either');

    // A venue is a view of one room, so it never offers a transport: no skip,
    // no pause, no seek — only the level, which is this device's own.
    const controls = await browser.eval(`[...document.querySelectorAll('#listen-venue-host button')]
      .map((b) => ({ id: b.id, label: (b.textContent || '').trim(), aria: b.getAttribute('aria-label') || '' }))`);
    // "Player view" is the way back, not a transport: it is excluded by name.
    const transportWords = /^(pause|skip|next|previous|seek)$|^(play|pause|skip|next)\s/i;
    for (const control of controls) {
      assert.doesNotMatch(control.label, transportWords,
        `the venue has no transport control (${JSON.stringify(control)})`);
    }
    const ids = controls.map((c) => c.id);
    assert.ok(!ids.some((id) => /play|pause|next|prev|skip/i.test(id)),
      `and no transport button ids (${ids.join(', ')})`);
    assert.ok(ids.includes('listen-venue-mute'), 'it does have this device’s volume');
  });

test('the venue follows the host in place, and the end of a set still reads as a room',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 0,
      index: 0, queue: queueOf(4),
    });
    await browser.viewport({ width: 1280, height: 900 });
    await openVenue(room.code);
    await browser.eval(`window.__marker = 'still-here'`);
    const before = await view();
    assert.equal(before.screenTitle, 'Alpha Song');

    // A host skip repaints the room — projector, posters, queue — without
    // rebuilding the page under the guest.
    // Relative commands carry the revision they were formed on, so read the room
    // as the host (the public view needs a guest cookie and answers 403 here).
    const state = await (await fetch(`${BASE}/api/rooms/${room.code}/state`, { headers: { cookie } })).json();
    const res = await fetch(`${BASE}/api/rooms/${room.code}/command`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ rev: state.rev, type: 'next' }),
    });
    assert.ok(res.ok);
    await browser.waitFor(`document.querySelector('.v-screen-title')?.textContent === 'Beta Song'`, 20_000);
    const after = await view();
    assert.equal(await browser.eval(`window.__marker`), 'still-here',
      'the room updates in place; the page is not rebuilt');
    assert.equal(after.screenTitle, 'Beta Song', 'the projector follows the host');
    assert.equal(after.nowTitle, 'Beta Song', 'and so does the card');
    assert.equal(after.screenArt, `/t/${IDS[1]}/art.jpg`, 'with the new sleeve');
    assert.deepEqual(after.errors, []);

    // A room with nothing up next is a real state (the last track of a set), and
    // the venue has to read as a room at the end of a night rather than as a
    // broken one: no sleeves ahead on the wall, and a drawer that says so.
    const single = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 0,
      index: 0, queue: queueOf(1),
    });
    await browser.goto(`${BASE}/l/${single.code}/live?view=venue`);
    await browser.waitFor(`document.body.dataset.view === 'venue'
      && !!document.querySelector('#listen-venue-host .v-figure')`, 20_000);
    await browser.eval(`document.getElementById('listen-venue-queue-toggle').click()`);
    const last = await browser.eval(`({
      title: document.querySelector('.v-screen-title').textContent,
      posters: document.querySelectorAll('.v-poster-frames image').length,
      figures: document.querySelectorAll('#listen-venue-host .v-figure').length,
      deck: document.querySelector('.v-deck-queue').textContent.trim(),
      errors: window.__errors,
    })`);
    assert.equal(last.title, 'Alpha Song', 'the last track is still on the screen');
    assert.equal(last.posters, 1, 'and its sleeve is the only one on the wall');
    assert.equal(last.figures, 1, 'the host is still in the room');
    assert.match(last.deck, /last track/i, 'the drawer says there is nothing after it');
    assert.deepEqual(last.errors, []);

    // An ended room keeps its sleeve and its crowd, and stops claiming to be live.
    await fetch(`${BASE}/api/rooms/${single.code}`, { method: 'DELETE', headers: { cookie } });
    await browser.waitFor(`document.querySelector('.venue')?.dataset.ended === '1'`, 20_000);
    const ended = await browser.eval(`({
      ended: document.querySelector('.venue').dataset.ended,
      sub: document.querySelector('.v-now-sub').textContent,
      sync: document.querySelector('.v-now-sync').textContent,
      figures: document.querySelectorAll('#listen-venue-host .v-figure').length,
      gate: document.getElementById('listen-venue-gate').hidden,
      gateLabel: document.querySelector('.v-gate-btn span').textContent,
      gateDisabled: document.querySelector('.v-gate-btn').disabled,
      errors: window.__errors,
    })`);
    assert.equal(ended.ended, '1', 'the room marks itself ended');
    assert.match(ended.sub, /ended/i, 'and says so where the artist would be');
    assert.equal(ended.figures, 1, 'the room keeps its crowd');
    assert.equal(ended.gate, false, 'the gate returns, because it is where the reason lives');
    assert.equal(ended.gateLabel, 'Room ended', 'labelled as an end, not a button to press');
    assert.equal(ended.gateDisabled, true, 'and it cannot be pressed');
    assert.equal(ended.sync, '—', 'with no transport state to claim');
    assert.deepEqual(ended.errors, []);
  });

test('a guest whose autoplay is blocked can still start the room from the venue',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 0,
      index: 0, queue: queueOf(3),
    });

    // The venue hides the player's column, and the player's "listen live"
    // overlay lives in that column. A browser that refuses autoplay (which is
    // the normal case for a first visit) would otherwise leave a guest in the
    // room view with silence and no button at all.
    const strict = await launch(await freePort(), { autoplayPolicy: 'document-user-activation-required' });
    try {
      await strict.addInitScript(`
        window.__errors = [];
        addEventListener('error', (e) => window.__errors.push(String(e.message ?? 'error')));
        addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason?.message ?? e.reason)));
      `);
      await strict.viewport({ width: 1280, height: 900 });
      await strict.goto(`${BASE}/l/${room.code}/live?view=venue`);
      await strict.waitFor(`document.body.dataset.view === 'venue'
        && !!document.querySelector('#listen-venue-host .v-figure')`, 20_000);
      await strict.waitFor(`document.getElementById('listen-venue-gate').hidden === false`, 20_000);
      const gated = await strict.eval(`({
        label: document.querySelector('.v-gate-btn span').textContent,
        disabled: document.querySelector('.v-gate-btn').disabled,
        paused: document.getElementById('listen-audio').paused,
        note: document.querySelector('.v-gate-note').textContent,
        playerOverlay: !document.getElementById('listen-overlay').hidden,
      })`);
      assert.equal(gated.label, 'Listen live', 'the room offers the same one tap');
      assert.equal(gated.disabled, false, 'and it is usable');
      assert.equal(gated.paused, true, 'nothing is playing yet');
      assert.match(gated.note, /needs a tap/, 'the gate explains itself');
      assert.equal(gated.playerOverlay, true, 'the player overlay is gated too, just hidden');

      // A trusted gesture, not a synthetic `click()`: the policy under test is
      // precisely "does a real tap unlock this element", and `eval`-ing a click
      // is not a user activation.
      const tapped = await strict.send('Runtime.evaluate', {
        expression: `document.getElementById('listen-venue-start').click()`,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true,
      });
      assert.equal(tapped.exceptionDetails ?? null, null, 'the tap runs');
      await strict.waitFor(`!document.getElementById('listen-audio').paused`, 20_000);
      await strict.waitFor(`document.getElementById('listen-venue-gate').hidden === true`, 10_000);
      const playing = await strict.eval(`({
        paused: document.getElementById('listen-audio').paused,
        gate: document.getElementById('listen-venue-gate').hidden,
        view: document.body.dataset.view,
        errors: window.__errors,
      })`);
      assert.equal(playing.paused, false, 'the room is playing');
      assert.equal(playing.gate, true, 'and the gate is gone');
      assert.equal(playing.view, 'venue', 'without leaving the room view');
      assert.deepEqual(playing.errors, []);
    } finally {
      strict.close();
    }
  });

test('the venue is remembered across visits, and a ?view=venue link opens it for one visit',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 0, index: 0, queue: queueOf(3),
    });

    // Remembered: a reload comes back to the venue, in the same style.
    await browser.viewport({ width: 1280, height: 900 });
    await openVenue(room.code);
    await browser.eval(`document.querySelector('[data-theme-id="concert"]').click()`);
    await browser.waitFor(`document.querySelector('.venue').dataset.theme === 'concert'`, 5_000);
    // Wait for the choice to be *written*, not just applied: the assertion below
    // is about what a reload reads back.
    await browser.waitFor(`JSON.parse(localStorage.getItem('sonora.listen.venue') ?? '{}').theme === 'concert'`, 5_000);
    await browser.goto(`${BASE}/l/${room.code}/live`);
    await browser.waitFor(`document.body.dataset.view === 'venue'
      && !!document.querySelector('#listen-venue-host .v-figure')`, 20_000);
    const remembered = await view();
    assert.equal(remembered.view, 'venue', 'the view is remembered');
    assert.equal(remembered.theme, 'concert', 'and so is the room style');

    // The query parameter opens the venue without overwriting the choice.
    await browser.eval(`localStorage.setItem('sonora.listen.view', 'player')`);
    await browser.goto(`${BASE}/l/${room.code}/live?view=venue`);
    await browser.waitFor(`document.body.dataset.view === 'venue'
      && !!document.querySelector('#listen-venue-host .v-figure')`, 20_000);
    assert.equal((await view()).view, 'venue', 'a shared link can open the room');
    assert.equal(await browser.eval(`localStorage.getItem('sonora.listen.view')`), 'player',
      'without making that the guest’s remembered choice');

    // And an unset choice lands on the player, not the venue.
    await browser.eval(`localStorage.removeItem('sonora.listen.view')`);
    await browser.goto(`${BASE}/l/${room.code}/live`);
    await browser.waitFor(`!!document.getElementById('listen-view-venue')`, 20_000);
    assert.equal((await view()).view, 'player', 'the default is still the player');
  });

test('on a phone the room is shown whole, above its cards',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 20_000,
      index: 1, queue: queueOf(5),
    });

    await browser.viewport({ width: 390, height: 844, mobile: true });
    await openVenue(room.code);
    await new Promise((r) => setTimeout(r, 500));

    const layout = await browser.eval(`(() => {
      const scene = document.querySelector('.v-scene').getBoundingClientRect();
      const now = document.getElementById('listen-venue-now').getBoundingClientRect();
      const tools = document.querySelector('.v-tools').getBoundingClientRect();
      const deck = document.querySelector('.v-deck').getBoundingClientRect();
      const stage = document.querySelector('.v-screen-group').getBoundingClientRect();
      return {
        sceneTop: scene.top, sceneBottom: scene.bottom, sceneHeight: scene.height,
        nowTop: now.top, toolsTop: tools.top, deckTop: deck.top,
        stageLeft: stage.left, stageRight: stage.right,
        width: innerWidth,
        overflowX: document.documentElement.scrollWidth - innerWidth,
        figures: document.querySelectorAll('#listen-venue-host .v-figure').length,
        errors: window.__errors,
      };
    })()`);
    // The whole room, not a crop of its corner: the projector is inside the
    // scene's frame, and the cards are stacked underneath it rather than laid
    // over the crowd.
    assert.ok(layout.sceneHeight > 200, `the room has height (${layout.sceneHeight}px)`);
    assert.ok(layout.stageRight <= layout.width + 1 && layout.stageLeft >= -1,
      'the projector screen is inside the frame');
    assert.ok(layout.nowTop >= layout.sceneBottom - 1, 'the now-playing card is under the room');
    assert.ok(layout.toolsTop > layout.nowTop, 'the tools follow it');
    assert.ok(layout.deckTop > layout.toolsTop, 'and the deck comes last');
    assert.equal(layout.overflowX, 0, 'no horizontal scroll');
    assert.ok(layout.figures >= 1, 'the crowd is drawn');
    assert.deepEqual(layout.errors, []);
  });
