// Following an artist and turning their new releases into notifications.
//
// This module is deliberately free of HTTP concerns: it is imported by
// src/server.js (the routes and the background sweep) and directly by
// test/follows.test.js, which injects a fake `page` so the diff logic can be
// exercised without touching YouTube.
//
// The shape of the problem: an artist page lists what exists *now*. The
// interesting event is "something appeared that we did not have before", which
// is a diff against the baseline in artist_releases (see src/db.js). The first
// check of an artist only ever establishes that baseline — following a band
// with twelve albums must not fire twelve notifications.
//
// "Only" has a second edge: a check that read *no* release shelf has not
// established anything, and recording it as the baseline would make the next
// readable sweep report the whole back catalogue as news. checkArtist() refuses
// that baseline and retries on the next sweep.

import {
  knownReleases, recordReleases, listArtistFollowers, listUserIds,
  artistReleaseInitialized, markArtistReleaseInitialized,
  followSweepDue, markFollowAttempt, touchFollowChecked, addNotification, transaction,
} from './db.js';
import { artistPage } from './youtube.js';

/** A browse id the client's collection route understands (an album release). */
const CATALOGUE_ID = /^(MPR|VLPL|PL)[\w-]+$/;

/**
 * What is new in `releases`, given the ids we already know.
 *
 * `initialized` is explicit because a known empty catalogue has no release ids.
 * The known-ids fallback preserves the old pure-helper contract: a non-empty
 * baseline is itself proof of initialization. Everything seen before the first
 * successful check is a baseline; every later check reports only unknown ids.
 * checkArtist() records `fresh` *and* `baseline` in the same transaction as their
 * notifications, so a failed poll can safely try again.
 */
export function diffReleases(knownIds, releases, initialized) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
  const list = (releases ?? []).filter((r) => r?.releaseId);
  if (!(initialized ?? (known.size > 0))) return { fresh: [], baseline: list };
  return { fresh: list.filter((r) => !known.has(r.releaseId)), baseline: [] };
}

/**
 * The in-app route for a release, ready for `location.hash =`.
 *
 * A catalogue release (MPR…/VLPL…) opens the collection page the client already
 * has; a video opens the track route. Anything unrecognised gets no url rather
 * than a broken one — the notification still renders, it just does not navigate.
 */
export function releaseUrl(release) {
  const id = String(release?.releaseId ?? release?.videoId ?? '').trim();
  if (!id) return null;
  // Albums first: a catalogue id is unambiguous. An 11-character id is a video,
  // which is checked before the looser `PL…` playlist form because a video id
  // may legitimately begin with "PL".
  if (/^(MPR|VLPL)[\w-]+$/.test(id)) return `#/c/a${id}`;
  if (/^[\w-]{11}$/.test(id)) return `#/t/${id}`;
  if (/^PL[\w-]+$/.test(id)) return `#/c/a${id}`;
  return null;
}

/**
 * One album/single row from `artistPage()` → a release we can store.
 *
 * `artistPage()` already dropped rows it could not read (see toAlbumItem), so
 * the only thing left to guard is an id/title pair that cannot be stored or
 * rendered. `kind` is the release's own format; notification `kind` is the
 * separate 'release' | 'track' distinction the bell uses.
 */
export function releaseFromItem(item) {
  const releaseId = typeof item?.id === 'string' ? item.id.trim() : '';
  if (!releaseId || !CATALOGUE_ID.test(releaseId)) return null;
  const title = String(item?.title ?? '').trim();
  if (!title) return null;
  return {
    releaseId,
    title,
    kind: /single|\bep\b/i.test(String(item?.type ?? '')) ? 'single' : 'album',
    year: item?.year != null ? String(item.year) : null,
    thumb: item?.thumb ?? null,
  };
}

/** Same release twice (an album also listed as a single) must not be diffed twice. */
function dedupeReleases(list) {
  const seen = new Map();
  for (const r of list) if (r?.releaseId && !seen.has(r.releaseId)) seen.set(r.releaseId, r);
  return [...seen.values()];
}

/**
 * The same-origin URL for a release thumbnail, or null when there is none.
 *
 * A notification's `icon` must be same-origin: iOS silently drops an off-origin
 * one, which is the trap public/media-session.js documents for lock-screen
 * artwork — and an artist avatar or album cover is always on Google's CDN
 * (`yt3.googleusercontent.com`, `lh3.googleusercontent.com`, `i.ytimg.com`),
 * never on this origin. The server owns the one host allowlist (`/api/img?u=`
 * answers 400 for a host it does not trust), so *every* absolute https image is
 * proxied and an unknown future CDN degrades to a proxied miss instead of a
 * silently art-less alert. This mirrors `artSrc()` in public/media-session.js,
 * on the server side of the wire, and is the address that ends up in the
 * notification row's `thumb`.
 */
export function proxiedThumb(raw) {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return null;
  // Only http(s) can be a picture: a `javascript:` or `data:text/html` URL in an
  // icon is not artwork, it is a payload.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) return null;
  // YouTube returns protocol-relative URLs for channel avatars.
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  // A relative path is the app's own (/icons/…), and an http: URL is left alone
  // because an https page cannot render it and the proxy only speaks TLS.
  if (!/^https:/i.test(absolute)) return absolute;
  return `/api/img?u=${encodeURIComponent(absolute)}`;
}

// Artists already warned about an empty catalogue, so a sweep every twenty
// minutes logs once per artist instead of on every pass. Entries are dropped as
// soon as the artist is readable or has no followers left, so this stays a cache
// of current trouble rather than a list of every channel that ever misparsed.
const warnedEmptyCatalogue = new Set();

/**
 * Forget the empty-catalogue warning for one artist.
 *
 * Called when an artist is unfollowed: the entry exists to keep a log line from
 * repeating, and an artist nobody follows is never checked again, so keeping it
 * would leak one string per abandoned follow for the life of the process.
 */
export function forgetEmptyCatalogueWarning(artistId) {
  if (artistId) warnedEmptyCatalogue.delete(String(artistId));
}

/**
 * Check one artist and atomically record its releases and their notifications.
 *
 * The upstream read is deliberately outside the database transaction. The
 * baseline and follower list are read only after that read completes, so a
 * follow/unfollow made while the page was in flight is reflected in the fan-out.
 * If reading followers, recording a release, or adding any notification fails,
 * the whole transaction rolls back and the next check still sees the news.
 *
 * `page` is injectable so tests can drive this with no network. Callers decide
 * what an exception means — the follow route logs it, the sweep records it and
 * moves on. `artist` supplies the sweep's stored labels as upstream fallbacks.
 */
export async function checkArtist(artistId, {
  page = artistPage, artist = null,
  at = new Date().toISOString(),
  // Storage hooks make follower/notification failures testable without network
  // or monkey-patching ES module exports. Production defaults are the db helpers.
  readKnown = knownReleases,
  readInitialized = artistReleaseInitialized,
  readFollowers = listArtistFollowers,
  record = recordReleases,
  initialize = markArtistReleaseInitialized,
  notify = addNotification,
} = {}) {
  const data = await page(artistId);
  const releases = dedupeReleases(
    [...(data?.albums ?? []), ...(data?.singles ?? [])].map(releaseFromItem).filter(Boolean),
  );
  const artistName = data?.name ?? artist?.name ?? null;

  return transaction(() => {
    const known = readKnown(artistId);
    const initialized = readInitialized(artistId) || known.length > 0;
    // This read must succeed before any baseline write. Treating a database
    // error as "no followers" would consume every fresh release without fanout.
    const followers = readFollowers(artistId);

    // An empty first look is ambiguous, and the ambiguity is not survivable.
    // `artistPage()` reports a shelf it could not read and a catalogue that
    // really is empty the same way — `albums: []`, `singles: []` — so nothing
    // downstream can tell "this artist has released nothing" from "YouTube
    // changed its shelves and we parsed nothing". Recording an empty baseline on
    // a parse miss is what floods a user: the next sweep, with the shelves
    // readable again, finds the *entire* back catalogue unknown and notifies all
    // of it. So an empty first look is deliberately not recorded — the artist
    // stays uninitialized and is looked at again (one page fetch per sweep, and
    // the backoff ladder keeps it off the front of the queue). The cost of a
    // re-check is a fetch; the cost of the other mistake is the user's trust.
    if (!initialized && releases.length === 0) {
      if (!followers.length) {
        // Nobody is waiting for this artist, so there is no reason to remember
        // that it misparsed: the entry would outlive the follow itself.
        warnedEmptyCatalogue.delete(artistId);
      } else if (!warnedEmptyCatalogue.has(artistId)) {
        warnedEmptyCatalogue.add(artistId);
        console.warn(`[sonora] no readable release shelf for ${artistId}; leaving it uninitialized so the next check looks again`);
      }
      return {
        name: data?.name ?? null,
        thumb: data?.thumb ?? null,
        fresh: [],
        baseline: [],
        created: 0,
        followers,
      };
    }
    warnedEmptyCatalogue.delete(artistId);

    const { fresh, baseline } = diffReleases(
      known.map((r) => r.releaseId), releases, initialized,
    );

    // Initialization is durable per artist, including a successful empty page.
    // It shares the notification transaction: a crash or failed write leaves
    // both fresh releases and the empty baseline owed to the next poll.
    record(artistId, releases);
    initialize(artistId, at);

    let created = 0;
    for (const release of fresh) {
      const what = release.kind === 'single' ? 'single' : 'album';
      const body = `New ${what} from ${artistName ?? 'an artist you follow'}`
        + (release.year ? ` · ${release.year}` : '');
      for (const follower of followers) {
        if (notify({
          userId: follower.userId,
          kind: 'release',
          title: release.title,
          body,
          thumb: proxiedThumb(release.thumb ?? data?.thumb ?? artist?.thumb),
          url: releaseUrl(release),
          artistId,
          artistName,
          videoId: null,
          dedupe: `release:${artistId}:${release.releaseId}`,
          createdAt: at,
        })) created += 1;
      }
    }

    return {
      name: data?.name ?? null,
      thumb: data?.thumb ?? null,
      fresh,
      baseline,
      created,
      followers,
    };
  });
}

/**
 * The artists this sweep should look at, healthy ones first.
 *
 * `followSweepDue()` is per user (the backoff is stored on the follow row, which
 * belongs to a user), while a check is per *artist*: one page fetch serves every
 * follower. So the due rows of all accounts are merged by artist, keeping the
 * least-failed spelling of each, and the merge is ordered the way the per-user
 * query is: `failCount` first, then how long ago the attempt was made.
 *
 * That ordering is the fix for the starvation bug: the old global queue was
 * strictly oldest-checked-first, so three dead channels at the front were
 * retried on every sweep and a healthy artist behind them was never reached.
 * Now a never-tried artist sorts ahead of anything that has failed, so one
 * sweep always makes progress on someone who might answer.
 *
 * The task is the caller side of the fix-db contract
 * (`followSweepDue(userId, limit, now)` + `markFollowAttempt(userId, artistId,
 * { ok, at })`); a single global query would save one read per account.
 */
export function dueFollows(limit = 4, now = new Date().toISOString(), userId = null) {
  const byArtist = new Map();
  // Only ids are needed here, and the sweep runs on a timer over every account.
  // Asking listUsersWithStats() for them meant six aggregates over the whole of
  // everyone's listening history, every twenty minutes, on the event loop the
  // audio streams share, for six numbers nothing read. listUserIds() returns
  // bare ids, so this iterates them as such.
  const accounts = userId == null ? listUserIds() : [userId];
  for (const accountId of accounts) {
    for (const row of followSweepDue(accountId, limit, now)) {
      const prev = byArtist.get(row.artistId);
      if (!prev) {
        byArtist.set(row.artistId, { ...row, userIds: [accountId] });
        continue;
      }
      // The same artist is due for several followers: one check covers them
      // all, but each of those rows has to record the attempt separately.
      prev.userIds.push(accountId);
      if ((row.failCount ?? 0) < (prev.failCount ?? 0)) Object.assign(prev, row, { userIds: prev.userIds });
    }
  }
  return [...byArtist.values()]
    .sort((a, b) => (a.failCount ?? 0) - (b.failCount ?? 0)
      || String(a.lastAttemptAt ?? '').localeCompare(String(b.lastAttemptAt ?? ''))
      || String(a.artistId).localeCompare(String(b.artistId)))
    .slice(0, Math.max(1, Math.trunc(Number(limit) || 0)));
}

/**
 * One sweep: check the followed artists that are due and fan any new releases
 * out to their followers.
 *
 * Never throws — it runs from a timer, where an exception is invisible. One
 * artist failing (deleted channel, transient upstream error) must not stop the
 * rest of the sweep, hence the per-artist try/catch, and the failure is written
 * to each due follower's row (see markFollowAttempt) so a dead channel backs
 * off instead of occupying the front of every future sweep. `dedupe` is
 * `release:<artistId>:<releaseId>`, so re-running the sweep creates no rows.
 */
export async function pollFollows({
  limit = 4, page = artistPage, now, userId = null, storage = {},
} = {}) {
  const at = now ?? new Date().toISOString();
  let due = [];
  try {
    due = dueFollows(limit, at, userId);
  } catch (err) {
    console.warn('[sonora] follow sweep could not read the follow list:', err.message);
    return { checked: 0, created: 0, failed: 0 };
  }

  let checked = 0;
  let created = 0;
  let failed = 0;

  for (const artist of due) {
    let result;
    try {
      result = await checkArtist(artist.artistId, { ...storage, page, artist, at });
      // checkArtist returns only after its baseline and notification transaction
      // commits, so neither counter includes work that was rolled back.
      checked += 1;
      created += result.created;
    } catch (err) {
      failed += 1;
      console.warn(`[sonora] follow check failed for ${artist.artistId}: ${err.message}`);
      // Recorded, not forgotten: the failure is what moves this artist behind
      // the healthy ones in the next sweep (and starts its backoff ladder).
      for (const userId of artist.userIds ?? []) {
        try {
          markFollowAttempt(userId, artist.artistId, { ok: false, at });
        } catch (writeErr) {
          console.warn(`[sonora] could not record a failed follow check for ${artist.artistId}:`, writeErr.message);
        }
      }
      continue;
    }

    // Marked even when nothing was new: "we looked and found nothing" is the
    // fact that keeps this artist at the back of the next sweep's queue. A
    // successful check is evidence about the *artist*, so every follower's
    // row clears its failure counter — the channel is alive for all of them.
    // Bookkeeping is separate from reconciliation: a failed timestamp update
    // cannot turn an already-committed check into a reported upstream failure.
    if (result.followers.length) {
      for (const follower of result.followers) {
        try {
          markFollowAttempt(follower.userId, artist.artistId, { ok: true, at });
        } catch (err) {
          console.warn(`[sonora] could not record a successful follow check for ${artist.artistId}:`, err.message);
        }
      }
    } else {
      try {
        touchFollowChecked(artist.artistId, at);
      } catch (err) {
        console.warn(`[sonora] could not record a successful follow check for ${artist.artistId}:`, err.message);
      }
    }
  }

  return { checked, created, failed };
}
