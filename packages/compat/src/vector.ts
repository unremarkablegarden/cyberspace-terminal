// The teapot demo and the Term-facing Braille canvas handed to published
// programs. The bitmap and projection maths live in @cyberspace/tui/vector;
// this file keeps the (term, cols, rows) constructor the original programs
// call, building the face metrics from the Term they pass.

import { DotCanvas as TuiDotCanvas } from '@cyberspace/tui'
import type { CellMetrics } from '@cyberspace/tui'

export { drawEdges, rotate, project } from '@cyberspace/tui'
export type { View, P3, Edge } from '@cyberspace/tui'
import type { P3, Edge } from '@cyberspace/tui'

interface Term {
  cols: number
  rows: number
  advance: number
  font: { cellW?: number; cellH: number }
  stretch?: number
}

function metricsOf(term: Term): CellMetrics {
  return {
    cellW: term.font.cellW ?? term.advance - 1,
    cellH: term.font.cellH,
    advance: term.advance,
    stretch: term.stretch,
  }
}

/** The tui canvas, sized and aspected from a Term as the original API was. */
export class DotCanvas extends TuiDotCanvas {
  constructor(term: Term, cols = term.cols, rows = term.rows) {
    super(metricsOf(term), cols, rows)
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
