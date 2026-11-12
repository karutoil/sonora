// sonora — install / update / offline chrome.
//
// Self-initialising ES module. It deliberately shares nothing with app.js
// except the DOM contract that already exists (data-page / data-collection
// buttons and #auth-overlay), so a broken app.js still registers the worker
// and a broken pwa.js leaves a fully usable app. Nothing is exposed globally.
//
// Three jobs, all of them quiet until relevant:
//   1. register /sw.js, offer a one-tap refresh when a new build is waiting,
//      and say "reload to finish updating" when the page has been left behind
//   2. offer installation — Android/desktop banner, iOS "Add to Home Screen" sheet
//   3. narrate the connection: a slim offline pill that recovers by itself

const PRODUCT = 'sonora';
const SNOOZE_KEY = 'sonora.pwa.install-snoozed-until';
const UPDATE_SNOOZE_KEY = 'sonora.pwa.update-snoozed-build';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // two weeks
const UPDATE_CHECK_MS = 15 * 1000;
// A page must be idle for this long, continuously, before an update may reload
// it without asking. iOS emits transient pause/play pairs during the audio
// session resume (~1 s) and during source swaps; five continuous seconds is
// settled idle, not a blip.
const IDLE_ACCEPT_MS = 5 * 1000;
// After boot the app is still restoring its session and may be about to start
// a track; an update reload inside that window is what the device showed as
// the Now Playing widget cycling and the app coming up blank.
const BOOT_GRACE_MS = 20 * 1000;
// A stale page (old code under a new worker) only auto-reloads when it is
// settled-idle for this long; the pill stays for anyone who wants it sooner.
const STABLE_IDLE_MS = 5 * 1000;
const bootAt = Date.now();

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches === true
  || window.navigator.standalone === true;

/** iOS Safari is the one engine with an install flow but no beforeinstallprompt. */
const isIpadOs = () => navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1;
const isIosSafari = () => {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports a desktop "Macintosh" UA, so the token test alone
  // silently drops every iPad; a touch Mac is an iPad.
  return (isIpadOs() || /iP(hone|ad|od)/.test(ua))
    && /Safari/.test(ua)
    && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA)/.test(ua);
};

const snoozed = () => {
  try { return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now(); } catch { return false; }
};

const snooze = () => {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* private mode */ }
};

// A build the listener already declined must not be offered again on every
// cold launch — that turns a useful notice into nagging. The value remembered is
// the worker's *build id*: a hash of the bytes of sw.js, which is what the
// browser itself compares when it decides a worker is new. Keying this on the
// hand-written VERSION (as it used to) was untrue in the one case that is easy
// to hit: edit sw.js without bumping VERSION and the genuinely new worker
// matched the string the user had already declined, so it was taken over
// silently and no prompt was ever shown.
const declinedUpdate = () => {
  try { return localStorage.getItem(UPDATE_SNOOZE_KEY) || ''; } catch { return ''; }
};

// Never store nothing. If the version handshake times out there is no identity to
// remember, and an unremembered "not now" was asked again on the very next
// launch — and the one after that, forever. A sentinel is less precise than the
// truth and far better than nagging; a later, identifiable build still compares
// unequal to it and gets its own offer.
const UNKNOWN_BUILD = 'unknown';

const declineUpdate = (build) => {
  try { localStorage.setItem(UPDATE_SNOOZE_KEY, build || UNKNOWN_BUILD); } catch { /* private mode */ }
};

const forgetDeclinedUpdate = () => {
  try { localStorage.removeItem(UPDATE_SNOOZE_KEY); } catch { /* private mode */ }
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
// enough, because a silent gap is unfixable from the inside while a labelled one
// is not. What it must not do is put the measurement on screen: the user needs
// the one thing they can act on ("reopen it"), and the numbers are for whoever
// is looking at a bug report, so they live in the pill's title and the console.
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

  // One human sentence in the same visual weight as "You're offline"; the
  // measurement — which nobody on a phone can act on — is the title and a debug
  // line, where a bug report can find it.
  const text = "This app can't fill your screen — reopening it usually fixes it.";
  const detail = `Display: ${Math.round(reached)}px of ${window.screen.height}px`
    + ` — ${missing}px short`;
  const existing = pills.get('chin');
  if (existing) {
    existing.querySelector('.pwa-pill-text').textContent = text;
    existing.title = detail;
    return;
  }
  console.debug(`sonora: ${detail}`);
  // No action button: this reports, it does not pretend to fix.
  showPill('chin', { text, title: detail, tone: 'warn' });
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

function showPill(kind, { text, tone, title, actionLabel, onAction, onDismiss, dismissable = true }) {
  removePill(kind);
  const pill = h('div', 'pwa-pill');
  pill.dataset.kind = kind;
  if (tone) pill.dataset.tone = tone;
  // A pill carries one sentence. Anything a user cannot act on (the measured
  // shortfall behind the chin notice, say) belongs here, not in the sentence.
  if (title) pill.title = title;
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

  // Not every pill may be waved away: "Reload to finish updating" reports a page
  // that is running old code and only the reload ends it, so a × there would be
  // a lie the user can click.
  if (dismissable) {
    const dismiss = h('button', 'pwa-pill-dismiss', '\u00d7');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', () => {
      onDismiss?.();
      removePill(kind);
    });
    pill.append(dismiss);
  }

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
// Set when a worker this page never asked for has taken over (see
// wireUpdates): the document is then last build's code under a new worker.
let staleController = false;
// Set when that takeover was a release another tab performed: the pill is
// offered, but reloading is the listener's call, not ours (see releasedElsewhere).
let autoReloadBlocked = false;
// One timer and one set of listeners for the stale reload, however many times a
// takeover arrives. Re-binding on every controllerchange stacked handlers that
// nothing ever removed, and each one armed its own reload.
let staleTimer = 0;
let staleWired = false;

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  clearTimeout(reloadTimer);
  clearTimeout(staleTimer);
  staleTimer = 0;
  // The document is going away. A late controllerchange or pause event must not
  // leave this page believing it is still stale, or a queued reload could fire
  // behind the navigation that is already happening.
  staleController = false;
  location.reload();
}

/**
 * Reload-storm guard.
 *
 * Every automatic update-reload bumps a sessionStorage counter that survives
 * reloads (but not a browser restart). The *first* auto-reload is always
 * allowed; a page that boots while the counter is still hot — meaning an
 * auto-reload fired in the last two minutes and this document is its result —
 * never auto-reloads again. That is what ends a SKIP_WAITING/claim race:
 * without it, a worker that takes a moment to claim its own clients shows a
 * "waiting" worker to the freshly booted page too, which reloads again, and
 * the listener watches the Now Playing widget cycle through boot after boot
 * (measured on the device: three reloads in two seconds at launch, final page
 * blank and paused). The pill still offers the manual tap, and a genuinely
 * idle settled page can auto-accept once the counter cools.
 */
const UPDATE_RELOAD_COOLDOWN_MS = 120_000;
const STORM_KEY = 'sonora-update-reloads';
function markUpdateReload() {
  try {
    sessionStorage.setItem(STORM_KEY, String(Date.now()));
  } catch { /* private mode */ }
}
function bootedFromUpdateReload() {
  try {
    const at = Number(sessionStorage.getItem(STORM_KEY) || 0);
    return at > 0 && Date.now() - at < UPDATE_RELOAD_COOLDOWN_MS;
  } catch { return false; }
}
const stormBooted = bootedFromUpdateReload();

/**
 * Cross-tab release marker.
 *
 * sessionStorage is per tab, so the storm guard above cannot see that a *sibling
 * tab* released the worker. When tab B taps Refresh, SKIP_WAITING activates the
 * worker and claims tab A too; A's controllerchange carries acceptingUpdate ===
 * false, so without this it treated the release as an unexplained staleness and
 * auto-reloaded itself — stopping the music the listener never asked to stop.
 * localStorage is shared, and the timestamp keeps the same cooldown semantics:
 * a takeover within the window belongs to a release this page did not perform,
 * so show the pill and leave the reload to a human tap.
 */
const RELEASE_AT_KEY = 'sonora-update-release-at';
function markUpdateRelease() {
  try {
    localStorage.setItem(RELEASE_AT_KEY, String(Date.now()));
  } catch { /* private mode */ }
}
function releasedElsewhere() {
  try {
    const at = Number(localStorage.getItem(RELEASE_AT_KEY) || 0);
    return at > 0 && Date.now() - at < UPDATE_RELOAD_COOLDOWN_MS;
  } catch { return false; }
}

/** The identity a "not now" is remembered against. Always a truthy string. */
const buildIdentity = ({ build, version }) => build || version || UNKNOWN_BUILD;

function offerUpdate(registration) {
  if (pills.has('update')) return;
  const worker = registration.waiting;
  askWorkerVersion(worker).then((answer) => {
    const build = buildIdentity(answer);
    if (build === declinedUpdate()) {
      // "Not now" for this exact build. Never ask again; release it while the
      // app is backgrounded so the next launch simply is the new version.
      activateWhenHidden(worker);
      return;
    }
    showUpdateOffer(registration, build);
  });
}

function showUpdateOffer(registration, build) {
  if (pills.has('update')) return;
  showPill('update', {
    text: 'New version available',
    actionLabel: 'Refresh',
    onAction: () => acceptUpdate(registration),
    onDismiss: () => {
      declineUpdate(build);
      activateWhenHidden(registration.waiting);
    },
  });
  // Three rounds of device reports arrived tagged with builds the server had
  // replaced hours earlier: the pill was on the phone's screen and nobody
  // tapped it, so every test re-ran the previous round's bug. An installed iOS
  // PWA keeps its old JavaScript until something reloads the page, and nothing
  // did. So an *idle* page now accepts for itself: visible and nothing playing
  // is the moment a reload costs the listener nothing. While music plays the
  // pill stays and this retries on the next pause or foreground return.
  maybeAutoAccept(registration);
}

function acceptUpdate(registration) {
  acceptingUpdate = true;
  markUpdateReload();
  // Tell any sibling tab that this release is ours, so its controllerchange is
  // not mistaken for staleness it must fix by itself.
  markUpdateRelease();
  forgetDeclinedUpdate();
  removePill('update');
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
  // If there was no waiting worker after all (or it vanished), still honour
  // the tap — a plain reload is what the user asked for.
  reloadTimer = setTimeout(reloadOnce, 2500);
}

/** Accept a waiting update without asking, when doing so costs nothing. */
let autoAcceptTimer = 0;
function maybeAutoAccept(registration) {
  if (reloading || acceptingUpdate) return;
  if (!registration.waiting) return;
  if (document.visibilityState !== 'visible') return;
  // Just booted: the app is still restoring its session and may be about to
  // start a track. Reloading now kills the restore — measured on the device as
  // three reloads in two seconds at launch, which the listener experiences as
  // the song starting, the Now Playing widget cycling, and the app coming up
  // blank and paused. Wait out the boot window, then look again once.
  if (Date.now() - bootAt < BOOT_GRACE_MS) {
    clearTimeout(autoAcceptTimer);
    autoAcceptTimer = setTimeout(() => maybeAutoAccept(registration),
      BOOT_GRACE_MS - (Date.now() - bootAt) + 250);
    return;
  }
  // "Nothing playing" must mean *settled* idle, not a momentary pause: iOS
  // emits pause/play pairs during the resume handshake and during every source
  // swap, and accepting inside one of those blips reloads the page under a
  // song that is audibly playing. Require five continuous seconds of pause;
  // any `play` in between cancels the pending acceptance and the next pause
  // starts over.
  const audioEl = document.getElementById('audio');
  if (audioEl && !audioEl.paused) return;
  clearTimeout(autoAcceptTimer);
  autoAcceptTimer = setTimeout(() => {
    autoAcceptTimer = 0;
    const el = document.getElementById('audio');
    if (reloading || acceptingUpdate) return;
    if (!registration.waiting) return;
    if (document.visibilityState !== 'visible') return;
    if (el && !el.paused) return;
    // This page booted *from* an update reload and a waiting worker is still
    // showing (a SKIP_WAITING/claim race): stop the chain here rather than
    // boot-looping. The pill still offers the tap.
    if (stormBooted) return;
    acceptUpdate(registration);
  }, IDLE_ACCEPT_MS);
}

/**
 * Ask a waiting worker which build it is.
 *
 * The answer is `{ version, build }`: the version names the worker's caches and
 * the build is a hash of its own bytes (see sw.js), which is the only identity
 * that changes exactly when the browser considers the worker new. A missing reply
 * is not fatal — it resolves to empty strings and the caller falls back to a
 * sentinel it can still remember.
 */
function askWorkerVersion(worker) {
  return new Promise((resolve) => {
    if (!worker) { resolve({ version: '', build: '' }); return; }
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish(null), 1200);
    function finish(data) {
      clearTimeout(timer);
      const answer = data?.type === 'sonora:version' ? data : null;
      resolve({ version: String(answer?.version || ''), build: String(answer?.build || '') });
    }
    channel.port1.onmessage = (event) => finish(event.data);
    try { worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]); }
    catch { finish(null); }
  });
}

/**
 * Apply a declined update without touching the current page: skipWaiting()
 * changes the controller, not the running code, so a backgrounded tab never
 * reloads mid-track and the next launch is already the new build.
 *
 * Which is exactly why controllerchange no longer goes unmentioned: this page
 * *is* then running old code under a new worker, and offerReload() is what says
 * so (see wireUpdates).
 */
function activateWhenHidden(worker) {
  if (!worker) return;
  const release = () => worker.postMessage({ type: 'SKIP_WAITING' });
  if (document.visibilityState === 'hidden') { release(); return; }
  document.addEventListener('visibilitychange', function onHide() {
    if (document.visibilityState !== 'hidden') return;
    document.removeEventListener('visibilitychange', onHide);
    release();
  });
}

/**
 * "Reload to finish updating".
 *
 * This page is running the previous build's JS and CSS under the new worker: the
 * decline was applied while the app was hidden, so controllerchange happened
 * without a reload, the decline marker was spent and registration.waiting is now
 * null — the update pill could never come back and nothing mentioned that the
 * page was old. An installed iOS app that is resumed instead of relaunched can
 * stay that way for weeks, so say it, and do not offer a way to dismiss it: only
 * the reload ends it.
 *
 * And do not wait for the tap either. Three consecutive device reports arrived
 * tagged with a build the server had replaced hours earlier: the pill was on
 * screen and nobody touched it, while every test re-ran the previous round's
 * bug. So the stale page also reloads itself the first moment that is safe —
 * visible, and nothing playing — which for a phone in a pocket is the next
 * unlock. The pill remains for the case where playback never pauses.
 */
function offerReload() {
  if (!staleController || reloading || pills.has('reload')) return;
  showPill('reload', {
    text: 'Reload to finish updating',
    actionLabel: 'Reload',
    dismissable: false,
    onAction: () => {
      acceptingUpdate = true;
      removePill('reload');
      reloadOnce();
    },
  });
  scheduleStaleReload();
}

/**
 * Reload a provably stale page without asking.
 *
 * "Safe" is not just "paused": iOS emits transient pause/play pairs during the
 * audio-session resume handshake (a `repairAudioSession` round trip takes ~1 s)
 * and during every source swap. Reloading inside one of those blips is what
 * the device showed after an unlock — song starts, page reloads under it, the
 * Now Playing widget cycles with each reload, and the final page comes up
 * blank because a fresh load gets no playback gesture. So require a *settled*
 * pause: continuous for STABLE_IDLE_MS with a real loaded source, and cancel
 * the pending reload on any play. A page with nothing loaded at all (fresh
 * boot, empty player) is idle by definition.
 */
function cancelStaleReload() {
  clearTimeout(staleTimer);
  staleTimer = 0;
}

function checkStaleReload() {
  cancelStaleReload();
  if (!staleController || reloading) return;
  if (document.visibilityState !== 'visible') return;
  const audioEl = document.getElementById('audio');
  if (audioEl && !audioEl.paused) return;
  staleTimer = setTimeout(() => {
    staleTimer = 0;
    if (!staleController || reloading) return;
    if (document.visibilityState !== 'visible') return;
    const el = document.getElementById('audio');
    // Still paused, still visible, still stale — and a track that is loaded
    // and settled-paused is exactly the case the listener may resume at any
    // moment; keep waiting for a genuinely idle page instead. The pill
    // remains on screen for anyone who wants the update now.
    if (el && (!el.paused || (el.currentSrc && el.readyState > 0))) return;
    // Two guards, both about a reload nobody consented to: the per-tab storm
    // (an update-reload already happened in this tab) and a release performed
    // by another tab (this document is stale through no action of its own).
    if (stormBooted || autoReloadBlocked) return;
    acceptingUpdate = true;
    markUpdateReload();
    removePill('reload');
    reloadOnce();
  }, STABLE_IDLE_MS);
}

function scheduleStaleReload() {
  // Bind once. This used to run inside offerReload() on every controllerchange:
  // each takeover added another visibilitychange/pause/play listener and armed
  // another timer, so the reload could be scheduled several times over and none
  // of the handlers were ever removed.
  if (!staleWired) {
    staleWired = true;
    document.addEventListener('visibilitychange', checkStaleReload);
    const audioEl = document.getElementById('audio');
    audioEl?.addEventListener('pause', checkStaleReload);
    audioEl?.addEventListener('play', cancelStaleReload);
    audioEl?.addEventListener('playing', cancelStaleReload);
  }
  checkStaleReload();
}

/** Say it now if the page is on screen, else the first moment it is. */
function offerReloadWhenVisible() {
  if (document.visibilityState === 'visible') { offerReload(); return; }
  document.addEventListener('visibilitychange', function onShow() {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onShow);
    offerReload();
  });
}

function wireUpdates(registration) {
  // Whether this document is already running under a worker. On a first visit
  // there is no controller at all, and the claim that follows the install is not
  // an update: the page *is* the build that was just installed, so saying
  // "reload to finish updating" there would greet a brand-new user with a nag.
  let controlled = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const wasControlled = controlled;
    controlled = true;
    // Whatever was waiting has taken over; the decline marker has done its job.
    forgetDeclinedUpdate();
    if (acceptingUpdate) { reloadOnce(); return; }
    if (!wasControlled) return;
    // Nobody in this page asked for this. It happens when the release was armed
    // while hidden (activateWhenHidden) or when another tab or window released
    // the same worker. Either way the document is now stale, so replace the
    // unanswerable "New version available" with the one instruction that ends it.
    if (releasedElsewhere()) {
      // A sibling tab tapped Refresh: this takeover is that release reaching
      // us, not staleness we should fix on our own. Offer the pill, never pull
      // the page out from under playback.
      autoReloadBlocked = true;
    }
    staleController = true;
    removePill('update');
    offerReloadWhenVisible();
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

  // Look for a new deploy every time the app comes back to the foreground —
  // iOS never re-checks by itself once installed, and a half-hour gate meant a
  // resumed phone could sit on a replaced build for most of a listening
  // session. A conditional GET for sw.js per unlock is cheap; the 15 s throttle
  // only exists for rapid tab switching.
  let lastCheck = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastCheck < UPDATE_CHECK_MS) return;
    lastCheck = now;
    registration.update().then(() => {
      if (registration.waiting) {
        offerUpdate(registration);
      }
    }).catch(() => {});
    // A pause that happens while the page is visible is another idle moment.
    maybeAutoAccept(registration);
  });
  const audioForUpdates = document.getElementById('audio');
  audioForUpdates?.addEventListener('pause', () => maybeAutoAccept(registration));
  // Any play cancels a pending auto-accept: settled idle is the only state in
  // which the page may reload itself.
  audioForUpdates?.addEventListener('play', () => { clearTimeout(autoAcceptTimer); autoAcceptTimer = 0; });
  audioForUpdates?.addEventListener('playing', () => { clearTimeout(autoAcceptTimer); autoAcceptTimer = 0; });
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
    // No "works offline": the shell opens without a network, but nothing plays
    // until sonora can reach YouTube (see docs/pwa-device-audit.md). Say only
    // what installing buys — full screen, one tap — plus the honest shell.
    ? 'Add it to your Home Screen: full screen, one tap away, with an offline app shell.'
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
    text: `Add ${PRODUCT} to your desktop — full screen, with an offline app shell.`,
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
  // Read the kind *before* dismissing: dismissInstall() nulls installKind, so
  // re-offering with `installKind ?? 'chromium'` afterwards always rebuilt a
  // Chromium offer — on iPadOS in landscape that meant a desktop notice whose
  // Install button had no beforeinstallprompt behind it, so it did nothing.
  const kind = installKind ?? 'chromium';
  if (isCard === isDesktop()) {
    dismissInstall();
    offerInstall(kind);
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
  // offsetParent is not the spec's visibility test: it is null for a fixed
  // element itself and, on some engines, for everything inside one — which
  // would drop every control in this sheet, since .pwa-sheet-backdrop is
  // position: fixed. getClientRects() is the safe test: a rendered box exists.
  return [...root.querySelectorAll(selector)].filter((node) => node.getClientRects().length > 0);
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
  sheet.querySelector('.pwa-sheet-done').addEventListener('click', () => {
    // Reading the instructions is an answer: stop asking for two weeks instead
    // of showing the same card on the next launch.
    snooze();
    dismissInstall();
    closeSheet();
  });
  document.addEventListener('keydown', onSheetKeydown, true);

  // Focus moves into the dialog, and back to the trigger on close.
  const close = sheet.querySelector('.pwa-sheet-close');
  setTimeout(() => { if (close.isConnected) close.focus(); }, 0);
}

// ── connection state ────────────────────────────────────────────────────────
// navigator.onLine reports the link, not the origin: behind a tunnel that is
// down the Wi-Fi is still "online" and every request fails. So the pill has two
// triggers — the link events (instant) and the traffic the app already makes
// (honest). No polling: one successful same-origin response clears it.

let onlineTimer = 0;
let reachFailures = 0;
let reachDecay = 0;
let reachabilityPill = false;

function showOffline(text) {
  const existing = pills.get('offline');
  if (existing) {
    const label = existing.querySelector('.pwa-pill-text');
    if (label && label.textContent !== text) label.textContent = text;
    return;
  }
  showPill('offline', { text, tone: 'offline' });
}

function syncConnection() {
  clearTimeout(onlineTimer);
  const existing = pills.get('offline');
  if (navigator.onLine) {
    reachFailures = 0;
    reachabilityPill = false;
    // Only speak if we had something to say.
    if (!existing) return;
    existing.dataset.tone = 'online';
    const label = existing.querySelector('.pwa-pill-text');
    if (label) label.textContent = 'Back online.';
    existing.querySelector('.pwa-pill-action')?.remove();
    onlineTimer = setTimeout(() => removePill('offline'), 2600);
    return;
  }
  showOffline("You're offline — playback needs a connection.");
}

/** The origin answered: whatever the link state, the app is usable again. */
function markReachable() {
  reachFailures = 0;
  clearTimeout(reachDecay);
  if (!reachabilityPill) return;
  reachabilityPill = false;
  syncConnection();
}

/**
 * The origin did not answer. Two consecutive failures, because one aborted
 * cover or one endpoint bug is not "offline"; a decay window means a single
 * failure during normal use never accumulates into a false alarm.
 */
function markUnreachable() {
  if (navigator.onLine === false) { syncConnection(); return; }
  reachFailures += 1;
  clearTimeout(reachDecay);
  reachDecay = setTimeout(() => { reachFailures = 0; }, 20_000);
  if (reachFailures < 2 || reachabilityPill) return;
  reachabilityPill = true;
  showOffline("Can't reach sonora — check your connection.");
}

function watchReachability() {
  // There used to be a pair of custom window listeners here, on the theory that
  // app.js would tell this module when the origin is gone. Nothing ever
  // dispatched them, so the contract was one-sided: it read as "the app reports
  // reachability" while the only real evidence was the traffic below. They are
  // deleted rather than kept as decoration — a listener nobody calls is a
  // promise this module cannot keep — and the two witnesses underneath need no
  // cooperation from any other module.

  // A failed <audio> load is the listener-facing version of "the origin is
  // gone". MEDIA_ERR_NETWORK is the only code that means transport; a decode
  // failure or a 404 is not an offline state.
  document.addEventListener('error', (event) => {
    const media = event.target;
    if (media?.id === 'audio' && media.error?.code === 2) markUnreachable();
  }, true);

  // Observe the traffic the app already makes. PerformanceObserver is passive
  // (no monkey-patching of fetch, which would be a global side effect this
  // module promises not to have), and `responseStatus` has the origin's actual
  // answer — including the service worker's own cached reply.
  if (typeof PerformanceObserver !== 'function'
    || !PerformanceObserver.supportedEntryTypes?.includes('resource')) return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      let url;
      try { url = new URL(entry.name); } catch { continue; }
      if (url.origin !== location.origin) continue;
      const status = entry.responseStatus;
      // WebKit has no `responseStatus` at all: on iOS this loop can never see
      // the origin's answer, and inventing one from a transfer is exactly the
      // optimism this witness exists to avoid. An entry that completed (bytes
      // moved or time spent) is neutral evidence — traffic happened, not what
      // was said about it — so it counts as neither reachable nor unreachable.
      // That leaves the <audio> MEDIA_ERR_NETWORK listener above as the only
      // passive WebKit witness; a same-origin fetch/XHR failure witness would
      // need monkey-patching, which this module promises not to do.
      if (status === undefined) continue;
      // 5xx means the origin or its tunnel did not serve the app. (Network
      // failures report 0 here; the <audio> listener below covers those.)
      if (status >= 500) markUnreachable();
      else if (status >= 200) markReachable();
    }
  });
  try { observer.observe({ type: 'resource', buffered: true }); } catch { /* older engine */ }
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

// What honourShortcut() has already consumed. A shortcut tapped while the app
// is installed and running is a *focus*, not a navigation (launch_handler:
// focus-existing), so the query string is never re-read by a page load; this
// listener is what turns a later ?page= into the same click.
let shortcutSearch = location.search;

function honourShortcut() {
  shortcutSearch = location.search;
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
    // Consume the shortcut *without* dropping the route it just produced.
    // app.js keeps its route in location.hash, so replacing with the pathname
    // alone discarded the `#/search` the click had pushed; boot's own route
    // read then found nothing and landed on Home — a launcher shortcut opened
    // the wrong page. Only the query string belongs to the shortcut.
    try {
      history.replaceState(history.state, '', location.pathname + location.hash);
    } catch { /* a page that refuses history writes still navigated */ }
    shortcutSearch = location.search;
  });
}

/** Re-read a shortcut query a focus-style launch handed to the running page. */
function honourShortcutAgain() {
  if (location.search === shortcutSearch) return;
  honourShortcut();
}

// ── boot ────────────────────────────────────────────────────────────────────

async function init() {
  syncConnection();
  watchReachability();
  window.addEventListener('online', syncConnection);
  window.addEventListener('offline', syncConnection);
  watchLayout();
  watchBottomEdge();

  // Installation can become impossible when the app is already installed.
  window.matchMedia?.('(display-mode: standalone)')
    .addEventListener?.('change', (event) => { if (event.matches) dismissInstall(); });

  offerIosInstall();
  honourShortcut();
  // launch_handler: focus-existing focuses this window instead of navigating
  // it, so a shortcut query may arrive with no page load to read it. Check when
  // the window comes back to the front; a genuine navigation is a new document
  // and runs the line above anyway.
  window.addEventListener('focus', honourShortcutAgain);
  window.addEventListener('pageshow', honourShortcutAgain);

  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    wireUpdates(registration);
    // The shell cache *is* the app. Without a persist grant the browser may
    // evict it under pressure, and the user has no way to fix that from inside.
    // Best-effort: a refusal is normal in private windows and on some engines,
    // so nothing is surfaced. But verify the outcome — the grant can be absent
    // even after a successful-looking call — and leave a line for a bug report.
    navigator.storage?.persist?.().then(async (granted) => {
      const persisted = typeof navigator.storage.persisted === 'function'
        ? await navigator.storage.persisted().catch(() => false)
        : false;
      if (!granted && !persisted) {
        console.debug('sonora: the offline shell is not persistent; the browser may evict it');
      }
    }).catch(() => {});
  } catch {
    // No worker (insecure context, private mode, blocked storage): the app
    // still works, it just cannot be installed or opened offline.
  }
}

init();
