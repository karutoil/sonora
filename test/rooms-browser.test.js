import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, freePort, CHROME } from './helpers/cdp.js';
import { writeSilentM4a } from './helpers/audio-fixture.js';

// Listen Together, driven in two (and then three) real Chromium sessions.
//
// HTTP tests can prove the protocol; only a browser can prove the promise the
// feature is actually making — that two people hear the same second. So this
// suite boots the real app, plays real (silent, local) audio through a real
// <audio> element, and checks the two playheads against each other: after a
// pause, after a seek, and across a track change.
//
// The third session is the anti-feature: a signed-in stranger must see a wall
// instead of a private room's music, and a *guest* (no account at all) must be
// able to listen to a public one.

const DIR = new URL('./.tmp/rooms-browser/', import.meta.url).pathname;
let PORT = 0;
let BASE = '';

// Genuine duration-matched silent AAC/M4A fixtures cannot roll over mid-test and make the
// suite measure the room's (correct) auto-advance instead of the stated behavior.
const TRACKS = [
  { videoId: 'dQw4w9WgXcQ', title: 'Alpha Song', channel: 'The Alphas', durationS: 150 },
  { videoId: '9bZkp7q19f0', title: 'Beta Song', channel: 'The Betas', durationS: 150 },
  { videoId: 'kJQP7kiw5Fk', title: 'Gamma Song', channel: 'The Gammas', durationS: 150 },
];
// What the room is created with, and what the assertions name.
const QUEUE = TRACKS;

let server;
let host;
let guest;
let other;

/**
 * Boot the server. Called again by the restart test: a room's survival across a
 * restart is a real promise (docs/rooms.md), so the suite has to be able to
 * stop and start the process rather than assume it lives forever.
 */
const startServer = async () => {
  const proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: path.join(DIR, 'sonora.db'),
      SONORA_AUDIO_DIR: path.join(DIR, 'audio'),
      SONORA_SECRET: 'rooms-browser-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[rooms-browser] ${d}`));
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
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  if (!CHROME) return;
  fs.rmSync(DIR, { recursive: true, force: true });
  for (const t of TRACKS) writeSilentM4a(path.join(DIR, 'audio', `${t.videoId}.m4a`), { seconds: t.durationS });
  server = await startServer();
  // Three separate profiles: two accounts and one anonymous visitor, each with
  // its own cookie jar, exactly as three different people would be.
  host = await launch(await freePort());
  guest = await launch(await freePort());
  other = await launch(await freePort());
  for (const b of [host, guest, other]) {
    // The app boots from a module script; a thrown render would otherwise be
    // invisible and read as a mysterious missing element.
    await b.addInitScript(`
      window.__errors = [];
      addEventListener('error', (e) => window.__errors.push(String(e.message ?? e.target?.src ?? 'error')));
      addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason?.message ?? e.reason)));
    `);
    await b.viewport({ width: 900, height: 900 });
  }
});

after(() => {
  host?.close();
  guest?.close();
  other?.close();
  try { server?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
});

/** Sign in inside the page, so the browser holds a genuine session cookie. */
const signIn = async (b, name, passphrase, deviceId) => {
  await b.goto(`${BASE}/`);
  const result = await b.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ${JSON.stringify(name)}, passphrase: ${JSON.stringify(passphrase)},
        deviceId: ${JSON.stringify(deviceId)}, deviceName: 'Chromium' }) });
    return { status: r.status, body: await r.json() };
  })()`);
  return result;
};

const apiIn = (b, expression) => b.eval(`(async () => { ${expression} })()`);

const createRoom = (b, options) => apiIn(b, `
  const r = await fetch('/api/rooms', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(${JSON.stringify(options)}) });
  return { status: r.status, body: await r.json() };
`);

/**
 * A trusted click.
 *
 * `element.click()` from a plain Runtime.evaluate is *not* user activation, so
 * a strict autoplay policy correctly refuses the play() it causes — which would
 * make this test pass for the wrong reason (it would look like the page needs
 * no gesture). CDP's `userGesture: true` is what the browser uses for input
 * that came from the UI.
 */
const tap = async (b, selector) => {
  const r = await b.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)}).click()`,
    userGesture: true,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
};

const audioTime = (b) => b.eval(`document.querySelector('audio').currentTime`);
const guestTime = (b) => b.eval(`document.getElementById('listen-audio').currentTime`);

test('two people hear the same second, one with no account at all', { skip: !CHROME && 'chromium not installed' }, async (t) => {
  // ── the host: a real account, the real app ─────────────────────────────
  const login = await signIn(host, 'admin', 'hunter2hunter2', 'host-browser');
  assert.equal(login.status, 200, 'the host signs in');
  const created = await createRoom(host, {
    visibility: 'public', control: 'everyone', playing: true, positionMs: 5000, queue: QUEUE,
  });
  assert.equal(created.status, 200);
  const code = created.body.code;

  await host.goto(`${BASE}/#/room/${code}`);
  await host.waitFor(`!!document.querySelector('[data-room="${code}"]')`, 20_000);
  await host.waitFor(`!document.querySelector('audio').paused`, 20_000);
  const room = await host.eval(`({
    title: document.querySelector('.room-title')?.textContent,
    track: document.querySelector('[data-room-track]')?.textContent,
    queue: [...document.querySelectorAll('.room-queue-row')].length,
    roster: [...document.querySelectorAll('.room-person-name')].map((n) => n.textContent),
    badge: document.querySelector('[data-room-sync]')?.textContent,
    headphones: !!document.querySelector('[data-action="room"]'),
    errors: window.__errors,
  })`);
  assert.match(room.title ?? '', /admin/i, 'the room page names the host');
  assert.match(room.track ?? '', /Alpha Song/, 'and what is playing');
  assert.equal(room.queue, 3, 'and the shared queue');
  assert.ok(room.roster.includes('admin'), 'the host is in the roster');
  assert.deepEqual(room.errors, [], 'the room page rendered without errors');
  await host.waitFor(`/Synced|Syncing|Out of sync/.test(document.querySelector('[data-room-sync]')?.textContent ?? '')`, 15_000);
  const badge = await host.eval(`document.querySelector('[data-room-sync]').textContent`);
  assert.match(badge, /Synced|Syncing|Out of sync/, 'sync is reported as a measurement, not a promise');

  const startedAt = await audioTime(host);
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok((await audioTime(host)) > startedAt + 0.5, 'the playhead advances');

  // ── the guest: no account, no cookie, the link and nothing else ────────
  await guest.goto(`${BASE}/l/${code}/live`);
  await guest.waitFor(`!!document.getElementById('listen-start')`, 15_000);
  const before = await guest.eval(`({
    title: document.getElementById('listen-title').textContent,
    overlay: !document.getElementById('listen-overlay').hidden,
    cookies: document.cookie,
  })`);
  assert.match(before.title, /Alpha Song/, 'the listener page names the track before any script runs');
  assert.ok(!before.cookies.includes('sonora_uid'), 'and holds no session');

  // The page preloads the real source as soon as it has the cookie (the server
  // mints it with the HTML), so whether the room starts by itself depends only
  // on the browser's autoplay policy. Either way it must not need a *second*
  // press: with the overlay gone it is playing, with it up one tap starts it.
  const startedAlone = await guest.eval(`document.getElementById('listen-overlay').hidden && !document.getElementById('listen-audio').paused`);
  if (!startedAlone) {
    assert.equal(before.overlay, true, 'a blocked autoplay leaves a single, obvious start button');
    await guest.eval(`document.getElementById('listen-start').click()`);
  }
  // `currentTime` alone is not proof of playback: the element is preloaded and
  // seeked to the room's position while paused, which is the whole point.
  await guest.waitFor(`!document.getElementById('listen-audio').paused && document.getElementById('listen-audio').currentTime > 0.2`, 25_000);
  // Metadata for the room's source arrives after the (silent) unlock, so the
  // duration is a thing to wait for, not a thing to assume.
  await guest.waitFor(`document.getElementById('listen-audio').duration > 100`, 25_000);
  await guest.waitFor(`/In sync|Sync \\d|Off by/.test(document.getElementById('listen-sync').textContent)`, 20_000);
  // The listener count is a live measurement, not a constant: the document
  // renders it before this guest's stream exists, and the stream's own opening
  // snapshot is what adds the guest to it. Wait for the measurement rather than
  // sampling it in the window before it lands.
  await guest.waitFor(`Number(document.getElementById('listen-listeners').textContent) >= 2`, 20_000);
  const guestView = await guest.eval(`({
    sync: document.getElementById('listen-sync').textContent,
    listeners: Number(document.getElementById('listen-listeners').textContent),
    status: document.getElementById('listen-status').textContent,
    duration: document.getElementById('listen-audio').duration,
    error: document.getElementById('listen-error').hidden ? null : document.getElementById('listen-error').textContent,
  })`);
  assert.equal(guestView.error, null, `the guest page is error-free (${guestView.error})`);
  assert.ok(guestView.duration > 100, `the guest has a real audio duration (${guestView.duration})`);
  assert.ok(guestView.listeners >= 2, `the guest is counted (${guestView.listeners})`);

  const [hostPos, guestPos] = await Promise.all([audioTime(host), guestTime(guest)]);
  assert.ok(Math.abs(hostPos - guestPos) < 1.6,
    `the two playheads agree (host ${hostPos.toFixed(2)}s, guest ${guestPos.toFixed(2)}s)`);

  // ── a pause in the app is a pause in the room ─────────────────────────
  await host.eval(`document.querySelector('[data-room] [data-action="playpause"]').click()`);
  await guest.waitFor(`document.getElementById('listen-audio').paused`, 20_000);
  const [pausedHost, pausedGuest] = await Promise.all([audioTime(host), guestTime(guest)]);
  assert.ok(Math.abs(pausedHost - pausedGuest) < 1.2,
    `they stopped in the same place (${pausedHost.toFixed(2)}s vs ${pausedGuest.toFixed(2)}s)`);
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(await host.eval(`document.querySelector('audio').paused`), 'the host stays paused');
  assert.ok(await guest.eval(`document.getElementById('listen-audio').paused`), 'so does the guest');

  // ── a seek is a seek for everyone, even while paused ──────────────────
  await apiIn(host, `
    const r = await fetch('/api/rooms/${code}/command', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'seek', positionMs: 25000 }) });
    return r.status;
  `);
  await guest.waitFor(`Math.abs(document.getElementById('listen-audio').currentTime - 25) < 1.6`, 20_000);
  const seeked = await guestTime(guest);
  assert.ok(Math.abs(seeked - 25) < 1.6, `the guest followed the seek (${seeked.toFixed(2)}s)`);

  // ── play, then a track change ─────────────────────────────────────────
  await host.eval(`document.querySelector('[data-room] [data-action="playpause"]').click()`);
  await guest.waitFor(`!document.getElementById('listen-audio').paused`, 20_000);
  await apiIn(host, `
    const rev = (await (await fetch('/api/rooms/${code}/state')).json()).rev;
    const r = await fetch('/api/rooms/${code}/command', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'next', rev }) });
    return r.status;
  `);
  await guest.waitFor(`document.getElementById('listen-title').textContent.includes('Beta Song')`, 25_000);
  const afterNext = await guest.eval(`({
    src: document.getElementById('listen-audio').src,
    playing: !document.getElementById('listen-audio').paused,
    sync: document.getElementById('listen-sync').textContent,
  })`);
  assert.match(afterNext.src, /9bZkp7q19f0/, 'the guest switched track');
  assert.equal(afterNext.playing, true, 'and is playing it');
  assert.ok(!/Off by/.test(afterNext.sync), `and stayed in sync across the change (${afterNext.sync})`);
  await host.waitFor(`document.querySelector('[data-room-track]').textContent.includes('Beta Song')`, 20_000);

  // ── ending the room takes the sound with it ───────────────────────────
  await apiIn(host, `return (await fetch('/api/rooms/${code}', { method: 'DELETE', credentials: 'same-origin' })).status;`);
  // The stream announces the end, then the page stops the audio: wait for the
  // announcement (the cause), not for the pause (a consequence that lands a
  // tick later, and can also be the correction loop's doing).
  await guest.waitFor(`document.getElementById('listen-status').textContent.trim() === 'Ended'`, 20_000);
  await guest.waitFor(`document.getElementById('listen-audio').paused`, 10_000);
  const ended = await guest.eval(`({
    status: document.getElementById('listen-status').textContent,
    error: document.getElementById('listen-error').hidden ? null : document.getElementById('listen-error').textContent,
    start: document.getElementById('listen-start').textContent,
  })`);
  assert.ok(ended.error || /Ended/i.test(ended.status), `the guest is told the room ended (${JSON.stringify(ended)})`);
  assert.match(ended.start, /ended/i, 'and cannot restart it');

  await guest.screenshot(path.join(DIR, 'guest-live.png'));
  await host.screenshot(path.join(DIR, 'host-room.png'));
});

test('a private room is a wall for strangers and needs no account to listen when public',
  { skip: !CHROME && 'chromium not installed' }, async (t) => {
    const login = await signIn(host, 'admin', 'hunter2hunter2', 'host-browser');
    assert.equal(login.status, 200);

    const priv = await createRoom(host, {
      visibility: 'private', control: 'host', playing: true, positionMs: 0,
      queue: [QUEUE[0]],
    });
    assert.equal(priv.status, 200);
    const privCode = priv.body.code;

    // The public listener page refuses a private room outright.
    const livePage = await fetch(`${BASE}/l/${privCode}/live`);
    assert.equal(livePage.status, 403, 'no listener page for a private room');
    const landing = await fetch(`${BASE}/l/${privCode}`);
    const landingHtml = await landing.text();
    assert.equal(landing.status, 200);
    assert.ok(!landingHtml.includes('Alpha Song'), 'the landing page never names a private room’s track');

    // A second account, signed in, still gets nothing.
    await apiIn(host, `
      const r = await fetch('/api/admin/users', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ben', passphrase: 'ben-pass-123', role: 'user' }) });
      return r.status;
    `);
    const benLogin = await signIn(other, 'ben', 'ben-pass-123', 'ben-browser');
    assert.equal(benLogin.status, 200, 'the second account signs in');
    await other.goto(`${BASE}/#/room/${privCode}`);
    await other.waitFor(`!!document.querySelector('.room-gate')`, 20_000);
    const gate = await other.eval(`({
      heading: document.querySelector('.room-gate h1')?.textContent,
      join: !!document.querySelector('[data-action="room-join"]'),
      audio: document.querySelector('audio')?.src ?? '',
    })`);
    assert.match(gate.heading ?? '', /private/i, 'a signed-in stranger sees an invite-only wall');
    assert.equal(gate.join, false, 'and no join button');
    assert.equal(gate.audio, '', 'and no audio is loaded');
    await other.screenshot(path.join(DIR, 'ben-private-gate.png'));

    // The same stranger may join a public room, and a paused room stays paused.
    const pub = await createRoom(host, {
      visibility: 'public', control: 'everyone', playing: false, positionMs: 0, queue: [QUEUE[0]],
    });
    const pubCode = pub.body.code;
    await other.goto(`${BASE}/#/room/${pubCode}`);
    await other.waitFor(`!!document.querySelector('[data-action="room-join"]')`, 20_000);
    await other.eval(`document.querySelector('[data-action="room-join"]').click()`);
    await other.waitFor(`!!document.querySelector('[data-room="${pubCode}"]')`, 25_000);
    const joined = await other.eval(`({
      src: document.querySelector('audio')?.src ?? '',
      paused: document.querySelector('audio').paused,
      badge: document.querySelector('[data-room-sync]')?.textContent,
      errors: window.__errors,
    })`);
    assert.match(joined.src, /dQw4w9WgXcQ/, 'joining loads the shared track');
    assert.equal(joined.paused, true, 'and a paused room does not start playing');
    assert.deepEqual(joined.errors, [], 'the joined page is error-free');

    // The host presses play: the joiner starts, from the same position.
    await host.goto(`${BASE}/#/room/${pubCode}`);
    await host.waitFor(`!!document.querySelector('[data-room="${pubCode}"] [data-action="playpause"]')`, 25_000);
    await host.eval(`document.querySelector('[data-room="${pubCode}"] [data-action="playpause"]').click()`);
    await other.waitFor(`!document.querySelector('audio').paused`, 25_000);
    await host.waitFor(`!document.querySelector('audio').paused`, 20_000);
    // A joiner's audio has to buffer before it can seek to the room's position,
    // so convergence is a promise about a second or two, not about the instant
    // `play` returns. Wait for the correction loop to close the gap, then hold
    // it to a tight bound — that is the honest version of "in sync".
    await other.waitFor(`(async () => {
      const a = document.querySelector('audio').currentTime;
      const r = await (await fetch('/api/rooms/${pubCode}/state')).json();
      const target = r.positionMs / 1000;
      return Math.abs(a - target) < 0.6;
    })()`, 25_000);
    const [a, b] = await Promise.all([audioTime(host), audioTime(other)]);
    assert.ok(Math.abs(a - b) < 1.6, `the joiner and the host agree (${a.toFixed(2)}s vs ${b.toFixed(2)}s)`);
    await other.screenshot(path.join(DIR, 'ben-joined.png'));
  });

test('a guest gets one tap, a 5% start and a volume control',
  { skip: !CHROME && 'chromium not installed' }, async (t) => {
    const login = await signIn(host, 'admin', 'hunter2hunter2', 'host-browser');
    assert.equal(login.status, 200);

    // A browser as strict as Safari about autoplay (`--autoplay-policy=
    // document-user-activation-required`): nothing may start without a real
    // gesture, which is exactly the case a guest link has to survive.
    const strict = await launch(await freePort(), { autoplayPolicy: 'document-user-activation-required' });
    try {
      await strict.viewport({ width: 420, height: 900 });
      const room = await createRoom(host, {
        visibility: 'public', control: 'everyone', playing: true, positionMs: 3000, queue: [QUEUE[0]],
      });
      const code = room.body.code;
      await strict.goto(`${BASE}/l/${code}/live`);
      // Under parallel test load a fresh Chromium can take well past 15 s to
      // finish a cold navigate; the timeouts here buy headroom, they do not
      // change what is being asserted.
      await strict.waitFor(`!!document.getElementById('listen-start')`, 30_000);
      // The preload is already in flight by the time we look; give the page a
      // moment to prove it did not start on its own.
      await strict.waitFor(`/Alpha Song/.test(document.getElementById('listen-title').textContent)`, 20_000);
      await new Promise((r) => setTimeout(r, 1200));

      const before = await strict.eval(`({
        volume: document.getElementById('listen-audio').volume,
        slider: document.getElementById('listen-volume').value,
        label: document.getElementById('listen-vol-label').textContent,
        paused: document.getElementById('listen-audio').paused,
        overlay: document.getElementById('listen-overlay').hidden,
        src: document.getElementById('listen-audio').getAttribute('src'),
        error: document.getElementById('listen-error').hidden,
      })`);
      assert.ok(Math.abs(before.volume - 0.05) < 0.001, `the join volume is 5% (${before.volume})`);
      assert.equal(before.slider, '5', 'the control starts at 5%');
      assert.equal(before.label, '5%');
      assert.equal(before.paused, true, 'a strict browser must not autoplay the room');
      assert.equal(before.overlay, false, 'so it shows the start button');
      assert.equal(before.error, true, 'and no error');
      // The cookie came with the page, so the source is real before the tap:
      // that is what makes the tap a plain play() rather than a race.
      assert.match(String(before.src ?? ''), /dQw4w9WgXcQ/, 'the room audio is preloaded before the tap');

      // Exactly one tap — a real one, with user activation.
      await tap(strict, '#listen-start');
      await strict.waitFor(`!document.getElementById('listen-audio').paused && document.getElementById('listen-audio').currentTime > 0.2`, 25_000);
      const after = await strict.eval(`({
        volume: document.getElementById('listen-audio').volume,
        label: document.getElementById('listen-vol-label').textContent,
        overlay: document.getElementById('listen-overlay').hidden,
        error: document.getElementById('listen-error').hidden ? null : document.getElementById('listen-error').textContent,
      })`);
      assert.ok(Math.abs(after.volume - 0.05) < 0.001, `one tap plays at 5% (${after.volume})`);
      assert.equal(after.label, '5%');
      assert.equal(after.overlay, true, `and the overlay is gone (${JSON.stringify(after)})`);
      assert.equal(after.error, null, `with no error (${after.error})`);

      // The volume control: raise, mute, unmute.
      await strict.eval(`(() => { const s = document.getElementById('listen-volume');
        s.value = '42'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const raised = await strict.eval(`({
        volume: document.getElementById('listen-audio').volume,
        label: document.getElementById('listen-vol-label').textContent,
      })`);
      assert.ok(Math.abs(raised.volume - 0.42) < 0.001, `the slider changes the volume (${raised.volume})`);
      assert.equal(raised.label, '42%');

      await strict.eval(`document.getElementById('listen-mute').click()`);
      const muted = await strict.eval(`({
        volume: document.getElementById('listen-audio').volume,
        pressed: document.getElementById('listen-mute').getAttribute('aria-pressed'),
        label: document.getElementById('listen-vol-label').textContent,
      })`);
      assert.equal(muted.volume, 0, 'mute silences it');
      assert.equal(muted.pressed, 'true');
      assert.equal(muted.label, 'Muted');

      await strict.eval(`document.getElementById('listen-mute').click()`);
      const unmuted = await strict.eval(`({
        volume: document.getElementById('listen-audio').volume,
        pressed: document.getElementById('listen-mute').getAttribute('aria-pressed'),
      })`);
      assert.ok(Math.abs(unmuted.volume - 0.42) < 0.001, `unmute restores the level (${unmuted.volume})`);
      assert.equal(unmuted.pressed, 'false');
      await strict.screenshot(path.join(DIR, 'guest-volume.png'));

      // A paused room: the same single tap unlocks the element without making a
      // sound, so the host's later play needs no second tap from the guest.
      const paused = await createRoom(host, {
        visibility: 'public', control: 'everyone', playing: false, positionMs: 0, queue: [QUEUE[0]],
      });
      const pausedCode = paused.body.code;
      await strict.goto(`${BASE}/l/${pausedCode}/live`);
      await strict.waitFor(`!!document.getElementById('listen-start')`, 30_000);
      await tap(strict, '#listen-start');
      // Wait on the real condition (overlay gone) instead of a fixed sleep:
      // under parallel load 2 s was not always enough and the test flaked.
      await strict.waitFor(`document.getElementById('listen-overlay').hidden`, 30_000);
      const waiting = await strict.eval(`({
        paused: document.getElementById('listen-audio').paused,
        volume: document.getElementById('listen-audio').volume,
        overlay: document.getElementById('listen-overlay').hidden,
        error: document.getElementById('listen-error').hidden ? null : document.getElementById('listen-error').textContent,
      })`);
      assert.equal(waiting.paused, true, 'a paused room does not start playing on join');
      assert.ok(Math.abs(waiting.volume - 0.05) < 0.001, 'and it keeps the 5% level');
      assert.equal(waiting.overlay, true, 'and does not ask for a second tap');
      assert.equal(waiting.error, null);

      await host.goto(`${BASE}/#/room/${pausedCode}`);
      await host.waitFor(`!!document.querySelector('[data-room="${pausedCode}"] [data-action="playpause"]')`, 25_000);
      await host.eval(`document.querySelector('[data-room="${pausedCode}"] [data-action="playpause"]').click()`);
      await strict.waitFor(`!document.getElementById('listen-audio').paused && document.getElementById('listen-audio').currentTime > 0.2`, 25_000);
      const started = await strict.eval(`({
        time: document.getElementById('listen-audio').currentTime,
        overlay: document.getElementById('listen-overlay').hidden,
      })`);
      assert.ok(started.time > 0.2, 'the host’s play starts the guest with no second tap');
      assert.equal(started.overlay, true, 'and no resume prompt appears');
      await strict.screenshot(path.join(DIR, 'guest-paused-room.png'));
    } finally {
      strict.close();
    }
  });

test('a room follows what you play, survives a restart and comes back on reload',
  { skip: !CHROME && 'chromium not installed' }, async (t) => {
    const login = await signIn(host, 'admin', 'hunter2hunter2', 'host-browser');
    assert.equal(login.status, 200);

    // A real playlist, made through the API the UI uses, so the test can press
    // the same Play button a person would.
    const playlistId = await apiIn(host, `
      const r = await fetch('/api/playlists', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Room Set' }) });
      const { playlist } = await r.json();
      for (const t of ${JSON.stringify(QUEUE.slice(1))}) {
        await fetch('/api/playlists/' + playlist.id + '/tracks', { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
      }
      return playlist.id;
    `);
    assert.ok(playlistId, 'the playlist exists');

    const created = await createRoom(host, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 0, queue: [QUEUE[0]],
    });
    const code = created.body.code;
    await host.goto(`${BASE}/#/room/${code}`);
    await host.waitFor(`!document.querySelector('audio').paused`, 25_000);
    await guest.goto(`${BASE}/l/${code}/live`);
    await guest.waitFor(`/Alpha Song/.test(document.getElementById('listen-title').textContent)`, 25_000);
    await guest.waitFor(`!document.getElementById('listen-audio').paused`, 25_000);

    // ── pressing Play on a playlist moves the room ────────────────────
    // This is the whole point of "no extra step": the ordinary player is the
    // room's control surface, and the room's queue becomes that playlist.
    await host.goto(`${BASE}/#/c/p${playlistId}`);
    await host.waitFor(`!!document.querySelector('[data-action="play-collection"]')`, 25_000);
    await host.eval(`document.querySelector('[data-action="play-collection"]').click()`);
    await guest.waitFor(`/Beta Song/.test(document.getElementById('listen-title').textContent)`, 25_000);
    await guest.waitFor(`!document.getElementById('listen-audio').paused && document.getElementById('listen-audio').currentTime > 0.2`, 25_000);

    const roomQueue = await apiIn(host, `
      const r = await (await fetch('/api/rooms/${code}/state', { credentials: 'same-origin' })).json();
      return { length: r.queue.length, track: r.track.title, ids: r.queue.map((x) => x.videoId) };
    `);
    assert.equal(roomQueue.track, 'Beta Song', 'the room is now on the playlist');
    assert.equal(roomQueue.length, 2, 'and its queue is the playlist');
    assert.deepEqual(roomQueue.ids, ['9bZkp7q19f0', 'kJQP7kiw5Fk']);

    // ── picking a track from "Up next" moves it too ───────────────────
    await host.goto(`${BASE}/#/home`);
    await host.waitFor(`!!document.querySelector('[data-action="nowplaying"]')`, 25_000);
    await host.eval(`document.querySelector('[data-action="nowplaying"]').click()`);
    await host.waitFor(`!!document.querySelector('[data-overlay-tab="queue"]')`, 15_000);
    await host.eval(`document.querySelector('[data-overlay-tab="queue"]').click()`);
    await host.waitFor(`!!document.querySelector('[data-action="play-track"][data-id="kJQP7kiw5Fk"]')`, 15_000);
    await host.eval(`document.querySelector('[data-action="play-track"][data-id="kJQP7kiw5Fk"]').click()`);
    await guest.waitFor(`/Gamma Song/.test(document.getElementById('listen-title').textContent)`, 25_000);
    const hostErrors = await host.eval(`window.__errors`);
    assert.deepEqual(hostErrors, [], 'the host app raised no errors while following');

    // ── a server restart keeps the room, the queue and the playhead ────
    const before = await apiIn(host, `
      const r = await (await fetch('/api/rooms/${code}/state', { credentials: 'same-origin' })).json();
      return { rev: r.rev, track: r.track.videoId, positionMs: r.positionMs };
    `);
    server.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    server = await startServer();
    const after = await apiIn(host, `
      const r = await fetch('/api/rooms/${code}/state', { credentials: 'same-origin' });
      const body = await r.json();
      return { status: r.status, rev: body.rev, track: body.track?.videoId, positionMs: body.positionMs };
    `);
    assert.equal(after.status, 200, 'the room is still there after a restart');
    assert.equal(after.rev, before.rev, 'with its revision intact');
    assert.equal(after.track, before.track, 'and the same track');
    // The stored playhead is `positionMs + (now - anchorAt)`, so a restart in
    // the middle of a track must not rewind it to the stored position.
    assert.ok(after.positionMs >= before.positionMs - 1000,
      `the playhead did not rewind (${before.positionMs} -> ${after.positionMs})`);

    // The guest's stream reconnects on its own and lands back in sync.
    await guest.waitFor(`!document.getElementById('listen-audio').paused`, 30_000);

    // ── a reload comes back into the room ─────────────────────────────
    const trackBefore = await host.eval(`document.querySelector('[data-room-track]')?.textContent ?? null`);
    await host.goto(`${BASE}/#/room/${code}`);
    await host.waitFor(`!!document.querySelector('[data-room="${code}"]')`, 30_000);
    // The badge is a live measurement, so it starts as "not connected" and
    // settles into a real number once the stream and the clock are back.
    await host.waitFor(`/Synced|Syncing|Out of sync|Paused/.test(document.querySelector('[data-room-sync]')?.textContent ?? '')`, 20_000);
    const rejoined = await host.eval(`({
      track: document.querySelector('[data-room-track]')?.textContent,
      pill: !document.getElementById('room-pill').hidden,
      sync: document.querySelector('[data-room-sync]')?.textContent,
      errors: window.__errors,
    })`);
    assert.equal(rejoined.pill, true, 'the room is still attached after a reload');
    assert.ok(/Gamma Song|Beta Song|Alpha Song/.test(rejoined.track ?? ''), `the room page renders a track (${rejoined.track})`);
    assert.match(rejoined.sync ?? '', /Synced|Syncing|Out of sync|Paused/, 'and reports its sync state');
    assert.deepEqual(rejoined.errors, [], 'with no client errors');
    await host.screenshot(path.join(DIR, 'rejoined.png'));
    if (trackBefore) assert.equal(rejoined.track, trackBefore, 'the same track as before the reload');
  });

// A guest whose *stream* is gone must not become a request pump. Everything
// below rides the polling fallback (`/state` every 3 s), which is exactly the
// path a guest whose SSE died takes — and the one place a room that went
// private (or whose guest cookie expired) used to spin 'Reconnecting…' forever.
test('a guest on the polling fallback reaches a terminal state when the room closes',
  { skip: !CHROME && 'chromium not installed' }, async (t) => {
    const login = await signIn(host, 'admin', 'hunter2hunter2', 'host-browser');
    assert.equal(login.status, 200);

    // The server refuses to establish the guest's stream at all: the
    // constructor throwing is what `openStream` treats as "cannot connect",
    // which is how the page lands on its polling fallback without a network
    // failure having to be staged.
    const dispose = await guest.addInitScript(`
      const RealES = window.EventSource;
      window.EventSource = class extends RealES {
        constructor(url) {
          if (String(url).includes('/events')) {
            throw new TypeError('stream unavailable (test)');
          }
          super(url);
        }
      };
      // Count the polling requests so the test can prove the poller stops
      // rather than trust that a 3 s interval happened not to fire.
      window.__stateFetches = 0;
      // ... and the guest re-mints, which is how a lost/expired cookie is
      // supposed to heal instead of ending the page.
      window.__guestMints = 0;
      const realFetch = window.fetch;
      window.fetch = (...args) => {
        if (String(args[0]).includes('/state')) window.__stateFetches += 1;
        if (String(args[0]).includes('/guest')) window.__guestMints += 1;
        return realFetch(...args);
      };
    `);
    try {
      const room = await createRoom(host, {
        visibility: 'public', control: 'everyone', playing: true, positionMs: 3000, queue: [QUEUE[0]],
      });
      const code = room.body.code;
      await guest.goto(`${BASE}/l/${code}/live`);
      await guest.waitFor(`!!document.getElementById('listen-start')`, 30_000);
      // The badge reads Live either way, so the fallback is proven by its
      // traffic: an established stream makes no /state requests, the poller
      // makes one immediately and one every 3 s.
      await guest.waitFor(`window.__stateFetches >= 2`, 20_000);
      assert.ok(await guest.eval(`window.__stateFetches >= 2`), 'the fallback polls for state');

      // The host closes the door: every poll now answers 403 PRIVATE, which is
      // a terminal answer for a guest — the badge must say so and the polling
      // must stop, not spin as 'Reconnecting…' forever.
      const patch = await apiIn(host, `
        const r = await fetch('/api/rooms/${code}', { method: 'PATCH', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visibility: 'private' }) });
        return r.status;
      `);
      assert.equal(patch, 200, 'the host flips the room private');
      await guest.waitFor(`document.body.dataset.status === 'private'`, 20_000);
      const privated = await guest.eval(`({
        badge: document.getElementById('listen-status').textContent.trim(),
        start: document.getElementById('listen-start').textContent.trim(),
        paused: document.getElementById('listen-audio').paused,
      })`);
      assert.equal(privated.badge, 'Invite only', `the badge reaches the invite-only state (${JSON.stringify(privated)})`);
      assert.equal(privated.start, 'Invite only', 'and the gate does not offer listening');
      assert.equal(privated.paused, true, 'the audio stops with the room');

      // The poller stops: no further /state requests once the terminal answer
      // has been applied (two poll windows of silence is decisive; the old
      // behaviour would have added ~4 more fetches in that span).
      const before = await guest.eval(`window.__stateFetches`);
      await new Promise((r) => setTimeout(r, 7000));
      const after = await guest.eval(`window.__stateFetches`);
      assert.equal(after, before, `the poller stopped (state requests went ${before} -> ${after})`);

      // The other side of the same coin: a guest cookie that is simply *gone*
      // (six hours old, or a cleared jar) must heal rather than end the page.
      // NO_GUEST is recoverable — the client mints one fresh token and carries
      // on — while PRIVATE above is not.
      const room2 = await createRoom(host, {
        visibility: 'public', control: 'everyone', playing: true, positionMs: 3000, queue: [QUEUE[0]],
      });
      await guest.goto(`${BASE}/l/${room2.body.code}/live`);
      await guest.waitFor(`window.__stateFetches >= 2`, 20_000);
      await guest.send('Network.enable');
      const beforeRemint = await guest.eval(`window.__stateFetches`);
      await guest.send('Network.deleteCookies', { name: 'sonora_guest', url: BASE });
      // The next poll answers 403 NO_GUEST, the engine re-mints, and the room
      // is followed again: the fetch counter keeps moving and the badge is not
      // a terminal one.
      await guest.waitFor(`window.__guestMints >= 1`, 20_000);
      await guest.waitFor(`window.__stateFetches > ${beforeRemint + 1}`, 20_000);
      const recovered = await guest.eval(`({
        status: document.body.dataset.status,
        badge: document.getElementById('listen-status').textContent.trim(),
        error: document.getElementById('listen-error').hidden ? null : document.getElementById('listen-error').textContent,
        mints: window.__guestMints,
      })`);
      assert.notEqual(recovered.status, 'ended', `a lost cookie is not the end of the room (${JSON.stringify(recovered)})`);
      assert.notEqual(recovered.status, 'private');
      assert.equal(recovered.badge, 'Live', `the page says it is following the room again (${JSON.stringify(recovered)})`);
      assert.equal(recovered.error, null, 'and shows no terminal error');
      assert.ok(recovered.mints >= 1, 'the guest credential was minted again');
      await guest.screenshot(path.join(DIR, 'guest-terminal.png'));
    } finally {
      dispose();
    }
  });

// The sync engine's own logic, driven in-page (`import('/rooms.js')`) against a
// scripted transport and a fake EventSource: fast, deterministic versions of
// the error-path behaviours that would take minutes of wall-clock play to
// provoke in a real room. The real-server side of these paths is covered above
// and in test/rooms.test.js; what is under test here is the client's.
test('the sync engine survives refused commands, dead streams and stale events',
  { skip: !CHROME && 'chromium not installed' }, async (t) => {
    const login = await signIn(host, 'admin', 'hunter2hunter2', 'host-browser');
    assert.equal(login.status, 200);
    const room = await createRoom(host, {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 3000, queue: [QUEUE[0]],
    });
    assert.equal(room.status, 200);

    // Any real page will do as the host for the module context.
    await host.goto(`${BASE}/#/room/${room.body.code}`);
    await host.waitFor(`!!document.querySelector('[data-room="${room.body.code}"]')`, 30_000);

    const out = await host.eval(`(async () => {
      const mod = await import('/rooms.js');
      const log = { streams: 0, status: [], commands: [], seeks: [], snapshotRevs: [], notes: [] };

      // A scriptable stand-in for the browser's EventSource: it never fires on
      // its own; the test drives onopen/onerror/event delivery by hand.
      const streams = [];
      class FakeES {
        constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; streams.push(this); }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); }
        close() { this.readyState = 2; }
      }
      FakeES.CONNECTING = 0; FakeES.OPEN = 1; FakeES.CLOSED = 2;
      const RealES = window.EventSource;
      window.EventSource = FakeES;

      // A transport that answers every read from the canned snapshot and every
      // command from a policy the scenarios swap in.
      const TRACK = { videoId: 'dQw4w9WgXcQ', title: 'Unit Song', channel: '', thumb: null, durationS: 150 };
      let rev = 10;
      let positionMs = 3000;
      const snap = (over = {}) => ({
        code: 'unitroom01', host: { id: 1, name: 'h' }, visibility: 'public', control: 'everyone',
        joined: true, rev, now: Date.now(), at: Date.now(), positionMs, playing: false,
        ended: false, index: 0, queue: [TRACK], track: TRACK, members: [], guests: 0, listeners: 1, ...over,
      });
      let behavior = null;
      const api = async (path, opts = {}) => {
        const method = opts.method ?? 'GET';
        if (method === 'GET') log.gets = (log.gets ?? 0) + 1;
        if (method === 'POST') {
          log.commands.push({ type: opts.body?.type, auto: Boolean(opts.body?.auto) });
        }
        if (behavior) return behavior(path, method, opts);
        return snap();
      };
      const httpError = (status, code, message) => {
        const err = new Error(message);
        err.status = status;
        err.body = { error: message, code };
        return err;
      };

      let currentId = null;
      const hooks = {
        currentTrackId: () => currentId,
        isLoaded: (id) => id === currentId,
        loadTrack: (s) => { currentId = s.track?.videoId ?? currentId; log.loads = (log.loads ?? 0) + 1; },
        seek: (s) => log.seeks.push(s),
        play: () => { log.plays = (log.plays ?? 0) + 1; }, pause: () => {}, setRate: () => {},
        onSnapshot: (s) => log.snapshotRevs.push(s?.rev),
        onStatus: (s) => log.status.push(s.status),
        onDrift: () => {}, notify: (m, l) => log.notes.push({ m, l }),
      };
      // The correction loop only ever reads these four properties, so a plain
      // object is a faithful (and controllable) audio element for a unit test.
      const fakeAudio = (over = {}) => ({ paused: true, currentTime: 0, playbackRate: 1, ...over });
      const fresh = () => {
        const sync = mod.createRoomSync({ api, audio: document.createElement('audio'), hooks });
        return sync;
      };

      // ── refused auto-next is remembered until the room moves ──────────
      {
        const sync = fresh();
        await sync.load('unitroom01');
        behavior = (path, method) => {
          if (method === 'POST') throw httpError(403, 'NOT_ENDED', 'That track has not finished yet.');
          return snap();
        };
        await sync.command('next', { auto: true });
        await sync.command('next', { auto: true });
        await sync.command('next', { auto: true });
        const suppressed = log.commands.filter((c) => c.auto).length;
        await sync.command('next'); // a person pressing next is never suppressed
        const userNext = log.commands.filter((c) => c.type === 'next' && !c.auto).length;
        // The room moving (a state event with a new rev) re-arms auto: the
        // refusal was about *this* playhead, not about auto-advance forever.
        rev = 11; positionMs = 4000;
        streams.at(-1).emit('state', snap());
        await sync.command('next', { auto: true });
        const reArmed = log.commands.filter((c) => c.auto).length;
        await sync.command('next', { auto: true });
        sync.destroy();
        log.autoNext = { firstRev: suppressed, userNext, reArmed, afterNewRev: log.commands.filter((c) => c.auto).length - reArmed };
        log.statusAfterRefusal = log.status.at(-1);
      }

      // ── a live stream recovers its badge, and a retry starts clean ────
      {
        const beforeScenario = streams.length;
        const sync = fresh();
        await sync.load('unitroom01');
        const es1 = streams.at(-1);
        // Three blind errors (readyState CONNECTING, the network-blip shape)
        // demote the stream to polling.
        for (let i = 0; i < 3; i += 1) es1.onerror();
        log.fallbackStatus = sync.status;
        // A fresh attempt (what the 30 s retry timer does): the failure count
        // from the dead stream must not ride along, or the new stream is
        // one strike from the same fallback forever.
        await sync.load('unitroom01');
        const es2 = streams.at(-1);
        es2.onerror(); // one hiccup — must survive it now
        log.retrySurvivedOneError = sync.status !== 'polling';
        es2.emit('snapshot', snap());
        log.recoveredStatus = sync.status;
        // A refused command parks the badge on 'error'; the next state the
        // (still live) stream delivers must restore it.
        behavior = (path, method) => {
          if (method === 'POST') throw httpError(403, 'HOST_ONLY', 'Only the host controls this room.');
          return snap();
        };
        await sync.command('seek', { positionMs: 5000 });
        log.afterRefusedCommand = sync.status;
        rev = 12; positionMs = 5500;
        es2.emit('state', snap());
        log.afterNextState = sync.status;
        sync.destroy();
        log.streamAttempts = streams.length - beforeScenario;
        behavior = null;
      }

      // ── a stale state event must not rewind the playhead ─────────────
      {
        rev = 20; positionMs = 60000;
        const sync = fresh();
        await sync.load('unitroom01');
        const es = streams.at(-1);
        es.emit('state', snap({ rev: 18, positionMs: 9000 })); // queued behind a newer answer
        log.staleApplied = sync.room.rev === 18;
        log.stalePosition = sync.positionOf();
        es.emit('state', snap({ rev: 21, positionMs: 61000 })); // genuinely newer
        log.freshApplied = sync.room.rev === 21;
        log.freshPosition = sync.positionOf();
        // A hold armed by a *previous* room must not delay this one's first
        // correction: rejoin the same room with the thumb mid-drag. The
        // observable is the correction itself — a paused room 60 s behind the
        // fresh snapshot gets seeked to it the moment corrections are allowed.
        sync.hold(8000);
        const seeksBefore = log.seeks.length;
        await sync.load('unitroom01');
        log.holdSurvivesReload = log.seeks.length === seeksBefore;
        sync.destroy();
      }

      // ── an older command response must not drag the room back ─────────
      {
        rev = 30; positionMs = 30000;
        currentId = null;
        const sync = fresh();
        await sync.load('unitroom01');
        log.loadsAfterOpen = log.loads ?? 0;
        // Someone else moved the room while this command was in flight; the
        // answer that lost the race describes an older, different room.
        behavior = (path, method) => (method === 'POST'
          ? snap({ rev: 29, index: 1, queue: [TRACK, { ...TRACK, videoId: '9bZkp7q19f0', title: 'Other' }],
            track: { ...TRACK, videoId: '9bZkp7q19f0', title: 'Other' }, positionMs: 1000 })
          : snap());
        await sync.command('seek', { positionMs: 1000 });
        log.staleCommandRev = sync.room.rev;
        log.staleCommandIndex = sync.room.index;
        log.staleCommandReloads = (log.loads ?? 0) - log.loadsAfterOpen;
        behavior = null;
        sync.destroy();
      }

      // ── a track that has ended is paused, not restarted once a second ──
      {
        rev = 40;
        currentId = 'dQw4w9WgXcQ';
        const audio = fakeAudio({ paused: true, currentTime: 150 });
        const seeks = [];
        let plays = 0;
        let localId = 'dQw4w9WgXcQ';
        const endedSnap = snap({ rev: 40, playing: true, positionMs: 150000, ended: false });
        const sync = mod.createRoomSync({
          api: async () => endedSnap,
          audio,
          hooks: {
            ...hooks,
            currentTrackId: () => localId,
            isLoaded: (id) => id === localId,
            loadTrack: (s) => { localId = s.track?.videoId ?? localId; },
            play: () => { plays += 1; },
            seek: (s) => seeks.push(s),
          },
        });
        await sync.load('unitroom01');
        sync.correct(); sync.correct(); sync.correct();
        log.endedPlays = plays;
        log.endedSeeks = seeks.length;
        log.endedMaxSeek = seeks.length ? Math.max(...seeks) : 0;
        log.endedPosition = sync.positionOf();
        sync.destroy();
      }

      // ── a refused auto-next is retried once the boundary has passed ───
      {
        rev = 50; positionMs = 3000;
        currentId = null;
        const autoCount = () => log.commands.filter((c) => c.auto).length;
        const sync = fresh();
        await sync.load('unitroom01');
        behavior = (path, method) => {
          if (method === 'POST') throw httpError(403, 'NOT_ENDED', 'That track has not finished yet.');
          return snap();
        };
        const start = autoCount();
        await sync.command('next', { auto: true }); // refused: 3 s into a 150 s track
        const refused = autoCount();
        await sync.command('next', { auto: true }); // still nowhere near the end
        const suppressed = autoCount();
        // The room's own derived position is now the end, so the refusal no
        // longer describes the playhead this client is looking at.
        streams.at(-1).emit('state', snap({ rev: 50, positionMs: 150000, playing: false, ended: true }));
        await sync.command('next', { auto: true }); // one retry, allowed
        const retried = autoCount();
        behavior = null;
        sync.destroy();
        log.autoRetry = { start, refused, suppressed, retried };
      }

      // ── a full room says so instead of retrying the door forever ──────
      {
        rev = 60; positionMs = 3000;
        currentId = null;
        const sync = fresh();
        // This scenario shares the page with the app's own room sync, so it
        // must look at the stream THIS engine opened, not the last one globally.
        const before = streams.length;
        await sync.load('unitroom01');
        const es = streams.slice(before).at(-1);
        const getsBefore = log.gets ?? 0;
        es.emit('room', { ended: false, error: 'This room has too many listeners.' });
        log.capacityStatus = sync.status;
        log.capacityNotes = log.notes.filter((n) => /too many listeners/.test(n.m)).length;
        await new Promise((r) => setTimeout(r, 150));
        log.capacityClosed = es.readyState === 2;
        log.capacityPolls = (log.gets ?? 0) - getsBefore;
        log.capacityError = sync.error;
        sync.destroy();
      }

      window.EventSource = RealES;
      return log;
    })()`);

    // ── auto-next suppression ─────────────────────────────────────────
    assert.equal(out.autoNext.firstRev, 1, `at most one auto command per rev (${JSON.stringify(out.autoNext)})`);
    assert.equal(out.autoNext.userNext, 1, 'a user-initiated next is never suppressed');
    assert.equal(out.autoNext.reArmed, 2, 'a new rev re-arms auto-next (1 + 1 new)');
    assert.equal(out.autoNext.afterNewRev, 0, 'the next refusal is suppressed again (no request at all)');
    assert.equal(out.statusAfterRefusal, 'error', 'a refused command parks the badge on error');

    // ── stream recovery ───────────────────────────────────────────────
    assert.equal(out.fallbackStatus, 'polling', 'three blind errors demote the stream to polling');
    assert.equal(out.retrySurvivedOneError, true, 'a retry starts with a clean failure count');
    assert.equal(out.recoveredStatus, 'live', 'and the stream carries the room again');
    assert.equal(out.afterRefusedCommand, 'error', 'a refused command parks the badge on error');
    assert.equal(out.afterNextState, 'live', 'the next state from the live stream restores it');
    assert.equal(out.streamAttempts, 2, 'the stream re-established within two attempts');

    // ── stale state and stale holds ───────────────────────────────────
    assert.equal(out.staleApplied, false, 'an out-of-order state event is ignored');
    assert.equal(out.stalePosition, 60000, `the playhead did not jump back (${out.stalePosition})`);
    assert.equal(out.freshApplied, true, 'a genuinely newer state is applied');
    assert.equal(out.freshPosition, 61000, `and moves the playhead forward (${out.freshPosition})`);
    assert.equal(out.holdSurvivesReload, false, 'a hold from the previous visit does not outlive load()');

    // ── an older command response is ignored ──────────────────────────
    assert.equal(out.staleCommandRev, 30, `a stale command response does not rewind the room (${out.staleCommandRev})`);
    assert.equal(out.staleCommandIndex, 0, 'nor change the track it is playing');
    assert.equal(out.staleCommandReloads, 0, 'so the player is not told to load the previous song');

    // ── the end of a track is a pause, not a loop ─────────────────────
    assert.equal(out.endedPosition, 150000, `the derived position is clamped to the duration (${out.endedPosition})`);
    assert.equal(out.endedPlays, 0, 'an ended track is never re-played (play() from the end restarts it)');
    assert.equal(out.endedSeeks, 0, 'and nothing seeks past the end');
    assert.ok(out.endedMaxSeek <= 150, `no correction target exceeds the duration (${out.endedMaxSeek})`);

    // ── an auto-next is retried once the boundary has passed ───────────
    assert.equal(out.autoRetry.refused, out.autoRetry.start + 1, 'the first auto-next is sent');
    assert.equal(out.autoRetry.suppressed, out.autoRetry.refused, 'a second one is suppressed while the boundary is far away');
    assert.equal(out.autoRetry.retried, out.autoRetry.suppressed + 1,
      'and exactly one retry happens once the room says the track ended');

    // ── a full room ends the retry, not the page ──────────────────────
    assert.equal(out.capacityNotes, 1, `the listener is told once (${out.capacityNotes})`);
    assert.equal(out.capacityStatus, 'polling', `and the room keeps following by polling (${out.capacityStatus})`);
    assert.equal(out.capacityClosed, true, 'the unanswered stream is closed instead of retried');
    assert.ok(out.capacityPolls >= 1, `and the room is followed by polling (${out.capacityPolls} state reads)`);
    assert.match(out.capacityError ?? '', /too many listeners/i, `the badge carries the reason (${out.capacityError})`);
  });
