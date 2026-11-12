// Lock-screen / Now Playing integration.
//
// Everything here encodes a rule iOS enforces *silently*: when one of them is
// wrong the lock screen still shows the controls, it just loses the artwork or
// the seek bar and gives no error anywhere. That is why this lives in its own
// module with tests instead of inline in app.js.
//
// 1. Artwork must be an absolute, same-origin (or CORS-enabled) URL. A
//    cross-origin i.ytimg.com URL renders nothing on the iOS lock screen, and
//    WebKit has historically ignored relative artwork srcs too. So every
//    https image is rewritten onto `/api/img` (see artSrc) — the server owns
//    the only host allowlist, and the client cannot drift behind it again.
// 2. `sizes` must describe the real bitmap. iOS drops artwork whose declared
//    size is a lie; /api/img/<videoId> serves mqdefault.jpg (320×180, 16:9).
// 3. No seek bar without setPositionState(). The lock screen shows
//    title/artist/artwork but no scrubber until position state exists, and a
//    scrubber is dead weight without a `seekto` handler.
// 4. Nothing in here may throw into the caller's audio event handler: a
//    rejected MediaMetadata or a platform that refuses `seekto` must cost that
//    one control, not the lock screen (or playback).
// 5. Registering the handlers is not enough; they have to be *re*-registered
//    while the screen is off, or the lock screen swaps previous/next for ±seek
//    buttons. See keepAlive().

const ART_CDN = /(?:i\.ytimg\.com|img\.youtube\.com)\/vi\/([A-Za-z0-9_-]{11})\//;

/**
 * An absolute https image (protocol-relative URLs are normalised to https first).
 *
 * This used to be a duplicated host allowlist (i.ytimg.com, yt3.ggpht.com,
 * lh3.googleusercontent.com, …) which fell behind YouTube's CDN: release covers
 * now come from `yt3.googleusercontent.com`, so they were left as cross-origin
 * URLs — fetched from Google by the browser, and dropped by the iOS lock
 * screen. The server owns the one allowlist (`/api/img?u=` answers 400 for a
 * host it does not trust); the client's job is only to make artwork
 * same-origin, so *every* https image is proxied and an unknown future host
 * degrades to a proxied miss instead of a silently art-less lock screen.
 */
const ABSOLUTE_IMAGE = /^https:\/\//i;

/**
 * What GET /api/img/<videoId> returns: YouTube's mqdefault.jpg.
 * 16:9 on purpose — hqdefault is a 4:3 canvas with black bars baked in around
 * a 16:9 frame, which turned into a black band in every square crop.
 */
export const ART_SIZE = '320x180';

/**
 * Re-registration cadence while the page is hidden.
 *
 * The failure this exists for: a locked iPhone relaunches the GPU process, and
 * WebKit rebuilds the page's remote-command listener empty. An empty set falls
 * back to WebKit's `defaultCommands()`, which lists Play, Pause, seek and
 * SkipForward/SkipBackward but *not* PreviousTrack/NextTrack — so the lock
 * screen shows ±15s arrows instead of the track buttons. Registering a handler
 * is the only thing that puts a command back into that set
 * (MediaSession::setActionHandler → addSupportedCommand), so the fix is to keep
 * re-registering while the screen is off.
 *
 * Nothing in the page can observe the relaunch, so this is a heartbeat rather
 * than an event response. Fast for the first stretch after locking, because
 * that is when the relaunch happens; slow afterwards, because a phone in a
 * pocket can stay locked for hours and 6 setActionHandler calls a second for
 * the whole time is pure waste. Both are cheap: WebKit keeps the commands in a
 * HashSet and coalesces the update into one main-thread task that early-returns
 * when the set is unchanged, so a repeat registration costs no IPC.
 */
const KEEP_ALIVE_FAST_MS = 1_000;
const KEEP_ALIVE_SLOW_MS = 15_000;
/** How long after the page hides the fast cadence applies. */
const KEEP_ALIVE_FAST_WINDOW_MS = 30_000;

/**
 * Absolute, same-origin artwork URL for a track's `thumb` (or any allowlisted
 * CDN image). Returns null when there is no usable artwork.
 *
 * `opts.hi` asks for the full 16:9 source instead of the 4:3 hqdefault canvas
 * (which has black bars baked in). Use it wherever the artwork is large: the
 * now-playing sheet, a collection hero, the lock screen.
 */
export function artSrc(art, base = globalThis.location?.href, opts = {}) {
  if (!art) return null;
  const raw = String(art).trim();
  if (!raw) return null;
  // Only http(s) can be artwork. A `javascript:` or `data:text/html` URL in an
  // <img> or in MediaMetadata is not a picture, it is a payload.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return null;
  // YouTube returns protocol-relative URLs for channel avatars.
  const url = raw.startsWith('//') ? `https:${raw}` : raw;

  const m = ART_CDN.exec(url);
  let src = url;
  if (m) src = `/api/img/${m[1]}${opts.hi ? '?hi=1' : ''}`;
  else if (ABSOLUTE_IMAGE.test(url)) src = `/api/img?u=${encodeURIComponent(url)}`;
  // A relative path is the app's own (/icons/…); an http: URL is passed through
  // because an https page cannot render it anyway and the proxy only speaks TLS.

  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

/** MediaMetadata `artwork` entries for a track's `thumb`. */
export function artwork(art, base) {
  const src = artSrc(art, base);
  if (!src) return [];
  // Only the id-based proxy route has a known bitmap size. For an arbitrary
  // CDN image, omitting `sizes` beats declaring one that is wrong.
  //
  // `type` is omitted on *both* paths for the same reason. The proxy relays the
  // upstream content-type verbatim (src/server.js readImageCandidate accepts
  // jpeg/png/webp/avif/gif and proxyImage sends that exact type back), so a
  // hardcoded `image/jpeg` becomes a lie the moment an upstream answers webp or
  // avif. A MediaMetadata entry whose declared type disagrees with the bytes is
  // dropped silently by iOS, exactly like a wrong `sizes` — and an absent type
  // just lets the fetcher sniff the truth.
  return ART_CDN.test(String(art))
    ? [{ src, sizes: ART_SIZE }]
    : [{ src }];
}

/**
 * Wire an <audio> element to the Media Session API.
 *
 * Injected dependencies (audio, mediaSession, MediaMetadata, …) keep this
 * testable in plain node — the browser globals only supply the defaults.
 */
export function createMediaSession({
  audio,
  mediaSession = globalThis.navigator?.mediaSession ?? null,
  getTrack = () => null,
  base = globalThis.location?.href,
  MediaMetadata = globalThis.MediaMetadata,
  warmArtwork = null,
  handlers = {},
  hooks = {},
  // Injected for tests: whether the page is backgrounded, and the clock.
  isHidden = () => globalThis.document?.visibilityState === 'hidden',
  now = () => Date.now(),
  // What "position" and "duration" mean, for a player that is not playing a
  // track: while the queue stream plays, the element's clock is a position in
  // the whole plan (public/queue-stream.js), and reporting that to the lock
  // screen would draw an hours-long bar over the wrong song. The player injects
  // the track it is actually on.
  clock = {},
} = {}) {
  const clockPosition = () => (clock.position ? clock.position() : Number(audio?.currentTime) || 0);
  const clockDuration = () => (clock.duration ? clock.duration() : Number(audio?.duration));
  const ms = mediaSession;
  let lastPos = -1;
  let lastDur = -1;
  let lastWarm = null;
  let hiddenAt = null;
  let lastKeepAlive = 0;
  let inKeepAlive = false;
  // Set by stopped(). A hard stop is not a pause: the element is paused *and*
  // sourceless, so it reports `paused` and would resurrect the widget the stop
  // just asked the OS to take away. Only audible playback clears the marker.
  let hardStopped = false;

  /**
   * Re-assert the action handlers while the page is hidden.
   *
   * Why a heartbeat and not an event: the thing that empties the command set is
   * a GPU-process relaunch, which locking a phone in a pocket does to a
   * backgrounded tab (public/audio-session.js documents the same relaunch
   * emptying the audio-session category). It happens *after* the `hidden`
   * transition, so no event the page can see marks it. Nothing repopulates the
   * set except a `setActionHandler` call with a real handler, and the player
   * deliberately does not pause on a background handoff (PLAN.md finding #3),
   * so neither `playing` nor `pause` arrives to trigger one — the buttons stay
   * wrong for the rest of the song.
   *
   * Cheap enough to repeat: WebKit keeps the commands in a HashSet, so a
   * re-registration is a no-op add plus a coalesced main-thread task that
   * early-returns when the set is unchanged. It only crosses into MediaRemote
   * when the set actually differs, which is exactly the recovery we want.
   *
   * Driven from `position()`, which the player already calls from `timeupdate`
   * — the one event that keeps firing on a locked iPhone.
   *
   * Deliberately no timer, and deliberately no beat while *paused*: a paused
   * element fires no `timeupdate`, so there is nothing to ride. It does not need
   * one either. The listener's way out of that state is the lock screen's own
   * play button, `PlayCommand` is in WebKit's `defaultCommands()` fallback, so it
   * still works with an empty set — and resuming fires `playing`, which
   * re-registers everything. The paused case therefore heals itself on the next
   * press; a polling timer would only burn battery to fix what the press fixes.
   */
  function keepAlive() {
    // Re-entrant: the `seekto` handler calls position(), which calls this.
    if (inKeepAlive) return false;
    if (!ms?.setActionHandler) return false;
    const at = now();
    if (!isHidden()) {
      // Foregrounded: the page's own listeners own re-registration from here.
      hiddenAt = null;
      lastKeepAlive = 0;
      return false;
    }
    if (hiddenAt === null) { hiddenAt = at; lastKeepAlive = 0; }
    const elapsed = at - hiddenAt;
    const interval = elapsed < KEEP_ALIVE_FAST_WINDOW_MS
      ? KEEP_ALIVE_FAST_MS : KEEP_ALIVE_SLOW_MS;
    if (lastKeepAlive && at - lastKeepAlive < interval) return false;
    lastKeepAlive = at;
    inKeepAlive = true;
    try {
      return installHandlers();
    } finally {
      inKeepAlive = false;
    }
  }

  /**
   * Publish duration/position so the lock screen can draw a draggable bar.
   * Returns whether anything was reported.
   */
  function position(force = false) {
    keepAlive();
    if (!audio || !ms?.setPositionState) return false;
    const duration = Number(clockDuration());
    // Live/unknown duration: iOS rejects the call, so do not make it.
    if (!Number.isFinite(duration) || duration <= 0) return false;
    // setPositionState throws a RangeError when position > duration; a seek can
    // race a source swap, so clamp instead of losing the whole update.
    const pos = Math.min(Math.max(Number(clockPosition()) || 0, 0), duration);
    const playbackRate = Number(audio.playbackRate) || 1;
    // timeupdate fires ~4×/s; iOS needs about one a second, and each call is a
    // hop into the media process while the phone is locked.
    if (!force && lastDur === duration && Math.abs(pos - lastPos) < 1) return false;
    try {
      ms.setPositionState({ duration, playbackRate, position: pos });
      lastPos = pos;
      lastDur = duration;
      return true;
    } catch {
      return false;
    }
  }

  /** Refresh metadata and/or playback state. */
  function sync({ metadata = false, force = false } = {}) {
    if (!ms) return;
    if (metadata && MediaMetadata) {
      // A track object comes from the app's own state and a malformed one must
      // not break the event that called us (playing/loadedmetadata).
      try {
        const t = getTrack();
        if (t) {
          const art = artwork(t.thumb, base);
          ms.metadata = new MediaMetadata({
            title: t.title || t.videoId || 'Unknown',
            artist: t.channel || '',
            album: 'sonora',
            artwork: art,
          });
          // Warm the HTTP cache. iOS fetches artwork lazily, and the moment the
          // screen locks is the worst possible time for a cold fetch.
          if (art[0] && warmArtwork && art[0].src !== lastWarm) {
            lastWarm = art[0].src;
            warmArtwork(art[0].src);
          }
        }
      } catch {
        // Metadata is decoration; playback state is not. Keep going.
      }
    }
    try {
      // A source swap is not a pause. `playIndex` assigns a new `src` on an
      // element the OS still counts as playing, and the pause that assignment
      // queues is not a listener pausing — publishing it flips the lock screen /
      // Android notification to `paused` for the whole cold load (seconds on a
      // phone), which is exactly what makes the media widget look like the app
      // was shut down. Keep saying `playing` while a swap is in flight; the
      // `playing` handler re-publishes the truth when the new source starts, and
      // the `pause` handler does the same for a real pause.
      // Playback that is audibly running again ends a hard stop: the listener
      // pressed play, and the widget has to come back with it.
      if (audio?.paused === false) hardStopped = false;
      const swapping = hooks.isSwitching?.() === true;
      if (!swapping && !hardStopped) ms.playbackState = audio?.paused === false ? 'playing' : 'paused';
    } catch {
      // A browser that rejects a state must not break the caller's event.
    }
    position(force);
  }

  /**
   * Publish `none`: there is no player any more.
   *
   * `sync` reports what the element is doing, and after a hard stop the element
   * is paused with no source — which sync calls `paused`, i.e. a live player
   * sitting on nothing. That is the lie that kept the Now Playing widget on
   * screen after the player gave up on a queue of failing tracks. `none` is the
   * only state that asks the OS to take the widget away, so it gets its own
   * entry point rather than another guess in sync — and it holds until something
   * is audibly playing again (see `hardStopped`), because the `pause` event that
   * follows a stop would otherwise republish `paused` a moment later.
   */
  function stopped() {
    hardStopped = true;
    try {
      if (ms) ms.playbackState = 'none';
    } catch {
      // A browser that rejects a state must not break the caller's event.
    }
  }

  /**
   * (Re)register action handlers. Idempotent on purpose: iOS drops them across
   * audio-session interruptions, so app.js calls this on every `playing`.
   *
   * Each registration is guarded separately: one action a platform does not
   * support (or has removed) must not stop the rest — losing `seekto` is the
   * seek bar, losing everything is a dead lock screen.
   */
  function installHandlers() {
    if (!ms?.setActionHandler) return false;
    const set = (name, fn) => {
      try {
        ms.setActionHandler(name, fn);
        return true;
      } catch {
        return false;
      }
    };
    // `stop` is the OS's own hard stop (a car head unit, a Bluetooth
    // long-press, Android's "stop" on the notification). It is optional: a
    // platform that does not offer it simply keeps play/pause.
    for (const name of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack']) {
      const fn = handlers[name];
      if (fn) set(name, () => fn());
    }
    // Without this the lock-screen scrubber slides but the audio never moves.
    set('seekto', (details) => {
      if (!audio) return;
      const to = Number(details?.seekTime);
      if (!Number.isFinite(to) || to < 0) return;
      hooks.onSeekStart?.(to);
      // A player whose element is not playing the track the bar describes (the
      // queue stream) has to move the seek itself; assigning `currentTime` on
      // the element would jump to a position in a different timeline.
      if (hooks.onSeek?.(to)) { position(true); return; }
      if (details.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(to);
      else audio.currentTime = to;
      position(true);
      hooks.onSeekEnd?.(Number(audio.currentTime) || 0);
    });
    // Nulling these two is what keeps the track arrows on screen. WebKit builds
    // its remote-command set from the registered handlers, and when that set is
    // empty it falls back to `defaultCommands()`, which contains SkipForward and
    // SkipBackward but *not* PreviousTrack/NextTrack — the ±15s buttons the
    // listener sees instead of next/previous. Registering them would put Skip*
    // into the set and win that contest; removing them is what keeps them out.
    set('seekbackward', null);
    set('seekforward', null);
    return true;
  }

  return { sync, position, installHandlers, keepAlive, stopped };
}
