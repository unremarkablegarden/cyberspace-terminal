// Box drawing, with junctions that work themselves out.
//
// The problem with drawing frames on a character grid is where lines meet: a
// vertical rule crossing a horizontal one needs ┼, meeting a top edge needs ┬,
// meeting a left edge needs ├. Hardcoding those at each call site is how TUI
// layout code turns into a pile of special cases.
//
// So every line segment is stored as four direction bits and merged with
// whatever is already in the cell. Draw a frame, then draw a divider through
// it, and the junctions appear because ─ plus │ is by definition ┼. Order does
// not matter and nothing needs to know what else is on the grid.
//
// Both faces carry all 128 of U+2500..257F — single AND double — so every
// combination resolves in either. Checked, not assumed: a codepoint missing
// from one face renders as `?` and nothing warns you.

import { NORMAL, BOLD, FAINT, BG } from './attrs.js'
import type { Grid } from './surface.js'

export interface Rect { x: number; y: number; w: number; h: number }

const U = 1, R = 2, D = 4, L = 8

/**
 * Line weight.
 *
 * Weight is not decoration and is never mixed WITHIN a box — that reads as a
 * rendering fault. It is for telling two boxes apart: a double border is how a
 * character grid says "this one", the way `feed` marks the record you are on.
 * Unicode gives the double set no half-length stubs, so those fall back to the
 * single nubs; a one-cell nub is too small to read as a weight either way.
 */
export type Weight = 'single' | 'double'

const SINGLE: Record<number, string> = {
  [R | L]: '─',
  [U | D]: '│',
  [R | D]: '┌',
  [D | L]: '┐',
  [U | R]: '└',
  [U | L]: '┘',
  [U | R | D]: '├',
  [U | D | L]: '┤',
  [R | D | L]: '┬',
  [U | R | L]: '┴',
  [U | R | D | L]: '┼',
  // Stubs, for a one-cell line that has nowhere to go.
  [U]: '╵', [R]: '╶', [D]: '╷', [L]: '╴',
}

const DOUBLE: Record<number, string> = {
  [R | L]: '═',
  [U | D]: '║',
  [R | D]: '╔',
  [D | L]: '╗',
  [U | R]: '╚',
  [U | L]: '╝',
  [U | R | D]: '╠',
  [U | D | L]: '╣',
  [R | D | L]: '╦',
  [U | R | L]: '╩',
  [U | R | D | L]: '╬',
  [U]: '╵', [R]: '╶', [D]: '╷', [L]: '╴',
}

const SETS: Record<Weight, Record<number, string>> = { single: SINGLE, double: DOUBLE }

const reverse = (set: Record<number, string>) => new Map<number, number>(
  Object.entries(set).map(([bits, ch]) => [ch.codePointAt(0)!, Number(bits)])
)

const BITS: Record<Weight, Map<number, number>> = {
  single: reverse(SINGLE),
  double: reverse(DOUBLE),
}

/**
 * Merge line bits into a cell, keeping whatever was already drawn there.
 *
 * Merging is per weight: a cell holding a line of the OTHER weight reads as
 * empty and is overwritten. There is no glyph for a single rule meeting a
 * double one at every angle, and guessing at the ones that exist would make
 * junctions depend on draw order — so a crossing of weights is a covering,
 * which at least is predictable.
 */
/**
 * Region a draw is confined to, on top of the grid's own bounds.
 *
 * For a pane that SCROLLS a column of boxes: a box half off the top of the
 * pane has to lose the half that is off, not paint it over the chrome above.
 * Passing the pane as `clip` lets a caller lay boxes out in virtual space and
 * hand them coordinates that are partly outside it, which is the whole trick —
 * without it, a scrolling list has to special-case its first and last item.
 */
export function inside(clip: Rect | undefined, x: number, y: number): boolean {
  if (!clip) return true
  return x >= clip.x && y >= clip.y && x < clip.x + clip.w && y < clip.y + clip.h
}

function plot(
  term: Grid, x: number, y: number, bits: number, attr: number,
  weight: Weight, clip?: Rect,
) {
  if (x < 0 || y < 0 || x >= term.cols || y >= term.rows) return
  if (!inside(clip, x, y)) return
  // The tube stores code points and a Surface stores characters; a junction
  // has to read back either.
  const cell = term.chars[y * term.cols + x]
  const code = typeof cell === 'string' ? cell.codePointAt(0) ?? 32 : cell ?? 32
  const existing = BITS[weight].get(code) ?? 0
  const glyph = SETS[weight][existing | bits]
  if (glyph) term.put(x, y, glyph, attr)
}

export function hline(
  term: Grid, y: number, x0: number, x1: number, attr = NORMAL,
  weight: Weight = 'single', clip?: Rect,
) {
  for (let x = x0; x <= x1; x++) {
    plot(term, x, y, (x > x0 ? L : 0) | (x < x1 ? R : 0), attr, weight, clip)
  }
}

export function vline(
  term: Grid, x: number, y0: number, y1: number, attr = NORMAL,
  weight: Weight = 'single', clip?: Rect,
) {
  for (let y = y0; y <= y1; y++) {
    plot(term, x, y, (y > y0 ? U : 0) | (y < y1 ? D : 0), attr, weight, clip)
  }
}

/**
 * Draw a frame and return the usable area inside it.
 *
 * The returned Rect is the box's own interior whether or not any of it survived
 * the clip — it describes the box, not what was painted. A caller drawing into
 * it must clip its own rows the same way.
 */
export function frame(
  term: Grid, r: Rect, attr = NORMAL, weight: Weight = 'single', clip?: Rect,
): Rect {
  const x1 = r.x + r.w - 1
  const y1 = r.y + r.h - 1
  hline(term, r.y, r.x, x1, attr, weight, clip)
  hline(term, y1, r.x, x1, attr, weight, clip)
  vline(term, r.x, r.y, y1, attr, weight, clip)
  vline(term, x1, r.y, y1, attr, weight, clip)
  return { x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }
}

/** A run of text within a label, so one label can mix treatments. */
export interface Span {
  text: string
  attr?: number
  /**
   * Draw as a keycap: the beam fills the cell and the glyph is the hole left
   * in it. A real terminal had no other way to make something look pressable,
   * and it costs nothing — term.ts has carried the inverse plane from the
   * start. Pad the text with a space either side and the inversion becomes the
   * cap around it.
   */
  inverse?: boolean
}

/**
 * A footer of key hints: the key, then what it does, repeated.
 *
 * A key spelled in LETTERS is BOLD and the word beside it is not — the reader
 * is scanning for the key, and weight is what says where it is. A key that is
 * already a SYMBOL (‹›, ⬆⬇, ↵, ⌫) needs no help being found and takes none.
 *
 * This is for a box's own bottom rule, drawn as plain text. The inverse keycap
 * is the app frame's voice, not a modal's, and carries its own weight anyway —
 * an inverted cell is bold whatever it was drawn as.
 */
export function keyHint(pairs: [key: string, action: string][], gap = '  '): Span[] {
  const out: Span[] = []
  pairs.forEach(([key, action], i) => {
    if (i) out.push({ text: gap })
    out.push({ text: key, attr: /[A-Za-z]/.test(key) ? BOLD : NORMAL })
    out.push({ text: ' ' + action })
  })
  return out
}

/** Grid cells a string occupies. Code points, not UTF-16 units. */
export const cells = (s: string) => [...s].length

/** Cut a run of spans to `width` cells, dropping whole spans past the end. */
function trimSpans(spans: Span[], width: number): Span[] {
  const out: Span[] = []
  let left = width
  for (const span of spans) {
    if (left <= 0) break
    const w = cells(span.text)
    out.push(w <= left ? span : { ...span, text: [...span.text].slice(0, left).join('') })
    left -= w
  }
  return out
}

/**
 * A label set into a rule, the way every TUI has done it. `align` is measured
 * from the left or right edge of the box, inset by 2 so it never lands on a
 * corner.
 *
 * Spans instead of a plain string when parts of the label need their own
 * treatment — a row of key hints, where the keys are capped and the words
 * between them are not.
 *
 * `max` is the cells the label may occupy, blanks included. A label whose text
 * is not fixed — a room name, a head count — shares its rule with a junction, a
 * corner, or another label, and without a budget a long one simply writes over
 * them and the frame comes apart.
 */
export function label(
  term: Grid,
  r: Rect,
  text: string | Span[],
  opts: {
    edge?: 'top' | 'bottom'; align?: 'left' | 'right'; attr?: number
    clip?: Rect; max?: number
  } = {}
) {
  const { edge = 'top', align = 'left', attr = NORMAL, clip, max } = opts
  let spans = typeof text === 'string' ? [{ text }] : text
  if (max !== undefined) spans = trimSpans(spans, Math.max(0, max - 2))
  // A blank either side, so the label sits in a gap in the rule rather than
  // running straight into it. Never inverted — that gap is the point.
  const width = spans.reduce((n, s) => n + cells(s.text), 2)

  const y = edge === 'top' ? r.y : r.y + r.h - 1
  let x = align === 'left' ? r.x + 2 : r.x + r.w - 2 - width

  // A label lives in one row of one rule, so it is in or out as a whole — no
  // point clipping it column by column when the rule it sits in is gone.
  if (clip && (y < clip.y || y >= clip.y + clip.h)) return

  term.put(x++, y, 32, attr)
  for (const span of spans) {
    term.text(x, y, span.text, span.attr ?? attr, span.inverse ? 1 : 0)
    x += cells(span.text)
  }
  term.put(x, y, 32, attr)
}

/** Fill a region with blanks. Cheaper than clearing and redrawing the frame. */
export function clear(term: Grid, r: Rect) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) term.put(x, y, 32)
  }
}

/**
 * Light the region a popup covers — the LAST thing a popup's draw does.
 *
 * The tube has no background colour: `raster()` gives each cell a beam level
 * for the pixels its glyph lights and black for the rest. `BG` makes that black
 * a low level instead (see term.ts), which is what turns a box from a frame cut
 * OUT of the screen into a panel lying ON it.
 *
 * **A sweep at the end rather than an attribute threaded through the draw.** A
 * ground is per cell and a popup writes its cells from a dozen places — the
 * blanks, the frame, two or three labels, the rows, the dividers, an inverted
 * selection, an input line with a caret in it. ORing `BG` into every one of
 * those means every future call site has to remember, and the cost of
 * forgetting is a visible hole in the middle of the panel. Sweeping the rect
 * afterwards cannot miss one, and leaves every widget's own attributes alone:
 * this only ever ADDS the bit.
 *
 * Called with the box's own rect, so it stops at the border — the drop shadow
 * lands OUTSIDE that and keeps its own level, which is what stops a lit box
 * from dissolving into the shadow it casts.
 *
 * Picture cells are skipped. A photograph's dark pixels are part of the
 * photograph, and lifting them off black is not a panel behind the image, it is
 * a fog over it.
 */
export function ground(term: Grid, r: Rect) {
  for (let y = Math.max(0, r.y); y < Math.min(term.rows, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(term.cols, r.x + r.w); x++) {
      const i = y * term.cols + x
      if (term.gfx?.[i]) continue
      term.attrs[i]! |= BG
    }
  }
  term.dirty = true
}

/**
 * The shadow a box casts: solid blocks down its right side, half blocks along
 * its foot, offset one row down and one column right.
 *
 * That offset is the whole trick — a right edge and a bottom edge meeting at a
 * corner is what a light from the top left leaves. The same shadow the boot
 * banner wears and the same one the site's DOS modals wear in CSS.
 *
 * Solid at FAINT rather than the banner's dithered `░` at full beam: a dithered
 * cell breaks up at this size and reads as noise lying on the program
 * underneath, where an even field reads as a shape the box is casting.
 *
 * FAINT (100) and not DIM (150) because a solid block lights every pixel of its
 * cell. At DIM it put four and a half times the light on the glass as the text
 * beside it and read as a lit panel rather than a shadow; the tier exists
 * precisely because the floor that keeps a STROKE legible is the wrong floor
 * for a filled field. See FAINT in term.ts.
 * The foot is a HALF block because a cell is twice as tall as it is wide, so a
 * full row under the box would be a shadow twice as deep as the one down its
 * side.
 *
 * `clip` is the region the shadow is allowed into — a modal's own `bounds`,
 * normally. `put` would clamp to the grid on its own, but bounds is what a
 * program hands over as the part of the screen it will have covered, and a
 * shadow is still covering.
 */
export function shadow(term: Grid, r: Rect, clip?: Rect) {
  const b = clip ?? { x: 0, y: 0, w: term.cols, h: term.rows }
  const fits = (x: number, y: number) =>
    x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h

  for (let i = 1; i < r.h; i++) {
    if (fits(r.x + r.w, r.y + i)) term.put(r.x + r.w, r.y + i, '█', FAINT)
  }
  // The foot runs last and one cell further right than the side, so the corner
  // is the half block: the shadow turns there rather than stacking a full cell
  // on top of a half one.
  for (let k = 1; k <= r.w; k++) {
    if (fits(r.x + k, r.y + r.h)) term.put(r.x + k, r.y + r.h, '▀', FAINT)
  }
}
