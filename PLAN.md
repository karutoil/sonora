# sonora — personal YouTube music PWA with a learning recommender

Status: **P0–P2 working and tested** (2026-10-18). Decisions: iOS, Cloudflare Tunnel,
fresh build (does **not** use the Discord bot), multi-user from day one.

Everything in "Measured" below was verified on this host, not assumed.

## Run it

```bash
cd ~/projects/muse-pwa
SONORA_SECRET=$(openssl rand -hex 32) SONORA_PASSPHRASE='your-passphrase' \
  npm start            # http://127.0.0.1:8130
npm test               # 143 tests, hits live YouTube, ~40s
```

First run creates user `toil` with `SONORA_PASSPHRASE`. yt-dlp is already installed at
`~/.local/share/sonora-venv/bin/yt-dlp`.

### In a container (podman)

```bash
cp .env.example .env   # then fill SONORA_SECRET=$(openssl rand -hex 32)
podman compose up -d --build   # same http://127.0.0.1:8130 as dev
podman compose logs -f
podman compose down            # state stays in ./data
```

Same port on purpose, so bookmarks, the phone PWA and any tunnel config keep
working. `./data` is bind-mounted, so the container and `npm start` share one
database and audio cache (never run both at once — SQLite is the reason).

The image adds what yt-dlp needs and the host already had: ffmpeg (downloads
arrive as m3u8), a JS runtime (`node`, for YouTube's JS challenges) and the
bgutil PO-token plugin. Compose points `SONORA_POT_PROVIDER` at
`host.containers.internal:4416` — inside a container `127.0.0.1` is the
container, not the host, so the provider would otherwise look absent.

`scripts/container-entrypoint.sh` refuses to boot with an empty `SONORA_SECRET`.
The app deliberately falls back to a random per-process key when it is unset
(right for a laptop, wrong for a container, where it would silently sign every
device out on each restart and lose the AES key for the stored YouTube jar).
Note `??` in `config.js` does not catch an empty string, so the check is in the
entrypoint, not there.

## The three findings that shaped this

### 1. googlevideo is IP-bound (why there must be a proxy)

Deciphered URLs embed the resolving host's IP in `sparams` and expire in ~6h:

```
ip= 2600:1700:b230:6da0::32    sparams= expire,ei,ip,id,itag,...
```

The phone can never play a URL the server resolved. Everything goes through
`GET /api/stream/:videoId`.

### 2. googlevideo serves only the first ≤1 MiB (why a byte proxy is impossible)

Measured against the `IOS` client:

| Range sent upstream | Result |
|---|---|
| `bytes=0-65535` … `bytes=0-1048575` | 206 |
| `bytes=0-2097152` | 403 |
| `bytes=0-` (open-ended — **what `<audio>` sends**) | 403 |
| `bytes=1048576-`, `bytes=2000000-`, even 1 byte mid-file | 403 |

So a transparent range proxy would stall one megabyte into every song. This was
the bug that made the first version silently skip through the entire queue.

**Fix: download the whole file, then serve ranges off disk.** yt-dlp negotiates a
client that is allowed the full file — a 3.4 MB track arrives in ~2 s (~25× realtime),
and it works with no PO token (it uses the `visionos` client). Side benefits: seeking is
instant, URL expiry stops mattering, and replaying costs zero network.

### 3. iOS closes the audio session on a natural `ended` (why `loop` is always on)

From WebKit behaviour (undocumented, but reproducible): when a track ends naturally
and nothing else is playing, iOS closes the app's audio session. In the background it
will not reopen, so playback dies at track end and the lock screen shows a paused
track. Pausing and seeking do *not* close it.

Implemented in `public/app.js` and `public/playback.js`:
- `audio.loop = true` always — the element never emits `ended`.
- Detect the loop wrap (a non-manual jump from >3 s to <1.5 s), pause, switch source,
  and start the next track **inside the event** (background timers are delayed).
- The wrap is detected on `seeking` **and** `timeupdate`. WebKit on a locked iPhone can
  loop without emitting `seeking`; `timeupdate` is then the only witness, and without it
  the same song repeats forever. Both events call one idempotent `endTrack()` so a single
  wrap can never skip two tracks.
- `navigator.audioSession.type = 'playback'` is claimed on every play intent (feature
  detected). Without the long-form category WebKit drops the audio session after a couple
  of silent seconds — exactly the buffering gap between two tracks.
- Media Session handlers are re-registered on **every** `playing` event, and
  `seekbackward`/`seekforward` are explicitly set to `null` — otherwise iOS ignores
  them and substitutes ±10 s buttons.

Verified in a real browser: seeking to the end advanced to the next track with
`ended` never firing, Media Session metadata updated, and a `timeupdate`-only wrap
(no `seeking` event) still advanced exactly one track.

**Update — the category has to be *re-sent*, not re-asserted (2026-10-21).** The
`navigator.audioSession.type = 'playback'` line above is necessary but not enough, and
its failure mode is the nastiest one in the app: on a locked phone the tab keeps
*playing* — playhead advances, tracks advance, the lock screen keeps updating,
`audio.paused` stays `false` — while the device is silent, and nothing fires that a
page can observe. Cause (WebKit bug 323104): the web process caches the category it
last sent (`RemoteAudioSession.cpp` returns early when the requested value equals the
cached one), while the GPU-side session is recreated empty after a GPU-process
relaunch — which is what locking a phone does to a backgrounded tab. The fresh
session has no demand from this page, resolves to **ambient**, and ambient is what
the Ring/Silent switch silences. Assigning `'playback'` again is then a no-op against
that cache, so the app's guarded re-assertion (`if (type !== 'playback')`) could
never recover: unlocking and pressing play was the only way out.

The fix lives in `public/audio-session.js`: `claim()` is the cheap one-liner for play
intents, and `repair()` moves the category to a *different* value and back, so two
`SetCategory` messages go through and the GPU-side session is repopulated. The pair is
synchronous (a frozen page may never run a deferred callback, and ending on
`playback` means it can never be left muted), with a rate limit so the ambient step —
which briefly lets other audio mix back in — is not paid on every event. It runs where
a session can be lost rather than everywhere: `visibilitychange` in both directions,
`pageshow`/`resume` (a restored page has a fresh process chain behind the same DOM),
and `playing` while the document is hidden (a lock-screen skip is otherwise the one
unreachable case). The first gesture claims the category outright, because WebKit
ignores an assignment made from a timer or an async continuation. The guest room page
(`public/listen.js`) claims it too — a guest has one gesture and no app shell, so
without it the room is ambient and the Ring/Silent switch silences it.

Also fixed alongside: iOS can interrupt the session (a call, Siri, another app) and
leave the element paused while the tab still believes it is playing. Returning to the
page now resumes it — and, if the browser still refuses, stops claiming it is playing
rather than showing a play button over silence. The one pause a person *can* make while
locked is the lock screen's own pause button: that handler marks the pause as
deliberate (`state.userPause`), so an interruption is undone and a decision is not.

Tested in `test/audio-session.test.js`: the module's contract in plain node (one
assignment for a claim, the ambient→playback cycle for a repair, the rate limit, a
page that freezes before the deferred step, no API, a throwing setter), the wiring in
`public/app.js`/`public/listen.js` statically, and the real assignment sequence in
headless Chromium with `navigator.audioSession` instrumented (it has no such API, so
the fake is also what makes the case reachable). Device-side confirmation of the
diagnosis, for the next time it is suspected: **flip the Ring/Silent switch to RING
while the phone is silent** — if sound comes back with no reload, the tab is in the
ambient category and this is the bug.

### 4. The lock screen silently drops artwork and the seek bar

Three separate rules, each of which fails with no error in the page, the console or
the network log — the controls still appear, only the cover and the scrubber are
missing. Isolated in `public/media-session.js` so they can be tested without a phone:

| Rule | Why |
|---|---|
| Artwork must be **absolute and same-origin** | WebKit renders nothing for a cross-origin `i.ytimg.com` URL, and ignores relative srcs. Art goes through `/api/img/<id>` like every `<img>` in the UI. |
| `sizes` must match the **real bitmap** | iOS discards artwork whose declared size is a lie. `/api/img/<id>` is `hqdefault.jpg` → `480x360`. |
| `setPositionState()` is **required** for a scrubber | Without it the lock screen shows title/artist/art only. It throws `RangeError` when `position > duration`, so position is clamped. And a scrubber is dead without a `seekto` handler. |

Position state is refreshed from `timeupdate` (throttled to ~1 Hz — every call crosses
into the media process), plus `loadedmetadata`, `durationchange`, `seeked` and `pause`.
Metadata is published in `playIndex` as well, so a phone locked while the next track
buffers does not keep showing the previous one.

A `seekto` to 0 looks exactly like the loop wrap from finding #3, so the seek sets
`state.manualSeek`/`state.lockSeek`; the `seeking` handler consumes the flag *after*
the wrap test (never a timer — background timers are delayed), and `timeupdate` clears
it as a safety net. A stale flag would stop the queue advancing forever.

Verified in a real browser (`test/lockscreen.test.js`): the artwork URL is same-origin
and its declared size equals the loaded bitmap, the seek bar tracks the audio, a
lock-screen seek to 0 moves the playhead without skipping the track, and the
seek-to-zero wrap still advances the queue afterwards.

### 5. Resuming where you left off — on the same device or another one

`player_state` is one row per user, so it is the shared hand-off point: the phone
writes it while playing, and the laptop reads it on boot. The position is persisted
with the queue (a window of 60 tracks *around* the playhead, not the first 60) and is
applied only after `loadedmetadata`/`playing` knows the real duration. The player bar
shows the saved position before play (`resumes at 1:01`), and the home hero names the
device it came from (`UP NEXT · FROM YOUR IPHONE` → **Continue here**).

Two open players must not overwrite each other every five seconds, so the row records
its owner:

- every save carries a stable per-browser `deviceId`/`deviceName`;
- a save from a non-owner is refused with `409` **plus the current state**;
- the loser mirrors that state, pauses and stops writing (a toast announces the
  hand-off) instead of fighting over the playhead;
- only an explicit play intent (`play`, a track pick, next/prev, a lock-screen command)
  sets `takeover: true` and claims the session back;
- a session untouched for 12 hours is stale and may be claimed silently.

A device that booted into someone else's session is a **reader** until the user plays:
background/visibility saves are skipped, so merely opening the app on a second device
cannot steal the session. Restoring is still not playing — nothing autoplays.

## Architecture

```
iPhone (installed PWA)
  <audio loop>  ──► GET /api/stream/:id ──► Fastify ──► data/audio/:id.m4a ◄── yt-dlp
                        (ranges off disk)                  (cache, LRU)
  POST /api/events  ──► plays table (the taste signal)
  PUT  /api/now     ──► player_state (resume here or on another device)
```

- Node 22 + Fastify 5, **`node:sqlite`** (no native build).
- Sessions are stateless HMAC cookies (`scrypt` password hashing), so a restart does
  not log every device out.
- The rate limiter covers `/api/` only: one page load fetches a dozen shell assets, and
  a 429 for `app.js` is a blank page. Auth keeps its own tight limit.
- `user_id` is on every table already — multi-user is free later.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login`, `/logout`, `/refresh`, `GET /api/auth/capabilities` | auth |
| `GET /api/me`, `GET /api/auth/security` | session + devices + passkeys |
| `POST /api/auth/passkey/{register,login}/{options,verify}` | WebAuthn |
| `PATCH`/`DELETE /api/auth/devices/:id`, `POST /api/auth/devices/revoke-others`, `POST /api/auth/signout-all` | device control |
| `GET /api/search?q=` | search (20 results) |
| `GET /api/radio?seed=` | `yt.music.getUpNext` → the recommendation graph |
| `GET /api/station` | first page of the endless personal station (cached 10 min) |
| `GET /api/station/next?cursor=&exclude=` | the next page: never cached, never repeats the queue |
| `GET /api/stream/:id` | audio, ranged from disk |
| `POST /api/events` | `start` / `progress` / `complete` / `skip` |
| `POST /api/likes`, `GET /api/likes` | library |
| `GET /api/stats` | starts/skips/completes/likes, `readyForRanking` at 50 plays |
| `GET`/`PUT /api/now` | session resume, with device ownership (`409` on a non-owner save) |

## Decisions still needed

**Cloudflare Tunnel has a ToS problem.** Cloudflare's docs: the public-hostname
tunnel on Free/Pro/Business is "subject to the terms", and streaming video/large files
without Stream gets redirected. Audio is far smaller than video, but a 3.4 MB-per-track
proxy is exactly the "disproportionate amount of large files" pattern they describe.
Cloudflare's own documentation points at **private network routes** as the allowed
path for "large-file or high-traffic workloads" — i.e. `cloudflared` + WARP, not a
public hostname.

Recommendation: use a **private route** (WARP on the phone) and skip the public
hostname. Tell me which you want and I'll wire it up — `cloudflared` 2026.8.3 is
already installed but logged out.

Also: live streams (24/7 radio) are refused with a clear message. Supporting them
needs the HLS pump from the Discord bot, or just accept songs.

## The recommender (not built yet)

Single-user collaborative filtering is degenerate — there is no user-user signal, so
"CF for one user" just learns to replay your top 20. The plan is three layers:

1. **Graph (free, strong, day one).** `yt.music.getUpNext` returns 50 related tracks;
   persist as weighted edges and random-walk with restart from recent positives.
2. **Embeddings.** CLAP/MERT on 30 s previews → vectors in `sqlite-vec`, kNN. This is
   what separates "same texture" from "same artist". Nightly CPU batch (the RX 6600 is
   gfx1032 — no ROCm).
3. **Contextual bandit.** Thompson sampling over three generators (graph / kNN /
   explore) with a ranker over: decayed artist affinity, embedding cosine to recent
   positives *and negatives*, graph proximity, completion rate, recency penalty.
   Diversity via MMR.

**Diversity is not deferred to the bandit any more.** The first complaint about the
station was "I only get songs from the same artist" — a *lane* problem, not a ranking
problem: the station asked YouTube one question ("more like this song") and YouTube
answers that with the same band. The four-lane page is built now (see "Station
breadth" below); the bandit will replace how the lanes are *weighted*, not whether
they exist.

Signals are already being recorded. Two data-quality bugs were found and fixed while
testing — both would have poisoned the model:
- `start` used to log on `src` assignment, so a failed resolve wrote a fake play
  (432 bogus plays in one session). Now logged on `playing`.
- Skips were never logged at all. Now logged on user-initiated next/prev when
  played <30 s.

Eval gate: hold out the next N plays, beat both random and same-artist baselines on
precision@10. Also scrobble to Last.fm as an off-device backup of taste.

## Station breadth: four lanes, two familiar to one new (2026-10-20)

Reported: *"I am only getting songs from the same artist more than we get new songs
from different artists."* The station took priority as designed, but it had exactly
one expansion source — `yt.music.getUpNext` for each seed — and up-next is a
same-artist machine. Measured on the real history: a 30-track page was 13 tracks from
seed artists, and page 1 of the extension was **7 of 20 from Red Hot Chili Peppers**
and 6 from Jason Aldean. Over three pages: 42 distinct artists, 39% from artists
already in the history, with three names owning 23 of 70 tracks.

A page is now built from four lanes (`src/station.js` `LANE`):

| lane | source | what it answers |
|---|---|---|
| `seed` | your likes + play-throughs | "this queue is mine" (first page only) |
| `sameArtist` | up-next, *plus* catalogue searches of your top artists | "more of what I play" |
| `adjacent` | the unfamiliar half of up-next, *plus* the catalogues of your artists' "fans also like" | "a new name, same taste" |
| `trending` | YouTube Music's **genre page** Songs shelf | "what is big in this lane" |

`planPage()` sets the weights: **two thirds familiar, one third discovery**, with
trending capped at ~10% so the station cannot become a chart. `slotOrder()` spends the
slots with smooth weighted round-robin, so lanes *interleave* instead of block-sorting.
`buildStation()` then enforces, in order: refusals → per-artist cap (2) → familiar
ceiling (`FAMILIAR_SHARE`) → the lane's turn. A lane that runs dry hands its turn to
the others, so a thin catalogue shortens nothing.

Three things were learned the hard way and are pinned by tests:

1. **Classify recommendations by artist, not by pool.** Two thirds of up-next results
   are artists already in the history. Tagging the whole up-next list `sameArtist` let
   the familiar lane silently own 17 of 30 slots. The server now splits up-next into
   `familiarRecs` / `newRecs` by looking each artist up against the full history.
2. **Resolve neighbours by channel id, never by name.** "Default", "Creed" and
   "Flaws" are artist names *and* ordinary words; a name search returned a rapper with
   "(feat. …)" in the title, a Hillsong worship band, and a podcast. The id is the only
   thing that means one artist.
3. **The genre is inferred, not hard-coded.** Every genre tile's Songs shelf is fetched
   once per process (14 pages, ~1.4 s, warmed at boot), and the tile that lists the most
   of your artists — weighted 3× — plus the most of their *neighbours* wins. Verified:
   Nickelback → Rock, Morgan Wallen → Country & Americana, Radiohead → Indie &
   alternative. A plain search for a genre word answers with a decade's back catalogue,
   not what is big now.

Measured after (same history, same three pages): **59 distinct artists, 0 duplicates,
~1.2 s per page warm** (was 1.0 s with one lane), 4 ms cached. The per-page lane split
is returned as `lanes` in the API response and advertised as the `station-lanes`
feature, so "why is my station all one band" is answerable from the payload instead of
by reading logs.

Next step for this lane, if it still feels too familiar: decay the familiar share as a
function of how many consecutive pages the listener has been on, and let skips on
`adjacent` tracks lower that lane's weight (a bandit over four fixed arms, which is a
much smaller change than the full ranker above).

## Next

- P3: graph random-walk radio, then the bandit + eval harness.
- Tunnel (see above), then validate on the actual iPhone.
- Optional: offline pinning, live-stream HLS, playlists.

---

# Why metadata was slow, artwork 404'd, and playback took 30 s (2026-10-20)

Reported: "Music metadata is taking forever to load and might 404, playing music can
take upwards of 30 seconds." Both symptoms had the same root cause, and it was not
in the application.

## 1. The container could not resolve names quickly (root cause)

Rootless podman hands every container its own forwarder: `/etc/resolv.conf` says
`nameserver 10.89.24.1` (aardvark-dns). Measured from inside the running container:

| Query | Via podman's forwarder | Via the host's resolver |
|---|---|---|
| `lookup i.ytimg.com` | **2503 ms**, every time | 1 ms |
| `resolve4 google.com` | 2502–4505 ms | 24 ms |
| `lookup example.com` | 2514 ms | — |

Exactly 2.5 s per query, uncached, for every name. Node resolves per *connection*,
and this app opens a lot of them:

- **Artwork** (`/api/img/<id>`, one per row in every list): ~2.5 s each. The proxy's
  timeout was 8 s and the browser fires a dozen at once, so the tail of every burst
  hit the timeout and rendered as a **404** — the reported "might 404".
- **Playback**: yt-dlp resolves ~5 names per run, so a cold track cost 12.5 s of pure
  DNS on top of a 2 s download. Container logs showed `/api/stream` at **15–22 s**.
- **Every Innertube call** (search, radio, station, lyrics) paid the same per request.

**Fix:** pin real resolvers in `compose.yaml` (`dns:`, overridable with
`SONORA_DNS_1`/`SONORA_DNS_2`). Verified inside the container: 1–17 ms per lookup.

| | Before | After |
|---|---|---|
| 12 cold thumbnails, concurrent | 8 s+, most 404 | **0.17 s**, all 200 |
| Cold track, first byte | 15 s (22 s worst in logs) | **2.5 s** |
| Cached track | — | 6 ms |
| `/api/search` (cold session) | 5.5 s | **0.45 s** |
| `/api/station` | timed out / 500s | 1.0 s cold, 2.6 ms cached |

## 2. Fixes that make it stay fast

These are worth having even with DNS fixed — they remove work, not just latency:

- **Prefetch the next track** (`POST /api/warm/:id` + `warmNext()` in `app.js`). The
  queue already knows the successor, so its yt-dlp run happens while the current
  track plays. The endpoint answers `202 {warming:true}` in ~2 ms (never blocks),
  dedupes against an in-flight download, and the next `/api/stream` becomes a disk
  read. Measured: press-next latency went from 2.5 s to **3.5 ms**.
- **Negative-cache artwork misses** for 2 minutes. A dead cover used to re-pay a full
  upstream timeout on *every repaint*; now the second request answers locally.
- **Artwork timeout 8 s → 5 s.** Nothing legitimate takes longer once DNS answers.
- **Skip the liveness probe for cached tracks.** `isLive()` is a full YouTube
  round-trip, and it ran before the cache was consulted — so the first request for an
  already-downloaded song still paid for it.
- **Warm the Innertube session at startup.** Creating it costs ~5 s (it fetches the
  player and config); it used to land inside the first user search. First search
  after a restart went from 5.5 s to **0.46 s**.

## 3. A second, independent cause: `no-store` on every `/api/` response

The global `onSend` hook set `cache-control: no-store` on everything under
`/api/`, and because it runs *after* the route handler it silently overwrote the
headers the artwork proxy and the audio stream set for themselves. Consequences:

- **Artwork was never browser-cached.** 677 image requests in one afternoon; every
  navigation re-downloaded every cover from the origin.
- **Audio ranges were never browser-cached**, so a seek could not reuse a window the
  element had already fetched.

**Fix:** the hook now only fills in `no-store` when the handler did not set a cache
policy. Artwork and audio keep `private, max-age=86400`; personal JSON (`/api/me`,
`/api/recent`, `/api/likes`, …) is still explicitly `no-store`. Verified: revisiting
home makes 6 image requests, all 6 served from the browser cache.

## 4. Tests

- `test/latency.test.js` — real browser (headless Chromium), no stubs: every rendered
  `img.cover` must decode (`naturalWidth > 0`) and come from `/api/img/`; starting
  playback must POST a warm for the *next* queue id (not the playing one); a warmed
  track must answer `ready` and then stream in under a second.
- `test/e2e.test.js` — artwork proxy caching (and its `max-age`), remembered 404s,
  host allowlisting, personal JSON staying `no-store`, and warm → ready → 206-in-under-
  a-second against live YouTube.
- `test/proxy.test.js` — warm answers immediately (202) and does not block; duplicate
  warms do not double-fetch; a cached track is served with no upstream probe; audio
  keeps a real `max-age` instead of `no-store`.
- `test/container.test.js` — `compose.yaml` must declare resolvers, and they must not
  be loopback (the exact regression that caused this).

Note for anyone touching the browser tests: the **first** http navigation in a fresh
headless Chromium profile stalls 25 s on this host (reproduced against a plain
`python3 -m http.server`, so it is the browser, not the app). `latency.test.js`
absorbs it in `before()` so it cannot be mistaken for an app regression.

---

# sonora — design implementation (2026-10-19)

The concept file `~/projects/sonora_music_ui.html` is now the real UI. The design
system is taken **verbatim** (36 KB stylesheet, 31-symbol icon sprite, identical
class names and layout), and the fictional data layer is replaced with live data.

## What carried over unchanged

- The full stylesheet, including the `--accent:#ff997b` palette, the
  `235px / 1fr / 292px` desktop grid, and every breakpoint (1600/1310/1080/810/650/380).
- The icon sprite (31 `<symbol>`s), `brand`, `hero` orb + rings, `waveform`,
  `quick-card`, `music-card`, `track-row`, `station`, `now-modal`, `drawer`, `toast`,
  `context-menu`, `profile-popover`.
- Interaction model: click-delegation on `data-action` / `data-page` /
  `data-collection` / `data-track`, Cmd-K, Esc, Space, Alt+arrows, hover-reveal
  play buttons, mobile bottom nav.

## What was replaced (fictional → real)

| Concept file | Now |
|---|---|
| 16 hardcoded songs | live YouTube search + radio |
| 16 base64 album arts | real thumbnails via a same-origin proxy |
| 8 hardcoded playlists | real playlists in SQLite, per user |
| `setInterval` fake playhead | `<audio>` + Media Session |
| Simulated lyrics | `yt.music.getLyrics` (real, cached) |
| Fake artist list | artists ranked from your own play history |
| Fake album list | real YouTube releases by those artists |
| "Interactive concept" toast | actual playback |

## New backend surface

| Endpoint | Purpose |
|---|---|
| `GET /api/img/:videoId` | thumbnail proxy (allowlisted, cached, auth'd) |
| `GET /api/img?u=` | channel-avatar proxy (host allowlist) |
| `GET /api/lyrics/:videoId` | real lyrics, cached 6h |
| `GET/POST /api/playlists`, `/:id`, `/:id/tracks`, `DELETE` | full playlist CRUD |
| `GET /api/browse/albums`, `/artists` | real entities, artists from history |
| `GET /api/album/:id` | open a real YouTube release (`MPR…` catalogue album or `PL…` playlist) |
| `GET /api/album/for/:videoId` | which release a song belongs to, matched on the song, not the upload |
| `GET /api/artist/:id` | an artist page: popular songs, albums, singles, videos, neighbours (id or name, cached) |
| `GET /api/recent` | derived from the plays table |
| `GET /api/status` | bot-gate / cookie state for the UI |

Playlists and playlist items are user-scoped: every query carries `user_id`, so
one account cannot read another's playlist.

## Bugs found by driving the real UI

- Playing from search lost metadata (player showed the raw video id) — fixed with
  a track index + `completeTrack()`.
- Thumbnails failed in-browser while the same URLs worked from the host — moved to
  a same-origin proxy (also better privacy: the client never hits Google's CDN).
- `saveSession` did not persist `durationS`, so restored queues showed `0:00`.
- `isLive()` was a hard prerequisite, so a failed check blocked playback entirely.
  It is now best-effort.
- Artist search ranked by nothing (small fan channels first); now ranked by
  audience, and the Artists tab is derived from actual listening history.
- Channel avatars were dropped because the URL lives in `author.thumbnails` and is
  protocol-relative.

## Tests

55 tests: 48 pass, 0 fail, 7 skipped.

- `proxy.test.js` — 12 offline, deterministic tests for range/seek/chunking,
  using a synthetic 3 MiB file. No network, no yt-dlp. This is the part that
  broke twice, so it must never depend on YouTube.
- `library.test.js` — 17 tests for playlists, isolation, lyrics, browse, artwork,
  and that the served CSS/HTML still carries the concept's design tokens.
- `e2e.test.js` — live tests; the streaming ones now **skip with a reason** when
  YouTube gates the IP, instead of failing.

## Known blocker (external, not a bug)

From 2026-10-19 this host gets `LOGIN_REQUIRED: "Sign in to confirm you're not a
bot"` on **every** YouTube client (IOS/ANDROID/TV/WEB/MWEB/YTMUSIC) for both
youtubei.js and yt-dlp. Search, radio, lyrics, thumbnails and the whole UI still
work; audio download does not.

Wired and ready:
- `SONORA_YT_COOKIE` — raw Cookie header for Innertube
- `SONORA_YTDLP_COOKIES` — path to a Netscape `cookies.txt` for yt-dlp

The UI now surfaces this: `/api/status` reports the gate, and the player explains
it instead of silently skipping through the queue.

This is exactly the failure mode flagged in the original plan, and it is why the
Discord bot already had a `YOUTUBE_COOKIE` escape hatch.

---

# Connecting a YouTube session (2026-10-19)

When YouTube bot-gates the IP, the app now **prompts the user and offers to
connect their own session** instead of failing silently.

## Why it is a file import, not a login button

An in-app Google sign-in is not buildable:

- Google refuses OAuth inside embedded webviews (`disallowed_useragent`).
- YouTube's auth cookies are `HttpOnly`, so a bookmarklet or in-page script
  cannot read them either.

So the flow mirrors what the yt-dlp docs prescribe: export `cookies.txt` from a
real browser, then import it. The sheet walks through it step by step, links the
open-source "Get cookies.txt LOCALLY" extension, and accepts either a drag-drop,
a file picker, or a paste.

## When it appears

- **Automatically** on boot if `/api/status` reports a bot gate.
- **Automatically** the moment playback fails with the gate (after the failure
  guard trips), with a toast explaining why.
- **Manually** from the profile menu → *Connect YouTube*.

## Server side

| Endpoint | Purpose |
|---|---|
| `POST /api/youtube/cookies` | validate + verify + store an imported jar |
| `GET /api/youtube/status` | connected / source / imported-at / expiry |
| `DELETE /api/youtube/cookies` | forget the session |

Import pipeline:

1. Parse Netscape format (handles `#HttpOnly_` prefixes, tabs, JSON rejection).
2. Require a real sign-in cookie (`SID` / `__Secure-*-PSID`) plus corroboration —
   a jar with only `PREF`/`CONSENT` is rejected before any download.
3. Store, then **verify against YouTube** with `yt-dlp --simulate` on a real
   video. If YouTube still asks for a sign-in, the jar is rolled back and the
   user sees why. A jar is only ever reported as "connected" if it works.
4. On success: clear the gate flag, reset the cached Innertube session, and both
   yt-dlp and Innertube pick up the new identity.

## Security

Cookies are equivalent to a password, so:

- Encrypted at rest with AES-256-GCM, key derived from `SONORA_SECRET` via scrypt.
- Materialised as `youtube-cookies.txt` with mode `0600`.
- Never returned by any endpoint — asserted by a test that greps the status
  response and the raw SQLite file for cookie values.
- Import rate-limited (10 per 5 minutes).

## Bugs found while testing this

- `playIndex()` reset `state.failures` on every advance, which defeated the
  "stop after 3 failures" guard: a broken upstream skipped endlessly through the
  queue and never prompted. The counter now only resets on `playing`.
- Escape did not close the connect sheet (only the player and queue drawers).

## Tests

`cookies.test.js` — 11 tests, fully offline via a stub yt-dlp whose behaviour is
selected by a marker inside the jar. Covers: auth required, empty/JSON input,
missing sign-in cookie, a jar YouTube rejects (rollback + no file left behind),
a working jar, `0600` permissions, encryption at rest, survival across a restart
(via `restoreJar()`), and disconnect cleanup.

## Fixes after the first real import attempt (2026-10-19)

A user pasted cookies and it "did not work". Reproduced three defects:

1. **The instructions pointed at the wrong domain.** They said sign in at
   *youtube.com* and export there. The sign-in cookies (`SID`, `HSID`, `SSID`,
   `SAPISID`...) live on the **google.com** domain and are not visible to a
   youtube.com-scoped export, so the jar contained only visitor cookies
   (`PREF`, `YSC`, `VISITOR_INFO1_LIVE`) and could never authenticate. The steps
   now say google.com explicitly and tell the user to pick *Export all cookies*.
   The rejection message names what it actually found, so the failure explains itself.
2. **Verification could not tell success from "nothing was blocking".** The probe
   only ran *with* cookies. When the IP was not gated, YouTube served it with no
   cookies at all, so a jar of garbage was reported as verified. Verification now
   probes **with and without** the jar and compares:
   `baseline fails + jar works -> verified`, `both work -> unproven`,
   `jar fails with auth error -> rejected`, `other error -> unproven`.
   The UI shows "Session saved" with an amber *not yet proven* note instead of a
   green tick it has not earned.
3. **A possibly-good jar was destroyed by an inconclusive test.** Rollback now
   happens only on an explicit auth rejection; an inconclusive probe keeps the jar
   and marks it `unproven`. Added `POST /api/youtube/verify` and a *Test
   connection* button so the user can re-check later.

Also: JSON exports are now accepted (`[{name,value,domain}]`), since several
popular extensions produce JSON rather than Netscape.

---

# "Another way to get this working" — investigation (2026-10-19)

## Switching libraries would not help: the suggested repo *is* the current library

`github.com/LuanRT/YouTube.js` is **youtubei.js** — the package already in
`package.json`, already at the newest release (18.2.0, npm latest = 18.2.0).
So there was nothing to switch to. What *was* worth testing is whether its own
PO-token path beats yt-dlp, so I built that test.

Result: youtubei.js can mint a valid BotGuard PO token via `bgutils-js` and
reach the stream, **but it hits the same IP-level gate on mid-file ranges** —
first 1 MiB returns 206, every later offset returns 403. Switching libraries
cannot fix an IP-level block.

## What actually helps (all now wired)

| Mitigation | Effect | Status |
|---|---|---|
| **PO-token provider** (bgutil container, port 4416) | defeats *client-level* checks | installed, running, `restart=always` |
| **JS runtime** (deno) | yt-dlp needs it; was warning on every run | installed at `~/.deno/bin/deno`, auto-detected |
| **Proxy** (`SONORA_YTDLP_PROXY`) | the only thing that changes the IP | wired, not configured |
| **Cookies** | account-level identity | wired (needs a google.com export) |

Honest limit: on 2026-10-19 with the gate active, **none of PO token, deno, or
every player client I tried** got past it. PO tokens fix the client-level bot
check; they do not fix an IP that Google has flagged. Only a different egress IP
does that, which is why `SONORA_YTDLP_PROXY` is wired and documented.

## The gate is intermittent

Measured repeatedly: identical commands failed with "Sign in to confirm you're
not a bot", then succeeded minutes later, then failed again. So "it doesn't
work" and "it works" are both true at different moments on the same setup. The
app now tracks this with a 30-minute window instead of a permanent flag.

## New: staged diagnostics

`GET /api/youtube/diagnose` (and a **Diagnose** button in the connect sheet)
reports each layer separately, because one opaque "playback failed" was hiding
which part was broken:

1. PO token provider reachable
2. JS runtime present
3. Proxy configured (advisory, not a hard failure)
4. Metadata via youtubei.js (usually works even when gated)
5. Extraction via yt-dlp — the one that decides whether audio can flow

It returns concrete advice for the failing case instead of a generic error.

---

# Instance admin (2026-10-19)

An admin is a **database role**, not a flag in a cookie and not a separate
login page. `users.role` is `'user'` or `'admin'`, it is re-read from SQLite on
every request, and the whole `/api/admin/*` surface answers 403 without it.

## Assigning the role

The bootstrap account is created as an admin, so a fresh instance always has
one. Everything else is assignment by hand — no email, no invite, no UI
chicken-and-egg:

```bash
npm run admin -- list               # who exists, and their role
npm run admin -- promote alice
npm run admin -- demote alice
npm run admin -- disable alice      # blocks sign-in and revokes sessions
npm run admin -- enable alice
```

The same thing in SQL, which is the contract the feature actually promises:

```sql
UPDATE users SET role = 'admin' WHERE name = 'alice';
```

Existing databases upgrade in place: `CREATE TABLE IF NOT EXISTS` never adds
columns, so `role`, `disabled`, `session_version`, `last_login_at` and
`last_seen_at` are migrated with `ALTER TABLE`. When the `role` column is first
added, the **oldest account is promoted** — that is the account that ran the
bootstrap, and it means an upgrade cannot lock the owner out. The migration is
pinned by `test/migration.test.js`, which builds a pre-role database, boots
against it, and asserts both the promotion and that a pre-role session cookie
still works.

## What an admin can actually do

| Section | Actions |
|---|---|
| Overview | counts, cache/database size, recent admin activity, backup, vacuum |
| Users | create (user or admin), change role, reset passphrase, sign out everywhere, disable/enable, clear play history, delete |
| Library | search the track catalog, delete a track from every user's history/likes/playlists *and* its cached audio |
| Storage | inspect the audio cache, prune to a MB limit, delete all cached audio, download a consistent DB snapshot, vacuum |
| System | runtime/memory/config (no secrets), YouTube session status, connect/replace/clear, staged diagnostics |

Destructive actions land in `admin_audit` (actor, action, target, detail), so a
mistake is explainable instead of mysterious.

## The guards that keep an instance usable

These are the failure modes a role system introduces, and each one is refused
rather than allowed:

- **No self-lockout.** You cannot demote, disable or delete your own account.
- **No last-admin removal.** Demoting/disabling/deleting the only active admin
  is a 400, and `npm run admin` refuses it too.
- **Password reset revokes sessions.** Sessions are stateless HMAC cookies, so
  revocation is `session_version + 1`; the token carries the version it was
  issued with. Resetting your *own* passphrase signs you out and the UI reloads
  to the login screen.
- **Disabling revokes sessions.** A disabled account's existing cookies stop
  working immediately, not in 90 days.
- **The YouTube jar is admin-only.** It is instance-wide: one Google account
  serves every listener, so letting any user replace it would let them point the
  instance at their own identity. Non-admins see a toast telling them to ask an
  admin instead of a sheet that would 403.

## Two implementation notes

**Roles are read per request, never from the token.** The session payload only
carries `uid`, `ver` and `exp`. Adding `role` to it would have meant a stale
token keeps admin rights after a demotion; reading `users.role` costs one
indexed lookup and is always correct.

**The admin page is not a separate app.** It is a page in the existing shell
(same nav, same player, same tokens), because an admin is also a listener. The
nav entry is rendered from `/api/me`, but that is convenience only — every
`/api/admin/*` handler calls `requireAdmin`, and the tests assert a normal user
gets 403 on all of them.

## Tests

`test/admin.test.js` — 16 tests over the real HTTP surface: bootstrap is admin,
403 for anonymous and normal users on every admin route, input validation,
duplicate names, self-lockout refusals, password reset + session revocation,
disable/enable, admin sign-out, history clearing that keeps likes, track
deletion that removes likes, storage prune/clear/vacuum, a downloaded backup
that really starts with `SQLite format 3`, a system payload that does not leak
the session secret, role changes taking effect on the *same* cookie, user
deletion, and the audit trail.

`test/migration.test.js` — 4 tests for the upgrade path described above.

`test/db.test.js` — role assignment, admin counting, and cascading user
deletion.

---

# Login, remember-me & passkeys (2026-10-20)

The sign-in screen was a single 430px card over the app with two fields, and a
session cookie that lived for 90 days whether or not anyone asked for it. It is
now a real screen with a real account model behind it. Full details in
`docs/auth.md`; the decisions worth recording here are the ones with trade-offs.

## Short access token, rotating refresh token

The access cookie is a stateless HMAC payload — that is what keeps a phone's
many ranged audio requests cheap — but a stateless token cannot be revoked
individually. So it is now short-lived (`SONORA_SESSION_MINUTES`, 12h) and carries
a **device id**. Deleting the device row invalidates every token that names it,
which is what makes per-device sign-out real without giving up statelessness.

"Remember me" issues an opaque refresh token whose SHA-256 is all the database
keeps, and it **rotates on every use**. Presenting a consumed token is treated
as theft and deletes the whole device, so a stolen token is worth one request to
an attacker and a forced re-login to the victim. Two tabs racing is handled the
same way, which is why the client funnels every 401 through one shared refresh
promise.

Without "remember me" the access cookie is session-scoped, and signing in
explicitly revokes any older refresh token for that device: "don't remember me"
has to mean something.

## Passkeys

`@simplewebauthn/server` with server-side challenges bound to a short-lived
cookie and consumed on first use. `userVerification: 'required'`, discoverable
credentials, and no account enumeration: an unknown name still gets valid
options.

A passkey is scoped to a registrable domain, so `http://192.168.1.50:8130` can
never work and the browser will not even prompt. Rather than fail mysteriously,
`/api/auth/capabilities` reports `supported: false` with the reason and the UI
shows that instead of a dead button. `SONORA_RP_ID` / `SONORA_ORIGIN` cover the
tunnel case where `Host` is rewritten.

Counter regression is rejected — but only on a non-zero counter, because many
platform passkeys report 0 forever and treating that as a clone would lock out
every iPhone.

## Devices

One browser is one row, keyed by the `localStorage` id the player already uses
for "same device resuming". From `#/security` a person can rename, sign out,
forget (drop the refresh token but stay signed in), sign out every other device,
or sign out everywhere. An administrator's "sign out" for a user now destroys
that user's devices and refresh tokens too, so a disabled or password-reset
account cannot quietly renew itself.

## Gaps closed while in here

- A failed sign-in used to close the login card and show "Not signed in."
  instead of "Wrong name or passphrase." — `api()` now only pulls the auth
  screen for a 401 on an *authenticated* endpoint, and reads the body first.
- The name field was prefilled with the bootstrap username, leaking it.
- A 429 surfaced as "Too Many Requests"; it is now "Too many attempts. Wait a
  minute and try again.", and the limit is configurable (`SONORA_LOGIN_RATE_MAX`)
  because a household can share one IP.
- `#/security` needed its own route entry, and boot had to kick its loader —
  deep links rendered the page but never fetched it.
- Boot now prunes expired tokens, expired ceremonies and devices unseen for 60
  days.

## Tests

`test/auth.test.js` (14 HTTP tests) and `test/passkey.test.js` (7 tests in real
Chromium with a CDP virtual authenticator, including a full register → sign in →
sign out everywhere → remove round trip through the actual UI).
