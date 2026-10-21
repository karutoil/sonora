import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// The admin role was added after the first instances existed, so the upgrade
// path matters as much as the fresh-install path: an old database has no
// `users.role` column, and `CREATE TABLE IF NOT EXISTS` will never add one.
// A migration bug here would either crash the server on boot or lock the owner
// out of the admin surface.

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
function run(file, code, env = {}) {
  const res = spawnSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, SONORA_DB: file, SONORA_SECRET: 'migration-test', ...env },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed:\n${res.stdout}\n${res.stderr}`);
  const line = res.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `no @@ marker in output:\n${res.stdout}`);
  return line.slice(2).trim();
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
