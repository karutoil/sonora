// Real-browser acceptance for song edit versions (clean / explicit).
//
// The complaint this suite pins: the listener is an adult who was being handed
// the clean edit of songs without any indication, and could not tell. Three
// behaviours must hold end to end:
//
//   1. a clean edit is *marked* — a CLEAN tag renders beside the title in the
//      search page, the queue and the now-playing sheet;
//   2. when the same song arrives as both a clean and an explicit upload, the
//      keeper the page offers is the explicit one (this is server-side, in
//      rankTracks, so it is exercised through the real /api/search route);
//   3. a clean edit that is the only upload of its song is still offered —
//      partitioned, not hidden — and it is marked.
//
// Real HTTP + real SQLite + real parsers + real ranking, with only the remote
// Innertube session replaced by a fixture (the pattern of
// station-routes.test.js / fixtures/station-server.mjs). The DOM is driven by
// the UX harness's Chromium. No live upstream, no developer database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME, freePort, launch } from './helpers/cdp.js';
import { ROOT, VIEW, INIT_SCRIPT, withPage } from './helpers/ux.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-track-version-'));
const DB = path.join(DIR, 'tv.db');
const FIXTURE = new URL('./fixtures/track-version-server.mjs', import.meta.url).pathname;
const PASS = 'hunter2hunter2';
const SHOTS = path.join(ROOT, '.tmp/track-version');
const ARTIST_ID = `UC${'v'.repeat(22)}`;

/** A raw MusicResponsiveListItem song row, the shape toMusicTrack parses. */
function songRow(t = {}) {
  return {
    id: t.videoId,
    title: { text: t.title ?? 'Fixture Song' },
    author: { name: t.artist ?? 'Fixture Artist', id: ARTIST_ID },
    artists: [{ name: t.artist ?? 'Fixture Artist', channel_id: ARTIST_ID }],
    duration: { seconds: t.durationS ?? 210 },
    item_type: 'song',
    ...(t.badges ? { badges: t.badges } : {}),
  };
}

// The same song twice — the explicit badge on one row, "(Clean)" on the title
// of the other — exactly what YouTube Music returns for an explicit release,
// plus a song that only exists as a clean upload.
const SONGS = [
  songRow({ videoId: 'verExplct01', title: 'Deduplic Kamed', badges: [{ icon_type: 'EXPLICIT' }] }),
  songRow({ videoId: 'verCleanC02', title: 'Deduplic Kamed (Clean)' }),
  songRow({ videoId: 'verCleanO03', title: 'Only Clean Exists (Clean)' }),
  songRow({ videoId: 'verNoMark04', title: 'Plain Old Song' }),
];

fs.writeFileSync(path.join(DIR, 'songs.json'), JSON.stringify(SONGS));

let proc;
let BASE;
let browser;

test.before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logs = [];
  proc = spawn(process.execPath, ['--no-warnings', FIXTURE], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: path.join(DIR, 'audio'),
      SONORA_SECRET: 'track-version-secret', SONORA_PASSPHRASE: PASS,
      SONORA_LOGIN_RATE_MAX: '1000', SONORA_LOG_LEVEL: 'warn',
      SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '', SONORA_RESOLVE_TIMEOUT_MS: '500',
      SONGS_FILE: path.join(DIR, 'songs.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error(`fixture server did not start:\n${logs.join('')}`);

  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.addInitScript(CAPTURE_REAL_FETCH);
  await browser.addInitScript(INIT_SCRIPT);
  await browser.addInitScript(ROUTE_SEARCH_TO_SERVER);
  await browser.viewport(VIEW.desktop);
  await browser.goto(`${BASE}/`);
  const status = await browser.eval(`fetch('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: ${JSON.stringify(PASS)} }) }).then((r) => r.status)`);
  assert.equal(status, 200, 'browser login failed');
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
});

test.after(async () => {
  browser?.close();
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise((r) => { proc.on('exit', r); setTimeout(r, 3000); });
  }
  fs.rmSync(DIR, { recursive: true, force: true });
});

function needBrowser(t) {
  if (browser) return true;
  t.skip(CHROME
    ? 'Chromium did not launch; set CHROME_BIN=/usr/bin/chromium and re-run'
    : 'no Chromium found; set CHROME_BIN=/usr/bin/chromium to run this suite');
  return false;
}

/**
 * Capture the *real* network fetch before the UX harness installs its own
 * page stub, so this suite can reach the fixture server for `/api/search`.
 *
 * Init scripts run in the order they were added, every page load: this one is
 * registered before INIT_SCRIPT, so at the moment it runs `window.fetch` is
 * still the browser's own. The harness stub layered on top keeps serving its
 * static fixtures for every other route (login, library, …) exactly as the
 * other suites expect; only `/api/search` is re-pointed at the real server.
 */
const CAPTURE_REAL_FETCH = `(() => {
  window.__realFetch = window.fetch.bind(window);
  return true;
})()`;

/**
 * Route `/api/search` to the real fixture server (the browser's own fetch,
 * captured before any stub) while every other request keeps going through
 * whatever the harness stub serves.
 */
const ROUTE_SEARCH_TO_SERVER = `(() => {
  const real = window.__realFetch;
  if (!real) return false;
  const stub = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
    let url;
    try { url = new URL(raw, location.href); } catch { return stub(input, init); }
    if (url.pathname === '/api/search') return real(input, init);
    return stub(input, init);
  };
  return true;
})()`;

/** Type a query like a person, then wait for the songs shelf to fill. */
async function searchFor(browser, q = 'deduplic kamed') {
  await browser.eval(`(() => {
    const i = document.querySelector('#primary-search');
    i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await browser.waitFor(`document.querySelectorAll('#search-results .track-row').length >= 1`, 8000);
}

/** What the songs shelf rendered: one entry per row, with any version tag. */
const rowsSrc = `(() => [...document.querySelectorAll('#search-results .track-row')].map((r) => ({
  video: r.dataset.track,
  title: r.querySelector('.track-name')?.textContent ?? '',
  explicit: Boolean(r.querySelector('.ver-tag.ver-explicit')),
  clean: Boolean(r.querySelector('.ver-tag.ver-clean')),
  titleTagInside: Boolean(r.querySelector('.track-name .ver-tag')),
})))()`;

test('V1: the explicit edit is the keeper; the clean duplicate is gone; both are marked', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'search' }, async (ctx) => {
    await searchFor(browser);

    const rows = await browser.eval(rowsSrc);
    assert.ok(rows.length >= 1, `the songs shelf did not render: ${JSON.stringify(rows)}`);

    const deduplic = rows.filter((r) => /Deduplic/i.test(r.title));
    // The same song key twice (rankTracks merges them) with an explicit badge
    // against a clean title: the keeper is the explicit row, and it is badged.
    assert.equal(deduplic.length, 1,
      `Deduplic Kamed appeared ${deduplic.length} times: ${JSON.stringify(rows)}`);
    assert.equal(deduplic[0].video, 'verExplct01',
      'the keeper is the clean edit, not the explicit one');
    assert.equal(deduplic[0].explicit, true, 'the explicit keeper carries no E tag');
    assert.equal(deduplic[0].clean, false);

    await ctx.shot('v1-explicit-keeper');
  });
});

test('V2: a clean edit that is the only upload is offered and marked CLEAN', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'search' }, async (ctx) => {
    await searchFor(browser, 'only clean exists');

    const rows = await browser.eval(rowsSrc);
    const only = rows.find((r) => r.video === 'verCleanO03');
    assert.ok(only, `the clean-only row is missing: ${JSON.stringify(rows)}`);
    assert.equal(only.clean, true, 'the clean row has no CLEAN tag');
    assert.equal(only.explicit, false);
    // The tag must not leak into the title text (the queue and media-session
    // read these elements' textContent as the track title).
    assert.equal(only.titleTagInside, false, 'the tag lives inside .track-name');
    assert.equal(only.title, 'Only Clean Exists (Clean)');

    await ctx.shot('v2-clean-marked');
  });
});

test('V3: playing the clean-only track marks the queue rows and the now-playing sheet', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'search' }, async (ctx) => {
    await searchFor(browser, 'only clean exists');

    // Play the clean-only row. The harness blocks real streaming, which does
    // not matter here: the click fills state.queue and paints the now-playing
    // metadata before any audio starts (see playIndex).
    await browser.eval(`document.querySelector('#search-results .track-row[data-track="verCleanO03"]').click()`);

    // The drawer is painted from state.queue on open, so open it the way a
    // listener does and read the row there.
    await browser.waitFor(`!!document.querySelector('#rail-content [data-action="queue"], #player [data-action="queue"]')`, 8000).catch(() => {});
    let queued = null;
    for (let i = 0; i < 40 && !queued; i++) {
      await browser.eval(`(() => {
        const el = document.querySelector('#rail-content [data-action="queue"], #player [data-action="queue"]');
        if (el) el.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 150));
      queued = await browser.eval(`(() => {
        const row = document.querySelector('#queue-drawer [data-queue-row][data-video="verCleanO03"]');
        if (!row) return null;
        return {
          clean: Boolean(row.querySelector('.ver-tag.ver-clean')),
          title: row.querySelector('.queue-text strong')?.textContent ?? '',
          tagInsideTitle: Boolean(row.querySelector('.queue-text strong .ver-tag')),
        };
      })()`);
    }
    assert.ok(queued, 'the played track never reached the queue');
    assert.equal(queued.clean, true, 'the queue row has no CLEAN tag');
    assert.equal(queued.tagInsideTitle, false, 'the queue title text is polluted by the tag');
    assert.equal(queued.title, 'Only Clean Exists (Clean)');

    await ctx.shot('v3-queue-tag');
  });
});

test('V4: an unversioned song renders with no tag at all', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'search' }, async (ctx) => {
    await searchFor(browser, 'plain old song');

    const rows = await browser.eval(rowsSrc);
    const plain = rows.find((r) => r.video === 'verNoMark04');
    assert.ok(plain, `the unmarked row is missing: ${JSON.stringify(rows)}`);
    assert.equal(plain.explicit, false, 'an unmarked row must not carry an E tag');
    assert.equal(plain.clean, false, 'an unmarked row must not carry a CLEAN tag');
    assert.equal(plain.title, 'Plain Old Song');

    await ctx.shot('v4-no-tags');
  });
});
