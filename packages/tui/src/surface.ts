// A cell grid that renders to ANSI. Full paint on first render, minimal
// cursor-move + SGR runs after — the byte diet matters at baud rates.
//
// The planes and the drawing calls are the CRT grid's, cell for cell and
// argument for argument, so a widget written against one draws on the other
// without knowing which it has. See attrs.ts.

import { NORMAL, sgr } from './attrs.js'

/** Marks, joiners and variation selectors: no cell of their own. See text(). */
const ZERO_WIDTH = /[\p{M}\p{Cf}]/u

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What a widget needs to draw. Both Surface and the CRT's own CellGrid satisfy
 * it, which is why there is one copy of each widget rather than two.
 */
export interface Grid {
  cols: number
  rows: number
  attrs: Uint8Array
  /** The tube stores code points, a Surface stores characters. Read either. */
  chars: ArrayLike<string | number>
  /** Where the caret is parked, and whether there is one to park. */
  cx: number
  cy: number
  showCursor: boolean
  /** Picture cells, which a ground must not lift. A plain Surface has none. */
  gfx?: ArrayLike<unknown> | null
  /** The tube repaints on this; a Surface diffs instead and ignores it. */
  dirty?: boolean
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
  text(x: number, y: number, str: string, attr?: number, inv?: number): number
}

export class Surface implements Grid {
  chars: string[]
  attrs: Uint8Array
  inv: Uint8Array
  cx = 0
  cy = 0
  showCursor = true

  private prevChars: string[] | null = null
  private prevAttrs: Uint8Array | null = null
  private prevInv: Uint8Array | null = null
  private prevShowCursor: boolean | null = null

  constructor(public cols: number, public rows: number) {
    this.chars = new Array(cols * rows).fill(' ')
    this.attrs = new Uint8Array(cols * rows)
    this.inv = new Uint8Array(cols * rows)
  }

  clear(attr = NORMAL): void {
    this.chars.fill(' ')
    this.attrs.fill(attr)
    this.inv.fill(0)
  }

  put(x: number, y: number, ch: string | number, attr = NORMAL, inv = 0): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = y * this.cols + x
    this.chars[i] = typeof ch === 'number' ? String.fromCodePoint(ch) : ch
    this.attrs[i] = attr
    this.inv[i] = inv
  }

  /**
   * A cell per code point — except the ones that are no cells at all.
   *
   * A combining mark, a joiner or a variation selector folds into the character
   * before it on the parser's side. Given a cell here, the row is one column
   * longer than the row on the glass and everything past it is off by one; what
   * falls off the end is whatever the layout keeps at the right margin, and the
   * diff cannot find it because the diff compares against this. Text off a wire
   * is folded by `plain()` before it gets here — this is the floor under that.
   */
  text(x: number, y: number, str: string, attr = NORMAL, inv = 0): number {
    let cx = x
    for (const ch of str) {
      if (ZERO_WIDTH.test(ch)) continue
      this.put(cx++, y, ch, attr, inv)
    }
    return cx
  }

  fill(r: Rect, ch = ' ', attr = NORMAL, inv = 0): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) this.put(x, y, ch, attr, inv)
    }
  }

  /** Forget the previous frame; the next render repaints everything. */
  invalidate(): void {
    this.prevChars = null
    this.prevAttrs = null
    this.prevInv = null
    this.prevShowCursor = null
  }

  /** ANSI for what changed since the last render. */
  render(): string {
    let out = '\x1b[?25l'
    let run = -1
    const full = !this.prevChars

    if (full) out += '\x1b[2J'

    const same = (i: number): boolean => !full
      && this.chars[i] === this.prevChars![i]
      && this.attrs[i] === this.prevAttrs![i]
      && this.inv[i] === this.prevInv![i]

    for (let y = 0; y < this.rows; y++) {
      let x = 0
      while (x < this.cols) {
        if (same(y * this.cols + x)) { x++; continue }

        // Start of a changed run: move once, then stream cells.
        out += `\x1b[${y + 1};${x + 1}H`
        while (x < this.cols) {
          const j = y * this.cols + x
          if (same(j)) break
          // The inverse plane rides in the same run as the attribute byte.
          const cell = this.attrs[j] | (this.inv[j] ? 0x100 : 0)
          if (cell !== run) {
            run = cell
            out += sgr(this.attrs[j], this.inv[j])
          }
          out += this.chars[j]
          x++
        }
      }
    }

    out += `\x1b[0m\x1b[${this.cy + 1};${this.cx + 1}H`
    if (this.showCursor !== this.prevShowCursor) {
      out += this.showCursor ? '\x1b[?25h' : '\x1b[?25l'
    } else if (this.showCursor) {
      out += '\x1b[?25h'
    }

    this.prevChars = this.chars.slice()
    this.prevAttrs = this.attrs.slice()
    this.prevInv = this.inv.slice()
    this.prevShowCursor = this.showCursor
    return out
  }
}
