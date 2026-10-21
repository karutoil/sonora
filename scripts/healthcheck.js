// Container healthcheck. A separate file rather than `node -e "..."` because
// podman-compose stringifies list-form healthchecks, and shell-quoting a
// one-liner with parentheses breaks under /bin/sh.
const port = process.env.PORT || 8130;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    console.error(`health: HTTP ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  if (body?.ok !== true) {
    console.error(`health: unexpected body ${JSON.stringify(body)}`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(`health: ${err.message}`);
  process.exit(1);
}
