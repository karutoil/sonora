import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { startServer, seedPlayerState } from './helpers/ux.js';

// A deterministic, real-audio counterpart to the locked-iPhone handoff tests.
// No YouTube and no synthetic `timeupdate`: the media element reaches its own
// loop boundary, just as it does on the phone. Chromium cannot reproduce every
// WebKit session-policy bug, but it can prove the native event ordering and
// that each replacement source reaches `playing` without a natural `ended`.

const TRACKS = [
  { videoId: 'hndf0000001', title: 'Handoff One', channel: 'Fixture', durationS: 6 },
  { videoId: 'hndf0000002', title: 'Handoff Two', channel: 'Fixture', durationS: 6 },
  { videoId: 'hndf0000003', title: 'Handoff Three', channel: 'Fixture', durationS: 6 },
];

// Record calls as well as events. A queued `pause` event alone cannot prove
// that pause() happened before the source assignment in the wrap handler.
const INSTRUMENT = `(() => {
  const trace = window.__handoffTrace = { active: null, categories: [], ended: 0 };
  const media = HTMLMediaElement.prototype;
  const src = Object.getOwnPropertyDescriptor(media, 'src');
  Object.defineProperty(media, 'src', {
    configurable: true,
    get() { return src.get.call(this); },
    set(value) {
      trace.active?.push({ op: 'src', value: String(value) });
      return src.set.call(this, value);
    },
  });
  const pause = media.pause;
  media.pause = function (...args) {
    trace.active?.push({ op: 'pause', value: this.currentSrc });
    return pause.apply(this, args);
  };
  const play = media.play;
  media.play = function (...args) {
    trace.active?.push({ op: 'play', value: this.currentSrc });
    return play.apply(this, args);
  };
  document.addEventListener('ended', (event) => {
    if (event.target instanceof HTMLMediaElement) trace.ended += 1;
  }, true);
  let category = 'auto';
  // The interruption half of the Audio Session API. Chromium has no such API at
  // all, so the fake is also what makes the interrupted-to-active transition
  // reachable; without a state and a statechange event the recovery path is
  // dead code in every test.
  let sessionState = 'active';
  const sessionListeners = new Set();
  window.__fakeSession = {
    __set(next) {
      sessionState = next;
      for (const fn of sessionListeners) fn(new Event('statechange'));
    },
  };
  Object.defineProperty(navigator, 'audioSession', {
    configurable: true,
    value: {
      get type() { return category; },
      set type(value) {
        category = value;
        if (trace.active) {
          trace.active.push({ op: 'category', value });
          trace.categories.push(value);
        }
      },
      get state() { return sessionState; },
      addEventListener(name, fn) { if (name === 'statechange') sessionListeners.add(fn); },
      removeEventListener(name, fn) { if (name === 'statechange') sessionListeners.delete(fn); },
    },
  });
})();`;

let server;
let browser;

before(async () => {
  server = await startServer();
  const audioDir = path.join(server.dir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  for (let i = 0; i < TRACKS.length; i++) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${220 * (i + 1)}:duration=6`,
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
      path.join(audioDir, `${TRACKS[i].videoId}.m4a`),
    ]);
  }
  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.addInitScript(INSTRUMENT);
  await browser.goto(`${server.base}/`);
  const status = await browser.eval(`fetch('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
  assert.equal(status, 200);
  // Park the app before seeding so its visibility save cannot overwrite the
  // fixture while the next document is starting.
  await browser.goto('about:blank');
  await seedPlayerState(server.base, {
    tracks: TRACKS, index: 0, positionMs: 0,
    source: 'home', deviceId: 'handoff-fixture',
  });
  await browser.goto(`${server.base}/?handoff=1`);
  await browser.waitFor(`document.querySelector('#player .player-song-meta strong')?.textContent === 'Handoff One'`, 20_000)
    .catch(async (err) => {
      const diagnostic = await browser.eval(`(async () => ({
        title: document.querySelector('#player .player-song-meta strong')?.textContent,
        authHidden: document.getElementById('auth-overlay')?.hidden,
        toast: document.getElementById('toast-text')?.textContent,
        saved: await fetch('/api/now').then((r) => r.json()),
      }))()`);
      throw new Error(`${err.message}\n${JSON.stringify(diagnostic)}`);
    });
});

after(async () => {
  browser?.close();
  await server?.stop();
});

test('natural loop boundaries replace and really play every next source', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');

  await browser.eval(`document.querySelector('#player .main-toggle').click()`);
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.currentTime > 0.15 && a.readyState >= 2; })()`, 20_000);

  // Model the page state where this failure lives: iOS can relaunch the GPU
  // audio process while the tab is hidden, leaving the web-process category
  // cache saying `playback` while the fresh GPU session resolves to ambient.
  await browser.eval(`(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get() { return 'hidden'; },
    });
    return document.visibilityState;
  })()`);

  for (let i = 1; i < TRACKS.length; i++) {
    await browser.eval(`(() => {
      const trace = window.__handoffTrace;
      trace.active = [];
      trace.categories.length = 0;
      const a = document.getElementById('audio');
      a.currentTime = Math.max(0, a.duration - 0.35);
      return true;
    })()`);

    // Do not accept metadata/src alone: the iOS failure reaches exactly that
    // state and then stops. The new source must emit playback progress.
    await browser.waitFor(`(() => { const a = document.getElementById('audio');
      return a.currentSrc.includes('/api/stream/${TRACKS[i].videoId}')
        && !a.paused && a.currentTime > 0.08 && a.readyState >= 2; })()`, 20_000)
      .catch(async (err) => {
        const diagnostic = await browser.eval(`(() => { const a = document.getElementById('audio');
          return { src: a.currentSrc, paused: a.paused, time: a.currentTime,
            readyState: a.readyState, trace: window.__handoffTrace.active,
            categories: window.__handoffTrace.categories }; })()`);
        throw new Error(`${err.message}\n${JSON.stringify(diagnostic)}`);
      });

    const transition = await browser.eval(`({
      calls: window.__handoffTrace.active,
      categories: window.__handoffTrace.categories,
    })`);
    const operations = transition.calls.map((x) => x.op);
    const srcAt = operations.indexOf('src');
    const playAt = operations.indexOf('play');
    // A hidden handoff must NOT pause the old source. A pause on a backgrounded
    // phone is where iOS reclaims the audio session, and it does not give it
    // back until the listener returns to the app: the replacement plays into a
    // dead session, silently, with the Now Playing widget emptied. The manual
    // "next" path never pauses and is known-good on the device.
    assert.equal(operations.indexOf('pause'), -1,
      `track ${i} paused its old source while hidden: ${JSON.stringify(transition)}`);
    assert.ok(srcAt >= 0, `track ${i} never replaced its source: ${JSON.stringify(transition)}`);
    assert.ok(playAt > srcAt, `track ${i} did not play the replacement: ${JSON.stringify(transition)}`);
    // `claim()` cannot repair the stale cache described in audio-session.js;
    // a hidden handoff must force two real category messages before src changes.
    const beforeSrc = transition.calls.slice(0, srcAt);
    const categories = beforeSrc.filter((x) => x.op === 'category').map((x) => x.value);
    assert.deepEqual(categories, ['ambient', 'playback'],
      `track ${i} repaired the hidden audio session in the wrong place: ${JSON.stringify(transition)}`);
  }

  await browser.eval('delete document.visibilityState');
  const ended = await browser.eval('window.__handoffTrace.ended');
  assert.equal(ended, 0, 'looping should prevent a natural ended at every transition');
});

test('a visible loop boundary still pauses its old source', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The other half of the same rule: with the page on screen a pause costs
  // nothing, so the visible handoff keeps the ordering the loop workaround was
  // developed against rather than changing two things at once.
  await browser.eval(`(() => { const a = document.getElementById('audio');
    a.play().catch(() => {}); return true; })()`);
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.readyState >= 2; })()`, 20_000);
  await browser.eval(`(() => {
    const trace = window.__handoffTrace;
    trace.active = [];
    const a = document.getElementById('audio');
    a.currentTime = Math.max(0, a.duration - 0.35);
    return true;
  })()`);
  await browser.waitFor(`window.__handoffTrace.active.some((x) => x.op === 'src')`, 20_000);
  const operations = await browser.eval(`window.__handoffTrace.active.map((x) => x.op)`);
  const pauseAt = operations.indexOf('pause');
  const srcAt = operations.indexOf('src');
  assert.ok(pauseAt >= 0, `a visible handoff stopped pausing: ${JSON.stringify(operations)}`);
  assert.ok(srcAt > pauseAt, `a visible handoff replaced src before pausing: ${JSON.stringify(operations)}`);
});

test('a platform interruption ending in the background resumes the track', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The reported failure: the app is open, the phone is in another app, and an
  // interruption (a call, Maps taking the output) pauses the element. When that
  // interruption ends the listener is still in the other app, so no
  // `visibilitychange` ever fires. Before the audio-session statechange hook the
  // player stayed paused until the app was opened again — and a paused
  // background tab never advances to the next track. The Now Playing widget
  // empties out, which is what "the multimedia goes blank" looks like.
  const resumed = await browser.eval(`(async () => {
    const a = document.getElementById('audio');
    a.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const fake = window.__fakeSession;
    if (!fake) return 'no fake audio session';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    fake.__set('interrupted');
    a.pause();
    const pausedAfterInterruption = a.paused;
    fake.__set('active');
    await new Promise((r) => setTimeout(r, 1500));
    return { pausedAfterInterruption, pausedAfterResume: a.paused, time: a.currentTime };
  })()`);
  assert.notEqual(resumed, 'no fake audio session');
  assert.equal(resumed.pausedAfterInterruption, true, 'the fake interruption must pause the element');
  assert.equal(resumed.pausedAfterResume, false,
    `the player never resumed in the background: ${JSON.stringify(resumed)}`);
  assert.ok(resumed.time > 0.05, `the resumed source must produce progress: ${JSON.stringify(resumed)}`);
});
