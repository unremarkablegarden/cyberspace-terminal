import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import mkcert from 'vite-plugin-mkcert'

// COOP/COEP from day one: SharedArrayBuffer is needed for blocking process I/O.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Mirrors app/vercel.json. img-src omits remote hosts, so an injected
// <img src=…> beacon cannot leave; the machine draws images to a canvas, never
// an <img>. connect-src stays broad because view(1) and chat fetch images from
// arbitrary hosts; user-program egress is bounded by the worker realm and a
// brokered image capability, not by this header. Preview only: the dev server
// keeps just the isolation headers so HMR's inline scripts and eval still run.
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'self' https: wss:; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

export default defineConfig({
  // https on the LAN: OPFS and the isolation headers need a secure context,
  // and only localhost is exempt. The mkcert root CA must be trusted on the
  // client device.
  server: { headers: isolation, host: true },
  preview: { headers: { ...isolation, 'Content-Security-Policy': csp } },
  plugins: [
    mkcert(),
    // Offline machine: the chunks, fonts, sounds, wasm and example programs are
    // precached, so a booted install works with no network. The document
    // itself is network-first with a short timeout: it names the build's
    // chunks, so a visit that is online boots the latest deploy even while
    // the old worker is still in charge, and one that is offline boots the
    // cached copy. A new service worker waits: it activates when every tab is
    // gone, or on reboot, never mid-session.
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
        globPatterns: ['**/*.{js,css,bdf,wasm,wav,mp3,png}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: null,
        runtimeCaching: [{
          urlPattern: ({ request }) => request.mode === 'navigate',
          handler: 'NetworkFirst',
          options: { cacheName: 'document', networkTimeoutSeconds: 3 },
        }],
      },
    }),
  ],
})
