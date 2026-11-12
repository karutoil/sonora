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
// `playing`) from being mistaken for a finished one, and `duration` shrinks the
// "first few seconds" for a track too short to ever be past them (see
// isLoopWrap) — otherwise the short end of the range is the one the module
// cannot see.

/**
 * Replace a finished source. Keep this synchronous: background timers are
 * delayed, so a handoff deferred to one can miss the whole next track.
 *
 * `background` decides whether the old source is paused on the way out, and it
 * is the opposite of what the WebKit 261858 workaround suggests.
 *
 * A pause is the moment iOS is free to tear the app's audio session down. On a
 * locked or backgrounded phone it does exactly that, and a session taken away
 * in the background is not handed back: the next `src`/`play()` is accepted,
 * `audio.paused` goes false, the Media Session metadata updates — and then the
 * Now Playing widget empties out and nothing is audible until the listener
 * comes back to the app. That is a pause between tracks, which is the one thing
 * a background music app must never do (README, PLAN.md finding #3).
 *
 * The pause was added to dodge a direct end→src/play transition, but this
 * player never has one: `audio.loop` is always on, so the element is still
 * *playing* at the wrap and the swap is playing→src→play. A manual "next"
 * while the app is in the background makes exactly that transition and is
 * known-good on the device, so the auto-advance does the same instead of
 * routing through a pause the manual path never takes.
 *
 * With the page visible a pause costs nothing and stays: it keeps the visible
 * handoff byte-identical to the one the loop workaround was developed against.
 */
export function handoffTrack({ pause, next, background = false }) {
  if (!background) pause();
  next();
}

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
 *
 * `duration` (seconds, the element's own) is what makes the short end of the
 * range work. The fixed thresholds above assume a track long enough to be past
 * 3 s and to jump back by more than 2 s — a track (or a truncated stream)
 * shorter than that can never satisfy them, so it is never detected as finished
 * and, with `loop` on and no `ended` event on WebKit, repeats forever on a
 * locked phone: precisely the failure this module exists to prevent. With a
 * known short length both thresholds scale down to half of it, which keeps the
 * jump test meaningful (it still has to be a real jump back from the tail to
 * the head) without asking a two-second track for a three-second jump.
 */
export function isLoopWrap(from, to, { manualSeek = false, started = true, duration = null } = {}) {
  const a = Number(from);
  const b = Number(to);
  if (manualSeek || !started) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const length = Number(duration);
  const known = Number.isFinite(length) && length > 0 ? length : null;
  const wrapFrom = known == null ? WRAP_FROM : Math.min(WRAP_FROM, known / 2);
  const minJump = known == null ? WRAP_MIN_JUMP : Math.min(WRAP_MIN_JUMP, known / 2);
  return a > wrapFrom && b < WRAP_TO && a - b > minJump;
}
