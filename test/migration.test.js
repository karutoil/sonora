import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// The admin role was added after the first instances existed, so the upgrade
// path matters as much as the fresh-install path: an old database has no
// `users.role` column, and `CREATE TABLE IF NOT EXISTS` will never add one.
// The same is true of every column added since a release shipped, which is why
// the fix is a versioned migration (PRAGMA user_version) rather than five
// hand-written ALTERs. A migration bug here would either crash the server on
// boot, lose rows, or lock the owner out of the admin surface.
//
// These tests drive real processes against real files: db.js opens its database
// at import time, and the whole point is what happens to a file that already
// exists.

const ROOT = new URL('..', import.meta.url).pathname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-migration-'));

/** Build a database with the schema as it existed before the admin role. */
function makeLegacyDb(file, users) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      pass_hash  TEXT NOT NULL,
      salt       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE plays (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      video_id    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      position_ms INTEGER,
      duration_ms INTEGER,
      source      TEXT,
      created_at  TEXT NOT NULL
    );
  `);
  for (const name of users) {
    db.prepare('INSERT INTO users (name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
      .run(name, '00', '00', new Date().toISOString());
  }
  db.close();
}

/**
 * Run a snippet against db.js in its own process (db.js opens its database at
 * import time, so a shared process would pin one file). Output is read from a
 * marker line, because db.js logs to stdout as well.
 */
function runRaw(file, code, env = {}) {
  return spawnSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, SONORA_DB: file, SONORA_SECRET: 'migration-test', ...env },
    encoding: 'utf8',
  });
}

function run(file, code, env = {}) {
  const res = runRaw(file, code, env);
  assert.equal(res.status, 0, `child failed:\n${res.stdout}\n${res.stderr}`);
  const line = res.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `no @@ marker in output:\n${res.stdout}`);
  return line.slice(2).trim();
}

/** The version marker a file carries, read without importing db.js. */
function userVersion(file) {
  const db = new DatabaseSync(file);
  try {
    return Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  } finally {
    db.close();
  }
}

test('an existing database gains the role columns on boot', () => {
  const file = path.join(TMP, 'legacy.db');
  makeLegacyDb(file, ['owner', 'friend']);

  const out = run(file, `
    const db = await import('./src/db.js');
    const cols = db.db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const users = db.db.prepare('SELECT name, role, disabled FROM users ORDER BY id').all();
    console.log('@@' + JSON.stringify({ cols, users }));
  `);
  const { cols, users } = JSON.parse(out);

  for (const col of ['role', 'disabled', 'session_version', 'last_login_at', 'last_seen_at']) {
    assert.ok(cols.includes(col), `users.${col} was added`);
  }
  // The oldest account is the one that ran the bootstrap, so it becomes admin.
  assert.equal(users[0].role, 'admin', 'first account is promoted on upgrade');
  assert.equal(users[1].role, 'user');
  assert.equal(users[0].disabled, 0);
});

test('booting twice does not re-run the promotion', () => {
  const file = path.join(TMP, 'twice.db');
  makeLegacyDb(file, ['owner', 'friend']);

  run(file, `await import('./src/db.js'); console.log('@@boot');`);
  const out = run(file, `
    const db = await import('./src/db.js');
    db.setUserRole(db.findUser('owner').id, 'user');
    db.setUserRole(db.findUser('friend').id, 'admin');
    console.log('@@' + db.countAdmins());
  `);
  assert.equal(out, '1');

  // A third boot must leave the deliberate role assignment alone.
  const roles = JSON.parse(run(file, `
    const db = await import('./src/db.js');
    console.log('@@' + JSON.stringify(db.listUsersWithStats().map((u) => [u.name, u.role])));
  `));
  assert.deepEqual(roles, [['owner', 'user'], ['friend', 'admin']]);
});

test('v1 promotes the owner even when a restored file already has users.role', () => {
  const file = path.join(TMP, 'existing-role.db');
  makeLegacyDb(file, ['owner', 'friend']);
  const before = new DatabaseSync(file);
  before.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  before.close();
  assert.equal(userVersion(file), 0);

  const got = JSON.parse(run(file, `
    const db = await import('./src/db.js');
    console.log('@@' + JSON.stringify(db.db.prepare(
      'SELECT name, role FROM users ORDER BY id'
    ).all()));
  `));
  assert.deepEqual(got, [{ name: 'owner', role: 'admin' }, { name: 'friend', role: 'user' }]);
});

test('a pre-role session cookie still works after the upgrade', () => {
  const file = path.join(TMP, 'session.db');
  makeLegacyDb(file, ['owner']);

  // Tokens issued before session_version existed carry no `ver` claim; the
  // migration default of 1 must keep them valid instead of signing everyone out.
  const out = run(file, `
    const db = await import('./src/db.js');
    const u = db.findUser('owner');
    const tok = db.signSession({ uid: u.id, exp: Date.now() + 60000 });
    console.log('@@' + JSON.stringify({ version: db.getUser(u.id).session_version, tok }));
  `);
  const { version, tok } = JSON.parse(out);
  assert.equal(version, 1);

  const verdict = run(file, `
    const db = await import('./src/db.js');
    const payload = db.readSession(${JSON.stringify(tok)});
    const row = db.db.prepare('SELECT session_version FROM users WHERE id = ?').get(payload.uid);
    console.log('@@' + JSON.stringify({ uid: payload.uid, match: (payload.ver ?? 1) === row.session_version }));
  `);
  assert.deepEqual(JSON.parse(verdict), { uid: 1, match: true });
});

test('the bootstrap account is an admin on a brand-new database', () => {
  const file = path.join(TMP, 'fresh.db');
  const out = run(file, `
    const db = await import('./src/db.js');
    db.bootstrapUser();
    console.log('@@' + JSON.stringify(db.listUsersWithStats().map((u) => [u.name, u.role])));
  `, { SONORA_PASSPHRASE: 'hunter2hunter2' });
  assert.deepEqual(JSON.parse(out), [['toil', 'admin']]);
});

// ── the migration mechanism ─────────────────────────────────────────────

/** A database from before `tracks.channel_id` existed, with real rows in it. */
function makeOldTracksDb(file, tracks) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      pass_hash  TEXT NOT NULL,
      salt       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tracks (
      video_id   TEXT PRIMARY KEY,
      title      TEXT,
      channel    TEXT,
      duration_s INTEGER,
      thumb      TEXT,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO users (name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run('owner', '00', '00', new Date().toISOString());
  const now = new Date().toISOString();
  for (const t of tracks) {
    db.prepare(`
      INSERT INTO tracks (video_id, title, channel, duration_s, thumb, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(t.videoId, t.title, t.channel, t.duration, null, now, now);
  }
  db.close();
}

test('a database from before a column existed gains it, keeps its rows, and records the version', () => {
  const file = path.join(TMP, 'old-tracks.db');
  makeOldTracksDb(file, [
    { videoId: 'old00000001', title: 'Old One', channel: 'Radiohead', duration: 200 },
    { videoId: 'old00000002', title: 'Old Two', channel: 'Portishead', duration: 180 },
  ]);
  assert.equal(userVersion(file), 0, 'the legacy file carries no version marker');

  const out = run(file, `
    const db = await import('./src/db.js');
    const cols = db.db.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
    const tracks = db.db.prepare('SELECT video_id AS videoId, title, duration_s AS durationS FROM tracks ORDER BY video_id').all();
    const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    const users = db.db.prepare('SELECT name, role FROM users ORDER BY id').all();
    // The write that used to answer 500 ("no such column: channel_id").
    db.upsertTrack({ videoId: 'new00000001', title: 'New', channel: 'Bjork', channelId: 'UC-new', durationS: 210 });
    const written = db.getTrack('new00000001');
    console.log('@@' + JSON.stringify({
      cols, tracks, indexes, users, written,
      version: db.schemaStatus(),
      fk: db.db.prepare('PRAGMA foreign_key_check').all().length,
    }));
  `);
  const got = JSON.parse(out);

  // The column that made every search 500 before is there now...
  assert.ok(got.cols.includes('channel_id'), 'tracks.channel_id was added');
  // ...and an index declared over it (tracks_channel) exists too.
  assert.ok(got.indexes.includes('tracks_channel'), 'indexes are created after the column migration');
  assert.ok(got.indexes.includes('likes_video'), 'the newer indexes reach an old database');
  // Non-destructive: the rows the user had are untouched.
  assert.deepEqual(got.tracks, [
    { videoId: 'old00000001', title: 'Old One', durationS: 200 },
    { videoId: 'old00000002', title: 'Old Two', durationS: 180 },
  ]);
  // The statement that answered 500 before the migration now works.
  assert.deepEqual(got.written, {
    videoId: 'new00000001', title: 'New', channel: 'Bjork', durationS: 210, thumb: null,
  });
  // The old migration still runs as a numbered step, and promotes the owner.
  assert.deepEqual(got.users, [{ name: 'owner', role: 'admin' }]);
  // The version marker and referential integrity both hold afterwards.
  assert.equal(got.version.version, got.version.expected);
  assert.equal(got.version.current, true);
  assert.equal(userVersion(file), got.version.expected);
  assert.equal(got.fk, 0);
});

test('an existing follows table gains the sweep columns, keeping its rows', () => {
  const file = path.join(TMP, 'old-follows.db');
  // The shape `artist_follows` had before the sweep grew its own bookkeeping.
  const before = new DatabaseSync(file);
  before.exec(`
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      pass_hash  TEXT NOT NULL,
      salt       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE artist_follows (
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      artist_id       TEXT NOT NULL,
      name            TEXT,
      thumb           TEXT,
      created_at      TEXT NOT NULL,
      last_checked_at TEXT,
      PRIMARY KEY (user_id, artist_id)
    );
  `);
  before.prepare('INSERT INTO users (name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run('owner', '00', '00', new Date().toISOString());
  const inserted = before.prepare(`
    INSERT INTO artist_follows (user_id, artist_id, name, thumb, created_at, last_checked_at)
    VALUES (1, ?, ?, NULL, ?, ?)
  `);
  inserted.run('UColdfollow1', 'Old One', '2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z');
  inserted.run('UColdfollow2', 'Old Two', '2025-01-02T00:00:00.000Z', null);
  before.close();

  const out = run(file, `
    const db = await import('./src/db.js');
    const cols = db.db.prepare('PRAGMA table_info(artist_follows)').all().map((c) => c.name);
    const rows = db.db.prepare(\`
      SELECT artist_id AS artistId, last_checked_at AS lastCheckedAt,
             last_attempt_at AS lastAttemptAt, fail_count AS failCount
      FROM artist_follows ORDER BY artist_id\`).all();
    const due = db.followSweepDue(1, 10);
    const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    console.log('@@' + JSON.stringify({ cols, rows, due, indexes, version: db.schemaStatus() }));
  `);
  const got = JSON.parse(out);

  assert.ok(got.cols.includes('last_attempt_at'), 'artist_follows.last_attempt_at was added');
  assert.ok(got.cols.includes('fail_count'), 'artist_follows.fail_count was added');
  // Existing rows are untouched apart from the new columns' defaults.
  assert.deepEqual(got.rows, [
    { artistId: 'UColdfollow1', lastCheckedAt: '2025-06-01T00:00:00.000Z', lastAttemptAt: null, failCount: 0 },
    { artistId: 'UColdfollow2', lastCheckedAt: null, lastAttemptAt: null, failCount: 0 },
  ]);
  // A restored follow is due immediately and can be attempted.
  assert.equal(got.due.length, 2);
  assert.ok(got.indexes.includes('artist_follows_sweep'));
  assert.equal(got.version.version, got.version.expected);
  assert.equal(got.version.expected, 4);
});

test('v4 rounds real releases and empty markers into durable initialization state', () => {
  const file = path.join(TMP, 'release-state.db');
  const realArtist = 'UCmigrationRealArtist0001';
  const emptyArtist = 'UCmigrationEmptyArtist001';
  run(file, `await import('./src/db.js'); console.log('@@create');`);
  const before = new DatabaseSync(file);
  before.exec('DROP TABLE artist_release_state; PRAGMA user_version = 3');
  const insert = before.prepare(`
    INSERT INTO artist_releases (artist_id, release_id, title, kind, first_seen)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run(realArtist, 'MPRexisting0001', 'Existing', 'album', '2020-01-01T00:00:00.000Z');
  insert.run(emptyArtist, '__sonora_initialized_empty_v1__', null, null, '2021-02-03T04:05:06.000Z');
  before.close();

  const got = JSON.parse(run(file, `
    const db = await import('./src/db.js');
    const user = db.createUser('migration-owner', 'pw');
    db.followArtist(user.id, { artistId: ${JSON.stringify(emptyArtist)}, name: 'Empty Artist' });
    console.log('@@' + JSON.stringify({
      schema: db.schemaStatus(),
      state: db.db.prepare(
        'SELECT artist_id AS artistId, initialized_at AS initializedAt FROM artist_release_state ORDER BY artist_id'
      ).all(),
      markers: db.db.prepare(
        "SELECT COUNT(*) AS n FROM artist_releases WHERE release_id = '__sonora_initialized_empty_v1__'"
      ).get().n,
      real: db.knownReleases(${JSON.stringify(realArtist)}),
      empty: db.knownReleases(${JSON.stringify(emptyArtist)}),
    }));
  `));
  assert.deepEqual(got.schema, { version: 4, expected: 4, current: true });
  assert.equal(got.markers, 0);
  assert.equal(got.real.length, 1);
  assert.equal(got.real[0].releaseId, 'MPRexisting0001');
  assert.deepEqual(got.empty, []);
  assert.deepEqual(got.state, [
    { artistId: emptyArtist, initializedAt: '2021-02-03T04:05:06.000Z' },
    { artistId: realArtist, initializedAt: '2020-01-01T00:00:00.000Z' },
  ]);

  // Replaying the current-version boot must not repeat the data move.
  const stable = fs.readFileSync(file);
  const replay = runRaw(file, `await import('./src/db.js'); console.log('@@stable');`);
  assert.equal(replay.status, 0, replay.stderr);
  assert.ok(!/migrating .* to schema v4/.test(replay.stdout));
  assert.ok(stable.equals(fs.readFileSync(file)));

  // The state is not merely storage: the next real catalogue item is news for
  // the existing follower after a marker-only artist is migrated.
  const next = JSON.parse(run(file, `
    const db = await import('./src/db.js');
    const { checkArtist } = await import('./src/follows.js');
    const result = await checkArtist(${JSON.stringify(emptyArtist)}, {
      page: async () => ({
        name: 'Empty Artist', singles: [{ id: 'MPRfirstAfterEmpty', title: 'First', type: 'Single' }], albums: [],
      }),
    });
    console.log('@@' + JSON.stringify({
      fresh: result.fresh.map((r) => r.releaseId), created: result.created,
      notifications: db.listNotifications(db.findUser('migration-owner').id).map((n) => n.title),
    }));
  `));
  assert.deepEqual(next, { fresh: ['MPRfirstAfterEmpty'], created: 1, notifications: ['First'] });
});

test('a second boot applies nothing and writes nothing', () => {
  const file = path.join(TMP, 'idempotent.db');
  makeOldTracksDb(file, [{ videoId: 'idem0000001', title: 'Keep', channel: 'A', duration: 100 }]);
  run(file, `await import('./src/db.js'); console.log('@@first');`);
  const version = userVersion(file);
  const before = fs.readFileSync(file);

  const res = runRaw(file, `
    const db = await import('./src/db.js');
    console.log('@@' + JSON.stringify({
      version: db.schemaStatus(),
      tracks: db.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,
    }));
  `);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!/migrating .* to schema v/.test(res.stdout), `nothing left to migrate:\n${res.stdout}`);
  assert.ok(!/migrated schema: (added|created|rebuilt)/.test(res.stdout), `no schema writes:\n${res.stdout}`);
  assert.ok(!/measured the query planner statistics/.test(res.stdout), 'existing statistics are not rebuilt on boot');
  const got = JSON.parse(res.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.equal(got.version.version, version);
  assert.equal(got.tracks, 1);
  assert.ok(before.equals(fs.readFileSync(file)), 'the second boot leaves every database byte unchanged');
});

test('periodic optimization refreshes statistics after real catalogue growth', () => {
  const file = path.join(TMP, 'statistics-growth.db');
  makeOldTracksDb(file, Array.from({ length: 2000 }, (_, i) => ({
    videoId: `stat${String(i).padStart(7, '0')}`,
    title: `Track ${i}`,
    channel: `Artist ${i % 80}`,
    duration: 200,
  })));
  const initial = JSON.parse(run(file, `
    const db = await import('./src/db.js');
    console.log('@@' + JSON.stringify({
      schema: db.schemaStatus(),
      stat: db.db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl='tracks' AND idx='tracks_channel'").get()?.stat,
    }));
  `));
  assert.equal(initial.schema.expected, 4);
  assert.match(initial.stat, /^2000 /);

  const grown = JSON.parse(run(file, `
    const db = await import('./src/db.js');
    const stat = () => db.db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl='tracks' AND idx='tracks_channel'").get()?.stat;
    const before = stat();
    const insert = db.db.prepare(
      'INSERT INTO tracks(video_id,title,channel,duration_s,thumb,first_seen,last_seen) VALUES (?,?,?,?,NULL,?,?)'
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let i = 2000; i < 100000; i += 1) {
        insert.run('stat' + String(i).padStart(7, '0'), 'Track ' + i, 'Artist ' + (i % 80), 200, now, now);
      }
    });
    const stale = stat();
    const optimized = db.optimizeStatistics();
    const refreshed = stat();
    const insideTransaction = db.transaction(() => db.optimizeStatistics());
    console.log('@@' + JSON.stringify({
      before, stale, optimized, refreshed, insideTransaction,
      rows: db.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,
      schema: db.schemaStatus(),
    }));
  `));
  assert.equal(grown.rows, 100000);
  assert.equal(grown.before, initial.stat);
  assert.equal(grown.stale, initial.stat, 'growth alone does not silently rewrite sqlite_stat1');
  assert.equal(grown.optimized, true);
  assert.match(grown.refreshed, /^100000 /, 'the documented all-table optimize mask measures material growth');
  assert.notEqual(grown.refreshed, grown.stale);
  assert.equal(grown.insideTransaction, false, 'the timer cannot interrupt an application transaction');
  assert.deepEqual(grown.schema, { version: 4, expected: 4, current: true });
});

test('a migration that cannot finish rolls back completely', () => {
  const file = path.join(TMP, 'unmigratable.db');
  // A file whose `users` table has no `id`: the primary key cannot be added by
  // ALTER TABLE, so the only honest answer is to stop and say so.
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      name       TEXT PRIMARY KEY,
      pass_hash  TEXT NOT NULL,
      salt       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO users (name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run('owner', '00', '00', new Date().toISOString());
  db.close();

  const res = runRaw(file, `await import('./src/db.js'); console.log('@@boot');`);
  assert.notEqual(res.status, 0, 'the boot must fail loudly, not half-apply');
  assert.match(res.stderr, /cannot migrate users/);
  assert.match(res.stderr, /primary key/);

  // One transaction: the tables created earlier in the batch are gone again and
  // the version marker never moved, so the next start retries from a clean file.
  assert.equal(userVersion(file), 0, 'no version was recorded for rolled-back work');
  const check = new DatabaseSync(file);
  try {
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((r) => r.name);
    assert.ok(!tables.includes('tracks'), 'the half-created schema was rolled back');
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'user rows survive');
  } finally {
    check.close();
  }
});

test('late schema validation rolls back migration data changes and the version header', () => {
  const file = path.join(TMP, 'late-validation.db');
  run(file, `
    const db = await import('./src/db.js');
    const u = db.createUser('late-owner', 'pw');
    db.db.prepare('INSERT INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)')
      .run(u.id, 'late-conflict', '2020-01-01T00:00:00.000Z');
    db.db.prepare('INSERT INTO dislikes (user_id, video_id, created_at) VALUES (?, ?, ?)')
      .run(u.id, 'late-conflict', '2021-01-01T00:00:00.000Z');
    db.db.prepare('INSERT INTO plays (user_id, video_id, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(u.id, 'late-conflict', 'like', '2020-01-01T00:00:00.000Z');
    db.cacheSet('station:999999:late', { stale: true }, 60000);
    db.db.prepare(
      "INSERT INTO artist_releases (artist_id, release_id, first_seen) VALUES ('UClateempty', '__sonora_initialized_empty_v1__', '2021-01-01T00:00:00.000Z')"
    ).run();
    db.db.exec('PRAGMA user_version = 1');
    console.log('@@seeded');
  `);

  // Keep every column but remove the table-level dedupe constraint. This passes
  // all additive migration steps and fails only in assertSchema at the end.
  const patch = new DatabaseSync(file);
  const original = patch.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'"
  ).get().sql;
  const withoutUnique = original.replace(/,\s*UNIQUE\s*\(user_id,\s*dedupe\)/, '');
  assert.notEqual(withoutUnique, original, 'the fixture really removes the unique constraint');
  patch.exec(`DROP TABLE notifications; ${withoutUnique}`);
  patch.close();

  const res = runRaw(file, `await import('./src/db.js'); console.log('@@unexpected');`);
  assert.notEqual(res.status, 0, 'late validation must still refuse the invalid file');
  assert.match(res.stderr, /UNIQUE \(user_id, dedupe\) on notifications/);
  assert.equal(userVersion(file), 1, 'the version bumps rolled back too');
  const check = new DatabaseSync(file);
  try {
    const count = (table) => check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.equal(count('likes'), 1, 'migration 2 did not commit its destructive conflict repair');
    assert.equal(count('dislikes'), 1);
    assert.equal(count('plays'), 1, 'the corresponding like play was not committed either');
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM upstream_cache WHERE key = 'station:999999:late'").get().n, 1);
    assert.equal(check.prepare(
      "SELECT COUNT(*) AS n FROM artist_releases WHERE release_id = '__sonora_initialized_empty_v1__'"
    ).get().n, 1, 'v4 did not delete the marker before the failed commit');
    assert.equal(count('artist_release_state'), 0, 'v4 initialization insert rolled back');
  } finally {
    check.close();
  }
});

test('a database from a newer release is refused, never downgraded', () => {
  const file = path.join(TMP, 'newer.db');
  run(file, `await import('./src/db.js'); console.log('@@create');`);
  const version = userVersion(file);
  const bump = new DatabaseSync(file);
  bump.exec(`PRAGMA user_version = ${version + 5}`);
  bump.close();

  const res = runRaw(file, `await import('./src/db.js'); console.log('@@boot');`);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /newer release/);
  assert.equal(userVersion(file), version + 5, 'the marker is untouched');
});

test('migration 2 repairs a like/dislike contradiction, keeping the newer action', () => {
  const file = path.join(TMP, 'conflict.db');
  run(file, `
    const db = await import('./src/db.js');
    const u = db.createUser('conflict-owner', 'pw');
    db.db.prepare('INSERT INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)')
      .run(u.id, 'conflict001', '2020-01-01T00:00:00.000Z');
    db.db.prepare('INSERT INTO dislikes (user_id, video_id, created_at) VALUES (?, ?, ?)')
      .run(u.id, 'conflict001', '2021-01-01T00:00:00.000Z');
    const play = db.db.prepare(
      'INSERT INTO plays (user_id, video_id, kind, created_at) VALUES (?, ?, ?, ?)'
    );
    play.run(u.id, 'conflict001', 'like', '2020-01-01T00:00:00.000Z');
    play.run(u.id, 'conflict001', 'start', '2020-01-02T00:00:00.000Z');
    // Wind the marker back so the next boot has to run v2 again.
    db.db.exec('PRAGMA user_version = 1');
    console.log('@@' + u.id);
  `);

  const out = run(file, `
    const db = await import('./src/db.js');
    const likes = db.db.prepare('SELECT video_id FROM likes').all().map((r) => r.video_id);
    const dislikes = db.db.prepare('SELECT video_id FROM dislikes').all().map((r) => r.video_id);
    const plays = db.db.prepare(
      'SELECT kind, COUNT(*) AS n FROM plays GROUP BY kind ORDER BY kind'
    ).all();
    console.log('@@' + JSON.stringify({ likes, dislikes, plays, version: db.schemaStatus() }));
  `);
  const got = JSON.parse(out);
  // The dislike is the newer instruction, so it is the one that survives.
  assert.deepEqual(got.likes, []);
  assert.deepEqual(got.dislikes, ['conflict001']);
  assert.deepEqual(got.plays, [{ kind: 'start', n: 1 }],
    'the like signal is removed exactly as toggleDislike does; listening history survives');
  assert.equal(got.version.version, got.version.expected);
});

test('an index whose definition changed is rebuilt at boot', () => {
  const file = path.join(TMP, 'index-change.db');
  run(file, `await import('./src/db.js'); console.log('@@create');`);
  const patch = new DatabaseSync(file);
  patch.exec('DROP INDEX likes_video; CREATE INDEX likes_video ON likes(created_at)');
  patch.close();

  const out = run(file, `
    const db = await import('./src/db.js');
    const cols = db.db.prepare('PRAGMA index_info(likes_video)').all().map((r) => r.name);
    console.log('@@' + JSON.stringify(cols));
  `);
  assert.deepEqual(JSON.parse(out), ['video_id'], 'the stale definition was replaced');
});

test('one WebAuthn challenge is returned exactly once across racing processes', async () => {
  const file = path.join(TMP, 'challenge-race.db');
  const id = JSON.parse(run(file, `
    const db = await import('./src/db.js');
    const user = db.createUser('challenge-racer', 'pw');
    console.log('@@' + JSON.stringify(db.createChallenge({
      userId: user.id, kind: 'register', challenge: 'once-across-processes',
      rpId: 'localhost', origin: 'http://localhost',
    })));
  `));
  const startAt = Date.now() + 500;
  const workers = Array.from({ length: 16 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const db = await import('./src/db.js');
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(process.env.CHALLENGE_START) - Date.now())));
      const row = db.takeChallenge(${JSON.stringify(id)}, 'register');
      console.log('@@' + JSON.stringify(row?.challenge ?? null));
    `], {
      cwd: ROOT,
      env: { ...process.env, SONORA_DB: file, SONORA_SECRET: 'migration-test', CHALLENGE_START: String(startAt) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`challenge racer failed (${code}):\n${stdout}\n${stderr}`));
      else {
        const line = stdout.split('\n').find((l) => l.startsWith('@@'));
        if (!line) reject(new Error(`challenge racer returned no marker:\n${stdout}`));
        else resolve(JSON.parse(line.slice(2)));
      }
    });
  }));
  const answers = await Promise.all(workers);
  assert.deepEqual(answers.filter(Boolean), ['once-across-processes']);
  const check = new DatabaseSync(file);
  try {
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges WHERE id = ?').get(id).n, 0);
  } finally {
    check.close();
  }
});

test('a file another process has open still boots, in rollback-journal mode', () => {
  const file = path.join(TMP, 'locked.db');
  run(file, `await import('./src/db.js'); console.log('@@create');`);

  // A second process holding the file (an sqlite3 session, a copy mid-read)
  // makes the WAL conversion impossible. That used to abort the whole import.
  const holder = new DatabaseSync(file);
  try {
    holder.exec('PRAGMA journal_mode = DELETE');
    holder.exec('BEGIN');
    holder.prepare('SELECT COUNT(*) AS n FROM users').get();

    const res = runRaw(file, `
      const db = await import('./src/db.js');
      console.log('@@' + JSON.stringify(db.schemaStatus()));
    `);
    assert.equal(res.status, 0, `the boot must survive a locked file:\n${res.stderr}`);
    const status = JSON.parse(res.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
    assert.equal(status.current, true);
    // It says what happened and keeps going, instead of dying on module load.
    assert.match(`${res.stdout}${res.stderr}`, /could not switch .* to WAL/);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
});

test('a no-throw non-WAL database keeps full synchronous durability', () => {
  // SQLite silently keeps :memory: databases in journal_mode=memory when asked
  // for WAL. No exception does not mean NORMAL is safe on this connection.
  const got = JSON.parse(run(':memory:', `
    const db = await import('./src/db.js');
    console.log('@@' + JSON.stringify({
      journal: db.db.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: db.db.prepare('PRAGMA synchronous').get().synchronous,
      schema: db.schemaStatus(),
    }));
  `));
  assert.equal(got.journal, 'memory');
  assert.equal(got.synchronous, 2, 'FULL is retained instead of incorrectly setting NORMAL');
  assert.deepEqual(got.schema, { version: 4, expected: 4, current: true });
});

test('a table deleted by hand is created again on the next boot', () => {
  const file = path.join(TMP, 'missing-table.db');
  run(file, `await import('./src/db.js'); console.log('@@create');`);
  const patch = new DatabaseSync(file);
  assert.equal(Number(patch.prepare('PRAGMA user_version').get().user_version), 4,
    'the fixture really begins at the current schema version');
  patch.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE passkeys;
  `);
  patch.close();

  const out = run(file, `
    const db = await import('./src/db.js');
    const cols = db.db.prepare('PRAGMA table_info(passkeys)').all().map((c) => c.name);
    console.log('@@' + JSON.stringify({ n: cols.length, cols, version: db.schemaStatus().version }));
  `);
  const got = JSON.parse(out);
  assert.ok(got.cols.includes('credential_id'), 'the table is back with its full shape');
  assert.ok(got.cols.includes('backed_up'));
  assert.equal(got.version, 4, 'restoring a deleted table does not change the schema version');
});

test('an unwritable database path fails with the fix, not SQLITE_READONLY', () => {
  // The container failure this guards: a bind mount owned by another user opens
  // for reading and dies several steps into the migration, so the only thing the
  // operator sees is "attempt to write a readonly database" from createMissingTables
  // — which reads as a corrupt file rather than an ownership problem. The check
  // must fire on module load, name the path, and stay silent on a healthy one.
  const dir = fs.mkdtempSync(path.join(TMP, 'readonly-'));
  const file = path.join(dir, 'locked.db');
  run(file, `await import('./src/db.js'); console.log('@@ok');`);

  // 0o500 keeps it readable but not writable, so SQLite opens and later fails
  // exactly as it does on a misowned mount.
  fs.chmodSync(file, 0o500);
  try {
    const res = runRaw(file, `await import('./src/db.js'); console.log('@@ok');`);
    assert.notEqual(res.status, 0, 'the boot must refuse a file it cannot write');
    assert.doesNotMatch(res.stderr, /readonly database/,
      'the raw SQLite error must not be what the operator has to read');
    assert.match(res.stderr, /cannot write to .*locked\.db/);
    assert.match(res.stderr, /not writable/);
    assert.match(res.stderr, /chown -R 1000:1000 data/, 'names the Docker repair');
    assert.match(res.stderr, /compose\.podman\.yaml/, 'names the rootless Podman repair');
  } finally {
    fs.chmodSync(file, 0o600);
  }

  // The same file, writable again, must boot without a warning.
  const good = runRaw(file, `await import('./src/db.js'); console.log('@@ok');`);
  assert.equal(good.status, 0, good.stderr);
  assert.doesNotMatch(good.stderr, /cannot write to/, 'a healthy file is not reported as broken');
});
