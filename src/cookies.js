import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

// Cookie storage.
//
// YouTube cookies are as sensitive as a password: they grant account access.
// So they are encrypted at rest (AES-256-GCM, key derived from SONORA_SECRET),
// never logged, never returned to a client, and the materialised cookies.txt is
// written 0600.

const SALT = 'sonora-cookie-v1';
let keyCache = null;

function key() {
  keyCache ??= crypto.scryptSync(config.secret, SALT, 32);
  return keyCache;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob) {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function dbGet(name) {
  return db.prepare('SELECT value FROM secrets WHERE name = ?').get(name)?.value ?? null;
}

function dbSet(name, value) {
  db.prepare(`
    INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(name, value, new Date().toISOString());
}

function dbDel(name) {
  db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
}

export { dbGet, dbSet, dbDel };

// ── Netscape cookies.txt ────────────────────────────────────────────────
// Format: domain, flag, path, secure, expiry, name, value (tab separated).
// Lines starting with #HttpOnly_ carry the HttpOnly prefix; the leading '#' is
// part of the domain marker, not a comment.

// JS Date's largest representable millisecond value is ±8.64e15. Keeping the
// persisted seconds below that boundary makes inspectJar/saveJar total: an
// imported 1e400 can never become Infinity or make toISOString() throw.
const MAX_COOKIE_EXPIRY = 8_640_000_000_000;

function normaliseExpiry(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return 0;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const expiry = Number(value);
  if (!Number.isFinite(expiry) || expiry < 0 || expiry > MAX_COOKIE_EXPIRY) return null;
  return Math.floor(expiry);
}

function cleanCookieField(value) {
  // Besides being invalid cookie data, C0/DEL characters can inject a new
  // Netscape column/row or a second Cookie header when re-serialised.
  return typeof value === 'string' && !/[\0-\x1f\x7f]/.test(value);
}

function normaliseCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return null;
  const { domain, name, value } = cookie;
  const flag = cookie.hostOnly === true
    ? 'FALSE'
    : String(cookie.flag ?? 'TRUE').toUpperCase();
  const cookiePath = cookie.path ?? '/';
  const expiry = normaliseExpiry(cookie.expiry ?? 0);
  if (!cleanCookieField(domain) || !domain
    || !cleanCookieField(name) || !name || /[;=\s]/.test(name)
    || !cleanCookieField(value) || /[;]/.test(value)
    || !cleanCookieField(cookiePath) || !cookiePath.startsWith('/')
    || !['TRUE', 'FALSE'].includes(flag) || expiry === null) return null;
  return {
    domain,
    flag,
    path: cookiePath,
    secure: cookie.secure === true || cookie.secure === 'TRUE',
    expiry,
    name,
    value,
    httpOnly: Boolean(cookie.httpOnly),
  };
}

export function parseNetscape(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw;
    if (!line.trim()) continue;
    const comment = line.trimStart();
    if (comment.startsWith('#') && !comment.startsWith('#HttpOnly_')) continue;
    const httpOnly = line.startsWith('#HttpOnly_');
    if (line.startsWith('#') && !httpOnly) continue; // real comment
    const rest = httpOnly ? line.slice('#HttpOnly_'.length) : line;
    const parts = rest.split('\t');
    // A tab in a value is an extra Netscape field, not harmless cookie data.
    // Reject the whole jar rather than silently importing a privileged subset.
    if (parts.length !== 7) return [];
    const [domain, flag, cookiePath, secure, expiry, name, value] = parts;
    const cookie = normaliseCookie({
      domain, flag, path: cookiePath, secure: secure.toUpperCase(), expiry, name, value, httpOnly,
    });
    if (!cookie || !['TRUE', 'FALSE'].includes(secure.toUpperCase())) return [];
    out.push(cookie);
  }
  return out;
}

/**
 * Parse a JSON cookie export (the shape most other extensions produce), so a
 * user is not dead-ended just because their exporter is not the one we name.
 * Accepts both {name,value,domain} and {name,value,host} entries.
 */
export function parseJsonCookies(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const arr = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : null;
  if (!arr) return null;
  const out = [];
  for (const c of arr) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return null;
    let domain = c.domain ?? c.host ?? '.youtube.com';
    if (typeof domain !== 'string') return null;
    if (/^https?:\/\//i.test(domain)) {
      try { domain = new URL(domain).hostname; } catch { return null; }
    }
    // WebExtension exports carry hostOnly explicitly. A bare `host` is also
    // host-only; a leading dot remains the common explicit domain-cookie form.
    const hostOnly = typeof c.hostOnly === 'boolean'
      ? c.hostOnly
      : c.domain == null ? true : !domain.startsWith('.');
    const bare = domain.replace(/^\./, '');
    const cookie = normaliseCookie({
      domain: hostOnly ? bare : `.${bare}`,
      flag: hostOnly ? 'FALSE' : 'TRUE',
      path: c.path ?? '/',
      secure: c.secure !== false,
      expiry: c.expirationDate ?? c.expires ?? 0,
      name: c.name,
      value: c.value,
      httpOnly: c.httpOnly,
    });
    if (!cookie) return null;
    out.push(cookie);
  }
  return out.length ? out : null;
}

/** Auto-detect the export format so the error message can be about content, not syntax. */
export function parseAny(text) {
  const input = String(text ?? '');
  const raw = input.trim();
  if (!raw) return { format: 'empty', cookies: [] };
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const json = parseJsonCookies(raw);
    return { format: json ? 'json' : 'unknown', cookies: json ?? [] };
  }
  // Detection may trim whitespace; parsing must not turn an injected leading
  // tab into a valid domain before parseNetscape sees it.
  const cookies = parseNetscape(input);
  return { format: cookies.length ? 'netscape' : 'unknown', cookies };
}

// The cookies yt-dlp needs to act as a signed-in viewer. Different accounts
// surface slightly different sets, so require a core identity cookie plus a
// second corroborating one rather than an exact list.
const CORE = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID'];

// The cookie that *is* the session. Their expiry is the only one that says
// whether the jar still works; Google's rotating cookies (__Secure-1PSIDTS, YSC,
// AEC…) expire in hours by design and made a healthy jar look expired.
const IDENTITY = ['SID', '__Secure-1PSID', '__Secure-3PSID'];

function cookieHost(domain) {
  return String(domain ?? '').replace(/^#HttpOnly_/, '').replace(/^\./, '').replace(/\.$/, '').toLowerCase();
}

function inGoogleScope(domain) {
  const host = cookieHost(domain);
  return /(^|\.)youtube\.com$/i.test(host) || /(^|\.)google\.com$/i.test(host);
}

function latestExpiry(cookies) {
  let latest = 0;
  for (const cookie of cookies) {
    const expiry = normaliseExpiry(cookie?.expiry ?? 0);
    if (expiry !== null && expiry > latest) latest = expiry;
  }
  return latest ? new Date(latest * 1000).toISOString() : null;
}

export function inspectJar(cookies) {
  const scoped = cookies.filter((c) => inGoogleScope(c?.domain));
  const names = new Set(scoped.map((c) => c.name));
  const present = CORE.filter((n) => names.has(n));
  const hasIdentity = names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
  const identities = scoped.filter((c) => IDENTITY.includes(c.name) && normaliseExpiry(c.expiry ?? 0) > 0);
  return {
    total: cookies.length,
    youtubeCount: scoped.length,
    present,
    hasIdentity,
    // A session with only one cookie cannot authenticate.
    plausible: hasIdentity && present.length >= 2,
    // The identity cookie's own expiry, else the longest-lived scoped cookie.
    // Never the *earliest*: that is a rotating cookie and reporting it flipped
    // a working session to "expired" within the hour.
    expiresAt: latestExpiry(identities.length ? identities : scoped),
    domains: [...new Set(scoped.map((c) => c.domain))],
    // Helpful for the UI: what we saw, so the error can be specific.
    sampleNames: [...names].slice(0, 12),
  };
}

// youtubei.js 18.x applies one cookie string to www.youtube.com/youtubei and
// upload.youtube.com, and reuses it for suggestqueries-clients6.youtube.com.
// Model the main HTTPS request explicitly rather than treating the jar as one
// undifferentiated set. A second URL argument keeps the matching rules testable.
const INNERTUBE_REQUEST = 'https://www.youtube.com/youtubei/v1/search';
const INNERTUBE_SIGN_IN = new Set([...CORE, 'SAPISID']);
const AUTH_SUFFIX = /(?:PSID|PSIDTS|PSIDCC|PAPISID)$/;

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/**
 * Build the static Cookie header consumed by youtubei.js for its HTTPS YouTube
 * request family. Normal domain, host-only, path, Secure and expiry rules apply.
 *
 * One deliberate compatibility exception is required by the library and by the
 * google.com exports this app asks for: it finds SAPISID in this string to mint
 * Innertube authorization. Domain-wide `.google.com` sign-in cookies therefore
 * accompany YouTube requests, but only after their own path/Secure/expiry checks.
 * Host-only Google cookies and unrelated Google/tracking cookies never cross.
 */
export function cookieHeader(cookies, request = INNERTUBE_REQUEST) {
  let url;
  try { url = request instanceof URL ? request : new URL(request); } catch { return ''; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const requestPath = url.pathname || '/';
  const secureRequest = url.protocol === 'https:' || url.protocol === 'wss:';
  const youtubeRequest = /(^|\.)youtube\.com$/.test(host);
  const now = Date.now() / 1000;
  const usable = [];

  for (const [index, cookie] of cookies.entries()) {
    const normal = normaliseCookie(cookie);
    if (!normal || (normal.secure && !secureRequest)
      || (normal.expiry > 0 && normal.expiry <= now)
      || !pathMatches(requestPath, normal.path)) continue;
    const rawDomain = String(normal.domain).replace(/^#HttpOnly_/, '');
    const domain = cookieHost(rawDomain);
    const hostOnly = normal.flag === 'FALSE';
    const domainMatches = hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
    const googleSignIn = youtubeRequest && !hostOnly && rawDomain.toLowerCase() === '.google.com'
      && (INNERTUBE_SIGN_IN.has(normal.name)
        || (normal.name.startsWith('__Secure-') && AUTH_SUFFIX.test(normal.name)));
    if (domainMatches || googleSignIn) usable.push({ ...normal, index });
  }

  usable.sort((a, b) => b.path.length - a.path.length || a.index - b.index);
  return usable.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ── stored state ────────────────────────────────────────────────────────

export function storedCookiesPath() {
  return path.join(path.dirname(config.dbPath), 'youtube-cookies.txt');
}

/**
 * Does the stored jar look like a session that can actually authenticate?
 *
 * Used only to decide whether it is allowed to *shadow* a working
 * SONORA_YTDLP_COOKIES file. Two independent signals: the verdict a live probe
 * recorded at import time ('rejected' is stored on purpose, so the user can see
 * why a jar failed), and `inspectJar().plausible`, which until now was computed
 * and never read.
 *
 * Unreadable is *not* implausible: a permissions problem is not evidence about
 * the cookies, and yt-dlp will report the real error itself.
 */
function storedJarLooksUsable(file) {
  try {
    const meta = JSON.parse(dbGet('youtube_cookies_meta') ?? 'null');
    if (meta?.verdict?.status === 'rejected') return false;
  } catch { /* unreadable metadata: fall through to the file itself */ }
  try {
    return inspectJar(parseNetscape(fs.readFileSync(file, 'utf8'))).plausible;
  } catch {
    return true;
  }
}

/**
 * The cookies file yt-dlp should use: an imported jar if one exists, otherwise
 * whatever SONORA_YTDLP_COOKIES pointed at.
 *
 * The imported jar used to win unconditionally, and the import route
 * deliberately keeps a jar whose verdict is 'rejected' (destroying a
 * possibly-good jar because a *test* failed would be worse). Together that made
 * one bad import permanently disable playback even with a perfectly good
 * SONORA_YTDLP_COOKIES file configured — the env jar could never be reached
 * again. A stored jar that is rejected or implausible now steps aside; a
 * plausible one still wins, so metadata and downloads keep one identity.
 */
function selectedCookieSource() {
  const own = storedCookiesPath();
  const external = config.ytdlpCookies || null;
  const ownExists = fs.existsSync(own);
  const externalExists = Boolean(external && fs.existsSync(external));
  if (ownExists) {
    return externalExists && !storedJarLooksUsable(own)
      ? { source: 'env', path: external }
      : { source: 'imported', path: own };
  }
  return externalExists ? { source: 'env', path: external } : { source: null, path: null };
}

export function activeCookiesPath() {
  return selectedCookieSource().path;
}

export function activeCookieHeader(request) {
  // All consumers use the same selector: a rejected import that steps aside for
  // SONORA_YTDLP_COOKIES must not remain the identity used by Innertube or the
  // identity described by jarStatus().
  const selected = selectedCookieSource();
  if (selected.path) {
    try {
      const header = cookieHeader(parseNetscape(fs.readFileSync(selected.path, 'utf8')), request);
      if (header) return header;
    } catch { /* unreadable file: only the environment has another input */ }
    if (selected.source === 'imported') return null;
  }
  return config.ytCookie || null;
}

/**
 * Write the materialised jar atomically: a 0600 temp file, then a rename.
 *
 * A crash halfway through a plain write leaves a truncated cookies.txt, which
 * yt-dlp reads and reports as an authentication failure — indistinguishable
 * from an expired session. Creating the temp file with the final mode also
 * means the secrets are never readable by anyone else, not even for the instant
 * between create and chmod. The rename is atomic within the directory, so a
 * concurrent yt-dlp run sees either the old jar or the new one.
 */
async function writeJarFile(target, text) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => { /* best effort on odd filesystems */ });
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Serialise cookies as a Netscape cookies.txt — the only format yt-dlp reads.
 * A JSON export stored verbatim is a jar that imports "successfully" and then
 * cannot authenticate anything, because the child cannot parse it.
 */
export function toNetscape(cookies) {
  return cookies.map((input) => {
    const c = normaliseCookie(input);
    if (!c) {
      if (normaliseExpiry(input?.expiry ?? 0) === null) throw new TypeError('Invalid cookie expiry.');
      throw new TypeError('Invalid cookie field: control characters and extra columns are not allowed.');
    }
    const host = c.httpOnly && !c.domain.startsWith('#HttpOnly_')
      ? `#HttpOnly_${c.domain}`
      : c.domain;
    return [
      host,
      c.flag,
      c.path,
      c.secure ? 'TRUE' : 'FALSE',
      c.expiry,
      c.name,
      c.value,
    ].join('\t');
  }).join('\n') + '\n';
}

/** Persist an imported jar: encrypted in the DB, and materialised 0600. */
export async function saveJar(cookies, text, verdict = null) {
  const normalised = cookies.map(normaliseCookie);
  if (normalised.some((c) => !c)) throw new TypeError('Cannot store a malformed cookie jar.');
  const info = inspectJar(normalised);
  // Normalise before writing: `text` may be a JSON export (see parseJsonCookies),
  // and only Netscape cookies.txt is usable by yt-dlp.
  const jarText = toNetscape(normalised);
  await writeJarFile(storedCookiesPath(), jarText);
  dbSet('youtube_cookies', encrypt(jarText));
  dbSet('youtube_cookies_meta', JSON.stringify({
    importedAt: new Date().toISOString(),
    cookieCount: info.total,
    expiresAt: info.expiresAt,
    ...(verdict ? { verdict } : {}),
  }));
  return info;
}

export async function clearJar() {
  const target = storedCookiesPath();
  try {
    await fsp.unlink(target);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  // Only after the active plaintext is gone may its encrypted recovery copy be
  // removed. If a DB delete now fails, disconnect still fails closed and the
  // remaining row can be restored/retried rather than leaving an active secret.
  dbDel('youtube_cookies');
  dbDel('youtube_cookies_meta');
}

/** Re-materialise the jar at boot so a restart does not lose the session. */
export async function restoreJar() {
  const blob = dbGet('youtube_cookies');
  if (!blob) return false;
  try {
    const text = decrypt(blob);
    // Re-serialise on the way out: jars imported before the fix above were
    // stored as the raw export (JSON for some exporters), which yt-dlp cannot
    // read. Normalising here repairs them on the next boot.
    const { cookies } = parseAny(text);
    await writeJarFile(storedCookiesPath(), cookies.length ? toNetscape(cookies) : text);
    return true;
  } catch {
    // Wrong SONORA_SECRET or a corrupt row. Do NOT delete the row: a wrong
    // secret is recoverable by restoring the old one, a deleted jar is not, and
    // silently wiping it (with no log line) looked exactly like "everyone got
    // signed out of YouTube". The materialised file is left as it is.
    console.warn('[sonora] stored YouTube cookie jar could not be decrypted — '
      + 'SONORA_SECRET changed? Keeping the stored copy; re-import to replace it.');
    return false;
  }
}

function statusDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function jarStatus() {
  const selected = selectedCookieSource();
  const imported = selected.source === 'imported';
  const metaRaw = dbGet('youtube_cookies_meta');
  let meta = null;
  try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch { /* ignore */ }

  // Inspect the selected file, not an import that may deliberately have stepped
  // aside. Live counts/expiry supersede stale import stamps in either case.
  let live = null;
  if (selected.path) {
    try { live = inspectJar(parseNetscape(fs.readFileSync(selected.path, 'utf8'))); } catch { /* ignore */ }
  }
  const expiresAt = statusDate(live?.expiresAt)
    ?? (imported ? statusDate(meta?.expiresAt) : null);
  const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
  const storedCount = imported && Number.isInteger(meta?.cookieCount) && meta.cookieCount >= 0
    ? meta.cookieCount
    : null;
  return {
    connected: Boolean(selected.path),
    source: selected.source,
    importedAt: imported ? statusDate(meta?.importedAt) : null,
    cookieCount: live?.total ?? storedCount,
    expiresAt,
    expired: expiresMs !== null && expiresMs < Date.now(),
    // Import verdicts describe only the import, never an environment fallback.
    // 'verified' | 'unproven' | 'rejected' | null — see verifyJar in server.js.
    verdict: imported ? meta?.verdict?.status ?? null : null,
    verdictReason: imported ? meta?.verdict?.reason ?? null : null,
  };
}
