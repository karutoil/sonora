import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Authentication is the one surface where a regression is not cosmetic: a
// replayable refresh token or a device that cannot be revoked is a real
// security bug. These tests drive the same HTTP surface a browser uses and
// assert on cookie behaviour, rotation, and per-device revocation.
//
// The requests go to 127.0.0.1 but carry `x-forwarded-host: localhost` so the
// server derives a WebAuthn-capable RP ID (an IP can never be one). That is the
// same override a tunnel deployment uses via SONORA_RP_ID/SONORA_ORIGIN.

const PORT = 8147;
const BASE = `http://127.0.0.1:${PORT}`;
const HOST_HEADERS = { 'x-forwarded-host': `localhost:${PORT}`, 'x-forwarded-proto': 'http' };
const DB = new URL(`./.tmp/auth-${Date.now()}.db`, import.meta.url).pathname;
const AUDIO = new URL(`./.tmp/authaudio-${Date.now()}`, import.meta.url).pathname;

let proc;
const logs = [];

class Jar {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  has(name) { return this.cookies.has(name); }
  get(name) { return this.cookies.get(name); }
  set(name, value) { this.cookies.set(name, value); }
  clear() { this.cookies.clear(); }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      // An empty value or Max-Age=0 is a deletion, not a cookie.
      if (!value || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

async function req(path, { jar = null, body, method = 'GET', headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...HOST_HEADERS,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) jar.absorb(res);
  const isJson = res.headers.get('content-type')?.includes('json');
  return { res, status: res.status, body: isJson ? await res.json() : null };
}

const login = (jar, body) => req('/api/auth/login', {
  jar, method: 'POST', body: { name: 'toil', passphrase: 'hunter2hunter2', ...body },
});

before(async () => {
  fs.mkdirSync(new URL('./.tmp', import.meta.url).pathname, { recursive: true });
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'auth-test-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_SESSION_MINUTES: '60', SONORA_REFRESH_DAYS: '14',
      // This file signs in far more often than a person does, and the limiter is
      // keyed by IP, so a realistic limit would make the suite fail on itself.
      SONORA_LOGIN_RATE_MAX: '1000',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { headers: HOST_HEADERS });
      const health = r.ok ? await r.json() : null;
      if (health?.pid === proc.pid) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${logs.join('')}`);
});

after(() => {
  proc?.kill('SIGTERM');
});

test('capabilities describe the deployment and its passkey support', async () => {
  const { status, body } = await req('/api/auth/capabilities');
  assert.equal(status, 200);
  assert.equal(body.hasUsers, true);
  assert.equal(body.passkeys.supported, true);
  assert.equal(body.passkeys.rpID, 'localhost');
  assert.equal(body.refreshDays, 14);
  assert.equal(body.sessionMinutes, 60);
});

test('an IP address is refused as a passkey origin, with a reason', async () => {
  const { body } = await req('/api/auth/capabilities', {
    headers: { 'x-forwarded-host': '192.168.1.50:8130' },
  });
  assert.equal(body.passkeys.supported, false);
  assert.match(body.passkeys.reason, /domain/i);
});

test('login without remember sets no refresh token and a session cookie', async () => {
  const jar = new Jar();
  const { status, body, res } = await login(jar, {
    remember: false, deviceId: 'no-remember-browser', deviceName: 'Test Laptop',
  });
  assert.equal(status, 200);
  assert.equal(body.remembered, false);
  assert.equal(body.device.name, 'Test Laptop');
  assert.equal(jar.has('sonora_refresh'), false);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('sonora_auth=') || c.startsWith('sonora_session='));
  assert.ok(access, 'access cookie was set');
  assert.doesNotMatch(access, /max-age=/i, 'a non-remembered session must not outlive the browser');
});

test('login with remember sets a persistent refresh token and a device row', async () => {
  const jar = new Jar();
  const { status, body, res } = await login(jar, {
    remember: true, deviceId: 'remembered-browser', deviceName: 'Test Phone',
  });
  assert.equal(status, 200);
  assert.equal(body.remembered, true);
  assert.equal(jar.has('sonora_refresh'), true);
  const refresh = res.headers.getSetCookie().find((c) => c.startsWith('sonora_refresh='));
  assert.match(refresh, /max-age=/i);

  const me = await req('/api/me', { jar });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.remembered, true);
  assert.ok(me.body.user.deviceId);

  const security = await req('/api/auth/security', { jar });
  assert.equal(security.status, 200);
  // Devices accumulate across tests on one account, so assert on this device
  // rather than on a global count.
  const current = security.body.devices.find((d) => d.current);
  assert.ok(current, 'the current device is listed');
  assert.equal(current.name, 'Test Phone');
  assert.equal(current.remembered, true);
  assert.deepEqual(security.body.passkeys, []);
  assert.equal(security.body.capabilities.supported, true);
});

test('a refresh token rotates and the old one is rejected as replay', async () => {
  const jar = new Jar();
  await login(jar, { remember: true, deviceId: 'rotate-browser', deviceName: 'Rotate' });
  const first = jar.get('sonora_refresh');
  assert.ok(first);

  // Simulate the access cookie expiring while the tab stays open.
  jar.cookies.delete('sonora_auth');
  jar.cookies.delete('sonora_session');
  const rotated = await req('/api/auth/refresh', { jar, method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.ok(jar.get('sonora_refresh'));
  assert.notEqual(jar.get('sonora_refresh'), first);
  assert.equal((await req('/api/me', { jar })).status, 200);

  // Replaying the consumed token is theft: the device dies, including the
  // session that legitimately rotated.
  const current = jar.get('sonora_refresh');
  jar.set('sonora_refresh', first);
  const replay = await req('/api/auth/refresh', { jar, method: 'POST', body: {} });
  assert.equal(replay.status, 401);
  assert.equal(jar.has('sonora_refresh'), false);

  jar.set('sonora_refresh', current);
  const afterReplay = await req('/api/auth/refresh', { jar, method: 'POST', body: {} });
  assert.equal(afterReplay.status, 401, 'the whole device is revoked after a replay');
});

test('a device can be renamed and revoked, and revoking it kills its session', async () => {
  const a = new Jar();
  await login(a, { remember: true, deviceId: 'device-a', deviceName: 'Laptop A' });
  const b = new Jar();
  await login(b, { remember: true, deviceId: 'device-b', deviceName: 'Phone B' });

  const listed = await req('/api/auth/security', { jar: a });
  // Look each device up by name: earlier tests leave other devices behind.
  assert.ok(listed.body.devices.some((d) => d.name === 'Laptop A'));
  const other = listed.body.devices.find((d) => d.name === 'Phone B');
  assert.ok(other);

  const renamed = await req(`/api/auth/devices/${encodeURIComponent(other.id)}`, {
    jar: a, method: 'PATCH', body: { name: 'Phone B (work)' },
  });
  assert.equal(renamed.status, 200);
  assert.ok(renamed.body.devices.some((d) => d.name === 'Phone B (work)'));

  const revoked = await req(`/api/auth/devices/${encodeURIComponent(other.id)}`, { jar: a, method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await req('/api/me', { jar: b })).status, 401);
  assert.equal((await req('/api/auth/refresh', { jar: b, method: 'POST', body: {} })).status, 401);
});

test('a remembered device can be forgotten without signing out', async () => {
  const jar = new Jar();
  await login(jar, { remember: true, deviceId: 'forget-browser', deviceName: 'Forget' });
  const refresh = jar.get('sonora_refresh');
  const me = await req('/api/me', { jar });
  assert.equal(me.body.user.remembered, true);

  const r = await req(`/api/auth/devices/${encodeURIComponent(me.body.user.deviceId)}`, {
    jar, method: 'PATCH', body: { remembered: false },
  });
  assert.equal(r.status, 200);
  const row = r.body.devices.find((d) => d.current);
  assert.equal(row.remembered, false);

  // The access session survives, the saved-session token does not.
  assert.equal((await req('/api/me', { jar })).status, 200);
  assert.equal(jar.has('sonora_refresh'), false);
  jar.set('sonora_refresh', refresh);
  assert.equal((await req('/api/auth/refresh', { jar, method: 'POST', body: {} })).status, 401);
});

test('sign out other devices keeps this one and kills the rest', async () => {
  const a = new Jar();
  await login(a, { remember: true, deviceId: 'keep-a', deviceName: 'Keep' });
  const b = new Jar();
  await login(b, { remember: true, deviceId: 'drop-b', deviceName: 'Drop' });

  const r = await req('/api/auth/devices/revoke-others', { jar: a, method: 'POST', body: {} });
  assert.equal(r.status, 200);
  // Every other device on the account goes, including leftovers from earlier
  // tests; only the caller must survive.
  assert.ok(r.body.revoked >= 1);
  assert.equal((await req('/api/me', { jar: a })).status, 200);
  assert.equal((await req('/api/me', { jar: b })).status, 401);
  assert.equal((await req('/api/auth/refresh', { jar: b, method: 'POST', body: {} })).status, 401);

  const left = await req('/api/auth/security', { jar: a });
  assert.equal(left.body.devices.length, 1);
  assert.equal(left.body.devices[0].current, true);
});

test('sign out everywhere ends this session too', async () => {
  const jar = new Jar();
  await login(jar, { remember: true, deviceId: 'all-browser', deviceName: 'All' });
  const r = await req('/api/auth/signout-all', { jar, method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal((await req('/api/me', { jar })).status, 401);
  assert.equal((await req('/api/auth/refresh', { jar, method: 'POST', body: {} })).status, 401);
  assert.equal(jar.has('sonora_refresh'), false);
});

test('logout forgets the device rather than only clearing the cookie', async () => {
  const jar = new Jar();
  await login(jar, { remember: true, deviceId: 'logout-browser', deviceName: 'Logout' });
  const refresh = jar.get('sonora_refresh');
  const out = await req('/api/auth/logout', { jar, method: 'POST', body: {} });
  assert.equal(out.status, 200);
  assert.equal((await req('/api/me', { jar })).status, 401);

  // Replaying the old refresh cookie after logout must not resurrect it.
  jar.set('sonora_refresh', refresh);
  assert.equal((await req('/api/auth/refresh', { jar, method: 'POST', body: {} })).status, 401);
});

test('passkey registration issues a single-use challenge', async () => {
  const jar = new Jar();
  const signedIn = await login(jar, { remember: false, deviceId: 'passkey-browser', deviceName: 'Passkey' });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));

  const options = await req('/api/auth/passkey/register/options', { jar, method: 'POST', body: {} });
  assert.equal(options.status, 200);
  assert.equal(options.body.options.rp.id, 'localhost');
  assert.equal(typeof options.body.options.challenge, 'string');
  assert.ok(options.body.options.user.id);
  assert.ok(jar.has('sonora_webauthn'), 'ceremony is bound to a cookie');

  const bad = await req('/api/auth/passkey/register/verify', {
    jar, method: 'POST', body: { challengeId: options.body.challengeId, response: { id: 'x' } },
  });
  assert.equal(bad.status, 400);

  // The challenge is consumed even by a failed verification.
  const again = await req('/api/auth/passkey/register/verify', {
    jar, method: 'POST', body: { challengeId: options.body.challengeId, response: { id: 'x' } },
  });
  assert.equal(again.status, 400);

  const list = await req('/api/auth/passkeys', { jar });
  assert.deepEqual(list.body.passkeys, []);
});

test('passkey login options do not reveal whether an account exists', async () => {
  const known = await req('/api/auth/passkey/login/options', { method: 'POST', body: { name: 'toil' } });
  const unknown = await req('/api/auth/passkey/login/options', { method: 'POST', body: { name: 'nobody-here' } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(typeof known.body.options.challenge, 'string');
  assert.equal(typeof unknown.body.options.challenge, 'string');
  // No registered credentials exist, so both must fall back to discoverable
  // credentials rather than naming the account.
  assert.equal(known.body.options.allowCredentials, undefined);
});

test('an unknown credential is rejected without a challenge', async () => {
  const options = await req('/api/auth/passkey/login/options', { method: 'POST', body: {} });
  const verify = await req('/api/auth/passkey/login/verify', {
    method: 'POST',
    headers: { cookie: `sonora_webauthn=${options.res.headers.getSetCookie()[0].split('=')[1].split(';')[0]}` },
    body: { challengeId: options.body.challengeId, response: { id: 'not-registered', response: {} } },
  });
  assert.equal(verify.status, 401);
});

test('the security surface requires a session', async () => {
  assert.equal((await req('/api/auth/security')).status, 401);
  assert.equal((await req('/api/auth/devices/revoke-others', { method: 'POST', body: {} })).status, 401);
  assert.equal((await req('/api/auth/signout-all', { method: 'POST', body: {} })).status, 401);
  assert.equal((await req('/api/auth/passkey/register/options', { method: 'POST', body: {} })).status, 401);
});
