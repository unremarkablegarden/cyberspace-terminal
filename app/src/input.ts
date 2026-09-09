// Input from the operator: the physical keyboard, the phone keyboard, and the
// key sound each keypress makes.

import type { Tty } from '@cyberspace/kernel'
import type { KeyInput } from '@cyberspace/tui'
import { bytes } from '@cyberspace/kernel'
import type { Sound } from '@cyberspace/crt/audio'
import { softKeydownWanted, softInputKeys, SENTINEL } from '@cyberspace/crt/softkeys'
import { aliasKey, encodeKey, encodeKeyName } from './keys'
import { hostModifier, MAC } from './config'
import type { Baud } from './baud'
import type { Scrollback } from './scrollback'
import type { ConfigBox } from './settings'
import type { JobPalette } from './palette'

/** A screen covering the machine that takes every key: the config box, the screensaver. */
export interface Overlay {
  readonly open: boolean
  key(k: KeyInput): void
  silentKey(k: KeyInput): boolean
}

export interface KeyboardDeps {
  tty: Tty
  tx: Baud
  snd: Sound
  scroll: Scrollback
  config: () => ConfigBox | null
  /** The job switcher. CMD-K (CTRL-K off a Mac) opens and steps it; letting the modifier go chooses. */
  palette: () => JobPalette | null
  /** The overlay taking keys, if any. The config box when open, else the screensaver when up. */
  overlay: () => Overlay | null
  /** Any input path: a key or a pointer press. Feeds the idle timer. */
  activity?: () => void
  /** ^C during the cold boot skips it. Answers whether it took the key. */
  skipBoot: () => boolean
  /** Any key switches a machine in standby on. Answers whether it took the key. */
  powerOn: () => boolean
  /** True once a shell is reading the tty. Before that, keys and pastes are dropped. */
  live: () => boolean
  /**
   * Each physical keydown, with its auto-repeat flag. A held key plays no click
   * (the repeat is dropped); the host instead bleeps the screen change the
   * repeat causes, so a hold chatters like output. See main.ts.
   */
  markRepeat?: (repeat: boolean) => void
}

/** Keys that are only a modifier, which do not count as a keypress in standby. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

export class Keyboard {
  private woken = false

  constructor(private d: KeyboardDeps) {}

  /** Browsers only start an audio context from a user gesture, so every input path calls this. */
  wake(): void {
    this.d.activity?.()
    this.d.snd.resume()
    if (!this.woken) {
      this.woken = true
      this.d.snd.start()
    }
  }

  /** A pointer press on the canvas: unlocks audio and, in standby, switches the machine on. */
  pointer(): void {
    this.wake()
    this.d.powerOn()
  }

  /**
   * Play the key sound for one keypress, before anything dispatches it.
   *
   * Every key sounds, including keys the machine ignores: Escape, modifiers,
   * F-keys, browser-reserved chords. Called once here rather than in each
   * branch that handles a key, so no branch can omit it.
   *
   * Skipped when the component on screen makes its own sound for that key. The
   * config box ticks as the selection moves and the scrollback ticks as it
   * scrolls, so one keypress never makes two sounds.
   *
   * Auto-repeat is not filtered here; Sound.key drops repeats.
   */
  click(e: { key: string; repeat?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): void {
    const overlay = this.d.overlay()
    if (overlay?.open) {
      if (!overlay.silentKey(keyInput(e.key, !!e.ctrlKey, !!e.shiftKey))) this.d.snd.key(e)
      return
    }
    if (this.d.tty.isSilent(e.key)) return
    if (this.d.scroll.moves(e.key, !!e.ctrlKey, !!e.shiftKey)) return
    this.d.snd.key(e)
  }

  /** A key by name, from the soft keyboard or from the config box's own handling. */
  press(name: string, ctrl = false, shift = false): void {
    if (this.d.powerOn()) return
    const overlay = this.d.overlay()
    if (!overlay?.open && this.d.scroll.key(name, ctrl, shift)) return
    if (overlay?.open) {
      overlay.key(keyInput(name, ctrl, shift))
      return
    }
    const s = encodeKeyName(name, ctrl)
    if (s === null) return
    if (s === '\x03' && this.d.skipBoot()) return
    if (!this.d.live()) return
    if (s === '\x03') this.d.tx.flush()
    this.d.tty.input(bytes(s))
  }

  /** A key from the real keyboard, event and all. */
  key(ev: KeyboardEvent): void {
    this.wake()
    const e = aliasKey(ev)
    if (e !== ev) ev.preventDefault()
    // Standby takes the key and nothing else acts on it. No key sound: the audio
    // context is still suspended here, and the press is answered by powerOn().
    // Bare modifiers and browser chords (Cmd-R, ^W) are not the switch.
    if (!MODIFIERS.has(e.key) && !e.metaKey && !e.ctrlKey && this.d.powerOn()) {
      e.preventDefault()
      return
    }
    // ev, not e: aliasKey drops the repeat flag when it rewrites the event.
    this.d.markRepeat?.(!!ev.repeat)
    // The switcher before the key click: it ticks for itself. The chord is
    // Cmd+K on a Mac and Ctrl+K elsewhere, as on the site. e.code, not e.key:
    // with Option or AltGr held the character is the layout's, not the letter.
    if (hostModifier(e) && !e.altKey && e.code === 'KeyK') {
      e.preventDefault()
      const palette = this.d.palette()
      const overlay = this.d.overlay()
      if (palette && this.d.live() && (!overlay?.open || overlay === palette)) {
        palette.step(e.shiftKey ? -1 : 1)
      }
      return
    }
    this.click(e)
    // ^C skips the cold boot. Kept out of the tty: no shell exists yet.
    if (e.ctrlKey && e.key === 'c' && this.d.skipBoot()) {
      e.preventDefault()
      return
    }
    const config = this.d.config()
    const overlay = this.d.overlay()
    // F1 opens the config box, except over the screensaver, which takes the
    // key like any other and wakes.
    if (e.key === 'F1' && (!overlay?.open || overlay === config)) {
      e.preventDefault()
      config?.toggle()
      return
    }
    if (!overlay?.open && this.d.scroll.key(e.key, e.ctrlKey, e.shiftKey)) {
      e.preventDefault()
      return
    }
    if (overlay?.open) {
      e.preventDefault()
      this.press(e.key, e.ctrlKey, e.shiftKey)
      return
    }
    const str = encodeKey(e)
    if (str === null) return
    e.preventDefault()
    if (!this.d.live()) return
    // ^C also discards output still queued in the rate limiter.
    if (str === '\x03') this.d.tx.flush()
    this.d.tty.input(bytes(str))
  }

  /** A key released. Only the switcher's modifier matters: letting go takes its row. */
  keyUp(e: KeyboardEvent): void {
    if (e.key === (MAC ? 'Meta' : 'Control')) this.d.palette()?.release()
  }

  /** Pasted text goes in as if typed. */
  paste(text: string): void {
    this.wake()
    if (this.d.overlay()?.open || !this.d.live()) return
    this.d.tty.input(bytes(text.replace(/\r\n?/g, '\r')))
  }

  /**
   * The phone keyboard: a transparent textarea covering the canvas.
   *
   * iOS fires no keydown for ordinary characters, so beforeinput carries most
   * of them. The field is reset to a one-character sentinel after every event
   * so backspace always has something to delete and reports as a keypress.
   */
  wireSoftKeyboard(canvas: HTMLCanvasElement): void {
    const field = document.createElement('textarea')
    field.setAttribute('autocapitalize', 'off')
    field.setAttribute('autocomplete', 'off')
    field.setAttribute('autocorrect', 'off')
    field.setAttribute('spellcheck', 'false')
    field.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;opacity:0;border:0;padding:0;' +
      'background:transparent;color:transparent;caret-color:transparent;z-index:10;resize:none'
    field.value = SENTINEL
    document.body.appendChild(field)

    const reset = () => {
      field.value = SENTINEL
      field.setSelectionRange(1, 1)
    }

    canvas.addEventListener('pointerdown', () => {
      this.pointer()
      field.focus()
    })
    field.addEventListener('pointerdown', () => this.pointer())

    field.addEventListener('keydown', e => {
      const a = aliasKey(e)
      if (a === e && !softKeydownWanted(e)) return
      e.preventDefault()
      this.click(a)
      this.press(a.key, a.ctrlKey, a.shiftKey)
    })
    field.addEventListener('beforeinput', e => {
      e.preventDefault()
      const r = softInputKeys(e.inputType, (e as InputEvent).data)
      if (r.kind === 'keys') {
        for (const k of r.keys) {
          this.click({ key: k })
          this.press(k)
        }
      }
      reset()
    })
    field.addEventListener('input', reset)
  }
}

const keyInput = (key: string, ctrlKey: boolean, shiftKey: boolean) =>
  ({ key, ctrlKey, shiftKey, metaKey: false, altKey: false })
