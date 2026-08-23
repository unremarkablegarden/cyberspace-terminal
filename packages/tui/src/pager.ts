// Pages through pre-folded lines.
//
// A Screen rather than a loop, so the same pager serves `less` at a prompt and
// the source view inside a full-screen program. Folding happens before this, so
// a row means the same thing to the navigation keys and to every paint.

import { NORMAL, DIM, BOLD } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'

export interface PagerOptions {
  lines: string[]
  /** Left of the status bar: a filename, or a description of what is being read. */
  name: string
  onDone(): void
  /** `edge` is a movement key at the top or bottom with nowhere to go. */
  onFeedback?(kind: 'move' | 'edge' | 'close'): void
}

export class Pager implements Screen {
  private top = 0
  /** Rows of text available, excluding the status bar. Set on every draw. */
  private view = 1

  constructor(private opts: PagerOptions) {}

  private get max(): number {
    return Math.max(0, this.opts.lines.length - this.view)
  }

  private step(delta: number): void {
    const next = Math.min(this.max, Math.max(0, this.top + delta))
    if (next === this.top) return this.opts.onFeedback?.('edge')
    this.top = next
    this.opts.onFeedback?.('move')
  }

  silentKey(e: KeyInput): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    return ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey) return false
    switch (e.key) {
      case 'q': case 'Q': case 'Escape':
        this.opts.onFeedback?.('close')
        this.opts.onDone()
        return true
      case 'ArrowDown': case 'j': case 'Enter': this.step(1); return true
      case 'ArrowUp': case 'k': this.step(-1); return true
      case ' ': case 'f': case 'PageDown': this.step(this.view); return true
      case 'b': case 'PageUp': this.step(-this.view); return true
      case 'd': this.step(Math.floor(this.view / 2)); return true
      case 'u': this.step(-Math.floor(this.view / 2)); return true
      case 'g': case 'Home': this.step(-this.opts.lines.length); return true
      case 'G': case 'End': this.step(this.opts.lines.length); return true
    }
    // Everything else is swallowed; an unhandled key would reach the shell
    // hidden behind this screen.
    return true
  }

  draw(term: Grid): void {
    this.view = Math.max(1, term.rows - 1)
    this.top = Math.min(this.top, this.max)

    for (let i = 0; i < this.view; i++) {
      const line = this.opts.lines[this.top + i]
      term.text(0, i, (line ?? '').padEnd(term.cols), NORMAL)
    }

    const end = this.top >= this.max
    const pct = this.opts.lines.length <= this.view ? 'ALL' : end ? 'END' : `${Math.round((this.top / this.max) * 100)}%`
    const left = ` ${this.opts.name} `
    const right = `SPACE b  g G   Q quit   ${pct} `
    const gap = Math.max(1, term.cols - left.length - right.length)
    term.text(0, term.rows - 1, (left + ' '.repeat(gap) + right).slice(0, term.cols).padEnd(term.cols),
              end ? DIM | BOLD : DIM, 1)
    term.showCursor = false
  }
}
