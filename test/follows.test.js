import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Two layers, one file:
//
//  * unit — src/follows.js is driven with a fake `page`, so the diff/baseline
//    rules and the fan-out are proven without touching YouTube;
//  * HTTP — the real server (test/helpers/ux.js) is asked for the pinned
//    follow/notification contract, including the paths that must survive a dead
//    upstream.
//
// The unit layer needs its own database, so SONORA_DB is set before src/db.js is
// imported (it opens the file at import time). A mkdtemp directory keeps a
// crashed run from leaving a stale database behind for the next one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-follows-'));
process.env.SONORA_DB = path.join(TMP, 'follows.db');
process.env.SONORA_SECRET = 'follows-test-secret';
process.env.SONORA_PASSPHRASE = 'hunter2hunter2';

const db = await import('../src/db.js');
const { diffReleases, releaseUrl, releaseFromItem, checkArtist, pollFollows } =
  await import('../src/follows.js');
const { startServer } = await import('./helpers/ux.js');

// ── unit fixtures ───────────────────────────────────────────────────────

const ALBUM_ONE = { id: 'MPRunitAlbumOne01', title: 'First Album', year: '2019', type: 'Album', thumb: 'https://img.test/one.jpg' };
const ALBUM_TWO = { id: 'MPRunitAlbumTwo02', title: 'Second Album', year: '2024', type: 'Album', thumb: null };
const SINGLE_ONE = { id: 'MPRunitSingleOne1', title: 'A Single', year: '2021', type: 'Single', thumb: null };
const ALBUM_THREE = { id: 'MPRunitAlbumThree', title: 'Brand New Album', year: '2026', type: 'Album', thumb: 'https://img.test/three.jpg' };

/** A well-formed channel id, distinct per test so fixtures cannot collide. */
const artistId = (tag) => `UC${String(tag).padEnd(22, 'x')}`;

/** An artistPage()-shaped answer for one artist, from album/single rows. */
const pageOf = (id, { name = 'Fixture Artist', albums = [], singles = [] } = {}) =>
  async () => ({ id, name, thumb: 'https://img.test/artist.jpg', albums, singles, songs: [], videos: [], adjacent: [] });

/** A `page` that answers from a map and throws for anything else. */
function fakePage(pages) {
  return async (id) => {
    const page = pages[id];
    if (!page) throw new Error(`no fixture artist ${id}`);
    return page(id);
  };
}

/** These three tables are shared by every unit test; each one starts empty. */
function resetTables() {
  db.db.exec('DELETE FROM artist_follows; DELETE FROM artist_releases; DELETE FROM notifications;');
}

db.bootstrapUser();
const alice = db.createUser('follow-alice', 'pw');
const bob = db.createUser('follow-bob', 'pw');

// ── unit: the diff rules ────────────────────────────────────────────────

test('the first look at an artist is a baseline, not news', () => {
  const { fresh, baseline } = diffReleases([], [{ releaseId: 'MPRa' }, { releaseId: 'MPRb' }]);
  assert.deepEqual(fresh, [], 'following a band must not announce their back catalogue');
  assert.equal(baseline.length, 2);
});

test('a later look reports only ids we have not seen', () => {
  const { fresh, baseline } = diffReleases(['MPRa', 'MPRb'], [{ releaseId: 'MPRa' }, { releaseId: 'MPRb' }, { releaseId: 'MPRc' }]);
  assert.deepEqual(fresh.map((r) => r.releaseId), ['MPRc']);
  assert.deepEqual(baseline, []);
});

test('releaseFromItem normalises an album row and drops unusable ones', () => {
  assert.deepEqual(releaseFromItem(ALBUM_ONE), {
    releaseId: ALBUM_ONE.id,
    title: 'First Album',
    kind: 'album',
    year: '2019',
    thumb: 'https://img.test/one.jpg',
  });
  assert.equal(releaseFromItem(SINGLE_ONE).kind, 'single');
  assert.equal(releaseFromItem({ id: '', title: 'No id' }), null);
  assert.equal(releaseFromItem({ id: 'not-a-browse-id', title: 'Wrong id' }), null);
  assert.equal(releaseFromItem({ id: 'MPRnoTitle' }), null);
  assert.equal(releaseFromItem(null), null);
});

test('releaseUrl points at the in-app route the client can hash-assign', () => {
  assert.equal(releaseUrl({ releaseId: 'MPRunitAlbumOne01' }), '#/c/aMPRunitAlbumOne01');
  assert.equal(releaseUrl({ releaseId: 'VLPLunitPlaylist01' }), '#/c/aVLPLunitPlaylist01');
  assert.equal(releaseUrl({ videoId: 'dQw4w9WgXcQ' }), '#/t/dQw4w9WgXcQ');
  assert.equal(releaseUrl({}), null);
});

// ── unit: checkArtist ───────────────────────────────────────────────────

test('checkArtist records the back catalogue on the first check and notifies nothing', async () => {
  resetTables();
  const id = artistId('first');
  const page = pageOf(id, { albums: [ALBUM_ONE], singles: [SINGLE_ONE] });

  const first = await checkArtist(id, { page });
  assert.deepEqual(first.fresh, []);
  assert.equal(first.baseline.length, 2);
  assert.equal(first.name, 'Fixture Artist');
  assert.equal(db.knownReleases(id).length, 2, 'the baseline is persisted for the next check');
});

test('checkArtist reports exactly the release that appeared since the baseline', async () => {
  resetTables();
  const id = artistId('second');

  await checkArtist(id, { page: pageOf(id, { albums: [ALBUM_ONE] }) });
  const second = await checkArtist(id, { page: pageOf(id, { albums: [ALBUM_ONE, ALBUM_TWO] }) });

  assert.deepEqual(second.fresh.map((r) => r.releaseId), [ALBUM_TWO.id]);
  assert.equal(db.knownReleases(id).length, 2);

  // Third check, same page: nothing is new twice.
  const third = await checkArtist(id, { page: pageOf(id, { albums: [ALBUM_ONE, ALBUM_TWO] }) });
  assert.deepEqual(third.fresh, []);
});

// ── unit: pollFollows fan-out ───────────────────────────────────────────

test('two followers of one artist each get one notification and the release is stored once', async () => {
  resetTables();
  const id = artistId('shared');
  const pages = { [id]: pageOf(id, { albums: [ALBUM_ONE] }) };

  db.followArtist(alice.id, { artistId: id, name: 'Fixture Artist' });
  db.followArtist(bob.id, { artistId: id, name: 'Fixture Artist' });

  // First sweep: baseline only.
  const baselineRun = await pollFollows({ page: fakePage(pages) });
  assert.equal(baselineRun.checked, 1);
  assert.equal(baselineRun.created, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM artist_releases WHERE artist_id = ?').get(id).n, 1);

  // The artist releases something.
  pages[id] = pageOf(id, { albums: [ALBUM_ONE, ALBUM_THREE] });
  const run = await pollFollows({ page: fakePage(pages) });
  assert.equal(run.created, 2, 'one notification per follower');

  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM artist_releases WHERE artist_id = ?').get(id).n, 2,
    'a release is a fact about the artist: stored once, however many followers');

  for (const user of [alice, bob]) {
    const items = db.listNotifications(user.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'release');
    assert.equal(items[0].title, ALBUM_THREE.title);
    assert.equal(items[0].artistId, id);
    assert.equal(items[0].url, `#/c/a${ALBUM_THREE.id}`);
    assert.match(items[0].body, /New album from Fixture Artist/);
    assert.equal(db.countUnread(user.id), 1);
  }
});

test('re-running the poll creates no new rows (dedupe is the idempotency key)', async () => {
  resetTables();
  const id = artistId('dedupe');
  db.followArtist(alice.id, { artistId: id, name: 'Fixture Artist' });
  const pages = { [id]: pageOf(id, { albums: [ALBUM_ONE] }) };

  await pollFollows({ page: fakePage(pages) });            // baseline
  pages[id] = pageOf(id, { albums: [ALBUM_ONE, ALBUM_TWO] });
  const first = await pollFollows({ page: fakePage(pages) });
  assert.equal(first.created, 1);

  const again = await pollFollows({ page: fakePage(pages) });
  assert.equal(again.created, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1);
});

test('one artist failing does not stop the sweep, and is retried next time', async () => {
  resetTables();
  const broken = artistId('broken');
  const healthy = artistId('healthy');
  const pages = {
    [broken]: async () => { throw new Error('upstream said no'); },
    [healthy]: pageOf(healthy, { name: 'Healthy Artist', albums: [ALBUM_ONE] }),
  };
  db.followArtist(alice.id, { artistId: broken, name: 'Broken Artist' });
  db.followArtist(bob.id, { artistId: healthy, name: 'Healthy Artist' });

  const run = await pollFollows({ page: fakePage(pages) });
  assert.equal(run.checked, 1, 'the healthy artist was still checked');
  assert.equal(run.created, 0, 'its catalogue is a baseline, not news');
  assert.equal(db.knownReleases(healthy).length, 1);

  const touched = (id) => db.db.prepare('SELECT last_checked_at AS at FROM artist_follows WHERE artist_id = ?')
    .get(id).at;
  assert.equal(touched(broken), null, 'a failed check stays at the front of the queue');
  assert.ok(touched(healthy), 'a successful check is stamped');
});

test('a manual check after a follow of a dead channel is quiet, not a flood', async () => {
  resetTables();
  const id = artistId('empty');
  db.followArtist(alice.id, { artistId: id, name: 'Nobody' });

  // A page that answers with no releases at all (a channel with nothing
  // catalogued, which is what a bogus-but-well-formed id produces).
  const run = await pollFollows({ page: pageOf(id, { name: null, albums: [], singles: [] }) });
  assert.equal(run.created, 0);
  assert.equal(db.countUnread(alice.id), 0);
});

// ── unit: notification store ────────────────────────────────────────────

test('marking read only ever touches the caller’s own rows', () => {
  resetTables();
  const mine = db.addNotification({
    userId: alice.id, kind: 'release', title: 'Mine', dedupe: 'release:X:1', url: '#/c/aMPR1',
  });
  db.addNotification({ userId: bob.id, kind: 'release', title: 'Theirs', dedupe: 'release:X:1', url: '#/c/aMPR1' });
  assert.equal(mine, true);
  assert.equal(db.countUnread(alice.id), 1);
  assert.equal(db.countUnread(bob.id), 1);

  const theirId = db.listNotifications(bob.id)[0].id;
  assert.equal(db.markNotificationsRead(alice.id, [theirId]), 0, 'another user’s id is a no-op');
  assert.equal(db.countUnread(bob.id), 1);
  // A JSON body can carry junk; none of it may be read as an id.
  assert.equal(db.markNotificationsRead(alice.id, [true, 'abc', null, -1, 1.5]), 0);
  assert.equal(db.countUnread(alice.id), 1);

  assert.equal(db.markNotificationsRead(alice.id, db.listNotifications(alice.id).map((n) => n.id)), 1);
  assert.equal(db.countUnread(alice.id), 0);

  db.addNotification({ userId: alice.id, kind: 'release', title: 'Another', dedupe: 'release:X:2' });
  db.markAllNotificationsRead(alice.id);
  assert.equal(db.countUnread(alice.id), 0);
  assert.equal(db.countUnread(bob.id), 1, 'read-all is scoped to the caller too');
});

test('addNotification is idempotent on its dedupe key', () => {
  resetTables();
  const args = { userId: alice.id, kind: 'release', title: 'Once', dedupe: 'release:Y:1' };
  assert.equal(db.addNotification(args), true);
  assert.equal(db.addNotification(args), false);
  assert.equal(db.listNotifications(alice.id).length, 1);
});

test('the sweep queue is least-recently-checked first, and never walks the catalogue', () => {
  resetTables();
  const older = artistId('older');
  const newer = artistId('newer');
  db.followArtist(alice.id, { artistId: older, name: 'Older' });
  db.followArtist(alice.id, { artistId: newer, name: 'Newer' });
  db.touchFollowChecked(older, '2020-01-01T00:00:00.000Z');
  db.touchFollowChecked(newer, '2021-01-01T00:00:00.000Z');

  assert.deepEqual(db.listFollowsToCheck(1).map((r) => r.artistId), [older], 'the limit is per artist');
  assert.deepEqual(db.listFollowsToCheck(5).map((r) => r.artistId), [older, newer]);

  // Never checked sorts ahead of everything: a fresh follow is the next thing a
  // sweep should learn about.
  const fresh = artistId('never');
  db.followArtist(alice.id, { artistId: fresh, name: 'Fresh' });
  db.followArtist(bob.id, { artistId: fresh, name: 'Fresh' });
  const [next] = db.listFollowsToCheck(1);
  assert.equal(next.artistId, fresh);
  assert.equal(next.followers, 2, 'one row per artist, with the follower count');
});

test('deleting a user takes their follows and notifications with them', () => {
  resetTables();
  const doomed = db.createUser('follow-doomed', 'pw');
  const id = artistId('doomed');
  db.followArtist(doomed.id, { artistId: id, name: 'Fixture Artist' });
  db.recordReleases(id, [{ releaseId: 'MPRgone', title: 'Gone', kind: 'album' }]);
  db.addNotification({ userId: doomed.id, kind: 'release', title: 'Gone', dedupe: `release:${id}:MPRgone` });

  assert.equal(db.deleteUser(doomed.id), true);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM artist_follows WHERE user_id = ?').get(doomed.id).n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(doomed.id).n, 0);
  // The release itself stays: it is a fact about the artist, not about who
  // followed them, so the next follower still gets a quiet baseline.
  assert.equal(db.knownReleases(id).length, 1);
});

// ── HTTP: the pinned contract ───────────────────────────────────────────

// A well-formed channel id that cannot exist. The baseline fetch will fail or
// answer empty, which is exactly the path being tested: following is a local
// decision and must survive a dead upstream.
const HTTP_ARTIST = `UC${'httpfollows'.padEnd(22, 'z')}`;

let server;
let cookie = '';

const jfetch = async (p, { cookie: jarOverride, ...opts } = {}) => {
  const jar = jarOverride ?? cookie;
  const res = await fetch(server.base + p, {
    ...opts,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: jar } : {}),
      ...opts.headers,
    },
  });
  const sc = res.headers.getSetCookie?.()[0];
  if (sc && !jarOverride) cookie = sc.split(';')[0];
  const isJson = res.headers.get('content-type')?.includes('json');
  return { status: res.status, body: isJson ? await res.json() : null };
};

/** A second, independent session — for proving per-user answers are not shared. */
async function loginAs(name, passphrase) {
  const res = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, passphrase }),
  });
  if (!res.ok) throw new Error(`login as ${name} failed: ${res.status} ${await res.text()}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  if (!raw) throw new Error(`login as ${name} returned no cookie`);
  return raw.split(';')[0];
}

/** The server's own database, for seeding rows a test cannot create over HTTP. */
function serverDb() {
  const d = new DatabaseSync(path.join(server.dir, 'ux.db'));
  d.exec('PRAGMA busy_timeout = 5000');
  return d;
}

before(async () => {
  server = await startServer();
});

after(async () => {
  await server?.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('the follow and notification routes require a session', async () => {
  for (const [p, method] of [
    ['/api/follows', 'GET'],
    ['/api/notifications', 'GET'],
    ['/api/notifications/check', 'POST'],
    [`/api/artists/${HTTP_ARTIST}/follow`, 'POST'],
    [`/api/artists/${HTTP_ARTIST}/follow`, 'DELETE'],
  ]) {
    const res = await fetch(server.base + p, { method });
    assert.equal(res.status, 401, `${method} ${p} should be protected`);
  }
});

test('sign in', async () => {
  const { status } = await jfetch('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  assert.equal(status, 200);
  assert.ok(cookie, 'a session cookie came back');
});

test('a follow needs a channel id', async () => {
  for (const bad of ['radiohead', 'PLabc', 'UCshort', '']) {
    const { status } = await jfetch(`/api/artists/${encodeURIComponent(bad)}/follow`, {
      method: 'POST', body: JSON.stringify({ name: 'Nope' }),
    });
    assert.equal(status, 400, `"${bad}" is not a channel id`);
  }
});

test('follow → list → artist page → unfollow, and following twice is idempotent', async () => {
  const first = await jfetch(`/api/artists/${HTTP_ARTIST}/follow`, {
    method: 'POST', body: JSON.stringify({ name: 'HTTP Fixture Artist', thumb: 'https://img.test/a.jpg' }),
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { following: true, artistId: HTTP_ARTIST, name: 'HTTP Fixture Artist' });

  const list = await jfetch('/api/follows');
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  const [row] = list.body.items;
  assert.equal(row.artistId, HTTP_ARTIST);
  assert.equal(row.name, 'HTTP Fixture Artist');
  assert.equal(row.thumb, 'https://img.test/a.jpg');
  assert.ok(row.since, 'since is the follow date');
  assert.ok('lastCheckedAt' in row);

  // Following again must not duplicate the row or reset the follow date.
  const again = await jfetch(`/api/artists/${HTTP_ARTIST}/follow`, {
    method: 'POST', body: JSON.stringify({ name: 'HTTP Fixture Artist' }),
  });
  assert.equal(again.status, 200);
  const relisted = await jfetch('/api/follows');
  assert.equal(relisted.body.items.length, 1);
  assert.equal(relisted.body.items[0].since, row.since);

  // The artist page answers for the current user…
  const artist = await jfetch(`/api/artist/${HTTP_ARTIST}`);
  assert.equal(artist.status, 200);
  assert.equal(artist.body.following, true);

  const gone = await jfetch(`/api/artists/${HTTP_ARTIST}/follow`, { method: 'DELETE' });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body, { following: false, artistId: HTTP_ARTIST });
  assert.deepEqual((await jfetch('/api/follows')).body.items, []);

  // …and `following` is computed after the artist cache read, so the second
  // (cached) response must not repeat the first one's answer.
  const cached = await jfetch(`/api/artist/${HTTP_ARTIST}`);
  assert.equal(cached.status, 200);
  assert.equal(cached.body.following, false, 'the cached payload must not bake in one user’s flag');
});

test('notifications keep their shape, order and unread count, and can be read', async () => {
  // Seed two rows (one already read) straight into the server's database: the
  // only HTTP path that creates notifications is a live release, which is not
  // something a test should depend on.
  const sdb = serverDb();
  try {
    const uid = sdb.prepare("SELECT id FROM users WHERE name = 'toil'").get().id;
    const insert = sdb.prepare(`
      INSERT INTO notifications
        (user_id, kind, title, body, thumb, url, artist_id, artist_name, video_id, dedupe, created_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(uid, 'release', 'Older Release', 'New album from Old Artist', null,
      '#/c/aMPRolder0000001', 'UColder000000000000000000', 'Old Artist', null,
      'release:UColder000000000000000000:MPRolder0000001', '2020-01-01T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z');
    insert.run(uid, 'release', 'Newer Release', 'New single from New Artist', null,
      '#/c/aMPRnewer0000001', 'UCnewer000000000000000000', 'New Artist', null,
      'release:UCnewer000000000000000000:MPRnewer0000001', '2021-01-01T00:00:00.000Z', null);
  } finally {
    sdb.close();
  }

  const { status, body } = await jfetch('/api/notifications?limit=500');
  assert.equal(status, 200);
  assert.equal(body.unread, 1);
  assert.equal(body.items.length, 2);
  // Newest first.
  assert.deepEqual(body.items.map((n) => n.title), ['Newer Release', 'Older Release']);
  // Exactly the pinned shape, no more and no less.
  assert.deepEqual(Object.keys(body.items[0]).sort(), [
    'artistId', 'artistName', 'body', 'createdAt', 'id', 'kind', 'readAt', 'thumb', 'title', 'url', 'videoId',
  ]);

  const unreadId = body.items[0].id;
  const read = await jfetch('/api/notifications/read', {
    method: 'POST', body: JSON.stringify({ ids: [unreadId, 999999] }),
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.unread, 0, 'a forged id is ignored, the real one is marked');

  // The read-all route is what the bell's "mark everything read" does.
  const all = await jfetch('/api/notifications/read-all', { method: 'POST' });
  assert.equal(all.status, 200);
  assert.equal(all.body.unread, 0);
});

test('the cached artist page does not carry one user’s following flag', async () => {
  // An artist page is cached for ten minutes and shared by every account, so
  // `following` must be computed after the cache read. Two sessions are the only
  // way to prove it: the first user warms the cache while following, the second
  // reads the same cached page while not following.
  await jfetch(`/api/artists/${HTTP_ARTIST}/follow`, {
    method: 'POST', body: JSON.stringify({ name: 'HTTP Fixture Artist' }),
  });
  const mine = await jfetch(`/api/artist/${HTTP_ARTIST}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.following, true);

  const created = await jfetch('/api/admin/users', {
    method: 'POST', body: JSON.stringify({ name: 'follow-other', passphrase: 'hunter2hunter2' }),
  });
  assert.equal(created.status, 201, 'the admin can create the second account');
  const other = await loginAs('follow-other', 'hunter2hunter2');

  const theirs = await jfetch(`/api/artist/${HTTP_ARTIST}`, { cookie: other });
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.following, false, 'a cached page must not hand over another user’s flag');

  // And the other user reading the cache must not overwrite the first user's view.
  assert.equal((await jfetch(`/api/artist/${HTTP_ARTIST}`)).body.following, true);

  await jfetch(`/api/artists/${HTTP_ARTIST}/follow`, { method: 'DELETE' });
});

test('a manual check is throttled to once a minute per user', async () => {
  await jfetch(`/api/artists/${HTTP_ARTIST}/follow`, {
    method: 'POST', body: JSON.stringify({ name: 'HTTP Fixture Artist' }),
  });
  const first = await jfetch('/api/notifications/check', { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(typeof first.body.created, 'number');
  assert.equal(typeof first.body.unread, 'number');
  assert.ok(!first.body.throttled, 'the first check in the window runs');

  const second = await jfetch('/api/notifications/check', { method: 'POST' });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { created: 0, unread: second.body.unread, throttled: true });

  await jfetch(`/api/artists/${HTTP_ARTIST}/follow`, { method: 'DELETE' });
});
