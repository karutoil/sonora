import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { activeCookiesPath } from './cookies.js';

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

const inFlight = new Map(); // videoId -> Promise<{file, size}>
let activeDownloads = 0;
const waiters = [];

async function acquireSlot() {
  if (activeDownloads < config.maxDownloads) {
    activeDownloads += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  activeDownloads += 1;
}

function releaseSlot() {
  activeDownloads -= 1;
  const next = waiters.shift();
  if (next) next();
}

export function audioPath(videoId) {
  return path.join(CACHE_DIR, `${videoId}.m4a`);
}

export async function cachedAudio(videoId) {
  const file = audioPath(videoId);
  try {
    const st = await fsp.stat(file);
    if (st.size > 1024) {
      // Touch for LRU eviction.
      await fsp.utimes(file, new Date(), new Date()).catch(() => {});
      return { file, size: st.size };
    }
  } catch {}
  return null;
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

function run(cmd, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, new Error('yt-dlp timed out'));
    }, timeoutMs);
    timer.unref?.();

    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => done(reject, err));
    child.on('exit', (code) => {
      if (code === 0) return done(resolve, stderr);
      // Distinguish an external block from our own failure, so the UI can say
      // something actionable instead of "could not fetch audio".
      if (/sign in to confirm|not a bot|cookies for the authentication/i.test(stderr)) {
        const err = new Error('YouTube is asking for sign-in on this IP (bot gate).');
        err.code = 'BOT_GATED';
        return done(reject, err);
      }
      done(reject, new Error(`yt-dlp exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Ensure a complete audio file for `videoId` exists locally.
 * Concurrent requests for the same track share one download.
 */
export function ensureAudio(videoId) {
  const hit = inFlight.get(videoId);
  if (hit) return hit;

  const task = (async () => {
    const existing = await cachedAudio(videoId);
    if (existing) return existing;

    await acquireSlot();
    try {
      // Re-check: another process may have finished while we queued.
      const again = await cachedAudio(videoId);
      if (again) return again;

      const file = audioPath(videoId);
      const partial = `${file}.part`;
      await fsp.mkdir(CACHE_DIR, { recursive: true });

      const cookieFile = activeCookiesPath();
      await run(ytdlpBin(), [
        '-f', '140/bestaudio[ext=m4a]/bestaudio',
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        '--no-mtime',
        '--retries', '3',
        ...ytdlpExtraArgs(),
        ...(cookieFile ? ['--cookies', cookieFile] : []),
        '-o', partial,
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeoutMs: config.downloadTimeoutMs });

      const st = await fsp.stat(partial).catch(() => null);
      if (!st || st.size < 1024) throw new Error('yt-dlp produced no audio');
      await fsp.rename(partial, file);
      return { file, size: st.size };
    } finally {
      releaseSlot();
      inFlight.delete(videoId);
    }
  })();

  inFlight.set(videoId, task);
  return task;
}

/** Evict least-recently-used files once the cache exceeds its budget. */
export { run as runProcess, ytdlpBin };

async function audioFiles() {
  let entries;
  try {
    entries = await fsp.readdir(CACHE_DIR);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    if (!name.endsWith('.m4a')) continue;
    const full = path.join(CACHE_DIR, name);
    try {
      const st = await fsp.stat(full);
      files.push({ file: full, name, size: st.size, atime: st.atimeMs });
    } catch {}
  }
  return files;
}

/** What the admin storage panel reports. */
export async function cacheStats() {
  const files = await audioFiles();
  const bytes = files.reduce((n, f) => n + f.size, 0);
  return {
    dir: CACHE_DIR,
    files: files.length,
    bytes,
    limitBytes: config.cacheBytes,
  };
}

/** Evict LRU files until the cache is at or below `maxBytes`. */
export async function pruneCacheTo(maxBytes = config.cacheBytes) {
  const files = await audioFiles();
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= maxBytes) return { removed: 0, bytes: total };

  files.sort((a, b) => a.atime - b.atime);
  let removed = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      await fsp.unlink(f.file);
      total -= f.size;
      removed += 1;
    } catch {}
  }
  return { removed, bytes: total };
}

export async function clearCache() {
  const files = await audioFiles();
  let removed = 0;
  for (const f of files) {
    try {
      await fsp.unlink(f.file);
      removed += 1;
    } catch {}
  }
  return { removed };
}

export async function removeCachedAudio(videoId) {
  try {
    await fsp.unlink(audioPath(videoId));
    return true;
  } catch {
    return false;
  }
}

export async function pruneCache() {
  await pruneCacheTo(config.cacheBytes);
}
