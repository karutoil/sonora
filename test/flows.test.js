// End-to-end flows for the polished UI: the parts that are only real when a
// browser drives them. These exercise the in-app sheets that replaced
// prompt()/confirm(), optimistic like state, playlist mutation, sort
// persistence, the mobile hero layout and the offline boot path.
//
// Everything runs against its own server (temp DB) with the UX harness, so it
// never touches the developer's database and never reaches YouTube.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CHROME, freePort, launch } from './helpers/cdp.js';
import {
  SHOTS, VIEW, SEED_TRACK,
  startServer, seedPlaylist, INIT_SCRIPT, withPage, nav,
} from './helpers/ux.js';

const skip = CHROME ? false : 'no Chromium found (set CHROME_BIN)';

let server;
let browser;
let seeded;

test.before(async () => {
  if (skip) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  server = await startServer();
  seeded = await seedPlaylist(server.base);
  browser = await launch(await freePort());
  await browser.addInitScript(INIT_SCRIPT);
  // Log in once: the cookie survives every navigation in this session.
  await browser.goto(`${server.base}/`);
  const status = await browser.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name:'toil',passphrase:'hunter2hunter2'})}).then(r=>r.status)`);
  assert.equal(status, 200, 'browser login failed');
});

test.after(async () => {
  browser?.close();
  await server?.stop();
});

const withApp = (opts, fn) => withPage(browser, server.base, opts, fn);

// ── creating a playlist without a native dialog ─────────────────────────

test('a playlist is created in-app: validation, then a real playlist page', { skip }, async () => {
  await withApp({ viewport: VIEW.mobile390, page: 'library' }, async (ctx) => {
    await browser.eval(`document.querySelector('[data-action="create"]').click()`);
    await browser.waitFor(`!document.querySelector('#form-overlay').hidden`);
    await browser.waitFor(`document.activeElement?.id === 'playlist-name'`);

    // The sheet is a labelled dialog and the field is focused.
    const dialog = await browser.eval(`(() => {
      const el = document.querySelector('#form-content');
      return { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'),
               label: el.getAttribute('aria-label'),
               focused: document.activeElement?.id };
    })()`);
    assert.equal(dialog.role, 'dialog');
    assert.equal(dialog.modal, 'true');
    assert.equal(dialog.label, 'Create playlist');
    assert.equal(dialog.focused, 'playlist-name');

    // Empty submit is in-app validation, not a browser tooltip.
    await browser.eval(`document.querySelector('#playlist-form').requestSubmit()`);
    await browser.waitFor(`(document.querySelector('#playlist-error')?.textContent || '').length > 0`);
    assert.match(await browser.eval(`document.querySelector('#playlist-error').textContent`), /name/i);
    assert.equal(await browser.eval(`document.activeElement.id`), 'playlist-name');

    const name = `Flow ${Date.now().toString(36)}`;
    await browser.eval(`(() => {
      const f = document.querySelector('#playlist-form');
      f.querySelector('#playlist-name').value = ${JSON.stringify(name)};
      f.querySelector('button[type="submit"]').click();
    })()`);
    await browser.waitFor(`document.querySelector('#form-overlay').hidden === true`, 8000);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero')`, 8000);
    assert.equal(await browser.eval(`document.querySelector('#page-root .collection-hero h1').textContent`), name);
    assert.match(await browser.eval('location.hash'), /^#\/c\/p\d+$/);
    assert.match(await browser.eval('document.title'), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await ctx.shot('create-playlist');
  });
});

// ── playlist mutation from a track menu ─────────────────────────────────

test('add to playlist then remove from playlist, both without a reload', { skip }, async () => {
  await withApp({ viewport: VIEW.mobile390, page: 'playlist', playlistId: seeded.id }, async () => {
    // The collection page paints a skeleton before its GET lands, so wait for
    // the real rows instead of racing the round trip.
    await browser.waitFor(`document.querySelectorAll('#page-root .track-row').length >= 1`, 8000).catch(() => {});
    const before = await browser.eval(`document.querySelectorAll('#page-root .track-row').length`);
    assert.ok(before >= 1, 'seed playlist lost its track');

    // Remove the seeded track through the row menu.
    await browser.eval(`(() => {
      const row = document.querySelector('#page-root .track-row');
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, clientX: r.left + 40, clientY: r.top + 20 }));
    })()`);
    await browser.waitFor(`!document.querySelector('#context-menu').hidden`);
    const items = await browser.eval(`document.querySelector('#context-menu').innerText`);
    assert.match(items, /Remove from playlist/);

    await browser.eval(`(() => {
      // Hold the collection reload: the confirmed DELETE must announce success
      // before this read, not after it. This used to leave an intermittent empty
      // toast under load, because row removal and notification shared one tail.
      window.__ux.delays.playlist = 5000;
      document.querySelector('#toast-text').textContent = '';
      document.querySelector('#context-menu [data-menu-action="remove-from-playlist"]').click();
    })()`);
    await browser.waitFor(`/Removed/i.test(document.querySelector('#toast-text')?.textContent || '')`, 1000);
    await browser.waitFor(`document.querySelectorAll('#page-root .track-row').length === ${before - 1}`, 8000);
    assert.match(await browser.eval(`document.querySelector('#toast-text').textContent`), /Removed/i);

    // Put it back with the API (the sheet flow is covered by the add test).
    await browser.eval(`fetch('/api/playlists/${seeded.id}/tracks',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(SEED_TRACK)})}).then(r=>r.ok)`);
  });
});

test('the "add to playlist" picker writes through and confirms', { skip }, async () => {
  await withApp({ viewport: VIEW.mobile390, page: 'liked' }, async () => {
    // Like the seeded track first so the liked list has a row.
    await browser.eval(`fetch('/api/likes',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({videoId:'${SEED_TRACK.videoId}',like:true,source:'test'})}).then(r=>r.ok)`);
    await nav(browser, 'liked');
    await browser.eval(`(() => {
      const row = document.querySelector('#page-root .track-row');
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 20 }));
    })()`);
    await browser.waitFor(`!document.querySelector('#context-menu').hidden`);
    await browser.eval(`document.querySelector('#context-menu [data-menu-action="add"]').click()`);
    await browser.waitFor(`!document.querySelector('#form-overlay').hidden`);
    assert.ok(await browser.eval(`document.querySelectorAll('.pick-row').length`) >= 1);
    await browser.eval(`document.querySelector('.pick-row').click()`);
    await browser.waitFor(`document.querySelector('#form-overlay').hidden === true`, 8000);
    assert.match(await browser.eval(`document.querySelector('#toast-text').textContent`), /Added to playlist/);
  });
});

// ── optimistic likes ────────────────────────────────────────────────────

test('a like updates the heart immediately, persists, and reads back after reload', { skip }, async () => {
  // Self-contained: this test owns the like it asserts on.
  const like = await browser.eval(`fetch('/api/likes',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({videoId:'${SEED_TRACK.videoId}',like:true,source:'test'})}).then(r=>r.ok)`);
  assert.equal(like, true, 'could not seed the like through the API');

  await withApp({ viewport: VIEW.mobile390, page: 'liked' }, async () => {
    await browser.waitFor(`!!document.querySelector('#page-root .track-row')`, 10_000);
    const id = await browser.eval(`document.querySelector('#page-root .track-row').dataset.track`);
    assert.equal(id, SEED_TRACK.videoId);

    const before = await browser.eval(`document.querySelectorAll('#page-root .track-row').length`);
    await browser.eval(`document.querySelector('#page-root .track-row .like-row').click()`);

    // Optimistic: the row reacts (aria-pressed flips or starts leaving) before
    // the network round trip has finished.
    await browser.waitFor(`(() => {
      const b = document.querySelector('#page-root .like-row');
      if (!b) return true;                        // already gone
      return b.getAttribute('aria-pressed') === 'false'
        || !!b.closest('.track-row')?.classList.contains('removing');
    })()`);

    await browser.waitFor(`document.querySelectorAll('#page-root .track-row').length === ${before - 1}`, 8000);
    const persisted = await browser.eval(`fetch('/api/likes').then(r=>r.json()).then(d=>d.tracks.some(t=>t.videoId==='${SEED_TRACK.videoId}'))`);
    assert.equal(persisted, false, 'un-liking must reach the server');

    // Collection routes are #/c/<collection>; #/liked is not a page route.
    await browser.goto(`${server.base}/#/c/liked`);
    await browser.waitFor(`!!document.querySelector('#page-root .collection-hero, #page-root .empty-state')`, 10_000);
    const stillThere = await browser.eval(
      `[...document.querySelectorAll('#page-root .track-row')].some(r => r.dataset.track === '${SEED_TRACK.videoId}')`,
    );
    assert.equal(stillThere, false, 'the un-liked track must not come back after a reload');
  });
});

// ── sort persists ───────────────────────────────────────────────────────

test('sort choice applies to the library and survives a reload', { skip }, async () => {
  await withApp({ viewport: VIEW.mobile390, page: 'library' }, async () => {
    await browser.waitFor(`document.querySelectorAll('#page-root .library-grid .music-card').length >= 2`, 10_000);
    await browser.eval(`document.querySelector('[data-action="sort"]').click()`);
    await browser.waitFor(`!document.querySelector('#context-menu').hidden`);
    await browser.eval(`document.querySelector('#context-menu [data-menu-action="sort-title"]').click()`);
    await browser.waitFor(`localStorage.getItem('sonora.sort') === '"title"'`);

    // "Liked songs" is deliberately pinned first; the sort applies to playlists.
    const titles = await browser.eval(
      `[...document.querySelectorAll('#page-root .library-grid .music-card:not([data-collection="liked"]) .music-card-title')]
        .map(n => n.textContent)`,
    );
    const sorted = [...titles].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    assert.deepEqual(titles, sorted);

    await browser.goto(`${server.base}/#/library`);
    await browser.waitFor(`!!document.querySelector('#page-root [data-library-tab]')`);
    await browser.waitFor(`document.querySelectorAll('#page-root .library-grid .music-card').length >= 2`, 10_000);
    const after = await browser.eval(
      `[...document.querySelectorAll('#page-root .library-grid .music-card:not([data-collection="liked"]) .music-card-title')]
        .map(n => n.textContent)`,
    );
    assert.deepEqual(after, titles, 'the chosen sort must be restored on the next visit');
  });
});

// ── the account menu follows its trigger ────────────────────────────────
// One popover, two triggers: the topbar button and the sidebar footer. It used
// to be pinned to a hardcoded top-right slot, which opened it in the opposite
// corner from the sidebar and, on desktop, out in the right rail.

test('the account menu opens anchored to whichever profile button was clicked', { skip }, async () => {
  // The popover animates in with a scale, and getBoundingClientRect reports the
  // transformed box: settle the animation before measuring or every edge reads
  // a few pixels short.
  const settle = () => browser.eval(`Promise.all(document.querySelector('#profile-menu')
    .getAnimations().map((a) => a.finished.catch(() => {}))).then(() => true)`);

  const geo = (triggerSelector) => browser.eval(`(() => {
    const menu = document.querySelector('#profile-menu');
    const btn = document.querySelector(${JSON.stringify(triggerSelector)});
    const rail = document.querySelector('.rail');
    const m = menu.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const railShown = rail && getComputedStyle(rail).display !== 'none';
    return {
      hidden: menu.hidden,
      menu: { left: m.left, right: m.right, top: m.top, bottom: m.bottom, width: m.width },
      btn: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
      railLeft: railShown ? rail.getBoundingClientRect().left : null,
      expanded: btn.getAttribute('aria-expanded'),
      vw: innerWidth, vh: innerHeight,
    };
  })()`);

  const assertInside = (g, label) => {
    assert.equal(g.hidden, false, `${label}: the menu must be open`);
    assert.equal(g.expanded, 'true', `${label}: the trigger must report aria-expanded`);
    assert.ok(g.menu.left >= 0 && g.menu.right <= g.vw + 0.5, `${label}: menu overflows the viewport horizontally`);
    assert.ok(g.menu.top >= 0 && g.menu.bottom <= g.vh + 0.5, `${label}: menu overflows the viewport vertically`);
    // 8px breathing room from the edges, minus sub-pixel rounding.
    assert.ok(g.menu.left >= 7.5 && g.menu.right <= g.vw - 7.5, `${label}: menu is too close to a viewport edge`);
    assert.ok(g.menu.top >= 7.5 && g.menu.bottom <= g.vh - 7.5, `${label}: menu is too close to a viewport edge`);
  };

  // Desktop: the rail makes the topbar's right edge sit ~292px inside the
  // viewport, which is exactly where the hardcoded `right:12px` used to miss.
  await withApp({ viewport: VIEW.desktop, page: 'home' }, async (ctx) => {
    await browser.eval(`document.querySelector('#profile-button').click()`);
    await browser.waitFor(`!document.querySelector('#profile-menu').hidden`);
    await settle();
    const top = await geo('#profile-button');
    assertInside(top, 'topbar button');
    assert.ok(Math.abs(top.menu.right - top.btn.right) <= 1,
      `topbar button: the menu's right edge (${top.menu.right}) must line up with the button (${top.btn.right})`);
    assert.ok(top.menu.top >= top.btn.bottom,
      `topbar button: the menu must hang below the button (menu ${top.menu.top}, button ${top.btn.bottom})`);
    assert.ok(top.menu.top - top.btn.bottom <= 16, 'topbar button: the menu must sit right under the button');
    assert.ok(top.railLeft === null || top.menu.right <= top.railLeft,
      `topbar button: the menu (right ${top.menu.right}) must stay out of the right rail (${top.railLeft})`);
    await ctx.shot('profile-menu-topbar');

    // Escape closes it and hands focus back to the button that opened it.
    await browser.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await browser.waitFor(`document.querySelector('#profile-menu').hidden === true`);
    assert.equal(await browser.eval(`document.activeElement.id`), 'profile-button');

    // The sidebar footer button opens the same menu next to itself, not in
    // the opposite corner.
    await browser.eval(`document.querySelector('#side-profile-button').click()`);
    await browser.waitFor(`!document.querySelector('#profile-menu').hidden`);
    await settle();
    const side = await geo('#side-profile-button');
    assertInside(side, 'sidebar button');
    assert.ok(Math.abs(side.menu.left - side.btn.left) <= 1,
      `sidebar button: the menu's left edge (${side.menu.left}) must line up with the button (${side.btn.left})`);
    const gapBelow = Math.abs(side.menu.top - side.btn.bottom);
    const gapAbove = Math.abs(side.btn.top - side.menu.bottom);
    assert.ok(Math.min(gapBelow, gapAbove) <= 16,
      `sidebar button: the menu must be adjacent to the button (below ${gapBelow}px, above ${gapAbove}px)`);
    assert.ok(side.menu.right <= side.vw / 2,
      'sidebar button: the menu must stay in the sidebar half, not jump to the far right');
    await ctx.shot('profile-menu-sidebar');
  });

  // Phone: one trigger, and the menu must still fit the narrow viewport.
  await withApp({ viewport: VIEW.mobile390, page: 'home' }, async (ctx) => {
    await browser.eval(`document.querySelector('#profile-button').click()`);
    await browser.waitFor(`!document.querySelector('#profile-menu').hidden`);
    await settle();
    const phone = await geo('#profile-button');
    assertInside(phone, 'phone');
    assert.ok(Math.abs(phone.menu.right - phone.btn.right) <= 1,
      'phone: the menu must line up with the account button');
    await ctx.shot('profile-menu-phone');
  });
});

// ── mobile hero ─────────────────────────────────────────────────────────

test('the mobile hero actions stay inside the hero with no overlap', { skip }, async () => {
  const viewports = [VIEW.mobile390, VIEW.mobile360, { name: '320x568', width: 320, height: 568, mobile: true }];
  for (const viewport of viewports) {
    await withApp({ viewport, page: 'home' }, async () => {
      await browser.waitFor(`!!document.querySelector('.hero')`, 10_000);
      const geo = await browser.eval(`(() => {
        const hero = document.querySelector('.hero').getBoundingClientRect();
        const items = [...document.querySelector('.hero-footer').children]
          .filter((n) => getComputedStyle(n).display !== 'none')
          .map((n) => { const r = n.getBoundingClientRect();
            return { cls: n.className, top: Math.round(r.top), bottom: Math.round(r.bottom),
                     left: Math.round(r.left), right: Math.round(r.right) }; });
        return { hero: { top: hero.top, bottom: hero.bottom, left: hero.left, right: hero.right }, items,
                 scrollWidth: document.documentElement.scrollWidth,
                 clientWidth: document.documentElement.clientWidth };
      })()`);

      assert.equal(geo.scrollWidth, geo.clientWidth, 'the hero must not create horizontal overflow');
      assert.equal(geo.items.length, 2, 'both hero actions must be visible');
      const [a, b] = geo.items;
      assert.ok(a.top === b.top || a.bottom <= b.top, 'the actions must not overlap vertically');
      if (a.top === b.top) assert.ok(a.right <= b.left, 'side-by-side actions must not overlap horizontally');
      for (const item of geo.items) {
        assert.ok(item.right <= geo.hero.right, `${item.cls} overflows the hero horizontally`);
        assert.ok(item.bottom <= geo.hero.bottom - 8, `${item.cls} is closer than 8px to the hero edge`);
      }
      // the caption that used to collide with the buttons is gone on phones
      assert.equal(await browser.eval(`getComputedStyle(document.querySelector('.hero-meta') || document.body).display`), 'none');

      // Both actions must be usable without scrolling past the mini player —
      // the whole point of the footer is a one-tap resume.
      const playerTop = await browser.eval(`Math.round(document.querySelector('#player').getBoundingClientRect().top)`);
      for (const item of geo.items) {
        assert.ok(item.bottom <= playerTop,
          `${item.cls} ends at ${item.bottom}px, behind the player that starts at ${playerTop}px`);
      }
    });
  }
});

// ── offline boot ────────────────────────────────────────────────────────

test('a fetch failure at boot shows the in-app offline state, not a blank page', { skip }, async () => {
  await browser.addInitScript(`(() => {
    try {
      if (localStorage.getItem('ux-offline') !== '1') return;
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        if (String(url).includes('/api/')) return Promise.reject(new TypeError('Failed to fetch'));
        return real(input, init);
      };
    } catch {}
  })()`);
  await browser.viewport(VIEW.mobile390);
  await browser.goto(`${server.base}/`);
  await browser.waitFor(`!!document.querySelector('#mobile-nav button')`, 20_000);
  await browser.eval(`localStorage.setItem('ux-offline','1')`);
  await browser.goto(`${server.base}/`);
  await browser.waitFor(`!!document.querySelector('#page-root .empty-state')`, 10_000);
  const text = await browser.eval(`document.querySelector('#page-root').innerText`);
  assert.match(text, /offline/i);
  assert.match(await browser.eval(`document.querySelector('#page-root [data-action="retry-boot"]').textContent`), /Try again/);
  assert.equal(await browser.eval(`document.title`), 'Offline · sonora');
  await browser.eval(`localStorage.removeItem('ux-offline')`);
});

// ── share deep links ─────────────────────────────────────────────────────

test('a copied link opens sonora and plays that exact track', { skip }, async () => {
  await browser.viewport(VIEW.mobile390);
  await browser.goto(`${server.base}/#/t/${SEED_TRACK.videoId}`);
  await browser.waitFor(`document.querySelector('.player-song-meta strong')?.textContent === ${JSON.stringify(SEED_TRACK.title)}`, 12_000);
  assert.equal(await browser.eval('location.hash'), `#/t/${SEED_TRACK.videoId}`);
  assert.match(await browser.eval(`document.querySelector('#toast-text').textContent || ''`), /Playing/i);

  // A link to an id this instance has never catalogued still plays: the shared
  // id is a play intent, so the client falls back to a minimal track instead of
  // refusing (the server may also answer with a synthetic track).
  await browser.goto(`${server.base}/#/t/AAAAAAAAAAA`);
  await browser.waitFor(`/Playing/i.test(document.querySelector('#toast-text')?.textContent || '')`, 10_000);
  assert.equal(await browser.eval(`document.getElementById('player').classList.contains('is-empty')`), false,
    'a shared id the instance has not seen must still load in the player');
  assert.equal(await browser.eval(`document.getElementById('auth-overlay').hidden`), true);
});

// ── artwork resilience ───────────────────────────────────────────────────

test('dead artwork degrades to the placeholder instead of a broken glyph', { skip }, async () => {
  await browser.viewport(VIEW.mobile390);
  await browser.goto(`${server.base}/#/c/recent`);
  await browser.waitFor(`!!document.querySelector('#page-root .collection-hero, #page-root .empty-state')`, 12_000);
  // A fresh temp DB has no play history, so seed one real play first.
  if (!(await browser.eval(`!!document.querySelector('#page-root .track-row img.cover')`))) {
    await browser.eval(`fetch('/api/events',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({videoId:'${SEED_TRACK.videoId}',kind:'start',source:'test',
        title:${JSON.stringify(SEED_TRACK.title)},channel:${JSON.stringify(SEED_TRACK.channel)},
        thumb:${JSON.stringify(SEED_TRACK.thumb)},durationS:${SEED_TRACK.durationS}})}).then(r=>r.ok)`);
    await browser.goto(`${server.base}/#/c/recent`);
  }
  await browser.waitFor(`!!document.querySelector('#page-root .track-row img.cover')`, 12_000);

  const before = await browser.eval(`document.querySelectorAll('#page-root img.cover').length`);
  assert.ok(before > 0, 'the recent list should have artwork');

  // Point every cover at a URL the artwork proxy rejects, the way a deleted
  // video or a throttled proxy behaves in production.
  await browser.eval(`(() => {
    for (const img of document.querySelectorAll('#page-root img.cover')) img.src = '/api/img/doesnotexist00';
    return true;
  })()`);
  await browser.waitFor(`document.querySelectorAll('#page-root img.is-broken').length > 0`, 10_000);

  const state = await browser.eval(`(() => {
    const img = document.querySelector('#page-root img.is-broken');
    const cs = getComputedStyle(img);
    return {
      broken: document.querySelectorAll('#page-root img.is-broken').length,
      blanked: img.currentSrc.startsWith('data:image/gif'),
      hasPlaceholder: cs.backgroundImage.includes('svg'),
      width: Math.round(img.getBoundingClientRect().width),
      height: Math.round(img.getBoundingClientRect().height),
    };
  })()`);
  assert.equal(state.blanked, true, 'the broken image must be repointed so no glyph is painted');
  assert.equal(state.hasPlaceholder, true, 'a broken cover must paint the waveform placeholder');
  assert.ok(state.width >= 40 && state.height >= 40, 'the cover box must not collapse');
  await browser.screenshot(`${SHOTS}/broken-artwork.png`);
});
