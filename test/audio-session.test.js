import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { ROOT, startServer } from './helpers/ux.js';
import { createAudioSession, PLAYBACK, AMBIENT } from '../public/audio-session.js';

// The audio-session category is the difference between a music app and a muted
// page: iOS silences the ambient category with the Ring/Silent switch, and on a
// locked phone WebKit can leave the tab in ambient while every API — including
// `audio.paused` and the playhead — reports that it is playing. Nothing fires,
// so the only defence is to send the category again at the moments it can be
// lost. That behaviour is what this file pins: the module's contract in plain
// node, the wiring in app.js statically, and the real assignment sequence in a
// browser with an instrumented navigator.audioSession.

const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const LISTEN = fs.readFileSync(path.join(ROOT, 'public/listen.js'), 'utf8');

/** The source from `marker` onwards, so an assertion cannot match far away. */
function near(source, marker, len = 600) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `source no longer contains ${marker}`);
  return source.slice(at, at + len);
}

/** A stand-in for navigator.audioSession that records every assignment. */
function fakeSession(initial = 'auto') {
  const writes = [];
  let type = initial;
  return {
    writes,
    get type() { return type; },
    set type(v) { writes.push(v); type = v; },
  };
}

// ── the module's contract ───────────────────────────────────────────────

test('claim asks for playback exactly once', () => {
  const session = fakeSession();
  const audioSession = createAudioSession({ session, defer: () => {} });
  assert.equal(audioSession.supported, true);
  assert.equal(audioSession.claim(), true);
  assert.deepEqual(session.writes, [PLAYBACK]);
  // A second claim changes nothing, so it must not re-send: the assignment is
  // a hop into the media process and, per WebKit's own cache, a no-op.
  assert.equal(audioSession.claim(), false);
  assert.deepEqual(session.writes, [PLAYBACK]);
});

test('repair cycles through a different value so two categories go out', () => {
  // Starting from 'playback' is the broken case: re-asserting that value is
  // exactly what WebKit's web process short-circuits.
  const session = fakeSession(PLAYBACK);
  const deferred = [];
  const audioSession = createAudioSession({ session, defer: (fn) => deferred.push(fn) });
  assert.equal(audioSession.repair(), true);
  assert.deepEqual(session.writes, [AMBIENT, PLAYBACK]);
  assert.equal(session.type, PLAYBACK);
  // A third assignment, in a later task, in case the pair was coalesced.
  assert.equal(deferred.length, 1);
  deferred[0]();
  assert.deepEqual(session.writes, [AMBIENT, PLAYBACK, PLAYBACK]);
});

test('a page that freezes before the deferred step is never left muted', () => {
  // A locked phone can be frozen at any moment. The synchronous pair ends on
  // playback, so losing the deferred assignment must be harmless.
  const session = fakeSession(PLAYBACK);
  const audioSession = createAudioSession({ session, defer: () => { /* never runs */ } });
  audioSession.repair();
  assert.equal(session.type, PLAYBACK, 'the page would be silent (ambient) forever');
});

test('repair is rate-limited, and force ignores the limit', () => {
  let clock = 0;
  const session = fakeSession(PLAYBACK);
  const audioSession = createAudioSession({
    session, defer: () => {}, now: () => clock, cooldownMs: 1000,
  });
  assert.equal(audioSession.repair(), true);
  assert.equal(audioSession.repair(), false);
  clock = 500;
  assert.equal(audioSession.repair(), false, 'a fast skip must not cycle twice');
  clock = 1001;
  assert.equal(audioSession.repair(), true);
  assert.equal(audioSession.repair({ force: true }), true);
});

test('no Audio Session API is a silent no-op', () => {
  // Every browser but Safari 16.4+/iOS 17+ lands here.
  const audioSession = createAudioSession({ session: null });
  assert.equal(audioSession.supported, false);
  assert.equal(audioSession.claim(), false);
  assert.equal(audioSession.repair(), false);
});

test('a session that refuses the assignment cannot break playback', () => {
  const session = { get type() { return 'auto'; }, set type(_v) { throw new Error('read-only'); } };
  const audioSession = createAudioSession({ session });
  assert.equal(audioSession.claim(), false);
  assert.equal(audioSession.repair(), false);
});

// ── the interruption that ends in the background ────────────────────────

/** A stand-in for the AudioSession state machine (state + statechange). */
function fakeStateSession(initial = 'active') {
  const listeners = new Set();
  let state = initial;
  return {
    get type() { return PLAYBACK; },
    set type(_v) {},
    get state() { return state; },
    addEventListener(name, fn) { if (name === 'statechange') listeners.add(fn); },
    removeEventListener(name, fn) { if (name === 'statechange') listeners.delete(fn); },
    set(next) { state = next; for (const fn of listeners) fn(new Event('statechange')); },
  };
}

test('an interruption ending while the app is backgrounded is reported', () => {
  // The reported failure: the phone is in another app when the call ends (or
  // Maps finishes talking), so nothing the page observes fires — no
  // visibilitychange, no resume. The session's own state is the only witness.
  const session = fakeStateSession('active');
  const audioSession = createAudioSession({ session, defer: () => {} });
  let resumed = 0;
  assert.equal(audioSession.onResume(() => { resumed += 1; }), true);
  session.set('interrupted');
  assert.equal(resumed, 0, 'the interruption itself must not resume playback');
  session.set('active');
  assert.equal(resumed, 1, 'ending the interruption has to resume the track');
});

test('only the interrupted→active edge counts as a resume', () => {
  // `statechange` also fires for 'inactive' between two sources. Resuming on
  // every transition would call play() on a finished track and fight the
  // handoff that is already running.
  const session = fakeStateSession('active');
  const audioSession = createAudioSession({ session, defer: () => {} });
  let resumed = 0;
  audioSession.onResume(() => { resumed += 1; });
  session.set('inactive');
  session.set('active');
  assert.equal(resumed, 0, 'an idle session becoming active is not an interruption');
  // And the edge must fire again on a second interruption, not only the first.
  session.set('interrupted');
  session.set('active');
  assert.equal(resumed, 1);
  session.set('interrupted');
  session.set('active');
  assert.equal(resumed, 2, 'every interruption must be recoverable, not just the first');
});

test('a page that is interrupted when it loads still recovers once', () => {
  const session = fakeStateSession('interrupted');
  const audioSession = createAudioSession({ session, defer: () => {} });
  let resumed = 0;
  audioSession.onResume(() => { resumed += 1; });
  session.set('active');
  assert.equal(resumed, 1);
});

test('no interruption hook on a browser without the API', () => {
  // Chromium and Firefox land here. The module must stay a no-op rather than
  // throwing into the player's setup.
  const audioSession = createAudioSession({ session: null });
  assert.equal(audioSession.onResume(() => {}), false);
  const noEvents = createAudioSession({ session: fakeSession() });
  assert.equal(noEvents.onResume(() => {}), false, 'a session with no addEventListener is a no-op');
  assert.equal(noEvents.onResume(null), false, 'a non-function callback is ignored');
});

// ── the wiring (static) ─────────────────────────────────────────────────

test('the player delegates the audio session to the tested module', () => {
  assert.match(APP, /import \{ createAudioSession \} from '\.\/audio-session\.js'/);
  assert.equal(APP.match(/createAudioSession\(/g)?.length, 1,
    'one instance, so the cooldown and the cached value agree');
  // The regression this file exists for: a bare re-assertion of 'playback'.
  // It reads as correct and does nothing once WebKit's cache holds that value.
  assert.doesNotMatch(APP, /navigator\.audioSession/,
    'assign navigator.audioSession only through public/audio-session.js');
});

test('every moment the category can be lost re-sends it', () => {
  // Rule 1: the first gesture claims it, whatever that gesture is.
  assert.match(near(APP, "for (const gesture of ['pointerdown', 'keydown']", 400),
    /claimAudioSession\(\)/, 'the first gesture must claim the session');

  // Locking and unlocking: both directions, before anything else in the
  // handler. (`near` from the top of the file would find the keep-alive
  // listener instead, so anchor on the player's own handler.)
  const visibility = near(APP, "document.addEventListener('visibilitychange', () => {\n  // Locking the phone", 500);
  assert.match(visibility, /repairAudioSession\(\)/,
    'the lock screen is where the session is lost');
  // A restored page has a fresh process chain behind the same DOM.
  assert.match(near(APP, "addEventListener('pageshow'", 200), /repairAudioSession\(/);
  assert.match(near(APP, "addEventListener('resume'", 200), /repairAudioSession\(\{ force: true \}\)/);
  // A track that starts while the screen is off: no gesture, no visibility
  // change, no other event at all. (The window covers the whole handler, which
  // also converges a hidden page onto the queue stream.)
  assert.match(near(APP, "addEventListener('playing'", 2800), /repairAudioSession\(\)/,
    'a lock-screen skip must not be the one silent case');
});

test('an interrupted session is resumed, not just re-claimed', () => {
  // iOS pauses the element without telling the page; a transport that shows
  // "playing" over silence is worse than an honest pause.
  const resume = near(APP, 'function resumeAfterInterruption', 1400);
  assert.match(resume, /claimAudioSession\(\)/);
  assert.match(resume, /audio\.play\(\)/);
  assert.match(resume, /state\.playing = false/, 'a refused resume must not lie');
  // A bounded retry count: the watchdog below re-arms the intent on every
  // refusal, so an interruption that never ends must not retry forever.
  assert.match(resume, /state\.resumeAttempts/, 'an endless resume loop');

  // A pause that arrives while the screen is off was iOS (a call, Siri), not
  // the user — unless the user pressed pause on the lock screen itself, which
  // marks the pause as deliberate.
  const pause = near(APP, "audio.addEventListener('pause'", 800);
  assert.match(pause, /visibilityState === 'hidden'/);
  assert.match(pause, /state\.resumeOnVisible = true/);
  assert.match(pause, /!state\.userPause/, 'a lock-screen pause must not be undone');
  assert.match(near(APP, '// This is a person pressing pause on the lock screen', 300),
    /state\.userPause = true/);
  // Coming back to the page picks the track up rather than demanding a tap.
  // The decision now lives in one place (shared with the audio-session hook
  // below), so the assertion follows it instead of the inlined call. The window
  // covers the whole handler, which also hands the queue stream back to the
  // per-track player on the way in (public/queue-stream.js).
  assert.match(near(APP, "document.addEventListener('visibilitychange', () => {\n  // Locking the phone", 3000),
    /resumeIfInterrupted\(\)/);
  assert.match(near(APP, 'function resumeIfInterrupted', 600), /resumeAfterInterruption\(\)/);
});

test('an interruption that ends in the background resumes too', () => {
  // The reported failure: the app is open, the phone is in another app, the
  // interruption (a call, Maps) ends and the listener never comes back to us.
  // No visibilitychange fires, so the session's own statechange is the only
  // witness — without it the player stayed paused until the app was opened, and
  // a paused background tab never auto-advances to the next track.
  assert.match(near(APP, 'audioSession.onResume(', 400), /resumeIfInterrupted\(\)/);
  // The statechange net only fires if WebKit classified the takeover as an
  // interruption. Another app grabbing the output (Discord, a game) does not
  // always qualify, and the listener never comes back to fire a
  // `visibilitychange`, so the page has to notice on its own: a periodic check
  // while hidden is the last-resort witness.
  assert.match(near(APP, 'The last-resort net: notice on our own', 2200),
    /setInterval\(\(\) => \{[\s\S]{0,300}resumeIfInterrupted\(\);/);
  // And the intent must survive a refused play(): that is the state the app
  // switch actually produced (pause mid-swap, then a rejected play), where
  // `state.playing` is deliberately false so the transport does not lie.
  assert.match(near(APP, 'function resumeIfInterrupted', 700), /state\.resumeWanted/);
  assert.match(near(APP, "audio.play().catch((err) => {\n    // A superseded source", 900),
    /state\.resumeWanted = true/);
  assert.doesNotMatch(APP, /navigator\.audioSession/,
    'the statechange wiring belongs in public/audio-session.js with the rest of the API');
  // A room's playhead is the server's own corrector; a local resume there would
  // fight it, so the shared decision point has to keep the room out.
  assert.match(near(APP, 'function resumeIfInterrupted', 400), /if \(rooms\.active\) return/);
});

test('the guest room page claims the category too', () => {
  // A guest has exactly one gesture and no app shell: without this the room is
  // ambient, which the Ring/Silent switch silences.
  assert.match(LISTEN, /import \{ createAudioSession \} from '\.\/audio-session\.js'/);
  // The claim has to be inside the start handler: that tap is the guest's one
  // gesture, and a category set outside it is ignored. The handler is a named
  // function (`startPlayback`) because both views share it — the player's
  // overlay and the venue's own gate — so the assertion follows the wiring from
  // the button to that function and then to the claim.
  assert.match(LISTEN, /\$\('listen-start'\)\??\.addEventListener\('click', startPlayback\)/);
  assert.match(LISTEN, /async function startPlayback\(\) \{[\s\S]{0,600}audioSession\.claim\(\)/);
  assert.match(near(LISTEN, "document.addEventListener('visibilitychange'", 400), /audioSession\.repair\(\)/);
});

// ── the real assignment sequence ────────────────────────────────────────

// Records every category the page hands to WebKit. Chromium has no Audio
// Session API, so this is also what makes the browser case reachable here.
const INSTRUMENT = `(() => {
  const writes = [];
  let type = 'auto';
  const session = {
    get type() { return type; },
    set type(v) { writes.push(v); type = v; },
  };
  Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
  window.__as = { writes, get type() { return type; } };
})();`;

let server;
let browser;
let BASE;

before(async () => {
  server = await startServer();
  BASE = server.base;
  if (CHROME) {
    browser = await launch(await freePort());
    await browser.addInitScript(INSTRUMENT);
  }
});

after(async () => {
  browser?.close();
  await server?.stop();
});

test('the page sends playback at load, and re-sends it after a lock', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.goto(`${BASE}/`);
  await browser.waitFor('!!window.__as');

  // Loading the app establishes the category: a restore fires pageshow, and
  // rule 1 wants it early — so the page is a music player before any audio
  // exists, and, crucially, ends on playback rather than on ambient.
  await browser.waitFor('window.__as.writes.length > 0');
  assert.equal(await browser.eval('window.__as.type'), PLAYBACK);
  assert.equal(await browser.eval('window.__as.writes.at(-1)'), PLAYBACK);
  // The load-time cycle is a repair, not a bare claim: ambient then playback,
  // which is what forces WebKit to send the category again.
  assert.deepEqual(await browser.eval('window.__as.writes.slice(0, 2)'), [AMBIENT, PLAYBACK],
    'a re-assertion alone cannot repopulate a GPU-side session that fell back to ambient');

  // The cooldown: another event straight after is not worth a second cycle
  // (the ambient step briefly lets other audio mix back in).
  const settled = await browser.eval('window.__as.writes.length');
  await browser.eval("dispatchEvent(new Event('pageshow'))");
  await browser.eval("document.dispatchEvent(new Event('visibilitychange'))");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await browser.eval('window.__as.writes.length'), settled,
    'pageshow or visibilitychange right after a repair must not cycle again');

  // ...unless it is a resume from the freezer, which is forced: that page comes
  // back with a fresh process chain and must not wait out the cooldown.
  await browser.eval("dispatchEvent(new Event('resume'))");
  await browser.waitFor(`window.__as.writes.length >= ${settled + 2}`);
  assert.deepEqual(await browser.eval(`window.__as.writes.slice(${settled}, ${settled + 2})`),
    [AMBIENT, PLAYBACK]);

  // A real gesture claims it, and nothing about the flow leaves the page muted.
  await browser.eval(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  assert.equal(await browser.eval('window.__as.type'), PLAYBACK);
});

