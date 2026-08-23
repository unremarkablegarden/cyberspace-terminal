import { BRIGHT } from '../term.js'
import { DotCanvas } from '../vector.js'
import type { SaverSpec } from './common.js'
import { blank } from './common.js'

/**
 * A starfield on the braille bitmap, using the grid as 160x100 dots, as
 * examples/river does. Stars move outward from the centre, each drawn with a
 * short streak back to its previous position.
 */
export const stars: SaverSpec = {
  name: 'stars', summary: 'punch it', fps: 30,
  make(term) {
    const c = new DotCanvas(term)
    const N = 240
    const SPEED = 0.45 // fractions of z per second
    const spawn = () => ({
      x: Math.random() * 2 - 1, y: Math.random() * 2 - 1,
      z: 0.15 + Math.random() * 0.85,
    })
    const field = Array.from({ length: N }, spawn)
    const px = (s: { x: number; z: number }) => c.w / 2 + (s.x / s.z) * (c.w / 2)
    const py = (s: { y: number; z: number }) => c.h / 2 + (s.y / s.z) * (c.h / 2)

    return {
      frame(t, dt) {
        blank(t)
        c.clear()
        for (let i = 0; i < field.length; i++) {
          let s = field[i]!
          const ox = px(s), oy = py(s)
          s.z -= SPEED * dt
          if (s.z <= 0.05 || Math.abs(px(s)) > c.w * 2 || Math.abs(py(s)) > c.h * 2) {
            s = field[i] = spawn()
            c.line(px(s), py(s), px(s), py(s))
            continue
          }
          c.line(ox, oy, px(s), py(s))
        }
        c.blit(t, BRIGHT)
      },
    }
  },
}
