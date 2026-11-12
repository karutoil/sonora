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

## The findings that shaped this

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
- Detect the loop wrap (a non-manual jump from >3 s to <1.5 s), replace the source and
  start the next track **inside the event** (background timers are delayed).
- **While the page is hidden, the handoff does not pause the old source.** A pause is
  exactly where iOS reclaims the audio session, and it does not hand it back until the
  listener returns to the app: the replacement is accepted, `audio.paused` goes false,
  the metadata updates, and then the Now Playing widget empties out and nothing is
  audible. A manual "next" in the background never pauses and is known-good on the
  device, so the auto-advance now makes the same `playing → src → play` transition
  instead of routing through a pause the manual path never takes. With the page visible
  the pause is kept (it costs nothing there and is the ordering the loop workaround was
  developed against), and the queued pause is marked as a source switch so it is never
  mistaken for a listener pausing playback.
- The wrap is detected on `seeking` **and** `timeupdate`. WebKit on a locked iPhone can
  loop without emitting `seeking`; `timeupdate` is then the only witness, and without it
  the same song repeats forever. Both events call one idempotent `endTrack()` so a single
  wrap can never skip two tracks.
- `navigator.audioSession.type = 'playback'` is claimed on every visible play intent. A source swap
  while the page is hidden **forces the full repair sequence before the new `src` is assigned**.
  Without the long-form category WebKit drops the audio session after a couple of silent seconds —
  exactly the buffering gap between two tracks. A hidden handoff is the moment the web process's
  category cache and the GPU session are most likely to disagree, so `playIndex()` cannot trust
  `claim()` there; visible swaps keep the cheap claim because visibility/page lifecycle events have
  already repaired the category.
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

**Update — the interruption rarely ends while we are looking (2026-11-02).** Coming
back to the page was the only recovery, and it is the wrong moment: the call is hung up
or the directions prompt finishes while the listener is *still in the other app*, which
fires no `visibilitychange`, no `pageshow` and no `playing`. The player stayed paused
until the app was opened — and a paused background tab never auto-advances, so the
queue stopped at the end of the current track and the OS's Now Playing widget emptied
out. `navigator.audioSession` reports exactly this edge, so `public/audio-session.js`
now exposes `onResume()`: it watches for `interrupted → active` (the edge, not the
level, so an idle session waking up between two sources is not mistaken for a resume)
and the player calls the same `resumeIfInterrupted()` it already used on
`visibilitychange`. The same update removed the pause from the *hidden* track handoff,
which was the other half of the same failure — see finding #3 above.

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

Four separate rules, each of which fails with no error in the page, the console or
the network log — the controls still appear, only the cover, the scrubber or the
*buttons* are wrong. Isolated in `public/media-session.js` so they can be tested
without a phone:

| Rule | Why |
|---|---|
| Artwork must be **absolute and same-origin** | WebKit renders nothing for a cross-origin `i.ytimg.com` URL, and ignores relative srcs. Art goes through `/api/img/<id>` like every `<img>` in the UI. |
| `sizes` must match the **real bitmap** | iOS discards artwork whose declared size is a lie. `/api/img/<id>` is `hqdefault.jpg` → `480x360`. |
| `setPositionState()` is **required** for a scrubber | Without it the lock screen shows title/artist/art only. It throws `RangeError` when `position > duration`, so position is clamped. And a scrubber is dead without a `seekto` handler. |
| The handlers must be **re-registered while hidden** | Registering them once at boot is not enough; see below. |

Position state is refreshed from `timeupdate` (throttled to ~1 Hz — every call crosses
into the media process), plus `loadedmetadata`, `durationchange`, `seeked` and `pause`.
Metadata is published in `playIndex` as well, so a phone locked while the next track
buffers does not keep showing the previous one.

A `seekto` to 0 looks exactly like the loop wrap from finding #3, so the seek sets
`state.manualSeek`/`state.lockSeek`; the `seeking` handler consumes the flag *after*
the wrap test (never a timer — background timers are delayed), and `timeupdate` clears
it as a safety net. A stale flag would stop the queue advancing forever.

**Update — the media centre shows ±seek buttons instead of previous/next (2026-11-07).**
Reported from a real iPhone: lock the phone mid-song and the Now Playing widget swaps
the track arrows for two ±15 s skip buttons. Nothing in the page changes and nothing
throws. Read out of WebKit's own source (`RemoteCommandListenerCocoa.mm`):

```cpp
auto currentCommands = !supportedCommands().isEmpty() ? supportedCommands().unionWith(minimalCommands())
                                                      : defaultCommands();
```

`defaultCommands()` is Play, Pause, TogglePlayPause, begin/end seeking, SeekToPlaybackPosition
and **SkipForward/SkipBackward — with no PreviousTrack/NextTrack**. So an *empty*
page command set does not mean "no buttons"; it means "the ±15 s buttons". The set
empties because locking the phone relaunches the GPU process, which is the same
relaunch finding #3's category cache suffers: `NowPlayingManager::removeClient()`
drops the remote-command listener and a later `addClient()` builds a fresh one whose
`m_supportedCommands` starts empty. `MediaSession::setActionHandler()` is the only
thing that repopulates it (`addSupportedCommand` on the non-null branch), and the
player had only ever called it on `playing`, `pause` and a `visible` transition.

That is exactly the set of moments a locked phone does not produce: audio keeps
playing, so there is no `playing` and no `pause` — and finding #3 deliberately
*removed* the pause from a background handoff, which is what closed the last one.
So the command set stayed empty for the rest of the song and the buttons stayed wrong.

The fix is a keep-alive in `public/media-session.js`: while the document is hidden,
`position()` re-runs `installHandlers()` — one beat a second for the first 30 s after
locking (when the relaunch lands), then one every 15 s, because a phone in a pocket
stays locked for hours. It rides `position()` rather than a timer on purpose:
`timeupdate` is the one event that keeps firing on a locked iPhone (finding #3), and
a background timer may not run at all. Repeating is nearly free — WebKit keeps the
commands in a `HashSet` and `updateSupportedCommands()` early-returns when the set is
unchanged, so a repeat beat costs no MediaRemote IPC, and the beat that matters is the
one that lands after the relaunch. `installHandlers()` also re-arms on *both*
visibility transitions now, not only the way back in, and the guest room page
(`public/listen.js`) does the same.

`seekbackward`/`seekforward` stay explicitly `null` through every beat: registering
them would put SkipForward/SkipBackward into the set and re-create the bug.

Deliberately *not* handled: a page that is hidden **and paused**. A paused element
emits no `timeupdate`, so there is nothing to ride — and nothing needs riding, because
`PlayCommand` is in `defaultCommands()`, so the lock screen's play button still works,
and resuming fires `playing`, which re-registers everything. A polling timer there
would burn battery to fix what one press already fixes.

Verified in a real browser (`test/lockscreen.test.js`, `test/media-session.test.js`):
the artwork URL is same-origin and its declared size equals the loaded bitmap, the seek
bar tracks the audio, a lock-screen seek to 0 moves the playhead without skipping the
track, the seek-to-zero wrap still advances the queue afterwards, and — with the page
forced hidden and the playhead ticking on real timers — the app re-registers
previous/next repeatedly, keeps the seek buttons nulled, never pauses the element, and
a `nexttrack` press from that state really skips the track.

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

### 6. A locked iPhone runs no page script, so the next track has to already be in the stream

Reported against the live instance (2026-11-09): *"On iOS when the phone is locked and
the track ends, it does not play the next track automatically."* Everything in finding #3
was already shipped and working on the visible player — the wrap detector fires from
`timeupdate`, the hidden handoff never pauses, the audio session is repaired before the
swap — and the track still stopped at the boundary.

The production log says why, and it is not the player: the page stopped running. The last
request the phone made was `PUT /api/now` at `19:20:24.866` — the `visibilitychange` save,
i.e. the instant the screen locked — with the playhead at 149.5 s of a 176 s track. That
save is *driven by `timeupdate`* (`saveSession` is throttled to one write per 15 s and
called from the timeupdate handler), so its cadence is a heartbeat for "this page's media
events are still arriving": every 15 s while unlocked, and then nothing. The track's end,
26 s later, produced no `/api/events` `complete`, no `/api/stream/<next>` request and no
further save for the rest of the night. The page was not slow, and nothing threw: WebKit
suspended it.

That is the documented WebKit behaviour, not a mistake in our code. A media element keeps
playing while the web process is suspended — that is how background audio works at all —
but script does not run, and the events that would tell it about a track boundary are
delivered to a process that is not executing (WebKit bug 173332 is the same failure with
`ended`; bug 261554 is the iOS 17.2+ variant where `play()` on a new `src` resolves and
is silent). A client-side auto-advance therefore cannot work in that state; the only thing
that crosses a locked track boundary is a media resource that *already contains* the next
tracks, because the media process keeps streaming it with no script involved. That is why
an internet-radio `<audio src="https://…">` plays for hours on a locked iPhone.

So on the way into the background the element is handed the queue as one stream:

- `POST /api/queue-stream/plan` (armed from every track start and every `playing`, while
  the page is still awake) answers a token plus the ordered `{ videoId, durationMs }` of
  the tracks that are *already cached*. It is a player endpoint: ids are only ever served
  out of the audio cache the player itself filled, so it is not an open YouTube proxy.
- On `hidden`, `enterQueueStream()` points the element at
  `GET /api/queue-stream/:token?at=<playhead ms>`. `src/queue-stream.js` builds an ffmpeg
  concat list — the first entry with `inpoint` at that playhead — and streams it as ONE
  fragmented MP4 (`-c copy`, paced with `-re`), repeating the list until it covers a day.
  No page script is needed from here on: track boundaries happen inside the stream.
- On `visible` (or `pageshow`), `leaveQueueStream()` maps the stream position back to
  `(track, offset)` with `public/queue-stream.js` and hands playback back to the normal
  per-track player there — so unlocking shows the song that is actually playing, at the
  right second, and seeking/duration/metadata are the real ones again.
- While the stream plays and the page *is* awake (unlock in progress, another engine), the
  mapped track drives `state.index`, the Now Playing metadata, the player bar and the
  session save; the wrap detector and `endTrack()` are inert, and any deliberate seek,
  skip or pause leaves the stream first.

Scope, deliberately: iOS/iPadOS only (every other engine keeps delivering `timeupdate` to
a hidden element, so the per-track handoff works there and a second source swap would only
add a gap) and personal playback only (a room's playhead is the server's). Every queue mode
gets a plan: queue order is the queue from the playhead; shuffle is the current track then
the rest in a fresh random order (the player picks at random too, so any order is as right
as the one it would have picked); repeat-one is the current track alone, which the server
loops — that *is* repeat-one. The first version skipped shuffle and repeat-one, which left
exactly the listeners most likely to leave the phone locked with no protection at all.

**Update — the first deploy worked, but the phone never asked for a plan (2026-11-10).**
The rebuilt image served the new shell, yet a full listening session from the iPhone
produced per-track `/api/stream/<id>` handoffs, `/api/now` saves every 15 s, `complete`
events at real track ends — and not one `POST /api/queue-stream/plan`. Two explanations
were equally consistent with the server log: the page was still the shell it had loaded
before the deploy (a PWA stays resident for days; the new worker installs and precaches in
the background while the old page keeps running), or `armQueueStream()` bailed early on the
device. Nothing the server could see told them apart, which is the real defect: a feature
whose whole design is "it happens while the page is not running" needs to say what it
decided.

So the client now reports through `POST /api/client-report` — authenticated, bounded to
4 KB, rate-limited, logged at info and never stored. It sends `live-plan` (armed, with the
track count or the failure), `live-enter` / `live-leave` (the position mapping), `live-error`
and `live-skip` (why it could not arm). Every report carries `build: queue-stream-2`, the
device name, queue length and the shuffle/repeat state, so one log line answers what three
guesses could not. The arming path also lost its last silent hole: shuffle, repeat-one and
single-track queues now all get a plan (above), and a plan that fails is reported rather
than swallowed.

A stream also has to prove it plays: four seconds after the swap, the page (while it is
still awake) checks the element is advancing — `HAVE_FUTURE_DATA` or a non-zero playhead,
not paused, no error. If it is not, the player reports `live-stalled` and hands playback
back to the per-track element, which at worst keeps the current song going. Silently
accepting a source WebKit never decodes is the one failure mode that looks exactly like the
bug this feature exists to fix.

**Update — the diagnostics paid for themselves: iOS refuses the fMP4 (2026-11-10).** The
reports from the phone, once it ran `queue-stream-2`, said it exactly:

```
live-enter ok:true  src=/api/queue-stream/…?at=4235
live-enter ok:false reason=play-rejected error=NotSupportedError
live-error
live-leave elapsedMs=0 track=qN4ooNx77u0 offsetMs=4235
```

`NotSupportedError` is the engine refusing the *source*, not a gesture (`NotAllowedError`)
— WebKit will not play an unseekable, chunked fragmented MP4 from a plain `<audio src>`.
Chromium plays it happily, which is why every test passed; fMP4 is an MSE/HLS payload on
iOS, not a progressive one. The same reports confirmed the earlier suspicion about the
missing plan in the first round: `shuffle: true`. The build that skipped shuffle had
nothing to arm, exactly as designed — and that design was wrong.

The stream is now **MP3** (`audio/mpeg`, `-c:a libmp3lame -b:a 192k`, paced with `-re`),
because a live MP3 over HTTP is precisely what a locked iPhone plays for hours — every
internet radio station is one. The cost is one lossy generation and ~1% of a core per
listener, paid only while a page is hidden. Two guards came with it:
`enterQueueStream()` forces the audio-session repair *before* it assigns the new source
(the same rule as a hidden track swap in `playIndex`), and any `NotSupportedError` —
whether it arrives as a rejected `play()` or as the element's own error event — sets
`streamBlocked` for the rest of the page and hands playback straight back to the per-track
player. A rejected stream can no longer be retried into silence, which is what "locking
the phone now stops playback right away" was: the swap replaced a working track with a
source WebKit would not decode.

Verified against the live deployment with a throwaway account: `/api/queue-stream/…`
answers `audio/mpeg`, 71 KB in three seconds (192 kbps at real time, `ffprobe` reads it as
mp3), and the deployed client in Chromium with an iPhone UA arms the plan, swaps on
`hidden`, and reaches `readyState 3` playing. What still needs the phone is only whether
iOS accepts it — the format every radio stream already proves.

**Update — the lock can arrive before the plan (2026-11-10, later).** With MP3 the phone
stopped rejecting the source, and the next report was quieter but just as precise: a plan
was armed (`live-plan ok:true tracks:27`), and then **no `live-enter` at all** — while
`/api/now` saves kept flowing for a minute and the lock-screen next button worked. Two
things came out of that:

* the page was *running* after the lock (iOS gives a locked audio page a grace period
  before suspending it), so this was not the freeze — it was the entry condition;
* `enterQueueStream()` only ran on the `visibilitychange → hidden` transition. If the plan
  for the playing track had not arrived by that instant — which is exactly what happens
  when the lock lands within a second of a track change — nothing ever tried again, even
  though the page was alive for another minute and armed several more plans.

So the plan became a **timeline** rather than "the queue starting at this track":
`GET /api/queue-stream/:token?at=` now takes an offset into the *whole plan*, and
`concatList` starts ffmpeg at whichever entry contains it (via `inpoint`), so a plan armed
for one track can start the stream two songs later — a plan is still the same queue.
`planOffsetFor()` computes that position on the client (`locate()` is its inverse, and the
test asserts they round-trip), which removes the "stale plan" race entirely.

On top of that the player now **converges** instead of relying on one transition: it tries
to enter whenever the page is hidden, playing, and has a plan — on the way in, when a plan
arrives, on `playing`, and on every `timeupdate` while still running. The armed plan is no
longer cleared while a new one is in flight. Every bail-out is reported (`no-plan`,
`not-in-plan`, `paused`, `blocked`), and repeated *failures* are throttled to one a minute
while successes always go through, so convergence cannot spam the log.

`test/queue-stream-handoff.test.js` now covers the exact shape: hide the page first, start
a new track while hidden, and the element must end up on `/api/queue-stream/…` playing once
its plan arrives.

**Update — the transport itself was wrong twice, and the device was right both times
(2026-11-10, evening).** The reports from `queue-stream-5` finally showed the stream
reaching the phone and dying there: `live-enter ok:true at:168571`, then four seconds later
`live-stalled {readyState:1, time:0, error:null}` — AVFoundation accepted the connection
and starved on an *indefinite* MP3 response; my health check reverted, the convergence
re-entered, and the page ping-ponged until it froze. An endless HTTP body is not a shape
the iOS media pipeline schedules in the background.

The transport is now **HLS**, the one shape iOS's media process is built to keep fetching
with no script: finite MPEG-TS segment files plus a playlist it re-reads on its own
cadence. One session per plan: a fast unpaced head burst (~30 s, five segments, on disk
before the first playlist is served) and a real-time tail (`-re`) cutting 6 s segments for
as long as the listener stays; the playlist is a sliding window over what exists, with a
24 s grace behind the playhead and 18 s ahead, `#EXT-X-DISCONTINUITY` at the head/tail
seam, and `#EXT-X-ENDLIST` only once the tail has died and the window reaches the last
produced segment. Segments are immutable and cacheable; the playlist is `no-store`.

Two engine rules were measured the hard way, and both are now load-bearing:

1. **The playlist URL must end in `.m3u8`.** Same bytes, same
   `application/vnd.apple.mpegurl` content type, same headers: `/root.m3u8` plays,
   `/rootnoext` is `NotSupportedError`; `/api/queue-stream/<tok>/list.m3u8` plays,
   `/api/queue-stream/<tok>` is `NotSupportedError` — at both path depths, VOD and live.
   Chromium (and WebKit) pick the HLS demuxer by the *extension*, not the content type.
   The route is `/api/queue-stream/:token/live.m3u8` for exactly this reason; every earlier
   "it works in Chromium" probe had quietly been using a `.m3u8` path.
2. **A live playlist needs at least three segments.** Apple's authoring rule, enforced by
   Chromium: a two-segment live list fails where the identical bytes with `#EXT-X-ENDLIST`
   play. A short plan therefore gets shorter head segments
   (`headSpan/3`, floored at 1 s) so the first playlist always has three.

Two robustness rules came out of watching the phone fail on a bad segment: segments are
served `no-store` rather than `immutable` (a caching layer in front that ever hands out a
partial copy would otherwise pin that corruption for an hour), and a stream failure is
counted rather than fatal — two failures in a row give up on the stream for the page, one
failure cools down for 15 s and retries, because a single truncated fetch through a tunnel
is not a verdict on the transport.

And segments are **re-encoded** (`-c:a aac -b:a 128k -ar 48000 -ac 2`), not remuxed:
copying through the concat demuxer emits non-monotonic-DTS warnings at track seams and the
resulting TS decodes to `MEDIA_ERR_DECODE` in the browser (measured: same segment bytes as
VOD play, concat-cut ones do not), and a queue is heterogeneous YouTube rips — 44.1/48 kHz,
mono/stereo, LC/HE-AAC — whose codec configuration a copy stream would change mid-list.
One encoder pass makes every segment of every plan one stream; the price is a real-time
AAC encode per locked listener.

**Update — seeking while locked (2026-11-10, night).** The device log showed every
lock-screen seek doing `live-leave offset=<target>` followed immediately by
`live-enter at=<the old playhead>`: leaving the stream hands playback to the per-track
player, whose resume is asynchronous, and the hidden convergence re-entered the stream
before that resume landed — reading the element's still-old clock and snapping playback
back to where it was. After about a minute the page is fully suspended and the seek never
runs at all. A seek is now a move *inside* the stream: same session, new plan offset, new
`src` nonce (`k`), and the server slides its playlist window to the `at` a new `k` names.
The window itself no longer runs on the server's wall clock — it follows what the listener
consumes (each segment fetch is the playhead; between fetches it advances only while the
gap is short enough to be playing), so a paused or suspended listener keeps its window and
resumes where it left off. The in-app scrubber paints while dragging and seeks on release
while streaming; the lock-screen `seekto` and the keyboard arrows go through the same door.

Verified in headless Chromium against the real routes: plan → hidden swap →
`live.m3u8` → segments → playback across a track boundary inside the stream, convergence
while already hidden, and rejoin on visible — `test/queue-stream-handoff.test.js` drives
all four against a real server and real ffmpeg.

**Update — the health check was killing working streams (2026-11-10, night).** The phone's
own trace showed the stream *working*: `live-enter ok at=194631`, then the server log shows
the media process fetching seg 0–2 at +1 s, re-polling the playlist at +15 s and fetching
again at +16 s — and then the client's four-second health check, firing late out of a
suspended page, read the frozen JS-visible element (`readyState 1, currentTime 0`) and
reverted a stream that was playing. The revert re-entered with a fresh plan, three ffmpeg
sessions stacked inside four seconds, the per-user cap answered `429`, and the phone went
silent. Three structural fixes: the health check never judges while the document is hidden
(and never reverts a stream that has played at all); leaving a stream tells the server
(`DELETE /api/queue-stream/<token>/live.m3u8`, keepalive) so a session and its ffmpeg tail
die with the listener instead of after the idle timeout; and the per-user session cap went
from 2 to 4 so a legitimate re-entry cannot 429.

**Update — the seek still failed, because the paced broadcast could not serve it
(2026-11-11, night).** With seek-in-stream shipped, the device reports changed shape but
not outcome: `live-seek k=2 at=329819` fired, yet the element kept fetching the segments
around its *old* position and the lock-screen bar snapped back. The server log told why —
the playlist after a far seek came back **empty** (`#EXT-X-ENDLIST` with no segments).

The paced-tail transport had two structural limits that seeking hits head-on:

* the tail only ever produced audio *up to the real-time frontier*. A seek to five minutes
  into the plan asked for segments the broadcast had not reached, so there was nothing to
  list;
* and producing a segment via ffmpeg's **segment muxer** with a non-zero
  `-output_ts_offset` is a trap: the muxer splits on *absolute* PTS, so it writes a
  few-hundred-byte sliver into the `seq`-numbered file and the real audio into `seq+1`.
  The sliver then trips the sub-second guard and the segment vanishes. (Measured in the
  container: `-output_ts_offset 6.0` + segment muxer → `cut-000001.ts` = 0.021 s,
  `cut-000002.ts` = 6.0 s.)

The transport is therefore now **on-demand**: there is no tail. The playlist names the
slice the listener is in, and any segment not already on disk is cut for it right there —
one ffmpeg run per segment, `-f mpegts` single-file (never the segment muxer), with
`-output_ts_offset` at the slice start so independently-produced files share one
continuous PTS timeline and need no discontinuity tags. Seeking to any position is then
just "cut the segments there": a cold open or a far seek costs ~300 ms of encode, not a
wait for a broadcast to catch up. The overnight pace falls out for free — the media
process polls the playlist every segment, so production tracks consumption, and a
suspended listener produces nothing. A sliver guard (`< 1 s` → drop) and an atomic
tmp→serve rename keep a half-written or overshoot segment from ever reaching a playlist,
and `openQueueStream` pre-cuts the opening window so the very first playlist is never the
empty one.

**Update — absolute segment timestamps desynced the playhead, and an app switch
silenced the phone (2026-11-11, midday).** Two device reports, one root cause each.

*Positions that ran away.* The on-demand segments were stamped with their **absolute**
plan position (`-output_ts_offset start`). Chromium normalises `currentTime` to elapsed
since load, but WebKit reports the segment PTS, so on the iPhone the client computed
`startMs + currentTime` and counted the anchor **twice**. Each re-entry compounded it —
the device log shows the mapped position walking 152 s -> 999 s -> 5376 s (89 minutes in a
15-minute plan) with the queue index bouncing 0 -> 37 -> 33 -> 10 -> 37, and the server
serving `seg/828.ts`..`seg/847.ts` for a `k=9` load. The lock-screen widget emptied
because the metadata described a track nobody was hearing. Fix: every segment's PTS is now
relative to *that load's* anchor, and `-muxdelay 0 -muxpreload 0` zeroes the muxer's own
1.4 s base, so the media timeline starts at exactly 0 for every load and both engines
agree. A re-anchor (seek, re-entry) now invalidates the whole segment cache plus a
generation counter that drops in-flight cuts from the old anchor, since a stale file would
restart the timeline in the wrong place. Client-side belt and braces: `streamElapsedSeconds`
rejects any `currentTime` ahead of the wall clock since the src was assigned (a live stream
cannot run faster than time), reports it as `live-skew`, and both the mapping and
`leaveQueueStream` ignore the reading rather than believe it. Verified live: the stream
clock advanced 5.00 s across 5 s of wall time.

*Switching apps stopped the music for good.* The chain, from the device log: Discord took
the audio output mid-swap, the element paused, `leaveQueueStream` handed back to the
per-track player, and that `play()` was **rejected** — after which nothing in the page could
ever observe the silence. No `visibilitychange` (the listener never came back), no Audio
Session `statechange` (another app grabbing the output is not always classified as an
interruption), and a paused element fires no `timeupdate` to ride. The rejected-play path
also left `switching` armed, and the pause handler deliberately ignores an armed swap, so
even the intent to resume was never recorded. Two fixes: a `resumeWanted` intent set at both
rejected-`play()` sites and at a hidden non-deliberate pause, which survives the honest
`state.playing = false`; and a 10 s watchdog that calls `resumeIfInterrupted()` while hidden,
bounded to 60 attempts and reset by a real `playing`. A deliberate pause — lock screen or
transport — clears the intent and sets `userPause`, which now short-circuits the resume
decision outright, so the watchdog can never restart music the listener stopped. Both halves
are pinned by browser tests in `test/queue-stream-handoff.test.js`.

**Update — the update machinery itself bricked a locking phone (2026-11-11, morning).**
The device symptom: lock the phone, the song plays ~1 s, the Now Playing widget disappears
and returns twice, then stays blank with nothing playing. The server log told the whole
story — three full page loads inside two seconds at 07:45:29–31, then four locks over the
next half hour each reporting `live-enter no-plan playing:false` and *zero* plan requests:
the reload chain (from the previous round's "an idle page accepts updates itself") had
reloaded the app while a song was starting, raced its own SKIP_WAITING/claim, reloaded
again, and landed on a fresh paused page with no plan armed. Every later lock found
exactly that.

An auto-reload is only safe when "idle" means *settled* idle. Three guards now:

* **boot grace** — no auto-reload within 20 s of page load (the restore/startup window);
* **settled idle** — five continuous seconds of pause, and any `play` in between cancels
  the pending acceptance (iOS emits pause/play blips during the audio-session resume
  handshake, which is what fired the reload under a playing song);
* **storm guard** — an auto-reload stamps sessionStorage; a page that *boots from* an
  update reload never auto-reloads again (the pill stays for a human tap), which ends a
  SKIP_WAITING/claim race at exactly one reload.

The same settled-idle rule applies to the stale-page reload path. Pinned by two new tests
in `test/pwa.test.js`: a transient pause while playing must not reload the page, and a
storm-booted page must not auto-reload again.

What it costs, stated plainly: while the phone is locked the Now Playing widget keeps
naming the track that was playing at lock time, and the play log does not see the tracks
that went by — the page is not running, so neither can be updated. Both correct themselves
the moment the page wakes (`applyStreamPosition` maps the stream and publishes the real
track); the music, which is the point, does not stop. A lock-screen skip or pause while the
page is frozen is also not delivered — that was already true before this change.

One implementation trap worth writing down: fragmented MP4 with `frag_keyframe` alone
does not stream through a pipe. Every AAC frame is a keyframe, and with `-re` pacing the
muxer buffered and emitted the 728-byte `ftyp`/`moov` and then nothing — the element sat
at `readyState 0` forever. Measured alternatives: 71 KB in 5 s with `frag_every_frame`,
52 KB with `-frag_duration 500000`. Half-second fragments are the setting that works.

Verified in headless Chromium (`test/queue-stream-handoff.test.js`, iPhone UA, real
ffmpeg, real 4 s tracks): the plan is armed while visible and starts with the playing
track; hiding makes the element play `/api/queue-stream/…` **without pausing it**; the
first track's boundary passes with the element still on the stream, no
`/api/stream/<next>` request and no `src` reassignment — playback itself continues past
it — while the mapped title becomes the second track; showing the page rejoins
`/api/stream/<track two>` within a second of where the stream had reached and restores
`loop`. `test/queue-stream.test.js` covers the mapping, the concat list (offset, repeats,
escaping), the routes (401, ownership, 404, HEAD, hang-up) and a real stream's length from
a requested offset. What no test here can prove is the premise: that iOS stops running the
page. That is the production log above; the next device check is to lock the phone
mid-track and confirm the *music keeps going*, not just that the app recovers.

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
