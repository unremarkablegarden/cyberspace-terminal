// A modal of numeric controls, and the only popup here where the sideways
// arrows change a value.
//
// Every other popup in tui/ swallows the sideways arrows as inert, since a
// single column has nowhere to move and the key only needs to be kept from
// scrolling the host page. This one is a column of numbers, so up and down move
// between controls and left and right adjust the focused one, with the display
// updating live: the value cannot be judged from the number alone.
//
// There is no commit step and therefore nothing to cancel, following the same
// approach as settings.ts: each adjustment is applied and persisted as it is
// made, and Escape only closes the box. Two undo paths cover that: Backspace
// restores the focused control, and the row at the foot restores all of them.
//
// The controls are data, as the settings are. This module knows only that a
// control has a range and a step. See TuneSpec.

import { NORMAL, BRIGHT, BOLD, DIM } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, keyHint, label, shadow, type Rect, type Span } from './box.js'

/** One number, and how far it is allowed to go. */
export interface Knob {
  /** Identifies the control to get/set, and labels the row. */
  key: string
  min: number
  max: number
  /**
   * The increment for one arrow press, and the precision the readout is rounded
   * to: a step of 0.0002 gives four decimals and 0.1 gives one, so a control
   * never displays more precision than it can be set to.
   */
  step: number
  /** Short description, shown in the top rule for the focused row. */
  hint: string
}

/** Controls under a heading. Presentation only; nothing else groups them. */
export interface KnobGroup {
  title: string
  knobs: Knob[]
}

/**
 * What a tunable subject supplies: the controls, and the three operations on
 * them.
 *
 * All are functions rather than values, for the same reason Setting.current is
 * a getter: the box must not hold the authoritative copy. Values are read back
 * on every frame, so a change made elsewhere appears at the next paint rather
 * than being overwritten.
 */
export interface TuneSpec {
  title: string
  groups: KnobGroup[]
  get(key: string): number
  /** Applied and persisted immediately. There is no commit step. */
  set(key: string, value: number): void
  /** Restore the initial value. Omitting the key restores all of them. */
  reset(key?: string): void
}

export interface TuneOptions extends TuneSpec {
  /** Called on dismissal. The caller pops, as with SelectPopup. */
  onDone(): void
  /** Sounds the box requests; it produces none itself. See SelectOptions.onFeedback. */
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
/** Preferred bar width. The bar is the first element narrowed when the box must shrink. */
const BAR = 16
/** Minimum bar width; below this it conveys nothing. */
const MIN_BAR = 6
/** Rows before the list scrolls instead of growing. As MAX_ROWS in settings.ts. */
const MAX_ROWS = 14

const RESET_LABEL = 'reset all'

/**
 * Plain text rather than keycaps, as modal hints are elsewhere. Same rule as
 * settings.ts's HINT and feed's POPUP_HINT.
 *
 * Uses ‹› (U+2039/203A) because no font here has a leftwards arrow and <> reads
 * as markup. BKSP is spelled out because ⌫ is not among the glyphs bdf.ts
 * synthesises and would render as ? in most fonts.
 */
/** Width of a run of spans, in cells. */
const spanCells = (spans: Span[]): number =>
  spans.reduce((n, s) => n + cells(s.text), 0)

const HINT = keyHint([
  ['‹›', 'Adjust'], ['⬆⬇', 'Move'], ['⌫', 'Reset'], ['ESC', 'Back'],
])
const COPIED = 'COPIED'
const COPY_FAILED = 'CLIPBOARD BLOCKED — SEE CONSOLE'
/** How long the copy acknowledgement remains in the rule. */
const FLASH_MS = 1400

/** Coarse adjustment: ten steps at once, for controls with a step as small as 0.0002. */
const COARSE = 10

/** Headings and gaps cannot be focused; the other row kinds can. */
type Row =
  | { kind: 'head', text: string }
  | { kind: 'gap' }
  | { kind: 'knob', knob: Knob }
  | { kind: 'reset' }

/** Decimal places implied by the step: 0.01 gives two, 0.0002 gives four. */
function decimals(step: number): number {
  return Math.max(0, Math.ceil(-Math.log10(step)))
}

export class TunePopup implements Screen {
  private rows: Row[]
  private cursor: number
  /**
   * The grid from the last draw, so the copy acknowledgement can clear itself.
   * Nothing else would repaint: the stack draws on a consumed key, and the
   * acknowledgement expires long after that key. SettingsScreen keeps one for
   * the same reason.
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
   * Every key here plays its own sound, so the key click is suppressed. Ctrl-C
   * keeps its click deliberately, being the only key here that acts outside the
   * machine.
   */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
      || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      || e.key === 'Backspace' || e.key === 'Enter'
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false

    // Ctrl-C copies in this box only; everywhere else in the machine it cancels.
    // A deliberate exception: this is where a tuning worth keeping is arrived
    // at, and the only use for one is pasting it into crt.ts. Escape is
    // unchanged, so the box is no harder to leave.
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
      // The reset row holds no value, so sideways keys do nothing.
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
      // Every control has applied as it was adjusted, so Enter confirms what is
      // already in effect. Same as settings.ts.
      this.opts.onFeedback?.('cancel', e)
      this.opts.onDone()
      return true
    }

    // Swallow the rest: an unconsumed key acts on the hidden screen beneath,
    // and an unconsumed arrow scrolls the host page.
    return false
  }

  /** Move to the next focusable row, wrapping. Headings and gaps are skipped. */
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
   * Adjust a control by whole steps.
   *
   * Snapped to the step grid and rounded to the implied decimals rather than
   * accumulated: forty presses at a step of 0.005 would otherwise drift into
   * floating-point noise, leaving the readout showing 0.30 while the value is
   * 0.30000000000000004.
   */
  private nudge(knob: Knob, steps: number, e: KeyInput) {
    const current = this.opts.get(knob.key)
    const raw = Math.round(current / knob.step + steps) * knob.step
    const next = Number(
      Math.min(knob.max, Math.max(knob.min, raw)).toFixed(decimals(knob.step))
    )
    // Already at the limit. Still consumed, since the key reached the box.
    if (next === current) { this.opts.onFeedback?.('edge', e); return }
    this.opts.onFeedback?.('adjust', e)
    this.opts.set(knob.key, next)
  }

  /**
   * Every control as `  key: value,` lines, matching the preset blocks in
   * crt.ts, so a tuning can be pasted back into the source in one step.
   */
  private copy(e: KeyInput) {
    const text = this.opts.groups
      .flatMap(g => g.knobs)
      .map(k => `  ${k.key}: ${this.opts.get(k.key)},`)
      .join('\n')

    this.opts.onFeedback?.('apply', e)

    // Absent over plain http. This never runs in an insecure context, but a ?.
    // yielding undefined and then being .then'd would throw a TypeError inside a
    // key handler and close the box.
    const write = navigator.clipboard?.writeText(text)
    if (!write) { this.fallback(text); return }

    write
      .then(() => this.setFlash(COPIED))
      // Blocked by permissions, or the document was not focused.
      .catch(() => this.fallback(text))
  }

  /** Fallback to the console, where shader values are usually collected. */
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
    // Measured from each control's maximum, the widest reading it can produce.
    // Sizing to the current value would shift the numbers as they are adjusted.
    const numW = knobs.reduce(
      (n, k) => Math.max(n, cells(k.max.toFixed(decimals(k.step)))), 1
    )

    // +1 on the left for the caret in the first column.
    const fixed = 1 + PAD + labelW + GAP + GAP + numW + PAD
    let barW = BAR

    // The rules must hold the title and the hint, both inside the frame with a
    // blank either side and an inset of 2 from the corner.
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

  /** Keep the focused row on screen when the list is taller than the box. */
  private window(rows: number): number {
    return Math.max(0, Math.min(this.cursor - (rows >> 1), this.rows.length - rows))
  }

  draw(term: Grid) {
    this.term = term
    const { box, labelW, barW, numW } = this.geometry(term)

    // Clear the whole box, borders included, before framing it: box drawing
    // merges line bits with the existing cell, so a border over the config box's
    // own rule would merge into a tee rather than covering it. Same note as in
    // select.ts and settings.ts.
    clear(term, box)
    if (this.opts.shadow) shadow(term, box, this.opts.bounds)
    frame(term, box)

    label(term, box, this.opts.title, { attr: BRIGHT | BOLD })

    // The focused control's description, in the top rule opposite the title.
    // The bottom rule already carries the keys, and a name such as `chroma`
    // does not convey that it controls misconvergence. Dropped rather than
    // wrapped when the box is too narrow for both.
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
        // DIM and lower case, so a heading reads as a divider rather than as
        // another control.
        term.text(inner.x + 1 + PAD, y, row.text.slice(0, inner.w - 1 - PAD), DIM)
        continue
      }

      // A caret rather than an inverse bar. Every other list here highlights
      // with the inverse plane, which fails in this box: half of each row is
      // block glyphs, and inverting a filled block clears the cells the meter is
      // drawn from, so the focused row's meter would read backwards.
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

    // Applied last, over everything the box drew. See ground() in box.ts. The
    // meters are unaffected: both the dithered and filled blocks keep their own
    // beam level, and the background only lifts the dark pixels between them,
    // as it already does for the blanks around the empty half of the bar.
    ground(term, box)

    // Nothing here takes input, so the caret is hidden rather than parked on the
    // frame, where the cursor would invert that cell and blink. The stack
    // restores showCursor on pop.
    term.showCursor = false
    term.dirty = true
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.term = null
  }
}
