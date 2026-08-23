// A centred modal page of text — read it, dismiss it.
//
// SelectPopup's sibling: same frame, same centring, same rule about only using
// the `bounds` it was given. What it does not have is a selection, because
// there is nothing here to choose. Anything taller than the box scrolls.
//
// It is a Screen, so the grid underneath is snapshotted on push and handed back
// on pop — the program behind it neither knows nor redraws.

import { NORMAL, BRIGHT, BOLD, DIM } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, hline, label, shadow, type Rect, type Span } from './box.js'

/**
 * A label's worth of content: plain text, or spans when parts of it carry their
 * own treatment — a keycap, a badge on a DIM inverse field. The same Span the
 * rules use, so a program styles a line in a box the way it styles a label in a
 * rule.
 */
export type TextLabel = string | Span[]

/**
 * One display row: a label's worth of content, or a rule across the box.
 *
 * RULE is a marker rather than a string of dashes because only the widget knows
 * how wide the box ended up — a caller that drew its own would either fall
 * short of both edges or set the width of the box by being the longest line in
 * it.
 */
export type TextLine = TextLabel | typeof RULE

/** A horizontal divider, drawn edge to edge and joined into both borders. */
export const RULE = { rule: true } as const

export interface TextOptions {
  title: string
  /**
   * Set into the TOP rule at the right, opposite the title.
   *
   * For what a thing IS rather than what it says — a badge, a count, a state.
   * On the rule because the rule is where this widget keeps everything that is
   * about the box rather than in it, and because a row of the body spent on
   * two words is a row of the text it was opened to read.
   */
  note?: TextLabel
  /** One entry per display line. Already wrapped — this does not reflow. */
  lines: TextLine[]
  /** Called when the reader dismisses it. The caller pops. */
  onDone: () => void
  /** As SelectPopup: the widget makes no sound of its own. */
  onFeedback?: (kind: 'move' | 'close' | 'edge' | 'inert', e: KeyInput) => void
  /**
   * One extra key the box answers, matched case-insensitively and only as a
   * bare letter — a modifier combo belongs to the browser.
   *
   * The box stays open: an action here is something you do TO what is on
   * screen, not a way off it, and the caller owns whatever it sounds like.
   * Advertise it in `hint` — the widget will not do that for you, because only
   * the caller knows what to call it.
   */
  /**
   * One extra key the box answers itself — the bio's `L`, which copies. `silent`
   * says the caller makes a sound of its own for it, so the keyclick would be a
   * second sound for one keypress.
   */
  action?: { key: string; run: () => void; silent?: boolean }
  /** Shown in the bottom rule. */
  hint?: TextLabel
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /**
   * Lay a drop-shadow under the box, one row down and one column right — the
   * same offset the boot banner and the site's own DOS modals use.
   *
   * Off by default. It costs nothing to draw, but it EATS the cells it falls
   * on: over a program that is still readable underneath, a shadow is the thing
   * saying this box is on top of it, and over a program that is not it is just
   * a smudge. The caller knows which it has.
   */
  shadow?: boolean
}

const MIN_W = 18
/** Blank columns either side of the longest line. */
const PAD = 2


/**
 * Cells a line occupies, whichever kind it is. A rule is zero: it takes the
 * width the box turns out to have rather than asking for one.
 */
const width = (line: TextLine): number => {
  if (typeof line === 'string') return cells(line)
  if (Array.isArray(line)) return line.reduce((n, s) => n + cells(s.text), 0)
  return 0
}

export class TextPopup implements Screen {
  /** First visible line. Non-zero only when the text is taller than the box. */
  private top = 0
  /** A result standing in for the hint until the next keypress. See say(). */
  private message?: TextLabel
  /**
   * The grid this box was last drawn on, so `say` can repaint without being
   * handed one. There is only ever the one, and a modal that cannot show the
   * result of its own action would make the caller draw over it from outside.
   */
  private term?: Grid

  constructor(private opts: TextOptions) {}

  /**
   * Report the result of an `action` in the bottom rule, in place of the hint.
   *
   * Because the box is the only thing the reader can see: the program
   * underneath is covered, and its own status rule — even where the box does
   * not reach — was snapshotted when this went up and will not be repainted
   * until it comes down. The next keypress puts the hint back.
   */
  say(text: TextLabel) {
    this.message = text
    if (!this.term) return
    this.draw(this.term)
    this.term.dirty = true
  }

  /**
   * Forget the grid, so a `say` still in flight cannot paint a box that is no
   * longer on the stack.
   *
   * The one caller of `say` is asynchronous — `feed`'s bio box reports a
   * clipboard write from a `.then` — and Escape does not wait for it. Without
   * this, an answer landing after the pop repaints a dead box over whatever is
   * underneath AND turns the caret off with `draw`'s last line, which is how
   * the shell ends up at a prompt with no cursor: nothing below the stack ever
   * turns it back on. The same guard TunePopup and SettingsScreen keep, and the
   * same one PromptPopup keeps with its `closed` flag.
   */
  dispose() {
    this.term = undefined
  }

  /** As SelectPopup: the scroll keys answer themselves, so no keyclick. */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    const action = this.opts.action
    if (action?.silent && e.key.toLowerCase() === action.key.toLowerCase()) return true
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false
    // Any key the box answers puts the hint back — a result is about the key
    // that caused it and stops being true the moment there is another one. The
    // stack repaints after a consumed key, so this needs no draw of its own;
    // an action that reports again does so through say() below.
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

    // Swallowed rather than passed on: unconsumed arrows scroll the page under
    // the modal, which is the classic way a TUI in a browser leaks.
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
   * How far down the text can be pushed. Recomputed rather than stored: it
   * depends on the box height, which depends on the grid.
   */
  private maxTop = 0

  /** Centred within `bounds`, sized to its contents, clamped to fit. */
  private rect(term: Grid): Rect {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const widest = this.opts.lines.reduce((n, line) => Math.max(n, width(line)), 0)

    // A title and a note share the top rule, so that row wants room for both
    // plus the blank each label sits in — otherwise they meet in the middle.
    const top = cells(this.opts.title)
      + (this.opts.note ? width(this.opts.note) + 2 : 0)

    const w = Math.min(
      Math.max(MIN_W, b.w - 4),
      Math.max(
        MIN_W,
        widest + PAD * 2 + 2,
        top + 6,
        // Both, and the wider of them: a message longer than the hint would
        // otherwise be laid out from an edge the box does not have, and a
        // right-aligned label that does not fit starts before its own frame.
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

    // Blank the whole box, borders included, BEFORE framing it. Box drawing
    // merges line bits with whatever is already in the cell — which is what
    // makes junctions resolve themselves, and is exactly wrong for a modal: a
    // border crossing the program's own rule underneath would fuse with it
    // into a tee instead of covering it. Clearing first means the frame is
    // drawn onto nothing and has nothing to fuse with.
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
        // RULE. Run it into both borders: hline merges line bits with what is
        // already in the cell, so the ends resolve to tees rather than sitting
        // a column short of an edge they were clearly meant to reach.
        //
        // At the frame's own beam, not below it. A divider IS the frame — the
        // same rule, continued inwards — and hline writes its attribute into
        // the two border cells it merges with, so a dimmer one would take the
        // tees down with it and leave two faint notches in the border.
        hline(term, y, inner.x - 1, inner.x + inner.w, NORMAL)
        continue
      }
      // Spans run left to right from the same margin, each cut at the edge of
      // the box — a row that overruns loses its tail rather than wrapping into
      // the next line, which is not this widget's business to invent.
      let x = inner.x + PAD
      const end = inner.x + inner.w
      for (const span of line) {
        if (x >= end) break
        const text = [...span.text].slice(0, end - x).join('')
        term.text(x, y, text, span.attr ?? NORMAL, span.inverse ? 1 : 0)
        x += cells(text)
      }
    }

    // Last, over everything the box just drew. See `ground` in box.ts. Picture
    // cells are skipped there, which matters here more than anywhere: this is
    // the widget a halftone lands in.
    ground(term, r)

    // Nothing to type into, so no caret — the stamp would invert a cell of the
    // frame and read as a blinking corner. The stack restores this on pop.
    term.showCursor = false
    term.dirty = true
  }
}
