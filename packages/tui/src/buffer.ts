// An editable text buffer: one string, one caret index, and a fold.
//
// The model is a single string with a single caret index into it, not an array
// of lines. Row breaks, the caret's row and the behaviour of Up all follow from
// folding that string to the width, so the wrap and the caret cannot disagree
// about where a character is. Hard newlines are ordinary characters in the
// string, inserted by Enter.

import { Surface, type Rect } from './surface.js'
import { NORMAL } from './attrs.js'
import type { KeyInput } from './keys.js'

/** One drawn row of the folded text: its start offset and length. */
export interface Fold { start: number; len: number }

/**
 * Fold a string to `width`, keeping every character. The caret indexes the same
 * string, so dropping the spaces broken on would misplace it.
 *
 * Breaks at the last space in the window where there is one, and that space
 * stays on the row it ended. A hard line always produces at least one row, so
 * an empty line is a row the caret can occupy.
 */
export function fold(text: string, width: number, wrap = true): Fold[] {
  const rows: Fold[] = []
  let base = 0

  for (const line of text.split('\n')) {
    if (!wrap) {
      rows.push({ start: base, len: line.length })
      base += line.length + 1
      continue
    }
    let i = 0
    do {
      let take = Math.min(width, line.length - i)
      if (i + take < line.length) {
        const space = line.slice(i, i + take + 1).lastIndexOf(' ')
        if (space > 0) take = space + 1
      }
      rows.push({ start: base + i, len: take })
      i += take
    } while (i < line.length)
    base += line.length + 1
  }
  return rows
}

export interface BufferOptions {
  initial?: string
  /** Maximum length in characters. Beyond it a key is refused rather than truncating. */
  maxLength?: number
  /** Fold long lines to the width. When off, the buffer has a hard right edge. */
  wrap?: boolean
  width?: number
  /** Called when a key could not act: the caret is at an end, or a limit was hit. */
  onReject?: () => void
}

const DEFAULT_MAX = 65536
const DEFAULT_WIDTH = 56

export class TextBuffer {
  private str: string
  private at = 0
  /** First visible row of the folded text. Owned by the caller that draws. */
  top = 0
  private cols = 0

  constructor(private opts: BufferOptions = {}) {
    this.str = opts.initial ?? ''
  }

  get text(): string {
    return this.str
  }

  get caret(): number {
    return this.at
  }

  get width(): number {
    return this.cols || (this.opts.width ?? DEFAULT_WIDTH)
  }

  /** Set by draw() to the number of rows it had room for. */
  setWidth(cols: number): void {
    this.cols = cols
  }

  set(text: string): void {
    this.str = text
    this.at = 0
    this.top = 0
  }

  rows(): Fold[] {
    return fold(this.str, this.width, this.opts.wrap !== false)
  }

  /** The row the caret is on: the last row starting at or before the caret. */
  rowAt(rows: Fold[], at = this.at): number {
    for (let i = rows.length - 1; i > 0; i--) if (at >= rows[i].start) return i
    return 0
  }

  /** Handle one editing key. False if it is not one this buffer handles. */
  key(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false

    if (e.ctrlKey) {
      // ^K follows nano: cuts the whole hard line, not the tail from the caret.
      if (e.key === 'k') return this.killLine()
      return false
    }

    if (e.key === 'Enter') { this.insert('\n'); return true }
    if (e.key === 'Backspace') {
      if (!this.at) return this.reject()
      this.str = this.str.slice(0, this.at - 1) + this.str.slice(this.at)
      this.at--
      return true
    }
    if (e.key === 'Delete') {
      if (this.at >= this.str.length) return this.reject()
      this.str = this.str.slice(0, this.at) + this.str.slice(this.at + 1)
      return true
    }

    if (e.key === 'ArrowLeft') return this.at ? (this.at--, true) : this.reject()
    if (e.key === 'ArrowRight') {
      return this.at < this.str.length ? (this.at++, true) : this.reject()
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      return this.step(e.key === 'ArrowUp' ? -1 : 1)
    }
    if (e.key === 'Home' || e.key === 'End') return this.toLineEdge(e.key === 'Home')
    if (e.key === 'PageUp' || e.key === 'PageDown') return true

    if ([...e.key].length === 1) { this.insert(e.key); return true }
    return false
  }

  /** Insert a run of text at the caret. Refused rather than truncated if it does not fit. */
  insert(s: string): void {
    const max = this.opts.maxLength ?? DEFAULT_MAX
    if (this.str.length + s.length > max) { this.opts.onReject?.(); return }

    const next = this.str.slice(0, this.at) + s + this.str.slice(this.at)
    if (this.opts.wrap === false
      && next.split('\n').some(line => line.length > this.width)) {
      this.opts.onReject?.()
      return
    }
    this.str = next
    this.at += s.length
  }

  /** Home/End on the folded row rather than the hard line. */
  toLineEdge(start: boolean): boolean {
    const rows = this.rows()
    const row = rows[this.rowAt(rows)]
    this.at = start ? row.start : row.start + row.len
    return true
  }

  /**
   * ^K: delete the hard line the caret is on together with its trailing newline,
   * so following lines move up. On the last line the leading newline is taken
   * instead, which avoids leaving a blank row.
   */
  killLine(): boolean {
    if (!this.str) return this.reject()

    const start = this.at ? this.str.lastIndexOf('\n', this.at - 1) + 1 : 0
    const nl = this.str.indexOf('\n', this.at)
    const end = nl === -1 ? this.str.length : nl + 1
    const from = nl === -1 && start > 0 ? start - 1 : start

    this.str = this.str.slice(0, from) + this.str.slice(end)
    this.at = Math.min(from, this.str.length)
    return true
  }

  /** Move up or down one visual row, preserving the column where possible. */
  step(delta: number): boolean {
    const rows = this.rows()
    const i = this.rowAt(rows)
    const next = rows[i + delta]
    if (!next) return this.reject()
    const col = this.at - rows[i].start
    this.at = next.start + Math.min(col, next.len)
    return true
  }

  private reject(): boolean {
    this.opts.onReject?.()
    return true
  }
}

/**
 * Paint a buffer into `r` and place the cursor on its caret. The view scrolls to
 * follow the caret only. Does not clear the rect.
 */
export function drawBuffer(s: Surface, buf: TextBuffer, r: Rect, attr = NORMAL): Fold[] {
  buf.setWidth(r.w)
  const rows = buf.rows()
  const caret = buf.rowAt(rows)

  if (caret < buf.top) buf.top = caret
  if (caret >= buf.top + r.h) buf.top = caret - r.h + 1
  buf.top = Math.max(0, Math.min(buf.top, Math.max(0, rows.length - r.h)))

  for (let i = 0; i < r.h; i++) {
    const row = rows[buf.top + i]
    if (!row) break
    const text = buf.text.slice(row.start, row.start + row.len)
    s.text(r.x, r.y + i, text.slice(0, r.w), attr)
  }

  const row = rows[caret]
  s.cx = r.x + Math.min(buf.caret - (row?.start ?? 0), r.w)
  s.cy = r.y + caret - buf.top
  return rows
}
