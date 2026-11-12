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
  const playing = near("addEventListener('playing'", 2100);
  assert.match(playing, /installHandlers\(\)/,
    'handlers must be re-registered on playing: iOS drops them on interruption');
  assert.match(playing, /sync\(\{ metadata: true/,
    'a track that starts while the phone is locked must still name itself');
  // The window covers the handler's head, which now also converges the hidden
  // page onto the queue stream before the wrap test (public/queue-stream.js).
  assert.match(near("addEventListener('timeupdate'", 2400), /nowPlaying\.position\(\)/,
    'the seek bar has to keep moving');
  assert.match(near("addEventListener('loadedmetadata'", 300), /sync\(/,
    'the seek bar cannot appear until the duration is known');
  assert.match(near("addEventListener('seeked'", 500), /sync\(/,
    'seeking has to be reflected on the lock screen');
  assert.match(near('function playIndex', 2600), /nowPlaying\.sync\(\{ metadata: true \}\)/,
    'the new track must be named while it buffers, not after it starts');
});

test('a source swap never paints the lock screen as paused', () => {
  // Assigning a new `src` pauses the element until the new source buffers. That
  // pause is not a listener pausing, and publishing it flips the lock screen /
  // Android notification to "paused" for seconds mid-track-change — the widget
  // looks like it lost the app. The player has to expose the swap marker.
  // `near` from `createMediaSession` is too short to reach the hooks block (the
  // handler table sits between them), so anchor on the hook itself; the count
  // assertions keep it from matching somewhere unintended.
  assert.equal(APP.match(/isSwitching:/g)?.length, 1,
    'the swap marker belongs to the one media-session construction');
  assert.match(APP, /isSwitching: \(\) => state\.switching && !state\.userPause/,
    'a swap is suppressed, but a pause the listener made during one is still theirs');
  assert.match(near('isSwitching: () => state.switching', 220), /isSwitching/,
    'the marker must be wired into the hooks table');
  assert.match(MOD, /hooks\.isSwitching\?\.\(\)/,
    'the module has to honour the marker, not just be handed it');
});

test('the hidden handoff keeps the swap armed, so the swap-pause is never published', () => {
  // The regression: the `playing` handler called enterQueueStream() — which arms
  // `switching` for the src swap it makes — and then cleared `switching` a few
  // lines later. The swap's queued `pause` fires after the handler, so it read
  // as a listener pause: the lock screen showed `paused` for the whole stream
  // cold load, a false paused save reached /api/now, and the resume watchdog
  // raced the stream's play. The flag may only be cleared when this handler is
  // not the one that armed a swap.
  const playing = near("addEventListener('playing'", 2100);
  assert.match(playing, /const enteredStream = document\.visibilityState === 'hidden'[\s\S]*?enterQueueStream\(\)/,
    'the hidden handoff has to report whether it just armed a swap');
  assert.match(playing, /if \(!enteredStream\) state\.switching = false/,
    'clearing switching unconditionally disarms the swap the handler just started');
  assert.doesNotMatch(playing, /^\s*state\.switching = false;$/m,
    'an unconditional `switching = false` in the playing handler is the bug itself');
});

test('exactly one resume watchdog interval runs while hidden', () => {
  // Two byte-identical 10 s intervals used to call resumeIfInterrupted(). Every
  // tick spends one of resumeAfterInterruption's 60 attempts, so the pair
  // expired that cap twice as fast and a six-minute phone call disarmed
  // auto-resume for the rest of the session.
  const beats = APP.match(/if \(document\.visibilityState !== 'hidden'\) return;\s*\n\s*resumeIfInterrupted\(\);\s*\n\}, 10_000\)/g) ?? [];
  assert.equal(beats.length, 1, `exactly one hidden resume watchdog may exist, found ${beats.length}`);
});

test('a lock-screen "previous" at the top of a track stays inside the queue stream', () => {
  // nextTrack({ back: true }) leaves the stream and cold-loads a per-track src
  // while the page is (usually) frozen — the one swap a suspended page never
  // finishes, so the music stops until the app is opened. In streaming mode this
  // is a seek to the start of the streamed track instead.
  const prev = near('previoustrack: () => {', 900);
  assert.match(prev, /else if \(state\.streaming\) seekStreamTo\(0\)/);
  assert.doesNotMatch(prev, /if \(playerPosition\(\) > 3\) seekTo\(0\);\s*\n\s*else nextTrack/,
    'the pre-streaming branch order is what dropped the stream');
});

test('the OS stop action hard-stops and takes the Now Playing widget away', () => {
  // The regression: after the player gave up on a queue of failing tracks the
  // element was merely paused, so the widget kept advertising a live player for
  // a song that would never start.
  const stop = near('stop: () => {', 1500);
  assert.match(stop, /audio\.pause\(\)/);
  assert.match(stop, /nowPlaying\.stopped\(\)/,
    'a stop has to publish `none`, not leave the element\'s `paused` to be published');
  assert.match(MOD, /function stopped\(\)[\s\S]{0,400}?playbackState = 'none'/);
  assert.match(MOD, /\['play', 'pause', 'stop', 'previoustrack', 'nexttrack'\]/,
    'the action has to be registered or the OS has nothing to call');
});

test('a lock-screen seek cannot be mistaken for the end of a track', () => {
  // Dragging the bar to 0 looks exactly like the loop wrap that advances the
  // queue, so the seek has to be flagged — and the flag consumed, or the queue
  // would never advance again.
  assert.match(near('onSeekStart', 200), /state\.manualSeek = true/);
  assert.match(near("addEventListener('seeking'", 800), /state\.lockSeek/);
  assert.match(near("addEventListener('timeupdate'", 2400), /state\.lockSeek/,
    'a seek that never moved must not leave the wrap guard disarmed');
});

test('the loop wrap is detected on timeupdate as well as seeking', () => {
  // The locked-iPhone regression: WebKit can loop without emitting `seeking`.
  // If only the seeking listener exists, the same song repeats forever. Both
  // events must feed the same idempotent end handler.
  assert.match(APP, /import \{[^}]*isLoopWrap[^}]*\} from '\.\/playback\.js'/);
  assert.match(near("addEventListener('seeking'", 900), /isLoopWrap\(/);
  assert.match(near("addEventListener('timeupdate'", 2400), /isLoopWrap\(/,
    'timeupdate is the only witness on a locked iPhone');
  assert.match(near('function endTrack', 900), /(if \(state\.ending\) return|ending stays armed)/,
    'one wrap must never advance the queue twice');
});

test('a failed load advances the queue and cleans up the switch state', () => {
  // Two regressions from the adversarial playback audit: a source that errors
  // before its first `playing` never advanced the queue (the user had to press
  // next until the failures cap tripped), and the failed source left
  // `switching` armed so every later pause skipped its session save.
  // The window covers the whole handler, which now also bails out early when
  // the queue stream (not a track) failed, and blocks a stream the engine
  // cannot play (public/queue-stream.js).
  const err = near("audio.addEventListener('error'", 3800);
  assert.match(err, /state\.switching = false/,
    'a failed source never reaches the playing listener that clears switching');
  assert.match(err, /state\.ending = false/);
  // The advance must not bail out on a missing start stamp.
  assert.match(err, /failing === null && state\.sourceStarted/,
    'a source that never started must still advance; only a mid-track failure with no stamp is skipped');
  assert.match(err, /nextTrack\(\)/, 'the retry advances the queue');
});

test('a refused play rolls back the session claim it just made', () => {
  // Otherwise a device whose play() was rejected (autoplay policy after a
  // restore) writes takeover:true on its next visibility save and steals the
  // session from the device that is actually playing.
  assert.match(near('function playIndex', 4200), /releaseFailedClaim\(claimUndo\)/);
  assert.match(near('function releaseFailedClaim', 400), /state\.claim = false/);
});

test('lock-screen handlers survive an interruption while the screen is off', () => {
  // iOS drops Media Session handlers across audio-session interruptions, and
  // an interruption pauses the element — no `playing` will fire until the user
  // resumes, so the re-registration points are visibility and pause, not just
  // `playing`.
  assert.match(near("audio.addEventListener('pause'", 1600), /installHandlers\(\)/,
    'a paused element is the interruption state; handlers must be re-armed here');
  const visibility = near("document.addEventListener('visibilitychange', () => {\n  // Locking the phone", 1200);
  assert.match(visibility, /^\s*nowPlaying\.installHandlers\(\);/m,
    'both hiding (the last synchronous GPU-reset boundary) and showing re-arm the lock screen');
  assert.doesNotMatch(visibility, /if \(document\.visibilityState === 'visible'\)\s*nowPlaying\.installHandlers/,
    'the visible-only guard would restore the missed hide-boundary registration');
});

test('a personal track hands off synchronously, and only pauses when visible', () => {
  // The regression: the handoff used to pause unconditionally. A pause on a
  // backgrounded phone is where iOS takes the audio session away, and the next
  // track then plays into silence with the Now Playing widget emptied — while
  // `audio.paused` still reports false. A manual "next" while backgrounded
  // never pauses and works, so the auto-advance must match it. Visible
  // handoffs keep the pause the loop workaround was developed against.
  const end = near('function endTrack', 2600);
  const personal = end.slice(end.indexOf('if (state.repeat === 2)'));
  assert.match(personal, /handoffTrack\(\{/, 'the handoff goes through the tested primitive');
  assert.match(personal, /background: document\.visibilityState === 'hidden'/,
    'the pause decision has to follow the real visibility of the page');
});

test('a background handoff is never deferred to a timer', () => {
  // A locked phone may not run a background timer until it is unlocked, so a
  // deferred handoff can lose the whole next track.
  const end = near('function endTrack', 2600);
  const personal = end.slice(end.indexOf('if (state.repeat === 2)'));
  assert.doesNotMatch(personal, /setTimeout|setInterval|queueMicrotask/,
    'the source swap must stay inside the event that saw the track end');
});

test('the room auto-next keeps the transport honest and retries slowly', () => {
  // A room waits for the server's next-track snapshot. Do not pause while the
  // current track loops during that round trip; the personal handoff below it
  // is different because it replaces the source synchronously.
  const end = near('function endTrack', 2400);
  const room = end.slice(0, end.indexOf('if (state.repeat === 2)'));
  assert.match(room, /ROOM_AUTO_NEXT_COOLDOWN_MS/);
  assert.match(room, /state\.roomNextAt = Date\.now\(\)/);
  assert.doesNotMatch(room, /audio\.pause\(\)/,
    'a room must not pause-and-loop the old track while waiting for the server');
});

test('a hidden source swap repairs the audio-session category before src', () => {
  const play = near('function playIndex', 2200);
  assert.match(play, /document\.visibilityState === 'hidden'\) repairAudioSession\(\{ force: true \}\)/,
    'a locked page must not trust the stale WebKit category cache at a handoff');
  assert.match(play, /else claimAudioSession\(\)/,
    'a visible page still uses the cheap claim on every play intent');
});

test('the player claims the long-form audio session on every play intent', () => {
  // Without the playback category WebKit drops the session after a couple of
  // silent seconds, which is exactly the gap between two buffering tracks.
  // The assignment itself lives in public/audio-session.js, because a bare
  // re-assertion is a no-op once WebKit has cached the value; see
  // test/audio-session.test.js for the category being re-sent.
  assert.match(APP, /createAudioSession\(\)/);
  assert.match(near('function playPause', 300), /claimAudioSession\(\)/);
  assert.match(near('function playIndex', 2200), /claimAudioSession\(\)/);
  assert.match(near("addEventListener('playing'", 1600), /claimAudioSession\(\)/);
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
  const log = (window.__ms = { positions: [], metadata: [], handlers: {}, handlerLog: [], playbackState: null });
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
    const kind = typeof fn === 'function' ? 'fn' : null;
    log.handlers[name] = kind;
    // The order matters: WebKit builds its remote-command set from these calls,
    // and the lock screen's buttons come from that set, so a re-registration
    // sequence is evidence in its own right. (Concatenation, not a template
    // literal: this block is inside one, and a nested backtick ends it.)
    log.handlerLog.push(name + '=' + kind);
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
    body:JSON.stringify({name:'admin',passphrase:'hunter2hunter2'})}).then(r=>r.status)`);
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
  // No declared MIME type: /api/img relays the upstream content-type, so a
  // hardcoded one is a lie the moment YouTube answers webp/avif — and iOS drops
  // artwork whose declared type disagrees with the bytes, silently. Chromium
  // normalises an absent `type` to '', hence the falsy test rather than
  // `undefined`.
  assert.ok(!art.type, `artwork must not declare a MIME type, got ${art.type}`);

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
  assert.equal(snap.handlers.stop, 'fn', 'without a stop handler the widget can never reach `none`');
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
    meta: document.querySelector('#player .player-song-meta > span')?.textContent,
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

// The reported bug, end to end: a locked iPhone shows ±seek buttons where the
// track arrows belong. Locking relaunches the GPU process *after* the
// visibilitychange transition, and WebKit rebuilds the page's remote-command
// listener empty; an empty set falls back to WebKit's `defaultCommands()`, which
// lists SkipForward/SkipBackward but no PreviousTrack/NextTrack. No event tells
// the page that happened, and the player deliberately does not pause on a
// background handoff, so only the playhead-driven keep-alive restores them.
//
// test/media-session.test.js covers the module in isolation; this drives the
// real app with real audio, so it proves the wiring (timeupdate → position())
// and not just the primitive.
//
// Last in the file on purpose: it presses nexttrack, which moves the shared
// session the resume test above depends on.
test('a locked phone keeps previous/next instead of ±seek', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  if (await skipIfUpstreamBlocked(t, BASE)) return;

  // The previous test left a session saved; reload and play it so there is a
  // real playhead and a real queue to skip.
  await browser.goto(`${BASE}/?keepalive=${Date.now()}`);
  await browser.waitFor(`!!document.querySelector('.mobile-nav button')`, 20_000);
  await browser.eval(`document.querySelector('#player [data-action="playpause"]')?.click()`);
  try {
    await browser.waitFor(`(() => { const a = document.getElementById('audio');
      return !!a && !a.paused && a.currentTime > 0.5 && Number.isFinite(a.duration); })()`, 90_000);
  } catch (err) {
    throw new Error(`${err.message}\naudio state: ${JSON.stringify(await diagnostics())}`);
  }

  // Same modelling as test/track-handoff.test.js: this Chromium has no
  // Emulation.setPageVisibility, so the page is told it is locked by overriding
  // the property the code reads.
  await browser.eval(`(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get() { return 'hidden'; },
    });
    return document.visibilityState;
  })()`);
  assert.equal(await browser.eval(`document.visibilityState`), 'hidden');

  // Clear the log: everything below must come from the heartbeat, not from the
  // re-registrations the app already made while visible.
  await browser.eval(`window.__ms.handlerLog.length = 0`);
  // A locked iPhone keeps ticking timeupdate, which feeds position(). Two beats
  // of the one-second fast cadence prove it is periodic, not a one-shot that a
  // later relaunch would undo.
  try {
    await browser.waitFor(`window.__ms.handlerLog.length >= 14`, 20_000);
  } catch (err) {
    const seen = await browser.eval(`window.__ms.handlerLog.slice(0, 40)`);
    throw new Error(`${err.message}\nhandler registrations while hidden: ${JSON.stringify(seen)}`);
  }

  const beats = await browser.eval(`(() => {
    const log = window.__ms.handlerLog;
    const a = document.getElementById('audio');
    return { entries: log.slice(), paused: a.paused,
      title: window.__ms.metadata.at(-1)?.title };
  })()`);
  const oneBeat = ['play=fn', 'pause=fn', 'stop=fn', 'previoustrack=fn', 'nexttrack=fn',
    'seekto=fn', 'seekbackward=null', 'seekforward=null'];
  assert.deepEqual(beats.entries.slice(0, oneBeat.length), oneBeat,
    `a hidden beat must re-register the whole set: ${beats.entries.slice(0, 10).join(' ')}`);
  assert.ok(beats.entries.filter((e) => e === 'nexttrack=fn').length >= 2,
    'the beat must repeat: a one-shot registration cannot survive a later relaunch');
  assert.equal(beats.paused, false,
    'the heartbeat must not pause the element: pausing is what loses the session');

  // And the buttons it re-registered actually drive the app.
  await browser.eval(`window.__msFns.nexttrack()`);
  await browser.waitFor(
    `window.__ms.metadata.at(-1)?.title !== ${JSON.stringify(beats.title ?? '')}`,
    60_000,
  ).catch(async (err) => {
    throw new Error(`${err.message} (a lock-screen nexttrack did not skip)`
      + `\naudio state: ${JSON.stringify(await diagnostics())}`);
  });

  // The page is still locked while that skip happens, so the beat must have kept
  // the buttons correct across the handoff too.
  const afterSkip = await browser.eval(`window.__ms.handlerLog.slice(-7)`);
  assert.ok(afterSkip.includes('nexttrack=fn'),
    `the beat must survive a skip while locked: ${afterSkip.join(' ')}`);

  await browser.eval(`delete document.visibilityState`);
  assert.equal(await browser.eval(`document.visibilityState`), 'visible');
});
