import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
