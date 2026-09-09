// Line editor over a raw tty: cursor movement, history, tab completion.
// Renders on one screen row with horizontal scrolling for long lines.
//
// What it draws is echo rather than program output, so it is written to the tty
// unrate-limited and a keystroke repaints only what changed. Reprinting the
// whole line per key would send the entire row through the rate limiter.

import { dec, type Source } from '@cyberspace/kernel'
import type { TtyControl } from '@cyberspace/kernel'

export interface Completion {
  /** Text to insert at the cursor. */
  insert?: string
  /** Characters before the cursor that `insert` replaces. */
  erase?: number
  /** Candidates to print when there is nothing unambiguous to insert. */
  list?: string[]
}

export type Completer = (line: string, cursor: number) => Promise<Completion>

const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length

// Selection helpers, kept local so the shell keeps its one dependency (kernel).
// The tui widgets carry the same logic in edits.ts.
const selRange = (anchor: number | null, pos: number): [number, number] | null =>
  anchor === null || anchor === pos ? null : anchor < pos ? [anchor, pos] : [pos, anchor]
const wordLeft = (s: string, p: number): number => {
  let i = Math.max(0, Math.min(p, s.length))
  while (i > 0 && /\s/.test(s[i - 1]!)) i--
  while (i > 0 && !/\s/.test(s[i - 1]!)) i--
  return i
}
const wordRight = (s: string, p: number): number => {
  let i = Math.max(0, Math.min(p, s.length))
  while (i < s.length && /\s/.test(s[i]!)) i++
  while (i < s.length && !/\s/.test(s[i]!)) i++
  return i
}

export class Readline {
  history: string[] = []

  private buf = ''
  private cursor = 0
  /** Other end of the selection, or null when nothing is selected. */
  private anchor: number | null = null
  private histIndex = 0
  private draft = ''
  private prompt = ''

  // What is currently on the row, for the incremental repaint.
  private drawnStart = 0
  private drawnView = ''
  private drawnCol = 0
  // Whether the last paint showed a selection. A selection forces a full row
  // repaint: the incremental diff tracks plain text and cannot place inverse.
  private selShown = false

  /**
   * The stdin read a cancelled read() left pending, taken up by the next
   * read() so no keystroke is lost between them.
   */
  private inflight: Promise<Uint8Array | null> | null = null
  private cancelFn: (() => void) | null = null
  /** The line being typed when read() was cancelled; the next read() starts with it. */
  private kept = ''

  constructor(
    private tty: TtyControl,
    private stdin: Source,
    private complete?: Completer,
  ) {}

  private drawn(start: number, view: string, col: number): void {
    this.drawnStart = start
    this.drawnView = view
    this.drawnCol = col
  }

  private sel(): [number, number] | null {
    return selRange(this.anchor, this.cursor)
  }

  /** Move the caret; a shifted move extends the selection, a plain one drops it. */
  private move(to: number, shift: boolean): void {
    to = Math.max(0, Math.min(to, this.buf.length))
    const prevCursor = this.cursor
    const prevAnchor = this.anchor
    if (shift) {
      if (this.anchor === null) this.anchor = this.cursor
      this.cursor = to
    } else {
      this.anchor = null
      this.cursor = to
    }
    if (this.cursor !== prevCursor || this.anchor !== prevAnchor) this.redraw()
  }

  private deleteSel(): boolean {
    const s = this.sel()
    if (!s) return false
    this.buf = this.buf.slice(0, s[0]) + this.buf.slice(s[1])
    this.cursor = s[0]
    this.anchor = null
    return true
  }

  /**
   * Interrupt a read() from outside: it resolves undefined and the row is
   * ended, so what the shell prints next starts on a fresh line. The line
   * typed so far comes back on the next read().
   */
  cancel(): void {
    this.cancelFn?.()
  }

  /** Read one line. Returns null on EOF (^D at an empty line), undefined when cancelled. */
  async read(prompt: string): Promise<string | null | undefined> {
    this.tty.setRaw()
    this.prompt = prompt
    this.buf = ''
    this.cursor = 0
    this.anchor = null
    this.selShown = false
    this.histIndex = this.history.length
    this.draft = ''
    this.tty.echo(prompt)
    this.drawn(0, '', 0)
    if (this.kept) {
      this.buf = this.kept
      this.cursor = this.kept.length
      this.kept = ''
      this.redraw()
    }

    let cancelled = false
    const cancelP = new Promise<void>(res => {
      this.cancelFn = () => { cancelled = true; res() }
    })
    let pending = ''
    try {
      for (;;) {
        if (!pending) {
          this.inflight ??= this.stdin.read()
          const chunk = await Promise.race([this.inflight, cancelP.then(() => null)])
          if (cancelled) {
            this.kept = this.buf
            this.tty.echo('\r\n')
            return undefined
          }
          this.inflight = null
          if (chunk === null) return this.buf ? this.finish() : null
          pending = dec.decode(chunk)
        }
        const [key, rest] = nextKey(pending)
        pending = rest
        const done = await this.key(key)
        if (done === 'eof') return null
        if (done === 'line') return this.finish()
      }
    } finally {
      this.cancelFn = null
    }
  }

  private finish(): string {
    this.tty.echo('\r\n')
    return this.buf
  }

  private async key(k: string): Promise<'line' | 'eof' | void> {
    switch (k) {
      case '\r': case '\n': case '\x1b[106;5u': return 'line'
      case '\x04': return this.buf ? undefined : 'eof'
      case '\x03': // ^C: abandon the line
        this.tty.echo('^C\r\n' + this.prompt)
        this.buf = ''
        this.cursor = 0
        this.anchor = null
        this.selShown = false
        this.drawn(0, '', 0)
        return
      // Copy and cut, from cmd+C/cmd+X or ctrl+shift+C/X. See app/src/keys.ts.
      case '\x1b[99;6u': {
        const s = this.sel()
        if (s) this.tty.copy(this.buf.slice(s[0], s[1]))
        return
      }
      case '\x1b[120;6u': {
        const s = this.sel()
        if (s) { this.tty.copy(this.buf.slice(s[0], s[1])); this.deleteSel(); this.redraw() }
        return
      }
      case '\x7f': case '\b': case '\x1b[104;5u':
        if (this.deleteSel()) { this.redraw(); return }
        if (this.cursor > 0) {
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor)
          this.cursor--
          this.redraw()
        }
        return
      case '\x1b[3~': // Delete
        if (this.deleteSel()) { this.redraw(); return }
        if (this.cursor < this.buf.length) {
          this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1)
          this.redraw()
        }
        return
      case '\x1b[D': { // Left; collapse a selection to its start
        const s = this.sel()
        if (s) { this.cursor = s[0]; this.anchor = null; this.redraw() }
        else this.move(this.cursor - 1, false)
        return
      }
      case '\x1b[C': { // Right; collapse a selection to its end
        const s = this.sel()
        if (s) { this.cursor = s[1]; this.anchor = null; this.redraw() }
        else this.move(this.cursor + 1, false)
        return
      }
      // Modified arrows: `1;2` shift (extend), `1;5` ctrl (word), `1;6` both.
      case '\x1b[1;2D': this.move(this.cursor - 1, true); return
      case '\x1b[1;2C': this.move(this.cursor + 1, true); return
      case '\x1b[1;5D': this.move(wordLeft(this.buf, this.cursor), false); return
      case '\x1b[1;5C': this.move(wordRight(this.buf, this.cursor), false); return
      case '\x1b[1;6D': this.move(wordLeft(this.buf, this.cursor), true); return
      case '\x1b[1;6C': this.move(wordRight(this.buf, this.cursor), true); return
      case '\x1b[H': case '\x01': this.move(0, false); return
      case '\x1b[F': case '\x05': this.move(this.buf.length, false); return
      case '\x1b[1;2H': this.move(0, true); return // Shift+Home
      case '\x1b[1;2F': this.move(this.buf.length, true); return // Shift+End
      case '\x1b[A': this.hist(-1); return
      case '\x1b[B': this.hist(1); return
      case '\x15': // ^U kill to start
        this.anchor = null
        this.buf = this.buf.slice(this.cursor)
        this.cursor = 0
        this.redraw()
        return
      case '\x0b': // ^K kill to end
        this.anchor = null
        this.buf = this.buf.slice(0, this.cursor)
        this.redraw()
        return
      case '\x17': { // ^W kill word
        this.anchor = null
        const head = this.buf.slice(0, this.cursor).replace(/\S+\s*$/, '')
        this.buf = head + this.buf.slice(this.cursor)
        this.cursor = head.length
        this.redraw()
        return
      }
      case '\x0c': // ^L
        this.tty.echo('\x1b[2J\x1b[H')
        this.redraw(true)
        return
      case '\t': {
        if (!this.complete) return
        this.anchor = null
        const r = await this.complete(this.buf, this.cursor)
        if (r.insert) {
          // `erase` characters before the cursor are replaced too, so a match
          // that differs in case from what was typed corrects it.
          const erase = r.erase ?? 0
          this.buf = this.buf.slice(0, this.cursor - erase) + r.insert + this.buf.slice(this.cursor)
          this.cursor += r.insert.length - erase
          this.redraw()
        } else if (r.list?.length) {
          this.tty.echo('\r\n' + columns(r.list, this.tty.cols) + '\r\n')
          this.redraw(true)
        }
        return
      }
    }
    if (k.length === 1 && k >= ' ') {
      this.deleteSel()
      this.buf = this.buf.slice(0, this.cursor) + k + this.buf.slice(this.cursor)
      this.cursor++
      this.redraw()
    }
  }

  private hist(dir: -1 | 1): void {
    const next = this.histIndex + dir
    if (next < 0 || next > this.history.length) return
    if (this.histIndex === this.history.length) this.draft = this.buf
    this.histIndex = next
    this.buf = next === this.history.length ? this.draft : this.history[next]
    this.cursor = this.buf.length
    this.anchor = null
    this.redraw()
  }

  private redraw(force = false): void {
    const width = this.tty.cols - visibleLen(this.prompt) - 1
    // Keep the cursor inside the visible window.
    let start = 0
    if (this.cursor > width) start = this.cursor - width
    const view = this.buf.slice(start, start + width)
    const col = this.cursor - start
    const s = this.sel()

    // Same window, so send the difference rather than the whole row. Skipped
    // whenever a selection is on screen now or was on the last paint, since the
    // diff tracks plain text and cannot add or clear the inverse run.
    if (!force && !s && !this.selShown && start === this.drawnStart) {
      const atEnd = col === view.length && this.drawnCol === this.drawnView.length
      if (atEnd && view.length > this.drawnView.length && view.startsWith(this.drawnView)) {
        this.tty.echo(view.slice(this.drawnView.length))
        this.drawn(start, view, col)
        return
      }
      if (atEnd && view.length < this.drawnView.length && this.drawnView.startsWith(view)) {
        this.tty.echo('\b'.repeat(this.drawnView.length - view.length) + '\x1b[K')
        this.drawn(start, view, col)
        return
      }
      if (view === this.drawnView && col !== this.drawnCol) {
        const d = col - this.drawnCol
        this.tty.echo(d > 0 ? `\x1b[${d}C` : `\x1b[${-d}D`)
        this.drawn(start, view, col)
        return
      }
    }

    // The selected run in the visible window, drawn inverse.
    let out = view
    if (s) {
      const lo = Math.max(0, s[0] - start)
      const hi = Math.min(view.length, s[1] - start)
      if (hi > lo) out = view.slice(0, lo) + '\x1b[7m' + view.slice(lo, hi) + '\x1b[27m' + view.slice(hi)
    }
    this.selShown = s !== null
    this.tty.echo('\r\x1b[K' + this.prompt + out)
    const back = view.length - col
    if (back > 0) this.tty.echo(`\x1b[${back}D`)
    this.drawn(start, view, col)
  }
}

/** Split one key (escape sequence or char) off the front of pending input. */
function nextKey(s: string): [string, string] {
  if (s[0] !== '\x1b') return [s[0], s.slice(1)]
  const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(s)
  if (m) return [m[0], s.slice(m[0].length)]
  return [s[0], s.slice(1)]
}

function columns(items: string[], cols: number): string {
  const w = Math.max(...items.map(i => i.length)) + 2
  const per = Math.max(1, Math.floor(cols / w))
  const lines: string[] = []
  for (let i = 0; i < items.length; i += per) {
    lines.push(items.slice(i, i + per).map(s => s.padEnd(w)).join('').trimEnd())
  }
  return lines.join('\r\n')
}
