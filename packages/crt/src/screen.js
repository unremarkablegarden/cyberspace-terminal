// Host layer: font fetch, grid + renderer construction, frame loop, keyboard.
// The only file here that touches the DOM.

import { parseBDF } from './bdf.js'
import { Term } from './term.js'
import { CRT } from './crt.js'
import { FONT, GRID, RENDER, PHOSPHOR } from '../config.js'

async function loadFont(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`font ${url}: ${res.status}`)
  return parseBDF(await res.text())
}

/** A running tube. Construct via mount(). */
export class Screen {
  constructor(canvas, term, crt, program) {
    this.canvas = canvas
    this.term = term
    this.crt = crt
    this.program = program
    this.cols = term.cols
    this.rows = term.rows

    this.raf = 0
    this.t0 = 0
    this.blinkAt = 0
    this.stopped = false

    this.onKeyDown = e => { this.program?.key?.(this, e) }
    this.onKeyUp = e => { this.program?.keyUp?.(this, e) }
  }

  /** Set the beam tint by name. See PHOSPHORS in config.js. */
  setPhosphor(name) { this.crt.setPhosphor(name) }

  start() {
    addEventListener('keydown', this.onKeyDown)
    addEventListener('keyup', this.onKeyUp)
    this.program?.init?.(this)
    this.raf = requestAnimationFrame(t => this.frame(t))
  }

  frame(t) {
    if (this.stopped) return
    if (!this.t0) this.t0 = t
    const { term, crt } = this

    if (RENDER.cursor && t - this.blinkAt > RENDER.blinkMs) {
      this.blinkAt = t
      term.cursorVisible = !term.cursorVisible
      term.dirty = true
    }
    term.showCursor = RENDER.cursor

    this.program?.frame?.(this, (t - this.t0) / 1000)

    // The tube renders every frame (noise, roll bar and persistence are all
    // per-frame); the rasteriser runs only when a cell changed.
    if (term.dirty) {
      term.raster()
      crt.upload(term.fb)
    }

    crt.resize(RENDER.pixelBudget)
    crt.render(t / 1000)
    this.raf = requestAnimationFrame(ts => this.frame(ts))
  }

  /** Stop the loop and free the GL context. Not restartable. */
  dispose() {
    this.stopped = true
    cancelAnimationFrame(this.raf)
    removeEventListener('keydown', this.onKeyDown)
    removeEventListener('keyup', this.onKeyUp)
    this.crt.dispose()
  }
}

/**
 * Start a tube on a canvas and run a program on it.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{init?: Function, frame?: Function, key?: Function, keyUp?: Function}} program
 * @returns {Promise<Screen>}
 */
export async function mount(canvas, program) {
  const font = await loadFont(FONT.regular)

  const term = new Term(font, GRID.cols, GRID.rows, GRID.padX, GRID.padY)
  const crt = new CRT(canvas, term.w, term.h, RENDER.superSample)
  crt.setPhosphor(PHOSPHOR)

  // Cuts load behind the roman. Until one arrives BOLD is the smear and ITALIC
  // is roman, as on a family that has neither.
  if (FONT.bold) loadFont(FONT.bold).then(f => { term.bold = f; term.dirty = true }).catch(() => {})
  if (FONT.italic) loadFont(FONT.italic).then(f => { term.italic = f; term.dirty = true }).catch(() => {})

  const screen = new Screen(canvas, term, crt, program)
  screen.start()
  return screen
}
