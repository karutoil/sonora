import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './helpers/cdp.js';

// The user-data invariants, without the live-YouTube tests in library.test.js.
// Two independently authenticated clients share only the global catalogue.

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-library-integrity-'));
const DB = path.join(ROOT, 'library.db');
let proc;
let BASE;

function client() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(route, { body, ...options } = {}) {
      const res = await fetch(BASE + route, {
        ...options,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...options.headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie?.()[0];
      if (setCookie) cookie = setCookie.split(';')[0];
      const isJson = res.headers.get('content-type')?.includes('json');
      return { res, body: isJson ? await res.json() : null };
    },
    async login(name, passphrase) {
      const out = await this.request('/api/auth/login', {
        method: 'POST', body: { name, passphrase },
      });
      assert.equal(out.res.status, 200, JSON.stringify(out.body));
      return out;
    },
  };
}

const owner = client();
const other = client();

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: path.join(ROOT, 'audio'),
      SONORA_SECRET: 'library-integrity-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const health = res.ok ? await res.json() : null;
      if (health?.pid === proc.pid) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 119) throw new Error(`server did not start:\n${logs.join('')}`);
  }
  await owner.login('admin', 'hunter2hunter2');
  const created = await owner.request('/api/admin/users', {
    method: 'POST',
    body: { name: 'other', passphrase: 'other-password-123', role: 'user' },
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  await other.login('other', 'other-password-123');
});

after(async () => {
  if (!proc) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await exited;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function makePlaylist(api, title) {
  const out = await api.request('/api/playlists', { method: 'POST', body: { title } });
  assert.equal(out.res.status, 201, JSON.stringify(out.body));
  return out.body.playlist.id;
}

async function addToPlaylist(api, playlistId, track) {
  return api.request(`/api/playlists/${playlistId}/tracks`, { method: 'POST', body: track });
}

const canonical = (videoId) => ({
  videoId,
  title: `Canonical ${videoId}`,
  channel: 'Canonical artist',
  thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  durationS: 295,
});
const hostile = (videoId) => ({
  videoId,
  title: 'Forged title',
  channel: 'Forged artist',
  thumb: 'https://i.ytimg.com/vi/forged/hqdefault.jpg',
  durationS: 1,
});

test('two authenticated users cannot overwrite global canonical track metadata', async () => {
  const ownerPlaylist = await makePlaylist(owner, 'Canonical owner');
  const otherPlaylist = await makePlaylist(other, 'Other listener');
  const cases = [
    { videoId: 'crossLike01', run: (b) => other.request('/api/likes', { method: 'POST', body: { ...b, like: true } }) },
    { videoId: 'crossHate01', run: (b) => other.request('/api/dislikes', { method: 'POST', body: { ...b, dislike: true } }) },
    { videoId: 'crossPlay01', run: (b) => other.request('/api/events', { method: 'POST', body: { ...b, kind: 'progress' } }) },
    { videoId: 'crossList01', run: (b) => addToPlaylist(other, otherPlaylist, b) },
  ];
  for (const { videoId, run } of cases) {
    const added = await addToPlaylist(owner, ownerPlaylist, canonical(videoId));
    assert.equal(added.res.status, 200, JSON.stringify(added.body));
    const changed = await run(hostile(videoId));
    assert.equal(changed.res.status, 200, JSON.stringify(changed.body));
  }

  for (const { videoId } of cases) {
    const expected = canonical(videoId);
    for (const [label, api] of [['owner', owner], ['other', other]]) {
      const out = await api.request(`/api/track/${videoId}`);
      assert.equal(out.res.status, 200);
      assert.deepEqual(out.body.track, expected, `${label} sees canonical metadata after ${videoId}`);
    }
  }

  // A genuinely unknown shared track still gets enough metadata to appear in a
  // library; the protection is against overwriting an existing row.
  const shared = await other.request('/api/likes', {
    method: 'POST', body: { ...canonical('shareNew001'), like: true },
  });
  assert.equal(shared.res.status, 200);
  const remembered = await owner.request('/api/track/shareNew001');
  assert.equal(remembered.body.track.title, 'Canonical shareNew001');
});

test('likes, dislikes, playback flags, and ordering fields are strictly validated', async () => {
  for (const [route, field] of [['/api/likes', 'like'], ['/api/dislikes', 'dislike']]) {
    for (const value of ['false', 1, null]) {
      const out = await owner.request(route, {
        method: 'POST',
        body: { videoId: 'strictBool1', [field]: value },
      });
      assert.equal(out.res.status, 400, `${route} ${field}=${JSON.stringify(value)}`);
    }
    const missing = await owner.request(route, { method: 'POST', body: { videoId: 'strictBool1' } });
    assert.equal(missing.res.status, 400);
  }

  for (const field of ['takeover', 'station', 'playing']) {
    const out = await owner.request('/api/now', {
      method: 'PUT', body: { deviceId: 'strict-device', [field]: 'false' },
    });
    assert.equal(out.res.status, 400, `${field}=string must not be coerced`);
  }

  for (const [field, value] of [
    ['clientSavedAt', -1], ['clientSavedAt', 1.5], ['clientSavedAt', '100'],
    ['clientSaveSeq', 0], ['clientSaveSeq', -1], ['clientSaveSeq', 1.5], ['clientSaveSeq', '1'],
  ]) {
    const out = await owner.request('/api/now', {
      method: 'PUT', body: { deviceId: 'strict-device', [field]: value },
    });
    assert.equal(out.res.status, 400, `${field}=${JSON.stringify(value)}`);
  }
});

test('every playlist verb rejects non-positive, unsafe, and non-integer ids', async () => {
  const playlistId = await makePlaylist(owner, 'Identifier validation');
  const malformed = ['0', '-1', '1.5', '9007199254740992', 'abc', '1e0'];
  for (const id of malformed) {
    const calls = [
      ['GET', `/api/playlists/${id}`, undefined],
      ['POST', `/api/playlists/${id}/tracks`, { videoId: 'validid1234' }],
      ['DELETE', `/api/playlists/${id}/tracks/validid1234`, undefined],
      ['DELETE', `/api/playlists/${id}`, undefined],
    ];
    for (const [method, route, body] of calls) {
      const out = await owner.request(route, { method, body });
      assert.equal(out.res.status, 400, `${method} ${route}`);
    }
  }
  assert.equal((await owner.request(`/api/playlists/${playlistId}`)).res.status, 200);
});

test('durations and playhead numbers must be finite nonnegative safe integers', async () => {
  const playlistId = await makePlaylist(owner, 'Duration validation');
  const invalid = [-1, 1.25, 9_007_199_254_740_992, '295'];
  for (const value of invalid) {
    const added = await addToPlaylist(owner, playlistId, { videoId: 'duration001', durationS: value });
    assert.equal(added.res.status, 400, `playlist duration ${value}`);
    for (const [route, field] of [['/api/events', 'positionMs'], ['/api/events', 'durationMs'], ['/api/now', 'positionMs']]) {
      const body = route === '/api/events'
        ? { videoId: 'duration001', kind: 'progress', [field]: value }
        : { deviceId: 'duration-device', [field]: value };
      const out = await owner.request(route, { method: route === '/api/now' ? 'PUT' : 'POST', body });
      assert.equal(out.res.status, 400, `${route} ${field}=${value}`);
    }
    const like = await owner.request('/api/likes', {
      method: 'POST', body: { videoId: 'duration001', like: true, title: 'Duration', durationS: value },
    });
    assert.equal(like.res.status, 400, `like metadata duration ${value}`);
  }

  // 1e400 is valid JSON syntax but parses as Infinity, not a finite duration.
  const infinite = await owner.request('/api/events', {
    method: 'POST', body: '{"videoId":"duration001","kind":"progress","durationMs":1e400}',
  });
  assert.equal(infinite.res.status, 400);

  for (const value of invalid) {
    const queued = await owner.request('/api/now', {
      method: 'PUT', body: { queue: [{ videoId: 'duration001', durationS: value }], index: 0 },
    });
    assert.equal(queued.res.status, 400, `queue duration ${value}`);
  }
  const valid = await addToPlaylist(owner, playlistId, { videoId: 'duration001', durationS: Number.MAX_SAFE_INTEGER });
  assert.equal(valid.res.status, 200);
});

test('removing an absent or malformed playlist track is a true no-op', async () => {
  const playlistId = await makePlaylist(owner, 'Removal idempotence');
  assert.equal((await addToPlaylist(owner, playlistId, canonical('removeMe001'))).res.status, 200);
  assert.equal((await owner.request(`/api/playlists/${playlistId}/tracks/removeMe001`, { method: 'DELETE' })).res.status, 200);
  const before = await owner.request(`/api/playlists/${playlistId}`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const absent = await owner.request(`/api/playlists/${playlistId}/tracks/removeMe001`, { method: 'DELETE' });
  assert.equal(absent.res.status, 200);
  const afterAbsent = await owner.request(`/api/playlists/${playlistId}`);
  assert.equal(afterAbsent.body.playlist.updatedAt, before.body.playlist.updatedAt);

  const malformed = await owner.request(`/api/playlists/${playlistId}/tracks/not-valid`, { method: 'DELETE' });
  assert.equal(malformed.res.status, 400);
  const afterMalformed = await owner.request(`/api/playlists/${playlistId}`);
  assert.equal(afterMalformed.body.playlist.updatedAt, before.body.playlist.updatedAt);
});

test('now saves reject stale same-device writes and keep necessary queue conflicts', async () => {
  const queue = [
    { videoId: 'validid1234', title: 'A' },
    { videoId: 'dQw4w9WgXcQ', title: 'B' },
  ];
  const base = { queue, index: 0, deviceId: 'ordering-device', playing: true };
  const newest = await owner.request('/api/now', {
    method: 'PUT', body: { ...base, positionMs: 99_999, clientSavedAt: 2_000, clientSaveSeq: 1, takeover: true },
  });
  assert.equal(newest.res.status, 200, JSON.stringify(newest.body));

  const old = await owner.request('/api/now', {
    method: 'PUT', body: { ...base, positionMs: 11_111, clientSavedAt: 1_000, clientSaveSeq: 99 },
  });
  assert.equal(old.res.status, 409);
  assert.equal(old.body.code, 'STALE_SAVE');
  assert.equal(old.body.state, undefined, 'a same-device stale response does not echo a whole queue');
  assert.ok(JSON.stringify(old.body).length < 300);

  const sameTimeNew = await owner.request('/api/now', {
    method: 'PUT', body: { deviceId: 'ordering-device', videoId: queue[1].videoId, index: 1,
      positionMs: 88_888, clientSavedAt: 2_000, clientSaveSeq: 3 },
  });
  assert.equal(sameTimeNew.res.status, 200, JSON.stringify(sameTimeNew.body));
  const sameTimeOld = await owner.request('/api/now', {
    method: 'PUT', body: { deviceId: 'ordering-device', positionMs: 77_777,
      clientSavedAt: 2_000, clientSaveSeq: 2 },
  });
  assert.equal(sameTimeOld.res.status, 409);

  const current = await owner.request('/api/now');
  assert.equal(current.body.state.positionMs, 88_888);
  assert.equal(current.body.state.index, 1);

  const conflict = await owner.request('/api/now', {
    method: 'PUT', body: { ...base, deviceId: 'conflict-device', positionMs: 4,
      clientSavedAt: 3_000, clientSaveSeq: 1 },
  });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.code, 'DEVICE_CONFLICT');
  assert.deepEqual(conflict.body.state.tracks.map((t) => t.videoId), queue.map((t) => t.videoId),
    'the other-device conflict still carries the queue needed to adopt it');
});

test('repeated absolute likes and dislikes do not duplicate taste evidence', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  for (const [route, field, kind, videoId] of [
    ['/api/likes', 'like', 'like', 'idemLike001'],
    ['/api/dislikes', 'dislike', 'dislike', 'idemHate001'],
  ]) {
    for (let i = 0; i < 3; i++) {
      const out = await owner.request(route, { method: 'POST', body: { videoId, [field]: true } });
      assert.equal(out.res.status, 200);
    }
    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM plays p JOIN users u ON u.id = p.user_id
      WHERE u.name = 'admin' AND p.video_id = ? AND p.kind = ?
    `).get(videoId, kind);
    db.close();
    assert.equal(row.n, 1, `${route}: three identical requests must be one evidence transition`);
  }
});

test('stats preserve outputs while ignoring non-counter play kinds', async () => {
  const baseline = await owner.request('/api/stats');
  assert.equal(baseline.res.status, 200);
  for (const kind of ['start', 'complete', 'skip', 'progress']) {
    const event = await owner.request('/api/events', {
      method: 'POST', body: { videoId: 'stats000001', kind },
    });
    assert.equal(event.res.status, 200, JSON.stringify(event.body));
  }
  const after = await owner.request('/api/stats');
  for (const [field, delta] of [['starts', 1], ['completes', 1], ['skips', 1]]) {
    assert.equal(after.body[field], baseline.body[field] + delta, field);
  }
  assert.equal(after.body.likes, baseline.body.likes);
});

test('queue filtering resolves the requested index in original queue positions', async () => {
  const out = await owner.request('/api/now', {
    method: 'PUT',
    body: {
      queue: [
        { videoId: 'not valid!', title: 'discarded' },
        { videoId: 'validid1234', title: 'A' },
        { videoId: 'dQw4w9WgXcQ', title: 'B' },
      ],
      index: 1, positionMs: 0, deviceId: 'filtered-device', takeover: true,
    },
  });
  assert.equal(out.res.status, 200, JSON.stringify(out.body));
  const current = await owner.request('/api/now');
  assert.equal(current.body.state.tracks[current.body.state.index].title, 'A');
});
