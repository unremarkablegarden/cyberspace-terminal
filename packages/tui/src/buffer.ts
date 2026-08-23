// The text a caret moves through: one string, one index, and a fold.
//
// The model is ONE string and ONE caret index into it, not an array of lines.
// Everything else — where the rows break, which row the caret is on, what Up
// does — falls out of folding that string to the width, so the wrap and the
// caret can never disagree about where a character is. Hard newlines are in
// the string like any other character; they are what Enter inserts.

import { Surface, type Rect } from './surface.js'
import { NORMAL } from './attrs.js'
import type { KeyInput } from './keys.js'

/** One drawn row of the folded text: where it starts, and how long it is. */
export interface Fold { start: number; len: number }

/**
 * Fold a string to `width`, keeping EVERY character — the caret is an index
 * into the same string, so a wrap that dropped the spaces it broke on would
 * put the caret in the wrong place the moment anyone typed one.
 *
 * Breaks at the last space in the window when there is one; the space stays on
 * the row it ended. A hard line always contributes at least one row, so an
 * empty line is a row the caret can sit on.
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
  /** Characters. Beyond it a key is refused rather than truncating. */
  maxLength?: number
  /** Fold long lines to the width. Off makes it a canvas with a hard right edge. */
  wrap?: boolean
  width?: number
  /** A key that could not do what it asked — caret at an end, or a limit. */
  onReject?: () => void
}

const DEFAULT_MAX = 65536
const DEFAULT_WIDTH = 56

export class TextBuffer {
  private str: string
  private at = 0
  /** First visible row of the folded text. Owned by whoever draws. */
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

  /** Told by draw what it actually had room for. */
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

  /** The row the caret is on: the last one that starts at or before it. */
  rowAt(rows: Fold[], at = this.at): number {
    for (let i = rows.length - 1; i > 0; i--) if (at >= rows[i].start) return i
    return 0
  }

  /** One editing key, or false if it is not one of ours. */
  key(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false

    if (e.ctrlKey) {
      // ^K is nano's: the whole hard line, not the tail of it.
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

  /**
   * Drop a run of text in at the caret. Refused rather than truncated: half a
   * pasted paragraph is worse than none.
   */
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

  /** Home/End on the FOLDED row — the line the eye sees. */
  toLineEdge(start: boolean): boolean {
    const rows = this.rows()
    const row = rows[this.rowAt(rows)]
    this.at = start ? row.start : row.start + row.len
    return true
  }

  /**
   * ^K: the hard line the caret is on, gone, with the newline that ends it —
   * so what is underneath comes up. The last line takes its leading newline
   * instead, or the text ends in a blank row nobody typed.
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

  /** Up or down a visual row, keeping the column where it can. */
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
 * Paint a buffer into `r` and park the cursor on its caret. The view follows
 * the caret and only the caret. Does not clear.
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
