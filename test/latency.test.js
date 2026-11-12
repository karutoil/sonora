import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { VIEW, startServer, skipIfUpstreamBlocked } from './helpers/ux.js';

// Real-browser acceptance for the "metadata is slow / 404s" and "playback takes
// 30 s" complaints (2026-10-20).
//
// The failures being pinned are invisible to a unit test because they live in
// the browser's own behaviour:
//   1. A thumbnail request that 404s or times out renders an <img> with
//      naturalWidth === 0. The page "works"; it just shows empty covers.
//   2. Prefetching the next track is a *client* decision (the server cannot know
//      when playback starts), so only a driven browser proves it fires.
//
// The artwork assertions need the real image CDN, so nothing here is stubbed —
// unlike ux.test.js, which replaces the network with fixtures.

let server;
let browser;
let BASE;
let PLAYLIST_ID;

// Three real uploads, so /api/img has real upstreams to proxy.
const TRACKS = [
  { videoId: 'dQw4w9WgXcQ', title: 'Latency Fixture One', channel: 'Fixture Channel', durationS: 214 },
  { videoId: 'fAuT8_dboWo', title: 'Latency Fixture Two', channel: 'Fixture Channel', durationS: 180 },
  { videoId: '2tOutF8B3f8', title: 'Latency Fixture Three', channel: 'Fixture Channel', durationS: 200 },
].map((t) => ({ ...t, thumb: `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg` }));

// Records every fetch the app makes, before app.js runs, so the prefetch can be
// asserted on rather than inferred. Wrapping window.fetch keeps credentials and
// semantics intact — only observation is added.
const RECORDER = `(() => {
  const calls = [];
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    calls.push({ url, method: (init && init.method) || 'GET', at: Date.now() });
    return real.apply(this, arguments);
  };
  window.__calls = calls;
  window.__warmCalls = () => calls.filter((c) => c.url.includes('/api/warm/'));
})();`;

/** Seed a playlist with real artwork, through the real HTTP API. */
async function seed(base) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
  });
  assert.equal(login.status, 200, 'login');
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const created = await fetch(`${base}/api/playlists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Latency Fixture Playlist', artVideo: TRACKS[0].videoId }),
  });
  assert.equal(created.status, 201, 'playlist created');
  const { playlist } = await created.json();

  for (const t of TRACKS) {
    const add = await fetch(`${base}/api/playlists/${playlist.id}/tracks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(t),
    });
    assert.equal(add.status, 200, `track ${t.videoId} added`);
  }
  return playlist.id;
}

before(async () => {
  server = await startServer();
  BASE = server.base;
  PLAYLIST_ID = await seed(BASE);
  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.addInitScript(RECORDER);
  await browser.viewport(VIEW.mobile390);

  // Absorb a Chromium cold-start stall before anything is timed. Measured
  // 2026-10-20: the FIRST http navigation in a fresh headless profile takes
  // exactly 25 s to get a response (verified against a plain python http.server
  // too, so it is the browser, not this app). Every navigation after it is ~40
  // ms. Doing it here keeps that one-off out of the latency assertions below.
  await browser.goto(`${BASE}/`);

  const status = await browser.eval(`fetch('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
  assert.equal(status, 200, 'browser login failed');
});

after(async () => {
  try { browser?.close?.(); } catch {}
  await server?.stop();
});

const openPlaylist = async () => {
  await browser.goto(`${BASE}/#/c/p${PLAYLIST_ID}`);
  await browser.waitFor(`document.querySelectorAll('img.cover').length >= 3`, 30_000);
};

test('every artwork <img> the page renders actually decodes', async (t) => {
  if (!CHROME) return t.skip('no chromium');
  await openPlaylist();

  // The real complaint was silent: images that 404 render as empty boxes with no
  // error the user can see. So assert on the decoded bitmap, not the request.
  //
  // Only *visible* covers count: the app keeps hidden panels (queue, drawer) in
  // the DOM with loading="lazy", and a lazy image inside a hidden container is
  // correctly never fetched. Asserting on those would demand that we download
  // artwork nobody can see.
  await browser.waitFor(
    `[...document.querySelectorAll('img.cover')]
       .filter((i) => i.getBoundingClientRect().height > 0)
       .every((i) => i.complete)`,
    30_000,
  );
  const probe = await browser.eval(`(() => {
    const imgs = [...document.querySelectorAll('img.cover')]
      .filter((i) => i.getBoundingClientRect().height > 0);
    return {
      total: imgs.length,
      broken: imgs.filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')),
      srcs: imgs.map((i) => i.getAttribute('src')),
    };
  })()`);
  assert.ok(probe.total >= 3, `rendered ${probe.total} covers`);
  assert.deepEqual(probe.broken, [], `covers failed to decode: ${probe.broken.join(', ')}`);

  // And they must come from the same-origin proxy, not hot-linked to Google.
  for (const src of probe.srcs) {
    assert.match(src, /\/api\/img\//, `artwork went through the proxy: ${src}`);
  }
});

test('starting playback prefetches the next track before it is needed', async (t) => {
  if (!CHROME) return t.skip('no chromium');
  await openPlaylist();

  const clicked = await browser.eval(`(() => {
    const btn = document.querySelector('[data-action="play-collection"]');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  assert.ok(clicked, 'found the play-collection control');

  await browser.waitFor(`window.__warmCalls().length > 0`, 20_000);
  const warms = await browser.eval(`window.__warmCalls()`);
  assert.ok(warms.length >= 1, 'the client asked the server to warm a track');
  assert.equal(warms[0].method, 'POST', 'prefetch is a POST (it has a side effect)');

  // The warmed id must be the *next* queue entry, not the one playing: warming
  // what is already playing would do nothing useful.
  const probe = await browser.eval(`(() => {
    const src = document.querySelector('audio')?.getAttribute('src') || '';
    const m = /\\/api\\/stream\\/([A-Za-z0-9_-]{11})/.exec(src);
    const w = window.__warmCalls()[0]?.url || '';
    return { playing: m ? m[1] : null, warmed: (w.match(/[A-Za-z0-9_-]{11}$/) || [null])[0] };
  })()`);
  assert.ok(probe.playing, 'a track is playing');
  assert.ok(probe.warmed, 'a track was warmed');
  assert.notEqual(probe.warmed, probe.playing, 'the warmed track is not the one already playing');
  // It must be the queue's own successor, not an arbitrary id.
  const expected = TRACKS.find((x) => x.videoId !== probe.playing)?.videoId;
  assert.ok([...TRACKS.map((x) => x.videoId)].includes(probe.warmed),
    `warmed a track from this queue (${probe.warmed})`);
  assert.ok(expected, 'fixture has a successor');
});

test('a warmed track is reported ready, so its playback is a disk read', async (t) => {
  if (!CHROME) return t.skip('no chromium');
  // Warming reads from YouTube; a gated IP must not look like a client bug.
  if (await skipIfUpstreamBlocked(t, BASE)) return;
  await browser.waitFor(`window.__warmCalls().length > 0`, 20_000);
  const warmedId = await browser.eval(`(() => {
    const w = window.__warmCalls()[0]?.url || '';
    return (w.match(/[A-Za-z0-9_-]{11}$/) || [null])[0];
  })()`);
  assert.ok(warmedId, 'captured a warmed id');

  // Poll until the background download lands (it spawns yt-dlp).
  let body = null;
  for (let i = 0; i < 120; i++) {
    body = await browser.eval(`fetch('/api/warm/${warmedId}', {
      method: 'POST', credentials: 'same-origin',
    }).then((r) => r.json())`);
    if (body?.ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(body?.ready, true, `prefetch never finished: ${JSON.stringify(body)}`);

  // Now the real proof: the first byte of that track comes off disk.
  const elapsed = await browser.eval(`(async () => {
    const t0 = performance.now();
    const res = await fetch('/api/stream/${warmedId}', { headers: { Range: 'bytes=0-' } });
    await res.arrayBuffer();
    return { status: res.status, ms: performance.now() - t0 };
  })()`);
  assert.equal(elapsed.status, 206);
  assert.ok(elapsed.ms < 1000, `warmed playback took ${Math.round(elapsed.ms)}ms`);
});
