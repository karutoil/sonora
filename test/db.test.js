import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Tests run against a throwaway DB and a fixed secret so sessions survive
// across imports; set before anything reads config.
process.env.SONORA_DB = new URL(`./.tmp/test-${process.pid}-${Date.now()}.db`, import.meta.url).pathname;
process.env.SONORA_SECRET = 'test-secret';
process.env.SONORA_PASSPHRASE = 'hunter2hunter2';

const db = await import('../src/db.js');

test('bootstrap user is created and verifies', () => {
  db.bootstrapUser();
  const u = db.findUser('admin');
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
  const u = db.findUser('admin');
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
  const a = db.findUser('admin');
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

test('fixed device and passkey queries reuse their prepared statements', () => {
  const u = db.createUser('prepared-owner', 'pw');
  const device = db.createDevice({ userId: u.id, clientDeviceId: 'prepared-client' });
  const calls = [
    () => db.getDevice(device.id),
    () => db.findDeviceByClient(u.id, 'prepared-client'),
    () => db.touchDevice(device.id),
    () => db.touchDevice(device.id, { login: true }),
    () => db.countPasskeys(u.id),
  ];
  // Warm every SQL text before spying, including touchDevice's second branch.
  for (const call of calls) call();
  const original = db.db.prepare;
  const prepared = [];
  db.db.prepare = function (sql, ...options) {
    prepared.push(sql);
    return original.call(this, sql, ...options);
  };
  try {
    for (const call of calls) {
      call();
      call();
    }
  } finally {
    db.db.prepare = original;
  }
  assert.deepEqual(prepared, [], 'two hot calls must compile no SQL after the cache is warm');
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

// ── schema version, indexes and integrity ───────────────────────────────

test('the schema is versioned and reports itself as current', () => {
  const status = db.schemaStatus();
  assert.equal(status.expected, db.SCHEMA_VERSION);
  assert.equal(status.version, db.SCHEMA_VERSION, 'a fresh database is migrated at import');
  assert.equal(status.current, true);
  assert.equal(db.integrityReport().schemaVersion, db.SCHEMA_VERSION);
});

test('every index the queries rely on exists', () => {
  const names = new Set(db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all().map((r) => r.name));
  for (const name of [
    // read/lookup indexes the audit measured as missing
    'tracks_channel', 'likes_video', 'dislikes_video', 'playlist_items_video',
    'notifications_video', 'users_role',
    // housekeeping over tables that only grow between restarts
    'upstream_cache_expiry', 'refresh_tokens_expiry',
    // the station's GROUP BY over a user's whole play history
    'plays_user_kind_video',
  ]) {
    assert.ok(names.has(name), `index ${name} exists`);
  }
});

test('grouping a user\'s plays is served by the covering index, not a scan', () => {
  const plan = db.db.prepare(
    'EXPLAIN QUERY PLAN SELECT video_id, MAX(created_at) FROM plays WHERE user_id = ? GROUP BY video_id',
  ).all(1).map((r) => r.detail).join(' | ');
  assert.match(plan, /COVERING INDEX plays_user_kind_video/,
    `expected the covering index in the plan, got: ${plan}`);
});

/** Capture the production statement itself, rather than a copied test query. */
function capturePlan(call, args) {
  const original = db.db.prepare;
  let sql;
  db.db.prepare = function (text, ...options) {
    if (sql === undefined) sql = text;
    return original.call(this, text, ...options);
  };
  try {
    call();
  } finally {
    db.db.prepare = original;
  }
  assert.equal(typeof sql, 'string', 'the statement was prepared, not served by an earlier capture');
  return { sql, detail: db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail) };
}

test('hot SQL aggregates before metadata joins and room visibility uses its three indexes', () => {
  const recent = capturePlan(() => db.recentlyPlayed(-101, 40), [-101, 40]);
  const candidates = capturePlan(() => db.stationCandidates(-101, 400), [-101, 400]);
  const top = capturePlan(() => db.topArtists(-101, 18), [-101, 18]);
  const artists = capturePlan(() => db.stationArtists(-101, 18), [-101, 18]);
  const rooms = capturePlan(() => db.listRoomsForUser(-101, 20), [-101, -101, -101, -101, -101, 20]);

  for (const [name, query] of [['recent', recent], ['candidates', candidates]]) {
    assert.match(query.detail.join(' | '), new RegExp(`CO-ROUTINE ${name}`));
    assert.match(query.detail.join(' | '), /COVERING INDEX plays_user_kind_video/);
    assert.ok(query.detail.findIndex((d) => d.startsWith(`SCAN ${name === 'recent' ? 'r' : 'c'}`)) >= 0,
      `${name}: the already-limited aggregate feeds the outer metadata join`);
  }
  for (const query of [top, artists]) {
    const detail = query.detail.join(' | ');
    assert.match(detail, /CO-ROUTINE by_track/);
    assert.match(detail, /SEARCH p USING COVERING INDEX plays_user_kind_video/);
    assert.match(query.sql, /CROSS JOIN tracks t/, 'stale global stats cannot reverse the join order');
    assert.ok(!detail.includes('SEARCH t USING INDEX tracks_channel (channel>?)'),
      `must not walk the global channel catalogue first: ${detail}`);
  }
  const roomPlan = rooms.detail.join(' | ');
  assert.match(roomPlan, /CO-ROUTINE visible/);
  assert.match(roomPlan, /(?:UNION USING TEMP B-TREE|MERGE \(UNION\))/, 'overlapping access paths are de-duplicated');
  for (const index of ['rooms_host', 'room_members_user', 'room_invites_user']) {
    assert.match(roomPlan, new RegExp(`SEARCH .* USING (?:COVERING )?INDEX ${index}`),
      `${index} serves its visibility branch: ${roomPlan}`);
  }
  assert.ok(!roomPlan.includes('SCAN u USING COVERING INDEX'), `no all-user host scan: ${roomPlan}`);
});

test('aggregate rewrites preserve grouped output, nulls, ties, orphan tracks and limits', () => {
  const u = db.createUser('aggregate-equivalence', 'pw');
  const other = db.createUser('aggregate-other', 'pw');
  const at = (seconds) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + seconds * 1000).toISOString();
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const now = at(0);
  const tracks = [
    ['agg-a1', 'A one', 'Alpha', 100, 'alpha-thumb'],
    ['agg-a2', 'A two', 'Alpha', null, null],
    ['agg-b1', null, 'Beta', 200, 'beta-thumb'],
    ['agg-null', null, null, null, null],
    ['agg-empty', 'Empty channel', '', 0, null],
    ['agg-tie', 'Tie', 'Tie', 50, 'tie-thumb'],
    ['agg-likeonly', 'Gamma', 'Gamma', 75, 'gamma-thumb'],
    ['agg-delta', 'Delta', 'Delta', 60, null],
    ['agg-epsilon', 'Epsilon', 'Epsilon', 60, 'epsilon-thumb'],
  ];
  const addTrack = db.db.prepare(`
    INSERT INTO tracks (video_id, title, channel, duration_s, thumb, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const addPlay = db.db.prepare(`
    INSERT INTO plays (user_id, video_id, kind, position_ms, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const row of tracks) addTrack.run(...row, now, now);
    const play = (videoId, kind, seconds, positionMs = null, durationMs = null, userId = u.id) => {
      addPlay.run(userId, videoId, kind, positionMs, durationMs, at(seconds));
    };
    play('agg-a1', 'start', 5);
    play('agg-a1', 'progress', 6, 25, 100);
    play('agg-a1', 'progress', 7, 150, 100); // clamped to 1
    play('agg-a1', 'complete', 8);
    play('agg-a1', 'like', 9); // artists only, never the history aggregates
    play('agg-a2', 'start', 4);
    play('agg-a2', 'skip', 4); // exact lastPlayed tie with Beta
    play('agg-a2', 'progress', 2, null, 100);
    play('agg-b1', 'progress', 3, 50, 0);
    play('agg-b1', 'complete', 4);
    play('agg-null', 'start', 6);
    play('agg-null', 'progress', 6, 50, 200);
    play('agg-orphan', 'start', 7); // LEFT JOIN must retain this row
    play('agg-orphan', 'progress', 7, 25, 100);
    play('agg-empty', 'start', 3);
    play('agg-tie', 'complete', 8); // exact recent tie with A one
    play('agg-tie', 'skip', 9);
    play('agg-likeonly', 'like', 10);
    play('agg-delta', 'like', 11); // exact artist rank/time tie with Epsilon
    play('agg-epsilon', 'like', 11);
    play('agg-a1', 'complete', 12, null, null, other.id);
  });

  const recent = [
    { videoId: 'agg-a1', at: at(8), title: 'A one', channel: 'Alpha', thumb: 'alpha-thumb', durationS: 100 },
    { videoId: 'agg-tie', at: at(8), title: 'Tie', channel: 'Tie', thumb: 'tie-thumb', durationS: 50 },
    { videoId: 'agg-orphan', at: at(7), title: null, channel: null, thumb: null, durationS: null },
    { videoId: 'agg-null', at: at(6), title: null, channel: null, thumb: null, durationS: null },
    { videoId: 'agg-a2', at: at(4), title: 'A two', channel: 'Alpha', thumb: null, durationS: null },
    { videoId: 'agg-b1', at: at(4), title: null, channel: 'Beta', thumb: 'beta-thumb', durationS: 200 },
    { videoId: 'agg-empty', at: at(3), title: 'Empty channel', channel: '', thumb: null, durationS: 0 },
  ];
  assert.deepEqual(plain(db.recentlyPlayed(u.id, 40)), recent);
  assert.deepEqual(plain(db.recentlyPlayed(u.id, 1)), recent.slice(0, 1));
  assert.deepEqual(plain(db.recentlyPlayed(u.id, -1)), recent, 'SQLite negative LIMIT still means unbounded');
  assert.deepEqual(plain(db.recentlyPlayed(u.id, 0)), []);

  const candidate = (
    videoId, completes, skips, starts, deepest, lastPlayed, title, channel, thumb, durationS,
    channelId = null,
  ) => ({
    videoId, completes, skips, starts, deepest, lastPlayed, title, channel,
    channelId, thumb, durationS,
  });
  const candidates = [
    candidate('agg-tie', 1, 1, 0, 0, at(9), 'Tie', 'Tie', 'tie-thumb', 50),
    candidate('agg-a1', 1, 0, 1, 1, at(8), 'A one', 'Alpha', 'alpha-thumb', 100),
    candidate('agg-orphan', 0, 0, 1, 0.25, at(7), null, null, null, null),
    candidate('agg-null', 0, 0, 1, 0.25, at(6), null, null, null, null),
    candidate('agg-a2', 0, 1, 1, 0, at(4), 'A two', 'Alpha', null, null),
    candidate('agg-b1', 1, 0, 0, 0, at(4), null, 'Beta', 'beta-thumb', 200),
    candidate('agg-empty', 0, 0, 1, 0, at(3), 'Empty channel', '', null, 0),
  ];
  const station = db.stationCandidates(u.id, 400);
  assert.deepEqual(plain(station.plays), candidates);
  assert.deepEqual(station.likes, []);
  assert.deepEqual(plain(db.stationCandidates(u.id, 1).plays), candidates.slice(0, 1));
  assert.deepEqual(plain(db.stationCandidates(u.id, 0).plays), []);

  const top = [
    { title: 'Alpha', plays: 4, lastPlayed: at(9), thumb: 'alpha-thumb' },
    { title: 'Delta', plays: 1, lastPlayed: at(11), thumb: null },
    { title: 'Epsilon', plays: 1, lastPlayed: at(11), thumb: 'epsilon-thumb' },
    { title: 'Gamma', plays: 1, lastPlayed: at(10), thumb: 'gamma-thumb' },
    { title: 'Tie', plays: 1, lastPlayed: at(8), thumb: 'tie-thumb' },
    { title: 'Beta', plays: 1, lastPlayed: at(4), thumb: 'beta-thumb' },
  ];
  assert.deepEqual(plain(db.topArtists(u.id, 18)), top);
  assert.deepEqual(plain(db.topArtists(u.id, 3)), top.slice(0, 3), 'ties at the LIMIT use the channel tiebreak');
  assert.deepEqual(plain(db.topArtists(u.id, 0)), []);
  const artistRanking = plain(db.stationArtists(u.id, 20));
  assert.deepEqual(artistRanking[0], { name: 'Alpha', plays: 2 });
  // stationArtists historically orders only by plays. Keep that contract rather
  // than inventing a new tiebreak in a performance patch: tied groups are
  // compared as a set, while Alpha (the unique winner) and every LIMIT are exact.
  assert.deepEqual(artistRanking.slice(1).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'Beta', plays: 1 },
    { name: 'Delta', plays: 1 },
    { name: 'Epsilon', plays: 1 },
    { name: 'Gamma', plays: 1 },
    { name: 'Tie', plays: 1 },
  ]);
  assert.deepEqual(plain(db.stationArtists(u.id, 1)), [{ name: 'Alpha', plays: 2 }]);
  assert.deepEqual(plain(db.stationArtists(u.id, 0)), []);
  assert.deepEqual(db.listLikes(other.id), [], 'the other user contributes only isolation coverage');
});

test('room UNION listing preserves overlap, flags, ended filtering, ordering and bounds', () => {
  const host = db.createUser('room-query-host', 'pw');
  const viewer = db.createUser('room-query-viewer', 'pw');
  const at = (seconds) => new Date(Date.parse('2026-02-01T00:00:00.000Z') + seconds * 1000).toISOString();
  const make = (code, hostId, seconds, ended = false) => {
    db.createRoomRow({ code, hostId, visibility: 'private', control: 'host', state: { index: 0 } });
    db.db.prepare('UPDATE rooms SET created_at = ?, updated_at = ?, ended_at = ? WHERE code = ?')
      .run(at(0), at(seconds), ended ? at(seconds) : null, code);
  };
  make('RQ-MEMBER', host.id, 4);
  make('RQ-HOST', viewer.id, 3);
  make('RQ-INVITE', host.id, 3);
  make('RQ-ENDED', viewer.id, 5, true);
  make('RQ-OTHER', host.id, 5);
  for (const code of ['RQ-HOST', 'RQ-MEMBER', 'RQ-ENDED']) db.addRoomMember(code, viewer.id);
  for (const code of ['RQ-HOST', 'RQ-INVITE', 'RQ-ENDED']) db.addRoomInvite(code, viewer.id, host.id);

  const rows = db.listRoomsForUser(viewer.id, 20);
  // RQ-HOST appears through all three branches and must still occur only once.
  assert.deepEqual(rows.map((r) => r.code), ['RQ-MEMBER', 'RQ-HOST', 'RQ-INVITE']);
  assert.deepEqual(rows.map((r) => ({
    code: r.code, hostName: r.hostName, members: r.members, joined: r.joined, invited: r.invited,
  })), [
    { code: 'RQ-MEMBER', hostName: 'room-query-host', members: 1, joined: true, invited: false },
    { code: 'RQ-HOST', hostName: 'room-query-viewer', members: 1, joined: true, invited: true },
    { code: 'RQ-INVITE', hostName: 'room-query-host', members: 0, joined: false, invited: true },
  ]);
  assert.equal(rows[1].hostId, viewer.id);
  assert.equal(rows[1].createdAt, at(0));
  assert.equal(rows[1].updatedAt, at(3));
  assert.deepEqual(db.listRoomsForUser(viewer.id, 2).map((r) => r.code), ['RQ-MEMBER', 'RQ-HOST']);
  assert.deepEqual(db.listRoomsForUser(viewer.id, 0).map((r) => r.code), ['RQ-MEMBER'],
    'the existing minimum bound of one is retained');
  assert.deepEqual(db.listRoomsForUser(viewer.id, -20).map((r) => r.code), ['RQ-MEMBER']);
  assert.equal(db.listRoomsForUser(host.id, 100).some((r) => r.code === 'RQ-ENDED'), false);
});

test('LIKE searches treat % and _ as characters, not wildcards', () => {
  db.createUser('search_underscore', 'pw');
  db.createUser('searchXunderscore', 'pw');
  db.createUser('plain-name', 'pw');

  const underscore = db.searchUsers('_').map((u) => u.name);
  assert.ok(underscore.includes('search_underscore'), 'a literal _ matches itself');
  assert.ok(!underscore.includes('searchXunderscore'), '_ is not "any character"');
  assert.ok(!underscore.includes('plain-name'));

  // The admin track search had the same bug: "_" returned every track.
  db.upsertTrack({ videoId: 'lit_eral_01', title: 'a_b' });
  db.upsertTrack({ videoId: 'wildcard001', title: 'axb' });
  const tracks = db.listTracksForAdmin('_').map((t) => t.videoId);
  assert.deepEqual(tracks, ['lit_eral_01']);
});

test('upsertTrack rejects unusable ids and stores only safe integer durations', () => {
  for (const track of [
    null, {}, { videoId: '' }, { videoId: ' \t\n ' }, { videoId: 123 },
    { videoId: null }, { videoId: new String('boxed-id') },
  ]) {
    assert.throws(() => db.upsertTrack(track), { name: 'TypeError', message: /videoId/ });
  }

  const cases = [
    ['duration-round', 12.6, 13],
    ['duration-floor', -12, 0],
    ['duration-large', Number.MAX_VALUE, Number.MAX_SAFE_INTEGER],
    ['duration-inf', Infinity, null],
    ['duration-nan', Number.NaN, null],
    ['duration-text', '120', null],
  ];
  for (const [videoId, durationS, expected] of cases) {
    db.upsertTrack({ videoId, title: videoId, durationS });
    assert.equal(db.getTrack(videoId).durationS, expected, `${videoId} duration`);
    if (expected !== null) {
      assert.equal(db.db.prepare('SELECT typeof(duration_s) AS type FROM tracks WHERE video_id = ?')
        .get(videoId).type, 'integer');
    }
  }
  db.upsertTrack({ videoId: '  duration-trim  ', durationS: 20 });
  assert.ok(db.getTrack('duration-trim'), 'significant edge whitespace is removed from the id');
});

test('station evidence carries channel ids for likes and played seeds', () => {
  const u = db.createUser('station-channel-owner', 'pw');
  const videoId = 'channelSeed01';
  const channelId = 'UCstationSeed000000000001';
  db.upsertTrack({ videoId, title: 'Station seed', channel: 'Seed Artist', channelId });
  db.recordPlay({ userId: u.id, videoId, kind: 'complete' });
  db.toggleLike(u.id, videoId, true);

  const played = db.stationCandidates(u.id).plays.find((track) => track.videoId === videoId);
  const liked = db.listLikes(u.id).find((track) => track.videoId === videoId);
  assert.equal(played.channelId, channelId);
  assert.equal(liked.channelId, channelId);
});

test('marking a huge notification id list is capped instead of failing', () => {
  const u = db.createUser('bell-flood', 'pw');
  for (let i = 0; i < 600; i += 1) {
    db.addNotification({ userId: u.id, kind: 'track', title: `t${i}`, dedupe: `flood-${i}` });
  }
  const ids = Array.from({ length: 40_000 }, (_, i) => i + 1);
  const marked = db.markNotificationsRead(u.id, ids);
  assert.ok(marked <= 500, `at most the cap is marked (got ${marked})`);
  assert.ok(marked > 0);
  // The call must not throw "too many SQL variables", and the rest stay unread.
  assert.ok(db.countUnread(u.id) >= 100);
});

test('deleting a track removes the bell rows that point at it', () => {
  const u = db.createUser('bell-track', 'pw');
  db.upsertTrack({ videoId: 'gone-track1', title: 'Gone' });
  assert.equal(db.addNotification({
    userId: u.id, kind: 'track', title: 'Gone', videoId: 'gone-track1', dedupe: 'gone-1',
  }), true);
  assert.equal(db.deleteTrack('gone-track1'), true);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE video_id = ?')
    .get('gone-track1').n, 0);
});

test('global track deletion covers cached recommendations; history clears stay scoped', () => {
  const first = db.createUser('cache-evict-first', 'pw');
  const second = db.createUser('cache-evict-second', 'pw');
  const other = db.createUser('cache-evict-other', 'pw');
  db.upsertTrack({ videoId: 'evict-track1', title: 'Evicted' });
  db.recordPlay({ userId: first.id, videoId: 'evict-track1', kind: 'complete' });
  db.toggleDislike(second.id, 'evict-track1', true);
  db.recordPlay({ userId: other.id, videoId: 'other-track1', kind: 'complete' });
  for (const u of [first, second, other]) {
    db.cacheSet(`station:${u.id}:delete`, { owner: u.id }, 60_000);
  }

  db.deleteTrack('evict-track1');
  assert.equal(db.cacheGet(`station:${first.id}:delete`), null, 'a deleted played track evicts its station');
  assert.equal(db.cacheGet(`station:${second.id}:delete`), null, 'removing a dislike also changes that station');
  assert.equal(db.cacheGet(`station:${other.id}:delete`), null,
    'even another user’s cached recommendations cannot retain a globally deleted track');

  db.cacheSet(`station:${other.id}:delete`, { owner: other.id }, 60_000);
  db.recordPlay({ userId: first.id, videoId: 'history-evict1', kind: 'start' });
  db.cacheSet(`station:${first.id}:history`, { stale: true }, 60_000);
  assert.equal(db.clearUserHistory(first.id), 1);
  assert.equal(db.cacheGet(`station:${first.id}:history`), null);
  assert.deepEqual(db.cacheGet(`station:${other.id}:delete`), { owner: other.id });

  db.toggleLike(first.id, 'taste-evict1', true);
  db.cacheSet(`station:${first.id}:taste`, { stale: true }, 60_000);
  assert.equal(db.clearUserTaste(first.id), 1);
  assert.equal(db.cacheGet(`station:${first.id}:taste`), null);
});

test('deleting a user drops their cached station, so a reused id cannot inherit it', () => {
  const u = db.createUser('station-owner', 'pw');
  db.cacheSet(`station:${u.id}:first`, { seeds: ['private'] }, 60_000);
  assert.deepEqual(db.cacheGet(`station:${u.id}:first`), { seeds: ['private'] });

  assert.equal(db.deleteUser(u.id), true);
  assert.equal(db.cacheGet(`station:${u.id}:first`), null);

  // And integrity reporting plus the general repair also catch a blob left
  // behind by an older build (there is no foreign key on the cache key).
  db.cacheSet('station:999999:first', { seeds: ['stale'] }, 60_000);
  const report = db.integrityReport();
  assert.equal(report.orphanStationCache, 1);
  assert.equal(report.ok, false);
  assert.ok(report.orphans.some((o) => o.table === 'upstream_cache' && o.column === 'key'));
  const repaired = db.pruneOrphans();
  assert.ok(repaired.some((o) => o.table === 'upstream_cache' && o.rows === 1));
  assert.equal(db.cacheGet('station:999999:first'), null);
  assert.equal(db.integrityReport().orphanStationCache, 0);
});

test('orphan rows are detected and pruned without touching reachable data', () => {
  const u = db.createUser('orphan-owner', 'pw');
  db.upsertTrack({ videoId: 'orphan-vid1', title: 'Orphan' });
  db.toggleLike(u.id, 'orphan-vid1', true);
  db.recordPlay({ userId: u.id, videoId: 'orphan-vid1', kind: 'start' });
  const keep = db.createUser('keep-owner', 'pw');
  db.toggleLike(keep.id, 'orphan-vid1', true);

  // Simulate a row written while foreign keys were off (a sqlite3 session, a
  // hand edit, a build that forgot the pragma).
  db.db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  } finally {
    db.db.exec('PRAGMA foreign_keys = ON');
  }

  const found = db.findOrphans();
  assert.ok(found.some((o) => o.table === 'likes'), `likes orphan reported: ${JSON.stringify(found)}`);
  assert.ok(found.some((o) => o.table === 'plays'));
  assert.equal(db.integrityReport().ok, false);

  const removed = db.pruneOrphans();
  assert.ok(removed.reduce((n, r) => n + r.rows, 0) >= 2);
  assert.deepEqual(db.findOrphans(), []);
  assert.equal(db.listLikes(keep.id).length, 1, 'reachable likes survive');
  assert.equal(db.integrityReport().ok, true);
});

test('a dangling inviter is nulled without deleting the room invitation', () => {
  const host = db.createUser('invite-host', 'pw');
  const invited = db.createUser('invite-guest', 'pw');
  const inviter = db.createUser('invite-old-host', 'pw');
  db.createRoomRow({ code: 'INVITE1', hostId: host.id, state: {} });
  db.addRoomInvite('INVITE1', invited.id, inviter.id);

  db.db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.db.prepare('DELETE FROM users WHERE id = ?').run(inviter.id);
  } finally {
    db.db.exec('PRAGMA foreign_keys = ON');
  }
  assert.ok(db.findOrphans().some((o) => o.table === 'room_invites' && o.column === 'invited_by'));
  assert.equal(db.integrityReport().ok, false);

  const repaired = db.pruneOrphans();
  assert.ok(repaired.some((o) => o.table === 'room_invites' && o.column === 'invited_by'));
  const invite = db.getRoomInvite('INVITE1', invited.id);
  assert.ok(invite, 'the invitation itself survives');
  assert.equal(invite.invited_by, null);
  assert.equal(db.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.integrityReport().ok, true);
});

test('a room command commits against the revision it was computed from', () => {
  const u = db.createUser('cas-host', 'pw');
  db.createRoomRow({ code: 'CAS001', hostId: u.id, state: { index: 0, positionMs: 0 } });

  assert.equal(db.updateRoomStateCas('CAS001', {
    state: { index: 1, positionMs: 0 }, rev: 2, expectedRev: 1,
  }), true);
  // A second command that still thinks it is on rev 1 must not move the
  // playhead back — that is what used to make two people jump backwards.
  assert.equal(db.updateRoomStateCas('CAS001', {
    state: { index: 2, positionMs: 0 }, rev: 2, expectedRev: 1,
  }), false);
  assert.equal(db.getRoomRow('CAS001').rev, 2);
  assert.deepEqual(JSON.parse(db.getRoomRow('CAS001').state), { index: 1, positionMs: 0 });
});

test('users.last_seen_at is refreshed, and never regressed', () => {
  const u = db.createUser('seen-owner', 'pw');
  const before = db.getUser(u.id).last_seen_at;
  assert.equal(before, null);

  assert.equal(db.touchUserSeen(u.id), true);
  const seen = db.getUser(u.id).last_seen_at;
  assert.ok(seen, 'a device touching the account records when it was last seen');

  // Called again inside the throttle window it is a no-op, so a second device
  // cannot move the value backwards.
  assert.equal(db.touchUserSeen(u.id), false);
  assert.equal(db.getUser(u.id).last_seen_at, seen);
});

test('expired cache rows are swept by expiry, not left for their next read', () => {
  db.cacheSet('sweep:dead', { x: 1 }, -1);
  db.cacheSet('sweep:live', { x: 2 }, 60_000);
  assert.ok(db.pruneExpiredCache() >= 1);
  assert.equal(db.cacheGet('sweep:dead'), null);
  assert.deepEqual(db.cacheGet('sweep:live'), { x: 2 });
});

test('a follow attempt stamps the attempt, counts failures and clears them on success', () => {
  const u = db.createUser('follow-attempt', 'pw');
  db.followArtist(u.id, { artistId: 'UCattempt0001', name: 'Attempt' });
  const row = () => db.db.prepare(`
    SELECT last_checked_at, last_attempt_at, fail_count
    FROM artist_follows WHERE user_id = ? AND artist_id = ?
  `).get(u.id, 'UCattempt0001');

  assert.deepEqual({ ...row() }, { last_checked_at: null, last_attempt_at: null, fail_count: 0 });

  assert.equal(db.markFollowAttempt(u.id, 'UCattempt0001', { ok: false, at: '2026-01-01T00:00:00.000Z' }), true);
  let r = row();
  assert.equal(r.fail_count, 1);
  assert.equal(r.last_attempt_at, '2026-01-01T00:00:00.000Z');
  // A failure is an attempt, not a check: the artist is still owed a real look.
  assert.equal(r.last_checked_at, null);

  db.markFollowAttempt(u.id, 'UCattempt0001', { ok: false, at: '2026-01-01T01:00:00.000Z' });
  assert.equal(row().fail_count, 2);

  assert.equal(db.markFollowAttempt(u.id, 'UCattempt0001', { ok: true, at: '2026-01-01T02:00:00.000Z' }), true);
  r = row();
  assert.equal(r.fail_count, 0, 'a success resets the backoff');
  assert.equal(r.last_checked_at, '2026-01-01T02:00:00.000Z');
  assert.equal(r.last_attempt_at, '2026-01-01T02:00:00.000Z');

  // An artist this user does not follow is not silently created or updated.
  assert.equal(db.markFollowAttempt(u.id, 'UCnotfollowed', { ok: false }), false);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM artist_follows WHERE artist_id = ?')
    .get('UCnotfollowed').n, 0);
});

test('the follow sweep serves healthy artists first and backs off the failing ones', () => {
  const u = db.createUser('follow-sweep', 'pw');
  const other = db.createUser('follow-sweep-other', 'pw');
  const t0 = '2026-01-01T00:00:00.000Z';
  const at = (ms) => new Date(Date.parse(t0) + ms).toISOString();

  for (const id of ['UCfailing01', 'UCfailing02', 'UCfailing03', 'UChealthy01']) {
    db.followArtist(u.id, { artistId: id, name: id });
  }
  db.followArtist(other.id, { artistId: 'UConlyother', name: 'onlyother' });
  // Three artists fail at t0; one has never been tried.
  for (const id of ['UCfailing01', 'UCfailing02', 'UCfailing03']) {
    db.markFollowAttempt(u.id, id, { ok: false, at: t0 });
  }

  // Inside the first hour of backoff, only the healthy artist is due — and it
  // is first, which is the whole point: failing artists cannot hog the sweep.
  const soon = db.followSweepDue(u.id, 10, at(30 * 60_000));
  assert.deepEqual(soon.map((a) => a.artistId), ['UChealthy01']);

  // Past the 1 h backoff the failures are due again, still behind the healthy one.
  const later = db.followSweepDue(u.id, 10, at(61 * 60_000));
  assert.deepEqual(later.map((a) => a.artistId),
    ['UChealthy01', 'UCfailing01', 'UCfailing02', 'UCfailing03']);
  assert.equal(later[0].failCount, 0);

  // Someone else's follows never leak into this user's sweep.
  assert.ok(!later.some((a) => a.artistId === 'UConlyother'));
  assert.deepEqual(db.followSweepDue(other.id, 10, at(30 * 60_000)).map((a) => a.artistId), ['UConlyother']);

  // A second failure puts that artist on the 2 h rung, behind its peers.
  db.markFollowAttempt(u.id, 'UCfailing01', { ok: false, at: at(2 * 60 * 60_000) });
  const mid = db.followSweepDue(u.id, 10, at(2.5 * 60 * 60_000));
  assert.deepEqual(mid.map((a) => a.artistId),
    ['UChealthy01', 'UCfailing02', 'UCfailing03']);

  // ...and the ladder is capped at a day: 5 fails is 16 h, 6+ is 24 h.
  db.followArtist(u.id, { artistId: 'UCladder0001', name: 'ladder' });
  for (let i = 0; i < 6; i += 1) db.markFollowAttempt(u.id, 'UCladder0001', { ok: false, at: t0 });
  const ids = (now) => db.followSweepDue(u.id, 50, now).map((a) => a.artistId);
  assert.ok(!ids(at(23 * 60 * 60_000)).includes('UCladder0001'), 'not due before 24 h');
  assert.ok(ids(at(24 * 60 * 60_000 + 60_000)).includes('UCladder0001'), 'due after 24 h');

  // The limit is honoured, and the ordering is stable across calls.
  assert.equal(db.followSweepDue(u.id, 2, at(25 * 60 * 60_000)).length, 2);
  assert.deepEqual(ids(at(25 * 60 * 60_000)), ids(at(25 * 60 * 60_000)));
});

test('a nested transaction joins the outer one instead of rolling it back', () => {
  const u = db.createUser('nested-tx', 'pw');
  db.transaction(() => {
    db.recordPlay({ userId: u.id, videoId: 'nested00001', kind: 'start' });
    // deleteTrack/deleteUser/recordReleases must be safe inside this.
    db.deleteTrack('nested00001');
    db.recordReleases('UCnested', [{ releaseId: 'r1', title: 'One' }]);
  });
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM plays WHERE user_id = ?').get(u.id).n, 0);
  assert.equal(db.knownReleases('UCnested').length, 1);
});

// ── the audit fixes ─────────────────────────────────────────────────────

test('an equal-timestamp like/dislike pair cannot leave a contradictory state', () => {
  // Migration 2 decides which of two contradictory actions wins. With a strict
  // `>` on one side and `>=` on the other, an equal created_at made the
  // statements disagree, and a `kind='like'` play row could outlive the like it
  // described. This drives the migration itself, in its own process, because
  // db.js opens its database at import and this file's copy has already run it.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-tie2-')), 'tie.db');
  const run = (code) => {
    const res = spawnSync(process.execPath, ['--no-warnings', '-e', code], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, SONORA_DB: file, SONORA_SECRET: 'db-tie-test', SONORA_PASSPHRASE: 'hunter2hunter2' },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `child failed:\n${res.stdout}\n${res.stderr}`);
    const line = res.stdout.split('\n').find((l) => l.startsWith('@@'));
    assert.ok(line, `no @@ marker:\n${res.stdout}`);
    return JSON.parse(line.slice(2));
  };
  const T = '2026-01-01T00:00:00.000Z';
  run(`
    const db = await import('./src/db.js');
    const u = db.createUser('tie-owner', 'pw');
    const sql = (q, ...args) => db.db.prepare(q).run(...args);
    sql('INSERT INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)', u.id, 'tie00000001', ${JSON.stringify(T)});
    sql('INSERT INTO dislikes (user_id, video_id, created_at) VALUES (?, ?, ?)', u.id, 'tie00000001', ${JSON.stringify(T)});
    sql("INSERT INTO plays (user_id, video_id, kind, created_at) VALUES (?, ?, 'like', ?)", u.id, 'tie00000001', ${JSON.stringify(T)});
    sql("INSERT INTO plays (user_id, video_id, kind, created_at) VALUES (?, ?, 'start', ?)", u.id, 'tie00000001', ${JSON.stringify(T)});
    db.db.exec('PRAGMA user_version = 1');
    console.log('@@' + JSON.stringify({ userId: u.id }));
  `);
  const got = run(`
    const db = await import('./src/db.js');
    const rows = (q) => db.db.prepare(q).all().map((r) => ({ ...r }));
    console.log('@@' + JSON.stringify({
      likes: rows('SELECT video_id, created_at FROM likes'),
      dislikes: rows('SELECT video_id, created_at FROM dislikes'),
      plays: rows('SELECT video_id, kind FROM plays ORDER BY kind'),
      conflicting: rows('SELECT l.video_id FROM likes l JOIN dislikes d USING (user_id, video_id)'),
      orphanLikePlays: rows("SELECT p.video_id FROM plays p WHERE p.kind = 'like'"
        + ' AND NOT EXISTS (SELECT 1 FROM likes l'
        + ' WHERE l.user_id = p.user_id AND l.video_id = p.video_id)'),
    }));
  `);
  // Exactly one of the two contradictory rows survives — never both.
  assert.equal(got.likes.length + got.dislikes.length, 1, JSON.stringify(got));
  assert.deepEqual(got.conflicting, []);
  // And the play log agrees with whatever won: no `kind='like'` row is left
  // behind for a like the migration deleted, and the listening history survives.
  assert.deepEqual(got.orphanLikePlays, []);
  assert.equal(got.plays.filter((p) => p.kind === 'start').length, 1, 'listening history is untouched');
  assert.equal(got.plays.filter((p) => p.kind === 'like').length, got.likes.length);
});

test('unfollowing the last follower drops the artist’s release bookkeeping', () => {
  const a = db.createUser('unfollow-a', 'pw');
  const b = db.createUser('unfollow-b', 'pw');
  const artistId = 'UCunfollowed1';
  db.followArtist(a.id, { artistId, name: 'Unfollowed' });
  db.followArtist(b.id, { artistId, name: 'Unfollowed' });
  db.recordReleases(artistId, [{ releaseId: 'rel1', title: 'One' }]);
  db.markArtistReleaseInitialized(artistId);
  const releases = () => db.db.prepare('SELECT COUNT(*) AS n FROM artist_releases WHERE artist_id = ?')
    .get(artistId).n;
  const state = () => db.db.prepare('SELECT COUNT(*) AS n FROM artist_release_state WHERE artist_id = ?')
    .get(artistId).n;

  // One follower leaving is not the end of the artist: r2 still needs the
  // baseline, or the next sweep would announce every old release to them.
  assert.equal(db.unfollowArtist(a.id, artistId), true);
  assert.equal(releases(), 1);
  assert.equal(state(), 1);
  // The last one leaving takes the artist-keyed rows with them, so a future
  // follower starts from a real baseline instead of a stale "initialized".
  assert.equal(db.unfollowArtist(b.id, artistId), true);
  assert.equal(releases(), 0);
  assert.equal(state(), 0);
  // Not following is a no-op, not a second delete.
  assert.equal(db.unfollowArtist(b.id, artistId), false);
});

test('room policy columns only accept their enum values', () => {
  const host = db.createUser('room-meta-host', 'pw');
  db.createRoomRow({ code: 'META01', hostId: host.id, state: { index: 0 } });
  const row = () => db.getRoomRow('META01');

  assert.equal(db.updateRoomMeta('META01', { visibility: 'private' }), true);
  assert.equal(row().visibility, 'private');
  assert.equal(db.updateRoomMeta('META01', { control: 'host' }), true);
  assert.equal(row().control, 'host');
  // The exact enums the routes accept: `anyone` is not one of them.
  assert.throws(() => db.updateRoomMeta('META01', { control: 'anyone' }), /everyone or host/);
  assert.throws(() => db.updateRoomMeta('META01', { visibility: 'friends' }), /public or private/);
  assert.equal(row().visibility, 'private', 'a rejected write changes nothing');
  assert.equal(row().control, 'host', 'a rejected control value cannot fail open');
  // Nothing to change is not an error, and an unknown room still reports false.
  assert.equal(db.updateRoomMeta('META01', {}), false);
  assert.equal(db.updateRoomMeta('NOPE01', { visibility: 'public' }), false);
  // The route layer keeps working unchanged.
  db.updateRoomMeta('META01', { visibility: 'public', control: 'everyone' });
  assert.equal(row().visibility, 'public');
  assert.equal(row().control, 'everyone');
});

test('reading an expired cache row does not write', () => {
  db.cacheSet('readonly:dead', { x: 1 }, -1);
  db.cacheSet('readonly:live', { x: 2 }, 60_000);
  assert.equal(db.cacheGet('readonly:dead'), null);
  // The row is still there: the read path returned null without a DELETE.
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM upstream_cache WHERE key = ?')
    .get('readonly:dead').n, 1);
  // The sweeper is the one owner of that deletion.
  assert.ok(db.pruneExpiredCache() >= 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM upstream_cache WHERE key = ?')
    .get('readonly:dead').n, 0);
  assert.deepEqual(db.cacheGet('readonly:live'), { x: 2 });
});

test('unreferenced old track metadata is pruned; anything referenced survives', () => {
  const u = db.createUser('prune-tracks', 'pw');
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const fresh = new Date().toISOString();
  const add = (videoId, seen) => db.db.prepare(`
    INSERT INTO tracks (video_id, title, channel, duration_s, thumb, first_seen, last_seen)
    VALUES (?, ?, NULL, NULL, NULL, ?, ?)
  `).run(videoId, videoId, old, seen);
  add('prunestale1', old);      // unreferenced and old: goes
  add('prunektorre1', old);     // older than the window but played
  add('prunektorre2', old);     // older than the window but liked
  add('prunektorre3', old);     // older than the window but disliked
  add('prunektorre4', old);     // older than the window but in a playlist
  add('prunekepme1', fresh);    // unreferenced but seen just now: stays
  db.recordPlay({ userId: u.id, videoId: 'prunektorre1', kind: 'start' });
  db.toggleLike(u.id, 'prunektorre2', true);
  db.toggleDislike(u.id, 'prunektorre3', true);
  const playlistId = db.createPlaylist(u.id, { title: 'Kept' });
  db.addPlaylistItem(u.id, playlistId, { videoId: 'prunektorre4' });

  const remaining = () => db.db.prepare('SELECT video_id FROM tracks ORDER BY video_id').all()
    .map((r) => r.video_id)
    .filter((id) => id.startsWith('prune'));
  assert.deepEqual(remaining(), [
    'prunekepme1', 'prunektorre1', 'prunektorre2', 'prunektorre3', 'prunektorre4', 'prunestale1',
  ]);

  const removed = db.pruneStaleTracks(180 * 86_400_000);
  assert.equal(removed, 1, 'only the unreferenced old row is deleted');
  assert.deepEqual(remaining(), [
    'prunekepme1', 'prunektorre1', 'prunektorre2', 'prunektorre3', 'prunektorre4',
  ]);
  // Nothing referenced was harmed.
  assert.equal(db.listLikes(u.id).some((l) => l.videoId === 'prunektorre2'), true);
  assert.equal(db.getPlaylist(u.id, playlistId).tracks.some((i) => i.videoId === 'prunektorre4'), true);
  assert.equal(db.pruneStaleTracks(0) >= 0, true, 'a zero window is allowed');
  assert.equal(db.pruneStaleTracks(Number.NaN), 0, 'junk windows delete nothing');
});
