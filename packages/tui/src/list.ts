// A plain list of items, top-anchored, truncated with a count when it overflows.
//
// Separate from drawLog because the two want opposite things: a log anchors to
// the bottom and drops the head, a list anchors to the top and drops the tail.

import { NORMAL } from './attrs.js'
import type { Grid } from './surface.js'
import type { Rect, Span } from './box.js'

export interface ListItem {
  /**
   * Spans instead of a plain string when parts of a row need their own
   * treatment — the same escape hatch label() takes, and for the same reason.
   * cIRC's online pane puts a DIM sleep marker in front of a NORMAL name.
   */
  text: string | Span[]
  /** Fallback for spans that do not carry one of their own. */
  attr?: number
}

export function drawList(term: Grid, r: Rect, items: ListItem[]) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) term.put(x, y, 32)
  }
  if (r.h <= 0) return

  // If it does not fit, give up the last row to say how much is hidden —
  // a silently truncated list reads as a complete one.
  const overflow = items.length > r.h
  const shown = overflow ? items.slice(0, r.h - 1) : items

  for (let i = 0; i < shown.length; i++) {
    const item = shown[i]!
    const spans = typeof item.text === 'string' ? [{ text: item.text }] : item.text
    // Truncation is per row, not per span: each span gets whatever is left of
    // the width, so a row overruns the pane by being cut short rather than by
    // writing past its right edge.
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
