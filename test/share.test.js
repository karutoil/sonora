import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CHROME, freePort, launch } from './helpers/cdp.js';

// Share cards.
//
// A shared track is rendered by the *receiving* app, from Open Graph tags on a
// URL its crawler fetches with no cookies. Everything here is about that
// contract rather than about the player: the page must be public, absolute and
// self-describing, and the artwork must answer without a session.
//
// The crawler itself cannot be run from a test, so a request with no cookie
// header stands in for it — that is the whole difference between a card and a
// bare URL. The last two tests drive the real page in Chromium, because "the
// tags are present" is not the same claim as "the page works".

const VIDEO = 'dQw4w9WgXcQ';
// Deliberately a real-world title shape: the card has to lose the qualifiers.
const TRACK = {
  videoId: VIDEO,
  title: 'Fixture Artist - Fixture Song (Official Music Video)',
  channel: 'Fixture Artist - Topic',
  durationS: 214,
};
// A title that must never reach the document unescaped.
const NASTY = {
  videoId: 'escaper0001',
  title: 'Bad "Company" - Rock & Roll <script>',
  channel: 'Bad "Company"',
  durationS: 61,
};
const UNKNOWN = 'zzzzzzzzzzz';

let proc;
let base;
let dir;
let cookie = '';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-share-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  proc = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(dir, 'share.db'),
      SONORA_AUDIO_DIR: path.join(dir, 'audio'),
      SONORA_SECRET: 'share-test-secret',
      SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOG_LEVEL: 'warn',
      // Keep every YouTube subprocess out of the critical path.
      SONORA_POT_PROVIDER: '',
      SONORA_JS_RUNTIME: '',
      // Left empty on purpose: the card must fall back to the request's Host.
      SONORA_PUBLIC_URL: '',
      // Direct clients must not be able to forge the public origin or IP bucket.
      SONORA_TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      // A server left over from an earlier run answers health too, on the
      // previous run's database — only our own pid counts as "up".
      const health = r.ok ? await r.json() : null;
      if (health?.pid === proc.pid) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  assert.ok(login.ok, `login failed: ${login.status} ${await login.text()}`);
  cookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie')).split(';')[0];

  // Seeding through the real API: a like remembers the track's metadata, which
  // is exactly how a track the sharer only ever saw in a list gets a row.
  for (const t of [TRACK, NASTY]) {
    const res = await fetch(`${base}/api/likes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...t, like: true }),
    });
    assert.ok(res.ok, `like seed failed: ${res.status} ${await res.text()}`);
  }
});

after(() => {
  proc?.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

/** The crawler's view: no cookies, no session, no JavaScript. */
async function crawl(url) {
  const res = await fetch(url, { redirect: 'manual' });
  return { res, body: await res.text() };
}

/** Read a meta tag's content by property or name. */
function meta(html, key) {
  const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html);
  return m ? m[1] : null;
}

test('the share page is public and describes the track', async () => {
  const { res, body } = await crawl(`${base}/t/${VIDEO}`);

  assert.equal(res.status, 200, 'a crawler has no session, so the page cannot require one');
  assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(res.headers.get('cache-control') ?? '', /public/);

  assert.equal(meta(body, 'og:type'), 'music.song');
  assert.equal(meta(body, 'og:site_name'), 'sonora');
  assert.equal(meta(body, 'og:url'), `${base}/t/${VIDEO}`);

  // The two lines a chat client actually draws.
  assert.equal(meta(body, 'og:title'), 'Fixture Song', 'upload qualifiers must not reach the card');
  assert.equal(meta(body, 'og:description'), 'Fixture Artist \u00b7 3:34');

  // Absolute, same-origin artwork, or the card renders without a picture.
  assert.equal(meta(body, 'og:image'), `${base}/t/${VIDEO}/art.jpg`);
  assert.match(meta(body, 'og:image') ?? '', /^https?:\/\//);
  assert.equal(meta(body, 'og:image:width'), '1280');
  assert.equal(meta(body, 'og:image:height'), '720');

  assert.equal(meta(body, 'twitter:card'), 'summary_large_image');
  assert.equal(meta(body, 'twitter:image'), `${base}/t/${VIDEO}/art.jpg`);
  assert.equal(meta(body, 'music:duration'), '214');

  // Server-rendered: nothing for a crawler to fail to run.
  assert.ok(!/<script[\s>]/i.test(body), 'the share page must not depend on JavaScript');
  assert.match(body, /<link rel="alternate" type="application\/json\+oembed"/);
});

test('the landing page hands the visitor to the app route', async () => {
  const { body } = await crawl(`${base}/t/${VIDEO}`);
  assert.match(body, new RegExp(`class="play" href="${base}/#/t/${VIDEO}"`));
  assert.match(body, /Open in sonora/);
});

test('track metadata is HTML-escaped', async () => {
  const { body } = await crawl(`${base}/t/${NASTY.videoId}`);
  assert.ok(!body.includes('<script>'), 'a title must never become markup');
  assert.equal(meta(body, 'og:title'), 'Rock &amp; Roll &lt;script&gt;');
  assert.equal(meta(body, 'og:description'), 'Bad &quot;Company&quot; \u00b7 1:01');
});

test('a valid but unknown id still renders a card and still links in', async () => {
  const { res, body } = await crawl(`${base}/t/${UNKNOWN}`);
  // Not a 404: the link has to keep working, it just cannot name the track.
  assert.equal(res.status, 200);
  assert.equal(meta(body, 'og:title'), 'A track on sonora');
  assert.match(meta(body, 'og:image') ?? '', /\/icons\/icon-512\.png$/);
  assert.match(body, new RegExp(`href="${base}/#/t/${UNKNOWN}"`));
});

test('a malformed id is a 404 and is not indexed', async () => {
  const { res, body } = await crawl(`${base}/t/not-a-video-id`);
  assert.equal(res.status, 404);
  assert.equal(meta(body, 'robots'), 'noindex');
});

test('the artwork answers without a session', async () => {
  const res = await fetch(`${base}/t/${VIDEO}/art.jpg`, { redirect: 'manual' });
  // Offline this is a 404 from the upstream fetch, which is fine and expected.
  // What must never happen is the 401 a crawler would get from /api/img.
  assert.ok(res.status !== 401 && res.status !== 403,
    `artwork must be public, got ${res.status}`);
  if (res.status === 200) assert.match(res.headers.get('content-type') ?? '', /^image\//);
});

test('the in-app artwork route stays private', async () => {
  // The public sibling exists precisely so this one does not have to change.
  const res = await fetch(`${base}/api/img/${VIDEO}`);
  assert.equal(res.status, 401);
});

test('the API track looked up by a share link answers for an unseen id', async () => {
  // A shared /t/<id> link for a track this instance never upserted used to get
  // a 404 from /api/track/:id ("sonora has not seen yet") even though /t/<id>
  // renders a card and /api/stream/<id> would serve the bytes. The player
  // tolerates a null title/duration, so a valid id must be playable.
  const unknown = await fetch(`${base}/api/track/${UNKNOWN}`, { headers: { cookie } });
  assert.equal(unknown.status, 200, 'a valid but unseen id is not an error');
  const body = await unknown.json();
  assert.equal(body.track.videoId, UNKNOWN);
  assert.equal(body.track.unknown, true);
  assert.equal(body.track.title, null);
  assert.equal(body.track.durationS, null);

  // A known track still carries its real metadata, so the fallback did not
  // replace the normal answer.
  const known = await fetch(`${base}/api/track/${VIDEO}`, { headers: { cookie } });
  assert.equal(known.status, 200);
  const knownBody = await known.json();
  assert.equal(knownBody.track.videoId, VIDEO);
  assert.match(knownBody.track.title, /Fixture Song/);
  assert.equal(knownBody.track.unknown, undefined);

  // A malformed id is still a 400: the fallback is for real ids only.
  assert.equal((await fetch(`${base}/api/track/not-a-video-id`, { headers: { cookie } })).status, 400);
  assert.equal((await fetch(`${base}/api/track/${UNKNOWN}`)).status, 401, 'and it still needs a session');
});

test('release covers on yt3.googleusercontent.com are proxied, not refused', async () => {
  // Album covers moved to yt3.googleusercontent.com, which was on neither this
  // allowlist nor the client's: the browser fetched them from Google (so the
  // art proxy was bypassed) and /api/img?u= answered 400 for them.
  //
  // The client no longer keeps its own list — it rewrites *every* https artwork
  // URL onto /api/img?u= — so this allowlist is now the single gate and a host
  // missing here is a broken cover. Google shards the art across numbered hosts
  // (lh3-lh6.googleusercontent.com, yt1-yt5.ggpht.com), which is why the
  // families are matched by suffix rather than enumerated.
  for (const host of [
    'yt3.googleusercontent.com',
    'lh4.googleusercontent.com',
    'yt4.ggpht.com',
  ]) {
    const url = encodeURIComponent(`https://${host}/ytc/release-cover.jpg`);
    const res = await fetch(`${base}/api/img?u=${url}`, { headers: { cookie } });
    // Offline the upstream fetch fails, which is a 404 (or the body is served).
    // What must not happen is the host being refused.
    assert.notEqual(res.status, 400, `${host} must be allowlisted`);
    await res.arrayBuffer();
  }

  // A lookalike domain is not "the same family": the leading dot matters.
  const lookalike = encodeURIComponent('https://evilgoogleusercontent.com/x.jpg');
  const bad = await fetch(`${base}/api/img?u=${lookalike}`, { headers: { cookie } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not allowed/i);

  // A host that is not a YouTube image host is still refused.
  const other = await fetch(`${base}/api/img?u=${encodeURIComponent('https://example.com/x.jpg')}`, {
    headers: { cookie },
  });
  assert.equal(other.status, 400);
  assert.match((await other.json()).error, /not allowed/i);

  // Nor is a non-default port on an allowed host.
  const port = await fetch(`${base}/api/img?u=${encodeURIComponent('https://i.ytimg.com:8443/x.jpg')}`, {
    headers: { cookie },
  });
  assert.equal(port.status, 400);
});

test('oEmbed describes the same track', async () => {
  const url = `${base}/t/${VIDEO}`;
  const res = await fetch(`${base}/oembed.json?url=${encodeURIComponent(url)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.version, '1.0');
  assert.equal(body.type, 'link');
  assert.equal(body.url, url);
  assert.equal(body.html, undefined, 'a link card must not pretend to be an incomplete rich embed');
  assert.equal(body.width, undefined);
  assert.equal(body.height, undefined);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(body.provider_name, 'sonora');
  assert.equal(body.title, 'Fixture Song \u2014 Fixture Artist');
  assert.equal(body.author_name, 'Fixture Artist');
  assert.equal(body.thumbnail_url, `${base}/t/${VIDEO}/art.jpg`);
});

test('oEmbed rejects malformed, non-canonical, foreign and unknown targets without caching', async () => {
  const canonical = `${base}/t/${VIDEO}`;
  const malformed = [
    null,
    'not a URL',
    `javascript:/t/${VIDEO}`,
    `${base}/t/not-an-id`,
    `${base}/t/${VIDEO}/`,
    `${base}/t/${VIDEO}?download=1`,
    `${base}/t/${VIDEO}#fragment`,
    `${base}/prefix/t/${VIDEO}`,
    `https://evil.example/t/${VIDEO}`,
    `https://evil.example/?next=${encodeURIComponent(`/t/${VIDEO}`)}`,
    `https://user:pw@127.0.0.1:${new URL(base).port}/t/${VIDEO}`,
  ];
  for (const target of malformed) {
    const query = target === null ? '' : `?url=${encodeURIComponent(target)}`;
    const res = await fetch(`${base}/oembed.json${query}`);
    assert.equal(res.status, 400, `unsafe target was accepted: ${target}`);
    assert.equal(res.headers.get('cache-control'), 'no-store', `unsafe target was cacheable: ${target}`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    await res.arrayBuffer();
  }
  // Duplicate parameters are not silently coerced into a comma-joined URL.
  const duplicate = await fetch(`${base}/oembed.json?url=${encodeURIComponent(canonical)}&url=${encodeURIComponent(canonical)}`);
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.headers.get('cache-control'), 'no-store');
  await duplicate.arrayBuffer();

  const unknown = await fetch(`${base}/oembed.json?url=${encodeURIComponent(`${base}/t/${UNKNOWN}`)}`);
  assert.equal(unknown.status, 404, 'a well-formed URL for a track we do not know is not a successful embed');
  assert.equal(unknown.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unknown.json(), { error: 'Track not found.' });
});

test('unmatched GET and HEAD responses are uncacheable and carry baseline security headers', async () => {
  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(`${base}/definitely-not-a-route-${method}`, { method });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    const bodyBytes = (await res.arrayBuffer()).byteLength;
    if (method === 'HEAD') assert.equal(bodyBytes, 0);
    else assert.ok(bodyBytes > 0);
  }
  const malformedCard = await fetch(`${base}/t/not-a-video-id`);
  assert.equal(malformedCard.headers.get('cache-control'), 'no-store');
  await malformedCard.arrayBuffer();
});

test('static dotfiles are denied while the app shell and modules still load', async () => {
  const filename = `.sonora-share-test-secret-${process.pid}`;
  const filenamePath = path.join(new URL('../public', import.meta.url).pathname, filename);
  fs.writeFileSync(filenamePath, 'never-return-this-secret', { flag: 'wx' });
  try {
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(`${base}/${filename}`, { method });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(!(await res.text()).includes('never-return-this-secret'));
    }
    const [shell, module] = await Promise.all([fetch(`${base}/`), fetch(`${base}/app.js`)]);
    assert.equal(shell.status, 200);
    assert.equal(module.status, 200);
    await Promise.all([shell.arrayBuffer(), module.arrayBuffer()]);
  } finally {
    fs.rmSync(filenamePath, { force: true });
  }
});

test('direct forwarding headers cannot change the card or oEmbed authority', async () => {
  const forged = {
    'x-forwarded-host': 'attacker.example',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.99',
  };
  const card = await fetch(`${base}/t/${VIDEO}`, { headers: forged });
  assert.equal(card.status, 200);
  assert.equal(meta(await card.text(), 'og:url'), `${base}/t/${VIDEO}`);

  const foreign = await fetch(`${base}/oembed.json?url=${encodeURIComponent(`https://attacker.example/t/${VIDEO}`)}`, {
    headers: forged,
  });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.headers.get('cache-control'), 'no-store');
  await foreign.arrayBuffer();
});

test('cookie-authenticated mutations reject sibling, same-site, cross-site and contradictory origins', async () => {
  const payload = JSON.stringify({ ...TRACK, like: true });
  const crossSite = [
    { origin: 'https://attacker.invalid' }, // Origin alone, without Fetch Metadata.
    { origin: 'not a valid origin', 'sec-fetch-site': 'same-origin' },
    { origin: `${base}/not-an-origin` },
    { origin: 'https://sibling.example.test', 'sec-fetch-site': 'same-site' },
    { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' },
    { origin: base, 'sec-fetch-site': 'same-site' },
    { origin: 'null', 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of crossSite) {
    const res = await fetch(`${base}/api/likes`, {
      method: 'POST',
      headers: { ...headers, cookie, 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.arrayBuffer();
  }

  const sameOrigin = await fetch(`${base}/api/likes`, {
    method: 'POST',
    headers: { cookie, origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: payload,
  });
  assert.equal(sameOrigin.status, 200);
  await sameOrigin.arrayBuffer();
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 200,
    'rejected mutation attempts must not revoke or otherwise damage the session');
});

test('API bodies require explicit JSON, while valid empty POSTs and same-origin login still work', async () => {
  const payload = JSON.stringify({ ...TRACK, like: true });
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/ld+json', null]) {
    const headers = { cookie, origin: base, 'sec-fetch-site': 'same-origin' };
    if (type !== null) headers['content-type'] = type;
    const res = await fetch(`${base}/api/likes`, {
      method: 'POST', headers, body: type === null ? Buffer.from(payload) : payload,
    });
    assert.equal(res.status, 415, `body media type must be rejected: ${type}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.arrayBuffer();
  }

  const withCharset = await fetch(`${base}/api/likes`, {
    method: 'POST',
    headers: {
      cookie, origin: base, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json; charset=utf-8',
    },
    body: payload,
  });
  assert.equal(withCharset.status, 200);
  await withCharset.arrayBuffer();

  // Fetch Metadata alone is enough to reject a modern cross-site body-less form.
  const emptyAttack = await fetch(`${base}/api/notifications/read-all`, {
    method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(emptyAttack.status, 403);
  await emptyAttack.arrayBuffer();

  // A text/plain declaration on a zero-length POST is not a hidden request body.
  const emptyAllowed = await fetch(`${base}/api/notifications/read-all`, {
    method: 'POST',
    headers: { cookie, origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
  });
  assert.equal(emptyAllowed.status, 200);
  await emptyAllowed.arrayBuffer();

  const publicLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
  });
  assert.equal(publicLogin.status, 200);
  await publicLogin.arrayBuffer();
});

test('the bounded notification cooldown still acquires and throttles a user slot', async () => {
  const headers = { cookie, origin: base, 'sec-fetch-site': 'same-origin' };
  const first = await fetch(`${base}/api/notifications/check`, { method: 'POST', headers });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.created, 0, 'this fixture follows no artists, so no upstream work is required');
  const second = await fetch(`${base}/api/notifications/check`, { method: 'POST', headers });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).throttled, true);
});

test('an authenticated loopback proxy supplies the canonical card and mutation origin', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-share-proxy-'));
  const port = await freePort();
  const fixtureBase = `http://127.0.0.1:${port}`;
  const publicOrigin = 'https://music.example.test';
  const forwarded = {
    'x-forwarded-host': 'music.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.10, 198.51.100.10',
  };
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      SONORA_DB: path.join(fixtureDir, 'proxy.db'),
      SONORA_AUDIO_DIR: path.join(fixtureDir, 'audio'),
      SONORA_SECRET: 'share-proxy-secret', SONORA_PASSPHRASE: 'hunter2hunter2',
      SONORA_LOGIN_RATE_MAX: '1000', SONORA_TRUST_PROXY: '1', SONORA_PUBLIC_URL: '',
      SONORA_LOG_LEVEL: 'warn', SONORA_POT_PROVIDER: '', SONORA_JS_RUNTIME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fixtureLogs = [];
  child.stdout.on('data', (d) => fixtureLogs.push(String(d)));
  child.stderr.on('data', (d) => fixtureLogs.push(String(d)));
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        const health = await fetch(`${fixtureBase}/api/health`);
        up = health.ok && (await health.json()).pid === child.pid;
      } catch {}
      if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(up, `proxy fixture did not start:\n${fixtureLogs.join('')}`);

    const login = await fetch(`${fixtureBase}/api/auth/login`, {
      method: 'POST',
      headers: {
        ...forwarded, origin: publicOrigin, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
    });
    assert.equal(login.status, 200, await login.text());
    const fixtureCookie = login.headers.getSetCookie()[0].split(';')[0];

    const remembered = await fetch(`${fixtureBase}/api/likes`, {
      method: 'POST',
      headers: {
        ...forwarded, cookie: fixtureCookie, origin: publicOrigin,
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      },
      body: JSON.stringify({ ...TRACK, like: true }),
    });
    assert.equal(remembered.status, 200, await remembered.text());

    const sibling = await fetch(`${fixtureBase}/api/notifications/read-all`, {
      method: 'POST',
      headers: {
        ...forwarded, cookie: fixtureCookie, origin: 'https://evil.example.test',
        'sec-fetch-site': 'same-site',
      },
    });
    assert.equal(sibling.status, 403, 'a sibling eTLD+1 is not the request origin');
    await sibling.arrayBuffer();

    const card = await fetch(`${fixtureBase}/t/${VIDEO}`, { headers: forwarded });
    assert.equal(card.status, 200);
    assert.equal(meta(await card.text(), 'og:url'), `${publicOrigin}/t/${VIDEO}`);

    const embedded = await fetch(
      `${fixtureBase}/oembed.json?url=${encodeURIComponent(`${publicOrigin}/t/${VIDEO}`)}`,
      { headers: forwarded },
    );
    const embeddedText = await embedded.text();
    assert.equal(embedded.status, 200, embeddedText);
    const embedBody = JSON.parse(embeddedText);
    assert.equal(embedBody.type, 'link');
    assert.equal(embedBody.provider_url, publicOrigin);
    assert.equal(embedBody.thumbnail_url, `${publicOrigin}/t/${VIDEO}/art.jpg`);

    // The transport's internal origin is not a second accepted oEmbed authority.
    const internal = await fetch(
      `${fixtureBase}/oembed.json?url=${encodeURIComponent(`${fixtureBase}/t/${VIDEO}`)}`,
      { headers: forwarded },
    );
    assert.equal(internal.status, 400);
    assert.equal(internal.headers.get('cache-control'), 'no-store');
    await internal.arrayBuffer();
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

// ── real browser ────────────────────────────────────────────────────────

test('the card page renders and hands off in a real browser', async (t) => {
  if (!CHROME) return t.skip('no Chromium on this host');

  const browser = await launch(await freePort());
  try {
    await browser.viewport({ width: 390, height: 844, mobile: true });
    await browser.goto(`${base}/t/${VIDEO}`);

    assert.equal(await browser.eval(`document.querySelector('h1').textContent`), 'Fixture Song');
    assert.equal(await browser.eval(`document.querySelector('.artist').textContent`), 'Fixture Artist');
    assert.equal(await browser.eval(`document.querySelector('.dur').textContent`), '3:34');
    assert.equal(
      await browser.eval(`document.querySelector('.play').getAttribute('href')`),
      `${base}/#/t/${VIDEO}`,
    );
    // The button has to be on screen at phone width, not merely in the DOM.
    assert.equal(await browser.eval(`(() => {
      const r = document.querySelector('.play').getBoundingClientRect();
      return r.top > 0 && r.bottom <= innerHeight && r.width > 0;
    })()`), true);

    // The artwork is a CSS background on the anchor rather than an <img>: a
    // broken <img> draws the browser's own broken-file glyph inside the frame,
    // and suppressing that needs JavaScript. A background that 404s renders
    // nothing, which reveals the music-note fallback layered underneath.
    const art = await browser.eval(`getComputedStyle(document.querySelector('.art')).backgroundImage`);
    assert.match(art, new RegExp(`${base}/t/${VIDEO}/art\\.jpg`));
    assert.equal(await browser.eval(`document.querySelector('.art').getAttribute('aria-label')`),
      'Open Fixture Song by Fixture Artist in sonora');

    await browser.eval(`document.querySelector('.play').click()`);
    await browser.waitFor(`location.hash === '#/t/${VIDEO}'`);
    assert.equal(await browser.eval(`location.pathname`), '/');
  } finally {
    browser.close();
  }
});

test('the track menu copies a shareable /t/ link', async (t) => {
  if (!CHROME) return t.skip('no Chromium on this host');

  const browser = await launch(await freePort());
  try {
    await browser.viewport({ width: 1280, height: 900 });
    await browser.goto(`${base}/`);

    // A fragment never reaches the server, so the link the menu copies has to
    // be a path. Capture whichever branch the app takes.
    await browser.addInitScript(`(() => {
      window.__share = { copied: null, shared: null };
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: (t) => { window.__share.copied = t; return Promise.resolve(); } },
        });
        // Headless Chromium has no Web Share API; make that explicit so the
        // clipboard branch is the one under test.
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      } catch {}
    })()`);

    // Log in through the real endpoint so the httpOnly session cookie lands in
    // the browser's own jar, then boot the app against it.
    const status = await browser.eval(`fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }),
    }).then((r) => r.status)`);
    assert.equal(status, 200);

    await browser.goto(`${base}/?share=${Date.now()}`);
    await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
    await browser.waitFor(`document.getElementById('auth-overlay').hidden`, 20_000);

    // The liked track is in the sidebar collection, which renders rows with the
    // per-track menu.
    await browser.eval(`document.querySelector('.sidebar [data-collection="liked"]').click()`);
    await browser.waitFor(
      `!!document.querySelector('#page-root [data-action="track-menu"][data-id="${VIDEO}"]')`, 15_000,
    );
    await browser.eval(
      `document.querySelector('#page-root [data-action="track-menu"][data-id="${VIDEO}"]').click()`,
    );
    await browser.waitFor(`!!document.querySelector('#context-menu [data-menu-action="share"]')`);
    await browser.eval(`document.querySelector('#context-menu [data-menu-action="share"]').click()`);

    const shared = await browser.eval(`window.__share.copied ?? window.__share.shared?.url ?? null`);
    assert.equal(shared, `${base}/t/${VIDEO}`,
      'a shared track must link to the card page, not to the client hash route');
  } finally {
    browser.close();
  }
});
