// TEST ONLY: start SongSort's dev server allowing the local test website (scripts/fixture-server.mjs).
// The normal app (npm start, and the published site) never allows local addresses.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SONGSORT_TEST_ORIGIN = 'http://127.0.0.1:5199';
process.env.VITE_SONGSORT_TEST_ORIGIN = 'http://127.0.0.1:5199';
await import('./fixture-server.mjs');
const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), server: { port: 5180, strictPort: true } });
await server.listen();
server.printUrls();
