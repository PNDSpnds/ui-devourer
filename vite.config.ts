import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    watch: {
      // Editors that write atomically leave short-lived .tmpdir folders behind.
      // Watching those files makes chokidar crash with EBUSY on Windows.
      ignored: ['**/.*.tmpdir/**', '**/*.tmpdir/**', '**/.tmp/**'],
    },
  },
  build: {
    target: 'es2022',
    // rapier3d-compat inlines its WASM as base64, so the vendor chunk is large by design.
    chunkSizeWarningLimit: 6000,
  },
});
