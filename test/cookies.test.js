import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Cookie-import flow, tested end to end through the HTTP API.
//
// A stub yt-dlp stands in for the real one so verification is deterministic:
// it fails with the bot-gate message unless the jar contains a "good" cookie.
// That lets us assert the important property — a jar is only reported as
// connected if it actually works — without touching YouTube.

const PORT = 8144;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cookies-'));
const DB = path.join(ROOT, 'test.db');
const STUB = path.join(ROOT, 'yt-dlp-stub.mjs');

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
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
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
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
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
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
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
