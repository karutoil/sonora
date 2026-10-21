// Ranking and de-duplication for YouTube search results.
//
// Plain video search is a marketplace of re-uploads: one song arrives as the
// official video, the official audio, three lyric channels and a lyric-video
// channel, so a results page fills with the same track from everyone *except*
// the artist. Mood queries are worse: "rnb" is answered with 4-hour single-video
// "playlists" that are not lists of anything, so there is no song to pick.
//
// The Music catalogue (yt.music.search) is far cleaner, but still repeats a song
// across releases and still returns long mixes for mood words. These rules
// clean up both sources. They are pure functions on plain objects so they can be
// tested without the network.

/** Longer than this is not a song, it is a mix or a full-album upload. */
export const MAX_SONG_SECONDS = 20 * 60;
/** Shorter than this is a jingle, interlude or preview. */
export const MIN_SONG_SECONDS = 20;

// Words that describe the *upload*, not the song. A bracketed group containing
// one of these is dropped from the title; "(Acoustic)" or "(Live)" is kept,
// because those are genuinely different recordings.
const QUALIFIER = /\b(?:official(?:\s+(?:music\s+)?video|\s+audio)?|music\s+video|lyrics?|lyric\s+video|audio(?:only)?|visuali[sz]er|hd|hq|4k|8k|explicit|clean|remaster(?:ed)?(?:\s+\d{4})?|feat\.?|ft\.?|featuring)\b/i;

const TOPIC_CHANNEL = /\s*-\s*topic$/i;
const VEVO_CHANNEL = /\s*vevo$/i;

/**
 * "Blinding Lights (Official Video) [HD]" and "Blinding Lights (Lyrics)"
 * both reduce to "blinding lights"; "Blinding Lights (Acoustic)" does not.
 */
export function normalizeTitle(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[([{][^)\]}]*[)\]}]/g, (m) => (QUALIFIER.test(m) ? ' ' : m));
  s = s.replace(/\s*[-–—|/]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visuali[sz]er|hd|4k)\b.*$/i, ' ');
  s = s.replace(/\b(?:feat|ft|featuring)\.?\s+.+$/i, ' ');
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * "The Weeknd - Blinding Lights (Official Video)" -> { artist, title }.
 *
 * Only trusted when the left side looks like a credit (a few words), so
 * "Love - Part 2" stays a title instead of inventing an artist called "Love".
 */
export function parseVideoTitle(raw) {
  const title = String(raw ?? '').trim();
  const m = /^(.{1,48}?)\s+[-–—]\s+(.+)$/.exec(title);
  if (!m) return { artist: null, title };
  const artist = m[1].trim();
  if (artist.split(/\s+/).length > 5) return { artist: null, title };
  return { artist, title: m[2].trim() };
}

/** Is the uploader the artist (or the label channel acting for them)? */
export function cleanChannelName(channel) {
  return String(channel ?? '').replace(TOPIC_CHANNEL, '').replace(VEVO_CHANNEL, '').trim();
}

/**
 * Strip the parts of a title that describe the *upload* rather than the song,
 * keeping the original case so the result can be shown to a person.
 *
 * "DaBaby - POP DAT THANG (Official Music Video) [HD]" -> "POP DAT THANG",
 * while "Blinding Lights (Acoustic)" survives intact.
 */
function cleanForCard(raw) {
  return String(raw ?? '')
    .replace(/[([{][^)\]}]*[)\]}]/g, (m) => (QUALIFIER.test(m) ? ' ' : m))
    .replace(/\s*[-\u2013\u2014|/]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visuali[sz]er|hd|hq|4k|8k)\b.*$/i, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-\u2013\u2014|/]+|[\s\-\u2013\u2014|/]+$/g, '')
    .trim();
}

/** Does this string still say anything once the qualifier words are gone? */
function namesSomething(s) {
  return /[a-z0-9]/i.test(String(s ?? '').replace(
    /\b(?:official|music|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|8k|explicit|clean|feat|ft|featuring|remaster(?:ed)?)\b/gi,
    '',
  ));
}

/**
 * Title and artist as they should read on a link-preview card.
 *
 * YouTube titles are written for search, not for a card: a shared track should
 * read "POP DAT THANG" by "DaBaby", not "DaBaby - POP DAT THANG (Official
 * Music Video)". The split is only trusted when the right-hand side still names
 * something — otherwise "Song - Official Video" would produce an artist called
 * "Song" and a track called "Official Video".
 *
 * Never returns an empty title: a card with a messy title beats a blank one.
 */
export function cardMetadata({ title, channel } = {}) {
  const raw = String(title ?? '').trim();
  const split = parseVideoTitle(raw);
  const useSplit = Boolean(split.artist) && namesSomething(split.title);
  const name = useSplit ? cleanForCard(split.title) : cleanForCard(raw);
  const artist = useSplit ? split.artist : cleanChannelName(channel);
  return { title: name || raw, artist: String(artist ?? '').trim() };
}

export function isOfficialChannel(channel, artist) {
  const ch = String(channel ?? '').trim();
  if (!ch) return false;
  // "Artist - Topic" is label-distributed; "…VEVO" is the label's own network.
  // Both are the artist's own uploads even when the spelling differs.
  if (TOPIC_CHANNEL.test(ch) || VEVO_CHANNEL.test(ch)) return true;
  const a = String(artist ?? '').trim();
  if (!a) return false;
  return normalizeTitle(cleanChannelName(ch)) === normalizeTitle(a);
}

/** A 4-hour "playlist" video, a full-album upload, a non-stop megamix. */
export function isCompilation({ title, durationS } = {}) {
  if (Number.isFinite(durationS) && durationS > MAX_SONG_SECONDS) return true;
  const t = String(title ?? '');
  if (/\b(?:\d+\s*(?:hours?|hrs?)|hours?\s+of)\b/i.test(t)) return true;
  return /\b(?:full\s+album|non[- ]?stop|mixtape|megamix)\b/i.test(t);
}

export function toCount(v) {
  if (typeof v === 'number') return v;
  const m = /([\d.]+)\s*([KMB])?/i.exec(String(v ?? '').replace(/,/g, ''));
  if (!m) return 0;
  const n = Number(m[1]);
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] ?? 1;
  return Math.round(n * scale);
}

/** The release formats a catalogue byline can lead with, as they should read. */
const RELEASE_FORMAT = {
  album: 'Album', single: 'Single', ep: 'EP', compilation: 'Compilation', soundtrack: 'Soundtrack',
};

/**
 * The artist out of a playlist row's "Author • 299K views" byline.
 *
 * A `MusicResponsiveListItem` playlist row has no author field: the name and the
 * popularity share one line. Reading the whole line as the author printed
 * "299K views" as the person who made the list, so the segments that read as a
 * count are skipped.
 */
export function parsePlaylistByline(second) {
  const parts = String(second ?? '').split('\u2022').map((s) => s.trim()).filter(Boolean);
  const author = parts.find((p) => !/\b(?:views|plays|tracks?|songs?|hours?|minutes?|updated)\b/i.test(p)
    && !/^[\d.,]+\s*[KMB]?$/i.test(p));
  return { author: author ?? null };
}

/**
 * "Album • Radiohead • 1997" -> the release's own byline.
 *
 * The order is fixed (format, artist, year) but any part can be missing, so each
 * is recognised by its shape rather than by its position.
 */
export function parseReleaseByline(second) {
  const parts = String(second ?? '').split('\u2022').map((s) => s.trim()).filter(Boolean);
  const format = parts.map((p) => RELEASE_FORMAT[p.toLowerCase()]).find(Boolean) ?? null;
  const year = parts.find((p) => /^\d{4}$/.test(p)) ?? null;
  const author = parts.find((p) => RELEASE_FORMAT[p.toLowerCase()] == null && p !== year) ?? null;
  return { format, author, year };
}

/**
 * Read the stats line a Music playlist header carries:
 * "3.4M views • 147 tracks • 11+ hours".
 */
export function parsePlaylistStats(second) {
  const s = String(second ?? '');
  const views = /([\d.,]+\s*[KMB]?)\s*views?/i.exec(s);
  const tracks = /([\d.,]+)\s*(?:tracks?|songs?)/i.exec(s);
  return {
    views: views ? toCount(views[1]) : null,
    trackCount: tracks ? toCount(tracks[1]) : null,
  };
}

/** The song title and credited artist used to decide two rows are one song. */
function describe(track) {
  const isSong = track.itemType === 'song';
  const parsed = isSong
    ? { artist: null, title: track.title }
    : parseVideoTitle(track.title);
  const artist = parsed.artist
    ?? track.artist
    ?? cleanChannelName(track.channel);
  const titleKey = normalizeTitle(parsed.title);
  return {
    titleKey,
    key: `${titleKey}|${normalizeTitle(artist)}`,
    haystack: `${titleKey} ${normalizeTitle(artist)}`,
  };
}

/** Stable identity of a song, for de-duplicating across sources and playlists. */
export function songKey(track) {
  return describe(track).key;
}

function score(track, described, queryTokens) {
  let s = 0;
  if (track.official) s += 4;
  if (track.itemType === 'song') s += 2;       // catalogue release, not an upload
  if (track.album) s += 1;
  if (Number.isFinite(track.durationS)
    && track.durationS >= MIN_SONG_SECONDS && track.durationS <= 900) s += 1;
  // A track that covers every word of the query is the one that was asked for.
  if (queryTokens.length && queryTokens.every((w) => described.haystack.includes(w))) s += 2;
  return s;
}

/**
 * Rank, filter and de-duplicate a mixed list of search hits.
 *
 * - long compilations are dropped (see isCompilation)
 * - the same song by the same artist appears once, whichever source it came from
 * - a song title appears at most `maxPerTitle` times, so one cover cannot flood
 *   the page when the real version is right there
 *
 * Ordering is a stable score sort: the source's own relevance order survives
 * for equal scores, which is what YouTube Music's catalogue ordering is worth.
 */
export function rankTracks(tracks, { query = '', limit = 20, maxPerTitle = 1 } = {}) {
  const queryTokens = normalizeTitle(query).split(' ').filter((w) => w.length > 1);
  const prepared = (tracks ?? [])
    .filter((t) => t && t.videoId && t.title)
    .filter((t) => !isCompilation(t))
    .map((t, i) => {
      const described = describe(t);
      return { t, described, i, s: score(t, described, queryTokens) };
    });
  prepared.sort((a, b) => b.s - a.s || a.i - b.i);

  const seen = new Set();
  const perTitle = new Map();
  const out = [];
  for (const { t, described } of prepared) {
    if (seen.has(described.key)) continue;
    const n = perTitle.get(described.titleKey) ?? 0;
    if (n >= maxPerTitle) continue;
    seen.add(described.key);
    perTitle.set(described.titleKey, n + 1);
    out.push(t);
    if (out.length >= limit) break;
  }

  // Every hit was a mix/compilation: an unfiltered list beats an empty page.
  return out.length ? out : (tracks ?? []).slice(0, limit);
}

/**
 * Community playlists, ranked by popularity and stripped of anything that is
 * not really a list of songs. `trackCount` is null when it could not be read,
 * and those are kept: a failed lookup must not silently drop everything.
 */
export function rankPlaylists(playlists, { limit = 12, minTracks = 8 } = {}) {
  return (playlists ?? [])
    .filter((p) => p && p.id && p.title)
    .filter((p) => p.trackCount == null || p.trackCount >= minTracks)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, limit);
}
