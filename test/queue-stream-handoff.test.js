import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { startServer, seedPlayerState } from './helpers/ux.js';
import { MEDIA_SESSION_PROBE } from './helpers/android.js';

// The locked-iPhone path, end to end.
//
// The device failure this covers: on a locked iPhone the page runs no script,
// so the player cannot start the next track at the end of one — the queue stops
// and nothing arrives until the app is opened again (PLAN.md finding #6 has the
// production log). The fix hands the element the *whole queue* as one
// server-built stream while the page is hidden, so the boundary happens inside
// the media resource and needs nothing from the page.
//
// What a browser can prove here, and what it cannot:
//   * it CAN prove the element is playing the queue stream, that a track
//     boundary inside that stream passes with the player never loading the next
//     track's own URL, and that coming back to the page rejoins the per-track
//     player at the track the music actually reached;
//   * it CANNOT prove iOS stops running the page. That is the platform
//     behaviour the design exists for, evidenced from the device log.
//
// The one thing this test must not let happen is the old failure passing as a
// success: a per-track auto-advance would also reach track two, so every
// assertion below checks *how* it got there — no `/api/stream/<next>` request,
// no `src` assign to it, and the element still on the queue stream.

// Short tracks on purpose: the boundary inside the stream has to arrive during
// the test, and seeking a non-seekable paced stream to it is not possible. The
// page is hidden within the first second, before the per-track player can
// advance anything by itself.
const TRACK_SECONDS = 4;
const TRACKS = [
  { videoId: 'qsx00000001', title: 'Stream One', channel: 'Fixture', durationS: TRACK_SECONDS },
  { videoId: 'qsx00000002', title: 'Stream Two', channel: 'Fixture', durationS: TRACK_SECONDS },
  { videoId: 'qsx00000003', title: 'Stream Three', channel: 'Fixture', durationS: TRACK_SECONDS },
];

const INSTRUMENT = `(() => {
  const trace = window.__streamTrace = { fetches: [], src: [], pauses: 0, plans: [] };
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try { url = String(typeof input === 'string' ? input : (input && input.url) || ''); } catch {}
    trace.fetches.push(url);
    const pending = realFetch.apply(this, arguments);
    if (url.includes('/api/client-report')) {
      try { trace.reports = trace.reports || []; trace.reports.push(JSON.parse(init && init.body)); } catch {}
    }
    if (url.includes('/api/queue-stream/plan')) {
      // The plan is part of the contract: record what was *asked for* as well as
      // what came back, because planTrackIds bakes the playback mode into the
      // request (repeat-one asks for one id, shuffle asks for a fresh order), so
      // the request is the only way a browser can see the mode a plan was built
      // for.
      try { (trace.planRequests = trace.planRequests || []).push(JSON.parse(init && init.body)); } catch {}
      // The plan is part of the contract: record what the server said, so a
      // failure says whether it was empty, refused or never armed.
      pending.then((res) => res.clone().json()
        .then((body) => trace.plans.push({ status: res.status, body }))
        .catch(() => trace.plans.push({ status: res.status })))
        .catch(() => {});
    }
    return pending;
  };
  const proto = HTMLMediaElement.prototype;
  const src = Object.getOwnPropertyDescriptor(proto, 'src');
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get() { return src.get.call(this); },
    set(value) { trace.src.push(String(value)); return src.set.call(this, value); },
  });
  const pause = proto.pause;
  proto.pause = function (...args) { trace.pauses += 1; return pause.apply(this, args); };
})();`;

// An iPhone is the one device this feature targets (public/queue-stream.js):
// report one, so the app arms the queue stream the way it does on the phone.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1';

let server;
let browser;

before(async () => {
  // A short cover keeps the stream bounded: the plan repeats until it is longer
  // than the cover, and the test only needs a few seconds of it.
  server = await startServer({ env: { SONORA_QUEUE_COVER_MS: '120000' } });
  const audioDir = path.join(server.dir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  for (let i = 0; i < TRACKS.length; i++) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${220 * (i + 1)}:duration=${TRACK_SECONDS}`,
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
      path.join(audioDir, `${TRACKS[i].videoId}.m4a`),
    ]);
  }
  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.send('Emulation.setUserAgentOverride', {
    userAgent: IPHONE_UA,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'iPhone',
    userAgentMetadata: {
      brands: [{ brand: 'Safari', version: '27' }],
      fullVersionList: [{ brand: 'Safari', version: '27.0.1' }],
      fullVersion: '27.0.1',
      platform: 'iPhone',
      platformVersion: '18.7',
      architecture: '',
      model: 'iPhone',
      mobile: true,
      bitness: '',
      wow64: false,
      formFactors: ['Mobile'],
    },
  });
  await browser.addInitScript(INSTRUMENT);
  await browser.addInitScript(MEDIA_SESSION_PROBE);
  await browser.goto(`${server.base}/`);
  const status = await browser.eval(`fetch('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
  assert.equal(status, 200);
  // Park the app before seeding so its visibility save cannot overwrite the
  // fixture while the next document is starting.
  await browser.goto('about:blank');
  await seedPlayerState(server.base, {
    tracks: TRACKS, index: 0, positionMs: 0, source: 'home', deviceId: 'stream-fixture',
  });
  await browser.goto(`${server.base}/?stream=1`);
  await browser.waitFor(`document.getElementById('audio') && document.querySelector('#player .player-song-meta strong')?.textContent === 'Stream One'`, 20_000)
    .catch(async (err) => {
      const diagnostic = await browser.eval(`({
        title: document.querySelector('#player .player-song-meta strong')?.textContent,
        authHidden: document.getElementById('auth-overlay')?.hidden,
        toast: document.getElementById('toast-text')?.textContent,
      })`);
      throw new Error(`${err.message}\n${JSON.stringify(diagnostic)}`);
    });
});

after(async () => {
  browser?.close();
  await server?.stop();
});

/** Hide or show the page the way a lock screen does, and run the handler. */
const setVisibility = (state) => browser.eval(`(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => '${state}' });
  document.dispatchEvent(new Event('visibilitychange'));
  return document.visibilityState;
})()`);

const elementState = () => browser.eval(`(() => {
  const a = document.getElementById('audio');
  return { src: a.currentSrc, time: a.currentTime, readyState: a.readyState, paused: a.paused,
    loop: a.loop, error: a.error ? { code: a.error.code, message: a.error.message } : null,
    title: document.querySelector('#player .player-song-meta strong')?.textContent };
})()`);

test('the armed plan is requested while the page is still visible', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  await browser.eval(`document.querySelector('#player .main-toggle').click()`);
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.currentTime > 0.15 && a.readyState >= 2; })()`, 20_000);
  // The plan is requested from every track start (and from `playing`), so it is
  // in hand long before the screen locks — hidden is the one moment there is no
  // time for a round trip.
  await browser.waitFor(`window.__streamTrace.fetches.some((u) => u.includes('/api/queue-stream/plan'))`, 20_000);
  const plans = await browser.eval('window.__streamTrace.plans');
  assert.equal(plans[0]?.status, 200, `the server refused the plan: ${JSON.stringify(plans)}`);
  assert.equal(plans[0]?.body?.tracks?.[0]?.videoId, TRACKS[0].videoId,
    `the plan does not start with the track that is playing: ${JSON.stringify(plans[0])}`);
});

test('a hidden `playing` keeps the stream swap armed until it settles', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The regression: the `playing` handler ran enterQueueStream() — which arms
  // `switching` for the src swap it makes — and then cleared `switching` on the
  // same event. The swap's queued `pause` arrives afterwards, so with the flag
  // gone it was published as a listener pause: the lock screen showed `paused`
  // for the whole cold load, a false paused save reached /api/now, and the resume
  // watchdog raced the stream's own play.
  //
  // The page is hidden here *without* a `visibilitychange`, which is the real
  // case this handler exists for: the track started while the screen was already
  // off, so `playing` is the only event that can converge onto the stream.
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.currentTime > 0.15; })()`, 20_000);
  await browser.waitFor(`(window.__streamTrace.planRequests || []).length >= 1`, 20_000);
  await browser.eval(`Object.defineProperty(document, 'visibilityState', {
    configurable: true, get: () => 'hidden' }); 1`);
  // Everything the app publishes from here on is the evidence.
  const mark = await browser.eval(`window.__ms.updates.length`);
  await browser.eval(`document.getElementById('audio').dispatchEvent(new Event('playing'))`);

  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return a.currentSrc.includes('/live.m3u8') && !a.paused && !a.error
      && (a.readyState >= 3 || a.currentTime > 0.2); })()`, 30_000).catch(async (err) => {
    throw new Error(`${err.message}\n${JSON.stringify(await elementState())}`);
  });
  const published = await browser.eval(`window.__ms.updates.slice(${mark})`);
  assert.ok(published.includes('state:playing'),
    `the stream never republished playing: ${JSON.stringify(published)}`);
  assert.equal(published.filter((u) => u === 'state:paused').length, 0,
    `the src swap was published to the lock screen as a pause: ${JSON.stringify(published)}`);

  // Leave the stream again so the rest of the file starts where it expects to.
  await setVisibility('visible');
  await browser.waitFor(`!document.getElementById('audio').currentSrc.includes('/live.m3u8')`, 20_000);
});

test('toggling shuffle or repeat rebuilds the armed plan', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // A plan bakes the playback mode in at arm time (public/queue-stream.js):
  // repeat-one is the current track alone, shuffle is one particular order. A
  // toggle that leaves the armed plan alone therefore hands a locked phone the
  // *old* mode for the night — repeat-one armed before the toggle loops one song
  // until morning. The re-arm is the only part a browser can see, and it is the
  // part that was missing.
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && !a.currentSrc.includes('/live.m3u8'); })()`, 20_000);
  const planCount = () => browser.eval(`(window.__streamTrace.planRequests || []).length`);
  const latestPlan = () => browser.eval(`(window.__streamTrace.planRequests || []).at(-1)`);

  const before = await planCount();
  await browser.eval(`document.querySelector('#player [data-action="shuffle"]').click()`);
  await browser.waitFor(`(window.__streamTrace.planRequests || []).length > ${before}`, 10_000)
    .catch(async (err) => {
      throw new Error(`${err.message} — shuffle left the armed plan in place (no re-arm)`);
    });
  const shuffled = await latestPlan();
  assert.equal(shuffled.ids.length, TRACKS.length,
    `a shuffled re-arm must still carry the queue: ${JSON.stringify(shuffled)}`);
  assert.equal(shuffled.ids[0], TRACKS[0].videoId,
    `a shuffled plan has to start at the track that is playing: ${JSON.stringify(shuffled)}`);

  // repeat: off → all → one. Repeat-one is a single id, which is the mode the
  // plan would otherwise never switch to once armed.
  await browser.eval(`document.querySelector('#player [data-action="repeat"]').click()`);
  await browser.eval(`document.querySelector('#player [data-action="repeat"]').click()`);
  await browser.waitFor(`(window.__streamTrace.planRequests || []).some((p) => p.ids.length === 1)`, 10_000)
    .catch(async (err) => {
      const seen = await browser.eval(`window.__streamTrace.planRequests`);
      throw new Error(`${err.message} — repeat-one never reached the plan: ${JSON.stringify(seen)}`);
    });
  const repeatOne = await latestPlan();
  assert.deepEqual(repeatOne.ids, [TRACKS[0].videoId],
    `a repeat-one plan is the current track alone: ${JSON.stringify(repeatOne)}`);

  // Put the player back: these toggles are persisted preferences, and every test
  // below expects a normal queue order.
  await browser.eval(`document.querySelector('#player [data-action="repeat"]').click()`);
  await browser.eval(`document.querySelector('#player [data-action="shuffle"]').click()`);
  await browser.waitFor(`(() => { const p = (window.__streamTrace.planRequests || []).at(-1);
    return p && p.ids.length === ${TRACKS.length} && p.ids[0] === ${JSON.stringify(TRACKS[0].videoId)}; })()`, 10_000);
  const restored = await latestPlan();
  assert.deepEqual(restored.ids, TRACKS.map((x) => x.videoId),
    `the queue order was not restored for the tests below: ${JSON.stringify(restored)}`);
});

test('a hidden page plays the queue as one stream and crosses a track inside it', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  const pausesBefore = await browser.eval('window.__streamTrace.pauses');
  assert.equal(await setVisibility('hidden'), 'hidden');

  const startedUpperBound = Date.now() + 20_000;
  let started;
  do {
    started = await elementState();
    if (started.src.includes('/api/queue-stream/') && started.readyState >= 2 && started.time > 0.1) break;
    if (started.error) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < startedUpperBound);
  if (!started.src.includes('/api/queue-stream/')) {
    const reports = await browser.eval('window.__streamTrace.reports || []');
    const srcs = await browser.eval('window.__streamTrace.src.slice(-6)');
    throw new Error(`the page never entered the queue stream: ${JSON.stringify(started)}
reports: ${JSON.stringify(reports)}
srcs: ${JSON.stringify(srcs)}`);
  }
  assert.equal(started.error, null, `the stream failed: ${JSON.stringify(started)}`);
  assert.equal(started.paused, false, `the stream never started: ${JSON.stringify(started)}`);
  assert.ok(started.readyState >= 2, `the stream never loaded: ${JSON.stringify(started)}`);
  // A swap on the way into the background must not pause the old source: on a
  // locked phone a pause is where iOS takes the audio session away.
  assert.equal(await browser.eval('window.__streamTrace.pauses'), pausesBefore,
    'entering the queue stream paused the element');
  const streamTime = started.time;

  // Now the boundary the stream owns: the first track ends TRACK_SECONDS in.
  // Nothing in the page is allowed to advance the queue — no next-track URL is
  // fetched, no next-track src is assigned, and the element stays on the
  // stream. Playback itself has to keep going past it.
  await browser.waitFor(`(() => {
    const a = document.getElementById('audio');
    return a.currentTime > ${TRACK_SECONDS + 0.4} && !a.paused && !a.error;
  })()`, 20_000)
    .catch(async (err) => {
      throw new Error(`${err.message}\n${JSON.stringify(await elementState())}`);
    });

  const after = await browser.eval(`(() => ({
    src: document.getElementById('audio').currentSrc,
    time: document.getElementById('audio').currentTime,
    fetchedNext: window.__streamTrace.fetches.filter((u) => u.includes('/api/stream/qsx00000002')),
    assignedNext: window.__streamTrace.src.filter((u) => u.includes('/api/stream/qsx00000002')),
  }))()`);
  assert.ok(streamTime < TRACK_SECONDS, `the test started past the boundary: ${streamTime}`);
  assert.ok(after.src.includes('/api/queue-stream/'),
    `the player left the queue stream at the boundary: ${JSON.stringify(after)}`);
  assert.deepEqual(after.fetchedNext, [],
    `the boundary was handled by the per-track player, not the stream: ${JSON.stringify(after)}`);
  assert.deepEqual(after.assignedNext, [],
    `the boundary was handled by the per-track player, not the stream: ${JSON.stringify(after)}`);
  // The mapping follows the stream: while the page is awake it names the track
  // the stream has reached, so the UI does not claim the previous song for the
  // next four minutes.
  assert.equal((await elementState()).title, 'Stream Two');
});

test('a page that is already hidden converges onto a plan that arrives later', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The device failure this covers: the screen locked *before* the plan for the
  // track that was starting had arrived, so the lock transition found nothing to
  // enter. iOS keeps a locked audio page running for a while, so the page must
  // converge onto the stream as soon as a plan exists — not only at the moment
  // of locking.
  await setVisibility('hidden');
  await browser.eval(`document.querySelector('#player [aria-label="Next song"]')?.click()`);
  await browser.waitFor(`document.getElementById('audio').currentSrc.includes('/api/queue-stream/')`, 20_000)
    .catch(async (err) => {
      const diagnostic = await browser.eval(`(() => { const a = document.getElementById('audio');
        return { src: a.currentSrc, paused: a.paused, rs: a.readyState,
          srcs: window.__streamTrace.src.slice(-4),
          plans: window.__streamTrace.plans }; })()`);
      throw new Error(`${err.message}\n${JSON.stringify(diagnostic)}`);
    });
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && !a.error && (a.readyState >= 3 || a.currentTime > 0.2); })()`, 20_000);
  const state = await elementState();
  assert.ok(state.src.includes('/api/queue-stream/'), `not on the stream: ${JSON.stringify(state)}`);
  assert.equal(state.error, null, `the converged stream failed: ${JSON.stringify(state)}`);
  assert.equal(state.paused, false, `the converged stream is paused: ${JSON.stringify(state)}`);
});

test('a lock-screen seek moves the playhead inside the stream', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The device failure this covers: a seek left the stream, and the hidden
  // convergence re-entered it at the *old* playhead (the element's clock had
  // not moved yet), undoing the seek; once the page suspended, seeks died
  // outright. A seek must stay inside the stream.
  await setVisibility('hidden');
  await browser.waitFor(`document.getElementById('audio').currentSrc.includes('/live.m3u8')`, 20_000);
  const before = await browser.eval(`document.getElementById('audio').currentSrc`);
  await browser.eval(`window.__msFns.seekto({ seekTime: 2 })`);
  await browser.waitFor(`(() => {
    const src = document.getElementById('audio').currentSrc;
    return src.includes('/live.m3u8') && src !== ${JSON.stringify(before)};
  })()`, 20_000).catch(async (err) => {
    const d = await browser.eval(`({ src: document.getElementById('audio').currentSrc,
      paused: document.getElementById('audio').paused })`);
    throw new Error(`${err.message}\n${JSON.stringify(d)}`);
  });
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && !a.error && (a.readyState >= 3 || a.currentTime > 0.2); })()`, 20_000);
  const after = await browser.eval(`(() => { const a = document.getElementById('audio');
    return { src: a.currentSrc, paused: a.paused, rs: a.readyState }; })()`);
  assert.match(after.src, /live\.m3u8\?at=\d+&k=\d+/, `seek left the stream: ${after.src}`);
  assert.equal(after.paused, false, 'the seek paused playback');
  // The lock screen's bar describes the track, and the seek landed at 2 s of it.
  const pos = await browser.eval(`window.__ms.positions.at(-1)?.position`);
  assert.ok(Math.abs(pos - 2) < 1.5, `lock-screen position after seek: ${pos}`);
  await setVisibility('visible');
  await browser.waitFor(`!document.getElementById('audio').currentSrc.includes('/live.m3u8')`, 20_000);
  const track = await browser.eval(`(() => { const a = document.getElementById('audio');
    return { t: a.currentTime, paused: a.paused }; })()`);
  assert.ok(Math.abs(track.t - 2) < 2.5, `rejoin lost the seek: ${JSON.stringify(track)}`);
});

test('coming back to the page rejoins the per-track player where the music got to', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  const streamedFor = (await elementState()).time;
  assert.equal(await setVisibility('visible'), 'visible');
  await browser.waitFor(`document.getElementById('audio').currentSrc.includes('/api/stream/qsx00000002')`, 20_000)
    .catch(async (err) => {
      throw new Error(`${err.message}\n${JSON.stringify(await elementState())}\n${JSON.stringify(await browser.eval('window.__streamTrace.src.slice(-4)'))}`);
    });
  const rejoined = await elementState();
  assert.equal(rejoined.title, 'Stream Two');
  assert.equal(rejoined.paused, false, `the rejoin did not start playing: ${JSON.stringify(rejoined)}`);
  // The stream had reached `streamedFor` seconds, i.e. this far into track two;
  // the rejoin must land there, not restart the song and not jump to its end.
  const expected = Math.max(0, Math.min(TRACK_SECONDS, streamedFor - TRACK_SECONDS));
  assert.ok(Math.abs(rejoined.time - expected) < 1.5,
    `the rejoin landed at ${rejoined.time}s, expected about ${expected}s: ${JSON.stringify(rejoined)}`);
  // Back on the per-track player, the element loops again: that is what ends a
  // track for this player.
  assert.equal(rejoined.loop, true, `the loop flag was not restored: ${JSON.stringify(rejoined)}`);
});

test('an app switch that takes the audio resumes without any event', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The reported failure: switching to another app took the audio output, the
  // element ended up paused while the page stayed hidden, and the music never
  // came back. Nothing could observe it — no `visibilitychange` (the listener
  // never returned), no Audio Session `statechange` (another app grabbing the
  // output is not always classified as an interruption), and a paused element
  // fires no `timeupdate`. Only the periodic check while hidden can notice.
  assert.equal(await setVisibility('visible'), 'visible');
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && !a.currentSrc.includes('/live.m3u8'); })()`, 20_000);

  await setVisibility('hidden');
  await browser.waitFor(`document.getElementById('audio').currentSrc.includes('/live.m3u8')`, 20_000);
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.currentTime > 0.2; })()`, 20_000);

  // The platform takes the output: the element pauses with no user gesture and
  // no interruption event.
  await browser.eval(`document.getElementById('audio').pause()`);
  await browser.waitFor(`document.getElementById('audio').paused === true`, 10_000);
  const silent = await elementState();
  assert.equal(silent.paused, true, 'arrangement failed: the element is still playing');

  // The watchdog runs every 10 s; it must put the music back on its own.
  await browser.waitFor(`document.getElementById('audio').paused === false`, 25_000).catch(async (err) => {
    throw new Error(`${err.message} — a hidden page whose audio was taken away never resumed\n`
      + `${JSON.stringify(await elementState())}`);
  });
  const resumed = await elementState();
  assert.equal(resumed.paused, false, 'the music did not come back');
  assert.ok(!resumed.error, `the resume produced an error: ${JSON.stringify(resumed.error)}`);
  assert.equal(resumed.loop, false, 'the stream must not be looping the plan timeline');
});


test('the watchdog never restarts music the listener paused on purpose', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The other half of the app-switch fix: a periodic resume that cannot tell a
  // platform interruption from a deliberate pause would start the music again
  // seconds after the listener stopped it — on a locked phone, with no way to
  // see why. A lock-screen pause sets `userPause`, and that is the one signal
  // that must win.
  // The previous test left the page playing (or paused mid-recovery), so start
  // from whatever it is rather than assuming a click means "play".
  await setVisibility('visible');
  await browser.eval(`(() => { const a = document.getElementById('audio');
    if (!a.paused) return true;               // already playing: leave it alone
    document.querySelector('#player .main-toggle').click();
    return false;
  })()`);
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.currentTime > 0.2; })()`, 20_000);
  await setVisibility('hidden');
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && (a.currentSrc.includes('/live.m3u8') || a.currentTime > 0.2); })()`, 20_000);

  // Pause from the lock screen, the way a listener does it.
  await browser.eval(`window.__msFns.pause()`);
  await browser.waitFor(`document.getElementById('audio').paused === true`, 10_000);

  // Outlive the 10 s watchdog tick and a couple more.
  await new Promise((r) => setTimeout(r, 13_000));
  const still = await elementState();
  assert.equal(still.paused, true, `a deliberate pause was undone: ${JSON.stringify(still)}`);
  assert.equal(await browser.eval(`window.__ms.playbackState`), 'paused',
    'the lock screen must keep saying paused');
});

// Last on purpose: it stops playback for good.
test('the OS stop action hard-stops and takes the widget away', async (t) => {
  if (!browser) return t.skip('no chromium available; set CHROME_BIN to enable');
  // The reported failure: after the player gave up on a queue of failing tracks
  // the element was merely paused, so the Now Playing widget kept advertising a
  // live player for a song that would never start. The OS's own stop action has
  // the same shape, and `none` is the only playback state that asks the OS to
  // take the widget away.
  await setVisibility('visible');
  await browser.eval(`(() => { const a = document.getElementById('audio');
    if (a.paused) document.querySelector('#player .main-toggle').click(); return 1; })()`);
  await browser.waitFor(`(() => { const a = document.getElementById('audio');
    return !a.paused && a.currentTime > 0.2; })()`, 20_000);
  assert.equal(await browser.eval(`typeof window.__msFns.stop`), 'function',
    'no stop action was registered, so the widget can never reach `none`');

  await browser.eval(`window.__msFns.stop()`);
  await browser.waitFor(`document.getElementById('audio').paused === true`, 10_000);
  assert.equal(await browser.eval(`window.__ms.playbackState`), 'none',
    'a hard stop must publish `none`, not `paused`');
  // The element's own `pause` event lands one task later; `none` has to survive
  // it, or the widget the stop just removed comes straight back.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await browser.eval(`window.__ms.playbackState`), 'none',
    'the pause event after a stop resurrected the widget');
  assert.equal(await browser.eval(`document.getElementById('audio').loop`), true,
    'leaving the stream must restore the per-track loop flag');
});
