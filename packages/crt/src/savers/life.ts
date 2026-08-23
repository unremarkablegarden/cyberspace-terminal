import { BRIGHT } from '../term.js'
import { DotCanvas } from '../vector.js'
import type { SaverSpec } from './common.js'
import { blank } from './common.js'

/**
 * Conway's Life on the braille bitmap, 160 by 100 dots and nothing else drawn.
 * Adapted from the member program it began as, without the GEN/POP readout and
 * the SPACE/P bindings, since any key dismisses a screensaver.
 *
 * Edges wrap, so a glider leaving the right returns on the left. A population
 * that stops changing has reached still lifes and oscillators, at which point a
 * new board is seeded.
 */
export const life: SaverSpec = {
  name: 'life', summary: 'conway, in braille', fps: 16,
  make(term) {
    const c = new DotCanvas(term)
    const W = c.w, H = c.h
    const DENSITY = 0.28
    let cells = new Uint8Array(W * H)
    let next = new Uint8Array(W * H)
    let lastPop = -1, stale = 0

    const soup = () => {
      for (let i = 0; i < cells.length; i++) cells[i] = Math.random() < DENSITY ? 1 : 0
      next.fill(0)
      lastPop = -1; stale = 0
    }
    soup()

    return {
      frame(t) {
        c.clear()
        let pop = 0
        for (let y = 0; y < H; y++) {
          const row = y * W
          for (let x = 0; x < W; x++) {
            if (cells[row + x]) { c.plot(x, y); pop++ }
          }
        }
        // blit leaves empty cells untouched, so the grid is cleared first or
        // every dead dot stays lit.
        blank(t)
        c.blit(t, BRIGHT)

        // A constant population means only still lifes and oscillators remain.
        if (pop === lastPop) stale++
        else stale = 0
        lastPop = pop
        if (stale > 80 || pop === 0) { soup(); return }

        for (let y = 0; y < H; y++) {
          const up = ((y + H - 1) % H) * W, mid = y * W, dn = ((y + 1) % H) * W
          for (let x = 0; x < W; x++) {
            const l = (x + W - 1) % W, r = (x + 1) % W
            const n = cells[up + l]! + cells[up + x]! + cells[up + r]!
              + cells[mid + l]! + cells[mid + r]!
              + cells[dn + l]! + cells[dn + x]! + cells[dn + r]!
            next[mid + x] = (n === 3 || (n === 2 && cells[mid + x])) ? 1 : 0
          }
        }
        const swap = cells; cells = next; next = swap
      },
    }
  },
}
