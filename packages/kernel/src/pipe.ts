// Byte streams. A Pipe is both ends; a Source read of null is EOF.

export interface Source {
  read(): Promise<Uint8Array | null>
  /** Resolve pending and future reads with EOF. Used to kill blocked readers. */
  interrupt?(): void
}

export interface Sink {
  write(data: Uint8Array | string): void
  /** Close. File-backed sinks flush here; await the result before relying on the file. */
  end(): void | Promise<void>
}

const enc = new TextEncoder()
export const dec = new TextDecoder()

export function bytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? enc.encode(data) : data
}

export class Pipe implements Source, Sink {
  private chunks: Uint8Array[] = []
  private waiters: ((v: Uint8Array | null) => void)[] = []
  private closed = false

  write(data: Uint8Array | string): void {
    if (this.closed) return
    const b = bytes(data)
    if (!b.length) return
    const w = this.waiters.shift()
    if (w) w(b)
    else this.chunks.push(b)
  }

  end(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w(null)
  }

  interrupt(): void {
    this.end()
  }

  read(): Promise<Uint8Array | null> {
    const c = this.chunks.shift()
    if (c) return Promise.resolve(c)
    if (this.closed) return Promise.resolve(null)
    return new Promise(res => this.waiters.push(res))
  }
}

/** Read a whole source as text. */
export async function readAll(src: Source): Promise<string> {
  const parts: Uint8Array[] = []
  for (;;) {
    const c = await src.read()
    if (c === null) break
    parts.push(c)
  }
  let len = 0
  for (const p of parts) len += p.length
  const buf = new Uint8Array(len)
  let o = 0
  for (const p of parts) { buf.set(p, o); o += p.length }
  return dec.decode(buf)
}

/** A Sink that discards everything. */
export const nullSink: Sink = { write() {}, end() {} }

/** A Source that is immediately EOF. */
export const nullSource: Source = { read: () => Promise.resolve(null) }
