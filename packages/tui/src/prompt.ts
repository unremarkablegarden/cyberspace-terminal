// A modal that asks for one line and offers suggestions while typing.
//
// The same frame, centring and bounds handling as SelectPopup, but the list is
// produced by the caller from the text so far, making it a search box rather
// than a menu.
//
// The box does not resize as suggestions arrive. It is drawn at full height
// from the first frame with the rows below the input left blank, so the row
// under the cursor does not move while typing.
//
// Queries resolve out of order: a slow request for `jo` can arrive after a fast
// one for `jon`. Each request carries a sequence number and anything but the
// newest is discarded, which prevents the list reverting to a stale answer.

import { NORMAL, BRIGHT, BOLD, DIM } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, hline, label, shadow, type Rect, type Span } from './box.js'
import { InputLine } from './input.js'

export interface PromptOptions {
  title: string
  /**
   * Suggestions for the text so far. Called on a debounce rather than on every
   * keystroke. Returning [] is normal: a prefix too short to search, or one
   * that matches nothing.
   */
  suggest?: (value: string) => Promise<string[]>
  /**
   * The chosen line, or null if dismissed. A highlighted suggestion takes
   * precedence over the typed text; with none highlighted the typed text is the
   * answer, so a name absent from the index can still be entered.
   */
  onDone: (value: string | null) => void
  /** As SelectPopup: the widget produces no sound itself. */
  onFeedback?: (kind: 'move' | 'choose' | 'cancel' | 'edge' | 'inert', e: KeyInput) => void
  /** Drawn before the input, such as `@`. Not part of the answer. */
  prefix?: string
  /** Shown in the bottom rule. Spans, so a key can be drawn as a cap. */
  hint?: string | Span[]
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /**
   * Draw a drop shadow under the box. See shadow() in box.ts. Off by default,
   * because it overwrites the cells it falls on: that reads as depth over a
   * program still legible beneath, and as noise otherwise.
   */
  shadow?: boolean
  /** Suggestion rows. The box is always this tall, filled or not. */
  rows?: number
  /** Columns of text. The box is this wide regardless of what is in it. */
  width?: number
  maxLength?: number
  /** Characters before `suggest` is called at all. */
  minChars?: number
  /** Debounce interval before suggest() is called. */
  debounceMs?: number
}

const DEFAULTS = {
  rows: 6,
  width: 34,
  maxLength: 64,
  minChars: 2,
  debounceMs: 250,
}

export class PromptPopup implements Screen {
  private input: InputLine
  private items: string[] = []
  /** Index of the highlighted suggestion, or -1 to use the typed text. */
  private index = -1
  private timer: number | null = null
  /** Sequence number of the newest request. Older answers are discarded. */
  private seq = 0
  private closed = false

  constructor(private opts: PromptOptions) {
    this.input = new InputLine({
      prompt: opts.prefix ?? '',
      maxLength: opts.maxLength ?? DEFAULTS.maxLength,
    })
  }

  /** The arrows move the list, which the caller sounds as a move. */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
  }

  onKey(e: KeyInput): boolean {
    if (this.closed) return false

    if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      this.opts.onFeedback?.('cancel', e)
      this.finish(null)
      return true
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false

    if (e.key === 'Enter') {
      const picked = this.index >= 0 ? this.items[this.index] : this.input.value.trim()
      if (!picked) {
        this.opts.onFeedback?.('edge', e)
        return true
      }
      this.opts.onFeedback?.('choose', e)
      this.finish(picked)
      return true
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.items.length) {
        this.opts.onFeedback?.('edge', e)
        return true
      }
      // -1 is a position in the ring rather than a gap: moving off the top of
      // the list returns to the typed text, which is the only way to deselect a
      // suggestion without editing.
      const span = this.items.length + 1
      const from = this.index + 1
      const next = (from + (e.key === 'ArrowUp' ? -1 : 1) + span) % span
      this.index = next - 1
      this.opts.onFeedback?.('move', e)
      return true
    }

    // Tab completes to the highlighted suggestion without submitting, so it can
    // be seen and edited before Enter.
    if (e.key === 'Tab') {
      const picked = this.items[Math.max(0, this.index)]
      if (picked) {
        this.input.set(picked)
        this.index = -1
        this.schedule()
      } else {
        this.opts.onFeedback?.('inert', e)
      }
      return true
    }

    if (this.input.onKey(e)) {
      // Any edit clears the highlight, which indexed a list built for text that
      // no longer exists.
      this.index = -1
      this.schedule()
      return true
    }

    return false
  }

  onPaste(text: string): boolean {
    if (this.closed || !this.input.insert(text)) return false
    this.index = -1
    this.schedule()
    return true
  }

  /** Schedule another query, cancelled if a further keystroke arrives first. */
  private schedule() {
    if (!this.opts.suggest) return
    if (this.timer !== null) clearTimeout(this.timer)

    const value = this.input.value.trim()
    if (value.length < (this.opts.minChars ?? DEFAULTS.minChars)) {
      this.items = []
      this.seq++
      return
    }

    const mine = ++this.seq
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.opts.suggest!(value)
        .then((items) => {
          // A stale answer, or the box closed while the request was in flight.
          if (this.closed || mine !== this.seq) return
          this.items = items.slice(0, this.opts.rows ?? DEFAULTS.rows)
          this.index = -1
          this.redraw?.()
        })
        .catch(() => { /* no suggestions is a fine answer */ })
    }, this.opts.debounceMs ?? DEFAULTS.debounceMs)
  }

  /**
   * Set by the stack's draw so a late answer can repaint. The stack repaints
   * only on a handled key, and an arriving list is not one.
   */
  private redraw?: () => void

  private finish(value: string | null) {
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.opts.onDone(value)
  }

  dispose() {
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Fixed size, so nothing under the cursor moves as the list changes. */
  private rect(term: Grid): Rect {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const rows = this.opts.rows ?? DEFAULTS.rows
    const hint = this.opts.hint
    const hintW = !hint ? 0
      : typeof hint === 'string' ? cells(hint)
      : hint.reduce((n, s) => n + cells(s.text), 0)

    const w = Math.min(
      Math.max(16, b.w - 4),
      Math.max((this.opts.width ?? DEFAULTS.width) + 4, cells(this.opts.title) + 6, hintW + 6),
    )
    // Input row, a rule beneath it, and the suggestions. With no suggestions at
    // all the box is the input alone: a caller offering no completions would
    // otherwise get a divider with a blank row under it.
    const h = rows > 0 ? Math.min(Math.max(5, b.h - 2), rows + 4) : 3

    return {
      x: b.x + Math.floor((b.w - w) / 2),
      y: b.y + Math.floor((b.h - h) / 2),
      w,
      h,
    }
  }

  draw(term: Grid) {
    const r = this.rect(term)
    this.redraw = () => this.draw(term)

    // Cleared before framing, as TextPopup does: box drawing merges with the
    // existing cell, so a border over the program's own rule would merge into a
    // tee rather than covering it.
    clear(term, r)
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)
    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    if (this.opts.hint) label(term, r, this.opts.hint, { edge: 'bottom', align: 'right' })

    this.input.draw(term, { x: inner.x + 1, y: inner.y, w: inner.w - 2, h: 1 })
    // The only widget on this stack that takes input, so it shows the caret.
    // InputLine.draw has already positioned it; this only makes it visible. The
    // stack restores showCursor on pop.
    term.showCursor = true

    // Nothing to divide, so no divider. See rect(). A branch rather than an
    // early return, so ground() below runs in both cases; otherwise the
    // single-line form alone would render unlit.
    if ((this.opts.rows ?? DEFAULTS.rows) > 0) {
      // A rule between the typed text and the suggestions, so the two do not
      // read as one list. Run into both borders rather than stopping inside
      // them: hline merges with the existing cell, so the ends resolve to
      // junctions. NORMAL, matching the frame it joins; a dimmer rule would also
      // dim the two border cells it merges with.
      hline(term, inner.y + 1, r.x, r.x + r.w - 1, NORMAL)

      const top = inner.y + 2
      const rows = inner.h - 2
      for (let i = 0; i < rows; i++) {
        const item = this.items[i]
        if (item === undefined) break
        const on = i === this.index
        const text = ` ${item} `.padEnd(inner.w - 2).slice(0, inner.w - 2)
        // DIM inverse with BOLD text on the selected row, matching SelectPopup.
        // On an inverse cell the attribute applies to the background, so NORMAL
        // would make the selection the brightest element on screen.
        term.text(inner.x + 1, top + i, text, on ? DIM | BOLD : NORMAL, on ? 1 : 0)
      }
    }

    // Applied last, over everything the box drew. See ground() in box.ts.
    ground(term, r)
    term.dirty = true
  }
}
