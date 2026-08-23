// xterm buffer -> Term cell planes. Runs every frame; writes only changed cells.
//
// Two kinds of program write here. One draws on a Surface and encodes the exact
// attribute byte (@cyberspace/tui attrs.ts): the palette index it sets is the
// marker, and the byte comes back whole. Everything else — a shell, a wasm
// binary, anything printing plain SGR — is read the way a terminal reads it.

import type { Terminal, IBufferCell } from '@xterm/headless'
import { NORMAL, BRIGHT, BOLD, DIM, ITALIC, BG } from '@cyberspace/crt/term'
import { INDEX_LEVEL, BG_INDEX } from '@cyberspace/tui'

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
