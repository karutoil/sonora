// The queue as one continuous media stream — the server half.
//
// Why this exists: on a locked iPhone the page stops running script (the media
// process keeps playing, the web process is suspended), so a player that starts
// the next track from a `timeupdate` cannot start it at all. Measured against
// the live instance: the last /api/now save the phone made was the
// `visibilitychange` one at the moment of locking, and the track boundary 26 s
// later produced no /api/events and no next /api/stream request at all, for the
// rest of the night.
//
// What survives that is a media resource the *media process* keeps fetching on
// its own. Three transports were tried, and the device decided between them:
//
//   1. fragmented MP4 over one endless response — Chromium plays it; iOS
//      answers `NotSupportedError` (an unseekable chunked fMP4 is an MSE/HLS
//      payload to WebKit, not a progressive source);
//   2. MP3 over one endless response — iOS accepts the connection and then
//      starves: `readyState 1`, `currentTime 0`, no error, forever. An
//      indefinite HTTP body is not a shape AVFoundation will schedule in the
//      background;
//   3. **HLS** — finite MPEG-TS segment files plus a playlist the media process
//      re-fetches on its own cadence. This is the native iOS background-audio
//      transport (every podcast and radio app uses it), it needs no page
//      script at a track boundary, and every response is finite.
//
// So a plan is a list of cached tracks, and the route serves it as a live HLS
// session: a fast "head" burst of the first ~30 s (so playback can start within
// a second of the screen locking), then a real-time "tail" that keeps cutting
// 6 s segments ahead of the listener, with the playlist window sliding forward.
// The list repeats until it covers a day, so a phone locked overnight never
// runs out; when it does reach the end the playlist carries `#EXT-X-ENDLIST`
// and the client's existing end handling takes over.
//
// Plans are short-lived, per-user, and bound to the account that asked for
// them — the route is a *player* endpoint, not a way to fetch arbitrary tracks
// (every id must already be in the audio cache, which the player itself
// filled).

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { audioPath, cachedAudio, ensureAudio } from './audio.js';

/** A valid YouTube video id, as src/audio.js defines it. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Tracks in one plan. At ~4 min each this is well over two hours per pass. */
export const MAX_TRACKS = 48;
/** How far ahead the repeated list must reach, so a locked phone never runs out. */
const COVER_MS = (() => {
  const raw = Number(process.env.SONORA_QUEUE_COVER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
})();
/** A plan outlives any plausible single lock, and is dropped by TTL after. */
const PLAN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_PLANS = 64;
const DURATION_CACHE_MAX = 2048;

/** Segment length. 6 s is the HLS sweet spot: few requests, small join latency. */
export const SEGMENT_MS = 6000;
/** The burst that makes playback start immediately instead of one segment in. */
const HEAD_MS = 30_000;
/** How far ahead of the playhead the playlist keeps segments listed. */
const LEAD_MS = 3 * SEGMENT_MS;
/** A session whose client has gone quiet is torn down after this. */
const SESSION_IDLE_MS = 120_000;
/** How often the tail's segment list is re-read. */

/** token -> { userId, tracks, at } */
const plans = new Map();
/** token -> live session (segments, playlist state, ffmpeg tail). */
const sessions = new Map();
/** videoId -> { key, durationMs } */
const durations = new Map();
/** userId -> number of sessions ffmpeg is currently producing for them. */
const streamsByUser = new Map();
/** One ffmpeg tail per open session, held for as long as a phone stays locked:
 *  bound it so a client that retries in a loop cannot fill the host with
 *  muxers (each one is cheap, but not free). */
const MAX_STREAMS_PER_USER = 4;
let activeStreams = 0;
const MAX_ACTIVE_STREAMS = 12;

/** ffmpeg/ffprobe, overridable for a deployment that installs them elsewhere. */
function bin(name) {
  const env = name === 'ffprobe' ? process.env.FFPROBE_BIN : process.env.FFMPEG_BIN;
  return env && String(env).trim() ? String(env).trim() : name;
}

/**
 * One track's playable length, from the file itself.
 *
 * The catalogue's `durationS` is YouTube's idea of the length; the stream is
 * built from the cached file, and the mapping between a stream position and a
 * track only stays honest if it uses the length that is actually in the bytes.
 * ffprobe's answer is cached by (videoId, size) so a plan costs one process per
 * track in its lifetime, not one per request.
 */
function probeDuration(videoId, meta) {
  const key = `${meta.size}`;
  const known = durations.get(videoId);
  if (known && known.key === key) return Promise.resolve(known.durationMs);
  return new Promise((resolve) => {
    const child = spawn(bin('ffprobe'), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', meta.file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (durationMs) => {
      if (settled) return;
      settled = true;
      if (durationMs > 0) {
        durations.set(videoId, { key, durationMs });
        if (durations.size > DURATION_CACHE_MAX) {
          const oldest = durations.keys().next().value;
          durations.delete(oldest);
        }
      }
      resolve(durationMs);
    };
    child.stdout.on('data', (chunk) => { out += chunk; if (out.length > 4096) child.kill('SIGKILL'); });
    child.on('error', () => finish(0));
    child.on('close', () => finish(Math.round((Number.parseFloat(out.trim()) || 0) * 1000)));
  });
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Turn a list of ids into a streamable plan.
 *
 * Only what is already on disk is included: a cold download is exactly the
 * silence this feature exists to avoid, and the plan is requested while the
 * page is still visible and playing, so the track that matters is always there.
 * The first few tracks that were *not* warmed get a best-effort download so the
 * next plan (the next track start re-arms one) can include them.
 */
export async function planQueueStream({ userId, videoIds }) {
  const wanted = [];
  let previous = null;
  for (const raw of Array.isArray(videoIds) ? videoIds : []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!VIDEO_ID.test(id)) continue;
    // A wrapped short queue repeats the same id back to back; one entry is
    // enough because the stream loops the list anyway.
    if (id === previous) continue;
    previous = id;
    wanted.push(id);
    if (wanted.length >= MAX_TRACKS) break;
  }
  if (!wanted.length) return { token: null, tracks: [] };

  const metas = await mapBounded(wanted, 4, async (id) => cachedAudio(id).catch(() => null));
  const playable = [];
  const missing = [];
  for (let i = 0; i < wanted.length; i += 1) {
    if (metas[i]) playable.push({ videoId: wanted[i], meta: metas[i] });
    else missing.push(wanted[i]);
  }
  // Warm a couple of the gaps in the background: this plan cannot use them, but
  // the next one (a few minutes of listening later) can.
  for (const id of missing.slice(0, 2)) ensureAudio(id).catch(() => {});

  const tracks = [];
  const probed = await mapBounded(playable, 4, async ({ videoId, meta }) => ({
    videoId, durationMs: await probeDuration(videoId, meta),
  }));
  for (const track of probed) {
    if (track.durationMs > 0) tracks.push(track);
  }
  if (!tracks.length) return { token: null, tracks: [] };

  prunePlans();
  const token = crypto.randomBytes(18).toString('base64url');
  plans.set(token, { userId, tracks, at: Date.now() });
  return { token, tracks };
}

/** The plan behind a token, if it belongs to `userId` and has not expired. */
export function getPlan(token, userId) {
  if (typeof token !== 'string' || !token) return null;
  const plan = plans.get(token);
  if (!plan) return null;
  if (Date.now() - plan.at > PLAN_TTL_MS) {
    plans.delete(token);
    return null;
  }
  if (plan.userId !== userId) return null;
  return plan;
}

function prunePlans(now = Date.now()) {
  for (const [token, plan] of plans) {
    if (now - plan.at > PLAN_TTL_MS) plans.delete(token);
  }
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
}

/** A path inside a single-quoted ffmpeg concat-list line. */
function concatPath(file) {
  return String(file).replace(/'/g, "'\\''");
}

/**
 * Concat-list lines for a slice of the plan's timeline.
 *
 * `fromMs`/`toMs` are positions in the plan (modulo one pass); the first entry
 * carries an `inpoint` and the last an `outpoint`, so the slice starts and ends
 * exactly where the caller asked. `toMs === null` means "to the end of the
 * pass", and `repeatCoverMs` extends the slice across whole further passes —
 * which is how a tail covers a night without listing a night of files.
 */
export function concatSlice(tracks, fromMs, toMs, { repeatCoverMs = 0 } = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) return '';
  const lengths = list.map((t) => Math.max(0, Number(t.durationMs) || 0));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return '';
  const norm = (ms) => ((Math.round(Number(ms) || 0) % total) + total) % total;
  const from = norm(fromMs);
  const end = toMs == null ? null : norm(toMs);
  // How much timeline this slice must cover.
  const span = end == null ? total - from : (((end - from) % total) + total) % total || total;
  const target = span + repeatCoverMs;

  // The entry that contains `from`, and how far into it.
  let idx = 0;
  let into = from;
  for (let i = 0; i < list.length; i += 1) {
    if (into < lengths[i] || i === list.length - 1) { idx = i; break; }
    into -= lengths[i];
  }

  const lines = [];
  let covered = 0;
  let pass = 0;
  let first = true;
  const startIndex = idx;
  while (covered < target && pass < 64) {
    const usable = lengths[idx] - (idx === startIndex && pass === 0 ? into : 0);
    lines.push(`file '${concatPath(audioPath(list[idx].videoId))}'`);
    if (first) {
      if (into > 0) lines.push(`inpoint ${(into / 1000).toFixed(3)}`);
      first = false;
    }
    const remaining = target - covered;
    if (remaining < usable - 1) {
      // This entry holds the slice's end: cut it there.
      const outAt = (idx === startIndex && pass === 0 ? into : 0) + remaining / 1000;
      lines.push(`outpoint ${outAt.toFixed(3)}`);
      covered = target;
      break;
    }
    covered += usable;
    idx += 1;
    if (idx >= list.length) { idx = 0; pass += 1; }
    into = 0;
  }
  return `${lines.join('\n')}\n`;
}

/** Parse an ffmpeg segment-list CSV: rows of `name,start,end` in seconds. */
function parseSegmentCsv(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const [name, start, end] = line.split(',');
    if (!name || !name.endsWith('.ts')) continue;
    const seqMatch = /(\d+)\.ts$/.exec(name);
    if (!seqMatch) continue;
    rows.push({
      seq: Number(seqMatch[1]),
      startMs: Math.round((Number.parseFloat(start) || 0) * 1000),
      endMs: Math.round((Number.parseFloat(end) || 0) * 1000),
    });
  }
  return rows;
}


/**
 * Open a live HLS session for one plan.
 *
 * Segments are produced ON DEMAND, not by a paced tail: the playlist names the
 * slice of the plan timeline the listener is in, and any segment that does not
 * exist yet is cut for it right there — six seconds of audio cost a fraction
 * of a second of encode. That is what makes the stream seekable (a paced
 * broadcast has nothing to offer at a position it has not reached yet, which
 * is exactly what a lock-screen seek kept running into), and the overnight
 * pace falls out for free: the media process polls the playlist every segment
 * and fetches the next one, so production tracks consumption by construction
 * and a suspended listener produces nothing at all.
 *
 * The segment grid is absolute in the plan timeline (segment q covers
 * [q*SEG, (q+1)*SEG)), with one exception: the segment a load or a seek starts
 * in is cut from the exact requested offset, so playback begins where the
 * finger was, not up to six seconds before it. Its PTS offset equals that
 * anchor, and every later segment's equals its grid start, so the MPEG-TS
 * timeline is continuous across independently produced files — no
 * discontinuity tags anywhere.
 */
/**
 * A refusal the route translates into `429` + `retry-after` (see server.js).
 * `BUSY` is the code it switches on; the message is for the log, not the client.
 */
function busy(message) {
  const err = new Error(message);
  err.code = 'BUSY';
  return err;
}

export async function openQueueStream(tracks, atMs, userId = null) {
  const list = Array.isArray(tracks) ? tracks : [];
  const total = list.reduce((n, t) => n + Math.max(0, Number(t.durationMs) || 0), 0);
  if (!list.length || !(total > 0)) {
    const err = new Error('Nothing to stream.');
    err.code = 'EMPTY';
    throw err;
  }
  // The cap the constants above describe was declared and never spent: the route's
  // 429 for it was unreachable, so a client that retried in a loop could open one
  // session per retry and fill the host with ffmpeg cuts. Checked before the temp
  // dir exists, so a refusal costs nothing; released in `cleanup`, which is the
  // one path every teardown takes (DELETE, the idle sweeper, forgetPlans).
  if (userId != null && (streamsByUser.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) {
    throw busy(`Account ${userId} already has ${MAX_STREAMS_PER_USER} open streams.`);
  }
  if (activeStreams >= MAX_ACTIVE_STREAMS) {
    throw busy(`Already producing ${MAX_ACTIVE_STREAMS} streams.`);
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sonora-queue-'));
  activeStreams += 1;
  if (userId != null) streamsByUser.set(userId, (streamsByUser.get(userId) ?? 0) + 1);
  const anchor = ((Math.round(Number(atMs) || 0) % total) + total) % total;
  const session = {
    userId,
    dir,
    tracks: list,
    total,
    coverEnd: Math.ceil(COVER_MS / SEGMENT_MS) * SEGMENT_MS,
    createdAt: Date.now(),
    /** The position the current element load began at (open or seek). */
    anchorMs: anchor,
    anchorSeq: Math.floor(anchor / SEGMENT_MS),
    /** seq -> { startMs, endMs }; the file is `seg%06d.ts` under `dir`. */
    segMeta: new Map(),
    /** seq -> in-flight production promise, so concurrent asks share one cut. */
    producing: new Map(),
    /** The listener's playhead, moved by what it fetches (see noteSegmentFetch). */
    nowMs: anchor,
    lastSegAt: 0,
    lastK: null,
    /** Bumped on every re-anchor: in-flight cuts from the old anchor are stale. */
    gen: 0,
    evictedThrough: -1,
    closed: false,
    cleanup: null,
  };
  session.cleanup = async () => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.token ?? '');
    // Release the counters here and nowhere else: DELETE, the idle sweeper and
    // forgetPlans all end up in this function exactly once (the `closed` guard).
    activeStreams = Math.max(0, activeStreams - 1);
    if (userId != null) {
      const left = (streamsByUser.get(userId) ?? 1) - 1;
      if (left > 0) streamsByUser.set(userId, left);
      else streamsByUser.delete(userId);
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  // Cut the opening window eagerly, before the first playlist is served, so a
  // cold open or a seek does not make the listener wait for ffmpeg: the
  // element gets a ready playlist on its very first request. This is awaited
  // (not fire-and-forget) precisely so the playlist that follows is never the
  // empty one.
  await ensureSegments(session, windowSeqs(session, anchor)).catch(() => {});
  return { session, cleanup: session.cleanup, dir };
}

/** The seq whose slice contains a plan position. */
export const seqAt = (ms) => Math.floor(Math.max(0, ms) / SEGMENT_MS);

/** The slice one seq covers, honouring the session's anchor and cover end. */
function segRange(session, seq) {
  const gridStart = seq * SEGMENT_MS;
  const start = seq === session.anchorSeq ? Math.min(session.anchorMs, gridStart + SEGMENT_MS - 1) : gridStart;
  const end = Math.min(gridStart + SEGMENT_MS, session.coverEnd);
  return { start, end };
}

/**
 * The audio length to cut for one slot, derived from the plan's own track
 * durations.
 *
 * Why not just `end - start`: ffmpeg cuts audio at packet boundaries, so a
 * slice ending on a track seam overshoots into the next slot by up to one
 * packet. That overshoot is the *sliver* bug — measured on the device as a
 * playlist of 0.021 s "segments" after an anchored open, because the cut at a
 * seam ended slot produced a few hundred bytes of audio instead of six
 * seconds. Asking the plan for the slot's true length (and telling ffmpeg via
 * `-t`) keeps every slice a real one: slots are `SEGMENT_MS` of audio except
 * the anchor slot, whose length is the grid remainder measured along the plan,
 * and the last slot before the cover end.
 */
function slotAudioMs(session, seq) {
  const gridStart = seq * SEGMENT_MS;
  const gridEnd = Math.min(gridStart + SEGMENT_MS, session.coverEnd);
  if (seq === session.anchorSeq && session.anchorMs > gridStart) {
    // The anchored slot runs from the anchor to the next grid line, measured
    // along the plan (it can wrap).
    const total = session.total;
    const span = gridEnd - gridStart;
    const into = session.anchorMs - gridStart;
    return Math.max(500, span - into);
  }
  return Math.max(500, gridEnd - gridStart);
}

/** Global bound on concurrent segment cuts: a scrubber must not fork a farm. */
const MAX_CONCURRENT_CUTS = 6;
let cutsInFlight = 0;
const cutQueue = [];
function takeCutSlot() {
  if (cutsInFlight < MAX_CONCURRENT_CUTS) { cutsInFlight += 1; return Promise.resolve(); }
  return new Promise((resolve) => cutQueue.push(resolve));
}
function freeCutSlot() {
  cutsInFlight -= 1;
  const next = cutQueue.shift();
  if (next) { cutsInFlight += 1; next(); }
}

/**
 * Produce one segment if it is not on disk already, and return its metadata.
 *
 * Independent ffmpeg runs, one per segment, each with `-output_ts_offset` at
 * its slice start: the MPEG-TS timestamps line up across files even though no
 * single process cut them, which is what lets the playlist omit discontinuity
 * tags entirely.
 */
function probeFileDuration(file) {
  return new Promise((resolve) => {
    const child = spawn(bin('ffprobe'), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; if (out.length > 4096) child.kill('SIGKILL'); });
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Math.round((Number.parseFloat(out.trim()) || 0) * 1000)));
  });
}

export async function ensureSegment(session, seq) {
  const known = session.segMeta.get(seq);
  const file = path.join(session.dir, `seg${String(seq).padStart(6, '0')}.ts`);
  if (known) {
    try {
      await fsp.access(file);
      return known;
    } catch { /* evicted: fall through and cut it again */ }
  }
  const pending = session.producing.get(seq);
  if (pending) return pending;
  const job = (async () => {
    const gen = session.gen;
    const { start, end } = segRange(session, seq);
    if (!(end > start)) return null;
    // The slice's own length along the plan, which is what the segmenter must
    // be told to cut: at a track seam the grid length and the audio length
    // disagree by the seam's packet overshoot, and trusting the grid produces
    // sliver segments (see slotAudioMs).
    const sliceMs = slotAudioMs(session, seq);
    const listFile = path.join(session.dir, `cut${String(seq).padStart(6, '0')}.txt`);
    const tmpFile = path.join(session.dir, `cut${String(seq).padStart(6, '0')}.ts`);
    await fsp.writeFile(listFile, concatSlice(session.tracks, start, end), { mode: 0o600 });
    await takeCutSlot();
    let ok = false;
    try {
      ok = await new Promise((resolve) => {
        const child = spawn(bin('ffmpeg'), [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'concat', '-safe', '0', '-i', listFile,
          '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
          // Relative to this load's anchor, NOT the absolute plan position:
          // the media timeline must start at 0 for every element load,
          // because WebKit reports `currentTime` from the segment PTS while
          // Chromium normalises to zero — with absolute stamps the two
          // engines disagreed by the whole anchor and the client's
          // `startMs + currentTime` mapping double-counted on the phone
          // (lock-screen positions of 16–89 minutes in a 15-minute plan).
          '-output_ts_offset', ((start - session.anchorMs) / 1000).toFixed(3),
          // Zero the muxer's own initial PTS so the timeline starts at exactly
          // 0 for every load. Without this each segment carries a ~1.4 s base,
          // which WebKit reports through `currentTime` and the client's
          // `startMs + currentTime` mapping re-adds on every interruption —
          // a slow drift that eventually walks the playhead off the track.
          '-muxdelay', '0', '-muxpreload', '0',
          '-t', (sliceMs / 1000).toFixed(3),
          // One cut is exactly one segment, so a single-file `-f mpegts`
          // output — NOT the segment muxer. The segmenter splits on absolute
          // PTS, so under a non-zero `-output_ts_offset` it writes a few
          // hundred bytes of sliver into the `seq`-numbered file and the real
          // audio into `seq+1`; the sliver then fails the sub-second guard and
          // the playlist comes back empty (measured on the device).
          '-f', 'mpegts', tmpFile,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 8192) child.kill('SIGKILL'); });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
    } finally {
      freeCutSlot();
      void fsp.rm(listFile, { force: true }).catch(() => {});
    }
    if (!ok) { void fsp.rm(tmpFile, { force: true }).catch(() => {}); return null; }
    const durationMs = await probeFileDuration(tmpFile);
    // A sub-second result is an ffmpeg artifact, not audio anyone should play.
    if (!durationMs || durationMs < 1000) {
      void fsp.rm(tmpFile, { force: true }).catch(() => {});
      return null;
    }
    // A reposition while this cut was in flight invalidates it: its PTS is
    // relative to the *old* anchor, and serving it would restart the media
    // timeline at the wrong place.
    if (gen !== session.gen) {
      void fsp.rm(tmpFile, { force: true }).catch(() => {});
      return null;
    }
    // A re-anchor while this cut was running makes its PTS relative to a
    // position nobody is listening from any more: drop it rather than serve a
    // segment whose clock starts in the wrong place.
    if (gen !== session.gen) {
      void fsp.rm(tmpFile, { force: true }).catch(() => {});
      return null;
    }
    // Rename into place last: a concurrent playlist build must never see a
    // half-written segment under its serving name.
    await fsp.rename(tmpFile, file);
    const meta = { startMs: start, endMs: start + durationMs };
    session.segMeta.set(seq, meta);
    return meta;
  })();
  session.producing.set(seq, job);
  try {
    return await job;
  } finally {
    session.producing.delete(seq);
  }
}

/** Produce every segment a window needs, concurrently but bounded. */
export async function ensureSegments(session, seqs) {
  await mapBounded(seqs, 4, (seq) => ensureSegment(session, seq));
}

/**
 * The seqs a playlist should list for a playhead.
 *
 * From the load anchor (a slow client joining mid-buffer still sees its own
 * segment) or four segments behind the playhead, whichever is later, to the
 * lead ahead — bounded by the covered timeline.
 */
export function windowSeqs(session, nowMs) {
  const first = Math.max(seqAt(session.anchorMs), seqAt(nowMs - 4 * SEGMENT_MS));
  const last = Math.min(seqAt(session.coverEnd - 1), seqAt(nowMs + LEAD_MS));
  const out = [];
  for (let seq = first; seq <= last; seq += 1) out.push(seq);
  return out;
}

/** Register a live session under its token (the route does this once). */
export function attachSession(token, session) {
  session.token = token;
  sessions.set(token, session);
}

/** Look up a live session, touching its idle clock. */
export function getSession(token, userId) {
  const session = sessions.get(token);
  if (!session || session.closed) return null;
  if (session.userId !== userId) return null;
  session.lastFetch = Date.now();
  return session;
}

/**
 * Tear a session down. With a `userId`, only that listener's session of this
 * token dies — a token is per-user anyway, but the check keeps the DELETE
 * route honest.
 */
export function closeSession(token, userId = null) {
  const session = sessions.get(token);
  if (!session) return;
  if (userId != null && session.userId !== userId) return;
  sessions.delete(token);
  void session.cleanup?.();
}

/**
 * The listener's position in the plan timeline.
 *
 * Between segment fetches the playhead moves in real time (that is what
 * playing is), so the clock advances by the elapsed gap — but only while the
 * client is actually consuming. A gap longer than a few segments means the
 * page is suspended or the listener paused, and the playhead is frozen: the
 * window must stay where it was, or resuming would find its segments gone.
 */
export function sessionNow(session) {
  const gap = Date.now() - session.lastSegAt;
  if (session.lastSegAt && gap > 0 && gap < 4 * SEGMENT_MS) return session.nowMs + gap;
  return session.nowMs;
}

/**
 * Record that the client consumed a segment: its start is the playhead.
 * Forward-only — a backward fetch is a revalidation or the refetch after a
 * backward seek, and the seek itself has already moved the clock through
 * `maybeReposition`; letting the refetch drag it back would undo the seek.
 */
export function noteSegmentFetch(session, seq) {
  const meta = session.segMeta.get(seq);
  if (!meta) return;
  if (meta.startMs >= session.nowMs - 500) session.nowMs = meta.startMs;
  session.lastSegAt = Date.now();
}

/**
 * Reposition the window: a playlist request whose `k` differs from the one the
 * session was opened (or last repositioned) with is a new `src` on the client
 * — a seek, or a fresh entry — and its `at` is the truth.
 */
export function maybeReposition(session, atMs, k) {
  if (k == null) return false;
  if (session.lastK === k) return false;
  session.lastK = k;
  const total = session.total;
  const at = ((Math.round(Number(atMs) || 0) % total) + total) % total;
  session.nowMs = at;
  session.lastSegAt = Date.now();
  // Same anchor (the first playlist request of a load, or a re-entry at the
  // position the listener is already at): every cached segment's PTS is still
  // relative to it, so the cache stays — dropping it here would throw away the
  // eager pre-cut and make every cold open pay for its window twice.
  if (at === session.anchorMs) {
    session.anchorSeq = seqAt(at);
    return false;
  }
  session.anchorMs = at;
  session.anchorSeq = seqAt(at);
  // Every cached segment carries PTS relative to the *previous* anchor, so a
  // new load (a seek, or a re-entry after an interruption) invalidates the
  // whole cache: the window's segments are re-cut on demand at ~300 ms each,
  // and a stale file would restart the media timeline at the wrong place.
  // Bumping the generation also drops in-flight cuts from the old anchor.
  session.gen += 1;
  session.evictedThrough = -1;
  for (const seq of session.segMeta.keys()) {
    void fsp.rm(path.join(session.dir, `seg${String(seq).padStart(6, '0')}.ts`), { force: true }).catch(() => {});
  }
  session.segMeta.clear();
  return true;
}

/**
 * The playlist body for a session, once `seqs` have been produced.
 *
 * Live (no ENDLIST) until the playhead reaches the covered timeline's end;
 * segments are named relative to the playlist's own directory.
 */
export function playlistFor(session, seqs) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  const metas = (Array.isArray(seqs) ? seqs : [])
    .map((seq) => ({ seq, meta: session.segMeta.get(seq) }))
    .filter((x) => x.meta);
  if (!metas.length) return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n#EXT-X-ENDLIST\n';
  const target = Math.max(1, ...metas.map(({ meta }) => Math.ceil((meta.endMs - meta.startMs) / 1000)));
  lines.push(`#EXT-X-TARGETDURATION:${target}`);
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${metas[0].seq}`);
  for (const { seq, meta } of metas) {
    lines.push(`#EXTINF:${((meta.endMs - meta.startMs) / 1000).toFixed(6)},`);
    lines.push(`seg/${seq}.ts`);
  }
  const lastSeq = seqAt(session.coverEnd - 1);
  if (metas[metas.length - 1].seq >= lastSeq) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/** Read one produced segment, or null when it does not exist (yet). */
export function readSegment(session, seq) {
  if (!Number.isInteger(seq) || seq < 0) return null;
  const file = path.join(session.dir, `seg${String(seq).padStart(6, '0')}.ts`);
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Drop segment files far behind the playhead. They are regenerable (the cut is
 * a pure function of the plan and the slice), so this is cache eviction, not
 * loss — it only keeps a night of listening from filling the temp dir.
 */
const EVICT_BEHIND = 300;
function evictSegments(session) {
  const floor = seqAt(session.nowMs) - EVICT_BEHIND;
  for (let seq = session.evictedThrough + 1; seq < floor; seq += 1) {
    if (seq === session.anchorSeq) continue;
    void fsp.rm(path.join(session.dir, `seg${String(seq).padStart(6, '0')}.ts`), { force: true }).catch(() => {});
  }
  if (floor > session.evictedThrough) session.evictedThrough = floor - 1;
}

// A listener that never comes back (phone unlocked elsewhere, tab closed) must
// not leave a temp dir behind. One sweeper for everything.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - (session.lastFetch ?? session.createdAt) > SESSION_IDLE_MS) closeSession(token);
    else evictSegments(session);
  }
  for (const [token, plan] of plans) {
    if (now - plan.at > PLAN_TTL_MS && !sessions.has(token)) plans.delete(token);
  }
}, 30_000);
sweeper.unref?.();

/** Test seam: forget every plan and tear every session down. */
export function forgetPlans() {
  for (const token of [...sessions.keys()]) closeSession(token);
  plans.clear();
}

// Re-exported for the route: the caller must know whether the id is even a
// candidate before asking the plan builder about it.
export { VIDEO_ID };
