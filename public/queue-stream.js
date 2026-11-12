// The queue as one continuous media stream — the client half.
//
// Why this exists: on a locked iPhone the page stops running script. The web
// process is suspended while the *media process* keeps playing, so nothing in
// the player is awake when the last second of a track arrives: no `timeupdate`,
// no loop-wrap detection, no `src` swap, no next track. It is not a bug in the
// wrap detector — the detector never runs. Measured on the live instance
// (PLAN.md finding #6): the last save the page made was the `visibilitychange`
// one at the moment of locking, and the track boundary 26 s later produced
// neither an /api/events `complete` nor an /api/stream request for the next
// track, for the rest of the night.
//
// The one thing that does keep playing across a track boundary with no script
// is a media element playing a resource that already contains the next track.
// So while the page is hidden the element is pointed at
// `GET /api/queue-stream/:token?at=…`, a server-side concatenation of the queue
// that the media process plays on its own; the page can be frozen for hours and
// the music keeps going. Everything here is the mapping that makes that
// survivable: which tracks go into the plan, where a stream position lands in
// the queue, and how to get back to normal per-track playback afterwards.
//
// Kept dependency-free (and DOM-free) so it is testable in plain node; app.js
// owns the state machine and public/media-session.js owns the lock screen.

/** How many tracks a plan carries. A night in a pocket is the design target. */
export const PLAN_LIMIT = 40;

/**
 * The ids to hand the server, starting at the playhead and wrapping once.
 *
 * A plan is the *queue order*, so this is only right when the player is playing
 * in queue order; `planTrackIds` is the entry point every caller should use,
 * because it also covers shuffle and repeat-one.
 */
export function planIds(queue, index, { limit = PLAN_LIMIT } = {}) {
  if (!Array.isArray(queue) || !queue.length) return [];
  const n = queue.length;
  const count = Math.min(Math.max(1, limit), n);
  const start = ((Number(index) || 0) % n + n) % n;
  const ids = [];
  for (let k = 0; k < count; k += 1) {
    const id = queue[(start + k) % n]?.videoId;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

/** Fisher–Yates over a copy; `random` is injectable so a test is deterministic. */
export function shuffledCopy(list, random = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The ids for the plan the player would actually have played next.
 *
 * All three playback modes are covered, because every one of them has to keep
 * playing on a locked phone — a silent hole in one mode is exactly the bug this
 * feature exists to remove (the first version skipped shuffle and repeat-one,
 * and a listener with shuffle left on got no protection at all):
 *
 *   * queue order (the default) — the queue from the playhead, wrapped once;
 *   * shuffle — the current track, then the rest in a fresh random order. The
 *     player picks each next track at random too, so any order is as correct as
 *     the one it would have picked; what matters is that the music continues;
 *   * repeat-one — the current track alone, which the server loops: that *is*
 *     repeat-one, rendered by the same mechanism.
 *
 * A single-track queue falls out of the same rule as a one-entry list.
 */
export function planTrackIds({
  queue, index, shuffle = false, repeatOne = false, limit = PLAN_LIMIT, random = Math.random,
} = {}) {
  if (!Array.isArray(queue) || !queue.length) return [];
  const start = ((Number(index) || 0) % queue.length + queue.length) % queue.length;
  const current = queue[start]?.videoId;
  if (typeof current !== 'string' || !current) return [];
  if (repeatOne) return [current];
  if (shuffle && queue.length > 1) {
    const rest = queue.filter((_, i) => i !== start);
    return [current, ...shuffledCopy(rest, random).map((t) => t?.videoId).filter(Boolean)];
  }
  return planIds(queue, start, { limit });
}

/**
 * Cumulative start of each planned track, in ms, from the plan's own origin.
 *
 * The origin is the *beginning of the first track*, not the playhead: the
 * stream is asked to start at `at` ms into that track, so a stream position of
 * `at + elapsed` is directly comparable with these offsets.
 */
export function planStarts(tracks) {
  const starts = [];
  let at = 0;
  for (const track of Array.isArray(tracks) ? tracks : []) {
    starts.push(at);
    at += Math.max(0, Number(track?.durationMs) || 0);
  }
  return starts;
}

/** Total length of one pass of the plan, in ms (0 when nothing is playable). */
export function planTotalMs(tracks) {
  const starts = planStarts(tracks);
  if (!starts.length) return 0;
  return starts[starts.length - 1] + Math.max(0, Number(tracks[tracks.length - 1]?.durationMs) || 0);
}

/**
 * Where a stream position lands: `{ index, offsetMs, startMs, videoId }`.
 *
 * `ms` is a position in the plan's timeline (see planStarts), which is why the
 * caller adds the `at` it requested before calling. The plan loops, so the
 * position is taken modulo one pass — the stream is a long repetition of the
 * same list, and an hour in it is the same track as a minute in it.
 */
export function locate(tracks, ms) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const total = planTotalMs(tracks);
  if (!(total > 0)) return null;
  const starts = planStarts(tracks);
  const raw = Number(ms);
  const pos = ((Number.isFinite(raw) ? raw : 0) % total + total) % total;
  // Last track whose window contains the position, ignoring zero-length
  // entries (a track whose duration never loaded) rather than reporting a
  // position inside nothing. Linear is fine: a plan is a few dozen entries and
  // this runs about once a second at most.
  let index = -1;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] > pos) break;
    if ((Number(tracks[i]?.durationMs) || 0) > 0) index = i;
  }
  if (index < 0) {
    index = starts.findIndex((_, i) => (Number(tracks[i]?.durationMs) || 0) > 0);
    if (index < 0) return null;
  }
  return {
    index,
    startMs: starts[index],
    offsetMs: Math.max(0, pos - starts[index]),
    videoId: tracks[index]?.videoId ?? null,
  };
}

/**
 * Where a track sits in the plan's timeline, in ms, for a playhead `offsetMs`
 * into that track: the stream can start *anywhere* in the plan, not only in
 * its first entry.
 *
 * That is what makes a plan survive the track it was built for ending. A plan
 * armed at one track start is still the right plan two songs later — the queue
 * is the same queue — so the player does not have to race a fresh request
 * against the screen locking.
 *
 * Returns null when the track is not in the plan.
 */
export function planOffsetFor(tracks, videoId, offsetMs = 0) {
  if (!Array.isArray(tracks) || !videoId) return null;
  const index = tracks.findIndex((t) => t?.videoId === videoId);
  if (index < 0) return null;
  const starts = planStarts(tracks);
  const length = Math.max(0, Number(tracks[index]?.durationMs) || 0);
  const into = Math.min(Math.max(0, Math.round(Number(offsetMs) || 0)), Math.max(0, length - 1));
  return starts[index] + into;
}

/**
 * The URL the element plays while the page is hidden.
 *
 * `live.m3u8` is load-bearing, not decoration: the engines pick the HLS
 * demuxer by the playlist's extension. The same bytes with the same
 * `application/vnd.apple.mpegurl` content type are `NotSupportedError` from an
 * extensionless path (measured in Chromium across path depths and VOD/live
 * shapes; the iPhone's refusals had the same signature).
 */
export function streamSrc(token, atMs, k = null) {
  const at = Math.max(0, Math.round(Number(atMs) || 0));
  // `k` names this assignment of the element's src. The server slides its
  // playlist window with the listener's consumption, so a *new* src (a seek, a
  // fresh entry) has to say so: a different `k` repositions the window to `at`,
  // while polls that carry the same `k` ride the consumption clock.
  const nonce = k == null ? '' : `&k=${encodeURIComponent(String(k))}`;
  return `/api/queue-stream/${encodeURIComponent(String(token ?? ''))}/live.m3u8?at=${at}${nonce}`;
}

/** Is this browser the kind that freezes a hidden page while audio plays? */
export function freezesWhenHidden(deviceName) {
  return deviceName === 'iPhone' || deviceName === 'iPad';
}
