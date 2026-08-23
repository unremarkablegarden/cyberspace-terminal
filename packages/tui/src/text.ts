// A centred modal page of read-only text.
//
// The same frame, centring and bounds handling as SelectPopup, without a
// selection. Content taller than the box scrolls.
//
// A Screen, so the grid beneath is snapshotted on push and restored on pop; the
// program behind it is not notified and does not redraw.

import { NORMAL, BRIGHT, BOLD, DIM } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, hline, label, shadow, type Rect, type Span } from './box.js'

/**
 * One line's content: plain text, or spans when parts carry their own
 * attributes, such as a keycap or a badge. The same Span type the rules use, so
 * a line in a box is styled the same way as a label in a rule.
 */
export type TextLabel = string | Span[]

/**
 * One display row: line content, or a rule across the box.
 *
 * RULE is a marker rather than a string of dashes, because only the widget
 * knows the final box width. A caller supplying its own would either fall short
 * of both edges or become the longest line and set the width.
 */
export type TextLine = TextLabel | typeof RULE

/** A horizontal divider, drawn edge to edge and joined into both borders. */
export const RULE = { rule: true } as const

export interface TextOptions {
  title: string
  /**
   * Set into the top rule at the right, opposite the title.
   *
   * For a badge, a count or a state: metadata about the box rather than part of
   * its content, and it costs no row of the body.
   */
  note?: TextLabel
  /** One entry per display line. Already wrapped; this does not reflow. */
  lines: TextLine[]
  /** Called when the reader dismisses it. The caller pops. */
  onDone: () => void
  /** As SelectPopup: the widget produces no sound itself. */
  onFeedback?: (kind: 'move' | 'close' | 'edge' | 'inert', e: KeyInput) => void
  /**
   * One extra key the box handles, matched case-insensitively and only as a
   * bare letter; modifier combinations are left to the browser.
   *
   * The box stays open, since an action operates on what is displayed rather
   * than dismissing it, and the caller supplies any sound. Advertise it in
   * `hint`: the widget cannot, since only the caller knows its label.
   */
  /**
   * One extra key the box handles itself, such as the bio box's L, which copies.
   * `silent` marks keys the caller sounds itself, so the key click is suppressed.
   */
  action?: { key: string; run: () => void; silent?: boolean }
  /** Shown in the bottom rule. */
  hint?: TextLabel
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /**
   * Draw a drop shadow under the box, one row down and one column right, the
   * same offset the boot banner and the website's DOS modals use.
   *
   * Off by default. The shadow overwrites the cells it falls on, which reads as
   * depth over a program still legible beneath and as noise otherwise. Only the
   * caller knows which case applies.
   */
  shadow?: boolean
}

const MIN_W = 18
/** Blank columns either side of the longest line. */
const PAD = 2


/**
 * Cells a line occupies, for either kind. A rule counts zero, since it adopts
 * the box's final width rather than requesting one.
 */
const width = (line: TextLine): number => {
  if (typeof line === 'string') return cells(line)
  if (Array.isArray(line)) return line.reduce((n, s) => n + cells(s.text), 0)
  return 0
}

export class TextPopup implements Screen {
  /** First visible line. Non-zero only when the text is taller than the box. */
  private top = 0
  /** A result shown in place of the hint until the next keypress. See say(). */
  private message?: TextLabel
  /**
   * The grid this box was last drawn on, so say() can repaint without being
   * passed one. Without it, a caller would have to draw the result over the
   * modal from outside.
   */
  private term?: Grid

  constructor(private opts: TextOptions) {}

  /**
   * Report the result of an action in the bottom rule, replacing the hint.
   *
   * The program beneath is covered, and its own status rule was snapshotted on
   * push and will not repaint until this box is popped, so the result has
   * nowhere else to go. The next keypress restores the hint.
   */
  say(text: TextLabel) {
    this.message = text
    if (!this.term) return
    this.draw(this.term)
    this.term.dirty = true
  }

  /**
   * Drop the grid reference, so a pending say() cannot paint a box that has been
   * popped.
   *
   * say()'s only caller is asynchronous: feed's bio box reports a clipboard
   * write from a .then, and Escape does not wait for it. Without this, a result
   * arriving after the pop repaints a dead box over whatever is beneath and
   * clears the caret in draw()'s last line, leaving the shell at a prompt with
   * no cursor, since nothing below the stack turns it back on. TunePopup and
   * SettingsScreen keep the same guard, as does PromptPopup with its `closed`
   * flag.
   */
  dispose() {
    this.term = undefined
  }

  /** As SelectPopup: the scroll keys sound themselves, so the key click is suppressed. */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    const action = this.opts.action
    if (action?.silent && e.key.toLowerCase() === action.key.toLowerCase()) return true
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false
    // Any handled key restores the hint, since a result describes the keypress
    // that produced it. The stack repaints after a consumed key, so no draw is
    // needed here; an action reporting again does so through say().
    this.message = undefined

    if (e.key === 'Escape' || e.key === 'Enter'
        || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      this.opts.onFeedback?.('close', e)
      this.opts.onDone()
      return true
    }

    if (e.ctrlKey) return false

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const before = this.top
      this.top = Math.max(0, Math.min(this.top + (e.key === 'ArrowUp' ? -1 : 1), this.maxTop))
      this.opts.onFeedback?.(this.top === before ? 'edge' : 'move', e)
      return true
    }

    // Swallowed rather than passed on: an unconsumed arrow scrolls the host
    // page beneath the modal.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.opts.onFeedback?.('inert', e)
      return true
    }

    const action = this.opts.action
    if (action && e.key.toLowerCase() === action.key.toLowerCase()) {
      action.run()
      return true
    }

    return false
  }

  /**
   * Maximum scroll offset. Recomputed rather than stored, since it depends on
   * the box height, which depends on the grid.
   */
  private maxTop = 0

  /** Centred within `bounds`, sized to its contents, clamped to fit. */
  private rect(term: Grid): Rect {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const widest = this.opts.lines.reduce((n, line) => Math.max(n, width(line)), 0)

    // The title and note share the top rule, so it needs room for both plus the
    // blank each label sits in, or they meet in the middle.
    const top = cells(this.opts.title)
      + (this.opts.note ? width(this.opts.note) + 2 : 0)

    const w = Math.min(
      Math.max(MIN_W, b.w - 4),
      Math.max(
        MIN_W,
        widest + PAD * 2 + 2,
        top + 6,
        // The wider of the two: a message longer than the hint would otherwise
        // be laid out from an edge the box does not have, and a right-aligned
        // label that does not fit would start before its own frame.
        Math.max(
          this.opts.hint ? width(this.opts.hint) : 0,
          this.message ? width(this.message) : 0,
        ) + 6,
      )
    )
    const h = Math.min(Math.max(3, b.h - 2), this.opts.lines.length + 2)

    return {
      x: b.x + Math.floor((b.w - w) / 2),
      y: b.y + Math.floor((b.h - h) / 2),
      w,
      h,
    }
  }

  draw(term: Grid) {
    this.term = term
    const r = this.rect(term)

    // Clear the whole box, borders included, before framing it. Box drawing
    // merges line bits with the existing cell, which resolves junctions but is
    // wrong for a modal: a border crossing the program's own rule beneath would
    // merge into a tee rather than covering it. Clearing first leaves nothing
    // to merge with.
    clear(term, r)
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)

    this.maxTop = Math.max(0, this.opts.lines.length - inner.h)
    if (this.top > this.maxTop) this.top = this.maxTop

    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    if (this.opts.note) label(term, r, this.opts.note, { align: 'right' })
    const foot = this.message ?? this.opts.hint
    if (foot) label(term, r, foot, { edge: 'bottom', align: 'right' })

    for (let i = 0; i < inner.h; i++) {
      const line = this.opts.lines[this.top + i]
      if (line === undefined) break
      const y = inner.y + i
      if (typeof line === 'string') {
        term.text(inner.x + PAD, y, line.slice(0, inner.w - PAD), NORMAL)
        continue
      }
      if (!Array.isArray(line)) {
        // A rule, run into both borders: hline merges line bits with the
        // existing cell, so the ends resolve to tees rather than stopping a
        // column short.
        //
        // Drawn at the frame's own beam level. hline writes its attribute into
        // the two border cells it merges with, so a dimmer divider would dim
        // those tees and leave two notches in the border.
        hline(term, y, inner.x - 1, inner.x + inner.w, NORMAL)
        continue
      }
      // Spans run left to right from the same margin, each cut at the box edge.
      // An over-long row loses its tail rather than wrapping, which this widget
      // does not do.
      let x = inner.x + PAD
      const end = inner.x + inner.w
      for (const span of line) {
        if (x >= end) break
        const text = [...span.text].slice(0, end - x).join('')
        term.text(x, y, text, span.attr ?? NORMAL, span.inverse ? 1 : 0)
        x += cells(text)
      }
    }

    // Applied last, over everything the box drew. See ground() in box.ts, which
    // skips picture cells; this is the widget images are drawn into.
    ground(term, r)

    // Nothing here takes input, so the caret is hidden; it would otherwise
    // invert a cell of the frame. The stack restores it on pop.
    term.showCursor = false
    term.dirty = true
  }
}
