import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// COOP/COEP from day one: SharedArrayBuffer is needed for blocking process I/O.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  plugins: [
    // Offline machine: the shell, fonts, sounds, wasm and example programs are
    // precached, so a booted install works with no network. A new service
    // worker WAITS — it activates when every tab is gone, never mid-session.
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Cyberspace Terminal',
        short_name: 'Terminal',
        description: 'A machine on the wire.',
        display: 'standalone',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,bdf,wasm,wav,mp3,png}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
      },
    }),
  ],
})
