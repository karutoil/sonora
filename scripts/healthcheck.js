// Container healthcheck. A separate file rather than `node -e "..."` because
// podman-compose stringifies list-form healthchecks, and shell-quoting a
// one-liner with parentheses breaks under /bin/sh.
//
// `body.ok === true` is the assertion that counts. /api/health is the process's
// own verdict and it runs the cheap-but-real probes (the database answers, there
// is a way to sign in at all, the audio directory is writable) for exactly this
// caller. A 200 on its own proves only that Fastify is still answering: an
// instance nobody can log into, or whose audio dir went read-only, used to report
// `(healthy)` for as long as it ran — and the health status is the first thing an
// operator checks to rule that out.
//
// Every failure prints WHY. `(unhealthy)` alone sends people to the port, the
// tunnel or the bind mount while the cause is sitting in the response body, so
// whatever /api/health said about the failing check goes into the log line that
// `podman logs` / `docker compose logs` shows.
import { pathToFileURL } from 'node:url';

function fail(reason) {
  console.error(`health: ${reason}`);
  process.exit(1);
}

// /api/health reports a machine-readable `reason` code. Translate the ones it can
// report into a sentence, because the operator reading `podman logs` should not
// have to guess what `no-account` means. An unknown code falls through as-is
// rather than being swallowed — a renamed reason must never make the failure
// message emptier than the response.
const REASONS = {
  'database-unreadable': 'the database cannot be read (locked, corrupt, or on a full disk)',
  'audio-dir-not-writable': 'the audio directory cannot be written (permissions, or a full disk)',
  'no-account': 'there is no account and no SONORA_PASSPHRASE, so nobody can sign in',
};

/**
 * Turn a health body into one line a human can act on, without pinning the shape.
 *
 * The body belongs to /api/health, so this reads what it plausibly reports rather
 * than one exact schema: a summary under `error`/`reason`/`detail`, and failing
 * probes either under `checks`/`failures` or directly on the body, each as a
 * `false` or an `{ ok: false, detail }`. Anything it cannot read is printed
 * verbatim instead of being swallowed, because a health failure with no
 * explanation is the problem this file exists to fix.
 */
export function explain(body) {
  if (!body || typeof body !== 'object') return '';

  const summary = [];
  for (const key of ['error', 'reason', 'detail', 'message']) {
    const text = body[key];
    if (typeof text !== 'string' || !text.trim()) continue;
    summary.push(key === 'reason' ? (REASONS[text.trim()] ?? text.trim()) : text.trim());
  }

  const failed = [];
  const record = (name, value) => {
    if (value === false) {
      failed.push({ name, detail: '' });
      return;
    }
    if (value && typeof value === 'object' && value.ok === false) {
      const detail = value.detail ?? value.error ?? value.reason ?? value.message;
      failed.push({ name, detail: typeof detail === 'string' ? detail : '' });
    }
  };

  const walk = (container) => {
    if (Array.isArray(container)) {
      for (const entry of container) record(entry?.check ?? entry?.name ?? entry?.id ?? 'check', entry);
      return;
    }
    if (!container || typeof container !== 'object') return;
    for (const [name, value] of Object.entries(container)) {
      if (name !== 'ok') record(name, value);
    }
  };

  // The body itself (`{ ok: false, db: false }`), then the usual containers.
  walk(body);
  walk(body.checks);
  walk(body.failures);

  // A summary already names the broken part, so a detail-less "db failed" beside
  // it would be the same fact twice (reason `database-unreadable` also fails the
  // `signIn` probe, which is a cascade, not a second fault). Keep the check names
  // only when they carry a detail of their own.
  const extra = summary.length ? failed.filter((f) => f.detail) : failed;
  const parts = [...summary, ...extra.map((f) => (f.detail ? `${f.name} failed: ${f.detail}` : `${f.name} failed`))];

  // Nothing readable: the raw body is still better than "unexpected body".
  return parts.length ? parts.join('; ') : JSON.stringify(body);
}

export async function main() {
  // Read PORT at call time, not import time: importing explain() for a unit test
  // must not depend on (or capture) the ambient environment.
  const port = process.env.PORT || 8130;
  const url = `http://127.0.0.1:${port}/api/health`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    // Read the body on a non-200 too: an unhealthy instance may answer 503 with its
    // verdict attached, and "health: HTTP 503" alone is the message this file
    // exists to avoid.
    let body = null;
    let parsed = false;
    try {
      body = await res.json();
      parsed = true;
    } catch {}
    // "Not JSON at all" is its own answer: it means something else is listening on
    // PORT (a stale container, another dev server), not that sonora is unhealthy.
    const why = explain(body) || (parsed ? '' : 'the response was not JSON');
    if (!res.ok) fail(`HTTP ${res.status} from ${url}${why ? ` — ${why}` : ''}`);
    if (body?.ok !== true) fail(`${url} reports this instance is not healthy${why ? ` — ${why}` : ''}`);
    process.exit(0);
  } catch (err) {
    // A refused connection and a timeout are different stories and the message says
    // which: still booting (start_period covers that), wedged, or dead.
    fail(`could not reach ${url}: ${err.message}`);
  }
}

// Only run when executed as a program (`node scripts/healthcheck.js`, including
// the image's HEALTHCHECK): importing explain() for tests must not probe a port
// or call process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}