// The personal station: an endless queue built from what this person enjoys.
//
// Two positive signals feed it, and they are deliberately different:
//   * an explicit like (the heart)
//   * listening through most of a track — a `complete`, or a `progress` event at
//     ≥60% of the duration. This is what catches the songs someone loves but
//     never remembered to heart.
// A skip is negative evidence: a track that was only ever skipped never becomes
// a seed, however many times it was started, and one it *keeps* bailing out of
// early is refused until something contradicts that (see rejectedBySkip).
//
// Everything here is pure so the ranking can be tested without YouTube. The
// station is then *expanded* through YouTube's recommender (see server.js) so it
// keeps playing after the familiar songs run out.
//
// The station is endless by construction. It is not one long queue that has to
// be built up front: it is a *page* of the station (see EXTEND_LIMIT) that the
// client tops up when it runs low, seeded by whatever this person liked or
// played through — including the tracks the station itself just introduced
// them to, which is how the catalogue grows instead of looping the same 30.

import { isCompilation, songKey, normalizeTitle, cleanChannelName } from './search-rank.js';

/** Long enough to feel like a station, short enough to build in one request. */
export const STATION_LIMIT = 30;
/**
 * How much one `extend` request returns. Smaller than a first build on purpose:
 * extending happens while a track plays, so it must feel like nothing at all.
 */
export const EXTEND_LIMIT = 20;
/** More seeds than this just means more parallel YouTube lookups. */
export const SEED_LIMIT = 8;
/** At most this many seeds by one artist, so one binge cannot own the station. */
const MAX_SEEDS_PER_ARTIST = 2;

/**
 * How much of the station may come from artists this person already listens to.
 *
 * This is the number that decides whether the station feels like "more of the
 * same" or like finding things. Two out of every three tracks stay familiar —
 * the taste is still the point — and every third slot is a stranger (an
 * artist-adjacent pick or something trending in the same lane). Above one half
 * the queue reads as a loop of the same handful of names, which is exactly the
 * complaint this constant exists to fix.
 */
export const FAMILIAR_SHARE = 0.66;
/**
 * One artist cannot fill the queue. Two in a row from the same band is a
 * playlist; a third is a radio that has stopped trying.
 */
export const MAX_PER_ARTIST = 2;
/**
 * "Same artist" and "known artist" are not the same thing. A seed's *own* band
 * is the most repetitive answer the recommender can give, so it is capped
 * harder than the rest of the familiar pool.
 */
export const MAX_PER_SEED_ARTIST = 2;

/**
 * Every track a station hands over answers one of four questions, and which
 * one it is decides where it sits in the queue:
 *
 *   seed        a song of yours (first page only) — what makes it recognisable
 *   sameArtist  more from an artist you already play
 *   adjacent    a song by one of that artist's neighbours, from YouTube's
 *               "similar artists" / "fans also like" — a new name, same taste
 *   trending    a well-played song in the same lane/decade right now
 *
 * The last two are the discovery half. `lane` is attached to each track so the
 * planner knows what it is holding without being told twice (see withLane).
 */
export const LANE = {
  seed: { key: 'seed' },
  sameArtist: { key: 'sameArtist' },
  adjacent: { key: 'adjacent' },
  trending: { key: 'trending' },
};

const laneKey = (name) => LANE[name]?.key ?? null;

/** Tag a pool of tracks with the lane they came from; returns a new array. */
export function withLane(tracks = [], lane) {
  const key = laneKey(lane);
  if (!key) return (tracks ?? []).slice();
  return (tracks ?? []).map((t) => (t ? { ...t, lane: key } : t));
}

/** How many discovery tracks (`discover` share of the page) a trade should hold. */
export function discoveryTarget({ limit = STATION_LIMIT, share = FAMILIAR_SHARE } = {}) {
  const n = Math.max(0, Math.trunc(Number(limit) || 0));
  return Math.max(1, Math.round(n * (1 - share)));
}

/**
 * How many tracks a page should ask YouTube for, per lane.
 *
 * This is a *plan*, not a guarantee: lanes the station cannot fill (an artist
 * with no catalogue of its own, no trending shelf for a genre) leave their
 * slots to the others, which keeps a thin catalogue from producing a short
 * page. The numbers are deliberately generous — every pool is filtered for
 * duplicates and refusals later, so asking for exactly `limit` returns short.
 */
export function planPage({ limit = STATION_LIMIT, includeSeeds = false, share = FAMILIAR_SHARE } = {}) {
  const n = Math.max(0, Math.trunc(Number(limit) || 0));
  // The first page opens with a couple of songs of yours; extensions are pure
  // discovery and hold none.
  const seeds = includeSeeds ? Math.min(3, Math.max(1, Math.round(n * 0.1))) : 0;
  const discovery = Math.min(Math.max(0, n - seeds), discoveryTarget({ limit: n, share }));
  // "Trending in your lane" is a garnish, not a course: one slot in ten is
  // enough to notice, and more than that turns the station into a chart.
  const trending = Math.max(1, Math.min(Math.round(n * 0.1), Math.floor(discovery / 2)));
  const adjacent = Math.max(0, discovery - trending);
  const sameArtist = Math.max(0, n - seeds - discovery);
  return {
    // `seed` is the lane key slotOrder walks by; `seeds` stays for callers that
    // read the plan as prose (the station blurb and the server logs do).
    seed: seeds,
    seeds,
    sameArtist,
    adjacent,
    trending,
    // What the server asks YouTube for: one extra of everything, because the
    // first few hits are usually songs this person already has.
    fetch: { seeds: seeds + 1, sameArtist: sameArtist + 2, adjacent: adjacent + 2, trending: trending + 3 },
  };
}

export function stationName(userName) {
  const name = String(userName ?? '').trim();
  return name ? `${name}'s station` : 'Your station';
}

/**
 * "Built from 2 songs you played through and 3 you liked."
 * Both counts are subsets of the seeds, so the sentence stays true even when a
 * song is both.
 */
export function stationBlurb({ playedThrough = 0, liked = 0 } = {}) {
  const parts = [];
  if (playedThrough) {
    parts.push(`${playedThrough} ${playedThrough === 1 ? 'song' : 'songs'} you played through`);
  }
  if (liked) parts.push(`${liked} ${liked === 1 ? 'song' : 'songs'} you liked`);
  if (!parts.length) return 'Play a song through, or like one, and this station builds itself.';
  return `Built from ${parts.join(' and ')}.`;
}

/**
 * How much this track earned its place. Deliberately coarse: a like is the
 * strongest signal available, hearing a song to the end is next, and a skip
 * cancels the credit a start would otherwise give.
 */
export function seedScore(t) {
  // A like is the strongest *single* signal: 5. Repeated listening can still
  // beat it (two completions plus a deep play is 6), which is correct — three
  // real listens say more than one tap.
  let score = t.liked ? 5 : 0;
  score += Math.min(Number(t.completes) || 0, 2) * 2;
  const deepest = Number(t.deepest) || 0;
  if (deepest >= 0.85) score += 2;
  else if (deepest >= 0.6) score += 1.5;
  else if (deepest >= 0.3) score += 0.5;
  score -= Math.min(Number(t.skips) || 0, 3);
  if ((Number(t.starts) || 0) >= 2) score += 0.5;
  return score;
}

const artistKey = (t) => normalizeTitle(cleanChannelName(t.channel));

/** The comparison key for an artist name, exposed so callers can pre-bucket. */
export const artistKeyOf = (name) => normalizeTitle(cleanChannelName(name));

/**
 * Which seeds an extension should expand from.
 *
 * The first page of the station expands the *strongest* seeds, which is what
 * makes it open with something recognisable. An extension must not do that
 * again: `upNext` for one seed returns largely the same neighbourhood every
 * time, so re-asking the same three seeds produces the same songs. Rotating
 * through the seed list by how much has already been delivered walks the
 * station outwards instead — the top of the list is the taste this person has
 * expressed most clearly, the tail is the long tail of it, and every pass
 * re-reads the evidence (see stationCandidates) so songs they fell for *on the
 * station* have joined the list by the time the cursor comes round again.
 */
export function rotateSeeds(seeds = [], { cursor = 0, count = 3 } = {}) {
  return rotate((seeds ?? []).filter((s) => s?.videoId), cursor, count);
}

/** The same rotation, for the artist pools an extension also draws from. */
export function rotateArtists(artists = [], { cursor = 0, count = 2 } = {}) {
  return rotate((artists ?? []).filter((a) => a?.name), cursor, count);
}

function rotate(list, cursor, count) {
  const n = list.length;
  if (!n) return [];
  const raw = Math.trunc(Number(cursor) || 0);
  const start = ((raw % n) + n) % n;
  const out = [];
  for (let i = 0; i < Math.min(count, n); i++) out.push(list[(start + i) % n]);
  return out;
}

/**
 * Rank the evidence into seeds.
 *
 * `plays` is the per-track aggregate from the database; `likes` is the liked
 * songs, which are included even when they were never played (a song liked from
 * search results is still something this person wants to hear).
 */
export function rankSeeds({ plays = [], likes = [], disliked = new Set() } = {}, { limit = SEED_LIMIT } = {}) {
  const byId = new Map();
  const base = (videoId) => ({
    videoId, title: null, channel: null, thumb: null, durationS: null,
    completes: 0, skips: 0, starts: 0, deepest: 0, liked: false,
  });

  for (const p of plays) {
    if (!p?.videoId) continue;
    byId.set(p.videoId, {
      ...base(p.videoId),
      title: p.title ?? null,
      channel: p.channel ?? null,
      thumb: p.thumb ?? null,
      durationS: p.durationS ?? null,
      completes: Number(p.completes) || 0,
      skips: Number(p.skips) || 0,
      starts: Number(p.starts) || 0,
      deepest: Math.min(1, Number(p.deepest) || 0),
      liked: false,
    });
  }

  for (const l of likes) {
    if (!l?.videoId) continue;
    const row = byId.get(l.videoId) ?? base(l.videoId);
    byId.set(l.videoId, {
      ...row,
      liked: true,
      title: row.title ?? l.title ?? null,
      channel: row.channel ?? l.channel ?? null,
      thumb: row.thumb ?? l.thumb ?? null,
      durationS: row.durationS ?? l.durationS ?? null,
    });
  }

  const scored = [...byId.values()]
    .map((t) => ({ ...t, score: seedScore(t) }))
    // A title is required to show anything, a 4-hour mix is not a seed, and a
    // dislike is a standing instruction: that track never seeds anything.
    .filter((t) => t.score > 0 && t.title && !isCompilation(t) && !disliked.has(t.videoId))
    .sort((a, b) => b.score - a.score
      || String(a.title).localeCompare(String(b.title)));

  // One artist cannot own the station: a binge would otherwise make every
  // recommendation the same person.
  const perArtist = new Map();
  const out = [];
  for (const t of scored) {
    const key = artistKey(t);
    const n = perArtist.get(key) ?? 0;
    if (key && n >= MAX_SEEDS_PER_ARTIST) continue;
    if (key) perArtist.set(key, n + 1);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The tracks this person has *refused by leaving*: started, then abandoned
 * early, and never engaged with any other way.
 *
 * This is the third signal, next to the like and the play-through, and it is
 * the one a station needs to stop re-offering the same miss. A single early
 * skip is enough, because it is the behaviour that says "not this" most
 * clearly — but it is only conclusive when nothing else contradicts it: a track
 * that was also played through, or liked, was clearly wanted, and a dislike
 * (see dislikedSongKeys) is handled separately and permanently.
 *
 * Reversible on purpose: play the track through once and it stops being
 * rejected, which is what makes an accidental skip recoverable.
 */
export function rejectedBySkip(plays = []) {
  const out = new Set();
  for (const p of plays ?? []) {
    if (!p?.videoId) continue;
    const skips = Number(p.skips) || 0;
    const completes = Number(p.completes) || 0;
    const deepest = Math.min(1, Number(p.deepest) || 0);
    if (skips > 0 && completes === 0 && deepest < 0.25) out.add(p.videoId);
  }
  return out;
}

const isValidTrack = (t) => t
  && typeof t.videoId === 'string' && t.videoId.length === 11
  && Boolean(t.title);

/**
 * Where slot `i` of a page wants to land: familiar taste or something new.
 *
 * Two familiar tracks for every discovery one. Written as a rhythm rather than
 * a quota because the *order* is what the listener hears: a station that plays
 * eleven songs by people they know and then two strangers feels like two
 * different stations stapled together. A steady every-third-track keeps the
 * queue recognisable without letting it become a loop.
 */
export function wantsFamiliar(i) {
  return (Math.trunc(Number(i) || 0) % 3) !== 2;
}

/**
 * Turn a plan's per-lane weights into the order the page is actually built in.
 *
 * Weights alone stack the page: eleven familiar tracks in a row before anybody
 * remembers the discovery lane exists. This walks the lanes round-robin by a
 * *weighted* count, so a 14/5/5 page alternates instead of block-sorting and the
 * first track is one this person knows.
 *
 * The walk uses the smooth weighted round-robin every load balancer uses: each
 * turn, every lane's running credit grows by its weight and the highest credit
 * spends one turn. That produces a spread with no clumps — the 14/5/5 page
 * alternates within the first few slots instead of opening with fourteen of the
 * same lane — and it is deterministic, which matters because tests compare
 * whole queues.
 *
 * The order is built from the *plan*, not from what the pools happened to
 * return: a lane that comes back short simply fails to fill its turn, and the
 * fill loop hands that slot to another lane.
 *
 * Returns lane keys, one per slot, in delivery order.
 */
export function slotOrder(plan = {}, { limit = STATION_LIMIT, order = ['seed', 'sameArtist', 'adjacent', 'trending'] } = {}) {
  const lanes = order
    .map((lane) => ({ lane, weight: Math.max(0, Math.trunc(Number(plan?.[lane]) || 0)), credit: 0 }))
    .filter((l) => l.weight > 0);
  const total = lanes.reduce((n, l) => n + l.weight, 0);
  const slots = Math.max(0, Math.min(Math.trunc(Number(limit) || 0), total));
  const out = [];
  for (let i = 0; i < slots; i++) {
    // Add every lane's weight, then let the richest spend one turn.
    let pick = lanes[0];
    for (const lane of lanes) {
      lane.credit += lane.weight;
      if (lane.credit > pick.credit) pick = lane;
    }
    pick.credit -= total;
    out.push(pick.lane);
  }
  return out;
}

/**
 * Build a page of the station.
 *
 * `seeds` are songs of yours (first page only). `expansions` are the pools the
 * station widens into, each tagged with its lane — pass tracks through
 * withLane() before handing them over, or give `{ tracks, lane }` entries:
 *
 *   sameArtist   more from an artist already in the history (familiar)
 *   adjacent     songs by that artist's neighbours (discovery)
 *   trending     well-played songs in the same lane right now (discovery)
 *
 * A plain array is accepted as a neutral pool (offered in pool order, and
 * counted as discovery when its artist is unknown).
 *
 * What the page does, in order of authority:
 *  1. Refuse what cannot be delivered: disliked videos and songs, anything in
 *     `exclude` (the queue and everything an earlier page handed over),
 *     duplicates, compilations.
 *  2. Cap each artist, hardest for the seed's own artist. "More of the band you
 *     are already listening to" is the cheapest answer a recommender can give,
 *     and YouTube gives it eagerly — its up-next list for a song is often half
 *     that one artist.
 *  3. Hold a ceiling on familiar tracks (FAMILIAR_SHARE), so the page keeps
 *     offering new names instead of circling the same four.
 *  4. Spend the page's slots in an interleaved order (see planPage and
 *     slotOrder) rather than block-sorting by lane.
 *
 * Rules 2–4 are preferences with fallbacks, not hard quotas: when a lane has
 * nothing usable it hands its turn to the others rather than leaving a hole. A
 * familiar page beats a short one, and a short page beats a stall.
 *
 * Refusal is checked twice on purpose:
 *   `disliked`     — the exact videos the user refused
 *   `dislikedSongs`— the same *song* under another upload. "Less like this" is
 *                    an instruction about the song, and the recommender happily
 *                    returns the official audio of a video that was refused.
 */
export function buildStation({
  seeds = [], expansions = [], disliked = new Set(), dislikedSongs = new Set(), limit = STATION_LIMIT,
  exclude = new Set(), knownArtists = new Set(), seedArtists = new Set(), share = FAMILIAR_SHARE,
  plan = null,
} = {}) {
  const seenVideo = new Set();
  const seenSong = new Set();
  const out = [];
  const perArtist = new Map();
  const familiarArtists = new Set(Array.from(knownArtists ?? [], (a) => artistKey({ channel: a })));
  const seedArtistKeys = new Set(Array.from(seedArtists ?? [], (a) => artistKey({ channel: a })));

  const seedPool = { tracks: (seeds ?? []).map((t) => (t ? { ...t, lane: LANE.seed.key } : t)), lane: 'seed' };
  // A pool's lane comes from the tracks themselves when they were tagged (see
  // withLane) and from the entry otherwise. An untagged pool is offered
  // neutrally, but it still has to land somewhere: sameArtist is the honest
  // home for "here are some tracks, nobody said what they are" — it is the
  // familiar half, and the familiar ceiling still applies to anything by an
  // artist this person already plays.
  const tagged = (expansions ?? []).map((entry) => {
    const raw = Array.isArray(entry) ? entry.slice() : (entry?.tracks ?? []).slice();
    const declared = Array.isArray(entry) ? null : entry?.lane ?? null;
    const lane = declared ?? raw.find((t) => t?.lane)?.lane ?? 'sameArtist';
    // Stamp the lane on every track, so the finished page can be counted by
    // lane without the caller having to remember how each pool was built.
    return { tracks: raw.map((t) => (t && !t.lane ? { ...t, lane } : t)), lane };
  });
  const pools = [seedPool, ...tagged].filter((p) => p.tracks.length);
  const discoveryLanes = new Set([LANE.adjacent.key, LANE.trending.key]);

  // How many familiar tracks the page may hold at most.
  const familiarCap = Math.ceil(Math.max(0, limit) * share);
  let familiarCount = 0;
  // Where each lane's rotation currently points (see fill).
  const laneCursor = new Map();

  /** Familiar = one of your own songs, or an artist already in the history. */
  const isFamiliar = (track, pool) => {
    if (pool?.lane === 'seed') return true;
    if (track?.lane && discoveryLanes.has(track.lane)) return false;
    return familiarArtists.has(artistKey(track));
  };

  /** Can this track be queued at all? Duplicates, refusals and caps live here. */
  const usable = (track) => {
    if (out.length >= limit || !isValidTrack(track)) return false;
    if (disliked.has(track.videoId)) return false;
    // `exclude` is what the listener has already been handed: their queue, and
    // everything an earlier page of the station returned. Without it an
    // extension would re-offer the same recommendations forever.
    if (exclude.has(track.videoId)) return false;
    if (seenVideo.has(track.videoId)) return false;
    if (isCompilation(track)) return false;
    const key = songKey(track);
    if (key && dislikedSongs.has(key)) return false;
    if (key && seenSong.has(key)) return false;
    // One name cannot own the station. The seed's own artist is capped hardest.
    const artist = artistKey(track);
    if (artist) {
      const n = perArtist.get(artist) ?? 0;
      if (n >= MAX_PER_ARTIST) return false;
      if (seedArtistKeys.has(artist) && n >= MAX_PER_SEED_ARTIST) return false;
    }
    return true;
  };

  const commit = (track, pool) => {
    seenVideo.add(track.videoId);
    const key = songKey(track);
    if (key) seenSong.add(key);
    const artist = artistKey(track);
    if (artist) perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    if (isFamiliar(track, pool)) familiarCount++;
    out.push(track);
  };

  /**
   * Pull the next usable track for one turn.
   *
   * A turn names a lane, not a pool: several pools can share a lane (three
   * up-next lists are all `sameArtist`). Within a lane the pools are rotated, so
   * two seeds' recommendations interleave instead of the first seed's list
   * draining completely before the second is touched.
   */
  const fill = (lane) => {
    const lanePools = pools.filter((p) => p.lane === lane);
    if (!lanePools.length) return false;
    const start = laneCursor.get(lane) ?? 0;
    for (let i = 0; i < lanePools.length; i++) {
      const pool = lanePools[(start + i) % lanePools.length];
      const at = pool.tracks.findIndex(usable);
      if (at < 0) continue;
      // A familiar track may not push the page past its ceiling, whichever lane
      // it arrived in: a discovery lane can still hand back an artist already in
      // the history, and that counts against the same budget.
      if (isFamiliar(pool.tracks[at], pool) && familiarCount >= familiarCap) continue;
      laneCursor.set(lane, (start + i + 1) % lanePools.length);
      commit(pool.tracks.splice(at, 1)[0], pool);
      return true;
    }
    return false;
  };

  const laneOrder = slotOrder(
    plan ?? planPage({ limit, includeSeeds: seedPool.tracks.length > 0 }),
    { limit },
  );

  // The station opens with one of your own songs whenever there is one: it is
  // the cue that this queue is *yours*, not a genre radio. Everything after
  // that is the interleaved walk, which spreads the remaining seeds through the
  // page instead of stacking them at the front.
  if (seedPool.tracks.length && out.length < limit) fill('seed');

  for (const wanted of laneOrder) {
    if (out.length >= limit) break;
    // Wanted lane first, then every other lane in the same interleaved order:
    // a lane that ran dry hands its turn on rather than leaving a hole, so a
    // page is never short while a pool has something usable.
    for (const lane of [...new Set([wanted, ...laneOrder])]) {
      if (fill(lane)) break;
    }
  }

  return out;
}
