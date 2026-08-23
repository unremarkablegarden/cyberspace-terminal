import { NORMAL, BRIGHT, DIM } from '../term.js'
import type { SaverSpec } from './common.js'
import { rnd } from './common.js'

/**
 * cmatrix. One drop per column at a fractional speed: the head is BRIGHT, the
 * cell behind it NORMAL, a DIM flicker mutates mid-trail, and a space erases
 * the tail. The held phosphor decay produces the streaks that cmatrix
 * approximates with a palette.
 */
export const matrix: SaverSpec = {
  name: 'matrix', summary: 'digital rain', fps: 20, decay: 0.88,
  make(term) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=<>:;'
    const glyph = () => CHARS.charCodeAt(rnd(CHARS.length))
    const drop = () => ({
      y: -Math.random() * term.rows * 2,
      speed: 6 + Math.random() * 14, // rows per second
      len: 4 + rnd(term.rows * 0.6),
    })
    const drops = Array.from({ length: term.cols }, drop)

    return {
      frame(t, dt) {
        for (let x = 0; x < t.cols; x++) {
          const d = drops[x]!
          const prev = Math.floor(d.y)
          d.y += d.speed * dt
          const head = Math.floor(d.y)
          // Every row the head crossed this step, so a fast drop leaves no gap.
          for (let r = prev + 1; r <= head; r++) {
            t.put(x, r, glyph(), BRIGHT)
            t.put(x, r - 1, glyph(), NORMAL)
            t.put(x, r - ((d.len * 0.7) | 0), glyph(), DIM)
            t.put(x, r - d.len, 32, NORMAL)
          }
          if (head - d.len > t.rows) drops[x] = drop()
        }
      },
    }
  },
}
