# sonora on an Android phone — PWA device audit

A device-level pass over everything the app promises a phone: install, lock screen,
background playback, offline, deep links, passkeys and layout. This document records
what was verified, with what evidence, and — just as important — what could *not* be
verified on this machine.

Run it with:

```bash
npm test                                             # the whole suite, this audit included
node --no-warnings --test test/android-pwa.test.js   # just the device pass (~21 s)
```

Verified in this tree on 2026-11-12 (Node v22.22.2):

```console
$ node --no-warnings --test test/android-pwa.test.js
# tests 12
# pass 12
# fail 0
# skipped 0
# duration_ms 20714.152316
$ npm run lint
check-syntax: 26 files parse cleanly (src/, public/, scripts/).
```

Whole-suite totals are deliberately not quoted here: they move with every commit, and a
number in a document outlives the run that produced it. The stable claims are that this
file is **12 checks and all 12 pass** (skipped 0 — the MPRIS check found its D-Bus
session bus), and that `npm run lint` is clean.

Screenshots from the last run are written to `.tmp/android/` (git-ignored), along with
`layout.json` — every measured viewport, the smallest target found and every target
under 44 dp.

---

## 1. What "Android" means in this audit

**There is no Android emulator on this box, and there cannot be one.** Verified:

```console
$ ls -l /dev/kvm                    # no such file
$ mknod /tmp/kvmtest c 10 232       # Operation not permitted
$ grep Cap /proc/self/status        # CapEff: 0000000000000000, no cap_mknod
$ sudo -n true                      # "no new privileges" flag is set
```

The KVM modules are loaded on the host, but the device node is absent and this account
cannot create it, so `qemu`/the Android emulator would fall back to full software
emulation — and an x86_64 system image refuses to boot without acceleration at all.
Sideloading Chrome onto an AOSP image on top of that is not a test, it is an
archaeology project.

So the phone is reproduced one layer lower, at the layer that decides what the web app
sees: the renderer. Everything a PWA can observe there is what a phone would report; where
a headless browser can only be *told*, the mechanism is named in the table, and the few
places that remain a patch rather than a device are called out.

| What a phone gives a PWA | How it is produced here |
| --- | --- |
| Android Chrome UA + `navigator.userAgentData` (`platform: Android`, model, `mobile: true`) | `Emulation.setUserAgentOverride` with full user-agent metadata |
| 412×915 dp at DPR 2.625, five touch points, `pointer: coarse`, `hover: none` | `Emulation.setDeviceMetricsOverride` + `setTouchEmulationEnabled` + `setEmitTouchEventsForMouse` |
| Status-bar and navigation-bar safe areas (`env(safe-area-inset-*)`) | `Emulation.setSafeAreaInsetsOverride` (24 dp top, 48 dp bottom) |
| `display-mode: standalone` — an installed app | a real Chromium **app window** (`--app=…`), which is the only genuine `display-mode: standalone` a headless box can produce. The device emulation *also* sets the `display-mode` media feature (`test/helpers/android.js`) so the same window can be driven across profiles — so the assertion alone cannot separate the two, and the app window is what makes it real |
| The screen locking while music plays | a real background tab: the app receives a genuine `visibilitychange` → `hidden` from the browser, which is exactly the state an audible page is left in when a phone screen goes off |
| Doze / frozen renderer | `Page.setWebLifecycleState('frozen')` |
| No network | `Network.emulateNetworkConditions({offline:true})` — a real offline flag in the network stack, with the service worker on the real path |
| The OS media layer the notification is drawn from | **MPRIS over a private D-Bus session.** Chromium publishes the same `media_session` state an Android notification is built from: `PlaybackStatus`, `xesam:title`, `xesam:artist`, `mpris:length`, `mpris:artUrl`, `CanGoNext`… and its `Next`/`Pause`/`Play` calls are delivered back into the page |

The audio is real audio: `test/fixtures/silent-6.m4a` (6 s of AAC, generated the same
way as the other audio fixtures — `ffmpeg -f lavfi -i anullsrc=r=8000:cl=mono -c:a aac
-b:a 8k`, see `test/helpers/audio-fixture.js`) copied into the
server's audio cache, so `<audio>` plays, loops, ends and hands off exactly as it does for
a listener — no yt-dlp, no YouTube, no network.

Device profiles (`test/helpers/android.js`): Pixel 8 `412×915 @2.625`, Pixel 5
`393×851 @2.75`, a 360 dp Samsung `SM-G991B`, a 320 dp Pixel 4a, and a Pixel Tablet.
The suite runs the Pixel 8 unless a check says otherwise.

## 2. Verified on the emulated phone

`test/android-pwa.test.js` — **12/12 passing**, each one a real assertion, not a screenshot:

| # | Check | What the evidence is |
| --- | --- | --- |
| 1 | The app boots on a phone that reports itself as an Android device | UA `Android 14; Pixel 8`, `coarse`/`hover:none` true, `standalone` true, insets 24/48, and a relaunch stays signed in |
| 2 | Chromium would install this as an app | `Page.getInstallabilityErrors` → `[]`; manifest parses; `id`/`start_url`/`scope` = `/`, `display: standalone`, 192/512/512-maskable icons, `background_color`, ≥3 shortcuts, `launch_handler.client_mode: focus-existing` (a shortcut tap must not reload the running app) |
| 3 | The lock screen gets artwork, metadata, a seek bar and track buttons | `navigator.mediaSession` receives absolute same-origin `/api/img/…` artwork (`320x180`, and **no declared MIME type** — `/api/img` relays the upstream `content-type`, so a hardcoded one is dropped silently the moment it disagrees with the bytes), title/artist/album, in-range position state, and `play`/`pause`/`previoustrack`/`nexttrack`/`seekto` handlers while `seekbackward`/`seekforward` stay null |
| 4 | **A song ends and the next one starts while the screen is off** | with the page genuinely `hidden`, the 6 s track wraps, the queue advances to track 2, the element keeps playing, **no `paused` state is ever published to the OS**, the new track is named, and the handlers are re-registered while hidden |
| 5 | The notification can skip, pause and seek while the app is off screen | `nexttrack`, `pause`, `play` and `seekto` invoked on the published handlers while `hidden` all move the player, and a seek does not skip the track |
| 6 | Freezing the app does not lose the session | after a renderer freeze/thaw the media session and its buttons survive, and one press resumes the same track (no replay, no double-skip) |
| 7 | The app fits every phone size Android ships, portrait and landscape | no horizontal overflow, player bar above the bottom nav (412/360/320 dp) and on-screen, sidebar only ≥811 dp, smallest measured target 44 dp (see finding 3) |
| 8 | The shell installs itself, boots with no network, and says what still needs one | active worker + `sonora-shell-*` cache containing `/`, `/app.js`, `/app.css`, `/pwa.js`, `/manifest.webmanifest`; offline cold start renders "You are offline — sonora needs a connection to reach YouTube"; the offline pill admits playback needs a connection; an offline `/t/<id>` deep link gets the branded offline page with a retry |
| 9 | A home-screen shortcut and a shared link land inside the installed app | `?page=search` → `#/search` with the search field, `?collection=liked` → `#/c/liked`, `/t/<id>` renders the card, and the back gesture stays inside the document |
| 10 | The operating system receives the session, and its buttons drive the app | MPRIS: `PlaybackStatus: Playing`, title/artist/album, `mpris:length` 6000000 µs, `mpris:artUrl` present (Chromium fetched the artwork itself), `CanGoNext/Previous/Play/Pause/Seek` all true; `Next` advances the queue, `Pause`/`Play` round-trip |
| 11 | Notifications are not requested on boot, and the bell is honest | `Notification.permission` is never silently granted; the panel offers an explicit "Enable alerts", or explains a blocked permission instead of offering a dead button |
| 12 | A passkey registered on the phone signs the app back in | virtual platform authenticator: passkey created and listed as "Android passkey" (named from the device UA), then sign-out and sign-in with the passkey alone |

Screenshots: `.tmp/android/{pixel8-home,pixel8-playing,pixel8-portrait,galaxy-portrait,
compact-portrait,pixel8-landscape,offline-shell,offline-page,pixel8-passkey}.png`.

## 3. Findings

### 3.1 Fixed: a launcher shortcut opened Home instead of the page it names

Home-screen shortcuts are the one PWA entry point a phone user actually taps, so this
mattered. Two things combined:

1. `pwa.js` translated `?page=search` into a click on the nav — that click works, and it
   pushes the app's route (`#/search`) via `history.pushState`.
2. `pwa.js` then consumed the shortcut with
   `history.replaceState(null, '', location.pathname)` — **which discarded the hash the
   click had just produced**. `app.js` boots asynchronously and reads its route from
   `location.hash` when it settles, found nothing, and applied `#/home`.

Traced in the browser (capture phase listeners on click and on both history methods):

```
click [data-page=search]  t=41
pushState "#/search"      t=42      ← the app navigated
replaceState "/"          t=55      ← pwa.js wiped the route
replaceState "#/home"     t=69      ← boot() settled on Home
```

`public/pwa.js` now replaces only the query string (`location.pathname + location.hash`,
keeping `history.state`), and `#/search` survives boot.

The existing test ("a manifest shortcut lands on the page it names") passed throughout:
it waited for a *transient* `.active` class, which exists for the ~14 ms between the
click and the wipe, and then asserted `pathname === '/'` — which was true either way. It
now waits for the settled app and asserts the search field, the hash and the title; a
second test covers `?collection=liked`. Both fail if the bug is reintroduced.

### 3.2 Offline is the app shell only — there is no offline playback

The service worker deliberately never caches `/api/`, `/stream/` or `/audio/`, and the
audio cache lives on the **server's** disk, so with no network the app paints its own
offline page ("You are offline — sonora needs a connection to reach YouTube") and the
offline pill says "You're offline — playback needs a connection." That is coherent, but for a phone app it
is the largest remaining gap: a listener on a train gets the chrome and nothing to play.

Recommendation, in order of value for effort:

1. **Downloaded tracks** — a "Download" action per playlist/album that pulls the already
   range-served audio into the Cache API (`cache.addAll` of `/api/stream/<id>` is enough),
   plus a PlaybackList / storage-usage screen. The server already caches on disk; the
   client needs its own copy and the SW needs a `/stream/` cache-first branch for
   downloaded ids only.
2. **Offline queue** — plays/likes taken offline are currently lost. A Background Sync
   job (`SyncManager.requestSync`) that replays them on reconnect would make the app
   feel finished on a bad connection. Nothing in the tree references `SyncManager` or
   `requestSync` today — there is no capability probe for it to "already pass", so the
   feature detect is part of the work.
3. **Quota honesty** — `navigator.storage.persist()` is requested and the grant is now
   verified with `persisted()` (`public/pwa.js`, around the service-worker
   registration), but the outcome only reaches `console.debug`: nothing surfaces it in
   the UI and nothing shows quota, so evicting the shell stays invisible until it
   happens offline.

### 3.3 Fixed: the landscape topbar arrows were 36 dp, and now measure 44 dp

`layout.json` from the last run reports the smallest measured target as 44×44 dp and
`targetsUnder44` as empty: every button on the bottom nav, the player and the topbar
clears WCAG 2.2's enhanced target, including the two `Go back` / `Go forward` icon
buttons in the wide (landscape phone / tablet) layout, which are the pair that used to
be 36 dp. Android's own guidance is still 48 dp, so this clears the accessibility floor
without yet meeting Google's.

The suite enforces it: `test/android-pwa.test.js` fails any target under **44 dp**
in every measured profile. The floor used to be 36 dp — the same number the arrows
measured — so it could not have caught the bug this section records; it now matches
the app.

### 3.4 A landscape phone gets the desktop sidebar

At 915×412 the app crosses its ≥811 px breakpoint and shows the sidebar instead of the
bottom nav. Nothing overflows and the player stays on screen, so this is a design
decision rather than a bug — but it does mean a phone turned sideways is running a layout
designed for a window, with 130 px of the 412 px height spent on the player.

### 3.5 Passkeys require a hostname, so install from `https://` (or `localhost`)

The app is correct here, and it is worth knowing before installing on a phone: a PIN
cannot be a WebAuthn RP ID.

```console
$ curl -s http://127.0.0.1:8130/api/auth/capabilities
{"passkeys":{"supported":false,"rpID":"127.0.0.1",
 "reason":"Passkeys are bound to a domain name, not an IP address. …"}}
$ curl -s http://localhost:8130/api/auth/capabilities
{"passkeys":{"supported":true,"rpID":"localhost"}}
```

Installing the PWA from `http://192.168.x.x:8130` therefore gives a phone with no
passkey sign-in *and* no secure-context service worker. The phone install needs HTTPS on
a real name (the tunnel/proxy path the README documents).

## 4. What this audit could not verify (needs a phone or an emulator with KVM)

Be explicit with yourself about these; they are the checks that would need real hardware:

- **The notification shade itself** — that Android renders the session as a media
  notification with a large icon, a scrubber, and the right buttons. The state that
  notification is built from is verified end-to-end (§2.10), the renderer is not.
- **Audio focus and interruptions** — a call, Maps, or another player taking the output,
  ducking, and the app's recovery afterwards.
- **A real screen lock** — `visibilitychange` is emulated faithfully, but the OS scheduler,
  Doze buckets and "the app was in your pocket for three hours" are not.
- **The iPhone lock, specifically** — on iOS the page stops running entirely when the screen
  locks (PLAN.md finding #6), which is a *stronger* form of this: Android keeps delivering
  media events to a hidden page and the per-track handoff works there, while iOS cannot run
  the handoff at all. That is why the player hands the element a continuous server-built
  queue stream on the way into the background on iOS, and why the check below is "the music
  keeps going", not "the app recovers". A browser cannot reproduce it:
  `test/queue-stream-handoff.test.js` proves the stream crosses a track boundary with the
  player never touching the source again, and the premise itself comes from the production
  log (the phone's last save is the `visibilitychange` one, and the track's end produces
  nothing).
- **WebAPK minting / the install flow** — the install *gate* is verified
  (`getInstallabilityErrors` is empty), the Play-Store-free WebAPK build is not.
- **Hardware buttons** — Bluetooth headset play/pause/next, wired remote, Android
  Assistant, Android Auto.
- **Keyboard/IME and Android accessibility settings** — "Display size"/"Font size" at 130%,
  the keyboard inset, predictive-text behavior.
- **Splash screen** rendering from `background_color` + icons.

If you want these, the runner is a phone with `adb`: install the app on Chrome for
Android, then

```bash
adb shell input keyevent KEYCODE_POWER                       # lock the screen
adb shell dumpsys media_session | head -60                   # what Android was told
adb shell cmd notification post -S bigtext -t sonora hi      # sanity-check the shade
adb shell input keyevent KEYCODE_MEDIA_NEXT                  # notification button
adb logcat -s chromium:*                                      # renderer + media logs
```

`chrome://inspect` over `adb forward tcp:9222 localabstract:chrome_devtools_remote` gives
the same CDP surface these tests use, so most of §2 can be re-pointed at the phone.

## 5. The rest of the PWA checklist

Things worth testing (or adding) beyond the lock-screen question. "Covered" means an
existing or new test asserts it.

CI runs this audit's own file. `.github/workflows/ci.yml` has two test jobs: the offline `unit`
job (no browser) and the `browser` job, which runs cdp, passkey, ux, layout, safe-area,
ios-chin, flows, listen-page, listen-venue, player-artist, track-handoff, audio-session,
media-session, queue, search-ui, share, notifications, pwa, rooms-browser, android-pwa,
queue-stream-handoff and track-version. The browser job installs `ffmpeg` and `dbus` so the
stream fixtures and the private D-Bus session bus the MPRIS check reads are present rather
than assumed; without the bus that one check skips with a named reason rather than failing.
`lockscreen` and `latency` need the live network as well as a browser, so both stay
developer-run — the table below says what is asserted, and which suite it is asserted in.

| Area | State | Notes |
| --- | --- | --- |
| Installability gate, manifest fields, maskable icon | covered | §2.2 |
| Standalone layout at 320–915 dp, landscape, safe areas | covered | §2.7 |
| Service worker install/activate/precache, update offer, no mid-track swap | covered | `test/pwa.test.js` (in CI's `browser` job) |
| Offline shell + offline deep link | covered | §2.8 |
| **Offline *playback*** | **missing feature** | §3.2 — the biggest one |
| Media Session metadata/artwork/position/actions | covered | §2.3, `test/media-session.test.js`, `test/lockscreen.test.js` |
| Auto-advance with the screen off | covered | §2.4 |
| OS transport controls (skip/pause/seek) | covered | §2.5, §2.10 (MPRIS) |
| Notification actions, permission honesty | covered | §2.11, `test/notifications.test.js` |
| Notification **badge** on the app icon | **not implemented** | `navigator.setAppBadge` is absent; the unread bell could drive it with one call |
| Web **Share Target** (share a YouTube link into sonora → search) | **not implemented** | `share_target` is absent from the manifest; the app already has the search page to receive it |
| Web Push for followed-artist releases | **not implemented** | alerts only exist while the app is open (stated honestly in the UI); a phone with the app closed gets nothing |
| Background Sync for offline likes/plays | **not implemented** | nothing in the tree probes or uses `SyncManager`; see §3.2 |
| Shortcuts / deep links / share cards | covered | §2.9, `test/share.test.js` |
| Back gesture stays in the app | covered | §2.9 |
| Passkeys in the installed app | covered | §2.12 |
| Session survives a relaunch | covered | §2.1 |
| Storage persistence / eviction | partial | `persist()` is requested and the `persisted()` grant is checked in `public/pwa.js`, but only into `console.debug`; nothing in the UI shows the grant or the quota |
| Autoplay policy (gesture required) | partial | the harness clicks play; `test/rooms-browser.test.js` and `test/listen-venue.test.js` relaunch with `autoplayPolicy: 'document-user-activation-required'` and assert the start overlay survives the refusal |
| Reduced motion | covered | `test/ux.test.js` case "G" asserts `prefers-reduced-motion:reduce` removes page/card/sheet animation; `test/pwa.test.js` asserts the CSS block ships |
| Android font scaling / `text-size-adjust` | **untested** | needs `font-size` overrides or a phone |
| RTL / other locales | **untested** | manifest declares `en`/`ltr`; no RTL audit |
| Screenshots in the manifest (richer install sheet) | covered | `public/screenshots/narrow.png` and `wide.png` are declared in the manifest and present; `pwa.test.js` only lists them if the files exist |
| Long queues / memory over an album | **untested** | `take_heap_snapshot` exists in the harness tooling; nothing asserts a bound |
