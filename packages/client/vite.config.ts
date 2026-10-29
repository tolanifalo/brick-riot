import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative base keeps the build loadable from a Capacitor WebView.
  base: './',
  server: { port: 5173, host: true },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    // Phaser alone is ~1.2 MB minified; it is a single cached vendor chunk.
    chunkSizeWarningLimit: 1600,
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
