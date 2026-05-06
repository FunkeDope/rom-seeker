import { defineConfig } from 'vite'

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
})
