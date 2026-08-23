// Rate-limits program output into the terminal parser so it arrives at a fixed
// rate rather than all at once. Token bucket: `credit` accrues at `cps` and is
// spent per byte written.
//
// Echo and full-screen repaints bypass the limiter. Only rate-limited output is
// counted by drain(); the host uses that count to time the output bleep.

/** How output is released: `line` emits a whole line per step, `char` emits bytes at `cps`. */
export type Arrival = 'line' | 'char'

const NL = 10

/** Writes at least this large are treated as a screen repaint, not program output. */
const BULK = 512

export class Baud {
  private chunks: { data: Uint8Array; bulk: boolean; echo: boolean }[] = []
  private offset = 0
  /** Unspent byte budget. Fractional and signed so sub-byte-per-frame rates and
   *  over-long lines still average out to `cps`. */
  private credit = 0

  constructor(
    private out: (data: Uint8Array) => void,
    public cps = 9600,
    public mode: Arrival = 'line',
  ) {}

  /** Queue program output. Released by drain() at `cps`. */
  write(data: Uint8Array): void {
    if (data.length) this.chunks.push({ data, bulk: data.length >= BULK, echo: false })
  }

  /** Write echo. Bypasses the limiter, but queues behind pending output to preserve ordering. */
  now(data: Uint8Array): void {
    if (!data.length) return
    if (this.chunks.length) this.chunks.push({ data, bulk: false, echo: true })
    else this.out(data)
  }

  get idle(): boolean {
    return this.chunks.length === 0
  }

  /**
   * Discard queued output. Ctrl-C only.
   *
   * A real terminal would go on delivering what it had already buffered.
   */
  flush(): void {
    this.chunks.length = 0
    this.offset = 0
    this.credit = 0
  }

  /**
   * Emit up to `dt` milliseconds' worth of queued bytes.
   *
   * Returns the number of rate-limited output bytes written. Echo and repaints
   * are excluded from the count.
   */
  drain(dt: number): number {
    // Burst cap: at most one second of credit, so a tab that stalls does not
    // release its whole backlog at once on resume.
    this.credit = Math.min(this.credit + (this.cps * dt) / 1000, this.cps)
    let sent = 0
    while (this.chunks.length && (this.credit >= 1 || this.chunks[0].bulk || this.chunks[0].echo)) {
      const { data: head, bulk, echo } = this.chunks[0]
      // Repaints and echo are written whole and spend no credit.
      const instant = bulk || echo
      const take = instant ? head.length - this.offset
        : this.mode === 'line' ? lineRun(head, this.offset)
        : Math.min(Math.floor(this.credit), head.length - this.offset)
      this.out(head.subarray(this.offset, this.offset + take))
      this.offset += take
      if (!instant) { this.credit -= take; sent += take }
      if (this.offset >= head.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    // Drop unspent credit when the queue empties, so output arriving after an
    // idle period starts rate-limited instead of releasing a full second at once.
    if (!this.chunks.length) this.credit = 0
    return sent
  }
}

/** Bytes from `from` up to and including the next newline, else to the end. */
function lineRun(chunk: Uint8Array, from: number): number {
  const nl = chunk.indexOf(NL, from)
  return nl === -1 ? chunk.length - from : nl - from + 1
}
