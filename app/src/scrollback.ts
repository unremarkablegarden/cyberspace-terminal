import type { Terminal } from '@xterm/headless'
import type { Sound } from '@cyberspace/crt/audio'

/**
 * Scrolled-back view of output that has passed off the top of the screen.
 *
 * Bound to shifted chords, so bare arrows still recall commands. Any output or
 * echo snaps the view back to live: main's Baud sink calls reset() on every
 * write rather than each caller doing it.
 */
export class Scrollback {
  /** How many rows above the live bottom the view sits. 0 is live. */
  back = 0

  constructor(private xt: Terminal, private rows: number, private snd: Sound) {}

  reset(): void {
    this.back = 0
  }

  /** Re-clamps `back` as xterm's buffer grows and trims. Call once per frame. */
  clamp(): void {
    this.back = Math.max(0, Math.min(this.back, this.xt.buffer.active.baseY))
  }

  /** Rows a chord moves the view, or 0 if it is not one of them. */
  moves(key: string, ctrl: boolean, shift: boolean): number {
    if (!shift) return 0
    if (ctrl) return key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? -1 : 0
    return key === 'PageUp' ? this.rows - 1 : key === 'PageDown' ? -(this.rows - 1) : 0
  }

  /**
   * Move the view by one chord. Returns true if the chord was a scroll chord,
   * so the caller stops handling it.
   *
   * Refused on the alt screen, where `circ`, `cmail`, `less` and `edit` paint
   * the full grid and scroll themselves: there is no scrollback behind them.
   */
  key(key: string, ctrl: boolean, shift: boolean): boolean {
    const delta = this.moves(key, ctrl, shift)
    if (!delta) return false

    if (this.xt.buffer.active.type === 'alternate') {
      this.snd.beep(220, 0.04)
      return true
    }
    const next = Math.max(0, Math.min(this.back + delta, this.xt.buffer.active.baseY))
    if (next === this.back) this.snd.beep(220, 0.04)
    else { this.back = next; this.snd.tick() }
    return true
  }
}
