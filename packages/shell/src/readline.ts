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
  /** Candidates to print when there is nothing unambiguous to insert. */
  list?: string[]
}

export type Completer = (line: string, cursor: number) => Promise<Completion>

const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length

export class Readline {
  history: string[] = []

  private buf = ''
  private cursor = 0
  private histIndex = 0
  private draft = ''
  private prompt = ''

  // What is currently on the row, for the incremental repaint.
  private drawnStart = 0
  private drawnView = ''
  private drawnCol = 0

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

  /** Read one line. Returns null on EOF (^D at an empty line). */
  async read(prompt: string): Promise<string | null> {
    this.tty.setRaw()
    this.prompt = prompt
    this.buf = ''
    this.cursor = 0
    this.histIndex = this.history.length
    this.draft = ''
    this.tty.echo(prompt)
    this.drawn(0, '', 0)

    let pending = ''
    for (;;) {
      if (!pending) {
        const chunk = await this.stdin.read()
        if (chunk === null) return this.buf ? this.finish() : null
        pending = dec.decode(chunk)
      }
      const [key, rest] = nextKey(pending)
      pending = rest
      const done = await this.key(key)
      if (done === 'eof') return null
      if (done === 'line') return this.finish()
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
        this.drawn(0, '', 0)
        return
      case '\x7f': case '\b': case '\x1b[104;5u':
        if (this.cursor > 0) {
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor)
          this.cursor--
          this.redraw()
        }
        return
      case '\x1b[3~': // Delete
        if (this.cursor < this.buf.length) {
          this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1)
          this.redraw()
        }
        return
      case '\x1b[D': if (this.cursor > 0) { this.cursor--; this.redraw() } return
      case '\x1b[C': if (this.cursor < this.buf.length) { this.cursor++; this.redraw() } return
      case '\x1b[H': case '\x01': this.cursor = 0; this.redraw(); return
      case '\x1b[F': case '\x05': this.cursor = this.buf.length; this.redraw(); return
      case '\x1b[A': this.hist(-1); return
      case '\x1b[B': this.hist(1); return
      case '\x15': // ^U kill to start
        this.buf = this.buf.slice(this.cursor)
        this.cursor = 0
        this.redraw()
        return
      case '\x0b': // ^K kill to end
        this.buf = this.buf.slice(0, this.cursor)
        this.redraw()
        return
      case '\x17': { // ^W kill word
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
        const r = await this.complete(this.buf, this.cursor)
        if (r.insert) {
          this.buf = this.buf.slice(0, this.cursor) + r.insert + this.buf.slice(this.cursor)
          this.cursor += r.insert.length
          this.redraw()
        } else if (r.list?.length) {
          this.tty.echo('\r\n' + columns(r.list, this.tty.cols) + '\r\n')
          this.redraw(true)
        }
        return
      }
    }
    if (k.length === 1 && k >= ' ') {
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
    this.redraw()
  }

  private redraw(force = false): void {
    const width = this.tty.cols - visibleLen(this.prompt) - 1
    // Keep the cursor inside the visible window.
    let start = 0
    if (this.cursor > width) start = this.cursor - width
    const view = this.buf.slice(start, start + width)
    const col = this.cursor - start

    // Same window, so send the difference rather than the whole row.
    if (!force && start === this.drawnStart) {
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

    this.tty.echo('\r\x1b[K' + this.prompt + view)
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
