// Lock-screen / Now Playing integration.
//
// Everything here encodes a rule iOS enforces *silently*: when one of them is
// wrong the lock screen still shows the controls, it just loses the artwork or
// the seek bar and gives no error anywhere. That is why this lives in its own
// module with tests instead of inline in app.js.
//
// 1. Artwork must be an absolute, same-origin (or CORS-enabled) URL. A
//    cross-origin i.ytimg.com URL renders nothing on the iOS lock screen, and
//    WebKit has historically ignored relative artwork srcs too.
// 2. `sizes` must describe the real bitmap. iOS drops artwork whose declared
//    size is a lie; /api/img/<videoId> serves mqdefault.jpg (320×180, 16:9).
// 3. No seek bar without setPositionState(). The lock screen shows
//    title/artist/artwork but no scrubber until position state exists, and a
//    scrubber is dead weight without a `seekto` handler.

const ART_CDN = /(?:i\.ytimg\.com|img\.youtube\.com)\/vi\/([A-Za-z0-9_-]{11})\//;
const PROXY_HOST = /^https:\/\/(?:yt3\.ggpht\.com|lh3\.googleusercontent\.com|i\.ytimg\.com|img\.youtube\.com)\//;

/**
 * What GET /api/img/<videoId> returns: YouTube's mqdefault.jpg.
 * 16:9 on purpose — hqdefault is a 4:3 canvas with black bars baked in around
 * a 16:9 frame, which turned into a black band in every square crop.
 */
export const ART_SIZE = '320x180';

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
  const raw = String(art);
  const m = ART_CDN.exec(raw);
  let src = raw;
  if (m) src = `/api/img/${m[1]}${opts.hi ? '?hi=1' : ''}`;
  else if (PROXY_HOST.test(raw)) src = `/api/img?u=${encodeURIComponent(raw)}`;
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
  return ART_CDN.test(String(art))
    ? [{ src, sizes: ART_SIZE, type: 'image/jpeg' }]
    : [{ src, type: 'image/jpeg' }];
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
} = {}) {
  const ms = mediaSession;
  let lastPos = -1;
  let lastDur = -1;
  let lastWarm = null;

  /**
   * Publish duration/position so the lock screen can draw a draggable bar.
   * Returns whether anything was reported.
   */
  function position(force = false) {
    if (!ms?.setPositionState) return false;
    const duration = Number(audio.duration);
    // Live/unknown duration: iOS rejects the call, so do not make it.
    if (!Number.isFinite(duration) || duration <= 0) return false;
    // setPositionState throws a RangeError when position > duration; a seek can
    // race a source swap, so clamp instead of losing the whole update.
    const pos = Math.min(Math.max(Number(audio.currentTime) || 0, 0), duration);
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
    }
    ms.playbackState = audio.paused ? 'paused' : 'playing';
    position(force);
  }

  /**
   * (Re)register action handlers. Idempotent on purpose: iOS drops them across
   * audio-session interruptions, so app.js calls this on every `playing`.
   */
  function installHandlers() {
    if (!ms?.setActionHandler) return false;
    for (const name of ['play', 'pause', 'previoustrack', 'nexttrack']) {
      const fn = handlers[name];
      if (fn) ms.setActionHandler(name, () => fn());
    }
    // Without this the lock-screen scrubber slides but the audio never moves.
    ms.setActionHandler('seekto', (details) => {
      const to = Number(details?.seekTime);
      if (!Number.isFinite(to) || to < 0) return;
      hooks.onSeekStart?.(to);
      if (details.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(to);
      else audio.currentTime = to;
      position(true);
      hooks.onSeekEnd?.(Number(audio.currentTime) || 0);
    });
    // iOS otherwise substitutes ±10s buttons and hides previous/next.
    ms.setActionHandler('seekbackward', null);
    ms.setActionHandler('seekforward', null);
    return true;
  }

  return { sync, position, installHandlers };
}
