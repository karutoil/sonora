import Fastify from 'fastify';
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
  pruneNotifications,
} from './db.js';
import {
  RoomError, ROOM_CODE, createRoom, joinRoom, leaveRoom, endRoom, updateRoom,
  inviteUser, uninviteUser, peopleFor, applyCommand, openStream, memberRoster,
  viewRoom, expireRooms, roomPreview, publicSnapshot, guestStreamAllowed,
} from './rooms.js';
import {
  rankSeeds, buildStation, stationName, stationBlurb, rotateSeeds, rotateArtists,
  rejectedBySkip, planPage, withLane, artistKeyOf, STATION_LIMIT, EXTEND_LIMIT,
  MAX_PER_ARTIST, MAX_PER_SEED_ARTIST,
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
import {
  parseNetscape, parseAny, inspectJar, saveJar, clearJar, restoreJar, jarStatus,
  activeCookiesPath, dbGet, decrypt,
} from './cookies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const COOKIE = 'sonora_session';
const startedAt = new Date();

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
    const key = songKey({ title: t.title, channel: t.channel, itemType: 'song' });
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * The personal station is built from this user's listening, likes and dislikes,
 * so any change to those inputs must drop the cached queue. Without this a
 * disliked track would keep playing until the ten-minute cache expired.
 */
function invalidateStation(userId) {
  cacheDeletePrefix(`station:${userId}:`);
}

/**
 * Track metadata a write may carry, so the server can remember a track it has
 * never seen. Liking a song opened from a share link used to store a like with
 * no title, which made that song invisible to the station *and* to the library.
 */
function rememberFromBody(videoId, b = {}) {
  const title = typeof b.title === 'string' ? b.title.slice(0, 200).trim() : '';
  if (!title) return;
  upsertTrack({
    videoId,
    title,
    channel: typeof b.channel === 'string' ? b.channel.slice(0, 200) : null,
    thumb: typeof b.thumb === 'string' ? b.thumb.slice(0, 500) : null,
    durationS: Number.isFinite(b.durationS) ? Math.round(b.durationS) : null,
  });
}

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
await app.register(rateLimit, {
  max: 600,
  timeWindow: '1 minute',
  allowList: (req) => !String(req.raw?.url ?? '').startsWith('/api/'),
});
await app.register(fastifyStatic, {
  root: PUBLIC,
  prefix: '/',
  // The PWA updates by reloading; never let a proxy pin an old bundle.
  // Note: v10 passes the Fastify reply, not a raw ServerResponse.
  setHeaders: (reply, filePath) => {
    reply.header(
      'cache-control',
      filePath?.endsWith('.html') ? 'no-cache' : 'no-cache, must-revalidate',
    );
  },
});

// ── auth ────────────────────────────────────────────────────────────────

const REFRESH_COOKIE = 'sonora_refresh';
const CHALLENGE_COOKIE = 'sonora_webauthn';

const trim = (value, max = 200) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : null;
};

function currentUser(req) {
  const payload = readSession(req.cookies?.[COOKIE]);
  if (!payload) return null;
  const row = db.prepare(`
    SELECT id, name, role, disabled, session_version FROM users WHERE id = ?
  `).get(payload.uid);
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
    }
    return {
      id: row.id, name: row.name, role: row.role,
      deviceId: device.id, remembered: Boolean(device.remembered), exp: payload.exp ?? null,
    };
  }
  return { id: row.id, name: row.name, role: row.role, deviceId: null, remembered: false, exp: payload.exp ?? null };
}

app.decorateRequest('user', null);
app.addHook('onRequest', async (req) => {
  req.user = currentUser(req);
});

/**
 * JSON API answers are personal and change without a version number: the
 * personal station is rebuilt when a like lands, and a 304 from Fastify's ETag
 * would hand the browser last week's queue. The artwork proxy sets its own long
 * cache headers below, so only /api/ is swept here.
 */
app.addHook('onSend', async (req, reply, payload) => {
  if (!req.url.startsWith('/api/')) return payload;
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

function baseCookie() {
  return { httpOnly: true, sameSite: 'lax', secure: !config.isDev, path: '/' };
}

function clearAuthCookies(reply) {
  return reply
    .clearCookie(COOKIE, { path: '/' })
    .clearCookie(REFRESH_COOKIE, { path: '/' })
    .clearCookie(CHALLENGE_COOKIE, { path: '/' });
}

function setChallengeCookie(reply, id) {
  reply.setCookie(CHALLENGE_COOKIE, id, { ...baseCookie(), maxAge: 300 });
}

function setRefreshCookie(reply, { token, expiresAt }) {
  const seconds = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  reply.setCookie(REFRESH_COOKIE, token, { ...baseCookie(), maxAge: seconds });
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
    db.prepare(`
      UPDATE devices SET name = ?, platform = COALESCE(?, platform), user_agent = ?,
        last_seen_at = ?, last_login_at = ?, last_ip = ?, remembered = ?
      WHERE id = ?
    `).run(name, platform, userAgent, now, now, ip, remember ? 1 : 0, existing.id);
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
function startSession(reply, user, device, remember, refresh = null) {
  const ttlMs = config.sessionMinutes * 60_000;
  const token = signSession({
    uid: user.id,
    ver: user.session_version ?? 1,
    sid: device.id,
    exp: Date.now() + ttlMs,
  });
  reply.setCookie(COOKIE, token, {
    ...baseCookie(),
    ...(remember ? { maxAge: Math.floor(ttlMs / 1000) } : {}),
  });
  if (remember) {
    const issued = refresh ?? issueRefreshToken({
      deviceId: device.id, userId: user.id, ttlMs: config.refreshDays * 86_400_000,
    });
    setRefreshCookie(reply, issued);
    setDeviceRemembered(device.id, true);
    return issued;
  }
  revokeDeviceTokens(device.id);
  setDeviceRemembered(device.id, false);
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
  const raw = String(hostHeader ?? '').split(',')[0].trim();
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
  const hostHeader = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0].trim() || 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http')
    .split(',')[0].trim() || 'http';
  return {
    rpID: config.rpId ?? hostnameOf(hostHeader),
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

function challengeIdFrom(req) {
  const id = trim(req.body?.challengeId, 200);
  const cookie = req.cookies?.[CHALLENGE_COOKIE];
  if (!id || !cookie || id !== cookie) return null;
  return id;
}

// ── auth routes ─────────────────────────────────────────────────────────

app.get('/api/auth/capabilities', async (req) => {
  const ctx = rpContext(req);
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  return {
    hasUsers,
    passkeys: passkeySupport(ctx),
    sessionMinutes: config.sessionMinutes,
    refreshDays: config.refreshDays,
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
  const name = String(req.body?.name ?? config.bootstrapUser).trim();
  const pass = String(req.body?.passphrase ?? '');
  const user = findUser(name);
  if (!user || !pass || !verifyPassword(user, pass)) {
    return reply.code(401).send({ error: 'Wrong name or passphrase.' });
  }
  if (user.disabled) {
    return reply.code(403).send({ error: 'This account has been disabled by an administrator.' });
  }
  const remember = req.body?.remember === true;
  const device = resolveDevice(req, user, remember);
  startSession(reply, user, device, remember);
  touchLogin(user.id);
  return reply.send({
    user: publicUser(user),
    device: publicDevice(device),
    remembered: remember,
    sessionMinutes: config.sessionMinutes,
  });
});

/**
 * Exchange a saved device's refresh token for a fresh access token. The token
 * rotates on every use: replaying an already-used token is treated as theft and
 * deletes the device, so both the thief and the legitimate client are locked out
 * and must sign in again.
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
    // Replay of a rotated token: revoke the whole device rather than trust it.
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
    // the replacement we just minted is orphaned. Drop it and treat this as a
    // replay — the device is revoked rather than left in an ambiguous state.
    revokeRefreshToken(next.id);
    deleteDevice(device.id);
    recordAudit({ actorId: user.id, action: 'refresh_replay', target: device.id, detail: 'concurrent rotation' });
    return clearAuthCookies(reply).code(401).send({ error: 'That saved session was already used. Sign in again.' });
  }
  touchDevice(device.id, { ip: req.ip, login: true });
  startSession(reply, user, device, true, next);
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
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  const challengeId = createChallenge({
    userId: user.id, kind: 'register', challenge: options.challenge,
    rpId: ctx.rpID, origin: ctx.origin,
  });
  setChallengeCookie(reply, challengeId);
  return { challengeId, options };
});

app.post('/api/auth/passkey/register/verify', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const challengeId = challengeIdFrom(req);
  const row = challengeId ? takeChallenge(challengeId, 'register') : null;
  reply.clearCookie(CHALLENGE_COOKIE, { path: '/' });
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
  // A name is only a hint: unknown names still get discoverable-credential
  // options, so the endpoint cannot be used to enumerate accounts.
  const name = trim(req.body?.name, 80);
  const user = name ? findUser(name) : null;
  const allowCredentials = user ? listPasskeyCredentials(user.id) : [];
  const options = await generateAuthenticationOptions({
    rpID: ctx.rpID,
    userVerification: 'required',
    ...(allowCredentials.length ? { allowCredentials } : {}),
  });
  const challengeId = createChallenge({
    userId: user?.id ?? null, kind: 'authenticate', challenge: options.challenge,
    rpId: ctx.rpID, origin: ctx.origin,
  });
  setChallengeCookie(reply, challengeId);
  return { challengeId, options };
});

app.post('/api/auth/passkey/login/verify', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const challengeId = challengeIdFrom(req);
  const row = challengeId ? takeChallenge(challengeId, 'authenticate') : null;
  reply.clearCookie(CHALLENGE_COOKIE, { path: '/' });
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
        counter: passkey.counter ?? 0,
        transports: passkey.transports ? passkey.transports.split(',').filter(Boolean) : undefined,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return reply.code(401).send({ error: 'That passkey did not verify.' });
    }
    const authInfo = verification.authenticationInfo;
    // A counter that fails to advance is the classic cloned-authenticator tell.
    // Many platform passkeys legitimately report 0, so only a real regression counts.
    if (authInfo.newCounter > 0 && passkey.counter > 0 && authInfo.newCounter <= passkey.counter) {
      recordAudit({ actorId: user.id, actorName: user.name, action: 'passkey_replay', target: String(passkey.id), detail: 'counter did not advance' });
      return reply.code(401).send({ error: 'That passkey looks cloned. Use another sign-in method.' });
    }
    updatePasskeyUse(passkey.id, authInfo.newCounter ?? 0, {
      deviceType: authInfo.credentialDeviceType ?? null,
      backedUp: Boolean(authInfo.credentialBackedUp),
    });
    const remember = req.body?.remember === true;
    const device = resolveDevice(req, user, remember);
    startSession(reply, user, device, remember);
    touchLogin(user.id);
    return { user: publicUser(user), device: publicDevice(device), remembered: remember };
  } catch (err) {
    req.log.warn({ err: err?.message }, 'passkey authentication failed');
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
  const remembered = typeof req.body?.remembered === 'boolean' ? req.body.remembered : null;
  if (!name && remembered === null) return reply.code(400).send({ error: 'Nothing to change.' });
  if (name) renameDevice(user.id, id, name);
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
      }), baseCookie());
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
  startSession(reply, fresh, device, Boolean(device.remembered));
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

// Two requests for the same shelf (a double-tap on Search, two tabs, the client
// re-rendering) would both miss the cache and both hit YouTube. One upstream
// call per query/type is enough: the second request waits on the first.
const searchInFlight = new Map();

/**
 * One type's worth of a search answer, cached on its own.
 *
 * A tab switch uses the answer from the same request, but typing the same query
 * again (or a second client asking) must not hammer YouTube: a few minutes of
 * cache is enough, since a search answer is not personal. The key carries the
 * query, the type and the limit, so a 4-artist shelf and a longer one cannot be
 * served from each other's slot.
 *
 * Failures are deliberately *not* cached by the caller (`catch` sits outside),
 * so a transient upstream error does not stick for the whole TTL.
 */
async function searchGroup(type, q, load) {
  const key = `search:${type}:${SEARCH_LIMITS[type]}:${q.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const pending = searchInFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    const items = await load();
    cacheSet(key, items, SEARCH_TTL_MS);
    return items;
  })().finally(() => searchInFlight.delete(key));
  searchInFlight.set(key, work);
  return work;
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
  if (!requireUser(req, reply)) return;
  const q = String(req.query?.q ?? '').trim().slice(0, 200);
  if (!q) return reply.code(400).send({ error: 'Missing q.' });
  const type = String(req.query?.type ?? 'all').trim().toLowerCase() || 'all';
  if (!SEARCH_TYPES.has(type)) return reply.code(400).send({ error: 'Unknown type.' });
  const wants = (t) => type === 'all' || type === t;

  const [tracks, artists, albums, playlists] = await Promise.all([
    wants('song')
      ? searchGroup('song', q, () => searchTracks(q, SEARCH_LIMITS.song)).catch(() => [])
      : [],
    wants('artist')
      ? searchGroup('artist', q, () => searchArtists(q, SEARCH_LIMITS.artist)).catch(() => [])
      : [],
    wants('album')
      ? searchGroup('album', q, () => searchAlbums(q, SEARCH_LIMITS.album)).catch(() => [])
      : [],
    wants('playlist')
      ? searchGroup('playlist', q, () => searchPlaylists(q, SEARCH_LIMITS.playlist)).catch(() => [])
      : [],
  ]);

  // A cached song shelf still feeds the track table, so upsert runs on every
  // answer rather than only on the request that missed the cache.
  for (const t of tracks) upsertTrack(t);

  const artistItems = artists.map(({ id, title, subscribers, thumb }) => ({ id, title, subscribers, thumb }));
  // `type` here is the shelf the row belongs to, not the release format: the
  // client renders both album and single rows with the same collection route.
  const albumItems = albums.map(({ id, title, author, year, trackCount, thumb }) => ({
    id, title, author: author ?? null, year: year ?? null, trackCount: trackCount ?? null, thumb, type: 'Album',
  }));
  const playlistItems = playlists.map(({ id, title, author, trackCount, thumb }) => ({
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
  const tracks = (await upNext(seed))
    .filter((t) => !disliked.has(t.videoId))
    .filter((t) => !songs.has(songKey({ ...t, itemType: 'song' })));
  for (const t of tracks) upsertTrack(t);
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
async function stationPage(userId, {
  cursor = 0, exclude = new Set(), limit = STATION_LIMIT, includeSeeds = true,
} = {}) {
  const { candidates, disliked, dislikedSongs, rejected } = stationRefusals(userId);
  const seeds = rankSeeds({ ...candidates, disliked });
  if (!seeds.length) return { seeds, tracks: [] };

  const plan = planPage({ limit, includeSeeds });
  const picked = rotateSeeds(seeds, { cursor, count: 3 });
  // The artist pool rotates on its own count so it does not stay pinned to the
  // same two artists while the seed cursor walks the list.
  const artistNames = rotateArtists(stationArtists(userId, 6), { cursor, count: 2 })
    .map((a) => a.name);

  // The artists this person actually plays: the definition of "familiar" for
  // the whole page, and the set whose own band is capped hardest.
  const knownArtists = new Set(allStationArtistNames(userId));
  const seedArtists = new Set(seeds.map((s) => String(s.channel ?? '')).filter(Boolean));

  // Two stages on purpose: the genre lane's vote needs the neighbours the
  // adjacent lane discovers. It does not wait for their *catalogues*, though —
  // the vote starts the moment the artist pages name them.
  let resolveNeighbours;
  const neighboursReady = new Promise((resolve) => { resolveNeighbours = resolve; });
  const trendingPending = neighboursReady
    .then((names) => trendingPool(seeds, names, plan.fetch.trending))
    .catch(() => []);

  const [related, byArtist, adjacent] = await Promise.all([
    Promise.all(picked.map((s) => upNext(s.videoId, 25).catch(() => []))),
    Promise.all(artistNames.map((a) => searchTracks(a, 12).catch(() => []))),
    adjacentProfile(picked, knownArtists, plan.fetch.adjacent, { onNeighbours: resolveNeighbours }),
  ]);
  // A lane with no artist pages to read never calls back; resolve it anyway so
  // the trending lane cannot wait forever.
  resolveNeighbours([]);

  // Split the up-next results by whether this person already knows the artist.
  // The familiarity of a *recommendation* is the useful distinction here, not
  // where it was fetched from: YouTube's "more like this" list for one song is
  // half the same band (familiar) and half the neighbouring scene (new).
  // Routing them apart is what stops the familiar lane from silently owning the
  // page — and it costs no extra request, which the neighbour lookups do.
  const knownKey = new Set([...knownArtists].map((a) => artistKeyOf(a)));
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
  });

  // Every track the page delivers is also evidence for the next one: playing
  // one of these through makes its artist familiar, which is what lets the
  // station follow the listener somewhere new.
  for (const t of tracks) upsertTrack(t);
  return { seeds, tracks, lanes: laneSummary(tracks) };
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
async function adjacentProfile(picked, knownArtists, limit = 8, { onNeighbours = null } = {}) {
  if (!picked.length || limit <= 0) return { tracks: [], neighbours: [] };
  const profiles = await Promise.all(picked.slice(0, 2).map(async (s) => {
    const id = s.channelId ?? await artistIdFor(s.channel).catch(() => null);
    if (!id) return null;
    return artistProfile(id).catch(() => null);
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

  // Each neighbour contributes its own catalogue's top songs, one at a time,
  // so a single lookalike band cannot own the lane.
  const lists = await Promise.all(neighbours.slice(0, 6).map(async (n) => {
    if (!n.id) return [];
    const page = await artistProfile(n.id).catch(() => null);
    return page?.songs ?? [];
  }));

  // One song per neighbour per round, up to the ceiling the caller asked for.
  // The caller is generous (see planPage.fetch): every pool is filtered again
  // for refusals and duplicates, so asking for exactly the quota returns short.
  const ceiling = Math.max(limit, 12);
  const tracks = [];
  for (let round = 0; tracks.length < ceiling && lists.some((l) => l.length > round); round++) {
    for (const list of lists) {
      const t = list[round];
      if (t && tracks.length < ceiling) tracks.push(t);
    }
  }
  return { tracks, neighbours: neighbours.map((n) => n.name) };
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
  // The whole shelf, not just this page's quota: the planner decides how many
  // of these slots are trending, and later pages need the rows this page did
  // not use (they are already in `exclude`).
  return genreSongs(genre, 40).catch(() => []);
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
    const shelves = await Promise.all(tiles.map(async (tile) => ({
      name: tile.name,
      artists: new Set((await genreSongs(tile.name, 50).catch(() => []))
        .map((s) => artistKeyOf(s.channel ?? s.artist))
        .filter(Boolean)),
    })));
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
  const key = genreCacheKey(names);
  const cached = GENRE_CACHE.get(key);
  if (cached) return cached;

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
app.get('/api/station', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;

  const name = stationName(user.name);

  // Building a page costs three or four YouTube calls, and the inputs only
  // change when the user plays, likes or dislikes something (all of which drop
  // this key). Cache it so the pinned entry feels instant. `?fresh=1` is the
  // Rebuild button: it asks for a new draw on purpose.
  const fresh = String(req.query?.fresh ?? '') === '1';
  const key = `station:${user.id}:${fresh ? `fresh:${Date.now()}` : 'first'}`;
  const hit = fresh ? null : cacheGet(key);
  if (hit) return { ...hit, cached: true };

  const { seeds, tracks, lanes } = await stationPage(user.id, {
    cursor: 0, limit: STATION_LIMIT, includeSeeds: true,
  });
  if (!seeds.length) {
    // An honest empty station beats a random one: it says what to do next.
    return { name, blurb: stationBlurb({}), seeds: [], tracks: [], empty: true };
  }

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
    empty: false,
  };
  // Ten minutes: opening the station twice is instant, but a queue cannot
  // outlive a listening session.
  cacheSet(key, payload, 10 * 60_000);
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

  const cursor = Math.max(0, Math.trunc(Number(req.query?.cursor) || 0));
  const raw = String(req.query?.exclude ?? '');
  const exclude = new Set(raw.split(',').map((s) => s.trim()).filter((s) => VIDEO_ID.test(s)).slice(0, 400));

  const { seeds, tracks, lanes } = await stationPage(user.id, {
    cursor, exclude, limit: EXTEND_LIMIT, includeSeeds: false,
  });
  if (!seeds.length) return { tracks: [], cursor, empty: true };
  return {
    tracks,
    lanes,
    // How far the *next* call should start. A page that found nothing still
    // advances, so a dry stretch cannot pin the station to one seed forever.
    cursor: cursor + 3,
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
    const items = await searchMoodPlaylists(q);
    cacheSet(key, items, 10 * 60_000);
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
    const fallback = await searchArtists(q || 'music');
    return { items: fallback.map((a) => ({ ...a, source: 'search' })) };
  }

  // Albums: releases by the artists you actually listen to.
  const seed = q || topArtists(user.id, 1)[0]?.title || 'music';
  const key = `browse:albums:${seed}`;
  const hit = cacheGet(key);
  if (hit) return { items: hit };
  const items = await searchAlbums(seed);
  cacheSet(key, items, 10 * 60_000);
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

  const id = /^UC[\w-]{20,}$/.test(raw) ? raw : await artistIdFor(raw);
  if (!id) return reply.code(404).send({ error: 'No such artist.' });

  const page = await artistPage(id);
  for (const t of [...page.songs, ...page.videos]) upsertTrack(t);
  const payload = { ...page, id };
  cacheSet(key, payload, 10 * 60_000);
  return { ...payload, following: isFollowing(user.id, id) };
});

/**
 * Which release a track belongs to, for "Open album".
 *
 * The client only asks when the track's own row did not carry an album id
 * (up-next, videos, older library rows). `title`/`artist` are accepted as
 * hints so the server does not have to re-read the track from YouTube.
 */
app.get('/api/album/for/:videoId', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const title = String(req.query?.title ?? '').trim().slice(0, 200) || null;
  const artist = String(req.query?.artist ?? '').trim().slice(0, 200) || null;
  const known = getTrack(videoId);
  const found = await albumForVideo(videoId, {
    title: title ?? known?.title ?? null,
    artist: artist ?? known?.channel ?? null,
  });
  return { albumId: found?.albumId ?? null, title: found?.title ?? null, author: found?.author ?? null };
});

/** Open a YouTube playlist or album by id. */
app.get('/api/album/:id', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const id = String(req.params.id).slice(0, 200);
  // MPR… is a Music album, which the playlist reader cannot fetch. Albums
  // opened from an artist page arrive in that form; the library's album tab
  // still uses PL ids and keeps the old path.
  if (/^MPR[\w-]+$/.test(id)) {
    const data = await albumPage(id);
    for (const t of data.tracks) upsertTrack(t);
    return { ...data, albumId: id };
  }
  const { title, author, type, tracks } = await playlistTracks(id);
  for (const t of tracks) upsertTrack(t);
  return { title, author, type, tracks };
});

// ── follows & notifications ─────────────────────────────────────────────
// A follow is a standing request stored on the server, so it survives a cleared
// browser and works from every device. The bell is a feed of what the sweep in
// src/follows.js found; the client renders it and turns unread rows into a
// Web/PWA notification, but the server stays the source of truth.

/** A channel id, which is the only thing a follow is keyed by. */
const ARTIST_ID = /^UC[\w-]{20,}$/;

app.post('/api/artists/:id/follow', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const artistId = String(req.params.id ?? '').trim();
  if (!ARTIST_ID.test(artistId)) return reply.code(400).send({ error: 'Not a channel id.' });
  const name = String(req.body?.name ?? '').trim().slice(0, 200) || null;
  const thumb = String(req.body?.thumb ?? '').trim().slice(0, 500) || null;

  followArtist(user.id, { artistId, name, thumb });

  // Baseline immediately, so following never fires a flood of "new album" for
  // the whole back catalogue. Two rules here: a dead upstream must not fail the
  // follow (following is a local decision), and the response must not wait on
  // YouTube. If the check never lands the next sweep baselines instead, because
  // an empty baseline means "first look" and notifies nothing.
  const bounded = new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    timer.unref?.();
  });
  await Promise.race([
    checkArtist(artistId).catch((err) => {
      console.warn('[sonora] follow baseline failed for', artistId, err.message);
    }),
    bounded,
  ]);

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
const lastNotificationCheck = new Map(); // userId → epoch ms

app.post('/api/notifications/check', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const nowMs = Date.now();
  const last = lastNotificationCheck.get(user.id) ?? 0;
  if (nowMs - last < NOTIFICATION_CHECK_MS) {
    return { created: 0, unread: countUnread(user.id), throttled: true };
  }
  // Stamped before the poll so two concurrent requests cannot both run it.
  lastNotificationCheck.set(user.id, nowMs);
  const { created } = await pollFollows({ limit: 4 });
  return { created, unread: countUnread(user.id) };
});

/** Lyrics for the now-playing sheet. Cached; null is a normal answer. */app.get('/api/lyrics/:videoId', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const key = `lyrics:${videoId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const text = await fetchLyrics(videoId);
  const payload = { text };
  cacheSet(key, payload, 6 * 60 * 60_000);
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
  const pl = getPlaylist(user.id, Number(req.params.id));
  if (!pl) return reply.code(404).send({ error: 'No such playlist.' });
  return { playlist: pl };
});

app.post('/api/playlists/:id/tracks', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const videoId = String(req.body?.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const ok = addPlaylistItem(user.id, Number(req.params.id), {
    videoId,
    title: String(req.body?.title ?? '').slice(0, 300) || null,
    channel: String(req.body?.channel ?? '').slice(0, 200) || null,
    channelId: String(req.body?.channelId ?? '').slice(0, 64) || null,
    durationS: Number.isFinite(req.body?.durationS) ? req.body.durationS : null,
    thumb: String(req.body?.thumb ?? '').slice(0, 500) || null,
  });
  if (!ok) return reply.code(404).send({ error: 'No such playlist.' });
  return { ok: true };
});

app.delete('/api/playlists/:id/tracks/:videoId', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const ok = removePlaylistItem(user.id, Number(req.params.id), req.params.videoId);
  if (!ok) return reply.code(404).send({ error: 'No such playlist.' });
  return { ok: true };
});

app.delete('/api/playlists/:id', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  if (!deletePlaylist(user.id, Number(req.params.id))) {
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
  if (!track) return reply.code(404).send({ error: 'Unknown track.' });
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
  const row = db.prepare('SELECT state, updated_at FROM player_state WHERE user_id = ?').get(user.id);
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
app.put('/api/now', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const b = req.body ?? {};
  const queue = Array.isArray(b.queue) ? b.queue.slice(0, 60) : [];
  const tracks = queue
    .filter((t) => VIDEO_ID.test(String(t?.videoId ?? '')))
    .map((t) => ({
      videoId: t.videoId,
      title: String(t.title ?? '').slice(0, 300),
      channel: String(t.channel ?? '').slice(0, 200),
      thumb: String(t.thumb ?? '').slice(0, 500),
      durationS: Number.isFinite(t.durationS) ? Math.max(0, Math.round(t.durationS)) : null,
    }));
  const index = Number.isInteger(b.index) ? Math.max(0, Math.min(b.index, Math.max(0, tracks.length - 1))) : 0;

  const deviceId = DEVICE_ID.test(String(b.deviceId ?? '')) ? String(b.deviceId) : null;
  const deviceName = String(b.deviceName ?? '').trim().slice(0, 40) || null;
  const takeover = Boolean(b.takeover);

  const row = db.prepare('SELECT state, updated_at FROM player_state WHERE user_id = ?').get(user.id);
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
      state: prev,
      updatedAt: prevUpdatedAt,
    });
  }

  const now = Date.now();
  const state = {
    tracks,
    index,
    positionMs: Number.isFinite(b.positionMs) ? Math.max(0, Math.round(b.positionMs)) : 0,
    source: String(b.source ?? '').slice(0, 40),
    // Whether what was playing was the endless station. Restoring a station as
    // a plain queue would silently freeze it into the handful of songs that
    // happened to be buffered when the phone locked.
    station: Boolean(b.station),
    deviceId: deviceId ?? prevDeviceId ?? null,
    deviceName: deviceName ?? prev?.deviceName ?? null,
    playing: Boolean(b.playing),
    updatedAt: now,
  };
  db.prepare(`
    INSERT INTO player_state (user_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
  `).run(user.id, JSON.stringify(state), new Date(now).toISOString());
  return { ok: true, updatedAt: now, deviceId: state.deviceId, deviceName: state.deviceName };
});

app.post('/api/likes', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const videoId = String(req.body?.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const on = Boolean(req.body?.like);
  rememberFromBody(videoId, req.body ?? {});
  toggleLike(user.id, videoId, on);
  // Likes are a station input, so the built queue is now stale.
  invalidateStation(user.id);
  recordPlay({
    userId: user.id, videoId, kind: on ? 'like' : 'unlike',
    source: String(req.body?.source ?? '') || null,
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
  const on = Boolean(req.body?.dislike);
  rememberFromBody(videoId, req.body ?? {});
  toggleDislike(user.id, videoId, on);
  invalidateStation(user.id);
  recordPlay({
    userId: user.id, videoId, kind: on ? 'dislike' : 'undislike',
    source: String(req.body?.source ?? '') || null,
  });
  return { ok: true, disliked: on };
});

// ── the taste signal ────────────────────────────────────────────────────

app.post('/api/events', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const b = req.body ?? {};
  const videoId = String(b.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const kind = String(b.kind ?? '');
  const allowed = new Set(['start', 'progress', 'complete', 'skip']);
  if (!allowed.has(kind)) return reply.code(400).send({ error: 'Bad kind.' });
  // The station names what it was built from, so a play event from a track the
  // server has never seen must bring its metadata along.
  rememberFromBody(videoId, b);
  recordPlay({
    userId: user.id,
    videoId,
    kind,
    positionMs: Number.isFinite(b.positionMs) ? Math.max(0, Math.round(b.positionMs)) : null,
    durationMs: Number.isFinite(b.durationMs) ? Math.max(0, Math.round(b.durationMs)) : null,
    source: String(b.source ?? '').slice(0, 40) || null,
  });
  // A track played through becomes a station seed; a skip changes its score.
  invalidateStation(user.id);
  return { ok: true };
});

app.get('/api/stats', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const row = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'start')  AS starts,
      COUNT(*) FILTER (WHERE kind = 'complete') AS completes,
      COUNT(*) FILTER (WHERE kind = 'skip')   AS skips
    FROM plays WHERE user_id = ?
  `).get(user.id);
  const likes = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE user_id = ?').get(user.id).n;
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

function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m) return { start: 0, end: Math.min(total - 1, CHUNK_BYTES - 1) };
  const [, rawStart, rawEnd] = m;

  // suffix form: bytes=-N  (last N bytes)
  if (rawStart === '' && rawEnd !== '') {
    const n = Math.min(Number(rawEnd), CHUNK_BYTES);
    return { start: Math.max(0, total - n), end: total - 1 };
  }

  const start = Number(rawStart);
  const wanted = rawEnd === '' ? Infinity : Number(rawEnd);
  if (!Number.isFinite(start) || start < 0) return null;
  if (start >= total) return null; // 416

  const end = Math.min(wanted, start + CHUNK_BYTES - 1, total - 1);
  return { start, end };
}

// ── audio prefetch ──────────────────────────────────────────────────────
// Cold playback costs one full yt-dlp run. The queue always knows the next
// track, so that cost can be paid while the current one is playing instead of
// after the user presses next. Measured 2026-10-20: a cold track took 15 s to
// first byte (and 30 s+ when DNS was slow) versus ~0.17 s from cache — this is
// the difference between "press play, wait" and "press play".
app.post('/api/warm/:videoId', {
  // Prefetching is chatty by nature (one call per track advance); it must not
  // eat into the interactive budget.
  config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
}, async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });

  if (await cachedAudio(videoId)) return { ready: true };

  // Fire and forget: the client never waits on this, and a failure is silent
  // because the real /api/stream request will retry and report it properly.
  // ensureAudio() dedupes against an in-flight download, so a warm that races
  // a real play shares one yt-dlp process.
  ensureAudio(videoId).catch((err) => {
    req.log.debug({ videoId, err: err.message }, 'prefetch failed');
  });
  return reply.code(202).send({ warming: true });
});

app.route({
  method: ['GET', 'HEAD'],
  url: '/api/stream/:videoId',
  // Audio must never be throttled into a 429: the <audio> element treats that
  // as a decode failure. Keep a ceiling, but well above normal playback.
  config: { rateLimit: { max: 6000, timeWindow: '1 minute' } },
  handler: async (req, reply) => {
    const { videoId } = req.params;
    if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
    if (!req.user) {
      // Anonymous listening exists only inside a public room. The guest cookie
      // is room-scoped and the id must be in that room's queue, so this never
      // becomes an open YouTube proxy: it serves exactly what the room is
      // playing (and has queued), nothing else.
      const guest = currentGuest(req);
      if (!guest || !guestStreamAllowed(guest.code, videoId)) {
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
      try {
        // Live broadcasts cannot be fetched to completion; fail fast instead of
        // letting yt-dlp read a never-ending stream until it times out.
        //
        // Only probed when a download is actually needed: the check is a full
        // YouTube round-trip, and a track already on disk is known-good. Paying
        // it unconditionally put ~0.2 s (much more with slow DNS) in front of
        // every cold page load for no benefit.
        if (!(await cachedAudio(videoId)) && (await isLive(videoId))) {
          return reply.code(502).send({ error: 'This is a live stream — not supported yet.' });
        }
        meta = await ensureAudio(videoId);      } catch (err) {
        req.log.warn({ videoId, err: err.message }, 'audio fetch failed');
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
    if (!range) {
      return reply.code(416).header('content-range', `bytes */${meta.size}`).send();
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

    return reply.send(fs.createReadStream(meta.file, { start: range.start, end: range.end }));
  },
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
  // Following an artist and the notification bell. A client that offers either
  // needs the follow routes *and* the sweep that fills the bell; without these
  // flags a stale server would answer 404 to a follow and never notify anyone.
  'follows',
  'notifications',
];

app.get('/api/health', async () => ({
  ok: true,
  ts: new Date().toISOString(),
  features: API_FEATURES,
  // Distinguishes "restarted" from "rebuilt": a stale process keeps its old
  // start time, which is the first thing to check when an endpoint 404s.
  startedAt: startedAt.toISOString(),
  pid: process.pid,
}));

// Playback health, so the UI can explain an external block instead of just
// failing. YouTube periodically gates whole IPs behind "sign in to confirm you
// are not a bot"; when that happens every fetch fails identically.
let botGateAt = null;
app.get('/api/status', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const jar = jarStatus();
  return {
    botGated: Boolean(botGateAt) && Date.now() - botGateAt < 30 * 60_000,
    botGateAt: botGateAt ? new Date(botGateAt).toISOString() : null,
    cookiesConfigured: jar.connected,
    jar,
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
      '-f', '140/bestaudio[ext=m4a]/bestaudio',
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

app.post('/api/youtube/cookies', {
  config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
}, async (req, reply) => {
  // The jar is instance-wide, so replacing it is an admin action. A normal
  // listener can still see the gate status and ask an admin to fix it.
  if (!requireAdmin(req, reply)) return;

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
  await saveJar(cookies, text);
  const verdict = await verifyJar(activeCookiesPath());
  await saveJar(cookies, text, verdict);

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

/** Re-test the stored jar on demand (e.g. after the gate clears). */app.post('/api/youtube/verify', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const path = activeCookiesPath();
  if (!path) return reply.code(400).send({ error: 'No cookies are stored yet.' });
  const verdict = await verifyJar(path);
  const blob = dbGet('youtube_cookies');
  if (blob) {
    const text = decrypt(blob);
    const { cookies } = parseAny(text);
    if (cookies.length) await saveJar(cookies, text, verdict);
  }
  if (verdict.status === 'verified') botGateAt = null;
  resetYT();
  return { verdict, jar: jarStatus() };
});

/**
 * Staged diagnostic. The point is to say *which* layer is failing instead of a
 * single opaque "playback failed": metadata, extraction, or byte delivery.
 */
app.get('/api/youtube/diagnose', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const steps = [];
  const add = (name, ok, detail) => steps.push({ name, ok, detail });

  // 1. PO token provider reachable?
  if (config.potProviderUrl) {
    try {
      const r = await fetch(`${config.potProviderUrl}/ping`, { signal: AbortSignal.timeout(4000) });
      add('PO token provider', r.ok, r.ok ? config.potProviderUrl : `HTTP ${r.status}`);
    } catch {
      add('PO token provider', false, `not reachable at ${config.potProviderUrl} — start the bgutil container`);
    }
  } else {
    add('PO token provider', true, 'disabled');
  }

  // 2. JS runtime present?
  add('JS runtime', Boolean(config.jsRuntime), config.jsRuntime || 'not configured (yt-dlp extraction is weaker without one)');

  // 3. Proxy configured? This is advisory: everything can work without one.
  add('Proxy', config.ytdlpProxy ? true : null,
    config.ytdlpProxy || 'none — the server uses its own IP, which YouTube may gate');

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
    botGated: Boolean(botGateAt),
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
  return { jar: jarStatus(), botGated: Boolean(botGateAt) };
});

app.delete('/api/youtube/cookies', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  await clearJar();
  resetYT();
  botGateAt = null;
  return { ok: true, jar: jarStatus() };
});

// ── admin ───────────────────────────────────────────────────────────────
// Everything here is gated by the `role` column, re-read from the database on
// every request. There is no client-side role claim to trust or forge.
//
// The surface is deliberately split by what an admin actually changes:
// users, library content, local storage, and the instance's YouTube identity.
// Destructive actions are recorded in admin_audit so a mistake is explainable.

const USERNAME = /^[A-Za-z0-9._-]{1,40}$/;
const MIN_PASSWORD = 6;

function audit(actor, action, target = null, detail = null) {
  recordAudit({
    actorId: actor.id, actorName: actor.name, action, target, detail,
  });
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
    botGated: Boolean(botGateAt),
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
  if (passphrase.length < MIN_PASSWORD) {
    return reply.code(400).send({ error: `Passphrase must be at least ${MIN_PASSWORD} characters.` });
  }
  if (findUser(name)) return reply.code(409).send({ error: 'That name is already taken.' });

  const created = createUser(name, passphrase, role);
  audit(admin, 'user.create', name, `role=${role}`);
  return reply.code(201).send({ user: publicUser(getUser(created.id)) });
});

app.patch('/api/admin/users/:id', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Bad user id.' });
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
  const nextDisabled = b.disabled === undefined ? null : Boolean(b.disabled);
  const nextPassword = b.password === undefined ? null : String(b.password);
  if (nextPassword !== null && nextPassword.length < MIN_PASSWORD) {
    return reply.code(400).send({ error: `Passphrase must be at least ${MIN_PASSWORD} characters.` });
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
  if (nextRole !== null && nextRole !== target.role) {
    setUserRole(id, nextRole);
    changed.push(`role=${nextRole}`);
  }
  if (nextDisabled !== null && nextDisabled !== Boolean(target.disabled)) {
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
    // A password reset is a revocation event: every remembered device has to
    // prove itself again with the new passphrase.
    revokeAllRefreshTokens(id);
    deleteAllDevices(id);
    changed.push('password reset');
  }

  if (changed.length) audit(admin, 'user.update', target.name, changed.join(', '));
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
  const id = Number(req.params.id);
  const target = getUser(id);
  if (!target) return reply.code(404).send({ error: 'No such user.' });
  bumpSessionVersion(id);
  revokeAllRefreshTokens(id);
  deleteAllDevices(id);
  audit(admin, 'user.signout', target.name);
  return { ok: true, self: id === admin.id };
});

app.post('/api/admin/users/:id/clear-history', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const id = Number(req.params.id);
  const target = getUser(id);
  if (!target) return reply.code(404).send({ error: 'No such user.' });
  const removed = clearUserHistory(id);
  audit(admin, 'user.clear-history', target.name, `${removed} play events`);
  return { ok: true, removed };
});

app.delete('/api/admin/users/:id', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const id = Number(req.params.id);
  if (id === admin.id) return reply.code(400).send({ error: 'You cannot delete your own account.' });

  const target = getUser(id);
  if (!target) return reply.code(404).send({ error: 'No such user.' });
  if (target.role === 'admin' && !target.disabled && countAdmins() <= 1) {
    return reply.code(400).send({ error: 'At least one active admin is required.' });
  }

  deleteUser(id);
  audit(admin, 'user.delete', target.name, `role=${target.role}`);
  return { ok: true };
});

app.get('/api/admin/tracks', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const q = String(req.query?.q ?? '').trim().slice(0, 200);
  const limit = Number(req.query?.limit ?? 100);
  return { tracks: listTracksForAdmin(q, Number.isFinite(limit) ? limit : 100), q };
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

app.post('/api/admin/db/vacuum', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  db.exec('VACUUM');
  audit(admin, 'db.vacuum');
  return { ok: true, db: dbBytes() };
});

/** A consistent snapshot: VACUUM INTO copies the live database atomically. */
app.get('/api/admin/backup', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-backup-'));
  const target = path.join(dir, 'sonora.db');
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  audit(admin, 'db.backup');

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
  return { entries: listAudit(Number.isFinite(limit) ? limit : 50) };
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
    botGated: Boolean(botGateAt),
  };
});

// ── artwork proxy ───────────────────────────────────────────────────────
// Thumbnails are served same-origin rather than hot-linked to i.ytimg.com:
// it keeps the client's IP and referrer off Google's CDN for every row in
// every list, and it makes the UI independent of third-party image gating.
const IMG_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com', 'lh3.googleusercontent.com', 'yt3.ggpht.com']);
// cacheKey -> { body, type, at } on a hit, or { miss: true, at } after a failure.
const imgCache = new Map();
const IMG_TTL = 6 * 60 * 60_000;
// A thumbnail that failed is usually a deleted upload or a dead CDN host, and
// it will fail again. Remember the miss briefly: every list render asks for the
// same covers, and without this each repaint re-paid a full upstream timeout.
const IMG_MISS_TTL = 2 * 60_000;
// Was 8 s. Nothing legitimate takes that long once DNS answers promptly, and a
// hung upstream must not hold a phone's whole grid hostage.
const IMG_TIMEOUT_MS = 5000;

function sendMiss(reply) {
  return reply.code(404).header('cache-control', 'no-store').send({ error: 'No artwork.' });
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
    imgCache.delete(cacheKey);
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), IMG_TIMEOUT_MS);
  timer.unref?.();
  const miss = () => {
    if (imgCache.size > 3000) imgCache.clear();
    imgCache.set(cacheKey, { miss: true, at: Date.now() });
    return sendMiss(reply);
  };
  try {
    // Try each candidate in order (a high-resolution crop first, the always-
    // present one last) and cache whichever answered.
    let res = null;
    for (const url of [upstream, ...fallbacks]) {
      res = await fetch(url, { signal: abort.signal });
      if (res.ok) break;
    }
    if (!res?.ok) return miss();
    const body = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    if (imgCache.size > 3000) imgCache.clear();
    imgCache.set(cacheKey, { body, type, at: Date.now() });
    return reply.code(200).header('content-type', type)
      .header('cache-control', cacheControl).send(body);
  } catch {
    return miss();
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/img/:videoId', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(400).send({ error: 'Bad video id.' });
  const base = `https://i.ytimg.com/vi/${videoId}`;
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
  if (u.protocol !== 'https:' || !IMG_HOSTS.has(u.hostname)) {
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
const GUEST_COOKIE = 'sonora_guest';
const GUEST_TTL_MS = 6 * 60 * 60_000;

function currentGuest(req) {
  const payload = readGuest(req.cookies?.[GUEST_COOKIE]);
  if (!payload) return null;
  return { id: `g:${payload.g}`, name: 'Guest', guest: true, code: payload.c };
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
  const guest = currentGuest(req);
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
app.get('/api/rooms/:code/state', roomRoute(async (req, reply, user) => viewRoom(req.params.code, user)));

app.post('/api/rooms/:code/join', roomRoute(async (req, reply, user) => {
  const snapshot = joinRoom(req.params.code, user);
  return { ...snapshot, members: memberRoster(req.params.code) };
}));

app.post('/api/rooms/:code/leave', roomRoute(async (req, reply, user) => leaveRoom(req.params.code, user)));
app.delete('/api/rooms/:code', roomRoute(async (req, reply, user) => endRoom(req.params.code, user)));
app.patch('/api/rooms/:code', roomRoute(async (req, reply, user) => updateRoom(req.params.code, user, req.body ?? {})));

app.post('/api/rooms/:code/command', roomRoute(async (req, reply, user) => (
  applyCommand(req.params.code, user, req.body ?? {})
)));

// A clock probe. Three of these per join (and once a minute after) is enough to
// estimate the offset with a round-trip correction; one-way event timestamps
// would bias it forward by the whole transit delay.
app.get('/api/rooms/:code/time', roomRoute(async () => ({ now: Date.now() })));

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
  const token = signGuest({
    c: code,
    g: crypto.randomBytes(9).toString('base64url'),
    exp: Date.now() + GUEST_TTL_MS,
  });
  reply.setCookie(GUEST_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: !config.isDev, path: '/',
    maxAge: Math.floor(GUEST_TTL_MS / 1000),
  });
  return snapshot;
}));

app.get('/api/public/rooms/:code', publicRoute(async (req, reply) => {
  guestFor(req, req.params.code);
  return publicSnapshot(req.params.code);
}));

app.get('/api/public/rooms/:code/state', publicRoute(async (req, reply) => {
  guestFor(req, req.params.code);
  return publicSnapshot(req.params.code);
}));

app.get('/api/public/rooms/:code/time', publicRoute(async (req) => {
  guestFor(req, req.params.code);
  return { now: Date.now() };
}));

app.get('/api/public/rooms/:code/events', publicRoute(async (req, reply) => {
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

function roomLandingHtml({ base, code, preview }) {
  const open = `${base}/#/room/${encodeURIComponent(code)}`;
  const url = `${base}/l/${encodeURIComponent(code)}`;
  const isPrivate = preview ? preview.visibility === 'private' : false;
  // A public room has a listener page that needs no account at all. The app
  // link stays for people who do have one (they can control playback there).
  const liveUrl = preview && !isPrivate ? `${base}/l/${encodeURIComponent(code)}/live` : null;
  const primary = liveUrl ?? open;
  const track = preview?.track ?? null;
  const meta = track ? cardMetadata(track) : null;
  const title = isPrivate ? 'A private listening room' : (meta?.title || 'Listen together on sonora');
  const artist = !isPrivate ? (meta?.artist ?? '') : '';
  const host = preview?.host ? `${preview.host} is listening.` : 'Listen together on sonora.';
  const description = isPrivate
    ? 'Ask the host for an invite.'
    : [artist, host].filter(Boolean).join(' \u00b7 ');
  const art = track ? `${base}/t/${encodeURIComponent(track.videoId)}/art.jpg` : `${base}${SHARE_FALLBACK_ART}`;
  const listeners = preview ? Math.max(1, preview.listeners ?? ((preview.members ?? 0) + (preview.guests ?? 0))) : 0;

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
${isPrivate ? '' : `<p class="listeners"><b>${listeners}</b> listening now</p>`}
<a class="play" href="${htmlEsc(primary)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>${liveUrl ? 'Listen live' : isPrivate ? 'Open sonora' : 'Join the room'}</a>
${liveUrl ? `<p class="alt-link"><a href="${htmlEsc(open)}">Sign in to sonora to control playback</a></p>` : ''}
<p class="note">${isPrivate
    ? 'This is a private room. Sign in, then ask the host to invite you.'
    : 'No account is needed to listen — the link is the invitation. Playback stays in sync with everyone else in the room.'}</p>
</main>
</body>
</html>`;
}

app.get('/l/:code', async (req, reply) => {
  const { code } = req.params;
  const preview = ROOM_CODE.test(code) ? roomPreview(code) : null;
  if (!preview) return reply.code(404).type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(roomLandingHtml({ base: publicBase(req), code, preview: null }));
  return reply.type('text/html; charset=utf-8')
    // Short: a room's listener count and track change while it lives.
    .header('cache-control', 'public, max-age=60')
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
  const host = preview?.host ?? 'Someone';
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
.v-screen-glow{filter:drop-shadow(0 0 18px hsl(var(--hue) 90% 60% / .55))}
/* The projector's caption lives in the SVG, so it scales with the room. */
.v-screen-title{font:750 26px/1 Inter,system-ui,sans-serif;fill:#fff;letter-spacing:-.3px}
.v-screen-sub{font:500 17px/1 Inter,system-ui,sans-serif;fill:rgba(255,255,255,.74)}
.v-screen-elapsed,.v-screen-total{font:600 15px/1 Inter,system-ui,sans-serif;fill:rgba(255,255,255,.66);font-variant-numeric:tabular-nums}
/* The people: illustrated figures drawn inside the scene, so they stand on the
   furniture rather than floating in front of it. Only the idle sway animates. */
.v-people{pointer-events:none}
.v-figure .v-pose{transform-box:fill-box;transform-origin:50% 100%;animation:v-sway 7s ease-in-out infinite;animation-delay:var(--d)}
.v-figure[data-pose="dance"] .v-pose{animation:v-dance 2.6s ease-in-out infinite;animation-delay:var(--d)}
.v-figure[data-pose="sit"] .v-pose{animation:none}
@keyframes v-sway{0%,100%{transform:rotate(var(--lean))}50%{transform:rotate(calc(var(--lean) * -1)) translateY(-1.5px)}}
@keyframes v-dance{0%,100%{transform:rotate(var(--lean))}25%{transform:rotate(calc(var(--lean) + 3deg)) translateY(-3px)}75%{transform:rotate(calc(var(--lean) - 3deg)) translateY(-1px)}}
.v-tag{font:750 15px/1 Inter,system-ui,sans-serif;fill:#fff;paint-order:stroke;stroke:rgba(8,9,12,.85);stroke-width:4px;stroke-linejoin:round}
.v-more text{font:700 15px/1 Inter,system-ui,sans-serif;fill:#d7d5da}
.v-bubble{overflow:visible;animation:v-pop .4s var(--ease-out) both}
.v-bubble>div{display:inline-block;padding:7px 12px;border-radius:13px 13px 13px 4px;background:rgba(250,247,242,.97);color:#191a1f;font:600 15px/1.3 Inter,system-ui,sans-serif;white-space:nowrap;box-shadow:0 10px 26px rgba(0,0,0,.5)}
.v-figure.is-host .v-bubble>div{border-radius:13px 13px 4px 13px;background:hsl(var(--hue) 60% 88%)}
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
  body[data-view="venue"] .shell{height:auto;min-height:calc(100dvh - 32px)}
  body[data-view="venue"] .venue-host{flex:none}
  .venue{display:flex;flex-direction:column;flex:none;border-radius:16px}
  .v-scene{position:relative;flex:none;aspect-ratio:16/10;inset:auto}
  .v-now,.v-tools,.v-deck{position:static;max-width:none;width:auto;left:auto;right:auto;top:auto;bottom:auto}
  .v-now{margin:10px 10px 0;padding:9px 11px;border-radius:14px;order:1}
  .v-now-eyebrow{display:block}
  .v-now-title{font-size:13px}
  .v-now-sub{font-size:10.5px}
  .v-now-meta{margin-top:6px;font-size:9.5px}
  /* The title and artist are already in this card, so the listener count does
     not need to appear twice in it. */
  .v-now-meta .v-now-people{display:none}
  .v-tools{order:2;margin:8px 10px 0;justify-content:flex-start;flex-wrap:wrap;gap:6px;overflow:visible}
  .v-themes,.v-light,.v-exit{flex:none}
  .v-light{padding:0 2px 0 7px}
  .v-hue{width:56px}
  .v-deck{order:4;margin:8px 10px 10px;align-items:stretch}
  .v-deck-btn{align-self:flex-start}
  .v-deck-queue{max-height:min(34vh,240px)}
  .v-transport{width:100%}
  .v-bubble>div{font-size:11px;padding:5px 9px}
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
  /* The switch has to survive a 390px header: icons only, labels read by the
     accessible name (aria-label is added by the page). */
  .view-btn{padding:0 9px}
  .view-btn span{display:none}
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
<audio id="listen-audio" preload="none"></audio>
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

app.get('/l/:code/live', async (req, reply) => {
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
  reply.setCookie(GUEST_COOKIE, signGuest({
    c: code,
    g: crypto.randomBytes(9).toString('base64url'),
    exp: Date.now() + GUEST_TTL_MS,
  }), {
    httpOnly: true, sameSite: 'lax', secure: !config.isDev, path: '/',
    maxAge: Math.floor(GUEST_TTL_MS / 1000),
  });
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
  const host = String(req.headers.host ?? '');
  if (/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) return `${req.protocol}://${host}`;
  return `http://127.0.0.1:${config.port}`;
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
app.get('/t/:videoId', async (req, reply) => {
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
app.get('/t/:videoId/art.jpg', async (req, reply) => {
  const { videoId } = req.params;
  if (!VIDEO_ID.test(videoId)) return reply.code(404).send({ error: 'Bad video id.' });
  const base = `https://i.ytimg.com/vi/${videoId}`;
  return proxyImage(`v:${videoId}:hi`, `${base}/maxresdefault.jpg`, reply,
    [`${base}/hq720.jpg`, `${base}/mqdefault.jpg`, `${base}/hqdefault.jpg`],
    'public, max-age=86400');
});

/**
 * oEmbed discovery. Discord ignores it; Slack, Notion and most unfurl tools do
 * not, and it costs one route.
 */
app.get('/oembed.json', async (req, reply) => {
  const match = /\/t\/([A-Za-z0-9_-]{11})\/?$/.exec(String(req.query?.url ?? ''));
  const videoId = match?.[1] ?? null;
  const track = videoId ? getTrack(videoId) : null;
  const meta = track ? cardMetadata(track) : null;
  const base = publicBase(req);
  return reply
    // oEmbed is read by the consumer's own page, so it has to be CORS-open.
    .header('access-control-allow-origin', '*')
    .header('cache-control', 'public, max-age=300')
    .send({
      version: '1.0',
      type: 'rich',
      provider_name: 'sonora',
      provider_url: base,
      title: meta ? [meta.title, meta.artist].filter(Boolean).join(' \u2014 ') : 'sonora',
      ...(meta?.artist ? { author_name: meta.artist } : {}),
      ...(videoId ? {
        thumbnail_url: `${base}/t/${videoId}/art.jpg`,
        thumbnail_width: 1280,
        thumbnail_height: 720,
      } : {}),
    });
});

// ── error handling ──────────────────────────────────────────────────────

app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  reply.code(code).send({ error: code === 500 ? 'Internal error.' : err.message });
});

const close = async () => {
  await app.close();
  try { db.close(); } catch {}
  process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, close);

await app.listen({ port: config.port, host: config.host });
console.log(`[sonora] http://${config.host}:${config.port} (pid ${process.pid}, ${API_FEATURES.length} api features)`);
await pruneCache();
// Session housekeeping: expired refresh tokens and stale WebAuthn ceremonies are
// dead weight, and a device unseen for two months is a device the user has long
// since replaced. Cheap to run once at boot; nothing here is on a hot path.
try {
  const tokens = deleteExpiredRefreshTokens();
  const ceremonies = deleteExpiredChallenges();
  const devices = pruneStaleDevices(60);
  const roomsGone = expireRooms();
  if (tokens || ceremonies || devices || roomsGone) {
    console.log(`[sonora] pruned ${tokens} refresh token(s), ${ceremonies} ceremony(s), ${devices} stale device(s), ${roomsGone} room(s)`);
  }
} catch (err) {
  console.warn('[sonora] session housekeeping failed:', err.message);
}
// Rooms have their own clock: a room is idle for hours, not minutes. The timer
// skips rooms with a live stream, so this cannot end a group mid-song.
setInterval(() => {
  try { expireRooms(); } catch (err) { console.warn('[sonora] room housekeeping failed:', err.message); }
}, 60 * 60_000).unref?.();
// Release checks have their own, much slower clock. A new album is not urgent,
// and every followed artist costs one catalogue page fetch, so twenty minutes is
// often enough to feel current and rare enough that a dozen follows are a
// handful of requests an hour. Only artists somebody actually follows are ever
// touched: the sweep reads the follow table, it never walks the catalogue.
setInterval(() => {
  pollFollows().catch((err) => console.warn('[sonora] follow sweep failed:', err.message));
}, 20 * 60_000).unref?.();
// The bell is a recent-events feed, so old rows are dropped at boot (see
// pruneNotifications): cheap, and it keeps the table from growing with every
// release of every artist anyone ever followed.
try { pruneNotifications(60); } catch (err) {
  console.warn('[sonora] notification housekeeping failed:', err.message);
}
// Build the shared Innertube session now rather than inside the first search.
// Measured 2026-10-20: session creation costs ~5 s (it fetches the player and
// config), and paying that on the first user search reads as "search is slow".
// Failure is harmless: getYT() clears its cache and the next call retries.
getYT().catch((err) => console.warn('[sonora] youtube session warm-up failed:', err.message));
// The station's genre lane votes with YouTube's genre pages (~14 shelves). It
// is warmed here rather than at boot *before* the session exists, because 14
// parallel page fetches on a cold client made the first station request slower
// (11 s) than paying for them lazily (2.6 s). Failures are harmless: the vote
// falls back to the other lanes.
getYT()
  .then(() => new Promise((resolve) => setImmediate(resolve)))
  .then(() => genreShelves())
  .catch((err) => console.warn('[sonora] genre shelf warm-up failed:', err.message));
if (config.isDev) console.warn('[sonora] SONORA_SECRET unset — sessions reset on restart');
