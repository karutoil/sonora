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
// .tmp/plan/brief.md); `sonora.notifSeen` is this module's own event cursor.
// It is scoped per account (see seenKey): two accounts in one browser must not
// share a watermark, or the second one silently loses every alert below the
// first one's highest id. `SEEN_KEY` is only the prefix now — there is no
// shared key to fall back to, because a fallback is the bug.
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
// One silent token rotation at a time, shared by every 401 this module sees.
let refreshing = null;
// /api/me : the account the watermark belongs to. Cached for the page's life,
// and re-fetched after a failure (at most once a poll).
let accountPromise = null;
// The same id, already resolved, for the two paths that cannot wait on a
// promise: the watermark a poll compares against, and the cross-tab channel's
// stamp. '' until the first successful lookup (and again after a sign-out).
let accountNow = '';
// Cross-tab read-state sync; null when the browser has no BroadcastChannel.
let channel = null;

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

/**
 * The last announced event for this account, or null on a first run.
 *
 * Version 2 stores `{ v, at, id, maxId }`. `at` is createdAt in epoch ms and is
 * the primary ordering: SQLite may reuse an INTEGER PRIMARY KEY after its
 * retention pass removes the largest rows. `maxId` remains a separate,
 * monotonic floor for legacy numeric cursors and rows without a usable date.
 */
function readSeen(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && value.v === 2) {
        const storedId = Number(value.id);
        const at = value.at == null ? null : Number(value.at);
        const id = Number.isSafeInteger(storedId) && storedId >= 0
          ? storedId
          : Number(value.maxId);
        const max = Number(value.maxId);
        const maxId = Number.isSafeInteger(max) && max >= 0 ? max : id;
        if ((at == null || Number.isFinite(at))
          && Number.isSafeInteger(id) && id >= 0
          && Number.isSafeInteger(maxId) && maxId >= 0) {
          return { at, id, maxId };
        }
      }
    } catch {
      // The old format was a bare integer, not JSON.
    }
    const legacy = Number(raw);
    return Number.isSafeInteger(legacy) && legacy >= 0
      ? { at: null, id: legacy, maxId: legacy, legacy: true }
      : null;
  } catch { return null; }
}

function writeSeen(key, cursor) {
  const value = {
    v: 2,
    at: cursor.at,
    id: cursor.id,
    maxId: Math.max(cursor.maxId ?? 0, cursor.id),
  };
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/**
 * The account id, or '' when it is not known (signed out, offline, no /api/me).
 * A failure is not cached: the next poll tries again. Bounded by a timeout so a
 * dead network cannot hold up the poll that is waiting to render.
 */
function accountId(timeout = 1500) {
  accountPromise ??= Promise.race([
    fetch('/api/me', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data?.user?.id != null ? String(data.user.id) : ''))
      .catch(() => ''),
    new Promise((resolve) => { setTimeout(() => resolve(''), timeout); }),
  ]).then((id) => {
    if (!id) accountPromise = null;
    else accountNow = id;
    return id;
  });
  return accountPromise;
}

/**
 * The watermark key for the signed-in account, or '' when the account is not
 * known (signed out, offline, or `/api/me` slower than its timeout).
 *
 * There used to be a shared fallback key here, and it was worse than having
 * none: `accountId()` races `/api/me` against 1.5 s, so every user who hit that
 * timeout wrote their highest id into one origin-wide `sonora.notifSeen`, and
 * the next account to hit the same timeout compared its rows against a
 * stranger's watermark — rows below it were silently never announced, and the
 * write that followed re-poisoned the shared key downward for the next victim.
 * That is exactly the bug the per-account key was introduced to fix, reachable
 * on any 3G boot. So an unknown account now gets no key at all: `announce()`
 * announces nothing and writes nothing, and the next poll tries again.
 */
async function seenKey() {
  const id = await accountId();
  return id ? `${SEEN_KEY}:${id}` : '';
}

const permissionState = () => {
  if (typeof Notification !== 'function') return 'unsupported';
  return Notification.permission || 'default';
};

/**
 * One authenticated POST, with the same one-shot rotation `poll()` uses.
 *
 * A write that answered 401 used to be swallowed as `{}` by every caller below:
 * the optimistic row stayed marked here, the server never heard about it, and
 * the next poll put the row back to unread — the exact overnight-tab flap
 * `poll()` documents (the access cookie is short-lived and app.js renews it
 * silently). So a 401 gets one silent refresh and one retry, and anything that
 * still is not `ok` returns null: "this did not land" is a fact the caller can
 * act on, where a 401 response object that parses to `{}` looked like success.
 */
async function post(url, body) {
  const send = () => fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let res;
  try {
    res = await send();
    if (res.status === 401 && await refreshSession()) res = await send();
  } catch {
    return null; // a network failure is the same answer as a refused write
  }
  return res.ok ? res : null;
}

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
 *
 * The copy has to be honest about *when* an alert can arrive. The only producer
 * of one is `announce()`, which runs inside `poll()`, and the poller is stopped
 * and its request aborted the moment the tab is hidden (see `boot`) — with no
 * push subscription anywhere, so the worker has no `push` listener. A user who
 * enabled alerts and then switched tabs or locked the phone would therefore
 * receive nothing, in exactly the case alerts exist for, with the feature
 * looking enabled and no error anywhere (permission is `granted`, so this row
 * disappears). Promising "when a followed artist releases something" was
 * promising background delivery the app cannot do; saying "while sonora is open
 * in a tab" is a smaller feature, stated.
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
    <span class="notif-alerts-copy">Get a desktop alert when a followed artist releases — while sonora is open in a tab.</span>
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
  // The poll re-renders every minute; without this, reading an older row is
  // impossible because the list jumps back to the top each time.
  const scrollTop = panel.querySelector('.notif-list')?.scrollTop ?? 0;

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
  // After the focus restore, so a re-rendered list does not get scrolled twice.
  if (scrollTop) {
    const list = panel.querySelector('.notif-list');
    if (list) list.scrollTop = scrollTop;
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

/**
 * The controls Tab can actually land on, in DOM order — what the phone sheet's
 * Tab loop wraps around.
 *
 * `[href]` used to match SVG `<use href="#i-bell">` too, so the SVG sprite the
 * icons are made of counted as a focus stop: the "last" element in the list
 * could never be focused, and Tab wrapping silently did nothing. `tabIndex >= 0`
 * filters those (and every other non-focusable node) out.
 */
function focusables() {
  return [...panel.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
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
  if (event.key !== 'Tab') return;
  // Only the phone sheet traps Tab.
  //
  // The desktop popover is `aria-modal="false"` — assistive technology is told
  // that the rest of the page is still reachable — so wrapping Tab around its
  // handful of controls contradicted that and was a keyboard trap in the WCAG
  // 2.1.2 sense: a keyboard-only user who does not guess Escape could not get to
  // the page behind the panel (the bell is not one of the stops, so even
  // Shift+Tab from the first control wrapped back to the last).
  //
  // On desktop Tab is now allowed to walk out, and `onFocusIn` closes the panel
  // as it goes, so nothing stays over the page the user just moved into. The
  // sheet keeps the loop because it really is modal: it covers the page and has
  // a backdrop, so there is nothing behind it to reach.
  if (!isSheet()) {
    // Tab out of the *last* control lands on the browser's own chrome, where
    // `document.activeElement` becomes `<body>` and no `focusin` fires at all —
    // so `onFocusIn` alone would leave the panel hanging over a page the user is
    // already tabbing through. Check where focus actually went after the browser
    // has moved it, and close if it is no longer in the panel (or on the bell).
    if (!event.shiftKey) {
      setTimeout(() => {
        if (!state.open) return;
        const active = document.activeElement;
        if (active && active !== document.body
          && (panel.contains(active) || bellEl?.contains(active))) return;
        close({ restoreFocus: false });
      }, 0);
    }
    return;
  }
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

/**
 * Desktop only: focus leaving the popover means the user is done with it.
 *
 * The popover is non-modal, so Tab must be able to leave it — so *something*
 * has to be watching where focus went, or a panel left open would sit over the
 * page the user is now tabbing through. `focusin` rather than `focusout` on
 * purpose: a re-render (`panel.innerHTML = …`) blurs whatever had focus inside
 * the panel with no related target, and closing on that would shut the panel
 * every time the minute's poll repainted it.
 */
function onFocusIn(event) {
  if (!state.open || isSheet()) return;
  const target = event.target;
  if (panel.contains(target) || bellEl?.contains(target)) return;
  // No focus restore: pulling focus back to the bell would undo the move the
  // user just made with the keyboard.
  close({ restoreFocus: false });
}

function attachGlobal() {
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('resize', place);
}

function detachGlobal() {
  document.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('focusin', onFocusIn, true);
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

const asText = (v) => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));

/**
 * A row's id, as the one number both the list and the event cursor use.
 *
 * The server accepts nothing but a positive integer as a notification id (see
 * `markNotificationsRead` in src/db.js), and the cursor has always needed a safe
 * integer. Those two rules used to be applied separately: `sanitizeItems` kept
 * any non-empty string, so a row with id `"4.2"` rendered — and could never be
 * marked read, and was skipped by `eventCursor`, so it also never announced and
 * never advanced the watermark. One rule, applied once, at the door.
 */
function itemId(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Keep only rows this module can render.
 *
 * `/api/notifications` is the server's own route, but a row is a projection of
 * whatever the follows sweep found: a release with no title, a video without a
 * thumbnail, an older server's shape. One `null` in the array used to throw on
 * `item.id` during render; one object title rendered as `[object Object]`. A
 * feed is a list of rows, not a schema, so each row is coerced and the junk is
 * dropped rather than allowed to blank the panel.
 */
function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const id = itemId(item.id ?? item.notificationId);
      if (id === null) return null;
      return {
        ...item,
        id,
        title: asText(item.title),
        body: asText(item.body),
        artistName: asText(item.artistName),
        thumb: asText(item.thumb) || null,
        url: asText(item.url),
        createdAt: asText(item.createdAt),
        readAt: item.readAt ? asText(item.readAt) || null : null,
      };
    })
    .filter(Boolean);
}

async function applyPayload(data) {
  const items = sanitizeItems(data?.items);
  const unread = Number.isFinite(data?.unread)
    ? data.unread
    : items.filter((item) => !item.readAt).length;
  state.items = items;
  applyUnread(unread);
  // Fire-and-forget. `announce` waits on `seenKey()` — a `/api/me` round trip,
  // or its 1.5 s timeout — and awaiting it here held the whole poll (and so
  // `state.phase = 'ready'` and the repaint that follows) behind the shimmer:
  // on a cold start over a slow link the user stared at three skeleton rows for
  // up to 1.5 s *after* the feed had arrived. `queueAnnounce` still runs the
  // announcements in order and swallows their errors, so nothing below needs
  // the result.
  void queueAnnounce(items);
}

/** One poll: fetch the feed and keep everything else in step with it. */
async function poll() {
  if (state.signedOut) return;
  if (authOverlayVisible()) {
    // A signed-out tab has no feed. The dot goes away, the timer stops, and the
    // next visibilitychange (or the sign-in overlay closing) tries again.
    signOut();
    return;
  }

  pollController?.abort();
  const controller = new AbortController();
  pollController = controller;

  if (!state.items.length && state.phase !== 'error') state.phase = 'loading';
  renderIfOpen();

  const fetchList = () => fetch(API.list(LIMIT), {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    signal: controller.signal,
  });

  try {
    let res = await fetchList();
    if (res.status === 401) {
      // A 401 is usually just the short-lived access cookie: app.js answers it
      // with one silent `/api/auth/refresh` and a retry, and the bell has to do
      // the same or a tab left open overnight shows "Nothing new" until it is
      // hidden and shown again (the module's own timer had stopped by then).
      // Only a refresh that also fails means the session is really gone.
      const rotated = await refreshSession();
      if (rotated) res = await fetchList();
    }
    if (res.status === 401) {
      signOut();
      return;
    }
    if (!res.ok) throw new Error(`notifications: HTTP ${res.status}`);
    const data = await res.json();
    if (controller.signal.aborted) return;
    await applyPayload(data);
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

/** Latch "this tab has no session" and stop spending requests on it. */
function signOut() {
  state.signedOut = true;
  stopTimer();
  applyUnread(0);
  // The rows on screen belong to whoever was signed in a moment ago. A later
  // sign-in may be a different account, and until the next poll answers, keeping
  // them would show that account's feed under this one's bell — so the list is
  // emptied and the panel asks for its skeleton ('loading') rather than claiming
  // "Nothing new" about a feed it has not read.
  state.items = [];
  state.phase = 'loading';
  // The next session may be a different account; its watermark is its own, and
  // the cross-tab channel must stop answering to the old one's id.
  accountPromise = null;
  accountNow = '';
  renderIfOpen();
}

/**
 * One silent token rotation, shared by every 401 in this module.
 *
 * The server allows a replay of a just-rotated refresh token for a short grace
 * window precisely so two pages (or two modules in one page) can race this, so
 * a duplicate attempt here is safe; the local promise just avoids making one
 * when the app has already started its own.
 */
function refreshSession(timeout = 4000) {
  if (refreshing) return refreshing;
  refreshing = Promise.race([
    fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async (res) => {
        // Do not leave an unread 401/rotation body behind when returning only
        // a boolean. In the signed-out boot path both this module and app.js
        // refresh at once; consuming the response lets the worker update job
        // finish instead of keeping its initial network transaction open.
        await res.arrayBuffer();
        return res.ok;
      })
      .catch(() => false),
    new Promise((resolve) => { setTimeout(() => resolve(false), timeout); }),
  ]).finally(() => { refreshing = null; });
  return refreshing;
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

/**
 * Tell the other tabs what this one just read.
 *
 * Read state is server-side but each tab keeps its own copy for a minute, so
 * reading a row here left another tab's dot and count wrong until its next
 * poll — long enough to look broken. The message carries the ids (or the
 * authoritative unread count) so a peer reconciles without a request.
 *
 * It also carries the *account* the change belongs to. The channel is
 * origin-scoped and this module explicitly supports two signed-in people in one
 * browser (see the top of the file), so an unlabelled message let tab A's
 * "Mark all read" mark tab B's rows read, adopt A's unread count and clear B's
 * badge — for an account that never opened them.
 */
function tellPeers(message) {
  // No id yet (the first `/api/me` is still in flight, or this tab is signed
  // out): a message nothing can be scoped to is not worth sending, and the
  // peer's own poll catches up within a minute either way.
  if (!accountNow) return;
  try { channel?.postMessage({ ...message, account: accountNow }); } catch {}
}

/** Apply a peer's read change locally, then repaint. Never re-broadcasts. */
function applyPeerMessage(data) {
  if (!data || typeof data !== 'object') return;
  // Drop anything not addressed to the account on screen here. A message with
  // no account at all is from an older page of this module (every message is
  // stamped now), and guessing whose read state it describes is exactly the
  // cross-account bug this check exists to stop.
  if (!accountNow || String(data.account ?? '') !== accountNow) return;
  if (data.type === 'read' && Array.isArray(data.ids)) {
    const ids = new Set(data.ids.map((id) => String(id)));
    const now = new Date().toISOString();
    state.items = state.items.map((row) => (
      ids.has(String(row.id)) && !row.readAt ? { ...row, readAt: now } : row
    ));
    applyUnread(Number.isFinite(data.unread) ? data.unread : state.items.filter((row) => !row.readAt).length);
  } else if (data.type === 'read-all') {
    const now = new Date().toISOString();
    state.items = state.items.map((row) => (row.readAt ? row : { ...row, readAt: now }));
    applyUnread(Number.isFinite(data.unread) ? data.unread : 0);
  } else if (data.type === 'unread' && Number.isFinite(data.unread)) {
    applyUnread(data.unread);
  } else {
    return;
  }
  renderIfOpen();
}

/**
 * Mark rows read on the server, and say whether the write landed.
 *
 * `post()` retries a 401 once and answers null for anything that did not stick,
 * so the caller (`activate`) can undo the optimistic paint instead of leaving a
 * row that the next poll flips back to unread. A failed write also sends nothing
 * to the other tabs: a peer that adopted a read nobody committed was the other
 * half of that flap.
 */
async function markRead(ids) {
  const res = await post(API.read, { ids });
  if (!res) {
    renderIfOpen();
    return false;
  }
  const data = await res.json().catch(() => ({}));
  if (Number.isFinite(data?.unread)) applyUnread(data.unread);
  tellPeers({ type: 'read', ids, unread: data?.unread });
  renderIfOpen();
  return true;
}

async function markAllRead() {
  const res = await post(API.readAll);
  // Nothing changed on the server, so leave the dot alone: it is still true.
  if (res) {
    const data = await res.json().catch(() => ({}));
    const now = new Date().toISOString();
    state.items = state.items.map((item) => (item.readAt ? item : { ...item, readAt: now }));
    applyUnread(Number.isFinite(data?.unread) ? data.unread : 0);
    tellPeers({ type: 'read-all', unread: Number.isFinite(data?.unread) ? data.unread : 0 });
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
  const res = await post(API.check);
  if (res) await res.json().catch(() => null);
  state.checking = false;
  await poll();
  renderIfOpen();
}

/**
 * One row, tapped. Optimistic locally (the accent clears immediately), then
 * closed and navigated, then confirmed with the server. `item.url` comes from
 * the server and is the only route this module will ever navigate to.
 *
 * The optimistic paint is kept — a tap that waits on a round trip feels broken —
 * and undone if `markRead` reports the write did not land, which is what the
 * 401 retry inside `post()` made knowable. A write that *did* land needs no
 * optimism at all: the next poll reads the same state back, so there is nothing
 * left to flap.
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
  void markRead([item.id]).then((ok) => {
    if (ok || !wasUnread) return;
    // Unread again, from the list rather than from an old count: a poll may have
    // landed while the write was in flight.
    state.items = state.items.map((row) => (row.id === item.id ? { ...row, readAt: item.readAt ?? null } : row));
    applyUnread(state.items.filter((row) => !row.readAt).length);
    renderIfOpen();
  });
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

/** A server row's stable event order. A missing date keeps the legacy id path. */
function eventCursor(item, maxId) {
  const id = itemId(item?.id);
  if (id === null) return null;
  const parsed = Date.parse(String(item?.createdAt ?? ''));
  return {
    at: Number.isFinite(parsed) ? parsed : null,
    id,
    maxId: Math.max(maxId, id),
  };
}

function compareCursor(a, b) {
  if (a.at != null && b.at != null && a.at !== b.at) return a.at > b.at ? 1 : -1;
  if (a.id !== b.id) return a.id > b.id ? 1 : -1;
  return 0;
}

/**
 * Announce events after this account's persisted `(createdAt, id)` cursor.
 *
 * The very first run only records a baseline: following an artist with twelve
 * albums must not fire twelve notifications. Thereafter a newer createdAt wins
 * even when retention made SQLite reuse a lower id. Equal timestamps use the
 * id tie-breaker, matching the server's ordering and allowing a same-ms burst.
 * The separate maxId and legacy branch preserve the old bare-number behaviour
 * during its one-time upgrade. Both the cursor and its per-account key survive
 * reloads, so re-polling (or restarting on) the same event stays silent.
 */
async function announce(items) {
  const key = await seenKey();
  // No account id means no honest watermark to compare against: announcing on
  // the shared key is what swallowed alerts for a second account, and writing
  // one would poison it for the next. Skipping costs this poll's alerts at
  // worst — the next poll (or the tab's return) tries again.
  if (!key) return;
  const seen = readSeen(key);
  const maxId = Math.max(seen?.maxId ?? 0, ...items.map((item) => itemId(item?.id) ?? 0));
  const rows = items
    .map((item) => ({ item, cursor: eventCursor(item, maxId) }))
    .filter((entry) => entry.cursor !== null);
  const newest = rows.reduce((latest, entry) => (
    !latest || compareCursor(entry.cursor, latest) > 0 ? entry.cursor : latest
  ), null) ?? { at: null, id: 0, maxId };

  if (seen == null) {
    writeSeen(key, newest);
    return;
  }

  const fresh = seen.legacy
    ? rows.filter((entry) => entry.cursor.id > seen.id)
    : rows.filter((entry) => compareCursor(entry.cursor, seen) > 0);

  if (seen.legacy) {
    // A bare number carries no date against which reused ids could be compared.
    // Keep that established id-only decision for this response, then persist a
    // dated cursor so every subsequent response has the missing information.
    writeSeen(key, { ...newest, maxId });
  } else if (fresh.length) {
    const next = fresh.reduce((latest, entry) => (
      compareCursor(entry.cursor, latest) > 0 ? entry.cursor : latest
    ), { ...seen, maxId });
    writeSeen(key, next);
  } else if (maxId > seen.maxId) {
    // An undated/id-only response can still advance the old numeric floor.
    writeSeen(key, { ...seen, maxId });
  }

  if (!fresh.length) return;
  if (!desktopAlertsOn()) return;
  if (permissionState() !== 'granted') return;

  for (const { item } of fresh.slice(0, ALERT_BURST)) void showAlert(item);
}

/**
 * Run `announce` after the previous one, without making the caller wait.
 *
 * `applyPayload` no longer awaits the announcement (it used to hold the whole
 * repaint behind `/api/me`), so two polls can overlap its tail: a fast second
 * poll could read the watermark before the first had written it, re-baseline
 * past the very row that should have alerted, and then have the first one's
 * older `highest` written over it. Chaining keeps the watermark monotonic while
 * the poll itself stays non-blocking. Errors are its own to swallow.
 */
let announceChain = Promise.resolve();
function queueAnnounce(items) {
  announceChain = announceChain.then(() => announce(items)).catch(() => {});
  return announceChain;
}

async function showAlert(item) {
  const title = item.title || item.artistName || 'sonora';
  const body = item.body || item.artistName || 'New release';
  const options = {
    body,
    // A row with no artwork is normal; a row whose thumb is not a string is not
    // something to hand the notification API.
    icon: asText(item.thumb) || '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    // Grouped per row: the OS collapses a re-show instead of stacking a
    // duplicate, which is the second line of defence behind the watermark.
    tag: `sonora-${item.id}`,
    data: { url: asText(item.url) || null },
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
  if (detail.value !== true) {
    renderIfOpen();
    return;
  }
  // A browser with no `Notification` at all (iOS Safari in a tab, which is where
  // this app spends its life) cannot ever show a desktop alert. `askPermission()`
  // has nothing to ask, `alertsRowHtml()` says nothing, and `announce()` refuses
  // at `permissionState() !== 'granted'` — so storing `true` would only make the
  // settings toggle claim a feature that does not exist, on every reload. The
  // write is refused instead, which flips app.js's checkbox back off (it mirrors
  // this event into `state.prefs`) and leaves the stored value honest.
  if (permissionState() === 'unsupported') {
    writePref('desktopAlerts', false);
    renderIfOpen();
    return;
  }
  void askPermission().then(() => renderIfOpen());
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
      // A sign-in can be a different person: do not keep the previous account's
      // watermark (nor the previous account's alert baseline), and do not let a
      // peer message from the old account through.
      accountPromise = null;
      accountNow = '';
      startTimer();
      void poll();
    }, 0);
  }).observe(overlay, { attributes: true, attributeFilter: ['hidden', 'class'] });
}

// Read state lives on the server, but every tab renders its own copy until its
// next poll. A change made in one tab is announced here so the other tab's dot,
// badge and rows agree immediately instead of up to a minute later.
function watchTabs() {
  try {
    if (typeof BroadcastChannel !== 'function') return;
    channel = new BroadcastChannel('sonora-notifications');
    channel.addEventListener('message', (event) => applyPeerMessage(event.data));
  } catch {
    channel = null; // a private-mode browser that refuses BroadcastChannel
  }
}

function boot() {
  if (!buildChrome()) return;
  applyUnread(0);
  watchAuth();
  watchTabs();

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
