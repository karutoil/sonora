import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/ux.js';

// The shell and the API have different abuse profiles. A page load fetches a
// dozen static assets, and a user with several tabs open must never be handed a
// 429 for app.js — the module loader turns that into a blank page. The API
// (including ranged /api/stream requests) keeps its limit.

let server;

before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

test('every public dynamic card/listener/room route has its own effective limit', async () => {
  const cases = [
    ['/t/not-valid', 'GET', 120],
    ['/t/not-valid/art.jpg', 'GET', 120],
    ['/oembed.json', 'GET', 120],
    ['/l/not-a-code', 'GET', 120],
    ['/l/not-a-code/live', 'GET', 60],
    ['/api/public/rooms/not-a-code/guest', 'POST', 60],
    ['/api/public/rooms/not-a-code', 'GET', 60],
    ['/api/public/rooms/not-a-code/state', 'GET', 60],
    ['/api/public/rooms/not-a-code/time', 'GET', 60],
    ['/api/public/rooms/not-a-code/events', 'GET', 60],
  ];
  for (const [route, method, limit] of cases) {
    const res = await fetch(server.base + route, { method });
    assert.equal(res.headers.get('x-ratelimit-limit'), String(limit), route);
    assert.ok(Number(res.headers.get('x-ratelimit-remaining')) < limit, `${route} did not consume its bucket`);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${route} failures must not be cached`);
    await res.arrayBuffer();
  }
});

test('direct clients cannot rotate public-route buckets with forged forwarding headers', async () => {
  // /t/<id> used to inherit the shell exemption altogether. Even after adding a
  // route budget, trusting X-Forwarded-For on a direct peer would make it moot.
  const statuses = await Promise.all(Array.from({ length: 125 }, (_, i) => fetch(
    `${server.base}/t/aaaaaaaaaaa?rate=${i}`,
    { headers: { 'x-forwarded-for': `198.51.100.${i + 1}`, 'x-forwarded-host': 'spoofed.example' } },
  ).then(async (res) => { await res.arrayBuffer(); return res.status; })));
  assert.ok(statuses.includes(200), 'ordinary public cards must still be served');
  assert.ok(statuses.includes(429), 'the per-route budget must apply to the real direct peer');
});

test('the shell is exempt from the rate limit, the API is not', async () => {
  const base = server.base;

  const shell = await Promise.all(
    Array.from({ length: 700 }, () => fetch(`${base}/app.js`).then(async (r) => {
      await r.arrayBuffer(); // release keep-alive connections before shutdown is asserted
      return r.status;
    }).catch(() => 0)),
  );
  const rejected = shell.filter((s) => s !== 200);
  assert.equal(rejected.length, 0,
    `the shell was rate-limited: ${rejected.length}/700 requests to /app.js did not return 200`);

  const api = await Promise.all(
    Array.from({ length: 650 }, () => fetch(`${base}/api/me`).then(async (r) => {
      await r.arrayBuffer();
      return r.status;
    }).catch(() => 0)),
  );
  assert.ok(api.includes(429), 'the API lost its rate limit entirely');
  assert.ok(api.includes(401), 'unauthenticated API calls should still reach the auth check');
});
