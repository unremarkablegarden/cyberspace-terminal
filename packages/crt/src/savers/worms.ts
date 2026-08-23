import { NORMAL, BRIGHT } from '../term.js'
import type { SaverSpec } from './common.js'
import { rnd } from './common.js'

/**
 * bsdgames worms. Each worm is a queue of cells following an eight-way random
 * walk biased straight ahead: the head is BRIGHT, the body NORMAL, and the tail
 * erases itself. Edges wrap, as in the original.
 */
export const worms: SaverSpec = {
  name: 'worms', summary: 'the worm farm', fps: 12,
  make(term) {
    const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1]
    const LEN = 11
    const N = Math.max(3, (term.cols / 14) | 0)
    const squad = Array.from({ length: N }, () => ({
      cells: [[rnd(term.cols), rnd(term.rows)]] as [number, number][],
      dir: rnd(8),
    }))

    return {
      frame(t) {
        for (const w of squad) {
          // Mostly straight with occasional turns. Limiting the change to ±1 on
          // an eight-way compass prevents a reversal.
          const roll = Math.random()
          if (roll < 0.2) w.dir = (w.dir + 1) % 8
          else if (roll < 0.4) w.dir = (w.dir + 7) % 8
          const [hx, hy] = w.cells[w.cells.length - 1]!
          const nx = (hx + DX[w.dir]! + t.cols) % t.cols
          const ny = (hy + DY[w.dir]! + t.rows) % t.rows
          t.put(hx, hy, 111, NORMAL) // o — the old head joins the body
          t.put(nx, ny, 64, BRIGHT)  // @
          w.cells.push([nx, ny])
          if (w.cells.length > LEN) {
            const [tx, ty] = w.cells.shift()!
            t.put(tx, ty, 32, NORMAL)
          }
        }
      },
    }
  },
}
