// Unit tests for search ranking and de-duplication.
//
// These encode the two complaints that drove the module: a search page full of
// the same song from lyric channels instead of the artist, and a "browse by
// feeling" page full of 4-hour single-video mixes instead of playlists.
//
// Nothing here touches the network: rankTracks/rankPlaylists take plain objects,
// so the real YouTube response shapes are pinned as fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTitle, parseVideoTitle, isCompilation, isOfficialChannel,
  parsePlaylistStats, rankTracks, rankPlaylists, MAX_SONG_SECONDS, songKey,
  cardMetadata,
} from '../src/search-rank.js';

// ── title normalization ─────────────────────────────────────────────────

test('upload decorations collapse onto the song title', () => {
  const same = [
    'Blinding Lights',
    'Blinding Lights (Official Video)',
    'Blinding Lights (Official Audio)',
    'Blinding Lights [Lyrics]',
    'Blinding Lights (Lyrics)',
    'Blinding Lights - Official Music Video',
    'Blinding Lights (feat. Somebody)',
  ];
  for (const t of same) {
    assert.equal(normalizeTitle(t), 'blinding lights', `${JSON.stringify(t)} did not normalize`);
  }
});

test('a genuinely different version stays distinct', () => {
  assert.notEqual(normalizeTitle('Creep (Acoustic)'), normalizeTitle('Creep'));
  assert.notEqual(normalizeTitle('Blinding Lights (Hardstyle)'), normalizeTitle('Blinding Lights'));
  assert.notEqual(normalizeTitle('Blinding Lights (Live)'), normalizeTitle('Blinding Lights'));
});

test('"Artist - Song" is split, but "Song - Part 2" is not', () => {
  assert.deepEqual(
    parseVideoTitle('The Weeknd - Blinding Lights (Official Video)'),
    { artist: 'The Weeknd', title: 'Blinding Lights (Official Video)' },
  );
  assert.deepEqual(
    parseVideoTitle('Love - Part 2'),
    { artist: 'Love', title: 'Part 2' },
  );
  assert.equal(parseVideoTitle('No dash here').artist, null);
  // A long left side is a title, not a credit.
  assert.equal(parseVideoTitle('A very long left hand side that rambles on - right').artist, null);
});

test('official uploaders are recognised, lyric channels are not', () => {
  assert.equal(isOfficialChannel('Radiohead - Topic', 'Radiohead'), true);
  assert.equal(isOfficialChannel('theweekndVEVO', 'The Weeknd'), true);
  assert.equal(isOfficialChannel('The Weeknd', 'The Weeknd'), true);
  assert.equal(isOfficialChannel('7clouds', 'The Weeknd'), false);
  assert.equal(isOfficialChannel('The Vibe Guide', null), false);
});

// ── compilations ────────────────────────────────────────────────────────

test('a 4-hour single-video mix is a compilation', () => {
  assert.equal(isCompilation({ title: 'RnB Playlist', durationS: 4 * 3600 }), true);
  assert.equal(isCompilation({ title: '1 Hour of Chill Lofi', durationS: 120 }), true);
  assert.equal(isCompilation({ title: '3 Hours of Chill Lofi', durationS: 11017 }), true);
  assert.equal(isCompilation({ title: 'Full Album', durationS: 200 }), true);
  assert.equal(isCompilation({ title: 'Blinding Lights', durationS: 202 }), false);
});

test('a normal song is never treated as a compilation', () => {
  assert.equal(isCompilation({ title: 'End Of The Road Medley', durationS: 712 }), false);
  assert.equal(isCompilation({ title: 'Echoes', durationS: MAX_SONG_SECONDS - 1 }), false);
});

// ── ranking / de-duplication ────────────────────────────────────────────

const song = (over) => ({
  videoId: 'xxxxxxxxxxx',
  title: 'Untitled',
  channel: 'Some Channel',
  durationS: 200,
  itemType: 'video',
  official: false,
  ...over,
});

test('the same song from a lyric channel does not appear twice', () => {
  const rows = rankTracks([
    song({ videoId: 'officialVid', title: 'The Weeknd - Blinding Lights (Official Video)', channel: 'The Weeknd', official: true }),
    song({ videoId: 'lyricsOne1', title: 'The Weeknd - Blinding Lights (Lyrics)', channel: '7clouds' }),
    song({ videoId: 'lyricsTwo2', title: 'The Weeknd - Blinding Lights (Lyrics)', channel: 'The Vibe Guide' }),
    song({ videoId: 'lyricsTre3', title: 'The Weeknd - Blinding Lights (Lyrics)', channel: '7clouds Indie' }),
  ], { query: 'blinding lights' });

  assert.equal(rows.length, 1, `expected one row, got ${rows.map((r) => r.channel).join(', ')}`);
  assert.equal(rows[0].videoId, 'officialVid', 'the artist upload must win, not a lyric channel');
});

test('a cover flood cannot bury the real song', () => {
  const rows = rankTracks([
    song({ videoId: 'mariCoverX1', title: 'Blinding Lights', artist: 'Marianne', channel: 'Marianne', itemType: 'song', official: true }),
    song({ videoId: 'leoCoverXx1', title: 'Blinding Lights', artist: 'Leo', channel: 'Leo', itemType: 'song', official: true }),
    song({ videoId: 'evCoverXx11', title: 'Blinding Lights', artist: 'EV', channel: 'EV', itemType: 'song', official: true }),
    // The catalogue entry carries an album credit, so it scores highest.
    song({ videoId: 'realWeeknd1', title: 'Blinding Lights', artist: 'The Weeknd', channel: 'The Weeknd', album: 'After Hours', itemType: 'song', official: true }),
  ], { query: 'blinding lights' });

  assert.equal(rows.length, 1, 'one row per song title');
  assert.equal(rows[0].videoId, 'realWeeknd1', 'the released version wins');
});

test('different versions of one song both survive', () => {
  const rows = rankTracks([
    song({ videoId: 'creepOrig01', title: 'Creep', artist: 'Radiohead', channel: 'Radiohead', itemType: 'song', official: true }),
    song({ videoId: 'creepAcous1', title: 'Creep (Acoustic)', artist: 'Radiohead', channel: 'Radiohead', itemType: 'song', official: true }),
  ], { query: 'creep' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.videoId).sort(), ['creepAcous1', 'creepOrig01']);
});

test('compilations are dropped from search results', () => {
  const rows = rankTracks([
    song({ videoId: 'longMix0001', title: '4 Hour RnB Playlist', durationS: 4 * 3600 }),
    song({ videoId: 'realSong001', title: 'Foolish', artist: 'Ashanti', channel: 'Ashanti', itemType: 'song', official: true, album: 'Ashanti' }),
  ], { query: 'rnb' });
  assert.deepEqual(rows.map((r) => r.videoId), ['realSong001']);
});

test('if everything was filtered out the raw list is returned, not an empty page', () => {
  const mix = song({ videoId: 'onlyMix0001', title: '8 Hours of Ambient', durationS: 8 * 3600 });
  const rows = rankTracks([mix], { query: 'ambient' });
  assert.equal(rows.length, 1, 'a query that only matches mixes still shows something');
  assert.equal(rows[0].videoId, 'onlyMix0001');
});

test('the limit is respected after de-duplication', () => {
  const rows = rankTracks(
    Array.from({ length: 10 }, (_, i) => song({ videoId: `vid${String(i).padStart(8, '0')}`, title: `Song ${i}` })),
    { limit: 3 },
  );
  assert.equal(rows.length, 3);
});

test('songKey identifies one song across uploads, but keeps versions apart', () => {
  const catalogue = { title: 'Ever Changing Times (feat. Michael McDonald)', artist: 'Aretha Franklin', channel: 'Aretha Franklin', itemType: 'song' };
  const video = { title: 'Ever Changing Times (Official Music Video) (feat. Michael McDonald)', channel: 'Aretha Franklin', itemType: 'video' };
  assert.equal(songKey(catalogue), songKey(video), 'the same song from two uploads must collide');

  const live = { title: 'Ever Changing Times (Live)', artist: 'Aretha Franklin', itemType: 'song' };
  assert.notEqual(songKey(live), songKey(catalogue), 'a live version is a different recording');

  const cover = { title: 'Ever Changing Times', artist: 'Some Cover Band', itemType: 'song' };
  assert.notEqual(songKey(cover), songKey(catalogue), 'a cover by another artist is a different song');
});

// ── playlist stats and ranking ──────────────────────────────────────────

test('playlist headers yield views and a track count', () => {
  assert.deepEqual(parsePlaylistStats('13M views • 201 tracks • 12+ hours'), {
    views: 13_000_000, trackCount: 201,
  });
  assert.deepEqual(parsePlaylistStats('1,234 views • 5 songs'), { views: 1234, trackCount: 5 });
  assert.deepEqual(parsePlaylistStats(null), { views: null, trackCount: null });
});

test('single-video "playlists" are dropped and popularity wins', () => {
  const rows = rankPlaylists([
    { id: 'VLPLone', title: 'One 4-hour video', views: 9e6, trackCount: 1 },
    { id: 'VLPLtwo', title: 'Small list', views: 200, trackCount: 20 },
    { id: 'VLPLtre', title: 'Big list', views: 5e6, trackCount: 120 },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['VLPLtre', 'VLPLtwo']);
});

test('a playlist whose length could not be read is kept, not hidden', () => {
  const rows = rankPlaylists([
    { id: 'VLPLunk', title: 'Unknown length', views: 10, trackCount: null },
  ]);
  assert.equal(rows.length, 1);
});

// ── share-card metadata ─────────────────────────────────────────────────
// A shared track is read by a chat client as two lines: a bold title and a grey
// description. These are the shapes YouTube actually serves.

test('an upload title becomes a card title and artist', () => {
  assert.deepEqual(
    cardMetadata({ title: 'DaBaby - POP DAT THANG (Official Music Video)', channel: 'DaBaby' }),
    { title: 'POP DAT THANG', artist: 'DaBaby' },
  );
  assert.deepEqual(
    cardMetadata({ title: 'Blinding Lights (Official Video) [HD]', channel: 'TheWeekndVEVO' }),
    { title: 'Blinding Lights', artist: 'TheWeeknd' },
  );
  // A "- Topic" channel is the artist, spelled with the label suffix.
  assert.deepEqual(
    cardMetadata({ title: 'POP DAT THANG', channel: 'DaBaby - Topic' }),
    { title: 'POP DAT THANG', artist: 'DaBaby' },
  );
});

test('a different recording keeps its qualifier', () => {
  assert.deepEqual(
    cardMetadata({ title: 'Blinding Lights (Acoustic)', channel: 'The Weeknd' }),
    { title: 'Blinding Lights (Acoustic)', artist: 'The Weeknd' },
  );
});

test('a title whose separator is the qualifier is not split', () => {
  // "Song - Official Video" would otherwise credit an artist called "Song" and
  // name the track "Official Video".
  const card = cardMetadata({ title: 'Song - Official Video', channel: 'Real Artist' });
  assert.equal(card.title, 'Song');
  assert.equal(card.artist, 'Real Artist');
});

test('a card title is never empty', () => {
  assert.equal(cardMetadata({ title: '(Official Video)', channel: 'X' }).title, '(Official Video)');
  assert.equal(cardMetadata({}).title, '');
});
