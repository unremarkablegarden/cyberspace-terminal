import { NORMAL, BRIGHT, DIM } from '../term.js'
import type { SaverSpec } from './common.js'
import { blank, wrap } from './common.js'

/**
 * A random epigram typed into the centre of the screen, held long enough to
 * read, then replaced, inside a marquee of chasing lights around the edge with
 * every third one lit. Uses the same 629 entries `fortune` prints, from one
 * shared copy of the text.
 *
 * Silent, because this starts on its own after an idle timeout.
 */
export const fortune: SaverSpec = {
  name: 'fortune', summary: 'the cookie jar', fps: 30,
  make(term, deps) {
    let lines: string[] = []
    let x0 = 0, y0 = 0
    let li = 0, ci = 0
    let hold = 0
    let phase: 'loading' | 'typing' | 'holding' = 'loading'
    let disposed = false

    // The perimeter, walked clockwise from the top-left corner, so the chase
    // travels around the frame rather than mirroring at the corners.
    const bulbs: [number, number][] = []
    for (let x = 0; x < term.cols; x++) bulbs.push([x, 0])
    for (let y = 1; y < term.rows; y++) bulbs.push([term.cols - 1, y])
    for (let x = term.cols - 2; x >= 0; x--) bulbs.push([x, term.rows - 1])
    for (let y = term.rows - 2; y >= 1; y--) bulbs.push([0, y])
    let tick = 0

    const load = () => {
      phase = 'loading'
      deps.fortune().then((text) => {
        if (disposed) return
        // Inset two columns and two rows from the marquee on each side.
        const width = Math.min(term.cols - 8, 62)
        lines = wrap(text ?? 'the jar is empty', width)
        const widest = lines.reduce((n, l) => Math.max(n, l.length), 0)
        x0 = Math.max(2, (term.cols - widest) >> 1)
        y0 = Math.max(2, (term.rows - lines.length) >> 1)
        li = ci = 0
        blank(term)
        phase = 'typing'
      })
    }
    load()

    return {
      frame(t) {
        // The lights continue through every phase, so the marquee does not go
        // dark between fortunes.
        tick++
        const step = (tick / 4) | 0 // ~7 chases a second
        for (let i = 0; i < bulbs.length; i++) {
          const [bx, by] = bulbs[i]!
          const lit = (i + step) % 3 === 0
          t.put(bx, by, lit ? 111 : 46, lit ? BRIGHT : DIM) // o / .
        }

        if (phase === 'typing') {
          const line = lines[li]
          if (line === undefined) {
            phase = 'holding'
            hold = 30 * 7 // seven seconds to read it, in ticks
            return
          }
          if (ci < line.length) {
            t.put(x0 + ci, y0 + li, line.charCodeAt(ci), NORMAL)
            ci++
          } else {
            li++; ci = 0
          }
        } else if (phase === 'holding' && --hold <= 0) {
          load()
        }
      },
      dispose() { disposed = true },
    }
  },
}
