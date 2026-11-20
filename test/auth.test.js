import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { freePort } from './helpers/cdp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Authentication is the one surface where a regression is not cosmetic: a
// replayable refresh token or a device that cannot be revoked is a real
// security bug. These tests drive the same HTTP surface a browser uses and
// assert on cookie behaviour, rotation, and per-device revocation.
//
// The requests go to 127.0.0.1 but carry `x-forwarded-host: localhost` so the
// server derives a WebAuthn-capable RP ID (an IP can never be one). That is the
// same override a tunnel deployment uses via SONORA_RP_ID/SONORA_ORIGIN.

let PORT = 0;
let BASE = '';
let HOST_HEADERS = null;
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
  jar, method: 'POST', body: { name: 'admin', passphrase: 'hunter2hunter2', ...body },
});

function storedChallenge(id) {
  const database = new DatabaseSync(DB, { readOnly: true });
  try {
    return database.prepare('SELECT id, kind FROM webauthn_challenges WHERE id = ?').get(id);
  } finally {
    database.close();
  }
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  HOST_HEADERS = { 'x-forwarded-host': `localhost:${PORT}`, 'x-forwarded-proto': 'http' };
  fs.mkdirSync(new URL('./.tmp', import.meta.url).pathname, { recursive: true });
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'auth-test-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_SESSION_MINUTES: '60', SONORA_REFRESH_DAYS: '14',
      // This file simulates a tunnel: x-forwarded-host names the public host a
      // passkey has to be scoped to, and forwarded headers are only honoured
      // when the proxy is trusted (the default is now off — see config.js).
      SONORA_TRUST_PROXY: '1',
      // Strict rotation for the replay tests here: the grace window (which the
      // browser needs when two tabs share a refresh token) is covered on its own
      // server in this file.
      SONORA_REFRESH_GRACE_MS: '0',
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

test('signing in again without remember clears the old persistent credential', async () => {
  const jar = new Jar();
  const remembered = await login(jar, {
    remember: true, deviceId: 'remember-transition', deviceName: 'Remember transition',
  });
  assert.equal(remembered.status, 200);
  const oldRefresh = jar.get('sonora_refresh');
  assert.ok(oldRefresh);

  const forgotten = await login(jar, {
    remember: false, deviceId: 'remember-transition', deviceName: 'Remember transition',
  });
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.body.remembered, false);
  assert.equal(jar.has('sonora_refresh'), false, 'the browser deleted the old refresh cookie');
  const removal = forgotten.res.headers.getSetCookie()
    .find((cookie) => cookie.startsWith('sonora_refresh='));
  assert.ok(removal, 'the forgetting response explicitly clears the refresh cookie');
  assert.match(removal, /max-age=0/i);
  const access = forgotten.res.headers.getSetCookie()
    .find((cookie) => cookie.startsWith('sonora_session='));
  assert.ok(access);
  assert.doesNotMatch(access, /max-age=/i, 'the replacement access cookie is session-scoped');

  const liveSession = jar.get('sonora_session');
  jar.set('sonora_refresh', oldRefresh);
  assert.equal((await req('/api/auth/refresh', { jar, method: 'POST', body: {} })).status, 401);
  assert.equal((await req('/api/me', {
    headers: { cookie: `sonora_session=${liveSession}` },
  })).status, 200, 'the old revoked token cannot delete the replacement session');
});

test('a revoked token that was never rotated cannot delete its current device', async () => {
  const jar = new Jar();
  await login(jar, { remember: true, deviceId: 'revoked-not-rotated', deviceName: 'Revoked only' });
  const revokedToken = jar.get('sonora_refresh');
  const before = await req('/api/me', { jar });
  const deviceId = before.body.user.deviceId;

  // Forgetting through the security screen revokes the token without giving it
  // a replaced_by successor. That is an ordinary revocation, not evidence that a
  // rotated credential was stolen.
  const forgotten = await req(`/api/auth/devices/${encodeURIComponent(deviceId)}`, {
    jar, method: 'PATCH', body: { remembered: false },
  });
  assert.equal(forgotten.status, 200);
  const currentSession = jar.get('sonora_session');
  assert.ok(currentSession);

  jar.set('sonora_refresh', revokedToken);
  const replay = await req('/api/auth/refresh', { jar, method: 'POST', body: {} });
  assert.equal(replay.status, 401);
  const me = await req('/api/me', { headers: { cookie: `sonora_session=${currentSession}` } });
  assert.equal(me.status, 200, 'the current access session survives an old revoked token');
  assert.equal(me.body.user.deviceId, deviceId);
  assert.equal(me.body.user.remembered, false);
});

test('one device cannot make another device remembered with an undeliverable token', async () => {
  const controller = new Jar();
  const other = new Jar();
  await login(controller, { remember: false, deviceId: 'remember-controller', deviceName: 'Controller' });
  await login(other, { remember: false, deviceId: 'remember-target', deviceName: 'Remote target' });

  const listed = await req('/api/auth/security', { jar: controller });
  const target = listed.body.devices.find((device) => device.name === 'Remote target');
  assert.ok(target);
  assert.equal(target.remembered, false);
  assert.equal(target.activeRefreshTokens, 0);

  const changed = await req(`/api/auth/devices/${encodeURIComponent(target.id)}`, {
    jar: controller, method: 'PATCH', body: { remembered: true },
  });
  assert.equal(changed.status, 409, 'the browser must enable this on the device receiving its cookie');
  assert.equal(changed.res.headers.getSetCookie().some((cookie) => cookie.startsWith('sonora_refresh=')), false);

  const otherSecurity = await req('/api/auth/security', { jar: other });
  const unchanged = otherSecurity.body.devices.find((device) => device.current);
  assert.equal(unchanged.id, target.id);
  assert.equal(unchanged.remembered, false, 'a rejected change does not mark the remote device remembered');
  assert.equal(unchanged.activeRefreshTokens, 0, 'a rejected change creates no orphan refresh token');
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
  assert.ok(jar.has('sonora_webauthn_register'), 'ceremony is bound to its own cookie');
  // Registration and login no longer share one cookie: a login ceremony
  // started while a registration was open used to overwrite the challenge and
  // fail the registration with "that passkey request expired".
  assert.equal(jar.has('sonora_webauthn_login'), false);

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
  const known = await req('/api/auth/passkey/login/options', { method: 'POST', body: { name: 'admin' } });
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

test('a newer registration ceremony deletes the previous same-kind challenge row', async () => {
  const jar = new Jar();
  await login(jar, { remember: false, deviceId: 'latest-register', deviceName: 'Latest registration' });
  const first = await req('/api/auth/passkey/register/options', { jar, method: 'POST', body: {} });
  const second = await req('/api/auth/passkey/register/options', { jar, method: 'POST', body: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.challengeId, second.body.challengeId);
  assert.equal(jar.get('sonora_webauthn_register'), second.body.challengeId);
  assert.equal(storedChallenge(first.body.challengeId), undefined,
    'the superseded ceremony is deleted instead of lingering until its TTL');
  assert.equal(storedChallenge(second.body.challengeId)?.kind, 'register');
});

test('a stale registration verify cannot clear or consume the latest ceremony', async () => {
  const jar = new Jar();
  await login(jar, { remember: false, deviceId: 'stale-register', deviceName: 'Stale registration' });
  const first = await req('/api/auth/passkey/register/options', { jar, method: 'POST', body: {} });
  const latest = await req('/api/auth/passkey/register/options', { jar, method: 'POST', body: {} });
  const latestCookie = jar.get('sonora_webauthn_register');

  const stale = await req('/api/auth/passkey/register/verify', {
    jar, method: 'POST', body: { challengeId: first.body.challengeId, response: { id: 'stale' } },
  });
  assert.equal(stale.status, 400);
  assert.equal(jar.get('sonora_webauthn_register'), latestCookie,
    'a stale response must leave the newer browser ceremony alone');
  assert.equal(storedChallenge(latest.body.challengeId)?.kind, 'register');

  // The latest ceremony remains usable and single-use. Invalid WebAuthn data is
  // enough to prove that its own matching request consumes only its own row.
  const failedLatest = await req('/api/auth/passkey/register/verify', {
    jar, method: 'POST', body: { challengeId: latest.body.challengeId, response: { id: 'invalid' } },
  });
  assert.equal(failedLatest.status, 400);
  assert.equal(jar.has('sonora_webauthn_register'), false);
  assert.equal(storedChallenge(latest.body.challengeId), undefined);
});

test('passkey login is latest-only and a stale login cannot clear its successor', async () => {
  const jar = new Jar();
  const first = await req('/api/auth/passkey/login/options', { jar, method: 'POST', body: {} });
  const latest = await req('/api/auth/passkey/login/options', { jar, method: 'POST', body: {} });
  assert.equal(first.status, 200);
  assert.equal(latest.status, 200);
  assert.equal(jar.get('sonora_webauthn_login'), latest.body.challengeId);
  assert.equal(storedChallenge(first.body.challengeId), undefined,
    'starting again removes the superseded login challenge row');

  const stale = await req('/api/auth/passkey/login/verify', {
    jar, method: 'POST',
    body: { challengeId: first.body.challengeId, response: { id: 'stale', response: {} } },
  });
  assert.equal(stale.status, 400);
  assert.equal(jar.get('sonora_webauthn_login'), latest.body.challengeId,
    'the stale login did not clear the latest cookie');
  assert.equal(storedChallenge(latest.body.challengeId)?.kind, 'authenticate');

  const latestResult = await req('/api/auth/passkey/login/verify', {
    jar, method: 'POST',
    body: { challengeId: latest.body.challengeId, response: { id: 'not-registered', response: {} } },
  });
  assert.equal(latestResult.status, 401, 'the latest challenge still reaches credential verification');
  assert.equal(jar.has('sonora_webauthn_login'), false, 'only the consumed latest cookie is cleared');
  assert.equal(storedChallenge(latest.body.challengeId), undefined);
});

test('a failed login ceremony leaves a parallel registration untouched', async () => {
  const jar = new Jar();
  await login(jar, { remember: false, deviceId: 'parallel-ceremonies', deviceName: 'Parallel ceremonies' });
  const registration = await req('/api/auth/passkey/register/options', { jar, method: 'POST', body: {} });
  const authentication = await req('/api/auth/passkey/login/options', { jar, method: 'POST', body: {} });
  assert.equal(registration.status, 200);
  assert.equal(authentication.status, 200);
  const registrationCookie = jar.get('sonora_webauthn_register');
  assert.ok(registrationCookie);
  assert.ok(jar.has('sonora_webauthn_login'));

  const failedLogin = await req('/api/auth/passkey/login/verify', {
    jar, method: 'POST',
    body: { challengeId: authentication.body.challengeId, response: { id: 'not-registered', response: {} } },
  });
  assert.equal(failedLogin.status, 401);
  assert.equal(jar.has('sonora_webauthn_login'), false);
  assert.equal(jar.get('sonora_webauthn_register'), registrationCookie);
  assert.equal(storedChallenge(registration.body.challengeId)?.kind, 'register');

  const failedRegistration = await req('/api/auth/passkey/register/verify', {
    jar, method: 'POST',
    body: { challengeId: registration.body.challengeId, response: { id: 'invalid' } },
  });
  assert.equal(failedRegistration.status, 400);
  assert.equal(jar.has('sonora_webauthn_register'), false);
  assert.equal(storedChallenge(registration.body.challengeId), undefined);
});

test('the security surface requires a session', async () => {
  assert.equal((await req('/api/auth/security')).status, 401);
  assert.equal((await req('/api/auth/devices/revoke-others', { method: 'POST', body: {} })).status, 401);
  assert.equal((await req('/api/auth/signout-all', { method: 'POST', body: {} })).status, 401);
  assert.equal((await req('/api/auth/passkey/register/options', { method: 'POST', body: {} })).status, 401);
});

// ── configuration that has to be a property of the *request* ────────────
// The three defects below all shared one shape: a setting was decided from the
// deployment (is a secret configured? is the env var present?) instead of from
// the request, so the copy-the-template path and the LAN path were broken in
// ways no unit test could see. Each fixture boots its own server because the
// env is the subject of the test.

/** A throwaway server on a free port with its own database and audio dir. */
async function bootFixture(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-auth-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'fixture.db'),
      SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'auth-fixture-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOGIN_RATE_MAX: '1000',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  };
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      const health = r.ok ? await r.json() : null;
      if (health?.pid === child.pid) return { child, base, port, logs, stop };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error(`fixture server did not start:\n${logs.join('')}`);
}

/** One POST/GET against a fixture, with its own cookie jar. */
function fixtureReq(fixture, routePath, { jar = null, body, method = 'GET', headers = {} } = {}) {
  return fetch(fixture.base + routePath, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    if (jar) jar.absorb(res);
    const isJson = res.headers.get('content-type')?.includes('json');
    return { res, status: res.status, body: isJson ? await res.json() : null };
  });
}

/** Send an HTTP request target that fetch() cannot represent (absolute form). */
function rawLogin(port, target) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: 'request-target-missing', passphrase: 'wrong passphrase' });
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error(`timed out waiting for ${target}`)));
    socket.on('connect', () => {
      socket.end(
        `POST ${target} HTTP/1.1\r\n`
        + `Host: localhost:${port}\r\n`
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + 'Connection: close\r\n\r\n'
        + body,
      );
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('latin1');
      const [head] = raw.split('\r\n\r\n');
      const [statusLine, ...lines] = head.split('\r\n');
      const status = Number(statusLine?.split(' ')[1]);
      const headers = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      if (!status) reject(new Error(`invalid raw response for ${target}: ${raw}`));
      else resolve({ status, headers });
    });
  });
}

test('encoded and absolute-form API targets receive the same no-store protection', async () => {
  const targets = [
    '/api/auth/login?target=origin',
    '/%61pi/auth/login?target=encoded',
    `http://localhost:${PORT}/api/auth/login?target=absolute`,
    `http://localhost:${PORT}/%61pi/auth/login?target=absolute-encoded`,
  ];
  for (const target of targets) {
    const response = await rawLogin(PORT, target);
    assert.equal(response.status, 401, target);
    assert.equal(response.headers['cache-control'], 'no-store', target);
  }
  // Fastify rejects an invalid escape through onBadUrl before response hooks;
  // unlike the valid variants above there is no protected response to cache.
  const malformed = await rawLogin(PORT, '/%ZZ/api/auth/login?target=malformed');
  assert.equal(malformed.status, 400);
});

test('encoded and absolute-form API targets share the canonical login limiter', async () => {
  const variants = [
    (port) => '/api/auth/login?limit=origin',
    (port) => '/%61pi/auth/login?limit=encoded',
    (port) => `http://localhost:${port}/api/auth/login?limit=absolute`,
  ];
  for (const targetFor of variants) {
    const fixture = await bootFixture({ SONORA_LOGIN_RATE_MAX: '2' });
    try {
      const target = targetFor(fixture.port);
      const responses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        responses.push(await rawLogin(fixture.port, target));
      }
      assert.deepEqual(responses.map((response) => response.status), [401, 401, 429], target);
      for (const response of responses) {
        assert.equal(response.headers['cache-control'], 'no-store', target);
      }
    } finally {
      fixture.stop();
    }
  }
});

test('case-variant account names have independent failure lockouts', async () => {
  const fixture = await bootFixture();
  try {
    const admin = new Jar();
    const signedIn = await fixtureReq(fixture, '/api/auth/login', {
      jar: admin, method: 'POST',
      body: { name: 'admin', passphrase: 'hunter2hunter2', deviceId: 'case-admin' },
    });
    assert.equal(signedIn.status, 200);
    const created = await fixtureReq(fixture, '/api/admin/users', {
      jar: admin, method: 'POST',
      body: { name: 'TOIL', passphrase: 'correct-horse-passphrase', role: 'user' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await fixtureReq(fixture, '/api/auth/login', {
        method: 'POST', body: { name: 'admin', passphrase: 'wrong passphrase' },
      });
      assert.equal(wrong.status, 401);
    }
    const locked = await fixtureReq(fixture, '/api/auth/login', {
      method: 'POST', body: { name: 'admin', passphrase: 'hunter2hunter2' },
    });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.res.headers.get('retry-after')) > 0);

    const variant = new Jar();
    const otherAccount = await fixtureReq(fixture, '/api/auth/login', {
      jar: variant, method: 'POST',
      body: { name: 'TOIL', passphrase: 'correct-horse-passphrase', deviceId: 'case-variant' },
    });
    assert.equal(otherAccount.status, 200, 'the distinct SQLite account must not inherit admin’s lock');
    assert.equal(otherAccount.body.user.name, 'TOIL');
    assert.equal((await fixtureReq(fixture, '/api/me', { jar: variant })).status, 200);

    const stillLocked = await fixtureReq(fixture, '/api/auth/login', {
      method: 'POST', body: { name: 'admin', passphrase: 'hunter2hunter2' },
    });
    assert.equal(stillLocked.status, 429, 'the variant’s success must not clear admin’s failure history');
  } finally {
    fixture.stop();
  }
});

test('a replay inside the rotation grace window rotates instead of killing the device', async () => {
  // Two tabs (or one refresh response lost in flight) both present the same
  // refresh token. Treating the second as theft deleted the device and signed
  // the whole browser out; inside the window it must rotate forward instead.
  const fixture = await bootFixture();
  try {
    const jar = new Jar();
    const loginRes = await fixtureReq(fixture, '/api/auth/login', {
      method: 'POST', jar,
      body: { name: 'admin', passphrase: 'hunter2hunter2', remember: true, deviceId: 'two-tabs', deviceName: 'Two tabs' },
    });
    assert.equal(loginRes.status, 200);
    const first = jar.get('sonora_refresh');
    assert.ok(first, 'the remembered device got a refresh token');

    // Tab A refreshes: the token rotates.
    jar.cookies.delete('sonora_session');
    const tabA = await fixtureReq(fixture, '/api/auth/refresh', { method: 'POST', jar, body: {} });
    assert.equal(tabA.status, 200);
    const second = jar.get('sonora_refresh');
    assert.ok(second && second !== first, 'the token rotated');
    const sessionA = jar.get('sonora_session');

    // Tab B still holds the *old* token and presents it.
    const tabB = await fixtureReq(fixture, '/api/auth/refresh', {
      method: 'POST', body: {}, headers: { cookie: `sonora_refresh=${first}` },
    });
    assert.equal(tabB.status, 200, 'a just-rotated token is a second tab, not a thief');
    const rotatedForB = tabB.res.headers.getSetCookie().find((c) => c.startsWith('sonora_refresh='));
    assert.ok(rotatedForB, 'tab B is handed a fresh token');

    // Nobody was signed out: tab A's access cookie still works and the device
    // still exists (a revoked device kills every token it issued).
    assert.equal((await fixtureReq(fixture, '/api/me', { headers: { cookie: `sonora_session=${sessionA}` } })).status, 200);
    const security = await fixtureReq(fixture, '/api/auth/security', { headers: { cookie: `sonora_session=${sessionA}` } });
    assert.equal(security.status, 200);
    assert.equal(security.body.devices.length, 1, 'the device survived the replay');
    assert.equal(security.body.devices[0].remembered, true);

    // A third presentation follows the chain again, so a tab that retries late
    // is not punished either.
    const tabC = await fixtureReq(fixture, '/api/auth/refresh', {
      method: 'POST', body: {}, headers: { cookie: `sonora_refresh=${first}` },
    });
    assert.equal(tabC.status, 200, 'the rotation chain is followed, not just one hop');
  } finally {
    fixture.stop();
  }
});

test('a blank RP ID/origin is treated as unset, and zeroed lifetimes are clamped', async () => {
  // `cp .env.example .env` shipped SONORA_RP_ID= and SONORA_ORIGIN= (present but
  // empty). `??` kept the empty string, passkeySupport() saw rpID '', and every
  // passkey ceremony answered 400 "needs a real domain" — on a real HTTPS domain.
  // SONORA_SESSION_MINUTES=0 / SONORA_REFRESH_DAYS=0 used to mint a session with
  // maxAge 0 (login 200, instantly signed out).
  const fixture = await bootFixture({
    SONORA_RP_ID: '', SONORA_ORIGIN: '',
    SONORA_SESSION_MINUTES: '0', SONORA_REFRESH_DAYS: '0',
    SONORA_TRUST_PROXY: '1',
  });
  try {
    const caps = await fixtureReq(fixture, '/api/auth/capabilities', {
      headers: { 'x-forwarded-host': `localhost:${fixture.port}`, 'x-forwarded-proto': 'https' },
    });
    assert.equal(caps.status, 200);
    assert.equal(caps.body.passkeys.supported, true, 'blank is unset: passkeys keep working');
    assert.equal(caps.body.passkeys.rpID, 'localhost', 'the request host fills the gap');
    assert.equal(caps.body.passkeys.origin, `https://localhost:${fixture.port}`);
    assert.ok(caps.body.sessionMinutes >= 1, `sessionMinutes must be clamped, got ${caps.body.sessionMinutes}`);
    assert.ok(caps.body.refreshDays >= 1, `refreshDays must be clamped, got ${caps.body.refreshDays}`);

    // And the boot log names the blank values instead of leaving them to be
    // discovered from a misleading passkey message.
    const log = fixture.logs.join('');
    assert.match(log, /SONORA_RP_ID is set but blank/);
    assert.match(log, /SONORA_ORIGIN is set but blank/);

    // A clamped session really is usable: login then /api/me in the same jar.
    const jar = new Jar();
    const login = await fixtureReq(fixture, '/api/auth/login', {
      method: 'POST', jar,
      headers: { 'x-forwarded-host': `localhost:${fixture.port}`, 'x-forwarded-proto': 'https' },
      body: { name: 'admin', passphrase: 'hunter2hunter2', remember: true, deviceId: 'clamp-browser' },
    });
    assert.equal(login.status, 200);
    assert.equal((await fixtureReq(fixture, '/api/me', { jar })).status, 200);
  } finally {
    fixture.stop();
  }
});

test('a Secure cookie is decided per request, so LAN sign-in over plain HTTP works', async () => {
  // `secure: !config.isDev` meant "a secret is configured", never "this request
  // is HTTPS". A container on a LAN serves http://192.168.x.x with a secret set,
  // so every session cookie was Secure and Chrome dropped it: login 200, then
  // /api/me 401, and the form silently reset.
  const fixture = await bootFixture({ SONORA_TRUST_PROXY: '1' });
  try {
    const lan = { 'x-forwarded-host': `192.168.1.50:${fixture.port}`, 'x-forwarded-proto': 'http' };
    const caps = await fixtureReq(fixture, '/api/auth/capabilities', { headers: lan });
    assert.equal(caps.body.cookies.secure, false, 'plain HTTP on a LAN is not a secure context');

    const login = await fetch(`${fixture.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...lan },
      body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
    });
    assert.equal(login.status, 200);
    const session = login.headers.getSetCookie().find((c) => c.startsWith('sonora_session='));
    assert.ok(session, 'a session cookie was set');
    assert.doesNotMatch(session, /;\s*secure/i,
      'a Secure cookie over plain HTTP is discarded by the browser — the login would do nothing');

    // Over the tunnel it still is Secure: this is not "never".
    const httpsCaps = await fixtureReq(fixture, '/api/auth/capabilities', {
      headers: { 'x-forwarded-host': `music.example.com`, 'x-forwarded-proto': 'https' },
    });
    assert.equal(httpsCaps.body.cookies.secure, true);
  } finally {
    fixture.stop();
  }
});

test('a blank account name falls back to the default admin and says so', async () => {
  // An empty account name cannot be typed into the sign-in form, so a blank
  // SONORA_USER (`SONORA_USER=` in a .env, or a line of spaces) keeps the
  // documented default. The alternative — creating an unreachable admin, or
  // refusing to boot over an accidental space — was the original hazard; the
  // contract now is "the app comes up and the default name is signable".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-blankuser-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'blank.db'), SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'blank-user-secret', SONORA_USER: '   ', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  try {
    let up = false;
    for (let i = 0; i < 160 && child.exitCode === null; i++) {
      try {
        const r = await fetch(`${base}/api/health`);
        const health = r.ok ? await r.json() : null;
        if (health?.pid === child.pid) { up = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, `the server must come up with a signable default name:\n${logs.join('')}`);
    assert.match(logs.join(''), /SONORA_USER is blank/,
      'a deliberately blank name is reported instead of silently ignored');
    const signedIn = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
    });
    assert.equal(signedIn.status, 200, 'the default name is the account that was created');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

test('SONORA_ORIGIN is an accepted request origin and nothing else is', async () => {
  // A TLS-terminating proxy makes the process see http://127.0.0.1 while the
  // browser sends https://music.example.com. Every mutation then looked
  // cross-site and answered 403, so the deployment could read but not act.
  const fixture = await bootFixture({ SONORA_ORIGIN: 'https://music.example.com' });
  try {
    const jar = new Jar();
    const signedIn = await fixtureReq(fixture, '/api/auth/login', {
      jar, method: 'POST',
      body: { name: 'admin', passphrase: 'hunter2hunter2', deviceId: 'csrf-origin' },
    });
    assert.equal(signedIn.status, 200);

    const read = () => fixtureReq(fixture, '/api/notifications/read', {
      jar, method: 'POST', body: {},
    });

    assert.equal((await read()).status, 200, 'no Origin header stays supported for non-browser clients');
    const sameOrigin = await fixtureReq(fixture, '/api/notifications/read', {
      jar, method: 'POST', body: {}, headers: { origin: fixture.base },
    });
    assert.equal(sameOrigin.status, 200, 'the request’s own origin is still accepted');
    const configured = await fixtureReq(fixture, '/api/notifications/read', {
      jar, method: 'POST', body: {}, headers: { origin: 'https://music.example.com' },
    });
    assert.equal(configured.status, 200, 'SONORA_ORIGIN is this deployment’s own origin');

    for (const origin of ['https://evil.example', 'https://music.example.com.evil.example',
      'http://music.example.com', 'null']) {
      const refused = await fixtureReq(fixture, '/api/notifications/read', {
        jar, method: 'POST', body: {}, headers: { origin },
      });
      assert.equal(refused.status, 403, `${origin} must not be treated as this origin`);
    }
    // Fetch Metadata still refuses a sibling-site frame outright.
    const crossSite = await fixtureReq(fixture, '/api/notifications/read', {
      jar, method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
  } finally {
    fixture.stop();
  }
});

test('a passkey can be renamed by its owner and by nobody else', async () => {
  const jar = new Jar();
  await login(jar, { remember: false, deviceId: 'passkey-rename' });
  const me = await req('/api/me', { jar });
  const adminId = me.body.user.id;

  // Registration needs a real authenticator, so the row is written directly;
  // the route under test is the rename, not the ceremony.
  const created = await req('/api/admin/users', {
    jar, method: 'POST',
    body: { name: 'passkey-other', passphrase: 'other-passphrase', role: 'user' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const otherId = created.body.user.id;
  const database = new DatabaseSync(DB);
  const now = new Date().toISOString();
  try {
    const insert = database.prepare(`
      INSERT INTO passkeys (user_id, credential_id, public_key, counter, name, created_at)
      VALUES (?, ?, 'public-key', 0, ?, ?)
    `);
    insert.run(adminId, 'rename-cred-admin', 'Laptop', now);
    insert.run(otherId, 'rename-cred-other', 'Phone', now);
  } finally {
    database.close();
  }

  const anonymous = await req('/api/auth/passkeys/1', { method: 'PATCH', body: { name: 'x' } });
  assert.equal(anonymous.status, 401);

  const blank = await req('/api/auth/passkeys/1', { jar, method: 'PATCH', body: { name: '   ' } });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /name/i);

  const missing = await req('/api/auth/passkeys/999999', { jar, method: 'PATCH', body: { name: 'Gone' } });
  assert.equal(missing.status, 404);

  const list = await req('/api/auth/passkeys', { jar });
  const mine = list.body.passkeys.find((p) => p.credentialId === 'rename-cred-admin');
  const theirs = list.body.passkeys.find((p) => p.credentialId === 'rename-cred-other');
  assert.ok(mine, 'the owner sees their passkey');
  assert.equal(theirs, undefined, 'and not someone else’s');

  const foreign = await req(`/api/auth/passkeys/${otherId}`, {
    jar, method: 'PATCH', body: { name: 'Seized' },
  });
  assert.equal(foreign.status, 404, 'an unrelated id is just not found');
  const otherRow = new DatabaseSync(DB, { readOnly: true });
  let otherPasskeyId;
  try {
    otherPasskeyId = otherRow.prepare("SELECT id FROM passkeys WHERE credential_id = 'rename-cred-other'").get().id;
  } finally {
    otherRow.close();
  }
  // The real target is another account's passkey row: renaming it must fail and
  // must leave it alone.
  const stolen = await req(`/api/auth/passkeys/${otherPasskeyId}`, {
    jar, method: 'PATCH', body: { name: 'Seized' },
  });
  assert.equal(stolen.status, 404, 'another account’s passkey is not found either');

  const renamed = await req(`/api/auth/passkeys/${mine.id}`, {
    jar, method: 'PATCH', body: { name: '  Studio laptop  ' },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.passkeys.find((p) => p.id === mine.id).name, 'Studio laptop',
    'the name is trimmed and stored');
  assert.equal(renamed.body.passkeys.some((p) => p.id === otherPasskeyId), false);
  const check = new DatabaseSync(DB, { readOnly: true });
  try {
    assert.equal(check.prepare("SELECT name FROM passkeys WHERE credential_id = 'rename-cred-other'").get().name,
      'Phone', 'the other account’s passkey was not touched');
  } finally {
    check.close();
  }
});
