import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';

// The passkey path is the one part of auth that cannot be proven with HTTP
// alone: the browser has to actually sign a challenge. Chromium ships a virtual
// authenticator over CDP, so this suite registers a real credential, signs in
// with it, and then revokes it — no mocking of navigator.credentials, no
// skipping the verification the server performs.
//
// The page is loaded from http://localhost (not 127.0.0.1) because WebAuthn
// requires a secure context and a registrable RP ID: localhost qualifies, an IP
// address does not. That is also why the login screen explains the same thing
// to anyone opening the app over a LAN IP.

const ROOT = new URL('..', import.meta.url).pathname;
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-passkey-'));

let proc;
let browser;
let BASE;
const logs = [];

async function waitForHealth(base, pid) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      const health = r.ok ? await r.json() : null;
      if (health?.pid === pid) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

before(async () => {
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(DB_DIR, 'passkey.db'),
      SONORA_AUDIO_DIR: path.join(DB_DIR, 'audio'),
      SONORA_SECRET: 'passkey-test-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2', SONORA_LOGIN_RATE_MAX: '1000',
      // The tunnel case: this suite reaches the server on 127.0.0.1 but the RP
      // context is taken from the forwarded host, which only happens when the
      // proxy is trusted (off by default; see the untrusted-proxy case below).
      SONORA_TRUST_PROXY: '1',
      SONORA_LOG_LEVEL: 'warn',
      SONORA_POT_PROVIDER: '',
      SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  if (!(await waitForHealth(BASE, proc.pid))) {
    throw new Error(`server did not start:\n${logs.join('')}`);
  }

  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.viewport({ width: 1280, height: 900 });
  // A virtual authenticator with a resident key and user verification is what a
  // platform passkey (Touch ID, Windows Hello) looks like to the API.
  await browser.send('WebAuthn.enable');
  await browser.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
});

after(async () => {
  browser?.close();
  proc?.kill('SIGTERM');
  try { fs.rmSync(DB_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

function needBrowser(t) {
  if (browser) return true;
  t.skip(CHROME
    ? 'Chromium did not launch; set CHROME_BIN=/usr/bin/chromium and re-run'
    : 'no Chromium found; set CHROME_BIN=/usr/bin/chromium to run the passkey suite');
  return false;
}

const signOut = async () => {
  await browser.eval(`fetch('/api/auth/logout', { method: 'POST' }).then(() => 1)`);
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
};

// ── the passkey RP context vs. forwarded headers ───────────────────────
// These are HTTP-only checks of one narrow rule: x-forwarded-host/-proto
// decide the RP ID and origin exactly when the proxy is trusted (the tunnel
// case the headers exist for), and are ignored otherwise — otherwise a client
// that can set the header itself chooses the origin a passkey ceremony is
// bound to. The browser tests below then prove the whole ceremony works with
// the request's own host.

test('a trusted proxy’s forwarded host scopes the passkey RP context', async () => {
  // The suite's own server sets SONORA_TRUST_PROXY=1 (the tunnel case), so the
  // forwarded host is the honest RP ID. Defaulting this to *on* was the bug:
  // any client could rotate x-forwarded-for for a fresh login bucket.
  const res = await fetch(`${BASE}/api/auth/capabilities`, {
    headers: { 'x-forwarded-host': 'tunnel.example', 'x-forwarded-proto': 'https' },
  });
  const body = await res.json();
  assert.equal(body.passkeys.rpID, 'tunnel.example');
  assert.equal(body.passkeys.supported, true);
});

test('an untrusted forwarded host cannot poison the passkey RP context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-rp-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'rp.db'),
      SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'rp-test-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn',
      // The whole point: the proxy is NOT trusted, so a client-supplied
      // x-forwarded-host must not become the passkey origin.
      SONORA_TRUST_PROXY: '0',
      SONORA_POT_PROVIDER: '',
      SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  try {
    assert.ok(await waitForHealth(base, child.pid), `fixture started:\n${logs.join('')}`);
    const evil = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };

    // Capabilities must record the request's own host, not the forwarded one.
    const caps = await (await fetch(`${base}/api/auth/capabilities`, { headers: evil })).json();
    assert.equal(caps.passkeys.rpID, '127.0.0.1',
      'the RP ID is the request host, not the client-supplied forwarded host');

    // And the challenge a ceremony would bind to likewise. A raw request so
    // the Host header can be a real domain (fetch refuses to override it),
    // which lets registration options succeed and persist the row.
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
    });
    assert.ok(login.ok, `login failed: ${login.status}`);
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const call = (p, headers, body) => new Promise((resolve, reject) => {
      const req = http.request(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      }, (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.end(body);
    });
    const options = await call('/api/auth/passkey/register/options', {
      host: `localhost:${port}`, cookie, ...evil,
    }, '{}');
    assert.equal(options.status, 200, `register options failed: ${options.body}`);

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'rp.db'), { readOnly: true });
    try {
      const row = db.prepare(
        'SELECT rp_id AS rpId, origin FROM webauthn_challenges ORDER BY created_at DESC LIMIT 1',
      ).get();
      assert.ok(row, 'the challenge row exists');
      assert.equal(row.rpId, 'localhost', 'the ceremony binds to the request host');
      // The origin keeps the request's port; only the RP ID is the bare host.
      assert.equal(row.origin, `http://localhost:${port}`);
      assert.ok(!`${row.rpId} ${row.origin}`.includes('evil'),
        'the forwarded host never reaches the ceremony');
    } finally {
      db.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

test('the login screen explains passkeys and offers a remember-me choice', async (t) => {
  if (!needBrowser(t)) return;
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 20_000);
  // Capabilities arrive asynchronously; wait for the passkey button to appear
  // rather than racing the fetch.
  await browser.waitFor(`!document.getElementById('auth-passkey').hidden`, 10_000);

  assert.equal(await browser.eval(`document.getElementById('auth-remember').checked`), true,
    'remember-me defaults on');
  assert.match(await browser.eval(`document.getElementById('auth-remember-note').textContent`), /30 days/);
  assert.equal(await browser.eval(`document.getElementById('auth-name').value`), '',
    'the name field is not prefilled with a guessed account');

  // Reveal/hide is a real toggle, not a second field.
  await browser.eval(`document.querySelector('[data-action="toggle-pass"]').click()`);
  assert.equal(await browser.eval(`document.getElementById('auth-pass').type`), 'text');
  await browser.eval(`document.querySelector('[data-action="toggle-pass"]').click()`);
  assert.equal(await browser.eval(`document.getElementById('auth-pass').type`), 'password');
});

test('a wrong passphrase reports the server message and keeps the screen open', async (t) => {
  if (!needBrowser(t)) return;
  await browser.eval(`document.getElementById('auth-name').value = 'toil'`);
  await browser.eval(`document.getElementById('auth-pass').value = 'not-the-passphrase'`);
  await browser.eval(`document.getElementById('auth-form').requestSubmit()`);
  await browser.waitFor(`document.getElementById('auth-err').textContent.length > 0`, 10_000);
  assert.equal(await browser.eval(`document.getElementById('auth-err').textContent`), 'Wrong name or passphrase.');
  assert.equal(await browser.eval(`document.getElementById('auth-overlay').hidden`), false,
    'a failed sign-in must not dismiss the form');
  assert.equal(await browser.eval(`document.getElementById('auth-submit').disabled`), false,
    'the button is usable again after a failure');
});

test('signing in with remember-me persists a refresh cookie', async (t) => {
  if (!needBrowser(t)) return;
  await browser.eval(`document.getElementById('auth-pass').value = 'hunter2hunter2'`);
  await browser.eval(`document.getElementById('auth-form').requestSubmit()`);
  await browser.waitFor(`document.getElementById('auth-overlay').hidden`, 20_000);

  const cookies = (await browser.send('Network.getAllCookies')).cookies
    .filter((c) => c.domain.includes('localhost'));
  const refresh = cookies.find((c) => c.name === 'sonora_refresh');
  assert.ok(refresh, 'a remembered device gets a refresh cookie');
  assert.ok(refresh.expires > 0, 'the refresh cookie is persistent, not session-scoped');
  assert.equal(refresh.httpOnly, true);
  assert.equal(refresh.sameSite, 'Lax');
});

test('a passkey can be registered from Account & security', async (t) => {
  if (!needBrowser(t)) return;
  await browser.goto(`${BASE}/#/security`);
  await browser.waitFor(`!!document.querySelector('[data-action="passkey-add"]')`, 20_000);
  assert.match(await browser.eval(`document.querySelector('.sec-card-body .sec-empty').textContent`), /No passkeys yet/);

  await browser.eval(`document.querySelector('[data-action="passkey-add"]').click()`);
  // Registration is: options -> navigator.credentials.create -> verify. All
  // three have to succeed for a row to appear.
  await browser.waitFor(`!!document.querySelector('[data-action="passkey-remove"]')`, 25_000);

  const name = await browser.eval(`document.querySelector('.sec-row .sec-name').textContent`);
  assert.match(name, /passkey/i);

  const list = await browser.eval(`fetch('/api/auth/passkeys').then((r) => r.json())`);
  assert.equal(list.passkeys.length, 1);
  assert.equal(list.passkeys[0].backedUp, false, 'a virtual platform authenticator is single-device');
  assert.ok(list.passkeys[0].credentialId);
});

test('a passkey signs you in without a passphrase', async (t) => {
  if (!needBrowser(t)) return;
  await signOut();

  await browser.waitFor(`!document.getElementById('auth-passkey').hidden`, 10_000);
  await browser.eval(`document.querySelector('[data-action="passkey-login"]').click()`);
  await browser.waitFor(`document.getElementById('auth-overlay').hidden`, 25_000);

  const me = await browser.eval(`fetch('/api/me').then((r) => r.json())`);
  assert.equal(me.user.name, 'toil');
  assert.ok(me.user.hasPasskeys, 'the session reports that a passkey exists');
});

test('a synced (backed-up) passkey is not refused after its stored counter moves', async (t) => {
  if (!needBrowser(t)) return;
  // A passkey in iCloud Keychain or Google Password Manager re-derives its
  // signature counter on a new device. @simplewebauthn/server throws when the
  // counter fails to advance, and the app's own monotonic check could never run
  // (the library threw first), so the effective rule was `<=` with no exemption
  // for synced credentials: the one passkey a user owns worked today and stopped
  // working permanently, with no audit entry. A backed-up credential must not be
  // held to a monotonic counter.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(DB_DIR, 'passkey.db'));
  try {
    db.prepare('UPDATE passkeys SET backed_up = 1, counter = 500').run();
  } finally {
    db.close();
  }

  await signOut();
  await browser.waitFor(`!document.getElementById('auth-passkey').hidden`, 10_000);
  await browser.eval(`document.querySelector('[data-action="passkey-login"]').click()`);
  await browser.waitFor(`document.getElementById('auth-overlay').hidden`, 25_000);

  const me = await browser.eval(`fetch('/api/me').then((r) => r.json())`);
  assert.equal(me.user.name, 'toil', 'the synced passkey still signs in');

  // The stored counter is still updated from the response, so a later
  // single-device regression is still visible; `backed_up` follows the last
  // assertion's report (a virtual authenticator is single-device).
  const list = await browser.eval(`fetch('/api/auth/passkeys').then((r) => r.json())`);
  assert.equal(list.passkeys.length, 1);

  // The clone alarm is not raised for a synced credential — the whole point of
  // mapping the library's own counter error instead of replacing it.
  const auditLog = await browser.eval(`fetch('/api/admin/audit?limit=50').then((r) => r.json())`);
  assert.ok(Array.isArray(auditLog.entries));
  assert.equal(auditLog.entries.filter((e) => e.action === 'passkey_replay').length, 0,
    'a backed-up credential is not reported as a cloned one');

  // Leave the row in a state the rest of the suite can use (updatePasskeyUse
  // keeps the counter monotonic, and this assertion is not about that).
  const reset = new DatabaseSync(path.join(DB_DIR, 'passkey.db'));
  try {
    reset.prepare('UPDATE passkeys SET backed_up = 1, counter = 0').run();
  } finally {
    reset.close();
  }
});

test('the devices list marks this device and can sign out everywhere', async (t) => {
  if (!needBrowser(t)) return;
  await browser.goto(`${BASE}/#/security`);
  await browser.waitFor(`!!document.querySelector('.sec-row.is-current')`, 20_000);

  const current = await browser.eval(`document.querySelector('.sec-row.is-current .sec-tags').textContent`);
  assert.match(current, /This device/);
  assert.match(current, /Remembered/);

  // "Sign out everywhere" is destructive, so it goes through the confirm sheet.
  await browser.eval(`document.querySelector('[data-action="signout-all"]').click()`);
  await browser.waitFor(`!!document.querySelector('[data-action="confirm-form"]')`, 10_000);
  await browser.eval(`document.querySelector('[data-action="confirm-form"]').click()`);

  await browser.waitFor(`!document.getElementById('auth-overlay').hidden`, 25_000);
  const me = await browser.eval(`fetch('/api/me').then((r) => r.status)`);
  assert.equal(me, 401, 'signing out everywhere ends this session too');
});

test('a revoked passkey can no longer sign in', async (t) => {
  if (!needBrowser(t)) return;
  // Sign back in with the passphrase, remove the passkey, then confirm the
  // server has nothing left to authenticate against.
  await browser.eval(`document.getElementById('auth-name').value = 'toil'`);
  await browser.eval(`document.getElementById('auth-pass').value = 'hunter2hunter2'`);
  await browser.eval(`document.getElementById('auth-form').requestSubmit()`);
  await browser.waitFor(`document.getElementById('auth-overlay').hidden`, 20_000);

  await browser.goto(`${BASE}/#/security`);
  await browser.waitFor(`!!document.querySelector('[data-action="passkey-remove"]')`, 20_000);
  await browser.eval(`document.querySelector('[data-action="passkey-remove"]').click()`);
  await browser.waitFor(`!!document.querySelector('[data-action="confirm-form"]')`, 10_000);
  await browser.eval(`document.querySelector('[data-action="confirm-form"]').click()`);
  await browser.waitFor(`!!document.querySelector('.sec-card-body .sec-empty')`, 15_000);

  const list = await browser.eval(`fetch('/api/auth/passkeys').then((r) => r.json())`);
  assert.deepEqual(list.passkeys, []);

  const options = await browser.eval(`fetch('/api/auth/passkey/login/options', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then((r) => r.json())`);
  assert.equal(options.options.allowCredentials, undefined,
    'with no registered credentials the server must not name an account');
});
