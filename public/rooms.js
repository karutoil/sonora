// Listen Together — the client side of a shared playhead.
//
// The server owns the playhead (see src/rooms.js and docs/rooms.md). This module
// does three jobs:
//
//   1. Keep the clock honest. It estimates the server offset with round-trip
//      corrected probes, never from the one-way timestamps in the event stream
//      (a one-way delay would bias the offset forward by the whole delay).
//   2. Follow the playhead. Every second it compares local audio time with the
//      position the room says is current and either nudges the playback rate
//      (small drift) or hard-seeks (large drift). Nudging is what keeps a room
//      from sounding like a stutter.
//   3. Carry intent. Local transport actions become commands; the returned
//      snapshot is applied immediately. A revision conflict (`STALE`) means
//      someone else moved the room first, so this client simply follows.
//
// It never publishes a position. A client that negotiated would make "C" mean
// something different on every phone.

const POLL_MS = 3000;
// The polling fallback's cadence. A healthy link is polled every 3 s — with the
// stream gone, that is what keeps a room from falling seconds behind everyone
// else. A *failing* one backs off instead: the old fixed 3 s loop spent ~1,200
// full-snapshot requests an hour on a connection that was already struggling.
const POLL_STEPS_MS = [POLL_MS, 10_000, 30_000];
// How long the stream may deliver nothing before it is presumed dead. The
// server ticks every 15 s (src/rooms.js TICK_MS) and writes a `: ping` comment
// with each one, so this is three missed liveness signals.
const STREAM_SILENCE_MS = 45_000;
// A poll request that has not answered in this long is presumed hung and may be
// overtaken (see pollTick): `api` has no timeout of its own.
const POLL_STALL_MS = 60_000;
const CORRECT_MS = 1000;
const HARD_SEEK_S = 1.25;
const NUDGE_S = 0.12;
const MAX_RATE_DELTA = 0.04;
const SETTLE_MS = 1200;
const CALIBRATE_EVERY_MS = 60_000;

const parseEvent = (event) => {
  try { return JSON.parse(event.data); } catch { return null; }
};

/** A track's length in ms, or null when the catalogue never said. */
const trackDurationMs = (track) => (track?.durationS > 0 ? track.durationS * 1000 : null);
/**
 * When the catalogue gave no duration, both ends of a room still have to agree
 * on when the track is over.
 *
 * src/rooms.js derives "ended" for such a track at this same ceiling, so this is
 * not a guess at its length — it is the point after which waiting longer cannot
 * be right. Without it the auto-next suppression below had no end condition at
 * all (the server would never agree), so it stayed suppressed forever and a
 * host-controlled room whose host had gone to sleep never left that track.
 */
const UNKNOWN_DURATION_CEILING_MS = 15 * 60_000;

export function createRoomSync({ api, audio, hooks = {}, basePath = '/api/rooms' }) {
  let room = null;
  let members = [];
  let guests = 0;
  let listeners = 0;
  let status = 'idle';
  let error = null;
  let offsetMs = 0;
  let lastCalibrated = 0;
  let source = null;
  let poller = null;
  let corrector = null;
  let calibrator = null;
  let retryTimer = null;
  let failures = 0;
  // When the stream last delivered *anything* (a frame or a tick). `es.onerror`
  // is not a liveness signal: a connection that dies without a FIN/RST fires
  // nothing at all, so silence is the only detector there is (see watchStream).
  let lastFrameAt = 0;
  // Poller bookkeeping: consecutive failures drive the backoff, `pollBusy` keeps
  // one /state in flight at a time, and `pollGeneration` is bumped whenever the
  // room goes away so a late answer cannot apply to a room this page has left.
  let pollMisses = 0;
  let pollBusy = false;
  let pollStartedAt = 0;
  let pollDueAt = 0;
  let pollGeneration = 0;
  let settleUntil = 0;
  let holdUntil = 0;
  let driftMs = 0;
  let destroyed = false;
  // The revision (and queue index) at which the server last refused a
  // `next {auto:true}` because the track had not really ended. See `command`.
  let autoNextRefused = null;
  // One guest re-mint per page: the cookie expires (and a browser can lose it),
  // and the only thing between that and a dead page used to be "open the link
  // again". A second refusal is terminal, so this cannot become a retry loop.
  let remintTried = false;
  let remintInFlight = false;

  const setStatus = (next, why = null) => {
    if (status === next && error === why) return;
    status = next;
    error = why;
    hooks.onStatus?.({ status, error });
  };

  /** Server time, as this client understands it. */
  const serverNow = () => Date.now() + offsetMs;

  /** Where the room's playhead is right now, in milliseconds. */
  function positionOf(snapshot = room) {
    if (!snapshot) return 0;
    const elapsed = snapshot.playing && !snapshot.ended
      ? Math.max(0, serverNow() - snapshot.at)
      : 0;
    const raw = Math.max(0, (snapshot.positionMs ?? 0) + elapsed);
    // The end is derivable here too, and it is a hard ceiling: a playhead that
    // keeps walking past the last sample of the file is what made an ended,
    // un-advanced room seek to 202 s forever. Clamping is the client's own
    // arithmetic, not a guess about the server.
    const dur = trackDurationMs(snapshot.track);
    return dur != null ? Math.min(raw, dur) : raw;
  }

  // ── applying state ────────────────────────────────────────────────────

  /**
   * Adopt a snapshot.
   *
   * Revisions only move forward, so an older snapshot that lost a race must not
   * overwrite a newer one — whichever path it arrived by. That guard used to
   * live only in the SSE handler, so a command response or a poll that lost to
   * a concurrent state frame could drag the whole room back a track (and make
   * the player reload the previous song). `allowStale` is for snapshots that
   * are asked-for by construction: the first one of a room this page is
   * opening, joining or creating.
   */
  function apply(snapshot, { reason = 'state', allowStale = false } = {}) {
    if (!snapshot?.code) return false;
    if (!allowStale && room && snapshot.code === room.code
      && Number.isFinite(room.rev) && Number.isFinite(snapshot.rev)
      && snapshot.rev < room.rev) {
      return false;
    }
    room = snapshot;
    if (Number.isFinite(snapshot.guests)) guests = snapshot.guests;
    if (Number.isFinite(snapshot.listeners)) listeners = snapshot.listeners;
    if (Array.isArray(snapshot.members)) {
      members = snapshot.members;
      hooks.onMembers?.(members, guests, listeners);
    }
    hooks.onSnapshot?.(snapshot);

    const localId = hooks.currentTrackId?.() ?? null;
    if (snapshot.track && snapshot.track.videoId !== localId) {
      // The track changed for everyone. Hand the whole snapshot to the player,
      // with the position resolved for *now* so a slow load is not a permanent
      // offset; the correction loop takes over once the source is ready.
      settleUntil = Date.now() + SETTLE_MS;
      driftMs = 0;
      hooks.onDrift?.(0);
      hooks.loadTrack?.({ ...snapshot, positionMs: positionOf(snapshot), reason });
      return true;
    }
    // Same track: this is a transport change (play, pause, seek). Apply it now,
    // not up to a second later, so "pause here" means this frame on every
    // device. The loop's own guards still apply.
    correct();
    return true;
  }

  function setMembers(list, guestCount, listenersCount) {
    if (Array.isArray(list)) members = list;
    if (Number.isFinite(guestCount)) guests = guestCount;
    if (Number.isFinite(listenersCount)) listeners = listenersCount;
    hooks.onMembers?.(members, guests, listeners);
  }

  // ── drift correction ──────────────────────────────────────────────────

  function correct() {
    if (!room?.joined || !room.track) return;
    const now = Date.now();
    if (now < settleUntil || now < holdUntil) return;
    if (!hooks.isLoaded?.(room.track.videoId)) return;

    const target = positionOf(room) / 1000;
    const local = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const drift = local - target; // positive = this device is ahead
    const nextDrift = Math.round(drift * 1000);
    if (Math.abs(nextDrift - driftMs) >= 50) {
      driftMs = nextDrift;
      hooks.onDrift?.(driftMs);
    }

    const dur = trackDurationMs(room.track);
    // A track that has reached its end is over, whether or not anyone has
    // advanced the room yet. Without this the paused branch below would call
    // play() on an element sitting at its end (which restarts it from 0:00) and
    // the next tick would hard-seek it back to the end — a visible stutter about
    // once a second in a room whose host never pressed next.
    const atEnd = dur != null && positionOf(room) >= dur;
    if (!room.playing || atEnd) {
      if (audio.playbackRate !== 1) hooks.setRate?.(1);
      if (!audio.paused) hooks.pause?.();
      // A pause is also a position. Without this a guest keeps whatever frame it
      // was on when the host stopped (a second or two off) and stays there until
      // the next play, which is exactly the drift a paused room should not have.
      if (Math.abs(drift) > 0.25) {
        hooks.seek?.(target);
        driftMs = 0;
        hooks.onDrift?.(0);
      }
      return;
    }
    if (audio.paused) { hooks.play?.(); return; }

    if (Math.abs(drift) > HARD_SEEK_S) {
      hooks.seek?.(target);
      driftMs = 0;
      hooks.onDrift?.(0);
      return;
    }
    if (Math.abs(drift) > NUDGE_S) {
      // Ahead → slow down; behind → speed up. Capped at 4 %, inaudible.
      const delta = Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, drift / 8));
      hooks.setRate?.(1 - delta);
    } else if (audio.playbackRate !== 1) {
      hooks.setRate?.(1);
    }
  }

  // ── clock ─────────────────────────────────────────────────────────────

  /**
   * Three probes, keep the one with the smallest round trip. The error in an
   * offset estimate is bounded by half that trip, so the fastest sample is the
   * best one — and it is cheap enough to repeat every minute.
   */
  async function calibrate() {
    if (!room || destroyed) return offsetMs;
    if (Date.now() - lastCalibrated < CALIBRATE_EVERY_MS && lastCalibrated) return offsetMs;
    const samples = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const t0 = Date.now();
        const reply = await api(`${basePath}/${encodeURIComponent(room.code)}/time`);
        const t1 = Date.now();
        if (Number.isFinite(reply?.now)) {
          samples.push({ rtt: t1 - t0, offset: reply.now - (t0 + t1) / 2 });
        }
      }
    } catch {
      // A failed probe keeps the previous offset; the room is still usable.
    }
    if (samples.length) {
      samples.sort((a, b) => a.rtt - b.rtt);
      // Smooth a little: a single fast sample can still be lucky.
      offsetMs = Math.round(offsetMs * 0.25 + samples[0].offset * 0.75);
      lastCalibrated = Date.now();
    }
    return offsetMs;
  }

  // ── transport ─────────────────────────────────────────────────────────

  function stopPolling() {
    clearInterval(poller);
    poller = null;
    clearInterval(retryTimer);
    retryTimer = null;
  }

  function closeStream() {
    if (source) { try { source.close(); } catch {} source = null; }
    stopPolling();
    // The room is over (or another one is about to be loaded): a /state answer
    // still in flight now describes a room this page is no longer in, and
    // applying it would hand `room` back to the engine after leave() nulled it.
    pollGeneration += 1;
    pollMisses = 0;
    pollDueAt = 0;
    lastFrameAt = 0;
  }

  function stopLoops() {
    clearInterval(corrector);
    corrector = null;
    clearInterval(calibrator);
    calibrator = null;
  }

  function startLoops() {
    // One interval, two jobs: the drift fix every second, and the stream's own
    // liveness watchdog. `correct` returns early for a room with no track and a
    // page that is settling or held, and the watchdog must still run there — a
    // room parked on a dead stream is exactly the one nobody notices.
    if (!corrector) corrector = setInterval(() => { watchStream(); correct(); }, CORRECT_MS);
    if (!calibrator) {
      calibrator = setInterval(() => {
        if (document.visibilityState === 'visible') calibrate();
      }, CALIBRATE_EVERY_MS);
    }
    correct();
  }

  /**
   * Is the stream still alive?
   *
   * Presence *is* the SSE connection, and `es.onerror` is the only thing a
   * browser reports about one. A connection that stops delivering without a
   * FIN/RST — a mobile-network switch, a carrier NAT timeout, a stalled proxy —
   * fires no error at all, so the page would sit on `status === 'live'` with an
   * empty failure count, extrapolating the playhead from a frozen snapshot: it
   * keeps drifting away from everyone while the sync badge (measured against
   * that same extrapolation) goes on saying "Synced". The server ticks every
   * 15 s with a `: ping` alongside it, so silence is the signal that was
   * missing: 45 s of it, in a visible tab, is a dead stream.
   */
  function watchStream() {
    if (destroyed || !source) return;
    // A hidden tab's timers are throttled (sometimes to once a minute), so
    // silence there proves nothing — and demoting to polling would spend the
    // radio on a page nobody is looking at. app.js re-reads the room with
    // syncNow() when the tab comes back, and this check runs again from there.
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastFrameAt < STREAM_SILENCE_MS) return;
    const es = source;
    // Clear `source` first: every handler is scoped to *this* stream, and a
    // close() must not be mistaken for the stream we are about to open.
    source = null;
    try { es.close(); } catch {}
    // A network-shaped failure, not a capacity answer: the poller's own 30 s
    // retry is allowed to try the door again (see startPolling).
    startPolling();
    // startPolling() returns early when a poller is already running — a stream
    // retry that opened and then went silent — and the badge would stay on the
    // 'live' that dead stream's onopen set.
    if (poller && status === 'live') setStatus('polling');
  }

  function pollStepMs() {
    return POLL_STEPS_MS[Math.min(pollMisses, POLL_STEPS_MS.length - 1)];
  }

  /**
   * One full-snapshot read over HTTP: the whole of the polling fallback.
   *
   * No AbortController: `api` is app.js's helper, and it rewrites *every* fetch
   * rejection — an abort included — into the "You are offline. Reconnect and try
   * again." toast (app.js:394-396), so cancelling a poll would show a false
   * error over a room that is fine. The two guards below buy what the abort was
   * for instead: `pollBusy` means two requests never overlap (so a slow link
   * cannot deliver them out of order), and `pollGeneration` — bumped by
   * closeStream — means an answer for a room this page has left is dropped
   * rather than applied.
   */
  async function fetchState() {
    if (!room || destroyed) return null;
    if (pollBusy) return null;
    pollBusy = true;
    pollStartedAt = Date.now();
    const generation = pollGeneration;
    const { code } = room;
    try {
      const snapshot = await api(`${basePath}/${encodeURIComponent(code)}/state`);
      if (generation !== pollGeneration || room?.code !== code) return null;
      pollMisses = 0;
      pollDueAt = Date.now() + pollStepMs();
      // `apply` owns the revision ordering, and it is the only thing that may
      // touch the roster: calling setMembers() from the same payload ran even
      // when apply() had refused a stale snapshot, so an old poll landing after
      // a newer command answer rewrote members/guests/listeners from the past
      // (a departed listener back online, "N listening" jumping backwards) and
      // fired hooks.onMembers a second time for every accepted frame.
      const applied = apply(snapshot);
      // A successful read is evidence the room is being followed after all: the
      // badge must not stay on "Connection problem" because one read failed,
      // when the poller's whole job is to prove otherwise. Only an `error` is
      // corrected — 'connecting' (a stream retry in flight) and the terminal
      // 'ended'/'private' are not ours to overwrite.
      if (status === 'error') setStatus(poller ? 'polling' : 'live');
      return applied ? snapshot : null;
    } catch (err) {
      if (generation !== pollGeneration) return null;
      pollMisses = Math.min(pollMisses + 1, POLL_STEPS_MS.length - 1);
      pollDueAt = Date.now() + pollStepMs();
      return handleError(err, { silent: true });
    } finally {
      pollBusy = false;
    }
  }

  /** The interval's own tick: when to poll, and when not to poll at all. */
  function pollTick() {
    if (destroyed || !room) return;
    // A phone in a pocket is not a room someone is listening to. `syncNow`
    // catches the tab up the moment it is visible again.
    if (document.visibilityState !== 'visible') return;
    // `api` has no timeout, so one hung socket would otherwise stop the fallback
    // for good: after a minute, let a second request through. Two answers can
    // then race, and `apply`'s revision guard decides between them.
    if (pollBusy && Date.now() - pollStartedAt < POLL_STALL_MS) return;
    if (Date.now() < pollDueAt) return;
    void fetchState();
  }

  /**
   * Follow the room over HTTP instead of the stream.
   *
   * `retryToStream` decides whether the 30 s timer that re-opens the stream is
   * armed. A network-shaped failure deserves it — a proxy hiccup must not demote
   * a room to polling for the rest of the session. A *capacity* answer must not:
   * the room is full, so the server accepts the connection, writes
   * `room {error}` and ends it (src/rooms.js). Each cycle then came back as
   * onopen → 'live' → stopPolling → the error frame → another toast, i.e. an
   * error toast every 30 seconds forever, a badge flickering between "Live" and
   * "Live · polling", in the one situation (a 200-listener room) where the user
   * is already frustrated. The poller keeps the room followed; a rejoin or a
   * reload tries the stream again.
   */
  function startPolling({ retryToStream = true } = {}) {
    if (poller) return;
    setStatus('polling');
    // A fresh polling session starts on the healthy cadence: the miss count from
    // a previous demotion (before the stream recovered and died again) is not
    // this session's.
    pollMisses = 0;
    pollDueAt = 0;
    fetchState();
    poller = setInterval(pollTick, POLL_MS);
    if (!retryToStream) return;
    // Try the push stream again periodically: a proxy hiccup should not demote
    // a room to polling for the rest of the session.
    retryTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || source) return;
      openStream();
    }, 30_000);
  }

  function openStream() {
    if (!room?.joined || destroyed) return;
    // Only the stream is replaced here. A poller that is already running keeps
    // the room live while this attempt is in flight, and is stopped the moment
    // the stream actually opens (see es.onopen). Clearing it here would leave a
    // room that is retrying the stream with no source of state at all, which is
    // exactly the silent-stale-room case: an EventSource can sit in CONNECTING
    // behind a proxy for minutes before it fails.
    if (source) { try { source.close(); } catch {} source = null; }
    // A retry starts with a clean slate: `failures` still holds the count that
    // demoted the previous stream to polling, so without this reset the first
    // hiccup of the new connection would close it again — one strike instead
    // of three — and the stream could never actually re-establish.
    failures = 0;
    if (typeof EventSource === 'undefined') { startPolling(); return; }
    if (!poller) setStatus('connecting');
    let es;
    try {
      es = new EventSource(`${basePath}/${encodeURIComponent(room.code)}/events`);
    } catch {
      startPolling();
      return;
    }
    source = es;
    // The stream exists from here, even before it opens: the watchdog measures
    // silence from this moment, and the server's own snapshot is the first
    // frame, so 45 s with nothing at all means this connection is not working.
    lastFrameAt = Date.now();
    // Every handler is scoped to *this* stream: a late error from one we closed
    // (after leave(), or a room switch) must not resurrect polling or repaint
    // the badge of a room this page is no longer in.
    // Each of them also stamps `lastFrameAt`: any frame — including a tick, and
    // the `: ping` comment the server writes beside it — is proof of life, and
    // it is the only proof a silent half-open connection ever gives.
    es.addEventListener('snapshot', (e) => {
      if (source !== es) return;
      lastFrameAt = Date.now();
      failures = 0;
      const data = parseEvent(e);
      if (data) apply(data, { reason: 'snapshot' });
      setMembers(data?.members);
      setStatus('live');
    });
    es.addEventListener('state', (e) => {
      if (source !== es) return;
      lastFrameAt = Date.now();
      failures = 0;
      // The stream just delivered state, so it is healthy: a badge parked on
      // 'error' by a refused command must not outlive the evidence that the
      // room is, in fact, perfectly live.
      if (status === 'error') setStatus('live');
      const data = parseEvent(e);
      if (!data) return;
      // `apply` owns the revision ordering now (command responses and polls lost
      // the same race this event can lose), so an out-of-order frame is dropped
      // there — including one queued behind a reconnect snapshot.
      apply(data);
    });
    es.addEventListener('members', (e) => {
      if (source !== es) return;
      lastFrameAt = Date.now();
      const data = parseEvent(e);
      setMembers(data?.members, data?.guests, data?.listeners);
    });
    es.addEventListener('room', (e) => {
      if (source !== es) return;
      lastFrameAt = Date.now();
      const data = parseEvent(e);
      if (data?.ended) endLocally('The host ended the room.');
      // A room that turns private revokes its guests: there is no account to
      // remove, so the stream itself is closed (see src/rooms.js).
      else if (data?.removed) endLocally(data.reason ?? 'This room is now private.', 'private');
      // A room at its stream ceiling answers with `{error}` and closes. That is
      // a capacity answer, not a blip: retrying the stream cannot help, and
      // ignoring the frame left the badge on "Reconnecting…" forever while the
      // browser retried a door that is full. Say so, and fall back to polling —
      // the room's state is still readable, so the page keeps following it.
      else if (data?.error) {
        hooks.notify?.(data.error, 'error');
        if (source === es) { try { es.close(); } catch {} source = null; }
        // …and *without* the 30 s stream retry: a full room answers every
        // reconnection with the same refusal, so that timer turned one refusal
        // into an identical error toast every 30 seconds for as long as the page
        // stayed open (onopen → 'live' → close → toast → poll …). The poller
        // keeps the room followed and a rejoin or reload tries the stream again.
        startPolling({ retryToStream: false });
        setStatus('polling', data.error);
      }
    });
    es.addEventListener('tick', () => {
      if (source !== es) return;
      lastFrameAt = Date.now();
      failures = 0;
    });
    es.onopen = () => {
      if (source !== es) return;
      lastFrameAt = Date.now();
      failures = 0;
      setStatus('live');
      // The stream is carrying state again, so the fallback can go.
      stopPolling();
    };
    es.onerror = () => {
      if (source !== es || destroyed) return;
      failures += 1;
      // A stream that is CLOSED will not be retried by the browser (the server
      // answered 403/404/410, not a network blip). Ask once, then fall back.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        source = null;
        startPolling();
        return;
      }
      if (failures >= 3) {
        es.close();
        source = null;
        startPolling();
      }
    };
  }

  // ── errors ────────────────────────────────────────────────────────────

  function endLocally(reason, finalStatus = 'ended') {
    closeStream();
    stopLoops();
    // The shared playhead is gone, so the sound must go with it: a guest left
    // playing in an ended room is just a stale stream nobody can control.
    if (!audio.paused) hooks.pause?.();
    if (room) room = { ...room, ended: true, playing: false, joined: false };
    hooks.onSnapshot?.(room);
    // 'private' is the honest terminal state for a guest whose room closed its
    // door: the page is over either way, but the badge says why.
    setStatus(finalStatus, reason);
    hooks.notify?.(reason, 'info');
  }

  /**
   * Mint a fresh guest cookie and resume.
   *
   * The guest credential is minted with the listener page and expires after six
   * hours, and a browser can simply lose it (a cleared jar, a privacy mode).
   * Without this, the only recovery was "open the link again" — the page itself
   * said so and stopped. One attempt per visit: the mint route is rate limited
   * and a page that is not allowed in must still end, not retry.
   */
  async function remintGuest() {
    if (remintInFlight || !room?.code || destroyed) return false;
    remintInFlight = true;
    setStatus('connecting');
    try {
      const snapshot = await api(`${basePath}/${encodeURIComponent(room.code)}/guest`, { method: 'POST' });
      remintTried = false;
      if (snapshot?.code) apply(snapshot, { allowStale: true, reason: 'remint' });
      setMembers(snapshot?.members, snapshot?.guests, snapshot?.listeners);
      // A poller that is already running is enough to keep following the room
      // (and its 30 s retry re-opens the stream when there is room); a page
      // with no stream and no poller is not following anything, so reopen.
      if (source) openStream();
      else if (poller) setStatus('polling');
      else openStream();
      return true;
    } catch (err) {
      // A refusal here is terminal (private room, dead room): the same error
      // handler decides, and `remintTried` makes the NO_GUEST branch end.
      remintTried = true;
      handleError(err);
      return false;
    } finally {
      remintInFlight = false;
    }
  }

  function handleError(err, { silent = false } = {}) {
    const body = err?.body ?? {};
    const statusCode = err?.status ?? 0;
    // A stale relative command is not a failure: the room moved on, and the
    // snapshot in the error is the truth to follow.
    if (statusCode === 409 && body.state) {
      apply(body.state);
      if (!silent) hooks.notify?.('The room already moved on.', 'info');
      return null;
    }
    if (statusCode === 410) { endLocally('This room has ended.'); return null; }
    if (statusCode === 404) { endLocally('This room no longer exists.'); return null; }
    if (statusCode === 403) {
      // A guest on the polling fallback whose room went private, or whose guest
      // cookie expired, gets one of these on every poll — and no poll can ever
      // succeed again. They are terminal, exactly like a 410: without this the
      // page spins 'Reconnecting…' forever and the poller alone would issue
      // ~1,200 dead requests an hour instead of reaching an honest end state.
      if (body.code === 'PRIVATE') {
        endLocally(body.error ?? err?.message ?? 'This room is now private.', 'private');
        return null;
      }
      if (body.code === 'NO_GUEST') {
        // No guest credential for this room: mint one (once) and carry on. A
        // second refusal means the room is not open to guests any more, which
        // is terminal.
        if (!remintTried) {
          remintTried = true;
          void remintGuest();
          return null;
        }
        endLocally(body.error ?? err?.message ?? 'Open this room to listen.');
        return null;
      }
      if (body.code === 'HOST_ONLY') {
        if (!silent) hooks.notify?.('Only the host controls this room.', 'info');
      } else if (body.code === 'NOT_ENDED') {
        if (!silent) hooks.notify?.('Wait for the track to finish first.', 'info');
      } else if (!silent) {
        hooks.notify?.(err.message, 'info');
      }
      setStatus('error', err.message);
      return null;
    }
    if (!silent) hooks.notify?.(err?.message ?? 'Could not reach the room.', 'error');
    setStatus('error', err?.message ?? 'Could not reach the room.');
    return null;
  }

  // ── public API ────────────────────────────────────────────────────────

  /** Read a room without joining (the page shows a Join button). */
  async function load(code) {
    stopLoops();
    closeStream();
    failures = 0;
    // Corrections the *previous* room armed must not bleed into this one: a
    // hold from a seek-drag in flight when the user left, or the settle window
    // of the old room's last track change, would otherwise delay this room's
    // first fix by up to their whole window after rejoining.
    settleUntil = 0;
    holdUntil = 0;
    autoNextRefused = null;
    remintTried = false;
    setStatus('connecting');
    try {
      const snapshot = await api(`${basePath}/${encodeURIComponent(code)}`);
      room = snapshot;
      setMembers(snapshot.members, snapshot.guests, snapshot.listeners);
      if (snapshot.joined) {
        // Joining is also "start following": the track has to reach the player,
        // not just the page. `apply` does that (and is a no-op if the current
        // track already matches, e.g. just after creating the room).
        apply(snapshot, { reason: 'snapshot', allowStale: true });
        await calibrate();
        openStream();
        startLoops();
        setStatus('live');
      } else {
        hooks.onSnapshot?.(snapshot);
        setStatus('idle');
      }
      return snapshot;
    } catch (err) {
      const body = err?.body ?? {};
      if (err?.status === 403 && body.code === 'PRIVATE') setStatus('private', err.message);
      else if (err?.status === 404 || err?.status === 410) setStatus('ended', err.message);
      else setStatus('error', err?.message ?? 'Could not open the room.');
      room = { code, error: err?.message ?? null, private: body.code === 'PRIVATE' };
      hooks.onSnapshot?.(room);
      return null;
    }
  }

  async function join(code) {
    setStatus('connecting');
    try {
      const snapshot = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST' });
      room = snapshot;
      settleUntil = 0;
      holdUntil = 0;
      autoNextRefused = null;
      setMembers(snapshot.members, snapshot.guests, snapshot.listeners);
      apply(snapshot, { reason: 'join', allowStale: true });
      await calibrate();
      openStream();
      startLoops();
      setStatus('live');
      return snapshot;
    } catch (err) {
      const body = err?.body ?? {};
      if (err?.status === 403 && body.code === 'PRIVATE') setStatus('private', err.message);
      else if (err?.status === 409) setStatus('error', err.message);
      else setStatus('error', err?.message ?? 'Could not join the room.');
      hooks.notify?.(err?.message ?? 'Could not join the room.', 'error');
      return null;
    }
  }

  async function create({ queue, index = 0, positionMs = 0, playing = false, visibility = 'public', control = 'everyone' }) {
    setStatus('connecting');
    const snapshot = await api('/api/rooms', {
      method: 'POST',
      body: { queue, index, positionMs, playing, visibility, control },
    });
    room = snapshot;
    settleUntil = 0;
    holdUntil = 0;
    autoNextRefused = null;
    setMembers(snapshot.members, snapshot.guests, snapshot.listeners);
    apply(snapshot, { reason: 'create', allowStale: true });
    await calibrate();
    openStream();
    startLoops();
    setStatus('live');
    return snapshot;
  }

  async function leave() {
    const code = room?.code;
    closeStream();
    stopLoops();
    room = null;
    members = [];
    guests = 0;
    listeners = 0;
    driftMs = 0;
    settleUntil = 0;
    holdUntil = 0;
    autoNextRefused = null;
    // Tell the UI *first*, and let the goodbye travel on its own.
    //
    // `api` has no timeout, so awaiting the POST here used to freeze the whole
    // teardown on a flaky link: `room` was already nulled, which makes `active`
    // false and turns every transport control into a silent no-op, while the
    // room page kept rendering — the pill still said "N listening", play/pause/
    // next did nothing, and the user's tap on **Leave** looked ignored for as
    // long as the request took to fail. The server's membership row is a
    // bookkeeping detail; this page has left either way.
    hooks.onSnapshot?.(null);
    hooks.onMembers?.([], 0, 0);
    hooks.onDrift?.(0);
    setStatus('idle');
    if (code) {
      // Fire and forget: a guest's presence is the connection (already closed),
      // and a host's row is re-derived on their next request, so a lost POST is
      // not worth blocking a page transition on.
      void api(`/api/rooms/${encodeURIComponent(code)}/leave`, { method: 'POST' }).catch(() => {});
    }
  }

  async function end() {
    if (!room) return null;
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(room.code)}`, { method: 'DELETE' });
      endLocally('Room ended.');
      return result;
    } catch (err) {
      return handleError(err);
    }
  }

  async function update(patch) {
    if (!room) return null;
    try {
      const snapshot = await api(`/api/rooms/${encodeURIComponent(room.code)}`, { method: 'PATCH', body: patch });
      apply(snapshot);
      return snapshot;
    } catch (err) {
      return handleError(err);
    }
  }

  /**
   * Hand the host seat to another member.
   *
   * A `control: 'host'` room is unskippable, unpausable and unendable for
   * everyone but the host, so without this the group had no way out when the
   * host walked away — the room just looped until housekeeping deleted it. Host
   * only, and the server rejects anyone who is not in the room.
   */
  async function setHost(userId) {
    if (!room?.joined) return null;
    try {
      const snapshot = await api(
        `/api/rooms/${encodeURIComponent(room.code)}/host`,
        { method: 'PATCH', body: { userId } },
      );
      // The response is a full snapshot plus the new roster, so it applies
      // exactly like a PATCH: the local policy view flips to the new host
      // without waiting for the next stream frame.
      apply(snapshot);
      return snapshot;
    } catch (err) {
      return handleError(err);
    }
  }

  async function command(type, payload = {}) {
    if (!room?.joined) return null;
    // A refused auto-next must not be retried while the room stands still. The
    // player fires `next {auto:true}` on every loop wrap (~1 Hz); when the
    // server answers NOT_ENDED — a drift-ahead device, or a catalogue entry
    // with no duration, so the derived playhead can never reach "ended" — that
    // disagreement would otherwise repeat once a second forever: a command and
    // a hard seek on every wrap, for as long as the room stays on this track.
    // The refusal is remembered against (rev, index) and further auto-nexts
    // are swallowed until the room itself moves; a person pressing next is
    // never suppressed.
    const isAutoNext = type === 'next' && Boolean(payload.auto);
    let retriedAuto = false;
    if (isAutoNext && autoNextRefused
      && autoNextRefused.rev === room.rev && autoNextRefused.index === room.index) {
      // The refusal is remembered against (rev, index), but not forever: it was
      // about *this* playhead, and a device that was a few milliseconds early
      // becomes right a few milliseconds later. With a known duration the room's
      // own derived position says when that is, so retry once the boundary has
      // actually passed (the server allows a small tolerance too). With no
      // duration the server ends the track at UNKNOWN_DURATION_CEILING_MS
      // (src/rooms.js), so this waits for that same instant instead of staying
      // suppressed until the room moves.
      const dur = trackDurationMs(room.track) ?? UNKNOWN_DURATION_CEILING_MS;
      if (positionOf(room) < dur) return null;
      // A retry that was refused *again* is not repeated every second either:
      // one attempt every few seconds is enough while the clocks disagree.
      if (autoNextRefused.retried && Date.now() - (autoNextRefused.at ?? 0) < 5000) return null;
      autoNextRefused = null;
      retriedAuto = true;
    }
    try {
      const snapshot = await api(`/api/rooms/${encodeURIComponent(room.code)}/command`, {
        method: 'POST',
        body: { type, rev: room.rev, ...payload },
      });
      apply(snapshot);
      return snapshot;
    } catch (err) {
      if (isAutoNext && err?.status === 403 && err?.body?.code === 'NOT_ENDED') {
        autoNextRefused = { rev: room.rev, index: room.index, at: Date.now(), retried: retriedAuto };
      }
      return handleError(err, { silent: Boolean(payload.auto) });
    }
  }

  async function invite(name, userId = null) {
    if (!room) return null;
    return api(`/api/rooms/${encodeURIComponent(room.code)}/invite`, {
      method: 'POST',
      body: userId ? { userId } : { name },
    });
  }

  async function uninvite(userId) {
    if (!room) return null;
    return api(`/api/rooms/${encodeURIComponent(room.code)}/invite/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  async function people(q = '') {
    if (!room) return [];
    const { people: list } = await api(`/api/rooms/${encodeURIComponent(room.code)}/people?q=${encodeURIComponent(q)}`);
    return list ?? [];
  }

  /** Re-read the room after a tab wakes up, and re-estimate the clock. */
  async function syncNow() {
    if (!room?.joined) return;
    await calibrate();
    await fetchState();
    correct();
  }

  /**
   * Make the player hold the room's current track right now.
   *
   * `apply` only loads a track when the snapshot's track differs from the local
   * one, which is right for events but not for "I am about to press play and I
   * want the source already loaded". A guest page calls this from inside the
   * tap: with the real source in the element, play() is an ordinary playback
   * start rather than a fetch racing a gesture.
   */
  function ensureLoaded() {
    if (!room?.track) return false;
    if (hooks.currentTrackId?.() === room.track.videoId) return true;
    hooks.loadTrack?.({ ...room, positionMs: positionOf(room), reason: 'ensure' });
    return true;
  }

  /** Pause corrections while the user drags a seek slider. */
  function hold(ms = 2500) {
    holdUntil = Date.now() + ms;
  }

  function stop() {
    closeStream();
    stopLoops();
  }

  function destroy() {
    destroyed = true;
    stop();
  }

  return {
    get active() { return Boolean(room?.joined && status !== 'ended'); },
    get room() { return room; },
    get members() { return members; },
    get guests() { return guests; },
    // Everyone listening, signed in or not: what a room's own page reports.
    get listeners() { return listeners || (members.filter((m) => m.online).length + guests); },
    get status() { return status; },
    get error() { return error; },
    get driftMs() { return driftMs; },
    get offsetMs() { return offsetMs; },
    get positionMs() { return positionOf(); },
    positionOf,
    load, join, create, leave, end, update, setHost, command, invite, uninvite, people,
    syncNow, hold, stop, destroy, calibrate, ensureLoaded,
    correct,
  };
}
