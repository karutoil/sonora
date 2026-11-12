import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

// A 60-line CDP client is enough to drive headless Chromium for the tests that
// a static grep cannot cover: real layout with real safe-area insets, and the
// Media Session object a locked phone actually reads.

export const CHROME = process.env.CHROME_BIN || ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  .find((bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0);

/** A free port, so a leftover run can never poison this one. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Crashed runs (a killed test process, a browser that outlived its harness)
// leave their --user-data-dir profile behind in /tmp; one full-suite run
// accumulated ~548 sonora-cdp-* directories that way. Before creating this
// run's profile, sweep the ones older than a day — they cannot belong to a live
// run, and a crashed browser holds no locks worth respecting anymore. Purely
// best-effort: any error here must never fail a launch.
export function sweepStaleProfiles(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('sonora-cdp-')) continue;
      const stale = path.join(os.tmpdir(), name);
      try {
        if (fs.statSync(stale).mtimeMs < cutoff) {
          fs.rmSync(stale, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      } catch {}
    }
  } catch {}
}

/** Protocol errors that mean the page/target is gone and no command can ever
 *  succeed again (seen verbatim from lockscreen.test.js during a full run). */
const DETACHED_RE = /Not attached to an active page|Target closed|Session closed|target closed/i;

function withDeadline(promise, timeoutMs, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'CDP_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

export async function launch(port, {
  autoplayPolicy = 'no-user-gesture-required',
  // Tests can inject a hung Runtime.evaluate without waiting twenty seconds.
  commandTimeout = 20_000,
  launchTimeout = 15_000,
  // Launch a real app window at this URL instead of a tab. `--app` is the only
  // way to get a *genuine* `display-mode: standalone` report in Chromium (the
  // Emulation.setEmulatedMedia override does not reach that feature), which is
  // exactly what an installed PWA on a phone reports. The window's target
  // already exists, so this attaches to it rather than creating one.
  app = null,
  /** Extra environment for the browser, applied after the two variables below
   *  are stripped (the OS media-service tests need a session bus back). */
  extraEnv = null,
} = {}) {
  for (const [name, value] of [['commandTimeout', commandTimeout], ['launchTimeout', launchTimeout]]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  }
  if (!CHROME) throw new Error('no Chromium found; set CHROME_BIN to run browser tests');
  sweepStaleProfiles();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cdp-'));
  // Strip the session bus and Qt's accessibility opt-in.
  //
  // With DBUS_SESSION_BUS_ADDRESS + QT_ACCESSIBILITY=1 inherited, a fresh
  // headless Chromium takes **25 s** to answer its first HTTP request: it opens
  // the a11y bus on the session bus and blocks on a timeout before the network
  // stack serves anything. Measured on this box with plain `chromium --dump-dom`
  // against a bare http.server, so it is not this harness: 25.4 s inherited vs
  // 0.4 s with the two variables removed. Every suite launches its own browser,
  // so that timeout was most of the total test run. Nothing here needs the
  // session bus (no MPRIS, no a11y, no portal), so it is dropped deliberately.
  const env = { ...process.env };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.QT_ACCESSIBILITY;
  Object.assign(env, extraEnv ?? {});
  let proc;
  try {
    proc = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
      // Playback is started from script, not a trusted gesture. A test that is
      // *about* the gesture passes 'document-user-activation-required' to make
      // the browser as strict as Safari.
      `--autoplay-policy=${autoplayPolicy}`,
      ...(app ? [`--app=${app}`, `--window-size=412,915`] : ['about:blank']),
    ], { stdio: 'ignore', env, detached: true });
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw error;
  }

  let id = 0;
  let ws;
  let transportFailure = null;
  let processFailure = null;
  let exitOutcome = null;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const pending = new Map();
  const waiters = new Map();

  const failTransport = (cause) => {
    if (transportFailure) return;
    transportFailure = cause instanceof Error ? cause : new Error(String(cause));
    transportFailure.cdpDetached = true;
    for (const { rej, timer } of pending.values()) {
      clearTimeout(timer);
      rej(transportFailure);
    }
    pending.clear();
    for (const entries of waiters.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timer);
        entry.rej(transportFailure);
      }
    }
    waiters.clear();
  };
  const settleExit = (code, signal) => {
    if (exitOutcome) return;
    exitOutcome = { code, signal };
    resolveExit(exitOutcome);
    failTransport(new Error(`cdp: Chromium exited (${signal ? `signal ${signal}` : `code ${code}`})`));
  };
  // A missing executable is an event, not a synchronous throw from spawn().
  // Listening immediately prevents an unhandled `error`, and launch failure
  // below still goes through the same process/profile cleanup path.
  proc.once('error', (error) => {
    processFailure = new Error(`cdp: could not launch Chromium: ${error.message}`, { cause: error });
    failTransport(processFailure);
    if (proc.pid === undefined) settleExit(null, null);
  });
  proc.once('exit', settleExit);

  let cleanupPromise;
  const close = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      failTransport(new Error('cdp: browser closed'));
      try { ws?.close(); } catch {}
      if (!exitOutcome && proc.pid !== undefined) {
        // Kill the process group, not just the browser's main process: the
        // zygote/renderers otherwise survive and retain the profile.
        try { process.kill(-proc.pid, 'SIGKILL'); }
        catch { try { proc.kill('SIGKILL'); } catch {} }
      }
      if (!exitOutcome) await withDeadline(exited, 5000, 'cdp: Chromium did not exit within 5000 ms');
      // Do not unlink a live browser's profile. On both ordinary close and a
      // failed launch/attach, deletion happens only after the terminal exit.
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return cleanupPromise;
  };
  const failLaunch = async (error) => {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Chromium launch and cleanup both failed');
    }
    throw error;
  };

  let launchApi;
  try {
    const launchDeadline = Date.now() + launchTimeout;
    let info;
    while (!info && Date.now() < launchDeadline) {
      if (processFailure) throw processFailure;
      if (exitOutcome) throw new Error(`cdp: Chromium exited before DevTools opened (${JSON.stringify(exitOutcome)})`);
      const remaining = launchDeadline - Date.now();
      try {
        // Each readiness request is bounded too; otherwise one stalled fetch can
        // outlive the nominal launch deadline indefinitely.
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(1000, remaining))),
        });
        if (r.ok) info = await r.json();
      } catch {}
      if (!info && Date.now() < launchDeadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, launchDeadline - Date.now()))));
      }
    }
    if (!info?.webSocketDebuggerUrl) throw new Error('chromium did not expose a DevTools socket before the launch deadline');

    ws = new WebSocket(info.webSocketDebuggerUrl);
    await withDeadline(new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('cdp: could not connect to the browser DevTools socket'));
      ws.onclose = () => reject(new Error('cdp: DevTools socket closed during setup'));
    }), Math.min(commandTimeout, 5000), 'cdp: DevTools socket setup timed out');

    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); }
      catch (error) {
        failTransport(new Error('cdp: invalid DevTools response', { cause: error }));
        try { ws.close(); } catch {}
        return;
      }
      if (message.id && pending.has(message.id)) {
        const { res, rej, timer } = pending.get(message.id);
        clearTimeout(timer);
        pending.delete(message.id);
        if (!message.error) { res(message.result); return; }
        // Target teardown is unrecoverable; waitFor() rethrows it immediately.
        const detached = DETACHED_RE.test(String(message.error.message));
        const error = new Error(detached ? `cdp: page detached (${message.error.message})` : message.error.message);
        if (detached) error.cdpDetached = true;
        rej(error);
      } else if (message.method && waiters.has(message.method)) {
        const entries = [...waiters.get(message.method)];
        waiters.delete(message.method);
        // One-shot only. A navigation listener retained after completion used to
        // accumulate forever and could resolve a later navigation by accident.
        for (const entry of entries) {
          clearTimeout(entry.timer);
          entry.res(message.params);
        }
      }
    };
    ws.onerror = () => failTransport(new Error('cdp: DevTools socket error'));
    ws.onclose = () => failTransport(new Error('cdp: DevTools socket closed'));

    const send = (method, params = {}, sessionId, timeout = commandTimeout) => {
      if (transportFailure) return Promise.reject(transportFailure);
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`cdp: socket is not open for ${method}`));
      return new Promise((res, rej) => {
        const mid = ++id;
        const timer = setTimeout(() => {
          pending.delete(mid);
          const error = new Error(`cdp: ${method} timed out after ${timeout} ms`);
          error.code = 'CDP_TIMEOUT';
          rej(error);
        }, timeout);
        pending.set(mid, { res, rej, timer });
        try { ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(mid);
          rej(error);
        }
      });
    };
    const waitForEvent = (method, timeout = commandTimeout) => {
      if (transportFailure) return { promise: Promise.reject(transportFailure), cancel() {} };
      let entry;
      const promise = new Promise((res, rej) => {
        const timer = setTimeout(() => {
          waiters.get(method)?.delete(entry);
          if (!waiters.get(method)?.size) waiters.delete(method);
          const error = new Error(`cdp: ${method} timed out after ${timeout} ms`);
          error.code = 'CDP_TIMEOUT';
          rej(error);
        }, timeout);
        entry = { res, rej, timer };
        if (!waiters.has(method)) waiters.set(method, new Set());
        waiters.get(method).add(entry);
      });
      return {
        promise,
        cancel() {
          if (!waiters.get(method)?.has(entry)) return;
          clearTimeout(entry.timer);
          waiters.get(method).delete(entry);
          if (!waiters.get(method).size) waiters.delete(method);
          entry.res(undefined);
        },
      };
    };

    // An `--app` window is already open: wait for its target and attach to it.
    // (A fresh tab would be a browser-display page, not the installed app.)
    const appTarget = async () => {
      const deadline = Date.now() + launchTimeout;
      while (Date.now() < deadline) {
        const { targetInfos } = await send('Target.getTargets');
        const pages = targetInfos.filter((info) => info.type === 'page');
        const hit = pages.find((info) => !/^about:blank$/i.test(info.url)) ?? pages[0];
        if (hit) return hit.targetId;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`cdp: the app window never exposed a page target for ${app}`);
    };
    let targetId = app
      ? await appTarget()
      : (await send('Target.createTarget', { url: 'about:blank' })).targetId;
    let { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

    let reattaching = null;
    const reattach = async () => {
      if (reattaching) return reattaching;
      reattaching = (async () => {
        try {
          const { targetInfos } = await send('Target.getTargets');
          const pages = (targetInfos ?? []).filter((info) => info.type === 'page');
          const hit = pages.find((info) => info.targetId === targetId) ?? pages[0];
          if (!hit) {
            const created = await send('Target.createTarget', { url: 'about:blank' });
            targetId = created.targetId;
          } else {
            targetId = hit.targetId;
          }
          const attached = await send('Target.attachToTarget', { targetId, flatten: true });
          sessionId = attached.sessionId;
          await send('Page.enable', {}, sessionId);
          await send('Runtime.enable', {}, sessionId);
        } finally {
          reattaching = null;
        }
      })();
      return reattaching;
    };

    const S = async (method, params, timeout) => {
      try {
        return await send(method, params, sessionId, timeout);
      } catch (err) {
        if (DETACHED_RE.test(String(err?.message)) && ws?.readyState === WebSocket.OPEN && !exitOutcome) {
          await reattach();
          return await send(method, params, sessionId, timeout);
        }
        throw err;
      }
    };
    await S('Page.enable');
    await S('Runtime.enable');

    // Scoped to the return object below through this closure.
    launchApi = { send: S, waitForEvent, close };
  } catch (error) {
    // Target.createTarget/attachToTarget and Page/Runtime.enable are deliberately
    // inside this scope: partial attachment used to leak Chromium and its dir.
    await failLaunch(error);
  }

  const { send: S, waitForEvent, close: killAndCleanup } = launchApi;
  return {
    /** Runs before every future document loads — the only way to instrument
     *  globals (navigator.mediaSession) before the app module touches them.
     *  Returns a disposer: scripts accumulate across a session, so a test that
     *  needs to *stop* emulating a device must remove its own. */
    async addInitScript(source) {
      const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source });
      return () => S('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
    },
    async iphone({ width, height, top, bottom }) {
      await S('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 3, mobile: true, screenWidth: width, screenHeight: height,
      });
      await S('Emulation.setSafeAreaInsetsOverride', {
        insets: { top, topMax: top, bottom, bottomMax: bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 },
      });
      await S('Emulation.setEmulatedMedia', {
        features: [{ name: 'display-mode', value: 'standalone' }, { name: 'prefers-color-scheme', value: 'dark' }],
      });
    },
    /** Generic device emulation for layout/a11y sweeps. `reducedMotion` opts
     *  into prefers-reduced-motion:reduce; `standalone` reports an installed
     *  PWA. Existing screens keep their own insets (iphone()), so this resets
     *  them to 0 to keep runs deterministic. */
    async viewport({ width, height, mobile = false, standalone = false, reducedMotion = false } = {}) {
      await S('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: mobile ? 3 : 1, mobile, screenWidth: width, screenHeight: height,
      });
      await S('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 0, topMax: 0, bottom: 0, bottomMax: 0, left: 0, leftMax: 0, right: 0, rightMax: 0 },
      });
      const features = [
        { name: 'display-mode', value: standalone ? 'standalone' : 'browser' },
        { name: 'prefers-color-scheme', value: 'dark' },
      ];
      if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
      await S('Emulation.setEmulatedMedia', { features });
    },
    /** Capture the current viewport to a PNG (parent directories created). */
    async screenshot(file) {
      const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const out = path.resolve(file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      return out;
    },
    async goto(url, { timeout = commandTimeout } = {}) {
      // A fragment-only or identical navigation fires no `Page.loadEventFired`,
      // so force a real document load: set the URL first, then reload it. Both
      // the protocol commands and the event wait share bounded deadlines.
      const current = (await S('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, timeout)).result.value;
      let sameDocument = false;
      try {
        const target = new URL(url, current);
        sameDocument = target.href.split('#')[0] === String(current).split('#')[0];
      } catch {}

      const loaded = waitForEvent('Page.loadEventFired', timeout);
      // The command and load deadlines can expire in either order. Observe the
      // event immediately so its earlier rejection is never process-level while
      // the command is still the operation currently being awaited.
      loaded.promise.catch(() => {});
      try {
        if (sameDocument) {
          await S('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}` }, timeout);
          await S('Page.reload', { ignoreCache: false }, timeout);
        } else {
          await S('Page.navigate', { url }, timeout);
        }
      } catch (error) {
        loaded.cancel();
        // If transport loss had already rejected the event waiter, observe that
        // rejection as well as the command's rejection instead of leaking an
        // unhandled promise from this compound navigation operation.
        await loaded.promise.catch(() => {});
        throw error;
      }
      await loaded.promise;
    },
    // Poll instead of sleeping: the app boots from a module script, so a fixed
    // delay is a race waiting to fail on a loaded machine.
    async waitFor(expression, timeout = 10_000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const remaining = Math.max(1, timeout - (Date.now() - started));
        try { if (await this.eval(expression, { timeout: remaining })) return; } catch (e) {
          // An app-level exception means "not true yet, keep polling" (the page
          // may still be booting), but a detached page can never become true:
          // rethrow immediately instead of burning the whole timeout on a
          // corpse and then reporting a misleading "timed out".
          if (e?.cdpDetached) throw e;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },
    async eval(expression, { timeout = commandTimeout } = {}) {
      let r;
      try {
        r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
      } catch (error) {
        if (error?.code === 'CDP_TIMEOUT') {
          error.message += `: ${String(expression).replace(/\s+/g, ' ').slice(0, 160)}`;
        }
        throw error;
      }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** Escape hatch for protocol domains the helper does not wrap (WebAuthn's
     *  virtual authenticator, for one). Page-scoped, so it can drive the tab. */
    send: (method, params = {}) => S(method, params),
    /** Idempotent; resolves only after Chromium exits and its profile is gone. */
    close: killAndCleanup,
  };
}
