// Path rule and quota for pages.cyberspace.online, as the machine checks them
// before a request leaves. The origin is ../nuxt/app/config/pages.ts, with a
// twin at ../api/src/lib/pages.ts; the bodies below are copied from it and
// stay character-identical. The server enforces the same rule again.

export const PAGES_QUOTA = {
  maxBytesTotal: 5 * 1024 * 1024,
  maxFiles: 128,
  maxBytesPerFile: 1024 * 1024,
} as const

/** Extension → Content-Type. The allowlist is the key set. */
export const PAGES_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mid: 'audio/midi',
  midi: 'audio/midi',
}

const SEGMENT = /^[a-z0-9_-][a-z0-9._-]{0,63}$/
const MAX_SEGMENTS = 8
const MAX_LENGTH = 200

export const pagesExtension = (path: string): string =>
  path.slice(path.lastIndexOf('.') + 1).toLowerCase()

/**
 * A site path, or null. Lowercased; 1–8 segments of `[a-z0-9._-]` with no
 * leading dot (so no `.`, `..`, `.htaccess`); ≤200 chars; a known extension.
 */
export function normalisePagesPath(raw: string): string | null {
  const path = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, '')
  if (!path || path.length > MAX_LENGTH) return null
  const segments = path.split('/')
  if (segments.length > MAX_SEGMENTS) return null
  if (!segments.every(s => SEGMENT.test(s))) return null
  const last = segments[segments.length - 1]!
  if (!last.includes('.') || !(pagesExtension(last) in PAGES_TYPES)) return null
  return segments.join('/')
}

export const pagesContentType = (path: string): string =>
  PAGES_TYPES[pagesExtension(path)] ?? 'application/octet-stream'

export const isPagesText = (path: string): boolean =>
  ['html', 'css', 'js', 'txt'].includes(pagesExtension(path))

/** An 88×31 button: gif or png. */
export const isPagesButton = (path: string): boolean =>
  ['gif', 'png'].includes(pagesExtension(path))
