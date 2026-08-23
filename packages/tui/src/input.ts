// A single-line input, with a caret.
//
// Editing behaves the way the command line does — arrows, Home/End, insert and
// delete at the caret — because there is no good reason for the two places you
// type in this machine to disagree about what Left does.
//
// The value can be longer than the field, so the field is a window onto it that
// follows the caret. The window only moves when the caret would otherwise leave
// it, which is what keeps the text still while you type in the middle of a long
// line instead of shuffling it under your eyes.
//
// The shell's own line editor (shell.ts) is a different thing: it also has
// history and completion, and is wired straight to the grid rather than to a
// rect. This is the widget for programs.

import { NORMAL, BRIGHT, DIM } from './attrs.js'
import { oneCell } from './plain.js'
import type { Grid } from './surface.js'
import type { Rect } from './box.js'
import type { KeyInput } from './keys.js'

export interface InputOptions {
  prompt?: string
  maxLength?: number
  /**
   * Shown DIM in the empty field, and gone the moment anything is typed.
   *
   * Furniture, so it takes the beam level furniture takes — a placeholder at
   * NORMAL is a value, and a field that already looks filled in is one nobody
   * types into.
   */
  placeholder?: string
  /** Rings when a keystroke is refused. */
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

  /** What has been typed. Read-only from outside — see set(). */
  get value() {
    return this.text
  }

  /**
   * Replace the line wholesale, as a completion does. The caret lands at the
   * end unless told otherwise, which is where someone who just accepted a
   * completion expects to carry on typing.
   *
   * A setter rather than a writable field: the caret is an offset INTO the
   * value, so the two have to move together. Assigning the text on its own
   * leaves the caret parked at whatever offset the old value put it — which is
   * exactly the bug where completing `@jon` to `@jonny` left the cursor sitting
   * after the first `n`.
   */
  set(next: string, pos = next.length) {
    this.text = next.slice(0, this.maxLength)
    this.pos = Math.max(0, Math.min(pos, this.text.length))
  }

  /**
   * Drop a run of text in at the caret — a paste, or anything else arriving all
   * at once. Whatever will not fit is trimmed and refused audibly, the same as
   * one character too many is.
   *
   * Returns false only when there was nothing to insert, so a caller can leave
   * an empty clipboard to the browser.
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

  /** True if the key was consumed. Enter and Escape are the caller's business. */
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

    // Forward delete. Only reachable now that the caret can leave the end of
    // the line, which is why it did not exist before.
    if (e.key === 'Delete') {
      if (this.pos < this.text.length) {
        this.text = this.text.slice(0, this.pos) + this.text.slice(this.pos + 1)
      }
      return true
    }

    if (e.key.length === 1) {
      // A character the grid cannot hold in one cell tears the row it is typed
      // into, and every row after it once it is sent. Refused at the key, which
      // is the only place the operator can be told. See plain.ts.
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
   * Paint into `r` (one row is used) and park the hardware cursor on the caret,
   * so the shell's blink lands in the right place.
   */
  draw(term: Grid, r: Rect) {
    for (let x = r.x; x < r.x + r.w; x++) term.put(x, r.y, 32)

    const width = Math.max(1, r.w - this.prompt.length)

    // Scroll only as far as it takes to bring the caret back into the field.
    // The caret needs a cell of its own at the end of the value, hence the
    // width - 1: it can sit one past the last character.
    if (this.pos < this.off) this.off = this.pos
    if (this.pos > this.off + width - 1) this.off = this.pos - width + 1
    // And never so far that the field is padded out with blanks on the right,
    // which is what a shrinking value would otherwise leave behind.
    this.off = Math.max(0, Math.min(this.off, Math.max(0, this.text.length - width + 1)))

    const visible = this.text.slice(this.off, this.off + width)

    term.text(r.x, r.y, this.prompt, BRIGHT)
    // The placeholder sits where the value would, so the caret lands on its
    // first character rather than beside it — which is what says the field is
    // empty and waiting rather than holding those words.
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
