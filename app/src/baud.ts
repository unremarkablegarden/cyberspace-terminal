// Pace output bytes to the parser so text lands like it came down a line.

export class Baud {
  private chunks: Uint8Array[] = []
  private offset = 0

  constructor(private out: (data: Uint8Array) => void, public cps = 9600) {}

  write(data: Uint8Array): void {
    if (data.length) this.chunks.push(data)
  }

  get idle(): boolean {
    return this.chunks.length === 0
  }

  /** dt in milliseconds. Returns how many bytes went out this call. */
  drain(dt: number): number {
    let budget = Math.max(1, Math.round((this.cps * dt) / 1000))
    let sent = 0
    while (budget > 0 && this.chunks.length) {
      const head = this.chunks[0]
      const take = Math.min(budget, head.length - this.offset)
      this.out(head.subarray(this.offset, this.offset + take))
      this.offset += take
      budget -= take
      sent += take
      if (this.offset >= head.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    return sent
  }
}
