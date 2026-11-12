import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './helpers/cdp.js';

// Real HTTP + real SQLite + real YouTube parsers, with only the remote
// Innertube session replaced. These tests never depend on a live upstream.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-station-routes-'));
const CONTROL = path.join(DIR, 'control.json');
const LOG = path.join(DIR, 'upstream.jsonl');
const DB = path.join(DIR, 'station.db');
const PASS = 'hunter2hunter2';
const FIXTURE = new URL('./fixtures/station-server.mjs', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channel = (letter) => `UC${letter.repeat(22)}`;
const track = (videoId, title, artist = 'Fixture Artist', extra = {}) => ({
  videoId, title, channel: artist, durationS: 200, ...extra,
});

const GENRES = [
  { name: 'Fixture Rock', params: 'fixture-rock', tracks: [track('rocktrend01', 'Rock Trend', 'Rock Neighbour')] },
  { name: 'Fixture Jazz', params: 'fixture-jazz', tracks: [track('jazztrend01', 'Jazz Trend', 'Jazz Neighbour')] },
];
const DEFAULT_CONTROL = {
  defaultUpNext: [track('recommend01', 'Recommended One', 'New Artist')],
  upNext: {}, profiles: {}, artistIds: {}, searchSongs: {}, genres: GENRES,
  holdUpNext: false, emptyUpstream: false,
  failAll: false, failUpNext: false, failArtistSearch: false,
  failArtists: false, failExplore: false, failBrowse: false,
};
function setControl(patch = {}) {
  fs.writeFileSync(CONTROL, JSON.stringify({ ...DEFAULT_CONTROL, ...patch }));
}
function logEntries() {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}
async function waitFor(check, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${message}; upstream=${JSON.stringify(logEntries())}`);
}

let proc;
let BASE;
let adminCookie;
let adminId;
let serial = 0;

async function request(route, { cookie = '', method = 'GET', body } = {}) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return {
    status: res.status,
    headers: res.headers,
    body: type.includes('json') ? await res.json() : await res.text(),
  };
}
async function login(name) {
  const answer = await request('/api/auth/login', {
    method: 'POST', body: { name, passphrase: PASS },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const setCookie = answer.headers.getSetCookie?.()[0] ?? answer.headers.get('set-cookie');
  return setCookie.split(';')[0];
}
async function newUser(prefix) {
  serial += 1;
  const name = `${prefix}-${serial}`;
  const created = await request('/api/admin/users', {
    cookie: adminCookie, method: 'POST', body: { name, passphrase: PASS, role: 'user' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.user.id, cookie: await login(name) };
}
async function event(cookie, t, kind, extra = {}) {
  const answer = await request('/api/events', {
    cookie, method: 'POST', body: { ...t, kind, source: 'station-test', ...extra },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}
async function likeSong(cookie, t, on = true) {
  const answer = await request('/api/likes', {
    cookie, method: 'POST', body: { ...t, like: on, source: 'station-test' },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}
async function dislikeSong(cookie, t) {
  const answer = await request('/api/dislikes', {
    cookie, method: 'POST', body: { ...t, dislike: true, source: 'station-test' },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

before(async () => {
  setControl();
  fs.writeFileSync(LOG, '');
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logs = [];
  proc = spawn(process.execPath, ['--no-warnings', FIXTURE], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: path.join(DIR, 'audio'),
      SONORA_SECRET: 'station-route-secret', SONORA_PASSPHRASE: PASS,
      SONORA_LOGIN_RATE_MAX: '1000', SONORA_LOG_LEVEL: 'warn',
      SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '', SONORA_RESOLVE_TIMEOUT_MS: '500',
      SONORA_STATION_CONTROL: CONTROL, SONORA_STATION_LOG: LOG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 160 && proc.exitCode === null; i += 1) {
    try {
      const health = await request('/api/health');
      if (health.status === 200 && health.body.pid === proc.pid) {
        adminCookie = await login('admin');
        const me = await request('/api/me', { cookie: adminCookie });
        adminId = me.body.user.id;
        return;
      }
    } catch {}
    await sleep(50);
  }
  throw new Error(`station fixture did not start:\n${logs.join('')}`);
});

after(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGTERM');
    const stopped = await Promise.race([once(proc, 'exit').then(() => true), sleep(3000).then(() => false)]);
    if (!stopped && proc.exitCode === null) proc.kill('SIGKILL');
  }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('mocked first-page and more-like contracts stay honest with and without seeds', async () => {
  setControl();
  const user = await newUser('station-basic');
  let answer = await request('/api/station', { cookie: user.cookie });
  assert.equal(answer.body.reason, 'no-seeds');
  assert.deepEqual(answer.body.tracks, []);

  const seed = track('basicSeed01', 'Basic Seed', 'Basic Artist');
  await likeSong(user.cookie, seed);
  answer = await request('/api/station', { cookie: user.cookie });
  assert.equal(answer.status, 200);
  assert.ok(answer.body.tracks.some((t) => t.videoId === seed.videoId));
  assert.ok(answer.body.tracks.some((t) => t.videoId === 'recommend01'));

  const held = answer.body.tracks.map((t) => t.videoId);
  const next = await request(`/api/station/next?cursor=3&exclude=${encodeURIComponent(held.join(','))}`, {
    cookie: user.cookie,
  });
  assert.equal(next.status, 200);
  assert.equal(next.body.cursor, 6);
  for (const t of next.body.tracks) assert.ok(!held.includes(t.videoId));
});

test('known channel ids bypass artist-name search, and neighbour catalogues stay capped', async () => {
  const seedId = channel('k');
  const profileId = channel('p');
  const seeds = [track('knownChan01', 'Known Channel', 'Known Artist', { channelId: seedId })];
  setControl({ profiles: { [seedId]: { name: 'Known Artist', adjacent: [] } }, failArtistSearch: true });
  const known = await newUser('known-channel');
  await likeSong(known.cookie, seeds[0]);
  const beforeSearch = logEntries().filter((e) => e.op.startsWith('artistSearch')).length;
  const page = await request('/api/station', { cookie: known.cookie });
  assert.equal(page.status, 200);
  assert.equal(logEntries().filter((e) => e.op.startsWith('artistSearch')).length, beforeSearch,
    'the stored channel id must go straight to artistProfile');

  const ids = [channel('a'), channel('b')];
  const neighbourIds = [channel('c'), channel('d'), channel('e'), channel('f')];
  const profiles = {};
  for (const id of ids) profiles[id] = {
    name: id === ids[0] ? 'Fallback A' : 'Fallback B',
    adjacent: neighbourIds.map((nid, i) => ({ id: nid, name: `Neighbour ${i}` })),
  };
  for (const id of neighbourIds) profiles[id] = { name: 'Neighbour', songs: [] };
  setControl({ profiles, artistIds: { 'Fallback A': ids[0], 'Fallback B': ids[1] } });
  const fallback = await newUser('fallback-channel');
  await likeSong(fallback.cookie, track('fallback01a', 'Different A', 'Fallback A'));
  await likeSong(fallback.cookie, track('fallback01b', 'Different B', 'Fallback B'));
  const start = logEntries().length;
  await request('/api/station', { cookie: fallback.cookie });
  const calls = logEntries().slice(start).filter((e) => e.op === 'artist').map((e) => e.id);
  assert.ok(calls.filter((id) => neighbourIds.includes(id)).length <= 3,
    `one page should not queue all four neighbour catalogues: ${calls.join(',')}`);
});

test('song-level dislikes filter alternate uploads before any up-next fanout', async () => {
  setControl();
  const user = await newUser('dislike-seed');
  const original = track('dislikeOrig', 'Refused Song (Official Video)', 'Refused Band');
  const alternate = track('dislikeAltr', 'Refused Song', 'Refused Band');
  const welcome = track('welcomeSee1', 'Welcome Song', 'Welcome Band');
  await likeSong(user.cookie, original);
  await likeSong(user.cookie, alternate);
  await likeSong(user.cookie, welcome);
  await dislikeSong(user.cookie, original);
  const start = logEntries().length;
  const answer = await request('/api/station', { cookie: user.cookie });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.seeds.map((s) => s.videoId), [welcome.videoId]);
  const expanded = logEntries().slice(start)
    .filter((e) => e.op === 'upNext:start').map((e) => e.videoId);
  assert.ok(!expanded.includes(original.videoId));
  assert.ok(!expanded.includes(alternate.videoId), `alternate upload consumed a fanout slot: ${expanded}`);
  assert.ok(expanded.includes(welcome.videoId));
});

test('a generation change retries rather than returning or caching old evidence', async (t) => {
  const cases = [
    {
      name: 'like', prefix: 'stale-like', initial: [track('staleLikeA1', 'Initial A', 'Initial Artist')],
      added: track('staleLikeB1', 'Added B', 'Added Artist'),
      action: (user, added) => likeSong(user.cookie, added),
      verify: (body, added) => assert.ok(body.seeds.some((s) => s.videoId === added.videoId), 'new like is present'),
    },
    {
      name: 'dislike', prefix: 'stale-dislike', initial: [track('staleHateA1', 'Initial A', 'Initial Artist')],
      explicitLike: true,
      action: (user, _added, initial) => dislikeSong(user.cookie, initial[0]),
      verify: (body) => assert.equal(body.reason, 'no-seeds', 'a disliked only seed disappears immediately'),
    },
    {
      name: 'complete', prefix: 'stale-complete', initial: [track('staleCompA1', 'Initial A', 'Initial Artist')],
      added: track('staleCompB1', 'Added B', 'Added Artist'),
      action: (user, added) => event(user.cookie, added, 'complete'),
      verify: (body, added) => assert.ok(body.seeds.some((s) => s.videoId === added.videoId), 'new completion is present'),
    },
    {
      name: 'skip', prefix: 'stale-skip', initial: [
        track('staleSkipA1', 'Initial A', 'Initial Artist'), track('staleSkipB1', 'Initial B', 'Other Artist'),
      ],
      action: (user, _added, initial) => event(user.cookie, initial[1], 'skip'),
      verify: (body, _added, initial) => {
        const changed = body.seeds.find((s) => s.videoId === initial[1].videoId);
        assert.equal(changed?.score, 1, 'the returned seed carries the post-skip score');
      },
    },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      setControl();
      const user = await newUser(c.prefix);
      for (const initial of c.initial) {
        if (c.explicitLike) await likeSong(user.cookie, initial);
        else await event(user.cookie, initial, 'complete');
      }
      setControl({ holdUpNext: true });
      const start = logEntries().length;
      const pending = request('/api/station', { cookie: user.cookie });
      await waitFor(() => logEntries().slice(start).some((e) => e.op === 'upNext:start'), `${c.name} build is held upstream`);
      await c.action(user, c.added, c.initial);
      setControl({ holdUpNext: false });
      const first = await pending;
      assert.equal(first.status, 200, JSON.stringify(first.body));
      c.verify(first.body, c.added, c.initial);
      const second = await request('/api/station', { cookie: user.cookie });
      c.verify(second.body, c.added, c.initial);
    });
  }
});

test('admin clear-history hands off to the same in-flight generation invalidation', async () => {
  setControl();
  const user = await newUser('stale-clear');
  const seed = track('clearSeed01', 'Clear Me', 'Clear Artist');
  await event(user.cookie, seed, 'complete');
  setControl({ holdUpNext: true });
  const start = logEntries().length;
  const pending = request('/api/station', { cookie: user.cookie });
  await waitFor(() => logEntries().slice(start).some((e) => e.op === 'upNext:start'), 'clear-history build is held upstream');
  const cleared = await request(`/api/admin/users/${user.id}/clear-history`, { cookie: adminCookie, method: 'POST' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  setControl({ holdUpNext: false });
  const first = await pending;
  assert.equal(first.body.reason, 'no-seeds', 'the completed build must not return the cleared evidence');
  const second = await request('/api/station', { cookie: user.cookie });
  assert.equal(second.body.reason, 'no-seeds', 'the cleared evidence must not have been re-cached');
  assert.equal(adminId > 0, true);
});

test('progress invalidates once at sixty percent, not on every later heartbeat', async () => {
  setControl();
  const user = await newUser('progress-seed');
  await likeSong(user.cookie, track('progressBas', 'Base Seed', 'Base Artist'));
  let page = await request('/api/station', { cookie: user.cookie });
  assert.equal(page.body.empty, false);
  const growing = track('progressNew', 'Growing Seed', 'Growing Artist');

  await event(user.cookie, growing, 'progress', { positionMs: 30_000, durationMs: 100_000 });
  page = await request('/api/station', { cookie: user.cookie });
  assert.equal(page.body.cached, true, 'a shallow heartbeat leaves the cached page alone');

  await event(user.cookie, growing, 'progress', { positionMs: 60_000, durationMs: 100_000 });
  page = await request('/api/station', { cookie: user.cookie });
  assert.notEqual(page.body.cached, true, 'crossing sixty percent rebuilds from the new evidence');
  assert.ok(page.body.seeds.some((s) => s.videoId === growing.videoId));

  await event(user.cookie, growing, 'progress', { positionMs: 75_000, durationMs: 100_000 });
  page = await request('/api/station', { cookie: user.cookie });
  assert.equal(page.body.cached, true, 'a later heartbeat above the threshold reuses the new page');
});

test('total upstream failure is retryable at the same cursor; real exhaustion advances', async () => {
  const failedUser = await newUser('failed-lanes');
  await likeSong(failedUser.cookie, track('failedSeed1', 'Failed Seed', 'Unlisted Artist'));
  setControl({ failAll: true });
  const failed = await request('/api/station/next?cursor=3', { cookie: failedUser.cookie });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.cursor, 3, 'a total failure must not spend the draw');
  assert.equal(failed.body.retry, true);
  assert.equal(failed.body.empty, false, 'a transient failure is not terminal no-evidence');
  assert.deepEqual(failed.body.tracks, []);

  setControl({ failAll: false });
  const recovered = await request('/api/station/next?cursor=3', { cookie: failedUser.cookie });
  assert.equal(recovered.body.cursor, 6);
  assert.ok(recovered.body.tracks.length > 0);

  const emptyUser = await newUser('exhausted-lanes');
  await likeSong(emptyUser.cookie, track('emptySeed01', 'Empty Seed', 'Unlisted Artist'));
  setControl({ emptyUpstream: true });
  const exhausted = await request('/api/station/next?cursor=3', { cookie: emptyUser.cookie });
  assert.equal(exhausted.status, 200);
  assert.equal(exhausted.body.cursor, 6, 'successful empty lanes are genuine exhaustion and advance');
  assert.equal(exhausted.body.empty, false);
  assert.notEqual(exhausted.body.retry, true);
});

test('genre votes include their neighbours and reuse the cached winning shelf rows', async () => {
  const seedId = channel('g');
  const rockNeighbour = channel('r');
  const jazzNeighbour = channel('j');
  const user = await newUser('genre-vote');
  await likeSong(user.cookie, track('genreSeed01', 'Genre Seed', 'Genre Seed', { channelId: seedId }));
  setControl({
    profiles: {
      [seedId]: { name: 'Genre Seed', adjacent: [{ id: rockNeighbour, name: 'Rock Neighbour' }] },
      [rockNeighbour]: { name: 'Rock Neighbour', songs: [] },
      [jazzNeighbour]: { name: 'Jazz Neighbour', songs: [] },
    },
  });
  await waitFor(() => logEntries().filter((e) => e.op === 'genreSongs').length === GENRES.length, 'genre shelf warm-up');
  const initialBrowseCalls = logEntries().filter((e) => e.op === 'genreSongs').length;
  assert.equal(initialBrowseCalls, GENRES.length, 'the fixture warmed each shelf exactly once');

  const rock = await request('/api/station', { cookie: user.cookie });
  assert.ok(rock.body.tracks.some((track) => track.videoId === 'rocktrend01'), JSON.stringify({
    tracks: rock.body.tracks, upstream: logEntries(),
  }));
  assert.equal(logEntries().filter((e) => e.op === 'genreSongs').length, initialBrowseCalls,
    'the winner uses the tracks already cached for voting');

  setControl({
    profiles: {
      [seedId]: { name: 'Genre Seed', adjacent: [{ id: jazzNeighbour, name: 'Jazz Neighbour' }] },
      [rockNeighbour]: { name: 'Rock Neighbour', songs: [] },
      [jazzNeighbour]: { name: 'Jazz Neighbour', songs: [] },
    },
  });
  const jazz = await request('/api/station?fresh=1', { cookie: user.cookie });
  assert.ok(jazz.body.tracks.some((track) => track.videoId === 'jazztrend01'), JSON.stringify(jazz.body.tracks));
  assert.ok(!jazz.body.tracks.some((track) => track.videoId === 'rocktrend01'),
    'a cached vote for different neighbours must not be reused');
  assert.equal(logEntries().filter((e) => e.op === 'genreSongs').length, initialBrowseCalls,
    'changing the vote still must not refetch the winning song shelf');
});
