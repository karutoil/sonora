import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The audio cache is the one part of the data layer that owns files as well as
// rows, and everything that can go wrong there is a failure mode: a killed
// download that leaves a temp file nothing ever revisits, two requests for one
// track spawning two yt-dlp processes, or LRU eviction deleting the file a
// listener is streaming right now.
//
// yt-dlp is replaced by a script, so none of this touches the network.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-audio-'));
const audioDir = path.join(dir, 'audio');
const counter = path.join(dir, 'runs.log');
const argvLog = path.join(dir, 'argv.log');
const fakeYtdlp = path.join(dir, 'fake-yt-dlp.mjs');

// The fake models what the real binary observably does — including the temp-name
// handling that broke every cold download:
//
//  * given `-o <file>` it streams to `<file>.part` and renames it at the end, so
//    an interrupted download never looks finished (this is the shape the code
//    must rely on);
//  * given an output name that *ends* in `.part` it strips that suffix (yt-dlp's
//    `undo_temp_name`), writes `<file>`, and then exits 1 from the m4a fixup
//    because the temp path it asks for does not exist. The previous argv
//    (`--no-part` + `-o <file>.part`) hit exactly this, so the download always
//    reported failure while a complete file sat in the cache and `/api/stream`
//    answered 502;
//  * it writes its cookie jar back over the `--cookies` file on exit, which is
//    why children must not share one.
fs.writeFileSync(fakeYtdlp, `#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

fs.appendFileSync(process.env.SONORA_TEST_ARGV, args.join(' ') + '\\n');
fs.appendFileSync(process.env.SONORA_TEST_COUNTER, 'run\\n');

// A 16-byte ISO BMFF header + filler = 8192 bytes, like a real .m4a.
const track = () => {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16, 0);
  head.write('ftypM4A ', 4, 'latin1');
  return Buffer.concat([head, crypto.randomBytes(8176)]);
};

const jar = opt('--cookies');
if (jar) fs.appendFileSync(jar, '# yt-dlp writes its jar back here\\n');

const out = opt('-o');
const delayMs = Number(process.env.SONORA_TEST_DELAY_MS || 0);
if (Number.isFinite(delayMs) && delayMs > 0) await delay(delayMs);
if (process.env.SONORA_TEST_FAIL === '1') {
  console.error('ERROR: [youtube] extractor blew up');
  process.exit(1);
}
if (process.env.SONORA_TEST_NOTMP4 === '1') {
  // A WebM/Opus stream: yt-dlp would still name the file .m4a and exit 0.
  fs.writeFileSync(out, crypto.randomBytes(8192));
  process.exit(0);
}
if (process.env.SONORA_TEST_EXIT1_AFTER_WRITE === '1') {
  // Complete audio, then a postprocessor failure: the real shape of the bug.
  fs.writeFileSync(out + '.part', track());
  fs.renameSync(out + '.part', out);
  console.error('ERROR: Postprocessing: ' + out + '.part: No such file or directory');
  process.exit(1);
}
if (out.endsWith('.part')) {
  // undo_temp_name: the suffix is stripped, so the download lands at <file>…
  const final = out.slice(0, -'.part'.length);
  fs.writeFileSync(final, track());
  // …and the m4a fixup then looks for the temp path and fails.
  console.error('ERROR: Postprocessing: ' + out + ': No such file or directory');
  process.exit(1);
}
fs.writeFileSync(out + '.part', track());
fs.renameSync(out + '.part', out);
if (process.env.SONORA_TEST_HANG_AFTER_WRITE === '1') {
  const keepAlive = setInterval(() => {}, 1000);
  await new Promise(() => {});
  clearInterval(keepAlive);
}
`, { mode: 0o755 });

process.env.SONORA_DB = path.join(dir, 'audio.db');
process.env.SONORA_AUDIO_DIR = audioDir;
process.env.SONORA_SECRET = 'audio-test';
process.env.SONORA_YTDLP = fakeYtdlp;
process.env.SONORA_TEST_COUNTER = counter;
process.env.SONORA_TEST_ARGV = argvLog;
// A 1 MiB ceiling, so "the budget is enforced where bytes are added" is provable
// with a few hundred 8 KiB files.
process.env.SONORA_CACHE_MB = '1';

const audio = await import('../src/audio.js');

const runs = () => {
  try {
    return fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

const lastArgv = () => fs.readFileSync(argvLog, 'utf8').trim().split('\n').pop().split(' ');

const backdate = (file, ms) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
};

after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('a download lands under the real name and leaves no temp file', async () => {
  const meta = await audio.ensureAudio('aaaaaaaaaaa');
  assert.equal(meta.size, 8192);
  assert.equal(meta.file, audio.audioPath('aaaaaaaaaaa'));
  assert.ok(fs.existsSync(meta.file), 'the finished file is in place');
  assert.equal(fs.existsSync(`${meta.file}.part`), false, 'no temp file survives a success');
  assert.equal(runs(), 1);

  // Regression guard for the cold-download bug: yt-dlp is given the *final*
  // path and owns the temp name. Either mistake (a `.part` suffix here, or
  // `--no-part`) makes the real binary rename the file itself and then exit 1.
  const argv = lastArgv();
  const out = argv[argv.indexOf('-o') + 1];
  assert.equal(out, audio.audioPath('aaaaaaaaaaa'), 'yt-dlp is handed the final path');
  assert.equal(out.endsWith('.part'), false, 'never hand yt-dlp a temp name it will strip');
  assert.equal(argv.includes('--no-part'), false, 'yt-dlp owns its temp name');
  assert.ok(argv.includes('--no-continue'), 'a stale fragment must not be resumed');
});

test('a cached track is served without another download', async () => {
  const meta = await audio.ensureAudio('aaaaaaaaaaa');
  assert.equal(meta.size, 8192);
  assert.equal(runs(), 1, 'the second request did not spawn yt-dlp');
});

test('two requests for the same track share one yt-dlp process', async () => {
  const first = audio.ensureAudio('bbbbbbbbbbb');
  const second = audio.ensureAudio('bbbbbbbbbbb');
  assert.equal(first, second, 'the second call joins the in-flight download');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.size, b.size);
  assert.equal(runs(), 2, 'one more process, not two');
});

test('a failed download removes its temp file', async () => {
  process.env.SONORA_TEST_FAIL = '1';
  try {
    await assert.rejects(audio.ensureAudio('ccccccccccc'), /yt-dlp exited 1/);
  } finally {
    delete process.env.SONORA_TEST_FAIL;
  }
  assert.equal(fs.existsSync(audio.audioPath('ccccccccccc')), false, 'nothing is cached');
  assert.equal(fs.existsSync(`${audio.audioPath('ccccccccccc')}.part`), false, 'no temp file leaks');
  assert.deepEqual(
    fs.readdirSync(audioDir).filter((n) => n.includes('ccccccccccc')),
    [],
    'the video id left no trace at all',
  );
});

// The exact failure mode of the old code: yt-dlp exits non-zero while a complete,
// valid track is already on disk. Discarding it loses the song; using it is
// right. This also protects against a future version where a postprocessor fails
// after a successful download.
test('a download that exits non-zero after writing the whole file is still used', async () => {
  process.env.SONORA_TEST_EXIT1_AFTER_WRITE = '1';
  let meta;
  try {
    meta = await audio.ensureAudio('ddddddddddd');
  } finally {
    delete process.env.SONORA_TEST_EXIT1_AFTER_WRITE;
  }
  assert.equal(meta.size, 8192);
  assert.ok(fs.existsSync(meta.file), 'the complete file is kept');
  assert.equal(fs.existsSync(`${meta.file}.part`), false);
  // and it is a cache hit from now on, not a re-download
  assert.equal((await audio.ensureAudio('ddddddddddd')).size, 8192);
});

test('a truncated file is a miss, and the fragment is cleaned up', async () => {
  const file = audio.audioPath('ggggggggggg');
  fs.writeFileSync(file, Buffer.alloc(10));
  assert.equal(await audio.cachedAudio('ggggggggggg'), null);
  assert.equal(fs.existsSync(file), false, 'the next request re-downloads instead of serving 10 bytes');
});

// A killed download leaves `<file>.part` behind, and yt-dlp would happily resume
// into it — but googlevideo 403s every non-zero offset, so a resumed download
// burns all three retries and fails. The fragment must go before the next try,
// even though the sweep would not touch it (it is seconds old).
test('a leftover .part from a killed download is cleared before the next attempt', async () => {
  const stale = `${audio.audioPath('eeeeeeeeeee')}.part`;
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(stale, Buffer.alloc(4096));
  const meta = await audio.ensureAudio('eeeeeeeeeee');
  assert.equal(meta.size, 8192);
  assert.equal(fs.existsSync(stale), false, 'the fragment did not survive the download');
});

// A WebM/Opus stream cached under an `.m4a` name is served as `audio/mp4` and
// never plays on Safari — permanently, because the cache then says it is there.
test('a download that is not MP4 audio is rejected instead of cached', async () => {
  process.env.SONORA_TEST_NOTMP4 = '1';
  try {
    await assert.rejects(audio.ensureAudio('fffffffffff'), /not MP4 audio/);
  } finally {
    delete process.env.SONORA_TEST_NOTMP4;
  }
  assert.deepEqual(
    fs.readdirSync(audioDir).filter((n) => n.includes('fffffffffff')),
    [],
    'an unplayable container leaves nothing behind',
  );
});

// yt-dlp truncates and rewrites the file given to --cookies on exit. Sharing one
// jar between children corrupts it, and a child started before an import flushes
// its stale copy over the fresh one — bot gate until the next restart.
test('each download gets a private cookie jar, so the stored one cannot be clobbered', async () => {
  const stored = path.join(dir, 'youtube-cookies.txt');
  const jar = '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tshared-jar\n';
  fs.writeFileSync(stored, jar, { mode: 0o600 });

  const meta = await audio.ensureAudio('hhhhhhhhhhh');
  assert.equal(meta.size, 8192);

  const argv = lastArgv();
  const used = argv[argv.indexOf('--cookies') + 1];
  assert.ok(used, 'the jar is passed to yt-dlp');
  assert.notEqual(used, stored, 'the child did not get the stored jar itself');
  assert.match(path.basename(used), /^\.ytdlp-cookies-[0-9a-f]+\.txt$/, 'a private copy');

  assert.equal(fs.readFileSync(stored, 'utf8'), jar, 'the stored jar was not written back to');
  assert.deepEqual(
    fs.readdirSync(audioDir).filter((n) => n.startsWith('.ytdlp-cookies-')),
    [],
    'the private copy is deleted after the run',
  );
  fs.unlinkSync(stored);
});

test('eviction drops the least recently used files and spares a fresh one', async () => {
  // Two files touched just now (the downloads above are inside the grace
  // window), plus three new ones: two old, one fresh. Only the old ones may go.
  const old1 = path.join(audioDir, 'iiiiiiiiiig.m4a');
  const old2 = path.join(audioDir, 'iiiiiiiiiih.m4a');
  const fresh = path.join(audioDir, 'iiiiiiiiiif.m4a');
  for (const f of [old1, old2, fresh]) fs.writeFileSync(f, Buffer.alloc(8192));
  backdate(old1, 4 * 3_600_000);
  backdate(old2, 2 * 3_600_000);

  const result = await audio.pruneCacheTo(3 * 8192);
  assert.equal(result.removed, 2, 'only the two evictable files were removed');
  assert.equal(fs.existsSync(old1), false, 'the oldest file went first');
  assert.equal(fs.existsSync(old2), false);
  assert.ok(fs.existsSync(fresh), 'a file touched just now is never evicted');
  assert.ok(fs.existsSync(audio.audioPath('aaaaaaaaaaa')), 'nor is a track that may be streaming');
  assert.ok(result.bytes > 3 * 8192, 'grace wins over the budget: a stall is worse than a big cache');
});

test('a stale .part is swept even when nothing needs evicting', async () => {
  const stale = path.join(audioDir, 'jjjjjjjjjjj.m4a.part');
  const live = path.join(audioDir, 'kkkkkkkkkkk.m4a.part');
  fs.writeFileSync(stale, Buffer.alloc(4096));
  fs.writeFileSync(live, Buffer.alloc(4096));
  backdate(stale, 2 * 3_600_000);

  // A budget far above the cache size: the sweep is not eviction, it is hygiene.
  const result = await audio.pruneCacheTo(1e12);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(stale), false, 'a leftover from a killed download is removed');
  assert.ok(fs.existsSync(live), 'a download in progress keeps its temp file');
});

test('concurrent prunes are serialised, not interleaved', async () => {
  const results = await Promise.all([audio.pruneCacheTo(1e12), audio.pruneCacheTo(1e12)]);
  assert.equal(results.length, 2);
  for (const r of results) assert.equal(typeof r.bytes, 'number');
});

// The documented ceiling used to be enforced only at boot and from the admin
// button, so between those events the cache grew without bound and a full disk
// ended up failing SQLite writes too.
test('the configured cache budget is enforced by the next download', async () => {
  const budget = 1024 * 1024; // SONORA_CACHE_MB=1
  for (let i = 0; i < 200; i++) {
    const f = path.join(audioDir, `bulk-${String(i).padStart(4, '0')}.m4a`);
    fs.writeFileSync(f, Buffer.alloc(8192));
    backdate(f, 2 * 3_600_000); // outside the grace window, so evictable
  }
  const before = await audio.cacheStats();
  assert.ok(before.bytes > budget, `the cache starts over budget (${before.bytes} > ${budget})`);
  assert.equal(before.limitBytes, budget);

  const meta = await audio.ensureAudio('lllllllllll');
  assert.equal(meta.size, 8192);

  const after = await audio.cacheStats();
  assert.ok(after.bytes <= budget, `download brought the cache back under budget (${after.bytes} <= ${budget})`);
  assert.ok(fs.existsSync(meta.file), 'the track that was just downloaded survived the prune');

  for (const name of fs.readdirSync(audioDir)) {
    if (name.startsWith('bulk-')) fs.unlinkSync(path.join(audioDir, name));
  }
});

test('cache stats count temp files separately instead of hiding them', async () => {
  const stats = await audio.cacheStats();
  assert.equal(stats.dir, audioDir);
  assert.ok(stats.files >= 3);
  assert.equal(stats.bytes, stats.files * 8192, 'bytes only counts playable tracks');
  // the live `.part` from the sweep test is still there
  assert.ok(stats.partialFiles >= 1);
  assert.ok(stats.partialBytes >= 4096, 'a hidden fragment cannot inflate the panel usage');
});

test('deleting a track removes its temp file too', async () => {
  const file = audio.audioPath('mmmmmmmmmmm');
  fs.writeFileSync(file, Buffer.alloc(8192));
  fs.writeFileSync(`${file}.part`, Buffer.alloc(4096));
  assert.equal(await audio.removeCachedAudio('mmmmmmmmmmm'), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.part`), false, 'the fragment went with the track');
  assert.equal(await audio.removeCachedAudio('mmmmmmmmmmm'), false, 'nothing left to remove');
});

test('clearing the cache removes the leftovers as well as the tracks', async () => {
  const partial = path.join(audioDir, 'nnnnnnnnnnn.m4a.part');
  fs.writeFileSync(partial, Buffer.alloc(4096));
  const result = await audio.clearCache();
  assert.ok(result.removed >= 1);
  assert.deepEqual(
    fs.readdirSync(audioDir).filter((n) => n.endsWith('.m4a') || n.endsWith('.part')),
    [],
    'delete-all leaves no bytes behind',
  );
  const stats = await audio.cacheStats();
  assert.equal(stats.files, 0);
  assert.equal(stats.bytes, 0);
  assert.equal(stats.partialFiles, 0);
});

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(5);
  }
};

const waitForRuns = (count) => waitFor(() => runs() >= count, `yt-dlp run ${count}`);
const rejectsAborted = (promise) => assert.rejects(promise, (err) => {
  assert.equal(err?.code, 'ABORTED');
  assert.equal(err?.name, 'AbortError');
  return true;
});

test('aborting the original caller does not cancel a joined subscriber', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '150';
  const firstController = new AbortController();
  const secondController = new AbortController();
  const before = runs();
  try {
    const first = audio.ensureAudio('ooooooooooo', { signal: firstController.signal });
    const second = audio.ensureAudio('ooooooooooo', { signal: secondController.signal });
    await waitForRuns(before + 1);
    firstController.abort();
    await rejectsAborted(first);
    const meta = await second;
    assert.equal(meta.size, 8192);
    assert.equal(runs(), before + 1, 'the survivor used the original child');
    assert.ok(fs.statSync(meta.file).isFile());
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
    firstController.abort();
    secondController.abort();
  }
});

test('aborting a joined caller does not cancel the original subscriber', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '150';
  const firstController = new AbortController();
  const secondController = new AbortController();
  const before = runs();
  try {
    const first = audio.ensureAudio('ppppppppppp', { signal: firstController.signal });
    const second = audio.ensureAudio('ppppppppppp', { signal: secondController.signal });
    await waitForRuns(before + 1);
    secondController.abort();
    await rejectsAborted(second);
    const meta = await first;
    assert.equal(meta.size, 8192);
    assert.equal(runs(), before + 1);
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
    firstController.abort();
    secondController.abort();
  }
});

test('a no-signal warm pins shared work until settlement', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '150';
  const stream = new AbortController();
  const before = runs();
  try {
    const playback = audio.ensureAudio('qqqqqqqqqqq', { signal: stream.signal });
    const warm = audio.ensureAudio('qqqqqqqqqqq');
    assert.notEqual(playback, warm, 'the stream has an independent subscription');
    await waitForRuns(before + 1);
    stream.abort();
    await rejectsAborted(playback);
    const meta = await warm;
    assert.equal(meta.size, 8192, 'the warm still receives the completed download');
    assert.equal(runs(), before + 1);
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
    stream.abort();
  }
});

test('the last departing subscriber kills work and a later request can retry', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '250';
  const firstController = new AbortController();
  const secondController = new AbortController();
  const id = 'rrrrrrrrrrr';
  const file = audio.audioPath(id);
  const before = runs();
  try {
    const first = audio.ensureAudio(id, { signal: firstController.signal });
    const second = audio.ensureAudio(id, { signal: secondController.signal });
    const firstRejection = rejectsAborted(first);
    const secondRejection = rejectsAborted(second);
    await waitForRuns(before + 1);
    firstController.abort();
    secondController.abort();
    await Promise.all([firstRejection, secondRejection]);
    await delay(325);
    assert.equal(fs.existsSync(file), false, 'the abandoned child did not finish later');
    assert.equal(fs.existsSync(`${file}.part`), false);
    assert.equal(runs(), before + 1, 'nobody silently kept or restarted the old work');

    delete process.env.SONORA_TEST_DELAY_MS;
    const retry = await audio.ensureAudio(id);
    assert.equal(retry.size, 8192, 'inFlight and slot cleanup permit a clean retry');
    assert.equal(runs(), before + 2);
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
    firstController.abort();
    secondController.abort();
  }
});

test('an immediate retry does not join the just-abandoned controller', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '1000';
  const firstController = new AbortController();
  const secondController = new AbortController();
  const id = 'sssssssssss';
  const before = runs();
  try {
    const first = audio.ensureAudio(id, { signal: firstController.signal });
    const second = audio.ensureAudio(id, { signal: secondController.signal });
    const rejections = Promise.all([rejectsAborted(first), rejectsAborted(second)]);
    await waitForRuns(before + 1);
    firstController.abort();
    secondController.abort();
    await rejections;

    delete process.env.SONORA_TEST_DELAY_MS;
    const retry = await audio.ensureAudio(id);
    assert.equal(retry.size, 8192);
    assert.equal(runs(), before + 2, 'retry drained the abandoned child and ran exactly one replacement');
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
    firstController.abort();
    secondController.abort();
  }
  await audio.removeCachedAudio(id);
});

test('the last queued subscriber releases its place without spawning or leaking a slot', { timeout: 5_000 }, async () => {
  const { config } = await import('../src/config.js');
  const oldLimit = config.maxDownloads;
  config.maxDownloads = 1;
  process.env.SONORA_TEST_DELAY_MS = '150';
  const firstController = new AbortController();
  const secondController = new AbortController();
  const blockerId = 'zzzzzzzzzz5';
  const queuedId = 'zzzzzzzzzz6';
  const before = runs();
  try {
    const blocker = audio.ensureAudio(blockerId);
    await waitForRuns(before + 1);
    const first = audio.ensureAudio(queuedId, { signal: firstController.signal });
    const second = audio.ensureAudio(queuedId, { signal: secondController.signal });
    const rejections = Promise.all([rejectsAborted(first), rejectsAborted(second)]);
    await delay(20);
    firstController.abort();
    secondController.abort();
    await rejections;
    await blocker;
    assert.equal(runs(), before + 1, 'the abandoned queued download never spawned');

    config.maxDownloads = oldLimit;
    delete process.env.SONORA_TEST_DELAY_MS;
    const retry = await audio.ensureAudio(queuedId);
    assert.equal(retry.size, 8192, 'the released slot is immediately reusable');
    assert.equal(runs(), before + 2);
  } finally {
    config.maxDownloads = oldLimit;
    delete process.env.SONORA_TEST_DELAY_MS;
    firstController.abort();
    secondController.abort();
  }
});

test('abort after a final rename rejects the waiter but may retain valid audio', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_HANG_AFTER_WRITE = '1';
  const controller = new AbortController();
  const id = 'uuuuuuuuuuu';
  const file = audio.audioPath(id);
  try {
    const pending = audio.ensureAudio(id, { signal: controller.signal });
    const rejection = rejectsAborted(pending);
    await waitFor(() => fs.existsSync(file), 'fake final-file rename');
    controller.abort();
    await rejection;
    assert.ok(fs.existsSync(file), 'a complete file may be salvaged');
  } finally {
    delete process.env.SONORA_TEST_HANG_AFTER_WRITE;
    controller.abort();
  }
  const cached = await audio.cachedAudio(id);
  assert.equal(cached.size, 8192, 'the salvaged file is validated before reuse');
});

test('invalid preseeded audio is removed and re-downloaded; stable hits do not reopen it', async () => {
  const id = 'vvvvvvvvvvv';
  const file = audio.audioPath(id);
  fs.writeFileSync(file, Buffer.alloc(8192, 7));
  const before = runs();
  const meta = await audio.ensureAudio(id);
  assert.equal(runs(), before + 1, 'a large non-MP4 file was not accepted as a cache hit');
  assert.ok(fs.readFileSync(file).includes(Buffer.from('ftyp')), 'the replacement is really MP4');
  assert.equal(meta.size, 8192);

  // The completed download already supplied an identity and validated header.
  // Adjacent range checks should need neither another open nor another read.
  const originalOpen = fsp.open;
  let opens = 0;
  fsp.open = async (...args) => {
    if (args[0] === file) opens += 1;
    return originalOpen(...args);
  };
  try {
    await audio.cachedAudio(id);
    await audio.cachedAudio(id);
    assert.equal(opens, 0, 'unchanged validated identity avoids open/read on range hits');
  } finally {
    fsp.open = originalOpen;
  }

  // Same path and size cannot inherit validation after an in-place replacement.
  fs.writeFileSync(file, Buffer.alloc(8192, 9));
  backdate(file, 5_000);
  assert.equal(await audio.cachedAudio(id), null, 'changed identity is revalidated');
  assert.equal(fs.existsSync(file), false);
});

test('a preseeded symlink is unlinked, its target is untouched, and audio retries', async (t) => {
  const id = 'wwwwwwwwwww';
  const file = audio.audioPath(id);
  const target = path.join(dir, 'outside-audio-cache.bin');
  const bytes = Buffer.alloc(9000, 13);
  fs.writeFileSync(target, bytes);
  try {
    fs.symlinkSync(target, file);
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip('symlinks need an extra privilege on this platform');
      return;
    }
    throw err;
  }
  const before = runs();
  const meta = await audio.ensureAudio(id);
  assert.equal(meta.size, 8192);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(target), bytes, 'the external target was never changed');
  assert.equal(runs(), before + 1, 'the link was a miss, not externally served content');
  fs.unlinkSync(target);
});

test('a non-regular cache entry is removed instead of being returned', async () => {
  const id = 'xxxxxxxxxxx';
  const file = audio.audioPath(id);
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'not-audio'), 'x');
  assert.equal(await audio.cachedAudio(id), null);
  assert.equal(fs.existsSync(file), false, 'the invalid directory cannot poison the next retry');
});

test('a private cookie copy failure never falls back to the stored writable jar', async () => {
  const stored = path.join(dir, 'youtube-cookies.txt');
  const jar = '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tprivate-only\n';
  fs.writeFileSync(stored, jar, { mode: 0o600 });
  const originalCopy = fsp.copyFile;
  const before = runs();
  fsp.copyFile = async () => {
    const err = new Error('injected cookie-copy failure');
    err.code = 'EIO';
    throw err;
  };
  try {
    await assert.rejects(audio.ensureAudio('yyyyyyyyyyy'), { code: 'EIO' });
    assert.equal(runs(), before, 'yt-dlp was not spawned without a private jar');
    assert.equal(fs.readFileSync(stored, 'utf8'), jar, 'nothing wrote through the stored jar');
  } finally {
    fsp.copyFile = originalCopy;
    fs.unlinkSync(stored);
  }
});

test('cache listing and unlink failures are errors, never successful clears', async () => {
  const file = audio.audioPath('zzzzzzzzzz0');
  fs.writeFileSync(file, Buffer.alloc(8192));
  const originalReadDir = fsp.readdir;
  fsp.readdir = async (...args) => {
    if (args[0] === audioDir) {
      const err = new Error('injected readdir failure');
      err.code = 'EIO';
      throw err;
    }
    return originalReadDir(...args);
  };
  try {
    await assert.rejects(audio.clearCache(), { code: 'EIO' });
    assert.ok(fs.existsSync(file));
  } finally {
    fsp.readdir = originalReadDir;
  }

  const originalUnlink = fsp.unlink;
  fsp.unlink = async (...args) => {
    if (args[0] === file) {
      const err = new Error('injected unlink failure');
      err.code = 'EIO';
      throw err;
    }
    return originalUnlink(...args);
  };
  try {
    await assert.rejects(audio.clearCache(), { code: 'EIO' });
    assert.ok(fs.existsSync(file), 'a failed clear cannot claim that the bytes disappeared');
  } finally {
    fsp.unlink = originalUnlink;
  }
  await audio.clearCache();
});

test('removeCachedAudio propagates unlink errors and can be retried', async () => {
  const id = 'zzzzzzzzzz1';
  const file = audio.audioPath(id);
  fs.writeFileSync(file, Buffer.alloc(8192));
  const originalUnlink = fsp.unlink;
  fsp.unlink = async (...args) => {
    if (args[0] === file) {
      const err = new Error('injected track unlink failure');
      err.code = 'EIO';
      throw err;
    }
    return originalUnlink(...args);
  };
  try {
    await assert.rejects(audio.removeCachedAudio(id), { code: 'EIO' });
    assert.ok(fs.existsSync(file));
  } finally {
    fsp.unlink = originalUnlink;
  }
  assert.equal(await audio.removeCachedAudio(id), true, 'a failed gate does not block retry');
  assert.equal(fs.existsSync(file), false);
});

test('clearCache cancels and drains active downloads before reporting completion', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '250';
  const id = 'zzzzzzzzzz2';
  const file = audio.audioPath(id);
  const before = runs();
  try {
    const download = audio.ensureAudio(id);
    const rejection = rejectsAborted(download);
    await waitForRuns(before + 1);
    await audio.clearCache();
    await rejection;
    delete process.env.SONORA_TEST_DELAY_MS;
    await delay(325);
    assert.equal(fs.existsSync(file), false, 'the drained child cannot recreate the track');
    assert.equal(fs.existsSync(`${file}.part`), false);
    const stats = await audio.cacheStats();
    assert.equal(stats.files, 0);
    assert.equal(stats.partialFiles, 0);
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
  }
});

test('track removal cancels and drains its active download', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '250';
  const id = 'zzzzzzzzzz3';
  const file = audio.audioPath(id);
  const before = runs();
  try {
    const download = audio.ensureAudio(id);
    const rejection = rejectsAborted(download);
    await waitForRuns(before + 1);
    assert.equal(await audio.removeCachedAudio(id), false, 'there was not a completed track to count');
    await rejection;
    delete process.env.SONORA_TEST_DELAY_MS;
    await delay(325);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.part`), false);
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
  }
});

test('same-ID work requested during deletion waits, coalesces, and survives old-job cleanup', { timeout: 5_000 }, async () => {
  process.env.SONORA_TEST_DELAY_MS = '100';
  const id = 'zzzzzzzzzz4';
  const controller = new AbortController();
  const before = runs();
  try {
    const oldDownload = audio.ensureAudio(id, { signal: controller.signal });
    const rejection = rejectsAborted(oldDownload);
    await waitForRuns(before + 1);
    const removing = audio.removeCachedAudio(id);
    const replacement = audio.ensureAudio(id);
    const joinedReplacement = audio.ensureAudio(id);
    assert.equal(replacement, joinedReplacement, 'one replacement waits behind the deletion gate');
    await removing;
    await rejection;
    delete process.env.SONORA_TEST_DELAY_MS;
    const meta = await replacement;
    assert.equal(meta.size, 8192);
    assert.equal(runs(), before + 2, 'only the cancelled old child and one replacement ran');
    assert.ok(fs.existsSync(meta.file), 'old finally cleanup did not disturb replacement state');
  } finally {
    delete process.env.SONORA_TEST_DELAY_MS;
    controller.abort();
  }
  await audio.removeCachedAudio(id);
});

test('prunes coalesce duplicates and one trailing stricter pass', { timeout: 5_000 }, async () => {
  for (let i = 0; i < 64; i++) {
    const file = path.join(audioDir, `coalesce-${String(i).padStart(2, '0')}.m4a`);
    fs.writeFileSync(file, Buffer.alloc(2048));
    backdate(file, 2 * 3_600_000);
  }
  const originalReadDir = fsp.readdir;
  let scans = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  fsp.readdir = async (...args) => {
    if (args[0] === audioDir) {
      scans += 1;
      if (scans === 1) await firstGate;
    }
    return originalReadDir(...args);
  };
  try {
    const first = audio.pruneCacheTo(1e12);
    assert.equal(audio.pruneCacheTo(1e12), first, 'same-limit callers share the active scan');
    await waitFor(() => scans === 1, 'first blocked prune scan');
    const trailing = audio.pruneCacheTo(0);
    assert.notEqual(trailing, first, 'a stricter request gets the trailing pass');
    for (let i = 0; i < 20; i++) {
      assert.equal(audio.pruneCacheTo(i % 2 ? 0 : 1e12), trailing, 'at most one coalesced trailing scan');
    }
    releaseFirst();
    const [a, b] = await Promise.all([first, trailing]);
    assert.equal(a.removed, 0);
    assert.ok(b.removed >= 64, 'the stricter trailing pass preserved LRU/grace behavior');
    assert.equal(scans, 2, 'twenty-three requests produced only two whole-cache scans');
  } finally {
    releaseFirst();
    fsp.readdir = originalReadDir;
  }
});

test('a salvaged cancelled download still enforces the cache budget', { timeout: 5_000 }, async () => {
  // A cancelled download that already produced a complete file is kept (see the
  // salvage test above), but every other path that leaves bytes in the cache
  // prunes on the way out. This one used to throw before reaching the prune, so
  // an aborted-but-complete download was the one write that never counted
  // against the documented ceiling.
  const victim = path.join(audioDir, 'salvage-victim.m4a');
  fs.writeFileSync(victim, Buffer.alloc(1_500_000)); // the ceiling here is 1 MiB
  backdate(victim, 20 * 60_000); // past the 10-minute eviction grace
  const id = 'ssssssssss1';
  const file = audio.audioPath(id);
  process.env.SONORA_TEST_HANG_AFTER_WRITE = '1';
  const controller = new AbortController();
  try {
    const pending = audio.ensureAudio(id, { signal: controller.signal });
    const rejection = rejectsAborted(pending);
    await waitFor(() => fs.existsSync(file), 'fake final-file rename');
    controller.abort();
    await rejection;
  } finally {
    delete process.env.SONORA_TEST_HANG_AFTER_WRITE;
    controller.abort();
  }
  // The joined waiter is rejected as soon as the signal aborts; the salvage
  // cleanup (and its prune) continues behind it, so wait for that work. Before
  // the fix this path threw first and the ceiling was never enforced, so the
  // victim survived until some later download pruned.
  await waitFor(() => !fs.existsSync(victim), 'post-abort cache prune');
  assert.ok(fs.existsSync(file), 'the salvaged file itself is inside the grace window');
  fs.rmSync(file, { force: true });
});

test('a cache hit refreshes its LRU touch at most once a minute', async () => {
  // Every range request goes through cachedAudio(), so an utimes() per hit is a
  // metadata write per 1 MiB chunk of every track. The identity cache already
  // stays valid across the skip, which is what makes the skip safe.
  const id = 'tttttttttt1';
  const meta = await audio.ensureAudio(id);
  const file = meta.file;
  backdate(file, 120_000); // invalidate the identity so the next hit revalidates
  assert.equal((await audio.cachedAudio(id)).size, 8192);
  const touched = fs.statSync(file).mtimeMs;
  assert.ok(Date.now() - touched < 5_000, 'the first hit performed the LRU touch');
  await delay(30);
  assert.equal((await audio.cachedAudio(id)).size, 8192);
  assert.equal(fs.statSync(file).mtimeMs, touched, 'a second hit inside the window must not write mtime');
  fs.rmSync(file, { force: true });
});
