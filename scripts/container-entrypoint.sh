#!/bin/sh
# Fail fast on the one misconfiguration that is dangerous rather than obvious.
#
# With SONORA_SECRET unset the app deliberately falls back to dev mode: a random
# signing key per process and non-Secure session cookies. That is the right
# default for `npm start` on a laptop, but in a container it means every restart
# silently signs everyone out and the AES key for the stored YouTube jar changes.
# A blank value is the easy mistake (`SONORA_SECRET=` in .env), and `??` in
# config.js does not catch the empty string, so it is checked here.
set -eu

if [ -z "${SONORA_SECRET:-}" ]; then
  echo "sonora: SONORA_SECRET is unset or empty — refusing to start." >&2
  echo "sonora: generate one with:  openssl rand -hex 32" >&2
  echo "sonora: then put it in .env as  SONORA_SECRET=<value>" >&2
  exit 1
fi

exec "$@"
