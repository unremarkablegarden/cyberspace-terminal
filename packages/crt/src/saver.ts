// Screensavers: the roster, and the screen that hosts them.
//
// Loaded behind a dynamic import. commands/index.ts is static, so the command
// file is a stub and the shell's idle trigger imports this on first use.
// Nothing here is fetched until a saver runs.
//
// One saver per file under savers/, with the shared contract and helpers in
// savers/common.ts. Adding one means a file there, an entry in SAVERS below,
// and a name in SAVER_NAMES in saverdefs.ts.

import type { Screen, KeyInput } from '@cyberspace/tui'
import { SAVER_NAMES } from './saverdefs.js'
import type { Term } from './term.js'
import { blank } from './savers/common.js'
import type { Saver, SaverDeps, SaverSpec } from './savers/common.js'
import { matrix } from './savers/matrix.js'
import { pipes } from './savers/pipes.js'
import { worms } from './savers/worms.js'
import { rain } from './savers/rain.js'
import { stars } from './savers/stars.js'
import { life } from './savers/life.js'
import { fire } from './savers/fire.js'
import { dvd } from './savers/dvd.js'
import { fortune } from './savers/fortune.js'

export type { Saver, SaverDeps, SaverSpec }

// --- the roster ------------------------------------------------------------

export const SAVERS: SaverSpec[] = [
  matrix, pipes, worms, rain, stars, life, fire, dvd, fortune,
]

// CONFIG lists the names module without loading this one, so a saver added
// above without a name there cannot be selected anywhere.
if (SAVERS.length !== SAVER_NAMES.length
    || SAVERS.some((s, i) => s.name !== SAVER_NAMES[i])) {
  throw new Error('saver roster out of step with SAVER_NAMES in saverdefs.ts')
}

/** Look up a saver by name, falling back to the first for an unknown preference. */
export function pickSaver(name: string): SaverSpec {
  return SAVERS.find(s => s.name === name) ?? SAVERS[0]!
}

// --- the host --------------------------------------------------------------

/**
 * The screen every saver runs inside: rAF with a fixed-step accumulator, a dt
 * clamp so a backgrounded tab does not simulate its whole absence in one frame,
 * and dismissal on any key down.
 */
export class SaverScreen implements Screen {
  /** Lets Shell recognise a saver screen without importing the class. See Shell.startSaver. */
  readonly isSaver = true

  private saver: Saver
  private raf = 0
  private prev = 0
  private acc = 0
  private started = false
  private active = true
  private done = false

  constructor(
    private term: Term,
    private spec: SaverSpec,
    private deps: SaverDeps,
    /** Called once on the first key. The owner pops the screen; dispose() cleans up. */
    private onDismiss: () => void,
  ) {
    this.saver = spec.make(term, deps)
  }

  draw(term: Term) {
    // Called on push and again after any consumed key, by which point the key
    // has already dismissed the saver and there is nothing to repaint.
    if (this.started) return
    this.started = true
    blank(term)
    if (this.spec.decay !== undefined) this.deps.setDecay(this.spec.decay)
    this.prev = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  private loop = (t: number) => {
    if (this.done || !this.active) return
    this.raf = requestAnimationFrame(this.loop)
    const step = 1 / this.spec.fps
    // The clamp stops a backgrounded tab simulating its whole absence in one
    // frame, but must exceed the step: capped below it, a saver slower than
    // 10fps would never accumulate a full step and would freeze.
    this.acc = Math.min(this.acc + (t - this.prev) / 1000, Math.max(0.1, step * 2))
    this.prev = t
    while (this.acc >= step) {
      this.acc -= step
      this.saver.frame(this.term, step)
    }
  }

  onKey(e: KeyInput): boolean {
    if (!this.done) this.onDismiss()
    // The key that wakes the saver is consumed. Modifier combinations are passed
    // to the browser, so Cmd+R still reloads, but they wake the saver first.
    return !e.metaKey && !e.altKey
  }

  /** Covered by a modal: stop simulating until revealed again. */
  setActive(active: boolean) {
    this.active = active
    cancelAnimationFrame(this.raf)
    if (active && !this.done && this.started) {
      this.prev = performance.now()
      this.acc = 0
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  dispose() {
    this.done = true
    cancelAnimationFrame(this.raf)
    // Restore the phosphor before the snapshot beneath repaints, or the restored
    // screen smears with nothing running to account for it.
    if (this.spec.decay !== undefined) this.deps.setDecay(null)
    this.saver.dispose?.()
  }
}

// --- the picker ------------------------------------------------------------

/** Name column width in the picker, which the summaries are indented to. */
const NAME_W = 9
/** Width of the gutter carrying the `*` that marks the active saver, including its space. */
const MARK_W = 2

/**
 * The `screensaver` command: a list to arrow through, where Enter both persists
 * the choice and runs it immediately, returning to the list on the waking key.
 * The idle timer and the off switch are in CONFIG with the other settings.
 */
