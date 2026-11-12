import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { CHROME, freePort, launch } from './helpers/cdp.js';
import {
  ART_SIZE,
  artSrc,
  artwork,
  createMediaSession,
} from '../public/media-session.js';

// These cover the three things iOS drops *silently* on a locked phone:
// cross-origin artwork, artwork with a lying `sizes`, and a missing position
// state (no seek bar). None of them produce an error anywhere else.

const BASE = 'https://sonora.example/';
const THUMB = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';

/** A stand-in <audio> element with just the properties the module reads. */
function fakeAudio(over = {}) {
  return {
    duration: 200,
    currentTime: 0,
    playbackRate: 1,
    paused: false,
    fastSeek: null,
    ...over,
  };
}

/** Records every Media Session call. Throws like iOS on an invalid range. */
function fakeMediaSession() {
  const calls = { positions: [], handlers: {}, metadata: null, playbackState: 'none' };
  return {
    calls,
    get metadata() { return calls.metadata; },
    set metadata(v) { calls.metadata = v; },
    get playbackState() { return calls.playbackState; },
    set playbackState(v) { calls.playbackState = v; },
    setPositionState(state) {
      if (!state) return;
      const { duration, position, playbackRate } = state;
      assert.ok(Number.isFinite(duration) && duration > 0, 'duration must be finite');
      assert.ok(position >= 0 && position <= duration, `position ${position} out of range`);
      assert.ok(Number.isFinite(playbackRate) && playbackRate > 0, 'playbackRate must be positive');
      calls.positions.push(state);
    },
    setActionHandler(name, fn) { calls.handlers[name] = fn; },
  };
}

class FakeMediaMetadata {
  constructor(init) { Object.assign(this, init); }
}

function setup({ track = { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channel: 'Rick Astley', thumb: THUMB }, audio = fakeAudio(), handlers = {}, hooks = {}, warmArtwork = null, isHidden = null, now = null } = {}) {
  const mediaSession = fakeMediaSession();
  const session = createMediaSession({
    audio,
    mediaSession,
    MediaMetadata: FakeMediaMetadata,
    base: BASE,
    getTrack: () => track,
    handlers,
    hooks,
    warmArtwork,
    ...(isHidden ? { isHidden } : {}),
    ...(now ? { now } : {}),
  });
  return { session, mediaSession, calls: mediaSession.calls, audio, track };
}

// ── artwork ─────────────────────────────────────────────────────────────
test('artwork is rewritten to the same-origin proxy and made absolute', () => {
  assert.equal(artSrc(THUMB, BASE), 'https://sonora.example/api/img/dQw4w9WgXcQ');
  // A relative base must still produce an absolute URL: iOS ignores relative
  // artwork srcs.
  assert.match(artSrc(THUMB, 'https://sonora.example/player'), /^https:\/\/sonora\.example\/api\/img\//);
});

test('allowlisted CDN avatars go through the query proxy', () => {
  const avatar = 'https://yt3.ggpht.com/abc123=s88';
  assert.equal(
    artSrc(avatar, BASE),
    `https://sonora.example/api/img?u=${encodeURIComponent(avatar)}`,
  );
});

test('any https artwork is proxied, so a new CDN cannot fall behind the server allowlist', () => {
  // YouTube moved release covers to yt3.googleusercontent.com, which was on
  // neither allowlist: it stayed cross-origin (a Google fetch from the browser)
  // and the iOS lock screen dropped it.
  for (const art of [
    'https://yt3.googleusercontent.com/_y-a_KSdeH1=w544-h544-l90-rj',
    'https://lh3.googleusercontent.com/G-Vsaq4pw6Bl5Ny4=w120-h120-p-l90-rj',
    'https://lh3.googleusercontent.com/abc=s88',
    'https://some-future-cdn.example/cover.jpg',
    '//yt3.ggpht.com/protocol-relative=s88',
  ]) {
    const src = artSrc(art, BASE);
    assert.match(src, /^https:\/\/sonora\.example\/api\/img\?u=/, `${art} must be proxied`);
    const upstream = decodeURIComponent(src.split('?u=')[1]);
    assert.equal(upstream, art.startsWith('//') ? `https:${art}` : art);
  }
});

test('artwork with no usable thumb is empty, not a broken entry', () => {
  assert.equal(artSrc(null, BASE), null);
  assert.equal(artSrc('', BASE), null);
  assert.equal(artSrc('   ', BASE), null);
  assert.deepEqual(artwork(null, BASE), []);
  // A non-http scheme is not artwork. `javascript:` in an <img src> or in
  // MediaMetadata is a payload, and `data:` cannot be proxied at all.
  assert.equal(artSrc('javascript:alert(1)', BASE), null);
  assert.equal(artSrc('data:image/svg+xml,<svg onload=alert(1)>', BASE), null);
  assert.equal(artSrc('file:///etc/passwd', BASE), null);
  assert.deepEqual(artwork('javascript:alert(1)', BASE), []);
  // The app's own relative image stays relative-but-absolute.
  assert.equal(artSrc('/icons/icon-192.png', BASE), 'https://sonora.example/icons/icon-192.png');
});

test('declared sizes match what /api/img really serves', () => {
  const [art] = artwork(THUMB, BASE);
  assert.equal(art.sizes, ART_SIZE);
  assert.equal(ART_SIZE, '320x180'); // mqdefault.jpg, 16:9
  // No declared type: /api/img relays the upstream content-type verbatim
  // (jpeg/png/webp/avif/gif), so any hardcoded type is a lie waiting for an
  // upstream that answers something else — and iOS drops artwork whose type
  // disagrees with the bytes, silently, exactly like a wrong `sizes`.
  assert.equal(art.type, undefined);
  assert.match(art.src, /^https:\/\/sonora\.example\/api\/img\//);
});

test('an avatar has no declared size rather than a wrong one', () => {
  const [art] = artwork('https://yt3.ggpht.com/abc123=s88', BASE);
  assert.equal(art.sizes, undefined);
  assert.match(art.src, /^https:\/\/sonora\.example\/api\/img\?u=/);
});

// ── metadata ────────────────────────────────────────────────────────────
test('sync publishes title, artist, album, artwork and playback state', () => {
  const { session, calls } = setup();
  session.sync({ metadata: true });

  assert.equal(calls.metadata.title, 'Never Gonna Give You Up');
  assert.equal(calls.metadata.artist, 'Rick Astley');
  assert.equal(calls.metadata.album, 'sonora');
  assert.equal(calls.metadata.artwork.length, 1);
  assert.equal(calls.playbackState, 'playing');
});

test('a paused element reports paused state', () => {
  const { session, calls } = setup({ audio: fakeAudio({ paused: true }) });
  session.sync({ metadata: true });
  assert.equal(calls.playbackState, 'paused');
});

test('a source swap never tells the OS the app paused', () => {
  // Assigning a new `src` pauses the element for the length of the cold load
  // (seconds on a phone). Publishing that pause flips the lock screen / Android
  // notification to "paused" mid-track-change, which is what reads as the media
  // widget going blank — the reported symptom. While a swap is in flight the
  // state must stay `playing`; a real pause still goes through once the swap
  // marker is cleared.
  let switching = true;
  const calls = [];
  const { session, mediaSession } = setup({
    audio: fakeAudio({ paused: true }),
    hooks: { isSwitching: () => switching },
  });
  const proto = Object.getPrototypeOf(mediaSession);
  Object.defineProperty(mediaSession, 'playbackState', {
    configurable: true,
    get() { return proto && mediaSession.calls.playbackState; },
    set(v) { calls.push(v); mediaSession.calls.playbackState = v; },
  });
  mediaSession.calls.playbackState = 'playing';

  session.sync({ force: true });
  assert.deepEqual(calls, [], 'a swap in flight must not publish a paused state');

  switching = false;
  session.sync({ force: true });
  assert.deepEqual(calls, ['paused'], 'a real pause is still published');
});

test('a track with no title falls back to its id instead of undefined', () => {
  const { session, calls } = setup({ track: { videoId: 'abcdefghijk', thumb: null } });
  session.sync({ metadata: true });
  assert.equal(calls.metadata.title, 'abcdefghijk');
  assert.equal(calls.metadata.artist, '');
  assert.deepEqual(calls.metadata.artwork, []);
});

test('artwork is warmed once per track so the lock screen never does a cold fetch', () => {
  const warmed = [];
  const { session } = setup({ warmArtwork: (src) => warmed.push(src) });
  session.sync({ metadata: true });
  // playing, loadedmetadata and durationchange all refresh the metadata.
  session.sync({ metadata: true });
  session.sync({ metadata: true });
  assert.deepEqual(warmed, ['https://sonora.example/api/img/dQw4w9WgXcQ']);
});

test('sync without metadata leaves the current metadata alone', () => {
  const { session, calls } = setup();
  session.sync({ metadata: true });
  const first = calls.metadata;
  session.sync({ force: true });
  assert.equal(calls.metadata, first);
});

// ── position state (the lock-screen seek bar) ───────────────────────────
test('position state is reported so the lock screen draws a seek bar', () => {
  const { session, calls } = setup({ audio: fakeAudio({ currentTime: 42, duration: 200 }) });
  assert.equal(session.position(true), true);
  assert.deepEqual(calls.positions.at(-1), { duration: 200, playbackRate: 1, position: 42 });
});

test('no position state without a finite duration (a live stream has none)', () => {
  for (const duration of [Number.NaN, Infinity, 0, -1, undefined]) {
    const { session, calls } = setup({ audio: fakeAudio({ duration }) });
    assert.equal(session.position(true), false, `duration ${duration}`);
    assert.equal(calls.positions.length, 0);
  }
});

test('a durationless source still keeps its track buttons', () => {
  // Ordering, and it is load-bearing: keepAlive() runs *before* the duration
  // guard in position(). A room stream or a live track can report no finite
  // duration for a while, and if the heartbeat sat behind that guard those
  // pages would lose previous/next on a locked phone with nothing left to
  // restore it — the guest room has no queue and no next event to ride.
  const c = clock();
  const { session, calls } = setup({
    audio: fakeAudio({ duration: Number.NaN, currentTime: 30 }),
    isHidden: c.isHidden,
    now: c.now,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });
  assert.equal(session.position(true), false, 'there is still no bar to draw');
  assert.equal(calls.positions.length, 0);
  assert.equal(typeof calls.handlers.nexttrack, 'function',
    'the buttons must be re-registered even without a duration');
  assert.equal(typeof calls.handlers.previoustrack, 'function');
  assert.equal(calls.handlers.seekbackward, null);
});

test('position is clamped to the duration instead of throwing a RangeError', () => {
  // A seek racing a source swap can leave currentTime past the new duration.
  const { session, calls } = setup({ audio: fakeAudio({ currentTime: 210, duration: 200 }) });
  assert.equal(session.position(true), true);
  assert.equal(calls.positions.at(-1).position, 200);
});

test('negative currentTime is clamped to zero', () => {
  const { session, calls } = setup({ audio: fakeAudio({ currentTime: -3, duration: 200 }) });
  session.position(true);
  assert.equal(calls.positions.at(-1).position, 0);
});

test('timeupdate chatter is throttled but a real jump is reported', () => {
  const audio = fakeAudio({ currentTime: 10, duration: 200 });
  const { session, calls } = setup({ audio });
  session.position();
  assert.equal(calls.positions.length, 1);

  // Four updates a second: only sub-second drift, so nothing is sent.
  for (const t of [10.25, 10.5, 10.75]) {
    audio.currentTime = t;
    session.position();
  }
  assert.equal(calls.positions.length, 1);

  // A seek is a real jump and must be reported immediately.
  audio.currentTime = 120;
  session.position(true);
  assert.equal(calls.positions.length, 2);
  assert.equal(calls.positions.at(-1).position, 120);

  // One second of ordinary playback is worth reporting.
  audio.currentTime = 121;
  session.position();
  assert.equal(calls.positions.length, 3);
});

test('a duration change re-reports even at the same position', () => {
  const audio = fakeAudio({ currentTime: 5, duration: 200 });
  const { session, calls } = setup({ audio });
  session.position();
  assert.equal(calls.positions.length, 1);
  audio.duration = 180;
  session.position();
  assert.equal(calls.positions.length, 2);
});

test('a throwing setPositionState is swallowed, never breaks playback', () => {
  const audio = fakeAudio();
  const mediaSession = fakeMediaSession();
  mediaSession.setPositionState = () => { throw new TypeError('nope'); };
  const session = createMediaSession({ audio, mediaSession, base: BASE, MediaMetadata: FakeMediaMetadata });
  assert.equal(session.position(true), false);
  assert.doesNotThrow(() => session.sync({ force: true }));
});

test('a track getter that throws still leaves the lock screen playable', () => {
  const mediaSession = fakeMediaSession();
  const session = createMediaSession({
    audio: fakeAudio({ currentTime: 30 }),
    mediaSession,
    base: BASE,
    MediaMetadata: FakeMediaMetadata,
    getTrack: () => { throw new TypeError('track is gone'); },
  });
  assert.doesNotThrow(() => session.sync({ metadata: true }));
  // The state and the seek bar matter more than the metadata that just failed.
  assert.equal(mediaSession.calls.playbackState, 'playing');
  assert.equal(mediaSession.calls.positions.at(-1).position, 30);
});

test('a platform that rejects one action handler still gets the others', () => {
  const mediaSession = fakeMediaSession();
  // iOS has shipped builds that throw from setActionHandler for an action it
  // does not know; aborting there would leave the whole lock screen dead.
  const set = mediaSession.setActionHandler;
  mediaSession.setActionHandler = (name, fn) => {
    if (name === 'seekbackward' || name === 'previoustrack') throw new TypeError('unsupported');
    set(name, fn);
  };
  const audio = fakeAudio();
  const session = createMediaSession({
    audio,
    mediaSession,
    base: BASE,
    MediaMetadata: FakeMediaMetadata,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });
  assert.equal(session.installHandlers(), true);
  assert.equal(typeof mediaSession.calls.handlers.nexttrack, 'function', 'a rejected neighbour must not stop registration');
  assert.equal(typeof mediaSession.calls.handlers.seekto, 'function', 'the seek bar survives');
  assert.equal(mediaSession.calls.handlers.seekbackward, undefined);
});

test('a media session without an audio element is a no-op, not a crash', () => {
  const session = createMediaSession({ audio: null, mediaSession: fakeMediaSession(), base: BASE, MediaMetadata: FakeMediaMetadata });
  assert.equal(session.position(true), false);
  assert.doesNotThrow(() => session.sync({ metadata: true, force: true }));
  assert.equal(session.installHandlers(), true);
  assert.doesNotThrow(() => session.sync({ metadata: true }));
});

// ── action handlers ─────────────────────────────────────────────────────
test('play/pause/stop/next/previous handlers are wired to the app', () => {
  const fired = [];
  const { session, calls } = setup({
    handlers: {
      play: () => fired.push('play'),
      pause: () => fired.push('pause'),
      stop: () => fired.push('stop'),
      nexttrack: () => fired.push('next'),
      previoustrack: () => fired.push('prev'),
    },
  });
  session.installHandlers();
  calls.handlers.play();
  calls.handlers.pause();
  calls.handlers.stop();
  calls.handlers.nexttrack();
  calls.handlers.previoustrack();
  assert.deepEqual(fired, ['play', 'pause', 'stop', 'next', 'prev']);
});

test('a hard stop publishes `none` and a stray pause cannot bring the widget back', () => {
  // The failure this pins: after the player gave up (or the OS's stop button was
  // pressed) the element is paused with no source, so `sync` reports `paused` —
  // a live player sitting on nothing, which keeps the Now Playing widget on
  // screen over silence. The `pause` event arrives *after* the stop, so `none`
  // has to outlive at least one sync; audible playback clears it again.
  const { session, audio, calls } = setup();
  session.stopped();
  assert.equal(calls.playbackState, 'none');
  // The element's own pause event, one task later.
  audio.paused = true;
  session.sync({ force: true, metadata: true });
  assert.equal(calls.playbackState, 'none', 'a hard stop must not be republished as a paused player');
  // The listener presses play: the widget has to come back with the audio.
  audio.paused = false;
  session.sync({ force: true });
  assert.equal(calls.playbackState, 'playing');
});

test('a platform without a stop action still gets play/pause', () => {
  // `stop` is optional in Media Session; one unsupported action must not cost
  // the rest (same rule as the seek commands below).
  const mediaSession = fakeMediaSession();
  const real = mediaSession.setActionHandler;
  mediaSession.setActionHandler = (name, fn) => {
    if (name === 'stop') throw new TypeError('unsupported');
    return real(name, fn);
  };
  const session = createMediaSession({
    audio: fakeAudio(), mediaSession, MediaMetadata: FakeMediaMetadata, base: BASE,
    handlers: { play: () => {}, stop: () => {} },
  });
  assert.equal(session.installHandlers(), true);
  assert.equal(typeof mediaSession.calls.handlers.play, 'function');
});

test('±10s buttons are removed so iOS keeps previous/next', () => {
  const { session, calls } = setup();
  session.installHandlers();
  assert.equal(calls.handlers.seekbackward, null);
  assert.equal(calls.handlers.seekforward, null);
});

// ── the locked-phone keep-alive ─────────────────────────────────────────
// The reported bug: on a locked iPhone the media centre shows ±seek buttons
// instead of previous/next. WebKit rebuilds the page's remote-command listener
// empty when the GPU process is relaunched (which locking a backgrounded tab
// does), and an empty set falls back to WebKit's `defaultCommands()` — which
// has SkipForward/SkipBackward but no PreviousTrack/NextTrack. Only a
// setActionHandler call with a real handler puts a command back, and the player
// never pauses on a background handoff, so no `playing`/`pause` event arrives
// to trigger one. These pin the heartbeat that does.

/** A clock the test drives, plus a visibility flag. */
function clock(start = 1_000_000) {
  let at = start;
  let hidden = true;
  return {
    now: () => at,
    isHidden: () => hidden,
    advance: (ms) => { at += ms; },
    setVisible: () => { hidden = false; },
    setHidden: () => { hidden = true; },
  };
}

test('a hidden page re-registers previous/next from the playhead tick', () => {
  const c = clock();
  const { session, calls } = setup({
    isHidden: c.isHidden,
    now: c.now,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });
  // The page locked before this tick: the handlers are already gone by now.
  session.keepAlive();
  assert.equal(typeof calls.handlers.previoustrack, 'function');
  assert.equal(typeof calls.handlers.nexttrack, 'function');
  assert.equal(calls.handlers.seekbackward, null);
  assert.equal(calls.handlers.seekforward, null);
});

test('position() drives the keep-alive, so timeupdate alone holds the buttons', () => {
  // This is the wiring that matters: on a locked iPhone `timeupdate` is the one
  // event that keeps firing, and app.js feeds it to position(). A heartbeat
  // nothing calls would never run.
  const c = clock();
  const audio = fakeAudio({ currentTime: 0, duration: 200 });
  const { session, calls } = setup({
    audio,
    isHidden: c.isHidden,
    now: c.now,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });
  // Simulate the relaunch: everything but the seek commands is gone.
  for (const name of ['previoustrack', 'nexttrack', 'play', 'pause']) {
    calls.handlers[name] = undefined;
  }
  audio.currentTime = 5;
  session.position();
  assert.equal(typeof calls.handlers.previoustrack, 'function',
    'a single position() while hidden must restore previous');
  assert.equal(typeof calls.handlers.nexttrack, 'function');
});

test('the keep-alive is fast just after locking, then backs off', () => {
  const c = clock();
  const mediaSession = fakeMediaSession();
  // Count re-registrations of one action: installHandlers always hands over a
  // fresh closure, so a call is a beat.
  const beats = [];
  const real = mediaSession.setActionHandler.bind(mediaSession);
  mediaSession.setActionHandler = (name, fn) => {
    if (name === 'nexttrack') beats.push(c.now());
    return real(name, fn);
  };
  const session = createMediaSession({
    audio: fakeAudio(),
    mediaSession,
    base: BASE,
    MediaMetadata: FakeMediaMetadata,
    isHidden: c.isHidden,
    now: c.now,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });

  session.keepAlive();
  assert.equal(beats.length, 1, 'the first beat must land immediately');

  // ~4 timeupdate ticks a second. The one-second fast cadence must suppress the
  // three intervening ticks but never let the window around the relaunch go
  // silent: that window is exactly when the command set is emptied.
  for (let i = 0; i < 5; i++) { c.advance(250); session.keepAlive(); }
  assert.equal(beats.length, 2,
    `the immediate beat plus one at the first tick after 1s is exact, got ${beats.length}`);
  assert.equal(beats.at(-1) - beats.at(-2), 1000,
    'the first fast re-registration lands on the tick at a full second');

  // Clear the fast window (30 s) and establish a slow beat, then advance
  // exactly one slow interval through quarter-second ticks. Only the boundary
  // may re-register — a phone can stay locked for hours.
  c.advance(60_000);
  session.keepAlive();
  const before = beats.length;
  for (let i = 0; i < 60; i++) { c.advance(250); session.keepAlive(); }
  assert.equal(beats.length - before, 1,
    '15s of slow-window ticks produces exactly one boundary beat');
  assert.equal(beats.at(-1) - beats.at(-2), 15_000,
    'the slow cadence is one beat per 15s');
});

test('a visible page does not heartbeat: the page owns re-registration', () => {
  const c = clock();
  c.setVisible();
  const { session, calls } = setup({
    isHidden: c.isHidden,
    now: c.now,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });
  assert.equal(session.keepAlive(), false);
  assert.equal(calls.handlers.nexttrack, undefined,
    'keepAlive must not register anything while the page is in front');
  // And returning to hidden starts over on the fast cadence.
  c.setHidden();
  assert.equal(session.keepAlive(), true);
  assert.equal(typeof calls.handlers.nexttrack, 'function');
});

test('a seek from the lock screen cannot recurse into the keep-alive', () => {
  // seekto → position() → keepAlive() → installHandlers() → a fresh seekto
  // closure. Without the guard this is infinite recursion on the one input the
  // locked listener can actually make.
  const c = clock();
  const audio = fakeAudio({ currentTime: 40, duration: 200 });
  const { session, calls } = setup({
    audio,
    isHidden: c.isHidden,
    now: c.now,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });
  session.installHandlers();
  assert.doesNotThrow(() => calls.handlers.seekto({ seekTime: 10 }));
  assert.equal(audio.currentTime, 10);
  assert.equal(calls.positions.at(-1).position, 10);
});

test('a platform that refuses the heartbeat is a no-op, not a crash', () => {
  const c = clock();
  const mediaSession = fakeMediaSession();
  mediaSession.setActionHandler = () => { throw new TypeError('gone'); };
  const session = createMediaSession({
    audio: fakeAudio(),
    mediaSession,
    base: BASE,
    MediaMetadata: FakeMediaMetadata,
    isHidden: c.isHidden,
    now: c.now,
    handlers: { previoustrack: () => {}, nexttrack: () => {} },
  });
  // installHandlers swallows per-action failures and still reports true, so the
  // assertion is that nothing throws and playback is untouched.
  assert.doesNotThrow(() => session.keepAlive());
  assert.doesNotThrow(() => session.position(true));
  assert.doesNotThrow(() => session.sync({ metadata: true, force: true }));
});

test('a hidden page with no media session still reports no keep-alive', () => {
  const c = clock();
  const session = createMediaSession({
    audio: fakeAudio(),
    mediaSession: null,
    base: BASE,
    isHidden: c.isHidden,
    now: c.now,
  });
  assert.equal(session.keepAlive(), false);
});

test('the lock-screen scrubber actually seeks, and reports the new position', () => {
  const audio = fakeAudio({ currentTime: 0, duration: 200 });
  const events = [];
  const { session, calls } = setup({
    audio,
    hooks: {
      onSeekStart: (to) => events.push(['start', to]),
      onSeekEnd: (at) => events.push(['end', at]),
    },
  });
  session.installHandlers();
  calls.handlers.seekto({ seekTime: 87.5 });

  assert.equal(audio.currentTime, 87.5);
  assert.deepEqual(events, [['start', 87.5], ['end', 87.5]]);
  assert.equal(calls.positions.at(-1).position, 87.5);
});

test('seekto uses fastSeek when the platform offers it', () => {
  const fast = [];
  const audio = fakeAudio({ currentTime: 0, fastSeek: (t) => fast.push(t) });
  const { session, calls } = setup({ audio });
  session.installHandlers();
  calls.handlers.seekto({ seekTime: 30, fastSeek: true });
  assert.deepEqual(fast, [30]);
});

test('a garbage seekto payload is ignored instead of seeking to NaN', () => {
  const audio = fakeAudio({ currentTime: 12 });
  const { session, calls } = setup({ audio });
  session.installHandlers();
  calls.handlers.seekto({});
  calls.handlers.seekto({ seekTime: 'later' });
  calls.handlers.seekto({ seekTime: -5 });
  assert.equal(audio.currentTime, 12);
});

test('re-installing handlers is safe (iOS drops them across interruptions)', () => {
  const { session, calls } = setup();
  assert.equal(session.installHandlers(), true);
  const first = calls.handlers.seekto;
  assert.equal(session.installHandlers(), true);
  assert.notEqual(calls.handlers.seekto, first);
});

test('a browser without the Media Session API is a no-op, not a crash', () => {
  const session = createMediaSession({ audio: fakeAudio(), mediaSession: null, base: BASE });
  assert.equal(session.installHandlers(), false);
  assert.equal(session.position(true), false);
  assert.doesNotThrow(() => session.sync({ metadata: true, force: true }));
});

// ── real browser ──────────────────────────────────────────────────────────
//
// The node tests above inject `isHidden`/`now`, which cannot cover the *default*
// bindings — the ones a locked iPhone actually hits. Those read
// `globalThis.document.visibilityState` and `Date.now()`. So this drives real
// Chromium with a real `navigator.mediaSession`, and models the lock the way
// test/track-handoff.test.js does: by overriding the property the code reads,
// because this Chromium has no Emulation.setPageVisibility.

let browser;

before(async () => {
  if (CHROME) browser = await launch(await freePort());
});

after(() => { browser?.close(); });

/** Every setActionHandler call the page makes, in order, from load time. */
const INSTRUMENT = `(() => {
  window.__reg = [];
  const ms = navigator.mediaSession;
  if (!ms) return;
  const real = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (name, fn) => {
    window.__reg.push({ name, kind: typeof fn === 'function' ? 'fn' : 'null' });
    return real(name, fn);
  };
})();`;

test('a locked page re-registers previous/next from its own playhead', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.addInitScript(INSTRUMENT);
  await browser.goto('data:text/html,<title>ms</title>');

  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../public/media-session.js', import.meta.url), 'utf8'));

  // Load the real module, then lock the page and tick the playhead the way
  // timeupdate does — roughly 4x a second, which is what the throttle is for.
  const out = await browser.eval(`(async () => {
    const src = ${JSON.stringify(src)};
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const mod = await import(url);
    const audio = { duration: 200, currentTime: 0, playbackRate: 1, paused: false, fastSeek: null };
    const session = mod.createMediaSession({
      audio,
      getTrack: () => ({ videoId: 'abc', title: 'T', thumb: null }),
      base: 'https://sonora.example/',
      handlers: {
        play: () => {},
        pause: () => {},
        previoustrack: () => {},
        nexttrack: () => {},
      },
    });
    session.installHandlers();
    const afterInstall = window.__reg.length;

    // The phone locks. This is the state WebKit leaves behind after the GPU
    // relaunch: the command set is empty and the page can see nothing.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get() { return 'hidden'; },
    });

    // Tick the playhead on real timers, the way timeupdate does — roughly 4x a
    // second for five seconds of locked playback. A synchronous loop would not
    // move Date.now() at all, and the cadence is a wall-clock rate limit, so it
    // would beat once and look broken.
    for (let i = 0; i < 20; i++) {
      audio.currentTime += 0.25;
      session.position();
      await new Promise((r) => setTimeout(r, 250));
    }

    const beats = window.__reg.slice(afterInstall);
    const names = beats.map((r) => r.name);
    const counts = {};
    for (const n of names) counts[n] = (counts[n] ?? 0) + 1;

    // A beat that re-registered the track buttons.
    const restored = names.includes('previoustrack') && names.includes('nexttrack');
    // ...and the ones it must keep out of the set.
    const nulled = beats.some((r) => r.name === 'seekbackward' && r.kind === 'null')
      && beats.some((r) => r.name === 'seekforward' && r.kind === 'null');
    const seekNeverFnned = !beats.some((r) =>
      (r.name === 'seekbackward' || r.name === 'seekforward') && r.kind === 'fn');

    return { restored, nulled, seekNeverFnned, counts };
  })()`);

  assert.equal(out.restored, true,
    `a locked page must re-register previoustrack/nexttrack, got ${JSON.stringify(out.counts)}`);
  assert.equal(out.nulled, true,
    'the beat must keep nulling seekbackward/seekforward, or iOS keeps the ±15s buttons');
  assert.equal(out.seekNeverFnned, true,
    'a beat must never register the seek buttons as handlers');
  // Five seconds of ticks at ~4/s is 20 calls; the one-second fast cadence must
  // have beaten several times, not once, and not per tick.
  assert.ok(out.counts.nexttrack >= 2,
    `the beat must repeat while locked, nexttrack registered ${out.counts.nexttrack}x`);
  assert.ok(out.counts.nexttrack < 20,
    `the beat must be throttled, not per tick: nexttrack registered ${out.counts.nexttrack}x of 20 ticks`);
});

test('a visible page does not heartbeat: the page owns re-registration', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.goto('data:text/html,<title>ms</title>');
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../public/media-session.js', import.meta.url), 'utf8'));

  const out = await browser.eval(`(async () => {
    const src = ${JSON.stringify(src)};
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const mod = await import(url);
    const audio = { duration: 200, currentTime: 0, playbackRate: 1, paused: false, fastSeek: null };
    const session = mod.createMediaSession({
      audio, getTrack: () => null, base: 'https://sonora.example/',
      handlers: { play(){}, pause(){}, previoustrack(){}, nexttrack(){} },
    });
    // Never hidden: a foreground page re-registers from its own listeners
    // (playing/pause/visibilitychange), so a heartbeat would be pure waste.
    const before = window.__reg?.length ?? 0;
    for (let i = 0; i < 20; i++) { audio.currentTime += 0.25; session.position(); }
    return { visibility: document.visibilityState,
      added: (window.__reg?.length ?? 0) - before };
  })()`);

  assert.equal(out.visibility, 'visible', 'the page must still be foregrounded');
  assert.equal(out.added, 0,
    'a visible page must not heartbeat: position() registered handlers behind the app\'s back');
});

test('the default hidden binding is what the browser reports, not an injected flag', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.goto('data:text/html,<title>ms</title>');
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../public/media-session.js', import.meta.url), 'utf8'));

  // No isHidden/now injected at all: this is the production wiring, so it proves
  // the default reads the real document and the real clock.
  const out = await browser.eval(`(async () => {
    const src = ${JSON.stringify(src)};
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const mod = await import(url);
    const audio = { duration: 200, currentTime: 0, playbackRate: 1, paused: false, fastSeek: null };
    const session = mod.createMediaSession({
      audio, getTrack: () => null, base: 'https://sonora.example/',
      handlers: { play(){}, pause(){}, previoustrack(){}, nexttrack(){} },
    });
    const before = window.__reg?.length ?? 0;
    await new Promise((r) => setTimeout(r, 1_300));
    audio.currentTime = 3; session.position();
    audio.currentTime = 6; session.position();
    return { added: (window.__reg?.length ?? 0) - before };
  })()`);

  assert.equal(out.added, 0,
    'a visible page must stay quiet through the real bindings too');
});
