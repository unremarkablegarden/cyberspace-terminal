// The display in standby, powering on and powering off. strike() is implode()
// in reverse.
//
// All three draw directly onto the Term planes. The host must stop feeding the
// grid while one runs, and repaint afterwards.
//
// Phases are paced by wall clock rather than step count, so a throttled tab,
// where timers are clamped to 1s, skips frames instead of stretching the
// sequence.

import { BRIGHT, BOLD, DIM, NORMAL } from './term.js'
import type { Sound } from './audio.js'

interface TermLike {
  cols: number
  rows: number
  dirty: boolean
  clear(): void
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
  text(x: number, y: number, str: string, attr?: number, inv?: number): number
}

/** Thrown when an effect is skipped. The caller handles the end state. */
export class Aborted extends Error {}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(new Aborted())
  return new Promise<void>((res, rej) => {
    const timer = setTimeout(() => { cleanup(); res() }, ms)
    const onAbort = () => { clearTimeout(timer); cleanup(); rej(new Aborted()) }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Call draw(progress 0..1) until dur elapses. Always ends at exactly 1. */
async function anim(dur: number, draw: (p: number) => void, signal?: AbortSignal): Promise<void> {
  const t0 = performance.now()
  for (;;) {
    const p = Math.min(1, (performance.now() - t0) / dur)
    draw(p)
    if (p >= 1) return
    await sleep(16, signal)
  }
}

function line(term: TermLike, midX: number, midY: number, half: number): void {
  term.clear()
  for (let col = Math.max(0, midX - half); col <= Math.min(term.cols - 1, midX + half); col++) {
    term.put(col, midY, '█', BRIGHT | BOLD)
  }
  term.dirty = true
}

const STANDBY_HEAD = 'CYBERSPACE  ·  STANDBY'
const STANDBY_HINT = 'PRESS ANY KEY TO POWER ON'
/** Standby blink period in ms. Slower than the cursor's, so the two do not read alike. */
const STANDBY_BLINK = 900

/**
 * Standby: the machine off, waiting to be switched on. Resolves when `signal`
 * aborts, which the host does on the first keypress or tap.
 *
 * A cold start waits here because an AudioContext unlocks only on a user
 * gesture, and every sound strike() and the boot sequence make is dropped while
 * it is suspended. Booting unprompted therefore boots silent.
 *
 * DIM rather than FAINT: FAINT (level 100) is a fill for shadows and panels,
 * and these two lines are read on an unlit screen.
 */
export async function standby(term: TermLike, signal: AbortSignal): Promise<void> {
  const mid = term.rows >> 1
  const draw = (lit: boolean) => {
    term.clear()
    term.text((term.cols - STANDBY_HEAD.length) >> 1, mid - 1, STANDBY_HEAD, DIM)
    if (lit) term.text((term.cols - STANDBY_HINT.length) >> 1, mid + 2, STANDBY_HINT, DIM)
    term.dirty = true
  }

  let lit = true
  draw(lit)
  while (!signal.aborted) {
    // Aborted here is the power switch, not a failure.
    await sleep(STANDBY_BLINK, signal).catch(() => {})
    if (signal.aborted) break
    draw(lit = !lit)
  }
  term.clear()
  term.dirty = true
}

/**
 * The power-on sequence. A CRT does not fade up: the gun fires before the yoke
 * deflects fully, so the picture appears as a dot, expands to a line, and then
 * opens into a raster.
 */
export async function strike(term: TermLike, snd?: Sound, signal?: AbortSignal): Promise<void> {
  const { cols, rows } = term
  const midX = cols >> 1
  const midY = rows >> 1

  // Contact, then the transformer taking load. Nothing is drawn yet.
  await sleep(420, signal)

  term.put(midX, midY, '●', BRIGHT | BOLD)
  term.dirty = true
  snd?.degauss()
  await sleep(280, signal)

  // Expand the dot into a horizontal line.
  await anim(300, p => line(term, midX, midY, Math.max(2, Math.round(p * midX))), signal)

  // Open the line into a raster, faint: a warming tube is dim rather than bright.
  await anim(420, p => {
    const half = Math.round(p * midY)
    term.clear()
    for (let row = midY - half; row <= midY + half; row++) {
      for (let col = 0; col < cols; col++) {
        const centre = row === midY
        term.put(col, row, centre ? '█' : (Math.random() < 0.5 ? '▒' : '░'),
          centre ? BRIGHT | BOLD : NORMAL)
      }
    }
    term.dirty = true
  }, signal)

  snd?.hiss(0.30, 0.10)
  await sleep(120, signal)
  // Settled. The phosphor decay clears the remaining wash.
  term.clear()
  term.dirty = true
  await sleep(420, signal)
}

/**
 * The power-off sequence: the raster collapses to a bright line, then a dot,
 * then out. Does not clear first, so whatever is displayed is what collapses.
 */
export async function implode(term: TermLike, snd?: Sound): Promise<void> {
  const { cols, rows } = term
  const midY = rows >> 1
  const midX = cols >> 1

  snd?.powerOff()

  // Collapse to a line, keeping some noise so the picture reads as compressed.
  await anim(950, p => {
    const half = Math.round((1 - p) * midY)
    term.clear()
    for (let row = midY - half; row <= midY + half; row++) {
      for (let col = 0; col < cols; col++) {
        const ch = half === 0 || Math.random() < 0.55 ? '█' : '▓'
        term.put(col, row, ch, BRIGHT | BOLD)
      }
    }
    term.dirty = true
  })

  // Collapse the line to a dot.
  await anim(340, p => line(term, midX, midY, Math.round((1 - p) * midX)))

  term.clear()
  term.put(midX, midY, '●', BRIGHT | BOLD)
  term.dirty = true
  await sleep(420)

  // Extinguish. The phosphor decay takes a few more frames.
  term.clear()
  term.dirty = true
  await sleep(900)
}
