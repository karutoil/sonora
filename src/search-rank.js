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

/** A finite integer count; invalid input uses the caller's normal default. */
function normalizedLimit(value, fallback, minimum = 0) {
  let n;
  try { n = Number(value ?? fallback); } catch { return fallback; }
  return Number.isFinite(n) ? Math.max(minimum, Math.floor(n)) : fallback;
}

// Words that describe the *upload*, not the song. A bracketed group containing
// one of these is dropped from the title; "(Acoustic)" or "(Live)" is kept,
// because those are genuinely different recordings.
const QUALIFIER = /\b(?:official(?:\s+(?:music\s+)?video|\s+audio)?|music\s+video|lyrics?|lyric\s+video|audio(?:only)?|visuali[sz]er|hd|hq|4k|8k|explicit|clean|remaster(?:ed)?(?:\s+\d{4})?|feat\.?|ft\.?|featuring)\b/i;

// Words that mark *which edit of the song* this is. They must survive the
// QUALIFIER strip for the de-duplication key — that is the whole point: without
// them "Song (Clean)" and "Song" collapse to one row and the version that
// survives is decided by view counts, not by what the listener asked for.
const VERSION_MARKER = /\b(?:clean|clean\s+version|radio\s+edit|clean\s+radio\s+edit|censored|censored\s+version|radio\s+friendly|family\s+friendly)\b/i;
// And the words that mark the other edit. "Explicit" is also a QUALIFIER word
// (the catalogue badges it), so the badge and the title have to agree.
const EXPLICIT_MARKER = /\b(?:explicit|explicit\s+version|dirty|uncut|uncensored)\b/i;
// In a trailing dash qualifier ("Song - Clean Version") a bare marker is not
// enough: "Taylor Swift - Clean" is a song called Clean. Only a full phrase
// counts there.
const TAIL_VERSION_MARKER = /\b(?:clean\s+version|clean\s+edit|clean\s+radio\s+edit|radio\s+edit|radio\s+version|censored\s+version|edited\s+version|explicit\s+version|uncensored\s+version|uncut\s+version)\b/i;

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
  s = s.toLowerCase().replace(/&/g, ' and ');
  // Fold accents onto their base letter (`Beyoncé` and `Beyonce` are one
  // artist) and compatibility forms onto their plain spelling, but keep every
  // script. The old `[^a-z0-9]` strip reduced "夜に駆ける", "Песня" and "أغنية"
  // to the empty string, so every non-Latin title on a page collided with every
  // other one and the de-duplication threw all but a single song away.
  //
  // Marks are stripped only after a *Latin* letter: Indic, Thai and Arabic
  // vowel marks are part of the spelling, not decoration, so they stay (and
  // NFC puts precomposed forms like أ back together).
  s = s.normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1');
  return s.replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').normalize('NFC').trim();
}

/** A duration in seconds, however it was written; null when it is unknown. */
function secondsOf(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  // Keep finite zero/negative values: they are known-bad metadata, not an
  // unknown duration. Non-finite and non-numeric values remain unknown.
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Which edit of the song this row is: 'clean' (censored), 'explicit', or null
 * (unknown — the vast majority of rows carry neither marker).
 *
 * The row's own badge is authoritative when it exists: YouTube Music catalogues
 * the explicit edit with an "E" badge (`badges` on the row, icon type
 * EXPLICIT), and that badge is the *release's* claim about itself, while the
 * upload title is the uploader's. A badge that says explicit outranks a title
 * that says clean (labels re-title, they do not re-badge). When there is no
 * badge, the title decides — but only the *qualifying* parts of it: the markers
 * are matched against bracketed groups ("Song (Clean)", "Song [Radio Edit]")
 * and a trailing dash-separated qualifier ("Song - Explicit Version"), never
 * against the title as a whole, because "Come Clean" and "Dirty Diana" are
 * song names, not edits. When there is neither badge nor marker the row is
 * unmarked, which is the common case and stays null.
 */
export function trackVersion(track) {
  if (!track || typeof track !== 'object') return null;
  if (track.version === 'explicit' || track.version === 'clean') return track.version;

  // Badges: the library parses them to objects with icon_type/label, raw
  // fixtures use either shape. Anything that says "explicit" (or the bare "E"
  // the up-next panel renders) is an explicit badge; nothing else is a badge
  // we care about — there is no "clean" badge upstream, clean only ever
  // appears in titles, so a non-explicit badge is not evidence of clean.
  const badges = Array.isArray(track.badges) ? track.badges : [];
  for (const b of badges) {
    if (!b || typeof b !== 'object') continue;
    const says = (v) => {
      const s = typeof v === 'string' ? v.toLowerCase() : '';
      return s === 'e' || s.includes('explicit');
    };
    if (says(b.icon_type) || says(b.iconType) || says(b.label) || says(b.text)
      || says(b.tooltip) || says(b.accessibility?.accessibility_data?.label)) return 'explicit';
  }

  const segments = versionSegments(track.title);
  if (!segments) return null;
  if (EXPLICIT_MARKER.test(segments)) return 'explicit';
  if (VERSION_MARKER.test(segments)) return 'clean';
  return null;
}

/**
 * The parts of a title that can carry an edit marker: bracketed groups and a
 * trailing dash/pipe qualifier. null when the title has neither.
 *
 * Bare markers ("Clean", "Dirty") count inside brackets — "[Clean]" on an
 * upload is an edit annotation, and a song genuinely named "Clean" does not
 * put it in brackets after its own name. In a trailing dash qualifier only a
 * full phrase counts ("Song - Clean Version"), because the tail of
 * "Artist - Song" *is* the song name and songs called "Clean" exist.
 */
function versionSegments(raw) {
  const s = String(raw ?? '');
  const brackets = s.match(/[([{][^)\]}]*[)\]}]/g) ?? [];
  const dash = /\s[-–—|]\s*[^-–—|]*$/.exec(s)?.[0] ?? '';
  const hasBareMarker = VERSION_MARKER.test(brackets.join(' '))
    || EXPLICIT_MARKER.test(brackets.join(' '));
  const hasTailMarker = TAIL_VERSION_MARKER.test(dash);
  const segments = [];
  if (hasBareMarker) segments.push(brackets.join(' '));
  if (hasTailMarker) segments.push(dash);
  return segments.length ? segments.join(' ') : null;
}

/**
 * Sort rank of an edit version, for the within-score-tier tie-break: explicit
 * first, unmarked next, clean last. Inverted when the listener asked for the
 * clean edit.
 */
function rankForSort(v, wantsCleanEdit) {
  if (v === 'clean') return wantsCleanEdit ? 2 : 0;
  if (v === 'explicit') return wantsCleanEdit ? 0 : 2;
  return 1;
}

/**
 * Is this a playable song length?
 *
 * Unknown durations pass: a row without metadata is not evidence of anything,
 * and refusing it would hide whole shelves (artist pages carry no durations).
 * A *known* duration outside the bounds is refused, which is what MIN_SONG_SECONDS
 * was always documented to mean — it used to be a score bonus only, so a
 * 15-second teaser scored exactly like a song.
 */
export function isSongDuration(track = {}) {
  // A null/undefined row is "no metadata", not a crash: callers pass whatever a
  // parser produced, and this used to throw on `isSongDuration(null)`.
  const d = secondsOf(track?.durationS);
  if (d == null) return true;
  return d >= MIN_SONG_SECONDS && d <= MAX_SONG_SECONDS;
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
  // Any script counts as naming something: "夜に駆ける" is a title, not an
  // empty right-hand side to be discarded by cardMetadata().
  return /[\p{L}\p{N}]/u.test(String(s ?? '').replace(
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
  const a = String(artist ?? '').trim();
  const channelKey = normalizeTitle(cleanChannelName(ch));
  const artistKey = normalizeTitle(a);
  // Two empty normalization results are not evidence that two identities
  // match. Punctuation/emoji-only names must never inherit an official boost,
  // including through a suffix that would otherwise prove label distribution.
  if (a && (!channelKey || !artistKey)) return false;
  // "Artist - Topic" is label-distributed; "…VEVO" is the label's own network.
  // Both are the artist's own uploads even when the spelling differs.
  if (TOPIC_CHANNEL.test(ch) || VEVO_CHANNEL.test(ch)) return true;
  if (!a) return false;
  return channelKey === artistKey;
}

/** A 4-hour "playlist" video, a full-album upload, a non-stop megamix. */
export function isCompilation(track = {}) {
  // Same guard as isSongDuration: a missing row has no duration and no title, so
  // it is not a compilation — it used to throw when destructured from null.
  const seconds = secondsOf(track?.durationS);
  if (seconds != null && seconds > MAX_SONG_SECONDS) return true;
  const t = String(track?.title ?? '');
  if (/\b(?:\d+\s*(?:hours?|hrs?)|hours?\s+of)\b/i.test(t)) return true;
  return /\b(?:full\s+album|non[- ]?stop|mixtape|megamix)\b/i.test(t);
}

export function toCount(v) {
  // A number is only a count when it is finite: `NaN`/`Infinity` (an unparsed
  // metric, or 1e400 out of JSON) used to be returned as-is and then sorted
  // arbitrary pages against each other.
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const m = /([\d.]+)\s*([KMB])?/i.exec(String(v ?? '').replace(/,/g, ''));
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
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

/** An unambiguous fallback outside normalizeTitle's letter/number alphabet. */
function fallbackIdentity(kind, raw, id) {
  const stableId = String(id ?? '').trim();
  return `~${kind}:${stableId ? `id:${encodeURIComponent(stableId)}` : `raw:${encodeURIComponent(String(raw ?? ''))}`}`;
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
  const normalizedTitle = normalizeTitle(parsed.title);
  const normalizedArtist = normalizeTitle(artist);
  // "!!!" and "???" (or two emoji-only credits) both normalize to "". Sharing
  // that empty key silently merged unrelated rows. A real id is the safest
  // fallback; without one, the exact raw text is deterministic and separates
  // distinct symbols without weakening normal title/artist de-duplication.
  const titleKey = normalizedTitle || fallbackIdentity('title', parsed.title, track.videoId);
  const artistKey = normalizedArtist || fallbackIdentity('artist', artist, track.channelId);
  return {
    titleKey,
    key: `${titleKey}|${artistKey}`,
    haystack: `${normalizedTitle} ${normalizedArtist}`,
  };
}

/** Stable identity of a song, for de-duplicating across sources and playlists. */
export function songKey(track) {
  return describe(track).key;
}

function score(track, described, queryTokens, queryText) {
  let s = 0;
  if (track.official) s += 4;
  if (track.itemType === 'song') s += 2;       // catalogue release, not an upload
  if (track.album) s += 1;
  const seconds = secondsOf(track.durationS);
  if (seconds != null && seconds >= MIN_SONG_SECONDS && seconds <= 900) s += 1;
  // Relevance is graded and it outranks everything above. It used to be a flat
  // +2 for "contains every query word *somewhere*", which meant the flags for
  // *what kind of row it is* (8 points, and every catalogue row claims
  // `official`) decided the page: an unrelated catalogue release beat the
  // upload of the exact song the user typed (08-recommender.md #5).
  s += relevance(described.titleKey, described.haystack, queryTokens, queryText);
  return s;
}

/**
 * How well a row answers the query, on word boundaries, in exclusive tiers.
 *
 * The old test was `haystack.includes(word)`, a plain substring: "one" was
 * matched inside "Money" and "Someone", so a row that had nothing to do with the
 * query collected the full-match bonus. `normalizeTitle` has already reduced
 * every separator to a single space, so comparing whole tokens is both stricter
 * and exact.
 *
 * The tiers do not stack — only the best one applies, so the numbers are the
 * whole relevance contribution:
 *
 *   the title, exactly                                +20
 *   the title, plus what normalizeTitle had to keep   +8   ("(Live)", "(Acoustic)")
 *   every query word, each as a whole word            +4
 *   one of them                                       +1
 *
 * Provenance tops out at 8 (official 4 + catalogue song 2 + album 1 + plausible
 * duration 1) and the best a merely *containing* title can add is the +8 prefix
 * tier, so the exact-title tier has to be worth more than 16 to win outright.
 * It is: a row that is nothing but the title the user typed (20 + 4) outranks an
 * official catalogue release that only mentions it (8 + 8).
 */
function relevance(titleKey, haystack, queryTokens, queryText) {
  if (!queryText) return 0;
  if (titleKey === queryText) return 20;
  if (titleKey.startsWith(`${queryText} `)) return 8;
  const words = new Set(haystack.split(' '));
  const hits = queryTokens.filter((w) => words.has(w)).length;
  if (!hits) return 0;
  return hits === queryTokens.length ? 4 : 1;
}

/**
 * Rank, filter and de-duplicate a mixed list of search hits.
 *
 * - long compilations are dropped (see isCompilation)
 * - known, implausible durations are dropped (see isSongDuration)
 * - the same song by the same artist appears once, whichever source it came from
 * - the same *upload* appears once too, whatever its title parses as
 * - a song title appears at most `maxPerTitle` times, so one cover cannot flood
 *   the page when the real version is right there — but a title shared by
 *   genuinely different songs (three artists' "Stay") is not a reason to hide
 *   two of them, which is why the cap is not 1
 * - when the same song arrives as both a clean and a non-clean upload, the
 *   keeper is the non-clean one, and the row that survives is marked with its
 *   version (see trackVersion). A clean edit is only offered when it is the
 *   only edit that exists — or when the query itself asked for it.
 *
 * Ordering is a stable score sort: the source's own relevance order survives
 * for equal scores, which is what YouTube Music's catalogue ordering is worth.
 */
export function rankTracks(tracks, { query = '', limit = 20, maxPerTitle = 3 } = {}) {
  const resultLimit = normalizedLimit(limit, 20);
  const titleLimit = normalizedLimit(maxPerTitle, 3, 1);
  // Check before the output loop: testing only after push used to return one row
  // for limit=0. Negative limits also slice oddly in the all-filtered fallback.
  if (resultLimit === 0) return [];
  const queryText = normalizeTitle(query);
  const queryTokens = queryText.split(' ').filter((w) => w.length > 1);
  // The listener's own words can ask for the censored edit ("song clean
  // version", "song radio edit"), and that is the one case where a clean row
  // must win its key. Only a full phrase counts: bare "clean" is an artist
  // ("Clean Bandit") as often as an edit request, and a query never carries
  // the bracketed markers a title does.
  const wantsCleanEdit = /\b(?:clean\s+(?:version|edit|cut|radio\s+edit)|(?:clean|radio)\s+edit)\b/i.test(String(query ?? ''));
  // Version preference for the de-duplication keeper: explicit beats unmarked,
  // unmarked beats clean. A clean edit is only the keeper when it is the only
  // upload of the song — or when the query asked for it.
  const rank = (v) => (v === 'explicit' ? 2 : v === 'clean' ? 0 : 1);
  const prefers = wantsCleanEdit
    ? (candidate) => candidate === 'clean'
    : (candidate, current) => rank(candidate) > rank(current);
  const valid = (tracks ?? []).filter((t) => t && t.videoId && t.title);
  const prepared = valid
    .filter((t) => !isCompilation(t) && isSongDuration(t))
    .map((t, i) => {
      const described = describe(t);
      return { t, described, i, s: score(t, described, queryTokens, queryText), v: trackVersion(t) };
    });
  // Score still decides the page; version is the tie-break *within* a score
  // tier, before source order. Two effects, both wanted: the same song's
  // non-clean edit reaches the de-duplication keeper first, and a clean upload
  // sinks below the unmarked uploads it tied with instead of riding YouTube's
  // own ordering to the top.
  prepared.sort((a, b) => b.s - a.s
    || rankForSort(b.v, wantsCleanEdit) - rankForSort(a.v, wantsCleanEdit)
    || a.i - b.i);

  // key -> position in `out`, so a better edit can replace the kept row in place
  // rather than being dropped by the duplicate check.
  const seen = new Map();
  // One search asks two shelves — the Music catalogue and plain video search —
  // and both can contain the *same upload*. The song key catches that only when
  // the two rows agree on title *and* artist, and an upload whose title does not
  // parse as "Artist - Song" takes its artist from the channel instead, so the
  // same video arrived twice with two titles and two sets of art. The id is the
  // only thing that is the same video both times (08-recommender.md #6).
  const seenIds = new Set();
  const perTitle = new Map();
  const out = [];
  const stamp = (t) => {
    // Never write to the caller's row: the same objects come from a cached
    // upstream answer and are shared with other callers (search results, the
    // station, share cards). Marking a version on them would leak one page's
    // decision into every later one. A copy is returned only when there is
    // something to add; otherwise the row is already correct.
    const v = trackVersion(t);
    return v && !t.version ? { ...t, version: v } : t;
  };
  for (const { t, described } of prepared) {
    const version = trackVersion(t);
    const taken = seen.get(described.key);
    if (taken != null) {
      // Same song, possibly a different edit. Replace the kept row only on a
      // strict version win, and keep the replacement in the same position so
      // relevance order still decides where the song sits.
      if (version && prefers(version, out[taken].version ?? null)) {
        seenIds.delete(out[taken].videoId);
        seenIds.add(t.videoId);
        out[taken] = stamp(t);
      }
      continue;
    }
    if (seenIds.has(t.videoId)) continue;
    const n = perTitle.get(described.titleKey) ?? 0;
    if (n >= titleLimit) continue;
    seenIds.add(t.videoId);
    seen.set(described.key, out.length);
    perTitle.set(described.titleKey, n + 1);
    out.push(stamp(t));
    if (out.length >= resultLimit) break;
  }
  if (out.length) return out;

  // Every hit was a mix, a teaser or unusable: an honest page beats an empty
  // one, so the raw rows are offered instead. They are still ordered by
  // relevance and still capped by the limit, and the caller can tell they were
  // nothing but mixes because they are the only rows isCompilation() refuses.
  // The same two de-duplications apply here: these are the same rows from the
  // same two shelves, and showing one video twice is not more honest than
  // showing it once.
  const seenRaw = new Set();
  const seenRawSongs = new Set();
  return valid
    .map((t, i) => {
      const described = describe(t);
      return { t, described, i, s: score(t, described, queryTokens, queryText) };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .filter(({ t, described }) => {
      if (seenRaw.has(t.videoId) || seenRawSongs.has(described.key)) return false;
      seenRaw.add(t.videoId);
      seenRawSongs.add(described.key);
      return true;
    })
    .slice(0, resultLimit)
    .map((p) => stamp(p.t));
}

/**
 * Community playlists, ranked by how well they answer the query and then by
 * popularity, and stripped of anything that is not really a list of songs.
 * `trackCount` is null when it could not be read, and those are kept: a failed
 * lookup must not silently drop everything.
 *
 * `views` used to be the only term, so "chill jazz" came back as the eight
 * most-viewed lists YouTube had, whatever they were lists *of*
 * (08-recommender.md #10). The title is now graded the way a track title is (see
 * relevance) — a list named after the query first, then the most-played of
 * those — and it is the only field a playlist row can be matched on, because the
 * row carries no track list (see parsePlaylistByline).
 *
 * Ties fall back to the order the caller passed the rows in. That order is the
 * *previous* ranking's: youtube.js sorts by views to decide which headers are
 * worth reading, then re-ranks the survivors here with real track counts, so the
 * earlier order is the best popularity evidence available for a row whose count
 * could not be read. It is written out rather than left to Array#sort being
 * stable, so the answer does not depend on the engine.
 */
export function rankPlaylists(playlists, { limit = 12, minTracks = 8, query = '' } = {}) {
  const resultLimit = normalizedLimit(limit, 12);
  const minimumTracks = normalizedLimit(minTracks, 8);
  const queryText = normalizeTitle(query);
  const queryTokens = queryText.split(' ').filter((w) => w.length > 1);
  return (playlists ?? [])
    .filter((p) => p && p.id && p.title)
    .filter((p) => p.trackCount == null || p.trackCount >= minimumTracks)
    .map((p, i) => {
      const titleKey = normalizeTitle(p.title);
      return { p, i, s: relevance(titleKey, titleKey, queryTokens, queryText) };
    })
    // Views arrive as a number from parsePlaylistStats but as a string from
    // other sources; a NaN in the comparator silently makes the sort arbitrary.
    .sort((a, b) => b.s - a.s
      || (Number(b.p.views) || 0) - (Number(a.p.views) || 0)
      || a.i - b.i)
    .slice(0, resultLimit)
    .map(({ p }) => p);
}
