// sonora — install / update / offline chrome.
//
// Self-initialising ES module. It deliberately shares nothing with app.js
// except the DOM contract that already exists (data-page / data-collection
// buttons and #auth-overlay), so a broken app.js still registers the worker
// and a broken pwa.js leaves a fully usable app. Nothing is exposed globally.
//
// Three jobs, all of them quiet until relevant:
//   1. register /sw.js, and offer a one-tap refresh when a new build is waiting
//   2. offer installation — Android/desktop banner, iOS "Add to Home Screen" sheet
//   3. narrate the connection: a slim offline pill that recovers by itself

const PRODUCT = 'sonora';
const SNOOZE_KEY = 'sonora.pwa.install-snoozed-until';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // two weeks
const UPDATE_CHECK_MS = 30 * 60 * 1000;

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches === true
  || window.navigator.standalone === true;

/** iOS Safari is the one engine with an install flow but no beforeinstallprompt. */
const isIosSafari = () => {
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/.test(ua)
    && /Safari/.test(ua)
    && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA)/.test(ua);
};

const snoozed = () => {
  try { return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now(); } catch { return false; }
};

const snooze = () => {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* private mode */ }
};

const h = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// ── the stack ───────────────────────────────────────────────────────────────
// One fixed column in the gap above the player (see pwa.css for the offsets).
// Created lazily: on desktop with nothing to say, this module adds no nodes.

let stackEl = null;
const STACK_GAP = 10;

/**
 * Sit just above the player bar, whatever the app's layout currently is.
 * Measuring beats hardcoding: app.css owns --player-h/--nav-h and its
 * breakpoints, and this chrome must survive that changing underneath it.
 * Runs on every show and on resize/orientationchange; no polling.
 */
function placeStack() {
  if (!stackEl || !stackEl.isConnected) return;
  const rect = document.querySelector('.player')?.getBoundingClientRect();
  const visible = rect && rect.height > 0 && rect.top > 0 && rect.top < window.innerHeight;
  if (!visible) {
    // No player bar on screen: fall back to pwa.css's safe-area position.
    stackEl.style.removeProperty('--pwa-bottom');
    return;
  }
  const bottom = Math.round(window.innerHeight - rect.top) + STACK_GAP;
  stackEl.style.setProperty('--pwa-bottom', `${bottom}px`);
}

function stack() {
  if (!stackEl || !stackEl.isConnected) {
    stackEl = h('div', 'pwa-stack');
    document.body.append(stackEl);
  }
  placeStack();
  return stackEl;
}

function watchLayout() {
  const schedule = () => requestAnimationFrame(() => {
    placeStack();
    // A window that crosses the sidebar breakpoint changes which *shape* the
    // install offer should take, without changing whether it is offered.
    reflowInstall();
  });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
  // The player's own box can change without a window resize (a station starts,
  // an album art gets taller). Observe it if the browser can.
  const player = document.querySelector('.player');
  if (player && 'ResizeObserver' in window) new ResizeObserver(schedule).observe(player);
}

// ── bottom-edge self-check ─────────────────────────────────────────────────
// An installed iOS app can report a viewport shorter than the screen, which
// leaves a dead band under the nav (the "chin"). index.html publishes
// --app-h to close it; this check exists for the case where that still is not
// enough, because a silent gap is unfixable while a labelled one is not: if the
// shell cannot reach the bottom of the screen, say so with the numbers.
//
// It reads the *smaller* of the shell and the root: a shell taller than its
// clipping ancestor looks correct to getBoundingClientRect and still shows a
// gap on the phone, so measuring only .app would miss it.
const CHIN_SLACK = 2; // rounding, not a bug

function checkBottomEdge() {
  // Strictly iOS home-screen: elsewhere screen.height is the display, not this
  // window, and a split-screen window would report a false chin.
  if (window.navigator.standalone !== true || !window.screen?.height) return;
  const shell = document.querySelector('.app');
  if (!shell) return;
  const root = document.documentElement;
  const reached = Math.min(
    shell.getBoundingClientRect().height,
    root.getBoundingClientRect().height,
  );
  const missing = Math.round(window.screen.height - reached);
  if (missing <= CHIN_SLACK) { removePill('chin'); return; }

  const text = `Display: ${Math.round(reached)}px of ${window.screen.height}px`
    + ` — ${missing}px short`;
  const existing = pills.get('chin');
  if (existing) { existing.querySelector('.pwa-pill-text').textContent = text; return; }
  // No action button: this reports, it does not pretend to fix.
  showPill('chin', { text, tone: 'warn' });
}

function watchBottomEdge() {
  // iOS re-measures the viewport a frame or two after the first paint, and again
  // after backgrounding, so check more than once per launch.
  const check = () => requestAnimationFrame(checkBottomEdge);
  checkBottomEdge();
  setTimeout(check, 500);
  setTimeout(check, 1500);
  window.addEventListener('resize', check, { passive: true });
  window.addEventListener('orientationchange', check, { passive: true });
  window.addEventListener('pageshow', check, { passive: true });
  document.addEventListener('visibilitychange', check);
}

// ── pills ───────────────────────────────────────────────────────────────────

const pills = new Map();

function removePill(kind) {
  const pill = pills.get(kind);
  if (pill) pill.remove();
  pills.delete(kind);
}

function showPill(kind, { text, tone, actionLabel, onAction, onDismiss }) {
  removePill(kind);
  const pill = h('div', 'pwa-pill');
  pill.dataset.kind = kind;
  if (tone) pill.dataset.tone = tone;
  // role=status gives screen readers the change without stealing focus.
  pill.setAttribute('role', 'status');

  const dot = h('span', 'pwa-pill-dot');
  dot.setAttribute('aria-hidden', 'true');
  const label = h('span', 'pwa-pill-text', text);
  pill.append(dot, label);

  if (actionLabel && onAction) {
    const action = h('button', 'pwa-pill-action', actionLabel);
    action.type = 'button';
    action.addEventListener('click', onAction);
    pill.append(action);
  }

  const dismiss = h('button', 'pwa-pill-dismiss', '\u00d7');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.addEventListener('click', () => {
    onDismiss?.();
    removePill(kind);
  });
  pill.append(dismiss);

  stack().append(pill);
  pills.set(kind, pill);
  return pill;
}

// ── update flow ─────────────────────────────────────────────────────────────
// The worker never calls skipWaiting() on its own: the app must not change
// underneath a playing track. The user taps Refresh, the worker is released,
// the page reloads exactly once.

let acceptingUpdate = false;
let reloading = false;
let reloadTimer = 0;

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  clearTimeout(reloadTimer);
  location.reload();
}

function offerUpdate(registration) {
  if (pills.has('update')) return;
  showPill('update', {
    text: 'New version available',
    actionLabel: 'Refresh',
    onAction: () => {
      acceptingUpdate = true;
      removePill('update');
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      // If there was no waiting worker after all (or it vanished), still honour
      // the tap — a plain reload is what the user asked for.
      reloadTimer = setTimeout(reloadOnce, 2500);
    },
  });
}

function wireUpdates(registration) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (acceptingUpdate) reloadOnce();
  });

  if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration);

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // "installed" with an existing controller means: a new build is ready.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(registration);
    });
  });

  // Look for a new deploy when the app comes back to the foreground, at most
  // every half hour — iOS never re-checks by itself once installed.
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck < UPDATE_CHECK_MS) return;
    lastCheck = Date.now();
    registration.update().catch(() => {});
  });
}

// ── install flow ────────────────────────────────────────────────────────────
//
// Installing is not a phone gesture. Chromium fires beforeinstallprompt on
// Windows and macOS too, and there an installed PWA gets its own Start-menu /
// Dock entry, a frameless window and an offline shell — the same three things
// the phone offer promises. So the offer is made everywhere.
//
// Only its *shape* is platform-specific. The card below is phone furniture (art
// tile, stacked 44px buttons); dropped into a desktop window it covered the
// bottom of the sidebar and the content grid, so there the same offer is made
// as a one-line notice above the player. DESKTOP_QUERY mirrors app.css's
// sidebar breakpoint (see docs/ui.md) — one definition of "desktop", not two.

const DESKTOP_QUERY = '(min-width: 1081px)';
const isDesktop = () => window.matchMedia?.(DESKTOP_QUERY).matches === true;

let deferredPrompt = null;
let installEl = null;
let installKind = null;

function dismissInstall() {
  if (installEl) installEl.remove();
  installEl = null;
  installKind = null;
  removePill('install');
}

/** One-tap install, shared by the card and the notice. */
async function runInstallPrompt() {
  const prompt = deferredPrompt;
  deferredPrompt = null;
  dismissInstall();
  if (!prompt || typeof prompt.prompt !== 'function') return;
  prompt.prompt();
  try {
    const choice = await prompt.userChoice;
    // Dismissing the browser's own dialog is still a "no" — honour it for
    // two weeks instead of asking again on the next page load.
    if (choice?.outcome !== 'accepted') snooze();
  } catch { /* prompt() can reject if the event is stale */ }
}

function installBanner(kind) {
  if ((installEl && installEl.isConnected) || isStandalone() || snoozed()) return;

  const banner = h('div', 'pwa-banner');
  banner.setAttribute('role', 'group');
  banner.setAttribute('aria-labelledby', 'pwa-install-title');

  const art = document.createElement('img');
  art.className = 'pwa-banner-art';
  art.src = '/icons/icon-192.png';
  art.alt = '';
  art.width = 38;
  art.height = 38;
  art.decoding = 'async';

  const body = h('div', 'pwa-banner-body');
  const title = h('p', 'pwa-banner-title', `Install ${PRODUCT}`);
  title.id = 'pwa-install-title';
  const text = h('p', 'pwa-banner-text', kind === 'ios'
    ? 'Add it to your Home Screen: full screen, one tap away, works offline.'
    : 'One tap from your home screen — full screen and an offline shell.');
  body.append(title, text);
  const actions = h('div', 'pwa-banner-actions');

  const primary = h('button', 'pwa-banner-btn primary', kind === 'ios' ? 'How' : 'Install');
  primary.type = 'button';
  primary.addEventListener('click', () => {
    if (kind === 'ios') openSheet(primary);
    else runInstallPrompt();
  });

  const ghost = h('button', 'pwa-banner-btn ghost', 'Not now');
  ghost.type = 'button';
  ghost.addEventListener('click', () => { snooze(); dismissInstall(); });

  actions.append(primary, ghost);
  banner.append(art, body, actions);
  stack().append(banner);
  installEl = banner;
  installKind = kind;
}

/**
 * Desktop shape: the same offer, at notification weight. One line, one button,
 * one dismiss, in the corner above the player — nothing like the card's block
 * of art and stacked buttons over the sidebar and the grid.
 */
function installNotice() {
  if ((installEl && installEl.isConnected) || isStandalone() || snoozed()) return;
  installEl = showPill('install', {
    text: `Add ${PRODUCT} to your desktop — full screen, works offline.`,
    actionLabel: 'Install',
    onAction: runInstallPrompt,
    // × is this notice's "Not now".
    onDismiss: snooze,
  });
  installKind = 'chromium';
}

/** Choose the shape that matches the window the offer is being made in. */
function offerInstall(kind) {
  if (kind !== 'ios' && isDesktop()) installNotice();
  else installBanner(kind);
}

/** Follow the window: widening past the sidebar breakpoint turns the card into
 *  a notice and narrowing turns it back, without ever snoozing the offer. */
function reflowInstall() {
  if (!installEl?.isConnected) return;
  const isCard = installEl.classList.contains('pwa-banner');
  if (isCard === isDesktop()) {
    dismissInstall();
    offerInstall(installKind ?? 'chromium');
  }
}

window.addEventListener('beforeinstallprompt', (event) => {
  // The default mini-infobar covers the app and cannot be styled. Keep the
  // event so Install can be a real one-tap prompt later.
  event.preventDefault();
  deferredPrompt = event;
  // Let the first paint land before asking for anything: a banner in the same
  // frame as the page is the visual equivalent of a pop-up.
  setTimeout(() => offerInstall('chromium'), 1200);
});

window.addEventListener('appinstalled', () => {
  dismissInstall();
  snooze();
});

/** iOS never fires beforeinstallprompt; offer the Share sheet instructions. */
function offerIosInstall() {
  if (!isIosSafari() || isStandalone() || snoozed()) return;
  setTimeout(() => installBanner('ios'), 6000);
  // Or as soon as they interact — but not in the first beats of a page load,
  // when a banner would just be noise.
  setTimeout(() => {
    window.addEventListener('pointerdown', () => installBanner('ios'), { once: true, passive: true });
  }, 2500);
}

// ── iOS explainer sheet ─────────────────────────────────────────────────────

const SHARE_GLYPH = '<svg class="pwa-step-share" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3v11M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

let sheetBackdrop = null;
let sheetReturnFocus = null;

function focusableIn(root) {
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
}

function onSheetKeydown(event) {
  if (!sheetBackdrop) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSheet();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusableIn(sheetBackdrop);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeSheet() {
  if (!sheetBackdrop) return;
  sheetBackdrop.remove();
  sheetBackdrop = null;
  document.removeEventListener('keydown', onSheetKeydown, true);
  // The trigger may be gone (banner dismissed meanwhile); never focus a ghost.
  if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

function openSheet(trigger) {
  if (sheetBackdrop) return;
  sheetReturnFocus = trigger || document.activeElement;

  const backdrop = h('div', 'pwa-sheet-backdrop');
  const sheet = h('div', 'pwa-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'pwa-sheet-title');
  sheet.setAttribute('aria-describedby', 'pwa-sheet-text');
  // Static copy only — no interpolation, so innerHTML is safe here.
  sheet.innerHTML = `
    <div class="pwa-sheet-head">
      <img class="pwa-sheet-art" src="/icons/icon-192.png" alt="" width="44" height="44" decoding="async">
      <div>
        <h2 class="pwa-sheet-title" id="pwa-sheet-title">Add ${PRODUCT} to your Home Screen</h2>
        <p class="pwa-sheet-text" id="pwa-sheet-text">Safari keeps it one tap away, full screen and offline-ready.</p>
      </div>
      <button class="pwa-sheet-close" type="button" aria-label="Close">\u2715</button>
    </div>
    <ol class="pwa-steps">
      <li class="pwa-step">
        <span class="pwa-step-n" aria-hidden="true">1</span>
        <div><strong>Tap Share ${SHARE_GLYPH}</strong><p>It is the square with the arrow, in Safari's toolbar.</p></div>
      </li>
      <li class="pwa-step">
        <span class="pwa-step-n" aria-hidden="true">2</span>
        <div><strong>Choose <b>Add to Home Screen</b></strong><p>Scroll the share sheet if you cannot see it.</p></div>
      </li>
      <li class="pwa-step">
        <span class="pwa-step-n" aria-hidden="true">3</span>
        <div><strong>Tap <b>Add</b></strong><p>${PRODUCT} then opens like any other app.</p></div>
      </li>
    </ol>
    <button class="pwa-banner-btn primary pwa-sheet-done" type="button">Got it</button>`;

  backdrop.append(sheet);
  document.body.append(backdrop);
  sheetBackdrop = backdrop;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeSheet();
  });
  sheet.querySelector('.pwa-sheet-close').addEventListener('click', closeSheet);
  sheet.querySelector('.pwa-sheet-done').addEventListener('click', closeSheet);
  document.addEventListener('keydown', onSheetKeydown, true);

  // Focus moves into the dialog, and back to the trigger on close.
  const close = sheet.querySelector('.pwa-sheet-close');
  setTimeout(() => { if (close.isConnected) close.focus(); }, 0);
}

// ── connection state ────────────────────────────────────────────────────────

let onlineTimer = 0;

function syncConnection() {
  clearTimeout(onlineTimer);
  const existing = pills.get('offline');
  if (navigator.onLine) {
    // Only speak if we had something to say.
    if (!existing) return;
    existing.dataset.tone = 'online';
    const label = existing.querySelector('.pwa-pill-text');
    if (label) label.textContent = 'Back online.';
    existing.querySelector('.pwa-pill-action')?.remove();
    onlineTimer = setTimeout(() => removePill('offline'), 2600);
    return;
  }
  showPill('offline', {
    text: "You're offline — playback needs a connection.",
    tone: 'offline',
  });
}

// ── manifest shortcuts ──────────────────────────────────────────────────────
// The app routes in memory, so "?page=search" from the home-screen shortcut is
// translated into the same click the user would make. If the app ever grows a
// URL router this becomes a no-op (the nav is already active).

const cssEscape = (value) => (window.CSS?.escape
  ? CSS.escape(value)
  : String(value).replace(/["\\\]]/g, '\\$&'));

function waitForElement(selector, timeout = 8000) {
  return new Promise((resolve) => {
    const immediate = document.querySelector(selector);
    if (immediate) { resolve(immediate); return; }
    const observer = new MutationObserver(() => {
      const node = document.querySelector(selector);
      if (node) { stop(); resolve(node); }
    });
    const timer = setTimeout(() => { stop(); resolve(null); }, timeout);
    function stop() { observer.disconnect(); clearTimeout(timer); }
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function honourShortcut() {
  const params = new URLSearchParams(location.search);
  const page = params.get('page');
  const collection = params.get('collection');
  if (!page && !collection) return;
  const selector = collection
    ? `[data-collection="${cssEscape(collection)}"]`
    : `[data-page="${cssEscape(page)}"]`;

  waitForElement(selector).then((target) => {
    if (!target) return;
    // Signed out: leave the query string alone so the next boot lands right.
    const auth = document.getElementById('auth-overlay');
    if (auth && !auth.hidden) return;
    if (!target.classList.contains('active')) target.click();
    history.replaceState(null, '', location.pathname);
  });
}

// ── boot ────────────────────────────────────────────────────────────────────

async function init() {
  syncConnection();
  window.addEventListener('online', syncConnection);
  window.addEventListener('offline', syncConnection);
  watchLayout();
  watchBottomEdge();

  // Installation can become impossible when the app is already installed.
  window.matchMedia?.('(display-mode: standalone)')
    .addEventListener?.('change', (event) => { if (event.matches) dismissInstall(); });

  offerIosInstall();
  honourShortcut();

  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    wireUpdates(registration);
  } catch {
    // No worker (insecure context, private mode, blocked storage): the app
    // still works, it just cannot be installed or opened offline.
  }
}

init();
