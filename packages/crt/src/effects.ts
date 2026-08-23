// The tube coming on and going out. strike() is implode() played backwards —
// the machine goes out the same way it comes in.
//
// Both draw straight onto the Term planes. The host must stop feeding the grid
// from anywhere else while one runs, and repaint afterwards.
//
// Phases are paced by wall clock, not by step count: a throttled tab (timers
// clamped to 1s) skips frames instead of stretching the movement.

import { BRIGHT, BOLD, NORMAL } from './term.js'
import type { Sound } from './audio.js'

interface TermLike {
  cols: number
  rows: number
  dirty: boolean
  clear(): void
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
}

/** A skipped effect. The caller owns the end state. */
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

/** Run draw(progress 0..1) until dur elapses. Always ends exactly at 1. */
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

/**
 * A CRT does not fade up, it strikes: the gun fires before the yoke deflects
 * properly, so the picture arrives as a dot, springs out into a line, and only
 * then opens into a raster.
 */
export async function strike(term: TermLike, snd?: Sound, signal?: AbortSignal): Promise<void> {
  const { cols, rows } = term
  const midX = cols >> 1
  const midY = rows >> 1

  // Contact, then the transformer taking load. Nothing on screen yet.
  await sleep(420, signal)

  term.put(midX, midY, '●', BRIGHT | BOLD)
  term.dirty = true
  snd?.degauss()
  await sleep(280, signal)

  // Out into a line.
  await anim(300, p => line(term, midX, midY, Math.max(2, Math.round(p * midX))), signal)

  // Open into a raster. Faint — a warming tube is a dim wash, not a flash.
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
  // Settled. The phosphor lets go of the wash on its own.
  term.clear()
  term.dirty = true
  await sleep(420, signal)
}

/**
 * The raster collapsing: picture to a bright line, line to a dot, dot out.
 * Does NOT clear first — whatever is on the glass is what gets crushed.
 */
export async function implode(term: TermLike, snd?: Sound): Promise<void> {
  const { cols, rows } = term
  const midY = rows >> 1
  const midX = cols >> 1

  snd?.powerOff()

  // Down to a line, keeping some noise so the picture reads as being crushed.
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

  // In to a dot.
  await anim(340, p => line(term, midX, midY, Math.round((1 - p) * midX)))

  term.clear()
  term.put(midX, midY, '●', BRIGHT | BOLD)
  term.dirty = true
  await sleep(420)

  // Out. The phosphor takes a few more frames to let go of it.
  term.clear()
  term.dirty = true
  await sleep(900)
}
