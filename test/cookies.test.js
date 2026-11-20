import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/cdp.js';

// Cookie-import flow, tested end to end through the HTTP API.
//
// A stub yt-dlp stands in for the real one so verification is deterministic:
// it fails with the bot-gate message unless the jar contains a "good" cookie.
// That lets us assert the important property — a jar is only reported as
// connected if it actually works — without touching YouTube.

let PORT = 0;
let BASE = '';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cookies-'));
const DB = path.join(ROOT, 'test.db');
const STUB = path.join(ROOT, 'yt-dlp-stub.mjs');

// src/cookies.js opens the database when it is imported, so point it at the
// scratch directory before the unit tests at the bottom of this file do that.
// The server child below passes its own SONORA_DB explicitly, which overrides.
process.env.SONORA_DB = path.join(ROOT, 'unit.db');

// Behaviour is selected by a marker inside the cookie file.
fs.writeFileSync(STUB, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const i = args.indexOf('--cookies');
if (i === -1) { console.error('ERROR: [youtube] Sign in to confirm you\\'re not a bot.'); process.exit(1); }
const jar = fs.readFileSync(args[i + 1], 'utf8');
if (jar.includes('GOODJAR')) { console.log('stub: resolved'); process.exit(0); }
console.error('ERROR: [youtube] Sign in to confirm you\\'re not a bot.');
process.exit(1);
`, { mode: 0o755 });

const COOKIE = (name, value, extra = {}) =>
  `#HttpOnly_.google.com\tTRUE\t/\tTRUE\t${extra.expiry ?? 1893456000}\t${name}\t${value}`;

const GOOD_JAR = [
  COOKIE('SID', 'GOODJAR-sid'),
  COOKIE('HSID', 'goodjar-hsid'),
  COOKIE('SSID', 'goodjar-ssid'),
  COOKIE('LOGIN_INFO', 'goodjar-login'),
  COOKIE('PREF', 'tz=UTC'),
].join('\n');

const NO_IDENTITY_JAR = [
  COOKIE('PREF', 'tz=UTC'),
  COOKIE('CONSENT', 'YES+'),
].join('\n');

const BAD_JAR = [
  COOKIE('SID', 'expired-sid'),
  COOKIE('HSID', 'expired-hsid'),
].join('\n');

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

const post = (cookies) => jfetch('/api/youtube/cookies', {
  method: 'POST', body: JSON.stringify({ cookies }),
});

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: path.join(ROOT, 'audio'),
      SONORA_SECRET: 'cookie-test-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_YTDLP: STUB, SONORA_LOG_LEVEL: 'warn',
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
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
  });
  cookie = res.headers.getSetCookie()[0].split(';')[0];
});

after(() => {
  proc?.kill('SIGTERM');
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

test('the cookie endpoints require a session', async () => {
  assert.equal((await fetch(`${BASE}/api/youtube/status`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/youtube/cookies`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${BASE}/api/youtube/cookies`, { method: 'DELETE' })).status, 401);
});

test('nothing is connected initially', async () => {
  const { body } = await jfetch('/api/youtube/status');
  assert.equal(body.jar.connected, false);
  assert.equal(body.jar.source, null);
});

test('empty input is rejected', async () => {
  const { res, body } = await post('   ');
  assert.equal(res.status, 400);
  assert.match(body.error, /paste/i);
});

test('a non-cookie file is rejected with a usable message', async () => {
  const { res, body } = await post('this is not a cookie file at all');
  assert.equal(res.status, 400);
  assert.match(body.error, /could not read|no cookies/i);
});

test('a JSON export is accepted (not just Netscape)', async () => {
  const json = JSON.stringify([
    { domain: '.google.com', name: 'SID', value: 'GOODJAR-j1', expirationDate: 1893456000 },
    { domain: '.google.com', name: 'HSID', value: 'GOODJAR-j2', expirationDate: 1893456000 },
    { domain: '.google.com', name: 'SSID', value: 'GOODJAR-j3', expirationDate: 1893456000 },
  ]);
  const { res, body } = await post(json);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.jar.connected, true);
  assert.equal(body.jar.cookieCount, 3);
  // The materialised jar is what yt-dlp reads: it must be Netscape cookies.txt,
  // not the JSON export verbatim (a jar that imports and then cannot be read).
  const { parseNetscape } = await import('../src/cookies.js');
  const written = parseNetscape(fs.readFileSync(path.join(ROOT, 'youtube-cookies.txt'), 'utf8'));
  assert.deepEqual(written.map((c) => c.name).sort(), ['HSID', 'SID', 'SSID']);
  await jfetch('/api/youtube/cookies', { method: 'DELETE' });
});

// The real-world failure: exporting while on youtube.com yields only visitor
// cookies, because the sign-in cookies live on the google.com domain.
test('a youtube.com-only export is rejected and the message names google.com', async () => {
  const visitorOnly = [
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tPREF\ttz=UTC',
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tVISITOR_INFO1_LIVE\tabc',
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tYSC\tabc',
  ].join('\n');
  const { res, body } = await post(visitorOnly);
  assert.equal(res.status, 400);
  assert.match(body.error, /SID/);
  assert.match(body.error, /google\.com/, 'must point at the right domain');
  assert.match(body.error, /PREF/, 'should name what it actually found');
  assert.equal(body.jar.hasIdentity, false);
});

test('a jar with no sign-in cookie is rejected before any download', async () => {
  const { res, body } = await post(NO_IDENTITY_JAR);
  assert.equal(res.status, 400);
  assert.match(body.error, /SID/);
  // and it must not have been stored
  const { body: st } = await jfetch('/api/youtube/status');
  assert.equal(st.jar.connected, false);
});

test('a jar that YouTube rejects is stored but reported as rejected', async () => {
  const { res, body } = await post(BAD_JAR);
  assert.equal(res.status, 400);
  assert.match(body.error, /still asked for a sign-in|not a signed-in session/i);
  assert.equal(body.verdict.status, 'rejected');
  // It is kept so the user can replace it, but the state must not claim success.
  const { body: st } = await jfetch('/api/youtube/status');
  assert.equal(st.jar.verdict, 'rejected');
});

test('a working jar is reported honestly, not as "verified" when nothing was blocked', async () => {
  const { res, body } = await post(GOOD_JAR);
  assert.equal(res.status, 200);
  assert.equal(body.jar.connected, true);
  assert.equal(body.jar.source, 'imported');
  assert.equal(body.jar.cookieCount, 5);
  assert.ok(body.jar.importedAt);
  assert.ok(body.jar.expiresAt);
  // The stub always fails without cookies and succeeds with them, so the
  // baseline probe fails and the jar genuinely unblocks it.
  assert.equal(body.verdict.status, 'verified', 'stub baseline is gated, so this is provable');
  assert.match(body.verdict.reason, /unblocked/i);

  const { body: st } = await jfetch('/api/youtube/status');
  assert.equal(st.jar.connected, true);
  assert.equal(st.jar.verdict, 'verified');
  assert.equal(st.jar.expired, false);
});

test('the jar is written 0600 and never returned to the client', async () => {
  const file = path.join(ROOT, 'youtube-cookies.txt');
  assert.ok(fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

  const { body } = await jfetch('/api/youtube/status');
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes('GOODJAR'), 'cookie values must never reach a client');
  assert.ok(!serialised.includes('expired-sid'));
});

test('the jar is encrypted at rest in the database', async () => {
  const raw = fs.readFileSync(DB);
  assert.ok(!raw.includes(Buffer.from('GOODJAR-sid')), 'plaintext cookie value in the db file');
  // the encrypted blob should still be present
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(DB);
  const row = d.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies'").get();
  d.close();
  assert.ok(row?.value, 'encrypted secret row exists');
  assert.ok(!row.value.includes('GOODJAR'), 'row is ciphertext');
});

test('the stored jar is used for playback and survives a restart', async () => {
  // Restart the server: restoreJar() must re-materialise the file from the DB.
  // Graceful shutdown can legitimately exceed an arbitrary sleep, so do not
  // race its listener against the replacement process.
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cookie server did not stop')), 15_000);
    timer.unref?.();
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  proc.kill('SIGTERM');
  await exited;
  fs.rmSync(path.join(ROOT, 'youtube-cookies.txt'), { force: true });

  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: path.join(ROOT, 'audio'),
      SONORA_SECRET: 'cookie-test-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_YTDLP: STUB, SONORA_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
  });
  cookie = res.headers.getSetCookie()[0].split(';')[0];

  assert.ok(fs.existsSync(path.join(ROOT, 'youtube-cookies.txt')), 'jar restored at boot');
  const { body } = await jfetch('/api/youtube/status');
  assert.equal(body.jar.connected, true, 'still connected after restart');
});

test('disconnect removes the jar and the stored secret', async () => {
  const { res, body } = await jfetch('/api/youtube/cookies', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(body.jar.connected, false);
  assert.equal(fs.existsSync(path.join(ROOT, 'youtube-cookies.txt')), false);

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(DB);
  const row = d.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies'").get();
  d.close();
  assert.equal(row, undefined, 'secret removed from the db');
});

test('disconnect reports unlink failure, preserves recovery state, and audits without secrets', async () => {
  const imported = await post(GOOD_JAR);
  assert.equal(imported.res.status, 200, JSON.stringify(imported.body));
  const file = path.join(ROOT, 'youtube-cookies.txt');
  // unlink(2) on a directory reliably fails even when tests run as root.
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  try {
    const failed = await jfetch('/api/youtube/cookies', { method: 'DELETE' });
    assert.equal(failed.res.status, 500);
    assert.equal(failed.body.code, 'COOKIE_CLEAR_FAILED');
    assert.match(failed.body.error, /no connection state was reset/i);
    assert.ok(fs.existsSync(file), 'the failed plaintext path still exists');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB, { readOnly: true });
    assert.ok(db.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies'").get(),
      'encrypted recovery remains when plaintext removal fails');
    db.close();

    const audit = await jfetch('/api/admin/audit?limit=200');
    assert.ok(audit.body.entries.some((e) => e.action === 'youtube.cookies.clear_failed'));
    assert.ok(!JSON.stringify(audit.body).includes('GOODJAR-sid'));
  } finally {
    fs.rmdirSync(file);
  }
  const cleared = await jfetch('/api/youtube/cookies', { method: 'DELETE' });
  assert.equal(cleared.res.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.jar.connected, false);
  const audit = await jfetch('/api/admin/audit?limit=200');
  for (const action of ['youtube.cookies.import', 'youtube.cookies.clear']) {
    assert.ok(audit.body.entries.some((e) => e.action === action), `audit includes ${action}`);
  }
  assert.ok(!JSON.stringify(audit.body).includes('GOODJAR-sid'));
});

// ── jar semantics, without a server ─────────────────────────────────────────

const cookiesUrl = new URL('../src/cookies.js', import.meta.url).href;

/** Run a snippet in a fresh process: config is read from the env at import time. */
const runIsolated = (env, code) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('close', (code2) => (code2 === 0
    ? resolve(out)
    : reject(new Error(`isolated process exited ${code2}: ${err}`))));
});

/** The value a snippet printed: db.js logs its migrations on stdout too. */
const lastLine = (out) => out.trim().split('\n').pop().trim();

/** A fully isolated real cookie server with its own yt-dlp stub, DB and jar. */
async function withCookieServer({ extraEnv = {}, stub = STUB }, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cookie-http-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  try {
    child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: String(port), HOST: '127.0.0.1',
        SONORA_DB: path.join(root, 'test.db'), SONORA_AUDIO_DIR: path.join(root, 'audio'),
        SONORA_SECRET: 'isolated-cookie-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
        SONORA_YTDLP: stub, SONORA_LOG_LEVEL: 'warn',
        ...(typeof extraEnv === 'function' ? extraEnv(root) : extraEnv),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(`${base}/api/health`);
        const health = res.ok ? await res.json() : null;
        if (health?.pid === child.pid) break;
      } catch {}
      if (i === 119) throw new Error('isolated cookie server did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let cookie = '';
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie()[0].split(';')[0];
    const api = async (route, { body, ...options } = {}) => {
      const res = await fetch(base + route, {
        ...options,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          cookie, ...options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        res,
        body: res.headers.get('content-type')?.includes('json') ? await res.json() : null,
      };
    };
    await run({ api, root, dbPath: path.join(root, 'test.db') });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Google's rotating cookies (__Secure-1PSIDTS, YSC, AEC…) expire within hours by
// design. Reporting the *earliest* expiry told people their working session had
// expired and made them re-export cookies for nothing.
test('a jar is judged by its identity cookie, not by Google\'s rotating ones', async () => {
  const { parseNetscape, inspectJar } = await import('../src/cookies.js');
  const identity = 2_000_000_000; // 2033-05-18
  const rotating = Math.floor(Date.now() / 1000) + 3600;
  const text = [
    COOKIE('SID', 'sid', { expiry: identity }),
    COOKIE('HSID', 'hsid', { expiry: rotating }),
    COOKIE('__Secure-1PSIDTS', 'rotating', { expiry: rotating }),
    COOKIE('YSC', 'short', { expiry: rotating }),
  ].join('\n');
  const info = inspectJar(parseNetscape(text));
  assert.equal(info.hasIdentity, true);
  assert.equal(
    new Date(info.expiresAt).toISOString(),
    new Date(identity * 1000).toISOString(),
    'the SID expiry, not the earliest rotating cookie',
  );
  assert.ok(Date.parse(info.expiresAt) > Date.now(), 'a healthy jar must not look expired');
});

test('expired cookies are not sent to YouTube', async () => {
  const { parseNetscape, cookieHeader } = await import('../src/cookies.js');
  const now = Math.floor(Date.now() / 1000);
  const text = [
    COOKIE('SID', 'live', { expiry: now + 3600 }),
    COOKIE('YSC', 'stale', { expiry: now - 3600 }),
  ].join('\n');
  const header = cookieHeader(parseNetscape(text));
  assert.match(header, /SID=live/);
  assert.doesNotMatch(header, /YSC=stale/, 'an expired cookie is never presented to Innertube');
});

// Downloads use the imported jar (`activeCookiesPath`). Metadata used the env
// cookie first, so importing a session changed what played but not what was
// searched — and disconnecting left search on the old identity.
test('an imported jar wins over SONORA_YT_COOKIE for metadata requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-jar-'));
  fs.writeFileSync(path.join(dir, 'youtube-cookies.txt'), GOOD_JAR, { mode: 0o600 });
  const out = await runIsolated(
    { SONORA_DB: path.join(dir, 'unit.db'), SONORA_SECRET: 'jar-test', SONORA_YT_COOKIE: 'ENVCOOKIE=env' },
    `const { activeCookieHeader } = await import(${JSON.stringify(cookiesUrl)});`
      + 'process.stdout.write(String(activeCookieHeader()));',
  );
  assert.match(out, /SID=GOODJAR-sid/, 'the imported jar is used');
  assert.doesNotMatch(out, /ENVCOOKIE/, 'the env cookie does not shadow it');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Rotating SONORA_SECRET is the documented emergency action. Wiping the stored
// jar on the next boot turned it into "everyone is signed out of YouTube, with no
// way back"; a wrong secret is recoverable, a deleted row is not.
test('a wrong SONORA_SECRET keeps the stored jar instead of deleting it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-jar-secret-'));
  const db = path.join(dir, 'unit.db');
  const saved = await runIsolated(
    { SONORA_DB: db, SONORA_SECRET: 'secret-one' },
    `const m = await import(${JSON.stringify(cookiesUrl)});`
      + `const text = ${JSON.stringify(GOOD_JAR)};`
      + "await m.saveJar(m.parseNetscape(text), text); process.stdout.write('saved');",
  );
  assert.equal(lastLine(saved), 'saved');
  assert.ok(fs.existsSync(path.join(dir, 'youtube-cookies.txt')));

  const restored = await runIsolated(
    { SONORA_DB: db, SONORA_SECRET: 'secret-two' },
    `const m = await import(${JSON.stringify(cookiesUrl)});`
      + 'process.stdout.write(String(await m.restoreJar()));',
  );
  assert.equal(lastLine(restored), 'false', 'the jar cannot be decrypted with the new secret');

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(db);
  const row = d.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies'").get();
  d.close();
  assert.ok(row?.value, 'the encrypted jar is kept, so the old secret can still recover it');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression coverage for the current selector, parser, and disconnect paths.
// Every stateful case uses a fresh temporary database and cookie directory.
test('malformed expiry and injected fields are clean HTTP 400s, never a stored jar', async () => {
  const cases = [
    [
      COOKIE('SID', 'bad-expiry', { expiry: 'Infinity' }),
      COOKIE('HSID', 'bad-expiry', { expiry: 'Infinity' }),
    ].join('\n'),
    JSON.stringify([
      { domain: '.google.com', name: 'SID', value: 'GOODJAR-sid\r\ninjected', expirationDate: 1893456000 },
      { domain: '.google.com', name: 'HSID', value: 'good-hsid', expirationDate: 1893456000 },
    ]),
  ];
  for (const input of cases) {
    try {
      const { res, body } = await post(input);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(body.error, /could not read|no cookies/i);
    } finally {
      // A failing-before run must not leak a partially accepted jar into the
      // remaining tests or leave plaintext behind in the temporary directory.
      await jfetch('/api/youtube/cookies', { method: 'DELETE' });
    }
  }
});

test('a rejected import coherently yields playback, metadata, and status to the env jar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-jar-selection-'));
  try {
    const db = path.join(dir, 'unit.db');
    const external = path.join(dir, 'environment-cookies.txt');
    fs.writeFileSync(external, GOOD_JAR, { mode: 0o600 });
    await runIsolated(
      { SONORA_DB: db, SONORA_SECRET: 'selection-test' },
      `const m = await import(${JSON.stringify(cookiesUrl)});`
        + `const text = ${JSON.stringify(BAD_JAR)};`
        + "await m.saveJar(m.parseNetscape(text), text, {status:'rejected',reason:'probe rejected'});",
    );
    const out = await runIsolated(
      {
        SONORA_DB: db,
        SONORA_SECRET: 'selection-test',
        SONORA_YTDLP_COOKIES: external,
        SONORA_YT_COOKIE: 'ENVHEADER=must-not-win',
      },
      `const m = await import(${JSON.stringify(cookiesUrl)});`
        + 'process.stdout.write(JSON.stringify({path:m.activeCookiesPath(),'
        + 'header:m.activeCookieHeader(),status:m.jarStatus()}));',
    );
    const selected = JSON.parse(lastLine(out));
    assert.equal(selected.path, external);
    assert.equal(selected.status.source, 'env');
    assert.equal(selected.status.connected, true);
    assert.equal(selected.status.cookieCount, 5, 'status describes the selected external file');
    assert.equal(selected.status.importedAt, null, 'rejected import metadata is not attributed to env');
    assert.equal(selected.status.verdict, null, 'the rejected import verdict is not attributed to env');
    assert.match(selected.header, /SID=GOODJAR-sid/, 'Innertube reads the selected external jar');
    assert.doesNotMatch(selected.header, /expired-sid/, 'the rejected import cannot shadow the env jar');
    assert.doesNotMatch(selected.header, /ENVHEADER/, 'a real env jar beats the raw fallback header');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reverify is read-only and never assigns an env fallback verdict to a rejected import', async () => {
  await withCookieServer({
    extraEnv(root) {
      const external = path.join(root, 'environment-cookies.txt');
      fs.writeFileSync(external, GOOD_JAR, { mode: 0o600 });
      return { SONORA_YTDLP_COOKIES: external };
    },
  }, async ({ api, root, dbPath }) => {
    const imported = await api('/api/youtube/cookies', { method: 'POST', body: { cookies: BAD_JAR } });
    assert.equal(imported.res.status, 400, JSON.stringify(imported.body));
    assert.equal(imported.body.verdict.status, 'rejected');

    const { DatabaseSync } = await import('node:sqlite');
    const before = new DatabaseSync(dbPath, { readOnly: true });
    const original = before.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies'").get().value;
    const originalMeta = before.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies_meta'").get().value;
    before.close();
    const originalFile = fs.readFileSync(path.join(root, 'youtube-cookies.txt'));
    assert.equal(JSON.parse(originalMeta).verdict.status, 'rejected');

    for (let i = 0; i < 2; i++) {
      const verified = await api('/api/youtube/verify', { method: 'POST' });
      assert.equal(verified.res.status, 200, JSON.stringify(verified.body));
      assert.equal(verified.body.verdict.status, 'verified');
      assert.equal(verified.body.jar.source, 'env');
      assert.equal(verified.body.jar.verdict, null, 'env status does not adopt import metadata');

      const after = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal(after.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies'").get().value, original);
      assert.equal(after.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies_meta'").get().value, originalMeta);
      after.close();
      assert.deepEqual(fs.readFileSync(path.join(root, 'youtube-cookies.txt')), originalFile,
        'verification did not rewrite the imported jar');
    }
    const audit = await api('/api/admin/audit?limit=200');
    assert.ok(audit.body.entries.filter((e) => e.action === 'youtube.cookies.verify').length >= 2);
    assert.ok(!JSON.stringify(audit.body).includes('GOODJAR-sid'));
    assert.ok(!JSON.stringify(audit.body).includes('expired-sid'));
  });
});

test('a delayed import cannot resurrect a jar after a newer disconnect', async () => {
  const stub = path.join(ROOT, 'delayed-yt-dlp-stub.mjs');
  fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const at = args.indexOf('--cookies');
if (at < 0) { console.error('ERROR: Sign in to confirm you\\'re not a bot.'); process.exit(1); }
const jar = fs.readFileSync(args[at + 1], 'utf8');
if (!jar.includes('GOODJAR')) process.exit(1);
fs.writeFileSync(process.env.COOKIE_TEST_STARTED, 'started');
for (let i = 0; i < 200 && !fs.existsSync(process.env.COOKIE_TEST_RELEASE); i++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log('stub: resolved');
`, { mode: 0o755 });
  let started;
  let release;
  try {
    await withCookieServer({
      stub,
      extraEnv(root) {
        started = path.join(root, 'probe-started');
        release = path.join(root, 'probe-release');
        return { COOKIE_TEST_STARTED: started, COOKIE_TEST_RELEASE: release };
      },
    }, async ({ api, root, dbPath }) => {
      const pending = api('/api/youtube/cookies', {
        method: 'POST', body: { cookies: GOOD_JAR },
      });
      for (let i = 0; i < 100 && !fs.existsSync(started); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(fs.existsSync(started), 'the first save reached its delayed verification probe');
      const clearing = api('/api/youtube/cookies', { method: 'DELETE' });
      const early = await Promise.race([
        clearing.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      assert.equal(early, false, 'disconnect waits for the in-flight import instead of interleaving its save');
      fs.writeFileSync(release, 'release');

      const [late, cleared] = await Promise.all([pending, clearing]);
      assert.equal(late.res.status, 200, JSON.stringify(late.body));
      assert.equal(cleared.res.status, 200, JSON.stringify(cleared.body));
      assert.equal(fs.existsSync(path.join(root, 'youtube-cookies.txt')), false);
      const status = await api('/api/youtube/status');
      assert.equal(status.body.jar.connected, false);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal(db.prepare("SELECT value FROM secrets WHERE name = 'youtube_cookies'").get(), undefined);
      db.close();
    });
  } finally {
    // A failed test must release the child probe so the helper can shut down.
    if (release && fs.existsSync(path.dirname(release)) && !fs.existsSync(release)) {
      fs.writeFileSync(release, 'release');
    }
  }
});

const netscapeCookie = ({ domain = '.youtube.com', flag = 'TRUE', cookiePath = '/',
  secure = true, expiry = 2_000_000_000, name, value }) =>
  `${domain}\t${flag}\t${cookiePath}\t${secure ? 'TRUE' : 'FALSE'}\t${expiry}\t${name}\t${value}`;

test('Innertube headers enforce domain, host-only, path, Secure, and expiry rules', async () => {
  const { parseNetscape, cookieHeader } = await import('../src/cookies.js');
  const now = Math.floor(Date.now() / 1000);
  const cookies = parseNetscape([
    // youtubei.js uses SAPISID for its authorization token and reuses this
    // header for YouTube's Innertube endpoints. Domain-wide Google sign-in
    // cookies therefore remain intentional; unrelated Google cookies do not.
    netscapeCookie({ domain: '.google.com', name: 'SID', value: 'google-sid' }),
    netscapeCookie({ domain: '.google.com', name: 'SAPISID', value: 'google-auth' }),
    netscapeCookie({ domain: '.google.com', name: 'NID', value: 'google-tracking' }),
    netscapeCookie({ domain: 'google.com', flag: 'FALSE', name: 'LOGIN_INFO', value: 'host-only-google' }),
    netscapeCookie({ name: 'YSC', value: 'youtube-domain' }),
    netscapeCookie({ domain: 'www.youtube.com', flag: 'FALSE', name: 'HOST_ONLY', value: 'yes' }),
    netscapeCookie({ domain: 'www.youtube.com.evil.test', name: 'LOOKALIKE', value: 'no' }),
    netscapeCookie({ domain: 'example.com', name: 'UNRELATED', value: 'no' }),
    netscapeCookie({ cookiePath: '/youtubei', name: 'LONG_PATH', value: 'yes' }),
    netscapeCookie({ cookiePath: '/browse', name: 'WRONG_PATH', value: 'no' }),
    netscapeCookie({ secure: true, name: 'SECURE_ONLY', value: 'yes' }),
    netscapeCookie({ secure: false, name: 'PLAIN_OK', value: 'yes' }),
    netscapeCookie({ expiry: now - 10, name: 'EXPIRED', value: 'no' }),
    netscapeCookie({ expiry: 0, secure: false, name: 'SESSION', value: 'yes' }),
  ].join('\n'));

  const header = cookieHeader(cookies);
  for (const pair of ['SID=google-sid', 'SAPISID=google-auth', 'YSC=youtube-domain',
    'HOST_ONLY=yes', 'LONG_PATH=yes', 'SECURE_ONLY=yes', 'PLAIN_OK=yes', 'SESSION=yes']) {
    assert.ok(header.split('; ').includes(pair), `missing ${pair} in ${header}`);
  }
  for (const pair of ['NID=google-tracking', 'LOGIN_INFO=host-only-google', 'LOOKALIKE=no',
    'UNRELATED=no', 'WRONG_PATH=no', 'EXPIRED=no']) {
    assert.ok(!header.split('; ').includes(pair), `unexpected ${pair}`);
  }
  assert.ok(header.split('; ').indexOf('LONG_PATH=yes') < header.split('; ').indexOf('YSC=youtube-domain'),
    'the most specific path is sent first');

  const insecure = cookieHeader(cookies, 'http://www.youtube.com/youtubei/v1/search');
  assert.ok(!insecure.split('; ').includes('SECURE_ONLY=yes'));
  assert.ok(insecure.split('; ').includes('PLAIN_OK=yes'));

  const subdomain = cookieHeader(cookies, 'https://music.youtube.com/youtubei/v1/browse');
  assert.ok(!subdomain.split('; ').includes('HOST_ONLY=yes'), 'host-only cookies never cross hosts');
  assert.ok(subdomain.split('; ').includes('YSC=youtube-domain'));

  const wrongPath = cookieHeader(cookies, 'https://www.youtube.com/youtubeifoo');
  assert.ok(!wrongPath.split('; ').includes('LONG_PATH=yes'), 'path matching observes a slash boundary');

  const { parseJsonCookies } = await import('../src/cookies.js');
  const jsonHostOnly = parseJsonCookies(JSON.stringify([
    { domain: 'www.youtube.com', hostOnly: true, path: '/', secure: true, name: 'JSON_HOST', value: 'yes' },
  ]));
  assert.equal(jsonHostOnly[0].flag, 'FALSE');
  assert.equal(cookieHeader(jsonHostOnly, 'https://www.youtube.com/'), 'JSON_HOST=yes');
  assert.equal(cookieHeader(jsonHostOnly, 'https://music.youtube.com/'), '');
});

test('the scoped header still drives youtubei.js SAPISID authentication', async () => {
  const { Innertube } = await import('youtubei.js');
  const { cookieHeader } = await import('../src/cookies.js');
  const header = cookieHeader([
    { domain: '.google.com', flag: 'TRUE', path: '/', secure: true, expiry: 2_000_000_000, name: 'SAPISID', value: 'auth-value' },
    { domain: '.google.com', flag: 'TRUE', path: '/', secure: true, expiry: 2_000_000_000, name: 'NID', value: 'tracking' },
  ]);
  const calls = [];
  const yt = await Innertube.create({
    cookie: header,
    retrieve_player: false,
    generate_session_locally: true,
    retrieve_innertube_config: false,
    fetch: async (input, init) => {
      const headers = new Headers(init.headers);
      calls.push({
        url: String(input.url ?? input),
        cookie: headers.get('cookie'),
        authorization: headers.get('authorization'),
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await yt.search('cookie transport probe').catch(() => { /* response shape is irrelevant */ });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/www\.youtube\.com\/youtubei\/v1\/search/);
  assert.equal(calls[0].cookie, 'SAPISID=auth-value');
  assert.match(calls[0].authorization, /^SAPISIDHASH \d+_[a-f0-9]{40}$/);
});

test('cookie parsers normalise safe expiries and reject invalid or injected fields', async () => {
  const { parseAny, parseNetscape, parseJsonCookies, inspectJar, toNetscape } = await import('../src/cookies.js');
  const safe = parseNetscape([
    COOKIE('SID', 'fractional', { expiry: '2000000000.9' }),
    COOKIE('HSID', 'session', { expiry: 0 }),
  ].join('\n'));
  assert.equal(safe.length, 2);
  assert.equal(safe[0].expiry, 2_000_000_000);
  assert.equal(inspectJar(safe).expiresAt, new Date(2_000_000_000_000).toISOString());

  for (const expiry of ['NaN', 'Infinity', '-1', '8640000000001', '1e400']) {
    const parsed = parseAny([
      COOKIE('SID', 'bad', { expiry }),
      COOKIE('HSID', 'bad', { expiry }),
    ].join('\n'));
    assert.deepEqual(parsed, { format: 'unknown', cookies: [] }, `expiry ${expiry}`);
  }
  assert.doesNotThrow(() => inspectJar([
    { domain: '.google.com', name: 'SID', value: 'x', expiry: Infinity },
    { domain: '.google.com', name: 'HSID', value: 'y', expiry: Infinity },
  ]));
  assert.equal(inspectJar([{ domain: '.google.com', name: 'SID', value: 'x', expiry: Infinity }]).expiresAt, null);
  assert.throws(() => toNetscape([{ domain: '.google.com', name: 'SID', value: 'x', expiry: Infinity }]), /expiry/i);

  const base = { domain: '.google.com', name: 'SID', value: 'safe', expirationDate: 1893456000 };
  for (const field of ['domain', 'path', 'name', 'value']) {
    for (const injection of ['\r\ninjected', '\tinjected']) {
      const data = [base, { domain: '.google.com', name: 'HSID', value: 'safe', expirationDate: 1893456000 }];
      data[0] = { ...base, [field]: `${base[field] ?? '/'}${injection}` };
      assert.equal(parseJsonCookies(JSON.stringify(data)), null, `${field} with ${JSON.stringify(injection)}`);
      assert.equal(parseAny(JSON.stringify(data)).format, 'unknown');
    }
  }
  assert.equal(parseAny(`${GOOD_JAR}\tInjected`).format, 'unknown', 'extra Netscape columns are not cookie values');
  assert.equal(parseAny(`\t${GOOD_JAR}`).format, 'unknown', 'leading tabs are not trimmed into a valid domain');
});

test('clearJar removes plaintext first, preserves encrypted recovery on failure, and accepts ENOENT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-jar-clear-'));
  try {
    const db = path.join(dir, 'unit.db');
    await runIsolated(
      { SONORA_DB: db, SONORA_SECRET: 'clear-test' },
      `const m = await import(${JSON.stringify(cookiesUrl)});`
        + `const text = ${JSON.stringify(GOOD_JAR)};`
        + 'await m.saveJar(m.parseNetscape(text), text);',
    );
    const out = await runIsolated(
      { SONORA_DB: db, SONORA_SECRET: 'clear-test' },
      `import fs from 'node:fs'; const m = await import(${JSON.stringify(cookiesUrl)});`
        + 'const target=m.storedCookiesPath(); fs.rmSync(target); fs.mkdirSync(target);'
        + 'let error=null; try { await m.clearJar(); } catch (err) { error={code:err.code}; }'
        + "process.stdout.write(JSON.stringify({error,secret:Boolean(m.dbGet('youtube_cookies')),"
        + "meta:Boolean(m.dbGet('youtube_cookies_meta')),active:m.activeCookiesPath()}));",
    );
    const failed = JSON.parse(lastLine(out));
    assert.ok(failed.error?.code, 'non-ENOENT unlink errors reach the caller');
    assert.equal(failed.secret, true, 'encrypted credentials remain available for a retry/recovery');
    assert.equal(failed.meta, true);
    assert.ok(failed.active, 'test proves the plaintext path would otherwise remain active');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-jar-clear-missing-'));
  try {
    const out = await runIsolated(
      { SONORA_DB: path.join(missingDir, 'unit.db'), SONORA_SECRET: 'clear-test' },
      `const m = await import(${JSON.stringify(cookiesUrl)});`
        + "m.dbSet('youtube_cookies','recoverable'); m.dbSet('youtube_cookies_meta','{}');"
        + "await m.clearJar(); process.stdout.write(JSON.stringify({secret:m.dbGet('youtube_cookies'),"
        + "meta:m.dbGet('youtube_cookies_meta')}));",
    );
    assert.deepEqual(JSON.parse(lastLine(out)), { secret: null, meta: null });
  } finally {
    fs.rmSync(missingDir, { recursive: true, force: true });
  }
});

// ── write ordering and the memoised verdict ─────────────────────────────
// The encrypted row is the copy that survives a lost file, so it is written
// first; and the "does this jar look usable" answer is cached per (mtime, size)
// because it is recomputed on every download, but the cache must never outlive
// the file it describes.

test('saveJar stores the encrypted copy even when the plaintext write fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-jar-order-'));
  try {
    const db = path.join(dir, 'unit.db');
    const text = GOOD_JAR;
    const out = await runIsolated(
      { SONORA_DB: db, SONORA_SECRET: 'order-test' },
      `import fs from 'node:fs'; const m = await import(${JSON.stringify(cookiesUrl)});`
        + `const text = ${JSON.stringify(text)};`
        // A directory where the jar file belongs makes the rename fail.
        + 'fs.mkdirSync(m.storedCookiesPath(), { recursive: true });'
        + 'let error = null;'
        + 'try { await m.saveJar(m.parseNetscape(text), text); } catch (err) { error = err.code ?? err.message; }'
        + 'const meta = m.dbGet("youtube_cookies_meta");'
        + 'process.stdout.write(JSON.stringify({ error, secret: Boolean(m.dbGet("youtube_cookies")), meta }));',
    );
    const result = JSON.parse(lastLine(out));
    assert.ok(result.error, 'a failed plaintext write is reported, not swallowed');
    assert.equal(result.secret, true,
      'the encrypted jar was committed before the file was attempted');
    assert.equal(JSON.parse(result.meta).cookieCount, 5, 'and the import metadata came with it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cached verdict follows the file instead of remembering an old answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-jar-cache-'));
  try {
    const db = path.join(dir, 'unit.db');
    const envJar = path.join(dir, 'env-cookies.txt');
    fs.writeFileSync(envJar, GOOD_JAR);
    const out = await runIsolated(
      { SONORA_DB: db, SONORA_SECRET: 'cache-test', SONORA_YTDLP_COOKIES: envJar },
      `import fs from 'node:fs'; const m = await import(${JSON.stringify(cookiesUrl)});`
        + `const good = ${JSON.stringify(GOOD_JAR)};`
        + `const weak = ${JSON.stringify(NO_IDENTITY_JAR)};`
        + 'const seen = {};'
        // 1. An implausible stored jar steps aside for the env jar (and the
        //    verdict for it is now cached).
        + 'await m.saveJar(m.parseNetscape(weak), weak);'
        + 'seen.implausible = m.activeCookiesPath();'
        // 2. The file is replaced behind the module's back: a plausible jar with
        //    a different size and mtime must be believed, not the cached "no".
        + 'fs.writeFileSync(m.storedCookiesPath(), good);'
        + 'seen.replaced = m.activeCookiesPath();'
        // 3. clearJar/saveJar must forget the memo as well.
        + 'await m.clearJar(); seen.cleared = m.activeCookiesPath();'
        + 'await m.saveJar(m.parseNetscape(weak), weak); seen.saved = m.activeCookiesPath();'
        + 'process.stdout.write(JSON.stringify({ seen, stored: m.storedCookiesPath() }));',
    );
    const { seen, stored } = JSON.parse(lastLine(out));
    assert.equal(seen.implausible, envJar, 'an implausible import yields to SONORA_YTDLP_COOKIES');
    assert.equal(seen.replaced, stored, 'a replaced, plausible jar is selected again');
    assert.equal(seen.cleared, envJar, 'after a disconnect the env jar is the source');
    assert.equal(seen.saved, envJar, 'and a fresh implausible import still yields');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
