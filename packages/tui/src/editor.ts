// A centred modal for typing more than one line: a frame, a caret and a
// TextBuffer that scrolls inside a fixed-size box.
//
// The box does not grow with the text. A modal that resized under the caret
// would move the row about to be typed on, so the size is fixed from the first
// frame and the text scrolls, as in PromptPopup.

import { BRIGHT, BOLD } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { clear, frame, ground, label, shadow, type Rect } from './box.js'
import { TextBuffer, drawBuffer } from './buffer.js'
import type { TextLabel } from './text.js'

export interface EditorOptions {
  title: string
  /** Opening text, caret at the start. Absent means empty. */
  initial?: string
  /** Set into the top rule at the right: what is being written, or to whom. */
  note?: TextLabel
  /**
   * The finished text, or null when the reader backed out. The caller pops.
   * Called only after the confirm question, when one is configured. In editor
   * mode (see onSave) it is called with null only, meaning leave.
   */
  onDone: (text: string | null) => void
  /**
   * Save without closing. Given, the box is an editor: ^O, ^S and ^D hand the
   * text over and the box stays; ^X and Escape ask the caller to leave; ^C is
   * not a way out. Absent, the box is a composer: ^S and ^D submit and close,
   * ^C and Escape cancel.
   */
  onSave?: (text: string) => void
  /** The widget plays no sound itself. `reject` is a refused key. */
  onFeedback?: (kind: 'edge' | 'submit' | 'cancel' | 'reject', e?: KeyInput) => void
  /** Shown in the bottom rule while editing. */
  hint?: TextLabel
  /**
   * Question shown in place of the hint before the text is handed back.
   * Y submits, N or Escape returns to the text. Without it a submit key posts
   * at once.
   */
  confirm?: string
  bounds?: Rect
  shadow?: boolean
  /** Characters. Beyond it a key is refused rather than truncating. */
  maxLength?: number
  /** Rows of text and columns of it. The box is this size regardless. */
  rows?: number
  width?: number
  /** Fold long lines to the width. Default on. */
  wrap?: boolean
}

const DEFAULTS = { rows: 8, width: 56, maxLength: 4096 }
/** Blank columns either side of the text. */
const PAD = 2

export class EditorPopup implements Screen {
  private buf: TextBuffer
  /** True while the confirm question is up and owns the keyboard. */
  private asking = false
  /** The text as last saved, for `modified`. Trimmed, as a save would write it. */
  private clean: string
  /** One line in place of the hint until the next key. See say(). */
  private status: string | null = null

  constructor(private opts: EditorOptions) {
    this.buf = new TextBuffer({
      initial: opts.initial,
      maxLength: opts.maxLength ?? DEFAULTS.maxLength,
      wrap: opts.wrap,
      width: opts.width ?? DEFAULTS.width,
      onReject: () => this.opts.onFeedback?.('reject'),
    })
    this.clean = this.finished()
  }

  /** The text as it would be handed over: outer whitespace removed. */
  private finished(): string {
    return this.buf.text.trim()
  }

  /** Whether the buffer differs from what was last saved. */
  get modified(): boolean {
    return this.finished() !== this.clean
  }

  /** `text` reached storage: the buffer is no longer modified. */
  markSaved(text: string): void {
    this.clean = text
  }

  /** Report one thing in the bottom rule. The next key clears it. */
  say(message: string | null): void {
    this.status = message
  }

  onKey(e: KeyInput): boolean {
    this.status = null
    if (e.metaKey || e.altKey) return false
    if (this.asking) return this.answer(e)

    if (e.ctrlKey) {
      if (this.opts.onSave) {
        if (e.key === 'o') { this.submit(e); return true }
        if (e.key === 'x') { this.cancel(e); return true }
      }
      if (e.key === 's' || e.key === 'd') { this.submit(e); return true }
      if (e.key === 'c') {
        if (this.opts.onSave) return false
        this.cancel(e)
        return true
      }
      if (e.key === 'k') return this.buf.killLine()
      return false
    }

    if (e.key === 'Escape') { this.cancel(e); return true }
    return this.buf.key(e)
  }

  private answer(e: KeyInput): boolean {
    if (e.key === 'y' || e.key === 'Y') {
      this.asking = false
      this.opts.onFeedback?.('submit', e)
      this.opts.onDone(this.finished())
      return true
    }
    if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
      this.asking = false
      this.opts.onFeedback?.('cancel', e)
      return true
    }
    // Other keys are consumed: the program underneath must not act on them.
    return true
  }

  private submit(e: KeyInput): void {
    if (!this.buf.text.trim()) { this.opts.onFeedback?.('reject', e); return }
    if (this.opts.onSave) {
      this.opts.onFeedback?.('submit', e)
      this.opts.onSave(this.finished())
      return
    }
    if (!this.opts.confirm) {
      this.opts.onFeedback?.('submit', e)
      this.opts.onDone(this.finished())
      return
    }
    this.asking = true
  }

  private cancel(e: KeyInput): void {
    this.opts.onFeedback?.('cancel', e)
    this.opts.onDone(null)
  }

  /** Fixed size, centred in `bounds`, clamped to it. */
  private rect(term: Grid): Rect {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const inner = this.opts.width ?? DEFAULTS.width
    const rows = this.opts.rows ?? DEFAULTS.rows
    const w = Math.min(Math.max(20, b.w - 4), inner + PAD * 2 + 2)
    const h = Math.min(Math.max(3, b.h - 2), rows + 2)
    return {
      x: b.x + Math.floor((b.w - w) / 2),
      y: b.y + Math.floor((b.h - h) / 2),
      w,
      h,
    }
  }

  draw(term: Grid): void {
    const r = this.rect(term)

    // Blanked before framing: box drawing merges with the cell beneath, so a
    // border over the program's own rule would fuse into a tee.
    clear(term, r)
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)

    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    if (this.opts.note) label(term, r, this.opts.note, { align: 'right' })

    const foot = this.asking ? this.opts.confirm : (this.status ?? this.opts.hint)
    if (foot) label(term, r, foot, { edge: 'bottom', align: 'right' })

    const width = inner.w - PAD * 2
    drawBuffer(term, this.buf, { x: inner.x + PAD, y: inner.y, w: width, h: inner.h })

    ground(term, r)
    term.showCursor = !this.asking
  }
}
