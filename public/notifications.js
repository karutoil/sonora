// sonora — the notification bell.
//
// A separate module on purpose. app.js is one big non-exporting module, so a
// feature that needs its own lifetime (a poll, an OS notification, a panel that
// outlives a route change) cannot be a function inside it without the two
// fighting over state. This module owns the bell end to end:
//
//   · it polls GET /api/notifications on a timer that only runs while the tab
//     is visible, and on every return to the tab;
//   · it keeps the bell honest (the dot, a numeric badge, an aria-label with
//     the count) and renders the panel itself;
//   · it turns rows that are new since the last seen id into a desktop/PWA
//     notification, but only when the user asked for that;
//   · it navigates with `location.hash = item.url`, where `url` is the route the
//     *server* computed. Building one here would mean guessing whether a
//     release is an album or a video.
//
// Everything it renders is namespaced `.notif-*` so it can never collide with
// the app's own classes, and it talks to app.js only through the existing
// `[data-action="notifications"]` button, DOM it owns, and `location.hash`.

const API = {
  list: (limit) => `/api/notifications?limit=${limit}`,
  read: '/api/notifications/read',
  readAll: '/api/notifications/read-all',
  check: '/api/notifications/check',
};

// One poll a minute: the server's sweep runs every 20 minutes, and the manual
// check is throttled to a minute per user, so polling faster buys nothing and
// costs a catalogue page fetch per followed artist.
const POLL_MS = 60_000;
const CHECK_MS = 60_000;
const LIMIT = 50;

// Storage keys. `sonora.prefs` is the pinned shared shape (see
// .tmp/plan/brief.md); `sonora.notifSeen` is this module's own bookmark of the
// highest id it has already announced.
const PREFS_KEY = 'sonora.prefs';
const SEEN_KEY = 'sonora.notifSeen';

// Long enough to see an exit animation, short enough not to feel laggy.
const CLOSE_MS = 160;
// How many backlog rows may become an OS notification at once. A first run is
// baselined silently, so this only ever catches a burst; four alerts for four
// albums is a notification storm, one is news.
const ALERT_BURST = 3;

const state = {
  items: [],
  unread: 0,
  // 'idle' (never polled) | 'loading' | 'ready' | 'error'
  phase: 'idle',
  open: false,
  signedOut: false,
  checking: false,
  lastCheck: 0,
};

let bellEl = null;
let badgeEl = null;
let panel = null;
let backdrop = null;
let openTrigger = null;
let pollController = null;
let timer = null;
let closeToken = 0;
let lastOpenedAt = 0;
// Set when *we* closed the panel in response to a bell click. app.js may also
// delegate that same click to open(), and the two handlers can run in either
// order; without this a toggle would be undone by the second handler.
let lastToggleAt = 0;
let askingPermission = false;

// ── small helpers ──────────────────────────────────────────────────────────

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

const isSheet = () => {
  try { return window.matchMedia('(max-width: 650px)').matches; } catch { return window.innerWidth <= 650; }
};

/** `just now`, `12m`, `3h`, `2d`, `5mo`, `2y` — the units a feed actually uses. */
function relTime(iso) {
  const then = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

const desktopAlertsOn = () => readPrefs().desktopAlerts === true;

/** Writing a preference the app also owns. The event tells app.js to re-read
 *  it; app.js already dispatches the same event for its own writes. */
function writePref(key, value) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), [key]: value }));
  } catch {}
  document.dispatchEvent(new CustomEvent('sonora:pref-change', { detail: { key, value } }));
}

/** The highest notification id already announced, or null on a first run. */
function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function writeSeen(id) {
  try { localStorage.setItem(SEEN_KEY, String(id)); } catch {}
}

const permissionState = () => {
  if (typeof Notification !== 'function') return 'unsupported';
  return Notification.permission || 'default';
};

const post = (url, body) => fetch(url, {
  method: 'POST',
  credentials: 'same-origin',
  ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
});

const authOverlayVisible = () => {
  const overlay = document.getElementById('auth-overlay');
  return Boolean(overlay) && !overlay.hidden;
};

// ── chrome: badge, panel, backdrop ─────────────────────────────────────────

function buildChrome() {
  const trigger = document.querySelector('[data-action="notifications"]');
  if (!trigger) return false;
  bellEl = trigger;

  // The dot is the app's own hook (app.css positions it), so it stays exactly
  // where it is; the count is a second element in the same corner that covers
  // it. A 6px dot cannot carry "12", and moving the dot would break the CSS
  // contract the shell was built on.
  badgeEl = document.createElement('span');
  badgeEl.className = 'notif-badge';
  badgeEl.setAttribute('aria-hidden', 'true');
  badgeEl.hidden = true;
  trigger.appendChild(badgeEl);

  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  if (!trigger.getAttribute('aria-label')) trigger.setAttribute('aria-label', 'Notifications');

  backdrop = document.createElement('div');
  backdrop.className = 'notif-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', () => close());

  panel = document.createElement('div');
  panel.className = 'notif-panel';
  panel.id = 'notif-panel';
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'notif-heading');
  panel.addEventListener('click', onPanelClick);

  document.body.append(backdrop, panel);

  // One click opens it, whether or not app.js also delegates the same click.
  trigger.addEventListener('click', onBellClick);
  return true;
}

function onBellClick(event) {
  // app.js's own `case 'notifications'` calls open() on the same click, and the
  // order of the two handlers is not ours to choose. Both directions are
  // guarded: a panel that was just opened by the other handler is not toggled
  // shut, and one we just toggled shut is not reopened.
  if (Date.now() - lastOpenedAt < 350) { event.preventDefault(); return; }
  if (state.open) {
    close();
    lastToggleAt = Date.now();
    return;
  }
  open(bellEl);
}

function onPanelClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const itemEl = target.closest('[data-notif-item]');
  if (itemEl) {
    const item = state.items.find((row) => String(row.id) === itemEl.dataset.notifItem);
    if (item) activate(item);
    return;
  }

  const action = target.closest('[data-notif]')?.dataset.notif;
  if (!action) return;
  if (action === 'close') close();
  else if (action === 'read-all') void markAllRead();
  else if (action === 'refresh') void checkNow();
  else if (action === 'enable-alerts') void enableAlerts();
  else if (action === 'retry') void poll();
}

// ── rendering ──────────────────────────────────────────────────────────────

function itemHtml(item) {
  const unread = !item.readAt;
  const key = esc(String(item.id));
  // A missing thumb is normal (a video without artwork): a glyph keeps the row
  // aligned instead of collapsing the text column.
  const thumb = item.thumb
    ? `<img class="notif-thumb-img" src="${esc(item.thumb)}" alt="" loading="lazy" decoding="async">`
    : '<svg class="notif-thumb-glyph" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-bell"/></svg>';
  const artist = item.artistName && item.title ? ` · ${esc(item.artistName)}` : '';
  return `<li class="notif-row"><button type="button" class="notif-item${unread ? ' is-unread' : ''}"
    data-notif-item="${key}" data-focus-key="item-${key}">
    <span class="notif-thumb" aria-hidden="true">${thumb}</span>
    <span class="notif-copy">
      <span class="notif-item-title">${esc(item.title || item.artistName || 'New release')}</span>
      ${item.body ? `<span class="notif-item-body">${esc(item.body)}</span>` : ''}
      <span class="notif-item-meta">${unread ? '<span class="notif-item-dot" aria-hidden="true"></span><span class="sr-only">Unread. </span>' : ''}<time datetime="${esc(item.createdAt || '')}">${esc(relTime(item.createdAt))}</time>${artist}</span>
    </span>
  </button></li>`;
}

/**
 * The one line about desktop alerts that is worth the space: silence when they
 * are on and working, an offer when the browser has not decided yet, and the
 * honest reason when it said no. A blocked permission that fails quietly looks
 * like a broken feature.
 */
function alertsRowHtml() {
  const permission = permissionState();
  if (permission === 'unsupported') return '';
  if (permission === 'denied') {
    return `<p class="notif-note">Desktop alerts are blocked in this browser — the bell still works.</p>`;
  }
  if (permission === 'granted' && desktopAlertsOn()) return '';
  return `<div class="notif-alerts">
    <button type="button" class="notif-enable" data-notif="enable-alerts" data-focus-key="enable">Enable alerts</button>
    <span class="notif-alerts-copy">Get a desktop notification when a followed artist releases something.</span>
  </div>`;
}

function bodyHtml() {
  if (state.phase === 'loading' && !state.items.length) {
    return `<div class="notif-body" aria-busy="true">
      <span class="sr-only">Loading notifications…</span>
      <div class="notif-skel" aria-hidden="true"><span class="notif-skel-row"></span><span class="notif-skel-row"></span><span class="notif-skel-row"></span></div>
    </div>`;
  }
  if (state.phase === 'error' && !state.items.length) {
    return `<div class="notif-body"><div class="notif-error" role="alert">
      <p class="notif-error-text">Could not load your notifications.</p>
      <button type="button" class="notif-enable" data-notif="retry" data-focus-key="retry">Try again</button>
    </div></div>`;
  }
  if (!state.items.length) {
    return `<div class="notif-body"><div class="notif-empty">
      <svg class="notif-empty-glyph" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-bell"/></svg>
      <p class="notif-empty-title">Nothing new.</p>
      <p class="notif-empty-text">Follow an artist and you will hear about their releases here.</p>
    </div></div>`;
  }
  return `<div class="notif-body"><ul class="notif-list">${state.items.map(itemHtml).join('')}</ul></div>`;
}

function render() {
  if (!panel) return;
  // Re-rendering must not drop the user out of the dialog: remember what had
  // focus inside the panel and put it back on the same control afterwards.
  const active = document.activeElement;
  const keepFocus = active instanceof Element && panel.contains(active)
    ? active.getAttribute('data-focus-key')
    : null;

  panel.innerHTML = `
    <div class="notif-head">
      <h2 class="notif-heading" id="notif-heading">Notifications</h2>
      <div class="notif-head-actions">
        <button type="button" class="notif-icon-btn" data-notif="refresh" data-focus-key="refresh"
          aria-label="Check for new releases" title="Check for new releases"${state.checking ? ' disabled' : ''}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-repeat"/></svg>
        </button>
        <button type="button" class="notif-text-btn" data-notif="read-all" data-focus-key="read-all"${state.unread === 0 ? ' disabled' : ''}>Mark all read</button>
        <button type="button" class="notif-icon-btn notif-close" data-notif="close" data-focus-key="close" aria-label="Close notifications">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg>
        </button>
      </div>
    </div>
    ${alertsRowHtml()}
    ${bodyHtml()}`;

  if (keepFocus) {
    const next = panel.querySelector(`[data-focus-key="${keepFocus}"]`);
    (next ?? panel).focus({ preventScroll: true });
  }
}

function renderIfOpen() {
  if (state.open) render();
}

// ── bell state ─────────────────────────────────────────────────────────────

function applyUnread(count) {
  state.unread = Math.max(0, Number(count) || 0);

  // The dot is the app's hook; hiding it when there is nothing to say is the
  // whole point of it existing.
  const dot = bellEl?.querySelector('.notification-dot') ?? document.querySelector('.notification-dot');
  if (dot) dot.hidden = state.unread === 0;

  if (badgeEl) {
    badgeEl.hidden = state.unread === 0;
    badgeEl.textContent = state.unread > 9 ? '9+' : String(state.unread);
  }

  if (bellEl) {
    bellEl.setAttribute('aria-label', state.unread ? `Notifications, ${state.unread} unread` : 'Notifications');
  }
}

// ── panel open/close ───────────────────────────────────────────────────────

/** Anchor the desktop popover under the bell. The bell moves with the topbar
 *  and the breakpoints, so this is measured rather than hardcoded in CSS. */
function place() {
  if (!panel) return;
  if (isSheet()) {
    // The sheet is laid out by the stylesheet (bottom, full width); inline
    // values from a desktop open would otherwise win over it.
    panel.style.removeProperty('top');
    panel.style.removeProperty('right');
    return;
  }
  const rect = bellEl?.getBoundingClientRect();
  const width = panel.offsetWidth || 360;
  const right = rect && rect.width > 0
    ? Math.max(8, Math.min(window.innerWidth - width - 8, window.innerWidth - rect.right))
    : 16;
  const top = rect && rect.height > 0 ? rect.bottom + 8 : 64;
  panel.style.right = `${Math.round(right)}px`;
  panel.style.top = `${Math.round(Math.max(8, top))}px`;
}

function focusables() {
  return [...panel.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.getClientRects().length > 0);
}

function onKeydown(event) {
  if (!state.open) return;
  if (event.key === 'Escape') {
    // The bell is the topmost layer, so Escape belongs to it: stop the app's
    // own Escape handler from closing a sheet underneath as well.
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab' || panel.getAttribute('aria-modal') !== 'true') return;
  const list = focusables();
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (!panel.contains(active)) { event.preventDefault(); first.focus(); return; }
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}

function onPointerDown(event) {
  if (!state.open) return;
  const target = event.target;
  if (panel.contains(target) || bellEl?.contains(target)) return;
  close();
}

function attachGlobal() {
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', place);
}

function detachGlobal() {
  document.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('resize', place);
}

/**
 * Open the panel. `trigger` is the bell app.js passes in (`open(el)`); it is
 * also where focus returns to on close, which is what makes the panel usable
 * from a keyboard without a pointer.
 */
function open(trigger) {
  if (!panel) return;
  // A close from the same click (see onBellClick) must not be undone.
  if (!state.open && Date.now() - lastToggleAt < 350) return;
  if (state.open) return;

  state.open = true;
  lastOpenedAt = Date.now();
  closeToken += 1;
  openTrigger = trigger instanceof HTMLElement ? trigger : bellEl;

  const sheet = isSheet();
  panel.classList.toggle('is-sheet', sheet);
  panel.classList.remove('is-closing');
  panel.setAttribute('aria-modal', String(sheet));
  panel.hidden = false;
  backdrop.hidden = !sheet;
  if (sheet) backdrop.classList.remove('is-closing');

  bellEl?.setAttribute('aria-expanded', 'true');

  render();
  place();
  attachGlobal();
  panel.focus({ preventScroll: true });
}

function close({ restoreFocus = true } = {}) {
  if (!panel || !state.open) return;
  state.open = false;
  closeToken += 1;
  const token = closeToken;

  detachGlobal();
  bellEl?.setAttribute('aria-expanded', 'false');

  const finish = () => {
    if (token !== closeToken) return;
    panel.classList.remove('is-closing');
    panel.hidden = true;
    backdrop.hidden = true;
    backdrop.classList.remove('is-closing');
  };

  if (reducedMotion()) {
    finish();
  } else {
    panel.classList.add('is-closing');
    backdrop.classList.add('is-closing');
    setTimeout(finish, CLOSE_MS);
  }

  if (restoreFocus && openTrigger?.isConnected) openTrigger.focus({ preventScroll: true });
}

// ── data ───────────────────────────────────────────────────────────────────

function applyPayload(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const unread = Number.isFinite(data?.unread)
    ? data.unread
    : items.filter((item) => !item.readAt).length;
  state.items = items;
  applyUnread(unread);
  announce(items);
}

/** One poll: fetch the feed and keep everything else in step with it. */
async function poll() {
  if (state.signedOut) return;
  if (authOverlayVisible()) {
    // A signed-out tab has no feed. The dot goes away, the timer stops, and the
    // next visibilitychange (or the sign-in overlay closing) tries again.
    state.signedOut = true;
    stopTimer();
    applyUnread(0);
    state.phase = 'idle';
    renderIfOpen();
    return;
  }

  pollController?.abort();
  const controller = new AbortController();
  pollController = controller;

  if (!state.items.length && state.phase !== 'error') state.phase = 'loading';
  renderIfOpen();

  try {
    const res = await fetch(API.list(LIMIT), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 401) {
      state.signedOut = true;
      stopTimer();
      applyUnread(0);
      state.phase = 'idle';
      return;
    }
    if (!res.ok) throw new Error(`notifications: HTTP ${res.status}`);
    const data = await res.json();
    if (controller.signal.aborted) return;
    applyPayload(data);
    state.phase = 'ready';
  } catch (error) {
    if (error?.name === 'AbortError') return;
    // Keep whatever is on screen: a failed poll is not a reason to blank a feed
    // that was correct a minute ago.
    state.phase = state.items.length ? 'ready' : 'error';
  } finally {
    if (pollController === controller) pollController = null;
    renderIfOpen();
  }
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') void poll();
  }, POLL_MS);
}

function stopTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// ── read state ─────────────────────────────────────────────────────────────

async function markRead(ids) {
  try {
    const res = await post(API.read, { ids });
    const data = await res.json().catch(() => ({}));
    if (Number.isFinite(data?.unread)) applyUnread(data.unread);
    renderIfOpen();
  } catch {
    // The row is already marked locally; the next poll reconciles.
  }
}

async function markAllRead() {
  try {
    const res = await post(API.readAll);
    const data = await res.json().catch(() => ({}));
    const now = new Date().toISOString();
    state.items = state.items.map((item) => (item.readAt ? item : { ...item, readAt: now }));
    applyUnread(Number.isFinite(data?.unread) ? data.unread : 0);
  } catch {
    // Nothing changed on the server, so leave the dot alone: it is still true.
  }
  renderIfOpen();
}

/** The manual sweep. The server throttles it to a minute per user and answers
 *  `throttled: true` rather than erroring — that is a fine answer, not a bug. */
async function checkNow() {
  if (state.checking) return;
  if (Date.now() - state.lastCheck < CHECK_MS) {
    await poll();
    return;
  }
  state.checking = true;
  state.lastCheck = Date.now();
  renderIfOpen();
  try {
    const res = await post(API.check);
    if (res.ok) await res.json().catch(() => null);
  } catch {}
  state.checking = false;
  await poll();
  renderIfOpen();
}

/**
 * One row, tapped. Optimistic locally (the accent clears immediately), then
 * closed and navigated, then confirmed with the server. `item.url` comes from
 * the server and is the only route this module will ever navigate to.
 */
function activate(item) {
  const now = new Date().toISOString();
  const wasUnread = !item.readAt;
  state.items = state.items.map((row) => (row.id === item.id ? { ...row, readAt: row.readAt || now } : row));
  applyUnread(Math.max(0, state.unread - (wasUnread ? 1 : 0)));

  // No focus restore: the route change owns focus from here on, and pulling it
  // back to the bell would fight the page the user just asked for.
  close({ restoreFocus: false });

  if (item.url) location.hash = item.url;
  void markRead([item.id]);
}

// ── desktop / PWA alerts ───────────────────────────────────────────────────

/** The active service worker, or null. `ready` never resolves when no worker is
 *  registered, so it is raced against a timeout and the constructor fallback. */
function registration(timeout = 2500) {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker) return Promise.resolve(null);
  return Promise.race([
    navigator.serviceWorker.ready.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
  ]);
}

/**
 * Announce rows that are newer than the highest id we have already seen.
 *
 * The very first run only records a baseline: following an artist with twelve
 * albums must not fire twelve notifications. `tag` is per row id, so a second
 * poll that sees the same row cannot alert twice even if this code runs again.
 */
function announce(items) {
  const highest = items.reduce((max, item) => Math.max(max, Number(item?.id) || 0), 0);
  const seen = readSeen();
  if (seen == null) {
    writeSeen(highest);
    return;
  }
  if (highest <= seen) return;

  const fresh = items.filter((item) => (Number(item?.id) || 0) > seen);
  writeSeen(highest);

  if (!fresh.length) return;
  if (!desktopAlertsOn()) return;
  if (permissionState() !== 'granted') return;

  for (const item of fresh.slice(0, ALERT_BURST)) void showAlert(item);
}

async function showAlert(item) {
  const title = item.title || item.artistName || 'sonora';
  const body = item.body || item.artistName || 'New release';
  const options = {
    body,
    icon: item.thumb || '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    // Grouped per row: the OS collapses a re-show instead of stacking a
    // duplicate, which is the second line of defence behind `sonora.notifSeen`.
    tag: `sonora-${item.id}`,
    data: { url: item.url || null },
  };
  try {
    const active = await registration();
    if (active && typeof active.showNotification === 'function') {
      await active.showNotification(title, options);
      return;
    }
    if (typeof Notification === 'function') new Notification(title, options);
  } catch {
    // A notification that cannot be shown must never break the poll.
  }
}

/**
 * Ask for permission — and only ever from a real user gesture: the settings
 * toggle (app.js announces it with `sonora:pref-change`) or the panel's own
 * "Enable alerts" button. Asking on page load is how a site gets denied for
 * good, and the bell works without it.
 */
async function askPermission() {
  if (permissionState() !== 'default') return permissionState();
  if (typeof Notification?.requestPermission !== 'function') return permissionState();
  askingPermission = true;
  try {
    await Notification.requestPermission();
  } catch {
    // Some browsers throw when the call is not user-initiated; treat as default.
  } finally {
    askingPermission = false;
  }
  return permissionState();
}

async function enableAlerts() {
  const result = await askPermission();
  if (result === 'granted') {
    // The button says "Enable", so it has to actually enable the alerts, not
    // just collect a permission that nothing reads.
    writePref('desktopAlerts', true);
  }
  renderIfOpen();
}

// ── wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('sonora:pref-change', (event) => {
  const detail = event.detail ?? {};
  if (detail.key !== 'desktopAlerts') return;
  if (askingPermission) return;
  if (detail.value === true) void askPermission().then(() => renderIfOpen());
  else renderIfOpen();
});

// A notification tapped in the OS while the app is already open arrives as a
// message from the worker (see notificationclick in sw.js). The worker cannot
// navigate a fragment, so the page applies it.
function applyUrl(raw) {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return;
  if (url.startsWith('#')) { location.hash = url; return; }
  try {
    const target = new URL(url, location.href);
    if (target.origin === location.origin) {
      if (target.pathname === location.pathname) location.hash = target.hash;
      else location.assign(target.href);
    }
  } catch {}
}

if ('serviceWorker' in navigator && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'sonora:open-url') return;
    applyUrl(data.url);
  });
}

// The sign-in overlay closing is the moment a 401 becomes recoverable without
// waiting for the user to leave the tab and come back.
//
// Two guards, because the overlay is written to more than once per sign-in:
// app.js removes `.closing` and then sets `hidden`, and the boot path touches
// both attributes as well. Reacting to every mutation asked for the feed three
// times for one sign-in (and the same on a plain load of a signed-out tab), so
// this fires only on the *transition* into hidden while a 401 is on record, and
// coalesces the attribute writes that follow it into a single poll.
function watchAuth() {
  const overlay = document.getElementById('auth-overlay');
  if (!overlay || typeof MutationObserver !== 'function') return;
  let wasHidden = overlay.hidden;
  let pending = 0;
  new MutationObserver(() => {
    const hidden = overlay.hidden;
    const closed = hidden && !wasHidden;
    wasHidden = hidden;
    if (!closed || !state.signedOut || pending) return;
    pending = setTimeout(() => {
      pending = 0;
      if (!state.signedOut) return;
      state.signedOut = false;
      startTimer();
      void poll();
    }, 0);
  }).observe(overlay, { attributes: true, attributeFilter: ['hidden', 'class'] });
}

function boot() {
  if (!buildChrome()) return;
  applyUnread(0);
  watchAuth();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      state.signedOut = false;
      startTimer();
      void poll();
    } else {
      // Nothing to poll for behind a closed tab, and an in-flight request would
      // only keep the radio awake.
      stopTimer();
      pollController?.abort();
    }
  });

  startTimer();
  void poll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// The one interface app.js is allowed to use (its `case 'notifications'` calls
// open(el)). Everything else here is private.
window.__sonoraNotifications = {
  open,
  close,
  refresh: () => poll(),
};
