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
const CORRECT_MS = 1000;
const HARD_SEEK_S = 1.25;
const NUDGE_S = 0.12;
const MAX_RATE_DELTA = 0.04;
const SETTLE_MS = 1200;
const CALIBRATE_EVERY_MS = 60_000;

const parseEvent = (event) => {
  try { return JSON.parse(event.data); } catch { return null; }
};

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
  let settleUntil = 0;
  let holdUntil = 0;
  let driftMs = 0;
  let destroyed = false;

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
    return Math.max(0, (snapshot.positionMs ?? 0) + elapsed);
  }

  // ── applying state ────────────────────────────────────────────────────

  function apply(snapshot, { reason = 'state' } = {}) {
    if (!snapshot?.code) return;
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
      return;
    }
    // Same track: this is a transport change (play, pause, seek). Apply it now,
    // not up to a second later, so "pause here" means this frame on every
    // device. The loop's own guards still apply.
    correct();
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

    if (!room.playing) {
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

  function closeStream() {
    if (source) { try { source.close(); } catch {} source = null; }
    clearInterval(poller);
    poller = null;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function stopLoops() {
    clearInterval(corrector);
    corrector = null;
    clearInterval(calibrator);
    calibrator = null;
  }

  function startLoops() {
    if (!corrector) corrector = setInterval(correct, CORRECT_MS);
    if (!calibrator) {
      calibrator = setInterval(() => {
        if (document.visibilityState === 'visible') calibrate();
      }, CALIBRATE_EVERY_MS);
    }
    correct();
  }

  async function fetchState() {
    if (!room || destroyed) return null;
    try {
      const snapshot = await api(`${basePath}/${encodeURIComponent(room.code)}/state`);
      apply(snapshot);
      setMembers(snapshot.members, snapshot.guests, snapshot.listeners);
      return snapshot;
    } catch (err) {
      return handleError(err, { silent: true });
    }
  }

  function startPolling() {
    if (poller) return;
    setStatus('polling');
    fetchState();
    poller = setInterval(fetchState, POLL_MS);
    // Try the push stream again periodically: a proxy hiccup should not demote
    // a room to polling for the rest of the session.
    retryTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || source) return;
      openStream();
    }, 30_000);
  }

  function openStream() {
    if (!room?.joined || destroyed) return;
    closeStream();
    if (typeof EventSource === 'undefined') { startPolling(); return; }
    setStatus('connecting');
    let es;
    try {
      es = new EventSource(`${basePath}/${encodeURIComponent(room.code)}/events`);
    } catch {
      startPolling();
      return;
    }
    source = es;
    es.addEventListener('snapshot', (e) => {
      failures = 0;
      const data = parseEvent(e);
      if (data) apply(data, { reason: 'snapshot' });
      setMembers(data?.members);
      setStatus('live');
    });
    es.addEventListener('state', (e) => {
      failures = 0;
      const data = parseEvent(e);
      if (data) apply(data);
    });
    es.addEventListener('members', (e) => {
      const data = parseEvent(e);
      setMembers(data?.members, data?.guests, data?.listeners);
    });
    es.addEventListener('room', (e) => {
      const data = parseEvent(e);
      if (data?.ended) endLocally('The host ended the room.');
      // A room that turns private revokes its guests: there is no account to
      // remove, so the stream itself is closed (see src/rooms.js).
      else if (data?.removed) endLocally(data.reason ?? 'This room is now private.');
    });
    es.addEventListener('tick', () => { failures = 0; });
    es.onopen = () => { failures = 0; setStatus('live'); };
    es.onerror = () => {
      failures += 1;
      if (destroyed) return;
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

  function endLocally(reason) {
    closeStream();
    stopLoops();
    // The shared playhead is gone, so the sound must go with it: a guest left
    // playing in an ended room is just a stale stream nobody can control.
    if (!audio.paused) hooks.pause?.();
    if (room) room = { ...room, ended: true, playing: false, joined: false };
    hooks.onSnapshot?.(room);
    setStatus('ended', reason);
    hooks.notify?.(reason, 'info');
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
    setStatus('connecting');
    try {
      const snapshot = await api(`${basePath}/${encodeURIComponent(code)}`);
      room = snapshot;
      setMembers(snapshot.members, snapshot.guests, snapshot.listeners);
      if (snapshot.joined) {
        // Joining is also "start following": the track has to reach the player,
        // not just the page. `apply` does that (and is a no-op if the current
        // track already matches, e.g. just after creating the room).
        apply(snapshot, { reason: 'snapshot' });
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
      setMembers(snapshot.members, snapshot.guests, snapshot.listeners);
      apply(snapshot, { reason: 'join' });
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
    setMembers(snapshot.members, snapshot.guests, snapshot.listeners);
    apply(snapshot, { reason: 'create' });
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
    if (code) {
      try { await api(`/api/rooms/${encodeURIComponent(code)}/leave`, { method: 'POST' }); } catch {}
    }
    hooks.onSnapshot?.(null);
    hooks.onMembers?.([], 0, 0);
    hooks.onDrift?.(0);
    setStatus('idle');
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

  async function command(type, payload = {}) {
    if (!room?.joined) return null;
    try {
      const snapshot = await api(`/api/rooms/${encodeURIComponent(room.code)}/command`, {
        method: 'POST',
        body: { type, rev: room.rev, ...payload },
      });
      apply(snapshot);
      return snapshot;
    } catch (err) {
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
    load, join, create, leave, end, update, command, invite, uninvite, people,
    syncNow, hold, stop, destroy, calibrate, ensureLoaded,
    correct,
  };
}
