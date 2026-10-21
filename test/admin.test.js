import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Admin is a database role, so these tests exercise it through the same HTTP
// surface a browser uses: bootstrap admin, a normal account, and the guards
// that stop an instance from locking itself out.

const PORT = 8146;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = new URL(`./.tmp/admin-${Date.now()}.db`, import.meta.url).pathname;
const AUDIO = new URL(`./.tmp/adminaudio-${Date.now()}`, import.meta.url).pathname;

let proc;
let adminCookie = '';
let listenerCookie = '';

const req = async (path, { cookie = '', body, ...opts } = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...opts.headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.()[0];
  const isJson = res.headers.get('content-type')?.includes('json');
  return {
    res,
    body: isJson ? await res.json() : null,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
};

const login = async (name, passphrase) => {
  const r = await req('/api/auth/login', {
    method: 'POST', body: { name, passphrase },
  });
  assert.equal(r.res.status, 200, `login ${name}`);
  return r.cookie;
};

before(async () => {
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'admin-test-secret', SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      // A server left over from an earlier run answers health too, on the
      // previous run's database — so every count-based assertion then fails for
      // a reason that has nothing to do with the code. Only our pid counts.
      const health = r.ok ? await r.json() : null;
      if (health?.pid === proc.pid) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  adminCookie = await login('toil', 'hunter2hunter2');
});

after(() => {
  proc?.kill('SIGTERM');
});

test('the bootstrap account is an admin', async () => {
  const { res, body } = await req('/api/me', { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'admin');
});

test('admin endpoints are closed without a session and to normal users', async () => {
  assert.equal((await req('/api/admin/overview')).res.status, 401);

  const created = await req('/api/admin/users', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'listener', passphrase: 'hunter22', role: 'user' },
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.body.user.role, 'user');
  assert.equal(created.body.user.name, 'listener');
  assert.equal(created.body.user.pass_hash, undefined, 'never returns a hash');

  listenerCookie = await login('listener', 'hunter22');

  for (const [method, path] of [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/tracks'],
    ['GET', '/api/admin/storage'],
    ['GET', '/api/admin/system'],
    ['GET', '/api/admin/audit'],
    ['POST', '/api/admin/users'],
    ['POST', '/api/admin/db/vacuum'],
    ['DELETE', '/api/youtube/cookies'],
  ]) {
    const r = await req(path, {
      method, cookie: listenerCookie,
      body: method === 'POST' ? { name: 'nope', passphrase: '123456' } : undefined,
    });
    assert.equal(r.res.status, 403, `${method} ${path} must be admin-only`);
  }
});

test('creating an account validates input and rejects duplicates', async () => {
  const badName = await req('/api/admin/users', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'has spaces', passphrase: '123456' },
  });
  assert.equal(badName.res.status, 400);

  const shortPass = await req('/api/admin/users', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'shortpass', passphrase: '123' },
  });
  assert.equal(shortPass.res.status, 400);

  const duplicate = await req('/api/admin/users', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'listener', passphrase: '123456' },
  });
  assert.equal(duplicate.res.status, 409);
});

test('the users list includes the admin and the created account', async () => {
  const { res, body } = await req('/api/admin/users', { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(body.me, body.users.find((u) => u.role === 'admin').id);
  const names = body.users.map((u) => u.name);
  assert.deepEqual(names.sort(), ['listener', 'toil']);
  assert.ok(body.users.every((u) => u.pass_hash === undefined));
});

test('an admin cannot demote or disable themselves', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const me = body.users.find((u) => u.id === body.me);

  const demote = await req(`/api/admin/users/${me.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { role: 'user' },
  });
  assert.equal(demote.res.status, 400);

  const disable = await req(`/api/admin/users/${me.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { disabled: true },
  });
  assert.equal(disable.res.status, 400);

  const remove = await req(`/api/admin/users/${me.id}`, {
    method: 'DELETE', cookie: adminCookie,
  });
  assert.equal(remove.res.status, 400);
});

test('a password reset revokes the target sessions', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const listener = body.users.find((u) => u.name === 'listener');

  const reset = await req(`/api/admin/users/${listener.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { password: 'newpass1' },
  });
  assert.equal(reset.res.status, 200);
  assert.deepEqual(reset.body.changed, ['password reset']);

  // The old session is invalid because session_version was bumped.
  assert.equal((await req('/api/me', { cookie: listenerCookie })).res.status, 401);
  // The new passphrase works.
  listenerCookie = await login('listener', 'newpass1');
});

test('disabling blocks sign-in and revokes existing sessions, enabling restores it', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const listener = body.users.find((u) => u.name === 'listener');

  const disabled = await req(`/api/admin/users/${listener.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { disabled: true },
  });
  assert.equal(disabled.res.status, 200);

  assert.equal((await req('/api/me', { cookie: listenerCookie })).res.status, 401);
  const blocked = await req('/api/auth/login', {
    method: 'POST', body: { name: 'listener', passphrase: 'newpass1' },
  });
  assert.equal(blocked.res.status, 403);

  const enabled = await req(`/api/admin/users/${listener.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { disabled: false },
  });
  assert.equal(enabled.res.status, 200);
  listenerCookie = await login('listener', 'newpass1');
});

test('admin sign-out revokes a session without disabling the account', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const listener = body.users.find((u) => u.name === 'listener');

  const out = await req(`/api/admin/users/${listener.id}/signout`, {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(out.res.status, 200);
  assert.equal((await req('/api/me', { cookie: listenerCookie })).res.status, 401);

  listenerCookie = await login('listener', 'newpass1');
});

test('history can be cleared without touching likes or playlists', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const listener = body.users.find((u) => u.name === 'listener');

  // Play events do not create catalog rows, so put the track in a playlist
  // first — that is also what makes it appear in the admin library.
  const pl = await req('/api/playlists', {
    method: 'POST', cookie: listenerCookie, body: { title: 'Admin test' },
  });
  assert.equal(pl.res.status, 201);
  const added = await req(`/api/playlists/${pl.body.playlist.id}/tracks`, {
    method: 'POST', cookie: listenerCookie,
    body: { videoId: '2tOutF8B3f8', title: 'Xtal', channel: 'pigsfood27' },
  });
  assert.equal(added.res.status, 200);

  await req('/api/events', {
    method: 'POST', cookie: listenerCookie,
    body: { videoId: '2tOutF8B3f8', kind: 'start', source: 'search' },
  });
  await req('/api/likes', {
    method: 'POST', cookie: listenerCookie, body: { videoId: '2tOutF8B3f8', like: true },
  });

  const cleared = await req(`/api/admin/users/${listener.id}/clear-history`, {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(cleared.res.status, 200);
  assert.ok(cleared.body.removed >= 2);

  const recent = await req('/api/recent', { cookie: listenerCookie });
  assert.equal(recent.body.tracks.length, 0);
  const likes = await req('/api/likes', { cookie: listenerCookie });
  assert.equal(likes.body.tracks.length, 1, 'likes survive a history clear');
});

test('tracks can be listed and deleted from every user', async () => {
  const { res, body } = await req('/api/admin/tracks?q=2tOutF8B3f8', { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.ok(body.tracks.some((t) => t.videoId === '2tOutF8B3f8'));

  const del = await req('/api/admin/tracks/2tOutF8B3f8', {
    method: 'DELETE', cookie: adminCookie,
  });
  assert.equal(del.res.status, 200);

  const after = await req('/api/admin/tracks?q=2tOutF8B3f8', { cookie: adminCookie });
  assert.equal(after.body.tracks.length, 0);
  const likes = await req('/api/likes', { cookie: listenerCookie });
  assert.equal(likes.body.tracks.length, 0, 'track deletion removes likes too');
});

test('storage can be inspected, pruned, cleared and vacuumed', async () => {
  const storage = await req('/api/admin/storage', { cookie: adminCookie });
  assert.equal(storage.res.status, 200);
  assert.equal(typeof storage.body.cache.files, 'number');
  assert.ok(storage.body.cache.limitBytes > 0);
  assert.ok(storage.body.db.bytes > 0);

  const prune = await req('/api/admin/storage/prune', {
    method: 'POST', cookie: adminCookie, body: { maxMb: 1 },
  });
  assert.equal(prune.res.status, 200);
  assert.ok(prune.body.removed >= 0);

  const clear = await req('/api/admin/storage/clear', {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(clear.res.status, 200);
  assert.equal(clear.body.cache.files, 0);

  const vacuum = await req('/api/admin/db/vacuum', {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(vacuum.res.status, 200);
  assert.equal(vacuum.body.ok, true);
});

test('a consistent database backup can be downloaded', async () => {
  const res = await fetch(`${BASE}/api/admin/backup`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/octet-stream/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="sonora-backup-/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // SQLite files begin with "SQLite format 3\0".
  assert.equal(new TextDecoder().decode(bytes.slice(0, 15)), 'SQLite format 3');
});

test('the system endpoint reports config without leaking secrets', async () => {
  const { res, body } = await req('/api/admin/system', { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(body.config.secretConfigured, true);
  assert.equal(body.config.sessionSecret, undefined);
  assert.equal(body.config.secret, undefined);
  assert.equal(typeof body.jar.connected, 'boolean');
  assert.ok(body.node.startsWith('v'));
});

test('role changes take effect immediately for the target', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const listener = body.users.find((u) => u.name === 'listener');

  const promote = await req(`/api/admin/users/${listener.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { role: 'admin' },
  });
  assert.equal(promote.res.status, 200);
  assert.equal(promote.body.user.role, 'admin');

  // The same cookie now has admin access, because role is read per request.
  assert.equal((await req('/api/admin/overview', { cookie: listenerCookie })).res.status, 200);

  const demote = await req(`/api/admin/users/${listener.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { role: 'user' },
  });
  assert.equal(demote.res.status, 200);
  assert.equal((await req('/api/admin/overview', { cookie: listenerCookie })).res.status, 403);
});

test('deleting a user removes their data and they cannot sign in', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const listener = body.users.find((u) => u.name === 'listener');

  const del = await req(`/api/admin/users/${listener.id}`, {
    method: 'DELETE', cookie: adminCookie,
  });
  assert.equal(del.res.status, 200);

  const gone = await req('/api/auth/login', {
    method: 'POST', body: { name: 'listener', passphrase: 'newpass1' },
  });
  assert.equal(gone.res.status, 401);

  const list = await req('/api/admin/users', { cookie: adminCookie });
  assert.equal(list.body.users.some((u) => u.name === 'listener'), false);
});

test('destructive actions are recorded in the audit log', async () => {
  const { res, body } = await req('/api/admin/audit', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const actions = body.entries.map((e) => e.action);
  for (const expected of ['user.create', 'user.update', 'user.signout', 'user.delete']) {
    assert.ok(actions.includes(expected), `audit contains ${expected}`);
  }
  assert.ok(body.entries.every((e) => e.actorName === 'toil'));
});

test('a rejected change does not partially apply', async () => {
  const created = await req('/api/admin/users', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'partial', passphrase: 'hunter22', role: 'user' },
  });
  assert.equal(created.res.status, 201);
  const id = created.body.user.id;

  // The password is invalid, so the valid role change must not be applied.
  const res = await req(`/api/admin/users/${id}`, {
    method: 'PATCH', cookie: adminCookie,
    body: { role: 'admin', password: 'x' },
  });
  assert.equal(res.res.status, 400);

  const list = await req('/api/admin/users', { cookie: adminCookie });
  const target = list.body.users.find((u) => u.id === id);
  assert.equal(target.role, 'user', 'role was not changed by a rejected request');

  await req(`/api/admin/users/${id}`, { method: 'DELETE', cookie: adminCookie });
});

test('a disabled admin can still be cleaned up when no other admin is active', async () => {
  const { body } = await req('/api/admin/users', { cookie: adminCookie });
  const me = body.users.find((u) => u.id === body.me);

  // Create a second admin, disable them from the first admin's session, then
  // delete them: they are no longer an "active admin", so deletion is allowed.
  const created = await req('/api/admin/users', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'temp-admin', passphrase: 'hunter22', role: 'admin' },
  });
  const id = created.body.user.id;

  const off = await req(`/api/admin/users/${id}`, {
    method: 'PATCH', cookie: adminCookie, body: { disabled: true },
  });
  assert.equal(off.res.status, 200);

  const del = await req(`/api/admin/users/${id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(del.res.status, 200);

  const after = await req('/api/admin/users', { cookie: adminCookie });
  assert.equal(after.body.users.filter((u) => u.role === 'admin').length, 1);
  assert.equal(after.body.users.find((u) => u.id === me.id).role, 'admin');
});
