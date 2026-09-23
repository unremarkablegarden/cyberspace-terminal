// The Term-facing Braille canvas handed to published programs. The bitmap,
// the projection maths and the teapot live in @cyberspace/tui; this file keeps
// the (term, cols, rows) constructor published programs call, building the
// face metrics from the Term they pass.

import { DotCanvas as TuiDotCanvas } from '@cyberspace/tui'
import type { CellMetrics } from '@cyberspace/tui'

export { drawEdges, rotate, project, teapot } from '@cyberspace/tui'
export type { View, P3, Edge } from '@cyberspace/tui'

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
