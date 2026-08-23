// A centred modal that asks one question and takes one answer.
//
// SelectPopup without the list, so there is nothing to move through and nothing
// to select by accident. The answer is a letter rather than Enter, because a
// reader who has just pressed Escape or Ctrl-C is already leaving and a box
// that read the next keystroke as yes would not be asking anything.
//
// A Screen, so the grid beneath is snapshotted on push and restored on pop; the
// program behind is not notified and does not redraw.

import { NORMAL, BRIGHT, BOLD } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, label, shadow, type Rect, type Span } from './box.js'

export interface ConfirmOptions {
  title: string
  /** The question, one entry per line. This does not reflow. */
  lines: string[]
  /** The answer. Called once; the caller pops, since only it knows what to draw next. */
  onDone: (yes: boolean) => void
  /**
   * As SelectPopup: the widget produces no sound itself. Both answers suppress
   * the key click, so a caller that plays no sound for either gets a silent box.
   */
  onFeedback?: (kind: 'confirm' | 'cancel' | 'inert', e: KeyInput) => void
  /** Shown in the bottom rule, as plain text. */
  hint?: string | Span[]
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /**
   * Draw a drop shadow under the box. See shadow() in box.ts. Off by default,
   * because it overwrites the cells it falls on.
   */
  shadow?: boolean
  /**
   * Light the box's cells rather than leaving them black. See ground() in
   * box.ts. On by default, as in every popup here.
   *
   * Can be disabled for a box over an image, where a lit background beside an
   * unlit picture reads as two separate screens. Nothing passes false today.
   */
  panel?: boolean
}

/** The two answers, as a hint. Shared so every call site words it identically. */
export const YES_NO: Span[] = [{ text: 'Y/N' }]

const MIN_W = 18
/**
 * Blank columns either side of the longest line.
 *
 * Wider than SelectPopup's 2. In a list the padding is the margin the selection
 * bar starts at, and extra is wasted width. This box holds one sentence, where
 * the surrounding space separates it from the frame; at 2 the text sat against
 * the border.
 */
const PAD = 4

/**
 * Blank rows above and below the question.
 *
 * Previously zero: the height was lines.length + 2, the two border rows only,
 * so a one-line question sat directly against the title rule above and the Y/N
 * rule below, in a box three rows tall, and read as a third label.
 */
const PAD_Y = 1

export class ConfirmPopup implements Screen {
  private answered = false

  constructor(private opts: ConfirmOptions) {}

  /**
   * Both answers close the box, which the caller sounds, so the key click would
   * be a second sound. Every other key keeps its click, indicating it was
   * received but was not an answer.
   */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false
    if (e.ctrlKey) return e.key === 'c' || e.key === 'C'
    return e.key === 'Escape' || 'ynYN'.includes(e.key)
  }

  onKey(e: KeyInput): boolean {
    if (this.answered) return false
    if (e.metaKey || e.altKey) return false

    // Escape and Ctrl-C answer no, as in every other box here. This matters for
    // a quit dialog, where Ctrl-C also opened the box: the second press cancels
    // rather than confirming.
    if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      this.finish(false, e)
      return true
    }
    if (e.ctrlKey) return false

    if (e.key === 'y' || e.key === 'Y') {
      this.finish(true, e)
      return true
    }
    if (e.key === 'n' || e.key === 'N') {
      this.finish(false, e)
      return true
    }

    // Anything else is not an answer. Consumed rather than passed on: a key
    // falling through would act on the hidden screen beneath, and an unconsumed
    // arrow scrolls the host page.
    this.opts.onFeedback?.('inert', e)
    return true
  }

  private finish(yes: boolean, e: KeyInput) {
    this.answered = true
    this.opts.onFeedback?.(yes ? 'confirm' : 'cancel', e)
    this.opts.onDone(yes)
  }

  /** Centred within `bounds`, sized to its contents, clamped to fit. */
  private rect(term: Grid): Rect {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const widest = this.opts.lines.reduce((n, s) => Math.max(n, cells(s)), 0)
    const hint = this.opts.hint
    const hintW = !hint ? 0
      : typeof hint === 'string' ? cells(hint)
      : hint.reduce((n, s) => n + cells(s.text), 0)

    const w = Math.min(
      Math.max(MIN_W, b.w - 4),
      Math.max(MIN_W, widest + PAD * 2 + 2, cells(this.opts.title) + 6, hintW + 6),
    )
    // Never taller than the given region and never shorter than a frame with one
    // row, so a long question stays inside a short pane.
    const h = Math.min(Math.max(3, b.h - 2), this.opts.lines.length + 2 + PAD_Y * 2)

    return {
      x: b.x + Math.floor((b.w - w) / 2),
      y: b.y + Math.floor((b.h - h) / 2),
      w,
      h,
    }
  }

  draw(term: Grid) {
    const r = this.rect(term)

    // Clear the whole box, borders included, before framing it: box drawing
    // merges line bits with the existing cell, so a border over the program's
    // own rule would merge into a tee rather than covering it. Same note as
    // text.ts.
    clear(term, r)
    // The shadow falls outside the box, so ground() below never reaches it. It
    // is drawn at FAINT (100), three times the panel's level, so a lit box still
    // casts a darker edge rather than merging into it.
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)

    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    if (this.opts.hint) label(term, r, this.opts.hint, { edge: 'bottom', align: 'right' })

    // Padding gives way to the text when the box is clamped. rect() requests
    // widest + PAD * 2 and gets it where there is room, but at 44 columns the
    // width is clamped to the pane and four columns a side would remove six
    // characters from every line. The pad is therefore whatever is spare, down
    // to one, so a narrow box loses its margins before its text.
    const widest = this.opts.lines.reduce((n, s) => Math.max(n, cells(s)), 0)
    const pad = Math.max(1, Math.min(PAD, Math.floor((inner.w - widest) / 2)))
    // The same vertically: a box clamped shorter than its content drops the
    // blank rows before dropping a line of the question.
    const padY = this.opts.lines.length + PAD_Y * 2 <= inner.h ? PAD_Y : 0

    for (let i = 0; i < Math.max(0, inner.h - padY); i++) {
      const line = this.opts.lines[i]
      if (line === undefined) break
      term.text(
        inner.x + pad, inner.y + padY + i,
        line.slice(0, Math.max(0, inner.w - pad * 2)), NORMAL,
      )
    }

    // Applied last, over everything the box drew. See ground().
    if (this.opts.panel !== false) ground(term, r)

    // Nothing here takes input, so the caret is hidden; it would otherwise
    // invert a cell of the frame. The stack restores it on pop.
    term.showCursor = false
    term.dirty = true
  }
}
