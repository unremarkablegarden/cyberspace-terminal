// A box of knobs — the first thing in here where ← and → change a VALUE.
//
// Every other popup in tui/ swallows the sideways arrows as `inert`: a single
// column has nowhere to go, and the key only has to be stopped from scrolling
// the browser page underneath. This one is a column of numbers, and a number
// has somewhere to go in both directions. Up and down move between knobs, left
// and right move the knob you are standing on, and the tube changes under the
// key — which is the whole reason the box exists. You cannot pick a bloom by
// reading `1.28`.
//
// There is no commit and therefore nothing to cancel, the same doctrine
// settings.ts follows: every turn of a knob is already on the machine and
// already written down by the time you reach for Escape. Escape means "done
// turning things". What that costs is an undo, so there are two: Backspace puts
// the knob under the cursor back where it started, and the row at the foot puts
// all of them back.
//
// The knobs are DATA, as the settings are. This module knows that a thing has a
// range and a step; it has never heard of a phosphor mask. See TuneSpec.

import { NORMAL, BRIGHT, BOLD, DIM } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, keyHint, label, shadow, type Rect, type Span } from './box.js'

/** One number, and how far it is allowed to go. */
export interface Knob {
  /** Identifies it to `get`/`set`, and is what the row is labelled with. */
  key: string
  min: number
  max: number
  /**
   * One press of an arrow. Also what the readout is rounded to — a step of
   * 0.0002 is four decimals, a step of 0.1 is one — so a knob cannot show more
   * precision than it can actually be set to.
   */
  step: number
  /** What it does, in a few words. Shown in the top rule for the focused row. */
  hint: string
}

/** Knobs under a heading. Purely how they are listed; nothing groups them. */
export interface KnobGroup {
  title: string
  knobs: Knob[]
}

/**
 * What a tunable thing hands over: the knobs, and the three ways to touch them.
 *
 * Everything is a call rather than a value for the reason `Setting.current` is a
 * getter — the box must never be the copy of record. What it draws is read back
 * out of the machine on every frame, so a value changed from anywhere else is
 * on screen the next time the box paints rather than silently overwritten.
 */
export interface TuneSpec {
  title: string
  groups: KnobGroup[]
  get(key: string): number
  /** Applied and persisted at once. There is no commit step. */
  set(key: string, value: number): void
  /** Back to where it started. No key means all of them. */
  reset(key?: string): void
}

export interface TuneOptions extends TuneSpec {
  /** Dismissed. The caller pops — the same contract SelectPopup has. */
  onDone(): void
  /**
   * Sounds the box has an opinion about; it makes none of its own. Not the
   * keyclick — see SelectOptions.onFeedback.
   */
  onFeedback?(
    kind: 'move' | 'adjust' | 'edge' | 'apply' | 'cancel',
    e: KeyInput
  ): void
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /** Lay a drop-shadow under the box. See `shadow` in box.ts. */
  shadow?: boolean
}

/** Blank columns at either side of the contents. */
const PAD = 2
/** Between a label, its bar and its number. */
const GAP = 2
/** What the bar wants. It gives cells back first when the box has to shrink. */
const BAR = 16
/** Below this it stops being a bar and starts being a rounding error. */
const MIN_BAR = 6
/** Rows before the list scrolls instead of growing. As MAX_ROWS in settings.ts. */
const MAX_ROWS = 14

const RESET_LABEL = 'reset all'

/**
 * Plain text, not keycaps — a modal's hint is a caption, and the inverse cap is
 * the app frame's voice. Same rule as settings.ts's HINT and feed's POPUP_HINT.
 *
 * `‹›` (U+2039/203A) because there is no leftwards arrow in any face here, and
 * `<>` reads as markup — settings.ts made the same call. BKSP is spelled out
 * for the same reason in reverse: `⌫` is NOT one of the glyphs bdf.ts
 * synthesises, so on most faces it would come out as `?`.
 */
/** Width of a run of spans, in cells. */
const spanCells = (spans: Span[]): number =>
  spans.reduce((n, s) => n + cells(s.text), 0)

const HINT = keyHint([
  ['‹›', 'Adjust'], ['⬆⬇', 'Move'], ['⌫', 'Reset'], ['ESC', 'Back'],
])
const COPIED = 'COPIED'
const COPY_FAILED = 'CLIPBOARD BLOCKED — SEE CONSOLE'
/** How long the copy acknowledgement sits in the rule. */
const FLASH_MS = 1400

/** Ten at a time. Twenty-three knobs at a step of 0.0002 need a coarse gear. */
const COARSE = 10

/** A heading and a gap cannot be landed on; the other two can. */
type Row =
  | { kind: 'head', text: string }
  | { kind: 'gap' }
  | { kind: 'knob', knob: Knob }
  | { kind: 'reset' }

/** Decimals the step implies. 0.01 is two, 0.0002 is four. */
function decimals(step: number): number {
  return Math.max(0, Math.ceil(-Math.log10(step)))
}

export class TunePopup implements Screen {
  private rows: Row[]
  private cursor: number
  /**
   * The grid from the last draw, so the copy acknowledgement can take itself
   * back down. Nothing else would repaint: the stack draws on a consumed key,
   * and by the time the flash expires that key is long gone. Same reason
   * SettingsScreen keeps one.
   */
  private term: Grid | null = null
  private flash: typeof COPIED | typeof COPY_FAILED | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: TuneOptions) {
    this.rows = []
    for (const group of opts.groups) {
      if (this.rows.length) this.rows.push({ kind: 'gap' })
      this.rows.push({ kind: 'head', text: group.title })
      for (const knob of group.knobs) this.rows.push({ kind: 'knob', knob })
    }
    this.rows.push({ kind: 'gap' }, { kind: 'reset' })
    this.cursor = this.rows.findIndex(r => r.kind === 'knob' || r.kind === 'reset')
    if (this.cursor < 0) this.cursor = 0
  }

  private get focused(): Row | undefined {
    return this.rows[this.cursor]
  }

  /**
   * Every key here answers with a sound of its own, so the keyclick would be a
   * second noise for one press. Ctrl-C is the exception and deliberately keeps
   * its click: it is the one key in here that reaches outside the machine.
   */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
      || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      || e.key === 'Backspace' || e.key === 'Enter'
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false

    // Ctrl-C COPIES here, and nowhere else in this machine does it mean
    // anything but "no". That is a real exception to a rule the rest of the
    // terminal keeps — ConfirmPopup treats it as a refusal precisely because a
    // key meaning "get me out of this" must not also mean "do the thing" — and
    // it is taken on purpose: this box is where a tuning worth keeping is
    // arrived at, and the only thing to do with one is paste it into crt.ts.
    // Escape is untouched, so the box is still exactly as easy to leave.
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      this.copy(e)
      return true
    }

    if (e.key === 'Escape') {
      this.opts.onFeedback?.('cancel', e)
      this.opts.onDone()
      return true
    }

    if (e.ctrlKey) return false

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      this.move(e.key === 'ArrowUp' ? -1 : 1, e)
      return true
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const row = this.focused
      // The reset row is not a number, so there is nothing sideways about it.
      if (row?.kind !== 'knob') { this.opts.onFeedback?.('edge', e); return true }
      this.nudge(row.knob, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? COARSE : 1), e)
      return true
    }

    if (e.key === 'Backspace') {
      const row = this.focused
      if (row?.kind !== 'knob') { this.opts.onFeedback?.('edge', e); return true }
      this.opts.onFeedback?.('apply', e)
      this.opts.reset(row.knob.key)
      return true
    }

    if (e.key === 'Enter') {
      if (this.focused?.kind === 'reset') {
        this.opts.onFeedback?.('apply', e)
        this.opts.reset()
        return true
      }
      // Every knob has been live since it was turned, so Enter on one is
      // agreeing with what is already on the tube. Same as settings.ts.
      this.opts.onFeedback?.('cancel', e)
      this.opts.onDone()
      return true
    }

    // Swallow the rest. An unconsumed key acts on a screen the reader cannot
    // see, and an unconsumed arrow scrolls the browser page under the modal.
    return false
  }

  /** To the next landable row, wrapping. Headings and gaps are stepped over. */
  private move(delta: number, e: KeyInput) {
    const n = this.rows.length
    for (let i = 1; i <= n; i++) {
      const at = (this.cursor + delta * i + n * i) % n
      const row = this.rows[at]
      if (row?.kind === 'knob' || row?.kind === 'reset') {
        this.cursor = at
        this.opts.onFeedback?.('move', e)
        return
      }
    }
    this.opts.onFeedback?.('edge', e)
  }

  /**
   * Turn a knob by whole steps.
   *
   * Snapped to the step grid and rounded to the decimals the step implies,
   * rather than accumulating: forty presses of ← on a step of 0.005 otherwise
   * drift into float noise, and a readout that says 0.30 while the uniform
   * holds 0.30000000000000004 is a box lying about the machine.
   */
  private nudge(knob: Knob, steps: number, e: KeyInput) {
    const current = this.opts.get(knob.key)
    const raw = Math.round(current / knob.step + steps) * knob.step
    const next = Number(
      Math.min(knob.max, Math.max(knob.min, raw)).toFixed(decimals(knob.step))
    )
    // Already against the stop. Still consumed — the key did reach the box.
    if (next === current) { this.opts.onFeedback?.('edge', e); return }
    this.opts.onFeedback?.('adjust', e)
    this.opts.set(knob.key, next)
  }

  /**
   * Every knob as `  key: value,` lines — the shape of the preset blocks in
   * crt.ts, so a tuning arrived at here goes back into the source as a paste
   * rather than as twenty-three separate readings copied by eye.
   */
  private copy(e: KeyInput) {
    const text = this.opts.groups
      .flatMap(g => g.knobs)
      .map(k => `  ${k.key}: ${this.opts.get(k.key)},`)
      .join('\n')

    this.opts.onFeedback?.('apply', e)

    // Absent entirely over plain http, which is not an insecure context this
    // ever runs in — but a `?.` that yields undefined and is then `.then`ed is
    // a TypeError inside a key handler, and that would take the box down.
    const write = navigator.clipboard?.writeText(text)
    if (!write) { this.fallback(text); return }

    write
      .then(() => this.setFlash(COPIED))
      // Blocked by permissions, or the document was not focused.
      .catch(() => this.fallback(text))
  }

  /** The console, which is where anyone copying shader values out already is. */
  private fallback(text: string) {
    console.log(text)
    this.setFlash(COPY_FAILED)
  }

  private setFlash(message: typeof COPIED | typeof COPY_FAILED) {
    this.flash = message
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flash = null
      if (this.term) this.draw(this.term)
    }, FLASH_MS)
    if (this.term) this.draw(this.term)
  }

  /** Sized to its contents, centred within `bounds`, clamped to fit. */
  private geometry(term: Grid): { box: Rect, labelW: number, barW: number, numW: number } {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const knobs = this.opts.groups.flatMap(g => g.knobs)

    const labelW = knobs.reduce(
      (n, k) => Math.max(n, cells(k.key)), cells(RESET_LABEL)
    )
    // Measured off each knob's own top of range, which is the widest reading it
    // can produce — a column sized to the value that happens to be live would
    // shuffle the numbers sideways as they were turned.
    const numW = knobs.reduce(
      (n, k) => Math.max(n, cells(k.max.toFixed(decimals(k.step)))), 1
    )

    // +1 on the left for the cursor caret in the first column.
    const fixed = 1 + PAD + labelW + GAP + GAP + numW + PAD
    let barW = BAR

    // The rules have to hold the title and the hint, both of which sit inside
    // the frame with a blank either side and an inset of 2 from the corner.
    const need = Math.max(cells(this.opts.title), spanCells(HINT)) + 6
    const grow = need - (fixed + barW + 2)
    if (grow > 0) barW += grow

    const w = Math.min(b.w, fixed + barW + 2)
    barW = Math.max(MIN_BAR, barW - Math.max(0, fixed + barW + 2 - w))

    const h = Math.min(Math.max(3, b.h), Math.min(MAX_ROWS, this.rows.length) + 2)

    return {
      box: {
        x: b.x + Math.floor((b.w - w) / 2),
        y: b.y + Math.floor((b.h - h) / 2),
        w,
        h,
      },
      labelW,
      barW,
      numW,
    }
  }

  /** Keep the cursor on screen when the list is taller than the box. */
  private window(rows: number): number {
    return Math.max(0, Math.min(this.cursor - (rows >> 1), this.rows.length - rows))
  }

  draw(term: Grid) {
    this.term = term
    const { box, labelW, barW, numW } = this.geometry(term)

    // Blank the whole box, borders included, BEFORE framing it: box drawing
    // merges line bits with what is already in the cell, so a border laid over
    // the config box's own rule underneath would fuse with it into a tee rather
    // than cover it. Same note as in select.ts and settings.ts.
    clear(term, box)
    if (this.opts.shadow) shadow(term, box, this.opts.bounds)
    frame(term, box)

    label(term, box, this.opts.title, { attr: BRIGHT | BOLD })

    // What the focused knob DOES, in the top rule opposite the title. The
    // bottom rule is already spoken for by the keys, and a knob called `chroma`
    // that never says it means misconvergence is a knob you turn at random.
    // Dropped rather than wrapped when the box is too narrow for both.
    const focused = this.focused
    if (focused?.kind === 'knob') {
      const hint = focused.knob.hint
      if (cells(this.opts.title) + cells(hint) + 8 <= box.w) {
        label(term, box, hint, { align: 'right', attr: DIM })
      }
    }

    label(term, box, this.flash ?? HINT, {
      edge: 'bottom',
      align: 'right',
      attr: this.flash ? BRIGHT : NORMAL,
    })

    const inner = { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 }
    const first = this.window(inner.h)

    for (let i = 0; i < inner.h; i++) {
      const at = first + i
      const row = this.rows[at]
      if (!row) break
      const y = inner.y + i
      const on = at === this.cursor

      if (row.kind === 'gap') continue

      if (row.kind === 'head') {
        // DIM and lower case: a heading is a divider that happens to be a word,
        // and one drawn at the weight of the knobs would read as a knob.
        term.text(inner.x + 1 + PAD, y, row.text.slice(0, inner.w - 1 - PAD), DIM)
        continue
      }

      // The caret, and not an inverse bar. Every other list in here highlights
      // with the inverse plane, which cannot work in this box: half of each row
      // is block glyphs, and inverting a `█` puts out the very cells the bar is
      // made of — the focused row would be the one whose meter reads backwards.
      const attr = on ? BRIGHT : NORMAL
      term.text(inner.x, y, on ? '›' : ' ', attr)

      if (row.kind === 'reset') {
        term.text(inner.x + 1 + PAD, y, RESET_LABEL.slice(0, inner.w - 1 - PAD), attr)
        continue
      }

      const { knob } = row
      const value = this.opts.get(knob.key)
      const span = knob.max - knob.min
      const ratio = span > 0 ? (value - knob.min) / span : 0
      const filled = Math.round(Math.min(1, Math.max(0, ratio)) * barW)

      const text = ' '.repeat(PAD)
        + knob.key.padEnd(labelW)
        + ' '.repeat(GAP)
        + '█'.repeat(filled) + '░'.repeat(barW - filled)
        + ' '.repeat(GAP)
        + value.toFixed(decimals(knob.step)).padStart(numW)

      term.text(inner.x + 1, y, text.slice(0, inner.w - 1), attr)
    }

    // Last, over everything the box just drew. See `ground` in box.ts. The
    // meters take it like anything else: a `░` is a dither and a `█` is a
    // fill, and both keep their own beam — the ground only lifts the dark
    // pixels between them, which is the same lift the empty half of the bar
    // already gets from the blanks around it.
    ground(term, box)

    // Nothing to type into, so there should be no caret. Parking it on the
    // frame does not hide it — the cursor stamp inverts whatever cell it lands
    // on, so it shows up as a blinking corner. The stack gives showCursor back
    // on pop.
    term.showCursor = false
    term.dirty = true
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.term = null
  }
}
