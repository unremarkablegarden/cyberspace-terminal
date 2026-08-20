// A 1-bit bitmap addressed through the character grid.
//
// Braille (U+2800-28FF) is 256 codepoints covering every combination of a 2x4
// dot matrix, so an 80x25 grid of it is a 160x100 monochrome framebuffer, drawn
// through the same rasteriser as text.
//
// The face need not carry any Braille: bdf.js synthesises all 256 patterns for
// whatever cell size is loaded. Terminus has none.

/**
 * Dot width against dot height for the loaded face.
 *
 * A dot is half a cell across and a quarter down: 4.5 x 4 device pixels in an
 * 8x16 face (9-dot advance). Not square, and not the same in every face, so it
 * is measured rather than hardcoded.
 */
function dotAspect(term) {
  const dotW = term.advance / 2
  const dotH = term.font.cellH / 4
  return dotH / dotW
}

/**
 * Braille dot numbering is not raster order: dots 1-3 run down the left column,
 * 4-6 down the right, 7-8 were added underneath later. So the bottom row is bits
 * 6 and 7 while the rest are column-major. `braille()` in bdf.js keeps the same
 * table; the two must agree.
 */
const DOT_BIT = [
  [0, 3],  // row 0: dots 1, 4
  [1, 4],  // row 1: dots 2, 5
  [2, 5],  // row 2: dots 3, 6
  [6, 7],  // row 3: dots 7, 8
]

export class DotCanvas {
  /**
   * Sized off the Term it will be blitted to, so swapping the face rescales the
   * picture.
   *
   * cols/rows default to the whole grid; pass them for a canvas covering part of
   * it. aspect comes from the Term either way: it is a property of the face, not
   * of the area in use.
   */
  constructor(term, cols = term.cols, rows = term.rows) {
    this.cols = Math.max(1, cols | 0)
    this.rows = Math.max(1, rows | 0)
    /** Dots across and down. */
    this.w = this.cols * 2
    this.h = this.rows * 4
    /** x correction for this face's dot shape. See dotAspect. */
    this.aspect = dotAspect(term)
    this.cells = new Uint8Array(this.cols * this.rows)
  }

  clear() {
    this.cells.fill(0)
  }

  plot(x, y) {
    x |= 0
    y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const bit = DOT_BIT[y & 3][x & 1]
    this.cells[(y >> 2) * this.cols + (x >> 1)] |= 1 << bit
  }

  /** Bresenham. */
  line(x0, y0, x1, y1) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy

    // Bounds the walk for a line whose endpoints are both far off screen.
    let guard = this.w + this.h + Math.abs(dx) + Math.abs(dy)

    for (;;) {
      this.plot(x0, y0)
      if ((x0 === x1 && y0 === y1) || guard-- <= 0) return
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }

  /**
   * Stamp the bitmap onto the grid at `ox, oy`. Empty cells are skipped, so
   * anything drawn underneath survives.
   *
   * @param {object} [clip] {x, y, w, h} in cells
   */
  blit(term, attr = 0, ox = 0, oy = 0, clip = undefined) {
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const bits = this.cells[cy * this.cols + cx]
        if (!bits) continue
        const x = ox + cx, y = oy + cy
        if (clip && (x < clip.x || y < clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h)) {
          continue
        }
        term.put(x, y, 0x2800 + bits, attr)
      }
    }
  }
}

/**
 * Rotate, project and draw a list of edges.
 *
 * @param {DotCanvas} dc
 * @param {Array<[number[], number[]]>} edges pairs of [x, y, z] points
 * @param {{yaw: number, pitch: number, scale: number, ox: number, oy: number,
 *   focal: number}} v yaw/pitch in radians, scale in dots per model unit, ox/oy
 *   the centre in dots, focal the eye distance in model units (large is nearly
 *   orthographic; ~6 gives mild convergence).
 */
export function drawEdges(dc, edges, v) {
  const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
  const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch)
  const sx = v.scale * dc.aspect

  const project = (p) => {
    // Y (turntable) then X (tilt), inlined: six multiplies.
    const x = p[0] * cy + p[2] * sy
    const zy = p[2] * cy - p[0] * sy
    const y = p[1] * cp - zy * sp
    const z = p[1] * sp + zy * cp
    const s = v.focal / (v.focal + z)
    return [v.ox + x * sx * s, v.oy - y * v.scale * s]
  }

  for (const [a, b] of edges) {
    const A = project(a)
    const B = project(b)
    dc.line(A[0], A[1], B[0], B[1])
  }
}
