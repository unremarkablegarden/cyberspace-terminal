// A vector display drawn into the character grid.
//
// Braille (U+2800-28FF) covers all 256 combinations of a 2x4 dot matrix, and
// Spleen includes every one. Addressing an 80x25 text grid through Braille
// therefore yields a 160x100 monochrome bitmap on the same canvas and
// rasteriser, with no second canvas and no WebGL.
//
// Integer arithmetic throughout: a wireframe is a list of line segments and a
// rotation is four multiplies, so there is no matrix or camera library here.

import { dotAspect } from './image.js'
import type { CellMetrics } from './image.js'
import type { Rect } from './surface.js'

/** The part of a grid a bitmap needs: Surface and the CRT CellGrid both have it. */
export interface DotTarget {
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
}

/** A point, as a plain tuple to limit allocation. */
export type P3 = [number, number, number]
export type Edge = [P3, P3]

/**
 * Maps dot position to bit, because Braille numbering is not raster order:
 * dots 1-3 run down the left column and 4-6 down the right, with 7-8 added
 * beneath later for 8-dot computer Braille. The bottom row is therefore bits 6
 * and 7 while the rest are column-major.
 */
const DOT_BIT = [
  [0, 3],  // row 0: dots 1, 4
  [1, 4],  // row 1: dots 2, 5
  [2, 5],  // row 2: dots 3, 6
  [6, 7],  // row 3: dots 7, 8
]

/** A 1-bit bitmap backed by Braille cells. */
export class DotCanvas {
  readonly cols: number
  readonly rows: number
  /** Size in dots, across and down. */
  readonly w: number
  readonly h: number
  /** x correction for this face's dot shape. See dotAspect in image.ts. */
  readonly aspect: number

  private cells: Uint8Array

  /**
   * Sized from the face it will be drawn on, so changing the font rescales the
   * picture rather than distorting it. aspect is a property of the font, not
   * of the area used, so a canvas covering part of the grid measures the same.
   */
  constructor(metrics: CellMetrics, cols: number, rows: number) {
    this.cols = Math.max(1, cols | 0)
    this.rows = Math.max(1, rows | 0)
    this.w = this.cols * 2
    this.h = this.rows * 4
    this.aspect = dotAspect(metrics)
    this.cells = new Uint8Array(this.cols * this.rows)
  }

  clear() {
    this.cells.fill(0)
  }

  plot(x: number, y: number) {
    x |= 0
    y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const bit = DOT_BIT[y & 3]![x & 1]!
    this.cells[(y >> 2) * this.cols + (x >> 1)]! |= 1 << bit
  }

  /** Draw one line, Bresenham. Every picture here is built from these. */
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

  /** Draw the bitmap onto the grid at ox, oy, leaving empty cells untouched. */
  blit(grid: DotTarget, attr = 0, ox = 0, oy = 0, clip?: Rect) {
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const bits = this.cells[cy * this.cols + cx]!
        if (!bits) continue
        const x = ox + cx, y = oy + cy
        if (clip && (x < clip.x || y < clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h)) {
          continue
        }
        grid.put(x, y, 0x2800 + bits, attr)
      }
    }
  }
}

export interface View {
  /** Turntable angle, radians. */
  yaw: number
  /** Tilt towards the viewer, radians, so part of the lid is visible. */
  pitch: number
  /** Dots per model unit. */
  scale: number
  /** Centre of projection, in dots. */
  ox: number
  oy: number
  /**
   * Distance to the eye, in model units. Large values are nearly orthographic;
   * around 6 gives mild convergence without the model intersecting the near plane.
   */
  focal: number
}

/**
 * Rotate one point: Y (turntable) then X (tilt), inlined rather than composed
 * as a matrix. The result's z is depth from the eye, positive away.
 */
export function rotate(p: P3, v: View, out: P3): P3 {
  const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
  const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch)
  const x = p[0] * cy + p[2] * sy
  const zy = p[2] * cy - p[0] * sy
  out[0] = x
  out[1] = p[1] * cp - zy * sp
  out[2] = p[1] * sp + zy * cp
  return out
}

/**
 * Project a rotated point to dot coordinates. The eye is on the -z side
 * looking down +z, so in a right-handed frame +x is to the viewer's left:
 * x is negated to keep east on the right.
 */
export function project(r: P3, v: View, aspect: number): [number, number] {
  const s = v.focal / (v.focal + r[2])
  return [v.ox - r[0] * v.scale * aspect * s, v.oy - r[1] * v.scale * s]
}

/** Rotate the model, project it and draw the segments. */
export function drawEdges(dc: DotCanvas, edges: Edge[], v: View) {
  const ra: P3 = [0, 0, 0], rb: P3 = [0, 0, 0]
  for (const [a, b] of edges) {
    const A = project(rotate(a, v, ra), v, dc.aspect)
    const B = project(rotate(b, v, rb), v, dc.aspect)
    dc.line(A[0], A[1], B[0], B[1])
  }
}
