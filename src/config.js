import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Node clamps larger delays to 1 ms. Absolute dates have a separate, much larger
// ceiling, but Date.now() +/- a lifetime still has to remain a valid timestamp.
const MAX_TIMER_MS = 2_147_483_647;
const MAX_DATE_MS = 8_640_000_000_000_000;
const maxDateUnits = (unitMs) => Math.max(1,
  Math.floor((MAX_DATE_MS - Date.now()) / unitMs) - 1);

function invalid(name, _value, expected) {
  // Do not echo the value: malformed URL settings may contain pasted credentials.
  throw new Error(`${name} is invalid: expected ${expected}.`);
}

/** Parse the whole value; a blank optional setting retains its default. */
function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, unitMs = 1 } = {}) {
  const value = process.env[name];
  if (value === undefined || !value.trim()) return fallback;
  const raw = value.trim();
  if (!/^-?\d+$/.test(raw)) invalid(name, value, 'a whole base-10 integer (no suffix, decimal or exponent)');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) invalid(name, value, 'a safe base-10 integer');
  if (raw.startsWith('-') || parsed < min || parsed > max) {
    invalid(name, value, `an integer from ${min} through ${max}`);
  }
  if (!Number.isSafeInteger(parsed * unitMs)) invalid(name, value, 'a value whose converted duration is safe');
  return parsed;
}

/**
 * Backwards-compatible handling for the old documented zero lifetime/count
 * footgun: zero becomes one. Junk, negatives and overflows are not clamped —
 * silently falling back for those hides a misspelled production setting.
 */
function positiveInt(name, fallback, options = {}) {
  const value = int(name, fallback, { ...options, min: 0 });
  return value === 0 ? 1 : value;
}

const PROXY_ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Validate here as well as in Fastify so the boot error names the setting. */
function validProxyEntry(name, entry) {
  if (PROXY_ALIASES.has(entry)) return;
  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (!family) invalid(name, entry, 'proxy IPs/CIDRs, loopback, linklocal or uniquelocal');
  if (slash === -1) return;
  const prefix = entry.slice(slash + 1);
  const max = family === 4 ? 32 : 128;
  // @fastify/proxy-addr also rejects /0; more importantly, a match-all trust
  // entry is the same vulnerability as trustProxy=true.
  if (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > max) {
    invalid(name, entry, `a CIDR prefix from 1 through ${max}`);
  }
}

/**
 * Only authenticated proxy peers may influence req.ip, req.host or req.protocol.
 * Fastify 5.12.7 treats numeric hop counts as fail-closed, not as a safe alias,
 * and true trusts every hop (including the client's left-most X-Forwarded-For).
 * Keep 0/direct and 1/loopback for compatibility; every other deployment must
 * name its actual proxy addresses or networks.
 */
function proxyTrust(name) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw || raw === '0') return false;
  if (raw === '1') return 'loopback';
  if (/^\d+$/.test(raw)) {
    throw new Error(`${name}=${raw} is invalid: hop counts are not supported. `
      + 'Use 0 for direct access, 1 for a loopback proxy, or proxy IPs/CIDRs.');
  }
  if (raw.toLowerCase() === 'true') {
    throw new Error(`${name}=true is invalid: it trusts forged forwarding headers. `
      + 'List the actual proxy IPs/CIDRs instead.');
  }
  const entries = raw.split(',').map((entry) => entry.trim());
  for (const entry of entries) validProxyEntry(name, entry);
  return raw;
}

/** Present-but-blank optional strings are unset, not values with magic meaning. */
function str(name) {
  const value = (process.env[name] ?? '').trim();
  return value || null;
}

/** Paths may contain significant edge whitespace; only use blankness as absence. */
function pathSetting(name, fallback) {
  const value = process.env[name];
  return value?.trim() ? value : fallback;
}

/** These settings are origins, not arbitrary URLs to concatenate into cards. */
function originSetting(name) {
  const raw = str(name);
  if (!raw) return null;
  if (/\s/.test(raw)) invalid(name, raw, 'an origin without whitespace');
  let url;
  try {
    url = new URL(raw);
  } catch {
    invalid(name, raw, 'an absolute http:// or https:// origin');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || !/^\/+$/.test(url.pathname) || url.search || url.hash) {
    invalid(name, raw, 'an http(s) origin with no credentials, path, query or fragment');
  }
  return url.origin;
}

/** WebAuthn RP IDs are bare DNS names; localhost is the development exception. */
function rpIdSetting(name) {
  const raw = str(name);
  if (!raw) return null;
  const value = raw.toLowerCase();
  const localhost = value === 'localhost' || value.endsWith('.localhost');
  const domain = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value);
  if ((!localhost && !domain) || isIP(value)) {
    invalid(name, raw, 'a bare DNS name without a scheme, port or IP address (localhost works in development)');
  }
  return value;
}

function secureCookieSetting(name) {
  const value = (str(name) ?? 'auto').toLowerCase();
  if (!['auto', 'always', 'never'].includes(value)) {
    invalid(name, process.env[name], 'auto, always or never');
  }
  return value;
}

const TIME_UNITS = {
  ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, wks: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  y: 31_557_600_000, yr: 31_557_600_000, yrs: 31_557_600_000,
  year: 31_557_600_000, years: 31_557_600_000,
};

/** Match @fastify/rate-limit's duration strings, but never accept undefined/NaN. */
function loginWindowSetting(name) {
  const value = str(name) ?? '1 minute';
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/i.exec(value);
  const milliseconds = match
    ? Number(match[1]) * (TIME_UNITS[match[2].toLowerCase()] ?? (match[2] ? Number.NaN : 1))
    : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > MAX_TIMER_MS) {
    invalid(name, value, `a positive duration no greater than ${MAX_TIMER_MS} ms (for example "1 minute")`);
  }
  return value;
}

// The default database file was data/muse.db before the rename. An existing
// install keeps its library and accounts by continuing to use that file; a
// fresh clone starts on data/sonora.db.
const DEFAULT_DB = fs.existsSync(new URL('../data/muse.db', import.meta.url).pathname)
  ? new URL('../data/muse.db', import.meta.url).pathname
  : new URL('../data/sonora.db', import.meta.url).pathname;

// An env var that is present but empty (SONORA_SECRET= in a compose file or a
// `docker run -e SONORA_SECRET`) must count as *unset*: `??` alone would accept
// the empty string, which is a fixed signing key shared by every instance — the
// exact failure the per-process random default exists to prevent.
const configuredSecret = (process.env.SONORA_SECRET ?? '').trim();

export const config = {
  port: int('PORT', 8130, { min: 1, max: 65_535 }),
  host: str('HOST') ?? '127.0.0.1',
  dbPath: pathSetting('SONORA_DB', DEFAULT_DB),
  audioDir: pathSetting('SONORA_AUDIO_DIR', new URL('../data/audio', import.meta.url).pathname),
  // yt-dlp downloads far faster than realtime; this is a safety ceiling.
  //
  // A zero concurrency/timeout used to wedge playback or kill every download, so
  // those legacy zeroes retain their one-unit compatibility clamp. The cache is
  // different: zero is an intentional bound, while a negative cache is rejected.
  downloadTimeoutMs: positiveInt('SONORA_DOWNLOAD_TIMEOUT_MS', 120_000, { max: MAX_TIMER_MS }),
  maxDownloads: positiveInt('SONORA_MAX_DOWNLOADS', 4),
  cacheBytes: int('SONORA_CACHE_MB', 8192, {
    max: Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024)), unitMs: 1024 * 1024,
  }) * 1024 * 1024,
  // How long a request may wait for a download slot before answering "busy".
  //
  // The wait used to be an unbounded FIFO: a listener who skipped four tracks
  // left four 120-second downloads holding every slot, and the track they
  // actually wanted queued behind them — minutes of silence per press of play,
  // with no way for the browser to give up (the request had no abort either).
  // Bounded, the request fails fast and the player moves on.
  queueTimeoutMs: positiveInt('SONORA_DOWNLOAD_QUEUE_TIMEOUT_MS', 20_000, { max: MAX_TIMER_MS }),
  // Shared secret for session cookies. Required in production; generated
  // per-process in dev so a forgotten env var can never ship a fixed key.
  secret: configuredSecret || crypto.randomBytes(32).toString('hex'),
  isDev: !configuredSecret,
  // Access tokens are short-lived; a remembered device silently renews one with
  // its refresh token. Without "remember me" the cookie is session-scoped, so
  // closing the browser signs the device out.
  sessionMinutes: positiveInt('SONORA_SESSION_MINUTES', 12 * 60, {
    max: maxDateUnits(60_000), unitMs: 60_000,
  }),
  refreshDays: positiveInt('SONORA_REFRESH_DAYS', positiveInt('SONORA_SESSION_DAYS', 30, {
    max: maxDateUnits(86_400_000), unitMs: 86_400_000,
  }), { max: maxDateUnits(86_400_000), unitMs: 86_400_000 }),
  // Legacy name kept so an existing SONORA_SESSION_DAYS deployment keeps working.
  sessionDays: positiveInt('SONORA_SESSION_DAYS', 90, {
    max: maxDateUnits(86_400_000), unitMs: 86_400_000,
  }),
  // Refresh-token rotation is not idempotent: two tabs (or one response lost in
  // flight) each present the same token, and the second presentation used to be
  // treated as theft — deleting the device and signing the whole browser out.
  // Within this window a replay of a just-rotated token rotates its successor
  // forward and answers 200; outside it, the theft response stands. 0 disables
  // the window (the strict behaviour).
  refreshGraceMs: int('SONORA_REFRESH_GRACE_MS', 30_000, { max: MAX_TIMER_MS }),
  // `Secure` cookies. 'auto' follows the request scheme: always Secure over
  // HTTPS (including a trusted proxy's x-forwarded-proto), never over plain
  // HTTP except on localhost, which browsers treat as a secure context. Deriving
  // it from "is a secret configured" made LAN sign-in over http://192.168.x.x
  // silently fail: the browser dropped the cookie, /api/me answered 401 and the
  // form just came back. 'always'/'never' are the manual overrides for setups a
  // request cannot describe (a TLS terminator that does not forward the scheme).
  secureCookies: secureCookieSetting('SONORA_SECURE_COOKIES'),

  // WebAuthn / passkeys. A passkey is bound to a registrable domain, not an IP,
  // so these default to the request host and must be set explicitly when the
  // public origin differs from what Fastify sees (a tunnel or reverse proxy).
  rpId: rpIdSetting('SONORA_RP_ID'),
  origin: originSetting('SONORA_ORIGIN'),
  rpName: str('SONORA_RP_NAME') ?? 'sonora',
  // Sign-in attempts per window, per client. Ten a minute is generous for one
  // person and hostile to a script; raise it for a household sharing one IP.
  loginRateMax: positiveInt('SONORA_LOGIN_RATE_MAX', 10),
  loginRateWindow: loginWindowSetting('SONORA_LOGIN_RATE_WINDOW'),
  // Bootstrap user, created only when the users table is empty.
  bootstrapUser: (process.env.SONORA_USER ?? 'admin').trim(),
  bootstrapPass: process.env.SONORA_PASSPHRASE ?? '',
  // Stream URL lifetime, reported to the admin panel. The Innertube-resolved
  // URL cache this used to bound is gone: audio is fetched once into the local
  // content cache instead of proxied from an expiring googlevideo URL.
  urlTtlMs: int('SONORA_URL_TTL_MS', 3 * 60 * 60 * 1000, { max: MAX_TIMER_MS }),
  resolveTimeoutMs: positiveInt('SONORA_RESOLVE_TIMEOUT_MS', 25_000, { max: MAX_TIMER_MS }),
  upstreamTimeoutMs: positiveInt('SONORA_UPSTREAM_TIMEOUT_MS', 20_000, { max: MAX_TIMER_MS }),
  // Trust the tunnel/proxy for client IPs (rate limiting). Off by default: on,
  // any client can rotate X-Forwarded-For and get a fresh login-rate-limit
  // bucket per request, which turns the passphrase check into a free oracle.
  // A loopback-only tunnel may use the 1 alias. A tunnel in another container or
  // on a LAN must list its actual peer address/CIDR instead. See .env.example.
  trustProxy: proxyTrust('SONORA_TRUST_PROXY'),
  // Listen Together rooms. A room is one shared playhead (see docs/rooms.md);
  // it is deleted when it has been idle this long with nobody connected, or an
  // hour after the host ends it. The member cap is what keeps a room a room
  // instead of a broadcast.
  roomHours: int('SONORA_ROOM_HOURS', 12, {
    max: maxDateUnits(3_600_000), unitMs: 3_600_000,
  }),
  roomMaxMembers: positiveInt('SONORA_ROOM_MAX_MEMBERS', 50),

  // Absolute origin used in share-card URLs (og:url, og:image, oEmbed). Behind
  // a tunnel the origin the crawler used is not the one the process sees, so
  // this is the honest answer; empty falls back to the request's Host header.
  publicUrl: originSetting('SONORA_PUBLIC_URL') ?? '',

  // YouTube bot-gating. Since 2026-10-19 this host intermittently gets
  // "Sign in to confirm you're not a bot" (LOGIN_REQUIRED). The gate is applied
  // per-IP and comes and goes, so three independent mitigations are wired:
  //   1. a PO-token provider (defeats client-level checks, not IP-level ones)
  //   2. a JS runtime (yt-dlp needs one for full extraction)
  //   3. a proxy, which is the only thing that actually changes the IP
  ytCookie: str('SONORA_YT_COOKIE'),
  ytdlpCookies: pathSetting('SONORA_YTDLP_COOKIES', null),
  // e.g. http://127.0.0.1:8118 (Privoxy) or socks5://127.0.0.1:1080
  ytdlpProxy: str('SONORA_YTDLP_PROXY'),
  // bgutil-ytdlp-pot-provider HTTP endpoint; blank whitespace disables it.
  potProviderUrl: str('SONORA_POT_PROVIDER')
    ?? (process.env.SONORA_POT_PROVIDER === undefined ? 'http://127.0.0.1:4416' : ''),
  // yt-dlp needs a JS runtime for some clients; blank whitespace disables.
  jsRuntime: str('SONORA_JS_RUNTIME')
    ?? (process.env.SONORA_JS_RUNTIME === undefined
      ? (fs.existsSync(path.join(os.homedir(), '.deno/bin/deno'))
        ? `deno:${path.join(os.homedir(), '.deno/bin/deno')}` : '')
      : ''),
};

// WebAuthn permits an exact host or a parent domain, never an unrelated RP ID.
// Catch a pair that could never complete a ceremony before opening the port.
if (config.rpId && config.origin) {
  const host = new URL(config.origin).hostname.toLowerCase();
  if (host !== config.rpId && !host.endsWith(`.${config.rpId}`)) {
    throw new Error('SONORA_RP_ID must equal SONORA_ORIGIN\'s hostname or be one of its parent domains.');
  }
}

// A blank account name is unreachable: nothing can be typed that signs into it,
// and it is created as the instance's only admin. Fail at boot with the reason
// instead of handing back an app nobody can log into.
if (config.bootstrapPass && !config.bootstrapUser) {
  throw new Error(
    'SONORA_USER is blank but SONORA_PASSPHRASE is set. Set a name (e.g. SONORA_USER=you) '
    + 'or unset the passphrase — an empty account name cannot be signed into.',
  );
}
