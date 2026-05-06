import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Repo deploys to https://<user>.github.io/rom-seeker/
export default defineConfig({
  base: '/rom-seeker/',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      // parse-torrent imports node:path for one call to path.join — shim it
      // with a tiny browser implementation so the bundle resolves cleanly.
      path: fileURLToPath(new URL('./src/path-shim.js', import.meta.url)),
    },
  },
})
