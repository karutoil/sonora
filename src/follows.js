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

import {
  knownReleases, recordReleases, listFollowsToCheck, listArtistFollowers,
  touchFollowChecked, addNotification,
} from './db.js';
import { artistPage } from './youtube.js';

/** A browse id the client's collection route understands (an album release). */
const CATALOGUE_ID = /^(MPR|VLPL|PL)[\w-]+$/;

/**
 * What is new in `releases`, given the ids we already know.
 *
 * `knownIds` empty means this is the first look at the artist: everything is a
 * baseline and nothing is notified. Every later check reports only the ids that
 * were not known. Callers record `fresh` *and* `baseline` as known, so a release
 * is announced at most once even if a poll crashes half way through.
 */
export function diffReleases(knownIds, releases) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
  const list = (releases ?? []).filter((r) => r?.releaseId);
  if (known.size === 0) return { fresh: [], baseline: list };
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
 * Check one artist: read the baseline, fetch the page, diff, and record
 * everything as known.
 *
 * `page` is injectable so tests can drive this with no network. It is the only
 * thing that can throw here (a dead upstream), and callers decide what that
 * means — the follow route swallows it, the sweep logs it and moves on.
 */
export async function checkArtist(artistId, { page = artistPage } = {}) {
  const known = knownReleases(artistId);
  const data = await page(artistId);
  const releases = dedupeReleases(
    [...(data?.albums ?? []), ...(data?.singles ?? [])].map(releaseFromItem).filter(Boolean),
  );
  const { fresh, baseline } = diffReleases(known.map((r) => r.releaseId), releases);
  // Record everything, not just what is new: INSERT OR IGNORE means this also
  // fills in metadata for a release whose row predates a field, and it keeps the
  // baseline complete if a previous check died between diff and record.
  recordReleases(artistId, releases);
  return {
    name: data?.name ?? null,
    thumb: data?.thumb ?? null,
    fresh,
    baseline,
  };
}

/**
 * One sweep: check the least recently checked followed artists and fan any new
 * releases out to their followers.
 *
 * Never throws — it runs from a timer, where an exception is invisible. One
 * artist failing (deleted channel, transient upstream error) must not stop the
 * rest of the sweep, hence the per-artist try/catch. `dedupe` is
 * `release:<artistId>:<releaseId>`, so re-running the sweep creates no rows.
 */
export async function pollFollows({ limit = 4, page = artistPage, now } = {}) {
  const at = now ?? new Date().toISOString();
  let due = [];
  try {
    due = listFollowsToCheck(limit);
  } catch (err) {
    console.warn('[sonora] follow sweep could not read the follow list:', err.message);
    return { checked: 0, created: 0 };
  }

  let checked = 0;
  let created = 0;

  for (const artist of due) {
    try {
      const result = await checkArtist(artist.artistId, { page });
      checked += 1;

      if (result.fresh.length) {
        const artistName = result.name ?? artist.name ?? null;
        const followers = listArtistFollowers(artist.artistId);
        for (const release of result.fresh) {
          const what = release.kind === 'single' ? 'single' : 'album';
          const body = `New ${what} from ${artistName ?? 'an artist you follow'}`
            + (release.year ? ` · ${release.year}` : '');
          for (const follower of followers) {
            if (addNotification({
              userId: follower.userId,
              kind: 'release',
              title: release.title,
              body,
              thumb: release.thumb ?? result.thumb ?? artist.thumb ?? null,
              url: releaseUrl(release),
              artistId: artist.artistId,
              artistName,
              videoId: null,
              dedupe: `release:${artist.artistId}:${release.releaseId}`,
              createdAt: at,
            })) created += 1;
          }
        }
      }

      // Marked even when nothing was new: "we looked and found nothing" is the
      // fact that keeps this artist at the back of the next sweep's queue.
      touchFollowChecked(artist.artistId, at);
    } catch (err) {
      console.warn(`[sonora] follow check failed for ${artist.artistId}: ${err.message}`);
    }
  }

  return { checked, created };
}
