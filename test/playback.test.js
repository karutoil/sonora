import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopWrap, WRAP_FROM, WRAP_TO } from '../public/playback.js';

// The end-of-track detector. It exists because WebKit on a locked iPhone can
// loop an <audio> element without emitting `seeking`; `timeupdate` is the only
// witness. If this function is too eager, a deliberate seek skips a track; if
// it is too shy, the same song repeats forever. Both directions are pinned.

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
