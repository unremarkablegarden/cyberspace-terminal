import { NORMAL, BRIGHT, DIM, MUTED } from '../term.js'
import { DotCanvas } from '../vector.js'
import type { SaverSpec } from './common.js'
import { blank } from './common.js'

/**
 * The 5x7 wordmark, one string per letter row, with `#` marking a lit dot.
 * Only the letters needed to spell CYBERSPACE.
 */
const DVD_FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
}

/**
 * A bouncing wordmark. Drawn on the braille bitmap rather than the cell grid,
 * since moving a whole cell per step reads as a rendering fault and the dots
 * are the finest resolution available. The mark changes beam level on each wall
 * it touches, in place of the original's colour cycling.
 */
export const dvd: SaverSpec = {
  name: 'dvd', summary: 'waiting for the corner', fps: 30,
  make(term) {
    const c = new DotCanvas(term)
    const TEXT = 'CYBERSPACE'
    const STEP = 6 // five columns of letter, one of gap
    const W = TEXT.length * STEP - 1
    const H = 7
    const ATTRS = [BRIGHT, NORMAL, MUTED, DIM]
    let x = Math.random() * (c.w - W)
    let y = Math.random() * (c.h - H)
    let vx = 26, vy = 13 // dots per second
    let ai = 0

    return {
      frame(t, dt) {
        x += vx * dt
        y += vy * dt
        const mx = c.w - W, my = c.h - H
        if (x <= 0 || x >= mx) { vx = -vx; x = Math.min(mx, Math.max(0, x)); ai++ }
        if (y <= 0 || y >= my) { vy = -vy; y = Math.min(my, Math.max(0, y)); ai++ }

        blank(t)
        c.clear()
        for (let i = 0; i < TEXT.length; i++) {
          const glyph = DVD_FONT[TEXT[i]!]!
          for (let r = 0; r < H; r++) {
            const row = glyph[r]!
            for (let col = 0; col < row.length; col++) {
              if (row[col] === '#') c.plot((x | 0) + i * STEP + col, (y | 0) + r)
            }
          }
        }
        c.blit(t, ATTRS[ai % ATTRS.length]!)
      },
    }
  },
}
