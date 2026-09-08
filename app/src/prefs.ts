// Reads and writes the member's saved settings in localStorage.
// Applying any of them to the CRT or the audio bus is settings.ts.

import { PRESETS } from '@cyberspace/crt/config'
import { DEFAULT_KEY_PACK } from '@cyberspace/crt/keypacks'
import { SAVER_NAMES, type ScreensaverPrefs } from '@cyberspace/crt/saverdefs'
import { store } from './store'

/** Per-channel volumes, 0 to 1, and the name of the key-sound pack. */
export interface Audio { background: number; keys: number; beeps: number; pack: string }

export function readAudio(): Audio {
  const fallback: Audio = { background: 1, keys: 1, beeps: 1, pack: DEFAULT_KEY_PACK }
  try {
    return { ...fallback, ...JSON.parse(store.get('sound', '')) as Partial<Audio> }
  } catch {
    return fallback
  }
}

export function writeAudio(a: Audio): void {
  store.set('sound', JSON.stringify(a))
}

/** Idle-timeout values offered in the settings box, in minutes. */
export const SAVER_MINUTES = ['1', '2', '5', '10', '15', '30']

export function saverPrefs(): ScreensaverPrefs {
  const fallback: ScreensaverPrefs = { enabled: true, minutes: 10, saver: SAVER_NAMES[0] }
  try {
    return { ...fallback, ...JSON.parse(store.get('screensaver', '')) as Partial<ScreensaverPrefs> }
  } catch {
    return fallback
  }
}

export function setSaverPrefs(patch: Partial<ScreensaverPrefs>): void {
  store.set('screensaver', JSON.stringify({ ...saverPrefs(), ...patch }))
}

/** Preset name for a member's hand-tuned CRT parameters, as opposed to a built-in preset. */
export const USER_PRESET = 'user'

export function userParams(): Record<string, number> {
  try {
    return JSON.parse(store.get('crt.user', '')) as Record<string, number>
  } catch {
    return { ...PRESETS.sharp }
  }
}

export function writeUserParams(params: Record<string, number>): void {
  store.set('crt.user', JSON.stringify(params))
}

/** CRT parameters currently selected: a named preset, or the member's own. */
export function screenParams(): Record<string, number> {
  const preset = store.get('screen', 'sharp')
  if (preset === USER_PRESET) return userParams()
  return (PRESETS[preset as keyof typeof PRESETS] ?? PRESETS.sharp) as Record<string, number>
}

/** Phosphor name for the member's own tint, as opposed to a built-in one. */
export const CUSTOM_PHOSPHOR = 'custom'

/** Hue in degrees 0..360, saturation and lightness in percent 0..100. */
export interface Hsl { h: number; s: number; l: number }

/** The matrix tint (P1) in HSL, so custom starts from the default green. */
export const CUSTOM_PHOSPHOR_DEFAULT: Hsl = { h: 133, s: 100, l: 59 }

export function customPhosphor(): Hsl {
  try {
    const saved = JSON.parse(store.get('phosphor.custom', '')) as Partial<Hsl>
    return { ...CUSTOM_PHOSPHOR_DEFAULT, ...saved }
  } catch {
    return { ...CUSTOM_PHOSPHOR_DEFAULT }
  }
}

export function writeCustomPhosphor(hsl: Hsl): void {
  store.set('phosphor.custom', JSON.stringify(hsl))
}

/**
 * HSL to an [r, g, b] beam multiplier in 0..1.
 *
 * Not normalised to a brightest channel of 1.00 as the built-in tints are, so
 * lightness stays a real control: below 50 it dims the beam, above 50 it mixes
 * towards white.
 */
export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const sat = s / 100, lum = l / 100
  const c = (1 - Math.abs(2 * lum - 1)) * sat
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lum - c / 2
  const sector = Math.floor((((h % 360) + 360) % 360) / 60)
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][sector] ?? [0, 0, 0]
  return [r + m, g + m, b + m]
}

/** The phosphor currently selected, as the engine takes it: a name, or the custom tint. */
export function phosphorTint(): string | [number, number, number] {
  const name = store.get('phosphor', 'matrix')
  return name === CUSTOM_PHOSPHOR ? hslToRgb(customPhosphor()) : name
}
