// A tail-anchored pane of wrapped lines — a scrolling log.
//
// Anchored at the bottom rather than the top: the newest line is the one that
// matters, and a partially-filled pane should sit on the floor of its box the
// way a chat window does, not float at the ceiling.
//
// The caller owns the scroll position and passes it in, because only the caller
// knows what should reset it. The pane holds no state of its own.

import { NORMAL } from './attrs.js'
import type { Grid } from './surface.js'
import { ground, type Rect } from './box.js'

/**
 * A run of the line that carries its own attribute — the clock in front of a
 * message, the name after it. Given as an offset and a length into `text`,
 * because the caller builds that string by padding fixed-width fields and
 * already knows where its own columns are.
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
   * than the single highlight this started as: a cIRC entry wants its clock
   * pushed down to DIM and its name lifted to BRIGHT in the same line, and one
   * span can only do one of them.
   */
  spans?: LineSpan[]
  /**
   * Draw as a bar: the row sits on a lit ground, the same one a modal's panel
   * sits on (`BG`, see term.ts). The words keep their own attributes and are
   * read exactly as they would be anywhere else — the row is lit from behind,
   * not turned inside out.
   *
   * Applied as a sweep once the line is drawn, for the reason `ground` gives in
   * box.ts: a ground is per cell, this line writes its cells from three places
   * (the text, the spans, the blanks past the last word), and a sweep cannot
   * miss one. It also means nothing here has to pad the text to the width of
   * the pane — the cells past the end of the sentence are already spaces, and
   * the sweep lights them with the rest.
   */
  bar?: boolean
  /**
   * Column the bar starts at; everything before it is left dark. Defaults to
   * the margin, i.e. the whole row.
   *
   * The point is that a bar should cover what was said and not the furniture
   * around it. Lighting the clock and the nick column too makes the fixed
   * chrome flash on every mention, which is the part of the row that was
   * identical before the highlight and is still identical after it.
   */
  barFrom?: number
}

/**
 * Break one logical entry into display lines. Continuations are indented to
 * `hang` so a wrapped message stays under its own text column instead of
 * running back to the margin, which is the whole reason an aligned nick column
 * is readable.
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
 * `scroll` is how many lines back from the newest to sit, so 0 is the bottom.
 * Out-of-range values are clamped rather than rejected — the list it indexes
 * into changes on its own as messages arrive and age out of the window.
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
      // Sliced from the already-truncated text, so a span that runs off the
      // end of the pane — or off the end of a half-typed line — is simply
      // shorter rather than out of bounds.
      term.text(r.x + s.at, y, text.slice(s.at, s.at + s.len), s.attr, 0)
    }

    // Last, over everything the line just wrote, including the blanks past its
    // last word: the ground is a bit ORed onto cells that are already drawn.
    if (line.bar) {
      const from = Math.max(0, Math.min(line.barFrom ?? 0, r.w))
      ground(term, { x: r.x + from, y, w: r.w - from, h: 1 })
    }
  }
}
