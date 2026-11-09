import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // Pre-bundle the scanner's libraries up front so the dev server never reloads the page mid-scan.
  optimizeDeps: { include: ['music-metadata', 'hash-wasm', 'client-zip'] },
  server: { port: 5178 },
  preview: { port: 5178 },
});
