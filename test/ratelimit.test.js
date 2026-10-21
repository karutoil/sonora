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

test('the shell is exempt from the rate limit, the API is not', async () => {
  const base = server.base;

  const shell = await Promise.all(
    Array.from({ length: 700 }, () => fetch(`${base}/app.js`).then((r) => r.status).catch(() => 0)),
  );
  const rejected = shell.filter((s) => s !== 200);
  assert.equal(rejected.length, 0,
    `the shell was rate-limited: ${rejected.length}/700 requests to /app.js did not return 200`);

  const api = await Promise.all(
    Array.from({ length: 650 }, () => fetch(`${base}/api/me`).then((r) => r.status).catch(() => 0)),
  );
  assert.ok(api.includes(429), 'the API lost its rate limit entirely');
  assert.ok(api.includes(401), 'unauthenticated API calls should still reach the auth check');
});
