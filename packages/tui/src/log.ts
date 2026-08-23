// A bottom-anchored pane of wrapped lines: a scrolling log.
//
// Anchored at the bottom so the newest line is always visible and a partly
// filled pane rests on the floor of its box.
//
// The caller owns the scroll position and passes it in, since only the caller
// knows what should reset it. This holds no state.

import { NORMAL } from './attrs.js'
import type { Grid } from './surface.js'
import { ground, type Rect } from './box.js'

/**
 * A run within a line carrying its own attribute, such as the timestamp or the
 * name. Given as an offset and length into `text`, since the caller builds that
 * string from fixed-width fields and already knows its column positions.
 */
export interface LineSpan {
  at: number
  len: number
  attr: number
}

export interface LogLine {
  text: string
  attr?: number
  /**
   * Runs to re-attribute, applied over the base text in order. A list rather
   * than one span, because a circ entry needs its timestamp set DIM and its
   * name set BRIGHT on the same line.
   */
  spans?: LineSpan[]
  /**
   * Draw the row on a lit background (BG, see term.ts), the same one a modal
   * panel uses. The text keeps its own attributes rather than being inverted.
   *
   * Applied as a sweep after the line is drawn, for the reason given for
   * `ground` in box.ts: the background is per cell and this line writes cells
   * from three places (the text, the spans, and the blanks past the last word),
   * so a sweep covers all of them. It also means the text need not be padded to
   * the pane width, since the trailing cells are already spaces.
   */
  bar?: boolean
  /**
   * Column at which the background starts; cells before it are left dark.
   * Defaults to the margin, covering the whole row.
   *
   * Used to light the message text without the timestamp and nick columns,
   * which are identical on every row and would flash on each mention.
   */
  barFrom?: number
}

/**
 * Break one logical entry into display lines. Continuation lines are indented to
 * `hang`, so a wrapped message stays under its own text column rather than
 * returning to the margin.
 */
export function hangingWrap(head: string, body: string, width: number): string[] {
  const usable = Math.max(1, width - head.length)
  const text = body.replace(/\s+/g, ' ').trim()
  if (!text) return [head]

  const out: string[] = []
  let line = ''
  for (let word of text.split(' ')) {
    while (word.length > usable) {
      if (line) { out.push(line); line = '' }
      out.push(word.slice(0, usable))
      word = word.slice(usable)
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= usable) line += ' ' + word
    else { out.push(line); line = word }
  }
  if (line) out.push(line)

  const pad = ' '.repeat(head.length)
  return out.map((l, i) => (i === 0 ? head : pad) + l)
}

/**
 * `scroll` is how many lines back from the newest to display; 0 is the bottom.
 * Out-of-range values are clamped rather than rejected, because the list it
 * indexes changes as messages arrive and age out.
 */
export function drawLog(term: Grid, r: Rect, lines: LogLine[], scroll = 0) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) term.put(x, y, 32)
  }

  const back = Math.max(0, Math.min(scroll, Math.max(0, lines.length - r.h)))
  const end = lines.length - back
  const visible = lines.slice(Math.max(0, end - r.h), end)
  const top = r.y + Math.max(0, r.h - visible.length)

  for (let i = 0; i < visible.length; i++) {
    const line = visible[i]!
    const y = top + i

    const text = line.text.slice(0, r.w)
    term.text(r.x, y, text, line.attr ?? NORMAL, 0)

    for (const s of line.spans ?? []) {
      // Sliced from the already-truncated text, so a span running past the end
      // of the pane, or of a partly typed line, is shortened rather than out of
      // bounds.
      term.text(r.x + s.at, y, text.slice(s.at, s.at + s.len), s.attr, 0)
    }

    // Applied last, over every cell the line wrote including trailing blanks:
    // the background is a bit ORed onto cells that are already drawn.
    if (line.bar) {
      const from = Math.max(0, Math.min(line.barFrom ?? 0, r.w))
      ground(term, { x: r.x + from, y, w: r.w - from, h: 1 })
    }
  }
}
