// sonora — real music, mock's design.
//
// Design, layout and interaction come from the original concept file verbatim;
// the fictional data layer (16 songs, 8 playlists, fake artwork, a simulated
// playhead) is replaced with the live API, real YouTube tracks and real audio.
//
// Three WebKit behaviours drive the player. All are undocumented but
// reproducible, and playback dies without them:
//  1. A natural `ended` closes the iOS audio session, which background
//     playback cannot reopen. So `loop` is always on and the track switch
//     happens inside the seek-to-zero wrap.
//  2. On a locked iPhone the loop jump is not always reported by `seeking`.
//     `timeupdate` is the only reliable witness, so both events feed the same
//     end-of-track detector (see playback.js).
//  3. Media Session handlers set before the element is "Now Playing" are
//     ignored, and iOS then substitutes ±10s skip buttons. So they are
//     re-registered on every `playing` event.
//
// Everything the UI renders is escaped: titles and channel names are
// attacker-controlled strings from YouTube.

import { createAudioSession } from './audio-session.js';
import { artSrc, createMediaSession } from './media-session.js';
import { handoffTrack, isLoopWrap } from './playback.js';
import { planTrackIds, locate, planOffsetFor, streamSrc, freezesWhenHidden } from './queue-stream.js';
import { createRoomSync } from './rooms.js';

const $ = (id) => document.getElementById(id);

// ── tiny utils ──────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]
));
const fmt = (s) => (Number.isFinite(s) && s >= 0
  ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  : '0:00');
// Every sprite <symbol> draws in a 24x24 space. The outer <svg> must repeat that
// viewBox or the browser renders the art at 1:1 and clips whatever falls outside
// the CSS box — which silently ate the tips of every icon smaller than 24px.
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const totalTime = (tracks) => tracks.reduce((n, t) => n + (t.durationS || 0), 0);

// Small, dependency-free persistence. Private-mode Safari throws on write, and
// a preference is never worth breaking a page over.
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(`sonora.${key}`); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`sonora.${key}`, JSON.stringify(value)); } catch {}
  },
  remove(key) {
    try { localStorage.removeItem(`sonora.${key}`); } catch {}
  },
};

// A stable identity for this browser. The server uses it to tell "the same
// device resuming" from "another device taking over", so two phones do not
// silently overwrite each other's position every five seconds.
const deviceId = (() => {
  const saved = store.get('deviceId');
  if (typeof saved === 'string' && saved.length >= 8) return saved;
  const id = globalThis.crypto?.randomUUID?.()
    ?? `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  store.set('deviceId', id);
  return id;
})();

const deviceName = (() => {
  const ua = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const touchMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iP(hone|ad|od)/.test(ua) || touchMac) return /iPad/.test(ua) || touchMac ? 'iPad' : 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac/i.test(platform)) return 'Mac';
  if (/Win/i.test(platform)) return 'Windows';
  if (/Linux/i.test(platform)) return 'Linux';
  return 'this device';
})();

/**
 * The page's audio-session category (see public/audio-session.js for the three
 * WebKit rules behind it).
 *
 * `claim` is the cheap one-line ask, safe on every play intent; `repair` forces
 * the category through the audio session again, which is the only page-side
 * recovery from a locked phone that keeps playing silently. Both are no-ops on
 * every browser without the Audio Session API.
 */
const audioSession = createAudioSession();

function claimAudioSession() {
  audioSession.claim();
}

/**
 * Re-send the audio-session category.
 *
 * Called where a session can be lost rather than on every event: locking the
 * phone, coming back from the lock screen, a page restored from the freezer, a
 * track that starts while the screen is off. All four can leave WebKit with a
 * stale category and the tab rendering into a muted ambient session — audible
 * nothing, reported nowhere.
 */
function repairAudioSession(opts) {
  audioSession.repair(opts);
}

// Rule 1: a category assigned from a timer or an async continuation is ignored,
// so the very first gesture claims it — whether or not that gesture starts
// playback. Passive and `once`: this listener never competes with the UI.
for (const gesture of ['pointerdown', 'keydown']) {
  document.addEventListener(gesture, () => claimAudioSession(), {
    capture: true, once: true, passive: true,
  });
}

// ── loading + empty primitives ──────────────────────────────────────────
const skCard = () => `<div class="sk-card" aria-hidden="true">
  <div class="sk sk-cover"></div><div class="sk sk-line w-70"></div><div class="sk sk-line w-40"></div></div>`;
const skCards = (n = 4) => `<div class="sk-grid" aria-hidden="true">${Array.from({ length: n }, skCard).join('')}</div>`;
const skRows = (n = 6) => `<div class="sk-rows" aria-hidden="true">${Array.from({ length: n }, () =>
  `<div class="sk-row"><div class="sk sk-cover sm"></div><div class="sk-lines">
    <div class="sk sk-line w-70"></div><div class="sk sk-line w-35"></div></div></div>`).join('')}</div>`;
const emptyState = ({ art = 'spark', title, text = '', actions = '' }) => `<div class="empty-state">
  <div class="empty-art">${icon(art, 'lg')}</div><h3>${esc(title)}</h3>
  ${text ? `<p>${esc(text)}</p>` : ''}${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`;

const byTitle = (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, { sensitivity: 'base' });
const sortList = (list) => (state.sort === 'title' ? [...list].sort(byTitle) : list);

// ── state ───────────────────────────────────────────────────────────────
const state = {
  user: null,
  page: 'home',
  collection: null,
  playing: false,
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 0),
  volume: store.get('volume', 0.8),
  muted: store.get('muted', false),
  queue: [],
  index: -1,
  liked: new Set(),
  disliked: new Set(),
  // The pinned personal station (see src/station.js): a queue built from what
  // this person actually listens to, expanded through the same artists.
  station: null,
  // Set while the *station* is what is playing. A station has no end, so this
  // carries the cursor that keeps it generating: the queue is topped up from
  // /api/station/next whenever it runs low, and `seen` is every id the station
  // has already handed over so nothing is offered twice.
  stationQueue: null,
  stationError: null,
  stationLoading: false,
  // Set at boot when the running server lacks endpoints this bundle needs (a
  // process left up across a deploy), so the page can say so instead of
  // showing a mystery "Not Found".
  serverSkew: null,
  playlists: [],
  search: '',
  // One search answer fills four shelves (songs, artists, albums, playlists).
  // They are stored together because they arrive together: the type tabs below
  // the field are a view switch over these arrays, never a second request.
  searchResults: undefined,
  searchArtists: [],
  searchAlbums: [],
  searchPlaylists: [],
  searchCounts: null,
  // Which query the shelves belong to, so a new query can reset the tab.
  searchQuery: '',
  // The search type tab. Exactly the keys of SEARCH_FILTERS: 'all' | 'song' |
  // 'album' | 'artist' | 'playlist'.
  filter: 'all',
  libraryTab: ['Playlists', 'Albums', 'Artists'].includes(store.get('libraryTab')) ? store.get('libraryTab') : 'Playlists',
  overlayTab: 'lyrics',
  currentLyrics: null,
  startedAt: null,
  manualSeek: false,
  // Set by any programmatic seek (lock screen, previous, resume). The seeking
  // handler consumes it after the wrap test, so a deliberate jump to 0 is
  // never mistaken for the end of a track.
  lockSeek: false,
  lastTime: 0,
  // A source that has not emitted `playing` yet must never be judged as
  // finished (a fresh src reports 0:00 before it starts).
  sourceStarted: false,
  // One-shot guard so `seeking` and `timeupdate` cannot both advance the queue
  // for the same loop wrap.
  ending: false,
  // When the last room auto-next was commanded: the wrap detector fires again
  // on every timeupdate while the element loops a finished room track, so this
  // timestamp is the cool-down that throttles retries of a failed auto-next.
  roomNextAt: 0,
  // The queue as one continuous server stream (public/queue-stream.js): the
  // plan armed while the page is visible, and the stream the element is playing
  // while it is hidden. `streaming` is non-null only between enterQueueStream()
  // and leaveQueueStream().
  queuePlan: null,
  streaming: null,
  streamSeekNonce: 0,
  streamWatch: null,
  streamBlocked: false,
  streamPlayedOnce: false,
  /** When the current stream src was assigned: the ceiling on its clock. */
  streamLoadAt: 0,
  streamFails: 0,
  streamCooldownUntil: 0,
  streamTrack: null,
  streamOffsetMs: 0,
  streamDurationMs: 0,
  // True while playIndex swaps the source: the pause that a src change emits
  // is not the user pausing, so it must not be saved as a new position.
  switching: false,
  // Set by a user play intent (press play, pick a track, next/prev). The next
  // save then takes ownership of the session from another device.
  claim: false,
  // Has this tab ever actually played? A tab that merely restored a session is
  // a reader: its visibility save must not clobber the position of the tab (or
  // device) that is really playing.
  hasPlayed: false,
  // True after another device has taken over: stop writing until the user
  // explicitly plays here again.
  sessionBlocked: false,
  sessionUpdatedAt: 0,
  // The device the restored session came from, when it is not this one.
  resumeFrom: null,
  // Set when iOS paused the element on our behalf while the screen was off
  // (a call, Siri, another app). Coming back to the page resumes instead of
  // waiting for a tap; a lock-screen pause is deliberate and sets `userPause`.
  resumeOnVisible: false,
  // Playback is wanted but the element is not running, for a reason that was
  // not the listener. `state.playing` cannot carry this: the rejected-play
  // paths deliberately set it false so the transport stays honest, and that is
  // exactly when the intent must survive — an interruption that pauses a swap
  // in flight used to leave nothing that remembered the music was supposed to
  // be on (measured: switching to Discord silenced the phone for good).
  resumeWanted: false,
  // Consecutive refused resume attempts (see resumeAfterInterruption).
  resumeAttempts: 0,
  userPause: false,
  failures: 0,
  savedAt: 0,
  pendingResumeMs: 0,
  browse: { albums: null, artists: null },
  browseLoading: {},
  // Followed artists (GET /api/follows). `null` means "not asked yet", exactly
  // like browse.*: the library's Artists tab is the only place they are shown,
  // so a listener who never opens it never pays for the request.
  follows: null,
  followsLoading: false,
  // Browse by feeling: a mood is answered with real playlists (plus the
  // catalogue's top songs), never with a 4-hour single-video "mix".
  mood: null,
  // The artist page currently open. `key` is what was asked for (a channel id
  // or a plain name) so revisiting does not refetch, and `id` is the channel
  // the server resolved it to.
  artist: null,
  collectionData: null,
  collectionLoading: false,
  collectionError: null,
  sort: store.get('sort', 'recent'),
  searchRecent: store.get('searchRecent', []),
  home: { radio: [], recent: [], featured: null },
  // Admin data is cached per tab so switching tabs does not refetch, and is
  // invalidated after every mutation instead of guessing at staleness.
  admin: {
    tab: 'overview',
    data: {},
    loading: {},
    error: null,
    trackQuery: '',
    trackFocus: false,
    diag: null,
  },
  // Account security is read fresh on every visit: a device revoked on a phone
  // must disappear from the laptop the next time it is opened.
  security: { data: null, loading: false, error: null, busy: null },
  // Listen Together (public/rooms.js, docs/rooms.md). `room` is the snapshot
  // while this device is following a shared playhead; `roomMembers` is the live
  // roster; `roomDriftMs` is local time minus the room's, so "synced" is a
  // claim with evidence behind it rather than a reassuring label.
  room: null,
  roomMembers: [],
  roomGuests: 0,
  roomStatus: 'idle',
  roomError: null,
  roomDriftMs: 0,
  // True only while the room itself is writing to the player. The play helpers
  // check it so a remote state change is never echoed back as a command.
  roomApplying: false,
  roomPeople: [],
  roomInvites: [],
  roomPeopleLoaded: false,
  // Client-side preferences (Settings). One localStorage record so a new toggle
  // never needs a migration: a missing key simply means its default.
  prefs: store.get('prefs', {}),
};

// The drag currently in flight on a queue row (see "queue reorder" below).
// Declared up here so any early render can read it without a temporal-dead-zone
// throw; the gesture itself is set up much later.
let queueDrag = null;
// The queued frame of a drag in flight (see "queue reorder" below): pointer
// events outrun paint, so the gesture is coalesced to one update per frame.
let queueDragFrame = 0;
let queueSaveTimer = null;
let queueSuppressClick = 0;
// Volume drags persist at most every 150 ms instead of on every input event.
let volumeSaveTimer = null;

// ── preferences ─────────────────────────────────────────────────────────
// Pinned shared interface (see .tmp/plan/brief.md): other features extend
// `PREF_DEFAULTS` and call `pref()` / `setPref()` rather than inventing their
// own storage key. Every default lives here in code, so `sonora.prefs` only
// ever holds the keys the user actually changed.
const PREF_DEFAULTS = { queueFillList: false, desktopAlerts: false };

// The copy for each toggle, next to the defaults so a new preference is one
// entry in each table and nothing else has to change: the settings sheet
// renders whatever keys these two tables hold. A key with no meta still gets a
// row (labelled with the key itself) rather than silently disappearing.
const PREF_META = {
  queueFillList: {
    label: 'Queue the rest of the list when I start a song',
    hint: 'Starting a song with nothing else queued fills the queue with the rest of the list you picked it from.',
  },
  desktopAlerts: {
    label: 'Desktop notifications when a followed artist releases something',
    hint: 'Asks for browser permission the first time you turn this on. The notification bell shows them either way.',
  },
};

/** Every preference the settings sheet renders, in table order, de-duplicated. */
const prefKeys = () => [...new Set([...Object.keys(PREF_DEFAULTS), ...Object.keys(PREF_META)])];

function pref(k) { return state.prefs?.[k] ?? PREF_DEFAULTS[k]; }
function setPref(k, v) {
  state.prefs = { ...(state.prefs ?? {}), [k]: v };
  store.set('prefs', state.prefs);
  // Announce the change so a module that owns a preference's *effect* (desktop
  // notifications asking for permission on the user gesture, say) can react
  // without app.js knowing about it. Dispatched from here rather than from the
  // settings sheet so a programmatic change is announced too, and so nothing
  // else ever has to call Notification.requestPermission() itself.
  document.dispatchEvent(new CustomEvent('sonora:pref-change', { detail: { key: k, value: v } }));
}

const audio = $('audio');

/**
 * A remembered device keeps a rotating refresh cookie. When the short-lived
 * access cookie runs out mid-session, one silent exchange mints a new one and
 * the original request is retried, so a tab left open overnight does not dump
 * the user back on the login screen. Concurrent 401s share one exchange: two
 * parallel refreshes would race, and the loser looks like token theft.
 */
let refreshing = null;
function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (res) => {
      // This request's boolean answer still owns a response body. Consume that
      // small JSON payload before settling; discarded 401 streams from two
      // concurrent refresh owners can otherwise keep Chromium's initial worker
      // network job alive and leave a subsequent registration.update() pending.
      await res.arrayBuffer();
      return res.ok;
    })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * A remembered device should never hit the 401 path in the first place. The
 * access token is short-lived, but a tab or an installed PWA can stay open for
 * days, and an audio request that 401s mid-song cannot be retried from script —
 * the <audio> element has no way to run a refresh. So renew at half-life while
 * the tab is visible, and again on returning to a tab that was hidden for a
 * while.
 */
let keepAlive = null;
let keepAliveBound = false;
let lastRenew = 0;
function keepSessionAlive(remembered, sessionMinutes) {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  const lifeMs = Math.max(60_000, Number(sessionMinutes ?? 720) * 60_000);
  const everyMs = Math.max(60_000, Math.floor(lifeMs / 2));
  if (!remembered) {
    // Signed out of "remember me": nothing to renew, nothing to schedule.
    lastRenew = 0;
    return;
  }
  lastRenew = Date.now();
  keepAlive = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    lastRenew = Date.now();
    refreshSession();
  }, everyMs);
  if (keepAliveBound) return;
  keepAliveBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !keepAlive) return;
    if (Date.now() - lastRenew < everyMs) return;
    lastRenew = Date.now();
    refreshSession();
  });
}

/**
 * An API failure that keeps the status and the parsed body, so a caller can
 * switch on `code` instead of scraping a message. Listen Together needs this:
 * a `STALE` room command is not an error to report, it is the answer to follow.
 */
function httpError(message, status, body = null) {
  const err = new Error(message);
  err.status = status;
  err.body = body;
  return err;
}

  const api = async (path, opts = {}) => {
    const { _retried, ...fetchOpts } = opts;
    let res;
    try {
      res = await fetch(path, {
        credentials: 'same-origin',
        headers: fetchOpts.body ? { 'content-type': 'application/json' } : undefined,
        ...fetchOpts,
        body: fetchOpts.body ? JSON.stringify(fetchOpts.body) : undefined,
      });
    } catch {
      notify('You are offline. Reconnect and try again.', 'error');
      throw new Error('You appear to be offline.');
    }
    // Auth endpoints are never retried: /api/auth/refresh failing *is* the
    // answer, and retrying a login would resubmit a passphrase.
    if (res.status === 401 && !_retried && !path.startsWith('/api/auth/')) {
      if (await refreshSession()) return api(path, { ...opts, _retried: true });
    }
    const isJson = res.headers.get('content-type')?.includes('json');
    const body = isJson ? await res.json().catch(() => ({})) : null;
    if (res.status === 401) {
      // A rejected passphrase is an expected answer, not a lost session, so only
      // an *authenticated* call pulls the sign-in screen over the app. Reading
      // the body first is what lets the form show "Wrong name or passphrase."
      // instead of a generic "Not signed in."
      if (!path.startsWith('/api/auth/')) showAuth();
      throw httpError(body?.error ?? 'Not signed in.', 401, body);
    }
    // A 404 on an /api/ path usually means the running server has no such route
    // — it is older than this bundle (a process left up across a deploy). That
    // is a deploy problem, not a bug in the page, so say so instead of echoing
    // "Not Found". Endpoints that answer 404 for real (an unknown track) send
    // their own error string and are left alone.
    if (res.status === 404 && path.startsWith('/api/')
      && (body?.error === 'Not Found' || /route .* not found/i.test(body?.message ?? ''))) {
      throw httpError('This server is older than the app. Restart it (or rebuild the container) and reload.', 404, body);
    }
    // The rate limiter answers with Fastify's own shape ("Too Many Requests"),
    // which is not something to show a person who mistyped a passphrase.
    if (res.status === 429) {
      throw httpError('Too many attempts. Wait a minute and try again.', 429, body);
    }
    if (!res.ok) throw httpError(body?.error ?? `HTTP ${res.status}`, res.status, body);
    return body;
  };

/**
 * The shared-playhead client. It owns the clock offset and the drift loop and
 * calls back into the player; nothing here publishes a position (see
 * public/rooms.js for why). Instantiated once, after the API helper it uses.
 */
const rooms = createRoomSync({
  api,
  audio,
  hooks: {
    notify,
    currentTrackId: () => current()?.videoId ?? null,
    // The room may only move the playhead of a track this device has actually
    // loaded; seeking a source that is still buffering fights the load.
    isLoaded: (videoId) => current()?.videoId === videoId && audio.readyState >= 1,
    loadTrack: (snapshot) => loadRoomTrack(snapshot),
    play: () => {
      // The shared playhead may not start audio behind the sign-in form: a
      // session that expired mid-room leaves the client polling, and the next
      // snapshot would otherwise begin a track for a user who is not signed in
      // and cannot stop it. Refusing here is honest — the room's state is
      // unchanged, and signing back in re-syncs to it.
      if (!$('auth-overlay').hidden) return;
      claimAudioSession();
      state.playing = true;
      audio.play().catch(() => {});
      updatePlayer();
    },
    pause: () => { state.playing = false; audio.pause(); updatePlayer(); },
    seek: (seconds) => seekTo(seconds),
    setRate: (rate) => { audio.playbackRate = Math.min(1.5, Math.max(0.5, Number(rate) || 1)); },
    onSnapshot: (snapshot) => {
      state.room = snapshot;
      if (snapshot?.invites) state.roomInvites = snapshot.invites;
      if (snapshot?.members) state.roomMembers = snapshot.members;
      if (Number.isFinite(snapshot?.guests)) state.roomGuests = snapshot.guests;
      if (!snapshot) {
        state.roomMembers = [];
        state.roomGuests = 0;
        state.roomDriftMs = 0;
        // Leaving the room can happen mid auto-next round trip, while `ending`
        // is still armed as the wrap guard. The queue is personal again, so a
        // stale armed flag must not swallow its next natural wrap.
        state.ending = false;
      }
      // A room that ended is not one to come back to on the next reload.
      if (snapshot?.ended) rememberRoom(null);
      updateRoomPill();
      updatePlayer();
      if (state.page === 'room') paintRoom();
    },
    onMembers: (list, guestCount) => {
      state.roomMembers = Array.isArray(list) ? list : [];
      if (Number.isFinite(guestCount)) state.roomGuests = guestCount;
      updateRoomPill();
      if (state.page === 'room') paintRoom();
    },
    onStatus: ({ status, error }) => {
      state.roomStatus = status;
      state.roomError = error;
      updateRoomPill();
      if (state.page === 'room') paintRoom();
    },
    onDrift: (ms) => {
      state.roomDriftMs = ms;
      patchRoomSync();
    },
  },
});

const current = () => state.queue[state.index] ?? null;

// Every rendered track is indexed by id so playback can recover its metadata
// (title, channel, artwork, duration) no matter which page the user clicked in.
//
// It is a *cache*, not a record: a long session can render thousands of rows (an
// endless station tops itself up forever, and every search result is remembered
// too), and an unbounded Map of track objects — each holding a thumbnail URL per
// size — is the one thing here that only grows. The cap is deliberately far
// above any live queue, so eviction never touches a track the player can still
// name; when it does fire, the oldest writes go first (see evictTrackIndex).
const TRACK_INDEX_MAX = 3000;
const trackIndex = new Map();
function evictTrackIndex() {
  if (trackIndex.size <= TRACK_INDEX_MAX) return;
  // Map iteration order is insertion order, and every write below re-inserts, so
  // the front of the Map is the least recently *written* entry.
  for (const videoId of trackIndex.keys()) {
    if (trackIndex.size <= TRACK_INDEX_MAX) break;
    trackIndex.delete(videoId);
  }
}
function rememberTracks(list = []) {
  for (const t of list) {
    if (!t?.videoId) continue;
    const prev = trackIndex.get(t.videoId);
    if (!prev || t.title) {
      // Delete before set: without it a re-seen track keeps its original slot
      // and would be the first thing evicted despite being the one on screen.
      trackIndex.delete(t.videoId);
      trackIndex.set(t.videoId, { ...prev, ...t });
    }
  }
  evictTrackIndex();
  return list;
}

/** Fill in a queue entry's metadata from whatever we already know about it. */
function completeTrack(t) {
  const known = trackIndex.get(t.videoId);
  if (!known) return t;
  return {
    videoId: t.videoId,
    title: t.title && t.title !== t.videoId ? t.title : (known.title ?? t.videoId),
    channel: t.channel || known.channel || '',
    thumb: t.thumb || known.thumb || null,
    durationS: t.durationS || known.durationS || 0,
    // The album column and the now-playing sheet both read this; dropping it
    // here silently blanked the column for anything that entered via the queue.
    album: t.album || known.album || null,
    // Carried through so "Open album" works for anything already in a queue,
    // not only for rows freshly rendered from a catalogue search.
    albumId: t.albumId || known.albumId || null,
    // Which edit of the song this is (see trackVersion on the server). Kept so
    // the queue and the now-playing sheet can badge a clean edit as clean.
    version: t.version ?? known.version ?? null,
  };
}

/** The visible track list for the current page, used to build a queue. */
function currentList() {
  if (state.page === 'search') return state.searchResults ?? [];
  if (state.page === 'station') return state.station?.tracks ?? [];
  if (state.page === 'mood') return state.mood?.top ?? [];
  if (state.page === 'artist') return state.artist?.songs ?? [];
  if (state.page === 'collection') return state.lastCollection ?? [];
  return state.home.recent ?? [];
}

// ── design primitives (from the concept file) ───────────────────────────
const cover = (key, cls = 'cover', art = null, loading = 'lazy', hi = false) => {
  if (!art) {
    return `<span class="${cls} cover-empty">${icon('wave')}</span>`;
  }
  // Prefer the same-origin artwork proxy: one host, no third-party gating, and
  // the client's IP never hits Google's image CDN. The lock screen uses the
  // exact same mapping (see media-session.js) — it needs it even more.
  // `hi` pulls the full 16:9 source for large frames; small thumbnails stay on
  // the cheap 4:3 one.
  const src = artSrc(art, location.href, { hi }) ?? art;
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="${loading}" decoding="async"
    draggable="false" onerror="this.classList.add('is-broken')">`;
};

function notify(msg, kind = 'success') {
  const el = $('toast');
  const use = el.querySelector('use');
  $('toast-text').textContent = msg;
  el.dataset.kind = kind;
  if (use) use.setAttribute('href', `#i-${kind === 'error' ? 'close' : kind === 'info' ? 'spark' : 'check'}`);
  clearTimeout(notify.t);
  clearTimeout(notify.h);
  el.classList.remove('show');
  el.hidden = false;
  // Two frames so the entrance transition always runs, even back-to-back toasts.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  notify.t = setTimeout(() => {
    el.classList.remove('show');
    notify.h = setTimeout(() => { el.hidden = true; }, 240);
  }, 2800);
}

// ── routing / history ───────────────────────────────────────────────────
// Hash routing keeps deep links working through the Cloudflare tunnel and in an
// offline PWA without a server-side catch-all. The in-app back/forward buttons
// and the phone's back gesture both drive the same history stack.
const historyEntries = [{ page: 'home', collection: null }];
const historyCursor = { index: 0 };

const routePath = (page, collection, mood) => (
  page === 'collection' && collection ? `#/c/${encodeURIComponent(collection)}`
    : page === 'artist' && collection ? `#/artist/${encodeURIComponent(collection)}`
      : page === 'room' && collection ? `#/room/${encodeURIComponent(collection)}`
      : page === 'mood' ? `#/mood/${encodeURIComponent(mood ?? '')}`
        : `#/${page}`
);

function routeFromLocation() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return null;
  const [kind, arg] = raw.split('/');
  // `decodeURIComponent` throws a URIError on a malformed escape, and `#/c/50%`
  // is exactly what a half-copied or hand-edited share link looks like. That
  // throw used to escape into boot() — where the fallback renders Discover —
  // and into the popstate path, where nothing caught it at all: navigation
  // simply stopped working and the URL was left as it was. A damaged route is
  // not a route, and saying so is the whole recovery.
  const part = (value) => {
    try { return decodeURIComponent(value); } catch { return null; }
  };
  if (kind === 'c' && arg) {
    const id = part(arg);
    return id == null ? null : { page: 'collection', collection: id };
  }
  if (kind === 'artist' && arg) {
    const id = part(arg);
    return id == null ? null : { page: 'artist', collection: id };
  }
  if (kind === 'mood' && arg) {
    const mood = part(arg);
    return mood == null ? null : { page: 'mood', collection: null, mood };
  }
  // `#/room/<code>` — the in-app half of a `/l/<code>` share link.
  if (kind === 'room' && arg) {
    const code = part(arg);
    return code == null ? null : { page: 'room', collection: code };
  }
  // `#/t/<videoId>` is what "Copy link" writes: open sonora and start the track.
  if (kind === 't' && arg) {
    const videoId = part(arg);
    return videoId == null ? null : { page: 'track', videoId };
  }
  if (['home', 'search', 'library', 'radio', 'station', 'admin', 'security'].includes(kind)) {
    return { page: kind, collection: null };
  }
  return null;
}

/** Same page, same collection, same mood — the three things an entry names. */
const sameRoute = (a, b) => a?.page === b?.page
  && (a?.collection ?? null) === (b?.collection ?? null)
  && (a?.mood ?? null) === (b?.mood ?? null);

async function playSharedTrack(videoId) {
  try {
    const { track } = await api(`/api/track/${encodeURIComponent(videoId)}`);
    // A shared link is a different queue, not an addition to the endless
    // station: leaving it first stops the station from topping the shared
    // song up with (or repeating) recommendations.
    leaveStation();
    state.queue = [completeTrack(track)];
    playIndex(0, { claim: true, queueChanged: true });
    notify(`Playing ${track.title ?? 'shared track'}`, 'info');
  } catch (err) {
    // The server refuses an id it has never seen; a share link is still a play
    // intent, so fall back to the minimal track the player can play.
    if (err.message === 'Unknown track.' || err.status === 404) {
      leaveStation();
      state.queue = [completeTrack({ videoId })];
      playIndex(0, { claim: true, queueChanged: true });
      notify('Playing shared track', 'info');
      return;
    }
    notify(err.message, 'error');
  }
}

const PAGE_TITLES = {
  home: 'Discover', search: 'Search', library: 'Your library', radio: 'Radio', admin: 'Instance admin',
  security: 'Account & security',
};

function pageTitle() {
  if (state.page === 'collection') {
    return `${state.collectionData?.title ?? (state.collection === 'liked' ? 'Liked songs'
      : state.collection === 'recent' ? 'Recently played' : 'Collection')} · sonora`;
  }
  if (state.page === 'search' && state.search.trim()) return `${state.search.trim()} · sonora`;
  if (state.page === 'mood') return `${state.mood?.name ?? 'A feeling'} · sonora`;
  if (state.page === 'artist') return `${state.artist?.name ?? 'Artist'} · sonora`;
  if (state.page === 'station') return `${state.station?.name ?? 'Your station'} · sonora`;
  if (state.page === 'room') {
    return `${state.room?.host?.name ? `${state.room.host.name}’s room` : 'Listen together'} · sonora`;
  }
  return `${PAGE_TITLES[state.page] ?? 'Discover'} · sonora`;
}

/** Remember where the page being left was scrolled, so Back can return there. */
function captureScroll() {
  const entry = historyEntries[historyCursor.index];
  const el = $('main-scroll');
  if (entry && el) entry.scroll = el.scrollTop;
}

function pushRoute(entry) {
  captureScroll();
  historyEntries.splice(historyCursor.index + 1);
  historyEntries.push(entry);
  historyCursor.index = historyEntries.length - 1;
  const path = routePath(entry.page, entry.collection, entry.mood);
  try { history.pushState({ i: historyCursor.index }, '', path); } catch {}
}

function navigate(page, collection = null, addHistory = true, mood = null) {
  if (page === 'collection' && collection) return openCollection(collection, { history: addHistory ? 'push' : 'none' });
  const entry = { page, collection, ...(mood ? { mood } : {}) };
  // Clicking the nav item for the page already showing is not a navigation:
  // pushing a duplicate entry made the in-app Back look dead once.
  const current = historyEntries[historyCursor.index];
  if (addHistory && current && current.page === entry.page
    && (current.collection ?? null) === (entry.collection ?? null)
    && (current.mood ?? null) === (entry.mood ?? null)) return;
  if (addHistory) {
    pushRoute(entry);
  } else {
    // In-app back/forward walks the internal stack without pushing. Keep the
    // address bar honest anyway, so a reload (or the phone's own back gesture)
    // lands on the page actually being shown.
    try { history.replaceState({ i: historyCursor.index }, '', routePath(page, collection, mood)); } catch {}
  }
  // A fresh navigation starts at the top; Back/Forward restore the scroll the
  // entry was left at, so the gesture never loses your place in a long page.
  applyRoute(entry, { scroll: addHistory, scrollTop: addHistory ? 0 : (entry.scroll ?? 0) });
}

function applyRoute({ page, collection, mood = null }, { scroll = false, scrollTop = 0 } = {}) {
  if (page === 'admin' && !isAdmin()) {
    notify('Administrator access required.', 'error');
    page = 'home';
    collection = null;
  }
  state.page = page;
  state.collection = collection;
  closeMenus({ restoreFocus: false });
  render();
  document.title = pageTitle();
  const announcer = $('route-announcer');
  if (announcer) announcer.textContent = document.title.replace(' · sonora', '');
  const target = scroll ? 0 : scrollTop;
  const restoreScroll = () => { const el = $('main-scroll'); if (el) el.scrollTop = target; };
  restoreScroll();
  // The content was just replaced, so a second pass after layout makes the
  // position stick even when images or a skeleton changed the page height.
  requestAnimationFrame(restoreScroll);
  if (page === 'search' && window.matchMedia('(min-width: 811px)').matches) {
    setTimeout(() => $('primary-search')?.focus({ preventScroll: true }), 60);
  }
  // A mood needs its playlists; load once per mood, including on deep links
  // and when the phone's back gesture lands here.
  if (page === 'mood' && mood && state.mood?.q !== mood) loadMood(mood);
  // A search debounce must not outlive the page that started it: a pending
  // query fired after navigating away raised an error toast on the new page.
  if (page !== 'search') clearTimeout(searchTimer);
  // An artist page is one upstream call and is cached server-side; opening it
  // again (back gesture, reload) reuses the copy already in state.
  if (page === 'artist' && collection && state.artist?.key !== collection) loadArtist(collection);
  // The station is "this person, right now": it is rebuilt on every visit so a
  // like or a dislike taken elsewhere shows up immediately.
  if (page === 'station') loadStation();
  // Devices and passkeys change from another device, so this page never trusts
  // a cached copy.
  if (page === 'security') loadSecurity();
  // A room is a live connection, not data already in state: the cold deep link
  // (and the phone's back gesture) must open the stream and read a snapshot.
  if (page === 'room' && collection) openRoom(collection);
}

window.addEventListener('popstate', (e) => {
  // Remember where the entry being left was scrolled before the cursor moves.
  captureScroll();
  const i = e.state?.i;
  // The route the address bar names — null when there is no hash at all.
  const route = routeFromLocation();
  // The index on the entry is only trustworthy when the entry it names is the
  // page the address bar names. A reload keeps the old {i} but rebuilds the
  // roster from scratch, so index 0 can hold the boot route while the browser
  // has gone back to a page written before it; following the integer there
  // showed one page under another page's URL. A mismatch reads the route from
  // the hash instead (the adoption below), which is the record a reload cannot
  // corrupt.
  if (Number.isInteger(i) && historyEntries[i] && (!route || sameRoute(historyEntries[i], route))) {
    historyCursor.index = i;
    const entry = historyEntries[i];
    const entryScroll = entry.scroll ?? 0;
    if (entry.page === 'collection' && entry.collection) {
      return openCollection(entry.collection, { history: 'none', scrollTop: entryScroll });
    }
    return applyRoute(entry, { scrollTop: entryScroll });
  }
  if (!route) return;
  if (route.page === 'track') return playSharedTrack(route.videoId);
  // Two kinds of entry reach this fallback instead of the indexed path above:
  // one nobody in this document wrote (state===null — anything outside the
  // router set location.hash, notifications.js does), and one whose index
  // historyEntries no longer holds (a reload keeps the old {i} but rebuilds the
  // roster from scratch). Inserting them at the cursor stacked a fresh duplicate
  // of the same page on every re-entry and walked the cursor off the real
  // stack, so adopt the entry in place instead: drop whatever sat ahead of the
  // cursor and take its slot. Nothing is lost but a scroll position — every
  // route is recoverable from its own hash.
  historyEntries.splice(historyCursor.index + 1);
  historyEntries.push(route);
  historyCursor.index = historyEntries.length - 1;
  // Tag the entry so coming back to it takes the indexed path above, which is
  // what stops the duplicates in the first place. url is the current href, so
  // the address bar keeps the hash the route was read from.
  try { history.replaceState({ ...(e.state ?? {}), i: historyCursor.index }, '', location.href); } catch {}
  if (route.page === 'collection') return openCollection(route.collection, { history: 'none' });
  applyRoute(route, { scroll: true });
});

const activeRoute = (n) => state.page === n
  || (n === 'search' && state.page === 'mood')   // browse-by-feeling lives under Search
  || (n === 'library' && (state.page === 'collection' || state.page === 'artist'));

const isAdmin = () => state.user?.role === 'admin';

// ── navigation chrome ───────────────────────────────────────────────────
function renderNav() {
  // [page, icon, desktop label, mobile label]
  const nav = [
    ['home', 'home', 'Discover'],
    ['search', 'search', 'Search'],
    ['library', 'library', 'Your library', 'Library'],
    ['radio', 'radio', 'Radio'],
  ];
  // Admin is a database role, so the entry appears from the server's answer to
  // /api/me — not from a local flag a user could flip.
  if (isAdmin()) nav.push(['admin', 'shield', 'Instance admin', 'Admin']);

  // The station is pinned next to Discover on phones too: it is the entry point
  // people come back to, and the sidebar pin is invisible below 811px.
  const mobileNav = [nav[0], ['station', 'spark', 'Your station', 'Station'], ...nav.slice(1)];

  $('profile-admin').hidden = !isAdmin();
  $('profile-yt').hidden = !isAdmin();
  $('desktop-nav').innerHTML = nav.map(([page, ic, label]) => `
    <button class="nav-btn ${activeRoute(page) ? 'active' : ''}" data-page="${page}"${activeRoute(page) ? ' aria-current="page"' : ''}>
      ${icon(ic)}<span>${label}</span>
    </button>`).join('');

  $('mobile-nav').innerHTML = mobileNav.map(([page, ic, label, short]) => `
    <button class="${activeRoute(page) ? 'active' : ''}" data-page="${page}" aria-label="${label}"${activeRoute(page) ? ' aria-current="page"' : ''}>
      ${icon(ic)}<span>${short ?? label}</span>
    </button>`).join('');

  // The station is pinned to the person, not to a page: its label carries the
  // name so the sidebar entry reads "admin's station".
  const stationBtn = $('nav-station');
  if (stationBtn) {
    const stationOn = activeRoute('station');
    stationBtn.classList.toggle('active', stationOn);
    if (stationOn) stationBtn.setAttribute('aria-current', 'page');
    else stationBtn.removeAttribute('aria-current');
  }
  syncStationNavLabel();

  const dots = ['#ff997b', '#988ae0', '#92c1bd', '#ca7b9d', '#e4b985'];
  $('side-playlists').innerHTML = state.playlists.map((p, i) => `
    <button class="playlist-link ${state.page === 'collection' && state.collection === `p${p.id}` ? 'active' : ''}"
            data-collection="p${p.id}"${state.page === 'collection' && state.collection === `p${p.id}` ? ' aria-current="page"' : ''}>
      <span class="color-dot" style="--dot:${dots[i % 5]}"></span><span>${esc(p.title)}</span>
    </button>`).join('')
    || '<div class="side-empty">No playlists yet</div>';
}

/**
 * The station's name in the sidebar, in one place.
 *
 * It reads live state (`state.station` arrives after the first paint), so the
 * silent station load patches the label instead of repainting the nav.
 */
function syncStationNavLabel() {
  const label = $('nav-station')?.querySelector('span');
  if (!label) return;
  const name = state.station?.name ?? `${state.user?.name ?? 'Your'}'s station`;
  if (label.textContent !== name) label.textContent = name;
}

/**
 * One section heading, shared by every routed page.
 *
 * `.shelf-head` is the v2 vocabulary (copy block + optional link). It keeps
 * carrying `.section-head` as well: the search suite counts section heads, and
 * other surfaces still style the older class, so both keep working.
 */
function sectionHeader(title, desc = '', button = 'See all', go = 'library') {
  return `<div class="shelf-head section-head"><div class="shelf-head-copy">
    <h2>${esc(title)}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div>
    ${button ? `<button class="text-link shelf-link" data-page="${go}">${esc(button)}${icon('arrow-right')}</button>` : ''}</div>`;
}

/**
 * An artwork tile with a title, a sub-line and a play affordance.
 *
 * `.music-card` stays on the element because the app's card grid, the tests
 * and the context menus key off it; `.sleeve-tile` is the shared geometry that
 * makes library, search and artist tiles read as one object.
 */
function card(c) {
  return `<button class="music-card sleeve-tile" data-collection="${esc(c.collection)}" aria-label="${esc(c.title)}">
    <div class="cover-wrap sleeve-tile-art">${cover(null, 'cover', c.art)}<span class="cover-play sleeve-tile-play">${icon('play')}</span></div>
    <div class="music-card-title sleeve-tile-title">${esc(c.title)}</div>
    <div class="music-card-sub sleeve-tile-sub">${esc(c.sub)}</div></button>`;
}

// ── pages ───────────────────────────────────────────────────────────────

/**
 * The sleeve: the track this device last played, with its real artwork and its
 * real playhead. Returns `null` when nothing has been played here yet — a
 * normal first-run state, not an error, so the hero offers a start rather than
 * inventing a cover for a song the listener never chose.
 */
function sleeveFeatured() {
  const track = state.home.featured;
  if (!track) return null;
  // Under five seconds there is nothing to pick up: a resume chip reading
  // "0:02 in" is noise, and the button already resumes from the top.
  const at = Math.round((state.home.featuredPos || 0) / 1000);
  return { track, at: at >= 5 ? at : 0 };
}

/**
 * The hero. Sleeve-first: the artwork of the actual last track fills the card,
 * the track's own title and channel sit on it, and one button continues it.
 * The fallback (no history) keeps the brand wash and offers a start.
 *
 * The class names `.hero`, `.hero-content`, `.hero-footer` and `.hero-meta` are
 * load-bearing: layout and resume tests measure the footer's two actions and
 * the mobile caption. `.sleeve-*` is the new sleeve vocabulary on top.
 */
function homeHero() {
  const sleeve = sleeveFeatured();
  const remote = state.resumeFrom ? String(state.resumeFrom) : null;
  const likedRecent = `${state.liked.size} liked · ${state.home.recent.length} recent`;

  if (!sleeve) {
    return `<div class="hero sleeve-hero is-empty">
  <div class="hero-art" aria-hidden="true"><div class="hero-orb"></div><div class="ring"></div><div class="ring r2"></div><div class="ring r3"></div></div>
  <div class="hero-fade"></div><div class="hero-noise"></div>
  <div class="hero-content"><div class="hero-tag">THE EVENING EDIT · VOL. 01</div>
    <h1>Find your <em>afterglow.</em></h1>
    <p>For slow evenings, long drives, and whatever comes next. Start with a song and sonora builds the rest.</p>
    <div class="hero-footer">
      <button class="play-btn" data-action="surprise">${icon('play')}Start listening</button>
      <button class="secondary-btn" data-page="search">Find a song ${icon('arrow-right', 'sm')}</button>
      <span class="hero-meta">${likedRecent}</span>
    </div></div></div>`;
  }

  const t = sleeve.track;
  // A real cover when the catalogue gave us one; the brand wash when the
  // artwork proxy has nothing to show. Never a painted-on fake sleeve.
  const art = t.thumb
    ? cover(null, 'sleeve-hero-img', t.thumb, 'eager', true)
    : `<div class="hero-orb"></div><div class="ring"></div><div class="ring r2"></div>`;

  return `<div class="hero sleeve-hero">
  <div class="hero-art sleeve-hero-art${t.thumb ? '' : ' is-artless'}" aria-hidden="true">${art}</div>
  <div class="hero-fade"></div>${t.thumb ? '' : '<div class="hero-noise"></div>'}
  <div class="hero-content">
    <div class="hero-tag">${remote
      ? `UP NEXT · FROM YOUR ${esc(remote.toUpperCase())}`
      : 'PICK UP WHERE YOU LEFT OFF'}</div>
    <h1>Keep the <em>feeling.</em></h1>
    <p class="sleeve-hero-now"><strong>${esc(t.title ?? 'Your last track')}</strong><span>${esc(t.channel ?? '')}</span>${sleeve.at
      ? `<em class="sleeve-hero-resume">${fmt(sleeve.at)} in</em>` : ''}</p>
    <div class="hero-footer">
      <button class="play-btn" data-action="play-featured">${icon('play')}${remote ? 'Continue here' : 'Resume listening'}</button>
      <button class="secondary-btn" data-collection="recent">See history ${icon('arrow-right', 'sm')}</button>
      <span class="hero-meta">${likedRecent}</span>
    </div></div></div>`;
}

/**
 * Back in rotation: a compact, artwork-first shelf of what was played here
 * recently. Each tile is the same `data-track` control the rest of the app
 * uses, so a tap plays the track and keeps the recent list as the queue.
 *
 * No history is a first-run state, not an empty page: one quiet line and a way
 * to find music, never a full-height empty-state block.
 */
function homeShelfHead() {
  return `<div class="shelf-head sleeve-shelf-head">
    <div class="shelf-head-copy"><h2>Back in rotation</h2></div>
    <button class="text-link sleeve-shelf-link shelf-link" data-collection="recent">All history ${icon('arrow-right', 'sm')}</button>
  </div>`;
}

/** The shelf body only, so a playing track can repaint it without the head. */
function homeShelfBody() {
  const recent = (state.home.recent ?? []).slice(0, 6);
  if (!recent.length) {
    return `<div class="sleeve-shelf-empty">
      <span>${icon('clock', 'sm')} Nothing played here yet.</span>
      <button class="text-link" data-page="search">Find music ${icon('arrow-right', 'sm')}</button>
    </div>`;
  }

  return `<div class="sleeve-shelf shelf">${recent.map((t) => `
    <button class="sleeve-tile sleeve-shelf-item" data-track="${esc(t.videoId)}" aria-label="Play ${esc(t.title ?? t.videoId)}">
      <span class="sleeve-shelf-art sleeve-tile-art">${cover(null, 'cover', t.thumb)}<span class="sleeve-tile-play" aria-hidden="true">${icon('play', 'sm')}</span></span>
      <span class="sleeve-shelf-title sleeve-tile-title">${esc(t.title ?? '')}</span>
      <span class="sleeve-tile-sub">${esc(t.channel ?? '')}</span></button>`).join('')}</div>`;
}

function homeShelf() {
  return `${homeShelfHead()}${homeShelfBody()}`;
}

/**
 * The station, secondary on the sleeve home: one quiet strip that names the
 * station, says what it is, opens it, and can start it without a detour.
 */
function homeStationStrip() {
  const s = state.station;
  const name = s?.name ?? `${state.user?.name ?? 'Your'}'s station`;
  const empty = !s || s.empty;
  return `<div class="sleeve-station" role="group" aria-label="${esc(name)}">
    <button class="sleeve-station-main" data-page="station">
      <span class="sleeve-station-mark" aria-hidden="true">${icon('spark')}</span>
      <span class="sleeve-station-copy"><strong>${esc(name)}</strong>
        <small>${empty ? 'Play something and it starts building.' : 'Built from the songs you finish.'}</small></span>
      <span class="sleeve-station-go" aria-hidden="true">${icon('arrow-right', 'sm')}</span>
    </button>
    <button class="sleeve-station-play icon-btn" data-action="play-station" aria-label="Play ${esc(name)}">${icon('play')}</button>
  </div>`;
}

function homePage() {
  const h = state.home;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const mixes = state.playlists.slice(0, 4);

  // Sleeve-first order: who you are, the song you were in, what is still warm,
  // then the station as the quiet second door. Playlists and discovery follow
  // below the fold, where browsing belongs.
  return `
<div class="page-head"><div><span class="page-overline">Made for your ears</span>
  <h1 class="page-title">Good ${greeting}<span class="accent">.</span></h1>
  <span class="date-text">${esc(date)}</span></div>
  <div class="page-head-actions">
    <button class="secondary-btn page-head-play" data-action="play-station" aria-label="Play station" title="Play station">${icon('play', 'sm')}<span class="btn-label">Play station</span></button>
  </div></div>

${homeHero()}

${homeShelf()}

${homeStationStrip()}

${sectionHeader('Made for the moment', 'Your own playlists, ready when you are.', 'Browse library')}
${mixes.length
    ? `<div class="card-grid">${mixes.map((p) => card({
      collection: `p${p.id}`, art: p.artVideo ? `https://i.ytimg.com/vi/${p.artVideo}/hqdefault.jpg` : null,
      title: p.title, sub: `${p.trackCount} ${p.trackCount === 1 ? 'song' : 'songs'}`,
    })).join('')}</div>`
    : emptyState({ art: 'plus', title: 'No playlists yet',
      text: 'Group the songs you keep coming back to.',
      actions: `<button class="play-btn" data-action="create">${icon('plus')} New playlist</button>` })}

${sectionHeader('A little discovery', 'Find something you did not know you needed.', 'Browse radio', 'radio')}
<div class="wide-feature">${cover(null, 'cover', h.radio[0]?.thumb, 'eager')}
  <div><span class="eyebrow">START HERE</span>
    <h3>${esc(h.radio[0]?.title ?? 'Pick a seed track')}</h3>
    <p>${esc(h.radio[0]?.channel ?? 'Search for an artist, then let sonora build an endless station from it.')}</p>
    <button data-action="${h.radio[0] ? 'play-track' : 'go-search'}" data-id="${esc(h.radio[0]?.videoId ?? '')}">
      Listen now ${icon('arrow-right', 'xs')}</button></div></div>`;
}

// `#search-results` is the app's only asynchronously-updated *region* without a
// live role: every shelf (songs, artists, albums, playlists) arrived silently
// for a screen reader, so `/` → type → Enter changed the screen and announced
// nothing. Polite, not assertive: a query that is still being refined should not
// interrupt the field the user is typing into, and `aria-atomic="false"` means
// only the shelves that actually changed are read — the search field and the
// filter tabs are outside the region for exactly that reason.
function searchPage() {
  return `<div class="page-head"><div><span class="page-overline">Explore something new</span>
    <h1 class="page-title">Search the sound<span class="accent">.</span></h1></div>
    <div class="page-head-actions"></div></div>
  <div class="search-shell" role="search">
    <div class="search-box">${icon('search')}
      <input id="primary-search" autocomplete="off" autocapitalize="none" spellcheck="false"
        enterkeyhint="search" type="search" value="${esc(state.search)}" aria-controls="search-results"
        placeholder="Songs, albums, artists, playlists…" aria-label="Search music">
      <button class="search-clear" data-action="clear-search" aria-label="Clear search" ${state.search ? '' : 'hidden'}>${icon('close', 'sm')}</button>
      <span class="kbd-hint">ESC</span></div>
  </div>
  <div id="search-results" aria-live="polite" aria-atomic="false">${searchBody()}</div>`;
}

const MOODS = [
  { name: 'Electronic', bg: 'linear-gradient(135deg,#61448e,#3d3462)', q: 'electronic dance music' },
  { name: 'Indie', bg: 'linear-gradient(135deg,#ad635c,#684047)', q: 'indie rock' },
  { name: 'Chill', bg: 'linear-gradient(135deg,#639aa2,#3b606d)', q: 'lofi chill' },
  { name: 'R&B', bg: 'linear-gradient(135deg,#aa5478,#5b314d)', q: 'rnb soul' },
  { name: 'Ambient', bg: 'linear-gradient(135deg,#7271a4,#444273)', q: 'ambient music' },
  { name: 'Feel good', bg: 'linear-gradient(135deg,#bc8b4b,#846746)', q: 'feel good songs' },
];

// The five shelves one search answer can fill, in the order they are shown.
// `state.filter` holds one of these keys, so a tab is a pure view switch over
// data that is already in memory: nothing here may need a request of its own.
const SEARCH_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'song', label: 'Songs', count: 'tracks' },
  { key: 'album', label: 'Albums', count: 'albums' },
  { key: 'artist', label: 'Artists', count: 'artists' },
  { key: 'playlist', label: 'Playlists', count: 'playlists' },
];

/** The active tab, coerced to a key this page can render. */
const searchFilterKey = () => (SEARCH_FILTERS.some((f) => f.key === state.filter) ? state.filter : 'all');

/**
 * The type tabs, carrying the real counts from the one answer on screen.
 *
 * Counts are what make the tabs worth reading: "Albums 12" tells the listener
 * their band has a catalogue before they spend a tap finding out. A shelf with
 * nothing in it still gets its tab — that is how they learn the answer has no
 * albums — but no number.
 */
function searchFilterBar() {
  const counts = state.searchCounts ?? {};
  const active = searchFilterKey();
  const total = SEARCH_FILTERS.reduce((n, f) => n + (f.count ? counts[f.count] ?? 0 : 0), 0);
  return `<div class="search-filters segmented" role="tablist" aria-label="Filter results by type">
    ${SEARCH_FILTERS.map((f) => {
    const n = f.count ? counts[f.count] ?? 0 : total;
    const selected = active === f.key;
    return `<button class="segment${selected ? ' is-active' : ''}" role="tab"
        aria-selected="${selected}" data-filter="${f.key}" data-search-type="${f.key}">${esc(f.label)}${n ? `<span class="seg-count">${n}</span>` : ''}</button>`;
  }).join('')}
  </div>`;
}

/** One shelf: a header carrying the shelf's own count, then its contents. */
const searchShelf = (title, count, body) => `<div class="shelf-head section-head">
    <div class="shelf-head-copy"><h2>${esc(title)} <span class="section-count">${count}</span></h2></div></div>${body}`;

/**
 * A catalogue release as a card. `a` + the browse id is the collection route
 * (`#/c/aMPR…`), which is exactly what the album shelf of a search returns.
 */
function searchAlbumCard(x) {
  const songs = x.trackCount ? `${x.trackCount} ${x.trackCount === 1 ? 'song' : 'songs'}` : null;
  return card({
    collection: `a${x.id}`, art: x.thumb, title: x.title,
    sub: [x.year, x.author, songs].filter(Boolean).join(' · ') || 'Album',
  });
}

/**
 * A playlist result, opened through the album route.
 *
 * `p` is reserved for a *local* playlist: openCollection parses the number
 * after it (`/api/playlists/12`), so a YouTube id like `PL…` would become
 * `/api/playlists/NaN` and open nothing. `a` + the id is the route albums use,
 * and `GET /api/album/:id` reads a PL/VLPL id as a playlist — so a playlist
 * result opens with its real track list.
 */
function searchPlaylistCard(x) {
  const songs = x.trackCount ? `${x.trackCount} ${x.trackCount === 1 ? 'song' : 'songs'}` : null;
  return card({
    collection: `a${x.id}`, art: x.thumb, title: x.title,
    sub: [x.author, songs].filter(Boolean).join(' · ') || 'Playlist',
  });
}

function searchBody() {
  const q = state.search.trim();
  if (!q) {
    const art = [...state.home.radio, ...state.home.recent].filter((t) => t?.thumb);
    const recent = state.searchRecent.slice(0, 6);
    const played = state.home.recent ?? [];
    return `${recent.length ? `<div class="search-recent" aria-label="Recent searches">
        ${recent.map((s) => `<button class="chip small" data-recent-search="${esc(s)}">${icon('clock', 'xs')}${esc(s)}</button>`).join('')}
        <button class="chip small ghost" data-action="clear-recent-searches">Clear</button></div>` : ''}
      ${sectionHeader('Browse by feeling', 'Whatever the mood, there is music for it.', 'View your library', 'library')}
      <div class="mood-grid">${MOODS.map((m, i) => `
        <button class="mood" style="--mood:${m.bg}" data-mood="${esc(m.q)}" aria-label="Browse ${esc(m.name)}">
          <span class="mood-name">${esc(m.name)}</span>
          ${art[i] ? `<img src="${esc(artSrc(art[i].thumb, location.href) ?? art[i].thumb)}" alt="" loading="lazy" decoding="async" draggable="false">` : ''}
          <span class="mood-arrow">${icon('arrow-right', 'sm')}</span></button>`).join('')}</div>
      ${sectionHeader('Pick up where you left off', 'Your recent tracks, ready to replay.', 'See all', 'library')}
      <div class="search-track-list">${played.length
        ? trackRows(played.slice(0, 5), false)
        : emptyState({ art: 'spark', title: 'Nothing here yet',
          text: 'Search for an artist or a song you love — sonora builds the rest.',
          actions: `<button class="play-btn" data-page="radio">${icon('wave')} Open radio</button>` })}</div>`;
  }
  const results = state.searchResults ?? null;
  if (results === null) return `<div class="search-hint"><span class="spinner"></span> Searching YouTube…</div>${skRows(5)}`;

  const artists = state.searchArtists ?? [];
  const albums = state.searchAlbums ?? [];
  const playlists = state.searchPlaylists ?? [];
  const counts = state.searchCounts ?? {
    tracks: results.length, artists: artists.length, albums: albums.length, playlists: playlists.length,
  };
  const active = searchFilterKey();
  const shows = (type) => active === 'all' || active === type;
  const total = results.length + artists.length + albums.length + playlists.length;

  if (!total) {
    return `${searchFilterBar()}${emptyState({ art: 'search', title: `No match for “${q}”`,
      text: 'Try an artist, a track title, or one of these moods.',
      actions: MOODS.slice(0, 3).map((m) => `<button class="chip" data-mood="${esc(m.q)}">${esc(m.name)}</button>`).join('') })}`;
  }

  // A type tab with nothing behind it is a real answer, so it says which tab
  // came up empty instead of showing a blank page (or, worse, falling back to
  // the songs and pretending the filter did nothing).
  const shelfEmpty = (label) => emptyState({
    art: 'search', title: `No ${label.toLowerCase()} for “${q}”`,
    text: 'The other tabs may have what you meant — or try a different spelling.',
    actions: `<button class="chip" data-filter="all">Show all results</button>`,
  });

  // Artists first: searching a band's name is asking for the band, and the
  // page behind the chip is where their popular songs, albums and neighbours
  // live. A song list alone cannot answer that.
  const sections = [];
  if (shows('artist')) {
    sections.push(artists.length
      ? searchShelf('Artists', counts.artists ?? artists.length, `<div class="artist-strip">${artists.map((a) => `
        <button class="artist-chip" data-action="artist" data-artist="${esc(a.id ?? a.title)}"
          aria-label="Open ${esc(a.title)}">
          <span class="artist-chip-art">${cover(null, 'cover artist-avatar', a.thumb)}</span>
          <span class="artist-chip-copy"><strong>${esc(a.title)}</strong>
            <small>${esc(a.subscribers || 'Artist')}</small></span></button>`).join('')}</div>`)
      : (active === 'artist' ? shelfEmpty('Artists') : ''));
  }
  if (shows('song')) {
    sections.push(results.length
      ? searchShelf('Songs', counts.tracks ?? results.length, `<div class="search-track-list">${trackRows(results, false)}</div>`)
      : (active === 'song' ? shelfEmpty('Songs') : ''));
  }
  if (shows('album')) {
    sections.push(albums.length
      ? searchShelf('Albums', counts.albums ?? albums.length,
        `<div class="library-grid shelf">${albums.map(searchAlbumCard).join('')}</div>`)
      : (active === 'album' ? shelfEmpty('Albums') : ''));
  }
  if (shows('playlist')) {
    sections.push(playlists.length
      ? searchShelf('Playlists', counts.playlists ?? playlists.length,
        `<div class="library-grid shelf">${playlists.map(searchPlaylistCard).join('')}</div>`)
      : (active === 'playlist' ? shelfEmpty('Playlists') : ''));
  }

  return `${searchFilterBar()}<div class="search-shelves">${sections.filter(Boolean).join('')}</div>`;
}

function libraryPage() {
  const tab = state.libraryTab;
  // Playlists are already in state; only Albums/Artists are fetched lazily.
  const key = tab === 'Playlists' ? null : tab.toLowerCase();
  const loading = key ? state.browse[key] == null : false;
  const items = key ? sortList(state.browse[key] ?? []) : [];
  const playlists = sortList(state.playlists);

  const likedCard = card({
    collection: 'liked', art: null, title: 'Liked songs',
    sub: `${state.liked.size} ${state.liked.size === 1 ? 'song' : 'songs'}`,
  });

  let body;
  if (loading) {
    // A persisted tabs selection can land here before anything was fetched.
    if (key) setTimeout(() => loadBrowse(key), 0);
    body = skCards(4);
  }
  else if (tab === 'Playlists') {
    body = playlists.length || state.liked.size
      ? `<div class="library-grid shelf">${likedCard}${playlists.map((p) => card({
        collection: `p${p.id}`,
        art: p.artVideo ? `https://i.ytimg.com/vi/${p.artVideo}/hqdefault.jpg` : null,
        title: p.title, sub: `${p.trackCount} ${p.trackCount === 1 ? 'song' : 'songs'}`,
      })).join('')}</div>`
      : emptyState({ art: 'list', title: 'Your library is waiting',
        text: 'Save a song you like, or start a playlist for a mood you keep coming back to.',
        actions: `<button class="play-btn" data-action="create">${icon('plus')} New playlist</button>
          <button class="secondary-btn" data-page="search">Find music</button>` });
  } else if (tab === 'Artists') {
    // Followed artists are fetched the first time this tab is opened, next to
    // the browse shelf the tab already loads. A follow is an explicit choice,
    // so it is listed first and outranks the artists the history inferred; the
    // same artist never appears twice (by channel id, or by name when the
    // history only ever knew the name).
    if (state.follows == null) setTimeout(loadFollows, 0);
    const followed = state.follows ?? [];
    const followedIds = new Set(followed.map((f) => f.id));
    const followedNames = new Set(followed.map((f) => String(f.title).toLowerCase()));
    const known = items
      .filter((a) => !followedIds.has(a.id) && !followedNames.has(String(a.title).toLowerCase()))
      .map((a) => ({ ...a, following: false }));
    const all = [...followed, ...known];
    body = all.length
      ? `<div class="library-grid shelf">${all.map((a) => `
          <button class="music-card sleeve-tile" data-action="artist" data-artist="${esc(/^UC[\w-]{20,}$/.test(a.id ?? '') ? a.id : a.title)}" aria-label="${esc(a.title)}">
            <div class="cover-wrap artist-wrap sleeve-tile-art">${cover(null, 'cover artist-avatar', a.thumb)}</div>
            ${a.following ? '<span class="following-tag">Following</span>' : ''}
            <div class="music-card-title sleeve-tile-title">${esc(a.title)}</div>
            <div class="music-card-sub sleeve-tile-sub">${esc(a.subscribers || 'Artist')}</div></button>`).join('')}</div>`
      : emptyState({ art: 'headphones', title: 'No artists yet',
        text: 'Artists you follow — and the ones you play enough of — collect here.',
        actions: '<button class="secondary-btn" data-page="search">Find an artist</button>' });
  } else {
    body = items.length
      ? `<div class="library-grid shelf">${items.map((a) => card({
          collection: `a${a.id}`, art: a.thumb, title: a.title, sub: a.author || 'Album',
        })).join('')}</div>`
      : emptyState({ art: 'wave', title: 'No albums yet',
        text: 'Play a few tracks and albums from those artists will collect here.',
        actions: '<button class="secondary-btn" data-page="search">Browse music</button>' });
  }

  return `<div class="page-head"><div><span class="page-overline">Your music, your way</span>
      <h1 class="page-title">Your library<span class="accent">.</span></h1></div>
    <div class="page-head-actions">
      <button class="secondary-btn" data-action="create">${icon('plus', 'sm')} New playlist</button>
    </div></div>
  <div class="toolbar-row"><div class="segmented" role="tablist" aria-label="Library sections">
    ${['Playlists', 'Albums', 'Artists'].map((t) =>
      `<button role="tab" aria-selected="${tab === t}" class="segment ${tab === t ? 'is-active' : ''}" data-library-tab="${esc(t)}">${esc(t)}</button>`).join('')}
  </div><button class="icon-btn sort-btn" data-action="sort" title="Sort collection" aria-label="Sort collection" aria-haspopup="menu">${icon('list')}</button></div>
  ${body}`;
}

function radioPage() {
  const seeds = state.home.recent.slice(0, 6);
  const stations = [
    ['After Hours', 'Night Drive', 'Electronic for the streets after dark.', 'linear-gradient(135deg,#4b3a6b,#2a2337)'],
    ['Quiet Hours', 'Soft Focus', 'Just enough sound to slow down.', 'linear-gradient(135deg,#3f6f6b,#233534)'],
    ['Sunday Morning', 'Daybreak', 'Bright melodies and lighter mornings.', 'linear-gradient(135deg,#a4713f,#4a3428)'],
    ['Slow Jams', 'Velvet Skies', 'For the late-night listeners.', 'linear-gradient(135deg,#8c4a63,#3d2633)'],
    ['High Energy', 'In Motion', 'Stay in motion, no matter what.', 'linear-gradient(135deg,#8d4a3a,#3c2823)'],
    ['The Night Shift', 'Moonflower', 'Ambient sounds for drifting away.', 'linear-gradient(135deg,#4c5183,#272a44)'],
  ];
  const featureSeed = seeds[0];
  return `<div class="page-head"><div><span class="page-overline">Always something on</span>
      <h1 class="page-title">Turn it up<span class="accent">.</span></h1></div>
    <div class="page-head-actions">
      <button class="secondary-btn" data-action="${featureSeed ? 'play-seed' : 'go-search'}">${icon(featureSeed ? 'play' : 'search', 'sm')} ${featureSeed ? 'Play radio' : 'Find a seed'}</button>
    </div></div>
  <div class="radio-feature"><div class="radio-copy" style="position:relative;z-index:1">
    <span class="radio-live"><span class="live-dot"></span> ON AIR · SONORA RADIO</span>
    <h2>Good music.<br>All day long.</h2>
    <p>Every station is built live from YouTube's own recommendation graph, seeded by a track you actually like.</p>
    <button class="play-btn" data-action="${featureSeed ? 'play-seed' : 'go-search'}">${icon(featureSeed ? 'play' : 'search')}${featureSeed ? 'Tune in' : 'Find a seed'}</button></div>
    <div class="radio-graphics" aria-hidden="true">${Array.from({ length: 15 }, (_, i) =>
      `<i style="--h:${18 + Math.round((Math.sin(i * 1.8) + 1) * 45)}px"></i>`).join('')}</div></div>
  ${sectionHeader('Stations for every mood', 'Press play and leave the choosing to us.', 'Browse mixes', 'library')}
  <div class="station-grid">${stations.map(([name, tagline, desc, tone], i) => {
    const seed = seeds[i % Math.max(1, seeds.length)];
    return `<button class="station" style="--tone:${tone}" ${seed ? `data-action="station" data-id="${esc(seed.videoId)}"` : 'data-action="go-search"'}
        aria-label="${seed ? `Play ${esc(name)} station` : `Find music for ${esc(name)}`}">
      <div class="station-art">${cover(null, 'cover', seed?.thumb ?? null)}<span class="station-play">${icon(seed ? 'play' : 'search')}</span></div>
      <div class="station-body"><small>${esc(tagline)}</small><strong>${esc(name)}</strong><p>${esc(desc)}</p>
        <span class="station-meta">${seed ? 'STATION · LIVE' : 'STATION · NEEDS A SEED'}</span></div>
    </button>`;
  }).join('')}</div>`;
}

// ── browse by feeling ───────────────────────────────────────────────────
// A feeling is not a song. Searching songs for "rnb" used to return 4-hour
// single-video mixes — technically results, useless as listening. A mood page
// shows real community playlists (each one a list of songs you can open and
// pick from) plus the catalogue's own top songs for that feeling.

function moodPage() {
  const m = state.mood;
  if (!m) return collectionSkeleton();
  const head = `<div class="page-head"><div><span class="page-overline">Browse by feeling</span>
      <h1 class="page-title">${esc(m.name)}<span class="accent">.</span></h1></div>
      <div class="page-head-actions">
        <button class="text-link" data-page="search">All feelings ${icon('arrow-right')}</button>
      </div></div>`;

  if (m.error) {
    return `${head}${emptyState({
      art: 'close', title: 'Could not load this feeling', text: m.error,
      actions: `<button class="secondary-btn" data-mood="${esc(m.q)}">Try again</button>`,
    })}`;
  }

  const playlists = m.playlists ?? [];
  const top = m.top ?? [];
  const loading = m.playlists == null;

  const listSection = `${sectionHeader('Playlists for this feeling',
    'Real track lists — open one and choose the songs you want.', '', '')}
    ${loading ? skCards(6) : playlists.length
    ? `<div class="library-grid shelf">${playlists.map((p) => card({
      collection: `a${p.id}`, art: p.thumb, title: p.title,
      sub: [p.trackCount ? `${p.trackCount} songs` : null, p.author].filter(Boolean).join(' · ') || 'Playlist',
    })).join('')}</div>`
    : emptyState({ art: 'wave', title: 'No playlists for this one',
      text: 'Try another feeling — the catalogue answers best for the moods it knows.',
      actions: '<button class="secondary-btn" data-page="search">Browse feelings</button>' })}`;

  const songsSection = `${sectionHeader('Top songs right now',
    'One version of each song, from the artist — play straight from here.', '', '')}
    ${loading ? skRows(5) : top.length
    ? `<div class="search-track-list">${trackRows(top, false)}</div>`
    : ''}`;

  return `${head}${listSection}${songsSection}`;
}

async function loadMood(q) {
  const known = MOODS.find((x) => x.q === q);
  state.mood = { q, name: known?.name ?? q, playlists: null, top: null, error: null };
  render();
  try {
    const [lists, songs] = await Promise.all([
      api(`/api/browse/playlists?q=${encodeURIComponent(q)}`),
      api(`/api/search?q=${encodeURIComponent(q)}`),
    ]);
    if (state.mood?.q !== q) return;
    state.mood.playlists = lists.items ?? [];
    state.mood.top = songs.tracks.slice(0, 8);
    rememberTracks(state.mood.top);
  } catch (err) {
    if (state.mood?.q !== q) return;
    state.mood.error = err.message;
    state.mood.playlists = [];
    state.mood.top = [];
  }
  if (state.page === 'mood') render();
}

// ── artists ─────────────────────────────────────────────────────────────
// "Who is this and what should I hear next" is a different question from "play
// this track". The artist page answers it from the catalogue: popular songs,
// the releases they belong to, the videos, and the artists YouTube files next
// to them. Opening it is how a song becomes a body of work.

// The artist page leads with its own hero, which already carries the name and
// the "Artist" overline. It used to prepend a second page-head with both, so
// every artist route shipped two <h1>s and the same caps label twice.

function artistView() {
  const a = state.artist;
  if (!a) {
    return `<div class="artist-hero"><div class="sk sk-cover xl round"></div>
        <div class="sk-lines" style="flex:1;max-width:420px">
          <div class="sk sk-line w-35"></div><div class="sk sk-line w-70 tall"></div>
          <div class="sk sk-line w-60"></div></div></div>${skRows(6)}`;
  }
  if (a.error) {
    return `${emptyState({
      art: 'close', title: 'Could not load this artist', text: a.error,
      actions: `<button class="secondary-btn" data-action="retry-artist" data-id="${esc(a.key)}">Try again</button>
        <button class="secondary-btn" data-page="search">Back to search</button>`,
    })}`;
  }

  const songs = a.songs ?? [];
  const videos = a.videos ?? [];
  const albums = a.albums ?? [];
  const singles = a.singles ?? [];
  const adjacent = a.adjacent ?? [];
  // A follow is keyed by a channel id — the only handle the server can check
  // for new releases. An artist page resolved from a plain name still comes
  // back with its channel id; if one ever does not, there is nothing honest to
  // press, so the control is simply not rendered.
  const channelId = /^UC[\w-]{20,}$/.test(a.id ?? '') ? a.id : null;
  const following = Boolean(a.following);

  const albumGrid = (list, label, blurb = '') => (list.length
    ? `${sectionHeader(label, blurb, '', '')}
      <div class="library-grid shelf">${list.map((x) => card({
        collection: `a${x.id}`, art: x.thumb, title: x.title,
        sub: [x.type, x.year].filter(Boolean).join(' · ') || 'Album',
      })).join('')}</div>`
    : '');

  return `<div class="artist-hero">
      <div class="artist-hero-art">${cover(null, 'cover artist-avatar', a.thumb, 'eager', true)}</div>
      <div class="artist-hero-copy"><span class="collection-type">Artist</span>
        <h1>${esc(a.name ?? 'Artist')}</h1>
        ${a.description ? `<p>${esc(a.description)}</p>` : ''}
        <div class="collection-meta"><strong>YouTube Music</strong>${songs.length ? ` · ${songs.length} popular songs` : ''}${albums.length ? ` · ${albums.length} release${albums.length === 1 ? '' : 's'}` : ''}</div>
      </div></div>
    <div class="collection-actions">
      <button class="play-btn" data-action="play-artist" aria-label="Play ${esc(a.name ?? 'artist')}" title="Play popular songs">${icon('play')}</button>
      <button class="circle-action" data-action="shuffle-artist" aria-label="Shuffle ${esc(a.name ?? 'artist')}" title="Shuffle popular songs">${icon('shuffle')}</button>
      <button class="circle-action" data-action="artist-radio" aria-label="Start a station from ${esc(a.name ?? 'this artist')}" title="Start a station from this artist">${icon('wave')}</button>
      ${channelId ? followButtonMarkup(channelId, a.name ?? 'Artist', following) : ''}
    </div>
    ${songs.length
    ? `${sectionHeader('Popular songs', 'What people actually play, straight from the catalogue.', '', '')}
      <div class="search-track-list">${trackRows(songs, true)}</div>`
    : emptyState({ art: 'wave', title: 'No popular songs listed',
      text: 'This artist page has no catalogue songs right now.',
      actions: `<button class="secondary-btn" data-action="artist-radio">${icon('wave', 'sm')} Start a station anyway</button>` })}
    ${albumGrid(albums, 'Albums', 'Open one to see its track list.')}
    ${albumGrid(singles, 'Singles & EPs')}
    ${videos.length
    ? `${sectionHeader('Videos', 'Official uploads from the same artist.', '', '')}
      <div class="search-track-list">${trackRows(videos, false)}</div>`
    : ''}
    ${adjacent.length
    ? `${sectionHeader('Fans also like', 'The neighbours YouTube files this artist next to.', '', '')}
      <div class="artist-strip">${adjacent.map((x) => `
        <button class="artist-chip" data-action="artist" data-artist="${esc(x.id ?? x.name)}" aria-label="Open ${esc(x.name)}">
          <span class="artist-chip-art">${x.thumb ? cover(null, 'cover artist-avatar', x.thumb) : icon('headphones')}</span>
          <span class="artist-chip-copy"><strong>${esc(x.name)}</strong><small>Artist</small></span>
        </button>`).join('')}</div>`
    : ''}`;
}

/**
 * The follow control. A real toggle button, so its state is announced
 * (`aria-pressed`) as well as shown, and the label itself says which state it
 * is in — someone who cannot see the accent colour still knows.
 */
function followButtonMarkup(artistId, name, following) {
  return `<button class="secondary-btn follow-btn${following ? ' is-following' : ''}" data-action="follow-artist"
      data-artist="${esc(artistId)}" data-name="${esc(name)}" aria-pressed="${following}"
      aria-label="${following ? 'Following' : 'Follow'} ${esc(name)}"
      title="${following ? `Unfollow ${esc(name)}` : `Follow ${esc(name)} for release notifications`}">${icon(following ? 'check' : 'plus', 'sm')}<span>${following ? 'Following' : 'Follow'}</span></button>`;
}

/**
 * Repaint the follow button in place, in both directions.
 *
 * A full `render()` would scroll the artist page back to the top and drop
 * focus from the control the listener just pressed, which is exactly the kind
 * of jump that makes an optimistic update feel broken. Only the attributes and
 * the label change here; the element (and its focus) survives.
 */
function paintFollowButton(following) {
  const btn = document.querySelector('#page-root [data-action="follow-artist"]');
  if (!btn) return;
  const name = btn.dataset.name || 'Artist';
  btn.classList.toggle('is-following', following);
  btn.setAttribute('aria-pressed', String(following));
  btn.setAttribute('aria-label', `${following ? 'Following' : 'Follow'} ${name}`);
  btn.title = following ? `Unfollow ${name}` : `Follow ${name} for release notifications`;
  btn.innerHTML = `${icon(following ? 'check' : 'plus', 'sm')}<span>${following ? 'Following' : 'Follow'}</span>`;
}

/**
 * Follow or unfollow an artist from their page.
 *
 * The button flips immediately: following baselines the artist's releases
 * upstream, which can take a moment, and a toggle that waits looks broken. The
 * server's answer is then authoritative — whatever `following` it reports is
 * what the page shows — and a failure puts the button back and says why.
 */
async function setFollowing(artistId, name, next) {
  const key = state.artist?.key;
  const before = Boolean(state.artist?.following);
  if (before === next) return;
  state.artist = { ...(state.artist ?? {}), following: next };
  paintFollowButton(next);
  try {
    const path = `/api/artists/${encodeURIComponent(artistId)}/follow`;
    const res = next
      ? await api(path, { method: 'POST', body: { name: name || null, thumb: state.artist?.thumb ?? null } })
      : await api(path, { method: 'DELETE' });
    const confirmed = typeof res?.following === 'boolean' ? res.following : next;
    if (state.artist?.key === key) {
      state.artist = { ...state.artist, following: confirmed };
      paintFollowButton(confirmed);
    }
    // The library's Artists tab lists follows, so the next visit must not show
    // the list from before this tap.
    state.follows = null;
    notify(confirmed ? `Following ${name || 'artist'}` : `Unfollowed ${name || 'artist'}`, 'info');
  } catch (err) {
    if (state.artist?.key === key) {
      state.artist = { ...state.artist, following: before };
      paintFollowButton(before);
    }
    notify(err.message, 'error');
  }
}

function openArtist(idOrName) {
  const key = String(idOrName ?? '').trim();
  if (!key) return;
  if (state.page === 'artist' && state.artist?.key === key) return;
  navigate('artist', key);
}

async function loadArtist(idOrName) {
  const key = String(idOrName ?? '').trim();
  if (!key) return;
  // The skeleton is rendered immediately (a 2-3 s catalogue fetch must never
  // look like a dead page), then replaced by the real shelves.
  state.artist = { key };
  if (state.page === 'artist') render();
  try {
    const data = await api(`/api/artist/${encodeURIComponent(key)}`);
    if (state.artist?.key !== key) return;
    state.artist = { ...data, key };
    rememberTracks([...(data.songs ?? []), ...(data.videos ?? [])]);
  } catch (err) {
    if (state.artist?.key !== key) return;
    state.artist = { key, error: err.message };
  }
  if (state.page === 'artist' && state.artist?.key === key) {
    await render();
    document.title = pageTitle();
    $('main-scroll').scrollTop = 0;
  }
}

/**
 * Open the release a track came from.
 *
 * Rows from a catalogue search carry their album id already; everything else
 * (up next, videos, an old queue) asks the server, which searches the catalogue
 * for the same song. A miss is reported as "no album" rather than opening a
 * guessed one.
 */
async function openAlbumFor(videoId, trigger = null) {
  const known = trackIndex.get(videoId) ?? (current()?.videoId === videoId ? current() : null);
  if (known?.albumId) return openCollection(`a${known.albumId}`);

  const btn = trigger;
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const q = new URLSearchParams();
    if (known?.title) q.set('title', known.title);
    if (known?.artist || known?.channel) q.set('artist', known.artist || known.channel);
    const { albumId } = await api(`/api/album/for/${encodeURIComponent(videoId)}?${q}`);
    if (!albumId) { notify('No album found for this track.', 'info'); return; }
    if (known) { trackIndex.set(videoId, { ...known, albumId }); evictTrackIndex(); }
    await openCollection(`a${albumId}`);
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = prev; }
  }
}

// ── the personal station ────────────────────────────────────────────────
// Pinned, and named after the person it belongs to. Unlike Radio (which needs
// a seed the user picks) this is always there and always theirs: built from
// what they listened through and liked, then widened outwards in steps — the
// same artists, their neighbours, and what is big in the same lane. The mix is
// deliberate: two familiar tracks for every discovery one (see src/station.js).

/**
 * The line under "The station queue".
 *
 * One function because two places write it: the page render, and the in-place
 * repaint after the queue window is trimmed behind the playhead.
 */
const stationQueueNote = (n) => `${n} songs in the queue and more arriving as you listen. Every skip and every play-through re-seeds the next stretch — the station grows instead of looping.`;

function stationPage() {
  const s = state.station;
  const name = s?.name ?? 'Your station';
  const head = `<div class="page-head"><div><span class="page-overline">Your station</span>
      <h1 class="page-title">${esc(name)}<span class="accent">.</span></h1></div>
      <div class="page-head-actions">${s && !s.empty
    ? `<button class="secondary-btn" data-action="rebuild-station">${icon('shuffle', 'sm')} Rebuild</button>` : ''}</div></div>`;

  if (state.stationError) {
    return `${head}${emptyState({
      art: 'close', title: 'Could not build your station', text: state.stationError,
      actions: '<button class="secondary-btn" data-action="rebuild-station">Try again</button>',
    })}`;
  }
  if (!s) {
    return `${head}<div class="station-hero"><div class="sk sk-line w-40"></div>
      <div class="sk sk-line w-70 tall"></div><div class="sk sk-line w-60"></div></div>${skRows(6)}`;
  }
  if (s.empty) {
    return `${head}${emptyState({
      art: 'spark',
      title: 'Your station builds itself',
      text: s.blurb,
      actions: '<button class="secondary-btn" data-page="search">Find something to play</button>',
    })}`;
  }

  const seedCount = s.seeds?.length ?? 0;
  const playedThrough = s.seeds?.filter((x) => !x.liked).length ?? 0;
  const likedSeeds = s.seeds?.filter((x) => x.liked).length ?? 0;
  // While the station is what is playing, the page shows the *live* queue: it
  // has grown past the first page by then, and hiding that would make the
  // endless part invisible exactly where the listener looks for it.
  const live = stationPlaying() ? state.queue : null;
  const rows = live ?? s.tracks;
  // Four covers read as a mix; one cover reads as a single album. Anything in
  // between looks like a broken grid, so fall back to the single cover.
  const art = rows.filter((t) => t.thumb).slice(0, 4);
  return `${head}
  <div class="station-hero">
    <div class="station-hero-art${art.length >= 4 ? '' : ' single'}" aria-hidden="true">
      ${art.length >= 4 ? art.map((t) => cover(null, 'cover', t.thumb, 'lazy')).join('')
        : art.length ? cover(null, 'cover', art[0].thumb, 'lazy')
          : `<span class="station-card-mark">${icon('spark')}</span>`}
    </div>
    <div class="station-hero-copy">
      <span class="eyebrow">STATION · ${seedCount} ${seedCount === 1 ? 'SEED' : 'SEEDS'} · ENDLESS</span>
      <h2>${esc(s.blurb)}</h2>
      <div class="station-hero-actions">
        <button class="play-btn" data-action="play-station">${icon('play')}Play station</button>
        <button class="secondary-btn" data-action="shuffle-station">${icon('shuffle', 'sm')}Shuffle</button>
      </div>
      ${playedThrough || likedSeeds ? `<p class="station-seeds">Seeded by
        ${s.seeds.slice(0, 3).map((x) => `<strong>${esc(x.title ?? '')}</strong>`).join(', ')}${seedCount > 3 ? ` and ${seedCount - 3} more` : ''}.</p>` : ''}
    </div>
  </div>
  ${sectionHeader(live ? 'The station queue' : 'Up next', live
    ? stationQueueNote(rows.length)
    : 'Your songs, then more from the artists you play, then their neighbours and what is big in the same lane. It keeps going: what you play through here becomes a seed for the next stretch.', '', '')}
  ${trackRows(rows, true, 'station')}`;
}

async function loadStation({ force = false, silent = false } = {}) {
  if (state.stationLoading) return;
  state.stationLoading = true;
  if (!silent) state.stationError = null;
  try {
    const data = await api(`/api/station${force ? '?fresh=1' : ''}`);
    state.station = data;
    rememberTracks(data.tracks ?? []);
  } catch (err) {
    if (!silent) state.stationError = err.message;
  } finally {
    state.stationLoading = false;
  }
  // The station page is built from this answer, so it is rebuilt.
  if (state.page === 'station') { render(); return; }
  // The silent load exists to fill the home page's station strip — the name, and
  // whether it is still building. It used to call render(), so a cold boot
  // painted home and then repainted the whole page a few hundred milliseconds
  // later (the flash the review saw), and it threw away any scroll or focus the
  // listener had already gained in between. Patch the strip and the one nav
  // label that reads the same state.
  if (silent && state.page === 'home') patchHomeStationStrip();
}

/** Repaint the home page's station strip in place (see loadStation). */
function patchHomeStationStrip() {
  syncStationNavLabel();
  const strip = $('page-root')?.querySelector('.sleeve-station');
  if (strip) strip.outerHTML = homeStationStrip();
}

// ── instance admin ──────────────────────────────────────────────────────
// The admin page is only reachable when /api/me reports role='admin'. The
// server re-checks the role on every /api/admin request, so hiding the UI is
// convenience, never the security boundary.

const ADMIN_TABS = [
  ['overview', 'Overview'],
  ['users', 'Users'],
  ['library', 'Library'],
  ['storage', 'Storage'],
  ['system', 'System'],
];

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
};

const fmtDuration = (sec) => {
  if (!Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.floor(sec)}s`;
};

const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
};

const fmtAgo = (iso) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(iso);
};

async function loadAdminTab(tab, { force = false } = {}) {
  if (!isAdmin()) return;
  if (state.admin.loading[tab]) return;
  if (state.admin.data[tab] && !force) return;

  state.admin.loading[tab] = true;
  try {
    const endpoint = tab === 'library'
      ? `/api/admin/tracks?q=${encodeURIComponent(state.admin.trackQuery)}`
      : `/api/admin/${tab}`;
    state.admin.data[tab] = await api(endpoint);
    state.admin.error = null;
  } catch (err) {
    state.admin.error = err.message;
  } finally {
    state.admin.loading[tab] = false;
  }

  if (state.page === 'admin' && state.admin.tab === tab) {
    render();
    if (tab === 'library' && state.admin.trackFocus) {
      const input = $('admin-track-search');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      state.admin.trackFocus = false;
    }
  }
}

/** Mutations invalidate the tabs they touch; nothing is guessed to be fresh. */
function invalidateAdmin(...tabs) {
  for (const tab of tabs) delete state.admin.data[tab];
}

function adminPage() {
  if (!isAdmin()) return emptyState({ art: 'shield', title: 'Administrator access required',
    text: 'This area is limited to the instance owner.',
    actions: '<button class="secondary-btn" data-page="home">Back to music</button>' });
  const tab = state.admin.tab;
  const body = adminBody(tab);
  return `<div class="page-head"><div><span class="page-overline">Owner controls</span>
      <h1 class="page-title">Instance control<span class="accent">.</span></h1>
      <p class="admin-lede">Accounts, content, storage and the YouTube session for this instance.</p></div>
    <div class="page-head-actions">
      <button class="secondary-btn" data-admin="refresh">${icon('repeat', 'sm')} Refresh</button>
    </div></div>
  <div class="toolbar-row"><div class="chips scroll" role="tablist" aria-label="Admin sections">
    ${ADMIN_TABS.map(([id, label]) => `<button class="chip ${tab === id ? 'selected' : ''}" role="tab"
      aria-selected="${tab === id}" data-admin-tab="${id}">${label}</button>`).join('')}
  </div><span class="admin-who">${icon('shield', 'sm')} ${esc(state.user.name)} · admin</span></div>
  ${state.admin.error ? `<div class="admin-error">${esc(state.admin.error)}
    <button class="text-link" data-admin="refresh">Retry</button></div>` : ''}
  ${body}`;
}

function adminBody(tab) {
  const data = state.admin.data[tab];
  if (!data) {
    // Do not auto-retry a failed load: render the error once, with a Retry
    // button, instead of spinning render -> fetch -> render forever.
    if (state.admin.error) return '';
    void loadAdminTab(tab);
    return `<div class="sk-hero"></div>${skCards(3)}`;
  }
  if (tab === 'overview') return adminOverview(data);
  if (tab === 'users') return adminUsers(data);
  if (tab === 'library') return adminLibrary(data);
  if (tab === 'storage') return adminStorage(data);
  if (tab === 'system') return adminSystem(data);
  return emptyState({ art: 'list', title: 'Unknown section', text: 'Pick a section above.' });
}

function adminOverview(d) {
  const c = d.counts;
  const s = d.storage;
  const pct = s.limitBytes ? Math.min(100, (s.bytes / s.limitBytes) * 100) : 0;
  const stat = (label, value, hint) => `<div class="admin-stat">
    <span class="admin-stat-label">${label}</span><strong>${value}</strong>
    <span class="admin-stat-hint">${hint}</span></div>`;

  return `<div class="admin-stats">
      ${stat('Users', c.users, `${c.admins} admin${c.admins === 1 ? '' : 's'}${c.disabled ? ` · ${c.disabled} disabled` : ''}`)}
      ${stat('Plays', c.plays, 'taste signals recorded')}
      ${stat('Tracks', c.tracks, 'known videos')}
      ${stat('Likes', c.likes, 'across all users')}
      ${stat('Playlists', c.playlists, 'across all users')}
    </div>
  <div class="admin-grid">
    <section class="admin-card"><h3>Local audio cache</h3>
      <div class="admin-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="admin-kv"><span>${fmtBytes(s.bytes)}</span><span>${s.files} file${s.files === 1 ? '' : 's'}</span></div>
      <p class="admin-note">Limit ${fmtBytes(s.limitBytes)} · <code>${esc(s.dir)}</code></p>
      <button class="secondary-btn" data-admin-tab="storage">Manage storage ${icon('arrow-right', 'xs')}</button>
    </section>
    <section class="admin-card"><h3>Database</h3>
      <div class="admin-kv"><span>${fmtBytes(d.db.bytes)}</span><span>SQLite + WAL</span></div>
      <p class="admin-note"><code>${esc(d.db.path)}</code></p>
      <div class="admin-inline">
        <a class="secondary-btn" href="/api/admin/backup" download>Download backup</a>
        <button class="secondary-btn" data-admin="vacuum">Vacuum</button>
      </div>
    </section>
    <section class="admin-card"><h3>Instance</h3>
      <div class="admin-kv"><span>Node ${esc(d.system.node)}</span><span>pid ${d.system.pid}</span></div>
      <p class="admin-note">${esc(d.system.platform)} · up ${fmtDuration(d.system.uptimeSec)}</p>
      <div class="admin-kv"><span>YouTube session</span>
        <span class="admin-badge ${d.jar.connected ? 'on' : 'off'}">${d.jar.connected ? 'connected' : 'not connected'}</span></div>
      ${d.botGated ? '<p class="admin-note warn">YouTube is currently gating this IP.</p>' : ''}
      <button class="secondary-btn" data-admin-tab="system">System details ${icon('arrow-right', 'xs')}</button>
    </section>
  </div>
  <section class="admin-card"><h3>Recent admin activity</h3>
    ${auditTable(d.audit)}</section>`;
}

function auditTable(entries) {
  if (!entries?.length) return '<p class="admin-empty">No admin actions recorded yet.</p>';
  return `<div class="admin-table-wrap"><table class="admin-table audit responsive">
    <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
    <tbody>${entries.map((e) => `<tr>
      <td data-label="When">${esc(fmtWhen(e.createdAt))}</td>
      <td data-label="Admin">${esc(e.actorName ?? '—')}</td>
      <td data-label="Action"><code>${esc(e.action)}</code></td>
      <td data-label="Target">${esc(e.target ?? '—')}</td>
      <td data-label="Detail">${esc(e.detail ?? '')}</td></tr>`).join('')}</tbody></table></div>`;
}

function adminUsers(d) {
  return `<form class="admin-form" id="admin-new-user">
      <div class="admin-form-title">${icon('plus', 'sm')} Create an account</div>
      <input name="name" placeholder="name" autocomplete="off"
        pattern="[A-Za-z0-9._-]{1,40}" title="Letters, numbers, dot, dash or underscore" required>
      <input name="passphrase" type="password" placeholder="passphrase (6+ characters)"
        minlength="6" autocomplete="new-password" required>
      <select name="role" aria-label="Role"><option value="user">user</option><option value="admin">admin</option></select>
      <button class="play-btn" type="submit">Create</button>
    </form>
  <div class="admin-table-wrap"><table class="admin-table responsive">
    <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Plays</th><th>Playlists</th><th>Last active</th><th></th></tr></thead>
    <tbody>${d.users.map((u) => adminUserRow(u, d.me)).join('')}</tbody></table></div>
  <p class="admin-note">Roles live in the <code>users.role</code> column. The bootstrap account is
    an admin; promote a second one before demoting yourself.</p>`;
}

function adminUserRow(u, me) {
  const self = u.id === me;
  return `<tr class="${u.disabled ? 'is-disabled' : ''}">
    <td data-label="User"><div class="admin-user-name">${esc(u.name)}${self ? '<span class="admin-you">you</span>' : ''}</div>
      <div class="admin-sub">created ${esc(fmtDate(u.createdAt))}</div>
      <div class="admin-sub">${u.passkeys
        ? `${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'}` : 'passphrase only'} · ${u.devices ?? 0} device${(u.devices ?? 0) === 1 ? '' : 's'}</div></td>
    <td data-label="Role"><span class="admin-badge ${esc(u.role)}">${esc(u.role)}</span></td>
    <td data-label="Status"><span class="admin-badge ${u.disabled ? 'off' : 'on'}">${u.disabled ? 'disabled' : 'active'}</span></td>
    <td data-label="Plays">${u.plays}</td><td data-label="Playlists">${u.playlists}</td>
    <td data-label="Last active"><span title="${esc(fmtWhen(u.lastPlayedAt ?? u.lastLoginAt))}">${esc(fmtAgo(u.lastPlayedAt ?? u.lastLoginAt))}</span></td>
    <td class="admin-actions"><div class="admin-action-grid">
      <button data-admin="toggle-role" data-id="${u.id}" ${self ? 'disabled' : ''}>${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
      <button data-admin="reset-pass" data-id="${u.id}">Reset password</button>
      <button data-admin="signout" data-id="${u.id}">Sign out</button>
      <button data-admin="${u.disabled ? 'enable' : 'disable'}" data-id="${u.id}" ${self ? 'disabled' : ''}>${u.disabled ? 'Enable' : 'Disable'}</button>
      <button data-admin="clear-history" data-id="${u.id}">Clear history</button>
      <button class="danger" data-admin="delete-user" data-id="${u.id}" ${self ? 'disabled' : ''}>Delete</button>
    </div></td></tr>`;
}

function adminLibrary(d) {
  return `<div class="admin-search-row">
      <div class="search-box admin-search">${icon('search')}
        <input id="admin-track-search" type="search" autocomplete="off"
          value="${esc(state.admin.trackQuery)}" placeholder="Filter by title, channel or video id..."
          aria-label="Filter tracks"></div>
      <span class="admin-who">${d.tracks.length} shown</span></div>
    <div class="admin-table-wrap"><table class="admin-table responsive">
      <thead><tr><th>Track</th><th>Plays</th><th>Skips</th><th>Likes</th><th>Last seen</th><th></th></tr></thead>
      <tbody>${d.tracks.length ? d.tracks.map((t) => `<tr>
        <td data-label="Track"><div class="admin-user-name">${esc(t.title ?? t.videoId)}</div>
          <div class="admin-sub">${esc(t.channel ?? '')} · <code>${esc(t.videoId)}</code></div></td>
        <td data-label="Plays">${t.plays}</td><td data-label="Skips">${t.skips}</td>
        <td data-label="Likes">${t.likes}</td>
        <td data-label="Last seen">${esc(fmtAgo(t.lastSeen))}</td>
        <td class="admin-actions"><div class="admin-action-grid"><button class="danger" data-admin="delete-track"
          data-id="${esc(t.videoId)}">Delete</button></div></td></tr>`).join('')
        : '<tr><td colspan="6" class="admin-empty">No tracks match.</td></tr>'}</tbody></table></div>
    <p class="admin-note">Deleting a track removes it from every user's history, likes and playlists,
      and deletes its cached audio.</p>`;
}

function adminStorage(d) {
  const s = d.cache;
  const pct = s.limitBytes ? Math.min(100, (s.bytes / s.limitBytes) * 100) : 0;
  const limitMb = Math.round(s.limitBytes / 1024 / 1024);
  return `<div class="admin-grid">
    <section class="admin-card"><h3>Audio cache</h3>
      <div class="admin-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="admin-kv"><span>${fmtBytes(s.bytes)} used</span><span>${fmtBytes(s.limitBytes)} limit</span></div>
      <p class="admin-note">${s.files} file${s.files === 1 ? '' : 's'} in <code>${esc(s.dir)}</code></p>
      <div class="admin-form compact">
        <input id="admin-prune-mb" type="number" min="1" step="1" value="${limitMb}"
          aria-label="Cache limit in megabytes">
        <button class="secondary-btn" data-admin="prune">Prune to limit</button>
      </div>
      <button class="secondary-btn danger" data-admin="clear-cache">Delete all cached audio</button>
    </section>
    <section class="admin-card"><h3>Database</h3>
      <div class="admin-kv"><span>${fmtBytes(d.db.bytes)}</span><span>SQLite + WAL</span></div>
      <p class="admin-note"><code>${esc(d.db.path)}</code></p>
      <div class="admin-inline">
        <a class="secondary-btn" href="/api/admin/backup" download>Download backup</a>
        <button class="secondary-btn" data-admin="vacuum">Vacuum</button>
      </div>
      <p class="admin-note">A backup is a consistent snapshot taken with VACUUM INTO;
        it is safe to copy while the instance is running.</p>
    </section>
  </div>`;
}

function adminSystem(d) {
  const c = d.config;
  const jar = d.jar ?? {};
  const kv = (k, v) => `<div class="admin-kv"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`;
  return `<div class="admin-grid">
    <section class="admin-card"><h3>Runtime</h3>
      ${kv('Node', d.node)}${kv('Platform', d.platform)}${kv('PID', d.pid)}
      ${kv('Uptime', fmtDuration(d.uptimeSec))}${kv('RSS', fmtBytes(d.memory.rss))}
      ${kv('Heap', `${fmtBytes(d.memory.heapUsed)} / ${fmtBytes(d.memory.heapTotal)}`)}
    </section>
    <section class="admin-card"><h3>Configuration</h3>
      ${kv('Listen', `${c.host}:${c.port}`)}${kv('Database', c.dbPath)}${kv('Audio dir', c.audioDir)}
      ${kv('Cache limit', `${c.cacheMb} MB`)}${kv('Download timeout', `${c.downloadTimeoutMs} ms`)}
      ${kv('Max downloads', c.maxDownloads)}${kv('Session days', c.sessionDays)}
      ${kv('Trust proxy', c.trustProxy ? 'yes' : 'no')}
      ${kv('Session secret', c.secretConfigured ? 'configured' : 'generated (dev)')}
    </section>
    <section class="admin-card"><h3>YouTube session</h3>
      ${kv('Status', jar.connected ? 'connected' : 'not connected')}
      ${jar.source ? kv('Source', jar.source === 'env' ? 'environment variable' : 'imported file') : ''}
      ${jar.cookieCount ? kv('Cookies', jar.cookieCount) : ''}
      ${jar.importedAt ? kv('Imported', fmtWhen(jar.importedAt)) : ''}
      ${jar.verdict ? kv('Verification', jar.verdict) : ''}
      ${d.botGated ? '<p class="admin-note warn">YouTube is gating this IP right now.</p>' : ''}
      <div class="admin-inline">
        <button class="play-btn" data-admin="connect-yt">${icon('wave', 'sm')}
          ${jar.connected ? 'Replace session' : 'Connect session'}</button>
        ${jar.connected ? '<button class="secondary-btn danger" data-admin="clear-yt">Clear</button>' : ''}
        <button class="secondary-btn" data-admin="diagnose">Run diagnostics</button>
      </div>
      ${state.admin.diag ? diagHtml(state.admin.diag) : ''}
    </section>
  </div>`;
}

async function adminAction(action, id) {
  const uid = Number(id);
  const userOf = () => (state.admin.data.users?.users ?? []).find((u) => u.id === uid);
  try {
    switch (action) {
      case 'refresh':
        state.admin.error = null;
        await loadAdminTab(state.admin.tab, { force: true });
        break;

      case 'toggle-role': {
        const u = userOf();
        if (!u) return;
        const role = u.role === 'admin' ? 'user' : 'admin';
        if (!(await ask({
          title: `Make ${u.name} ${role === 'admin' ? 'an admin' : 'a regular user'}?`,
          text: role === 'admin'
            ? 'Admins can manage every account, the audio cache and the YouTube session.'
            : 'They keep their library and playlists but lose access to instance settings.',
          confirmLabel: 'Change role', danger: role === 'user',
        }))) return;
        await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { role } });
        notify(`${u.name} is now ${role === 'admin' ? 'an admin' : 'a regular user'}`);
        invalidateAdmin('overview');
        await loadAdminTab('users', { force: true });
        break;
      }

      case 'reset-pass': {
        const u = userOf();
        if (!u) return;
        openFormSheet(`<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
          <div class="form-body"><span class="eyebrow">Account</span><h2>New passphrase for ${esc(u.name)}</h2>
            <form id="admin-pass-form" data-uid="${uid}" novalidate>
              <label class="sr-only" for="admin-pass">New passphrase</label>
              <input id="admin-pass" name="password" type="password" minlength="6" autocomplete="new-password"
                required placeholder="At least 12 characters">
              <p class="field-hint">Every signed-in device for ${esc(u.name)} will be signed out.</p>
              <p class="field-error" id="admin-pass-error" role="alert"></p>
              <div class="form-actions"><button type="button" class="secondary-btn" data-action="close-form">Cancel</button>
                <button type="submit" class="play-btn">Set passphrase</button></div>
            </form></div>`, { label: 'Reset passphrase', focus: '#admin-pass' });
        break;
      }

      case 'disable':
      case 'enable': {
        const u = userOf();
        if (!u) return;
        const disabled = action === 'disable';
        if (disabled && !(await ask({
          title: `Disable ${u.name}?`,
          text: 'They are signed out immediately and cannot sign back in until you enable the account.',
          confirmLabel: 'Disable account', danger: true,
        }))) return;
        await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { disabled } });
        notify(disabled ? `${u.name} disabled` : `${u.name} enabled`);
        invalidateAdmin('overview');
        await loadAdminTab('users', { force: true });
        break;
      }

      case 'signout': {
        const u = userOf();
        if (!u) return;
        if (!(await ask({
          title: `Sign ${u.name} out everywhere?`,
          text: 'Their library is untouched; they simply have to sign in again on each device.',
          confirmLabel: 'Sign out',
        }))) return;
        const r = await api(`/api/admin/users/${uid}/signout`, { method: 'POST' });
        if (r.self) { notify('Signed out'); setTimeout(() => location.reload(), 700); return; }
        notify(`${u.name} signed out`);
        break;
      }

      case 'clear-history': {
        const u = userOf();
        if (!u) return;
        if (!(await ask({
          title: `Clear ${u.name}'s history?`,
          text: 'Every play event is deleted, so recommendations start fresh. Likes and playlists are kept.',
          confirmLabel: 'Clear history', danger: true,
        }))) return;
        const r = await api(`/api/admin/users/${uid}/clear-history`, { method: 'POST' });
        notify(`Removed ${r.removed} play events`);
        invalidateAdmin('overview', 'library');
        await loadAdminTab('users', { force: true });
        break;
      }

      case 'delete-user': {
        const u = userOf();
        if (!u) return;
        if (!(await ask({
          title: `Delete ${u.name}?`,
          text: 'The account, likes, playlists and play history are removed. This cannot be undone.',
          confirmLabel: 'Delete account', danger: true,
        }))) return;
        await api(`/api/admin/users/${uid}`, { method: 'DELETE' });
        notify(`${u.name} deleted`);
        invalidateAdmin('overview', 'library');
        await loadAdminTab('users', { force: true });
        break;
      }

      case 'delete-track': {
        if (!(await ask({
          title: 'Delete this track everywhere?',
          text: 'It is removed from every library and its cached audio file is deleted. It will download again if anyone plays it.',
          confirmLabel: 'Delete track', danger: true,
        }))) return;
        await api(`/api/admin/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
        notify('Track deleted');
        invalidateAdmin('overview', 'storage');
        await loadAdminTab('library', { force: true });
        break;
      }

      case 'prune': {
        const mb = Number($('admin-prune-mb')?.value);
        if (!Number.isFinite(mb) || mb <= 0) { notify('Enter a cache limit in megabytes.'); return; }
        const r = await api('/api/admin/storage/prune', { method: 'POST', body: { maxMb: mb } });
        notify(`Pruned ${r.removed} file${r.removed === 1 ? '' : 's'}`);
        invalidateAdmin('overview');
        await loadAdminTab('storage', { force: true });
        break;
      }

      case 'clear-cache': {
        if (!(await ask({
          title: 'Delete every cached audio file?',
          text: 'Nothing is lost from your library — tracks download again the next time they are played.',
          confirmLabel: 'Clear cache', danger: true,
        }))) return;
        const r = await api('/api/admin/storage/clear', { method: 'POST' });
        notify(`Deleted ${r.removed} cached file${r.removed === 1 ? '' : 's'}`);
        invalidateAdmin('overview');
        await loadAdminTab('storage', { force: true });
        break;
      }

      case 'vacuum': {
        await api('/api/admin/db/vacuum', { method: 'POST' });
        notify('Database vacuumed');
        invalidateAdmin('overview', 'storage');
        await loadAdminTab(state.admin.tab, { force: true });
        break;
      }

      case 'connect-yt':
        await refreshYtStatus();
        openYtSheet();
        break;

      case 'clear-yt': {
        if (!(await ask({
          title: 'Forget the YouTube session?',
          text: 'Playback keeps working while YouTube does not require a sign-in. You can reconnect at any time.',
          confirmLabel: 'Disconnect', danger: true,
        }))) return;
        await api('/api/youtube/cookies', { method: 'DELETE' });
        await refreshYtStatus();
        notify('YouTube session cleared');
        invalidateAdmin('overview', 'system');
        await loadAdminTab('system', { force: true });
        break;
      }

      case 'diagnose': {
        notify('Running diagnostics…');
        state.admin.diag = await api('/api/youtube/diagnose');
        await loadAdminTab('system', { force: true });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    notify(err.message);
  }
}

/**
 * The E / CLEAN tag after a track title.
 *
 * An explicit row shows "E" the way YouTube Music does. A clean row shows
 * "CLEAN" — spelling it out because a silent clean edit is exactly the bug
 * this marks: the whole point is that the listener can see *and tell* when
 * they are being served the censored edit.
 *
 * The tag is always a *sibling* of the element that holds the title text,
 * never a child of it: tests (and the media-session metadata they pin) read
 * `.track-name`/`.queue-text strong`/h2 textContent as the track title, and a
 * badge inside one of those would corrupt every comparison.
 */
function versionTag(t) {
  if (t?.version === 'explicit') return '<b class="ver-tag ver-explicit" title="Explicit">E</b>';
  if (t?.version === 'clean') return '<b class="ver-tag ver-clean" title="Clean edit — censored version">CLEAN</b>';
  return '';
}

function trackRows(tracks, headers = true, collection = null) {
  if (!tracks.length) {
    return emptyState({ art: 'wave', title: 'Nothing here yet',
      text: collection ? 'Add a few songs and they will show up here.' : 'Play something and it will show up here.',
      actions: '<button class="secondary-btn" data-page="search">Find music</button>' });
  }
  rememberTracks(tracks);
  state.lastCollection = tracks;
  const act = current();
  const anyAlbum = tracks.some((t) => t.album);
  const head = headers ? `<div class="track-header" aria-hidden="true"><span>#</span><span>Title</span>
    <span class="track-album">${anyAlbum ? 'Album' : ''}</span><span></span><span></span>
    <span style="text-align:right">${icon('clock', 'xs')}</span></div>` : '';
  const rows = tracks.map((t, i) => {
    const isNow = act && act.videoId === t.videoId && state.playing;
    const liked = state.liked.has(t.videoId);
    const disliked = state.disliked.has(t.videoId);
    const label = `${t.title ?? t.videoId}${t.channel ? ` by ${t.channel}` : ''}`;
    // The album cell is a link to the release when we know (or can look up)
    // which one it is. It is a button, not an <a>: opening an album is an
    // in-app route, and the row around it is already interactive.
    const albumCell = t.album
      ? `<button class="track-album track-album-link" data-action="open-album" data-id="${esc(t.videoId)}"${t.albumId ? ` data-album="${esc(t.albumId)}"` : ''}
          aria-label="Open the album ${esc(t.album)}" title="Open album">${esc(t.album)}</button>`
      : '<span class="track-album"></span>';
    return `<div class="track-row ${isNow ? 'active' : ''}" data-track="${esc(t.videoId)}"${collection ? ` data-coll="${esc(collection)}"` : ''}
        role="listitem" tabindex="0" aria-label="Play ${esc(label)}"${isNow ? ' aria-current="true"' : ''}>
      <div class="track-index"><span>${i + 1}</span>
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>${icon('play', 'xs')}</div>
      <div class="track-details">${cover(null, 'cover', t.thumb, 'lazy')}
        <div class="track-desc"><div class="track-title-line"><div class="track-name">${esc(t.title ?? t.videoId)}</div>${versionTag(t)}</div><div class="track-artist">${esc(t.channel ?? '')}</div></div></div>
      ${albumCell}
      <button class="like-row ${liked ? 'liked' : ''}" data-action="heart" data-id="${esc(t.videoId)}"
        aria-pressed="${liked}" aria-label="${liked ? 'Remove from' : 'Add to'} liked songs">${icon('heart', 'sm')}</button>
      <button class="like-row dislike-row ${disliked ? 'is-disliked' : ''}" data-action="dislike" data-id="${esc(t.videoId)}"
        aria-pressed="${disliked}" aria-label="${disliked ? 'Undo "less like this"' : 'Play this less often'}"
        title="${disliked ? 'Undo "less like this"' : 'Less like this'}">${icon('thumb-down', 'sm')}</button>
      <span class="track-time">${Number.isFinite(t.durationS) && t.durationS > 0 ? fmt(t.durationS) : ''}</span>
      <button class="track-more" data-action="track-menu" data-id="${esc(t.videoId)}"
        aria-label="More options for ${esc(t.title ?? '')}" aria-haspopup="menu">${icon('dots', 'sm')}</button>
    </div>`;
  }).join('');
  // A list, not a table.
  //
  // The rows carried `role="row"` and nothing around them had a table role, so
  // every track in every list was an orphan row: a required-parent violation on
  // every page, and a row announced with no column context at all. A real
  // `<table>`/`role="grid"` was not available without wrapping each cell — the
  // row is a CSS grid of six columns and three of them *are* the buttons, which
  // a cell role would strip of their button semantics and a wrapper would
  // reflow. The list is what the markup actually is: an ordered set of playable
  // entries, each already carrying its own name in `aria-label`.
  return `<div class="track-list ${headers ? '' : 'compact'}" role="list">${head}${rows}</div>`;
}

function collectionSkeleton(type = 'Playlist') {
  return `<div class="collection-hero"><div class="sk sk-cover xl"></div>
      <div class="sk-lines" style="flex:1;max-width:420px">
        <div class="sk sk-line w-35"></div><div class="sk sk-line w-70 tall"></div><div class="sk sk-line w-60"></div></div></div>
    <div class="sk-actions"><div class="sk sk-pill"></div><div class="sk sk-pill"></div></div>
    ${skRows(6)}`;
}

async function collectionPage() {
  const c = state.collection;
  if (!c) return emptyState({ art: 'list', title: 'Nothing selected', text: 'Pick a playlist, an album or a station.' });
  if (state.collectionLoading) return collectionSkeleton();
  if (state.collectionError) {
    return emptyState({ art: 'close', title: 'Could not load this collection', text: state.collectionError,
      actions: `<button class="secondary-btn" data-action="retry-collection" data-id="${esc(c)}">Try again</button>` });
  }

  if (c === 'liked' || c === 'recent') {
    const tracks = c === 'liked' ? (state.likedTracks ?? []) : (state.home.recent ?? []);
    return collectionShell({
      title: c === 'liked' ? 'Liked songs' : 'Recently played',
      type: 'Your collection',
      desc: c === 'liked' ? 'All the songs you have saved, in one place.' : 'Everything you have played, newest first.',
      tracks, art: tracks[0]?.thumb ?? null, id: c,
      empty: c === 'liked' ? 'Tap the heart on any track and it lands here.' : 'Play a song and it will be waiting here.',
    });
  }

  if (c.startsWith('p')) {
    const pl = state.collectionData;
    if (!pl) return collectionSkeleton();
    return collectionShell({
      title: pl.title, type: 'Playlist',
      desc: pl.description || `${pl.tracks.length} songs, hand-picked.`,
      tracks: pl.tracks, art: pl.tracks[0]?.thumb ?? null, id: c, playlistId: pl.id,
      empty: 'This playlist is empty. Find something you love and add it here.',
    });
  }

  if (c.startsWith('a')) {
    const data = state.collectionData;
    if (!data) return collectionSkeleton();
    return collectionShell({
      title: data.title, type: data.type ?? 'Album', desc: data.author || '',
      tracks: data.tracks, art: data.art ?? data.tracks[0]?.thumb ?? null, id: c,
      // The way back up: an album belongs to an artist, and that is where the
      // rest of their work is.
      artist: data.author ? { name: data.author, id: data.authorId ?? null } : null,
      empty: 'This album has no playable tracks.',
    });
  }

  return emptyState({ art: 'list', title: 'Nothing selected', text: 'Pick a playlist, an album or a station.' });
}

/** 157 min is a worse thing to read than "2 hr 37 min". */
function humanDuration(seconds) {
  const total = Math.round((seconds || 0) / 60);
  if (!total) return '';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`;
}

function collectionShell({ title, type, desc, tracks, art, id, playlistId, artist = null, empty = '' }) {
  const length = humanDuration(totalTime(tracks));
  const source = artist
    ? `<button class="artist-link" data-action="artist" data-artist="${esc(artist.id || artist.name)}">${esc(artist.name)}</button>`
    : `<strong>${esc(type === 'Album' || type === 'Single' ? 'YouTube' : 'sonora')}</strong>`;
  return `<div class="collection-hero ${String(title).length > 26 ? 'compact' : ''}">
      <div class="collection-art">${cover(null, 'cover', art, 'eager', true)}</div>
    <div class="collection-copy"><span class="collection-type">${esc(type)}</span><h1>${esc(title)}</h1>
      ${desc ? `<p>${esc(desc)}</p>` : ''}
      <div class="collection-meta">${source}${tracks.length ? ` · ${tracks.length} song${tracks.length === 1 ? '' : 's'}` : ''}${length ? ` · ${length}` : ''}</div>
    </div></div>
  <div class="collection-actions">
    <button class="play-btn" title="Play ${esc(title)}" aria-label="Play ${esc(title)}" data-action="play-collection" data-id="${esc(id)}">${icon('play')}</button>
    <button class="circle-action" title="Shuffle play" aria-label="Shuffle play ${esc(title)}" data-action="shuffle-play" data-id="${esc(id)}">${icon('shuffle')}</button>
    <button class="circle-action" title="Add to queue" aria-label="Add to queue" data-action="queue-collection" data-id="${esc(id)}">${icon('queue')}</button>
    ${playlistId ? `<button class="circle-action" title="More options" aria-label="More playlist options" aria-haspopup="menu" data-action="playlist-menu" data-id="${playlistId}">${icon('dots')}</button>` : ''}
    <span class="collection-count">${tracks.length ? `${tracks.length} songs` : ''}</span>
  </div>
  ${sectionHeader('Songs', '', '', '')}
  ${tracks.length ? trackRows(tracks, true, id) : emptyState({ art: 'plus', title: 'Nothing in here yet', text: empty || 'Add a few songs and they will show up here.',
    actions: '<button class="secondary-btn" data-page="search">Find music</button>' })}`;
}

// ── player chrome ───────────────────────────────────────────────────────
function rail() {
  const t = current();
  if (!t) {
    return `<div class="rail-top"><span class="rail-label">NOW PLAYING</span></div>
      <div class="rail-cover">${cover(null, 'cover', null)}</div>
      <div class="rail-track-info"><div><h2>Nothing playing</h2><span>Pick a track to start</span></div></div>
      <div class="rail-divider"></div>
      <div class="session-card"><span class="eyebrow">KEEP THE FEELING</span>
        <div class="session-title">Your soundtrack, uninterrupted.</div>
        <p>Search for a song you love, then let the radio do the rest.</p></div>`;
  }
  const up = [...state.queue.slice(state.index + 1), ...state.queue.slice(0, state.index)].slice(0, 4);
  return `<div class="rail-top"><span class="rail-label">NOW PLAYING</span>
      <button class="icon-btn" data-action="nowplaying" title="Expand player">${icon('arrow-right', 'sm')}</button></div>
    <div class="rail-cover" data-action="nowplaying" role="button" tabindex="0" aria-label="Open now playing">
      ${cover(null, 'cover', t.thumb, 'eager')}<div class="rail-live"><span class="live-dot"></span> YOUR SESSION</div></div>
    <div class="rail-track-info"><div><h2>${esc(t.title)}</h2>
      <span>${(t.channelId || t.channel)
        ? `<button class="rail-artist" data-action="artist" data-artist="${esc(t.channelId || t.channel)}" aria-label="Open ${esc(t.channel)}'s artist page">${esc(t.channel)}</button>`
        : esc(t.channel ?? '')}</span></div>
      <button class="icon-btn ${state.liked.has(t.videoId) ? 'primary' : ''}" data-action="heart"
        data-id="${esc(t.videoId)}" aria-pressed="${state.liked.has(t.videoId)}"
        aria-label="${state.liked.has(t.videoId) ? 'Remove from' : 'Add to'} liked songs">${icon('heart')}</button>
      <button class="icon-btn ${state.disliked.has(t.videoId) ? 'is-disliked' : ''}" data-action="dislike"
        data-id="${esc(t.videoId)}" aria-pressed="${state.disliked.has(t.videoId)}"
        aria-label="${state.disliked.has(t.videoId) ? 'Undo "less like this"' : 'Play this less often'}"
        title="Less like this">${icon('thumb-down')}</button></div>
    <div class="waveform ${state.playing ? 'playing' : ''}">${Array.from({ length: 36 }, (_, i) =>
      `<i style="--h:${6 + Math.round(Math.abs(Math.sin(i * 8.82) * 26 + Math.cos(i * 2.17) * 6))}px"></i>`).join('')}</div>
    <div class="rail-divider"></div>
    <div class="rail-section-head"><strong>Up next</strong>
      <button data-action="queue">View queue →</button></div>
    <div class="rail-queue">${up.length ? up.map((x) => `<div class="queue-mini" data-action="play-track" data-id="${esc(x.videoId)}">
      ${cover(null, 'cover', x.thumb)}<div class="queue-text">
        <strong>${esc(x.title)}</strong><span>${esc(x.channel ?? '')}</span></div>
      <span class="duration">${fmt(x.durationS)}</span></div>`).join('')
      : `<div class="rail-queue-empty">${state.stationQueue
        ? 'Your station keeps going ahead of you. Skips teach it what to play next.'
        : 'Nothing queued yet. Play an album or start a station and the runway appears here.'}</div>`}</div>`;
}

function playerBar() {
  const t = current();
  const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t?.durationS || 0);
  const pos = playerPosition();
  const percent = dur ? Math.min(100, (pos / dur) * 100) : 0;
  const playIcon = state.playing ? 'pause' : 'play';
  const resuming = !state.playing && !state.sourceStarted && state.pendingResumeMs > 1000;
  const progress = `<div class="mini-progress" aria-hidden="true"><i></i></div>`;

  if (!t) {
    return `${progress}<div class="player-song">
      <button class="player-cover player-cover-empty" data-page="search" aria-label="Find music">${icon('wave')}</button>
      <div class="player-song-meta"><strong>Nothing playing</strong><span>Pick a track to start</span></div></div>
      <div class="player-controls">
        <div class="player-transport">
          <button data-action="prev" aria-label="Previous song" disabled>${icon('prev')}</button>
          <button class="main-toggle" data-action="playpause" aria-label="Play" disabled>${icon('play', 'fill')}</button>
          <button data-action="next" aria-label="Next song" disabled>${icon('next')}</button>
        </div>
      </div>
      <div class="player-extras"><button class="secondary-btn" data-page="search">${icon('search', 'sm')} Find music</button></div>`;
  }

  // The song block is just cover + title, so the title gets the whole left
  // column at every width. The taste actions sit with the other utilities.
  return `${progress}<div class="player-song">
      <button class="player-cover" data-action="nowplaying" aria-label="Open now playing">${cover(null, 'cover', t.thumb, 'eager')}</button>
      <div class="player-song-meta">
        <strong role="button" tabindex="0" data-action="nowplaying"><span>${esc(t.title)}</span></strong>
        <span>${(t.channelId || t.channel)
          ? `<button class="player-song-artist" data-action="artist" data-artist="${esc(t.channelId || t.channel)}" aria-label="Open ${esc(t.channel)}'s artist page">${esc(t.channel)}</button>`
          : esc(t.channel ?? '')}${resuming ? ` · resumes at ${fmt(state.pendingResumeMs / 1000)}` : ''}</span></div>
      <button class="icon-btn player-like ${state.liked.has(t.videoId) ? 'primary' : ''}" data-action="heart"
        data-id="${esc(t.videoId)}" aria-pressed="${state.liked.has(t.videoId)}" aria-label="Like this song">${icon('heart', 'sm')}</button>
      <button class="icon-btn player-dislike ${state.disliked.has(t.videoId) ? 'is-disliked' : ''}" data-action="dislike"
        data-id="${esc(t.videoId)}" aria-pressed="${state.disliked.has(t.videoId)}"
        aria-label="${state.disliked.has(t.videoId) ? 'Undo "less like this"' : 'Play this less often'}"
        title="Less like this">${icon('thumb-down', 'sm')}</button></div>
  <div class="player-controls">
    <div class="player-transport">
      <button class="ctrl ${state.shuffle ? 'on' : ''}" data-action="shuffle" aria-label="Shuffle" aria-pressed="${state.shuffle}">${icon('shuffle')}</button>
      <button class="ctrl" aria-label="Previous song" data-action="prev">${icon('prev')}</button>
      <button class="main-toggle" data-action="playpause" aria-label="${state.playing ? 'Pause' : 'Play'}">${icon(playIcon, 'fill')}</button>
      <button class="ctrl" aria-label="Next song" data-action="next">${icon('next')}</button>
      <button class="ctrl ${state.repeat ? 'on' : ''}" data-action="repeat" aria-label="Repeat ${['off', 'all', 'one'][state.repeat]}" aria-pressed="${state.repeat > 0}">${icon('repeat')}</button>
    </div>
    <div class="timebar"><span class="elapsed">${fmt(pos)}</span>
      <input aria-label="Track progress" class="range" type="range" min="0" max="${Math.max(1, Math.floor(dur))}"
        value="${Math.floor(pos)}" style="--percent:${percent}%" data-slider="progress">
      <span class="duration">${fmt(dur)}</span></div>
  </div>
  <div class="player-extras">
    <button class="icon-btn ${rooms.active ? 'room-on' : ''}" data-action="room"
      aria-label="${rooms.active ? 'Listen together — in a room' : 'Listen together'}" aria-haspopup="dialog">${icon('headphones')}</button>
    <button class="icon-btn" data-action="lyrics" aria-label="Lyrics" aria-haspopup="dialog">${icon('lyrics')}</button>
    <button class="icon-btn" data-action="queue" aria-label="Queue" aria-haspopup="dialog">${icon('queue')}</button>
    <!-- No "expand player" button here: the cover, the title and the rail arrow
         all open the same sheet. It cost 52px of a 283px column and pushed this
         cluster past its track, where it spilled left over the transport. -->
    <div class="volume-group"><button class="icon-btn" data-action="mute" aria-label="${state.muted ? 'Unmute' : 'Mute'}">${icon(state.muted ? 'mute' : 'volume')}</button>
      <input class="range" aria-label="Volume" data-slider="volume" type="range" min="0" max="100"
        value="${Math.round(state.volume * 100)}" style="--percent:${Math.round(state.volume * 100)}%"></div></div>
  <div class="mobile-player-control">
    <button data-action="playpause" aria-label="${state.playing ? 'Pause' : 'Play'}">${icon(playIcon, 'fill')}</button>
    <button data-action="next" aria-label="Next song">${icon('next', 'fill')}</button></div>`;
}

/**
 * Identify a control well enough to find it again after an innerHTML rebuild.
 *
 * Re-rendering `#page-root`, the player bar or the nav replaces the focused
 * element and throws focus to `<body>`, so Tab restarts at the top of the
 * document. Any of these attributes is stable across a repaint of the same
 * state, which makes it the re-focus key.
 */
const FOCUS_KEYS = ['data-library-tab', 'data-overlay-tab', 'data-admin-tab', 'data-filter',
  'data-page', 'data-action', 'data-collection', 'data-menu-action'];
function focusKey(el) {
  if (!el || el === document.body || el === document.documentElement || !el.getAttribute) return null;
  // Remember which surface the control was in: a heart exists in the player bar
  // and on every row of the page for the same track.
  const scope = el.closest('#player, #page-root, #rail-content, #mobile-nav, #desktop-nav, #side-playlists, #now-content, #queue-drawer');
  for (const key of FOCUS_KEYS) {
    const value = el.getAttribute(key);
    if (value) return { key, value, id: el.getAttribute('data-id'), scope: scope?.id ?? null };
  }
  return el.id ? { key: 'id', value: el.id, scope: scope?.id ?? null } : null;
}
function restoreFocus(key) {
  if (!key) return false;
  // Only a focused element that the rebuild actually destroyed falls back to
  // <body>; if focus is still somewhere real, it was never ours to move.
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) return false;
  const root = key.scope ? document.getElementById(key.scope) : document;
  if (!root) return false;
  let selector = `[${key.key}="${CSS.escape(key.value)}"]`;
  if (key.id) selector += `[data-id="${CSS.escape(key.id)}"]`;
  const hit = [...root.querySelectorAll(selector)].find((n) => n.getClientRects().length > 0);
  if (!hit) return false;
  hit.focus({ preventScroll: true });
  return true;
}

async function render() {
  const focus = focusKey(document.activeElement);
  renderNav();
  const root = $('page-root');
  const body = state.page === 'home' ? homePage()
    : state.page === 'search' ? searchPage()
    : state.page === 'mood' ? moodPage()
    : state.page === 'artist' ? artistView()
    : state.page === 'station' ? stationPage()
    : state.page === 'library' ? libraryPage()
    : state.page === 'radio' ? radioPage()
    : state.page === 'admin' ? adminPage()
    : state.page === 'security' ? securityPage()
    : state.page === 'room' ? roomPage()
    : await collectionPage();
  root.innerHTML = body;
  $('rail-content').innerHTML = rail();
  updatePlayer();
  refreshOverlay();
  updateRoomPill();
  document.title = pageTitle();
  restoreFocus(focus);
}

/**
 * Paint the player bar's 2px progress hairline.
 *
 * This runs on every `timeupdate` — four times a second for the whole session —
 * so it may only touch compositor-owned properties. It used to set `--progress`
 * on `#player`, and a custom property invalidates style for that element's
 * whole subtree: the scrubber, the cover, the 36-bar waveform and every control
 * were re-resolved on every tick. The `<i>` inside `.mini-progress` is now
 * pinned full width once and scaled into place, which the compositor can do
 * without a layout pass. app.css still sizes that element by `--progress`, so
 * the width is overridden inline; nothing else in the stylesheet reads it.
 */
function paintPlayerProgress(pos, dur) {
  const bar = $('player')?.querySelector('.mini-progress > i');
  if (!bar || !(dur > 0)) return;
  if (bar.style.width !== '100%') {
    bar.style.width = '100%';
    bar.style.transformOrigin = '0 50%';
  }
  bar.style.transform = `scaleX(${Math.min(1, Math.max(0, pos / dur)).toFixed(4)})`;
}

function updatePlayer() {
  const el = $('player');
  const focus = focusKey(document.activeElement);
  const t = current();
  el.classList.toggle('is-playing', !!state.playing);
  el.classList.toggle('is-empty', !t);
  el.innerHTML = playerBar();
  paintPlayerProgress(playerPosition(), playerDuration());
  restoreFocus(focus);
  if (!$('now-overlay').hidden) refreshOverlay();
  // Playback is the one thing that changes what the home sleeve is about.
  syncHomeFeatured();
}

/**
 * Keep the home sleeve in step with what is actually playing.
 *
 * `state.home.featured` used to be written only when a session save came back,
 * so a track started from the shelf left the hero showing the previous song (or
 * the first-run fallback) until the next reload — the player and the home page
 * disagreed about what was on. This is the single place playback state changes,
 * so it is the single place that adopts the current track into the sleeve.
 *
 * It repaints only the two home sections that read that state, and only when
 * the track really changed: a full `render()` here would reset the reading
 * position, and the player bar repaints constantly. Scroll and focus survive by
 * replacing the nodes in place and restoring the control that had focus.
 */
function syncHomeFeatured() {
  if (state.page !== 'home') return;
  const t = current();
  if (!t?.videoId || t.videoId === state.home.featured?.videoId) return;
  const root = $('page-root');
  const hero = root?.querySelector('.sleeve-hero');
  if (!hero) return; // the home page is not on screen
  const focus = focusKey(document.activeElement);
  state.home.featured = { ...t };
  state.home.featuredPos = state.pendingResumeMs > 0
    ? state.pendingResumeMs
    : Math.round((audio.currentTime || 0) * 1000);
  hero.outerHTML = homeHero();
  const shelf = root.querySelector('.sleeve-shelf');
  if (shelf) shelf.outerHTML = homeShelfBody();
  // outerHTML drops focus to <body>; put it back on the control it was on (the
  // tile that was just tapped, or the hero's resume button) without scrolling.
  restoreFocus(focus);
}

/**
 * Where the playhead will be. A restored session has no loaded metadata yet,
 * so its saved position is the honest answer until the first `playing` seeks
 * there; showing 0:00 would make "resume" look like "restart".
 *
 * While the element is playing the *queue* as one stream, its `currentTime` is
 * a position in the plan (hours of it), not in a track: the mapped offset is
 * the honest answer to "where in this song are we", and it is what the bar, the
 * lock screen and the session save all read.
 */
function playerPosition() {
  if (state.streaming) return (Number(state.streamOffsetMs) || 0) / 1000;
  // A restored/adopted session has no loaded metadata yet, so its saved
  // position is the honest answer until the first `playing` seeks there.
  if (state.pendingResumeMs > 0 && !state.sourceStarted) return state.pendingResumeMs / 1000;
  return audio.currentTime || 0;
}

/**
 * The length of the track the player is meant to be drawing, in seconds.
 *
 * The element's own `duration` is the plan's total while streaming (hours), so
 * ask the track for its length there instead.
 */
function playerDuration() {
  const known = Number(audio.duration);
  if (state.streaming) {
    // The plan's own duration for the track is the one the stream is playing.
    const streamed = Number(state.streamDurationMs) / 1000;
    if (streamed > 0) return streamed;
  }
  return Number.isFinite(known) && known > 0 ? known : (Number(current()?.durationS) || 0);
}

/**
 * Apply the saved playhead once the element knows how long the track is.
 *
 * Called from `loadedmetadata` and `playing`: iOS can emit `playing` while
 * `duration` is still unusable, and silently dropping the seek there would turn
 * "continue on this device" back into "restart from 0:00". The pending value is
 * only cleared once a real duration exists, so the next event can retry.
 */
function applyPendingResume() {
  if (!(state.pendingResumeMs > 0)) return;
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const target = state.pendingResumeMs / 1000;
  state.pendingResumeMs = 0;
  // The high bound used to be `target < duration - 2`, which threw away any
  // saved playhead in the last two seconds: the player bar advertised
  // "resumes at 3:59" and then restarted from 0:00. Resuming near the end is
  // the correct behaviour — the track plays its last second and the loop wrap
  // advances the queue, which is what a listener finishing a song on another
  // device expects to continue into.
  if (target > 1) {
    state.manualSeek = false;
    // Set lastTime first: assigning currentTime can fire `seeking`
    // synchronously, and a resume from a loaded 30 s playhead to 1.2 s must not
    // read as the loop wrap that skips the track.
    state.lastTime = target;
    audio.currentTime = target;
  }
}

// ── playback ────────────────────────────────────────────────────────────
/**
 * Say the new track to screen readers. `#player` is rebuilt constantly and has
 * no live region of its own, so an automatic advance used to be completely
 * silent; this is a polite, dedicated region (created on first use so no
 * markup change is needed) that only speaks when the track actually changes.
 */
let npAnnouncer = null;
let npAnnounced = null;
function announceNowPlaying(t) {
  if (!t?.videoId || t.videoId === npAnnounced) return;
  npAnnounced = t.videoId;
  if (!npAnnouncer) {
    npAnnouncer = document.createElement('div');
    npAnnouncer.id = 'np-announcer';
    npAnnouncer.className = 'sr-only';
    npAnnouncer.setAttribute('aria-live', 'polite');
    npAnnouncer.setAttribute('aria-atomic', 'true');
    document.body.append(npAnnouncer);
  }
  npAnnouncer.textContent = `Now playing: ${t.title ?? 'unknown track'}${t.channel ? ` by ${t.channel}` : ''}`;
}

function log(kind, extra = {}) {
  const t = current();
  if (!t) return;
  fetch('/api/events', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      videoId: t.videoId, kind, source: state.page,
      // Streamed playback reports the *track* playhead and length, not the
      // stream's (see playerPosition/playerDuration).
      positionMs: Math.round(playerPosition() * 1000),
      durationMs: Math.round(playerDuration() * 1000) || null,
      // The metadata travels with the event so the personal station can name a
      // track that was never searched (a shared link, an old queue).
      title: t.title ?? null, channel: t.channel ?? null,
      thumb: t.thumb ?? null, durationS: t.durationS ?? null,
      ...extra,
    }),
  }).catch(() => {});
}

function logSkipIfEarly() {
  if (state.startedAt == null) return;
  const played = (Date.now() - state.startedAt) / 1000;
  const dur = Number.isFinite(audio.duration) ? audio.duration : null;
  if (played < 30 || (dur && dur > 30 && played / dur < 0.2)) {
    log('skip', { positionMs: Math.round(played * 1000) });
  }
}

/**
 * How often the playhead alone is written back to the server while a track
 * plays.
 *
 * A save is a SQLite write and a radio wake-up for every other device on the
 * account, so the tick is deliberately coarse: everything that actually matters
 * to a second device is saved immediately by a `force` caller (a track change,
 * a pause, the tab going away, a queue edit). This interval only sets how stale
 * a mid-song resume can be.
 */
const SESSION_TICK_MS = 15_000;

/**
 * The composition last written to /api/now, so a tick can be a patch.
 *
 * A playhead tick has nothing new to say about the queue, and re-sending the
 * 60-track window every few seconds meant serialising ~58 KB on the main thread,
 * holding it in the network process (keepalive) and rewriting the player-state
 * row — hundreds of times an hour of listening, for a number that had moved by
 * a few seconds. The server merges a body that carries no `queue`, so only a
 * real change to the window (a new track, a reorder, a station page landing, a
 * restored session) pays for the full body.
 */
let sentSessionKey = '';
let sentSessionPlaying = null;
// Arrival order is not save order when two requests take different network
// paths. The timestamp orders save attempts; this per-device sequence breaks
// same-millisecond ties. Both ride along on full saves and small playhead patches.
let sessionSaveSequence = 0;

async function saveSession({ force = false, takeover = false } = {}) {
  // In a room the playhead belongs to the server. Writing /api/now here would
  // fight it (and could steal the personal session from another device that is
  // genuinely playing), so the personal-session plumbing is simply off.
  if (rooms.active) return;
  const now = Date.now();
  if (!force && now - state.savedAt < SESSION_TICK_MS) return;
  const t = current();
  if (!t) return;
  const wantsTakeover = takeover || state.claim;
  // Another device owns the session and the user has not played here since.
  // Writing now would steal it back from a device that is actually playing.
  if (state.sessionBlocked && !wantsTakeover) return;
  // A tab that only restored a session must not overwrite the playhead of the
  // one that is playing.
  if (!state.hasPlayed && !wantsTakeover) return;
  state.savedAt = now;
  // Save a window *around the playhead*, not the front of the queue. An endless
  // station queue grows past 60 entries, and the server stores at most 60: a
  // naive slice(0, 60) would resume an hour-old position on the wrong song.
  const start = Math.max(0, Math.min(state.index - 5, state.queue.length - 60));
  const windowTracks = state.queue.slice(start, start + 60);
  const positionMs = Math.round(playerPosition() * 1000);
  const clientSavedAt = Date.now();
  const clientSaveSeq = ++sessionSaveSequence;
  // What the server would be told by a full body. `start` is part of it because
  // a partial body's `index` is relative to the stored window: if the window
  // slid, the same track has a different offset in it.
  const windowKey = `${start}|${state.stationQueue ? 'station' : 'queue'}|${windowTracks.map((x) => x.videoId).join(',')}`;
  const playing = !audio.paused && state.playing;
  // A patch is only ever a playhead tick. Anything that changes what the stored
  // row *means* — a new window, or playing flipping to paused and back — goes
  // out in full, so a merge that handles nothing but `{videoId, index,
  // positionMs}` still cannot leave a paused session looking like it is playing.
  const full = windowKey !== sentSessionKey || playing !== sentSessionPlaying;
  const payload = full ? {
    queue: windowTracks.map((x) => ({
      videoId: x.videoId,
      title: String(x.title ?? '').slice(0, 300),
      channel: String(x.channel ?? '').slice(0, 200),
      thumb: String(x.thumb ?? '').slice(0, 500),
      durationS: x.durationS || null,
    })),
    index: state.index - start,
    positionMs,
    source: state.page,
    // A station queue must come back as a station, or a reload would freeze
    // the endless queue into a finite list of what happened to be in it.
    station: Boolean(state.stationQueue),
    deviceId, deviceName,
    playing, clientSavedAt, clientSaveSeq,
    // A user play intent claims the session; a periodic save does not.
    takeover: wantsTakeover,
  } : {
    // The patch: what moved, and the few fields the server cannot infer. A
    // merged row keeps its stored tracks, source and station flag.
    videoId: t.videoId,
    index: state.index - start,
    positionMs,
    playing,
    station: Boolean(state.stationQueue),
    deviceId, deviceName,
    clientSavedAt, clientSaveSeq,
    takeover: wantsTakeover,
  };
  // `keepalive` bodies are capped at 64 KiB by the browser, and a worst-case
  // 60-track window can reach it. A fetch that throws on size is swallowed as
  // "offline" below, so the saved position would silently stop updating.
  // Trim until the serialised body is safely under the cap. Only a full body
  // can be big: the patch above is a couple of hundred bytes by construction.
  const MAX_BODY = 58_000;
  let body = JSON.stringify(payload);
  if (full && body.length > MAX_BODY) {
    for (const entry of payload.queue) entry.thumb = '';
    body = JSON.stringify(payload);
  }
  if (full && body.length > MAX_BODY) {
    for (const entry of payload.queue) {
      entry.title = String(entry.title).slice(0, 120);
      entry.channel = String(entry.channel).slice(0, 80);
    }
    body = JSON.stringify(payload);
  }
  if (full && body.length > MAX_BODY) {
    // Last resort: keep the window up to the playhead, where the resume matters.
    payload.queue = payload.queue.slice(0, Math.max(1, payload.index + 1));
    body = JSON.stringify(payload);
  }
  let res;
  try {
    res = await fetch('/api/now', {
      method: 'PUT', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch {
    // Offline: keep the claim so the next attempt can still take over.
    return;
  }
  if (res.status === 409) {
    // Another device started playing while this one was writing. Adopt its
    // state and stop until the user chooses to play here again.
    const payload = await res.json().catch(() => null);
    if (payload?.state) adoptRemoteSession(payload.state, payload.updatedAt);
    return;
  }
  if (!res.ok) return;
  // The composition is only "sent" once the server has it: a failed write must
  // be re-sent in full next time rather than patched onto a row that predates
  // the queue this device is holding.
  if (full) { sentSessionKey = windowKey; sentSessionPlaying = playing; }
  const data = await res.json().catch(() => null);
  if (Number.isFinite(data?.updatedAt) && data.updatedAt > state.sessionUpdatedAt) {
    // Two saves can be in flight at once (a `playing` claim and the pause that
    // follows it); an older response must not move the clock backwards, or the
    // next visibility refresh would re-adopt a state it already has.
    state.sessionUpdatedAt = data.updatedAt;
  }
  state.claim = false;
  state.sessionBlocked = false;
  state.home.featured = { ...t };
  state.home.featuredPos = positionMs;
}

/**
 * The other device won the session. Mirror it here and stop writing, so the
 * two devices cannot ping-pong the position. Pressing play here claims it
 * back (see playPause / playIndex).
 */
function adoptRemoteSession(remote, updatedAt, { block = true } = {}) {
  if (!remote?.tracks?.length) return;
  state.sessionBlocked = block;
  state.claim = false;
  state.hasPlayed = false;
  state.sessionUpdatedAt = Math.max(
    state.sessionUpdatedAt,
    Number.isFinite(updatedAt) ? updatedAt : (remote.updatedAt ?? 0),
  );
  state.ending = false;
  state.switching = true;
  state.sourceStarted = false;
  state.lastTime = 0;
  if (!audio.paused) audio.pause();
  state.playing = false;
  state.queue = remote.tracks.map(completeTrack);
  state.index = Math.max(0, Math.min(remote.index ?? 0, state.queue.length - 1));
  state.stationQueue = remote.station
    ? { cursor: 3, seen: state.queue.map((x) => x.videoId), loading: false, misses: 0, retryAt: 0, done: false }
    : null;
  state.home.featured = state.queue[state.index];
  state.home.featuredPos = remote.positionMs ?? 0;
  state.pendingResumeMs = remote.positionMs ?? 0;
  state.resumeFrom = block && remote.deviceId !== deviceId ? (remote.deviceName ?? 'another device') : null;
  audio.src = `/api/stream/${state.queue[state.index].videoId}`;
  warmNext();
  maybeExtendStation();
  render();
  if (block) {
    notify(remote.deviceName ? `Picked up on your ${remote.deviceName}` : 'Picked up on another device', 'info');
  }
}

/**
 * Fetch the session again when the app becomes visible.
 *
 * Boot is not the only hand-off moment: a laptop left open on the home page
 * should pick up what the phone played five minutes ago, without a reload. Only
 * a *newer* server state is adopted, and only while this device is idle, so a
 * device that is playing never has its queue yanked out from under it.
 */
async function refreshSessionFromServer() {
  if (!state.user || state.playing) return;
  // A room is the session; adopting a personal one would yank the shared queue.
  if (rooms.active) return;
  let payload;
  try { payload = await api('/api/now'); } catch { return; }
  const remote = payload?.state;
  if (!remote?.tracks?.length) return;
  const stamp = Number.isFinite(payload.updatedAt) ? payload.updatedAt : (remote.updatedAt ?? 0);
  if (stamp <= state.sessionUpdatedAt) return;
  state.sessionUpdatedAt = stamp;
  // Another tab of this browser is still the same owner: adopt its queue and
  // playhead, but do not block future saves (this tab may play next).
  adoptRemoteSession(remote, stamp, { block: remote.deviceId !== deviceId });
}

/**
 * Ask the server to fetch the *next* track's audio while this one plays.
 *
 * A cold track costs one yt-dlp run (seconds, and much worse when the host's
 * DNS is slow); the queue already knows what comes next, so paying that cost
 * now turns "press next, wait" into "press next". Exactly one track ahead:
 * prefetching deeper spends bandwidth on songs that may never be reached, and
 * the server's download slots are shared.
 *
 * Fire and forget — nothing awaits this, and a failure is invisible because
 * the real /api/stream request retries and reports properly.
 */
function warmNext() {
  const nxt = state.queue[state.index + 1];
  clearTimeout(warmTimer);
  warmTimer = null;
  if (!nxt?.videoId) return;
  // Debounce to the track the listener settles on. Mashing "next" used to fire
  // one warm per skipped song; the server's download slots are FIFO, so the
  // track actually chosen could queue behind four abandoned prefetches.
  warmTimer = setTimeout(() => {
    warmTimer = null;
    // The queue may have moved on while the debounce waited.
    if (state.queue[state.index + 1]?.videoId !== nxt.videoId) return;
    fetch(`/api/warm/${encodeURIComponent(nxt.videoId)}`, {
      method: 'POST', credentials: 'same-origin', keepalive: true,
    }).catch(() => {});
  }, 400);
}

/** One debounced prefetch of "the next track", not one per skip. */
let warmTimer = null;

// ── the endless station ─────────────────────────────────────────────────
// A station is not a playlist: it must not stop, and it must not start over.
// The first page arrives with the station itself (30 songs); everything after
// it is asked for while a track is playing, so the listener never reaches an
// end and never waits.
//
// Three tracks of runway is the threshold: enough that a slow extension is
// still finished before the queue runs out, few enough that the station is
// always reacting to what has just been heard.
const STATION_AHEAD = 3;

/** Is the station what is playing right now? */
const stationPlaying = () => Boolean(state.stationQueue) && state.queue.length > 0;

/**
 * How many played entries stay in front of the playhead.
 *
 * An endless station appends a page every few tracks, for as long as the app is
 * open — days, in an installed PWA — so the queue and everything that renders it
 * (the drawer, the now-playing sheet, the station page) grew without bound. Only
 * a window behind the playhead is worth keeping: "previous" is a skip, not an
 * archive, and the drawer's "Earlier" section is a glance, not a history.
 */
const QUEUE_BEHIND = 20;

/**
 * Drop the queue entries that have scrolled far behind the playhead.
 *
 * `state.index` is rebased with the array: every consumer treats the queue as
 * the whole world, so the two must move together or "next" lands on the wrong
 * song. Nothing is offered up twice by dropping it — the station's `seen` list
 * remembers every id it ever handed over, and the /api/now window is saved
 * around the playhead, not from the front.
 *
 * Never while a room owns the queue: there `state.index` addresses the *shared*
 * queue the server keeps, and trimming it locally would make this device's row
 * numbers disagree with everyone else's.
 */
function trimQueueBehind(limit = QUEUE_BEHIND) {
  if (rooms.active) return 0;
  const drop = state.index - limit;
  if (drop <= 0) return 0;
  state.queue = state.queue.slice(drop);
  state.index -= drop;
  return drop;
}

/**
 * Ask the server for the next page of the station and append it to the queue.
 *
 * `exclude` is every id already in the queue *plus* everything the station has
 * handed over before, so a page that recommends a song already heard is not
 * appended twice. The cursor advances regardless of what comes back, so a dry
 * stretch cannot pin the station to one seed.
 */
async function extendStation() {
  const sq = state.stationQueue;
  if (!sq || sq.loading || sq.done) return 0;
  sq.loading = true;
  // The wire caps `exclude` at 400 ids, so *which* 400 matters. It used to keep
  // the first 400 — the queue's opening tracks plus the oldest ids the station
  // ever handed over — which meant a long session stopped telling the
  // recommender about the songs it had just played and started being offered
  // them again. Keep the newest instead: the recent past is what "do not repeat
  // yourself" means.
  const exclude = [...new Set([...state.queue.map((t) => t.videoId), ...sq.seen])]
    .filter(Boolean).slice(-400);
  try {
    const data = await api(`/api/station/next?cursor=${sq.cursor}&exclude=${encodeURIComponent(exclude.join(','))}`);
    // Leaving the station (or starting another queue) must stop this page from
    // landing: the request captured the old queue object, and appending its
    // answer to whatever queue is current now tailed a new playlist with
    // random station songs.
    if (state.stationQueue !== sq) return 0;
    // `fresh` checks sq.seen as well as the queue: `exclude` is capped at
    // 400 ids on the wire, so a track the station handed over long ago can
    // come back from the server once the queue has rotated past it — without
    // the seen filter it would be appended as if it were new.
    const seen = new Set(sq.seen);
    const fresh = (data.tracks ?? [])
      .filter((t) => t?.videoId && !seen.has(t.videoId) && !state.queue.some((q) => q.videoId === t.videoId));
    for (const t of data.tracks ?? []) if (t?.videoId) sq.seen.push(t.videoId);
    if (Number.isFinite(data.cursor)) sq.cursor = data.cursor;
    else sq.cursor += 3;
    // `empty` is terminal: the evidence itself is gone (no seeds left, or all
    // refused), so there is nothing to extend from. A page that merely found
    // nothing *new* only cools down — a track played through from here becomes
    // a seed, and that reopens the station.
    if (data.empty) sq.done = true;
    sq.misses = fresh.length ? 0 : sq.misses + 1;
    if (!fresh.length) {
      sq.retryAt = Date.now() + backoffMs(sq.misses);
      return 0;
    }
    rememberTracks(fresh);
    state.queue = [...state.queue, ...fresh.map(completeTrack)];
    // An endless station grows for the life of the session, so the window
    // behind the playhead is trimmed every time a page lands (see
    // trimQueueBehind). The append itself is a composition change, so the
    // station page is rebuilt below in either case.
    trimQueueBehind();
    // A new track was appended, so whatever was warmed is no longer the last
    // one in the queue — but the *next* one may not exist yet. Warm it now.
    if (state.queue.length === state.index + 2) warmNext();
    // The queue grew: every surface that lists it has to follow. The station
    // page lists the live queue, so `rowsChanged` rebuilds it; every other page
    // only needs the up-next rail and the player bar (a full render there would
    // rebuild the search field and steal focus from someone typing). Going
    // through refreshQueueViews() is also what repaints an *open* queue drawer —
    // it used to be left showing the queue as it was before the page landed.
    refreshQueueViews({ rowsChanged: true });
    return fresh.length;
  } catch {
    // Silence on purpose: the queue still has songs, and a later advance will
    // try again. A toast here would interrupt the music to report a hiccup.
    sq.misses += 1;
    sq.retryAt = Date.now() + backoffMs(sq.misses);
    return 0;
  } finally {
    sq.loading = false;
  }
}

/** 2 s, 4 s, 8 s… capped at a minute: a dry recommender is not asked twice a second. */
const backoffMs = (misses) => Math.min(60_000, 2000 * 2 ** Math.max(0, misses - 1));

/**
 * Top the station up if the runway is short. Cheap to call on every advance.
 *
 * After a dry page it waits (see backoffMs) instead of asking again
 * immediately: the recommender will not answer differently a second later, and
 * the queue still has songs to play meanwhile. Meanwhile the station *keeps*
 * playing — a dry stretch means it loops what it has, never that it goes quiet.
 */
function maybeExtendStation() {
  const sq = state.stationQueue;
  if (!sq || !state.queue.length || sq.loading || sq.done) return;
  if (state.queue.length - state.index - 1 > STATION_AHEAD) return;
  if (Date.now() < (sq.retryAt ?? 0)) return;
  extendStation();
}

/**
 * Start playing the station as an endless queue.
 *
 * `tracks` is the first page from /api/station. `seen` starts as those ids so
 * the first extension cannot repeat them.
 */
function playStation(tracks, { shuffle = false } = {}) {
  if (!tracks.length) { notify('Your station needs a few listens first.', 'info'); return; }
  rememberTracks(tracks);
  const list = tracks.map(completeTrack);
  // A room has one queue and no per-listener shuffle: a station is shared as
  // its first window, and the room's own "next" carries everyone forward.
  if (rooms.active && !state.roomApplying) {
    leaveStation();
    roomFollow({ queue: shuffle ? shuffled(list) : list, index: 0, playing: true });
    return;
  }
  state.queue = shuffle ? shuffled(list) : list;
  state.stationQueue = {
    cursor: 3, seen: list.map((t) => t.videoId), loading: false, misses: 0, retryAt: 0, done: false,
  };
  playIndex(0, { claim: true, queueChanged: true });
  notify(shuffle ? 'Shuffled — this station never ends' : 'Station playing · it never runs out', 'info');
}

/** Leaving the station (any other queue) stops the topping-up. */
function leaveStation() {
  state.stationQueue = null;
}

function playIndex(i, { resumeMs = 0, claim = false, queueChanged = false } = {}) {
  const t = state.queue[i];
  if (!t) { state.ending = false; return; }
  // A shared-queue jump is a room command; `roomApplying` marks the room's own
  // writes, so applying a remote state cannot echo back a command.
  if (rooms.active && !state.roomApplying) {
    rooms.command('select', { index: i, positionMs: resumeMs });
    return;
  }
  // A deliberate source change ends the queue stream, if one was playing: this
  // is the per-track player taking over (that is how the page leaves the stream
  // on the way back in, and how a lock-screen skip leaves it while hidden).
  if (state.streaming) {
    state.streaming = null;
    state.streamTrack = null;
    state.streamOffsetMs = 0;
    audio.loop = true;
  }
  const claimUndo = claim ? { hasPlayed: state.hasPlayed, blocked: state.sessionBlocked } : null;
  state.index = i;
  state.startedAt = null;
  // NOTE: `failures` is deliberately NOT reset here. Resetting it on every
  // advance would defeat the guard in the error handler and turn a broken
  // upstream into an endless skip through the queue. It resets on `playing`.
  state.manualSeek = false;
  state.lockSeek = false;
  state.lastTime = 0;
  state.sourceStarted = false;
  state.ending = false;
  state.switching = true;
  state.hasPlayed = true;
  if (claim) claimSession();
  state.pendingResumeMs = resumeMs;
  state.currentLyrics = null;
  // A locked phone is the one swap where WebKit can have rebuilt its GPU-side
  // audio session while the web process still caches `type: 'playback'`. The
  // cheap claim sees that stale cache and sends nothing; force the repair here,
  // before the source changes, so the new session is asked for playback before
  // it has to start the replacement source.
  if (document.visibilityState === 'hidden') repairAudioSession({ force: true });
  else claimAudioSession();
  audio.loop = true;
  audio.src = `/api/stream/${t.videoId}`;
  warmNext();
  // Keep the station's runway full from the moment a track starts, not only
  // when the next one is requested: a lock-screen skip can arrive first.
  maybeExtendStation();
  // Name the new track on the lock screen while it buffers, not after it
  // starts — otherwise a phone locked mid-load shows the previous song.
  nowPlaying.sync({ metadata: true });
  announceNowPlaying(t);
  audio.play().catch((err) => {
    // A superseded source (the listener pressed next again before this one
    // started) rejects with AbortError. Painting that as a pause makes the bar
    // say "Play" while the new track is already loading — or audible.
    if (current()?.videoId !== t.videoId) return;
    console.warn('play blocked', err.message);
    state.playing = false;
    // An interruption (another app taking the audio output) rejects this play
    // and leaves the element paused. A paused element fires no `timeupdate`, so
    // nothing else will ever look at it again: record that playback is still
    // wanted so the resume paths below have something to act on.
    if (document.visibilityState === 'hidden' && !state.userPause) {
      state.resumeWanted = true;
    }
    // Nothing will emit `playing` or `error` for a refused play, so a
    // `switching` left armed would keep dropping pause saves and stray `ended`
    // events until the next successful track start.
    state.switching = false;
    // A refused play must not turn this device's next save into a takeover
    // (see releaseFailedClaim): the device actually playing would be stolen
    // from on the next visibilitychange save.
    releaseFailedClaim(claimUndo);
    updatePlayer();
  });
  state.playing = true;
  // Arm the queue's continuous stream for the moment this page is hidden.
  // One request per track start, and it has to happen *before* the screen
  // locks: hidden is the one moment there is no time for a round trip, and on
  // iOS the moment script stops running (public/queue-stream.js).
  void armQueueStream();
  // A track advance is not a navigation. This used to be a full `render()`:
  // every track boundary — including the autonomous one at the end of a song —
  // re-assigned #page-root, #rail-content and #player, and reset #main-scroll
  // to the top. What actually changed is the player bar, the rail's now/next,
  // the queue drawer if it is open, and one "active" row marker.
  //
  // A station queue is endless, so the window behind the playhead is trimmed as
  // it advances. Anything dropped there changes the row indices the drawer and
  // the sheet render from, so those are forced rather than patched. A caller
  // that replaced the queue itself (`queueChanged`) is a different matter: on
  // the station page the rows *are* the live queue, so that page is rebuilt.
  const dropped = state.stationQueue ? trimQueueBehind() : 0;
  refreshQueueViews({ forceOverlay: dropped > 0, rowsChanged: queueChanged, trimmed: dropped });
  // With the now-playing sheet open, the lyrics pane is on screen. A new track
  // must not leave the previous song's words sitting under the new title — the
  // dislike button skips a track, so this is reachable in one tap.
  if (!$('now-overlay').hidden && state.overlayTab === 'lyrics') loadLyrics();
}

function playTrack(videoId, queue = null) {
  // Settings → "Queue the rest of the list when I start a song" (off by
  // default). With it on, starting one song from a list builds the queue from
  // that list; with it off nothing below changes.
  const filled = queue ? queueFillFromList(queue, videoId) : null;
  if (filled) {
    leaveStation();
    state.queue = filled;
    playIndex(0, { claim: true, queueChanged: true });
    return;
  }
  const base = queue ?? (state.queue.length ? state.queue : []);
  let idx = base.findIndex((x) => x.videoId === videoId);
  if (idx < 0) {
    base.push({ videoId });
    idx = base.length - 1;
  }
  // Playing a track is how you change what a room is listening to. No second
  // "add to room" step, and no separate room library to keep in sync.
  if (rooms.active && !state.roomApplying) {
    roomFollow({ queue: base, index: idx, positionMs: 0, playing: true });
    return;
  }
  // Jumping to a track *within* the queue that is playing keeps the station
  // alive (that is the queue the listener is in). Handing in a different list
  // starts a new context, so the endless station stops there.
  if (queue && queue !== state.queue) leaveStation();
  state.queue = base.map(completeTrack);
  playIndex(idx, { claim: true, queueChanged: true });
}

function playQueue(tracks, { shuffle = false } = {}) {
  if (!tracks.length) { notify('Nothing to play here yet.'); return; }
  if (rooms.active && !state.roomApplying) {
    const list = tracks.map(completeTrack);
    roomFollow({ queue: shuffle ? shuffled(list) : list, index: 0, playing: true });
    if (shuffle) notify('Shuffled');
    return;
  }
  leaveStation();
  rememberTracks(tracks);
  const list = tracks.map(completeTrack);
  state.queue = shuffle ? shuffled(list) : list;
  playIndex(0, { claim: true, queueChanged: true });
  if (shuffle) notify('Shuffled');
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextTrack({ back = false, userInitiated = false } = {}) {
  if (!state.queue.length) { state.ending = false; return; }
  // In a room the queue is shared, so "next" is the room's next — including a
  // skip from the lock screen or a headset button.
  if (rooms.active && !state.roomApplying) {
    if (userInitiated && !back) logSkipIfEarly();
    rooms.command(back ? 'prev' : 'next');
    return;
  }
  if (userInitiated && !back) logSkipIfEarly();
  const n = state.queue.length;
  let idx = state.index;
  if (state.shuffle && !back && n > 1) {
    // Shuffle must not pick the track that is already playing; with two songs
    // the old formula had a 50% chance of "next" replaying the same one.
    do { idx = Math.floor(Math.random() * n); } while (idx === state.index);
  } else {
    idx = (idx + (back ? -1 : 1) + n) % n;
  }
  // A station is endless: top it up before it can wrap, so "next" never
  // replays the beginning of the queue. The wrap below is what other queues do
  // (a playlist loops), and for the station it is the fallback while a dry
  // recommender is being retried — never the normal path.
  playIndex(idx, { claim: userInitiated });
}

/**
 * This device is now the owner of the session. Only an explicit play intent
 * calls this: a periodic save from a device that merely has the app open must
 * not take the playhead away from the one that is actually playing.
 */
function claimSession() {
  state.claim = true;
  state.hasPlayed = true;
  state.sessionBlocked = false;
  // The hero's "from your iPhone / Continue here" framing is over once this
  // device has taken over; it would otherwise keep claiming to be resuming.
  state.resumeFrom = null;
}

/**
 * Undo a session claim whose play() was refused.
 *
 * A claim is what turns the next /api/now save into `takeover: true`. If the
 * play never actually started (autoplay policy, a refused stream), a claim
 * that survives makes this device steal the session from the one genuinely
 * playing — as soon as a visibilitychange save fires. Roll back only when
 * this device was a *reader* before the claim: a device that was already
 * playing keeps its ownership, and an unblocked older claim is not affected.
 */
function releaseFailedClaim(before) {
  if (!before || !(before.blocked || !before.hasPlayed)) return;
  state.claim = false;
  state.hasPlayed = before.hasPlayed;
  state.sessionBlocked = before.blocked;
}

function playPause() {
  if (!current()) return;
  if (rooms.active) {
    // Optimistic locally, authoritative on the server: the returned snapshot
    // reconciles every device, and a race is resolved by the last command.
    const willPlay = audio.paused;
    if (willPlay) { claimAudioSession(); audio.play().catch(() => {}); }
    else audio.pause();
    state.playing = willPlay;
    updatePlayer();
    rooms.command(willPlay ? 'play' : 'pause', {
      positionMs: Math.round((audio.currentTime || 0) * 1000),
    });
    return;
  }
  if (audio.paused) {
    claimAudioSession();
    // An explicit play here is the one action that may take the session back
    // from another device. If the browser refuses the play, the claim is
    // rolled back below so a later save does not steal the session.
    const before = { hasPlayed: state.hasPlayed, blocked: state.sessionBlocked };
    claimSession();
    // A rejected play() (autoplay policy, a refused stream) must not leave
    // this device claiming the session either: releaseFailedClaim restores
    // the reader state, so the next /api/now save cannot send takeover:true
    // at the device that is actually playing.
    audio.play().catch((err) => {
      if (!audio.paused) return;
      releaseFailedClaim(before);
      notify(err.message);
    });
    state.playing = true;
  } else {
    // A person pressing pause: any source swap in flight is over as far as the
    // transport is concerned, so `switching` must not stay armed (a stale flag
    // drops the next pause save and the next natural `ended`).
    state.switching = false;
    state.userPause = true;
    // A deliberate pause ends the interruption recovery too: leaving the intent
    // armed would let the hidden watchdog start the music again a few seconds
    // after the listener stopped it on purpose.
    state.resumeOnVisible = false;
    state.resumeWanted = false;
    state.resumeAttempts = 0;
    audio.pause();
    state.playing = false;
  }
  updatePlayer();
}

// ── the now-playing sheet ───────────────────────────────────────────────
function overlayHtml() {
  const t = current();
  if (!t) {
    return `<button class="modal-close" data-action="close-overlay" aria-label="Close player">${icon('close')}</button>
      ${emptyState({ art: 'wave', title: 'Nothing playing', text: 'Pick a track and it will appear here.',
        actions: '<button class="play-btn" data-page="search">Find music</button>' })}`;
  }
  const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t.durationS || 0);
  const pos = playerPosition();
  const percent = dur ? Math.min(100, (pos / dur) * 100) : 0;
  const liked = state.liked.has(t.videoId);
  // The queue as a rotation anchored on the playing track: everything after it,
  // then everything before it. The indices travel alongside so each row knows
  // which entry of `state.queue` it is (reordering needs that, not the slot).
  // The rotation is windowed to ±QUEUE_BEHIND entries for the same reason the
  // drawer is: the sheet is rebuilt whenever it is open and a long queue would
  // otherwise put every entry (and every thumbnail) on screen at once.
  const queueIdx = state.queue.map((_, i) => i);
  const upcomingIdx = [...queueIdx.slice(Math.max(0, state.index + 1)), ...queueIdx.slice(0, Math.max(0, state.index))]
    .slice(0, QUEUE_BEHIND * 2);
  const upcoming = upcomingIdx.map((i) => state.queue[i]);

  const tabs = [['lyrics', 'Lyrics'], ['queue', 'Up next'], ['details', 'About']];
  let panel;
  if (state.overlayTab === 'queue') {
    panel = `<div class="np-next">${upcoming.length
      ? upcomingIdx.map((i) => queueRow(state.queue[i], i)).join('')
      : `<div class="np-empty">${icon('queue')}<p>Nothing queued after this track.</p></div>`}</div>`;
  } else if (state.overlayTab === 'details') {
    panel = `<div class="np-details">
      <div class="detail-row"><span>Title</span><b>${esc(t.title)}</b></div>
      <div class="detail-row"><span>Edit</span><b>${t.version === 'explicit' ? 'Explicit' : t.version === 'clean' ? 'Clean (censored)' : 'Unmarked'}</b></div>
      <div class="detail-row"><span>Artist</span>
        ${t.channelId || t.channel
    ? `<button class="detail-link" data-action="artist" data-artist="${esc(t.channelId || t.channel)}">${esc(t.channel ?? '—')}${icon('arrow-right', 'xs')}</button>`
    : '<b>—</b>'}</div>
      <div class="detail-row"><span>Album</span>
        <button class="detail-link" data-action="open-album" data-id="${esc(t.videoId)}"${t.albumId ? ` data-album="${esc(t.albumId)}"` : ''}
          aria-label="Open the album for ${esc(t.title)}">${esc(t.album ?? 'Find album')}${icon('arrow-right', 'xs')}</button></div>
      <div class="detail-row"><span>Duration</span><b>${fmt(dur)}</b></div>
      <div class="detail-row"><span>Source</span><b>YouTube</b></div>
      <p class="detail-note">Your plays, skips and likes stay on this instance and shape what sonora recommends next.</p></div>`;
  } else {
    panel = lyricsHtml();
  }

  return `<button class="modal-close" data-action="close-overlay" aria-label="Close player">${icon('close')}</button>
    <div class="sheet-grip" aria-hidden="true"></div>
    <div class="modal-cover">${cover(null, 'cover', t.thumb, 'eager', true)}</div>
    <div class="modal-content">
      <div class="np-head">
        <div class="np-head-copy"><span class="eyebrow">NOW PLAYING</span>
          <div class="track-title-line"><h2>${esc(t.title)}</h2>${versionTag(t)}</div>${(t.channelId || t.channel)
            ? `<button class="byline byline-link" data-action="artist" data-artist="${esc(t.channelId || t.channel)}" aria-label="Open ${esc(t.channel)}'s artist page">${esc(t.channel)}</button>`
            : `<p class="byline">${esc(t.channel ?? '')}</p>`}</div>
        <div class="np-actions">
          <button class="icon-btn ${liked ? 'primary' : ''}" data-action="heart" data-id="${esc(t.videoId)}"
            aria-pressed="${liked}" aria-label="${liked ? 'Remove from' : 'Add to'} liked songs">${icon('heart')}</button>
          <button class="icon-btn ${state.disliked.has(t.videoId) ? 'is-disliked' : ''}" data-action="dislike"
            data-id="${esc(t.videoId)}" aria-pressed="${state.disliked.has(t.videoId)}"
            aria-label="${state.disliked.has(t.videoId) ? 'Undo "less like this"' : 'Play this less often'}"
            title="Less like this">${icon('thumb-down')}</button>
          <button class="icon-btn ${rooms.active ? 'room-on' : ''}" data-action="room" aria-label="Listen together" aria-haspopup="dialog">${icon('headphones')}</button>
          <button class="icon-btn" data-action="track-menu" data-id="${esc(t.videoId)}" aria-label="More options" aria-haspopup="menu">${icon('dots')}</button>
        </div>
      </div>
      <div class="modal-tabs" role="tablist" aria-label="Track details">
        ${tabs.map(([key, label]) => `<button role="tab" aria-selected="${state.overlayTab === key}"
          class="${state.overlayTab === key ? 'active' : ''}" data-overlay-tab="${key}">${label}${key === 'queue' && upcoming.length ? `<span class="tab-badge">${upcoming.length}</span>` : ''}</button>`).join('')}
      </div>
      <div class="np-scroll">${panel}</div>
      <div class="modal-progress"><div class="timebar"><span class="elapsed">${fmt(pos)}</span>
        <input class="range" type="range" aria-label="Track progress" data-slider="progress"
          min="0" max="${Math.max(1, Math.floor(dur))}" value="${Math.floor(pos)}"
          style="--percent:${percent}%"><span class="duration">${fmt(dur)}</span></div></div>
      <div class="modal-controls">
        <button class="ctrl ${state.shuffle ? 'on' : ''}" data-action="shuffle" aria-label="Shuffle" aria-pressed="${state.shuffle}">${icon('shuffle')}</button>
        <button class="ctrl" data-action="prev" aria-label="Previous song">${icon('prev', 'lg')}</button>
        <button class="big-play" data-action="playpause" aria-label="${state.playing ? 'Pause' : 'Play'}">${icon(state.playing ? 'pause' : 'play', 'fill lg')}</button>
        <button class="ctrl" data-action="next" aria-label="Next song">${icon('next', 'lg')}</button>
        <button class="ctrl ${state.repeat ? 'on' : ''}" data-action="repeat" aria-label="Repeat ${['off', 'all', 'one'][state.repeat]}" aria-pressed="${state.repeat > 0}">${icon('repeat')}</button></div>
    </div>`;
}

function lyricsHtml() {
  if (state.currentLyrics === undefined) return `<div class="np-loading"><span class="spinner"></span> Loading lyrics…</div>`;
  if (state.currentLyrics === null) {
    return `<div class="np-empty">${icon('lyrics')}<p>No lyrics for this track yet.</p></div>`;
  }
  return `<div class="lyric-lines"><div class="plain">${esc(state.currentLyrics)}</div></div>`;
}

let overlaySig = '';

function overlaySignature() {
  const t = current();
  return [t?.videoId, state.overlayTab, state.currentLyrics === undefined ? 'u'
    : state.currentLyrics === null ? 'n' : 'y', t ? state.queue.length : 0,
    // A reorder keeps the length, so the queue tab has to key on the order too.
    state.overlayTab === 'queue' ? state.queue.map((x) => x.videoId).join(',') : ''].join('|');
}

// Rebuilding the sheet on every timeupdate would steal focus and reset the
// lyrics scroll. Only the track/tab/lyrics change rebuilds it; everything else
// is patched in place.
function refreshOverlay({ force = false } = {}) {
  const shell = $('now-overlay');
  if (shell.hidden || shell.classList.contains('closing')) { overlaySig = ''; return; }
  // A session that expired mid-song puts the sign-in form on top of everything;
  // repainting the sheet underneath it (what this guard used to do, at the very
  // end of the function, after every write) would be the one surface able to
  // appear in front of a form the user has to fill in. The boot path closes the
  // sheet itself; this is the guard for the tick right after.
  if (!$('auth-overlay').hidden) return;
  const sig = overlaySignature();
  if (force || sig !== overlaySig) {
    const active = document.activeElement;
    const action = active?.closest?.('#now-content') ? active.dataset.action : null;
    overlaySig = sig;
    $('now-content').innerHTML = overlayHtml();
    // The queue tab needs vertical room more than it needs a large cover, so
    // the artwork shrinks there (and only there) to show more upcoming tracks.
    $('now-content').classList.toggle('tab-queue', state.overlayTab === 'queue');
    if (action) $('now-content').querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  }
  // Cheap live patches: play state, like state, progress.
  const t = current();
  $('now-content').querySelectorAll('[data-action="playpause"]').forEach((b) => {
    b.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    const use = b.querySelector('use');
    if (use) use.setAttribute('href', state.playing ? '#i-pause' : '#i-play');
  });
  if (t) {
    const liked = state.liked.has(t.videoId);
    $('now-content').querySelectorAll(`[data-action="heart"][data-id="${CSS.escape(t.videoId)}"]`).forEach((b) => {
      b.classList.toggle('primary', liked);
      b.setAttribute('aria-pressed', String(liked));
      b.setAttribute('aria-label', `${liked ? 'Remove from' : 'Add to'} liked songs`);
    });
  }
  if (!$('drawer-overlay').hidden) drawerHtml();
}

async function loadLyrics() {
  const t = current();
  if (!t) return;
  if (state.currentLyrics !== null && state.currentLyrics !== undefined) return;
  state.currentLyrics = undefined;
  refreshOverlay();
  try {
    const { text } = await api(`/api/lyrics/${t.videoId}`);
    const t2 = current();
    if (t2 && t2.videoId === t.videoId) state.currentLyrics = text ?? null;
  } catch {
    // Same staleness guard as the success path: a late failure for the
    // previous track used to mark the *new* track as having no lyrics, and
    // loadLyrics() then never asked again.
    const t2 = current();
    if (t2 && t2.videoId === t.videoId) state.currentLyrics = null;
  }
  refreshOverlay();
}

/**
 * One row of the playing queue: the play target plus a separate reorder grip.
 *
 * The grip is a *sibling* of the play button, never a child — a control nested
 * inside a control is invalid HTML and would swallow the row's own activation.
 * `.queue-mini`, `.queue-text`, `.duration`, `.current` and
 * `data-action="play-track" data-id` are kept exactly as they were so the
 * existing stylesheet and the tests that pin those hooks keep working; the
 * wrapper only adds what reordering needs (`data-queue-row`, `data-index`).
 */
function queueRow(t, index, { current = false } = {}) {
  const videoId = esc(t.videoId ?? '');
  const title = esc(t.title ?? t.videoId ?? '');
  // Dragging is the shared queue's job while a room is live: the server owns the
  // order there, so the grip is shown but disabled, with the reason in its name
  // rather than silently missing.
  const grip = rooms.active
    ? `<button class="queue-grip" type="button" data-queue-grip disabled
        aria-label="Reorder ${title} — the room owns this queue"
        title="The room owns the shared queue">${icon('lock', 'sm')}</button>`
    : `<button class="queue-grip" type="button" data-queue-grip
        aria-label="Reorder ${title}" title="Drag to reorder · Alt+↑ Alt+↓">${icon('list', 'sm')}</button>`;
  return `<div class="queue-row${current ? ' current' : ''}${queueDrag?.videoId === t.videoId ? ' dragging' : ''}"
      data-queue-row data-video="${videoId}" data-index="${index}"${current ? ' data-current="1"' : ''}>
    <button class="queue-mini${current ? ' current' : ''}" data-action="play-track" data-id="${videoId}"
      aria-label="Play ${title}">${cover(null, 'cover', t.thumb)}
      <span class="queue-text"><span class="track-title-line"><strong>${title}</strong>${versionTag(t)}</span><span>${esc(t.channel ?? '')}</span></span>
      <span class="duration">${fmt(t.durationS)}</span></button>
    ${grip}</div>`;
}

function drawerHtml() {
  const drawer = $('queue-drawer');
  const entries = state.queue.map((t, i) => ({ t, i }));
  const playing = state.index >= 0 ? state.queue[state.index] : null;
  // A window, not the whole queue: the drawer is repainted by refreshQueueViews
  // on every playback change, and a long station queue is 50-200 entries, so
  // rendering all of them rebuilt ~1,600 nodes (one <img> each) for rows nobody
  // had scrolled to. The header still states the real total.
  const upcoming = entries.slice(Math.max(0, state.index + 1), Math.max(0, state.index + 1) + QUEUE_BEHIND);
  const earlier = entries.slice(0, Math.max(0, state.index)).slice(-QUEUE_BEHIND);
  // Say so when the window is hiding rows: a drawer that silently stops after
  // twenty reads as "the queue ends here", which is a worse lie than the cost of
  // one line.
  const aheadMore = Math.max(0, state.queue.length - Math.max(0, state.index + 1) - upcoming.length);
  const behindMore = Math.max(0, Math.max(0, state.index) - earlier.length);
  const moreNote = (n, where) => (n
    ? `<p class="drawer-more field-hint">${n} more ${n === 1 ? 'track' : 'tracks'} ${where}</p>` : '');
  const count = `${state.queue.length} ${state.queue.length === 1 ? 'track' : 'tracks'}`;
  // innerHTML is a teardown, and this drawer is rebuilt on every track advance
  // while it is open: a listener reading "Up next" had the list jump back to the
  // top (they were sent back to the playing row) and the focused row's control
  // land on <body> (Tab then restarted at the top of the document) once the
  // track rolled over. Both are cheap to carry across the rebuild: the scroll
  // offset is one number, the focus target is the same key every other repaint
  // already uses (focusKey/restoreFocus, see render()).
  const scrolled = drawer.scrollTop;
  const focus = focusKey(document.activeElement);
  drawer.innerHTML = `<div class="drawer-top"><div><h2>Queue <span class="drawer-count">${count}</span></h2></div>
      <button class="icon-btn" data-action="close-drawer" aria-label="Close queue">${icon('close')}</button></div>
    ${playing ? `<div class="drawer-list">${queueRow(playing, state.index, { current: true })}</div>` : ''}
    <div class="drawer-section"><span class="eyebrow">Up next</span><div class="drawer-list">
      ${upcoming.length ? upcoming.map(({ t, i }) => queueRow(t, i)).join('')
        : `<div class="np-empty small">${icon('queue')}<p>Nothing queued. Play a playlist or a station to fill this.</p></div>`}</div>
      ${moreNote(aheadMore, 'after these')}</div>
    ${earlier.length ? `<div class="drawer-section"><span class="eyebrow">Earlier</span><div class="drawer-list">${earlier.map(({ t, i }) => queueRow(t, i)).join('')}</div>
      ${moreNote(behindMore, 'before these')}</div>` : ''}`;
  if (scrolled) drawer.scrollTop = scrolled;
  restoreFocus(focus);
  return drawer;
}

// ── queue reorder ───────────────────────────────────────────────────────
// Pointer events rather than HTML5 drag-and-drop: the drawer is re-rendered by
// `updatePlayer` on every playback change, which kills a native drag session
// mid-gesture, and native DnD does not exist on touch at all. The gesture state
// lives in one module-level object and every listener sits on `document`, so a
// re-render can replace the row under the finger without ending the drag: the
// row is looked up by video id on each move instead of being held by reference.

const QUEUE_DRAG_THRESHOLD = 6;

/** Every queue row currently on screen, in displayed order. */
function queueRowEls(el = null) {
  const scope = el?.closest?.('#now-content, #queue-drawer')
    ?? (!document.getElementById('now-overlay').hidden ? $('now-content') : $('queue-drawer'));
  return [...scope.querySelectorAll('[data-queue-row]')].filter((r) => r.getClientRects().length);
}

/** The live row for the entry being dragged, wherever it was last rendered. */
function queueDragRow() {
  if (!queueDrag) return null;
  const scope = queueDrag.surface
    && document.contains(queueDrag.surface) ? queueDrag.surface : document.getElementById('queue-drawer');
  return scope?.querySelector(`[data-queue-row][data-video="${CSS.escape(queueDrag.videoId)}"]`) ?? null;
}

/**
 * Row midpoints for the slot scan, read once and reused.
 *
 * `paintQueueDrop` used to read a rect per row on every pointermove, interleaved
 * with the class writes that clear the old indicator — the classic
 * write-then-read loop, which forces a synchronous layout per event. Pointer
 * events arrive at the digitizer rate (120-240 Hz on a phone), so a 200-row
 * queue cost ~400 rect computations per frame's worth of moves and the drop
 * landed a frame behind the finger. The midpoints are read here in one batch
 * (one layout, then every rect out of it) and thrown away when something can
 * have moved them: a scroll, a resize, or a re-render under the finger.
 */
function queueDragGeometry(refresh = false) {
  const rows = queueRowEls(queueDragRow());
  const cached = queueDrag.geometry;
  if (!refresh && cached && cached.rows.length === rows.length
    && cached.rows.every((r, i) => r === rows[i] && r.isConnected)) return cached;
  const centers = rows.map((r) => {
    const box = r.getBoundingClientRect();
    return box.top + box.height / 2;
  });
  queueDrag.geometry = { rows, centers };
  return queueDrag.geometry;
}

/** Which visual slot (0…rows.length) the pointer is over. */
function queueInsertSlot(rows, centers, clientY) {
  const dragged = queueDragRow();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === dragged) continue; // the dragged row has no height of its own
    if (clientY < centers[i]) return i;
  }
  return rows.length;
}

/**
 * Convert a slot in the *displayed* list into an index in `state.queue`.
 *
 * Both surfaces render the queue as a rotation anchored on the playing track
 * (the drawer starts at it, the sheet starts after it), so a visual position is
 * not a queue index. The only rule that keeps the result stable is: the entry
 * lands immediately after the row displayed above the slot (or immediately
 * before the first displayed row). The returned value is the index in the array
 * *after* the entry has been taken out — what `moveQueueEntry()` expects.
 */
function queueTargetIndex(rows, fromIndex, slot) {
  const n = state.queue.length;
  if (!rows.length) return fromIndex;
  // The drawer always shows the playing row first, and it always will: a row
  // "above" the current song cannot be displayed. The top slot therefore means
  // "first up next", not "before the song that is playing".
  if (slot <= 0 && rows[0]?.dataset.current === '1') slot = 1;
  const idxs = rows.map((r) => Number(r.dataset.index));
  let to;
  if (slot <= 0) {
    const first = idxs[0];
    to = first - (fromIndex < first ? 1 : 0);
  } else {
    const anchor = idxs[Math.min(slot, rows.length) - 1];
    to = anchor === fromIndex ? fromIndex : (anchor - (fromIndex < anchor ? 1 : 0)) + 1;
  }
  return Math.max(0, Math.min(n - 1, to));
}

/** Paint the drop indicator under the pointer and remember the target index. */
function paintQueueDrop(clientY) {
  const { rows, centers } = queueDragGeometry();
  const slot = queueInsertSlot(rows, centers, clientY);
  queueDrag.target = queueTargetIndex(rows, queueDrag.fromIndex, slot);
  const dragged = queueDragRow();
  const mark = slot <= 0 ? rows[0] : rows[Math.min(slot, rows.length) - 1];
  const next = !mark || mark === dragged ? null : mark;
  const at = next ? (slot <= 0 ? 'drop-before' : 'drop-after') : null;
  // Only the two rows that changed are touched — the one that held the
  // indicator and the one that holds it now — instead of clearing a class on
  // every row in the list on every move.
  if (next === queueDrag.mark && at === queueDrag.markAt) return;
  queueDrag.mark?.classList.remove('drop-before', 'drop-after');
  if (next) next.classList.add(at);
  queueDrag.mark = next;
  queueDrag.markAt = at;
}

function clearQueueDrop() {
  for (const r of document.querySelectorAll('[data-queue-row]')) {
    r.classList.remove('dragging', 'drop-before', 'drop-after');
    r.style.transform = '';
  }
}

function beginQueueDrag(e, row) {
  // Untrusted or already-released pointer ids make setPointerCapture throw; the
  // document-level listeners are the real safety net, so a miss here is fine.
  try { row.setPointerCapture?.(e.pointerId); } catch {}
  queueDrag.active = true;
  queueDrag.startY = e.clientY;
  queueDrag.startX = e.clientX;
  queueDrag.frameY = e.clientY;
  // Cache where every row is *now*, at the cheapest moment there is: the hand
  // has just gone down and nothing has moved yet. From here a move costs one
  // transform write, not a layout.
  queueDragGeometry(true);
}

/** The coalesced frame of a drag: one transform write, then one cached scan. */
function flushQueueDrag() {
  queueDragFrame = 0;
  const drag = queueDrag;
  if (!drag) return;
  const row = queueDragRow();
  if (row) row.style.transform = `translateY(${Math.round(drag.frameY - drag.startY)}px)`;
  paintQueueDrop(drag.frameY);
}

document.addEventListener('pointerdown', (e) => {
  if (e.button) return;
  const grip = e.target.closest?.('[data-queue-grip]');
  const row = e.target.closest?.('[data-queue-row]');
  if (!row || rooms.active || (grip && grip.disabled)) return;
  // A finger on the row itself scrolls the list; only the grip is a handle for
  // touch. A mouse or pen can start from anywhere in the row.
  if (!grip && e.pointerType === 'touch') return;
  queueDrag = {
    videoId: row.dataset.video,
    pointerId: e.pointerId,
    fromIndex: Number(row.dataset.index),
    target: Number(row.dataset.index),
    startX: e.clientX,
    startY: e.clientY,
    frameY: e.clientY,
    active: Boolean(grip),
    moved: false,
    surface: row.closest('#now-content, #queue-drawer'),
    geometry: null,
    mark: null,
    markAt: null,
  };
  if (queueDrag.active) beginQueueDrag(e, row);
});

document.addEventListener('pointermove', (e) => {
  if (!queueDrag || e.pointerId !== queueDrag.pointerId) return;
  const dy = e.clientY - queueDrag.startY;
  const dx = e.clientX - queueDrag.startX;
  if (!queueDrag.active) {
    if (Math.abs(dy) < QUEUE_DRAG_THRESHOLD && Math.abs(dx) < QUEUE_DRAG_THRESHOLD) return;
    // A row press only becomes a drag for a clearly vertical gesture, so a
    // horizontal swipe and a plain tap still do what they always did.
    if (Math.abs(dy) <= Math.abs(dx)) { queueDrag = null; return; }
    queueDrag.active = true;
  }
  if (e.cancelable) e.preventDefault();
  queueDrag.moved = true;
  // The "being dragged" class is two writes on one element: done here so a
  // re-render under the finger (queueRow reads queueDrag) still marks the row,
  // and so the gesture is observable before the next frame. Everything that
  // reads layout waits for the frame below.
  queueDragRow()?.classList.add('dragging');
  queueDrag.frameY = e.clientY;
  // There is no point doing this work more than once per frame: the pointer can
  // fire ten times between two paints. Coalescing also means a dropped frame
  // costs one skipped update, not a queued backlog of stale ones.
  if (!queueDragFrame) queueDragFrame = requestAnimationFrame(flushQueueDrag);
}, { passive: false });

function finishQueueDrag(e, cancelled = false) {
  if (!queueDrag || e.pointerId !== queueDrag.pointerId) return;
  // A pointerup almost always arrives in the same frame as the last
  // pointermove, so the coalesced paint has not run yet and `target` still
  // points at the previous slot. Apply the pending frame synchronously: where
  // the finger let go is exactly what has to be committed, whatever the frame
  // rate was doing.
  if (queueDragFrame) { cancelAnimationFrame(queueDragFrame); queueDragFrame = 0; }
  flushQueueDrag();
  const drag = queueDrag;
  queueDrag = null;
  clearQueueDrop();
  if (!drag.active || !drag.moved || cancelled) return;
  // A drag that ends over the row it started on must not also start playback.
  queueSuppressClick = Date.now();
  moveQueueEntry(drag.videoId, drag.target);
}

document.addEventListener('pointerup', (e) => finishQueueDrag(e));
document.addEventListener('pointercancel', (e) => finishQueueDrag(e, true));

// The cached midpoints only hold while the list stays put. Both surfaces can
// scroll under the finger (and the sheet's list is short enough to scroll on a
// phone), so a scroll throws them away and the next frame re-reads them once.
document.addEventListener('scroll', () => { if (queueDrag) queueDrag.geometry = null; }, { capture: true, passive: true });
window.addEventListener('resize', () => { if (queueDrag) queueDrag.geometry = null; }, { passive: true });

// The click that a completed drag emits (pointerup → click on the row) is the
// one thing that would turn a reorder into "play this track". Capture phase, so
// the app's own click handler never sees it.
document.addEventListener('click', (e) => {
  if (!queueSuppressClick) return;
  if (Date.now() - queueSuppressClick > 600) { queueSuppressClick = 0; return; }
  if (!e.target.closest?.('[data-queue-row]')) return;
  queueSuppressClick = 0;
  e.stopPropagation();
  e.preventDefault();
}, true);

/**
 * One step up or down in the *displayed* list (Alt+Arrow), reusing the drag's
 * slot maths so keyboard and pointer land on the same place.
 */
function reorderQueueRow(row, delta) {
  const rows = queueRowEls(row);
  const pos = rows.indexOf(row);
  if (pos < 0) return;
  const from = Number(row.dataset.index);
  const slot = pos + (delta > 0 ? 2 : -1);
  const to = queueTargetIndex(rows, from, Math.max(0, Math.min(rows.length, slot)));
  if (to === from) {
    notify(delta > 0 ? 'Already at the end of the queue' : 'Already at the top of the queue', 'info');
    return;
  }
  const grip = row.contains(document.activeElement) && document.activeElement.matches('[data-queue-grip]');
  const surface = row.closest('#now-content, #queue-drawer');
  moveQueueEntry(row.dataset.video, to);
  // Focus follows the row it was on: a re-render must not drop the keyboard
  // user back at the top of the document.
  //
  // The repaint can itself land in a rAF (the pointer-drag path batches it), so
  // restoring on the next frame and assuming the new DOM already existed was a
  // race: it silently lost the user's place. Retry a couple of frames instead,
  // and fall back to the document when the surface was replaced wholesale.
  const selector = `[data-queue-row][data-video="${CSS.escape(row.dataset.video)}"]`;
  let focusAttempts = 0;
  const restoreFocus = () => {
    const host = surface?.isConnected ? surface : document;
    const moved = host.querySelector(selector) ?? document.querySelector(selector);
    if (!moved) {
      // ~200 ms of frames, only while the row genuinely is not there yet. A
      // fixed number of frames was not enough on a loaded machine (the repaint
      // competes with other suites), and the failure mode is silent.
      focusAttempts += 1;
      if (focusAttempts <= 12) requestAnimationFrame(restoreFocus);
      return;
    }
    (grip ? moved.querySelector('[data-queue-grip]') : moved.querySelector('[data-action="play-track"]'))
      ?.focus({ preventScroll: true });
  };
  // The common case repaints synchronously, so try before yielding a frame.
  restoreFocus();
  notify(`Moved to position ${to + 1} of ${state.queue.length}`, 'info');
}

/**
 * Move one queue entry to a new position without changing what is playing.
 *
 * `toIndex` is the index in the array *after* the entry has been taken out, so
 * moving a track down by one is `from + 1`. `state.index` is recomputed by
 * locating the playing entry rather than by arithmetic: a move across the
 * playhead shifts every later index by one, and "next" has to keep meaning the
 * next song, not whichever song was next before the reorder.
 */
function moveQueueEntry(fromVideoId, toIndex) {
  const n = state.queue.length;
  const from = state.queue.findIndex((t) => t.videoId === fromVideoId);
  if (from < 0 || n < 2) return false;
  const playing = state.queue[state.index] ?? null;
  const wanted = Math.floor(Number(toIndex));
  const to = Math.max(0, Math.min(n - 1, Number.isFinite(wanted) ? wanted : from));
  if (to === from) return false;
  const next = state.queue.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  state.queue = next;
  // Order is part of the plan: an armed plan still describes the old order, so
  // a stream started after this drag would play the queue as it used to be.
  invalidateQueuePlan();
  // The song that is playing is the same song; only where it sits changes.
  if (playing) state.index = Math.max(0, next.findIndex((t) => t.videoId === playing.videoId));
  refreshQueueViews({ forceOverlay: true, rowsChanged: true });
  // Reordering is a queue edit, not a play intent: it is saved, but debounced so
  // a held-down Alt+Arrow cannot spam the session endpoint.
  clearTimeout(queueSaveTimer);
  queueSaveTimer = setTimeout(() => { saveSession({ force: true }); }, 250);
  return true;
}

/** Repaint every surface that lists the queue. */
function refreshQueueViews({ forceOverlay = false, rowsChanged = false, trimmed = 0 } = {}) {
  $('rail-content').innerHTML = rail();
  updatePlayer(); // player bar (+ the sheet, when it is open)
  if (forceOverlay && !$('now-overlay').hidden) refreshOverlay({ force: true });
  if (!$('drawer-overlay').hidden) drawerHtml();
  // The station page lists the *live* queue, so it follows the queue. A change
  // to that list's composition (an append, a reorder, a removal) rebuilds the
  // page — the hero, the counts and the rows all move. A track advance does not:
  // it only moves the "now playing" row marker. A trim behind the playhead does
  // move rows (the dropped ones are gone from the list), so the list alone is
  // repainted in place — the page keeps its scroll position and its hero.
  if (state.page === 'station') {
    if (rowsChanged) { void render(); return; }
    if (trimmed > 0) { patchStationRows(trimmed); return; }
  }
  patchNowPlayingRows();
}

/**
 * Repaint the station page's row list from the live queue.
 *
 * Only the list (and the count in its section head) is rebuilt: the rows are a
 * window on the queue, so trimming behind the playhead makes the rendered list
 * stale long before anything else on the page changes.
 *
 * `dropped` is how many entries fell off the front. In the common case that is
 * the only change, and the rows that remain are literally the same elements —
 * so the leading rows are removed and the numbering shifted instead of
 * re-parsing the whole list (which would re-create a thumbnail per row on every
 * track advance). Anything else — an append, a reorder — falls back to a rebuild.
 */
function patchStationRows(dropped = 0) {
  const root = $('page-root');
  const list = root?.querySelector('.track-list');
  const live = stationPlaying() ? state.queue : null;
  if (!list || !live) return;
  const rendered = [...list.querySelectorAll('.track-row')];
  const intact = dropped > 0 && rendered.length === live.length + dropped
    && rendered[dropped]?.dataset.track === live[0]?.videoId;
  if (intact) {
    for (let i = 0; i < dropped; i++) rendered[i].remove();
    [...list.querySelectorAll('.track-row')].forEach((row, i) => {
      const n = row.querySelector('.track-index span');
      if (n) n.textContent = String(i + 1);
    });
  } else {
    list.outerHTML = trackRows(live, true, 'station');
  }
  const note = root.querySelector('.shelf-head-copy p');
  if (note) note.textContent = stationQueueNote(live.length);
  patchNowPlayingRows();
}

/**
 * Move the "now playing" marker without rebuilding the page.
 *
 * Every list surface — station, playlist, album, liked songs, search results —
 * marks the row that is playing with `.active` and aria-current, and that marker
 * is the only thing about them that changes when one track ends and the next
 * begins. Rebuilding them for it meant re-assigning `#page-root.innerHTML` (and
 * `#rail-content`, and `#player`) 150-400 nodes at a time, with 10-30 images to
 * re-decode, plus a reset of `#main-scroll` to the top — the reading position a
 * listener had scrolled to, thrown away every few minutes.
 */
function patchNowPlayingRows() {
  const root = $('page-root');
  if (!root) return;
  const act = current();
  const videoId = state.playing && act ? act.videoId : null;
  for (const row of root.querySelectorAll('.track-row[data-track]')) {
    const isNow = Boolean(videoId) && row.dataset.track === videoId;
    if (row.classList.contains('active') === isNow) continue;
    row.classList.toggle('active', isNow);
    if (isNow) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
}

// ── overlay mechanics ───────────────────────────────────────────────────
const overlayTriggers = new WeakMap();
// The overlay that currently owns focus for the focusin guard below. Only
// overlays opened through openOverlay claim it.
let modalOwner = null;
let confirmAction = null;
let confirmResolve = null;

function focusables(el) {
  return [...el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((n) => n.getClientRects().length > 0);
}

function openOverlay(id, trigger = document.activeElement, focusSelector = null) {
  const el = $(id);
  if (!el) return;
  overlayTriggers.set(el, trigger);
  modalOwner = el;
  el.classList.remove('closing');
  el.hidden = false;
  setTimeout(() => {
    if (el.hidden || el.classList.contains('closing')) return;
    const root = el.querySelector('[role="dialog"]') ?? el;
    // 'self' parks focus on the panel, which is right for the now-playing
    // sheet: nothing gets a ring painted on it the instant it opens, and Tab
    // still walks into the controls because the trap starts from the panel.
    if (focusSelector === 'self') {
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      root.focus({ preventScroll: true });
      return;
    }
    const preferred = focusSelector ? root.querySelector(focusSelector) : null;
    (preferred ?? focusables(root)[0])?.focus({ preventScroll: true });
  }, 70);
}

function closeOverlay(id) {
  const el = $(id);
  if (!el || el.hidden || el.classList.contains('closing')) return;
  if (modalOwner === el) modalOwner = null;
  el.classList.add('closing');
  setTimeout(() => {
    if (!el.classList.contains('closing')) return; // reopened during the exit
    el.hidden = true;
    el.classList.remove('closing');
  }, 180);
  const trigger = overlayTriggers.get(el);
  overlayTriggers.delete(el);
  if (trigger && document.contains(trigger)) {
    if (!trigger.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(trigger.tagName)) {
      trigger.setAttribute('tabindex', '-1');
    }
    trigger.focus?.({ preventScroll: true });
  }
}

function topOverlay() {
  const open = [...document.querySelectorAll('.overlay:not([hidden]):not(.closing),.drawer-backdrop:not([hidden]):not(.closing)')];
  return open.at(-1) ?? null;
}

// Tab is trapped in the keydown handler; this catches focus arriving from
// anywhere else (programmatic focus, a screen reader, a stray click on the
// backdrop's siblings). An aria-modal dialog owns focus while it is open.
document.addEventListener('focusin', (e) => {
  const top = modalOwner;
  if (!top || top.hidden || top.classList.contains('closing')) return;
  const dialog = top.querySelector('[role="dialog"]') ?? top;
  if (dialog.contains(e.target)) return;
  const next = focusables(dialog)[0];
  if (next) next.focus({ preventScroll: true });
  else if (!dialog.hasAttribute('tabindex')) {
    dialog.setAttribute('tabindex', '-1');
    dialog.focus({ preventScroll: true });
  } else {
    dialog.focus({ preventScroll: true });
  }
});

function trapTab(e, root) {
  const list = focusables(root);
  if (!list.length) return;
  const first = list[0];
  const last = list.at(-1);
  const active = document.activeElement;
  if (!root.contains(active)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

function openNow(tab = null, trigger = null) {
  if (tab) state.overlayTab = tab;
  if (state.overlayTab === 'lyrics' || state.overlayTab === 'details') loadLyrics();
  $('now-content').classList.toggle('tab-queue', state.overlayTab === 'queue');
  openOverlay('now-overlay', trigger ?? document.activeElement, 'self');
  refreshOverlay({ force: true });
}

function closeNow() { closeOverlay('now-overlay'); }

function openDrawer(trigger = document.activeElement) {
  drawerHtml();
  openOverlay('drawer-overlay', trigger);
}

function closeFormSheet() {
  confirmAction = null;
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  closeOverlay('form-overlay');
}

function openFormSheet(html, { label = 'Dialog', trigger = null, focus = null } = {}) {
  const content = $('form-content');
  content.setAttribute('aria-label', label);
  content.innerHTML = html;
  openOverlay('form-overlay', trigger ?? menuTrigger ?? document.activeElement, focus);
}

// ── settings ────────────────────────────────────────────────────────────
// One in-app sheet for every client preference (never a native dialog). The
// rows come from `PREF_META` / `PREF_DEFAULTS`, so adding a preference is one
// line in each table — and each row is a real `<label>` wrapping a real
// checkbox, because that is what gives keyboard, screen-reader and touch
// behaviour for free.
function settingsHtml() {
  // desktopAlerts is hidden on engines without Notification (iOS Safari in a
  // PWA): the toggle would store a pref that can never alert, and the settings
  // sheet is the one surface that must not overpromise. notifications.js
  // refuses to keep the pref on those engines too — belt and braces.
  const rows = prefKeys()
    .filter((key) => key !== 'desktopAlerts' || typeof Notification === 'function')
    .map((key) => {
    const meta = PREF_META[key] ?? {};
    const label = meta.label ?? key;
    const hint = meta.hint ?? '';
    return `<label class="pref-row" for="pref-${esc(key)}">
      <input type="checkbox" id="pref-${esc(key)}" data-pref="${esc(key)}"${pref(key) ? ' checked' : ''}>
      <span class="pref-copy"><strong>${esc(label)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;
  }).join('');
  return `<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <div class="form-body"><span class="eyebrow">Settings</span><h2>How sonora behaves</h2>
      <p class="form-desc">Saved on this device. Nothing here leaves it.</p>
      <div class="pref-list">${rows}</div>
      <div class="form-actions"><button class="play-btn" data-action="close-form">Done</button></div></div>`;
}

function openSettings() {
  openFormSheet(settingsHtml(), { label: 'Settings', focus: '.pref-row input' });
}

/** Re-apply stored values to an open sheet — a toggle stays open, and a value
 *  changed elsewhere (another tab, a future feature) is reflected without a
 *  rebuild that would steal focus from the control just used. */
function syncPrefInputs() {
  for (const input of document.querySelectorAll('#form-content [data-pref]')) {
    input.checked = Boolean(pref(input.dataset.pref));
  }
}

document.addEventListener('change', (e) => {
  const key = e.target?.dataset?.pref;
  if (!key) return;
  setPref(key, Boolean(e.target.checked));
  syncPrefInputs();
});

document.addEventListener('sonora:pref-change', (e) => {
  // notifications.js writes its own preference straight to localStorage (the
  // "Enable alerts" tap in the bell panel is the browser's permission
  // gesture, which belongs to that module) and announces the write with this
  // event. Mirror the change into state.prefs, or the settings sheet renders
  // a stale checkbox after the user just enabled it — without re-writing
  // localStorage (the module already did) or re-dispatching (that would loop
  // back into notifications.js).
  const key = e.detail?.key;
  if (!key) return;
  state.prefs = { ...(state.prefs ?? {}), [key]: e.detail?.value };
  // A sheet that is open re-applies stored values instead of being rebuilt.
  syncPrefInputs();
});

function confirmSheet({ title, text, confirmLabel = 'Delete', danger = false, action }) {
  confirmAction = action;
  openFormSheet(`<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <div class="form-body"><span class="eyebrow">${danger ? 'Please confirm' : 'One moment'}</span>
      <h2>${esc(title)}</h2><p class="form-desc">${esc(text)}</p>
      <div class="form-actions"><button class="secondary-btn" data-action="close-form">Cancel</button>
        <button class="play-btn ${danger ? 'danger' : ''}" data-action="confirm-form">${esc(confirmLabel)}</button></div></div>`,
  { label: title, focus: danger ? '[data-action="close-form"]' : '[data-action="confirm-form"]' });
}

/** Promise-based confirmation for imperative flows (admin actions). */
function ask(options) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    confirmResolve = finish;
    confirmSheet({ ...options, action: async () => { finish(true); } });
  });
}

// Swipe-down dismisses the now-playing sheet on touch devices. The gesture only
// starts at the top of the sheet so the lyrics list keeps scrolling normally.
let sheetDrag = null;
function bindSheetSwipe() {
  const el = $('now-content');
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || $('now-overlay').hidden) return;
    const scroller = e.target.closest('.np-scroll');
    if (scroller && scroller.scrollTop > 0) return;
    sheetDrag = { y: e.touches[0].clientY, dy: 0 };
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!sheetDrag) return;
    sheetDrag.dy = Math.max(0, e.touches[0].clientY - sheetDrag.y);
    if (sheetDrag.dy > 6) {
      el.classList.add('dragging');
      el.style.transform = `translateY(${Math.round(sheetDrag.dy * 0.92)}px)`;
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (!sheetDrag) return;
    const dy = sheetDrag.dy;
    sheetDrag = null;
    el.classList.remove('dragging');
    el.style.transform = '';
    if (dy > 110) closeNow();
  });
}

// ── context menu ────────────────────────────────────────────────────────
let menuTrigger = null;

function contextMenu(e, items) {
  const el = $('context-menu');
  menuTrigger = document.activeElement;
  el.classList.remove('flip-x', 'flip-y');
  el.innerHTML = items.map((i) =>
    `<button role="menuitem" ${i.dataAction
      ? `data-action="${esc(i.dataAction)}"`
      : `data-menu-action="${esc(i.action)}"`} data-id="${esc(i.id ?? '')}" data-coll="${esc(i.coll ?? '')}">${icon(i.icon)}${esc(i.text)}</button>`).join('');
  const rect = e?.currentTarget?.getBoundingClientRect?.() ?? e?.target?.getBoundingClientRect?.();
  let x = Number.isFinite(e?.clientX) && e.clientX > 0 ? e.clientX : (rect?.left ?? 8);
  let y = Number.isFinite(e?.clientY) && e.clientY > 0 ? e.clientY : ((rect?.bottom ?? 8) + 6);
  el.hidden = false;
  const w = el.offsetWidth || 200;
  const h = el.offsetHeight || 200;
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  el.querySelector('button')?.focus({ preventScroll: true });
}

// The menu is announced as `role="menu"`, so it has to behave like one: arrow
// keys move between items (wrapping), Home/End jump, and Tab still leaves the
// menu (that is the ARIA APG pattern; Escape is handled globally).
$('context-menu').addEventListener('keydown', (e) => {
  const menu = $('context-menu');
  if (menu.hidden) return;
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  let next = null;
  if (e.key === 'ArrowDown') next = items[(at + 1 + items.length) % items.length];
  else if (e.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
  else if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items.at(-1);
  if (!next) return;
  e.preventDefault();
  e.stopPropagation();
  next.focus({ preventScroll: true });
});

// The account menu is ONE popover shared by two triggers: the topbar button and
// the sidebar footer. It used to be pinned to a hardcoded `top:54px; right:12px`
// slot, so from the sidebar it opened in the opposite corner and on desktop it
// landed out in the right rail instead of under the button. Anchor it to
// whichever trigger opened it: below the trigger, right edges aligned (left
// edges for a sidebar trigger, so it never runs off-screen), flipped above when
// there is no room below, and clamped to the viewport in both axes.
function positionProfileMenu(trigger) {
  const menu = $('profile-menu');
  menu.hidden = false;
  const rect = trigger?.getBoundingClientRect?.();
  const w = menu.offsetWidth || 240;
  const h = menu.offsetHeight || 240;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 8;
  let left;
  let top;
  if (!rect || (!rect.width && !rect.height)) {
    // No geometry to work from (detached trigger): keep the documented slot.
    left = vw - w - 12;
    top = 54 + gap;
  } else {
    // A trigger in the left half (the sidebar footer) grows rightwards;
    // everything else hangs leftwards off its right edge.
    left = rect.right <= vw / 2 ? rect.left : rect.right - w;
    top = rect.bottom + gap;
    if (top + h > vh - gap) {
      const above = rect.top - h - gap;
      top = above >= gap ? above : vh - h - gap;
    }
  }
  menu.style.left = `${Math.round(Math.max(gap, Math.min(left, vw - w - gap)))}px`;
  menu.style.top = `${Math.round(Math.max(gap, Math.min(top, vh - h - gap)))}px`;
  // Inline left wins only if the stylesheet's fallback `right` is cleared.
  menu.style.right = 'auto';
}

// The topbar is sticky and the page scrolls under it, so an open menu has to
// follow its button instead of drifting away from it.
function reanchorProfileMenu() {
  const menu = $('profile-menu');
  if (!menu || menu.hidden || !menuTrigger) return;
  positionProfileMenu(menuTrigger);
}
window.addEventListener('resize', reanchorProfileMenu);
document.addEventListener('scroll', reanchorProfileMenu, { passive: true, capture: true });

function closeMenus({ restoreFocus = true } = {}) {
  const menu = $('context-menu');
  const profile = $('profile-menu');
  const wasOpen = !menu.hidden || !profile.hidden;
  const hadFocus = menu.contains(document.activeElement) || profile.contains(document.activeElement);
  menu.hidden = true;
  profile.hidden = true;
  for (const btn of document.querySelectorAll('[data-action="profile"]')) {
    btn.setAttribute('aria-expanded', 'false');
  }
  if (restoreFocus && wasOpen && hadFocus && menuTrigger && document.contains(menuTrigger)) {
    menuTrigger.focus?.({ preventScroll: true });
  }
  // The old guard read `if (!menu.hidden)` — dead, since menu.hidden was just
  // set true, so a stale trigger survived every close and a later, unrelated
  // sheet could restore focus to a row that no longer owns it. Drop the
  // trigger only when a menu was actually open and nobody consumed it: the
  // focus restore above deliberately passes the trigger on (that is how a
  // row that opened a context menu gets its focus back), so an Escape close
  // that returned focus still has an owner, and a menu-item click that
  // immediately opens a sheet has not reached this line yet.
  if (wasOpen && !(restoreFocus && hadFocus)) menuTrigger = null;
}

// ── account & security ──────────────────────────────────────────────────
// Devices and passkeys are the two things a person needs to see after the fact:
// what is signed in as me, and how do I get in without typing. Everything here
// reads /api/auth/security fresh, because it can change from another device.

async function loadSecurity() {
  state.security.loading = true;
  state.security.error = null;
  if (state.page === 'security') render();
  try {
    state.security.data = await api('/api/auth/security');
  } catch (err) {
    state.security.error = err.message;
  } finally {
    state.security.loading = false;
  }
  if (state.page === 'security') render();
}

function securityPage() {
  const d = state.security.data;
  const head = `<div class="page-head security-hero"><div>
      <span class="page-overline">Your account</span>
      <h1 class="page-title">Account &amp; security<span class="accent">.</span></h1>
      <p class="security-lede">Who can get in, which devices stay signed in, and how to lock them out.</p>
    </div><div class="page-head-actions"></div></div>`;

  if (!d) {
    if (state.security.error) {
      return `<div class="security-page">${head}<div class="admin-error">${esc(state.security.error)}
        <button class="text-link" data-action="security-refresh">Retry</button></div></div>`;
    }
    return `<div class="security-page">${head}<div class="security-grid">
      <div class="sec-card"><div class="sec-card-head"><div><h2>Passkeys</h2></div></div>
        <div class="sec-card-body">${skRows(2)}</div></div>
      <div class="sec-card"><div class="sec-card-head"><div><h2>Saved devices</h2></div></div>
        <div class="sec-card-body">${skRows(2)}</div></div>
    </div></div>`;
  }

  const caps = d.capabilities ?? { supported: false, reason: 'Passkeys are unavailable.' };
  const session = d.session ?? { accessMinutes: 720, refreshDays: 30 };
  const accessLabel = session.accessMinutes >= 60
    ? `${Math.round(session.accessMinutes / 60)} hours` : `${session.accessMinutes} minutes`;

  return `<div class="security-page">${head}
    <div class="security-session">
      <span class="sec-pill"><svg class="ico" viewBox="0 0 24 24"><use href="#i-shield"/></svg> Signed in as ${esc(d.user?.name ?? state.user?.name ?? 'you')}</span>
      <span class="sec-pill ${d.remembered ? 'ok' : ''}"><svg class="ico" viewBox="0 0 24 24"><use href="#i-clock"/></svg> ${d.remembered
        ? `Remembered for ${session.refreshDays} days` : `Session only — signs out when you close the browser`}</span>
      <span class="sec-pill"><svg class="ico" viewBox="0 0 24 24"><use href="#i-device"/></svg> Access renews every ${accessLabel}</span>
    </div>
    <div class="security-grid">
      ${securityPasskeys(d, caps)}
      ${securityDevices(d)}
    </div>
    ${securityDanger(d)}</div>`;
}

function securityPasskeys(d, caps) {
  const list = d.passkeys ?? [];
  const rows = list.length ? list.map((p) => `
    <div class="sec-row">
      <span class="sec-ico"><svg class="ico" viewBox="0 0 24 24"><use href="#i-key"/></svg></span>
      <div>
        <div class="sec-name">${esc(p.name || 'Passkey')}</div>
        <div class="sec-tags"><span class="sec-badge ${p.backedUp ? 'saved' : 'this'}">${p.backedUp ? 'Synced' : 'Device-bound'}</span></div>
        <span class="sec-meta">Added ${esc(fmtDate(p.createdAt))} · ${p.lastUsedAt
          ? `last used ${esc(fmtAgo(p.lastUsedAt))}` : 'never used yet'}</span>
      </div>
      <div class="sec-actions">
        <button class="icon-btn" data-action="passkey-rename" data-id="${p.id}" aria-label="Rename passkey" title="Rename">${icon('edit', 'sm')}</button>
        <button class="icon-btn" data-action="passkey-remove" data-id="${p.id}" aria-label="Remove passkey" title="Remove">${icon('trash', 'sm')}</button>
      </div>
    </div>`).join('')
    : `<div class="sec-empty"><strong>No passkeys yet</strong>
        Add one to sign in with your face, fingerprint or a security key instead of typing a passphrase.</div>`;

  const add = caps.supported
    ? `<button class="secondary-btn sec-add" data-action="passkey-add" ${state.security.busy === 'add' ? 'disabled' : ''}>
        ${state.security.busy === 'add' ? '<span class="spinner"></span>Waiting for your device…' : `${icon('plus', 'sm')} Add a passkey`}</button>`
    : `<p class="auth-hint">${esc(caps.reason ?? 'Passkeys are unavailable on this address.')}</p>`;

  return `<section class="sec-card" aria-labelledby="sec-passkeys-title">
    <div class="sec-card-head"><div>
      <h2 id="sec-passkeys-title">Passkeys</h2>
      <p>A passkey replaces the passphrase with a key held on your device. It never leaves the device and cannot be phished.</p>
    </div></div>
    <div class="sec-card-body">${rows}${add}</div>
  </section>`;
}

function securityDevices(d) {
  const list = d.devices ?? [];
  const rows = list.length ? list.map((dev) => `
    <div class="sec-row ${dev.current ? 'is-current' : ''}">
      <span class="sec-ico"><svg class="ico" viewBox="0 0 24 24"><use href="#i-device"/></svg></span>
      <div>
        <div class="sec-name">${esc(dev.name || 'Unnamed device')}</div>
        <div class="sec-tags">
          ${dev.current ? '<span class="sec-badge this">This device</span>' : ''}
          <span class="sec-badge ${dev.remembered ? 'saved' : 'risk'}">${dev.remembered ? 'Remembered' : 'Session only'}</span>
        </div>
        <span class="sec-meta">${dev.platform ? `${esc(dev.platform)} · ` : ''}last active ${esc(fmtAgo(dev.lastSeenAt))}
          · signed in ${esc(fmtDate(dev.lastLoginAt ?? dev.createdAt))}</span>
      </div>
      <div class="sec-actions">
        ${dev.remembered ? `<button class="icon-btn" data-action="device-forget" data-id="${esc(dev.id)}" aria-label="Stop remembering this device" title="Stop remembering">${icon('key', 'sm')}</button>` : ''}
        <button class="icon-btn" data-action="device-rename" data-id="${esc(dev.id)}" aria-label="Rename device" title="Rename">${icon('edit', 'sm')}</button>
        <button class="icon-btn" data-action="device-revoke" data-id="${esc(dev.id)}" aria-label="Sign out this device" title="Sign out this device">${icon('close', 'sm')}</button>
      </div>
    </div>`).join('')
    : `<div class="sec-empty"><strong>No devices</strong>Nothing is signed in right now.</div>`;

  return `<section class="sec-card" aria-labelledby="sec-devices-title">
    <div class="sec-card-head"><div>
      <h2 id="sec-devices-title">Saved devices</h2>
      <p>Every browser with a live session. A remembered device can renew its own access without asking again.</p>
    </div>
      <button class="icon-btn" data-action="security-refresh" aria-label="Refresh device list" title="Refresh">${icon('repeat', 'sm')}</button>
    </div>
    <div class="sec-card-body">${rows}
      <button class="secondary-btn sec-add" data-action="revoke-others" ${list.length < 2 ? 'disabled' : ''}>
        ${icon('shield', 'sm')} Sign out every other device</button>
    </div>
  </section>`;
}

function securityDanger(d) {
  return `<section class="sec-card sec-danger" aria-labelledby="sec-danger-title">
    <div class="sec-card-head"><div>
      <h2 id="sec-danger-title">Lock everything down</h2>
      <p>Signing out everywhere also forgets saved devices, so nothing can renew itself behind your back.</p>
    </div></div>
    <div class="sec-danger-list">
      <div class="sec-danger-item"><div>
        <strong>Sign out this device</strong>
        <span>Ends this session only. The other devices stay signed in, and your saved place in the song is untouched.</span>
      </div><button class="secondary-btn" data-action="signout-here">Sign out here</button></div>
      <div class="sec-danger-item"><div>
        <strong>Sign out everywhere</strong>
        <span>Ends every session on every device, including this one. You will need your passphrase or a passkey to get back in.</span>
      </div><button class="play-btn danger" data-action="signout-all">Sign out everywhere</button></div>
    </div>
  </section>`;
}

// ── WebAuthn wire format ────────────────────────────────────────────────
// The server speaks base64url JSON (WebAuthn's JSON serialisation); the browser
// speaks ArrayBuffers. These two directions are the whole translation layer.

function b64urlToBuffer(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const passkeySupported = () => Boolean(globalThis.PublicKeyCredential) && Boolean(navigator.credentials?.create);

function toCreationOptions(options) {
  return {
    ...options,
    challenge: b64urlToBuffer(options.challenge),
    user: { ...options.user, id: b64urlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ ...c, id: b64urlToBuffer(c.id) })),
  };
}

function toRequestOptions(options) {
  return {
    ...options,
    challenge: b64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c) => ({ ...c, id: b64urlToBuffer(c.id) })),
  };
}

function serializeCredential(cred) {
  const r = cred.response;
  const base = {
    id: cred.id,
    rawId: bufferToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
  if (typeof r.attestationObject !== 'undefined') {
    return {
      ...base,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: bufferToB64url(r.clientDataJSON),
        attestationObject: bufferToB64url(r.attestationObject),
        transports: r.getTransports?.() ?? [],
      },
    };
  }
  return {
    ...base,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bufferToB64url(r.clientDataJSON),
      authenticatorData: bufferToB64url(r.authenticatorData),
      signature: bufferToB64url(r.signature),
      userHandle: r.userHandle ? bufferToB64url(r.userHandle) : undefined,
    },
  };
}

const passkeyError = (err) => {
  if (err?.name === 'NotAllowedError') return 'Passkey prompt dismissed or timed out.';
  if (err?.name === 'InvalidStateError') return 'That passkey is already registered on this account.';
  if (err?.name === 'SecurityError') return 'This address is not allowed to use passkeys. Use localhost or your HTTPS domain.';
  return err?.message || 'The passkey did not work. Try again.';
};

async function addPasskey() {
  if (state.security.busy) return;
  state.security.busy = 'add';
  render();
  try {
    if (!passkeySupported()) throw new Error('This browser cannot create a passkey.');
    const { challengeId, options } = await api('/api/auth/passkey/register/options', { method: 'POST' });
    const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) });
    if (!cred) throw new Error('No passkey was created.');
    const { passkey } = await api('/api/auth/passkey/register/verify', {
      method: 'POST',
      body: { challengeId, response: serializeCredential(cred), name: suggestedPasskeyName() },
    });
    notify(`${passkey?.name ?? 'Passkey'} added`);
    await loadSecurity();
  } catch (err) {
    notify(passkeyError(err), 'error');
  } finally {
    state.security.busy = null;
    if (state.page === 'security') render();
  }
}

function suggestedPasskeyName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/iPhone/i.test(deviceName)) return 'iPhone passkey';
  if (/iPad/i.test(deviceName)) return 'iPad passkey';
  if (/Android/i.test(deviceName)) return 'Android passkey';
  if (/Mac/i.test(platform)) return 'Mac passkey';
  if (/Win/i.test(platform)) return 'Windows passkey';
  return `${deviceName} passkey`;
}

function renameSheet({ kind, id, title, value, label }) {
  openFormSheet(`<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <form class="form-body" id="rename-form" data-kind="${esc(kind)}" data-id="${esc(String(id))}">
      <span class="eyebrow">${esc(title)}</span>
      <h2>Rename</h2>
      <div class="field"><label for="rename-input">${esc(label)}</label>
        <input id="rename-input" name="name" value="${esc(value ?? '')}" maxlength="60" required autocomplete="off"></div>
      <div class="form-actions"><button class="secondary-btn" type="button" data-action="close-form">Cancel</button>
        <button class="play-btn" type="submit">Save name</button></div>
    </form>`, { label: 'Rename', focus: '#rename-input' });
}

async function revokeDevice(id) {
  const device = (state.security.data?.devices ?? []).find((d) => d.id === id);
  if (!device) return;
  const ok = await ask({
    title: device.current ? 'Sign out this device?' : `Sign out ${device.name || 'this device'}?`,
    text: device.current
      ? 'You will be returned to the sign-in screen. A passkey or your passphrase gets you back in.'
      : 'That session ends immediately. Anything it was playing keeps its place on the server.',
    confirmLabel: 'Sign out', danger: true,
  });
  if (!ok) return;
  try {
    const r = await api(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.signedOut) { location.reload(); return; }
    state.security.data.devices = (r.devices ?? []).map((d) => ({ ...d, current: d.id === state.security.data.currentDeviceId }));
    notify('Device signed out');
    render();
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function revokeOtherDevices() {
  const others = (state.security.data?.devices ?? []).filter((d) => !d.current).length;
  const ok = await ask({
    title: 'Sign out every other device?',
    text: `${others} other session${others === 1 ? '' : 's'} will end. This device stays signed in.`,
    confirmLabel: 'Sign out others', danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('/api/auth/devices/revoke-others', { method: 'POST' });
    if (r.signedOut) { location.reload(); return; }
    notify(`${r.revoked ?? 0} device${r.revoked === 1 ? '' : 's'} signed out`);
    await loadSecurity();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ── signing out ─────────────────────────────────────────────────────────
//
// Signing out is an account decision that three different buttons can make, so
// the account-scoped half of localStorage is cleared in exactly one place. A
// reload alone used to leave it all behind for whoever signed in next on this
// browser: the raw search queries they typed, their settings and the two view
// preferences the app remembers. Device-scoped keys stay, because they identify
// the browser and not the account — `sonora.deviceId` (the row the device list
// shows), `sonora.*` PWA install/update snoozes (written by pwa.js) and
// `sonora.room` (where *this tab* was listening). Clearing those would re-prompt
// on the very next visit, or silently drop a room the next account was rejoining.
const ACCOUNT_STORAGE_KEYS = ['searchRecent', 'prefs', 'sort', 'libraryTab'];

/**
 * Drop every account-scoped key. Never throws: storage can be absent, full or
 * refused (Safari private mode / a blocked-cookies profile), and signing out is
 * not allowed to fail because a `removeItem` did.
 */
function clearAccountStorage() {
  for (const key of ACCOUNT_STORAGE_KEYS) store.remove(key);
}

// One browser, many tabs. Signing out of one tab signs out the *session* — the
// cookie is shared — but every other tab kept its user, its room and its refresh
// timer, and simply carried on until its next request 401'd (an audio element
// never re-asks, so that tab could keep playing). A BroadcastChannel is the
// direct line; the `storage` event is the fallback, and it is the one that
// cannot be unavailable, because it needs no API at all.
const AUTH_CHANNEL = 'sonora-auth';
const AUTH_STORAGE_KEY = 'sonora.auth';
let authChannel = null;
let authSyncBound = false;

/** Create the channel and the storage listener once, on the page that needs it. */
function authSync() {
  if (authSyncBound) return authChannel;
  authSyncBound = true;
  try {
    if (typeof BroadcastChannel === 'function') {
      authChannel = new BroadcastChannel(AUTH_CHANNEL);
      authChannel.onmessage = (event) => applySignedOut(event.data);
    }
  } catch { authChannel = null; }
  // `storage` only fires in *other* tabs of this origin, which is exactly the
  // audience: the tab that signed out is about to reload.
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_STORAGE_KEY || !event.newValue) return;
    try { applySignedOut(JSON.parse(event.newValue)); } catch {}
  });
  return authChannel;
}

/**
 * Tell every other tab that this browser is signed out.
 *
 * The key carries a kind and a timestamp and nothing else. The write happens
 * last and synchronously, so it is already queued for the other tabs when the
 * caller's `location.reload()` runs — `BroadcastChannel.postMessage` alone was
 * not a safe ordering: a reload can happen before the message is delivered.
 */
function broadcastSignOut() {
  const stamp = { kind: 'signout', at: Date.now() };
  try { authSync()?.postMessage(stamp); } catch {}
  try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(stamp)); } catch {}
}

/** Another tab signed this browser out: become that tab. */
function applySignedOut(message) {
  if (!message || message.kind !== 'signout') return;
  // A late delivery (a page restored from the freezer, an event that finally
  // fired) must not sign out a session started since: the sign-out path writes
  // its timestamp, so anything older than a minute is history.
  if (Number.isFinite(message.at) && Date.now() - message.at > 60_000) return;
  if (!$('auth-overlay').hidden) return;
  // showAuth() is the whole teardown: it leaves the room, stops the refresh
  // timer, pauses the element and raises the form.
  showAuth();
  notify('Signed out in another tab.', 'info');
}

// Listen from the moment the app runs, not from the first sign-out: the tab
// that has to *hear* the news is by definition not the tab that sends it.
authSync();

async function signOutEverywhere() {
  const ok = await ask({
    title: 'Sign out everywhere?',
    text: 'Every device loses its session, including this one. Saved-device tokens are destroyed, so nothing can silently sign itself back in.',
    confirmLabel: 'Sign out everywhere', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/auth/signout-all', { method: 'POST' });
    // This is the strongest sign-out there is, so it clears the most: every
    // account-scoped key here, and every open tab told to leave as well.
    clearAccountStorage();
    broadcastSignOut();
    location.reload();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ── auth ────────────────────────────────────────────────────────────────
// Whether the page on screen is the offline empty state rather than a page the
// user navigated to. `state.user` alone cannot answer that: a signed-in browser
// whose reload ran while the tunnel was down still carries the user from the
// previous boot, so the offline page looked "signed in" to the online handler.
let offlineBootShown = false;

function showOffline() {
  offlineBootShown = true;
  $('auth-overlay').hidden = true;
  closeOverlay('now-overlay');
  closeOverlay('drawer-overlay');
  $('page-root').innerHTML = emptyState({
    art: 'wave', title: 'You are offline',
    text: 'sonora needs a connection to reach YouTube. Your likes and playlists are safe on the server.',
    actions: `<button class="play-btn" data-action="retry-boot">${icon('repeat')} Try again</button>`,
  });
  $('rail-content').innerHTML = '';
  document.title = 'Offline · sonora';
}

window.addEventListener('online', () => {
  // `!state.user` used to be the whole condition, so a signed-in boot that raced
  // a tunnel blip stayed on the offline empty state — the room/now pill
  // self-recovered, the page did not, and the only way out was a full reload.
  // Coming back online is exactly that reload's "Try again", minus the reload.
  if (offlineBootShown || !state.user) boot();
});

// ── sign-in screen ──────────────────────────────────────────────────────
// The capabilities call is what decides whether a passkey button appears and
// what the remember-me copy promises. It is cached for the page's lifetime: the
// RP ID cannot change without a reload.
let authCaps = null;

async function loadAuthCaps() {
  if (authCaps) return authCaps;
  try {
    authCaps = await api('/api/auth/capabilities');
  } catch {
    authCaps = { passkeys: { supported: false, reason: 'Passkeys are unavailable on this server.' }, refreshDays: 30 };
  }
  return authCaps;
}

function applyAuthCaps() {
  const caps = authCaps;
  if (!caps) return;
  const note = $('auth-remember-note');
  if (note) {
    const days = caps.refreshDays ?? 30;
    note.textContent = `Stay signed in for ${days} days. Leave off on shared machines.`;
  }
  const passkeyBtn = $('auth-passkey');
  const or = $('auth-or');
  const hint = $('auth-hint');
  const usable = Boolean(caps.passkeys?.supported && passkeySupported());
  if (passkeyBtn) passkeyBtn.hidden = !usable;
  if (or) or.hidden = !usable;
  if (hint) {
    // Only explain the *absence* of passkeys when the browser could have used
    // them; a browser without WebAuthn does not need a lecture about RP IDs.
    const reason = caps.passkeys?.supported
      ? 'This browser cannot use passkeys. Your passphrase still works.'
      : caps.passkeys?.reason;
    hint.textContent = usable ? '' : (reason ?? '');
    hint.hidden = usable || !reason;
  }
  const foot = $('auth-foot-note');
  if (foot && caps.hasUsers === false) {
    foot.innerHTML = 'This instance has no accounts yet. Ask an administrator to create one, or set <strong>SONORA_USER</strong> and <strong>SONORA_PASSPHRASE</strong> before first boot.';
  }
}

/**
 * Show the sign-in screen.
 *
 * This is the whole app's front door for a first-time visitor and for an
 * expired session, and it is deliberately the cheapest thing boot can do: the
 * overlay markup already exists in index.html (hidden), so this only unhides it.
 * Every round trip that used to sit in front of it has been taken out of the
 * path — boot() fires /api/me immediately instead of after /api/health (see
 * bootOnce) — and nothing here awaits anything: the capability fetch below
 * repaints the passkey row when it lands, long after the form is on screen.
 *
 * What is left is the module itself: app.js is one 337 KB ES module, so V8
 * parses and compiles all of it before the first statement runs, and a visitor
 * who only needs this form pays for the whole player. Splitting that is not
 * possible from inside this file — it needs a second entry module (a few dozen
 * lines: fetch /api/me, then `await import('./app.js')` on success, else
 * unhide the overlay) plus one `<script>` swap in public/index.html. No build
 * step is required for it: dynamic `import()` is native. That change belongs to
 * index.html and to whoever owns the shell, not here.
 */
function showAuth() {
  // A session that expires while a room is live must not leave this tab in it.
  // The sign-in form is in front of everything, so nothing here can be *used*,
  // but the room is server state and the shared-playhead client is still
  // running inside it: its refresh loop would keep asking a 401 to sync, and
  // the next person at this browser would inherit the room. Leave first (it
  // fires its own goodbye, which a dead session simply refuses), then stop the
  // renewal timer that only exists for a remembered device.
  try { if (rooms.active) void rooms.leave?.(); } catch { /* a teardown never throws */ }
  keepSessionAlive(false);
  closeOverlay('now-overlay');
  closeOverlay('drawer-overlay');
  closeOverlay('yt-overlay');
  closeOverlay('form-overlay');
  $('auth-overlay').hidden = false;
  $('audio').pause();
  document.title = 'Sign in · sonora';
  // The name is never prefilled with a guessed account: that would leak the
  // bootstrap username and would be wrong for every other person on the
  // instance. The browser's own autofill (autocomplete="username") does the
  // remembering instead.
  applyAuthCaps();
  loadAuthCaps().then(applyAuthCaps).catch(() => {});
  setTimeout(() => (($('auth-name')?.value ? $('auth-pass') : $('auth-name'))?.focus({ preventScroll: true })), 80);
}

const authRemember = () => Boolean($('auth-remember')?.checked);

// The browser's stable id and friendly name are already kept for playback
// handoff; the same pair identifies a device to the auth server, so one browser
// is one row in the devices list no matter how often it signs in.
const authDevice = () => ({
  deviceId,
  deviceName,
  platform: navigator.userAgentData?.platform || navigator.platform || null,
});

function authBusy(btn, label) {
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.dataset.label = btn.textContent;
  btn.innerHTML = `<span class="spinner"></span>${esc(label)}`;
}

function authIdle(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('btn-loading');
  if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
}

async function signInWithPassphrase(form) {
  const btn = form.querySelector('button[type="submit"]');
  const fd = new FormData(form);
  const name = String(fd.get('name') ?? '').trim();
  const passphrase = String(fd.get('passphrase') ?? '');
  if (!name || !passphrase) {
    $('auth-err').textContent = 'Enter your name and passphrase.';
    return;
  }
  authBusy(btn, 'Signing in…');
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: { name, passphrase, remember: authRemember(), ...authDevice() },
    });
    $('auth-overlay').hidden = true;
    await boot();
  } catch (err) {
    $('auth-err').textContent = err.message;
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
    authIdle(btn);
    $('auth-pass')?.select();
  }
}

async function signInWithPasskey() {
  const btn = $('auth-passkey');
  const errEl = $('auth-err');
  if (errEl) errEl.textContent = '';
  authBusy(btn, 'Waiting for your device…');
  try {
    if (!passkeySupported()) throw new Error('This browser cannot use passkeys.');
    const name = $('auth-name')?.value?.trim() || undefined;
    const { challengeId, options } = await api('/api/auth/passkey/login/options', {
      method: 'POST', body: name ? { name } : {},
    });
    const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) });
    if (!cred) throw new Error('No passkey was chosen.');
    await api('/api/auth/passkey/login/verify', {
      method: 'POST',
      body: {
        challengeId, response: serializeCredential(cred),
        remember: authRemember(), ...authDevice(),
      },
    });
    $('auth-overlay').hidden = true;
    await boot();
  } catch (err) {
    if (errEl) errEl.textContent = passkeyError(err);
    authIdle(btn);
  }
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-err').textContent = '';
  await signInWithPassphrase(e.target);
});

// Show/hide the passphrase without losing what was typed. The field stays a
// password input; only its type flips, so autofill and password managers keep
// working.
function togglePassphrase() {
  const input = $('auth-pass');
  const btn = document.querySelector('[data-action="toggle-pass"]');
  if (!input || !btn) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
  btn.innerHTML = `<svg class="ico" viewBox="0 0 24 24"><use href="#i-${show ? 'eye-off' : 'eye'}"/></svg>`;
  input.focus({ preventScroll: true });
}

// Forms rendered dynamically (admin, playlists) are handled by delegation.
document.addEventListener('submit', async (e) => {
  if (e.target.id === 'room-create-form') {
    e.preventDefault();
    await createRoomFromForm(e.target);
    return;
  }
  if (e.target.id === 'room-invite-form') {
    e.preventDefault();
    await inviteFromForm(e.target);
    return;
  }

  if (e.target.id === 'playlist-form') {
    e.preventDefault();
    await createPlaylistFromForm(e.target);
    return;
  }

  if (e.target.id === 'rename-form') {
    e.preventDefault();
    const form = e.target;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    const { kind, id } = form.dataset;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving…'; }
    try {
      if (kind === 'device') {
        const r = await api(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
        if (state.security.data) {
          state.security.data.devices = (r.devices ?? []).map((x) => ({ ...x, current: x.id === state.security.data.currentDeviceId }));
        }
      } else {
        const r = await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
        if (state.security.data) state.security.data.passkeys = r.passkeys ?? [];
      }
      closeFormSheet();
      notify('Name saved');
      if (state.page === 'security') render();
    } catch (err) {
      notify(err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Save name'; }
    }
    return;
  }

  if (e.target.id === 'admin-pass-form') {
    e.preventDefault();
    const form = e.target;
    const uid = Number(form.dataset.uid);
    const password = String(new FormData(form).get('password') ?? '');
    const error = $('admin-pass-error');
    if (password.length < 12) { if (error) error.textContent = 'Use at least 12 characters.'; return; }
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving…'; }
    try {
      const r = await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: { password } });
      closeFormSheet();
      if (r.signedOut) {
        notify('Passphrase changed — sign in again');
        setTimeout(() => location.reload(), 900);
        return;
      }
      notify('Passphrase updated');
      await loadAdminTab('users', { force: true });
    } catch (err) {
      if (error) error.textContent = err.message;
      if (btn) { btn.disabled = false; btn.textContent = 'Set passphrase'; }
    }
    return;
  }

  if (e.target.id !== 'admin-new-user') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const name = String(fd.get('name') ?? '').trim();
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: {
        name,
        passphrase: fd.get('passphrase'),
        role: fd.get('role'),
      },
    });
    e.target.reset();
    notify(`Created ${name}`);
    invalidateAdmin('users', 'overview');
    await loadAdminTab('users', { force: true });
  } catch (err) {
    notify(err.message, 'error');
  }
});

// ── input modality ──────────────────────────────────────────────────────
// `:focus-visible` already handles most of this, but focus moved
// programmatically (a tab that re-renders itself) inherits whatever mode the
// browser last saw. Recording it explicitly keeps a tap from painting a
// keyboard ring on the control it just selected.
let lastInputWasKeyboard = false;
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length > 1 || e.key === ' ') lastInputWasKeyboard = true;
}, true);
window.addEventListener('pointerdown', () => { lastInputWasKeyboard = false; }, true);

// ── global interactions ─────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action],[data-page],[data-collection],[data-track],[data-filter],[data-library-tab],[data-mood],[data-menu-action],[data-overlay-tab],[data-admin-tab],[data-admin]');
  // Any click outside an open menu dismisses it first. Without this a menu can
  // outlive the action it triggered and float over the panel that replaced it.
  const inMenu = e.target.closest?.('#profile-menu, #context-menu');
  const isProfileToggle = e.target.closest?.('[data-action="profile"]');
  if (!inMenu && !isProfileToggle) closeMenus({ restoreFocus: false });
  // Choosing something from the account menu always dismisses it.
  if (el && e.target.closest?.('#profile-menu')) closeMenus({ restoreFocus: false });
  if (!el) { return; }
  const d = el.dataset;

  if (d.adminTab) {
    state.admin.tab = d.adminTab;
    // Keep the active chip visible after a swipe-scroll on a phone.
    const chip = document.querySelector(`[data-admin-tab="${d.adminTab}"]`);
    chip?.scrollIntoView({ block: 'nearest', inline: 'center' });
    state.admin.error = null;
    closeMenus();
    render();
    return;
  }
  if (d.admin) { await adminAction(d.admin, d.id); return; }

  if (d.page) { navigate(d.page); return; }
  if (d.collection) { await openCollection(d.collection); return; }
  if (d.track && !d.action) {
    const row = el.closest?.('.track-row');
    if (row?.dataset.longPress) { delete row.dataset.longPress; return; }
    const coll = el.dataset.coll;
    // Clicking a song on the station page starts the station from that song —
    // endless, and still the station, rather than a 30-song one-off copy.
    if (coll === 'station') {
      if (stationPlaying()) { playTrack(d.track, state.queue); return; }
      const list = state.station?.tracks ?? [];
      const at = list.findIndex((t) => t.videoId === d.track);
      playStation(at > 0 ? [...list.slice(at), ...list.slice(0, at)] : list);
      return;
    }
    const list = coll ? (await tracksFor(coll)) : currentList();
    playTrack(d.track, list.length ? list : null);
    return;
  }
  if (d.filter) {
    // The type tabs only ever switch the view over the answer already on
    // screen, so an unknown value (an old cached page, a typo in markup) is
    // ignored rather than stored and left to fall through to a blank shelf.
    if (!SEARCH_FILTERS.some((f) => f.key === d.filter)) return;
    const keyboard = lastInputWasKeyboard;
    state.filter = d.filter;
    $('search-results').innerHTML = searchBody();
    // Re-rendering replaces the pressed tab, which would otherwise drop a
    // keyboard user back to the top of the document; the ring follows the tab.
    if (keyboard) $('search-results').querySelector(`[data-filter="${d.filter}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (d.libraryTab) {
    if (state.libraryTab === d.libraryTab && state.page === 'library') return;
    state.libraryTab = d.libraryTab;
    store.set('libraryTab', d.libraryTab);
    if (state.page !== 'library') navigate('library');
    else render();
    return;
  }
  if (d.recentSearch) {
    state.search = d.recentSearch;
    state.searchResults = null;
    navigate('search');
    runSearch();
    return;
  }
  if (d.mood) {
    state.filter = 'all';
    navigate('mood', null, true, d.mood);
    return;
  }
  if (d.overlayTab) {
    state.overlayTab = d.overlayTab;
    if (d.overlayTab === 'lyrics' || d.overlayTab === 'details') loadLyrics();
    refreshOverlay({ force: true });
    const tab = $('now-content').querySelector(`[data-overlay-tab="${d.overlayTab}"]`);
    // Focus follows the keyboard so the ring tracks where the user is; after a
    // tap the tab is simply selected, with no ring painted on it.
    if (tab && lastInputWasKeyboard) tab.focus({ preventScroll: true });
    return;
  }

  if (d.menuAction) {
    const id = d.id;
    if (d.menuAction === 'like') { await toggleLike(id); }
    if (d.menuAction === 'dislike') { await toggleDislike(id); }
    if (d.menuAction === 'next') { queueNext(id); }
    if (d.menuAction === 'remove-from-playlist' && d.coll) {
      const plId = Number(String(d.coll).slice(1));
      const row = document.querySelector(`.track-row[data-track="${CSS.escape(id)}"]`);
      row?.classList.add('removing');
      api(`/api/playlists/${plId}/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then(async () => {
          // The DELETE is the success boundary. Confirm it before auxiliary refresh
          // work: a slow collection reload must not leave the changed screen silent.
          notify('Removed from playlist');
          await loadPlaylists();
          setTimeout(async () => {
            if (state.collection === d.coll) await openCollection(d.coll, { history: 'none' });
          }, row ? 180 : 0);
        })
        .catch((err) => { row?.classList.remove('removing'); notify(err.message, 'error'); });
    }
    if (d.menuAction === 'add') { closeMenus({ restoreFocus: false }); openAddToPlaylist(id); return; }
    if (d.menuAction === 'open-album') { closeMenus({ restoreFocus: false }); await openAlbumFor(id); return; }
    if (d.menuAction === 'go-artist') {
      closeMenus({ restoreFocus: false });
      const t = trackIndex.get(id) ?? current();
      const who = t?.channelId || t?.channel;
      if (!who) { notify('No artist is known for that track.', 'info'); return; }
      if (!$('now-overlay').hidden) closeNow();
      openArtist(who);
      return;
    }
    if (d.menuAction === 'sort-title' || d.menuAction === 'sort-recent') {
      state.sort = d.menuAction === 'sort-title' ? 'title' : 'recent';
      store.set('sort', state.sort);
      render();
    }
    if (d.menuAction === 'delete-playlist') {
      const pl = state.playlists.find((p) => p.id === Number(id)) ?? state.collectionData;
      confirmSheet({
        title: 'Delete this playlist?',
        text: `“${pl?.title ?? 'This playlist'}” will be removed from sonora. Your YouTube account is untouched.`,
        confirmLabel: 'Delete playlist', danger: true,
        action: async () => {
          await api(`/api/playlists/${id}`, { method: 'DELETE' });
          await loadPlaylists();
          notify('Playlist deleted');
          navigate('library');
        },
      });
    }
    if (d.menuAction === 'share') {
      // A real path, not the app's `#/t/<id>` hash: a fragment never reaches the
      // server, so a chat client's link crawler would only ever see the generic
      // app shell and the paste would render as a bare URL. `/t/<id>` serves the
      // Open Graph card and links back into `#/t/<id>` (src/server.js, "share
      // cards").
      const url = `${location.origin}/t/${encodeURIComponent(id)}`;
      if (navigator.share) navigator.share({ title: 'sonora', url }).catch(() => {});
      else navigator.clipboard?.writeText(url).then(() => notify('Link copied', 'info')).catch(() => notify(`Link: ${url}`, 'info'));
    }
    closeMenus();
    return;
  }

  const id = d.id;
  // One catch for the whole delegation. Many branches await helpers that report
  // their own errors, but the ones that do not (a room command, a playlist read
  // behind "Play all") used to reject into an unhandled promise — the button
  // did nothing and said nothing.
  try {
  switch (d.action) {
    case 'back':
      if (historyCursor.index > 0) {
        captureScroll();
        historyCursor.index -= 1;
        const x = historyEntries[historyCursor.index];
        if (x.page === 'collection' && x.collection) await openCollection(x.collection, { history: 'none', scrollTop: x.scroll ?? 0 });
        else navigate(x.page, x.collection, false, x.mood);
      }
      break;
    case 'forward':
      if (historyCursor.index < historyEntries.length - 1) {
        captureScroll();
        historyCursor.index += 1;
        const x = historyEntries[historyCursor.index];
        if (x.page === 'collection' && x.collection) await openCollection(x.collection, { history: 'none', scrollTop: x.scroll ?? 0 });
        else navigate(x.page, x.collection, false, x.mood);
      }
      break;
    case 'heart': await toggleLike(id); break;
    case 'dislike': await toggleDislike(id); break;
    case 'rebuild-station': await loadStation({ force: true }); break;
    case 'play-station': {
      if (!state.station) await loadStation();
      const tracks = state.station?.tracks ?? [];
      playStation(tracks);
      break;
    }
    case 'shuffle-station': {
      if (!state.station) await loadStation();
      const tracks = state.station?.tracks ?? [];
      playStation(tracks, { shuffle: true });
      break;
    }
    case 'playpause': playPause(); break;
    case 'play-track': playTrack(id, state.queue); break;
    case 'queue-add':
      closeMenus({ restoreFocus: false });
      await queueAdd(id);
      break;
    case 'play-collection': {
      const tracks = await tracksFor(state.collection);
      if (!tracks.length) return notify('This collection is empty.', 'info');
      playQueue(tracks);
      break;
    }
    case 'shuffle-play': {
      const tracks = await tracksFor(state.collection);
      if (!tracks.length) return notify('This collection is empty.', 'info');
      playQueue(tracks, { shuffle: true });
      break;
    }
    case 'queue-collection': {
      const tracks = await tracksFor(state.collection);
      if (rooms.active) {
        // Adding to the queue is adding to *the room's* queue: a suggestion
        // everyone can see, which is the collaborative half of a room.
        const fresh = tracks.filter((t) => !(state.room?.queue ?? []).some((q) => q.videoId === t.videoId));
        if (!fresh.length) { notify('Already in the queue', 'info'); break; }
        for (const t of fresh) await rooms.command('queue-add', { track: t });
        notify(fresh.length === 1 ? 'Added to the shared queue' : `${fresh.length} added to the shared queue`, 'info');
        break;
      }
      const fresh = tracks.filter((t) => !state.queue.some((q) => q.videoId === t.videoId));
      state.queue = [...state.queue, ...fresh];
      notify(fresh.length ? `${fresh.length} added to the queue` : 'Already in the queue', 'info');
      render();
      break;
    }
    case 'retry-collection': await openCollection(id, { history: 'none' }); break;
    case 'playlist-menu': {
      contextMenu(e, [
        { text: 'Add to queue', action: 'queue-collection', icon: 'queue', id: state.collection },
        { text: 'Delete playlist', action: 'delete-playlist', icon: 'close', id },
      ]);
      break;
    }
    case 'play-seed': {
      const seed = state.home.recent[0];
      if (seed) await startRadio(seed.videoId);
      else notify('Play a song first to seed the radio.', 'info');
      break;
    }
    case 'station':
      if (id) await startRadio(id);
      break;
    case 'surprise': {
      const seed = state.likedTracks[0] ?? state.home.recent[0];
      if (seed) await startRadio(seed.videoId);
      else navigate('search');
      break;
    }
    case 'play-featured': {
      const f = state.home.featured;
      if (!f) break;
      const idx = state.queue.findIndex((x) => x.videoId === f.videoId);
      const resumeMs = state.home.featuredPos || 0;
      if (idx >= 0 && idx === state.index && audio.src) {
        // Already loaded: resume in place rather than re-downloading the file.
        if (audio.paused) {
          state.pendingResumeMs = resumeMs;
          claimSession();
          claimAudioSession();
          audio.play().catch(() => {});
        }
        updatePlayer();
      } else if (idx >= 0) {
        playIndex(idx, { resumeMs, claim: true });
      } else {
        state.queue = [completeTrack(f), ...state.queue];
        playIndex(0, { resumeMs, claim: true, queueChanged: true });
      }
      break;
    }
    case 'go-search': navigate('search'); break;
    case 'prev':
      if (rooms.active) {
        if (audio.currentTime > 3) rooms.command('seek', { positionMs: 0 });
        else rooms.command('prev');
        break;
      }
      claimSession();
      if (playerPosition() > 3) { seekTo(0); return; }
      nextTrack({ back: true, userInitiated: true });
      break;
    case 'next':
      if (rooms.active) { rooms.command('next'); break; }
      nextTrack({ userInitiated: true });
      break;
    case 'room': await openRoomSheet(id ?? null); break;
    case 'room-join': await joinRoomFromUi(id ?? state.collection); break;
    case 'room-copy': await copyRoomLink(); break;
    case 'room-share': await shareRoomLink(); break;
    case 'room-leave': await leaveRoomFromUi(); break;
    case 'room-end': endRoomFromUi(); break;
    case 'room-make-host': {
      // Hand the seat over, from the sheet, host only. The click is optimistic
      // in one direction only: the button disables immediately so a double tap
      // cannot send two hand-overs, and the roster repaints from the snapshot
      // the server returns (which is what flips everyone's policy view).
      if (!rooms.active) break;
      // `d` is already the element's dataset (see `const d = el.dataset`), so
      // this read used to be `d.dataset.user` — undefined.user, a TypeError on
      // every tap: "Make host" threw, the hand-over never left the page, and the
      // only trace was a toast reading "Cannot read properties of undefined
      // (reading 'user')". Handing the seat over is the one escape from a room
      // whose host has walked off, so the button has to work.
      const who = Number(d.user);
      if (!Number.isInteger(who)) break;
      d.disabled = true;
      const label = d.textContent;
      d.textContent = 'Handing over…';
      const snap = await rooms.setHost(who);
      if (!snap) {
        d.disabled = false;
        d.textContent = label;
      }
      break;
    }
    case 'room-visibility': await setRoomVisibility(d.value); break;
    case 'room-control': await setRoomControl(d.value); break;
    case 'room-select':
      if (rooms.active) await rooms.command('select', { index: Number(d.index) });
      break;
    case 'room-queue-remove':
      if (rooms.active) {
        // Remove by track id, not by position: the idempotent form is
        // exactly-once (already gone is success) and cannot delete a neighbour
        // when another member changed the queue under a retried request.
        // `index` stays as the fallback for an old snapshot without ids.
        if (d.videoId) await rooms.command('queue-remove', { videoId: d.videoId });
        else await rooms.command('queue-remove', { index: Number(d.index) });
      }
      break;
    case 'room-invite-user': await inviteUserById(Number(d.id)); break;
    case 'room-uninvite': await uninviteById(Number(d.id)); break;
    case 'open-room-page': closeFormSheet(); navigate('room', id); break;
    case 'shuffle':
      state.shuffle = !state.shuffle;
      store.set('shuffle', state.shuffle);
      // The armed plan holds one random *order*, baked in when it was built
      // (public/queue-stream.js). Toggling shuffle mid-track without dropping it
      // is how a locked phone plays the old order all night.
      invalidateQueuePlan();
      notify(state.shuffle ? 'Shuffle on' : 'Shuffle off', 'info');
      updatePlayer();
      refreshOverlay();
      break;
    case 'repeat':
      state.repeat = (state.repeat + 1) % 3;
      store.set('repeat', state.repeat);
      // Same rule as shuffle, and worse when it is missed: a plan armed before
      // repeat-one stays a whole-queue plan, and the reverse leaves one song
      // looping until the listener comes back to the app.
      invalidateQueuePlan();
      notify(['Repeat off', 'Repeat all', 'Repeat one'][state.repeat], 'info');
      updatePlayer();
      refreshOverlay();
      break;
    case 'create': openCreatePlaylist(); break;
    case 'pick-playlist': {
      const t = trackIndex.get(d.video) ?? { videoId: d.video };
      const btn = el;
      btn.disabled = true;
      try {
        await api(`/api/playlists/${id}/tracks`, {
          method: 'POST',
          body: { videoId: t.videoId, title: t.title, channel: t.channel, durationS: t.durationS, thumb: t.thumb },
        });
        await loadPlaylists();
        closeFormSheet();
        notify('Added to playlist');
        if (state.page === 'collection') render();
      } catch (err) {
        btn.disabled = false;
        notify(err.message, 'error');
      }
      break;
    }
    case 'close-form': closeFormSheet(); break;
    case 'confirm-form': {
      const action = confirmAction;
      const btn = $('form-content').querySelector('[data-action="confirm-form"]');
      if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); btn.innerHTML = `<span class="spinner"></span>${btn.textContent.trim()}`; }
      try { await action?.(); closeFormSheet(); } catch (err) {
        notify(err.message, 'error');
        if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Try again'; }
      }
      break;
    }
    case 'nowplaying': openNow(null, el); break;
    case 'lyrics': openNow('lyrics', el); break;
    case 'close-overlay': closeNow(); break;
    case 'queue': openDrawer(el); break;
    case 'close-drawer': closeOverlay('drawer-overlay'); break;
    // The bell belongs to the notifications module (public/notifications.js):
    // it owns the panel and talks to the API itself. The fallback keeps the old
    // "nothing to report" toast if that module is not loaded.
    case 'notifications':
      if (window.__sonoraNotifications?.open) window.__sonoraNotifications.open(el);
      else notify('You are all caught up. Happy listening!', 'info');
      break;
    case 'profile': {
      const menu = $('profile-menu');
      // Re-clicking the same button toggles; clicking the other trigger while
      // the menu is open just moves it to that corner.
      const open = menu.hidden || menuTrigger !== el;
      menuTrigger = el;
      if (open) positionProfileMenu(el);
      else menu.hidden = true;
      // Only the trigger that opened it claims aria-expanded; the other one is
      // the same menu from a different corner of the shell.
      for (const btn of document.querySelectorAll('[data-action="profile"]')) {
        btn.setAttribute('aria-expanded', String(open && btn === el));
      }
      if (open) menu.querySelector('button:not([hidden])')?.focus({ preventScroll: true });
      break;
    }
    case 'settings': openSettings(); break;
    case 'shortcuts': {
      closeMenus({ restoreFocus: false });
      openFormSheet(`<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
        <div class="form-body"><span class="eyebrow">Keyboard</span><h2>Shortcuts</h2>
        <div class="shortcut-list">
          <div><kbd>Space</kbd><span>Play / pause</span></div>
          <div><kbd>Alt</kbd><kbd>→</kbd><span>Next track</span></div>
          <div><kbd>Alt</kbd><kbd>←</kbd><span>Previous track</span></div>
          <div><kbd>⌘</kbd><kbd>K</kbd><span>Search</span></div>
          <div><kbd>Esc</kbd><span>Close any panel</span></div>
        </div>
        <div class="form-actions"><button class="play-btn" data-action="close-form">Got it</button></div></div>`,
      { label: 'Keyboard shortcuts' });
      break;
    }
    case 'logout':
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      // A reload alone leaves the previous account's data sitting in this
      // browser for whoever signs in next. See clearAccountStorage(): the
      // account-scoped keys go, the device-scoped ones stay.
      clearAccountStorage();
      // Other tabs share this cookie, so they are signed out too — tell them
      // before the reload (the write is synchronous; see broadcastSignOut()).
      broadcastSignOut();
      location.reload();
      break;

    // ── sign-in screen ──
    case 'toggle-pass':
      togglePassphrase();
      break;
    case 'passkey-login':
      await signInWithPasskey();
      break;

    // ── account & security ──
    case 'security-refresh':
      state.security.data = null;
      await loadSecurity();
      break;
    case 'passkey-add':
      await addPasskey();
      break;
    case 'passkey-rename': {
      const id = Number(d.id);
      const pk = (state.security.data?.passkeys ?? []).find((p) => p.id === id);
      if (pk) renameSheet({ kind: 'passkey', id, title: 'Passkey', value: pk.name, label: 'Passkey name' });
      break;
    }
    case 'passkey-remove': {
      const id = Number(d.id);
      const pk = (state.security.data?.passkeys ?? []).find((p) => p.id === id);
      if (!pk) break;
      const ok = await ask({
        title: `Remove ${pk.name || 'this passkey'}?`,
        text: 'That device can no longer sign in with it. Your passphrase still works, and you can add a new passkey at any time.',
        confirmLabel: 'Remove passkey', danger: true,
      });
      if (!ok) break;
      try {
        const r = await api(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
        if (state.security.data) state.security.data.passkeys = r.passkeys ?? [];
        notify('Passkey removed');
        render();
      } catch (err) { notify(err.message, 'error'); }
      break;
    }
    case 'device-rename': {
      const dev = (state.security.data?.devices ?? []).find((x) => x.id === d.id);
      if (dev) renameSheet({ kind: 'device', id: dev.id, title: 'Device', value: dev.name, label: 'Device name' });
      break;
    }
    case 'device-revoke':
      await revokeDevice(d.id);
      break;
    case 'device-forget': {
      const dev = (state.security.data?.devices ?? []).find((x) => x.id === d.id);
      if (!dev) break;
      const ok = await ask({
        title: `Stop remembering ${dev.name || 'this device'}?`,
        text: 'Its saved-session token is destroyed. The device stays signed in until you close the browser, then needs the passphrase again.',
        confirmLabel: 'Forget device',
      });
      if (!ok) break;
      try {
        const r = await api(`/api/auth/devices/${encodeURIComponent(d.id)}`, {
          method: 'PATCH', body: { remembered: false },
        });
        if (state.security.data) {
          state.security.data.devices = (r.devices ?? []).map((x) => ({ ...x, current: x.id === state.security.data.currentDeviceId }));
          if (d.id === state.security.data.currentDeviceId) {
            state.security.data.remembered = false;
            // Stop the renewal timer too: this device no longer has a token to
            // renew, and a failed refresh every few hours is just noise.
            keepSessionAlive(false);
          }
        }
        notify('Device forgotten');
        render();
      } catch (err) { notify(err.message, 'error'); }
      break;
    }
    case 'revoke-others':
      await revokeOtherDevices();
      break;
    case 'signout-all':
      await signOutEverywhere();
      break;
    case 'signout-here': {
      const ok = await ask({
        title: 'Sign out this device?',
        text: 'Only this browser loses its session. Your other devices stay signed in.',
        confirmLabel: 'Sign out here', danger: true,
      });
      if (!ok) break;
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      // Same teardown as the account menu's Sign out: this button signs the
      // same session out and used to leave every account-scoped key behind.
      clearAccountStorage();
      broadcastSignOut();
      location.reload();
      break;
    }
    case 'retry-boot': location.reload(); break;
    case 'device': notify('Output: this device', 'info'); break;
    case 'connect-youtube':
      await refreshYtStatus();
      openYtSheet();
      break;
    case 'yt-verify': {
      const btn = $('yt-verify');
      const errEl = $('yt-err');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Testing…'; }
      try {
        const { verdict, jar } = await api('/api/youtube/verify', { method: 'POST' });
        state.jar = jar;
        openYtSheet();
        notify(verdict.status === 'verified' ? 'Verified — cookies work'
          : verdict.status === 'rejected' ? 'YouTube rejected these cookies'
          : 'Test inconclusive — nothing is blocking right now');
      } catch (e) {
        if (errEl) errEl.textContent = e.message;
        if (btn) { btn.disabled = false; btn.textContent = 'Test connection'; }
      }
      break;
    }
    case 'yt-diagnose': {
      const errEl = $('yt-err');
      const btn = $('yt-diagnose');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Checking…'; }
      try {
        const d = await api('/api/youtube/diagnose');
        state.diagnosis = d;
        openYtSheet();
      } catch (e) {
        if (errEl) errEl.textContent = e.message;
        if (btn) { btn.disabled = false; btn.textContent = 'Run diagnostics'; }
      }
      break;
    }
    case 'yt-submit':
      await submitCookies($('yt-text')?.value ?? '');
      break;
    case 'yt-replace':
      state.jar = { connected: false };
      $('yt-content').innerHTML = ytSheetHtml();
      break;
    case 'yt-disconnect':
      await api('/api/youtube/cookies', { method: 'DELETE' }).catch((e) => notify(e.message));
      await refreshYtStatus();
      openYtSheet();
      notify('YouTube session disconnected');
      break;
    case 'close-yt': closeOverlay('yt-overlay'); break;
    case 'mute':
      state.muted = !state.muted;
      audio.muted = state.muted;
      store.set('muted', state.muted);
      updatePlayer();
      break;
    case 'artist':
      // Navigating out of a sheet dismisses it: the page must not change
      // underneath a modal that still covers it.
      if (!$('now-overlay').hidden) closeNow();
      openArtist(d.artist);
      break;
    case 'retry-artist':
      state.artist = null;
      loadArtist(id);
      break;
    case 'play-artist': {
      const songs = state.artist?.songs ?? [];
      if (!songs.length) return notify('This artist has no playable songs.', 'info');
      playQueue(songs);
      break;
    }
    case 'shuffle-artist': {
      const songs = state.artist?.songs ?? [];
      if (!songs.length) return notify('This artist has no playable songs.', 'info');
      playQueue(songs, { shuffle: true });
      break;
    }
    case 'artist-radio': {
      // A station seeded from the artist's most-played song: the same graph the
      // Radio page uses, but entered from the page the listener is reading.
      const seed = state.artist?.songs?.[0]?.videoId;
      if (!seed) return notify('No song to seed a station with.', 'info');
      await startRadio(seed);
      break;
    }
    case 'follow-artist': {
      // The id and name travel on the button, so the control works even if the
      // page re-rendered underneath it (the state read here is only a fallback).
      const artistId = d.artist || state.artist?.id;
      if (!/^UC[\w-]{20,}$/.test(artistId ?? '')) break;
      await setFollowing(artistId, d.name || state.artist?.name, !state.artist?.following);
      break;
    }
    case 'open-album': {
      if (!$('now-overlay').hidden) closeNow();
      if (d.album) { await openCollection(`a${d.album}`); break; }
      await openAlbumFor(id, el);
      break;
    }
    case 'sort':
      contextMenu(e, [
        { text: 'Recently added', action: 'sort-recent', icon: 'clock' },
        { text: 'Title A–Z', action: 'sort-title', icon: 'list' },
      ]);
      break;
    case 'clear-search':
      state.search = '';
      clearSearchShelves(undefined);
      render();
      $('primary-search')?.focus({ preventScroll: true });
      break;
    case 'clear-recent-searches':
      state.searchRecent = [];
      store.set('searchRecent', []);
      $('search-results').innerHTML = searchBody();
      break;
    case 'track-menu': {
      const vid = d.id;
      const disliked = state.disliked.has(vid);
      contextMenu(e, [
        { text: 'Play next', action: 'next', icon: 'next', id: vid },
        // Append, unlike "Play next" which jumps the queue (see queueAdd).
        { text: 'Add to queue', dataAction: 'queue-add', icon: 'queue', id: vid },
        { text: 'Add to playlist', action: 'add', icon: 'plus', id: vid },
        // Album navigation belongs on every song, including on a phone where
        // the album column of the row is hidden.
        { text: 'Open album', action: 'open-album', icon: 'list', id: vid },
        // Who made it is the other half of "what is this" — reachable from any
        // song, including on a phone where the artist name is not a link.
        { text: 'Go to artist', action: 'go-artist', icon: 'headphones', id: vid },
        { text: 'Like', action: 'like', icon: 'heart', id: vid },
        // The row hides the dislike button on narrow screens, so the instruction
        // has to live somewhere reachable on every song.
        { text: disliked ? 'Undo "less like this"' : 'Less like this', action: 'dislike', icon: 'thumb-down', id: vid },
        { text: 'Copy link', action: 'share', icon: 'share', id: vid },
      ]);
      break;
    }
    default: break;
  }
  } catch (err) {
    notify(err?.message || 'Something went wrong. Try again.', 'error');
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'primary-search') {
    state.search = t.value;
    document.title = pageTitle();
    const clear = document.querySelector('[data-action="clear-search"]');
    if (clear) clear.hidden = !t.value;
    if (searchTimer) clearTimeout(searchTimer);
    if (!t.value.trim()) {
      clearSearchShelves([]);
      $('search-results').innerHTML = searchBody();
      return;
    }
    // `clearSearchShelves(null)` puts the results container into its loading
    // state first, so the repaint below is the spinner and five skeleton rows —
    // NOT the shelves: `searchBody()` returns early while `searchResults` is
    // null, and the four shelves are only built by the debounced runSearch when
    // an answer actually arrives. (The review filed this as a ~3,000-node
    // repaint per keystroke; measured against this code it is ~35 nodes, which
    // is why the immediate "Searching…" feedback stays.)
    clearSearchShelves(null);
    $('search-results').innerHTML = searchBody();
    searchTimer = setTimeout(runSearch, 380);
  }
  if (t.dataset.slider === 'progress') {
    // A drag is a human hand on the playhead: hold the room's correction loop
    // so it does not yank the slider back under the finger.
    if (rooms.active) rooms.hold(4000);
    if (state.streaming) {
      // While the stream plays, a drag cannot seek per input event: each seek
      // is a new source. Paint the bar under the finger and seek on release
      // (the `change` handler below).
      const dur = playerDuration() || 1;
      document.querySelectorAll('input[data-slider="progress"]').forEach((x) => {
        x.value = t.value;
        x.style.setProperty('--percent', `${(Number(t.value) / dur) * 100}%`);
      });
      document.querySelectorAll('.elapsed').forEach((x) => { x.textContent = fmt(Number(t.value)); });
      paintPlayerProgress(Number(t.value), dur);
      return;
    }
    // seekTo is the one door: it knows whether the element is playing a track
    // or the queue stream, and a raw `currentTime` write while streaming would
    // jump inside the plan's timeline instead of the track's.
    seekTo(Number(t.value));
    const dur = audio.duration || 1;
    document.querySelectorAll('input[data-slider="progress"]').forEach((x) => {
      x.value = t.value;
      x.style.setProperty('--percent', `${(Number(t.value) / dur) * 100}%`);
    });
    document.querySelectorAll('.elapsed').forEach((x) => { x.textContent = fmt(Number(t.value)); });
    if (dur) paintPlayerProgress(Number(t.value), dur);
  }
  if (t.dataset.slider === 'volume') {
    state.volume = Number(t.value) / 100;
    state.muted = state.volume === 0;
    audio.volume = state.volume;
    audio.muted = state.muted;
    t.style.setProperty('--percent', `${t.value}%`);
    // A drag fires ~60 input events a second; a synchronous localStorage write
    // on each one is a known source of drag jank on a phone. Persist on settle.
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(() => {
      volumeSaveTimer = null;
      store.set('volume', state.volume);
      store.set('muted', state.muted);
    }, 150);
  }
  if (t.id === 'admin-track-search') {
    state.admin.trackQuery = t.value;
    state.admin.trackFocus = true;
    clearTimeout(adminSearchTimer);
    adminSearchTimer = setTimeout(() => loadAdminTab('library', { force: true }), 300);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.slider === 'progress') {
    // The drag painted while streaming; the release is the seek.
    if (state.streaming) seekTo(Number(e.target.value));
    state.manualSeek = false;
    // The command is sent on release, not on every input event: a drag would
    // otherwise be a flood of seeks for everyone else in the room.
    if (rooms.active) {
      rooms.hold(1500);
      rooms.command('seek', { positionMs: Math.round(Number(e.target.value) * 1000) });
    }
  }
});

$('now-overlay').addEventListener('click', (e) => { if (e.target.id === 'now-overlay') closeNow(); });
$('yt-overlay').addEventListener('click', (e) => { if (e.target.id === 'yt-overlay') closeOverlay('yt-overlay'); });

// File drop / picker for the cookie jar.
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'yt-file') return;
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const area = $('yt-text');
  if (area) area.value = text;
  await submitCookies(text);
});

document.addEventListener('dragover', (e) => {
  const drop = e.target.closest?.('#yt-drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  e.target.closest?.('#yt-drop')?.classList.remove('dragging');
});
document.addEventListener('drop', async (e) => {
  const drop = e.target.closest?.('#yt-drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const text = await file.text();
  const area = $('yt-text');
  if (area) area.value = text;
  await submitCookies(text);
});

document.addEventListener('click', (e) => {
  if (e.target.closest?.('#yt-drop')) $('yt-file')?.click();
});
$('drawer-overlay').addEventListener('click', (e) => { if (e.target.id === 'drawer-overlay') closeOverlay('drawer-overlay'); });

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (state.page !== 'search') navigate('search');
    else $('primary-search')?.focus({ preventScroll: true });
    return;
  }

  if (e.key === 'Tab') {
    const top = topOverlay();
    if (top) trapTab(e, top.querySelector('[role="dialog"]') ?? top);
    return;
  }

  if (e.key === 'Escape') {
    if (!$('context-menu').hidden || !$('profile-menu').hidden) { closeMenus(); return; }
    if (!$('form-overlay').hidden) return closeFormSheet();
    if (!$('yt-overlay').hidden) return closeOverlay('yt-overlay');
    if (!$('drawer-overlay').hidden) return closeOverlay('drawer-overlay');
    if (!$('now-overlay').hidden) return closeNow();
    if (document.activeElement.id === 'primary-search') document.activeElement.blur();
    return;
  }

  if (document.activeElement.id === 'primary-search' && e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    runSearch();
    if (window.matchMedia('(max-width: 650px)').matches) document.activeElement.blur();
    return;
  }

  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
    || document.activeElement.isContentEditable;
  if (typing) return;

  // Reorder the queue from the keyboard: Alt+↑ / Alt+↓ with focus on a row or
  // on its grip. Plain arrows are left alone — they scroll the list. This runs
  // BEFORE the sheet guard below: reordering is a keyboard feature of the queue
  // drawer and of the sheet's "Up next" tab, so focus inside a queue row is
  // exactly where the keys must keep working while an overlay is open.
  const queueRowEl = document.activeElement.closest?.('[data-queue-row]');
  if (queueRowEl && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    e.stopPropagation();
    reorderQueueRow(queueRowEl, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  // A modal sheet is open: the keys below are the sheet's to interpret, not
  // the player's. The typing guard above only covers focused inputs, so `/`,
  // `m`, `q`, Space and the arrows would otherwise navigate/switch tracks
  // while a confirm or form sheet sits on top of the app (typing an unmached
  // letter into a form that never focuses an input — a confirm sheet — is the
  // reachable case). topOverlay() is the same state the Escape handler uses.
  if (topOverlay()) return;

  // Elements that act as buttons but are not <button> still need Enter/Space.
  // A real <button> (the album cell inside a row, say) activates itself, and
  // stealing Enter here would play the row instead of opening the album.
  if (document.activeElement.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
  const roleButton = document.activeElement.closest?.('[role="button"][data-action]');
  if (roleButton && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    e.stopPropagation();
    roleButton.click();
    return;
  }
  const activeRow = document.activeElement.closest?.('.track-row[data-track]');
  if (activeRow && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    e.stopPropagation();
    activeRow.click();
    return;
  }

  if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (state.page !== 'search') navigate('search');
    $('primary-search')?.focus({ preventScroll: true });
    return;
  }
  if (document.activeElement.tagName === 'BUTTON' && e.code === 'Space') return;
  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); playPause(); }
  if (e.key === 'ArrowRight' && e.altKey) { e.preventDefault(); nextTrack({ userInitiated: true }); }
  // `userInitiated` matches Alt+Right: an Alt+ArrowLeft is the same keyboard
  // gesture (a deliberate skip) and must log the skip and claim the session
  // the same way — the omission made the back-skip the one action that did not.
  if (e.key === 'ArrowLeft' && e.altKey) { e.preventDefault(); nextTrack({ back: true, userInitiated: true }); }
  if (e.key === 'ArrowRight' && !e.altKey) { e.preventDefault(); if (playerDuration()) seekTo(Math.min(playerDuration() - 0.5, playerPosition() + 5)); }
  if (e.key === 'ArrowLeft' && !e.altKey) { e.preventDefault(); seekTo(Math.max(0, playerPosition() - 5)); }
  if (e.key.toLowerCase() === 'm') { e.preventDefault(); state.muted = !state.muted; audio.muted = state.muted; store.set('muted', state.muted); updatePlayer(); }
  if (e.key.toLowerCase() === 'q') { e.preventDefault(); openDrawer(); }
});

// Right-click and long-press both open the per-track menu. Long-press is what
// touch users actually reach for, and there is no hover affordance on a phone.
function openTrackMenu(row, e) {
  const vid = row.dataset.track;
  const coll = row.dataset.coll || (state.page === 'collection' ? state.collection : null);
  const items = [
    { text: 'Play next', action: 'next', icon: 'next', id: vid },
    { text: 'Add to queue', dataAction: 'queue-add', icon: 'queue', id: vid },
    { text: 'Add to playlist', action: 'add', icon: 'plus', id: vid },
    { text: 'Listen together', action: 'room', icon: 'headphones', id: vid },
    { text: 'Like', action: 'like', icon: 'heart', id: vid },
    { text: 'Copy link', action: 'share', icon: 'share', id: vid },
  ];
  if (coll && String(coll).startsWith('p')) {
    items.push({ text: 'Remove from playlist', action: 'remove-from-playlist', icon: 'close', id: vid, coll });
  }
  contextMenu(e, items);
}

// Any artwork that fails (deleted video, throttled proxy, offline) becomes the
// same waveform placeholder a missing cover renders. Pointing the <img> at a
// transparent pixel is what removes the browser's broken-image glyph; the
// element keeps its class list, so size, radius and mask are unchanged.
const BLANK_ART = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
document.addEventListener('error', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLImageElement) || el.dataset.fallback === '1') return;
  el.dataset.fallback = '1';
  el.classList.add('is-broken');
  el.removeAttribute('srcset');
  el.src = BLANK_ART;
}, true);

document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest?.('.track-row[data-track]');
  if (!row) return;
  e.preventDefault();
  openTrackMenu(row, e);
});

let pressTimer = null;
let pressStart = null;
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest?.('.track-row[data-track]');
  if (!row || e.pointerType === 'mouse') return;
  pressStart = { x: e.clientX, y: e.clientY, row };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!pressStart) return;
    row.dataset.longPress = '1';
    openTrackMenu(row, { clientX: pressStart.x, clientY: pressStart.y });
    pressStart = null;
  }, 520);
});
document.addEventListener('pointermove', (e) => {
  if (!pressStart) return;
  if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) {
    pressStart = null;
    clearTimeout(pressTimer);
  }
});
document.addEventListener('pointerup', () => { pressStart = null; clearTimeout(pressTimer); });
document.addEventListener('pointercancel', () => { pressStart = null; clearTimeout(pressTimer); });

// ── listen together (the surface) ───────────────────────────────────────
// The playhead and the clock live in public/rooms.js; this is what people see.
// Two rules shape it:
//   * "Synced" is a measurement, not a promise — the badge shows the actual
//     local-vs-room drift, because a label that is always green is worthless.
//   * The room page is rebuilt only when its composition changes (track, queue,
//     policy). Progress, sync and the roster are patched in place, so neither a
//     command from someone else nor somebody joining steals the invite field out
//     from under the host.

const initialOf = (name) => String(name ?? '?').trim().charAt(0).toUpperCase() || '?';

function onlineCount() {
  const list = state.roomMembers.length ? state.roomMembers : (state.room?.members ?? []);
  const online = list.filter((m) => m.online).length;
  const guests = Number.isFinite(state.roomGuests) && state.roomGuests > 0
    ? state.roomGuests : (state.room?.guests ?? 0);
  const total = online + guests;
  return total || (rooms.active ? 1 : 0);
}

function roomSyncLabel() {
  const s = state.roomStatus;
  if (s === 'polling') return 'Live · polling';
  if (s !== 'live') {
    return ({
      idle: 'Not connected', connecting: 'Connecting…', error: 'Connection problem',
      ended: 'Ended', private: 'Invite only',
    })[s] ?? '';
  }
  if (state.room && !state.room.playing) return 'Paused';
  const d = Math.abs(state.roomDriftMs);
  if (d < 150) return 'Synced';
  if (d < 1000) return `Syncing · ${(d / 1000).toFixed(1)}s`;
  return `Out of sync · ${(d / 1000).toFixed(1)}s`;
}

function roomSyncState() {
  if (state.roomStatus !== 'live' && state.roomStatus !== 'polling') return 'idle';
  if (state.room && !state.room.playing) return 'idle';
  const d = Math.abs(state.roomDriftMs);
  if (d < 150) return 'good';
  if (d < 1000) return 'warn';
  return 'bad';
}

/** Cheap live patches: the drift badge and the listener count. */
function patchRoomSync() {
  const el = document.querySelector('[data-room-sync]');
  if (el) {
    el.dataset.roomSync = roomSyncState();
    el.textContent = roomSyncLabel();
  }
  const online = document.querySelector('[data-room-online]');
  if (online) online.textContent = String(onlineCount());
  updateRoomPill();
}

function updateRoomPill() {
  const el = $('room-pill');
  if (!el) return;
  const active = rooms.active;
  el.hidden = !active;
  if (!active) return;
  const n = onlineCount();
  const label = el.querySelector('.room-pill-text');
  if (label) label.textContent = `${n} listening`;
  el.dataset.state = roomSyncState();
  el.classList.toggle('is-warn', state.roomStatus === 'error');
  el.setAttribute('aria-label', `Listen together — ${n} listening. Open the room.`);
}

let roomSig = '';
function roomSignature() {
  const r = state.room;
  if (!r) return `none:${state.roomStatus}`;
  // What has to be rebuilt, not what merely has to be right. The roster
  // (member list, online flags, guest count) is deliberately absent: presence is
  // the SSE connection, so it changes whenever anyone joins, leaves or locks
  // their phone — often several times a minute — and rebuilding #page-root for
  // that threw away the host's half-typed invite name and their cursor. Those
  // are patched in place by patchRoomRoster() instead. Track, queue and policy
  // changes stay here: they move the layout.
  return [
    r.code, r.ended ? 'ended' : '', r.joined ? 'in' : 'out', state.roomStatus,
    r.private ? 'locked' : '', r.track?.videoId ?? '', r.queue?.length ?? 0, r.index ?? 0,
    r.visibility ?? '', r.control ?? '', r.host?.id ?? '',
    (state.roomInvites ?? []).length,
    (state.roomPeople ?? []).map((p) => `${p.id}${p.member ? 'm' : p.invited ? 'i' : ''}`).join(','),
  ].join('|');
}

/** The roster people, from the live member list when there is one. */
const roomRoster = () => (state.roomMembers.length ? state.roomMembers : (state.room?.members ?? []));
const roomRosterGuests = () => (Number.isFinite(state.roomGuests) && state.roomGuests > 0
  ? state.roomGuests : (state.room?.guests ?? 0));

let roomRosterSig = '';
const roomRosterSignature = () => `${roomRoster().map((m) => `${m.id}${m.online ? '*' : ''}`).join(',')}|${roomRosterGuests()}`;

/**
 * Patch the roster in place, the way patchRoomSync() patches the drift badge.
 *
 * A join, a leave, a phone locking: each of those is one chip and one number.
 * Rebuilding the page for it was the difference between "the room updated" and
 * "the name I was halfway through typing into Invite people just vanished".
 */
function patchRoomRoster() {
  const sig = roomRosterSignature();
  if (sig === roomRosterSig) return;
  roomRosterSig = sig;
  const people = roomRoster();
  const row = document.querySelector('.room-page [data-room-people-row]');
  if (row) row.innerHTML = roomPeopleRowHtml(people, roomRosterGuests());
  const count = document.querySelector('.room-page [data-room-people-count]');
  if (count) count.textContent = roomPeopleCount(people.length);
}

function paintRoom({ force = false } = {}) {
  if (state.page !== 'room') { roomSig = ''; roomRosterSig = ''; return; }
  const sig = roomSignature();
  if (force || sig !== roomSig) {
    roomSig = sig;
    render();
    // The rebuild just painted the roster as it is now; record that so the next
    // presence change is the only thing that rewrites the row again.
    roomRosterSig = roomRosterSignature();
    return;
  }
  patchRoomSync();
  patchRoomRoster();
}

const roomSkeleton = () => `<section class="room-page" aria-busy="true">
  <div class="room-hero sk-hero"></div>
  <div class="sk-rows">${Array.from({ length: 4 }, () => `<div class="sk-row"><div class="sk sk-cover sm"></div>
    <div class="sk-lines"><div class="sk sk-line w-70"></div><div class="sk sk-line w-35"></div></div></div>`).join('')}</div>
</section>`;

function roomGate({ locked = false, code = '', room = null }) {
  return `<section class="room-page room-gate">
    <div class="room-gate-eye">${locked ? icon('lock') : icon('headphones')}</div>
    <span class="eyebrow">Listen together</span>
    <h1>${locked ? 'A private listening room' : `${esc(room?.host?.name ?? 'Someone')}’s room`}</h1>
    <p>${locked
    ? esc(state.roomError ?? 'This room is invite-only. Ask the host to add you, then open the link again.')
    : 'Join to hear exactly what everyone else is hearing — the same track, the same second.'}</p>
    <div class="room-gate-actions">
      ${locked ? '' : `<button class="play-btn" data-action="room-join" data-id="${esc(code)}">${icon('headphones', 'sm')} Join room</button>`}
      <button class="secondary-btn" data-page="home">Back to music</button>
    </div>
    <p class="field-hint">Listening needs a sonora account on this instance.</p>
  </section>`;
}

function roomEndedPage() {
  return `<section class="room-page room-gate">
    ${emptyState({
      art: 'headphones',
      title: 'This room has ended',
      text: state.roomError ?? 'The host closed the room. Nothing was deleted from your library.',
      actions: `<button class="play-btn" data-action="room">${icon('plus', 'sm')} Start a new room</button>
        <button class="secondary-btn" data-page="home">Back to music</button>`,
    })}
  </section>`;
}

/**
 * One person in the room.
 *
 * `canPromote` adds the hand-over control, and is passed only from the room
 * sheet and only for the host looking at somebody else. It exists because a
 * `control: 'host'` room is unskippable, unpausable and unendable for everyone
 * but the host: without a way to give the seat away, a group whose host walked
 * off was stuck with the room until housekeeping deleted it.
 */
const roomPersonChip = (m, { canPromote = false } = {}) => `<span class="room-person${m.online ? ' is-online' : ''}${m.role === 'host' ? ' is-host' : ''}">
  <span class="room-avatar" aria-hidden="true">${esc(initialOf(m.name))}</span>
  <span class="room-person-name">${esc(m.name)}</span>
  ${m.role === 'host' ? '<span class="room-host-tag">HOST</span>' : ''}
  <span class="sr-only">${m.online ? 'listening now' : 'offline'}</span></span>${canPromote
  ? `<button type="button" class="room-promote" data-action="room-make-host" data-user="${esc(m.id)}">Make host</button>` : ''}`;

/**
 * The chips of "In the room", plus the anonymous listeners behind the code.
 *
 * Shared by the page and by `patchRoomRoster()` so the two can never disagree
 * about what a roster looks like.
 */
function roomPeopleRowHtml(people, guests) {
  return `${people.map(roomPersonChip).join('')}${guests > 0
    ? `<span class="room-person is-guest"><span class="room-avatar" aria-hidden="true">+${guests}</span><span class="room-person-name">listening as guests</span></span>` : ''}`;
}

const roomPeopleCount = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

function roomQueueRows(room) {
  const queue = room.queue ?? [];
  // Under host-only control a member's click would be a 403 and a confusing
  // toast; the row is still theirs to look at (and to add to), not to press.
  const locked = room.control === 'host' && room.host?.id !== state.user?.id;
  if (!queue.length) {
    return `<p class="room-empty">The queue is empty. Open a track’s menu and choose “Add to room queue”.</p>`;
  }
  return `<ol class="room-queue-list">${queue.map((x, i) => `
    <li class="room-queue-row${i === room.index ? ' is-current' : ''}${i < room.index ? ' is-past' : ''}${locked ? ' is-locked' : ''}">
      <button class="room-queue-btn" data-action="room-select" data-index="${i}"${locked ? ' disabled' : ''}
        aria-label="Play ${esc(x.title)}${i === room.index ? ' (now playing)' : ''}"
        ${locked ? `aria-describedby="room-locked-note"` : ''}>
        <span class="room-queue-num" aria-hidden="true">${i === room.index ? icon('wave', 'sm') : i + 1}</span>
        ${cover(null, 'cover sm', x.thumb)}
        <span class="room-queue-text"><strong>${esc(x.title)}</strong><span>${esc(x.channel ?? '')}</span></span>
        <span class="duration">${fmt(x.durationS)}</span></button>
      ${i === room.index || locked ? '' : `<button class="icon-btn room-queue-remove" data-action="room-queue-remove"
        data-video-id="${esc(x.videoId)}" data-index="${i}"
        aria-label="Remove ${esc(x.title)} from the queue">${icon('close', 'sm')}</button>`}
    </li>`).join('')}</ol>`;
}

function roomHostPanel(room) {
  const invites = state.roomInvites ?? room.invites ?? [];
  const people = state.roomPeople ?? [];
  return `<div class="room-host">
    <div class="room-section-head"><strong>Room settings</strong><span>Only you</span></div>
    <div class="room-setting">
      <div><strong>Who can join</strong><p>${room.visibility === 'private'
    ? 'Only people you invite' : 'Anyone signed in with the link'}</p></div>
      <div class="segmented" role="tablist" aria-label="Who can join">
        <button class="segment${room.visibility === 'public' ? ' is-active' : ''}" role="tab"
          aria-selected="${room.visibility === 'public'}" data-action="room-visibility" data-value="public">Public</button>
        <button class="segment${room.visibility === 'private' ? ' is-active' : ''}" role="tab"
          aria-selected="${room.visibility === 'private'}" data-action="room-visibility" data-value="private">Private</button>
      </div>
    </div>
    <div class="room-setting">
      <div><strong>Who controls playback</strong><p>${room.control === 'host'
    ? 'Only you can play, pause and skip' : 'Anyone in the room can'}</p></div>
      <div class="segmented" role="tablist" aria-label="Who controls playback">
        <button class="segment${room.control === 'everyone' ? ' is-active' : ''}" role="tab"
          aria-selected="${room.control === 'everyone'}" data-action="room-control" data-value="everyone">Everyone</button>
        <button class="segment${room.control === 'host' ? ' is-active' : ''}" role="tab"
          aria-selected="${room.control === 'host'}" data-action="room-control" data-value="host">Only me</button>
      </div>
    </div>
    ${room.visibility === 'private' ? `<div class="room-invite">
      <div class="room-section-head"><strong>Invite people</strong><span>They sign in, then join the link</span></div>
      <form id="room-invite-form" novalidate class="room-invite-form">
        <label class="sr-only" for="room-invite-name">Invite by name</label>
        <input id="room-invite-name" name="name" autocomplete="off" spellcheck="false" placeholder="Search a name">
        <button class="play-btn" type="submit">Invite</button>
      </form>
      <p class="field-error" id="room-invite-error" role="alert"></p>
      ${people.length ? `<div class="room-suggestions">${people.map((p) => `<button class="chip small${p.member ? ' is-done' : ''}"
        data-action="room-invite-user" data-id="${p.id}"${p.member ? ' disabled' : ''}>${p.member ? `${esc(p.name)} · in room` : p.invited ? `${esc(p.name)} · invited` : esc(p.name)}</button>`).join('')}</div>` : ''}
      ${invites.length ? `<ul class="room-invite-list">${invites.map((i) => `<li><span class="room-avatar" aria-hidden="true">${esc(initialOf(i.name))}</span>
        <span>${esc(i.name)}</span>
        <button class="icon-btn" data-action="room-uninvite" data-id="${i.id}" aria-label="Remove invite for ${esc(i.name)}">${icon('close', 'sm')}</button></li>`).join('')}</ul>`
    : '<p class="field-hint">Nobody is invited yet. Switch to Private to invite people.</p>'}
    </div>` : ''}
  </div>`;
}

function roomLivePage(room) {
  const t = room.track ?? current();
  const isHost = room.host?.id === state.user?.id;
  const people = state.roomMembers.length ? state.roomMembers : (room.members ?? []);
  const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t?.durationS || 0);
  const pos = rooms.positionMs / 1000;
  const percent = dur ? Math.min(100, (pos / dur) * 100) : 0;
  const playing = room.playing && !room.ended;
  const locked = room.control === 'host' && !isHost;
  return `<section class="room-page" data-room="${esc(room.code)}">
    <header class="room-head">
      <div class="room-head-copy">
        <span class="eyebrow">Listen together</span>
        <h1 class="room-title">${esc(room.host?.name ?? 'Someone')}’s room</h1>
        <div class="room-badges">
          <span class="room-badge">${room.visibility === 'private'
    ? `${icon('lock', 'xs')} Private` : `${icon('globe', 'xs')} Public`}</span>
          <span class="room-badge room-live"><i class="room-dot" aria-hidden="true"></i>
            <b data-room-online>${onlineCount()}</b>&nbsp;listening</span>
          <span class="room-badge room-sync" data-room-sync="${roomSyncState()}">${esc(roomSyncLabel())}</span>
          ${room.control === 'host' ? `<span class="room-badge">${icon('shield', 'xs')} Host controls</span>` : ''}
        </div>
      </div>
      <div class="room-actions">
        <button class="secondary-btn" data-action="room-copy">${icon('share', 'sm')} Copy link</button>
        <button class="secondary-btn" data-action="room-share"${navigator.share ? '' : ' hidden'}>Share…</button>
        <button class="secondary-btn" data-action="room-leave">Leave</button>
        ${isHost ? `<button class="secondary-btn danger" data-action="room-end">End room</button>` : ''}
      </div>
    </header>
    <div class="room-now">
      <div class="room-art">${cover(null, 'cover', t?.thumb, 'eager', true)}
        <span class="room-art-live${playing ? ' is-playing' : ''}"><i></i><i></i><i></i></span></div>
      <div class="room-now-body">
        <span class="eyebrow">${playing ? 'Playing now' : 'Paused'}</span>
        <h2 data-room-track>${esc(t?.title ?? 'Nothing playing yet')}</h2>
        <p class="room-byline">${esc(t?.channel ?? '')}</p>
        <div class="room-transport">${locked ? `<p class="room-locked" id="room-locked-note">${icon('lock', 'sm')} Only ${esc(room.host?.name ?? 'the host')} controls playback</p>` : `
          <button class="icon-btn" data-action="prev" aria-label="Previous track">${icon('prev')}</button>
          <button class="room-play" data-action="playpause" aria-label="${playing ? 'Pause' : 'Play'}">
            ${icon(playing ? 'pause' : 'play', 'fill')}</button>
          <button class="icon-btn" data-action="next" aria-label="Next track">${icon('next')}</button>`}</div>
        <div class="timebar room-timebar"><span class="elapsed">${fmt(pos)}</span>
          <input class="range" type="range" aria-label="Track progress" data-slider="progress"
            min="0" max="${Math.max(1, Math.floor(dur))}" value="${Math.floor(pos)}" style="--percent:${percent}%">
          <span class="duration">${fmt(dur)}</span></div>
      </div>
    </div>
    <div class="room-people">
      <div class="room-section-head"><strong>In the room</strong>
        <span data-room-people-count>${roomPeopleCount(people.length)}</span></div>
      <div class="room-people-row" data-room-people-row>${roomPeopleRowHtml(people, state.roomGuests ?? room.guests ?? 0)}</div>
    </div>
    <div class="room-queue">
      <div class="room-section-head"><strong>Up next</strong><span>${room.queue?.length ?? 0} tracks</span></div>
      ${roomQueueRows(room)}
    </div>
    ${isHost ? roomHostPanel(room) : ''}
  </section>`;
}

function roomPage() {
  const code = state.collection;
  const room = state.room?.code === code ? state.room : null;
  // Not connected and not trying to be: this is the moment after leaving, not
  // a page that failed to load. A skeleton here would never resolve.
  if (!room && state.roomStatus === 'idle') return roomEndedPage();
  if (!room) return roomSkeleton();
  // 'private' must be tested before 'ended': a snapshot can carry both (a
  // private room that was later ended), and the signed-in app polls its way
  // into 403 PRIVATE snapshots — the visitor must see the locked gate, not a
  // page that tells them the room is over (they cannot verify that).
  if (state.roomStatus === 'private' || room.private) return roomGate({ locked: true, code });
  if (state.roomStatus === 'ended' || room.ended) return roomEndedPage();
  if (!room.joined) return roomGate({ code, room });
  return roomLivePage(room);
}

async function openRoom(code) {
  if (!code) return;
  rememberRoom(code);
  // Idempotent: a create/join already opened the stream, and re-loading would
  // close and reopen it for no reason (and drop the revision we just got).
  if (rooms.room?.code === code && rooms.active) {
    state.roomMembers = rooms.members;
    state.roomInvites = rooms.room?.invites ?? state.roomInvites;
    if (state.page === 'room') paintRoom({ force: true });
    loadRoomPeople().catch(() => {});
    return;
  }
  state.roomPeople = [];
  state.roomInvites = [];
  await rooms.load(code);
  if (state.page === 'room') render();
  if (rooms.room?.joined) loadRoomPeople().catch(() => {});
}

async function loadRoomPeople() {
  if (!rooms.active) return;
  if (rooms.room?.host?.id !== state.user?.id) return;
  if (rooms.room?.visibility !== 'private') { state.roomPeople = []; return; }
  try {
    state.roomPeople = await rooms.people('');
    if (state.page === 'room') paintRoom();
  } catch {
    // A host-only field; a non-host never reaches here, and a transient failure
    // just leaves the free-text invite box (which still works).
  }
}

function roomCreateHtml() {
  const seed = state.pendingRoomSeed ?? current();
  return `<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <div class="form-body"><span class="eyebrow">Listen together</span><h2>Start a room</h2>
      <p class="form-desc">Everyone hears the same track at the same moment. Public rooms can be opened by anyone with the link — no account needed to listen.${seed
    ? ` It starts with <strong>${esc(seed.title ?? seed.videoId)}</strong>.` : ''}</p>
      <form id="room-create-form" novalidate>
        <fieldset class="room-choice"><legend>Who can join</legend>
          <label><input type="radio" name="visibility" value="public" checked>
            <span><strong>Anyone with the link</strong><small>No account needed to listen — the link is the invitation.</small></span></label>
          <label><input type="radio" name="visibility" value="private">
            <span><strong>Only people I invite</strong><small>They sign in first; the link alone will not let them in.</small></span></label>
        </fieldset>
        <fieldset class="room-choice"><legend>Who controls playback</legend>
          <label><input type="radio" name="control" value="everyone" checked>
            <span><strong>Everyone</strong><small>Anyone can play, pause and skip.</small></span></label>
          <label><input type="radio" name="control" value="host">
            <span><strong>Only me</strong><small>Others can still suggest songs.</small></span></label>
        </fieldset>
        <p class="field-error" id="room-create-error" role="alert"></p>
        <div class="form-actions"><button type="button" class="secondary-btn" data-action="close-form">Cancel</button>
          <button type="submit" class="play-btn">Start room</button></div>
      </form></div>`;
}

function roomSheetHtml(room) {
  const url = `${location.origin}${room.link ?? `/l/${room.code}`}`;
  const people = state.roomMembers.length ? state.roomMembers : (room.members ?? []);
  const iAmHost = room.host?.id === state.user?.id;
  return `<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <div class="form-body"><span class="eyebrow">Listening together</span>
      <h2>${esc(room.host?.name ?? 'Someone')}’s room</h2>
      <p class="form-desc"><span data-room-sync="${roomSyncState()}">${esc(roomSyncLabel())}</span>
        · <b data-room-online>${onlineCount()}</b> listening</p>
      <div class="room-people-row room-sheet-people">${people.map((m) => roomPersonChip(m, {
    canPromote: Boolean(iAmHost) && m.role !== 'host',
  })).join('')}</div>
      <div class="room-link-row"><input readonly value="${esc(url)}" aria-label="Room link">
        <button class="secondary-btn" data-action="room-copy">Copy</button></div>
      <div class="form-actions">
        <button class="secondary-btn" data-action="open-room-page" data-id="${esc(room.code)}">Open room</button>
        <button class="secondary-btn" data-action="room-leave">Leave</button>
        ${room.host?.id === state.user?.id ? `<button class="secondary-btn danger" data-action="room-end">End</button>` : ''}
      </div></div>`;
}

function openRoomSheet(trackId = null) {
  if (rooms.active && rooms.room?.joined) {
    openFormSheet(roomSheetHtml(rooms.room), { label: 'Listen together' });
    return;
  }
  state.pendingRoomSeed = trackId ? (trackIndex.get(trackId) ?? { videoId: trackId }) : null;
  if (!state.pendingRoomSeed && !current()) {
    notify('Play something first — a room needs a track to share.', 'info');
    return;
  }
  openFormSheet(roomCreateHtml(), { label: 'Start a room', focus: 'input[name="visibility"]' });
}

/** The 60-track window `/api/now` stores, so a long station is not truncated. */
function roomQueueWindow() {
  const start = Math.max(0, Math.min(state.index - 5, Math.max(0, state.queue.length - 60)));
  return { queue: state.queue.slice(start, start + 60), index: state.index - start };
}

async function createRoomFromForm(form) {
  const fd = new FormData(form);
  const visibility = String(fd.get('visibility') ?? 'public') === 'private' ? 'private' : 'public';
  const control = String(fd.get('control') ?? 'everyone') === 'host' ? 'host' : 'everyone';
  const error = $('room-create-error');
  const seed = state.pendingRoomSeed;
  let payload;
  if (seed) {
    payload = { queue: [completeTrack(seed)], index: 0, positionMs: 0, playing: true };
  } else {
    if (!current()) { if (error) error.textContent = 'Play something first — a room needs a track to share.'; return; }
    payload = {
      ...roomQueueWindow(),
      positionMs: Math.round((audio.currentTime || 0) * 1000),
      playing: !audio.paused,
    };
  }
  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); btn.innerHTML = `<span class="spinner"></span>Starting…`; }
  try {
    const snapshot = await rooms.create({ ...payload, visibility, control });
    state.pendingRoomSeed = null;
    closeFormSheet();
    notify('Room started — share the link', 'info');
    navigate('room', snapshot.code);
    loadRoomPeople().catch(() => {});
  } catch (err) {
    if (error) error.textContent = err.message;
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Start room'; }
  }
}

async function joinRoomFromUi(code) {
  if (!code) return;
  const snapshot = await rooms.join(code);
  if (!snapshot) return;
  notify('You are in — listening in sync', 'info');
  render();
  loadRoomPeople().catch(() => {});
}

async function leaveRoomFromUi() {
  rememberRoom(null);
  await rooms.leave();
  notify('Left the room', 'info');
  closeFormSheet();
  navigate('home');
}

function endRoomFromUi() {
  confirmSheet({
    title: 'End this room?',
    text: 'Everyone stops following you and the listening link stops working. Nothing is deleted from anyone’s library.',
    confirmLabel: 'End room',
    danger: true,
    action: async () => {
      await rooms.end();
      closeFormSheet();
      navigate('home');
    },
  });
}

async function copyRoomLink() {
  const code = rooms.room?.code ?? state.collection;
  if (!code) return;
  const url = `${location.origin}/l/${encodeURIComponent(code)}`;
  try {
    await navigator.clipboard.writeText(url);
    notify('Listening link copied', 'info');
  } catch {
    notify(`Link: ${url}`, 'info');
  }
}

async function shareRoomLink() {
  const code = rooms.room?.code ?? state.collection;
  if (!code) return;
  const url = `${location.origin}/l/${encodeURIComponent(code)}`;
  if (!navigator.share) { copyRoomLink(); return; }
  try {
    await navigator.share({ title: 'Listen together on sonora', url });
  } catch { /* dismissed */ }
}

async function setRoomVisibility(value) {
  if (!rooms.active) return;
  const snapshot = await rooms.update({ visibility: value });
  if (!snapshot) return;
  notify(value === 'private' ? 'Invite only from now on' : 'Anyone with the link can join', 'info');
  if (value === 'private') loadRoomPeople().catch(() => {});
}

async function setRoomControl(value) {
  if (!rooms.active) return;
  const snapshot = await rooms.update({ control: value });
  if (!snapshot) return;
  notify(value === 'host' ? 'Only you can control playback now' : 'Everyone can control playback', 'info');
}

async function inviteFromForm(form) {
  const name = String(new FormData(form).get('name') ?? '').trim();
  const error = $('room-invite-error');
  if (!name) { if (error) error.textContent = 'Type a name to invite.'; return; }
  try {
    const result = await rooms.invite(name);
    state.roomInvites = result.invites ?? [];
    if (state.room) state.room = { ...state.room, invites: state.roomInvites };
    form.reset();
    if (error) error.textContent = '';
    notify(`${name} can join now`);
    paintRoom({ force: true });
  } catch (err) {
    if (error) error.textContent = err.message;
  }
}

async function inviteUserById(id) {
  try {
    const result = await rooms.invite(null, id);
    state.roomInvites = result.invites ?? [];
    if (state.room) state.room = { ...state.room, invites: state.roomInvites };
    notify('Invite added');
    await loadRoomPeople();
    paintRoom({ force: true });
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function uninviteById(id) {
  try {
    const result = await rooms.uninvite(id);
    state.roomInvites = result.invites ?? [];
    if (state.room) state.room = { ...state.room, invites: state.roomInvites };
    notify('Invite removed', 'info');
    await loadRoomPeople();
    paintRoom({ force: true });
  } catch (err) {
    notify(err.message, 'error');
  }
}

/**
 * Load the room's track into the player without touching the personal session.
 * `pendingResumeMs` is a first guess at the shared position; the correction
 * loop owns the rest once the source has metadata.
 *
 * `roomApplying` is set for the duration: this write came *from* the room, so
 * the play helpers must not translate it back into a command (that would be an
 * infinite echo, and two devices could ping-pong the playhead forever).
 */
function loadRoomTrack(snapshot) {
  const track = snapshot.track;
  if (!track?.videoId) return;
  // A snapshot can land after the session died (the room's own polling and the
  // refresh timer both outlive the cookie for a beat). Loading the track would
  // set a source and start it under the sign-in form, and the only control that
  // could stop it is behind that form.
  if (!$('auth-overlay').hidden) return;
  state.roomApplying = true;
  try {
    rememberTracks(snapshot.queue ?? []);
    leaveStation();
    state.queue = (snapshot.queue ?? []).map(completeTrack);
    state.index = Math.max(0, Math.min(snapshot.index ?? 0, state.queue.length - 1));
    state.currentLyrics = null;
    state.manualSeek = false;
    state.lockSeek = false;
    state.lastTime = 0;
    state.sourceStarted = false;
    state.switching = true;
    state.ending = false;
    state.startedAt = null;
    state.pendingResumeMs = Math.max(0, Math.round(snapshot.positionMs ?? 0));
    state.playing = Boolean(snapshot.playing) && !snapshot.ended;
    state.home.featured = state.queue[state.index] ?? track;
    state.home.featuredPos = state.pendingResumeMs;
    claimAudioSession();
    audio.loop = true;
    audio.src = `/api/stream/${track.videoId}`;
    warmNext();
    if (state.playing) audio.play().catch(() => {});
    nowPlaying.sync({ metadata: true });
  } finally {
    state.roomApplying = false;
  }
  render();
  if (!$('now-overlay').hidden && state.overlayTab === 'lyrics') loadLyrics();
}

/**
 * The room follows what its people actually play.
 *
 * A room is not a separate library you have to remember to feed: starting a
 * playlist, an album, a station or a single track in the app is the moment the
 * room's queue becomes that. Only a *deliberate* play intent calls this (not
 * every render, not every next), so the queue is what someone chose rather than
 * whatever the player happened to have loaded.
 */
function roomFollow(context) {
  if (!rooms.active) return;
  const { queue, index = 0, positionMs = 0, playing = true } = context ?? {};
  if (!Array.isArray(queue) || !queue.length) return;
  // The window `/api/now` stores; a room is a shared playhead, not a library.
  const start = Math.max(0, Math.min(index, queue.length - 60));
  rooms.command('queue-set', {
    queue: queue.slice(start, start + 60).map(completeTrack),
    index: Math.max(0, Math.min(index - start, 59)),
    positionMs,
    playing,
  });
}

/**
 * The room this browser last had open, so a reload lands back in it.
 *
 * Kept in localStorage rather than on the server: it is a fact about this
 * browser's tabs ("where was I"), not about the account ("what am I hosting").
 */
function rememberRoom(code) {
  try {
    if (code) localStorage.setItem('sonora.room', JSON.stringify({ code, at: Date.now() }));
    else localStorage.removeItem('sonora.room');
  } catch { /* storage is optional */ }
}
function rememberedRoom() {
  try {
    const v = JSON.parse(localStorage.getItem('sonora.room') ?? 'null');
    if (!v?.code) return null;
    // A room older than the idle lifetime cannot still exist.
    if (Date.now() - (v.at ?? 0) > 24 * 3_600_000) return null;
    return v.code;
  } catch {
    return null;
  }
}


// ── the queue as one continuous stream ──────────────────────────────────
//
// Everything above assumes the page is awake at the end of a track. On a locked
// iPhone it is not: WebKit suspends the web process while the media process
// keeps playing, so `timeupdate` stops arriving, the loop wrap is never seen,
// and the queue stops at the end of the current song. The production log has
// it exactly (PLAN.md finding #6): the last save this app made was the
// `visibilitychange` one at the instant of locking, the track boundary 26 s
// later produced no /api/events `complete` and no next /api/stream request, and
// nothing else arrived all night.
//
// The only thing that crosses that boundary with no script running is a media
// resource that already contains the next tracks. So while the page is hidden
// the element plays `/api/queue-stream/:token` — the queue concatenated by the
// server into one fragmented MP4 — and it is handed back to the per-track
// player, at whatever the music actually reached, when the page is visible
// again. public/queue-stream.js owns the mapping; src/queue-stream.js owns the
// stream.
//
// Scope, deliberately:
//   * iOS only. Android and desktop keep the per-track handoff, which works
//     there: their hidden pages still deliver `timeupdate`, so swapping the
//     source again for no reason would only insert a gap.
//   * Not in a room. The room's playhead is the server's, and a locally
//     generated stream would fight every snapshot the room sends.
//   * Every queue mode otherwise: queue order, shuffle and repeat-one all get a
//     plan (public/queue-stream.js explains what each becomes). An earlier
//     version skipped shuffle and repeat-one, which left exactly the listeners
//     most likely to leave the phone locked with no protection at all.

const queueStreamDevice = freezesWhenHidden(deviceName);
/** Reported with every diagnostic, so a log line names the build that wrote it. */
const CLIENT_BUILD = 'queue-stream-14';
/** How long the stream gets to prove it is playing before the player reverts. */
const QUEUE_STREAM_HEALTH_MS = 4000;

/**
 * Tell the server what the hidden-playback path decided.
 *
 * A PWA on a locked phone has no remote console, and this feature is invisible
 * by nature: the plan is armed minutes before it is used, and the moment it
 * matters the page is not running. Without this, "it still does not work" is
 * unanswerable from the server (the previous round had to guess between three
 * explanations). Best-effort by construction: diagnostics must never interfere
 * with playback, so every failure here is swallowed.
 */
const clientReportAt = new Map();
function clientReport(event, detail = {}) {
  // The arming path runs on every track start; repeating the same verdict once
  // a minute is plenty to see what a device is doing, and keeps the log quiet.
  const key = `${event}:${detail.reason ?? detail.ok ?? ''}`;
  const now = Date.now();
  // A success (or a leave/error) is always worth seeing; a repeated *failure*
  // — the convergence below can retry every timeupdate — is not.
  const always = detail.ok === true || event === 'live-leave' || event === 'live-error';
  if (!always && now - (clientReportAt.get(key) ?? 0) < 60_000) return;
  clientReportAt.set(key, now);
  try {
    fetch('/api/client-report', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event,
        build: CLIENT_BUILD,
        device: deviceName,
        room: Boolean(rooms.active),
        shuffle: Boolean(state.shuffle),
        repeat: state.repeat,
        queue: state.queue.length,
        index: state.index,
        playing: Boolean(state.playing),
        ...detail,
      }),
    }).catch(() => {});
  } catch { /* never break playback for a diagnostic */ }
}

/**
 * Ask the server for a plan built from the queue as it is right now.
 *
 * Called from every track start, so the plan is already in hand when the phone
 * locks — the moment the page is hidden is the one moment there is no time for
 * a round trip. A failure is silent on purpose: the caller falls back to the
 * per-track player, which is exactly what the app did before this existed.
 */
async function armQueueStream() {
  // Not iOS: the per-track handoff works, so there is nothing to report.
  if (!queueStreamDevice) { state.queuePlan = null; return; }
  // This page already learned its engine cannot play the stream. Do not keep
  // swapping the listener's track out for silence.
  if (state.streamBlocked) { state.queuePlan = null; return; }
  if (rooms.active) { state.queuePlan = null; clientReport('live-skip', { reason: 'room' }); return; }
  const ids = planTrackIds({
    queue: state.queue, index: state.index, shuffle: state.shuffle, repeatOne: state.repeat === 2,
  });
  if (!ids.length) { state.queuePlan = null; clientReport('live-skip', { reason: 'no-queue' }); return; }
  // Already armed for this track: `playing` and `playIndex` both call this, and
  // a fresh plan for the same track buys nothing.
  if (state.queuePlan?.firstId === ids[0] && Date.now() - state.queuePlan.at < 30_000) return;
  // The previous plan is deliberately kept while this one is in flight: it is
  // still a timeline over the same queue, and the screen may lock in the
  // milliseconds before the answer arrives (which is exactly what happened on
  // the first device test after this shipped).
  const firstId = ids[0];
  try {
    const res = await fetch('/api/queue-stream/plan', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) { clientReport('live-plan', { ok: false, status: res.status, asked: ids.length }); return; }
    const plan = await res.json().catch(() => null);
    // The track may have moved on while the request was in flight; a plan whose
    // first track is not the one playing would start the wrong song.
    if (!plan?.token || !Array.isArray(plan.tracks) || !plan.tracks.length) {
      clientReport('live-plan', { ok: false, reason: 'empty', asked: ids.length });
      return;
    }
    if (state.streaming) return;
    state.queuePlan = { token: plan.token, tracks: plan.tracks, firstId, at: Date.now() };
    clientReport('live-plan', { ok: true, asked: ids.length, tracks: plan.tracks.length });
    // Armed while the page is already hidden (a track that started after the
    // screen locked): converge onto the stream now, while this page still runs.
    if (document.visibilityState === 'hidden') enterQueueStream();
  } catch (err) {
    // Offline, or a server that predates the endpoint.
    clientReport('live-plan', { ok: false, error: String(err?.name ?? err) });
  }
}

/**
 * Forget the armed queue-stream plan because the queue or the mode just changed.
 *
 * `planTrackIds` bakes the playback mode into the plan at arm time
 * (public/queue-stream.js): a repeat-one plan carries the current track alone,
 * a shuffle plan carries one particular random order. So a plan armed before a
 * shuffle/repeat toggle keeps describing an order the player is no longer
 * playing: repeat-one armed on a locked phone then loops one song all night,
 * shuffle turned on mid-track locks the old order in, and a removed row keeps
 * playing because the stream still contains it. Dropping the plan is what makes
 * the next enterQueueStream — or the hidden arm path, or the re-arm below —
 * rebuild it from the queue and mode as they are now.
 */
function invalidateQueuePlan() {
  state.queuePlan = null;
  // While the stream is live the plan is already committed to the element's
  // URL; there is nothing to arm until playback leaves the stream, and
  // enterQueueStream returns early while `streaming` is set anyway.
  if (state.streaming) return;
  // Re-arm now rather than at the next `playing`: the screen can lock between
  // this tap and the next track start, and the hidden convergence has no plan to
  // work with until one lands. armQueueStream itself is a no-op off-device, in a
  // room, or once the engine has refused the stream.
  if (document.visibilityState === 'visible' && !state.streamBlocked) void armQueueStream();
}

/**
 * Hand the element the whole queue. Called on the way into the background,
 * while the page is still running: from here on nothing has to run at a track
 * boundary for the music to continue.
 */
function enterQueueStream() {
  const plan = state.queuePlan;
  const t = current();
  if (state.streamBlocked) return false;
  if ((state.streamCooldownUntil ?? 0) > Date.now()) return false;
  if (state.streaming) return true;
  if (!plan) { clientReport('live-enter', { ok: false, reason: 'no-plan' }); return false; }
  if (!t?.videoId) { clientReport('live-enter', { ok: false, reason: 'no-track' }); return false; }
  if (!state.playing || audio.paused) {
    clientReport('live-enter', { ok: false, reason: audio.paused ? 'paused' : 'not-playing' });
    return false;
  }
  // The plan is a timeline over the queue, so the stream can start at the
  // current track's position *anywhere* in it — not only where it was armed.
  // That is what keeps this working when the lock lands between a track change
  // and the next plan.
  const offsetMs = Math.max(0, Math.round((Number(audio.currentTime) || 0) * 1000));
  const atMs = planOffsetFor(plan.tracks, t.videoId, offsetMs);
  if (atMs == null) {
    clientReport('live-enter', { ok: false, reason: 'not-in-plan', now: t.videoId });
    return false;
  }
  state.streaming = { token: plan.token, tracks: plan.tracks, startMs: atMs, videoId: t.videoId };
  state.streamLoadAt = Date.now();
  state.streamPlayedOnce = false;
  state.streamTrack = t.videoId;
  state.streamOffsetMs = offsetMs;
  state.streamDurationMs = Math.round((Number(t.durationS) || 0) * 1000);
  // The stream is the queue: the element must not loop it, and the wrap
  // detector that normally advances the queue has nothing to see in it.
  audio.loop = false;
  state.switching = true;
  state.manualSeek = false;
  state.lockSeek = false;
  state.sourceStarted = false;
  state.lastTime = 0;
  // Same rule as a hidden track swap in playIndex: this is the moment the
  // web-process category cache and a fresh GPU-side session are most likely to
  // disagree, so force the pair through before the new source is assigned.
  repairAudioSession({ force: true });
  state.streamSeekNonce = (state.streamSeekNonce ?? 0) + 1;
  audio.src = streamSrc(plan.token, atMs, state.streamSeekNonce);
  // No pause first: on a locked phone a pause is where iOS takes the audio
  // session away (public/playback.js). This is the same playing → src → play
  // transition a lock-screen "next" makes.
  audio.play().catch((err) => {
    clientReport('live-enter', { ok: false, reason: 'play-rejected', error: String(err?.name ?? err) });
    // An interruption (another app grabbing the audio output — Discord, a call,
    // Siri) rejects this play() and leaves the element paused. `switching` must
    // not stay armed: the pause handler treats an armed swap as "not the
    // listener" and so refuses to record that a resume is owed, and a paused
    // element fires no `timeupdate`, so nothing would ever retry. Measured:
    // switching apps ended the stream and the music never came back.
    if (err?.name === 'AbortError' || err?.name === 'NotAllowedError') {
      state.switching = false;
      if (document.visibilityState === 'hidden' && !state.userPause) {
        state.resumeOnVisible = true;
      }
      return;
    }
    if (err?.name === 'NotSupportedError') {
      // The engine will not play this stream at all. Count it like any other
      // failure (two in a row gives up), and hand playback back right here:
      // this rejection can arrive without the element's own `error` event, and
      // an element left pointing at an unsupported source is simply silent.
      state.streamFails = (state.streamFails ?? 0) + 1;
      if (state.streamFails >= 2) {
        state.streamBlocked = true;
        clientReport('live-blocked', { reason: 'not-supported', fails: state.streamFails });
      } else {
        state.streamCooldownUntil = Date.now() + 15_000;
      }
      state.queuePlan = null;
      leaveQueueStream();
    }
  });
  nowPlaying.sync({ force: true });
  state.streamFails = 0;
  clientReport('live-enter', { ok: true, atMs, tracks: plan.tracks.length, src: audio.src.slice(0, 80) });
  // The stream has to *prove* it plays. WebKit can accept a source and then
  // never decode it, and the listener is usually already gone by the time that
  // would show up — silently, with the Now Playing widget empty. A couple of
  // seconds of watching, while the page is still awake, is the only chance to
  // tell the difference; if it is not playing, hand playback back to the
  // per-track element (which at worst keeps the current song going) and say so.
  clearTimeout(state.streamWatch);
  const watching = plan.token;
  state.streamWatch = setTimeout(() => {
    if (!state.streaming || state.streaming.token !== watching) return;
    // Never judge a hidden page. iOS suspends the web process: timers fire
    // late and the element's JS-visible readyState/currentTime are frozen at
    // their lock-time values, so a check that runs here always reads
    // "stalled" — and reverts a stream the media process is playing fine
    // (measured: segments kept arriving for 20 s, then a late timer killed
    // it). The check exists to catch a dead swap while the page is awake.
    if (document.visibilityState === 'hidden') return;
    // A stream that has played at all is not stalled, whatever it reads now.
    if (state.streamPlayedOnce) return;
    // HAVE_FUTURE_DATA means the element has enough to keep playing; a small
    // non-zero playhead is the same proof from the other side.
    const ok = !audio.paused && !audio.error && (audio.readyState >= 3 || audio.currentTime > 0.2);
    if (ok) return;
    clientReport('live-stalled', {
      readyState: audio.readyState, paused: audio.paused,
      error: audio.error?.code ?? null, time: Number(audio.currentTime) || 0,
    });
    state.queuePlan = null;
    leaveQueueStream();
  }, QUEUE_STREAM_HEALTH_MS);
  return true;
}

/**
 * Hand playback back to the per-track player, at the position the music
 * actually reached. `offsetMs` overrides that position (a seek: the bar the
 * listener dragged was the mapped track's, so the target is a track offset).
 */
function leaveQueueStream({ offsetMs = null } = {}) {
  const live = state.streaming;
  if (!live) return false;
  clearTimeout(state.streamWatch);
  state.streamWatch = null;
  // Clamped by the same wall-clock ceiling as the playhead mapping: leaving on
  // a bogus reading used to resume the per-track player minutes into a track
  // the listener had never reached.
  const elapsedSec = streamElapsedSeconds();
  const elapsed = Math.max(0, Math.round((elapsedSec ?? 0) * 1000));
  const mapped = elapsedSec === null ? null : locate(live.tracks, live.startMs + elapsed);
  // The server keeps a session (and an ffmpeg tail) per plan token until it
  // goes idle; a client that leaves and re-enters with fresh plans would stack
  // them into the per-user cap and get 429s. Closing on the way out is one
  // keepalive fetch, and it is the difference between "skip works" and "the
  // fourth skip kills the stream".
  try {
    fetch(streamSrc(live.token, 0), { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
  } catch { /* leaving must never throw */ }
  state.streaming = null;
  state.streamTrack = null;
  state.streamOffsetMs = 0;
  state.streamDurationMs = 0;
  audio.loop = true;
  const target = mapped ?? { videoId: live.videoId, offsetMs: 0 };
  const index = state.queue.findIndex((x) => x.videoId === target.videoId);
  const resumeMs = offsetMs == null ? target.offsetMs : Math.max(0, Math.round(Number(offsetMs) || 0));
  clientReport('live-leave', {
    elapsedMs: elapsed, track: target.videoId, index, offsetMs: resumeMs,
    found: index >= 0, seekOverride: offsetMs != null,
  });
  // A resume into a track is a deliberate seek: without these the swap looks
  // exactly like a loop wrap and the queue would advance twice.
  state.manualSeek = false;
  state.lockSeek = false;
  state.sourceStarted = false;
  state.lastTime = 0;
  playIndex(index >= 0 ? index : state.index, { resumeMs });
  return true;
}

/**
 * Keep the player honest while the queue stream plays.
 *
 * Usually the page is frozen and this never runs. When it does — an unlock that
 * has not happened yet, a desktop-sized viewport, a background tab on another
 * engine — the mapped track is the truth: move `state.index` to it, name it on
 * the lock screen, and let the bar draw the track's own progress rather than
 * three hours of stream.
 */
/**
 * How long the current stream load has been running, in seconds of wall clock.
 *
 * The element's clock can only ever advance as fast as real time, so this is a
 * hard ceiling on any `currentTime` reading. An engine that reports the raw
 * segment PTS instead of elapsed-since-load (WebKit did, while the segments
 * were stamped with absolute plan positions) reads as minutes of playback in
 * the first second — and the client then "maps" that to a track the listener
 * is nowhere near, walking the playhead further off on every cycle until the
 * element runs past its window and ends. Measured on the device: the mapped
 * position compounding 152 s -> 999 s -> 5376 s across three re-entries.
 */
function streamWallSeconds() {
  const at = Number(state.streamLoadAt) || 0;
  return at > 0 ? Math.max(0, (Date.now() - at) / 1000) : 0;
}

/**
 * The stream's elapsed seconds, or null when the reading is impossible.
 *
 * `SLACK_S` covers a buffered element running slightly ahead of the wall clock
 * plus timer slop; anything beyond that is a bogus reading, not playback.
 */
const STREAM_CLOCK_SLACK_S = 30;
function streamElapsedSeconds() {
  const ct = Number(audio.currentTime) || 0;
  if (!(ct >= 0)) return null;
  const wall = streamWallSeconds();
  if (wall > 0 && ct > wall + STREAM_CLOCK_SLACK_S) {
    clientReport('live-skew', { time: +ct.toFixed(2), wall: +wall.toFixed(2) });
    return null;
  }
  return ct;
}

function applyStreamPosition() {
  const live = state.streaming;
  if (!live) return false;
  const elapsed = streamElapsedSeconds();
  // An impossible clock reading is ignored rather than believed: mapping it
  // would move `state.index` to a track nobody is hearing and re-arm the plan
  // from there, which is how one bad reading became three.
  if (elapsed === null) return true;
  if (elapsed > 0.5) state.streamPlayedOnce = true;
  const at = locate(live.tracks, live.startMs + Math.round(elapsed * 1000));
  if (!at) return true;
  state.streamDurationMs = Number(live.tracks[at.index]?.durationMs) || 0;
  if (at.videoId && at.videoId !== state.streamTrack) {
    // A track finished inside the stream. Log it as played through — at its own
    // end, which is where the listener heard it finish — before the playhead
    // moves to the new one.
    state.streamOffsetMs = Math.max(0, Math.round((Number(current()?.durationS) || 0) * 1000)) || state.streamOffsetMs;
    log('complete');
    state.streamTrack = at.videoId;
    const index = state.queue.findIndex((x) => x.videoId === at.videoId);
    if (index >= 0) state.index = index;
    state.playing = true;
    state.streamOffsetMs = at.offsetMs;
    log('start');
    nowPlaying.sync({ metadata: true, force: true });
    announceNowPlaying(current());
    warmNext();
    maybeExtendStation();
    updatePlayer();
  } else {
    state.streamOffsetMs = at.offsetMs;
  }
  return true;
}

// ── iOS audio session plumbing ──────────────────────────────────────────
/**
 * A deliberate seek. Marking it is what keeps the loop-wrap detector from
 * treating "previous", a keyboard jump, or a resume as the end of a track.
 * `lockSeek` is consumed by the `seeking` handler after the wrap test, so the
 * guard cannot outlive its seek.
 */
function seekTo(seconds) {
  const to = Math.max(0, Number(seconds) || 0);
  // While the queue stream plays, a seek is a track offset *inside the plan*:
  // the element gets the same session at a new position. Leaving the stream
  // and re-entering instead loses the seek — the re-entry reads the element's
  // clock before the per-track resume has landed, and a suspended page (a
  // locked phone after its grace period) never gets to finish the hand-back
  // at all.
  if (state.streaming) { seekStreamTo(to); return; }
  state.pendingResumeMs = 0;
  state.manualSeek = true;
  state.lockSeek = true;
  state.lastTime = to;
  audio.currentTime = to;
}

/**
 * Move the playhead inside the live queue stream.
 *
 * Same session, same plan, new position: `streamSrc(token, at, k)` with a fresh
 * `k` tells the server to slide its playlist window to `at` (the window
 * otherwise follows what the listener consumes), and the element restarts from
 * the segment that holds the target. No leave/re-enter round trip, so nothing
 * can read a stale clock in between.
 */
function seekStreamTo(seconds) {
  const live = state.streaming;
  const t = current();
  const offsetMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const atMs = planOffsetFor(live.tracks, t?.videoId, offsetMs);
  if (atMs == null || !t) {
    // The track is not in this plan (a station that regenerated, say): fall
    // back to the per-track player, which can always seek its own file.
    leaveQueueStream({ offsetMs });
    return;
  }
  state.streamSeekNonce = (state.streamSeekNonce ?? 0) + 1;
  state.manualSeek = true;
  state.lockSeek = true;
  state.lastTime = 0;
  // The element's clock restarts at zero on the new source, and it is at `atMs`
  // in the plan: that pair is the mapping applyStreamPosition reads.
  live.startMs = atMs;
  state.streamLoadAt = Date.now();
  state.streamTrack = t.videoId;
  state.streamOffsetMs = offsetMs;
  state.streamDurationMs = Math.round((Number(t.durationS) || 0) * 1000);
  state.streamPlayedOnce = false;
  repairAudioSession({ force: true });
  audio.src = streamSrc(live.token, atMs, state.streamSeekNonce);
  audio.play().catch(() => {});
  nowPlaying.sync({ force: true });
  updatePlayer();
  clientReport('live-seek', { atMs, offsetMs, k: state.streamSeekNonce });
}

audio.loop = true;
audio.volume = state.volume;
audio.muted = state.muted;
bindSheetSwipe();

// boot() runs once at the very end of this module (after `nowPlaying` exists).
// Calling it here as well made every boot request, render and session restore
// happen twice.

// The lock screen is its own renderer: it needs metadata, an artwork URL it is
// allowed to fetch, and an explicit position state before it will draw a seek
// bar. All three live in media-session.js so they can be tested.
const nowPlaying = createMediaSession({
  audio,
  base: location.href,
  getTrack: () => current(),
  // The lock screen draws the *track* the listener is on, not the queue stream
  // the element happens to be playing (see playerPosition/playerDuration).
  clock: { position: playerPosition, duration: playerDuration },
  // Preload the art so the lock screen never has to do a cold fetch.
  warmArtwork: (src) => { const img = new Image(); img.src = src; },
  handlers: {
    play: () => {
      claimAudioSession();
      state.userPause = false;
      if (rooms.active) { rooms.command('play'); return; }
      claimSession();
      audio.play().catch(() => {});
    },
    pause: () => {
      // This is a person pressing pause on the lock screen: unlike an
      // interruption, it must not be undone when the page becomes visible.
      state.userPause = true;
      state.resumeOnVisible = false;
      state.resumeWanted = false;
      if (rooms.active) {
        rooms.command('pause', { positionMs: Math.round((audio.currentTime || 0) * 1000) });
        return;
      }
      // A deliberate pause ends any swap in flight, exactly as the transport's
      // own pause button does: leaving the marker armed would keep the media
      // widget saying `playing` over a paused track, and would make the paused
      // save below look like a source swap and skip it.
      state.switching = false;
      audio.pause();
    },
    /**
     * The OS's own stop (a car head unit, a Bluetooth long-press, Android's
     * "stop" on the notification). Unlike pause this ends the session, so it is
     * the one action that must also take the Now Playing widget away instead of
     * leaving it claiming a live player over silence — the same lie the failure
     * cap told before `stopped()` existed.
     */
    stop: () => {
      // The listener's decision in both directions: nothing may resume it when
      // the page comes back, and nothing may retry it.
      state.userPause = true;
      state.resumeOnVisible = false;
      state.resumeWanted = false;
      state.resumeAttempts = 0;
      state.switching = false;
      state.playing = false;
      // Deliberately not leaveQueueStream(): that hands playback back to the
      // per-track element at the mapped position, which is a resume, not a stop.
      // Tear the stream bookkeeping down here instead, and restore the loop flag
      // the stream had to clear (enterQueueStream): a per-track source loops.
      clearTimeout(state.streamWatch);
      state.streamWatch = null;
      state.streaming = null;
      state.streamTrack = null;
      state.streamOffsetMs = 0;
      state.streamDurationMs = 0;
      state.queuePlan = null;
      audio.loop = true;
      audio.pause();
      nowPlaying.stopped();
      updatePlayer();
    },
    previoustrack: () => {
      if (rooms.active) {
        // Same rule as the button: a deliberate restart of the shared track, or
        // the previous track for everybody.
        if (audio.currentTime > 3) rooms.command('seek', { positionMs: 0 });
        else rooms.command('prev');
        return;
      }
      claimSession();
      if (playerPosition() > 3) seekTo(0);
      // At the top of a track, "previous" must stay inside the queue stream.
      // `nextTrack({ back: true })` leaves the stream and cold-loads a per-track
      // source, which is the one transition a hidden page may not survive: the
      // page is usually frozen, so nothing starts the new source and the music
      // stops until the app is opened. Restart the streamed track instead —
      // same session, same plan, a seek to its own beginning.
      else if (state.streaming) seekStreamTo(0);
      else nextTrack({ back: true, userInitiated: true });
    },
    nexttrack: () => {
      if (rooms.active) { rooms.command('next'); return; }
      nextTrack({ userInitiated: true });
    },
  },
  hooks: {
    // Dragging the lock-screen bar must not look like the seek-to-zero wrap
    // that advances the queue. The flag is one-shot: the `seeking` handler
    // consumes it, so a stale flag can never disarm the wrap that advances
    // the queue at the end of a track.
    onSeekStart: () => { state.pendingResumeMs = 0; state.manualSeek = true; state.lockSeek = true; },
    // The lock screen's scrubber describes the mapped track while the queue
    // stream plays, so that seek has to leave the stream and land in the track.
    // Returning true means this callback already moved playback.
    onSeek: (seconds) => {
      if (!state.streaming) return false;
      seekStreamTo(seconds);
      return true;
    },
    onSeekEnd: () => { state.lastTime = playerPosition(); updatePlayer(); },
    // The `pause` a src swap emits is not a listener pause, so the lock screen
    // must not be told playback stopped — see media-session.js `sync`. A pause
    // the listener made *during* a swap is still theirs, which is the same rule
    // the transport uses two lines into the `pause` handler below.
    isSwitching: () => state.switching && !state.userPause,
  },
});

/**
 * The track ended. Called from both `seeking` and `timeupdate` because WebKit
 * on a locked iPhone can report the loop jump through only one of them; the
 * guard makes the pair idempotent, so one wrap can never skip two tracks.
 */
function endTrack() {
  // While the queue stream plays there is no per-track boundary to react to:
  // the boundary is inside the server's stream, and advancing the queue here
  // would swap the source out from under a page that is (usually) frozen.
  if (state.streaming) return;
  // In a room, `ending` stays armed as the wrap guard (the still-looping
  // element re-detects the wrap on every timeupdate); the roomNextAt cool-down
  // is what retries a failed auto-next, slowly, instead of on every wrap.
  if (rooms.active) {
    if (Date.now() - (state.roomNextAt ?? 0) < ROOM_AUTO_NEXT_COOLDOWN_MS) return;
  } else if (state.ending) return;
  // A retry inside the same room wrap must not log another 'complete' — the
  // station counts those as played-through seeds — and the non-room path
  // logs exactly once per wrap.
  if (!state.ending) log('complete');
  state.ending = true;
  if (rooms.active) {
    // The room decides what plays next. This is a natural continuation, which
    // any member may trigger, so a host with a locked phone cannot freeze the
    // group on the last second of a track.
    // Transport truth: the element is still audibly looping the finished
    // track until the room's snapshot lands (loadRoomTrack reads the
    // snapshot's own playing state), so `playing` must keep saying so —
    // painting a pause here would make the bar, the lock screen and the room
    // pill lie for the whole round trip, and pausing the element is what
    // surrenders the iOS audio session on a locked phone.
    state.roomNextAt = Date.now();
    rooms.command('next', { auto: true });
    return;
  }
  if (state.repeat === 2) {
    state.lastTime = 0;
    audio.currentTime = 0;
    state.ending = false;
    audio.play().catch(() => {});
    return;
  }
  // Switch inside this event, not in a timer — background timers are delayed.
  // While the page is hidden the old source is deliberately *not* paused: a
  // pause on a backgrounded phone is where iOS drops the audio session, and the
  // next track then plays into a dead session (silent, with an emptying Now
  // Playing widget) until the listener returns to the app. `handoffTrack`
  // carries the whole argument, including why the manual "next" path — which
  // never pauses — is the behaviour to match.
  handoffTrack({
    pause: () => audio.pause(),
    next: nextTrack,
    background: document.visibilityState === 'hidden',
  });
}

/** One room auto-next per wrap retry: failed commands are re-sent, slowly. */
const ROOM_AUTO_NEXT_COOLDOWN_MS = 3000;

// Belt and braces: with `loop` on, `ended` should never fire, and on iOS it
// must not (a natural end closes the audio session). If an engine still emits
// it, advancing here is better than stopping on the last second of a track.
// `switching` filters a stale `ended` that arrives while the next source loads.
// A stream that ends at all has failed (it repeats for a day), so the honest
// answer there is to rejoin the per-track player instead of ending the queue.
audio.addEventListener('ended', () => {
  if (state.streaming) { leaveQueueStream(); return; }
  if (!state.switching) endTrack();
});

audio.addEventListener('seeking', () => {
  if (state.streaming) return;
  const wrap = isLoopWrap(state.lastTime, audio.currentTime, {
    manualSeek: state.manualSeek, started: state.sourceStarted,
  });
  // Consume the lock-screen seek flag here, after the wrap test but not in a
  // timer: background timers are delayed, and a flag that outlives its seek
  // would stop the queue advancing at the end of every track.
  if (state.lockSeek) { state.lockSeek = false; state.manualSeek = false; }
  if (!wrap) return;
  endTrack();
});

audio.addEventListener('timeupdate', () => {
  // While the queue stream plays, the element's clock is a position in the plan
  // rather than in a track: map it back to the track and offset first, then the
  // rest of this handler paints the same way it always does.
  if (!state.streaming && document.visibilityState === 'hidden' && state.playing && !audio.paused) {
    // The screen is locked but this page is still running (iOS gives a locked
    // audio page a grace period before suspending it). Converge onto the queue
    // stream now: a plan may have arrived after the transition, or the track
    // under the playhead may have changed since the plan was armed. With no
    // plan at all, ask for one — nothing else re-arms while hidden, and the
    // device log showed exactly that window staying open for minutes.
    if (!state.queuePlan && !state.streamBlocked) void armQueueStream();
    enterQueueStream();
  }
  if (state.streaming) {
    applyStreamPosition();
  } else if (isLoopWrap(state.lastTime, audio.currentTime, {
    // Some engines — WebKit on a locked iPhone is the one that matters — loop
    // without emitting `seeking`. The jump is still visible here, and this is
    // the only chance to advance the queue before the same song repeats forever.
    // Test before lastTime is overwritten and before the seek flag is cleared,
    // so a deliberate seek to 0 is still not mistaken for the end.
    manualSeek: state.manualSeek, started: state.sourceStarted,
  })) {
    endTrack();
    return;
  }
  if (!state.streaming) {
    // Safety net for a lock-screen seek that never moved the playhead (no
    // `seeking` event fires then): by the time timeupdate runs, any seek that
    // did happen has already been consumed above.
    if (state.lockSeek) { state.lockSeek = false; state.manualSeek = false; }
    if (!state.manualSeek) state.lastTime = audio.currentTime;
  }
  const pos = playerPosition();
  const dur = playerDuration();
  // Keeps the lock-screen scrubber honest while it is visible. Throttled
  // inside the module; this is a no-op when paused.
  if (state.playing) nowPlaying.position();
  // Scoped, not document-wide. This runs four times a second for the whole
  // session, and `querySelectorAll` over the document allocated two NodeLists
  // and walked every node in the player bar, the whole page and both overlays
  // for a scrubber that only exists in three places: the player bar, the
  // expanded sheet, and the room page's own timebar. `#page-root` is searched
  // only while the room page is up — it is the one page with a playhead of its
  // own, and the only other page-level list is tracks, which has no slider.
  const surfaces = [$('player')];
  if (!$('now-overlay').hidden) surfaces.push($('now-content'));
  if (state.page === 'room') surfaces.push($('page-root'));
  for (const root of surfaces) {
    if (!root) continue;
    for (const x of root.querySelectorAll('input[data-slider="progress"]')) {
      if (document.activeElement === x) continue;
      x.value = String(Math.floor(pos));
      if (dur) x.style.setProperty('--percent', `${(pos / dur) * 100}%`);
    }
    for (const x of root.querySelectorAll('.elapsed')) x.textContent = fmt(pos);
  }
  // Composited, not a custom-property write: see paintPlayerProgress.
  paintPlayerProgress(pos, dur);
  if (state.playing && current()) saveSession();
});

audio.addEventListener('loadedmetadata', () => {
  // Duration is finally known: this is the first safe moment to honour a saved
  // playhead, and on some engines it arrives after `playing`.
  applyPendingResume();
  nowPlaying.sync({ metadata: true, force: true });
});
audio.addEventListener('durationchange', () => nowPlaying.sync({ force: true }));

// The playhead landed. Refresh the lock-screen bar and resume tracking the
// position for the wrap detector (a slider drag clears its own flag on
// `change`; a lock-screen seek was already cleared by `seeking`).
audio.addEventListener('seeked', () => {
  if (state.lockSeek) {
    state.lockSeek = false;
    state.manualSeek = false;
  }
  state.lastTime = audio.currentTime;
  nowPlaying.sync({ force: true });
});

audio.addEventListener('playing', () => {
  state.playing = true;
  // Playback can start without `playIndex` (resuming a restored session, an
  // interrupted session coming back): arm the hidden-playback plan here too,
  // because the plan has to exist before the screen locks, not after.
  if (!state.streaming) void armQueueStream();
  // Hidden already (a track that started while the screen was locked): this is
  // the moment to get onto the stream, while the page is still running.
  //
  // A swap this call arms must not be disarmed by this same handler: the `pause`
  // that a `src` assignment queues arrives *after* it, and clearing the flag
  // here made that pause look like a listener pause — the lock screen went
  // `paused` for the whole cold load, a false paused save reached /api/now, and
  // the resume watchdog raced the stream's own play. Leave it to the code that
  // knows when the swap settled: the stream's `playing` (below, next event),
  // its `pause`, or enterQueueStream's own rejection path. `!state.streaming` is
  // read first because enterQueueStream also answers `true` for "already
  // streaming" — and that case *is* the settled swap, which must clear it.
  const enteredStream = document.visibilityState === 'hidden'
    && !state.streaming && enterQueueStream();
  state.failures = 0;
  state.sourceStarted = true;
  if (!enteredStream) state.switching = false;
  state.ending = false;
  state.hasPlayed = true;
  claimAudioSession();
  if (state.startedAt == null) {
    state.startedAt = Date.now();
    log('start');
  }
  if (state.pendingResumeMs > 0 && audio.duration) {
    applyPendingResume();
  }
  const ms = navigator.mediaSession;
  if (ms) {
    // Re-registered every time on purpose: iOS drops handlers across audio
    // session interruptions. Metadata is refreshed here too, so a track that
    // starts while the phone is already locked still names itself.
    nowPlaying.installHandlers();
    nowPlaying.sync({ metadata: true, force: true });
  }
  // Playing is the user saying yes: a pause they made earlier (on the lock
  // screen) does not outlive the next track.
  state.userPause = false;
  state.resumeOnVisible = false;
  state.resumeWanted = false;
  state.resumeAttempts = 0;
  // A track that starts while the screen is off is the one case nothing else
  // can rescue: there is no gesture, no visibility change and no event that
  // says the audio session went stale. Repair it here (rate-limited inside the
  // module, so a fast skip cannot cycle the category twice).
  if (document.visibilityState === 'hidden') repairAudioSession();
  updatePlayer();
  // Claim the session promptly: another device's next save is then refused,
  // and the resumed position is stored before the first five-second tick.
  saveSession({ force: true });
});

audio.addEventListener('pause', () => {
  // A pause that arrives while the screen is off was not the user: iOS
  // interrupts the audio session (a call, Siri, another app taking the output)
  // by pausing the element, and nothing resumes it on its own. Remember it so
  // coming back to the page can pick the track up instead of demanding a tap.
  // A lock-screen pause is deliberate and sets `state.userPause` first, so the
  // one pause a person can make while locked is never undone.
  if (document.visibilityState === 'hidden'
    && !state.userPause && !state.ending && !state.switching) {
    state.resumeOnVisible = true;
    state.resumeWanted = true;
  }
  // A `.src` swap pauses and immediately re-plays; that queued pause is not
  // the listener, so it must not paint the transport as paused (it used to
  // flip the button to "Play" for the whole cold load).
  state.playing = !audio.paused || (state.switching && !state.userPause);
  // Re-register the Media Session handlers here too, not only on `playing`:
  // an iOS interruption (a call, Siri, another app taking the output) arrives
  // as a pause and can drop the handlers, and until the track resumes the
  // lock-screen controls would be dead. Cheap and idempotent.
  nowPlaying.installHandlers();
  // Position state survives a pause, which is what keeps the lock-screen bar
  // at the right place instead of snapping back to zero.
  nowPlaying.sync({ force: true });
  updatePlayer();
  // A source swap emits `pause` too; only a real pause is worth saving.
  if (!state.ending && !state.switching && !state.sessionBlocked) {
    saveSession({ force: true });
  }
});

audio.addEventListener('error', async () => {
  const t = current();
  if (!t) return;
  // A stream that fails is not a track that failed. Drop the plan and return to
  // the per-track player at the mapped position: counting this against the
  // track would skip a song the listener never heard the end of.
  if (state.streaming) {
    console.warn('queue stream failed', audio.error?.code);
    clientReport('live-error', { code: audio.error?.code ?? null });
    // A source this engine cannot play at all (MEDIA_ERR_SRC_NOT_SUPPORTED) is
    // not worth retrying in a loop — every attempt swaps the working track out
    // for silence. But a single bad segment (a truncated fetch through a
    // tunnel) is worth exactly one more try, so failures are counted and the
    // stream is only given up on after two in a row.
    state.streamFails = (state.streamFails ?? 0) + 1;
    if (!audio.error || audio.error.code === 4) {
      if (state.streamFails >= 2) {
        state.streamBlocked = true;
        clientReport('live-blocked', { code: audio.error?.code ?? null, fails: state.streamFails });
      } else {
        state.streamCooldownUntil = Date.now() + 15_000;
      }
    }
    state.queuePlan = null;
    leaveQueueStream();
    return;
  }
  console.warn('audio error', audio.error?.code, t.videoId);
  state.failures += 1;
  const failedId = t.videoId;
  const failing = state.startedAt;
  state.startedAt = null;
  // A failed source never reaches `playing`, which normally clears these.
  state.switching = false;
  state.ending = false;

  if (state.failures > 3) {
    // Stop churning through the queue and say why, if the server knows why.
    state.playing = false;
    // There is no player left, not a paused one: `paused` would leave the Now
    // Playing widget on screen advertising a track that will never start.
    nowPlaying.stopped();
    updatePlayer();
    let gated = false;
    try {
      const st = await api('/api/status');
      gated = st.botGated;
      state.jar = st.jar ?? null;
      if (gated) {
        notify(st.jar?.connected
          ? 'YouTube rejected the saved session — an admin needs to reconnect it.'
          : 'YouTube wants a sign-in. Ask an instance admin to connect a session.');
      }
    } catch {}
    if (gated && isAdmin()) {
      // Prompt immediately: a silent failure is the worst possible outcome here.
      openYtSheet();
    } else if (gated) {
      notify('YouTube is asking for a sign-in. Ask an instance admin to connect a session.');
    } else {
      notify('Could not play that track. Tap another.');
    }
    return;
  }
  // Advance before a locked iPhone can freeze background timers. Microtasks
  // finish with this media event; a 400 ms timer may not run until unlock.
  // The failed-id guard also protects a manual next in this same event turn,
  // and makes repeated error events for one source idempotent.
  queueMicrotask(() => {
    // Never skip the song the listener chose while this recovery was queued.
    if (current()?.videoId !== failedId) return;
    if (state.failures > 3 || state.startedAt !== null) return;
    // A source that never reached `playing` has no start stamp, but must still
    // advance; only a mid-track failure with no stamp is skipped.
    if (failing === null && state.sourceStarted) return;
    nextTrack();
  });
});

document.addEventListener('visibilitychange', () => {
  // Locking the phone is the moment the audio session can be lost with nothing
  // to report it, so repair the category on the way out and on the way back in
  // (public/audio-session.js explains why re-asserting alone does not work).
  repairAudioSession();
  // Both directions, not just the way back in. iOS drops the lock-screen
  // handlers on an interruption while hidden — which pauses the element, so no
  // `playing` will fire until something resumes it — and locking the phone
  // relaunches the GPU process *after* this transition, which empties WebKit's
  // remote-command set with no event at all (public/media-session.js). The
  // way out is the last synchronous chance to re-register before the page can
  // be frozen; media-session.js then keeps re-asserting from `timeupdate`.
  nowPlaying.installHandlers();
  // A room is a live connection: come back by re-reading it, not by trusting
  // whatever the stream managed to deliver while the tab was frozen.
  if (rooms.active) {
    if (document.visibilityState === 'visible') rooms.syncNow();
    return;
  }
  if (document.visibilityState === 'hidden') {
    // Hand the element the whole queue first, while this page still runs: on a
    // locked iPhone nothing here will run again until the screen comes back
    // (public/queue-stream.js).
    enterQueueStream();
    if (!audio.paused) log('progress');
    saveSession({ force: true });
    return;
  }
  // Visible again: the queue stream is the queue, not a track. Hand playback
  // back to the real player at wherever the music actually got to before doing
  // anything else, so the UI, the lock screen and the session save all agree.
  leaveQueueStream();
  // Coming back to an idle app is the natural moment to notice that the phone
  // kept playing: adopt its newer session instead of offering a stale position.
  if (audio.paused && !state.playing) refreshSessionFromServer();
  // iOS can interrupt the audio session (a call, Siri, another app taking the
  // output) and leave the element paused while this tab still believes it is
  // playing, or while it was paused *for* us (see the pause handler). Nothing
  // resumes it by itself, so do it here rather than waiting for a tap: a play()
  // is allowed again now that the page is visible.
  resumeIfInterrupted();
});

/**
 * Pick the track back up after a platform interruption.
 *
 * Called from the two places an interruption can be observed to end: the page
 * becoming visible again, and the audio session returning to `active` while the
 * page stays in the background (the call was hung up, the prompt finished, the
 * listener is still in Maps). The second one used to leave the player paused
 * until the app was opened again — and a paused background tab never advances
 * to the next track, which is the silence this whole file is about.
 */
function resumeIfInterrupted() {
  // A room's playhead is the server's; its own corrector owns resume there, and
  // a local play() would just fight it.
  if (rooms.active) return;
  // A pause the listener made is never undone, whichever flag survived.
  if (state.userPause) return;
  if (state.resumeOnVisible || state.resumeWanted || (state.playing && audio.paused)) {
    resumeAfterInterruption();
  }
}

/**
 * This tab was playing and is not any more, for a reason that was not the user.
 *
 * Re-claims the session, starts the element, and — if the browser still refuses
 * — stops pretending: a transport that says "playing" while nothing plays is
 * worse than an honest pause.
 */
function resumeAfterInterruption() {
  state.resumeOnVisible = false;
  state.resumeWanted = false;
  // Signed out: the element was paused by the sign-in screen, not by iOS, and
  // playing it again would only 401 the stream.
  if ($('auth-overlay') && !$('auth-overlay').hidden) return;
  // Nothing left to play (the queue ran out, the source was never set): giving
  // up is correct, and the watchdog below must not resurrect a finished queue.
  if (!audio.currentSrc && !current()) return;
  // Bounded retries. The watchdog re-arms `resumeWanted` on every refusal, so
  // an interruption that never ends (a call that is still going, another app
  // that keeps the output) would otherwise retry for as long as the page lives.
  state.resumeAttempts = (state.resumeAttempts ?? 0) + 1;
  if (state.resumeAttempts > 60) return;
  state.playing = true;
  claimAudioSession();
  audio.play().catch(() => {
    if (!audio.paused) return;
    state.playing = false;
    // Still refused: the session has not come back yet. Keep the intent so the
    // next witness (a page resume, the audio session going active, or the
    // watchdog below) tries again instead of giving up after one attempt.
    if (document.visibilityState === 'hidden' && !state.userPause) state.resumeWanted = true;
    updatePlayer();
  });
}

// A frozen page comes back with a fresh process chain behind the same DOM: the
// category has to be sent again, not remembered. `pageshow` also covers a
// restore from the back/forward cache, which fires no `visibilitychange` — and
// a page that comes back from there while the queue stream was playing has to
// return to the per-track player just as a visible page does.
addEventListener('pageshow', () => { repairAudioSession(); leaveQueueStream(); });
// `resume` is the page lifecycle event: a suspended page coming back to life.
// The category needs re-sending (a fresh process chain is behind the same DOM),
// and so does the playback state — a page suspended mid-interruption wakes with
// the element paused and no event that says the interruption is over.
addEventListener('resume', () => { repairAudioSession({ force: true }); resumeIfInterrupted(); });

// The interruption can also end without the listener ever returning to the app:
// they hang up, dismiss the prompt, and stay in Maps. That produces no
// `visibilitychange` and no `playing` event, so the audio session's own state is
// the only witness. Without this the player sat paused — silently, with the Now
// Playing widget emptied — until the app was opened again, and a paused
// background tab never auto-advances to the next track.
audioSession.onResume(() => {
  if (document.visibilityState === 'visible') return;
  resumeIfInterrupted();
});

/**
 * The last-resort net: notice on our own that we should be playing and are not.
 *
 * Every other recovery is event-driven, and each event can fail to arrive. The
 * audio session's `statechange` only fires if WebKit classified the takeover as
 * an interruption — another app simply grabbing the output (Discord, a game, a
 * navigation prompt) does not always qualify. `visibilitychange` needs the
 * listener to come back to the app, which is exactly what they did not do.
 * `resume` needs the page to have been suspended first. So a hidden page whose
 * music was taken away could sit paused forever with the Now Playing widget
 * emptied — the "switched apps and the music stopped" report.
 *
 * Cheap by construction: one interval, and `resumeIfInterrupted` is a handful of
 * boolean checks that return immediately whenever playback is healthy, a swap is
 * in flight, or the pause was the listener's own. It only ever calls play() on a
 * page that has produced audio before and is silent through no one's choosing.
 *
 * Exactly one interval, deliberately. There used to be a second, byte-identical
 * copy of this block (a copy-paste), and the two together burned the 60-attempt
 * retry cap in resumeAfterInterruption twice as fast: a six-minute phone call
 * disarmed auto-resume for the rest of the session, so the music never came back
 * after the next interruption. A second net must not be added to fix a net that
 * is not firing — make this one smarter instead.
 */
setInterval(() => {
  if (document.visibilityState !== 'hidden') return;
  resumeIfInterrupted();
}, 10_000);

// ── data actions ────────────────────────────────────────────────────────
let searchTimer = null;
let adminSearchTimer = null;

/**
 * Drop every shelf of the last search answer together.
 *
 * The four arrays are one answer, so they are cleared as one: a stale album
 * shelf left under a new query is worse than no shelf at all. `mode` keeps the
 * page's three-state convention for `searchResults` — `null` means "loading",
 * `undefined` means "nothing asked for yet", `[]` means "asked, found nothing".
 */
function clearSearchShelves(mode) {
  state.searchResults = mode;
  state.searchArtists = [];
  state.searchAlbums = [];
  state.searchPlaylists = [];
  state.searchCounts = null;
  state.searchQuery = '';
}

async function runSearch() {
  const q = state.search.trim();
  if (!q) { clearSearchShelves([]); if ($('search-results')) $('search-results').innerHTML = searchBody(); return; }
  try {
    // One request, every shelf. The Search API contract answers `type=all` with
    // songs, artists, albums and playlists together, which is what lets the
    // type tabs below the field switch instantly instead of asking YouTube
    // again for a shelf it already sent.
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&type=all`);
    if (state.search.trim() !== q) return;
    // A new query starts on All: a tab chosen for the previous query would hide
    // the shelf the listener is actually asking for now.
    if (state.searchQuery !== q) state.filter = 'all';
    state.searchQuery = q;
    state.searchResults = data.tracks ?? [];
    state.searchArtists = data.artists ?? [];
    state.searchAlbums = data.albums ?? [];
    state.searchPlaylists = data.playlists ?? [];
    state.searchCounts = data.counts ?? {
      tracks: state.searchResults.length, artists: state.searchArtists.length,
      albums: state.searchAlbums.length, playlists: state.searchPlaylists.length,
    };
    // Any shelf counts as a search worth remembering: a query that only found
    // the artist is still how they got to that artist's page.
    const found = state.searchResults.length + state.searchArtists.length
      + state.searchAlbums.length + state.searchPlaylists.length;
    if (found) {
      state.searchRecent = [q, ...state.searchRecent.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
      store.set('searchRecent', state.searchRecent);
    }
  } catch (err) {
    // A slow failure belongs to the query that asked for it. Without this
    // guard a delayed 500 on the previous query cleared the newer query's
    // shelves and blamed it ("No match for …", "Search is unavailable").
    if (state.search.trim() !== q) return;
    clearSearchShelves([]);
    notify(err.message, 'error');
  }
  if ($('search-results') && state.page === 'search') $('search-results').innerHTML = searchBody();
}

async function loadPlaylists() {
  const { playlists } = await api('/api/playlists');
  // An unexpected shape (an older server, a proxy error page) must degrade to
  // "no playlists" instead of making every later render throw on .map().
  state.playlists = Array.isArray(playlists) ? playlists : [];
}

/**
 * Metadata for a track the UI is looking at, so the server can remember a track
 * it has never seen (a shared link, a queue restored from storage).
 */
function trackMeta(videoId) {
  const t = state.queue.find((x) => x.videoId === videoId)
    ?? state.likedTracks?.find((x) => x.videoId === videoId)
    ?? state.station?.tracks?.find((x) => x.videoId === videoId)
    ?? state.lastCollection?.find((x) => x.videoId === videoId);
  if (!t) return {};
  return {
    title: t.title ?? null, channel: t.channel ?? null,
    thumb: t.thumb ?? null, durationS: t.durationS ?? null,
  };
}

async function loadLikes() {
  const { tracks } = await api('/api/likes');
  state.likedTracks = Array.isArray(tracks) ? tracks : [];
  state.liked = new Set(state.likedTracks.map((t) => t.videoId));
}

async function loadDislikes() {
  const { tracks } = await api('/api/dislikes');
  state.disliked = new Set((Array.isArray(tracks) ? tracks : []).map((t) => t.videoId));
}

/**
 * Remove a refused track from the queue.
 *
 * If it is the track playing right now, play whatever takes its place. Just
 * filtering the array would leave the audio untouched and relabel the current
 * song as the next one — the player would claim to be playing something the user
 * has just refused, at the refused song's position and duration.
 */
function removeFromQueue(videoId) {
  const idx = state.queue.findIndex((t) => t.videoId === videoId);
  if (idx < 0) return;
  const wasPlaying = idx === state.index;
  state.queue = state.queue.filter((t) => t.videoId !== videoId);
  // The removed row is still inside any armed plan's track list, so a stream
  // armed before this edit would keep playing the song the listener refused.
  invalidateQueuePlan();
  if (idx < state.index) {
    state.index -= 1;
    // The row that was removed sits above the playhead, so no playback change
    // is needed — but every open list still shows the old rows with their old
    // indices, and a click on one would target the wrong entry.
    refreshQueueViews({ forceOverlay: true, rowsChanged: true });
    clearTimeout(queueSaveTimer);
    queueSaveTimer = setTimeout(() => { saveSession({ force: true }); }, 250);
    return;
  }
  if (!wasPlaying) return;
  if (!state.queue.length) {
    audio.pause();
    audio.removeAttribute('src');
    state.index = -1;
    state.playing = false;
    // A station cannot run out: if the refused track was the last one queued,
    // ask for the next page and keep going instead of stopping dead.
    if (state.stationQueue) {
      extendStation().then((n) => {
        if (n && state.queue.length) playIndex(0);
        else render();
      });
      return;
    }
    render();
    return;
  }
  playIndex(Math.min(idx, state.queue.length - 1), { queueChanged: true });
}

/**
 * "Less like this" — a standing instruction, not a collection.
 *
 * Optimistic like the heart: the row reacts before the round trip. Disliking a
 * liked song also un-likes it (the server enforces that), so the heart is
 * repainted here instead of waiting for the next load.
 */
async function toggleDislike(videoId) {
  if (!videoId) return;
  const on = !state.disliked.has(videoId);
  on ? state.disliked.add(videoId) : state.disliked.delete(videoId);
  paintDislike(videoId, on);
  if (on && state.liked.has(videoId)) {
    state.liked.delete(videoId);
    paintLike(videoId, false);
  }
  notify(on ? 'Fewer songs like this' : 'Undone — it can play again', on ? 'info' : 'info');
  try {
    await api('/api/dislikes', { method: 'POST', body: { videoId, dislike: on, source: state.page, ...trackMeta(videoId) } });
    if (on) {
      await loadLikes();
      // The instruction is felt now, not at the next build.
      removeFromQueue(videoId);
      if (state.page === 'station') await loadStation({ force: true });
    }
  } catch (err) {
    on ? state.disliked.delete(videoId) : state.disliked.add(videoId);
    paintDislike(videoId, !on);
    notify(err.message, 'error');
  }
}

async function toggleLike(videoId) {
  if (!videoId) return;
  const on = !state.liked.has(videoId);
  on ? state.liked.add(videoId) : state.liked.delete(videoId);
  paintLike(videoId, on);
  notify(on ? 'Added to liked songs' : 'Removed from liked songs');
  try {
    await api('/api/likes', { method: 'POST', body: { videoId, like: on, source: state.page, ...trackMeta(videoId) } });
    await loadLikes();
    paintLike(videoId, on);
    if (!on && state.page === 'collection' && state.collection === 'liked') {
      const row = document.querySelector(`.track-row[data-track="${CSS.escape(videoId)}"]`);
      if (row) {
        row.classList.add('removing');
        setTimeout(() => {
          row.remove();
          if (!document.querySelector('#page-root .track-row')) render();
        }, 180);
      }
    }
  } catch (err) {
    on ? state.liked.delete(videoId) : state.liked.add(videoId);
    paintLike(videoId, !on);
    notify(err.message, 'error');
  }
}

/** Patch every dislike button for a track in place. */
function paintDislike(videoId, disliked) {
  const sel = CSS.escape(videoId);
  document.querySelectorAll(`[data-action="dislike"][data-id="${sel}"]`).forEach((b) => {
    b.classList.toggle('is-disliked', disliked);
    b.setAttribute('aria-pressed', String(disliked));
    b.setAttribute('aria-label', disliked ? 'Undo "less like this"' : 'Play this less often');
    b.title = disliked ? 'Undo "less like this"' : 'Less like this';
  });
}

/** Patch every heart for a track in place — a full re-render would drop scroll. */
function paintLike(videoId, liked) {
  const sel = CSS.escape(videoId);
  document.querySelectorAll(`[data-action="heart"][data-id="${sel}"]`).forEach((b) => {
    b.classList.toggle('primary', liked);
    b.classList.toggle('liked', liked);
    b.setAttribute('aria-pressed', String(liked));
    b.setAttribute('aria-label', `${liked ? 'Remove from' : 'Add to'} liked songs`);
  });
  const count = document.querySelector('[data-collection="liked"] .music-card-sub');
  if (count) count.textContent = `${state.liked.size} ${state.liked.size === 1 ? 'song' : 'songs'}`;
}


async function tracksFor(collection) {
  if (!collection) return [];
  if (collection === 'liked') return state.likedTracks ?? [];
  if (collection === 'recent') return state.home.recent ?? [];
  if (collection === 'station') return state.station?.tracks ?? [];
  if (collection.startsWith('p')) {
    const { playlist } = await api(`/api/playlists/${Number(collection.slice(1))}`);
    return playlist.tracks;
  }
  if (collection.startsWith('a')) {
    return state.albumTracks?.id === collection.slice(1) ? state.albumTracks.tracks : [];
  }
  return [];
}

async function openCollection(collection, { history = 'push', scrollTop = 0 } = {}) {
  state.page = 'collection';
  state.collection = collection;
  state.collectionLoading = true;
  state.collectionError = null;
  state.collectionData = null;
  if (history === 'push') pushRoute({ page: 'collection', collection });
  else if (history === 'replace') {
    historyEntries[historyCursor.index] = { page: 'collection', collection };
    try { history.replaceState({ i: historyCursor.index }, '', routePath('collection', collection)); } catch {}
  }
  applyRoute({ page: 'collection', collection }, { scroll: history === 'push', scrollTop });
  document.title = pageTitle();

  // Resolve into locals first. A slow answer for a collection the listener has
  // already left used to be written straight into state, so opening playlist B
  // while A was still loading left B's page showing A's title and tracks.
  let data = null;
  let albumTracks = null;
  let error = null;
  try {
    if (collection === 'liked') {
      await loadLikes();
    } else if (collection.startsWith('p')) {
      const { playlist } = await api(`/api/playlists/${Number(collection.slice(1))}`);
      data = playlist ?? null;
    } else if (collection.startsWith('a')) {
      const ytId = collection.slice(1);
      const known = state.browse.albums?.find((a) => a.id === ytId)
        ?? state.mood?.playlists?.find((p) => p.id === ytId);
      const album = await api(`/api/album/${encodeURIComponent(ytId)}`);
      const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
      data = {
        title: album?.title ?? known?.title ?? tracks[0]?.album ?? 'Album',
        author: album?.author ?? known?.author ?? tracks[0]?.channel,
        authorId: album?.authorId ?? null,
        type: album?.type ?? 'Album',
        // The release's own cover, not its first track's video still.
        art: album?.thumb ?? known?.thumb ?? tracks[0]?.thumb ?? null,
        tracks,
      };
      albumTracks = { id: ytId, title: data.title, author: data.author, tracks };
    }
  } catch (err) {
    error = err.message;
  }
  // The staleness guard runs before *anything* is committed, and in the error
  // path too: a late failure must not label the newer page as broken.
  if (state.collection !== collection || state.page !== 'collection') return;
  state.collectionData = data;
  state.albumTracks = albumTracks;
  state.collectionError = error;
  state.collectionLoading = false;
  await render();
  document.title = pageTitle();
  if (state.page === 'collection') $('main-scroll').scrollTop = scrollTop;
}

async function startRadio(seedVideoId) {
  notify('Building a station…');
  try {
    const { tracks } = await api(`/api/radio?seed=${encodeURIComponent(seedVideoId)}`);
    if (!tracks.length) { notify('No station found for that seed.'); return; }
    playQueue(tracks);
    notify(`Station started · ${tracks.length} tracks`);
  } catch (err) {
    notify(err.message);
  }
}

/**
 * The artists this listener follows (GET /api/follows).
 *
 * Fetched lazily next to the browse shelves: the library's Artists tab is the
 * one place they are shown, and a listener who never opens it never pays for
 * the request. A follow list that cannot be read must not hide the artists the
 * library already knows, so a failure leaves an empty list rather than a
 * broken tab.
 */
async function loadFollows() {
  if (state.follows || state.followsLoading) return;
  state.followsLoading = true;
  try {
    const { items } = await api('/api/follows');
    state.follows = (items ?? []).map((f) => ({
      id: f.artistId, title: f.name || f.artistId, thumb: f.thumb ?? null, following: true,
    }));
  } catch {
    state.follows = [];
  } finally {
    state.followsLoading = false;
    if (state.page === 'library') render();
  }
}

async function loadBrowse(kind) {
  if (state.browse[kind] || state.browseLoading[kind]) return;
  state.browseLoading[kind] = true;
  try {
    // No query: the server seeds albums from the artists you actually play.
    const { items } = await api(`/api/browse/${kind}`);
    state.browse[kind] = items;
  } catch {
    state.browse[kind] = [];
  } finally {
    state.browseLoading[kind] = false;
    if (state.page === 'library') render();
  }
}

function queueNext(videoId) {
  const t = trackIndex.get(videoId) ?? { videoId };
  const playing = state.queue[state.index] ?? null;
  const existing = state.queue.findIndex((x) => x.videoId === videoId);
  if (existing >= 0) state.queue.splice(existing, 1);
  // Taking the entry out shifts every later index by one. Re-locate the song
  // that is playing instead of trusting the old number, or "play next" on a
  // track above the playhead leaves the player highlighting the wrong song
  // (and a reload resumes on the wrong one).
  if (playing) state.index = Math.max(0, state.queue.findIndex((x) => x.videoId === playing.videoId));
  const at = Math.min(state.queue.length, Math.max(0, state.index + 1));
  state.queue.splice(at, 0, { ...t, videoId });
  notify('Playing next', 'info');
  render();
  refreshOverlay();
  saveSession({ force: true });
}

/**
 * Append a song to the end of the queue — from a row menu or the now-playing
 * sheet. A queue is a set here, not a log: a song already in it is left where it
 * is and the user is told so, rather than being added a second time.
 *
 * In a room the queue belongs to everyone, so the command goes to the server
 * exactly like the "add this collection" branch does.
 */
async function queueAdd(videoId) {
  const t = trackIndex.get(videoId) ?? { videoId };
  if (rooms.active) {
    const shared = state.room?.queue ?? [];
    if (shared.some((q) => q.videoId === videoId)) { notify('Already in the queue', 'info'); return; }
    await rooms.command('queue-add', { track: { ...t, videoId } });
    notify('Added to the shared queue', 'info');
    return;
  }
  if (state.queue.some((q) => q.videoId === videoId)) { notify('Already in the queue', 'info'); return; }
  state.queue = [...state.queue, completeTrack({ ...t, videoId })];
  // An emptied queue (the last song was disliked away) leaves the index at -1;
  // appending the first new entry must give it a current track again, without
  // autoplaying it.
  if (state.index < 0) state.index = state.queue.length - 1;
  refreshQueueViews({ forceOverlay: true, rowsChanged: true });
  notify('Added to the queue', 'info');
  // The queue is part of the session; save it now rather than waiting for the
  // next playback tick, which may never come if nothing is playing.
  saveSession({ force: true });
}

/**
 * "Queue the rest of the list" (Settings → queueFillList, off by default).
 *
 * The rule, in one place: when a song is started *from a list* (a row, a
 * collection, search results), the preference is on, nothing is queued yet (an
 * empty queue, or one that holds nothing but the song being started), no station
 * is generating and no room is sharing, then the queue becomes that whole list
 * starting at the chosen song, followed by the rest in displayed order. Off, or
 * any of those conditions unmet, the caller's own behaviour is untouched.
 */
function queueFillFromList(list, videoId) {
  if (!pref('queueFillList') || rooms.active || stationPlaying()) return null;
  if (!Array.isArray(list) || list.length < 2) return null;
  const onlyStarting = state.queue.length === 0
    || (state.queue.length === 1 && state.queue[0]?.videoId === videoId);
  if (!onlyStarting) return null;
  const at = list.findIndex((t) => t.videoId === videoId);
  if (at < 0) return null;
  // Whole list, rotated to start at the chosen song; the songs before it land
  // at the end rather than being dropped, and the chosen song is not repeated.
  return [...list.slice(at), ...list.slice(0, at)].map(completeTrack);
}

function openAddToPlaylist(videoId) {
  if (!state.playlists.length) {
    notify('Create a playlist first.', 'info');
    return openCreatePlaylist();
  }
  openFormSheet(`<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <div class="form-body"><span class="eyebrow">Save to</span><h2>Add to a playlist</h2>
      <div class="pick-list">${state.playlists.map((p) => `
        <button class="pick-row" data-action="pick-playlist" data-id="${p.id}" data-video="${esc(videoId)}">
          ${icon('plus', 'sm')}<span>${esc(p.title)}</span><small>${p.trackCount} songs</small></button>`).join('')}</div>
      <div class="form-actions"><button class="secondary-btn" data-action="close-form">Cancel</button></div></div>`,
  { label: 'Add to playlist', focus: '.pick-row' });
}

function openCreatePlaylist() {
  openFormSheet(`<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <div class="form-body"><span class="eyebrow">New playlist</span><h2>Name your playlist</h2>
      <form id="playlist-form" novalidate>
        <label class="sr-only" for="playlist-name">Playlist name</label>
        <input id="playlist-name" name="title" maxlength="80" required autocomplete="off"
          placeholder="Late night drive" aria-describedby="playlist-hint">
        <p class="field-hint" id="playlist-hint">You can add songs from any track menu.</p>
        <p class="field-error" id="playlist-error" role="alert"></p>
        <div class="form-actions"><button type="button" class="secondary-btn" data-action="close-form">Cancel</button>
          <button type="submit" class="play-btn">Create playlist</button></div>
      </form></div>`, { label: 'Create playlist', focus: '#playlist-name' });
}

async function createPlaylistFromForm(form) {
  const name = String(new FormData(form).get('title') ?? '').trim();
  const error = $('playlist-error');
  if (!name) {
    if (error) error.textContent = 'Give the playlist a name.';
    $('playlist-name')?.focus();
    return;
  }
  if (name.length > 80) {
    if (error) error.textContent = 'Keep it under 80 characters.';
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); btn.innerHTML = `<span class="spinner"></span>Creating…`; }
  try {
    const { playlist } = await api('/api/playlists', {
      method: 'POST',
      body: { title: name, description: 'Your new playlist. Find some songs you love and make it yours.' },
    });
    await loadPlaylists();
    closeFormSheet();
    notify('Playlist created');
    await openCollection(`p${playlist.id}`);
  } catch (err) {
    if (error) error.textContent = err.message;
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Create playlist'; }
  }
}

// ── connecting a YouTube session ────────────────────────────────────────
// Google refuses sign-in inside embedded webviews, so there is no in-app login
// to build. The supported flow is: export cookies.txt from a real browser, then
// import it here. This sheet walks through that and verifies the jar server-side.

const YT_EXT = 'https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc';

function ytSheetHtml() {
  const jar = state.jar;
  if (jar?.connected && !jar.expired) {
    const when = jar.importedAt ? new Date(jar.importedAt).toLocaleString() : 'earlier';
    const exp = jar.expiresAt ? new Date(jar.expiresAt).toLocaleDateString() : 'no fixed date';
    // Be honest about what the import actually proved. A successful probe while
    // the IP is not gated proves nothing, and claiming otherwise would hide a
    // broken jar until the next block.
    const banner = jar.verdict === 'verified'
      ? `<div class="yt-ok">${icon('check')}<span>Verified — these cookies unblocked a gated server.</span></div>`
      : jar.verdict === 'rejected'
        ? `<div class="yt-bad">${icon('close')}<span>YouTube rejected these cookies. Export again while signed in.</span></div>`
        : `<div class="yt-warn">${icon('clock')}<span>Saved, but not yet proven — YouTube was not blocking this server when we tested.
             It will use these cookies for playback anyway. You can re-test below.</span></div>`;
    return `<button class="modal-close" data-action="close-yt" aria-label="Close">${icon('close')}</button>
      <span class="eyebrow">YOUTUBE SESSION</span>
      <h2>Session saved<span class="brand-dot">.</span></h2>
      ${banner}
      <div class="yt-connected">
        <div>Imported <b>${esc(when)}</b></div>
        <div>Cookies <b>${jar.cookieCount ?? '—'}</b> · expires <b>${esc(exp)}</b></div>
        <div>Source <b>${esc(jar.source === 'env' ? 'environment variable' : 'imported file')}</b></div>
      </div>
      <div class="yt-actions">
        <button class="play-btn" data-action="close-yt">Done</button>
        <button class="secondary-btn" data-action="yt-verify" id="yt-verify">Test connection</button>
        <button class="secondary-btn" data-action="yt-replace">Replace</button>
        <button class="secondary-btn" data-action="yt-disconnect">Disconnect</button>
      </div>
      <p class="yt-err" id="yt-err"></p>`;
  }

  return `<button class="modal-close" data-action="close-yt" aria-label="Close">${icon('close')}</button>
    <span class="eyebrow">CONNECT YOUTUBE</span>
    <h2>Give sonora a sign-in<span class="brand-dot">.</span></h2>
    <p>YouTube is asking this server to prove it isn't a bot. Connecting your own
      signed-in session fixes playback — it is used only to fetch audio, and it is
      encrypted on the server.</p>
    <ol class="yt-steps">
      <li><span>Sign in at <a href="https://www.google.com" target="_blank" rel="noreferrer noopener">google.com</a> in a browser on your computer.
        <br><b>Not youtube.com</b> — the sign-in cookies (SID, HSID, SSID…) live on the google.com domain.</span></li>
      <li><span>Install <a href="${YT_EXT}" target="_blank" rel="noreferrer noopener">“Get cookies.txt LOCALLY”</a> (open source, never uploads anything).</span></li>
      <li><span>Still on <b>google.com</b>, click the extension → <code>Export</code>. If it offers a choice, pick
        <code>Export all cookies</code> so the .google.com ones are included.</span></li>
      <li><span>Drop the file below, or paste its contents.</span></li>
    </ol>
    <div class="yt-drop" id="yt-drop" role="button" tabindex="0">
      <strong>Drop cookies.txt here</strong>
      <span>or click to choose a file</span>
      <input type="file" id="yt-file" accept=".txt,.json,text/plain,application/json" hidden>
    </div>
    <textarea class="yt-textarea" id="yt-text" placeholder="…or paste the contents of cookies.txt here (Netscape or JSON both work)"></textarea>
    <p class="yt-err" id="yt-err"></p>
    <div class="yt-actions">
      <button class="play-btn" data-action="yt-submit" id="yt-submit">Connect</button>
      <button class="secondary-btn" data-action="yt-diagnose" id="yt-diagnose">Diagnose instead</button>
      <button class="secondary-btn" data-action="close-yt">Not now</button>
    </div>
    ${state.diagnosis ? diagHtml() : ''}
    <p class="yt-note">Your cookies are equivalent to a password: stored AES-256 encrypted,
      never returned to any client, and only sent to YouTube. Signing out of that
      Google account invalidates them. Sonora cannot sign in for you — Google blocks
      sign-in inside embedded apps, which is why this is a file import.</p>`;
}

function openYtSheet() {
  $('yt-content').innerHTML = ytSheetHtml();
  openOverlay('yt-overlay');
}

/**
 * Renders the staged diagnostic so a failure names the broken layer instead of
 * "playback failed". Each step is a real check the server just ran.
 */
function diagHtml(d = state.diagnosis) {
  if (!d) return '';
  const row = (s) => `<div class="diag-row ${s.ok === true ? 'ok' : s.ok === null ? 'warn' : 'bad'}">
      <span class="diag-mark">${s.ok === true ? '✓' : s.ok === null ? '!' : '✕'}</span>
      <span class="diag-name">${esc(s.name)}</span>
      <span class="diag-detail">${esc(String(s.detail ?? '').slice(0, 120))}</span></div>`;
  return `<div class="diag">
      <div class="diag-head">${d.ok ? 'Everything needed for playback is working.' : 'One or more layers are failing.'}</div>
      ${d.steps.map(row).join('')}
      ${d.advice ? `<p class="diag-advice">${esc(d.advice)}</p>` : ''}
    </div>`;
}

async function refreshYtStatus() {
  try {
    const { jar } = await api('/api/youtube/status');
    state.jar = jar;
  } catch { state.jar = null; }
}

async function submitCookies(text) {
  const btn = $('yt-submit');
  const errEl = $('yt-err');
  if (errEl) errEl.textContent = '';
  if (!text?.trim()) { if (errEl) errEl.textContent = 'Paste or drop your cookies.txt first.'; return; }
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Verifying with YouTube…'; }
  try {
    await api('/api/youtube/cookies', { method: 'POST', body: { cookies: text } });
    await refreshYtStatus();
    openYtSheet();
    notify('Connected — playback enabled');
    render();
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  }
}

// ── boot ────────────────────────────────────────────────────────────────
/**
 * Compare the running server's advertised API surface with what this bundle
 * needs. A mismatch is a deployment state, not a code fault, so it is reported
 * plainly and only once.
 */
async function checkServer() {
  const REQUIRED = ['search', 'radio', 'station', 'station-next', 'dislikes', 'likes', 'playlists', 'album',
    // The account screen and the login form depend on these; a server that
    // predates them would 404 on every refresh and passkey attempt.
    'devices', 'passkeys',
    // The three whose absence is worst: a locked phone has no page script, so
    // only the server's queue stream can advance it ('queue-stream'); a follow
    // that 404s is a feature that silently does nothing ('follows'); and the
    // bell would poll an endpoint that does not exist ('notifications').
    'queue-stream', 'follows', 'notifications'];
  let health;
  try {
    health = await api('/api/health');
  } catch {
    // Offline or an unreadable health answer: the normal error paths handle it.
    return;
  }
  const have = new Set(Array.isArray(health?.features) ? health.features : []);
  // An older server does not advertise features at all; that is the same signal.
  const missing = REQUIRED.filter((f) => !have.has(f));
  state.serverSkew = missing.length ? { missing, startedAt: health?.startedAt ?? null } : null;
  if (missing.length) {
    notify('This server is older than the app — restart it to pick up the new features.', 'error');
  }
}

// Single-flight: the document used to call boot() twice (module scope and the
// trailing line), so every boot request, render and session restore happened
// twice. Concurrent callers share one run; a later explicit boot (after sign-in,
// after coming back online) still gets a fresh one.
let bootRun = null;

/**
 * Tell index.html's boot watchdog that the module graph loaded and ran.
 *
 * The watchdog covers the one failure a page cannot report about itself: app.js
 * (or one of its static imports) failing to resolve out of a half-evicted
 * service-worker cache leaves the skeleton painted and nothing else, forever,
 * with no error the user can act on. It only needs to know that *this file
 * executed* — every failure after that has a UI of its own (showAuth,
 * showOffline, and boot()'s own catch) — so it is cleared here, before boot()
 * spends its first request.
 */
function markBooted() {
  try {
    document.documentElement.dataset.sonoraBooted = '1';
    clearTimeout(window.__sonoraBootWatch);
    const banner = document.getElementById('boot-recovery');
    if (banner) banner.hidden = true;
  } catch { /* a watchdog is not worth failing a boot over */ }
}

async function boot() {
  if (bootRun) return bootRun;
  markBooted();
  bootRun = bootOnce()
    .catch(async (err) => {
      // Last resort. boot() is called fire-and-forget, so an unexpected throw
      // would leave the index.html skeleton on screen with no error at all.
      console.error('boot failed', err);
      if (state.user) { try { await render(); } catch {} }
      else showAuth();
    })
    .finally(() => { bootRun = null; });
  return bootRun;
}

async function bootOnce() {
  // A boot *is* the offline page's "Try again": whatever this run decides is the
  // new truth, and showOffline raises the flag again if it fails offline.
  offlineBootShown = false;
  // The server check must still happen (the app is served from disk per request
  // but the routes are frozen at process start, so a server left running across
  // a deploy hands the new bundle old routes — saying that once is the
  // difference between "the deploy went wrong" and "the app is broken"), but it
  // does not have to happen *first*. Three questions used to be asked one after
  // another — /api/health, then /api/me, then /api/now after five more loaders —
  // and the hero image, the LCP element, only exists after the render() at the
  // end of all of it: every round trip was dead air in front of the first real
  // paint. Health only reports a skew, so it is not awaited at all.
  checkServer();

  // The saved session needs nothing but the cookie, so it goes out beside
  // /api/me and is awaited where its answer is actually used, further down.
  // On a signed-out browser this costs one 401 that the server answers without
  // touching the database — a whole round trip saved on every signed-in boot is
  // worth that. It cannot reject: a failure here means "no session to restore".
  const savedNow = api('/api/now').catch(() => null);

  try {
    const me = await api('/api/me');
    const user = me.user;
    state.user = user;
    const initial = (user.name || 'S').trim().charAt(0).toUpperCase() || 'S';
    $('side-avatar').textContent = initial;
    $('top-avatar').textContent = initial;
    $('side-name').textContent = user.name;
    $('top-name').textContent = user.name;
    // Admin navigation and the instance-wide YouTube controls are owner-only.
    $('profile-admin').hidden = user.role !== 'admin';
    $('profile-yt').hidden = user.role !== 'admin';
    keepSessionAlive(Boolean(user.remembered), me.sessionMinutes);
  } catch (err) {
    if (!navigator.onLine || /offline/i.test(err?.message ?? '')) showOffline();
    else showAuth();
    return;
  }

  $('auth-overlay').hidden = true;

  // Every loader is independent: one failing endpoint (a 500 on /api/likes, a
  // slow /api/playlists) must not abort boot and leave the skeleton up
  // forever. The page still renders with whatever the others produced.
  await Promise.all([
    loadLikes().catch(() => { state.likedTracks = []; state.liked = new Set(); }),
    loadDislikes().catch(() => { state.disliked = new Set(); }),
    loadPlaylists().catch(() => { state.playlists = []; }),
    api('/api/recent')
      .then((r) => { state.home.recent = Array.isArray(r?.tracks) ? r.tracks : []; })
      .catch(() => { state.home.recent = []; }),
  ]);

  // The pinned station is on the home page, so fetch it in the background (it
  // costs a couple of YouTube calls). Failures stay silent here: the station
  // page reports its own error if the user opens it.
  loadStation({ silent: true });

  // Restore the last session the phone was playing. The request itself went out
  // beside /api/me (see the top of bootOnce); only the answer is awaited here,
  // because a restored queue must land before the first render() but the fetch
  // had no reason to wait for the five loaders above.
  const nowSession = await savedNow;
  if (nowSession) {
    const saved = nowSession.state;
    const updatedAt = nowSession.updatedAt;
    if (saved?.tracks?.length && saved.tracks[saved.index ?? 0]) {
      // Durations are persisted with the queue; if an older save lacks them,
      // fall back to the track index so "up next" never shows 0:00.
      state.queue = saved.tracks.map(completeTrack);
      state.index = saved.index ?? 0;
      state.home.featured = state.queue[state.index];
      state.home.featuredPos = saved.positionMs ?? 0;
      // Keep the saved playhead until the first `playing` seeks there. This is
      // what makes pressing the player's own play button resume instead of
      // restarting, and it is also the position a second device continues from.
      state.pendingResumeMs = saved.positionMs ?? 0;
      state.sessionUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : (saved.updatedAt ?? 0);
      state.resumeFrom = saved.deviceId && saved.deviceId !== deviceId
        ? (saved.deviceName || 'another device')
        : null;
      // Until the user plays here, this device is a reader, not a writer. A
      // background save from a second open tab must not take the session back
      // from the device that is actually playing.
      state.sessionBlocked = Boolean(state.resumeFrom);
      // A restored station stays a station: it keeps generating instead of
      // ending after the songs that happened to be saved with it.
      if (saved.station) {
        state.stationQueue = {
          cursor: 3, seen: state.queue.map((t) => t.videoId), loading: false, misses: 0, retryAt: 0, done: false,
        };
      }
      state.sourceStarted = false;
      state.switching = true;
      audio.src = `/api/stream/${state.queue[state.index].videoId}`;
      // Restoring is not playing: nothing is buffered yet, so fetch the next
      // track in the restored queue too rather than only the first.
      warmNext();
      maybeExtendStation();
    }
  }

  // Seed the home page with something real to click. Fire and forget: the
  // first paint must not wait on a network round trip, and whatever page the
  // user lands on gets a patch when the tracks arrive.
  if (!state.home.radio.length) {
    const seed = state.likedTracks[0] ?? state.home.recent[0];
    if (seed) {
      api(`/api/radio?seed=${encodeURIComponent(seed.videoId)}`)
        .then((r) => {
          state.home.radio = r.tracks;
          if (state.page === 'home') render();
          else if (state.page === 'search' && !state.search.trim() && state.searchResults !== null) {
            const box = $('search-results');
            if (box) box.innerHTML = searchBody();
          }
        })
        .catch(() => {});
    }
  }

  // Deep links first: #/c/p3 opens a playlist directly, so the right page is
  // what renders on boot instead of flashing Discover first.
  const shared = routeFromLocation();
  const route = shared?.page === 'track' ? { page: 'home', collection: null } : (shared ?? { page: 'home', collection: null });
  historyEntries[0] = route;
  historyCursor.index = 0;
  if (shared?.page !== 'track') {
    // The hash is the source of truth on a reload, and the entry being shown may
    // be one this page pushed before the reload: its state carries an `i` that
    // this document's fresh historyEntries knows nothing about. Unconditionally
    // replacing it with { i: 0 } threw that state away *and* pointed the entry
    // at the wrong index, so the next popstate adopted a stale `i` and routed to
    // the wrong page. Only an entry nobody wrote (state===null: a first visit, a
    // plain /l/ tunnel link) gets a rewrite, and any state it does carry is kept.
    // An entry the app already owns needs nothing: its hash is the route.
    if (history.state?.i === undefined) {
      try { history.replaceState({ ...(history.state ?? {}), i: 0 }, '', routePath(route.page, route.collection, route.mood)); } catch {}
    }
  }
  try {
    if (route.page === 'collection' && route.collection) {
      await openCollection(route.collection, { history: 'none' });
    } else if (route.page === 'artist' && route.collection) {
      // A shared or reloaded artist link is a page whose content is fetched, so
      // boot has to kick its loader itself — rendering the route alone would
      // leave the skeleton up forever.
      state.page = 'artist';
      state.collection = route.collection;
      await loadArtist(route.collection);
    } else if (route.page === 'mood' && route.mood) {
      state.page = 'mood';
      state.collection = null;
      await loadMood(route.mood);
    } else {
      state.page = route.page;
      state.collection = route.collection;
      await render();
      // Pages whose content is fetched (not derived from state already loaded)
      // must kick their own loader on a deep link: applyRoute does this for
      // in-app navigation, but boot renders directly.
      if (route.page === 'security') loadSecurity();
      if (route.page === 'room' && route.collection) openRoom(route.collection);
      if (shared?.page === 'track') playSharedTrack(shared.videoId);
    }
  } catch (err) {
    // A route whose data failed still paints the page it can paint: an empty
    // Discover is a usable app, a skeleton held forever is not.
    console.error('boot route failed', err);
    state.page = 'home';
    state.collection = null;
    await render().catch(() => {});
  }

  // Rejoin the room this browser was in. A reload is not a decision to leave:
  // the room page is restored by the route above, but a reload on any other
  // page must still put this device back on the shared playhead (and show the
  // pill) instead of quietly dropping out.
  const savedRoom = rememberedRoom();
  if (savedRoom && state.page !== 'room') {
    rooms.load(savedRoom)
      .then((snapshot) => {
        // Gone, ended, or no longer ours: stop pretending it is waiting.
        if (!snapshot || !rooms.active) {
          rememberRoom(null);
          updateRoomPill();
        }
      })
      .catch(() => rememberRoom(null));
  }

  // Tell the user once if YouTube is refusing this IP, with the actual fix.
  try {
    const st = await api('/api/status');
    state.jar = st.jar ?? null;
    if (st.botGated) {
      setTimeout(() => {
        if (isAdmin()) {
          openYtSheet();
          notify(st.jar?.connected
            ? 'YouTube rejected the saved session — reconnect it.'
            : 'YouTube wants a sign-in. Connect your account to keep playing.');
        } else {
          notify('YouTube wants a sign-in. Ask an instance admin to connect a session.');
        }
      }, 700);
    }
  } catch {}
}

// ── iOS keyboard scroll guard ───────────────────────────────────────────
// Only .main scrolls; the window itself never does. iOS ignores that and, when
// a text field is focused near the bottom, scrolls the whole webview up to
// reveal it — then leaves it there after the keyboard closes, so the app looks
// "shifted up" with the top bar clipped. Resetting the window scroll on focus
// and blur undoes it; on every other platform this is a no-op.
function pinWindowScroll() {
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
}

document.addEventListener('focusin', (e) => {
  if (!e.target.matches('input,textarea,select,[contenteditable]')) return;
  setTimeout(pinWindowScroll, 0);
});
document.addEventListener('focusout', () => setTimeout(pinWindowScroll, 0));
window.visualViewport?.addEventListener('resize', pinWindowScroll);

// pwa.js owns the service worker lifecycle (register, update prompt, offline
// pill) and always loads, so registering here as well was a second update check
// and a second place that had to agree on the options forever. One owner.
boot();
