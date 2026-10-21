import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- role is assigned in the database: UPDATE users SET role = 'admin' WHERE name = '...'.
  -- The bootstrap user is created as an admin, so a fresh instance always has one.
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    pass_hash       TEXT NOT NULL,
    salt            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user',
    disabled        INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1,
    last_login_at   TEXT,
    last_seen_at    TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracks (
    video_id   TEXT PRIMARY KEY,
    title      TEXT,
    channel    TEXT,
    channel_id TEXT,
    duration_s INTEGER,
    thumb      TEXT,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );

  -- The taste signal. Written from day one; the model can wait.
  CREATE TABLE IF NOT EXISTS plays (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    video_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,            -- start | progress | complete | skip | like | unlike
    position_ms INTEGER,
    duration_ms INTEGER,
    source      TEXT,                     -- radio | search | playlist | artist
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plays_user_time ON plays(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS plays_video ON plays(video_id);

  CREATE TABLE IF NOT EXISTS likes (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    video_id   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, video_id)
  );

  -- Explicit "less of this". Deliberately a separate table from likes rather
  -- than a boolean on it: a dislike is a standing instruction (never put this in
  -- a generated queue again), while a like is a collection the user browses.
  CREATE TABLE IF NOT EXISTS dislikes (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    video_id   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, video_id)
  );

  -- Last playback session, so reopening the PWA resumes instead of blanking.
  CREATE TABLE IF NOT EXISTS player_state (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    state      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    title       TEXT NOT NULL,
    description TEXT,
    art_video   TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    video_id    TEXT NOT NULL,
    position    INTEGER NOT NULL,
    added_at    TEXT NOT NULL,
    PRIMARY KEY (playlist_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS playlist_items_order ON playlist_items(playlist_id, position);

  -- Cached upstream lookups (lyrics, related) so we do not re-hit YouTube.
  CREATE TABLE IF NOT EXISTS upstream_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- Encrypted secrets (currently the imported YouTube cookie jar).
  CREATE TABLE IF NOT EXISTS secrets (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Who changed what in the admin surface. Admin actions are consequential
  -- (delete a user, wipe the cache), so they are recorded rather than guessed.
  CREATE TABLE IF NOT EXISTS admin_audit (
    id         INTEGER PRIMARY KEY,
    actor_id   INTEGER,
    actor_name TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(created_at DESC);

  -- A signed-in browser/device. Sessions are stateless, but the device row is
  -- what makes "saved devices" and per-device revocation real: a session token
  -- carries the device id and stops working the moment the row is deleted.
  CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT,
    platform        TEXT,
    user_agent      TEXT,
    client_device_id TEXT,
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    last_login_at   TEXT,
    last_ip         TEXT,
    remembered      INTEGER NOT NULL DEFAULT 0,
    revoked_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id, last_seen_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS devices_client
    ON devices(user_id, client_device_id) WHERE client_device_id IS NOT NULL;

  -- Opaque, rotating refresh tokens. Only a SHA-256 hash is stored, so a
  -- database leak cannot be replayed against the instance. Rotation makes
  -- theft detectable: presenting a used token revokes the whole device.
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          INTEGER PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at  TEXT,
    replaced_by TEXT
  );
  CREATE INDEX IF NOT EXISTS refresh_device ON refresh_tokens(device_id, revoked_at);
  CREATE INDEX IF NOT EXISTS refresh_user ON refresh_tokens(user_id, revoked_at);

  -- WebAuthn credentials (passkeys). public_key is base64url-encoded COSE;
  -- counter is persisted so a cloned authenticator can be detected.
  CREATE TABLE IF NOT EXISTS passkeys (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key    TEXT NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT,
    device_type   TEXT,
    backed_up     INTEGER NOT NULL DEFAULT 0,
    aaguid        TEXT,
    name          TEXT,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id, created_at DESC);

  -- Short-lived WebAuthn ceremonies. Stored server-side so a challenge cannot
  -- be replayed, and consumed atomically on verification.
  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    challenge  TEXT NOT NULL,
    rp_id      TEXT NOT NULL,
    origin     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS webauthn_expiry ON webauthn_challenges(expires_at);

  -- A "Listen Together" room: one authoritative playhead several people follow.
  -- The playhead is stored as JSON in the state column (queue, index, positionMs,
  -- anchorAt, playing) and rev is bumped on every accepted command, which is
  -- what lets a client detect that it is acting on a stale view (two people
  -- pressing next at once must advance once, not twice).
  CREATE TABLE IF NOT EXISTS rooms (
    code       TEXT PRIMARY KEY,
    host_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'public',   -- public | private
    control    TEXT NOT NULL DEFAULT 'everyone', -- everyone | host
    state      TEXT NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS rooms_host ON rooms(host_id, updated_at DESC);

  -- Durable membership: the authorization record, not a presence table.
  -- Presence is the open SSE connection (see src/rooms.js), so a member who
  -- closes the tab stays a member and can rejoin without another invite.
  CREATE TABLE IF NOT EXISTS room_members (
    room_code    TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member',  -- host | member
    joined_at    TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (room_code, user_id)
  );
  CREATE INDEX IF NOT EXISTS room_members_user ON room_members(user_id, last_seen_at DESC);

  -- Who a private room has let in. Kept after a join so leaving and rejoining
  -- does not need the host again.
  CREATE TABLE IF NOT EXISTS room_invites (
    room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_code, user_id)
  );
  CREATE INDEX IF NOT EXISTS room_invites_user ON room_invites(user_id);

  -- Following an artist is a standing request, not a bookmark: it is what turns
  -- "I like this band" into "tell me when they release something". artist_id is
  -- a channel id (UC…), and name/thumb are stored here so the follows list can
  -- render without re-fetching an artist page per row.
  CREATE TABLE IF NOT EXISTS artist_follows (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_id       TEXT NOT NULL,
    name            TEXT,
    thumb           TEXT,
    created_at      TEXT NOT NULL,
    last_checked_at TEXT,
    PRIMARY KEY (user_id, artist_id)
  );
  CREATE INDEX IF NOT EXISTS artist_follows_user ON artist_follows(user_id, created_at DESC);

  -- The baseline: every release we have already seen for an artist. The first
  -- check of an artist records its back catalogue here and notifies nothing, so
  -- following a band with twelve albums does not fire twelve notifications.
  -- Deliberately shared between users: a release is a fact about the artist, not
  -- about a follower, so the first follower pays for the fetch and the rest
  -- reuse what it learned.
  CREATE TABLE IF NOT EXISTS artist_releases (
    artist_id  TEXT NOT NULL,
    release_id TEXT NOT NULL,
    title      TEXT,
    kind       TEXT,                     -- album | single
    year       TEXT,
    thumb      TEXT,
    first_seen TEXT NOT NULL,
    PRIMARY KEY (artist_id, release_id)
  );

  -- The bell panel. One row per thing worth telling one user about. The dedupe
  -- key plus the unique index is what makes a poll idempotent: however often the
  -- sweep runs, or however many devices ask it to check, the same release can
  -- only produce one notification per user.
  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,           -- release | track
    title       TEXT,
    body        TEXT,
    thumb       TEXT,
    url         TEXT,                    -- in-app route: #/c/aMPR… or #/t/<videoId>
    artist_id   TEXT,
    artist_name TEXT,
    video_id    TEXT,
    dedupe      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    read_at     TEXT,
    UNIQUE (user_id, dedupe)
  );
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at DESC);
`);

// CREATE TABLE IF NOT EXISTS never adds columns to an existing database, so the
// role/session columns are migrated explicitly. This is what makes an instance
// created before the admin role existed upgrade in place.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

const roleColumnAdded = ensureColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'user'");
ensureColumn('users', 'disabled', 'disabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'session_version', 'session_version INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'last_login_at', 'last_login_at TEXT');
ensureColumn('users', 'last_seen_at', 'last_seen_at TEXT');
// Created after the migration: an index over a column that only exists in the
// new schema would fail the whole batch on an old database.
db.exec('CREATE INDEX IF NOT EXISTS users_role ON users(role)');

// Upgrading an instance that predates the admin role must not lock its owner
// out: the oldest account becomes the admin, which is the account that ran the
// bootstrap. Fresh databases get their admin from bootstrapUser() instead.
if (roleColumnAdded) {
  const promoted = db.prepare(`
    UPDATE users SET role = 'admin'
    WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (
      SELECT 1 FROM users WHERE role = 'admin'
    )
  `).run().changes;
  if (promoted) console.log('[sonora] migrated users.role: the first account is now an admin');
}

const SHA = (buf) => crypto.createHash('sha256').update(buf).digest();

function hashPassword(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}

export const ROLES = ['user', 'admin'];

export function findUser(name) {
  return db.prepare('SELECT * FROM users WHERE name = ?').get(name) ?? null;
}

export function getUser(id) {
  return db.prepare(`
    SELECT id, name, role, disabled, session_version, created_at, last_login_at, last_seen_at
    FROM users WHERE id = ?
  `).get(id) ?? null;
}

export function createUser(name, pass, role = 'user') {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO users (name, pass_hash, salt, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, hashPassword(pass, salt), salt, role, new Date().toISOString());
  return findUser(name);
}

export function setUserRole(id, role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id).changes > 0;
}

export function setUserDisabled(id, disabled) {
  return db.prepare('UPDATE users SET disabled = ? WHERE id = ?')
    .run(disabled ? 1 : 0, id).changes > 0;
}

export function setUserPassword(id, pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?')
    .run(hashPassword(pass, salt), salt, id).changes > 0;
}

/** Sessions are stateless, so revoking one means invalidating its version. */
export function bumpSessionVersion(id) {
  return db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?')
    .run(id).changes > 0;
}

export function touchLogin(id) {
  db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), new Date().toISOString(), id);
}

// ── devices & refresh tokens ────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const newId = (prefix = '') => `${prefix}${crypto.randomBytes(18).toString('base64url')}`;

/** Refresh tokens are stored only as a digest, like a password. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createDevice({
  userId, name = null, platform = null, userAgent = null,
  clientDeviceId = null, ip = null, remembered = false,
}) {
  const id = newId('dev_');
  const now = nowIso();
  db.prepare(`
    INSERT INTO devices
      (id, user_id, name, platform, user_agent, client_device_id,
       created_at, last_seen_at, last_login_at, last_ip, remembered)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, name, platform, userAgent, clientDeviceId, now, now, now, ip, remembered ? 1 : 0);
  return getDevice(id);
}

export function getDevice(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) ?? null;
}

export function findDeviceByClient(userId, clientDeviceId) {
  if (!clientDeviceId) return null;
  return db.prepare(`
    SELECT * FROM devices
    WHERE user_id = ? AND client_device_id = ? AND revoked_at IS NULL
  `).get(userId, clientDeviceId) ?? null;
}

export function listDevices(userId) {
  return db.prepare(`
    SELECT id, name, platform, user_agent AS userAgent, client_device_id AS clientDeviceId,
           created_at AS createdAt, last_seen_at AS lastSeenAt, last_login_at AS lastLoginAt,
           last_ip AS lastIp, remembered, revoked_at AS revokedAt,
           (SELECT COUNT(*) FROM refresh_tokens r
             WHERE r.device_id = devices.id AND r.revoked_at IS NULL
               AND r.expires_at > ?) AS activeRefreshTokens
    FROM devices WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY last_seen_at DESC
  `).all(nowIso(), userId).map((d) => ({ ...d, remembered: Boolean(d.remembered) }));
}

export function touchDevice(id, { ip = null, login = false } = {}) {
  if (login) {
    db.prepare('UPDATE devices SET last_seen_at = ?, last_login_at = ?, last_ip = ? WHERE id = ?')
      .run(nowIso(), nowIso(), ip, id);
  } else {
    db.prepare('UPDATE devices SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?')
      .run(nowIso(), ip, id);
  }
}

export function setDeviceRemembered(id, remembered) {
  return db.prepare('UPDATE devices SET remembered = ? WHERE id = ?')
    .run(remembered ? 1 : 0, id).changes > 0;
}

export function renameDevice(userId, id, name) {
  return db.prepare('UPDATE devices SET name = ? WHERE id = ? AND user_id = ?')
    .run(name, id, userId).changes > 0;
}

export function deleteDevice(id) {
  // refresh_tokens and any passkey-bound ceremony rows cascade from here.
  return db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
}

export function deleteDeviceForUser(userId, id) {
  return db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?')
    .run(id, userId).changes > 0;
}

/** Remove every device except the one making the request. */
export function deleteOtherDevices(userId, keepId) {
  if (keepId) {
    return db.prepare('DELETE FROM devices WHERE user_id = ? AND id != ?')
      .run(userId, keepId).changes;
  }
  return db.prepare('DELETE FROM devices WHERE user_id = ?').run(userId).changes;
}

export function deleteAllDevices(userId) {
  return db.prepare('DELETE FROM devices WHERE user_id = ?').run(userId).changes;
}

/** Housekeeping: a device that has not been seen for months is noise — but only
 *  if it has nothing left to redeem. A device holding an unexpired refresh token
 *  is still legitimately signed in (SONORA_REFRESH_DAYS can exceed 60), so it stays. */
export function pruneStaleDevices(days = 60) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db.prepare(`
    DELETE FROM devices
    WHERE last_seen_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM refresh_tokens r
        WHERE r.device_id = devices.id AND r.revoked_at IS NULL AND r.expires_at > ?
      )
  `).run(cutoff, nowIso()).changes;
}

export function issueRefreshToken({ deviceId, userId, ttlMs }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(`
    INSERT INTO refresh_tokens (device_id, user_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(deviceId, userId, tokenHash, nowIso(), expiresAt);
  const id = Number(db.prepare('SELECT id FROM refresh_tokens WHERE token_hash = ?').get(tokenHash).id);
  return { id, token, tokenHash, expiresAt };
}

export function getRefreshToken(tokenHash) {
  return db.prepare(`
    SELECT r.*, d.user_id AS device_user_id, d.revoked_at AS device_revoked_at
    FROM refresh_tokens r JOIN devices d ON d.id = r.device_id
    WHERE r.token_hash = ?
  `).get(tokenHash) ?? null;
}

/** Mark a token used and link it to its replacement (rotation audit trail). */
export function consumeRefreshToken(id, replacedBy = null) {
  return db.prepare(`
    UPDATE refresh_tokens SET revoked_at = ?, last_used_at = ?, replaced_by = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(nowIso(), nowIso(), replacedBy, id).changes > 0;
}

export function revokeRefreshToken(id) {
  return db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(nowIso(), id).changes > 0;
}

export function revokeDeviceTokens(deviceId) {
  return db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
    .run(nowIso(), deviceId).changes;
}

export function revokeAllRefreshTokens(userId) {
  return db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowIso(), userId).changes;
}

export function deleteExpiredRefreshTokens() {
  return db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(nowIso()).changes;
}

// ── passkeys (WebAuthn) ─────────────────────────────────────────────────

export function listPasskeys(userId) {
  return db.prepare(`
    SELECT id, credential_id AS credentialId, name, transports,
           device_type AS deviceType, backed_up AS backedUp, aaguid,
           created_at AS createdAt, last_used_at AS lastUsedAt
    FROM passkeys WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId).map((p) => ({
    ...p,
    transports: p.transports ? p.transports.split(',').filter(Boolean) : [],
    backedUp: Boolean(p.backedUp),
  }));
}

export function listPasskeyCredentials(userId) {
  return db.prepare('SELECT credential_id AS credentialId, transports FROM passkeys WHERE user_id = ?')
    .all(userId).map((p) => ({
      id: p.credentialId,
      transports: p.transports ? p.transports.split(',').filter(Boolean) : undefined,
    }));
}

export function getPasskeyByCredentialId(credentialId) {
  return db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId) ?? null;
}

export function createPasskey({
  userId, credentialId, publicKey, counter = 0, transports = [],
  deviceType = null, backedUp = false, aaguid = null, name = null,
}) {
  const info = db.prepare(`
    INSERT INTO passkeys
      (user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, credentialId, publicKey, counter, transports.join(','), deviceType,
    backedUp ? 1 : 0, aaguid, name, nowIso());
  return Number(info.lastInsertRowid);
}

export function updatePasskeyUse(id, counter, { deviceType = null, backedUp = false } = {}) {
  return db.prepare(`
    UPDATE passkeys SET counter = MAX(counter, ?), device_type = COALESCE(?, device_type),
      backed_up = ?, last_used_at = ? WHERE id = ?
  `).run(counter, deviceType, backedUp ? 1 : 0, nowIso(), id).changes > 0;
}

export function renamePasskey(userId, id, name) {
  return db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?')
    .run(name, id, userId).changes > 0;
}

export function deletePasskey(userId, id) {
  return db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?')
    .run(id, userId).changes > 0;
}

export function countPasskeys(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
}

// ── listening rooms (see docs/rooms.md) ─────────────────────────────────
// The playhead logic lives in src/rooms.js; this module owns the SQL. A room's
// `state` is JSON because it changes as one unit on every command, and nothing
// queries inside it.

const ROOM_COLUMNS = `code, host_id AS hostId, visibility, control, state, rev,
  created_at AS createdAt, updated_at AS updatedAt, ended_at AS endedAt`;

/** The stored JSON, or null. A corrupt row is treated as an empty room. */
export function parseRoomState(row) {
  if (!row) return null;
  try {
    const state = JSON.parse(row.state);
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

export function createRoomRow({ code, hostId, visibility = 'public', control = 'everyone', state }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO rooms (code, host_id, visibility, control, state, rev, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(code, hostId, visibility, control, JSON.stringify(state), now, now);
  return getRoomRow(code);
}

export function getRoomRow(code) {
  return db.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE code = ?`).get(code) ?? null;
}

/** Rooms this user hosts, has joined, or has been invited to. */
export function listRoomsForUser(userId, limit = 20) {
  return db.prepare(`
    SELECT r.code, r.host_id AS hostId, u.name AS hostName, r.visibility, r.control,
           r.rev, r.created_at AS createdAt, r.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM room_members m WHERE m.room_code = r.code) AS members,
           EXISTS(SELECT 1 FROM room_members m2
                   WHERE m2.room_code = r.code AND m2.user_id = ?) AS joined,
           EXISTS(SELECT 1 FROM room_invites i
                   WHERE i.room_code = r.code AND i.user_id = ?) AS invited
    FROM rooms r JOIN users u ON u.id = r.host_id
    WHERE r.ended_at IS NULL
      AND (
        r.host_id = ?
        OR EXISTS(SELECT 1 FROM room_members m3 WHERE m3.room_code = r.code AND m3.user_id = ?)
        OR EXISTS(SELECT 1 FROM room_invites i2 WHERE i2.room_code = r.code AND i2.user_id = ?)
      )
    ORDER BY r.updated_at DESC LIMIT ?
  `).all(userId, userId, userId, userId, userId, Math.max(1, Math.min(100, limit)))
    .map((r) => ({ ...r, joined: Boolean(r.joined), invited: Boolean(r.invited) }));
}

/**
 * Rooms old enough to collect. The caller must still skip any that has a live
 * SSE subscriber (src/rooms.js) — a room paused overnight with a tab open is
 * not idle, and `updated_at` cannot see an open connection.
 */
export function listRoomsToPrune(idleCutoffIso, endedCutoffIso) {
  return db.prepare(`
    SELECT code FROM rooms
    WHERE updated_at < ? OR (ended_at IS NOT NULL AND ended_at < ?)
  `).all(idleCutoffIso, endedCutoffIso).map((r) => r.code);
}

/** Commit an accepted command: new state and revision, in one write. */
export function updateRoomState(code, { state, rev, updatedAt = new Date().toISOString() }) {
  db.prepare('UPDATE rooms SET state = ?, rev = ?, updated_at = ? WHERE code = ?')
    .run(JSON.stringify(state), rev, updatedAt, code);
}

export function touchRoomRow(code) {
  return db.prepare('UPDATE rooms SET updated_at = ? WHERE code = ?')
    .run(new Date().toISOString(), code).changes > 0;
}

export function updateRoomMeta(code, { visibility, control }) {
  const sets = [];
  const values = [];
  if (visibility) { sets.push('visibility = ?'); values.push(visibility); }
  if (control) { sets.push('control = ?'); values.push(control); }
  if (!sets.length) return false;
  values.push(new Date().toISOString(), code);
  return db.prepare(`UPDATE rooms SET ${sets.join(', ')}, updated_at = ? WHERE code = ?`)
    .run(...values).changes > 0;
}

export function endRoomRow(code) {
  return db.prepare('UPDATE rooms SET ended_at = ?, updated_at = ? WHERE code = ? AND ended_at IS NULL')
    .run(new Date().toISOString(), new Date().toISOString(), code).changes > 0;
}

export function deleteRoomRow(code) {
  return db.prepare('DELETE FROM rooms WHERE code = ?').run(code).changes > 0;
}

// ── membership ──────────────────────────────────────────────────────────

export function addRoomMember(code, userId, role = 'member') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO room_members (room_code, user_id, role, joined_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(room_code, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(code, userId, role, now, now);
  return getRoomMember(code, userId);
}

export function getRoomMember(code, userId) {
  return db.prepare(`
    SELECT m.room_code AS roomCode, m.user_id AS userId, m.role,
           m.joined_at AS joinedAt, m.last_seen_at AS lastSeenAt, u.name
    FROM room_members m JOIN users u ON u.id = m.user_id
    WHERE m.room_code = ? AND m.user_id = ?
  `).get(code, userId) ?? null;
}

/** The roster, oldest demo first with the host pinned to the top. */
export function listRoomMembers(code) {
  return db.prepare(`
    SELECT m.user_id AS id, u.name, m.role, m.joined_at AS joinedAt, m.last_seen_at AS lastSeenAt
    FROM room_members m JOIN users u ON u.id = m.user_id
    WHERE m.room_code = ?
    ORDER BY (m.role = 'host') DESC, m.joined_at ASC
  `).all(code);
}

export function countRoomMembers(code) {
  return db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_code = ?').get(code).n;
}

export function removeRoomMember(code, userId) {
  return db.prepare('DELETE FROM room_members WHERE room_code = ? AND user_id = ?')
    .run(code, userId).changes > 0;
}

export function touchRoomMember(code, userId) {
  return db.prepare('UPDATE room_members SET last_seen_at = ? WHERE room_code = ? AND user_id = ?')
    .run(new Date().toISOString(), code, userId).changes > 0;
}

// ── invites ─────────────────────────────────────────────────────────────

export function addRoomInvite(code, userId, invitedBy = null) {
  db.prepare(`
    INSERT INTO room_invites (room_code, user_id, invited_by, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_code, user_id) DO NOTHING
  `).run(code, userId, invitedBy, new Date().toISOString());
  return true;
}

export function removeRoomInvite(code, userId) {
  return db.prepare('DELETE FROM room_invites WHERE room_code = ? AND user_id = ?')
    .run(code, userId).changes > 0;
}

export function getRoomInvite(code, userId) {
  return db.prepare('SELECT * FROM room_invites WHERE room_code = ? AND user_id = ?')
    .get(code, userId) ?? null;
}

export function listRoomInvites(code) {
  return db.prepare(`
    SELECT i.user_id AS id, u.name, i.created_at AS invitedAt
    FROM room_invites i JOIN users u ON u.id = i.user_id
    WHERE i.room_code = ? ORDER BY i.created_at ASC
  `).all(code);
}

/**
 * Who the host can invite. Deliberately a name search over active accounts
 * only — never a directory of everyone's stats, and never a disabled account.
 */
export function searchUsers(q, excludeId = null, limit = 8) {
  const term = `%${String(q ?? '').trim()}%`;
  return db.prepare(`
    SELECT id, name FROM users
    WHERE disabled = 0 AND (? = '' OR name LIKE ?) AND id != COALESCE(?, -1)
    ORDER BY name COLLATE NOCASE LIMIT ?
  `).all(String(q ?? '').trim(), term, excludeId, Math.max(1, Math.min(50, limit)));
}

// ── WebAuthn challenges ─────────────────────────────────────────────────

export function createChallenge({ userId = null, kind, challenge, rpId, origin, ttlMs = 5 * 60_000 }) {
  const id = crypto.randomBytes(24).toString('base64url');
  db.prepare(`
    INSERT INTO webauthn_challenges
      (id, user_id, kind, challenge, rp_id, origin, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, kind, challenge, rpId, origin, nowIso(), Date.now() + ttlMs);
  return id;
}

/** Consume a challenge exactly once; expiry and kind are checked here. */
export function takeChallenge(id, kind) {
  if (!id || typeof id !== 'string') return null;
  const row = db.prepare('SELECT * FROM webauthn_challenges WHERE id = ? AND kind = ?')
    .get(id, kind);
  if (!row) return null;
  db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
  if (row.expires_at < Date.now()) return null;
  return row;
}

export function deleteExpiredChallenges() {
  return db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(Date.now()).changes;
}

export function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
}

/** Everything a user owns, removed in one transaction so no orphan rows remain. */
export function deleteUser(id) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)').run(id);
    db.prepare('DELETE FROM playlists WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM likes WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM dislikes WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM plays WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM player_state WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM devices WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?').run(id);
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.exec('COMMIT');
    return info.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Users plus the counts an admin actually needs to make a decision. */
export function listUsersWithStats() {
  return db.prepare(`
    SELECT u.id, u.name, u.role, u.disabled, u.created_at AS createdAt,
           u.last_login_at AS lastLoginAt, u.last_seen_at AS lastSeenAt,
           (SELECT COUNT(*) FROM plays p WHERE p.user_id = u.id) AS plays,
           (SELECT COUNT(*) FROM likes l WHERE l.user_id = u.id) AS likes,
           (SELECT COUNT(*) FROM playlists pl WHERE pl.user_id = u.id) AS playlists,
           (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices,
           (SELECT COUNT(*) FROM passkeys pk WHERE pk.user_id = u.id) AS passkeys,
           (SELECT MAX(p.created_at) FROM plays p WHERE p.user_id = u.id) AS lastPlayedAt
    FROM users u ORDER BY u.id
  `).all().map((u) => ({ ...u, disabled: Boolean(u.disabled) }));
}

export function adminCounts() {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    users: one('SELECT COUNT(*) AS n FROM users'),
    admins: one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0"),
    disabled: one('SELECT COUNT(*) AS n FROM users WHERE disabled = 1'),
    plays: one('SELECT COUNT(*) AS n FROM plays'),
    likes: one('SELECT COUNT(*) AS n FROM likes'),
    dislikes: one('SELECT COUNT(*) AS n FROM dislikes'),
    tracks: one('SELECT COUNT(*) AS n FROM tracks'),
    playlists: one('SELECT COUNT(*) AS n FROM playlists'),
    secrets: one('SELECT COUNT(*) AS n FROM secrets'),
  };
}

export function listTracksForAdmin(q = '', limit = 100) {
  const like = `%${q}%`;
  return db.prepare(`
    SELECT t.video_id AS videoId, t.title, t.channel, t.duration_s AS durationS, t.thumb,
           t.first_seen AS firstSeen, t.last_seen AS lastSeen,
           (SELECT COUNT(*) FROM plays p WHERE p.video_id = t.video_id AND p.kind = 'start') AS plays,
           (SELECT COUNT(*) FROM plays p WHERE p.video_id = t.video_id AND p.kind = 'skip') AS skips,
           (SELECT COUNT(*) FROM likes l WHERE l.video_id = t.video_id) AS likes
    FROM tracks t
    WHERE ? = '' OR t.video_id = ? OR t.title LIKE ? OR t.channel LIKE ?
    ORDER BY plays DESC, t.last_seen DESC LIMIT ?
  `).all(q, q, like, like, Math.max(1, Math.min(500, limit)));
}

/** Remove a track everywhere: cached audio is removed by the caller. */
export function deleteTrack(videoId) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM playlist_items WHERE video_id = ?').run(videoId);
    db.prepare('DELETE FROM likes WHERE video_id = ?').run(videoId);
    db.prepare('DELETE FROM dislikes WHERE video_id = ?').run(videoId);
    db.prepare('DELETE FROM plays WHERE video_id = ?').run(videoId);
    const info = db.prepare('DELETE FROM tracks WHERE video_id = ?').run(videoId);
    db.exec('COMMIT');
    return info.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function clearUserHistory(userId) {
  return db.prepare('DELETE FROM plays WHERE user_id = ?').run(userId).changes;
}

/** "Reset my taste": the station evidence and both explicit signals. */
export function clearUserTaste(userId) {
  return db.prepare('DELETE FROM plays WHERE user_id = ?').run(userId).changes
    + db.prepare('DELETE FROM likes WHERE user_id = ?').run(userId).changes
    + db.prepare('DELETE FROM dislikes WHERE user_id = ?').run(userId).changes;
}

export function recordAudit({ actorId, actorName, action, target = null, detail = null }) {
  db.prepare(`
    INSERT INTO admin_audit (actor_id, actor_name, action, target, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorId ?? null, actorName ?? null, action, target, detail, new Date().toISOString());
}

export function listAudit(limit = 30) {
  return db.prepare(`
    SELECT id, actor_id AS actorId, actor_name AS actorName, action, target, detail,
           created_at AS createdAt
    FROM admin_audit ORDER BY id DESC LIMIT ?
  `).all(Math.max(1, Math.min(200, limit)));
}

export function verifyPassword(user, pass) {
  const expected = Buffer.from(user.pass_hash, 'hex');
  const actual = Buffer.from(hashPassword(pass, user.salt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Sessions are stateless: base64url(payload).hmac. No server-side session
 * table, so a restart does not log every device out.
 */
export function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readSession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const want = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  const a = Buffer.from(sig ?? '');
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.uid || !payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * A public-room guest. Deliberately NOT a user session: no uid, a different
 * HMAC domain prefix, and an expiry that cannot outlive a listening session.
 * It authorizes exactly one thing — this room's playhead and the tracks in its
 * queue (see the guest branch of /api/stream). Domain-separating the prefix is
 * what makes a guest token useless as a session cookie, and vice versa.
 */
export function signGuest(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.secret).update(`guest:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function readGuest(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const want = crypto.createHmac('sha256', config.secret).update(`guest:${body}`).digest('base64url');
  const a = Buffer.from(sig ?? '');
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.c || !payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function upsertTrack(t) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tracks (video_id, title, channel, channel_id, duration_s, thumb, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      title = COALESCE(excluded.title, tracks.title),
      channel = COALESCE(excluded.channel, tracks.channel),
      channel_id = COALESCE(excluded.channel_id, tracks.channel_id),
      duration_s = COALESCE(excluded.duration_s, tracks.duration_s),
      thumb = COALESCE(excluded.thumb, tracks.thumb),
      last_seen = excluded.last_seen
  `).run(t.videoId, t.title ?? null, t.channel ?? null, t.channelId ?? null,
    t.durationS ?? null, t.thumb ?? null, now, now);
}

/** Metadata for one known track — used by share links and deep links. */
export function getTrack(videoId) {
  return db.prepare(`
    SELECT video_id AS videoId, title, channel, duration_s AS durationS, thumb
    FROM tracks WHERE video_id = ?
  `).get(videoId) ?? null;
}

export function recordPlay({ userId, videoId, kind, positionMs = null, durationMs = null, source = null }) {
  db.prepare(`
    INSERT INTO plays (user_id, video_id, kind, position_ms, duration_ms, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, videoId, kind, positionMs, durationMs, source, new Date().toISOString());
}

export function toggleLike(userId, videoId, on) {
  if (on) {
    // Liking something that was previously disliked is a change of mind; the
    // two tables must never both hold the same track.
    db.prepare('DELETE FROM dislikes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
    db.prepare('INSERT OR IGNORE INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)')
      .run(userId, videoId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
  }
}

/**
 * Mark a track as "less like this", or clear that mark.
 *
 * A dislike is exclusive with a like: you cannot both want a song in your
 * library and never want to hear it.
 */
export function toggleDislike(userId, videoId, on) {
  if (on) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
    db.prepare('INSERT OR IGNORE INTO dislikes (user_id, video_id, created_at) VALUES (?, ?, ?)')
      .run(userId, videoId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM dislikes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
  }
}

export function listDislikes(userId) {
  return db.prepare(`
    SELECT d.video_id AS videoId, t.title, t.channel, t.thumb, t.duration_s AS durationS,
           d.created_at AS dislikedAt
    FROM dislikes d LEFT JOIN tracks t ON t.video_id = d.video_id
    WHERE d.user_id = ? ORDER BY d.created_at DESC
  `).all(userId);
}

/** Just the ids — what every generated queue needs to filter against. */
export function dislikedIds(userId) {
  return new Set(db.prepare('SELECT video_id FROM dislikes WHERE user_id = ?')
    .all(userId).map((r) => r.video_id));
}

export function listLikes(userId) {
  return db.prepare(`
    SELECT l.video_id AS videoId, t.title, t.channel, t.thumb, t.duration_s AS durationS, l.created_at AS likedAt
    FROM likes l LEFT JOIN tracks t ON t.video_id = l.video_id
    WHERE l.user_id = ? ORDER BY l.created_at DESC
  `).all(userId);
}

// ── playlists ───────────────────────────────────────────────────────────

export function listPlaylists(userId) {
  return db.prepare(`
    SELECT p.id, p.title, p.description, p.art_video AS artVideo, p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS trackCount
    FROM playlists p WHERE p.user_id = ? ORDER BY p.updated_at DESC
  `).all(userId);
}

export function createPlaylist(userId, { title, description = null, artVideo = null }) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO playlists (user_id, title, description, art_video, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, title, description, artVideo, now, now);
  return Number(info.lastInsertRowid);
}

/** A playlist only exists for its owner, so every lookup is user-scoped. */
export function getPlaylist(userId, id) {
  const p = db.prepare(`
    SELECT id, title, description, art_video AS artVideo, updated_at AS updatedAt
    FROM playlists WHERE id = ? AND user_id = ?
  `).get(id, userId);
  if (!p) return null;
  p.tracks = db.prepare(`
    SELECT i.video_id AS videoId, t.title, t.channel, t.thumb, t.duration_s AS durationS
    FROM playlist_items i LEFT JOIN tracks t ON t.video_id = i.video_id
    WHERE i.playlist_id = ? ORDER BY i.position
  `).all(id);
  return p;
}

export function addPlaylistItem(userId, playlistId, track) {
  const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!p) return false;
  upsertTrack(track);
  const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM playlist_items WHERE playlist_id = ?')
    .get(playlistId).n;
  db.prepare(`
    INSERT OR IGNORE INTO playlist_items (playlist_id, video_id, position, added_at) VALUES (?, ?, ?, ?)
  `).run(playlistId, track.videoId, next, new Date().toISOString());
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), playlistId);
  return true;
}

export function removePlaylistItem(userId, playlistId, videoId) {
  const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!p) return false;
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?').run(playlistId, videoId);
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), playlistId);
  return true;
}

export function deletePlaylist(userId, playlistId) {
  const info = db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(playlistId, userId);
  return info.changes > 0;
}

/**
 * "Recently played" as distinct tracks, newest first. Derived from the plays
 * table rather than a separate list, so it cannot drift from the signal data.
 */
export function recentlyPlayed(userId, limit = 40) {
  return db.prepare(`
    SELECT p.video_id AS videoId, MAX(p.created_at) AS at,
           t.title, t.channel, t.thumb, t.duration_s AS durationS
    FROM plays p LEFT JOIN tracks t ON t.video_id = p.video_id
    WHERE p.user_id = ? AND p.kind IN ('start','complete')
    GROUP BY p.video_id ORDER BY at DESC LIMIT ?
  `).all(userId, limit);
}

/**
 * The artists this user actually listens to, ranked by engagement rather than
 * by a search query. This is what makes the library tab personal: a plain
 * channel search for "music" just returns random small channels.
 */
export function topArtists(userId, limit = 18) {
  return db.prepare(`
    SELECT t.channel AS title,
           COUNT(*) AS plays,
           MAX(p.created_at) AS lastPlayed,
           (SELECT t2.thumb FROM tracks t2
             WHERE t2.channel = t.channel AND t2.thumb IS NOT NULL LIMIT 1) AS thumb
    FROM plays p
    JOIN tracks t ON t.video_id = p.video_id
    WHERE p.user_id = ? AND t.channel IS NOT NULL AND t.channel != ''
      AND p.kind IN ('start','complete','like')
    GROUP BY t.channel
    ORDER BY plays DESC, lastPlayed DESC
    LIMIT ?
  `).all(userId, limit);
}

export function cacheGet(key) {
  const row = db.prepare('SELECT value, expires_at FROM upstream_cache WHERE key = ?').get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM upstream_cache WHERE key = ?').run(key);
    return null;
  }
  try { return JSON.parse(row.value); } catch { return null; }
}

export function cacheSet(key, value, ttlMs) {
  db.prepare(`
    INSERT INTO upstream_cache (key, value, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
  `).run(key, JSON.stringify(value), Date.now() + ttlMs);
}

/** Drop a cached value early (e.g. the personal station after a new like). */
export function cacheDelete(key) {
  db.prepare('DELETE FROM upstream_cache WHERE key = ?').run(key);
}

/** Drop every cached value whose key starts with `prefix`. */
export function cacheDeletePrefix(prefix) {
  // LIKE treats % and _ as wildcards; the keys are ours, so escape them.
  const escaped = String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.prepare("DELETE FROM upstream_cache WHERE key LIKE ? ESCAPE '\\'")
    .run(`${escaped}%`).changes;
}

/**
 * The evidence behind the personal station: how far each track was actually
 * heard, aggregated per track, plus explicit likes.
 *
 * `deepest` is the furthest fraction of a track ever reached, which is the only
 * way to tell "listened to it" from "skipped after 8 seconds" without a model.
 */
export function stationCandidates(userId, limit = 400) {
  const plays = db.prepare(`
    SELECT p.video_id AS videoId,
           SUM(CASE WHEN p.kind = 'complete' THEN 1 ELSE 0 END) AS completes,
           SUM(CASE WHEN p.kind = 'skip'     THEN 1 ELSE 0 END) AS skips,
           SUM(CASE WHEN p.kind = 'start'    THEN 1 ELSE 0 END) AS starts,
           MAX(CASE WHEN p.duration_ms > 0 AND p.position_ms IS NOT NULL
                    THEN MIN(1.0, CAST(p.position_ms AS REAL) / p.duration_ms)
                    ELSE 0 END) AS deepest,
           MAX(p.created_at) AS lastPlayed,
           t.title, t.channel, t.thumb, t.duration_s AS durationS
    FROM plays p LEFT JOIN tracks t ON t.video_id = p.video_id
    WHERE p.user_id = ? AND p.kind IN ('start','progress','complete','skip')
    GROUP BY p.video_id
    ORDER BY lastPlayed DESC
    LIMIT ?
  `).all(userId, limit);
  return { plays, likes: listLikes(userId) };
}

/**
 * The artists this user keeps coming back to, weighted by how much of each
 * track was heard. Used to pull in more from the same artist, so the station is
 * not limited to songs already in the history.
 */
export function stationArtists(userId, limit = 4) {
  return db.prepare(`
    SELECT t.channel AS name, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.video_id = p.video_id
    WHERE p.user_id = ? AND t.channel IS NOT NULL AND t.channel != ''
      AND p.kind IN ('complete','like')
    GROUP BY t.channel
    ORDER BY plays DESC
    LIMIT ?
  `).all(userId, limit);
}

// ── follows & notifications ─────────────────────────────────────────────
// The polling logic lives in src/follows.js; this module owns the SQL. A follow
// is per user, a release is per artist, and a notification is per user per
// release — the three tables exist because those are three different lifetimes.

/** Follow an artist, or refresh the label we show for them. */
export function followArtist(userId, { artistId, name = null, thumb = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO artist_follows (user_id, artist_id, name, thumb, created_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, artist_id) DO UPDATE SET
      name = COALESCE(excluded.name, artist_follows.name),
      thumb = COALESCE(excluded.thumb, artist_follows.thumb)
  `).run(userId, artistId, name, thumb, now);
  return isFollowing(userId, artistId);
}

export function unfollowArtist(userId, artistId) {
  return db.prepare('DELETE FROM artist_follows WHERE user_id = ? AND artist_id = ?')
    .run(userId, artistId).changes > 0;
}

export function listFollows(userId) {
  return db.prepare(`
    SELECT artist_id AS artistId, name, thumb,
           created_at AS since, last_checked_at AS lastCheckedAt
    FROM artist_follows WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

export function isFollowing(userId, artistId) {
  if (!userId || !artistId) return false;
  return Boolean(db.prepare('SELECT 1 AS x FROM artist_follows WHERE user_id = ? AND artist_id = ?')
    .get(userId, artistId));
}

/**
 * A check is a fact about the artist, so it is recorded on every follower's row
 * at once — otherwise the next sweep would re-check the same page once per
 * follower.
 */
export function touchFollowChecked(artistId, at = new Date().toISOString()) {
  return db.prepare('UPDATE artist_follows SET last_checked_at = ? WHERE artist_id = ?')
    .run(at, artistId).changes;
}

/**
 * The artists a sweep should look at next: one row per artist, least recently
 * checked first, with never-checked (`last_checked_at` NULL → '') ahead of the
 * rest. Only artists somebody actually follows can appear here — the sweep
 * never walks the catalogue.
 */
export function listFollowsToCheck(limit = 4) {
  return db.prepare(`
    SELECT artist_id AS artistId,
           MAX(name) AS name,
           MAX(thumb) AS thumb,
           COUNT(*) AS followers,
           MIN(COALESCE(last_checked_at, '')) AS lastCheckedAt
    FROM artist_follows
    GROUP BY artist_id
    ORDER BY lastCheckedAt ASC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, limit)));
}

/** Everyone who follows an artist — the fan-out target of a fresh release. */
export function listArtistFollowers(artistId) {
  return db.prepare(`
    SELECT user_id AS userId, name, thumb FROM artist_follows WHERE artist_id = ?
  `).all(artistId);
}

export function knownReleases(artistId) {
  return db.prepare(`
    SELECT release_id AS releaseId, title, kind, year, thumb
    FROM artist_releases WHERE artist_id = ?
  `).all(artistId);
}

/** Record what an artist has released. Existing rows are left alone: the first
 *  sighting is the one that matters, and re-recording must never count as new. */
export function recordReleases(artistId, releases) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO artist_releases
      (artist_id, release_id, title, kind, year, thumb, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const r of releases ?? []) {
      if (!r?.releaseId) continue;
      added += stmt.run(artistId, r.releaseId, r.title ?? null, r.kind ?? null,
        r.year ?? null, r.thumb ?? null, now).changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return added;
}

/**
 * Add one notification. `dedupe` is the idempotency key: INSERT OR IGNORE makes
 * a repeated poll a no-op, and the return value tells the caller whether this
 * call is the one that actually created the row (so counts are honest).
 */
export function addNotification({
  userId, kind = 'release', title = null, body = null, thumb = null, url = null,
  artistId = null, artistName = null, videoId = null, dedupe, createdAt = null,
}) {
  if (!userId || !dedupe) throw new Error('addNotification needs a user and a dedupe key');
  const info = db.prepare(`
    INSERT OR IGNORE INTO notifications
      (user_id, kind, title, body, thumb, url, artist_id, artist_name, video_id, dedupe, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, kind, title, body, thumb, url, artistId, artistName, videoId, dedupe,
    createdAt ?? new Date().toISOString());
  return info.changes > 0;
}

export function listNotifications(userId, limit = 50) {
  return db.prepare(`
    SELECT id, kind, title, body, thumb, url,
           artist_id AS artistId, artist_name AS artistName, video_id AS videoId,
           created_at AS createdAt, read_at AS readAt
    FROM notifications WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, Math.max(1, Math.min(100, limit)));
}

export function countUnread(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId).n;
}

/** Only the caller's own rows can be marked, whatever ids a client sends. */
export function markNotificationsRead(userId, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    // A JSON body can carry anything; only a positive integer can be an id.
    .map((id) => (typeof id === 'number' || typeof id === 'string' ? Number(id) : Number.NaN))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!list.length) return 0;
  const marks = list.map(() => '?').join(', ');
  return db.prepare(`
    UPDATE notifications SET read_at = ?
    WHERE user_id = ? AND read_at IS NULL AND id IN (${marks})
  `).run(new Date().toISOString(), userId, ...list).changes;
}

export function markAllNotificationsRead(userId) {
  return db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(new Date().toISOString(), userId).changes;
}

/**
 * Housekeeping: the bell is a recent-events feed, not an archive. Read rows are
 * dropped after `days`; unread ones get twice the window, because a long
 * absence must not silently delete something the user has never seen.
 */
export function pruneNotifications(days = 60) {
  const readCutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const unreadCutoff = new Date(Date.now() - days * 2 * 86_400_000).toISOString();
  return db.prepare(`
    DELETE FROM notifications
    WHERE (read_at IS NOT NULL AND created_at < ?) OR created_at < ?
  `).run(readCutoff, unreadCutoff).changes;
}

export function bootstrapUser() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  if (!config.bootstrapPass) {
    console.warn('[sonora] no users yet and SONORA_PASSPHRASE unset — login is impossible until you set it');
    return;
  }
  // The first account is the instance owner, so it is an admin by construction.
  // Other admins are assigned in the database (see scripts/set-role.js).
  createUser(config.bootstrapUser, config.bootstrapPass, 'admin');
  console.log(`[sonora] created bootstrap admin "${config.bootstrapUser}"`);
}

export { SHA };
