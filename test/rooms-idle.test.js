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

function makeRoom(code) {
  db.createRoomRow({
    code,
    hostId: host.id,
    visibility: 'public',
    control: 'everyone',
    state: { queue: [TRACK], index: 0, positionMs: 0, anchorAt: Date.now(), playing: false },
  });
  db.addRoomMember(code, host.id, 'host');
}

const backdate = (code) => db.db.prepare('UPDATE rooms SET updated_at = ?, ended_at = ? WHERE code = ?')
  .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), null, code);

before(() => {
  host = db.createUser('host', 'host-pass', 'user');
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
