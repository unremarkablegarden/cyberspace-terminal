// Terminal device. Host feeds keystroke bytes in and takes display bytes out;
// processes read/write it as stdin/stdout.
//
// Two input modes:
// - raw: bytes pass straight to the reader, no echo. A line editor wants this.
// - cooked: line buffering with echo, backspace, ^C -> SIGINT, ^D -> EOF.
// Output always maps lone \n to \r\n.

import { type Source, type Sink, bytes, dec, Pipe } from './pipe.js'

export interface TtyControl {
  setRaw(): void
  setCooked(): void
  get cols(): number
  get rows(): number
}

export class Tty implements TtyControl {
  cols: number
  rows: number
  onSigint: (() => void) | null = null

  private raw = false
  private line = ''
  private readers = new Pipe()
  private out: (data: Uint8Array) => void

  constructor(out: (data: Uint8Array) => void, cols = 80, rows = 25) {
    this.out = out
    this.cols = cols
    this.rows = rows
  }

  setRaw(): void {
    this.raw = true
    this.line = ''
  }

  setCooked(): void {
    this.raw = false
    this.line = ''
  }

  /** Host side: keystroke bytes arrive here. */
  input(data: Uint8Array | string): void {
    if (this.raw) {
      this.readers.write(bytes(data))
      return
    }
    for (const ch of dec.decode(bytes(data))) this.cookedKey(ch)
  }

  private cookedKey(ch: string): void {
    if (ch === '\x03') {
      this.echo('^C\r\n')
      this.line = ''
      this.onSigint?.()
      return
    }
    if (ch === '\x04') {
      // EOF only at an empty line, as termios does.
      if (this.line === '') this.readers.write(EOF_MARK)
      return
    }
    if (ch === '\r' || ch === '\n') {
      this.echo('\r\n')
      this.readers.write(this.line + '\n')
      this.line = ''
      return
    }
    if (ch === '\x7f' || ch === '\b') {
      if (this.line) {
        this.line = this.line.slice(0, -1)
        this.echo('\b \b')
      }
      return
    }
    if (ch >= ' ') {
      this.line += ch
      this.echo(ch)
    }
  }

  private echo(s: string): void {
    this.out(bytes(s))
  }

  /** Process side: stdin. Reads track the live queue, so an interrupt only
   *  EOFs reads that were already pending. */
  get stdin(): Source {
    const tty = this
    return {
      async read() {
        const c = await tty.readers.read()
        if (c && c.length === 1 && c[0] === 4) return null
        return c
      },
      interrupt: () => this.flushReaders(),
    }
  }

  /** Process side: stdout/stderr. \n becomes \r\n. */
  get stdout(): Sink {
    return {
      write: (data: Uint8Array | string) => {
        const s = typeof data === 'string' ? data : dec.decode(data)
        this.out(bytes(s.replace(/(?<!\r)\n/g, '\r\n')))
      },
      end() {},
    }
  }

  /** Unblock every pending tty read with EOF. Used when killing a foreground job. */
  flushReaders(): void {
    const old = this.readers
    this.readers = new Pipe()
    old.end()
  }
}

const EOF_MARK = new Uint8Array([4])
