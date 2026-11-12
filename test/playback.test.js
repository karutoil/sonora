import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffTrack, isLoopWrap, WRAP_FROM, WRAP_TO } from '../public/playback.js';

// The end-of-track detector. It exists because WebKit on a locked iPhone can
// loop an <audio> element without emitting `seeking`; `timeupdate` is the only
// witness. If this function is too eager, a deliberate seek skips a track; if
// it is too shy, the same song repeats forever. Both directions are pinned.

// The handoff exists for its *ordering*: the source must be swapped inside the
// event that saw the track end, synchronously, because a background timer on a
// locked phone may not run until the listener unlocks it. Whether the old
// source is paused on the way out depends on whether anyone can see the page —
// see the test below and public/playback.js for why.

test('a visible track handoff pauses the old source before advancing synchronously', () => {
  const calls = [];
  handoffTrack({ pause: () => calls.push('pause'), next: () => calls.push('next') });
  assert.deepEqual(calls, ['pause', 'next']);
});

test('a background handoff swaps the source without pausing it first', () => {
  // A pause on a backgrounded phone is where iOS reclaims the audio session,
  // and it does not give it back until the listener returns to the app: the
  // next `play()` resolves, the metadata updates, and the Now Playing widget
  // empties out in silence. A manual "next" in the background never pauses, so
  // the auto-advance must not either.
  const calls = [];
  handoffTrack({ pause: () => calls.push('pause'), next: () => calls.push('next'), background: true });
  assert.deepEqual(calls, ['next'], 'a background handoff must not pause the old source');
});

test('a jump from the end back to 0:00 is a loop wrap', () => {
  assert.equal(isLoopWrap(214, 0), true);
  assert.equal(isLoopWrap(214, 0.4), true);
  assert.equal(isLoopWrap(5, WRAP_TO - 0.01), true);
});

test('the first seconds of a track are never the end', () => {
  assert.equal(isLoopWrap(2, 0.2), false, 'a seek at 2s is not a finished track');
  assert.equal(isLoopWrap(WRAP_FROM, 0.2), false, 'the boundary itself is not past it');
  assert.equal(isLoopWrap(0, 0), false, 'a fresh source reporting 0 is not a wrap');
});

test('a deliberate seek is never a wrap', () => {
  assert.equal(isLoopWrap(214, 0, { manualSeek: true }), false,
    'previous / slider / lock-screen scrub to 0 must not skip the track');
});

test('a source that has not played yet is never judged', () => {
  assert.equal(isLoopWrap(214, 0, { started: false }), false,
    'a freshly assigned src reports 0 before its first playing event');
});

test('a small jump is a seek, not a wrap', () => {
  assert.equal(isLoopWrap(4, 3.5), false, 'from 4s to 3.5s is not the end');
  assert.equal(isLoopWrap(214, 1.49), true, 'landing just inside the boundary counts');
  assert.equal(isLoopWrap(214, WRAP_TO), false, 'the boundary itself is not inside it');
});

test('junk timestamps are ignored rather than throwing', () => {
  assert.equal(isLoopWrap(NaN, 0), false);
  assert.equal(isLoopWrap(214, NaN), false);
  assert.equal(isLoopWrap(undefined, undefined), false);
  assert.equal(isLoopWrap('214', '0'), true, 'numeric strings are accepted');
});
