// The phone key bar: a row of keys the soft keyboard lacks, under the canvas and
// above the soft keyboard. Phones only; an iPad keeps the desktop layout.
//
// Caps act on pointerdown with preventDefault, so focus stays in the hidden
// field and the soft keyboard stays up. Ported from the legacy /terminal page.

import { PHOSPHORS } from '@cyberspace/crt/config'
import { phosphorTint } from './prefs'
import type { Keyboard } from './input'

interface Cap {
  key: string
  cap: string
  label: string
  /** Arrow and symbol glyphs sit small in their em box and are set larger than lettered caps. */
  glyph?: boolean
}

/** ESC and TAB left of the arrows. No Enter: the soft keyboard has one. */
const PADS: Cap[] = [
  { key: 'Escape', cap: 'ESC', label: 'Escape' },
  { key: 'Tab', cap: 'TAB', label: 'Tab' },
  { key: 'ArrowLeft', cap: '←', label: 'Left', glyph: true },
  { key: 'ArrowRight', cap: '→', label: 'Right', glyph: true },
  { key: 'ArrowUp', cap: '↑', label: 'Up', glyph: true },
  { key: 'ArrowDown', cap: '↓', label: 'Down', glyph: true },
]

/** The rows while ^ is armed: the control keys the shell and job control read, F1 for the config box, and the clipboard. */
const CTRL_KEYS: Cap[][] = [
  [
    { key: 'c', cap: '^C', label: 'Interrupt' },
    { key: 'd', cap: '^D', label: 'End of file' },
    { key: 'z', cap: '^Z', label: 'Suspend' },
    { key: 'l', cap: '^L', label: 'Clear' },
    { key: 'u', cap: '^U', label: 'Kill line' },
    { key: 'w', cap: '^W', label: 'Kill word' },
  ],
  [
    { key: 'F1', cap: 'F1', label: 'Settings' },
    { key: 'copy', cap: 'COPY', label: 'Copy screen' },
    { key: 'paste', cap: 'PASTE', label: 'Paste' },
  ],
]

export interface Clipboard {
  /** The text on screen, for COPY. A phone has no Shift to make a selection with. */
  screen(): string
  paste(text: string): void
}

/**
 * Big layout height in CSS px: two rows of 44px caps, a 4px gap, 6px padding
 * top and bottom. Must match the #keys and .cap rules in index.html.
 */
const BIG_H = 44 * 2 + 4 + 12
/**
 * How far the big layout may shrink the canvas, in CSS px of height. An
 * iPhone 17 with the soft keyboard up is about 4px short of fitting it at
 * full width; 24px keeps the raster within 8% of full size.
 */
const BIG_SHRINK = 24

/** Beam levels for cap text and cap borders, as fractions of the phosphor colour. */
const CAP_FG = 0.78
const CAP_EDGE = 0.45

export class KeyBar {
  private armed = false
  /** Two rows with the arrows as an inverted T, used when the screen has room for it. */
  private big = false

  constructor(private el: HTMLElement, private keyboard: Keyboard, private clip: Clipboard) {
    this.render()
    this.tint()
    const vv = window.visualViewport
    if (vv) {
      // iOS pans the visual viewport instead of resizing it in some states;
      // offsetTop is the only place that shows, hence scroll as well as resize.
      const fit = () => {
        const kbd = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))
        document.documentElement.style.setProperty('--kbd', `${kbd}px`)
        // The big layout only when the 4:3 canvas at full width, less
        // BIG_SHRINK, still fits above it.
        const screen = this.el.parentElement!
        const big = screen.clientHeight - kbd - screen.clientWidth * 3 / 4 + BIG_SHRINK >= BIG_H
        if (big !== this.big) {
          this.big = big
          this.render()
        }
      }
      vv.addEventListener('resize', fit)
      vv.addEventListener('scroll', fit)
      fit()
    }
  }

  /** The armed ^, taken by the next typed character. Disarms. */
  takeCtrl(): boolean {
    if (!this.armed) return false
    this.disarm()
    return true
  }

  private render(): void {
    const mod = this.button('^', 'Control', true, () => {
      this.armed = !this.armed
      this.keyboard.wake()
      this.render()
    })
    mod.classList.add('mod')
    mod.classList.toggle('armed', this.armed)
    const caps = (row: Cap[]) => row.map(c => this.cap(c))
    const jobs = this.button('≡', 'Programs', true, () => this.keyboard.switcher())
    this.el.classList.toggle('big', this.big && !this.armed)
    if (this.big && !this.armed) {
      // Grid areas in index.html: ESC TAB and ^ ≡ on the left, the arrows as
      // an inverted T on the right.
      const all = [...caps(PADS), mod, jobs]
      const areas = ['esc', 'tab', 'left', 'right', 'up', 'down', 'mod', 'jobs']
      all.forEach((b, i) => { b.style.gridArea = areas[i]! })
      this.el.replaceChildren(...all)
      return
    }
    // In the big layout ^ sits bottom left, so it stays there while armed.
    const rows = this.armed
      ? [caps(CTRL_KEYS[0]!), this.big ? [mod, ...caps(CTRL_KEYS[1]!)] : [...caps(CTRL_KEYS[1]!), mod]]
      : [[...caps(PADS), mod, jobs]]
    this.el.replaceChildren(...rows.map(r => {
      const div = document.createElement('div')
      div.className = 'row'
      div.append(...r)
      return div
    }))
  }

  private cap(c: Cap): HTMLButtonElement {
    if (c.key === 'copy' || c.key === 'paste') {
      // Clipboard access needs transient user activation, which iOS grants on
      // click and not on pointerdown. pointerdown still cancels the focus move.
      const b = this.button(c.cap, c.label, false, () => {})
      b.addEventListener('click', () => {
        this.disarm()
        this.keyboard.wake()
        if (c.key === 'copy') void navigator.clipboard?.writeText(this.clip.screen()).catch(() => {})
        else void navigator.clipboard?.readText().then(t => { if (t) this.clip.paste(t) }).catch(() => {})
      })
      return b
    }
    return this.button(c.cap, c.label, !!c.glyph, () => this.press(c))
  }

  private disarm(): void {
    if (!this.armed) return
    this.armed = false
    this.render()
  }

  private press(c: Cap): void {
    const ctrl = this.armed && c.key.length === 1
    this.disarm()
    if (c.key === 'F1') this.keyboard.settings()
    else this.keyboard.tap(c.key, ctrl)
  }

  private button(cap: string, label: string, glyph: boolean, act: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = glyph ? 'cap glyph' : 'cap'
    b.textContent = cap
    b.setAttribute('aria-label', label)
    b.addEventListener('pointerdown', e => {
      e.preventDefault()
      act()
      // A phosphor can only change through the config box, and on a phone the
      // config box is driven from these caps, so this is the one place to recheck.
      this.tint()
    })
    return b
  }

  /** Colour the caps from the live phosphor. They are DOM buttons outside the canvas, so the CRT cannot draw them. */
  private tint(): void {
    const t = phosphorTint()
    const rgb = typeof t === 'string' ? PHOSPHORS[t] ?? PHOSPHORS.matrix! : t
    const at = (level: number) => `rgb(${rgb.map(c => Math.round(c * level * 255)).join(' ')})`
    this.el.style.setProperty('--cap-fg', at(CAP_FG))
    this.el.style.setProperty('--cap-edge', at(CAP_EDGE))
  }
}
