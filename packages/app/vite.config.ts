import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

/** Ship app.json with the build so `dist/` (bridge-hosted at /app/) exposes the manifest like the Vite dev server does. */
function appManifest(): Plugin {
  return {
    name: 'claudedeck-app-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'app.json', source: readFileSync(new URL('./app.json', import.meta.url), 'utf8') })
    },
  }
}

export default defineConfig({
  server: { host: true, port: 5173 },
  base: './',
  build: { target: 'esnext' },
  plugins: [appManifest()],
})
