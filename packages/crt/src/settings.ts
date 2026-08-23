// The settings screen — one box for everything the machine can be told about
// itself.
//
// Before this there were five F-keys, one per setting, each cycling its own
// list blind: you pressed F9 and the phosphor became whatever was next, and the
// only way to learn what else was on offer was to keep pressing until it came
// round again. That does not survive a sixth setting, and it was already at
// five. F11 stayed a key, because fullscreen is an action rather than a
// setting and the binding has to be taken off the browser to keep Escape.
//
// Two panes. The left is the settings and what each is currently on; the right
// is the values of the one you are standing on. Left and right move BETWEEN the
// panes, up and down move WITHIN whichever has focus, and a value applies the
// moment you land on it — every setting in here is judged by looking at it, so
// previewing and choosing have to be the same act. There is nothing to confirm
// and so nothing to cancel: Escape means "done looking", not "put it back".
//
// The settings themselves are DATA supplied by the page. The engine has never
// known what a phosphor is or where a preference is written down — the session
// goes through stores/terminal.ts, chat and the feed go through injected
// services — and a settings screen is not the place to start teaching it. See
// SettingsSource.

import {
  cells, clear, frame, ground, keyHint, label, shadow, vline, TunePopup, ScreenStack,
  NORMAL, BRIGHT, BOLD, DIM, FAINT,
  type Grid, type Rect, type Screen, type KeyInput, type TuneSpec, type StackSurface,
} from '@cyberspace/tui'

/** One thing a member can change. */
export interface Setting {
  /** Left-pane label. Short and upper case — FONT, PHOSPHOR. */
  label: string
  /** The values on offer, in the order they are shown. */
  values: string[]
  /**
   * Which one is live.
   *
   * A getter rather than a value because the truth is not the screen's: the
   * `phosphor` command changes the phosphor from the shell, and a member who
   * saves a CRT preset grows the list of them. Read on every draw, so the box
   * cannot go stale behind its own back.
   */
  current(): string
  /**
   * Apply one, and answer with what actually took.
   *
   * Async and fallible because of the font: switching face fetches and parses
   * a BDF, and a fetch that fails leaves the old face up. Everything else here
   * answers immediately and simply returns a string.
   */
  select(value: string): string | Promise<string>
  /**
   * Settings of its own, instead of values.
   *
   * The right pane then lists these with what each is on, and Enter advances
   * the one under the cursor to its next value — which for a two-value child is
   * a toggle. AUDIO is the case it exists for: background, keys and beeps are
   * three independent switches, not three alternatives, and a row that offered
   * them as a list of values would be claiming you can only have one.
   *
   * `values`/`select` are ignored where this is present; `current()` still is
   * not, because the left pane has to say something about the group as a whole.
   */
  children?: Setting[]
  /**
   * A value that opens a box of its own instead of being the end of the road.
   *
   * Null for values that do not, which is nearly all of them — `user` under
   * SCREEN is the only one today, because it is the only value that is not one
   * of a fixed set of alternatives but a set of knobs the member owns. A phosphor
   * has nothing inside it.
   *
   * Per VALUE rather than per setting for that reason: the other three screens
   * are presets and there is nothing to turn.
   */
  tune?(value: string): TuneSpec | null
}

/**
 * Where the settings come from, supplied by the page the way ChatService and
 * ProgramStore are.
 *
 * A call rather than an array for the same reason `current` is a getter: the
 * list itself moves. Saving a user CRT preset adds a fourth value to SCREEN,
 * and a source read once at construction would never show it.
 */
export interface SettingsSource {
  settings(): Setting[]
}

export interface SettingsOptions {
  settings: Setting[]
  /** Dismissed. The caller pops — see Shell.toggleSettings. */
  onDone(): void
  /**
   * Off the stack, by any route — `onDone`'s pop, or the drain in
   * `Shell.dispose()` on unmount. What resolves the `config` command, which
   * has to keep the prompt back until the box is actually gone.
   *
   * Deliberately distinct from `onDone`: that one is a request to close and
   * must pop, this one is the news that it closed and must not, or it would
   * re-enter the pop that called it.
   */
  onGone?(): void
  /**
   * Sounds the widget has an opinion about; it makes none of its own. Not the
   * keyclick — that is played once per key by the page, and a widget adding
   * another would double it. See SelectOptions.onFeedback.
   */
  onFeedback?(
    kind: 'move' | 'pane' | 'apply' | 'edge' | 'cancel',
    e: KeyInput
  ): void
  /** Region to centre within. Defaults to the whole grid. */
  bounds?: Rect
  /** Lay a drop-shadow under the box. See `shadow` in tui/box.ts. */
  shadow?: boolean
  /**
   * Put a screen on top of this one, and take it off again — the stack this
   * screen is itself on, handed over as two calls rather than as the stack
   * itself, because the only thing in here that is allowed to touch it is the
   * knob box and it needs exactly these two.
   *
   * Without them a tunable value simply does not open; the box degrades to what
   * it was.
   */
  push?(screen: Screen): void
  pop?(): void
}

// CONFIG, not SETTINGS: it is what the boot message points at and what the
// command that opens the same box is called, and a box that introduces a third
// word for itself is a box you have to learn twice.
const TITLE = 'CONFIG'
/** Blank columns at the left of either pane. */
const PAD = 2
/** Between a label and its current value in the left pane. */
const GAP = 2

/**
 * Most rows the box will grow to before the panes start scrolling instead.
 *
 * Without a cap the height comes from the longest list, and the font list is
 * open-ended — the box would grow until it filled the tube top to bottom and
 * stopped reading as a box laid over the machine. `window()` was already doing
 * the scrolling; this is what makes it earn its keep.
 */
const MAX_ROWS = 12

/**
 * Plain text, not keycaps: the inverse cap is the app frame's voice and this is
 * a box that borrows the screen for a moment. Same rule as feed's POPUP_HINT.
 *
 * `⬆⬇` and `↵` are the same glyphs cIRC and feed hint with, and they are safe
 * on any face because `bdf.ts` now SYNTHESISES them for any cell rather than
 * carrying a hand-drawn set per size. Before that they came out as `?` on every
 * face that was not a Spleen — checked against the parser, not assumed.
 *
 * `‹›` (U+2039/203A) is there because there is no leftwards arrow anywhere in
 * this — not in a face, not in the synthesised set — and `<>` reads as markup.
 * It is present in every face on offer, and one that lacked it would have lost
 * the border this sits in first.
 *
 * This is the screen where getting it wrong shows most: it is where the face
 * gets switched, so a hint built on a codepoint the new face lacks breaks in
 * front of the person switching to it. A missing glyph renders as `?` and
 * nothing warns you.
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
   * An async `select` in flight. Only the font has one, and only the first
   * press of it — the face is parsed once and kept. Without this a held-down
   * arrow starts a second fetch on top of the first, which is the guard
   * `switchingFont` gave F7.
   */
  private busy = false
  /**
   * The grid, kept from the last draw so an async select can repaint when it
   * lands. Nothing else would: the stack repaints on a consumed key, and by
   * the time a font resolves that key is long gone — the left pane would sit
   * showing the face it used to be on.
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
   * Park the right pane. On the value that is live for a plain setting; on the
   * first child for a group, since none of a group's children is "the" one.
   */
  private syncValue() {
    const setting = this.focused
    if (!setting || setting.children) { this.value = 0; return }
    const i = setting.values.indexOf(setting.current())
    // -1 for a live value that is not in the list at all, which should not
    // happen and is not worth crashing over. The top of the list is a
    // defensible place to stand.
    this.value = i < 0 ? 0 : i
  }

  /**
   * The four keys that always answer with onFeedback, so the movement is the
   * sound and the keyclick would only double it. The modifier checks mirror
   * onKey's: a combo handed back to the browser is not a key we answer.
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
      // A ring in both panes, as SelectPopup is: one arrow held down reaches
      // everything and neither end is a dead stop.
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
      // A group's children are switches, not alternatives: moving between them
      // must not turn anything on, or you could not walk past one to reach the
      // next. Enter is what changes a child.
      if (!setting?.children) this.apply(e)
      else this.opts.onFeedback?.('move', e)
      return true
    }

    // Enter is the same key as Right in the left pane — a list you can step
    // into should answer the key that means "into" everywhere else in here.
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      if (this.pane === LEFT) {
        if (!this.rightCount) { this.opts.onFeedback?.('edge', e); return true }
        this.pane = RIGHT
        this.opts.onFeedback?.('pane', e)
        return true
      }
      // A value that opens further answers BOTH keys, before either of their
      // usual meanings. Right, because right has meant "into" everywhere else
      // in this box and a dead edge on the one row that has somewhere to go
      // would be the exception; Enter, because a list you can step into should
      // answer the key that means "into" as well.
      if (this.open(e)) return true
      if (e.key === 'Enter') {
        // In a group, Enter is the switch — the only thing in here that has to
        // be pressed rather than moved onto.
        const child = setting?.children?.[this.value]
        if (child) { this.advance(child, e); return true }
        // Otherwise the value has been live since you landed on it, so this is
        // agreeing with what is already on screen.
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
   * Put the value under the cursor on the machine.
   *
   * The value is applied on the way past rather than on Enter, which is the
   * whole point of the screen: a phosphor and a CRT preset are things you
   * decide about by looking at them, and a picker that made you commit before
   * showing you anything would be worse than the F-key it replaced.
   */
  /** Step a child setting to its next value, wrapping. Two values is a toggle. */
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
      // Still moved the cursor; the caller hears the move either way.
      this.opts.onFeedback?.('move', e)
      return
    }

    this.opts.onFeedback?.('apply', e)
    const result = setting.select(value)
    if (typeof result === 'string') return

    this.busy = true
    void result
      .catch(() => { /* the page logs it; the old value simply stands */ })
      .then(() => {
        this.busy = false
        // Park the cursor on what actually took, which is not necessarily what
        // was asked for — a face that failed to load leaves the old one up,
        // and a bar sitting on the name of a font that is not on screen would
        // be the screen lying about the machine.
        this.syncValue()
        if (this.term) this.draw(this.term)
      })
  }

  /**
   * Open the knob box over this one, if the value under the cursor has one.
   *
   * This box stays on the stack underneath rather than being replaced: Escape in
   * there comes back to the row it was opened from, which is the only thing
   * "back" can sensibly mean. Nothing needs `setActive` — this screen paints
   * only on a key it consumed, and while the knob box is on top it sees none.
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
      // 'adjust' is a knob turning, which is the same kind of event as a value
      // landing in here — one mapping rather than a second vocabulary for the
      // caller to answer.
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
    // Measured across EVERY setting rather than the one in focus: a value
    // column that resized as you moved down the left pane would make the whole
    // box jump about under a cursor that only went down one row.
    const valueW = settings.reduce(
      (n, s) => s.values.reduce((m, v) => Math.max(m, cells(v)), n),
      0
    )
    // A group's rows carry a label and a value of their own, so the right pane
    // has to be wide enough for the widest of those too.
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

    // The rules have to hold the title and the hint, both of which sit inside
    // the frame with a blank either side and an inset of 2 from the corner.
    const need = Math.max(cells(TITLE) + 6, HINT_W + 6)
    const grow = need - (leftW + rightW + 3)
    if (grow > 0) rightW += grow

    const w = Math.min(b.w, leftW + rightW + 3)
    // Give back what would not fit, from the value column first — the left
    // pane is the one carrying two things per row.
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

  /**
   * Keep the cursor on screen when a column is taller than the box. Neither
   * list is anywhere near 23 rows today; both will be one day, and a window
   * that only appears once the list is too long is invisible until then.
   */
  private window(index: number, count: number, rows: number): number {
    return Math.max(0, Math.min(index - (rows >> 1), count - rows))
  }

  /**
   * The attribute the cursor row is drawn with. It is drawn inverse, so this is
   * the level of the BAR rather than of the text in it: DIM in the pane with
   * focus, FAINT in the other one.
   *
   * Both are two tiers below where a cursor bar would sit if it were text, and
   * deliberately: an inverse row is a FILL, lighting every pixel of every cell it
   * covers rather than the fifth or so a line of glyphs does, so it carries
   * several times the light of the words around it at the same level. BRIGHT
   * blew out against a frame and two panes of NORMAL text; NORMAL still did.
   * The floor that protects a stroke is the wrong floor for a filled field —
   * which is the whole argument the FAINT docstring in term.ts makes for the
   * drop shadow, and it applies here for the same reason.
   *
   * FAINT for the pane without focus is a real step down rather than a notch:
   * 100 against 150, so the pane you are not in reads as somewhere the cursor
   * still is without asking to be looked at. Nudge either tier by moving it
   * along BRIGHT > NORMAL > MUTED > DIM > FAINT; nothing else depends on it.
   *
   * BOLD either way. The glyphs in an inverse bar are the unlit pixels, so the
   * smear thickens the WORD rather than the bar, which is what carries the row
   * now that the bar itself is no longer shouting.
   */
  private barAttr(pane: typeof LEFT | typeof RIGHT): number {
    return (this.pane === pane ? DIM : FAINT) | BOLD
  }

  draw(term: Grid) {
    this.term = term
    const { box, leftW, rightW, splitX, rows } = this.geometry(term)
    const settings = this.opts.settings

    // Blank the whole box, borders included, BEFORE framing it: box drawing
    // merges line bits with what is already in the cell, so a border laid over
    // a rule of the program underneath would fuse with it into a tee rather
    // than cover it. Same note as in select.ts and text.ts.
    clear(term, box)
    if (this.opts.shadow) shadow(term, box, this.opts.bounds)
    frame(term, box)
    // Merges into the top and bottom rules as ┬ and ┴ on its own — the whole
    // reason box.ts stores lines as direction bits.
    vline(term, splitX, box.y, box.y + box.h - 1)

    // BRIGHT | BOLD, as every other title in the machine is drawn — the five
    // popups in tui/ and cIRC's room name. A box that named itself in a
    // different weight to all of them would read as a different kind of thing.
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
      // The marker in the last column says which way this row opens, and only
      // the row that is open gets one.
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
      // The same marker the open row in the left pane wears, and for the same
      // reason: it says which way the row opens. Here it is the value's own
      // property rather than the cursor's, so every tunable row carries one
      // whether or not it is the one in focus — a member has to be able to SEE
      // that `user` is the row with something inside it.
      const opens = !children && setting?.tune?.(setting.values[firstValue + i] ?? '')
      term.text(
        splitX + 1, top + i,
        (opens ? text.padEnd(rightW - 1) + '›' : text).padEnd(rightW).slice(0, rightW),
        on ? this.barAttr(RIGHT) : NORMAL,
        on ? 1 : 0
      )
    }

    // Last, over everything the box just drew. See `ground` in box.ts. The knob
    // box `tune.ts` opens on top of this one grounds itself the same way, so
    // the two stack as two lit panels rather than one with a hole in it.
    ground(term, box)

    // Nothing to type into, so there should be no caret. Parking it on the
    // frame does not hide it — the cursor stamp inverts whatever cell it lands
    // on, so it shows up as a blinking corner. The stack gives showCursor back
    // on pop.
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
 * F1, and what the faceplate holds.
 *
 * The screen above is the original's, unchanged. This is the half the host used
 * to do by hand: hold the settings, put the knob box on top of the settings box
 * and take it off again, and answer one key at a time.
 *
 * The stack is the same one a program's modals use. It is what makes the knob
 * box able to come down: push snapshots the planes and pop puts them back, so
 * closing a box that was bigger than the one underneath does not leave the
 * difference on the glass.
 */
export class SettingsOverlay {
  open = false
  onChange: (() => void) | null = null
  onFeedback: ((kind: 'move' | 'pane' | 'apply' | 'edge' | 'cancel') => void) | null = null

  private screen: SettingsScreen | null = null
  /** The knob box, while it is up. The only thing that ever sits on top. */
  private child: Screen | null = null
  private stack: ScreenStack

  constructor(private term: Grid, private source: () => Setting[]) {
    this.stack = new ScreenStack(term as unknown as StackSurface)
  }

  /**
   * Built on every open rather than held: saving a user preset adds a fourth
   * value to SCREEN, and a list read once at construction would never show it.
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
    // F1 under the knob box drops the whole chain in one press, rather than
    // leaving a settings box stranded under a box with no way back to it.
    if (this.open) { this.hide(); return }
    this.open = true
    this.child = null
    this.screen = this.build()
    this.stack.push(this.screen)
  }

  hide(): void {
    // Unwind whatever is up, innermost first, so every snapshot is put back.
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

  /** True for a key the box answers with a sound of its own. */
  silentKey(e: KeyInput): boolean {
    const top = this.child ?? this.screen
    return !!top?.silentKey?.(e)
  }

  /** Handle a key while open. Everything is swallowed: the machine is covered. */
  key(e: KeyInput): boolean {
    if (!this.open) return false
    if (e.key === 'F1') { this.hide(); return true }
    const top = this.child ?? this.screen
    top?.onKey(e)
    this.draw()
    return true
  }
}
