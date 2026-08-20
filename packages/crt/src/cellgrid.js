// Cell grid: character, attribute, inverse and bitmap planes, cursor,
// scrollback. The framebuffer, the font and raster() are in ./term.js, which
// extends this. Nothing here needs a font beyond cellW/cellH.

// Attribute bits. Intensity tiers map to beam levels in term.js.
// DIM overrides BRIGHT and MUTED when a caller sets several.
// BOLD uses the family's bold if loaded, otherwise smears the glyph 1px right.
export const NORMAL = 0, BRIGHT = 1, BOLD = 2, DIM = 4

/** Draw from the second face (Term.alt). Null alt draws the roman. */
export const ALT = 8

/** Draw from the family's oblique (Term.italic). Null draws the roman.
 *  There is no synthetic italic. */
export const ITALIC = 16

/** Intensity between NORMAL and DIM. */
export const MUTED = 32

/** Intensity below DIM. Fills only: too dim for strokes. */
export const FAINT = 64

/**
 * Background: pixels the glyph does not light are drawn at BG_LEVEL instead of
 * 0. Applies per cell, so every cell of a panel needs it.
 *
 * With inverse set as well, the glyph is drawn at BG_LEVEL and the field at the
 * intensity.
 */
export const BG = 128

/** All attribute bits. BG is the last one in the byte. */
export const ATTR_MASK = 255

/** Rows retained above the top of the screen. 320KB at 80 columns. */
export const SCROLLBACK_MAX = 1000

export class CellGrid {
  /** @param {{cellW: number, cellH: number}} font cell size */
  constructor(font, cols = 80, rows = 25) {
    this.cols = cols
    this.rows = rows
    this.font = font
    /** Cell width in framebuffer pixels: cellW + 1. A 9-dot advance for an
     *  8-dot font, as in VGA text mode. */
    this.advance = font.cellW + 1

    this.chars = new Uint16Array(cols * rows).fill(32)
    this.attrs = new Uint8Array(cols * rows).fill(NORMAL)
    this.inverse = new Uint8Array(cols * rows)
    /**
     * Per-cell bitmap drawn instead of the codepoint's glyph. One word per row,
     * bit (cellW-1) leftmost. Carries arbitrary pixels at framebuffer
     * resolution through the same rasteriser as text.
     *
     * Filled rather than sparse: the plane is copied whole.
     */
    this.gfx = new Array(cols * rows).fill(undefined)
    this.dirty = true

    // Rows scrolled off the top, oldest first, across the three text planes.
    // Read by Term.raster() for a scrolled-back view.
    this.histChars = []
    this.histAttrs = []
    this.histInv = []
    /** Rows above the live grid the view sits at. 0 is the bottom. */
    this.view = 0

    this.cx = 0
    this.cy = 0
    this.cursorVisible = true
    this.showCursor = true
  }

  /** Blank the screen. The scrollback survives. */
  clear() {
    this.chars.fill(32)
    this.attrs.fill(NORMAL)
    this.inverse.fill(0)
    this.gfx.fill(undefined)
    this.cx = 0
    this.cy = 0
    this.view = 0
    this.dirty = true
  }

  put(x, y, ch, attr = NORMAL, inv = 0) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    this.snapToLive()
    const i = y * this.cols + x
    this.chars[i] = typeof ch === 'string' ? (ch.codePointAt(0) ?? 32) : ch
    this.attrs[i] = attr
    this.inverse[i] = inv
    // A character clears the cell's bitmap.
    this.gfx[i] = undefined
    this.dirty = true
  }

  /**
   * Put a bitmap in a cell. See `gfx`.
   *
   * `bits` is one word per row, bit (cellW-1) leftmost. Not copied — the grid
   * holds the reference for as long as the cell is on screen.
   */
  putGlyph(x, y, bits, attr = NORMAL, inv = 0) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    this.snapToLive()
    const i = y * this.cols + x
    // Space, so the character plane stays valid text.
    this.chars[i] = 32
    this.attrs[i] = attr
    this.inverse[i] = inv
    this.gfx[i] = bits
    this.dirty = true
  }

  text(x, y, str, attr = NORMAL, inv = 0) {
    let cx = x
    for (const ch of str) this.put(cx++, y, ch, attr, inv)
    return cx
  }

  /** Rows available to scroll back over, and the current view offset. */
  get scrollbackRows() { return this.histChars.length }
  get viewOffset() { return this.view }

  /** Move the view by whole rows; positive goes into the scrollback. Returns
   *  false if already at that stop. */
  scrollView(delta) {
    const next = Math.max(0, Math.min(this.view + delta, this.histChars.length))
    if (next === this.view) return false
    this.view = next
    this.dirty = true
    return true
  }

  /** Reset the view to the bottom. Called by put() and newline(). */
  snapToLive() {
    if (!this.view) return
    this.view = 0
    this.dirty = true
  }

  scroll() {
    const { cols, rows } = this
    // Retain the row about to be shifted off the top.
    this.histChars.push(this.chars.slice(0, cols))
    this.histAttrs.push(this.attrs.slice(0, cols))
    this.histInv.push(this.inverse.slice(0, cols))
    if (this.histChars.length > SCROLLBACK_MAX) {
      this.histChars.shift()
      this.histAttrs.shift()
      this.histInv.shift()
    }
    this.chars.copyWithin(0, cols, cols * rows)
    this.attrs.copyWithin(0, cols, cols * rows)
    this.inverse.copyWithin(0, cols, cols * rows)
    // Bitmaps scroll but are not retained: the history planes are text only.
    this.gfx.copyWithin(0, cols, cols * rows)
    this.chars.fill(32, cols * (rows - 1))
    this.attrs.fill(NORMAL, cols * (rows - 1))
    this.inverse.fill(0, cols * (rows - 1))
    this.gfx.fill(undefined, cols * (rows - 1))
    this.dirty = true
  }

  newline() {
    // Also in put(); needed here for empty lines.
    this.snapToLive()
    this.cx = 0
    if (++this.cy >= this.rows) {
      this.cy = this.rows - 1
      this.scroll()
    }
  }

  /** Write at the cursor, wrapping and scrolling. */
  write(str, attr = NORMAL) {
    for (const ch of str) {
      if (ch === '\n') { this.newline(); continue }
      if (this.cx >= this.cols) this.newline()
      this.put(this.cx++, this.cy, ch, attr)
    }
  }

  writeln(str = '', attr = NORMAL) {
    this.write(str, attr)
    this.newline()
  }

  backspace() {
    if (this.cx > 0) {
      this.cx--
      this.put(this.cx, this.cy, 32)
    }
  }
}
