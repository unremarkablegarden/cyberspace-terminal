// The cell attribute byte, and how it survives the wire.
//
// These are the CRT grid's own bits (packages/crt cellgrid.js), repeated here
// because the TUI must not depend on the faceplate. Same values on purpose: a
// widget drawing on a Surface and the same widget drawing straight onto the
// tube must mean the same thing by the same number.
//
// Attributes are not colour. The tube stores how hard the gun hit a cell, so
// four of these bits are beam LEVELS (mutually exclusive) and the rest are
// faces and fields. Inverse is not a bit at all — it is a plane, as on the
// grid, because it swaps stroke and field rather than describing either.

export const NORMAL = 0
export const BRIGHT = 1
export const BOLD = 2
export const DIM = 4
/** A second face. No face is loaded in this build; carried for parity. */
export const ALT = 8
export const ITALIC = 16
export const MUTED = 32
/** A fill, never a stroke — the drop shadow under a panel. */
export const FAINT = 64
/** Lights the field under a cell: a frame becomes a panel lying on the glass. */
export const BG = 128

/** The beam level bits. One at a time; NORMAL is none of them. */
export const LEVEL_MASK = BRIGHT | DIM | MUTED | FAINT

// --- transport ---------------------------------------------------------------
//
// A program speaks ANSI, so the byte has to cross a pty and come back whole.
// The level rides a 256-colour foreground index and the ground rides a
// background one; weight, slant and inverse are ordinary SGR. Every code below
// is standard, so a foreign terminal shows something sensible rather than
// mojibake — and the indices are the marker that says the attribute is exact,
// which is what separates a Surface's output from a program that merely
// happens to print \x1b[1m.

/** Beam level -> foreground palette index. */
export const LEVEL_INDEX: Record<number, number> = {
  [BRIGHT]: 15,
  [NORMAL]: 7,
  [DIM]: 8,
  [MUTED]: 250,
  [FAINT]: 240,
}

/** Foreground palette index -> beam level. */
export const INDEX_LEVEL: Record<number, number> = {
  15: BRIGHT,
  7: NORMAL,
  8: DIM,
  250: MUTED,
  240: FAINT,
}

/** Background palette index that carries BG. */
export const BG_INDEX = 236

/** The SGR run for one cell. */
export function sgr(attr: number, inv: number): string {
  const parts = ['0']
  if (attr & BOLD) parts.push('1')
  if (attr & DIM) parts.push('2')
  if (attr & ITALIC) parts.push('3')
  if (inv) parts.push('7')
  parts.push('38', '5', String(LEVEL_INDEX[attr & LEVEL_MASK] ?? LEVEL_INDEX[NORMAL]))
  if (attr & BG) parts.push('48', '5', String(BG_INDEX))
  return `\x1b[${parts.join(';')}m`
}
