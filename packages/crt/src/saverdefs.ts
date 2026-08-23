// The screensaver contract between the engine and the page — names, prefs and
// the persistence seam. Split from ./saver.ts so the config box can list the
// roster and the shell can read the prefs without pulling the savers
// themselves into the chunk: they load behind a dynamic import, the way DOOM
// does, and nothing here is heavier than a string.

/**
 * The roster, in the order the picker and the config box both show it.
 * ./saver.ts builds SAVERS in this order and asserts it stayed true, so a
 * saver added there without a name here fails loudly rather than silently
 * missing from CONFIG.
 */
export const SAVER_NAMES = [
  'matrix', 'pipes', 'worms', 'rain', 'stars', 'life', 'fire', 'dvd', 'fortune',
] as const

export type SaverName = (typeof SAVER_NAMES)[number]

export interface ScreensaverPrefs {
  enabled: boolean
  /** Idle minutes before the saver goes up. */
  minutes: number
  /** Which saver, by SAVER_NAMES entry. Unknown names fall back to the first. */
  saver: string
}
