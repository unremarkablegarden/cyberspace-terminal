// A centred modal that asks one question and takes one answer.
//
// The smallest member of the popup family — SelectPopup with the list taken
// away, which is the whole point: there is nothing to move through, so nothing
// to land on by accident. The answer is a letter, deliberately not Enter: a
// reader who has just pressed Escape or Ctrl-C is already on their way out, and
// a box that took the next keystroke as yes would not be asking anything.
//
// It is a Screen, so the grid underneath is snapshotted on push and handed back
// on pop — the program behind it neither knows nor redraws.

import { NORMAL, BRIGHT, BOLD } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, label, shadow, type Rect, type Span } from './box.js'

export interface ConfirmOptions {
  title: string
  /** The question. One entry per line — this does not reflow. */
  lines: string[]
  /**
   * The answer. Called once, and the caller pops — as everywhere else here,
   * because only the caller knows what to draw underneath afterwards.
   */
  onDone: (yes: boolean) => void
  /**
   * As SelectPopup: the widget makes no sound of its own. Both answers are
   * declared silent for the keyclick, so a caller that voices neither gets a
   * box that answers in silence.
   */
  onFeedback?: (kind: 'confirm' | 'cancel' | 'inert', e: KeyInput) => void
  /** Shown in the bottom rule. Plain text — a modal's hint is a caption. */
  hint?: string | Span[]
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /**
   * Lay a drop-shadow under the box — see `shadow` in box.ts. Off by default,
   * because it EATS the cells it falls on. The caller knows what is underneath.
   */
  shadow?: boolean
  /**
   * Light the box's own cells instead of leaving them black — see `ground` in
   * box.ts. On by default, as it is in every popup here.
   *
   * The escape hatch exists for a box over a photograph, where a lit field
   * behind the text and an unlit picture beside it read as two screens; nothing
   * passes false today.
   */
  panel?: boolean
}

/**
 * The two answers, as a hint.
 *
 * Shared rather than written out at each call site: a box that asks Y or N is
 * asking the same question wherever it is, and four copies of this is four
 * chances for one of them to say it differently.
 */
export const YES_NO: Span[] = [{ text: 'Y/N' }]

const MIN_W = 18
/**
 * Blank columns either side of the longest line.
 *
 * Wider than SelectPopup's 2, and the difference is what the two boxes are.
 * A list is a column of rows you move a bar through, so its padding is the
 * margin the bar starts at and more of it is wasted width. This box holds one
 * sentence and asks you to stop and read it — the space around it is what says
 * so, and at 2 the words sat against the frame like a row of a list that had
 * lost its neighbours.
 */
const PAD = 4

/**
 * Blank ROWS above and below the question. There were none.
 *
 * The height was `lines.length + 2`, which is the two border rows and nothing
 * else — so `Quit cIRC?` was drawn hard against the title rule above it and the
 * `Y/N` rule below it, in a box three rows tall. A question wedged between two
 * labelled rules reads as a third label rather than as the thing being asked.
 */
const PAD_Y = 1

export class ConfirmPopup implements Screen {
  private answered = false

  constructor(private opts: ConfirmOptions) {}

  /**
   * Both answers close the box, which is an event the caller voices — the
   * keyclick on top of that is two sounds for one keypress. Everything else is
   * not an answer and keeps its click, which is what says the key was heard and
   * was not one of the two.
   */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false
    if (e.ctrlKey) return e.key === 'c' || e.key === 'C'
    return e.key === 'Escape' || 'ynYN'.includes(e.key)
  }

  onKey(e: KeyInput): boolean {
    if (this.answered) return false
    if (e.metaKey || e.altKey) return false

    // Escape and Ctrl-C are no, as they are in every other box here. Worth
    // saying out loud for a quit dialog, where Ctrl-C is also what opened it:
    // the second one cancels rather than confirming, because a key that means
    // "get me out of this" cannot also mean "yes, do the thing".
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

    // Anything else is not an answer. Consumed rather than passed on — a key
    // that fell through would act on a screen the reader cannot see, and an
    // unconsumed arrow scrolls the page under the modal.
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
    // Never taller than the region it was given, and never shorter than a frame
    // with one row in it — the clamp is what keeps a long question inside a
    // short pane rather than growing past the bottom of it.
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

    // Blank the whole box, borders included, BEFORE framing it: box drawing
    // merges line bits with what is already in the cell, so a border laid over
    // the program's own rule underneath would fuse with it into a tee rather
    // than covering it. Same note as text.ts.
    clear(term, r)
    // The shadow stays OUTSIDE the box, so `ground` below never reaches it —
    // which is what keeps the two readable together. It is drawn at FAINT
    // (100), three times the panel's level, so a lit box still casts a darker
    // edge rather than dissolving into it.
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)

    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    if (this.opts.hint) label(term, r, this.opts.hint, { edge: 'bottom', align: 'right' })

    // **Padding yields to the words when the box is clamped.** `rect` asks for
    // `widest + PAD * 2`, and gets it on any screen with the room — but a 44
    // column phone clamps the width to the pane, and spending four columns a
    // side there would cut six characters off every line of a sentence that
    // already only just fits. So the pad is whatever is actually spare, down to
    // one: a narrow box loses its margins before it loses its text.
    const widest = this.opts.lines.reduce((n, s) => Math.max(n, cells(s)), 0)
    const pad = Math.max(1, Math.min(PAD, Math.floor((inner.w - widest) / 2)))
    // Same trade vertically. Two blank rows are worth having and are worth less
    // than the last line of the question, so a box clamped shorter than its
    // content gives them up first.
    const padY = this.opts.lines.length + PAD_Y * 2 <= inner.h ? PAD_Y : 0

    for (let i = 0; i < Math.max(0, inner.h - padY); i++) {
      const line = this.opts.lines[i]
      if (line === undefined) break
      term.text(
        inner.x + pad, inner.y + padY + i,
        line.slice(0, Math.max(0, inner.w - pad * 2)), NORMAL,
      )
    }

    // Last, over everything the box just drew. See `ground`.
    if (this.opts.panel !== false) ground(term, r)

    // Nothing to type into, so no caret — the stamp would invert a cell of the
    // frame and read as a blinking corner. The stack restores this on pop.
    term.showCursor = false
    term.dirty = true
  }
}
