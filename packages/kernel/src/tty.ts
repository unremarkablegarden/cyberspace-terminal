// Terminal device. Host feeds keystroke bytes in and takes display bytes out;
// processes read/write it as stdin/stdout.
//
// Two input modes:
// - raw: bytes pass straight to the reader, no echo. A line editor wants this.
// - cooked: line buffering with echo, backspace, ^C -> SIGINT, ^D -> EOF.
// Output always maps lone \n to \r\n.
//
// Echo is marked urgent on the way out, so a host that rate-limits program
// output does not rate-limit keystroke echo.

import { type Source, type Sink, bytes, dec, Pipe } from './pipe.js'

export interface TtyControl {
  setRaw(): void
  setCooked(): void
  get cols(): number
  get rows(): number
  /** Echo: display bytes originating from the keyboard rather than a program. */
  echo(s: string): void
  /**
   * Keys for which this program plays its own sound, so the host suppresses the
   * key click and one keypress does not make two sounds.
   *
   * Declared per key rather than inferred by the host. Cleared on setCooked().
   */
  silence(keys: string[]): void
  isSilent(key: string): boolean
  /**
   * Write a full-screen repaint.
   *
   * Not rate-limited, as with echo: the rate models text arriving over a line,
   * which a whole frame is not. Rate-limiting one would draw its own chrome a
   * character at a time.
   */
  paint(s: string): void
  /**
   * The keyboard. A full-screen program under a pipe has a pipe for stdin, so it
   * reads keys from here instead; equivalent to /dev/tty.
   */
  get stdin(): Source
}

export class Tty implements TtyControl {
  cols: number
  rows: number
  onSigint: (() => void) | null = null

  /** Whether the running program wants a caret shown. See paint(). */
  caret = true

  /** Keys the program handles with its own sound. See silence(). */
  private quiet = new Set<string>()

  private raw = false
  private line = ''
  private readers = new Pipe()
  private out: (data: Uint8Array, urgent?: boolean) => void

  constructor(out: (data: Uint8Array, urgent?: boolean) => void, cols = 80, rows = 25) {
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
    // Back to the shell, which plays no sounds of its own.
    this.caret = true
    this.quiet.clear()
  }

  silence(keys: string[]): void {
    this.quiet = new Set(keys)
  }

  isSilent(key: string): boolean {
    return this.quiet.has(key)
  }

  /** Host side: keystroke bytes arrive here. */
  input(data: Uint8Array | string): void {
    if (this.raw) {
      // Ctrl-C aborts in raw mode as well, unlike a real tty, which passes it
      // through as a byte and lets the program decide. That would leave a
      // program busy writing, enumerating or waiting on the network unable to
      // be stopped. The byte is delivered too, so a program can still tidy up.
      const text = dec.decode(bytes(data))
      if (text.includes('\x03')) this.onSigint?.()
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

  echo(s: string): void {
    this.out(bytes(s.replace(/(?<!\r)\n/g, '\r\n')), true)
  }

  /**
   * Write one frame from a full-screen program, unmodified.
   *
   * DECTCEM is tracked as it passes, because a program hides the caret in the
   * frame it paints and the host has no other way to know: its render loop
   * writes the caret every frame and would restore the one just turned off.
   */
  paint(s: string): void {
    const hide = s.lastIndexOf('\x1b[?25l')
    const show = s.lastIndexOf('\x1b[?25h')
    if (hide !== -1 || show !== -1) this.caret = show > hide
    this.out(bytes(s), true)
  }

  /** Process side: stdin. Reads track the live queue, so an interrupt EOFs only
   *  reads that were already pending. */
  get stdin(): Source {
    const tty = this
    return {
      isInteractive: true,
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
