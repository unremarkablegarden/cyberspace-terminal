// Constants for the faceplate: grid size, addresses and timings.
// Public values only; nothing here is a secret.

/**
 * Phones get the narrow grid; the soft keyboard is wired up in main.ts. An iPad
 * sends a Mac user agent by default, and 'iPad' when Safari is asked for the
 * mobile site; either way it gets the 80x25 machine. An Android tablet sends
 * no 'Mobile' token and gets it too.
 */
export const MOBILE = /mobi/i.test(navigator.userAgent) && !/ipad|tablet/i.test(navigator.userAgent)

export const ANDROID = /android/i.test(navigator.userAgent)

/** An Android tablet: the 80x25 machine, with the phone's soft keyboard and key bar. */
export const ANDROID_TABLET = ANDROID && !MOBILE

/** An iPad: touch on a 'Mac' or 'iPad' user agent. Its keyboards have no F row or Escape. */
export const TABLET = !MOBILE && navigator.maxTouchPoints > 1 && /ipad|macintosh/i.test(navigator.userAgent)

/** A Mac, an iPhone or an iPad: the machines whose host modifier is Cmd. */
export const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  || /Macintosh|MacIntel|MacPPC|Mac68K/.test(navigator.userAgent)

/**
 * The platform's own modifier, as the site reads it (usePlatform): Cmd on a
 * Mac, Ctrl everywhere else. It carries the keys the machine answers itself,
 * the switcher among them, so on Windows and Linux ^K reaches the switcher
 * rather than the shell's kill-to-end-of-line. The site takes the same key for
 * its command palette.
 */
export const hostModifier = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey

/** Prefix on everything this faceplate keeps in localStorage. */
export const STORE_PREFIX = 'csterm.'

/** The grid sizes F1 offers, as cols x rows. */
export const GRIDS = ['44x20', '80x25', '132x43']

/**
 * The grid chosen in F1, else the device's own: 44x20 on a phone, 80x25 elsewhere.
 * Read once at load, since nothing resizes the tty after boot; a change in F1 reloads the page.
 * Read from localStorage directly because store.ts imports this file.
 */
export const GRID_SIZE = ((): string => {
  const saved = localStorage.getItem(STORE_PREFIX + 'grid')
  return saved && GRIDS.includes(saved) ? saved : MOBILE ? '44x20' : '80x25'
})()

export const [COLS, ROWS] = GRID_SIZE.split('x').map(Number)
export const HOME = '/home/guest'

/** A member's home sits next to guest's on the same OPFS mount. */
export const homeOf = (user: string | null): string => `/home/${user ?? 'guest'}`

/** ~/bin first so an installed program runs by name. resolveExec does not expand ~, hence the literal. */
export const pathOf = (home: string): string => `${home}/bin:/bin`

export const API_URL = 'https://api.cyberspace.online'

// Live chat reads stream straight from RTDB with the caller's idToken; writes
// go via the API.
export const RTDB_URL = 'https://cyberspace-cyberspace-default-rtdb.europe-west1.firebasedatabase.app'

// Host suffixes a user program may load an image from via ctx.image. A user
// program runs in a worker with no network of its own; the host fetches on its
// behalf and only from these. Matched as the host itself or a subdomain of it,
// https only.
export const IMAGE_HOSTS = [
  'giphy.com', 'tenor.com', 'imgur.com', 'cyberspace.online',
  'wikimedia.org', 'githubusercontent.com',
]

/** Audio asset paths. */
export const SOUNDS = { bootup: '/sounds/bootup.mp3' }

/** Output rate in characters per second. 2400 baud at 8N1 is ten bits per character. */
export const CPS = 240

/** Time away after which the next visit is a cold boot, with the full boot animation. */
export const COLD_AFTER = 10 * 60 * 1000

/** The environment every shell starts with. USER, HOME and PATH follow the login (main.ts). */
export const ENV = {
  USER: 'guest',
  HOME,
  HOSTNAME: 'cyberspace',
  // Builtins resolve before the PATH walk (packages/kernel/src/kernel.ts), so
  // nothing in ~/bin can shadow ls or cat.
  PATH: pathOf(HOME),
  SHELL: '/bin/sh',
  TERM: 'xterm',
  // bash's values. help(1) reads it to name the copy and paste chords.
  OSTYPE: MAC ? 'darwin' : /Win/.test(navigator.platform) ? 'msys' : 'linux-gnu',
  COLUMNS: String(COLS),
  LINES: String(ROWS),
}
