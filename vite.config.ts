import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { downloadHelper } from './server/downloadHelper';

export default defineConfig({
  // The download helper only exists in SongSort's local server (npm start); the published site is static.
  plugins: [react(), downloadHelper()],
  worker: { format: 'es' },
  // Pre-bundle the scanner's libraries up front so the dev server never reloads the page mid-scan.
  // FFmpeg starts its own worker and must not be pre-bundled.
  optimizeDeps: {
    include: ['music-metadata', 'hash-wasm', 'client-zip'],
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  server: { port: 5178 },
  preview: { port: 5178 },
});
