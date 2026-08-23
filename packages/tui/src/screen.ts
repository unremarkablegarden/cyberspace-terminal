// The screen stack: what lets a modal cover a program and give the grid back.
//
// A pushed screen owns the whole grid and the keyboard; whatever is underneath
// sits still and sees nothing. Push snapshots the planes and pop restores them,
// so a popup can paint over a program's chrome and leave it exactly as it was —
// the program is not asked to repaint, and cannot get it wrong.
//
// The original carries a wider contract (pointer lock, dropped files, block
// pastes). None of that reaches a pty, so this is the half that does.

import type { Grid } from './surface.js'
import type { KeyInput } from './keys.js'

export interface Screen {
  /** True if the key was consumed. Only the top screen is asked. */
  onKey(e: KeyInput): boolean
  /**
   * True for a key this screen answers with a sound of its own, so the host
   * does not also play the keyclick. Asked before the key is dispatched, so it
   * must answer from the key alone — say yes only for a key ALWAYS answered.
   */
  silentKey?(e: KeyInput): boolean
  draw?(term: Grid): void
  /** Covered by something on top: stop drawing, or a repaint erases it. */
  setActive?(on: boolean): void
  dispose?(): void
}

type Plane = ArrayLike<any> & { slice(): Plane }

interface Snapshot {
  chars: Plane
  attrs: Plane
  inv: Plane
  cx: number
  cy: number
  showCursor: boolean
}

/**
 * The grid a stack restores onto: one that owns its planes.
 *
 * The tube keeps code points in a typed array and a Surface keeps characters in
 * a plain one, so the copy is by `slice` and the paste is by index — the one
 * operation both stores answer to.
 */
export interface StackSurface extends Omit<Grid, 'chars' | 'attrs'> {
  chars: Plane
  attrs: Plane
  /** Called `inverse` on the tube and `inv` on a Surface. Either will do. */
  inv?: Plane
  inverse?: Plane
}

const paste = (into: Plane | undefined, from: Plane | undefined): void => {
  if (!into || !from) return
  for (let i = 0; i < from.length; i++) (into as unknown[])[i] = from[i]
}

export class ScreenStack {
  private stack: Screen[] = []
  private saved: Snapshot[] = []

  constructor(private term: StackSurface) {}

  get top(): Screen | undefined {
    return this.stack[this.stack.length - 1]
  }

  get active(): boolean {
    return this.stack.length > 0
  }

  push(screen: Screen): void {
    this.top?.setActive?.(false)
    this.saved.push({
      chars: this.term.chars.slice(),
      attrs: this.term.attrs.slice(),
      inv: (this.term.inv ?? this.term.inverse)!.slice(),
      // The caret too: whoever is underneath writes where it left off.
      cx: this.term.cx,
      cy: this.term.cy,
      showCursor: this.term.showCursor,
    })
    this.stack.push(screen)
    screen.draw?.(this.term as unknown as Grid)
  }

  pop(): void {
    const screen = this.stack.pop()
    const snap = this.saved.pop()
    if (snap) {
      paste(this.term.chars, snap.chars)
      paste(this.term.attrs, snap.attrs)
      paste(this.term.inv ?? this.term.inverse, snap.inv)
      this.term.dirty = true
      this.term.cx = snap.cx
      this.term.cy = snap.cy
      this.term.showCursor = snap.showCursor
    }
    screen?.dispose?.()
    this.top?.setActive?.(true)
    this.top?.draw?.(this.term as unknown as Grid)
  }

  /** Send a key to the top screen. False when nothing is stacked. */
  key(e: KeyInput): boolean {
    const top = this.top
    if (!top) return false
    const handled = top.onKey(e)
    // Every consumed key repaints; a key may also have popped the top.
    if (handled) this.top?.draw?.(this.term as unknown as Grid)
    return handled
  }
}
