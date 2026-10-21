import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

// The default database file was data/muse.db before the rename. An existing
// install keeps its library and accounts by continuing to use that file; a
// fresh clone starts on data/sonora.db.
const DEFAULT_DB = fs.existsSync(new URL('../data/muse.db', import.meta.url).pathname)
  ? new URL('../data/muse.db', import.meta.url).pathname
  : new URL('../data/sonora.db', import.meta.url).pathname;

export const config = {
  port: int('PORT', 8130),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.SONORA_DB ?? DEFAULT_DB,
  audioDir: process.env.SONORA_AUDIO_DIR ?? new URL('../data/audio', import.meta.url).pathname,
  // yt-dlp downloads far faster than realtime; this is a safety ceiling.
  downloadTimeoutMs: int('SONORA_DOWNLOAD_TIMEOUT_MS', 120_000),
  maxDownloads: int('SONORA_MAX_DOWNLOADS', 4),
  cacheBytes: int('SONORA_CACHE_MB', 8192) * 1024 * 1024,
  // Shared secret for session cookies. Required in production; generated
  // per-process in dev so a forgotten env var can never ship a fixed key.
  secret: process.env.SONORA_SECRET ?? crypto.randomBytes(32).toString('hex'),
  isDev: !process.env.SONORA_SECRET,
  // Access tokens are short-lived; a remembered device silently renews one with
  // its refresh token. Without "remember me" the cookie is session-scoped, so
  // closing the browser signs the device out.
  sessionMinutes: int('SONORA_SESSION_MINUTES', 12 * 60),
  refreshDays: int('SONORA_REFRESH_DAYS', int('SONORA_SESSION_DAYS', 30)),
  // Legacy name kept so an existing SONORA_SESSION_DAYS deployment keeps working.
  sessionDays: int('SONORA_SESSION_DAYS', 90),

  // WebAuthn / passkeys. A passkey is bound to a registrable domain, not an IP,
  // so these default to the request host and must be set explicitly when the
  // public origin differs from what Fastify sees (a tunnel or reverse proxy).
  rpId: process.env.SONORA_RP_ID ?? null,
  origin: process.env.SONORA_ORIGIN ?? null,
  rpName: process.env.SONORA_RP_NAME ?? 'sonora',
  // Sign-in attempts per window, per client. Ten a minute is generous for one
  // person and hostile to a script; raise it for a household sharing one IP.
  loginRateMax: int('SONORA_LOGIN_RATE_MAX', 10),
  loginRateWindow: process.env.SONORA_LOGIN_RATE_WINDOW ?? '1 minute',
  // Bootstrap user, created only when the users table is empty.
  bootstrapUser: process.env.SONORA_USER ?? 'toil',
  bootstrapPass: process.env.SONORA_PASSPHRASE ?? '',
  // Stream URL cache lifetime. YouTube embeds `expire` (~6h); refresh early.
  urlTtlMs: int('SONORA_URL_TTL_MS', 3 * 60 * 60 * 1000),
  resolveTimeoutMs: int('SONORA_RESOLVE_TIMEOUT_MS', 25_000),
  upstreamTimeoutMs: int('SONORA_UPSTREAM_TIMEOUT_MS', 20_000),
  // Trust the tunnel/proxy for client IPs (rate limiting).
  trustProxy: (process.env.SONORA_TRUST_PROXY ?? '1') === '1',
  // Listen Together rooms. A room is one shared playhead (see docs/rooms.md);
  // it is deleted when it has been idle this long with nobody connected, or an
  // hour after the host ends it. The member cap is what keeps a room a room
  // instead of a broadcast.
  roomHours: int('SONORA_ROOM_HOURS', 12),
  roomMaxMembers: int('SONORA_ROOM_MAX_MEMBERS', 50),

  // Absolute origin used in share-card URLs (og:url, og:image, oEmbed). Behind
  // a tunnel the origin the crawler used is not the one the process sees, so
  // this is the honest answer; empty falls back to the request's Host header.
  publicUrl: (process.env.SONORA_PUBLIC_URL ?? '').replace(/\/+$/, ''),

  // YouTube bot-gating. Since 2026-10-19 this host intermittently gets
  // "Sign in to confirm you're not a bot" (LOGIN_REQUIRED). The gate is applied
  // per-IP and comes and goes, so three independent mitigations are wired:
  //   1. a PO-token provider (defeats client-level checks, not IP-level ones)
  //   2. a JS runtime (yt-dlp needs one for full extraction)
  //   3. a proxy, which is the only thing that actually changes the IP
  ytCookie: process.env.SONORA_YT_COOKIE ?? null,
  ytdlpCookies: process.env.SONORA_YTDLP_COOKIES ?? null,
  // e.g. http://127.0.0.1:8118 (Privoxy) or socks5://127.0.0.1:1080
  ytdlpProxy: process.env.SONORA_YTDLP_PROXY ?? null,
  // bgutil-ytdlp-pot-provider HTTP endpoint; empty string disables it.
  potProviderUrl: process.env.SONORA_POT_PROVIDER ?? 'http://127.0.0.1:4416',
  // yt-dlp needs a JS runtime for some clients; empty string disables.
  jsRuntime: process.env.SONORA_JS_RUNTIME
    ?? (fs.existsSync(path.join(os.homedir(), '.deno/bin/deno'))
      ? `deno:${path.join(os.homedir(), '.deno/bin/deno')}`
      : ''),
};
