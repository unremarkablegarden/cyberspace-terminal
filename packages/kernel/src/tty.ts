// Terminal device. Host feeds keystroke bytes in and takes display bytes out;
// processes read/write it as stdin/stdout.
//
// Two input modes:
// - raw: bytes pass straight to the reader, no echo. A line editor wants this.
// - cooked: line buffering with echo, backspace, ^C -> SIGINT, ^D -> EOF.
// Output always maps lone \n to \r\n.
//
// Echo is marked urgent on the way out. A host that paces program output must
// not pace the letters under the operator's fingers.

import { type Source, type Sink, bytes, dec, Pipe } from './pipe.js'

export interface TtyControl {
  setRaw(): void
  setCooked(): void
  get cols(): number
  get rows(): number
  /** Echo: display bytes that belong to the keyboard, not to a program. */
  echo(s: string): void
  /**
   * Keys this program answers with a sound of its own, so the host does not
   * also play the keyclick. A scrolling log already ticks, and a clack on top
   * of a tick is one keypress making two noises.
   *
   * Declared by key, rather than the host guessing. Cleared on setCooked().
   */
  silence(keys: string[]): void
  isSilent(key: string): boolean
  /**
   * A repaint: the whole glass as a program means it to look.
   *
   * Unpaced, like echo and for the same reason. The rate models a line
   * DELIVERING TEXT; a full-screen program handing over a frame is not that,
   * and pacing one types its chrome on a character at a time.
   */
  paint(s: string): void
  /**
   * The keyboard itself. A full-screen program under a pipe has a pipe for
   * stdin, so it takes its keys from here — the tty is /dev/tty.
   */
  get stdin(): Source
}

export class Tty implements TtyControl {
  cols: number
  rows: number
  onSigint: (() => void) | null = null

  /** Whether the program on the glass wants a caret. See paint(). */
  caret = true

  /** Keys the program answers itself. See silence(). */
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
    // Back to the shell, which types and answers nothing itself.
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
      // **Ctrl-C interrupts in raw mode too.** A real tty leaves it as a byte
      // and lets the program decide — which means a program that is busy
      // writing, enumerating or waiting on the network cannot be stopped by the
      // one key that means stop. On this machine it always aborts, and the
      // byte is delivered as well so a program that wants to tidy up can.
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
   * A frame from a full-screen program. Straight to the glass.
   *
   * The tty tracks DECTCEM for the host as it goes past: a program that hides
   * the caret says so in the frame it paints, and the faceplate has no other
   * way to know — its render loop writes the caret on every frame and would
   * put back the one the program just turned off.
   */
  paint(s: string): void {
    const hide = s.lastIndexOf('\x1b[?25l')
    const show = s.lastIndexOf('\x1b[?25h')
    if (hide !== -1 || show !== -1) this.caret = show > hide
    this.out(bytes(s), true)
  }

  /** Process side: stdin. Reads track the live queue, so an interrupt only
   *  EOFs reads that were already pending. */
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
