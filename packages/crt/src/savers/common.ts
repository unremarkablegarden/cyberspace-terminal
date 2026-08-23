// The screensaver contract and the helpers every saver uses.
//
// A saver is a frame function over the cell grid. SaverScreen (saver.ts) owns
// the rAF loop, the fixed-step accumulator and cleanup, so a saver does not
// need to know how it is driven. Any key dismisses it, and the screen stack's
// snapshot restores what was beneath.
//
// No colour: BRIGHT through DIM are beam levels. A saver needing more
// resolution than the cell grid uses what the grid already carries, either
// braille dots (life, stars, dvd) or per-cell bitmaps via putGlyph (fire),
// rather than a glyph a font might lack.

import { NORMAL } from '../term.js'
import type { Term } from '../term.js'

/** Break text on word boundaries to fit `width` columns. Used by fortune. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) { line = word; continue }
      if (line.length + 1 + word.length <= width) { line += ' ' + word; continue }
      out.push(line)
      line = word
    }
    out.push(line)
  }
  return out
}

export interface SaverDeps {
  /** Phosphor persistence, for savers that want a longer trail. */
  setDecay: (value: number | null) => void
  /** The fortune text source, kept as a single shared copy. */
  fortune: () => Promise<string | null>
}

export interface Saver {
  /** One fixed step. dt is always 1/fps; the host owns the accumulator. */
  frame(term: Term, dt: number): void
  dispose?(): void
}

export interface SaverSpec {
  name: string
  /** A one-line summary for the picker's right column. */
  summary: string
  /** Fixed simulation rate. The host never calls frame() faster or slower. */
  fps: number
  /**
   * Phosphor decay held while this saver runs, applied and released by the host,
   * since a saver exiting while still holding it would leave the prompt
   * smeared. Absolute, clamped to DECAY_MAX in crt.ts.
   */
  decay?: number
  make(term: Term, deps: SaverDeps): Saver
}


/** Clear to spaces at NORMAL with the cursor off. The starting state for every saver. */
export function blank(term: Term) {
  for (let y = 0; y < term.rows; y++) {
    for (let x = 0; x < term.cols; x++) term.put(x, y, 32, NORMAL)
  }
  term.showCursor = false
}

/** A random integer under `n`. */
export const rnd = (n: number) => (Math.random() * n) | 0
