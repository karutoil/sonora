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

# Container defaults. Applied here rather than compose.yaml `environment:`
# because podman-compose 1.3 puts self-referential `${VAR:-default}` keys into
# its own substitution map and leaves them literal when unset in `.env`.
# `:-` falls back when unset or empty; `-` keeps an explicit empty string so
# `.env` (`SONORA_POT_PROVIDER=`, `SONORA_JS_RUNTIME=`) disables the feature.
export HOST="${HOST:-0.0.0.0}"
export SONORA_POT_PROVIDER="${SONORA_POT_PROVIDER-http://host.containers.internal:4416}"
export SONORA_JS_RUNTIME="${SONORA_JS_RUNTIME-node:/usr/local/bin/node}"

exec "$@"
