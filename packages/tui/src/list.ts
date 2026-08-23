// A plain list of items, top-anchored, truncated with a count when it overflows.
//
// Separate from drawLog, which anchors to the bottom and drops the head; this
// anchors to the top and drops the tail.

import { NORMAL } from './attrs.js'
import type { Grid } from './surface.js'
import type { Rect, Span } from './box.js'

export interface ListItem {
  /**
   * Spans rather than a plain string when parts of a row need their own
   * attributes, as label() also accepts. circ's online pane uses this to draw a
   * DIM idle marker beside a NORMAL name.
   */
  text: string | Span[]
  /** Attribute used for spans that do not carry one. */
  attr?: number
}

export function drawList(term: Grid, r: Rect, items: ListItem[]) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) term.put(x, y, 32)
  }
  if (r.h <= 0) return

  // When the list overflows, the last row reports how many items are hidden;
  // a silently truncated list would read as a complete one.
  const overflow = items.length > r.h
  const shown = overflow ? items.slice(0, r.h - 1) : items

  for (let i = 0; i < shown.length; i++) {
    const item = shown[i]!
    const spans = typeof item.text === 'string' ? [{ text: item.text }] : item.text
    // Truncated per row rather than per span: each span takes what remains of
    // the width, so an over-long row is cut short instead of writing past the
    // right edge.
    let x = r.x
    for (const s of spans) {
      const room = r.x + r.w - x
      if (room <= 0) break
      term.text(x, r.y + i, s.text.slice(0, room), s.attr ?? item.attr ?? NORMAL, s.inverse ? 1 : 0)
      x += Math.min(s.text.length, room)
    }
  }

  if (overflow) {
    const more = `+${items.length - shown.length} more`
    term.text(r.x, r.y + r.h - 1, more.slice(0, r.w), NORMAL)
  }
}
