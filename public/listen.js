// The listener page for a public room — no account involved.
//
// It reuses the same sync engine the signed-in app uses (`public/rooms.js`),
// against the `/api/public/rooms` endpoints, so there is exactly one clock and
// one drift algorithm in the codebase rather than a second, subtly different
// one for guests. What is different is what it cannot do: a guest has no
// commands. The playhead is the host's (and the room's) to move; this page
// follows it, and says so.
//
// The page is a room, not a bare player: the now-playing side owns the sound
// and the honest transport state, the queue side is the live running order
// (current, up next, played earlier) and the room's facts. A guest can see the
// whole set list even though they cannot change it.

import { createAudioSession } from './audio-session.js';
import { createRoomSync } from './rooms.js';

const code = document.body.dataset.room;
const audio = document.getElementById('listen-audio');
const $ = (id) => document.getElementById(id);
// A guest page is as much a music player as the app: without the playback
// category iOS silences it with the Ring/Silent switch (and, on a locked phone,
// with the screen), so the tap that starts the room claims it. See
// public/audio-session.js for why the category also has to be re-sent later.
const audioSession = createAudioSession();

/**
 * A room joins at 5%, not at 100%.
 *
 * Someone opening a link in a quiet room, a lecture or a sleeping house should
 * not have the room shouted at them; the control is right there if they want it
 * louder. Deliberately not persisted: this is a fresh visitor, not a profile.
 */
const DEFAULT_VOLUME = 0.05;
let volume = DEFAULT_VOLUME;
let muted = false;

let started = false;
let currentId = null;
let pendingResumeMs = null;
let lastBarAt = 0;
let lastMetaAt = 0;
let lastQueueSig = '';

/**
 * Which view is open.
 *
 * The player is the default because it is the one that answers the questions a
 * listener actually has — what is playing, what follows, how long the queue
 * runs. The venue is a second way to see the same room, chosen deliberately and
 * remembered: it is the thing a person comes back to, not the thing they land
 * on. A `?view=venue` link opens it for one visit without overwriting that
 * choice, which is what makes it safe to send to someone.
 */
const VIEW_KEY = 'sonora.listen.view';
const readView = () => {
  try { return localStorage.getItem(VIEW_KEY) === 'venue' ? 'venue' : 'player'; } catch { return 'player'; }
};
const saveView = (next) => {
  try { localStorage.setItem(VIEW_KEY, next); } catch { /* private mode: the choice lasts the visit */ }
};
let view = readView();
if (new URLSearchParams(location.search).get('view') === 'venue') view = 'venue';
document.body.dataset.view = view;
let venue = null;
let venueLoading = null;

const START_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
const END_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmt = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A queue is measured in minutes, not seconds. */
const fmtLong = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return '<1 min';
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
};

const listenAgo = (ts) => {
  if (!Number.isFinite(ts)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

const artUrl = (videoId) => `/t/${encodeURIComponent(videoId)}/art.jpg`;

const setText = (id, text) => {
  const el = $(id);
  if (el) el.textContent = text;
};

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = res.headers.get('content-type')?.includes('json')
    ? await res.json().catch(() => ({}))
    : null;
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
};

const showError = (message) => {
  const el = $('listen-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
};

const clearError = () => {
  const el = $('listen-error');
  if (el) el.hidden = true;
};

// ── the running order ──────────────────────────────────────────────────

/** One row of the live set list. Escaped here, once, for every repaint. */
function rowHtml(track, index, state) {
  const now = state === 'now';
  const played = state === 'played';
  const duration = track.durationS > 0 ? fmt(track.durationS) : '';
  return `<li class="q-row${now ? ' is-now' : ''}${played ? ' is-played' : ''}"${now ? ' aria-current="true"' : ''} data-video-id="${esc(track.videoId)}">
    <span class="q-mark" aria-hidden="true">${now
      ? '<span class="eq"><i></i><i></i><i></i></span>'
      : `<span class="q-num">${index + 1}</span>`}</span>
    <span class="q-art" style="background-image:url(&quot;${esc(artUrl(track.videoId))}&quot;)" aria-hidden="true"></span>
    <span class="q-copy"><span class="q-titleline"><strong>${esc(track.title ?? track.videoId)}</strong>${now ? '<span class="q-flag">Now playing</span>' : ''}</span><span class="q-sub">${esc(track.channel ?? '')}</span></span>
    <span class="q-dur">${esc(duration)}</span>
  </li>`;
}

function paintNowIndex(snapshot) {
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  const index = Number.isInteger(snapshot?.index) ? snapshot.index : 0;
  setText('listen-now-index', queue.length ? `Track ${Math.min(index + 1, queue.length)} of ${queue.length}` : 'Waiting for music');
}

function paintQueueMeta(snapshot) {
  const el = $('listen-queue-meta');
  if (!el) return;
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  const index = Number.isInteger(snapshot?.index) ? Math.max(0, Math.min(snapshot.index, Math.max(0, queue.length - 1))) : 0;
  const current = queue[index];
  if (!current) { el.textContent = 'Waiting for a track'; return; }
  const upcoming = queue.slice(index + 1);
  // While this tab is actually playing the current track, its own clock is the
  // most honest source for "how much is left"; before that the room's snapshot
  // is. Both answer the same question, just from different sides of the sync.
  const positionMs = started && currentId === current.videoId && Number.isFinite(audio.currentTime)
    ? audio.currentTime * 1000
    : (snapshot.positionMs ?? 0);
  let remainingMs = 0;
  let hasDuration = false;
  if (current.durationS > 0) {
    remainingMs += Math.max(0, current.durationS * 1000 - positionMs);
    hasDuration = true;
  }
  for (const t of upcoming) {
    if (t.durationS > 0) { remainingMs += t.durationS * 1000; hasDuration = true; }
  }
  el.textContent = `${upcoming.length ? `${upcoming.length} up next` : 'Last track'}${hasDuration ? ` · ${fmtLong(remainingMs / 1000)} left` : ''}`;
}

function paintQueue(snapshot) {
  if (!snapshot) return;
  const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
  const index = Number.isInteger(snapshot.index)
    ? Math.max(0, Math.min(snapshot.index, Math.max(0, queue.length - 1)))
    : 0;
  const sig = `${queue.map((t) => t.videoId).join('|')}#${index}`;
  if (sig !== lastQueueSig) {
    lastQueueSig = sig;
    const current = queue[index];
    const upcoming = current ? queue.slice(index + 1) : [];
    const played = current ? queue.slice(0, index).reverse() : [];
    const list = $('listen-queue');
    if (list) {
      list.innerHTML = (current ? rowHtml(current, index, 'now') : '')
        + upcoming.map((t, i) => rowHtml(t, index + 1 + i, 'next')).join('');
    }
    const empty = $('listen-queue-empty');
    if (empty) empty.hidden = Boolean(current);
    const end = $('listen-queue-end');
    if (end) end.hidden = !(current && !upcoming.length);
    const playedBox = $('listen-played');
    if (playedBox) playedBox.hidden = !played.length;
    const playedList = $('listen-played-list');
    if (playedList) playedList.innerHTML = played.map((t, i) => rowHtml(t, index - 1 - i, 'played')).join('');
    setText('listen-played-count', String(played.length));
    const count = $('listen-queue-count');
    if (count) {
      count.textContent = String(queue.length);
      count.setAttribute('aria-label', `${queue.length} tracks`);
    }
    // A new current track is the new top of the set list. If the panel had been
    // scrolled down the old runway, bring the new one back into view.
    const scroll = $('listen-queue-scroll');
    if (scroll) scroll.scrollTop = 0;
  }
  paintNextUp(queue, index);
  paintNowIndex(snapshot);
  paintQueueMeta(snapshot);
  markPlaying(Boolean(snapshot.playing && !snapshot.ended));
}

// ── now playing and the room ───────────────────────────────────────────

/**
 * The one-glance "what is next" on the player side.
 *
 * The full running order lives in its own column (or further down the page on a
 * phone), so on a wide screen the player would otherwise end in dead space and
 * a listener would have to look away from the track to know what follows it.
 */
function paintNextUp(queue, index) {
  const box = $('listen-next-up');
  if (!box) return;
  const next = queue[index + 1] ?? null;
  box.hidden = !next;
  if (!next) return;
  setText('listen-next-title', next.title ?? next.videoId);
  setText('listen-next-sub', next.channel ?? '');
  setText('listen-next-dur', next.durationS > 0 ? fmt(next.durationS) : '');
  const art = $('listen-next-art');
  if (art) art.style.backgroundImage = `url("${artUrl(next.videoId)}")`;
}

function paintTrack(track) {
  if (!track) {
    setText('listen-title', 'Waiting for music');
    setText('listen-artist', '');
    setText('listen-mini-title', 'Waiting for music');
    if (!started && sync?.status !== 'ended') setStartButton('Waiting for music', true);
    return;
  }
  const title = track.title ?? track.videoId;
  const url = artUrl(track.videoId);
  setText('listen-title', title);
  setText('listen-artist', track.channel ?? '');
  setText('listen-mini-title', title);
  const art = $('listen-art');
  if (art && art.getAttribute('src') !== url) art.src = url;
  const glow = $('listen-glow');
  if (glow) glow.style.backgroundImage = `url("${url}")`;
  const miniArt = $('listen-mini-art');
  if (miniArt && miniArt.getAttribute('src') !== url) miniArt.src = url;
  document.title = `${title} · listen together · sonora`;
  if (!started && sync?.status !== 'ended') setStartButton('Listen live', false);
}

function paintRoom(snapshot) {
  if (!snapshot) return;
  const host = snapshot.host?.name ?? 'Someone';
  setText('listen-host', host);
  setText('listen-room-host', host);
  setText('listen-host-avatar', String(host).trim().charAt(0).toUpperCase() || '?');
  setText('listen-code', String(snapshot.code ?? code).toUpperCase());
  setText('listen-room-control', snapshot.control === 'host' ? 'Host only' : 'Everyone');
  setText('listen-room-note', snapshot.control === 'host'
    ? 'Anyone with the link can listen. The host controls playback.'
    : 'Anyone with the link can listen. Signed-in members can change the music.');
  setText('listen-room-started', listenAgo(snapshot.createdAt));
}

const paintListeners = () => {
  // The room's own count (members with an open stream + guests). A guest page
  // shows the number, never the roster.
  const n = String(Math.max(1, sync.listeners ?? 0));
  setText('listen-listeners', n);
  setText('listen-room-listeners', n);
};

// ── status, sync, volume and progress ─────────────────────────────────

const paintStatus = (status, error) => {
  const el = $('listen-status');
  const dot = el?.querySelector('span');
  if (el && dot) {
    const text = {
      idle: 'Ready', connecting: 'Connecting…', live: 'Live', polling: 'Live', error: 'Reconnecting…',
      ended: 'Ended', private: 'Invite only',
    }[status] ?? status;
    dot.textContent = error && status === 'error' ? 'Reconnecting…' : text;
    el.classList.toggle('live', status === 'live' || status === 'polling');
  }
  document.body.dataset.status = status ?? '';
  setText('listen-stage-label', {
    live: 'Live', polling: 'Live', connecting: 'Connecting', error: 'Reconnecting', ended: 'Ended', idle: 'Ready',
  }[status] ?? 'Live');
  if (status === 'ended') {
    const overlay = $('listen-overlay');
    if (overlay) overlay.hidden = false;
    setStartButton('Room ended', true, END_ICON);
    const mini = $('listen-mini');
    if (mini) mini.hidden = true;
    document.body.classList.remove('mini-on');
    showError(error ?? 'This room has ended.');
  }
};

const paintSync = (ms) => {
  const el = $('listen-sync');
  if (!el) return;
  // An ended room has no playhead to be off from, so the badge stops claiming
  // a measurement it can no longer take.
  if (sync.status === 'ended') {
    el.dataset.sync = 'idle';
    el.textContent = '—';
    return;
  }
  // Before the visitor has started playback the element is parked at the room's
  // position and cannot follow, so the honest label is "waiting for you", not a
  // growing "off by" — the number is a claim about *playing* audio.
  if (!started) {
    el.dataset.sync = 'idle';
    el.textContent = 'Ready';
    return;
  }
  const d = Math.abs(ms);
  if (d < 150) { el.dataset.sync = 'good'; el.textContent = 'In sync'; }
  else if (d < 1000) { el.dataset.sync = 'warn'; el.textContent = `Sync ${(d / 1000).toFixed(1)}s`; }
  else { el.dataset.sync = 'bad'; el.textContent = `Off by ${(d / 1000).toFixed(1)}s`; }
};

function paintProgress() {
  const dur = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (sync.room?.track?.durationS > 0 ? sync.room.track.durationS : 0);
  const cur = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const percent = dur ? Math.min(100, (cur / dur) * 100) : 0;
  const bar = $('listen-bar');
  if (bar) {
    bar.firstElementChild.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  }
  const miniBar = $('listen-mini-bar');
  if (miniBar) miniBar.style.width = `${percent}%`;
  setText('listen-elapsed', fmt(cur));
  setText('listen-duration', dur ? fmt(dur) : '–:––');
  setText('listen-current-left', dur ? `${fmt(Math.max(0, dur - cur))} left` : '');
  setText('listen-mini-time', `${fmt(cur)} / ${dur ? fmt(dur) : '–:––'}`);
  // The venue draws the same clock on the projector and under the room; it is
  // fed from here so there is one timer, not two.
  venue?.paintProgress({ currentTime: cur, duration: dur, ended: Boolean(sync.room?.ended) });
}

function markPlaying(on) {
  document.body.dataset.playing = on ? '1' : '0';
  const nowRow = document.querySelector('#listen-queue .q-row.is-now');
  if (nowRow) nowRow.classList.toggle('is-paused', !on || Boolean(sync.room?.ended));
}

function setStartButton(label, disabled = false, icon = START_ICON) {
  const btn = $('listen-start');
  if (!btn) return;
  btn.disabled = disabled;
  btn.innerHTML = `${icon}${esc(label)}`;
}

const paintVolume = () => {
  const slider = $('listen-volume');
  const label = $('listen-vol-label');
  const btn = $('listen-mute');
  const miniBtn = $('listen-mini-mute');
  const effective = muted ? 0 : volume;
  audio.volume = effective;
  audio.muted = false; // volume 0 is the mute; the element's flag is not used
  if (slider) {
    slider.value = String(Math.round(effective * 100));
    slider.style.setProperty('--fill', `${Math.round(effective * 100)}%`);
  }
  if (label) label.textContent = muted ? 'Muted' : `${Math.round(effective * 100)}%`;
  for (const button of [btn, miniBtn]) {
    if (!button) continue;
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }
  const wave = muted ? 'M19 9.5l3.5 5M22.5 9.5l-3.5 5' : 'M16.5 8.5a5 5 0 0 1 0 7';
  $('listen-vol-wave')?.setAttribute('d', wave);
  $('listen-mini-vol-wave')?.setAttribute('d', wave);
  // The venue has its own mute and slider (the player is hidden there), so the
  // one source of truth for the level has to paint both.
  venue?.paintVolume({ muted, volume });
};

// ── view switching ─────────────────────────────────────────────────────
// The venue module is imported on first use: a guest who never opens it never
// downloads it, which is the whole point of a non-default view.
const viewButtons = [...document.querySelectorAll('.view-btn')];

async function ensureVenue() {
  if (venue) return venue;
  if (!venueLoading) {
    venueLoading = import('./listen-venue.js').then(({ mountVenue }) => {
      venue = mountVenue($('listen-venue-host'), {
        onExit: () => setView('player'),
        onMute: () => toggleMute(),
        onShare: () => copyRoomLink($('listen-copy')),
        onVolume: (next) => {
          volume = Math.min(1, Math.max(0, next));
          if (volume > 0) muted = false;
          paintVolume();
        },
      });
      if (sync.room) venue.paint(sync.room);
      venue.paintVolume({ muted, volume });
      return venue;
    });
  }
  return venueLoading;
}

async function setView(next, { persist = true } = {}) {
  const target = next === 'venue' ? 'venue' : 'player';
  view = target;
  document.body.dataset.view = view;
  for (const btn of viewButtons) btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
  if (view === 'venue') {
    const api = await ensureVenue();
    api.show();
    if (sync.room) api.paint(sync.room);
    api.paintVolume({ muted, volume });
  } else {
    venue?.hide();
    paintProgress();
  }
  if (persist) saveView(view);
  updateMini();
}

for (const btn of viewButtons) {
  btn.addEventListener('click', () => setView(btn.dataset.view));
}

// ── one tap, one room ─────────────────────────────────────────────────

/**
 * Autoplay cannot be assumed. Browsers only allow a play() that follows a real
 * gesture, so the first one happens inside the click; if a later one is refused
 * (a phone that locked, a tab that was backgrounded) the overlay comes back
 * with an honest "Tap to resume" rather than silent nothing.
 */
function showResume() {
  // A stale rejection must not undo a successful start: play() promises reject
  // with AbortError when a src changes under them, and the correction loop tries
  // play() on its own (without a gesture) until the visitor unlocks audio.
  if (!audio.paused) return;
  if (sync.status === 'ended') return;
  const overlay = $('listen-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  setStartButton('Tap to resume', false);
}

// The room page uses one shared engine; a guest scores `guests` in the snapshot
// only, so the count shown here is the room's, not this tab's.
const sync = createRoomSync({
  api,
  audio,
  basePath: '/api/public/rooms',
  hooks: {
    currentTrackId: () => currentId,
    isLoaded: (videoId) => currentId === videoId && audio.readyState >= 1,
    loadTrack: (snapshot) => {
      const track = snapshot.track;
      if (!track?.videoId) return;
      paintTrack(track);
      pendingResumeMs = Math.max(0, Math.round(snapshot.positionMs ?? 0));
      // The element was already unlocked by the start gesture; unless the room
      // is on a different track than the one primed, keep the source (and the
      // unlock) and just move the playhead.
      if (currentId === track.videoId && audio.src && !audio.src.startsWith('data:')) {
        applyPendingResume();
      } else {
        currentId = track.videoId;
        audio.src = `/api/stream/${track.videoId}`;
        audio.load();
      }
      paintProgress();
      if (snapshot.playing && started) audio.play().catch(showResume);
    },
    play: () => { if (started) audio.play().catch(showResume); },
    pause: () => { audio.pause(); },
    seek: (seconds) => {
      try { audio.currentTime = Math.max(0, seconds); } catch { /* not seekable yet */ }
    },
    setRate: (rate) => {
      const r = Math.min(1.5, Math.max(0.5, Number(rate) || 1));
      try { audio.playbackRate = r; } catch { /* ignore */ }
    },
    onSnapshot: (snapshot) => {
      if (!snapshot) return;
      paintTrack(snapshot.track ?? null);
      paintQueue(snapshot);
      paintRoom(snapshot);
      paintListeners();
      // The venue is a view of the same snapshot: it never fetches, and it
      // never needs to know that the player exists.
      venue?.paint(snapshot);
    },
    onMembers: () => paintListeners(),
    onStatus: ({ status, error }) => paintStatus(status, error),
    // The correction loop's drift is only meaningful while this element is
    // actually following the room; `paintSync` decides that from `started`.
    onDrift: (ms) => paintSync(ms),
    notify: (message, level) => { if (level === 'error') showError(message); },
  },
});

/**
 * One tap, and the room is playing.
 *
 * The page arrives with the guest cookie already set (the server mints it with
 * the HTML), so everything that does not need a gesture has already happened by
 * the time the visitor taps: the stream is open, the clock is calibrated and the
 * *real* audio source is loaded and seeked. The tap is therefore a plain
 * play() on a ready element — which every browser allows — rather than a dance
 * of silent placeholders that leaves a guest pressing Listen live twice.
 */
$('listen-start')?.addEventListener('click', async () => {
  const btn = $('listen-start');
  const overlay = $('listen-overlay');
  if (!sync.room?.track) {
    setStartButton('Waiting for music', true);
    return;
  }
  if (btn) btn.disabled = true;
  clearError();
  audioSession.claim();
  try {
    await sync.calibrate();
    // Seek to the room's position as part of the gesture: a seek before the
    // tap could land on a source that has not buffered.
    sync.ensureLoaded();
    audio.volume = muted ? 0 : volume;
    if (sync.room?.playing) {
      await audio.play();
    } else {
      // A paused room must not make a sound on join. Starting and immediately
      // suspending still counts as the gesture that unlocks the element, so the
      // host pressing play later needs no second tap from this visitor.
      await audio.play();
      audio.pause();
    }
    if (overlay) overlay.hidden = true;
    // From here on the room may start playback on its own: the visitor has
    // given this page the one gesture it needs, and `hooks.play` gates on this.
    started = true;
    paintSync(Math.abs(sync.driftMs));
    paintProgress();
  } catch (err) {
    // Autoplay was refused even with a gesture (rare: an extension, or a
    // browser that treats the fetch-then-play chain as untrusted). Say so.
    showError(err?.message ? `Could not start audio: ${err.message}` : 'Could not start audio.');
  } finally {
    if (btn && sync.status !== 'ended') btn.disabled = false;
  }
});

$('listen-volume')?.addEventListener('input', (e) => {
  volume = Math.min(1, Math.max(0, Number(e.target.value) / 100));
  if (volume > 0) muted = false;
  paintVolume();
});

const toggleMute = () => {
  muted = !muted;
  paintVolume();
};
$('listen-mute')?.addEventListener('click', toggleMute);
$('listen-mini-mute')?.addEventListener('click', toggleMute);

// The room's seek may arrive before the browser knows the duration; `seeked`
// would clamp to 0. Applying it on `loadedmetadata` is the reliable moment.
function applyPendingResume() {
  if (pendingResumeMs == null) return;
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const seconds = pendingResumeMs / 1000;
  pendingResumeMs = null;
  if (Number.isFinite(seconds) && seconds > 0 && seconds < duration - 0.5) {
    try { audio.currentTime = seconds; } catch { /* not seekable yet */ }
  }
}

// ── sharing ────────────────────────────────────────────────────────────

/**
 * Copy the shareable landing link, not the /live URL the visitor happens to be
 * on. The landing page is the canonical invitation (it carries the Open Graph
 * card) and it mints a fresh guest cookie when its listener page opens.
 */
async function copyRoomLink(btn) {
  const url = `${location.origin}/l/${encodeURIComponent(code)}`;
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      ok = true;
    }
  } catch { /* fall through to the legacy path */ }
  if (!ok) {
    const field = document.createElement('textarea');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    try { ok = document.execCommand('copy'); } catch { /* nothing else to try */ }
    field.remove();
  }
  const label = btn?.querySelector('[data-copy-label]');
  if (!label) return;
  if (!label.dataset.default) label.dataset.default = label.textContent;
  label.textContent = ok ? 'Copied' : 'Copy failed';
  btn.classList.toggle('is-copied', ok);
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    label.textContent = label.dataset.default;
    btn.classList.remove('is-copied');
  }, 2000);
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyRoomLink(btn));
});

// "See the queue" is a jump, not a tab: the panel is already on screen on a
// desktop, and below the fold on a phone. Scrolling it into view (and focusing
// it, so a keyboard user lands in the list) serves both.
$('listen-next-jump')?.addEventListener('click', () => {
  const panel = document.querySelector('.queue-panel');
  if (!panel) return;
  panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  panel.setAttribute('tabindex', '-1');
  panel.focus({ preventScroll: true });
});

// ── the phone's persistent strip ───────────────────────────────────────

/**
 * On a phone the queue can be longer than the viewport, so the now-playing
 * facts would scroll away exactly when the listener is deciding what is next.
 * A small persistent strip (progress, title, mute) appears only after the
 * player has left the top of the screen. It duplicates state, never authority:
 * a guest still cannot move the playhead.
 */
const mini = $('listen-mini');
const player = $('listen-player');
const mobileQuery = window.matchMedia('(max-width: 900px)');
let miniFrame = 0;

function updateMini() {
  if (!mini || !player) return;
  // The strip exists to keep the track visible while reading the *player*
  // page's queue; in the venue the track is on the stage, so it would be a
  // second copy of the same fact in the same glance.
  const show = view === 'player' && mobileQuery.matches && player.getBoundingClientRect().bottom < 72;
  if (mini.hidden === !show) return;
  mini.hidden = !show;
  document.body.classList.toggle('mini-on', show);
}

const queueMini = () => {
  if (miniFrame) return;
  miniFrame = requestAnimationFrame(() => {
    miniFrame = 0;
    updateMini();
  });
};
window.addEventListener('scroll', queueMini, { passive: true });
window.addEventListener('resize', queueMini);
mobileQuery.addEventListener?.('change', queueMini);

// ── audio element events ───────────────────────────────────────────────

audio.addEventListener('loadedmetadata', () => {
  applyPendingResume();
  paintProgress();
});
audio.addEventListener('durationchange', paintProgress);
audio.addEventListener('seeked', paintProgress);
audio.addEventListener('playing', () => {
  markPlaying(true);
  paintSync(Math.abs(sync.driftMs));
  paintProgress();
  const overlay = $('listen-overlay');
  if (overlay && started) overlay.hidden = true;
});
audio.addEventListener('pause', () => {
  markPlaying(false);
  paintSync(Math.abs(sync.driftMs));
  paintProgress();
});
audio.addEventListener('volumechange', () => {
  // Keep the control honest if anything else moves the volume.
  const label = $('listen-vol-label');
  if (!label) return;
  const shown = Math.round((muted ? 0 : volume) * 100);
  if (label.textContent !== `${shown}%` && label.textContent !== (muted ? 'Muted' : '')) {
    label.textContent = muted ? 'Muted' : `${shown}%`;
  }
});
audio.addEventListener('error', () => {
  // A source we swapped away from can abort mid-load; only a real failure in
  // the track we are on is worth telling a listener about.
  if (started && audio.src) showError('This track could not be played here. It may have been removed.');
});

audio.addEventListener('timeupdate', () => {
  // The bars are patched at most ~4x a second: a CSS transition at every
  // timeupdate is a repaint per frame for no visible gain.
  const now = Date.now();
  if (now - lastBarAt < 250) return;
  lastBarAt = now;
  paintProgress();
  // "12 min left" is a queue-level fact, not a frame-level one.
  if (now - lastMetaAt > 1000) {
    lastMetaAt = now;
    paintQueueMeta(sync.room);
  }
});

// Set up the 5% starting point before anything can play.
audio.volume = DEFAULT_VOLUME;
paintVolume();
paintProgress();
updateMini();

// Everything that does not need a gesture happens now: the guest cookie came
// with the page, so the state, the clock and the audio source are ready before
// the visitor taps anything. If the browser is willing to autoplay (usual after
// a first visit to this origin), the room simply starts — and a refresh lands
// back in the room at the room's own position rather than at the start.
(async () => {
  try {
    await sync.load(code);
    started = true;
    if (!sync.room?.track) { started = false; return; }
    sync.ensureLoaded();
    if (sync.room?.playing) {
      await audio.play();
      const overlay = $('listen-overlay');
      if (overlay) overlay.hidden = true;
      paintSync(Math.abs(sync.driftMs));
      paintProgress();
      return;
    }
  } catch {
    // Fall through: the overlay is the answer, and the tap reports the detail.
  }
  started = false;
  paintSync(Math.abs(sync.driftMs));
})();

// A remembered venue (or a `?view=venue` link) opens once the room is known, and
// without overwriting the remembered choice.
if (view === 'venue') setView('venue', { persist: false });

// A locked phone loses the audio session; coming back should resync rather than
// drift silently for however long the screen was off.
document.addEventListener('visibilitychange', () => {
  // Both directions: the category can be lost while the screen is off, and the
  // guest has no second gesture to give when it comes back.
  audioSession.repair();
  if (document.visibilityState === 'visible' && started) sync.syncNow();
  if (document.visibilityState === 'visible') queueMini();
});
