#!/bin/sh
# Fail fast on the one misconfiguration that is dangerous rather than obvious.
#
# With SONORA_SECRET unset the app deliberately falls back to dev mode: a random
# signing key per process. That is the right default for `npm start` on a laptop,
# but in a container it means every restart silently signs everyone out and the
# AES key for the stored YouTube jar changes. Blank and whitespace-only values are
# equally unsafe: config.js treats them as unset, so it must reject them here.
set -eu

# Use the same trim() as config.js: POSIX character classes do not reject every
# Unicode whitespace value (NBSP, BOM and em-space were accepted in a runtime probe).
if ! node -e 'process.exit((process.env.SONORA_SECRET || "").trim() ? 0 : 1)'; then
  echo "sonora: SONORA_SECRET is unset, empty, or whitespace — refusing to start." >&2
  echo "sonora: generate one with:  openssl rand -hex 32" >&2
  echo "sonora: then put it in .env as  SONORA_SECRET=<value>" >&2
  exit 1
fi

exec "$@"
