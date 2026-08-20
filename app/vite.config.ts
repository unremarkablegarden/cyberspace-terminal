import { defineConfig } from 'vite'

// COOP/COEP from day one: SharedArrayBuffer is needed for blocking process I/O.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
})
