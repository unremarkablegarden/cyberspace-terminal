// A cell grid that renders to ANSI. Full paint on the first render, then
// cursor moves and SGR runs for changed cells only, which keeps the byte count
// low enough to matter at the output rate.
//
// The planes and drawing calls mirror the CRT grid cell for cell and argument
// for argument, so one copy of each widget draws on either. See attrs.ts.

import { NORMAL, sgr } from './attrs.js'

/** Combining marks, joiners and variation selectors, which occupy no cell. See text(). */
const ZERO_WIDTH = /[\p{M}\p{Cf}]/u

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The drawing surface a widget requires. Both Surface and the CRT's CellGrid
 * satisfy it, so each widget exists once rather than twice.
 */
export interface Grid {
  cols: number
  rows: number
  attrs: Uint8Array
  /** Code points on the CRT grid, characters on a Surface. Either can be read. */
  chars: ArrayLike<string | number>
  /** Caret position, and whether a caret is shown. */
  cx: number
  cy: number
  showCursor: boolean
  /** Picture cells, which a background must not highlight. Absent on a plain Surface. */
  gfx?: ArrayLike<unknown> | null
  /** Repaint flag used by the CRT grid. A Surface diffs instead and ignores it. */
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
   * One cell per code point, except code points that occupy no cell.
   *
   * A combining mark, joiner or variation selector folds into the preceding
   * character on the parser's side. Giving it a cell here makes this row one
   * column longer than the rendered row, so everything after it is off by one
   * and whatever the layout holds at the right margin is lost. The diff cannot
   * detect it, since the diff compares against this. Text from the network is
   * folded by plain() before it arrives; this is the backstop.
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

  /** Discard the previous frame, so the next render repaints in full. */
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

        // Start of a changed run: move the cursor once, then write cells.
        out += `\x1b[${y + 1};${x + 1}H`
        while (x < this.cols) {
          const j = y * this.cols + x
          if (same(j)) break
          // The inverse plane is carried in the same run as the attribute byte.
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
