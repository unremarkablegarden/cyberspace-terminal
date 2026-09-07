// Path rule and quota for home sync, as the machine checks them before a file
// is encrypted. The server never sees a path, so this rule has no twin there;
// the quota mirrors HOME_QUOTA in ../api/src/lib/home.ts.

export const HOME_QUOTA = {
  maxBytesTotal: 5 * 1024 * 1024,
  maxFiles: 256,
  maxBytesPerFile: 1024 * 1024,
} as const

const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/
const MAX_SEGMENTS = 8
const MAX_LENGTH = 200

/**
 * Paths under the home that never sync. public_html has its own transport;
 * the manual and the examples are rewritten from the bundle each boot; .sync
 * is the sync's own state; .sh_history is appended to by the running shell
 * without awaiting, so a pull could not replace it safely.
 */
export function isHomeExcluded(rel: string): boolean {
  return rel === '.sync' || rel === '.sh_history' || rel.endsWith('.tmp')
    || rel === 'public_html' || rel.startsWith('public_html/')
    || rel.startsWith('bin/docs/') || rel.startsWith('bin/examples/')
}

/**
 * A home-relative path the sync accepts, or null. Case kept; 1–8 segments of
 * `[A-Za-z0-9._-]`, none `.` or `..`; ≤200 chars. Dotfiles are the point, and
 * a program in ~/bin has no extension, so there is no allowlist.
 */
export function normaliseHomePath(raw: string): string | null {
  const path = raw.replace(/^\/+|\/+$/g, '')
  if (!path || path.length > MAX_LENGTH) return null
  const segments = path.split('/')
  if (segments.length > MAX_SEGMENTS) return null
  if (!segments.every(s => SEGMENT.test(s) && s !== '.' && s !== '..')) return null
  return segments.join('/')
}
