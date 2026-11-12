import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, freePort, CHROME } from './helpers/cdp.js';
import { writeSilentM4a } from './helpers/audio-fixture.js';

// The listener page, driven in a real browser.
//
// `test/rooms.test.js` proves the page arrives with its running order in the
// HTML. Only a browser can prove the rest of the promise this surface makes: a
// guest with no account can see what is playing, what follows, what already
// played and what the room is — and all of it stays true while the host moves
// the playhead under them, on a desktop and on a phone.
//
// The suite is deliberately about *information* rather than sync (that is
// rooms-browser.test.js): the failure this guards against is a page that is
// technically in sync but reads as a bare player.

// A fresh directory per run, outside the repo: this suite writes audio
// fixtures and screenshots, and must not be able to collide with (or clean up
// after) any other suite's scratch space.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-listen-page-'));
// A free port rather than a fixed one: a crashed run must not be able to squat
// the suite's port and turn a green build red.
let BASE = '';

// Silent fixtures. 4 minutes each so a full queue is measured in hours and no
// assertion races the room's (correct) auto-advance.
const SECONDS = 240;
const NAMES = ['Alpha Song', 'Beta Song', 'Gamma Song', 'Delta Song', 'Epsilon Song',
  'Zeta Song', 'Eta Song', 'Theta Song'];
const IDS = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk', 'fAuT8_dboWo',
  'OPf0YbXqDm0', 'CevxZvSJLk8', 'RgKAFK5djSk', 'JGwWNGJdvx8'];
const TRACKS = NAMES.map((title, i) => ({
  videoId: IDS[i], title, channel: `Artist ${i + 1}`, durationS: SECONDS,
}));
const queueOf = (n) => TRACKS.slice(0, n).map(({ videoId, title, channel, durationS }) => ({
  videoId, title, channel, durationS,
}));

let server;
let browser;
let PORT = 0;

const startServer = async () => {
  const proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: path.join(DIR, 'sonora.db'),
      SONORA_AUDIO_DIR: path.join(DIR, 'audio'),
      SONORA_SECRET: 'listen-page-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[listen-page] ${d}`));
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      const health = r.ok ? await r.json() : null;
      if (health?.pid === proc.pid) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGKILL');
  throw new Error('the server did not come up');
};

before(async () => {
  if (!CHROME) return;
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  for (const t of TRACKS) writeSilentM4a(path.join(DIR, 'audio', `${t.videoId}.m4a`), { seconds: SECONDS });
  server = await startServer();
  browser = await launch(await freePort());
  await browser.addInitScript(`
    window.__errors = [];
    addEventListener('error', (e) => window.__errors.push(String(e.message ?? e.target?.src ?? 'error')));
    addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason?.message ?? e.reason)));
    // Clipboard writes are recorded rather than granted: the assertion is that
    // the page offers the shareable landing link, not that Chromium can paste.
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__copied.push(text); } },
    });
  `);
});

after(() => {
  browser?.close();
  try { server?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
});

/** A host session, over plain HTTP: the listener page never needs one. */
const hostCookie = async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2', deviceId: 'listen-page', deviceName: 'Chromium' }),
  });
  assert.equal(res.status, 200, 'the host signs in');
  return (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
};

const createRoom = async (cookie, body) => {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `room create: ${res.status} ${await res.clone().text()}`);
  return res.json();
};

const command = async (cookie, code, body) => {
  // A relative command (next/prev) must carry the revision it was formed on, so
  // the helper reads the room as the commanding member — the public view has no
  // guest cookie here and answers 403.
  const state = await (await fetch(`${BASE}/api/rooms/${code}/state`, { headers: { cookie } })).json();
  const res = await fetch(`${BASE}/api/rooms/${code}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ rev: state.rev, ...body }),
  });
  assert.ok(res.ok, `command ${body.type}: ${res.status}`);
  return res.json();
};

/** Everything a listener is supposed to be able to read off the page. */
const view = (b) => b.eval(`({
  now: document.querySelector('#listen-queue .q-row.is-now strong')?.textContent ?? null,
  nowSub: document.querySelector('#listen-queue .q-row.is-now .q-sub')?.textContent ?? null,
  rows: [...document.querySelectorAll('#listen-queue .q-row:not(.is-now) strong')].map((n) => n.textContent),
  played: [...document.querySelectorAll('#listen-played-list .q-row strong')].map((n) => n.textContent),
  playedOpen: document.getElementById('listen-played').open,
  playedHidden: document.getElementById('listen-played').hidden,
  meta: document.getElementById('listen-queue-meta').textContent,
  count: document.getElementById('listen-queue-count').textContent,
  index: document.getElementById('listen-now-index').textContent,
  title: document.getElementById('listen-title').textContent,
  nextTitle: document.getElementById('listen-next-title').textContent,
  nextHidden: document.getElementById('listen-next-up').hidden,
  host: document.getElementById('listen-room-host').textContent,
  control: document.getElementById('listen-room-control').textContent,
  opened: document.getElementById('listen-room-started').textContent,
  status: document.getElementById('listen-status').textContent.trim(),
  sync: document.getElementById('listen-sync').textContent,
  listeners: document.getElementById('listen-listeners').textContent,
  end: document.getElementById('listen-queue-end').hidden,
  overflowX: document.documentElement.scrollWidth - innerWidth,
  errors: window.__errors,
})`);

test('the listener page reads as a room: current, up next, played and the facts',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    // Mid-way through the fourth of eight tracks: a current, four ahead, three
    // behind, and an hour of queue.
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 60_000,
      index: 3, queue: queueOf(8),
    });

    await browser.viewport({ width: 1280, height: 900 });
    await browser.goto(`${BASE}/l/${room.code}/live`);
    await browser.waitFor(`!!document.querySelector('#listen-queue .q-row.is-now')`, 20_000);
    await browser.waitFor(`!document.getElementById('listen-audio').paused`, 30_000);
    await browser.waitFor(`/In sync|Sync \\d|Off by/.test(document.getElementById('listen-sync').textContent)`, 20_000);

    const v = await view(browser);
    assert.deepEqual(v.errors, [], `no page errors (${v.errors})`);
    assert.equal(v.overflowX, 0, 'nothing overflows sideways');
    assert.equal(v.title, 'Delta Song', 'the now-playing title is the room’s track');
    assert.equal(v.now, 'Delta Song', 'and the queue marks the same row');
    assert.equal(v.nowSub, 'Artist 4', 'with the artist');
    assert.deepEqual(v.rows, ['Epsilon Song', 'Zeta Song', 'Eta Song', 'Theta Song'],
      'the running order is the room’s order, not a guess');
    assert.deepEqual(v.played, ['Gamma Song', 'Beta Song', 'Alpha Song'],
      'and what already played is recoverable, most recent first');
    assert.equal(v.playedHidden, false, 'the played list is offered');
    assert.equal(v.playedOpen, false, 'but collapsed: it is history, not the point');
    assert.match(v.meta, /4 up next/, `the header counts the runway (${v.meta})`);
    assert.match(v.meta, /left/, 'and estimates the time remaining');
    assert.equal(v.count, '8', 'the badge is the whole queue');
    assert.equal(v.index, 'Track 4 of 8', 'the position in the set is stated');
    assert.equal(v.nextTitle, 'Epsilon Song', 'the player side names what follows');
    assert.equal(v.nextHidden, false, 'and shows it');
    assert.equal(v.host, 'toil', 'the room names its host');
    assert.equal(v.control, 'Everyone', 'and its control policy');
    assert.match(v.opened, /Just now|min ago/, 'and how long it has been open');
    assert.equal(v.end, true, 'no end-of-queue note while there is more');
    assert.ok(Number(v.listeners) >= 1, 'the listener count is a number');
    assert.equal(v.status, 'Live', 'the stream is live');

    // Opening the history is a disclosure, not a navigation.
    await browser.eval(`document.getElementById('listen-played').open = true`);
    assert.equal((await view(browser)).played.length, 3, 'the played rows are really there');

    // The share action offers the landing link (which carries the card), not
    // the /live URL this tab happens to be on.
    await browser.eval(`document.getElementById('listen-copy').click()`);
    await browser.waitFor(`document.getElementById('listen-copy').textContent.includes('Copied')`, 5_000);
    assert.deepEqual(await browser.eval(`window.__copied`), [`${BASE}/l/${room.code}`],
      'copying shares the invitation, not the guest view');

    // ── the host moves the room; the guest's page follows in place ────────
    await browser.eval(`window.__marker = 'still-here'`);
    await command(cookie, room.code, { type: 'next' });
    await browser.waitFor(`document.querySelector('#listen-queue .q-row.is-now strong')?.textContent === 'Epsilon Song'`, 20_000);
    const after = await view(browser);
    assert.equal(await browser.eval(`window.__marker`), 'still-here',
      'the queue updates in place; the page is not rebuilt under the listener');
    assert.equal(after.now, 'Epsilon Song', 'the new current track');
    assert.deepEqual(after.played, ['Delta Song', 'Gamma Song', 'Beta Song', 'Alpha Song'],
      'the old one moved into history');
    assert.equal(after.index, 'Track 5 of 8', 'and the position advanced');
    assert.equal(after.nextTitle, 'Zeta Song', 'the up-next card moved with it');
    assert.deepEqual(after.errors, [], `still no errors (${after.errors})`);
    await browser.screenshot(path.join(DIR, 'desktop.png'));

    // A queue that runs out says so, in the queue and on the player side.
    await command(cookie, room.code, { type: 'select', index: 7 });
    await browser.waitFor(`document.getElementById('listen-queue-end').hidden === false`, 20_000);
    const last = await view(browser);
    assert.equal(last.now, 'Theta Song', 'the last track is current');
    assert.deepEqual(last.rows, [], 'with nothing after it');
    assert.equal(last.nextHidden, true, 'so the up-next card is gone');
    assert.match(last.meta, /Last track/, `and the header says so (${last.meta})`);
    assert.match(await browser.eval(`document.getElementById('listen-queue-end').textContent`), /last track/i,
      'with a note that the host can add more');
  });

test('a phone gets the same room, stacked, with a strip that keeps the track in view',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'host', playing: true, positionMs: 10_000,
      index: 1, queue: queueOf(8),
    });

    await browser.viewport({ width: 390, height: 844, mobile: true });
    await browser.goto(`${BASE}/l/${room.code}/live`);
    await browser.waitFor(`!!document.querySelector('#listen-queue .q-row.is-now')`, 20_000);
    await browser.waitFor(`!document.getElementById('listen-audio').paused`, 30_000);
    await new Promise((r) => setTimeout(r, 400));

    const stacked = await browser.eval(`(() => {
      const player = document.getElementById('listen-player').getBoundingClientRect();
      const queue = document.querySelector('.queue-panel').getBoundingClientRect();
      const room = document.querySelector('.room-panel').getBoundingClientRect();
      return { playerBottom: player.bottom, queueTop: queue.top, roomTop: room.top,
        mini: !document.getElementById('listen-mini').hidden,
        nextUp: getComputedStyle(document.getElementById('listen-next-up')).display,
        overflowX: document.documentElement.scrollWidth - innerWidth,
        control: document.getElementById('listen-room-control').textContent };
    })()`);
    assert.ok(stacked.queueTop >= stacked.playerBottom - 1, 'the queue sits under the player');
    assert.ok(stacked.roomTop > stacked.queueTop, 'and the room facts under the queue');
    assert.equal(stacked.mini, false, 'no strip while the player is on screen');
    assert.equal(stacked.nextUp, 'none', 'the duplicate up-next card is dropped on a phone');
    assert.equal(stacked.overflowX, 0, 'no horizontal scroll at 390px');
    assert.equal(stacked.control, 'Host only', 'the policy is stated on the phone too');
    await browser.screenshot(path.join(DIR, 'mobile-top.png'));

    // Scrolling into the queue brings up the persistent strip, so the track
    // does not disappear while the listener reads what is next.
    await browser.eval(`document.querySelector('#listen-queue').scrollIntoView({ block: 'start' })`);
    await browser.waitFor(`!document.getElementById('listen-mini').hidden`, 5_000);
    const strip = await browser.eval(`({
      title: document.getElementById('listen-mini-title').textContent,
      time: document.getElementById('listen-mini-time').textContent,
      bar: document.getElementById('listen-mini-bar').style.width,
    })`);
    assert.equal(strip.title, 'Beta Song', 'the strip names the track that is playing');
    assert.match(strip.time, /^\d+:\d\d \/ 4:00$/, `and its position (${strip.time})`);
    assert.match(strip.bar, /%$/, 'and how far through it is');
    await browser.screenshot(path.join(DIR, 'mobile-queue.png'));

    // Mute is one control, in two places, and they agree.
    await browser.eval(`document.getElementById('listen-mini-mute').click()`);
    const muted = await browser.eval(`({
      volume: document.getElementById('listen-audio').volume,
      mini: document.getElementById('listen-mini-mute').getAttribute('aria-pressed'),
      main: document.getElementById('listen-mute').getAttribute('aria-pressed'),
      label: document.getElementById('listen-vol-label').textContent,
    })`);
    assert.equal(muted.volume, 0, 'the strip mutes the real element');
    assert.equal(muted.mini, 'true');
    assert.equal(muted.main, 'true', 'and the main control agrees');
    assert.equal(muted.label, 'Muted');

    // Scrolling back to the player retires the strip.
    await browser.eval(`window.scrollTo(0, 0)`);
    await browser.waitFor(`document.getElementById('listen-mini').hidden`, 5_000);
  });

test('a room that ends leaves the set list readable and says why the sound stopped',
  { skip: !CHROME && 'chromium not installed' }, async () => {
    const cookie = await hostCookie();
    const room = await createRoom(cookie, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 5_000,
      index: 0, queue: queueOf(4),
    });

    await browser.viewport({ width: 1280, height: 900 });
    await browser.goto(`${BASE}/l/${room.code}/live`);
    await browser.waitFor(`!document.getElementById('listen-audio').paused`, 30_000);

    await fetch(`${BASE}/api/rooms/${room.code}`, { method: 'DELETE', headers: { cookie } });
    await browser.waitFor(`document.getElementById('listen-status').textContent.trim() === 'Ended'`, 20_000);
    await browser.waitFor(`document.getElementById('listen-audio').paused`, 10_000);

    const ended = await browser.eval(`({
      status: document.getElementById('listen-status').textContent.trim(),
      sync: document.getElementById('listen-sync').textContent,
      start: document.getElementById('listen-start').textContent,
      disabled: document.getElementById('listen-start').disabled,
      overlay: !document.getElementById('listen-overlay').hidden,
      error: document.getElementById('listen-error').hidden ? null : document.getElementById('listen-error').textContent,
      rows: document.querySelectorAll('#listen-queue .q-row').length,
      stage: document.getElementById('listen-stage-label').textContent,
    })`);
    assert.equal(ended.status, 'Ended');
    assert.equal(ended.stage, 'Ended', 'the stage says so too, not just the badge');
    assert.equal(ended.sync, '—', 'a badge that cannot measure stops claiming a number');
    assert.match(ended.start, /ended/i, 'the button cannot restart a dead room');
    assert.equal(ended.disabled, true);
    assert.equal(ended.overlay, true);
    assert.match(ended.error ?? '', /ended/i, `the listener is told why (${ended.error})`);
    assert.equal(ended.rows, 4, 'the set list is still there to read');
    await browser.screenshot(path.join(DIR, 'desktop-ended.png'));
  });
