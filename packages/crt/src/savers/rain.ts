import { NORMAL, BRIGHT, DIM } from '../term.js'
import type { Term } from '../term.js'
import type { SaverSpec } from './common.js'
import { rnd } from './common.js'

/**
 * bsdgames rain. Drops land at random positions and age through a splash of
 * dot, ring and spray before erasing themselves. Nothing accumulates.
 */
export const rain: SaverSpec = {
  name: 'rain', summary: 'a storm on the glass', fps: 10,
  make(term) {
    const drops: { x: number; y: number; age: number }[] = []
    const put = (t: Term, x: number, y: number, ch: number, attr: number) => t.put(x, y, ch, attr)

    return {
      frame(t) {
        for (let i = drops.length - 1; i >= 0; i--) {
          const d = drops[i]!
          d.age++
          switch (d.age) {
            case 1: put(t, d.x, d.y, 111, NORMAL); break             // o
            case 2: put(t, d.x, d.y, 79, BRIGHT); break              // O
            case 3:
              put(t, d.x, d.y, 32, NORMAL)
              put(t, d.x, d.y - 1, 124, DIM); put(t, d.x, d.y + 1, 124, DIM) // |
              put(t, d.x - 1, d.y, 45, DIM); put(t, d.x + 1, d.y, 45, DIM)   // -
              break
            case 4:
              put(t, d.x, d.y - 1, 32, NORMAL); put(t, d.x, d.y + 1, 32, NORMAL)
              put(t, d.x - 1, d.y, 32, NORMAL); put(t, d.x + 1, d.y, 32, NORMAL)
              drops.splice(i, 1)
              break
          }
        }
        for (let n = 1 + rnd(2); n > 0; n--) {
          const d = { x: rnd(term.cols), y: rnd(term.rows), age: 0 }
          drops.push(d)
          put(term, d.x, d.y, 46, DIM) // .
        }
      },
    }
  },
}
