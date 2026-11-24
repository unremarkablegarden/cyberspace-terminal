// A one-cell Braille spinner for a wait, put before a label: `⠹ LOADING`.
//
// Like Reveal it draws nothing: the owner writes text() where it wrote the
// label and repaints on onTick. The timer runs only between start() and stop(),
// and both may be called on every paint, so an owner can tie the spinner to its
// own loading flag in one place: `loading ? spinner.start() : spinner.stop()`.
//
// Braille needs no font support: crt/bdf.js synthesises all 256 patterns.

/** The `dots` frames of cli-spinners: one dot missing from a six-dot cell, walking round it. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** ms per frame. A full turn is 800 ms. */
const FRAME_MS = 80

export interface SpinnerOptions {
  /** The frame changed; repaint. */
  onTick(): void
}

export class Spinner {
  private frame = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private opts: SpinnerOptions) {}

  get running(): boolean {
    return this.timer !== null
  }

  /** Start turning from the first frame. No effect while running. */
  start(): void {
    if (this.timer) return
    this.frame = 0
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.opts.onTick()
    }, FRAME_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The current frame, one cell wide. */
  get glyph(): string {
    return FRAMES[this.frame]!
  }

  /** `label` with the frame and a space before it. */
  text(label: string): string {
    return `${this.glyph} ${label}`
  }
}
