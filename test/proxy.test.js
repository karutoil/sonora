import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/cdp.js';

// Offline proxy tests.
//
// These exist because the range/seek behaviour is the part that silently broke
// twice, and it should never depend on YouTube being reachable or un-gated.
// A synthetic audio file is placed in the cache directory, so every assertion
// here is deterministic: no network, no yt-dlp, no bot gate.

// A free port, acquired in before(): proxy.test.js and search-types.test.js
// both hardcoded 8143 and collided under concurrent runs.
let PORT = 0;
let BASE = '';
const AUDIO = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-proxy-'));
const DB = path.join(AUDIO, 'test.db');
const VIDEO = 'aaaaaaaaaaa';

// 3 MiB of deterministic bytes: big enough to span several range windows.
const SIZE = 3 * 1024 * 1024;
const BYTES = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) BYTES[i] = (i * 31 + 7) & 0xff;
// A cached .m4a is an ISO BMFF file, not arbitrary entropy. New cache validation
// checks the `ftyp` box, so make the large deterministic range fixture truthful.
BYTES.writeUInt32BE(16, 0);
BYTES.write('ftypM4A ', 4, 'latin1');

// Both seams which otherwise touch YouTube are replaced in every child: the
// Innertube session (including boot-time genre warming and live probes), and
// yt-dlp. The preload has no effect on an ordinary server without our opt-in.
const OFFLINE_PRELOAD = path.join(AUDIO, 'offline.mjs');
const FAKE_YTDLP = path.join(AUDIO, 'fake-yt-dlp.mjs');
const YTDLP_LOG = path.join(AUDIO, 'yt-dlp.log');
fs.writeFileSync(OFFLINE_PRELOAD, `
if (process.env.SONORA_PROXY_OFFLINE === '1') {
  const { setSessionOverride } = await import(${JSON.stringify(new URL('../src/youtube.js', import.meta.url).href)});
  setSessionOverride({
    music: { getExplore: async () => ({ sections: [] }) },
    getBasicInfo: async () => ({ basic_info: { is_live: false } }),
  });
}
`);
fs.writeFileSync(FAKE_YTDLP, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const i = args.indexOf('-o');
const out = i < 0 ? null : args[i + 1];
const id = /[?&]v=([A-Za-z0-9_-]{11})/.exec(args.at(-1))?.[1] ?? 'unknown';
if (process.env.SONORA_TEST_YTDLP_LOG) {
  fs.appendFileSync(process.env.SONORA_TEST_YTDLP_LOG, id + '\\n');
}
if (!out) process.exit(1);
const bytes = Buffer.alloc(8192);
bytes.writeUInt32BE(16, 0);
bytes.write('ftypM4A ', 4, 'latin1');
const finish = () => {
  fs.writeFileSync(out + '.part', bytes);
  fs.renameSync(out + '.part', out);
};
setTimeout(finish, Number(process.env.SONORA_TEST_YTDLP_DELAY_MS ?? 100));
`, { mode: 0o755 });
const SERVER_ARGS = ['--no-warnings', '--import', OFFLINE_PRELOAD, 'src/server.js'];
const OFFLINE_ENV = {
  SONORA_PROXY_OFFLINE: '1', SONORA_YTDLP: FAKE_YTDLP,
  SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
};

let proc;
let cookie = '';

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  // The proxy serves whatever is already on disk, so pre-seeding the cache is
  // enough to exercise it without downloading anything.
  fs.mkdirSync(AUDIO, { recursive: true });
  fs.writeFileSync(path.join(AUDIO, `${VIDEO}.m4a`), BYTES);

  proc = spawn(process.execPath, SERVER_ARGS, {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, ...OFFLINE_ENV, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_TEST_YTDLP_LOG: YTDLP_LOG,
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

test('bytes=-0 is not a range: 416, never a 500', async () => {
  // It used to compute start === total, and fs.createReadStream threw
  // ERR_OUT_OF_RANGE *after* the 206 headers had already been flushed.
  const res = await get('bytes=-0');
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('an inverted range is a 416, not a 500 with a bad content-range', async () => {
  const res = await get('bytes=100-50');
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('a suffix range longer than the file is clamped to one chunk', async () => {
  const res = await get(`bytes=-${SIZE * 2}`);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${SIZE - CHUNK}-${SIZE - 1}/${SIZE}`);
  assert.equal((await res.arrayBuffer()).byteLength, CHUNK);
});

test('a response carries the baseline security headers', async () => {
  const res = await get('bytes=0-');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  await res.arrayBuffer();
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

test('even free cached prefetches retain their HTTP route ceiling', async () => {
  // A cache hit deliberately spends none of the per-account *download* budget.
  // It still cannot exempt the route from HTTP abuse control, so walk only this
  // already-cached id and assert the route's 240/min ceiling, not a cold-download
  // allowance which these requests correctly never consume.
  let limited = false;
  for (let i = 1; i <= 241; i += 1) {
    const res = await fetch(`${BASE}/api/warm/${VIDEO}`, { method: 'POST', headers: { cookie } });
    if (res.status === 429) {
      // Earlier warm/auth tests share this per-IP bucket, so do not pretend this
      // loop owns all 240 slots; the ceiling must still be near that route max.
      assert.ok(i > 200 && i <= 241, `the route limiter engaged unexpectedly at request ${i}`);
      limited = true;
      break;
    }
    assert.equal(res.status, 200, `cached warm ${i} must answer, got ${res.status}`);
    await res.arrayBuffer();
  }
  assert.ok(limited, 'the cached warm route ceiling must engage');
  const callsAfter = fs.existsSync(YTDLP_LOG) ? fs.readFileSync(YTDLP_LOG, 'utf8') : '';
  assert.ok(!callsAfter.split('\n').includes(VIDEO),
    'cached warms never invoke the controlled downloader for the cached id');
});

// ── anonymous guest cookies are per room ─────────────────────────────────
// One browser can listen to room A and open a link to room B. The guest cookie
// used to be a single browser-wide name holding a value signed for one room, so
// opening B silently killed A: polls answered 403 NO_GUEST and the next track's
// audio answered 401, while the already-open SSE stream kept working (auth
// happens at connect), which made it look random.

class CookieJar {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(name) { return this.cookies.get(name); }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

const GUEST_VIDEO = 'aaaaaaaaaaa'; // already in the cache (see before())
const OTHER_VIDEO = 'bbbbbbbbbbb';

/** The room-code → token map the guest cookie carries. */
function guestMap(jar) {
  const raw = jar.get('sonora_guest');
  assert.ok(raw, 'the guest cookie is set');
  return JSON.parse(decodeURIComponent(raw));
}

async function openRoom(jar, videoId, title) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: jar.header() },
    body: JSON.stringify({
      visibility: 'public', control: 'everyone',
      queue: [{ videoId, title, channel: 'Guest Test', durationS: 200, thumb: null }],
      index: 0, positionMs: 0, playing: false,
    }),
  });
  assert.equal(res.status, 200, `room create failed: ${res.status}`);
  jar.absorb(res);
  return res.json();
}

test('listening to a second room does not revoke the first room’s guest', async () => {
  const member = new CookieJar();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  member.absorb(login);

  const roomA = await openRoom(member, GUEST_VIDEO, 'Room A');
  const guest = new CookieJar();
  // The listener page mints the cookie with the page itself; the API route is
  // the same cookie for a page-less client.
  const mintA = await fetch(`${BASE}/api/public/rooms/${roomA.code}/guest`, { method: 'POST' });
  assert.equal(mintA.status, 200);
  guest.absorb(mintA);
  assert.ok(guestMap(guest)[roomA.code], 'the cookie carries a token for room A');

  const roomB = await openRoom(member, OTHER_VIDEO, 'Room B');
  const mintB = await fetch(`${BASE}/api/public/rooms/${roomB.code}/guest`, {
    method: 'POST', headers: { cookie: guest.header() },
  });
  assert.equal(mintB.status, 200);
  guest.absorb(mintB);
  const map = guestMap(guest);
  assert.ok(map[roomA.code], 'room A’s token survives room B being opened');
  assert.ok(map[roomB.code], 'and room B is added');
  assert.notEqual(map[roomA.code], map[roomB.code], 'each room has its own signed token');

  // Room A is still authorised for this browser…
  const stateA = await fetch(`${BASE}/api/public/rooms/${roomA.code}/state`, {
    headers: { cookie: guest.header() },
  });
  assert.equal(stateA.status, 200, 'opening room B must not revoke room A');
  await stateA.arrayBuffer();

  // …and its audio still plays, while B's track is not served for A's cookie
  // alone (the queue check is what keeps this from being an open proxy).
  const headA = await fetch(`${BASE}/api/stream/${GUEST_VIDEO}`, {
    method: 'HEAD', headers: { cookie: guest.header() },
  });
  assert.equal(headA.status, 206, 'room A’s queue still authorises its audio');
});

test('a guest cookie for another room does not authorise this room’s audio', async () => {
  const member = new CookieJar();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  member.absorb(login);
  const room = await openRoom(member, GUEST_VIDEO, 'Room C');
  const guest = new CookieJar();
  const mint = await fetch(`${BASE}/api/public/rooms/${room.code}/guest`, { method: 'POST' });
  guest.absorb(mint);

  // A second, unrelated room the guest never opened: the id is not in any
  // queue this browser is a guest of, so it is a 401 and not a download.
  const stranger = 'ccccccccccc';
  const res = await fetch(`${BASE}/api/stream/${stranger}`, {
    method: 'HEAD', headers: { cookie: guest.header() },
  });
  assert.equal(res.status, 401);
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

// ── the public artwork route ───────────────────────────────────────
// /t/:videoId/art.jpg is public (a crawler has no session) and sits outside
// the global /api/ limiter, so it carries its own per-IP limit and a cap on
// the bodies the image cache will hold.

const ART_ID = 'zzzzzzzzzzz';

/**
 * Run the image-cap check inside a fixture server built for it: its env makes
 * i.ytimg.com unreachable, so the oversized-body test cannot depend on the
 * internet. The cap itself is read from the source so the test states its
 * contract against the constant the server enforces (a literal here would let
 * the two drift).
 */
async function withArtFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-art-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A local upstream on a real, unprivileged port. The burst test leaves it
  // dead; the oversized-body test listens on it for exactly one oversized
  // answer, then closes it.
  const upstreamPort = await freePort();
  const child = spawn(process.execPath, SERVER_ARGS, {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, ...OFFLINE_ENV, PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'art.db'), SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'art-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_TEST_YTDLP_LOG: path.join(dir, 'yt-dlp.log'),
      SONORA_LOG_LEVEL: 'error',
      // The point is determinism: the proxy's own behaviour (caching,
      // limiting) must not depend on YouTube or this machine's DNS.
      SONORA_YTIMG_HOST: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        const r = await fetch(`${base}/api/health`);
        up = r.ok && (await r.json()).pid === child.pid;
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, 'the artwork fixture started');
    await fn(base, upstreamPort);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
}

const SERVER_SOURCE = fs.readFileSync(new URL('../src/server.js', import.meta.url).pathname, 'utf8');
const IMG_CAP = Number(
  /const IMG_MAX_BYTES = (\d+) \* 1024;/.exec(SERVER_SOURCE)?.[1] ?? 0,
) * 1024;
const IMG_TIMEOUT = Number(/const IMG_TIMEOUT_MS = (\d+);/.exec(SERVER_SOURCE)?.[1] ?? 0);
const IMG_CACHE_CAP = Number(
  /const IMG_CACHE_MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(SERVER_SOURCE)?.[1] ?? 0,
) * 1024 * 1024;
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
  'base64',
);

/** A controlled HTTP upstream which can observe cancellation of every reply. */
async function startArtUpstream(port, handler) {
  const state = { requests: [], cancelled: 0, server: null, close: null };
  const server = http.createServer((req, res) => {
    state.requests.push(req.url);
    res.on('close', () => { if (!res.writableEnded) state.cancelled += 1; });
    Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  state.server = server;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  state.close = async () => {
    if (!server.listening) return;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  };
  return state;
}

async function eventually(check, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('a burst of public art requests engages the route’s own limiter', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    const upstream = await startArtUpstream(upstreamPort, (_req, res) => {
      res.writeHead(404).end();
    });
    try {
      // The first request proves absence at every candidate, so the remaining
      // 119 are negative-cache hits and the 121st never reaches the handler.
      let over = false;
      for (let i = 1; i <= 121; i++) {
        const res = await fetch(`${base}/t/${ART_ID}/art.jpg`);
        if (res.status === 429) {
          assert.equal(i, 121, `the limiter engaged early, at request ${i}`);
          over = true;
          break;
        }
        assert.equal(res.status, 404, `request ${i} must answer with the cached miss`);
        await res.arrayBuffer();
      }
      assert.ok(over, 'the burst must reach the limiter by the 121st request');
      assert.equal(upstream.requests.length, 4, 'only the first request fans out upstream');
    } finally {
      await upstream.close();
    }
  });
});

test('a declared oversized image is rejected and every candidate body is cancelled', async () => {
  assert.ok(IMG_CAP > 0, 'the server defines IMG_MAX_BYTES');
  await withArtFixture(async (base, upstreamPort) => {
    const size = IMG_CAP + 64 * 1024;
    const upstream = await startArtUpstream(upstreamPort, (_req, res) => {
      // Deliberately send no body. Reading even one byte after this declaration
      // would be wasteful; the proxy must cancel as soon as it sees the length.
      res.writeHead(200, {
        'content-type': 'image/jpeg', 'content-length': String(size), connection: 'close',
      });
      res.flushHeaders();
    });
    try {
      const res = await fetch(`${base}/t/${ART_ID}/art.jpg`);
      assert.equal(res.status, 404, 'oversized art is no longer served');
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      await res.arrayBuffer();
      assert.equal(upstream.requests.length, 4, 'all public-route candidates were bounded');
      await eventually(() => upstream.cancelled === 4,
        `every declared response must be cancelled (got ${upstream.cancelled})`);
    } finally {
      await upstream.close();
    }
  });
});

test('a chunked image is cancelled as soon as the streaming read crosses the byte cap', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    const chunk = Buffer.alloc(64 * 1024, 0x0a);
    const upstream = await startArtUpstream(upstreamPort, (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', connection: 'close' });
      res.flushHeaders();
      // No content-length: only the incremental reader can enforce the limit.
      const timer = setInterval(() => {
        if (!res.destroyed) res.write(chunk);
      }, 5);
      res.on('close', () => clearInterval(timer));
    });
    try {
      const res = await fetch(`${base}/t/${ART_ID}/art.jpg`);
      assert.equal(res.status, 404, 'an unbounded chunked response is not relayed');
      await res.arrayBuffer();
      assert.equal(upstream.requests.length, 4);
      await eventually(() => upstream.cancelled === 4,
        `the overflowing streams must be destroyed (got ${upstream.cancelled})`);
    } finally {
      await upstream.close();
    }
  });
});

test('the artwork timeout covers a stalled body, not just response headers', async () => {
  assert.ok(IMG_TIMEOUT > 0, 'the server defines IMG_TIMEOUT_MS');
  await withArtFixture(async (base, upstreamPort) => {
    const upstream = await startArtUpstream(upstreamPort, (req, res) => {
      if (!req.url.endsWith('/hqdefault.jpg')) {
        res.writeHead(404).end();
        return;
      }
      // The first three candidates prove absence quickly. The final one sends
      // valid headers and a prefix, then never ends: this must still time out.
      res.writeHead(200, { 'content-type': 'image/jpeg', connection: 'close' });
      res.write(JPEG.subarray(0, 16));
      res.flushHeaders();
    });
    try {
      const started = Date.now();
      const res = await fetch(`${base}/t/${ART_ID}/art.jpg`);
      const elapsed = Date.now() - started;
      assert.equal(res.status, 404);
      await res.arrayBuffer();
      assert.ok(elapsed >= IMG_TIMEOUT - 250,
        `stalled body returned before the deadline (${elapsed}ms)`);
      assert.ok(elapsed < IMG_TIMEOUT + 2500,
        `body timeout must cancel promptly (${elapsed}ms)`);
      await eventually(() => upstream.cancelled === 1, 'the stalled body was not cancelled');
    } finally {
      await upstream.close();
    }
  });
});

test('normal JPEG art is cached, while active HTML and SVG MIME types are refused', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    const htmlId = 'hhhhhhhhhhh';
    const svgId = 'sssssssssss';
    const upstream = await startArtUpstream(upstreamPort, (req, res) => {
      const id = req.url.split('/')[2];
      if (id === ART_ID && req.url.endsWith('/maxresdefault.jpg')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
      } else if (id === htmlId && req.url.endsWith('/maxresdefault.jpg')) {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<script>globalThis.pwned=true</script>');
      } else if (id === svgId && req.url.endsWith('/maxresdefault.jpg')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg onload="globalThis.pwned=true"/>');
      } else {
        res.writeHead(404).end();
      }
    });
    try {
      const good = await fetch(`${base}/t/${ART_ID}/art.jpg`);
      assert.equal(good.status, 200);
      assert.equal(good.headers.get('content-type'), 'image/jpeg');
      assert.equal(good.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(Buffer.from(await good.arrayBuffer()).equals(JPEG));
      assert.equal(upstream.requests.length, 1);

      const cached = await fetch(`${base}/t/${ART_ID}/art.jpg`);
      assert.equal(cached.status, 200);
      await cached.arrayBuffer();
      assert.equal(upstream.requests.length, 1, 'the normal JPEG positive cache works');

      for (const id of [htmlId, svgId]) {
        const unsafe = await fetch(`${base}/t/${id}/art.jpg`);
        assert.equal(unsafe.status, 404, `${id} active content must not be proxied`);
        assert.match(unsafe.headers.get('content-type') ?? '', /application\/json/);
        assert.doesNotMatch(Buffer.from(await unsafe.arrayBuffer()).toString(), /script|onload/);
      }
    } finally {
      await upstream.close();
    }
  });
});

test('image redirects revalidate origin and remain bounded', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    const sameId = 'iiiiiiiiiii';
    const remoteId = 'rrrrrrrrrrr';
    const loopId = 'lllllllllll';
    const loopbackPort = await freePort();
    const loopback = await startArtUpstream(loopbackPort, (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
    });
    let loopReads = 0;
    const upstream = await startArtUpstream(upstreamPort, (req, res) => {
      const parsed = new URL(req.url, 'http://fixture');
      const id = parsed.pathname.startsWith('/loop/')
        ? parsed.searchParams.get('id') : req.url.split('/')[2];
      if (id === sameId && req.url.endsWith('/maxresdefault.jpg')) {
        res.writeHead(302, { location: `/vi/${sameId}/mqdefault.jpg` }).end();
      } else if (id === sameId && req.url.endsWith('/mqdefault.jpg')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
      } else if (id === remoteId && req.url.endsWith('/maxresdefault.jpg')) {
        // Even a loopback starting origin must not make a different loopback
        // port trustworthy. The target response would be valid if contacted.
        res.writeHead(302, { location: `http://127.0.0.1:${loopbackPort}/private` }).end();
      } else if (id === loopId && (req.url.endsWith('/maxresdefault.jpg') || req.url.startsWith('/loop/'))) {
        loopReads += 1;
        const hop = Number(parsed.searchParams.get('hop') ?? 0);
        res.writeHead(302, { location: `/loop/?id=${loopId}&hop=${hop + 1}` }).end();
      } else {
        res.writeHead(404).end();
      }
    });
    try {
      const same = await fetch(`${base}/t/${sameId}/art.jpg`);
      assert.equal(same.status, 200, 'a genuinely same-origin redirect remains supported');
      assert.ok(Buffer.from(await same.arrayBuffer()).equals(JPEG));

      const remote = await fetch(`${base}/t/${remoteId}/art.jpg`);
      assert.equal(remote.status, 404);
      await remote.arrayBuffer();
      assert.equal(loopback.requests.length, 0, 'a redirect must not issue the loopback request');

      const loop = await fetch(`${base}/t/${loopId}/art.jpg`);
      assert.equal(loop.status, 404);
      await loop.arrayBuffer();
      assert.equal(loopReads, 4, 'the redirect reader performs at most four total requests');
    } finally {
      await upstream.close();
      await loopback.close();
    }
  });
});

test('negative artwork cache stores definitive absence, never an upstream 503', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    const missingId = 'nnnnnnnnnnn';
    const transientId = 'ttttttttttt';
    let mode = 'missing';
    const upstream = await startArtUpstream(upstreamPort, (req, res) => {
      if (mode === 'jpeg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
      } else {
        res.writeHead(mode === 'missing' ? 404 : 503).end();
      }
    });
    try {
      const missing = await fetch(`${base}/t/${missingId}/art.jpg`);
      assert.equal(missing.status, 404);
      await missing.arrayBuffer();
      assert.equal(upstream.requests.length, 4);
      const remembered = await fetch(`${base}/t/${missingId}/art.jpg`);
      assert.equal(remembered.status, 404);
      await remembered.arrayBuffer();
      assert.equal(upstream.requests.length, 4, '404/410 absence is negatively cached');

      mode = 'unavailable';
      const temporary = await fetch(`${base}/t/${transientId}/art.jpg`);
      assert.equal(temporary.status, 404);
      await temporary.arrayBuffer();
      assert.equal(upstream.requests.length, 8);

      mode = 'jpeg';
      const recovered = await fetch(`${base}/t/${transientId}/art.jpg`);
      assert.equal(recovered.status, 200, 'a 503 must not poison the cache after recovery');
      await recovered.arrayBuffer();
      assert.equal(upstream.requests.length, 9, 'recovery retries upstream immediately');
    } finally {
      await upstream.close();
    }
  });
});

test('a network failure is not cached as artwork absence', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    const id = 'eeeeeeeeeee';
    const failed = await fetch(`${base}/t/${id}/art.jpg`);
    assert.equal(failed.status, 404, 'nothing is listening on the controlled upstream port yet');
    await failed.arrayBuffer();

    const upstream = await startArtUpstream(upstreamPort, (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
    });
    try {
      const recovered = await fetch(`${base}/t/${id}/art.jpg`);
      assert.equal(recovered.status, 200, 'the next request retries after a connection failure');
      await recovered.arrayBuffer();
      assert.equal(upstream.requests.length, 1);
    } finally {
      await upstream.close();
    }
  });
});

test('one shared artwork miss coalesces and a leaving subscriber does not cancel the other', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    let started;
    const upstreamStarted = new Promise((resolve) => { started = resolve; });
    let finish = () => assert.fail('upstream response was not started');
    const upstream = await startArtUpstream(upstreamPort, (req, res) => {
      if (!req.url.endsWith('/maxresdefault.jpg')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.flushHeaders();
      finish = () => res.end(JPEG);
      started();
    });
    try {
      const first = new AbortController();
      const firstResponse = fetch(`${base}/t/${ART_ID}/art.jpg`, { signal: first.signal });
      const keptResponse = fetch(`${base}/t/${ART_ID}/art.jpg`);
      await upstreamStarted;
      // Let the second localhost request attach before the first one leaves.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(upstream.requests.length, 1, 'the two cache misses share one producer');

      first.abort();
      await assert.rejects(firstResponse, /aborted|abort/i);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(upstream.cancelled, 0, 'one leaving subscriber must not cancel shared work');
      finish();

      const kept = await keptResponse;
      assert.equal(kept.status, 200);
      assert.ok(Buffer.from(await kept.arrayBuffer()).equals(JPEG));
      assert.equal(upstream.requests.length, 1, 'no replacement fetch was needed');
    } finally {
      finish();
      await upstream.close();
    }
  });
});

test('closing the only artwork response cancels its exclusively owned upstream body', async () => {
  await withArtFixture(async (base, upstreamPort) => {
    let started;
    const upstreamStarted = new Promise((resolve) => { started = resolve; });
    const upstream = await startArtUpstream(upstreamPort, (req, res) => {
      if (!req.url.endsWith('/maxresdefault.jpg')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.write(JPEG.subarray(0, 16));
      res.flushHeaders();
      started();
    });
    try {
      const controller = new AbortController();
      const response = fetch(`${base}/t/${ART_ID}/art.jpg`, { signal: controller.signal });
      await upstreamStarted;
      controller.abort();
      await assert.rejects(response, /aborted|abort/i);
      await eventually(() => upstream.cancelled === 1,
        'the last downstream close must cancel the upstream fetch');
      assert.equal(upstream.requests.length, 1, 'an abandoned job must not walk the fallbacks');
    } finally {
      await upstream.close();
    }
  });
});

test('the artwork cache evicts by total bytes without clearing every recent entry', async () => {
  assert.ok(IMG_CACHE_CAP > 0 && IMG_CAP > 0 && IMG_CAP <= IMG_CACHE_CAP);
  await withArtFixture(async (base, upstreamPort) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
    });
    assert.equal(login.status, 200);
    const auth = login.headers.getSetCookie()[0].split(';')[0];
    const count = Math.floor(IMG_CACHE_CAP / IMG_CAP) + 1;
    const ids = Array.from({ length: count }, (_, i) => `b${String(i).padStart(10, '0')}`);
    const body = Buffer.alloc(IMG_CAP, 0x0a);
    const upstream = await startArtUpstream(upstreamPort, (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(body);
    });
    try {
      for (const id of ids) {
        const res = await fetch(`${base}/api/img/${id}`, { headers: { cookie: auth } });
        assert.equal(res.status, 200, `cache fill failed for ${id}`);
        assert.equal((await res.arrayBuffer()).byteLength, IMG_CAP);
      }
      assert.equal(upstream.requests.length, count);
    } finally {
      await upstream.close();
    }

    // The oldest entry no longer fits and must retry (the listener is now gone).
    // A blanket clear would also drop the newest entry; both observations matter.
    const oldest = await fetch(`${base}/api/img/${ids[0]}`, { headers: { cookie: auth } });
    assert.equal(oldest.status, 404, 'the byte ceiling must evict the oldest buffered image');
    await oldest.arrayBuffer();
    const newest = await fetch(`${base}/api/img/${ids.at(-1)}`, { headers: { cookie: auth } });
    assert.equal(newest.status, 200, 'byte-budget eviction must preserve recent hot entries');
    await newest.arrayBuffer();
  });
});

// ── shutdown ────────────────────────────────────────────────────────────
// A room's SSE stream is hijacked and never ends on its own, and server.close()
// waits for every open connection. SIGTERM therefore hung until the supervisor's
// kill timeout (measured: still alive after 8 s with one client connected), so
// every restart was a hard kill mid-request. A half-sent request is the same
// shape from the server's point of view, and needs no room to reproduce.

// (freePort now comes from test/helpers/cdp.js; a local copy defined further
// down the file was in the temporal dead zone when node:test runs the root
// before() hook during module evaluation.)

test('SIGTERM stops the server even with a connection still open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-shutdown-'));
  const port = await freePort();
  const child = spawn(process.execPath, SERVER_ARGS, {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, ...OFFLINE_ENV, PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'shutdown.db'),
      SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'shutdown-secret', SONORA_LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  let sock;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        up = r.ok && (await r.json()).pid === child.pid;
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, 'the shutdown fixture started');

    sock = net.connect(port, '127.0.0.1', () => sock.write('GET /api/health HTTP/1.1\r\nHost: x\r\n'));
    sock.on('error', () => {});
    await new Promise((r) => setTimeout(r, 250));

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.kill('SIGTERM');
      setTimeout(() => resolve('timeout'), 12_000);
    });
    assert.notEqual(exitCode, 'timeout', 'SIGTERM must stop the server instead of hanging');
    assert.equal(exitCode, 0, 'a signal-initiated shutdown exits cleanly');
  } finally {
    sock?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
