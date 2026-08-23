// The settings box that F1 opens, and restoring saved settings at boot.

import type { CrtScreen } from '@cyberspace/crt'
import { RENDER, PRESETS } from '@cyberspace/crt/config'
import type { Sound } from '@cyberspace/crt/audio'
import {
  FONT_ENTRIES, fontFace, fontLabel, familyOf, loadFamily,
} from '@cyberspace/crt/fonts'
import { SettingsOverlay, type Setting } from '@cyberspace/crt/settings'
import { KEY_PACK_NAMES } from '@cyberspace/crt/keypacks'
import { CRT_CONTROLS } from '@cyberspace/crt/controls'
import { SAVER_NAMES } from '@cyberspace/crt/saverdefs'
import type { KeyInput } from '@cyberspace/tui'
import { store } from './store'
import { grid } from './grid'
import {
  SAVER_MINUTES, USER_PRESET, readAudio, saverPrefs, screenParams, setSaverPrefs,
  userParams, writeAudio, writeUserParams,
} from './prefs'

/** Volume steps offered by the AUDIO rows, and the gain each maps to. */
const AUDIO_LEVELS: [string, number][] = [['off', 0], ['25%', 0.25], ['50%', 0.5], ['100%', 1]]

const levelLabel = (v: number): string =>
  AUDIO_LEVELS.reduce((best, [label, level]) =>
    Math.abs(level - v) < Math.abs(AUDIO_LEVELS.find(l => l[0] === best)![1] - v) ? label : best,
  AUDIO_LEVELS[0][0])

function setUserParam(screen: CrtScreen, key: string, value: number): void {
  const params = { ...userParams(), [key]: value }
  writeUserParams(params)
  // Adjusting a knob also selects the user preset, so the change takes effect
  // at once rather than after the operator selects that preset by hand.
  store.set('screen', USER_PRESET)
  screen.crt.setParams(params)
}

function resetUserParam(screen: CrtScreen, key?: string): void {
  const base = PRESETS.sharp as Record<string, number>
  const params = key ? { ...userParams(), [key]: base[key] ?? 0 } : { ...base }
  writeUserParams(params)
  screen.crt.setParams(params)
}

/**
 * The settings list, rebuilt on every open rather than cached.
 *
 * `current` is a getter on every row because the authoritative value is in
 * storage, not in the box: saving a preset extends the SCREEN list, and the
 * shell can change any of these while the box is closed.
 */
function settings(screen: CrtScreen, snd: Sound): Setting[] {
  const channel = (name: 'background' | 'keys' | 'beeps'): Setting => ({
    label: name,
    values: AUDIO_LEVELS.map(([label]) => label),
    current: () => levelLabel(snd.channel(name)),
    select: (value) => {
      const level = AUDIO_LEVELS.find(([label]) => label === value)?.[1] ?? 0
      snd.setChannel(name, level)
      const next = readAudio()
      next[name] = level
      writeAudio(next)
      return value
    },
  })

  return [
    {
      // Listed by label rather than face name: a family's regular, bold and
      // oblique cuts share a label and would otherwise be three identical rows.
      label: 'FONT',
      values: FONT_ENTRIES.map(e => e.label),
      current: () => fontLabel(store.get('font', 'terminus-8x16')),
      // The only async setting: the font is fetched and parsed. A failed load
      // returns the font still in use.
      select: async (label) => {
        const name = fontFace(label)
        try {
          await loadFamily(screen.term, familyOf(name))
          screen.crt.setSource(screen.term.w, screen.term.h)
          store.set('font', name)
          return label
        } catch {
          return fontLabel(store.get('font', 'terminus-8x16'))
        }
      },
    },
    {
      label: 'SCREEN',
      values: [...Object.keys(PRESETS), USER_PRESET],
      current: () => store.get('screen', 'sharp'),
      select: (value) => {
        store.set('screen', value)
        screen.crt.setParams(screenParams())
        return value
      },
      // Only the user preset has knobs to open; the built-in presets are fixed.
      tune: value => value !== USER_PRESET ? null : {
        title: USER_PRESET.toUpperCase(),
        groups: CRT_CONTROLS,
        get: key => userParams()[key] ?? 0,
        set: (key, v) => setUserParam(screen, key, v),
        reset: key => resetUserParam(screen, key),
      },
    },
    {
      label: 'PHOSPHOR',
      values: ['matrix', 'vt320', 'brutalist', 'bubblegum', 'white'],
      current: () => store.get('phosphor', 'matrix'),
      select: (value) => {
        store.set('phosphor', value)
        screen.crt.setPhosphor(value)
        return value
      },
    },
    {
      label: 'AUDIO',
      values: [],
      // A group row has no value of its own, so it reports the three channels
      // below it: their shared level, or "mixed" when they differ.
      current: () => {
        const labels = (['background', 'keys', 'beeps'] as const).map(c => levelLabel(snd.channel(c)))
        return labels.every(l => l === labels[0]) ? labels[0] : 'mixed'
      },
      select: v => v,
      children: [
        channel('background'),
        channel('keys'),
        channel('beeps'),
        // Selects the key-sound pack rather than a volume, unlike the other rows
        // in this group. Placed under keys, which sets its volume.
        {
          label: 'keyboard',
          values: KEY_PACK_NAMES,
          current: () => snd.keyPackName,
          select: (value) => {
            const name = snd.setKeyPack(value)
            const next = readAudio()
            next.pack = name
            writeAudio(next)
            return name
          },
        },
      ],
    },
    {
      label: 'SCREENSAVER',
      values: [],
      // Reports enabled state and timeout in one word; the saver itself is
      // chosen in the rows below.
      current: () => saverPrefs().enabled ? `${saverPrefs().minutes}min` : 'off',
      select: v => v,
      children: [
        {
          label: 'enabled',
          values: ['on', 'off'],
          current: () => saverPrefs().enabled ? 'on' : 'off',
          select: (v) => { setSaverPrefs({ enabled: v === 'on' }); return v },
        },
        {
          label: 'after',
          values: SAVER_MINUTES,
          current: () => String(saverPrefs().minutes),
          select: (v) => { setSaverPrefs({ minutes: Number(v) || 10 }); return v },
        },
        {
          label: 'saver',
          values: [...SAVER_NAMES],
          current: () => saverPrefs().saver,
          select: (v) => { setSaverPrefs({ saver: v }); return v },
        },
      ],
    },
  ]
}

/**
 * The settings box. Holds the grid lock and the caret while it is open.
 *
 * The render loop writes showCursor from RENDER.cursor on every frame, so a
 * screen that clears showCursor itself has it restored a frame later. Setting
 * RENDER.cursor here is the only way to keep the caret hidden.
 */
export class ConfigBox {
  private overlay: SettingsOverlay
  /** RENDER.cursor as it was before the box opened, restored on close. */
  private cursorWas = true

  constructor(screen: CrtScreen, snd: Sound) {
    this.overlay = new SettingsOverlay(screen.term, () => settings(screen, snd))
    this.overlay.onFeedback = kind => {
      if (kind === 'edge') snd.beep(220, 0.04)
      // Same close sound the other screens use.
      else if (kind === 'cancel') snd.blip(420, 0.09, 0)
      else snd.tick()
    }
  }

  get open(): boolean {
    return this.overlay.open
  }

  toggle(): void {
    if (this.overlay.open) {
      this.overlay.hide()
      this.release()
      return
    }
    grid.lock()
    this.cursorWas = RENDER.cursor
    RENDER.cursor = false
    this.overlay.toggle()
  }

  /** Handle one key. Escape and F1 close the box. */
  key(k: KeyInput): void {
    this.overlay.key(k)
    if (!this.overlay.open) this.release()
  }

  /** Whether the box plays its own sound for this key, so the host skips the key click. */
  silentKey(k: KeyInput): boolean {
    return this.overlay.silentKey(k)
  }

  private release(): void {
    grid.unlock()
    RENDER.cursor = this.cursorWas
  }
}

/** Apply saved preferences to the CRT and the audio bus at boot. */
export function restoreSettings(screen: CrtScreen, snd: Sound): void {
  const audio = readAudio()
  snd.setChannel('background', audio.background)
  snd.setChannel('keys', audio.keys)
  snd.setChannel('beeps', audio.beeps)
  snd.setKeyPack(audio.pack)

  screen.crt.setParams(screenParams())
  screen.crt.setPhosphor(store.get('phosphor', 'matrix'))
}
