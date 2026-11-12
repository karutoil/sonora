// Executable fixture for test/track-version.test.js. It replaces only the
// Innertube session; the real server, parsers, ranking, routes and SQLite
// database run — so what this file feeds in is exactly what a listener's
// browser would see from a real search.
import fs from 'node:fs';
import { setSessionOverride } from '../../src/youtube.js';

const SONGS_FILE = process.env.SONGS_FILE;
if (!SONGS_FILE) throw new Error('track-version fixture needs SONGS_FILE');

const songs = () => JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));

const session = {
  music: {
    search: async (query, options = {}) => {
      if (options.type !== 'song') return {};
      return { songs: { contents: songs() } };
    },
    getUpNext: async () => ({ contents: [] }),
    getExplore: async () => ({ sections: [] }),
    getArtist: async () => ({ header: { title: { text: 'Fixture Artist' } }, sections: [] }),
    getAlbum: async () => ({}),
    getPlaylist: async () => ({}),
    getLyrics: async () => ({ description: 'La la la' }),
  },
  search: async () => ({ videos: [] }),
  getPlaylist: async () => ({}),
  getBasicInfo: async () => ({ basic_info: { title: 'Fixture Song', author: 'Fixture Artist', is_live: false } }),
  actions: { execute: async () => ({ data: {} }) },
  session: { player: {} },
};

setSessionOverride(session);
await import('../../src/server.js');
