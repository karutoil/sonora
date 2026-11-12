import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/cdp.js';

// Real HTTP, fake upstream. The supported setSessionOverride seam lets this
// suite prove cache/error/concurrency behavior without one live-YouTube skip.
const FIXTURE = process.env.SONORA_SEARCH_FIXTURE === '1';
const PASS = 'hunter2hunter2';
const ROOT = new URL('..', import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SEARCH_ROW_CAP = 256;
const SEARCH_BYTE_CAP = 4 * 1024 * 1024;
const DISTINCT_QUERY_CAP = 24;

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out: ${message}; last value ${JSON.stringify(value)}`);
}

function searchPath(q, type = 'all') {
  return `/api/search?${new URLSearchParams({ q, type })}`;
}

async function request(base, route, { cookie = '', body, method = 'GET', headers = {} } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get('content-type') ?? '';
  return { res, body: type.includes('json') ? await res.json() : await res.text() };
}

async function login(base, name = 'toil') {
  const response = await request(base, '/api/auth/login', {
    method: 'POST', body: { name, passphrase: PASS },
  });
  assert.equal(response.res.status, 200, JSON.stringify(response.body));
  const header = response.res.headers.getSetCookie?.()[0] ?? response.res.headers.get('set-cookie');
  assert.ok(header, 'login returned a session cookie');
  return header.split(';')[0];
}

function setMode(server, mode = {}) {
  fs.writeFileSync(server.modeFile, JSON.stringify(mode));
  if (mode.hold?.length) fs.writeFileSync(server.holdFile, 'hold');
  else fs.rmSync(server.holdFile, { force: true });
}

function searches(server) {
  return readLines(server.searchLog);
}

function withTestDb(server, fn, { readOnly = false } = {}) {
  const db = new DatabaseSync(server.dbPath, { readOnly });
  try { return fn(db); } finally { db.close(); }
}

function searchCacheStats(server) {
  return withTestDb(server, (db) => db.prepare(`SELECT COUNT(*) AS rows,
      COALESCE(SUM(LENGTH(CAST(key AS BLOB)) + LENGTH(CAST(value AS BLOB))), 0) AS bytes
    FROM upstream_cache WHERE key >= 'search:' AND key < 'search:\uFFFF'`).get(), { readOnly: true });
}

function sentinels(server) {
  return withTestDb(server, (db) => db.prepare(`SELECT key, value FROM upstream_cache
    WHERE key IN ('station:77:first', 'lyrics:abcdefghijk') ORDER BY key`).all()
    .map((row) => ({ ...row })), { readOnly: true });
}

async function launchFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-search-http-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['--no-warnings', 'test/search-types.test.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      SONORA_SEARCH_FIXTURE: '1', SONORA_SEARCH_CONTROL: dir,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'search.db'), SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'search-fixture-secret', SONORA_PASSPHRASE: PASS,
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const server = {
    base, child, dir, logs,
    dbPath: path.join(dir, 'search.db'),
    modeFile: path.join(dir, 'mode.json'),
    holdFile: path.join(dir, 'hold-upstream'),
    searchLog: path.join(dir, 'search-calls.jsonl'),
    txLog: path.join(dir, 'transactions.jsonl'),
  };
  server.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      timeout.unref?.();
      await exited;
      clearTimeout(timeout);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  try {
    await waitFor(async () => {
      try {
        const response = await request(server.base, '/api/health');
        return response.res.status === 200 && response.body.pid === child.pid;
      } catch { return false; }
    }, `fixture ${child.pid} became healthy`, 15_000);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\n${logs.join('')}`);
  }
  return server;
}

// ── fixture child ────────────────────────────────────────────────────────
function fixtureHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fakeSearchSession(control) {
  const channel = `UC${'f'.repeat(22)}`;
  const readMode = () => {
    try { return JSON.parse(fs.readFileSync(path.join(control, 'mode.json'), 'utf8')); }
    catch { return {}; }
  };
  const record = (entry) => fs.appendFileSync(path.join(control, 'search-calls.jsonl'), `${JSON.stringify({
    at: Date.now(), ...entry,
  })}\n`);
  const fail = (mode, shelf) => {
    const err = new Error(mode.messages?.[shelf] ?? mode.message ?? `${shelf} fixture upstream failed`);
    if (mode.code) err.code = mode.code;
    if (mode.retryAfterMs) err.retryAfterMs = mode.retryAfterMs;
    return err;
  };
  const response = (query, shelf) => {
    if (shelf === 'song') return {
      songs: { contents: [{
        id: `s${fixtureHash(`video:${query}`).slice(0, 10)}`,
        title: { text: `${query} title` },
        artists: [{ name: `${query} artist`, channel_id: channel }],
        duration: { seconds: 211 },
        album: { name: `${query} album`, id: `MPR${fixtureHash(query).slice(0, 16)}` },
      }] },
    };
    if (shelf === 'artist') return {
      artists: { contents: [{
        id: channel, name: `${query} artist`, subscribers: '12K subscribers', thumbnails: [],
      }] },
    };
    if (shelf === 'album') return {
      albums: { contents: [{
        id: `MPR${fixtureHash(query).slice(0, 16)}`,
        title: { text: `${query} album` },
        subtitle: `Album • ${query} artist • 2024`, thumbnails: [],
      }] },
    };
    return {
      playlists: { contents: [{
        id: `PL${fixtureHash(query).slice(0, 16)}`,
        title: `${query} playlist`, author: { name: 'Fixture listener' },
        flex_columns: [{ title: { text: `${query} playlist` } }, {
          title: { text: 'Fixture listener • 12K views • 20 tracks' },
        }],
        thumbnails: [],
      }] },
    };
  };

  const search = (source) => async (query, options = {}) => {
    const requested = String(options.type ?? '');
    const shelf = requested === 'song' || requested === 'video' ? 'song'
      : requested === 'artist' || requested === 'channel' ? 'artist'
        : requested === 'album' || (source === 'plain' && requested === 'playlist') ? 'album'
          : 'playlist';
    record({ query, source, requested, shelf });
    const mode = readMode();
    if (mode.fail?.includes(shelf)) throw fail(mode, shelf);
    if (mode.hold?.includes(shelf)) {
      while (fs.existsSync(path.join(control, 'hold-upstream'))) await sleep(10);
    }
    if (mode.empty?.includes(shelf)) return { contents: [] };
    if (source === 'music') return response(query, shelf);
    // A second video source is unnecessary once the catalogue row succeeds;
    // returning none still exercises the real partial-fallback search path.
    if (shelf === 'song') return { videos: [] };
    if (shelf === 'artist') return { channels: [] };
    return { playlists: [] };
  };

  return {
    music: {
      search: search('music'),
      getExplore: async () => ({ sections: [] }),
      getPlaylist: async () => ({ header: { second_subtitle: { text: '12K views • 20 tracks' } } }),
      getUpNext: async () => ({ contents: [] }),
      getArtist: async () => ({ sections: [] }),
      getAlbum: async () => ({ contents: [] }),
      getLyrics: async () => ({ description: null }),
    },
    search: search('plain'),
    getPlaylist: async () => ({ contents: [] }),
    getBasicInfo: async () => ({ basic_info: { is_live: false } }),
  };
}

async function runFixture() {
  const control = process.env.SONORA_SEARCH_CONTROL;
  setMode({
    modeFile: path.join(control, 'mode.json'),
    holdFile: path.join(control, 'hold-upstream'),
  }, {});
  const youtube = await import('../src/youtube.js');
  youtube.setSessionOverride(fakeSearchSession(control));
  await import('../src/server.js');

  // Observe the actual write transaction at its real SQLite boundary. Search
  // also writes one cache transaction per freshly loaded shelf; these markers
  // let the coalescing test isolate track-upsert BEGIN/COMMIT pairs.
  const { db } = await import('../src/db.js');
  const exec = db.exec.bind(db);
  db.exec = (sql, ...args) => {
    if (String(sql).trim().toUpperCase() === 'BEGIN IMMEDIATE') {
      fs.appendFileSync(path.join(control, 'transactions.jsonl'), `${JSON.stringify({ at: Date.now(), sql: 'BEGIN IMMEDIATE' })}\n`);
    }
    return exec(sql, ...args);
  };
}

if (FIXTURE) {
  await runFixture();
} else {
  let server;
  let adminCookie;
  let first;

  before(async () => {
    server = await launchFixture();
    adminCookie = await login(server.base);
  });
  after(async () => {
    const logs = server?.logs.join('') ?? '';
    await server?.stop();
    if (process.env.SONORA_SEARCH_DEBUG === '1' && logs) console.error(logs);
  });

  const api = (route, options = {}) => request(server.base, route, {
    cookie: adminCookie, ...options,
  });

  test('search requires a session', async () => {
    const response = await api(searchPath('fixture'), { cookie: '' });
    assert.equal(response.res.status, 401);
  });

  test('missing q and an unknown type are still 400', async () => {
    const missing = await api('/api/search');
    assert.equal(missing.res.status, 400);
    assert.equal(missing.body.error, 'Missing q.');
    const unknown = await api(searchPath('fixture', 'nonsense'));
    assert.equal(unknown.res.status, 400);
    assert.equal(unknown.body.error, 'Unknown type.');
  });

  test('a specific shelf uses only that upstream and keeps the full shape', async () => {
    setMode(server);
    const q = 'typed fixture';
    const beforeCalls = searches(server).length;
    const { res, body } = await api(searchPath(q, 'song'));
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.q, q);
    assert.ok(body.tracks.length > 0);
    for (const field of ['tracks', 'artists', 'albums', 'playlists']) assert.ok(Array.isArray(body[field]));
    assert.deepEqual(body.artists, []);
    assert.deepEqual(body.albums, []);
    assert.deepEqual(body.playlists, []);
    assert.deepEqual(body.counts, { tracks: body.tracks.length, artists: 0, albums: 0, playlists: 0 });
    const calls = searches(server).slice(beforeCalls);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.shelf === 'song'));
  });

  test('one request answers all four shelves with internally consistent counts', async () => {
    setMode(server);
    const { res, body } = await api(searchPath('radiohead fixture'));
    assert.equal(res.status, 200, JSON.stringify(body));
    for (const field of ['tracks', 'artists', 'albums', 'playlists']) {
      assert.ok(body[field].length > 0, `${field} is populated from its fixture shelf`);
    }
    assert.deepEqual(body.counts, {
      tracks: body.tracks.length, artists: body.artists.length,
      albums: body.albums.length, playlists: body.playlists.length,
    });
    for (const row of body.albums) assert.match(row.id, /^MPR[\w-]+$/);
    for (const row of body.playlists) assert.match(row.id, /^(?:VL)?PL[\w-]+$/);
    for (const row of body.artists) assert.match(row.id, /^UC[\w-]{20,}$/);
    assert.equal(body.errors, undefined);
    first = body;
  });

  test('repeat requests and tab switches reuse shelves without re-querying', async () => {
    const beforeCalls = searches(server).length;
    const repeated = await api(searchPath('radiohead fixture'));
    assert.equal(repeated.res.status, 200);
    assert.deepEqual(repeated.body, first);
    const albums = await api(searchPath('radiohead fixture', 'album'));
    assert.equal(albums.res.status, 200);
    assert.deepEqual(albums.body.albums, first.albums);
    assert.deepEqual(albums.body.tracks, []);
    assert.deepEqual(albums.body.artists, []);
    assert.deepEqual(albums.body.playlists, []);
    assert.equal(searches(server).length, beforeCalls, 'both answers were cache hits');
  });

  test('partial shelf failure preserves successful items and exposes its sanitized error', async () => {
    setMode(server, { fail: ['playlist'] });
    const { res, body } = await api(searchPath('partial fixture'));
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.tracks.length > 0);
    assert.ok(body.artists.length > 0);
    assert.ok(body.albums.length > 0);
    assert.deepEqual(body.playlists, []);
    assert.equal(body.counts.playlists, 0);
    assert.equal(body.errors.playlists.code, 'UPSTREAM_FAILED');
    assert.match(body.errors.playlists.error, /playlist search/i);
    assert.equal(body.errors.tracks, undefined);

    const callsBeforeRetry = searches(server).length;
    setMode(server);
    const recovered = await api(searchPath('partial fixture'));
    assert.equal(recovered.res.status, 200, JSON.stringify(recovered.body));
    assert.ok(recovered.body.playlists.length > 0, 'the failed shelf is tried again');
    assert.equal(recovered.body.errors, undefined);
    assert.deepEqual(recovered.body.tracks, body.tracks, 'successful songs stayed cached');
    assert.deepEqual(recovered.body.albums, body.albums, 'successful albums stayed cached');
    const retryCalls = searches(server).slice(callsBeforeRetry);
    assert.ok(retryCalls.length > 0);
    assert.ok(retryCalls.every((call) => call.shelf === 'playlist'),
      'no rejected shelf was cached and no successful shelf was needlessly re-fetched');
  });

  test('all actual successful-empty shelves remain a cacheable 200', async () => {
    setMode(server, { empty: ['song', 'artist', 'album', 'playlist'] });
    const q = 'successful empty fixture';
    const beforeCalls = searches(server).length;
    const empty = await api(searchPath(q));
    assert.equal(empty.res.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.tracks, []);
    assert.deepEqual(empty.body.artists, []);
    assert.deepEqual(empty.body.albums, []);
    assert.deepEqual(empty.body.playlists, []);
    assert.deepEqual(empty.body.counts, { tracks: 0, artists: 0, albums: 0, playlists: 0 });
    assert.equal(empty.body.errors, undefined);
    const calls = searches(server).length;
    assert.ok(calls > beforeCalls, 'the empty fixtures really ran upstream');
    const repeated = await api(searchPath(q));
    assert.equal(repeated.res.status, 200);
    assert.deepEqual(repeated.body, empty.body);
    assert.equal(searches(server).length, calls, 'successful empty is cached without becoming an error');
  });

  test('total rejection is classified and never cached as an empty success', async () => {
    const q = 'recoverable failure fixture';
    setMode(server, { fail: ['song', 'artist', 'album', 'playlist'] });
    const failed = await api(searchPath(q));
    assert.equal(failed.res.status, 502, JSON.stringify(failed.body));
    assert.equal(failed.body.code, 'UPSTREAM_FAILED');
    const failedQueryCalls = searches(server).filter((call) => call.query === q).length;
    const keys = ['song:20', 'artist:4', 'album:12', 'playlist:8']
      .map((shelf) => `search:${shelf}:${q}`);
    const cached = withTestDb(server, (db) => db.prepare(`SELECT key, value FROM upstream_cache
      WHERE key IN (?, ?, ?, ?) ORDER BY key`).all(...keys), { readOnly: true });
    assert.deepEqual(cached, [], 'none of the four rejected shelves was persisted');

    setMode(server);
    const recovered = await api(searchPath(q));
    assert.equal(recovered.res.status, 200, JSON.stringify(recovered.body));
    assert.ok(recovered.body.tracks.length > 0);
    assert.ok(recovered.body.artists.length > 0);
    assert.ok(recovered.body.albums.length > 0);
    assert.ok(recovered.body.playlists.length > 0);
    assert.ok(searches(server).filter((call) => call.query === q).length > failedQueryCalls,
      'the retry performed real upstream work instead of serving failed empties');
  });

  test('one timed-out requested shelf yields UPSTREAM_TIMEOUT, not an empty 200', async () => {
    setMode(server, { fail: ['song'], message: 'song search timed out' });
    const { res, body } = await api(searchPath('timeout fixture', 'song'));
    assert.equal(res.status, 503);
    assert.equal(body.code, 'UPSTREAM_TIMEOUT');
  });

  test('mixed total failures prefer an actionable timeout over a generic shelf error', async () => {
    setMode(server, {
      fail: ['song', 'artist', 'album', 'playlist'],
      messages: { playlist: 'playlist search timed out' },
    });
    const { res, body } = await api(searchPath('mixed failure fixture'));
    assert.equal(res.status, 503);
    assert.equal(body.code, 'UPSTREAM_TIMEOUT');
  });

  test('structured upstream backoff remains a 503 with Retry-After', async () => {
    setMode(server, {
      fail: ['song'], code: 'YT_BLOCKED', retryAfterMs: 12_345,
      message: 'YouTube is rate-limiting this IP; retry in 13s.',
    });
    const { res, body } = await api(searchPath('backoff fixture', 'song'));
    assert.equal(res.status, 503);
    assert.equal(body.code, 'UPSTREAM_RATE_LIMITED');
    assert.equal(res.headers.get('retry-after'), '13');
  });

  test('coalesced followers share one shelf call and only the leader commits upserts', async () => {
    const q = 'coalesced fixture';
    setMode(server, { hold: ['song'] });
    fs.writeFileSync(server.txLog, '');
    const beforeCalls = searches(server).length;
    const pending = Promise.all([1, 2, 3].map(() => api(searchPath(q, 'song'))));
    await waitFor(() => searches(server).some((call) => call.query === q && call.source === 'music'), 'held upstream call started');
    // Let every request become a follower before releasing the producer.
    await sleep(150);
    const heldCalls = searches(server).slice(beforeCalls).filter((call) => call.query === q && call.source === 'music');
    assert.equal(heldCalls.length, 1);
    fs.rmSync(server.holdFile, { force: true });
    const answers = await pending;
    for (const answer of answers) {
      assert.equal(answer.res.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(answer.body, answers[0].body);
    }
    const transactions = readLines(server.txLog).length;
    assert.equal(transactions, 2,
      'one cache transaction plus one track-upsert transaction; followers add neither');
  });

  test('expired search rows are swept without touching station or lyrics keys', async () => {
    withTestDb(server, (db) => {
      const insert = db.prepare('INSERT OR REPLACE INTO upstream_cache (key, value, expires_at) VALUES (?, ?, ?)');
      insert.run('search:song:20:expired-fixture', JSON.stringify([{ stale: true }]), 1);
      insert.run('station:77:first', JSON.stringify({ private: 'station survives' }), Date.now() + 600_000);
      insert.run('lyrics:abcdefghijk', JSON.stringify({ text: 'lyrics survive' }), Date.now() + 600_000);
    });
    setMode(server);
    const response = await api(searchPath('expiry sweep fixture', 'song'));
    assert.equal(response.res.status, 200, JSON.stringify(response.body));
    const expired = withTestDb(server, (db) => db.prepare(
      'SELECT value FROM upstream_cache WHERE key = ?',
    ).get('search:song:20:expired-fixture'), { readOnly: true });
    assert.equal(expired, undefined);
    assert.deepEqual(sentinels(server), [
      { key: 'lyrics:abcdefghijk', value: JSON.stringify({ text: 'lyrics survive' }) },
      { key: 'station:77:first', value: JSON.stringify({ private: 'station survives' }) },
    ]);
  });

  test('row pressure evicts oldest search entries but never station or lyrics', async () => {
    withTestDb(server, (db) => {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare('INSERT OR REPLACE INTO upstream_cache (key, value, expires_at) VALUES (?, ?, ?)');
      for (let i = 0; i < SEARCH_ROW_CAP + 20; i += 1) {
        insert.run(`search:seed:${i}`, JSON.stringify([{ i }]), Date.now() + 100_000 + i);
      }
      insert.run('station:77:first', JSON.stringify({ private: 'station survives' }), 1);
      insert.run('lyrics:abcdefghijk', JSON.stringify({ text: 'lyrics survive' }), 1);
      db.exec('COMMIT');
    });
    assert.ok(searchCacheStats(server).rows > SEARCH_ROW_CAP);
    setMode(server);
    const response = await api(searchPath('row pressure fixture', 'song'));
    assert.equal(response.res.status, 200, JSON.stringify(response.body));
    const stats = searchCacheStats(server);
    assert.ok(stats.rows <= SEARCH_ROW_CAP, `row cap exceeded: ${JSON.stringify(stats)}`);
    assert.deepEqual(sentinels(server), [
      { key: 'lyrics:abcdefghijk', value: JSON.stringify({ text: 'lyrics survive' }) },
      { key: 'station:77:first', value: JSON.stringify({ private: 'station survives' }) },
    ]);
  });

  test('byte pressure evicts large search blobs but cannot consume isolated keys', async () => {
    withTestDb(server, (db) => {
      const insert = db.prepare('INSERT OR REPLACE INTO upstream_cache (key, value, expires_at) VALUES (?, ?, ?)');
      insert.run(`search:seed:${SEARCH_BYTE_CAP}-old-blob`, JSON.stringify('x'.repeat(SEARCH_BYTE_CAP + 4096)), 1);
      insert.run('station:77:first', JSON.stringify({ private: 'station survives' }), 1);
      insert.run('lyrics:abcdefghijk', JSON.stringify({ text: 'lyrics survive' }), 1);
    });
    setMode(server);
    const response = await api(searchPath('byte pressure fixture', 'song'));
    assert.equal(response.res.status, 200, JSON.stringify(response.body));
    const stats = searchCacheStats(server);
    assert.ok(stats.bytes <= SEARCH_BYTE_CAP, `byte cap exceeded: ${JSON.stringify(stats)}`);
    assert.deepEqual(sentinels(server), [
      { key: 'lyrics:abcdefghijk', value: JSON.stringify({ text: 'lyrics survive' }) },
      { key: 'station:77:first', value: JSON.stringify({ private: 'station survives' }) },
    ]);
  });

  test('concurrent arbitrary distinct queries hit the per-user ceiling exactly once', async () => {
    // A different account also proves this is per-user rather than the global IP
    // bucket. Only the first caller's independent cache misses consume its set.
    const created = await api('/api/admin/users', {
      method: 'POST', body: { name: 'search-budget-user', passphrase: PASS, role: 'user' },
    });
    assert.equal(created.res.status, 201, JSON.stringify(created.body));
    const budgetCookie = await login(server.base, 'search-budget-user');
    setMode(server);
    fs.writeFileSync(server.searchLog, '');
    const requests = Array.from({ length: DISTINCT_QUERY_CAP + 12 }, (_, i) => api(
      searchPath(`distinct fixture ${i}`, 'song'), { cookie: budgetCookie },
    ));
    const responses = await Promise.all(requests);
    const ok = responses.filter(({ res }) => res.status === 200);
    const limited = responses.filter(({ res }) => res.status === 429);
    assert.equal(ok.length, DISTINCT_QUERY_CAP);
    assert.equal(limited.length, 12);
    for (const { res, body } of limited) {
      assert.equal(body.code, 'SEARCH_RATE_LIMITED');
      assert.ok(Number(res.headers.get('retry-after')) > 0);
    }
    const calls = searches(server);
    const uniqueQueries = new Set(calls.map((call) => call.query));
    assert.equal(uniqueQueries.size, DISTINCT_QUERY_CAP,
      'rejected q strings never reached the fake upstream');
    const musicCalls = calls.filter((call) => call.source === 'music');
    assert.equal(musicCalls.length, DISTINCT_QUERY_CAP,
      'each admitted distinct song query called the catalogue exactly once');

    // Repeating a cached query still works after the distinct-query window fills.
    const cached = await api(searchPath([...uniqueQueries][0], 'song'), { cookie: budgetCookie });
    assert.equal(cached.res.status, 200, JSON.stringify(cached.body));
    assert.equal(searches(server).length, calls.length,
      'a full distinct-query budget never charges or repeats a cached shelf');
  });

  test('a bot gate on every requested shelf retains BOT_GATED', async () => {
    setMode(server, {
      fail: ['song', 'artist', 'album', 'playlist'],
      message: "Sign in to confirm you're not a bot",
    });
    const { res, body } = await api(searchPath('bot gate fixture'));
    assert.equal(res.status, 503);
    assert.equal(body.code, 'BOT_GATED');
  });
}
