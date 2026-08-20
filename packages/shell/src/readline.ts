// Line editor over a raw tty: cursor movement, history, tab completion.
// Renders on one screen row with horizontal scrolling for long lines.

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

  constructor(
    private tty: TtyControl,
    private stdin: Source,
    private out: (s: string) => void,
    private complete?: Completer,
  ) {}

  /** Read one line. Returns null on EOF (^D at an empty line). */
  async read(prompt: string): Promise<string | null> {
    this.tty.setRaw()
    this.prompt = prompt
    this.buf = ''
    this.cursor = 0
    this.histIndex = this.history.length
    this.draft = ''
    this.out(prompt)

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
    this.out('\r\n')
    return this.buf
  }

  private async key(k: string): Promise<'line' | 'eof' | void> {
    switch (k) {
      case '\r': case '\n': return 'line'
      case '\x04': return this.buf ? undefined : 'eof'
      case '\x03': // ^C: abandon the line
        this.out('^C\r\n' + this.prompt)
        this.buf = ''
        this.cursor = 0
        return
      case '\x7f': case '\b':
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
        this.out('\x1b[2J\x1b[H')
        this.redraw()
        return
      case '\t': {
        if (!this.complete) return
        const r = await this.complete(this.buf, this.cursor)
        if (r.insert) {
          this.buf = this.buf.slice(0, this.cursor) + r.insert + this.buf.slice(this.cursor)
          this.cursor += r.insert.length
          this.redraw()
        } else if (r.list?.length) {
          this.out('\r\n' + columns(r.list, this.tty.cols) + '\r\n')
          this.redraw()
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

  private redraw(): void {
    const width = this.tty.cols - visibleLen(this.prompt) - 1
    // Keep the cursor inside the visible window.
    let start = 0
    if (this.cursor > width) start = this.cursor - width
    const view = this.buf.slice(start, start + width)
    const col = this.cursor - start
    this.out('\r\x1b[K' + this.prompt + view)
    const back = view.length - col
    if (back > 0) this.out(`\x1b[${back}D`)
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
