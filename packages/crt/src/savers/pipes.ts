import { NORMAL, BRIGHT, DIM, MUTED } from '../term.js'
import type { SaverSpec } from './common.js'
import { blank, rnd } from './common.js'

/**
 * pipes.sh. Four pipes alternating between the single and double box-drawing
 * sets, with beam levels in place of the original's colours. The corner table
 * maps the side a pipe entered from to the side it leaves by, keyed
 * oldDir*4+newDir. The screen clears and restarts once it is full.
 */
export const pipes: SaverSpec = {
  name: 'pipes', summary: 'plumbing', fps: 30,
  make(term) {
    const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]
    const SINGLE = {
      v: 0x2502, h: 0x2500,
      corner: { 1: 0x250c, 3: 0x2510, 4: 0x2518, 6: 0x2510, 9: 0x2514, 11: 0x2518, 12: 0x2514, 14: 0x250c } as Record<number, number>,
    }
    const DOUBLE = {
      v: 0x2551, h: 0x2550,
      corner: { 1: 0x2554, 3: 0x2557, 4: 0x255d, 6: 0x2557, 9: 0x255a, 11: 0x255d, 12: 0x255a, 14: 0x2554 } as Record<number, number>,
    }
    const ATTRS = [BRIGHT, NORMAL, MUTED, DIM]
    const spawn = (i: number) => ({
      x: rnd(term.cols), y: rnd(term.rows), dir: rnd(4),
      set: i % 2 ? DOUBLE : SINGLE,
      attr: ATTRS[i % ATTRS.length]!,
    })
    let squad = [0, 1, 2, 3].map(spawn)
    let drawn = 0
    const RESET_AT = term.cols * term.rows * 1.5

    return {
      frame(t) {
        for (const p of squad) {
          // Two cells per step, to keep the movement quick at a low simulation rate.
          for (let s = 0; s < 2; s++) {
            let ch: number
            if (Math.random() < 0.18) {
              const next = (p.dir + (Math.random() < 0.5 ? 1 : 3)) % 4
              ch = p.set.corner[p.dir * 4 + next]!
              p.dir = next
            } else {
              ch = p.dir % 2 ? p.set.h : p.set.v
            }
            t.put(p.x, p.y, ch, p.attr)
            p.x = (p.x + DX[p.dir]! + t.cols) % t.cols
            p.y = (p.y + DY[p.dir]! + t.rows) % t.rows
            drawn++
          }
        }
        if (drawn > RESET_AT) {
          drawn = 0
          blank(t)
          squad = [0, 1, 2, 3].map(spawn)
        }
      },
    }
  },
}
