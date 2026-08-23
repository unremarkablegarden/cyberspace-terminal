// The screensaver names and preferences, shared between the engine and the page.
//
// Split from ./saver.ts so the config box can list the roster and the shell can
// read the preferences without pulling the savers into the same chunk; they load
// behind a dynamic import, and nothing here is larger than a string.

/**
 * The roster, in the order the picker and the config box display it.
 *
 * ./saver.ts builds SAVERS in this order and asserts they match, so a saver
 * added there without a name here fails at startup rather than being silently
 * absent from CONFIG.
 */
export const SAVER_NAMES = [
  'matrix', 'pipes', 'worms', 'rain', 'stars', 'life', 'fire', 'dvd', 'fortune',
] as const

export type SaverName = (typeof SAVER_NAMES)[number]

export interface ScreensaverPrefs {
  enabled: boolean
  /** Idle minutes before the saver starts. */
  minutes: number
  /** Which saver, as a SAVER_NAMES entry. An unknown name falls back to the first. */
  saver: string
}
