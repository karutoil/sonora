// Listen Together — the shared playhead.
//
// One room is one authoritative playhead that several people follow. The design
// decisions that matter, and why:
//
//   * The SERVER owns the playhead. A client never publishes a position, only
//     intent (play, pause, seek, next). If clients negotiated, "C" would mean
//     different things on different phones.
//   * The playhead is stored as `{ positionMs, anchorAt }` — a position and the
//     instant it was true — so any reader derives `positionMs + (now - anchorAt)`
//     without a timer per room. A slow client therefore computes a later
//     position, which is exactly right; no lead compensation needed.
//   * Track end is DERIVED from the duration, never stored, and any member may
//     send `next {auto:true}` when the state really is ended. That is what keeps
//     a room moving when the host's phone is asleep.
//   * Every command carries the `rev` it was based on. Absolute commands rebase
//     on current state; RELATIVE ones (next/prev) require the revision to match,
//     so two people pressing next at once advance once, not twice.
//
// Presence is the open SSE stream, in memory. `room_members` is the durable
// membership and authorization record; a closed tab leaves the member in place
// (they can rejoin without a new invite) and merely shows as offline.
// See docs/rooms.md for the contract.

import crypto from 'node:crypto';
import { config } from './config.js';
import {
  getRoomRow, createRoomRow, touchRoomRow, updateRoomState, updateRoomMeta, endRoomRow,
  deleteRoomRow, parseRoomState, listRoomMembers, getRoomMember, addRoomMember,
  removeRoomMember, countRoomMembers, touchRoomMember, addRoomInvite, removeRoomInvite,
  getRoomInvite, listRoomInvites, searchUsers, listRoomsToPrune, getUser, upsertTrack,
  setRoomHost, setRoomMemberRole,
  transaction,
} from './db.js';

// No i/l/o/0/1: a code gets read aloud and retyped.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_LENGTH = 10;
/** The alphabet above, spelled as a range so a bad code is rejected before a query. */
export const ROOM_CODE = /^[2-9a-hj-km-np-z]{8,12}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** The same window `/api/now` stores; a room queue is not a playlist. */
const MAX_QUEUE = 60;
const MAX_STREAMS_PER_ROOM = 200;
/**
 * How much unwritten data a subscriber may hold before it is dropped.
 *
 * A phone that suspends the tab (or a laptop that sleeps) stops draining its
 * socket, and an SSE writer that keeps writing to it grows the server's memory
 * for as long as the room lives. A megabyte is far more than a few frames of
 * playhead state and far less than a leak.
 */
const MAX_BUFFERED_BYTES = 1 << 20;
const TICK_MS = 15_000;
// Node clamps larger (and non-finite) delays to 1 ms. Sleep in bounded chunks
// instead: the timer re-reads the persisted playhead before arming its successor.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * How close to the derived end an `auto` advance may be and still count as a
 * natural continuation.
 *
 * A device that is a little ahead of the server — the steady state, since the
 * server's clock is the authority and positive drift is normal — reaches the
 * end of its own file up to ~120 ms before the server's derived end. Refusing
 * that one advance used to wedge a room whose host was asleep, so the rule gets
 * a tolerance; it is far too small to be usable as a skip.
 */
const AUTO_END_TOLERANCE_MS = 500;
/**
 * When a track's duration is unknown, this is when the room decides it is over.
 *
 * Fifteen minutes is longer than any song and shorter than a mix or a live set
 * (which `isCompilation()` keeps out of rooms anyway), so treating an
 * unmeasurable track as ended at this point is a ceiling, not a guess at its
 * length. Without it the room could never leave such a track at all. Mirrored
 * in public/rooms.js.
 */
const UNKNOWN_DURATION_CEILING_MS = 15 * 60_000;

export class RoomError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ── state shaping ───────────────────────────────────────────────────────

export function normaliseTrack(t) {
  const videoId = String(t?.videoId ?? '');
  if (!VIDEO_ID.test(videoId)) return null;
  return {
    videoId,
    title: String(t?.title ?? '').slice(0, 300) || videoId,
    channel: String(t?.channel ?? '').slice(0, 200),
    thumb: String(t?.thumb ?? '').slice(0, 500) || null,
    durationS: Number.isFinite(t?.durationS) ? Math.max(0, Math.round(t.durationS)) : null,
  };
}

export function normaliseQueue(list) {
  const seen = new Set();
  const queue = [];
  for (const candidate of Array.isArray(list) ? list : []) {
    const track = normaliseTrack(candidate);
    // Keep the first copy and its position. Duplicate ids make index-based
    // transport ambiguous and used to let create/queue-set bypass queue-add's
    // duplicate rule. De-duplicate before the cap so repeats cannot crowd out
    // distinct tracks later in the submitted queue.
    if (!track || seen.has(track.videoId)) continue;
    seen.add(track.videoId);
    queue.push(track);
    if (queue.length === MAX_QUEUE) break;
  }
  return queue;
}

const durationMs = (track) => {
  const seconds = Number(track?.durationS);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  // Overflow is not a measurable duration. Treat it like an unknown one, with
  // its normal bounded ceiling, rather than producing an infinite timer.
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Where the playhead is at `now`, from stored state.
 *
 * `ended` is computed, not stored: a known duration plus a position past it is
 * the end of a track, and no per-room timer should be responsible for noticing.
 */
export function derivePlayhead(state, now = Date.now()) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  // The index is normalised to an integer, not merely clamped: `Math.min/max`
  // leaves a fractional value fractional, which reads `queue[1.5]` = undefined
  // while the queue is still non-empty — a snapshot with a queue and no track,
  // which no client path can repair without a command.
  const wanted = Number.isFinite(state?.index) ? Math.trunc(state.index) : 0;
  const index = queue.length
    ? Math.min(Math.max(0, wanted), queue.length - 1)
    : 0;
  const track = queue[index] ?? null;
  const dur = durationMs(track);
  const storedPosition = Number(state?.positionMs);
  let positionMs = Number.isFinite(storedPosition) ? Math.max(0, Math.round(storedPosition)) : 0;
  let playing = Boolean(state?.playing);
  // A corrupt persisted position or anchor must fall back independently. In
  // particular, never let NaN reach `limit - positionMs`: Node turns that into
  // the same 1 ms timeout as an overflowing duration.
  const anchorAt = state?.anchorAt == null ? NaN : Number(state.anchorAt);
  if (playing && Number.isFinite(anchorAt)) positionMs += Math.max(0, now - anchorAt);
  let ended = false;
  // A track with no known duration has no derivable end — the catalogue simply
  // did not say, and the client cannot invent one either. Left at that, nothing
  // could ever make such a track "ended": `scheduleEnd` returns early, the
  // `auto` rule in applyCommand refuses every auto-advance, and a host-only room
  // whose host had gone to sleep stayed frozen on that track until housekeeping
  // deleted the room hours later. So it is treated as ended after a ceiling no
  // song reaches. public/rooms.js applies the same ceiling to the auto-next
  // suppression, which is what lets the two sides agree on "this is over".
  if (dur != null && positionMs >= dur) {
    positionMs = dur;
    ended = true;
    playing = false;
  } else if (dur == null && positionMs >= UNKNOWN_DURATION_CEILING_MS) {
    positionMs = UNKNOWN_DURATION_CEILING_MS;
    ended = true;
    playing = false;
  }
  return { queue, index, track, positionMs, playing, ended };
}

const clampPosition = (value, track) => {
  const max = durationMs(track);
  const numeric = Number(value);
  const n = Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
  return max != null ? Math.min(n, max) : n;
};

const nowIso = () => new Date().toISOString();

/**
 * The wire object. `at` is the server instant `positionMs` was true.
 *
 * `includeActor` is off for the public (guest) shape: `updatedBy` carries an
 * account id and display name, and names are not a public-room resource — the
 * guest page never renders it, so it must not be sent either.
 */
export function snapshotFor(row, { userId = null, includeActor = true } = {}) {
  const stored = parseRoomState(row) ?? { queue: [], index: 0, positionMs: 0, playing: false };
  const now = Date.now();
  const ph = derivePlayhead(stored, now);
  const host = getUser(row.hostId);
  const member = userId ? getRoomMember(row.code, userId) : null;
  return {
    code: row.code,
    host: { id: row.hostId, name: host?.name ?? 'Someone' },
    visibility: row.visibility,
    control: row.control,
    joined: Boolean(member),
    rev: row.rev,
    now,
    at: now,
    positionMs: ph.positionMs,
    playing: ph.playing,
    ended: ph.ended,
    index: ph.index,
    queue: ph.queue,
    track: ph.track,
    updatedAt: Date.parse(row.updatedAt) || now,
    ...(includeActor && stored.updatedBy ? { updatedBy: stored.updatedBy } : {}),
    createdAt: Date.parse(row.createdAt) || now,
    // Anonymous listeners in a public room. They have no membership row by
    // design; the open stream is the only trace, which is why this is a count
    // from the hub and not a query.
    guests: guestCount(row.code),
    // Everyone present: signed-in members with an open stream, plus guests.
    listeners: listenerCount(row.code),
    link: `/l/${row.code}`,
  };
}

// ── the live stream hub ─────────────────────────────────────────────────
// Subscribers live here and nowhere else: the database holds who is a member,
// this holds who is connected right now.

const hub = new Map(); // code -> { subs: Set<sub>, ticker }

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function entryFor(code) {
  let entry = hub.get(code);
  if (!entry) {
    entry = { subs: new Set(), ticker: null };
    hub.set(code, entry);
  }
  return entry;
}

function dropSub(code, sub, { notify = true } = {}) {
  const entry = hub.get(code);
  if (!entry || !entry.subs.delete(sub)) return;
  try { sub.res.end(); } catch { /* already gone */ }
  if (notify) publish(code, 'members', presencePayload(code));
  if (!entry.subs.size) {
    clearInterval(entry.ticker);
    clearTimeout(entry.endTimer);
    hub.delete(code);
  }
}

/**
 * Publish the moment a playing room reaches the end of its track.
 *
 * `ended` is derived, not stored, so nothing used to *notify* anyone when the
 * playhead crossed it: clients kept their last `playing: true` snapshot and
 * their target position grew past the duration forever, which made an
 * un-advanced room restart and jump to the end about once a second. The derived
 * end is a known instant, so arm one timer for it (per room, replaced on every
 * state change, unref'd) and broadcast the ended snapshot when it fires.
 */
function scheduleEnd(code) {
  const entry = hub.get(code);
  if (!entry) return;
  clearTimeout(entry.endTimer);
  entry.endTimer = null;
  const row = getRoomRow(code);
  if (!row || row.endedAt) return;
  const ph = derivePlayhead(parseRoomState(row) ?? {}, Date.now());
  if (!ph.playing || ph.ended) return;
  // An unknown duration still gets a timer. derivePlayhead() ends such a track
  // at UNKNOWN_DURATION_CEILING_MS, so this is the instant the room needs a
  // wake-up at — returning here instead (the old behaviour) meant the state
  // frame that announces "ended" was never published and no client was ever
  // told the track was over.
  const limit = durationMs(ph.track) ?? (ph.track ? UNKNOWN_DURATION_CEILING_MS : null);
  if (limit == null || !Number.isFinite(limit)) return;
  const remaining = limit - ph.positionMs;
  // Very long tracks need more than one timeout. At each chunk boundary the
  // callback below re-reads state and calls scheduleEnd again if it is genuinely
  // early, so no accuracy is lost and a corrupt row cannot create a 1 ms loop.
  const wait = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
  const delay = Math.max(1, Math.min(wait + 10, MAX_TIMER_DELAY_MS));
  entry.endTimer = setTimeout(() => {
    entry.endTimer = null;
    if (!hub.has(code)) return;
    const fresh = getRoomRow(code);
    if (!fresh || fresh.endedAt) return;
    const atEnd = derivePlayhead(parseRoomState(fresh) ?? {}, Date.now());
    if (!atEnd.ended) {
      if (!atEnd.playing) return; // paused or advanced in the meantime
      scheduleEnd(code); // the timer fired a hair early
      return;
    }
    publish(code, 'state', snapshotFor(fresh, { userId: null }));
  }, delay);
  entry.endTimer.unref?.();
}

/** How many anonymous listeners are connected right now. */
export function guestCount(code) {
  const entry = hub.get(code);
  if (!entry) return 0;
  let n = 0;
  for (const sub of entry.subs) if (sub.guest) n += 1;
  return n;
}

/** Everyone with an open stream: signed-in members plus guests. */
export function listenerCount(code) {
  const entry = hub.get(code);
  if (!entry) return 0;
  const online = new Set();
  let guests = 0;
  for (const sub of entry.subs) {
    if (sub.guest) guests += 1;
    else online.add(sub.userId);
  }
  return online.size + guests;
}

export function publish(code, event, data, { notifyDrops = true } = {}) {
  const entry = hub.get(code);
  if (!entry?.subs.size) return;
  const payload = frame(event, data);
  // A guest must never receive the roster: account names are not a public-room
  // resource, so the presence event is shaped per subscriber.
  let guestPresence = null;
  let dropped = 0;
  // A `state` frame is a snapshot, and a snapshot is per-viewer: the caller
  // built it for the commander, whose `joined` flag and (for a guest, via
  // publicSnapshotData) roster-free shape are not every subscriber's. Clients
  // treat `state` exactly like the initial snapshot of their own stream, so
  // each subscriber gets the snapshot the same viewer would have fetched —
  // members snapshotFor themselves, guests get the public shape. Memoised per
  // userId so a room of fifty still pays one query set per *viewer*, and only
  // on the (human-frequency) command path, never per tick.
  const row = event === 'state' ? getRoomRow(code) : null;
  const memberFrames = new Map();
  const memberStateFrame = (userId) => {
    if (!memberFrames.has(userId)) {
      memberFrames.set(userId, frame('state', row ? snapshotFor(row, { userId }) : data));
    }
    return memberFrames.get(userId);
  };
  let guestState = null;
  for (const sub of [...entry.subs]) {
    let out = payload;
    if (event === 'state') {
      if (sub.guest) {
        // No 403 gate here (unlike publicSnapshot): a state frame can only
        // follow a room the guest is already in. If the room just went
        // private, the eviction below closes their stream; a snapshot that
        // cannot be built simply is not sent to them.
        if (guestState === null) {
          try { guestState = frame('state', publicSnapshotData(code)); } catch { guestState = false; }
        }
        out = guestState || null;
      } else {
        out = memberStateFrame(sub.userId);
      }
    } else if (sub.guest && event === 'members') {
      guestPresence ??= frame('members', { members: [], guests: data.guests, listeners: data.listeners });
      out = guestPresence;
    }
    // Dropping a subscriber must not re-enter publish once per drop: a sweep
    // that evicts ten stalled sockets would otherwise nest ten deep.
    if (Number(sub.res.writableLength) > MAX_BUFFERED_BYTES) {
      dropSub(code, sub, { notify: false });
      dropped += 1;
      continue;
    }
    if (out) {
      try { sub.res.write(out); } catch { dropSub(code, sub, { notify: false }); dropped += 1; }
    }
  }
  // A terminal room broadcast is followed immediately by bulk teardown. A write
  // failure during that broadcast must not wedge a roster frame after `ended`.
  if (dropped && notifyDrops) publish(code, 'members', presencePayload(code));
}

/**
 * A guest-shaped snapshot without the route layer: the same object
 * `publicSnapshot` returns, minus the 403 gate.
 */
function publicSnapshotData(code) {
  const row = mustGetRoom(code);
  return {
    ...snapshotFor(row, { userId: null, includeActor: false }),
    joined: true,
    guest: true,
    members: [],
    listeners: listenerCount(code),
  };
}

/** Every member, with the ones holding a live stream marked online. */
export function memberRoster(code) {
  const online = new Set([...(hub.get(code)?.subs ?? [])].map((s) => s.userId));
  return listRoomMembers(code).map((m) => ({
    id: m.id, name: m.name, role: m.role, joinedAt: m.joinedAt, online: online.has(m.id),
  }));
}

/** The payload of every `members` event: the roster and the listener tallies. */
function presencePayload(code) {
  return {
    members: memberRoster(code),
    guests: guestCount(code),
    listeners: listenerCount(code),
  };
}

function startTicker(code) {
  const entry = entryFor(code);
  if (entry.ticker) return;
  entry.ticker = setInterval(() => {
    if (!hub.has(code)) return;
    // A tick is liveness and a clock sample for the client's own display of
    // sync health. It is deliberately NOT used to estimate the clock offset:
    // a one-way delay would bias that forward by the whole delay.
    publish(code, 'tick', { now: Date.now() });
    for (const sub of [...(hub.get(code)?.subs ?? [])]) {
      try { sub.res.write(': ping\n\n'); } catch { dropSub(code, sub); }
    }
  }, TICK_MS);
  // A room must never keep the process (or a test) alive on its own.
  entry.ticker.unref?.();
}

/**
 * Attach an SSE consumer. The reply is hijacked by the caller, so this writes
 * to the raw response and never returns.
 *
 * `identity` is a signed-in user or a public-room guest (`{ id, name, guest }`).
 * A guest is in the hub but never in `room_members`: there is no account to
 * remember, and presence is the connection itself.
 */
export function openStream(code, identity, res) {
  // The capacity check runs before `entryFor`: creating the entry first left an
  // empty `{subs:0, ticker:null}` map entry behind on every refused connection
  // (only dropSub ever deletes an empty entry), a slow leak in exactly the
  // situation — 200 streams — where the process is already at its ceiling.
  if ((hub.get(code)?.subs.size ?? 0) >= MAX_STREAMS_PER_ROOM) {
    res.write(frame('room', { ended: false, error: 'This room has too many listeners.' }));
    res.end();
    return null;
  }
  const entry = entryFor(code);
  if (entry.subs.size >= MAX_STREAMS_PER_ROOM) {
    res.write(frame('room', { ended: false, error: 'This room has too many listeners.' }));
    res.end();
    return null;
  }
  const sub = { userId: identity.id, name: identity.name, guest: Boolean(identity.guest), res };
  entry.subs.add(sub);
  res.on('close', () => dropSub(code, sub));
  res.on('error', () => dropSub(code, sub));
  startTicker(code);
  touchRoomRow(code);
  if (!identity.guest) touchRoomMember(code, identity.id);
  // The stream always opens with a full snapshot, so a reconnect after any
  // amount of downtime is one message, not a replay protocol.
  let snapshot;
  if (identity.guest) {
    try {
      // Not `snapshotFor` + an empty roster: a guest snapshot has its own shape
      // (no names, a listener count) and must not drift from it.
      snapshot = publicSnapshot(code);
    } catch (err) {
      res.write(frame('room', { ended: true, error: err.message }));
      res.end();
      return null;
    }
  } else {
    snapshot = {
      ...snapshotFor(getRoomRow(code), { userId: identity.id }),
      // The subscriber was added above. Recompute here rather than reusing the
      // route's pre-open roster, whose online flags necessarily predate it.
      members: memberRoster(code),
      listeners: listenerCount(code),
    };
  }
  res.write(frame('snapshot', snapshot));
  // A room that is already playing has a known end; make sure the boundary is
  // broadcast even if the only people present are watching, not commanding.
  scheduleEnd(code);
  publish(code, 'members', presencePayload(code));
  return sub;
}

export function liveCodes() {
  return new Set([...hub.entries()].filter(([, e]) => e.subs.size).map(([code]) => code));
}

/**
 * What a signed-in visitor may see of a room. A public room is readable before
 * joining (the page then offers Join); a private one is a wall with a reason.
 * The track is never part of a private room's leak — `snapshotFor` includes it,
 * so this gate runs before the snapshot is built into the reply.
 */
export function viewRoom(code, user) {
  const row = assertOpen(mustGetRoom(code));
  const member = getRoomMember(code, user.id);
  const invited = getRoomInvite(code, user.id);
  if (row.visibility === 'private' && row.hostId !== user.id && !member && !invited) {
    throw new RoomError(403, 'PRIVATE', 'This room is private. Ask the host to invite you.');
  }
  return {
    ...snapshotFor(row, { userId: user.id }),
    members: memberRoster(code),
    invited: Boolean(invited),
    ...(row.hostId === user.id ? { invites: listRoomInvites(code) } : {}),
  };
}

// ── lifecycle ───────────────────────────────────────────────────────────

function makeCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** 404, or the row. Every route funnels through here. */
export function mustGetRoom(code) {
  if (!ROOM_CODE.test(String(code ?? ''))) throw new RoomError(404, 'NO_ROOM', 'No such room.');
  const row = getRoomRow(code);
  if (!row) throw new RoomError(404, 'NO_ROOM', 'No such room.');
  return row;
}

function assertOpen(row) {
  if (row.endedAt) throw new RoomError(410, 'ENDED', 'This room has ended.');
  return row;
}

const VISIBILITIES = new Set(['public', 'private']);
const CONTROLS = new Set(['everyone', 'host']);

export function createRoom({ host, visibility = 'public', control = 'everyone', queue, index = 0, positionMs = 0, playing = false }) {
  if (!VISIBILITIES.has(visibility)) throw new RoomError(400, 'BAD_INPUT', 'Visibility must be public or private.');
  if (!CONTROLS.has(control)) throw new RoomError(400, 'BAD_INPUT', 'Control must be everyone or host.');
  const tracks = normaliseQueue(queue);
  // A room with nothing to play has no playhead to share; the UI asks for a
  // track first, which is one honest step instead of an empty page.
  if (!tracks.length) throw new RoomError(400, 'NO_TRACK', 'Play something first — a room needs a track to share.');
  // One commit for the whole queue: a 60-track room would otherwise pay 60.
  transaction(() => { for (const t of tracks) upsertTrack(t); });
  const selected = Number.isInteger(index)
    ? Math.min(Math.max(0, index), tracks.length - 1)
    : 0;
  const state = {
    queue: tracks,
    index: selected,
    // Store the same bounded playhead the first snapshot reports; otherwise an
    // oversized position is only clamped on read and a non-finite one becomes
    // null when the state is serialised.
    positionMs: clampPosition(positionMs, tracks[selected]),
    anchorAt: Date.now(),
    playing: Boolean(playing),
    updatedBy: { id: host.id, name: host.name },
  };
  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
    const code = makeCode();
    if (getRoomRow(code)) continue;
    row = createRoomRow({ code, hostId: host.id, visibility, control, state });
  }
  if (!row) throw new RoomError(500, 'NO_CODE', 'Could not allocate a room code.');
  // The host is a member from the start: hosting implies listening.
  addRoomMember(row.code, host.id, 'host');
  return snapshotFor(row, { userId: host.id });
}

export function joinRoom(code, user) {
  const row = assertOpen(mustGetRoom(code));
  const existing = getRoomMember(code, user.id);
  if (!existing) {
    const invited = getRoomInvite(code, user.id);
    if (row.visibility === 'private' && row.hostId !== user.id && !invited) {
      throw new RoomError(403, 'PRIVATE', 'This room is private. Ask the host to invite you.');
    }
    if (countRoomMembers(code) >= config.roomMaxMembers) {
      throw new RoomError(409, 'FULL', 'This room is full.');
    }
    addRoomMember(code, user.id, row.hostId === user.id ? 'host' : 'member');
    publish(code, 'members', presencePayload(code));
  } else {
    touchRoomMember(code, user.id);
  }
  touchRoomRow(code);
  return snapshotFor(getRoomRow(code), { userId: user.id });
}

export function leaveRoom(code, user) {
  const row = assertOpen(mustGetRoom(code));
  const isHost = row.hostId === user.id;
  // Leaving is not ending. The host owns `rooms.host_id` whether or not a
  // membership row exists, so deleting their row only made the room report
  // `joined: false` to its own host and answer their next command with
  // `403 NOT_MEMBER` — and under `control: 'host'` that stranded the room,
  // because nobody else may move the playhead. A host keeps the seat; giving it
  // up explicitly is transferHost(), and ending the room is endRoom().
  if (!isHost) removeRoomMember(code, user.id);
  // Orphaning a live stream would leave it watching a room it is no longer in.
  // One account may hold several streams; remove all of them before paying for
  // one final roster fanout instead of publishing an intermediate roster per
  // closed socket (quadratic in a room with several duplicate connections).
  const entry = hub.get(code);
  for (const sub of [...(entry?.subs ?? [])]) {
    if (sub.userId === user.id) dropSub(code, sub, { notify: false });
  }
  publish(code, 'members', presencePayload(code));
  return { ok: true, code: row.code, host: isHost };
}

export function endRoom(code, user) {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== user.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can end the room.');
  endRoomRow(code);
  // The terminal frame is the last event, even if writing it drops a socket.
  // Teardown is deliberately silent: nobody remains to consume the successive
  // intermediate member lists, and ending N streams must not publish N times.
  publish(code, 'room', { ended: true, code }, { notifyDrops: false });
  const entry = hub.get(code);
  for (const sub of [...(entry?.subs ?? [])]) dropSub(code, sub, { notify: false });
  return { ok: true };
}

/**
 * Hand the host seat to another member.
 *
 * This is the escape hatch for the worst room state there is: under
 * `control: 'host'` nobody but the host may move the playhead or end the room,
 * so a host who simply walks away used to strand everyone until housekeeping
 * deleted the room hours later. Only the host may give the seat away (otherwise
 * any member could seize the room), and only to someone who is actually in it —
 * handing the room to an id that is not a member would produce a room whose host
 * cannot see it.
 *
 * Both halves of the seat move: `rooms.host_id` (authorization) and the member
 * row's `role` (what the roster, and therefore the client, draws).
 */
export function transferHost(code, user, newHostId) {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== user.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can hand the room over.');
  const target = Number(newHostId);
  if (!Number.isInteger(target) || target <= 0) {
    throw new RoomError(400, 'BAD_INPUT', 'Pick the person to hand the room to.');
  }
  if (target === row.hostId) throw new RoomError(409, 'ALREADY_HOST', 'They are already hosting this room.');
  if (!getRoomMember(code, target)) {
    throw new RoomError(400, 'NOT_MEMBER', 'Only someone who is in the room can take it over.');
  }

  transaction(() => {
    setRoomHost(code, target);
    setRoomMemberRole(code, target, 'host');
    // The old host stays a member: losing the seat is not being removed from the
    // room, and a host who was also listening should keep their place in it.
    setRoomMemberRole(code, row.hostId, 'member');
  });

  const fresh = getRoomRow(code);
  const snapshot = snapshotFor(fresh, { userId: user.id });
  // State first, then presence, then the room frame: a client applies the
  // snapshot and re-reads its own permissions from the roster that follows. The
  // same order updateRoom() uses.
  publish(code, 'state', snapshot);
  publish(code, 'members', presencePayload(code));
  publish(code, 'room', { hostId: fresh.hostId, control: fresh.control, code: fresh.code });
  scheduleEnd(code);
  return snapshot;
}

/**
 * Mark a room as still in use, without a command.
 *
 * Presence is the SSE stream (see `liveCodes`), so a listener on the polling
 * fallback — a proxy that blocks streaming, a browser without EventSource — is
 * invisible to `expireRooms` and their room could be deleted while they were
 * actively following it. `GET /state` is that client's heartbeat, so it says so.
 * A no-op for a room that is already gone: there is nothing left to keep alive.
 */
export function touchRoomPresence(code) {
  try {
    touchRoomRow(code);
  } catch {
    // A room deleted between the caller's viewRoom() and this write needs no
    // presence, and the caller already has its snapshot.
  }
}

export function updateRoom(code, user, patch = {}) {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== user.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can change the room.');
  const visibility = patch.visibility == null ? null : String(patch.visibility);
  const control = patch.control == null ? null : String(patch.control);
  if (visibility && !VISIBILITIES.has(visibility)) throw new RoomError(400, 'BAD_INPUT', 'Visibility must be public or private.');
  if (control && !CONTROLS.has(control)) throw new RoomError(400, 'BAD_INPUT', 'Control must be everyone or host.');
  updateRoomMeta(code, { visibility, control });
  const fresh = getRoomRow(code);
  // Going private is a revocation, not a label: anonymous listeners had no
  // account to remove, so their streams are closed now rather than left open
  // until they disconnect. The eviction runs BEFORE the state broadcast: a
  // guest used to receive one last full `state` frame (queue and track intact)
  // on the same tick the room stopped sharing it, and only then the `room`
  // eviction.
  if (fresh.visibility === 'private') {
    // Drop with notify disabled and publish once after the loop: notifying per
    // guest would broadcast N roster frames in one tick, all describing the
    // same intermediate states of a single eviction (mirrors the buffered-drop
    // sweep in publish).
    const guests = [...(hub.get(code)?.subs ?? [])].filter((s) => s.guest);
    for (const sub of guests) {
      try { sub.res.write(frame('room', { code, removed: true, reason: 'This room is now private.' })); } catch {}
      dropSub(code, sub, { notify: false });
    }
    if (guests.length) publish(code, 'members', presencePayload(code));
  }
  const snapshot = snapshotFor(fresh, { userId: user.id });
  publish(code, 'state', snapshot);
  publish(code, 'room', { visibility: fresh.visibility, control: fresh.control, code });
  scheduleEnd(code);
  return snapshot;
}

// ── invites ─────────────────────────────────────────────────────────────

export function inviteUser(code, host, { name = null, userId = null } = {}) {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== host.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can invite people.');
  let target = null;
  if (Number.isInteger(userId)) {
    // Look the account up directly. Searching for "" and taking the first 50
    // hits silently refused every user whose name sorts after the fiftieth, and
    // "no such user" is the honest answer for a disabled one.
    const u = getUser(userId);
    if (!u || u.disabled) throw new RoomError(404, 'NO_USER', 'No account with that name.');
    target = { id: u.id, name: u.name };
  }
  if (!target) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) throw new RoomError(400, 'BAD_INPUT', 'Who should be invited?');
    const hits = searchUsers(String(name).trim(), host.id, 5);
    target = hits.find((u) => u.name.toLowerCase() === wanted) ?? null;
  }
  if (!target) throw new RoomError(404, 'NO_USER', 'No account with that name.');
  if (getRoomMember(code, target.id)) throw new RoomError(409, 'MEMBER', `${target.name} is already in the room.`);
  addRoomInvite(code, target.id, host.id);
  publish(code, 'members', presencePayload(code));
  return { invites: listRoomInvites(code) };
}

export function uninviteUser(code, host, userId) {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== host.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can remove an invite.');
  removeRoomInvite(code, userId);
  return { invites: listRoomInvites(code) };
}

/** Candidates for the invite field, annotated with their current state. */
export function peopleFor(code, user, q = '') {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== user.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can invite people.');
  const invited = new Set(listRoomInvites(code).map((i) => i.id));
  const members = new Set(listRoomMembers(code).map((m) => m.id));
  return searchUsers(q, user.id, 10)
    .map((u) => ({ ...u, invited: invited.has(u.id), member: members.has(u.id) }));
}

// ── commands ────────────────────────────────────────────────────────────

/**
 * Apply one intent to the room and broadcast the result.
 *
 * Throws RoomError; a `STALE` one carries the current snapshot so the caller
 * (and the client) can simply follow the winner of the race.
 */
export function applyCommand(code, user, body = {}) {
  const row = assertOpen(mustGetRoom(code));
  const member = getRoomMember(code, user.id);
  if (!member) throw new RoomError(403, 'NOT_MEMBER', 'Join this room first.');
  const type = String(body.type ?? '');
  const isHost = row.hostId === user.id;

  const base = parseRoomState(row) ?? { queue: [], index: 0, positionMs: 0, playing: false };
  const now = Date.now();
  const ph = derivePlayhead(base, now);
  const dur = durationMs(ph.track);
  // A natural continuation is not a skip: once the track has really ended, any
  // member may carry the room forward whatever the control policy says. The
  // policy gate used to run first, so under `control: 'host'` that exemption
  // was unreachable and a room froze at the end of EVERY track once the host's
  // phone went to sleep — the exact case the exemption exists for.
  const autoAdvance = Boolean(body.auto)
    // Only forward continuation is natural. `prev` is always transport control:
    // the shared exemption must never let a member move a host-only room back.
    && type === 'next'
    && (ph.ended || (dur != null && ph.positionMs >= dur - AUTO_END_TOLERANCE_MS));

  // Host-only control: a member may still suggest a track (a queue is a
  // suggestion), but not move everyone's playhead.
  if (row.control === 'host' && !isHost && type !== 'queue-add' && !autoAdvance) {
    throw new RoomError(403, 'HOST_ONLY', 'Only the host controls this room.');
  }

  // Two people pressing next at the same moment must advance once. A relative
  // command is therefore only valid against the revision it was formed on;
  // the loser follows the winner. Absolute commands rebase instead — the user
  // asked for a position, not for a change to the old one.
  //
  // The revision is REQUIRED for a relative command, and required to be an
  // integer: a missing or malformed `rev` used to fall back to "current", so
  // `{type:'next'}` bypassed the very check that makes "two people pressing
  // next advance once" true.
  if (type === 'next' || type === 'prev') {
    if (!Number.isInteger(body.rev)) {
      throw new RoomError(400, 'BAD_INPUT', 'Say which revision of the room this command is based on.');
    }
    if (body.rev !== row.rev) {
      throw new RoomError(409, 'STALE', 'The room already moved on.', snapshotFor(row, { userId: user.id }));
    }
  }

  const state = {
    ...base,
    queue: [...ph.queue],
    index: ph.index,
    positionMs: ph.positionMs,
    anchorAt: now,
    playing: ph.playing,
    updatedBy: { id: user.id, name: user.name },
  };
  const jump = (index) => {
    state.index = index;
    state.positionMs = 0;
    state.anchorAt = now;
    state.playing = true;
  };

  switch (type) {
    case 'play': {
      // Restarting a finished track is the only reading of play that makes
      // sense; anywhere else it resumes exactly where the room paused.
      if (ph.ended) state.positionMs = 0;
      else if (Number.isFinite(body.positionMs)) state.positionMs = clampPosition(body.positionMs, ph.track);
      state.playing = true;
      break;
    }
    case 'pause': {
      if (Number.isFinite(body.positionMs)) state.positionMs = clampPosition(body.positionMs, ph.track);
      state.playing = false;
      break;
    }
    case 'seek': {
      if (!Number.isFinite(body.positionMs)) throw new RoomError(400, 'BAD_INPUT', 'Where should it seek to?');
      state.positionMs = clampPosition(body.positionMs, ph.track);
      break;
    }
    case 'select': {
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= state.queue.length) {
        throw new RoomError(400, 'BAD_INPUT', 'No such track in the queue.');
      }
      jump(i);
      if (Number.isFinite(body.positionMs)) state.positionMs = clampPosition(body.positionMs, state.queue[i]);
      break;
    }
    // The room follows what its people actually play. Starting a playlist,
    // album or single track in the app sends this, so there is no second
    // "add to the room" step to remember.
    case 'queue-set': {
      const tracks = normaliseQueue(body.queue);
      if (!tracks.length) throw new RoomError(400, 'NO_TRACK', 'Nothing to play.');
      const i = Number.isInteger(body.index) ? body.index : 0;
      // Every rejection belongs before the catalogue write. An invalid index is
      // not consent to insert otherwise valid, attacker-chosen track metadata.
      if (i < 0 || i >= tracks.length) throw new RoomError(400, 'BAD_INPUT', 'No such track in the queue.');
      transaction(() => { for (const t of tracks) upsertTrack(t); });
      state.queue = tracks;
      state.index = i;
      state.positionMs = clampPosition(body.positionMs ?? 0, state.queue[state.index]);
      state.anchorAt = now;
      state.playing = body.playing !== false;
      break;
    }
    case 'next':
    case 'prev': {
      if (!state.queue.length) throw new RoomError(400, 'EMPTY', 'The queue is empty.');
      // A natural continuation is allowed by anyone, but only once the track has
      // really ended; otherwise it is a skip and obeys the control policy.
      if (body.auto && !autoAdvance && !isHost) {
        throw new RoomError(403, 'NOT_ENDED', 'That track has not finished yet.');
      }
      const n = state.queue.length;
      jump(type === 'next' ? (ph.index + 1) % n : (ph.index - 1 + n) % n);
      break;
    }
    case 'queue-add': {
      const track = normaliseTrack(body.track ?? body);
      if (!track) throw new RoomError(400, 'BAD_INPUT', 'That track cannot be added.');
      if (state.queue.length >= MAX_QUEUE) throw new RoomError(409, 'QUEUE_FULL', 'This room’s queue is full.');
      const dupe = state.queue.findIndex((t) => t.videoId === track.videoId);
      // Repeating an add remains a 409 no-op. Validate first so even the global
      // catalogue, not just this room's queue and revision, is left untouched.
      if (dupe >= 0) throw new RoomError(409, 'IN_QUEUE', 'That track is already in the queue.');
      upsertTrack(track);
      // Adding to an empty room starts it: silence with a queue is a bug.
      if (!state.queue.length) jump(0);
      state.queue.push(track);
      break;
    }
    case 'queue-remove': {
      const wanted = body.videoId == null ? '' : String(body.videoId);
      // Removal is by TRACK, not by position, whenever the client says which
      // track it means. Removing "index 2" after the queue shifted underneath
      // deletes a different song than the one the user pointed at (a retried
      // request is the obvious way to get there), so:
      //   * `videoId` is the idempotent form — already gone is the outcome the
      //     caller wanted, and it must never take a neighbour with it;
      //   * `index` alone is only honoured against the revision the client was
      //     looking at, so a stale index is refused (`409 STALE`) instead of
      //     silently deleting the wrong row.
      if (wanted) {
        const i = state.queue.findIndex((t) => t.videoId === wanted);
        if (i < 0) return snapshotFor(row, { userId: user.id }); // already removed
        if (i === ph.index) throw new RoomError(400, 'CURRENT', 'That track is playing — skip it instead.');
        state.queue.splice(i, 1);
        if (i < ph.index) state.index = ph.index - 1;
        break;
      }
      if (!Number.isInteger(body.index)) {
        throw new RoomError(400, 'BAD_INPUT', 'Say which track to remove.');
      }
      if (!Number.isInteger(body.rev)) {
        throw new RoomError(400, 'BAD_INPUT', 'Say which revision of the room this command is based on.');
      }
      if (body.rev !== row.rev) {
        throw new RoomError(409, 'STALE', 'The room already moved on.', snapshotFor(row, { userId: user.id }));
      }
      const i = body.index;
      if (i < 0 || i >= state.queue.length) throw new RoomError(400, 'BAD_INPUT', 'No such track in the queue.');
      if (i === ph.index) throw new RoomError(400, 'CURRENT', 'That track is playing — skip it instead.');
      state.queue.splice(i, 1);
      if (!state.queue.length) {
        state.index = 0;
        state.positionMs = 0;
        state.playing = false;
      } else if (i < ph.index) {
        state.index = ph.index - 1;
      }
      break;
    }
    default:
      throw new RoomError(400, 'BAD_INPUT', 'Unknown room command.');
  }

  updateRoomState(code, { state, rev: row.rev + 1, updatedAt: nowIso() });
  const snapshot = snapshotFor(getRoomRow(code), { userId: user.id });
  publish(code, 'state', snapshot);
  // Arm the derived end broadcast for whatever this command started.
  scheduleEnd(code);
  return snapshot;
}

// ── housekeeping ────────────────────────────────────────────────────────

/**
 * Delete idle rooms. A room with a live subscriber is never idle, whatever
 * `updated_at` says — a group paused overnight with tabs open is still a room.
 */
export function expireRooms() {
  const idleCutoff = new Date(Date.now() - config.roomHours * 3_600_000).toISOString();
  const endedCutoff = new Date(Date.now() - 3_600_000).toISOString();
  const live = liveCodes();
  let removed = 0;
  for (const code of listRoomsToPrune(idleCutoff, endedCutoff)) {
    if (live.has(code)) continue;
    if (deleteRoomRow(code)) removed += 1;
  }
  return removed;
}

/** Used by the landing page and the room route; never leaks a private track. */
export function roomPreview(code) {
  if (!ROOM_CODE.test(String(code ?? ''))) return null;
  const row = getRoomRow(code);
  if (!row || row.endedAt) return null;
  const host = getUser(row.hostId);
  const base = {
    code: row.code,
    host: host?.name ?? null,
    visibility: row.visibility,
    control: row.control,
    members: countRoomMembers(row.code),
    guests: guestCount(row.code),
    listeners: listenerCount(row.code),
    createdAt: Date.parse(row.createdAt) || null,
  };
  if (row.visibility === 'private') return { ...base, track: null };
  const ph = derivePlayhead(parseRoomState(row) ?? {}, Date.now());
  // `playing` is what the listener page needs to decide whether its first
  // gesture should start sound or only unlock the element (a paused room must
  // not blast the join screen). The queue is here too: a public room's queue is
  // already visible to every guest, and server-rendering it means the listener
  // page has the running order on screen before a byte of JavaScript runs.
  return {
    ...base,
    track: ph.track,
    playing: ph.playing,
    positionMs: ph.positionMs,
    index: ph.index,
    queue: ph.queue,
  };
}

// ── anonymous public listeners ──────────────────────────────────────────
// A public room is the one place audio does not require an account. The guest
// identity is a signed, room-scoped cookie (see signGuest in db.js): it opens
// this room's state, stream and nothing else. Guests are listeners — they can
// never command the transport, which keeps "anyone can listen" from becoming
// "anyone can skip the host's song".

export function publicSnapshot(code) {
  const row = assertOpen(mustGetRoom(code));
  if (row.visibility !== 'public') {
    throw new RoomError(403, 'PRIVATE', 'This room is private. Sign in and ask the host to invite you.');
  }
  const snapshot = {
    ...snapshotFor(row, { userId: null, includeActor: false }),
    joined: true,
    guest: true,
    // Names of account members are not a public-room resource: a guest gets the
    // count, never the roster.
    members: [],
    listeners: listenerCount(code),
  };
  return snapshot;
}

/**
 * The security boundary for anonymous audio: a guest may fetch a track only
 * while it is in a public room's queue. Not "any track this room ever played",
 * and certainly not an arbitrary video id.
 */
export function guestStreamAllowed(code, videoId) {
  if (!ROOM_CODE.test(String(code ?? ''))) return false;
  const row = getRoomRow(code);
  if (!row || row.endedAt || row.visibility !== 'public') return false;
  const ph = derivePlayhead(parseRoomState(row) ?? {}, Date.now());
  return ph.queue.some((t) => t.videoId === videoId);
}
