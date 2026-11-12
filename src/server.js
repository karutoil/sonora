import Fastify from 'fastify';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from './config.js';
import {
  db, findUser, verifyPassword, signSession, readSession,
  upsertTrack, recordPlay, toggleLike, listLikes, bootstrapUser,
  listPlaylists, createPlaylist, getPlaylist, addPlaylistItem,
  removePlaylistItem, deletePlaylist, recentlyPlayed, topArtists, cacheGet, cacheSet,
  cacheDeletePrefix, cacheDelete,
  getUser, createUser, setUserRole, setUserDisabled, setUserPassword,
  bumpSessionVersion, touchLogin, countAdmins, deleteUser, listUsersWithStats,
  adminCounts, listTracksForAdmin, deleteTrack, clearUserHistory,
  recordAudit, listAudit, getTrack, ROLES,
  toggleDislike, listDislikes, dislikedIds, stationCandidates, stationArtists,
  createDevice, getDevice, findDeviceByClient, listDevices, touchDevice,
  setDeviceRemembered, renameDevice, deleteDevice, deleteDeviceForUser,
  deleteOtherDevices, deleteAllDevices, pruneStaleDevices,
  issueRefreshToken, getRefreshToken, consumeRefreshToken, revokeRefreshToken,
  revokeDeviceTokens, revokeAllRefreshTokens, deleteExpiredRefreshTokens, hashToken,
  listPasskeys, listPasskeyCredentials, getPasskeyByCredentialId, createPasskey,
  updatePasskeyUse, renamePasskey, deletePasskey, countPasskeys,
  createChallenge, takeChallenge, deleteExpiredChallenges,
  listRoomsForUser, signGuest, readGuest,
  followArtist, unfollowArtist, listFollows, isFollowing,
  listNotifications, countUnread, markNotificationsRead, markAllNotificationsRead,
  pruneNotifications, transaction, pruneExpiredCache, pruneOrphanCache, touchUserSeen,
  prunePlays,
} from './db.js';
import {
  RoomError, ROOM_CODE, createRoom, joinRoom, leaveRoom, endRoom, updateRoom,
  inviteUser, uninviteUser, peopleFor, applyCommand, openStream, memberRoster,
  viewRoom, expireRooms, roomPreview, publicSnapshot, guestStreamAllowed,
  transferHost, touchRoomPresence,
} from './rooms.js';
import {
  rankSeeds, buildStation, stationName, stationBlurb, rotateSeeds, rotateArtists,
  rejectedBySkip, planPage, withLane, artistKeyOf, STATION_LIMIT, EXTEND_LIMIT,
  normalizeStationCursor, advanceStationCursor,
} from './station.js';
import { songKey, cardMetadata } from './search-rank.js';
import { checkArtist, pollFollows } from './follows.js';
import {
  searchTracks, upNext, isLive, fetchLyrics, searchAlbums, searchArtists, searchMoodPlaylists,
  searchPlaylists,
  playlistTracks, getYT, resetYT, artistIdFor, artistProfile, artistPage, albumPage,
  albumForVideo, genreSongs, genreTiles,
} from './youtube.js';
import {
  ensureAudio, cachedAudio, pruneCache, pruneCacheTo, clearCache, removeCachedAudio,
  cacheStats, runProcess, ytdlpBin, ytdlpExtraArgs,
} from './audio.js';
// The queue as one continuous stream: the only playback shape that survives an
// iPhone locking its screen (see src/queue-stream.js).
import {
  planQueueStream, getPlan, openQueueStream, attachSession, getSession,
  sessionNow, playlistFor, readSegment, closeSession, windowSeqs, seqAt,
  ensureSegments, ensureSegment, noteSegmentFetch, maybeReposition,
} from './queue-stream.js';
import {
  parseNetscape, parseAny, inspectJar, saveJar, clearJar, restoreJar, jarStatus,
  activeCookiesPath,
} from './cookies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const COOKIE = 'sonora_session';
const startedAt = new Date();

// ── process-owned work ──────────────────────────────────────────────────
// A response finishing does not mean the work it started has finished. Own every
// detached promise here, so shutdown can stop scheduling new work, cancel jobs
// through their module's own AbortSignal, and give their cleanup a bounded grace
// period before SQLite closes. Request-owned jobs use the same registry: they are
// drained too, but only detached jobs are cancelled while their responses may
// already have completed.
const schedulerHandles = new Set();
const jobs = new Set();
let closing = false;

function trackJob(label, work, { detached = false, cancel = null } = {}) {
  if (closing) return null;
  const job = { label, detached, cancel, promise: null };
  // Starting in a microtask adds the job to the registry before user code can
  // throw and also turns a synchronous throw into a normal, observed rejection.
  job.promise = Promise.resolve().then(work);
  jobs.add(job);
  const settled = () => { jobs.delete(job); };
  job.promise.then(settled, settled);
  return job;
}

function trackDetached(label, work, options = {}) {
  return trackJob(label, work, { ...options, detached: true });
}

function schedulePeriodic(work, intervalMs) {
  const handle = setInterval(work, intervalMs);
  handle.unref?.();
  schedulerHandles.add(handle);
  return handle;
}

function stopSchedulers() {
  for (const handle of schedulerHandles) clearInterval(handle);
  schedulerHandles.clear();
}

/** Cancel detached subscribers, then await every tracked job for a finite time. */
async function drainJobs() {
  stopSchedulers();
  for (const job of jobs) {
    if (!job.detached || !job.cancel) continue;
    try { job.cancel(); } catch (err) {
      console.warn(`[sonora] could not cancel ${job.label}:`, err?.message ?? err);
    }
  }
  if (!jobs.size) return;

  const pending = [...jobs];
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), 2500);
    timer.unref?.();
  });
  const drained = Promise.allSettled(pending.map((job) => job.promise)).then(() => true);
  const complete = await Promise.race([drained, expired]);
  clearTimeout(timer);
  if (!complete) {
    // The caller exits synchronously after closing SQLite when this deadline is
    // exceeded. An uncancellable upstream promise therefore cannot wake up and
    // write to a closing database; the media/follows modules still need a native
    // cancellation API if such work is ever meant to be reusable after shutdown.
    console.warn('[sonora] background job drain timed out:', pending
      .filter((job) => jobs.has(job)).map((job) => job.label).join(', '));
  }
}

/**
 * A route-independent security classification for one request target.
 *
 * Fastify routes a percent-encoded `/%61pi/me` to `/api/me`, and Node also
 * accepts the absolute-form target `http://host/api/me`. Looking only at the raw
 * request target made both spellings invisible to the API limiter and no-store
 * hook. Parse origin/absolute forms, then decode the path once for both
 * decisions. Malformed targets fail closed: an unknown route may lose the static
 * cache/rate-limit exemption, but an API route cannot silently bypass them.
 */
function isApiRequest(req) {
  const raw = String(req.raw?.url ?? req.url ?? '');
  try {
    const pathname = decodeURIComponent(new URL(raw, 'http://local').pathname);
    return pathname.startsWith('/api/');
  } catch {
    return true;
  }
}

/**
 * The set of *songs* (not just video ids) this user has refused.
 *
 * A dislike is recorded against one upload, but the recommender will happily
 * offer the same song as "(Official Audio)" under a different id, which reads
 * as the app ignoring the instruction.
 */
function dislikedSongKeys(userId) {
  const keys = new Set();
  for (const t of listDislikes(userId)) {
    if (!t.title) continue;
    // The *same* key function the recommendations are filtered with. A dislike
    // stores the raw upload title ("Radiohead - Creep (Official Video)"), while
    // a candidate row is a video whose title gets parsed by songKey() into
    // "creep|radiohead"; keying the dislike as an already-parsed song meant the
    // two never collided, so "fewer like this" looked ignored on re-uploads.
    // Both shapes are recorded: the parsed one for video rows, the explicit
    // song one for catalogue rows that arrive without an artist credit.
    const parsed = songKey({ title: t.title, channel: t.channel });
    const explicit = songKey({ title: t.title, channel: t.channel, itemType: 'song' });
    if (parsed) keys.add(parsed);
    if (explicit) keys.add(explicit);
  }
  return keys;
}

/**
 * The personal station is built from this user's listening, likes and dislikes,
 * so any change to those inputs must drop the cached queue. The epoch also
 * invalidates work already in flight: deleting a cache row alone lets an older
 * slow build return its evidence and write it straight back after the delete.
 *
 * Kept synchronous and one-argument for every mutation route, including the
 * admin clear-history handoff. Once this returns, older attempts cannot publish.
 */
const STATION_EPOCHS = new Map();
const STATION_EPOCHS_MAX = 512;
function stationEpoch(userId) {
  return STATION_EPOCHS.get(userId) ?? 0;
}
function invalidateStation(userId) {
  const next = stationEpoch(userId) >= Number.MAX_SAFE_INTEGER ? 0 : stationEpoch(userId) + 1;
  if (STATION_EPOCHS.size >= STATION_EPOCHS_MAX && !STATION_EPOCHS.has(userId)) {
    let drop = Math.ceil(STATION_EPOCHS_MAX / 3);
    for (const id of STATION_EPOCHS.keys()) {
      if (drop-- <= 0) break;
      STATION_EPOCHS.delete(id);
    }
  }
  STATION_EPOCHS.set(userId, next);
  cacheDeletePrefix(`station:${userId}:`);
}

/**
 * Request-boundary input rules shared by the library routes. `null` is an
 * omitted optional number (the client uses it when media metadata is unknown),
 * but strings, fractions, negatives and values outside SQLite's exact JS integer
 * range are not silently rounded or clamped into a different user instruction.
 */
function optionalDurationValid(value) {
  return value === undefined || value === null
    || (Number.isSafeInteger(value) && value >= 0);
}

function optionalBooleanValid(body, field) {
  return body?.[field] === undefined || typeof body[field] === 'boolean';
}

function positiveSafeId(value) {
  const raw = String(value ?? '');
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Track metadata a write may carry, so the server can remember a track it has
 * never seen. Liking a song opened from a share link used to store a like with
 * no title, which made that song invisible to the station *and* to the library.
 *
 * `tracks` is the shared catalogue, not the current user's private copy. Never
 * upsert browser-supplied metadata over a row another user may already see.
 */
function rememberFromBody(videoId, b = {}) {
  if (getTrack(videoId)) return;
  const title = typeof b.title === 'string' ? b.title.slice(0, 200).trim() : '';
  if (!title) return;
  upsertTrack({
    videoId,
    title,
    channel: typeof b.channel === 'string' ? b.channel.slice(0, 200) : null,
    channelId: typeof b.channelId === 'string' ? b.channelId.slice(0, 80) : null,
    thumb: typeof b.thumb === 'string' ? b.thumb.slice(0, 500) : null,
    durationS: b.durationS ?? null,
  });
}

// ── hot-path statements ─────────────────────────────────────────────────
// db.prepare() compiles SQL, so calling it inside a handler pays that cost on
// every single request. These are the statements the per-request path uses
// (session lookup, the shared player-state row, the stats header), compiled
// once here instead of once per request.
const SQL = {
  userById: db.prepare(`
    SELECT id, name, role, disabled, session_version FROM users WHERE id = ?
  `),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  playerState: db.prepare('SELECT state, updated_at FROM player_state WHERE user_id = ?'),
  savePlayerState: db.prepare(`
    INSERT INTO player_state (user_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
  `),
  // The pre-write depth of one track. A progress heartbeat invalidates only
  // when it crosses the station's 60% eligibility threshold, not on every tick.
  stationDepth: db.prepare(`
    SELECT MAX(CASE WHEN duration_ms > 0 AND position_ms IS NOT NULL
                    THEN MIN(1.0, CAST(position_ms AS REAL) / duration_ms)
                    ELSE 0 END) AS deepest
    FROM plays WHERE user_id = ? AND video_id = ?
      AND kind IN ('start','progress','complete','skip')
  `),
  stats: db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'start')  AS starts,
      COUNT(*) FILTER (WHERE kind = 'complete') AS completes,
      COUNT(*) FILTER (WHERE kind = 'skip')   AS skips
    FROM plays WHERE user_id = ? AND kind IN ('start','complete','skip')
  `),
  likeCount: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE user_id = ?'),
  likePresent: db.prepare('SELECT 1 AS present FROM likes WHERE user_id = ? AND video_id = ?'),
  dislikePresent: db.prepare('SELECT 1 AS present FROM dislikes WHERE user_id = ? AND video_id = ?'),
  playlistOwned: db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?'),
  playlistItem: db.prepare('SELECT 1 AS present FROM playlist_items WHERE playlist_id = ? AND video_id = ?'),
  updateDeviceOnLogin: db.prepare(`
    UPDATE devices SET name = ?, platform = COALESCE(?, platform), user_agent = ?,
      last_seen_at = ?, last_login_at = ?, last_ip = ?, remembered = ?
    WHERE id = ?
  `),
  // Rotation chain lookup: `replaced_by` records the successor's *token hash*,
  // not its row id (see consumeRefreshToken), so the grace window walks the
  // chain by hash.
  refreshByHash: db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?'),
  deleteChallenge: db.prepare('DELETE FROM webauthn_challenges WHERE id = ? AND kind = ?'),
};

bootstrapUser();
// Re-materialise an imported cookie jar so a restart keeps the session.
await restoreJar();

const app = Fastify({
  logger: { level: process.env.SONORA_LOG_LEVEL ?? 'info' },
  trustProxy: config.trustProxy,
  bodyLimit: 64 * 1024,
});

await app.register(fastifyCookie);
// Generous: a single track costs several ranged requests, and one phone
// seeks constantly. Auth gets its own tight limit below.
// The shell (HTML/CSS/JS/icons) is exempt: one page load fetches a dozen of
// those, and rate-limiting them turns a few open tabs into a blank page served
// with 429 to the module loader. Everything under /api/ stays limited.
//
// "Exempt" is not "unlimited": the public routes outside /api/ that touch a
// database or a network — /l/:code, /l/:code/live, /t/:id, /t/:id/art.jpg and
// /oembed.json — each set their own per-IP limit with `allowList: null`, which
// replaces this exemption for that route. A route added here that reads upstream
// or writes state must do the same.

/**
 * What is worth compressing: the shell's text, CSS, JSON (including the manifest),
 * JS and SVG.
 *
 * An allowlist rather than the plugin's default, because the default gets two
 * things wrong here. `application/javascript` is *not* in it (and that is how
 * `@fastify/static` labels `.js` on some installs), and the default's
 * `octet-stream` arm is how the admin database backup is served. Never
 * `text/event-stream`: the room SSE stream must not be buffered by a compressor.
 *
 * This list is a *narrowing*, not a veto: `@fastify/compress` falls back to
 * mime-db's own `compressible` flag for any type this says no to, and mime-db
 * calls `application/octet-stream` compressible. The backup route therefore opts
 * out with `compress: false` — a gzip-encoded `.db` download is a corrupt backup.
 */
const COMPRESSIBLE_TYPES = /^(?:text\/(?!event-stream)|(?:application|text)\/(?:[\w.+-]*\+)?(?:json|xml|javascript)|image\/svg\+xml)/i;

await app.register(rateLimit, {
  max: 600,
  timeWindow: '1 minute',
  allowList: (req) => !isApiRequest(req),
});
// The shell was shipped raw: app.js is ~395 KB and app.css ~182 KB, which is the
// whole page load on a phone. Registered before @fastify/static so the static
// routes carry the hook.
//
// It must stay off the media paths. `@fastify/compress` skips a 206 itself (a
// `Content-Range` describes unencoded byte offsets) and the type list above keeps
// it off `/api/stream`'s `audio/mp4` and the queue stream's `video/mp2t` as well,
// so a ranged or streamed response is never re-encoded even when a proxy in front
// advertises `accept-encoding`.
await app.register(compress, {
  // Brotli is what a modern browser asks for; gzip covers the rest.
  encodings: ['br', 'gzip'],
  // Below this the header and the framing cost more than the bytes saved.
  threshold: 1024,
  customTypes: COMPRESSIBLE_TYPES,
  // Responses only. Nothing here is asked to inflate a request body, and turning
  // it on would let a 64 KB gzip body (the body limit counts the compressed
  // bytes) expand into a much larger document before Fastify's JSON parse — a
  // decompression bomb in exchange for a feature no client uses.
  globalDecompression: false,
});
await app.register(fastifyStatic, {
  root: PUBLIC,
  prefix: '/',
  // The PWA updates by reloading; never let a proxy pin an old bundle.
  // Never expose repository/deployment files accidentally placed below public/.
  // `deny` rejects the path whether or not a dotfile actually exists there.
  dotfiles: 'deny',
  // Note: v10 passes the Fastify reply, not a raw ServerResponse.
  setHeaders: (reply, filePath) => {
    reply.header(
      'cache-control',
      filePath?.endsWith('.html') ? 'no-cache' : 'no-cache, must-revalidate',
    );
  },
});

/**
 * Does an `If-None-Match` header name this tag? `*`, a list, and the `W/` prefix
 * are all legal (RFC 9110 §13.1.2) and a browser will send back exactly what it
 * was given, prefixed with `W/` if it stored it as weak.
 */
function etagMatches(header, etag) {
  if (typeof header !== 'string') return false;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((part) => {
    const tag = part.trim().replace(/^W\//, '');
    return tag === '*' || tag === bare;
  });
}

/**
 * The service worker, with a tag that is its content.
 *
 * Every other static file keeps `@fastify/static`'s validator, which is
 * size+mtime — in a container the mtime is the COPY time, so two builds of the
 * same size share it and a client gets a 304 for a worker whose bytes changed.
 * For every other file that is a stale asset; for the worker it is a wedged
 * update: the browser never installs the new worker, so the app updates
 * *never* arrive, and nothing in the app can see why.
 *
 * Hashing per request rather than at boot is deliberate: a deploy rewrites
 * public/ under a running process (only src/ is frozen at start), so a boot-time
 * hash would certify bytes that are no longer on disk. One small file, one read
 * and one SHA per page load, and the tag always names the bytes just served.
 */
app.get('/sw.js', {
  // A strong tag names one representation, so this route is not compressed: the
  // same tag must not label both an identity and a gzip body.
  compress: false,
}, async (req, reply) => {
  let body;
  try {
    body = await fs.promises.readFile(path.join(PUBLIC, 'sw.js'));
  } catch {
    return reply.code(404).send({ error: 'Not found.' });
  }
  const etag = `"sw-${crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)}"`;
  // `no-cache`, not `no-store`: the worker must be revalidated on every check,
  // and the 304 it gets when nothing changed is the cheap answer.
  reply.header('cache-control', 'no-cache').header('etag', etag);
  if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
  return reply.type('text/javascript; charset=utf-8').send(body);
});

// ── auth ────────────────────────────────────────────────────────────────

const REFRESH_COOKIE = 'sonora_refresh';
// One cookie per ceremony. A shared name meant a login ceremony started while a
// registration was open overwrote the registration's challenge cookie, and the
// registration then failed with "that passkey request expired".
const CHALLENGE_COOKIE = 'sonora_webauthn';
const CHALLENGE_COOKIE_REGISTER = 'sonora_webauthn_register';
const CHALLENGE_COOKIE_LOGIN = 'sonora_webauthn_login';

const trim = (value, max = 200) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : null;
};

function currentUser(req) {
  const payload = readSession(req.cookies?.[COOKIE]);
  if (!payload) return null;
  const row = SQL.userById.get(payload.uid);
  if (!row || row.disabled) return null;
  // Stateless sessions are revoked by bumping session_version. Tokens issued
  // before the column existed are treated as version 1 (the migration default),
  // so upgrading does not sign every device out.
  if ((payload.ver ?? 1) !== row.session_version) return null;
  // A session minted after device tracking was added carries the device id. A
  // deleted or revoked device therefore kills every token it ever issued, which
  // is what makes "sign out this device" real on a stateless session.
  if (payload.sid) {
    const device = getDevice(payload.sid);
    if (!device || device.user_id !== row.id || device.revoked_at) return null;
    // last_seen is a coarse presence signal; writing it on every one of a
    // phone's ranged audio requests would be pointless churn.
    if (Date.now() - Date.parse(device.last_seen_at ?? 0) > 5 * 60_000) {
      touchDevice(device.id, { ip: req.ip });
      // "Last seen" in the admin user list was only ever last *login*; this is
      // the same write, throttled inside the db helper so it cannot become a
      // per-request update on the audio path.
      touchUserSeen(row.id);
    }
    return {
      id: row.id, name: row.name, role: row.role,
      deviceId: device.id, remembered: Boolean(device.remembered), exp: payload.exp ?? null,
    };
  }
  return { id: row.id, name: row.name, role: row.role, deviceId: null, remembered: false, exp: payload.exp ?? null };
}

app.decorateRequest('user', null);
app.addHook('onRequest', async (req, reply) => {
  // Baseline hardening on every response (JSON, HTML and static alike). There is
  // deliberately no CSP here: the share/listen pages carry inline styles and the
  // app is an unbundled ES module, so a policy that actually helps is a bigger
  // change than this pass.
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'SAMEORIGIN');
  reply.header('referrer-policy', 'same-origin');
  req.user = currentUser(req);
});

// Cookies are ambient authority. A cross-origin page must not be able to use a
// session, refresh, WebAuthn-challenge or room-guest cookie for a state-changing
// request merely because SameSite happens to permit it (notably sibling sites).
// Origin is authoritative when present; Fetch Metadata covers modern requests
// without one. Legacy/non-browser clients with neither remain supported, while
// the JSON requirement below still excludes every simple HTML form body type.
const API_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_CONTENT_TYPE = /^\s*application\/json\s*(?:;|$)/i;

function hasCredentialCookie(req) {
  const cookies = req.cookies ?? {};
  return Boolean(
    cookies[COOKIE] || cookies[REFRESH_COOKIE] || cookies[CHALLENGE_COOKIE]
    || cookies[CHALLENGE_COOKIE_REGISTER] || cookies[CHALLENGE_COOKIE_LOGIN]
    // The guest constant is declared with the listener implementation below;
    // use its stable wire name here rather than widening this hook's scope.
    || cookies.sonora_guest
  );
}

function requestHasBody(req) {
  // Transfer-Encoding means a body is possible even before its chunks arrive.
  // For Content-Length, zero is deliberately exempt: several legitimate room and
  // auth operations are POSTs with an empty body and no JSON document to declare.
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && /^\d+$/.test(String(length)) && Number(length) > 0;
}

app.addHook('preValidation', async (req, reply) => {
  if (!isApiRequest(req) || !API_MUTATION_METHODS.has(req.method)) return;

  if (hasCredentialCookie(req)) {
    const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') {
      return reply.code(403).send({ error: 'Cross-site request refused.' });
    }

    const origin = req.headers.origin;
    if (origin !== undefined) {
      const expected = requestOrigin(req);
      let actual = null;
      try {
        const parsed = new URL(String(origin));
        if (['http:', 'https:'].includes(parsed.protocol)
          && !parsed.username && !parsed.password && parsed.pathname === '/'
          && !parsed.search && !parsed.hash) actual = parsed.origin;
      } catch {
        // Handled by the comparison below; never reflect the supplied value.
      }
      if (String(origin) === 'null' || !expected || actual !== expected) {
        return reply.code(403).send({ error: 'Request origin does not match.' });
      }
    }
  }

  if (requestHasBody(req) && !JSON_CONTENT_TYPE.test(String(req.headers['content-type'] ?? ''))) {
    return reply.code(415).send({ error: 'JSON request body requires Content-Type: application/json.' });
  }
});

/**
 * JSON API answers are personal and change without a version number: the
 * personal station is rebuilt when a like lands, and a 304 from Fastify's ETag
 * would hand the browser last week's queue. The artwork proxy sets its own long
 * cache headers below, so only /api/ is swept here.
 */
app.addHook('onSend', async (req, reply, payload) => {
  if (!isApiRequest(req)) {
    // A failed public lookup or an unsafe URL is not a cacheable representation.
    // This also covers @fastify/static denials and public-route 429 responses;
    // successful share/art responses keep the explicit policy set by their route.
    if (reply.statusCode >= 400 && reply.getHeader('cache-control') == null) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  }
  // A handler that set its own cache-control made a deliberate decision; this
  // hook runs *after* the route, so it used to silently clobber it with
  // no-store. That broke two things quietly:
  //   * artwork — the proxy sets `private, max-age=86400`, so every cover was
  //     re-fetched on every render (677 image requests for one afternoon, and a
  //     cold grid on every navigation).
  //   * audio — /api/stream sets the same, so the media element could not reuse
  //     any range it had already fetched, and every seek went back over the wire.
  // Everything else stays no-store: personal JSON must not be cached.
  if (reply.getHeader('cache-control') == null) {
    reply.header('cache-control', 'no-store');
  }
  return payload;
});

function requireUser(req, reply) {
  if (!req.user) {
    reply.code(401).send({ error: 'Not signed in.' });
    return null;
  }
  return req.user;
}

/** Admin is a database role, not a client claim: it is read on every request. */
function requireAdmin(req, reply) {
  const user = requireUser(req, reply);
  if (!user) return null;
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'Administrator access required.' });
    return null;
  }
  return user;
}

// ── session & device plumbing ───────────────────────────────────────────

/**
 * The only shape a user is ever sent in. Defined once, here, because it is used
 * by both the auth routes and the admin surface: the admin one needs the extra
 * columns, and two helpers with the same name is a module-level redeclaration.
 */
const publicUser = (u) => (u ? {
  id: u.id,
  name: u.name,
  role: u.role ?? 'user',
  disabled: Boolean(u.disabled),
  createdAt: u.created_at ?? u.createdAt ?? null,
  lastLoginAt: u.last_login_at ?? u.lastLoginAt ?? null,
  lastSeenAt: u.last_seen_at ?? u.lastSeenAt ?? null,
} : null);

const publicDevice = (d) => (d ? {
  id: d.id, name: d.name, platform: d.platform,
  createdAt: d.created_at, lastSeenAt: d.last_seen_at, lastLoginAt: d.last_login_at,
  remembered: Boolean(d.remembered),
} : null);

/**
 * The scheme this request actually arrived on.
 *
 * `req.protocol` is the honest answer for a direct connection; behind a tunnel it
 * is only right when the proxy is trusted, which is exactly what
 * SONORA_TRUST_PROXY says. Shared with rpContext so cookies and passkeys agree
 * about what the public origin is.
 */
function requestProto(req) {
  // Fastify has already applied the authenticated proxy rule, including the
  // immediate-peer check. Never read X-Forwarded-Proto directly here: doing so
  // would trust it even on a direct request from an unlisted address.
  return lastHop(req?.protocol ?? 'http') || 'http';
}

/**
 * The *last* element of a comma-separated proxy header.
 *
 * These headers are append-lists: each proxy adds its own view to the end, so
 * the first element is whatever the *client* sent — free text. Reading `[0]`
 * therefore let a client pick the scheme and host its own session cookies and
 * passkey ceremony were bound to (a broken ceremony and a wrong `Secure` flag
 * rather than account takeover, but both are self-inflicted outages). The last
 * element is the one the trusted hop in front of us appended, which is the only
 * hop whose word this process has any reason to take. With a single proxy the
 * two are the same string, so nothing changes for a normal deployment.
 */
function lastHop(value) {
  return String(value ?? '').split(',').pop().trim();
}

/**
 * The request's actual HTTP origin, with no configured share-card override.
 * Fastify has already decided whether the immediate peer may supply forwarded
 * host/scheme headers. Parsing the pair as a URL both normalizes default ports
 * and rejects a Host containing credentials, a path or other URL syntax.
 */
function requestOrigin(req) {
  const proto = requestProto(req).toLowerCase();
  if (proto !== 'http' && proto !== 'https') return null;
  const host = String(req?.host ?? req?.headers?.host ?? '');
  if (!host) return null;
  try {
    const url = new URL(`${proto}://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The hostname this request was addressed to, minus any port. */
function requestHostname(req) {
  // req.host includes X-Forwarded-Host only when Fastify accepted the peer in
  // SONORA_TRUST_PROXY; ordinary/direct requests expose the actual Host header.
  return hostnameOf(String(req?.host ?? req?.headers?.host ?? ''));
}

// Browsers treat these as secure contexts even over plain HTTP.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Should this response's cookies carry `Secure`?
 *
 * It was `!config.isDev`, i.e. "is a secret configured" — a property of the
 * deployment, never of the request. A container on a LAN serves http://192.168.x.x
 * with a secret configured, so every session cookie was Secure and Chrome threw
 * it away: login answered 200, /api/me answered 401, the form silently reset.
 * Depending on the request instead gives the right answer on HTTPS, on localhost
 * (a secure context) and on a plain-HTTP LAN, with SONORA_SECURE_COOKIES for the
 * setups a request cannot describe.
 */
function cookieSecure(req) {
  if (config.secureCookies === 'always') return true;
  if (config.secureCookies === 'never') return false;
  if (requestProto(req) === 'https') return true;
  const host = requestHostname(req).toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

function baseCookie(req) {
  return { httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), path: '/' };
}

function clearAuthCookies(reply) {
  return reply
    .clearCookie(COOKIE, { path: '/' })
    .clearCookie(REFRESH_COOKIE, { path: '/' })
    .clearCookie(CHALLENGE_COOKIE, { path: '/' })
    .clearCookie(CHALLENGE_COOKIE_REGISTER, { path: '/' })
    .clearCookie(CHALLENGE_COOKIE_LOGIN, { path: '/' });
}

function challengeCookieName(kind) {
  return kind === 'register' ? CHALLENGE_COOKIE_REGISTER : CHALLENGE_COOKIE_LOGIN;
}

function setChallengeCookie(req, reply, id, kind) {
  reply.setCookie(challengeCookieName(kind), id, { ...baseCookie(req), maxAge: 300 });
}

/** Discard the ceremony this browser replaces when it starts another of the same kind. */
function discardSupersededChallenge(req, kind) {
  const ids = new Set([
    req.cookies?.[challengeCookieName(kind)],
    req.cookies?.[CHALLENGE_COOKIE],
  ]);
  for (const id of ids) {
    if (id) SQL.deleteChallenge.run(id, kind);
  }
}

/** A stale body must never clear the cookie belonging to its newer successor. */
function clearChallengeCookie(req, reply, kind, id) {
  if (!id) return;
  const name = challengeCookieName(kind);
  if (req.cookies?.[name] === id) reply.clearCookie(name, { path: '/' });
  if (req.cookies?.[CHALLENGE_COOKIE] === id) {
    reply.clearCookie(CHALLENGE_COOKIE, { path: '/' });
  }
}

function setRefreshCookie(req, reply, { token, expiresAt }) {
  const seconds = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  reply.setCookie(REFRESH_COOKIE, token, { ...baseCookie(req), maxAge: seconds });
}

function inferDeviceName(req) {
  const ua = String(req.headers['user-agent'] ?? '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

/**
 * One browser is one device, even after many sign-ins: the client keeps a
 * localStorage id, and it is the lookup key. Without it the devices list would
 * grow a duplicate row on every login.
 */
function resolveDevice(req, user, remember) {
  const b = req.body ?? {};
  const clientDeviceId = trim(b.deviceId, 64);
  const name = trim(b.deviceName, 60) ?? inferDeviceName(req);
  const platform = trim(b.platform, 40);
  const userAgent = trim(req.headers['user-agent'], 400);
  const ip = trim(req.ip, 60);
  const now = new Date().toISOString();
  const existing = findDeviceByClient(user.id, clientDeviceId);
  if (existing) {
    SQL.updateDeviceOnLogin.run(name, platform, userAgent, now, now, ip, remember ? 1 : 0, existing.id);
    return getDevice(existing.id);
  }
  try {
    return createDevice({ userId: user.id, name, platform, userAgent, clientDeviceId, ip, remembered: remember });
  } catch (err) {
    // Two sign-ins from the same browser can race between the lookup and the
    // insert; the unique index on (user_id, client_device_id) is the backstop.
    // Losing that race is not an error: the winner's row is the device.
    const raced = findDeviceByClient(user.id, clientDeviceId);
    if (raced) return raced;
    throw err;
  }
}

/**
 * Issue the access cookie, and a rotating refresh cookie when the device asked
 * to be remembered. A non-remembered sign-in explicitly revokes any older
 * refresh token for the same device, so "don't remember me" actually forgets.
 *
 * `refresh` lets the caller supply an already-issued token: rotation must revoke
 * the old token *and* hand out its recorded replacement, so issuing a second one
 * here would orphan a live token and break the rotation chain.
 */
function startSession(req, reply, user, device, remember, refresh = null) {
  const ttlMs = config.sessionMinutes * 60_000;
  const token = signSession({
    uid: user.id,
    ver: user.session_version ?? 1,
    sid: device.id,
    exp: Date.now() + ttlMs,
  });
  reply.setCookie(COOKIE, token, {
    ...baseCookie(req),
    ...(remember ? { maxAge: Math.floor(ttlMs / 1000) } : {}),
  });
  if (remember) {
    const issued = refresh ?? issueRefreshToken({
      deviceId: device.id, userId: user.id, ttlMs: config.refreshDays * 86_400_000,
    });
    setRefreshCookie(req, reply, issued);
    setDeviceRemembered(device.id, true);
    return issued;
  }
  revokeDeviceTokens(device.id);
  setDeviceRemembered(device.id, false);
  // A remembered -> session-only sign-in revoked the credential in SQLite but
  // left its cookie in the browser. The next background refresh then looked like
  // a theft attempt rather than the user's explicit "forget this device".
  reply.clearCookie(REFRESH_COOKIE, { path: '/' });
  return null;
}

function deviceForRefreshCookie(req) {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) return null;
  const row = getRefreshToken(hashToken(raw));
  return row ? getDevice(row.device_id) : null;
}

// ── WebAuthn / passkey plumbing ─────────────────────────────────────────

function hostnameOf(hostHeader) {
  // Last hop, not first: see lastHop().
  const raw = lastHop(hostHeader);
  if (!raw) return 'localhost';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.replace(/:\d+$/, '');
}

/**
 * A passkey is scoped to an origin, so the RP ID must be the public hostname.
 * Behind a tunnel Fastify sees the tunnel's own host, which is why
 * SONORA_RP_ID/SONORA_ORIGIN exist; unset, the request host is used, which is right
 * for localhost and a direct HTTPS reverse proxy.
 */
function rpContext(req) {
  // The forwarded headers are consulted only when the proxy is trusted, same
  // as req.ip. A client who can set x-forwarded-host themselves would otherwise
  // poison the RP ID/origin a passkey ceremony is bound to, which is strictly
  // worse than a mis-scoped-but-honest rpID behind an unconfigured proxy: the
  // fix for that case is SONORA_TRUST_PROXY=1, not a client-controlled header.
  // Trusted or not, the value read is the LAST comma-separated element — the one
  // the hop in front of us appended — never the caller's own (see lastHop()).
  const hostname = requestHostname(req);
  const hostHeader = lastHop(req.host ?? req.headers.host) || 'localhost';
  const proto = requestProto(req);
  return {
    rpID: config.rpId ?? hostname,
    origin: config.origin ?? `${proto}://${hostHeader}`,
  };
}

/** An IP address can never be a WebAuthn RP ID, so say that instead of failing mysteriously. */
function passkeySupport(ctx) {
  const rp = String(ctx.rpID ?? '').toLowerCase();
  const isLocalhost = rp === 'localhost' || rp.endsWith('.localhost');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(rp) || rp.includes(':');
  const isDomain = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(rp);
  if (isIp) {
    return {
      supported: false, rpID: ctx.rpID,
      reason: `Passkeys are bound to a domain name, not an IP address. Open sonora at localhost or your HTTPS domain to use one.`,
    };
  }
  if (!isLocalhost && !isDomain) {
    return { supported: false, rpID: ctx.rpID, reason: 'Passkeys need a real domain name (localhost works for local development).' };
  }
  return { supported: true, rpID: ctx.rpID, origin: ctx.origin };
}

function challengeIdFrom(req, kind) {
  const id = trim(req.body?.challengeId, 200);
  const name = challengeCookieName(kind);
  // The legacy shared name is still read so a ceremony started before a deploy
  // (or by an older client) can finish; it is no longer written.
  const cookie = req.cookies?.[name] ?? req.cookies?.[CHALLENGE_COOKIE];
  if (!id || !cookie || id !== cookie) return null;
  return id;
}

/**
 * A stand-in user row for an unknown account name.
 *
 * `findUser()` returning null used to short-circuit the password check, so an
 * unknown name answered in ~0.1 ms and a real one in ~34 ms (one scrypt pass):
 * the login form was an account oracle. Verifying against a fixed hash spends the
 * same work either way.
 */
const TIMING_DUMMY_USER = {
  pass_hash: crypto.scryptSync('sonora-timing-dummy', 'sonora-timing-salt', 32).toString('hex'),
  salt: 'sonora-timing-salt',
};

// ── auth routes ─────────────────────────────────────────────────────────

/** Match the same exact, case-sensitive spelling as SQLite account lookups. */
// Preserve SQLite's case-sensitive account identity. Folding these keys joined
// two distinct accounts (Alice and alice) into one lockout and let failures for
// either lock out the other.
const loginKey = (name) => String(name ?? '').trim().slice(0, 200);

// A wrong-passphrase counter that is independent of the client's address.
//
// The login route is rate-limited per IP, and with SONORA_TRUST_PROXY=1 that
// bucket is whatever X-Forwarded-For the client cares to invent — one header per
// guess. Nothing counted failures *per account*, so the passphrase check was the
// only cost, and scrypt is synchronous: a few thousand guesses is also a few
// thousand event-loop stalls. Five free attempts, then an exponential wait
// (30 s doubling, capped at 15 min) answered as 429 + Retry-After.
//
// Deliberately in memory: a restart clears it (restarting is not a brute-force
// tool), and persisting it would mean a database write on every wrong guess from
// an unauthenticated route — the cheapest possible way to grow the database
// remotely. The name is counted whether or not it exists, so the lockout itself
// says nothing about which accounts are real, and a successful sign-in clears
// the entry so a person who finally remembers their passphrase is not punished
// for it.
const LOGIN_FAIL_FREE = 5;
const LOGIN_LOCK_BASE_MS = 30_000;
const LOGIN_LOCK_MAX_MS = 15 * 60_000;
const LOGIN_FAILURES_MAX = 2048;
const loginFailures = new Map(); // loginKey(name) → { fails, until }

/** Milliseconds until this name may be attempted again; 0 when it may now. */
function loginLockedFor(name) {
  const entry = loginFailures.get(loginKey(name));
  if (!entry?.until) return 0;
  const left = entry.until - Date.now();
  if (left > 0) return left;
  // The wait is over: the count survives one more window so the schedule keeps
  // escalating, but the lock itself only lifts once someone tries again.
  entry.until = 0;
  return 0;
}

function noteLoginFailure(name) {
  const key = loginKey(name);
  const entry = loginFailures.get(key) ?? { fails: 0, until: 0 };
  entry.fails += 1;
  if (entry.fails >= LOGIN_FAIL_FREE) {
    const step = entry.fails - LOGIN_FAIL_FREE;
    entry.until = Date.now() + Math.min(LOGIN_LOCK_BASE_MS * 2 ** step, LOGIN_LOCK_MAX_MS);
  }
  // Bounded: an anonymous client posting a fresh name every second must not be
  // able to grow this map without limit.
  if (!loginFailures.has(key) && loginFailures.size >= LOGIN_FAILURES_MAX) {
    loginFailures.delete(loginFailures.keys().next().value);
  }
  loginFailures.set(key, entry);
}

function clearLoginFailures(name) {
  loginFailures.delete(loginKey(name));
}

app.get('/api/auth/capabilities', async (req) => {
  const ctx = rpContext(req);
  const hasUsers = SQL.userCount.get().n > 0;
  return {
    hasUsers,
    passkeys: passkeySupport(ctx),
    sessionMinutes: config.sessionMinutes,
    refreshDays: config.refreshDays,
    // Whether this *request* would receive Secure cookies. Derived, not
    // configured, so a client can explain "sign-in did nothing" on a plain-HTTP
    // LAN instead of silently dropping the session.
    cookies: { secure: cookieSecure(req), mode: config.secureCookies },
  };
});

app.post('/api/auth/login', {
  // A config knob, not a literal: a test suite that signs in dozens of times is
  // indistinguishable from an attacker at the IP level. This was hardcoded to 10
  // here while `config.loginRateMax` existed and was never read, so auth.test.js
  // raised it to 1000, still got a 429 on the eleventh login, and then reported
  // "session lost" in an unrelated test three cases later.
  config: { rateLimit: { max: config.loginRateMax, timeWindow: config.loginRateWindow } },
}, async (req, reply) => {
  // Clamped like every other user-supplied string: the body limit bounds the
  // size, but a 64 KB name would still be hashed and looked up for nothing.
  const name = String(req.body?.name ?? config.bootstrapUser).trim().slice(0, 200);
  // Per-account lockout, keyed by the name that was *attempted* whether or not
  // it exists (see LOGIN_FAIL_FREE): the IP bucket above is free to rotate with
  // X-Forwarded-For, so it cannot be the only defence against a dictionary run
  // on one account. Checked before the scrypt spend, and answered with
  // Retry-After rather than a silent 401 so a locked-out human knows to wait.
  const lockMs = loginLockedFor(name);
  if (lockMs) {
    reply.header('retry-after', String(Math.ceil(lockMs / 1000)));
    return reply.code(429).send({ error: 'Too many wrong attempts for this account. Try again shortly.' });
  }
  const pass = String(req.body?.passphrase ?? '');
  const user = findUser(name);
  // Same scrypt cost for an unknown name (see TIMING_DUMMY_USER): the response
  // must not say which half of the pair was wrong, in words or in timing.
  const passOk = verifyPassword(user ?? TIMING_DUMMY_USER, pass || ' ');
  if (!user || !pass || !passOk) {
    noteLoginFailure(name);
    return reply.code(401).send({ error: 'Wrong name or passphrase.' });
  }
  clearLoginFailures(name);
  if (user.disabled) {
    return reply.code(403).send({ error: 'This account has been disabled by an administrator.' });
  }
  const remember = req.body?.remember === true;
  const device = resolveDevice(req, user, remember);
  startSession(req, reply, user, device, remember);
  touchLogin(user.id);
  return reply.send({
    user: publicUser(user),
    device: publicDevice(device),
    remembered: remember,
    sessionMinutes: config.sessionMinutes,
  });
});

/**
 * Continue a rotation chain from a token that was *itself* rotated.
 *
 * Rotation is not idempotent, and one browser has more than one tab (the client
 * dedupes per page, and a 200 lost in flight is indistinguishable from theft).
 * Any second presentation of a just-rotated token therefore deleted the device
 * and signed every tab out, with `refresh_replay` in the audit log blaming the
 * user's own browser. Within SONORA_REFRESH_GRACE_MS of the rotation, a replay
 * instead rotates the successor forward and answers 200; outside it, the theft
 * response stands. A chain that ended in a revocation-not-rotation (logout,
 * "sign out everywhere", expiry) is never forgiven.
 *
 * Returns the response body on success, or null to let the caller treat the
 * presentation as a replay.
 */
function rotateWithinGrace(req, reply, row) {
  if (!row?.revoked_at || !row.replaced_by || config.refreshGraceMs <= 0) return null;
  const usedAt = Date.parse(String(row.last_used_at ?? '')) || 0;
  if (!usedAt || Date.now() - usedAt > config.refreshGraceMs) return null;
  const device = getDevice(row.device_id);
  const user = getUser(row.user_id);
  if (!device || device.revoked_at || !user || user.disabled) return null;

  // Walk to the newest link: another tab may already have rotated the
  // successor onward, and the whole chain belongs to this one device.
  let tail = SQL.refreshByHash.get(row.replaced_by);
  if (!tail || tail.device_id !== device.id || tail.user_id !== user.id) return null;
  for (let hops = 0; tail?.replaced_by && hops < 8; hops += 1) {
    const link = SQL.refreshByHash.get(tail.replaced_by);
    if (!link || link.device_id !== device.id) break;
    tail = link;
  }
  if (tail.revoked_at) return null;
  if (new Date(tail.expires_at).getTime() < Date.now()) return null;

  const next = issueRefreshToken({
    deviceId: device.id, userId: user.id, ttlMs: config.refreshDays * 86_400_000,
  });
  if (!consumeRefreshToken(tail.id, next.tokenHash)) {
    revokeRefreshToken(next.id);
    return null;
  }
  touchDevice(device.id, { ip: req.ip, login: true });
  startSession(req, reply, user, device, true, next);
  return { user: publicUser(user), device: publicDevice(device), refreshed: true, rotated: true };
}

/**
 * Exchange a saved device's refresh token for a fresh access token. The token
 * rotates on every use: replaying an already-used token outside the grace window
 * is treated as theft and deletes the device, so both the thief and the
 * legitimate client are locked out and must sign in again.
 */
app.post('/api/auth/refresh', {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) return reply.code(401).send({ error: 'No saved session.' });
  const row = getRefreshToken(hashToken(raw));
  if (!row) {
    return clearAuthCookies(reply).code(401).send({ error: 'That saved session is no longer valid.' });
  }
  if (row.revoked_at) {
    if (!row.replaced_by) {
      // Logout, an explicit forget, expiry and an administrator's revocation are
      // ordinary revoked credentials. Only reuse *inside a rotation chain* is the
      // theft signal; conflating the two let such a cookie delete the device's
      // still-current access session.
      return clearAuthCookies(reply).code(401).send({ error: 'That saved session is no longer valid. Sign in again.' });
    }
    const graced = rotateWithinGrace(req, reply, row);
    if (graced) return graced;
    // Replay of a rotated token outside the window: revoke the whole device
    // rather than trust it.
    deleteDevice(row.device_id);
    recordAudit({ actorId: row.user_id, action: 'refresh_replay', target: row.device_id, detail: 'rotated token reused; device revoked' });
    return clearAuthCookies(reply).code(401).send({ error: 'That saved session was already used. Sign in again.' });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    revokeRefreshToken(row.id);
    return clearAuthCookies(reply).code(401).send({ error: 'That saved session has expired. Sign in again.' });
  }
  const device = getDevice(row.device_id);
  const user = getUser(row.user_id);
  if (!device || device.revoked_at || !user || user.disabled) {
    revokeDeviceTokens(row.device_id);
    return clearAuthCookies(reply).code(401).send({ error: 'That device has been signed out.' });
  }
  const next = issueRefreshToken({
    deviceId: device.id, userId: user.id, ttlMs: config.refreshDays * 86_400_000,
  });
  if (!consumeRefreshToken(row.id, next.tokenHash)) {
    // Lost a race with another tab: that request already rotated the token, so
    // the replacement we just minted is orphaned. That is a race, not theft —
    // take the grace path with the row as it is now, and only revoke when even
    // that is refused.
    revokeRefreshToken(next.id);
    const fresh = getRefreshToken(hashToken(raw));
    const graced = fresh ? rotateWithinGrace(req, reply, fresh) : null;
    if (graced) return graced;
    deleteDevice(device.id);
    recordAudit({ actorId: user.id, action: 'refresh_replay', target: device.id, detail: 'concurrent rotation' });
    return clearAuthCookies(reply).code(401).send({ error: 'That saved session was already used. Sign in again.' });
  }
  touchDevice(device.id, { ip: req.ip, login: true });
  startSession(req, reply, user, device, true, next);
  return { user: publicUser(user), device: publicDevice(device), refreshed: true };
});

app.post('/api/auth/logout', async (req, reply) => {
  const device = req.user?.deviceId ? getDevice(req.user.deviceId) : deviceForRefreshCookie(req);
  if (device) {
    revokeDeviceTokens(device.id);
    deleteDevice(device.id);
  }
  clearAuthCookies(reply);
  return { ok: true };
});

app.get('/api/me', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return {
    user: {
      ...publicUser(user),
      deviceId: user.deviceId,
      remembered: Boolean(user.remembered),
      hasPasskeys: countPasskeys(user.id) > 0,
    },
    // The client schedules its silent refresh from this, so the lifetime is
    // stated in one place (the server) instead of duplicated in the bundle.
    sessionMinutes: config.sessionMinutes,
  };
});

// ── passkeys ────────────────────────────────────────────────────────────

app.get('/api/auth/passkeys', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return { passkeys: listPasskeys(user.id) };
});

app.post('/api/auth/passkey/register/options', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const ctx = rpContext(req);
  const support = passkeySupport(ctx);
  if (!support.supported) return reply.code(400).send({ error: support.reason });
  deleteExpiredChallenges();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: ctx.rpID,
    userName: user.name,
    userID: Buffer.from(`sonora:${user.id}`),
    userDisplayName: user.name,
    attestationType: 'none',
    excludeCredentials: listPasskeyCredentials(user.id),
    // `required`, not `preferred`. A discoverable (resident) key is what lets
    // sign-in work without the server naming an account first — which is the
    // only shape of the login-options answer that does not leak "this name
    // exists". Registering a non-resident credential would create a passkey its
    // owner cannot use on the login screen, because that endpoint no longer
    // sends allowCredentials.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  // One latest ceremony per kind and browser. The old cookie names the exact
  // row to discard; starting again does not leave an orphan until the TTL sweep.
  discardSupersededChallenge(req, 'register');
  const challengeId = createChallenge({
    userId: user.id, kind: 'register', challenge: options.challenge,
    rpId: ctx.rpID, origin: ctx.origin,
  });
  setChallengeCookie(req, reply, challengeId, 'register');
  return { challengeId, options };
});

app.post('/api/auth/passkey/register/verify', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const challengeId = challengeIdFrom(req, 'register');
  const row = challengeId ? takeChallenge(challengeId, 'register') : null;
  clearChallengeCookie(req, reply, 'register', challengeId);
  if (!row || row.user_id !== user.id) {
    return reply.code(400).send({ error: 'That passkey request expired. Try again.' });
  }
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: row.challenge,
      expectedOrigin: row.origin,
      expectedRPID: row.rp_id,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: 'Could not verify that passkey. Try again.' });
    }
    const info = verification.registrationInfo;
    const credential = info.credential;
    const name = trim(req.body?.name, 60) ?? `${inferDeviceName(req)} passkey`;
    const id = createPasskey({
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter ?? 0,
      transports: credential.transports ?? [],
      deviceType: info.credentialDeviceType ?? null,
      backedUp: Boolean(info.credentialBackedUp),
      aaguid: info.aaguid ?? null,
      name,
    });
    recordAudit({ actorId: user.id, actorName: user.name, action: 'passkey_add', target: String(id), detail: name });
    return { passkey: listPasskeys(user.id).find((p) => p.id === id) ?? null };
  } catch (err) {
    req.log.warn({ err: err?.message }, 'passkey registration failed');
    return reply.code(400).send({ error: 'Could not verify that passkey. Try again.' });
  }
});

app.patch('/api/auth/passkeys/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const name = trim(req.body?.name, 60);
  if (!name) return reply.code(400).send({ error: 'Missing name.' });
  if (!renamePasskey(user.id, Number(req.params.id), name)) {
    return reply.code(404).send({ error: 'No such passkey.' });
  }
  return { passkeys: listPasskeys(user.id) };
});

app.delete('/api/auth/passkeys/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const id = Number(req.params.id);
  const target = listPasskeys(user.id).find((p) => p.id === id);
  if (!deletePasskey(user.id, id)) {
    return reply.code(404).send({ error: 'No such passkey.' });
  }
  recordAudit({ actorId: user.id, actorName: user.name, action: 'passkey_remove', target: String(id), detail: target?.name ?? null });
  return { passkeys: listPasskeys(user.id) };
});

app.post('/api/auth/passkey/login/options', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const ctx = rpContext(req);
  const support = passkeySupport(ctx);
  if (!support.supported) return reply.code(400).send({ error: support.reason });
  deleteExpiredChallenges();
  // Discoverable credentials only, and the posted name is ignored.
  //
  // This endpoint used to resolve the name and send that account's
  // `allowCredentials`, which made the *response shape* an oracle: an entry in
  // the list means "this name exists and has a passkey", and its absence means
  // "unknown name" — the account enumeration docs/auth.md says cannot happen.
  // Sending the list only when it is non-empty is what leaked.
  //
  // So the name is a hint the client may collect and the server drops: the
  // picker is the account selector. That works because registration now asks for
  // a resident key (see register/options), which is what makes a credential
  // discoverable without being named first. The answer for an unknown name, a
  // known name and a known name with no passkeys is byte-identical.
  const options = await generateAuthenticationOptions({
    rpID: ctx.rpID,
    userVerification: 'required',
  });
  discardSupersededChallenge(req, 'authenticate');
  const challengeId = createChallenge({
    userId: null, kind: 'authenticate', challenge: options.challenge,
    rpId: ctx.rpID, origin: ctx.origin,
  });
  setChallengeCookie(req, reply, challengeId, 'authenticate');
  return { challengeId, options };
});

app.post('/api/auth/passkey/login/verify', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const challengeId = challengeIdFrom(req, 'authenticate');
  const row = challengeId ? takeChallenge(challengeId, 'authenticate') : null;
  clearChallengeCookie(req, reply, 'authenticate', challengeId);
  if (!row) return reply.code(400).send({ error: 'That passkey request expired. Try again.' });

  const response = req.body?.response;
  const credentialId = trim(response?.id, 400) ?? trim(response?.rawId, 400);
  const passkey = credentialId ? getPasskeyByCredentialId(credentialId) : null;
  if (!passkey || (row.user_id && row.user_id !== passkey.user_id)) {
    return reply.code(401).send({ error: 'That passkey is not registered here.' });
  }
  const user = getUser(passkey.user_id);
  if (!user || user.disabled) {
    return reply.code(403).send({ error: 'This account has been disabled by an administrator.' });
  }
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: row.origin,
      expectedRPID: row.rp_id,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, 'base64url'),
        // Synced (backed-up) credentials — iCloud Keychain, Google Password
        // Manager — re-derive their counter on a new device, so a strict
        // monotonic check "works today and never again" on the only passkey the
        // user owns. @simplewebauthn/server rejects a non-advancing counter by
        // throwing; handing it 0 for a backed-up credential disables that check
        // for exactly those, and the counter is still stored from the response.
        counter: passkey.backed_up ? 0 : (passkey.counter ?? 0),
        transports: passkey.transports ? passkey.transports.split(',').filter(Boolean) : undefined,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return reply.code(401).send({ error: 'That passkey did not verify.' });
    }
    const authInfo = verification.authenticationInfo;
    updatePasskeyUse(passkey.id, authInfo.newCounter ?? 0, {
      deviceType: authInfo.credentialDeviceType ?? null,
      backedUp: Boolean(authInfo.credentialBackedUp),
    });
    const remember = req.body?.remember === true;
    const device = resolveDevice(req, user, remember);
    startSession(req, reply, user, device, remember);
    touchLogin(user.id);
    return { user: publicUser(user), device: publicDevice(device), remembered: remember };
  } catch (err) {
    const message = String(err?.message ?? '');
    // The library's own clone signal. Surfaced distinctly (and audited) instead
    // of as the generic "did not verify", which read as "your passkey broke".
    if (/counter value .* was lower than expected/i.test(message)) {
      recordAudit({ actorId: user.id, actorName: user.name, action: 'passkey_replay', target: String(passkey.id), detail: 'counter did not advance' });
      return reply.code(401).send({ error: 'That passkey looks cloned. Use another sign-in method.' });
    }
    req.log.warn({ err: message }, 'passkey authentication failed');
    return reply.code(401).send({ error: 'That passkey did not verify.' });
  }
});

// ── account security (devices & sessions) ───────────────────────────────

app.get('/api/auth/security', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const ctx = rpContext(req);
  return {
    user: publicUser(user),
    currentDeviceId: user.deviceId,
    remembered: Boolean(user.remembered),
    expiresAt: user.exp ?? null,
    session: { accessMinutes: config.sessionMinutes, refreshDays: config.refreshDays },
    passkeys: listPasskeys(user.id),
    devices: listDevices(user.id).map((d) => ({ ...d, current: d.id === user.deviceId })),
    capabilities: passkeySupport(ctx),
  };
});

app.patch('/api/auth/devices/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const id = req.params.id;
  const device = getDevice(id);
  if (!device || device.user_id !== user.id || device.revoked_at) {
    return reply.code(404).send({ error: 'No such device.' });
  }
  const name = trim(req.body?.name, 60);
  // "Remember this device" must be reversible after the fact: a laptop signed in
  // on a borrowed network can be dropped back to a session-only login without
  // signing out and back in.
  //
  // Both directions are implemented, because `{remembered: true}` used to pass
  // validation, rename nothing, revoke nothing and answer 200 with the device
  // still remembered:false — a success response for a change that never
  // happened, which later reads as "remember me randomly turned itself off".
  // Re-enabling mints exactly what a remembered sign-in would have: a refresh
  // token for that device and a persistent access cookie.
  const remembered = typeof req.body?.remembered === 'boolean' ? req.body.remembered : null;
  if (remembered === true && id !== user.deviceId) {
    // This response cannot deliver a cookie to another browser. Minting an
    // undelivered token used to claim that device was remembered, leaving the
    // other browser signed out and accumulating unusable token rows.
    return reply.code(409).send({
      error: 'That device must enable “remember me” while it is signed in.',
    });
  }
  if (!name && remembered === null) return reply.code(400).send({ error: 'Nothing to change.' });
  if (name) renameDevice(user.id, id, name);
  if (remembered === true) {
    // This device: the cookies in this very response carry the change. The
    // cross-device case returned 409 above because this browser cannot deliver
    // a refresh cookie to another browser.
    //
    // The *full* user row, not the session view: startSession stamps the token
    // with `session_version`, and currentUser's shape does not carry it, so the
    // fallback of 1 would mint a cookie this account's own version check rejects
    // (it is > 1 after any "sign out everywhere").
    startSession(req, reply, getUser(user.id) ?? user, device, true);
    recordAudit({ actorId: user.id, actorName: user.name, action: 'device_remember', target: id });
  }
  if (remembered === false) {
    revokeDeviceTokens(id);
    setDeviceRemembered(id, false);
    // For this device, the access cookie must also stop being persistent, or
    // "forgotten" would still survive a browser restart.
    if (id === user.deviceId) {
      reply.setCookie(COOKIE, signSession({
        uid: user.id,
        ver: getUser(user.id)?.session_version ?? 1,
        sid: id,
        exp: Date.now() + config.sessionMinutes * 60_000,
      }), baseCookie(req));
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    }
    recordAudit({ actorId: user.id, actorName: user.name, action: 'device_forget', target: id });
  }
  return { devices: listDevices(user.id).map((d) => ({ ...d, current: d.id === user.deviceId })) };
});

app.delete('/api/auth/devices/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const id = req.params.id;
  if (!deleteDeviceForUser(user.id, id)) {
    return reply.code(404).send({ error: 'No such device.' });
  }
  recordAudit({ actorId: user.id, actorName: user.name, action: 'device_revoke', target: id, detail: id === user.deviceId ? 'self' : 'other' });
  if (id === user.deviceId) {
    clearAuthCookies(reply);
    return { signedOut: true };
  }
  return { devices: listDevices(user.id).map((d) => ({ ...d, current: d.id === user.deviceId })) };
});

/**
 * Sign out every *other* device. session_version is bumped so tokens that
 * predate device tracking are invalidated too, then this device is handed a
 * fresh access cookie carrying the new version.
 */
app.post('/api/auth/devices/revoke-others', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  bumpSessionVersion(user.id);
  const removed = deleteOtherDevices(user.id, user.deviceId);
  recordAudit({ actorId: user.id, actorName: user.name, action: 'devices_revoke_others', detail: `${removed} device(s)` });
  const fresh = getUser(user.id);
  const device = user.deviceId ? getDevice(user.deviceId) : null;
  if (!device) {
    clearAuthCookies(reply);
    return { signedOut: true, revoked: removed };
  }
  startSession(req, reply, fresh, device, Boolean(device.remembered));
  return { revoked: removed, device: publicDevice(device) };
});

/** Sign out everywhere, including this device. */
app.post('/api/auth/signout-all', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  bumpSessionVersion(user.id);
  revokeAllRefreshTokens(user.id);
  const removed = deleteAllDevices(user.id);
  clearAuthCookies(reply);
  recordAudit({ actorId: user.id, actorName: user.name, action: 'signout_all', detail: `${removed} device(s)` });
  return { signedOut: true, revoked: removed };
});
// ── discovery ───────────────────────────────────────────────────────────

// Every type a search can be asked for. The client offers these as tabs, and
// each one names a shelf that can be looked up on its own.
const SEARCH_TYPES = new Set(['all', 'song', 'album', 'artist', 'playlist']);
const SEARCH_LIMITS = { song: 20, artist: 4, album: 12, playlist: 8 };
const SEARCH_TTL_MS = 3 * 60_000;
// A normal search All request creates four shelf rows. These bounds stop an
// account turning arbitrary q strings into a permanent, unbounded SQLite cache.
const SEARCH_CACHE_MAX_ROWS = 256;
const SEARCH_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const SEARCH_QUERY_MAX = 24;
const SEARCH_QUERY_WINDOW_MS = 60_000;
const searchQueryBudget = new Map(); // userId -> { resetAt, queries: Set<string> }

class SearchQueryLimitError extends Error {
  constructor(retryAfterMs) {
    super('Too many distinct search queries.');
    this.code = 'SEARCH_RATE_LIMITED';
    this.retryAfterMs = retryAfterMs;
  }
}

const canonicalSearchQuery = (q) => String(q).normalize('NFKC').toLowerCase();

/** Charge a new cache-miss query once per account/window, not once per shelf. */
function searchQueryAllowed(userId, q) {
  const now = Date.now();
  let bucket = searchQueryBudget.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { resetAt: now + SEARCH_QUERY_WINDOW_MS, queries: new Set() };
  }
  const key = canonicalSearchQuery(q);
  if (bucket.queries.has(key)) {
    searchQueryBudget.delete(userId);
    searchQueryBudget.set(userId, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.queries.size >= SEARCH_QUERY_MAX) {
    return { allowed: false, retryAfterMs: Math.max(1, bucket.resetAt - now) };
  }
  bucket.queries.add(key);
  searchQueryBudget.delete(userId);
  searchQueryBudget.set(userId, bucket);
  // The accounts themselves are durable; this in-memory bookkeeping need not be.
  if (searchQueryBudget.size > 512) searchQueryBudget.delete(searchQueryBudget.keys().next().value);
  return { allowed: true, retryAfterMs: 0 };
}

// Every statement is explicitly range-limited. In particular, adding cache
// pressure must never evict a personal station or a six-hour lyrics answer.
const SEARCH_CACHE_SQL = {
  expired: db.prepare(`DELETE FROM upstream_cache
    WHERE key >= 'search:' AND key < 'search:\uFFFF' AND expires_at <= ?`),
  stats: db.prepare(`SELECT COUNT(*) AS rows,
      COALESCE(SUM(LENGTH(CAST(key AS BLOB)) + LENGTH(CAST(value AS BLOB))), 0) AS bytes
    FROM upstream_cache WHERE key >= 'search:' AND key < 'search:\uFFFF'`),
  excessRows: db.prepare(`DELETE FROM upstream_cache WHERE key IN (
      SELECT key FROM upstream_cache
      WHERE key >= 'search:' AND key < 'search:\uFFFF'
      ORDER BY expires_at ASC, key ASC LIMIT ?
    )`),
  oldest: db.prepare(`SELECT key,
      LENGTH(CAST(key AS BLOB)) + LENGTH(CAST(value AS BLOB)) AS bytes
    FROM upstream_cache WHERE key >= 'search:' AND key < 'search:\uFFFF'
    ORDER BY expires_at ASC, key ASC LIMIT 1`),
  deleteKey: db.prepare(`DELETE FROM upstream_cache
    WHERE key >= 'search:' AND key < 'search:\uFFFF' AND key = ?`),
};

/** Expire and evict inside the caller's transaction, only in the search range. */
function pruneSearchCache(now = Date.now()) {
  SEARCH_CACHE_SQL.expired.run(now);
  let stats = SEARCH_CACHE_SQL.stats.get();
  if (stats.rows > SEARCH_CACHE_MAX_ROWS) {
    SEARCH_CACHE_SQL.excessRows.run(stats.rows - SEARCH_CACHE_MAX_ROWS);
    stats = SEARCH_CACHE_SQL.stats.get();
  }
  while (stats.bytes > SEARCH_CACHE_MAX_BYTES) {
    const oldest = SEARCH_CACHE_SQL.oldest.get();
    if (!oldest) break;
    SEARCH_CACHE_SQL.deleteKey.run(oldest.key);
    stats = { rows: stats.rows - 1, bytes: stats.bytes - oldest.bytes };
  }
}

function cacheSearchGroup(key, items) {
  // A failed bound or serialization rolls back the cache write as well: a
  // failed request must not leave an answer that the next caller mistakes for
  // a successful empty shelf.
  transaction(() => {
    cacheSet(key, items, SEARCH_TTL_MS);
    pruneSearchCache();
  });
}

// Two requests for the same shelf (a double-tap on Search, two tabs, the client
// re-rendering) would both miss the cache and both hit YouTube. One upstream
// call per query/type is enough: the second request waits on the first.
const searchInFlight = new Map();

/**
 * One upstream call per key, even when the same thing is asked for twice at once.
 *
 * A cache cannot answer the second of two simultaneous misses — both callers
 * look before either has filled it — so the in-flight map is what actually
 * collapses them. The entry is removed as soon as the work settles (a rejection
 * included), so the next caller retries instead of waiting on a dead promise.
 * Keyed by request shape, shared by every route that can be double-tapped.
 */
function coalesce(inFlight, key, load) {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = (async () => load())().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

/**
 * Upstream failures a listener can act on, mapped once instead of per route.
 *
 * These routes used to let a YouTube failure fall into the global error handler,
 * which answers `500 Internal error.` — so Play-radio during a bot-gate/outage
 * reported a server bug, the client's bot-gate UI never fired, and a dead
 * album/playlist id looked like a crash rather than "that release does not
 * exist". The classification is by message because youtube.js throws plain
 * Errors; anything unrecognised stays a 502 (upstream), never a 500 (us).
 */
const UPSTREAM_BOT_GATE = /sign in to confirm|not a bot|login_required|bot gate/i;
const UPSTREAM_TIMEOUT = /timed out|timeout|aborted/i;
const UPSTREAM_MISSING = /\bnot found\b|does not exist|unavailable|404/i;
const UPSTREAM_RATE_LIMIT = /\b429\b|too many requests|rate[- ]limit/i;

/** Sanitize an upstream error once; partial search responses use the same body. */
function classifyUpstreamFailure(err, label) {
  // searchTracks deliberately aggregates two independent source outages. Route
  // classification must look through that wrapper instead of downgrading a
  // shared timeout or policy block to an unhelpful generic 502.
  const causes = [err, ...(Array.isArray(err?.errors) ? err.errors : [])].filter(Boolean);
  const message = causes.map((cause) => String(cause?.message ?? '')).join('; ');
  const statuses = causes.map((cause) => Number(
    cause?.response?.status ?? cause?.status ?? cause?.statusCode,
  ));
  const retry = causes.map((cause) => Number(cause?.retryAfterMs))
    .find((ms) => Number.isFinite(ms) && ms > 0) ?? null;
  if (UPSTREAM_BOT_GATE.test(message)) {
    // Same signal /api/stream raises, so one bot-gate banner covers every route.
    botGateAt = Date.now();
    return {
      status: 503,
      retryAfterMs: retry,
      body: {
        error: 'YouTube is blocking this IP until a sign-in is provided. Set SONORA_YTDLP_COOKIES.',
        code: 'BOT_GATED',
      },
    };
  }
  if (causes.some((cause) => cause?.code === 'YT_BLOCKED')
    || statuses.includes(429) || UPSTREAM_RATE_LIMIT.test(message)) {
    return {
      status: 503,
      retryAfterMs: retry,
      body: { error: `YouTube is rate-limiting ${label}. Try again shortly.`, code: 'UPSTREAM_RATE_LIMITED' },
    };
  }
  if (UPSTREAM_TIMEOUT.test(message)
    || causes.some((cause) => cause?.name === 'TimeoutError' || cause?.name === 'AbortError' || cause?.code === 'YT_TIMEOUT')) {
    return {
      status: 503,
      retryAfterMs: retry,
      body: { error: `YouTube did not answer for ${label}. Try again.`, code: 'UPSTREAM_TIMEOUT' },
    };
  }
  if (UPSTREAM_MISSING.test(message) || statuses.includes(404)) {
    return { status: 404, retryAfterMs: retry, body: { error: `YouTube has no ${label} for that id.`, code: 'NOT_FOUND' } };
  }
  return {
    status: 502,
    retryAfterMs: retry,
    body: { error: `Could not load ${label} from YouTube.`, code: 'UPSTREAM_FAILED' },
  };
}

function sendUpstreamFailure(reply, failure) {
  if (failure.retryAfterMs) {
    reply.header('retry-after', String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))));
  }
  return reply.code(failure.status).send(failure.body);
}

function upstreamFailure(reply, err, label) {
  return sendUpstreamFailure(reply, classifyUpstreamFailure(err, label));
}

/**
 * One type's worth of a search answer, cached on its own.
 *
 * A tab switch uses the answer from the same request, but typing the same query
 * again (or a second client asking) must not hammer YouTube: a few minutes of
 * cache is enough, since a search answer is not personal. The key carries the
 * query, the type and the limit, so a 4-artist shelf and a longer one cannot be
 * served from each other's slot.
 *
 * Returns `{ items, cached }` because the caller has side effects to skip. Only
 * the request that actually invoked YouTube is uncached; a coalesced follower
 * must not repeat the same transaction after awaiting the leader's answer.
 *
 * Failures are deliberately *not* cached: loading precedes the transaction that
 * stores a resolved shelf. A rejected load therefore retries on the next call.
 */
async function searchGroup(type, q, userId, load) {
  const normalizedQuery = canonicalSearchQuery(q);
  const key = `search:${type}:${SEARCH_LIMITS[type]}:${normalizedQuery}`;
  const hit = cacheGet(key);
  // [] is a successful cache hit too; do not use its length as success evidence.
  if (hit !== null) return { items: hit, cached: true };
  let loadedHere = false;
  const items = await coalesce(searchInFlight, key, async () => {
    const allowance = searchQueryAllowed(userId, q);
    if (!allowance.allowed) throw new SearchQueryLimitError(allowance.retryAfterMs);
    loadedHere = true;
    const loaded = await load();
    cacheSearchGroup(key, loaded);
    return loaded;
  });
  return { items, cached: !loadedHere };
}

/**
 * One search request answers all four shelves.
 *
 * The client's All / Songs / Albums / Artists / Playlists tabs switch locally,
 * so the request has to carry every shelf it might show. The lookups are
 * independent and run in parallel; each one is caught on its own, because a
 * rate-limited album shelf must not cost the listener their songs. `type`
 * narrows which shelves are actually looked up, but the response shape never
 * changes — only its `counts` say what was asked for.
 */
app.get('/api/search', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const q = String(req.query?.q ?? '').trim().slice(0, 200);
  if (!q) return reply.code(400).send({ error: 'Missing q.' });
  const type = String(req.query?.type ?? 'all').trim().toLowerCase() || 'all';
  if (!SEARCH_TYPES.has(type)) return reply.code(400).send({ error: 'Unknown type.' });
  const wants = (t) => type === 'all' || type === t;

  // Keep the rejection as data. Empty items alone cannot distinguish a failed
  // shelf from a successful search with no matches, which made total upstream
  // outages look like a cacheable 200 answer. Unrequested shelves stay inert.
  const shelf = (t, load) => (wants(t)
    ? searchGroup(t, q, user.id, load).then(
      (result) => ({ ...result, ok: true }),
      (error) => ({ items: [], cached: true, ok: false, error }),
    )
    : Promise.resolve({ items: [], cached: true, ok: true }));

  const [songs, artists, albums, playlists] = await Promise.all([
    shelf('song', () => searchTracks(q, SEARCH_LIMITS.song)),
    shelf('artist', () => searchArtists(q, SEARCH_LIMITS.artist)),
    shelf('album', () => searchAlbums(q, SEARCH_LIMITS.album)),
    shelf('playlist', () => searchPlaylists(q, SEARCH_LIMITS.playlist)),
  ]);
  const requested = [
    { type: 'song', field: 'tracks', label: 'song search', result: songs },
    { type: 'artist', field: 'artists', label: 'artist search', result: artists },
    { type: 'album', field: 'albums', label: 'album search', result: albums },
    { type: 'playlist', field: 'playlists', label: 'playlist search', result: playlists },
  ].filter(({ type: shelfType }) => wants(shelfType));
  const failed = requested.filter(({ result }) => !result.ok);
  for (const failure of failed) {
    const err = failure.result.error;
    req.log.warn({
      shelf: failure.type,
      err: err?.message ?? String(err),
      causes: Array.isArray(err?.errors) ? err.errors.map((cause) => cause?.message ?? String(cause)) : undefined,
    }, 'search shelf failed');
  }

  if (failed.length === requested.length) {
    const limited = failed.find(({ result }) => result.error instanceof SearchQueryLimitError);
    if (limited) {
      const retryAfterMs = limited.result.error.retryAfterMs;
      reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return reply.code(429).send({
        error: 'Too many different searches. Listen for a minute or repeat a recent search.',
        code: 'SEARCH_RATE_LIMITED',
      });
    }
    // One classified failure for the request, rather than four empty arrays.
    // Prefer an actionable policy/timeout signal over a generic shelf failure;
    // otherwise which error the listener saw would depend on shelf ordering.
    const priority = {
      BOT_GATED: 0, UPSTREAM_RATE_LIMITED: 1, UPSTREAM_TIMEOUT: 2,
      UPSTREAM_FAILED: 3, NOT_FOUND: 4,
    };
    const selected = failed.map((failure) => classifyUpstreamFailure(failure.result.error, 'search results'))
      .sort((a, b) => (priority[a.body.code] ?? 5) - (priority[b.body.code] ?? 5))[0];
    return sendUpstreamFailure(reply, selected);
  }

  const errors = {};
  for (const failure of failed) {
    const err = failure.result.error;
    errors[failure.field] = err instanceof SearchQueryLimitError
      ? { error: 'Too many different searches. Try this shelf again shortly.', code: 'SEARCH_RATE_LIMITED' }
      : classifyUpstreamFailure(err, failure.label).body;
  }

  const tracks = songs.items;

  // Exactly one caller of a cold coalesced search owns this transaction. Cached
  // answers and followers only read its result; neither commits the rows again.
  if (!songs.cached && tracks.length) transaction(() => { for (const t of tracks) upsertTrack(t); });

  const artistItems = artists.items.map(({ id, title, subscribers, thumb }) => ({ id, title, subscribers, thumb }));
  // `type` here is the shelf the row belongs to, not the release format: the
  // client renders both album and single rows with the same collection route.
  const albumItems = albums.items.map(({ id, title, author, year, trackCount, thumb }) => ({
    id, title, author: author ?? null, year: year ?? null, trackCount: trackCount ?? null, thumb, type: 'Album',
  }));
  const playlistItems = playlists.items.map(({ id, title, author, trackCount, thumb }) => ({
    id, title, author: author ?? null, trackCount: trackCount ?? null, thumb, type: 'Playlist',
  }));

  return {
    q,
    tracks,
    artists: artistItems,
    albums: albumItems,
    playlists: playlistItems,
    counts: {
      tracks: tracks.length,
      artists: artistItems.length,
      albums: albumItems.length,
      playlists: playlistItems.length,
    },
    ...(Object.keys(errors).length ? { errors } : {}),
  };
});

app.get('/api/radio', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const seed = String(req.query?.seed ?? '');
  if (!VIDEO_ID.test(seed)) return reply.code(400).send({ error: 'Bad seed video id.' });
  // A dislike is a standing instruction: never hand one back in a station.
  const disliked = dislikedIds(user.id);
  const songs = dislikedSongKeys(user.id);
  let related;
  try {
    related = await upNext(seed);
  } catch (err) {
    // Play-radio is the most-pressed button in the app, so a bot-gate or an
    // upstream timeout here must reach the client as such: a bare 500 read as a
    // server bug and never triggered the bot-gate banner.
    req.log.warn({ seed, err: err.message }, 'radio lookup failed');
    return upstreamFailure(reply, err, 'that seed');
  }
  const tracks = related
    .filter((t) => !disliked.has(t.videoId))
    .filter((t) => !songs.has(songKey({ ...t, itemType: 'song' })));
  transaction(() => { for (const t of tracks) upsertTrack(t); });
  return { tracks };
});

/**
 * Everything the station refuses to hand back, in one place.
 *
 * A dislike is permanent and about the *song* (see dislikedSongKeys). A track
 * the listener keeps skipping is refused too, but only while nothing
 * contradicts that — see rejectedBySkip. Both must be re-read on every request:
 * the whole point of the station is that it changes as the person listens.
 */
function stationRefusals(userId) {
  const candidates = stationCandidates(userId);
  const rejected = rejectedBySkip(candidates.plays);
  // A like outranks a skip. Someone who hearted a song and then bailed out of
  // an advert-laden upload of it still wants the song, so the station may
  // re-offer it (and it seeds).
  for (const l of candidates.likes) rejected.delete(l?.videoId);
  return {
    candidates,
    disliked: dislikedIds(userId),
    dislikedSongs: dislikedSongKeys(userId),
    rejected,
  };
}

/**
 * One page of the station, given the evidence and how far it has travelled.
 *
 * `cursor` is what makes the station endless rather than a 30-song loop: each
 * extension starts from a different seed, so the recommendations differ, and
 * the evidence is re-read every time — so a song this person fell for *on the*
 * station becomes a seed for a later page. `exclude` is everything already
 * delivered, so nothing is offered twice. `includeSeeds` is on for the first
 * page only (it opens with songs of yours) and off for every extension, which
 * is pure discovery.
 *
 * Four lanes feed the page, and the plan says how many of each it wants:
 *
 *   sameArtist  the up-next graph of each seed. This is the taste, and it is
 *               also the reason the station used to be an artist loop: ask
 *               YouTube "more like this" and half the answer is the same band.
 *               It is capped per artist (see buildStation), not dropped.
 *   adjacent    the seed artist's own *neighbours* — "fans also like" — whose
 *               songs are pulled from the catalogue. A new name that the taste
 *               graph itself vouches for.
 *   trending    well-played songs in the same lane, from a catalogue search of
 *               the artist's genre/decade words. Capped to a couple per page so
 *               the station never turns into a chart.
 *   artists     the artist pool (what this person keeps coming back to), kept
 *               from before: it is where a familiar artist's deep cuts come
 *               from when the up-next list is all hits already heard.
 *
 * Every lane is best-effort: a failed lookup returns an empty pool and the
 * planner fills from the others. A station that is a little more familiar beats
 * a station that does not load.
 */
/** Keep a best-effort lane's empty answer distinct from its failure. */
async function stationPool(load) {
  try {
    return { tracks: (await load()) ?? [], failed: false };
  } catch {
    return { tracks: [], failed: true };
  }
}

async function stationPageAttempt(userId, {
  cursor = 0, exclude = new Set(), limit = STATION_LIMIT, includeSeeds = true,
} = {}) {
  cursor = normalizeStationCursor(cursor);
  const { candidates, disliked, dislikedSongs, rejected } = stationRefusals(userId);
  const seeds = rankSeeds({ ...candidates, disliked, dislikedSongs });
  if (!seeds.length) return { seeds, tracks: [] };

  const plan = planPage({ limit, includeSeeds });
  const picked = rotateSeeds(seeds, { cursor, count: 3 });
  // The artist pool rotates on its own count so it does not stay pinned to the
  // same two artists while the seed cursor walks the list.
  const artistNames = rotateArtists(stationArtists(userId, 6), { cursor, count: 2 })
    .map((a) => a.name);

  // The artists this person actually plays: the definition of "familiar" for
  // the whole page. Which band is capped hardest is keyed off `seedArtists`
  // below, not this set — see the seed cap in station.js.
  //
  // Normalised once, here. adjacentProfile compares `artistKeyOf(a.name)`
  // (lower-case, punctuation-free) against this set, so a set of raw channel
  // strings never matched: every artist with a capital letter or a space was
  // "new", and the discovery lane kept re-offering names the listener already
  // plays. station.js normalises again internally, which is idempotent.
  const knownArtists = new Set(
    allStationArtistNames(userId).map((a) => artistKeyOf(a)).filter(Boolean),
  );
  const seedArtists = new Set(seeds.map((s) => String(s.channel ?? '')).filter(Boolean));

  // Two stages on purpose: the genre lane's vote needs the neighbours the
  // adjacent lane discovers. It does not wait for their *catalogues*, though —
  // the vote starts the moment the artist pages name them.
  let resolveNeighbours;
  const neighboursReady = new Promise((resolve) => { resolveNeighbours = resolve; });
  const trendingPending = neighboursReady
    .then((names) => trendingPool(seeds, names, plan.fetch.trending))
    .catch(() => []);

  const [relatedPools, artistPools, adjacent] = await Promise.all([
    Promise.all(picked.map((s) => stationPool(() => upNext(s.videoId, 25)))),
    Promise.all(artistNames.map((a) => stationPool(() => searchTracks(a, 12)))),
    adjacentProfile(picked, knownArtists, plan.fetch.adjacent, { onNeighbours: resolveNeighbours }),
  ]);
  const related = relatedPools.map((pool) => pool.tracks);
  const byArtist = artistPools.map((pool) => pool.tracks);
  // A lane with no artist pages to read never calls back; resolve it anyway so
  // the trending lane cannot wait forever.
  resolveNeighbours([]);

  // Split the up-next results by whether this person already knows the artist.
  // The familiarity of a *recommendation* is the useful distinction here, not
  // where it was fetched from: YouTube's "more like this" list for one song is
  // half the same band (familiar) and half the neighbouring scene (new).
  // Routing them apart is what stops the familiar lane from silently owning the
  // page — and it costs no extra request, which the neighbour lookups do.
  const knownKey = knownArtists;
  const familiarRecs = [];
  const newRecs = [];
  for (const t of [...related, ...byArtist].flat()) {
    const key = artistKeyOf(t?.channel ?? t?.artist);
    (knownKey.has(key) && key ? familiarRecs : newRecs).push(t);
  }

  const trending = await trendingPending;

  // A seed already heard is only re-queued on the *first* page, where it is the
  // point (the station opens with something recognisable). Later pages are for
  // discovery, so they deliver recommendations only — and they also refuse the
  // seeds themselves and anything this person keeps skipping, so "endless"
  // never degenerates into handing back the history.
  const seen = new Set(exclude);
  for (const id of rejected) seen.add(id);
  if (!includeSeeds) for (const s of seeds) seen.add(s.videoId);

  const tracks = buildStation({
    seeds: includeSeeds ? picked : [],
    expansions: [
      withLane(familiarRecs, 'sameArtist'),
      // Two discovery sources, both one step from the taste: the unfamiliar
      // half of the up-next graph, and the catalogue of the neighbours the
      // artist pages name. The first is closer to a specific song, the second
      // to a whole band.
      withLane([...newRecs, ...adjacent.tracks], 'adjacent'),
      withLane(trending, 'trending'),
    ],
    disliked,
    dislikedSongs,
    exclude: seen,
    knownArtists,
    seedArtists,
    plan,
    limit,
    // The cursor is what makes a Rebuild a different draw. Without it every
    // expansion pool is read in the same order, so the same candidates hit the
    // same per-artist caps and the page comes back as a permutation of itself.
    cursor,
  });

  // Every track the page delivers is also evidence for the next one: playing
  // one of these through makes its artist familiar, which is what lets the
  // station follow the listener somewhere new.
  transaction(() => { for (const t of tracks) upsertTrack(t); });
  const failures = [...relatedPools, ...artistPools].filter((pool) => pool.failed).length
    + adjacent.failed;
  const healthyCandidates = [...relatedPools, ...artistPools]
    .some((pool) => !pool.failed && pool.tracks.length > 0)
    || (adjacent.attempted > adjacent.failed && adjacent.tracks.length > 0);
  // A failed page cannot prove that this seed is exhausted. Advance only after
  // a genuinely healthy empty draw, or after a healthy lane supplied candidates
  // which the queue's exclusion/refusal rules then consumed.
  const retry = tracks.length === 0 && failures > 0 && !healthyCandidates;
  return { seeds, tracks, lanes: laneSummary(tracks), retry };
}

/**
 * Never publish an attempt whose evidence changed across an upstream await.
 * Three retries suffice for ordinary concurrent writes without letting a busy
 * listener create an unbounded rebuild loop. The bounded fallback re-reads the
 * latest refusals and re-plans the last candidate pools locally; if even that
 * is racing, the route's final epoch check still controls caching.
 */
async function stationPage(userId, options = {}) {
  let page;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const epoch = stationEpoch(userId);
    page = await stationPageAttempt(userId, options);
    if (stationEpoch(userId) === epoch) return { ...page, epoch };
  }

  const { candidates, disliked, dislikedSongs, rejected } = stationRefusals(userId);
  const seeds = rankSeeds({ ...candidates, disliked, dislikedSongs });
  if (!seeds.length) return { seeds, tracks: [], epoch: stationEpoch(userId), retry: false };
  const cursor = normalizeStationCursor(options.cursor ?? 0);
  const limit = options.limit ?? STATION_LIMIT;
  const includeSeeds = options.includeSeeds ?? true;
  const seen = new Set(options.exclude ?? []);
  for (const id of rejected) seen.add(id);
  if (!includeSeeds) for (const seed of seeds) seen.add(seed.videoId);
  const picked = rotateSeeds(seeds, { cursor, count: 3 });
  const tracks = buildStation({
    seeds: includeSeeds ? picked : [],
    expansions: ['sameArtist', 'adjacent', 'trending'].map((lane) => withLane(
      page.tracks.filter((track) => track.lane === lane), lane,
    )),
    disliked, dislikedSongs, exclude: seen,
    knownArtists: new Set(allStationArtistNames(userId).map((a) => artistKeyOf(a)).filter(Boolean)),
    seedArtists: new Set(seeds.map((s) => String(s.channel ?? '')).filter(Boolean)),
    plan: planPage({ limit, includeSeeds }), limit, cursor,
  });
  return {
    seeds, tracks, lanes: laneSummary(tracks), epoch: stationEpoch(userId),
    retry: tracks.length === 0,
  };
}

/** How a page split across the lanes, for the log and for tests. */
function laneSummary(tracks = []) {
  const out = {};
  for (const t of tracks) out[t.lane ?? 'unknown'] = (out[t.lane ?? 'unknown'] ?? 0) + 1;
  return out;
}

/**
 * Every artist in this person's history, not just the top few.
 *
 * `stationArtists` is deliberately short (the station only pulls *songs* from a
 * handful), but "have I heard of this name" needs the whole set: otherwise a
 * track by the person's 12th most played band counts as a discovery and the
 * familiar share quietly drifts.
 */
function allStationArtistNames(userId) {
  return topArtists(userId, 60).map((a) => a.title).filter(Boolean);
}

/**
 * The neighbourhood of the artists this person is listening to.
 *
 * Two things come out of an artist page and both are wanted here: the
 * "fans also like" list (which *names* live next door) and their songs. The
 * neighbour names are also the input to the genre lane, so this returns both
 * instead of being a pure track pool.
 *
 * `neighbours` is returned as soon as the artist pages answer, and the caller
 * gets it through `onNeighbours` so the genre vote can start *while* the
 * neighbour catalogues are still being fetched. Those are two independent
 * network trips; serialising them cost about a second on a cold page.
 *
 * Neighbours are resolved by *channel id*, never by name. "Default", "Creed"
 * and "Flaws" are all artist names that are also ordinary words, and a name
 * search for them returns a rapper with "(feat. …)" in the title, a worship
 * band and a podcast. The id is the only thing that means one artist.
 */
const STATION_NEIGHBOUR_CATALOGUES = 3;
async function adjacentProfile(picked, knownArtists, limit = 8, { onNeighbours = null } = {}) {
  const stats = { attempted: 0, failed: 0 };
  if (!picked.length || limit <= 0) return { tracks: [], neighbours: [], ...stats };
  const attempt = async (load) => {
    stats.attempted += 1;
    try { return await load(); } catch {
      stats.failed += 1;
      return null;
    }
  };

  // Reuse one root profile per artist even when two different seed songs by
  // that artist both made the draw. A stored channelId skips the name search.
  const roots = [];
  const seenRoots = new Set();
  for (const seed of picked.slice(0, 2)) {
    const key = seed.channelId ?? artistKeyOf(seed.channel);
    if (!key || seenRoots.has(key)) continue;
    seenRoots.add(key);
    roots.push(seed);
  }
  const profiles = await Promise.all(roots.map(async (seed) => {
    const id = seed.channelId ?? await attempt(() => artistIdFor(seed.channel));
    if (!id) return null;
    return attempt(() => artistProfile(id));
  }));

  const neighbours = [];
  const seen = new Set();
  for (const profile of profiles) {
    for (const a of profile?.adjacent ?? []) {
      const key = artistKeyOf(a.name);
      if (!key || seen.has(key) || knownArtists.has(key)) continue;
      seen.add(key);
      neighbours.push({ name: a.name, id: a.id ?? null });
    }
  }
  onNeighbours?.(neighbours.map((n) => n.name));

  // Bandwidth is bounded below in youtube.js; do not also queue every unique
  // neighbour a page names. Three catalogues are enough to round-robin a lane,
  // and unused names still participate in the cheap genre vote above.
  const lists = await Promise.all(neighbours.slice(0, STATION_NEIGHBOUR_CATALOGUES).map(async (n) => {
    if (!n.id) return [];
    const page = await attempt(() => artistProfile(n.id));
    return page?.songs ?? [];
  }));

  // One song per neighbour per round, up to the ceiling the caller asked for.
  const ceiling = Math.max(limit, 12);
  const tracks = [];
  for (let round = 0; tracks.length < ceiling && lists.some((l) => l.length > round); round++) {
    for (const list of lists) {
      const t = list[round];
      if (t && tracks.length < ceiling) tracks.push(t);
    }
  }
  return { tracks, neighbours: neighbours.map((n) => n.name), ...stats };
}

/**
 * Songs that are big in the lane this person actually listens in.
 *
 * This is the "trending, but in my genre" lane, and it is read from YouTube
 * Music's *genre page* (the same tiles the mood browser opens), not from a
 * search query: the page carries a Songs shelf ranked by YouTube itself, which
 * is exactly the "what is hot in rock right now" signal the station was
 * missing. A plain search for an artist name answers with that artist's own
 * back catalogue, which is the artist loop this change exists to break.
 *
 * Which genre? The one the seed artists' genre pages agree on. Each seed artist
 * is looked up to find which of YouTube's genre tiles lists them, and the
 * majority wins; that is a real inference from the listener's own taste rather
 * than a hard-coded genre string. Ties fall back to the first tile, and no
 * match at all leaves the lane empty — the planner then fills from the others.
 */
async function trendingPool(seedArtists = [], neighbourNames = [], limit = 6) {
  if (!seedArtists.length) return [];
  // Vote with *all* the seeds, not just the page's three: a single quiet seed
  // (one Radiohead song next to five rock ones) must not decide the lane.
  const genre = await genreForArtists(seedArtists.map((s) => s.channel).filter(Boolean), neighbourNames)
    .catch(() => null);
  if (!genre) return [];
  // genreShelves() already fetched 50 rows to make the vote. Reuse those rows
  // for the 40-track pool instead of fetching the winning shelf a second time.
  const shelves = await genreShelves().catch(() => []);
  const winner = shelves.find((shelf) => shelf.name.toLowerCase() === genre.toLowerCase());
  return winner?.tracks.slice(0, 40) ?? [];
}

/**
 * Which genre page covers this person's artists?
 *
 * Sampling: the candidate tiles are the ones the app's mood browser knows,
 * minus the non-genre ones (moods, decades, languages) that would answer with
 * the wrong kind of list. Each candidate's song shelf is fetched once, and the
 * tile that lists the most of this person's artists — and, weighted higher,
 * the most of their *adjacent* artists — wins. That neighbour weighting is
 * what makes it a taste inference rather than a keyword match: a rock page is
 * full of Nickelback's "fans also like" bands even when Nickelback itself is
 * not on it.
 *
 * All candidate pages are fetched in parallel (14 pages ≈ 1.5 s, once per
 * process, and the answer is cached), so this adds no per-page latency. No
 * match at all leaves the lane empty and the planner fills from the others.
 */
const GENRE_CACHE = new Map();
/**
 * Bound an in-memory Map by dropping its oldest third once it reaches `max`.
 *
 * Insertion order is age — nothing re-inserts to refresh — so the first third is
 * the coldest. Shared by the genre vote below and the artwork cache (see
 * imgCacheSet): both are keyed by a caller-influenced value, and a Map keyed that
 * way is a slow memory leak unless something evicts it.
 */
const GENRE_CACHE_MAX = 500;
function evictOldestThird(map, max) {
  if (map.size < max) return;
  let drop = Math.ceil(max / 3);
  for (const k of map.keys()) {
    if (drop-- <= 0) break;
    map.delete(k);
  }
}
// Moods, decades and languages read as "genre tiles" but answer a different
// question; the station wants a musical lane.
const NOT_A_GENRE = /^(?:decades|chill|commute|energize|feel good|focus|gaming|halloween|party|romance|sad|sleep|workout|songwriters & producers|soundtracks & musicals|family|african|arabic|bollywood & indian|brazilian|j-pop|k-pop|mandopop & cantopop|opm)$/i;
const genreCacheKey = (artists) => artists.map((a) => String(a).toLowerCase()).sort().join('|');

/**
 * The song shelf of every genre tile, fetched once and kept for the session.
 *
 * The vote below needs all of them, and the seed set rotates on every page — so
 * caching the *vote* alone would re-fetch ~30 pages each time the cursor moved.
 * Caching the shelves makes every later vote pure CPU, and the answer is stable
 * for a listening session anyway (a genre page does not change hour to hour).
 */
let genreShelvesPromise = null;
function genreShelves() {
  genreShelvesPromise ??= (async () => {
    const tiles = (await genreTiles()).filter((t) => !NOT_A_GENRE.test(t.name));
    const shelves = await Promise.all(tiles.map(async (tile) => {
      const tracks = await genreSongs(tile.name, 50).catch(() => []);
      return {
        name: tile.name,
        artists: new Set(tracks.map((s) => artistKeyOf(s.channel ?? s.artist)).filter(Boolean)),
        tracks,
      };
    }));
    return shelves.filter((s) => s.artists.size);
  })().catch((err) => {
    genreShelvesPromise = null;
    throw err;
  });
  return genreShelvesPromise;
}

async function genreForArtists(artists = [], adjacentNames = []) {
  const names = [...new Set(artists.map((a) => artistKeyOf(a)).filter(Boolean))].slice(0, 4);
  if (!names.length) return null;
  const neighbours = new Set(adjacentNames.map((a) => artistKeyOf(a)).filter(Boolean));
  // Neighbours are an input to the vote, not incidental context. Keeping them
  // out of this key pinned later pages to a genre chosen for somebody else's
  // neighbourhood; the two sides stay role-separated as well as sorted.
  const key = `${genreCacheKey(names)}>${genreCacheKey([...neighbours])}`;
  if (GENRE_CACHE.has(key)) return GENRE_CACHE.get(key);

  const shelves = await genreShelves();
  if (!shelves.length) return null;

  let best = null;
  for (const shelf of shelves) {
    let self = 0;
    let adjacent = 0;
    for (const name of names) if (shelf.artists.has(name)) self++;
    for (const name of neighbours) if (!names.includes(name) && shelf.artists.has(name)) adjacent++;
    // A known artist on the page is worth more than a neighbour, but a page
    // full of neighbours says more about the *lane* than one known hit does.
    const score = self * 3 + adjacent;
    if (!best || score > best.score || (score === best.score && shelf.name < best.name)) {
      best = { name: shelf.name, score };
    }
  }

  const genre = best && best.score > 0 ? best.name : null;
  // Bounded like every other in-memory map here: the key is the combination of
  // a user's top artists, so it is one permanent entry per distinct combination
  // for the life of the process — unbounded, and driven by what people listen to.
  evictOldestThird(GENRE_CACHE, GENRE_CACHE_MAX);
  GENRE_CACHE.set(key, genre);
  return genre;
}

/**
 * The pinned personal station.
 *
 * Two ingredients, both needed for it to feel like "yours":
 *   1. seeds — what this person demonstrably enjoys (a like, or listening
 *      through most of a track). These are interleaved into the queue so it
 *      opens with something recognisable.
 *   2. expansions — the same artists and the same neighbourhood, pulled from
 *      YouTube's recommender. Without this the station would just be a playlist
 *      of things already heard, which is not a station.
 *
 * This returns the *first page*. It is not the whole station: /api/station/next
 * continues it forever, and the client asks for more when the queue runs low.
 *
 * Dislikes and repeated skips are removed from every layer: they cannot seed,
 * cannot be recommended back in, and cannot appear in the finished queue.
 */
/**
 * How far each user's Rebuild has walked the seed list.
 *
 * The seed cursor is the only thing that makes one station page differ from the
 * next (`rotateSeeds` walks the seed list by it), so a page built at a pinned
 * cursor of 0 is the same page every time — which made **Rebuild** a no-op that
 * re-fetched the same three seeds, and for a new account with three seeds or
 * fewer (nothing to rotate) re-derived the identical 30 tracks. Advancing a
 * per-user cursor by the same stride `/api/station/next` uses gives Rebuild a
 * genuinely different draw. Bounded like every other map here: an entry per
 * account that has ever pressed the button is not worth an unbounded leak.
 */
const STATION_REBUILD_CURSORS = new Map();
const STATION_REBUILD_CURSORS_MAX = 512;

/** One seed-stride per Rebuild, so pressing it twice is two different draws. */
function nextRebuildCursor(userId) {
  const next = advanceStationCursor(STATION_REBUILD_CURSORS.get(userId) ?? 0);
  evictOldestThird(STATION_REBUILD_CURSORS, STATION_REBUILD_CURSORS_MAX);
  STATION_REBUILD_CURSORS.set(userId, next);
  return next;
}

app.get('/api/station', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;

  const name = stationName(user.name);

  // Building a page costs three or four YouTube calls, and the inputs only
  // change when the user plays, likes or dislikes something (all of which drop
  // this key). Cache it so the pinned entry feels instant. `?fresh=1` is the
  // Rebuild button: it asks for a new draw on purpose.
  const fresh = String(req.query?.fresh ?? '') === '1';
  const epoch = stationEpoch(user.id);
  const key = `station:${user.id}:${epoch}:${fresh ? `fresh:${Date.now()}` : 'first'}`;
  const hit = fresh ? null : cacheGet(key);
  if (hit) return { ...hit, cached: true };

  // The cache check above cannot stop two *simultaneous* misses, and a station
  // page is 6-15 upstream calls. A double-tap on Play, a launch plus a refresh,
  // or two tabs used to build it once per request, and the slower answer then
  // overwrote the cache with a page the faster one had already been given. The
  // in-flight map collapses them onto one build (search does the same, see
  // coalesce); a `?fresh=1` draw is deliberately excluded — asking twice for a
  // new draw is not asking for the same answer.
  const build = () => stationPage(user.id, {
    cursor: fresh ? nextRebuildCursor(user.id) : 0,
    limit: STATION_LIMIT,
    includeSeeds: true,
  });
  const page = fresh ? await build() : await coalesce(searchInFlight, key, build);
  const { seeds, tracks, lanes } = page;
  // The final handoff is synchronous, but an invalidation can have run after
  // the attempt resolved and before this continuation. Never frame that page as
  // current evidence, and never seed the cache with it.
  if (page.epoch !== stationEpoch(user.id)) {
    return {
      name, blurb: stationBlurb({}), seeds: [], tracks: [], empty: true,
      reason: 'station-changing', retry: true,
    };
  }
  if (!seeds.length) {
    // An honest empty station beats a random one: it says what to do next.
    return { name, blurb: stationBlurb({}), seeds: [], tracks: [], empty: true, reason: 'no-seeds' };
  }

  // Seeds but nothing deliverable is a *failure*, not a station: a transient
  // upstream refusal used to render as a working hero ("Built from N songs",
  // Play) with an empty Up-next and a Play button that toasted "needs a few
  // listens first" — and the shape was then cached for ten minutes. Say what
  // happened, offer a retry, and cache nothing.
  const empty = tracks.length === 0;
  const payload = {
    name,
    blurb: stationBlurb({
      playedThrough: seeds.filter((s) => !s.liked && (s.deepest >= 0.6 || s.completes > 0)).length,
      liked: seeds.filter((s) => s.liked).length,
    }),
    seeds: seeds.map(({ videoId, title, channel, thumb, durationS, liked, score }) => ({
      videoId, title, channel, thumb, durationS, liked, score,
    })),
    tracks,
    // What the page was made of (four lanes, see stationPage). Exposed because
    // "why is my station all the same band" must be answerable from the
    // response instead of guessed at from the log.
    lanes,
    empty,
    ...(empty ? { reason: 'no-tracks', retry: true } : {}),
  };
  // Ten minutes: opening the station twice is instant, but a queue cannot
  // outlive a listening session. A `fresh` draw is deliberately NOT stored: its
  // key carries the timestamp, so nothing would ever read it back and the row
  // would sit in upstream_cache until the hourly sweep — one dead blob per
  // Rebuild press. A failed draw is never stored either, so the next visit
  // tries again instead of repeating the empty page for ten minutes.
  if (!fresh && !empty && page.epoch === stationEpoch(user.id)) cacheSet(key, payload, 10 * 60_000);
  return payload;
});

/**
 * The next page of the station — what makes it endless.
 *
 * The client calls this when its station queue runs low, passing `cursor` (how
 * far the station has travelled) and `exclude` (the ids already in the queue,
 * so a track the user is about to hear is not handed back a second time).
 *
 * Never cached: the whole point is that it answers with what the evidence says
 * *now*, including tracks this person liked or played through since the first
 * page was built.
 */
app.get('/api/station/next', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;

  // Non-finite and unsafe client arithmetic resets to zero. A later response is
  // advanced with a checked/wrapping helper rather than `cursor + 3`, which can
  // silently stop changing in the unsafe integer range.
  const cursor = normalizeStationCursor(req.query?.cursor);
  const raw = String(req.query?.exclude ?? '');
  const exclude = new Set(raw.split(',').map((s) => s.trim()).filter((s) => VIDEO_ID.test(s)).slice(0, 400));

  // Never cached (the point is to answer from what the evidence says *now*), so
  // nothing stopped a reload-happy client from stacking builds: a refresh, a
  // browser back and a second tab all send the same cursor and each paid for a
  // full page. Identical in-flight requests share one build, and a per-account
  // ceiling bounds the rest — 30 a minute is one every two seconds, far above
  // the "queue is running low" rate this is called at, and low enough that a
  // loop cannot hold every download slot hostage.
  if (!stationNextBudgetOk(user.id)) {
    reply.header('retry-after', '60');
    return reply.code(429).send({ error: 'Slow down — the station is already loading.', code: 'BUSY' });
  }
  const epoch = stationEpoch(user.id);
  const page = await coalesce(
    searchInFlight,
    `station-next:${user.id}:${epoch}:${cursor}:${[...exclude].join(',')}`,
    () => stationPage(user.id, { cursor, exclude, limit: EXTEND_LIMIT, includeSeeds: false }),
  );
  const { seeds, tracks, lanes } = page;
  if (page.epoch !== stationEpoch(user.id)) {
    return { tracks: [], cursor, empty: false, retry: true, reason: 'station-changing' };
  }
  if (!seeds.length) return { tracks: [], cursor, empty: true, reason: 'no-seeds' };
  if (page.retry && !tracks.length) {
    return { tracks: [], lanes, cursor, empty: false, retry: true, reason: 'lanes-unavailable' };
  }
  return {
    tracks,
    lanes,
    // How far the *next* call should start. Genuine exhaustion advances; a
    // transient all-lane failure above explicitly retries at this same cursor.
    cursor: advanceStationCursor(cursor),
    empty: false,
  };
});

/** Real releases, channels and song-lists for the library and mood tabs. */
app.get('/api/browse/:kind', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const kind = String(req.params.kind);
  if (!['albums', 'artists', 'playlists'].includes(kind)) {
    return reply.code(400).send({ error: 'Unknown kind.' });
  }
  const q = String(req.query?.q ?? '').trim().slice(0, 200);

  // A mood is a feeling, not a song: searching songs for it returns 4-hour
  // single-video mixes. Community playlists are real lists the user can open
  // and pick songs from, which is what "browse by feeling" is supposed to be.
  if (kind === 'playlists') {
    if (!q) return reply.code(400).send({ error: 'Missing q.' });
    const key = `browse:playlists:${q.toLowerCase()}`;
    const hit = cacheGet(key);
    if (hit) return { items: hit };
    let items;
    try {
      items = await coalesce(searchInFlight, key, async () => {
        const loaded = await searchMoodPlaylists(q);
        cacheSet(key, loaded, 10 * 60_000);
        return loaded;
      });
    } catch (err) {
      req.log.warn({ q, err: err.message }, 'mood playlist lookup failed');
      return upstreamFailure(reply, err, 'playlist');
    }
    return { items };
  }

  // Artists come from what this user actually played. Falling back to a bare
  // "music" search would fill the tab with random small channels.
  if (kind === 'artists') {
    const mine = topArtists(user.id, 18);
    if (mine.length) {
      return {
        items: mine.map((a) => ({
          id: a.title,
          title: a.title,
          subscribers: `${a.plays} ${a.plays === 1 ? 'play' : 'plays'}`,
          thumb: a.thumb,
          source: 'history',
        })),
      };
    }
    let fallback;
    try {
      fallback = await searchArtists(q || 'music');
    } catch (err) {
      req.log.warn({ q, err: err.message }, 'artist browse lookup failed');
      return upstreamFailure(reply, err, 'artists');
    }
    return { items: fallback.map((a) => ({ ...a, source: 'search' })) };
  }

  // Albums: releases by the artists you actually listen to.
  const seed = q || topArtists(user.id, 1)[0]?.title || 'music';
  const key = `browse:albums:${seed}`;
  const hit = cacheGet(key);
  if (hit) return { items: hit };
  let items;
  try {
    // A cached album shelf is free; a miss is an upstream call, so two tabs
    // opening Browse at once share one (see coalesce).
    items = await coalesce(searchInFlight, key, async () => {
      const loaded = await searchAlbums(seed);
      cacheSet(key, loaded, 10 * 60_000);
      return loaded;
    });
  } catch (err) {
    req.log.warn({ seed, err: err.message }, 'album browse lookup failed');
    return upstreamFailure(reply, err, 'albums by that artist');
  }
  return { items };
});

/**
 * An artist page: popular songs, releases, videos and neighbours.
 *
 * `:id` is either a channel id (UC…) or a plain artist name. Names arrive from
 * the library's history view, which only knows what it played; resolving them
 * through the ranked artist search is what stops a fan re-upload channel from
 * winning. Cached because a page is one upstream call and does not change
 * minute to minute.
 */
app.get('/api/artist/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  let raw = String(req.params.id ?? '');
  try { raw = decodeURIComponent(raw); } catch {}
  raw = raw.trim().slice(0, 200);
  if (!raw) return reply.code(400).send({ error: 'Missing artist.' });

  const key = `artist:${raw.toLowerCase()}`;
  const hit = cacheGet(key);
  // `following` is per viewer, so it is added *after* the cache read. Baking it
  // into the cached payload would hand the first caller's answer to everyone
  // else who opens the page for the next ten minutes.
  if (hit) return { ...hit, following: isFollowing(user.id, hit.id ?? raw) };

  // A name has to be resolved through the ranked artist search first, which is
  // an upstream call of its own: a bot-gate here must not be reported as "no
  // such artist", or the client blames the link instead of the IP.
  let id = /^UC[\w-]{20,}$/.test(raw) ? raw : null;
  if (!id) {
    try {
      id = await artistIdFor(raw);
    } catch (err) {
      req.log.warn({ raw, err: err.message }, 'artist id resolution failed');
      return upstreamFailure(reply, err, 'that artist');
    }
  }
  if (!id) return reply.code(404).send({ error: 'No such artist.' });

  let payload;
  try {
    // Coalesced as well as cached: opening an artist page twice at once (two
    // tabs, a double-tap) is one page fetch, not two.
    payload = await coalesce(searchInFlight, key, async () => {
      const page = await artistPage(id);
      transaction(() => { for (const t of [...page.songs, ...page.videos]) upsertTrack(t); });
      const loaded = { ...page, id };
      cacheSet(key, loaded, 10 * 60_000);
      return loaded;
    });
  } catch (err) {
    req.log.warn({ id, err: err.message }, 'artist page failed');
    return upstreamFailure(reply, err, 'that artist');
  }
  return { ...payload, following: isFollowing(user.id, id) };
});

/**
 * Which release a track belongs to, for "Open album".
 *
 * The client only asks when the track's own row did not carry an album id
 * (up-next, videos, older library rows). The `?title=`/`?artist=` hints are
 * deliberately NOT trusted any more: see below.
 */
app.get('/api/album/for/:videoId', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const known = getTrack(videoId);
  // Only server-derived metadata reaches albumForVideo: it caches its answer
  // (including "no album") for the life of the process, so a caller-supplied
  // ?title= that did not match the track pair poisoned that cache — "Open
  // album" stayed greyed out for that song until a restart. A stored row is
  // trustworthy; a client hint is not, so it is ignored.
  const found = await albumForVideo(videoId, {
    title: known?.title ?? null,
    artist: known?.channel ?? null,
  });
  return { albumId: found?.albumId ?? null, title: found?.title ?? null, author: found?.author ?? null };
});

/**
 * Open a YouTube playlist or album by id.
 *
 * Cached for ten minutes and coalesced, like `/api/artist/:id` and
 * `/api/browse/albums`. It was the one detail page that re-fetched on every
 * open: back/forward, a reload and every revisit re-paid the resolution timeout
 * (25 s worst case) plus a 100-row upsert transaction, and `id` is any 200-char
 * string a client cares to send, so the same route was also the cheapest way to
 * drive arbitrary upstream load and `tracks` growth. A cached answer is one
 * object; a *failure* is never cached, so a transient gate is retried.
 */
app.get('/api/album/:id', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const id = String(req.params.id).slice(0, 200);
  if (!id) return reply.code(400).send({ error: 'Bad album id.' });

  const key = `album:${id}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  try {
    return await coalesce(searchInFlight, key, async () => {
      // MPR… is a Music album, which the playlist reader cannot fetch. Albums
      // opened from an artist page arrive in that form; the library's album tab
      // still uses PL ids and keeps the old path.
      if (/^MPR[\w-]+$/.test(id)) {
        const data = await albumPage(id);
        transaction(() => { for (const t of data.tracks) upsertTrack(t); });
        const payload = { ...data, albumId: id };
        cacheSet(key, payload, 10 * 60_000);
        return payload;
      }
      const { title, author, type, tracks } = await playlistTracks(id);
      transaction(() => { for (const t of tracks) upsertTrack(t); });
      const payload = { title, author, type, tracks };
      cacheSet(key, payload, 10 * 60_000);
      return payload;
    });
  } catch (err) {
    req.log.warn({ id, err: err.message }, 'album page failed');
    return upstreamFailure(reply, err, 'album or playlist');
  }
});

// ── follows & notifications ─────────────────────────────────────────────
// A follow is a standing request stored on the server, so it survives a cleared
// browser and works from every device. The bell is a feed of what the sweep in
// src/follows.js found; the client renders it and turns unread rows into a
// Web/PWA notification, but the server stays the source of truth.

/** A channel id, which is the only thing a follow is keyed by. */
const ARTIST_ID = /^UC[\w-]{20,}$/;

// Manual checks, follow-time reconciliation and the scheduled sweep all read and
// write the same release baselines. The old timestamp guarded only one user's
// manual requests, so two accounts (or the interval) could fetch and commit the
// same artist concurrently. One process-wide owner prevents those out-of-order
// writes and bounds upstream work; a busy manual caller gets the same quiet
// throttle shape as its per-user cooldown rather than queueing another poll.
// A follow-time baseline is the exception: it is not a notification check and
// must not consume or imitate the user's first manual check. The route waits for
// that short, already-running prerequisite before acquiring the shared slot.
let activeFollowJob = null;
function beginFollowJob(label, work, { detached = false, kind = 'poll' } = {}) {
  if (closing || activeFollowJob) return null;
  const job = trackJob(label, work, { detached });
  job.kind = kind;
  activeFollowJob = job;
  const settled = () => { if (activeFollowJob === job) activeFollowJob = null; };
  job.promise.then(settled, settled);
  return job;
}

app.post('/api/artists/:id/follow', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const artistId = String(req.params.id ?? '').trim();
  if (!ARTIST_ID.test(artistId)) return reply.code(400).send({ error: 'Not a channel id.' });
  const name = String(req.body?.name ?? '').trim().slice(0, 200) || null;
  const thumb = String(req.body?.thumb ?? '').trim().slice(0, 500) || null;

  followArtist(user.id, { artistId, name, thumb });

  // Reconcile immediately through the same notification-aware path as the sweep:
  // a first look baselines the back catalogue, while releases already known to
  // other followers are fanned out rather than consumed and discarded. Following
  // is still a local, nonblocking decision: a dead upstream cannot fail the route
  // and the response never waits on YouTube. A failed check leaves its baseline
  // unadvanced, so a later sweep retries the news.
  const baseline = beginFollowJob(
    `follow baseline ${artistId}`,
    () => checkArtist(artistId, { artist: { artistId, name, thumb } }),
    { detached: true, kind: 'baseline' },
  );
  baseline?.promise.catch((err) => {
    console.warn('[sonora] follow baseline failed for', artistId, err.message);
  });

  return { following: true, artistId, name };
});

app.delete('/api/artists/:id/follow', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const artistId = String(req.params.id ?? '').trim();
  unfollowArtist(user.id, artistId);
  // Deliberately not a 404 for an unknown id: the desired state is "not
  // following", and that is what the client gets either way.
  return { following: false, artistId };
});

app.get('/api/follows', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return { items: listFollows(user.id) };
});

app.get('/api/notifications', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const wanted = Number.parseInt(String(req.query?.limit ?? ''), 10);
  const limit = Number.isFinite(wanted) ? Math.max(1, Math.min(100, wanted)) : 50;
  return { items: listNotifications(user.id, limit), unread: countUnread(user.id) };
});

app.post('/api/notifications/read', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  // The db helper only ever touches rows owned by this user, so a forged id can
  // at most be a no-op — never someone else's notification.
  markNotificationsRead(user.id, Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 500) : []);
  return { unread: countUnread(user.id) };
});

app.post('/api/notifications/read-all', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  markAllNotificationsRead(user.id);
  return { unread: countUnread(user.id) };
});

// A manual poll, for a client that wants fresh news without waiting for the
// 20-minute sweep. One per user per minute: the poll is one catalogue page fetch
// per followed artist, and pressing the bell is not a reason to hammer YouTube.
// The throttle answers instead of erroring, because "nothing new right now" is
// exactly what the client would show anyway.
const NOTIFICATION_CHECK_MS = 60_000;
const NOTIFICATION_CHECK_MAX = 1000;
const lastNotificationCheck = new Map(); // userId → epoch ms

function markNotificationCheck(userId, nowMs) {
  // Accounts can be created and deleted independently of this process-local
  // cooldown. Prune expired stamps, then retain a hard ceiling even under a
  // continuous stream of distinct accounts; reinsertion keeps age ordering true.
  lastNotificationCheck.delete(userId);
  if (lastNotificationCheck.size >= NOTIFICATION_CHECK_MAX) {
    for (const [id, at] of lastNotificationCheck) {
      if (nowMs - at >= NOTIFICATION_CHECK_MS) lastNotificationCheck.delete(id);
    }
    evictOldestThird(lastNotificationCheck, NOTIFICATION_CHECK_MAX);
  }
  lastNotificationCheck.set(userId, nowMs);
}

app.post('/api/notifications/check', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const nowMs = Date.now();
  const last = lastNotificationCheck.get(user.id) ?? 0;
  if (nowMs - last < NOTIFICATION_CHECK_MS) {
    return { created: 0, unread: countUnread(user.id), throttled: true };
  }
  // Following returns before its baseline fetch finishes. If the listener opens
  // the bell at once, that prerequisite is still occupying the shared slot. Wait
  // for it rather than misreporting the user's *first* check as a throttled/busy
  // no-op. Reserve the cooldown while waiting so a second tap cannot queue a
  // second manual poll; an unsuccessful acquisition releases the reservation.
  const baseline = activeFollowJob?.kind === 'baseline' ? activeFollowJob : null;
  if (baseline) {
    markNotificationCheck(user.id, nowMs);
    await baseline.promise.catch(() => {});
  }
  const job = beginFollowJob(`manual follow poll for user ${user.id}`,
    () => pollFollows({ limit: 4, userId: user.id }));
  if (!job) {
    if (baseline && lastNotificationCheck.get(user.id) === nowMs) {
      lastNotificationCheck.delete(user.id);
    }
    if (closing) return reply.code(503).send({ error: 'The server is shutting down.' });
    // Do not spend this user's one-minute cooldown on work that never ran.
    return { created: 0, unread: countUnread(user.id), throttled: true, busy: true };
  }
  // Stamped once the process-wide slot is acquired, so two concurrent requests
  // for this user still cannot both run, even after the first poll settles. A
  // request that waited behind a baseline already reserved its stamp above.
  if (!baseline) markNotificationCheck(user.id, nowMs);
  // Scoped to the caller. dueFollows() merges every account's due rows and only
  // then slices to four, so a manual "check for news" used to spend all four of
  // its page fetches on whatever was globally most overdue — often other
  // people's artists — and answered {created: 0} having not looked at one of
  // theirs. Indistinguishable, from the bell, from "no new releases".
  const { created } = await job.promise;
  return { created, unread: countUnread(user.id) };
});

/** Lyrics for the now-playing sheet. Cached; null is a normal answer. */
app.get('/api/lyrics/:videoId', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const key = `lyrics:${videoId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const text = await fetchLyrics(videoId);
  const payload = { text };
  // A *definite* "no lyrics" is worth six hours; a null from a timeout, a gate
  // or a 5xx is not. fetchLyrics() collapses every failure into null, so the
  // only honest reading of null is "unknown" — cache it briefly, so one slow
  // lookup does not read as "no lyrics" for the rest of the day (the answer is
  // also in SQLite, so it survived restarts).
  cacheSet(key, payload, text ? 6 * 60 * 60_000 : 3 * 60_000);
  return payload;
});

// ── playlists ───────────────────────────────────────────────────────────

app.get('/api/playlists', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return { playlists: listPlaylists(user.id) };
});

app.post('/api/playlists', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const title = String(req.body?.title ?? '').trim().slice(0, 120);
  if (!title) return reply.code(400).send({ error: 'Missing title.' });
  const id = createPlaylist(user.id, {
    title,
    description: String(req.body?.description ?? '').slice(0, 400) || null,
    artVideo: VIDEO_ID.test(String(req.body?.artVideo ?? '')) ? req.body.artVideo : null,
  });
  return reply.code(201).send({ playlist: getPlaylist(user.id, id) });
});

app.get('/api/playlists/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad playlist id.' });
  const pl = getPlaylist(user.id, id);
  if (!pl) return reply.code(404).send({ error: 'No such playlist.' });
  return { playlist: pl };
});

app.post('/api/playlists/:id/tracks', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad playlist id.' });
  const b = req.body ?? {};
  const videoId = String(b.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  if (!optionalDurationValid(b.durationS)) {
    return reply.code(400).send({ error: 'Duration must be a nonnegative safe integer.' });
  }
  // The catalogue row is global. Existing canonical fields survive a playlist
  // add; only a genuinely new id may be initialised from the client body.
  const track = getTrack(videoId) ? { videoId } : {
    videoId,
    title: String(b.title ?? '').slice(0, 300) || null,
    channel: String(b.channel ?? '').slice(0, 200) || null,
    channelId: String(b.channelId ?? '').slice(0, 64) || null,
    durationS: b.durationS ?? null,
    thumb: String(b.thumb ?? '').slice(0, 500) || null,
  };
  const ok = addPlaylistItem(user.id, id, track);
  if (!ok) return reply.code(404).send({ error: 'No such playlist.' });
  return { ok: true };
});

app.delete('/api/playlists/:id/tracks/:videoId', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad playlist id.' });
  if (!VIDEO_ID.test(String(req.params.videoId ?? ''))) {
    return reply.code(400).send({ error: 'Bad video id.' });
  }
  if (!SQL.playlistOwned.get(id, user.id)) return reply.code(404).send({ error: 'No such playlist.' });
  // DELETE is idempotent. In particular, an absent item must not update the
  // playlist timestamp and make every client's collection look changed.
  if (!SQL.playlistItem.get(id, req.params.videoId)) return { ok: true };
  removePlaylistItem(user.id, id, req.params.videoId);
  return { ok: true };
});

app.delete('/api/playlists/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad playlist id.' });
  if (!deletePlaylist(user.id, id)) {
    return reply.code(404).send({ error: 'No such playlist.' });
  }
  return { ok: true };
});

/** One known track, for share links (`#/t/<videoId>`) and deep links. */
app.get('/api/track/:videoId', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const track = getTrack(videoId);
  // A valid id this instance has never seen is not an error: /t/<id> renders a
  // card for any id and /api/stream/<id> will fetch it, so a shared link used
  // to refuse to play here ("That link points to a track sonora has not seen
  // yet") on the one route that could have served it. The player tolerates a
  // null title/duration, so answer with a minimal synthetic row and let the
  // stream fill the rest in.
  if (!track) {
    return { track: { videoId, title: null, channel: null, thumb: null, durationS: null, unknown: true } };
  }
  return { track };
});

app.get('/api/recent', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return { tracks: recentlyPlayed(user.id) };
});

// ── library ─────────────────────────────────────────────────────────────

app.get('/api/likes', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return { tracks: listLikes(user.id) };
});

/**
 * Whatever the player was last doing, so a reload — or another device — can
 * resume the session instead of restarting it.
 */
app.get('/api/now', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const row = SQL.playerState.get(user.id);
  if (!row) return { state: null, updatedAt: null };
  try {
    const saved = JSON.parse(row.state);
    const updatedAt = Date.parse(row.updated_at) || saved.updatedAt || 0;
    return { state: { ...saved, updatedAt }, updatedAt };
  } catch {
    return { state: null, updatedAt: null };
  }
});

// A session saved by a device that has been gone for half a day is not
// "active"; the next device may claim it without an explicit takeover.
const SESSION_STALE_MS = 12 * 60 * 60 * 1000;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Save the playhead.
 *
 * The row is shared by every device signed into the same account, which is
 * exactly what makes "start on the phone, continue on the laptop" work. The
 * flip side is that two open players would overwrite each other every five
 * seconds, so the row records which device owns the session:
 *
 *  - a periodic save from the owner is accepted;
 *  - a save from another device is refused with 409 (and the current state)
 *    unless it explicitly takes over, which the client only does after the
 *    user presses play on that device;
 *  - a stale session can be claimed by anyone.
 */
app.put('/api/now', {
  // A worst-case 60-track queue (300/200/500-char fields) can approach the
  // global 64 KB limit; this route's own shape allows more than that, so the
  // limit is raised here instead of letting a long station window 413.
  config: { bodyLimit: 256 * 1024 },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const b = req.body ?? {};
  for (const field of ['takeover', 'station', 'playing']) {
    if (!optionalBooleanValid(b, field)) {
      return reply.code(400).send({ error: `${field} must be a boolean.` });
    }
  }
  if (!optionalDurationValid(b.positionMs) || !optionalDurationValid(b.clientSavedAt)) {
    return reply.code(400).send({ error: 'Playhead times must be nonnegative safe integers.' });
  }
  const hasClientOrder = Number.isSafeInteger(b.clientSavedAt) && b.clientSavedAt >= 0;
  if (b.clientSaveSeq !== undefined && b.clientSaveSeq !== null
      && (!Number.isSafeInteger(b.clientSaveSeq) || b.clientSaveSeq < 1)) {
    return reply.code(400).send({ error: 'clientSaveSeq must be a positive safe integer.' });
  }
  if (b.clientSaveSeq != null && !hasClientOrder) {
    return reply.code(400).send({ error: 'clientSaveSeq requires clientSavedAt.' });
  }
  if (b.index !== undefined && !Number.isSafeInteger(b.index)) {
    return reply.code(400).send({ error: 'Queue index must be a safe integer.' });
  }
  const clientSaveSeq = hasClientOrder ? (b.clientSaveSeq ?? 0) : null;
  const deviceId = DEVICE_ID.test(String(b.deviceId ?? '')) ? String(b.deviceId) : null;
  const deviceName = String(b.deviceName ?? '').trim().slice(0, 40) || null;
  const takeover = b.takeover ?? false;

  const row = SQL.playerState.get(user.id);
  let prev = null;
  if (row) { try { prev = JSON.parse(row.state); } catch {} }
  const prevUpdatedAt = row ? (Date.parse(row.updated_at) || 0) : 0;
  const prevDeviceId = prev?.deviceId ?? null;
  const stale = !prevUpdatedAt || Date.now() - prevUpdatedAt > SESSION_STALE_MS;

  // A background save must not steal an active session from another device.
  // A legacy client (no deviceId) keeps the old last-write-wins behaviour.
  if (deviceId && prevDeviceId && deviceId !== prevDeviceId && !takeover && !stale) {
    return reply.code(409).send({
      error: 'Another device is playing.',
      code: 'DEVICE_CONFLICT',
      // This conflict is the one case where the caller needs the complete queue:
      // app.js adopts it when another device has taken over playback.
      state: prev,
      updatedAt: prevUpdatedAt,
    });
  }

  // Arrival time cannot order two network requests: a delayed older autosave can
  // arrive after the pause/seek that followed it. New clients therefore stamp a
  // wall-clock millisecond plus a sequence for saves within that millisecond.
  // Compare only within the owning device; another device's sequence is private
  // and belongs to the ownership/takeover rule above. Omitting both fields keeps
  // the documented legacy last-write-wins behaviour.
  if (hasClientOrder && deviceId && deviceId === prevDeviceId
      && Number.isSafeInteger(prev?.clientSavedAt)) {
    const beforePrevious = b.clientSavedAt < prev.clientSavedAt
      || (b.clientSavedAt === prev.clientSavedAt
        && clientSaveSeq <= (Number.isSafeInteger(prev?.clientSaveSeq) ? prev.clientSaveSeq : 0));
    if (beforePrevious) {
      return reply.code(409).send({
        error: 'A newer save from this device has already been applied.',
        code: 'STALE_SAVE',
        updatedAt: prevUpdatedAt,
      });
    }
  }

  // The body is allowed to be PARTIAL, and the playhead patch is the reason: a
  // phone nudging its position every few seconds used to re-upload the whole
  // queue (58 KB for a full station window) to change three numbers. A body with
  // no `queue` therefore keeps the stored queue, and every field it does not
  // mention keeps its stored value — which also means an older client that
  // always sends the full body behaves exactly as before.
  const hasQueue = Array.isArray(b.queue);
  const stored = Array.isArray(prev?.tracks) ? prev.tracks : [];
  const submitted = hasQueue ? b.queue.slice(0, 60) : [];
  const indexedTracks = [];
  for (const [sourceIndex, t] of submitted.entries()) {
    if (!VIDEO_ID.test(String(t?.videoId ?? ''))) continue;
    if (!optionalDurationValid(t.durationS)) {
      return reply.code(400).send({ error: 'Queue durations must be nonnegative safe integers.' });
    }
    indexedTracks.push({
      sourceIndex,
      track: {
        videoId: t.videoId,
        title: String(t.title ?? '').slice(0, 300),
        channel: String(t.channel ?? '').slice(0, 200),
        thumb: String(t.thumb ?? '').slice(0, 500),
        durationS: t.durationS ?? null,
      },
    });
  }
  const tracks = hasQueue ? indexedTracks.map(({ track }) => track) : stored;
  const clampIndex = (n) => Math.max(0, Math.min(n, Math.max(0, tracks.length - 1)));

  // Which row the playhead is on. A full body's index refers to the *submitted*
  // queue, so if invalid ids are filtered, find the surviving entry at that
  // original position instead of shifting the playhead to the next song.
  // `videoId` remains the natural key for a patch; an explicit index wins.
  let index;
  if (Number.isInteger(b.index) && hasQueue) {
    const original = Math.max(0, Math.min(b.index, Math.max(0, submitted.length - 1)));
    const exact = indexedTracks.findIndex((entry) => entry.sourceIndex === original);
    const following = indexedTracks.findIndex((entry) => entry.sourceIndex >= original);
    index = exact >= 0 ? exact : following >= 0 ? following : clampIndex(b.index);
  } else if (Number.isInteger(b.index)) index = clampIndex(b.index);
  else if (VIDEO_ID.test(String(b.videoId ?? ''))) {
    const at = tracks.findIndex((t) => t.videoId === b.videoId);
    index = at >= 0 ? at : clampIndex(Number.isInteger(prev?.index) ? prev.index : 0);
  } else index = clampIndex(Number.isInteger(prev?.index) && !hasQueue ? prev.index : 0);

  // Absent fields inherit the stored value — but only for a *partial* body. A
  // full body that omits `station`/`playing`/`source` keeps the old reading
  // (false/empty), so a client that has always sent the whole queue behaves
  // exactly as it did; and a playhead patch can never freeze an endless station
  // into a plain queue by leaving `station` out.
  const inherit = !hasQueue;
  const now = Math.max(Date.now(), prevUpdatedAt + 1);
  const inheritedOrder = deviceId && deviceId === prevDeviceId;
  const state = {
    tracks,
    index,
    positionMs: b.positionMs ?? (hasQueue ? 0 : Number(prev?.positionMs) || 0),
    source: String(b.source ?? (inherit ? prev?.source ?? '' : '')).slice(0, 40),
    // Whether what was playing was the endless station. Restoring a station as
    // a plain queue would silently freeze it into the handful of songs that
    // happened to be buffered when the phone locked.
    station: b.station ?? (inherit ? prev?.station === true : false),
    deviceId: deviceId ?? prevDeviceId ?? null,
    deviceName: deviceName ?? prev?.deviceName ?? null,
    playing: b.playing ?? (inherit ? prev?.playing === true : false),
    ...(hasClientOrder ? {
      clientSavedAt: b.clientSavedAt,
      clientSaveSeq,
    } : inheritedOrder ? {
      clientSavedAt: prev.clientSavedAt ?? null,
      clientSaveSeq: prev.clientSaveSeq ?? null,
    } : { clientSavedAt: null, clientSaveSeq: null }),
    updatedAt: now,
  };
  SQL.savePlayerState.run(user.id, JSON.stringify(state), new Date(now).toISOString());
  return { ok: true, updatedAt: now, deviceId: state.deviceId, deviceName: state.deviceName };
});

app.post('/api/likes', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const videoId = String(req.body?.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  if (typeof req.body?.like !== 'boolean') return reply.code(400).send({ error: 'like must be a boolean.' });
  if (!optionalDurationValid(req.body?.durationS)) {
    return reply.code(400).send({ error: 'Duration must be a nonnegative safe integer.' });
  }
  const on = req.body.like;
  // This is an absolute setting, not a "vote again" event. Repeating it must not
  // manufacture extra station/ranking evidence or invalidate an unchanged queue.
  if (Boolean(SQL.likePresent.get(user.id, videoId)) === on) return { ok: true, liked: on };
  rememberFromBody(videoId, req.body ?? {});
  toggleLike(user.id, videoId, on);
  // Likes are a station input, so the built queue is now stale.
  invalidateStation(user.id);
  recordPlay({
    userId: user.id, videoId, kind: on ? 'like' : 'unlike',
    // Clamped like every sibling that writes plays: the body limit lets 64 KB
    // through, and `source` would otherwise be the one column without a cap.
    source: String(req.body?.source ?? '').slice(0, 40) || null,
  });
  return { ok: true, liked: on };
});

// ── "less like this" ────────────────────────────────────────────────────
// A dislike is a standing instruction rather than a collection: it removes the
// track from every generated queue and cancels a like. It stays reversible —
// the control is a toggle, and the track reappears when it is undone.

app.get('/api/dislikes', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return { tracks: listDislikes(user.id) };
});

app.post('/api/dislikes', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const videoId = String(req.body?.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  if (typeof req.body?.dislike !== 'boolean') return reply.code(400).send({ error: 'dislike must be a boolean.' });
  if (!optionalDurationValid(req.body?.durationS)) {
    return reply.code(400).send({ error: 'Duration must be a nonnegative safe integer.' });
  }
  const on = req.body.dislike;
  if (Boolean(SQL.dislikePresent.get(user.id, videoId)) === on) return { ok: true, disliked: on };
  rememberFromBody(videoId, req.body ?? {});
  toggleDislike(user.id, videoId, on);
  invalidateStation(user.id);
  recordPlay({
    userId: user.id, videoId, kind: on ? 'dislike' : 'undislike',
    source: String(req.body?.source ?? '').slice(0, 40) || null,
  });
  return { ok: true, disliked: on };
});

// ── the taste signal ────────────────────────────────────────────────────

// Every play event kind the client may report. Compiled once: a Set built per
// request is pure waste on the hottest write path in the app.
const PLAY_EVENT_KINDS = new Set(['start', 'progress', 'complete', 'skip']);

app.post('/api/events', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const b = req.body ?? {};
  const videoId = String(b.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const kind = String(b.kind ?? '');
  if (!PLAY_EVENT_KINDS.has(kind)) return reply.code(400).send({ error: 'Bad kind.' });
  if (!optionalDurationValid(b.positionMs) || !optionalDurationValid(b.durationMs)
      || !optionalDurationValid(b.durationS)) {
    return reply.code(400).send({ error: 'Playback times must be nonnegative safe integers.' });
  }
  // Work out the threshold crossing *before* recording this heartbeat. Later
  // 65%, 70%, … ticks then observe the already-deep history and do not evict the
  // station again. This also works across restarts and admin history clears;
  // an in-memory "already invalidated" set would forget or poison those cases.
  const crossedSeedThreshold = kind === 'progress' && b.durationMs > 0
    && b.positionMs / b.durationMs >= 0.6
    && (Number(SQL.stationDepth.get(user.id, videoId)?.deepest) || 0) < 0.6;
  // The station names what it was built from, so a play event from a track the
  // server has never seen must bring its metadata along.
  rememberFromBody(videoId, b);
  recordPlay({
    userId: user.id,
    videoId,
    kind,
    positionMs: b.positionMs ?? null,
    durationMs: b.durationMs ?? null,
    source: String(b.source ?? '').slice(0, 40) || null,
  });
  // Only events that can change seed evidence drop the cached station. A start
  // and a shallow heartbeat do not qualify; the first progress tick at 60% does,
  // while subsequent ticks above it reuse the freshly built page.
  if (kind === 'complete' || kind === 'skip' || crossedSeedThreshold) invalidateStation(user.id);
  return { ok: true };
});

app.get('/api/stats', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const row = SQL.stats.get(user.id);
  const likes = SQL.likeCount.get(user.id).n;
  return { ...row, likes, readyForRanking: (row.starts ?? 0) >= 50 };
});

// ── audio proxy ─────────────────────────────────────────────────────────
// The phone cannot play YouTube's URL directly: it is bound to the resolving
// host's IP (sparams=...ip...) and expires. Everything goes through here.
//
// Second hard constraint, measured 2026-10-18: googlevideo rejects open-ended
// and large ranges. `Range: bytes=0-` and `bytes=0-4194303` both return 403;
// only bounded ranges up to ~1 MiB return 206. Media elements always send
// open-ended ranges, so this proxy clamps every upstream request to
// CHUNK_BYTES and lets the client fetch the next chunk itself (RFC 9110
// explicitly allows a server to return fewer bytes than requested).
const CHUNK_BYTES = 1024 * 1024;

/**
 * A single byte range, or the instruction to ignore the header.
 *
 * `{ start, end }` is a usable range (206); `null` is a well-formed range that
 * cannot be satisfied (416, with the real size in `content-range`);
 * `'full'` is a header that is present but is not one usable byte range, and its
 * answer is the whole file with a 200.
 *
 * `'full'` exists because a malformed or multi-part header used to be answered
 * with the first chunk as a 206: RFC 9110 §14.2 says a Range the server cannot
 * use is *ignored*, and a 206 makes a media element believe the file is exactly
 * that one chunk — it played one window and then reported a truncated stream.
 * An *absent* header keeps the clamped 206 below: that is what a media element's
 * first request looks like, and every client of this proxy is a media element
 * (a 200 there would make it download a whole track to play the first second).
 */
function parseRange(header, total) {
  // A zero-byte file has no satisfiable byte range at all.
  if (!(total > 0)) return null;
  const raw = typeof header === 'string' ? header.trim() : '';
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m) {
    if (raw) return 'full';
    return { start: 0, end: Math.min(total - 1, CHUNK_BYTES - 1) };
  }
  const [, rawStart, rawEnd] = m;

  // suffix form: bytes=-N  (last N bytes)
  if (rawStart === '' && rawEnd !== '') {
    const n = Math.min(Number(rawEnd), CHUNK_BYTES);
    // bytes=-0 asks for the last zero bytes, which is not a range. Computing it
    // used to yield start === total, and fs.createReadStream then threw
    // ERR_OUT_OF_RANGE *after* the 206 headers were on the wire.
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: Math.max(0, total - n), end: total - 1 };
  }

  const start = Number(rawStart);
  const wanted = rawEnd === '' ? Infinity : Number(rawEnd);
  if (!Number.isFinite(start) || start < 0) return null;
  if (start >= total) return null; // 416
  // A last-byte-pos before the first-byte-pos is not a valid range (RFC 9110
  // §14.1.1). It used to reach createReadStream, which threw after the headers
  // had been flushed: a 500 carrying `content-range: bytes 100-50/…`.
  if (wanted < start) return null;

  const end = Math.min(wanted, start + CHUNK_BYTES - 1, total - 1);
  return { start, end };
}

// ── audio prefetch ──────────────────────────────────────────────────────
// Cold playback costs one full yt-dlp run. The queue always knows the next
// track, so that cost can be paid while the current one is playing instead of
// after the user presses next. Measured 2026-10-20: a cold track took 15 s to
// first byte (and 30 s+ when DNS was slow) versus ~0.17 s from cache — this is
// the difference between "press play, wait" and "press play".
// Prefetch is a *budget*, not an open tap. A signed-in client could ask the
// server to download any YouTube id forever — the guest path is queue-scoped,
// this one had no bound at all — and every abandoned prefetch queues ahead of a
// real stream in the download slots. One account gets 40 prefetches a minute; a
// client that settles on a track (the normal case) uses a tiny fraction of that.
//
// The same counter is what /api/stream spends on a cold track (see the handler):
// a prefetch and a play both cost one yt-dlp download in one of the shared
// slots, so they belong to one budget. A cache hit costs nothing in either.
const WARM_MAX_PER_MIN = 40;
const warmBudget = new Map(); // userId → epoch ms[]
const warmBudgetOk = (userId) => budgetOk(warmBudget, userId, WARM_MAX_PER_MIN);

// `/api/station/next` is never cached — its whole job is to answer from what the
// evidence says now — so its only bound was the IP rate limiter. One page is
// 6-15 upstream calls; see the route for the reasoning behind this ceiling.
const STATION_NEXT_MAX_PER_MIN = 30;
const stationNextBudget = new Map();
const stationNextBudgetOk = (userId) => budgetOk(stationNextBudget, userId, STATION_NEXT_MAX_PER_MIN);

/**
 * A per-account sliding one-minute window: the shared bookkeeping behind both
 * budgets above. Returns false when the window is full.
 *
 * Keyed by user id, not IP: the point is that one signed-in client cannot spend
 * a shared resource (yt-dlp slots, YouTube's patience) on behalf of everyone
 * else, and an IP is exactly the thing a client can change.
 */
function budgetOk(map, userId, max) {
  const now = Date.now();
  const hits = (map.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= max) {
    map.set(userId, hits);
    return false;
  }
  hits.push(now);
  map.set(userId, hits);
  // Bound the bookkeeping, not the feature: the oldest account is forgettable
  // and simply starts a fresh window on its next request.
  if (map.size > 512) map.delete(map.keys().next().value);
  return true;
}

app.post('/api/warm/:videoId', {
  // Prefetching is chatty by nature (one call per track advance); it must not
  // eat into the interactive budget.
  config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  // Cache hits never spend a download budget: no process or upstream request is
  // needed. The old order let repeatedly warming an existing file exhaust the
  // user's entire cold-playback allowance.
  if (await cachedAudio(videoId)) return { ready: true };

  if (!warmBudgetOk(user.id)) {
    return reply.code(429).send({ error: 'Too many prefetches. Playback still works; wait a minute.' });
  }

  // Fire and forget: the client never waits on this, and a failure is silent
  // because the real /api/stream request will retry and report it properly.
  // ensureAudio() dedupes against an in-flight download, so a warm that races a
  // real play shares one yt-dlp process. This signal cancels only the warm's own
  // subscriber: audio.js keeps the shared producer alive while a listener still
  // needs it. Shutdown never reaches past that API to kill a shared child.
  const ac = new AbortController();
  const warm = trackDetached(`audio prefetch ${videoId}`,
    () => ensureAudio(videoId, { signal: ac.signal }), { cancel: () => ac.abort() });
  if (!warm) return reply.code(503).send({ error: 'The server is shutting down.' });
  warm.promise.catch((err) => {
    req.log.debug({ videoId, err: err.message }, 'prefetch failed');
  });
  return reply.code(202).send({ warming: true });
});

app.route({
  // GET and HEAD only. `DELETE` used to be listed here and had no branch, so a
  // DELETE fell through the handler into the download-and-stream path — the one
  // method that looks like "stop" doing the most expensive thing the server can
  // do. The client's only DELETE is the queue stream's own live route (which has
  // its branch), so nothing loses a method; the explicit `app.delete` below
  // answers 405 rather than letting Fastify 404 it.
  method: ['GET', 'HEAD'],
  url: '/api/stream/:videoId',
  // The *request rate* must never throttle audio: a single track costs several
  // ranged requests and the <audio> element treats a 429 as a decode failure.
  // Keep a ceiling, but well above normal playback. (The cold-download budget in
  // the handler is a different thing and does answer 429 — see below.)
  config: { rateLimit: { max: 6000, timeWindow: '1 minute' } },
  handler: async (req, reply) => {
    const { videoId } = req.params;
    if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
    if (!req.user) {
      // Anonymous listening exists only inside a public room. The guest cookie
      // is room-scoped and the id must be in that room's queue, so this never
      // becomes an open YouTube proxy: it serves exactly what the room is
      // playing (and has queued), nothing else. A browser may hold a guest
      // identity for several rooms at once, so any of them may authorise this
      // id — nothing is served unless one room's queue actually contains it.
      const guests = guestsFor(req);
      if (!guests.some((g) => guestStreamAllowed(g.code, videoId))) {
        return reply.code(401).send({ error: 'Not signed in.' });
      }
    }

    // Serve from cache; on a miss the first request waits for the download.
    // HEAD is the player's prefetch signal, so it must not trigger one.
    let meta;
    if (req.method === 'HEAD') {
      meta = await cachedAudio(videoId);
      if (!meta) return reply.code(204).header('cache-control', 'no-store').send();
    } else {
      const onDisk = await cachedAudio(videoId);
      // Every cold id is a real yt-dlp download, and only `maxDownloads` run at
      // once — the rest wait in an unbounded queue while their request stays
      // open. Signed in, nothing bounded how many *new* ids one account could
      // ask for (the route allows 6000 requests a minute; ranged playback alone
      // needs a few), so a few hundred distinct ids kept every slot full of
      // tracks nobody was listening to and a real play waited behind them — and
      // it is the fastest way to get the whole instance's IP bot-gated. Cache
      // hits are free and never counted: this is a budget on downloads, not on
      // playback.
      const budgetKey = req.user?.id ?? `guest:${req.ip}`;
      if (!onDisk && !warmBudgetOk(budgetKey)) {
        // Guests are room/queue-scoped but anonymous. Charge their cold work by
        // the authenticated client's IP (the socket peer unless the actual proxy
        // is allowlisted), not by a regenerable guest cookie.
        reply.header('retry-after', '60');
        return reply.code(429).send({
          error: 'Too many new tracks at once. Playback still works; wait a minute.',
          code: 'BUDGET',
        });
      }
      // A client that navigates away mid-download used to keep its yt-dlp child
      // running to completion (and hold its slot doing it). The response's
      // close is the one signal that says the listener is gone, so it aborts the
      // download and frees the slot for someone who is still listening.
      const ac = new AbortController();
      reply.raw.on('close', () => ac.abort());
      try {
        // Live broadcasts cannot be fetched to completion; fail fast instead of
        // letting yt-dlp read a never-ending stream until it times out.
        //
        // Only probed when a download is actually needed: the check is a full
        // YouTube round-trip, and a track already on disk is known-good. Paying
        // it unconditionally put ~0.2 s (much more with slow DNS) in front of
        // every cold page load for no benefit.
        if (!onDisk && (await isLive(videoId))) {
          return reply.code(502).send({ error: 'This is a live stream — not supported yet.' });
        }
        meta = await ensureAudio(videoId, { signal: ac.signal });
      } catch (err) {
        if (err.code === 'ABORTED') {
          // The download was cancelled. When this request is the one that was
          // cancelled there is nobody left to answer — hijacking keeps Fastify
          // from writing to a closed socket. When a *shared* download was
          // aborted by whoever started it, this client is still waiting and gets
          // a retryable answer instead of a connection that never resolves.
          //
          // Not logged as a failure: navigating away mid-download is normal and
          // would otherwise fill the log with one warning per page change.
          if (ac.signal.aborted) return reply.hijack();
          return reply.code(503).send({ error: 'busy, try again', code: 'BUSY' });
        }
        if (err.code === 'BUSY') {
          // Every download slot stayed taken for the whole wait: say so instead
          // of hanging the request open until the client gives up.
          return reply.code(503).send({ error: 'busy, try again', code: 'BUSY' });
        }
        req.log.warn({ videoId, err: err.message }, 'audio fetch failed');
        if (err.code === 'ENOSPC') {
          return reply.code(503).send({
            error: 'The audio cache is on a full disk. Free some space (or clear the cache) and retry.',
            code: 'ENOSPC',
          });
        }
        if (err.code === 'BOT_GATED') {
          botGateAt = Date.now();
          return reply.code(503).send({
            error: 'YouTube is blocking this IP until a sign-in is provided. Set SONORA_YTDLP_COOKIES.',
            code: 'BOT_GATED',
          });
        }
        return reply.code(502).send({ error: 'Could not fetch audio for that video.' });
      }
    }

    const range = parseRange(req.headers.range, meta.size);
    if (range === 'full') {
      // The Range header was unusable, so it is ignored rather than guessed at:
      // 200 and the whole file, with the real length. A truncated 206 here made a
      // player treat one chunk as the entire track (see parseRange).
      reply
        .header('content-type', 'audio/mp4')
        .header('accept-ranges', 'bytes')
        .header('content-length', String(meta.size))
        .header('cache-control', 'private, max-age=86400');
      if (req.method === 'HEAD') return reply.send();
      return reply.send(fs.createReadStream(meta.file));
    }
    if (!range) {
      return reply
        .code(416)
        .header('accept-ranges', 'bytes')
        .header('content-range', `bytes */${meta.size}`)
        .send();
    }

    const length = range.end - range.start + 1;
    reply
      .code(206)
      .header('content-type', 'audio/mp4')
      .header('accept-ranges', 'bytes')
      .header('content-range', `bytes ${range.start}-${range.end}/${meta.size}`)
      .header('content-length', String(length))
      .header('cache-control', 'private, max-age=86400');

    if (req.method === 'HEAD') return reply.send();

    // reply.send() of a Readable goes through stream.pipeline, so a cancelled
    // request destroys this stream (and closes its fd) rather than leaking it.
    return reply.send(fs.createReadStream(meta.file, { start: range.start, end: range.end }));
  },
});

// The audio proxy is a GET and nothing else. This is not a route that "handles"
// DELETE — it answers it, so the method is refused instead of 404'd (a client
// that DELETE'd this path used to run the *download* path, which is the one
// method-shaped mistake this route can make: "stop" doing the most expensive
// thing the server does). Fastify does not synthesise 405 on its own.
app.delete('/api/stream/:videoId', async (req, reply) => reply
  .code(405)
  .header('allow', 'GET, HEAD')
  .send({ error: 'The audio proxy only answers GET and HEAD.' }));

// ── client diagnostics ──────────────────────────────────────────────────
//
// A PWA on a locked phone has no remote console, and the hidden-playback path
// is designed to be invisible: its plan is armed minutes before it is used, and
// at the moment it matters the page is not running. That makes "it still does
// not work" unanswerable from the server — the first report after the queue
// stream shipped could not be told apart from three very different causes. So
// the client is allowed to *say* what it decided, and the answer lands in the
// log with everything else.
//
// Nothing is stored and nothing is trusted: the body is a bounded, opaque
// object that is logged at info with the account it came from. Rate-limited so
// it cannot become a write amplifier.
const CLIENT_REPORT_MAX_CHARS = 4096;
app.post('/api/client-report', {
  config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply.code(400).send({ error: 'A report must be an object.' });
  }
  const size = JSON.stringify(body).length;
  if (size > CLIENT_REPORT_MAX_CHARS) return reply.code(413).send({ error: 'Report too large.' });
  if (typeof body.event !== 'string' || body.event.length > 40) {
    return reply.code(400).send({ error: 'A report needs a short event name.' });
  }
  // The rest is attacker-controlled JSON, so it does not go into the log as
  // structured fields: a key here becomes a field in the log line, and a value
  // with a newline in it forges the next line wherever the log is not JSON. One
  // compact, single-line, bounded string instead — the event name stays a field
  // because it is the thing a search greps for, and it is length-checked above.
  const { event, ...detail } = body;
  const summary = JSON.stringify(detail)
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
    .slice(0, 2000);
  req.log.info({ event, report: summary, userId: user.id, size }, 'client report');
  return reply.code(204).send();
});

// ── the queue as one continuous stream ──────────────────────────────────
// The client asks for a plan while it is visible and playing, and points the
// <audio> element at the stream when the page goes hidden. That is the only
// shape in which a locked iPhone keeps playing across a track boundary: the
// media process keeps streaming, the page's script is suspended, and nothing
// has to run at the boundary. src/queue-stream.js carries the whole argument.
//
// The plan is a *player* endpoint: every id must already be in the audio cache
// (the player filled it), so this cannot be used to fetch a track cold or to
// browse YouTube through the server.
app.post('/api/queue-stream/plan', {
  // One call per track start, plus retries; cheap, but not a hot path.
  config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return reply.code(400).send({ error: 'ids must be an array of video ids.' });
  if (ids.length > 200) return reply.code(400).send({ error: 'Too many ids.' });
  const plan = await planQueueStream({ userId: user.id, videoIds: ids });
  if (!plan.token) {
    // Nothing cached yet: the caller keeps the per-track player, which is what
    // it was doing before this endpoint existed.
    return reply.code(409).send({ error: 'Nothing to stream yet.', code: 'EMPTY' });
  }
  return reply.header('cache-control', 'no-store').send(plan);
});

app.route({
  method: ['GET', 'HEAD', 'DELETE'],
  // The URL ends in `.m3u8` because the engines do: Chromium and WebKit both
  // refuse a playlist served from an extensionless path with a perfect
  // `application/vnd.apple.mpegurl` content type (measured: same bytes, same
  // headers, `.m3u8` plays and the bare path is NotSupportedError). The name is
  // part of the contract, not decoration.
  url: '/api/queue-stream/:token/live.m3u8',
  // The media process re-fetches the playlist about every segment (6 s) for as
  // long as the phone stays locked, and one segment request rides along with
  // each. Generous, but bounded.
  config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  handler: async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const plan = getPlan(req.params.token, user.id);
    if (!plan) return reply.code(404).send({ error: 'Unknown or expired stream.', code: 'NO_PLAN' });
    const atMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(Number(req.query?.at) || 0)));

    // The session is created by the first playlist request and lives until the
    // listener goes quiet: every later request is a file read and a string
    // build, no ffmpeg.
    // HEAD is the app's "is this endpoint really there" probe; answering it
    // must not pay for an ffmpeg process. DELETE is the client saying it is
    // done: tear the session (and its ffmpeg tail) down now rather than after
    // the idle timeout, so a listener who skips around does not stack sessions
    // into the per-user cap.
    if (req.method === 'HEAD') {
      return reply.header('content-type', 'application/vnd.apple.mpegurl').send();
    }
    if (req.method === 'DELETE') {
      closeSession(req.params.token, user.id);
      return reply.code(204).send();
    }
    let session = getSession(req.params.token, user.id);
    if (!session) {
      try {
        const opened = await openQueueStream(plan.tracks, atMs, user.id);
        session = opened.session;
        attachSession(req.params.token, session);
      } catch (err) {
        if (err.code === 'BUSY') {
          reply.header('retry-after', '30');
          return reply.code(429).type('application/json')
            .send({ error: 'Too many open streams. Try again shortly.', code: 'BUSY' });
        }
        req.log.warn({ err: err.message }, 'queue stream failed to start');
        return reply.code(503).send({ error: 'Could not start the stream.' });
      }
    }
    // A new `k` means the client assigned a new `src` (a seek, or a fresh
    // entry): its `at` repositions the window. Polls carry the same `k` and
    // ride the consumption clock instead.
    maybeReposition(session, atMs, req.query?.k ?? null);
    // The window is whatever the listener is about to need; producing it here
    // is what makes a cold open or a far seek start within a segment cut
    // (~0.5 s of encode) rather than waiting for a broadcast to reach it.
    const seqs = windowSeqs(session, sessionNow(session));
    await ensureSegments(session, seqs);
    return reply
      .header('content-type', 'application/vnd.apple.mpegurl')
      .header('cache-control', 'no-store')
      .send(playlistFor(session, seqs));
  },
});

// One produced segment. A sequence number is cut exactly once, so unlike the
// playlist a segment is immutable and may be cached by the client (and by
// anything in front of it) — which is what lets a locked phone retry a fetch
// without touching the server twice.
app.get('/api/queue-stream/:token/seg/:name', {
  config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const session = getSession(req.params.token, user.id);
  if (!session) return reply.code(404).send({ error: 'Unknown or expired stream.', code: 'NO_PLAN' });
  const match = /^(\d+)\.ts$/.exec(req.params.name ?? '');
  if (!match) return reply.code(404).send({ error: 'No such segment.' });
  const seq = Number(match[1]);
  if (seq > seqAt(session.coverEnd - 1)) return reply.code(404).send({ error: 'Past the end of the stream.' });
  // Cut on demand: the playlist normally ensures ahead of the listener, but a
  // direct fetch (a retry, or a seek to a position nothing has produced yet)
  // must be served too — this is what makes the stream seekable.
  await ensureSegment(session, seq);
  const bytes = readSegment(session, seq);
  if (!bytes) return reply.code(404).send({ error: 'Segment could not be produced.', code: 'PENDING' });
  noteSegmentFetch(session, seq);
  // `no-store`, not `immutable`: a segment is immutable in content, but a
  // caching layer in front (the tunnel) that ever serves a partial copy would
  // pin that corruption for an hour. Re-fetching a 120 KB file is cheaper than
  // a locked phone stuck on a bad segment.
  return reply
    .header('content-type', 'video/mp2t')
    .header('cache-control', 'no-store')
    .header('content-length', String(bytes.length))
    .send(bytes);
});

// The API surface this build serves, advertised so a client can tell whether
// the server it reached is the one it was written for.
//
// This exists because of a real outage: `public/` is read from disk per request
// while `src/` is frozen at process start, so a server left running across a
// deploy served the *new* app.js with the *old* routes. The app showed a bare
// "Not Found" on a page whose endpoint simply did not exist yet, which reads as
// a code bug rather than a stale process. The client now checks this list.
const API_FEATURES = [
  'auth', 'search', 'radio', 'station', 'station-next', 'dislikes', 'likes', 'playlists',
  'browse-playlists', 'album', 'album-of', 'artist', 'events', 'stream', 'lyrics', 'artwork', 'admin',
  // Client diagnostics: an authenticated, bounded `POST /api/client-report` that
  // only writes a log line. A client that reports must know the server takes it.
  'client-report',
  // The queue as one continuous stream: a locked iPhone runs no page script, so
  // the only way the next track plays there is for the *server* to have already
  // concatenated it. A client that offers that must know the server can (a
  // stale process would 404 exactly when the phone locks, when nobody can see
  // the reason).
  'queue-stream',
  // `GET /api/search` answers songs, artists, albums and playlists in one
  // request and takes `?type=`. The flag lets a client tell a server whose
  // search returns only `{ tracks, artists }` from one that knows the tabs, so
  // a stale process does not render empty Albums/Playlists filters.
  'search-types',
  // The station stopped being one same-artist neighbourhood: a page is now a
  // mix of four lanes (see stationPage). The flag lets a client tell a server
  // that knows about `lanes` from one that predates it.
  'station-lanes',
  // Account security: saved devices with rotating refresh tokens, and passkeys.
  // A client that offers either needs both, and a stale server would 404.
  'devices',
  'passkeys',
  // Listen Together: shared rooms with a server-owned playhead, and the SSE
  // stream that pushes state to everyone in one.
  'rooms',
  'rooms-stream',
  // Anonymous listening inside a public room (no account required)
  'rooms-guests',
  // The host can hand the room to another member: PATCH /api/rooms/:code/host.
  // A stale server would 404 there, and the "host walked away" state would look
  // like a client bug.
  'rooms-host',
  // Following an artist and the notification bell. A client that offers either
  // needs the follow routes *and* the sweep that fills the bell; without these
  // flags a stale server would answer 404 to a follow and never notify anyone.
  'follows',
  'notifications',
];

/**
 * Is the audio directory (or the nearest directory that would have to be
 * created for it) writable?
 *
 * The directory itself is created lazily by the first download, so "missing" is
 * not a failure — a *parent that cannot be written to* is, and that is exactly
 * the state that answers 200 on every API call while playback dies on the first
 * cold track. Checks the nearest existing ancestor and stops there.
 */
function audioDirWritable() {
  let dir = config.audioDir;
  for (let hops = 0; hops < 8; hops += 1) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      if (fs.existsSync(dir)) return false; // present but not writable
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
  return false;
}

/**
 * Is this instance actually usable?
 *
 * This used to be a literal `{ ok: true }`: the container healthcheck only ever
 * proved that the process answered HTTP, so `podman ps` reported `(healthy)` on
 * an instance nobody could sign into (first run with SONORA_PASSPHRASE unset —
 * bootstrapUser() only warns and keeps serving) and on one whose audio directory
 * could not be written (every cold track fails, nothing restarts). The checks are
 * the cheapest ones that distinguish those states: one indexed COUNT on the
 * users table, and a W_OK on the audio directory. No yt-dlp probe — a healthcheck
 * is polled every 30 s and must not spawn subprocesses or touch the network.
 *
 * The HTTP status stays 200 deliberately: `scripts/healthcheck.js` reads `ok`
 * from the body and exits non-zero itself, and every test fixture, the client
 * boot check and any proxy in front of this route treat a 200 as "the server is
 * answering". An unhealthy *answer* and an unreachable *server* are different
 * failures and should not be conflated.
 *
 * The body is split by who asks. Signed out it carries only the verdict, the
 * reason and the feature list — what the container healthcheck and the client's
 * stale-server check read — because this route must answer without a session and
 * must not describe the host to whoever asks. The account count and the audio
 * directory's state are added for a signed-in caller.
 */
app.get('/api/health', async (req) => {
  let users = 0;
  let dbOk = true;
  try {
    users = SQL.userCount.get().n;
  } catch {
    // A locked or corrupt database is exactly what an operator needs to see.
    dbOk = false;
  }
  const audioOk = audioDirWritable();
  // No users *and* no passphrase: bootstrapUser() has nothing to create, and
  // there is no account anybody could sign into. That is not "healthy".
  const signedInPossible = users > 0 || Boolean(config.bootstrapPass);
  const reason = closing ? 'shutting-down'
    : !dbOk ? 'database-unreadable'
      : !audioOk ? 'audio-dir-not-writable'
        : !signedInPossible ? 'no-account'
          : null;
  const health = {
    // Keep HTTP 200 (see above): this is the process's own verdict, while the
    // `ready` field makes the shutting-down state explicit to JSON health probes.
    // Status-code-only load-balancer readiness remains a separate API decision;
    // changing this long-standing status would also change every health client.
    ok: reason === null,
    ready: reason === null,
    reason,
    // The two probes behind `reason`, plus the sign-in verdict — no counts and no
    // host paths. This route has to be public (the container healthcheck and the
    // client's stale-server check both call it signed-out), so the body must not
    // describe the host: an unauthenticated caller could otherwise read how many
    // accounts an instance has and whether its audio directory is writable —
    // reconnaissance with no legitimate public use.
    checks: { server: !closing, db: dbOk, signIn: signedInPossible },
    ts: new Date().toISOString(),
    // Not optional: a client uses this list to tell a stale process from a
    // broken app (see API_FEATURES), and it is the public API surface by design.
    features: API_FEATURES,
    // Distinguishes "restarted" from "rebuilt": a stale process keeps its old
    // start time, which is the first thing to check when an endpoint 404s.
    startedAt: startedAt.toISOString(),
    // `pid` stays public: every test fixture in this repository identifies *its
    // own* server by `health.pid === child.pid` (19 files — it is how a freshly
    // spawned instance is told apart from a stale one still holding the port),
    // and a pid is not a secret the host does not already publish. What was worth
    // hiding — the account count and the audio directory's state — moved to the
    // authenticated block below.
    pid: process.pid,
  };
  // The rest is for the operator, who is signed in: `req.user` is the same
  // best-effort session read every request gets (`onRequest` sets it, and an
  // absent or expired cookie simply leaves it null). No requireUser here — this
  // route must never answer 401 to the healthcheck.
  if (req.user) {
    health.checks.users = users;
    health.checks.audioDir = audioOk;
  }
  return health;
});

// Playback health, so the UI can explain an external block instead of just
// failing. YouTube periodically gates whole IPs behind "sign in to confirm you
// are not a bot"; when that happens every fetch fails identically.
let botGateAt = null;
const BOT_GATE_TTL_MS = 30 * 60_000;

/**
 * One staleness rule for listener, admin and diagnostic reports.
 *
 * The old listener status expired the boolean but still exposed the old timestamp,
 * while every admin/diagnostic response reported the gate forever. Expire the
 * source value once, here, so no response can disagree with another (or turn a
 * half-hour-old transient block into a permanent banner).
 */
function botGateState(now = Date.now()) {
  if (botGateAt !== null && now - botGateAt >= BOT_GATE_TTL_MS) botGateAt = null;
  return {
    botGated: botGateAt !== null,
    botGateAt: botGateAt !== null ? new Date(botGateAt).toISOString() : null,
  };
}

// Database maintenance in progress, if any (see the vacuum/backup routes).
//
// `db` is node:sqlite's DatabaseSync, so VACUUM and VACUUM INTO rewrite the file
// *on the event loop*: for the whole operation this process answers nothing at
// all — no JSON route, and no next 1 MiB range for anyone mid-song. Two things
// follow, and this flag is how both are surfaced: only one such job may run at a
// time (a second would double the stall and fight for the same lock), and clients
// and operators can see why everything just froze instead of guessing.
let maintenance = null; // { job, startedAt }

app.get('/api/status', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const jar = jarStatus();
  return {
    ...botGateState(),
    cookiesConfigured: jar.connected,
    jar,
    // Present only while a synchronous compaction is holding the event loop.
    maintenance,
  };
});

// ── connecting a YouTube session ───────────────────────────────────────
// An in-app Google sign-in is not possible: Google refuses OAuth in embedded
// webviews (disallowed_useragent), and YouTube's auth cookies are HttpOnly so a
// bookmarklet cannot read them either. The supported path is the same one the
// yt-dlp docs describe: export cookies.txt from a real browser, then import it
// here. The jar is encrypted at rest and never sent back to a client.

const TEST_VIDEO = 'dQw4w9WgXcQ';

/**
 * Probe YouTube with (or without) a cookie jar.
 * Returns { ok, code, detail } where code is 'OK' | 'BOT_GATED' | 'OTHER'.
 */
async function probe({ cookiePath = null } = {}) {
  try {
    await runProcess(ytdlpBin(), [
      ...(cookiePath ? ['--cookies', cookiePath] : []),
      '--simulate', '--no-warnings', '--no-playlist',
      '-f', '140/bestaudio[ext=m4a]',
      // The *same transport* as the downloader (proxy, PO-token provider, JS
      // runtime). Without it the probe tested a different client than playback:
      // a working cookies.txt that only works through the configured proxy was
      // rejected as "not a signed-in session", the app opened the Connect sheet
      // on every device, and /api/status reported bot-gated for the whole
      // instance while downloads kept succeeding.
      ...ytdlpExtraArgs(),
      `https://www.youtube.com/watch?v=${TEST_VIDEO}`,
    ], { timeoutMs: 45_000 });
    return { ok: true, code: 'OK', detail: null };
  } catch (err) {
    const msg = String(err.message ?? '');
    // Never echo cookie material, even if a future yt-dlp version includes it.
    const clean = msg.replace(/[A-Za-z0-9_\-]{40,}/g, '<redacted>').slice(0, 300);
    if (err.code === 'BOT_GATED' || /sign in to confirm|not a bot|asking for sign-in/i.test(msg)) {
      return { ok: false, code: 'BOT_GATED', detail: clean };
    }
    return { ok: false, code: 'OTHER', detail: clean };
  }
}

/**
 * Decide what an import actually proved.
 *
 * A single successful probe is NOT evidence the cookies work: when the IP is
 * not gated, YouTube serves the probe with no cookies at all. So we also probe
 * without the jar and compare:
 *
 *   baseline fails, jar works   -> 'verified'  (the jar unblocked a gated IP)
 *   baseline works, jar works   -> 'unproven'  (nothing was blocked; can't tell)
 *   jar fails with an auth error-> 'rejected'  (cookies are bad/expired)
 *   jar fails for other reasons -> 'unproven'  (inconclusive, not the jar's fault)
 */
async function verifyJar(cookiePath) {
  const [baseline, withJar] = await Promise.all([
    probe(),
    probe({ cookiePath }),
  ]);

  if (withJar.ok && !baseline.ok) {
    return { status: 'verified', reason: 'YouTube was blocking this server and these cookies unblocked it.' };
  }
  if (withJar.ok && baseline.ok) {
    return {
      status: 'unproven',
      reason: 'Saved. YouTube was not blocking this server right now, so there was nothing for the cookies to prove — they will be used for playback anyway.',
    };
  }
  if (withJar.code === 'BOT_GATED') {
    return {
      status: 'rejected',
      reason: 'YouTube still asked for a sign-in, so these cookies are not a signed-in session (expired, or exported from a browser that was not signed in).',
    };
  }
  return {
    status: 'unproven',
    reason: `Saved, but YouTube could not be reached to test them (${withJar.detail ?? 'unknown error'}).`,
  };
}

// Import/verify each await subprocesses and saveJar/clearJar also await filesystem
// work. Serialise the whole operations, not just their final writes: otherwise a
// disconnect can fit inside an import's first save and the old DB writes then
// resurrect the jar. The tail stays resolved after a failure so a bad import never
// wedges later cookie administration.
let cookieOperationTail = Promise.resolve();
function serialiseCookieOperation(work) {
  const result = cookieOperationTail.then(work);
  cookieOperationTail = result.catch(() => {});
  return result;
}

app.post('/api/youtube/cookies', {
  // A real Google/YouTube export exceeds the global 64 KB body limit, so the
  // framework's opaque "Payload Too Large" won the race against this handler's
  // own 512 KB check (which could therefore never fire). The limit has to be on
  // the route, not only in the handler.
  config: { rateLimit: { max: 10, timeWindow: '5 minutes' }, bodyLimit: 512 * 1024 },
}, async (req, reply) => {
  // The jar is instance-wide, so replacing it is an admin action. A normal
  // listener can still see the gate status and ask an admin to fix it.
  const admin = requireAdmin(req, reply);
  if (!admin) return;

  const text = String(req.body?.cookies ?? '');
  if (!text.trim()) return reply.code(400).send({ error: 'Paste your cookies.txt contents first.' });
  if (text.length > 512 * 1024) return reply.code(413).send({ error: 'That file is too large to be a cookies.txt.' });

  const { format, cookies } = parseAny(text);
  if (!cookies.length) {
    return reply.code(400).send({
      error: format === 'unknown'
        ? 'Could not read that. Paste the raw cookies.txt contents (Netscape format), not a screenshot or partial copy.'
        : 'No cookies found in that input.',
    });
  }

  const info = inspectJar(cookies);
  if (!info.hasIdentity) {
    // The most common real mistake: exporting while on youtube.com, where the
    // Google identity cookies (SID/HSID/SSID…) are not visible, so the export
    // contains only visitor cookies and cannot authenticate.
    return reply.code(400).send({
      error: `No sign-in cookie in that export. Found ${info.youtubeCount} cookie(s) `
        + `(${info.sampleNames.join(', ') || 'none'}) but no SID/__Secure-*-PSID. `
        + 'Export again while signed in at google.com — the sign-in cookies live on the '
        + 'google.com domain and are not visible from a youtube.com-only export.',
      jar: info,
      format,
    });
  }

  // Store first, then test. A jar is kept even when the probe is inconclusive:
  // destroying a possibly-good jar because a *test* failed would be worse than
  // leaving it for playback to try.
  return serialiseCookieOperation(async () => {
    await saveJar(cookies, text);
    const verdict = await verifyJar(activeCookiesPath());
    await saveJar(cookies, text, verdict);
    audit(admin, 'youtube.cookies.import', jarStatus().source,
      `format=${format}; cookies=${info.total}; verdict=${verdict.status}`);

    if (verdict.status === 'rejected') {
      // Keep it (so the user can replace it) but make the state honest.
      botGateAt = Date.now();
      resetYT();
      return reply.code(400).send({ error: verdict.reason, jar: jarStatus(), verdict });
    }

    botGateAt = null;
    resetYT();
    req.log.info({ cookies: info.total, verdict: verdict.status }, 'youtube session imported');
    return { ok: true, jar: jarStatus(), verdict };
  });
});

/** Re-test the stored jar on demand (e.g. after the gate clears). */
app.post('/api/youtube/verify', {
  // Two full yt-dlp probes per call; the generic API budget is far too generous
  // for something that spawns subprocesses.
  config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  return serialiseCookieOperation(async () => {
    const cookiePath = activeCookiesPath();
    if (!cookiePath) return reply.code(400).send({ error: 'No cookies are stored yet.' });
    const source = jarStatus().source;
    const verdict = await verifyJar(cookiePath);
    // Verification observes a jar; it does not re-import one. In particular an
    // environment fallback's good verdict must never relabel (and reactivate) a
    // rejected imported jar. The outcome is audited without copying secret text.
    audit(admin, 'youtube.cookies.verify', source, `verdict=${verdict.status}`);
    if (verdict.status === 'verified') botGateAt = null;
    resetYT();
    return { verdict, jar: jarStatus() };
  });
});

/**
 * Staged diagnostic. The point is to say *which* layer is failing instead of a
 * single opaque "playback failed".
 *
 * Admin-only: one call spawns yt-dlp (up to 45 s) plus several network probes,
 * and the answer names the deployment's proxy and PO-token endpoints. Any
 * signed-in listener could run it four times a minute and read back the
 * infrastructure — a household member has no need for that, and a listener who
 * cannot play only needs `GET /api/youtube/status` and the bot-gate message the
 * playback routes already carry. (The client's "Run diagnostics" button on the
 * listener sheet now needs an admin session — see the report.)
 *
 * The URLs are still redacted: a socks5 proxy URL can carry a username and
 * password, and this answer ends up in a screenshot in a bug report.
 */
const redactUrl = (value) => String(value ?? '').replace(/\/\/[^/\s@]+@/g, '//***@');

app.get('/api/youtube/diagnose', {
  // Rate limit kept: the route now needs an admin, but an admin double-clicking
  // still must not be able to spawn subprocesses back to back.
  config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
}, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const steps = [];
  const add = (name, ok, detail) => steps.push({ name, ok, detail });

  // 1. PO token provider reachable?
  if (config.potProviderUrl) {
    try {
      const r = await fetch(`${config.potProviderUrl}/ping`, { signal: AbortSignal.timeout(4000) });
      add('PO token provider', r.ok, r.ok ? redactUrl(config.potProviderUrl) : `HTTP ${r.status}`);
    } catch {
      add('PO token provider', false, `not reachable at ${redactUrl(config.potProviderUrl)} — start the bgutil container`);
    }
  } else {
    add('PO token provider', true, 'disabled');
  }

  // 2. JS runtime present?
  add('JS runtime', Boolean(config.jsRuntime), config.jsRuntime || 'not configured (yt-dlp extraction is weaker without one)');

  // 3. Proxy configured? This is advisory: everything can work without one.
  add('Proxy', config.ytdlpProxy ? true : null,
    config.ytdlpProxy ? redactUrl(config.ytdlpProxy) : 'none — the server uses its own IP, which YouTube may gate');

  // 4. Metadata via youtubei.js (usually works even when gated)
  try {
    const yt = await getYT();
    const info = await yt.getBasicInfo(TEST_VIDEO, { client: 'IOS' });
    const status = info.playability_status?.status;
    add('Metadata (youtubei.js)', status === 'OK', `playability=${status}${info.playability_status?.reason ? ` (${String(info.playability_status.reason).slice(0, 80)})` : ''}`);
  } catch (err) {
    add('Metadata (youtubei.js)', false, err.message.slice(0, 120));
  }

  // 5. Extraction + full-file reachability via yt-dlp
  const extraction = await probe({ cookiePath: activeCookiesPath() });
  add('Extraction (yt-dlp)', extraction.ok,
    extraction.ok ? 'resolved a real video' : `${extraction.code}: ${extraction.detail ?? 'failed'}`);

  const jar = jarStatus();
  // The proxy is advisory, so it does not decide the verdict: what matters is
  // whether extraction actually succeeded.
  return {
    ok: steps.every((s) => s.ok !== false),
    steps,
    jar,
    botGated: botGateState().botGated,
    advice: extraction.ok
      ? 'Everything needed for playback is working.'
      : extraction.code === 'BOT_GATED'
        ? (jar.connected
          ? 'YouTube is gating this IP and the stored cookies did not satisfy it. Try re-exporting from google.com, or route yt-dlp through a proxy (SONORA_YTDLP_PROXY).'
          : 'YouTube is gating this IP. Connect a session, or route yt-dlp through a proxy (SONORA_YTDLP_PROXY).')
        : 'yt-dlp failed for a reason unrelated to the bot gate — see the step detail.',
  };
});


app.get('/api/youtube/status', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return { jar: jarStatus(), botGated: botGateState().botGated };
});

app.delete('/api/youtube/cookies', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  return serialiseCookieOperation(async () => {
    const source = jarStatus().source;
    try {
      await clearJar();
    } catch (err) {
      // clearJar deliberately deletes plaintext first and leaves the encrypted
      // recovery copy in place when unlink fails. Do not reset YouTube or clear the
      // gate: a still-present jar may still be active, so success would be a lie.
      const code = /^[A-Z0-9_]+$/.test(String(err?.code)) ? err.code : 'UNLINK_FAILED';
      audit(admin, 'youtube.cookies.clear_failed', source, `code=${code}`);
      req.log.warn({ code }, 'youtube cookie removal failed');
      return reply.code(500).send({ error: 'Could not remove the cookie jar. No connection state was reset.', code: 'COOKIE_CLEAR_FAILED' });
    }
    resetYT();
    botGateAt = null;
    audit(admin, 'youtube.cookies.clear', source);
    return { ok: true, jar: jarStatus() };
  });
});

// ── admin ───────────────────────────────────────────────────────────────
// Everything here is gated by the `role` column, re-read from the database on
// every request. There is no client-side role claim to trust or forge.
//
// The surface is deliberately split by what an admin actually changes:
// users, library content, local storage, and the instance's YouTube identity.
// Destructive actions are recorded in admin_audit so a mistake is explainable.

const USERNAME = /^[A-Za-z0-9._-]{1,40}$/;
// Six characters was the whole policy, and the passphrase is the only factor on
// an instance whose login name is a known constant (SONORA_USER defaults to
// `admin`). Twelve is the shortest length that makes an offline dictionary pass
// on the stored scrypt hash impractical rather than trivial, and the scrypt cost
// is not the defence here: nothing rate-limits a copy of the database file.
const MIN_PASSWORD = 12;

/**
 * Why this passphrase is not acceptable, or null when it is.
 *
 * Length alone would accept `aaaaaaaaaaaa`, so the four-distinct-character floor
 * rejects the padding people type to satisfy a length rule. It is a floor, not a
 * strength meter: guessing entropy cannot be measured from one string, and a
 * rule that pretends to ("must contain a symbol") produces `Password1!` and
 * nothing else.
 */
function passwordProblem(passphrase) {
  const pass = String(passphrase ?? '');
  if (pass.length < MIN_PASSWORD) {
    return `Passphrase must be at least ${MIN_PASSWORD} characters.`;
  }
  if (new Set(pass).size < 4) {
    return 'Passphrase must use at least four different characters.';
  }
  return null;
}

function audit(actor, action, target = null, detail = null) {
  recordAudit({
    actorId: actor.id, actorName: actor.name, action, target, detail,
  });
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function dbBytes() {
  const base = config.dbPath;
  return {
    path: base,
    bytes: fileBytes(base) + fileBytes(`${base}-wal`) + fileBytes(`${base}-shm`),
  };
}

app.get('/api/admin/overview', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return {
    counts: adminCounts(),
    storage: await cacheStats(),
    db: dbBytes(),
    audit: listAudit(12),
    jar: jarStatus(),
    botGated: botGateState().botGated,
    system: {
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid,
      platform: `${process.platform} ${process.arch}`,
    },
  };
});

app.get('/api/admin/users', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  return { users: listUsersWithStats(), me: admin.id, roles: ROLES };
});

app.post('/api/admin/users', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;

  const name = String(req.body?.name ?? '').trim();
  const passphrase = String(req.body?.passphrase ?? '');
  const role = ROLES.includes(String(req.body?.role)) ? String(req.body.role) : 'user';

  if (!USERNAME.test(name)) {
    return reply.code(400).send({ error: 'Name must be 1–40 characters: letters, numbers, dot, dash or underscore.' });
  }
  const passProblem = passwordProblem(passphrase);
  if (passProblem) return reply.code(400).send({ error: passProblem });
  if (findUser(name)) return reply.code(409).send({ error: 'That name is already taken.' });

  const created = transaction(() => {
    const user = createUser(name, passphrase, role);
    audit(admin, 'user.create', name, `role=${role}`);
    return user;
  });
  return reply.code(201).send({ user: publicUser(getUser(created.id)) });
});

app.patch('/api/admin/users/:id', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;

  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad user id.' });
  const target = getUser(id);
  if (!target) return reply.code(404).send({ error: 'No such user.' });

  const b = req.body ?? {};
  const isSelf = id === admin.id;

  // Validate every requested change BEFORE applying any of them. A partial
  // update (role changed, then a bad password rejected) would be a bug the
  // caller cannot see or undo.
  const nextRole = b.role === undefined ? null : String(b.role);
  if (nextRole !== null && !ROLES.includes(nextRole)) {
    return reply.code(400).send({ error: 'Unknown role.' });
  }
  if (b.disabled !== undefined && typeof b.disabled !== 'boolean') {
    return reply.code(400).send({ error: 'disabled must be a boolean.' });
  }
  const nextDisabled = b.disabled === undefined ? null : b.disabled;
  const nextPassword = b.password === undefined ? null : String(b.password);
  if (nextPassword !== null) {
    const passProblem = passwordProblem(nextPassword);
    if (passProblem) return reply.code(400).send({ error: passProblem });
  }

  // Guards that keep an instance from locking itself out. Only an *active*
  // admin counts, so cleaning up an already-disabled admin is still allowed.
  const removingLastAdmin = (role, disabled) => {
    const wasActiveAdmin = target.role === 'admin' && !target.disabled;
    if (!wasActiveAdmin) return false;
    const stillActiveAdmin = (role ?? target.role) === 'admin' && !(disabled ?? Boolean(target.disabled));
    return !stillActiveAdmin && countAdmins() <= 1;
  };

  if (nextRole !== null && nextRole !== target.role) {
    if (isSelf && nextRole !== 'admin') {
      return reply.code(400).send({ error: 'You cannot remove your own admin role.' });
    }
    if (removingLastAdmin(nextRole, nextDisabled)) {
      return reply.code(400).send({ error: 'At least one active admin is required.' });
    }
  }
  if (nextDisabled === true && nextDisabled !== Boolean(target.disabled)) {
    if (isSelf) return reply.code(400).send({ error: 'You cannot disable your own account.' });
    if (removingLastAdmin(nextRole, true)) {
      return reply.code(400).send({ error: 'At least one active admin is required.' });
    }
  }

  const changed = [];
  // One write lock covers the fresh last-admin guard, every revocation and the
  // audit row. A concurrent CLI/HTTP change therefore cannot fit between the
  // guard and the mutation, and an acknowledged role change cannot lack its log.
  transaction(() => {
    const current = getUser(id);
    if (!current) throw httpError(404, 'No such user.');
    if (isSelf && nextRole !== null && nextRole !== current.role && nextRole !== 'admin') {
      throw httpError(400, 'You cannot remove your own admin role.');
    }
    if (isSelf && nextDisabled === true && nextDisabled !== Boolean(current.disabled)) {
      throw httpError(400, 'You cannot disable your own account.');
    }
    const wasActiveAdmin = current.role === 'admin' && !current.disabled;
    const remainsActiveAdmin = (nextRole ?? current.role) === 'admin'
      && !(nextDisabled ?? Boolean(current.disabled));
    if (wasActiveAdmin && !remainsActiveAdmin && countAdmins() <= 1) {
      throw httpError(400, 'At least one active admin is required.');
    }

    if (nextRole !== null && nextRole !== current.role) {
      setUserRole(id, nextRole);
      changed.push(`role=${nextRole}`);
    }
    if (nextDisabled !== null && nextDisabled !== Boolean(current.disabled)) {
      setUserDisabled(id, nextDisabled);
      // A disabled account must lose its existing stateless sessions and any
      // remembered device, or "disabled" would only hold until the access cookie
      // expires.
      if (nextDisabled) {
        bumpSessionVersion(id);
        revokeAllRefreshTokens(id);
        deleteAllDevices(id);
      }
      changed.push(nextDisabled ? 'disabled' : 'enabled');
    }
    if (nextPassword !== null) {
      setUserPassword(id, nextPassword);
      bumpSessionVersion(id);
      // A password reset is a revocation event: every remembered device
      // has to prove itself again with the new passphrase.
      revokeAllRefreshTokens(id);
      deleteAllDevices(id);
      changed.push('password reset');
    }
    if (changed.length) audit(admin, 'user.update', current.name, changed.join(', '));
  });

  return {
    user: publicUser(getUser(id)),
    changed,
    // Resetting your own password revokes the session you are using right now.
    signedOut: isSelf && changed.includes('password reset'),
  };
});

app.post('/api/admin/users/:id/signout', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad user id.' });
  const target = getUser(id);
  if (!target) return reply.code(404).send({ error: 'No such user.' });
  transaction(() => {
    bumpSessionVersion(id);
    revokeAllRefreshTokens(id);
    deleteAllDevices(id);
    audit(admin, 'user.signout', target.name);
  });
  return { ok: true, self: id === admin.id };
});

app.post('/api/admin/users/:id/clear-history', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad user id.' });
  const target = getUser(id);
  if (!target) return reply.code(404).send({ error: 'No such user.' });
  const removed = clearUserHistory(id);
  // Drops cached pages and invalidates/coordinates builds already in flight.
  invalidateStation(id);
  audit(admin, 'user.clear-history', target.name, `${removed} play events`);
  return { ok: true, removed };
});

app.delete('/api/admin/users/:id', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const id = positiveSafeId(req.params.id);
  if (id === null) return reply.code(400).send({ error: 'Bad user id.' });
  if (id === admin.id) return reply.code(400).send({ error: 'You cannot delete your own account.' });

  const target = getUser(id);
  if (!target) return reply.code(404).send({ error: 'No such user.' });
  transaction(() => {
    const current = getUser(id);
    if (!current) throw httpError(404, 'No such user.');
    if (current.role === 'admin' && !current.disabled && countAdmins() <= 1) {
      throw httpError(400, 'At least one active admin is required.');
    }
    deleteUser(id);
    audit(admin, 'user.delete', current.name, `role=${current.role}`);
  });
  return { ok: true };
});

app.get('/api/admin/tracks', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const q = String(req.query?.q ?? '').trim().slice(0, 200);
  const limit = Number(req.query?.limit ?? 100);
  if (!Number.isSafeInteger(limit)) return reply.code(400).send({ error: 'Limit must be a safe integer.' });
  return { tracks: listTracksForAdmin(q, limit), q };
});

app.delete('/api/admin/tracks/:videoId', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const existed = deleteTrack(videoId);
  const fileRemoved = await removeCachedAudio(videoId);
  if (!existed && !fileRemoved) return reply.code(404).send({ error: 'No such track.' });
  audit(admin, 'track.delete', videoId);
  return { ok: true };
});

app.get('/api/admin/storage', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { cache: await cacheStats(), db: dbBytes() };
});

app.post('/api/admin/storage/prune', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const mb = Number(req.body?.maxMb);
  // A limit in megabytes; 1 TB is a sane ceiling for a personal instance.
  const maxBytes = Number.isFinite(mb) && mb > 0
    ? Math.round(Math.min(mb, 1_048_576) * 1024 * 1024)
    : config.cacheBytes;
  const result = await pruneCacheTo(maxBytes);
  audit(admin, 'storage.prune', null, `${result.removed} files; limit ${maxBytes} bytes`);
  return { ...result, maxBytes, cache: await cacheStats() };
});

app.post('/api/admin/storage/clear', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const result = await clearCache();
  audit(admin, 'storage.clear', null, `${result.removed} files`);
  return { ...result, cache: await cacheStats() };
});

// ── database maintenance ────────────────────────────────────────────────
// Both routes below run a synchronous, whole-file rewrite on the event loop, so
// they share one guard: refuse when another such job is already running (two
// VACUUMs double the freeze and fight over the same exclusive lock), and refuse
// when the free space cannot hold the second copy a VACUUM needs — a disk that
// fills mid-compaction is the one way this can lose data.
const MAINTENANCE_STALE_MS = 15 * 60_000;

/** Free bytes on the filesystem holding `dir`, or null when it cannot be read. */
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * Take the maintenance flag, or answer the request and report that it did.
 *
 * Returns null on success, or the already-sent reply (409 when another job holds
 * the flag, 507 when there is not enough free space) — the caller returns it as
 * its handler result. The flag is cleared in a `finally` by the caller, so a
 * throw cannot wedge the instance into "always busy"; one older than
 * MAINTENANCE_STALE_MS is treated as debris from a crash, not a live lock.
 */
function beginMaintenance(job, reply, { needBytes = 0, spaceDir = path.dirname(config.dbPath) } = {}) {
  if (maintenance && Date.now() - Date.parse(maintenance.startedAt) < MAINTENANCE_STALE_MS) {
    reply.header('retry-after', '60');
    return reply.code(409).send({
      error: `A database ${maintenance.job} is already running. Everything, including playback, is paused until it finishes.`,
      code: 'MAINTENANCE',
      maintenance,
    });
  }
  const free = freeBytes(spaceDir);
  if (free !== null && needBytes && free < needBytes) {
    const mb = (n) => Math.round(n / 1_048_576);
    return reply.code(507).send({
      error: `Not enough free space: this needs about ${mb(needBytes)} MB and ${mb(free)} MB is available.`,
      code: 'NO_SPACE',
    });
  }
  maintenance = { job, startedAt: new Date().toISOString() };
  return null;
}

/** Hand the loop back once between the guard and the freeze, so the reply can be shaped. */
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

function isSqliteBusy(err) {
  const primaryCode = Number(err?.errcode) & 0xff;
  return primaryCode === 5 || err?.code === 'SQLITE_BUSY'
    || /SQLITE_BUSY|database is locked/i.test(String(err?.message ?? ''));
}

function maintenanceFailure(req, reply, err, job) {
  req.log.warn({ err: err?.message ?? err }, `${job} failed`);
  if (isSqliteBusy(err)) {
    return reply.header('retry-after', '5').code(409).send({
      error: 'Another process is writing to the database. Try again shortly.',
      code: 'DB_BUSY',
    });
  }
  return reply.code(500).send({
    error: job === 'backup'
      ? 'Could not write the backup copy. Check free space and try again.'
      : 'Could not compact the database. Check the administrator log and try again.',
  });
}

app.post('/api/admin/db/vacuum', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const size = dbBytes().bytes;
  const refused = beginMaintenance('vacuum', reply, { needBytes: size * 2 });
  if (refused) return refused;
  try {
    // The reply is only sent after the compile finishes (Fastify cannot stream
    // from inside a synchronous handler anyway), so the honest thing to report is
    // how long the freeze lasted.
    const started = Date.now();
    await yieldLoop();
    db.exec('VACUUM');
    audit(admin, 'db.vacuum', null, `${Date.now() - started} ms`);
    return { ok: true, ms: Date.now() - started, db: dbBytes() };
  } catch (err) {
    return maintenanceFailure(req, reply, err, 'vacuum');
  } finally {
    maintenance = null;
  }
});

/**
 * A consistent snapshot: VACUUM INTO copies the live database atomically.
 *
 * Same freeze as the vacuum above, plus a full second copy on disk, so it goes
 * through the same guard and the same 2×-the-database space check. The temp
 * directory is removed on every path now, including a failing VACUUM — it used to
 * leak a full copy of the database into /tmp every time the download errored.
 */
app.get('/api/admin/backup', {
  // A `.db` download must be the bytes of the database: `@fastify/compress` would
  // gzip `application/octet-stream` (mime-db marks it compressible) and the file
  // an operator saves would be a gzip stream with a `.db` name.
  compress: false,
}, async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;

  const size = dbBytes().bytes;
  const refused = beginMaintenance('backup', reply, { needBytes: size * 2, spaceDir: os.tmpdir() });
  if (refused) return refused;

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-backup-'));
  } catch (err) {
    maintenance = null;
    req.log.warn({ err: err?.message ?? err }, 'backup temp dir failed');
    return reply.code(500).send({ error: 'Could not create a temporary directory for the backup.' });
  }
  const target = path.join(dir, 'sonora.db');

  try {
    // One turn of the loop between taking the flag and freezing it: the 409 for
    // a concurrent job must be able to get out, and a queued keep-alive frame is
    // cheaper than a client timing out just before the freeze.
    await yieldLoop();
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    audit(admin, 'db.backup', null, `${size} bytes`);
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    return maintenanceFailure(req, reply, err, 'backup');
  } finally {
    maintenance = null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stream = fs.createReadStream(target);
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  stream.on('close', cleanup);
  stream.on('error', cleanup);

  return reply
    .header('content-type', 'application/octet-stream')
    .header('content-disposition', `attachment; filename="sonora-backup-${stamp}.db"`)
    .send(stream);
});

app.get('/api/admin/audit', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const limit = Number(req.query?.limit ?? 50);
  if (!Number.isSafeInteger(limit)) return reply.code(400).send({ error: 'Limit must be a safe integer.' });
  return { entries: listAudit(limit) };
});

app.get('/api/admin/system', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const mem = process.memoryUsage();
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    config: {
      port: config.port,
      host: config.host,
      dbPath: config.dbPath,
      audioDir: config.audioDir,
      downloadTimeoutMs: config.downloadTimeoutMs,
      maxDownloads: config.maxDownloads,
      cacheMb: Math.round(config.cacheBytes / 1024 / 1024),
      sessionDays: config.sessionDays,
      urlTtlMs: config.urlTtlMs,
      trustProxy: config.trustProxy,
      secretConfigured: !config.isDev,
      ytCookieConfigured: Boolean(config.ytCookie),
      ytdlpCookiesConfigured: Boolean(config.ytdlpCookies),
      ytdlpProxyConfigured: Boolean(config.ytdlpProxy),
      potProviderUrl: config.potProviderUrl || null,
      jsRuntime: config.jsRuntime || null,
    },
    jar: jarStatus(),
    botGated: botGateState().botGated,
  };
});

// ── artwork proxy ───────────────────────────────────────────────────────
// Thumbnails are served same-origin rather than hot-linked to i.ytimg.com:
// it keeps the client's IP and referrer off Google's CDN for every row in
// every list, and it makes the UI independent of third-party image gating.
//
// This list is the *only* gate now: public/media-session.js rewrites every
// https artwork URL onto /api/img?u=, so a host that is missing here renders as
// a broken cover instead of quietly hot-linking (which is what used to happen).
// Google shards the same art across numbered hosts (lh3-lh6.googleusercontent,
// yt1-yt5.ggpht) and adds new ones without notice, so the families are matched by
// suffix rather than enumerated; the leading dot keeps a lookalike such as
// evilgoogleusercontent.com out. Exact entries stay for hosts that do not live
// under those two domains.
const IMG_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com']);
const IMG_HOST_FAMILIES = ['.googleusercontent.com', '.ggpht.com', '.ytimg.com'];

function imageHostAllowed(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (IMG_HOSTS.has(host)) return true;
  return IMG_HOST_FAMILIES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}
// Host the id-based cover routes fetch from. Overridable (with an optional
// scheme) so a test can pin the upstream to a local plain-HTTP fixture and
// reason about the proxy's own behaviour — caching, limiting — without
// YouTube, DNS or TLS on the path.
const IMG_UPSTREAM = /^https?:\/\//.test(process.env.SONORA_YTIMG_HOST ?? '')
  ? process.env.SONORA_YTIMG_HOST.replace(/\/+$/, '')
  : `https://${process.env.SONORA_YTIMG_HOST || 'i.ytimg.com'}`;
// cacheKey -> { body, type, at } on a hit, or { miss: true, at } after proved absence.
const imgCache = new Map();
const imgInFlight = new Map();
let imgCacheBytes = 0;
const IMG_CACHE_MAX = 3000;
const IMG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const IMG_TTL = 6 * 60 * 60_000;

/**
 * Bound the artwork cache without throwing all of it away.
 *
 * Clearing the whole map at the ceiling turned the next render of a long list
 * into a stampede of upstream fetches — exactly what the cache exists to avoid.
 * Evict oldest-first only until both the entry and byte budgets fit, keeping hot
 * covers warm; Map iterates in insertion order, so "oldest" costs nothing to find.
 */
function imgCacheDelete(key) {
  const old = imgCache.get(key);
  if (!old) return;
  imgCache.delete(key);
  imgCacheBytes -= old.body?.length ?? 0;
}

function imgCacheSet(key, value) {
  imgCacheDelete(key);
  const bytes = value.body?.length ?? 0;
  // A future limit change must not let one value defeat the byte ceiling after
  // emptying every other entry. Today IMG_MAX_BYTES is lower, but the cache must
  // enforce its own invariant rather than relying on that unrelated constant.
  if (bytes > IMG_CACHE_MAX_BYTES) return;
  while (imgCache.size >= IMG_CACHE_MAX || imgCacheBytes + bytes > IMG_CACHE_MAX_BYTES) {
    const oldest = imgCache.keys().next().value;
    if (oldest === undefined) break;
    imgCacheDelete(oldest);
  }
  imgCache.set(key, value);
  imgCacheBytes += bytes;
}
// A thumbnail for a deleted upload will stay absent. Remember only that proved
// absence briefly: every list render asks for the same covers, and without this
// each repaint re-paid the full fallback chain. Transport failures never enter it.
const IMG_MISS_TTL = 2 * 60_000;
// Was 8 s. Nothing legitimate takes that long once DNS answers promptly, and a
// hung upstream must not hold a phone's whole grid hostage.
const IMG_TIMEOUT_MS = 5000;
/**
 * The largest image the artwork proxy accepts. Real covers (mqdefault 320x180
 * to maxresdefault 1280x720 JPEGs) are tens to a few hundred KB; anything
 * bigger is an upstream malfunction, not a cover. The art routes are public, so
 * this is a byte limit on the entire buffered read, not merely a cache hint:
 * oversized responses are cancelled rather than allocated or relayed.
 */
const IMG_MAX_BYTES = 512 * 1024;

function sendMiss(reply) {
  return reply.code(404).header('cache-control', 'no-store').send({ error: 'No artwork.' });
}

// Only inert raster formats. Correctly declared text/html is active content,
// and nosniff does not make it safe; SVG can carry active content too.
const SAFE_IMAGE_TYPE = /^image\/(?:jpeg|png|webp|avif|gif)(?:;|\s*$)/i;

function imageRequestAborted() {
  const err = new Error('Artwork request was cancelled.');
  err.code = 'IMG_ABORTED';
  return err;
}

/** Same custom fixture origin, or an actual allowlisted HTTPS CDN endpoint. */
function imageEndpointAllowed(raw, originalOrigin) {
  try {
    const url = new URL(raw);
    if (url.origin === originalOrigin) return true;
    return url.protocol === 'https:' && (!url.port || url.port === '443')
      && imageHostAllowed(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Read one image candidate through redirects, headers and the *whole body*.
 * Any oversized/invalid answer is cancelled and frees the connection. A failed
 * candidate returns kind=failure; an actual 404/410 returns kind=missing.
 */
async function readImageCandidate(upstream, jobSignal) {
  if (jobSignal.aborted) throw imageRequestAborted();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  jobSignal.addEventListener('abort', onAbort, { once: true });
  // Close the registration race as well as the already-aborted fast path above.
  if (jobSignal.aborted) ac.abort();
  const timer = setTimeout(() => ac.abort(), IMG_TIMEOUT_MS);
  timer.unref?.();
  try {
    const originalOrigin = new URL(upstream).origin;
    let url = upstream;
    for (let hop = 0; hop < 4; hop += 1) {
      const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.has('location')) {
        await res.body?.cancel().catch(() => {});
        if (hop === 3) return { kind: 'failure' };
        const next = new URL(res.headers.get('location'), url).href;
        // A redirect is a new trust decision, not an escape from the allowlist.
        if (!imageEndpointAllowed(next, originalOrigin)) return { kind: 'failure' };
        url = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { kind: res.status === 404 || res.status === 410 ? 'missing' : 'failure' };
      }
      const type = res.headers.get('content-type') ?? '';
      const declared = Number(res.headers.get('content-length'));
      if (!SAFE_IMAGE_TYPE.test(type) || (Number.isFinite(declared) && declared > IMG_MAX_BYTES)) {
        await res.body?.cancel().catch(() => {});
        return { kind: 'failure' };
      }
      if (!res.body) return { kind: 'failure' };
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > IMG_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return { kind: 'failure' };
        }
        chunks.push(Buffer.from(value));
      }
      return { kind: 'image', body: Buffer.concat(chunks, total), type };
    }
    return { kind: 'failure' };
  } catch (err) {
    if (jobSignal.aborted) throw imageRequestAborted();
    return { kind: 'failure' };
  } finally {
    clearTimeout(timer);
    jobSignal.removeEventListener('abort', onAbort);
  }
}

/** One read per cache key, with a private controller for subscriber cancellation. */
function imageJob(cacheKey, upstream, fallbacks) {
  let entry = imgInFlight.get(cacheKey);
  // The last leaving subscriber aborts its producer. A request arriving in the
  // small window before that promise settles needs fresh work, not an already-
  // aborted fetch which could never answer it.
  if (entry && !entry.controller.signal.aborted) return entry;
  entry = { controller: new AbortController(), pending: 0, promise: null };
  imgInFlight.set(cacheKey, entry);
  entry.promise = (async () => {
    let missing = false;
    let failed = false;
    for (const url of [upstream, ...fallbacks]) {
      const result = await readImageCandidate(url, entry.controller.signal);
      if (result.kind === 'image') {
        // The single producer populates the cache; joined responses never write
        // it again or allocate a second copy of the body.
        imgCacheSet(cacheKey, { body: result.body, type: result.type, at: Date.now() });
        return result;
      }
      if (result.kind === 'missing') missing = true;
      else failed = true;
    }
    // Network failures, 5xx and invalid bodies are not facts about the image.
    // Only an unambiguous chain of definitive absences earns a negative entry.
    if (missing && !failed) imgCacheSet(cacheKey, { miss: true, at: Date.now() });
    return null;
  })();
  const settled = () => { if (imgInFlight.get(cacheKey) === entry) imgInFlight.delete(cacheKey); };
  entry.promise.then(settled, settled);
  return entry;
}

/** Observe one job without letting one closed response strand every other tab. */
function joinImageJob(entry, reply) {
  return new Promise((resolve, reject) => {
    entry.pending += 1;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      entry.pending = Math.max(0, entry.pending - 1);
      reply.raw.off('close', onClose);
    };
    const onClose = () => {
      cleanup();
      const err = imageRequestAborted();
      // Keep the producer's rejection observed even when its last observer left.
      entry.promise.catch(() => {});
      if (!entry.pending) entry.controller.abort();
      reject(err);
    };
    reply.raw.once('close', onClose);
    entry.promise.then(
      (value) => { cleanup(); resolve(value); },
      (err) => { cleanup(); reject(err); },
    );
    if (reply.raw.destroyed) onClose();
  });
}

async function proxyImage(cacheKey, upstream, reply, fallbacks = [], cacheControl = 'private, max-age=86400') {
  const hit = imgCache.get(cacheKey);
  if (hit) {
    const ttl = hit.miss ? IMG_MISS_TTL : IMG_TTL;
    if (Date.now() - hit.at < ttl) {
      if (hit.miss) return sendMiss(reply);
      return reply.code(200).header('content-type', hit.type)
        .header('cache-control', cacheControl).send(hit.body);
    }
    imgCacheDelete(cacheKey);
  }

  let result;
  try {
    result = await joinImageJob(imageJob(cacheKey, upstream, fallbacks), reply);
  } catch (err) {
    if (err.code === 'IMG_ABORTED' || reply.raw.destroyed) return reply.hijack();
    throw err;
  }
  if (!result) return sendMiss(reply);
  return reply.code(200).header('content-type', result.type)
    .header('cache-control', cacheControl).send(result.body);
}

app.get('/api/img/:videoId', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const base = `${IMG_UPSTREAM}/vi/${videoId}`;
  // Every YouTube still is 16:9 EXCEPT hqdefault, which is a 4:3 canvas with
  // the 16:9 frame letterboxed inside baked-in black bars. Serving hqdefault
  // put a black band across every square crop in the app (station cards, rail
  // art, up-next rows). mqdefault is 320x180 — correct aspect, always present,
  // ~10KB — which is the right default for rows and cards. Large frames ask
  // for `hi=1` and get the 1280x720 source.
  if (req.query?.hi === '1') {
    return proxyImage(`v:${videoId}:hi`, `${base}/maxresdefault.jpg`, reply,
      [`${base}/hq720.jpg`, `${base}/mqdefault.jpg`]);
  }
  return proxyImage(`v:${videoId}`, `${base}/mqdefault.jpg`, reply,
    [`${base}/hqdefault.jpg`]);
});

// Channel avatars live on yt3.ggpht.com and have no id-based URL, so the
// upstream is passed explicitly — allowlisted by host so this cannot become an
// open proxy.
app.get('/api/img', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const raw = String(req.query?.u ?? '');
  let u;
  try { u = new URL(raw); } catch { return reply.code(400).send({ error: 'Bad image url.' }); }
  // https on the default port only: a host allowlist should not also become a
  // way to probe arbitrary ports on Google's CDN.
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || !imageHostAllowed(u.hostname)) {
    return reply.code(400).send({ error: 'Host not allowed.' });
  }
  return proxyImage(`u:${u.href}`, u.href, reply);
});

// ── listen together ─────────────────────────────────────────────────────
// A room is one shared playhead (docs/rooms.md). Reads and commands are plain
// JSON; state is pushed over SSE so a group hears a change at once instead of
// polling for it. The stream is hijacked: Fastify must never try to frame it.

/** Translate the engine's errors into the shapes the client switches on. */
const roomRoute = (fn) => async (req, reply, ...rest) => {
  const user = requireUser(req, reply);
  if (!user) return;
  try {
    return await fn(req, reply, user, ...rest);
  } catch (err) {
    if (!(err instanceof RoomError)) throw err;
    return reply.code(err.status).send({
      error: err.message,
      code: err.code,
      ...(err.details ? { state: err.details } : {}),
    });
  }
};

// ── anonymous public listeners ──────────────────────────────────────────
// A public room is the one place audio does not require an account. The guest
// cookie is signed, room-scoped and short-lived; it opens this room's state and
// its queue's audio, and nothing else (see the guest branch of /api/stream).
// It is domain-separated from the session token, so neither can stand in for
// the other.
//
// One cookie holds a *map* of room code → signed token. There used to be one
// cookie holding one room's token, so opening a second room's listener page
// overwrote the first: the open SSE stream kept working (auth happens at
// connect) but every poll answered 403 NO_GUEST and the next track's audio
// answered 401 — listening to room A died because a link to room B was opened
// in another tab. A map keeps one browser-wide cookie (so "no guest cookie"
// stays a single, meaningful state) without letting rooms evict each other.
const GUEST_COOKIE = 'sonora_guest';
const GUEST_TTL_MS = 6 * 60 * 60_000;
// Each token is ~80 encoded bytes; a browser that has opened more rooms than
// this is browsing, not listening. Bounded so the cookie cannot approach the
// 4 KB per-cookie ceiling.
const GUEST_ROOMS_MAX = 6;

function guestFromToken(token) {
  const payload = readGuest(token);
  if (!payload) return null;
  return { id: `g:${payload.g}`, name: 'Guest', guest: true, code: payload.c, exp: payload.exp };
}

/** The room-code → token map this browser holds (invalid JSON is "no guests"). */
function guestTokens(req) {
  const raw = req.cookies?.[GUEST_COOKIE];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [code, token] of Object.entries(parsed)) {
      if (ROOM_CODE.test(code) && typeof token === 'string') out[code] = token;
    }
    return out;
  } catch {
    return {};
  }
}

/** Every guest identity this browser currently holds, one per room. */
function guestsFor(req) {
  const out = [];
  for (const [code, token] of Object.entries(guestTokens(req))) {
    const guest = guestFromToken(token);
    // The token is signed for a room; a mismatch means a stale/forged entry.
    if (guest && guest.code === code) out.push(guest);
  }
  return out;
}

function currentGuest(req, code) {
  const guests = guestsFor(req);
  if (!guests.length) return null;
  if (code) return guests.find((g) => g.code === code) ?? null;
  return guests[0];
}

/**
 * Mint (or refresh) this browser's guest token for one room.
 *
 * The map is rewritten with the room added, dropping expired/invalid entries
 * first and then the oldest rooms past GUEST_ROOMS_MAX, so a long-lived browser
 * cannot grow the cookie without bound.
 */
function mintGuest(req, reply, code) {
  const tokens = guestTokens(req);
  const now = Date.now();
  const kept = {};
  for (const [entryCode, token] of Object.entries(tokens)) {
    const guest = guestFromToken(token);
    if (guest && guest.code === entryCode && guest.exp > now) kept[entryCode] = token;
  }
  kept[code] = signGuest({
    c: code,
    g: crypto.randomBytes(9).toString('base64url'),
    exp: now + GUEST_TTL_MS,
  });
  const codes = Object.keys(kept);
  for (const stale of codes.slice(0, Math.max(0, codes.length - GUEST_ROOMS_MAX))) delete kept[stale];
  reply.setCookie(GUEST_COOKIE, JSON.stringify(kept), {
    httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), path: '/',
    maxAge: Math.floor(GUEST_TTL_MS / 1000),
  });
  return guestFromToken(kept[code]);
}

const publicRoute = (fn) => async (req, reply) => {
  try {
    return await fn(req, reply);
  } catch (err) {
    if (!(err instanceof RoomError)) throw err;
    return reply.code(err.status).send({ error: err.message, code: err.code });
  }
};

function guestFor(req, code) {
  const guest = currentGuest(req, code);
  if (!guest || guest.code !== code) {
    throw new RoomError(403, 'NO_GUEST', 'Open this room to listen.');
  }
  return guest;
}

app.post('/api/rooms', roomRoute(async (req, reply, user) => {
  const b = req.body ?? {};
  const snapshot = createRoom({
    host: user,
    visibility: b.visibility ?? 'public',
    control: b.control ?? 'everyone',
    queue: b.queue,
    index: Number.isInteger(b.index) ? b.index : 0,
    positionMs: Number.isFinite(b.positionMs) ? b.positionMs : 0,
    playing: Boolean(b.playing),
  });
  return { ...snapshot, members: memberRoster(snapshot.code) };
}));

app.get('/api/rooms', roomRoute(async (req, reply, user) => ({
  rooms: listRoomsForUser(user.id),
})));

app.get('/api/rooms/:code', roomRoute(async (req, reply, user) => viewRoom(req.params.code, user)));
app.get('/api/rooms/:code/state', roomRoute(async (req, reply, user) => {
  // A snapshot is also the polling fallback's whole job, so it counts as presence:
  // housekeeping reaps a room whose `updated_at` is old when nobody is on the SSE
  // stream, and without this a group listening through a proxy that blocks
  // streaming (or a browser without EventSource) had a room that was invisible to
  // housekeeping — it could be deleted while they were actively following it, and
  // the next poll answered 404. Only after viewRoom() has authorised the caller,
  // so a stranger probing codes cannot keep someone else's room alive.
  const snapshot = viewRoom(req.params.code, user);
  touchRoomPresence(req.params.code);
  return snapshot;
}));

app.post('/api/rooms/:code/join', roomRoute(async (req, reply, user) => {
  const snapshot = joinRoom(req.params.code, user);
  return { ...snapshot, members: memberRoster(req.params.code) };
}));

app.post('/api/rooms/:code/leave', roomRoute(async (req, reply, user) => leaveRoom(req.params.code, user)));
app.delete('/api/rooms/:code', roomRoute(async (req, reply, user) => endRoom(req.params.code, user)));
app.patch('/api/rooms/:code', roomRoute(async (req, reply, user) => ({
  ...updateRoom(req.params.code, user, req.body ?? {}),
  // Every snapshot the client applies carries the roster; the command and PATCH
  // responses were the two that did not, so the client kept the stale member
  // list until the next SSE frame.
  members: memberRoster(req.params.code),
})));

app.post('/api/rooms/:code/command', roomRoute(async (req, reply, user) => ({
  ...applyCommand(req.params.code, user, req.body ?? {}),
  members: memberRoster(req.params.code),
})));

// Handing the room over.
//
// A `control: 'host'` room whose host walks away used to be unskippable,
// unpausable and unendable: `rooms.host_id` is written only by createRoomRow, and
// endRoom is host-only, so the group watched it loop the queue until housekeeping
// deleted the room hours later. The host is the only one who can give the seat
// away — otherwise any member could seize it — and the answer is the same shape
// every other snapshot-carrying room route returns, roster included, so a client
// applies it exactly like a PATCH.
app.patch('/api/rooms/:code/host', roomRoute(async (req, reply, user) => {
  const newHostId = Number(req.body?.userId);
  if (!Number.isInteger(newHostId) || newHostId <= 0) {
    throw new RoomError(400, 'BAD_USER', 'Pick the person to hand the room to.');
  }
  return {
    ...transferHost(req.params.code, user, newHostId),
    members: memberRoster(req.params.code),
  };
}));

// A clock probe. Three of these per join (and once a minute after) is enough to
// estimate the offset with a round-trip correction; one-way event timestamps
// would bias it forward by the whole transit delay.
//
// The view is still checked: this was the one room route without one, so clock
// calibration succeeded against rooms that had ended and rooms the caller was
// not allowed to see.
app.get('/api/rooms/:code/time', roomRoute(async (req, reply, user) => {
  viewRoom(req.params.code, user);
  return { now: Date.now() };
}));

app.get('/api/rooms/:code/people', roomRoute(async (req, reply, user) => ({
  people: peopleFor(req.params.code, user, String(req.query?.q ?? '')),
})));

app.post('/api/rooms/:code/invite', roomRoute(async (req, reply, user) => {
  const b = req.body ?? {};
  return inviteUser(req.params.code, user, {
    name: typeof b.name === 'string' ? b.name : null,
    userId: Number.isInteger(b.userId) ? b.userId : null,
  });
}));

app.delete('/api/rooms/:code/invite/:userId', roomRoute(async (req, reply, user) => (
  uninviteUser(req.params.code, user, Number(req.params.userId))
)));

app.get('/api/rooms/:code/events', roomRoute(async (req, reply, user) => {
  // Validate before hijacking: a 403/404 must still be an ordinary JSON reply.
  const snapshot = viewRoom(req.params.code, user);
  if (!snapshot.joined) throw new RoomError(403, 'NOT_MEMBER', 'Join this room first.');
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // no-transform keeps a compressing proxy from holding events until a
    // buffer fills; x-accel-buffering is the nginx equivalent.
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.socket?.setNoDelay?.(true);
  raw.socket?.setTimeout?.(0);
  raw.write(': connected\n\n');
  openStream(req.params.code, user, raw, { members: snapshot.members });
}));

// ── public listener API (no account) ────────────────────────────────

app.post('/api/public/rooms/:code/guest', {
  // Bound cookie farming and code probing without getting in the way of a
  // household behind one IP (a NAT full of guests still fits).
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}, publicRoute(async (req, reply) => {
  const code = req.params.code;
  const snapshot = publicSnapshot(code);
  mintGuest(req, reply, code);
  return snapshot;
}));

app.get('/api/public/rooms/:code', {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}, publicRoute(async (req, reply) => {
  guestFor(req, req.params.code);
  return publicSnapshot(req.params.code);
}));

app.get('/api/public/rooms/:code/state', {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}, publicRoute(async (req, reply) => {
  guestFor(req, req.params.code);
  const snapshot = publicSnapshot(req.params.code);
  // The guest polling fallback is a heartbeat too. Presence is normally the SSE
  // stream, so an anonymous listener whose proxy blocks streaming was invisible
  // to housekeeping and their room could be deleted while they were following
  // it. After publicSnapshot() has authorised them, not before: a stranger
  // probing codes must not keep someone else's room alive.
  touchRoomPresence(req.params.code);
  return snapshot;
}));

app.get('/api/public/rooms/:code/time', {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}, publicRoute(async (req) => {
  guestFor(req, req.params.code);
  // Same public-room gate as /state above: a clock probe says nothing about a
  // room (and leaks nothing), but it also has no business answering for a
  // private room once its guests are revoked.
  publicSnapshot(req.params.code); // 403 PRIVATE / 410 ENDED
  return { now: Date.now() };
}));

app.get('/api/public/rooms/:code/events', {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}, publicRoute(async (req, reply) => {
  const code = req.params.code;
  const guest = guestFor(req, code);
  publicSnapshot(code); // 403 PRIVATE / 410 ENDED before the socket is hijacked
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.socket?.setNoDelay?.(true);
  raw.socket?.setTimeout?.(0);
  raw.write(': connected\n\n');
  openStream(code, guest, raw, { members: [] });
}));

// ── listen-together landing page ────────────────────────────────────────
// `/l/<code>` is a real path for the same reason `/t/<id>` is: a chat crawler
// never sees a `#fragment`. It is server-rendered and public because a crawler
// carries no session — but a private room's track is never part of it.

/**
 * A room preview's host is a name.
 *
 * roomPreview() hands back the host as a string while a member snapshot hands
 * back an object (`{id,name}`); the two shapes reached the same page templates,
 * so one of them rendered `[object Object] is listening`. Accept both here
 * until the engine settles on one (see the note in the room contract).
 */
function hostNameOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return typeof value.name === 'string' ? value.name : null;
}

function roomLandingHtml({ base, code, preview, gone = false }) {
  const open = `${base}/#/room/${encodeURIComponent(code)}`;
  const url = `${base}/l/${encodeURIComponent(code)}`;
  const isPrivate = preview ? preview.visibility === 'private' : false;
  // A gone room is not an invitation: the link used to render the same cheerful
  // "join the room" card with a 404, so a dead link looked like a live one.
  const isGone = gone || !preview;
  // A public room has a listener page that needs no account at all. The app
  // link stays for people who do have one (they can control playback there).
  const liveUrl = preview && !isPrivate && !isGone ? `${base}/l/${encodeURIComponent(code)}/live` : null;
  const primary = liveUrl ?? open;
  const track = preview?.track ?? null;
  const meta = track ? cardMetadata(track) : null;
  const title = isGone
    ? 'This room has ended'
    : isPrivate ? 'A private listening room' : (meta?.title || 'Listen together on sonora');
  const artist = !isPrivate && !isGone ? (meta?.artist ?? '') : '';
  // A private room's host name is not public information: the landing page is
  // reachable with no session and used to print "<name> is listening".
  const hostName = isPrivate || isGone ? null : hostNameOf(preview?.host);
  const host = hostName ? `${hostName} is listening.` : (isGone ? 'This room is closed.' : 'Listen together on sonora.');
  const description = isGone
    ? 'The room this link pointed to has ended, or the code is not a room.'
    : isPrivate
      ? 'Ask the host for an invite.'
      : [artist, host].filter(Boolean).join(' \u00b7 ');
  const art = track ? `${base}/t/${encodeURIComponent(track.videoId)}/art.jpg` : `${base}${SHARE_FALLBACK_ART}`;
  const listeners = preview && !isGone
    ? Math.max(1, preview.listeners ?? ((preview.members ?? 0) + (preview.guests ?? 0)))
    : 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111215">
<meta name="color-scheme" content="dark">
<title>${htmlEsc(`${title} \u00b7 sonora`)}</title>
<meta name="description" content="${htmlEsc(description || 'A listening room on sonora.')}">
${track ? '' : '<meta name="robots" content="noindex">'}
<link rel="canonical" href="${htmlEsc(url)}">
<link rel="icon" href="/icons/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="sonora">
<meta property="og:url" content="${htmlEsc(url)}">
<meta property="og:title" content="${htmlEsc(title)}">
<meta property="og:description" content="${htmlEsc(description || 'A listening room on sonora.')}">
<meta property="og:image" content="${htmlEsc(art)}">
<meta property="og:image:width" content="${track ? 1280 : 512}">
<meta property="og:image:height" content="${track ? 720 : 512}">
<meta property="og:image:alt" content="${htmlEsc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${htmlEsc(title)}">
<meta name="twitter:description" content="${htmlEsc(description || 'A listening room on sonora.')}">
<meta name="twitter:image" content="${htmlEsc(art)}">
<link rel="stylesheet" href="/fonts.css">
<style>
:root{color-scheme:dark;--bg:#111215;--card:#202126;--line:rgba(255,255,255,.11);--white:#fbf9f6;--muted:#a5a4ad;--soft:#8f8f99;--accent:#ff997b;--accent-ink:#241814}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(120% 90% at 50% 0,#1b1c22 0,#111215 55%,#0d0e11 100%);color:var(--white);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:calc(32px + env(safe-area-inset-top)) 22px calc(32px + env(safe-area-inset-bottom))}
main{width:100%;max-width:400px;text-align:center}
.art{display:block;border-radius:18px;overflow:hidden;aspect-ratio:16/9;box-shadow:0 26px 64px rgba(0,0,0,.6),0 0 0 1px var(--line) inset;background-color:var(--card);background-repeat:no-repeat;background-position:center;background-size:cover,44px}
h1{margin:24px 0 0;font-size:clamp(21px,5.6vw,27px);line-height:1.18;letter-spacing:-.02em;font-weight:700;overflow-wrap:anywhere}
.artist{margin:9px 0 0;font-size:16px;color:var(--muted);overflow-wrap:anywhere}
.host{margin:6px 0 0;font-size:13px;color:var(--soft)}
.listeners{margin:12px 0 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.listeners b{color:var(--accent-2);font-weight:700}
.alt-link{margin:16px 0 0;font-size:12.5px}
.alt-link a{color:var(--muted);text-decoration:underline;text-underline-offset:3px}
.alt-link a:hover{color:var(--white)}
.play{display:inline-flex;align-items:center;gap:9px;margin-top:28px;padding:14px 26px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:16px;font-weight:650;text-decoration:none;transition:transform .12s ease}
.play:active{transform:scale(.97)}
.play svg{width:14px;height:14px;fill:currentColor}
.note{margin:28px 0 0;font-size:12.5px;line-height:1.55;color:var(--soft)}
@media (prefers-reduced-motion:no-preference){.art{animation:rise .45s ease-out both}@keyframes rise{from{opacity:0;transform:translateY(10px)}}}
@media (prefers-reduced-motion:reduce){.play{transition:none}}
</style>
</head>
<body>
<main>
<a class="art" href="${htmlEsc(open)}" aria-label="${htmlEsc(`Join ${title} on sonora`)}" style="background-image:url(&#39;${htmlEsc(art)}&#39;)"></a>
<h1>${htmlEsc(title)}</h1>
${artist ? `<p class="artist">${htmlEsc(artist)}</p>` : ''}
<p class="host">${htmlEsc(host)}</p>
${isPrivate || isGone ? '' : `<p class="listeners"><b>${listeners}</b> listening now</p>`}
${isGone
    ? `<a class="play" href="${htmlEsc(`${base}/`)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>Open sonora</a>`
    : `<a class="play" href="${htmlEsc(primary)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>${liveUrl ? 'Listen live' : isPrivate ? 'Open sonora' : 'Join the room'}</a>`}
${liveUrl ? `<p class="alt-link"><a href="${htmlEsc(open)}">Sign in to sonora to control playback</a></p>` : ''}
<p class="note">${isGone
    ? 'The room this link pointed to has ended, or the code is not a room. Open sonora to start your own.'
    : isPrivate
      ? 'This is a private room. Sign in, then ask the host to invite you.'
      : 'No account is needed to listen — the link is the invitation. Playback stays in sync with everyone else in the room.'}</p>
</main>
</body>
</html>`;
}

app.get('/l/:code', {
  // Public and session-less like the share card and the artwork proxy, which is
  // exactly why it needs its own per-IP limit: the global limiter exempts
  // everything outside /api/, and this route both reads a room and renders a
  // page. The global allowList is merged into every route's params, so it has to
  // be cleared here for the limit to bite at all.
  config: { rateLimit: { max: 120, timeWindow: '1 minute', allowList: null } },
}, async (req, reply) => {
  const { code } = req.params;
  const preview = ROOM_CODE.test(code) ? roomPreview(code) : null;
  if (!preview) return reply.code(404).type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(roomLandingHtml({ base: publicBase(req), code, preview: null, gone: true }));
  return reply.type('text/html; charset=utf-8')
    // Public metadata becomes private immediately when the host changes the
    // room. A shared-cache max-age would keep serving its track and host after
    // that transition, so this landing page (not only /live) is never stored.
    .header('cache-control', 'no-store')
    .send(roomLandingHtml({ base: publicBase(req), code, preview }));
});

/**
 * The listener page: the whole point of a public room.
 *
 * It is deliberately NOT the app. A guest has no account, so the app's boot
 * (`/api/me`, likes, playlists) would 401 its way to the login wall. This page
 * asks for nothing but the room, loads /listen.js (the same sync engine the
 * signed-in app uses), and plays. Server-rendered so the track is on screen
 * before a byte of JavaScript runs.
 */
/** "12 min left" — a queue is measured in minutes, not seconds. */
function listenTimeLeft(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return '<1 min';
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** "12 min ago" for the room's age; not a live countdown. */
function listenAgo(ts) {
  if (!Number.isFinite(ts)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** One row of the listener page's running order. */
function listenRowHtml(track, index, state) {
  const now = state === 'now';
  const played = state === 'played';
  const art = `/t/${encodeURIComponent(track.videoId)}/art.jpg`;
  const duration = clockDuration(track.durationS);
  return `<li class="q-row${now ? ' is-now' : ''}${played ? ' is-played' : ''}"${now ? ' aria-current="true"' : ''} data-video-id="${htmlEsc(track.videoId)}">
    <span class="q-mark" aria-hidden="true">${now
      ? '<span class="eq"><i></i><i></i><i></i></span>'
      : `<span class="q-num">${index + 1}</span>`}</span>
    <span class="q-art" style="background-image:url(&quot;${htmlEsc(art)}&quot;)" aria-hidden="true"></span>
    <span class="q-copy"><span class="q-titleline"><strong>${htmlEsc(track.title ?? track.videoId)}</strong>${now ? '<span class="q-flag">Now playing</span>' : ''}</span><span class="q-sub">${htmlEsc(track.channel ?? '')}</span></span>
    <span class="q-dur">${htmlEsc(duration)}</span>
  </li>`;
}

/**
 * The listener page: the whole point of a public room.
 *
 * It is deliberately NOT the app. A guest has no account, so the app's boot
 * (`/api/me`, likes, playlists) would 401 its way to the login wall. This page
 * asks for nothing but the room, loads /listen.js (the same sync engine the
 * signed-in app uses), and plays. Server-rendered so the track AND the running
 * order are on screen before a byte of JavaScript runs.
 *
 * The shape is a listening room, not a bare player: the now-playing side holds
 * the record sleeve and the honest transport state; the queue side is a live
 * set list (current, up next, played earlier) with the room's facts underneath.
 */
function listenHtml({ base, code, preview }) {
  const open = `${base}/#/room/${encodeURIComponent(code)}`;
  const host = hostNameOf(preview?.host) ?? 'Someone';
  const hostInitial = String(host).trim().charAt(0).toUpperCase() || '?';
  const track = preview?.track ?? null;
  const meta = track ? cardMetadata(track) : null;
  const art = track
    ? `${base}/t/${encodeURIComponent(track.videoId)}/art.jpg`
    : `${base}${SHARE_FALLBACK_ART}`;
  const title = meta?.title || 'Waiting for music';
  const artist = meta?.artist || '';
  const queue = Array.isArray(preview?.queue) ? preview.queue : [];
  const index = Number.isInteger(preview?.index)
    ? Math.max(0, Math.min(preview.index, Math.max(0, queue.length - 1)))
    : 0;
  const currentTrack = queue[index] ?? track;
  const upcoming = currentTrack ? queue.slice(index + 1) : [];
  const played = currentTrack ? queue.slice(0, index).reverse() : [];
  let remainingMs = 0;
  let hasDuration = false;
  if (currentTrack?.durationS > 0) {
    remainingMs += Math.max(0, currentTrack.durationS * 1000 - (preview?.positionMs ?? 0));
    hasDuration = true;
  }
  for (const t of upcoming) {
    if (t.durationS > 0) { remainingMs += t.durationS * 1000; hasDuration = true; }
  }
  const queueMeta = currentTrack
    ? `${upcoming.length ? `${upcoming.length} up next` : 'Last track'}${hasDuration ? ` · ${listenTimeLeft(remainingMs / 1000)} left` : ''}`
    : 'Waiting for a track';
  const currentRow = currentTrack ? listenRowHtml(currentTrack, index, 'now') : '';
  const upcomingRows = upcoming.map((t, i) => listenRowHtml(t, index + 1 + i, 'next')).join('');
  const playedRows = played.map((t, i) => listenRowHtml(t, index - 1 - i, 'played')).join('');
  const listeners = Math.max(1, preview?.listeners ?? ((preview?.members ?? 0) + (preview?.guests ?? 0)));
  const controlLabel = preview?.control === 'host' ? 'Host only' : 'Everyone';
  const roomNote = preview?.control === 'host'
    ? 'Anyone with the link can listen. The host controls playback.'
    : 'Anyone with the link can listen. Signed-in members can change the music.';
  const nowIndex = currentTrack ? `Track ${index + 1} of ${queue.length}` : 'Waiting for music';
  const startLabel = currentTrack ? 'Listen live' : 'Waiting for music';
  const startDisabled = currentTrack ? '' : ' disabled';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111215">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>${htmlEsc(`${title} \u00b7 listen together \u00b7 sonora`)}</title>
<meta name="description" content="${htmlEsc(`Listen in sync with ${host}.`)}">
<link rel="icon" href="/icons/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<link rel="stylesheet" href="/fonts.css">
<style>
:root{color-scheme:dark;--bg:#111215;--bg-deep:#0d0e11;--panel:#191a1f;--card:#202126;--card-2:#26272e;--card-3:#2d2e36;--line:rgba(255,255,255,.075);--line-2:rgba(255,255,255,.11);--line-3:rgba(255,255,255,.16);--inset:rgba(255,255,255,.055);--white:#fbf9f6;--text-2:#c9c7cd;--muted:#a5a4ad;--soft:#8f8f99;--accent:#ff997b;--accent-2:#f7b4a0;--accent-ink:#241814;--accent-soft:rgba(255,153,123,.13);--accent-line:rgba(255,153,123,.38);--ok:#8fd9a0;--warn:#e6c682;--bad:#ff9a9a;--ok-soft:rgba(143,217,160,.12);--dur-1:140ms;--dur-2:220ms;--dur-3:320ms;--ease-out:cubic-bezier(.22,.68,.18,1)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;height:100dvh;overflow:hidden;background:radial-gradient(120% 90% at 50% 0,#1b1c22 0,#111215 55%,#0d0e11 100%);color:var(--white);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;padding:calc(16px + env(safe-area-inset-top)) clamp(16px,4vw,34px) calc(16px + env(safe-area-inset-bottom))}
button,input{font:inherit;color:inherit;letter-spacing:inherit}
button{border:0;padding:0;background:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
a{color:inherit;text-decoration:none}
img{display:block;max-width:100%}
h1,h2,h3,p{margin:0}
.glow{position:fixed;inset:-12%;z-index:0;background-position:center;background-size:cover;filter:blur(90px) saturate(1.4);opacity:.22;transform:scale(1.12);pointer-events:none;mask-image:linear-gradient(#000 0%,rgba(0,0,0,.5) 45%,transparent 78%);-webkit-mask-image:linear-gradient(#000 0%,rgba(0,0,0,.5) 45%,transparent 78%)}
.glow::after{content:'';position:absolute;inset:0;background:radial-gradient(80% 60% at 50% 0,transparent,var(--bg) 78%)}
body[data-status="ended"] .glow{opacity:.06}
.shell{position:relative;z-index:1;height:100%;max-width:1160px;margin:0 auto;display:flex;flex-direction:column;min-height:0}
.topbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex:none;padding-bottom:16px;border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:9px;flex:none;font-weight:750;letter-spacing:-.02em;font-size:15px}
.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:linear-gradient(145deg,var(--accent),#e98261);color:var(--accent-ink);box-shadow:0 4px 14px rgba(233,130,97,.22)}
.brand-mark svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round}
.brand-dot{color:var(--accent)}
.topbar-sep{width:1px;height:18px;background:var(--line-2);flex:none}
.topbar-title{font-size:11px;font-weight:750;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.room-code{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:0 11px;border:1px solid var(--line-2);border-radius:999px;background:rgba(255,255,255,.035);font-size:11px;color:var(--soft);white-space:nowrap}
.room-code b{font-size:11.5px;letter-spacing:.14em;color:var(--text-2);font-weight:750}
.room-code-label{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase}
.icon-btn{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:0 13px;border:1px solid var(--line-2);border-radius:999px;background:rgba(255,255,255,.04);color:var(--text-2);font-size:12px;font-weight:650;transition:background var(--dur-1) var(--ease-out),color var(--dur-1) var(--ease-out),border-color var(--dur-1) var(--ease-out)}
.icon-btn:hover{background:rgba(255,255,255,.08);color:var(--white)}
.icon-btn.is-copied{color:var(--ok);border-color:rgba(143,217,160,.35);background:var(--ok-soft)}
.icon-btn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.app-link{display:inline-flex;align-items:center;gap:5px;min-height:40px;padding:0 8px;font-size:12px;font-weight:650;color:var(--muted);white-space:nowrap}
.app-link:hover{color:var(--white)}
.app-link svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
/* A view switch, not a tab bar: two ways to see the same room. The player is
   the default because it is the one that answers "what is playing, what is
   next"; the venue is the one that answers "who am I listening with". */
.view-switch{display:inline-flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--line-2);border-radius:999px;background:rgba(255,255,255,.035);flex:none}
.view-btn{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 11px;border-radius:999px;font-size:11.5px;font-weight:700;color:var(--soft);transition:background var(--dur-1) var(--ease-out),color var(--dur-1) var(--ease-out)}
.view-btn:hover{color:var(--white)}
.view-btn[aria-pressed="true"]{background:rgba(255,255,255,.1);color:var(--white);box-shadow:0 1px 0 rgba(255,255,255,.09) inset}
.view-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent-line);outline-offset:2px;border-radius:6px}
.layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.02fr) minmax(370px,.98fr);gap:clamp(22px,3vw,40px);padding:clamp(18px,2.4vw,30px) 0 0;align-items:stretch;overflow:hidden}
.player{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-right:4px;scrollbar-width:thin}
.side{min-height:0;display:flex;flex-direction:column;gap:14px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin}
.stage{position:relative;border-radius:20px;overflow:hidden;aspect-ratio:16/9;background:var(--card);box-shadow:0 30px 70px rgba(0,0,0,.55),0 0 0 1px var(--line) inset}
.stage img{width:100%;height:100%;object-fit:cover}
.stage-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,10,13,.16),transparent 38%,rgba(9,10,13,.5));pointer-events:none}
.stage-tags{position:absolute;left:12px;top:12px;right:12px;z-index:2;display:flex;justify-content:space-between;gap:8px;pointer-events:none}
.stage-live,.stage-guest{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:0 10px;border-radius:999px;background:rgba(9,10,13,.64);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(8px);font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--white)}
.stage-live i{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(143,217,160,.18)}
.stage-guest{color:var(--accent-2);border-color:var(--accent-line);background:rgba(9,10,13,.64)}
body[data-status="ended"] .stage-live i{background:var(--bad);box-shadow:none}
.overlay{position:absolute;inset:0;z-index:1;display:grid;place-items:center;background:rgba(9,10,13,.46);backdrop-filter:blur(3px);transition:opacity var(--dur-2) var(--ease-out)}
.listen-btn{display:inline-flex;align-items:center;gap:10px;min-height:54px;padding:0 28px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:15.5px;font-weight:750;font-family:inherit;box-shadow:0 12px 34px rgba(233,130,97,.38);transition:transform var(--dur-1) var(--ease-out),background var(--dur-1) var(--ease-out)}
.listen-btn:hover{background:var(--accent-2)}
.listen-btn:active{transform:scale(.96)}
.listen-btn:disabled{opacity:.7;cursor:progress}
.listen-btn svg{width:16px;height:16px;fill:currentColor}
.now{margin-top:20px}
.now-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 14px}
.eyebrow{display:block;font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.eyebrow-dim{color:var(--soft);font-weight:650;letter-spacing:.06em;margin-left:6px;text-transform:none}
h1{margin:10px 0 0;font-size:clamp(24px,3.2vw,38px);line-height:1.08;letter-spacing:-.035em;font-weight:780;overflow-wrap:anywhere}
.artist{margin:7px 0 0;font-size:clamp(14px,1.4vw,16px);color:var(--muted);overflow-wrap:anywhere}
.host-line{display:flex;align-items:center;gap:8px;margin:12px 0 0;font-size:12.5px;color:var(--soft)}
.host-avatar{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--accent-soft);border:1px solid var(--accent-line);color:var(--accent-2);font-size:10.5px;font-weight:800}
.host-line b{color:var(--text-2);font-weight:700}
.status-row{display:flex;flex-wrap:wrap;gap:7px}
.badge{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:0 10px;border:1px solid var(--line-2);border-radius:999px;background:rgba(255,255,255,.04);font-size:11px;font-weight:650;color:var(--text-2);white-space:nowrap}
.badge.live{color:var(--ok);border-color:rgba(143,217,160,.32);background:rgba(143,217,160,.12)}
.badge.live i{width:7px;height:7px;border-radius:50%;background:currentColor}
.badge[data-sync="warn"]{color:var(--warn);border-color:rgba(230,198,130,.32);background:rgba(230,198,130,.12)}
.badge[data-sync="bad"]{color:var(--bad);border-color:rgba(255,154,154,.34);background:rgba(255,154,154,.12)}
.badge-people svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.progress{margin-top:18px}
.bar{height:5px;border-radius:999px;background:rgba(255,255,255,.11);overflow:hidden}
.bar i{display:block;height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .25s linear}
.times{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11.5px;color:var(--soft);font-variant-numeric:tabular-nums}
.times-sep{opacity:.5}
.times-left{margin-left:auto;color:var(--muted)}
.controls{display:flex;align-items:center;gap:12px;margin-top:14px;flex-wrap:wrap}
.vol{display:flex;align-items:center;gap:8px;flex:1;min-width:200px}
.vol-btn{display:grid;place-items:center;flex:none;width:44px;height:44px;border-radius:12px;background:transparent;color:var(--muted);transition:background var(--dur-1) var(--ease-out),color var(--dur-1) var(--ease-out)}
.vol-btn:hover{background:rgba(255,255,255,.06);color:var(--white)}
.vol-btn svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.vol input[type=range]{-webkit-appearance:none;appearance:none;flex:1;min-width:0;height:28px;margin:0;background:transparent;cursor:pointer}
.vol input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--accent) var(--fill,5%),rgba(255,255,255,.14) var(--fill,5%))}
.vol input[type=range]::-moz-range-track{height:4px;border-radius:999px;background:rgba(255,255,255,.14)}
.vol input[type=range]::-moz-range-progress{height:4px;border-radius:999px;background:var(--accent)}
.vol input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6px;border:0;border-radius:50%;background:var(--white);box-shadow:0 1px 4px rgba(0,0,0,.5)}
.vol input[type=range]::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--white)}
.vol input[type=range]:focus-visible{outline:2px solid var(--accent-line);outline-offset:4px;border-radius:999px}
.vol-label{flex:none;min-width:38px;text-align:right;font-size:11.5px;color:var(--soft);font-variant-numeric:tabular-nums}
.ghost-btn{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:0 13px;border:1px solid var(--line-2);border-radius:999px;background:transparent;color:var(--muted);font-size:11.5px;font-weight:650;transition:background var(--dur-1) var(--ease-out),color var(--dur-1) var(--ease-out)}
.ghost-btn:hover{background:rgba(255,255,255,.06);color:var(--white)}
.ghost-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.guest-note{display:flex;gap:9px;margin:12px 0 0;padding:11px 12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025);color:var(--soft);font-size:11.5px;line-height:1.5}.guest-note svg{width:14px;height:14px;flex:none;margin-top:1px;stroke:var(--accent);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.guest-note strong{color:var(--text-2);font-weight:700}
.guest-note a{color:var(--accent-2);text-decoration:underline;text-underline-offset:2px}
.guest-note a:hover{color:var(--white)}
.error{margin:14px 0 0;font-size:12.5px;line-height:1.55;color:var(--bad)}
.next-up{margin-top:16px;padding:12px 14px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.025)}
.next-up-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.next-up-head .eyebrow{color:var(--soft);letter-spacing:.13em}
.next-up-jump{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 2px;font-size:11px;font-weight:650;color:var(--muted)}
.next-up-jump:hover{color:var(--white)}
.next-up-jump svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.next-up-row{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:10px;margin-top:9px}
.next-up-row .q-art{width:40px;height:40px}
.next-up-title{display:block;font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.next-up-sub{display:block;font-size:11px;color:var(--soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.next-up-dur{font-size:11px;color:var(--soft);font-variant-numeric:tabular-nums}
@media (max-width:900px){.next-up{display:none}}
.panel{border:1px solid var(--line);border-radius:22px;background:linear-gradient(180deg,rgba(32,33,38,.86),rgba(25,26,31,.92));box-shadow:0 18px 50px rgba(0,0,0,.28),0 1px 0 var(--inset) inset;backdrop-filter:blur(18px)}
.queue-panel{flex:1 1 auto;min-height:220px;display:flex;flex-direction:column;overflow:hidden}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 18px 12px;flex:none}
.panel-head h2{margin:0;font-size:15px;font-weight:750;letter-spacing:-.01em}
.panel-sub{margin:4px 0 0;font-size:11.5px;color:var(--soft)}
.queue-count{display:grid;place-items:center;min-width:28px;height:28px;padding:0 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent-2);font-size:11.5px;font-weight:800;font-variant-numeric:tabular-nums}
.queue-scroll{flex:1;min-height:0;overflow-y:auto;padding:0 8px 8px;overscroll-behavior:contain;scrollbar-width:thin;mask-image:linear-gradient(#000 calc(100% - 22px),transparent);-webkit-mask-image:linear-gradient(#000 calc(100% - 22px),transparent)}
.queue-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.q-row{display:grid;grid-template-columns:26px 46px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:60px;padding:7px 8px;border-radius:12px;transition:background var(--dur-1) var(--ease-out)}
.q-row:hover{background:rgba(255,255,255,.035)}
.q-row.is-now{background:linear-gradient(90deg,var(--accent-soft),rgba(255,153,123,.04));box-shadow:0 0 0 1px var(--accent-line) inset}
.q-mark{display:grid;place-items:center;width:26px;height:26px;color:var(--soft)}
.q-num{font-size:11px;font-variant-numeric:tabular-nums;color:var(--soft)}
.q-art{width:46px;height:46px;border-radius:9px;background-color:var(--card-2);background-position:center;background-size:cover;box-shadow:0 1px 0 rgba(255,255,255,.08) inset}
.q-copy{min-width:0;display:flex;flex-direction:column;gap:3px}
.q-titleline{display:flex;align-items:center;gap:7px;min-width:0}
.q-titleline strong{min-width:0;font-size:12.5px;font-weight:650;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.q-row.is-now .q-titleline strong{color:var(--accent-2)}
.q-sub{font-size:11px;color:var(--soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.q-flag{flex:none;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;line-height:1;color:var(--accent);border:1px solid var(--accent-line);border-radius:999px;padding:2px 6px}
.q-dur{font-size:11px;color:var(--soft);font-variant-numeric:tabular-nums;padding-left:4px}
.q-row.is-played{opacity:.52}
.q-row.is-played:hover{opacity:.8}
.eq{display:flex;align-items:flex-end;gap:2px;height:16px}
.eq i{display:block;width:3px;border-radius:2px;background:var(--accent);height:40%;animation:eq 1.05s ease-in-out infinite}
.eq i:nth-child(2){height:85%;animation-delay:.18s}
.eq i:nth-child(3){height:55%;animation-delay:.36s}
.q-row.is-now.is-paused .eq i{animation-play-state:paused}
@keyframes eq{0%,100%{height:30%}50%{height:95%}}
.queue-empty,.queue-end{margin:8px;padding:16px 14px;border:1px dashed var(--line-2);border-radius:12px;font-size:12px;line-height:1.55;color:var(--soft);text-align:center}
.queue-end{margin:6px 8px 10px;border-style:solid;background:rgba(255,255,255,.02)}
.played{flex:none;border-top:1px solid var(--line);padding:4px 8px 8px}
.played summary{display:flex;align-items:center;gap:8px;padding:10px 8px;font-size:11px;font-weight:750;letter-spacing:.09em;text-transform:uppercase;color:var(--soft);cursor:pointer;list-style:none}
.played summary::-webkit-details-marker{display:none}
.played summary::before{content:'';width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(-45deg);transition:transform var(--dur-1)}
.played[open] summary::before{transform:rotate(45deg)}
.played summary span:first-child{flex:1}
.played-count{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:rgba(255,255,255,.06);color:var(--muted);font-size:10.5px;font-weight:750;font-variant-numeric:tabular-nums}
.room-panel{flex:none;padding:0 18px 16px}
.room-panel .panel-head{padding:16px 0 12px}
.chip{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border:1px solid var(--line-2);border-radius:999px;background:rgba(255,255,255,.04);font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.room-stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--line)}
.room-stats>div{padding:9px 11px;background:var(--panel)}
.room-stats dt{font-size:9.5px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;color:var(--soft)}
.room-stats dd{margin:3px 0 0;font-size:12.5px;font-weight:650;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.room-note{margin:12px 0 0;font-size:11.5px;line-height:1.55;color:var(--soft)}
.room-link{display:inline-flex;align-items:center;gap:6px;margin-top:12px;font-size:12px;font-weight:650;color:var(--accent-2)}
.room-link:hover{color:var(--white)}
.room-link svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.foot{flex:none;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;line-height:1.55;color:var(--soft)}
.foot a{color:var(--muted);text-decoration:underline;text-underline-offset:2px}
.foot a:hover{color:var(--white)}
.mini{position:fixed;left:12px;right:12px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:40;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line-2);border-radius:16px;background:rgba(25,26,31,.94);box-shadow:0 18px 50px rgba(0,0,0,.6);backdrop-filter:blur(18px);overflow:hidden}
.mini-bar{position:absolute;left:0;right:0;top:0;height:2px;background:rgba(255,255,255,.1)}
.mini-bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .25s linear}
.mini img{width:38px;height:38px;border-radius:8px;object-fit:cover;flex:none;background:var(--card-2)}
.mini-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.mini-copy strong{font-size:12px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini-copy span{font-size:10.5px;color:var(--soft);font-variant-numeric:tabular-nums}
.mini-btn{display:grid;place-items:center;flex:none;width:44px;height:44px;border-radius:12px;color:var(--muted)}
.mini-btn:hover{background:rgba(255,255,255,.06);color:var(--white)}
.mini-btn svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
body.mini-on .shell{padding-bottom:calc(78px + env(safe-area-inset-bottom))}

/* ── the venue (opt-in view) ─────────────────────────────────────────────
   The room as a place: one illustrated SVG scene (brick wall, framed sleeves,
   wood floor, projector, DJ booth, sofas, plant, string lights) with the crowd
   drawn as figures on top and the room's real state in cards. No library, no
   assets, no second player: the whole scene is markup and CSS, lit by --hue
   sampled from the current artwork. */
.venue-host{flex:1;min-height:0;display:flex}
body[data-view="venue"]{height:100dvh;overflow:hidden}
body[data-view="venue"] .layout,
body[data-view="venue"] .foot{display:none}
body[data-view="venue"] .shell{height:100%}
body[data-view="venue"] .mini{display:none}
.venue{position:relative;flex:1;min-height:0;border-radius:22px;overflow:hidden;border:1px solid var(--line);background:#0a0807;isolation:isolate;--hue:14}
.v-scene{position:absolute;inset:0}
/* The room's light: a warm wash from the string lights and the stage, over the
   drawing rather than baked into it, so it can follow the current record. */
.v-scene::after{content:'';position:absolute;inset:0;pointer-events:none;background:
  radial-gradient(58% 42% at 52% 8%,rgba(255,206,140,.16),transparent 72%),
  radial-gradient(46% 34% at 66% 32%,hsl(var(--hue) 90% 60% / .14),transparent 74%),
  radial-gradient(80% 50% at 50% 100%,rgba(0,0,0,.42),transparent 70%)}
.v-art-svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.v-screen-glow{stroke:hsl(var(--hue) 85% 65% / .5);filter:drop-shadow(0 0 18px hsl(var(--hue) 90% 60% / .55))}
/* Anything in the scene that must follow the record's colour is styled here:
   CSS custom properties are not substituted inside SVG presentation attributes. */
.v-screen-fill{fill:hsl(var(--hue) 90% 74%)}
.v-neon-line{stroke:hsl(var(--hue) 96% 76%)}
.v-neon-halo{stroke:hsl(var(--hue) 96% 68% / .22);filter:blur(6px)}
.v-led{fill:hsl(var(--hue) 90% 66%)}
.v-lamp-glow{fill:hsl(var(--hue) 90% 66% / .5)}
/* The projector's caption lives in the SVG, so it scales with the room. */
.v-screen-title{font:750 26px/1 Inter,system-ui,sans-serif;fill:#fff;letter-spacing:-.3px}
.v-screen-sub{font:500 17px/1 Inter,system-ui,sans-serif;fill:rgba(255,255,255,.74)}
.v-screen-elapsed,.v-screen-total{font:600 15px/1 Inter,system-ui,sans-serif;fill:rgba(255,255,255,.66);font-variant-numeric:tabular-nums}
/* The people: illustrated figures drawn inside the scene, so they stand on the
   furniture rather than floating in front of it. Only the idle sway animates. */
/* The gate: the player's "listen live" overlay, redrawn on the stage because the
   venue hides the column the overlay lives in. */
.v-gate{position:absolute;inset:0;z-index:4;display:grid;place-items:center;align-content:center;gap:12px;background:rgba(6,7,10,.52);backdrop-filter:blur(3px);text-align:center;padding:20px}
.v-gate-btn{display:inline-flex;align-items:center;gap:10px;min-height:52px;padding:0 26px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:15px;font-weight:750;box-shadow:0 12px 34px rgba(233,130,97,.38);transition:transform var(--dur-1) var(--ease-out),background var(--dur-1) var(--ease-out)}
.v-gate-btn:hover{background:var(--accent-2)}
.v-gate-btn:active{transform:scale(.96)}
.v-gate-btn:disabled{opacity:.65;cursor:progress}
.v-gate-btn svg{width:16px;height:16px;fill:currentColor}
.v-gate-note{margin:0;font-size:11.5px;line-height:1.5;color:var(--text-2);max-width:34ch}
.v-people{pointer-events:none}
.v-figure .v-pose{transform-box:fill-box;transform-origin:50% 100%;animation:v-sway 7s ease-in-out infinite;animation-delay:var(--d)}
.v-figure[data-pose="dance"] .v-pose{animation:v-dance 2.6s ease-in-out infinite;animation-delay:var(--d)}
.v-figure[data-pose="sit"] .v-pose{animation:none}
@keyframes v-sway{0%,100%{transform:rotate(var(--lean))}50%{transform:rotate(calc(var(--lean) * -1)) translateY(-1.5px)}}
@keyframes v-dance{0%,100%{transform:rotate(var(--lean))}25%{transform:rotate(calc(var(--lean) + 3deg)) translateY(-3px)}75%{transform:rotate(calc(var(--lean) - 3deg)) translateY(-1px)}}
.v-tag{font:750 15px/1 Inter,system-ui,sans-serif;fill:#fff;paint-order:stroke;stroke:rgba(8,9,12,.85);stroke-width:4px;stroke-linejoin:round}
.v-more text{font:700 15px/1 Inter,system-ui,sans-serif;fill:#d7d5da}
.v-bubble{overflow:visible;animation:v-pop .4s var(--ease-out) both}
.v-bubble>div{display:inline-block;padding:6px 11px;border-radius:12px 12px 12px 4px;background:rgba(250,247,242,.97);color:#191a1f;font:600 13px/1.3 Inter,system-ui,sans-serif;white-space:nowrap;box-shadow:0 8px 22px rgba(0,0,0,.5)}
.v-bubble.is-host>div{border-radius:13px 13px 13px 4px;background:hsl(var(--hue) 62% 90%)}
@keyframes v-pop{from{opacity:0;transform:translateY(6px) scale(.94)}}
/* The cards over the room: now playing, the queue drawer, the transport. */
.v-now{position:absolute;left:2.6%;top:8%;z-index:4;max-width:min(19%,260px);padding:10px 13px 11px;border:1px solid hsl(var(--hue) 60% 60% / .3);border-radius:14px;background:rgba(10,11,14,.74);backdrop-filter:blur(12px);box-shadow:0 16px 40px rgba(0,0,0,.5)}
.v-now-eyebrow{display:block;font-size:9px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:hsl(var(--hue) 85% 72%)}
.v-now-title{display:block;margin-top:3px;font-size:13.5px;font-weight:750;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v-now-sub{display:block;margin-top:2px;font-size:10.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v-now-meta{display:flex;align-items:center;gap:8px;margin-top:7px;font-size:9.5px;color:var(--soft)}
.v-now-sync{padding:2px 7px;border-radius:999px;border:1px solid var(--line-2);font-weight:750}
.v-now-sync[data-sync="good"]{color:var(--ok);border-color:rgba(143,217,160,.35);background:rgba(143,217,160,.12)}
.v-now-sync[data-sync="warn"]{color:var(--warn);border-color:rgba(230,198,130,.35);background:rgba(230,198,130,.12)}
.v-tools{position:absolute;right:2.4%;top:3.4%;z-index:6;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:60%}
.v-themes{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--line-2);border-radius:999px;background:rgba(10,11,14,.66);backdrop-filter:blur(10px)}
.v-chip{min-height:26px;padding:0 9px;border-radius:999px;font-size:10.5px;font-weight:700;color:var(--soft);white-space:nowrap}
.v-chip:hover{color:var(--white)}
.v-chip[aria-pressed="true"]{background:rgba(255,255,255,.13);color:var(--white)}
.v-light{display:inline-flex;align-items:center;gap:6px;padding:0 3px 0 8px;min-height:32px;border:1px solid var(--line-2);border-radius:999px;background:rgba(10,11,14,.66);backdrop-filter:blur(10px)}
.v-light-label{font-size:9px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--soft)}
.v-hue{-webkit-appearance:none;appearance:none;width:66px;height:22px;margin:0;background:transparent;cursor:pointer}
.v-hue::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(90deg,#ff4d6d,#ffd166,#8fd9a0,#4dd4ff,#b388ff,#ff4d6d)}
.v-hue::-moz-range-track{height:4px;border-radius:999px;background:linear-gradient(90deg,#ff4d6d,#ffd166,#8fd9a0,#4dd4ff,#b388ff,#ff4d6d)}
.v-hue::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;margin-top:-4px;border:0;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.6)}
.v-hue::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:#fff}
.v-auto{min-height:24px;padding:0 7px;border-radius:999px;font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--soft)}
.v-auto[aria-pressed="true"]{color:hsl(var(--hue) 85% 74%);background:hsl(var(--hue) 70% 60% / .16)}
.v-exit{min-height:32px;padding:0 11px;border:1px solid var(--line-2);border-radius:999px;background:rgba(10,11,14,.66);backdrop-filter:blur(10px);font-size:10.5px;font-weight:750;color:var(--text-2)}
.v-exit:hover{background:rgba(255,255,255,.1);color:var(--white)}
.v-deck{position:absolute;left:2.4%;bottom:2.6%;z-index:6;display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:min(34%,330px)}
/* The order properties put the transport at the bottom of the deck without
   reordering the markup: the button stays first for keyboard users, and the
   drawer opens under it instead of pushing the button onto the room's cards. */
.v-transport{order:3}
.v-deck-queue{order:2}
.v-deck-btn{order:1}
.v-deck-btn{min-height:28px;padding:0 11px;border:1px solid var(--line-2);border-radius:999px;background:rgba(10,11,14,.7);backdrop-filter:blur(10px);font-size:10.5px;font-weight:750;color:var(--text-2)}
.v-deck-btn:hover{background:rgba(255,255,255,.1);color:var(--white)}
.v-deck-queue{width:100%;max-height:min(30vh,260px);overflow-y:auto;border:1px solid var(--line-2);border-radius:14px;background:rgba(10,11,14,.8);backdrop-filter:blur(14px);padding:6px;scrollbar-width:thin}
.v-deck-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.v-deck-list li{display:grid;grid-template-columns:16px 30px minmax(0,1fr) auto;align-items:center;gap:7px;padding:4px 5px;border-radius:8px}
.v-deck-list li:hover{background:rgba(255,255,255,.05)}
.v-deck-num{font-size:9.5px;color:var(--soft);font-variant-numeric:tabular-nums;text-align:right}
.v-deck-art{width:30px;height:30px;border-radius:5px;background-color:var(--card-2);background-size:cover;background-position:center}
.v-deck-copy{min-width:0}
.v-deck-copy strong{display:block;font-size:10.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v-deck-copy span{display:block;font-size:9.5px;color:var(--soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v-deck-dur{font-size:9.5px;color:var(--soft);font-variant-numeric:tabular-nums}
.v-deck-empty{margin:0;padding:9px;font-size:10.5px;color:var(--soft);text-align:center}
.v-transport{width:100%;padding:8px 11px 9px;border:1px solid var(--line-2);border-radius:14px;background:rgba(10,11,14,.78);backdrop-filter:blur(14px);box-shadow:0 16px 40px rgba(0,0,0,.5)}
.v-progress{height:4px;border-radius:999px;background:rgba(255,255,255,.16);overflow:hidden}
.v-progress i{display:block;height:100%;width:0;background:hsl(var(--hue) 90% 68%);transition:width .3s linear}
.v-transport-row{display:flex;align-items:center;gap:8px;margin-top:7px}
.v-time{font-size:10px;color:var(--soft);font-variant-numeric:tabular-nums;white-space:nowrap}
.v-vol{display:flex;align-items:center;gap:2px;margin-left:auto}
.v-vol .v-hue{width:58px}
.v-vol .v-hue::-webkit-slider-runnable-track{background:linear-gradient(90deg,hsl(var(--hue) 85% 66%) var(--fill,5%),rgba(255,255,255,.18) var(--fill,5%))}
.v-vol .v-hue::-moz-range-progress{height:4px;border-radius:999px;background:hsl(var(--hue) 85% 66%)}
.v-icon-btn{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;color:var(--text-2)}
.v-icon-btn:hover{background:rgba(255,255,255,.09);color:var(--white)}
.v-icon-btn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.v-link{min-height:26px;padding:0 9px;border-radius:999px;border:1px solid var(--line-2);font-size:9.5px;font-weight:750;color:var(--text-2)}
.v-link:hover{background:rgba(255,255,255,.09);color:var(--white)}
.venue[data-theme="concert"] .v-art-svg{filter:saturate(1.15) contrast(1.05)}
.venue[data-theme="concert"] .v-now{border-color:hsl(var(--hue) 70% 60% / .45)}
.venue[data-theme="room"] .v-now{max-width:min(22%,280px)}
.venue[data-theme="room"] .v-art-svg{filter:sepia(.18) saturate(.92) brightness(1.06)}
.venue[data-ended="1"] .v-screen-art{filter:grayscale(.75) brightness(.65)}
.venue[data-ended="1"] .v-figure{animation:none;opacity:.55}
@media (max-width:1100px){
  .v-now{max-width:min(24%,250px)}
  .v-deck{width:min(42%,300px)}
}
@media (max-width:900px){
  /* A phone gets the room whole, at the top, with the cards in flow beneath it:
     the scene is never cropped to a corner, and the controls are never layered
     over the crowd. */
  /* The stacked layout is taller than the viewport, so the page scrolls rather
     than the room leaving a dead area under its own cards. */
  body[data-view="venue"]{height:auto;min-height:100dvh;overflow-y:auto}
  /* The shell hugs its content: a stacked venue is shorter than the viewport,
     and stretching it would leave the room's own background below the cards. */
  body[data-view="venue"] .shell{height:auto;min-height:0}
  body[data-view="venue"] .venue-host{flex:none}
  .venue{display:flex;flex-direction:column;flex:none;border-radius:16px}
  .v-scene{position:relative;flex:none;aspect-ratio:16/10;inset:auto}
  .v-now,.v-tools,.v-deck{position:static;max-width:none;width:auto;left:auto;right:auto;top:auto;bottom:auto}
  /* The projector right above already carries the sleeve, the title and the
     artist at a readable size, so this card keeps only what the screen does not
     say: how many are listening, and whether this device is following. */
  .v-now{margin:8px 10px 0;padding:7px 11px;border-radius:999px;order:1;display:flex;align-items:center;gap:8px}
  .v-now-eyebrow,.v-now-title,.v-now-sub{display:none}
  .v-now-meta{margin-top:0;font-size:10px;gap:8px}
  .v-tools{order:2;margin:8px 10px 0;justify-content:flex-start;flex-wrap:wrap;gap:6px;overflow:visible}
  .v-themes,.v-light,.v-exit{flex:none}
  .v-light{padding:0 2px 0 7px}
  .v-hue{width:56px}
  .v-deck{order:4;margin:8px 10px 10px;align-items:stretch}
  .v-deck-btn{align-self:flex-start}
  .v-deck-queue{max-height:min(34vh,240px)}
  .v-transport{width:100%}
  /* The scene is one 1600-unit drawing scaled to ~390px, so text inside it is
     ~4x smaller on screen than in the design. Labels get their size back in
     user units, or they are unreadable at exactly the size where the room is
     the only thing on screen. */
  .v-tag{font-size:34px;stroke-width:7px}
  .v-bubble>div{font-size:38px;padding:12px 20px;border-radius:26px 26px 26px 8px}
  .v-more text{font-size:32px}
  .v-screen-title{font-size:38px}
  .v-screen-sub{font-size:26px}
  .v-screen-elapsed,.v-screen-total{font-size:24px}
}
@media (prefers-reduced-motion:reduce){
  .v-figure{animation:none}
  .v-bubble{animation:none}
  .v-progress i,.v-screen-bar i{transition:none}
}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:900px){
  body{height:auto;min-height:100dvh;overflow-x:hidden;overflow-y:auto}
  .shell{height:auto;min-height:calc(100dvh - 32px)}
  .layout{grid-template-columns:1fr;gap:18px;padding-top:16px;overflow:visible}
  .player{overflow:visible;padding-right:0}
  .side{overflow:visible}
  .queue-panel{max-height:none}
  .queue-scroll{overflow:visible;mask-image:none;-webkit-mask-image:none}
}
@media (max-width:640px){
  .topbar-title,.topbar-sep,.app-link{display:none}
  .topbar-actions{gap:6px}
  .room-code{min-height:32px;padding:0 9px}
  .copy-text{display:none}
  .icon-btn{padding:0 11px}
  .ghost-btn{display:none}
  /* The switch keeps its words: a hamburger and a house do not say "player" and
     "venue". It gets its own row under the brand, and the room code grows to
     fill what is left so the copy button never wraps onto a third line. */
  .topbar-actions{width:100%;gap:6px}
  .view-switch{flex:none}
  .view-btn{padding:0 10px;font-size:11px}
  .room-code{flex:1;justify-content:center;min-width:0}
  h1{font-size:clamp(23px,7vw,30px)}
  .stage{border-radius:16px}
  .controls{gap:8px}
  .foot{margin-top:10px}
  /* The now-playing flag competes with the title for the same line on a phone,
     and the eyebrow above already says it; shrink it rather than truncate the
     one title a visitor is looking for. */
  .q-row{gap:9px;padding:7px 7px}
  .q-flag{font-size:8px;letter-spacing:.06em;padding:2px 5px}
  .q-dur{padding-left:0}
}
@media (max-width:380px){.room-code-label{display:none}}
@media (prefers-reduced-motion:no-preference){.stage{animation:rise .5s var(--ease-out) both}@keyframes rise{from{opacity:0;transform:translateY(10px)}}}
@media (prefers-reduced-motion:reduce){.eq i{animation:none;height:55%}.bar i,.mini-bar i,.q-row,.icon-btn,.listen-btn,.ghost-btn,.vol-btn{transition:none}}
</style>
</head>
<body data-room="${htmlEsc(code)}" data-playing="${preview?.playing ? '1' : '0'}" data-status="connecting">
<div class="glow" id="listen-glow" aria-hidden="true" style="background-image:url(&quot;${htmlEsc(art)}&quot;)"></div>
<div class="shell">
  <header class="topbar">
    <a class="brand" href="${htmlEsc(`${base}/`)}" aria-label="sonora home"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2 9v6m4-10v14m4-16v18m4-14v10m4-13v16m4-11v6"/></svg></span>sonora<span class="brand-dot">.</span></a>
    <span class="topbar-sep" aria-hidden="true"></span>
    <span class="topbar-title">Listen together</span>
    <div class="topbar-actions">
      <div class="view-switch" role="group" aria-label="View">
        <button class="view-btn" id="listen-view-player" type="button" data-view="player" aria-pressed="true" aria-label="Player view"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span>Player</span></button>
        <button class="view-btn" id="listen-view-venue" type="button" data-view="venue" aria-pressed="false" aria-label="Venue view"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20V9l9-5 9 5v11"/><path d="M9 20v-6h6v6"/></svg><span>Venue</span></button>
      </div>
      <span class="room-code"><span class="room-code-label">Room</span><b id="listen-code">${htmlEsc(code.toUpperCase())}</b></span>
      <button class="icon-btn" id="listen-copy" type="button" data-copy aria-label="Copy room link"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg><span class="copy-text" data-copy-label>Copy link</span></button>
      <a class="app-link" href="${htmlEsc(open)}">Open sonora<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
    </div>
  </header>

  <main class="layout">
    <section class="player" id="listen-player" aria-labelledby="listen-title">
      <div class="stage">
        <img id="listen-art" src="${htmlEsc(art)}" alt="" decoding="async">
        <div class="stage-shade" aria-hidden="true"></div>
        <div class="stage-tags"><span class="stage-live" id="listen-stage-state"><i aria-hidden="true"></i><span id="listen-stage-label">Live</span></span><span class="stage-guest">Guest</span></div>
        <div class="overlay" id="listen-overlay">
          <button class="listen-btn" id="listen-start" type="button"${startDisabled}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>${startLabel}</button>
        </div>
      </div>

      <div class="now">
        <div class="now-head">
          <span class="eyebrow">Now playing<span class="eyebrow-dim" id="listen-now-index">${htmlEsc(nowIndex)}</span></span>
          <div class="status-row">
            <span class="badge live" id="listen-status" aria-live="polite"><i aria-hidden="true"></i><span>Connecting…</span></span>
            <span class="badge" id="listen-sync" data-sync="idle">Not synced yet</span>
            <span class="badge badge-people"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 19v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V19"/><circle cx="9" cy="7" r="3.5"/><path d="M17 5.2a3.5 3.5 0 0 1 0 6.6M22 19v-1.5a4 4 0 0 0-3-3.8"/></svg><b id="listen-listeners">${listeners}</b><span>listening</span></span>
          </div>
        </div>
        <h1 id="listen-title">${htmlEsc(title)}</h1>
        <p class="artist" id="listen-artist">${htmlEsc(artist)}</p>
        <p class="host-line"><span class="host-avatar" id="listen-host-avatar" aria-hidden="true">${htmlEsc(hostInitial)}</span>Hosted by <b id="listen-host">${htmlEsc(host)}</b></p>
      </div>

      <div class="progress">
        <div class="bar" role="progressbar" aria-label="Track progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="listen-bar"><i></i></div>
        <div class="times"><span id="listen-elapsed">0:00</span><span class="times-sep">/</span><span id="listen-duration">–:––</span><span class="times-left" id="listen-current-left"></span></div>
      </div>

      <div class="controls">
        <div class="vol">
          <button class="vol-btn" id="listen-mute" type="button" aria-label="Mute" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path id="listen-vol-wave" d="M16.5 8.5a5 5 0 0 1 0 7"/></svg></button>
          <input id="listen-volume" type="range" min="0" max="100" step="1" value="5" aria-label="Volume" style="--fill:5%">
          <span class="vol-label" id="listen-vol-label" aria-hidden="true">5%</span>
        </div>
        <button class="ghost-btn" id="listen-copy-secondary" type="button" data-copy aria-label="Copy room link"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg><span data-copy-label>Copy link</span></button>
      </div>

      <div class="next-up" id="listen-next-up" hidden>
        <div class="next-up-head"><span class="eyebrow">Up next</span><button class="next-up-jump" id="listen-next-jump" type="button">See the queue<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M13 7l5 5-5 5"/></svg></button></div>
        <div class="next-up-row"><span class="q-art" id="listen-next-art" aria-hidden="true"></span><span><span class="next-up-title" id="listen-next-title"></span><span class="next-up-sub" id="listen-next-sub"></span></span><span class="next-up-dur" id="listen-next-dur"></span></div>
      </div>

      <p class="error" id="listen-error" role="alert" hidden></p>
    </section>

    <aside class="side">
      <section class="panel queue-panel" aria-labelledby="listen-queue-heading">
        <header class="panel-head">
          <div><h2 id="listen-queue-heading">Queue</h2><p class="panel-sub" id="listen-queue-meta">${htmlEsc(queueMeta)}</p></div>
          <span class="queue-count" id="listen-queue-count" aria-label="${queue.length} tracks">${queue.length}</span>
        </header>
        <div class="queue-scroll" id="listen-queue-scroll">
          <ol class="queue-list" id="listen-queue">${currentRow}${upcomingRows}</ol>
          <p class="queue-empty" id="listen-queue-empty"${currentTrack ? ' hidden' : ''}>The queue is empty. ${htmlEsc(host)} can add a track from sonora.</p>
          <p class="queue-end" id="listen-queue-end"${currentTrack && !upcoming.length ? '' : ' hidden'}>That’s the last track in the queue. ${htmlEsc(host)} can add more from sonora.</p>
          <details class="played" id="listen-played"${playedRows ? '' : ' hidden'}>
            <summary><span>Played earlier</span><span class="played-count" id="listen-played-count">${played.length}</span></summary>
            <ol class="queue-list queue-list-played" id="listen-played-list">${playedRows}</ol>
          </details>
        </div>
      </section>

      <section class="panel room-panel" aria-labelledby="listen-room-heading">
        <header class="panel-head"><h2 id="listen-room-heading">The room</h2><span class="chip">Public</span></header>
        <dl class="room-stats">
          <div><dt>Host</dt><dd id="listen-room-host">${htmlEsc(host)}</dd></div>
          <div><dt>Listening</dt><dd><b id="listen-room-listeners">${listeners}</b></dd></div>
          <div><dt>Control</dt><dd id="listen-room-control">${htmlEsc(controlLabel)}</dd></div>
          <div><dt>Opened</dt><dd id="listen-room-started">${htmlEsc(listenAgo(preview?.createdAt))}</dd></div>
        </dl>
        <p class="room-note" id="listen-room-note">${htmlEsc(roomNote)}</p>
        <div class="guest-note"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><p><strong>Listening as a guest.</strong> Playback is the room’s. <a href="${htmlEsc(open)}">Sign in to sonora</a> to take part.</p></div>
        <a class="room-link" href="${htmlEsc(open)}">Open in sonora<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
      </section>
    </aside>
  </main>

  <div class="venue-host" id="listen-venue-host" hidden></div>

  <footer class="foot"><span>No account needed — the link is the invitation. Playback stays in sync with everyone in the room.</span><a href="${htmlEsc(open)}">Sign in to control playback</a></footer>
</div>

<div class="mini" id="listen-mini" hidden>
  <div class="mini-bar" aria-hidden="true"><i id="listen-mini-bar"></i></div>
  <img id="listen-mini-art" src="${htmlEsc(art)}" alt="">
  <div class="mini-copy"><strong id="listen-mini-title">${htmlEsc(title)}</strong><span id="listen-mini-time">0:00 / –:––</span></div>
  <button class="mini-btn" id="listen-mini-mute" type="button" aria-label="Mute" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path id="listen-mini-vol-wave" d="M16.5 8.5a5 5 0 0 1 0 7"/></svg></button>
</div>
<audio id="listen-audio" preload="auto"></audio>
<script type="module" src="/listen.js"></script>
</body>
</html>`;
}

/** A live page for a room that cannot be listened to right now. */
function listenUnavailableHtml({ base, code, reason }) {
  const open = code ? `${base}/#/room/${encodeURIComponent(code)}` : `${base}/`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111215"><meta name="color-scheme" content="dark">
<meta name="robots" content="noindex"><title>Listen together \u00b7 sonora</title>
<link rel="stylesheet" href="/fonts.css">
<style>
:root{color-scheme:dark;--white:#fbf9f6;--muted:#a5a4ad;--soft:#8f8f99;--accent:#ff997b;--accent-ink:#241814}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(120% 90% at 50% 0,#1b1c22 0,#111215 55%,#0d0e11 100%);color:var(--white);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:calc(32px + env(safe-area-inset-top)) 22px calc(32px + env(safe-area-inset-bottom));text-align:center}
main{max-width:380px}
h1{font-size:21px;letter-spacing:-.02em;margin:0 0 10px}
p{color:var(--muted);font-size:13.5px;line-height:1.65;margin:0 0 24px}
a{display:inline-flex;align-items:center;min-height:46px;padding:0 24px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-weight:650;text-decoration:none}
</style></head>
<body><main><h1>Listen together</h1><p>${htmlEsc(reason)}</p>
<a href="${htmlEsc(open)}">Open sonora</a></main></body></html>`;
}

app.get('/l/:code/live', {
  // The one un-throttled route that *writes*: every request runs roomPreview, an
  // HMAC sign and a Set-Cookie. It sat behind the global allowList (which exempts
  // everything outside /api/), so an anonymous loop could mint guest identities
  // and drive upstream room reads without limit. Its own small per-IP budget, with
  // the global allowList cleared so it applies; a household sharing one IP still
  // has room for the one request per tab it actually makes.
  config: { rateLimit: { max: 60, timeWindow: '1 minute', allowList: null } },
}, async (req, reply) => {
  const { code } = req.params;
  const base = publicBase(req);
  const preview = ROOM_CODE.test(code) ? roomPreview(code) : null;
  if (!preview) {
    return reply.code(404).type('text/html; charset=utf-8').header('cache-control', 'no-store')
      .send(listenUnavailableHtml({ base, code: null, reason: 'This room has ended, or the link is not a room.' }));
  }
  if (preview.visibility !== 'public') {
    return reply.code(403).type('text/html; charset=utf-8').header('cache-control', 'no-store')
      .send(listenUnavailableHtml({
        base, code,
        reason: 'This room is private. Sign in, then ask the host to invite you.',
      }));
  }
  // Mint the guest cookie with the page itself. Sending it here rather than
  // behind a click means the audio element can be preloading the room's real
  // source while the visitor reads the track name — so the one gesture they do
  // make is a plain play() on a ready source, which no browser refuses, and a
  // refresh resumes from where the room is instead of from scratch.
  mintGuest(req, reply, code);
  return reply.type('text/html; charset=utf-8')
    // A live room changes every few seconds; never let a proxy pin this page.
    .header('cache-control', 'no-store')
    .send(listenHtml({ base, code, preview }));
});

// ── share cards ─────────────────────────────────────────────────────────
/**
 * A shared track has to *look* like a track in the app that receives it, and
 * that card is drawn by the receiving client's crawler from Open Graph tags —
 * never by this app's JavaScript. Three consequences, all of which were missing:
 *
 *   * the link is a real path (`/t/<id>`), not the client's `#/t/<id>` hash.
 *     A fragment never reaches the server, so a crawler fetching the hash link
 *     got `/` and saw the generic app shell.
 *   * the artwork answers without a session. A crawler sends no cookies, and
 *     `/api/img/:videoId` replies 401, so the card had no image at all.
 *   * the metadata is server-rendered. There is no JavaScript in this page, so
 *     there is nothing for a crawler to fail to run.
 *
 * The page is a landing page, not the app: it shows what the sharer already put
 * in the chat, then hands the visitor to the SPA, where the login wall applies
 * unchanged. Nothing personal is exposed — no likes, no history, no counts.
 *
 * No upstream lookup happens here, on purpose. Every track the UI can show is
 * upserted by the search / radio / station / browse / playlist handlers, so an
 * id this instance has never seen can only have come from another instance.
 * Paying a 2-25 s (possibly bot-gated) YouTube fetch on a public URL to prettify
 * that case is not worth the DoS surface; an unknown id still renders a card
 * and still links into the app.
 */

/** Square fallback for a track whose art is unavailable. */
const SHARE_FALLBACK_ART = '/icons/icon-512.png';

/**
 * Absolute origin for the card's URLs.
 *
 * Open Graph requires absolute URLs, and behind a tunnel the origin the crawler
 * used is not the origin this process sees. `SONORA_PUBLIC_URL` is the honest
 * answer; otherwise the request's own Host is used, after a shape check so a
 * spoofed Host header cannot be reflected into og:url.
 */
function publicBase(req) {
  if (config.publicUrl) return config.publicUrl;
  // req.host/req.protocol include forwarded values only for an authenticated
  // proxy peer. Do not read X-Forwarded-* here: direct clients can forge them.
  return requestOrigin(req) ?? `http://127.0.0.1:${config.port}`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function htmlEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** "3:34" — the duration line under the artist, when the row knows it. */
function clockDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function shareHtml({ base, videoId, track }) {
  const meta = track ? cardMetadata(track) : null;
  const title = meta?.title || 'A track on sonora';
  const artist = meta?.artist || '';
  const duration = track ? clockDuration(track.durationS) : '';
  const seconds = Number.isFinite(track?.durationS) && track.durationS > 0
    ? String(Math.round(track.durationS)) : '';

  const url = videoId ? `${base}/t/${videoId}` : `${base}/`;
  const openUrl = videoId ? `${base}/#/t/${videoId}` : `${base}/`;
  const art = track ? `${url}/art.jpg` : `${base}${SHARE_FALLBACK_ART}`;
  const artW = track ? 1280 : 512;
  const artH = track ? 720 : 512;
  // Discord gives a card exactly two lines: a bold title and a grey
  // description. Artist first, duration second — the same shape as the card
  // that prompted this ("POP DAT THANG" over "DaBaby").
  const description = [artist, duration].filter(Boolean).join(' \u00b7 ') || 'Listen on sonora';
  const alt = artist ? `${title} by ${artist}` : title;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111215">
<meta name="color-scheme" content="dark">
<title>${htmlEsc(artist ? `${title} \u00b7 ${artist} \u00b7 sonora` : `${title} \u00b7 sonora`)}</title>
<meta name="description" content="${htmlEsc(description)}">
${videoId ? '' : '<meta name="robots" content="noindex">'}
<link rel="canonical" href="${htmlEsc(url)}">
<link rel="icon" href="/icons/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="sonora">
<meta property="og:url" content="${htmlEsc(url)}">
<meta property="og:title" content="${htmlEsc(title)}">
<meta property="og:description" content="${htmlEsc(description)}">
<meta property="og:image" content="${htmlEsc(art)}">
<meta property="og:image:secure_url" content="${htmlEsc(art)}">
<meta property="og:image:width" content="${artW}">
<meta property="og:image:height" content="${artH}">
<meta property="og:image:alt" content="${htmlEsc(alt)}">
${seconds ? `<meta property="music:duration" content="${seconds}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${htmlEsc(title)}">
<meta name="twitter:description" content="${htmlEsc(description)}">
<meta name="twitter:image" content="${htmlEsc(art)}">
${videoId ? `<link rel="alternate" type="application/json+oembed" href="${htmlEsc(`${base}/oembed.json?url=${encodeURIComponent(url)}`)}" title="${htmlEsc(title)}">` : ''}
<link rel="stylesheet" href="/fonts.css">
<style>
:root{color-scheme:dark;--bg:#111215;--card:#202126;--line:rgba(255,255,255,.11);--white:#fbf9f6;--muted:#a5a4ad;--soft:#6f6f7a;--accent:#ff997b;--accent-ink:#241814}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(120% 90% at 50% 0,#1b1c22 0,#111215 55%,#0d0e11 100%);color:var(--white);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:calc(32px + env(safe-area-inset-top)) 22px calc(32px + env(safe-area-inset-bottom))}
main{width:100%;max-width:400px;text-align:center}
.art{display:block;border-radius:18px;overflow:hidden;aspect-ratio:16/9;box-shadow:0 26px 64px rgba(0,0,0,.6),0 0 0 1px var(--line) inset;background-color:var(--card);background-repeat:no-repeat;background-position:center;background-size:cover,44px}
h1{margin:24px 0 0;font-size:clamp(21px,5.6vw,27px);line-height:1.18;letter-spacing:-.02em;font-weight:700;overflow-wrap:anywhere}
.artist{margin:9px 0 0;font-size:16px;color:var(--muted);overflow-wrap:anywhere}
.dur{margin:5px 0 0;font-size:13px;color:var(--soft);font-variant-numeric:tabular-nums}
.play{display:inline-flex;align-items:center;gap:9px;margin-top:28px;padding:14px 26px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:16px;font-weight:650;text-decoration:none;transition:transform .12s ease}
.play:active{transform:scale(.97)}
.play svg{width:14px;height:14px;fill:currentColor}
.note{margin:28px 0 0;font-size:12.5px;line-height:1.55;color:var(--soft)}
@media (prefers-reduced-motion:no-preference){.art{animation:rise .45s ease-out both}@keyframes rise{from{opacity:0;transform:translateY(10px)}}}
@media (prefers-reduced-motion:reduce){.play{transition:none}}
</style>
</head>
<body>
<main>
<a class="art" href="${htmlEsc(openUrl)}" aria-label="${htmlEsc(`Open ${alt} in sonora`)}" style="background-image:url(&#39;${htmlEsc(art)}&#39;),url(&#39;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27%236f6f7a%27%3E%3Cpath d=%27M9 18a3 3 0 1 1-2-2.83V6l11-2v10.17A3 3 0 1 1 16 12V7.5l-7 1.27V18z%27/%3E%3C/svg%3E&#39;)"></a>
<h1>${htmlEsc(title)}</h1>
${artist ? `<p class="artist">${htmlEsc(artist)}</p>` : ''}
${duration ? `<p class="dur">${htmlEsc(duration)}</p>` : ''}
<a class="play" href="${htmlEsc(openUrl)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>Open in sonora</a>
<p class="note">${track ? 'sonora is a personal music player.' : 'This track is not in this sonora library yet.'}</p>
</main>
</body>
</html>`;
}

/** The shareable page. Public by necessity: a crawler has no session. */
app.get('/t/:videoId', {
  // It performs a public database lookup, so it must not inherit the static
  // shell's global allowList exemption. Match the other public card routes.
  config: { rateLimit: { max: 120, timeWindow: '1 minute', allowList: null } },
}, async (req, reply) => {
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) {
    return reply.code(404).type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(shareHtml({ base: publicBase(req), videoId: null, track: null }));
  }
  return reply.type('text/html; charset=utf-8')
    // Long enough that a chat client's repeat fetches are cheap, short enough
    // that a corrected title reaches the next paste.
    .header('cache-control', 'public, max-age=300')
    .send(shareHtml({ base: publicBase(req), videoId, track: getTrack(videoId) }));
});

/**
 * The card's artwork, without a session.
 *
 * Same image and same cache entry as the app's large cover (`v:<id>:hi`), but
 * `public` rather than `private`, because the consumer here is a crawler or a
 * CDN and neither carries the viewer's cookie.
 */
app.get('/t/:videoId/art.jpg', {
  // Public and session-less, like the share page below — which is exactly why
  // it needs its own per-IP limit: the global limiter exempts everything
  // outside /api/, and each unseen id is an upstream fetch. 120/min keeps a
  // legitimate crawler fed while capping the anonymous fetch-amplification.
  // The global allowList is merged into every route's params, so it has to be
  // cleared here for the limit to bite at all.
  config: { rateLimit: { max: 120, timeWindow: '1 minute', allowList: null } },
}, async (req, reply) => {
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(404).send({ error: 'Bad video id.' });
  const base = `${IMG_UPSTREAM}/vi/${videoId}`;
  return proxyImage(`v:${videoId}:hi`, `${base}/maxresdefault.jpg`, reply,
    [`${base}/hq720.jpg`, `${base}/mqdefault.jpg`, `${base}/hqdefault.jpg`],
    'public, max-age=86400');
});

/**
 * oEmbed discovery. Discord ignores it; Slack, Notion and most unfurl tools do
 * not, and it costs one route. It is public like the share page and the
 * artwork, so it carries the same modest per-IP limit (unfurls are cheap here —
 * the route never fetches upstream — but it must not be the one public route a
 * client can hammer without limit).
 */
app.get('/oembed.json', {
  // Same public-exposure reasoning as the artwork route above: own per-IP
  // limit, and the global allowList cleared so it applies.
  config: { rateLimit: { max: 120, timeWindow: '1 minute', allowList: null } },
}, async (req, reply) => {
  // oEmbed is read by the consumer's own page, including its validation errors.
  reply.header('access-control-allow-origin', '*');
  const invalid = (message = 'Expected the canonical /t/<track-id> URL.') => reply.code(400)
    .header('cache-control', 'no-store').send({ error: message });

  const raw = req.query?.url;
  if (typeof raw !== 'string' || raw.length > 2048) return invalid();
  let target;
  try { target = new URL(raw); } catch { return invalid(); }

  const base = publicBase(req);
  // This provider only describes its own canonical track cards. A regex suffix
  // match would otherwise bless evil.example/t/<id>, credentials, extra paths,
  // query strings and fragments, making this provider vouch for another resource.
  if (target.origin !== base || target.username || target.password) {
    return invalid('Only a canonical same-origin track URL is supported.');
  }
  const match = /^\/t\/([A-Za-z0-9_-]{11})$/.exec(target.pathname);
  const videoId = match?.[1];
  const canonical = videoId ? `${base}/t/${videoId}` : null;
  if (!videoId || target.href !== canonical || target.search || target.hash) return invalid();

  const track = getTrack(videoId);
  if (!track) {
    return reply.code(404).header('cache-control', 'no-store')
      .send({ error: 'Track not found.' });
  }
  const meta = cardMetadata(track);
  return reply
    .header('cache-control', 'public, max-age=300')
    .send({
      version: '1.0',
      // This is a link card, not an HTML embed. Declaring `rich` without its
      // required html/width/height fields produced a schema-invalid oEmbed reply.
      type: 'link',
      url: canonical,
      provider_name: 'sonora',
      provider_url: base,
      title: [meta.title || 'A track on sonora', meta.artist].filter(Boolean).join(' \u2014 '),
      ...(meta.artist ? { author_name: meta.artist } : {}),
      thumbnail_url: `${base}/t/${videoId}/art.jpg`,
      thumbnail_width: 1280,
      thumbnail_height: 720,
    });
});

// ── error handling ──────────────────────────────────────────────────────

// Unlike static files, an unmatched path answers no representation at all. Make
// that negative answer uncacheable for GET/HEAD (and harmlessly for other
// methods); the global onRequest hook supplies the baseline security headers.
app.setNotFoundHandler((req, reply) => {
  reply.code(404).header('cache-control', 'no-store').send({ error: 'Not found.' });
});

app.setErrorHandler((err, req, reply) => {
  // Expected malformed input and rate limits are normal traffic, not server
  // faults. Keep their status and request id in logs without printing a full
  // stack for every 400/413/429; reserve error level and the error object for 5xx.
  const status = Number(err.statusCode) || 500;
  if (status >= 400 && status < 500) req.log.info({ status, code: err.code }, 'request rejected');
  else req.log.error(err);
  // A hijacked SSE stream (or a reply that has already flushed its headers)
  // cannot be answered: writing a JSON error into a text/event-stream corrupts
  // it, and Fastify throws FST_ERR_REP_ALREADY_SENT, which re-enters this
  // handler. Drop the connection instead — the client treats that as a
  // disconnect it can retry.
  if (reply.sent || reply.raw.headersSent) {
    try { reply.raw.destroy(); } catch {}
    return;
  }
  const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  reply.code(code).send({ error: code === 500 ? 'Internal error.' : err.message });
});

const close = async (exitCode = 0) => {
  if (closing) return;
  closing = true;
  stopSchedulers();
  // server.close() waits for every open connection, and a room's SSE stream
  // never ends on its own: without this, SIGTERM hung until the supervisor's
  // kill timeout (measured: still alive after 8 s with one client connected)
  // and every restart became a hard kill mid-request.
  const force = setTimeout(() => {
    try { app.server.closeAllConnections?.(); } catch {}
  }, 5000);
  force.unref?.();
  // No timer can enqueue another poll after this point. Detached audio work is
  // cancelled through ensureAudio's subscriber signal, and every registered job
  // gets a chance to finish its SQLite/filesystem cleanup before db.close().
  await drainJobs();
  try {
    await app.close();
  } catch (err) {
    console.warn('[sonora] shutdown:', err?.message ?? err);
  }
  clearTimeout(force);
  try { db.close(); } catch {}
  process.exit(exitCode);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => close(0));

// Process-level backstops. A rejected promise nobody awaited (a stray upstream
// call, a stream callback) used to take the whole server down mid-song on Node
// 22's default; log it instead so one bad request cannot silence the house.
process.on('unhandledRejection', (err) => {
  console.error('[sonora] unhandled rejection:', err?.stack ?? err);
});
process.on('uncaughtException', (err) => {
  // State is unknown after an uncaught throw, so this one still shuts down —
  // gracefully, and with a non-zero code so a supervisor notices.
  console.error('[sonora] uncaught exception:', err?.stack ?? err);
  close(1);
});

await app.listen({ port: config.port, host: config.host });
console.log(`[sonora] http://${config.host}:${config.port} (pid ${process.pid}, ${API_FEATURES.length} api features)`);
await pruneCache();
// Session housekeeping: expired refresh tokens and stale WebAuthn ceremonies are
// dead weight, and a device unseen for two months is a device the user has long
// since replaced. Cheap to run once at boot; nothing here is on a hot path.
function sweepExpired() {
  try {
    const tokens = deleteExpiredRefreshTokens();
    const ceremonies = deleteExpiredChallenges();
    const devices = pruneStaleDevices(60);
    const roomsGone = expireRooms();
    // upstream_cache only deletes an expired row when something reads that exact
    // key, so rows nobody asks for again (a `?fresh=1` station draw, a one-off
    // search) lived forever. That was swept at boot only, which on a long-lived
    // container means "once, months ago".
    const cacheRows = pruneExpiredCache();
    // A deleted account's station blobs have no foreign key to cascade from, and
    // SQLite reuses the highest rowid, so a new user could inherit them.
    const orphanRows = pruneOrphanCache();
    // Keep this on the hourly path as well as boot: notifications are an events
    // feed, not permanent storage. The bell's retention was previously promised
    // by a comment but only ran once per process lifetime.
    pruneNotifications(60);
    // `plays` had no retention at all, while two hot paths aggregate it: the
    // station's candidate query and /api/stats, whose LIMIT applies *after* the
    // aggregate. Most of what grows the table is write-only — a `progress`
    // heartbeat every few seconds of playback, plus the unlike/dislike markers
    // older builds wrote and nothing reads — so those are what prunePlays()
    // retires (90 days; the start/complete/skip rows that *are* the listening
    // history are kept, see db.js). An old heartbeat contributes nothing to any
    // answer: a track's depth is the deepest fraction heard, and that is either
    // recent or already lost.
    const oldPlays = prunePlays();
    if (tokens || ceremonies || devices || roomsGone || cacheRows || orphanRows || oldPlays) {
      console.log(`[sonora] pruned ${tokens} refresh token(s), ${ceremonies} ceremony(s), ${devices} stale device(s), ${roomsGone} room(s), ${cacheRows} cache row(s), ${orphanRows} orphan cache row(s), ${oldPlays} old play(s)`);
    }
  } catch (err) {
    console.warn('[sonora] session housekeeping failed:', err.message);
  }
}
sweepExpired();
// Hourly: the audio cache ceiling is enforced where bytes are added (see
// ensureAudio), but a cache that is only pruned at boot and from the admin
// button grows again between restarts and can fill the disk — which fails
// playback *and* SQLite's writes. The same tick sweeps the expired rows above,
// rooms included; their former second hourly timer only expired the same rows
// twice. Long async prunes are skipped, never overlapped or queued by each tick.
let cachePruneJob = null;
function scheduleCachePrune() {
  if (closing || cachePruneJob) return;
  const job = trackDetached('hourly cache prune', () => pruneCache());
  cachePruneJob = job;
  const settled = () => { if (cachePruneJob === job) cachePruneJob = null; };
  job.promise.then(settled, settled);
  job.promise.catch((err) => console.warn('[sonora] cache prune failed:', err.message));
}
schedulePeriodic(() => {
  scheduleCachePrune();
  sweepExpired();
}, 60 * 60_000);
// Release checks have their own, much slower clock. A new album is not urgent,
// and every followed artist costs one catalogue page fetch, so twenty minutes is
// often enough to feel current and rare enough that a dozen follows are a
// handful of requests an hour. Only artists somebody actually follows are ever
// touched: the sweep reads the follow table, it never walks the catalogue.
schedulePeriodic(() => {
  const job = beginFollowJob('scheduled follow poll', () => pollFollows(), { detached: true });
  // A slow previous/manual poll owns the slot. Skip this tick; the next one is
  // soon enough, and adding a queued poll behind it only repeats stale work.
  job?.promise.catch((err) => console.warn('[sonora] follow sweep failed:', err.message));
}, 20 * 60_000);
// Build the shared Innertube session now rather than inside the first search.
// Measured 2026-10-20: session creation costs ~5 s (it fetches the player and
// config), and paying that on the first user search reads as "search is slow".
// Failure is harmless: getYT() clears its cache and the next call retries.
trackDetached('youtube session warm-up', () => getYT())?.promise
  .catch((err) => console.warn('[sonora] youtube session warm-up failed:', err.message));
// The station's genre lane votes with YouTube's genre pages (~14 shelves). It
// is warmed here rather than at boot *before* the session exists, because 14
// parallel page fetches on a cold client made the first station request slower
// (11 s) than paying for them lazily (2.6 s). Failures are harmless: the vote
// falls back to the other lanes.
trackDetached('genre shelf warm-up', async () => {
  await getYT();
  await new Promise((resolve) => setImmediate(resolve));
  return genreShelves();
})?.promise.catch((err) => console.warn('[sonora] genre shelf warm-up failed:', err.message));
if (config.isDev) console.warn('[sonora] SONORA_SECRET unset — sessions reset on restart');

// The bootstrap passphrase is the one credential nothing else validates: it is
// read from the environment at boot and hashed straight into the only admin
// account. Saying so once is the whole remedy — refusing to boot would strand an
// existing install whose passphrase predates this floor, and rewriting it is not
// this process's business.
if (config.bootstrapPass) {
  const weak = passwordProblem(config.bootstrapPass);
  if (weak) {
    console.warn(`[sonora] SONORA_PASSPHRASE is weak (${weak}) and it protects the admin account — change it.`);
  }
}

// A blank-but-present RP pair is the shipped-template footgun: config treats it
// as unset now, so say so once at boot instead of leaving the operator to
// discover it from a "passkeys need a real domain" message.
if (process.env.SONORA_RP_ID !== undefined && !config.rpId) {
  console.warn('[sonora] SONORA_RP_ID is set but blank — treated as unset (the request host is used). Remove it or give it a domain.');
}
if (process.env.SONORA_ORIGIN !== undefined && !config.origin) {
  console.warn('[sonora] SONORA_ORIGIN is set but blank — treated as unset (the request origin is used). Remove it or give it a URL.');
}
if (!config.rpId && !config.origin) {
  console.log('[sonora] passkeys use the request host as RP ID/origin; behind a tunnel set SONORA_RP_ID and SONORA_ORIGIN');
}
