// A real Android phone, as far as Chromium can be made to believe it.
//
// There is no Android emulator on this box (no /dev/kvm, no CAP_MKNOD), so the
// device is reproduced at the layer that actually decides what the app sees:
// the renderer. Everything a phone reports to a PWA — the Android Chrome user
// agent and its `navigator.userAgentData`, a 412×915 dp viewport at DPR 2.625,
// five touch points with `pointer: coarse` / `hover: none`, status-bar and
// gesture-bar safe-area insets, `display-mode: standalone` for an installed
// app, Android's dark theme — is set through CDP before the first byte of
// document is parsed, so `app.css`, `pwa.js` and `media-session.js` boot into
// the same environment they get on a Pixel.
//
// Two things this cannot reproduce, and the suite must not pretend otherwise:
//   * the Android *notification shade* rendering the media session (the layer
//     below that — the browser's own MediaSession state — is verified for real),
//   * audio focus arbitration with another app (a call, Maps).
// Both are called out in docs/pwa-device-audit.md.

import { spawnSync } from 'node:child_process';
import { CHROME } from './cdp.js';

/** The Chromium this repository tests against, as the UA's Chrome version. */
function chromeVersion() {
  try {
    const out = spawnSync(CHROME, ['--version'], { encoding: 'utf8' }).stdout || '';
    const m = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
    if (m) return m[1];
  } catch {}
  return '156.0.0.0';
}

export const CHROME_VERSION = chromeVersion();
const CHROME_MAJOR = CHROME_VERSION.split('.')[0];

/**
 * Device definitions. Width/height are CSS px (dp), which is what the app
 * sizes against; screenWidth/screenHeight are the same numbers because Chrome
 * on Android reports the display in dp too.
 *
 * `insets` are the real Android system bar heights: a 24 dp status bar, and
 * either a 48 dp three-button navigation bar or the ~24 dp gesture pill.
 */
export const ANDROID_DEVICES = {
  pixel8: {
    name: 'Pixel 8',
    android: '14',
    model: 'Pixel 8',
    width: 412, height: 915, dpr: 2.625,
    insets: { top: 24, bottom: 48 },
  },
  pixel5: {
    name: 'Pixel 5',
    android: '14',
    model: 'Pixel 5',
    width: 393, height: 851, dpr: 2.75,
    insets: { top: 24, bottom: 24 },
  },
  // The 360 dp density bucket most Android phones actually ship in, and the
  // smallest width Android's own layout guidance asks a phone app to survive.
  galaxy: {
    name: 'SM-G991B',
    android: '13',
    model: 'SM-G991B',
    width: 360, height: 800, dpr: 3,
    insets: { top: 24, bottom: 24 },
  },
  compact: {
    name: 'Pixel 4a',
    android: '13',
    model: 'Pixel 4a',
    width: 320, height: 640, dpr: 2,
    insets: { top: 24, bottom: 48 },
  },
  tablet: {
    name: 'Pixel Tablet',
    android: '14',
    model: 'Pixel Tablet',
    width: 800, height: 1280, dpr: 2,
    insets: { top: 24, bottom: 24 },
  },
};

export function androidUserAgent(device) {
  const d = typeof device === 'string' ? ANDROID_DEVICES[device] : device;
  return `Mozilla/5.0 (Linux; Android ${d.android}; ${d.model}) AppleWebKit/537.36 (KHTML, like Gecko) `
    + `Chrome/${CHROME_MAJOR}.0.0.0 Mobile Safari/537.36`;
}

/**
 * Make the page believe it is that phone. Call before the first navigation:
 * a user agent that changes after the app has booted is a spoof, not a device.
 *
 * `standalone` is what an installed PWA reports. It is set as the
 * `display-mode` media feature, exactly the query `pwa.js` and `app.css` read,
 * because a headless browser has no install flow to run.
 */
export async function emulateAndroid(browser, device = 'pixel8', {
  standalone = true,
  theme = 'dark',
  reducedMotion = false,
  orientation = 'portrait',
  insets = null,
} = {}) {
  const d = typeof device === 'string' ? ANDROID_DEVICES[device] : device;
  if (!d) throw new Error(`unknown Android device: ${device}`);
  const bars = insets ?? d.insets;
  const landscape = orientation === 'landscape';
  const width = landscape ? d.height : d.width;
  const height = landscape ? d.width : d.height;

  await browser.send('Emulation.setUserAgentOverride', {
    userAgent: androidUserAgent(d),
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'Linux armv8l',
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: CHROME_MAJOR }, { brand: 'Google Chrome', version: CHROME_MAJOR }],
      fullVersionList: [
        { brand: 'Chromium', version: CHROME_VERSION },
        { brand: 'Google Chrome', version: CHROME_VERSION },
      ],
      fullVersion: CHROME_VERSION,
      platform: 'Android',
      platformVersion: `${d.android}.0.0`,
      architecture: '',
      model: d.name,
      mobile: true,
      bitness: '',
      wow64: false,
      formFactors: ['Mobile'],
    },
  });
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: d.dpr, mobile: true,
    screenWidth: width, screenHeight: height,
    screenOrientation: landscape
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 },
  });
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await browser.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  await browser.send('Emulation.setSafeAreaInsetsOverride', {
    insets: {
      top: bars.top, topMax: bars.top,
      bottom: bars.bottom, bottomMax: bars.bottom,
      left: 0, leftMax: 0, right: 0, rightMax: 0,
    },
  });
  await browser.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'display-mode', value: standalone ? 'standalone' : 'browser' },
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' },
    ],
  });
  return { ...d, orientation, standalone, theme, insets: bars, width, height };
}

/** Everything the page can see about the device it thinks it is on. */
export function readDevice(browser) {
  return browser.eval(`(() => {
    const probe = (prop) => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(' + prop + ',0px)';
      document.documentElement.appendChild(d);
      const h = d.getBoundingClientRect().height;
      d.remove();
      return h;
    };
    return {
      ua: navigator.userAgent,
      platform: navigator.userAgentData?.platform ?? null,
      mobile: navigator.userAgentData?.mobile ?? null,
      model: navigator.userAgentData?.getHighEntropyValues ? null : null,
      touchPoints: navigator.maxTouchPoints,
      coarse: matchMedia('(pointer: coarse)').matches,
      fine: matchMedia('(pointer: fine)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      standalone: matchMedia('(display-mode: standalone)').matches,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      dpr: devicePixelRatio,
      width: innerWidth,
      height: innerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
      orientation: screen.orientation?.type ?? null,
      insetTop: probe('safe-area-inset-top'),
      insetBottom: probe('safe-area-inset-bottom'),
      visibility: document.visibilityState,
      appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
    };
  })()`);
}

/**
 * Put the app in the background exactly the way Android does it when the screen
 * locks: another page becomes the active one, so this one gets a real
 * `visibilitychange` to `hidden` from the browser rather than a patched
 * `document.hidden`. That distinction matters — `media-session.js` decides
 * whether to run its keep-alive from `document.visibilityState`, and a fake
 * value would be proving the fake.
 *
 * Returns handles for `foreground()`.
 */
export async function background(browser, url = 'about:blank') {
  const { targetInfo } = await browser.send('Target.getTargetInfo');
  const { targetId } = await browser.send('Target.createTarget', { url });
  await browser.send('Target.activateTarget', { targetId });
  await browser.waitFor(`document.visibilityState === 'hidden'`, 5000);
  return { app: targetInfo.targetId, other: targetId };
}

/** Bring the app back to the foreground, as unlocking the phone does. */
export async function foreground(browser, handles) {
  await browser.send('Target.activateTarget', { targetId: handles.app });
  await browser.send('Target.closeTarget', { targetId: handles.other }).catch(() => {});
  await browser.waitFor(`document.visibilityState === 'visible'`, 5000);
}

/** Chrome's own page lifecycle freeze — what a silent background tab gets. */
export const freeze = (browser) => browser.send('Page.setWebLifecycleState', { state: 'frozen' });
export const thaw = (browser) => browser.send('Page.setWebLifecycleState', { state: 'active' });

/** Network conditions: `offline`, or a slow-but-connected radio. */
export async function network(browser, mode = 'online') {
  await browser.send('Network.enable');
  const conditions = mode === 'offline'
    ? { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
    // A congested LTE cell: 400 ms RTT and ~400 kbit/s down.
    : mode === 'slow'
      ? { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 25_000 }
      : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await browser.send('Network.emulateNetworkConditions', conditions);
}

/**
 * Instrument the Media Session API before the app module can touch it.
 *
 * This is the object the OS reads — Android's media notification and Linux's
 * MPRIS both render whatever `navigator.mediaSession` holds — so recording it
 * is the closest observation of the lock screen available without the phone.
 */
export const MEDIA_SESSION_PROBE = `(() => {
  const ms = navigator.mediaSession;
  if (!ms) { window.__ms = null; return; }
  const log = (window.__ms = {
    positions: [], metadata: [], handlers: {}, handlerLog: [], playbackState: 'none',
    updates: [],
  });
  window.__msFns = {};

  const setPositionState = ms.setPositionState.bind(ms);
  ms.setPositionState = (s) => {
    log.positions.push({ duration: s.duration, position: s.position, playbackRate: s.playbackRate });
    try { return setPositionState(s); } catch (e) { log.positions.at(-1).threw = String(e); throw e; }
  };

  const setActionHandler = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (name, fn) => {
    const kind = typeof fn === 'function' ? 'fn' : null;
    log.handlers[name] = kind;
    log.handlerLog.push(name + '=' + kind);
    if (typeof fn === 'function') window.__msFns[name] = fn;
    else delete window.__msFns[name];
    return setActionHandler(name, fn);
  };

  const proto = Object.getPrototypeOf(ms);
  const meta = Object.getOwnPropertyDescriptor(proto, 'metadata');
  Object.defineProperty(ms, 'metadata', {
    configurable: true,
    get() { return meta.get.call(ms); },
    set(v) {
      log.metadata.push({
        title: v.title, artist: v.artist, album: v.album,
        artwork: [...v.artwork].map((a) => ({ src: a.src, sizes: a.sizes, type: a.type })),
      });
      log.updates.push('metadata');
      meta.set.call(ms, v);
    },
  });

  const ps = Object.getOwnPropertyDescriptor(proto, 'playbackState');
  Object.defineProperty(ms, 'playbackState', {
    configurable: true,
    get() { return ps.get.call(ms); },
    set(v) { log.playbackState = v; log.updates.push('state:' + v); ps.set.call(ms, v); },
  });
})();`;

/** Read back everything the app published to the OS. */
export function readMediaSession(browser) {
  return browser.eval(`(() => {
    const a = document.getElementById('audio');
    return {
      audio: a ? {
        paused: a.paused, currentTime: a.currentTime, duration: a.duration,
        loop: a.loop, src: a.currentSrc, readyState: a.readyState, error: a.error?.code ?? null,
      } : null,
      log: window.__ms ? {
        metadata: window.__ms.metadata,
        positions: window.__ms.positions,
        handlers: window.__ms.handlers,
        handlerLog: window.__ms.handlerLog,
        playbackState: window.__ms.playbackState,
        updates: window.__ms.updates,
      } : null,
      playbackState: navigator.mediaSession?.playbackState ?? null,
    };
  })()`);
}

/** Press a lock-screen / notification button. */
export function pressMediaAction(browser, name, details) {
  const payload = details === undefined ? '' : JSON.stringify(details);
  return browser.eval(`window.__msFns[${JSON.stringify(name)}](${payload})`);
}
