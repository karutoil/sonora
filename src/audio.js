import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { activeCookiesPath } from './cookies.js';
// The live-stream guard needs YouTube's own answer (see rejectLiveStream). No
// cycle: youtube.js imports config and cookies, never this module.
import { hasYT, isLive } from './youtube.js';

// Audio acquisition.
//
// Measured 2026-10-18: googlevideo serves ONLY the first <=1MiB of an audio
// track and 403s on every nonzero offset, open-ended range and large range.
// That makes a transparent byte-for-byte proxy impossible — a media element
// would stall one megabyte into every song.
//
// yt-dlp does not hit this because it negotiates a streaming client that is
// allowed the whole file; it pulls a 3.4MB track in ~2s (25x realtime). So:
// fetch the complete file once into a local content cache, then serve ranges
// off disk. Seeks become instant, expiring URLs stop mattering, and replaying
// a track costs no network at all.

const CACHE_DIR = config.audioDir;
/** Anything smaller is a truncated write, not a track. */
const MIN_AUDIO_BYTES = 1024;
/** Per-child copies of the cookie jar (see privateJar). */
const CHILD_JAR_PREFIX = '.ytdlp-cookies-';
/**
 * A YouTube video id: 11 chars of base64url.
 *
 * Every current caller is behind this same check in the routes, but the guard
 * lived three files away from the `path.join` below, so one future caller (a
 * room import, a DB row, "download this playlist") would have made
 * `../../data/sonora.db` reachable — and `removeCachedAudio` would have unlinked
 * it. The check belongs where the path is built.
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function ytdlpBin() {
  if (process.env.SONORA_YTDLP) return process.env.SONORA_YTDLP;
  // The venv was created as muse-venv before the rename; keep using it so an
  // existing install does not have to re-download yt-dlp.
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/share/sonora-venv/bin/yt-dlp'),
    path.join(home, '.local/share/muse-venv/bin/yt-dlp'),
  ];
  const venv = candidates.find((p) => fs.existsSync(p));
  return venv ?? 'yt-dlp';
}

// videoId -> { task, controller, subscribers, pinned, ... }. The child has its
// own controller: a request owns a subscription, never the shared operation.
const inFlight = new Map();
const retiring = new Map(); // videoId -> deletion promise; new work waits behind it
let clearing = null; // whole-cache deletion promise; new work waits behind it
let activeDownloads = 0;
/** Pending slot requests, oldest first. See acquireSlot/releaseSlot. */
const waiters = [];

/** The download was cancelled by the client (see `opts.signal`). */
function abortedError() {
  const err = new Error('The audio download was cancelled.');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

/** Every slot stayed taken for longer than `queueTimeoutMs`. */
function busyError() {
  const err = new Error(`All ${config.maxDownloads} audio download slots are busy.`);
  err.code = 'BUSY';
  return err;
}

/** `run()` gave up on a child that never finished. */
function timedOutError() {
  const err = new Error('yt-dlp timed out');
  err.code = 'ETIMEDOUT';
  return err;
}

/**
 * Take one of the `maxDownloads` slots, waiting at most `queueTimeoutMs`, and
 * give up at once if `signal` aborts.
 *
 * All three bounds are the fix for one failure: a listener skipped four tracks,
 * which left four downloads (each up to `downloadTimeoutMs`) holding every slot,
 * so the track they actually wanted queued behind all four — minutes of silence
 * per press of play, and nothing could give up. There was no timeout on the
 * wait, no client abort on the request and no Fastify requestTimeout, so the
 * queue only drained when yt-dlp finished work nobody wanted any more.
 *
 * The abort hook is not optional either: an abandoned waiter used to stay in
 * `waiters` forever, and releaseSlot() handed it the next slot — which nothing
 * then released. A handful of abandoned requests were enough to wedge playback
 * completely, with no error anywhere, until the process restarted.
 */
async function acquireSlot(signal) {
  if (signal?.aborted) throw abortedError();
  if (activeDownloads < config.maxDownloads) {
    activeDownloads += 1;
    return;
  }
  await new Promise((resolve, reject) => {
    const entry = { timer: null, onAbort: null, grant: null };
    /** Leave the queue for good, then settle. Idempotent by construction. */
    const settle = (fn, arg) => {
      const i = waiters.indexOf(entry);
      if (i !== -1) waiters.splice(i, 1);
      clearTimeout(entry.timer);
      if (entry.onAbort) signal?.removeEventListener('abort', entry.onAbort);
      fn(arg);
    };
    // The slot is handed over by releaseSlot(), which does not decrement when a
    // waiter is waiting: decrementing first would let a third caller see a free
    // slot in between and run maxDownloads + 1 processes.
    entry.grant = () => settle(resolve);
    entry.onAbort = () => settle(reject, abortedError());
    entry.timer = setTimeout(() => settle(reject, busyError()), Math.max(1, config.queueTimeoutMs));
    entry.timer.unref?.();
    if (signal) {
      signal.addEventListener('abort', entry.onAbort, { once: true });
      // Registered, then re-checked: an abort that landed between the check at
      // the top of this function and that line would otherwise never fire.
      if (signal.aborted) {
        settle(reject, abortedError());
        return;
      }
    }
    waiters.push(entry);
  });
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) {
    // Hand the slot over instead of decrementing: the waiter inherits this one.
    next.grant();
    return;
  }
  activeDownloads -= 1;
}

export function audioPath(videoId) {
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) {
    const err = new Error('Not a YouTube video id.');
    err.code = 'BAD_ID';
    throw err;
  }
  return path.join(CACHE_DIR, `${videoId}.m4a`);
}

// A range request must not reopen and reread the file header to prove something
// that has not changed. Identity includes mtime (and inode/device/size), so an
// in-place rewrite or replacement cannot inherit an earlier validation.
const validatedAudio = new Map();
const MAX_VALIDATED_AUDIO = 2048;
const TOUCH_INTERVAL_MS = 60_000;

function sameIdentity(a, st) {
  return a && a.dev === st.dev && a.ino === st.ino && a.size === st.size
    && a.mtimeMs === st.mtimeMs && a.ctimeMs === st.ctimeMs;
}

function forgetValidatedAudio(file) {
  validatedAudio.delete(file);
}

function rememberValidatedAudio(file, st, touchedAt = Date.now()) {
  validatedAudio.delete(file);
  validatedAudio.set(file, {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    touchedAt,
  });
  while (validatedAudio.size > MAX_VALIDATED_AUDIO) {
    validatedAudio.delete(validatedAudio.keys().next().value);
  }
}

/** Unlink one cache path. Only disappearance is a successful no-op. */
async function unlinkCacheEntry(file) {
  try {
    await fsp.unlink(file);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    // `cachedAudio` also rejects a directory planted at a track path. Remove
    // that directory so the next request can retry, but never turn EACCES/EIO
    // on an ordinary file into a false-success result.
    if (err?.code === 'EISDIR' || err?.code === 'EPERM') {
      const st = await fsp.lstat(file).catch((statErr) => {
        if (statErr?.code === 'ENOENT') return null;
        throw statErr;
      });
      if (st?.isDirectory()) {
        await fsp.rm(file, { recursive: true, force: false });
        return true;
      }
    }
    throw err;
  }
}

async function discardInvalidAudio(file) {
  forgetValidatedAudio(file);
  await unlinkCacheEntry(file);
}

export async function cachedAudio(videoId) {
  const file = audioPath(videoId);
  let st;
  try {
    // Never trust or remove through a symlink. This also handles FIFOs,
    // sockets and directories, which a following stat() used to accept.
    st = await fsp.lstat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile() || st.size <= MIN_AUDIO_BYTES) {
    // Fragments and unsafe/non-audio entries must not become permanent cache
    // hits. Failure to remove one is an error, not a miss that overwrites it.
    await discardInvalidAudio(file);
    return null;
  }

  let known = validatedAudio.get(file);
  if (!sameIdentity(known, st)) {
    if (!(await looksLikeMp4(file))) {
      await discardInvalidAudio(file);
      return null;
    }
    known = null;
  } else {
    // Refresh the bounded cache's LRU position on an identity hit.
    validatedAudio.delete(file);
    validatedAudio.set(file, known);
  }

  // Touch for LRU eviction, at most once a minute per unchanged file. Besides
  // avoiding metadata-write pressure on adjacent range requests, leaving mtime
  // stable between touches is what lets the identity cache remain effective.
  if (known && Date.now() - known.touchedAt < TOUCH_INTERVAL_MS) {
    return { file, size: st.size };
  }
  await fsp.utimes(file, new Date(), new Date()).catch(() => {});
  // Persist the post-touch identity; storing the old mtime would force another
  // open/read on the very next range request.
  const fresh = await fsp.lstat(file).catch((err) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (!fresh) {
    forgetValidatedAudio(file);
    return null;
  }
  if (!fresh.isFile() || fresh.size <= MIN_AUDIO_BYTES || fresh.size !== st.size
    || fresh.dev !== st.dev || fresh.ino !== st.ino) {
    await discardInvalidAudio(file);
    return null;
  }
  rememberValidatedAudio(file, fresh);
  return { file, size: fresh.size };
}

/** Extra yt-dlp flags: PO-token provider, JS runtime, proxy. */
export function ytdlpExtraArgs() {
  const args = [];
  if (config.potProviderUrl) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`);
  }
  if (config.jsRuntime) args.push('--js-runtimes', config.jsRuntime);
  if (config.ytdlpProxy) args.push('--proxy', config.ytdlpProxy);
  return args;
}

/**
 * yt-dlp's stderr goes into logs and into API errors. A proxy URL can carry
 * credentials (socks5://user:pass@host) and there is no reason for those to
 * travel any further than the child process.
 */
const redact = (text) => String(text ?? '').replace(/\/\/[^/\s@]+@/g, '//***@');

/**
 * SIGKILL a child *and* everything it spawned.
 *
 * `spawn(..., { detached: true })` puts the child in its own process group, so
 * `-child.pid` reaches the whole tree. Killing only the direct child left
 * yt-dlp's helpers behind — with SONORA_JS_RUNTIME set it launches a JS runtime
 * for challenges — and repeated 120 s timeouts (routine once a listener skips
 * tracks) accumulated CPU-burning orphans that nothing ever reaped.
 */
function killTree(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // No process group to speak of (exited already, or a platform without
    // them): the single process is the best that can be done.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * The children currently running.
 *
 * `detached: true` is what makes the group kill possible, and it also means an
 * exiting server no longer takes its downloads with it the way a Ctrl-C on the
 * shared process group used to: up to `maxDownloads` yt-dlp runs would keep
 * filling a cache nobody is listening to. Nothing to do for a container (the
 * cgroup dies with it) or a systemd unit, but a foreground `npm start` needs it.
 */
const liveChildren = new Set();

process.once('exit', () => {
  for (const child of liveChildren) killTree(child);
});

function run(cmd, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    // stdout is discarded on purpose: nothing reads it, and an unread pipe
    // fills at 64 KiB and blocks the child until our timeout kills it.
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    liveChildren.add(child);
    let stderr = '';
    let settled = false;
    let timer = null;
    let backstop = null;
    /** Why we killed the child, so 'close' can report it (see stop). */
    let killed = null;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      clearTimeout(timer);
      clearTimeout(backstop);
      signal?.removeEventListener('abort', onAbort);
      fn(arg);
    };

    /**
     * Kill the child's whole group and remember *why*, so the error is reported
     * from 'close' rather than from here.
     *
     * Settling the moment a signal is *sent* is what let the caller unlink the
     * output file and the private cookie jar while yt-dlp was still exiting —
     * racing the child's own write-back and, on a slow exit, reporting success
     * or failure about a file that was still being renamed.
     */
    const stop = (why) => {
      if (killed || settled) return;
      killed = why;
      killTree(child);
      // SIGKILL cannot be ignored, so 'close' is milliseconds away. This is only
      // the backstop for the pathological case (a grandchild that still holds
      // our stderr pipe open, so 'close' would never fire) that would otherwise
      // hang the caller — and its download slot — forever.
      backstop = setTimeout(() => done(reject, why), 5_000);
      backstop.unref?.();
    };

    const onAbort = () => stop(abortedError());

    timer = setTimeout(() => stop(timedOutError()), timeoutMs);
    timer.unref?.();
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      // Re-checked after registering: an abort that landed in between would
      // otherwise never reach this child.
      if (signal.aborted) stop(abortedError());
    }

    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => done(reject, err));
    // 'close' (not 'exit') fires once stderr has drained, so the tail we report
    // is the whole message instead of whatever had arrived when the process
    // happened to die.
    child.on('close', (code, signal) => {
      if (killed) return done(reject, killed);
      if (code === 0) return done(resolve, stderr);
      if (signal) return done(reject, new Error(`yt-dlp was killed (${signal}): ${redact(stderr.slice(-400))}`));
      // Distinguish an external block from our own failure, so the UI can say
      // something actionable instead of "could not fetch audio".
      if (/sign in to confirm|not a bot|cookies for the authentication/i.test(stderr)) {
        const err = new Error('YouTube is asking for sign-in on this IP (bot gate).');
        err.code = 'BOT_GATED';
        return done(reject, err);
      }
      // A full disk is not a YouTube problem and must not be reported as one:
      // it is the one failure where retrying makes things worse.
      if (/no space left on device|errno 28/i.test(stderr)) {
        const err = new Error('The audio cache is on a full disk.');
        err.code = 'ENOSPC';
        return done(reject, err);
      }
      done(reject, new Error(`yt-dlp exited ${code}: ${redact(stderr.slice(-400))}`));
    });
  });
}

/**
 * Is this a real MP4/M4A container? The last arm of our format selector can
 * hand back WebM/Opus, which would be cached as `<id>.m4a` and served as
 * `audio/mp4`: a track that never plays on Safari and is never re-fetched,
 * because the cache says the file is there.
 */
async function looksLikeMp4(file) {
  let fh = null;
  try {
    // O_NOFOLLOW closes the common symlink-swap window in addition to the
    // lstat() check in cachedAudio (platforms without it use ordinary O_RDONLY).
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fh = await fsp.open(file, flags);
    const head = Buffer.alloc(32);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    // ISO BMFF starts with a box header then the `ftyp` brand; a free/wide box
    // may come first, so look at the head rather than a fixed offset.
    return head.subarray(0, bytesRead).includes(Buffer.from('ftyp', 'latin1'));
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * The private 0700 directory the per-child cookie jars live in.
 *
 * One per process, created on first use and removed on a clean exit. Under the
 * OS temp dir rather than SONORA_AUDIO_DIR: the audio cache is the directory an
 * operator rsyncs, screenshots in the admin panel or hands to a support script,
 * and the jar copy is a plaintext copy of a file that is encrypted at rest (see
 * the note on `leftoverFiles` too).
 */
let childJarDirPromise = null;

function childJarDir() {
  childJarDirPromise ??= (async () => {
    // mkdtemp: 0700, unpredictable name, so a pre-existing directory cannot be
    // planted where the secrets are about to be written.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sonora-ytdlp-'));
    // A long-lived process should not leave the directory behind if it exits
    // cleanly; a crash leaves at worst one empty 0700 directory in /tmp, which
    // the OS reclaims.
    process.once('exit', () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
    return dir;
  })().catch((err) => {
    // Never cache a failure: a full /tmp on one download must not disable cookie
    // support for the life of the process.
    childJarDirPromise = null;
    throw err;
  });
  return childJarDirPromise;
}

/**
 * yt-dlp writes its cookie file back on exit — a plain truncating write, not an
 * atomic rename. Up to `maxDownloads` children therefore raced on one shared
 * jar, and a child started before an import flushed its stale copy over the new
 * one, after which every download stayed bot-gated until the next restart.
 * Each child gets a private 0600 copy, so the write-back lands in a file we
 * throw away.
 */
async function privateJar(source) {
  if (!source) return null;
  // Fail closed: yt-dlp writes through --cookies, so using the stored source
  // after a copy failure would reintroduce the exact cross-child corruption and
  // stale-write-back this private copy exists to prevent.
  const dir = await childJarDir();
  const target = path.join(dir, `${CHILD_JAR_PREFIX}${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(target, 0o600).catch(() => { /* best effort, as in cookies.js */ });
    return target;
  } catch (err) {
    await fsp.unlink(target).catch(() => {});
    throw err;
  }
}

async function dropPrivateJar(jar) {
  if (!jar || !path.basename(jar).startsWith(CHILD_JAR_PREFIX)) return;
  await fsp.unlink(jar).catch(() => {});
}

/** Nobody is waiting for this file any more (see `opts.signal`). */
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError();
}

/** Wait for a deletion gate without making any one caller's signal the job's. */
async function awaitMaintenance(gate, signal) {
  if (!gate) return;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortedError());
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([gate, aborted]);
    throwIfAborted(signal);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function leaveDownload(job, subscriber) {
  if (!job.subscribers.delete(subscriber)) return;
  // A pin represents one or more callers with no signal (notably /api/warm).
  // They cannot leave early and keep the work alive through settlement.
  if (!job.settled && !job.pinned && job.subscribers.size === 0) {
    job.controller.abort();
  }
}

/** Give one caller an independently cancellable view of the shared job. */
function joinDownload(job, signal) {
  if (!signal) {
    job.pinned = true;
    return job.task;
  }
  if (signal.aborted) return Promise.reject(abortedError());
  if (job.settled) return job.task;
  const subscriber = {};
  job.subscribers.add(subscriber);
  return new Promise((resolve, reject) => {
    let active = true;
    const settle = (fn, arg, leave) => {
      if (!active) return;
      active = false;
      signal.removeEventListener('abort', onAbort);
      if (leave) leaveDownload(job, subscriber);
      else job.subscribers.delete(subscriber);
      fn(arg);
    };
    const onAbort = () => settle(reject, abortedError(), true);
    signal.addEventListener('abort', onAbort, { once: true });
    job.task.then(
      (value) => settle(resolve, value, false),
      (err) => settle(reject, err, false),
    );
    // An abort between subscribe() and listener registration must not strand a
    // reference or leave an unmaintained child running.
    if (signal.aborted) onAbort();
  });
}

/**
 * Refuse to start a download for a live broadcast.
 *
 * yt-dlp cannot "finish" one — it would read a never-ending stream until
 * `downloadTimeoutMs` kills it, holding one of the few download slots the whole
 * time. /api/stream already checks this before calling us; /api/warm did not, so
 * one live premiere in the queue (YouTube serves live ids from up-next like
 * anything else) burned the slot the next real play needed. Doing it here covers
 * every caller.
 *
 * Two deliberate limits. It is best-effort (see isLive: a failed *check* must
 * never stop a track that could play), and it only probes when an Innertube
 * session already exists: creating one costs seconds, and paying that inside
 * every cold download to rule out the rare broadcast is a bad trade. A warm in a
 * process that has never talked to YouTube skips the probe — and the /api/stream
 * request that follows always probes, so a broadcast still never reaches a slot.
 */
async function rejectLiveStream(videoId) {
  if (!hasYT()) return;
  if (await isLive(videoId)) {
    const err = new Error('This is a live stream — not supported yet.');
    err.code = 'LIVE';
    throw err;
  }
}

/**
 * Refuse to start a download on a filesystem that cannot hold one.
 *
 * `cacheBytes` is a budget, never a statement about the filesystem: an 8 GB
 * ceiling on a partition with 200 MB left still lets every cold download spawn
 * yt-dlp and hold a slot for the whole (doomed) run, and the player answers each
 * skip by trying again. A full disk is the one failure where retrying makes
 * things worse, so it is worth one syscall to report it immediately.
 */
const MIN_FREE_BYTES = 16 * 1024 * 1024;

async function assertDiskSpace() {
  let st;
  try {
    st = await fsp.statfs(CACHE_DIR);
  } catch {
    return; // no statfs here: let yt-dlp report it instead of guessing
  }
  const free = Number(st.bavail) * Number(st.bsize);
  if (Number.isFinite(free) && free < MIN_FREE_BYTES) {
    const err = new Error('The audio cache is on a full disk.');
    err.code = 'ENOSPC';
    throw err;
  }
}

async function downloadAudio(videoId, signal, gates, job) {
  try {
    // A job requested during clear/delete is new work, not part of the drain
    // snapshot. It waits, abortably, so deletion cannot be undone by a rename.
    await awaitMaintenance(gates.clear, signal);
    await awaitMaintenance(gates.retire, signal);
    if (gates.after) await awaitMaintenance(gates.after, signal);
    throwIfAborted(signal);
    const existing = await cachedAudio(videoId);
    if (existing) return existing;

    await rejectLiveStream(videoId);
    throwIfAborted(signal);

    await acquireSlot(signal);
    let result;
    let added = false;
    try {
      // Re-check: another process may have finished while we queued.
      const again = await cachedAudio(videoId);
      if (again) {
        result = again;
      } else {
        const file = audioPath(videoId);
        const partial = `${file}.part`;
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        // A statfs here, not before the slot: the directory has to exist to ask
        // about its filesystem, and this is still before a child is spawned.
        await assertDiskSpace();
        // A fragment left by a killed run must not be resumed: googlevideo 403s
        // every non-zero offset, so a resumed download burns all three retries
        // and fails. Nobody else can be writing this id (we hold the slot), so
        // remove it now and tell yt-dlp not to continue.
        await unlinkCacheEntry(partial);

        const jar = await privateJar(activeCookiesPath());
        let failure = null;
        try {
          await run(ytdlpBin(), [
            // m4a arms only: a bare `bestaudio` can be WebM/Opus, which is stored
            // under an `.m4a` name and served as audio/mp4 (unplayable on Safari).
            '-f', '140/bestaudio[ext=m4a]',
            '--no-playlist',
            '--no-progress',
            '--no-warnings',
            '--no-mtime',
            // yt-dlp owns the temp name: given `-o <file>` it streams to
            // `<file>.part` and renames it at the end, so an interrupted download
            // is never mistaken for a complete track. The old argv passed
            // `--no-part` and `-o <file>.part`, which yt-dlp normalises by
            // stripping the trailing `.part`: it wrote <file>, then the m4a fixup
            // looked for the temp path, exited 1, and every cold download answered
            // 502 with a perfectly good file already on disk.
            '--no-continue',
            '--retries', '3',
            ...ytdlpExtraArgs(),
            ...(jar ? ['--cookies', jar] : []),
            '-o', file,
            `https://www.youtube.com/watch?v=${videoId}`,
          ], { timeoutMs: config.downloadTimeoutMs, signal });
        } catch (err) {
          // Keep the error but inspect the output before acting on it: a
          // postprocessor can fail after the audio itself is complete (that is
          // exactly how the `.part` bug presented itself), and a good file on
          // disk should never be thrown away.
          failure = err;
        } finally {
          await dropPrivateJar(jar);
        }

        const st = await fsp.lstat(file).catch((err) => {
          if (err?.code === 'ENOENT') return null;
          throw err;
        });
        const valid = st?.isFile() && st.size > MIN_AUDIO_BYTES && await looksLikeMp4(file);
        if (!valid) {
          await discardInvalidAudio(file);
          await unlinkCacheEntry(partial);
          if (failure) throw failure;
          throw new Error(st
            ? 'yt-dlp produced a file that is not MP4 audio or not a regular file'
            : 'yt-dlp produced no audio');
        }
        // Salvaging a complete file after cancellation is fine; resolving an
        // aborted operation as though its waiter completed is not. The file is
        // kept, so the cache budget still has to be enforced on the way out —
        // every other path that leaves bytes behind prunes here, and a
        // cancelled-but-complete download used to skip it entirely.
        if (signal.aborted) {
          await pruneCacheTo(config.cacheBytes).catch(() => {});
          throw failure?.code === 'ABORTED' ? failure : abortedError();
        }
        rememberValidatedAudio(file, st);
        result = { file, size: st.size };
        added = true;
      }
    } finally {
      releaseSlot();
    }

    // Enforce the documented cache ceiling where bytes are added. Pruning only
    // at boot and from the admin button left it decorative: the cache grew
    // without bound, and a full disk fails the SQLite writes too. The file we
    // just wrote is inside the grace window, so it cannot be the victim.
    //
    // Outside the slot on purpose: this lists and stats the whole cache, which
    // with a few thousand tracks is hundreds of ms to seconds of bookkeeping —
    // and it used to spend a scarce download slot on it, with every other
    // download queued behind the scan as well. Still awaited before we resolve,
    // so "the budget is enforced by the next download" stays true.
    if (added) await pruneCacheTo(config.cacheBytes).catch(() => {});
    return result;
  } finally {
    job.settled = true;
    job.subscribers.clear();
    // Maintenance may already have installed this id's replacement, which is
    // waiting on a deletion gate. An older job must never delete that entry.
    if (inFlight.get(videoId) === job) inFlight.delete(videoId);
  }
}

/**
 * Ensure a complete audio file for `videoId` exists locally.
 * Concurrent requests for the same track share one download.
 *
 * `opts.signal` (an AbortSignal) is the client going away: the download is
 * killed — child, process group and all — its slot is freed and this rejects
 * with `err.code === 'ABORTED'`. Other codes a caller may see: 'BUSY' (no slot
 * within `config.queueTimeoutMs`), 'ENOSPC' (full disk) and 'BOT_GATED'.
 */
export function ensureAudio(videoId, opts = {}) {
  const signal = opts?.signal ?? null;
  if (signal?.aborted) return Promise.reject(abortedError());
  try {
    audioPath(videoId);
  } catch (err) {
    return Promise.reject(err);
  }
  const gates = { clear: clearing, retire: retiring.get(videoId) ?? null, after: null };
  const hit = inFlight.get(videoId);
  if (hit?.controller.signal.aborted) {
    // Do not hand a new caller an irrevocably aborted controller (quick skip and
    // replay can happen in the same millisecond). It waits for the old process
    // to close before touching the same final/.part paths.
    gates.after = hit.drained ??= hit.task.then(() => {}, () => {});
  }
  if (hit && !gates.after
    && (!gates.clear || hit.gates.clear === gates.clear)
    && (!gates.retire || hit.gates.retire === gates.retire)) {
    // Once an old gate has settled it is just history, not a reason to replace
    // the job that waited behind it.
    return joinDownload(hit, signal);
  }

  // Different gates mean maintenance replaced the previous job. The obsolete
  // job is aborted by clear/delete and its identity-checked cleanup cannot
  // remove this new map entry.
  const job = {
    controller: new AbortController(),
    gates,
    subscribers: new Set(),
    pinned: false,
    settled: false,
    task: null,
  };
  inFlight.set(videoId, job);
  job.task = downloadAudio(videoId, job.controller.signal, gates, job);
  return joinDownload(job, signal);
}

/** Evict least-recently-used files once the cache exceeds its budget. */
export { run as runProcess, ytdlpBin };

/**
 * One pass over the cache directory: finished tracks, and the leftovers that are
 * not tracks (half-written downloads and per-child cookie jars).
 *
 * The leftovers occupy disk without being counted by `cacheStats` or removed by
 * `clearCache`, which is how "delete all cached audio" could report success and
 * leave bytes behind. Child jars are no longer written here (they live in a
 * private temp directory, see childJarDir), but earlier versions put them next
 * to the music — including plaintext copies of the stored session — so they are
 * still counted and swept.
 *
 * A prune used to walk the directory twice (once for the sweep, once for
 * eviction), and it ran inside a download slot: with a few thousand tracks that
 * is hundreds of ms to seconds of a scarce slot spent on bookkeeping, per
 * completed download, serialised behind the same `pruneChain`. One listing, one
 * stat per entry.
 */
async function mapBounded(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

async function scanCache() {
  let entries;
  try {
    entries = await fsp.readdir(CACHE_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return { tracks: [], leftovers: [] };
    // EACCES/EIO must not show up in the admin panel as a healthy empty cache.
    throw err;
  }
  const candidates = entries.filter((name) => name.endsWith('.m4a')
    || name.endsWith('.part') || name.startsWith(CHILD_JAR_PREFIX));
  // Measured on 6,000 tmpfs entries: bounded 32 was ~2.6x faster than the old
  // serial stat loop; 128 gave no meaningful further gain. Keep a hard bound.
  const scanned = await mapBounded(candidates, 32, async (name) => {
    const isTrack = name.endsWith('.m4a');
    const full = path.join(CACHE_DIR, name);
    let st;
    try {
      st = await fsp.lstat(full);
    } catch (err) {
      if (err?.code === 'ENOENT') return null; // ordinary concurrent removal
      throw err;
    }
    const entry = { file: full, name, size: st.size, atime: st.atimeMs, mtime: st.mtimeMs };
    // Never follow cache symlinks during accounting/pruning. Unsafe and
    // non-regular entries are leftovers, not playable tracks.
    return { entry, track: isTrack && st.isFile() };
  });
  const tracks = [];
  const leftovers = [];
  for (const item of scanned) {
    if (item) (item.track ? tracks : leftovers).push(item.entry);
  }
  return { tracks, leftovers };
}

/** What the admin storage panel reports. */
export async function cacheStats() {
  // One directory pass for both numbers.
  const { tracks: files, leftovers: partials } = await scanCache();
  const bytes = files.reduce((n, f) => n + f.size, 0);
  // Reported separately so a hidden fragment cannot inflate the disk usage the
  // panel claims to account for; `files`/`bytes` stay "playable tracks".
  return {
    dir: CACHE_DIR,
    files: files.length,
    bytes,
    partialFiles: partials.length,
    partialBytes: partials.reduce((n, f) => n + f.size, 0),
    limitBytes: config.cacheBytes,
  };
}

/**
 * A file touched this recently may be streaming right now: the stream handler
 * stats it and then opens a read stream, so an unlink in between turns a
 * playing track into a 500. Eviction is never allowed to be that reason.
 */
const PRUNE_GRACE_MS = 10 * 60_000;

let activePrune = null;
let queuedPrune = null;

async function runPruneQueue() {
  while (queuedPrune) {
    const job = queuedPrune;
    queuedPrune = null;
    activePrune = { limit: job.limit, promise: job.promise };
    try {
      job.resolve(await pruneTo(job.limit));
    } catch (err) {
      job.reject(err);
    } finally {
      if (activePrune?.promise === job.promise) activePrune = null;
    }
  }
}

/** Evict LRU files until the cache is at or below `maxBytes`. */
export function pruneCacheTo(maxBytes = config.cacheBytes) {
  // At most one running scan and one trailing scan. A stronger (smaller) limit
  // satisfies every weaker waiter; requests that need a stronger active scan
  // coalesce into the trailing job instead of serialising a full scan each.
  if (queuedPrune) {
    queuedPrune.limit = Math.min(queuedPrune.limit, maxBytes);
    return queuedPrune.promise;
  }
  if (activePrune && activePrune.limit <= maxBytes) return activePrune.promise;

  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  queuedPrune = { limit: maxBytes, promise, resolve, reject };
  if (!activePrune) void runPruneQueue();
  return promise;
}

/**
 * Leftovers from a download that died before the cleanup in ensureAudio could
 * run (a crash, a container restart, a SIGKILL): neither a `.part` nor a child
 * cookie jar is ever served or counted, so nothing else would remove them.
 * Only files that have not been written for an hour are touched — a live
 * download keeps updating its mtime.
 */
async function sweepLeftovers(leftovers, maxAgeMs = 3_600_000) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const f of leftovers) {
    if (f.mtime > cutoff) continue;
    if (await unlinkCacheEntry(f.file)) {
      forgetValidatedAudio(f.file);
      removed += 1;
    }
  }
  return removed;
}

async function pruneTo(maxBytes) {
  // One listing feeds both the sweep and the eviction (see scanCache).
  const { tracks: files, leftovers } = await scanCache();
  let removed = await sweepLeftovers(leftovers);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= maxBytes) return { removed, bytes: total };

  const cutoff = Date.now() - PRUNE_GRACE_MS;
  files.sort((a, b) => a.atime - b.atime);
  for (const f of files) {
    if (total <= maxBytes) break;
    // Recently used files are skipped rather than deleted: they are either
    // being streamed or about to be, and a short cache is cheaper than a stall.
    if (f.atime > cutoff) continue;
    if (await unlinkCacheEntry(f.file)) {
      forgetValidatedAudio(f.file);
      total -= f.size;
      removed += 1;
    }
  }
  return { removed, bytes: total };
}

export function clearCache() {
  if (clearing) return clearing;
  let resolve;
  let reject;
  const gate = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Publish the gate before aborting: even an abort listener that re-enters
  // ensureAudio() must create work behind, rather than inside, this deletion.
  clearing = gate;
  void (async () => {
    try {
      const jobs = [...inFlight.values()].filter((job) => job.gates.clear !== gate);
      for (const job of jobs) job.controller.abort();
      // A graceful clear never leaves a child alive to recreate a final file or
      // .part after the administrative response. New jobs wait on `gate`.
      await Promise.allSettled(jobs.map((job) => job.task));
      const { tracks, leftovers } = await scanCache();
      let removed = 0;
      for (const f of [...tracks, ...leftovers]) {
        if (await unlinkCacheEntry(f.file)) {
          forgetValidatedAudio(f.file);
          removed += 1;
        }
      }
      validatedAudio.clear();
      resolve({ removed });
    } catch (err) {
      reject(err);
    } finally {
      if (clearing === gate) clearing = null;
    }
  })();
  return gate;
}

export function removeCachedAudio(videoId) {
  let file;
  try {
    file = audioPath(videoId);
  } catch (err) {
    return Promise.reject(err);
  }
  const existing = retiring.get(videoId);
  if (existing) return existing;
  let resolve;
  let reject;
  const gate = new Promise((res, rej) => { resolve = res; reject = rej; });
  retiring.set(videoId, gate);
  void (async () => {
    try {
      const job = inFlight.get(videoId);
      if (job && job.gates.retire !== gate) {
        job.controller.abort();
        await job.task.catch(() => {});
      }
      let removed = false;
      // The temp file belongs to the same track. Drain first so neither it nor
      // the final file can reappear after this operation reports completion.
      for (const target of [file, `${file}.part`]) {
        if (await unlinkCacheEntry(target)) {
          forgetValidatedAudio(target);
          removed = true;
        }
      }
      resolve(removed);
    } catch (err) {
      reject(err);
    } finally {
      if (retiring.get(videoId) === gate) retiring.delete(videoId);
    }
  })();
  return gate;
}

export async function pruneCache() {
  await pruneCacheTo(config.cacheBytes);
}
