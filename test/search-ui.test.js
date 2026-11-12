import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import { ROOT, VIEW, INIT_SCRIPT, startServer, withPage, settleAnimations } from './helpers/ux.js';

// Real-browser acceptance for the search shelves and the follow control.
//
// Two things must never be asserted here against the live network:
//
//  1. `/api/search` hits YouTube, so its answer is stubbed in the page with a
//     fixture of the *pinned* shape (see docs/ui.md / the shared brief) while
//     every other request still reaches the real server. That keeps the test
//     deterministic and offline-safe, and it is also what makes "the filter did
//     not refetch" observable: the stub counts its own calls.
//  2. `/api/artist/:id`, the follow endpoints and the collection fetch are
//     stubbed for the same reason (a real artist page is an upstream call).
//
// Everything else — boot, routing, rendering, focus, layout — is the real app
// against its own temp DB, so a run can never disturb ~/projects/muse-pwa/data.

const SHOTS = path.join(ROOT, '.tmp/search-ui');

// The narrowest viewport the spec cares about (docs/ux-spec.md §5). VIEW has
// 360 as its narrowest phone, and this file needs the 320 floor.
const NARROW = { name: '320x568', width: 320, height: 568, mobile: true };

// ── fixtures ─────────────────────────────────────────────────────────────

const ARTIST_ID = 'UCfxFixtureArtist000001'; // a real channel-id shape
const ALBUM_ONE = 'MPRfxAlbum0001';
const ALBUM_TWO = 'MPRfxAlbum0002';
const PLAYLIST_ONE = 'PLfxPlaylist001';
const PLAYLIST_TWO = 'PLfxPlaylist002';

const track = (videoId, title) => ({
  videoId, title, channel: 'Fixture Artist One', channelId: ARTIST_ID,
  durationS: 214, thumb: null, album: 'Fixture Album One', albumId: ALBUM_ONE,
  itemType: 'song',
});

const SEARCH = {
  q: 'fixture',
  tracks: [track('dQw4w9WgXcQ', 'Fixture Song One'), track('fAuT8_dboWo', 'Fixture Song Two')],
  artists: [{ id: ARTIST_ID, title: 'Fixture Artist One', subscribers: '12K subscribers', thumb: null }],
  albums: [
    { id: ALBUM_ONE, title: 'Fixture Album One', author: 'Fixture Artist One', year: '2020', trackCount: 10, thumb: null, type: 'Album' },
    { id: ALBUM_TWO, title: 'Fixture Album Two', author: 'Fixture Artist One', year: '2022', trackCount: 8, thumb: null, type: 'Album' },
  ],
  playlists: [
    { id: PLAYLIST_ONE, title: 'Fixture Playlist One', author: 'A Listener', trackCount: 12, thumb: null, type: 'Playlist' },
    { id: PLAYLIST_TWO, title: 'Fixture Playlist Two', author: 'A Listener', trackCount: 7, thumb: null, type: 'Playlist' },
  ],
  counts: { tracks: 2, artists: 1, albums: 2, playlists: 2 },
};

const COLLECTIONS = {
  [ALBUM_ONE]: {
    title: 'Fixture Album One', author: 'Fixture Artist One', type: 'Album', year: '2020',
    thumb: null, albumId: ALBUM_ONE,
    tracks: [track('dQw4w9WgXcQ', 'Fixture Song One'), track('fAuT8_dboWo', 'Fixture Song Two')],
  },
  [PLAYLIST_ONE]: {
    title: 'Fixture Playlist One', author: 'A Listener', type: 'Playlist',
    tracks: [track('dQw4w9WgXcQ', 'Fixture Song One'), track('fAuT8_dboWo', 'Fixture Song Two')],
  },
};

const artistPage = (overrides = {}) => ({
  id: ARTIST_ID,
  name: 'Fixture Artist One',
  thumb: null,
  description: 'A fixture artist used by the search UI suite.',
  songs: [track('dQw4w9WgXcQ', 'Fixture Song One'), track('fAuT8_dboWo', 'Fixture Song Two')],
  albums: [{ id: ALBUM_ONE, title: 'Fixture Album One', year: '2020', type: 'Album', thumb: null }],
  singles: [],
  videos: [],
  adjacent: [],
  following: false,
  ...overrides,
});

/**
 * Install the network fixture *inside the page*, over whatever `fetch` is there
 * (the UX harness already stubbed the parts of the API it owns).
 *
 * Requests this suite owns are answered from the fixture and counted; everything
 * else is passed through untouched, so the rest of the app still talks to the
 * real server.
 */
function stubScript(fixture) {
  return `(() => {
    const fx = ${JSON.stringify(fixture)};
    const pass = window.fetch.bind(window);
    window.__stub = { search: 0, artist: 0, album: [], follow: [], follows: 0, failFollow: false };
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'content-type': 'application/json' },
    });
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let url;
      try { url = new URL(raw, location.href); } catch { return pass(input, init); }
      const p = url.pathname;
      const method = String(init?.method || 'GET').toUpperCase();
      if (p === '/api/search') { window.__stub.search += 1; return json(fx.search); }
      if (p === '/api/follows') { window.__stub.follows += 1; return json({ items: fx.follows ?? [] }); }
      if (p.startsWith('/api/artists/') && p.endsWith('/follow')) {
        const id = decodeURIComponent(p.split('/')[3] || '');
        if (window.__stub.failFollow) return json({ error: 'Follow failed for this test.' }, 500);
        window.__stub.follow.push({ method, id });
        return json({ following: method === 'POST', artistId: id, name: fx.artist?.name ?? null });
      }
      if (method === 'GET' && p.startsWith('/api/artist/')) {
        window.__stub.artist += 1;
        return json(fx.artist);
      }
      if (method === 'GET' && p.startsWith('/api/album/')) {
        const id = decodeURIComponent(p.slice('/api/album/'.length));
        window.__stub.album.push(id);
        return json(fx.collections?.[id] ?? { tracks: [] });
      }
      return pass(input, init);
    };
    return true;
  })()`;
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
    body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
  assert.equal(status, 200, 'browser login with admin/hunter2hunter2 failed');
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
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

/** Install the fixture for the current document. */
async function stub(browser, fixture = {}) {
  await browser.eval(stubScript({
    search: fixture.search ?? SEARCH,
    artist: fixture.artist ?? artistPage(),
    collections: fixture.collections ?? COLLECTIONS,
    follows: fixture.follows ?? [],
  }));
}

/** Type a query the way a person does: one input event, then the debounce. */
async function searchFor(browser, q = 'fixture') {
  await browser.eval(`(() => {
    const i = document.querySelector('#primary-search');
    i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await browser.waitFor(
    `document.querySelectorAll('#search-results .section-head').length > 0
      || !!document.querySelector('#search-results .empty-state')`,
    8000,
  );
}

/** The shelves as rendered: header text and what is under each one. */
const shelvesSrc = `(() => ({
  heads: [...document.querySelectorAll('#search-results .section-head h2')]
    .map((h) => h.textContent.replace(/\\s+/g, ' ').trim()),
  tabs: [...document.querySelectorAll('#search-results [data-search-type]')].map((t) => ({
    key: t.dataset.searchType,
    role: t.getAttribute('role'),
    selected: t.getAttribute('aria-selected'),
    label: t.textContent.replace(/\\s+/g, ' ').trim(),
  })),
  artistChips: document.querySelectorAll('#search-results .artist-chip').length,
  rows: document.querySelectorAll('#search-results .track-row').length,
  albumCards: [...document.querySelectorAll('#search-results [data-collection^="aMPR"]')]
    .map((c) => c.dataset.collection),
  playlistCards: [...document.querySelectorAll('#search-results [data-collection^="aPL"]')]
    .map((c) => c.dataset.collection),
  empty: document.querySelector('#search-results .empty-state h3')?.textContent?.trim() ?? null,
}))()`;

// ── 1. the shelves ───────────────────────────────────────────────────────

test('S1: one search fills four shelves, each with its own count and a type tab', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await stub(browser);
    await searchFor(browser);

    const s = await browser.eval(shelvesSrc);
    assert.deepEqual(s.heads, ['Artists 1', 'Songs 2', 'Albums 2', 'Playlists 2'],
      `shelves are not sectioned artists → songs → albums → playlists with counts: ${JSON.stringify(s.heads)}`);
    assert.equal(s.artistChips, 1, 'the artist chip above the songs is gone');
    assert.equal(s.rows, 2, 'the songs shelf did not render its rows');
    assert.deepEqual(s.albumCards, [`a${ALBUM_ONE}`, `a${ALBUM_TWO}`],
      'album results are not cards on the album collection route');
    assert.deepEqual(s.playlistCards, [`a${PLAYLIST_ONE}`, `a${PLAYLIST_TWO}`],
      'playlist results are not cards on a collection route');

    // The tab bar: the five types, ARIA-selected, with the real counts.
    assert.deepEqual(s.tabs.map((x) => x.key), ['all', 'song', 'album', 'artist', 'playlist']);
    assert.ok(s.tabs.every((x) => x.role === 'tab'), `a type tab is not role="tab": ${JSON.stringify(s.tabs)}`);
    assert.deepEqual(s.tabs.filter((x) => x.selected === 'true').map((x) => x.key), ['all'],
      'more than one tab claims to be selected');
    assert.match(s.tabs.find((x) => x.key === 'album').label, /Albums\s*2/, 'the Albums tab has no count');
    assert.match(s.tabs.find((x) => x.key === 'playlist').label, /Playlists\s*2/);

    // The sub-line of a card is what tells two releases apart.
    const sub = await browser.eval(`document.querySelector('#search-results [data-collection="a${ALBUM_ONE}"] .music-card-sub').textContent.trim()`);
    assert.match(sub, /2020/, `album card sub-line has no year: ${JSON.stringify(sub)}`);
    assert.match(sub, /Fixture Artist One/, 'album card sub-line has no artist');
    assert.match(sub, /10 songs/, 'album card sub-line has no track count');

    assert.deepEqual(await ctx.errors(), []);
  });
});

test('S2: the type tabs switch instantly from the answer already fetched (no refetch)', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await stub(browser);
    await searchFor(browser);
    const before = await browser.eval(`({ hash: location.hash, searches: window.__stub.search })`);
    assert.equal(before.searches, 1, 'the first search did not go out exactly once');

    await browser.eval(`document.querySelector('#search-results [data-search-type="album"]').click()`);
    await browser.waitFor(`document.querySelectorAll('#search-results [data-collection^="aMPR"]').length === 2`);

    const albums = await browser.eval(shelvesSrc);
    assert.equal(albums.rows, 0, 'the Albums tab still shows song rows');
    assert.equal(albums.artistChips, 0, 'the Albums tab still shows the artist strip');
    assert.equal(albums.playlistCards.length, 0, 'the Albums tab still shows playlists');
    assert.deepEqual(albums.heads, ['Albums 2'], `the Albums tab is not a single shelf: ${JSON.stringify(albums.heads)}`);
    assert.deepEqual(albums.tabs.filter((x) => x.selected === 'true').map((x) => x.key), ['album']);

    // Songs next: same query, still no second request, still the same route.
    await browser.eval(`document.querySelector('#search-results [data-search-type="song"]').click()`);
    await browser.waitFor(`document.querySelectorAll('#search-results .track-row').length === 2`);
    const songs = await browser.eval(shelvesSrc);
    assert.deepEqual(songs.heads, ['Songs 2']);
    assert.equal(songs.albumCards.length, 0, 'the Songs tab still shows album cards');
    assert.equal(songs.playlistCards.length, 0, 'the Songs tab still shows playlist cards');

    const after = await browser.eval(`({ hash: location.hash, searches: window.__stub.search })`);
    assert.equal(after.searches, 1,
      `switching tabs refetched the search (${after.searches} /api/search calls, expected 1)`);
    assert.equal(after.hash, before.hash, 'switching tabs navigated away from the search page');

    assert.deepEqual(await ctx.errors(), []);
  });
});

test('S3: a filter with nothing behind it names the filter instead of going blank', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await stub(browser, {
      search: { ...SEARCH, albums: [], counts: { tracks: 2, artists: 1, albums: 0, playlists: 2 } },
    });
    await searchFor(browser);
    await browser.eval(`document.querySelector('#search-results [data-search-type="album"]').click()`);
    await browser.waitFor(`!!document.querySelector('#search-results .empty-state h3')`);

    const s = await browser.eval(shelvesSrc);
    assert.match(s.empty ?? '', /No albums/i, `the empty Albums shelf says ${JSON.stringify(s.empty)}`);
    assert.match(s.empty ?? '', /fixture/i, 'the empty state does not name the query');

    // The way back is on the page, not only in the tab bar.
    const back = await browser.eval(`!!document.querySelector('#search-results .empty-state [data-filter="all"]')`);
    assert.ok(back, 'the empty shelf offers no way back to all results');
    await browser.eval(`document.querySelector('#search-results .empty-state [data-filter="all"]').click()`);
    await browser.waitFor(`document.querySelectorAll('#search-results .track-row').length === 2`);
    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── 2. opening what the shelves found ────────────────────────────────────

test('S4: an album result opens its collection; a playlist result opens its tracks', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await stub(browser);
    await searchFor(browser);

    await browser.eval(`document.querySelector('#search-results [data-collection="a${ALBUM_ONE}"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero h1')`, 8000);
    const album = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .collection-hero h1')?.textContent?.trim(),
      hash: location.hash,
      rows: document.querySelectorAll('#page-root .track-row').length,
    }))()`);
    assert.equal(album.title, 'Fixture Album One');
    assert.equal(album.hash, `#/c/a${ALBUM_ONE}`, 'an album result is not a collection route');
    assert.equal(album.rows, 2, "the album's own track list is not shown");

    // Back to the answer (still in memory), then open a playlist result.
    await browser.eval(`location.hash = '#/search'`);
    await browser.waitFor(`!!document.querySelector('#search-results [data-collection="a${PLAYLIST_ONE}"]')`, 8000);
    await browser.eval(`document.querySelector('#search-results [data-collection="a${PLAYLIST_ONE}"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero h1')`, 8000);
    const playlist = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .collection-hero h1')?.textContent?.trim(),
      hash: location.hash,
      rows: document.querySelectorAll('#page-root .track-row').length,
      fetched: window.__stub.album.slice(),
    }))()`);
    assert.equal(playlist.title, 'Fixture Playlist One');
    assert.equal(playlist.hash, `#/c/a${PLAYLIST_ONE}`,
      'a playlist result did not open through the collection route that serves PL ids');
    assert.equal(playlist.rows, 2, 'opening a playlist result showed no tracks');
    assert.ok(playlist.fetched.includes(PLAYLIST_ONE),
      `the playlist id never reached /api/album/:id (saw ${JSON.stringify(playlist.fetched)})`);

    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── 3. following an artist ───────────────────────────────────────────────

test('S5: the artist page follows and unfollows, optimistically and with the server', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await stub(browser);
    await searchFor(browser);
    await browser.eval(`document.querySelector('#search-results .artist-chip').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .artist-hero h1')`, 8000);

    const read = `(() => {
      const b = document.querySelector('#page-root [data-action="follow-artist"]');
      return b ? {
        pressed: b.getAttribute('aria-pressed'),
        label: b.textContent.replace(/\\s+/g, ' ').trim(),
        aria: b.getAttribute('aria-label'),
        artist: b.dataset.artist,
        name: b.dataset.name,
        height: Math.round(b.getBoundingClientRect().height),
      } : null;
    })()`;

    const idle = await browser.eval(read);
    assert.ok(idle, 'the artist page has no follow control');
    assert.equal(idle.pressed, 'false');
    assert.match(idle.label, /^Follow$/, `the idle control reads ${JSON.stringify(idle.label)}`);
    assert.equal(idle.artist, ARTIST_ID, 'the follow control does not carry the channel id');
    assert.equal(idle.name, 'Fixture Artist One');
    assert.ok(idle.height >= 44, `the follow control is ${idle.height}px tall on mobile`);

    await browser.eval(`document.querySelector('#page-root [data-action="follow-artist"]').click()`);
    await browser.waitFor(`document.querySelector('#page-root [data-action="follow-artist"]')?.getAttribute('aria-pressed') === 'true'`);
    const followed = await browser.eval(read);
    assert.match(followed.label, /Following/, 'the pressed control does not say Following');
    assert.match(followed.aria ?? '', /^Following/, 'the pressed control does not announce Following');
    let calls = await browser.eval(`window.__stub.follow.slice()`);
    assert.deepEqual(calls, [{ method: 'POST', id: ARTIST_ID }],
      `following did not POST to the follow endpoint: ${JSON.stringify(calls)}`);

    // Unfollowing is the same control, pressed again.
    await browser.eval(`document.querySelector('#page-root [data-action="follow-artist"]').click()`);
    await browser.waitFor(`document.querySelector('#page-root [data-action="follow-artist"]')?.getAttribute('aria-pressed') === 'false'`);
    const unfollowed = await browser.eval(read);
    assert.match(unfollowed.label, /^Follow$/, 'the control did not go back to Follow');
    calls = await browser.eval(`window.__stub.follow.slice()`);
    assert.deepEqual(calls, [{ method: 'POST', id: ARTIST_ID }, { method: 'DELETE', id: ARTIST_ID }],
      `unfollowing did not DELETE the follow: ${JSON.stringify(calls)}`);

    assert.deepEqual(await ctx.errors(), []);
  });
});

test('S6: a follow that fails puts the control back and says why', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await stub(browser);
    await searchFor(browser);
    await browser.eval(`document.querySelector('#search-results .artist-chip').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root [data-action="follow-artist"]')`, 8000);

    await browser.eval(`window.__stub.failFollow = true`);
    await browser.eval(`document.querySelector('#page-root [data-action="follow-artist"]').click()`);
    await browser.waitFor(`document.querySelector('#page-root [data-action="follow-artist"]')?.getAttribute('aria-pressed') === 'false'`, 5000);
    await browser.waitFor(`document.getElementById('toast').dataset.kind === 'error'
      && !document.getElementById('toast').hidden`, 5000);

    const after = await browser.eval(`(() => ({
      pressed: document.querySelector('#page-root [data-action="follow-artist"]')?.getAttribute('aria-pressed'),
      label: document.querySelector('#page-root [data-action="follow-artist"]')?.textContent.replace(/\\s+/g, ' ').trim(),
      toast: document.getElementById('toast-text').textContent.trim(),
      kind: document.getElementById('toast').dataset.kind,
    }))()`);
    assert.equal(after.pressed, 'false', 'a failed follow left the control pressed');
    assert.match(after.label ?? '', /^Follow$/, 'a failed follow left the control reading Following');
    assert.equal(after.kind, 'error', 'a failed follow was not reported as an error');
    assert.match(after.toast, /Follow failed/i, `the toast says ${JSON.stringify(after.toast)}`);

    assert.deepEqual(await ctx.errors(), []);
  });
});

test('S7: an artist with no channel id gets no follow control (no broken button)', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    // A name-only artist: the server could not resolve a channel, so there is
    // nothing a follow could be keyed by.
    await stub(browser, {
      search: { ...SEARCH, artists: [{ id: 'Fixture Artist One', title: 'Fixture Artist One', subscribers: '', thumb: null }] },
      artist: artistPage({ id: 'Fixture Artist One' }),
    });
    await searchFor(browser);
    await browser.eval(`document.querySelector('#search-results .artist-chip').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .artist-hero h1')`, 8000);

    const state = await browser.eval(`(() => ({
      follow: !!document.querySelector('#page-root [data-action="follow-artist"]'),
      hash: location.hash,
    }))()`);
    assert.equal(state.follow, false, 'a name-only artist rendered a follow control that cannot work');
    assert.match(state.hash, /^#\/artist\//);

    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── 4. the library lists follows ─────────────────────────────────────────

test('S8: the library Artists tab lists followed artists and marks them', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'library' }, async (ctx) => {
    await stub(browser, {
      follows: [{ artistId: ARTIST_ID, name: 'Fixture Followed Artist', thumb: null, since: Date.now(), lastCheckedAt: null }],
    });
    await browser.eval(`document.querySelector('[data-library-tab="Artists"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .following-tag')`, 8000);

    const s = await browser.eval(`(() => {
      const card = [...document.querySelectorAll('#page-root .music-card')]
        .find((c) => c.textContent.includes('Fixture Followed Artist'));
      return {
        found: !!card,
        artist: card?.dataset.artist ?? null,
        tag: card?.querySelector('.following-tag')?.textContent?.trim() ?? null,
        fetched: window.__stub.follows,
        cards: document.querySelectorAll('#page-root .music-card').length,
      };
    })()`);
    assert.ok(s.found, 'the followed artist is not listed on the Artists tab');
    assert.equal(s.artist, ARTIST_ID, 'the followed artist card does not open their channel page');
    assert.equal(s.tag, 'Following', 'the followed artist is not marked as followed');
    assert.equal(s.fetched, 1, `GET /api/follows was called ${s.fetched} times (expected once)`);

    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── 5. 320px ─────────────────────────────────────────────────────────────

test('S9: the filter bar scrolls inside itself, never the document, at 320×568', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: NARROW, page: 'search' }, async (ctx) => {
    await stub(browser);
    await searchFor(browser);
    // The active tab scales in (segment-in); measure the resting geometry.
    await settleAnimations(browser);

    const m = await browser.eval(`(() => {
      const bar = document.querySelector('#search-results .search-filters');
      const r = bar.getBoundingClientRect();
      return {
        docScroll: document.documentElement.scrollWidth,
        bodyScroll: document.body.scrollWidth,
        inner: window.innerWidth,
        bar: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) },
        barScroll: bar.scrollWidth,
        barClient: bar.clientWidth,
        tabs: [...document.querySelectorAll('#search-results [data-search-type]')]
          .map((t) => ({ key: t.dataset.searchType, h: Math.round(t.getBoundingClientRect().height) })),
      };
    })()`);

    assert.ok(m.docScroll <= m.inner,
      `the filter bar widened the document: scrollWidth ${m.docScroll}px > innerWidth ${m.inner}px`);
    assert.ok(m.bodyScroll <= m.inner,
      `the filter bar widened the body: ${m.bodyScroll}px > ${m.inner}px`);
    assert.ok(m.bar.left >= -0.5 && m.bar.right <= m.inner + 0.5,
      `the filter bar sits outside the viewport: ${JSON.stringify(m.bar)} of ${m.inner}px`);
    assert.ok(m.barScroll > m.barClient,
      'the filter bar neither fits nor scrolls: it is clipping its tabs');
    assert.deepEqual(m.tabs.filter((x) => x.h < 44), [],
      `a type tab is under 44px tall on a phone: ${JSON.stringify(m.tabs)}`);

    assert.deepEqual(await ctx.errors(), []);
  });
});
