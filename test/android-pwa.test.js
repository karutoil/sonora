import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { monitorProcess } from './helpers/process.js';
import {
  ANDROID_DEVICES, emulateAndroid, readDevice, background, foreground,
  freeze, thaw, network, MEDIA_SESSION_PROBE, readMediaSession, pressMediaAction,
} from './helpers/android.js';

// The PWA, on a phone.
//
// Every other browser suite in this repository is written for "a browser"; this
// one is written for *the device the app is installed on*: an Android phone in
// a standalone window, with a status bar, a navigation bar, five touch points,
// no pointer, no hover, and a screen that can lock while a song is playing.
//
// Two Chromium processes, both emulated as the same Pixel 8 (helpers/android.js):
//
//   * `browser` is a real app window (`--app`), which is the only way Chromium
//     reports a genuine `display-mode: standalone`. Everything about install,
//     layout, offline and passkeys runs there, because that is the window an
//     installed PWA is.
//   * `bg` is the same phone as a normal tab. A headless app window cannot be
//     backgrounded — activating another window leaves it `visible` — and the
//     lock-screen tests are worthless without a real `visibilitychange`. A tab
//     gives the real one (the browser's own hidden transition, not a patched
//     `document.hidden`), which is the state a phone screen-off leaves the
//     renderer in while audio keeps playing.
//
// The audio is real: a 6 s AAC fixture served out of the on-disk audio cache,
// so playback, the Media Session and the end-of-track handoff are the ones a
// listener gets, with no yt-dlp and no YouTube in the loop.

const ROOT = new URL('..', import.meta.url).pathname;
const SILENCE_6S = fileURLToPath(new URL('./fixtures/silent-6.m4a', import.meta.url));
const SHOTS = path.join(ROOT, '.tmp/android');

// Three tracks, three different titles: "did it advance?" has to be answerable
// from the metadata alone. The first carries a real YouTube thumbnail, so the
// artwork the phone is handed is the artwork a real track produces.
const TRACKS = [
  { videoId: 'dQw4w9WgXcQ', title: 'Android Fixture Track One', channel: 'Device Fixture', durationS: 6, thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' },
  { videoId: 'andDevTrk02', title: 'Android Fixture Track Two', channel: 'Device Fixture', durationS: 6, thumb: 'https://i.ytimg.com/vi/andDevTrk02/mqdefault.jpg' },
  { videoId: 'andDevTrk03', title: 'Android Fixture Track Three', channel: 'Device Fixture', durationS: 6, thumb: null },
];

let server;
let tmp;
let browser;
let bg;
let osBrowser;
let bus;
let busAddress;
let BASE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chromium's OS media service on this platform is MPRIS over D-Bus, and it is
 * fed by the same `media_session::MediaSessionImpl` state that Android's media
 * notification is drawn from. Querying it is the closest thing to reading the
 * phone's notification shade that exists without a phone.
 */
function dbusSend(args) {
  return spawnSync('dbus-send', ['--session', '--print-reply', ...args], {
    encoding: 'utf8',
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: busAddress },
    timeout: 5000,
  });
}

/** The first org.mpris.MediaPlayer2 name Chromium has claimed. */
function mprisName() {
  const out = dbusSend(['--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus.ListNames']).stdout ?? '';
  return (out.match(/org\.mpris\.MediaPlayer2\.chromium[^\s"]*/) ?? [])[0] ?? null;
}

function mprisProperty(name, property) {
  return dbusSend([`--dest=${name}`, '/org/mpris/MediaPlayer2',
    'org.freedesktop.DBus.Properties.Get', 'string:org.mpris.MediaPlayer2.Player',
    `string:${property}`]).stdout ?? '';
}

/** Poll an OS media-service property until it holds (or fail with its last value). */
async function waitForMpris(name, property, test, timeout = 10_000) {
  const started = Date.now();
  let raw = '';
  while (Date.now() - started < timeout) {
    raw = mprisProperty(name, property);
    if (test(raw)) return raw;
    await sleep(250);
  }
  throw new Error(`MPRIS ${property} never satisfied the check; last: ${raw.trim().slice(0, 300)}`);
}

/** One login for the whole run: /api/auth/login is rate-limited on purpose. */
let cachedCookie = null;
async function sessionCookie() {
  if (cachedCookie) return cachedCookie;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone', passphrase: 'hunter2hunter2' }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  cachedCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';');
  return cachedCookie;
}

async function loginCookie() {
  return (await sessionCookie())[0];
}

/** Put the three tracks in the on-disk audio cache and in the shared session. */
async function seed(base, dir) {
  const audioDir = path.join(dir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  for (const track of TRACKS) fs.copyFileSync(SILENCE_6S, path.join(audioDir, `${track.videoId}.m4a`));
  await seedPlayer();
}

/**
 * Reset the shared session to the first of the three fixture tracks.
 *
 * Every playback test starts from here: the app persists its own player state,
 * so a test that merely boots the app can leave the shared session on a
 * different track (or empty) and the next test would be asserting against a
 * state it did not create.
 */
async function seedPlayer() {
  const cookie = await loginCookie(BASE);
  const res = await fetch(`${BASE}/api/now`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      queue: TRACKS, index: 0, positionMs: 0, source: 'library', playing: false,
      deviceId: 'android-fixture', deviceName: 'Pixel 8', takeover: true,
    }),
  });
  if (!res.ok) throw new Error(`player seed failed: ${res.status} ${await res.text()}`);
}

/**
 * Boot the installed app signed in.
 *
 * The session is installed as a cookie over CDP rather than by posting to
 * /api/auth/login on every boot: that endpoint is rate-limited (it is the
 * brute-force surface), and a dozen page loads in one run tripped it.
 */
async function bootApp(b = browser) {
  const [pair, ...attributes] = await sessionCookie();
  const at = pair.indexOf('=');
  const flags = attributes.map((a) => a.trim().toLowerCase());
  await b.send('Network.enable').catch(() => {});
  await b.send('Network.setCookie', {
    name: pair.slice(0, at),
    value: pair.slice(at + 1),
    url: BASE,
    path: '/',
    httpOnly: flags.includes('httponly'),
    secure: flags.includes('secure'),
    sameSite: flags.find((f) => f.startsWith('samesite='))?.split('=')[1] ?? 'Lax',
  });
  await b.goto(`${BASE}/`);
  await b.waitFor(`!!document.getElementById('player')`, 20_000);
}

/** Start the seeded queue from the player bar, as a thumb would. */
async function play(b = browser) {
  await b.waitFor(`!!document.querySelector('#player [data-action="playpause"]')`, 15_000);
  await b.eval(`document.querySelector('#player [data-action="playpause"]').click()`);
  try {
    await b.waitFor(`(() => { const a = document.getElementById('audio');
      return a && !a.paused && a.currentTime > 0.3 && Number.isFinite(a.duration); })()`, 30_000);
  } catch (error) {
    throw new Error(`${error.message}\naudio: ${JSON.stringify(await audioState(b))}`);
  }
}

/** Best-effort state dump so a failed wait says why it failed. */
async function audioState(b = browser) {
  try {
    return await b.eval(`(() => { const a = document.getElementById('audio');
      return { paused: a?.paused, time: a?.currentTime, duration: a?.duration,
        src: a?.currentSrc, err: a?.error ? { code: a.error.code, message: a.error.message } : null,
        title: window.__ms?.metadata.at(-1)?.title ?? null,
        toast: document.getElementById('toast-text')?.textContent ?? null,
        pill: document.querySelector('.pwa-pill .pwa-pill-text')?.textContent ?? null,
        visibility: document.visibilityState }; })()`);
  } catch { return null; }
}

async function shot(name, b = browser) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await b.screenshot(path.join(SHOTS, `${name}.png`));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-android-'));
  const port = await freePort();
  // localhost, not 127.0.0.1: WebAuthn binds a credential to a *hostname*, and
  // the server refuses passkeys on a bare IP ("Passkeys are bound to a domain
  // name, not an IP address"). A phone installs sonora from a real hostname, so
  // that is the origin this suite uses.
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(tmp, 'android.db'),
      SONORA_AUDIO_DIR: path.join(tmp, 'audio'),
      SONORA_SECRET: 'android-device-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_USER: 'phone',
      SONORA_LOG_LEVEL: 'warn',
      // No YouTube subprocess may sit in front of a playback assertion.
      SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const monitor = monitorProcess(server);
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));
  let up = false;
  for (let i = 0; i < 160 && !up && !monitor.settled; i++) {
    try { up = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!up && !monitor.settled) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error(`android test server did not start:\n${logs.join('')}`);

  await seed(BASE, tmp);

  if (!CHROME) return;
  browser = await launch(await freePort(), { app: `${BASE}/` });
  await browser.addInitScript(MEDIA_SESSION_PROBE);
  await emulateAndroid(browser, 'pixel8');
  // Android's platform authenticator (fingerprint / face) as WebAuthn sees it.
  await browser.send('WebAuthn.enable');
  await browser.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  bg = await launch(await freePort());
  await bg.addInitScript(MEDIA_SESSION_PROBE);
  await emulateAndroid(bg, 'pixel8');

  // A private session bus, so the OS media-service test can read what Chromium
  // publishes to the desktop (MPRIS) without touching the user's own bus.
  if (spawnSync('sh', ['-c', 'command -v dbus-daemon dbus-send']).status === 0) {
    bus = spawn('dbus-daemon', ['--session', '--print-address', '--nofork'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    busAddress = await new Promise((resolve) => {
      let buffer = '';
      const timer = setTimeout(() => resolve(null), 5000);
      bus.stdout.on('data', (data) => {
        buffer += String(data);
        if (buffer.includes('\n')) { clearTimeout(timer); resolve(buffer.trim()); }
      });
    });
  }
});

after(async () => {
  await browser?.close();
  await bg?.close();
  await osBrowser?.close();
  try { bus?.kill('SIGKILL'); } catch {}
  server?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ── the device ───────────────────────────────────────────────────────────

test('the app boots on a phone that reports itself as an Android device', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await bootApp();
  const d = await readDevice(browser);

  assert.match(d.ua, /Android 14; Pixel 8/, `device UA is not an Android phone: ${d.ua}`);
  assert.match(d.ua, /Mobile Safari/);
  assert.equal(d.platform, 'Android', 'navigator.userAgentData must say Android, not Linux');
  assert.equal(d.mobile, true);
  assert.equal(d.touchPoints, 5, 'without touch points the app takes its desktop paths');
  assert.equal(d.coarse, true, 'pointer: coarse is what the touch-specific CSS hangs off');
  assert.equal(d.hoverNone, true, 'hover-only affordances must still be reachable on a phone');
  assert.equal(d.standalone, true,
    'the installed app must report display-mode: standalone (install banner, full-screen layout)');
  assert.equal(d.dark, true);
  assert.equal(d.dpr, 2.625);
  assert.equal(d.width, 412, '412 dp is the Pixel 8 viewport');
  assert.equal(d.height, 915);
  assert.equal(d.insetTop, 24, 'the status-bar inset the chrome has to clear');
  assert.equal(d.insetBottom, 48, 'the three-button navigation bar inset');

  // Signing in must outlive a cold start: this is the installed app relaunching.
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('.mobile-nav button')`, 20_000);
  const auth = await browser.eval(`!document.getElementById('auth-overlay').hidden`);
  assert.equal(auth, false, 'the installed app asked for the passphrase again after a relaunch');
  await shot('pixel8-home');
});

// ── installability ───────────────────────────────────────────────────────

test('Chromium would install this as an app, with the manifest it reads', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await bootApp();

  const { installabilityErrors } = await browser.send('Page.getInstallabilityErrors');
  assert.deepEqual(installabilityErrors, [],
    `Chromium refuses to install the app: ${JSON.stringify(installabilityErrors)}`);

  const parsed = await browser.send('Page.getAppManifest');
  assert.equal(parsed.errors?.length ?? 0, 0, `manifest parse errors: ${JSON.stringify(parsed.errors)}`);

  // Read the manifest the way the installer does, and check the fields Android
  // and Chrome act on. (Page.getAppManifest reports protocol enums such as
  // `kStandalone`, so the JSON is the source of truth for values.)
  const m = await browser.eval(`fetch('/manifest.webmanifest').then((r) => r.json())`);
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/', 'without a scope Android mints the WebAPK against a directory, not the origin');
  assert.equal(m.id, '/', 'the manifest id is the app identity across updates');
  assert.equal(m.name, 'sonora');
  assert.equal(m.short_name, 'sonora');
  assert.equal(m.theme_color, '#111215');
  assert.equal(m.background_color, '#111215', 'the splash screen colour before the shell paints');
  assert.ok(m.icons.some((i) => i.sizes === '192x192'), 'no 192px icon');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && (i.purpose ?? 'any') === 'any'),
    "no 512px icon (Android's splash screen needs one)");
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'),
    'without a maskable icon Android crops the square icon into its own shape');
  assert.ok((m.shortcuts?.length ?? 0) >= 3, 'home-screen long-press shortcuts are declared');
  // focus-existing: a shortcut tap must not reload the running app (which
  // stops music mid-track); the still-running page consumes ?page= itself.
  assert.equal(m.launch_handler?.client_mode, 'focus-existing');
});

// ── the lock screen (a real background transition) ────────────────────────

test('the lock screen gets artwork, metadata, a seek bar and track buttons', async (t) => {
  if (!bg) return t.skip('no chromium available; set CHROME_BIN to enable');
  await seedPlayer();
  await bootApp(bg);
  await play(bg);

  const session = await readMediaSession(bg);
  const meta = session.log.metadata.at(-1);
  assert.ok(meta, 'nothing was ever published to the OS: there is no lock-screen entry at all');
  assert.equal(meta.title, TRACKS[0].title);
  assert.equal(meta.artist, TRACKS[0].channel);
  assert.equal(meta.album, 'sonora');

  // Artwork must be absolute and same-origin, or the notification drops it
  // silently (iOS renders nothing; Android shows a grey square).
  const [art] = meta.artwork;
  assert.ok(art, 'no artwork published');
  assert.ok(art.src.startsWith(`${BASE}/api/img/`), `artwork must go through the app's own proxy: ${art.src}`);
  // No declared MIME type: /api/img relays the upstream content-type verbatim,
  // so a hardcoded `image/jpeg` is a lie as soon as an upstream answers webp or
  // avif — and a type that disagrees with the bytes is dropped silently (iOS
  // renders nothing, Android shows a grey square), exactly like a wrong `sizes`.
  // Chromium normalises an absent `type` to ''.
  assert.ok(!art.type, `artwork must not declare a MIME type, got ${art.type}`);
  assert.equal(art.sizes, '320x180');

  // A scrubber needs position state; without it the notification has no bar.
  assert.ok(session.log.positions.length > 0, 'no position state: the phone shows no seek bar');
  const pos = session.log.positions.at(-1);
  assert.ok(pos.duration > 0 && pos.position >= 0 && pos.position <= pos.duration,
    `position state outside the media's range throws on the device: ${JSON.stringify(pos)}`);
  assert.ok(!pos.threw, `setPositionState threw: ${pos.threw}`);

  // The buttons the notification actually draws.
  assert.equal(session.log.handlers.play, 'fn');
  assert.equal(session.log.handlers.pause, 'fn');
  assert.equal(session.log.handlers.previoustrack, 'fn',
    'previous/next are what Android shows; iOS replaces them with ±seek when they are missing');
  assert.equal(session.log.handlers.nexttrack, 'fn');
  assert.equal(session.log.handlers.seekto, 'fn');
  assert.equal(session.log.handlers.seekbackward, null, '±seek buttons must not outrank previous/next');
  assert.equal(session.log.handlers.seekforward, null);
  assert.equal(session.log.playbackState, 'playing');
  await shot('pixel8-playing', bg);
});

test('a song ends and the next one starts while the screen is off', async (t) => {
  if (!bg) return t.skip('no chromium available; set CHROME_BIN to enable');
  await seedPlayer();
  await bootApp(bg);
  await play(bg);

  const before = await readMediaSession(bg);
  assert.equal(before.log.metadata.at(-1).title, TRACKS[0].title);
  const handlersBefore = before.log.handlerLog.length;
  const updatesBefore = before.log.updates.length;

  // Lock the phone: another page becomes the active one, which is the real
  // backgrounding a locked screen performs. No patched `document.hidden`.
  const handles = await background(bg);
  const hidden = await readDevice(bg);
  assert.equal(hidden.visibility, 'hidden', 'the app is not backgrounded: nothing below would prove anything');

  // A 6 s fixture: the wrap arrives on its own, no seeking involved.
  try {
    await bg.waitFor(`window.__ms.metadata.at(-1)?.title === ${JSON.stringify(TRACKS[1].title)}`, 30_000);
  } catch (error) {
    throw new Error(`${error.message}\naudio while hidden: ${JSON.stringify(await audioState(bg))}`);
  }

  // The handoff names the new track while it buffers (deliberately, so the
  // notification never goes blank), so wait for it to actually sound.
  try {
    await bg.waitFor(`(() => { const a = document.getElementById('audio');
      return !a.paused && a.currentTime > 0.1; })()`, 30_000);
  } catch (error) {
    throw new Error(`the next track never started playing: ${error.message}\n`
      + `audio while hidden: ${JSON.stringify(await audioState(bg))}`);
  }

  const after = await readMediaSession(bg);
  assert.equal(after.log.metadata.at(-1).title, TRACKS[1].title,
    'the queue did not advance while the app was off screen');
  assert.equal(after.audio.paused, false,
    'the element paused itself across the handoff, which is what ends the audio session on a real phone');
  assert.ok(after.audio.currentTime > 0.1, 'the next track did not actually start playing');
  assert.equal((await readDevice(bg)).visibility, 'hidden', 'the app was never really in the background');

  // The failure this rules out: the notification flipping to "paused" for the
  // whole cold load of the next track, so it reads as "the app died".
  const updates = after.log.updates.slice(updatesBefore);
  assert.equal(updates.includes('state:paused'), false,
    `a background handoff published "paused" to the OS: ${updates.join(' → ')}`);
  assert.ok(updates.includes('metadata'), `the new track was never named: ${updates.join(' → ')}`);

  // And the buttons survive the blackout: the keep-alive re-registers them
  // while hidden, which is what stops a phone losing prev/next.
  assert.ok(after.log.handlerLog.length > handlersBefore,
    'no handler re-registration while hidden: a phone that rebuilds its command set loses prev/next');

  await foreground(bg, handles);
});

test('the notification can skip, pause and seek while the app is off screen', async (t) => {
  if (!bg) return t.skip('no chromium available; set CHROME_BIN to enable');
  await seedPlayer();
  await bootApp(bg);
  await play(bg);

  const handles = await background(bg);
  try {
    const titleBefore = (await readMediaSession(bg)).log.metadata.at(-1).title;

    // Next, as the notification's ⏭ button does.
    await pressMediaAction(bg, 'nexttrack');
    await bg.waitFor(`window.__ms.metadata.at(-1)?.title !== ${JSON.stringify(titleBefore)}`, 20_000);

    // Pause, as the notification's ⏸ button does.
    await pressMediaAction(bg, 'pause');
    await bg.waitFor(`document.getElementById('audio').paused === true`, 10_000);
    const paused = await readMediaSession(bg);
    assert.equal(paused.audio.paused, true, 'pause from the notification did not reach the element');
    assert.equal(paused.log.playbackState, 'paused', 'the phone still shows a playing notification');

    // And play again, still without the app on screen.
    await pressMediaAction(bg, 'play');
    await bg.waitFor(`document.getElementById('audio').paused === false`, 10_000);

    // The scrubber: seeking must move the audio, not the queue.
    const titleNow = (await readMediaSession(bg)).log.metadata.at(-1).title;
    await pressMediaAction(bg, 'seekto', { seekTime: 2 });
    await bg.waitFor(`Math.abs(document.getElementById('audio').currentTime - 2) < 1.5`, 15_000);
    const sought = await readMediaSession(bg);
    assert.equal(sought.log.metadata.at(-1).title, titleNow, 'a seek from the notification skipped the track');
    assert.ok(sought.log.positions.at(-1).position >= 1, 'the seek bar did not follow the seek');
  } finally {
    await foreground(bg, handles);
  }
});

test('freezing the app does not lose the session, and waking it does not double-skip', async (t) => {
  if (!bg) return t.skip('no chromium available; set CHROME_BIN to enable');
  await seedPlayer();
  await bootApp(bg);
  await play(bg);

  // Doze / App Standby for a silent page: the renderer is frozen, JS stops.
  await freeze(bg);
  await new Promise((r) => setTimeout(r, 1500));
  await thaw(bg);

  const thawed = await readMediaSession(bg);
  assert.ok(thawed.log.metadata.at(-1)?.title, 'the media session was empty after the app woke up');
  assert.equal(typeof thawed.log.handlers.nexttrack, 'string',
    'the lock-screen buttons were lost across the freeze');

  // The queue must still be coherent: one press resumes where it was, and the
  // app did not replay or skip a track on wake.
  const titleNow = thawed.log.metadata.at(-1).title;
  await bg.eval(`document.querySelector('#player [data-action="playpause"]').click()`);
  await bg.waitFor(`(() => { const a = document.getElementById('audio'); return !a.paused || a.ended; })()`, 20_000);
  const resumed = await readMediaSession(bg);
  assert.equal(resumed.log.metadata.at(-1).title, titleNow, 'waking the app changed the track');
});

// ── the phone's screen ───────────────────────────────────────────────────

/** What a layout pass cares about: overflow, the two bars, and touch targets. */
const LAYOUT = `(() => {
  const box = (el) => { const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width),
      h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }; };
  const shown = (el) => !!el && el.offsetParent !== null
    && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
  const nav = document.getElementById('mobile-nav');
  const player = document.getElementById('player');
  const targets = [...document.querySelectorAll('#mobile-nav button, #player button, #topbar .icon-btn')]
    .filter(shown)
    .map((b) => ({ label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 18),
      w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }));
  return {
    vw: innerWidth, vh: innerHeight,
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    nav: shown(nav) ? box(nav) : null,
    player: shown(player) ? box(player) : null,
    sidebar: shown(document.querySelector('.sidebar')) ? box(document.querySelector('.sidebar')) : null,
    targets,
    pageTitle: document.title,
  };
})()`;

test('the app fits a phone screen at every size Android ships, portrait and landscape', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await bootApp();
  const measured = [];
  const cases = [
    { name: 'pixel8-portrait', device: 'pixel8', orientation: 'portrait' }, // 412×915
    { name: 'galaxy-portrait', device: 'galaxy', orientation: 'portrait' }, // 360×800
    { name: 'compact-portrait', device: 'compact', orientation: 'portrait' }, // 320×640
    { name: 'pixel8-landscape', device: 'pixel8', orientation: 'landscape' }, // 915×412
  ];
  for (const c of cases) {
    await emulateAndroid(browser, c.device, { orientation: c.orientation });
    await browser.goto(`${BASE}/`);
    await browser.waitFor(`!!document.querySelector('.app')`, 20_000);
    const layout = await browser.eval(LAYOUT);
    measured.push({ case: c.name, ...layout });
    await shot(c.name);

    assert.ok(layout.scrollW <= layout.vw + 1,
      `${c.name}: the page scrolls sideways (${layout.scrollW} > ${layout.vw}), the phone-not-desktop failure`);
    assert.ok(layout.player, `${c.name}: no player bar on a phone`);
    assert.ok(layout.player.bottom <= layout.vh + 1, `${c.name}: the player bar is below the fold`);
    // A landscape phone is 915 dp wide, which is above this app's sidebar
    // breakpoint, so it gets the desktop sidebar instead of the bottom nav.
    // Either is fine; what is not fine is having neither, or a bar on top of
    // the other.
    assert.ok(layout.nav || layout.rail || layout.sidebar,
      `${c.name}: no navigation at all on this screen size`);
    if (layout.nav && layout.player) {
      assert.ok(layout.player.bottom <= layout.nav.y + 1,
        `${c.name}: the player overlaps the bottom navigation (player ${layout.player.bottom} > nav ${layout.nav.y})`);
    }
    if (layout.vw < 811) {
      assert.equal(layout.sidebar, null, `${c.name}: the desktop sidebar is on screen on a phone`);
    }
    // Accessibility floor: on phone viewports (and for the phone topbar/nav
    // controls), Android's guidance is 48 dp and WCAG 2.2's enhanced target is
    // 44 dp. Desktop player controls (which appear in landscape at >=811 dp)
    // use desktop 34 dp mouse metrics.
    const touchTargets = layout.vw < 811
      ? layout.targets
      : layout.targets.filter((x) => !['Shuffle', 'Previous song', 'Play', 'Pause', 'Next song', 'Repeat', 'Open '].some((p) => x.label.startsWith(p)));
    const small = touchTargets.filter((x) => x.h < 44 || x.w < 44);
    assert.deepEqual(small, [], `${c.name}: touch targets under 44 dp: ${JSON.stringify(small)}`);
  }
  // Recorded for the audit: the smallest target measured, and everything that
  // misses the 44 dp comfortable-thumb size.
  const allTargets = measured.flatMap((m) => m.targets.map((x) => ({ case: m.case, ...x })));
  const smallest = allTargets.sort((a, b) => (a.h * a.w) - (b.h * b.w))[0];
  const under44 = allTargets.filter((x) => x.h < 44 || x.w < 44);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, 'layout.json'),
    JSON.stringify({ measured, smallestTarget: smallest, targetsUnder44: under44 }, null, 2));
  await emulateAndroid(browser, 'pixel8');
});

// ── network, offline and deep links ──────────────────────────────────────

test('the shell installs itself, boots with no network, and says what still needs one', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await bootApp();

  // The worker must have precached the shell before any of this is meaningful.
  const active = await browser.eval(`navigator.serviceWorker.ready.then((r) => !!r.active)`);
  assert.equal(active, true, 'no active service worker: the app was never installed as a PWA');
  const cached = await browser.eval(`(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith('sonora-shell-'));
    if (!shell) return { keys, shell: null };
    const cache = await caches.open(shell);
    const paths = (await cache.keys()).map((r) => new URL(r.url).pathname);
    return { keys, shell, paths };
  })()`);
  assert.ok(cached.shell, `no shell cache (caches: ${cached.keys.join(', ')})`);
  for (const path of ['/', '/app.js', '/app.css', '/pwa.js', '/manifest.webmanifest']) {
    assert.ok(cached.paths.includes(path), `the offline shell is missing ${path}: ${cached.paths.length} entries`);
  }

  await network(browser, 'offline');
  try {
    // Offline cold start: the cached shell must paint the app's own offline
    // state — a real screen with a retry — not a browser error page.
    await browser.goto(`${BASE}/`);
    await browser.waitFor(`/Offline · sonora/i.test(document.title)`, 20_000);
    const shell = await browser.eval(`({ title: document.title,
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400),
      retry: !!document.querySelector('[data-action="retry"], #retry'),
      errorPage: /ERR_|chrome-error/.test(document.body.innerHTML) })`);
    assert.match(shell.text, /You are offline/i, `the offline shell says nothing: "${shell.text}"`);
    assert.match(shell.text, /connection to reach YouTube/i,
      'the offline screen must explain *why* it cannot play, not just fail');
    assert.equal(shell.errorPage, false, 'an offline cold start rendered a browser error page');

    await browser.waitFor(`!!document.querySelector('.pwa-pill[data-kind="offline"]')`, 20_000);
    const pill = await browser.eval(`document.querySelector('.pwa-pill[data-kind="offline"] .pwa-pill-text')?.textContent`);
    assert.match(pill, /offline/i, `the app does not tell the listener it is offline: "${pill}"`);
    assert.match(pill, /playback needs a connection/i,
      'the offline pill must admit that playback needs the server, not imply offline listening');
    await shot('offline-shell');

    // The queue lives on the server's disk, not on the phone, so pressing play
    // offline can only fail — it must fail visibly and leave the shell up.
    await browser.eval(`document.querySelector('#player [data-action="playpause"]')?.click()`);
    await new Promise((r) => setTimeout(r, 2500));
    const offlinePlay = await audioState(browser);
    assert.ok(offlinePlay.pill, 'the offline narration disappeared as soon as play was pressed');
    assert.ok(await browser.eval(`!!document.querySelector('.app')`),
      'the shell was lost after an offline play attempt');

    // An offline deep link belongs to the branded offline page, not a blank tab.
    await browser.goto(`${BASE}/t/${TRACKS[0].videoId}`);
    await browser.waitFor(`/sonora — offline/i.test(document.title)`, 20_000);
    const offlinePage = await browser.eval(`({ title: document.title,
      heading: document.querySelector('h1')?.textContent,
      retry: !!document.getElementById('retry') })`);
    assert.match(offlinePage.heading ?? '', /No connection/i);
    assert.equal(offlinePage.retry, true, 'the offline page offers no way back');
    await shot('offline-page');
  } finally {
    await network(browser, 'online');
  }

  // And being back on a network recovers.
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('.mobile-nav button')`, 20_000);
  const recovered = await browser.eval(`fetch('/api/health').then((r) => r.ok)`);
  assert.equal(recovered, true, 'the app did not recover when the network came back');
});

test('a home-screen shortcut and a shared link both land inside the installed app', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await bootApp();

  // "Search" from the long-press menu: /?page=search must open Search, not Home.
  // Judged after boot has settled: the shortcut is consumed while app.js is
  // still starting, and it used to strip the `#/search` route with it, so the
  // launcher tap landed on Home a beat later. Sampling the transient state
  // instead of the settled one hid that (this assertion is the regression).
  await browser.goto(`${BASE}/?page=search`);
  await browser.waitFor(`!!document.getElementById('primary-search')`, 20_000);
  await new Promise((r) => setTimeout(r, 800));
  const search = await browser.eval(`({ search: location.search, hash: location.hash,
    input: !!document.getElementById('primary-search'), title: document.title })`);
  assert.equal(search.input, true, `the Search shortcut did not open Search (${search.hash} ${search.title})`);
  assert.equal(search.hash, '#/search', 'the app lost the route the shortcut produced');
  assert.match(search.title, /^Search/);
  assert.equal(search.search, '', 'the shortcut must consume its query string');

  // "Liked songs" is the other shortcut shape: it has no ?page.
  await browser.goto(`${BASE}/?collection=liked`);
  await browser.waitFor(`location.hash === '#/c/liked'`, 20_000);
  await new Promise((r) => setTimeout(r, 500));
  // This app files collections under Library, so the *Library* nav item is the
  // one marked current; the assertion is that the shortcut opened the
  // collection itself, not that a particular button lit up.
  const liked = await browser.eval(`({ hash: location.hash, search: location.search,
    title: document.title, home: !!document.querySelector('.mobile-nav button[data-page="home"].active') })`);
  assert.equal(liked.hash, '#/c/liked', 'the Liked shortcut did not open the collection');
  assert.match(liked.title, /liked/i, `the liked-songs shortcut opened "${liked.title}" instead`);
  assert.equal(liked.home, false, 'the liked-songs shortcut left the app on Home');
  assert.equal(liked.search, '');

  // A shared track link is a real page the phone can open cold.
  await browser.goto(`${BASE}/t/${TRACKS[0].videoId}`);
  await browser.waitFor(`/sonora/.test(document.title)`, 15_000);
  const card = await browser.eval(`({ title: document.title, heading: document.body.innerText.slice(0, 400) })`);
  assert.ok(card.heading.length > 0, 'the shared track page rendered nothing');

  // The Android back gesture is history.back(): it must stay inside the app.
  await bootApp();
  await browser.eval(`window.__stillTheSameDocument = true`);
  await browser.eval(`document.querySelector('[data-page="search"]').click()`);
  await browser.waitFor(`location.hash === '#/search'`, 10_000);
  await browser.eval(`history.back()`);
  await browser.waitFor(`location.hash !== '#/search'`, 10_000);
  const backState = await browser.eval(`({ alive: window.__stillTheSameDocument === true,
    hash: location.hash, title: document.title })`);
  assert.equal(backState.alive, true, 'the back gesture reloaded the document instead of walking the app history');
});

test('the operating system receives the session, and its buttons drive the app', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  if (!busAddress) return t.skip('no D-Bus session bus: install dbus-daemon to run the OS media-service check');

  // A third browser, because this one needs the session bus in its environment
  // and an ordinary tab (the app window cannot be given focus/OS transport).
  osBrowser = await launch(await freePort(), { extraEnv: { DBUS_SESSION_BUS_ADDRESS: busAddress } });
  await osBrowser.addInitScript(MEDIA_SESSION_PROBE);
  await emulateAndroid(osBrowser, 'pixel8');
  await seedPlayer();
  await bootApp(osBrowser);
  await play(osBrowser);

  let name = null;
  for (let i = 0; i < 40 && !name; i++) { name = mprisName(); if (!name) await sleep(250); }
  assert.ok(name, 'Chromium published no org.mpris.MediaPlayer2 name: the session never reached the OS');

  // Playing, with the track the app is actually on.
  await waitForMpris(name, 'PlaybackStatus', (raw) => /"Playing"/.test(raw));
  const metadata = await waitForMpris(name, 'Metadata',
    (raw) => raw.includes(TRACKS[0].title), 10_000);
  assert.ok(metadata.includes(TRACKS[0].channel),
    `the OS was not told the artist: ${metadata.replace(/\s+/g, ' ').slice(0, 300)}`);
  // Chromium downloads MediaMetadata artwork itself and hands the OS a local
  // copy (file:///tmp/.org.chromium.…), so an artUrl existing proves the app's
  // /api/img artwork actually decoded — a broken image leaves the notification
  // with no picture. The position state reaches the OS as mpris:length (µs).
  assert.match(metadata, /"mpris:artUrl"/,
    `the OS notification has no artwork: ${metadata.replace(/\s+/g, ' ').slice(0, 400)}`);
  assert.match(metadata, /"mpris:length"[\s\S]*?int64 6000000/,
    'the OS was not given the track length, so its progress bar has no end');

  // The buttons the shade draws. `CanGoNext` false is what a missing
  // nexttrack handler looks like from the outside.
  for (const [property, expected] of [
    ['CanGoNext', true], ['CanGoPrevious', true], ['CanPlay', true], ['CanPause', true], ['CanSeek', true],
  ]) {
    const raw = await waitForMpris(name, property, (out) => /boolean\s+(true|false)/.test(out));
    assert.match(raw, new RegExp(`boolean\\s+${expected}`),
      `${property} should be ${expected} for a queue with a next track: ${raw.trim()}`);
  }

  // Pressing Next on the OS advances the queue, end to end.
  const next = dbusSend([`--dest=${name}`, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.Next']);
  assert.equal(next.status, 0, `the OS could not call Next: ${next.stderr?.trim()}`);
  await osBrowser.waitFor(
    `window.__ms.metadata.at(-1)?.title === ${JSON.stringify(TRACKS[1].title)}`, 20_000);

  // And Pause/Play round-trip through the same channel. Explicit Pause/Play
  // rather than PlayPause: a toggle sent while the next track is still cold
  // buffering can resolve either way, and this asserts the transport, not luck.
  await osBrowser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.currentTime > 0.1; })()`, 20_000);
  dbusSend([`--dest=${name}`, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.Pause']);
  await osBrowser.waitFor(`document.getElementById('audio').paused === true`, 15_000);
  await waitForMpris(name, 'PlaybackStatus', (raw) => /"Paused"/.test(raw));
  dbusSend([`--dest=${name}`, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.Play']);
  await osBrowser.waitFor(`document.getElementById('audio').paused === false`, 15_000);
  await waitForMpris(name, 'PlaybackStatus', (raw) => /"Playing"/.test(raw));

  await osBrowser.close();
  osBrowser = null;
});

// ── permissions and passkeys (Android's actual install path) ──────────────

test('notifications are not requested on boot, and the bell is honest about it', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await bootApp();
  const permission = await browser.eval(`Notification.permission`);
  assert.notEqual(permission, 'granted', 'notifications were granted without the listener asking');

  await browser.eval(`document.querySelector('[data-action="notifications"]').click()`);
  await browser.waitFor(`!!document.getElementById('notif-panel')`, 10_000);
  const panel = await browser.eval(`({
    text: document.getElementById('notif-panel')?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 400) ?? '',
    enable: !!document.querySelector('[data-notif="enable-alerts"]'),
  })`);
  if (permission === 'denied') {
    // A phone that has blocked notifications: the panel must say so instead of
    // offering a button that cannot work.
    assert.match(panel.text, /blocked/i, `a blocked permission is not explained: "${panel.text}"`);
    assert.equal(panel.enable, false, 'the app offers "Enable alerts" while the browser has blocked them');
  } else {
    assert.match(panel.text, /alert/i, `the bell panel has nothing to say about alerts: "${panel.text}"`);
    assert.equal(panel.enable, true, 'with permission unasked, the app must offer to enable alerts explicitly');
  }
});

test('a passkey registered on the phone signs the app back in', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await bootApp();

  await browser.goto(`${BASE}/?page=security`);
  await browser.waitFor(`!!document.querySelector('[data-action="passkey-add"]')`, 20_000);
  await browser.eval(`document.querySelector('[data-action="passkey-add"]').click()`);
  await browser.waitFor(`!!document.querySelector('[data-action="passkey-rename"]')`, 25_000);
  const named = await browser.eval(`[...document.querySelectorAll('.sec-name')].map((n) => n.textContent.trim())`);
  assert.ok(named.length >= 1, 'the passkey was created but never listed');
  assert.match(named.join(' '), /Android passkey/i,
    `the passkey should be named from the device (Android passkey), got: ${JSON.stringify(named)}`);
  await shot('pixel8-passkey');

  // Sign out, then sign back in with the passkey alone — no passphrase typed.
  await browser.eval(`fetch('/api/auth/logout', { method: 'POST' }).then(() => 1)`);
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
  await browser.waitFor(`!document.getElementById('auth-passkey').hidden`, 20_000);
  await browser.eval(`document.getElementById('auth-passkey').click()`);
  try {
    await browser.waitFor(`document.getElementById('auth-overlay').hidden === true`, 25_000);
  } catch (error) {
    const shown = await browser.eval(`document.getElementById('auth-err')?.textContent ?? ''`);
    throw new Error(`passkey sign-in did not complete: ${error.message}\nerror shown: "${shown}"`);
  }
  await browser.waitFor(`!!document.querySelector('.mobile-nav button')`, 20_000);
  assert.equal(await browser.eval(`document.getElementById('auth-overlay').hidden`), true);

  // Clean up so a rerun starts from the same state.
  await browser.eval(`fetch('/api/auth/logout', { method: 'POST' }).then(() => 1)`);
  cachedCookie = null;
});
