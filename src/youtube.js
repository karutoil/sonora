import { AsyncLocalStorage } from 'node:async_hooks';
import { Innertube } from 'youtubei.js';
import { config } from './config.js';
import { activeCookieHeader } from './cookies.js';
import {
  rankTracks, rankPlaylists, parsePlaylistStats, parsePlaylistByline, parseReleaseByline,
  parseVideoTitle, isOfficialChannel, cleanChannelName, toCount, songKey, trackVersion,
} from './search-rank.js';

let ytPromise = null;
// Every resolved value, cached answer and backoff belongs to one identity. A
// reset advances this even while old work is still finishing; stale completions
// can answer their own callers, but must never mutate the replacement identity.
let identityGeneration = 0;
// Set by tests (or a future client swap) so the parsers can be driven with the
// shapes YouTube really returns when a renderer changes. Null means "use the
// real session".
let sessionOverride = null;

/**
 * Replace the session every public function talks to. `null` restores the real,
 * lazily-created one. A function is treated as a session factory, which is how
 * a test observes a rebuild (see SESSION_FAILURE_LIMIT). This is the seam a
 * test uses to feed the parsers a malformed payload without mocking the module
 * system.
 */
export function setSessionOverride(session) {
  sessionOverride = session ?? null;
  resetYT();
}

/**
 * A hard, transport-level deadline on every YouTube HTTP request.
 *
 * youtubei.js has no per-call AbortSignal to pass, so cancellation lands in the
 * constructed fetch through the initiating async context. This independent
 * deadline is deliberately longer than `resolveTimeoutMs`: the caller's error
 * normally wins, and this still reaps direct getYT() requests outside that
 * wrapper (for example the admin diagnostic).
 */
const upstreamRequestContext = new AsyncLocalStorage();

async function boundedFetch(input, init) {
  const deadline = AbortSignal.timeout(config.resolveTimeoutMs + 5_000);
  // youtubei.js does not accept a signal on getBasicInfo/search/etc. The custom
  // fetch is still inside the initiating async context, so this links the real
  // transport to the caller's total-operation deadline as well as the backstop.
  const context = upstreamRequestContext.getStore();
  if (context?.policyError) throw context.policyError;
  const operationSignal = context?.signal;
  const signals = [deadline, init?.signal, operationSignal].filter(Boolean);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const response = await fetch(input, { ...(init ?? {}), signal });
  if (response.status === 429) {
    // youtubei.js otherwise turns this into an InnertubeError containing only a
    // text body, losing Retry-After before our policy handler can see it.
    const err = new Error(`YouTube request failed with status code 429: ${response.url || 'unknown URL'}`);
    err.status = 429;
    err.response = response;
    if (context) context.policyError ??= err;
    throw err;
  }
  return response;
}

/** Is there an Innertube session already (created, or being created)? */
export function hasYT() {
  return ytPromise != null;
}

/** One shared Innertube session; creating one per request burns memory. */
export function getYT() {
  const wait = blockedForMs();
  if (wait > 0) {
    // A 429/policy answer (see withTimeout) is process-wide: asking again from
    // the same IP is exactly what turns one block into a storm. Nothing has been
    // sent yet — every public operation awaits this before it builds a request.
    return Promise.reject(blockedError(wait));
  }
  if (!ytPromise) {
    // Capture both values: resetting an override while its factory is pending
    // must not make that factory read (or clear) the replacement session.
    const generation = identityGeneration;
    const override = sessionOverride;
    // A fresh session starts with a clean failure count: the counter measures
    // how badly *this* session is doing, not how unlucky the process has been.
    upstreamFailures = 0;
    const creating = override
      ? Promise.resolve().then(() => (typeof override === 'function' ? override() : override))
      : (async () => {
        // Prefer an imported jar so a signed-in session also helps Innertube (it is
        // the same identity that unblocks yt-dlp).
        const cookie = activeCookieHeader();
        return Innertube.create({
          retrieve_player: false,
          fetch: boundedFetch,
          ...(cookie ? { cookie } : {}),
        });
      })();
    let pending;
    pending = creating.catch((err) => {
      // An old init can reject after resetYT() has installed a new init. Only
      // the exact promise that failed may clear itself.
      if (identityGeneration === generation && ytPromise === pending) ytPromise = null;
      throw err;
    });
    ytPromise = pending;
  }
  return ytPromise;
}

/** Drop the session and every answer/backoff tied to that cookie identity. */
export function resetYT() {
  identityGeneration += 1;
  ytPromise = null;
  upstreamFailures = 0;
  blockedUntil = 0;
  blockStreak = 0;
  genreTilesPromise = null;
  liveCache.clear();
  liveInFlight.clear();
  albumOfCache.clear();
  albumInFlight.clear();
  playlistStatsCache.clear();
  playlistStatsInFlight.clear();
}

/**
 * A string out of a `Text`/`Run` node, a plain string, or nothing.
 *
 * Only ever returns a string: a shelf that answers `{ title: {…} }` used to leak
 * the object into a `.test()`/`join()` and then into JSON, where the renderer
 * showed `[object Object]` and the regex checks silently stopped matching.
 */
function text(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const inner = v.text ?? v.simpleText;
  if (typeof inner === 'string') return inner;
  if (typeof v.toString === 'function' && v.toString !== Object.prototype.toString) {
    const s = v.toString();
    if (typeof s === 'string') return s;
  }
  return null;
}

/** A non-empty string id, or null. Ids are the only safe join key upstream. */
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * An array shelf, or an empty list.
 *
 * Every upstream shelf is an array or absent. One object/string/null answer
 * used to make `.map` throw a TypeError out of a public function, which the
 * route then reported as a 500 for the whole screen.
 */
const list = (v) => (Array.isArray(v) ? v : []);

/** A finite number from upstream, or null. `''`/`null`/booleans are not 0. */
const num = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Array#slice throws on BigInt/Symbol limits and treats negatives as offsets
 * from the end; rankTracks can even return one row for a negative limit. Every
 * public list goes through this whole, finite, bounded value instead.
 */
const PUBLIC_LIMIT_MAX = 100;
function publicLimit(value, fallback, max = PUBLIC_LIMIT_MAX) {
  let n;
  try {
    n = Number(value ?? fallback);
  } catch {
    n = fallback;
  }
  if (Number.isNaN(n)) n = fallback;
  if (n === Infinity) n = max;
  if (n === -Infinity) n = 0;
  if (!Number.isFinite(n)) n = fallback;
  return Math.max(0, Math.min(max, Math.trunc(n)));
}

/** "3:05" / "1:04:05" as seconds; null when the segment is not a duration. */
function durationOfSegment(segment) {
  const m = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/.exec(String(segment ?? '').trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * A duration that only exists as ":"-text in a byline.
 *
 * Artist shelves and video rows have no `duration` object at all; the length is
 * a segment of the subtitle ("Artist • 4:05"). Without this every song opened
 * from an artist page showed 0:00 until the player resolved it.
 */
function durationFromParts(parts) {
  for (const part of parts) {
    const seconds = durationOfSegment(part);
    if (seconds != null) return seconds;
  }
  return null;
}

function toTrack(v) {
  if (!v || typeof v !== 'object') return null;
  const id = v.video_id ?? v.id;
  if (typeof id !== 'string' || id.length !== 11) return null;
  // `author` is a plain string on a PlaylistPanelVideo (the up-next panel) and
  // an object elsewhere; reading only `.name` silently dropped every artist
  // from radio and the personal station.
  const author = v.author;
  const artists = list(v.artists).map((a) => text(a?.name)).filter(Boolean);
  // Up-next panel rows badge the explicit edit exactly like catalogue rows.
  const version = versionOf(v);
  return {
    videoId: id,
    title: text(v.title) ?? text(v.name),
    channel: artists.join(', ') || text(author?.name ?? author) || text(v.channel?.name ?? v.channel) || null,
    channelId: str(v.author?.id) ?? str(v.channel?.id) ?? str(v.artists?.[0]?.channel_id),
    durationS: num(v.duration?.seconds),
    thumb: str(v.thumbnails?.[0]?.url ?? v.thumbnail?.[0]?.url),
    album: text(v.album?.name ?? v.album) || null,
    ...(version ? { version } : {}),
  };
}

// How many upstream calls may fail in a row before the shared Innertube session
// is thrown away. A session that has gone bad (rotated visitor data, an
// invalidated jar, a client version YouTube stopped accepting) otherwise keeps
// failing every metadata call until the process restarts.
const SESSION_FAILURE_LIMIT = 3;
let upstreamFailures = 0;

// 429 / policy backoff. A rebuild *is* a retry, so answering a rate limit by
// throwing the session away asks the same IP again a fraction of a second later
// from a station page that issues ~20 upstream calls. Instead the whole process
// waits, honoring Retry-After and doubling when no delay was supplied, up to a
// minute of local backoff. The numeric delay also reaches the HTTP classifier.
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
let blockedUntil = 0;
let blockStreak = 0;

/** Milliseconds until upstream calls may be attempted again. */
const blockedForMs = () => Math.max(0, blockedUntil - Date.now());

function blockedError(ms) {
  const err = new Error(`YouTube is rate-limiting this IP; retry in ${Math.ceil(ms / 1000)}s.`);
  err.code = 'YT_BLOCKED';
  err.retryAfterMs = ms;
  err.retryAfter = Math.ceil(ms / 1000);
  return err;
}

/**
 * Does this failure say something about the *session*, or only about the one
 * video/playlist that was asked for?
 *
 * Three legitimate misses in a row used to throw the shared session away: a
 * private video, a region block and a deleted playlist row are all normal on a
 * station built from somebody's library, and a single station page issues ~20
 * calls in parallel — so one page of dead tracks could cost several
 * `Innertube.create()` calls plus cookie-jar reads, each of which then competes
 * with the work that was actually wanted.
 */
function isSessionFailure(err) {
  if (err?.code === 'YT_BLOCKED') return false;
  const netCode = String(err?.code ?? '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(netCode)) return true;
  // AbortSignal.timeout (boundedFetch) and our own race both surface as these.
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  const status = Number(err?.response?.status ?? err?.status ?? err?.statusCode);
  if (Number.isFinite(status) && (status === 429 || status >= 500)) return true;
  const msg = String(err?.message ?? '');
  if (/timed out/i.test(msg)) return true;
  // InnertubeError carries "Request to … failed with status code 429" / "503".
  if (/failed with status code (?:429|5\d\d)\b/i.test(msg)) return true;
  // LOGIN_REQUIRED / the bot gate, and the context errors a stale build causes.
  if (/LOGIN_REQUIRED|sign in to confirm|not a bot|INNERTUBE_INVALID_ARGUMENT|invalid argument/i.test(msg)) return true;
  return false;
}

/** A 429 or a policy answer, as opposed to a broken session. */
function isPolicyBlock(err) {
  if (err?.code === 'YT_BLOCKED') return false;
  const status = Number(err?.response?.status ?? err?.status ?? err?.statusCode);
  if (status === 429) return true;
  const msg = String(err?.message ?? '');
  return /\b429\b/.test(msg) || /too many requests/i.test(msg) || /not a bot|sign in to confirm/i.test(msg);
}

// The existing-process backoff error must short-circuit fallbacks too, but is
// deliberately not passed back to armPolicyBlock and counted as a second 429.
const isPolicyFailure = (err) => err?.code === 'YT_BLOCKED' || isPolicyBlock(err);

function responseHeader(err, name) {
  for (const headers of [err?.response?.headers, err?.headers]) {
    if (typeof headers?.get === 'function') {
      const value = headers.get(name);
      if (value != null) return String(value);
    }
    if (headers && typeof headers === 'object') {
      const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
      if (value != null) return String(value);
    }
  }
  return null;
}

/** Retry-After is delta seconds or an HTTP date; keep it as a numeric field. */
function retryAfterFrom(err) {
  const directMs = Number(err?.retryAfterMs);
  if (Number.isFinite(directMs) && directMs >= 0) return Math.ceil(directMs);
  const direct = Number(err?.retryAfter);
  if (Number.isFinite(direct) && direct >= 0) return Math.ceil(direct * 1000);
  const raw = responseHeader(err, 'retry-after')?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (Number.isSafeInteger(seconds)) return seconds * 1000;
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function armPolicyBlock(err, generation) {
  const requested = retryAfterFrom(err);
  let wait = requested ?? BACKOFF_BASE_MS;
  if (generation === identityGeneration) {
    blockStreak += 1;
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (blockStreak - 1));
    wait = Math.max(backoff, requested ?? 0);
    blockedUntil = Date.now() + wait;
    // Deliberately not a rebuild: a fresh session from the same IP is blocked
    // too, so rebuilding only adds a retry to the storm.
    upstreamFailures = 0;
  }
  if (err && (typeof err === 'object' || typeof err === 'function')) {
    err.retryAfterMs = wait;
    err.retryAfter = Math.ceil(wait / 1000);
    err.code ??= 'YT_RATE_LIMIT';
  }
  return err;
}

// A process-wide limiter, not one limiter per search/station/follows caller:
// their Promise.all fan-out shares this queue, so combined screens cannot open
// an unbounded number of YouTube sockets. The queue also has a ceiling to turn
// extreme overload into an error rather than an ever-growing array of closures.
const UPSTREAM_CONCURRENCY = 4;
const UPSTREAM_QUEUE_MAX = 256;
let upstreamActive = 0;
const upstreamQueue = [];

function pumpUpstream() {
  while (upstreamActive < UPSTREAM_CONCURRENCY && upstreamQueue.length) {
    const task = upstreamQueue.shift();
    if (task.signal.aborted) {
      task.reject(task.signal.reason);
      continue;
    }
    upstreamActive += 1;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(task.signal.reason);
    task.signal.addEventListener('abort', onAbort, { once: true });
    const running = Promise.resolve().then(() => (
      upstreamRequestContext.run({ signal: task.signal, policyError: null }, task.work)
    ));
    // The operation can outlive the race only for non-cooperative mocks or an
    // MP4 parse after fetch; real transports are aborted through boundedFetch.
    running.catch(() => {});
    Promise.race([running, aborted]).then(task.resolve, task.reject).finally(() => {
      task.signal.removeEventListener('abort', onAbort);
      upstreamActive -= 1;
      pumpUpstream();
    });
  }
}

function scheduleUpstream(work, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    if (upstreamQueue.length >= UPSTREAM_QUEUE_MAX) {
      const err = new Error('Too many YouTube operations are already queued.');
      err.code = 'YT_OVERLOADED';
      return reject(err);
    }
    upstreamQueue.push({ work, signal, resolve, reject });
    pumpUpstream();
  });
}

/**
 * Run getYT() and one upstream method inside one scheduler slot and one total
 * deadline. Queueing and session creation therefore count against the caller's
 * timeout instead of hanging before the old promise-only race even began.
 */
const withTimeout = (work, ms, label) => {
  const generation = identityGeneration;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out`);
      err.name = 'TimeoutError';
      err.code = 'YT_TIMEOUT';
      controller.abort(err);
      reject(err);
    }, ms);
    timer.unref?.();
  });
  const operation = scheduleUpstream(async () => {
    const yt = await getYT();
    if (controller.signal.aborted) throw controller.signal.reason;
    const context = upstreamRequestContext.getStore();
    // Innertube.create may recover from a failed session-data request locally.
    // That is reasonable for a timeout, but a policy answer must not silently
    // turn into an immediate request from the locally-created fallback session.
    if (context?.policyError) throw context.policyError;
    const value = await work(yt);
    if (context?.policyError) throw context.policyError;
    return value;
  }, controller.signal);
  operation.catch(() => {});
  return Promise.race([operation, timeout])
    .finally(() => clearTimeout(timer))
    .then((value) => {
      if (generation === identityGeneration) {
        upstreamFailures = 0;
        blockStreak = 0;
      }
      return value;
    }, (err) => {
      if (generation !== identityGeneration) {
        // Still expose a server's delay to the old caller, but never let an old
        // request block or rebuild the replacement identity.
        if (isPolicyBlock(err)) armPolicyBlock(err, generation);
        throw err;
      }
      if (isPolicyBlock(err)) throw armPolicyBlock(err, generation);
      if (isSessionFailure(err)) {
        upstreamFailures += 1;
        if (upstreamFailures >= SESSION_FAILURE_LIMIT) {
          upstreamFailures = 0;
          // Drop the cached session so the next call builds a fresh one. The
          // failure is still reported to the caller: a rebuild is a retry path,
          // not a reason to pretend the call succeeded.
          resetYT();
        }
      } else {
        // The session answered — it just had nothing for this id. That is
        // evidence the session is fine, so it clears the count.
        upstreamFailures = 0;
      }
      throw err;
    });
};

/**
 * A YouTube Music catalogue row (`MusicResponsiveListItem`). Songs arrive with
 * the credited artist and album, which is what makes de-duplication possible.
 */
function toMusicTrack(v) {
  if (!v || typeof v !== 'object') return null;
  const id = v.id ?? v.video_id;
  if (typeof id !== 'string' || id.length !== 11) return null;
  const title = typeof v.title === 'string' ? v.title : text(v.title);
  if (!title) return null;
  const artists = list(v.artists ?? v.authors).map((a) => text(a?.name)).filter(Boolean);
  // Album track rows have no credits at all and YouTube fills the gap with the
  // literal string "N/A", which then leaks into the artist column and blocks
  // the album header's own artist from being used as a fallback.
  const credit = (s) => (s && !/^N\/?A$/i.test(s) ? s : null);
  // Some catalogue rows have an empty artists array; their second flex column
  // is "Artist • Album • 3:05", which is enough to credit the song properly.
  const byline = String(text(list(v.flex_columns)[1]?.title) ?? '').split('\u2022').map((s) => s.trim());
  const artist = credit(artists[0]) ?? credit(text(v.author?.name)) ?? credit(byline[0]) ?? null;

  // An artist's top-songs shelf splits the same information across separate
  // columns — "Creep" | "Radiohead" | "2.3B plays" | "Pablo Honey" — and
  // carries no `album` object and no duration at all. Without reading those
  // columns, every popular song of an artist would show an empty album.
  const flex = list(v.flex_columns).map((c) => text(c?.title)).filter(Boolean).slice(1);
  const parts = flex.flatMap((s) => String(s).split('\u2022').map((x) => x.trim())).filter(Boolean);
  const plays = parts.find((p) => /\b(?:plays|views)\b/i.test(p)) ?? null;
  const albumFromColumns = [...parts].reverse().find((p) => (
    credit(p)
    && p !== artist
    && !/\b(?:plays|views)\b/i.test(p)
    && !/^\d+:\d\d$/.test(p)
  )) ?? null;
  // The byline's second segment is the album on a playlist/album row — but on
  // an artist's top-songs shelf it is the play count, which used to leak into
  // the album column as "2.3B plays".
  const bylineAlbum = credit(byline.length > 1 ? byline[1] : null);
  const albumCredit = bylineAlbum && !/\b(?:plays|views)\b/i.test(bylineAlbum) ? bylineAlbum : null;

  // Which edit of the song this row is, from the row's own badges and title
  // ("(Clean)", "E" badge). Absent on most rows; null stays absent so the
  // JSON the client sees is unchanged for unmarked songs.
  const version = versionOf(v);

  return {
    videoId: id,
    title,
    artist,
    channel: artists.join(', ') || artist,
    channelId: str(v.artists?.[0]?.channel_id) ?? str(v.author?.channel_id),
    // The catalogue row usually carries a duration object, but an artist's
    // top-songs shelf only has it in the byline ("… • 3:05").
    durationS: num(v.duration?.seconds) ?? durationFromParts(parts),
    // The catalogue thumbnail is the artist avatar; the video thumbnail is the
    // artwork every other screen already proxies by id, so prefer that.
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    album: text(v.album?.name) ?? albumCredit ?? albumFromColumns,
    // The album's browse id (MPR…) is what "Open album" needs. Catalogue rows
    // carry it; up-next rows do not, which is why albumForVideo() exists.
    albumId: str(v.album?.id),
    // Present on artist shelves ("2.3B plays"), absent elsewhere.
    ...(plays ? { views: toCount(plays) } : {}),
    ...(version ? { version } : {}),
    itemType: 'song',
    official: true,
  };
}

/**
 * Which edit of a song a raw row carries, from its badges and title markers.
 *
 * Parsed rows (MusicResponsiveListItem, PlaylistPanelVideo) keep `badges` as
 * parsed objects; raw fixtures use the same shapes. The explicit badge is
 * either an icon_type of EXPLICIT or a plain label "E" — both are the
 * *release's* claim, which outranks whatever the title says.
 */
function versionOf(v) {
  const badges = Array.isArray(v?.badges) ? v.badges : null;
  const track = badges ? { title: text(v.title), badges } : { title: text(v.title) };
  return trackVersion(track);
}

/**
 * A plain video hit. Its uploader is often a lyric channel, not the artist, so
 * the credited artist is parsed out of "Artist - Song" and kept separately.
 */
function toVideoTrack(v) {
  const base = toTrack(v);
  if (!base) return null;
  const { artist } = parseVideoTitle(base.title);
  return {
    ...base,
    artist: artist ?? cleanChannelName(base.channel),
    itemType: 'video',
    official: isOfficialChannel(base.channel, artist),
  };
}

/**
 * Search that returns songs, not uploads of songs.
 *
 * The Music catalogue is the primary source: it carries real releases, with the
 * credited artist and album, and it does not include the lyric-channel and
 * re-upload noise that dominates plain video search. Video results are merged
 * in (and de-duplicated against the songs) only when the catalogue is thin,
 * so an obscure query still finds something.
 */
export async function searchTracks(query, limit = 20) {
  const capped = publicLimit(limit, 20);
  if (capped === 0) return [];

  let songs = [];
  let musicFailure = null;
  try {
    const res = await withTimeout(
      (yt) => yt.music.search(query, { type: 'song' }),
      config.resolveTimeoutMs,
      'search',
    );
    songs = list(res?.songs?.contents).map(toMusicTrack).filter(Boolean);
  } catch (err) {
    // Retrying a policy answer through another client is still an immediate
    // retry from the same IP. Do not turn one 429 into a second request.
    if (isPolicyFailure(err)) throw err;
    musicFailure = err;
    // The Music client is a separate endpoint and can fail on its own (client
    // version, gating). Plain video search is the historical path; use it.
  }

  let videos = [];
  if (songs.length < capped) {
    // The fallback is guarded on its own: a failed video search must not throw
    // away catalogue songs that already succeeded.
    try {
      const res = await withTimeout(
        (yt) => yt.search(query, { type: 'video' }),
        config.resolveTimeoutMs,
        'search',
      );
      videos = list(res?.videos ?? res?.results).map(toVideoTrack).filter(Boolean);
    } catch (err) {
      if (isPolicyFailure(err) && (musicFailure || songs.length === 0)) throw err;
      if (musicFailure) {
        // Two outages are not an honest empty search. AggregateError retains
        // both causes for logs while routes can still classify the failure.
        throw new AggregateError([musicFailure, err], 'YouTube Music and video search both failed.');
      }
      // Keep whatever the catalogue gave us rather than nothing at all.
    }
  }

  return rankTracks([...songs, ...videos], { query, limit: capped });
}

/**
 * Raw community-playlist hits for a query.
 *
 * One search call, one filter: community playlists are PL/VLPL ids, while
 * auto-mixes (MPSPP…, RD…) are not lists a user can open and pick songs from.
 * Every playlist caller goes through here so that rule is stated once.
 */
async function playlistHits(query) {
  const res = await withTimeout(
    (yt) => yt.music.search(query, { type: 'playlist' }),
    config.resolveTimeoutMs,
    'playlist search',
  );
  return list(res?.playlists?.contents)
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const id = str(p.id);
      if (!id || !/^(?:VL)?PL/.test(id)) return null;
      const title = typeof p.title === 'string' ? p.title : text(p.title);
      if (!title) return null;
      // The row's own byline is "Author • 299K views"; the node carries neither
      // field, so both have to be read out of that line.
      const byline = text(list(p.flex_columns)[1]?.title);
      return {
        id,
        title,
        author: text(p.author?.name) ?? parsePlaylistByline(byline).author,
        thumb: thumbFrom(p),
        ...parsePlaylistStats(byline),
      };
    })
    .filter(Boolean);
}

/**
 * Track counts (and views) read from a playlist's own header, cached by id.
 *
 * `playlistResults` used to fetch a whole playlist page per candidate just to
 * read `header.second_subtitle` — a cold mood search was one search plus up to
 * ten full playlist fetches, which is precisely the traffic pattern that gets an
 * IP gated (and this header changes about as often as the playlist does).
 *
 * Failures are cached too, on a much shorter TTL: one dead playlist id must not
 * be re-fetched on every search, but a transient failure (a timeout, a flip of
 * the bot gate) has to heal on its own.
 */
const PLAYLIST_STATS_TTL_MS = 6 * 60 * 60_000;
const PLAYLIST_STATS_FAIL_TTL_MS = 10 * 60_000;
const PLAYLIST_STATS_MAX = 500;
/** id -> { at, ttl, stats }. Insertion order is eviction order (FIFO). */
const playlistStatsCache = new Map();
const playlistStatsInFlight = new Map();

function cachedPlaylistStats(id) {
  const hit = playlistStatsCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    playlistStatsCache.delete(id);
    return null;
  }
  return hit.stats;
}

function rememberPlaylistStats(id, stats, ttl = PLAYLIST_STATS_TTL_MS) {
  playlistStatsCache.set(id, { at: Date.now(), ttl, stats });
  // Bounded, not LRU: an unbounded map of playlist ids is a slow leak on an
  // instance that stays up for weeks.
  for (const key of playlistStatsCache.keys()) {
    if (playlistStatsCache.size <= PLAYLIST_STATS_MAX) break;
    playlistStatsCache.delete(key);
  }
}

function loadPlaylistStats(id) {
  const pending = playlistStatsInFlight.get(id);
  if (pending) return pending;
  const generation = identityGeneration;
  let work;
  work = (async () => {
    try {
      const pl = await withTimeout(
        (yt) => yt.music.getPlaylist(id),
        config.resolveTimeoutMs,
        'playlist',
      );
      const stats = parsePlaylistStats(text(pl?.header?.second_subtitle));
      if (generation === identityGeneration) rememberPlaylistStats(id, stats);
      return stats;
    } catch {
      // Unknown length: keep the search row rather than hide a working playlist.
      // Cache this lookup briefly, including a miss, but never across a reset.
      const stats = {};
      if (generation === identityGeneration) rememberPlaylistStats(id, stats, PLAYLIST_STATS_FAIL_TTL_MS);
      return stats;
    } finally {
      if (generation === identityGeneration && playlistStatsInFlight.get(id) === work) {
        playlistStatsInFlight.delete(id);
      }
    }
  })();
  playlistStatsInFlight.set(id, work);
  return work;
}

/**
 * Community playlists that are really lists of songs, by relevance then views.
 *
 * The search row only carries views, so the length of the shortlist is
 * confirmed from each playlist's own header: a "playlist" holding one 4-hour
 * video is not a list of songs. `verify` caps how many headers are read — a
 * combined search tab wants fast, a mood screen wants thorough.
 */
async function playlistResults(query, { limit = 12, verify = 10, minTracks = 8 } = {}) {
  const hits = await playlistHits(query);
  // Query relevance decides which expensive headers are worth reading. Ranking
  // without it used to spend the whole shortlist on popular but unrelated hits.
  const ranked = rankPlaylists(hits, { query, limit: hits.length, minTracks: 0 });
  // Only this shortlist pays for a header request, even if a public caller asks
  // for 100 rows. The unverified tail stays eligible below: rankPlaylists keeps
  // unknown track counts, so a verification cap cannot under-fill the result or
  // turn a large limit into a hundred extra requests.
  const candidates = ranked.slice(0, verify);
  const checked = await Promise.all(candidates.map(async (p) => {
    if (p.trackCount != null) return p;
    const known = cachedPlaylistStats(p.id);
    if (known) return { ...p, ...known };
    const stats = await loadPlaylistStats(p.id);
    return { ...p, ...stats };
  }));

  return rankPlaylists([...checked, ...ranked.slice(candidates.length)], { query, limit, minTracks });
}

/**
 * Community playlists for a mood word — the answer to "browse by feeling".
 *
 * A mood is not a song, so searching songs for it returns 4-hour single-video
 * mixes. Searching playlists returns actual lists. Headers give views, which is
 * the only popularity signal available, and the track count that proves the
 * list is one.
 */
export async function searchMoodPlaylists(query, limit = 12) {
  const capped = publicLimit(limit, 12);
  if (capped === 0) return [];
  return playlistResults(query, { limit: capped, verify: 10 });
}

/**
 * Playlists for an ordinary search, for the client's Playlists tab.
 *
 * Same source and the same list-of-songs rule as a mood lookup; a few fewer
 * headers are verified because this answer shares one request with songs,
 * albums and artists and must not hold them up.
 */
export async function searchPlaylists(query, limit = 12) {
  const capped = publicLimit(limit, 12);
  if (capped === 0) return [];
  return playlistResults(query, { limit: capped, verify: 8 });
}

/**
 * YouTube's own recommender graph. This is the free, strong signal for a
 * single user: 50 related tracks with ids, no model required.
 */
export async function upNext(videoId, limit = 25) {
  const capped = publicLimit(limit, 25);
  if (capped === 0) return [];
  const res = await withTimeout(
    (yt) => yt.music.getUpNext(videoId, true),
    config.resolveTimeoutMs,
    'upNext',
  );
  const tracks = list(res?.contents ?? res?.items)
    .map(toTrack)
    .filter((t) => t && t.videoId !== videoId);
  // A clean edit is offered only when the neighbourhood has nothing else: the
  // censored upload of a song and its real edit are the same song key, and the
  // recommender hands back both. Partitioning (not filtering) keeps the clean
  // rows reachable — an all-clean neighbourhood still fills the page — while
  // making sure a non-clean edit is always ahead of them.
  const notClean = tracks.filter((t) => t.version !== 'clean');
  const clean = tracks.filter((t) => t.version === 'clean');
  return [...notClean, ...clean].slice(0, capped);
}

/**
 * The catalogued artist for a name: a channel id, or null.
 *
 * Up-next knows who made each track but not their channel id, so a station
 * that wants an artist's *other* songs has to look the artist up once. Results
 * are ranked by audience (see searchArtists) so a fan re-upload channel does
 * not win over the real artist.
 */
export async function artistIdFor(name) {
  const q = String(name ?? '').trim();
  if (!q) return null;
  const res = await withTimeout(
    (yt) => yt.music.search(q, { type: 'artist' }),
    config.resolveTimeoutMs,
    'artist search',
  );
  const hit = list(res?.artists?.contents)[0];
  const id = hit?.id ?? hit?.channel_id ?? null;
  return typeof id === 'string' && /^UC[\w-]{20,}$/.test(id) ? id : null;
}

/**
 * An artist page, reduced to the two things a station needs from it:
 * their songs (the catalogue, not one up-next neighbourhood) and the artists
 * YouTube files next to them ("Fans might also like").
 *
 * The top-songs shelf is the first section and has no title; the rest are
 * Albums, Singles & EPs, Videos, … The adjacent list is what lets the station
 * move one step sideways *inside* the listener's taste instead of asking the
 * same band for the same songs again.
 */
/**
 * One album shelf row (`MusicTwoRowItem` with item_type "album").
 *
 * The id is the album's browse id (MPR…), which is what `music.getAlbum`
 * accepts. The subtitle carries the format — "Album • 2021", "Single • 2021" —
 * and is the only place the distinction appears.
 */
function toAlbumItem(v) {
  if (!v || typeof v !== 'object') return null;
  const id = v.id;
  if (typeof id !== 'string' || !/^MPR[\w-]+$/.test(id)) return null;
  const title = text(v.title);
  if (!title) return null;
  const subtitle = text(v.subtitle) ?? '';
  return {
    id,
    title,
    // `year` is a number upstream and a string in older payloads; a 4-digit
    // match in the subtitle is the fallback for both.
    year: /(\d{4})/.exec(subtitle)?.[1]
      ?? (/^\d{4}$/.test(String(v.year ?? '')) ? String(v.year) : null),
    type: /single|\bep\b/i.test(subtitle) ? 'Single' : 'Album',
    thumb: thumbFrom(v),
  };
}

/**
 * A video row on an artist page ("Videos", "Live performances").
 *
 * These are `MusicTwoRowItem`s, not catalogue songs: no album, no duration, and
 * the byline is "Artist • 1.5B views". The thumbnail is the video's own still.
 */
function toShelfVideo(v) {
  if (!v || typeof v !== 'object') return null;
  const id = v.id;
  if (typeof id !== 'string' || id.length !== 11) return null;
  const title = text(v.title);
  if (!title) return null;
  const parts = (text(v.subtitle) ?? '').split('\u2022').map((s) => s.trim()).filter(Boolean);
  const channel = parts[0] || null;
  return {
    videoId: id,
    title,
    artist: channel,
    channel,
    channelId: null,
    // "Artist • 4:05": the length is in the byline or nowhere.
    durationS: durationFromParts(parts),
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    album: null,
    itemType: 'video',
    official: true,
  };
}

/**
 * An artist page: who they are, their popular songs, their releases, and the
 * artists YouTube files next to them.
 *
 * The top-songs shelf is the first section and has no title; the rest are
 * Albums, Singles & EPs, Videos, Live performances, Featured on, Playlists by…
 * and "Fans might also like". Reading the headings rather than the order keeps
 * this working when YouTube adds or drops a shelf.
 */
export async function artistPage(artistId) {
  const page = await withTimeout(
    (yt) => yt.music.getArtist(artistId),
    config.resolveTimeoutMs,
    'artist',
  );
  const sections = list(page?.sections);
  const heading = (s) => text(s?.header?.title) ?? '';
  const contents = (re) => list(sections.find((s) => re.test(heading(s)))?.contents);
  const header = page?.header;

  const songs = list(sections.find((s) => !heading(s))?.contents)
    .map(toMusicTrack).filter(Boolean);
  const adjacent = contents(/might also like/i)
    .map((c) => (c && typeof c === 'object' ? {
      name: text(c.title) ?? text(c.name),
      id: str(c.id),
      thumb: thumbFrom(c),
    } : null))
    .filter((c) => c?.name && /^UC[\w-]{20,}$/.test(c.id ?? ''));

  return {
    id: artistId,
    name: text(header?.title) ?? null,
    // MusicImmersiveHeader keeps the avatar on `.thumbnail.contents`; other
    // header variants expose a plain array. Accept both.
    thumb: str(header?.thumbnail?.contents?.[0]?.url ?? header?.thumbnail?.[0]?.url),
    description: text(header?.description) ?? null,
    songs,
    albums: contents(/^albums$/i).map(toAlbumItem).filter(Boolean),
    singles: contents(/^singles/i).map(toAlbumItem).filter(Boolean),
    videos: contents(/^videos$|live performances/i).map(toShelfVideo).filter(Boolean),
    adjacent,
  };
}

/**
 * What the station needs from an artist page: their songs and their neighbours.
 * Kept as its own export because the station asks for hundreds of these and
 * should not start depending on the page's presentation shelves.
 */
export async function artistProfile(artistId) {
  const { name, songs, adjacent } = await artistPage(artistId);
  return { name, songs, adjacent };
}

/**
 * A real album (MPR… browse id), not a playlist.
 *
 * Album rows carry no artist or album credit of their own, so both are filled
 * from the header — otherwise every track opened from an album would lose the
 * artist that made the page findable in the first place.
 */
export async function albumPage(albumId) {
  const page = await withTimeout(
    (yt) => yt.music.getAlbum(albumId),
    config.resolveTimeoutMs,
    'album',
  );
  const header = page?.header;
  const title = text(header?.title) ?? null;
  const subtitle = text(header?.subtitle) ?? '';
  const artist = text(header?.strapline_text_one) ?? text(header?.strapline) ?? null;
  // The strapline's run carries the artist's channel, which is the canonical
  // way back to their page (a name would have to be re-resolved by search).
  const artistId = list(header?.strapline_text_one?.runs)
    .map((r) => str(r?.endpoint?.payload?.browseId))
    .find((id) => /^UC[\w-]{20,}$/.test(id ?? '')) ?? null;
  const tracks = list(page?.contents)
    .map(toMusicTrack)
    .filter(Boolean)
    .map((t) => ({
      ...t,
      artist: t.artist ?? artist,
      channel: t.channel ?? artist,
      // The album this page *is* — not whatever a row's byline happened to
      // contain (album rows often say "N/A" there).
      album: title ?? t.album,
      // The album a track came from is the page it was opened on, which is
      // cheaper and more accurate than re-deriving it from a search.
      albumId,
    }));
  return {
    title,
    author: artist,
    authorId: artistId,
    type: /single|\bep\b/i.test(subtitle) ? 'Single' : 'Album',
    year: /(\d{4})/.exec(subtitle)?.[1] ?? null,
    thumb: str(header?.thumbnail?.contents?.[0]?.url),
    tracks,
  };
}

// videoId -> { value, expiresAt }. Neither a hit nor a miss is permanent: a
// title can be re-released on an album, and a lookup that ran on stale metadata
// must not disable "Open album" for the life of the process.
const albumOfCache = new Map();
const albumInFlight = new Map();
const ALBUM_TTL = 6 * 60 * 60_000;
const ALBUM_MISS_TTL = 10 * 60_000;
const ALBUM_CACHE_MAX = 500;

/** Remember an album answer, evicting the oldest entry past the ceiling. */
function rememberAlbum(videoId, value, generation = identityGeneration) {
  if (generation !== identityGeneration) return;
  albumOfCache.set(videoId, { value, expiresAt: Date.now() + (value ? ALBUM_TTL : ALBUM_MISS_TTL) });
  if (albumOfCache.size <= ALBUM_CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of albumOfCache) if (v.expiresAt <= now) albumOfCache.delete(k);
  for (const k of albumOfCache.keys()) {
    if (albumOfCache.size <= ALBUM_CACHE_MAX) break;
    albumOfCache.delete(k);
  }
}

/**
 * The album a track belongs to, resolved from the Music catalogue.
 *
 * A catalogue row already carries its album id, but up-next, videos and older
 * library rows do not. Searching the catalogue for the track and matching on
 * video id — or, when the upload differs, on the song's identity — is the only
 * honest way to answer "open the album of this song". A miss stays a miss: a
 * wrong album is worse than a disabled button.
 */
export function albumForVideo(videoId, meta = {}) {
  const pending = albumInFlight.get(videoId);
  if (pending) return pending;
  const generation = identityGeneration;
  let work;
  work = findAlbumForVideo(videoId, meta, generation).finally(() => {
    if (generation === identityGeneration && albumInFlight.get(videoId) === work) {
      albumInFlight.delete(videoId);
    }
  });
  albumInFlight.set(videoId, work);
  return work;
}

async function findAlbumForVideo(videoId, meta, generation) {
  const cached = albumOfCache.get(videoId);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    albumOfCache.delete(videoId);
  }
  let { title, artist } = meta ?? {};
  if (!title) {
    try {
      const info = await withTimeout(
        (yt) => yt.getBasicInfo(videoId, { client: 'IOS' }),
        config.resolveTimeoutMs,
        'getBasicInfo',
      );
      title = text(info?.basic_info?.title);
      artist = artist ?? text(info?.basic_info?.author);
    } catch {
      // No title means there is nothing to search for, and that is a transient
      // failure rather than a fact about the track: do not cache it.
      return null;
    }
  }

  // An upload title is "Artist - Song (Official Video)"; the catalogue row is
  // "Song". Searching the raw upload title biases the result to the upload
  // itself, so the credit and the qualifiers are stripped first.
  const parsed = parseVideoTitle(text(title) ?? '');
  const songTitle = String(parsed.artist ? parsed.title : (text(title) ?? '')).trim();
  const credited = parsed.artist ?? text(artist) ?? null;
  // Nothing to search for is not "this track has no album".
  if (!songTitle) return null;

  let found = null;
  const q = [songTitle, credited].filter(Boolean).join(' ');
  try {
    const res = await withTimeout(
      (yt) => yt.music.search(q, { type: 'song' }),
      config.resolveTimeoutMs,
      'album lookup',
    );
    const rows = list(res?.songs?.contents).map(toMusicTrack).filter((t) => t?.albumId);
    // Match on the *song* identity, not the upload title: the same recording
    // is usually a different video id on the album than the video upload.
    const wanted = songKey({ title: songTitle, artist: credited ?? '', itemType: 'song' });
    const hit = rows.find((r) => r.videoId === videoId)
      ?? rows.find((r) => songKey({ ...r, itemType: 'song' }) === wanted);
    if (hit) {
      found = {
        albumId: hit.albumId,
        title: hit.album ?? null,
        author: hit.artist ?? credited ?? null,
      };
    }
  } catch {
    // A failed lookup is not cached as a miss; it may succeed later.
    return null;
  }

  rememberAlbum(videoId, found, generation);
  return found;
}

/**
 * Moods and genres as YouTube Music files them, e.g. `genreTiles()` ->
 * [{ name: 'Rock', params }, …].
 *
 * This is the one place where "which lane is this person in" can be answered
 * from YouTube rather than guessed: the same tiles the app's mood page shows.
 * Cached for the session — the list changes about as often as the site does.
 */
let genreTilesPromise = null;
export function genreTiles() {
  if (genreTilesPromise) return genreTilesPromise;
  const generation = identityGeneration;
  let pending;
  pending = (async () => {
    const feed = await withTimeout(
      (yt) => yt.music.getExplore(),
      config.resolveTimeoutMs,
      'explore',
    );
    const shelf = list(feed?.sections).find((s) => /moods/i.test(text(s?.header?.title) ?? ''));
    return list(shelf?.contents)
      .map((v) => (v && typeof v === 'object' ? {
        name: text(v.button_text) ?? text(v.text) ?? text(v.title),
        params: str(v.endpoint?.payload?.params),
        browseId: str(v.endpoint?.payload?.browseId),
      } : null))
      .filter((g) => g?.name && g.params && g.browseId);
  })().catch((err) => {
    if (generation === identityGeneration && genreTilesPromise === pending) genreTilesPromise = null;
    throw err;
  });
  genreTilesPromise = pending;
  return pending;
}

/**
 * The songs YouTube Music puts on a genre page — the "what is big in this lane
 * right now" shelf, 50 rows, ordered by YouTube itself.
 *
 * Deliberately read from the *browse* payload rather than the typed parser:
 * the shelf is a raw `musicCarouselShelfRenderer` here, because the Music
 * client wraps this page in its own renderers. Reading the raw shape is ugly
 * but it is the actual contract, and it is checked by the live test.
 */
export async function genreSongs(genre, limit = 20) {
  const name = String(genre ?? '').trim();
  const capped = publicLimit(limit, 20);
  if (!name || capped === 0) return [];
  const tiles = await genreTiles();
  const tile = tiles.find((g) => g.name.toLowerCase() === name.toLowerCase())
    ?? tiles.find((g) => g.name.toLowerCase().includes(name.toLowerCase()));
  if (!tile) return [];

  const res = await withTimeout(
    (yt) => yt.actions.execute('/browse', { browseId: tile.browseId, params: tile.params, client: 'YTMUSIC' }),
    config.resolveTimeoutMs,
    'genre songs',
  );
  const data = res?.data ?? res;
  const sections = list(data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents);
  const heading = (s) => list(s?.musicCarouselShelfRenderer?.header?.musicCarouselShelfBasicHeaderRenderer
    ?.title?.runs).map((r) => text(r?.text)).filter(Boolean).join('') || null;
  const shelf = sections.find((s) => /^songs$/i.test(heading(s) ?? ''))
    ?? sections.find((s) => /^music videos$/i.test(heading(s) ?? ''));
  const rows = list(shelf?.musicCarouselShelfRenderer?.contents);

  return rows
    .map(rawMusicRow)
    .filter(Boolean)
    // The genre page already ranks by popularity; the byline carries the views
    // so the caller can prefer bigger songs without a second lookup.
    .slice(0, capped);
}

/**
 * One row of a raw `musicResponsiveListItemRenderer`.
 *
 * Only used for pages the typed parser does not cover (genre shelves). The
 * columns are "Title / Artist • 86M views / Album", and the video id sits on
 * the thumbnail's play button — the title's own endpoint is a browse link.
 */
function rawMusicRow(item) {
  if (!item || typeof item !== 'object') return null;
  const r = item.musicResponsiveListItemRenderer;
  if (!r || typeof r !== 'object') return null;
  const col = (i) => list(list(r.flexColumns)[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs)
    .map((x) => text(x?.text)).filter(Boolean).join('');
  const title = col(0)?.trim();
  const byline = col(1) ?? '';
  const videoId = str(r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
    ?.playNavigationEndpoint?.watchEndpoint?.videoId)
    ?? str(list(list(r.flexColumns)[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs)[0]
      ?.navigationEndpoint?.watchEndpoint?.videoId);
  if (!videoId || videoId.length !== 11 || !title) return null;
  const [artistPart] = byline.split('\u2022');
  const artist = artistPart?.trim() || null;
  const views = /([\d.,]+\s*[KMB]?)\s*views?/i.exec(byline);
  return {
    videoId,
    title,
    artist,
    channel: artist,
    // "Artist • 86M views • 3:05" on the video shelf of a genre page.
    durationS: durationFromParts(byline.split('\u2022').map((s) => s.trim())),
    thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    album: col(2)?.trim() || null,
    views: views ? toCount(views[1]) : 0,
    itemType: 'song',
    official: true,
  };
}

/**
 * What is trending right now, unfiltered by genre. Used only when the station
 * has no better lane: it is the last-resort discovery pool, and it is capped
 * to a couple of tracks by the caller so a station never turns into a chart.
 */
export async function exploreTrending(limit = 12) {
  const capped = publicLimit(limit, 12);
  if (capped === 0) return [];
  const feed = await withTimeout(
    (yt) => yt.music.getExplore(),
    config.resolveTimeoutMs,
    'explore',
  );
  const section = list(feed?.sections).find((s) => /trending/i.test(text(s?.header?.title) ?? ''));
  return list(section?.contents)
    .map((v) => (v?.item_type === 'song' || v?.item_type === 'video' ? toMusicTrack(v) : null))
    .filter(Boolean)
    .slice(0, capped);
}

/**
 * Is this an ongoing live broadcast? yt-dlp cannot "download" one (it would
 * read forever), so this is checked before starting a fetch.
 *
 * Best effort: if the lookup fails (bot gate, timeout, transient outage) this
 * returns false and playback proceeds. A failed *check* must never stop a
 * track that could otherwise play.
 *
 * Answers are cached per id for a few minutes, because the check is a full
 * YouTube round-trip and two different places ask about the same id within one
 * request: /api/stream probes before it downloads, and ensureAudio() probes
 * before it takes a download slot. Only an actual boolean answer is cached:
 * an exception or a changed/missing renderer is not evidence of "not live".
 */
const LIVE_CACHE_TTL_MS = 5 * 60_000;
const LIVE_CACHE_MAX = 500;
const liveCache = new Map(); // videoId -> { at, live }
const liveInFlight = new Map();

export function isLive(videoId) {
  const hit = liveCache.get(videoId);
  if (hit && Date.now() - hit.at < LIVE_CACHE_TTL_MS) return Promise.resolve(hit.live);
  if (hit) liveCache.delete(videoId);
  const pending = liveInFlight.get(videoId);
  if (pending) return pending;

  const generation = identityGeneration;
  let work;
  work = (async () => {
    try {
      const info = await withTimeout(
        (yt) => yt.getBasicInfo(videoId, { client: 'IOS' }),
        config.resolveTimeoutMs,
        'getBasicInfo',
      );
      const live = info?.basic_info?.is_live;
      if (typeof live !== 'boolean') return false;
      if (generation === identityGeneration) {
        liveCache.set(videoId, { at: Date.now(), live });
        for (const key of liveCache.keys()) {
          if (liveCache.size <= LIVE_CACHE_MAX) break;
          liveCache.delete(key);
        }
      }
      return live;
    } catch {
      return false;
    } finally {
      if (generation === identityGeneration && liveInFlight.get(videoId) === work) {
        liveInFlight.delete(videoId);
      }
    }
  })();
  liveInFlight.set(videoId, work);
  return work;
}

/**
 * Lyrics via YouTube Music. Best effort: a track without lyrics is normal, not
 * an error, so this resolves to null instead of throwing. Verified against a
 * real track (Radiohead - Creep) returning ~800 chars of plain text.
 *
 * A null is deliberately ambiguous — "no lyrics" and "the lookup failed" look
 * the same here — so the *route* must not cache it for long (it gives a null
 * three minutes and a hit six hours).
 */
export async function fetchLyrics(videoId) {
  try {
    const shelf = await withTimeout(
      (yt) => yt.music.getLyrics(videoId),
      config.resolveTimeoutMs,
      'lyrics',
    );
    const d = shelf?.description;
    // Only a string or a run object can be lyrics; a number or a boolean is a
    // malformed answer, not something to print.
    const lyrics = typeof d === 'string'
      ? d
      : (d && typeof d === 'object'
        ? (typeof d.text === 'string'
          ? d.text
          : (typeof d.toString === 'function' && d.toString !== Object.prototype.toString ? String(d) : null))
        : null);
    return lyrics && lyrics.trim() ? lyrics.trim() : null;
  } catch {
    // Includes getYT(): a session that cannot be created is not a lyric-less track.
    return null;
  }
}

/**
 * Real releases and channels for the library tabs.
 *
 * youtubei.js 18.2 returns search hits as a unified `results` array instead of
 * typed shelves: playlists arrive as `LockupView` (id in `content_id`, title in
 * `metadata.title`) and artists as `Channel`. Both shapes are handled, plus the
 * older typed shelves, so a future API shuffle degrades instead of going blank.
 */
function thumbFrom(node) {
  let url = str(node?.thumbnails?.[0]?.url)
    // `MusicTwoRowItem` exposes the avatar/cover as a plain `thumbnail` array.
    ?? str(node?.thumbnail?.[0]?.url)
    ?? str(node?.author?.thumbnails?.[0]?.url);
  if (!url) {
    const img = node?.content_image?.primary_thumbnail?.image
      ?? node?.content_image?.image
      ?? node?.primary_thumbnail?.image;
    url = str(list(img)[0]?.url) ?? str(img?.url);
  }
  if (!url) return null;
  // YouTube returns protocol-relative URLs for channel avatars (//yt3.ggpht…).
  return url.startsWith('//') ? `https:${url}` : url;
}

/** Parse "12M subscribers" / "1.2K videos" into a number for ranking. */
function lockupTitle(node) {
  return text(node?.metadata?.title);
}

function lockupSubtitle(node) {
  const rows = list(node?.metadata?.metadata?.metadata_rows);
  const parts = rows.flatMap((r) => list(r?.metadata_parts).map((p) => text(p?.text?.text ?? p?.text)));
  return parts.filter(Boolean).join(' · ') || null;
}

/**
 * A release row from the catalogue's Albums shelf.
 *
 * Rows read `OK Computer` | `Album • Radiohead • 1997`, and the id is the real
 * browse id (MPR…), which is what makes the release openable. The shelf has no
 * track count: that lives on the album page, which is one more call than a
 * search tab can afford per row.
 */
function toReleaseItem(v) {
  if (!v || typeof v !== 'object') return null;
  const id = v.id;
  if (typeof id !== 'string' || !/^MPR[\w-]+$/.test(id)) return null;
  const title = text(v.title);
  if (!title) return null;
  const byline = parseReleaseByline(text(list(v.flex_columns)[1]?.title) ?? text(v.subtitle));
  return {
    id,
    title,
    author: byline.author,
    year: byline.year,
    trackCount: null,
    // "Single"/"EP" is kept apart from the album tab's own grouping: the client
    // labels the row, the response type only says which shelf it came from.
    format: byline.format,
    thumb: thumbFrom(v),
  };
}

/**
 * Real releases for the library's album tab and the search Albums tab.
 *
 * The Music catalogue's album shelf is the release shelf: its ids are MPR…
 * browse ids and its author/year byline is the release's own. Plain search
 * answers with playlists (PL…) and LockupViews, which are collections, not
 * releases — so it stays as the fallback for queries without a catalogue
 * release (a non-music channel, an obscure uploader).
 */
export async function searchAlbums(query, limit = 18) {
  const capped = publicLimit(limit, 18);
  if (capped === 0) return [];
  try {
    const res = await withTimeout(
      (yt) => yt.music.search(query, { type: 'album' }),
      config.resolveTimeoutMs,
      'album search',
    );
    const releases = list(res?.albums?.contents)
      .map(toReleaseItem).filter(Boolean).slice(0, capped);
    if (releases.length) return releases;
  } catch (err) {
    if (isPolicyFailure(err)) throw err;
    // Fall through: a failed catalogue lookup must not empty the album tab.
  }

  const res = await withTimeout(
    (yt) => yt.search(query, { type: 'playlist' }),
    config.resolveTimeoutMs,
    'album search',
  );
  const pool = list(res?.playlists ?? res?.results);
  return pool.map((p) => {
    if (!p || typeof p !== 'object') return null;
    if (p.type === 'LockupView' || p.content_id) {
      return {
        id: str(p.content_id),
        title: lockupTitle(p),
        author: lockupSubtitle(p),
        trackCount: null,
        thumb: thumbFrom(p),
      };
    }
    return {
      id: str(p.id),
      title: text(p.title),
      author: text(p.author?.name),
      trackCount: num(p.video_count ?? p.videoCount),
      thumb: thumbFrom(p),
    };
  }).filter((p) => p?.id && p.title).slice(0, capped);
}

export async function searchArtists(query, limit = 18) {
  const capped = publicLimit(limit, 18);
  if (capped === 0) return [];

  // The Music catalogue's artist shelf is the right source for a "who is this"
  // answer: it is relevance-ranked by the same graph the artist pages come
  // from, so the band itself leads, and it finds artists that plain channel
  // search misses entirely ("mazzy star" returns no channel hits at all).
  // The channel search stays as the fallback, for non-music channels.
  try {
    const res = await withTimeout(
      (yt) => yt.music.search(query, { type: 'artist' }),
      config.resolveTimeoutMs,
      'artist search',
    );
    const rows = list(res?.artists?.contents)
      .map((c) => (c && typeof c === 'object' ? {
        id: str(c.id),
        title: text(c.name) ?? text(c.title),
        // An empty string is not a subscriber count: it rendered as "0" and
        // sorted every artist with a blank byline to the bottom.
        subscribers: text(c.subscribers) || null,
        handle: null,
        videoCount: null,
        thumb: thumbFrom(c),
      } : null))
      // Only rows whose id is a channel: `music.getArtist` accepts nothing else.
      .filter((c) => c?.id && c.title && /^UC[\w-]{20,}$/.test(c.id));
    // Order is the catalogue's own relevance ranking; re-sorting by audience
    // would push the actual artist down behind a better-known neighbour.
    if (rows.length) return rows.slice(0, capped);
  } catch (err) {
    if (isPolicyFailure(err)) throw err;
    // Fall through: a failed Music lookup must not empty the artists tab.
  }

  const res = await withTimeout(
    (yt) => yt.search(query, { type: 'channel' }),
    config.resolveTimeoutMs,
    'artist search',
  );
  const pool = list(res?.channels ?? res?.results);
  return pool.map((c) => {
    if (!c || typeof c !== 'object') return null;
    // The channel renderer's fields shift between builds: sometimes
    // subscriber_count holds "@handle" and video_count holds "12M subscribers".
    // Read every candidate string and classify by content, not by field name.
    const raw = [
      text(c.subscriber_count), text(c.video_count),
      text(c.short_byline), text(c.long_byline), text(c.byline),
    ].filter(Boolean).join(' ');

    const subs = /([\d.,]+\s*[KMB]?)\s*subscribers?/i.exec(raw);
    const handle = /@[\w.-]+/.exec(raw);
    return {
      id: str(c.id ?? c.content_id),
      title: text(c.author?.name) ?? lockupTitle(c) ?? text(c.title),
      subscribers: subs ? subs[1].replace(/\s+/g, '') + ' subscribers' : null,
      handle: handle ? handle[0] : null,
      videoCount: null,
      thumb: thumbFrom(c),
    };
  })
    .filter((c) => c?.id && c.title)
    // Rank by audience so the actual artist outranks fan re-upload channels.
    .sort((a, b) => toCount(b.subscribers) - toCount(a.subscribers))
    .slice(0, capped);
}

/**
 * One row per song, keeping the first (highest-ranked) occurrence.
 *
 * Community playlists routinely hold the same song several times — the album
 * track, "(Official Music Video)", a remaster — because whoever built it added
 * every upload they found. Opening a playlist should not hand that mess back.
 * Genuinely different recordings (acoustic, live, remix) keep distinct titles
 * and therefore survive.
 */
function uniqueSongs(tracks) {
  const seenVideo = new Set();
  const seenSong = new Set();
  return tracks.filter((t) => {
    if (!t) return false;
    if (seenVideo.has(t.videoId)) return false;
    const key = songKey(t);
    if (key && seenSong.has(key)) return false;
    seenVideo.add(t.videoId);
    if (key) seenSong.add(key);
    return true;
  });
}

/**
 * Tracks belonging to a YouTube playlist — a real album, or a community
 * playlist opened from a mood page. Returns the header too, so the UI can name
 * the playlist without a second lookup.
 */
export async function playlistTracks(playlistId, limit = 100) {
  const capped = publicLimit(limit, 100);

  // Music-catalogue ids (VLPL…) are only readable through the Music client;
  // a plain PL… id from the library's album tab goes through the normal one.
  if (/^VL/.test(playlistId)) {
    const pl = await withTimeout(
      (yt) => yt.music.getPlaylist(playlistId),
      config.resolveTimeoutMs,
      'playlist',
    );
    const tracks = list(pl?.contents ?? pl?.items)
      .map((v) => ((v?.item_type === 'song' || v?.item_type === 'video') ? toMusicTrack(v) : null))
      .filter(Boolean);
    return {
      title: text(pl?.header?.title),
      author: null,
      type: 'Playlist',
      tracks: uniqueSongs(tracks).slice(0, capped),
    };
  }

  const pl = await withTimeout(
    (yt) => yt.getPlaylist(playlistId),
    config.resolveTimeoutMs,
    'playlist',
  );
  const tracks = list(pl?.videos ?? pl?.items).map(toTrack).filter(Boolean);
  return {
    title: text(pl?.info?.title),
    author: text(pl?.info?.author?.name),
    type: text(pl?.info?.author?.name) ? 'Playlist' : 'Album',
    tracks: uniqueSongs(tracks).slice(0, capped),
  };
}
