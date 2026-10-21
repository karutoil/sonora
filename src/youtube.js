import { Innertube } from 'youtubei.js';
import { config } from './config.js';
import { activeCookieHeader } from './cookies.js';
import {
  rankTracks, rankPlaylists, parsePlaylistStats, parsePlaylistByline, parseReleaseByline,
  parseVideoTitle, isOfficialChannel, cleanChannelName, toCount, songKey,
} from './search-rank.js';

const IOS_UA = 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)';

let ytPromise = null;

/** One shared Innertube session; creating one per request burns memory. */
export function getYT() {
  ytPromise ??= (async () => {
    // Prefer an imported jar so a signed-in session also helps Innertube (it is
    // the same identity that unblocks yt-dlp).
    const cookie = activeCookieHeader();
    return Innertube.create({ retrieve_player: false, ...(cookie ? { cookie } : {}) });
  })().catch((err) => {
    ytPromise = null;
    throw err;
  });
  return ytPromise;
}

/** Drop the cached session so a freshly imported cookie jar takes effect. */
export function resetYT() {
  ytPromise = null;
}

/** True when YouTube is refusing playback until we prove we are not a bot. */
export function isBotGated(info) {
  const reason = String(info?.playability_status?.reason ?? '');
  return info?.playability_status?.status === 'LOGIN_REQUIRED'
    && /not a bot|sign in/i.test(reason);
}

function text(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return v.text ?? v.toString?.() ?? null;
}

function toTrack(v) {
  const id = v.video_id ?? v.id;
  if (typeof id !== 'string' || id.length !== 11) return null;
  // `author` is a plain string on a PlaylistPanelVideo (the up-next panel) and
  // an object elsewhere; reading only `.name` silently dropped every artist
  // from radio and the personal station.
  const author = v.author;
  const artists = (v.artists ?? []).map((a) => a?.name).filter(Boolean);
  return {
    videoId: id,
    title: text(v.title) ?? text(v.name),
    channel: artists.join(', ') || text(author?.name ?? author) || text(v.channel?.name ?? v.channel) || null,
    channelId: v.author?.id ?? v.channel?.id ?? v.artists?.[0]?.channel_id ?? null,
    durationS: v.duration?.seconds ?? null,
    thumb: v.thumbnails?.[0]?.url ?? v.thumbnail?.[0]?.url ?? null,
    album: text(v.album?.name ?? v.album) || null,
  };
}

const withTimeout = (p, ms, label) => {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
    t.unref?.();
  });
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

/**
 * A YouTube Music catalogue row (`MusicResponsiveListItem`). Songs arrive with
 * the credited artist and album, which is what makes de-duplication possible.
 */
function toMusicTrack(v) {
  const id = v.id ?? v.video_id;
  if (typeof id !== 'string' || id.length !== 11) return null;
  const title = typeof v.title === 'string' ? v.title : text(v.title);
  if (!title) return null;
  const artists = (v.artists ?? v.authors ?? []).map((a) => a?.name).filter(Boolean);
  // Album track rows have no credits at all and YouTube fills the gap with the
  // literal string "N/A", which then leaks into the artist column and blocks
  // the album header's own artist from being used as a fallback.
  const credit = (s) => (s && !/^N\/?A$/i.test(s) ? s : null);
  // Some catalogue rows have an empty artists array; their second flex column
  // is "Artist • Album • 3:05", which is enough to credit the song properly.
  const byline = String(text(v.flex_columns?.[1]?.title) ?? '').split('\u2022').map((s) => s.trim());
  const artist = credit(artists[0]) ?? credit(v.author?.name) ?? credit(byline[0]) ?? null;

  // An artist's top-songs shelf splits the same information across separate
  // columns — "Creep" | "Radiohead" | "2.3B plays" | "Pablo Honey" — and
  // carries no `album` object and no duration at all. Without reading those
  // columns, every popular song of an artist would show an empty album.
  const flex = (v.flex_columns ?? []).map((c) => text(c.title)).filter(Boolean).slice(1);
  const parts = flex.flatMap((s) => String(s).split('\u2022').map((x) => x.trim())).filter(Boolean);
  const plays = parts.find((p) => /\b(?:plays|views)\b/i.test(p)) ?? null;
  const albumFromColumns = [...parts].reverse().find((p) => (
    credit(p)
    && p !== artist
    && !/\b(?:plays|views)\b/i.test(p)
    && !/^\d+:\d\d$/.test(p)
  )) ?? null;

  return {
    videoId: id,
    title,
    artist,
    channel: artists.join(', ') || artist,
    channelId: v.artists?.[0]?.channel_id ?? v.author?.channel_id ?? null,
    durationS: v.duration?.seconds ?? null,
    // The catalogue thumbnail is the artist avatar; the video thumbnail is the
    // artwork every other screen already proxies by id, so prefer that.
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    album: v.album?.name ?? credit(byline.length > 1 ? byline[1] : null) ?? albumFromColumns,
    // The album's browse id (MPR…) is what "Open album" needs. Catalogue rows
    // carry it; up-next rows do not, which is why albumForVideo() exists.
    albumId: v.album?.id ?? null,
    // Present on artist shelves ("2.3B plays"), absent elsewhere.
    ...(plays ? { views: toCount(plays) } : {}),
    itemType: 'song',
    official: true,
  };
}

/**
 * A plain video hit. Its uploader is often a lyric channel, not the artist, so
 * the credited artist is parsed out of "Artist - Song" and kept separately.
 */
function toVideoTrack(v) {
  const base = toTrack(v);
  if (!base) return null;
  const { artist } = parseVideoTitle(base.title);
  return {
    ...base,
    artist: artist ?? cleanChannelName(base.channel),
    itemType: 'video',
    official: isOfficialChannel(base.channel, artist),
  };
}

/**
 * Search that returns songs, not uploads of songs.
 *
 * The Music catalogue is the primary source: it carries real releases, with the
 * credited artist and album, and it does not include the lyric-channel and
 * re-upload noise that dominates plain video search. Video results are merged
 * in (and de-duplicated against the songs) only when the catalogue is thin,
 * so an obscure query still finds something.
 */
export async function searchTracks(query, limit = 20) {
  const yt = await getYT();

  let songs = [];
  try {
    const res = await withTimeout(yt.music.search(query, { type: 'song' }), config.resolveTimeoutMs, 'search');
    songs = (res?.songs?.contents ?? []).map(toMusicTrack).filter(Boolean);
  } catch {
    // The Music client is a separate endpoint and can fail on its own (client
    // version, gating). Plain video search is the historical path; use it.
  }

  let videos = [];
  if (songs.length < limit) {
    const res = await withTimeout(yt.search(query, { type: 'video' }), config.resolveTimeoutMs, 'search');
    videos = (res.videos ?? []).map(toVideoTrack).filter(Boolean);
  }

  return rankTracks([...songs, ...videos], { query, limit });
}

/**
 * Raw community-playlist hits for a query.
 *
 * One search call, one filter: community playlists are PL/VLPL ids, while
 * auto-mixes (MPSPP…, RD…) are not lists a user can open and pick songs from.
 * Every playlist caller goes through here so that rule is stated once.
 */
async function playlistHits(query) {
  const yt = await getYT();
  const res = await withTimeout(
    yt.music.search(query, { type: 'playlist' }),
    config.resolveTimeoutMs,
    'playlist search',
  );
  return (res?.playlists?.contents ?? [])
    .map((p) => {
      if (!p?.id || !/^(?:VL)?PL/.test(p.id)) return null;
      const title = typeof p.title === 'string' ? p.title : text(p.title);
      if (!title) return null;
      // The row's own byline is "Author • 299K views"; the node carries neither
      // field, so both have to be read out of that line.
      const byline = text(p.flex_columns?.[1]?.title);
      return {
        id: p.id,
        title,
        author: p.author?.name ?? parsePlaylistByline(byline).author,
        thumb: thumbFrom(p),
        ...parsePlaylistStats(byline),
      };
    })
    .filter(Boolean);
}

/**
 * Community playlists that are really lists of songs, most-viewed first.
 *
 * The search row only carries views, so the length of the shortlist is
 * confirmed from each playlist's own header: a "playlist" holding one 4-hour
 * video is not a list of songs. `verify` caps how many headers are read — a
 * combined search tab wants fast, a mood screen wants thorough.
 */
async function playlistResults(query, { limit = 12, verify = 10, minTracks = 8 } = {}) {
  const shortlist = rankPlaylists(await playlistHits(query), { limit: verify, minTracks: 0 });
  const yt = await getYT();
  const checked = await Promise.all(shortlist.map(async (p) => {
    if (p.trackCount != null) return p;
    try {
      const pl = await withTimeout(yt.music.getPlaylist(p.id), config.resolveTimeoutMs, 'playlist');
      return { ...p, ...parsePlaylistStats(text(pl?.header?.second_subtitle)) };
    } catch {
      return p; // unknown length: keep it rather than hide a working playlist
    }
  }));

  return rankPlaylists(checked, { limit, minTracks });
}

/**
 * Community playlists for a mood word — the answer to "browse by feeling".
 *
 * A mood is not a song, so searching songs for it returns 4-hour single-video
 * mixes. Searching playlists returns actual lists. Headers give views, which is
 * the only popularity signal available, and the track count that proves the
 * list is one.
 */
export async function searchMoodPlaylists(query, limit = 12) {
  return playlistResults(query, { limit, verify: 10 });
}

/**
 * Playlists for an ordinary search, for the client's Playlists tab.
 *
 * Same source and the same list-of-songs rule as a mood lookup; a few fewer
 * headers are verified because this answer shares one request with songs,
 * albums and artists and must not hold them up.
 */
export async function searchPlaylists(query, limit = 12) {
  return playlistResults(query, { limit, verify: 8 });
}

/**
 * YouTube's own recommender graph. This is the free, strong signal for a
 * single user: 50 related tracks with ids, no model required.
 */
export async function upNext(videoId, limit = 25) {
  const yt = await getYT();
  const res = await withTimeout(yt.music.getUpNext(videoId, true), config.resolveTimeoutMs, 'upNext');
  const items = res?.contents ?? res?.items ?? [];
  return items.map(toTrack).filter((t) => t && t.videoId !== videoId).slice(0, limit);
}

/**
 * The catalogued artist for a name: a channel id, or null.
 *
 * Up-next knows who made each track but not their channel id, so a station
 * that wants an artist's *other* songs has to look the artist up once. Results
 * are ranked by audience (see searchArtists) so a fan re-upload channel does
 * not win over the real artist.
 */
export async function artistIdFor(name) {
  const q = String(name ?? '').trim();
  if (!q) return null;
  const yt = await getYT();
  const res = await withTimeout(yt.music.search(q, { type: 'artist' }), config.resolveTimeoutMs, 'artist search');
  const hit = res?.artists?.contents?.[0];
  const id = hit?.id ?? hit?.channel_id ?? null;
  return typeof id === 'string' && /^UC[\w-]{20,}$/.test(id) ? id : null;
}

/**
 * An artist page, reduced to the two things a station needs from it:
 * their songs (the catalogue, not one up-next neighbourhood) and the artists
 * YouTube files next to them ("Fans might also like").
 *
 * The top-songs shelf is the first section and has no title; the rest are
 * Albums, Singles & EPs, Videos, … The adjacent list is what lets the station
 * move one step sideways *inside* the listener's taste instead of asking the
 * same band for the same songs again.
 */
/**
 * One album shelf row (`MusicTwoRowItem` with item_type "album").
 *
 * The id is the album's browse id (MPR…), which is what `music.getAlbum`
 * accepts. The subtitle carries the format — "Album • 2021", "Single • 2021" —
 * and is the only place the distinction appears.
 */
function toAlbumItem(v) {
  const id = v?.id;
  if (typeof id !== 'string' || !/^MPR[\w-]+$/.test(id)) return null;
  const title = text(v.title);
  if (!title) return null;
  const subtitle = text(v.subtitle) ?? '';
  return {
    id,
    title,
    year: v.year ?? /(\d{4})/.exec(subtitle)?.[1] ?? null,
    type: /single|\bep\b/i.test(subtitle) ? 'Single' : 'Album',
    thumb: thumbFrom(v),
  };
}

/**
 * A video row on an artist page ("Videos", "Live performances").
 *
 * These are `MusicTwoRowItem`s, not catalogue songs: no album, no duration, and
 * the byline is "Artist • 1.5B views". The thumbnail is the video's own still.
 */
function toShelfVideo(v) {
  const id = v?.id;
  if (typeof id !== 'string' || id.length !== 11) return null;
  const title = text(v.title);
  if (!title) return null;
  const by = text(v.subtitle) ?? '';
  const channel = by.split('\u2022')[0].trim() || null;
  return {
    videoId: id,
    title,
    artist: channel,
    channel,
    channelId: null,
    durationS: null,
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    album: null,
    itemType: 'video',
    official: true,
  };
}

/**
 * An artist page: who they are, their popular songs, their releases, and the
 * artists YouTube files next to them.
 *
 * The top-songs shelf is the first section and has no title; the rest are
 * Albums, Singles & EPs, Videos, Live performances, Featured on, Playlists by…
 * and "Fans might also like". Reading the headings rather than the order keeps
 * this working when YouTube adds or drops a shelf.
 */
export async function artistPage(artistId) {
  const yt = await getYT();
  const page = await withTimeout(yt.music.getArtist(artistId), config.resolveTimeoutMs, 'artist');
  const sections = page?.sections ?? [];
  const heading = (s) => text(s?.header?.title) ?? '';
  const contents = (re) => sections.find((s) => re.test(heading(s)))?.contents ?? [];
  const header = page?.header;

  const songs = (sections.find((s) => !heading(s))?.contents ?? [])
    .map(toMusicTrack).filter(Boolean);
  const adjacent = contents(/might also like/i)
    .map((c) => ({
      name: text(c.title) ?? text(c.name),
      id: c.id ?? null,
      thumb: thumbFrom(c),
    }))
    .filter((c) => c.name && /^UC[\w-]{20,}$/.test(c.id ?? ''));

  return {
    id: artistId,
    name: text(header?.title) ?? null,
    // MusicImmersiveHeader keeps the avatar on `.thumbnail.contents`; other
    // header variants expose a plain array. Accept both.
    thumb: header?.thumbnail?.contents?.[0]?.url ?? header?.thumbnail?.[0]?.url ?? null,
    description: text(header?.description) ?? null,
    songs,
    albums: contents(/^albums$/i).map(toAlbumItem).filter(Boolean),
    singles: contents(/^singles/i).map(toAlbumItem).filter(Boolean),
    videos: contents(/^videos$|live performances/i).map(toShelfVideo).filter(Boolean),
    adjacent,
  };
}

/**
 * What the station needs from an artist page: their songs and their neighbours.
 * Kept as its own export because the station asks for hundreds of these and
 * should not start depending on the page's presentation shelves.
 */
export async function artistProfile(artistId) {
  const { name, songs, adjacent } = await artistPage(artistId);
  return { name, songs, adjacent };
}

/**
 * A real album (MPR… browse id), not a playlist.
 *
 * Album rows carry no artist or album credit of their own, so both are filled
 * from the header — otherwise every track opened from an album would lose the
 * artist that made the page findable in the first place.
 */
export async function albumPage(albumId) {
  const yt = await getYT();
  const page = await withTimeout(yt.music.getAlbum(albumId), config.resolveTimeoutMs, 'album');
  const header = page?.header;
  const title = text(header?.title) ?? null;
  const subtitle = text(header?.subtitle) ?? '';
  const artist = text(header?.strapline_text_one) ?? text(header?.strapline) ?? null;
  // The strapline's run carries the artist's channel, which is the canonical
  // way back to their page (a name would have to be re-resolved by search).
  const artistId = header?.strapline_text_one?.runs
    ?.map((r) => r.endpoint?.payload?.browseId)
    ?.find((id) => /^UC[\w-]{20,}$/.test(id ?? '')) ?? null;
  const tracks = (page?.contents ?? [])
    .map(toMusicTrack)
    .filter(Boolean)
    .map((t) => ({
      ...t,
      artist: t.artist ?? artist,
      channel: t.channel ?? artist,
      // The album this page *is* — not whatever a row's byline happened to
      // contain (album rows often say "N/A" there).
      album: title ?? t.album,
      // The album a track came from is the page it was opened on, which is
      // cheaper and more accurate than re-deriving it from a search.
      albumId,
    }));
  return {
    title,
    author: artist,
    authorId: artistId,
    type: /single|\bep\b/i.test(subtitle) ? 'Single' : 'Album',
    year: /(\d{4})/.exec(subtitle)?.[1] ?? null,
    thumb: header?.thumbnail?.contents?.[0]?.url ?? null,
    tracks,
  };
}

// videoId -> { albumId, title, author } | null. "Which release is this upload
// from" never changes, so a miss is cached too (as null).
const albumOfCache = new Map();

/**
 * The album a track belongs to, resolved from the Music catalogue.
 *
 * A catalogue row already carries its album id, but up-next, videos and older
 * library rows do not. Searching the catalogue for the track and matching on
 * video id — or, when the upload differs, on the song's identity — is the only
 * honest way to answer "open the album of this song". A miss stays a miss: a
 * wrong album is worse than a disabled button.
 */
export async function albumForVideo(videoId, meta = {}) {
  if (albumOfCache.has(videoId)) return albumOfCache.get(videoId);
  const yt = await getYT();
  let { title, artist } = meta;
  if (!title) {
    try {
      const info = await withTimeout(
        yt.getBasicInfo(videoId, { client: 'IOS' }),
        config.resolveTimeoutMs,
        'getBasicInfo',
      );
      title = info.basic_info?.title ?? null;
      artist = artist ?? info.basic_info?.author ?? null;
    } catch {
      // Fall through: without a title there is nothing to search for.
    }
  }

  // An upload title is "Artist - Song (Official Video)"; the catalogue row is
  // "Song". Searching the raw upload title biases the result to the upload
  // itself, so the credit and the qualifiers are stripped first.
  const parsed = parseVideoTitle(title ?? '');
  const songTitle = parsed.artist ? parsed.title : (title ?? '');
  const credited = parsed.artist ?? artist ?? null;

  let found = null;
  if (songTitle) {
    const q = [songTitle, credited].filter(Boolean).join(' ');
    try {
      const res = await withTimeout(
        yt.music.search(q, { type: 'song' }),
        config.resolveTimeoutMs,
        'album lookup',
      );
      const rows = (res?.songs?.contents ?? []).map(toMusicTrack).filter((t) => t?.albumId);
      // Match on the *song* identity, not the upload title: the same recording
      // is usually a different video id on the album than the video upload.
      const wanted = songKey({ title: songTitle, artist: credited ?? '', itemType: 'song' });
      const hit = rows.find((r) => r.videoId === videoId)
        ?? rows.find((r) => songKey({ ...r, itemType: 'song' }) === wanted);
      if (hit) {
        found = {
          albumId: hit.albumId,
          title: hit.album ?? null,
          author: hit.artist ?? credited ?? null,
        };
      }
    } catch {
      // A failed lookup is not cached as a miss; it may succeed later.
      return null;
    }
  }

  albumOfCache.set(videoId, found);
  if (albumOfCache.size > 500) albumOfCache.delete(albumOfCache.keys().next().value);
  return found;
}

/**
 * Moods and genres as YouTube Music files them, e.g. `genreTiles()` ->
 * [{ name: 'Rock', params }, …].
 *
 * This is the one place where "which lane is this person in" can be answered
 * from YouTube rather than guessed: the same tiles the app's mood page shows.
 * Cached for the session — the list changes about as often as the site does.
 */
let genreTilesPromise = null;
export function genreTiles() {
  genreTilesPromise ??= (async () => {
    const yt = await getYT();
    const feed = await withTimeout(yt.music.getExplore(), config.resolveTimeoutMs, 'explore');
    const shelf = (feed?.sections ?? []).find((s) => /moods/i.test(text(s.header?.title) ?? ''));
    return (shelf?.contents ?? [])
      .map((v) => ({
        name: text(v.button_text) ?? text(v.text) ?? text(v.title),
        params: v.endpoint?.payload?.params ?? null,
        browseId: v.endpoint?.payload?.browseId ?? null,
      }))
      .filter((g) => g.name && g.params && g.browseId);
  })().catch((err) => {
    genreTilesPromise = null;
    throw err;
  });
  return genreTilesPromise;
}

/**
 * The songs YouTube Music puts on a genre page — the "what is big in this lane
 * right now" shelf, 50 rows, ordered by YouTube itself.
 *
 * Deliberately read from the *browse* payload rather than the typed parser:
 * the shelf is a raw `musicCarouselShelfRenderer` here, because the Music
 * client wraps this page in its own renderers. Reading the raw shape is ugly
 * but it is the actual contract, and it is checked by the live test.
 */
export async function genreSongs(genre, limit = 20) {
  const name = String(genre ?? '').trim();
  if (!name) return [];
  const yt = await getYT();
  const tiles = await genreTiles();
  const tile = tiles.find((g) => g.name.toLowerCase() === name.toLowerCase())
    ?? tiles.find((g) => g.name.toLowerCase().includes(name.toLowerCase()));
  if (!tile) return [];

  const res = await withTimeout(
    yt.actions.execute('/browse', { browseId: tile.browseId, params: tile.params, client: 'YTMUSIC' }),
    config.resolveTimeoutMs,
    'genre songs',
  );
  const data = res?.data ?? res;
  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const heading = (s) => s?.musicCarouselShelfRenderer?.header?.musicCarouselShelfBasicHeaderRenderer
    ?.title?.runs?.map((r) => r.text).join('') ?? null;
  const shelf = sections.find((s) => /^songs$/i.test(heading(s) ?? ''))
    ?? sections.find((s) => /^music videos$/i.test(heading(s) ?? ''));
  const rows = shelf?.musicCarouselShelfRenderer?.contents ?? [];

  return rows
    .map(rawMusicRow)
    .filter(Boolean)
    // The genre page already ranks by popularity; the byline carries the views
    // so the caller can prefer bigger songs without a second lookup.
    .slice(0, limit);
}

/**
 * One row of a raw `musicResponsiveListItemRenderer`.
 *
 * Only used for pages the typed parser does not cover (genre shelves). The
 * columns are "Title / Artist • 86M views / Album", and the video id sits on
 * the thumbnail's play button — the title's own endpoint is a browse link.
 */
function rawMusicRow(item) {
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const col = (i) => (r.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [])
    .map((x) => x.text).join('');
  const title = col(0)?.trim();
  const byline = col(1) ?? '';
  const videoId = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
    ?.playNavigationEndpoint?.watchEndpoint?.videoId
    ?? r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
      ?.navigationEndpoint?.watchEndpoint?.videoId
    ?? null;
  if (!videoId || typeof videoId !== 'string' || videoId.length !== 11 || !title) return null;
  const [artistPart] = byline.split('\u2022');
  const artist = artistPart?.trim() || null;
  const views = /([\d.,]+\s*[KMB]?)\s*views?/i.exec(byline);
  return {
    videoId,
    title,
    artist,
    channel: artist,
    durationS: null,
    thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    album: col(2)?.trim() || null,
    views: views ? toCount(views[1]) : 0,
    itemType: 'song',
    official: true,
  };
}

/**
 * What is trending right now, unfiltered by genre. Used only when the station
 * has no better lane: it is the last-resort discovery pool, and it is capped
 * to a couple of tracks by the caller so a station never turns into a chart.
 */
export async function exploreTrending(limit = 12) {
  const yt = await getYT();
  const feed = await withTimeout(yt.music.getExplore(), config.resolveTimeoutMs, 'explore');
  const section = (feed?.sections ?? []).find((s) => /trending/i.test(text(s.header?.title) ?? ''));
  return (section?.contents ?? [])
    .map((v) => (v?.item_type === 'song' || v?.item_type === 'video' ? toMusicTrack(v) : null))
    .filter(Boolean)
    .slice(0, limit);
}

// videoId -> { url, mime, bitrate, expiresAt }
const urlCache = new Map();

/**
 * Is this an ongoing live broadcast? yt-dlp cannot "download" one (it would
 * read forever), so this is checked before starting a fetch.
 *
 * Best effort: if the lookup fails (bot gate, timeout, transient outage) this
 * returns false and playback proceeds. A failed *check* must never stop a
 * track that could otherwise play.
 */
export async function isLive(videoId) {
  try {
    const yt = await getYT();
    const info = await withTimeout(
      yt.getBasicInfo(videoId, { client: 'IOS' }),
      config.resolveTimeoutMs,
      'getBasicInfo',
    );
    return Boolean(info.basic_info?.is_live ?? false);
  } catch {
    return false;
  }
}

/**
 * Lyrics via YouTube Music. Best effort: a track without lyrics is normal, not
 * an error, so this resolves to null instead of throwing. Verified against a
 * real track (Radiohead - Creep) returning ~800 chars of plain text.
 */
export async function fetchLyrics(videoId) {
  const yt = await getYT();
  try {
    const shelf = await withTimeout(yt.music.getLyrics(videoId), config.resolveTimeoutMs, 'lyrics');
    const d = shelf?.description;
    const text = typeof d === 'string' ? d : d?.toString?.() ?? null;
    return text && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Real releases and channels for the library tabs.
 *
 * youtubei.js 18.2 returns search hits as a unified `results` array instead of
 * typed shelves: playlists arrive as `LockupView` (id in `content_id`, title in
 * `metadata.title`) and artists as `Channel`. Both shapes are handled, plus the
 * older typed shelves, so a future API shuffle degrades instead of going blank.
 */
function thumbFrom(node) {
  let url = node?.thumbnails?.[0]?.url
    // `MusicTwoRowItem` exposes the avatar/cover as a plain `thumbnail` array.
    ?? node?.thumbnail?.[0]?.url
    ?? node?.author?.thumbnails?.[0]?.url;
  if (!url) {
    const img = node?.content_image?.primary_thumbnail?.image
      ?? node?.content_image?.image
      ?? node?.primary_thumbnail?.image;
    url = img?.[0]?.url ?? img?.url ?? null;
  }
  if (!url) return null;
  // YouTube returns protocol-relative URLs for channel avatars (//yt3.ggpht…).
  return url.startsWith('//') ? `https:${url}` : url;
}

/** Parse "12M subscribers" / "1.2K videos" into a number for ranking. */
function lockupTitle(node) {
  const t = node?.metadata?.title;
  return typeof t === 'string' ? t : t?.text ?? t?.toString?.() ?? null;
}

function lockupSubtitle(node) {
  const rows = node?.metadata?.metadata?.metadata_rows ?? [];
  const parts = rows.flatMap((r) => (r.metadata_parts ?? []).map((p) => p?.text?.text ?? p?.text ?? ''));
  return parts.filter(Boolean).join(' · ') || null;
}

/**
 * A release row from the catalogue's Albums shelf.
 *
 * Rows read `OK Computer` | `Album • Radiohead • 1997`, and the id is the real
 * browse id (MPR…), which is what makes the release openable. The shelf has no
 * track count: that lives on the album page, which is one more call than a
 * search tab can afford per row.
 */
function toReleaseItem(v) {
  const id = v?.id;
  if (typeof id !== 'string' || !/^MPR[\w-]+$/.test(id)) return null;
  const title = text(v.title);
  if (!title) return null;
  const byline = parseReleaseByline(text(v.flex_columns?.[1]?.title) ?? text(v.subtitle));
  return {
    id,
    title,
    author: byline.author,
    year: byline.year,
    trackCount: null,
    // "Single"/"EP" is kept apart from the album tab's own grouping: the client
    // labels the row, the response type only says which shelf it came from.
    format: byline.format,
    thumb: thumbFrom(v),
  };
}

/**
 * Real releases for the library's album tab and the search Albums tab.
 *
 * The Music catalogue's album shelf is the release shelf: its ids are MPR…
 * browse ids and its author/year byline is the release's own. Plain search
 * answers with playlists (PL…) and LockupViews, which are collections, not
 * releases — so it stays as the fallback for queries without a catalogue
 * release (a non-music channel, an obscure uploader).
 */
export async function searchAlbums(query, limit = 18) {
  const yt = await getYT();

  try {
    const res = await withTimeout(
      yt.music.search(query, { type: 'album' }),
      config.resolveTimeoutMs,
      'album search',
    );
    const releases = (res?.albums?.contents ?? [])
      .map(toReleaseItem).filter(Boolean).slice(0, limit);
    if (releases.length) return releases;
  } catch {
    // Fall through: a failed catalogue lookup must not empty the album tab.
  }

  const res = await withTimeout(yt.search(query, { type: 'playlist' }), config.resolveTimeoutMs, 'album search');
  const pool = res.playlists ?? res.results ?? [];
  return pool.map((p) => {
    if (p.type === 'LockupView' || p.content_id) {
      return {
        id: p.content_id ?? null,
        title: lockupTitle(p),
        author: lockupSubtitle(p),
        trackCount: null,
        thumb: thumbFrom(p),
      };
    }
    return {
      id: p.id,
      title: text(p.title),
      author: text(p.author?.name),
      trackCount: p.video_count ?? p.videoCount ?? null,
      thumb: thumbFrom(p),
    };
  }).filter((p) => p.id && p.title).slice(0, limit);
}

export async function searchArtists(query, limit = 18) {
  const yt = await getYT();

  // The Music catalogue's artist shelf is the right source for a "who is this"
  // answer: it is relevance-ranked by the same graph the artist pages come
  // from, so the band itself leads, and it finds artists that plain channel
  // search misses entirely ("mazzy star" returns no channel hits at all).
  // The channel search stays as the fallback, for non-music channels.
  try {
    const res = await withTimeout(
      yt.music.search(query, { type: 'artist' }),
      config.resolveTimeoutMs,
      'artist search',
    );
    const rows = (res?.artists?.contents ?? [])
      .map((c) => ({
        id: c.id ?? null,
        title: text(c.name) ?? text(c.title) ?? null,
        subscribers: text(c.subscribers) ?? null,
        handle: null,
        videoCount: null,
        thumb: thumbFrom(c),
      }))
      // Only rows whose id is a channel: `music.getArtist` accepts nothing else.
      .filter((c) => c.id && c.title && /^UC[\w-]{20,}$/.test(c.id));
    // Order is the catalogue's own relevance ranking; re-sorting by audience
    // would push the actual artist down behind a better-known neighbour.
    if (rows.length) return rows.slice(0, limit);
  } catch {
    // Fall through: a failed Music lookup must not empty the artists tab.
  }

  const res = await withTimeout(yt.search(query, { type: 'channel' }), config.resolveTimeoutMs, 'artist search');
  const pool = res.channels ?? res.results ?? [];
  return pool.map((c) => {
    // The channel renderer's fields shift between builds: sometimes
    // subscriber_count holds "@handle" and video_count holds "12M subscribers".
    // Read every candidate string and classify by content, not by field name.
    const raw = [
      text(c.subscriber_count), text(c.video_count),
      text(c.short_byline), text(c.long_byline), text(c.byline),
    ].filter(Boolean).join(' ');

    const subs = /([\d.,]+\s*[KMB]?)\s*subscribers?/i.exec(raw);
    const handle = /@[\w.-]+/.exec(raw);
    return {
      id: c.id ?? c.content_id ?? null,
      title: text(c.author?.name) ?? lockupTitle(c) ?? text(c.title),
      subscribers: subs ? subs[1].replace(/\s+/g, '') + ' subscribers' : null,
      handle: handle ? handle[0] : null,
      videoCount: null,
      thumb: thumbFrom(c),
    };
  })
    .filter((c) => c.id && c.title)
    // Rank by audience so the actual artist outranks fan re-upload channels.
    .sort((a, b) => toCount(b.subscribers) - toCount(a.subscribers))
    .slice(0, limit);
}

/**
 * One row per song, keeping the first (highest-ranked) occurrence.
 *
 * Community playlists routinely hold the same song several times — the album
 * track, "(Official Music Video)", a remaster — because whoever built it added
 * every upload they found. Opening a playlist should not hand that mess back.
 * Genuinely different recordings (acoustic, live, remix) keep distinct titles
 * and therefore survive.
 */
function uniqueSongs(tracks) {
  const seenVideo = new Set();
  const seenSong = new Set();
  return tracks.filter((t) => {
    if (!t) return false;
    if (seenVideo.has(t.videoId)) return false;
    const key = songKey(t);
    if (key && seenSong.has(key)) return false;
    seenVideo.add(t.videoId);
    if (key) seenSong.add(key);
    return true;
  });
}

/**
 * Tracks belonging to a YouTube playlist — a real album, or a community
 * playlist opened from a mood page. Returns the header too, so the UI can name
 * the playlist without a second lookup.
 */
export async function playlistTracks(playlistId, limit = 100) {
  const yt = await getYT();

  // Music-catalogue ids (VLPL…) are only readable through the Music client;
  // a plain PL… id from the library's album tab goes through the normal one.
  if (/^VL/.test(playlistId)) {
    const pl = await withTimeout(yt.music.getPlaylist(playlistId), config.resolveTimeoutMs, 'playlist');
    const tracks = (pl?.contents ?? pl?.items ?? [])
      .map((v) => ((v?.item_type === 'song' || v?.item_type === 'video') ? toMusicTrack(v) : null))
      .filter(Boolean);
    return {
      title: text(pl?.header?.title),
      author: null,
      type: 'Playlist',
      tracks: uniqueSongs(tracks).slice(0, limit),
    };
  }

  const pl = await withTimeout(yt.getPlaylist(playlistId), config.resolveTimeoutMs, 'playlist');
  const tracks = (pl?.videos ?? pl?.items ?? []).map(toTrack).filter(Boolean);
  return {
    title: text(pl?.info?.title),
    author: text(pl?.info?.author?.name),
    type: pl?.info?.author?.name ? 'Playlist' : 'Album',
    tracks: uniqueSongs(tracks).slice(0, limit),
  };
}

export function clearAudioCache(videoId) {
  if (videoId) urlCache.delete(videoId);
  else urlCache.clear();
}

/**
 * Resolve a playable audio URL for the iOS client path (itag 140 = AAC/MP4,
 * which Safari plays natively, so no transcoding is ever needed).
 *
 * The URL is IP-bound and expires, so it is only ever used server-side by the
 * proxy; the browser never sees it.
 */
export async function resolveAudio(videoId) {
  const hit = urlCache.get(videoId);
  if (hit && hit.expiresAt > Date.now()) return hit;

  const yt = await getYT();
  const info = await withTimeout(
    yt.getBasicInfo(videoId, { client: 'IOS' }),
    config.resolveTimeoutMs,
    'getBasicInfo',
  );

  const formats = (info.streaming_data?.adaptive_formats ?? [])
    .filter((f) => f.has_audio && !f.has_video);

  // Prefer AAC (Safari-safe); never hand Safari WebM/Opus.
  const aac = formats.filter((f) => f.mime_type?.startsWith('audio/mp4'));
  const pool = aac.length ? aac : formats;
  const best = pool.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  if (!best) throw new Error('No audio format available for this video.');

  const url = await best.decipher(yt.session.player);
  const entry = {
    url,
    mime: best.mime_type ?? 'audio/mp4',
    bitrate: best.bitrate ?? null,
    itag: best.itag,
    contentLength: Number(best.content_length) || null,
    expiresAt: Date.now() + config.urlTtlMs,
  };
  urlCache.set(videoId, entry);
  if (urlCache.size > 500) {
    for (const [k, v] of urlCache) if (v.expiresAt <= Date.now()) urlCache.delete(k);
  }
  return entry;
}

export { IOS_UA };
