import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// One search request has to answer with songs, artists, albums AND playlists so
// the client's All / Songs / Albums / Artists / Playlists tabs can switch
// without re-querying. Live YouTube is touched exactly like test/library.test.js
// does; nothing is faked, and an empty upstream answer is reported as a skip
// (the same treatment e2e.test.js gives a bot-gated stream) rather than a pass.

const PORT = 8143;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = new URL(`./.tmp/search-types-${Date.now()}.db`, import.meta.url).pathname;
const AUDIO = new URL(`./.tmp/search-types-audio-${Date.now()}`, import.meta.url).pathname;

let proc;
let cookie = '';

const jfetch = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...opts.headers,
    },
  });
  const sc = res.headers.getSetCookie?.()[0];
  if (sc) cookie = sc.split(';')[0];
  const isJson = res.headers.get('content-type')?.includes('json');
  return { res, body: isJson ? await res.json() : null };
};

before(async () => {
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'search-types-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn',
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
      // previous run's database — and its search routes may be the old ones.
      // Only the pid we spawned counts as ours.
      const health = r.ok ? await r.json() : null;
      if (health?.pid === proc.pid) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start:\n${logs.join('')}`);
});

after(() => proc?.kill('SIGTERM'));

test('search requires a session', async () => {
  const r = await fetch(`${BASE}/api/search?q=radiohead`);
  assert.equal(r.status, 401);
});

test('sign in', async () => {
  const { res } = await jfetch('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 200);
});

test('missing q is a 400', async () => {
  const { res, body } = await jfetch('/api/search');
  assert.equal(res.status, 400);
  assert.equal(body.error, 'Missing q.');
});

test('an unknown type is a 400', async () => {
  const { res, body } = await jfetch('/api/search?q=radiohead&type=nonsense');
  assert.equal(res.status, 400);
  assert.equal(body.error, 'Unknown type.');
});

test('a specific type returns the full shape with the other arrays empty', async () => {
  const { res, body } = await jfetch('/api/search?q=radiohead&type=song');
  assert.equal(res.status, 200);
  assert.equal(body.q, 'radiohead');
  // The contract is one shape for every request: a client rendering a filtered
  // tab must not have to branch on which arrays exist.
  for (const key of ['tracks', 'artists', 'albums', 'playlists']) {
    assert.ok(Array.isArray(body[key]), `${key} is always an array`);
  }
  assert.equal(body.counts.tracks, body.tracks.length);
  assert.equal(body.counts.artists, 0);
  assert.equal(body.counts.albums, 0);
  assert.equal(body.counts.playlists, 0);
  assert.deepEqual(body.artists, []);
  assert.deepEqual(body.albums, []);
  assert.deepEqual(body.playlists, []);
  assert.ok(body.tracks.length > 0, 'songs for a band name');
});

let first = null;

test('one request answers with songs, artists, albums and playlists', async (t) => {
  const { res, body } = await jfetch('/api/search?q=radiohead');
  assert.equal(res.status, 200);
  assert.equal(body.q, 'radiohead');

  // Nothing at all came back: that is YouTube refusing or being unreachable,
  // not a missing shelf. Skip with the reason instead of asserting a lie.
  const empty = body.tracks.length + body.artists.length + body.albums.length + body.playlists.length === 0;
  if (empty) {
    t.skip('search upstream returned nothing for "radiohead" (bot gate or offline)');
    return;
  }

  assert.ok(Array.isArray(body.tracks) && body.tracks.length > 0, 'songs are still returned');
  assert.ok(Array.isArray(body.artists) && body.artists.length > 0, 'an artist was found for a band name');
  assert.ok(Array.isArray(body.albums) && body.albums.length > 0, 'albums are part of the same answer');
  assert.ok(Array.isArray(body.playlists) && body.playlists.length > 0, 'playlists are part of the same answer');

  // counts is the client's tab badge, so it has to describe the arrays it ships.
  assert.deepEqual(body.counts, {
    tracks: body.tracks.length,
    artists: body.artists.length,
    albums: body.albums.length,
    playlists: body.playlists.length,
  });

  for (const a of body.albums) {
    assert.match(a.id, /^MPR[\w-]+$/, `album id is a Music release id, got ${a.id}`);
    assert.equal(a.type, 'Album');
    assert.ok(a.title, 'the album is named');
  }
  for (const p of body.playlists) {
    assert.match(p.id, /^(?:VL)?PL[\w-]+$/, `playlist id is an openable list, got ${p.id}`);
    assert.equal(p.type, 'Playlist');
    assert.ok(p.title, 'the playlist is named');
  }
  for (const a of body.artists) {
    assert.match(a.id, /^UC[\w-]{20,}$/, 'the artist carries a channel id');
    assert.ok(a.title, 'the artist is named');
  }
  first = body;
});

test('the whole answer is cached, so repeating a search does not re-query', async (t) => {
  if (!first) {
    t.skip('no search answer to repeat (see the previous skip reason)');
    return;
  }
  const t0 = Date.now();
  const { res, body } = await jfetch('/api/search?q=radiohead');
  assert.equal(res.status, 200);
  // A cache hit returns the identical shelves; a re-query would not be bit-equal
  // (views and track counts move) and would take a round trip to YouTube.
  assert.deepEqual(body, first);
  assert.ok(Date.now() - t0 < 1500, 'a repeated search should be a cache hit');
});

test('the albums tab is served from the same cached shelf', async (t) => {
  if (!first) {
    t.skip('no search answer to filter (see the earlier skip reason)');
    return;
  }
  const { res, body } = await jfetch('/api/search?q=radiohead&type=album');
  assert.equal(res.status, 200);
  assert.deepEqual(body.tracks, []);
  assert.deepEqual(body.artists, []);
  assert.deepEqual(body.playlists, []);
  assert.deepEqual(body.albums, first.albums, 'the album tab reuses the All tab shelf');
  assert.equal(body.counts.albums, first.albums.length);
});

test('concurrent searches for one query agree and all succeed', async (t) => {
  // Three tabs (or a double-tap) asking the same thing at once: the server
  // shares one upstream call, so every answer is the same and none is a
  // half-filled shape from a race.
  const results = await Promise.all([
    jfetch('/api/search?q=portishead'),
    jfetch('/api/search?q=portishead'),
    jfetch('/api/search?q=portishead'),
  ]);
  for (const { res } of results) assert.equal(res.status, 200);
  const [a, b, c] = results.map((r) => r.body);
  const empty = a.tracks.length + a.albums.length + a.playlists.length === 0;
  if (empty) {
    t.skip('search upstream returned nothing for "portishead" (bot gate or offline)');
    return;
  }
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.deepEqual(a.counts, {
    tracks: a.tracks.length,
    artists: a.artists.length,
    albums: a.albums.length,
    playlists: a.playlists.length,
  });
});
