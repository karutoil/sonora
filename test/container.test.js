import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the container setup against the two mistakes that are silent rather
// than loud: publishing a different port than the dev server, and running the
// server on the container's loopback (where the published port reaches nothing).

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Minimal extraction: enough to assert on this compose file, no YAML parser. */
function composeService() {
  const text = read('compose.yaml');
  const start = text.indexOf('services:');
  assert.notEqual(start, -1, 'compose.yaml has a services block');
  return text.slice(start);
}

test('compose publishes the same port the dev server uses', async () => {
  const { config } = await import('../src/config.js');
  const compose = composeService();

  // The dev default lives in src/config.js; the container must agree with it.
  assert.equal(config.port, 8130, 'dev default port is 8130');

  const mapping = /-\s*"\$\{SONORA_BIND:-[^}]+\}:(\d+):(\d+)"/.exec(compose);
  assert.ok(mapping, 'compose.yaml has a host:container port mapping');
  const [, hostPort, containerPort] = mapping;
  assert.equal(hostPort, String(config.port), 'host port matches the dev port');
  assert.equal(containerPort, String(config.port), 'container port matches the dev port');
});

test('the container listens on all interfaces, not loopback', () => {
  const compose = composeService();
  // Without this the app binds 127.0.0.1 *inside* the container and the
  // published port answers nothing — verified by trying it.
  assert.match(compose, /HOST:\s*0\.0\.0\.0/, 'HOST is overridden to 0.0.0.0');
});

test('the POT provider and JS runtime are wired for the container', () => {
  const compose = composeService();
  // 127.0.0.1 in a container is the container; the provider is on the host.
  assert.match(compose, /SONORA_POT_PROVIDER:\s*http:\/\/host\.containers\.internal:4416/);
  assert.match(compose, /SONORA_JS_RUNTIME:\s*node:/);
  assert.match(compose, /host\.containers\.internal:host-gateway/, 'host alias is declared');
});

test('state is a bind mount so the db, cookies and audio survive a rebuild', () => {
  const compose = composeService();
  assert.match(compose, /\.\/data:\/app\/data/, 'data dir is bind-mounted');
});

test('the container gets a working resolver, not just the podman forwarder', () => {
  const compose = composeService();
  // Measured 2026-10-20: rootless podman's aardvark-dns forwarder answers every
  // external name in 2.5 s, while the host's resolver answers in ~1 ms. Node
  // resolves per connection, so that penalty hit every thumbnail (some aborted
  // at the proxy's timeout and 404'd in the UI) and every yt-dlp run (5 lookups
  // -> 12.5 s per track instead of 2 s). Without explicit `dns:` entries the
  // container inherits 10.89.24.1 and the whole app feels broken again.
  const block = /^\s*dns:[ \t]*\n((?:\s*(?:#.*|-\s*.+)\n)+)/m.exec(compose);
  assert.ok(block, 'compose.yaml declares a dns list for the service');
  const servers = [...block[1].matchAll(/^\s*-\s*(.+)$/gm)]
    .map((m) => m[1].trim().replace(/^["']|["']$/g, ''));
  assert.ok(servers.length >= 2, `expected at least two resolvers, got ${servers.length}`);
  for (const s of servers) {
    assert.match(s, /^(?:\$\{SONORA_DNS_[12]:[-.0-9a-z]+\}|\d{1,3}(?:\.\d{1,3}){3})$/, `resolver ${s} looks usable`);
  }
  // A loopback resolver would point at the container itself, which is exactly
  // the failure mode being avoided.
  for (const s of servers) assert.doesNotMatch(s, /127\.0\.0\.1|localhost/);
});

test('the entrypoint refuses to start without SONORA_SECRET', () => {
  const script = read('scripts/container-entrypoint.sh');
  assert.match(script, /SONORA_SECRET/, 'entrypoint checks SONORA_SECRET');
  // An empty value is the likely mistake and config.js `??` does not catch it.
  assert.match(script, /-z "\$\{SONORA_SECRET:-\}"/, 'empty and unset are both rejected');
  assert.match(script, /exit 1/);
});

test('the image installs what yt-dlp actually needs', () => {
  const containerfile = read('Containerfile');
  // Measured on the dev host: downloads come from m3u8 and need ffmpeg, and
  // yt-dlp 2026.x solves JS challenges with a runtime.
  assert.match(containerfile, /ffmpeg/, 'ffmpeg is installed');
  assert.match(containerfile, /yt-dlp/, 'yt-dlp is installed');
  assert.match(containerfile, /bgutil-ytdlp-pot-provider/, 'the PO-token plugin is installed');
  assert.match(containerfile, /npm ci --omit=dev/, 'prod deps only');
});

test('the healthcheck script is shipped and wired', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/healthcheck.js')));
  const containerfile = read('Containerfile');
  assert.match(containerfile, /HEALTHCHECK/);
  // A list-form CMD survives podman-compose; a `node -e` one-liner does not.
  assert.match(containerfile, /CMD \["node", "scripts\/healthcheck\.js"\]/);
  assert.match(composeService(), /scripts\/healthcheck\.js/);
});

test('.env is gitignored and an example is provided', () => {
  assert.match(read('.gitignore'), /^\.env$/m);
  const example = read('.env.example');
  assert.match(example, /^SONORA_SECRET=/m);
  // The example must not carry a working secret.
  assert.doesNotMatch(example, /^SONORA_SECRET=.+$/m);
});
