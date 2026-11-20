// Unit tests for the pinned personal station.
//
// The station exists to answer one question: "is this queue mine?" That means
// two promises have to hold, and both are easy to break by accident:
//   1. it only seeds from evidence — a like, or hearing most of a track — so a
//      single skip cannot put a song in someone's station;
//   2. it is not a replay of the history — every seed has to pull in
//      recommendations, and a dislike has to vanish from every layer.
//
// Everything here is pure, so the shapes are pinned without the network —
// except the last test, which has to drive the HTTP surface to prove what the
// route does with a cursor the client should never send.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './helpers/cdp.js';

import {
  rankSeeds, buildStation, seedScore, stationName, stationBlurb, STATION_LIMIT,
  EXTEND_LIMIT, rotateSeeds, rotateArtists, rejectedBySkip,
  planPage, slotOrder, FAMILIAR_SHARE, MAX_PER_ARTIST,
  normalizeStationCursor, advanceStationCursor,
} from '../src/station.js';

const play = (over) => ({
  videoId: 'vid00000001', title: 'A Song', channel: 'An Artist', thumb: null,
  durationS: 200, completes: 0, skips: 0, starts: 1, deepest: 0, ...over,
});
const like = (over) => ({
  videoId: 'lik00000001', title: 'A Liked Song', channel: 'An Artist', thumb: null,
  durationS: 210, ...over,
});
const track = (over) => ({
  videoId: 'rec00000001', title: 'A Recommendation', channel: 'Someone', durationS: 190,
  itemType: 'song', ...over,
});

// ── naming ──────────────────────────────────────────────────────────────

test('the station is named after its owner', () => {
  assert.equal(stationName('admin'), "admin's station");
  assert.equal(stationName('  Ada  '), "Ada's station");
  // No name is not a reason to show "undefined's station".
  assert.equal(stationName(''), 'Your station');
  assert.equal(stationName(null), 'Your station');
});

test('the blurb states the evidence, and says what to do when there is none', () => {
  assert.equal(
    stationBlurb({ playedThrough: 2, liked: 3 }),
    'Built from 2 songs you played through and 3 songs you liked.',
  );
  assert.equal(stationBlurb({ playedThrough: 1 }), 'Built from 1 song you played through.');
  assert.equal(stationBlurb({ liked: 1 }), 'Built from 1 song you liked.');
  assert.match(stationBlurb({}), /Play a song through/);
});

// ── what counts as a seed ───────────────────────────────────────────────

test('hearing most of a track makes it a seed; one skip does not', () => {
  assert.ok(seedScore(play({ deepest: 0.95 })) > 0, 'played through');
  assert.ok(seedScore(play({ completes: 1 })) > 0, 'completed');
  // Started twice and skipped twice: it is not something this person enjoys.
  assert.ok(seedScore(play({ starts: 2, skips: 2, deepest: 0.05 })) <= 0, 'repeated skips cancel out');
});

test('one like outranks one inferred play-through', () => {
  const liked = seedScore({ liked: true, completes: 0, starts: 0, skips: 0, deepest: 0 });
  const played = seedScore({ liked: false, completes: 1, starts: 1, skips: 0, deepest: 0.9 });
  assert.ok(liked > played, 'an explicit like outranks an inferred one');
  // Real repetition is still allowed to beat a single tap: three listens say
  // more about taste than one like does.
  const thrice = seedScore({ liked: false, completes: 2, starts: 3, skips: 0, deepest: 1 });
  assert.ok(thrice > liked, 'listening repeatedly can outrank a like');
});

test('seeds come from likes and listening, and a dislike removes one', () => {
  const candidates = {
    plays: [
      play({ videoId: 'playedThru1', title: 'Loved It', deepest: 0.92 }),
      play({ videoId: 'skippedOne1', title: 'Not For Me', starts: 2, skips: 2, deepest: 0.04 }),
    ],
    likes: [like({ videoId: 'explicitOne', title: 'Hearted It' })],
  };
  const seeds = rankSeeds(candidates);
  const ids = seeds.map((s) => s.videoId);
  assert.ok(ids.includes('playedThru1'), 'a track played through seeds the station');
  assert.ok(ids.includes('explicitOne'), 'a liked song seeds the station');
  assert.ok(!ids.includes('skippedOne1'), 'a track that was only skipped must not seed');

  const withoutDislike = rankSeeds({ ...candidates, disliked: new Set(['playedThru1']) });
  assert.ok(!withoutDislike.map((s) => s.videoId).includes('playedThru1'),
    'a disliked track cannot seed the station');
});

test('one artist cannot own the station', () => {
  const plays = Array.from({ length: 6 }, (_, i) => play({
    videoId: `sameArtist0${i}`, title: `Song ${i}`, channel: 'One Band', completes: 1, deepest: 0.9,
  }));
  const seeds = rankSeeds({ plays }, { limit: 6 });
  const byOne = seeds.filter((s) => s.channel === 'One Band').length;
  assert.ok(byOne <= 2, `a binge would otherwise make every recommendation the same band (got ${byOne})`);
});

test('compilations never seed the station', () => {
  const seeds = rankSeeds({
    plays: [play({ videoId: 'longMix0001', title: '4 Hours of Chill', durationS: 4 * 3600, completes: 2, deepest: 1 })],
  });
  assert.equal(seeds.length, 0);
});

test('only a like, a complete, or genuinely deep listening makes a seed', () => {
  const seeds = rankSeeds({
    plays: [
      play({ videoId: 'bareStart01', title: 'Bare Start', channel: 'Bare Artist', starts: 2 }),
      play({ videoId: 'shallow0001', title: 'Thirty Percent', channel: 'Shallow Artist', deepest: 0.3 }),
      play({ videoId: 'almostDeep1', title: 'Fifty Nine Percent', channel: 'Almost Artist', starts: 2, deepest: 0.59 }),
      play({ videoId: 'deepEnough1', title: 'Sixty Percent', channel: 'Deep Artist', deepest: 0.6 }),
      play({ videoId: 'completed01', title: 'Completed', channel: 'Complete Artist', completes: 1 }),
    ],
    likes: [like({ videoId: 'liked000001', title: 'Liked', channel: 'Liked Artist' })],
  }, { limit: 20 });
  assert.deepEqual(new Set(seeds.map((s) => s.videoId)), new Set([
    'deepEnough1', 'completed01', 'liked000001',
  ]));
});

test('song-level dislikes are removed before the upstream seed draw', () => {
  const seeds = rankSeeds({
    plays: [
      play({ videoId: 'refused001a', title: 'Refused Song (Official Video)', channel: 'Band', completes: 1 }),
      play({ videoId: 'refused001b', title: 'Refused Song', channel: 'Band', itemType: 'song', completes: 1 }),
      play({ videoId: 'otherSong01', title: 'Other Song', channel: 'Other Artist', completes: 1 }),
    ],
    dislikedSongs: new Set(['refused song|band']),
  });
  assert.deepEqual(seeds.map((s) => s.videoId), ['otherSong01']);
});

test('duplicate song uploads do not waste the seed quota', () => {
  const seeds = rankSeeds({
    plays: [
      play({ videoId: 'sameSong01a', title: 'Same Song (Official Video)', channel: 'Band', completes: 2 }),
      play({ videoId: 'sameSong01b', title: 'Same Song', channel: 'Band', itemType: 'song', completes: 2 }),
      play({ videoId: 'otherSong01', title: 'Other Song', channel: 'Other Artist', completes: 1 }),
    ],
  }, { limit: 3 });
  assert.equal(seeds.filter((s) => s.title.includes('Same Song')).length, 1, 'one song spends one seed slot');
  assert.ok(seeds.some((s) => s.videoId === 'otherSong01'), 'deduplication leaves room for another artist');
});

test('station candidates keep a known channel id for direct artist lookups', () => {
  const fromPlay = rankSeeds({
    plays: [play({ videoId: 'channelPlay', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', completes: 1 })],
  });
  const fromLike = rankSeeds({
    likes: [like({ videoId: 'channelLike', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb' })],
  });
  assert.equal(fromPlay[0].channelId, 'UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(fromLike[0].channelId, 'UCbbbbbbbbbbbbbbbbbbbbbb');
});

// ── the finished queue ──────────────────────────────────────────────────

test('the station interleaves your songs with recommendations', () => {
  const seeds = [{ videoId: 'seedA000001', title: 'Mine A' }, { videoId: 'seedB000001', title: 'Mine B' }];
  const expansions = [
    [track({ videoId: 'recA0000001', title: 'More A' }), track({ videoId: 'recA0000002', title: 'More A2' })],
    [track({ videoId: 'recB0000001', title: 'More B' })],
  ];
  const out = buildStation({ seeds, expansions });
  assert.deepEqual(out.slice(0, 4).map((t) => t.videoId),
    ['seedA000001', 'recA0000001', 'recB0000001', 'seedB000001'],
    'the queue opens with a song of yours, then one from each expansion');
});

test('a station made only of the history is not padded out with it', () => {
  // Two seeds, no recommendations: the queue is short and honest rather than
  // repeating the same songs to fill the limit.
  const out = buildStation({
    seeds: [track({ videoId: 'onlyA000001', title: 'Only A' })],
    expansions: [],
  });
  assert.equal(out.length, 1);
});

test('dislikes are filtered out of recommendations too', () => {
  const out = buildStation({
    seeds: [track({ videoId: 'seedA000001', title: 'Mine A' })],
    expansions: [[
      track({ videoId: 'hated000001', title: 'Recommended But Hated' }),
      track({ videoId: 'wanted00001', title: 'Recommended And Welcome' }),
    ]],
    disliked: new Set(['hated000001']),
  });
  assert.deepEqual(out.map((t) => t.videoId), ['seedA000001', 'wanted00001']);
});

test('the same song is not queued twice, however it arrived', () => {
  const out = buildStation({
    seeds: [track({ videoId: 'seedA000001', title: 'Creep', artist: 'Radiohead' })],
    expansions: [[
      track({ videoId: 'creepCopy01', title: 'Creep (Official Music Video)', channel: 'Radiohead' }),
      track({ videoId: 'creepLive01', title: 'Creep (Live)', channel: 'Radiohead' }),
    ]],
  });
  const titles = out.map((t) => t.title);
  assert.equal(titles.filter((t) => /^Creep$/.test(t)).length, 1, 'the same song must not repeat');
  assert.ok(titles.some((t) => /Live/.test(t)), 'a genuinely different version survives');
});

test('compilations are never queued', () => {
  const out = buildStation({
    seeds: [track({ videoId: 'seedA000001', title: 'Mine A' })],
    expansions: [[
      track({ videoId: 'longMix0001', title: '8 Hours of Ambient', durationS: 8 * 3600 }),
      track({ videoId: 'fineSong001', title: 'A Fine Song' }),
    ]],
  });
  assert.deepEqual(out.map((t) => t.videoId), ['seedA000001', 'fineSong001']);
});

test('malformed recommendations are dropped rather than rendered', () => {
  const out = buildStation({
    seeds: [track({ videoId: 'seedA000001', title: 'Mine A' })],
    expansions: [[
      { videoId: 'short', title: 'Bad id' },
      { videoId: 'validEnough', title: null },
      null,
      track({ videoId: 'goodOne0001', title: 'Good' }),
    ]],
  });
  assert.deepEqual(out.map((t) => t.videoId), ['seedA000001', 'goodOne0001']);
});

test('the queue respects its limit and terminates on duplicates', () => {
  const same = track({ videoId: 'sameOne0001', title: 'Same' });
  const out = buildStation({
    seeds: [track({ videoId: 'seedA000001', title: 'Mine A' })],
    expansions: [Array.from({ length: 200 }, () => ({ ...same }))],
    limit: 5,
  });
  assert.equal(out.length, 2, 'only one copy of a repeated recommendation is kept');
  assert.ok(STATION_LIMIT >= 20, 'the default station is long enough to listen to');
});

test('a disliked *song* cannot come back as a different upload', () => {
  // "Less like this" is about the song. The recommender returns the official
  // audio of a refused video under another id, which reads as being ignored.
  const out = buildStation({
    seeds: [track({ videoId: 'seedA000001', title: 'Mine A' })],
    expansions: [[
      track({ videoId: 'otherUpload', title: 'Refused Song (Official Audio)', channel: 'Some Band' }),
      track({ videoId: 'fineSong001', title: 'A Fine Song' }),
    ]],
    disliked: new Set(['refusedVid01']),
    dislikedSongs: new Set(['refused song|some band']),
  });
  assert.deepEqual(out.map((t) => t.videoId), ['seedA000001', 'fineSong001']);
});

// ── the endless station ─────────────────────────────────────────────────
// A station is not a 30-song playlist. These pin the three things that make it
// endless without making it repetitive: a cursor that walks the seeds, a
// refusal to re-offer what was already delivered, and the skip signal that
// stops a rejected song coming back on the next page.

test('the seed cursor walks the list instead of always expanding the top', () => {
  const seeds = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ videoId: `seed000000${id}`, score: 9 - i }));
  assert.deepEqual(rotateSeeds(seeds, { cursor: 0 }).map((s) => s.videoId.slice(-1)), ['a', 'b', 'c']);
  assert.deepEqual(rotateSeeds(seeds, { cursor: 3 }).map((s) => s.videoId.slice(-1)), ['d', 'e', 'a'],
    'a page after the first starts somewhere else');
  // The cursor wraps rather than running off the end, and a negative or silly
  // cursor still lands inside the list.
  assert.deepEqual(rotateSeeds(seeds, { cursor: 5 }).map((s) => s.videoId.slice(-1)), ['a', 'b', 'c']);
  assert.deepEqual(rotateSeeds(seeds, { cursor: -1 }).map((s) => s.videoId.slice(-1)), ['e', 'a', 'b']);
  assert.equal(rotateSeeds(seeds, { cursor: 2, count: 99 }).length, 5, 'asking for more than exist returns all');
  for (const cursor of [Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_SAFE_INTEGER * 2]) {
    assert.deepEqual(rotateSeeds(seeds, { cursor }).map((s) => s.videoId.slice(-1)), ['a', 'b', 'c'],
      `unsafe cursor ${cursor} resets instead of producing holes`);
  }
  assert.deepEqual(rotateSeeds([], { cursor: 4 }), [], 'an empty seed list is not an error');
});

test('route cursors are safe integers and advance without unsafe arithmetic', () => {
  for (const value of [undefined, null, 'abc', Infinity, -Infinity, Number.MAX_VALUE, 9_007_199_254_740_992, -5, 2.7]) {
    const cursor = normalizeStationCursor(value);
    assert.ok(Number.isSafeInteger(cursor) && cursor >= 0, `${value} -> ${cursor}`);
    assert.ok(Number.isSafeInteger(advanceStationCursor(cursor)));
  }
  assert.equal(advanceStationCursor(3), 6);
  assert.equal(advanceStationCursor(Number.MAX_SAFE_INTEGER), 0, 'the cursor wraps before it can stick');
});

test('artists rotate too, so the station does not stay on two bands', () => {
  const artists = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
  assert.deepEqual(rotateArtists(artists, { cursor: 0 }).map((a) => a.name), ['A', 'B']);
  assert.deepEqual(rotateArtists(artists, { cursor: 3 }).map((a) => a.name), ['D', 'A']);
  assert.deepEqual(rotateArtists([{ name: '' }, null], { cursor: 0 }), [], 'nameless artists are skipped');
});

test('an extension never hands back a track the queue already holds', () => {
  const out = buildStation({
    expansions: [[
      track({ videoId: 'alreadyHave', title: 'Already Queued' }),
      track({ videoId: 'freshOne001', title: 'Fresh' }),
    ]],
    exclude: new Set(['alreadyHave']),
    limit: 5,
  });
  assert.deepEqual(out.map((t) => t.videoId), ['freshOne001']);
});

test('a track skipped early is refused until something contradicts the skip', () => {
  const skipped = rejectedBySkip([
    play({ videoId: 'skippedOne1', skips: 1, completes: 0, deepest: 0.05 }),
    play({ videoId: 'heardItOut1', skips: 1, completes: 1, deepest: 1 }),
    play({ videoId: 'likedAndSkip', skips: 1, completes: 0, deepest: 0.1 }),
    play({ videoId: 'neverSkipped', skips: 0, completes: 0, deepest: 0.4 }),
  ]);
  assert.ok(skipped.has('skippedOne1'), 'started then abandoned early is refused');
  assert.ok(!skipped.has('heardItOut1'), 'playing it through cancels the skip');
  assert.ok(skipped.has('likedAndSkip'),
    'the raw skip set does not know about likes — the caller subtracts those');
  assert.ok(!skipped.has('neverSkipped'), 'a partial listen is not a refusal');
});

test('the endless queue refuses the skipped track on the next page', () => {
  const out = buildStation({
    expansions: [[
      track({ videoId: 'skippedOne1', title: 'Bailed On This' }),
      track({ videoId: 'welcomeOne1', title: 'Welcome' }),
    ]],
    exclude: rejectedBySkip([play({ videoId: 'skippedOne1', skips: 1, deepest: 0.02 })]),
  });
  assert.deepEqual(out.map((t) => t.videoId), ['welcomeOne1']);
});

test('EXTEND_LIMIT is a page, not a playlist', () => {
  assert.ok(EXTEND_LIMIT >= 10, 'a page is worth several tracks of listening');
  assert.ok(EXTEND_LIMIT <= STATION_LIMIT, 'extending is cheaper than the first build');
});

// ── breadth: the same artist must not own the station ───────────────────
// Reported by the person using it: "I only get songs from the same artist more
// than new songs from different artists". The station is still *theirs* — two
// familiar tracks for every discovery one — but a page that circles four names
// is not a station, it is a playlist of the history with extra steps.

/** n songs by one artist. Ids are unique per artist + index. */
const artist = (name, n, over = {}) => Array.from({ length: n }, (_, i) => track({
  videoId: `${name.toLowerCase().slice(0, 4)}${String(i).padStart(7, '0')}`.slice(0, 11),
  title: `${name} song ${i}`,
  channel: name,
  ...over,
}));
/** n songs by n different artists, all named "<prefix> <i>". */
const artists = (prefix, n) => Array.from({ length: n }, (_, i) => track({
  videoId: `${prefix.slice(0, 4)}n${String(i).padStart(6, '0')}`.slice(0, 11),
  title: `${prefix} ${i}`,
  channel: `${prefix} ${i}`,
}));

test('a page is mostly familiar, with a discovery track every third', () => {
  const plan = planPage({ limit: 30, includeSeeds: true });
  const counts = slotOrder(plan, { limit: 30 }).reduce((m, l) => ({ ...m, [l]: (m[l] ?? 0) + 1 }), {});
  assert.equal(counts.seed + counts.sameArtist, 20, 'two thirds familiar');
  assert.equal(counts.adjacent + counts.trending, 10, 'one third discovery');
  assert.ok(counts.trending <= 4, 'trending is a garnish, not a course');
});

test('the plan always adds up to the page it is planning', () => {
  for (const [limit, seeds] of [[30, true], [20, false], [12, false], [7, true]]) {
    const plan = planPage({ limit, includeSeeds: seeds });
    const total = plan.seed + plan.sameArtist + plan.adjacent + plan.trending;
    assert.equal(total, limit, `plan for ${limit} (seeds=${seeds}) must fill the page`);
    assert.equal(slotOrder(plan, { limit }).length, limit);
  }
});

test('lanes are interleaved, not block-sorted', () => {
  // A page that plays 17 familiar tracks and then 7 strangers reads as two
  // stations stapled together. The order has to alternate from the start.
  const order = slotOrder({ seed: 3, sameArtist: 17, adjacent: 7, trending: 3 }, { limit: 30 });
  const firstFive = order.slice(0, 5);
  assert.ok(new Set(firstFive).size >= 3, `the page must open with a mix, got ${firstFive.join(',')}`);
  assert.equal(order.filter((l) => l === 'trending').length, 3);
  // Nothing is starved: every lane appears in the first third of the page.
  const firstThird = new Set(order.slice(0, 10));
  for (const lane of ['seed', 'sameArtist', 'adjacent', 'trending']) {
    assert.ok(firstThird.has(lane), `${lane} must appear early`);
  }
});

test('no single artist can fill the queue', () => {
  const out = buildStation({
    expansions: [{ tracks: artist('Creed', 20), lane: 'sameArtist' }],
    knownArtists: new Set(['Creed']),
    plan: { seed: 0, sameArtist: 20, adjacent: 0, trending: 0 },
    limit: 20,
  });
  assert.equal(out.length, 2, 'two songs by one band, then the lane is spent');
  assert.ok(out.every((t) => t.channel === 'Creed'));
});

test('the familiar half cannot become the whole page', () => {
  // Plenty of familiar material and nothing new: the page stays inside the
  // familiar ceiling rather than quietly becoming a replay of the history.
  const out = buildStation({
    expansions: [{ tracks: artist('Radiohead', 20), lane: 'sameArtist' }],
    knownArtists: new Set(['Radiohead']),
    limit: 30,
  });
  assert.ok(out.length <= Math.ceil(30 * FAMILIAR_SHARE), `got ${out.length} familiar tracks`);
});

test('discovery tracks fill the page when familiar material runs out', () => {
  // The point of the fallback: a thin familiar pool must not shorten the page.
  const out = buildStation({
    seeds: [track({ videoId: 'seedA000001', title: 'Mine A', channel: 'Known' })],
    expansions: [
      { tracks: artist('Known', 2), lane: 'sameArtist' },
      { tracks: artists('Stranger', 12), lane: 'adjacent' },
    ],
    knownArtists: new Set(['Known']),
    limit: 10,
  });
  assert.equal(out.length, 10, 'the page is still full');
  assert.ok(out.filter((t) => /^Stranger \d/.test(t.channel)).length >= 5,
    'the discovery lane takes over the turns it is given and the ones it inherits');
});

test('a discovery lane cannot smuggle a familiar artist past the ceiling', () => {
  // "Adjacent" is a claim about where a track came from, not a guarantee about
  // who made it: a neighbour search happily returns the band you already play.
  const out = buildStation({
    expansions: [
      { tracks: artist('Radiohead', 10), lane: 'adjacent' },
      { tracks: artist('sonora', 10), lane: 'adjacent' },
    ],
    knownArtists: new Set(['Radiohead']),
    limit: 30,
  });
  const familiar = out.filter((t) => t.channel === 'Radiohead').length;
  assert.ok(familiar <= MAX_PER_ARTIST, `a familiar artist got ${familiar} slots through a discovery lane`);
});

test('a station with no seed artists still gets a mix', () => {
  // An extension page has no seeds, and a genre vote can come back empty. The
  // page must still alternate instead of draining one lane first.
  const out = buildStation({
    expansions: [
      { tracks: artists('Familiar', 10), lane: 'sameArtist' },
      { tracks: artists('Newcomer', 10), lane: 'adjacent' },
    ],
    knownArtists: new Set(Array.from({ length: 10 }, (_, i) => `Familiar ${i}`)),
    plan: { seed: 0, sameArtist: 13, adjacent: 5, trending: 2 },
    limit: 20,
  });
  assert.equal(out.length, 20);
  const kinds = out.map((t) => t.lane);
  assert.ok(kinds.slice(0, 4).includes('adjacent'), 'a new artist appears in the first four tracks');
});

// ── the route's own guard rails ─────────────────────────────────────────
// `cursor` is client-supplied arithmetic. `Number('Infinity')` is Infinity, and
// `Math.max(0, Math.trunc(Infinity))` keeps it: rotate() computed
// `((Infinity % n) + n) % n` = NaN, picked seed `undefined`, and the page
// answered 500. This needs the HTTP route, so it boots a throwaway server.

test('a non-finite station cursor is clamped instead of answering 500', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cursor-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const ROOT = new URL('..', import.meta.url).pathname;
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'cursor.db'),
      SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'cursor-test-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOGIN_RATE_MAX: '1000',
      SONORA_LOG_LEVEL: 'warn',
      // Nothing upstream is reachable in a unit suite; a fresh database has no
      // seeds, so the route answers from local inference without a network call.
      SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '', SONORA_RESOLVE_TIMEOUT_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i += 1) {
      try {
        const r = await fetch(`${base}/api/health`);
        up = r.ok && (await r.json()).pid === child.pid;
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, `the station fixture started:\n${logs.join('')}`);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin', passphrase: 'hunter2hunter2' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie()[0].split(';')[0];

    for (const cursor of ['Infinity', '1e400', '-5', 'abc', '2.7', '9007199254740992', '1.7976931348623157e308']) {
      const res = await fetch(`${base}/api/station/next?cursor=${encodeURIComponent(cursor)}`, {
        headers: { cookie },
      });
      assert.equal(res.status, 200, `cursor=${cursor} must answer, not 500`);
      const body = await res.json();
      assert.ok(Number.isSafeInteger(body.cursor) && body.cursor >= 0,
        `cursor=${cursor} must come back safe and finite, got ${JSON.stringify(body.cursor)}`);
      assert.deepEqual(body.tracks, [], 'a fresh database has nothing to extend with');
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

// ── song-level exclusion, empty pages and 0-weight lanes ────────────────
// An extension is handed the ids it already delivered, and an id is only one
// upload of a song: the recommender returns the other upload of it happily.

test('an excluded song cannot return as a different upload', () => {
  const delivered = {
    videoId: 'delivrd0001', title: 'Blinding Lights (Official Video)', channel: 'The Weeknd',
    durationS: 200,
  };
  const out = buildStation({
    expansions: [[
      track({ videoId: 'othrUpld001', title: 'Blinding Lights (Official Audio)', channel: 'The Weeknd' }),
      track({ videoId: 'freshSong01', title: 'A Fresh Song', channel: 'Someone Else' }),
    ]],
    // The row itself, as the server passes it: buildStation derives the song key.
    exclude: new Set([delivered, 'goneId00001']),
    limit: 5,
  });
  assert.deepEqual(out.map((t) => t.videoId), ['freshSong01'],
    'the same song from another upload is the same repeat');
  // A bare id still excludes exactly that upload.
  const byId = buildStation({
    expansions: [[track({ videoId: 'othrUpld001', title: 'Blinding Lights', channel: 'The Weeknd' })]],
    exclude: new Set(['othrUpld001']),
    limit: 5,
  });
  assert.deepEqual(byId, []);
});

test('ranking zero seeds is an empty answer, not the best seed', () => {
  const evidence = { likes: [like({ videoId: 'liked000001' })], plays: [] };
  assert.deepEqual(rankSeeds(evidence, { limit: 0 }), []);
  assert.deepEqual(rankSeeds(evidence, { limit: -3 }), []);
  assert.deepEqual(rankSeeds(evidence, { limit: Number.NaN }), []);
  assert.deepEqual(rankSeeds(evidence, { limit: 1 }).map((s) => s.videoId), ['liked000001']);
});

test('a lane with no plan weight still fills a short page', () => {
  // The plan says "no trending on this page", but the other pools came back with
  // one track between them. A 1-track page is worse than a trending one.
  const expansions = [
    { tracks: [track({ videoId: 'onlyFam0001', title: 'Familiar Only', channel: 'Known' })], lane: 'sameArtist' },
    { tracks: [track({ videoId: 'onlyTrnd001', title: 'Trending Only', channel: 'Stranger' })], lane: 'trending' },
  ];
  const plan = { seed: 0, sameArtist: 3, adjacent: 0, trending: 0 };
  const out = buildStation({
    expansions,
    plan,
    limit: 3,
    knownArtists: new Set(['Known']),
  });
  assert.equal(out.length, 2, `both pools must be used, got ${out.map((t) => t.videoId).join(',')}`);
  assert.deepEqual(out.map((t) => t.videoId).sort(), ['onlyFam0001', 'onlyTrnd001']);
  // And the planned limit is still a limit: a 4th candidate is not admitted.
  const capped = buildStation({
    expansions,
    plan,
    limit: 1,
    knownArtists: new Set(['Known']),
  });
  assert.equal(capped.length, 1);
});
