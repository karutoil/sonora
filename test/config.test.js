import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Fastify from 'fastify';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_URL = new URL('../src/config.js', import.meta.url).href;
const MARKER = 'SONORA_CONFIG_JSON:';
const LOAD_CONFIG = `
try {
  const { config } = await import(${JSON.stringify(CONFIG_URL)});
  process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify(config));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}`;

/** Never inherit a developer's or CI runner's deployment settings into a case. */
function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === 'PORT' || name === 'HOST' || name.startsWith('SONORA_')) delete env[name];
  }
  env.SONORA_POT_PROVIDER = '';
  env.SONORA_JS_RUNTIME = '';
  return { ...env, ...overrides };
}

function configProcess(overrides = {}) {
  const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '--eval', LOAD_CONFIG], {
    cwd: ROOT, env: cleanEnvironment(overrides), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `config child timed out: ${child.stderr}`);
  return child;
}

function loadConfig(overrides = {}) {
  const child = configProcess(overrides);
  assert.equal(child.status, 0, `${JSON.stringify(overrides)}\n${child.stderr || child.stdout}`);
  const at = child.stdout.indexOf(MARKER);
  assert.notEqual(at, -1, `config child emitted no JSON: ${child.stdout}\n${child.stderr}`);
  return JSON.parse(child.stdout.slice(at + MARKER.length));
}

function assertInvalid(name, value, overrides = {}) {
  const child = configProcess({ [name]: value, ...overrides });
  assert.notEqual(child.status, 0, `${name}=${JSON.stringify(value)} must fail at boot; got ${child.stdout}`);
  assert.match(child.stderr, new RegExp(name), `${name} error must name the variable: ${child.stderr}`);
  assert.match(child.stderr, /invalid|must equal/i, `${name} error must explain the bad setting: ${child.stderr}`);
}

const NUMERIC_DEFAULTS = {
  PORT: ['port', 8130],
  SONORA_CACHE_MB: ['cacheBytes', 8192 * 1024 * 1024],
  SONORA_MAX_DOWNLOADS: ['maxDownloads', 4],
  SONORA_DOWNLOAD_TIMEOUT_MS: ['downloadTimeoutMs', 120_000],
  SONORA_DOWNLOAD_QUEUE_TIMEOUT_MS: ['queueTimeoutMs', 20_000],
  SONORA_SESSION_MINUTES: ['sessionMinutes', 720],
  SONORA_REFRESH_DAYS: ['refreshDays', 30],
  SONORA_SESSION_DAYS: ['sessionDays', 90],
  SONORA_REFRESH_GRACE_MS: ['refreshGraceMs', 30_000],
  SONORA_LOGIN_RATE_MAX: ['loginRateMax', 10],
  SONORA_URL_TTL_MS: ['urlTtlMs', 10_800_000],
  SONORA_RESOLVE_TIMEOUT_MS: ['resolveTimeoutMs', 25_000],
  SONORA_UPSTREAM_TIMEOUT_MS: ['upstreamTimeoutMs', 20_000],
  SONORA_ROOM_HOURS: ['roomHours', 12],
  SONORA_ROOM_MAX_MEMBERS: ['roomMaxMembers', 50],
  SONORA_ROOM_MAX_PER_HOST: ['roomMaxPerHost', 5],
  SONORA_QUEUE_COVER_MS: ['queueCoverMs', 86_400_000],
};
const NUMERIC_NAMES = Object.keys(NUMERIC_DEFAULTS);
const MAX_TIMER_MS = 2_147_483_647;
const MAX_DATE_MS = 8_640_000_000_000_000;

test('defaults and blank numeric settings are isolated from ambient environment', () => {
  const defaults = loadConfig();
  for (const [name, [key, expected]] of Object.entries(NUMERIC_DEFAULTS)) {
    assert.equal(defaults[key], expected, `${name} default`);
    for (const blank of ['   ', '\t\r\n']) {
      const config = loadConfig({ [name]: blank });
      assert.equal(config[key], expected, `${name} blank value must retain its default`);
    }
  }
});

test('every numeric setting rejects partial integers, exponents, negatives and unsafe values', () => {
  for (const name of NUMERIC_NAMES) {
    for (const value of ['12junk', '1e3', '-1', '9007199254740992']) assertInvalid(name, value);
  }
  for (const value of ['1.5', '0x10', 'Infinity', 'NaN', '+12', '1_000', '1ms', '-0']) {
    assertInvalid('PORT', value);
  }
});

test('ports, timer delays, scaled cache sizes and Date-based lifetimes reject overflow', () => {
  for (const value of ['0', '65536']) assertInvalid('PORT', value);
  for (const name of [
    'SONORA_DOWNLOAD_TIMEOUT_MS', 'SONORA_DOWNLOAD_QUEUE_TIMEOUT_MS',
    'SONORA_REFRESH_GRACE_MS', 'SONORA_URL_TTL_MS', 'SONORA_QUEUE_COVER_MS',
    'SONORA_RESOLVE_TIMEOUT_MS', 'SONORA_UPSTREAM_TIMEOUT_MS',
  ]) assertInvalid(name, String(MAX_TIMER_MS + 1));

  const maxCacheMb = Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024));
  assertInvalid('SONORA_CACHE_MB', String(maxCacheMb + 1));
  const dateCases = [
    ['SONORA_SESSION_MINUTES', 60_000],
    ['SONORA_REFRESH_DAYS', 86_400_000],
    ['SONORA_SESSION_DAYS', 86_400_000],
    ['SONORA_ROOM_HOURS', 3_600_000],
  ];
  for (const [name, unitMs] of dateCases) {
    const beyondDate = Math.floor((MAX_DATE_MS - Date.now()) / unitMs) + 1000;
    assertInvalid(name, String(beyondDate));
  }
});

test('intentional zeros survive; legacy nonfunctional zeroes clamp to one unit', () => {
  const zero = loadConfig({
    SONORA_CACHE_MB: '0', SONORA_REFRESH_GRACE_MS: '0', SONORA_ROOM_HOURS: '0',
    SONORA_SESSION_MINUTES: '0', SONORA_REFRESH_DAYS: '0', SONORA_SESSION_DAYS: '0',
    SONORA_DOWNLOAD_TIMEOUT_MS: '0', SONORA_MAX_DOWNLOADS: '0',
    SONORA_DOWNLOAD_QUEUE_TIMEOUT_MS: '0', SONORA_LOGIN_RATE_MAX: '0',
    SONORA_RESOLVE_TIMEOUT_MS: '0', SONORA_UPSTREAM_TIMEOUT_MS: '0',
    SONORA_ROOM_MAX_MEMBERS: '0', SONORA_QUEUE_COVER_MS: '0',
  });
  assert.equal(zero.cacheBytes, 0);
  assert.equal(zero.refreshGraceMs, 0);
  assert.equal(zero.roomHours, 0);
  for (const key of [
    'sessionMinutes', 'refreshDays', 'sessionDays', 'downloadTimeoutMs', 'maxDownloads',
    'queueTimeoutMs', 'loginRateMax', 'resolveTimeoutMs', 'upstreamTimeoutMs', 'roomMaxMembers',
    'queueCoverMs',
  ]) assert.equal(zero[key], 1, `${key} legacy zero clamp`);
  // A per-host room cap of zero would mean "nobody may host", which is not a
  // meaningful deployment: it is a bad setting, not a clampable zero.
  assertInvalid('SONORA_ROOM_MAX_PER_HOST', '0');
  assert.equal(loadConfig({ SONORA_ROOM_MAX_PER_HOST: '12' }).roomMaxPerHost, 12);

  const valid = loadConfig({
    PORT: ' 8131 ', SONORA_CACHE_MB: '1', SONORA_SESSION_DAYS: '14',
    SONORA_DOWNLOAD_TIMEOUT_MS: String(MAX_TIMER_MS),
  });
  assert.equal(valid.port, 8131);
  assert.equal(valid.cacheBytes, 1024 * 1024);
  assert.equal(valid.sessionDays, 14);
  assert.equal(valid.refreshDays, 14, 'legacy alias is used when REFRESH_DAYS is absent');
  assert.equal(valid.downloadTimeoutMs, MAX_TIMER_MS);
  assert.equal(loadConfig({ SONORA_SESSION_DAYS: '14', SONORA_REFRESH_DAYS: '21' }).refreshDays, 21);

  const maxDays = Math.floor((MAX_DATE_MS - Date.now()) / 86_400_000) - 10;
  const dated = loadConfig({ SONORA_REFRESH_DAYS: String(maxDays) });
  assert.ok(Number.isFinite(new Date(Date.now() + dated.refreshDays * 86_400_000).getTime()),
    'an accepted refresh lifetime must produce a valid Date');
});

test('blank path, passkey, public URL, cookie and rate-window settings retain defaults', () => {
  const defaults = loadConfig();
  const config = loadConfig({
    HOST: '  ', SONORA_DB: '\t', SONORA_AUDIO_DIR: ' \r\n', SONORA_RP_ID: ' ',
    SONORA_ORIGIN: '', SONORA_RP_NAME: '\t', SONORA_PUBLIC_URL: ' ',
    SONORA_SECURE_COOKIES: '', SONORA_LOGIN_RATE_WINDOW: '  ', SONORA_TRUST_PROXY: '\t',
    SONORA_YT_COOKIE: ' \t', SONORA_YTDLP_COOKIES: ' ', SONORA_YTDLP_PROXY: '\r\n',
    SONORA_POT_PROVIDER: '\t', SONORA_JS_RUNTIME: '  ',
  });
  for (const key of [
    'host', 'dbPath', 'audioDir', 'rpId', 'origin', 'rpName', 'publicUrl',
    'secureCookies', 'loginRateWindow', 'trustProxy', 'ytCookie', 'ytdlpCookies',
    'ytdlpProxy', 'potProviderUrl', 'jsRuntime',
  ]) assert.deepEqual(config[key], defaults[key], key);
});

test('secret whitespace semantics agree with the container entrypoint', () => {
  for (const secret of ['', ' ', ' \t\r\n', '\u00a0\ufeff\u2003']) {
    const config = loadConfig({ SONORA_SECRET: secret });
    assert.equal(config.isDev, true, JSON.stringify(secret));
    assert.match(config.secret, /^[a-f0-9]{64}$/, 'blank secrets get an ephemeral random key');
    const entrypoint = spawnSync('/bin/sh', ['scripts/container-entrypoint.sh', process.execPath, '--eval', ''], {
      cwd: ROOT, env: cleanEnvironment({ SONORA_SECRET: secret }), encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(entrypoint.status, 0, 'the container must reject the same absent secret');
    assert.match(entrypoint.stderr, /SONORA_SECRET/);
  }
  assert.notEqual(loadConfig({ SONORA_SECRET: '' }).secret, loadConfig({ SONORA_SECRET: '' }).secret,
    'development defaults must not share a fixed signing key');
  const configured = loadConfig({ SONORA_SECRET: ' \t config-secret \r\n' });
  assert.equal(configured.isDev, false);
  assert.equal(configured.secret, 'config-secret');
  const entrypoint = spawnSync('/bin/sh', [
    'scripts/container-entrypoint.sh', process.execPath, '--eval', '',
  ], {
    cwd: ROOT, env: cleanEnvironment({ SONORA_SECRET: ' \t config-secret \r\n' }), timeout: 10_000,
  });
  assert.equal(entrypoint.status, 0, 'a non-whitespace padded secret is present to both entrypoint and config');
});

test('public/passkey origins are canonicalised and bare RP IDs remain development-friendly', () => {
  const defaults = loadConfig();
  assert.equal(defaults.rpId, null);
  assert.equal(defaults.origin, null);
  assert.equal(defaults.publicUrl, '');

  const local = loadConfig({
    SONORA_RP_ID: ' LOCALHOST ', SONORA_ORIGIN: ' http://LOCALHOST:8130/// ',
    SONORA_PUBLIC_URL: ' https://Music.Example.com:443/// ',
  });
  assert.equal(local.rpId, 'localhost');
  assert.equal(local.origin, 'http://localhost:8130');
  assert.equal(local.publicUrl, 'https://music.example.com');

  const parent = loadConfig({
    SONORA_RP_ID: 'EXAMPLE.com', SONORA_ORIGIN: 'https://music.example.com:8443/',
    SONORA_PUBLIC_URL: 'http://192.168.1.20:8130', SONORA_SECURE_COOKIES: ' AUTO ',
  });
  assert.equal(parent.rpId, 'example.com');
  assert.equal(parent.origin, 'https://music.example.com:8443');
  assert.equal(parent.publicUrl, 'http://192.168.1.20:8130');
  assert.equal(parent.secureCookies, 'auto');
  assert.equal(loadConfig({ SONORA_ORIGIN: 'https://music.example.com' }).rpId, null,
    'setting only ORIGIN stays supported');
  assert.equal(loadConfig({ SONORA_RP_ID: 'dev.localhost' }).origin, null,
    'setting only RP_ID stays supported');
  assert.equal(loadConfig({ SONORA_PUBLIC_URL: 'http://[::1]:8130' }).publicUrl, 'http://[::1]:8130');
});

test('malformed, credentialed or non-origin URL and RP settings fail at boot', () => {
  const badOrigins = [
    'music.example.com', '//music.example.com', 'javascript:alert(1)',
    'https://user:pw@example.com', 'https://example.com/app', 'https://example.com?x=1',
    'https://example.com/#fragment', 'https://exa mple.com', 'https://example.com:99999',
  ];
  for (const name of ['SONORA_PUBLIC_URL', 'SONORA_ORIGIN']) {
    for (const value of badOrigins) assertInvalid(name, value);
  }
  for (const value of [
    'https://music.example.com', 'music.example.com/', 'music.example.com:443',
    '127.0.0.1', '::1', '.example.com', '-bad.example', 'bad-.example',
    'example..com', 'devbox', 'music example.com',
  ]) assertInvalid('SONORA_RP_ID', value);
  assertInvalid('SONORA_RP_ID', 'other.example', { SONORA_ORIGIN: 'https://music.example.com' });
  for (const value of ['yes', 'true', 'secure']) assertInvalid('SONORA_SECURE_COOKIES', value);
  for (const mode of ['auto', 'always', 'never']) {
    assert.equal(loadConfig({ SONORA_SECURE_COOKIES: mode.toUpperCase() }).secureCookies, mode);
  }
});

test('the login rate window is a validated duration compatible with the installed parser', () => {
  const { parse } = createRequire(import.meta.url)('@lukeed/ms');
  for (const value of ['1 minute', ' 30 seconds ', '250ms', '2h', '1.5 minutes', '.5s', '1']) {
    const config = loadConfig({ SONORA_LOGIN_RATE_WINDOW: value });
    assert.equal(config.loginRateWindow, value.trim());
    const milliseconds = parse(value.trim());
    assert.ok(Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= MAX_TIMER_MS,
      `${value} must also be understood by @fastify/rate-limit`);
  }
  for (const value of ['soon', '1 fortnight', '0', '0ms', '-1 minute', '1e3ms', `${MAX_TIMER_MS + 1}ms`]) {
    assertInvalid('SONORA_LOGIN_RATE_WINDOW', value);
  }
});

test('a blank bootstrap user keeps the default name, and log level and artwork host are validated', () => {
  const defaults = loadConfig();
  // An empty account name cannot be typed into the sign-in form, so a blank
  // setting keeps the documented default instead of creating an unreachable
  // admin (or refusing to boot over an accidental trailing space).
  assert.equal(defaults.bootstrapUser, 'admin');
  for (const blank of ['', '   ', '\t\r\n']) {
    assert.equal(loadConfig({ SONORA_USER: blank }).bootstrapUser, 'admin', JSON.stringify(blank));
  }
  assert.equal(loadConfig({ SONORA_USER: ' alice ' }).bootstrapUser, 'alice');
  assert.equal(loadConfig({ SONORA_USER: 'alice', SONORA_PASSPHRASE: 'hunter2hunter2' }).bootstrapUser,
    'alice', 'a real name and passphrase boot normally');

  assert.equal(defaults.logLevel, 'info');
  for (const [value, expected] of [
    ['FATAL', 'fatal'], [' error ', 'error'], ['Warn', 'warn'], ['debug', 'debug'],
    ['TRACE', 'trace'], ['silent', 'silent'],
  ]) assert.equal(loadConfig({ SONORA_LOG_LEVEL: value }).logLevel, expected, value);
  assert.equal(loadConfig({ SONORA_LOG_LEVEL: '  ' }).logLevel, 'info', 'a blank level keeps info');
  for (const value of ['verbose', 'warning', '0', 'info,debug']) assertInvalid('SONORA_LOG_LEVEL', value);

  assert.equal(defaults.ytimgHost, 'https://i.ytimg.com');
  assert.equal(loadConfig({ SONORA_YTIMG_HOST: '' }).ytimgHost, 'https://i.ytimg.com');
  assert.equal(loadConfig({ SONORA_YTIMG_HOST: ' i.ytimg.com ' }).ytimgHost, 'https://i.ytimg.com',
    'the documented bare host is completed with https');
  assert.equal(loadConfig({ SONORA_YTIMG_HOST: 'http://127.0.0.1:8139' }).ytimgHost,
    'http://127.0.0.1:8139');
  assert.equal(loadConfig({ SONORA_YTIMG_HOST: 'https://Img.Example.com:8443///' }).ytimgHost,
    'https://img.example.com:8443');
  for (const value of [
    'ftp://i.ytimg.com', 'https://user:pw@i.ytimg.com', 'https://i.ytimg.com/covers',
    'https://i.ytimg.com?x=1', 'https://i.ytimg.com/#x', 'i.yt img.com', 'https://i.ytimg.com:99999',
  ]) assertInvalid('SONORA_YTIMG_HOST', value);
});

test('proxy trust accepts only direct, loopback alias or explicit validated allowlists', () => {
  assert.equal(loadConfig().trustProxy, false);
  assert.equal(loadConfig({ SONORA_TRUST_PROXY: '' }).trustProxy, false);
  assert.equal(loadConfig({ SONORA_TRUST_PROXY: '0' }).trustProxy, false);
  assert.equal(loadConfig({ SONORA_TRUST_PROXY: '1' }).trustProxy, 'loopback');
  for (const value of [
    '127.0.0.1', '::1', '10.0.0.0/8', '2001:db8::/32',
    ' 127.0.0.1, ::1, 10.0.0.0/8 ', 'loopback,linklocal,uniquelocal',
  ]) assert.equal(loadConfig({ SONORA_TRUST_PROXY: value }).trustProxy, value.trim());
  for (const value of [
    'true', 'TRUE', '2', '999999999999999999999', '01', '-1', '1.5', '0x1',
    'false', 'proxy.internal', '*', '0.0.0.0/0', '::/0', '127.0.0.1/33',
    '::1/129', '127.0.0.1/', '127.0.0.1,,::1',
  ]) assertInvalid('SONORA_TRUST_PROXY', value);
});

async function forwardedContext(trustProxy, remoteAddress, headers = {}) {
  const app = Fastify({ trustProxy });
  app.get('/', (req) => ({ ip: req.ip, host: req.host, protocol: req.protocol }));
  try {
    const response = await app.inject({
      method: 'GET', url: '/', remoteAddress,
      headers: {
        host: 'direct.local:8130',
        'x-forwarded-for': '203.0.113.9, 198.51.100.7',
        'x-forwarded-host': 'spoofed.example, public.example:8443',
        'x-forwarded-proto': 'javascript, https',
        ...headers,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  } finally {
    await app.close();
  }
}

test('installed Fastify ignores all forwarded context from direct or unlisted peers', async () => {
  for (const trustProxy of [false, 'loopback']) {
    const remoteAddress = trustProxy === false ? '203.0.113.44' : '192.168.50.9';
    assert.deepEqual(await forwardedContext(trustProxy, remoteAddress), {
      ip: remoteAddress, host: 'direct.local:8130', protocol: 'http',
    });
  }
});

test('installed Fastify honors host/scheme only for allowlisted peers and stops XFF at an untrusted hop', async () => {
  for (const [trustProxy, remoteAddress] of [
    ['loopback', '127.0.0.1'],
    ['192.168.50.0/24', '192.168.50.7'],
    ['2001:db8::/32', '2001:db8::7'],
  ]) {
    assert.deepEqual(await forwardedContext(trustProxy, remoteAddress), {
      ip: '198.51.100.7', host: 'public.example:8443', protocol: 'https',
    });
  }
});
