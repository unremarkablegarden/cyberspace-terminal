// Box drawing with self-resolving junctions.
//
// Where lines meet on a character grid, the glyph depends on the directions
// present: a vertical rule crossing a horizontal one needs ┼, meeting a top
// edge needs ┬, meeting a left edge needs ├. Choosing those at each call site
// produces a large number of special cases.
//
// Instead, each line segment is stored as four direction bits and merged with
// whatever the cell already holds, so drawing a frame and then a divider
// through it produces the junctions automatically. Draw order does not matter
// and no caller needs to know what else is on the grid.
//
// Both fonts carry all 128 code points of U+2500..257F, single and double, so
// every combination resolves. Verified rather than assumed: a code point
// missing from a font renders as `?` with no warning.

import { NORMAL, BOLD, FAINT, BG } from './attrs.js'
import { isPictureCell } from './pict.js'
import type { Grid } from './surface.js'

export interface Rect { x: number; y: number; w: number; h: number }

const U = 1, R = 2, D = 4, L = 8

/**
 * Line weight.
 *
 * Never mixed within one box, which reads as a rendering fault. Weight
 * distinguishes one box from another: feed uses a double border to mark the
 * selected record. Unicode provides no half-length stubs for the double set, so
 * those fall back to the single ones; a one-cell stub is too small to show a
 * weight difference.
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
  // Stubs, for a one-cell line with no continuation.
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
 * Merge line bits into a cell, preserving what was already drawn.
 *
 * Merging is per weight: a cell holding a line of the other weight is treated
 * as empty and overwritten. Unicode has no glyph for every angle at which a
 * single rule meets a double one, and using the subset that exists would make
 * junctions depend on draw order, so a crossing of weights overwrites instead.
 */
/**
 * Region a draw is confined to, in addition to the grid's own bounds.
 *
 * For a pane scrolling a column of boxes: a box partly above the pane must lose
 * the part outside rather than painting over the chrome above. Passing the pane
 * as `clip` lets a caller lay boxes out in virtual space with coordinates
 * partly outside it, so a scrolling list needs no special case for its first
 * and last items.
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
  // The CRT grid stores code points and a Surface stores characters, so a
  // junction must read back from either.
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
 * The returned Rect is the box's interior whether or not any of it survived the
 * clip: it describes the box rather than what was painted. A caller drawing
 * into it must apply the same clip.
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

/** A run of text within a label, so one label can mix attributes. */
export interface Span {
  text: string
  attr?: number
  /**
   * Draw inverted, as a keycap. Padding the text with a space either side makes
   * the inverted region read as the cap around it. term.ts has carried the
   * inverse plane from the start, so this costs nothing.
   */
  inverse?: boolean
}

/**
 * A footer of key hints: each key followed by its label.
 *
 * A key written as letters is drawn BOLD and its label is not, so the eye finds
 * the key. A key that is already a symbol (‹›, ⬆⬇, ↵, ⌫) is distinct enough
 * without it.
 *
 * For a box's bottom rule, drawn as plain text. Inverse keycaps are used on the
 * application frame rather than in modals, and are bold in any case since an
 * inverted cell reads as bold whatever attribute it carries.
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

/** Grid cells a string occupies, counted in code points rather than UTF-16 units. */
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
 * A label set into a rule. `align` is measured from the left or right edge of
 * the box, inset by 2 so it never lands on a corner.
 *
 * Takes spans rather than a plain string when parts of the label need their own
 * attributes, such as a row of key hints where the keys are capped.
 *
 * `max` is the number of cells the label may occupy, blanks included. A label
 * of variable length, such as a room name or a member count, shares its rule
 * with a junction, a corner or another label, and without a budget would
 * overwrite them.
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
  // A blank either side, so the label sits in a gap in the rule. Never
  // inverted, since the gap is what separates it.
  const width = spans.reduce((n, s) => n + cells(s.text), 2)

  const y = edge === 'top' ? r.y : r.y + r.h - 1
  let x = align === 'left' ? r.x + 2 : r.x + r.w - 2 - width

  // A label occupies one row of one rule, so it is drawn or skipped as a whole
  // rather than clipped column by column.
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
 * Light the region a popup covers. Called last in a popup's draw.
 *
 * The display has no background colour: raster() gives each cell a beam level
 * for the pixels its glyph lights and black for the rest. BG raises that black
 * to a low level (see term.ts), so the box reads as a panel over the screen
 * rather than a frame cut out of it.
 *
 * Applied as a sweep at the end rather than threaded through the draw. The
 * background is per cell and a popup writes cells from many places: the blanks,
 * the frame, the labels, the rows, the dividers, an inverted selection and an
 * input line. ORing BG into each would require every future call site to
 * remember, and omitting it leaves a visible hole in the panel. A sweep cannot
 * miss a cell and leaves existing attributes intact, since it only adds the bit.
 *
 * Called with the box's own rect, so it stops at the border. The drop shadow
 * falls outside that and keeps its own level, which stops a lit box merging
 * into its shadow.
 *
 * Picture cells are skipped: an image's dark pixels are part of the image, and
 * raising them off black would wash it out rather than backing it.
 */
export function ground(term: Grid, r: Rect) {
  for (let y = Math.max(0, r.y); y < Math.min(term.rows, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(term.cols, r.x + r.w); x++) {
      const i = y * term.cols + x
      // Two planes are checked, because a picture cell differs between them:
      // the CRT grid keeps a bitmap beside the character and a Surface keeps
      // the handle as the character. See pict.ts.
      if (term.gfx?.[i] || isPictureCell(term.chars[i])) continue
      term.attrs[i]! |= BG
    }
  }
  term.dirty = true
}

/**
 * The shadow a box casts: solid blocks down its right side and half blocks
 * along its foot, offset one row down and one column right.
 *
 * The offset produces the shadow a light from the top left would leave. The
 * same offset the boot banner uses and the website's DOS modals use in CSS.
 *
 * Solid at FAINT rather than the banner's dithered block at full beam: a
 * dithered cell breaks up at this size and reads as noise over the program
 * beneath, where an even field reads as a cast shadow.
 *
 * FAINT (100) rather than DIM (150) because a solid block lights every pixel of
 * its cell. At DIM it emits about four and a half times the light of adjacent
 * text and reads as a lit panel; the FAINT tier exists because the level that
 * keeps a stroke legible is too high for a filled field. See FAINT in term.ts.
 *
 * The foot uses half blocks because a cell is twice as tall as it is wide, so a
 * full row would be twice as deep as the shadow down the side.
 *
 * `clip` is the region the shadow may enter, normally a modal's own bounds.
 * put() clamps to the grid by itself, but bounds is the area a program has
 * declared it covers, and the shadow is part of that coverage.
 */
export function shadow(term: Grid, r: Rect, clip?: Rect) {
  const b = clip ?? { x: 0, y: 0, w: term.cols, h: term.rows }
  const fits = (x: number, y: number) =>
    x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h

  for (let i = 1; i < r.h; i++) {
    if (fits(r.x + r.w, r.y + i)) term.put(r.x + r.w, r.y + i, '█', FAINT)
  }
  // The foot is drawn last and one cell further right than the side, so the
  // corner is a half block rather than a full cell over a half one.
  for (let k = 1; k <= r.w; k++) {
    if (fits(r.x + k, r.y + r.h)) term.put(r.x + k, r.y + r.h, '▀', FAINT)
  }
}
