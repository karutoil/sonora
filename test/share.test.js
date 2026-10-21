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
  const cookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie')).split(';')[0];

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

test('oEmbed describes the same track', async () => {
  const url = `${base}/t/${VIDEO}`;
  const res = await fetch(`${base}/oembed.json?url=${encodeURIComponent(url)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.version, '1.0');
  assert.equal(body.provider_name, 'sonora');
  assert.equal(body.title, 'Fixture Song \u2014 Fixture Artist');
  assert.equal(body.author_name, 'Fixture Artist');
  assert.equal(body.thumbnail_url, `${base}/t/${VIDEO}/art.jpg`);
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
