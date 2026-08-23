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
