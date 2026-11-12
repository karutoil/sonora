# Listen Together — shared listening rooms

A room is one authoritative playhead that several people follow. The host
starts a room from whatever is playing (or from nothing), gets a link, and
everyone who joins hears the same track at the same position, within a few
hundred milliseconds.

This document is the contract: the database, the wire format, the sync
algorithm and the deliberate limits. `docs/ui.md` records how the client
surfaces it.

---

## The two kinds of link

| visibility | who can join | what the link preview shows |
| --- | --- | --- |
| `public` | anyone with the link — **no account needed to listen** | the track, host and listener count on the share card; the listener page adds the full running order and the queue |
| `private` | the host and accounts the host invited | "a private listening room" and nothing else — not the track, not the queue, not the host's name |

A public room is the one place in sonora where audio does not require an
account. `/api/stream/:videoId` is a same-origin audio endpoint behind a session,
so opening it to "anyone with a link" would turn every room into a public audio
proxy for the whole internet. Instead a public listener gets a **guest cookie**:
signed with a `guest:`-prefixed HMAC (domain-separated from the session token so
neither can stand in for the other), room-scoped, 6 hours. It authorizes exactly
this room's state and the tracks in *this room's queue* — not an arbitrary video
id, not another room, and not the member API. That boundary is the whole security
model and it is pinned by tests.

One browser-wide cookie (`sonora_guest`) holds a JSON map of room code → signed
token, so opening a second room's link in another tab does not evict the first.
The map is bounded at 6 rooms and each entry expires on its own; `/api/stream`
accepts a video id that any of this browser's rooms is currently playing.

The cookie is minted with the listener page itself (`GET /l/:code/live`), not
behind a click. That is what lets the page preload the room's real audio source
while the visitor reads the track name, so the one tap they make is a plain
`play()` on a ready element — no second press, and no silent placeholder racing
a gesture.

A guest is a **listener**: they follow the playhead and cannot move it. A queue
belongs to the room; the transport belongs to the people in it. "Anyone can
listen" must not become "anyone can skip the host's song".

A guest can still *see* the queue, and does not have to wait for JavaScript to
read it: `roomPreview` carries the public room's `queue`, `index`, `positionMs`,
`playing`, `control` and `createdAt`, so `/l/<code>/live` is server-rendered with
the whole running order. That is not a widening of the boundary — every guest may
fetch the same snapshot from `/api/public/rooms/:code` — it is the same data
arriving one round trip earlier, which is what makes the page a room rather than a
player. A private room's preview still carries no track and no queue. One shape
difference to know: a preview's `host` is a name string, while a snapshot's is
`{ id, name }` (`hostNameOf()` in `src/server.js` accepts both).

The shareable link is a real path — `/l/<code>` — for the same reason track
links are `/t/<id>`: a fragment never reaches the server, so a chat crawler
would only ever see the generic app shell. `/l/<code>` is a server-rendered
landing page with Open Graph tags. For a public room it leads to
`/l/<code>/live`, a listener page that needs no account at all; for a private
one it offers the app, where the normal login and invite apply.

A room code is 10 characters from `23456789abcdefghjkmnpqrstuvwxyz` (no
`i l o 0 1` to survive being read aloud), and a code that reaches a route must
match `^[2-9a-hj-km-np-z]{8,12}$` before any query runs. It is unguessable at
that length; the global per-IP API limit (600 requests a minute) covers join
attempts, and the guest mint has its own 60 a minute.

---

## Authority, not consensus

The server owns the playhead. Clients never publish their position; they send
**intent** (play, pause, seek here, next) and receive state. That is what makes
"C" in a room and "C" on another phone mean the same thing.

### The room follows what you play

There is no separate room library to feed. Two commands carry play intent, and
the ordinary player sends them:

- **`queue-set`** — "this is what I am playing now" — replaces the room's queue
  and playhead. Pressing Play on a playlist, an album, a station, or clicking a
  track row in *Up next* does this. It is the whole of "listen together": the
  room hears what you chose, from the top, together.
- **`queue-add`** — "add this to what we are playing" — appends one track. This
  is the collaborative half, and the only transport command a member keeps under
  host-only control.

Only a *deliberate* play intent calls `roomFollow()`. Rendering, resuming a
personal session, and applying the room's own state never do — and `roomApplying`
marks the writes the room made, so a state change cannot echo back as a command
and make two devices ping-pong the playhead forever.

```
room state = { queue, index, positionMs, anchorAt, playing }
position(t) = positionMs + (playing ? t - anchorAt : 0)
```

`anchorAt` is a server timestamp, so a slow client receives an event that is
already a little old and computes a correspondingly later position. No lead
compensation is needed.

**Track end is derived, never stored.** If a known duration exists and
`position(now) >= duration`, the snapshot reports `ended: true` and
`playing: false` at `duration`. A track whose duration the catalogue never gave
still ends, at a ceiling no song reaches: 15 minutes
(`UNKNOWN_DURATION_CEILING_MS`, mirrored in `public/rooms.js`, where the client's
auto-next suppression uses the same instant). Without it a track with no
measurable length could never be left at all. Any member may then send
`next {auto:true}` (natural continuation); the server only accepts `auto` when the
state really is ended, so it cannot be used to skip — with one small tolerance
(500 ms) because a correct client that is a few milliseconds ahead of the server
reaches the end of *its* file first, and refusing that one advance would wedge a
room at every track boundary. A user-initiated skip obeys the room's control
policy.

The end is also *broadcast*: when the derived playhead crosses `duration` with
nobody commanding, the room pushes a `state` frame with `ended: true` and
`playing: false`. Clients clamp their own position to the duration, so a room
nobody advances pauses at its end instead of looping.

### Commands and revision

The whole vocabulary is nine `type`s — `play`, `pause`, `seek`, `select`,
`queue-set`, `queue-add`, `queue-remove`, `next`, `prev` — and anything else is
`400 BAD_INPUT`. Every command carries the `rev` the client last saw; the server
enforces it exactly where the intent depends on it.

- **Absolute** commands (`play`, `pause`, `seek`, `select`, `queue-add`,
  `queue-remove`) are applied against current state. The intent does not depend
  on the old revision, and rebasing is exactly what the user asked for — except
  for a removal by index, which is only honoured against the revision it was
  formed on (`409 STALE` otherwise) because "index 2" means a different song
  once the queue has shifted. Naming the track (`queue-remove {videoId}`) is the
  primary form and is idempotent. Either form refuses to remove the track that is
  playing (`400 CURRENT`): skip it instead.
- **Relative** commands (`next`, `prev`) require an integer `rev`, and it must
  match; a missing or malformed revision is `400 { code: 'BAD_INPUT' }`, never
  "assume current". Two people pressing next at once must advance once, not
  twice; the loser gets `409 { code: 'STALE', error: 'The room already moved on.',
  state }` and simply follows the winner.
- **Auto-advance** (`next {auto:true}`) is accepted when the state is ended
  (within the 500 ms tolerance above), or from the host when it is not (the
  host's player knows its own end even when the catalogue had no duration for
  the track). The ended-track case is checked *before* the control policy, so a
  `host`-controlled room still carries itself forward when the host's phone is
  asleep.

### Control policy

| `control` | members may |
| --- | --- |
| `everyone` (default) | play, pause, seek, next, prev, pick a track, change what is playing (queue-set), add to the queue |
| `host` | only add to the queue; transport is the host's (an ended track may still be continued by any member — see auto-advance above) |

Adding to the queue stays collaborative under `host` control because a queue is
a suggestion, not an interruption. The host can flip the policy at any time;
the change is broadcast.

---

## Clock and drift

A room is only as synced as the clocks behind it. On join (and every 60 s, and
when the tab becomes visible) the client runs three `GET /time` probes and keeps
the sample with the smallest round trip:

```
offset = server.now - (t0 + rtt / 2)
```

The kept sample is smoothed against the previous estimate (75 % new, 25 % old) so
one lucky probe cannot swing the offset. Ticks and state events are not used for
the offset: a one-way delay would bias it forward by the whole delay. They are
used for presence and liveness only.

Once the clock agrees, the correction loop runs once a second. It is also
invoked immediately whenever a fresh state (stream event, poll or command
response) lands, so a deliberate play/pause/seek is applied in the same frame
rather than up to a second later:

| local drift | action |
| --- | --- |
| ≤ 120 ms | nothing (playbackRate back to 1) |
| 120 ms – 1.25 s | nudge `playbackRate` by up to ±4 % (`1 − clamp(drift/8)`) |
| > 1.25 s | hard seek |

A paused room is corrected too, as soon as its position is more than 250 ms out —
a pause is also a position, and a guest that kept the frame it was on when the host
stopped would stay a second or two off until the next play.

A track change is applied by loading the track and seeking to the derived
position (`pendingResumeMs` in `app.js`); the loop waits ~1.2 s for that seek to
land so it does not fight it. Nudging rather than seeking is what keeps a room
from sounding like a stutter; the hard seek is the honest fallback when someone
was asleep, backgrounded, or joined a track late.

Every room seek goes through `seekTo()`, which arms the app's one-shot
`manualSeek`/`lockSeek` flags. Without that the player's loop-wrap detector
would read a correction to 0:00 as the end of the track and advance the room.

---

## Presence and lifetime

Presence is the open SSE connection, not a heartbeat table. A subscriber set
lives in memory; `room_members` is the durable membership and authorization
record, and `last_seen_at` moves when someone connects. Members who disconnect
stay members (they can rejoin without an invite), and show as offline. Guests
have no row at all — for them the connection *is* the presence, which is why an
idle room with a guest in it is not idle.

### Surviving a restart

Nothing about a live room is in memory. The queue, index, playhead and revision
are one JSON blob in `rooms.state`; the roster and invites are rows. A restart
therefore costs exactly the open streams, which reconnect by themselves:

- the client's `EventSource` retries the same URL; the stream's first message is
always a full `snapshot`, so a reconnect is one message, not a replay protocol;
- the guest page reloads its state when the tab becomes visible;
- `positionMs` is stored with `anchorAt`, so a restart in the middle of a track
  resumes from the stored anchor instead of rewinding.

Housekeeping is the one thing that changes after a restart: rooms idle beyond
`SONORA_ROOM_HOURS` are pruned at boot (and hourly thereafter), so a restart is
also the moment a forgotten room is finally collected.

### Coming back to a room

A browser remembers the room it was in (`localStorage` key `sonora.room`, "where
was I" — not account state, so it is not on the server). On boot, any page
restores that room: the pill appears and the shared playhead is followed again.
Opening `#/room/<code>` explicitly does the same. Only a room that has ended, been
deleted, or become private for that account clears the memory — a reload is not a
decision to leave. Explicitly leaving the room does clear it, and so does the
memory being more than 24 hours old: a code that old cannot still name a live room.

A room is deleted when it has been idle (no command, no join, no reconnect, no
`GET /state` poll) for `SONORA_ROOM_HOURS` (12) **and** has no live subscriber, or
one hour after the host ends it. Housekeeping runs at boot and hourly. Hosting does
not need the host to be online: the transport keeps working for everyone, and
host-only actions wait for the host's return (a host who is never coming back can
hand the room over — see `PATCH /host` below).

---

## API

All paths are under `/api/rooms`, authenticated, and JSON except the stream. An
unknown or malformed code is `404 { code: 'NO_ROOM' }`; an ended room answers
`410 { code: 'ENDED' }` on every route that takes a `:code`, until it is collected
(the `GET /api/rooms` list still shows it in the meantime).
`snapshot` below means the object in the next section.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/rooms` | create `{visibility, control, queue, index?, positionMs?, playing?}` → snapshot. The queue is required and non-empty (`400 NO_TRACK`); there is no single-`track` form |
| GET | `/api/rooms` | rooms I host or joined → `{ rooms }` |
| GET | `/api/rooms/:code` | snapshot; private non-invited → `403 { code:'PRIVATE' }` |
| POST | `/api/rooms/:code/join` | join (public or invited) → snapshot; a full room is `409 { code: 'FULL' }` |
| POST | `/api/rooms/:code/leave` | leave → `{ ok, code, host }`; a host keeps their seat (leaving is not ending) |
| DELETE | `/api/rooms/:code` | end the room (host) → `{ ok }` |
| PATCH | `/api/rooms/:code` | `{visibility?, control?}` (host) → snapshot |
| PATCH | `/api/rooms/:code/host` | `{ userId }` (host) → hand the room over → snapshot; the seat needs a member to move to (`400 NOT_MEMBER`) |
| GET | `/api/rooms/:code/state` | snapshot (the polling fallback, and its heartbeat: a poll counts as presence) |
| GET | `/api/rooms/:code/time` | `{ now }` — clock probe |
| GET | `/api/rooms/:code/events` | SSE: `snapshot`, `state`, `members`, `room`, `tick`. A non-member gets `403 NOT_MEMBER` |
| POST | `/api/rooms/:code/command` | `{ type, rev, ... }` → snapshot, or `409 STALE` |
| GET | `/api/rooms/:code/people?q=` | invite candidates, annotated `invited`/`member` (host) → `{ people }` |
| POST | `/api/rooms/:code/invite` | `{ name }` or `{ userId }` (host) → `{ invites }` |
| DELETE | `/api/rooms/:code/invite/:userId` | remove an invite (host) → `{ invites }` |

### Public listener API (no account)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/public/rooms/:code/guest` | mint the guest cookie → guest snapshot; `403 PRIVATE` |
| GET | `/api/public/rooms/:code` | guest snapshot |
| GET | `/api/public/rooms/:code/state` | guest snapshot (polling) |
| GET | `/api/public/rooms/:code/time` | `{ now }` |
| GET | `/api/public/rooms/:code/events` | SSE, sanitised: no roster, no roles |

A guest snapshot is the same object with `guest: true`, `joined: true`,
`members: []` (names are not a public-room resource), no `updatedBy`, and a
`listeners` count. Every route in that table except the mint answers
`403 { code: 'NO_GUEST' }` without a valid cookie for that room; the mint answers
`403 { code: 'PRIVATE' }` for a private room and is itself limited to 60 a minute.
The token is not a session: it is signed with a different HMAC domain prefix, it
carries no user id, and it grants nothing beyond this room's snapshot, stream and
queued audio.

### Snapshot

```json
{
  "code": "k7m2p9xq4r",
  "host": { "id": 1, "name": "admin" },
  "visibility": "public",
  "control": "everyone",
  "joined": true,
  "rev": 7,
  "now": 1730000000000,
  "at": 1730000000000,
  "positionMs": 42310,
  "playing": true,
  "ended": false,
  "index": 2,
  "queue": [{ "videoId": "…", "title": "…", "channel": "…", "thumb": "…", "durationS": 214 }],
  "track": { "videoId": "…", "title": "…", "channel": "…", "thumb": "…", "durationS": 214 },
  "updatedAt": 1730000000000,
  "updatedBy": { "id": 1, "name": "admin" },
  "createdAt": 1730000000000,
  "link": "/l/k7m2p9xq4r",
  "guests": 3,
  "listeners": 5,
  "members": [{ "id": 1, "name": "admin", "role": "host", "joinedAt": "…", "online": true }]
}
```

`guests` counts anonymous listeners connected right now (a fact about the hub,
not a query), `listeners` is everyone with an open stream — distinct signed-in
members plus guests — which is what the room pages display. `members` is absent
from the engine's own snapshot and added by the routes (create, `GET`, `join`,
`PATCH`, `command`, `PATCH /host`) and by the stream's opening frame; `updatedBy`
is omitted entirely from a guest's snapshot.

`at` is the server instant at which `positionMs` was true. A client that has
calibrated its offset computes `positionMs + (serverNow − at)` while playing.

### SSE

`GET /events` sends one `snapshot` immediately (the same object as `/state`,
including `members`), then:

- `state` — a new snapshot on every command, and one when the derived playhead
  reaches the end of the track (`ended: true`, `playing: false`). The frame is
  built per viewer, so each subscriber gets the shape it would have fetched
  itself (`joined` for its own account, no roster for a guest)
- `members` — the roster after a join/leave/connect/disconnect, as
  `{ members, guests, listeners }`; guests receive the same event with
  `members: []` and the counts
- `room` — after a visibility/control change, after a hand-over
  (`{ hostId, control, code }`), when the host ends the room (followed by closing
  the stream), to a guest being removed because the room became private
  (`{ removed: true, reason }`), or with `{ error }` when the room is at its
  200-stream ceiling (the stream is closed and the client falls back to polling
  rather than reopening a full door)
- `tick` — `{"now":…}` every 15 s, plus a `: ping` comment line on every tick
  (that is what lets a client tell a quiet room from a dead socket)

The stream sets `cache-control: no-cache, no-transform` and
`x-accel-buffering: no`, and the handler hijacks the reply so Fastify never
tries to frame it. If the stream cannot be established the client falls back to
polling `/state` every 3 s, backing off to 10 s and then 30 s while polls are
failing rather than spending a request a second on a link that is already
struggling.

---

## Deliberate limits

- **50 members** per room (`SONORA_ROOM_MAX_MEMBERS`). Beyond that a room is a
  broadcast, and the queue/people list stops being useful. The cap is checked when
  someone *joins* (`409 FULL`), so a member reconnecting is never turned away.
  Guests are counted against the stream ceiling, not against membership.
- **200 concurrent streams** per room (`MAX_STREAMS_PER_ROOM` in `src/rooms.js`),
  members and guests together. The refused connection gets a `room` frame with an
  error and the stream closes.
- **60 queue entries** — the same window `/api/now` stores. Adding past it
  replaces nothing; the server refuses (`409 QUEUE_FULL`) and the client shows the
  server's message. Duplicates are refused too (`409 IN_QUEUE`), and creating or
  replacing a queue de-duplicates by `videoId` instead of failing.
- **One queue, no per-listener shuffle.** Shuffle is a personal opinion; a
  shared playhead has to be the same order for everyone.
- **No chat.** This is a listening feature; the link lives in whatever chat
  the group already uses. The venue view's speech bubbles are *status* for the
  same reason: they only ever repeat a fact the room already has (who hosts, how
  many are listening, what is next) and never put words in a person's mouth.
- **No live streams** — they have no end and no finite duration to sync to.
- **Guests are listeners, not members.** No name, no roster entry, no commands.
  The count is honest; the identity is the connection.
- **Six guest rooms per browser** (`GUEST_ROOMS_MAX`). The guest cookie is one
  bounded map, so a browser that keeps opening links cannot grow it without limit;
  the oldest entries are dropped past six.
- **A room that goes private revokes its guests.** There is no account to
  remove, so their streams are closed with a reason instead of being left open.

## Configuration

```sh
SONORA_ROOM_HOURS=12          # idle lifetime, with nobody connected
SONORA_ROOM_MAX_MEMBERS=50    # hard cap on a room's roster
```

`SONORA_ROOM_HOURS=0` is not "keep rooms forever": the idle cutoff becomes *now*,
so every room with no live listener is collected on the next sweep. The hourly
sweep is what actually deletes, whichever value is set.

The guest cookie lives for 6 hours (`GUEST_TTL_MS` in `src/server.js`): long
enough for an evening, short enough that a shared link does not become standing
audio access.

## Tests

- `test/rooms.test.js` — HTTP: create/join, the private gate, invites, control
  policy, revision conflicts, end-of-track, the SSE stream, the clock endpoint,
  and the guest boundary (queued tracks only, no commands, no roster, no
  cross-site cookie reuse).
- `test/rooms-browser.test.js` — real Chromium sessions (skipped when Chromium is
  not installed): two people hear the same second across pause, seek and a track
  change; a stranger meets the private wall; a guest needs exactly one click,
  starts at 5% and can move the volume.
- `test/rooms-idle.test.js` — pruning: a room with a live listener is never pruned,
  a guest counts as presence, an ended room is collected early, and long/corrupt
  end waits stay finite.
- `test/listen-page.test.js` — the listener page's running order: server-rendered
  queue/played/room facts, a host command repainting it in place, the phone
  layout, and an ended room staying readable.
- `test/listen-venue.test.js` — the opt-in venue view: a view of the same room
  (same track, same queue, same count), never a second player, and no chat.

Last verified against the working tree at `2339565` on 2026-11-12.
