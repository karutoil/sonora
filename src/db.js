import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

/**
 * Fail with the cause instead of SQLITE_READONLY.
 *
 * A bind mount whose host owner is not the container's runtime user opens fine
 * for reading and then dies several steps later on the first CREATE TABLE, so
 * the only message the operator sees is "attempt to write a readonly database"
 * from deep inside the migration — which reads like a corrupt file and sends
 * people to the schema instead of the mount. The two access checks below are the
 * whole diagnosis, cost nothing and take no SQLite lock (an idle boot must still
 * write nothing, see migrateSchema), so the failure names the offending path and
 * both repair commands.
 *
 * Only checked when the check fails: a healthy file costs one syscall pair.
 */
function assertWritable(dbPath) {
  // In-memory or a URI handled by SQLite itself: nothing to inspect on disk.
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return;

  const dir = path.dirname(dbPath);
  const problems = [];
  const writable = (target) => {
    try {
      fs.accessSync(target, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (!writable(dir)) problems.push(`directory ${dir} is not writable`);
  // A missing file is fine (first boot creates it); an existing one that cannot
  // be written is the failure this exists for. WAL also needs to create the
  // -wal and -shm siblings, which the directory check above already covers.
  if (fs.existsSync(dbPath) && !writable(dbPath)) problems.push(`database ${dbPath} is not writable`);
  if (!problems.length) return;

  const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
  const gid = typeof process.getgid === 'function' ? process.getgid() : '?';
  throw new Error(
    `[sonora] cannot write to ${dbPath}: ${problems.join(' and ')} `
    + `(running as uid ${uid}, gid ${gid}).\n`
    + 'This is a file-ownership problem, not a corrupt database. The directory is '
    + 'usually a bind mount owned by a different user:\n'
    + '  Docker:          sudo chown -R 1000:1000 data\n'
    + '  Rootless Podman: sudo chown -R "$(id -u):$(id -g)" data   (and start with '
    + 'compose.podman.yaml, which keeps your uid inside the container)\n'
    + 'See README.md (Option A — container).',
  );
}

assertWritable(config.dbPath);

export const db = new DatabaseSync(config.dbPath);

// ── connection pragmas ──────────────────────────────────────────────────
// busy_timeout comes first on purpose. WAL still serialises writers, so a
// second writer (a second instance, scripts/set-role.js, a backup copy of the
// file) must wait for the lock instead of failing instantly with SQLITE_BUSY.
// And the journal_mode switch below needs a brief exclusive lock to convert a
// rollback-journal file: with the default 0 ms timeout that conversion failed
// instantly — aborting the whole import — whenever anything else had the file
// open (sqlite3, a `cp` mid-read, a second process).
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
const IN_WAL = enableWal();
// synchronous: SQLite defaults to FULL, i.e. an fsync per autocommit write.
// Every recordPlay(), touchDevice() and expired cacheGet() is its own
// transaction, and this process is synchronous, so on the SD card this app is
// meant to run on each of those fsyncs stalled the event loop — pressing "next"
// cost a disk flush before the next request was answered.
// NORMAL is the standard WAL pairing: a commit is still atomic and the file is
// still consistent after a crash or a power cut; only the last few *committed*
// transactions can be lost if the machine dies before the next checkpoint, and
// losing the tail of the play log is not worth stalling the server for. It is
// set only when WAL actually took: in rollback-journal mode NORMAL risks a
// corrupt file on power loss rather than merely a lost tail, and this project
// deliberately keeps serving from a rollback-journal file (see enableWal).
if (IN_WAL) db.exec('PRAGMA synchronous = NORMAL');
// 16 MiB page cache instead of the 2 MiB default. The hot set — the indexes
// this file declares, recently played tracks, the current user's plays — fits in
// that; past it an extra megabyte buys nothing, and the box this runs on (a
// household server, often a Pi) has better uses for the RAM.
db.exec('PRAGMA cache_size = -16384');

/** Returns whether the file ended up in WAL mode, which decides the pragmas below. */
function enableWal() {
  // Already converted: reading the mode needs no lock at all, so the common boot
  // path never asks for one.
  if (journalMode() === 'wal') return true;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // A PRAGMA assignment can succeed without granting the requested mode.
      // In-memory databases are the simplest example: they answer "memory" and
      // throw nothing. Re-read the connection instead of treating no exception
      // as proof of WAL (and, critically, before enabling synchronous=NORMAL).
      db.prepare('PRAGMA journal_mode = WAL').get();
      const actual = journalMode();
      if (actual === 'wal') return true;
      lastErr = new Error(`SQLite remained in ${actual} mode`);
      break;
    } catch (err) {
      lastErr = err;
      // A blocking sleep, deliberately: this runs before the module exposes
      // anything, there is no event loop yet, and it is the failure path only.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  // A rollback-journal database still works: one writer at a time, which this
  // single-process app already is, and busy_timeout makes a second writer wait
  // instead of failing. Refusing to boot (what this used to do) turned "somebody
  // has the file open for a second" into an outage. Warn, keep going, and the
  // next clean start converts.
  console.warn(`[sonora] could not switch ${config.dbPath} to WAL (${lastErr?.message ?? 'unknown error'}); `
    + `continuing in ${journalMode()} mode. Restart once nothing else has the file open.`);
  return false;
}

function journalMode() {
  try {
    return String(Object.values(db.prepare('PRAGMA journal_mode').get() ?? {})[0] ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

// Used by migration 2 as well as the later integrity helpers, so this constant
// must be initialized before the module runs its migration batch.
const ORPHAN_STATION_CACHE_WHERE = `
  key >= 'station:' AND key < 'station:\uFFFF'
  AND CAST(substr(key, 9, instr(substr(key, 9), ':') - 1) AS INTEGER)
      NOT IN (SELECT id FROM users)
`;

/**
 * The schema this build defines — every CREATE TABLE and CREATE INDEX, in one
 * canonical place. Nothing executes it directly: referenceSchema() parses it in
 * a scratch in-memory database so tables, columns and indexes can be applied to
 * a real file in the order a migration needs rather than in the order the text
 * happens to be written.
 */
const SCHEMA_SQL = `
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
  -- "Who is this artist" (topArtists, stationArtists, the station's familiar
  -- artist buckets) filters tracks by channel; without this every such lookup
  -- is a full scan of the track table.
  CREATE INDEX IF NOT EXISTS tracks_channel ON tracks(channel);

  -- The taste signal. Written from day one; the model can wait.
  CREATE TABLE IF NOT EXISTS plays (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    video_id    TEXT NOT NULL,
    -- The kinds this build reads: start | progress | complete | skip | like.
    -- Older builds also wrote unlike/dislike/undislike here to record the *act*
    -- of withdrawing a like, but no query ever read them back — a withdrawn like
    -- is already expressed by deleting the row from the likes table (and, since
    -- the taste model counts kind='like', by dropping that row in toggleLike
    -- too). They are tolerated in old files and retired by prunePlays().
    kind        TEXT NOT NULL,            -- start | progress | complete | skip | like
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
  -- The library reads one user's likes newest-first; the primary key orders by
  -- video_id, so without this the sort needs a temp B-tree on every open.
  CREATE INDEX IF NOT EXISTS likes_user_time ON likes(user_id, created_at DESC);

  -- Explicit "less of this". Deliberately a separate table from likes rather
  -- than a boolean on it: a dislike is a standing instruction (never put this in
  -- a generated queue again), while a like is a collection the user browses.
  CREATE TABLE IF NOT EXISTS dislikes (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    video_id   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS dislikes_user_time ON dislikes(user_id, created_at DESC);

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
    -- The sweep's own bookkeeping, separate from last_checked_at on purpose: a
    -- failed check is an attempt, not a check, and must not look like "we looked
    -- and there was nothing new". Without it a permanently failing artist sat at
    -- the front of the oldest-first queue forever and starved every healthy one.
    last_attempt_at TEXT,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, artist_id)
  );
  CREATE INDEX IF NOT EXISTS artist_follows_user ON artist_follows(user_id, created_at DESC);
  -- The sweep reads one user's rows in (fail_count, last_attempt_at) order and
  -- filters on the same two columns; this keeps that a range read.
  CREATE INDEX IF NOT EXISTS artist_follows_sweep
    ON artist_follows(user_id, fail_count, last_attempt_at);

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

  -- A successful first catalogue read must be distinguishable from an artist
  -- whose first read returned no releases. This is per-artist state, not a fake
  -- release in the table above: knownReleases([]) must really mean no releases.
  CREATE TABLE IF NOT EXISTS artist_release_state (
    artist_id     TEXT PRIMARY KEY,
    initialized_at TEXT NOT NULL
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
  -- The bell badge asks "how many unread" on every poll. A partial index makes
  -- that a count over just the unread rows instead of a table lookup per row.
  CREATE INDEX IF NOT EXISTS notifications_unread
    ON notifications(user_id) WHERE read_at IS NULL;

  -- ── indexes added later, kept in the same list ────────────────────────
  -- Every statement here is CREATE ... IF NOT EXISTS, i.e. additive and
  -- replayable, which is why indexes need no version of their own: they are
  -- reconciled after the column migrations — a missing one is created, one
  -- whose definition changed is rebuilt, and a file that already has them is
  -- not touched at all.

  -- role is read by countAdmins() and the admin Users list. Declared here, not
  -- next to the ALTER TABLE, so it is created after the column migration.
  CREATE INDEX IF NOT EXISTS users_role ON users(role);

  -- likes/dislikes are keyed by (user_id, video_id), so "how many people like
  -- this track" and "delete this track's likes" used to scan the whole table
  -- per row: the admin Tracks panel went from 139 ms to 2 ms with these two.
  CREATE INDEX IF NOT EXISTS likes_video ON likes(video_id);
  CREATE INDEX IF NOT EXISTS dislikes_video ON dislikes(video_id);

  -- deleteTrack() removes a track from every playlist; this makes that a
  -- lookup instead of a scan.
  CREATE INDEX IF NOT EXISTS playlist_items_video ON playlist_items(video_id);

  -- deleteTrack() now also prunes the bell for that track (a notification for
  -- a deleted video opened a dead #/t/<id>).
  CREATE INDEX IF NOT EXISTS notifications_video ON notifications(video_id);

  -- Expiry sweeps are WHERE expires_at < ? over two tables that only grow
  -- between restarts. Indexed so the sweep does not read every dead row.
  CREATE INDEX IF NOT EXISTS upstream_cache_expiry ON upstream_cache(expires_at);
  CREATE INDEX IF NOT EXISTS refresh_tokens_expiry ON refresh_tokens(expires_at);

  -- The station and "recently played" group one user's plays by video_id and
  -- sort them by time. This covering index lets that happen without walking
  -- every play row the user ever produced (a heavy listener reaches ~80 k
  -- rows a year, and the whole app blocks behind the synchronous query).
  --
  -- position_ms/duration_ms are part of it (rather than stopping at created_at)
  -- because the station also derives "deepest fraction heard" from every row:
  -- without them each of those rows needed a table page read to fetch the two
  -- columns, i.e. exactly the random read per play row the index was added to
  -- avoid. Cost of the wider index is a few bytes per play row; the win,
  -- measured on a 600 k-row / 60 k-track file, is 149 ms → 100 ms per cold
  -- station build, with the plan going from INDEX to COVERING INDEX.
  CREATE INDEX IF NOT EXISTS plays_user_kind_video
    ON plays(user_id, kind, video_id, created_at, position_ms, duration_ms);

  -- The admin Tracks panel shows "play count" and "skip count" per track, i.e.
  -- two COUNT(*)s per video_id filtered by kind. plays_video(video_id) could
  -- answer them only by reading the table row (kind lives there), and
  -- plays_user_kind_video cannot be used at all because it starts at user_id —
  -- so the panel did two random page reads per track on the instance. With this
  -- index both counts are answered from index entries alone: measured 277 ms →
  -- 52 ms for the unfiltered 100-row page at 600 k plays / 60 k tracks.
  CREATE INDEX IF NOT EXISTS plays_video_kind ON plays(video_id, kind);

  -- Retention for the write-only kinds (prunePlays): a plain (kind, created_at)
  -- range, so the hourly sweep deletes by index instead of scanning the biggest
  -- table in the file.
  CREATE INDEX IF NOT EXISTS plays_kind_time ON plays(kind, created_at);

  -- The bell's retention sweep is created_at < ? with no user in the predicate,
  -- so neither notifications index (both start at user_id) can serve it.
  CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at);

  -- artist_follows is keyed (user_id, artist_id), so artist_id is not a usable
  -- prefix and four queries constrain on it alone: listArtistFollowers (once per
  -- due artist per sweep), the "followers" correlated count inside
  -- followSweepDue, touchFollowChecked's UPDATE, and listFollowsToCheck's
  -- GROUP BY artist_id.
  CREATE INDEX IF NOT EXISTS artist_follows_artist ON artist_follows(artist_id);
`;

// ── schema, columns & migrations ────────────────────────────────────────
//
// Three things have to be true for an instance that predates a release to boot:
//
//   1. Tables it has never heard of must be created — CREATE TABLE IF NOT EXISTS
//      does that, in dependency order, so children follow their parents.
//   2. Tables it already has must gain the columns that release added.
//      CREATE TABLE IF NOT EXISTS silently does nothing there, which is how a
//      stale `tracks` table (no channel_id) started perfectly and then answered
//      500 "no such column: channel_id" on every search, play and like — with
//      nothing in the log to say the database was the problem.
//   3. The work must be one transaction, and the file must record the version it
//      reached. Otherwise a crash halfway leaves a half-migrated file, and two
//      processes starting at once both run the same ALTER TABLE and one dies
//      with "duplicate column name".
//
// `PRAGMA user_version` is that version marker: it lives in the database header,
// moves atomically with the transaction that changes it, costs no table, and is
// ignored by older builds.

/** A scratch in-memory copy of SCHEMA_SQL, used as the reference shape. */
function referenceSchema() {
  const mem = new DatabaseSync(':memory:');
  try {
    mem.exec(SCHEMA_SQL);
    const tables = mem.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all();
    const columns = new Map();
    const uniques = new Map();
    for (const { name } of tables) {
      columns.set(name, mem.prepare(`PRAGMA table_xinfo("${name}")`).all());
      // Table-level uniqueness — UNIQUE(...) and a non-rowid PRIMARY KEY — is the
      // one part of the schema no migration can add (see syncColumns). Record
      // the column sets so assertSchema() can prove a file has them.
      uniques.set(name, uniqueColumnSets(mem, name));
    }
    const indexes = mem.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
    `).all();
    return { tables, columns, uniques, indexes };
  } finally {
    mem.close();
  }
}

/**
 * The column sets this connection's `table` is unique on because its CREATE TABLE
 * says so, each as "col1,col2".
 *
 * Only origin 'u' (a UNIQUE constraint) and 'pk' (a composite primary key) count:
 * those are the ones a hand-edited or older file can be missing while still
 * accepting reads. A `CREATE UNIQUE INDEX` (origin 'c') is not listed here — it
 * is reconciled by syncIndexes() instead. An INTEGER PRIMARY KEY is a rowid alias
 * and appears in neither list, which is why this reads the index list rather than
 * the column list.
 */
function uniqueColumnSets(conn, table) {
  return conn.prepare(`PRAGMA index_list("${table}")`).all()
    .filter((ix) => ix.origin === 'u' || ix.origin === 'pk')
    .map((ix) => conn.prepare(`PRAGMA index_info("${ix.name}")`).all().map((c) => c.name).join(','))
    .sort();
}

/** `ALTER TABLE ... ADD COLUMN`, or false when the column is already there. */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  return true;
}

/**
 * Add every column the schema declares that this file does not have yet.
 *
 * Deliberately additive only: nothing is dropped, renamed or rewritten, so a
 * migration cannot lose a row of user data and an older build still works
 * against the migrated file. A column SQLite refuses to add (a PRIMARY KEY, or
 * NOT NULL with no default to backfill with) throws with the table and column
 * named — that is a change no automatic migration should guess at, so it needs
 * a human and a backup. Uniqueness cannot be added by ALTER TABLE either; the
 * columns that carry it (users.name, devices.client_device_id, …) are created
 * with their table, and assertSchema() is what catches a file that lacks them —
 * it compares the reference's UNIQUE/PRIMARY KEY column sets against the file's
 * and refuses to boot naming the constraint, because silently continuing means
 * addNotification's INSERT OR IGNORE stops deduping (every follow poll re-adds
 * the same release to the bell) and nothing ever reports why.
 */
function syncColumns(schema) {
  const added = new Set();
  for (const [table, expected] of schema.columns) {
    const actual = new Set(db.prepare(`PRAGMA table_xinfo("${table}")`).all().map((c) => c.name));
    for (const col of expected) {
      if (col.hidden) continue; // generated/hidden columns cannot be added
      if (actual.has(col.name)) continue;
      if (col.pk) {
        throw new Error(
          `[sonora] cannot migrate ${table}: "${col.name}" is part of the primary key and is `
          + 'missing from this database. Restore a backup instead of letting this build guess.',
        );
      }
      if (col.notnull && col.dflt_value === null) {
        throw new Error(
          `[sonora] cannot migrate ${table}: "${col.name}" is NOT NULL with no default, so `
          + 'existing rows cannot be backfilled automatically. Back up ./data and add it by hand.',
        );
      }
      const ddl = `"${col.name}" ${col.type || 'TEXT'}`
        + `${col.notnull ? ' NOT NULL' : ''}`
        + `${col.dflt_value === null ? '' : ` DEFAULT ${col.dflt_value}`}`;
      db.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
      added.add(`${table}.${col.name}`);
      console.log(`[sonora] migrated schema: added ${table}.${col.name}`);
    }
  }
  return added;
}

/**
 * The versioned history. Append only: a released number is never reused or
 * renumbered, because databases in the field already recorded it. Each step runs
 * exactly once per file, inside the boot transaction, and its work moves the
 * `user_version` bump with it.
 */
const MIGRATIONS = [
  [1, 'users: role, disabled, session_version, last_login_at, last_seen_at', () => {
    // The original ad-hoc migration, now a numbered step. The columns are added
    // by syncColumns() before this runs; these calls keep the step readable —
    // and still correct if the generic sync is ever narrowed.
    ensureColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'user'");
    ensureColumn('users', 'disabled', 'disabled INTEGER NOT NULL DEFAULT 0');
    ensureColumn('users', 'session_version', 'session_version INTEGER NOT NULL DEFAULT 1');
    ensureColumn('users', 'last_login_at', 'last_login_at TEXT');
    ensureColumn('users', 'last_seen_at', 'last_seen_at TEXT');

    // Upgrading an instance that predates the admin role must not lock its
    // owner out: the oldest account becomes the admin, which is the account
    // that ran the bootstrap. Fresh databases get theirs from bootstrapUser().
    // The version, not whether the column happened to exist already, is what
    // makes this a one-time upgrade. Restored v0 files can already have `role`;
    // skipping them would leave their owner locked out. An existing admin still
    // wins, and once v1 is committed no later boot runs this promotion again.
    const promoted = db.prepare(`
      UPDATE users SET role = 'admin'
      WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (
        SELECT 1 FROM users WHERE role = 'admin'
      )
    `).run().changes;
    if (promoted) console.log('[sonora] migrated users.role: the first account is now an admin');
  }],

  [2, 'integrity: like/dislike conflicts, cached stations of deleted accounts', () => {
    // A like and a dislike are contradictory instructions, and the two API calls
    // that write them keep the tables mutually exclusive (toggleLike /
    // toggleDislike). A file that breaks that — an interrupted write, a hand
    // edit, a build from before the transaction — would show one track both in
    // the library and in "never play this". Keep the newer action, which is what
    // the user asked for last.
    const staleDislikes = db.prepare(`
      DELETE FROM dislikes WHERE EXISTS (
        SELECT 1 FROM likes l
        WHERE l.user_id = dislikes.user_id AND l.video_id = dislikes.video_id
          AND l.created_at >= dislikes.created_at
      )
    `).run().changes;
    // A newer dislike has the same effect as toggleDislike(): remove the like's
    // play-log signal as well as its library row. Delete these before staleLikes
    // removes the rows that identify which play events belong to that action.
    //
    // `>=` throughout, matching staleDislikes: with a strict `>` an equal
    // created_at left the two statements disagreeing about which action won,
    // and a like row whose play-log signal depended on that ordering could be
    // abandoned in `plays` as an orphan `kind='like'` row for a disliked track.
    const staleLikePlays = db.prepare(`
      DELETE FROM plays WHERE kind = 'like' AND EXISTS (
        SELECT 1 FROM likes l JOIN dislikes d
          ON d.user_id = l.user_id AND d.video_id = l.video_id
        WHERE l.user_id = plays.user_id AND l.video_id = plays.video_id
          AND d.created_at >= l.created_at
      )
    `).run().changes;
    const staleLikes = db.prepare(`
      DELETE FROM likes WHERE EXISTS (
        SELECT 1 FROM dislikes d
        WHERE d.user_id = likes.user_id AND d.video_id = likes.video_id
          AND d.created_at >= likes.created_at
      )
    `).run().changes;
    // Station blobs are cached under `station:<user id>:…` and have no foreign
    // key. SQLite reuses the highest rowid after a delete, so a brand-new
    // account could be handed a deleted account's ten-minute station
    // (seeds, queue and all) and be shown it as its own.
    const staleCache = pruneOrphanCache();
    const conflicts = staleDislikes + staleLikes;
    if (conflicts || staleLikePlays || staleCache) {
      console.log(`[sonora] migrated integrity: ${conflicts} conflicting like/dislike row(s), `
        + `${staleLikePlays} stale like play row(s), ${staleCache} orphaned cache row(s) removed`);
    }
  }],

  [3, 'follows: last_attempt_at / fail_count, so a failing artist cannot hog the sweep', () => {
    // The columns are added by syncColumns() before this runs (they are part of
    // the table's declaration); the explicit calls keep the step readable and
    // correct if the generic sync is ever narrowed.
    ensureColumn('artist_follows', 'last_attempt_at', 'last_attempt_at TEXT');
    ensureColumn('artist_follows', 'fail_count', 'fail_count INTEGER NOT NULL DEFAULT 0');
    // A hand-added or restored column can hold NULL, which would make
    // `fail_count + 1` NULL and the backoff comparison meaningless.
    const repaired = db.prepare('UPDATE artist_follows SET fail_count = 0 WHERE fail_count IS NULL')
      .run().changes;
    if (repaired) console.log(`[sonora] migrated follows: ${repaired} fail_count NULL(s) reset to 0`);
  }],

  [4, 'follows: durable per-artist initialization, replacing the empty-catalogue marker', () => {
    // Any known release proves the artist's first baseline was established. The
    // short-lived reserved marker proves the same thing for an empty catalogue.
    // Move both facts to explicit state before removing the marker; all of this
    // and the v4 header update share the surrounding migration transaction.
    const initialized = db.prepare(`
      INSERT OR IGNORE INTO artist_release_state (artist_id, initialized_at)
      SELECT artist_id, MIN(first_seen) FROM artist_releases GROUP BY artist_id
    `).run().changes;
    const markers = db.prepare(`
      DELETE FROM artist_releases WHERE release_id = '__sonora_initialized_empty_v1__'
    `).run().changes;
    if (initialized || markers) {
      console.log(`[sonora] migrated follows: ${initialized} initialized artist(s), `
        + `${markers} empty-catalogue marker(s) removed`);
    }
  }],
];

/** The schema version this build expects and writes. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1][0];

function readUserVersion() {
  return Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
}

/**
 * What this file is at, for the admin storage panel and the tests.
 * `current: false` on a file this build cannot serve (a newer release wrote it).
 */
export function schemaStatus() {
  const version = readUserVersion();
  return { version, expected: SCHEMA_VERSION, current: version === SCHEMA_VERSION };
}

function refuseDowngrade(version) {
  throw new Error(
    `[sonora] ${config.dbPath} is at schema v${version}; this build only knows v${SCHEMA_VERSION}. `
    + 'That database was written by a newer release — upgrade the server rather than downgrade the file.',
  );
}

/** SQLite stores a statement with `IF NOT EXISTS` stripped, so compare without it. */
function normalizeSql(sql) {
  return String(sql).replace(/\bIF\s+NOT\s+EXISTS\s+/i, '').replace(/\s+/g, ' ').trim();
}

/**
 * Create the tables this file does not have yet, in declaration order.
 *
 * Tables are never dropped or rewritten: only missing ones are created, and the
 * schema is written parents-first, so a foreign key can never name a table that
 * does not exist yet.
 */
function createMissingTables(schema) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((r) => r.name));
  for (const { name, sql } of schema.tables) {
    if (tables.has(name)) continue;
    db.exec(sql);
    console.log(`[sonora] migrated schema: created table ${name}`);
  }
}

/**
 * Reconcile the indexes. An index carries no data, so one whose definition
 * changed in this build is dropped and recreated — which is what makes an index
 * change shippable without spending a schema version on it.
 */
function syncIndexes(schema) {
  const existing = new Map(db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
  ).all().map((r) => [r.name, normalizeSql(r.sql)]));
  for (const { name, sql } of schema.indexes) {
    const want = normalizeSql(sql);
    const have = existing.get(name);
    if (have === want) continue;
    if (have !== undefined) {
      db.exec(`DROP INDEX "${name}"`);
      console.log(`[sonora] migrated schema: rebuilt index ${name}`);
    }
    db.exec(sql);
  }
}

/**
 * What the file is missing, without writing anything. A boot at the current
 * version discovers an empty plan and returns before touching the write lock,
 * so a healthy instance starts even while another process is reading the file.
 */
function schemaPlan(schema) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((r) => r.name));
  const indexes = new Map(db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
  ).all().map((r) => [r.name, normalizeSql(r.sql)]));

  const missingTables = schema.tables.filter((t) => !tables.has(t.name)).map((t) => t.name);
  const missingColumns = [];
  for (const [table, expected] of schema.columns) {
    if (!tables.has(table)) continue; // the whole table is in missingTables
    const actual = new Set(db.prepare(`PRAGMA table_xinfo("${table}")`).all().map((c) => c.name));
    for (const col of expected) {
      if (!col.hidden && !actual.has(col.name)) missingColumns.push(`${table}.${col.name}`);
    }
  }
  const staleIndexes = schema.indexes
    .filter((idx) => indexes.get(idx.name) !== normalizeSql(idx.sql))
    .map((idx) => idx.name);
  return { missingTables, missingColumns, staleIndexes };
}

/**
 * Bring this file up to SCHEMA_VERSION: missing tables, additive columns, the
 * versioned steps and the indexes, all in one BEGIN IMMEDIATE … COMMIT.
 *
 * Idempotent (a boot at the current version writes nothing and finds nothing to
 * change), transactional (a failure rolls the whole batch back, so the next
 * start retries from a consistent file). The only row removals are the explicit
 * data repairs declared and tested by the numbered migration steps.
 */
function migrateSchema(schema) {
  const from = readUserVersion();
  if (from > SCHEMA_VERSION) refuseDowngrade(from);

  const planned = schemaPlan(schema);
  if (from === SCHEMA_VERSION
    && !planned.missingTables.length && !planned.missingColumns.length
    && !planned.staleIndexes.length) {
    // A clean, current file still needs the read-only constraint assertions;
    // unlike a migrating file it need not acquire a write lock for them.
    assertSchema(schema);
    return { from, to: from, added: [], applied: [] };
  }

  let added = new Set();
  const applied = [];
  transaction(() => {
    // Re-read under the write lock: a second process (a container restart
    // racing a manual `npm start`, scripts/set-role.js) may have migrated
    // between the check above and this BEGIN IMMEDIATE. The loser waits for
    // the lock, then finds nothing left to do instead of dying on "duplicate
    // column name".
    const at = readUserVersion();
    if (at > SCHEMA_VERSION) refuseDowngrade(at);

    // Tables first (parents before children, as declared), then columns, then
    // the versioned data steps, then indexes: an index may name a column that
    // only exists once a migration has added it, which is why CREATE INDEX is
    // not in the same batch as CREATE TABLE.
    createMissingTables(schema);
    added = syncColumns(schema);

    if (at < SCHEMA_VERSION) {
      const ctx = { from: at, added };
      for (const [version, label, run] of MIGRATIONS) {
        if (version <= at) continue;
        console.log(`[sonora] migrating ${path.basename(config.dbPath)} to schema v${version}: ${label}`);
        run(ctx);
        // Transactional in SQLite: the header write is part of this
        // transaction, so a crash before COMMIT cannot record a version whose
        // work was rolled back.
        db.exec(`PRAGMA user_version = ${version}`);
        applied.push(version);
      }
    }

    syncIndexes(schema);
    // Validate before COMMIT, inside the same transaction as every data and
    // schema change. A late failure (for example a table lacking a constraint
    // that ALTER TABLE cannot add) must roll back destructive migration steps,
    // rebuilt indexes and every user_version update along with the rest.
    assertSchema(schema);
  });

  return { from, to: readUserVersion(), added: [...added], applied };
}

/**
 * The last line of defence. If the file is still missing something the schema
 * declares, say so in one sentence at boot instead of letting the first request
 * that touches the column fail with "no such column" — which looked like a
 * YouTube failure, not a database one.
 *
 * Uniqueness is checked here too, and only here: it cannot be repaired by ALTER
 * TABLE, so a file whose notifications table lacks `UNIQUE (user_id, dedupe)`
 * (or whose artist_follows lost its composite PRIMARY KEY) would otherwise boot
 * happily and just quietly stop deduping — the bell would re-add the same
 * release on every follow poll, with nothing anywhere saying why. Naming the
 * missing constraint turns that into a one-line answer at startup.
 */
function assertSchema(schema) {
  const missing = [];
  for (const [table, expected] of schema.columns) {
    const actual = new Set(db.prepare(`PRAGMA table_xinfo("${table}")`).all().map((c) => c.name));
    const gone = expected.filter((c) => !actual.has(c.name)).map((c) => c.name);
    if (gone.length) missing.push(`${table}(${gone.join(', ')})`);
  }
  for (const [table, expected] of schema.uniques) {
    const actual = new Set(uniqueColumnSets(db, table));
    for (const cols of expected) {
      if (!actual.has(cols)) missing.push(`UNIQUE (${cols.split(',').join(', ')}) on ${table}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `[sonora] ${config.dbPath} does not match the schema this build needs: missing `
      + `${missing.join('; ')}. Back up ./data and start this version once against the file; `
      + 'if it still fails, the file was written by a different release.',
    );
  }
}

// ── prepared statements & transactions ─────────────────────────────────
// node:sqlite compiles the SQL on every prepare(), and this module prepares a
// statement per call — one per play event, one per room read, one per bell
// poll. A prepared statement is immutable, so the compiled form is cached by
// its own SQL text: only SQL written in this file can enter the cache, and
// dynamic SQL (an IN list built from a request body) still goes through
// db.prepare directly.
const statements = new Map();
function stmt(sql) {
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
}

/**
 * Run `fn` as one write transaction. `BEGIN IMMEDIATE` takes the write lock up
 * front — in WAL a deferred transaction that reads first can fail to upgrade
 * when another writer got in between. A nested call joins the outer transaction
 * instead of opening a second one.
 */
let txDepth = 0;
export function transaction(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const out = fn();
    // A promise would be committed here, long before its work ran, and the
    // rollback below could never reach it. Fail loudly instead.
    if (out && typeof out.then === 'function') {
      throw new Error('transaction() needs a synchronous function');
    }
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back */ }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

/**
 * Give the query planner real statistics, once per file.
 *
 * Nothing ever ran ANALYZE, so after a bulk import (the yt-dlp library import,
 * a restored backup, a year of listening) every plan was still built from
 * SQLite's guesses — which is how a table with 900 k rows gets planned as if it
 * had 1000.
 *
 * Deliberately once, not every boot: ANALYZE rewrites sqlite_stat1, and running
 * it at every start would add a full index sweep plus a write to a boot path
 * that otherwise writes nothing at all (see migrateSchema). A file with a
 * populated `plays` or `tracks` and no sqlite_stat1 is exactly "this build has
 * never measured this database", which is the moment the measurement is worth
 * its cost. An empty file is skipped on purpose: analysing it would record
 * "0 rows" for every table and leave the planner reading 0 while the library
 * fills up.
 */
function syncStatistics() {
  const hasStats = db.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
  ).get();
  if (hasStats) return false;
  const hasRows = db.prepare('SELECT EXISTS(SELECT 1 FROM tracks) AS x').get().x
    || db.prepare('SELECT EXISTS(SELECT 1 FROM plays) AS x').get().x;
  if (!hasRows) return false;
  try {
    db.exec('ANALYZE');
    return true;
  } catch (err) {
    // Statistics are an optimisation, not a requirement. A file another process
    // holds the write lock on (a second container, scripts/set-role.js, a `cp`
    // mid-read) must not turn into a failed boot over it — same reasoning as
    // enableWal's warning: keep serving, and the next clean start measures it.
    console.warn(`[sonora] could not measure query planner statistics (${err.message}); `
      + 'booting without them.');
    return false;
  }
}

const OPTIMIZE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Refresh statistics after material growth in a long-lived process.
 *
 * The documented 0x10002 mask also examines tables this connection has not
 * queried yet. This matters: a catalogue can grow by tens of thousands of rows
 * without running a query that makes bare PRAGMA optimize consider it. SQLite
 * still skips tables whose current statistics are useful and bounds the work on
 * enormous files. No invocation happens during import, so a healthy second boot
 * retains its no-write guarantee; the unref'd timer does not keep CLIs alive.
 */
export function optimizeStatistics() {
  if (txDepth > 0) return false;
  try {
    db.exec('PRAGMA optimize=0x10002');
    return true;
  } catch (err) {
    console.warn(`[sonora] could not refresh query planner statistics (${err.message}); `
      + 'continuing with the existing statistics.');
    return false;
  }
}

// The reference shape, then the upgrade itself. Both run before this module
// exports anything, so no request can ever observe a half-migrated file.
const SCHEMA = referenceSchema();
const MIGRATION = migrateSchema(SCHEMA);
if (MIGRATION.applied.length) {
  console.log(`[sonora] schema ${MIGRATION.from} → ${MIGRATION.to} (${config.dbPath})`);
}
// After the migrations, never inside them: ANALYZE writes, and a boot that has
// nothing to migrate must keep writing nothing (a second process may be reading
// the file, and test/migration.test.js asserts the silence).
if (syncStatistics()) console.log(`[sonora] measured the query planner statistics (${config.dbPath})`);
const optimizeTimer = setInterval(optimizeStatistics, OPTIMIZE_INTERVAL_MS);
optimizeTimer.unref();

const SHA = (buf) => crypto.createHash('sha256').update(buf).digest();

function hashPassword(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}

/**
 * A LIKE pattern for a user-supplied needle, with % and _ escaped. Callers pair
 * it with `ESCAPE '\'` (see searchUsers, listTracksForAdmin): a literal "_" in a
 * search box is a character, not "any one character", and without this it
 * matched every row in the table.
 *
 * Only the two admin/host *searches* need this. Prefix deletes on the cache go
 * through cacheDeletePrefix's key range instead — a LIKE there could not use the
 * primary key at all and scanned the whole blob table.
 */
function likeTerm(q) {
  return `%${String(q ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const ROLES = ['user', 'admin'];

export function findUser(name) {
  return stmt('SELECT * FROM users WHERE name = ?').get(name) ?? null;
}

export function getUser(id) {
  return stmt(`
    SELECT id, name, role, disabled, session_version, created_at, last_login_at, last_seen_at
    FROM users WHERE id = ?
  `).get(id) ?? null;
}

export function createUser(name, pass, role = 'user') {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  const salt = crypto.randomBytes(16).toString('hex');
  stmt(`
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

/**
 * Keep users.last_seen_at honest — the admin Users list shows it next to
 * last_login_at, and used to show the same value in both because nothing else
 * ever wrote it. The caller throttles (once per 5 minutes per device), and the
 * WHERE makes the write a no-op when the stored value is already recent, so a
 * second device cannot regress it.
 */
export function touchUserSeen(id, before = new Date(Date.now() - 5 * 60_000).toISOString()) {
  if (!id) return false;
  return db.prepare(`
    UPDATE users SET last_seen_at = ?
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
  `).run(new Date().toISOString(), id, before).changes > 0;
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
  return stmt('SELECT * FROM devices WHERE id = ?').get(id) ?? null;
}

export function findDeviceByClient(userId, clientDeviceId) {
  if (!clientDeviceId) return null;
  return stmt(`
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
    stmt('UPDATE devices SET last_seen_at = ?, last_login_at = ?, last_ip = ? WHERE id = ?')
      .run(nowIso(), nowIso(), ip, id);
  } else {
    stmt('UPDATE devices SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?')
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
  const info = stmt(`
    INSERT INTO refresh_tokens (device_id, user_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(deviceId, userId, tokenHash, nowIso(), expiresAt);
  // The insert already knows the row id; re-reading it by token_hash was a
  // second lookup for something lastInsertRowid hands back for free.
  return { id: Number(info.lastInsertRowid), token, tokenHash, expiresAt };
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
  return stmt('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
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
  return stmt(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE code = ?`).get(code) ?? null;
}

/** Rooms this user hosts, has joined, or has been invited to. */
export function listRoomsForUser(userId, limit = 20) {
  return stmt(`
    WITH visible AS (
      SELECT code FROM rooms WHERE ended_at IS NULL AND host_id = ?
      UNION
      SELECT m.room_code FROM room_members m
      JOIN rooms rx ON rx.code = m.room_code
      WHERE m.user_id = ? AND rx.ended_at IS NULL
      UNION
      SELECT i.room_code FROM room_invites i
      JOIN rooms ri ON ri.code = i.room_code
      WHERE i.user_id = ? AND ri.ended_at IS NULL
    )
    SELECT r.code, r.host_id AS hostId, u.name AS hostName, r.visibility, r.control,
           r.rev, r.created_at AS createdAt, r.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM room_members mm WHERE mm.room_code = r.code) AS members,
           EXISTS(SELECT 1 FROM room_members m2
                   WHERE m2.room_code = r.code AND m2.user_id = ?) AS joined,
           EXISTS(SELECT 1 FROM room_invites i2
                   WHERE i2.room_code = r.code AND i2.user_id = ?) AS invited
    FROM visible v
    JOIN rooms r ON r.code = v.code
    JOIN users u ON u.id = r.host_id
    ORDER BY r.updated_at DESC, r.code LIMIT ?
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
  stmt('UPDATE rooms SET state = ?, rev = ?, updated_at = ? WHERE code = ?')
    .run(JSON.stringify(state), rev, updatedAt, code);
}

/**
 * Commit an accepted command only if the room is still at the revision it was
 * computed against. `updateRoomState` above is unconditional, which is safe
 * inside one process (the guard lives in src/rooms.js) but not across two: two
 * servers could both accept a `next` and advance the room twice. Returns false
 * instead of writing a stale playhead, so the caller can re-read and recompute.
 */
export function updateRoomStateCas(code, { state, rev, expectedRev, updatedAt = new Date().toISOString() }) {
  return stmt('UPDATE rooms SET state = ?, rev = ?, updated_at = ? WHERE code = ? AND rev = ?')
    .run(JSON.stringify(state), rev, updatedAt, code, expectedRev).changes > 0;
}

export function touchRoomRow(code) {
  return stmt('UPDATE rooms SET updated_at = ? WHERE code = ?')
    .run(new Date().toISOString(), code).changes > 0;
}

/** The two enums the rooms table's CHECK-less TEXT columns accept. */
const ROOM_VISIBILITIES = new Set(['public', 'private']);
const ROOM_CONTROLS = new Set(['everyone', 'host']);

/**
 * Change a room's visibility/control policy.
 *
 * Validated here as well as in src/rooms.js: these are enum columns with no
 * CHECK constraint, so one future caller (an admin repair, a migration, a test
 * fixture) writing `privatee` or `anyone` would persist a value every reader
 * then has to guess about — and `host`-only control failing open is a security
 * answer, not a cosmetic one.
 */
export function updateRoomMeta(code, { visibility, control } = {}) {
  const sets = [];
  const values = [];
  if (visibility != null && visibility !== '') {
    if (!ROOM_VISIBILITIES.has(visibility)) {
      throw new Error(`visibility must be public or private, not ${String(visibility)}`);
    }
    sets.push('visibility = ?');
    values.push(visibility);
  }
  if (control != null && control !== '') {
    if (!ROOM_CONTROLS.has(control)) {
      throw new Error(`control must be everyone or host, not ${String(control)}`);
    }
    sets.push('control = ?');
    values.push(control);
  }
  if (!sets.length) return false;
  values.push(new Date().toISOString(), code);
  return db.prepare(`UPDATE rooms SET ${sets.join(', ')}, updated_at = ? WHERE code = ?`)
    .run(...values).changes > 0;
}

/**
 * Move the host seat. Only src/rooms.js's transferHost() calls this: that is
 * where the two rules live (the caller must be the current host, the target must
 * be a member), and repeating the check here would split one authorization rule
 * across two files. updated_at is bumped so a handover is as visible to
 * housekeeping as any other change to the room.
 */
export function setRoomHost(code, hostId) {
  return db.prepare('UPDATE rooms SET host_id = ?, updated_at = ? WHERE code = ?')
    .run(hostId, new Date().toISOString(), code).changes > 0;
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
  return stmt(`
    SELECT m.room_code AS roomCode, m.user_id AS userId, m.role,
           m.joined_at AS joinedAt, m.last_seen_at AS lastSeenAt, u.name
    FROM room_members m JOIN users u ON u.id = m.user_id
    WHERE m.room_code = ? AND m.user_id = ?
  `).get(code, userId) ?? null;
}

/** The roster, oldest demo first with the host pinned to the top. */
export function listRoomMembers(code) {
  return stmt(`
    SELECT m.user_id AS id, u.name, m.role, m.joined_at AS joinedAt, m.last_seen_at AS lastSeenAt
    FROM room_members m JOIN users u ON u.id = m.user_id
    WHERE m.room_code = ?
    ORDER BY (m.role = 'host') DESC, m.joined_at ASC
  `).all(code);
}

export function countRoomMembers(code) {
  return stmt('SELECT COUNT(*) AS n FROM room_members WHERE room_code = ?').get(code).n;
}

export function removeRoomMember(code, userId) {
  return db.prepare('DELETE FROM room_members WHERE room_code = ? AND user_id = ?')
    .run(code, userId).changes > 0;
}

export function touchRoomMember(code, userId) {
  return stmt('UPDATE room_members SET last_seen_at = ? WHERE room_code = ? AND user_id = ?')
    .run(new Date().toISOString(), code, userId).changes > 0;
}

/**
 * The roster's `role` is what the client colours the host chip from and what
 * listRoomMembers sorts on, so a handover has to move it as well as
 * rooms.host_id — otherwise the seat changes and the UI still crowns the old
 * host. Same authorization split as setRoomHost(): the checks live in
 * src/rooms.js's transferHost().
 */
export function setRoomMemberRole(code, userId, role) {
  return db.prepare('UPDATE room_members SET role = ? WHERE room_code = ? AND user_id = ?')
    .run(role, code, userId).changes > 0;
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
  const needle = String(q ?? '').trim();
  const term = likeTerm(needle);
  // ESCAPE: `%` and `_` in what the host typed are literals, not wildcards.
  // Without it a search for "_" matched every account on the instance.
  return db.prepare(`
    SELECT id, name FROM users
    WHERE disabled = 0 AND (? = '' OR name LIKE ? ESCAPE '\\') AND id != COALESCE(?, -1)
    ORDER BY name COLLATE NOCASE LIMIT ?
  `).all(needle, term, excludeId, Math.max(1, Math.min(50, limit)));
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
  // One atomic statement across connections/processes: exactly one racer can
  // receive the deleted row. The old SELECT-then-DELETE let both read the same
  // challenge before either delete, allowing a WebAuthn ceremony replay.
  const row = stmt(`
    DELETE FROM webauthn_challenges WHERE id = ? AND kind = ? RETURNING *
  `).get(id, kind);
  if (!row || row.expires_at < Date.now()) return null;
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
  return transaction(() => {
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
    // The per-user station cache has no foreign key and its key embeds the user
    // id, which SQLite reuses for the next account: a new user could otherwise
    // be served the deleted account's station for up to ten minutes.
    cacheDeletePrefix(`station:${id}:`);
    return info.changes > 0;
  });
}

/**
 * Just the accounts, for callers that only need to iterate the instance.
 *
 * The follow sweep (src/follows.js) needs exactly this: it asks "which users are
 * due a check?" and then does its own per-user query. It used to call
 * listUsersWithStats() for the ids, which meant six aggregates over every user's
 * whole history — COUNT(*) over plays, likes, playlists, devices, passkeys and
 * MAX(created_at) over plays — every 20 minutes, for counts nobody read, on the
 * same synchronous event loop that feeds /api/stream. The cost of the admin
 * dashboard query grows with users × history; this one is a table scan of a table
 * with one row per account.
 */
export function listUserIds() {
  return db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
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
  // ESCAPE: a `_` typed into the admin search is a character, not "any one
  // character" — without it the search matched every track on the instance.
  const like = likeTerm(q);
  // The play/skip counts stay correlated subqueries, and here they are
  // unavoidable: the ORDER BY is `plays DESC`, so ranking the page needs a play
  // count for every track — no index can rank an aggregate — and the LIMIT can
  // only cut the output, not the ranking.
  //
  // What that cost was one probe per track per kind into the *table*, so the fix
  // was to make the probes index-only rather than to reshape the query. Measured
  // on a 600 k-play / 60 k-track file: 277 ms before plays_video_kind, 52 ms
  // after (SCHEMA_SQL). Two rewrites that remove the correlation were tried and
  // both lost to this shape once the index existed — aggregating plays once and
  // joining it back needs a full covering-index scan of plays plus a temp index
  // over every video_id (121 ms; 253 ms against 180 ms at 250 k tracks, 187 ms
  // against 67 ms at 1.2 M plays). The likes count never needed any of this:
  // SQLite evaluates result columns after the sort and the LIMIT, so it runs 100
  // times instead of once per track.
  return db.prepare(`
    SELECT t.video_id AS videoId, t.title, t.channel, t.duration_s AS durationS, t.thumb,
           t.first_seen AS firstSeen, t.last_seen AS lastSeen,
           (SELECT COUNT(*) FROM plays p WHERE p.video_id = t.video_id AND p.kind = 'start') AS plays,
           (SELECT COUNT(*) FROM plays p WHERE p.video_id = t.video_id AND p.kind = 'skip') AS skips,
           (SELECT COUNT(*) FROM likes l WHERE l.video_id = t.video_id) AS likes
    FROM tracks t
    WHERE ? = '' OR t.video_id = ? OR t.title LIKE ? ESCAPE '\\' OR t.channel LIKE ? ESCAPE '\\'
    ORDER BY plays DESC, t.last_seen DESC, t.video_id
    LIMIT ?
  `).all(q, q, like, like, Math.max(1, Math.min(500, limit)));
}

/** Remove a track everywhere: cached audio is removed by the caller. */
export function deleteTrack(videoId) {
  return transaction(() => {
    db.prepare('DELETE FROM playlist_items WHERE video_id = ?').run(videoId);
    db.prepare('DELETE FROM likes WHERE video_id = ?').run(videoId);
    db.prepare('DELETE FROM dislikes WHERE video_id = ?').run(videoId);
    db.prepare('DELETE FROM plays WHERE video_id = ?').run(videoId);
    // The bell used to keep a row for a track that no longer exists, so it
    // opened a dead #/t/<id>. A notification is a pointer, so it goes with it.
    db.prepare('DELETE FROM notifications WHERE video_id = ?').run(videoId);
    const info = db.prepare('DELETE FROM tracks WHERE video_id = ?').run(videoId);
    // A cached station can already contain this track as a recommendation even
    // when that listener has no play/like row yet. Global metadata deletion is
    // rare; evict every station payload rather than leaving an unidentifiable
    // cached copy alive. Ordinary user history/taste deletion stays scoped.
    cacheDeletePrefix('station:');
    return info.changes > 0;
  });
}

/**
 * Delete `tracks` rows nobody references any more.
 *
 * `tracks` is global metadata: a station page or a search upserts every row it
 * renders, so the table grows with what the instance has *looked at*, not with
 * what anyone kept. Nothing ever removed a row except an explicit delete, which
 * means a long-lived install accumulates metadata for tracks that were never
 * played, liked, disliked or added to a playlist — one row per browse, forever.
 *
 * A row is only removable when it is both old (`last_seen` older than
 * `maxAgeMs`, default 180 days) and unreferenced: referencing it is exactly what
 * makes it worth keeping. Deleting metadata is safe for playback — a track that
 * comes back is re-upserted on the next render.
 */
export function pruneStaleTracks(maxAgeMs = 180 * 86_400_000) {
  const age = Number(maxAgeMs);
  if (!Number.isFinite(age) || age < 0) return 0;
  const cutoff = new Date(Date.now() - age).toISOString();
  // `last_seen` is an ISO-8601 UTC stamp, so the string comparison is the date
  // comparison (and can use an index if one is ever added for it).
  return db.prepare(`
    DELETE FROM tracks
    WHERE last_seen < ?
      AND NOT EXISTS (SELECT 1 FROM plays p WHERE p.video_id = tracks.video_id)
      AND NOT EXISTS (SELECT 1 FROM likes l WHERE l.video_id = tracks.video_id)
      AND NOT EXISTS (SELECT 1 FROM dislikes d WHERE d.video_id = tracks.video_id)
      AND NOT EXISTS (SELECT 1 FROM playlist_items i WHERE i.video_id = tracks.video_id)
  `).run(cutoff).changes;
}

export function clearUserHistory(userId) {
  return transaction(() => {
    const removed = db.prepare('DELETE FROM plays WHERE user_id = ?').run(userId).changes;
    cacheDeletePrefix(`station:${userId}:`);
    return removed;
  });
}

/** "Reset my taste": the station evidence and both explicit signals. */
export function clearUserTaste(userId) {
  // One transaction: a reset that half-ran would leave a station built from
  // evidence the user asked to forget.
  return transaction(() => {
    const removed = stmt('DELETE FROM plays WHERE user_id = ?').run(userId).changes
      + stmt('DELETE FROM likes WHERE user_id = ?').run(userId).changes
      + stmt('DELETE FROM dislikes WHERE user_id = ?').run(userId).changes;
    cacheDeletePrefix(`station:${userId}:`);
    return removed;
  });
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

/**
 * Record that a track exists, refreshing what we know about it.
 *
 * The guard in the DO UPDATE is load bearing: rendering a station page or
 * running a search upserts every matched track, and without it each of those
 * *reads* rewrote the row and fsynced a commit — a GET that dirties the disk on
 * the drive this project targets. The row is only touched when the metadata
 * actually differs, or when `last_seen` is older than the hour it is being
 * written in.
 *
 * `last_seen` is therefore an hourly presence signal ("we saw this title in a
 * shelf during this hour"), which is all anything reads it for: it is shown as an
 * "ago" stamp in the admin Tracks panel and is the tiebreak under `plays DESC`;
 * nothing filters or orders by it alone. One hour of staleness there is invisible,
 * and it turns a page that upserts fifty already-known tracks from fifty row
 * rewrites into none. `IS NOT` is used for the comparisons because it is
 * null-safe: with `<>`, a NULL title becoming 'X' compares as NULL, which is
 * falsy, and the update would be skipped.
 */
export function upsertTrack(t) {
  const videoId = typeof t?.videoId === 'string' ? t.videoId.trim() : '';
  if (!videoId) throw new TypeError('upsertTrack needs a non-empty string videoId');
  // duration_s is integer seconds, never NaN/Infinity, a fractional REAL or a
  // negative duration from an untrusted queue. Keep values inside SQLite's exact
  // JavaScript-safe integer range; absent or non-finite metadata means unknown.
  const durationS = Number.isFinite(t?.durationS)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(t.durationS)))
    : null;
  const now = new Date().toISOString();
  stmt(`
    INSERT INTO tracks (video_id, title, channel, channel_id, duration_s, thumb, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      title = COALESCE(excluded.title, tracks.title),
      channel = COALESCE(excluded.channel, tracks.channel),
      channel_id = COALESCE(excluded.channel_id, tracks.channel_id),
      duration_s = COALESCE(excluded.duration_s, tracks.duration_s),
      thumb = COALESCE(excluded.thumb, tracks.thumb),
      last_seen = excluded.last_seen
    WHERE COALESCE(excluded.title, tracks.title) IS NOT tracks.title
       OR COALESCE(excluded.channel, tracks.channel) IS NOT tracks.channel
       OR COALESCE(excluded.channel_id, tracks.channel_id) IS NOT tracks.channel_id
       OR COALESCE(excluded.duration_s, tracks.duration_s) IS NOT tracks.duration_s
       OR COALESCE(excluded.thumb, tracks.thumb) IS NOT tracks.thumb
       OR substr(tracks.last_seen, 1, 13) IS NOT substr(excluded.last_seen, 1, 13)
  `).run(videoId, t.title ?? null, t.channel ?? null, t.channelId ?? null,
    durationS, t.thumb ?? null, now, now);
}

/** Metadata for one known track — used by share links and deep links. */
export function getTrack(videoId) {
  return stmt(`
    SELECT video_id AS videoId, title, channel, duration_s AS durationS, thumb
    FROM tracks WHERE video_id = ?
  `).get(videoId) ?? null;
}

export function recordPlay({ userId, videoId, kind, positionMs = null, durationMs = null, source = null }) {
  stmt(`
    INSERT INTO plays (user_id, video_id, kind, position_ms, duration_ms, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, videoId, kind, positionMs, durationMs, source, new Date().toISOString());
}

export function toggleLike(userId, videoId, on) {
  // One transaction: a like is a delete from the opposite table plus an insert,
  // and a failure between them would leave the track in neither table.
  transaction(() => {
    if (on) {
      // Liking something that was previously disliked is a change of mind; the
      // two tables must never both hold the same track.
      stmt('DELETE FROM dislikes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
      stmt('INSERT OR IGNORE INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)')
        .run(userId, videoId, new Date().toISOString());
    } else {
      stmt('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
      // A withdrawn like must leave the taste model too. The API records the
      // like itself as a play event (kind='like'), and both topArtists() and
      // stationArtists() count those rows — so deleting only the `likes` row
      // left an unlike-able artist with its engagement score intact and its
      // tracks seeding the station forever, until "reset my taste" wiped the
      // whole history. The `likes` table was never the only place a like lives.
      stmt("DELETE FROM plays WHERE user_id = ? AND video_id = ? AND kind = 'like'")
        .run(userId, videoId);
    }
  });
}

/**
 * Mark a track as "less like this", or clear that mark.
 *
 * A dislike is exclusive with a like: you cannot both want a song in your
 * library and never want to hear it.
 */
export function toggleDislike(userId, videoId, on) {
  transaction(() => {
    if (on) {
      stmt('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
      // Same reason as toggleLike(…, false): keeping a like in `likes` and a
      // dislike in `dislikes` is the invariant, but the like *signal* that feeds
      // the taste model is a plays row, and it has to go with it — otherwise
      // "never play this again" leaves the track ranking as a favourite artist.
      stmt("DELETE FROM plays WHERE user_id = ? AND video_id = ? AND kind = 'like'")
        .run(userId, videoId);
      stmt('INSERT OR IGNORE INTO dislikes (user_id, video_id, created_at) VALUES (?, ?, ?)')
        .run(userId, videoId, new Date().toISOString());
    } else {
      stmt('DELETE FROM dislikes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
    }
  });
}

export function listDislikes(userId) {
  return stmt(`
    SELECT d.video_id AS videoId, t.title, t.channel, t.thumb, t.duration_s AS durationS,
           d.created_at AS dislikedAt
    FROM dislikes d LEFT JOIN tracks t ON t.video_id = d.video_id
    WHERE d.user_id = ? ORDER BY d.created_at DESC, d.video_id
  `).all(userId);
}

/** Just the ids — what every generated queue needs to filter against. */
export function dislikedIds(userId) {
  return new Set(stmt('SELECT video_id FROM dislikes WHERE user_id = ?')
    .all(userId).map((r) => r.video_id));
}

export function listLikes(userId) {
  return stmt(`
    SELECT l.video_id AS videoId, t.title, t.channel, t.channel_id AS channelId,
           t.thumb, t.duration_s AS durationS, l.created_at AS likedAt
    FROM likes l LEFT JOIN tracks t ON t.video_id = l.video_id
    WHERE l.user_id = ? ORDER BY l.created_at DESC, l.video_id
  `).all(userId);
}

// ── playlists ───────────────────────────────────────────────────────────

export function listPlaylists(userId) {
  return stmt(`
    SELECT p.id, p.title, p.description, p.art_video AS artVideo, p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS trackCount
    FROM playlists p WHERE p.user_id = ? ORDER BY p.updated_at DESC, p.id DESC
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
  const p = stmt(`
    SELECT id, title, description, art_video AS artVideo, updated_at AS updatedAt
    FROM playlists WHERE id = ? AND user_id = ?
  `).get(id, userId);
  if (!p) return null;
  p.tracks = stmt(`
    SELECT i.video_id AS videoId, t.title, t.channel, t.thumb, t.duration_s AS durationS
    FROM playlist_items i LEFT JOIN tracks t ON t.video_id = i.video_id
    WHERE i.playlist_id = ? ORDER BY i.position
  `).all(id);
  return p;
}

export function addPlaylistItem(userId, playlistId, track) {
  const p = stmt('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!p) return false;
  // One transaction: the next position is read, then used. Without it two adds
  // that interleave compute the same position, and the playlist's order stops
  // being well defined (the primary key hides the collision).
  transaction(() => {
    upsertTrack(track);
    const next = stmt('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM playlist_items WHERE playlist_id = ?')
      .get(playlistId).n;
    stmt(`
      INSERT OR IGNORE INTO playlist_items (playlist_id, video_id, position, added_at) VALUES (?, ?, ?, ?)
    `).run(playlistId, track.videoId, next, new Date().toISOString());
    stmt('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), playlistId);
  });
  return true;
}

export function removePlaylistItem(userId, playlistId, videoId) {
  const p = stmt('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!p) return false;
  transaction(() => {
    stmt('DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?').run(playlistId, videoId);
    stmt('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), playlistId);
  });
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
  return stmt(`
    WITH recent AS (
      SELECT p.video_id AS videoId, MAX(p.created_at) AS at
      FROM plays p
      WHERE p.user_id = ? AND p.kind IN ('start','complete')
      -- Rank and cap the play groups before looking up any track metadata.
      -- The outer ORDER BY is required: a CTE does not guarantee row order.
      GROUP BY p.video_id ORDER BY at DESC, p.video_id LIMIT ?
    )
    SELECT r.videoId, r.at, t.title, t.channel, t.thumb, t.duration_s AS durationS
    FROM recent r LEFT JOIN tracks t ON t.video_id = r.videoId
    ORDER BY r.at DESC, r.videoId
  `).all(userId, limit);
}

/**
 * The artists this user actually listens to, ranked by engagement rather than
 * by a search query. This is what makes the library tab personal: a plain
 * channel search for "music" just returns random small channels.
 */
export function topArtists(userId, limit = 18) {
  return stmt(`
    WITH by_track AS (
      SELECT p.video_id, COUNT(*) AS plays, MAX(p.created_at) AS lastPlayed
      FROM plays p
      WHERE p.user_id = ? AND p.kind IN ('start','complete','like')
      GROUP BY p.video_id
    )
    SELECT t.channel AS title,
           SUM(b.plays) AS plays,
           MAX(b.lastPlayed) AS lastPlayed,
           (SELECT t2.thumb FROM tracks t2
             WHERE t2.channel = t.channel AND t2.thumb IS NOT NULL LIMIT 1) AS thumb
    FROM by_track b
    -- CROSS JOIN is a SQLite join-order constraint, not a Cartesian product:
    -- always reduce this user's plays before probing the global track table.
    -- Stale sqlite_stat1 otherwise chooses tracks_channel first, which is
    -- catastrophic for a user with few or no plays.
    CROSS JOIN tracks t ON t.video_id = b.video_id
    WHERE t.channel IS NOT NULL AND t.channel != ''
    GROUP BY t.channel
    ORDER BY plays DESC, lastPlayed DESC, t.channel
    LIMIT ?
  `).all(userId, limit);
}

/**
 * Read a cached value, or null once it has expired.
 *
 * An expired row is *not* deleted here: this is the read path — a station draw
 * asks for a dozen keys per request — and a write on it (plus its WAL frame and
 * the fsync behind it) for a row the expiry sweep removes anyway is pure cost.
 * `pruneExpiredCache()` owns that deletion, and it runs on the expiry index.
 */
export function cacheGet(key) {
  const row = stmt('SELECT value, expires_at FROM upstream_cache WHERE key = ?').get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function cacheSet(key, value, ttlMs) {
  stmt(`
    INSERT INTO upstream_cache (key, value, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
  `).run(key, JSON.stringify(value), Date.now() + ttlMs);
}

/** Drop a cached value early (e.g. the personal station after a new like). */
export function cacheDelete(key) {
  stmt('DELETE FROM upstream_cache WHERE key = ?').run(key);
}

/**
 * Drop every cached value whose key starts with `prefix`.
 *
 * A range delete, not a LIKE: `upstream_cache.key` is `TEXT PRIMARY KEY`, i.e. a
 * BINARY-collated index, so `key >= 'station:7:' AND key < 'station:7:\uFFFF'` is
 * served by the primary key's range — while `LIKE 'station:7:%'` cannot use it
 * at all (SQLite's LIKE-to-range optimisation needs NOCASE collation or
 * case_sensitive_like, and this database is BINARY with the setting off), so it
 * scanned the whole table including the `value` column that holds ten-minute
 * station payloads and lyrics, evicting the page cache the rest of the app needs.
 *
 * This runs on the hottest write path there is — every completed song, every
 * skip, every like invalidates a station — so that scan was paid per event.
 *
 * `\uFFFF` is the upper bound because it sorts after every character a cache key
 * can contain: the keys are ASCII (`station:<id>:<seed>`, `lyrics:<id>`, …), and
 * no key starts with the sentinel itself. A prefix that did would be excluded,
 * which is why the sentinel is a character no caller here passes.
 */
export function cacheDeletePrefix(prefix) {
  const from = String(prefix);
  return stmt('DELETE FROM upstream_cache WHERE key >= ? AND key < ?')
    .run(from, `${from}\uFFFF`).changes;
}

/**
 * Sweep expired rows. `cacheGet` no longer deletes an expired row it happens to
 * read — a read path must not write — so this is the one owner of that deletion
 * besides the integrity repair. Housekeeping calls it; the expiry index makes it
 * a range delete instead of a full scan, which is why a value nobody asks for
 * again does not live for as long as the process does.
 */
export function pruneExpiredCache(now = Date.now()) {
  return db.prepare('DELETE FROM upstream_cache WHERE expires_at < ?').run(now).changes;
}

/**
 * Drop the per-user station blobs (`station:<user id>:…`) of accounts that no
 * longer exist. They have no foreign key, and SQLite reuses the highest rowid
 * after a delete — so a recycled id could serve a deleted account's station
 * (seeds, queue, "why this station") to somebody new, labelled as their own.
 *
 * `station:` … `station:\uFFFF` is the same prefix range cacheDeletePrefix uses,
 * so the sweep only ever visits station keys instead of every lyrics and
 * catalogue payload in the cache. It cannot narrow further: the user id is
 * embedded in the key and has to be compared against the users table row by row.
 * It does not need to — unlike cacheDeletePrefix this is not on a write path but
 * an hourly sweep, and the rows it walks are one per station per user.
 */
export function pruneOrphanCache() {
  return db.prepare(`DELETE FROM upstream_cache WHERE ${ORPHAN_STATION_CACHE_WHERE}`).run().changes;
}

/**
 * The evidence behind the personal station: how far each track was actually
 * heard, aggregated per track, plus explicit likes.
 *
 * `deepest` is the furthest fraction of a track ever reached, which is the only
 * way to tell "listened to it" from "skipped after 8 seconds" without a model.
 *
 * The aggregate still reads every selected play row so it can rank the groups,
 * but its `LIMIT` is applied inside the CTE: only the surviving rows pay a track
 * metadata lookup. plays_user_kind_video is declared with
 * position_ms/duration_ms for exactly this query, so those aggregate reads are
 * index entries and never table pages — without them the station paid one random
 * page read per play row. test/db.test.js captures and explains this actual
 * statement, rather than a simplified stand-in.
 */
export function stationCandidates(userId, limit = 400) {
  const plays = stmt(`
    WITH candidates AS (
      SELECT p.video_id AS videoId,
             SUM(CASE WHEN p.kind = 'complete' THEN 1 ELSE 0 END) AS completes,
             SUM(CASE WHEN p.kind = 'skip'     THEN 1 ELSE 0 END) AS skips,
             SUM(CASE WHEN p.kind = 'start'    THEN 1 ELSE 0 END) AS starts,
             MAX(CASE WHEN p.duration_ms > 0 AND p.position_ms IS NOT NULL
                      THEN MIN(1.0, CAST(p.position_ms AS REAL) / p.duration_ms)
                      ELSE 0 END) AS deepest,
             MAX(p.created_at) AS lastPlayed
      FROM plays p
      WHERE p.user_id = ? AND p.kind IN ('start','progress','complete','skip')
      GROUP BY p.video_id
      ORDER BY lastPlayed DESC, p.video_id
      LIMIT ?
    )
    SELECT c.videoId, c.completes, c.skips, c.starts, c.deepest, c.lastPlayed,
           t.title, t.channel, t.channel_id AS channelId, t.thumb, t.duration_s AS durationS
    FROM candidates c LEFT JOIN tracks t ON t.video_id = c.videoId
    ORDER BY c.lastPlayed DESC, c.videoId
  `).all(userId, limit);
  return { plays, likes: listLikes(userId) };
}

/**
 * The artists this user keeps coming back to, weighted by how much of each
 * track was heard. Used to pull in more from the same artist, so the station is
 * not limited to songs already in the history.
 */
export function stationArtists(userId, limit = 4) {
  return stmt(`
    WITH by_track AS (
      SELECT p.video_id, COUNT(*) AS plays
      FROM plays p
      WHERE p.user_id = ? AND p.kind IN ('complete','like')
      GROUP BY p.video_id
    )
    SELECT t.channel AS name, SUM(b.plays) AS plays
    FROM by_track b
    -- As in topArtists, the CROSS JOIN pins the selective play aggregate before
    -- the metadata lookup even when global planner statistics are stale.
    CROSS JOIN tracks t ON t.video_id = b.video_id
    WHERE t.channel IS NOT NULL AND t.channel != ''
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

/**
 * Stop following an artist.
 *
 * When this was the artist's last follower, the release bookkeeping for that
 * artist goes too: `artist_releases` and `artist_release_state` are keyed by
 * artist, not by user, so nothing else ever removes them — an unfollowed artist
 * used to leave a permanent row set (and, worse, an "initialized" marker that
 * would make a future follower's first sweep silent).
 */
export function unfollowArtist(userId, artistId) {
  return transaction(() => {
    const removed = db.prepare('DELETE FROM artist_follows WHERE user_id = ? AND artist_id = ?')
      .run(userId, artistId).changes > 0;
    if (!removed) return false;
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM artist_follows WHERE artist_id = ?')
      .get(artistId).n;
    if (remaining === 0) {
      db.prepare('DELETE FROM artist_releases WHERE artist_id = ?').run(artistId);
      db.prepare('DELETE FROM artist_release_state WHERE artist_id = ?').run(artistId);
    }
    return true;
  });
}

export function listFollows(userId) {
  return stmt(`
    SELECT artist_id AS artistId, name, thumb,
           created_at AS since, last_checked_at AS lastCheckedAt
    FROM artist_follows WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

export function isFollowing(userId, artistId) {
  if (!userId || !artistId) return false;
  return Boolean(stmt('SELECT 1 AS x FROM artist_follows WHERE user_id = ? AND artist_id = ?')
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
 *
 * Global and purely oldest-first: every user's failure pushes an artist around
 * for everybody. New callers should use followSweepDue(userId) instead.
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
    ORDER BY lastCheckedAt ASC, artist_id
    LIMIT ?
  `).all(Math.max(1, Math.min(50, limit)));
}

/**
 * Record what one follower's sweep attempt did to one artist.
 *
 * Always stamps `last_attempt_at` — that is the fact the backoff is measured
 * from, and a failure must not be invisible. On success it also clears
 * `fail_count` and stamps `last_checked_at` ("we looked and found nothing new");
 * on failure `last_checked_at` is deliberately left alone, because nothing was
 * checked and the artist is still owed a real look.
 *
 * `at` is injectable so tests (and a sweep replaying a fixed timestamp) can
 * exercise the backoff ladder without sleeping.
 */
export function markFollowAttempt(userId, artistId, { ok, at = new Date().toISOString() } = {}) {
  if (!userId || !artistId) return false;
  if (ok) {
    return stmt(`
      UPDATE artist_follows
      SET last_attempt_at = ?, last_checked_at = ?, fail_count = 0
      WHERE user_id = ? AND artist_id = ?
    `).run(at, at, userId, artistId).changes > 0;
  }
  return stmt(`
    UPDATE artist_follows
    SET last_attempt_at = ?, fail_count = COALESCE(fail_count, 0) + 1
    WHERE user_id = ? AND artist_id = ?
  `).run(at, userId, artistId).changes > 0;
}

/**
 * One user's artists that are due for a check, worst-failing last.
 *
 * Ordering is `fail_count ASC, last_attempt_at ASC`, so a healthy artist (or one
 * that has never been tried) always comes before an artist that has failed once,
 * and an artist that keeps failing falls to the back instead of occupying the
 * front of the queue forever — which is what the strictly oldest-first sweep
 * did (a few dead channels could starve every healthy artist indefinitely).
 *
 * A row whose backoff has not expired is skipped. The ladder is exponential and
 * capped at a day, measured from `last_attempt_at`:
 *
 *   fail_count: 1 → 1 h, 2 → 2 h, 3 → 4 h, 4 → 8 h, 5 → 16 h, 6+ → 24 h
 *
 * fail_count 0 means "due immediately" (never tried, or the last attempt
 * succeeded), which is why a healthy artist is never delayed by this.
 */
export function followSweepDue(userId, limit = 4, now = new Date().toISOString()) {
  if (!userId) return [];
  return db.prepare(`
    SELECT artist_id        AS artistId,
           name,
           thumb,
           fail_count       AS failCount,
           last_attempt_at  AS lastAttemptAt,
           last_checked_at  AS lastCheckedAt,
           (SELECT COUNT(*) FROM artist_follows f2
             WHERE f2.artist_id = artist_follows.artist_id) AS followers
    FROM artist_follows
    WHERE user_id = ?
      AND (
        fail_count <= 0
        OR last_attempt_at IS NULL
        -- MIN(24, 2^(n-1)) hours, as a fraction of a day. fail_count is
        -- clamped to 6 before the shift so a large counter cannot overflow it
        -- into "backoff 0" and make a hopeless artist due again immediately.
        OR julianday(?) - julianday(last_attempt_at)
             >= MIN(24.0, (1 << (MIN(fail_count, 6) - 1))) / 24.0
      )
    ORDER BY fail_count ASC, COALESCE(last_attempt_at, '') ASC, artist_id
    LIMIT ?
  `).all(userId, now, Math.max(1, Math.min(50, limit)));
}

/** Everyone who follows an artist — the fan-out target of a fresh release. */
export function listArtistFollowers(artistId) {
  return stmt(`
    SELECT user_id AS userId, name, thumb FROM artist_follows WHERE artist_id = ?
  `).all(artistId);
}

export function knownReleases(artistId) {
  return stmt(`
    SELECT release_id AS releaseId, title, kind, year, thumb
    FROM artist_releases WHERE artist_id = ?
  `).all(artistId);
}

/** Has at least one catalogue read for this artist completed successfully? */
export function artistReleaseInitialized(artistId) {
  return Boolean(stmt('SELECT 1 AS initialized FROM artist_release_state WHERE artist_id = ?')
    .get(artistId));
}

/** Preserve the first successful initialization; later reads only add releases. */
export function markArtistReleaseInitialized(artistId, at = new Date().toISOString()) {
  return stmt(`
    INSERT INTO artist_release_state (artist_id, initialized_at) VALUES (?, ?)
    ON CONFLICT(artist_id) DO NOTHING
  `).run(artistId, at).changes > 0;
}

/** Record what an artist has released. Existing rows are left alone: the first
 *  sighting is the one that matters, and re-recording must never count as new. */
export function recordReleases(artistId, releases) {
  const now = new Date().toISOString();
  const insert = stmt(`
    INSERT OR IGNORE INTO artist_releases
      (artist_id, release_id, title, kind, year, thumb, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // transaction() rather than a raw BEGIN: it joins an outer transaction
  // instead of starting a second one, which used to roll the outer work back.
  return transaction(() => {
    let added = 0;
    for (const r of releases ?? []) {
      if (!r?.releaseId) continue;
      added += insert.run(artistId, r.releaseId, r.title ?? null, r.kind ?? null,
        r.year ?? null, r.thumb ?? null, now).changes;
    }
    return added;
  });
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
  return stmt(`
    SELECT id, kind, title, body, thumb, url,
           artist_id AS artistId, artist_name AS artistName, video_id AS videoId,
           created_at AS createdAt, read_at AS readAt
    FROM notifications WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, Math.max(1, Math.min(100, limit)));
}

export function countUnread(userId) {
  return stmt('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId).n;
}

/** Only the caller's own rows can be marked, whatever ids a client sends. */
export function markNotificationsRead(userId, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    // A JSON body can carry anything; only a positive integer can be an id.
    .map((id) => (typeof id === 'number' || typeof id === 'string' ? Number(id) : Number.NaN))
    .filter((id) => Number.isInteger(id) && id > 0)
    // A body with 40 000 ids used to build a megabyte of SQL and then fail with
    // "too many SQL variables" (a 500). A user has ~200 notifications at most,
    // so anything beyond this cap is noise.
    .slice(0, 500);
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
 *
 * Called from the hourly sweep in src/server.js, not only at boot: this is a
 * service that can stay up for months, so "once, at the next restart" meant
 * never.
 *
 * The predicate is written `created_at < ?` first, collapsing the two windows
 * into one range, because that is what lets notifications_created serve it. The
 * original form `(read_at IS NOT NULL AND created_at < ?) OR created_at < ?` is
 * an OR of two terms and neither one is independently indexable (read_at has no
 * index of its own; notifications_unread is partial on read_at IS NULL), so
 * SQLite scanned the table. Since the unread window is the *longer* one, "older
 * than the long window" wins regardless of read_at, and everything inside it
 * must additionally have been read. Same rows, one index range.
 */
export function pruneNotifications(days = 60) {
  const readCutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const unreadCutoff = new Date(Date.now() - days * 2 * 86_400_000).toISOString();
  return db.prepare(`
    DELETE FROM notifications
    WHERE created_at < ? AND (read_at IS NOT NULL OR created_at < ?)
  `).run(readCutoff, unreadCutoff).changes;
}

/**
 * Retention for the play log: delete the *write-only* kinds older than
 * `maxAgeDays` and report how many rows went.
 *
 * `plays` is the table that grows without limit (~80 k rows a year for a heavy
 * listener) and every station build and library page scans a slice of it, but it
 * is also the taste signal, so it must not be pruned wholesale. The split is by
 * kind, not by age:
 *
 *   - 'start' | 'complete' | 'skip' are read back by recentlyPlayed(), the
 *     station and the admin Tracks counts, and they are the history the user
 *     would notice missing, so they are never deleted here.
 *   - 'progress' is a periodic heartbeat written while a track plays. Only
 *     stationCandidates() reads it, and only for its "deepest fraction heard"
 *     column — a track with no progress rows still appears (its start/complete/
 *     skip rows are what put it in the list), it just stops contributing extra
 *     depth. An old heartbeat is therefore the cheapest thing in the table to
 *     retire.
 *   - 'unlike' | 'dislike' | 'undislike' were written by older builds to record
 *     the act of withdrawing a like or disliking a track. No query in this
 *     codebase reads them — the state they describe already lives in the
 *     `dislikes` table and in the absence of a `likes` row — so they are pure
 *     growth. Deleting them changes no answer the app can give.
 *
 * The sweep runs from the hourly housekeeping in src/server.js; the default
 * window is long enough that a debugging session looking at last month's play
 * log still finds everything it expects.
 */
export function prunePlays(maxAgeDays = 90) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  return db.prepare(`
    DELETE FROM plays
    WHERE kind IN ('progress','unlike','dislike','undislike') AND created_at < ?
  `).run(cutoff).changes;
}

// ── integrity ───────────────────────────────────────────────────────────
// The schema declares real foreign keys and every cascade fires — but three
// things can still rot: a row written while `PRAGMA foreign_keys` was off (a
// hand edit, a sqlite3 session, a build that forgot it), a per-user cache key
// whose user id was reused by a newer account, and the like/dislike
// contradictions migration 2 repairs. Read-only check, then the repair.

/** References whose orphaned child rows have no meaning and can be deleted. */
const ORPHAN_RULES = [
  ['plays', 'user_id', 'users', 'id'],
  ['likes', 'user_id', 'users', 'id'],
  ['dislikes', 'user_id', 'users', 'id'],
  ['player_state', 'user_id', 'users', 'id'],
  ['playlists', 'user_id', 'users', 'id'],
  ['playlist_items', 'playlist_id', 'playlists', 'id'],
  ['devices', 'user_id', 'users', 'id'],
  ['refresh_tokens', 'device_id', 'devices', 'id'],
  ['refresh_tokens', 'user_id', 'users', 'id'],
  ['passkeys', 'user_id', 'users', 'id'],
  ['rooms', 'host_id', 'users', 'id'],
  ['room_members', 'room_code', 'rooms', 'code'],
  ['room_members', 'user_id', 'users', 'id'],
  ['room_invites', 'room_code', 'rooms', 'code'],
  ['room_invites', 'user_id', 'users', 'id'],
  ['artist_follows', 'user_id', 'users', 'id'],
  ['notifications', 'user_id', 'users', 'id'],
  ['webauthn_challenges', 'user_id', 'users', 'id'],
];

/** Nullable authorship references: repair the pointer, not the invited access. */
const SET_NULL_RULES = [
  ['room_invites', 'invited_by', 'users', 'id'],
];

function orphanWhere(table, column, parent, key) {
  return `${column} IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ${parent} p WHERE p.${key} = ${table}.${column}
  )`;
}

/** Every dangling reference, with a row count. Empty means clean. */
export function findOrphans() {
  const out = [];
  for (const [table, column, parent, key] of [...ORPHAN_RULES, ...SET_NULL_RULES]) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}
      WHERE ${orphanWhere(table, column, parent, key)}`).get();
    if (n) out.push({ table, column, parent, rows: n });
  }
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM upstream_cache
    WHERE ${ORPHAN_STATION_CACHE_WHERE}`).get();
  if (n) out.push({ table: 'upstream_cache', column: 'key', parent: 'users', rows: n });
  return out;
}

/**
 * Repair rows that point at something which no longer exists. Child rows whose
 * owner vanished are deleted; nullable authorship is set to NULL so an invite
 * survives whoever invited them. Orphan station blobs go too. One transaction,
 * so a partial cleanup cannot leave a worse shape than it found.
 */
export function pruneOrphans() {
  return transaction(() => {
    const repaired = [];
    for (const [table, column, parent, key] of SET_NULL_RULES) {
      const { changes } = db.prepare(`UPDATE ${table} SET ${column} = NULL
        WHERE ${orphanWhere(table, column, parent, key)}`).run();
      if (changes) repaired.push({ table, column, parent, rows: changes });
    }
    for (const [table, column, parent, key] of ORPHAN_RULES) {
      const { changes } = db.prepare(`DELETE FROM ${table}
        WHERE ${orphanWhere(table, column, parent, key)}`).run();
      if (changes) repaired.push({ table, column, parent, rows: changes });
    }
    const staleCache = pruneOrphanCache();
    if (staleCache) {
      repaired.push({ table: 'upstream_cache', column: 'key', parent: 'users', rows: staleCache });
    }
    if (repaired.length) {
      console.log(`[sonora] repaired ${repaired.reduce((n, r) => n + r.rows, 0)} orphan row(s)`);
    }
    return repaired;
  });
}

/**
 * One-call health check for the admin storage panel and the tests: SQLite's own
 * quick_check, the declared foreign keys, the like/dislike invariant, the
 * dangling references above, and the per-user cache rows of deleted accounts.
 */
export function integrityReport() {
  const quick = db.prepare('PRAGMA quick_check').get();
  const quickCheck = String(Object.values(quick ?? {})[0] ?? 'unknown');
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  const likeDislikeConflicts = db.prepare(`
    SELECT COUNT(*) AS n FROM likes l JOIN dislikes d
      ON d.user_id = l.user_id AND d.video_id = l.video_id
  `).get().n;
  const orphans = findOrphans();
  const orphanStationCache = orphans
    .find((o) => o.table === 'upstream_cache' && o.column === 'key')?.rows ?? 0;
  const schema = schemaStatus();
  return {
    ok: quickCheck === 'ok' && foreignKeyViolations === 0
      && likeDislikeConflicts === 0 && orphans.length === 0
      && orphanStationCache === 0 && schema.current,
    quickCheck,
    foreignKeyViolations,
    likeDislikeConflicts,
    orphans,
    orphanStationCache,
    schemaVersion: schema.version,
    schemaExpected: schema.expected,
  };
}

export function bootstrapUser() {
  // One transaction around the read-then-insert: two processes starting
  // together (a container restart racing `npm start`) both saw "no users" and
  // one died on `UNIQUE constraint failed: users.name` — with docker then
  // restarting it into the same state. BEGIN IMMEDIATE serialises them.
  return transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
    if (!config.bootstrapPass) {
      console.warn('[sonora] no users yet and SONORA_PASSPHRASE unset — login is impossible until you set it');
      return null;
    }
    // INSERT OR IGNORE so an account created between the count and this insert
    // by another process is a no-op instead of a crash.
    const salt = crypto.randomBytes(16).toString('hex');
    const info = db.prepare(`
      INSERT INTO users (name, pass_hash, salt, role, created_at)
      VALUES (?, ?, ?, 'admin', ?)
      ON CONFLICT(name) DO NOTHING
    `).run(config.bootstrapUser, hashPassword(config.bootstrapPass, salt), salt,
      new Date().toISOString());
    if (info.changes === 0) return null;
    // The first account is the instance owner, so it is an admin by
    // construction. Other admins are assigned in the database (see
    // scripts/set-role.js).
    console.log(`[sonora] created bootstrap admin "${config.bootstrapUser}"`);
    return findUser(config.bootstrapUser);
  });
}

export { SHA };
