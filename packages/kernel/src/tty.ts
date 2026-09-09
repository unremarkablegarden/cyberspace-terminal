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
//
// Job control: each job gets a JobTty view of this device. One view is in the
// foreground and owns the keyboard, the screen and the mode; the others read
// nothing, buffer their stdout and drop their frames. foreground() switches.

import { type Source, type Sink, bytes, dec, Pipe } from './pipe.js'

/**
 * A private OSC the host maps to the machine's blip, the sound circ makes per
 * batch of revealed lines. A program that runs in the kernel and holds no sound
 * service (edit, less) sends this through paint() instead. 777 is rxvt's
 * extension number; a terminal without a handler drops the sequence.
 */
export const OSC_BLIP = '\x1b]777;blip\x1b\\'

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
   * Rate-limit this program's stdout, or do not. On by default.
   *
   * The rate models text arriving over a line, which is what a program printing
   * text is doing. A program drawing its own frames is not, so it turns pacing
   * off for its run and paces whatever it wants to pace itself. Restored by
   * setCooked().
   */
  setPaced(on: boolean): void
  /**
   * The keyboard. A full-screen program under a pipe has a pipe for stdin, so it
   * reads keys from here instead; equivalent to /dev/tty.
   */
  get stdin(): Source
  /**
   * Put text on the system clipboard, for a copy or cut. Paste arrives the other
   * way, as input. Inert until the host wires a writer.
   */
  copy(text: string): void
}

export class Tty implements TtyControl {
  cols: number
  rows: number
  /** Handlers for a process reading this device directly. A foreground view's own take precedence. */
  onSigint: (() => void) | null = null
  onSigtstp: (() => void) | null = null
  /** The job view holding the terminal, or null while the shell has it. */
  fgView: JobTty | null = null

  /** Whether the running program wants a caret shown. See paint(). */
  caret = true

  /**
   * Whether the alt screen (DECSET 1049 or 47) is up, tracked from the bytes written.
   * The shell's ^C handler leaves the alt screen for a killed program, and must
   * not send 1049l when it is already down: xterm's 1049l also restores the
   * saved cursor, which was never saved, so the prompt would land at row 0.
   */
  alt = false

  /** Keys the program handles with its own sound. See silence(). */
  private quiet = new Set<string>()

  private raw = false
  /** Whether stdout is rate-limited. See setPaced(). */
  private paced = true
  private line = ''
  private readers = new Pipe()
  private out: (data: Uint8Array, urgent?: boolean) => void

  /**
   * Host-side clipboard writer, injected by the faceplate (the kernel has no DOM
   * and cannot reach navigator.clipboard). Null until wired; copy() is then inert.
   */
  clipboard: ((text: string) => void) | null = null

  constructor(out: (data: Uint8Array, urgent?: boolean) => void, cols = 80, rows = 25) {
    this.out = out
    this.cols = cols
    this.rows = rows
  }

  copy(text: string): void {
    this.clipboard?.(text)
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
    // Restored here as well as by the program, so one that exits without
    // tidying cannot leave the terminal unpaced for the shell.
    this.paced = true
  }

  setPaced(on: boolean): void {
    this.paced = on
  }

  silence(keys: string[]): void {
    this.quiet = new Set(keys)
  }

  isSilent(key: string): boolean {
    return this.quiet.has(key)
  }

  /** A job's own view of this device. See JobTty. */
  view(): JobTty {
    return new JobTty(this)
  }

  /**
   * Hand the terminal to a job view, or to the shell (null).
   *
   * The outgoing holder's alt screen is left so the shell's scrollback shows
   * again; the incoming view's is re-entered and its buffered output flushed.
   * Its program repaints on cont(), so nothing on screen is saved.
   */
  foreground(view: JobTty | null): void {
    if (this.fgView === view) return
    if (this.fgView) this.fgView.fg = false
    // Only when the alt screen is up: see `alt`.
    if (this.alt) this.paint('\x1b[?1049l\x1b[?25h')
    this.fgView = view
    if (!view) {
      this.setCooked()
      return
    }
    view.fg = true
    this.raw = view.raw
    this.line = ''
    this.quiet = new Set(view.quiet)
    this.paced = view.paced
    this.caret = view.caret
    if (view.alt) this.paint('\x1b[?1049h')
    view.flush()
  }

  /** Where keystrokes go: the foreground view, else whoever reads the device itself. */
  private get target(): Pipe {
    return this.fgView?.keys ?? this.readers
  }

  private sigint(): void {
    ;(this.fgView ? this.fgView.onSigint : this.onSigint)?.()
  }

  /** The ^Z handler in force, or null when ^Z is an ordinary byte. */
  private get sigtstp(): (() => void) | null {
    return this.fgView ? this.fgView.onSigtstp : this.onSigtstp
  }

  /** Host side: keystroke bytes arrive here. */
  input(data: Uint8Array | string): void {
    if (this.raw) {
      // Ctrl-C aborts in raw mode as well, unlike a real tty, which passes it
      // through as a byte and lets the program decide. That would leave a
      // program busy writing, enumerating or waiting on the network unable to
      // be stopped. The byte is delivered too, so a program can still tidy up.
      let text = dec.decode(bytes(data))
      if (text.includes('\x03')) this.sigint()
      // ^Z is taken out of the stream when a job can be stopped: the program
      // is losing the keyboard and has no use for the byte.
      const tstp = this.sigtstp
      if (tstp && text.includes('\x1a')) {
        text = text.replaceAll('\x1a', '')
        tstp()
      }
      if (text) this.target.write(bytes(text))
      return
    }
    for (const ch of dec.decode(bytes(data))) this.cookedKey(ch)
  }

  private cookedKey(ch: string): void {
    if (ch === '\x03') {
      this.echo('^C\r\n')
      this.line = ''
      this.sigint()
      return
    }
    if (ch === '\x1a') {
      const tstp = this.sigtstp
      if (tstp) {
        this.echo('^Z\r\n')
        this.line = ''
        tstp()
      }
      return
    }
    if (ch === '\x04') {
      // EOF only at an empty line, as termios does.
      if (this.line === '') this.target.write(EOF_MARK)
      return
    }
    if (ch === '\r' || ch === '\n') {
      this.echo('\r\n')
      this.target.write(this.line + '\n')
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
    this.trackAlt(s)
    this.out(bytes(s), true)
  }

  private trackAlt(s: string): void {
    // 47 is the older switch without cursor save; Vim's builtin xterm uses it.
    const up = Math.max(s.lastIndexOf('\x1b[?1049h'), s.lastIndexOf('\x1b[?47h'))
    const down = Math.max(s.lastIndexOf('\x1b[?1049l'), s.lastIndexOf('\x1b[?47l'))
    if (up !== -1 || down !== -1) this.alt = up > down
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
        this.trackAlt(s)
        this.out(bytes(s.replace(/(?<!\r)\n/g, '\r\n')), !this.paced)
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

/** Bytes of stdout kept for a job that is not in the foreground; the oldest go first past this. */
const HOLD_MAX = 64 * 1024

/**
 * One job's terminal.
 *
 * Holds the job's own mode (raw, silenced keys, pacing, caret, alt screen) and
 * applies it to the device only while in the foreground, so a job that is
 * stopped mid-frame leaves nothing on the device and comes back as it was.
 * Reads block while not in the foreground because nothing writes `keys`.
 * stdout is held and flushed on foreground; paint and echo are dropped, since
 * a frame is a diff against the frame before it and is wrong out of sequence.
 */
export class JobTty implements TtyControl {
  /** Set by Tty.foreground(). */
  fg = false
  keys = new Pipe()
  raw = false
  alt = false
  caret = true
  paced = true
  quiet = new Set<string>()
  /** Set by the shell for the job; the device consults them while the view is in the foreground. */
  onSigint: (() => void) | null = null
  onSigtstp: (() => void) | null = null

  private held: Uint8Array[] = []
  private heldBytes = 0

  constructor(private root: Tty) {}

  get cols(): number { return this.root.cols }
  get rows(): number { return this.root.rows }

  setRaw(): void {
    this.raw = true
    if (this.fg) this.root.setRaw()
  }

  setCooked(): void {
    this.raw = false
    this.caret = true
    this.quiet.clear()
    this.paced = true
    if (this.fg) this.root.setCooked()
  }

  setPaced(on: boolean): void {
    this.paced = on
    if (this.fg) this.root.setPaced(on)
  }

  silence(keys: string[]): void {
    this.quiet = new Set(keys)
    if (this.fg) this.root.silence(keys)
  }

  isSilent(key: string): boolean {
    return this.quiet.has(key)
  }

  echo(s: string): void {
    if (this.fg) this.root.echo(s)
  }

  paint(s: string): void {
    const hide = s.lastIndexOf('\x1b[?25l')
    const show = s.lastIndexOf('\x1b[?25h')
    if (hide !== -1 || show !== -1) this.caret = show > hide
    this.trackAlt(s)
    if (this.fg) this.root.paint(s)
  }

  copy(text: string): void {
    this.root.copy(text)
  }

  get stdin(): Source {
    const view = this
    return {
      isInteractive: true,
      async read() {
        const c = await view.keys.read()
        if (c && c.length === 1 && c[0] === 4) return null
        return c
      },
      interrupt: () => {
        const old = this.keys
        this.keys = new Pipe()
        old.end()
      },
    }
  }

  get stdout(): Sink {
    return {
      write: (data: Uint8Array | string) => {
        const s = typeof data === 'string' ? data : dec.decode(data)
        this.trackAlt(s)
        if (this.fg) { this.root.stdout.write(s); return }
        const b = bytes(s)
        this.held.push(b)
        this.heldBytes += b.length
        while (this.heldBytes > HOLD_MAX && this.held.length > 1) {
          this.heldBytes -= this.held.shift()!.length
        }
      },
      end() {},
    }
  }

  /** Write out what was held while stopped. Called by Tty.foreground(). */
  flush(): void {
    const chunks = this.held.splice(0)
    this.heldBytes = 0
    for (const c of chunks) this.root.stdout.write(c)
  }

  private trackAlt(s: string): void {
    const up = Math.max(s.lastIndexOf('\x1b[?1049h'), s.lastIndexOf('\x1b[?47h'))
    const down = Math.max(s.lastIndexOf('\x1b[?1049l'), s.lastIndexOf('\x1b[?47l'))
    if (up !== -1 || down !== -1) this.alt = up > down
  }
}
