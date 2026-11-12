import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Room housekeeping, in-process against its own database.
//
// The rule that matters: a room is idle because nothing has happened AND nobody
// is connected. A group paused overnight with a tab open is still a room, and
// `updated_at` cannot see an open stream — only the live hub can. That is why
// this test needs the hub, not just SQL.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-rooms-idle-'));
process.env.SONORA_DB = path.join(dir, 'idle.db');
process.env.SONORA_AUDIO_DIR = path.join(dir, 'audio');
process.env.SONORA_SECRET = 'rooms-idle-test';
process.env.SONORA_PASSPHRASE = 'hunter2hunter2';
// Zero idle hours makes "old enough" deterministic; the live-stream exemption
// is what the test is really exercising.
process.env.SONORA_ROOM_HOURS = '0';

const db = await import('../src/db.js');
const rooms = await import('../src/rooms.js');

const TRACK = { videoId: 'dQw4w9WgXcQ', title: 'Idle Room', channel: '', thumb: null, durationS: 10 };
let host;

function makeRoom(code, {
  track = TRACK, index = 0, positionMs = 0, anchorAt = Date.now(), playing = false,
} = {}) {
  db.createRoomRow({
    code,
    hostId: host.id,
    visibility: 'public',
    control: 'everyone',
    state: { queue: [track], index, positionMs, anchorAt, playing },
  });
  db.addRoomMember(code, host.id, 'host');
}

const backdate = (code) => db.db.prepare('UPDATE rooms SET updated_at = ?, ended_at = ? WHERE code = ?')
  .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), null, code);

before(() => {
  host = db.createUser('host', 'host-passphrase', 'user');
});

after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('an idle room with nobody connected is pruned', () => {
  makeRoom('23456789ab');
  backdate('23456789ab');
  const removed = rooms.expireRooms();
  assert.ok(removed >= 1);
  assert.equal(db.getRoomRow('23456789ab'), null);
});

test('a room with a live listener is never pruned, however old it looks', () => {
  makeRoom('3456789abc');
  // A minimal stand-in for an SSE response: the hub only writes and ends.
  const writes = [];
  const res = { write: (chunk) => writes.push(chunk), end: () => {}, on: () => {} };
  const sub = rooms.openStream('3456789abc', host, res, { members: [] });
  assert.ok(sub, 'the stream opened');
  assert.ok(writes.join('').includes('event: snapshot'));
  // openStream touches the row on purpose; backdate it again so the *only*
  // reason it survives is the live connection, not a fresh timestamp.
  backdate('3456789abc');
  rooms.expireRooms();
  assert.ok(db.getRoomRow('3456789abc'), 'the live room survived housekeeping');
  // Leave the hub clean so it cannot influence a later assertion.
  rooms.leaveRoom('3456789abc', host);
});

test('a guest counts as presence, and losing them makes the room idle again', () => {
  makeRoom('56789abcde');
  const handlers = {};
  const res = { write: () => {}, end: () => {}, on: (name, fn) => { handlers[name] = fn; } };
  const sub = rooms.openStream('56789abcde', { id: 'g:abc', name: 'Guest', guest: true }, res, { members: [] });
  assert.ok(sub, 'a guest stream opened');
  assert.equal(rooms.guestCount('56789abcde'), 1, 'and is counted as presence');
  backdate('56789abcde');
  rooms.expireRooms();
  assert.ok(db.getRoomRow('56789abcde'), 'a room with only a guest listening is not idle');

  // The socket closing is what ends a guest's presence, since there is no row.
  handlers.close();
  assert.equal(rooms.guestCount('56789abcde'), 0);
  backdate('56789abcde');
  rooms.expireRooms();
  assert.equal(db.getRoomRow('56789abcde'), null, 'and then the room is idle');
});

test('an ended room is collected even before the idle window', () => {
  makeRoom('456789abcd');
  db.endRoomRow('456789abcd');
  db.db.prepare('UPDATE rooms SET ended_at = ?, updated_at = ? WHERE code = ?')
    .run(new Date(Date.now() - 2 * 3_600_000).toISOString(),
      new Date(Date.now() - 2 * 3_600_000).toISOString(), '456789abcd');
  rooms.expireRooms();
  assert.equal(db.getRoomRow('456789abcd'), null);
});

// These are deliberate regressions for defects reproduced against the live room
// hub. Keeping them in this in-process suite lets a timer be inspected without
// waiting 24 days and lets one roster frame be counted without network timing.
const responseStub = () => ({
  writes: [],
  ended: false,
  write(chunk) { this.writes.push(chunk); return true; },
  end() { this.ended = true; },
  on() {},
});
const countFrames = (responses, event) => responses.reduce((n, res) => (
  n + res.writes.filter((chunk) => chunk.startsWith(`event: ${event}\n`)).length
), 0);

// Node turns a delay above 2^31-1 (and NaN) into a 1 ms timer. Re-arming it on
// every firing is therefore a hot loop, not a harmless lower-resolution timer.
test('long and corrupt end waits are capped, finite and safely re-armed', () => {
  const longCode = '6789abcdef';
  const corruptCode = '789abcdefg';
  makeRoom(longCode, { track: { ...TRACK, durationS: 3_000_000 }, playing: true });
  makeRoom(corruptCode, {
    track: { ...TRACK, videoId: '9bZkp7q19f0', durationS: Number.MAX_VALUE },
    positionMs: 'corrupt', anchorAt: 'corrupt', playing: true,
  });

  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => {
    const timer = { fn, delay, unref() { return this; } };
    timers.push(timer);
    return timer;
  };
  try {
    for (const code of [longCode, corruptCode]) {
      assert.ok(rooms.openStream(code, host, responseStub()));
    }
    assert.equal(timers.length, 2, 'one end wait per live room');
    for (const timer of timers) {
      assert.ok(Number.isFinite(timer.delay) && timer.delay > 0, `not a 1 ms/NaN timer (${timer.delay})`);
      assert.ok(timer.delay <= 2_147_483_647, `Node accepts this delay literally (${timer.delay})`);
    }

    // Simulate each timer firing early. It must calculate a fresh bounded wait,
    // not recurse, publish a bogus end, or create another overflowing timeout.
    timers.slice().forEach((timer) => timer.fn());
    assert.equal(timers.length, 4, 'each early wake-up arms exactly one successor');
    for (const timer of timers.slice(2)) {
      assert.ok(Number.isFinite(timer.delay) && timer.delay > 0 && timer.delay <= 2_147_483_647);
    }
    const corrupt = rooms.derivePlayhead(db.parseRoomState(db.getRoomRow(corruptCode)));
    assert.ok(Number.isFinite(corrupt.positionMs), 'a corrupt anchor cannot poison the playhead');
    assert.equal(corrupt.positionMs, 0, 'an unrecoverable stored position has a safe origin');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    for (const code of [longCode, corruptCode]) {
      try { rooms.leaveRoom(code, host); } catch {}
    }
  }
});

test('bulk queues keep the first copy, and creation stores finite in-range state', () => {
  const duplicate = { ...TRACK, title: 'A later duplicate must not replace the first' };
  const other = { ...TRACK, videoId: '9bZkp7q19f0', title: 'Other' };
  const queue = rooms.normaliseQueue([TRACK, duplicate, { videoId: 'bad' }, other, TRACK]);
  assert.deepEqual(queue.map((track) => track.videoId), [TRACK.videoId, other.videoId]);
  assert.equal(queue[0].title, TRACK.title);

  const created = rooms.createRoom({
    host, queue: [TRACK, duplicate, other], index: 99, positionMs: 500_000, playing: false,
  });
  assert.deepEqual(created.queue.map((track) => track.videoId), [TRACK.videoId, other.videoId]);
  assert.equal(created.index, 1, 'the selected track remains bounded after normalisation');
  assert.equal(created.track.videoId, other.videoId);
  assert.equal(created.positionMs, 10_000, 'creation clamps to the selected track duration');
  const stored = db.parseRoomState(db.getRoomRow(created.code));
  assert.equal(stored.index, 1);
  assert.equal(stored.positionMs, 10_000);
});

test('an opening SSE snapshot derives online flags after joining the hub', () => {
  const code = '89abcdefgh';
  makeRoom(code);
  const res = responseStub();
  const stale = [{ id: host.id, name: host.name, role: 'host', online: false }];
  assert.ok(rooms.openStream(code, host, res, { members: stale }));
  const match = res.writes.join('').match(/event: snapshot\ndata: (.+)\n/);
  assert.ok(match, 'the opening snapshot was written');
  const snapshot = JSON.parse(match[1]);
  assert.equal(snapshot.members.find((member) => member.id === host.id)?.online, true,
    'the new subscriber is online in its very first frame');
  rooms.leaveRoom(code, host);
});

test('ending a room emits no members frames after its terminal room frame', () => {
  const code = '9abcdefghj';
  makeRoom(code);
  const responses = [responseStub()];
  responses[0].write = function write(chunk) {
    if (chunk.startsWith('event: room\n')) throw new Error('terminal socket failed');
    this.writes.push(chunk);
    return true;
  };
  assert.ok(rooms.openStream(code, host, responses[0]));
  for (let i = 0; i < 4; i += 1) {
    const member = db.createUser(`end-${i}`, 'end-member-passphrase', 'user');
    db.addRoomMember(code, member.id, 'member');
    const res = responseStub();
    responses.push(res);
    assert.ok(rooms.openStream(code, member, res));
  }
  for (const res of responses) res.writes.length = 0;

  rooms.endRoom(code, host);
  assert.equal(countFrames(responses, 'members'), 0,
    'bulk terminal teardown cannot publish intermediate or post-terminal presence');
  assert.ok(responses.every((res) => res.ended), 'every live stream is closed');
  assert.equal(rooms.listenerCount(code), 0);
});

test('leaving closes every matching stream but publishes the final roster once', () => {
  const code = 'abcdefghj2';
  makeRoom(code);
  const leaving = db.createUser('leaving', 'leaving-passphrase', 'user');
  const observer = db.createUser('observer', 'observer-passphrase', 'user');
  db.addRoomMember(code, leaving.id, 'member');
  db.addRoomMember(code, observer.id, 'member');
  const leaverStreams = [responseStub(), responseStub(), responseStub()];
  const observerStream = responseStub();
  for (const res of leaverStreams) assert.ok(rooms.openStream(code, leaving, res));
  assert.ok(rooms.openStream(code, observer, observerStream));
  for (const res of [...leaverStreams, observerStream]) res.writes.length = 0;

  rooms.leaveRoom(code, leaving);
  assert.equal(countFrames([observerStream], 'members'), 1);
  assert.equal(countFrames([...leaverStreams, observerStream], 'members'), 1,
    'no N broadcast fanout while three streams for one account are being dropped');
  assert.ok(leaverStreams.every((res) => res.ended));
  assert.equal(observerStream.ended, false);
  rooms.leaveRoom(code, observer);
});
