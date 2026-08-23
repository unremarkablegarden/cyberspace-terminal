// Releases a list one line at a time.
//
// A shell types its output character by character because it writes to the
// terminal directly. A full-screen program cannot: it holds the grid and
// repaints all of it, so there is no cursor leaving characters behind. Holding
// lines back is the equivalent it can do.
//
// The unit is a line rather than a character. Typing a five-column table left
// to right would spend most of a second on padding before the first row said
// anything, across twenty rows.
//
// This draws nothing and knows nothing about the content: the owner reads
// `count` and displays that many rows. What a line means is the owner's
// choice - browse holds back table rows, circ and cmail hold back the opening
// screenful of history, and feed holds back rows of the pane its records are
// drawn into, which reveals the boxes themselves from the top down.

/** Lines per second: a screenful in under half a second. */
export const REVEAL_RATE = 45

/** Tick interval, about 60Hz, matching the shell's type-out and circ's arrival clock. */
const TICK_MS = 16

export interface RevealOptions {
  /** A batch became due; repaint. */
  onTick(): void
  /** Called once per batch rather than per line, matching the shell's type-out. */
  onBlip(): void
}

export class Reveal {
  /**
   * Lines revealed so far, and Infinity when no reveal is running, both before
   * one starts and after it ends. An owner can therefore compare against it
   * without first checking whether a reveal is in progress.
   */
  count = Infinity
  private target = 0
  private t0 = 0
  private timer: number | null = null

  constructor(private opts: RevealOptions) {}

  get running() { return this.timer !== null }

  /**
   * Reveal `target` lines from now.
   *
   * The caller supplies the target, which should be the number of lines that
   * will be visible rather than the length of the list: a line below the pane is
   * revealed to nobody, and a two-hundred-line list would leave the clock
   * running for four seconds after the last visible line appeared.
   *
   * Fewer than two lines starts no reveal, which would only add a bleep and a
   * frame's delay to content already on screen.
   */
  start(target: number) {
    this.stop()
    if (target < 2) return
    this.target = target
    this.count = 0
    this.t0 = performance.now()
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  /**
   * Emit whatever has come due.
   *
   * Computed from elapsed time rather than one line per tick: a tick revealing
   * exactly one line would run at whatever rate setInterval happened to deliver.
   */
  private tick() {
    const due = Math.min(
      this.target,
      Math.floor((performance.now() - this.t0) / 1000 * REVEAL_RATE) + 1,
    )
    if (due <= this.count) return
    this.count = due
    this.opts.onBlip()
    // finish() repaints as it returns, so the last batch is not painted twice.
    if (this.count >= this.target) this.finish()
    else this.opts.onTick()
  }

  /**
   * Reveal everything immediately, ending a reveal or skipping one.
   *
   * Repaints as it returns. Stopping the clock alone would leave a partly
   * revealed list on screen until something else triggered a repaint, which in
   * circ is the next incoming message.
   */
  finish() {
    if (this.timer === null) return
    this.stop()
    this.opts.onTick()
  }

  /** As finish(), without the repaint. For teardown, where there is nothing left to draw on. */
  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.count = Infinity
  }
}
