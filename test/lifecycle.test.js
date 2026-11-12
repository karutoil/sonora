import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// Real-process lifecycle tests. The child is this same file in fixture mode:
// that lets it install youtube.js's supported session override and (for gate
// expiry only) an observable clock, without adding production-only test routes
// or waiting thirty real minutes. All HTTP requests still go to src/server.js.
const FIXTURE = process.env.SONORA_LIFECYCLE_FIXTURE === '1';
const PASS = 'hunter2hunter2';
const ARTIST = `UC${'a'.repeat(22)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function waitFor(check, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`Timed out: ${message}; last value: ${JSON.stringify(value)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Fixture-only executable: a deterministic gate answer or a held download. */
function writeFakeYtdlp(dir) {
  const file = path.join(dir, 'yt-dlp.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const event = (kind) => fs.appendFileSync(process.env.SONORA_LIFECYCLE_YTDLP_LOG,
  JSON.stringify({ kind, pid: process.pid, at: Date.now() }) + '\\n');
if (process.env.SONORA_LIFECYCLE_YTDLP_MODE === 'gate') {
  console.error("ERROR: [youtube] Sign in to confirm you're not a bot.");
  process.exit(1);
}
event('start');
if (process.env.SONORA_LIFECYCLE_YTDLP_MODE === 'hang') {
  // The normal audio.js AbortSignal/process-group mechanism must reap this.
  // No audio is written: a completed file would turn cancellation into success.
  setInterval(() => {}, 1000);
} else {
  console.error('unexpected fixture invocation');
  process.exit(1);
}
`, { mode: 0o755 });
  return file;
}

/**
 * A supported fake Innertube session. Artist calls can be held by a marker file;
 * the state file records active/maxActive/calls so overlap is observed at the
 * actual upstream boundary, rather than inferred from two HTTP response shapes.
 */
function fakeSession(control) {
  const stateFile = path.join(control, 'artist-state.json');
  const holdFile = path.join(control, 'hold-artist');
  const writeState = (state) => {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  };
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  return {
    getBasicInfo: async () => ({
      basic_info: { is_live: false },
      playability_status: { status: 'OK' },
    }),
    music: {
      getExplore: async () => ({ sections: [] }),
      getArtist: async () => {
        active += 1;
        calls += 1;
        maxActive = Math.max(maxActive, active);
        writeState({ active, maxActive, calls });
        try {
          while (fs.existsSync(holdFile)) await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            id: ARTIST,
            name: 'Lifecycle Artist',
            header: { title: { text: 'Lifecycle Artist' }, thumbnails: [] },
            sections: [],
          };
        } finally {
          active -= 1;
          writeState({ active, maxActive, calls });
        }
      },
    },
  };
}

async function runFixture() {
  const control = process.env.SONORA_LIFECYCLE_CONTROL;
  const clockFile = path.join(control, 'clock-offset');
  fs.writeFileSync(clockFile, '0');

  // Deliberately local to the fixture child. fs.watch makes an external test
  // able to cross the bot-gate TTL without any Date clock option in production.
  if (process.env.SONORA_LIFECYCLE_FAKE_CLOCK === '1') {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const update = () => {
      const next = Number(fs.readFileSync(clockFile, 'utf8'));
      if (Number.isFinite(next)) offset = next;
    };
    const watcher = fs.watch(clockFile, { persistent: false }, update);
    watcher.on('error', () => {});
    Date.now = () => realNow() + offset;
  }

  const youtube = await import('../src/youtube.js');
  youtube.setSessionOverride(fakeSession(control));

  if (process.env.SONORA_LIFECYCLE_SEED_FOLLOWS === '1') {
    // Seed through the real DB API before server import. Following through HTTP
    // would itself start reconciliation, which belongs to a different test.
    const database = await import('../src/db.js');
    database.bootstrapUser();
    const admin = database.findUser('toil');
    database.createUser('lifecycle-listener', PASS);
    const listener = database.findUser('lifecycle-listener');
    for (const user of [admin, listener]) {
      database.followArtist(user.id, { artistId: ARTIST, name: 'Lifecycle Artist' });
    }
  }

  await import('../src/server.js');
}

async function request(server, route, {
  method = 'GET', cookie = '', body, rawBody, headers = {},
} = {}) {
  const res = await fetch(server.base + route, {
    method,
    headers: {
      ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return {
    status: res.status,
    headers: res.headers,
    body: type.includes('json') ? await res.json() : await res.text(),
  };
}

async function login(server, name = 'toil') {
  const res = await request(server, '/api/auth/login', {
    method: 'POST', body: { name, passphrase: PASS },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const cookie = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  assert.ok(cookie, 'login returned a session cookie');
  return cookie.split(';')[0];
}

async function launchFixture(t, {
  seedFollows = false, holdArtist = false, fakeClock = false, ytdlpMode = 'idle',
  logLevel = 'info',
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lifecycle-'));
  const port = await freePort();
  const ytdlp = writeFakeYtdlp(dir);
  const holdFile = path.join(dir, 'hold-artist');
  if (holdArtist) fs.writeFileSync(holdFile, 'hold');
  const logs = [];
  const child = spawn(process.execPath, ['--no-warnings', 'test/lifecycle.test.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      SONORA_LIFECYCLE_FIXTURE: '1',
      SONORA_LIFECYCLE_CONTROL: dir,
      SONORA_LIFECYCLE_SEED_FOLLOWS: seedFollows ? '1' : '',
      SONORA_LIFECYCLE_FAKE_CLOCK: fakeClock ? '1' : '',
      SONORA_LIFECYCLE_YTDLP_MODE: ytdlpMode,
      SONORA_LIFECYCLE_YTDLP_LOG: path.join(dir, 'ytdlp.jsonl'),
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'lifecycle.db'),
      SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'lifecycle-test-secret', SONORA_PASSPHRASE: PASS,
      SONORA_YTDLP: ytdlp, SONORA_LOG_LEVEL: logLevel,
      SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  const server = {
    child, dir, logs, base: `http://127.0.0.1:${port}`,
    holdFile,
    clockFile: path.join(dir, 'clock-offset'),
    artistState: path.join(dir, 'artist-state.json'),
    ytdlpLog: path.join(dir, 'ytdlp.jsonl'),
    dbFile: path.join(dir, 'lifecycle.db'),
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      const started = Date.now();
      const exited = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, signal: sig })));
      child.kill(signal);
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 10_000); });
      const result = await Promise.race([exited, timeout]);
      clearTimeout(timer);
      if (!result) {
        child.kill('SIGKILL');
        throw new Error(`server did not stop on ${signal}:\n${logs.join('')}`);
      }
      return { ...result, ms: Date.now() - started };
    },
  };

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });

  try {
    await waitFor(async () => {
      try {
        const health = await request(server, '/api/health');
        return health.status === 200 && health.body.pid === child.pid && health.body.ok ? health.body : null;
      } catch { return null; }
    }, `fixture ${child.pid} became healthy`, 15_000);
  } catch (err) {
    throw new Error(`${err.message}\n${logs.join('')}`);
  }
  return server;
}

if (FIXTURE) {
  await runFixture();
} else {
  test('routine 400/413/429 rejections log info metadata without an error stack', async (t) => {
    const server = await launchFixture(t);
    const malformed = await request(server, '/api/auth/login', {
      method: 'POST', rawBody: '{',
    });
    assert.equal(malformed.status, 400);

    const oversized = await request(server, '/api/auth/login', {
      method: 'POST', rawBody: JSON.stringify({ name: 'x'.repeat(70_000), passphrase: PASS }),
    });
    assert.equal(oversized.status, 413);

    const statuses = [];
    for (let i = 0; i < 21; i += 1) {
      const response = await request(server, '/api/auth/passkey/login/options', { method: 'POST', body: {} });
      statuses.push(response.status);
    }
    assert.equal(statuses.at(-1), 429, `passkey limiter sequence: ${statuses.join(',')}`);

    await waitFor(() => {
      const entries = server.logs.join('').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const rejected = entries.filter((entry) => entry.msg === 'request rejected');
      return [400, 413, 429].every((status) => rejected.some((entry) => entry.status === status))
        ? rejected : null;
    }, 'all three rejection classes reached the custom error logger');

    const rejected = server.logs.join('').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((entry) => entry.msg === 'request rejected');
    for (const entry of rejected.filter((entry) => [400, 413, 429].includes(entry.status))) {
      assert.equal(entry.level, 30, JSON.stringify(entry));
      assert.equal(entry.err, undefined, JSON.stringify(entry));
      assert.equal(entry.stack, undefined, JSON.stringify(entry));
      assert.doesNotMatch(JSON.stringify(entry), /\n\s+at |"stack"/);
    }
    const stopped = await server.stop();
    assert.equal(stopped.code, 0, server.logs.join(''));
  });

  test('bot-gate status expires through one rule in listener, admin and diagnostic answers', async (t) => {
    const server = await launchFixture(t, { ytdlpMode: 'gate', fakeClock: true, logLevel: 'warn' });
    const cookie = await login(server);
    const jar = [
      '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1893456000\tSID\texpired-sid',
      '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1893456000\tHSID\texpired-hsid',
    ].join('\n');
    const imported = await request(server, '/api/youtube/cookies', {
      method: 'POST', cookie, body: { cookies: jar },
    });
    assert.equal(imported.status, 400, JSON.stringify(imported.body));
    assert.equal(imported.body.verdict.status, 'rejected');

    const routes = [
      '/api/status', '/api/youtube/status', '/api/admin/overview',
      '/api/admin/system', '/api/youtube/diagnose',
    ];
    for (const route of routes) {
      const response = await request(server, route, { cookie });
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.botGated, true, `${route} should expose the fresh gate`);
    }
    const fresh = await request(server, '/api/status', { cookie });
    assert.ok(Number.isFinite(Date.parse(fresh.body.botGateAt)));

    fs.writeFileSync(server.clockFile, String(30 * 60_000));
    await waitFor(async () => {
      const status = await request(server, '/api/status', { cookie });
      return status.body.botGated === false ? status.body : null;
    }, 'the shared gate TTL elapsed on the fixture clock');
    const expired = await request(server, '/api/status', { cookie });
    assert.equal(expired.body.botGateAt, null, 'expired timestamps do not linger beside botGated=false');
    for (const route of routes.slice(1)) {
      const response = await request(server, route, { cookie });
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.botGated, false, `${route} must use the same expiry`);
    }
    const stopped = await server.stop();
    assert.equal(stopped.code, 0, server.logs.join(''));
  });

  test('the first manual check waits for follow-time baseline work instead of becoming a busy no-op', async (t) => {
    const server = await launchFixture(t, { holdArtist: true, logLevel: 'warn' });
    const admin = await login(server);

    const followed = await request(server, `/api/artists/${ARTIST}/follow`, {
      method: 'POST', cookie: admin, body: { name: 'Lifecycle Artist' },
    });
    assert.equal(followed.status, 200, JSON.stringify(followed.body));
    await waitFor(() => {
      const state = readJson(server.artistState);
      return state?.calls === 1 && state.active === 1 ? state : null;
    }, 'the nonblocking follow response left its baseline artist fetch active');

    let settled = false;
    const manual = request(server, '/api/notifications/check', {
      method: 'POST', cookie: admin,
    }).then((response) => { settled = true; return response; });
    try {
      await sleep(120);
      assert.equal(settled, false, 'a follow baseline was incorrectly reported as a throttled manual check');

      const repeated = await request(server, '/api/notifications/check', {
        method: 'POST', cookie: admin,
      });
      assert.deepEqual(repeated.body, { created: 0, unread: 0, throttled: true },
        'a second manual tap must not queue behind the one already waiting');
      assert.equal(readJson(server.artistState)?.calls, 1);
    } finally {
      fs.rmSync(server.holdFile, { force: true });
    }

    const first = await manual;
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { created: 0, unread: 0 });
    const state = readJson(server.artistState);
    assert.equal(state.calls, 2, 'the baseline and the manual poll each performed their own check');
    assert.equal(state.maxActive, 1, 'the prerequisite and manual check never overlapped');

    const second = await request(server, '/api/notifications/check', {
      method: 'POST', cookie: admin,
    });
    assert.deepEqual(second.body, { created: 0, unread: 0, throttled: true });
    const stopped = await server.stop();
    assert.equal(stopped.code, 0, server.logs.join(''));
  });

  test('manual follow polls exclude each other across users without spending a busy cooldown', async (t) => {
    const server = await launchFixture(t, { seedFollows: true, holdArtist: true, logLevel: 'warn' });
    const admin = await login(server);
    const listener = await login(server, 'lifecycle-listener');

    const first = request(server, '/api/notifications/check', { method: 'POST', cookie: admin });
    await waitFor(() => {
      const state = readJson(server.artistState);
      return state?.calls === 1 && state.active === 1 ? state : null;
    }, 'the first manual poll reached the held artist page');

    const busy = await request(server, '/api/notifications/check', {
      method: 'POST', cookie: listener,
    });
    assert.equal(busy.status, 200);
    assert.deepEqual(busy.body, { created: 0, unread: 0, throttled: true, busy: true });
    assert.equal(readJson(server.artistState)?.calls, 1, 'the second account did not start another page fetch');

    fs.rmSync(server.holdFile, { force: true });
    const completed = await first;
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    await waitFor(() => readJson(server.artistState)?.active === 0);

    const retry = await request(server, '/api/notifications/check', {
      method: 'POST', cookie: listener,
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.throttled, undefined, 'a skipped busy request was not charged a minute cooldown');
    const final = readJson(server.artistState);
    assert.equal(final.calls, 2);
    assert.equal(final.maxActive, 1, 'upstream artist calls never overlapped');

    const stopped = await server.stop();
    assert.equal(stopped.code, 0, server.logs.join(''));
  });

  test('an uncancellable follow poll cannot make SIGTERM unbounded or corrupt SQLite', async (t) => {
    const server = await launchFixture(t, { seedFollows: true, holdArtist: true, logLevel: 'warn' });
    const admin = await login(server);
    const pending = request(server, '/api/notifications/check', { method: 'POST', cookie: admin });
    pending.catch(() => {});
    await waitFor(() => readJson(server.artistState)?.active === 1,
      'the uncancellable artist request was in flight');

    const stopping = server.stop();
    // The listener remains available during the job-drain grace window. HTTP 200
    // is intentionally unchanged, but its own verdict must immediately stop
    // claiming this closing process is ready.
    await waitFor(async () => {
      try {
        const health = await request(server, '/api/health');
        return health.body.ready === false ? health : null;
      } catch { return null; }
    }, 'health changed its readiness verdict during shutdown');
    const health = await request(server, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, false);
    assert.equal(health.body.ready, false);
    assert.equal(health.body.reason, 'shutting-down');
    assert.equal(health.body.checks.server, false);

    const stopped = await stopping;
    assert.equal(stopped.code, 0, server.logs.join(''));
    assert.ok(stopped.ms >= 2000, `the bounded grace period was observable (${stopped.ms}ms)`);
    assert.ok(stopped.ms < 10_000);
    assert.match(server.logs.join(''), /background job drain timed out: manual follow poll/);
    assert.doesNotMatch(server.logs.join(''), /database is not open|SQLITE_MISUSE|uncaughtException/i);
    await Promise.allSettled([pending]);

    const db = new DatabaseSync(server.dbFile, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
    finally { db.close(); }
  });

  test('SIGTERM cancels and drains a detached warm through the audio subscription API', async (t) => {
    const server = await launchFixture(t, { ytdlpMode: 'hang', logLevel: 'debug' });
    const cookie = await login(server);
    const warm = await request(server, '/api/warm/aaaaaaaaaaa', { method: 'POST', cookie });
    assert.equal(warm.status, 202, JSON.stringify(warm.body));
    let started;
    try {
      started = await waitFor(() => {
        try {
          const lines = fs.readFileSync(server.ytdlpLog, 'utf8').trim().split('\n').filter(Boolean);
          const event = lines.map((line) => JSON.parse(line)).find((item) => item.kind === 'start');
          return event ?? null;
        } catch { return null; }
      }, 'the detached warm spawned its fake downloader');
    } catch (err) {
      throw new Error(`${err.message}\n${server.logs.join('')}`);
    }

    const stopped = await server.stop();
    assert.equal(stopped.code, 0, server.logs.join(''));
    assert.ok(stopped.ms < 5000, `cancellation drained promptly (${stopped.ms}ms)`);
    assert.doesNotMatch(server.logs.join(''), /background job drain timed out/);
    await waitFor(() => {
      try { process.kill(started.pid, 0); return null; }
      catch (err) { return err.code === 'ESRCH' ? true : null; }
    }, `downloader ${started.pid} was reaped by its owning audio module`);
  });
}
