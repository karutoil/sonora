# sonora — interface & interaction notes

This is the design and behaviour record for the client in `public/`. It exists
so the next change extends the system instead of fighting it.

## Structure

```
index.html          shell only: icons, sidebar, topbar, rail, page, player, nav,
                    overlays + the --app-h boot script (before any stylesheet)
offline.html        the branded offline document; carries a byte-identical
                    --app-h boot script and its own inline stylesheet
app.css             tokens → reset → typography → shell → player → pages → overlays
                    → motion → responsive → safe areas (must stay last)
app.js              the app module: state, hash router, renderers, playback,
                    interactions (it imports the five modules below)
audio-session.js    iOS audio-session category: claim 'playback' inside the first
                    gesture, and re-arm it after the page is backgrounded
playback.js         end-of-track detection for a looping <audio> (WebKit never
                    fires `ended`): isLoopWrap() + handoffTrack()
queue-stream.js     the queue as one continuous media stream: planTrackIds,
                    locate, planOffsetFor, streamSrc — the mapping that survives a
                    frozen page while the media process keeps playing
media-session.js    lock-screen / Media Session integration (artSrc, metadata,
                    position state, seekto, keep-alive)
rooms.css / rooms.js  Listen Together surfaces (namespaced .room-*) and the
                    shared-playhead client: clock offset, drift, commands
listen.js           the no-account listener page for a public room
listen-venue.js     optional `?view=venue` view of that room (people, projector,
                    record); lazy-imported by listen.js, never a second player
notifications.css / notifications.js  the bell: `.notif-*` panel styles, the
                    poll, the badge, and the OS notification
pwa.css / pwa.js    install, update and offline chrome (namespaced .pwa-*)
fonts.css + fonts/  self-hosted Inter variable (latin + latin-ext only)
icons/ + manifest.webmanifest  install icons (incl. maskable) and PWA metadata
sw.js               versioned shell precache; network-first for anything executable
```

`index.html` loads exactly three module scripts — `app.js`, `pwa.js` and
`notifications.js`. `app.js` statically imports `rooms.js`, `media-session.js`,
`audio-session.js`, `playback.js` and `queue-stream.js`, so those five are never
`<script>` tags; `sw.js` precaches the whole graph, because a module missing from
the shell is a dead offline app (`test/pwa.test.js` asserts every static import
is in the shell list). The hidden-playback modules have their own suites
(`test/audio-session.test.js`, `test/queue-stream.test.js`,
`test/queue-stream-handoff.test.js`), and `docs/pwa-device-audit.md` carries the
device record behind them.

The app is a single document with a hash router. Every page is a template
string rendered into `#page-root`; there is no component framework and no build
step. That is deliberate — the whole client is served as-is and an offline
cache can hold it.

## Tokens

Everything visual comes from the tokens in `:root` in `app.css` (a handful of
one-off literals survive — the selected chip's cream fill, some hero text
colours — but new work goes through a token):

- **Surfaces** `--bg --bg-deep --side --panel --card --card-2 --card-3`.
  Layered, warm charcoal. Depth comes from a 1px inset highlight
  (`--inset`) plus the hairline set `--line --line-2 --line-3`, and shadows
  (`--shadow-1/2/3`, `--shadow-accent`) only on things that actually float.
- **Ink** `--white --text-2 --muted --soft` — each is ≥4.5:1 on the surfaces
  it is used on.
- **Status** `--ok --warn --bad` and their soft fills `--ok-soft --bad-soft`.
- **Accent** `--accent:#ff997b` (pinned by a test), `--accent-2`,
  `--accent-ink`, `--accent-soft`, `--accent-line`.
- **Radii** `--r-xs/sm/md/lg/pill` = 8 / 12 / 16 / 22 / 999px, plus the role
  aliases `--r-cover --r-cover-lg --r-sheet` which resolve to that scale. Do
  not introduce a new value.
- **Motion** `--dur-1/2/3` (140/220/320ms), `--ease-out`, `--ease-spring`.
  Movement and entrances animate only `transform` and `opacity`. **Known gap:**
  hover/focus still transitions `background`, `color` and `border-color`
  (cheap paint, no layout), and the skeleton shimmer moves a gradient rather
  than a transform. Everything is disabled under
  `prefers-reduced-motion: reduce`.
- **Layering** `--z-topbar --z-rail --z-player --z-nav --z-drawer --z-overlay
  --z-menu --z-toast`.
- **Chrome metrics** `--topbar-h` (60px) `--player-h` (71px) `--nav-h` (67px)
  `--gutter` (17px), the layout widths `--side-w --rail-w --chrome-gutter`, plus
  the safe-area insets `--sat --sab --sal --sar` (declared in the last `:root`,
  in the safe-areas section).

## Layout

Base styles are mobile; `min-width` blocks add columns, and a few
`max-width:650px` blocks trim phone chrome (labels, nav arrows, secondary
actions):

| width | shell |
| --- | --- |
| ≤650 | one column: topbar, scrolling page, mini player, bottom nav |
| 651–810 | 69px icon rail (labels hidden); 82px player row, transport + extras |
| 811–1080 | 214px labelled sidebar, no now-playing rail; three-column player bar |
| 1081–1310 | 218px sidebar + 264px now-playing rail |
| 1311–1600 | 235px sidebar + 292px now-playing rail (the pinned desktop shell) |
| ≥1601 | 253px sidebar, 310px rail, wider gutters |

The document never scrolls; `.main` does. `.app` is padded by the safe-area
insets, and the player/nav rows grow by `--sab`, so nothing is painted under a
notch, an island or a home indicator. `test/safe-area.test.js` asserts this in a
real browser with real insets on four iPhone sizes (15 Pro, 15 Pro Max, SE and
SE 1st gen).

### Installed-app height (`--app-h`)

An iOS home-screen app can under-report its own layout viewport: `100dvh`,
`100svh`, `-webkit-fill-available` and `innerHeight` come back shorter than the
physical screen by the safe-area strip (WebKit 254868), while `screen.height`
stays honest. A shell sized by the short unit stops 20–59px above the bottom of
the screen, and the leftover band under the nav reads as a chin.

So the shell height comes from `--app-h`, not from a viewport unit:

- `index.html` runs a small inline boot script **before** the stylesheets. In a
  standalone app (`navigator.standalone` or `display-mode: standalone`) it
  publishes `--app-h`: `screen.height` in px when the shortfall looks like a
  safe-area strip (`0 < gap ≤ max(120, sat + sab + 40)`), otherwise `100vh`,
  which is the unit WebKit reports correctly in standalone.
- **`html`, `body` and `.app` all use it.** Sizing only `.app` is not enough:
  a `height:100%` root chain clips the taller shell straight back to the
  under-reported viewport, and the gap returns. This is what the first attempt
  got wrong.
- Full-screen `.overlay` / `.drawer-backdrop` take it too (`inset:0` resolves
  against the same short viewport), so sheets still reach the bottom.
- `offline.html` carries a byte-identical copy of the script (a test compares
  them) because it ships its own inline stylesheet instead of `app.css`.

It publishes nothing in Safari, where the browser chrome really does own that
space and `100dvh` is correct; in a standalone app it publishes `100vh` instead
of `screen.height` when the gap is too big to be a safe-area strip — the
keyboard (~350px), a resized or split-screen window such as iPad multitasking —
so the override is never stretched to cover those.

**Self-check.** Because a silent gap is unfixable while a labelled one is not,
`pwa.js` measures the smaller of `.app` and the root against `screen.height`
and, if the shell still cannot reach the bottom of an iOS home-screen app,
raises a dismissible `pwa-pill[data-kind="chin"]` reading *"This app can't fill
your screen — reopening it usually fixes it."* The measurement is not the
sentence: it goes on the pill's `title` and to `console.debug` as
`Display: 793px of 852px — 59px short`, where a bug report can find it.

`test/ios-chin.test.js` asserts the cold-start geometry, the post-re-measure
("dock") geometry, every refusal, and that the self-check fires only when
the shell is actually clipped.

## Home: the sleeve

Home is sleeve-first; `docs/sleeve-first-v2.md` is the token-level contract for
the `.sleeve-*` vocabulary, and this is the behaviour it has to keep.

`homePage()` renders, in order: the greeting head, `homeHero()`, `homeShelf()`,
`homeStationStrip()`, the playlists grid (`.card-grid`), then one discovery
feature. The hero is the **real** track from the restored session, not a mock-up:
`sleeveFeatured()` reads `state.home.featured` / `featuredPos`, the track's own
cover fills `.sleeve-hero-art` (the brand wash only when the catalogue has no
art), its title and channel sit on it, and one `play-btn`
(`data-action="play-featured"`) resumes it. A saved position under five seconds
renders no "N in" chip. With nothing played on this device the hero is the
branded `is-empty` fallback offering `Start listening` (`data-action="surprise"`)
and search — never an invented cover. A session restored from another device
flips the tag to `UP NEXT · FROM YOUR <DEVICE>` and the button to
`Continue here`.
`syncHomeFeatured()` keeps the hero in step with what is actually playing and
repaints only the hero and the shelf, restoring focus.

`homeShelf()` is "Back in rotation": at most six `.sleeve-tile` /
`.sleeve-shelf-item` buttons (`data-track`, same play path as any row), with a
one-line empty state plus `Find music` when nothing has been played here.
`homeStationStrip()` is the quiet second door — a `.sleeve-station` strip that
opens the station (`data-page="station"`) and a play button
(`data-action="play-station"`) beside it. Playlists and discovery stay below
the fold, where browsing belongs.

## Artists and albums

A song row answers "play this". Two other questions needed their own surfaces,
and both are answered from the Music catalogue, never guessed:

- **An artist is a page** (`#/artist/…`, `artistView()` in `app.js`). It is
  reached from the artist chips above search results, the library's Artists tab,
  the `Go to artist` row-menu item, the artist name under the title in the player
  bar and the now-playing rail, the byline on the sheet's front side, and the
  Artist line of the now-playing About tab. It shows the same shelves YouTube Music does — popular songs,
  Albums, Singles & EPs, Videos, and "Fans also like" — with Play / Shuffle /
  Station actions. `:id` may be a channel id (`UC…`) or a plain name; the server
  resolves a name through the ranked artist search, so a library entry that only
  knows what it played still lands on the right page.
- **An album is a route** (`#/c/aMPR…`). The album column of a track row, the
  row menu's `Open album`, and the About tab all lead to it, and the release's
  own cover, artist and year come from the album header. Where a row does not
  carry an album id (up next, videos, older queues), `GET /api/album/for/:videoId`
  finds the release by matching the *song* (title + credited artist), not the
  upload — the official video and the album track are different video ids. A
  miss is reported as "no album found" rather than opening a guess.

Upstream limits worth knowing: an artist's popular-songs shelf carries no
per-track duration (those rows show a blank time column rather than `0:00`), and
the album column of those rows is read from the shelf's own flex columns
("2.3B plays", "Pablo Honey") — there is no `album` object on that shelf.

## Interaction contracts

- **Routing.** `#/home`, `#/search`, `#/library`, `#/radio`, `#/station`,
  `#/admin`, `#/security`,
  `#/c/<collection>` (playlist `p3`, album `aMPR…`/`aPL…`, `liked`, `recent`),
  `#/artist/<channel id or name>`,
  `#/mood/<feeling>`, `#/t/<videoId>` (share link), `#/room/<code>` (a Listen
  Together room); anything else falls back to Discover. `navigate()` pushes
  history (and a duplicate push for the page already showing is refused);
  `popstate` and the phone's back gesture restore the previous page and its
  scroll. A page whose content is *fetched* (collection, artist, mood,
  security, room, and the `#/t/` share) must also be kicked by `boot()`:
  rendering the route alone leaves the skeleton up on a cold deep link. The
  station is the exception with no kick of its own: boot's background
  `loadStation({ silent: true })` fills both the home strip and the station page,
  which repaint when the answer lands.
- **Overlays.** `openOverlay(id, trigger, focusSelector)` stores the trigger,
  moves focus into the dialog, and `closeOverlay` restores focus. Every overlay
  is `role="dialog" aria-modal="true"`, traps Tab, closes on Escape, and plays a
  180ms exit animation (`.closing`). The now-playing sheet also dismisses on a
  downward swipe (`.dragging` disables the transition while dragging).
- **No native dialogs.** `prompt()` and `confirm()` are banned (a test asserts
  it). Creation uses `.form-sheet`, destructive actions use `confirmSheet()`
  (or the promise-based `ask()` for imperative admin flows).
- **Menus.** `contextMenu(event, items)` positions inside the viewport, focuses
  its first item, closes on any outside click, and is opened by right-click
  *and* long-press on a track row.
- **Feedback.** `notify(message, 'success'|'info'|'error')` renders a polite
  live region (the toast's `data-kind` picks the icon). Shuffle, repeat,
  volume/mute, the collection sort, recent searches, the library tab, the room
  code (`sonora.room`), the device id and the client preferences all persist in
  `localStorage` under `sonora.*` (`store` in `app.js`). Likes and dislikes are
  server state, not local storage.
- **Loading.** Anything fetched shows a skeleton (`.sk-hero`, `.sk-grid`,
  `.sk-rows`) or a `.spinner` inside the pressed button — never a bare
  "Loading…" line. Empty lists render `.empty-state` with a next action.
- **Touch.** Interactive controls are ≥44×44 CSS px on touch layouts; the
  mobile player keeps the title to one line so the transport never collides.
- **Player composition.** The bar is cover + title + transport at every width.
  The taste pair (like / less-like) sits next to the title only where the
  column is wide enough (≥1081px) and on phones (like only, the dislike lives
  in the sheet and the row menu); 651–1080 keeps the title readable instead.
  The now-playing sheet is the full control surface on a phone.
- **Keyboard.** Space play/pause, ←/→ seek 5s, Alt+←/→ previous/next, `/` or
  ⌘/Ctrl-K search, `m` mute, `q` queue, Esc closes the topmost layer. Track rows
  are focusable `div[role="row"]` and the player title is a
  `strong[role="button"]`; both answer Enter/Space through the global keydown
  handler, which is why they are not `<button>` elements (the row already
  contains buttons for like, album and the menu).
- **Install.** Offered at every width: Windows and macOS install PWAs from
  Chromium too (Start-menu / Dock entry, frameless window, offline shell), so
  the offer is not gated on phone widths. Only its shape is: `.pwa-banner`
  (card) below 1081px, `.pwa-pill[data-kind="install"]` (one line, centred above
  the player, filled Install action) above it, swapped live on resize by
  `reflowInstall()`. The breakpoint is `DESKTOP_QUERY` in `pwa.js` and mirrors
  `app.css`'s sidebar one. Both snooze for 14 days on dismiss, and neither asks
  inside a standalone window.

## Sign-in and account security

The sign-in screen is the one page that renders *instead of* the app, so it is
not a `.now-modal`: `.overlay.auth` holds `.auth-shell`, a two-pane grid
(pitch / form) that collapses to one column at 900px and goes full-bleed
edge-to-edge below 520px. The left pane is `aria-hidden` decoration; the form
is the only thing in the accessibility tree.

- The passkey button, the "stay signed in for N days" copy and the
  "passkeys need a domain, not an IP" hint all come from
  `GET /api/auth/capabilities`. Never hardcode them: the RP ID depends on how
the app was reached.
- The name field is never prefilled. `autocomplete="username"` lets the
  browser remember it instead of leaking the bootstrap account.
- Reveal-passphrase flips `input.type` rather than duplicating the field, so
  password managers keep working.
- A failed sign-in shakes the form, prints the server's own message and stays
  open. A lost session (401 on a normal API call) instead pulls the screen over
  the app.
- `#/security` is a real page, not a sheet: `securityPage()` renders the session
  summary pills, a passkeys card, a saved-devices card and a danger card. Rows
  carry their actions as 44px icon buttons; destructive ones go through
  `ask()`.

See `docs/auth.md` for the credential model, rotation and revocation semantics.
See `docs/rooms.md` for the shared-playhead contract.

## Listen Together

One room is one authoritative playhead (the server owns it; see
`docs/rooms.md`). The client's job is to follow it without sounding like a
stutter, which is why the sync engine (`public/rooms.js`) is separate from the
rendering in `app.js`.

**Entry points.** The headphones button in the player extras, the row menu's
`Listen together`, `#/room/<code>`, and the server-rendered `/l/<code>` link.
With no room, the button opens `.form-sheet` `#room-create-form` (visibility +
control as real radio `<fieldset>`s). In a room, the same button opens a sheet
with the link, the roster and Leave/End. The topbar carries `#room-pill` while
a room is live.

**The room has no library of its own.** Pressing Play on a playlist, an album, a
station or a single row sends `queue-set`; adding a collection to the queue sends
`queue-add`. `roomFollow()` is called from those deliberate play paths and
nowhere else, and `state.roomApplying` marks the writes the room itself makes so
applying a remote state never echoes back as a command. That is the difference
between a feature you have to feed and a feature that follows you.

**A reload is not leaving.** The browser remembers its room in `localStorage`
(`sonora.room`); boot re-attaches it on any page (pill visible, playhead
followed), and `#/room/<code>` restores the page itself. Ended, deleted or now
private rooms clear the memory instead of nagging.

**The room page** (`.room-page`) is a column on a phone and a two-column
now-playing panel from 811px. It is a live surface, so `paintRoom()` re-renders
only when the *composition* changes — code, track, queue, roster, policy, status
— and patches the sync badge and listener count in place. Without that split, a
command from someone else would rebuild the page under the host's typing.

**"Synced" is a measurement.** The badge shows the real local-vs-room drift:
`Synced` under 150ms, `Syncing · 0.4s` under a second, `Out of sync · 2.1s` past
that, and `Paused` when the playhead is paused. A label that is always green is
worthless; this one is the actual number `rooms.js` measured.

**Drift policy.** ≤120ms nothing; 120ms–1.25s nudge `playbackRate` by up to 4%;
beyond that a hard seek. Every room seek goes through `seekTo()`, which arms the
player's one-shot `manualSeek`/`lockSeek` flags — otherwise the loop-wrap
detector reads a correction to 0:00 as the end of the track and advances the
room. Dragging the progress slider calls `rooms.hold(4000)` so the loop does not
yank the thumb back under the finger.

**A guest is a different surface, not the app.** `/l/<code>/live` renders
`listen.js` against `/api/public/rooms`, because a guest has no session and the
app's boot would 401 its way to the sign-in screen.

The page is a **listening room, not a player widget**, because a guest who can
only see one track cannot tell whether the room is worth staying in. It is
server-rendered (`roomPreview` carries `queue`, `index`, `control` and
`createdAt`), so the running order is on screen before a byte of JavaScript:

```
┌───────────────────────────────┬──────────────────────────┐
│  sleeve · LIVE · GUEST        │  Queue           [20]    │
│                               │  16 up next · 1 hr left  │
│  NOW PLAYING · Track 4 of 20  │  ▎ now   (eq bars)       │
│  title / artist / host        │  5  up next              │
│  [Live] [In sync] [3 👥]      │  6  …                    │
│  progress · 1:56 / 4:00       │  ▸ Played earlier (4)    │
│  volume · copy link           ├──────────────────────────┤
│  Up next → See the queue      │  The room: host,         │
└───────────────────────────────┴──────────────────────────┘
```

- **The set list is the second column** (`.queue-panel`): the current track
  first (with an animated `eq` mark, not a number), then the runway in the
  room's own order, then `Played earlier` collapsed behind a `<details>` —
  history is recoverable, not the point. The header states `N up next · X min
  left`, computed from durations *and the live position*, so "how long is this
  room good for" is answerable without arithmetic.
- **`Up next` on the player side** is the one-glance version for wide screens
  (hidden under 900px, where the queue is directly below); its *See the queue*
  button scrolls and focuses the panel rather than pretending to be a tab.
- **The room panel** states host, listener count, control policy (`Everyone` /
  `Host only`) and how long the room has been open — the facts that decide
  whether to sign in. The guest note lives here, not under the player.
- **On a phone the same blocks stack**, and a persistent strip
  (`#listen-mini`: title, `1:56 / 4:00`, mute) appears once the player scrolls
  away, so reading the queue never loses the track. It duplicates state, never
  authority: a guest still cannot move the playhead.
- **Copy link shares the landing page** (`/l/<code>`), never the `/live` URL the
  tab happens to be on: the landing page carries the Open Graph card and mints a
  fresh guest cookie when its listener page opens.

Three behavioural rules come out of that page and are pinned by tests:

- **One tap.** The page arrives with its guest cookie and preloads the real
  source, so the tap is an ordinary `play()` on a ready element (allowed
  everywhere) rather than a silent placeholder racing the gesture. A paused room
  plays-then-pauses, which still counts as the unlock, so the host pressing play
  later needs no second tap.
- **5% on join, with a control.** `#listen-volume` (a real range input) plus
  `#listen-mute` and a `%` readout. Starting at 5% is the difference between
  "a link someone opened" and "a room shouting in a quiet house"; the level is
  deliberately not persisted, and a paused room never starts sound on join.
- **`Ready`, not `Off by`.** Before the visitor starts playback the element is
  parked at the room's position and cannot follow, so the badge says `Ready`
  instead of reporting a drift that is not about anything yet. An ended room
  says `—`: a badge that can no longer measure must not keep claiming a number.

Repaints are split the way the room page's are: `paintQueue` re-renders rows only
when the queue's *composition* changes (`videoId`s plus index), while the header
and `N min left` are patched in place — a command from the host must not rebuild
the list under a guest who is reading it.

**Roster and guests.** Signed-in members render as `.room-person` chips with
`online` from the stream. Anonymous listeners have no membership row, so the page
shows an aggregate chip (`+3 listening as guests`) rather than inventing names.

## Search: four shelves, one request

Search answers songs, artists, albums *and* playlists, and the type tabs
(`All / Songs / Albums / Artists / Playlists`, with real counts) switch over
the answer already in memory — a tab must never cost a second request.

- `GET /api/search?q=&type=all|song|album|artist|playlist` always returns the
  same shape: `{ q, tracks, artists, albums, playlists, counts }`. Shelves that
  were not asked for come back as `[]`, so a client can rely on the keys.
  An unknown `type` is a 400. Each shelf is looked up in parallel and caught on
  its own: a rate-limited album shelf must not cost the listener their songs.
  The `search-types` entry in `API_FEATURES` is how a client tells this server
  from one whose search returns only `{ tracks, artists }`.
- Albums and playlists open through the collection route (`#/c/a<id>`). `p` is
  reserved for *local* playlists — `openCollection` parses the number after it
  (`/api/playlists/12`) — so a YouTube playlist id (`PL…`/`VLPL…`) would become
  `/api/playlists/NaN`. `GET /api/album/:id` reads either form.
- A filter with nothing behind it says which filter came up empty rather than
  showing a blank page or silently falling back to the songs. Counts come from
  the server (`counts`), not from re-counting the arrays.
- The filter bar scrolls inside itself on a narrow screen
  (`.search-filters` is `overflow-x:auto` with a fade mask); the *document*
  never scrolls sideways.

## Queue

The queue is a list the listener owns, and it is editable without changing what
is playing.

- **Reorder.** The drawer (`#queue-drawer`) and the now-playing sheet's Up next
  tab render each entry as `.queue-row` — a `.queue-mini` play button plus a
  **sibling** `.queue-grip` button. The grip is never nested inside the play
  button: a control inside a control is invalid HTML and swallows the row's own
  activation. Pointer events, not HTML5 drag-and-drop: the drawer is re-rendered
  by `updatePlayer` on every playback change (which kills a native drag
  session), native DnD does not exist on touch, and the gesture state is looked
  up by video id on every move so a re-render cannot lose it. Alt+↑/↓ on a
  focused row or grip is the keyboard equivalent, and it announces the new
  position in the toast. Plain arrows still scroll.
- **`moveQueueEntry(fromVideoId, toIndex)`** is the only reorder path.
  `toIndex` is the index in the array *after* the entry has been taken out.
  `state.index` is recomputed by locating the playing entry, so a move across
  the playhead keeps the same song playing. The result is saved (debounced).
- **In a room** the server owns the order, so the grip is rendered disabled with
  the reason in its `aria-label`/`title` instead of silently missing.
- **Add to queue** is a row-menu item (`data-action="queue-add"`) that appends;
  "Play next" still jumps the queue. A song already queued is not added twice —
  the toast says so. In a room it becomes `rooms.command('queue-add')`.

## Preferences

Client preferences live in one `localStorage` record (`sonora.prefs`) with their
defaults in code, so a missing key simply means its default and a new toggle
needs no migration. `PREF_DEFAULTS` holds the values, `PREF_META` the copy, and
the settings sheet renders whatever keys those two tables hold — one entry in
each is all a new preference costs.

- `pref(key)` / `setPref(key, value)`. Every change dispatches
  `sonora:pref-change` on `document` with `{ detail: { key, value } }`, so a
  module that needs to react (the notification permission prompt, say) does not
  have to be known to `app.js`.
- **`queueFillList`** (off by default): starting a song *from a list* with
  nothing else queued makes the queue that whole list, rotated to start at the
  chosen song. Off, or with a station playing, or in a room, or when the queue
  already holds other songs, the existing behaviour is untouched.
- **`desktopAlerts`** (off by default): `app.js` only persists it. The
  notification module asks for browser permission on the event above — never on
  page load, because a denied permission is permanent and the bell works
  without it.

## Following artists and the bell

A follow is a standing request stored on the server, so it survives a cleared
browser and applies on every device. The bell is a feed of what the sweep found;
the server is the source of truth.

- The artist page carries a real toggle button (`data-action="follow-artist"`,
  `aria-pressed`), rendered only when the artist resolves to a `UC…` channel id
  — the only handle a release check can use. It flips optimistically and
  reconciles with the server's answer; a failure puts it back and says why.
- `GET /api/follows` feeds the library's Artists tab, which lists followed
  artists first and marks them, ahead of the artists inferred from history.
- **Nothing is notified on the first check.** `diffReleases` treats an empty
  baseline as "this is what already exists": following a band with twelve
  albums must not fire twelve notifications. Later checks report only ids that
  were not known, deduped per user per release, so a sweep can run as often as
  it likes. The sweep (20 min) only ever walks artists somebody follows.
- `public/notifications.js` is a self-contained module (it imports nothing from
  `app.js`, which exports nothing) loaded beside `pwa.js`. It owns the panel,
  the badge (`.notif-badge`, dot hidden at zero, `9+` above nine), the poll, and
  the OS notification. It talks to `app.js` only through the bell's existing
  `data-action="notifications"` (which delegates to
  `window.__sonoraNotifications.open(el)`), `sonora:pref-change`, and the
  server-supplied `url` on each row — a route is never built on the client.
- Desktop/PWA alerts go through the service worker
  (`registration.showNotification`) so they survive a backgrounded tab, with
  `new Notification(...)` as the fallback. `sw.js`'s `notificationclick` posts
  the route to an open app window and focuses it (a bare `#/…` would open a
  blank page), or opens the resolved URL. The highest seen row id is stored per
  account under `sonora.notifSeen:<accountId>` — there is deliberately no shared
  fallback key, because a `/api/me` timeout once let one account's watermark
  suppress another's alerts; with no known account nothing is announced or
  written. The first run for an account only records a baseline.

## Tests that pin this document

- `test/safe-area.test.js` — real-browser geometry with emulated iPhone insets.
- `test/ios-chin.test.js` — the installed-iOS viewport shortfall: the shell
  fills the screen, and the override stays off in Safari, with the keyboard
  open, and in a resized window.
- `test/ux.test.js` — overflow, touch targets, focus trap/restore, ARIA,
  reduced motion, skeletons, route/back navigation and scroll restore (J, Q, R),
  no native dialogs, artist pages and album opening (H2a–H2c).
- `test/flows.test.js` — create playlist, add/remove, optimistic likes, sort
  persistence, mobile hero layout, offline boot, share links.
- `test/pwa.test.js` — manifest/icons, service worker strategies, offline
  navigation, install/update chrome (phone card, desktop notice, iOS sheet).
- `test/lockscreen.test.js` — Media Session behaviour that must not regress:
  artwork, the seek bar, the loop wrap, and a locked phone keeping previous/next
  instead of ±seek (`test/media-session.test.js` covers the same keep-alive in
  isolation, and its node half runs without a browser).
- `test/auth.test.js` — login, remember-me, refresh rotation and replay,
  per-device revocation, passkey challenge single-use.
- `test/passkey.test.js` — a real passkey round trip in Chromium's virtual
  authenticator, driven through the actual UI.
- `test/rooms.test.js` — the room protocol over HTTP: derived playhead, revision
  conflicts, private rooms and invites, host-only control, the SSE stream, the
  clock probe, and the guest boundary (a guest streams its room's queue and
  nothing else).
- `test/rooms-browser.test.js` — real Chromium profiles: two people hear the
  same second across pause, seek and a track change; the room follows a playlist
  pressed into the ordinary player; it survives a server restart and returns on
  reload; a stranger meets a wall; and a guest, under a Safari-strict autoplay
  policy, needs one tap, starts at 5% and can move the volume.
- `test/listen-page.test.js` — the guest page as a *room*: the set list, the
  played history, the up-next card, the room facts, a host command repainting
  the queue in place (no reload), the phone's stacked layout and scroll-away
  strip, and the ended room staying readable.
- `test/listen-venue.test.js` — the opt-in venue view: lazy (costs nothing until
  asked), a view rather than a second player, the real people and queue, no
  chat, remembered across visits, and a blocked-autoplay guest still able to
  start the room from it.
- `test/rooms-idle.test.js` — housekeeping never prunes a room someone is
  listening to.
- `test/queue.test.js` — the drawer lists the queue with a grip, a real pointer
  drag reorders and persists while the same song keeps playing, Alt+↑/↓
  reorders and announces, the row menu appends without duplicating, the
  `queueFillList` toggle is a real checkbox that changes what playing a song
  from a playlist queues, and a room's queue cannot be dragged.
- `test/search-ui.test.js` — one search fills four shelves with counts, the type
  tabs switch without a second request, an empty shelf names itself, an album
  and a playlist result both open their tracks, follow/unfollow round-trips
  (and reverts on failure), and the filter bar never scrolls the document.
- `test/notifications.test.js` — the badge and its `aria-label`, the panel and
  its keyboard contract, a row marking itself read and following the server's
  route, `Mark all read`, the empty state, and that an OS alert fires exactly
  once for a new row and only when `desktopAlerts` is on and permission was
  granted on the settings gesture.
- `test/search-types.test.js` — the search API contract: four shelves and
  counts, `?type=`, 400 on an unknown type, real album/playlist ids, and that a
  repeated search is a cache hit.
- `test/follows.test.js` — release diffing with an injected page (first check
  baselines, a new album notifies once, two followers each get one row, one
  dead artist does not stop the sweep), plus the follow/notification routes
  over HTTP including the per-user throttle.

Run everything with `npm test` (Chromium is required for the browser suites;
set `CHROME_BIN` if it is not on `PATH`). Each suite launches its own headless
Chromium and its own server, so `npm test` runs the files with
`--test-concurrency=8`; CI instead runs two gated selections — the offline `unit`
job and the `browser` job — each with `--test-concurrency=1` (the runner has two
cores, so parallel real-browser geometry assertions fight over CPU and `/tmp`
profiles); the live-YouTube suites run in neither job. `npm run test:serial` is
the local equivalent of the CI shape when a geometry test flakes.
