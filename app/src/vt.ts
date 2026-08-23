// Copies the xterm buffer into the Term cell planes. Runs every frame and
// writes only changed cells.
//
// Cells arrive in three forms:
// - A Surface encodes the exact attribute byte as a palette index
//   (@cyberspace/tui attrs.ts), which is decoded back here unchanged.
// - Plain SGR from a shell or wasm binary is read as any terminal reads it.
// - A picture cell is a private-use code point naming a bitmap the faceplate
//   already holds, which is written to the gfx plane. See app/src/image.ts.

import type { Terminal, IBufferCell } from '@xterm/headless'
import { NORMAL, BRIGHT, BOLD, DIM, ITALIC, BG } from '@cyberspace/crt/term'
import { INDEX_LEVEL, BG_INDEX, PICT_LO, PICT_HI } from '@cyberspace/tui'
import { pictureBits } from './image'

function attrFor(cell: IBufferCell): number {
  let attr = NORMAL

  const level = cell.isFgPalette() ? INDEX_LEVEL[cell.getFgColor()] : undefined
  if (level !== undefined) {
    attr = level
    if (cell.isBold()) attr |= BOLD
    if (cell.isItalic()) attr |= ITALIC
    if (cell.isBgPalette() && cell.getBgColor() === BG_INDEX) attr |= BG
    return attr
  }

  if (cell.isBold()) attr |= BOLD | BRIGHT
  if (cell.isDim()) attr |= DIM
  if (cell.isItalic()) attr |= ITALIC
  // Bright ANSI palette (8..15) reads as BRIGHT on a monochrome tube.
  if (cell.isFgPalette() && cell.getFgColor() >= 8) attr |= BRIGHT
  return attr
}

/** `back` is how many rows above the live bottom the view sits. 0 is live. */
export function syncTerm(xt: Terminal, term: any, back = 0): void {
  const buf = xt.buffer.active
  const cell = buf.getNullCell()
  const cols = Math.min(term.cols, xt.cols)
  const rows = Math.min(term.rows, xt.rows)
  const top = buf.baseY - back

  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(top + y)
    const base = y * term.cols
    for (let x = 0; x < cols; x++) {
      let code = 32
      let attr = NORMAL
      let inv = 0
      if (line) {
        line.getCell(x, cell)
        const ch = cell.getChars()
        // Width-0 cells are wide-char continuations; leave them blank.
        if (ch && cell.getWidth() !== 0) code = ch.codePointAt(0) ?? 32
        attr = attrFor(cell)
        inv = cell.isInverse() ? 1 : 0
      }
      const i = base + x
      // A picture cell: the code point is a handle on a bitmap held by the host,
      // not a character. Bitmaps are interned, so comparing identity is enough to
      // diff them. An unknown handle renders blank rather than as a missing-glyph
      // box; a session restored after a reload has handles but no bank behind them.
      // See app/src/image.ts and packages/tui/src/pict.ts.
      const bits = pictureBits(code)
      if (bits) {
        if (term.gfx[i] !== bits || term.attrs[i] !== attr || term.inverse[i] !== inv) {
          term.putGlyph(x, y, bits, attr, inv)
        }
        continue
      }
      if (code >= PICT_LO && code <= PICT_HI) code = 32
      // `|| term.gfx[i]` clears a cell that has stopped being a picture. putGlyph
      // leaves a space in the character plane, so the code points already match
      // and no other term would detect the change.
      if (term.chars[i] !== code || term.gfx[i] || term.attrs[i] !== attr || term.inverse[i] !== inv) {
        term.put(x, y, code, attr, inv)
      }
    }
  }

  // Not updated while scrolled back: the row index would fall outside the grid.
  // The host hides the caret instead.
  if (back === 0 && (term.cx !== buf.cursorX || term.cy !== buf.cursorY)) {
    term.cx = buf.cursorX
    term.cy = buf.cursorY
    term.dirty = true
  }
}
