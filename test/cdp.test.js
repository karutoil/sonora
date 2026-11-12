import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { CHROME, freePort, launch } from './helpers/cdp.js';

// Failure injection, not merely a successful launch: a CDP promise must never
// strand the test runner when Chromium stops answering or the socket goes away.

test('a hung evaluation has a deadline and closing rejects pending commands', {
  skip: !CHROME && 'Chromium not installed; set CHROME_BIN to run this failure-injection check',
}, async () => {
  const browser = await launch(await freePort());
  let open = true;
  try {
    await browser.goto('data:text/html,<title>cdp-fixture</title>');
    assert.equal(await browser.eval('6 * 7'), 42);

    const started = Date.now();
    await assert.rejects(
      browser.eval('new Promise(() => {})', { timeout: 150 }),
      (error) => error.code === 'CDP_TIMEOUT' && /Runtime\.evaluate/.test(error.message),
    );
    assert.ok(Date.now() - started < 2000, 'the failure-injection deadline stayed bounded');

    // Attach the rejection assertion before deliberately closing the transport.
    const pending = browser.eval('new Promise(() => {})');
    const rejection = assert.rejects(pending, /cdp: browser closed|DevTools socket|Chromium exited/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await browser.close();
    open = false;
    await rejection;
    await assert.rejects(browser.eval('true'), /browser closed/);
    await browser.close(); // idempotent — safe for both tests and teardown
  } finally {
    if (open) await browser.close();
  }
});

test('a navigation whose document never loads rejects at its deadline', {
  skip: !CHROME && 'Chromium not installed; set CHROME_BIN to run this failure-injection check',
}, async () => {
  // Accept the request but never answer it. Page.loadEventFired therefore cannot
  // arrive; this must reject at the caller's bound rather than hang forever.
  const server = http.createServer(() => {});
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let browser;
  try {
    browser = await launch(await freePort());
    const started = Date.now();
    await assert.rejects(
      browser.goto(`http://127.0.0.1:${port}/never`, { timeout: 150 }),
      (error) => error.code === 'CDP_TIMEOUT' && /Page\.loadEventFired|Page\.navigate/.test(error.message),
    );
    assert.ok(Date.now() - started < 2000, 'the navigation deadline stayed bounded');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a Chromium that never exposes DevTools is reaped with its temporary profile', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-fake-chrome-test-'));
  const fakeChrome = path.join(fixture, 'never-ready.sh');
  fs.writeFileSync(fakeChrome, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in --user-data-dir=*) printf '%s' "\${1#*=}" > "$FAKE_CHROME_RECORD/profile" ;; esac
  shift
done
printf '%s' "$$" > "$FAKE_CHROME_RECORD/pid"
while :; do sleep 60; done
`, { mode: 0o700 });

  const probe = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, launch } from ${JSON.stringify(new URL('./helpers/cdp.js', import.meta.url).href)};
await assert.rejects(launch(await freePort(), { launchTimeout: 150, commandTimeout: 100 }), /DevTools socket/);
const record = process.env.FAKE_CHROME_RECORD;
const profile = fs.readFileSync(path.join(record, 'profile'), 'utf8');
const pid = Number(fs.readFileSync(path.join(record, 'pid'), 'utf8'));
assert.equal(fs.existsSync(profile), false, 'the failed launch removed its profile');
assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', 'the fake Chromium is gone');
`;
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '--eval', probe], {
    env: { ...process.env, CHROME_BIN: fakeChrome, FAKE_CHROME_RECORD: fixture },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(run.status, 0, `reaping probe failed:\n${run.stdout}${run.stderr}\n${run.error?.message ?? ''}`);
  fs.rmSync(fixture, { recursive: true, force: true });
});
