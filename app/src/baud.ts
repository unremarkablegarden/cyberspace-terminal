// Pace program output to the parser so text lands like it came down a line.
//
// Two arrivals:
// - line: a whole line per step. Fast, and the shape of a machine that buffers
//   a line and prints it.
// - char: byte by byte at the rate. A 2400-baud crawl.
//
// Echo does not belong to either. now() puts it on the glass immediately, and
// only falls in behind output that is still arriving, which would otherwise
// land out of order.
//
// drain() reports only what the MACHINE said — never the echo of a keystroke,
// never a painted frame. That number is what the host bleeps on, and the split
// is the whole rule: a key you press makes a key sound, text the machine sends
// makes a bleep, and nothing makes both.

export type Arrival = 'line' | 'char'

const NL = 10

/**
 * A write this big is not somebody talking — it is a program painting.
 *
 * A full-screen repaint is one Surface diff of a couple of thousand bytes, and
 * pacing it would type the chrome onto the glass a character at a time. The
 * rate is for OUTPUT, in the sense the machine has always meant: lines arriving
 * on a wire. A screenful arrives at once, as it does on a real terminal that
 * has just been handed a frame.
 */
const BULK = 512

export class Baud {
  private chunks: { data: Uint8Array; bulk: boolean; echo: boolean }[] = []
  private offset = 0
  /** Bytes owed. Fractional and signed, so a rate below one byte a frame —
   *  and a whole line that overspends — still come out at the right pace. */
  private credit = 0

  constructor(
    private out: (data: Uint8Array) => void,
    public cps = 9600,
    public mode: Arrival = 'line',
  ) {}

  write(data: Uint8Array): void {
    if (data.length) this.chunks.push({ data, bulk: data.length >= BULK, echo: false })
  }

  /** Echo: straight through while nothing is queued ahead of it. */
  now(data: Uint8Array): void {
    if (!data.length) return
    if (this.chunks.length) this.chunks.push({ data, bulk: false, echo: true })
    else this.out(data)
  }

  get idle(): boolean {
    return this.chunks.length === 0
  }

  /**
   * Drop what the line was still carrying. Ctrl-C, and nothing else.
   *
   * A real terminal would go on delivering what it had already buffered, and
   * that is exactly the complaint: the reader pressed stop and watched text
   * keep arriving for another few seconds. The queue here is a simulation, so
   * it stops when the operator says so.
   */
  flush(): void {
    this.chunks.length = 0
    this.offset = 0
    this.credit = 0
  }

  /** dt in milliseconds. Returns the bytes of machine output that went out —
   *  echo and painted frames are not it. */
  drain(dt: number): number {
    // A second's worth is as far behind as it is worth catching up from.
    this.credit = Math.min(this.credit + (this.cps * dt) / 1000, this.cps)
    let sent = 0
    while (this.chunks.length && (this.credit >= 1 || this.chunks[0].bulk || this.chunks[0].echo)) {
      const { data: head, bulk, echo } = this.chunks[0]
      // Echo and painted frames are not text on a wire: they go out WHOLE and
      // cost nothing, however long they had to queue for ordering's sake. Only
      // what the machine says is paced — a line whole, or a character at a time.
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
    if (!this.chunks.length) this.credit = 0
    return sent
  }
}

/** Bytes from `from` up to and including the next newline, else to the end. */
function lineRun(chunk: Uint8Array, from: number): number {
  const nl = chunk.indexOf(NL, from)
  return nl === -1 ? chunk.length - from : nl - from + 1
}
