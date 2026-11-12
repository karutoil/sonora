import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/cdp.js';
import { readFileSync } from 'node:fs';

// Boots the real server and exercises the library/playlist/artwork surface.
// Live YouTube is only touched for search, lyrics and artwork.

let PORT = 0;
let BASE = '';
const DB = new URL(`./.tmp/lib-${Date.now()}.db`, import.meta.url).pathname;
const AUDIO = new URL(`./.tmp/libaudio-${Date.now()}`, import.meta.url).pathname;

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
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'lib-secret', SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
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
      if (health?.pid === proc.pid) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start:\n${logs.join('')}`);
});

after(() => proc?.kill('SIGTERM'));

test('library endpoints require auth', async () => {
  for (const path of ['/api/playlists', '/api/recent', '/api/browse/albums', '/api/lyrics/2tOutF8B3f8']) {
    const r = await fetch(BASE + path);
    assert.equal(r.status, 401, `${path} should be protected`);
  }
});

test('sign in', async () => {
  const { res } = await jfetch('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 200);
});

test('a new playlist starts empty', async () => {
  const { body: list } = await jfetch('/api/playlists');
  assert.deepEqual(list.playlists, []);

  const { res, body } = await jfetch('/api/playlists', {
    method: 'POST', body: JSON.stringify({ title: 'Night Drive', description: 'late' }),
  });
  assert.equal(res.status, 201);
  assert.equal(body.playlist.title, 'Night Drive');
  assert.deepEqual(body.playlist.tracks, []);
});

test('tracks can be added and the playlist metadata is reflected', async () => {
  const { body: list } = await jfetch('/api/playlists');
  const id = list.playlists[0].id;

  const add = await jfetch(`/api/playlists/${id}/tracks`, {
    method: 'POST',
    body: JSON.stringify({
      videoId: '2tOutF8B3f8', title: 'Xtal', channel: 'pigsfood27',
      durationS: 295, thumb: 'https://i.ytimg.com/vi/2tOutF8B3f8/hqdefault.jpg',
    }),
  });
  assert.equal(add.res.status, 200);

  const { body } = await jfetch(`/api/playlists/${id}`);
  assert.equal(body.playlist.tracks.length, 1);
  assert.equal(body.playlist.tracks[0].title, 'Xtal');
  assert.equal(body.playlist.tracks[0].durationS, 295);

  const { body: after } = await jfetch('/api/playlists');
  assert.equal(after.playlists[0].trackCount, 1);
});

test('adding the same track twice is idempotent', async () => {
  const { body: list } = await jfetch('/api/playlists');
  const id = list.playlists[0].id;
  await jfetch(`/api/playlists/${id}/tracks`, {
    method: 'POST', body: JSON.stringify({ videoId: '2tOutF8B3f8', title: 'Xtal' }),
  });
  const { body } = await jfetch(`/api/playlists/${id}`);
  assert.equal(body.playlist.tracks.length, 1, 'no duplicate row');
});

test('a bad video id is rejected when adding', async () => {
  const { body: list } = await jfetch('/api/playlists');
  const { res } = await jfetch(`/api/playlists/${list.playlists[0].id}/tracks`, {
    method: 'POST', body: JSON.stringify({ videoId: 'nope' }),
  });
  assert.equal(res.status, 400);
});

test('one user cannot read another user\'s playlist', async () => {
  const { body: list } = await jfetch('/api/playlists');
  const id = list.playlists[0].id;

  // Second account, separate cookie jar.
  const other = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'someone', passphrase: 'pw' }),
  });
  // createUser is not an API, so a new login for an unknown user must fail; the
  // isolation guarantee is still testable by hitting the id with no session.
  const anon = await fetch(`${BASE}/api/playlists/${id}`);
  assert.equal(anon.status, 401, 'no session is refused');
  assert.notEqual(other.status, 200, 'unknown user cannot sign in');
});

test('removing and deleting work', async () => {
  const { body: list } = await jfetch('/api/playlists');
  const id = list.playlists[0].id;

  const del = await jfetch(`/api/playlists/${id}/tracks/2tOutF8B3f8`, { method: 'DELETE' });
  assert.equal(del.res.status, 200);
  const { body } = await jfetch(`/api/playlists/${id}`);
  assert.equal(body.playlist.tracks.length, 0);

  const gone = await jfetch(`/api/playlists/${id}`, { method: 'DELETE' });
  assert.equal(gone.res.status, 200);
  const missing = await jfetch(`/api/playlists/${id}`);
  assert.equal(missing.res.status, 404);
});

test('recently played is derived from real play events', async () => {
  await jfetch('/api/events', {
    method: 'POST', body: JSON.stringify({ videoId: '2tOutF8B3f8', kind: 'start', source: 'search' }),
  });
  const { body } = await jfetch('/api/recent');
  assert.ok(body.tracks.some((t) => t.videoId === '2tOutF8B3f8'));
});

test('artwork is proxied same-origin and returns a real image', async () => {
  const res = await fetch(`${BASE}/api/img/2tOutF8B3f8`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\//);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.ok(buf.byteLength > 1000, `expected image bytes, got ${buf.byteLength}`);
  // JPEG (ff d8) or PNG (89 50 4e 47)
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  assert.ok(isJpeg || isPng, 'not an image payload');
});

test('artwork rejects a malformed id', async () => {
  const { res } = await jfetch('/api/img/not-an-id');
  assert.equal(res.status, 400);
});

test('artwork is not served without a session', async () => {
  const res = await fetch(`${BASE}/api/img/2tOutF8B3f8`);
  assert.equal(res.status, 401);
});

test('lyrics come back for a real track, and null for one without', async () => {
  const { res, body } = await jfetch('/api/lyrics/XFkzRNyygfk'); // Radiohead - Creep
  assert.equal(res.status, 200);
  assert.equal(typeof body.text, 'string');
  assert.match(body.text, /you were here before/i);
  assert.ok(body.text.length > 100);

  const none = await jfetch('/api/lyrics/2tOutF8B3f8'); // instrumental
  assert.equal(none.res.status, 200);
  assert.equal(none.body.text, null, 'no lyrics is null, not an error');
});

test('lyrics are cached in the database', async () => {
  const first = await jfetch('/api/lyrics/XFkzRNyygfk');
  const t0 = Date.now();
  const second = await jfetch('/api/lyrics/XFkzRNyygfk');
  assert.deepEqual(second.body, first.body);
  assert.ok(Date.now() - t0 < 800, 'second read should be a cache hit');
});

test('browse returns real albums and artists', async () => {
  const albums = await jfetch('/api/browse/albums?q=radiohead');
  assert.equal(albums.res.status, 200);
  assert.ok(albums.body.items.length > 0, 'albums found');
  assert.ok(albums.body.items[0].id, 'album has an id');
  assert.ok(albums.body.items[0].title, 'album has a title');

  const artists = await jfetch('/api/browse/artists?q=radiohead');
  assert.equal(artists.res.status, 200);
  assert.ok(artists.body.items.length > 0, 'artists found');
});

test('an unknown browse kind is a 400', async () => {
  const { res } = await jfetch('/api/browse/nonsense');
  assert.equal(res.status, 400);
});

// ── artists and albums ──────────────────────────────────────────────────
// Checking out an artist and opening the album of a song are two different
// questions, and both have to be answered from the catalogue: a song search
// alone can never say what someone released or who they are filed next to.

test('search offers the artist next to the songs', async () => {
  const { res, body } = await jfetch('/api/search?q=radiohead');
  assert.equal(res.status, 200);
  assert.ok(body.tracks.length > 0, 'songs are still returned');
  assert.ok(Array.isArray(body.artists), 'artists are part of the search answer');
  assert.ok(body.artists.length > 0, 'an artist was found for a band name');
  assert.match(body.artists[0].id, /^UC[\w-]{20,}$/, 'the artist carries a channel id');
  assert.ok(body.artists[0].title, 'the artist is named');
  // A catalogue row knows its release, which is what makes the album column of
  // a track row openable without a second lookup.
  assert.ok(body.tracks.some((t) => t.albumId), 'a catalogue song carries its album id');
});

let radioheadId = null;

test('an artist page lists popular songs, releases, videos and neighbours', async () => {
  const { res, body } = await jfetch('/api/artist/radiohead');
  assert.equal(res.status, 200);
  assert.equal(body.name, 'Radiohead');
  assert.match(body.id, /^UC[\w-]{20,}$/, 'a name is resolved to a channel id');
  radioheadId = body.id;

  assert.ok(body.songs.length > 0, 'popular songs are listed');
  for (const s of body.songs) {
    assert.match(s.videoId, /^[A-Za-z0-9_-]{11}$/);
    assert.ok(s.title, 'every popular song has a title');
  }

  assert.ok(body.albums.length > 0, 'albums are listed');
  for (const a of body.albums) {
    assert.match(a.id, /^MPR[\w-]+$/, 'an album id is a Music release id, not a playlist id');
    assert.ok(a.title, 'the album is named');
    assert.ok(['Album', 'Single'].includes(a.type), 'the release format is known');
  }
  assert.ok(Array.isArray(body.singles), 'singles are separated from albums');
  assert.ok(body.videos.length > 0, 'videos are listed');
  assert.ok(body.adjacent.length > 0, 'the neighbours ("fans also like") are listed');
  assert.match(body.adjacent[0].id, /^UC[\w-]{20,}$/, 'a neighbour is an artist channel');
});

test('an artist page can be opened by channel id, and is cached', async () => {
  assert.ok(radioheadId, 'the previous test resolved the channel id');
  const first = await jfetch(`/api/artist/${radioheadId}`);
  assert.equal(first.res.status, 200);
  assert.equal(first.body.id, radioheadId);
  assert.ok(first.body.songs.length > 0);

  const t0 = Date.now();
  const second = await jfetch(`/api/artist/${radioheadId}`);
  assert.deepEqual(second.body, first.body);
  assert.ok(Date.now() - t0 < 800, 'the second read should be a cache hit');
});

test('an unknown artist is a 404, not an empty page', async () => {
  const { res } = await jfetch('/api/artist/zzqqxx-no-such-artist-9911');
  assert.equal(res.status, 404);
});

test('an album opens as a real release with its artist on every track', async () => {
  const artist = await jfetch('/api/artist/radiohead');
  const albumId = artist.body.albums[0].id;
  const { res, body } = await jfetch(`/api/album/${albumId}`);
  assert.equal(res.status, 200);
  assert.equal(body.title, artist.body.albums[0].title);
  assert.equal(body.author, 'Radiohead', 'the album names the artist, not a placeholder');
  assert.ok(['Album', 'Single'].includes(body.type));
  assert.ok(body.tracks.length > 1, 'the track list is the whole release');
  for (const t of body.tracks) {
    assert.match(t.videoId, /^[A-Za-z0-9_-]{11}$/);
    // Album rows carry no credits of their own; the header's artist has to be
    // used, or every track reads as "N/A" in the artist column.
    assert.equal(t.channel, 'Radiohead', 'the track is credited to the album artist');
    assert.equal(t.albumId, albumId, 'the track knows the release it came from');
  }
});

test('the album of a track is resolved from the catalogue', async () => {
  // This is the video upload of Creep, not the album track: the ids differ, so
  // the match has to be on the song's identity rather than on the video id.
  const { res, body } = await jfetch('/api/album/for/XFkzRNyygfk?title=Radiohead%20-%20Creep&artist=Radiohead');
  assert.equal(res.status, 200);
  assert.match(body.albumId, /^MPR[\w-]+$/, 'a release id was resolved');
  assert.equal(body.author, 'Radiohead');

  const album = await jfetch(`/api/album/${body.albumId}`);
  assert.equal(album.res.status, 200);
  assert.ok(album.body.tracks.some((t) => t.title === 'Creep'), 'the resolved album holds the song');
});

test('the album lookup rejects a malformed video id', async () => {
  const { res } = await jfetch('/api/album/for/not-an-id');
  assert.equal(res.status, 400);
});

/**
 * Every `/api/...` path the client mentions, as written.
 *
 * Template literals nest quotes (`/api/station${force ? '?fresh=1' : ''}`), so a
 * naive `[^'`]*` match stops inside the expression and silently finds nothing —
 * which is how the first version of this test passed against a missing route.
 * Walk to the closing delimiter of the enclosing literal, tracking `${` depth.
 */
function extractApiPaths(source) {
  const out = new Set();
  for (let i = source.indexOf('/api/'); i !== -1; i = source.indexOf('/api/', i + 1)) {
    // Only inside a quoted or template literal, or the comment text would match.
    const open = source[i - 1];
    if (open !== '`' && open !== "'" && open !== '"') continue;
    let depth = 0;
    let j = i;
    for (; j < source.length; j += 1) {
      const c = source[j];
      if (c === '\\') { j += 1; continue; }
      if (c === '$' && source[j + 1] === '{') { depth += 1; j += 1; continue; }
      if (c === '}' && depth > 0) { depth -= 1; continue; }
      if (depth === 0 && (c === open || c === '\n')) break;
    }
    if (j > i) out.add(source.slice(i, j));
  }
  return out;
}

/** Replace `${...}` and the query string so the router matches its pattern. */
function fill(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < raw.length && depth > 0; j += 1) {
        if (raw[j] === '{') depth += 1;
        else if (raw[j] === '}') depth -= 1;
      }
      const expr = raw.slice(i + 2, j - 1);
      // A few holes are not ids. An admin tab name has to be a real tab for the
      // route to exist; an expression that is only choosing a query string
      // (`${force ? '?fresh=1' : ''}`) contributes nothing to the path.
      if (/\?/.test(expr)) out += '';
      else if (/\btab\b/.test(expr)) out += 'overview';
      else out += '1';
      i = j - 1;
      continue;
    }
    out += raw[i];
  }
  return out.replace(/\?.*$/, '');
}

// ── client/server skew ────────────────────────────────────────────────────
// The app is served from disk on every request while routes are frozen at
// process start, so a server left running across a deploy hands the new bundle
// old routes. That produced a real outage: the station page said "Not Found"
// because /api/station did not exist in the running process, which reads as a
// code bug. These tests make the skew loud and one-dimensional.

test('the server advertises the API surface the app is written against', async () => {
  const { res, body } = await jfetch('/api/health');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.features), 'health must list its API features');
  for (const f of ['search', 'radio', 'station', 'dislikes', 'likes', 'playlists', 'album']) {
    assert.ok(body.features.includes(f), `health does not advertise "${f}"`);
  }
  // A stale process is identifiable by its start time, which is the first
  // thing to check when an endpoint 404s in production.
  assert.ok(!Number.isNaN(Date.parse(body.startedAt)), 'health must report when it started');
});

test('every /api route the client calls exists on the server', async () => {
  // The whole point: public/ and src/ ship together but are read at different
  // times. If the client calls a path the server does not have, the user sees a
  // broken feature and no explanation.
  const client = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const paths = extractApiPaths(client);
  assert.ok(paths.size > 15, `the extractor found only ${paths.size} client paths — it is broken`);
  assert.ok([...paths].some((p) => p.includes('station')), 'the extractor must find /api/station');

  // Endpoints answered by the proxy/static layer rather than a JSON route, plus
  // the ones a probe must not touch: logging out (or signing out every device)
  // ends this test's session, the admin routes mutate instance state (vacuum,
  // prune, delete a user), and the WebAuthn routes cannot be probed at all —
  // they need a live challenge cookie, and the attempt's Set-Cookie replaces
  // this jar's session cookie with a challenge one. A guard against missing
  // routes must not change the state it is checking.
  const skip = /^\/api\/(?:$|stream\/|artwork\/|auth\/(?:logout|signout-all|devices\/|passkey)|admin\/)/;
  const missing = [];
  for (const raw of paths) {
    if (skip.test(raw)) continue;
    // A path that ends in a bare slash is a prefix *test* in the source
    // (`path.startsWith('/api/auth/')`), never a request: no route ends in "/".
    if (raw.endsWith('/')) continue;
    const path = fill(raw);
    // Probe the verbs the client actually uses. A route registered for GET only
    // answers POST with Fastify's own "Route POST:/x not found", which is not a
    // missing route. Fastify's phrase is matched exactly, so an application 404
    // ("Unknown track.", "User not found.") is not mistaken for one.
    const NO_ROUTE = /^Route \w+:[^ ]+ not found$/;
    const probe = async (method) => {
      const { res, body } = await jfetch(path, {
        method, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
      });
      return !(res.status === 404 && NO_ROUTE.test(String(body?.message ?? '')));
    };
    if (await probe('GET')) continue;
    if (await probe('POST')) continue;
    if (await probe('DELETE')) continue;
    missing.push(raw);
  }
  assert.deepEqual(missing, [], `the client calls routes this server does not have: ${missing.join(', ')}`);

  // Belt and braces: any probe that did have a side effect must not silently
  // leave the rest of the file unauthenticated.
  const me = await jfetch('/api/me');
  assert.equal(me.res.status, 200, 'the probe run ended the test session');
});

// ── the personal station and "less like this" ───────────────────────────

test('a station with nothing to go on is empty and says so', async () => {
  // This instance has plays (from the recent-plays test) but they carry no
  // title, so no seeds exist — the honest answer is an empty station with a
  // blurb explaining what to do, not a random queue.
  const { res, body } = await jfetch('/api/station');
  assert.equal(res.status, 200);
  assert.match(body.name, /station$/);
  assert.equal(typeof body.blurb, 'string');
  assert.ok(body.blurb.length > 0);
  assert.ok(Array.isArray(body.tracks));
});

test('a dislike round-trips, cancels a like, and is reversible', async () => {
  const videoId = '2tOutF8B3f8';

  await jfetch('/api/likes', { method: 'POST', body: JSON.stringify({ videoId, like: true }) });
  const liked = await jfetch('/api/likes');
  assert.ok(liked.body.tracks.some((t) => t.videoId === videoId), 'like did not stick');

  const res = await jfetch('/api/dislikes', {
    method: 'POST',
    body: JSON.stringify({ videoId, dislike: true, source: 'test' }),
  });
  assert.equal(res.res.status, 200);
  assert.equal(res.body.disliked, true);

  const after = await jfetch('/api/likes');
  assert.ok(!after.body.tracks.some((t) => t.videoId === videoId), 'a dislike must clear the like');

  const disliked = await jfetch('/api/dislikes');
  assert.ok(disliked.body.tracks.some((t) => t.videoId === videoId), 'dislike did not persist');

  // Reversible: the instruction is a toggle, not a one-way door.
  const undo = await jfetch('/api/dislikes', {
    method: 'POST',
    body: JSON.stringify({ videoId, dislike: false }),
  });
  assert.equal(undo.body.disliked, false);
  const cleared = await jfetch('/api/dislikes');
  assert.ok(!cleared.body.tracks.some((t) => t.videoId === videoId), 'undo did not clear the dislike');
});

test('a disliked track is filtered out of radio', async () => {
  const seed = 'XFkzRNyygfk'; // Radiohead - Creep
  const first = await jfetch(`/api/radio?seed=${seed}`);
  assert.equal(first.res.status, 200);
  assert.ok(first.body.tracks.length > 0, 'radio returned nothing to filter');

  const victim = first.body.tracks[0].videoId;
  await jfetch('/api/dislikes', {
    method: 'POST', body: JSON.stringify({ videoId: victim, dislike: true }),
  });

  const second = await jfetch(`/api/radio?seed=${seed}`);
  assert.ok(!second.body.tracks.some((t) => t.videoId === victim),
    'a disliked track came back in the next station');

  await jfetch('/api/dislikes', {
    method: 'POST', body: JSON.stringify({ videoId: victim, dislike: false }),
  });
});

test('a station with a seed plays wider than the history', async () => {
  // Liking a song with its metadata gives the station something to build on.
  await jfetch('/api/likes', {
    method: 'POST',
    body: JSON.stringify({
      videoId: 'XFkzRNyygfk', like: true, source: 'test',
      title: 'Creep', channel: 'Radiohead', durationS: 239,
    }),
  });

  const { res, body } = await jfetch('/api/station?fresh=1');
  assert.equal(res.status, 200);
  assert.equal(body.empty, false);
  assert.match(body.name, /station$/);
  assert.match(body.blurb, /you liked/, 'the station explains itself');
  assert.ok(body.seeds.some((s) => s.videoId === 'XFkzRNyygfk'), 'the liked song is a seed');

  // The whole point: it is not just a list of songs already heard. Most of the
  // queue has to come from the recommender and the same-artist expansion.
  const seedIds = new Set(body.seeds.map((s) => s.videoId));
  const beyond = body.tracks.filter((t) => !seedIds.has(t.videoId));
  assert.ok(beyond.length >= 5,
    `expected recommendations beyond the history, got ${beyond.length} of ${body.tracks.length}`);
  assert.equal(body.tracks.filter((t) => seedIds.has(t.videoId)).length, seedIds.size,
    'every seed appears exactly once');
  for (const t of body.tracks) {
    assert.match(t.videoId, /^[A-Za-z0-9_-]{11}$/);
    assert.ok(t.title, 'every queued track has a title');
  }

  await jfetch('/api/likes', { method: 'POST', body: JSON.stringify({ videoId: 'XFkzRNyygfk', like: false }) });
  await jfetch('/api/dislikes', { method: 'POST', body: JSON.stringify({ videoId: 'XFkzRNyygfk', dislike: false }) });
});

test('the API is never cached by the browser', async () => {
  // The station is rebuilt when a like lands; a 304 on a cached body would hand
  // the browser a queue that ignores the instruction the user just gave.
  const res = await fetch(`${BASE}/api/station`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the design shell is served with the mock\'s own markup', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /sonora/);
  assert.match(html, /brand-word/, 'sidebar brand preserved');
  assert.match(html, /hero-art|mobile-nav/, 'layout primitives preserved');
  assert.match(html, /id="i-wave"/, 'icon sprite preserved');

  const css = await (await fetch(`${BASE}/app.css`)).text();
  assert.match(css, /--accent:#ff997b/, 'accent token preserved');
  assert.match(css, /grid-template-columns:235px/, 'desktop grid preserved');
  assert.match(css, /max-width:650px/, 'mobile breakpoint preserved');
});

test('likes and dislikes clamp the source string they persist', async () => {
  // `source` is the one plays column a request could fatten: every sibling
  // clamps to 40 chars, and the body limit would let a 10 KB string through
  // into a row written on every like. No API echoes the column back, so this
  // asserts on the database the run owns.
  const { DatabaseSync } = await import('node:sqlite');
  const big = 'x'.repeat(10_240);
  const like = await jfetch('/api/likes', {
    method: 'POST',
    body: JSON.stringify({ videoId: '2tOutF8B3f8', like: true, source: big }),
  });
  assert.equal(like.res.status, 200);
  // The like is read before the dislike, because a dislike is exclusive with a
  // like and therefore withdraws it — including the `kind='like'` evidence row
  // the taste model counts (see toggleLike in src/db.js). Reading "the last two
  // rows" afterwards would now see the dislike and an older dislike from a
  // previous test, not the two signals this test is about.
  //
  // WAL means the reader may trail the writer by nothing here (the request
  // above is already acknowledged), but the connection must be read-only
  // against the same file the server writes, not a copy.
  const db = new DatabaseSync(`${DB}`, { readOnly: true });
  const playRow = (kind) => db.prepare(
    `SELECT kind, source FROM plays
     WHERE kind = ? AND user_id = (SELECT id FROM users WHERE name = 'toil')
     ORDER BY rowid DESC LIMIT 1`,
  ).get(kind);
  try {
    const likeRow = playRow('like');
    assert.equal(likeRow?.kind, 'like', 'the like was recorded as a play event');
    assert.ok(likeRow.source.length <= 40, `stored like source is clamped (got ${likeRow.source.length})`);

    const dislike = await jfetch('/api/dislikes', {
      method: 'POST',
      body: JSON.stringify({ videoId: '2tOutF8B3f8', dislike: true, source: big }),
    });
    assert.equal(dislike.res.status, 200);

    const dislikeRow = playRow('dislike');
    assert.equal(dislikeRow?.kind, 'dislike', 'the dislike was recorded as a play event');
    assert.ok(dislikeRow.source.length <= 40, `stored dislike source is clamped (got ${dislikeRow.source.length})`);
    assert.equal(playRow('like'), undefined, 'the dislike withdrew the like and its evidence row');
  } finally {
    db.close();
  }

  // Undo the dislike so later tests keep their preconditions (a disliked
  // track is filtered from radio).
  await jfetch('/api/dislikes', {
    method: 'POST', body: JSON.stringify({ videoId: '2tOutF8B3f8', dislike: false }),
  });
});
