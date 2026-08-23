// The screen stack, which lets a modal cover a program and then restore it.
//
// A pushed screen holds the whole grid and the keyboard; screens beneath it are
// not drawn and receive no keys. Push snapshots the planes and pop restores
// them, so a popup can paint over a program's chrome without the program having
// to repaint.
//
// Pointer lock, dropped files and block pastes are not modelled here: none of
// them crosses a pty.

import type { Grid } from './surface.js'
import type { KeyInput } from './keys.js'

export interface Screen {
  /** True if the key was consumed. Only the top screen is asked. */
  onKey(e: KeyInput): boolean
  /**
   * True for a key this screen plays its own sound for, so the host suppresses
   * the key click. Called before the key is dispatched, so it must decide from
   * the key alone: return true only for keys the screen always handles.
   */
  silentKey?(e: KeyInput): boolean
  draw?(term: Grid): void
  /** Called when another screen covers this one, which must then stop drawing. */
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
 * A grid a stack can snapshot and restore, meaning one that owns its planes.
 *
 * The CRT grid stores code points in a typed array and a Surface stores
 * characters in a plain one, so copying uses slice and restoring assigns by
 * index, which both support.
 */
export interface StackSurface extends Omit<Grid, 'chars' | 'attrs'> {
  chars: Plane
  attrs: Plane
  /** Named `inverse` on the CRT grid and `inv` on a Surface; either is accepted. */
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
      // The caret is restored too, so the screen beneath resumes where it was.
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
    // Every consumed key repaints, and a key may also have popped the top screen.
    if (handled) this.top?.draw?.(this.term as unknown as Grid)
    return handled
  }
}
