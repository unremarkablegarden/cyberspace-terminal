// Constants for the faceplate: grid size, addresses and timings.
// Public values only; nothing here is a secret.

/** Phones get the narrow grid. The soft keyboard is wired up in main.ts. */
export const MOBILE = /mobi|android/i.test(navigator.userAgent)

export const COLS = MOBILE ? 44 : 80
export const ROWS = MOBILE ? 20 : 25
export const HOME = '/home/guest'

export const API_URL = 'https://api.cyberspace.online'

// Live chat reads stream straight from RTDB with the caller's idToken; writes
// go via the API.
export const RTDB_URL = 'https://cyberspace-cyberspace-default-rtdb.europe-west1.firebasedatabase.app'

/** Audio asset paths. */
export const SOUNDS = { bootup: '/sounds/bootup.mp3' }

/** Output rate in characters per second. 2400 baud at 8N1 is ten bits per character. */
export const CPS = 240

/** Time away after which the next visit is a cold boot, with the full boot animation. */
export const COLD_AFTER = 10 * 60 * 1000

/** Prefix on everything this faceplate keeps in localStorage. */
export const STORE_PREFIX = 'csterm.'

/** The environment every shell starts with. USER follows the login. */
export const ENV = {
  USER: 'guest',
  HOME,
  HOSTNAME: 'cyberspace',
  PATH: '/bin',
  SHELL: '/bin/sh',
  TERM: 'xterm',
  COLUMNS: String(COLS),
  LINES: String(ROWS),
}
