import { test } from 'node:test';
import assert from 'node:assert/strict';

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

function setup({ track = { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channel: 'Rick Astley', thumb: THUMB }, audio = fakeAudio(), handlers = {}, hooks = {}, warmArtwork = null } = {}) {
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

test('artwork with no usable thumb is empty, not a broken entry', () => {
  assert.equal(artSrc(null, BASE), null);
  assert.equal(artSrc('', BASE), null);
  assert.deepEqual(artwork(null, BASE), []);
  // A non-allowlisted host is passed through untouched (the browser decides),
  // but it is still made absolute.
  assert.equal(artSrc('https://evil.example/x.jpg', BASE), 'https://evil.example/x.jpg');
});

test('declared sizes match what /api/img really serves', () => {
  const [art] = artwork(THUMB, BASE);
  assert.equal(art.sizes, ART_SIZE);
  assert.equal(ART_SIZE, '320x180'); // mqdefault.jpg, 16:9
  assert.equal(art.type, 'image/jpeg');
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

// ── action handlers ─────────────────────────────────────────────────────
test('play/pause/next/previous handlers are wired to the app', () => {
  const fired = [];
  const { session, calls } = setup({
    handlers: {
      play: () => fired.push('play'),
      pause: () => fired.push('pause'),
      nexttrack: () => fired.push('next'),
      previoustrack: () => fired.push('prev'),
    },
  });
  session.installHandlers();
  calls.handlers.play();
  calls.handlers.pause();
  calls.handlers.nexttrack();
  calls.handlers.previoustrack();
  assert.deepEqual(fired, ['play', 'pause', 'next', 'prev']);
});

test('±10s buttons are removed so iOS keeps previous/next', () => {
  const { session, calls } = setup();
  session.installHandlers();
  assert.equal(calls.handlers.seekbackward, null);
  assert.equal(calls.handlers.seekforward, null);
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
