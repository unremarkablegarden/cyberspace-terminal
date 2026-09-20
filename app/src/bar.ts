// The notice bar: one inverse row over the top of whatever is running, for a
// few seconds per notice.
//
// It is painted onto the CRT grid after syncTerm, never into the pty. syncTerm
// diffs the parser's buffer against the grid every frame, so the first frame
// after the bar goes restores the row and the program under it is not involved.

import { NORMAL, BOLD, DIM } from '@cyberspace/crt/term'
import { plain } from '@cyberspace/tui'

export interface BarItem {
  text: string
  /** The command line the chord runs while this item is up. */
  line: string
  /** Called when the chord takes the item. */
  onOpen?: () => void
}

/** How long one notice stays up, in milliseconds. */
const SHOW_MS = 6000
/** Waiting notices past this are replaced by one line giving the count. */
const QUEUE_MAX = 3

interface Grid {
  cols: number
  put(x: number, y: number, code: number, attr: number, inverse: number): void
}

export class NoticeBar {
  private queue: BarItem[] = []
  private current: BarItem | null = null
  private until = 0
  private dropped = 0

  /**
   * `chord` is the key label drawn on the right. `tone` plays once per item,
   * when it goes up rather than when it is queued.
   */
  constructor(private chord: string, private tone: () => void, private enabled: () => boolean) {}

  get up(): boolean {
    return this.current !== null
  }

  show(item: BarItem): void {
    if (!this.enabled()) return
    this.queue.push(item)
    if (this.queue.length > QUEUE_MAX) {
      this.dropped += this.queue.length
      this.queue = []
    }
  }

  /** The item on screen, removed; the chord's target. Null when the bar is down. */
  take(): BarItem | null {
    const item = this.current
    this.current = null
    return item
  }

  clear(): void {
    this.queue = []
    this.current = null
    this.dropped = 0
  }

  /** Advance the queue and draw. Call after syncTerm, on frames where the pty owns the grid. */
  paint(term: Grid, now: number): void {
    if (this.current && now >= this.until) this.current = null
    if (!this.current) {
      if (this.dropped) {
        this.current = { text: `${this.dropped} new; inbox`, line: 'inbox' }
        this.dropped = 0
      } else {
        this.current = this.queue.shift() ?? null
      }
      if (!this.current) return
      this.until = now + SHOW_MS
      this.tone()
    }

    const hint = [...` ${this.chord} Open `]
    // The hint is dropped on a grid too narrow for it and any text.
    const at = term.cols - hint.length > 8 ? term.cols - hint.length : term.cols
    const text = [...(' ' + plain(this.current.text))].slice(0, Math.max(0, at - 1))
    for (let x = 0; x < term.cols; x++) {
      const ch = x >= at ? hint[x - at] : text[x]
      // DIM on an inverse cell dims the ground, which sets the key hint apart.
      term.put(x, 0, ch ? ch.codePointAt(0)! : 32, x >= at ? DIM : ch ? BOLD : NORMAL, 1)
    }
  }
}
