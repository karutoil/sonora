<div align="center">
  <img src="docs/assets/banner.png" alt="sonora — your own music, your own algorithm" width="100%">
</div>

<div align="center">

**A self-hosted YouTube music app for your phone, desktop and browser.**
Search, endless radio, likes, playlists, an installable offline PWA, and shared listening rooms —
with your own account, your own database, and no algorithm you cannot see.

[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![Container](https://img.shields.io/badge/container-podman%20%7C%20docker-892ca0?logo=docker&logoColor=white)](#quick-start)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![PWA](https://img.shields.io/badge/PWA-installable-ff997b)](#features)

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) ·
[How it works](#how-it-works) · [Testing](#testing) · [Documentation](#documentation)

</div>

> **Naming.** The product, repository, npm package, container image and every environment variable
> are all `sonora` / `SONORA_*`. A checkout made before the rename is still named `muse-pwa` on
> disk, and two paths on an existing install (`data/muse.db`, `~/.local/share/muse-venv`) are
> detected for compatibility. See [Migrating from Muse](#migrating-from-muse) if you are upgrading.

---

## Features

**Listen**

- Search songs, albums, artists and playlists in one request, with type tabs that switch over the
  answer already on screen (no refetch).
- Endless radio and a station that mixes four lanes — the song that seeded it, more from artists
  you already play, an artist-adjacent pick and something trending in the same lane — from what
  you actually play. No external recommendation service.
- A queue you can actually edit: drag or Alt+↑/↓ to reorder (the playing song stays the playing
  song), and “Add to queue” from any track menu next to “Play next”.
- Likes, dislikes, playlists, listening history and per-track stats.
- **Follow an artist** and hear about their new releases in the notification bell — or as a
  desktop / PWA notification if you turn that on. The first check only records what already
  exists, so following a band with twelve albums does not fire twelve alerts.
- Synced now-playing across your devices, plus lock-screen / Media Session controls.
- Audio is cached on disk, so seeking is instant and a replay costs no network.

**Share**

- **Listen Together** rooms: one shared playhead, several people following the same track at the
  same position, within a few hundred milliseconds.
- Public rooms can be joined by link **without an account**; private rooms are invite-only.
- Shareable links for tracks (`/t/<id>`) and rooms (`/l/<code>`) with real Open Graph cards.

**Own**

- Accounts stored locally in SQLite — passphrase plus optional **passkeys**, remembered devices
  with rotating refresh tokens, and per-device revocation.
- Installable PWA with an offline app shell.
- Admin panel — **Overview**, **Users**, **Library**, **Storage** and **System** — for accounts,
  the shared track library, cache limits, a consistent SQLite backup download and the YouTube
  cookie jar.
- No cloud dependency, no build step, no third-party analytics.

## Quick start

### One-line install (recommended)

Install and start sonora with a single command. It detects Docker or Podman, configures a secure `.env` (generating a random secret and admin passphrase), builds the container, and starts the server:

```bash
curl -fsSL https://raw.githubusercontent.com/karutoil/sonora/master/install.sh | bash
```

Once running, open **http://127.0.0.1:8130** and sign in with the username and passphrase printed at the end of the script.

---

### Manual container setup (Option A)

```bash
git clone https://github.com/karutoil/sonora.git
cd sonora

cp .env.example .env
chmod 600 .env
# Edit .env and set the two required values:
#   SONORA_SECRET      (required)    -> the output of:  openssl rand -hex 32
#   SONORA_PASSPHRASE  (first run)   -> a passphrase you will remember
# .env.example sets SONORA_USER=admin; change it if you prefer another name.
# Every other variable is optional and has a working default.

# Docker:
docker compose up -d --build

# Rootless Podman (the override maps uid/gid 1000 to your host account):
podman compose -f compose.yaml -f compose.podman.yaml up -d --build
podman compose -f compose.yaml -f compose.podman.yaml logs -f
```

`.env` holds the cookie-signing secret and the bootstrap passphrase, so keep it owner-only (`chmod 600`,
as `install.sh` does). Compose reads it for interpolation: `HOST`, `PORT`, `SONORA_POT_PROVIDER` and
`SONORA_JS_RUNTIME` are overridable there without editing `compose.yaml`.

> **Docker Desktop (macOS/Windows):** `compose.yaml` logs through `journald`, which is Linux-only and
> has no socket on Docker Desktop. Comment out the `logging:` block there (or switch the driver to
> `json-file`); otherwise `docker compose up` fails to start the container.

Open **http://127.0.0.1:8130** and sign in with the `SONORA_USER` / `SONORA_PASSPHRASE` you set.
The first account is created only while the database has no users, and is an admin.

```bash
podman compose -f compose.yaml -f compose.podman.yaml down   # data stays in ./data
podman compose -f compose.yaml -f compose.podman.yaml up -d  # no rebuild
```

For Docker, replace `podman compose` with `docker compose` and omit both `-f`
options. `./data` must be writable by uid/gid 1000 under Docker. If an older root
container already owns it, run `sudo chown -R 1000:1000 data` for Docker, or
`sudo chown -R "$(id -u):$(id -g)" data`
for the rootless Podman override. The override is required for Podman: plain `podman compose up`
maps container uid 1000 to a subuid that cannot write a directory owned by your host account.

> The override also sets `x-podman.in_pod: false`. `podman-compose` joins every project to a pod by
> default, and `podman` refuses `--userns` together with `--pod`, so without that setting the
> documented command fails with "--userns and --pod cannot be set together". Keep both files
> together: the override exists for its side effect on the mount, not just its comment.

`./data` holds the SQLite database, the audio cache and the materialised YouTube cookie jar
(`youtube-cookies.txt`, mode 0600; the encrypted copy lives in the database). It is
bind-mounted, so the container and a local dev server share the same state — just never run both
at once (SQLite is the reason).

> **"attempt to write a readonly database" on start.** This is file ownership, not corruption. The
> container runs as uid/gid 1000 and `./data` is a bind mount, so if the directory belongs to a
> different user, SQLite opens the file for reading and then dies on the first `CREATE TABLE` of
> the migration. Fix the mount, then start again — the migration is transactional and retries from
> a consistent file:
>
> ```bash
> # Docker
> sudo chown -R 1000:1000 data
>
> # Rootless Podman (start with the override so keep-id applies)
> sudo chown -R "$(id -u):$(id -g)" data
> podman compose -f compose.yaml -f compose.podman.yaml up -d
> ```
>
> The server now checks this before opening the database and reports the path, the effective uid/gid
> and both repair commands, so the raw SQLite error should no longer be the first thing you see.

> `SONORA_SECRET` is mandatory in a container. The app deliberately falls back to a random
> per-process key when it is unset (right for a laptop, wrong for a container: every restart would
> sign all devices out and lose the key that encrypts the stored YouTube cookie jar). The
> entrypoint refuses to start with an unset, empty or whitespace-only value.

### Option B — local development

Requirements: **Node.js ≥ 22.13** — the first 22.x release where the built-in **`node:sqlite`**
runs without a flag (it is still experimental, hence the `--no-warnings` in every npm script; CI
and the author run the latest 22.x) — plus **yt-dlp** and **ffmpeg**. A JS runtime for `yt-dlp`
(Deno or Node) is recommended.

```bash
npm ci
SONORA_SECRET=$(openssl rand -hex 32) \
SONORA_PASSPHRASE='choose-a-passphrase' \
  npm start                      # http://127.0.0.1:8130
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm start` | Run the server (data in `./data`) |
| `npm run dev` | Same, with `--watch` |
| `npm run lint` | Parse every file in `src/`, `public/` and `scripts/` (`node --check`); no dependencies, no config |
| `npm test` | Full suite, 8 files at a time (needs network + a browser — see [Testing](#testing)) |
| `npm run test:serial` | Same suite one file at a time — for bisecting a flake |
| `npm run admin -- list` | List accounts, roles and status |
| `npm run admin -- promote <name>` | Grant admin (also `demote`, `disable`, `enable`) |

## Configuration

Everything is configured through environment variables. All of them are documented in
[`.env.example`](.env.example), which is the single source of truth. Copy it to `.env` and edit.

**In short: set `SONORA_SECRET` for any real deployment, and `SONORA_PASSPHRASE` once to create the
first account. Every other variable is optional.** The **Need** column says which is which.

| Need | Meaning |
| --- | --- |
| **Required** | No safe default. The container refuses to start without it; outside a container the app falls back to a random value that breaks on restart. |
| **First run** | Only needed while the database has no users. Ignored once an account exists. |
| **Conditional** | Has a default that is wrong for one specific setup (a proxy, a tunnel, a feature). Set it only when that applies. |
| **Optional** | Has a working default. Change it only if you want different behaviour. |

### Essential

| Variable | Need | Default | Purpose |
| --- | --- | --- | --- |
| `SONORA_SECRET` | **Required** in a container; optional in dev | random per process | Signs session cookies **and** derives the AES key for an imported YouTube cookie jar. Set it explicitly in production. |
| `SONORA_PASSPHRASE` | **First run** | — | Passphrase for the bootstrap account. Only used while the users table is empty. |
| `SONORA_USER` | Optional | `admin` | Name of the bootstrap account. Set this explicitly if you want another name. |
| `PORT` | Optional | `8130` | HTTP port. |
| `HOST` | Optional | `127.0.0.1` | Bind address. Containers set `0.0.0.0`. |
| `SONORA_BIND` | Optional | `127.0.0.1` | Host address the compose file publishes on. Use `0.0.0.0` for LAN access. |

### Storage and performance

| Variable | Need | Default | Purpose |
| --- | --- | --- | --- |
| `SONORA_DB` | Optional | `./data/sonora.db` | SQLite database path. An existing `./data/muse.db` is used instead (see [Migrating from Muse](#migrating-from-muse)). |
| `SONORA_AUDIO_DIR` | Optional | `./data/audio` | Downloaded-audio cache directory. |
| `SONORA_CACHE_MB` | Optional | `8192` | Cache ceiling in MB. |
| `SONORA_MAX_DOWNLOADS` | Optional | `4` | Concurrent `yt-dlp` downloads. |
| `SONORA_DOWNLOAD_TIMEOUT_MS` | Optional | `120000` | Download safety ceiling. |
| `SONORA_DOWNLOAD_QUEUE_TIMEOUT_MS` | Optional | `20000` | How long a track request waits for a free download slot before the server answers "busy" so the player moves on. |
| `SONORA_QUEUE_COVER_MS` | Optional | `86400000` (24 h) | How far ahead one hidden-playback queue stream is written before it stops repeating the plan. Lowering it bounds how long a locked phone can keep playing without the page running. |
| `SONORA_LOG_LEVEL` | Optional | `info` | Fastify log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`; `warn` is quieter). |
| `FFMPEG_BIN` / `FFPROBE_BIN` | Optional | autodetected on `PATH` | `ffmpeg` and `ffprobe`, used to cut the hidden queue stream's segments. The image installs both; set these only when they live outside `PATH`. |

### Sessions, auth and rooms

| Variable | Need | Default | Purpose |
| --- | --- | --- | --- |
| `SONORA_SESSION_MINUTES` | Optional | `720` | Access-token lifetime. Remembered devices renew silently. |
| `SONORA_REFRESH_DAYS` | Optional | `30` | Lifetime of a "remember this device" refresh token. |
| `SONORA_SESSION_DAYS` | Optional | `90` | Legacy alias for `SONORA_REFRESH_DAYS` (read only when that is unset), kept so older deployments keep working. The admin panel still shows it as "Session days". |
| `SONORA_REFRESH_GRACE_MS` | Optional | `30000` | Grace window for refresh-token rotation. Two tabs presenting the same token inside it rotate its successor forward instead of signing the device out; outside it a replay is treated as theft and revokes the device. `0` means strict (any replay revokes). |
| `SONORA_LOGIN_RATE_MAX` | Optional | `10` | Sign-in attempts per window, per client. |
| `SONORA_LOGIN_RATE_WINDOW` | Optional | `1 minute` | Rate-limit window. |
| `SONORA_TRUST_PROXY` | Conditional | `0` | Which peers may supply `X-Forwarded-*`. `0` (or unset) trusts nobody; `1` is only an alias for `loopback`; anything else is a comma-separated list of proxy IPs/CIDRs (e.g. `10.89.1.0/24`). Hop counts above 1 and `true` are rejected at boot. |
| `SONORA_SECURE_COOKIES` | Conditional | `auto` | `Secure` cookies on HTTPS/localhost. Use `always` or `never` only for a proxy setup whose scheme cannot be detected. |
| `SONORA_ROOM_HOURS` | Optional | `12` | Idle hours before an empty room is deleted. |
| `SONORA_ROOM_MAX_MEMBERS` | Optional | `50` | Member cap per room. |

### Passkeys and public URLs

A passkey is bound to a **registrable domain**, not an IP. These default to the request's `Host`
header, which is correct for `http://localhost:8130` and a direct HTTPS proxy. Set them when a
tunnel rewrites `Host`, or when the public origin differs from what the process sees.

| Variable | Need | Default | Purpose |
| --- | --- | --- | --- |
| `SONORA_RP_ID` | Conditional | request host | WebAuthn Relying Party ID, e.g. `music.example.com`. Required for passkeys behind a tunnel. |
| `SONORA_ORIGIN` | Conditional | request origin | WebAuthn origin, e.g. `https://music.example.com`. Required for passkeys behind a tunnel. |
| `SONORA_RP_NAME` | Optional | `sonora` | Name shown by the passkey prompt. |
| `SONORA_PUBLIC_URL` | Conditional | request host | Absolute origin used in share cards (`og:url`, `og:image`, oEmbed). Required behind a proxy that rewrites `Host`. |

### YouTube fetching

The defaults work on a clean host. These knobs exist because YouTube intermittently gates whole
IPs behind *"Sign in to confirm you're not a bot"*. None is required to run.

| Variable | Need | Default | Purpose |
| --- | --- | --- | --- |
| `SONORA_YTDLP` | Optional | autodetected | Path to the `yt-dlp` binary. |
| `SONORA_YTDLP_PROXY` | Optional | — | Proxy for `yt-dlp` (`http://…` or `socks5://…`). The only mitigation that changes your IP. |
| `SONORA_YTDLP_COOKIES` | Optional | — | Path to a `cookies.txt` for `yt-dlp`. |
| `SONORA_YT_COOKIE` | Optional | — | Raw `Cookie:` header used by `youtubei.js` for metadata. |
| `SONORA_POT_PROVIDER` | Optional | `http://127.0.0.1:4416` | `bgutil` PO-token provider endpoint; empty disables it. |
| `SONORA_JS_RUNTIME` | Optional | autodetected `~/.deno/bin/deno`, else unset | JS runtime for `yt-dlp` (`node:/usr/local/bin/node`, `deno:/path`). Empty disables it; `compose.yaml` sets `node:/usr/local/bin/node` explicitly. |
| `SONORA_YTIMG_HOST` | Optional | `i.ytimg.com` | Host (or full `http(s)://` URL) the id-based artwork proxy fetches covers from. The proxy still serves ids only, and only from YouTube's image domains. |
| `SONORA_URL_TTL_MS` | Optional | `10800000` (3 h) | Reserved legacy diagnostic setting; no longer changes playback or fetching. |
| `SONORA_RESOLVE_TIMEOUT_MS` | Optional | `25000` | Metadata request timeout. |
| `SONORA_UPSTREAM_TIMEOUT_MS` | Optional | `20000` | Reserved: parsed from the environment but not applied by any request path yet. |

### Container-only (compose)

| Variable | Need | Default | Purpose |
| --- | --- | --- | --- |
| `SONORA_DNS_1` / `SONORA_DNS_2` | Optional | `1.1.1.1` / `8.8.8.8` | Resolvers passed to the container. Rootless podman's own forwarder can be very slow; point these at a fast resolver. |

### Test-only

| Variable | Need | Default | Purpose |
| --- | --- | --- | --- |
| `CHROME_BIN` | Optional | autodetected | Chromium binary for the browser-based UI tests. |
| `SONORA_FOLLOWS_OFFLINE` | Optional | unset | Set to `1` to run only the mock-backed follows/release tests; the live HTTP cases explicitly skip. Used by CI's offline job. |

## How it works

```
Browser / installed PWA
        │  same-origin fetch + <audio>
        ▼
Fastify (src/server.js) ──► SQLite (node:sqlite, ./data/sonora.db)
        │                        users, devices, tracks, plays, likes, playlists, rooms,
        │                        artist follows, release baselines, notifications
        ├──► youtubei.js ──► YouTube Music metadata (search, album, artist, lyrics)
        ├──► yt-dlp ──────► complete audio file ──► ./data/audio/<id>.m4a
        └──► GET /api/stream/:videoId ──► ranged reads from the cache
```

Four measured constraints shaped the design, and each is explained in [`PLAN.md`](PLAN.md):

1. **googlevideo URLs are IP-bound and expire.** The phone cannot play a URL the server resolved,
   so every byte goes through `GET /api/stream/:videoId`.
2. **googlevideo serves only the first ~1 MiB to a naive range request.** A transparent byte proxy
   stalls one megabyte into every song. So the server downloads the whole file once, then serves
   ranges off disk. Seeking becomes instant and replay is free.
3. **iOS closes the audio session when a track ends naturally.** The player loops the element and
   switches tracks inside the event, and while the app is in the background it never pauses
   between tracks — a pause there is the silence in which iOS tears the session (and the
   Now Playing widget) down, and it does not give it back until the app is reopened.
4. **A locked iPhone stops running the page's script.** Media keeps playing in the media
   process, but no `timeupdate` arrives, so a player that starts the next track *from* a
   track boundary cannot start it. On iOS the element is therefore handed the queue as one
   continuous server-built stream (`/api/queue-stream/…`) just before the page goes hidden,
   and the per-track player is restored — at the right track and second — on the way back
   in. Other platforms keep the per-track handoff, whose events do arrive there.

There is **no build step**. `public/` is served as-is, which is what makes an offline cache and a
single-document offline shell practical.

## Testing

```bash
npm ci
npm run lint      # parse every shipped file; seconds, no dependencies
npm test          # full suite
```

The full suite is intentionally end-to-end: several tests **hit live YouTube**, and the UI,
layout, safe-area, passkey and room tests drive a **real Chromium**. Install Chromium or set
`CHROME_BIN`; locally, tests that need a browser skip cleanly when none is found. CI installs and
verifies Chromium so a missing browser cannot silently pass. Browser setup and live-network tests
make the full suite slower than the fixture-only checks; timing depends on host and network
conditions.

CI has separate enforcing offline and browser jobs. Its image build/smoke test and both test jobs
must pass before GHCR publication. The offline job includes mock-backed follows/release tests, the
fixture-only library/station HTTP suites and the hidden-playback queue-stream contract; its seven
live follows HTTP cases report explicit skips.
Live-YouTube end-to-end, library, search-types, station-endless, lockscreen and real-CDN latency
checks remain developer-run, not release gates. The shared live-audio download gate may skip only
an explicit `503` response with code `BOT_GATED`: `BUSY`, `ENOSPC`, timeouts, empty/malformed results,
502s, budget errors and other server failures remain failures. Separately, the live-broadcast test
reports a content-availability skip when current search results contain no live broadcast. Upstream
availability therefore limits what a developer run can prove; it never turns a server error green.

For the same serial backend/container selection used by the CI unit job (which must
stay offline):

```bash
SONORA_FOLLOWS_OFFLINE=1 node --no-warnings --test --test-concurrency=1 \
  test/config.test.js \
  test/db.test.js \
  test/search-rank.test.js \
  test/auth.test.js \
  test/cookies.test.js \
  test/admin.test.js \
  test/rooms.test.js \
  test/rooms-idle.test.js \
  test/migration.test.js \
  test/station.test.js \
  test/audio.test.js \
  test/ratelimit.test.js \
  test/playback.test.js \
  test/media-session.test.js \
  test/queue-stream.test.js \
  test/container.test.js \
  test/proxy.test.js \
  test/youtube.test.js \
  test/lifecycle.test.js \
  test/follows.test.js \
  test/harness.test.js \
  test/library-integrity.test.js \
  test/station-routes.test.js
```

The browser job runs the fixture-driven suites named in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) — including the installed-Android device pass
(`android-pwa`) and the iOS queue-stream handoff and track-version harnesses — so a regression there
now fails the release gate; run them locally when changing UI or playback code. It installs `ffmpeg`
(the stream fixtures) and `dbus` (the MPRIS check) rather than assuming them. Live-YouTube suites are
the only ones left developer-run.

## Project layout

```
src/            server, routes, database, YouTube client, audio cache, rooms
public/         the entire client (HTML/CSS/JS, service worker, icons) — no build step
scripts/        admin CLI, container entrypoint, healthcheck, syntax checker, icon generator
test/           unit, integration, browser and end-to-end tests (fixtures in test/fixtures/)
docs/           design records: UI, UX, auth, rooms, the PWA device audit, design studies
.github/workflows/ci.yml   the offline, browser, image-smoke and GHCR jobs
Containerfile   production image (Node + yt-dlp + ffmpeg + PO-token plugin)
install.sh      single-command curl/bash installer
compose.yaml    hardened single-service stack; publishes 127.0.0.1:8130 and mounts ./data
compose.podman.yaml  rootless-Podman keep-id override for the ./data bind mount
.env.example    every environment variable, with explanations (copy to .env)
package.json    scripts and the seven runtime dependencies; package-lock.json pins them
PLAN.md         the engineering plan and the measurements behind the design
LICENSE         MIT
.gitignore      keeps `.env`, `data/` and any `cookies.txt` out of git (`.dockerignore` mirrors it)
```

## Deployment notes

### Migrating from Muse

The rename was mechanical, but three things live outside the source tree:

1. **Environment variables.** Rename the keys in `.env` and keep the values — especially
   `MUSE_SECRET` → `SONORA_SECRET`, which derives the key that encrypts the stored YouTube cookie
   jar. On Linux:

   ```bash
   sed -i 's/^MUSE_/SONORA_/' .env
   ```

2. **The database file.** New installs use `data/sonora.db`. An existing `data/muse.db` is still
   detected and used automatically, so nothing breaks if you do nothing. To finish the rename,
   stop the server first and move the file (plus its `-wal` and `-shm` siblings):

   ```bash
   podman compose -f compose.yaml -f compose.podman.yaml down
   mv data/muse.db data/sonora.db
   ```

3. **The container.** The image and container are now `localhost/sonora:latest` and `sonora`.
   An old `muse` container still holds port 8130, so remove it before starting the new one:

   ```bash
   podman rm -f muse
   podman compose -f compose.yaml -f compose.podman.yaml up -d --build
   ```

Two consequences are expected and one-time: session and passkey cookies were renamed, so every
**device is signed out once**, and the cookie-jar key salt changed, so a previously imported
YouTube cookie jar is discarded and must be re-imported (Admin → System → *Connect session*). The
yt-dlp venv at `~/.local/share/muse-venv` continues to be detected, so there is nothing to
reinstall.

- **Ports and origin.** The dev server and the container both use `8130` on purpose, so bookmarks,
  the installed PWA and a tunnel configuration keep working unchanged.
- **HTTPS is required for passkeys and service workers.** Put the app behind a TLS proxy or a
  tunnel (the author runs Cloudflare Tunnel). Set `SONORA_RP_ID`, `SONORA_ORIGIN` and
  `SONORA_PUBLIC_URL` to the public origin when the proxy rewrites `Host`.
- **Persist `./data`.** It contains the database, the audio cache and the materialised cookie jar.
  Back it up with *Admin → Storage → Download backup* (a consistent `VACUUM INTO` snapshot, safe to
  take while the server runs) or by copying the files while the server is stopped.
- **Keep `SONORA_SECRET` stable.** Rotating it invalidates every session and makes the encrypted
  YouTube cookie jar unreadable (you will need to re-import cookies).
- **Do not run the container and `npm start` against the same `./data` at the same time.**
- **Container privileges stay bounded.** The compose service drops all capabilities, sets
  `no-new-privileges`, and limits the container to 256 PIDs. Commented `cpus: 2` / `mem_limit: 2g`
  examples are optional starting points, not defaults; tune them to the host before enabling.

## Security notes

- All state is local. There is no telemetry and no third-party service beyond YouTube itself.
- Session cookies are `HttpOnly`, `SameSite=Lax`, HMAC-signed and `Secure` on HTTPS/localhost by
  default (`auto` mode). Refresh tokens rotate on use and a replayed one revokes the device — except
  inside `SONORA_REFRESH_GRACE_MS` (30 s), where a second tab presenting the same token rotates its
  successor forward instead of signing the browser out; set it to `0` for strict revocation.
  Passkeys are optional and revocable per device.
- The imported YouTube cookie jar is encrypted at rest with a key derived from `SONORA_SECRET` and is
  never sent back to a client.
- Public listening rooms use a separate, room-scoped guest cookie so "anyone with the link" cannot
  become "anyone can proxy any video". The boundary is covered by tests.
- **Never commit `.env`, `data/`, or any `cookies.txt`.** They are in `.gitignore`; keep it that
  way.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ui.md`](docs/ui.md) | Interface structure, design tokens, layout and playback behaviour |
| [`docs/ux-spec.md`](docs/ux-spec.md) | The production-polish contract the UI was built against |
| [`docs/auth.md`](docs/auth.md) | Credentials, sessions, devices and passkeys |
| [`docs/rooms.md`](docs/rooms.md) | Listen Together: database, wire format, sync algorithm, limits |
| [`docs/sleeve-first-direction.md`](docs/sleeve-first-direction.md) | The sleeve-first visual direction: one real cover as the front door |
| [`docs/sleeve-first-v2.md`](docs/sleeve-first-v2.md) | The unification pass — the class-name contract shared by `public/app.css` and `public/app.js` |
| [`docs/ui-concepts.html`](docs/ui-concepts.html) | Three explorable interface directions (open it in a browser) — the study `sleeve-first-direction.md` implements |
| [`docs/pwa-device-audit.md`](docs/pwa-device-audit.md) | The Android-phone device pass: install, lock screen, background playback, offline, deep links, passkeys and layout — what was verified, with evidence, and what could not be |
| [`PLAN.md`](PLAN.md) | The engineering plan and the measurements behind the design |
| [`.env.example`](.env.example) | Every environment variable, with explanations |

## Legal

sonora is a personal, self-hosted client for content you are entitled to access. It is not
affiliated with YouTube or Google. Respect the terms of service of any service you point it at,
and use it for personal listening only.

## License

[MIT](LICENSE) © the sonora authors.
