# Sonora · Sleeve-first v2 (unification pass)

Direction 01 was implemented on the home hero only. This pass makes the whole app
read as one system. It is a **contract**: the class names below are shared by
`public/app.css` (visual) and `public/app.js` (markup) and must match exactly.

## Evidence from the current build (1440×1000 and 390×844)

1. **The home hero goes stale.** The phone player showed a playing track while the
   hero still rendered the "Find your afterglow" fallback. On desktop the same
   page rendered the sleeve. `state.home.featured` is only written on session
   save/adopt, and the page is not repainted when the current track changes.
2. **A one-item shelf stretches.** Desktop "Back in rotation" renders one artwork
   tile across the full ~1000px column instead of a fixed-size sleeve.
3. **The desk hero is two glued rectangles.** Art occupies the right 54% with a
   hard vertical seam and no scrim blending into the copy side.
4. **Three artwork languages.** Home shelf (square, 8px), library cards (square,
   12px, brown-grey), artist avatar (circle), collection art (16px), sheet cover
   (22px). "No artwork" has three different tints.
5. **Page leads disagree.** Home: title + date. Library: title + New playlist.
   Station: title + Rebuild, with the same "MADE FOR YOUR EARS" overline as home.
   Search: title + nothing. Artist and collection: no page lead at all.
6. **Section headings disagree.** Home shelf 17px, station "Up next" 17px,
   artist "Popular songs" 20px, search "Artists 1" 17px with a count.
7. **Two filter idioms.** Library uses a segmented control; search renders the
   same `.segment` buttons loose, as disconnected pills.
8. **The install card is the loudest object on every phone page**, and it floats
   over content (it covers station rows and sits mid-page on library/search).
   It uses a different shape language from everything else.
9. **The queue drawer has three stacked caps labels** ("PLAYING QUEUE", "1 track",
   "NOW PLAYING") and a coral focus ring after a pointer click.

## Type and geometry rules

- No new numeric radii. Alias the existing scale:
  `--r-cover: var(--r-xs)` (8), `--r-cover-lg: var(--r-md)` (16), `--r-sheet: var(--r-lg)` (22).
- Page title: existing clamp. Section heading: **18px desktop / 17px phone**, weight 800, tracking -0.02em.
- Section sub: 11.5px, `--soft`, max 62ch. Caps labels: only where they name a
  real category (a section type, a state). Never two caps labels in one header.
- Gutter stays `--gutter`. Screen gutters are already consistent; do not change them.

## Shared vocabulary (must match in both files)

### Page lead — every routed page
```html
<div class="page-head">
  <div><span class="page-overline">…</span><h1 class="page-title">…<span class="accent">.</span></h1></div>
  <div class="page-head-actions">…buttons…</div>
</div>
```
- `.page-head-actions` holds 0–2 controls, right-aligned, baseline-aligned with the title.
- Home action: **Play station** (`data-action="play-station"`).
- Library: **New playlist**. Station: **Rebuild**. Radio: **Play radio**.
- Search / security / admin keep their existing controls, moved into this slot.
- Collection and artist get a page lead **in addition to** their existing
  `.collection-hero` / `.artist-hero` (tests pin those selectors).

### Shelf — every section heading
```html
<div class="shelf-head">
  <div class="shelf-head-copy"><h2>Title</h2><p>optional one line</p></div>
  <button class="shelf-link" …>Link</button>
</div>
<div class="shelf">…tiles…</div>
```
- Replaces `.section-head` and `.sleeve-shelf-head` usage on routed pages.
  Keep both old classes working (other code/tests use `.section-head`).
- `.shelf` for tiles is `grid-template-columns: repeat(auto-fill, minmax(104px, 1fr))`
  with `max-width` per tile so a single item can never stretch.

### Sleeve tile — any artwork entity
```html
<button class="sleeve-tile" …>
  <span class="sleeve-tile-art">…cover…<span class="sleeve-tile-play">▶</span></span>
  <span class="sleeve-tile-title">…</span>
  <span class="sleeve-tile-sub">…</span>
</button>
```
- Square art, `--r-cover`, hairline ring, hover lift, play affordance on hover/focus.
- Used by: home shelf, library cards, search album/playlist cards, artist releases.
- Existing `.music-card` may keep its class **and** gain `.sleeve-tile` (additive),
  or `.music-card` is restyled to the same geometry. Do not break
  `test/ux.test.js` and `test/flows.test.js` selectors (`.music-card`, `.music-card-title`).

### Hero
- `.sleeve-hero` art is full-bleed: `.sleeve-hero-art` inset 0; scrim is a
  directional gradient (left copy side opaque → transparent) plus a bottom fade.
  No hard vertical seam at any width.
- `.hero-art` remains the artwork layer (tests reference it).

### Filter row
- Search filters are wrapped in `<div class="segmented" role="tablist">` exactly
  like the library tabs, so both use one control. Keep `data-filter` /
  `data-library-tab` attributes and `role="tab"` / `aria-selected`.

### Install chrome (phones)
- One compact row, max height 56px, single primary action plus dismiss.
- Must not cover page content: reserve its space above the player, or reduce it
  to a slim bar. Keep `.pwa-banner` / `.pwa-pill` class names (tests pin them).

## Ownership

| File | Owner | May change |
|---|---|---|
| `public/app.css` | agent A | CSS only |
| `public/app.js` | agent B | markup, copy, the stale-hero fix |
| `public/pwa.css`, `public/notifications.css`, `public/rooms.css` | agent C | CSS only |

Nobody edits `docs/`, `test/`, or another owner's files. Do not run the full
`npm test`; run the focused suites named in each brief.

## Acceptance

- Home hero reflects the **current track immediately** after tapping a shelf
  item, with a real title, channel and playhead.
- One artwork tile never stretches; three tiles on a 390px phone.
- Station, library, artist, collection and search share the same page-lead
  rhythm, section heading scale and tile geometry.
- No horizontal overflow at 320 / 360 / 390px; touch targets stay ≥44px.
- The install chrome never covers a row, a control or the player.
- `node --test test/flows.test.js test/ux.test.js` and the layout/safe-area/pwa/
  rooms suites stay green.
## Closure notes (what the review changed)

A visual review of the finished build found two contract-level regressions and
a set of smaller divergences. All are fixed in the tree; the rules that matter
are recorded here so a later pass does not undo them.

1. **A page states its identity once.** `collectionShell()` and `artistView()`
   each rendered a `.page-head` *and* a hero carrying the same `<h1>` and the
   same overline, so every collection and artist route shipped two headings.
   Those two routes now lead with the hero alone; `.page-title` belongs to
   pages that have no hero. Tests wait on `.collection-hero h1` /
   `.artist-hero h1`, never `.page-title`, on these routes.
2. **The install band reserves space from the viewport, not the content.**
   `padding-bottom` on the scroll content only helps a page that already
   overflows, so on short pages (two station rows, the first radio card row)
   the band still sliced the last live line. `.main` now loses the band's
   height as `margin-bottom` on screens ≥700px tall, which puts the band in
   space no content can occupy. Below 700px the old scroll-clearance behaviour
   stays: there, shrinking the scroller robs the hero of height and pushes its
   footer under the player (`flows.test.js` pins this at 320×568).
   The desktop offer is a `.pwa-pill`, not a `.pwa-banner`, and needs the same
   treatment — it used to float over the top card of the radio grid.
3. **The page action is labelled where it fits.** The home head's bare coral
   circle was the app's only unlabelled control. It is a "Play station" pill
   from 651px up; below that the label is hidden and the same slot is a 44px
   circle, because a 130px pill beside "Good afternoon." wraps to a second row
   at 320px and pushes the hero under the player.
4. **`.segmented` has one width policy**: `width:fit-content; align-self:flex-start`.
   It used to hug its content on library, stretch an 835px desktop column on
   search, and clip the fifth tab mid-word on a phone.
5. **Radio stations are sleeves.** They were the last second card system — a
   bordered container with padding and a 3:2 crop. Now borderless, 1:1, same
   `--r-cover` radius, with the play disc revealed on hover where hover exists.
6. **One "now playing" idiom.** The queue drawer marked its current row with a
   brown wash and 16px art radius; it now uses the table's coral edge, coral
   duration and the 8px sleeve, and its close button is the same 44px circle as
   the now-playing sheet's — without the ring that programmatic focus painted.
7. **No repeated copy.** The rail's "KEEP THE FEELING" promo card is gone from
   the populated rail (it repeated on every page); an empty "Up next" gets a
   quiet line instead. "See history" no longer appears twice on home.
8. **No phantom columns.** The track table's Album header only renders when at
   least one row has an album to show.

Known and accepted at the end of this pass: the search page still shows the
topbar field and its own field; library cards are 168px against 120px shelf
tiles (a browse grid against a compact shelf); short pages keep visible dead
space. None of these read as two different systems.

## Desktop player bar: one control row

The bar's right cluster is packed to the right edge of a symmetric `1fr` track,
so when it grew wider than that track (six controls, ~348px against 283px) the
overflow went **left** and the "Listen together" button landed on top of the
repeat button — two glyphs stacked diagonally at the transport/extras seam.

Rules that keep it from happening again:

- The extras never exceed half the content column. The redundant "expand player"
  button is gone (the cover, the title and the rail arrow all open the same
  sheet), gaps are 6px, and the volume slider is the only flexible item
  (`flex:0 1 88px;min-width:56px`) so it yields before anything overlaps.
- Below 1311px the bar drops to what a bar is for: cover, title, transport,
  queue, volume. Room and lyrics come back at 1311px; the taste buttons at
  1181px. Everything dropped is still reachable in the rail (from 1081px), in
  every track row and in the now-playing sheet.
- The whole control row shares the bar's centre line: `.player-controls` carries
  `padding-top:20px` and a 20px timebar, so the transport, the taste buttons and
  the utilities sit at one height with the progress tucked beneath them. Without
  it the two-row column centred as a block and the transport sat 13px above the
  heart — three baselines in one 87px bar.

Verified with a bounding-box probe at 1601 / 1440 / 1311 / 1280 / 1180 / 1081 /
1000 / 900 / 811 / 760 / 700 / 651px: zero overlapping controls, and the
transport's centre equals the content column's centre at every width.

## Player bar: group separators

The row carries four kinds of control — what is playing, taste, transport,
utilities, volume — and 24px of air was not enough to tell them apart at this
density; it read as one strip of glyphs. Each gap now holds a 22px hairline
(`--line-2`, 1px, centred, positioned `left:-13px` = exactly half the grid gap),
and the volume control gets the same mark inside the utilities cluster.

- Two of the marks sit in the grid gaps; the third is inside `.player-extras`,
  where `.volume-group` gained 11px of `padding-left`. That is paid for by the
  slider, which is the only flexible item in the cluster (`flex:0 1 88px`), so
  the separators never reintroduce the overflow they were added alongside.
- Because the track is only half the content column, `Listen together` returns
  at 1440px and `Lyrics` at 1311px; below that the mark and the icons go
  together, so a group never appears with a divider but no content.
