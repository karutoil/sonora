// The first test imports src/config.js, which reads ambient environment
// variables; an inherited PORT (dev shells and CI runners both export one) made
// the "dev default port is 8130" assertion fail on the machine's environment
// instead of on the code. Neutralise it before config.js can possibly be
// evaluated: config.js is only imported dynamically inside a test body, which
// runs after this top-level statement, so the import sees PORT as unset.
delete process.env.PORT;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

/**
 * The compose interpolation this file relies on, implemented for `${VAR:-def}`
 * (unset *or empty* -> default) and `${VAR-def}` (unset -> default, empty kept).
 * Tests use it to prove both the documented default and an .env override,
 * instead of asserting on the literal text of one line.
 */
function interpolate(value, env = {}) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-)([^}]*)\}/g, (_, name, op, fallback) => {
    const set = Object.prototype.hasOwnProperty.call(env, name);
    if (op === ':-') return set && env[name] !== '' ? env[name] : fallback;
    return set ? env[name] : fallback;
  });
}

/** One `NAME: "${NAME...}"` environment entry, with its operator and default. */
function composeEnv(name) {
  const m = new RegExp(`^\\s{6}${name}:\\s*"(\\$\\{${name}(:?-)([^}]*)\\})"`, 'm').exec(composeService());
  assert.ok(m, `compose.yaml declares ${name} as an interpolated environment value`);
  return { expression: m[1], operator: m[2], fallback: m[3] };
}

test('compose publishes the same port the dev server uses', async () => {
  const { config } = await import('../src/config.js');
  const compose = composeService();

  // The dev default lives in src/config.js; the container must agree with it.
  assert.equal(config.port, 8130, 'dev default port is 8130');

  const mapping = /-\s*"(\$\{SONORA_BIND:-[^}]+\}):(\d+):(\$\{PORT(:?-)(\d+)\})"/.exec(compose);
  assert.ok(mapping, 'compose.yaml has a host:container port mapping');
  const [, bind, hostPort, portExpression, , containerDefault] = mapping;
  assert.equal(hostPort, String(config.port), 'host port matches the dev port');
  assert.equal(containerDefault, String(config.port), 'container port matches the dev port');
  // The expression keeps the published host port stable while letting .env move
  // the container's listener; both sides resolve to the dev port by default.
  assert.equal(interpolate(portExpression, {}), String(config.port));
  assert.equal(interpolate(portExpression, { PORT: '9000' }), '9000');
  assert.equal(interpolate(bind, {}), '127.0.0.1');
});

test('the container listens on all interfaces, not loopback', () => {
  const compose = composeService();
  // compose.yaml must not shadow .env with self-referential environment entries
  // (podman-compose 1.3 leaves `${VAR:-...}` literal when unset in .env);
  // instead, the entrypoint supplies container defaults when unset.
  assert.doesNotMatch(compose, /^\s{6}PORT:\s*"\$\{PORT/m, 'PORT is not self-referenced in compose environment');
  assert.doesNotMatch(compose, /^\s{6}HOST:\s*"\$\{HOST/m, 'HOST is not self-referenced in compose environment');

  const script = path.join(ROOT, 'scripts/container-entrypoint.sh');
  const dump = (extra = {}) => {
    const env = { ...process.env, SONORA_SECRET: 'valid-secret' };
    delete env.HOST;
    delete env.SONORA_POT_PROVIDER;
    delete env.SONORA_JS_RUNTIME;
    Object.assign(env, extra);
    const res = spawnSync('/bin/sh', [script, 'node', '-e', 'console.log(JSON.stringify({HOST:process.env.HOST,POT:process.env.SONORA_POT_PROVIDER,JS:process.env.SONORA_JS_RUNTIME}))'], {
      env, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };

  // Without this the app binds 127.0.0.1 *inside* the container and the
  // published port answers nothing.
  assert.deepEqual(dump(), {
    HOST: '0.0.0.0',
    POT: 'http://host.containers.internal:4416',
    JS: 'node:/usr/local/bin/node',
  });
  assert.equal(dump({ HOST: '' }).HOST, '0.0.0.0', 'an empty HOST still falls back to 0.0.0.0');
  assert.equal(dump({ HOST: '127.0.0.1' }).HOST, '127.0.0.1', '.env can override HOST');
});

test('the POT provider and JS runtime are wired for the container', () => {
  const compose = composeService();
  assert.match(compose, /host\.containers\.internal:host-gateway/, 'host alias is declared');

  const script = path.join(ROOT, 'scripts/container-entrypoint.sh');
  const dump = (extra = {}) => {
    const env = { ...process.env, SONORA_SECRET: 'valid-secret' };
    delete env.SONORA_POT_PROVIDER;
    delete env.SONORA_JS_RUNTIME;
    Object.assign(env, extra);
    const res = spawnSync('/bin/sh', [script, 'node', '-e', 'console.log(JSON.stringify({POT:process.env.SONORA_POT_PROVIDER,JS:process.env.SONORA_JS_RUNTIME}))'], {
      env, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };

  assert.equal(dump().POT, 'http://host.containers.internal:4416');
  assert.equal(dump({ SONORA_POT_PROVIDER: '' }).POT, '', 'empty SONORA_POT_PROVIDER disables it');
  assert.equal(dump({ SONORA_POT_PROVIDER: 'http://10.0.0.5:4416' }).POT, 'http://10.0.0.5:4416');
  assert.match(dump().JS, /^node:/);
  assert.equal(dump({ SONORA_JS_RUNTIME: '' }).JS, '', 'empty SONORA_JS_RUNTIME disables it');
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

test('the entrypoint enforces SONORA_SECRET at runtime', async (t) => {
  const script = path.join(ROOT, 'scripts/container-entrypoint.sh');
  const run = (secret) => {
    const env = { ...process.env };
    if (secret === undefined) delete env.SONORA_SECRET;
    else env.SONORA_SECRET = secret;
    return spawnSync('/bin/sh', [script, '/bin/sh', '-c', 'printf entrypoint-ok'], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
  };

  for (const [label, secret] of [
    ['unset', undefined],
    ['empty', ''],
    ['spaces', '   '],
    ['tabs and newlines', '\t \n\r\t'],
    ['Unicode whitespace', '\u00a0\ufeff\u2003'],
  ]) {
    await t.test(`rejects ${label}`, () => {
      const result = run(secret);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /SONORA_SECRET is unset, empty, or whitespace/);
    });
  }

  await t.test('accepts a non-whitespace value and executes the command', () => {
    const result = run('  a-valid-production-secret  ');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'entrypoint-ok');
    assert.equal(result.stderr, '');
  });
});

test('rootless podman maps the runtime user to the invoking host account', () => {
  const override = read('compose.podman.yaml');
  assert.match(override, /userns_mode:\s*["']?keep-id:uid=1000,gid=1000["']?/);
  assert.match(override, /compose\.yaml -f compose\.podman\.yaml/);
});

test('the podman override disables the pod that would cancel keep-id', () => {
  // podman-compose 1.3 joins every project to a pod by default, and podman
  // refuses `--userns` together with `--pod` ("cannot be set together"). The
  // documented command then fails outright, and any stack started without this
  // option runs unmapped — a read-only bind mount reported as "attempt to write
  // a readonly database" by the first boot that has to migrate. The setting is
  // top-level x-podman, not a service key, so assert on indentation too.
  const override = read('compose.podman.yaml');
  assert.match(override, /^x-podman:\s*$/m, 'x-podman is a top-level key');
  assert.match(override, /^\s+in_pod:\s*false\s*$/m, 'in_pod is disabled');
});

test('compose constrains privileges and process count', () => {
  const compose = composeService();
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /security_opt:\s*\n\s*- no-new-privileges:true/);
  const pids = /pids_limit:\s*(\d+)/.exec(compose);
  assert.ok(pids, 'compose declares a PID limit');
  assert.ok(Number(pids[1]) >= 64 && Number(pids[1]) <= 1024, 'PID limit is usable and bounded');
});

test('the image copies only the scripts its runtime and healthcheck need', () => {
  const containerfile = read('Containerfile');
  assert.match(containerfile, /COPY scripts\/container-entrypoint\.sh scripts\/healthcheck\.js \.\/scripts\//);
  assert.doesNotMatch(containerfile, /^COPY scripts \.\/scripts$/m);
});

test('the image normalises non-secret source modes before dropping to node', () => {
  // Atomic local edits left this assembled worktree's public/app.js and
  // package-lock.json at 0600. Buildah preserved that as root:root, so the
  // declared USER node could neither hash the lockfile nor execute public code.
  const containerfile = read('Containerfile');
  const normalise = containerfile.indexOf('chmod -R a+rX src public scripts');
  const drop = containerfile.indexOf('USER node:node');
  assert.ok(normalise >= 0, 'source readability/traversal is explicit');
  assert.ok(drop > normalise, 'normalisation runs before the unprivileged user');
  assert.match(containerfile, /chmod 0644 package\.json package-lock\.json/);
});

test('release publication is gated and PR builds have no package-write token', () => {
  const workflow = read('.github/workflows/ci.yml');
  const job = (name) => {
    const lines = workflow.split('\n');
    const start = lines.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `${name} job exists`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^  [a-z][a-z0-9-]*:$/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join('\n');
  };
  assert.match(job('publish'), /needs: \[unit, browser, build\]/);
  assert.match(job('publish'), /if: github\.event_name != 'pull_request'/);
  assert.match(job('publish'), /packages: write/);
  assert.doesNotMatch(job('build'), /packages: write/);
  assert.match(job('build'), /-e HOST=0\.0\.0\.0/, 'image smoke reaches a non-loopback listener');
  for (const name of ['config', 'rooms-idle', 'youtube', 'lifecycle']) {
    assert.match(job('unit'), new RegExp(`test/${name}\\.test\\.js`), `${name} gates publication`);
  }
  assert.doesNotMatch(job('browser'), /continue-on-error/);
  // Dependency probes: a missing ffmpeg or D-Bus turns into skipped cases, which
  // in a release gate is a green run that tested less. Both jobs must prove them.
  assert.match(job('unit'), /ffmpeg -version/, 'the offline job proves ffmpeg exists');
  assert.match(job('browser'), /ffmpeg -version/, 'the browser job proves ffmpeg exists');
  assert.match(job('browser'), /dbus-daemon --version/, 'the browser job proves the MPRIS bus dependency exists');
  for (const name of ['unit', 'browser', 'build', 'publish']) {
    assert.match(job(name), /timeout-minutes: \d+/, `${name} has a timeout`);
  }
});

test('secret material is excluded at every build-context depth', () => {
  const ignore = read('.dockerignore');
  for (const pattern of [
    '**/.env', '**/.env.*', '**/.netrc', '**/.npmrc', '**/*.pem', '**/*.key',
    '**/cookies.txt', '**/*-cookies.txt', '**/*.cookies', '**/*.db',
    '**/*.db-shm', '**/*.db-wal',
  ]) {
    assert.ok(ignore.split('\n').includes(pattern), `.dockerignore contains ${pattern}`);
  }
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

test('the healthcheck explains a body without pinning its shape', async () => {
  // Importing the module must not probe a port or exit: only running it as a
  // program does that. If this import ran the main block, node:test would die here.
  const { explain } = await import('../scripts/healthcheck.js');

  assert.equal(explain(null), '');
  assert.equal(explain('not a body'), '');

  // A machine-readable reason is translated for the operator.
  assert.equal(
    explain({ ok: false, reason: 'database-unreadable' }),
    'the database cannot be read (locked, corrupt, or on a full disk)',
  );
  // An unrecognised reason is printed verbatim, never swallowed.
  assert.equal(explain({ ok: false, reason: 'mystery-failure' }), 'mystery-failure');

  // A summary plus a failing probe that has its own detail.
  assert.equal(
    explain({ ok: false, error: 'boot failed', checks: { db: { ok: false, detail: 'disk full' } } }),
    'boot failed; db failed: disk full',
  );
  // A summary already names the fault, so detail-less cascade failures are not
  // repeated ("reason no-account" also fails signIn).
  assert.equal(
    explain({ ok: false, reason: 'no-account', checks: { signIn: { ok: false }, db: false } }),
    'there is no account and no SONORA_PASSPHRASE, so nobody can sign in',
  );
  // Array-shaped checks are read too.
  assert.equal(
    explain({ ok: false, checks: [{ name: 'db', ok: false, detail: 'locked' }] }),
    'db failed: locked',
  );
  // Nothing readable still beats "unexpected body".
  assert.equal(explain({ unexpected: true }), '{"unexpected":true}');

  // And the CLI seam: importing works, running reports the port.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import('./scripts/healthcheck.js').then((m) => process.stdout.write(`${typeof m.explain} ${typeof m.main}`))",
  ], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, 'function function');
});

/** Serve one fixed response on a loopback port and run healthcheck.js against it. */
async function runHealthcheckAgainst(status, body) {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    // spawn, not spawnSync: the stub server lives in this process, so blocking
    // the event loop would make the child's fetch time out instead of testing it.
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', 'scripts/healthcheck.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port) },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the healthcheck command accepts only a body that reports ok', async () => {
  const healthy = await runHealthcheckAgainst(200, '{"ok":true}');
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(healthy.stdout, '');

  // The finding this guards: HTTP 200 alone used to be enough, so an instance
  // nobody could sign into reported healthy forever.
  const unhealthy200 = await runHealthcheckAgainst(200, '{"ok":false,"reason":"database-unreadable"}');
  assert.equal(unhealthy200.status, 1, 'a 200 with ok:false must fail');
  assert.match(unhealthy200.stderr, /not healthy/);
  assert.match(unhealthy200.stderr, /the database cannot be read/, 'the failing reason reaches the log');

  const unhealthy503 = await runHealthcheckAgainst(503, '{"ok":false,"checks":{"db":{"ok":false,"detail":"disk full"}}}');
  assert.equal(unhealthy503.status, 1);
  assert.match(unhealthy503.stderr, /HTTP 503/);
  assert.match(unhealthy503.stderr, /db failed: disk full/);

  // Something else listening on the port is its own diagnosis, not "unhealthy".
  const notJson = await runHealthcheckAgainst(200, 'hello from another server');
  assert.equal(notJson.status, 1);
  assert.match(notJson.stderr, /the response was not JSON/);
});

test('install.sh keeps secrets private and cannot report success for an unhealthy server', () => {
  const script = read('install.sh');
  const syntax = spawnSync('/bin/sh', ['-n', path.join(ROOT, 'install.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  // Portable rewrite: `sed -i` is GNU-only and mangles macOS/BSD/BusyBox.
  assert.doesNotMatch(script, /^\s*sed -i\b/m, 'install.sh must not invoke GNU-only sed -i');
  assert.match(script, /\.env\.tmp/);

  // .env holds SONORA_SECRET and SONORA_PASSPHRASE.
  const copy = script.indexOf('cp .env.example .env');
  const tighten = script.indexOf('chmod 600 .env');
  assert.ok(copy >= 0 && tighten > copy, 'the created .env is made owner-only');
  assert.match(script, /umask 077/, 'the .env temp file is created under a restrictive umask');

  // Health must mean /api/health's own verdict, not any HTTP 200.
  assert.match(script, /\/api\/health/);
  assert.match(script, /\[\[:space:\]\]\*:\[\[:space:\]\]\*true/, 'install.sh parses "ok":true');
  assert.match(script, /exec -T sonora node scripts\/healthcheck\.js/,
    'without a host HTTP client it runs the container healthcheck');

  // The success banner is behind the health gate, and an unhealthy stack prints
  // logs and exits non-zero instead.
  const gate = script.indexOf('if [ "$HEALTHY" -ne 1 ]');
  const banner = script.indexOf('Sonora is up and running!');
  assert.ok(gate >= 0 && banner > gate, 'the success banner is gated on HEALTHY');
  const failure = script.slice(gate, banner);
  assert.match(failure, /logs sonora/, 'an unhealthy install prints the container logs');
  assert.match(failure, /err "Refusing to report success/, 'and exits non-zero');
  assert.doesNotMatch(script, /Server did not answer \/api\/health within 30s/,
    'the old warning-after-success path is gone');

  // Docker's uid/gid mismatch is the read-only-database failure; say so up front.
  assert.match(script, /\[ "\$ENGINE_TYPE" = "docker" \]/);
  assert.match(script, /id -u/);
  assert.match(script, /chown -R 1000:1000/);

  // A pre-existing .env without a passphrase leaves a fresh instance unusable.
  assert.match(script, /grep -Eq '\^SONORA_PASSPHRASE=/);
});

test('committed icons pass their own size and opacity check', () => {
  const result = spawnSync(process.execPath, ['--no-warnings', 'scripts/make-icons.js', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /all icons match their sources/);
  // Full-bleed icons must have no transparent pixel (iOS composites alpha onto
  // black; launchers crop maskable icons).
  for (const name of ['icon-180.png', 'icon-maskable-512.png']) {
    assert.match(result.stdout, new RegExp(`${name}: .*\\(opaque\\)`), `${name} is verified opaque`);
  }
  // The manifest's purpose:any marks stay the rounded plate: opaque body, and
  // the transparent corners icon.svg actually draws.
  for (const name of ['icon-192.png', 'icon-512.png']) {
    assert.match(result.stdout, new RegExp(`${name}: .*plate-opaque`), `${name} has an opaque plate`);
  }
});

test('build scripts resolve their own directory without a percent-encoded pathname', () => {
  for (const file of ['scripts/check-syntax.js', 'scripts/make-icons.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /import\.meta\.url\)\.pathname/, `${file} must not use URL.pathname`);
    assert.match(source, /fileURLToPath\(new URL\('\.\.', import\.meta\.url\)\)/,
      `${file} resolves the repo root with fileURLToPath`);
  }
});
