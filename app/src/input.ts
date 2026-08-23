// Input from the operator: the physical keyboard, the phone keyboard, and the
// key sound each keypress makes.

import type { Tty } from '@cyberspace/kernel'
import { bytes } from '@cyberspace/kernel'
import type { Sound } from '@cyberspace/crt/audio'
import { softKeydownWanted, softInputKeys, SENTINEL } from '@cyberspace/crt/softkeys'
import { encodeKey, encodeKeyName } from './keys'
import type { Baud } from './baud'
import type { Scrollback } from './scrollback'
import type { ConfigBox } from './settings'

export interface KeyboardDeps {
  tty: Tty
  tx: Baud
  snd: Sound
  scroll: Scrollback
  config: () => ConfigBox | null
  /** ^C during the cold boot skips it. Answers whether it took the key. */
  skipBoot: () => boolean
}

export class Keyboard {
  private woken = false

  constructor(private d: KeyboardDeps) {}

  /** Browsers only start an audio context from a user gesture, so every input path calls this. */
  wake(): void {
    this.d.snd.resume()
    if (!this.woken) {
      this.woken = true
      this.d.snd.start()
    }
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
    const config = this.d.config()
    if (config?.open) {
      if (!config.silentKey(keyInput(e.key, !!e.ctrlKey, !!e.shiftKey))) this.d.snd.key(e)
      return
    }
    if (this.d.tty.isSilent(e.key)) return
    if (this.d.scroll.moves(e.key, !!e.ctrlKey, !!e.shiftKey)) return
    this.d.snd.key(e)
  }

  /** A key by name, from the soft keyboard or from the config box's own handling. */
  press(name: string, ctrl = false, shift = false): void {
    const config = this.d.config()
    if (!config?.open && this.d.scroll.key(name, ctrl, shift)) return
    if (config?.open) {
      config.key(keyInput(name, ctrl, shift))
      return
    }
    const s = encodeKeyName(name, ctrl)
    if (s === null) return
    if (s === '\x03' && this.d.skipBoot()) return
    if (s === '\x03') this.d.tx.flush()
    this.d.tty.input(bytes(s))
  }

  /** A key from the real keyboard, event and all. */
  key(e: KeyboardEvent): void {
    this.wake()
    this.click(e)
    // ^C skips the cold boot. Kept out of the tty: no shell exists yet.
    if (e.ctrlKey && e.key === 'c' && this.d.skipBoot()) {
      e.preventDefault()
      return
    }
    const config = this.d.config()
    if (e.key === 'F1') {
      e.preventDefault()
      config?.toggle()
      return
    }
    if (!config?.open && this.d.scroll.key(e.key, e.ctrlKey, e.shiftKey)) {
      e.preventDefault()
      return
    }
    if (config?.open) {
      e.preventDefault()
      this.press(e.key, e.ctrlKey, e.shiftKey)
      return
    }
    const str = encodeKey(e)
    if (str === null) return
    e.preventDefault()
    // ^C also discards output still queued in the rate limiter.
    if (str === '\x03') this.d.tx.flush()
    this.d.tty.input(bytes(str))
  }

  /** Pasted text goes in as if typed. */
  paste(text: string): void {
    this.wake()
    if (this.d.config()?.open) return
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
      this.wake()
      field.focus()
    })
    field.addEventListener('pointerdown', () => this.wake())

    field.addEventListener('keydown', e => {
      if (!softKeydownWanted(e)) return
      e.preventDefault()
      this.click(e)
      this.press(e.key, e.ctrlKey, e.shiftKey)
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
