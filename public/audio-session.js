// The page's iOS audio-session category: the one line that decides whether the
// app can be heard at all, and the reason re-asserting it is not enough.
//
// `navigator.audioSession.type = 'playback'` moves the page off iOS's ambient
// category — which the Ring/Silent switch silences, and which is what a page
// that never asks for anything ends up with — onto the playback category a
// music app uses. Three rules make that harder than the one line suggests, and
// all three fail silently, which is why this lives in its own module with
// tests instead of inline in app.js.
//
// 1. It has to be claimed inside the first user gesture. A category assigned
//    from a timer or an async continuation is ignored, so "set it right before
//    play()" can do nothing at all.
// 2. It has to be re-sent after the page has been backgrounded. WebKit's web
//    process caches the category it last sent (RemoteAudioSession.cpp returns
//    early when the requested value equals the cached one), while the GPU-side
//    session is recreated empty after a GPU-process relaunch — which is what a
//    phone locking in a pocket does to a backgrounded tab. The fresh session
//    has no demand from this page and resolves to ambient.
// 3. Because of that cache, assigning 'playback' again is a NO-OP. The tab goes
//    on rendering audio — the playhead advances, tracks advance, the lock
//    screen keeps updating, `audio.paused` stays false — while the device is
//    silent, and no event fires that a page can observe. That is the "locked
//    phone plays silently until you unlock and press play" failure; see WebKit
//    bug 323104, which also documents the page-side recovery used below.
//
// The recovery is to move the category to a *different* value and back: the
// cached value changes twice, so two SetCategory messages go through and the
// GPU-side session is repopulated. The pair is synchronous on purpose — a
// frozen page (a locked phone is exactly that) may never run a deferred
// callback, and ending the synchronous pair on 'playback' means a page that
// freezes immediately is never left in the muted ambient category.

/** The category a music player wants: ignores the Ring/Silent switch. */
export const PLAYBACK = 'playback';
/** The category a plain page gets: silenced by the Ring/Silent switch. */
export const AMBIENT = 'ambient';

/**
 * Wire the Audio Session API.
 *
 * Injected dependencies keep this testable in plain node — the browser globals
 * only supply the defaults.
 */
export function createAudioSession({
  session = globalThis.navigator?.audioSession ?? null,
  defer = (fn) => setTimeout(fn, 0),
  now = () => Date.now(),
  cooldownMs = 10_000,
} = {}) {
  let lastRepair = -Infinity;

  /**
   * The cheap claim: one assignment, and only when the category is not already
   * right. Safe to call on every play intent — it is what makes the *first*
   * one stick.
   */
  function claim() {
    if (!session) return false;
    try {
      if (session.type === PLAYBACK) return false;
      session.type = PLAYBACK;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The repair: force the category through the audio session again, because a
   * plain re-assertion of the value WebKit already believes is a no-op (rule 3
   * above). Rate-limited: the ambient step briefly lets other audio mix back
   * in, so this is for the moments a session can be lost, not for every event.
   */
  function repair({ force = false } = {}) {
    if (!session) return false;
    const at = now();
    if (!force && at - lastRepair < cooldownMs) return false;
    lastRepair = at;
    try {
      session.type = AMBIENT;
      session.type = PLAYBACK;
      // Belt and braces for the case where the pair was coalesced into one
      // message: a third assignment in a later task cannot be merged with them.
      defer(() => {
        try { session.type = PLAYBACK; } catch { /* the page is going away */ }
      });
      return true;
    } catch {
      return false;
    }
  }

  return {
    claim,
    repair,
    /** False on every browser that does not implement the Audio Session API. */
    get supported() { return Boolean(session); },
  };
}
