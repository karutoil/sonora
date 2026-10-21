import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { skipIfUpstreamBlocked } from './helpers/ux.js';

// The lock screen is a separate renderer with its own silent failure modes.
// When it is wrong the controls still appear — only the artwork and the seek
// bar go missing, with no error in the page, the console or the network log.
// So this file pins the wiring statically *and* drives a real browser to read
// back exactly what navigator.mediaSession was handed.

const ROOT = new URL('..', import.meta.url).pathname;
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const MOD = fs.readFileSync(path.join(ROOT, 'public/media-session.js'), 'utf8');

// ── static contract (runs everywhere, even without a browser) ────────────

/** The source from `marker` onwards, so an assertion cannot match far away. */
function near(marker, len = 1200) {
  const at = APP.indexOf(marker);
  assert.ok(at >= 0, `app.js no longer contains ${marker}`);
  return APP.slice(at, at + len);
}

test('the player delegates lock-screen behaviour to the tested module', () => {
  assert.match(APP, /import \{[^}]*createMediaSession[^}]*\} from '\.\/media-session\.js'/);
  // One construction, so there is a single place that owns the API.
  assert.equal(APP.match(/createMediaSession\(/g)?.length, 1);
});

test('every event that can change the lock-screen view refreshes it', () => {
  const playing = near("addEventListener('playing'", 1500);
  assert.match(playing, /installHandlers\(\)/,
    'handlers must be re-registered on playing: iOS drops them on interruption');
  assert.match(playing, /sync\(\{ metadata: true/,
    'a track that starts while the phone is locked must still name itself');
  assert.match(near("addEventListener('timeupdate'", 1500), /nowPlaying\.position\(\)/,
    'the seek bar has to keep moving');
  assert.match(near("addEventListener('loadedmetadata'", 300), /sync\(/,
    'the seek bar cannot appear until the duration is known');
  assert.match(near("addEventListener('seeked'", 500), /sync\(/,
    'seeking has to be reflected on the lock screen');
  assert.match(near('function playIndex', 1600), /nowPlaying\.sync\(\{ metadata: true \}\)/,
    'the new track must be named while it buffers, not after it starts');
});

test('a lock-screen seek cannot be mistaken for the end of a track', () => {
  // Dragging the bar to 0 looks exactly like the loop wrap that advances the
  // queue, so the seek has to be flagged — and the flag consumed, or the queue
  // would never advance again.
  assert.match(near('onSeekStart', 200), /state\.manualSeek = true/);
  assert.match(near("addEventListener('seeking'", 800), /state\.lockSeek/);
  assert.match(near("addEventListener('timeupdate'", 1200), /state\.lockSeek/,
    'a seek that never moved must not leave the wrap guard disarmed');
});

test('the loop wrap is detected on timeupdate as well as seeking', () => {
  // The locked-iPhone regression: WebKit can loop without emitting `seeking`.
  // If only the seeking listener exists, the same song repeats forever. Both
  // events must feed the same idempotent end handler.
  assert.match(APP, /import \{[^}]*isLoopWrap[^}]*\} from '\.\/playback\.js'/);
  assert.match(near("addEventListener('seeking'", 900), /isLoopWrap\(/);
  assert.match(near("addEventListener('timeupdate'", 700), /isLoopWrap\(/,
    'timeupdate is the only witness on a locked iPhone');
  assert.match(near('function endTrack', 500), /if \(state\.ending\) return/,
    'seeking and timeupdate must not both advance the queue');
});

test('the player claims the long-form audio session on every play intent', () => {
  // Without the playback category WebKit drops the session after a couple of
  // silent seconds, which is exactly the gap between two buffering tracks.
  // The assignment itself lives in public/audio-session.js, because a bare
  // re-assertion is a no-op once WebKit has cached the value; see
  // test/audio-session.test.js for the category being re-sent.
  assert.match(APP, /createAudioSession\(\)/);
  assert.match(near('function playPause', 300), /claimAudioSession\(\)/);
  assert.match(near('function playIndex', 1200), /claimAudioSession\(\)/);
  assert.match(near("addEventListener('playing'", 900), /claimAudioSession\(\)/);
});

test('artwork is never handed to the lock screen as a cross-origin URL', () => {
  assert.doesNotMatch(APP, /artwork:\s*\[\{\s*src:\s*t\.thumb/,
    'the raw i.ytimg.com thumb is cross-origin: iOS renders nothing for it');
  assert.match(MOD, /\/api\/img\//);
  assert.match(MOD, /new URL\(src, base\)\.href/);
});

// ── real browser ──────────────────────────────────────────────────────────

// Instrument the Media Session API before the app module can touch it: shadow
// the instance methods, keep the real ones, and record what the app asked for.
const INSTRUMENT = `(() => {
  const ms = navigator.mediaSession;
  const log = (window.__ms = { positions: [], metadata: [], handlers: {}, playbackState: null });
  window.__msFns = {};

  const setPositionState = ms.setPositionState.bind(ms);
  ms.setPositionState = (s) => {
    // Record before delegating: the real call throws on an invalid range, and
    // a throw here is a bug worth seeing in the log rather than in silence.
    log.positions.push({ duration: s.duration, position: s.position, playbackRate: s.playbackRate });
    return setPositionState(s);
  };

  const setActionHandler = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (name, fn) => {
    log.handlers[name] = typeof fn === 'function' ? 'fn' : null;
    if (typeof fn === 'function') window.__msFns[name] = fn;
    else delete window.__msFns[name];
    return setActionHandler(name, fn);
  };

  const proto = Object.getPrototypeOf(ms);
  const meta = Object.getOwnPropertyDescriptor(proto, 'metadata');
  Object.defineProperty(ms, 'metadata', {
    configurable: true,
    get() { return meta.get.call(ms); },
    set(v) {
      log.metadata.push({
        title: v.title, artist: v.artist, album: v.album,
        artwork: [...v.artwork].map((a) => ({ src: a.src, sizes: a.sizes, type: a.type })),
      });
      meta.set.call(ms, v);
    },
  });

  const ps = Object.getOwnPropertyDescriptor(proto, 'playbackState');
  Object.defineProperty(ms, 'playbackState', {
    configurable: true,
    get() { return ps.get.call(ms); },
    set(v) { log.playbackState = v; ps.set.call(ms, v); },
  });
})();`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lock-'));

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
      SONORA_SECRET: 'lock-secret', SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
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
    browser = await launch(await freePort());
    await browser.addInitScript(INSTRUMENT);
  }
});

after(() => {
  browser?.close();
  server?.kill('SIGTERM');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

/** Best-effort state dump so a failed playback wait says why it failed. */
async function diagnostics() {
  try {
    return await browser.eval(`(() => { const a = document.getElementById('audio');
      return { error: a?.error ? { code: a.error.code, message: a.error.message } : null,
        readyState: a?.readyState, networkState: a?.networkState, src: a?.currentSrc,
        toast: document.getElementById('toast-text')?.textContent }; })()`);
  } catch { return null; }
}

test('the lock screen gets artwork, metadata and a working seek bar', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  if (await skipIfUpstreamBlocked(t, BASE)) return;

  await browser.goto(`${BASE}/`);
  // Log in, then reload so the app boots authenticated.
  await browser.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name:'toil',passphrase:'hunter2hunter2'})}).then(r=>r.status)`);
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('.mobile-nav button')`);

  // Drive the real search page: its rows are what teach the player a track's
  // title and channel (rememberTracks), so a track played any other way has
  // only a video id to show on the lock screen.
  await browser.eval(`document.querySelector('[data-page="search"]').click()`);
  await browser.waitFor(`!!document.getElementById('primary-search')`);

  const typeQuery = () => browser.eval(`(() => { const i = document.getElementById('primary-search');
    i.value = 'aphex twin xtal';
    i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  const rowsReady = `document.querySelectorAll('.search-track-list .track-row').length >= 3`;
  // A live YouTube search can hiccup; retry rather than fail the whole run on
  // a transient upstream error.
  await typeQuery();
  for (let attempt = 0; ; attempt++) {
    try {
      await browser.waitFor(rowsReady, 20_000);
      break;
    } catch (err) {
      if (attempt >= 2) {
        const html = await browser.eval(`(document.getElementById('search-results')?.innerHTML || '').slice(0, 300)`);
        throw new Error(`${err.message}\nsearch-results: ${html}`);
      }
      await typeQuery();
    }
  }

  const rows = await browser.eval(`[...document.querySelectorAll('.search-track-list .track-row')]
    .slice(0, 3).map((r) => ({ title: r.querySelector('.track-name').textContent,
      channel: r.querySelector('.track-artist').textContent }))`);
  assert.ok(rows.length >= 3, `expected three playable results, got ${rows.length}`);

  // Clicking a row queues the whole result list, which is what makes
  // "did it skip?" observable below.
  await browser.eval(`document.querySelectorAll('.search-track-list .track-row')[0].click()`);

  try {
    await browser.waitFor(`(() => { const a = document.getElementById('audio');
      return !!a && !a.paused && a.currentTime > 0.5 && Number.isFinite(a.duration); })()`, 120_000);
  } catch (err) {
    throw new Error(`${err.message}\naudio state: ${JSON.stringify(await diagnostics())}`);
  }

  const snap = await browser.eval(`(() => { const a = document.getElementById('audio');
    const log = window.__ms;
    return {
      now: { time: a.currentTime, duration: a.duration, src: a.currentSrc },
      metadata: log.metadata.at(-1) ?? null,
      positions: log.positions.slice(-5),
      handlers: log.handlers,
      playbackState: log.playbackState,
    }; })()`);

  // ── metadata ──
  assert.equal(snap.metadata.title, rows[0].title);
  assert.equal(snap.metadata.artist, rows[0].channel);
  assert.equal(snap.playbackState, 'playing');

  // ── artwork ──
  const [art] = snap.metadata.artwork;
  assert.ok(art, 'no artwork was published at all');
  assert.ok(art.src.startsWith(`${BASE}/api/img/`),
    `artwork must be absolute and same-origin, got ${art.src}`);
  assert.equal(art.type, 'image/jpeg');

  // Load it in the browser exactly like the lock screen would.
  const loaded = await browser.eval(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = ${JSON.stringify(art.src)};
  })`);
  assert.ok(loaded.w > 0, `the lock screen could not fetch the artwork: ${art.src}`);
  // The one that silently kills iOS artwork: a declared size that is a lie.
  assert.equal(art.sizes, `${loaded.w}x${loaded.h}`,
    `declared ${art.sizes} but the bitmap is ${loaded.w}x${loaded.h}`);

  // ── seek bar ──
  assert.ok(snap.positions.length > 0, 'no position state: the lock screen has no seek bar');
  for (const p of snap.positions) {
    assert.ok(p.duration > 0 && Number.isFinite(p.duration));
    assert.ok(p.position >= 0 && p.position <= p.duration,
      `position ${p.position} outside 0..${p.duration} makes setPositionState throw`);
    assert.ok(p.playbackRate > 0);
  }
  const last = snap.positions.at(-1);
  assert.ok(Math.abs(last.duration - snap.now.duration) < 0.5,
    `seek bar duration ${last.duration} does not match the audio (${snap.now.duration})`);
  assert.ok(Math.abs(last.position - snap.now.time) < 3,
    `seek bar position ${last.position} lags the audio (${snap.now.time})`);

  // ── action handlers ──
  assert.equal(snap.handlers.play, 'fn');
  assert.equal(snap.handlers.pause, 'fn');
  assert.equal(snap.handlers.previoustrack, 'fn');
  assert.equal(snap.handlers.nexttrack, 'fn');
  assert.equal(snap.handlers.seekto, 'fn', 'without a seekto handler the bar is inert');
  assert.equal(snap.handlers.seekbackward, null, 'iOS must keep prev/next, not ±10s');
  assert.equal(snap.handlers.seekforward, null);

  // ── dragging the lock-screen bar actually seeks ──
  await browser.waitFor(`document.getElementById('audio').currentTime > 6`, 60_000);
  await browser.eval(`window.__msFns.seekto({ seekTime: 0 })`);
  await browser.waitFor(`document.getElementById('audio').currentTime < 1.5`, 15_000);

  const afterSeek = await browser.eval(`(() => { const a = document.getElementById('audio');
    return { time: a.currentTime, src: a.currentSrc,
      title: window.__ms.metadata.at(-1)?.title,
      position: window.__ms.positions.at(-1)?.position }; })()`);
  // Seeking to the start must move the playhead, not the queue.
  assert.ok(afterSeek.time < 1.5, `seek ignored: still at ${afterSeek.time}s`);
  assert.equal(afterSeek.title, rows[0].title,
    'a lock-screen seek to 0 was mistaken for the end of the track and skipped it');
  assert.ok(afterSeek.position < 1.5, 'the seek bar did not follow the seek');

  // ── and the seek-to-zero wrap that advances the queue still works ──
  // A stale suppression flag from the seek above would strand playback on this
  // track forever, so this is the regression that must not happen.
  await browser.eval(`window.__msFns.seekto({ seekTime: 8 })`);
  await browser.waitFor(`document.getElementById('audio').currentTime > 7`, 60_000);
  await browser.eval(`document.getElementById('audio').currentTime = 0`);
  await browser.waitFor(
    `window.__ms.metadata.at(-1)?.title === ${JSON.stringify(rows[1].title)}`,
    60_000,
  ).catch(async (err) => {
    throw new Error(`${err.message}\naudio state: ${JSON.stringify(await diagnostics())}`);
  });

  // ── the timeupdate-only wrap (the locked-iPhone regression) ──
  // Some WebKit versions loop without emitting `seeking`. Shadow currentTime so
  // the element looks like it jumped to 0 with no seek event at all, then
  // deliver the one event such an engine does send. Without the timeupdate
  // detector the same track would repeat forever and this would time out.
  await browser.waitFor(`document.getElementById('audio').currentTime > 4`, 60_000);
  const beforeTimeupdate = await browser.eval(`window.__ms.metadata.at(-1)?.title`);
  await browser.eval(`(() => {
    const a = document.getElementById('audio');
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(a, 'currentTime', {
      configurable: true,
      get: () => 0.4,
      set: (v) => real.set.call(a, v),
    });
    a.dispatchEvent(new Event('timeupdate'));
    delete a.currentTime;
    return 1;
  })()`);
  await browser.waitFor(
    `window.__ms.metadata.at(-1)?.title !== ${JSON.stringify(beforeTimeupdate)}`,
    60_000,
  ).catch(async (err) => {
    throw new Error(`${err.message}\naudio state: ${JSON.stringify(await diagnostics())}`);
  });
  const afterTimeupdate = await browser.eval(`window.__ms.metadata.at(-1)?.title`);
  assert.equal(afterTimeupdate, rows[2].title,
    'the timeupdate-only wrap must advance exactly one track, not repeat the current one');
});

test('a session saved by another device resumes at its playhead after a reload', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  if (await skipIfUpstreamBlocked(t, BASE)) return;

  // Hand the shared session to a different device at a known playhead. The
  // current page is still playing the track from the previous test, so its
  // queue is real and already cached.
  const seeded = await browser.eval(`(async () => {
    const { state } = await fetch('/api/now').then((r) => r.json());
    if (!state?.tracks?.length) return null;
    const res = await fetch('/api/now', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queue: state.tracks,
        index: state.index,
        positionMs: 15_000,
        source: state.source,
        station: state.station,
        deviceId: 'other-phone-1',
        deviceName: 'iPhone',
        playing: true,
        takeover: true,
      }),
    });
    return res.ok ? { title: state.tracks[state.index].title } : null;
  })()`);
  assert.ok(seeded, 'the previous test left no session to resume');

  // A real document load: boot reads /api/now and must offer the saved playhead
  // before anything autoplays. A cache-busting query also clears the hash the
  // previous test left behind, so this lands on home (where the hero lives).
  await browser.goto(`${BASE}/?resume=${Date.now()}`);
  await browser.waitFor(`!!document.querySelector('.mobile-nav button')`, 20_000);
  await browser.waitFor(`!!document.querySelector('#player .player-song-meta strong')`, 10_000);

  const restored = await browser.eval(`({
    title: document.querySelector('#player .player-song-meta strong')?.textContent,
    meta: document.querySelector('#player .player-song-meta span')?.textContent,
    hero: document.querySelector('.hero-content')?.innerText.replace(/\\s+/g, ' '),
  })`);
  assert.equal(restored.title, seeded.title, 'the saved track is restored into the player bar');
  assert.match(restored.meta, /resumes at 0:15/, 'the saved playhead is shown before play');
  assert.match(restored.hero, /FROM YOUR IPHONE/i, `hero was: ${restored.hero}`);

  // Pressing play here resumes at 0:15 and takes the session back. The seek is
  // applied on `loadedmetadata`/`playing`; a restart would still be near 0:00.
  await browser.eval(`document.querySelector('#player [data-action="playpause"]').click()`);
  try {
    await browser.waitFor(`(() => { const a = document.getElementById('audio');
      return !!a && !a.paused && a.currentTime > 10; })()`, 30_000);
  } catch (err) {
    throw new Error(`${err.message}\naudio state: ${JSON.stringify(await diagnostics())}`);
  }
  const resumed = await browser.eval(`document.getElementById('audio').currentTime`);
  assert.ok(resumed > 10, `resume seek was lost: playhead is ${resumed}s, expected ~15s`);
});
