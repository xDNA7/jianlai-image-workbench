import { defineConfig } from 'vite'
import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // Absolute so deep routes (e.g. /jianlai/manage/<path>) still load ./assets.
  // A relative base resolved them under the route and the admin page went blank.
  base: process.env.VITE_APP_BASE || '/jianlai/',
  plugins: [reactRouter(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1' },
  // e2e builds with base '/' into its own folder so it never overwrites the release build.
  build: { outDir: process.env.VITE_OUT_DIR || '../dist/frontend-spa', emptyOutDir: true },
})
