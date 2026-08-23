// A list landing a line at a time.
//
// `ls` types its listing out because the SHELL is writing it, character by
// character at the line's baud — that is what a machine printing to a terminal
// looks like, and a list that appears whole looks like a picture of one. A
// full-screen program cannot type the same way: it owns the grid and repaints
// all of it, so there is no cursor walking along a line leaving characters
// behind. What it can do is hold lines back, which is all this is.
//
// A LINE is the unit, not a character. Five columns of a table typed left to
// right would spend most of a second on the padding between NAME and
// DESCRIPTION before the first row said anything, and there are twenty rows; a
// line at a time reads as a listing coming down a wire, which is what it is.
//
// It draws nothing and knows nothing about what is being revealed — the owner
// asks `count` and shows that many, and what a line IS is the owner's business:
// `browse` holds back rows of a table, `circ` and `cmail` hold back the
// screenful of history a conversation opens with, and `feed` holds back rows of
// the pane its records are drawn into — which prints the boxes themselves, from
// the top down, since a record the cut lands in is simply a clipped one.

/**
 * Lines a second. A screenful in under half a second — long enough to read as
 * the machine printing, short enough that nobody waiting on the list has to
 * think about it.
 */
export const REVEAL_RATE = 45

/** ~60Hz, the same tick the shell's type-out and cIRC's arrival both run on. */
const TICK_MS = 16

export interface RevealOptions {
  /** A batch landed; repaint. */
  onTick(): void
  /** One bleep per BATCH, as the shell's type-out does it — not per line. */
  onBlip(): void
}

export class Reveal {
  /**
   * Lines landed so far, and `Infinity` when nothing is running — which is both
   * where it starts and where it ends, so an owner can compare against it
   * unconditionally and never ask whether a reveal is happening.
   */
  count = Infinity
  private target = 0
  private t0 = 0
  private timer: number | null = null

  constructor(private opts: RevealOptions) {}

  get running() { return this.timer !== null }

  /**
   * Reveal `target` lines, from now.
   *
   * The caller works the target out, and it should be what will actually be on
   * SCREEN rather than what is in the list: a line past the bottom of the pane
   * is not being revealed to anybody, and a two-hundred-line list would leave a
   * clock running for four seconds after the last visible line had landed.
   *
   * Fewer than two is not a reveal. Starting one would be a bleep and a frame's
   * delay in front of something that was already there.
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
   * On the clock rather than one line per tick, which is the rule everywhere in
   * here: a tick that revealed exactly one line would run at whatever rate
   * setInterval happened to honour that second, and that is not the rate this
   * was tuned at.
   */
  private tick() {
    const due = Math.min(
      this.target,
      Math.floor((performance.now() - this.t0) / 1000 * REVEAL_RATE) + 1,
    )
    if (due <= this.count) return
    this.count = due
    this.opts.onBlip()
    // `finish` repaints on its way out, so the last batch is not painted twice.
    if (this.count >= this.target) this.finish()
    else this.opts.onTick()
  }

  /**
   * Everything, now — the end of a reveal and also the way past one.
   *
   * It repaints, and it has to: a key that only stopped the clock would leave
   * a half-printed list sitting there until something else happened to repaint
   * it, and in `circ` the something else is the next person to speak.
   */
  finish() {
    if (this.timer === null) return
    this.stop()
    this.opts.onTick()
  }

  /**
   * The same, silently — for teardown, where there is no longer anything to
   * paint on and `onTick` is the owner's own draw.
   */
  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.count = Infinity
  }
}
