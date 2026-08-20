// xterm buffer -> Term cell planes. Runs every frame; writes only changed cells.

import type { Terminal, IBufferCell } from '@xterm/headless'
import { NORMAL, BRIGHT, BOLD, DIM, ITALIC } from '@cyberspace/crt/term'

function attrFor(cell: IBufferCell): number {
  let attr = NORMAL
  if (cell.isBold()) attr |= BOLD | BRIGHT
  if (cell.isDim()) attr |= DIM
  if (cell.isItalic()) attr |= ITALIC
  // Bright ANSI palette (8..15) reads as BRIGHT on a monochrome tube.
  if (cell.isFgPalette() && cell.getFgColor() >= 8) attr |= BRIGHT
  return attr
}

export function syncTerm(xt: Terminal, term: any): void {
  const buf = xt.buffer.active
  const cell = buf.getNullCell()
  const cols = Math.min(term.cols, xt.cols)
  const rows = Math.min(term.rows, xt.rows)

  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.baseY + y)
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
      if (term.chars[i] !== code || term.attrs[i] !== attr || term.inverse[i] !== inv) {
        term.put(x, y, code, attr, inv)
      }
    }
  }

  if (term.cx !== buf.cursorX || term.cy !== buf.cursorY) {
    term.cx = buf.cursorX
    term.cy = buf.cursorY
    term.dirty = true
  }
}
