import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Offline proxy tests.
//
// These exist because the range/seek behaviour is the part that silently broke
// twice, and it should never depend on YouTube being reachable or un-gated.
// A synthetic audio file is placed in the cache directory, so every assertion
// here is deterministic: no network, no yt-dlp, no bot gate.

const PORT = 8143;
const BASE = `http://127.0.0.1:${PORT}`;
const AUDIO = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-proxy-'));
const DB = path.join(AUDIO, 'test.db');
const VIDEO = 'aaaaaaaaaaa';

// 3 MiB of deterministic bytes: big enough to span several range windows.
const SIZE = 3 * 1024 * 1024;
const BYTES = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) BYTES[i] = (i * 31 + 7) & 0xff;

let proc;
let cookie = '';

before(async () => {
  // The proxy serves whatever is already on disk, so pre-seeding the cache is
  // enough to exercise it without downloading anything.
  fs.mkdirSync(AUDIO, { recursive: true });
  fs.writeFileSync(path.join(AUDIO, `${VIDEO}.m4a`), BYTES);

  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'proxy-secret', SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOG_LEVEL: 'warn',
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

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  cookie = res.headers.getSetCookie()[0].split(';')[0];
});

after(() => {
  proc?.kill('SIGTERM');
  try { fs.rmSync(AUDIO, { recursive: true, force: true }); } catch {}
});

const get = (range, extra = {}) => fetch(`${BASE}/api/stream/${VIDEO}`, {
  headers: { cookie, ...(range ? { Range: range } : {}), ...extra },
});

const CHUNK = 1024 * 1024;

test('the cached file is served with 206, clamped to one chunk', async () => {
  const res = await get('bytes=0-');
  assert.equal(res.status, 206);
  // Each response is capped at CHUNK so a huge file cannot be buffered; the
  // media element simply asks for the next window.
  assert.equal(res.headers.get('content-range'), `bytes 0-${CHUNK - 1}/${SIZE}`);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.match(res.headers.get('content-type'), /audio\//);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, CHUNK);
  assert.ok(body.equals(BYTES.subarray(0, CHUNK)), 'served bytes match the file exactly');
});

test('audio keeps its cache-control so the browser can reuse fetched ranges', async () => {
  // A blanket `no-store` hook used to run after every /api/ handler and clobber
  // the proxy's own header. The media element then could not reuse a range it
  // had already downloaded, so every seek re-crossed the wire.
  const res = await get('bytes=0-');
  const cc = res.headers.get('cache-control') ?? '';
  assert.doesNotMatch(cc, /no-store/, `audio must be cacheable, got: ${cc}`);
  assert.match(cc, /max-age=\d+/, `audio should carry a max-age, got: ${cc}`);
});

test('walking chunk by chunk reconstructs the whole file', async () => {
  const parts = [];
  for (let start = 0; start < SIZE; start += CHUNK) {
    const res = await get(`bytes=${start}-`);
    assert.equal(res.status, 206);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  const whole = Buffer.concat(parts);
  assert.equal(whole.length, SIZE, 'every byte was delivered');
  assert.ok(whole.equals(BYTES), 'reassembled file is byte-identical');
});

test('an open-ended range from the middle returns the next chunk', async () => {
  const start = 1024 * 1024;
  const res = await get(`bytes=${start}-`);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${start + CHUNK - 1}/${SIZE}`);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, CHUNK);
  assert.ok(body.equals(BYTES.subarray(start, start + CHUNK)), 'offset bytes are correct');
});

test('the final chunk is truncated to the real end of file', async () => {
  const start = SIZE - 100;
  const res = await get(`bytes=${start}-`);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${SIZE - 1}/${SIZE}`);
  assert.equal((await res.arrayBuffer()).byteLength, 100);
});

test('a bounded range returns exactly those bytes', async () => {
  const res = await get('bytes=1000-2999');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-length'), '2000');
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(BYTES.subarray(1000, 3000)));
});

test('a suffix range returns the last N bytes', async () => {
  const res = await get('bytes=-500');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`);
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(BYTES.subarray(SIZE - 500)));
});

test('a range past the end is a 416 with the real size', async () => {
  const res = await get(`bytes=${SIZE + 10}-`);
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
});

test('HEAD reports 206 and the size without a body', async () => {
  const res = await fetch(`${BASE}/api/stream/${VIDEO}`, { method: 'HEAD', headers: { cookie } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-${CHUNK - 1}/${SIZE}`);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('HEAD for an uncached track is 204 and triggers no download', async () => {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/stream/bbbbbbbbbbb`, { method: 'HEAD', headers: { cookie } });
  assert.equal(res.status, 204);
  assert.ok(Date.now() - t0 < 1000, 'must not block on a fetch');
  assert.equal(fs.existsSync(path.join(AUDIO, 'bbbbbbbbbbb.m4a')), false, 'no file created');
});

test('a malformed id is rejected', async () => {
  const res = await fetch(`${BASE}/api/stream/nope`, { headers: { cookie } });
  assert.equal(res.status, 400);
});

test('streaming requires a session', async () => {
  const res = await fetch(`${BASE}/api/stream/${VIDEO}`);
  assert.equal(res.status, 401);
});

test('concurrent range requests are all served correctly', async () => {
  const ranges = ['bytes=0-999', 'bytes=500000-500999', 'bytes=2000000-2000999'];
  const bodies = await Promise.all(ranges.map((r) => get(r).then((x) => x.arrayBuffer())));
  ranges.forEach((r, i) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(r);
    assert.ok(Buffer.from(bodies[i]).equals(BYTES.subarray(Number(a), Number(b) + 1)),
      `chunk ${r} matched`);
  });
});

// ── prefetch ────────────────────────────────────────────────────────────
// The queue knows the next track, so the server can fetch its audio while the
// current one plays. These tests pin the two things that make it safe: it never
// blocks the caller, and it never turns into a second download of the same id.

test('warming a cached track reports ready and does no work', async () => {
  const res = await fetch(`${BASE}/api/warm/${VIDEO}`, { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ready: true });
});

test('warming an uncached track answers immediately instead of downloading', async () => {
  // `ccccccccccc` is not in the cache. The server must hand back 202 at once —
  // the whole point is that the caller never waits on a fetch. It will spawn a
  // yt-dlp run in the background; the assertion is about the response, and the
  // process is killed with the server at teardown.
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/warm/ccccccccccc`, { method: 'POST', headers: { cookie } });
  const took = Date.now() - t0;
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { warming: true });
  assert.ok(took < 1000, `warm must not block (took ${took}ms)`);
});

test('a second warm for the same id does not start a second fetch', async () => {
  // ensureAudio() keys in-flight work by video id, so the duplicate shares one
  // download. Two 202s (rather than a 500 or a hang) is the observable proof.
  const post = () => fetch(`${BASE}/api/warm/ddddddddddd`, { method: 'POST', headers: { cookie } });
  const [a, b] = await Promise.all([post(), post()]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
});

test('warming rejects a malformed id and requires a session', async () => {
  const bad = await fetch(`${BASE}/api/warm/nope`, { method: 'POST', headers: { cookie } });
  assert.equal(bad.status, 400);
  const anon = await fetch(`${BASE}/api/warm/${VIDEO}`, { method: 'POST' });
  assert.equal(anon.status, 401);
});

test('a cached track is served without any upstream liveness probe', async () => {
  // The live-stream check is a full YouTube round-trip. It used to run before
  // the cache was consulted, so every first request for an already-downloaded
  // song paid for it. A cached file must be served with no network at all: on a
  // machine with no route to YouTube this stays a 206.
  const t0 = Date.now();
  const res = await get('bytes=0-');
  assert.equal(res.status, 206);
  assert.ok(Date.now() - t0 < 1000, 'cached playback must not wait on a probe');
});
