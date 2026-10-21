import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { writeWav } from './helpers/wav.js';

// Listen Together, over the same HTTP surface a browser uses.
//
// The thing worth testing is not "does it return 200" — it is the two rules
// that make a shared playhead trustworthy:
//   * the server's position is a function of time, not of the last client to
//     report in (`at` + `positionMs`);
//   * a relative command formed on an old revision must not advance the room
//     twice, and the loser must receive the state to follow.
// Plus the two access rules: private means invited, and host-only means the
// host is the only transport.

const PORT = 8152;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = new URL(`./.tmp/rooms-${Date.now()}.db`, import.meta.url).pathname;
const AUDIO = new URL(`./.tmp/roomsaudio-${Date.now()}`, import.meta.url).pathname;

let proc;
const logs = [];

class Jar {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

async function req(path, { jar = null, body, method = 'GET', headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) jar.absorb(res);
  const isJson = res.headers.get('content-type')?.includes('json');
  return { res, status: res.status, body: isJson ? await res.json() : await res.text() };
}

const login = async (name, passphrase) => {
  const jar = new Jar();
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, passphrase, deviceId: `dev-${name}-test`, deviceName: 'Test' }),
  });
  jar.absorb(r);
  if (r.status !== 200) throw new Error(`login ${name} failed: ${r.status}`);
  return jar;
};

const TRACK = (videoId, title, durationS = 214) => ({
  videoId, title, channel: 'Room Test', durationS, thumb: null,
});

let toil; let ana; let ben; let carl;

before(async () => {
  fs.mkdirSync(new URL('./.tmp', import.meta.url).pathname, { recursive: true });
  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      SONORA_DB: DB, SONORA_AUDIO_DIR: AUDIO,
      SONORA_SECRET: 'rooms-test-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOGIN_RATE_MAX: '1000',
      // A small cap makes the "room is full" rule testable without 50 accounts.
      SONORA_ROOM_MAX_MEMBERS: '2',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  for (let i = 0; i < 160; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      const h = r.ok ? await r.json() : null;
      if (h?.pid === proc.pid) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  toil = await login('toil', 'hunter2hunter2');
  // Accounts other than the bootstrap one are created through the admin API,
  // exactly as an owner would.
  for (const name of ['ana', 'ben', 'carl']) {
    const r = await req('/api/admin/users', { jar: toil, method: 'POST', body: { name, passphrase: `${name}-pass`, role: 'user' } });
    assert.ok(r.status < 300, `create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  ana = await login('ana', 'ana-pass');
  ben = await login('ben', 'ben-pass');
  carl = await login('carl', 'carl-pass');
  // Remember two tracks so share links and room snapshots have metadata; the
  // engine never fabricates a title for an id it has not been told about.
  await req('/api/events', {
    jar: ana, method: 'POST',
    body: { ...TRACK('dQw4w9WgXcQ', 'Room One'), kind: 'start' },
  });
  await req('/api/events', {
    jar: ana, method: 'POST',
    body: { ...TRACK('9bZkp7q19f0', 'Room Two'), kind: 'start' },
  });
  // Real (if silent) audio for the three ids the tests use, so the stream route
  // answers 206 instead of trying to fetch from YouTube.
  for (const [i, id] of ['dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk'].entries()) {
    writeWav(`${AUDIO}/${id}.m4a`, { seconds: 40, freq: 300 + i * 100 });
  }
});

after(() => {
  try { proc?.kill('SIGKILL'); } catch {}
  // The audio fixtures and this run's database are large and one-shot; the
  // suite is not a library of previous runs.
  try { fs.rmSync(AUDIO, { recursive: true, force: true }); } catch {}
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(`${DB}${suffix}`, { force: true }); } catch {}
  }
});

const create = (jar, options = {}) => req('/api/rooms', {
  jar,
  method: 'POST',
  body: {
    visibility: 'public',
    control: 'everyone',
    queue: [TRACK('dQw4w9WgXcQ', 'Room One'), TRACK('9bZkp7q19f0', 'Room Two', 200)],
    index: 0,
    positionMs: 5000,
    playing: true,
    ...options,
  },
});

// ── creation and the playhead ──────────────────────────────────────────

test('a room needs a track and reports a playhead with a server timestamp', async () => {
  const bad = await req('/api/rooms', { jar: ana, method: 'POST', body: { visibility: 'public', queue: [] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'NO_TRACK');

  const { status, body } = await create(ana);
  assert.equal(status, 200);
  assert.match(body.code, /^[2-9a-hj-km-np-z]{8,12}$/);
  assert.equal(body.host.name, 'ana');
  assert.equal(body.joined, true);
  assert.equal(body.link, `/l/${body.code}`);
  assert.equal(body.rev, 1);
  assert.equal(body.track.videoId, 'dQw4w9WgXcQ');
  assert.ok(body.members.some((m) => m.name === 'ana' && m.role === 'host'), 'the host is a member');
  // `at` is the instant `positionMs` was true. A slow reader recomputes from
  // it; no lead compensation is needed and nothing is published by clients.
  const elapsed = body.now - body.at;
  assert.ok(elapsed >= 0 && elapsed < 5000, `at/now are consistent (${elapsed}ms)`);
});

test('the playhead advances with the clock while playing, and stops when paused', async () => {
  const { body: room } = await create(ana, { positionMs: 10_000 });
  await new Promise((r) => setTimeout(r, 650));
  const r1 = await req(`/api/rooms/${room.code}`, { jar: ana });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.positionMs >= 10_600, `position advanced (${r1.body.positionMs})`);
  assert.equal(r1.body.playing, true);

  const paused = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'pause', rev: r1.body.rev, positionMs: r1.body.positionMs },
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.playing, false);
  const frozen = paused.body.positionMs;
  await new Promise((r) => setTimeout(r, 400));
  const r2 = await req(`/api/rooms/${room.code}/state`, { jar: ana });
  assert.equal(r2.body.positionMs, frozen, 'a paused playhead does not drift');

  const resumed = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'play', rev: r2.body.rev },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.playing, true);
  // The response is a snapshot "as of now", so a few milliseconds of playback
  // have legitimately elapsed since the pause. It must continue from the pause,
  // not restart or jump.
  assert.ok(resumed.body.positionMs >= frozen && resumed.body.positionMs - frozen < 200,
    `resume continues where it paused (${resumed.body.positionMs} vs ${frozen})`);
});

test('a known duration turns the end of a track into derived state', async () => {
  const { status, body } = await req('/api/rooms', {
    jar: ana, method: 'POST',
    body: {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 900,
      queue: [{ ...TRACK('aBcDeFgHiJk', 'Short', 1) }],
    },
  });
  assert.equal(status, 200);
  await new Promise((r) => setTimeout(r, 250));
  const r = await req(`/api/rooms/${body.code}`, { jar: ana });
  assert.equal(r.body.ended, true);
  assert.equal(r.body.playing, false);
  assert.equal(r.body.positionMs, 1000, 'clamped to the duration, not past it');
});

test('any member may continue a track that ended; nobody may skip one that has not', async () => {
  // ana hosts a room, ben joins it.
  const { body: room } = await req('/api/rooms', {
    jar: ana, method: 'POST',
    body: {
      visibility: 'public', control: 'everyone', playing: true, positionMs: 0,
      queue: [TRACK('dQw4w9WgXcQ', 'Room One', 214), TRACK('9bZkp7q19f0', 'Room Two', 200)],
    },
  });
  const joined = await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  assert.equal(joined.status, 200);

  // Not ended: a member's "auto" advance is refused, because it would be a skip
  // disguised as a natural continuation.
  const early = await req(`/api/rooms/${room.code}/command`, {
    jar: ben, method: 'POST', body: { type: 'auto-next-placeholder' },
  });
  assert.equal(early.status, 400);
  const notEnded = await req(`/api/rooms/${room.code}/command`, {
    jar: ben, method: 'POST', body: { type: 'next', auto: true, rev: joined.body.rev },
  });
  assert.equal(notEnded.status, 403);
  assert.equal(notEnded.body.code, 'NOT_ENDED');

  // The host may declare the end of a track the catalogue had no duration for.
  const hostNext = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'next', auto: true, rev: joined.body.rev },
  });
  assert.equal(hostNext.status, 200);
  assert.equal(hostNext.body.index, 1);
});

// ── commands and revision conflicts ────────────────────────────────────

test('two people pressing next on the same revision advance the room once', async () => {
  const { body: room } = await create(ana);
  await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  const rev = room.rev;

  const first = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'next', rev },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.index, 1);
  const second = await req(`/api/rooms/${room.code}/command`, {
    jar: ben, method: 'POST', body: { type: 'next', rev },
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'STALE');
  // The loser gets the state to follow, not a dead end.
  assert.equal(second.body.state.index, 1);
  assert.equal(second.body.state.rev, first.body.rev);
});

test('absolute commands rebase instead of being rejected', async () => {
  const { body: room } = await create(ana, { positionMs: 0 });
  // A stale revision is fine for a seek: the user asked for a position, not for
  // a change to the old one.
  const seek = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'seek', rev: 1, positionMs: 42_000 },
  });
  assert.equal(seek.status, 200);
  assert.ok(seek.body.positionMs >= 42_000 && seek.body.positionMs < 42_200,
    `the seek landed at 42s (${seek.body.positionMs})`);
  const clamped = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'seek', rev: 1, positionMs: 999_999 },
  });
  assert.equal(clamped.body.positionMs, 214_000, 'a seek past the end is clamped');
});

test('the queue accepts a suggestion, refuses a duplicate, and never drops the current track', async () => {
  const { body: room } = await create(ana);
  const add = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST',
    body: { type: 'queue-add', track: TRACK('kJQP7kiw5Fk', 'Room Three') },
  });
  assert.equal(add.status, 200);
  assert.equal(add.body.queue.length, 3);

  const dupe = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'queue-add', track: TRACK('kJQP7kiw5Fk', 'Room Three') },
  });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, 'IN_QUEUE');

  const current = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'queue-remove', index: 0 },
  });
  assert.equal(current.status, 400);
  assert.equal(current.body.code, 'CURRENT');

  const removed = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'queue-remove', index: 2 },
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.queue.length, 2);
});

test('a non-member can read a public room but cannot join the transport or the stream', async () => {
  const { body: room } = await create(ana);
  const view = await req(`/api/rooms/${room.code}`, { jar: carl });
  assert.equal(view.status, 200);
  assert.equal(view.body.joined, false);

  const cmd = await req(`/api/rooms/${room.code}/command`, {
    jar: carl, method: 'POST', body: { type: 'pause', positionMs: 1 },
  });
  assert.equal(cmd.status, 403);
  assert.equal(cmd.body.code, 'NOT_MEMBER');

  const stream = await req(`/api/rooms/${room.code}/events`, { jar: carl });
  assert.equal(stream.status, 403);
  assert.equal(stream.body.code, 'NOT_MEMBER');

  const joined = await req(`/api/rooms/${room.code}/join`, { jar: carl, method: 'POST' });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.joined, true);
  assert.ok(joined.body.members.some((m) => m.name === 'carl'));
});

test('queue-set makes the room follow what someone is playing', async () => {
  const { body: room } = await create(ana);
  await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'seek', positionMs: 30_000 },
  });

  // Starting a playlist in the app sends exactly this: replace the room's queue
  // and playhead with the thing the person actually chose.
  const followed = await req(`/api/rooms/${room.code}/command`, {
    jar: ben,
    method: 'POST',
    body: {
      type: 'queue-set',
      queue: [TRACK('kJQP7kiw5Fk', 'Room Three'), TRACK('aBcDeFgHiJk', 'Room Four')],
      index: 1,
      positionMs: 1500,
      playing: true,
    },
  });
  assert.equal(followed.status, 200, JSON.stringify(followed.body));
  assert.equal(followed.body.queue.length, 2);
  assert.equal(followed.body.index, 1);
  assert.equal(followed.body.track.videoId, 'aBcDeFgHiJk');
  assert.equal(followed.body.playing, true);
  // A deliberate play intent starts from where it says, not from where the room
  // used to be.
  assert.ok(followed.body.positionMs >= 1500 && followed.body.positionMs < 1800,
    `it starts at the requested position (${followed.body.positionMs})`);

  const viewed = await req(`/api/rooms/${room.code}`, { jar: ana });
  assert.equal(viewed.body.track.videoId, 'aBcDeFgHiJk', 'everyone sees the new queue');
});

test('queue-set is a play intent: it validates, clamps and respects host-only control', async () => {
  const { body: room } = await create(ana, { control: 'host' });
  const joined = await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });

  const refused = await req(`/api/rooms/${room.code}/command`, {
    jar: ben, method: 'POST', body: { type: 'queue-set', queue: [TRACK('kJQP7kiw5Fk', 'x')] },
  });
  assert.equal(refused.status, 403, 'a member cannot move everyone’s playhead this way either');
  assert.equal(refused.body.code, 'HOST_ONLY');

  const empty = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'queue-set', queue: [] },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'NO_TRACK');

  const badIndex = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'queue-set', queue: [TRACK('kJQP7kiw5Fk', 'x')], index: 3 },
  });
  assert.equal(badIndex.status, 400);

  const junk = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'queue-set', queue: [{ videoId: 'nope' }, TRACK('kJQP7kiw5Fk', 'ok')] },
  });
  assert.equal(junk.status, 200);
  assert.equal(junk.body.queue.length, 1, 'unusable entries are dropped, not fatal');
});

// ── private rooms and invites ──────────────────────────────────────────

test('a private room is invisible to the uninvited, and an invite is the only door', async () => {
  const { body: room } = await create(ana, { visibility: 'private' });

  const hidden = await req(`/api/rooms/${room.code}`, { jar: ben });
  assert.equal(hidden.status, 403);
  assert.equal(hidden.body.code, 'PRIVATE');
  assert.equal(hidden.body.state, undefined, 'the refusal does not carry the track');

  const refused = await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  assert.equal(refused.status, 403);

  // A member cannot invite.
  const notHost = await req(`/api/rooms/${room.code}/invite`, {
    jar: ben, method: 'POST', body: { name: 'carl' },
  });
  assert.equal(notHost.status, 403);
  assert.equal(notHost.body.code, 'HOST_ONLY');

  const people = await req(`/api/rooms/${room.code}/people?q=ben`, { jar: ana });
  assert.equal(people.status, 200);
  assert.ok(people.body.people.some((p) => p.name === 'ben'));

  const invited = await req(`/api/rooms/${room.code}/invite`, {
    jar: ana, method: 'POST', body: { name: 'ben' },
  });
  assert.equal(invited.status, 200);
  assert.ok(invited.body.invites.some((i) => i.name === 'ben'));

  const nowVisible = await req(`/api/rooms/${room.code}`, { jar: ben });
  assert.equal(nowVisible.status, 200);
  assert.equal(nowVisible.body.invited, true);

  const joined = await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  assert.equal(joined.status, 200);

  // Removing the invite after joining does not eject a member.
  const removed = await req(`/api/rooms/${room.code}/invite/${joined.body.members.find((m) => m.name === 'ben').id}`, {
    jar: ana, method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  const stillIn = await req(`/api/rooms/${room.code}/state`, { jar: ben });
  assert.equal(stillIn.status, 200);
});

test('host-only control blocks transport but keeps the queue collaborative', async () => {
  const { body: room } = await create(ana, { control: 'host' });
  const joined = await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  assert.equal(joined.status, 200);

  const pause = await req(`/api/rooms/${room.code}/command`, {
    jar: ben, method: 'POST', body: { type: 'pause', rev: joined.body.rev, positionMs: 1000 },
  });
  assert.equal(pause.status, 403);
  assert.equal(pause.body.code, 'HOST_ONLY');

  const suggest = await req(`/api/rooms/${room.code}/command`, {
    jar: ben, method: 'POST', body: { type: 'queue-add', track: TRACK('kJQP7kiw5Fk', 'Suggested') },
  });
  assert.equal(suggest.status, 200, 'a queue is a suggestion, not an interruption');

  const hostPause = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'pause', rev: suggest.body.rev, positionMs: 1000 },
  });
  assert.equal(hostPause.status, 200);

  const policy = await req(`/api/rooms/${room.code}`, {
    jar: ana, method: 'PATCH', body: { control: 'everyone', visibility: 'private' },
  });
  assert.equal(policy.status, 200);
  assert.equal(policy.body.control, 'everyone');
  assert.equal(policy.body.visibility, 'private');

  const notHost = await req(`/api/rooms/${room.code}`, {
    jar: ben, method: 'PATCH', body: { control: 'everyone' },
  });
  assert.equal(notHost.status, 403);
});

test('the member cap is enforced', async () => {
  const { body: room } = await create(ana);
  const joined = await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  assert.equal(joined.status, 200, 'host + ben fills a two-person room');
  const full = await req(`/api/rooms/${room.code}/join`, { jar: carl, method: 'POST' });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'FULL');
});

test('leaving removes the membership and the live stream', async () => {
  const { body: room } = await create(ana);
  await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  const leave = await req(`/api/rooms/${room.code}/leave`, { jar: ben, method: 'POST' });
  assert.equal(leave.status, 200);
  const view = await req(`/api/rooms/${room.code}`, { jar: ben });
  assert.equal(view.body.joined, false);
  assert.ok(!view.body.members.some((m) => m.name === 'ben'));
});

// ── the live stream ────────────────────────────────────────────────────

/** Read SSE chunks until `needle` appears or the budget runs out. */
async function readUntil(reader, decoder, state, needle, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !state.buf.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    state.buf += decoder.decode(value, { stream: true });
    if (state.buf.length > 200_000) state.buf = state.buf.slice(-100_000);
  }
  return state.buf.includes(needle);
}

test('the stream opens with a snapshot and pushes every accepted command', async () => {
  const { body: room } = await create(ana);
  await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });

  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/rooms/${room.code}/events`, {
    headers: { cookie: ben.header() },
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.match(res.headers.get('cache-control'), /no-cache/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { buf: '' };
  assert.ok(await readUntil(reader, decoder, state, 'event: snapshot'), 'opens with a full snapshot');
  assert.ok(state.buf.includes(`"code":"${room.code}"`));

  const seek = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'seek', positionMs: 12_345 },
  });
  assert.equal(seek.status, 200);
  assert.ok(await readUntil(reader, decoder, state, 'event: state'), 'a command is pushed to the other member');
  // Parse the event stream rather than matching a substring: the pushed
  // position is "as of now", so it is a few milliseconds past 12.345s.
  const pushed = [...state.buf.matchAll(/event: state\ndata: (.+)\n/g)]
    .map((m) => JSON.parse(m[1])).at(-1);
  assert.ok(pushed, 'the state event carries JSON');
  assert.equal(pushed.playing, true);
  assert.ok(pushed.positionMs >= 12_345 && pushed.positionMs < 12_545,
    `the pushed seek is at 12.3s (${pushed.positionMs})`);

  ac.abort();
});

test('ending a room stops it for everyone and closes the stream', async () => {
  const { body: room } = await create(ana);
  await req(`/api/rooms/${room.code}/join`, { jar: ben, method: 'POST' });
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/rooms/${room.code}/events`, {
    headers: { cookie: ben.header() }, signal: ac.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { buf: '' };
  await readUntil(reader, decoder, state, 'event: snapshot');

  const notHost = await req(`/api/rooms/${room.code}`, { jar: ben, method: 'DELETE' });
  assert.equal(notHost.status, 403);
  const ended = await req(`/api/rooms/${room.code}`, { jar: ana, method: 'DELETE' });
  assert.equal(ended.status, 200);

  assert.ok(await readUntil(reader, decoder, state, 'event: room'), 'the end is announced');
  const gone = await req(`/api/rooms/${room.code}`, { jar: ben });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, 'ENDED');
  const again = await req(`/api/rooms/${room.code}`, { jar: ana, method: 'DELETE' });
  assert.equal(again.status, 410);
  ac.abort();
});

// ── clock, landing pages, validation ───────────────────────────────────

test('the clock probe is the server\u2019s own time', async () => {
  const { body: room } = await create(ana);
  const { status, body } = await req(`/api/rooms/${room.code}/time`, { jar: ana });
  assert.equal(status, 200);
  assert.ok(Math.abs(body.now - Date.now()) < 5000);
});

test('the share page is public and does not leak a private room\u2019s track', async () => {
  const { body: pub } = await create(ana, { visibility: 'public' });
  const publicPage = await req(`/l/${pub.code}`);
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.body, /property="og:title"/);
  assert.ok(publicPage.body.includes('Room One'), 'a public room names what is playing');
  assert.ok(publicPage.body.includes(`/#/room/${pub.code}`), 'the page hands the visitor to the app');
  assert.doesNotMatch(publicPage.body, /<script[\s>]/i, 'the landing page must work without JavaScript');

  const { body: priv } = await create(ana, { visibility: 'private' });
  const privatePage = await req(`/l/${priv.code}`);
  assert.equal(privatePage.status, 200);
  assert.match(privatePage.body, /private listening room/i);
  assert.ok(!privatePage.body.includes('Room One'), 'a private room never names its track');
  assert.match(privatePage.body, /Open sonora/, 'the private page offers the app, not a join');
  assert.doesNotMatch(privatePage.body, /Join the room/);

  const missing = await req('/l/zzzzzzzzzz');
  assert.equal(missing.status, 404);
  const junk = await req('/l/not-a-code');
  assert.equal(junk.status, 404);
});

test('rooms are listed for members and invitees only', async () => {
  const { body: room } = await create(ana, { visibility: 'private' });
  const mine = await req('/api/rooms', { jar: ana });
  assert.ok(mine.body.rooms.some((r) => r.code === room.code && r.joined));

  const benBefore = await req('/api/rooms', { jar: ben });
  assert.ok(!benBefore.body.rooms.some((r) => r.code === room.code), 'a private room is not listed to a stranger');

  await req(`/api/rooms/${room.code}/invite`, { jar: ana, method: 'POST', body: { name: 'ben' } });
  const benAfter = await req('/api/rooms', { jar: ben });
  const entry = benAfter.body.rooms.find((r) => r.code === room.code);
  assert.ok(entry, 'an invite surfaces the room');
  assert.equal(entry.invited, true);
  assert.equal(entry.joined, false);
});

test('bad input is refused with a reason', async () => {
  const badCode = await req('/api/rooms/zzzzzzzzzz', { jar: ana });
  assert.equal(badCode.status, 404);
  const badVisibility = await req('/api/rooms', {
    jar: ana, method: 'POST', body: { visibility: 'secret', queue: [TRACK('dQw4w9WgXcQ', 'x')] },
  });
  assert.equal(badVisibility.status, 400);
  const { body: room } = await create(ana);
  const badCommand = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'teleport' },
  });
  assert.equal(badCommand.status, 400);
  const badSeek = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'seek' },
  });
  assert.equal(badSeek.status, 400);
});

test('health advertises the room surface', async () => {
  const { body } = await req('/api/health');
  assert.ok(body.features.includes('rooms'));
  assert.ok(body.features.includes('rooms-stream'));
  assert.ok(body.features.includes('rooms-guests'));
});

// ── anonymous listeners (a public room, no account) ────────────────────
// A public room is the one place audio needs no account. The security property
// under test is narrow and checkable: the guest cookie opens THIS room's state
// and the tracks in ITS queue, and nothing else. Everything else (commands,
// membership, the authenticated API, another video id) stays shut.

const guestJoin = async (code) => {
  const jar = new Jar();
  const r = await req(`/api/public/rooms/${code}/guest`, { jar, method: 'POST' });
  return { jar: r.status === 200 ? jar : null, ...r };
};

/** A ranged media GET answers 206; 200 is acceptable, 401 is the refusal. */
const streamStatus = async (jar, videoId) => {
  const res = await fetch(`${BASE}/api/stream/${videoId}`, {
    headers: jar ? { cookie: jar.header() } : {},
  });
  return res.status;
};

const served = (status) => status === 200 || status === 206;

test('a public room lets anyone with the link listen, with no account', async () => {
  const { body: room } = await create(ana, { visibility: 'public' });
  const { jar, status, body } = await guestJoin(room.code);
  assert.equal(status, 200);
  assert.equal(body.guest, true);
  assert.equal(body.joined, true);
  assert.equal(body.track.videoId, 'dQw4w9WgXcQ');
  // A guest is a listener, not a member with a name in the roster.
  assert.deepEqual(body.members, []);
  assert.ok(Number.isFinite(body.listeners));

  const state = await req(`/api/public/rooms/${room.code}/state`, { jar });
  assert.equal(state.status, 200);
  assert.ok(state.body.positionMs >= 5000);

  const time = await req(`/api/public/rooms/${room.code}/time`, { jar });
  assert.equal(time.status, 200);
  assert.ok(Math.abs(time.body.now - Date.now()) < 5000);
  assert.match(time.res.headers.get('set-cookie') ?? 'HttpOnly', /HttpOnly/);
});

test('guest audio is confined to the room’s queue', async () => {
  const { body: room } = await create(ana, { visibility: 'public' });
  const { jar } = await guestJoin(room.code);
  assert.ok(served(await streamStatus(jar, 'dQw4w9WgXcQ')), 'the current track plays');
  assert.ok(served(await streamStatus(jar, '9bZkp7q19f0')), 'a queued track plays');
  assert.equal(await streamStatus(jar, 'aBcDeFgHiJk'), 401, 'an arbitrary video id does not');
  assert.equal(await streamStatus(null, 'dQw4w9WgXcQ'), 401, 'no cookie at all does not');
});

test('a guest cannot command the room or reach the member API', async () => {
  const { body: room } = await create(ana, { visibility: 'public' });
  const { jar } = await guestJoin(room.code);
  const command = await req(`/api/rooms/${room.code}/command`, {
    jar, method: 'POST', body: { type: 'pause', positionMs: 1000 },
  });
  assert.equal(command.status, 401);
  const join = await req(`/api/rooms/${room.code}/join`, { jar, method: 'POST' });
  assert.equal(join.status, 401);
  const view = await req(`/api/rooms/${room.code}`, { jar });
  assert.equal(view.status, 401);
  const invites = await req(`/api/rooms/${room.code}/people?q=ana`, { jar });
  assert.equal(invites.status, 401);
});

test('a guest stream carries no roster, and follows the host', async () => {
  const { body: room } = await create(ana, { visibility: 'public' });
  const { jar } = await guestJoin(room.code);
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/public/rooms/${room.code}/events`, {
    headers: { cookie: jar.header() }, signal: ac.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { buf: '' };
  assert.ok(await readUntil(reader, decoder, state, 'event: snapshot'), 'opens with a snapshot');
  const first = JSON.parse(state.buf.match(/event: snapshot\ndata: (.+)\n/)[1]);
  assert.deepEqual(first.members, [], 'no names reach a guest');
  assert.ok(first.listeners >= 1, 'but the guest is counted');

  const moved = await req(`/api/rooms/${room.code}/command`, {
    jar: ana, method: 'POST', body: { type: 'seek', positionMs: 21_000 },
  });
  assert.equal(moved.status, 200);
  assert.ok(await readUntil(reader, decoder, state, 'event: state'), 'the change is pushed');
  const pushed = [...state.buf.matchAll(/event: state\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1])).at(-1);
  assert.ok(pushed.positionMs >= 21_000 && pushed.positionMs < 21_200, `as of now (${pushed.positionMs})`);

  assert.ok(await readUntil(reader, decoder, state, 'event: members'), 'presence arrives');
  const presence = [...state.buf.matchAll(/event: members\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1])).at(-1);
  assert.deepEqual(presence.members, [], 'presence events carry no names either');
  assert.ok(presence.guests >= 1);
  assert.ok(!state.buf.includes('"role":') && !state.buf.includes('"online":'), 'no roster internals');
  ac.abort();
});

test('there is no anonymous way into a private room', async () => {
  const { body: room } = await create(ana, { visibility: 'private' });
  const refused = await guestJoin(room.code);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'PRIVATE');
  const noCookie = await req(`/api/public/rooms/${room.code}/state`);
  assert.equal(noCookie.status, 403);
  assert.equal(noCookie.body.code, 'NO_GUEST');
  const live = await req(`/l/${room.code}/live`);
  assert.equal(live.status, 403);
  assert.match(live.body, /private/i);
  const unknown = await req('/l/zzzzzzzzzz/live');
  assert.equal(unknown.status, 404);
});

test('making a room private revokes its guests’ streams and audio', async () => {
  const { body: room } = await create(ana, { visibility: 'public' });
  const { jar } = await guestJoin(room.code);
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/public/rooms/${room.code}/events`, {
    headers: { cookie: jar.header() }, signal: ac.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { buf: '' };
  await readUntil(reader, decoder, state, 'event: snapshot');
  assert.ok(served(await streamStatus(jar, 'dQw4w9WgXcQ')), 'audio before the change');

  const flipped = await req(`/api/rooms/${room.code}`, {
    jar: ana, method: 'PATCH', body: { visibility: 'private' },
  });
  assert.equal(flipped.status, 200);
  assert.ok(await readUntil(reader, decoder, state, 'event: room'), 'the guest is told');
  assert.match(state.buf, /"removed":true/);

  const after = await req(`/api/public/rooms/${room.code}/state`, { jar });
  assert.equal(after.status, 403);
  assert.equal(await streamStatus(jar, 'dQw4w9WgXcQ'), 401, 'and the audio stops');
  ac.abort();
});

test('the room link offers a listener page that needs no session', async () => {
  const { body: room } = await create(ana, { visibility: 'public' });
  const landing = await req(`/l/${room.code}`);
  assert.equal(landing.status, 200);
  assert.match(landing.body, /Listen live/);
  assert.ok(landing.body.includes(`/l/${room.code}/live`), 'the landing leads to it');
  assert.match(landing.body, /No account is needed to listen/);

  const live = await req(`/l/${room.code}/live`);
  assert.equal(live.status, 200);
  assert.ok(live.body.includes('/listen.js'), 'it loads the sync engine');
  assert.ok(live.body.includes('Room One'), 'and renders the track server-side');
  assert.ok(!live.body.includes('sonora_uid'), 'and asks for no session');
});

test('the listener page is a whole room, not a bare player, before any script runs', async () => {
  const queue = [
    TRACK('dQw4w9WgXcQ', 'First Up', 100),
    TRACK('9bZkp7q19f0', 'Second Up', 200),
    TRACK('kJQP7kiw5Fk', 'Third Up', 300),
    TRACK('fAuT8_dboWo', 'Fourth Up', 400),
  ];
  const { body: room } = await create(ana, { queue, index: 2, positionMs: 20_000, playing: true });
  const live = await req(`/l/${room.code}/live`);
  assert.equal(live.status, 200);
  const html = live.body;

  // The running order is in the document, not in a spinner: a listener with a
  // slow phone reads what is playing and what follows immediately.
  assert.ok(html.includes('id="listen-queue"'), 'there is a queue');
  assert.match(html, /class="q-row is-now"[\s\S]*?Third Up/, 'the current track heads it');
  assert.match(html, /Track 3 of 4/, 'and the position in the set is stated');
  assert.match(html, /1 up next/, 'the header counts what follows');
  // 20s into a 300s track plus one 400s track = 11 minutes left.
  assert.match(html, /11 min left/, 'and estimates the time remaining');
  assert.ok(html.includes('Fourth Up'), 'the upcoming tracks are listed');
  assert.match(html, /Played earlier[\s\S]*?Second Up/, 'and what already played is recoverable');

  // The room's facts, so the page is a room and not a mystery stream.
  assert.match(html, /id="listen-room-host">ana</, 'the host is named');
  assert.match(html, /id="listen-room-control">Everyone</, 'the control policy is stated');
  assert.ok(html.includes('id="listen-room-started"'), 'and how long the room has been open');
  assert.ok(html.includes('id="listen-copy"'), 'the link is shareable from the page itself');
  assert.ok(html.includes('id="listen-next-up"'), 'and the next track has a slot on the player side');
  assert.match(html, /Up next/, 'labelled as such');
});

test('a private room’s listener page never exists, so its queue never leaks', async () => {
  const { body: room } = await create(ana, { visibility: 'private' });
  const live = await req(`/l/${room.code}/live`);
  assert.equal(live.status, 403);
  assert.ok(!live.body.includes('Room One'), 'not even the track name');
  const landing = await req(`/l/${room.code}`);
  assert.equal(landing.status, 200);
  assert.ok(!landing.body.includes('Room One'), 'the landing is a wall too');
  assert.match(landing.body, /private/i);
});
