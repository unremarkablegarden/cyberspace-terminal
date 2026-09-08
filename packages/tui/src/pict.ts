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

/** A rasterised block as its distinct bitmaps and which one each cell uses (-1 unlit). */
export interface DistinctCells {
  distinct: Uint16Array[]
  cell: Int32Array
}

/**
 * Distinct bitmaps first, so the bank is asked once and either holds the whole
 * block or none of it.
 *
 * A cell with nothing lit is a picture cell too, with an all-zero bitmap: as a
 * space it would take the ground of a panel drawn under it, and the picture's
 * black would show as a hole. The zero bitmap is one shared entry.
 */
export function distinctCells(block: { cols: number; rows: number; cells: (Uint16Array | undefined)[] }): DistinctCells {
  const distinct: Uint16Array[] = []
  const nth = new Map<string, number>()
  const cell = new Int32Array(block.cols * block.rows).fill(-1)
  const rows = block.cells.find(b => b)?.length
  const blank = rows ? new Uint16Array(rows) : undefined
  for (let i = 0; i < cell.length; i++) {
    const bits = block.cells[i] ?? blank
    if (!bits) continue
    const key = String.fromCharCode(...bits)
    let n = nth.get(key)
    if (n === undefined) {
      n = distinct.length
      distinct.push(bits)
      nth.set(key, n)
    }
    cell[i] = n
  }
  return { distinct, cell }
}

/** Rows of handles for a block, `' '` where the cell is unlit. */
export function handleLines(cols: number, rows: number, cell: Int32Array, codes: number[]): string[] {
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      const n = cell[y * cols + x]!
      line += n < 0 ? ' ' : String.fromCharCode(codes[n]!)
    }
    lines.push(line)
  }
  return lines
}
