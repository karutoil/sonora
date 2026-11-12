import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME, freePort, launch } from './helpers/cdp.js';
import {
  ROOT, SHOTS, VIEW, SWEEP_PAGES, INIT_SCRIPT, SEED_TRACK,
  startServer, seedPlaylist, seedPlayerState, withPage, nav, click, startTrack, openNowPlaying,
  layoutProbeSrc, touchTargetProbeSrc, focusProbeSrc, nameProbeSrc, motionProbeSrc,
} from './helpers/ux.js';

// Real-browser UX acceptance for docs/ux-spec.md.
//
// Everything here is a behaviour assertion on live DOM/layout in headless
// Chromium: no greps dressed up as tests, except item F which is explicitly a
// source check. The app boots against its own temp DB, so a run can never
// disturb ~/projects/muse-pwa/data.
//
// Expected failures today are the implementation targets from the spec:
// library Playlists loading forever, sub-44px hit boxes, overlay semantics,
// aria-current/aria-pressed, native prompt()/confirm(), reduced motion,
// mobile search font size, bare "Loading…" text, and no pushState history.
// Do not weaken an assertion to make a run green.

const APP_JS = path.join(ROOT, 'public/app.js');

let server;
let browser;
let BASE;
let PLAYLIST;

before(async () => {
  // Fresh artifacts each run: .tmp/ux is only ever written by this suite.
  fs.rmSync(SHOTS, { recursive: true, force: true });
  server = await startServer();
  BASE = server.base;
  const seed = await seedPlaylist(BASE);
  PLAYLIST = { id: seed.id, title: seed.title, track: seed.tracks[0] };

  if (!CHROME) return;
  browser = await launch(await freePort());
  await browser.addInitScript(INIT_SCRIPT);
  await browser.viewport(VIEW.desktop);
  await browser.goto(`${BASE}/`);
  const status = await browser.eval(`fetch('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'toil', passphrase: 'hunter2hunter2' }) }).then((r) => r.status)`);
  assert.equal(status, 200, 'browser login with toil/hunter2hunter2 failed');
  await browser.goto(`${BASE}/`);
  await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
});

after(async () => {
  browser?.close();
  await server?.stop();
});

function needBrowser(t) {
  if (browser) return true;
  t.skip(CHROME
    ? 'Chromium did not launch; set CHROME_BIN=/usr/bin/chromium and re-run'
    : 'no Chromium found; set CHROME_BIN=/usr/bin/chromium to run the UX suite');
  return false;
}

function ageLabel(m) {
  return `document scrollWidth ${m.docScrollWidth}px > clientWidth ${m.docClientWidth}px`;
}

// ── A. library tabs ──────────────────────────────────────────────────────

test('A: Library → Playlists renders cards and never stays on a Loading skeleton', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'library' }, async (ctx) => {
    let rendered = true;
    try {
      await browser.waitFor(`!!document.querySelector('#page-root [data-collection="p${PLAYLIST.id}"]')`, 6000);
    } catch {
      rendered = false;
    }

    const diag = await browser.eval(`(() => {
      const root = document.getElementById('page-root');
      return {
        cards: root.querySelectorAll('.music-card').length,
        loading: root.querySelectorAll('.sk, .skeleton, [aria-busy="true"]').length,
        text: root.innerText.replace(/\\s+/g, ' ').slice(0, 220),
        tabs: [...root.querySelectorAll('[data-library-tab]')].map((b) => b.textContent.trim()),
      };
    })()`);
    assert.ok(rendered,
      `playlist card for "p${PLAYLIST.id}" never rendered on the Playlists tab `
      + `(cards=${diag.cards}, loading elements=${diag.loading}, tabs=${JSON.stringify(diag.tabs)}). `
      + `Page text: ${JSON.stringify(diag.text)}. `
      + 'The Playlists tab must render from the loaded playlist list, not wait on a browse key that is never set.');

    const titles = await browser.eval(
      `[...document.querySelectorAll('#page-root .music-card-title, #page-root .music-card')]
        .map((e) => e.textContent.trim())`,
    );
    assert.ok(titles.some((x) => x.includes(PLAYLIST.title)),
      `seeded playlist "${PLAYLIST.title}" is not among the rendered library cards: ${JSON.stringify(titles)}`);

    await browser.waitFor(
      `!document.querySelector('#page-root .sk, #page-root .skeleton, #page-root [aria-busy="true"]')`, 3000,
    ).catch(() => {});
    const stuck = await browser.eval(`(() => {
      const root = document.getElementById('page-root');
      const visibleLoading = [...root.querySelectorAll('*')].some((el) => {
        if (el.children.length) return false;
        if (!/\\bLoading\\b/.test(el.textContent)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4; // sr-only live regions are fine
      });
      return {
        skeletons: root.querySelectorAll('.sk, .skeleton').length,
        busy: root.querySelectorAll('[aria-busy="true"]').length,
        saysLoading: visibleLoading,
      };
    })()`);
    assert.deepEqual(stuck, { skeletons: 0, busy: 0, saysLoading: false },
      `the Playlists tab loaded data but still shows a loading state: ${JSON.stringify(stuck)}`);

    await ctx.shot('library-playlists');
  });
});

test('A: Library Albums and Artists tabs render fixture cards without console errors', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'library' }, async () => {
    for (const [tab, expected] of [
      ['Albums', 'Fixture Album One'],
      ['Artists', 'Fixture Artist One'],
    ]) {
      await browser.eval(`document.querySelector('#page-root [data-library-tab="${tab}"]').click()`);
      await browser.waitFor(
        `[...document.querySelectorAll('#page-root .music-card-title')].some((e) => e.textContent.includes(${JSON.stringify(expected)}))`,
        6000,
      ).catch(() => {});
      const state = await browser.eval(`(() => ({
        cards: document.querySelectorAll('#page-root .music-card').length,
        titles: [...document.querySelectorAll('#page-root .music-card-title')].map((e) => e.textContent.trim()),
        loading: document.querySelectorAll('#page-root .sk, #page-root .skeleton').length,
      }))()`);
      assert.ok(state.titles.some((x) => x.includes(expected)),
        `${tab} tab did not render its cards (cards=${state.cards}, loading=${state.loading}, titles=${JSON.stringify(state.titles)})`);

      const errors = await browser.eval(`(window.__ux?.errors ?? []).slice()`);
      assert.deepEqual(errors, [], `${tab} tab produced console errors: ${JSON.stringify(errors)}`);
    }
  });
});

// ── B. mobile layout sweep ───────────────────────────────────────────────

for (const viewport of [VIEW.mobile390, VIEW.mobile360]) {
  test(`B: ${viewport.name} — no horizontal overflow and chrome inside the viewport on every page`, async (t) => {
    if (!needBrowser(t)) return;

    await withPage(browser, BASE, { viewport }, async (ctx) => {
      for (const page of SWEEP_PAGES) {
        if (page !== 'home') await nav(browser, page, { playlistId: PLAYLIST.id });
        const m = await browser.eval(layoutProbeSrc);
        await ctx.shot(page);
        const at = `${page} @ ${viewport.name}`;

        assert.ok(m.docScrollWidth <= m.docClientWidth, `${at}: horizontal document overflow — ${ageLabel(m)}`);
        assert.ok(m.bodyScrollWidth <= m.innerWidth,
          `${at}: body is wider than the viewport (body ${m.bodyScrollWidth}px, viewport ${m.innerWidth}px)`);

        assert.ok(m.topbar, `${at}: no #topbar found`);
        assert.ok(m.topbar.top >= -0.5 && m.topbar.bottom <= m.innerHeight + 0.5,
          `${at}: topbar is outside the visual viewport (top ${m.topbar.top}px, bottom ${m.topbar.bottom}px, viewport ${m.innerHeight}px)`);

        assert.ok(m.nav, `${at}: no #mobile-nav found`);
        assert.ok(m.nav.top >= -0.5 && m.nav.bottom <= m.innerHeight + 0.5,
          `${at}: mobile nav is outside the visual viewport (top ${m.nav.top}px, bottom ${m.nav.bottom}px, viewport ${m.innerHeight}px)`);

        const navOutside = m.navButtons.filter((b) => b.left < -0.5 || b.right > m.innerWidth + 0.5);
        assert.deepEqual(navOutside, [],
          `${at}: mobile nav buttons spill outside the viewport width ${m.innerWidth}px: ${JSON.stringify(navOutside)}`);

        assert.ok(m.content.mainBottom <= m.content.playerTop + 1,
          `${at}: the scrolling content column ends at ${m.content.mainBottom}px, below the player top ${m.content.playerTop}px `
          + '(content is covered by the mini player)');
        assert.ok(m.content.lastBottom === null || m.content.lastBottom <= m.content.mainBottom + 1,
          `${at}: after scrolling to the end, the last block (${m.content.lastTag}) ends at ${m.content.lastBottom}px, `
          + `past the content area boundary ${m.content.mainBottom}px — it is hidden behind the player/nav`);
      }
    });
  });
}

// ── C. touch targets ─────────────────────────────────────────────────────

test('C: every visible control on 390x844 is at least 44x44 CSS px', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390 }, async (ctx) => {
    const perPage = [];
    for (const page of ['home', 'library', 'playlist']) {
      if (page !== 'home') await nav(browser, page, { playlistId: PLAYLIST.id });
      await ctx.shot(`touch-${page}`);
      perPage.push({ page, ...(await browser.eval(touchTargetProbeSrc)) });
    }

    // The now-playing sheet is the densest touch surface (transport, progress
    // slider, queue/like actions) and is only measurable while open.
    await ctx.goto();
    await startTrack(browser);
    await openNowPlaying(browser);
    await ctx.shot('touch-now-playing');
    perPage.push({ page: 'now-playing', ...(await browser.eval(touchTargetProbeSrc)) });

    const total = perPage.reduce((n, x) => n + x.total, 0);
    const offenders = perPage.flatMap((x) => x.offenders.map((o) => ({ page: x.page, ...o })));
    const report = offenders.slice(0, 30)
      .map((o) => `  ${o.page}: ${o.sel} → ${o.w}x${o.h}`)
      .join('\n');
    assert.equal(offenders.length, 0,
      `${offenders.length} of ${total} visible controls have a hit box under 44x44 on 390x844 `
      + `(min threshold 43.5px to absorb sub-pixel rounding):\n${report}`
      + (offenders.length > 30 ? `\n  … ${offenders.length - 30} more` : ''));
  });
});

// ── D. focus + keyboard ──────────────────────────────────────────────────

test('D: tab order runs nav → page → player and every focused control shows a visible ring', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async () => {
    const f = await browser.eval(focusProbeSrc);

    assert.ok(f.order.nav >= 0, 'no focusable element exists in the navigation');
    assert.ok(f.order.page >= 0, 'no focusable element exists in #page-root');
    assert.ok(f.order.player >= 0, 'no focusable element exists in #player');
    assert.ok(f.order.nav < f.order.page,
      `tab order puts page content (index ${f.order.page}) before the nav (index ${f.order.nav})`);
    assert.ok(f.order.page < f.order.player,
      `tab order puts the player (index ${f.order.player}) before page content (index ${f.order.page})`);

    const noRing = f.missingRing.map((x) => `${x.sel} (outline ${x.outline}, box-shadow ${x.boxShadow})`);
    assert.deepEqual(noRing, [],
      `${noRing.length} of ${f.sampled} focused controls have no visible focus indicator `
      + '(need outline-width >= 2px or a box-shadow ring):\n' + noRing.map((x) => `  ${x}`).join('\n'));

    const notFV = f.notFocusVisible.map((x) => x.sel);
    assert.deepEqual(notFV, [],
      `focus() did not put these controls in :focus-visible state: ${JSON.stringify(notFV)}`);
  });
});

test('D: now-playing is a modal dialog that traps focus, closes on Escape and restores focus', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async (ctx) => {
    await startTrack(browser);
    await openNowPlaying(browser);

    const dialog = await browser.eval(`(() => {
      const overlay = document.getElementById('now-overlay');
      const dlg = overlay.matches('[role="dialog"]') ? overlay : overlay.querySelector('[role="dialog"]');
      return {
        found: !!dlg,
        ariaModal: (dlg ?? overlay).getAttribute('aria-modal'),
        focusables: dlg ? dlg.querySelectorAll('button, input, a[href], [tabindex]:not([tabindex="-1"])').length : 0,
      };
    })()`);
    assert.ok(dialog.found, '#now-overlay / .now-modal has no role="dialog" (overlays must be dialogs)');
    assert.equal(dialog.ariaModal, 'true', 'the now-playing dialog does not set aria-modal="true"');
    assert.ok(dialog.focusables >= 2,
      `the now-playing dialog exposes only ${dialog.focusables} focusable control(s); a trap cannot cycle`);

    const focusInsideExpr = `(() => {
      const overlay = document.getElementById('now-overlay');
      const dlg = overlay.matches('[role="dialog"]') ? overlay : overlay.querySelector('[role="dialog"]');
      return !!dlg && dlg.contains(document.activeElement);
    })()`;
    await browser.waitFor(focusInsideExpr, 2000).catch(() => {});
    assert.ok(await browser.eval(focusInsideExpr),
      'opening the now-playing sheet did not move focus inside it');
    await ctx.shot('now-playing');
    // Let the sheet finish its open animation/lyrics re-render, then re-assert:
    // a late innerHTML refresh that drops focus is itself an a11y regression.
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(await browser.eval(focusInsideExpr),
      'focus was inside the sheet on open but a re-render stole it before the first Tab');

    // test/helpers/cdp.js exposes no Input.dispatchKeyEvent, so a trusted Tab
    // cannot be dispatched. We therefore emulate a native Tab: fire the keydown
    // the trap must handle, and if nothing moved, advance focus the way the
    // browser would — to the next focusable in the *document*, which is outside
    // the dialog once its last control is passed. A missing trap is caught by
    // that escape; a boundary-wrapping trap (the usual implementation) moves
    // focus itself and is counted as `handled`.
    const trap = await browser.eval(`(() => {
      const overlay = document.getElementById('now-overlay');
      const dlg = overlay.matches('[role="dialog"]') ? overlay : overlay.querySelector('[role="dialog"]');
      const visible = (el) => el.getClientRects().length > 0
        && getComputedStyle(el).visibility !== 'hidden';
      const snapshot = () => [...document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter(visible);
      const inDialog = snapshot().filter((el) => dlg.contains(el));
      let handled = 0;
      let escaped = null;
      const steps = Math.max(4, inDialog.length + 2);
      for (let i = 0; i < steps; i++) {
        const before = document.activeElement;
        before.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        if (document.activeElement !== before) { handled += 1; }
        else {
          // Browser default: next focusable in document order. Recomputed each
          // step because opening a sheet refreshes its DOM asynchronously.
          const all = snapshot();
          const at = all.indexOf(document.activeElement);
          // The sheet parks focus on its own tabindex="-1" panel, which is not
          // in the snapshot (it is not a tab stop). Its *children* still follow
          // it in document order, so compareDocumentPosition is what a real Tab
          // does here; indexOf would wrongly conclude "nothing follows".
          const next = at >= 0
            ? all[at + 1]
            : all.find((el) => document.activeElement.compareDocumentPosition(el)
              & Node.DOCUMENT_POSITION_FOLLOWING);
          if (next) next.focus({ focusVisible: true });
        }
        if (!dlg.contains(document.activeElement)) {
          escaped = (document.activeElement?.outerHTML ?? 'body').slice(0, 100);
          break;
        }
      }
      return { handled, escaped, inDialog: inDialog.length, steps };
    })()`);
    assert.equal(trap.escaped, null,
      `Tab escaped the now-playing dialog to ${trap.escaped} after ${trap.steps} steps`);
    if (trap.handled === 0) {
      // Some traps guard focusin instead of intercepting Tab. Accept that
      // mechanism too: focusing an element outside the sheet must be refused.
      const guard = await browser.eval(`(() => {
        const overlay = document.getElementById('now-overlay');
        const dlg = overlay.matches('[role="dialog"]') ? overlay : overlay.querySelector('[role="dialog"]');
        const outside = [...document.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
          .find((el) => !dlg.contains(el) && el.getClientRects().length > 0 && !el.closest('[hidden]'));
        if (!outside) return { ok: true, note: 'no outside control' };
        outside.focus({ focusVisible: true });
        return { ok: dlg.contains(document.activeElement), active: (document.activeElement?.outerHTML ?? '').slice(0, 90) };
      })()`);
      assert.ok(guard.ok, `programmatic focus escaped the dialog to ${guard.active}; no Tab or focusin trap is active`);
    } else {
      assert.ok(trap.handled > 0, 'the focus trap did not wrap at the dialog edges');
    }

    // The contract, stated directly: from the last control in the sheet, Tab
    // wraps to the first. Emulation above cannot prove this (it can always
    // "stay inside" by accident), so press the key from the edge and read the
    // outcome. This is what fails if the trap is removed.
    const wrap = await browser.eval(`(() => {
      const overlay = document.getElementById('now-overlay');
      const dlg = overlay.matches('[role="dialog"]') ? overlay : overlay.querySelector('[role="dialog"]');
      const list = [...dlg.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
      if (list.length < 2) return { ok: false, why: 'fewer than two controls in the sheet' };
      const first = list[0];
      const last = list[list.length - 1];
      last.focus();
      const before = document.activeElement;
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      const after = document.activeElement;
      return {
        ok: after !== before && after === first && dlg.contains(after),
        moved: after !== before,
        inside: dlg.contains(after),
        active: (after?.className ?? String(after?.tagName)).slice(0, 60),
      };
    })()`);
    assert.ok(wrap.ok,
      `Tab from the last control of the sheet must wrap to the first; it `
      + `${wrap.moved ? 'moved' : 'did not move'} to ${wrap.active} (inside dialog: ${wrap.inside})`);

    const closed = await browser.eval(`(() => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return document.getElementById('now-overlay').hidden
        || document.getElementById('now-overlay').classList.contains('closing');
    })()`);
    assert.ok(closed, 'Escape did not close the now-playing sheet (neither [hidden] nor .closing)');

    const restoredExpr = `(() => { const t = window.__uxTrigger;
      return !!t && (document.activeElement === t || t.contains(document.activeElement)); })()`;
    await browser.waitFor(restoredExpr, 2000).catch(() => {});
    const active = await browser.eval(`(document.activeElement?.outerHTML ?? 'null').slice(0, 120)`);
    assert.ok(await browser.eval(restoredExpr),
      `focus did not return to the now-playing trigger after Escape; active element is ${active}`);
  });
});

test('D: the queue drawer is a modal dialog and Escape closes it', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async () => {
    await startTrack(browser);
    await click(browser, '#player [data-action="queue"], #rail-content [data-action="queue"]', 'queue button');
    await browser.waitFor(`!document.getElementById('drawer-overlay').hidden`, 5000);

    const drawer = await browser.eval(`(() => {
      const backdrop = document.getElementById('drawer-overlay');
      const drawer = document.getElementById('queue-drawer');
      const located = [drawer, backdrop].find((el) => el && el.getAttribute('role') === 'dialog');
      return {
        found: !!located,
        ariaModal: located?.getAttribute('aria-modal') ?? null,
        focusables: drawer.querySelectorAll('button, [tabindex]:not([tabindex="-1"])').length,
      };
    })()`);
    assert.ok(drawer.found, 'the queue drawer (or its backdrop) has no role="dialog"');
    assert.equal(drawer.ariaModal, 'true', 'the queue drawer does not set aria-modal="true"');
    assert.ok(drawer.focusables > 0, 'the queue drawer has no focusable controls');

    const closed = await browser.eval(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return document.getElementById('drawer-overlay').hidden
        || document.getElementById('drawer-overlay').classList.contains('closing');
    })()`);
    assert.ok(closed, 'Escape did not close the queue drawer (neither [hidden] nor .closing)');
  });
});

// ── E. ARIA ──────────────────────────────────────────────────────────────

test('E: toast is announced politely (role=status, aria-live=polite)', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'playlist', playlistId: PLAYLIST.id }, async () => {
    // "Play next" from a song's row menu is a toast with no network behind it,
    // so this test measures the toast element and nothing else. (It used to
    // press the bell, which was the only toast on the home page — the bell now
    // opens the notification panel, which is the point of that panel.)
    await browser.waitFor(`!!document.querySelector('#page-root .track-more')`, 10_000);
    await browser.eval(`document.querySelector('#page-root .track-more').click()`);
    await browser.waitFor(`!!document.querySelector('#context-menu [data-menu-action="next"]')`, 3000);
    await browser.eval(`document.querySelector('#context-menu [data-menu-action="next"]').click()`);
    await browser.waitFor(`(() => {
      const el = document.getElementById('toast');
      return !el.hidden || el.classList.contains('show');
    })()`, 3000);

    const toast = await browser.eval(`(() => {
      const el = document.getElementById('toast');
      return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), text: el.textContent.trim() };
    })()`);
    assert.equal(toast.role, 'status', `#toast role is ${JSON.stringify(toast.role)}, expected "status"`);
    assert.equal(toast.live, 'polite', `#toast aria-live is ${JSON.stringify(toast.live)}, expected "polite"`);
    assert.ok(toast.text.length > 0, 'the visible toast has no text');
  });
});

test('E: the active nav item carries aria-current="page" and only it does', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'library' }, async () => {
    const items = await browser.eval(`(() => {
      const nav = window.innerWidth <= 650 ? document.getElementById('mobile-nav') : document.getElementById('desktop-nav');
      return [...nav.querySelectorAll('button')].map((b) => ({
        label: (b.textContent || b.getAttribute('aria-label') || '').trim(),
        active: b.classList.contains('active') || b.getAttribute('aria-current') === 'page',
        current: b.getAttribute('aria-current'),
      }));
    })()`);
    const active = items.filter((x) => x.active);
    assert.equal(active.length, 1, `expected exactly one active nav item, got ${JSON.stringify(items)}`);
    assert.equal(active[0].current, 'page',
      `the active nav item (${JSON.stringify(active[0].label)}) has aria-current=${JSON.stringify(active[0].current)}, expected "page"`);
    const strays = items.filter((x) => !x.active && x.current === 'page').map((x) => x.label);
    assert.deepEqual(strays, [], `inactive nav items also carry aria-current="page": ${JSON.stringify(strays)}`);
  });
});

test('E: like buttons expose aria-pressed', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop }, async () => {
    await startTrack(browser);
    const buttons = await browser.eval(`(() => [...document.querySelectorAll('[data-action="heart"]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => ({ pressed: b.getAttribute('aria-pressed'), html: b.outerHTML.replace(/\\s+/g, ' ').slice(0, 140) })))()`);
    assert.ok(buttons.length > 0, 'no like buttons rendered while a track is loaded');
    const bad = buttons.filter((b) => b.pressed !== 'true' && b.pressed !== 'false');
    assert.deepEqual(bad.map((b) => b.html), [],
      `${bad.length} of ${buttons.length} like button(s) have no aria-pressed="true|false":\n${bad.map((b) => `  ${b.html}`).join('\n')}`);

    // Track rows are the other place a heart appears; include them when the
    // collection route rendered (its availability is covered by A/B).
    await nav(browser, 'playlist', { playlistId: PLAYLIST.id }).catch(() => {});
    const rows = await browser.eval(`(() => [...document.querySelectorAll('#page-root [data-action="heart"]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => ({ pressed: b.getAttribute('aria-pressed'), html: b.outerHTML.replace(/\\s+/g, ' ').slice(0, 140) })))()`);
    const badRows = rows.filter((b) => b.pressed !== 'true' && b.pressed !== 'false');
    assert.deepEqual(badRows.map((b) => b.html), [],
      `${badRows.length} track-row like button(s) have no aria-pressed="true|false":\n${badRows.map((b) => `  ${b.html}`).join('\n')}`);
  });
});

test('E: every icon-only control has a non-empty accessible name', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390 }, async () => {
    const offenders = [];
    for (const page of ['home', 'library', 'playlist']) {
      if (page !== 'home') await nav(browser, page, { playlistId: PLAYLIST.id });
      const r = await browser.eval(nameProbeSrc);
      offenders.push(...r.offenders.map((sel) => `${page}: ${sel}`));
    }
    assert.deepEqual(offenders, [],
      `${offenders.length} icon-only control(s) have no aria-label/aria-labelledby/title:\n${offenders.map((x) => `  ${x}`).join('\n')}`);
  });
});

// ── F. no native dialogs ─────────────────────────────────────────────────

test('F: public/app.js contains no native prompt()/confirm()', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const lines = src.split('\n');
  const hits = [];
  const re = /\b(prompt|confirm)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    hits.push({ call: `${m[1]}(`, line, source: lines[line - 1]?.trim().slice(0, 120) });
  }
  assert.deepEqual(hits, [],
    `${hits.length} native dialog call(s) in public/app.js; they must be in-app sheets instead:\n`
    + hits.map((h) => `  line ${h.line}: ${h.call} … ${h.source}`).join('\n'));
});

// ── G. reduced motion ────────────────────────────────────────────────────

test('G: prefers-reduced-motion:reduce removes page/card/sheet animation', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE,
    { viewport: { ...VIEW.mobile390, name: '390x844-reduced', reducedMotion: true } },
    async () => {
      const pageAndCard = await browser.eval(motionProbeSrc);
      assert.equal(pageAndCard.reduce, true, 'prefers-reduced-motion:reduce is not being emulated');

      await startTrack(browser);
      await openNowPlaying(browser);
      const sheet = await browser.eval(motionProbeSrc);

      assert.equal(sheet.appHeight, sheet.innerHeight,
        `reduced motion changed the shell height (app ${sheet.appHeight}px vs viewport ${sheet.innerHeight}px)`);
      assert.ok(sheet.appHeight > 0, 'reduced motion collapsed the shell layout to zero height');

      const probes = [...pageAndCard.probes, ...sheet.probes.filter((p) => p.sel === '.now-modal')];
      const seen = new Set();
      for (const p of probes) {
        if (!p || seen.has(p.sel)) continue;
        seen.add(p.sel);
        const noAnimation = p.animationName === 'none' || /^0s(, 0s)*$/.test(p.animationDuration.trim());
        assert.ok(noAnimation,
          `${p.sel} still animates under prefers-reduced-motion:reduce `
          + `(animation-name: ${p.animationName}, animation-duration: ${p.animationDuration})`);
      }

      const sheetProbe = sheet.probes.find((p) => p.sel === '.now-modal');
      assert.ok(sheetProbe, 'the now-playing sheet (.now-modal) was not found while open');
      assert.equal(sheetProbe.maxTransition, 0,
        `.now-modal still transitions under prefers-reduced-motion:reduce (transition-duration: ${sheetProbe.transitionDuration})`);
      assert.ok(sheetProbe.width > 0, 'the now-playing sheet has zero width under reduced motion (layout broken)');
    });
});

// ── H. iOS zoom guard ────────────────────────────────────────────────────

test('H: the mobile search input font-size is at least 16px (iOS zoom guard)', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async () => {
    const input = await browser.eval(`(() => {
      const el = [...document.querySelectorAll('#primary-search, .search-shell input, input[type="search"]')]
        .find((x) => x.getBoundingClientRect().width > 0);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { id: el.id || el.className || el.tagName, fontSize: parseFloat(cs.fontSize), raw: cs.fontSize };
    })()`);
    assert.ok(input, 'no visible search input found on the search page');
    assert.ok(input.fontSize >= 16,
      `search input ${JSON.stringify(input.id)} is ${input.raw} on mobile; iOS zooms the page below 16px`);
  });
});

// ── H2. browse by feeling ────────────────────────────────────────────────
// A mood used to run a song search, which returned 4-hour single-video mixes.
// It must now list real playlists (openable, with songs to pick) plus top songs.

test('H2: a feeling lists playlists you can open, not 4-hour mixes', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await browser.eval(`document.querySelector('[data-mood="lofi chill"]').click()`);
    await browser.waitFor(
      `document.querySelectorAll('#page-root .library-grid [data-collection^="aPLuxMood"]').length === 2`,
      5000,
    );

    const info = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .page-title')?.textContent?.trim(),
      hash: location.hash,
      cards: [...document.querySelectorAll('#page-root .library-grid .music-card')]
        .map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
      rows: document.querySelectorAll('#page-root .track-row').length,
    }))()`);
    assert.match(info.title ?? '', /Chill/, 'the mood names the page');
    assert.equal(info.hash, '#/mood/lofi%20chill', 'a feeling is a route, so back works');
    assert.equal(info.cards.length, 2, 'playlists are listed');
    assert.match(info.cards[0], /Fixture Mood Playlist/, 'the playlist title is shown');
    assert.match(info.cards[0], /42 songs/, 'a real track count is shown, not a view count');
    assert.equal(info.rows, 2, 'the feeling\'s top songs are playable in place');

    // Opening a playlist is the point: a list of songs to choose from.
    await browser.eval(`document.querySelector('#page-root [data-collection="aPLuxMoodOne"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero h1')`, 5000);
    const opened = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .collection-hero h1')?.textContent?.trim(),
      type: document.querySelector('#page-root .collection-type')?.textContent?.trim(),
      rows: document.querySelectorAll('#page-root .track-row').length,
      hash: location.hash,
    }))()`);
    assert.equal(opened.title, 'Fixture Mood Playlist');
    assert.equal(opened.type, 'Playlist', 'a community playlist is labelled a playlist, not an album');
    assert.equal(opened.rows, 2, 'the playlist\'s songs are listed');
    assert.equal(opened.hash, '#/c/aPLuxMoodOne');

    // Back returns to the feeling page without refetching it.
    await browser.eval(`document.querySelector('[data-action="back"]').click()`);
    await browser.waitFor(
      `document.querySelectorAll('#page-root .library-grid [data-collection^="aPLuxMood"]').length === 2`,
      5000,
    );
    assert.equal(await browser.eval(`location.hash`), '#/mood/lofi%20chill');
    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── H2a. the artist page ────────────────────────────────────────────────
// Checking out an artist is a different question from playing a track: what
// are their popular songs, what did they release, and who is filed next to
// them. The search answer is where that starts.

test('H2a: search offers the artist, and their page lists songs, releases and neighbours', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'search' }, async (ctx) => {
    await browser.eval(`(() => {
      const i = document.querySelector('#primary-search');
      i.value = 'fixture artist';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await browser.waitFor(`!!document.querySelector('#search-results .artist-chip')`, 6000);

    const chip = await browser.eval(`(() => {
      const c = document.querySelector('#search-results .artist-chip');
      return { text: c.textContent.replace(/\\s+/g, ' ').trim(), action: c.dataset.action };
    })()`);
    assert.match(chip.text, /Fixture Artist One/, 'the artist is offered above the songs');
    assert.equal(chip.action, 'artist');

    // Opening an artist is the point: a song list cannot show a body of work.
    await browser.eval(`document.querySelector('#page-root .artist-chip, #search-results .artist-chip').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .artist-hero h1')`, 5000);
    const artist = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .artist-hero h1')?.textContent?.trim(),
      hash: location.hash,
      rows: document.querySelectorAll('#page-root .track-row').length,
      albums: [...document.querySelectorAll('#page-root .library-grid [data-collection^="aMPR"]')]
        .map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
      chips: document.querySelectorAll('#page-root .artist-chip').length,
      play: !!document.querySelector('#page-root [data-action="play-artist"]'),
    }))()`);
    assert.equal(artist.title, 'Fixture Artist One');
    assert.equal(artist.hash, '#/artist/UCuxFixtureArtist000000', 'an artist is a route, so back works');
    assert.ok(artist.rows >= 2, 'popular songs are listed');
    assert.ok(artist.play, 'the artist can be played from the top');
    assert.ok(artist.albums.length >= 1, 'releases are listed');
    assert.match(artist.albums[0], /Fixture Album One/);
    assert.ok(artist.chips >= 1, 'the neighbours ("fans also like") are reachable');

    // …and a release opens as an album, not as an unknown playlist.
    await browser.eval(`document.querySelector('#page-root [data-collection="aMPRuxFixtureAlbum01"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero h1')`, 5000);
    const album = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .collection-hero h1')?.textContent?.trim(),
      type: document.querySelector('#page-root .collection-type')?.textContent?.trim(),
      rows: document.querySelectorAll('#page-root .track-row').length,
      hash: location.hash,
    }))()`);
    assert.equal(album.title, 'Fixture Album One');
    assert.equal(album.type, 'Album');
    assert.equal(album.rows, 2, "the album's own track list is shown");
    assert.equal(album.hash, '#/c/aMPRuxFixtureAlbum01');

    // Back returns to the artist page from cache, without a refetch.
    await browser.eval(`document.querySelector('[data-action="back"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .artist-hero h1')`, 5000);
    assert.equal(await browser.eval(`location.hash`), '#/artist/UCuxFixtureArtist000000');
    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── H2b. a song opens its album ─────────────────────────────────────────
// The album of a song is the other half of "who is this": the row's album
// column, the track menu and the now-playing About tab all lead to the same
// release, and a track whose row does not carry an album id is resolved
// server-side instead of guessed.

test('H2b: the album column of a track row opens that release', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'search' }, async (ctx) => {
    await browser.eval(`(() => {
      const i = document.querySelector('#primary-search');
      i.value = 'fixture album';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await browser.waitFor(`!!document.querySelector('#search-results .track-row')`, 6000);

    const cell = await browser.eval(`(() => {
      const b = document.querySelector('#search-results .track-row .track-album-link');
      return b ? { tag: b.tagName, action: b.dataset.action, album: b.dataset.album, text: b.textContent.trim() } : null;
    })()`);
    assert.ok(cell, 'the album column of a catalogue row is not a link');
    assert.equal(cell.tag, 'BUTTON', 'the album cell is a real button, not a span');
    assert.equal(cell.action, 'open-album');
    assert.equal(cell.album, 'MPRuxFixtureAlbum01');
    assert.equal(cell.text, 'Fixture Album One');

    await browser.eval(`document.querySelector('#search-results .track-album-link').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero h1')`, 5000);
    const opened = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .collection-hero h1')?.textContent?.trim(),
      hash: location.hash,
    }))()`);
    assert.equal(opened.title, 'Fixture Album One');
    assert.equal(opened.hash, '#/c/aMPRuxFixtureAlbum01');
    assert.deepEqual(await ctx.errors(), []);
  });
});

test('H2c: a track with no album id still finds its album (now-playing About)', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'playlist', playlistId: PLAYLIST.id }, async (ctx) => {
    // The seeded track carries no album metadata at all, which is exactly the
    // case the server-side lookup exists for.
    await startTrack(browser);
    await openNowPlaying(browser);
    await browser.eval(`document.querySelector('#now-content [data-overlay-tab="details"]').click()`);
    await browser.waitFor(`!!document.querySelector('#now-content .detail-link[data-action="open-album"]')`, 5000);

    const before = await browser.eval(`(() => {
      const b = document.querySelector('#now-content .detail-link[data-action="open-album"]');
      return { text: b.textContent.trim(), album: b.dataset.album ?? null };
    })()`);
    assert.equal(before.album, null, 'this row has no album id to use directly');

    await browser.eval(`document.querySelector('#now-content .detail-link[data-action="open-album"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero h1')`, 8000);
    // The sheet closes on an exit animation, so `hidden` lands ~180ms after the
    // route changes. Waiting for it asserts the intent without racing the CSS.
    await browser.waitFor(`document.getElementById('now-overlay').hidden`, 3000);
    const opened = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .collection-hero h1')?.textContent?.trim(),
      hash: location.hash,
      overlayHidden: document.getElementById('now-overlay').hidden,
    }))()`);
    assert.equal(opened.title, 'Fixture Album One', 'the resolved album is the one that opened');
    assert.equal(opened.hash, '#/c/aMPRuxFixtureAlbum01');
    assert.equal(opened.overlayHidden, true, 'the sheet closes when it navigates');
    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── H3. the pinned personal station + "less like this" ──────────────────
// The station is the one surface that is always "yours", so it is pinned in the
// sidebar under the account's own name, and every song carries a dislike button
// that reaches the server.

test('H3: the station is pinned, named after the user, and dislikes stick', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'home' }, async (ctx) => {
    // Pinned in the sidebar, labelled with the account's name.
    const pin = await browser.eval(`(() => {
      const b = document.querySelector('#nav-station');
      return b ? { text: b.textContent.trim(), page: b.dataset.page } : null;
    })()`);
    assert.ok(pin, 'the station is not pinned in the sidebar');
    assert.match(pin.text, /station$/, 'the pinned entry is named "…station"');
    assert.equal(pin.page, 'station');

    // Reachable from the home page too — that is the mobile entry point.
    await browser.eval(`document.querySelector('#page-root [data-page="station"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root .station-hero')`, 8000);

    const station = await browser.eval(`(() => ({
      title: document.querySelector('#page-root .page-title')?.textContent?.trim(),
      hash: location.hash,
      blurb: document.querySelector('#page-root .station-hero h2')?.textContent?.trim(),
      rows: document.querySelectorAll('#page-root .track-row').length,
      seeds: document.querySelectorAll('#page-root .station-seeds strong').length,
      navActive: document.querySelector('#nav-station')?.getAttribute('aria-current'),
    }))()`);
    assert.match(station.title ?? '', /station\.$/, 'the page is titled after its owner');
    assert.equal(station.hash, '#/station');
    assert.match(station.blurb ?? '', /played through|liked/, 'the station says why it exists');
    assert.equal(station.rows, 2, 'the station queue is listed');
    assert.equal(station.seeds, 2, 'the seeds behind it are shown');
    assert.equal(station.navActive, 'page', 'the pinned entry marks itself current');

    // Every song has a dislike button, and it reaches the server.
    const before = await browser.eval(`document.querySelectorAll('#page-root [data-action="dislike"]').length`);
    assert.equal(before, 2, 'one dislike button per song');

    await browser.eval(`document.querySelector('#page-root .track-row [data-action="dislike"]').click()`);
    await browser.waitFor(`window.__ux.dislikes.length === 1`, 5000);
    const after = await browser.eval(`(() => ({
      disliked: window.__ux.dislikes.slice(),
      pressed: document.querySelector('#page-root [data-action="dislike"]')?.getAttribute('aria-pressed'),
      label: document.querySelector('#page-root [data-action="dislike"]')?.getAttribute('aria-label'),
      toast: document.querySelector('#toast-text')?.textContent ?? '',
    }))()`);
    assert.deepEqual(after.disliked, ['dQw4w9WgXcQ'], 'the dislike reached the server');
    assert.equal(after.pressed, 'true', 'the button reports its state');
    assert.match(after.label ?? '', /undo/i, 'a pressed dislike offers to undo itself');
    assert.match(after.toast, /less|fewer/i, 'the user is told what happened');

    // It is a toggle: pressing again restores the track.
    await browser.eval(`document.querySelector('#page-root [data-action="dislike"]').click()`);
    await browser.waitFor(`window.__ux.dislikes.length === 0`, 5000);
    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── H4. the station is endless ──────────────────────────────────────────
// The station used to be a fixed queue that looped. It must instead keep
// generating: the queue is topped up from /api/station/next without the
// listener asking, each page excludes everything already delivered, and the
// station page shows the live queue growing. Driven in a real browser because
// the whole behaviour lives in the client's playback state machine — the
// server-side contract is pinned in test/station-endless.test.js.

test('H4: playing the station keeps generating new tracks instead of looping', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'station' }, async (ctx) => {
    // The hero's own controls must actually start the station. They used to
    // emit a collection action with no collection, which toasted
    // "This collection is empty." and played nothing.
    const actions = await browser.eval(`[...document.querySelectorAll('#page-root .station-hero-actions button')]
      .map((b) => b.dataset.action)`);
    assert.deepEqual(actions, ['play-station', 'shuffle-station'],
      'the station page must start the station, not a collection');

    await browser.eval(`document.querySelector('#page-root .station-hero-actions .play-btn').click()`);
    await browser.waitFor(`!!document.querySelector('#player .player-song-meta strong')`, 5000);

    const started = await browser.eval(`({
      title: document.querySelector('#player .player-song-meta strong')?.textContent,
      toast: document.querySelector('#toast-text')?.textContent ?? '',
    })`);
    assert.equal(started.title, 'UX Fixture Track', 'the station started playing');
    assert.match(started.toast, /never (ends|runs out)/, 'the station says it is endless');

    // No click, no prompt: starting the station must already be fetching the
    // next page, because the first one is only 30 songs long.
    await browser.waitFor(`window.__ux.stationNext.length >= 1`, 5000);
    const first = await browser.eval(`window.__ux.stationNext[0]`);
    assert.equal(first.cursor, 3, 'the extension starts where the first page ended');
    for (const id of ['dQw4w9WgXcQ', 'fAuT8_dboWo']) {
      assert.ok(first.exclude.includes(id), `the queue's own ${id} must be excluded`);
    }

    // The page lists the live queue, so the appended page is visible as rows.
    await browser.waitFor(`document.querySelectorAll('#page-root .track-row').length > 2`, 5000);
    const grown = await browser.eval(`document.querySelectorAll('#page-root .track-row').length`);
    assert.equal(grown, 5, 'two fixture songs plus the three-track extension');

    // Advance through the queue: it must keep growing rather than wrap back to
    // the first fixture track, which is what "finite station" looked like.
    for (let i = 0; i < 4; i++) {
      await browser.eval(`document.querySelector('#player .player-controls [data-action="next"]').click()`);
      await new Promise((r) => setTimeout(r, 120));
    }
    await browser.waitFor(`window.__ux.stationNext.length >= 2`, 5000);

    const after = await browser.eval(`({
      titles: [...document.querySelectorAll('#page-root .track-name')].map((x) => x.textContent),
      rows: document.querySelectorAll('#page-root .track-row').length,
      playing: document.querySelector('#player .player-song-meta strong')?.textContent,
      calls: window.__ux.stationNext.length,
    })`);
    assert.ok(after.rows > grown, `the queue kept growing (${grown} -> ${after.rows})`);
    assert.ok(after.calls >= 2, 'a second page was fetched as the runway ran low');
    assert.equal(new Set(after.titles).size, after.titles.length, 'no song appears twice in the queue');
    assert.match(after.playing ?? '', /Station Page|UX Fixture/, 'playback continued into the generated part');
    assert.deepEqual(await ctx.errors(), []);
  });
});

test('H4b: a normal playlist never asks the station for more', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'playlist', playlistId: PLAYLIST.id }, async (ctx) => {
    // The collection route renders a skeleton first; on a loaded machine that
    // outlives the harness's own settle window, so wait for the real control.
    await browser.waitFor(`!!document.querySelector('#page-root .collection-actions .play-btn')`, 15_000);
    await click(browser, '#page-root .collection-actions .play-btn', 'play the playlist');
    await browser.waitFor(`!!document.querySelector('#player .player-song-meta strong')`, 5000);
    // A queue that is not the station must not spawn background requests: the
    // extension is a station property, not a global "play more" switch.
    for (let i = 0; i < 3; i++) {
      await browser.eval(`document.querySelector('#player .player-controls [data-action="next"]').click()`);
      await new Promise((r) => setTimeout(r, 80));
    }
    const calls = await browser.eval(`window.__ux.stationNext.length`);
    assert.equal(calls, 0, 'playing a playlist must not extend the station');
    assert.deepEqual(await ctx.errors(), []);
  });
});

// ── I. skeletons ─────────────────────────────────────────────────────────

async function pollSkeleton(browser, ms = 600) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await browser.eval(`(() => {
      const root = document.getElementById('page-root');
      const visibleLoading = [...root.querySelectorAll('*')].some((el) => {
        if (el.children.length) return false;
        if (!/Loading(\\.\\.\\.|…)?/.test(el.textContent)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      });
      return {
        sk: root.querySelectorAll('.sk').length,
        skeleton: root.querySelectorAll('.skeleton').length,
        loadingText: visibleLoading,
        text: root.innerText.replace(/\\s+/g, ' ').slice(0, 160),
        html: root.innerHTML.replace(/\\s+/g, ' ').slice(0, 240),
      };
    })()`);
    if (last.sk > 0) return last;
    await new Promise((r) => setTimeout(r, 30));
  }
  return last;
}

test('I: library and collection loads show a .sk skeleton, not bare "Loading…" text', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'library' }, async () => {
    await browser.eval(`window.__ux.delays.albums = 600`);
    await browser.eval(`document.querySelector('#page-root [data-library-tab="Albums"]').click()`);
    const albums = await pollSkeleton(browser, 600);
    assert.ok(albums.sk > 0,
      `no .sk skeleton exists while the Albums request is in flight (found ${albums.skeleton} .skeleton element(s)). `
      + `Loading markup: ${JSON.stringify(albums.html)}`);
    assert.ok(!albums.loadingText,
      `the in-flight state still shows bare "Loading…" copy instead of a skeleton: ${JSON.stringify(albums.text)}`);
    await browser.waitFor(`!document.querySelector('#page-root .sk')`, 5000).catch(() => {});

    await browser.eval(`window.__ux.delays.playlist = 600`);
    await browser.eval(`document.querySelector('#page-root [data-library-tab="Playlists"]').click()`);
    await browser.waitFor(`!!document.querySelector('#page-root [data-collection="p${PLAYLIST.id}"]')`, 5000);
    await browser.eval(`document.querySelector('#page-root [data-collection="p${PLAYLIST.id}"]').click()`);
    const collection = await pollSkeleton(browser, 600);
    assert.ok(collection.sk > 0,
      `no .sk skeleton exists while a playlist collection is loading (found ${collection.skeleton} .skeleton element(s)). `
      + `Loading markup: ${JSON.stringify(collection.html)}`);
    assert.ok(!collection.loadingText,
      `the in-flight collection still shows bare "Loading…" copy instead of a skeleton: ${JSON.stringify(collection.text)}`);
  });
});

// ── J. deep links / history ──────────────────────────────────────────────

test('J: navigation updates the URL, and history.back() returns to the previous in-app page', async (t) => {
  if (!needBrowser(t)) return;

  await withPage(browser, BASE, { viewport: VIEW.mobile390 }, async () => {
    await browser.eval(`window.__ux.marker = 1; window.__ux.homeUrl = location.href`);

    await nav(browser, 'library');
    const homeUrl = await browser.eval(`window.__ux.homeUrl`);
    const libraryUrl = await browser.eval(`location.href`);
    assert.notEqual(libraryUrl, homeUrl,
      `navigating home → library did not change the URL (still ${libraryUrl}); internal navigation must pushState`);

    // Open the seeded playlist. Clicking is shared with normal use, so a dead
    // route handler is caught here rather than assumed.
    const hasLink = await browser.eval(`!!document.querySelector('#page-root [data-collection="p${PLAYLIST.id}"], #side-playlists [data-collection="p${PLAYLIST.id}"]')`);
    assert.ok(hasLink, `no link to the seeded playlist "p${PLAYLIST.id}" exists on the library page`);
    await browser.eval(`document.querySelector('#page-root [data-collection="p${PLAYLIST.id}"], #side-playlists [data-collection="p${PLAYLIST.id}"]').click()`);
    await browser.waitFor(`location.href !== ${JSON.stringify(libraryUrl)}`, 3000).catch(() => {});
    const collectionUrl = await browser.eval(`location.href`);
    assert.notEqual(collectionUrl, libraryUrl,
      `opening a playlist collection did not change the URL (still ${collectionUrl}); collections need their own history entry`);

    await browser.eval(`history.back()`);
    await browser.waitFor(
      `window.__ux.marker === 1 && location.href === ${JSON.stringify(libraryUrl)}`,
      5000,
    ).catch(() => {});
    const after = await browser.eval(`({
      url: location.href,
      marker: window.__ux.marker ?? null,
      libraryVisible: !!document.querySelector('#page-root [data-library-tab]'),
      appMounted: !!document.querySelector('.app'),
    })`);
    assert.equal(after.marker, 1,
      'history.back() reloaded the document (the SPA marker is gone) — it left the app instead of routing');
    assert.equal(after.url, libraryUrl,
      `history.back() did not return to the library URL ${libraryUrl} (landed on ${after.url})`);
    assert.ok(after.libraryVisible, 'history.back() did not restore the library page content');
  });
});

// ── K. resume across reloads and devices ─────────────────────────────────

test('K: a saved session resumes at the saved playhead and can take over from another device', async (t) => {
  if (!needBrowser(t)) return;

  await seedPlayerState(BASE, {
    queue: [SEED_TRACK],
    index: 0,
    positionMs: 61_000,
    source: 'home',
    station: false,
    deviceId: 'phone-seed-0001',
    deviceName: 'iPhone',
    playing: true,
  });

  await withPage(browser, BASE, { viewport: VIEW.mobile390, page: 'home' }, async () => {
    const ui = await browser.eval(`(() => ({
      title: document.querySelector('#player .player-song-meta strong')?.textContent,
      meta: document.querySelector('#player .player-song-meta > span')?.textContent,
      hero: document.querySelector('.hero-content')?.innerText.replace(/\\s+/g, ' '),
      button: document.querySelector('[data-action="play-featured"]')?.textContent.trim(),
    }))()`);
    assert.equal(ui.title, SEED_TRACK.title, 'the saved track is restored into the player bar');
    assert.match(ui.meta, /resumes at 1:01/, 'the saved playhead is visible before pressing play');
    assert.match(ui.hero, /FROM YOUR IPHONE/i, 'the hero names the device the session came from');
    assert.equal(ui.button, 'Continue here', 'the hero offers a cross-device continue');

    // Record the next session save so the takeover flag is observable.
    await browser.eval(`(() => {
      window.__nowPuts = [];
      const orig = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url;
        if (String(url).includes('/api/now') && String(init?.method || '').toUpperCase() === 'PUT') {
          try { window.__nowPuts.push(JSON.parse(init.body)); } catch {}
        }
        return orig(input, init);
      };
      return 1;
    })()`);

    await browser.eval(`document.querySelector('#player [data-action="playpause"]').click()`);
    // The harness stubs media playback, so deliver the event the real element
    // would: this is what applies the saved position and saves the session.
    await browser.eval(`(() => {
      const a = document.getElementById('audio');
      let t = 0;
      Object.defineProperty(a, 'duration', { configurable: true, get: () => 214 });
      Object.defineProperty(a, 'currentTime', { configurable: true, get: () => t, set: (v) => { t = v; } });
      a.dispatchEvent(new Event('playing'));
      return a.currentTime;
    })()`);

    const pos = await browser.eval(`document.getElementById('audio').currentTime`);
    assert.equal(pos, 61, 'pressing play seeks to the saved position instead of restarting');

    await browser.waitFor(`(window.__nowPuts || []).length > 0`, 10_000);
    const put = await browser.eval(`window.__nowPuts[0]`);
    assert.ok(put.deviceId && put.deviceId.length >= 8, 'the save names this device');
    assert.equal(put.takeover, true, 'a user play claims the session from the other device');
    assert.equal(put.positionMs, 61_000, 'the resumed position is what gets stored');

    // ── the other device wins the next save ──
    // The server answers 409 with the winning state. The loser must mirror it
    // and stop writing instead of ping-ponging the playhead every five seconds.
    const remote = {
      tracks: [{ videoId: 'fAuT8_dboWo', title: 'Handoff Track', channel: 'Other Device', thumb: null, durationS: 180 }],
      index: 0, positionMs: 90_000, station: false,
      deviceId: 'laptop-remote', deviceName: 'Mac', playing: true,
    };
    await browser.eval(`(() => {
      const orig = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url;
        if (String(url).includes('/api/now') && String(init?.method || '').toUpperCase() === 'PUT') {
          return Promise.resolve(new Response(
            JSON.stringify({ error: 'Another device is playing.', state: ${JSON.stringify(remote)}, updatedAt: 123 }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ));
        }
        return orig(input, init);
      };
      return 1;
    })()`);
    await browser.eval(`document.getElementById('audio').dispatchEvent(new Event('playing'))`);
    await browser.waitFor(`document.querySelector('#player .player-song-meta strong')?.textContent === 'Handoff Track'`, 10_000);

    const handoff = await browser.eval(`({
      title: document.querySelector('#player .player-song-meta strong')?.textContent,
      meta: document.querySelector('#player .player-song-meta > span')?.textContent,
      hero: document.querySelector('.hero-content')?.innerText.replace(/\\s+/g, ' '),
      toast: document.getElementById('toast-text')?.textContent,
    })`);
    assert.equal(handoff.title, 'Handoff Track', 'the losing device mirrors the winning queue');
    assert.match(handoff.meta, /resumes at 1:30/, 'and the winning playhead');
    assert.match(handoff.hero, /FROM YOUR MAC/i, 'the hero names the new owner');
    assert.equal(handoff.toast, 'Picked up on your Mac', 'the hand-off is announced, not silent');
  });
});

// ── app-shell defects (see .audit/frontend-ux.md) ────────────────────────
//
// Each of these pins a bug that was visible in a real browser: a double boot,
// a skeleton that never clears, a stale response painting the wrong page, lost
// focus/scroll, a silent failure. The instrumentation is installed as an init
// script per test and disposed before the next navigation.

const UX_TRACKS = [
  { videoId: 'uxt00000001', title: 'UX Order One', channel: 'UX Channel', durationS: 200, thumb: null },
  { videoId: 'uxt00000002', title: 'UX Order Two', channel: 'UX Channel', durationS: 201, thumb: null },
  { videoId: 'uxt00000003', title: 'UX Order Three', channel: 'UX Channel', durationS: 202, thumb: null },
];

/** Create a playlist with real tracks through the API the app itself uses. */
async function makePlaylist(title, tracks) {
  return browser.eval(`(async () => {
    const create = await fetch('/api/playlists', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: ${JSON.stringify(title)} }) }).then((r) => r.json());
    for (const t of ${JSON.stringify(tracks)}) {
      await fetch('/api/playlists/' + create.playlist.id + '/tracks', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
    }
    return create.playlist.id;
  })()`);
}

const titleOf = () => browser.eval(`document.querySelector('#player .player-song-meta strong')?.textContent`);
const playingUI = () => browser.waitFor(
  `document.querySelector('#player .main-toggle')?.getAttribute('aria-label') === 'Pause'`, 5000);

test('L: boot runs once per load — no duplicated requests, renders or restores', async (t) => {
  if (!needBrowser(t)) return;
  const dispose = await browser.addInitScript(`(() => {
    const counts = {};
    window.__bootCounts = counts;
    const prev = window.fetch;
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      try { const u = new URL(raw, location.href); if (u.pathname.startsWith('/api/')) counts[u.pathname] = (counts[u.pathname] || 0) + 1; } catch {}
      return prev(input, init);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.mobile390 }, async () => {
      // boot's tail (station, status, room) is fire-and-forget; let it land.
      await new Promise((r) => setTimeout(r, 1500));
      const counts = await browser.eval(`window.__bootCounts`);
      // /api/me is also read by the notifications module, so it is not a boot
      // fingerprint; these five are only ever fetched by boot.
      for (const path of ['/api/likes', '/api/dislikes', '/api/playlists', '/api/recent', '/api/now']) {
        assert.equal(counts[path] ?? 0, 1,
          `${path} was requested ${counts[path] ?? 0} times during one boot; boot() must run once`);
      }
    });
  } finally {
    await dispose();
  }
});

test('M: one failing boot request still paints the app instead of a frozen skeleton', async (t) => {
  if (!needBrowser(t)) return;
  const dispose = await browser.addInitScript(`(() => {
    const prev = window.fetch;
    let failed = false;
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let u; try { u = new URL(raw, location.href); } catch { return prev(input, init); }
      if (u.pathname === '/api/likes' && !failed) {
        failed = true;
        return Promise.resolve(new Response(JSON.stringify({ error: 'likes are down' }),
          { status: 500, headers: { 'content-type': 'application/json' } }));
      }
      return prev(input, init);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.mobile390 }, async () => {
      await browser.waitFor(`!!document.querySelector('#page-root .page-title')`, 6000).catch(() => {});
      assert.ok(await browser.eval(`!!document.querySelector('#page-root .page-title')`),
        'a 500 on /api/likes aborted boot and left the index.html skeleton on screen');
      assert.equal(await browser.eval(`document.querySelectorAll('#page-root .sk').length`), 0,
        'the boot skeleton is still painted after the failing request');
      assert.ok(await browser.eval(`!!document.querySelector('#mobile-nav [data-page="library"]')`),
        'the shell is not navigable after a partial boot');
    });
  } finally {
    await dispose();
  }
});

test('N: a slow collection answer cannot paint over the page opened after it', async (t) => {
  if (!needBrowser(t)) return;
  const a = await makePlaylist(`Slow Collection ${Date.now().toString(36)}`, [UX_TRACKS[0]]);
  const b = await makePlaylist(`Fast Collection ${Date.now().toString(36)}`, [UX_TRACKS[1]]);
  const aTitle = await browser.eval(`fetch('/api/playlists/${a}').then((r) => r.json()).then((x) => x.playlist.title)`);
  const bTitle = await browser.eval(`fetch('/api/playlists/${b}').then((r) => r.json()).then((x) => x.playlist.title)`);

  // Delay the *first* playlist read only, so A lands after B.
  const dispose = await browser.addInitScript(`(() => {
    const prev = window.fetch;
    let delayed = false;
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let u; try { u = new URL(raw, location.href); } catch { return prev(input, init); }
      if (!delayed && /^\\/api\\/playlists\\/\\d+$/.test(u.pathname)
        && String(init?.method || 'GET').toUpperCase() === 'GET') {
        delayed = true;
        await new Promise((r) => setTimeout(r, 1200));
      }
      return prev(input, init);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'library' }, async () => {
      // Open A (slow), then B from the sidebar while A is still in flight.
      await browser.eval(`document.querySelector('#page-root [data-collection="p${a}"]').click()`);
      await browser.waitFor(`!!document.querySelector('#side-playlists [data-collection="p${b}"]')`, 4000);
      await browser.eval(`document.querySelector('#side-playlists [data-collection="p${b}"]').click()`);
      await browser.waitFor(`document.querySelector('#page-root .collection-hero h1')?.textContent === ${JSON.stringify(bTitle)}`, 6000);

      // Let A's late answer land, then force a repaint from state (the queue
      // menu renders the page again — the corruption used to show up there).
      await new Promise((r) => setTimeout(r, 1500));
      await browser.eval(`(() => {
        const row = document.querySelector('#page-root .track-row[data-track="${UX_TRACKS[1].videoId}"]');
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 20 }));
        return true;
      })()`);
      await browser.waitFor(`!document.getElementById('context-menu').hidden`, 4000);
      await browser.eval(`document.querySelector('#context-menu [data-menu-action="next"]').click()`);
      await new Promise((r) => setTimeout(r, 250));

      const page = await browser.eval(`({
        hero: document.querySelector('#page-root .collection-hero h1')?.textContent,
        rows: [...document.querySelectorAll('#page-root .track-row[data-track]')].map((r) => r.dataset.track),
        title: document.title,
        hash: location.hash,
      })`);
      assert.equal(page.hero, bTitle,
        `a slow playlist answer overwrote the newer page (hero is "${page.hero}", expected "${bTitle}" after A="${aTitle}")`);
      assert.deepEqual(page.rows, [UX_TRACKS[1].videoId],
        'the repainted page shows the wrong collection\'s tracks');
      assert.match(page.title, new RegExp(bTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(page.hash, `#/c/p${b}`);
    });
  } finally {
    await dispose();
  }
});

test('O: a slow search failure cannot wipe the newer query\'s results', async (t) => {
  if (!needBrowser(t)) return;
  const dispose = await browser.addInitScript(`(() => {
    const prev = window.fetch;
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let u; try { u = new URL(raw, location.href); } catch { return prev(input, init); }
      if (u.pathname === '/api/search' && u.searchParams.get('q') === 'slow query') {
        await new Promise((r) => setTimeout(r, 900));
        return new Response(JSON.stringify({ error: 'Search is unavailable.' }),
          { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return prev(input, init);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'search' }, async () => {
      const type = (q) => browser.eval(`(() => {
        const input = document.getElementById('primary-search');
        input.value = ${JSON.stringify(q)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await type('slow query');
      // The debounce fires at 380 ms; make sure the slow request is in flight
      // before typing over it.
      await new Promise((r) => setTimeout(r, 500));
      await type('fixture album');
      await browser.waitFor(`document.querySelectorAll('#page-root .track-row[data-track]').length >= 1`, 6000);

      // Let the first query's delayed 500 land.
      await new Promise((r) => setTimeout(r, 1300));
      const after = await browser.eval(`({
        rows: [...document.querySelectorAll('#page-root .track-row[data-track]')].map((r) => r.dataset.track),
        text: document.getElementById('page-root').innerText,
        toast: document.getElementById('toast-text')?.textContent || '',
      })`);
      assert.deepEqual(after.rows, [SEED_TRACK.videoId],
        'the newer query\'s result was cleared by the older query\'s failure');
      assert.doesNotMatch(after.text, /No match for/i,
        'the newer query was labelled "No match" because an older one failed');
      assert.doesNotMatch(after.toast, /unavailable/i,
        'a stale search failure raised an error toast for the query that succeeded');
    });
  } finally {
    await dispose();
  }
});

test('P: a repaint keeps keyboard focus on the control that caused it', async (t) => {
  if (!needBrowser(t)) return;
  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'library' }, async () => {
    // A library tab re-renders the whole page.
    const activated = await browser.eval(`(() => {
      const tab = document.querySelector('#page-root [data-library-tab="Albums"]');
      if (!tab) return false;
      tab.focus({ focusVisible: true });
      tab.click();
      return true;
    })()`);
    assert.ok(activated, 'the library rendered no Albums tab');
    await browser.waitFor(`document.querySelector('#page-root [data-library-tab="Albums"]')?.getAttribute('aria-selected') === 'true'`, 4000);
    assert.equal(await browser.eval(`document.activeElement?.getAttribute?.('data-library-tab')`), 'Albums',
      're-rendering the library dropped focus to <body> (Tab restarts at the top)');

    // The player bar is rebuilt on every playback change; start a real track
    // from its collection first.
    await nav(browser, 'playlist', { playlistId: PLAYLIST.id });
    await startTrack(browser);
    await browser.eval(`(() => {
      const next = document.querySelector('#player [data-action="next"]');
      next.focus({ focusVisible: true });
      next.click();
      return true;
    })()`);
    await browser.waitFor(`document.getElementById('player').classList.contains('is-playing')`, 3000).catch(() => {});
    const after = await browser.eval(`(() => {
      const a = document.activeElement;
      return { action: a?.getAttribute?.('data-action'), inPlayer: !!a?.closest?.('#player') };
    })()`);
    assert.equal(after.action, 'next', 'pressing next moved focus to <body> during the repaint');
    assert.equal(after.inPlayer, true, 'focus was restored outside the player bar');
  });
});

test('Q: Back restores the scroll position of the page being returned to', async (t) => {
  if (!needBrowser(t)) return;
  await withPage(browser, BASE, { viewport: VIEW.desktop }, async () => {
    const set = await browser.eval(`(() => {
      const main = document.getElementById('main-scroll');
      main.scrollTop = 420;
      return main.scrollTop;
    })()`);
    assert.ok(set >= 300, `the home page is not tall enough to scroll (scrollTop ${set})`);
    await nav(browser, 'library');
    assert.equal(await browser.eval(`document.getElementById('main-scroll').scrollTop`), 0,
      'a fresh navigation must start at the top');
    await browser.eval(`history.back()`);
    await browser.waitFor(`!!document.querySelector('#page-root .page-title')`, 5000);
    await new Promise((r) => setTimeout(r, 350));
    const restored = await browser.eval(`document.getElementById('main-scroll').scrollTop`);
    assert.ok(restored >= 300, `Back returned to the top of the page (scrollTop ${restored}, expected ~${set})`);
  });
});

test('R: activating the page you are already on does not push a duplicate history entry', async (t) => {
  if (!needBrowser(t)) return;
  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'library' }, async () => {
    const before = await browser.eval(`history.length`);
    await browser.eval(`document.querySelector('#desktop-nav [data-page="library"]').click()`);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await browser.eval(`history.length`), before,
      'clicking the current nav item pushed a duplicate entry (in-app Back then looks dead once)');
  });
});

test('S: a failing action reports instead of doing nothing', async (t) => {
  if (!needBrowser(t)) return;
  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'playlist', playlistId: PLAYLIST.id }, async () => {
    // The collection page's own read succeeded above; fail the next one, which
    // is what "Play all" does before it can start anything.
    await browser.eval(`(() => {
      const orig = window.fetch;
      let fail = true;
      window.fetch = (input, init) => {
        const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
        let u; try { u = new URL(raw, location.href); } catch { return orig(input, init); }
        if (fail && /^\\/api\\/playlists\\/\\d+$/.test(u.pathname)) {
          fail = false;
          return Promise.resolve(new Response(JSON.stringify({ error: 'Playlist is unreadable.' }),
            { status: 500, headers: { 'content-type': 'application/json' } }));
        }
        return orig(input, init);
      };
      window.__ux.errors.length = 0;
      return true;
    })()`);
    await browser.waitFor(`!!document.querySelector('#page-root [data-action="play-collection"]')`, 8000);
    await browser.eval(`document.querySelector('#page-root [data-action="play-collection"]').click()`);
    await browser.waitFor(`/unreadable/i.test(document.getElementById('toast-text')?.textContent || '')`, 5000)
      .catch(() => {});
    assert.match(await browser.eval(`document.getElementById('toast-text')?.textContent || ''`), /unreadable/i,
      'a rejected action was silent: no toast, no feedback, only an unhandled rejection');
  });
});

test('T: tapping the sheet scrim closes through the normal path (focus returns)', async (t) => {
  if (!needBrowser(t)) return;
  await withPage(browser, BASE, { viewport: VIEW.desktop }, async () => {
    await startTrack(browser);
    await openNowPlaying(browser);
    const trigger = await browser.eval(`(() => { window.__scrim = window.__uxTrigger; return !!window.__scrim; })()`);
    assert.equal(trigger, true);
    await browser.eval(`document.getElementById('now-overlay').click()`);
    await browser.waitFor(`document.getElementById('now-overlay').hidden === true`, 2000);
    assert.equal(await browser.eval(`document.activeElement === window.__scrim`), true,
      'dismissing the sheet by tapping the scrim lost focus instead of returning it to the trigger');
  });
});

test('U: the hero caption never cuts an HTML entity in half', async (t) => {
  if (!needBrowser(t)) return;
  const title = 'Rock & Roll Highway Star Party & More Stuff';
  await seedPlayerState(BASE, {
    queue: [{ videoId: 'uxt00000009', title, channel: 'UX Channel', thumb: null, durationS: 200 }],
    index: 0, positionMs: 0, source: 'home', deviceId: 'hero-entity-device', playing: false,
  });
  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'home' }, async () => {
    const meta = await browser.eval(`document.querySelector('.hero-meta')?.textContent || ''`);
    assert.ok(meta.length > 0, 'the hero rendered no caption');
    assert.doesNotMatch(meta, /&(amp|lt|gt|quot|#\d+);?/, `the caption shows a broken entity: "${meta}"`);
    assert.ok(meta.length <= title.length && !/&am$/.test(meta), `the caption is malformed: "${meta}"`);
  });
});

test('V: an unexpected API shape degrades instead of blanking every render', async (t) => {
  if (!needBrowser(t)) return;
  const dispose = await browser.addInitScript(`(() => {
    const prev = window.fetch;
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let u; try { u = new URL(raw, location.href); } catch { return prev(input, init); }
      const nullShape = (body) => Promise.resolve(new Response(JSON.stringify(body),
        { status: 200, headers: { 'content-type': 'application/json' } }));
      if (u.pathname === '/api/likes') return nullShape({ tracks: null });
      if (u.pathname === '/api/dislikes') return nullShape({ tracks: null });
      if (u.pathname === '/api/playlists') return nullShape({ playlists: null });
      if (u.pathname === '/api/now') return nullShape({ state: null, updatedAt: null });
      return prev(input, init);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.desktop }, async () => {
      await browser.waitFor(`!!document.querySelector('#page-root .page-title')`, 6000).catch(() => {});
      assert.ok(await browser.eval(`!!document.querySelector('#page-root .page-title')`),
        'null lists from the API left the page blank (render threw on .map of undefined)');
      // And the shell is still usable: opening the library renders.
      await nav(browser, 'library');
      await browser.waitFor(`!!document.querySelector('#page-root [data-library-tab]')`, 5000);
      assert.ok(await browser.eval(`!!document.querySelector('#page-root [data-library-tab]')`),
        'the library page cannot render after a null playlists answer');
    });
  } finally {
    await dispose();
  }
});

test('W: leaving Search cancels the pending debounced query', async (t) => {
  if (!needBrowser(t)) return;
  const dispose = await browser.addInitScript(`(() => {
    window.__searchCalls = [];
    const prev = window.fetch;
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      try { const u = new URL(raw, location.href); if (u.pathname === '/api/search') window.__searchCalls.push(u.searchParams.get('q')); } catch {}
      return prev(input, init);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'search' }, async () => {
      await browser.eval(`(() => {
        const input = document.getElementById('primary-search');
        input.value = 'typed then abandoned';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      // Navigate away inside the 380 ms debounce window.
      await nav(browser, 'library');
      await new Promise((r) => setTimeout(r, 900));
      assert.deepEqual(await browser.eval(`window.__searchCalls`), [],
        'a debounced search fired after the page was left (its failure would toast on the new page)');
    });
  } finally {
    await dispose();
  }
});

test('X: dragging the volume slider persists once, not on every input event', async (t) => {
  if (!needBrowser(t)) return;
  const dispose = await browser.addInitScript(`(() => {
    const orig = Storage.prototype.setItem;
    window.__storageWrites = [];
    Storage.prototype.setItem = function (key, value) {
      window.__storageWrites.push(key);
      return orig.call(this, key, value);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.desktop }, async () => {
      await browser.waitFor(`!!document.querySelector('#player input[data-slider="volume"]')`, 5000);
      await browser.eval(`(() => {
        const input = document.querySelector('#player input[data-slider="volume"]');
        window.__storageWrites.length = 0;
        for (let v = 10; v <= 60; v += 5) {
          input.value = String(v);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 350));
      const writes = await browser.eval(`window.__storageWrites.filter((k) => k === 'sonora.volume').length`);
      assert.ok(writes <= 2, `a volume drag wrote localStorage ${writes} times in 11 input events`);
      assert.equal(await browser.eval(`localStorage.getItem('sonora.volume')`), '0.6',
        'the settled volume was not persisted');
    });
  } finally {
    await dispose();
  }
});

test('Y: an automatic track change is announced to screen readers', async (t) => {
  if (!needBrowser(t)) return;
  const list = await makePlaylist(`Announce List ${Date.now().toString(36)}`, UX_TRACKS);
  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'playlist', playlistId: list }, async () => {
    await browser.waitFor(`document.querySelectorAll('#page-root .track-row[data-track]').length >= 3`, 8000);
    await browser.eval(`document.querySelectorAll('#page-root .track-row[data-track]')[0].click()`);
    await playingUI();
    await browser.waitFor(`document.getElementById('np-announcer')?.textContent.includes('UX Order One')`, 4000)
      .catch(() => {});
    const first = await browser.eval(`(() => {
      const el = document.getElementById('np-announcer');
      return el && { live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic'), text: el.textContent };
    })()`);
    assert.ok(first, 'no now-playing live region exists');
    assert.equal(first.live, 'polite');
    assert.equal(first.atomic, 'true');
    assert.match(first.text, /UX Order One/);

    await browser.eval(`document.querySelector('#player [data-action="next"]').click()`);
    await browser.waitFor(`document.getElementById('np-announcer')?.textContent.includes('UX Order Two')`, 4000)
      .catch(() => {});
    assert.match(await browser.eval(`document.getElementById('np-announcer')?.textContent || ''`), /UX Order Two/,
      'advancing the queue was silent for screen readers');
  });
});

test('Z: the track menu behaves like the menu it claims to be (arrow keys)', async (t) => {
  if (!needBrowser(t)) return;
  const list = await makePlaylist(`Menu List ${Date.now().toString(36)}`, UX_TRACKS);
  await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'playlist', playlistId: list }, async () => {
    await browser.waitFor(`!!document.querySelector('#page-root .track-row[data-track="${UX_TRACKS[0].videoId}"]')`, 8000);
    await browser.eval(`(() => {
      const row = document.querySelector('#page-root .track-row[data-track="${UX_TRACKS[0].videoId}"]');
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 20 }));
      return true;
    })()`);
    await browser.waitFor(`!document.getElementById('context-menu').hidden`, 4000);
    const move = (key) => browser.eval(`(() => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
      const items = [...document.querySelectorAll('#context-menu [role="menuitem"]')];
      return items.indexOf(document.activeElement);
    })()`);
    assert.equal(await move('ArrowDown'), 1, 'ArrowDown in the track menu did not move to the next item');
    assert.equal(await move('End'), await browser.eval(`document.querySelectorAll('#context-menu [role="menuitem"]').length - 1`),
      'End did not move to the last menu item');
    assert.equal(await move('ArrowDown'), 0, 'ArrowDown on the last item did not wrap to the first');
    assert.equal(await move('ArrowUp'), await browser.eval(`document.querySelectorAll('#context-menu [role="menuitem"]').length - 1`),
      'ArrowUp on the first item did not wrap to the last');
  });
});

test('AA: a late lyrics failure cannot mark the new track as lyric-less', async (t) => {
  if (!needBrowser(t)) return;
  const list = await makePlaylist(`Lyrics List ${Date.now().toString(36)}`, UX_TRACKS);
  const dispose = await browser.addInitScript(`(() => {
    const prev = window.fetch;
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let u; try { u = new URL(raw, location.href); } catch { return prev(input, init); }
      if (u.pathname === '/api/lyrics/${UX_TRACKS[0].videoId}') {
        await new Promise((r) => setTimeout(r, 800));
        return new Response(JSON.stringify({ error: 'lyrics are down' }),
          { status: 500, headers: { 'content-type': 'application/json' } });
      }
      if (u.pathname === '/api/lyrics/${UX_TRACKS[1].videoId}') {
        return new Response(JSON.stringify({ text: 'LA LA LA' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return prev(input, init);
    };
  })()`);
  try {
    await withPage(browser, BASE, { viewport: VIEW.desktop, page: 'playlist', playlistId: list }, async () => {
      await browser.waitFor(`document.querySelectorAll('#page-root .track-row[data-track]').length >= 2`, 8000);
      await browser.eval(`document.querySelectorAll('#page-root .track-row[data-track]')[0].click()`);
      await playingUI();
      await browser.eval(`document.querySelector('#player [data-action="lyrics"]').click()`);
      await browser.waitFor(`!document.getElementById('now-overlay').hidden`, 4000);
      // Switch to the next track while the first track's lyrics are in flight.
      await browser.eval(`document.querySelector('#player [data-action="next"]').click()`);
      await browser.waitFor(`/LA LA LA/.test(document.getElementById('now-content')?.innerText || '')`, 5000);
      // Now let the previous track's failure land.
      await new Promise((r) => setTimeout(r, 1100));
      const pane = await browser.eval(`document.getElementById('now-content')?.innerText || ''`);
      assert.match(pane, /LA LA LA/, 'a late failure for the previous track wiped the new track\'s lyrics');
      assert.doesNotMatch(pane, /No lyrics for this track/i);
    });
  } finally {
    await dispose();
  }
});
