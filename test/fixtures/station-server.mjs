// Executable fixture for test/station-routes.test.js. It replaces only the
// Innertube session; the real server, parsers, routes and SQLite database run.
import fs from 'node:fs';
import { setSessionOverride } from '../../src/youtube.js';

const CONTROL = process.env.SONORA_STATION_CONTROL;
const LOG = process.env.SONORA_STATION_LOG;
if (!CONTROL || !LOG) throw new Error('station fixture needs control/log files');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = () => JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
const record = (entry) => fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);

function track(t = {}) {
  return {
    id: t.videoId,
    title: { text: t.title ?? 'Fixture track' },
    author: { name: t.channel ?? 'Fixture Artist', id: t.channelId ?? undefined },
    artists: [{ name: t.channel ?? 'Fixture Artist', channel_id: t.channelId ?? undefined }],
    duration: { seconds: t.durationS ?? 200 },
    item_type: t.itemType === 'video' ? 'video' : 'song',
  };
}

function artistPage(profile = {}) {
  return {
    id: profile.id,
    header: { title: { text: profile.name ?? 'Fixture Artist' }, thumbnail: { contents: [] } },
    sections: [
      { contents: (profile.songs ?? []).map(track) },
      {
        header: { title: { text: 'Fans might also like' } },
        contents: (profile.adjacent ?? []).map((a) => ({ id: a.id, title: { text: a.name } })),
      },
    ],
  };
}

function genreBrowse(genres, params) {
  const genre = genres.find((g) => g.params === params);
  return {
    data: {
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
            { musicCarouselShelfRenderer: {
              header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: 'Songs' }] } } },
              contents: (genre?.tracks ?? []).map((t) => ({
                musicResponsiveListItemRenderer: {
                  flexColumns: [
                    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: t.title }] } } },
                    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: `${t.channel} • 1K views • 3:20` }] } } },
                  ],
                  overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: {
                    playNavigationEndpoint: { watchEndpoint: { videoId: t.videoId } },
                  } } } },
                },
              })),
            } },
          ] } } } }],
        },
      },
    },
  };
}

const session = {
  music: {
    getExplore: async () => {
      const c = read();
      if (c.failAll || c.failExplore) throw new Error('fixture explore failure');
      record({ op: 'explore' });
      return {
        sections: [{ header: { title: { text: 'Moods & genres' } }, contents: (c.genres ?? []).map((g) => ({
          button_text: { text: g.name },
          endpoint: { payload: { params: g.params, browseId: `browse-${g.params}` } },
        })) }],
      };
    },
    getUpNext: async (videoId) => {
      const initial = read();
      record({ op: 'upNext:start', videoId });
      while (read().holdUpNext) await sleep(10);
      const c = read();
      if (c.failAll || c.failUpNext) throw new Error('fixture up-next failure');
      const rows = c.upNext?.[videoId] ?? (c.emptyUpstream ? [] : c.defaultUpNext ?? []);
      const answer = { contents: rows.map(track) };
      record({ op: 'upNext:end', videoId, count: answer.contents.length });
      return answer;
    },
    search: async (query, options = {}) => {
      const c = read();
      if (c.failAll || (options.type === 'artist' && c.failArtistSearch)) {
        record({ op: options.type === 'artist' ? 'artistSearch:failed' : 'musicSearch:failed', query });
        throw new Error('fixture search failure');
      }
      if (options.type === 'artist') {
        record({ op: 'artistSearch', query });
        const id = c.artistIds?.[query];
        return { artists: { contents: id ? [{ id, title: { text: query } }] : [] } };
      }
      return { songs: { contents: (c.searchSongs?.[query] ?? []).map(track) } };
    },
    getArtist: async (id) => {
      const c = read();
      record({ op: 'artist', id });
      if (c.failAll || c.failArtists) throw new Error('fixture artist failure');
      return artistPage({ id, ...(c.profiles?.[id] ?? {}) });
    },
    getLyrics: async () => ({ description: null }),
    getPlaylist: async () => ({ contents: [] }),
  },
  search: async () => {
    if (read().failAll) throw new Error('fixture video-search failure');
    return { videos: [] };
  },
  getPlaylist: async () => ({ items: [] }),
  getBasicInfo: async () => ({ basic_info: { is_live: false }, playability_status: { status: 'OK' } }),
  actions: {
    execute: async (_path, body) => {
      const c = read();
      record({ op: 'genreSongs', params: body?.params });
      if (c.failAll || c.failBrowse) throw new Error('fixture browse failure');
      return genreBrowse(c.genres ?? [], body?.params);
    },
  },
  session: { player: {} },
};

setSessionOverride(session);
await import('../../src/server.js');
