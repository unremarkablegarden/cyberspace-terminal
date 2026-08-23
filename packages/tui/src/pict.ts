// Picture handles: code points that name a bitmap held by the faceplate.
//
// A cell can carry its own bitmap in the CRT's gfx plane (see cellgrid.js), but
// a program behind a pty cannot reach the grid to set one. The side holding the
// bitmaps therefore issues one code point per bitmap, the program writes those
// as ordinary text, and the faceplate resolves them when rendering.
//
// The private use area suits this: each code point is one cell wide, no font
// defines glyphs for it, and it passes through a parser unchanged. Anything
// needing to tell a picture from a character without access to the bank asks
// here.

/** First picture handle. */
export const PICT_LO = 0xe000
/** Last picture handle. 6400 in total, about two and a half screenfuls. */
export const PICT_HI = 0xf8ff

/** Whether this code point is a picture handle rather than a character. */
export function isPictureCell(ch: string | number | undefined): boolean {
  if (ch === undefined) return false
  const code = typeof ch === 'number' ? ch : ch.codePointAt(0)
  return code !== undefined && code >= PICT_LO && code <= PICT_HI
}
