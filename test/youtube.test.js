import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// src/youtube.js is the only module that reads YouTube's scraped payloads, and
// every screen depends on it. A renderer that changes shape (a shelf arriving as
// an object, a byline arriving as a number, a field renamed) must degrade to an
// empty list, never to a TypeError that the route reports as a 500 for the whole
// page. This file drives every public function with a hostile session to prove
// that, then with realistic shapes to prove the parsers still read them.
//
// No network: the session is replaced through `setSessionOverride`, which is the
// same seam a future client swap would use. The database is a throwaway because
// src/cookies.js → src/db.js opens it at import time.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-youtube-'));
process.env.SONORA_DB = path.join(TMP, 'youtube.db');
process.env.SONORA_SECRET = 'youtube-test-secret';
process.env.SONORA_PASSPHRASE = 'hunter2hunter2';

const yt = await import('../src/youtube.js');
const { config } = await import('../src/config.js');

const {
  setSessionOverride, searchTracks, searchMoodPlaylists, searchPlaylists, upNext,
  artistIdFor, artistPage, artistProfile, albumPage, albumForVideo, genreTiles,
  genreSongs, exploreTrending, searchAlbums, searchArtists, playlistTracks,
  fetchLyrics, isLive,
} = yt;

after(() => {
  setSessionOverride(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const VIDEO = 'dQw4w9WgXcQ';
const VIDEO_2 = 'OzL7u5teZhg';
const VIDEO_3 = 'abcdefghijk';
const CHANNEL = `UC${'a'.repeat(22)}`;
const CHANNEL_2 = `UC${'b'.repeat(22)}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message = 'condition was not reached') {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

// ── hostile payloads ──────────────────────────────────────────────────────

/**
 * Every field a shelf could use, filled with the wrong type.
 *
 * This is not arbitrary: YouTube has answered each of these at least once
 * (`songs` as a lockup object, `contents` as a single renderer, `title` as a
 * run object, a duration as a string). The point is that `.map`, `.split`,
 * `.test` and `.startsWith` on any of them must not be reachable.
 */
function junkPayload() {
  const run = { text: { not: 'a string' } };
  return {
    songs: 'not a shelf',
    videos: { length: 1 },
    artists: 42,
    albums: null,
    playlists: { contents: { nope: true } },
    results: 'nope',
    contents: 'nope',
    items: { 0: 'x' },
    sections: 'nope',
    header: {
      title: run,
      subtitle: 9,
      second_subtitle: [],
      strapline_text_one: { runs: { 0: run } },
      thumbnail: { contents: 'x' },
    },
    data: 'nope',
    basic_info: 'nope',
    streaming_data: { adaptive_formats: 'nope' },
    description: 12,
    flex_columns: 'nope',
  };
}

/**
 * A shelf that *is* an array but whose rows are junk — the other half of the
 * same problem (`[null, 'x', {…}]` is exactly what a half-parsed page looks
 * like).
 */
function junkRowsPayload() {
  const p = junkPayload();
  return {
    ...p,
    songs: { contents: [null, undefined, 'x', 42, {}, [], { video_id: 12345 }, { id: 'short' }] },
    videos: { contents: [null, 'x', { video_id: VIDEO_3 }] },
    artists: { contents: [null, 5, { id: 7 }, { id: CHANNEL, name: { not: 'a string' } }] },
    albums: { contents: [null, { id: 'MPR' }, { id: 42 }, { id: 'MPREb_ok' }] },
    playlists: { contents: [null, { id: 5 }, { id: 'PLx' }, { id: 'PLok', title: 'A list' }] },
    results: [null, 'x', 7],
    sections: [
      null,
      'x',
      { header: { title: { text: 'Albums' } }, contents: 'nope' },
      { header: { title: { text: 'Songs' } }, contents: [null, 'x', { musicResponsiveListItemRenderer: { flexColumns: 'nope' } }] },
      { header: { title: { text: 'Moods & genres' } }, contents: [null, { endpoint: { payload: { params: 7 } } }] },
      { header: 'nope', contents: [null, { id: 'MPREb_ok', title: 'x' }] },
    ],
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    { musicCarouselShelfRenderer: { header: 'nope', contents: 'nope' } },
                    {
                      musicCarouselShelfRenderer: {
                        header: {
                          musicCarouselShelfBasicHeaderRenderer: {
                            title: { runs: [{ text: 'Songs' }, { text: { bad: true } }] },
                          },
                        },
                        contents: [null, 'x', { musicResponsiveListItemRenderer: { flexColumns: 'nope' } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

function sessionReturning(payload) {
  return {
    music: {
      search: async () => payload,
      getUpNext: async () => payload,
      getArtist: async () => payload,
      getAlbum: async () => payload,
      getPlaylist: async () => payload,
      getExplore: async () => payload,
      getLyrics: async () => payload,
    },
    search: async () => payload,
    getPlaylist: async () => payload,
    getBasicInfo: async () => payload,
    actions: { execute: async () => payload },
    session: { player: null },
  };
}

/** Every public entry point that talks to YouTube. */
const PUBLIC_CALLS = [
  ['searchTracks', () => searchTracks('creep', 5)],
  ['searchMoodPlaylists', () => searchMoodPlaylists('rainy', 3)],
  ['searchPlaylists', () => searchPlaylists('rainy', 3)],
  ['upNext', () => upNext(VIDEO, 5)],
  ['artistIdFor', () => artistIdFor('radiohead')],
  ['artistPage', () => artistPage(CHANNEL)],
  ['artistProfile', () => artistProfile(CHANNEL)],
  ['albumPage', () => albumPage('MPREb_DciERiuADkS')],
  ['albumForVideo', () => albumForVideo(VIDEO_2)],
  ['genreTiles', () => genreTiles()],
  ['genreSongs', () => genreSongs('Rock', 5)],
  ['exploreTrending', () => exploreTrending(5)],
  ['searchAlbums', () => searchAlbums('pablo honey', 5)],
  ['searchArtists', () => searchArtists('radiohead', 5)],
  ['playlistTracks (VL)', () => playlistTracks('VLPL1234567890', 10)],
  ['playlistTracks (PL)', () => playlistTracks('PL1234567890', 10)],
  ['fetchLyrics', () => fetchLyrics(VIDEO)],
  ['isLive', () => isLive(VIDEO)],
];

// ── a malformed shape never throws ────────────────────────────────────────

test('no public function throws on a malformed upstream shape', async () => {
  for (const payload of [junkPayload(), junkRowsPayload()]) {
    for (const [name, call] of PUBLIC_CALLS) {
      setSessionOverride(sessionReturning(payload));
      try {
        await assert.doesNotReject(call, `${name} threw on a malformed shape`);
      } finally {
        setSessionOverride(null);
      }
    }
  }
});

test('a malformed shape is filtered to an empty answer, not a broken one', async () => {
  setSessionOverride(sessionReturning(junkRowsPayload()));
  try {
    assert.deepEqual(await searchTracks('creep', 5), []);
    assert.deepEqual(await upNext(VIDEO, 5), []);
    assert.deepEqual(await exploreTrending(5), []);
    assert.deepEqual(await genreSongs('Rock', 5), []);
    assert.deepEqual(await playlistTracks('PL1234567890', 10), { title: null, author: null, type: 'Album', tracks: [] });
    assert.equal(await artistIdFor('radiohead'), null);
    // A channel row whose name is a run object is dropped, not rendered as
    // "[object Object]".
    assert.deepEqual(await searchArtists('radiohead', 5), []);
    const page = await artistPage(CHANNEL);
    assert.deepEqual(page.songs, []);
    assert.deepEqual(page.albums, []);
    assert.equal(page.name, null);
    assert.equal(await fetchLyrics(VIDEO), null);
    assert.equal(await isLive(VIDEO), false);
  } finally {
    setSessionOverride(null);
  }
});

// ── an operational failure still propagates ───────────────────────────────

test('an upstream failure is reported, not papered over', async () => {
  // The parsers are total; the *transport* is not. A route has to be able to
  // answer "YouTube is unavailable" instead of an empty page, so a rejection
  // has to come through untouched.
  const failing = () => {
    const boom = async () => { throw new Error('upstream is down'); };
    return {
      music: { search: boom, getUpNext: boom, getArtist: boom, getAlbum: boom, getPlaylist: boom, getExplore: boom, getLyrics: boom },
      search: boom,
      getPlaylist: boom,
      getBasicInfo: boom,
      actions: { execute: boom },
      session: { player: null },
    };
  };
  setSessionOverride(failing());
  try {
    await assert.rejects(() => upNext(VIDEO, 5), /upstream is down/);
    await assert.rejects(() => artistPage(CHANNEL), /upstream is down/);
    await assert.rejects(() => playlistTracks('PL1234567890'), /upstream is down/);
    // …and the deliberately best-effort calls still answer.
    assert.equal(await fetchLyrics(VIDEO), null);
    assert.equal(await isLive(VIDEO), false);
  } finally {
    setSessionOverride(null);
  }
});

// ── a dead session is rebuilt ─────────────────────────────────────────────

test('only a session-health failure rebuilds the shared session', async () => {
  // YT-07 assumed "three failures in a row" meant a bad session. It does not: a
  // private video, a region block and a deleted playlist row are all ordinary
  // misses, and a station page issues ~20 calls in parallel — so one page of dead
  // tracks used to cost several `Innertube.create()` calls and cookie-jar reads.
  // Only a failure that says something about the session itself rebuilds it now.
  let built = 0;
  const sessionThrowing = (err) => () => {
    built += 1;
    const boom = async () => { throw err; };
    return {
      music: { getArtist: boom, search: boom, getUpNext: boom, getAlbum: boom, getPlaylist: boom, getExplore: boom, getLyrics: boom },
      search: boom,
      getPlaylist: boom,
      getBasicInfo: boom,
      actions: { execute: boom },
      session: { player: null },
    };
  };

  // 1. Ordinary per-item misses never throw the session away.
  setSessionOverride(sessionThrowing(new Error('This video is unavailable')));
  try {
    for (let i = 0; i < 6; i += 1) {
      await assert.rejects(() => artistPage(CHANNEL), /unavailable/);
    }
    assert.equal(built, 1, 'ordinary misses must not rebuild the session');
  } finally {
    setSessionOverride(null);
  }

  // 2. A genuine session-health failure (here: a timeout) still does, after three.
  built = 0;
  setSessionOverride(sessionThrowing(new Error('playlist timed out')));
  try {
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => artistPage(CHANNEL), /timed out/);
    }
    assert.equal(built, 1, 'the same session is reused until it has failed three times');
    await assert.rejects(() => artistPage(CHANNEL), /timed out/);
    assert.equal(built, 2, 'after three consecutive session-health failures the session is rebuilt');
  } finally {
    setSessionOverride(null);
  }
});

// ── realistic shapes still parse ─────────────────────────────────────────

/** A catalogue row, shaped like a MusicResponsiveListItem. */
function catalogueRow(over = {}) {
  return {
    id: VIDEO,
    title: { text: 'Creep' },
    artists: [{ name: 'Radiohead', channel_id: CHANNEL }],
    duration: { seconds: 239 },
    album: { name: 'Pablo Honey', id: 'MPREb_DciERiuADkS' },
    ...over,
  };
}

function artistPagePayload() {
  return {
    header: {
      title: { text: 'Radiohead' },
      description: { text: 'Art rock band' },
      thumbnail: { contents: [{ url: 'https://yt3.googleusercontent.com/abc=s88' }] },
    },
    sections: [
      {
        contents: [
          // The album really is the byline's second segment on this shelf…
          catalogueRow({
            duration: null,
            album: null,
            flex_columns: [{ title: { text: 'Creep' } }, { title: { text: 'Radiohead • Pablo Honey • 3:58' } }],
          }),
          // …and here it is a play count, with the album nowhere at all.
          catalogueRow({
            id: VIDEO_2,
            title: { text: 'High and Dry' },
            artists: [],
            duration: null,
            album: null,
            flex_columns: [{ title: { text: 'High and Dry' } }, { title: { text: 'Radiohead • 86M plays' } }],
          }),
          // An album track row: YouTube fills the credits with "N/A".
          catalogueRow({ id: VIDEO_3, title: { text: 'You' }, artists: [{ name: 'N/A' }], duration: null, album: null }),
        ],
      },
      {
        header: { title: { text: 'Albums' } },
        contents: [
          {
            id: 'MPREb_DciERiuADkS',
            title: { text: 'Pablo Honey' },
            subtitle: 'Album • 1993',
            thumbnails: [{ url: '//yt3.ggpht.com/cover=s176' }],
          },
        ],
      },
      {
        header: { title: { text: 'Singles & EPs' } },
        contents: [{ id: 'MPREb_single', title: 'Creep', subtitle: 'Single • 1992' }],
      },
      {
        header: { title: { text: 'Videos' } },
        contents: [{ id: VIDEO, title: 'Creep (Official Video)', subtitle: 'Radiohead • 1.5B views • 3:58' }],
      },
      {
        header: { title: { text: 'Fans might also like' } },
        contents: [
          { id: CHANNEL_2, title: { text: 'Muse' }, thumbnails: [{ url: 'https://lh3.googleusercontent.com/x=s88' }] },
          { id: 'not-a-channel', title: 'Nope' },
        ],
      },
    ],
  };
}

function realisticSession(over = {}) {
  const empty = { contents: [] };
  return {
    music: {
      search: async () => empty,
      getUpNext: async () => empty,
      getArtist: async () => artistPagePayload(),
      getAlbum: async () => empty,
      getPlaylist: async () => empty,
      getExplore: async () => ({ sections: [] }),
      getLyrics: async () => ({ description: 'La la la' }),
      ...over.music,
    },
    search: async () => empty,
    getPlaylist: async () => empty,
    getBasicInfo: async () => ({ basic_info: { title: 'Creep', author: 'Radiohead', is_live: false } }),
    actions: { execute: async () => ({ data: {} }) },
    session: { player: {} },
    ...over,
  };
}

test('an artist page keeps its songs, releases, videos and neighbours', async () => {
  setSessionOverride(realisticSession());
  try {
    const page = await artistPage(CHANNEL);
    assert.equal(page.name, 'Radiohead');
    assert.equal(page.description, 'Art rock band');
    assert.equal(page.thumb, 'https://yt3.googleusercontent.com/abc=s88');

    const [creep, high, you] = page.songs;
    assert.equal(creep.videoId, VIDEO);
    assert.equal(creep.title, 'Creep');
    assert.equal(creep.artist, 'Radiohead');
    assert.equal(creep.channelId, CHANNEL);
    // The length only exists as a byline segment on this shelf (YT-13).
    assert.equal(creep.durationS, 238);
    assert.equal(creep.album, 'Pablo Honey');

    // A play count is not an album, and it used to be printed as one.
    assert.equal(high.artist, 'Radiohead');
    assert.equal(high.album, null);
    assert.equal(high.views, 86_000_000);

    // "N/A" is not an artist.
    assert.equal(you.artist, null);

    assert.deepEqual(page.albums.map((a) => [a.id, a.year, a.type]), [['MPREb_DciERiuADkS', '1993', 'Album']]);
    // A protocol-relative avatar is made absolute, or iOS drops it.
    assert.equal(page.albums[0].thumb, 'https://yt3.ggpht.com/cover=s176');
    assert.equal(page.singles[0].type, 'Single');
    assert.equal(page.videos[0].durationS, 238);
    assert.equal(page.videos[0].itemType, 'video');
    assert.deepEqual(page.adjacent.map((a) => a.name), ['Muse']);

    // artistProfile is the same page reduced to what the station needs.
    const profile = await artistProfile(CHANNEL);
    assert.deepEqual(Object.keys(profile).sort(), ['adjacent', 'name', 'songs']);
  } finally {
    setSessionOverride(null);
  }
});

test('an album page credits every track with the release it was opened on', async () => {
  setSessionOverride(realisticSession({
    music: {
      getAlbum: async () => ({
        header: {
          title: { text: 'Pablo Honey' },
          subtitle: 'Album • 1993',
          strapline_text_one: {
            text: 'Radiohead',
            runs: [{ text: 'Radiohead', endpoint: { payload: { browseId: CHANNEL } } }],
          },
          thumbnail: { contents: [{ url: 'https://yt3.googleusercontent.com/cover=s544' }] },
        },
        contents: [catalogueRow({ album: { name: 'N/A', id: null } })],
      }),
    },
  }));
  try {
    const album = await albumPage('MPREb_DciERiuADkS');
    assert.equal(album.title, 'Pablo Honey');
    assert.equal(album.author, 'Radiohead');
    assert.equal(album.authorId, CHANNEL);
    assert.equal(album.year, '1993');
    assert.equal(album.type, 'Album');
    assert.equal(album.tracks.length, 1);
    // The page's own identity wins over the row's "N/A" byline.
    assert.equal(album.tracks[0].album, 'Pablo Honey');
    assert.equal(album.tracks[0].albumId, 'MPREb_DciERiuADkS');
  } finally {
    setSessionOverride(null);
  }
});

test('search merges catalogue songs with video hits and de-duplicates them', async () => {
  setSessionOverride(realisticSession({
    music: {
      search: async () => ({ songs: { contents: [catalogueRow()] } }),
    },
    search: async () => ({
      videos: [
        {
          video_id: VIDEO,
          title: 'Radiohead - Creep (Official Video)',
          author: 'Radiohead - Topic',
          duration: { seconds: 239 },
          thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }],
        },
        {
          video_id: VIDEO_2,
          title: 'Radiohead - High and Dry (Official Video)',
          author: { name: 'Radiohead', id: CHANNEL },
          duration: { seconds: 256 },
        },
      ],
    }),
  }));
  try {
    const tracks = await searchTracks('creep radiohead', 10);
    const ids = tracks.map((t) => t.videoId);
    assert.equal(ids.filter((id) => id === VIDEO).length, 1, `the same song must not arrive twice: ${ids}`);
    assert.ok(ids.includes(VIDEO_2));
    const video = tracks.find((t) => t.videoId === VIDEO_2);
    // "Artist - Song" is split so the lyric channel is not credited as artist.
    assert.equal(video.artist, 'Radiohead');
    assert.equal(video.itemType, 'video');
    assert.equal(video.channelId, CHANNEL);
    // An object `author` is read, not stringified (the up-next panel shape).
    assert.equal(video.channel, 'Radiohead');
  } finally {
    setSessionOverride(null);
  }
});

test('a failing video fallback keeps the songs the catalogue already returned', async () => {
  // YT-08: the unguarded fallback used to empty the whole Songs tab.
  setSessionOverride(realisticSession({
    music: { search: async () => ({ songs: { contents: [catalogueRow()] } }) },
    search: async () => { throw new Error('video search is gated'); },
  }));
  try {
    const tracks = await searchTracks('creep', 10);
    assert.equal(tracks.length, 1, 'the catalogue song must survive a failed video search');
    assert.equal(tracks[0].videoId, VIDEO);
  } finally {
    setSessionOverride(null);
  }
});

// ── song edit versions (clean / explicit) ───────────────────────────────

test('a catalogue row with an explicit badge is stamped explicit', async () => {
  setSessionOverride(realisticSession({
    music: {
      search: async () => ({
        songs: {
          contents: [
            catalogueRow({ badges: [{ icon_type: 'EXPLICIT' }] }),
            catalogueRow({ id: VIDEO_2, title: { text: 'High and Dry' } }),
          ],
        },
      }),
    },
  }));
  try {
    const tracks = await searchTracks('creep', 10);
    const creep = tracks.find((t) => t.videoId === VIDEO);
    const dry = tracks.find((t) => t.videoId === VIDEO_2);
    assert.equal(creep.version, 'explicit', 'the badge must reach the row');
    assert.equal(dry.version, undefined, 'an unbadged row is not stamped');
  } finally {
    setSessionOverride(null);
  }
});

test('a clean-titled row is stamped clean', async () => {
  setSessionOverride(realisticSession({
    music: {
      search: async () => ({
        songs: { contents: [catalogueRow({ title: { text: 'Creep (Clean)' } })] },
      }),
    },
  }));
  try {
    const tracks = await searchTracks('creep', 10);
    assert.equal(tracks[0].version, 'clean');
  } finally {
    setSessionOverride(null);
  }
});

test('upNext partitions clean rows behind the rest', async () => {
  // The seed itself is excluded from its own up-next list, so the seed id is
  // one that is not among the rows.
  const rows = [
    { video_id: VIDEO, title: 'Song A', author: 'Artist', duration: { seconds: 200 } },
    { video_id: VIDEO_2, title: 'Song B (Clean)', author: 'Artist', duration: { seconds: 200 } },
    { video_id: VIDEO_3, title: 'Song C', author: 'Artist', duration: { seconds: 200 }, badges: [{ icon_type: 'EXPLICIT' }] },
  ];
  setSessionOverride(realisticSession({
    music: { getUpNext: async () => ({ contents: rows }) },
  }));
  try {
    const tracks = await upNext('zzzzzzzzzzz', 5);
    // Non-clean first in their own order, then the clean row.
    assert.deepEqual(tracks.map((t) => t.videoId), [VIDEO, VIDEO_3, VIDEO_2]);
    assert.equal(tracks[2].version, 'clean');
    assert.equal(tracks[1].version, 'explicit');
  } finally {
    setSessionOverride(null);
  }
});

test('upNext still fills the page from an all-clean neighbourhood', async () => {
  setSessionOverride(realisticSession({
    music: {
      getUpNext: async () => ({
        contents: [
          { video_id: VIDEO, title: 'Song A (Clean)', author: 'Artist', duration: { seconds: 200 } },
          { video_id: VIDEO_2, title: 'Song B (Radio Edit)', author: 'Artist', duration: { seconds: 200 } },
        ],
      }),
    },
  }));
  try {
    const tracks = await upNext('zzzzzzzzzzz', 5);
    assert.equal(tracks.length, 2, 'clean rows are partitioned, not filtered away');
  } finally {
    setSessionOverride(null);
  }
});

test('searchTracks rejects total failure and can still use one successful source', async () => {
  const musicDown = new Error('Music catalogue unavailable');
  const videosDown = new Error('plain video search unavailable');
  setSessionOverride(realisticSession({
    music: { search: async () => { throw musicDown; } },
    search: async () => { throw videosDown; },
  }));
  try {
    await assert.rejects(() => searchTracks('creep', 10), (err) => {
      assert.ok(err instanceof AggregateError);
      assert.deepEqual(err.errors, [musicDown, videosDown]);
      return true;
    });
  } finally {
    setSessionOverride(null);
  }

  setSessionOverride(realisticSession({
    music: { search: async () => { throw new Error('catalogue gated'); } },
    search: async () => ({ videos: [{ video_id: VIDEO_2, title: 'Radiohead - High and Dry', author: 'Radiohead' }] }),
  }));
  try {
    const tracks = await searchTracks('high and dry', 10);
    assert.deepEqual(tracks.map((t) => t.videoId), [VIDEO_2]);
  } finally {
    setSessionOverride(null);
  }
});

test('policy errors never fan out to a fallback and retain Retry-After', async () => {
  for (const [name, call] of [
    ['tracks', () => searchTracks('creep', 5)],
    ['albums', () => searchAlbums('pablo honey', 5)],
    ['artists', () => searchArtists('radiohead', 5)],
  ]) {
    let plainCalls = 0;
    const limited = new Error('Request failed with status code 429');
    limited.status = 429;
    limited.response = { status: 429, headers: new Headers({ 'Retry-After': '17' }) };
    let current = realisticSession({
      music: { search: async () => { throw limited; } },
      search: async () => { plainCalls += 1; return { contents: [] }; },
    });
    let builds = 0;
    setSessionOverride(() => { builds += 1; return current; });
    try {
      await assert.rejects(call, (err) => {
        assert.equal(err, limited, `${name} must preserve the original policy error`);
        assert.equal(err.retryAfterMs, 17_000);
        assert.equal(err.retryAfter, 17);
        assert.equal(err.code, 'YT_RATE_LIMIT');
        return true;
      });
      assert.equal(plainCalls, 0, `${name} must not immediately retry via plain search`);
      await assert.rejects(() => yt.getYT(), (err) => {
        assert.equal(err.code, 'YT_BLOCKED');
        assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 17_000);
        return true;
      });
      await assert.rejects(call, (err) => err?.code === 'YT_BLOCKED');
      assert.equal(plainCalls, 0, 'an armed backoff does not enqueue a fallback either');

      // A cookie/session reset starts a genuinely new identity; the previous
      // identity's rate limit must not poison it.
      current = realisticSession();
      yt.resetYT();
      const page = await artistPage(CHANNEL);
      assert.equal(page.name, 'Radiohead');
      assert.equal(builds, 2);
    } finally {
      setSessionOverride(null);
    }
  }
});

test('a stale policy failure cannot re-arm backoff after resetYT', async () => {
  const oldFailure = deferred();
  let oldCalls = 0;
  let newCalls = 0;
  let current = realisticSession({
    music: { getArtist: async () => {
      oldCalls += 1;
      return oldFailure.promise;
    } },
  });
  setSessionOverride(() => current);
  try {
    const oldRequest = artistPage(CHANNEL);
    await waitUntil(() => oldCalls === 1);
    current = realisticSession({ music: { getArtist: async () => {
      newCalls += 1;
      return artistPagePayload();
    } } });
    yt.resetYT();
    assert.equal((await artistPage(CHANNEL)).name, 'Radiohead');
    const limited = new Error('old identity failed with status code 429');
    limited.status = 429;
    limited.response = { status: 429, headers: new Headers({ 'Retry-After': '30' }) };
    oldFailure.reject(limited);
    await assert.rejects(() => oldRequest, (err) => err === limited && err.retryAfterMs === 30_000);
    assert.equal((await artistPage(CHANNEL)).name, 'Radiohead');
    assert.equal(newCalls, 2, 'the replacement session was used, not blocked by the old 429');
  } finally {
    setSessionOverride(null);
  }
});

test('albumForVideo caches a hit and a miss, but never a failed lookup', async () => {
  let searches = 0;
  const row = catalogueRow();
  const music = {
    search: async () => {
      searches += 1;
      return { songs: { contents: [row] } };
    },
  };
  setSessionOverride(realisticSession({ music }));
  try {
    const first = await albumForVideo(VIDEO);
    assert.deepEqual(first, { albumId: 'MPREb_DciERiuADkS', title: 'Pablo Honey', author: 'Radiohead' });
    const second = await albumForVideo(VIDEO);
    assert.deepEqual(second, first);
    assert.equal(searches, 1, 'a resolved album is cached, not re-searched per screen');
  } finally {
    setSessionOverride(null);
  }

  // A miss is cached for a short while (a re-release can make it wrong later),
  // and a failed lookup is not cached at all.
  let misses = 0;
  setSessionOverride(realisticSession({
    music: { search: async () => { misses += 1; return { songs: { contents: [] } }; } },
  }));
  try {
    assert.equal(await albumForVideo(VIDEO_2), null);
    assert.equal(await albumForVideo(VIDEO_2), null);
    assert.equal(misses, 1, 'a looked-up miss is cached briefly');
  } finally {
    setSessionOverride(null);
  }

  let failures = 0;
  setSessionOverride(realisticSession({
    music: { search: async () => { failures += 1; throw new Error('gated'); } },
  }));
  try {
    assert.equal(await albumForVideo(VIDEO_3), null);
    assert.equal(await albumForVideo(VIDEO_3), null);
    assert.equal(failures, 2, 'a failed lookup must not be remembered as "no album"');
  } finally {
    setSessionOverride(null);
  }
});

test('albumForVideo coalesces misses and a reset rebinding rejects stale writes', async () => {
  const gate = deferred();
  let misses = 0;
  setSessionOverride(realisticSession({
    music: { search: async () => { misses += 1; await gate.promise; return { songs: { contents: [] } }; } },
  }));
  try {
    const first = albumForVideo(VIDEO_2, { title: 'High and Dry', artist: 'Radiohead' });
    const second = albumForVideo(VIDEO_2, { title: 'High and Dry', artist: 'Radiohead' });
    await waitUntil(() => misses === 1);
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second]), [null, null]);
    assert.equal(misses, 1, 'one in-flight miss serves every simultaneous caller');
    assert.equal(await albumForVideo(VIDEO_2), null);
    assert.equal(misses, 1, 'the completed miss remains cached');
  } finally {
    setSessionOverride(null);
  }

  const oldGate = deferred();
  let oldSearches = 0;
  let current = realisticSession({
    music: { search: async () => {
      oldSearches += 1;
      await oldGate.promise;
      return { songs: { contents: [catalogueRow()] } };
    } },
  });
  setSessionOverride(() => current);
  const oldLookup = albumForVideo(VIDEO, { title: 'Creep', artist: 'Radiohead' });
  await waitUntil(() => oldSearches === 1);
  current = realisticSession({
    music: { search: async () => ({ songs: { contents: [catalogueRow({
      album: { name: 'New Identity Album', id: 'MPREb_new_identity' },
    })] } }) },
  });
  yt.resetYT();
  const replacement = await albumForVideo(VIDEO, { title: 'Creep', artist: 'Radiohead' });
  assert.equal(replacement.title, 'New Identity Album');
  oldGate.resolve();
  assert.equal((await oldLookup).title, 'Pablo Honey', 'the old caller still receives its own answer');
  assert.deepEqual(await albumForVideo(VIDEO), replacement, 'the old completion did not overwrite the new cache');
  setSessionOverride(null);
});

test('genre tiles and genre songs read the raw browse payload', async () => {
  const explore = {
    sections: [
      { header: { title: { text: 'Moods & genres' } }, contents: [
        { button_text: { text: 'Rock' }, endpoint: { payload: { params: 'p1', browseId: 'FEmusic_moods_and_genres_category' } } },
        { button_text: { text: '' }, endpoint: { payload: { params: 'p2', browseId: 'x' } } },
      ] },
    ],
  };
  const browse = {
    data: {
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
            { musicCarouselShelfRenderer: {
              header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: 'Songs' }] } } },
              contents: [
                { musicResponsiveListItemRenderer: {
                  flexColumns: [
                    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Just' }] } } },
                    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Radiohead • 86M views • 3:54' }] } } },
                    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'The Bends' }] } } },
                  ],
                  overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId: VIDEO } } } } } },
                } },
                { musicResponsiveListItemRenderer: {
                  flexColumns: [
                    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'No id' }] } } },
                  ],
                } },
              ],
            } },
          ] } } } }],
        },
      },
    },
  };
  setSessionOverride({
    music: {
      getExplore: async () => explore,
      search: async () => ({ contents: [] }),
      getUpNext: async () => ({ contents: [] }),
      getArtist: async () => ({ sections: [] }),
      getAlbum: async () => ({ contents: [] }),
      getPlaylist: async () => ({ contents: [] }),
      getLyrics: async () => ({ description: null }),
    },
    search: async () => ({ contents: [] }),
    getPlaylist: async () => ({ contents: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
    actions: { execute: async () => browse },
    session: { player: {} },
  });
  try {
    const tiles = await genreTiles();
    assert.deepEqual(tiles, [{ name: 'Rock', params: 'p1', browseId: 'FEmusic_moods_and_genres_category' }]);
    const songs = await genreSongs('rock', 10);
    assert.equal(songs.length, 1);
    assert.equal(songs[0].videoId, VIDEO);
    assert.equal(songs[0].artist, 'Radiohead');
    assert.equal(songs[0].album, 'The Bends');
    assert.equal(songs[0].durationS, 234);
    assert.equal(songs[0].views, 86_000_000);
  } finally {
    setSessionOverride(null);
  }
});

test('every public limit is clamped before slicing or ranking', async () => {
  const musicRow = catalogueRow({ item_type: 'song' });
  const videoRow = { video_id: VIDEO_2, title: 'High and Dry', author: 'Radiohead', duration: { seconds: 256 } };
  const artist = { id: CHANNEL, name: 'Radiohead' };
  const release = { id: 'MPREb_limit', title: 'Pablo Honey', subtitle: 'Album • 1993' };
  const playlist = {
    id: 'PLlimit', title: 'Focus playlist',
    flex_columns: [{}, { title: { text: 'Curator • 12 tracks • 2 views' } }],
  };
  const raw = {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Creep' }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Radiohead • 3:58' }] } } },
      ],
      overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: {
        playNavigationEndpoint: { watchEndpoint: { videoId: VIDEO } },
      } } } },
    },
  };
  setSessionOverride(realisticSession({
    music: {
      search: async (_query, { type }) => ({
        songs: { contents: [musicRow] },
        artists: { contents: [artist] },
        albums: { contents: [release] },
        playlists: { contents: [playlist] },
      }),
      getUpNext: async () => ({ contents: [videoRow] }),
      getExplore: async () => ({ sections: [
        { header: { title: { text: 'Moods & genres' } }, contents: [
          { button_text: { text: 'Rock' }, endpoint: { payload: { params: 'p', browseId: 'FErock' } } },
        ] },
        { header: { title: { text: 'Trending' } }, contents: [musicRow] },
      ] }),
      getPlaylist: async () => ({ header: { title: 'VL list' }, contents: [musicRow] }),
    },
    actions: {
      execute: async () => ({
        data: {
          contents: {
            singleColumnBrowseResultsRenderer: {
              tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
                { musicCarouselShelfRenderer: {
                  header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: 'Songs' }] } } },
                  contents: [raw],
                } },
              ] } } } }],
            },
          },
        },
      }),
    },
    getPlaylist: async () => ({ info: { title: 'PL list' }, videos: [videoRow] }),
  }));
  const calls = [
    ['searchTracks', (value) => searchTracks('creep', value)],
    ['searchMoodPlaylists', (value) => searchMoodPlaylists('focus', value)],
    ['searchPlaylists', (value) => searchPlaylists('focus', value)],
    ['upNext', (value) => upNext(VIDEO_3, value)],
    ['genreSongs', (value) => genreSongs('Rock', value)],
    ['exploreTrending', (value) => exploreTrending(value)],
    ['searchAlbums', (value) => searchAlbums('pablo honey', value)],
    ['searchArtists', (value) => searchArtists('radiohead', value)],
  ];
  try {
    for (const [name, call] of calls) {
      assert.deepEqual(await call(-1), [], `${name}: negative limit`);
      assert.deepEqual(await call(-Infinity), [], `${name}: negative infinity`);
      assert.equal((await call(1n)).length, 1, `${name}: BigInt must not reach Array#slice`);
      assert.equal((await call(Symbol('bad'))).length, 1, `${name}: invalid limit falls back safely`);
    }
    assert.deepEqual((await playlistTracks('VLPLlimit', -1)).tracks, []);
    assert.equal((await playlistTracks('VLPLlimit', 1n)).tracks.length, 1);
    assert.deepEqual((await playlistTracks('PLlimit', -1)).tracks, []);
    assert.equal((await playlistTracks('PLlimit', 1n)).tracks.length, 1);
  } finally {
    setSessionOverride(null);
  }

  const many = Array.from({ length: 120 }, (_, i) => ({
    video_id: String(i).padStart(11, 'v'), title: `Track ${i}`, author: 'Unique Artist',
  }));
  setSessionOverride(realisticSession({ music: { getUpNext: async () => ({ contents: many }) } }));
  try {
    assert.equal((await upNext(VIDEO_3, Number.MAX_VALUE)).length, 100, 'overflow is capped');
    assert.equal((await upNext(VIDEO_3, Infinity)).length, 100);
  } finally {
    setSessionOverride(null);
  }
});

test('playlist relevance selects bounded header work and concurrent stats coalesce', async () => {
  const hits = [
    { id: 'PLexact', title: 'Chill jazz', flex_columns: [{}, { title: { text: 'Curator • 1 view' } }] },
    { id: 'PLprefix', title: 'Chill jazz for focus', flex_columns: [{}, { title: { text: 'Curator • 2 views' } }] },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `PLother${i}`,
      title: `Unrelated ${i}`,
      flex_columns: [{}, { title: { text: `Curator • ${100 - i}M views` } }],
    })),
  ];
  const verified = [];
  let searches = 0;
  setSessionOverride(realisticSession({
    music: {
      search: async () => { searches += 1; return { playlists: { contents: hits } }; },
      getPlaylist: async (id) => {
        verified.push(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { header: { second_subtitle: { text: '3 views • 20 tracks • 1 hour' } } };
      },
    },
  }));
  try {
    const [first, second] = await Promise.all([
      searchPlaylists('chill jazz', 3),
      searchPlaylists('chill jazz', 3),
    ]);
    assert.deepEqual(first.slice(0, 2).map((p) => p.id), ['PLexact', 'PLprefix']);
    assert.deepEqual(second, first);
    assert.equal(verified.length, 8, 'two concurrent searches share each of eight header loads');
    assert.equal(new Set(verified).size, 8);
    assert.ok(verified.includes('PLexact'), 'relevance, not raw views, selects verification work');
    assert.ok(verified.includes('PLprefix'));
    await searchPlaylists('chill jazz', 3);
    assert.equal(verified.length, 8, 'cached stats avoid another header fanout');
    assert.equal(searches, 3, 'only the raw playlist search repeats');
  } finally {
    setSessionOverride(null);
  }
});

test('playlist header verification does not under-fill the requested limit', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `PLfull${i}`,
    title: `Focus playlist ${i}`,
    flex_columns: [{}, { title: { text: 'Curator • 10 views' } }],
  }));
  let headers = 0;
  setSessionOverride(realisticSession({
    music: {
      search: async () => ({ playlists: { contents: rows } }),
      getPlaylist: async () => {
        headers += 1;
        return { header: { second_subtitle: { text: '20 tracks • 10 views' } } };
      },
    },
  }));
  try {
    const result = await searchMoodPlaylists('focus playlist');
    assert.equal(result.length, 12, 'the two unverified tail rows remain eligible');
    assert.equal(headers, 10, 'twelve results still cost at most ten headers');
  } finally {
    setSessionOverride(null);
  }
});

test('lyrics resolve to text or null, never to "[object Object]"', async () => {
  const descriptions = [
    ['La la la', 'La la la'],
    [{ text: 'Na na na' }, 'Na na na'],
    [{ toString: () => 'Da da da' }, 'Da da da'],
    [12, null],
    [null, null],
  ];
  for (const [description, expected] of descriptions) {
    setSessionOverride(realisticSession({ music: { getLyrics: async () => ({ description }) } }));
    try {
      assert.equal(await fetchLyrics(VIDEO), expected, `description ${JSON.stringify(description)}`);
    } finally {
      setSessionOverride(null);
    }
  }
  // A session that cannot even be created is not a lyric-less track.
  setSessionOverride(realisticSession({ music: { getLyrics: async () => { throw new Error('gated'); } } }));
  try {
    assert.equal(await fetchLyrics(VIDEO), null);
  } finally {
    setSessionOverride(null);
  }
});

test('one global scheduler bounds search, station and follows fanout together', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const answer = async (payload) => {
    active += 1;
    calls += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return payload;
    } finally {
      active -= 1;
    }
  };
  setSessionOverride(realisticSession({
    music: {
      search: async () => answer({ songs: { contents: [catalogueRow()] } }),
      getUpNext: async () => answer({ contents: [] }),
      getArtist: async () => answer(artistPagePayload()),
    },
    search: async () => answer({ videos: [] }),
  }));
  try {
    const work = [
      ...Array.from({ length: 12 }, () => upNext(VIDEO, 5)), // station up-next lane
      ...Array.from({ length: 10 }, () => artistProfile(CHANNEL)), // station + follows
      ...Array.from({ length: 6 }, (_, i) => searchTracks(`artist ${i}`, 1)), // search + artist lane
    ];
    await Promise.all(work);
    assert.equal(calls, work.length);
    assert.equal(maximum, 4, 'the shared queue runs four, not one per Promise.all branch');
    assert.equal(active, 0, 'every slot was released');
  } finally {
    setSessionOverride(null);
  }
});

test('a total deadline includes session creation and does not start late work', async () => {
  const previous = config.resolveTimeoutMs;
  const init = deferred();
  let factoryCalls = 0;
  let methodCalls = 0;
  let watchdog;
  config.resolveTimeoutMs = 25;
  setSessionOverride(() => {
    factoryCalls += 1;
    return init.promise;
  });
  try {
    const started = Date.now();
    const operation = Promise.race([
      upNext(VIDEO, 1),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('test watchdog: getYT was outside the deadline')), 300);
      }),
    ]);
    await assert.rejects(operation, (err) => {
      assert.equal(err.code, 'YT_TIMEOUT');
      assert.match(err.message, /upNext timed out/);
      return true;
    });
    assert.ok(Date.now() - started < 250);
    assert.equal(factoryCalls, 1);
    init.resolve(realisticSession({ music: { getUpNext: async () => {
      methodCalls += 1;
      return { contents: [] };
    } } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(methodCalls, 0, 'a late init result cannot issue its upstream method');
  } finally {
    clearTimeout(watchdog);
    config.resolveTimeoutMs = previous;
    init.resolve(realisticSession());
    setSessionOverride(null);
  }
});

test('the custom transport still aborts a hung mocked fetch', async () => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = AbortSignal.timeout;
  const previousConfig = config.resolveTimeoutMs;
  let fetches = 0;
  let aborts = 0;
  const abortReasons = [];
  let watchdog;
  globalThis.fetch = (_input, init = {}) => {
    fetches += 1;
    return new Promise((_, reject) => {
      const rejectAbort = () => {
        aborts += 1;
        const reason = init.signal.reason ?? new DOMException('aborted', 'AbortError');
        abortReasons.push(reason);
        reject(reason);
      };
      if (init.signal?.aborted) rejectAbort();
      else init.signal?.addEventListener('abort', rejectAbort, { once: true });
    });
  };
  // Keep the five-second production backstop, but shorten this offline test at
  // the standard AbortSignal.timeout seam rather than changing production code.
  AbortSignal.timeout = (ms) => previousTimeout(Math.min(ms, 20));
  config.resolveTimeoutMs = 5;
  setSessionOverride(null);
  try {
    const operation = Promise.race([
      yt.getYT(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('test watchdog: transport was not aborted')), 300);
      }),
    ]);
    // youtubei.js intentionally creates local session data when this fetch
    // fails; that fallback is fine as long as the underlying transport aborted.
    await operation;
    assert.ok(fetches > 0);
    assert.equal(aborts, fetches);
    assert.ok(abortReasons.every((err) => err?.name === 'TimeoutError'));
    assert.equal(yt.hasYT(), true, 'youtubei.js local init fallback remains available');
  } finally {
    clearTimeout(watchdog);
    globalThis.fetch = previousFetch;
    AbortSignal.timeout = previousTimeout;
    config.resolveTimeoutMs = previousConfig;
    setSessionOverride(null);
  }
});

test('a real mocked 429 response cannot be hidden by local init recovery', async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '13' } });
  };
  setSessionOverride(null);
  try {
    await assert.rejects(() => upNext(VIDEO, 1), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 13_000);
      assert.equal(err.retryAfter, 13);
      return true;
    });
    assert.equal(fetches, 1, 'neither init recovery nor another endpoint repeated the request');
  } finally {
    globalThis.fetch = previousFetch;
    setSessionOverride(null);
  }
});

test('isLive is true only for a real boolean, and never throws', async () => {
  for (const [value, expected] of [[true, true], ['yes', false], [1, false], [null, false], [undefined, false]]) {
    setSessionOverride(realisticSession({ getBasicInfo: async () => ({ basic_info: { is_live: value } }) }));
    try {
      assert.equal(await isLive(VIDEO), expected, `is_live ${JSON.stringify(value)}`);
    } finally {
      setSessionOverride(null);
    }
  }
});

test('isLive never caches failure or malformed answers and coalesces probes', async () => {
  let calls = 0;
  setSessionOverride(realisticSession({
    getBasicInfo: async () => {
      calls += 1;
      if (calls === 1) throw new Error('metadata gated');
      return { basic_info: { is_live: true } };
    },
  }));
  try {
    assert.equal(await isLive(VIDEO), false);
    assert.equal(await isLive(VIDEO), true);
    assert.equal(await isLive(VIDEO), true);
    assert.equal(calls, 2, 'the failed lookup was retried; the real boolean was cached');
  } finally {
    setSessionOverride(null);
  }

  calls = 0;
  setSessionOverride(realisticSession({
    getBasicInfo: async () => { calls += 1; return { basic_info: { is_live: 'yes' } }; },
  }));
  try {
    assert.equal(await isLive(VIDEO), false);
    assert.equal(await isLive(VIDEO), false);
    assert.equal(calls, 2, 'a non-boolean is_live is not a cacheable not-live answer');
  } finally {
    setSessionOverride(null);
  }

  calls = 0;
  const gate = deferred();
  setSessionOverride(realisticSession({
    getBasicInfo: async () => {
      calls += 1;
      await gate.promise;
      return { basic_info: { is_live: false } };
    },
  }));
  try {
    const probes = Array.from({ length: 8 }, () => isLive(VIDEO_2));
    await waitUntil(() => calls === 1);
    gate.resolve();
    assert.deepEqual(await Promise.all(probes), Array(8).fill(false));
    assert.equal(calls, 1, 'simultaneous probes share exactly one upstream request');
    assert.equal(await isLive(VIDEO_2), false);
    assert.equal(calls, 1, 'a real false answer is cached');
  } finally {
    setSessionOverride(null);
  }
});

test('an old live probe cannot overwrite or block a replacement identity', async () => {
  const oldGate = deferred();
  let oldCalls = 0;
  let newCalls = 0;
  let current = realisticSession({
    getBasicInfo: async () => {
      oldCalls += 1;
      await oldGate.promise;
      return { basic_info: { is_live: false } };
    },
  });
  setSessionOverride(() => current);
  try {
    const oldProbe = isLive(VIDEO_3);
    await waitUntil(() => oldCalls === 1);
    current = realisticSession({
      getBasicInfo: async () => { newCalls += 1; return { basic_info: { is_live: true } }; },
    });
    yt.resetYT();
    assert.equal(await isLive(VIDEO_3), true);
    oldGate.resolve();
    assert.equal(await oldProbe, false);
    assert.equal(await isLive(VIDEO_3), true);
    assert.equal(newCalls, 1, 'stale false neither replaced nor evicted the new true cache');
  } finally {
    oldGate.resolve();
    setSessionOverride(null);
  }
});

// ── the seam itself ──────────────────────────────────────────────────────

test('clearing the override restores the real session factory', async () => {
  setSessionOverride(realisticSession());
  const session = await yt.getYT();
  assert.ok(session.music, 'the override is what getYT() answers with');
  setSessionOverride(null);
  // No assertion on the real session here: creating one needs the network. The
  // point is that the override is not sticky, and that nothing above leaked a
  // half-configured client into the module.
  // The bot gate is decided by yt-dlp's exit code now (see src/audio.js), not by
  // inspecting a youtubei.js playability_status, so there is nothing to assert
  // about it here.
});