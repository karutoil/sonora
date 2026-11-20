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
  cardMetadata, isSongDuration, trackVersion, toCount,
} from '../src/search-rank.js';
// The station reuses these keys to cap one artist, so the non-Latin fixture is
// checked from both sides: the search page and the queue it feeds.
import { buildStation, MAX_PER_ARTIST } from '../src/station.js';

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

// ── non-Latin titles ────────────────────────────────────────────────────
// The old normalizer kept `[a-z0-9]` only, so every CJK/Cyrillic/Arabic title
// became "" and therefore became *the same song* as every other one.

test('non-Latin titles normalize to themselves, not to nothing', () => {
  assert.equal(normalizeTitle('夜に駆ける'), '夜に駆ける');
  assert.equal(normalizeTitle('Песня'), 'песня');
  assert.equal(normalizeTitle('أغنية'), 'أغنية');
  assert.notEqual(normalizeTitle('夜に駆ける'), normalizeTitle('怪物'));
  assert.notEqual(normalizeTitle('夜に駆ける'), '');
});

test('accents still fold, so a re-upload is not a second song', () => {
  assert.equal(normalizeTitle('Beyoncé'), 'beyonce');
  assert.equal(normalizeTitle('Beyonce'), 'beyonce');
  // Indic/Thai vowel marks are spelling, not decoration: they stay.
  assert.equal(normalizeTitle('हिन्दी'), 'हिन्दी');
});

const NON_LATIN = [
  { videoId: 'nlSongs0001', title: '夜に駆ける', artist: 'YOASOBI', channel: 'YOASOBI - Topic', itemType: 'song', official: true, durationS: 261 },
  { videoId: 'nlSongs0002', title: '怪物', artist: 'YOASOBI', channel: 'YOASOBI - Topic', itemType: 'song', official: true, durationS: 205 },
  { videoId: 'nlSongs0003', title: '群青', artist: 'YOASOBI', channel: 'YOASOBI - Topic', itemType: 'song', official: true, durationS: 248 },
  { videoId: 'nlSongs0004', title: 'Lemon', artist: '米津玄師', channel: '米津玄師 - Topic', itemType: 'song', official: true, durationS: 255 },
  { videoId: 'nlSongs0005', title: '感電', artist: '米津玄師', channel: '米津玄師 - Topic', itemType: 'song', official: true, durationS: 264 },
];

test('a non-Latin catalogue keeps five distinct songs by two artists', () => {
  const rows = rankTracks(NON_LATIN, { query: '夜に駆ける' });
  assert.equal(rows.length, 5, `five songs collapsed into ${rows.length}`);
  assert.equal(new Set(rows.map((r) => r.videoId)).size, 5);
  assert.equal(new Set(rows.map((r) => r.artist)).size, 2, 'two distinct artists survive');
  assert.equal(new Set(NON_LATIN.map(songKey)).size, 5, 'each song has its own identity key');
});

test('a non-Latin artist is still one artist to the station', () => {
  // With empty keys every row was a different "artist" to nothing and the same
  // song to everything: the cap was bypassed and the page collapsed. Now the
  // cap applies to the artist it names, and distinct songs stay distinct.
  const rows = rankTracks([
    ...NON_LATIN,
    { videoId: 'nlSongs0006', title: '紅蓮華', artist: 'YOASOBI', channel: 'YOASOBI - Topic', itemType: 'song', official: true, durationS: 234 },
  ], { query: '' });
  const out = buildStation({
    expansions: [{ tracks: rows, lane: 'sameArtist' }],
    knownArtists: new Set(['YOASOBI', '米津玄師']),
    plan: { seed: 0, sameArtist: 12, adjacent: 0, trending: 0 },
    limit: 12,
  });
  assert.equal(out.length, MAX_PER_ARTIST * 2, 'two per artist, and no more');
  assert.equal(new Set(out.map((t) => t.channel)).size, 2);
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

test('empty normalization results never prove a channel and artist match', () => {
  // Both sides normalize to "": equality of those empty strings used to award
  // the official-channel score boost to arbitrary punctuation-only accounts.
  assert.equal(isOfficialChannel('!!!', '???'), false);
  assert.equal(isOfficialChannel('!!!', '!!!'), false);
  assert.equal(isOfficialChannel('🔥🔥', '🎵🎵'), false);
  assert.equal(isOfficialChannel('!!! - Topic', '???'), false, 'a Topic suffix cannot lend meaning to an empty key');
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

// ── duration filters ────────────────────────────────────────────────────
// MIN_SONG_SECONDS was documented as "shorter than this is a jingle" but only
// ever added a score point, so a 15-second teaser ranked like a song.

test('a known duration is judged, an unknown one is not', () => {
  assert.equal(isSongDuration({ durationS: 15 }), false);
  assert.equal(isSongDuration({ durationS: 202 }), true);
  assert.equal(isSongDuration({ durationS: MAX_SONG_SECONDS + 1 }), false);
  assert.equal(isSongDuration({ durationS: null }), true, 'no metadata is not evidence');
  assert.equal(isSongDuration({ durationS: '202' }), true, 'a numeric string is still a duration');
  assert.equal(isSongDuration({ durationS: '' }), true, 'a blank duration is unknown');
});

test('finite zero and negative durations are known-bad, not unknown', () => {
  for (const durationS of [0, -1, -200, '0', '-1', '-200']) {
    assert.equal(isSongDuration({ durationS }), false, `duration ${JSON.stringify(durationS)} must be rejected`);
  }
  const rows = rankTracks([
    song({ videoId: 'zeroLength1', title: 'Zero length', durationS: 0 }),
    song({ videoId: 'negativeLen', title: 'Negative length', durationS: -1 }),
    song({ videoId: 'knownGood01', title: 'Known length', durationS: 200 }),
  ], { query: 'length' });
  assert.deepEqual(rows.map((row) => row.videoId), ['knownGood01'],
    'known-bad durations do not survive beside a real song');
});

test('a teaser is dropped from search results, a song is not', () => {
  const rows = rankTracks([
    song({ videoId: 'teaser000001', title: 'Foolish (teaser)', durationS: 15 }),
    song({ videoId: 'fullSong0001', title: 'Foolish', artist: 'Ashanti', channel: 'Ashanti', itemType: 'song', official: true }),
    song({ videoId: 'unknownDur01', title: 'Foolish (Acoustic)', artist: 'Ashanti', channel: 'Ashanti', itemType: 'song', official: true, durationS: null }),
  ], { query: 'foolish' });
  assert.deepEqual(rows.map((r) => r.videoId), ['fullSong0001', 'unknownDur01'],
    'the teaser goes, the song and the unknown-length version stay');
});

test('a known over-long upload is a compilation whatever its title says', () => {
  const rows = rankTracks([
    song({ videoId: 'longUpload01', title: 'Best Of', durationS: 5400 }),
    song({ videoId: 'shortSong001', title: 'Foolish', artist: 'Ashanti', channel: 'Ashanti', itemType: 'song', official: true }),
  ], { query: 'foolish' });
  assert.deepEqual(rows.map((r) => r.videoId), ['shortSong001']);
});

test('a query answered only by teasers still shows something', () => {
  const rows = rankTracks([song({ videoId: 'onlyTeaser01', title: 'Snip', durationS: 8 })], { query: 'snip' });
  assert.deepEqual(rows.map((r) => r.videoId), ['onlyTeaser01']);
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

test('a cover flood is capped, and the released version still wins', () => {
  const rows = rankTracks([
    song({ videoId: 'mariCoverX1', title: 'Blinding Lights', artist: 'Marianne', channel: 'Marianne', itemType: 'song', official: true }),
    song({ videoId: 'leoCoverXx1', title: 'Blinding Lights', artist: 'Leo', channel: 'Leo', itemType: 'song', official: true }),
    song({ videoId: 'evCoverXx11', title: 'Blinding Lights', artist: 'EV', channel: 'EV', itemType: 'song', official: true }),
    // The catalogue entry carries an album credit, so it scores highest.
    song({ videoId: 'realWeeknd1', title: 'Blinding Lights', artist: 'The Weeknd', channel: 'The Weeknd', album: 'After Hours', itemType: 'song', official: true }),
  ], { query: 'blinding lights' });

  // A handful of covers may follow the real thing; a page of them may not. The
  // title cap used to be 1, which also hid genuinely different songs that
  // happen to share a title (see the "Stay" test below).
  assert.ok(rows.length <= 3, `a cover flood filled the page: ${rows.length} rows`);
  assert.equal(rows[0].videoId, 'realWeeknd1', 'the released version wins');
});

test('different songs that share a title all survive', () => {
  const rows = rankTracks([
    song({ videoId: 'stayJustin01', title: 'Stay', artist: 'Justin Bieber', channel: 'Justin Bieber', album: 'Changes', itemType: 'song', official: true }),
    song({ videoId: 'stayKidLar01', title: 'Stay', artist: 'The Kid LAROI', channel: 'The Kid LAROI', itemType: 'song', official: true }),
    song({ videoId: 'stayRihanna1', title: 'Stay', artist: 'Rihanna', channel: 'Rihanna', itemType: 'song', official: true }),
  ], { query: 'stay' });
  assert.equal(rows.length, 3, 'a shared title is not a duplicate');
  assert.equal(new Set(rows.map((r) => r.artist)).size, 3);
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

test('track and playlist limits honor zero and normalize hostile counts', () => {
  const tracks = Array.from({ length: 5 }, (_, i) => song({
    videoId: `limited${String(i).padStart(4, '0')}`, title: `Song ${i}`,
  }));
  const playlists = Array.from({ length: 5 }, (_, i) => ({
    id: `PLlimited${i}`, title: `List ${i}`, trackCount: 20, views: 100 - i,
  }));
  for (const limit of [0, -1, -20.5]) {
    assert.deepEqual(rankTracks(tracks, { limit }), [], `track limit ${limit}`);
    assert.deepEqual(rankPlaylists(playlists, { limit }), [], `playlist limit ${limit}`);
    // The all-filtered fallback must not bypass a zero/negative limit either.
    assert.deepEqual(rankTracks([song({ title: 'teaser', durationS: 1 })], { limit }), []);
  }
  assert.equal(rankTracks(tracks, { limit: '2.9' }).length, 2);
  assert.equal(rankPlaylists(playlists, { limit: '2.9' }).length, 2);
  // A NaN/Infinity is not an instruction to return zero or unlimited rows.
  assert.equal(rankTracks(tracks, { limit: Number.NaN }).length, 5);
  assert.equal(rankPlaylists(playlists, { limit: Number.POSITIVE_INFINITY }).length, 5);
  assert.equal(rankTracks(tracks, { limit: Symbol('bad') }).length, 5, 'Symbol cannot throw from Number coercion');
  assert.equal(rankPlaylists(playlists, { limit: null }).length, 5, 'null means the normal default');
  assert.equal(rankTracks(tracks, { limit: 2n }).length, 2, 'safe BigInts still normalize');
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

test('symbol-only titles and credits use distinct deterministic identities', () => {
  const first = song({ videoId: 'symbol00001', title: '!!!', artist: '***', itemType: 'song' });
  const second = song({ videoId: 'symbol00002', title: '???', artist: '***', itemType: 'song' });
  const otherCredit = song({ videoId: 'symbol00003', title: 'Same title', artist: '???', itemType: 'song' });
  const firstCredit = song({ videoId: 'symbol00004', title: 'Same title', artist: '!!!', itemType: 'song' });
  assert.notEqual(songKey(first), songKey(second), 'ids disambiguate empty title keys');
  assert.notEqual(songKey(firstCredit), songKey(otherCredit), 'raw credits disambiguate empty artist keys');
  assert.notEqual(
    songKey({ title: '!!!', artist: 'Same artist', itemType: 'song' }),
    songKey({ title: '???', artist: 'Same artist', itemType: 'song' }),
    'even id-less stored callers cannot share the old empty title key',
  );
  const rows = rankTracks([first, second, { ...first }], { query: '' });
  assert.deepEqual(rows.map((row) => row.videoId).sort(), ['symbol00001', 'symbol00002'],
    'distinct symbol-only songs survive while a repeated upload still de-duplicates');
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

test('playlist relevance to the query precedes raw popularity', () => {
  const rows = rankPlaylists([
    { id: 'VLPLpopular', title: 'Most viewed rock anthems', views: 900_000_000, trackCount: 100 },
    { id: 'VLPLprefix', title: 'Chill jazz for late nights', views: 30_000, trackCount: 30 },
    { id: 'VLPLexact', title: 'Chill jazz', views: 100, trackCount: 20 },
  ], { query: 'chill jazz' });
  assert.deepEqual(rows.map((row) => row.id), ['VLPLexact', 'VLPLprefix', 'VLPLpopular']);
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

// ── song edit versions (clean / explicit) ───────────────────────────────
// The listener is an adult and does not want the censored edit. These pin the
// detector and the two places a version is decided: the within-tier sort and
// the de-duplication keeper.

test('trackVersion reads the badge and the bracketed markers', () => {
  // Badge shapes: parsed MusicInlineBadge (icon_type/label) and raw "E".
  assert.equal(trackVersion({ title: 'WAP', badges: [{ icon_type: 'EXPLICIT' }] }), 'explicit');
  assert.equal(trackVersion({ title: 'WAP', badges: [{ iconType: 'MUSIC_EXPLICIT' }] }), 'explicit');
  assert.equal(trackVersion({ title: 'WAP', badges: [{ label: 'E' }] }), 'explicit');
  assert.equal(trackVersion({ title: 'WAP', badges: [{ accessibility: { accessibility_data: { label: 'E' } } }] }), 'explicit');
  // A pre-stamped row is authoritative.
  assert.equal(trackVersion({ title: 'WAP', version: 'explicit' }), 'explicit');
  assert.equal(trackVersion({ title: 'WAP', version: 'clean' }), 'clean');
  // Titles, bracketed.
  assert.equal(trackVersion({ title: 'Song (Clean)' }), 'clean');
  assert.equal(trackVersion({ title: 'Song [Radio Edit]' }), 'clean');
  assert.equal(trackVersion({ title: 'Song (Censored Version)' }), 'clean');
  assert.equal(trackVersion({ title: 'Song (Explicit)' }), 'explicit');
  assert.equal(trackVersion({ title: 'Song (Uncut)' }), 'explicit');
  // Dash tail, full phrases only.
  assert.equal(trackVersion({ title: 'Song - Clean Version' }), 'clean');
  assert.equal(trackVersion({ title: 'Song - Radio Edit' }), 'clean');
  assert.equal(trackVersion({ title: 'Song - Explicit Version' }), 'explicit');
  // A song *named* Clean or Dirty is not an edit.
  assert.equal(trackVersion({ title: 'Clean' }), null);
  assert.equal(trackVersion({ title: 'Taylor Swift - Clean' }), null);
  assert.equal(trackVersion({ title: 'Dirty Diana' }), null);
  // No markers at all.
  assert.equal(trackVersion({ title: 'Creep' }), null);
  // The badge outranks the title.
  assert.equal(trackVersion({ title: 'Song (Clean)', badges: [{ icon_type: 'EXPLICIT' }] }), 'explicit');
});

test('rankTracks stamps the surviving row with its version', () => {
  const out = rankTracks([
    { videoId: 'verNoMark00', title: 'Creep', artist: 'Radiohead', itemType: 'video' },
    { videoId: 'verClean0001', title: 'Creep (Clean)', artist: 'Radiohead', itemType: 'video' },
    { videoId: 'verExplct002', title: 'Creep (Explicit)', artist: 'Radiohead', itemType: 'video' },
  ], { query: 'creep' });
  const creep = out.find((t) => /creep/i.test(t.title));
  assert.equal(creep.videoId, 'verExplct002', 'the explicit edit is the keeper');
  assert.equal(creep.version, 'explicit');
});

test('an unmarked edit beats a clean edit for the same song', () => {
  const out = rankTracks([
    { videoId: 'verClean0001', title: 'Creep (Clean)', artist: 'Radiohead', itemType: 'video' },
    { videoId: 'verNoMark00', title: 'Creep', artist: 'Radiohead', itemType: 'video' },
  ], { query: 'creep' });
  assert.equal(out.length, 1);
  assert.equal(out[0].videoId, 'verNoMark00', 'the unmarked edit is the keeper over clean');
  assert.equal(out[0].version, undefined);
});

test('a clean edit survives when it is the only upload of the song', () => {
  const out = rankTracks([
    { videoId: 'verCleanOnly', title: 'Creep (Clean)', artist: 'Radiohead', itemType: 'video' },
  ], { query: 'creep' });
  assert.equal(out.length, 1);
  assert.equal(out[0].videoId, 'verCleanOnly');
  assert.equal(out[0].version, 'clean', 'a clean row is offered, but it is marked as clean');
});

test('a typed "clean version" query inverts the preference', () => {
  const out = rankTracks([
    { videoId: 'verNoMark00', title: 'Creep', artist: 'Radiohead', itemType: 'video' },
    { videoId: 'verClean0001', title: 'Creep (Clean)', artist: 'Radiohead', itemType: 'video' },
  ], { query: 'creep clean version' });
  assert.equal(out.length, 1);
  assert.equal(out[0].videoId, 'verClean0001', 'an explicit ask for the clean edit is honoured');
  assert.equal(out[0].version, 'clean');
});

test('clean uploads sink within their score tier', () => {
  // Same score tier (both catalogue songs, both exact-title relevance): the
  // clean upload must not ride YouTube's own ordering to the top.
  const out = rankTracks([
    { videoId: 'verClean010', title: 'Song A (Clean)', itemType: 'song', official: true, durationS: 200 },
    { videoId: 'verPlain011', title: 'Song B', itemType: 'song', official: true, durationS: 200 },
  ], { query: '', limit: 2 });
  assert.deepEqual(out.map((t) => t.videoId), ['verPlain011', 'verClean010']);
});

test('the explicit badge on a catalogue row wins over a clean title', () => {
  // The release says explicit (badge); the upload title says clean. The badge
  // is the release's own claim, so the row is the explicit edit.
  const out = rankTracks([
    { videoId: 'verBadgeWins', title: 'Song (Clean)', badges: [{ icon_type: 'EXPLICIT' }], itemType: 'song', official: true },
    { videoId: 'verPlain012', title: 'Song', itemType: 'song', official: true },
  ], { query: 'song' });
  assert.equal(out.length, 1);
  assert.equal(out[0].videoId, 'verBadgeWins');
  assert.equal(out[0].version, 'explicit');
});

// ── missing rows, non-finite counts, caller-owned objects ────────────────
// These are the three "the parser handed us something odd" cases that used to
// throw or silently corrupt a page: a null row, a NaN metric and a row the
// caller still owns.

test('a missing row is unknown metadata, not a crash', () => {
  assert.equal(isSongDuration(null), true);
  assert.equal(isSongDuration(undefined), true);
  assert.equal(isSongDuration(), true);
  assert.equal(isCompilation(null), false);
  assert.equal(isCompilation(undefined), false);
  assert.equal(isCompilation(), false);
  // And a real short row keeps its verdict.
  assert.equal(isSongDuration({ durationS: 5 }), false);
});

test('non-finite metrics count as zero instead of poisoning a sort', () => {
  assert.equal(toCount(NaN), 0);
  assert.equal(toCount(Infinity), 0);
  assert.equal(toCount(-Infinity), 0);
  assert.equal(toCount(1e400), 0);
  assert.equal(toCount(0), 0, 'a real zero stays zero');
  assert.equal(toCount(1250), 1250);
  assert.equal(toCount('1.2M views'), 1_200_000);
  assert.equal(toCount('junk'), 0);
});

test('ranking never writes a version marker onto the caller’s row', () => {
  const clean = { videoId: 'ownedClean01', title: 'Creep (Clean)', artist: 'Radiohead', itemType: 'video' };
  const out = rankTracks([clean], { query: 'creep' });
  assert.equal(out.length, 1);
  assert.equal('version' in clean, false, 'the caller’s object must not gain a version');
  assert.equal(out[0].version, 'clean', 'the returned copy still carries its version');
  assert.notEqual(out[0], clean, 'and it is a copy when there is something to add');
  // A row that already has its version is returned as it is.
  const stamped = { videoId: 'ownedKnown01', title: 'Creep (Clean)', artist: 'Radiohead', version: 'clean' };
  assert.equal(rankTracks([stamped], { query: 'creep' })[0], stamped);
  // The all-filtered fallback path must not mutate either.
  const tease = { videoId: 'ownedTeaser1', title: 'Snip (Clean)', artist: 'Someone', durationS: 5 };
  const fallback = rankTracks([tease], { query: 'snip' });
  assert.equal(fallback.length, 1);
  assert.equal('version' in tease, false);
});
