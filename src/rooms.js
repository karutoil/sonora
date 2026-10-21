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
const TICK_MS = 15_000;

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
  return (Array.isArray(list) ? list : [])
    .map(normaliseTrack)
    .filter(Boolean)
    .slice(0, MAX_QUEUE);
}

const durationMs = (track) => (track?.durationS > 0 ? track.durationS * 1000 : null);

/**
 * Where the playhead is at `now`, from stored state.
 *
 * `ended` is computed, not stored: a known duration plus a position past it is
 * the end of a track, and no per-room timer should be responsible for noticing.
 */
export function derivePlayhead(state, now = Date.now()) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  const index = queue.length
    ? Math.min(Math.max(0, state.index ?? 0), queue.length - 1)
    : 0;
  const track = queue[index] ?? null;
  const dur = durationMs(track);
  let positionMs = Math.max(0, Math.round(state?.positionMs ?? 0));
  let playing = Boolean(state?.playing);
  if (playing) positionMs += Math.max(0, now - (state?.anchorAt ?? now));
  let ended = false;
  // A track with no known duration can never be "ended" here; the host's own
  // player reports that case (see the `auto` rule in applyCommand).
  if (dur != null && positionMs >= dur) {
    positionMs = dur;
    ended = true;
    playing = false;
  }
  return { queue, index, track, positionMs, playing, ended };
}

const clampPosition = (value, track) => {
  const max = durationMs(track);
  const n = Math.max(0, Math.round(Number(value) || 0));
  return max != null ? Math.min(n, max) : n;
};

const nowIso = () => new Date().toISOString();

/** The wire object. `at` is the server instant `positionMs` was true. */
export function snapshotFor(row, { userId = null } = {}) {
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
    ...(stored.updatedBy ? { updatedBy: stored.updatedBy } : {}),
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

function dropSub(code, sub) {
  const entry = hub.get(code);
  if (!entry) return;
  entry.subs.delete(sub);
  try { sub.res.end(); } catch { /* already gone */ }
  publish(code, 'members', presencePayload(code));
  if (!entry.subs.size) {
    clearInterval(entry.ticker);
    hub.delete(code);
  }
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

export function publish(code, event, data) {
  const entry = hub.get(code);
  if (!entry?.subs.size) return;
  const payload = frame(event, data);
  // A guest must never receive the roster: account names are not a public-room
  // resource, so the presence event is shaped per subscriber.
  let guestPayload = null;
  for (const sub of [...entry.subs]) {
    let out = payload;
    if (sub.guest && event === 'members') {
      guestPayload ??= frame('members', { members: [], guests: data.guests, listeners: data.listeners });
      out = guestPayload;
    }
    try { sub.res.write(out); } catch { dropSub(code, sub); }
  }
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
export function openStream(code, identity, res, { members } = {}) {
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
      members: members ?? memberRoster(code),
      listeners: listenerCount(code),
    };
  }
  res.write(frame('snapshot', snapshot));
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
  for (const t of tracks) upsertTrack(t);
  const state = {
    queue: tracks,
    index: Math.min(Math.max(0, index), tracks.length - 1),
    positionMs: Math.max(0, Math.round(positionMs)),
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
  removeRoomMember(code, user.id);
  // Orphaning a live stream would leave it watching a room it is no longer in.
  const entry = hub.get(code);
  for (const sub of [...(entry?.subs ?? [])]) if (sub.userId === user.id) dropSub(code, sub);
  publish(code, 'members', presencePayload(code));
  return { ok: true, code: row.code };
}

export function endRoom(code, user) {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== user.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can end the room.');
  endRoomRow(code);
  publish(code, 'room', { ended: true, code });
  const entry = hub.get(code);
  for (const sub of [...(entry?.subs ?? [])]) dropSub(code, sub);
  return { ok: true };
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
  const snapshot = snapshotFor(fresh, { userId: user.id });
  publish(code, 'state', snapshot);
  publish(code, 'room', { visibility: fresh.visibility, control: fresh.control, code });
  // Going private is a revocation, not a label: anonymous listeners had no
  // account to remove, so their streams are closed now rather than left open
  // until they disconnect.
  if (fresh.visibility === 'private') {
    const entry = hub.get(code);
    for (const sub of [...(entry?.subs ?? [])]) {
      if (!sub.guest) continue;
      try { sub.res.write(frame('room', { code, removed: true, reason: 'This room is now private.' })); } catch {}
      dropSub(code, sub);
    }
  }
  return snapshot;
}

// ── invites ─────────────────────────────────────────────────────────────

export function inviteUser(code, host, { name = null, userId = null } = {}) {
  const row = assertOpen(mustGetRoom(code));
  if (row.hostId !== host.id) throw new RoomError(403, 'HOST_ONLY', 'Only the host can invite people.');
  let target = null;
  if (Number.isInteger(userId)) {
    target = searchUsers('', null, 50).find((u) => u.id === userId) ?? null;
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

  // Host-only control: a member may still suggest a track (a queue is a
  // suggestion), but not move everyone's playhead.
  if (row.control === 'host' && !isHost && type !== 'queue-add') {
    throw new RoomError(403, 'HOST_ONLY', 'Only the host controls this room.');
  }

  const base = parseRoomState(row) ?? { queue: [], index: 0, positionMs: 0, playing: false };
  const now = Date.now();
  const ph = derivePlayhead(base, now);

  // Two people pressing next at the same moment must advance once. A relative
  // command is therefore only valid against the revision it was formed on;
  // the loser follows the winner. Absolute commands rebase instead — the user
  // asked for a position, not for a change to the old one.
  const rev = Number.isFinite(body.rev) ? Number(body.rev) : row.rev;
  if ((type === 'next' || type === 'prev') && rev !== row.rev) {
    throw new RoomError(409, 'STALE', 'The room already moved on.', snapshotFor(row, { userId: user.id }));
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
      for (const t of tracks) upsertTrack(t);
      const i = Number.isInteger(body.index) ? body.index : 0;
      if (i < 0 || i >= tracks.length) throw new RoomError(400, 'BAD_INPUT', 'No such track in the queue.');
      state.queue = tracks.slice(0, MAX_QUEUE);
      state.index = Math.min(i, state.queue.length - 1);
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
      if (body.auto && !ph.ended && !isHost) {
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
      upsertTrack(track);
      const dupe = state.queue.findIndex((t) => t.videoId === track.videoId);
      if (dupe >= 0) throw new RoomError(409, 'IN_QUEUE', 'That track is already in the queue.');
      // Adding to an empty room starts it: silence with a queue is a bug.
      if (!state.queue.length) jump(0);
      state.queue.push(track);
      break;
    }
    case 'queue-remove': {
      const i = Number.isInteger(body.index)
        ? body.index
        : state.queue.findIndex((t) => t.videoId === String(body.videoId ?? ''));
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
    ...snapshotFor(row, { userId: null }),
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
