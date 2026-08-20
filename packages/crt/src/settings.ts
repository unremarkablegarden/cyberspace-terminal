// The CONFIG box (F1). Faceplate-owned: it tunes the local tube, so it draws
// straight onto the Term planes over whatever the machine is showing. The host
// pauses its own grid writes while the box is open and repaints after.
//
// Two panes: settings left, the focused setting's values right. Left/Right
// move between panes, Up/Down within one. A value applies the moment the
// selection lands on it; there is nothing to confirm. Escape means done.

import { NORMAL, BRIGHT, BOLD, DIM, BG } from './term.js'

export interface SettingDef {
  name: string
  values(): string[]
  current(): string
  apply(value: string): void
}

interface TermLike {
  cols: number
  rows: number
  dirty: boolean
  attrs: Uint8Array
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
  text(x: number, y: number, str: string, attr?: number, inv?: number): number
}

export class SettingsOverlay {
  open = false
  onChange: (() => void) | null = null

  private row = 0
  private pane: 0 | 1 = 0

  constructor(private term: TermLike, private settings: SettingDef[]) {}

  toggle(): void {
    this.open = !this.open
    if (this.open) {
      this.pane = 0
      this.draw()
    }
    this.term.dirty = true
  }

  hide(): void {
    this.open = false
    this.term.dirty = true
  }

  /** Handle a key while open. Returns false only for keys the box ignores. */
  key(k: string): boolean {
    if (!this.open) return false
    switch (k) {
      case 'Escape':
      case 'F1':
        this.hide()
        return true
      case 'ArrowLeft':
        this.pane = 0
        this.draw()
        return true
      case 'ArrowRight':
      case 'Enter':
        this.pane = 1
        this.draw()
        return true
      case 'ArrowUp':
      case 'ArrowDown': {
        const d = k === 'ArrowUp' ? -1 : 1
        if (this.pane === 0) {
          this.row = Math.min(this.settings.length - 1, Math.max(0, this.row + d))
        } else {
          const s = this.settings[this.row]
          const values = s.values()
          const i = Math.max(0, values.indexOf(s.current())) + d
          if (i >= 0 && i < values.length) {
            s.apply(values[i])
            this.onChange?.()
          }
        }
        this.draw()
        return true
      }
      default:
        return true // swallowed: keys must not reach the machine underneath
    }
  }

  draw(): void {
    if (!this.open) return
    const t = this.term
    const s = this.settings[this.row]
    const values = s.values()

    const nameW = Math.max(...this.settings.map(x => x.name.length))
    const curW = Math.max(...this.settings.map(x => x.current().length), 1)
    const leftW = nameW + 2 + curW
    const rightW = Math.max(...values.map(v => v.length), 8)
    const w = Math.min(t.cols - 2, leftW + rightW + 9)
    const h = Math.max(this.settings.length, values.length) + 4
    const x0 = (t.cols - w) >> 1
    const y0 = Math.max(0, (t.rows - h) >> 1)

    // Frame.
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        let ch = ' '
        if (y === y0 || y === y0 + h - 1) ch = '─'
        if (x === x0 || x === x0 + w - 1) ch = '│'
        if (y === y0 && x === x0) ch = '┌'
        if (y === y0 && x === x0 + w - 1) ch = '┐'
        if (y === y0 + h - 1 && x === x0) ch = '└'
        if (y === y0 + h - 1 && x === x0 + w - 1) ch = '┘'
        t.put(x, y, ch, NORMAL)
      }
    }
    t.text(x0 + 2, y0, ' CONFIG ', BRIGHT | BOLD)
    t.text(x0 + 2, y0 + h - 1, ' ‹› pane  ↑↓ move  ESC done ', DIM)

    const divX = x0 + leftW + 4
    for (let y = y0 + 1; y < y0 + h - 1; y++) t.put(divX, y, '│', DIM)

    // Left pane: names and current values.
    for (let i = 0; i < this.settings.length; i++) {
      const it = this.settings[i]
      const sel = i === this.row
      const inv = sel && this.pane === 0 ? 1 : 0
      const label = ' ' + it.name.padEnd(nameW) + '  ' + it.current().padEnd(curW) + ' '
      t.text(x0 + 2, y0 + 2 + i, label, sel ? BRIGHT | BOLD : NORMAL, inv)
    }

    // Right pane: the focused setting's values.
    for (let i = 0; i < values.length; i++) {
      const cur = values[i] === s.current()
      const inv = cur && this.pane === 1 ? 1 : 0
      t.text(divX + 2, y0 + 2 + i, ' ' + values[i].padEnd(rightW) + ' ',
        cur ? BRIGHT | BOLD : NORMAL, inv)
    }

    // Ground the whole rect last, so no cell of the panel is a hole.
    for (let y = y0; y < y0 + h; y++) {
      const base = y * t.cols
      for (let x = x0; x < x0 + w; x++) t.attrs[base + x] |= BG
    }
    t.dirty = true
  }
}
