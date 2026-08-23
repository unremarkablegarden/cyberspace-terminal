// The settings screen: one box for every machine setting.
//
// Replaces five F-keys, one per setting, each cycling its own list with no way
// to see the available values without pressing through them. F11 remains a key,
// since fullscreen is an action rather than a setting and the binding must be
// taken from the browser to keep Escape.
//
// Two panes. The left lists the settings and their current values; the right
// lists the values of the focused setting. Left and right move between the
// panes, up and down move within the focused one, and a value applies as soon
// as the cursor lands on it, so previewing and choosing are the same action.
// There is nothing to confirm and nothing to cancel: Escape closes the box
// without reverting.
//
// The settings are data supplied by the page. The engine does not know what a
// phosphor is or where a preference is stored; the session goes through
// stores/terminal.ts and chat and the feed through injected services. See
// SettingsSource.

import {
  cells, clear, frame, ground, keyHint, label, shadow, vline, TunePopup, ScreenStack,
  NORMAL, BRIGHT, BOLD, DIM, FAINT,
  type Grid, type Rect, type Screen, type KeyInput, type TuneSpec, type StackSurface,
} from '@cyberspace/tui'

/** One thing a member can change. */
export interface Setting {
  /** Left-pane label. Short and upper case, such as FONT or PHOSPHOR. */
  label: string
  /** The values on offer, in the order they are shown. */
  values: string[]
  /**
   * The value currently in effect.
   *
   * A getter rather than a value, because this box is not the authoritative
   * copy: the `phosphor` command changes it from the shell, and saving a CRT
   * preset extends the list. Read on every draw, so the box cannot go stale.
   */
  current(): string
  /**
   * Apply a value and return the value that actually took effect.
   *
   * Async and fallible because of the font, where switching fetches and parses
   * a BDF and a failed fetch leaves the previous face in place. Every other
   * setting returns immediately.
   */
  select(value: string): string | Promise<string>
  /**
   * Child settings instead of values.
   *
   * The right pane then lists the children with their current values, and Enter
   * advances the focused one, which for two values is a toggle. AUDIO is the
   * case this exists for: background, keys and beeps are independent switches
   * rather than alternatives, and listing them as values would imply only one
   * can be active.
   *
   * `values` and `select` are ignored when this is present. `current()` is not,
   * since the left pane must still describe the group.
   */
  children?: Setting[]
  /**
   * A value that opens a further box rather than being a leaf.
   *
   * Null for most values. `user` under SCREEN is the only one today, being a
   * set of member-owned controls rather than one of a fixed list of
   * alternatives.
   *
   * Declared per value rather than per setting, since the other SCREEN values
   * are presets with nothing to adjust.
   */
  tune?(value: string): TuneSpec | null
}

/**
 * The source of the settings, supplied by the page as ChatService and
 * ProgramStore are.
 *
 * A function rather than an array, for the same reason `current` is a getter:
 * the list changes. Saving a user CRT preset adds a fourth value to SCREEN,
 * which a source read once at construction would never show.
 */
export interface SettingsSource {
  settings(): Setting[]
}

export interface SettingsOptions {
  settings: Setting[]
  /** Called on dismissal. The caller pops; see Shell.toggleSettings. */
  onDone(): void
  /**
   * Called once the screen has left the stack by any route, whether onDone's pop
   * or the drain in Shell.dispose() on unmount. Resolves the `config` command,
   * which withholds the prompt until the box is gone.
   *
   * Distinct from onDone: that is a request to close and must pop, this reports
   * that it closed and must not, or it would re-enter the pop that called it.
   */
  onGone?(): void
  /**
   * Sounds the widget requests; it produces none itself. Not the key click,
   * which the page already plays once per key. See SelectOptions.onFeedback.
   */
  onFeedback?(
    kind: 'move' | 'pane' | 'apply' | 'edge' | 'cancel',
    e: KeyInput
  ): void
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /** Draw a drop shadow under the box. See shadow() in tui/box.ts. */
  shadow?: boolean
  /**
   * Push and pop a screen above this one. The stack this screen is on, passed as
   * two functions rather than the stack itself, since the control box is the
   * only thing here permitted to use it and needs exactly these two.
   *
   * Without them a tunable value does not open and the box behaves as before.
   */
  push?(screen: Screen): void
  pop?(): void
}

// Titled CONFIG, matching the boot message and the command that opens the same
// box, rather than naming it for this class.
const TITLE = 'CONFIG'
/** Blank columns at the left of either pane. */
const PAD = 2
/** Between a label and its current value in the left pane. */
const GAP = 2

/**
 * Maximum rows before the panes scroll instead of the box growing.
 *
 * Without a cap the height follows the longest list, and the font list is
 * open-ended, so the box would eventually fill the screen and stop reading as a
 * box over the machine. window() already handles the scrolling.
 */
const MAX_ROWS = 12

/**
 * Plain text rather than keycaps, matching feed's POPUP_HINT.
 *
 * ⬆⬇ and ↵ are the glyphs circ and feed hint with, and are safe on any face
 * because bdf.ts synthesises them per cell size rather than carrying a
 * hand-drawn set. Before that they rendered as ? on every face except Spleen;
 * verified against the parser.
 *
 * ‹› (U+2039/203A) is used because no face and no synthesised glyph provides a
 * leftwards arrow, and <> reads as markup. It is present in every face offered.
 *
 * Correctness matters most on this screen, since it is where the face is
 * switched, so a hint using a code point the new face lacks would break in
 * front of the person switching to it. A missing glyph renders as ? with no
 * warning.
 */
const HINT = keyHint([
  ['‹›', 'Pane'], ['⬆⬇', 'Move'], ['↵', 'Set'], ['ESC', 'Close'],
])
const HINT_W = HINT.reduce((n, s) => n + cells(s.text), 0)

/** Which pane the arrows are moving in. */
const LEFT = 0, RIGHT = 1

interface Geometry {
  box: Rect
  /** Inner width of the settings column, excluding both borders. */
  leftW: number
  /** Inner width of the value column. */
  rightW: number
  /** Column the divider sits in, absolute. */
  splitX: number
  /** Rows available inside the frame. */
  rows: number
}

export class SettingsScreen implements Screen {
  /** Left pane: which setting. */
  private row = 0
  /** Right pane: which of that setting's values. */
  private value = 0
  private pane: typeof LEFT | typeof RIGHT = LEFT
  /**
   * True while an async select is in flight. Only the font has one, and only on
   * its first use, since the face is parsed once and cached. Without this a
   * held-down arrow would start a second fetch over the first.
   */
  private busy = false
  /**
   * The grid from the last draw, so an async select can repaint on completion.
   * Nothing else would: the stack repaints on a consumed key, and a font
   * resolves long after that key, leaving the left pane showing the previous
   * face.
   */
  private term: Grid | null = null

  constructor(private opts: SettingsOptions) {
    this.syncValue()
  }

  /** The focused setting, whatever kind it is. */
  private get focused(): Setting | undefined {
    return this.opts.settings[this.row]
  }

  /** How many rows the right pane has: child settings, or values. */
  private get rightCount(): number {
    const setting = this.focused
    return setting?.children?.length ?? setting?.values.length ?? 0
  }

  /**
   * Position the right pane: on the live value for a plain setting, or on the
   * first child for a group, where no child is the selected one.
   */
  private syncValue() {
    const setting = this.focused
    if (!setting || setting.children) { this.value = 0; return }
    const i = setting.values.indexOf(setting.current())
    // -1 when the live value is not in the list, which should not occur.
    // Falls back to the top of the list.
    this.value = i < 0 ? 0 : i
  }

  /**
   * The four keys that always report through onFeedback, so the movement is the
   * sound and the key click would double it. The modifier checks mirror onKey's:
   * a combination passed to the browser is not handled here.
   */
  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    return e.key === 'ArrowUp' || e.key === 'ArrowDown'
      || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false

    if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      this.opts.onFeedback?.('cancel', e)
      this.opts.onDone()
      return true
    }

    if (e.ctrlKey) return false

    const setting = this.opts.settings[this.row]

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const delta = e.key === 'ArrowUp' ? -1 : 1
      // Both panes wrap, as SelectPopup does, so one arrow held down reaches
      // every row.
      if (this.pane === LEFT) {
        const count = this.opts.settings.length
        if (!count) { this.opts.onFeedback?.('edge', e); return true }
        this.row = (this.row + delta + count) % count
        this.syncValue()
        this.opts.onFeedback?.('move', e)
        return true
      }
      const count = this.rightCount
      if (!count) { this.opts.onFeedback?.('edge', e); return true }
      this.value = (this.value + delta + count) % count
      // A group's children are switches rather than alternatives, so moving
      // between them must not activate one, or a child could not be passed over
      // to reach the next. Enter changes a child.
      if (!setting?.children) this.apply(e)
      else this.opts.onFeedback?.('move', e)
      return true
    }

    // In the left pane Enter behaves as Right, since both mean moving into the
    // list elsewhere in this box.
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      if (this.pane === LEFT) {
        if (!this.rightCount) { this.opts.onFeedback?.('edge', e); return true }
        this.pane = RIGHT
        this.opts.onFeedback?.('pane', e)
        return true
      }
      // A value that opens further handles both keys, ahead of their usual
      // meanings: Right because it means "into" elsewhere in this box, and Enter
      // for the same reason.
      if (this.open(e)) return true
      if (e.key === 'Enter') {
        // In a group Enter toggles the child, the only action here that must be
        // pressed rather than moved onto.
        const child = setting?.children?.[this.value]
        if (child) { this.advance(child, e); return true }
        // Otherwise the value has applied since the cursor landed on it, so this
        // confirms what is already in effect.
        this.opts.onFeedback?.('cancel', e)
        this.opts.onDone()
        return true
      }
      this.opts.onFeedback?.('edge', e)
      return true
    }

    if (e.key === 'ArrowLeft') {
      if (this.pane === RIGHT) {
        this.pane = LEFT
        this.opts.onFeedback?.('pane', e)
        return true
      }
      this.opts.onFeedback?.('edge', e)
      return true
    }

    return false
  }

  /**
   * Apply the value under the cursor.
   *
   * Applied on movement rather than on Enter, so a phosphor or CRT preset can be
   * judged by looking at it rather than being committed to unseen.
   */
  /** Advance a child setting to its next value, wrapping. With two values this is a toggle. */
  private advance(child: Setting, e: KeyInput) {
    const i = child.values.indexOf(child.current())
    const next = child.values[(i + 1 + child.values.length) % child.values.length]
    if (next === undefined) { this.opts.onFeedback?.('edge', e); return }
    this.opts.onFeedback?.('apply', e)
    child.select(next)
  }

  private apply(e: KeyInput) {
    const setting = this.opts.settings[this.row]
    const value = setting?.values[this.value]
    if (!setting || value === undefined || this.busy) {
      // The cursor still moved, so the caller reports the movement either way.
      this.opts.onFeedback?.('move', e)
      return
    }

    this.opts.onFeedback?.('apply', e)
    const result = setting.select(value)
    if (typeof result === 'string') return

    this.busy = true
    void result
      .catch(() => { /* the page logs it and the old value stands */ })
      .then(() => {
        this.busy = false
        // Move the cursor to the value that actually took effect, which is not
        // necessarily the one requested: a face that failed to load leaves the
        // previous one in use.
        this.syncValue()
        if (this.term) this.draw(this.term)
      })
  }

  /**
   * Open the control box over this one, where the focused value has one.
   *
   * This box stays on the stack beneath rather than being replaced, so Escape
   * returns to the row it was opened from. setActive is not needed: this screen
   * paints only on a key it consumed, and receives none while covered.
   */
  private open(e: KeyInput): boolean {
    const push = this.opts.push
    if (this.pane !== RIGHT || !push) return false
    const setting = this.opts.settings[this.row]
    const value = setting?.values[this.value]
    if (!setting?.tune || value === undefined) return false
    const spec = setting.tune(value)
    if (!spec) return false

    this.opts.onFeedback?.('pane', e)
    push(new TunePopup({
      ...spec,
      shadow: this.opts.shadow,
      bounds: this.opts.bounds,
      onDone: () => this.opts.pop?.(),
      // 'adjust' is reported as the same kind of event as a value applying here,
      // so the caller has one vocabulary rather than two.
      onFeedback: (kind, ev) =>
        this.opts.onFeedback?.(kind === 'adjust' ? 'apply' : kind, ev),
    }))
    return true
  }

  /** Sized to its contents, centred within `bounds`, clamped to fit. */
  private geometry(term: Grid): Geometry {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const settings = this.opts.settings

    const labelW = settings.reduce((n, s) => Math.max(n, cells(s.label)), 0)
    // Measured across every setting rather than the focused one, so the value
    // column does not resize as the cursor moves down the left pane.
    const valueW = settings.reduce(
      (n, s) => s.values.reduce((m, v) => Math.max(m, cells(v)), n),
      0
    )
    // A group's rows carry their own label and value, so the right pane must
    // also fit the widest of those.
    const childW = settings.reduce(
      (n, s) => (s.children ?? []).reduce(
        (m, c) => Math.max(m, cells(c.label) + GAP + c.values.reduce(
          (k, v) => Math.max(k, cells(v)), 0
        )),
        n
      ),
      0
    )

    // +1 on the left pane for the marker in its last column.
    let leftW = PAD + labelW + GAP + valueW + 1
    let rightW = PAD + Math.max(valueW, childW) + PAD

    // The rules must hold the title and the hint, both inside the frame with a
    // blank either side and an inset of 2 from the corner.
    const need = Math.max(cells(TITLE) + 6, HINT_W + 6)
    const grow = need - (leftW + rightW + 3)
    if (grow > 0) rightW += grow

    const w = Math.min(b.w, leftW + rightW + 3)
    // Reclaim any excess width from the value column first, since the left pane
    // carries two items per row.
    const over = leftW + rightW + 3 - w
    if (over > 0) {
      const off = Math.min(over, rightW - 1)
      rightW -= off
      leftW -= over - off
    }

    const tallest = settings.reduce(
      (n, s) => Math.max(n, s.children?.length ?? s.values.length), 0
    )
    const h = Math.min(
      Math.max(3, b.h),
      Math.min(MAX_ROWS, Math.max(settings.length, tallest)) + 2
    )

    const box: Rect = {
      x: b.x + Math.floor((b.w - w) / 2),
      y: b.y + Math.floor((b.h - h) / 2),
      w,
      h,
    }
    return { box, leftW, rightW, splitX: box.x + 1 + leftW, rows: box.h - 2 }
  }

  /** Keep the cursor visible when a column is taller than the box. */
  private window(index: number, count: number, rows: number): number {
    return Math.max(0, Math.min(index - (rows >> 1), count - rows))
  }

  /**
   * The attribute for the cursor row, which is drawn inverse, so this is the
   * level of the background rather than the text: DIM in the focused pane and
   * FAINT in the other.
   *
   * Both are two levels below where a text cursor would sit. An inverse row is a
   * fill, lighting every pixel of every cell rather than the fifth or so a line
   * of glyphs lights, so at the same level it carries several times the light of
   * the surrounding text. BRIGHT and NORMAL both overexposed against a frame and
   * two panes of NORMAL text. The same argument the FAINT docstring in term.ts
   * makes for the drop shadow applies here.
   *
   * FAINT for the unfocused pane is a full step down, 100 against 150, so it
   * still shows where the cursor is without drawing attention. Either level can
   * be moved along BRIGHT > NORMAL > MUTED > DIM > FAINT; nothing else depends
   * on them.
   *
   * BOLD in both cases: the glyphs in an inverse bar are the unlit pixels, so
   * the smear thickens the text rather than the bar.
   */
  private barAttr(pane: typeof LEFT | typeof RIGHT): number {
    return (this.pane === pane ? DIM : FAINT) | BOLD
  }

  draw(term: Grid) {
    this.term = term
    const { box, leftW, rightW, splitX, rows } = this.geometry(term)
    const settings = this.opts.settings

    // Clear the whole box, borders included, before framing it: box drawing
    // merges line bits with the existing cell, so a border over a rule of the
    // program beneath would merge into a tee rather than covering it. Same note
    // as in select.ts and text.ts.
    clear(term, box)
    if (this.opts.shadow) shadow(term, box, this.opts.bounds)
    frame(term, box)
    // Merges into the top and bottom rules as junctions automatically, which is
    // why box.ts stores lines as direction bits.
    vline(term, splitX, box.y, box.y + box.h - 1)

    // BRIGHT | BOLD, matching every other title: the five popups in tui/ and
    // circ's room name.
    label(term, box, TITLE, { attr: BRIGHT | BOLD })
    label(term, box, HINT, { edge: 'bottom', align: 'right' })

    const top = box.y + 1
    const labelW = settings.reduce((n, s) => Math.max(n, cells(s.label)), 0)

    // Left pane: every setting, and what it is on.
    const firstRow = this.window(this.row, settings.length, rows)
    for (let i = 0; i < rows; i++) {
      const setting = settings[firstRow + i]
      if (!setting) break
      const on = firstRow + i === this.row
      const text = ' '.repeat(PAD)
        + setting.label.padEnd(labelW)
        + ' '.repeat(GAP)
        + setting.current()
      // The marker in the last column indicates the row opens further, and only
      // the open row carries one.
      term.text(
        box.x + 1, top + i,
        (on ? text.padEnd(leftW - 1) + '›' : text).padEnd(leftW).slice(0, leftW),
        on ? this.barAttr(LEFT) : NORMAL,
        on ? 1 : 0
      )
    }

    // Right pane: the focused setting's children if it has any, its values if
    // not. A child row carries its own label and its own value, laid out on the
    // same two-column plan as the left pane.
    const setting = settings[this.row]
    const children = setting?.children
    const childLabelW = (children ?? []).reduce((n, c) => Math.max(n, cells(c.label)), 0)
    const rightRows = children
      ? children.map(c => c.label.padEnd(childLabelW) + ' '.repeat(GAP) + c.current())
      : setting?.values ?? []

    const firstValue = this.window(this.value, rightRows.length, rows)
    for (let i = 0; i < rows; i++) {
      const value = rightRows[firstValue + i]
      if (value === undefined) break
      const on = firstValue + i === this.value
      const text = ' '.repeat(PAD) + value
      // The same marker the open row in the left pane carries. Here it is a
      // property of the value rather than of the cursor, so every tunable row
      // shows one whether or not it is focused, making it visible which row
      // opens further.
      const opens = !children && setting?.tune?.(setting.values[firstValue + i] ?? '')
      term.text(
        splitX + 1, top + i,
        (opens ? text.padEnd(rightW - 1) + '›' : text).padEnd(rightW).slice(0, rightW),
        on ? this.barAttr(RIGHT) : NORMAL,
        on ? 1 : 0
      )
    }

    // Applied last, over everything the box drew. See ground() in box.ts. The
    // control box tune.ts opens above this one applies its own, so the two stack
    // as two lit panels.
    ground(term, box)

    // Nothing here takes input, so the caret is hidden rather than parked on the
    // frame, where the cursor would invert that cell and blink. The stack
    // restores showCursor on pop.
    term.showCursor = false
    term.dirty = true
  }

  /** Run by ScreenStack.pop() after the grid underneath is already back. */
  dispose() {
    this.term = null
    this.opts.onGone?.()
  }
}

/**
 * The F1 box and the state the faceplate holds for it.
 *
 * SettingsScreen above is unchanged from the original. This holds the settings,
 * pushes and pops the control box over it, and dispatches keys one at a time.
 *
 * Uses the same stack a program's modals use, which is what allows the control
 * box to close: push snapshots the planes and pop restores them, so closing a
 * box larger than the one beneath leaves nothing behind.
 */
export class SettingsOverlay {
  open = false
  onChange: (() => void) | null = null
  onFeedback: ((kind: 'move' | 'pane' | 'apply' | 'edge' | 'cancel') => void) | null = null

  private screen: SettingsScreen | null = null
  /** The control box while it is open, the only screen ever pushed above this one. */
  private child: Screen | null = null
  private stack: ScreenStack

  constructor(private term: Grid, private source: () => Setting[]) {
    this.stack = new ScreenStack(term as unknown as StackSurface)
  }

  /**
   * Rebuilt on every open rather than cached: saving a user preset adds a fourth
   * value to SCREEN, which a list read once at construction would never show.
   */
  private build(): SettingsScreen {
    return new SettingsScreen({
      settings: this.source(),
      shadow: true,
      onDone: () => this.hide(),
      onFeedback: kind => this.onFeedback?.(kind),
      push: screen => { this.child = screen; this.stack.push(screen) },
      pop: () => { this.child = null; this.stack.pop() },
    })
  }

  toggle(): void {
    // F1 while the control box is open closes the whole chain in one press.
    if (this.open) { this.hide(); return }
    this.open = true
    this.child = null
    this.screen = this.build()
    this.stack.push(this.screen)
  }

  hide(): void {
    // Unwind whatever is open, innermost first, so every snapshot is restored.
    while (this.stack.active) this.stack.pop()
    this.open = false
    this.child = null
    this.screen = null
    this.term.dirty = true
  }

  draw(): void {
    if (!this.open) return
    this.screen?.draw(this.term)
    this.child?.draw?.(this.term)
  }

  /** True for a key the box plays its own sound for. */
  silentKey(e: KeyInput): boolean {
    const top = this.child ?? this.screen
    return !!top?.silentKey?.(e)
  }

  /** Handle a key while open. Every key is swallowed, since the machine is covered. */
  key(e: KeyInput): boolean {
    if (!this.open) return false
    if (e.key === 'F1') { this.hide(); return true }
    const top = this.child ?? this.screen
    top?.onKey(e)
    this.draw()
    return true
  }
}
