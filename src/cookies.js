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

export function parseNetscape(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let domain = null;
    let rest = null;
    if (line.startsWith('#HttpOnly_')) {
      rest = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue; // real comment
    } else {
      rest = line;
    }
    const parts = rest.split('\t');
    if (parts.length < 7) continue;
    const [dom, flag, pth, secure, expiry, name, ...valueParts] = parts;
    domain = dom;
    out.push({
      domain,
      flag,
      path: pth,
      secure: secure === 'TRUE',
      expiry: Number(expiry) || 0,
      name,
      value: valueParts.join('\t'),
      httpOnly: line.startsWith('#HttpOnly_'),
    });
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
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    const domain = String(c.domain ?? c.host ?? '.youtube.com');
    out.push({
      domain: domain.startsWith('.') ? domain : `.${domain.replace(/^https?:\/\//, '').split('/')[0]}`,
      flag: 'TRUE',
      path: c.path ?? '/',
      secure: c.secure !== false,
      expiry: Number(c.expirationDate ?? c.expires ?? 0) || 0,
      name: c.name,
      value: c.value,
      httpOnly: Boolean(c.httpOnly),
    });
  }
  return out.length ? out : null;
}

/** Auto-detect the export format so the error message can be about content, not syntax. */
export function parseAny(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { format: 'empty', cookies: [] };
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const json = parseJsonCookies(raw);
    return { format: json ? 'json' : 'unknown', cookies: json ?? [] };
  }
  const cookies = parseNetscape(raw);
  return { format: cookies.length ? 'netscape' : 'unknown', cookies };
}

// The cookies yt-dlp needs to act as a signed-in viewer. Different accounts
// surface slightly different sets, so require a core identity cookie plus a
// second corroborating one rather than an exact list.
const CORE = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID'];

function inGoogleScope(domain) {
  const host = String(domain ?? '').replace(/^\./, '');
  return /(^|\.)youtube\.com$/i.test(host) || /(^|\.)google\.com$/i.test(host);
}

export function inspectJar(cookies) {
  const scoped = cookies.filter((c) => inGoogleScope(c.domain));
  const names = new Set(scoped.map((c) => c.name));
  const present = CORE.filter((n) => names.has(n));
  const hasIdentity = names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
  const expiries = scoped.map((c) => c.expiry).filter((e) => e > 0);
  const domains = [...new Set(scoped.map((c) => c.domain))];
  return {
    total: cookies.length,
    youtubeCount: scoped.length,
    present,
    hasIdentity,
    // A session with only one cookie cannot authenticate.
    plausible: hasIdentity && present.length >= 2,
    expiresAt: expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null,
    domains,
    // Helpful for the UI: what we saw, so the error can be specific.
    sampleNames: [...names].slice(0, 12),
  };
}

/** Build a Cookie header from the jar, for Innertube. */
export function cookieHeader(cookies) {
  const usable = cookies.filter((c) => inGoogleScope(c.domain));
  return usable.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ── stored state ────────────────────────────────────────────────────────

export function storedCookiesPath() {
  return path.join(path.dirname(config.dbPath), 'youtube-cookies.txt');
}

/**
 * The cookies file yt-dlp should use: an imported jar if one exists, otherwise
 * whatever SONORA_YTDLP_COOKIES pointed at.
 */
export function activeCookiesPath() {
  const own = storedCookiesPath();
  if (fs.existsSync(own)) return own;
  return config.ytdlpCookies || null;
}

export function activeCookieHeader() {
  if (config.ytCookie) return config.ytCookie;
  const own = storedCookiesPath();
  try {
    if (fs.existsSync(own)) return cookieHeader(parseNetscape(fs.readFileSync(own, 'utf8')));
  } catch { /* fall through */ }
  return null;
}

/** Persist an imported jar: encrypted in the DB, and materialised 0600. */
export async function saveJar(cookies, text, verdict = null) {
  const info = inspectJar(cookies);
  const target = storedCookiesPath();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text, { mode: 0o600 });
  try { await fsp.chmod(target, 0o600); } catch { /* best effort on odd filesystems */ }
  dbSet('youtube_cookies', encrypt(text));
  dbSet('youtube_cookies_meta', JSON.stringify({
    importedAt: new Date().toISOString(),
    cookieCount: info.total,
    expiresAt: info.expiresAt,
    ...(verdict ? { verdict } : {}),
  }));
  return info;
}

export async function clearJar() {
  dbDel('youtube_cookies');
  dbDel('youtube_cookies_meta');
  const target = storedCookiesPath();
  try { await fsp.unlink(target); } catch { /* already gone */ }
}

/** Re-materialise the jar at boot so a restart does not lose the session. */
export async function restoreJar() {
  const blob = dbGet('youtube_cookies');
  if (!blob) return false;
  try {
    const text = decrypt(blob);
    const target = storedCookiesPath();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, { mode: 0o600 });
    try { await fsp.chmod(target, 0o600); } catch { /* ignore */ }
    return true;
  } catch {
    // Wrong SONORA_SECRET or corrupt row: drop it rather than serving garbage.
    await clearJar();
    return false;
  }
}

export function jarStatus() {
  const metaRaw = dbGet('youtube_cookies_meta');
  let meta = null;
  try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch { /* ignore */ }
  const own = fs.existsSync(storedCookiesPath());
  const external = Boolean(config.ytdlpCookies && fs.existsSync(config.ytdlpCookies));
  const expiresAt = meta?.expiresAt ? new Date(meta.expiresAt) : null;
  return {
    connected: own || external,
    source: own ? 'imported' : external ? 'env' : null,
    importedAt: meta?.importedAt ?? null,
    cookieCount: meta?.cookieCount ?? null,
    expiresAt: meta?.expiresAt ?? null,
    expired: Boolean(expiresAt && expiresAt.getTime() < Date.now()),
    // 'verified' | 'unproven' | 'rejected' | null — see verifyJar in server.js.
    verdict: meta?.verdict?.status ?? null,
    verdictReason: meta?.verdict?.reason ?? null,
  };
}
