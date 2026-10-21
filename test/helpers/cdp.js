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

export async function launch(port, { autoplayPolicy = 'no-user-gesture-required' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    // Playback is started from script, not a trusted gesture. A test that is
    // *about* the gesture passes 'document-user-activation-required' to make
    // the browser as strict as Safari.
    `--autoplay-policy=${autoplayPolicy}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let info;
  for (let i = 0; i < 100 && !info; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) info = await r.json(); } catch {}
    if (!info) await new Promise((r) => setTimeout(r, 100));
  }
  if (!info) { proc.kill('SIGKILL'); throw new Error('chromium did not start'); }

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const waiters = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method && waiters.has(m.method)) {
      for (const fn of waiters.get(m.method)) fn(m.params);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const on = (method, fn) => { if (!waiters.has(method)) waiters.set(method, []); waiters.get(method).push(fn); };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');

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
    async goto(url) {
      // A fragment-only or identical navigation fires no `Page.loadEventFired`,
      // so awaiting one there would hang forever (the app routes by hash, which
      // makes this the common case). Force a real document load instead: set
      // the URL first, then reload it.
      const current = (await S('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value;
      let sameDocument = false;
      try {
        const target = new URL(url, current);
        sameDocument = target.href.split('#')[0] === String(current).split('#')[0];
      } catch {}

      const loaded = new Promise((res) => on('Page.loadEventFired', res));
      if (sameDocument) {
        await S('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}` });
        await S('Page.reload', { ignoreCache: false });
      } else {
        await S('Page.navigate', { url });
      }
      await loaded;
    },
    // Poll instead of sleeping: the app boots from a module script, so a fixed
    // delay is a race waiting to fail on a loaded machine.
    async waitFor(expression, timeout = 10_000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        try { if (await this.eval(expression)) return; } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },
    async eval(expression) {
      const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** Escape hatch for protocol domains the helper does not wrap (WebAuthn's
     *  virtual authenticator, for one). Page-scoped, so it can drive the tab. */
    send: (method, params = {}) => S(method, params),
    close() {
      try { ws.close(); } catch {}
      proc.kill('SIGKILL');
      // Chromium is still flushing its profile when it dies; give the removal
      // a few tries instead of failing an otherwise green run.
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    },
  };
}
