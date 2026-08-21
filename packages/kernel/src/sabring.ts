// One-way byte ring over a SharedArrayBuffer: the machine writes keyboard
// bytes in, a blocked WASI worker reads them out. Head and tail are monotonic
// counters; the worker sleeps on head with Atomics.wait.

export const RING_CAPACITY = 64 * 1024

const HEAD = 0
const TAIL = 1
const STATE = 2
export const STATE_OPEN = 0
export const STATE_EOF = 1
export const STATE_KILLED = 2

const HEADER_BYTES = 16

export function createRing(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + RING_CAPACITY)
}

export class RingWriter {
  private ctl: Int32Array
  private data: Uint8Array

  constructor(sab: SharedArrayBuffer) {
    this.ctl = new Int32Array(sab, 0, 4)
    this.data = new Uint8Array(sab, HEADER_BYTES)
  }

  private free(): number {
    return RING_CAPACITY - (Atomics.load(this.ctl, HEAD) - Atomics.load(this.ctl, TAIL))
  }

  /** Write what fits now; returns how many bytes went in. */
  write(bytes: Uint8Array): number {
    const n = Math.min(bytes.length, this.free())
    let head = Atomics.load(this.ctl, HEAD)
    for (let i = 0; i < n; i++) {
      this.data[(head + i) % RING_CAPACITY] = bytes[i]
    }
    head += n
    Atomics.store(this.ctl, HEAD, head)
    Atomics.notify(this.ctl, HEAD)
    return n
  }

  /** Write all of it, yielding while the ring is full. */
  async writeAll(bytes: Uint8Array): Promise<void> {
    let off = 0
    while (off < bytes.length) {
      off += this.write(bytes.subarray(off))
      if (off < bytes.length) await new Promise(r => setTimeout(r, 4))
    }
  }

  close(state: number = STATE_EOF): void {
    Atomics.store(this.ctl, STATE, state)
    Atomics.notify(this.ctl, HEAD)
  }
}

export class RingReader {
  private ctl: Int32Array
  private data: Uint8Array

  constructor(sab: SharedArrayBuffer) {
    this.ctl = new Int32Array(sab, 0, 4)
    this.data = new Uint8Array(sab, HEADER_BYTES)
  }

  /** Blocks the calling thread until bytes, EOF (empty result) or kill (null). */
  readBlocking(max: number): Uint8Array | null {
    for (;;) {
      const head = Atomics.load(this.ctl, HEAD)
      const tail = Atomics.load(this.ctl, TAIL)
      if (head !== tail) {
        const n = Math.min(max, head - tail)
        const out = new Uint8Array(n)
        for (let i = 0; i < n; i++) {
          out[i] = this.data[(tail + i) % RING_CAPACITY]
        }
        Atomics.store(this.ctl, TAIL, tail + n)
        return out
      }
      const state = Atomics.load(this.ctl, STATE)
      if (state === STATE_KILLED) return null
      if (state === STATE_EOF) return new Uint8Array()
      Atomics.wait(this.ctl, HEAD, head)
    }
  }
}
