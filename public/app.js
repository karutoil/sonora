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
import { isLoopWrap } from './playback.js';
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
let queueSaveTimer = null;
let queueSuppressClick = 0;

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
    .then((res) => res.ok)
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
    play: () => { claimAudioSession(); state.playing = true; audio.play().catch(() => {}); updatePlayer(); },
    pause: () => { state.playing = false; audio.pause(); updatePlayer(); },
    seek: (seconds) => seekTo(seconds),
    setRate: (rate) => { audio.playbackRate = Math.min(1.5, Math.max(0.5, Number(rate) || 1)); },
    onSnapshot: (snapshot) => {
      state.room = snapshot;
      if (snapshot?.invites) state.roomInvites = snapshot.invites;
      if (snapshot?.members) state.roomMembers = snapshot.members;
      if (Number.isFinite(snapshot?.guests)) state.roomGuests = snapshot.guests;
      if (!snapshot) { state.roomMembers = []; state.roomGuests = 0; state.roomDriftMs = 0; }
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
const trackIndex = new Map();
function rememberTracks(list = []) {
  for (const t of list) {
    if (!t?.videoId) continue;
    const prev = trackIndex.get(t.videoId);
    if (!prev || t.title) trackIndex.set(t.videoId, { ...prev, ...t });
  }
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
  if (kind === 'c' && arg) return { page: 'collection', collection: decodeURIComponent(arg) };
  if (kind === 'artist' && arg) return { page: 'artist', collection: decodeURIComponent(arg) };
  if (kind === 'mood' && arg) return { page: 'mood', collection: null, mood: decodeURIComponent(arg) };
  // `#/room/<code>` — the in-app half of a `/l/<code>` share link.
  if (kind === 'room' && arg) return { page: 'room', collection: decodeURIComponent(arg) };
  // `#/t/<videoId>` is what "Copy link" writes: open sonora and start the track.
  if (kind === 't' && arg) return { page: 'track', videoId: decodeURIComponent(arg) };
  if (['home', 'search', 'library', 'radio', 'station', 'admin', 'security'].includes(kind)) {
    return { page: kind, collection: null };
  }
  return null;
}

async function playSharedTrack(videoId) {
  try {
    const { track } = await api(`/api/track/${encodeURIComponent(videoId)}`);
    state.queue = [completeTrack(track)];
    playIndex(0, { claim: true });
    notify(`Playing ${track.title ?? 'shared track'}`, 'info');
  } catch (err) {
    notify(err.message === 'Unknown track.'
      ? 'That link points to a track sonora has not seen yet.'
      : err.message, 'error');
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

function pushRoute(entry) {
  historyEntries.splice(historyCursor.index + 1);
  historyEntries.push(entry);
  historyCursor.index = historyEntries.length - 1;
  const path = routePath(entry.page, entry.collection, entry.mood);
  try { history.pushState({ i: historyCursor.index }, '', path); } catch {}
}

function navigate(page, collection = null, addHistory = true, mood = null) {
  if (page === 'collection' && collection) return openCollection(collection, { history: addHistory ? 'push' : 'none' });
  const entry = { page, collection, ...(mood ? { mood } : {}) };
  if (addHistory) {
    pushRoute(entry);
  } else {
    // In-app back/forward walks the internal stack without pushing. Keep the
    // address bar honest anyway, so a reload (or the phone's own back gesture)
    // lands on the page actually being shown.
    try { history.replaceState({ i: historyCursor.index }, '', routePath(page, collection, mood)); } catch {}
  }
  applyRoute(entry, { scroll: true });
}

function applyRoute({ page, collection, mood = null }, { scroll = false } = {}) {
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
  if (scroll) $('main-scroll').scrollTop = 0;
  if (page === 'search' && window.matchMedia('(min-width: 811px)').matches) {
    setTimeout(() => $('primary-search')?.focus({ preventScroll: true }), 60);
  }
  // A mood needs its playlists; load once per mood, including on deep links
  // and when the phone's back gesture lands here.
  if (page === 'mood' && mood && state.mood?.q !== mood) loadMood(mood);
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
  const i = e.state?.i;
  if (Number.isInteger(i) && historyEntries[i]) {
    historyCursor.index = i;
    const entry = historyEntries[i];
    if (entry.page === 'collection' && entry.collection) {
      return openCollection(entry.collection, { history: 'none' });
    }
    return applyRoute(entry, { scroll: true });
  }
  const route = routeFromLocation();
  if (!route) return;
  if (route.page === 'track') return playSharedTrack(route.videoId);
  if (route.page === 'collection') return openCollection(route.collection, { history: 'none' });
  historyEntries.splice(historyCursor.index + 1, 0, route);
  historyCursor.index += 1;
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
      ${icon(ic)}<span>${label}</span>${page === 'radio' ? '<span class="tiny-new">NEW</span>' : ''}
    </button>`).join('');

  $('mobile-nav').innerHTML = mobileNav.map(([page, ic, label, short]) => `
    <button class="${activeRoute(page) ? 'active' : ''}" data-page="${page}" aria-label="${label}"${activeRoute(page) ? ' aria-current="page"' : ''}>
      ${icon(ic)}<span>${short ?? label}</span>
    </button>`).join('');

  // The station is pinned to the person, not to a page: its label carries the
  // name so the sidebar entry reads "toil's station".
  const stationBtn = $('nav-station');
  if (stationBtn) {
    const stationOn = activeRoute('station');
    stationBtn.classList.toggle('active', stationOn);
    if (stationOn) stationBtn.setAttribute('aria-current', 'page');
    else stationBtn.removeAttribute('aria-current');
    const label = stationBtn.querySelector('span');
    if (label) label.textContent = state.station?.name ?? `${state.user?.name ?? 'Your'}'s station`;
  }

  const dots = ['#ff997b', '#988ae0', '#92c1bd', '#ca7b9d', '#e4b985'];
  $('side-playlists').innerHTML = state.playlists.map((p, i) => `
    <button class="playlist-link ${state.page === 'collection' && state.collection === `p${p.id}` ? 'active' : ''}"
            data-collection="p${p.id}"${state.page === 'collection' && state.collection === `p${p.id}` ? ' aria-current="page"' : ''}>
      <span class="color-dot" style="--dot:${dots[i % 5]}"></span><span>${esc(p.title)}</span>
    </button>`).join('')
    || '<div class="side-empty">No playlists yet</div>';
}

function sectionHeader(title, desc = '', button = 'See all', go = 'library') {
  return `<div class="section-head"><div><h2>${esc(title)}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div>
    ${button ? `<button class="text-link" data-page="${go}">${esc(button)}${icon('arrow-right')}</button>` : ''}</div>`;
}

function card(c) {
  return `<button class="music-card" data-collection="${esc(c.collection)}" aria-label="${esc(c.title)}">
    <div class="cover-wrap">${cover(null, 'cover', c.art)}<span class="cover-play">${icon('play')}</span></div>
    <div class="music-card-title">${esc(c.title)}</div>
    <div class="music-card-sub">${esc(c.sub)}</div></button>`;
}

// ── pages ───────────────────────────────────────────────────────────────
function homePage() {
  const h = state.home;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const featured = h.featured;

  const quick = h.recent.slice(0, 6);
  const mixes = state.playlists.slice(0, 4);

  return `
<div class="page-head"><div><span class="page-overline">Made for your ears</span>
  <h1 class="page-title">Good ${greeting}<span class="accent">.</span></h1></div>
  <span class="date-text">${esc(date)}</span></div>

<div class="hero"><div class="hero-art"><div class="hero-orb"></div><div class="ring"></div><div class="ring r2"></div><div class="ring r3"></div></div>
  <div class="hero-fade"></div><div class="hero-noise"></div>
  <div class="hero-content"><div class="hero-tag">${featured ? (state.resumeFrom ? `UP NEXT · FROM YOUR ${esc(String(state.resumeFrom).toUpperCase())}` : 'UP NEXT · YOUR SESSION') : 'THE EVENING EDIT · VOL. 01'}</div>
    <h1>${featured ? `Keep the <em>feeling.</em>` : 'Find your <em>afterglow.</em>'}</h1>
    <p>${featured
      ? `${esc(featured.channel || 'Your last track')} — ${state.resumeFrom
        ? `pick up on this device where your ${esc(state.resumeFrom)} left off.`
        : 'pick up exactly where you left off.'}`
      : 'For slow evenings, long drives, and whatever comes next. Start with a song and sonora builds the rest.'}</p>
    <div class="hero-footer">
      ${featured
        ? `<button class="play-btn" data-action="play-featured">${icon('play')}${state.resumeFrom ? 'Continue here' : 'Resume session'}</button>
           <button class="secondary-btn" data-collection="recent">See history ${icon('arrow-right', 'sm')}</button>
           <span class="hero-meta">${esc(featured.title).slice(0, 34)}</span>`
        : `<button class="play-btn" data-action="surprise">${icon('play')}Start listening</button>
           <button class="secondary-btn" data-page="search">Find a song ${icon('arrow-right', 'sm')}</button>
           <span class="hero-meta">${state.liked.size} liked · ${h.recent.length} recent</span>`}
    </div></div></div>

${sectionHeader('Your station', 'Pinned and endless. Built from what you listen through and like, then widened to their neighbours and to what is big in the same lane — it keeps generating as you listen.', 'Open station', 'station')}
<div class="station-card" role="group" aria-label="${esc(state.station?.name ?? 'Your station')}">
  <div class="station-card-art" aria-hidden="true">${state.station?.tracks?.find((t) => t.thumb)
    ? cover(null, 'cover', state.station.tracks.find((t) => t.thumb).thumb)
    : `<span class="station-card-mark">${icon('spark')}</span>`}</div>
  <div class="station-card-copy">
    <strong>${esc(state.station?.name ?? `${state.user?.name ?? 'Your'}'s station`)}</strong>
    <p>${esc(state.station?.blurb ?? 'Built from what you play through and like, then widened to their neighbours and the same lane.')}
      ${state.station && !state.station.empty ? '<span class="station-card-endless">Never runs out.</span>' : ''}</p>
  </div>
  <div class="station-card-actions">
    <button class="play-btn" data-action="play-station">${icon('play')}Play</button>
    <button class="secondary-btn" data-action="shuffle-station">${icon('shuffle', 'sm')}Shuffle</button>
  </div>
</div>

${sectionHeader('Jump back in', state.liked.size || h.recent.length ? 'Pick up right where you left off.' : 'Your recent tracks will appear here.', '', 'library')}
${quick.length
    ? `<div class="quick-grid">${quick.map((t) => `
      <button class="quick-card" data-track="${esc(t.videoId)}" aria-label="Play ${esc(t.title ?? t.videoId)}">
        ${cover(null, 'cover', t.thumb)}<span class="quick-title">${esc(t.title)}</span>
        <span class="mini-play">${icon('play')}</span></button>`).join('')}</div>`
    : emptyState({ art: 'clock', title: 'Nothing played yet',
      text: 'Play something and your recent tracks will wait for you here.',
      actions: '<button class="secondary-btn" data-page="search">Find music</button>' })}

${sectionHeader('Made for the moment', 'Your own playlists, ready when you are.', 'Browse library')}
${mixes.length
    ? `<div class="card-grid">${mixes.map((p) => card({
      collection: `p${p.id}`, art: p.artVideo ? `https://i.ytimg.com/vi/${p.artVideo}/hqdefault.jpg` : null,
      title: p.title, sub: `${p.trackCount} ${p.trackCount === 1 ? 'song' : 'songs'}`,
    })).join('')}</div>`
    : emptyState({ art: 'plus', title: 'No playlists yet',
      text: 'Group the songs you keep coming back to.',
      actions: `<button class="play-btn" data-action="create">${icon('plus')} New playlist</button>` })}

${sectionHeader('Liked songs', 'The ones you keep coming back to.', 'Open', 'library')}
<div class="quick-grid">
  <button class="quick-card" data-collection="liked">
    <span class="cover" style="display:grid;place-items:center;background:linear-gradient(135deg,#d59976,#8e5c83);color:#fff">${icon('heart')}</span>
    <span class="quick-title">Liked songs</span><span class="mini-play">${icon('play')}</span></button>
  <button class="quick-card" data-collection="recent">
    <span class="cover" style="display:grid;place-items:center;background:#25262c;color:#9b9ca5">${icon('clock')}</span>
    <span class="quick-title">Recently played</span><span class="mini-play">${icon('play')}</span></button>
</div>

${sectionHeader('A little discovery', 'Find something you did not know you needed.', 'Browse radio', 'radio')}
<div class="wide-feature">${cover(null, 'cover', h.radio[0]?.thumb, 'eager')}
  <div><span class="eyebrow">START HERE</span>
    <h3>${esc(h.radio[0]?.title ?? 'Pick a seed track')}</h3>
    <p>${esc(h.radio[0]?.channel ?? 'Search for an artist, then let sonora build an endless station from it.')}</p>
    <button data-action="${h.radio[0] ? 'play-track' : 'go-search'}" data-id="${esc(h.radio[0]?.videoId ?? '')}">
      Listen now ${icon('arrow-right', 'xs')}</button></div></div>`;
}

function searchPage() {
  return `<div class="page-head"><div><span class="page-overline">Explore something new</span>
    <h1 class="page-title">Search the sound<span class="accent">.</span></h1></div></div>
  <div class="search-shell" role="search">
    <div class="search-box">${icon('search')}
      <input id="primary-search" autocomplete="off" autocapitalize="none" spellcheck="false"
        enterkeyhint="search" type="search" value="${esc(state.search)}" aria-controls="search-results"
        placeholder="Songs, albums, artists, playlists…" aria-label="Search music">
      <button class="search-clear" data-action="clear-search" aria-label="Clear search" ${state.search ? '' : 'hidden'}>${icon('close', 'sm')}</button>
      <span class="kbd-hint">ESC</span></div>
  </div>
  <div id="search-results">${searchBody()}</div>`;
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
  return `<div class="search-filters" role="tablist" aria-label="Filter results by type">
    ${SEARCH_FILTERS.map((f) => {
    const n = f.count ? counts[f.count] ?? 0 : total;
    const selected = active === f.key;
    return `<button class="segment${selected ? ' is-active' : ''}" role="tab"
        aria-selected="${selected}" data-filter="${f.key}" data-search-type="${f.key}">${esc(f.label)}${n ? `<span class="seg-count">${n}</span>` : ''}</button>`;
  }).join('')}
  </div>`;
}

/** One shelf: a header carrying the shelf's own count, then its contents. */
const searchShelf = (title, count, body) => `<div class="section-head">
    <h2>${esc(title)} <span class="section-count">${count}</span></h2></div>${body}`;

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
        `<div class="library-grid">${albums.map(searchAlbumCard).join('')}</div>`)
      : (active === 'album' ? shelfEmpty('Albums') : ''));
  }
  if (shows('playlist')) {
    sections.push(playlists.length
      ? searchShelf('Playlists', counts.playlists ?? playlists.length,
        `<div class="library-grid">${playlists.map(searchPlaylistCard).join('')}</div>`)
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
      ? `<div class="library-grid">${likedCard}${playlists.map((p) => card({
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
      ? `<div class="library-grid">${all.map((a) => `
          <button class="music-card" data-action="artist" data-artist="${esc(/^UC[\w-]{20,}$/.test(a.id ?? '') ? a.id : a.title)}" aria-label="${esc(a.title)}">
            <div class="cover-wrap artist-wrap">${cover(null, 'cover artist-avatar', a.thumb)}</div>
            ${a.following ? '<span class="following-tag">Following</span>' : ''}
            <div class="music-card-title">${esc(a.title)}</div>
            <div class="music-card-sub">${esc(a.subscribers || 'Artist')}</div></button>`).join('')}</div>`
      : emptyState({ art: 'headphones', title: 'No artists yet',
        text: 'Artists you follow — and the ones you play enough of — collect here.',
        actions: '<button class="secondary-btn" data-page="search">Find an artist</button>' });
  } else {
    body = items.length
      ? `<div class="library-grid">${items.map((a) => card({
          collection: `a${a.id}`, art: a.thumb, title: a.title, sub: a.author || 'Album',
        })).join('')}</div>`
      : emptyState({ art: 'wave', title: 'No albums yet',
        text: 'Play a few tracks and albums from those artists will collect here.',
        actions: '<button class="secondary-btn" data-page="search">Browse music</button>' });
  }

  return `<div class="page-head"><div><span class="page-overline">Your music, your way</span>
      <h1 class="page-title">Your library<span class="accent">.</span></h1></div>
    <button class="secondary-btn" data-action="create">${icon('plus', 'sm')} New playlist</button></div>
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
      <h1 class="page-title">Turn it up<span class="accent">.</span></h1></div></div>
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
      <button class="text-link" data-page="search">All feelings ${icon('arrow-right')}</button></div>`;

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
    ? `<div class="library-grid">${playlists.map((p) => card({
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

function artistView() {
  const a = state.artist;
  if (!a) {
    return `<div class="artist-hero"><div class="sk sk-cover xl round"></div>
        <div class="sk-lines" style="flex:1;max-width:420px">
          <div class="sk sk-line w-35"></div><div class="sk sk-line w-70 tall"></div>
          <div class="sk sk-line w-60"></div></div></div>${skRows(6)}`;
  }
  if (a.error) {
    return emptyState({
      art: 'close', title: 'Could not load this artist', text: a.error,
      actions: `<button class="secondary-btn" data-action="retry-artist" data-id="${esc(a.key)}">Try again</button>
        <button class="secondary-btn" data-page="search">Back to search</button>`,
    });
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
      <div class="library-grid">${list.map((x) => card({
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
    if (known) trackIndex.set(videoId, { ...known, albumId });
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

function stationPage() {
  const s = state.station;
  const name = s?.name ?? 'Your station';
  const head = `<div class="page-head"><div><span class="page-overline">Made for your ears</span>
      <h1 class="page-title">${esc(name)}<span class="accent">.</span></h1></div>
      ${s && !s.empty ? `<button class="secondary-btn" data-action="rebuild-station">${icon('shuffle', 'sm')} Rebuild</button>` : ''}</div>`;

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
    ? `${rows.length} songs so far, and more arriving as you listen. Every skip and every play-through re-seeds the next stretch — the station grows instead of looping.`
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
  if (state.page === 'station' || (silent && state.page === 'home')) render();
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
    <button class="secondary-btn" data-admin="refresh">${icon('repeat', 'sm')} Refresh</button></div>
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
                required placeholder="At least 6 characters">
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

function trackRows(tracks, headers = true, collection = null) {
  if (!tracks.length) {
    return emptyState({ art: 'wave', title: 'Nothing here yet',
      text: collection ? 'Add a few songs and they will show up here.' : 'Play something and it will show up here.',
      actions: '<button class="secondary-btn" data-page="search">Find music</button>' });
  }
  rememberTracks(tracks);
  state.lastCollection = tracks;
  const act = current();
  const head = headers ? `<div class="track-header" aria-hidden="true"><span>#</span><span>Title</span>
    <span class="track-album">Album</span><span></span><span></span>
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
        role="row" tabindex="0" aria-label="Play ${esc(label)}"${isNow ? ' aria-current="true"' : ''}>
      <div class="track-index"><span>${i + 1}</span>
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>${icon('play', 'xs')}</div>
      <div class="track-details">${cover(null, 'cover', t.thumb, 'lazy')}
        <div class="track-desc"><div class="track-name">${esc(t.title ?? t.videoId)}</div>
          <div class="track-artist">${esc(t.channel ?? '')}</div></div></div>
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
  return `<div class="track-list ${headers ? '' : 'compact'}">${head}${rows}</div>`;
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
    <div class="rail-track-info"><div><h2>${esc(t.title)}</h2><span>${esc(t.channel ?? '')}</span></div>
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
    <div class="rail-queue">${up.map((x) => `<div class="queue-mini" data-action="play-track" data-id="${esc(x.videoId)}">
      ${cover(null, 'cover', x.thumb)}<div class="queue-text">
        <strong>${esc(x.title)}</strong><span>${esc(x.channel ?? '')}</span></div>
      <span class="duration">${fmt(x.durationS)}</span></div>`).join('')}</div>
    <div class="session-card"><span class="eyebrow">KEEP THE FEELING</span>
      <div class="session-title">${state.repeat === 2 ? 'Repeating this one.' : 'Your soundtrack, uninterrupted.'}</div>
      <p>${state.stationQueue
        ? `${state.queue.length} tracks so far, and more arriving as you listen. Every skip teaches sonora what you like.`
        : `${state.queue.length} tracks queued. Every skip teaches sonora what you like.`}</p></div>`;
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
      <div class="player-center"><div class="player-controls">
        <button data-action="prev" aria-label="Previous song" disabled>${icon('prev')}</button>
        <button class="main-toggle" data-action="playpause" aria-label="Play" disabled>${icon('play', 'fill')}</button>
        <button data-action="next" aria-label="Next song" disabled>${icon('next')}</button></div></div>
      <div class="player-extras"><button class="secondary-btn" data-page="search">${icon('search', 'sm')} Find music</button></div>`;
  }

  // The song block is just cover + title, so the title gets the whole left
  // column at every width. The taste actions sit with the other utilities.
  return `${progress}<div class="player-song">
      <button class="player-cover" data-action="nowplaying" aria-label="Open now playing">${cover(null, 'cover', t.thumb, 'eager')}</button>
      <button class="player-song-meta" data-action="nowplaying" aria-label="Open now playing">
        <strong>${esc(t.title)}</strong><span>${esc(t.channel ?? '')}${resuming ? ` · resumes at ${fmt(state.pendingResumeMs / 1000)}` : ''}</span></button>
      <button class="icon-btn player-like ${state.liked.has(t.videoId) ? 'primary' : ''}" data-action="heart"
        data-id="${esc(t.videoId)}" aria-pressed="${state.liked.has(t.videoId)}" aria-label="Like this song">${icon('heart', 'sm')}</button>
      <button class="icon-btn player-dislike ${state.disliked.has(t.videoId) ? 'is-disliked' : ''}" data-action="dislike"
        data-id="${esc(t.videoId)}" aria-pressed="${state.disliked.has(t.videoId)}"
        aria-label="${state.disliked.has(t.videoId) ? 'Undo "less like this"' : 'Play this less often'}"
        title="Less like this">${icon('thumb-down', 'sm')}</button></div>
  <div class="player-center"><div class="player-controls">
    <button class="ctrl ${state.shuffle ? 'on' : ''}" data-action="shuffle" aria-label="Shuffle" aria-pressed="${state.shuffle}">${icon('shuffle')}</button>
    <button class="ctrl" aria-label="Previous song" data-action="prev">${icon('prev')}</button>
    <button class="main-toggle" data-action="playpause" aria-label="${state.playing ? 'Pause' : 'Play'}">${icon(playIcon, 'fill')}</button>
    <button class="ctrl" aria-label="Next song" data-action="next">${icon('next')}</button>
    <button class="ctrl ${state.repeat ? 'on' : ''}" data-action="repeat" aria-label="Repeat ${['off', 'all', 'one'][state.repeat]}" aria-pressed="${state.repeat > 0}">${icon('repeat')}</button></div>
    <div class="timebar"><span class="elapsed">${fmt(pos)}</span>
      <input aria-label="Track progress" class="range" type="range" min="0" max="${Math.max(1, Math.floor(dur))}"
        value="${Math.floor(pos)}" style="--percent:${percent}%" data-slider="progress">
      <span class="duration">${fmt(dur)}</span></div></div>
  <div class="player-extras">
    <button class="icon-btn ${rooms.active ? 'room-on' : ''}" data-action="room"
      aria-label="${rooms.active ? 'Listen together — in a room' : 'Listen together'}" aria-haspopup="dialog">${icon('headphones')}</button>
    <button class="icon-btn" data-action="lyrics" aria-label="Lyrics" aria-haspopup="dialog">${icon('lyrics')}</button>
    <button class="icon-btn" data-action="queue" aria-label="Queue" aria-haspopup="dialog">${icon('queue')}</button>
    <button class="icon-btn" data-action="nowplaying" aria-label="Expand player" aria-haspopup="dialog">${icon('expand', 'sm')}</button>
    <div class="volume-group"><button class="icon-btn" data-action="mute" aria-label="${state.muted ? 'Unmute' : 'Mute'}">${icon(state.muted ? 'mute' : 'volume')}</button>
      <input class="range" aria-label="Volume" data-slider="volume" type="range" min="0" max="100"
        value="${Math.round(state.volume * 100)}" style="--percent:${Math.round(state.volume * 100)}%"></div></div>
  <div class="mobile-player-control">
    <button data-action="playpause" aria-label="${state.playing ? 'Pause' : 'Play'}">${icon(playIcon, 'fill')}</button>
    <button data-action="next" aria-label="Next song">${icon('next', 'fill')}</button></div>`;
}

async function render() {
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
}

function updatePlayer() {
  const el = $('player');
  const t = current();
  el.classList.toggle('is-playing', !!state.playing);
  el.classList.toggle('is-empty', !t);
  el.innerHTML = playerBar();
  const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t?.durationS || 0);
  const pos = playerPosition();
  if (dur) el.style.setProperty('--progress', `${(pos / dur) * 100}%`);
  if (!$('now-overlay').hidden) refreshOverlay();
}

/**
 * Where the playhead will be. A restored session has no loaded metadata yet,
 * so its saved position is the honest answer until the first `playing` seeks
 * there; showing 0:00 would make "resume" look like "restart".
 */
function playerPosition() {
  // A restored/adopted session has no loaded metadata yet, so its saved
  // position is the honest answer until the first `playing` seeks there.
  if (state.pendingResumeMs > 0 && !state.sourceStarted) return state.pendingResumeMs / 1000;
  return audio.currentTime || 0;
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
  if (target > 1 && target < duration - 2) {
    state.manualSeek = false;
    // Set lastTime first: assigning currentTime can fire `seeking`
    // synchronously, and a resume from a loaded 30 s playhead to 1.2 s must not
    // read as the loop wrap that skips the track.
    state.lastTime = target;
    audio.currentTime = target;
  }
}

// ── playback ────────────────────────────────────────────────────────────
function log(kind, extra = {}) {
  const t = current();
  if (!t) return;
  fetch('/api/events', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      videoId: t.videoId, kind, source: state.page,
      positionMs: Math.round((audio.currentTime || 0) * 1000),
      durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null,
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

async function saveSession({ force = false, takeover = false } = {}) {
  // In a room the playhead belongs to the server. Writing /api/now here would
  // fight it (and could steal the personal session from another device that is
  // genuinely playing), so the personal-session plumbing is simply off.
  if (rooms.active) return;
  const now = Date.now();
  if (!force && now - state.savedAt < 5000) return;
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
  const window = state.queue.slice(start, start + 60);
  const positionMs = Math.round(playerPosition() * 1000);
  let res;
  try {
    res = await fetch('/api/now', {
      method: 'PUT', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queue: window.map((x) => ({
          videoId: x.videoId,
          // Cap like the server does: `keepalive` requests are limited to 64 KB
          // total, and an unusually long title must not break the save.
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
        playing: !audio.paused && state.playing,
        // A user play intent claims the session; a periodic save does not.
        takeover: wantsTakeover,
      }),
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
  if (!nxt?.videoId) return;
  fetch(`/api/warm/${encodeURIComponent(nxt.videoId)}`, {
    method: 'POST', credentials: 'same-origin', keepalive: true,
  }).catch(() => {});
}

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
  const exclude = [...new Set([...state.queue.map((t) => t.videoId), ...sq.seen])]
    .filter(Boolean).slice(0, 400);
  try {
    const data = await api(`/api/station/next?cursor=${sq.cursor}&exclude=${encodeURIComponent(exclude.join(','))}`);
    const fresh = (data.tracks ?? []).filter((t) => t?.videoId && !state.queue.some((q) => q.videoId === t.videoId));
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
    // A new track was appended, so whatever was warmed is no longer the last
    // one in the queue — but the *next* one may not exist yet. Warm it now.
    if (state.queue.length === state.index + 2) warmNext();
    // The station page lists the live queue, so it has to repaint. Any other
    // page only needs the up-next rail: a full render there would rebuild the
    // search field and steal focus from someone typing.
    if (state.page === 'station') render();
    else { $('rail-content').innerHTML = rail(); updatePlayer(); }
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
  playIndex(0, { claim: true });
  notify(shuffle ? 'Shuffled — this station never ends' : 'Station playing · it never runs out', 'info');
}

/** Leaving the station (any other queue) stops the topping-up. */
function leaveStation() {
  state.stationQueue = null;
}

function playIndex(i, { resumeMs = 0, claim = false } = {}) {
  const t = state.queue[i];
  if (!t) { state.ending = false; return; }
  // A deliberate jump inside the shared queue is a room command; the snapshot
  // it returns is what actually moves the playhead (here and everywhere else).
  // `roomApplying` marks the writes the room itself made, so applying a remote
  // state cannot echo back as a command.
  if (rooms.active && !state.roomApplying) {
    rooms.command('select', { index: i, positionMs: resumeMs });
    return;
  }
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
  claimAudioSession();
  audio.loop = true;
  audio.src = `/api/stream/${t.videoId}`;
  warmNext();
  // Keep the station's runway full from the moment a track starts, not only
  // when the next one is requested: a lock-screen skip can arrive first.
  maybeExtendStation();
  // Name the new track on the lock screen while it buffers, not after it
  // starts — otherwise a phone locked mid-load shows the previous song.
  nowPlaying.sync({ metadata: true });
  audio.play().catch((err) => {
    console.warn('play blocked', err.message);
    state.playing = false;
    updatePlayer();
  });
  state.playing = true;
  render();
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
    playIndex(0, { claim: true });
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
  playIndex(idx, { claim: true });
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
  playIndex(0, { claim: true });
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
    // from another device.
    claimSession();
    audio.play().catch((err) => notify(err.message));
    state.playing = true;
  } else {
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
  const queueIdx = state.queue.map((_, i) => i);
  const upcomingIdx = [...queueIdx.slice(Math.max(0, state.index + 1)), ...queueIdx.slice(0, Math.max(0, state.index))];
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
          <h2>${esc(t.title)}</h2><p class="byline">${esc(t.channel ?? '')}</p></div>
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
  const dur = audio.duration || 0;
  if (dur) $('now-content').style.setProperty('--progress', `${(audio.currentTime / dur) * 100}%`);
  if (!$('drawer-overlay').hidden) drawerHtml();
  if (!$('auth-overlay').hidden) return;
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
    state.currentLyrics = null;
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
      <span class="queue-text"><strong>${title}</strong><span>${esc(t.channel ?? '')}</span></span>
      <span class="duration">${fmt(t.durationS)}</span></button>
    ${grip}</div>`;
}

function drawerHtml() {
  const entries = state.queue.map((t, i) => ({ t, i }));
  const playing = state.index >= 0 ? state.queue[state.index] : null;
  const upcoming = entries.slice(Math.max(0, state.index + 1));
  const earlier = entries.slice(0, Math.max(0, state.index));
  $('queue-drawer').innerHTML = `<div class="drawer-top"><div><span class="eyebrow">Playing queue</span>
      <h2>${state.queue.length} ${state.queue.length === 1 ? 'track' : 'tracks'}</h2></div>
      <button class="icon-btn" data-action="close-drawer" aria-label="Close queue">${icon('close')}</button></div>
    ${playing ? `<span class="eyebrow">Now playing</span><div class="drawer-list">${queueRow(playing, state.index, { current: true })}</div>` : ''}
    <div class="drawer-section"><span class="eyebrow">Up next</span><div class="drawer-list">
      ${upcoming.length ? upcoming.map(({ t, i }) => queueRow(t, i)).join('')
        : `<div class="np-empty small">${icon('queue')}<p>Nothing queued. Play a playlist or a station to fill this.</p></div>`}</div></div>
    ${earlier.length ? `<div class="drawer-section"><span class="eyebrow">Earlier</span><div class="drawer-list">${earlier.map(({ t, i }) => queueRow(t, i)).join('')}</div></div>` : ''}`;
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

/** Which visual slot (0…rows.length) the pointer is over. */
function queueInsertSlot(rows, clientY) {
  const dragged = queueDragRow();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === dragged) continue; // the dragged row has no height of its own
    const box = rows[i].getBoundingClientRect();
    if (clientY < box.top + box.height / 2) return i;
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
  const rows = queueRowEls(queueDragRow());
  for (const r of rows) r.classList.remove('drop-before', 'drop-after');
  const slot = queueInsertSlot(rows, clientY);
  queueDrag.target = queueTargetIndex(rows, queueDrag.fromIndex, slot);
  const dragged = queueDragRow();
  const mark = slot <= 0 ? rows[0] : rows[Math.min(slot, rows.length) - 1];
  if (!mark || mark === dragged) return;
  mark.classList.add(slot <= 0 ? 'drop-before' : 'drop-after');
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
    active: Boolean(grip),
    moved: false,
    surface: row.closest('#now-content, #queue-drawer'),
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
  const row = queueDragRow();
  if (!row) return;
  row.classList.add('dragging');
  row.style.transform = `translateY(${Math.round(dy)}px)`;
  // Let every surface that is open follow along: a re-render during the drag
  // (a track change, a room update) must not leave a stale row behind.
  paintQueueDrop(e.clientY);
}, { passive: false });

function finishQueueDrag(e, cancelled = false) {
  if (!queueDrag || e.pointerId !== queueDrag.pointerId) return;
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
  requestAnimationFrame(() => {
    const moved = surface?.querySelector(`[data-queue-row][data-video="${CSS.escape(row.dataset.video)}"]`)
      ?? document.querySelector(`[data-queue-row][data-video="${CSS.escape(row.dataset.video)}"]`);
    if (!moved) return;
    (grip ? moved.querySelector('[data-queue-grip]') : moved.querySelector('[data-action="play-track"]'))
      ?.focus({ preventScroll: true });
  });
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
  // The song that is playing is the same song; only where it sits changes.
  if (playing) state.index = Math.max(0, next.findIndex((t) => t.videoId === playing.videoId));
  refreshQueueViews({ forceOverlay: true });
  // Reordering is a queue edit, not a play intent: it is saved, but debounced so
  // a held-down Alt+Arrow cannot spam the session endpoint.
  clearTimeout(queueSaveTimer);
  queueSaveTimer = setTimeout(() => { saveSession({ force: true }); }, 250);
  return true;
}

/** Repaint every surface that lists the queue. */
function refreshQueueViews({ forceOverlay = false } = {}) {
  $('rail-content').innerHTML = rail();
  updatePlayer(); // player bar (+ the sheet, when it is open)
  if (forceOverlay && !$('now-overlay').hidden) refreshOverlay({ force: true });
  if (!$('drawer-overlay').hidden) drawerHtml();
  if (state.page === 'station') void render();
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
  const rows = prefKeys().map((key) => {
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
  if (!menu.hidden) menuTrigger = null;
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
    </div></div>`;

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

async function signOutEverywhere() {
  const ok = await ask({
    title: 'Sign out everywhere?',
    text: 'Every device loses its session, including this one. Saved-device tokens are destroyed, so nothing can silently sign itself back in.',
    confirmLabel: 'Sign out everywhere', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/auth/signout-all', { method: 'POST' });
    location.reload();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ── auth ────────────────────────────────────────────────────────────────
function showOffline() {
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
  if (!state.user) boot();
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

function showAuth() {
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
    if (password.length < 6) { if (error) error.textContent = 'Use at least 6 characters.'; return; }
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
          await loadPlaylists();
          setTimeout(async () => {
            if (state.collection === d.coll) await openCollection(d.coll, { history: 'none' });
            notify('Removed from playlist');
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
  switch (d.action) {
    case 'back':
      if (historyCursor.index > 0) {
        historyCursor.index -= 1;
        const x = historyEntries[historyCursor.index];
        if (x.page === 'collection' && x.collection) await openCollection(x.collection, { history: 'none' });
        else navigate(x.page, x.collection, false, x.mood);
      }
      break;
    case 'forward':
      if (historyCursor.index < historyEntries.length - 1) {
        historyCursor.index += 1;
        const x = historyEntries[historyCursor.index];
        if (x.page === 'collection' && x.collection) await openCollection(x.collection, { history: 'none' });
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
      const pl = state.collectionData;
      contextMenu(e, [
        { text: 'Add to queue', action: 'queue-collection', icon: 'queue', id: state.collection },
        { text: 'Delete playlist', action: 'delete-playlist', icon: 'close', id },
      ]);
      void pl;
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
        playIndex(0, { resumeMs, claim: true });
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
      if (audio.currentTime > 3) { seekTo(0); return; }
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
    case 'room-visibility': await setRoomVisibility(d.value); break;
    case 'room-control': await setRoomControl(d.value); break;
    case 'room-select':
      if (rooms.active) await rooms.command('select', { index: Number(d.index) });
      break;
    case 'room-queue-remove':
      if (rooms.active) await rooms.command('queue-remove', { index: Number(d.index) });
      break;
    case 'room-invite-user': await inviteUserById(Number(d.id)); break;
    case 'room-uninvite': await uninviteById(Number(d.id)); break;
    case 'open-room-page': closeFormSheet(); navigate('room', id); break;
    case 'shuffle':
      state.shuffle = !state.shuffle;
      store.set('shuffle', state.shuffle);
      notify(state.shuffle ? 'Shuffle on' : 'Shuffle off', 'info');
      updatePlayer();
      refreshOverlay();
      break;
    case 'repeat':
      state.repeat = (state.repeat + 1) % 3;
      store.set('repeat', state.repeat);
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
    case 'delete-playlist': {
      const pl = state.playlists.find((p) => p.id === Number(id)) ?? state.collectionData;
      confirmSheet({
        title: 'Delete this playlist?',
        text: `“${pl?.title ?? 'This playlist'}” and its ${pl?.trackCount ?? pl?.tracks?.length ?? 0} songs will be removed from sonora. Your YouTube account is untouched.`,
        confirmLabel: 'Delete playlist', danger: true,
        action: async () => {
          await api(`/api/playlists/${id}`, { method: 'DELETE' });
          await loadPlaylists();
          notify('Playlist deleted');
          navigate('library');
        },
      });
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
    clearSearchShelves(null);
    $('search-results').innerHTML = searchBody();
    searchTimer = setTimeout(runSearch, 380);
  }
  if (t.dataset.slider === 'progress') {
    // A drag is a human hand on the playhead: hold the room's correction loop
    // so it does not yank the slider back under the finger.
    if (rooms.active) rooms.hold(4000);
    state.manualSeek = true;
    // The `seeking` handler consumes this after the wrap test. Without it, a
    // drag whose `change` never fires would leave `manualSeek` armed forever,
    // and the queue would stop advancing at the end of every track.
    state.lockSeek = true;
    audio.currentTime = Number(t.value);
    state.pendingResumeMs = 0;
    state.lastTime = audio.currentTime;
    const dur = audio.duration || 1;
    document.querySelectorAll('input[data-slider="progress"]').forEach((x) => {
      x.value = t.value;
      x.style.setProperty('--percent', `${(Number(t.value) / dur) * 100}%`);
    });
    document.querySelectorAll('.elapsed').forEach((x) => { x.textContent = fmt(Number(t.value)); });
    if (dur) $('player').style.setProperty('--progress', `${(Number(t.value) / dur) * 100}%`);
  }
  if (t.dataset.slider === 'volume') {
    state.volume = Number(t.value) / 100;
    state.muted = state.volume === 0;
    audio.volume = state.volume;
    audio.muted = state.muted;
    t.style.setProperty('--percent', `${t.value}%`);
    store.set('volume', state.volume);
    store.set('muted', state.muted);
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
    state.manualSeek = false;
    // The command is sent on release, not on every input event: a drag would
    // otherwise be a flood of seeks for everyone else in the room.
    if (rooms.active) {
      rooms.hold(1500);
      rooms.command('seek', { positionMs: Math.round(Number(e.target.value) * 1000) });
    }
  }
});

$('now-overlay').addEventListener('click', (e) => { if (e.target.id === 'now-overlay') $('now-overlay').hidden = true; });
$('yt-overlay').addEventListener('click', (e) => { if (e.target.id === 'yt-overlay') e.currentTarget.hidden = true; });

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
$('drawer-overlay').addEventListener('click', (e) => { if (e.target.id === 'drawer-overlay') e.currentTarget.hidden = true; });

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

  // Reorder the queue from the keyboard: Alt+↑ / Alt+↓ with focus on a row or on
  // its grip. Plain arrows are left alone — they scroll the list.
  const queueRowEl = document.activeElement.closest?.('[data-queue-row]');
  if (queueRowEl && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    e.stopPropagation();
    reorderQueueRow(queueRowEl, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

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
  if (e.key === 'ArrowLeft' && e.altKey) { e.preventDefault(); nextTrack({ back: true }); }
  if (e.key === 'ArrowRight' && !e.altKey) { e.preventDefault(); if (audio.duration) seekTo(Math.min(audio.duration - 0.5, audio.currentTime + 5)); }
  if (e.key === 'ArrowLeft' && !e.altKey) { e.preventDefault(); seekTo(Math.max(0, audio.currentTime - 5)); }
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
//     roster, policy). Progress and sync are patched in place, so a command from
//     someone else never steals the invite field out from under the host.

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
  return [
    r.code, r.ended ? 'ended' : '', r.joined ? 'in' : 'out', state.roomStatus,
    r.private ? 'locked' : '', r.track?.videoId ?? '', r.queue?.length ?? 0, r.index ?? 0,
    r.visibility ?? '', r.control ?? '', r.host?.id ?? '',
    (state.roomMembers ?? []).map((m) => `${m.id}${m.online ? '*' : ''}`).join(','),
    state.roomGuests ?? 0,
    (state.roomInvites ?? []).length,
    (state.roomPeople ?? []).map((p) => `${p.id}${p.member ? 'm' : p.invited ? 'i' : ''}`).join(','),
  ].join('|');
}

function paintRoom({ force = false } = {}) {
  if (state.page !== 'room') { roomSig = ''; return; }
  const sig = roomSignature();
  if (force || sig !== roomSig) {
    roomSig = sig;
    render();
    return;
  }
  patchRoomSync();
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

const roomPersonChip = (m) => `<span class="room-person${m.online ? ' is-online' : ''}${m.role === 'host' ? ' is-host' : ''}">
  <span class="room-avatar" aria-hidden="true">${esc(initialOf(m.name))}</span>
  <span class="room-person-name">${esc(m.name)}</span>
  ${m.role === 'host' ? '<span class="room-host-tag">HOST</span>' : ''}
  <span class="sr-only">${m.online ? 'listening now' : 'offline'}</span></span>`;

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
        data-index="${i}" aria-label="Remove ${esc(x.title)} from the queue">${icon('close', 'sm')}</button>`}
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
        <span>${people.length} ${people.length === 1 ? 'person' : 'people'}</span></div>
      <div class="room-people-row">${people.map(roomPersonChip).join('')}${(state.roomGuests ?? room.guests ?? 0) > 0
    ? `<span class="room-person is-guest"><span class="room-avatar" aria-hidden="true">+${state.roomGuests ?? room.guests}</span><span class="room-person-name">listening as guests</span></span>` : ''}</div>
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
  if (state.roomStatus === 'ended' || room.ended) return roomEndedPage();
  if (state.roomStatus === 'private' || room.private) return roomGate({ locked: true, code });
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
  return `<button class="modal-close" data-action="close-form" aria-label="Close">${icon('close')}</button>
    <div class="form-body"><span class="eyebrow">Listening together</span>
      <h2>${esc(room.host?.name ?? 'Someone')}’s room</h2>
      <p class="form-desc"><span data-room-sync="${roomSyncState()}">${esc(roomSyncLabel())}</span>
        · <b data-room-online>${onlineCount()}</b> listening</p>
      <div class="room-people-row room-sheet-people">${(state.roomMembers.length ? state.roomMembers : (room.members ?? [])).map(roomPersonChip).join('')}</div>
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


// ── iOS audio session plumbing ──────────────────────────────────────────
/**
 * A deliberate seek. Marking it is what keeps the loop-wrap detector from
 * treating "previous", a keyboard jump, or a resume as the end of a track.
 * `lockSeek` is consumed by the `seeking` handler after the wrap test, so the
 * guard cannot outlive its seek.
 */
function seekTo(seconds) {
  const to = Math.max(0, Number(seconds) || 0);
  state.pendingResumeMs = 0;
  state.manualSeek = true;
  state.lockSeek = true;
  state.lastTime = to;
  audio.currentTime = to;
}

audio.loop = true;
audio.volume = state.volume;
audio.muted = state.muted;
bindSheetSwipe();

boot();

// The lock screen is its own renderer: it needs metadata, an artwork URL it is
// allowed to fetch, and an explicit position state before it will draw a seek
// bar. All three live in media-session.js so they can be tested.
const nowPlaying = createMediaSession({
  audio,
  base: location.href,
  getTrack: () => current(),
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
      if (rooms.active) {
        rooms.command('pause', { positionMs: Math.round((audio.currentTime || 0) * 1000) });
        return;
      }
      audio.pause();
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
      if (audio.currentTime > 3) seekTo(0);
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
    onSeekEnd: () => { state.lastTime = audio.currentTime; updatePlayer(); },
  },
});

/**
 * The track ended. Called from both `seeking` and `timeupdate` because WebKit
 * on a locked iPhone can report the loop jump through only one of them; the
 * guard makes the pair idempotent, so one wrap can never skip two tracks.
 */
function endTrack() {
  if (state.ending) return;
  state.ending = true;
  // Pause first: pausing does not close the audio session, a natural end does.
  audio.pause();
  log('complete');
  if (rooms.active) {
    // The room decides what plays next. This is a natural continuation, which
    // any member may trigger, so a host with a locked phone cannot freeze the
    // group on the last second of a track.
    state.ending = false;
    state.playing = false;
    updatePlayer();
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
  nextTrack();
}

// Belt and braces: with `loop` on, `ended` should never fire, and on iOS it
// must not (a natural end closes the audio session). If an engine still emits
// it, advancing here is better than stopping on the last second of a track.
// `switching` filters a stale `ended` that arrives while the next source loads.
audio.addEventListener('ended', () => { if (!state.switching) endTrack(); });

audio.addEventListener('seeking', () => {
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
  // Some engines — WebKit on a locked iPhone is the one that matters — loop
  // without emitting `seeking`. The jump is still visible here, and this is
  // the only chance to advance the queue before the same song repeats forever.
  // Test before lastTime is overwritten and before the seek flag is cleared,
  // so a deliberate seek to 0 is still not mistaken for the end.
  if (isLoopWrap(state.lastTime, audio.currentTime, {
    manualSeek: state.manualSeek, started: state.sourceStarted,
  })) {
    endTrack();
    return;
  }
  // Safety net for a lock-screen seek that never moved the playhead (no
  // `seeking` event fires then): by the time timeupdate runs, any seek that
  // did happen has already been consumed above.
  if (state.lockSeek) { state.lockSeek = false; state.manualSeek = false; }
  if (!state.manualSeek) state.lastTime = audio.currentTime;
  const dur = audio.duration || 0;
  // Keeps the lock-screen scrubber honest while it is visible. Throttled
  // inside the module; this is a no-op when paused.
  if (state.playing) nowPlaying.position();
  document.querySelectorAll('input[data-slider="progress"]').forEach((x) => {
    if (document.activeElement === x) return;
    x.value = String(Math.floor(audio.currentTime));
    if (dur) x.style.setProperty('--percent', `${(audio.currentTime / dur) * 100}%`);
  });
  document.querySelectorAll('.elapsed').forEach((x) => { x.textContent = fmt(audio.currentTime); });
  const t = current();
  if (dur) $('player').style.setProperty('--progress', `${(audio.currentTime / dur) * 100}%`);
  // Keep the expanded sheet's scrubber honest without rebuilding it (a rebuild
  // would fight the user's focus and the lyrics scroll position).
  if (!$('now-overlay').hidden) {
    const sheet = $('now-content');
    const input = sheet.querySelector('[data-slider="progress"]');
    if (input && document.activeElement !== input) {
      input.value = String(Math.floor(audio.currentTime));
      if (dur) input.style.setProperty('--percent', `${(audio.currentTime / dur) * 100}%`);
    }
    sheet.querySelectorAll('.elapsed').forEach((x) => { x.textContent = fmt(audio.currentTime); });
  }
  if (t && state.playing) saveSession();
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
  state.failures = 0;
  state.sourceStarted = true;
  state.switching = false;
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
  }
  state.playing = false;
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
  console.warn('audio error', audio.error?.code, t.videoId);
  state.failures += 1;
  const failing = state.startedAt;
  state.startedAt = null;

  if (state.failures > 3) {
    // Stop churning through the queue and say why, if the server knows why.
    state.playing = false;
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
  setTimeout(() => {
    if (state.failures > 3 || state.startedAt !== null) return;
    if (failing === null) return;
    nextTrack();
  }, 400 * state.failures);
});

document.addEventListener('visibilitychange', () => {
  // Locking the phone is the moment the audio session can be lost with nothing
  // to report it, so repair the category on the way out and on the way back in
  // (public/audio-session.js explains why re-asserting alone does not work).
  repairAudioSession();
  // A room is a live connection: come back by re-reading it, not by trusting
  // whatever the stream managed to deliver while the tab was frozen.
  if (rooms.active) {
    if (document.visibilityState === 'visible') rooms.syncNow();
    return;
  }
  if (document.visibilityState === 'hidden') {
    if (!audio.paused) log('progress');
    saveSession({ force: true });
    return;
  }
  // Coming back to an idle app is the natural moment to notice that the phone
  // kept playing: adopt its newer session instead of offering a stale position.
  if (audio.paused && !state.playing) refreshSessionFromServer();
  // iOS can interrupt the audio session (a call, Siri, another app taking the
  // output) and leave the element paused while this tab still believes it is
  // playing, or while it was paused *for* us (see the pause handler). Nothing
  // resumes it by itself, so do it here rather than waiting for a tap: a play()
  // is allowed again now that the page is visible.
  if (state.resumeOnVisible) resumeAfterInterruption();
  else if (state.playing && audio.paused) resumeAfterInterruption();
});

/**
 * This tab was playing and is not any more, for a reason that was not the user.
 *
 * Re-claims the session, starts the element, and — if the browser still refuses
 * — stops pretending: a transport that says "playing" while nothing plays is
 * worse than an honest pause.
 */
function resumeAfterInterruption() {
  state.resumeOnVisible = false;
  // Signed out: the element was paused by the sign-in screen, not by iOS, and
  // playing it again would only 401 the stream.
  if ($('auth-overlay') && !$('auth-overlay').hidden) return;
  state.playing = true;
  claimAudioSession();
  audio.play().catch(() => {
    if (!audio.paused) return;
    state.playing = false;
    updatePlayer();
  });
}

// A frozen page comes back with a fresh process chain behind the same DOM: the
// category has to be sent again, not remembered. `pageshow` also covers a
// restore from the back/forward cache, which fires no `visibilitychange`.
addEventListener('pageshow', () => repairAudioSession());
addEventListener('resume', () => repairAudioSession({ force: true }));

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
    clearSearchShelves([]);
    notify(err.message, 'error');
  }
  if ($('search-results') && state.page === 'search') $('search-results').innerHTML = searchBody();
}

async function loadPlaylists() {
  const { playlists } = await api('/api/playlists');
  state.playlists = playlists;
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
  state.likedTracks = tracks;
  state.liked = new Set(tracks.map((t) => t.videoId));
}

async function loadDislikes() {
  const { tracks } = await api('/api/dislikes');
  state.disliked = new Set(tracks.map((t) => t.videoId));
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
  if (idx < state.index) { state.index -= 1; return; }
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
  playIndex(Math.min(idx, state.queue.length - 1));
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

async function openCollection(collection, { history = 'push' } = {}) {
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
  applyRoute({ page: 'collection', collection }, { scroll: true });
  document.title = pageTitle();

  try {
    if (collection === 'liked') {
      await loadLikes();
    } else if (collection.startsWith('p')) {
      const { playlist } = await api(`/api/playlists/${Number(collection.slice(1))}`);
      state.collectionData = playlist;
    } else if (collection.startsWith('a')) {
      const ytId = collection.slice(1);
      const known = state.browse.albums?.find((a) => a.id === ytId)
        ?? state.mood?.playlists?.find((p) => p.id === ytId);
      const data = await api(`/api/album/${encodeURIComponent(ytId)}`);
      const tracks = data.tracks ?? [];
      state.collectionData = {
        title: data.title ?? known?.title ?? tracks[0]?.album ?? 'Album',
        author: data.author ?? known?.author ?? tracks[0]?.channel,
        authorId: data.authorId ?? null,
        type: data.type ?? 'Album',
        // The release's own cover, not its first track's video still.
        art: data.thumb ?? known?.thumb ?? tracks[0]?.thumb ?? null,
        tracks,
      };
      state.albumTracks = { id: ytId, title: state.collectionData.title, author: state.collectionData.author, tracks };
    }
  } catch (err) {
    state.collectionError = err.message;
  }
  if (state.collection !== collection) return;
  state.collectionLoading = false;
  await render();
  document.title = pageTitle();
  if (state.page === 'collection') $('main-scroll').scrollTop = 0;
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
  const existing = state.queue.findIndex((x) => x.videoId === videoId);
  if (existing >= 0) state.queue.splice(existing, 1);
  const at = Math.min(state.queue.length, Math.max(0, state.index + 1));
  state.queue.splice(at, 0, { ...t, videoId });
  notify('Playing next', 'info');
  render();
  refreshOverlay();
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
  refreshQueueViews({ forceOverlay: true });
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
    'devices', 'passkeys'];
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

async function boot() {
  // Check the server before anything else. The app is served from disk per
  // request but the routes are frozen at process start, so a server left
  // running across a deploy hands the new bundle old routes. Saying that once,
  // up front, is the difference between "the deploy went wrong" and "the app is
  // broken".
  await checkServer();

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

  await Promise.all([
    loadLikes(),
    loadDislikes().catch(() => {}),
    loadPlaylists(),
    api('/api/recent').then((r) => { state.home.recent = r.tracks; }).catch(() => {}),
  ]);

  // The pinned station is on the home page, so fetch it in the background (it
  // costs a couple of YouTube calls). Failures stay silent here: the station
  // page reports its own error if the user opens it.
  loadStation({ silent: true });

  // Restore the last session the phone was playing.
  try {
    const { state: saved, updatedAt } = await api('/api/now');
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
  } catch {}

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
    try { history.replaceState({ i: 0 }, '', routePath(route.page, route.collection, route.mood)); } catch {}
  }
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
