// A vector display drawn into the character grid.
//
// Braille (U+2800-28FF) covers all 256 combinations of a 2x4 dot matrix, and
// Spleen includes every one. Addressing an 80x25 text grid through Braille
// therefore yields a 160x100 monochrome bitmap on the same canvas and
// rasteriser, with no second canvas and no WebGL.
//
// Integer arithmetic throughout: a wireframe is a list of line segments and a
// rotation is four multiplies, so there is no matrix or camera library here.

interface Term {
  cols: number
  rows: number
  advance: number
  font: { cellH: number }
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
}

/** A point, as a plain tuple to limit allocation. */
export type P3 = [number, number, number]
export type Edge = [P3, P3]

/**
 * Width-to-height ratio of a Braille dot in the font currently loaded.
 *
 * A dot is half a cell wide and a quarter of one tall, so the 8x16 face
 * (9-dot advance) gives 4.5 x 4 device pixels and the 12x24 face (13) gives
 * 6.5 x 6. Neither is square and they differ, so this is measured from the live
 * Term; a constant fitted to one face draws ellipses in the other.
 */
function dotAspect(term: Term): number {
  const dotW = term.advance / 2
  const dotH = term.font.cellH / 4
  return dotH / dotW
}

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
  /** x correction for this face's dot shape. See dotAspect. */
  readonly aspect: number

  private cells: Uint8Array

  /**
   * Sized from the Term it will be drawn to, so changing the font rescales the
   * picture rather than distorting it.
   *
   * cols and rows default to the whole grid. Pass them for a canvas covering
   * part of it, such as a picture inside a box. aspect comes from the Term
   * either way, being a property of the font rather than of the area used.
   */
  constructor(term: Term, cols = term.cols, rows = term.rows) {
    this.cols = Math.max(1, cols | 0)
    this.rows = Math.max(1, rows | 0)
    this.w = this.cols * 2
    this.h = this.rows * 4
    this.aspect = dotAspect(term)
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

  /**
   * Draw the bitmap onto the grid at ox, oy, leaving empty cells untouched.
   *
   * clip is taken structurally rather than as a tui Rect, so this file does not
   * depend on the TUI layer above it for four numbers.
   */
  blit(
    term: Term, attr = 0, ox = 0, oy = 0,
    clip?: { x: number; y: number; w: number; h: number },
  ) {
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const bits = this.cells[cy * this.cols + cx]!
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

/** Rotate the model, project it and draw the segments. */
export function drawEdges(dc: DotCanvas, edges: Edge[], v: View) {
  const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
  const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch)
  const sx = v.scale * dc.aspect

  const project = (p: P3): [number, number] => {
    // Y (turntable) then X (tilt), inlined rather than composed as a matrix:
    // six multiplies in total.
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

// --- the model ------------------------------------------------------------
//
// The Utah teapot. Not Newell's Bezier patches, whose 32 patches of control
// points are more data than this needs, but the same silhouette built by
// revolving a profile and bending two tubes.

/** Body profile: [radius, height] up the outside, foot to rim. */
const BODY: [number, number][] = [
  [0.62, -1.00], [0.90, -0.92], [1.10, -0.70], [1.22, -0.35],
  [1.24, 0.00], [1.14, 0.32], [0.92, 0.56], [0.66, 0.70], [0.60, 0.76],
]

/** Lid profile, from the flange up to the knob. */
const LID: [number, number][] = [
  [0.70, 0.78], [0.62, 0.86], [0.42, 0.99], [0.22, 1.07],
  [0.11, 1.11], [0.19, 1.19], [0.13, 1.26], [0.02, 1.30],
]

/** Spout centreline: [x, y, radius], running out to the left and up. */
const SPOUT: P3[] = [
  [-1.02, -0.12, 0.34], [-1.42, -0.02, 0.28], [-1.78, 0.20, 0.21],
  [-2.02, 0.50, 0.15], [-2.12, 0.74, 0.12],
]

const TAU = Math.PI * 2

/** Revolve a profile into rings and meridians. */
function revolve(profile: [number, number][], sides: number, everyMeridian: number): Edge[] {
  const edges: Edge[] = []
  const at = (i: number, k: number): P3 => {
    const [r, y] = profile[i]!
    const a = (k % sides) * TAU / sides
    return [r * Math.cos(a), y, r * Math.sin(a)]
  }

  for (let i = 0; i < profile.length; i++) {
    for (let k = 0; k < sides; k++) {
      // The ring at this height.
      edges.push([at(i, k), at(i, k + 1)])
      // The line up to the next ring, on a subset of meridians only: drawing
      // every one fills the silhouette solid instead of leaving a wireframe.
      if (i + 1 < profile.length && k % everyMeridian === 0) {
        edges.push([at(i, k), at(i + 1, k)])
      }
    }
  }
  return edges
}

/**
 * A tube along a path, each ring a circle perpendicular to the direction of
 * travel. For a path confined to the XY plane, one basis vector is the path's
 * normal and the other is z.
 */
function tube(path: P3[], sides: number): Edge[] {
  const edges: Edge[] = []
  const rings: P3[][] = []

  for (let i = 0; i < path.length; i++) {
    const [x, y, r] = path[i]!
    const prev = path[Math.max(0, i - 1)]!
    const next = path[Math.min(path.length - 1, i + 1)]!
    let dx = next[0] - prev[0]
    let dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy) || 1
    dx /= len; dy /= len

    const ring: P3[] = []
    for (let k = 0; k < sides; k++) {
      const a = k * TAU / sides
      const c = Math.cos(a) * r, s = Math.sin(a) * r
      // (-dy, dx) is the in-plane normal; z is the free axis.
      ring.push([x + -dy * c, y + dx * c, s])
    }
    rings.push(ring)
  }

  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]!
    for (let k = 0; k < sides; k++) {
      edges.push([ring[k]!, ring[(k + 1) % sides]!])
      if (i + 1 < rings.length) edges.push([ring[k]!, rings[i + 1]![k]!])
    }
  }
  return edges
}

/**
 * The handle: the same tube, bowed out on the right-hand side.
 *
 * A quadratic Bezier rather than a circular arc, because both ends must land at
 * specified points and an arc fixes only one. Both ends sit inside the body's
 * surface: at y=0.56 the body is at 0.92 and the handle starts at 0.84; at
 * y=-0.32 the body is at 1.22 and the handle ends at 1.10. There is no
 * hidden-line removal, so a tube ending exactly on the surface renders as one
 * floating clear of it.
 */
const HANDLE_FROM: [number, number] = [0.84, 0.56]   // into the shoulder
const HANDLE_BOW: [number, number] = [2.20, 0.20]    // control point, out right
const HANDLE_TO: [number, number] = [1.10, -0.32]    // into the belly

function handlePath(): P3[] {
  const path: P3[] = []
  const steps = 9
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const x = u * u * HANDLE_FROM[0] + 2 * u * t * HANDLE_BOW[0] + t * t * HANDLE_TO[0]
    const y = u * u * HANDLE_FROM[1] + 2 * u * t * HANDLE_BOW[1] + t * t * HANDLE_TO[1]
    // Widened where it meets the body, so the join reads as a flare rather than
    // a tube inserted into a hole.
    const r = 0.12 + 0.035 * Math.abs(2 * t - 1)
    path.push([x, y, r])
  }
  return path
}

let cached: Edge[] | null = null

/** Built once on first use. About 700 segments. */
export function teapot(): Edge[] {
  if (!cached) {
    cached = [
      ...revolve(BODY, 12, 3),
      ...revolve(LID, 12, 4),
      ...tube(SPOUT, 6),
      ...tube(handlePath(), 6),
    ]
  }
  return cached
}
