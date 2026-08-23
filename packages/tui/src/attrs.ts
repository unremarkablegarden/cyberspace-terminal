// The cell attribute byte, and how it is encoded for transport over a pty.
//
// These are the CRT grid's bits (packages/crt cellgrid.js), duplicated here so
// the TUI does not depend on the faceplate. The values match deliberately: one
// widget must mean the same thing whether it draws on a Surface or the grid.
//
// Attributes are not colour. The display stores beam intensity per cell, so
// four bits are mutually exclusive beam levels and the rest are faces and
// backgrounds. Inverse is a separate plane rather than a bit, because it swaps
// stroke and background instead of describing either.

export const NORMAL = 0
export const BRIGHT = 1
export const BOLD = 2
export const DIM = 4
/** A second typeface. None is loaded in this build; kept for parity with the grid. */
export const ALT = 8
export const ITALIC = 16
export const MUTED = 32
/** A fill rather than a stroke, used for the drop shadow under a panel. */
export const FAINT = 64
/** Lights the background behind a cell, turning a frame into a filled panel. */
export const BG = 128

/** The beam level bits. Mutually exclusive; NORMAL is none of them. */
export const LEVEL_MASK = BRIGHT | DIM | MUTED | FAINT

// --- transport ---------------------------------------------------------------
//
// A program emits ANSI, so the attribute byte must cross a pty and be decoded
// back exactly. The beam level is carried as a 256-colour foreground index and
// the background as a background index; weight, slant and inverse use ordinary
// SGR. Every code is standard, so another terminal renders something sensible.
// The specific indices are what mark the attribute as exact, distinguishing a
// Surface's output from a program that happens to print \x1b[1m.

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

/** Background palette index used to carry BG. */
export const BG_INDEX = 236

/** The SGR sequence for one cell's attributes. */
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
