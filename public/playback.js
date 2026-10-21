// End-of-track detection for a looping <audio> element.
//
// WebKit never emits `ended` for a looping element: at the end it jumps back
// to 0:00. Most engines also emit `seeking`/`seeked` for that jump, but WebKit
// on a locked iPhone can report it only through `timeupdate`. A player that
// listens to `seeking` alone therefore repeats the same song forever on the
// lock screen, which is exactly the bug this module exists to prevent.
//
// The test is deliberately conservative: a non-manual jump from past the first
// few seconds to the first second and a half is a loop wrap, and nothing else.
// `started` keeps a freshly assigned source (which reports 0 before its first
// `playing`) from being mistaken for a finished one.

/** Never treat the first seconds as "the end". */
export const WRAP_FROM = 3;
/** Where a loop lands. */
export const WRAP_TO = 1.5;
/** A jump smaller than this is a normal seek, not a wrap. */
export const WRAP_MIN_JUMP = 2;

/**
 * Did `from → to` cross the loop boundary?
 *
 * `manualSeek` covers every deliberate seek (the progress slider, previous
 * restarting the track, a lock-screen scrub), and `started` covers a source
 * that has not played yet.
 */
export function isLoopWrap(from, to, { manualSeek = false, started = true } = {}) {
  const a = Number(from);
  const b = Number(to);
  if (manualSeek || !started) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a > WRAP_FROM && b < WRAP_TO && a - b > WRAP_MIN_JUMP;
}
