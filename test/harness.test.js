import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { monitorProcess, stopServerProcess } from './helpers/process.js';
import { isUpstreamBotGate } from './helpers/upstream-gate.js';

function child(script) {
  const proc = spawn(process.execPath, ['--no-warnings', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { proc, monitor: monitorProcess(proc) };
}

test('only an explicit BOT_GATED 503 can be classified as an upstream skip', () => {
  assert.equal(isUpstreamBotGate(503, { code: 'BOT_GATED' }), true);
  for (const code of ['ENOSPC', 'BUSY', 'UPSTREAM_TIMEOUT', undefined, 'SERVER_BUG']) {
    assert.equal(isUpstreamBotGate(503, { code }), false, `503 ${code} must fail, not skip`);
  }
  for (const status of [200, 206, 429, 500, 502]) {
    assert.equal(isUpstreamBotGate(status, { code: 'BOT_GATED' }), false, `HTTP ${status} is not the stream bot-gate reply`);
  }
});

test('server state disappears only after the server has exited', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-process-fixture-'));
  fs.writeFileSync(path.join(dir, 'state'), 'in use');
  const { proc, monitor } = child('setInterval(() => {}, 1000)');
  let existedAtExit = false;
  proc.once('exit', () => { existedAtExit = fs.existsSync(dir); });

  const result = await stopServerProcess(proc, monitor, { dir, signal: 'SIGTERM', label: 'ordered fixture' });
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(existedAtExit, true, 'state was still present throughout process exit');
  assert.equal(fs.existsSync(dir), false, 'the completed teardown removed the state');
});

test('an abnormal server exit is not hidden, although its state is still removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-process-fixture-'));
  const { proc, monitor } = child('setTimeout(() => process.exit(9), 25)');
  await monitor.done;
  await assert.rejects(
    stopServerProcess(proc, monitor, { dir, label: 'broken fixture' }),
    /broken fixture exited abnormally with code 9/,
  );
  assert.equal(fs.existsSync(dir), false);
});

test('spawn failure rejects cleanup without leaving fixture state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-process-fixture-'));
  const proc = spawn(path.join(dir, 'does-not-exist'), [], { stdio: 'ignore' });
  const monitor = monitorProcess(proc);
  await monitor.done;
  await assert.rejects(stopServerProcess(proc, monitor, { dir, label: 'missing fixture' }), /missing fixture failed:/);
  assert.equal(fs.existsSync(dir), false);
});
