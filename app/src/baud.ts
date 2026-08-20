// Pace output bytes to the parser so text lands like it came down a line.

export class Baud {
  private chunks: Uint8Array[] = []
  private offset = 0

  constructor(private out: (data: Uint8Array) => void, public cps = 9600) {}

  write(data: Uint8Array): void {
    if (data.length) this.chunks.push(data)
  }

  drain(dt: number): void {
    let budget = Math.max(1, Math.round(this.cps * dt))
    while (budget > 0 && this.chunks.length) {
      const head = this.chunks[0]
      const take = Math.min(budget, head.length - this.offset)
      this.out(head.subarray(this.offset, this.offset + take))
      this.offset += take
      budget -= take
      if (this.offset >= head.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
  }
}
