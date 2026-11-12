import fs from 'node:fs';

/** Observe a spawned child from the moment it is created.
 *
 * Attaching the error listener here is important: an ENOENT from spawn is an
 * asynchronous event, and otherwise it can terminate the test runner before the
 * fixture gets a chance to clean up. `done` resolves after `exit` (or directly
 * for a spawn error where no process ever existed), and never rejects by itself.
 */
export function monitorProcess(proc) {
  let error = null;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    resolveDone({ ...outcome, error });
  };

  proc.once('error', (err) => {
    error = err;
    // Node does not guarantee `exit` after a spawn failure. With no pid there is
    // no process to wait for, so the error itself is the terminal observation.
    if (proc.pid === undefined) settle({ code: null, signal: null });
  });
  proc.once('exit', (code, signal) => settle({ code, signal }));

  return {
    done,
    get error() { return error; },
    get settled() { return settled || proc.exitCode !== null || proc.signalCode !== null; },
  };
}

function waitForExit(proc, monitor, timeoutMs, label) {
  if (proc.exitCode !== null || proc.signalCode !== null || monitor.settled) return monitor.done;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([monitor.done, timeout]).finally(() => clearTimeout(timer));
}

/** Terminate a child and report abnormal exits or a refusal to terminate. */
export async function stopProcess(proc, monitor, {
  // The server allows 2.5 s for jobs and force-closes lingering HTTP clients
  // after 5 s. Ten seconds includes both plus scheduling/completion time; the
  // older five-second cutoff could escalate just as healthy shutdown finished.
  timeoutMs = 10_000,
  signal = 'SIGTERM',
  label = 'test process',
} = {}) {
  if (!monitor) throw new TypeError('stopProcess requires the monitor created when the child was spawned');

  let outcome;
  if (!monitor.settled) {
    try {
      // A false return can simply mean the exit event is queued, so wait for the
      // monitor rather than turning an already-finished process into a failure.
      proc.kill(signal);
    } catch (error) {
      throw new Error(`${label} could not be signalled with ${signal}: ${error.message}`, { cause: error });
    }
  }

  try {
    outcome = await waitForExit(proc, monitor, timeoutMs, label);
  } catch (error) {
    if (signal === 'SIGKILL') throw error;
    // Escalation cleans up the resource, but does not make a stuck graceful
    // shutdown successful. The original timeout remains the reported failure.
    try { proc.kill('SIGKILL'); } catch {}
    await waitForExit(proc, monitor, timeoutMs, `${label} after SIGKILL`);
    throw error;
  }

  if (outcome?.error) {
    throw new Error(`${label} failed: ${outcome.error.message}`, { cause: outcome.error });
  }
  if (!outcome) throw new Error(`${label} exited before its status could be observed`);
  if (outcome.code !== 0 && outcome.signal !== signal) {
    const status = outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`;
    throw new Error(`${label} exited abnormally with ${status}`);
  }
  return outcome;
}

/** Stop a fixture before removing its state, and preserve both kinds of error. */
export async function stopServerProcess(proc, monitor, {
  dir,
  logs = [],
  label = 'test server',
  ...options
} = {}) {
  let outcome;
  let failure = null;
  try {
    outcome = await stopProcess(proc, monitor, { label, ...options });
  } catch (error) {
    failure = error;
  }

  if (dir) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      const cleanup = new Error(`${label} state could not be removed: ${error.message}`, { cause: error });
      failure = failure ? new AggregateError([failure, cleanup], `${label} teardown failed`) : cleanup;
    }
  }

  if (failure) {
    const suffix = logs.length ? `\n${logs.join('')}` : '';
    if (suffix) failure.message += suffix;
    throw failure;
  }
  return outcome;
}
