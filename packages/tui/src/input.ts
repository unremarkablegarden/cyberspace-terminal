// A single-line input with a caret.
//
// Editing matches the command line: arrows, Home/End, and insert and delete at
// the caret, so both places text is typed behave the same way.
//
// The value may be longer than the field, which is a window onto it that
// follows the caret. The window moves only when the caret would otherwise leave
// it, so text stays still while typing in the middle of a long line.
//
// The shell's own line editor (shell.ts) is separate: it adds history and
// completion and writes to the grid rather than to a rect. This is the widget
// for programs.

import { NORMAL, BRIGHT, DIM } from './attrs.js'
import { oneCell } from './plain.js'
import type { Grid } from './surface.js'
import type { Rect } from './box.js'
import type { KeyInput } from './keys.js'

export interface InputOptions {
  prompt?: string
  maxLength?: number
  /**
   * Placeholder shown DIM in an empty field, cleared as soon as anything is
   * typed. DIM rather than NORMAL, which would read as an entered value.
   */
  placeholder?: string
  /** Called when a keystroke is refused. */
  onReject?: () => void
}

export class InputLine {
  private text = ''
  /** Caret offset within `value`, 0..value.length. */
  private pos = 0
  /** First visible character, when the value is wider than the field. */
  private off = 0
  private prompt: string
  private maxLength: number
  private placeholder: string
  private onReject?: () => void

  constructor(opts: InputOptions = {}) {
    this.prompt = opts.prompt ?? '> '
    this.maxLength = opts.maxLength ?? 2048
    this.placeholder = opts.placeholder ?? ''
    this.onReject = opts.onReject
  }

  /** The current value. Read-only from outside; use set(). */
  get value() {
    return this.text
  }

  /**
   * Replace the whole value, as a completion does. The caret moves to the end
   * unless a position is given.
   *
   * A method rather than a writable field, because the caret is an offset into
   * the value and the two must move together: assigning the text alone leaves
   * the caret at the old offset, which is how completing `@jon` to `@jonny` left
   * it after the first `n`.
   */
  set(next: string, pos = next.length) {
    this.text = next.slice(0, this.maxLength)
    this.pos = Math.max(0, Math.min(pos, this.text.length))
  }

  /**
   * Insert a run of text at the caret, as a paste does. Text beyond the limit is
   * trimmed and the refusal is sounded, as for a single character.
   *
   * Returns false only when there was nothing to insert, so a caller can let the
   * browser handle an empty clipboard.
   */
  insert(text: string): boolean {
    if (!text) return false

    const room = this.maxLength - this.text.length
    if (room <= 0) {
      this.onReject?.()
      return true
    }

    const chunk = text.slice(0, room)
    if (chunk.length < text.length) this.onReject?.()
    this.text = this.text.slice(0, this.pos) + chunk + this.text.slice(this.pos)
    this.pos += chunk.length
    return true
  }

  /** True if the key was consumed. Enter and Escape are left to the caller. */
  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false

    if (e.key === 'ArrowLeft') {
      if (this.pos > 0) this.pos--
      return true
    }

    if (e.key === 'ArrowRight') {
      if (this.pos < this.text.length) this.pos++
      return true
    }

    if (e.key === 'Home') {
      this.pos = 0
      return true
    }

    if (e.key === 'End') {
      this.pos = this.text.length
      return true
    }

    if (e.key === 'Backspace') {
      if (this.pos > 0) {
        this.text = this.text.slice(0, this.pos - 1) + this.text.slice(this.pos)
        this.pos--
      }
      return true
    }

    // Forward delete, reachable only because the caret can sit before the end
    // of the line.
    if (e.key === 'Delete') {
      if (this.pos < this.text.length) {
        this.text = this.text.slice(0, this.pos) + this.text.slice(this.pos + 1)
      }
      return true
    }

    if (e.key.length === 1) {
      // A character the grid cannot hold in one cell misaligns this row, and
      // every row after it once sent. Refused at the keystroke, the only point
      // at which the operator can be told. See plain.ts.
      if (this.text.length >= this.maxLength || !oneCell(e.key)) {
        this.onReject?.()
        return true
      }
      this.text = this.text.slice(0, this.pos) + e.key + this.text.slice(this.pos)
      this.pos++
      return true
    }

    return false
  }

  clear() {
    this.text = ''
    this.pos = 0
    this.off = 0
  }

  /**
   * Paint into `r`, using one row, and place the hardware cursor on the caret so
   * the terminal's blink appears in the right place.
   */
  draw(term: Grid, r: Rect) {
    for (let x = r.x; x < r.x + r.w; x++) term.put(x, r.y, 32)

    const width = Math.max(1, r.w - this.prompt.length)

    // Scroll only far enough to bring the caret back into the field. width - 1
    // because the caret needs its own cell one past the last character.
    if (this.pos < this.off) this.off = this.pos
    if (this.pos > this.off + width - 1) this.off = this.pos - width + 1
    // Never so far that the field is padded with blanks on the right, which a
    // shrinking value would otherwise leave.
    this.off = Math.max(0, Math.min(this.off, Math.max(0, this.text.length - width + 1)))

    const visible = this.text.slice(this.off, this.off + width)

    term.text(r.x, r.y, this.prompt, BRIGHT)
    // The placeholder occupies the value's position, so the caret sits on its
    // first character and the field reads as empty rather than filled.
    if (!this.text && this.placeholder) {
      term.text(r.x + this.prompt.length, r.y, this.placeholder.slice(0, width), DIM)
    } else {
      term.text(r.x + this.prompt.length, r.y, visible, NORMAL)
    }

    term.cx = r.x + this.prompt.length + (this.pos - this.off)
    term.cy = r.y
    term.dirty = true
  }
}
