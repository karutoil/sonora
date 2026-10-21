import { test } from 'node:test';
import assert from 'node:assert/strict';

// Tests run against a throwaway DB and a fixed secret so sessions survive
// across imports; set before anything reads config.
process.env.SONORA_DB = new URL(`./.tmp/test-${process.pid}-${Date.now()}.db`, import.meta.url).pathname;
process.env.SONORA_SECRET = 'test-secret';
process.env.SONORA_PASSPHRASE = 'hunter2hunter2';

const db = await import('../src/db.js');

test('bootstrap user is created and verifies', () => {
  db.bootstrapUser();
  const u = db.findUser('toil');
  assert.ok(u, 'bootstrap user exists');
  assert.equal(db.verifyPassword(u, 'hunter2hunter2'), true);
  assert.equal(db.verifyPassword(u, 'wrong'), false);
  // The first account owns the instance, so it is an admin by construction.
  assert.equal(u.role, 'admin');
});

test('bootstrapUser is idempotent', () => {
  db.bootstrapUser();
  const n = db.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  assert.equal(n, 1);
});

test('roles can be assigned in the database', () => {
  const u = db.createUser('role-test', 'pw');
  assert.equal(u.role, 'user');
  assert.equal(db.countAdmins(), 1);

  db.setUserRole(u.id, 'admin');
  assert.equal(db.getUser(u.id).role, 'admin');
  assert.equal(db.countAdmins(), 2);

  db.setUserRole(u.id, 'user');
  assert.equal(db.countAdmins(), 1);
  assert.throws(() => db.setUserRole(u.id, 'owner'), /Unknown role/);
});

test('deleting a user removes their plays, likes and playlists', () => {
  const u = db.createUser('cascade-test', 'pw');
  db.recordPlay({ userId: u.id, videoId: 'ccccccccccc', kind: 'start' });
  db.toggleLike(u.id, 'ccccccccccc', true);
  const playlistId = db.createPlaylist(u.id, { title: 'Mine' });
  db.addPlaylistItem(u.id, playlistId, { videoId: 'ccccccccccc' });

  assert.equal(db.deleteUser(u.id), true);
  assert.equal(db.findUser('cascade-test'), null);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM plays WHERE user_id = ?').get(u.id).n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM likes WHERE user_id = ?').get(u.id).n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?').get(u.id).n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(playlistId).n, 0);
});

test('session round-trips and rejects tampering', () => {
  const tok = db.signSession({ uid: 1, exp: Date.now() + 60_000 });
  assert.equal(db.readSession(tok).uid, 1);

  // flip a byte in the signature
  const [body, sig] = tok.split('.');
  const bad = `${body}.${sig.slice(0, -1)}${sig.at(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(db.readSession(bad), null, 'tampered signature rejected');

  assert.equal(db.readSession('not-a-token'), null);
  assert.equal(db.readSession(undefined), null);
});

test('expired session is rejected', () => {
  const tok = db.signSession({ uid: 1, exp: Date.now() - 1000 });
  assert.equal(db.readSession(tok), null);
});

test('plays and likes are recorded per user', () => {
  const u = db.findUser('toil');
  db.recordPlay({ userId: u.id, videoId: 'dQw4w9WgXcQ', kind: 'start', source: 'search' });
  db.recordPlay({ userId: u.id, videoId: 'dQw4w9WgXcQ', kind: 'complete' });
  db.toggleLike(u.id, 'dQw4w9WgXcQ', true);

  const likes = db.listLikes(u.id);
  assert.equal(likes.length, 1);
  assert.equal(likes[0].videoId, 'dQw4w9WgXcQ');

  // unliking removes it again
  db.toggleLike(u.id, 'dQw4w9WgXcQ', false);
  assert.equal(db.listLikes(u.id).length, 0);

  const kinds = db.db
    .prepare('SELECT kind FROM plays WHERE user_id = ? ORDER BY id')
    .all(u.id)
    .map((r) => r.kind);
  assert.deepEqual(kinds, ['start', 'complete']);
});

test('a second user does not see the first user\'s likes', () => {
  const a = db.findUser('toil');
  const b = db.createUser('someone-else', 'pw');
  db.toggleLike(a.id, 'aaaaaaaaaaa', true);
  assert.equal(db.listLikes(b.id).length, 0, 'likes are scoped by user_id');
  assert.equal(db.listLikes(a.id).some((t) => t.videoId === 'aaaaaaaaaaa'), true);
});

test('devices are one-per-browser and cascade their refresh tokens', () => {
  const u = db.createUser('device-owner', 'pw');
  const device = db.createDevice({
    userId: u.id, name: 'Laptop', clientDeviceId: 'client-1', ip: '10.0.0.1', remembered: true,
  });
  assert.equal(db.findDeviceByClient(u.id, 'client-1').id, device.id);

  const token = db.issueRefreshToken({ deviceId: device.id, userId: u.id, ttlMs: 60_000 });
  assert.ok(db.getRefreshToken(db.hashToken(token.token)));
  // The plaintext is never stored.
  assert.equal(db.getRefreshToken(token.token), null);

  const other = db.createDevice({ userId: u.id, name: 'Phone', clientDeviceId: 'client-2' });
  assert.equal(db.listDevices(u.id).length, 2);
  assert.equal(db.deleteOtherDevices(u.id, device.id), 1);

  assert.ok(db.getDevice(device.id));
  assert.equal(db.getDevice(other.id), null);
  assert.ok(db.getRefreshToken(db.hashToken(token.token)), 'the kept device keeps its token');

  db.deleteDevice(device.id);
  assert.equal(db.getRefreshToken(db.hashToken(token.token)), null, 'deleting a device cascades');
});

test('a device that can still redeem a refresh token is not pruned', () => {
  const u = db.createUser('prune-owner', 'pw');
  const stale = db.createDevice({ userId: u.id, name: 'Old', clientDeviceId: 'client-old' });
  const kept = db.createDevice({ userId: u.id, name: 'Saved', clientDeviceId: 'client-kept' });
  db.issueRefreshToken({ deviceId: kept.id, userId: u.id, ttlMs: 90 * 86_400_000 });

  // Backdate both so they look abandoned, then prune.
  db.db.prepare('UPDATE devices SET last_seen_at = ?').run(new Date(Date.now() - 100 * 86_400_000).toISOString());
  assert.equal(db.pruneStaleDevices(60), 1);
  assert.equal(db.getDevice(stale.id), null, 'an abandoned device with no session goes');
  assert.ok(db.getDevice(kept.id), 'a device that can still redeem a token stays');
});

test('a rotated refresh token is consumed exactly once', () => {
  const u = db.createUser('rotate-owner', 'pw');
  const device = db.createDevice({ userId: u.id, name: 'Rotate', clientDeviceId: 'client-rot' });
  const first = db.issueRefreshToken({ deviceId: device.id, userId: u.id, ttlMs: 60_000 });
  const next = db.issueRefreshToken({ deviceId: device.id, userId: u.id, ttlMs: 60_000 });

  assert.equal(db.consumeRefreshToken(first.id, next.tokenHash), true);
  assert.equal(db.consumeRefreshToken(first.id, next.tokenHash), false, 'second use is refused');
  const row = db.getRefreshToken(db.hashToken(first.token));
  assert.ok(row.revoked_at);
  assert.equal(row.replaced_by, next.tokenHash, 'the replacement is recorded for the audit trail');
});

test('a passkey round-trips through the store with its counter', () => {
  const u = db.createUser('passkey-owner', 'pw');
  const id = db.createPasskey({
    userId: u.id, credentialId: 'cred-1', publicKey: 'pk', counter: 0,
    transports: ['internal'], deviceType: 'singleDevice', backedUp: false, name: 'Laptop passkey',
  });
  const list = db.listPasskeys(u.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Laptop passkey');
  assert.deepEqual(list[0].transports, ['internal']);

  assert.equal(db.getPasskeyByCredentialId('cred-1').id, id);
  db.updatePasskeyUse(id, 5, { deviceType: 'multiDevice', backedUp: true });
  const used = db.getPasskeyByCredentialId('cred-1');
  assert.equal(used.counter, 5);
  assert.equal(used.backed_up, 1);
  // A stale counter must never move stored state backwards.
  db.updatePasskeyUse(id, 2, {});
  assert.equal(db.getPasskeyByCredentialId('cred-1').counter, 5);

  assert.equal(db.deletePasskey(u.id, id), true);
  assert.equal(db.countPasskeys(u.id), 0);
});

test('a WebAuthn challenge is single use and expires', () => {
  const u = db.createUser('challenge-owner', 'pw');
  const id = db.createChallenge({
    userId: u.id, kind: 'register', challenge: 'abc', rpId: 'localhost', origin: 'http://localhost',
  });
  assert.equal(db.takeChallenge(id, 'register').challenge, 'abc');
  assert.equal(db.takeChallenge(id, 'register'), null, 'a consumed challenge is gone');

  const expired = db.createChallenge({
    userId: u.id, kind: 'authenticate', challenge: 'xyz', rpId: 'localhost', origin: 'http://localhost', ttlMs: -1,
  });
  assert.equal(db.takeChallenge(expired, 'authenticate'), null);

  // The wrong ceremony kind cannot consume a challenge it did not create.
  const rightKind = db.createChallenge({
    userId: u.id, kind: 'register', challenge: 'keep', rpId: 'localhost', origin: 'http://localhost',
  });
  assert.equal(db.takeChallenge(rightKind, 'authenticate'), null);
  assert.equal(db.takeChallenge(rightKind, 'register').challenge, 'keep');
});
