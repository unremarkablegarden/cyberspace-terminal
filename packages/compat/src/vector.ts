// A vector display, drawn into the character grid.
//
// The grid is 80x25 cells of text, which sounds like the end of the matter —
// but Braille (U+2800-28FF) is 256 codepoints covering every combination of a
// 2x4 dot matrix, and Spleen has all of them. Addressing the grid through
// Braille therefore gives a 160x100 monochrome bitmap at no cost, on the same
// tube, through the same rasteriser, with no second canvas and no WebGL of its
// own. Each dot lands as a couple of lit pixels in the beam framebuffer, which
// on a phosphor with this much bloom looks like precisely what it is imitating:
// a storage-tube vector display drawing lines out of dots.
//
// Everything here is integers and arithmetic. No matrices library, no
// perspective camera, no three.js — a wireframe is a list of line segments and
// a rotation is four multiplies.

interface Term {
  cols: number
  rows: number
  advance: number
  font: { cellH: number }
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
}

/** A point. Plain tuples: this file allocates enough as it is. */
export type P3 = [number, number, number]
export type Edge = [P3, P3]

/**
 * How wide a Braille dot is against how tall, for the face currently up.
 *
 * A dot is half a cell across and a quarter of one down, so in the 8x16 face
 * (9-dot advance) it covers 4.5 x 4 device pixels and in the 12x24 face (13)
 * it covers 6.5 x 6. Both are nearly square and neither is exactly square, and
 * they are not the same — so this is measured off the live Term rather than
 * written down. Hardcoding it to either face draws eggs in the other.
 */
function dotAspect(term: Term): number {
  const dotW = term.advance / 2
  const dotH = term.font.cellH / 4
  return dotH / dotW
}

/**
 * Braille dot numbering is historical, not raster order: dots 1-3 run down the
 * left column, 4-6 down the right, and 7-8 were added underneath much later for
 * 8-dot computer Braille. So the bottom row is bits 6 and 7 while the rest are
 * column-major. This table is that mapping, and it is the only surprising thing
 * in the file.
 */
const DOT_BIT = [
  [0, 3],  // row 0: dots 1, 4
  [1, 4],  // row 1: dots 2, 5
  [2, 5],  // row 2: dots 3, 6
  [6, 7],  // row 3: dots 7, 8
]

/** A 1-bit bitmap that happens to be made of text. */
export class DotCanvas {
  readonly cols: number
  readonly rows: number
  /** Dots across and down. */
  readonly w: number
  readonly h: number
  /** x correction for this face's dot shape. See dotAspect. */
  readonly aspect: number

  private cells: Uint8Array

  /**
   * Sized off the Term it will be blitted to, so a face swapped in under it
   * (F7) changes the picture's proportions rather than breaking them.
   *
   * `cols`/`rows` default to the whole grid — a full-screen vector display. Give
   * them explicitly for a canvas that covers only part of it, which is what a
   * picture inside a box needs. `aspect` still comes from the Term either way:
   * it is a property of the face, not of how much of the screen you are using.
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

  /** Bresenham. The whole picture is made of this. */
  line(x0: number, y0: number, x1: number, y1: number) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy

    // A line whose endpoints are both miles off screen would otherwise walk the
    // whole distance plotting nothing. Nothing here projects that far out, but
    // a runaway loop in a joke is still a runaway loop.
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
   * Stamp the bitmap onto the grid at `ox, oy`. Empty cells are left alone.
   *
   * `clip` is taken structurally rather than as a tui Rect: this file sits
   * under the TUI layer and should not start importing from it for the sake of
   * four numbers.
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
  /** Tilt towards the viewer, radians. Some of the lid is worth seeing. */
  pitch: number
  /** Dots per model unit. */
  scale: number
  /** Centre, in dots. */
  ox: number
  oy: number
  /**
   * Distance to the eye, in model units. Large is nearly orthographic; around
   * 6 gives the mild convergence a real vector rig had without the model
   * looking like it is being eaten by the near plane.
   */
  focal: number
}

/** Rotate, project, and draw. */
export function drawEdges(dc: DotCanvas, edges: Edge[], v: View) {
  const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
  const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch)
  const sx = v.scale * dc.aspect

  const project = (p: P3): [number, number] => {
    // Y first (the turntable), then X (the tilt). Inlined rather than run
    // through a matrix: it is six multiplies and reads better as what it is.
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
// The Utah teapot, which is the joke: it is the oldest in-joke in computer
// graphics, and it is also the thing members collect in /grid. Not Newell's
// actual Bezier patches — 32 patches of control points is a lot of data to ship
// for four seconds of a gag — but the same silhouette built the way a 1975
// program would have built it, by revolving a profile and bending two tubes.

/** Body: [radius, height] up the outside, foot to rim. */
const BODY: [number, number][] = [
  [0.62, -1.00], [0.90, -0.92], [1.10, -0.70], [1.22, -0.35],
  [1.24, 0.00], [1.14, 0.32], [0.92, 0.56], [0.66, 0.70], [0.60, 0.76],
]

/** Lid, from the flange up to the knob. */
const LID: [number, number][] = [
  [0.70, 0.78], [0.62, 0.86], [0.42, 0.99], [0.22, 1.07],
  [0.11, 1.11], [0.19, 1.19], [0.13, 1.26], [0.02, 1.30],
]

/** Spout: [x, y, radius] along its centreline, out to the left and up. */
const SPOUT: P3[] = [
  [-1.02, -0.12, 0.34], [-1.42, -0.02, 0.28], [-1.78, 0.20, 0.21],
  [-2.02, 0.50, 0.15], [-2.12, 0.74, 0.12],
]

const TAU = Math.PI * 2

/** Turn a profile into rings and meridians. */
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
      // ...and the line up to the next ring, on some of the meridians only. All
      // of them is a solid black pot; a few is a wireframe.
      if (i + 1 < profile.length && k % everyMeridian === 0) {
        edges.push([at(i, k), at(i + 1, k)])
      }
    }
  }
  return edges
}

/**
 * A tube along a path. Each ring is a circle perpendicular to the direction of
 * travel — which for a path that stays in the XY plane means one basis vector
 * is the path's own normal and the other is simply z.
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
      // (-dy, dx) is the normal in-plane; z is free.
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
 * A quadratic Bezier rather than a circular arc, because the two ends have to
 * land in specific places and an arc only lets you choose one of them. Both
 * ends sit INSIDE the body's surface — at y=0.56 the body is 0.92 out and the
 * handle starts at 0.84, at y=-0.32 the body is 1.22 and the handle ends at
 * 1.10 — so the tube visibly enters the pot. Ending it exactly on the surface
 * is not enough: with no hidden-line removal, a tube that merely touches reads
 * as a handle floating a few pixels off the side, which is precisely what the
 * arc this replaced did (its upper end was 0.9 out in clear space).
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
    // Slightly fatter where it meets the pot, the way a moulded handle flares
    // into the body rather than being posted into it.
    const r = 0.12 + 0.035 * Math.abs(2 * t - 1)
    path.push([x, y, r])
  }
  return path
}

let cached: Edge[] | null = null

/** Built once, on first use. ~700 segments, which Bresenham eats for breakfast. */
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
