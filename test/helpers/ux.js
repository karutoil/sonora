// Shared harness for the real-browser UX suite (test/ux.test.js).
//
// The suite boots its own server (temp DB) and drives headless Chromium so the
// assertions see real layout, real focus and real history. Nothing here talks
// to YouTube: fetch() inside the page is patched before app.js runs, so the
// live browse/search/lyrics endpoints are replaced with fixtures and the
// audio element never opens /api/stream/*.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { monitorProcess, stopServerProcess } from './process.js';
import { isUpstreamBotGate } from './upstream-gate.js';

export const ROOT = new URL('../..', import.meta.url).pathname;
export const SHOTS = path.join(ROOT, '.tmp/ux');

export const VIEW = {
  mobile390: { name: '390x844', width: 390, height: 844, mobile: true },
  mobile360: { name: '360x740', width: 360, height: 740, mobile: true },
  desktop: { name: '1280x900', width: 1280, height: 900, mobile: false },
};

/** Pages the mobile layout sweep has to survive (assignment item B). */
export const SWEEP_PAGES = ['home', 'search', 'library', 'radio', 'liked', 'recent', 'playlist'];

/** A fabricated track the server accepts (VIDEO_ID is 11 base64url chars). */
// A 2x2 PNG: real artwork for the seeded track, so cover rendering (and its
// failure path) can be exercised without touching the network or YouTube.
const SEED_THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYERxAAAHgACAwHlVPAAAAAASUVORK5CYII=';

export const SEED_TRACK = {
  videoId: 'dQw4w9WgXcQ',
  title: 'UX Fixture Track',
  channel: 'UX Fixture Channel',
  durationS: 214,
  thumb: SEED_THUMB,
};

// ── server ───────────────────────────────────────────────────────────────

export async function startServer({ env: extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-ux-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'ux.db'),
      SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'ux-test-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn',
      // Keep every YouTube subprocess out of the test's critical path.
      SONORA_POT_PROVIDER: '',
      SONORA_JS_RUNTIME: '',
      // Extra settings for one suite (a short queue-stream cover, so a stream
      // test does not have to wait for a night of audio).
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const monitor = monitorProcess(proc);
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  let up = false;
  for (let i = 0; i < 120 && !up && !monitor.settled; i++) {
    try { up = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!up && !monitor.settled) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    const failure = new Error(`ux test server did not start:\n${logs.join('')}`);
    try {
      await stopServerProcess(proc, monitor, {
        dir, logs, label: 'ux test server', signal: 'SIGKILL',
      });
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], 'ux server startup and cleanup both failed');
    }
    throw failure;
  }

  return {
    base,
    dir,
    logs,
    stop() {
      // The server must finish closing SQLite before its directory disappears.
      // Abnormal exits, spawn failures and failed removals remain test failures.
      return stopServerProcess(proc, monitor, { dir, logs, label: 'ux test server' });
    },
  };
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── seeding (through the real HTTP API, no UI guessing) ──────────────────

/** Log in over plain fetch and return the session cookie header. */
export async function loginCookie(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  if (!cookie) throw new Error('login returned no Set-Cookie');
  return cookie.split(';')[0];
}

export async function seedPlaylist(base) {
  const cookie = await loginCookie(base);

  const create = await fetch(`${base}/api/playlists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'UX Fixture Playlist', description: 'Seeded by test/ux.test.js' }),
  });
  if (!create.ok) throw new Error(`playlist create failed: ${create.status} ${await create.text()}`);
  const { playlist } = await create.json();

  const add = await fetch(`${base}/api/playlists/${playlist.id}/tracks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(SEED_TRACK),
  });
  if (!add.ok) throw new Error(`playlist track failed: ${add.status} ${await add.text()}`);

  // One recent play: the home page then has a playable quick-card, so overlay
  // tests do not depend on the (currently in-flux) collection route.
  const event = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      videoId: SEED_TRACK.videoId, kind: 'start', positionMs: 1000, durationMs: SEED_TRACK.durationS * 1000, source: 'home',
    }),
  });
  if (!event.ok) throw new Error(`recent-play seed failed: ${event.status} ${await event.text()}`);

  const full = await fetch(`${base}/api/playlists/${playlist.id}`, { headers: { cookie } });
  const { playlist: withTracks } = await full.json();
  if (!withTracks.tracks?.length) throw new Error('seeded playlist has no tracks');

  return { id: playlist.id, title: playlist.title, tracks: withTracks.tracks };
}

/** Seed the shared playback session (the row every device resumes from). */
export async function seedPlayerState(base, state) {
  const cookie = await loginCookie(base);
  // The API calls the queue `queue`; the GET response calls it `tracks`. Accept
  // either shape so a seed reads like the session it produces.
  const { tracks, ...rest } = state;
  const res = await fetch(`${base}/api/now`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ...rest, queue: state.queue ?? tracks ?? [], takeover: true }),
  });
  if (!res.ok) throw new Error(`player state seed failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── in-page instrumentation, installed before app.js boots ───────────────

function uxInit() {
  const ALBUMS = [
    { id: 'PLuxAlbumOne', title: 'Fixture Album One', author: 'Fixture Artist One', thumb: null },
    { id: 'PLuxAlbumTwo', title: 'Fixture Album Two', author: 'Fixture Artist Two', thumb: null },
  ];
  const ARTISTS = [
    { id: 'Fixture Artist One', title: 'Fixture Artist One', subscribers: '42 plays', thumb: null },
    { id: 'Fixture Artist Two', title: 'Fixture Artist Two', subscribers: '7 plays', thumb: null },
  ];
  // Browse-by-feeling answers with playlists (with real track counts) plus the
  // catalogue's own top songs — never with a single 4-hour video.
  const MOOD_PLAYLISTS = [
    { id: 'PLuxMoodOne', title: 'Fixture Mood Playlist', author: 'Fixture Curator', thumb: null, trackCount: 42, views: 900000 },
    { id: 'PLuxMoodTwo', title: 'Fixture Mood Playlist Two', author: 'Fixture Curator Two', thumb: null, trackCount: 18, views: 120000 },
  ];
  const MOOD_TRACKS = [
    { videoId: 'dQw4w9WgXcQ', title: 'UX Fixture Track', channel: 'UX Fixture Channel', thumb: null, durationS: 214 },
    { videoId: 'fAuT8_dboWo', title: 'Fixture Mood Track Two', channel: 'Fixture Artist', thumb: null, durationS: 180 },
  ];
  // An artist page and the release one of its songs belongs to. The album id is
  // an MPR… catalogue id, which is exactly what a real artist page returns and
  // what "open the album of this song" has to accept.
  const ARTIST_ID = 'UCuxFixtureArtist000000';
  const ALBUM_ID = 'MPRuxFixtureAlbum01';
  const ARTIST_PAGE = {
    id: ARTIST_ID,
    name: 'Fixture Artist One',
    thumb: null,
    description: 'A fixture artist used by the browser suite.',
    songs: [
      { videoId: 'dQw4w9WgXcQ', title: 'UX Fixture Track', artist: 'Fixture Artist One', channel: 'Fixture Artist One', thumb: null, durationS: 214, album: 'Fixture Album One', albumId: ALBUM_ID, itemType: 'song', official: true },
      { videoId: 'fAuT8_dboWo', title: 'Fixture Mood Track Two', artist: 'Fixture Artist One', channel: 'Fixture Artist One', thumb: null, durationS: 180, album: 'Fixture Album One', albumId: ALBUM_ID, itemType: 'song', official: true },
    ],
    albums: [{ id: ALBUM_ID, title: 'Fixture Album One', year: '2020', type: 'Album', thumb: null }],
    singles: [{ id: 'MPRuxFixtureSingle1', title: 'Fixture Single', year: '2021', type: 'Single', thumb: null }],
    videos: [{ videoId: 'uxVid0000001', title: 'Fixture Video', artist: 'Fixture Artist One', channel: 'Fixture Artist One', thumb: null, durationS: null, itemType: 'video' }],
    adjacent: [{ name: 'Fixture Neighbour', id: 'UCuxFixtureNeighbour00' }],
  };
  const ALBUM_TRACKS = [
    { videoId: 'dQw4w9WgXcQ', title: 'UX Fixture Track', artist: 'Fixture Artist One', channel: 'Fixture Artist One', thumb: null, durationS: 214, album: 'Fixture Album One', albumId: ALBUM_ID, itemType: 'song', official: true },
    { videoId: 'fAuT8_dboWo', title: 'Fixture Mood Track Two', artist: 'Fixture Artist One', channel: 'Fixture Artist One', thumb: null, durationS: 180, album: 'Fixture Album One', albumId: ALBUM_ID, itemType: 'song', official: true },
  ];
  // The pinned personal station: seeds (why) + tracks (what plays next).
  const STATION = {
    name: 'toil\u2019s station',
    blurb: 'Built from 1 song you played through and 1 song you liked.',
    seeds: [
      { videoId: 'dQw4w9WgXcQ', title: 'UX Fixture Track', channel: 'UX Fixture Channel', liked: true, score: 5 },
      { videoId: 'fAuT8_dboWo', title: 'Fixture Mood Track Two', channel: 'Fixture Artist', liked: false, score: 4 },
    ],
    tracks: [
      { videoId: 'dQw4w9WgXcQ', title: 'UX Fixture Track', channel: 'UX Fixture Channel', thumb: null, durationS: 214 },
      { videoId: 'fAuT8_dboWo', title: 'Fixture Mood Track Two', channel: 'Fixture Artist', thumb: null, durationS: 180 },
    ],
    empty: false,
  };

  const ux = { errors: [], delays: {}, dislikes: [] };
  window.__ux = ux;
  // Every top-up of the endless station, in order, so a test can assert both
  // that it happened unprompted and what it was told to exclude.
  ux.stationNext = [];
  let stationPageNo = 0;

  const realError = console.error.bind(console);
  console.error = (...args) => {
    ux.errors.push(args.map((a) => (a && a.message ? a.message : String(a))).join(' '));
    realError(...args);
  };
  window.addEventListener('error', (e) => ux.errors.push(`window.error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    ux.errors.push(`unhandledrejection: ${r?.message ?? String(r)}`);
  });

  const originalFetch = window.fetch.bind(window);
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
  const wait = (key) => new Promise((r) => setTimeout(r, ux.delays[key] || 0));

  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
    let url;
    try { url = new URL(raw, location.href); } catch { return originalFetch(input, init); }
    const p = url.pathname;
    const method = String((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase();

    if (p === '/api/browse/albums') { await wait('albums'); return json({ items: ALBUMS }); }
    if (p === '/api/browse/artists') { await wait('artists'); return json({ items: ARTISTS }); }
    if (p === '/api/browse/playlists') { await wait('playlists'); return json({ items: MOOD_PLAYLISTS }); }
    if (p === '/api/station') { await wait('station'); return json(STATION); }
    // The endless station's next page. Each call returns *new* ids so the test
    // can prove the queue grows rather than repeating what it already holds.
    if (p === '/api/station/next') {
      await wait('station-next');
      stationPageNo += 1;
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const exclude = url.searchParams.get('exclude') || '';
      ux.stationNext.push({ cursor, exclude });
      // Three per page: enough to see the runway refill, easy to count.
      const tracks = [1, 2, 3].map((n) => ({
        // 11 base64url chars, unique per page and position (the server rejects
        // anything else, and a collision would look like a duplicate track).
        videoId: `ux${String(stationPageNo).padStart(3, '0')}${n}`.padEnd(11, '0'),
        title: `Station Page ${stationPageNo} Track ${n}`,
        channel: `Station Artist ${stationPageNo}`,
        thumb: null,
        durationS: 200,
      }));
      return json({ tracks, cursor: cursor + 3, empty: false });
    }
    if (p === '/api/dislikes') {
      await wait('dislikes');
      // Writes are recorded so a test can prove the instruction reached the
      // server, and so the next read reflects it.
      if (method === 'POST') {
        const body = JSON.parse(init?.body ?? '{}');
        ux.dislikes = body.dislike
          ? [...new Set([...ux.dislikes, body.videoId])]
          : ux.dislikes.filter((id) => id !== body.videoId);
        return json({ ok: true, disliked: Boolean(body.dislike) });
      }
      return json({ tracks: ux.dislikes.map((videoId) => ({ videoId, title: 'Disliked Fixture' })) });
    }
    if (p === '/api/search') {
      await wait('search');
      const q = url.searchParams.get('q') || '';
      // A real search answers with both: the artist chip is what makes a band's
      // page reachable without knowing their channel id.
      const artists = q === 'fixture artist'
        ? [{ id: ARTIST_ID, title: 'Fixture Artist One', subscribers: '12K subscribers', thumb: null }]
        : [];
      // A catalogue row that knows its release, which is what makes the album
      // column of a track row a way into that album.
      const withAlbum = q === 'fixture album'
        ? [{
          videoId: 'dQw4w9WgXcQ', title: 'UX Fixture Track', artist: 'Fixture Artist One',
          channel: 'Fixture Artist One', thumb: null, durationS: 214,
          album: 'Fixture Album One', albumId: ALBUM_ID, itemType: 'song', official: true,
        }]
        : [];
      return json({ tracks: q === 'lofi chill' ? MOOD_TRACKS : withAlbum, artists });
    }
    if (p.startsWith('/api/artist/')) {
      await wait('artist');
      ux.artistRequests = [...(ux.artistRequests ?? []), decodeURIComponent(p.slice('/api/artist/'.length))];
      return json(ARTIST_PAGE);
    }
    // "Which release is this song from" — resolved server-side for rows that do
    // not carry an album id (up next, videos, an old queue).
    if (p.startsWith('/api/album/for/')) {
      await wait('album-for');
      return json({ albumId: ALBUM_ID, title: 'Fixture Album One', author: 'Fixture Artist One' });
    }
    if (p === '/api/radio') {
      await wait('radio');
      return json({
        tracks: [{
          videoId: 'dQw4w9WgXcQ', title: 'UX Fixture Track', channel: 'UX Fixture Channel',
          thumb: null, durationS: 214,
        }],
      });
    }
    if (p === '/api/lyrics/' || p.startsWith('/api/lyrics/')) return json({ text: null });
    if (p.startsWith('/api/album/')) {
      const id = decodeURIComponent(p.slice('/api/album/'.length));
      if (id === ALBUM_ID) {
        return json({
          title: 'Fixture Album One', author: 'Fixture Artist One', type: 'Album',
          year: '2020', thumb: null, tracks: ALBUM_TRACKS, albumId: ALBUM_ID,
        });
      }
      const pl = MOOD_PLAYLISTS.find((x) => x.id === id);
      return json(pl
        ? { title: pl.title, author: pl.author, type: 'Playlist', tracks: MOOD_TRACKS }
        : { tracks: [] });
    }
    if (method === 'GET' && /^\/api\/playlists\/\d+$/.test(p)) {
      await wait('playlist');
    }
    return originalFetch(input, init);
  };

  // No audio downloads: setting a stream src must not start a media load, and
  // play/pause are inert. The app's own state machine still runs.
  const media = HTMLMediaElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(media, 'src');
  if (srcDesc) {
    Object.defineProperty(media, 'src', {
      configurable: true,
      get() { return srcDesc.get.call(this); },
      set(value) {
        if (String(value).includes('/api/stream/')) {
          this.setAttribute('data-ux-blocked-stream', String(value));
          return;
        }
        srcDesc.set.call(this, value);
      },
    });
  }
  media.play = function play() { return Promise.resolve(); };
  media.pause = function pause() {};
  media.load = function load() {};
}

export const INIT_SCRIPT = `(${uxInit.toString()})()`;

// ── navigation ───────────────────────────────────────────────────────────

const PAGE_READY = {
  home: `!!document.querySelector('#page-root .page-title')`,
  search: `!!document.querySelector('#primary-search, .search-shell input, input[type="search"]')`,
  library: `!!document.querySelector('#page-root [data-library-tab]')`,
  radio: `!!document.querySelector('#page-root .radio-feature, #page-root .station-grid, #page-root .station')`,
  collection: `!!document.querySelector('#page-root .collection-hero, #page-root .sk, #page-root .sk-hero, #page-root .sk-grid, #page-root .sk-rows, #page-root .skeleton, #page-root [aria-busy="true"]')`,
  mood: `!!document.querySelector('#page-root .library-grid, #page-root .sk-grid, #page-root .empty-state')`,
  station: `!!document.querySelector('#page-root .station-hero, #page-root .sk-rows, #page-root .empty-state')`,
};

/** Click in-app navigation (programmatic, so hidden breakpoints still route). */
export async function nav(browser, page, opts = {}) {
  try {
    return await navStep(browser, page, opts);
  } catch (err) {
    err.message = `could not open page "${page}": ${err.message}`;
    throw err;
  }
}

async function navStep(browser, page, { playlistId } = {}) {
  if (page === 'liked' || page === 'recent') {
    await browser.eval(`document.querySelector('.sidebar [data-collection="${page}"]').click()`);
    await browser.waitFor(PAGE_READY.collection);
    await settleCollection(browser);
    return;
  }
  if (page === 'playlist') {
    const id = playlistId;
    await nav(browser, 'library');
    await browser.waitFor(
      `!!document.querySelector('#page-root [data-collection="p${id}"], #side-playlists [data-collection="p${id}"]')`,
    );
    await browser.eval(
      `document.querySelector('#page-root [data-collection="p${id}"], #side-playlists [data-collection="p${id}"]').click()`,
    );
    await browser.waitFor(PAGE_READY.collection);
    await settleCollection(browser);
    return;
  }
  if (page === 'station') {
    // The station is pinned in the sidebar rather than in the page nav.
    await browser.eval(`document.querySelector('#nav-station, [data-page="station"]').click()`);
    await browser.waitFor(PAGE_READY.station);
    return;
  }
  await browser.eval(
    `document.querySelector('#desktop-nav [data-page="${page}"], #mobile-nav [data-page="${page}"]').click()`,
  );
  await browser.waitFor(PAGE_READY[page] ?? PAGE_READY.home);
}

/** A collection route can render a skeleton first; layout sweeps want the
 *  settled page, so wait (briefly) for the hero before measuring. */
async function settleCollection(browser, timeout = 5000) {
  await browser.waitFor(`!!document.querySelector('#page-root .collection-hero')`, timeout).catch(() => {});
}

// ── page harness ─────────────────────────────────────────────────────────

/**
 * Boot a fresh app document at the requested viewport and run `fn(ctx)`.
 * Failures are prefixed with the viewport/page and leave a screenshot behind.
 */
/**
 * YouTube refuses the bare yt-dlp client (no cookies, no PO token) from some
 * IPs with a BOT_GATED 503. The browser suites that stream real audio must not
 * report a UI failure for that: they skip with the upstream reason instead, so
 * a red run always means the client regressed. The assertion itself stays
 * untouched whenever the network allows it.
 */
// A canonical id that is never part of a fixture, so the probe cannot join an
// in-flight warm of a track the page just asked for.
const PROBE_VIDEO = 'sWcLccMuCA8';

export async function skipIfUpstreamBlocked(t, base, videoId = PROBE_VIDEO) {
  const skip = (why) => {
    t.skip(`YouTube is gating this IP for the bare client (${why}); upstream, not the UI`);
    return true;
  };

  // The probe needs a session: an unauthenticated request answers 401 long
  // before YouTube is ever consulted.
  const cookie = await (async () => {
    try {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
      });
      if (!res.ok) return null;
      const raw = res.headers.getSetCookie?.() ?? [];
      const jar = raw.map((c) => c.split(';')[0]).join('; ');
      return jar || null;
    } catch {
      return null;
    }
  })();
  if (!cookie) return false;
  const headers = { range: 'bytes=0-1', cookie };

  // Fast path: a gated IP answers /api/stream with 503 BOT_GATED almost at once.
  const probe = (async () => {
    const res = await fetch(`${base}/api/stream/${videoId}`, { headers });
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      return isUpstreamBotGate(res.status, body) ? body.error : null;
    }
    return null;
  })().catch(() => null);

  const raced = await Promise.race([
    probe,
    new Promise((r) => setTimeout(() => r('timeout'), 20_000)),
  ]);
  if (raced && raced !== 'timeout') return skip(raced);

  // Slow path: the attempt did not resolve, so ask the server whether it has
  // already recorded a gate. A slow-but-working upstream stays a real failure.
  try {
    const res = await fetch(`${base}/api/status`, { headers: { cookie } });
    if (res.ok) {
      const body = await res.json();
      if (body?.botGated) return skip('the server recorded a bot gate');
    }
  } catch {}
  return false;
}

export async function withPage(browser, base, { viewport = VIEW.desktop, page = 'home', playlistId } = {}, fn) {
  await browser.viewport(viewport);
  // A cache-busting query makes each harness boot a real document load; going
  // from `/#/library` to `/` alone is a same-document fragment change in CDP
  // and would leave the app on the previous page.
  await browser.goto(`${base}/?ux=${Date.now()}`);
  await browser.waitFor(
    `!!document.querySelector('#mobile-nav button') && !!document.querySelector('.app')`,
    20_000,
  );
  // Local webfonts settle layout metrics; don't measure before they do.
  await browser.eval(`document.fonts.ready.then(() => true)`);
  const authed = await browser.eval(`document.getElementById('auth-overlay').hidden`);
  if (!authed) throw new Error('browser session is not logged in (auth overlay is showing)');
  await browser.eval(`window.__ux && (window.__ux.errors.length = 0)`);
  if (page !== 'home') await nav(browser, page, { playlistId });

  const ctx = {
    base,
    viewport,
    page,
    async errors() { return browser.eval(`(window.__ux?.errors ?? []).slice()`); },
    async clearErrors() { await browser.eval(`window.__ux && (window.__ux.errors.length = 0)`); },
    async shot(pageName = page) {
      await settleAnimations(browser).catch(() => {});
      return browser.screenshot(path.join(SHOTS, `${viewport.name}-${pageName}.png`));
    },
    async goto() {
      await browser.goto(`${base}/?ux=${Date.now()}`);
      await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
    },
  };

  try {
    return await fn(ctx);
  } catch (err) {
    try {
      await browser.screenshot(path.join(SHOTS, `${viewport.name}-${page}-FAILED.png`));
    } catch {}
    err.message = `[${viewport.name} · ${page}] ${err.message}`;
    throw err;
  }
}

/** Let entrance animations finish (capped) so screenshots are reviewable.
 *  Infinite loops (equaliser/waveform) would never finish, hence the race. */
export async function settleAnimations(browser, cap = 450) {
  await browser.eval(`(async () => {
    const running = document.getAnimations ? document.getAnimations() : [];
    await Promise.race([
      Promise.all(running.map((a) => a.finished.catch(() => {}))),
      new Promise((r) => setTimeout(r, ${cap})),
    ]);
    return true;
  })()`);
}

// ── in-page probes (stringified into Runtime.evaluate) ───────────────────

/** Layout geometry for assignment item B. */
export function layoutProbe() {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      left: Math.round(r.left * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
    };
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  const main = document.getElementById('main-scroll');
  const player = document.getElementById('player');
  const navEl = document.getElementById('mobile-nav');
  const topbar = document.getElementById('topbar');
  const root = document.getElementById('page-root');

  const chrome = {
    topbar: rect(topbar),
    nav: rect(navEl),
    player: rect(player),
    main: rect(main),
    innerWidth,
    innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    navButtons: [...navEl.querySelectorAll('button')].map((b) => ({ label: b.textContent.trim(), ...rect(b) })),
  };

  // Scroll the content column to the end: whatever is last must be reachable
  // without sitting underneath the mini player that owns the row below it.
  const before = main.scrollTop;
  main.scrollTop = main.scrollHeight;
  const mainRect = main.getBoundingClientRect();
  const children = [...root.children].filter(visible);
  const last = children.at(-1) ?? null;
  const content = {
    mainBottom: Math.round(mainRect.bottom * 10) / 10,
    lastTag: last ? `${last.tagName.toLowerCase()}.${[...last.classList].join('.')}` : null,
    lastBottom: last ? Math.round(last.getBoundingClientRect().bottom * 10) / 10 : null,
    playerTop: Math.round(player.getBoundingClientRect().top * 10) / 10,
  };
  main.scrollTop = before;

  return { ...chrome, content };
}

export const layoutProbeSrc = `(${layoutProbe.toString()})()`;

/** All visible interactive elements with their hit-box size (item C). */
export function touchTargetProbe(minSize = 44) {
  const owner = (el) => {
    const parent = el.parentElement?.closest('[class]');
    if (!parent || parent === el) return '';
    const cls = [...parent.classList].filter(Boolean)[0];
    return cls ? `${parent.tagName.toLowerCase()}.${cls} > ` : '';
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].filter(Boolean).slice(0, 3);
    if (cls.length) s += `.${cls.join('.')}`;
    const action = el.getAttribute('data-action') || el.getAttribute('data-page')
      || el.getAttribute('data-collection') || el.getAttribute('data-library-tab') || el.getAttribute('data-mood');
    if (action) s += `[${el.hasAttribute('data-action') ? 'data-action' : el.hasAttribute('data-page') ? 'data-page' : 'data'}=${action}]`;
    const label = el.getAttribute('aria-label') || el.getAttribute('title');
    if (label) s += ` "${label.slice(0, 30)}"`;
    return owner(el) + s;
  };
  const isInlineTextLink = (el) => {
    if (el.tagName !== 'A') return false;
    const display = getComputedStyle(el).display;
    return display.startsWith('inline') && el.textContent.trim().length > 0;
  };

  const seen = [];
  for (const el of document.querySelectorAll('button, [role="button"], input[type="range"], a')) {
    if (el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (Number(cs.opacity) === 0) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    if (isInlineTextLink(el)) continue;

    seen.push({
      sel: describe(el),
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      ok: r.width >= minSize - 0.5 && r.height >= minSize - 0.5,
    });
  }
  seen.sort((a, b) => a.w * a.h - b.w * b.h);
  return { total: seen.length, offenders: seen.filter((x) => !x.ok) };
}

export const touchTargetProbeSrc = `(${touchTargetProbe.toString()})()`;

/** Focus order + visible ring for each focusable element (item D). */
export function focusProbe() {
  const focusables = [...document.querySelectorAll(
    'a[href], button, [role="button"], input, select, textarea, [tabindex]',
  )].filter((el) => {
    if (el.disabled) return false;
    if (el.tabIndex < 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  });

  const index = (el) => focusables.indexOf(el);
  const first = (sel) => index(focusables.find((el) => el.matches(sel)));

  const ring = (el) => {
    el.focus({ focusVisible: true });
    const cs = getComputedStyle(el);
    const outline = parseFloat(cs.outlineWidth) || 0;
    const shadow = cs.boxShadow && cs.boxShadow !== 'none';
    return {
      ring: (outline >= 2 && cs.outlineStyle !== 'none') || shadow,
      outline: `${cs.outlineWidth} ${cs.outlineStyle}`,
      boxShadow: shadow ? cs.boxShadow : 'none',
      focusVisible: el.matches(':focus-visible'),
    };
  };

  const subject = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].filter(Boolean).slice(0, 2);
    if (cls.length) s += `.${cls.join('.')}`;
    const action = el.getAttribute('data-action') || el.getAttribute('data-page');
    if (action) s += `[${el.hasAttribute('data-action') ? 'data-action' : 'data-page'}=${action}]`;
    return s;
  };

  const sampled = focusables.slice(0, 40).map((el) => ({ sel: subject(el), ...ring(el) }));
  document.activeElement?.blur();

  return {
    order: {
      nav: first('#desktop-nav button, #mobile-nav button'),
      page: first('#page-root button, #page-root a, #page-root input, #page-root [role="button"]'),
      player: first('#player button, #player input'),
      total: focusables.length,
    },
    missingRing: sampled.filter((s) => !s.ring),
    notFocusVisible: sampled.filter((s) => !s.focusVisible),
    sampled: sampled.length,
  };
}

export const focusProbeSrc = `(${focusProbe.toString()})()`;

/** Accessible-name sweep for icon-only controls (item E). */
export function nameProbe() {
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      if (text) return text;
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return '';
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].filter(Boolean).slice(0, 3);
    if (cls.length) s += `.${cls.join('.')}`;
    const action = el.getAttribute('data-action');
    if (action) s += `[data-action=${action}]`;
    return s;
  };

  const offenders = [];
  let iconOnly = 0;
  for (const el of document.querySelectorAll('button, [role="button"], a[href]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (text) continue; // has a text node, so it is not icon-only
    iconOnly += 1;
    const name = labelFor(el);
    if (!name) offenders.push(describe(el));
  }
  return { iconOnly, offenders };
}

export const nameProbeSrc = `(${nameProbe.toString()})()`;

/** Reduced-motion probe: computed animation/transition on page/card/sheet. */
export function motionProbe() {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const durations = String(cs.transitionDuration).split(',').map((d) => parseFloat(d) || 0);
    return {
      sel,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      transitionDuration: cs.transitionDuration,
      maxTransition: Math.max(0, ...durations),
      display: cs.display,
      width: Math.round(el.getBoundingClientRect().width),
    };
  };
  return {
    reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    probes: [pick('.page'), pick('.music-card'), pick('.now-modal')],
    appHeight: Math.round(document.querySelector('.app')?.getBoundingClientRect().height ?? 0),
    innerHeight,
  };
}

export const motionProbeSrc = `(${motionProbe.toString()})()`;


// ── small actions with readable failures ─────────────────────────────────

/** Click the first matching element, or fail naming what was expected. */
export async function click(browser, selectors, label) {
  const hit = await browser.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selectors)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!hit) throw new Error(`no element matched ${JSON.stringify(selectors)}${label ? ` (${label})` : ''}`);
}

/**
 * Put a track in the player without touching the network: the seeded recent
 * play renders a home quick-card wired to data-track. Falls back to any
 * data-track / play-track control on the current page.
 */
export async function startTrack(browser, timeout = 5000) {
  await browser.waitFor(
    `!!document.querySelector('#page-root [data-track], #page-root [data-action="play-track"]')`, timeout,
  ).catch(() => {});
  let clicked = await browser.eval(`(() => {
    const el = document.querySelector('#page-root [data-track], #page-root [data-action="play-track"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) {
    await nav(browser, 'library');
    clicked = await browser.eval(`(() => {
      const el = document.querySelector('#page-root [data-collection="liked"]');
      if (el) el.click();
      return !!el;
    })()`);
  }
  if (!clicked) throw new Error('no track control was available to start playback');
  await browser.waitFor(`!!document.querySelector('#player [data-action="heart"], #player .player-like, #player [data-action="nowplaying"]')`, timeout);
}

/** Open the now-playing sheet from whatever trigger the current shell renders.
 *  Prefers a focusable trigger (button/[role=button]/[tabindex]) because focus
 *  restoration can only be asserted when the trigger can actually hold focus. */
export async function openNowPlaying(browser, timeout = 5000) {
  const trigger = await browser.eval(`(() => {
    const all = [...document.querySelectorAll('#rail-content [data-action="nowplaying"], #player [data-action="nowplaying"], [data-action="nowplaying"]')];
    if (!all.length) return false;
    const el = all.find((x) => x.matches('button, [role="button"], [tabindex]')) ?? all[0];
    el.focus({ focusVisible: true });
    el.click();
    window.__uxTrigger = el;
    return true;
  })()`);
  if (!trigger) throw new Error('no now-playing trigger (data-action="nowplaying") exists in the shell');
  await browser.waitFor(`!document.getElementById('now-overlay').hidden`, timeout);
}
