// A centred modal list: choose one item, or dismiss.
//
// A Screen, so pushing it snapshots the grid beneath and restores it on pop.
// The program behind is not notified and does not redraw.
//
// Selection uses the grid's inverse-video plane rather than a marker character.
// term.ts has carried the inverse array from the start, so this costs nothing.

import { NORMAL, BRIGHT, DIM, BOLD } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, label, shadow, type Rect, type Span } from './box.js'

export interface SelectOptions {
  title: string
  items: string[]
  /** Index to open on. Clamped. */
  selected?: number
  /** Chosen item, or null if dismissed. The caller pops the screen. */
  onDone: (item: string | null, index: number) => void
  /**
   * Sounds the widget requests; it produces none itself. Not the key click,
   * which the host already plays for every key, so a second would double it.
   * `edge` is reported because only the widget knows a movement was refused.
   */
  onFeedback?: (
    kind: 'move' | 'choose' | 'cancel' | 'edge' | 'inert',
    e: KeyInput
  ) => void
  /**
   * The caller plays its own sound for Enter, so the key click is suppressed.
   *
   * Opt-in rather than assumed, because choosing does not always act: circ's
   * room switcher is silent when the current room is chosen, where suppressing
   * the click would make the key appear unresponsive.
   */
  silentChoose?: boolean
  /**
   * One bare key per row that selects it directly, parallel to `items`.
   *
   * For a list short enough to number, where arrows are slower. Matched
   * case-insensitively and only without modifiers, so it cannot take a
   * combination the popup passes to the browser. A shorter array leaves the
   * remaining rows arrow-only.
   */
  keys?: string[]
  /** Shown in the bottom rule. Spans, so a key can be drawn as a cap. */
  hint?: string | Span[]
  /**
   * Region to centre within. Defaults to the whole grid. A program with its own
   * chrome, such as a chat screen with an input line, passes the area it is
   * willing to have covered.
   */
  bounds?: Rect
  /**
   * Rows to remove from the top after sizing, leaving the bottom edge where
   * centring placed it, so the box is shorter and sits lower. `bounds` cannot
   * do this: the height comes from the item count rather than the region, so a
   * smaller region moves the box without resizing it.
   */
  trimTop?: number
  /**
   * Re-attribute part of a row after it has been drawn.
   *
   * A row is drawn as one padded string at one attribute, which suits a list of
   * names but not a row carrying a second column such as a count or a marker
   * that should read less prominently. cmail's index uses this for its unread
   * mark and clock.
   *
   * `row` is where the item was drawn, one cell high, with PAD already removed,
   * so its column 0 is character 0 of the caller's string. `selected` is the
   * row's inversion, which anything drawn over an inverted row must also carry
   * or it leaves a gap in the selection bar.
   */
  decorate?: (term: Grid, row: Rect, index: number, selected: boolean) => void
  /**
   * Draw a drop shadow under the box. See shadow() in box.ts. Off by default,
   * because it overwrites the cells it falls on: that reads as depth over a
   * program still legible beneath, and as noise otherwise.
   */
  shadow?: boolean
  /**
   * Redraw the top screen and flush it to the terminal.
   *
   * Required only by the selected-row flash, which it enables: the stack
   * repaints on a key but not on a timer, so without this the box closes
   * immediately on Enter rather than flashing.
   */
  onRepaint?: () => void
}

const MIN_W = 18
/** Blank columns either side of the longest item. */
const PAD = 2

/**
 * The chosen row flashes before the box closes.
 *
 * A modal that disappears on the keypress leaves no indication of which row was
 * taken. Three pulses is long enough to register and short enough not to delay.
 */
const FLASH_MS = 55
/** Odd, and lit on odd phases, so the bar is lit when the box closes. */
const FLASH_PHASES = 5

export class SelectPopup implements Screen {
  private index: number
  /** Flash phases remaining. 0 when the box is not closing. */
  private phase = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private opts: SelectOptions) {
    this.index = Math.min(Math.max(opts.selected ?? 0, 0), Math.max(0, opts.items.length - 1))
  }

  /**
   * The two keys that always report onFeedback('move') or ('edge'), so the
   * movement is the sound and the key click would double it. Tied to
   * onFeedback, so a caller that plays nothing for those kinds gets a silent
   * arrow.
   *
   * The modifier checks mirror onKey's: a combination passed to the browser is
   * not a key this handles.
   */
  silentKey(e: KeyInput): boolean {
    // Already closing. Nothing is handled, so nothing sounds.
    if (this.phase) return true
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    if (e.key === 'Enter') return this.opts.silentChoose === true
    // A row's own key selects, so it sounds as Enter does.
    if (this.opts.silentChoose && e.key.length === 1
        && this.opts.keys?.some(k => k.toLowerCase() === e.key.toLowerCase())) return true
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
  }

  onKey(e: KeyInput): boolean {
    // The choice is made and the box is closing. Keys are swallowed rather than
    // passed on: a second Enter would choose twice, and an arrow reaching the
    // browser scrolls the page beneath the modal.
    if (this.phase) return true
    if (e.metaKey || e.altKey) return false

    if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      this.opts.onFeedback?.('cancel', e)
      this.opts.onDone(null, -1)
      return true
    }

    if (e.ctrlKey) return false

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const count = this.opts.items.length
      // Nothing to move through. Still consumed; see the arrow note below.
      if (!count) {
        this.opts.onFeedback?.('edge', e)
        return true
      }
      // Wraps at both ends, so holding one arrow reaches every item.
      const delta = e.key === 'ArrowUp' ? -1 : 1
      this.index = (this.index + delta + count) % count
      this.opts.onFeedback?.('move', e)
      return true
    }

    // A single column has no sideways movement, but the key must still be
    // swallowed or it reaches the browser and scrolls the page beneath the
    // modal. Acknowledged with a click and no movement.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.opts.onFeedback?.('inert', e)
      return true
    }

    if (e.key === 'Enter') {
      const item = this.opts.items[this.index]
      if (item === undefined) return true
      this.opts.onFeedback?.('choose', e)
      this.choose(item, this.index)
      return true
    }

    // A row's own key, checked last so it cannot shadow a key the list already
    // handles. It moves the selection before choosing, so the row flashes as it
    // is taken and identifies which one the key selected.
    if (this.opts.keys && e.key.length === 1) {
      const i = this.opts.keys.findIndex(k => k.toLowerCase() === e.key.toLowerCase())
      const item = i >= 0 ? this.opts.items[i] : undefined
      if (item !== undefined) {
        this.index = i
        this.opts.onFeedback?.('choose', e)
        this.choose(item, i)
        return true
      }
    }

    return false
  }

  /**
   * Select the row: flash it, then resolve.
   *
   * The stack repaints for the key that reached here, which is the first lit
   * phase; the timer drives the rest. Without a grid to paint on there is no
   * flash, and the result resolves immediately.
   */
  private choose(item: string, index: number) {
    if (!this.opts.onRepaint) {
      this.opts.onDone(item, index)
      return
    }
    this.phase = FLASH_PHASES
    this.timer = setInterval(() => {
      this.phase--
      if (this.phase > 0) {
        this.opts.onRepaint?.()
        return
      }
      // Stopped first, because onDone pops and pop disposes this.
      this.stop()
      this.opts.onDone(item, index)
    }, FLASH_MS)
  }

  private stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.phase = 0
  }

  /** Popped mid-flash, as when a program tears down. Stops the timer. */
  dispose() {
    this.stop()
  }

  /** Centred within `bounds`, sized to its contents, clamped to fit. */
  private rect(term: Grid): Rect {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const widest = this.opts.items.reduce((n, s) => Math.max(n, s.length), 0)
    const hint = this.opts.hint
    const hintW = !hint ? 0
      : typeof hint === 'string' ? cells(hint)
      : hint.reduce((n, s) => n + cells(s.text), 0)

    const w = Math.min(
      Math.max(MIN_W, b.w - 4),
      Math.max(MIN_W, widest + PAD * 2 + 2, this.opts.title.length + 6, hintW + 6)
    )
    // Never taller than the given region, so the caller keeps the rows it did
    // not offer.
    const h = Math.min(Math.max(3, b.h - 2), this.opts.items.length + 2)
    // Removed from the top with the bottom edge unchanged, so the box shortens
    // and descends by the same amount. Never smaller than a frame with one row.
    const trim = Math.min(Math.max(0, this.opts.trimTop ?? 0), Math.max(0, h - 3))

    return {
      x: b.x + Math.floor((b.w - w) / 2),
      y: b.y + Math.floor((b.h - h) / 2) + trim,
      w,
      h: h - trim,
    }
  }

  draw(term: Grid) {
    const r = this.rect(term)

    // Clear the whole box, borders included, before framing it: box drawing
    // merges line bits with the existing cell, so a border over the program's
    // own rule would merge into a tee rather than covering it. Same note in
    // text.ts.
    clear(term, r)
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)

    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    if (this.opts.hint) {
      label(term, r, this.opts.hint, { edge: 'bottom', align: 'right' })
    }

    // Keep the selection on screen when the list is taller than the popup.
    const first = Math.max(0, Math.min(
      this.index - Math.floor(inner.h / 2),
      this.opts.items.length - inner.h
    ))

    // BRIGHT on the odd phases, which the resting bar is drawn DIM to avoid.
    // Intended here, for a fifth of a second on the row just taken.
    const lit = this.phase % 2 === 1

    for (let i = 0; i < inner.h; i++) {
      const item = this.opts.items[first + i]
      if (item === undefined) break
      const on = first + i === this.index
      // Pad the whole row so the highlight is a bar rather than a ragged word.
      const text = ' '.repeat(PAD) + item.padEnd(inner.w - PAD)
      // DIM inverse with BOLD text on the selected row. On an inverse cell the
      // attribute applies to the background, so BRIGHT would make the selection
      // the brightest element on screen. DIM with bold text marks the row
      // without that.
      const attr = on ? (lit ? BRIGHT : DIM) | BOLD : NORMAL
      term.text(inner.x, inner.y + i, text.slice(0, inner.w), attr, on ? 1 : 0)
      // Applied after the row rather than instead of it: the padded string
      // draws the bar and this re-attributes columns of it. Passed the item's
      // own rect rather than the row's; see `decorate`.
      //
      // Skipped while the chosen row is flashing, where a column held at its own
      // level would leave a gap in the bar as the bar changes level.
      if (!(on && this.phase)) this.opts.decorate?.(
        term,
        { x: inner.x + PAD, y: inner.y + i, w: inner.w - PAD, h: 1 },
        first + i,
        on,
      )
    }

    // Applied last, over everything the box drew. See ground() in box.ts.
    ground(term, r)

    // Nothing here takes input, so the caret is hidden rather than parked on
    // the frame, where the cursor would invert that cell and blink. The stack
    // restores showCursor on pop.
    term.showCursor = false
    term.dirty = true
  }
}
