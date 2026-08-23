// A modal that asks for one line, and offers suggestions while you type.
//
// SelectPopup's other sibling: same frame, same centring, same rule about only
// using the `bounds` it was given. What it adds is that the list is not fixed —
// it comes from whatever the caller does with the text so far, which is what
// makes it a search box rather than a menu.
//
// The box does NOT resize as suggestions arrive. It is drawn at its full height
// from the first frame with the rows below the input left blank, because a modal
// that grows and shrinks under a typing cursor is a modal that moves the thing
// you were about to press Enter on.
//
// Answers are per keystroke and out of order by nature: a slow query for `jo`
// can land after a fast one for `jon`. Every request carries a sequence number
// and anything but the newest is dropped on arrival — without that the list
// flickers back to a stale answer for a prefix you have already typed past.

import { NORMAL, BRIGHT, BOLD, DIM } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, hline, label, shadow, type Rect, type Span } from './box.js'
import { InputLine } from './input.js'

export interface PromptOptions {
  title: string
  /**
   * Suggestions for the text so far. Called on a debounce, never on every
   * keystroke. Returning `[]` is normal — a prefix too short to search, or one
   * nothing matches.
   */
  suggest?: (value: string) => Promise<string[]>
  /**
   * The chosen line, or null if dismissed. A highlighted suggestion wins over
   * what was typed; with none highlighted the typed text is the answer, so a
   * name the index has not heard of can still be asked for.
   */
  onDone: (value: string | null) => void
  /** As SelectPopup: the widget makes no sound of its own. */
  onFeedback?: (kind: 'move' | 'choose' | 'cancel' | 'edge' | 'inert', e: KeyInput) => void
  /** Drawn in front of the input, e.g. `@`. Not part of the answer. */
  prefix?: string
  /** Shown in the bottom rule. Spans so a key can wear its cap, as the footer does. */
  hint?: string | Span[]
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /**
   * Lay a drop-shadow under the box — see `shadow` in box.ts. Off by default,
   * because it EATS the cells it falls on: over a program still readable
   * underneath it is what says this box is in front, and over one that is not
   * it is a smudge. The caller knows which it has.
   */
  shadow?: boolean
  /** Suggestion rows. The box is always this tall, filled or not. */
  rows?: number
  /** Columns of text. The box is this wide regardless of what is in it. */
  width?: number
  maxLength?: number
  /** Characters before `suggest` is called at all. */
  minChars?: number
  /** Quiet time before asking. */
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
  /** Which suggestion is highlighted, or -1 for "none — use what I typed". */
  private index = -1
  private timer: number | null = null
  /** Newest request. Answers that are not this are stale, and dropped. */
  private seq = 0
  private closed = false

  constructor(private opts: PromptOptions) {
    this.input = new InputLine({
      prompt: opts.prefix ?? '',
      maxLength: opts.maxLength ?? DEFAULTS.maxLength,
    })
  }

  /** The arrows move the list, which is a move the caller ticks for. */
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
      // -1 is a real position in the ring, not a gap in it: walking off the top
      // of the list puts you back in the text you typed, which is the only way
      // to un-choose a suggestion without deleting a character.
      const span = this.items.length + 1
      const from = this.index + 1
      const next = (from + (e.key === 'ArrowUp' ? -1 : 1) + span) % span
      this.index = next - 1
      this.opts.onFeedback?.('move', e)
      return true
    }

    // Tab completes to the highlighted suggestion without committing to it, so
    // you can see what you are about to ask for and keep editing.
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
      // Any edit invalidates the highlight: it pointed into a list built for
      // text that no longer exists.
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

  /** Ask again shortly, unless another keystroke moves the goalposts first. */
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
          // Stale answer, or the box closed while it was in flight.
          if (this.closed || mine !== this.seq) return
          this.items = items.slice(0, this.opts.rows ?? DEFAULTS.rows)
          this.index = -1
          this.redraw?.()
        })
        .catch(() => { /* no suggestions is a fine answer */ })
    }, this.opts.debounceMs ?? DEFAULTS.debounceMs)
  }

  /**
   * Set by the stack's draw so a late answer can repaint itself. The stack only
   * repaints on a handled key, and an arriving list is neither.
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
    // Input row, a rule under it, and the suggestions — unless there are no
    // suggestions at all, in which case the box is the input and nothing else.
    // A caller that offers no completions (a reason, a note) would otherwise
    // get a divider dividing one thing from nothing, and a blank row under it.
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

    // Cleared before framing, as TextPopup: box drawing merges with whatever is
    // in the cell, so a border over the program's own rule would fuse into a
    // tee instead of covering it.
    clear(term, r)
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)
    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    if (this.opts.hint) label(term, r, this.opts.hint, { edge: 'bottom', align: 'right' })

    this.input.draw(term, { x: inner.x + 1, y: inner.y, w: inner.w - 2, h: 1 })
    // The one widget on this stack that IS typed into, so it is the one that
    // wants the caret. InputLine.draw has already parked it; this only says the
    // machine is listening. The stack puts showCursor back on the way out.
    term.showCursor = true

    // Nothing to divide from, so no divider. See `rect`. A branch rather than
    // the early return this used to be, so the ground below is reached either
    // way — a popup that came out unlit in only its one-line form would be a
    // fiddly thing to notice and a fiddlier one to explain.
    if ((this.opts.rows ?? DEFAULTS.rows) > 0) {
      // A rule between what you typed and what the machine is offering, so the
      // two are never mistaken for one list. Run into both borders rather than
      // stopped inside them: hline merges with what is already in the cell, so
      // the ends resolve to ├ and ┤ instead of butting against the sides.
      // NORMAL, like the frame it joins — a dimmer rule reads as a different
      // material, and it also dims the two border cells it lands on.
      hline(term, inner.y + 1, r.x, r.x + r.w - 1, NORMAL)

      const top = inner.y + 2
      const rows = inner.h - 2
      for (let i = 0; i < rows; i++) {
        const item = this.items[i]
        if (item === undefined) break
        const on = i === this.index
        const text = ` ${item} `.padEnd(inner.w - 2).slice(0, inner.w - 2)
        // DIM inverse with BOLD text on the selected row — the same bar
        // `SelectPopup` draws, and drawn here for the same reason. On an
        // inverse cell the attr is the FIELD, so NORMAL made the selection a
        // slab of lit phosphor with the words cut out of it: the brightest
        // thing on the tube, for a row whose job is only to say where you are.
        // Taking the field down and thickening the letters says it without
        // shouting. This one was left behind when select.ts was changed.
        term.text(inner.x + 1, top + i, text, on ? DIM | BOLD : NORMAL, on ? 1 : 0)
      }
    }

    // Last, over everything the box just drew. See `ground` in box.ts.
    ground(term, r)
    term.dirty = true
  }
}
