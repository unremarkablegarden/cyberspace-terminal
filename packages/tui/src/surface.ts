// A cell grid that renders to ANSI. Full paint on first render, minimal
// cursor-move + SGR runs after — the byte diet matters at baud rates.

export const NORMAL = 0
export const BOLD = 1
export const DIM = 2
export const INVERSE = 4

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const SGR: [number, string][] = [
  [BOLD, '1'],
  [DIM, '2'],
  [INVERSE, '7'],
]

function sgr(attr: number): string {
  const parts = SGR.filter(([bit]) => attr & bit).map(([, code]) => code)
  return `\x1b[0${parts.length ? ';' + parts.join(';') : ''}m`
}

export class Surface {
  chars: string[]
  attrs: Uint8Array
  cx = 0
  cy = 0
  cursorVisible = true

  private prevChars: string[] | null = null
  private prevAttrs: Uint8Array | null = null
  private prevCursorVisible: boolean | null = null

  constructor(public cols: number, public rows: number) {
    this.chars = new Array(cols * rows).fill(' ')
    this.attrs = new Uint8Array(cols * rows)
  }

  clear(attr = NORMAL): void {
    this.chars.fill(' ')
    this.attrs.fill(attr)
  }

  put(x: number, y: number, ch: string, attr = NORMAL): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = y * this.cols + x
    this.chars[i] = ch
    this.attrs[i] = attr
  }

  text(x: number, y: number, str: string, attr = NORMAL): number {
    let cx = x
    for (const ch of str) this.put(cx++, y, ch, attr)
    return cx
  }

  fill(r: Rect, ch = ' ', attr = NORMAL): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) this.put(x, y, ch, attr)
    }
  }

  /** Forget the previous frame; the next render repaints everything. */
  invalidate(): void {
    this.prevChars = null
    this.prevAttrs = null
    this.prevCursorVisible = null
  }

  /** ANSI for what changed since the last render. */
  render(): string {
    let out = '\x1b[?25l'
    let attr = -1
    const full = !this.prevChars

    if (full) out += '\x1b[2J'

    for (let y = 0; y < this.rows; y++) {
      let x = 0
      while (x < this.cols) {
        const i = y * this.cols + x
        const changed = full
          || this.chars[i] !== this.prevChars![i]
          || this.attrs[i] !== this.prevAttrs![i]
        if (!changed) { x++; continue }

        // Start of a changed run: move once, then stream cells.
        out += `\x1b[${y + 1};${x + 1}H`
        while (x < this.cols) {
          const j = y * this.cols + x
          const runChanged = full
            || this.chars[j] !== this.prevChars![j]
            || this.attrs[j] !== this.prevAttrs![j]
          if (!runChanged) break
          if (this.attrs[j] !== attr) {
            attr = this.attrs[j]
            out += sgr(attr)
          }
          out += this.chars[j]
          x++
        }
      }
    }

    out += `\x1b[0m\x1b[${this.cy + 1};${this.cx + 1}H`
    if (this.cursorVisible !== this.prevCursorVisible) {
      out += this.cursorVisible ? '\x1b[?25h' : '\x1b[?25l'
    } else if (this.cursorVisible) {
      out += '\x1b[?25h'
    }

    this.prevChars = this.chars.slice()
    this.prevAttrs = this.attrs.slice()
    this.prevCursorVisible = this.cursorVisible
    return out
  }
}
