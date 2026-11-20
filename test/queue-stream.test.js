import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer, loginCookie } from './helpers/ux.js';
import { planIds, planTrackIds, planStarts, planTotalMs, locate, planOffsetFor, streamSrc, freezesWhenHidden } from '../public/queue-stream.js';
import {
  concatSlice, openQueueStream, ensureSegment, maybeReposition, closeQueueStreams,
} from '../src/queue-stream.js';
import { audioPath } from '../src/audio.js';
import { config } from '../src/config.js';

// The queue as one continuous stream.
//
// This is the only playback shape that survives an iPhone locking its screen:
// the media process keeps playing the resource it was given while the page's
// script is suspended, so the next track has to already be inside that
// resource. (PLAN.md finding #6 has the device evidence; public/queue-stream.js
// and src/queue-stream.js carry the argument.)
//
// Three things are worth proving and nothing else here is:
//   1. the mapping — which ids go into a plan, and where a stream position
//      lands — because getting that wrong rejoins the player on the wrong
//      track at the wrong second;
//   2. the plan/stream routes: auth, ownership, and an unknown token;
//   3. that ffmpeg really produces one playable stream whose length is the plan
//      from the requested offset, with the list repeated so it never runs out.

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// ── 1. the mapping (pure) ───────────────────────────────────────────────

const q = (...ids) => ids.map((videoId) => ({ videoId }));

test('a plan is the queue from the playhead, wrapped once', () => {
  const queue = q('aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc');
  assert.deepEqual(planIds(queue, 1), ['bbbbbbbbbbb', 'ccccccccccc', 'aaaaaaaaaaa']);
  assert.deepEqual(planIds(queue, 0, { limit: 2 }), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.deepEqual(planIds([], 0), []);
  // A tracked entry with no id is skipped rather than poisoning the list.
  assert.deepEqual(planIds([{ videoId: 'aaaaaaaaaaa' }, {}, { videoId: 'bbbbbbbbbbb' }], 0),
    ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('every playback mode gets a plan, not only queue order', () => {
  const queue = q('aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc');
  // Queue order is the default.
  assert.deepEqual(planTrackIds({ queue, index: 1 }), ['bbbbbbbbbbb', 'ccccccccccc', 'aaaaaaaaaaa']);
  // Repeat-one: the one track, which the server loops — that is repeat-one.
  assert.deepEqual(planTrackIds({ queue, index: 1, repeatOne: true }), ['bbbbbbbbbbb']);
  // Shuffle: the current track first (the stream starts where the listener is),
  // then the rest in a random order — with no track lost and none repeated.
  const shuffled = planTrackIds({ queue, index: 1, shuffle: true, random: () => 0.4 });
  assert.equal(shuffled[0], 'bbbbbbbbbbb');
  assert.deepEqual([...shuffled].sort(), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  // A single-track queue is a one-entry plan in every mode.
  const one = q('aaaaaaaaaaa');
  assert.deepEqual(planTrackIds({ queue: one, index: 0 }), ['aaaaaaaaaaa']);
  assert.deepEqual(planTrackIds({ queue: one, index: 0, shuffle: true }), ['aaaaaaaaaaa']);
  assert.deepEqual(planTrackIds({ queue: one, index: 0, repeatOne: true }), ['aaaaaaaaaaa']);
  // Nothing playable: no plan.
  assert.deepEqual(planTrackIds({ queue: [], index: 0 }), []);
  assert.deepEqual(planTrackIds({ queue: [{}], index: 0 }), []);
});

test('a stream position maps back to the right track and offset', () => {
  const tracks = [
    { videoId: 'aaaaaaaaaaa', durationMs: 10_000 },
    { videoId: 'bbbbbbbbbbb', durationMs: 20_000 },
    { videoId: 'ccccccccccc', durationMs: 15_000 },
  ];
  assert.deepEqual(planStarts(tracks), [0, 10_000, 30_000]);
  assert.equal(planTotalMs(tracks), 45_000);

  assert.deepEqual(locate(tracks, 0), { index: 0, startMs: 0, offsetMs: 0, videoId: 'aaaaaaaaaaa' });
  assert.deepEqual(locate(tracks, 9_999), { index: 0, startMs: 0, offsetMs: 9_999, videoId: 'aaaaaaaaaaa' });
  assert.deepEqual(locate(tracks, 10_000), { index: 1, startMs: 10_000, offsetMs: 0, videoId: 'bbbbbbbbbbb' });
  assert.deepEqual(locate(tracks, 44_500), { index: 2, startMs: 30_000, offsetMs: 14_500, videoId: 'ccccccccccc' });
  // The stream loops the plan, so a position past one pass is the same track.
  assert.deepEqual(locate(tracks, 45_000), { index: 0, startMs: 0, offsetMs: 0, videoId: 'aaaaaaaaaaa' });
  assert.deepEqual(locate(tracks, 46_000), { index: 0, startMs: 0, offsetMs: 1_000, videoId: 'aaaaaaaaaaa' });
  assert.deepEqual(locate(tracks, -1_000), { index: 2, startMs: 30_000, offsetMs: 14_000, videoId: 'ccccccccccc' });
});

test('a track with no known length is never the answer', () => {
  const tracks = [
    { videoId: 'aaaaaaaaaaa', durationMs: 0 },
    { videoId: 'bbbbbbbbbbb', durationMs: 5_000 },
  ];
  assert.equal(locate(tracks, 0).videoId, 'bbbbbbbbbbb');
  assert.equal(locate([], 0), null);
  assert.equal(locate([{ videoId: 'aaaaaaaaaaa', durationMs: 0 }], 0), null);
  assert.equal(locate(tracks, Number.NaN).videoId, 'bbbbbbbbbbb');
});

test('a track maps to a position anywhere in the plan, not only its first entry', () => {
  const tracks = [
    { videoId: 'aaaaaaaaaaa', durationMs: 10_000 },
    { videoId: 'bbbbbbbbbbb', durationMs: 20_000 },
    { videoId: 'ccccccccccc', durationMs: 15_000 },
  ];
  assert.equal(planOffsetFor(tracks, 'aaaaaaaaaaa', 0), 0);
  assert.equal(planOffsetFor(tracks, 'aaaaaaaaaaa', 4_000), 4_000);
  assert.equal(planOffsetFor(tracks, 'bbbbbbbbbbb', 5_000), 15_000);
  assert.equal(planOffsetFor(tracks, 'ccccccccccc', 0), 30_000);
  // A playhead past the track's own length is clamped inside it, and an
  // unknown track has no position at all.
  assert.equal(planOffsetFor(tracks, 'aaaaaaaaaaa', 99_000), 9_999);
  assert.equal(planOffsetFor(tracks, 'zzzzzzzzzzz', 0), null);
  assert.equal(planOffsetFor([], 'aaaaaaaaaaa', 0), null);
  // Where it lands is where `locate` says: the two are inverses.
  const at = locate(tracks, planOffsetFor(tracks, 'bbbbbbbbbbb', 5_000));
  assert.equal(at.videoId, 'bbbbbbbbbbb');
  assert.equal(at.offsetMs, 5_000);
});

test('the stream url carries the offset the element starts at', () => {
  assert.equal(streamSrc('tok en', 12_345.6), '/api/queue-stream/tok%20en/live.m3u8?at=12346');
  assert.equal(streamSrc('t', -5), '/api/queue-stream/t/live.m3u8?at=0');
  assert.equal(streamSrc('t', 'nope'), '/api/queue-stream/t/live.m3u8?at=0');
});

test('only the platforms that stop running a hidden page arm the stream', () => {
  // Every other engine keeps delivering `timeupdate` to a hidden media element,
  // so the per-track handoff works there and swapping the source again would
  // only insert a gap.
  assert.equal(freezesWhenHidden('iPhone'), true);
  assert.equal(freezesWhenHidden('iPad'), true);
  for (const other of ['Android', 'Mac', 'Windows', 'Linux', 'this device', null, undefined]) {
    assert.equal(freezesWhenHidden(other), false, `${other} must keep the per-track handoff`);
  }
});

// ── 2. the concat list (ffmpeg's own format) ────────────────────────────

test('a concat slice starts and ends exactly where it is asked', () => {
  const tracks = [
    { videoId: 'aaaaaaaaaaa', durationMs: 6_000 },
    { videoId: 'bbbbbbbbbbb', durationMs: 6_000 },
  ];
  const lines = (from, to, opts) => concatSlice(tracks, from, to, opts).trim().split('\n');

  // Inside one entry: inpoint on it, nothing else.
  const f = (id) => `file '${audioPath(id)}'`;
  assert.deepEqual(lines(1500, null), [
    f('aaaaaaaaaaa'),
    'inpoint 1.500',
    f('bbbbbbbbbbb'),
  ]);
  // Spanning the seam: inpoint first, outpoint on the entry that holds the end.
  assert.deepEqual(lines(4000, 8000), [
    f('aaaaaaaaaaa'),
    'inpoint 4.000',
    f('bbbbbbbbbbb'),
    'outpoint 2.000',
  ]);
  // Zero offset writes no inpoint at all rather than `inpoint 0.000`.
  assert.equal(lines(0, null)[1].startsWith('file '), true);
  // The tail slice repeats the plan until it covers what was asked, and every
  // line is still a single-quoted `file` or a point directive.
  const tail = lines(6000, null, { repeatCoverMs: 20_000 });
  assert.ok(tail.length >= 6, `expected repeats, got ${tail.length} lines`);
  for (const line of tail) assert.match(line, /^(file '[^']*'|inpoint [\d.]+|outpoint [\d.]+)$/);
  // A slice that wraps the end of the plan continues at its beginning.
  assert.deepEqual(lines(9000, 3000), [
    f('bbbbbbbbbbb'),
    'inpoint 3.000',
    f('aaaaaaaaaaa'),
    'outpoint 3.000',
  ]);
});

// ── 3. the routes, against a real server ────────────────────────────────

let server;
let cookie;

before(async () => {
  server = await startServer({ env: { SONORA_QUEUE_COVER_MS: '600000' } });
  const audioDir = path.join(server.dir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  cookie = await loginCookie(server.base);
  if (!HAS_FFMPEG) return;
  // 8 s tracks for the plan/ownership tests; 45 s tracks for the window and
  // seek tests, whose timelines must be bigger than the playlist's grace.
  for (const id of ['qqq00000001', 'qqq00000002']) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart', path.join(audioDir, `${id}.m4a`)]);
  }
  for (const id of ['qqq00000003', 'qqq00000004']) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45', '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart', path.join(audioDir, `${id}.m4a`)]);
  }
});

after(async () => {
  await server?.stop();
});

const plan = (ids, opts = {}) => fetch(`${server.base}/api/queue-stream/plan`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? cookie }) },
  body: JSON.stringify({ ids }),
});

test('the playlist window follows the listener, not the wall clock', async (t) => {
  if (!HAS_FFMPEG) return t.skip('no ffmpeg available');
  const { token } = await (await plan(['qqq00000003', 'qqq00000004'])).json();
  const seqOf = (text) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? -1);
  const segsOf = (text) => [...text.matchAll(/seg\/(\d+)\.ts$/gm)].map((m) => Number(m[1]));
  const get = (q) => fetch(`${server.base}/api/queue-stream/${token}/live.m3u8${q}`, { headers: { cookie } });

  // Open at zero with k=1 and consume what the first playlist names: segment
  // fetches are the only position signal a locked phone sends.
  const first = await (await get('?at=0&k=1')).text();
  const firstSegs = segsOf(first);
  assert.ok(firstSegs.length >= 3, `a live playlist needs three segments: ${first}`);
  for (const n of firstSegs) {
    const r = await fetch(`${server.base}/api/queue-stream/${token}/seg/${n}.ts`, { headers: { cookie } });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  // A poll with the same k slides with consumption, never backwards.
  await new Promise((r) => setTimeout(r, 7000));
  const poll = await (await get('?at=0&k=1')).text();
  assert.ok(seqOf(poll) >= seqOf(first), 'the window must follow consumption');

  // A new k with a far `at` is a seek: the window jumps there, on demand, and
  // segments behind the new window are still fetchable (a backward seek).
  const seek = await (await get('?at=60000&k=2')).text();
  assert.ok(seqOf(seek) > seqOf(poll), `seek did not move the window: ${seqOf(seek)} <= ${seqOf(poll)}`);
  const back = await fetch(`${server.base}/api/queue-stream/${token}/seg/${firstSegs[0]}.ts`, { headers: { cookie } });
  assert.equal(back.status, 200, 'a backward seek lost its segments');
  await back.arrayBuffer();

  // A suspended listener keeps its window: after a silence longer than the
  // freeze tolerance, a poll must still list the segment it was inside.
  const atSeek = segsOf(seek);
  await new Promise((r) => setTimeout(r, 30_000));
  const wake = await (await get('?at=60000&k=2')).text();
  assert.equal(seqOf(wake), seqOf(seek), 'the window slid while nobody was listening');
  assert.ok(segsOf(wake).includes(atSeek[atSeek.length - 1]), 'the wake playlist lost the playhead segment');
  await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
});

test('planning needs a signed-in listener', async () => {
  const res = await plan(['qqq00000001'], { cookie: null });
  assert.equal(res.status, 401);
});

test('a plan only contains tracks that are actually playable', async (t) => {
  if (!HAS_FFMPEG) return t.skip('no ffmpeg available');
  // One cached id, one that was never downloaded: the plan is what can play
  // right now, never a cold download in the middle of a locked night.
  const res = await plan(['qqq00000001', 'qqq00000009', 'qqq00000002']);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tracks.length, 2);
  assert.deepEqual(body.tracks.map((x) => x.videoId), ['qqq00000001', 'qqq00000002']);
  // The duration is the file's own (the mapping depends on it), not the
  // catalogue's idea of the track.
  for (const track of body.tracks) assert.ok(Math.abs(track.durationMs - 8000) < 300, JSON.stringify(body.tracks));
  assert.equal(typeof body.token, 'string');
  assert.ok(body.token.length > 16);

  const nothing = await plan(['qqq00000009']);
  assert.equal(nothing.status, 409);
  assert.equal((await nothing.json()).code, 'EMPTY');
});

test('the stream is a live HLS session: playlist first, then real segments', async (t) => {
  if (!HAS_FFMPEG) return t.skip('no ffmpeg available');
  const { token } = await (await plan(['qqq00000001', 'qqq00000002'])).json();

  // The playlist is the entry point: live (no ENDLIST while the tail runs),
  // and it names segments that exist.
  const listRes = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=1000`, { headers: { cookie } });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  const list = await listRes.text();
  assert.match(list, /^#EXTM3U\n/);
  assert.match(list, /#EXT-X-MEDIA-SEQUENCE:0/);
  assert.ok(!list.includes('#EXT-X-ENDLIST'), 'a fresh session is live, not ended');
  const names = [...list.matchAll(/(seg\/\d+\.ts)$/gm)].map((m) => m[1]);
  assert.ok(names.length >= 2, `expected listed segments, got ${JSON.stringify(names)}`);

  // Each listed segment is a real, decodable MPEG-TS file, and the first ones
  // together cover at least the offset the listener joined at.
  let covered = 0;
  for (const name of names) {
    // The playlist lists URIs relative to its own directory
    // (/api/queue-stream/<token>/), i.e. `seg/N.ts` — exactly what a media
    // element resolves them against.
    const segRes = await fetch(`${server.base}/api/queue-stream/${token}/${name}`, { headers: { cookie } });
    assert.equal(segRes.status, 200, `${name} missing`);
    assert.equal(segRes.headers.get('content-type'), 'video/mp2t');
    // `no-store`, not `immutable`: a segment is immutable in content, but a
    // caching layer in front (the tunnel) that ever serves a partial copy would
    // pin that corruption for an hour.
    assert.match(segRes.headers.get('cache-control'), /no-store/);
    const bytes = Buffer.from(await segRes.arrayBuffer());
    assert.ok(bytes.length > 1000, `${name} is suspiciously small`);
    const file = path.join(server.dir, `probe-${name.replace(/\//g, '-')}`);
    fs.writeFileSync(file, bytes);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=format_name,duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    assert.match(probe.split(',')[0], /mpegts/, `${name} is not MPEG-TS: ${probe}`);
    covered += Math.round(Number.parseFloat(probe.split(',')[1]) * 1000);
  }
  assert.ok(covered >= 6000, `the first window covers only ${covered} ms`);

  // The window slides: a later playlist names later segments.
  await new Promise((r) => setTimeout(r, 7000));
  const later = await (await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=1000`, { headers: { cookie } })).text();
  const firstSeq = (text) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0);
  assert.ok(later.includes('#EXTM3U'));
  assert.ok(firstSeq(later) >= firstSeq(list), 'the window must not move backwards');

  // Ownership still holds on both routes.
  const anonList = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`);
  assert.equal(anonList.status, 401);
  const anonSeg = await fetch(`${server.base}/api/queue-stream/${token}/seg/0.ts`);
  assert.equal(anonSeg.status, 401);
  const foreign = await fetch(`${server.base}/api/queue-stream/not-a-token/live.m3u8`, { headers: { cookie } });
  assert.equal(foreign.status, 404);
  const foreignSeg = await fetch(`${server.base}/api/queue-stream/not-a-token/seg/0.ts`, { headers: { cookie } });
  assert.equal(foreignSeg.status, 404);
  assert.equal(foreignSeg.status, 404);
  // The session holds an ffmpeg slot until the 120 s idle sweeper reaps it;
  // later tests open their own and the per-user cap counts them, so end this
  // one the way the app does when it leaves the stream.
  await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
});

test('a seek repositions the window; polls ride what the listener consumed', async (t) => {
  if (!HAS_FFMPEG) return t.skip('no ffmpeg available');
  const { token } = await (await plan(['qqq00000003', 'qqq00000004'])).json();
  const seqOf = (text) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? -1);

  // Open at the start with k=1 and consume the first segments: that is the
  // only position signal a locked phone sends.
  const open = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0&k=1`, { headers: { cookie } });
  const first = await open.text();
  assert.equal(open.status, 200);
  const firstSegs = [...first.matchAll(/(seg\/(\d+)\.ts)$/gm)].map((m) => Number(m[2]));
  for (const n of firstSegs) {
    const r = await fetch(`${server.base}/api/queue-stream/${token}/seg/${n}.ts`, { headers: { cookie } });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  // A poll with the same k slides with consumption, not with the wall clock.
  await new Promise((r) => setTimeout(r, 7000));
  const poll = await (await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0&k=1`, { headers: { cookie } })).text();
  assert.ok(seqOf(poll) >= seqOf(first), 'the window must follow consumption');

  // A new k with a far `at` is a seek: the window jumps to it, and segments
  // behind the new window are still fetchable (a backward seek must work).
  const seek = await (await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=60000&k=2`, { headers: { cookie } })).text();
  assert.ok(seqOf(seek) > seqOf(poll), `seek did not move the window: ${seqOf(seek)} <= ${seqOf(poll)}`);
  const back = await fetch(`${server.base}/api/queue-stream/${token}/seg/${firstSegs[0]}.ts`, { headers: { cookie } });
  assert.equal(back.status, 200, 'a backward seek lost its segments');
  await back.arrayBuffer();

  // A suspended listener keeps its window: no fetches for longer than the
  // freeze tolerance, then a poll must still list the segment it was inside.
  await new Promise((r) => setTimeout(r, 30_000));
  const wake = await (await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=60000&k=2`, { headers: { cookie } })).text();
  assert.equal(seqOf(wake), seqOf(seek), 'the window slid while nobody was listening');
  await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
});

test('the per-user stream cap answers BUSY instead of stacking muxers', async (t) => {
  if (!HAS_FFMPEG) return t.skip('no ffmpeg available');
  // MAX_STREAMS_PER_USER is 4: a client that leaves and re-enters with fresh
  // plans (health-check reverts, seek fallbacks) used to stack ffmpeg sessions
  // until the 120 s idle sweeper caught up. The cap was declared but never
  // wired; the 429/BUSY branch it feeds was unreachable.
  // Earlier tests may hold slots (their cleanup is best-effort), so open
  // until the cap answers, then prove the refusal and the release.
  const tokens = [];
  let refusal = null;
  for (let i = 0; i < 5 && !refusal; i++) {
    const { token } = await (await plan(['qqq00000001'])).json();
    const res = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0`, { headers: { cookie } });
    if (res.status === 429) refusal = { res, token };
    else {
      assert.equal(res.status, 200, `opening stream ${i + 1} failed`);
      tokens.push(token);
    }
  }
  assert.ok(refusal, 'the per-user cap never answered within five opens');
  assert.equal(refusal.res.status, 429, 'the cap refused with something other than 429');
  assert.equal((await refusal.res.json()).code, 'BUSY');

  // Ending one session frees the slot for the next.
  const released = tokens.shift();
  await fetch(`${server.base}/api/queue-stream/${released}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
  const { token: retry } = await (await plan(['qqq00000001'])).json();
  const afterDelete = await fetch(`${server.base}/api/queue-stream/${retry}/live.m3u8?at=0`, { headers: { cookie } });
  assert.equal(afterDelete.status, 200, 'a freed slot was not reusable');
  tokens.push(retry);

  // Cleanup: the remaining sessions would otherwise hold muxers until the
  // idle sweeper reaps them.
  for (const token of tokens) {
    await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
  }
});

test('a client report needs a session and stays bounded', async () => {
  const post = (body, opts = {}) => fetch(`${server.base}/api/client-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? cookie }) },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ event: 'live-plan' }, { cookie: null })).status, 401);
  assert.equal((await post({ event: 'live-plan' })).status, 204);
  assert.equal((await post({ nope: true })).status, 400);
  assert.equal((await post({ event: 'x'.repeat(60) })).status, 400);
  // A report is a log line, not storage: an oversized body is refused rather
  // than written anywhere.
  assert.equal((await post({ event: 'live-plan', pad: 'x'.repeat(5000) })).status, 413);
});

test('a stream belongs to the listener who planned it', async () => {
  const { token } = await (await plan(['qqq00000001'])).json().catch(() => ({ token: null }));
  if (!token) return;
  const anonymous = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`);
  assert.equal(anonymous.status, 401);
  const unknown = await fetch(`${server.base}/api/queue-stream/not-a-token/live.m3u8`, { headers: { cookie } });
  assert.equal(unknown.status, 404);
  // HEAD is the app's availability probe: headers, no ffmpeg process.
  const head = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'HEAD', headers: { cookie } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  // The HEAD open holds an ffmpeg slot like any other; release it so the
  // per-user cap in later tests starts from this test's own zero.
  await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
});

test('DELETE ends a session so a skipper cannot stack them', async (t) => {
  if (!HAS_FFMPEG) return t.skip('no ffmpeg available');
  const { token } = await (await plan(['qqq00000001', 'qqq00000002'])).json();
  const first = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0`, { headers: { cookie } });
  assert.equal(first.status, 200);
  await first.text();
  const gone = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
  assert.equal(gone.status, 204);
  // The plan is still valid, so a new playlist request simply opens a fresh
  // session — the point is that the old one no longer holds a slot.
  const again = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0`, { headers: { cookie } });
  assert.equal(again.status, 200);
  await again.text();
  await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
});

test('the server survives a listener that hangs up mid-stream', async (t) => {
  if (!HAS_FFMPEG) return t.skip('no ffmpeg available');
  const { token } = await (await plan(['qqq00000001', 'qqq00000002'])).json();
  const ac = new AbortController();
  const res = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0`, { headers: { cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read();
  ac.abort();
  // A segment fetch that is abandoned mid-body must not wedge the session or
  // the process: the next request still answers.
  const segAc = new AbortController();
  const seg = await fetch(`${server.base}/api/queue-stream/${token}/seg/0.ts`, { headers: { cookie }, signal: segAc.signal });
  const segReader = seg.body.getReader();
  await segReader.read().catch(() => {});
  segAc.abort();
  const health = await fetch(`${server.base}/api/health`);
  assert.equal(health.status, 200);
  const again = await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0`, { headers: { cookie } });
  assert.equal(again.status, 200);
  await again.text();
});

// ── the audit fixes: bounded children, bounded disk, bounded plans ───────

// A fake pair of binaries, so the cut/eviction tests do not depend on ffmpeg:
// the cut writes a token file to whatever path it was given, and the probe
// reports five seconds for it.
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-queue-fixtures-'));
const fakeFfmpeg = path.join(fixtures, 'fake-ffmpeg.sh');
const fakeFfprobe = path.join(fixtures, 'fake-ffprobe.sh');
const hangFfmpeg = path.join(fixtures, 'hang-ffmpeg.sh');
fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\nfor last; do :; done\nprintf "fake-ts" > "$last"\n', { mode: 0o755 });
fs.writeFileSync(fakeFfprobe, '#!/bin/sh\necho 5.0\n', { mode: 0o755 });
fs.writeFileSync(hangFfmpeg, '#!/bin/sh\necho $$ >> "$SONORA_TEST_PIDFILE"\nsleep 60\n', { mode: 0o755 });
after(() => { try { fs.rmSync(fixtures, { recursive: true, force: true }); } catch {} });

const withBins = async (bins, fn) => {
  const previous = { FFMPEG_BIN: process.env.FFMPEG_BIN, FFPROBE_BIN: process.env.FFPROBE_BIN };
  Object.assign(process.env, bins);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const oneTrack = [{ videoId: 'aaaaaaaaaaa', durationMs: 30_000 }];

test('the cover window comes from config.queueCoverMs, with the env default retained', async () => {
  // A deployment profile can set the cover window without the process
  // environment; the module's own default must survive when it is undefined.
  const previousConfig = config.queueCoverMs;
  const previousEnv = process.env.SONORA_QUEUE_COVER_MS;
  try {
    config.queueCoverMs = 120_000;
    const covered = await openQueueStream(oneTrack, 0, 901);
    try {
      assert.equal(covered.session.coverEnd, 120_000, 'the configured window wins');
    } finally { await covered.cleanup(); }

    delete config.queueCoverMs;
    process.env.SONORA_QUEUE_COVER_MS = '60000';
    const fromEnv = await openQueueStream(oneTrack, 0, 901);
    try {
      assert.equal(fromEnv.session.coverEnd, 60_000, 'the environment fallback still works');
    } finally { await fromEnv.cleanup(); }

    delete process.env.SONORA_QUEUE_COVER_MS;
    const fallback = await openQueueStream(oneTrack, 0, 901);
    try {
      assert.equal(fallback.session.coverEnd, 24 * 60 * 60_000, 'the built-in day-long default remains');
    } finally { await fallback.cleanup(); }
  } finally {
    if (previousConfig === undefined) delete config.queueCoverMs;
    else config.queueCoverMs = previousConfig;
    if (previousEnv === undefined) delete process.env.SONORA_QUEUE_COVER_MS;
    else process.env.SONORA_QUEUE_COVER_MS = previousEnv;
  }
});

test('a session keeps its segment files bounded however far the client scrubs', async () => {
  await withBins({ FFMPEG_BIN: fakeFfmpeg, FFPROBE_BIN: fakeFfprobe }, async () => {
    const { session, cleanup } = await openQueueStream(oneTrack, 0, 902);
    try {
      // Pretend the listener scrubbed all over a day-long plan: the segment map
      // used to grow with how far it went, not with how long it listened.
      for (let seq = 1000; seq < 1246; seq += 1) {
        session.segMeta.set(seq, { startMs: seq * 6000, endMs: seq * 6000 + 6000 });
      }
      session.nowMs = 166 * 6000;
      const meta = await ensureSegment(session, 100);
      assert.ok(meta, 'the segment the listener actually wants is still produced');
      assert.ok(session.segMeta.size <= 240, `the session kept ${session.segMeta.size} segments`);
      assert.equal(session.segMeta.has(1245), false, 'the segment farthest from the playhead went first');
      assert.equal(session.segMeta.has(100), true, 'the segment just produced is kept');
    } finally { await cleanup(); }
  });
});

test('a cut that finishes during a seek cannot revive a stale segment', async () => {
  await withBins({ FFMPEG_BIN: fakeFfmpeg, FFPROBE_BIN: fakeFfprobe }, async () => {
    const { session, cleanup } = await openQueueStream(oneTrack, 0, 903);
    const fsp = (await import('node:fs/promises')).default;
    const original = fsp.rename;
    let repositioned = 0;
    try {
      // The seek lands exactly in the window the old code could not see: after
      // the pre-rename generation check, before the file has its serving name.
      fsp.rename = async (from, to) => {
        if (!repositioned) {
          repositioned += 1;
          maybeReposition(session, 20_000, 'seek-after-cut');
        }
        return original(from, to);
      };
      const meta = await ensureSegment(session, 20);
      assert.equal(repositioned, 1, 'the seek really did interrupt the cut');
      assert.equal(meta, null, 'a cut from the old anchor is not served');
      assert.equal(session.segMeta.has(20), false, 'and it is not remembered as available');
      assert.equal(fs.existsSync(path.join(session.dir, 'seg000020.ts')), false,
        'the stale segment file was unlinked after the rename');
    } finally {
      fsp.rename = original;
      await cleanup();
    }
  });
});

test('a hung ffmpeg is killed, its cut slot released, and shutdown cleans up', async () => {
  // A wedged child used to hold one of the six takeCutSlot() permits (and its
  // temp dir) forever: six of them stopped every stream on the host. The
  // deadline and the process-group kill are module-level settings, so this runs
  // in its own process, like the migration tests.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-queue-hang-'));
  const pidFile = path.join(dir, 'pids');
  const strayDir = path.join(os.tmpdir(), `sonora-queue-stray-${process.pid}-${Date.now()}`);
  const code = `
    import fs from 'node:fs';
    const qs = await import('./src/queue-stream.js');
    const tracks = [{ videoId: 'aaaaaaaaaaa', durationMs: 30000 }];
    const t0 = Date.now();
    const first = await qs.openQueueStream(tracks, 0, 1);
    const elapsed = Date.now() - t0;
    // A second session must still get cut permits: none may stay wedged.
    const t1 = Date.now();
    const second = await qs.openQueueStream(tracks, 0, 2);
    const elapsed2 = Date.now() - t1;
    const pids = fs.readFileSync(process.env.SONORA_TEST_PIDFILE, 'utf8').trim().split('\\n').filter(Boolean).map(Number);
    const reaped = (pid) => {
      try { process.kill(pid, 0); } catch { return true; }
      // A zombie still answers kill(0) until Node reaps it; it is dead either way.
      try { return /^\\d+ \\(.*\\) Z/.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch { return true; }
    };
    const alive = pids.filter((pid) => !reaped(pid));
    const before = [first.dir, second.dir].every((d) => fs.existsSync(d));
    fs.mkdirSync(process.env.SONORA_TEST_STRAY, { recursive: true });
    await qs.closeQueueStreams();
    const after = [first.dir, second.dir].map((d) => fs.existsSync(d));
    console.log('@@' + JSON.stringify({
      elapsed, elapsed2, pids: pids.length, alive, before, after,
      stray: fs.existsSync(process.env.SONORA_TEST_STRAY),
    }));
  `;
  const res = spawnSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      SONORA_DB: path.join(dir, 'queue.db'),
      SONORA_SECRET: 'queue-hang-test',
      SONORA_QUEUE_CHILD_TIMEOUT_MS: '250',
      FFMPEG_BIN: hangFfmpeg,
      SONORA_TEST_PIDFILE: pidFile,
      SONORA_TEST_STRAY: strayDir,
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed:\n${res.stdout}\n${res.stderr}`);
  const line = res.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `no @@ marker:\n${res.stdout}`);
  const got = JSON.parse(line.slice(2));
  assert.ok(got.pids > 0, 'the hung children really were spawned');
  assert.deepEqual(got.alive, [], 'every hung child was killed by the deadline');
  assert.ok(got.elapsed < 10_000, `a hung cut must not wedge the open for ${got.elapsed} ms`);
  assert.ok(got.elapsed2 < 10_000, `the permits were not released: second open took ${got.elapsed2} ms`);
  assert.equal(got.before, true);
  assert.deepEqual(got.after, [false, false], 'closeQueueStreams removed the session temp dirs');
  assert.equal(got.stray, false, 'and swept a leftover sonora-queue-* directory');
  assert.equal(fs.existsSync(strayDir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a re-planning client cannot evict a live stream, only its own stale plans', async () => {
  // The plan map used to evict the globally oldest token, so a client that
  // re-planned in a loop could delete another listener's plan — including the
  // one its own playing stream was opened from.
  const planToken = async () => (await (await plan(['qqq00000001', 'qqq00000002'])).json()).token;
  const status = async (token) => (await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8?at=0`, { headers: { cookie } })).status;
  const live = await planToken();
  assert.equal(await status(live), 200, 'the first plan opens');
  const stale = [];
  for (let i = 0; i < 5; i++) stale.push(await planToken());
  // Creating one more plan runs the ceiling: the live plan must be skipped and
  // the oldest stale one evicted instead.
  const newest = await planToken();
  assert.equal(await status(live), 200, 'a live session’s plan survives re-planning elsewhere');
  assert.equal(await status(newest), 200, 'the newest plan is usable');
  const gone = await status(stale[0]);
  assert.equal(gone, 404, 'the oldest stale plan of the same account was reclaimed');
  for (const token of [live, newest]) {
    await fetch(`${server.base}/api/queue-stream/${token}/live.m3u8`, { method: 'DELETE', headers: { cookie } });
  }
});
