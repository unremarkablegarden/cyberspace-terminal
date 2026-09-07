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
import { wordLeft, wordRight, selRange } from './edits.js'
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
  /** Drawn in place of every character, as a password field does with `*`. */
  mask?: string
  /** Called when a keystroke is refused. */
  onReject?: () => void
  /** Write the selected text to the clipboard, for copy and cut. */
  clipboard?: (text: string) => void
}

export class InputLine {
  private text = ''
  /** Caret offset within `value`, 0..value.length. */
  private pos = 0
  /** Other end of the selection, or null when nothing is selected. */
  private anchor: number | null = null
  /** First visible character, when the value is wider than the field. */
  private off = 0
  private prompt: string
  private maxLength: number
  private placeholder: string
  private mask?: string
  private onReject?: () => void
  private clipboard?: (text: string) => void

  constructor(opts: InputOptions = {}) {
    this.prompt = opts.prompt ?? '> '
    this.maxLength = opts.maxLength ?? 2048
    this.placeholder = opts.placeholder ?? ''
    this.mask = opts.mask
    this.onReject = opts.onReject
    this.clipboard = opts.clipboard
  }

  /** The selection low/high, or null. */
  private sel(): [number, number] | null {
    return selRange(this.anchor, this.pos)
  }

  /** Move the caret to `to`; a shifted move extends the selection, a plain one drops it. */
  private move(to: number, shift: boolean): void {
    to = Math.max(0, Math.min(to, this.text.length))
    if (shift) {
      if (this.anchor === null) this.anchor = this.pos
      this.pos = to
    } else {
      this.anchor = null
      this.pos = to
    }
  }

  /** Delete the selection if there is one; returns whether it removed anything. */
  private deleteSel(): boolean {
    const s = this.sel()
    if (!s) return false
    this.text = this.text.slice(0, s[0]) + this.text.slice(s[1])
    this.pos = s[0]
    this.anchor = null
    return true
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
    this.anchor = null
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
    // Paste over a selection replaces it, as typing does.
    this.deleteSel()

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
    const shift = e.shiftKey
    // Ctrl held with an arrow moves and selects by word; the host sends the same
    // sequence for Alt (Option), so both mean word here.
    const word = e.ctrlKey || e.altKey

    // Copy and cut. The host maps cmd+C/cmd+X and ctrl+shift+C/X to this.
    if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'x')) {
      const s = this.sel()
      if (s) {
        this.clipboard?.(this.text.slice(s[0], s[1]))
        if (e.key === 'x') this.deleteSel()
      }
      return true
    }

    if (e.key === 'ArrowLeft') {
      const s = this.sel()
      if (s && !shift) { this.pos = s[0]; this.anchor = null }
      else this.move(word ? wordLeft(this.text, this.pos) : this.pos - 1, shift)
      return true
    }

    if (e.key === 'ArrowRight') {
      const s = this.sel()
      if (s && !shift) { this.pos = s[1]; this.anchor = null }
      else this.move(word ? wordRight(this.text, this.pos) : this.pos + 1, shift)
      return true
    }

    if (e.key === 'Home') { this.move(0, shift); return true }
    if (e.key === 'End') { this.move(this.text.length, shift); return true }

    // Every other modifier chord belongs to the caller.
    if (e.metaKey || e.ctrlKey || e.altKey) return false

    if (e.key === 'Backspace') {
      if (!this.deleteSel() && this.pos > 0) {
        this.text = this.text.slice(0, this.pos - 1) + this.text.slice(this.pos)
        this.pos--
      }
      return true
    }

    // Forward delete, reachable only because the caret can sit before the end
    // of the line.
    if (e.key === 'Delete') {
      if (!this.deleteSel() && this.pos < this.text.length) {
        this.text = this.text.slice(0, this.pos) + this.text.slice(this.pos + 1)
      }
      return true
    }

    if (e.key.length === 1) {
      // A character the grid cannot hold in one cell misaligns this row, and
      // every row after it once sent. Refused at the keystroke, the only point
      // at which the operator can be told. See plain.ts.
      if (!oneCell(e.key)) {
        this.onReject?.()
        return true
      }
      this.deleteSel()
      if (this.text.length >= this.maxLength) {
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
    this.anchor = null
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

    let visible = this.text.slice(this.off, this.off + width)
    if (this.mask) visible = this.mask.repeat(visible.length)

    term.text(r.x, r.y, this.prompt, BRIGHT)
    // The placeholder occupies the value's position, so the caret sits on its
    // first character and the field reads as empty rather than filled.
    if (!this.text && this.placeholder) {
      term.text(r.x + this.prompt.length, r.y, this.placeholder.slice(0, width), DIM)
    } else {
      const baseX = r.x + this.prompt.length
      term.text(baseX, r.y, visible, NORMAL)
      // Redraw the selected run over the top with the inverse plane set.
      const s = this.sel()
      if (s) {
        const lo = Math.max(0, s[0] - this.off)
        const hi = Math.min(width, s[1] - this.off)
        if (hi > lo) term.text(baseX + lo, r.y, visible.slice(lo, hi), NORMAL, 1)
      }
    }

    term.cx = r.x + this.prompt.length + (this.pos - this.off)
    term.cy = r.y
    term.dirty = true
  }
}
