# sonora — production UX polish spec

Status: **implemented** — this was the polish-pass contract; `docs/ui.md` records what shipped.
Every agent working on this repo reads `docs/ui.md` first.
Repo: `~/projects/muse-pwa`. Login for browser tests: whatever bootstrap account your
local `.env` creates (`SONORA_USER` / `SONORA_PASSPHRASE` — the dev instance's values are
local and intentionally not recorded here). **Do not restart the dev server, do not
modify `data/`, do not sign the existing session out.**

The app is a personal YouTube music PWA. It works; the problem is the finish. We are turning a
good-looking mock into a shipped-feeling product: consistent tokens, real hierarchy, complete
mobile behaviour (320 → 430, landscape, tablet), tasteful motion, accessible controls, no native
`prompt()`/`confirm()`, no dead-end loading, and an installable/offline PWA shell.

---

## 1. Hard contracts (tests pin these — do not break)

`test/library.test.js` asserts `public/app.css` contains, literally:

```
--accent:#ff997b
grid-template-columns:235px
max-width:650px
```

`test/safe-area.test.js` reads `public/app.css` and requires **exact** selector/value text
(whitespace inside `calc()` matters):

```css
.app{ ... padding:var(--sat) ... }                    /* last .app{ rule in the file wins */
.app{ ... grid-template-rows:minmax(0,1fr) calc(87px + var(--sab)); }
.app{ ... height:var(--app-h,100dvh) ... }            /* installed-iOS chin, see docs/ui.md */
.mobile-nav{ ... height:calc(67px + var(--sab)) ... }
.now-modal .modal-close{ ... top:calc(12px + var(--sat)) ... }
.now-modal{ padding:calc(64px + var(--sat)) ... }
```

`index.html` and `offline.html` must keep a byte-identical inline `--app-h` boot
script before their stylesheets; `test/ios-chin.test.js` compares the two. The
root chain (`html`, `body`) must use `height:var(--app-h,100%)` as well as
`.app` — a `100%` root clips the taller shell and the chin comes back.

and the real-browser geometry checks: `.app` height == `innerHeight`, document never scrolls,
top bar below the notch, mobile nav above the home indicator, now-playing close button above the
artwork and controls above the fold on iPhone 15 Pro / Pro Max / SE. `--sat/--sab/--sal/--sar`
custom properties must stay.

Also preserved: `<div class="brand-word">`, `id="i-wave"`, `@media(max-width:650px)`.

Existing JS hooks that must keep working: every `data-action`, `data-page`, `data-collection`,
`data-track`, `data-filter`, `data-library-tab`, `data-mood`, `data-overlay-tab`,
`data-admin-tab`, `data-slider`, ids `#page-root #player #rail-content #mobile-nav #desktop-nav
#side-playlists #toast #toast-text #now-overlay #now-content #drawer-overlay #queue-drawer
#context-menu #profile-menu #auth-overlay #yt-overlay #audio`.

---

## 2. Direction

- Brand: warm charcoal + coral (`--accent:#ff997b`), soft plum undertones, editorial display type,
  hairline borders, subtle depth. No neon, no glassmorphism soup, no generic "AI dashboard" cards.
- Surfaces are layered, not outlined everywhere: page → panel → raised card. 1px inset highlight
  on raised surfaces. Shadows only where something floats (player, menus, sheets).
- Type: self-hosted **Inter variable** (`/fonts.css`, weights 300–800) is already wired. UI text
  13–14px desktop / 14–15px mobile body; display uses tight tracking (`-0.02em` … `-0.035em`) and
  weight 750–800. Muted text must hit **≥4.5:1** on its background.
- Spacing: 4px base scale. Radii: 8 / 12 / 16 / 22 / pill. Don't mix arbitrary values.
- Motion tokens: `--dur-1:140ms; --dur-2:220ms; --dur-3:320ms;
  --ease-out:cubic-bezier(.22,.68,.18,1); --ease-spring:cubic-bezier(.2,.9,.25,1.2)`.
  Animate **transform/opacity only**. Entrance: page fade+8px rise 220ms; card grids stagger
  (30ms per item, cap 8); sheets slide up 320ms; backdrop fade 180ms; toast rise 220ms;
  heart pop; skeleton shimmer; waveform/eq loops. Nothing bouncy or longer than 400ms.
  Everything collapses under `@media (prefers-reduced-motion: reduce)`.

---

## 3. New DOM contract (implemented by the app-shell owner, styled by the CSS owner)

Class names below are reserved and will appear in `public/index.html` / `public/app.js`.
Do not rename them. Style all of them.

**Utilities / a11y**
`.sr-only`, `.skip-link`, `.press` (momentary TS touch class), `[aria-busy="true"]`,
`:focus-visible` ring (`outline:2px solid color-mix(in srgb, var(--accent) 75%, white); outline-offset:2px`).

**Skeletons** (replace text "Loading…")
```html
<div class="sk-hero"></div>
<div class="sk-grid">
  <div class="sk-card"><div class="sk sk-cover"></div><div class="sk sk-line w-60"></div><div class="sk sk-line w-40"></div></div>
</div>
<div class="sk-rows">
  <div class="sk-row"><div class="sk sk-cover sm"></div><div class="sk-lines"><div class="sk sk-line w-70"></div><div class="sk sk-line w-35"></div></div></div>
</div>
```
Width helpers `.w-35 .w-40 .w-60 .w-70` (percent). Shimmer via `::after` gradient sweep.

**Empty states**
```html
<div class="empty-state"><div class="empty-art"><svg class="ico">…</svg></div>
  <h3>Nothing liked yet</h3><p>Tap the heart on any track…</p>
  <div class="empty-actions"><button class="play-btn">…</button></div></div>
```

**Toast** — `.toast` gains `.show` while visible and `.toast.error` / `.toast.info` variants;
`aria-live="polite" role="status"` on the element.

**Overlays** — closing adds `.closing` for ~180ms before `hidden` returns:
`.overlay.closing`, `.overlay.closing .now-modal`, `.drawer-backdrop.closing`,
`.overlay:not([hidden])`, `.overlay:not([hidden]) .now-modal`, `.drawer-backdrop:not([hidden]) .drawer`.

**Now-playing sheet additions**
```html
<div class="sheet-grip" aria-hidden="true"></div>       <!-- mobile drag handle -->
<div class="np-head">                                    <!-- holds eyebrow + title + byline -->
<div class="np-scroll">                                  <!-- lyrics / about scroll region -->
<div class="np-actions">                                 <!-- action row: like, queue, share -->
<div class="np-next">                                    <!-- "Up next" list -->
```
Swipe-to-close sets inline `transform` and toggles `.dragging` (transition disabled).
`.now-modal.dragging{transition:none}`.

**Player** — `<div class="mini-progress"><i style="width:var(--progress,0%)"></i></div>` inside the
mobile bar (the old `:before` line goes away); `.player.is-playing` when playing; `.player.is-empty`;
`.player-song-meta` already exists. Mobile controls must be **≥44×44px**.

**Segmented control** (library tabs / player tabs)
```html
<div class="segmented" role="tablist">
  <button class="segment is-active" role="tab" aria-selected="true">Playlists</button>
</div>
```
Keep `.chip.selected`/`.modal-tabs button.active` working too.

**Forms** — `.form-sheet` (single-column modal), `.form-row`, `.form-actions`, `.btn-primary`
(alias of `.play-btn` look), `.btn-ghost`, `.field-hint`, `.field-error`, `.btn-loading` with spinner.

**Search** — `.search-shell`, `.search-recent` (row of `.chip.small`), `.search-hint`,
`.search-skeleton`.

**Radio** — station markup becomes
```html
<button class="station" data-action="station" data-id="…">
  <div class="station-art"><img class="cover" …><span class="station-play"><svg/></span></div>
  <div class="station-body"><strong>After Hours</strong><p>Night Drive</p><small>STATION</small></div>
</button>
```
Mobile: compact 2-column or stacked rows, never a 300px-tall cover.

**Collection** — `.collection-hero`, `.collection-actions` exist; add `.collection-hero.compact`
when the title is long. Mobile hero art 96–116px, title clamps to 2 lines.

**Mini player / nav** — mobile nav labels 9–10px, tap targets ≥44px high; `aria-current="page"`
on active nav; safe-area padding preserved.

**Context menu** — `.context-menu.flip-y` / `.flip-x` when it would overflow the viewport.

**Install / update / offline** (owned by the PWA agent, namespaced `.pwa-*`, its own
`public/pwa.css`): `.pwa-banner`, `.pwa-banner.show`, `.pwa-pill`, `.pwa-pill.show`, `.pwa-sheet`.
The install offer is made at every width — Windows and macOS install PWAs too — as
`.pwa-banner` below 1081px and as `.pwa-pill[data-kind="install"]` above it.

---

## 4. Measured defects to fix (from real-browser audit at 390×844)

1. **Library → Playlists is stuck on "Loading…" forever.** `libraryPage()` computes
   `loading = state.browse[tab.toLowerCase()] === null`; `browse.playlists` never exists.
2. `prompt()` for new playlist and `confirm()` for delete — native dialogs break the PWA feel.
   Replace with `.form-sheet` and an in-app confirm.
3. iOS zooms the page when the search field (14px) is focused. Inputs must be ≥16px on mobile.
4. Touch targets under 44px: topbar icon buttons 32×35, mini-player buttons 31×31, text links 16px.
5. Library/collection loads show a bare "Loading…" line (no skeleton, layout jump).
6. Search mood tiles render flat colour with no artwork on mobile (test the `.mood img` path;
   the markup hides images behind `right:-21px;bottom:-44px` on small screens).
7. Now-playing sheet: no swipe-to-dismiss, no drag affordance, no queue access, lyrics box cramped,
   no exit animation.
8. Player bar on mobile has no progress indication before audio metadata loads and no like/queue.
9. Radio page: station cards are giant squares on mobile; 2 columns push titles below the fold.
10. No focus trap / `aria-modal` / Escape handling consistency in overlays; context menu can
    overflow the right/bottom edge; no `aria-live` toast.
11. Browser back/forward do nothing (internal history array only, no `pushState`). Android back
    exits the app instead of going back.
12. No offline/update/install affordances; manifest is placeholder text ("sonora"), icons are a
    flat "M" placeholder on purple, service worker precaches nothing.
13. Empty library/recent/likes have no empty state; playlist card counts and "sort" action are fake
    (`notify('Sorted by recently played')`).
14. Images are all `loading="lazy"` including above-the-fold artwork; no low-quality placeholder,
    no broken-image fallback.
15. No page entrance transition when navigating; nav items re-render without `aria-current`.
16. Top bar is 75px of mostly empty space on mobile and the search affordance disappears entirely
    (there is no compact way to search from Discover).

Fix what you own; report the rest.

---

## 5. Acceptance bar

Real browser (headless Chromium via `test/helpers/cdp.js`), viewports:
`320×568, 360×740, 390×844, 430×932, 768×1024, 844×390 (landscape), 1024×768, 1440×900, 1920×1080`.

- No horizontal document overflow, no overlapping/clipped text, no controls outside the viewport.
- Every interactive element ≥44×44px on touch viewports (≥40 desktop is acceptable).
- All pages (home, search+results, library×3 tabs, radio, liked, recent, playlist, album, admin,
  queue drawer, now-playing, auth, YouTube sheet, create-playlist sheet) render without console errors.
- Keyboard: Tab reaches everything, visible focus ring, Escape closes every overlay, Space
  play/pause, ⌘/Ctrl-K search. Focus returns to the trigger after a sheet closes.
- `prefers-reduced-motion` removes animation, never breaks layout.
- Offline: reloading while offline shows the branded shell (or offline page), not a browser error.
- Lighthouse PWA installability (manifest icons 192/512 + maskable, SW registered).
- `npm test` stays green (143 tests; live-YouTube tests may be flaky — do not weaken them).
