// A 1-bit framebuffer at the face's pixel resolution, read back as per-cell
// bitmaps for the picture handles (see pict.ts).
//
// Braille gives 2x4 dots per cell; a cell bitmap gives cellW x cellH, so a
// line drawn here is as fine as the face itself. The canvas is cols*advance
// wide: the join column between cells is part of the coordinate space, and a
// pixel that lands on it is folded into the cell's rightmost bit, which the
// CRT extends across the gap for bitmaps (term.js joinCol).

import type { CellMetrics } from './image.js'

/** A bitmap face as the CRT parses one: rows per glyph, bit (cellW-1) leftmost. */
export interface PixelFont {
  cellW: number
  cellH: number
  glyphs: Map<number, ArrayLike<number>>
}

export class PixelCanvas {
  readonly cols: number
  readonly rows: number
  /** Size in pixels, across and down. */
  readonly w: number
  readonly h: number
  /** x correction: a displayed pixel is `stretch` times taller than wide. */
  readonly aspect: number

  private readonly cellW: number
  private readonly cellH: number
  private readonly advance: number
  private px: Uint8Array

  constructor(m: CellMetrics, cols: number, rows: number) {
    this.cols = Math.max(1, cols | 0)
    this.rows = Math.max(1, rows | 0)
    this.cellW = m.cellW
    this.cellH = m.cellH
    this.advance = m.advance
    this.w = this.cols * m.advance
    this.h = this.rows * m.cellH
    this.aspect = m.stretch ?? 1
    this.px = new Uint8Array(this.w * this.h)
  }

  clear() {
    this.px.fill(0)
  }

  plot(x: number, y: number) {
    x |= 0
    y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.px[y * this.w + x] = 1
  }

  /** Draw one line, Bresenham. */
  line(x0: number, y0: number, x1: number, y1: number) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    // Guards against a line with both endpoints far off screen, which would
    // otherwise iterate the whole distance plotting nothing.
    let guard = this.w + this.h + Math.abs(dx) + Math.abs(dy)
    for (;;) {
      this.plot(x0, y0)
      if ((x0 === x1 && y0 === y1) || guard-- <= 0) return
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }

  /** Whether the pixel is lit; false off the canvas. */
  lit(x: number, y: number): boolean {
    x |= 0
    y |= 0
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.px[y * this.w + x] === 1
  }

  /** Light the pixels from x0 inclusive to x1 exclusive on row y, clipped. */
  hspan(y: number, x0: number, x1: number) {
    y |= 0
    if (y < 0 || y >= this.h) return
    const a = Math.max(0, x0 | 0), b = Math.min(this.w, x1 | 0)
    if (a < b) this.px.fill(1, y * this.w + a, y * this.w + b)
  }

  /** Lit pixels in one cell, out of cellW x cellH. */
  count(cx: number, cy: number): number {
    const { cellW, cellH, advance, w } = this
    let n = 0
    for (let y = 0; y < cellH; y++) {
      let p = (cy * cellH + y) * w + cx * advance
      for (let x = 0; x < cellW; x++, p++) n += this.px[p]!
    }
    return n
  }

  /** Pixels a cell holds, the denominator of count(). */
  get cellArea(): number {
    return this.cellW * this.cellH
  }

  /** Clear a rectangle, clipped to the canvas. */
  erase(x: number, y: number, w: number, h: number) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0)
    const x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0)
    for (let yy = y0; yy < y1; yy++) this.px.fill(0, yy * this.w + x0, yy * this.w + x1)
  }

  /** Draw a string in a bitmap face with its top left at x, y. Unknown code points are skipped. */
  text(x: number, y: number, str: string, font: PixelFont) {
    let cx = x | 0
    for (const ch of str) {
      const glyph = font.glyphs.get(ch.codePointAt(0)!)
      if (glyph) {
        for (let gy = 0; gy < font.cellH; gy++) {
          const row = glyph[gy] ?? 0
          for (let gx = 0; gx < font.cellW; gx++) {
            if ((row >>> (font.cellW - 1 - gx)) & 1) this.plot(cx + gx, (y | 0) + gy)
          }
        }
      }
      cx += font.cellW
    }
  }

  /**
   * The bitmap of one cell, or undefined when nothing in it is lit. One word
   * per row, bit (cellW-1) leftmost, the layout putGlyph takes.
   */
  cell(cx: number, cy: number): Uint16Array | undefined {
    const { cellW, cellH, advance, w } = this
    let lit = 0
    const bits = new Uint16Array(cellH)
    const x0 = cx * advance
    for (let y = 0; y < cellH; y++) {
      let row = 0
      let p = (cy * cellH + y) * w + x0
      for (let x = 0; x < cellW; x++, p++) row = (row << 1) | this.px[p]!
      // The join column, when the advance leaves one.
      if (advance > cellW && this.px[p]) row |= 1
      bits[y] = row
      lit |= row
    }
    return lit ? bits : undefined
  }
}
