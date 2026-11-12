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
import { createMediaSession } from './media-session.js';
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
 * Whether this element honours writes to `volume`.
 *
 * iOS Safari makes HTMLMediaElement.volume read-only: the assignment is accepted
 * and silently discarded, so a page that mutes by setting volume to 0 shows
 * "Muted" and a slider at 0 while the room keeps playing at full volume — and
 * the guest has no way to silence it (this page claims the `playback` audio
 * category, so the hardware Ring/Silent switch does not help either). Detect it
 * once, by writing a value and reading it back, because both things that depend
 * on it — muting and the 5% starting point — fail silently.
 */
const volumeWritable = (() => {
  const before = Number(audio.volume);
  const probe = before === 0.5 ? 0.25 : 0.5;
  try { audio.volume = probe; } catch { return false; }
  const ok = Math.abs(Number(audio.volume) - probe) < 0.01;
  try { audio.volume = before; } catch { /* it is not writable; nothing lost */ }
  return ok;
})();

/**
 * A room joins at 5%, not at 100%.
 *
 * Someone opening a link in a quiet room, a lecture or a sleeping house should
 * not have the room shouted at them; the control is right there if they want it
 * louder. Deliberately not persisted: this is a fresh visitor, not a profile.
 *
 * Where the engine ignores volume writes (see `volumeWritable`) that 5% cannot
 * exist at all, so the same intent is expressed in the one control every engine
 * honours: the element starts muted, which the mute button shows as "Unmute".
 * Silence the guest can undo in one tap beats a room at full volume they cannot
 * turn down.
 */
const DEFAULT_VOLUME = 0.05;
let volume = DEFAULT_VOLUME;
let muted = !volumeWritable;

let started = false;
let currentId = null;
let pendingResumeMs = null;
// A source swap (or a retry) is in flight. The Media Session metadata must keep
// saying "playing" through it: the pause a `src` assignment queues is not a
// listener deciding to stop, and publishing it empties the lock-screen widget
// for the whole cold load.
let switching = false;
// The element has no data to play right now. `/api/stream` can block for a
// whole yt-dlp download, which is a minute of apparent nothing on a cold track.
let buffering = false;
// Failed loads of the current track's stream, and which track they belong to —
// see the `error` handler for why this is bounded.
let streamAttempts = 0;
let streamAttemptsId = null;
let streamRetry = null;
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
  if (status === 'ended' || status === 'private') {
    // A terminal room has no playhead any more, and the correction loop that
    // would otherwise be the only thing that ever touches this element has
    // already been stopped. Without this the last track plays on — for the
    // several minutes it has left — underneath "This room has ended", and this
    // page offers no pause control at all. `rooms.js` pauses through the same
    // hook; this is the page's own guarantee rather than a second opinion on it,
    // and it is idempotent.
    try { audio.pause(); } catch { /* nothing to pause yet */ }
  }
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
  // "Off by 3.2s" is not the answer to a stall: the number is a claim about
  // audio moving, and while the element is waiting for data nothing is. Say what
  // is actually happening instead — a cold `/api/stream` is a minute of silence
  // behind a disabled button, and a frozen progress bar with no explanation is
  // indistinguishable from a broken page.
  if (buffering) {
    el.dataset.sync = 'warn';
    el.textContent = 'Buffering…';
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

/**
 * Is the element waiting for data?
 *
 * Driven from the element's own events (`waiting`/`stalled` start it,
 * `playing`/`canplay` end it) rather than from a timer, because only the engine
 * knows whether it has enough audio to move.
 */
function setBuffering(on) {
  if (buffering === on) return;
  buffering = on;
  document.body.dataset.buffering = on ? '1' : '0';
  paintSync(Math.abs(sync.driftMs));
}

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
  // The lock screen's own bar, from the same clock. media-session.js throttles
  // it to about one call a second, which is what iOS needs.
  nowPlaying.position();
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
  const level = Math.min(1, Math.max(0, Number(volume) || 0));
  // The flag is the mute, and the only mute iOS honours: a `volume = 0` there is
  // accepted and ignored, which is how this page used to claim "Muted" while the
  // room played at full volume. Keep writing the level too, and not only where
  // it works: a slider and an element that disagree is the bug this finding is
  // about, and on iOS the write is a no-op, so there is nothing to lose by it.
  audio.muted = muted;
  try { audio.volume = muted ? 0 : level; } catch { /* iOS: read-only */ }
  const effective = muted ? 0 : level;
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
        // The venue's gate is the same one tap, in the same gesture: a guest in
        // the room view must be able to unlock audio without leaving it.
        onStart: () => startPlayback(),
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

// Two clicks in quick succession must not interleave: the venue's module is a
// lazy import, so `setView` really can be in flight when the next one starts.
// The newest request wins and the older one stops applying anything.
let viewToken = 0;

async function setView(next, { persist = true } = {}) {
  const target = next === 'venue' ? 'venue' : 'player';
  const token = (viewToken += 1);
  const previous = view;
  view = target;
  document.body.dataset.view = view;
  for (const btn of viewButtons) btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
  if (view === 'venue') {
    try {
      const api = await ensureVenue();
      if (token !== viewToken) return; // a newer click already decided
      api.show();
      if (sync.room) api.paint(sync.room);
      api.paintVolume({ muted, volume });
      // The room draws the same clock as the player, and it may be a paused room
      // whose element will not fire another `timeupdate`: paint it now rather
      // than opening the venue on a progress bar that only fills once sound
      // starts.
      paintProgress();
      paintGate();
    } catch (err) {
      if (token !== viewToken) return;
      // The venue is a lazy chunk, so it can genuinely fail to arrive (offline,
      // a proxy, a deploy that replaced the hashed file). A view that cannot
      // load must not take the room's sound down with it: fall back to the
      // player and say why, rather than leaving a blank panel and a stuck
      // `data-view`.
      view = previous === 'venue' ? 'player' : previous;
      document.body.dataset.view = view;
      for (const btn of viewButtons) btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
      venueLoading = null;
      showError(`The room view could not load (${err?.message ?? 'network'}). The player still works.`);
    }
  } else {
    venue?.hide();
    paintProgress();
    paintGate();
  }
  if (persist && view === target) saveView(view);
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
function showResume(err) {
  // A rejection is not a refusal. `play()` rejects with AbortError when a source
  // swap interrupts it, and that is routine here rather than exceptional: the
  // room's `/api/stream` can block for the whole download of an uncached track,
  // so the guest's play() promise stays pending for tens of seconds — and any
  // next-track event in that window aborts it. The old code treated that
  // AbortError as an autoplay refusal, so a full-screen "Tap to resume" came up
  // over a track that was in fact starting, and `started` was dropped, which is
  // what stops the room from following itself. Only NotAllowedError means the
  // browser refused; an unnamed rejection is treated the same way (the safe
  // answer, since there is nothing to inspect).
  const name = err?.name;
  if (name && name !== 'NotAllowedError') return;
  // A stale refusal must not undo a successful start.
  if (!audio.paused) return;
  if (sync.status === 'ended' || sync.status === 'private') return;
  // The swap this rejection came from is over, whatever the source is doing
  // now: leaving the marker armed would keep the lock screen saying "playing".
  switching = false;
  // The browser refused a play() that had no gesture behind it (or that it no
  // longer trusts), so the visitor's unlock is spent: the gate has to come back
  // in whichever view they are looking at.
  started = false;
  paintGate('Tap to resume');
}

// The room page uses one shared engine; a guest scores `guests` in the snapshot
// only, so the count shown here is the room's, not this tab's.

/** How many times a failed `/api/stream` is re-requested before giving up. */
const STREAM_RETRIES = 3;
/** The first retry is quick: the room's queue is not waiting for this client. */
const STREAM_RETRY_MS = 1200;

/**
 * Point the element at the room's stream.
 *
 * `retry` pads the URL, and only that: a request that failed (a truncated
 * response, a decode error) may still sit in the HTTP cache, and re-assigning
 * the identical URL could be answered from it. `/api/stream/:videoId` reads the
 * path only, so a query string is free.
 */
function loadSource(videoId, { retry = false } = {}) {
  // Attempts are counted per track, not per assignment — see scheduleStreamRetry.
  if (streamAttemptsId !== videoId) { streamAttemptsId = videoId; streamAttempts = 0; }
  currentId = videoId;
  // A `src` assignment queues a pause on an element the OS still counts as
  // playing. That is a swap, not a listener stopping: media-session.js keeps
  // saying "playing" while this flag is up.
  switching = true;
  clearTimeout(streamRetry);
  streamRetry = null;
  audio.src = retry ? `/api/stream/${videoId}?r=${streamAttempts}` : `/api/stream/${videoId}`;
  audio.load();
}

/**
 * A failed stream is retried, not abandoned.
 *
 * The source is set *before* it loads, so one failed `/api/stream` — a 503 while
 * the server's yt-dlp download is BOT_GATED, a dropped connection, a decode
 * failure — used to be the last word on that track: `ensureLoaded()`
 * short-circuits because the id already matches, the correction loop refuses to
 * run at all without a loaded source, and the guest gets one small red line and
 * then silence for the remaining minutes of the track (the room only advances on
 * the *host's* player). A cold download usually works on the next try, so drop
 * the id and ask again after a short backoff.
 *
 * Returns false once the attempts are spent; the caller says so.
 */
function scheduleStreamRetry(videoId) {
  if (streamAttemptsId !== videoId) { streamAttemptsId = videoId; streamAttempts = 0; }
  streamAttempts += 1;
  if (streamAttempts > STREAM_RETRIES) {
    // Out of attempts. The id is kept on purpose: a null `currentId` makes every
    // incoming snapshot look like a track change, and each one would re-load the
    // stream — a request loop against a track that cannot be played.
    currentId = videoId;
    return false;
  }
  // Nothing has this track loaded while the retry waits, which also keeps the
  // corrector out of the element instead of seeks against a dead source.
  currentId = null;
  clearTimeout(streamRetry);
  streamRetry = setTimeout(() => {
    streamRetry = null;
    // Anything may have happened meanwhile: the room moved on, a snapshot loaded
    // the track, or the page went away.
    if (currentId || sync.room?.track?.videoId !== videoId) return;
    loadSource(videoId, { retry: true });
    if (started && sync.room?.playing) audio.play().catch(showResume);
  }, STREAM_RETRY_MS * streamAttempts);
  setBuffering(true);
  return true;
}

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
        loadSource(track.videoId);
      }
      paintProgress();
      if (snapshot.playing && started) audio.play().catch(showResume);
    },
    /**
     * The corrector asking for sound.
     *
     * A finished element is the case that matters: `rooms.js` only calls a track
     * finished when it knows the catalogue's duration (`atEnd`), and for a track
     * it does not know, `play()` on an `ended` element restarts it at 0:00 — the
     * next tick sees a huge negative drift, hard-seeks to the room's ever-larger
     * position, lands on the end again, and repeats. The audible result is the
     * first couple of seconds of the track chopped in a loop until the host
     * advances. The room's position is the truth: go there and stay quiet. If
     * that position is past the end the element stays ended, which is exactly
     * where the room is.
     */
    play: () => {
      if (!started) return;
      if (audio.ended) {
        const target = Math.max(0, (sync.positionMs ?? 0) / 1000);
        // Only when the room really has a different answer: assigning the same
        // currentTime every tick would fire `seeked` (and a repaint) once a
        // second for nothing.
        if (Number.isFinite(target) && Math.abs(target - (Number(audio.currentTime) || 0)) > 0.25) {
          try { audio.currentTime = target; } catch { /* not seekable */ }
        }
        return;
      }
      audio.play().catch(showResume);
    },
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
      // The gate's label depends on whether the room has a track at all, and a
      // guest can open the venue before the first snapshot lands.
      paintGate();
    },
    onMembers: () => {
      paintListeners();
      // The venue's crowd is the room's count, so it follows member events, not
      // only the next state frame.
      venue?.setListeners(sync.listeners);
    },
    onStatus: ({ status, error }) => { paintStatus(status, error); paintGate(); },
    // The correction loop's drift is only meaningful while this element is
    // actually following the room; `paintSync` decides that from `started`.
    onDrift: (ms) => paintSync(ms),
    notify: (message, level) => {
      // A terminal reason (the room ended, went private, or the guest cookie
      // expired) is the one 'info' a visitor must actually see — the badge
      // alone only says the room is over, not why. Everything else stays quiet.
      if (level === 'error' || sync.status === 'ended' || sync.status === 'private') showError(message);
    },
  },
});

/**
 * One tap, and the room is playing.
 *
 * This is the page's only entry point into sound, and it is shared by the
 * player's overlay and the venue's own button: the venue hides `.layout`, so an
 * overlay inside it would be invisible exactly when a guest needs it. The page
 * arrives with the guest cookie already set (the server mints it with the
 * HTML), so by the time the visitor taps, the tap is a plain play() on a ready
 * element — which every browser allows — rather than a dance of silent
 * placeholders that leaves a guest pressing Listen live twice. The corollary,
 * and the whole reason the body is ordered the way it is: the play() comes first
 * and synchronously, because a promise chain in front of it spends the very
 * activation that makes it legal.
 */
async function startPlayback() {
  const btn = $('listen-start');
  if (!sync.room?.track) {
    setStartButton('Waiting for music', true);
    paintGate();
    return;
  }
  if (btn) btn.disabled = true;
  clearError();
  audioSession.claim();
  // Everything that needs the tap's user activation happens here, before the
  // first `await`: activation is spent by the first one, and both calls below can
  // take seconds. `calibrate()` is three sequential `/time` probes once its 60 s
  // cooldown has lapsed, and `ensureLoaded()` can start a blocking `/api/stream`
  // request that waits for a whole yt-dlp download. Awaiting them first is why a
  // guest on a slow link tapped, read "Could not start audio: …" and had to tap
  // again — the play() arrived with no activation left behind it.
  sync.ensureLoaded();
  // Re-assert the level inside the gesture: some engines only apply a media
  // element's volume once the page has been interacted with, and this is the
  // one interaction this page ever gets.
  paintVolume();
  // A paused room must not make a sound on join. Starting and immediately
  // suspending still counts as the gesture that unlocks the element, so the host
  // pressing play later needs no second tap from this visitor. An element that
  // has already finished must not be started at all — `play()` on an `ended`
  // element restarts it at 0:00, which is the same trap `hooks.play` guards
  // against for a track whose length the catalogue never supplied.
  const playCall = audio.ended ? null : audio.play();
  if (!sync.room?.playing) audio.pause();
  playCall?.catch?.(showResume);
  // From here on the room may start playback on its own: the visitor has given
  // this page the one gesture it needs, and `hooks.play` gates on this.
  started = true;
  paintSync(Math.abs(sync.driftMs));
  paintProgress();
  paintGate();
  try {
    // The room's clock is worth having, but never at the price of the tap: the
    // sound is already on its way, and a failed probe keeps the previous offset.
    await sync.calibrate();
    paintProgress();
  } catch {
    // The room is still playable on an older offset.
  } finally {
    if (btn && sync.status !== 'ended') btn.disabled = false;
    paintGate();
  }
}

/**
 * The gate: "listen live", "tap to resume", or nothing.
 *
 * Both views ask the same question — has this visitor unlocked audio? — so both
 * are painted from one place. The venue cannot show the player's overlay (it
 * hides that whole column), so it gets its own button on the stage; a guest in
 * the venue who is refused autoplay must still be able to start the room.
 */
function paintGate(label) {
  const overlay = $('listen-overlay');
  // 'ended' and 'private' are both terminal: the page is over either way, and
  // the gate is where the reason lives — it is just no longer a button to press.
  const gone = sync.status === 'ended' || sync.status === 'private';
  const needsTap = !gone && !started;
  const text = !sync.room?.track ? 'Waiting for music' : (label ?? 'Listen live');
  // A terminal room keeps its cover: the sleeve is still what the room played,
  // and the overlay is where the "this room is over" answer lives.
  if (overlay) overlay.hidden = !(needsTap || gone);
  if (needsTap) setStartButton(text, !sync.room?.track);
  if (gone) setStartButton(sync.status === 'ended' ? 'Room ended' : 'Invite only', true, END_ICON);
  venue?.paintGate({ needsTap, ended: gone, label: text, ready: Boolean(sync.room?.track) });
}

$('listen-start')?.addEventListener('click', startPlayback);

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
  const seconds = Number.isFinite(pendingResumeMs) ? Math.max(0, pendingResumeMs / 1000) : null;
  pendingResumeMs = null;
  // A position this page cannot trust is not a reason to seek anywhere: leave
  // the element where it is and let the corrector decide.
  if (seconds == null) return;
  // Joining in a track's last half-second is not a reason to start at 0:00.
  // Skipping the seek there meant the guest heard a burst of the intro, then the
  // corrector's hard seek to the real position, then silence — three separate
  // lies about where the room is. Land on the last audible moment instead: the
  // element reaches its own end a moment later, which is exactly where the room
  // already is.
  const target = Math.min(seconds, Math.max(0, duration - 0.5));
  try { audio.currentTime = target; } catch { /* not seekable yet */ }
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

// ── the lock screen ────────────────────────────────────────────────────
/**
 * The Now Playing widget.
 *
 * This is the page people background and lock, and it had no Media Session at
 * all: no artwork, no title, no scrubber, and no controls — while the system
 * pause button's default action went straight to the element, which the room's
 * correction loop then undid within a second, so a guest who paused from the
 * lock screen heard the music stop and start again forever.
 *
 * A guest cannot move the room's playhead (that is the whole contract of the
 * page), so only the two controls that apply to this device are handled here:
 *
 *  - `pause` is honoured locally, by dropping `started` — the same gate the "Tap
 *    to resume" overlay uses — so the corrector stops asking for sound instead
 *    of fighting the listener.
 *  - `play` re-takes the audio session and starts the element synchronously,
 *    before anything awaits, exactly as the tap does.
 *
 * The scrubber is a local seek and the corrector pulls it back to the room's
 * position within a second. That is what a shared playhead means; the
 * alternative, publishing no position state at all, leaves the widget looking
 * dead on the one screen a listener actually sees.
 */
const nowPlaying = createMediaSession({
  audio,
  getTrack: () => sync.room?.track ?? null,
  base: location.href,
  // Warm the artwork before the screen locks: iOS fetches artwork lazily, and
  // the lock is the worst possible time for a cold fetch.
  warmArtwork: (src) => { const img = new Image(); img.src = src; },
  handlers: {
    play: () => {
      if (sync.status === 'ended' || sync.status === 'private') return;
      audioSession.claim();
      started = true;
      // Synchronously, for the same reason `startPlayback` does it: whatever
      // activation a media-session action carries is spent by an await, and the
      // room's clock is never worth the sound.
      sync.ensureLoaded();
      if (sync.room?.playing && !audio.ended) audio.play().catch(showResume);
      paintSync(Math.abs(sync.driftMs));
      paintGate();
    },
    pause: () => {
      // Asked for by a person — on the lock screen, on headphones, in the car —
      // so it must outlive the next correction tick. `started` is that promise.
      started = false;
      try { audio.pause(); } catch { /* already stopped */ }
      paintSync(Math.abs(sync.driftMs));
      paintGate('Tap to resume');
    },
  },
  hooks: {
    // A source swap is not a pause: publishing it as one empties the widget for
    // the whole cold load (media-session.js has the reasoning in full).
    isSwitching: () => switching,
  },
});

// Registered once up front as well: a room that is paused when the guest arrives
// never fires `playing`, and a lock screen with no controls is the failure this
// whole block exists to prevent. Registration is idempotent by design.
nowPlaying.installHandlers();

// ── audio element events ───────────────────────────────────────────────

audio.addEventListener('loadedmetadata', () => {
  applyPendingResume();
  paintProgress();
  // Duration is finally known: the lock screen can draw its bar, and this may be
  // the first moment the track can name itself.
  nowPlaying.sync({ metadata: true, force: true });
});
audio.addEventListener('durationchange', () => {
  paintProgress();
  nowPlaying.sync({ force: true });
});
audio.addEventListener('seeked', () => {
  paintProgress();
  nowPlaying.sync({ force: true });
});
audio.addEventListener('playing', () => {
  // Playing is the truth, so it also ends every doubt: the element has audio,
  // whatever a rejected play() said earlier. `started` is set unconditionally
  // here on purpose — gating this on `started` is exactly what used to leave a
  // full-screen "Tap to resume" overlay sitting over a track that was playing.
  started = true;
  switching = false;
  // A load that reached `playing` worked, so the retry budget starts again.
  streamAttempts = 0;
  streamAttemptsId = null;
  clearTimeout(streamRetry);
  streamRetry = null;
  setBuffering(false);
  markPlaying(true);
  paintSync(Math.abs(sync.driftMs));
  paintProgress();
  paintGate();
  // Re-registered on every play: iOS drops Media Session handlers across an
  // audio-session interruption (a call, Siri), and the metadata is refreshed so
  // a track that started while the phone was already locked names itself.
  nowPlaying.installHandlers();
  nowPlaying.sync({ metadata: true, force: true });
});
audio.addEventListener('pause', () => {
  markPlaying(false);
  paintSync(Math.abs(sync.driftMs));
  paintProgress();
  nowPlaying.sync({ force: true });
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
// Buffering, from the element's own witness. `/api/stream` answers a cache miss
// only after the whole yt-dlp download, so joining a room whose track is cold is
// a minute of silence behind a button that looks stuck, and a mid-track stall
// freezes the progress bar with no explanation. `waiting`/`stalled` start it;
// `canplay` (and `playing`) end it.
audio.addEventListener('waiting', () => setBuffering(true));
audio.addEventListener('stalled', () => setBuffering(true));
audio.addEventListener('canplay', () => {
  // The swap is over once the new source has data: from here the element's own
  // `paused` is the truth again, and the lock screen may say so. Without this a
  // room that loads a track while paused would leave the widget claiming
  // "playing" for as long as nothing else touched it.
  switching = false;
  setBuffering(false);
});
audio.addEventListener('error', () => {
  // A source we swapped away from aborts mid-load (MEDIA_ERR_ABORTED, code 1);
  // a room that advances twice in a second does that routinely, and the old
  // error event used to arrive *after* the new track was already playing — so
  // a healthy room could show "this track could not be played". Only a real
  // decode/network failure in the track we are actually on is worth acting on.
  const code = audio.error?.code;
  if (code === 1) return;
  // A failed source never reaches `playing`, which is what normally clears this.
  switching = false;
  if (!currentId) return;
  if (!String(audio.src ?? '').includes(encodeURIComponent(currentId))) return;
  // Retried rather than believed: see scheduleStreamRetry. One 503 behind a
  // BOT_GATED download used to cost the guest the rest of the song.
  if (scheduleStreamRetry(currentId)) return;
  setBuffering(false);
  if (started) showError('This track could not be played here. It may have been removed.');
});

audio.addEventListener('timeupdate', () => {
  // A moving playhead is proof that data is flowing, so it is also the honest
  // end of a buffering state: `stalled` can fire on a network hiccup the
  // element rides out, and there would be no `canplay` afterwards to clear a
  // "Buffering…" nobody can see the end of.
  setBuffering(false);
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

// Set up the level before anything can play. `paintVolume` owns both halves of
// it now — the element's `muted` flag (the only one iOS honours) and the slider's
// volume — so there is exactly one place that decides what a fresh guest hears.
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
    if (!sync.room?.track) { paintGate(); return; }
    sync.ensureLoaded();
    if (sync.room?.playing) {
      // The one play() on this page that is allowed to be refused: there is no
      // gesture behind it. `showResume` puts the gate back with an honest label
      // instead of leaving a silent room, and the tap is the fix. The overlay is
      // cleared by the `playing` handler, not here: a gate that disappears before
      // the room makes a sound is a promise the page has not kept yet.
      audio.play().catch(showResume);
      paintSync(Math.abs(sync.driftMs));
      paintProgress();
      return;
    }
  } catch {
    // Fall through: the overlay is the answer, and the tap reports the detail.
  }
  // A paused room is not a failure: there is simply nothing to play yet. This
  // path must NOT clear `started`.
  //
  // It used to (`started = false`), and that made a paused room unstartable for
  // any guest who tapped first: `load()` is a round trip, the gate is clickable
  // before it resolves, so the tap set `started = true`, this branch then reset
  // it to false, and `hooks.play` — which gates on `started` — refused every
  // later start. The host pressing play could never make that guest play, and
  // the overlay sat on "Listen live" for the life of the page. `started` is only
  // ever cleared when the browser actually refuses (showResume) or the listener
  // pauses from the OS.
  paintSync(Math.abs(sync.driftMs));
  paintGate();
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
  // ...and the lock-screen handlers go with it. A guest locks the phone mid-room
  // constantly, and the interruption that pauses the element arrives as no event
  // a paused-but-looping stream will ever re-fire. media-session.js keeps
  // re-asserting from the playhead while hidden; this covers the moment of
  // locking itself and the return.
  nowPlaying.installHandlers();
  if (document.visibilityState === 'visible' && started) sync.syncNow();
  if (document.visibilityState === 'visible') queueMini();
});

// ...and an interruption (a call, Siri, Maps taking the output) can end while the
// listener is still in the other app: no `visibilitychange`, no `playing`, no
// resume — nothing this page can see except the audio session's own state, which
// is why audio-session.js listens for it. The guest page never wired this hook,
// so an interruption that ended in a pocket left a silent "Live" page until the
// phone was unlocked and the tab woken. Both calls are cheap and idempotent: the
// claim is one assignment, and a resync is one poll.
audioSession.onResume(() => {
  audioSession.claim();
  if (started) sync.syncNow();
});
