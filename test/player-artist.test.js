import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { ROOT, VIEW, INIT_SCRIPT, SEED_TRACK, startServer, seedPlaylist, withPage, startTrack, openNowPlaying } from './helpers/ux.js';

// The artist name is a way, not a label: every surface that names the current
// track's artist — the player bar, the desktop now-playing rail, the sheet's
// byline — opens that artist's page (#/artist/…). The About tab already did;
// these tests pin the rest.
//
// Real Chromium against a temp DB, no YouTube: /api/artist/:id is answered
// from an in-page fixture, which also covers the seeded track's case — it
// knows only a channel *name*, and the artist route takes names too.

const SHOTS = path.join(ROOT, '.tmp/player-artist');

/** Install the artist fixture; everything else reaches the real server. */
async function stubArtist(browser) {
  await browser.eval(`(() => {
    const pass = window.fetch.bind(window);
    window.__artistCalls = 0;
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'content-type': 'application/json' },
    });
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let url;
      try { url = new URL(raw, location.href); } catch { return pass(input, init); }
      if (String(init?.method || 'GET').toUpperCase() === 'GET'
        && url.pathname.startsWith('/api/artist/')) {
        window.__artistCalls += 1;
        return json({
          name: 'Player Fixture Artist',
          thumb: null,
          description: 'A fixture artist used by test/player-artist.test.js.',
          songs: [], albums: [], singles: [], videos: [], adjacent: [],
          following: false,
        });
      }
      return pass(input, init);
    };
    return true;
  })()`);
}

let server;
let browser;
let BASE;

before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  server = await startServer();
  BASE = server.base;
  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.addInitScript(INIT_SCRIPT);
  await browser.viewport(VIEW.desktop);
  await browser.goto(`${BASE}/`);
  const status = await browser.eval(`fetch('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
  assert.equal(status, 200, 'browser login with toil/hunter2hunter2 failed');
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
  // The seeded playlist + recent play give the home page a playable quick-card.
  await seedPlaylist(BASE);
});

after(async () => {
  browser?.close();
  await server?.stop();
});

function needBrowser(t) {
  if (browser) return true;
  t.skip(CHROME
    ? 'Chromium did not launch; set CHROME_BIN=/usr/bin/chromium and re-run'
    : 'no Chromium found; set CHROME_BIN=/usr/bin/chromium to run this suite');
  return false;
}

const ARTIST_HASH = `#/artist/${encodeURIComponent(SEED_TRACK.channel)}`;

test('the player bar artist name opens the artist page', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'home' }, async (ctx) => {
    await stubArtist(browser);
    await startTrack(browser);

    const bar = await browser.eval(`(() => {
      const b = document.querySelector('#player .player-song-artist');
      return b ? { tag: b.tagName, action: b.dataset.action, artist: b.dataset.artist, text: b.textContent.trim() } : null;
    })()`);
    assert.ok(bar, 'the player bar renders no artist control');
    assert.equal(bar.tag, 'BUTTON', 'the artist name is a real button, not a span');
    assert.equal(bar.action, 'artist', 'the artist name does not carry data-action="artist"');
    assert.equal(bar.artist, SEED_TRACK.channel,
      `the bar points at ${JSON.stringify(bar.artist)} instead of the track's artist`);
    assert.equal(bar.text, SEED_TRACK.channel);

    await browser.eval(`document.querySelector('#player .player-song-artist').click()`);
    await browser.waitFor(`location.hash === ${JSON.stringify(ARTIST_HASH)}`, 5000);
    await browser.waitFor(`!!document.querySelector('#page-root .artist-hero h1')`, 8000);
    assert.equal(await browser.eval(`document.querySelector('#page-root .artist-hero h1')?.textContent?.trim()`),
      'Player Fixture Artist', 'the bar landed somewhere other than the artist page');

    assert.deepEqual(await ctx.errors(), []);
  });
});

test('the bar keeps keyboard access: the title opens the sheet, the artist is its own stop', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'home' }, async (ctx) => {
    await stubArtist(browser);
    await startTrack(browser);

    const stops = await browser.eval(`(() => {
      const title = document.querySelector('#player .player-song-meta strong[role="button"]');
      const artist = document.querySelector('#player .player-song-artist');
      return {
        title: title ? { action: title.dataset.action, tabindex: title.tabIndex } : null,
        artist: artist ? { action: artist.dataset.action, tag: artist.tagName } : null,
      };
    })()`);
    assert.ok(stops.title, 'the song title is not a role="button"');
    assert.equal(stops.title.tabindex, 0, 'the song title is not a tab stop (it should open the sheet)');
    assert.equal(stops.title.action, 'nowplaying', 'the title lost its open-the-sheet action');
    assert.ok(stops.artist, 'the artist name is not a button');
    assert.equal(stops.artist.action, 'artist');

    // Enter on the focused title must still open the now-playing sheet: the
    // block stopped being a <button>, so this is the keydown handler's
    // role="button" path doing its job.
    await browser.eval(`(() => {
      const b = document.querySelector('#player .player-song-meta strong[role="button"]');
      b.focus();
      b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await browser.waitFor(`!document.getElementById('now-overlay').hidden`, 3000);
    await browser.eval(`document.getElementById('now-overlay').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await browser.waitFor(`document.getElementById('now-overlay').hidden`, 3000);

    // And the artist button navigates from the keyboard focus position too.
    await browser.eval(`document.querySelector('#player .player-song-artist').click()`);
    await browser.waitFor(`location.hash === ${JSON.stringify(ARTIST_HASH)}`, 5000);

    assert.deepEqual(await ctx.errors(), []);
  });
});

test('the desktop now-playing rail artist name opens the artist page', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'home' }, async (ctx) => {
    await stubArtist(browser);
    await startTrack(browser);

    const rail = await browser.eval(`(() => {
      const b = document.querySelector('#rail-content .rail-artist');
      return b ? { tag: b.tagName, action: b.dataset.action, artist: b.dataset.artist, text: b.textContent.trim() } : null;
    })()`);
    assert.ok(rail, 'the now-playing rail renders no artist control at desktop width');
    assert.equal(rail.tag, 'BUTTON');
    assert.equal(rail.action, 'artist');
    assert.equal(rail.artist, SEED_TRACK.channel);

    await browser.eval(`document.querySelector('#rail-content .rail-artist').click()`);
    await browser.waitFor(`location.hash === ${JSON.stringify(ARTIST_HASH)}`, 5000);
    await browser.waitFor(`!!document.querySelector('#page-root .artist-hero h1')`, 8000);

    assert.deepEqual(await ctx.errors(), []);
  });
});

test('the now-playing sheet byline opens the artist page and closes the sheet', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'home' }, async (ctx) => {
    await stubArtist(browser);
    await startTrack(browser);
    await openNowPlaying(browser);

    const byline = await browser.eval(`(() => {
      const b = document.querySelector('#now-content .byline-link');
      return b ? { tag: b.tagName, action: b.dataset.action, artist: b.dataset.artist, text: b.textContent.trim() } : null;
    })()`);
    assert.ok(byline, 'the sheet byline is not an artist link');
    assert.equal(byline.tag, 'BUTTON');
    assert.equal(byline.action, 'artist');
    assert.equal(byline.artist, SEED_TRACK.channel);

    await browser.eval(`document.querySelector('#now-content .byline-link').click()`);
    await browser.waitFor(`location.hash === ${JSON.stringify(ARTIST_HASH)}`, 5000);
    // Navigating out of a sheet dismisses it — the same contract the About
    // tab's artist link already follows (app.js, case 'artist').
    await browser.waitFor(`document.getElementById('now-overlay').hidden`, 3000);

    assert.deepEqual(await ctx.errors(), []);
  });
});
