// A centred modal list — pick one thing, or dismiss.
//
// It is a Screen, so pushing it onto the stack snapshots the grid underneath
// and hands it back on pop: the program behind it does not have to know it was
// covered, and does not have to redraw to recover.
//
// Selection is drawn with the grid's inverse-video bit rather than a marker
// character, which is what a real TUI does and costs nothing — term.ts has
// carried the `inverse` array since the beginning for exactly this.

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
  /** Chosen item, or null if dismissed. The caller is responsible for popping. */
  onDone: (item: string | null, index: number) => void
  /**
   * Hook for sounds the widget itself has an opinion about; it makes none of
   * its own. Not the keyclick — that is played once for every key, wherever
   * the page hands keys to the terminal, so a widget adding another would
   * double it. What is left is `edge`: nowhere to go, which is a complaint,
   * and only the widget knows it happened.
   */
  onFeedback?: (
    kind: 'move' | 'choose' | 'cancel' | 'edge' | 'inert',
    e: KeyInput
  ) => void
  /**
   * The caller answers Enter with a sound of its own, so the keyclick would be
   * a second sound for one keypress.
   *
   * Opt-in rather than assumed, because choosing does not always DO anything:
   * cIRC's room switcher is silent when you pick the room you were already in,
   * and a mute there would be a key that simply stopped responding.
   */
  silentChoose?: boolean
  /**
   * One bare key per row that picks it outright, parallel to `items`.
   *
   * For a list short enough to number, where the arrows are the slow way round.
   * Compared case-insensitively and only for a key with no modifier on it, so
   * it can never take a combo the popup already hands back to the browser. A
   * shorter array simply leaves the remaining rows arrow-only.
   */
  keys?: string[]
  /** Shown in the bottom rule. Spans so a key can wear its cap, as the footer does. */
  hint?: string | Span[]
  /**
   * Region to centre within. Defaults to the whole grid. A program with its own
   * furniture — a chat with an input line at the bottom — passes the area it is
   * willing to have covered, so the modal does not sit on top of it.
   */
  bounds?: Rect
  /**
   * Rows to take off the top after sizing, leaving the bottom edge where the
   * centring put it — so the box is that much shorter and sits that much
   * lower. `bounds` cannot do this: the height comes from the item count, not
   * from the region, so a smaller region moves the box without resizing it.
   */
  trimTop?: number
  /**
   * Re-attribute part of a row after it has been drawn.
   *
   * A row lands as ONE padded string at ONE attribute, which is right for a list
   * of names and wrong the moment a row carries a second fact beside the name —
   * a count, a marker — that should not read as loudly as the name does. This is
   * the hook for those columns, and it is exactly what `cmail`'s index does by
   * hand for its unread mark and its clock.
   *
   * `row` is where the ITEM was drawn, one cell high — PAD already taken off
   * the front, so column 0 of it is character 0 of the string the caller handed
   * over and the caller never has to know this widget indents anything.
   * `selected` is the row's inversion: anything drawn over an inverted row must
   * carry it too, or a re-attributed run punches a hole in the selection bar.
   */
  decorate?: (term: Grid, row: Rect, index: number, selected: boolean) => void
  /**
   * Lay a drop-shadow under the box — see `shadow` in box.ts. Off by default,
   * because it EATS the cells it falls on: over a program still readable
   * underneath it is what says this box is in front, and over one that is not
   * it is a smudge. The caller knows which it has.
   */
  shadow?: boolean
  /**
   * Draw the top screen again and flush it to the terminal.
   *
   * Only the chosen-row flash needs this, and it is what turns the flash on:
   * a key repaints through the stack, but a clock does not, so a caller that
   * cannot paint between keystrokes gets the box closing the moment Enter is
   * pressed rather than a bar strobing at a screen nobody is updating.
   */
  onRepaint?: () => void
}

const MIN_W = 18
/** Blank columns either side of the longest item. */
const PAD = 2

/**
 * The chosen row lights up before the box goes.
 *
 * A modal that vanishes on the keypress leaves nothing to say WHICH row went
 * with it — the eye is on the bar, the bar is gone, and the only evidence is
 * whatever happened underneath. Three pulses is long enough to register as the
 * row being taken and short enough that nobody waits for it.
 */
const FLASH_MS = 55
/** Odd, and lit on the odd ones: the bar is lit when the box closes over it. */
const FLASH_PHASES = 5

export class SelectPopup implements Screen {
  private index: number
  /** Flash phases left. 0 when the box is not closing. */
  private phase = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private opts: SelectOptions) {
    this.index = Math.min(Math.max(opts.selected ?? 0, 0), Math.max(0, opts.items.length - 1))
  }

  /**
   * The two keys that always come back as onFeedback('move') or ('edge'), so
   * the row moving is the sound and the keyclick would only double it. Ties
   * the silence to onFeedback: a caller that makes no noise for those kinds
   * gets an arrow that makes none either.
   *
   * The modifier checks mirror onKey's — a combo it hands back to the browser
   * is not a key it answers.
   */
  silentKey(e: KeyInput): boolean {
    // Already going. Nothing answers, so nothing sounds.
    if (this.phase) return true
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    if (e.key === 'Enter') return this.opts.silentChoose === true
    // A row's own key is a choose by another name, so it answers the same way.
    if (this.opts.silentChoose && e.key.length === 1
        && this.opts.keys?.some(k => k.toLowerCase() === e.key.toLowerCase())) return true
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
  }

  onKey(e: KeyInput): boolean {
    // The answer is in; the box is on its way out. Keys are swallowed rather
    // than passed on — a second Enter through here would choose twice, and an
    // arrow falling through to the browser scrolls the page under the modal.
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
      // Nothing to move through. Still consumed — see the arrow note below.
      if (!count) {
        this.opts.onFeedback?.('edge', e)
        return true
      }
      // Wraps around the ends: the list is a ring, so one arrow held down
      // reaches everything and neither end is a dead stop.
      const delta = e.key === 'ArrowUp' ? -1 : 1
      this.index = (this.index + delta + count) % count
      this.opts.onFeedback?.('move', e)
      return true
    }

    // A single column has nowhere to go sideways, but the key must still be
    // swallowed: unconsumed it falls through to the browser, which scrolls the
    // page under the modal. Acknowledged with a click, no movement.
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

    // A row's own key. Last, so it can never shadow a key the list already
    // answers, and it MOVES the selection before choosing — the row lights up
    // as it is taken, which is what says which one the key meant.
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
   * Take the row: flash it, then hand it over.
   *
   * The stack repaints for the key that got here, which is the first lit phase;
   * from there the clock owns the box. Without somewhere to paint there is no
   * flash to run, so the answer goes straight out.
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
      // Stopped first: onDone pops, and pop disposes this.
      this.stop()
      this.opts.onDone(item, index)
    }, FLASH_MS)
  }

  private stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.phase = 0
  }

  /** Popped mid-flash — a program tearing down. Kill the clock. */
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
    // Never taller than the region it was given: the whole point of bounds is
    // that the caller keeps the rows it did not offer.
    const h = Math.min(Math.max(3, b.h - 2), this.opts.items.length + 2)
    // Taken off the top with the bottom edge left where it was, so the box
    // shortens and descends by the same amount. Never below a frame with one
    // row in it.
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

    // Blank the whole box, borders included, BEFORE framing it: box drawing
    // merges line bits with what is already in the cell, so a border laid over
    // the program's own rule underneath would fuse with it into a tee rather
    // than covering it. See the same note in text.ts.
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

    // The flash is BRIGHT on the odd phases — a slab of lit phosphor, which is
    // exactly what the resting bar is drawn DIM to avoid being. For a fifth of
    // a second on the row that was just taken, that is the point.
    const lit = this.phase % 2 === 1

    for (let i = 0; i < inner.h; i++) {
      const item = this.opts.items[first + i]
      if (item === undefined) break
      const on = first + i === this.index
      // Pad the whole row so the highlight is a bar, not a ragged word.
      const text = ' '.repeat(PAD) + item.padEnd(inner.w - PAD)
      // DIM inverse with BOLD text on the selected row. On an inverse cell the
      // attr is the FIELD, so BRIGHT made the selection a slab of lit phosphor
      // with the words cut out of it — the brightest thing on the tube, for a
      // row whose job is only to say where you are. Taking the field down and
      // thickening the letters says the same thing without shouting it.
      const attr = on ? (lit ? BRIGHT : DIM) | BOLD : NORMAL
      term.text(inner.x, inner.y + i, text.slice(0, inner.w), attr, on ? 1 : 0)
      // After the row, never instead of it: the string is what lays the bar
      // down, and this only goes back over columns of it. Handed the item's own
      // rect rather than the row's — see `decorate`.
      //
      // Not while the chosen row is flashing: a column re-attributed to its own
      // level is a hole in the bar the moment the bar changes level, and the
      // flash wants one solid strobe rather than a row of parts pulsing apart.
      if (!(on && this.phase)) this.opts.decorate?.(
        term,
        { x: inner.x + PAD, y: inner.y + i, w: inner.w - PAD, h: 1 },
        first + i,
        on,
      )
    }

    // Last, over everything the box just drew. See `ground` in box.ts.
    ground(term, r)

    // Nothing to type into, so there should be no caret at all. Parking it on
    // the frame does not hide it — the cursor stamp inverts whatever cell it
    // lands on, so it shows up as a blinking corner. The stack restores
    // showCursor on pop.
    term.showCursor = false
    term.dirty = true
  }
}
