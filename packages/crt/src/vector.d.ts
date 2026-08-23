import type { Term } from './term.js'

/** A braille dot canvas over the cell grid: 2x4 dots per cell. */
export class DotCanvas {
  constructor(term: Term, cols?: number, rows?: number)
  readonly w: number
  readonly h: number
  clear(): void
  plot(x: number, y: number): void
  line(x0: number, y0: number, x1: number, y1: number): void
  blit(term: Term, attr?: number, ox?: number, oy?: number, clip?: { x: number, y: number, w: number, h: number }): void
}

export function drawEdges(
  dc: DotCanvas,
  edges: ArrayLike<number>,
  v: ArrayLike<number> | number[][],
): void
