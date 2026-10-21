import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './helpers/cdp.js';

// The endless station over the real HTTP API.
//
// The ranking is unit-tested in station.test.js; this proves the *contract* the
// client's top-up depends on: an extension never re-offers what the queue
// already holds, it advances the cursor so the station cannot get stuck, and a
// person with no evidence gets an honest empty answer rather than noise.
//
// Extensions are built from YouTube's recommender (upNext), like every other
// collection route, so the live assertions skip when the catalogue answers with
// nothing — the same condition test/e2e.test.js reports as a bot gate.

const DB = new URL(`./.tmp/endless-${Date.now()}.db`, import.meta.url).pathname;
const AUDIO = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-endless-'));
// A free port, not a fixed one: two runs of this file back to back would
// otherwise hand the second run the first one's still-exiting server — and its
// database. That stale-process trap has burned this project before.
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let cookie = '';

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, {
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

/** Three real uploads, so the recommender has something to expand from. */
const SEED_TRACKS = [
  { videoId: '2tOutF8B3f8', title: 'Xtal', channel: 'Aphex Twin' },
  { videoId: 'fAuT8_dboWo', title: 'Fixture Two', channel: 'Fixture Channel' },
  { videoId: 'dQw4w9WgXcQ', title: 'Fixture Three', channel: 'Fixture Channel' },
];

before(async () => {
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'endless-secret', SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
      // Keep every yt-dlp/PO-token subprocess out of the critical path: this
      // suite only ever asks the metadata graph for recommendations.
      SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 120; i++) {
    try {
      const health = await (await fetch(`${BASE}/api/health`)).json();
      // Only *our* process counts: an older server that still holds a port
      // answers health too, and would run these assertions on its own database.
      if (health.ok && health.pid === proc.pid) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const { res } = await jfetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 200, 'login failed');
});

after(async () => {
  proc?.kill('SIGTERM');
  try { fs.rmSync(AUDIO, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

/** Give the station evidence: every seed is played through once. */
async function seedEvidence() {
  for (const t of SEED_TRACKS) {
    const { res } = await jfetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        ...t, kind: 'start', source: 'station', positionMs: 1000, durationMs: (t.durationS || 200) * 1000,
      }),
    });
    assert.equal(res.status, 200);
    await jfetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        ...t, kind: 'complete', source: 'station',
        positionMs: (t.durationS || 200) * 1000, durationMs: (t.durationS || 200) * 1000,
      }),
    });
  }
}

test('the extension is login-only', async () => {
  const res = await fetch(`${BASE}/api/station/next`);
  assert.equal(res.status, 401);
});

test('junk in exclude/cursor is ignored, not trusted', async () => {
  const { res } = await jfetch('/api/station/next?cursor=-4&exclude=not-a-video,%20,,dQw4w9WgXcQ');
  assert.equal(res.status, 200, 'a nonsensical cursor must not be an error');
});

test('without evidence the station is honestly empty — both pages', async () => {
  // A second account with no listening at all.
  const created = await jfetch('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ name: 'nohistory', passphrase: 'hunter2hunter2', role: 'user' }),
  });
  assert.equal(created.res.status, 201, 'could not create the empty account');

  const admin = cookie;
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nohistory', passphrase: 'hunter2hunter2' }),
  });
  const fresh = login.headers.getSetCookie()[0].split(';')[0];

  const first = await fetch(`${BASE}/api/station`, { headers: { cookie: fresh } });
  const firstBody = await first.json();
  assert.equal(firstBody.empty, true, 'no evidence must not invent a station');
  assert.deepEqual(firstBody.tracks, []);

  const next = await fetch(`${BASE}/api/station/next?cursor=3`, { headers: { cookie: fresh } });
  const nextBody = await next.json();
  assert.equal(nextBody.empty, true);
  assert.deepEqual(nextBody.tracks, []);

  cookie = admin;
});

test('an extension never returns what the queue already holds', async (t) => {
  await seedEvidence();

  const first = await jfetch('/api/station');
  assert.equal(first.res.status, 200);
  if (!first.body.tracks?.length) {
    t.skip('YouTube returned no recommendations (bot gate or empty graph)');
    return;
  }

  const held = first.body.tracks.map((x) => x.videoId);
  const { res, body } = await jfetch(
    `/api/station/next?cursor=3&exclude=${encodeURIComponent(held.join(','))}`,
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.tracks));
  assert.equal(body.cursor, 6, 'the cursor advances so the station cannot stall');

  const given = body.tracks.map((x) => x.videoId);
  assert.equal(new Set(given).size, given.length, 'one page must not repeat itself');
  for (const id of given) {
    assert.ok(!held.includes(id), `${id} was already in the queue`);
  }
});

test('two extensions do not converge on the same songs', async (t) => {
  const first = await jfetch('/api/station');
  if (!first.body.tracks?.length) {
    t.skip('YouTube returned no recommendations (bot gate or empty graph)');
    return;
  }

  const held = new Set(first.body.tracks.map((x) => x.videoId));
  const pageA = await jfetch(`/api/station/next?cursor=3&exclude=${encodeURIComponent([...held].join(','))}`);

  const heldB = new Set([...held, ...(pageA.body.tracks ?? []).map((x) => x.videoId)]);
  const pageB = await jfetch(`/api/station/next?cursor=6&exclude=${encodeURIComponent([...heldB].join(','))}`);

  const a = (pageA.body.tracks ?? []).map((x) => x.videoId);
  const b = (pageB.body.tracks ?? []).map((x) => x.videoId);
  // A different cursor expands a different seed, so the overlap must be small;
  // identical pages would mean the "endless" station is just the same 20 songs.
  const overlap = b.filter((id) => a.includes(id));
  assert.ok(overlap.length < Math.max(1, a.length),
    `page 2 repeated page 1 wholesale (${overlap.length}/${a.length})`);
});

test('the extension is advertised, so a stale server is detectable', async () => {
  const { body } = await jfetch('/api/health');
  assert.ok(body.features.includes('station-next'),
    'a bundle that calls /api/station/next needs the server to say it exists');
});
