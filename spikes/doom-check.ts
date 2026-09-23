// doom: engine loads, frames land inside the framebuffer margins at every grid size, raster() leaves fb alone while raw.
//   bun spikes/doom-check.ts

import { parseBDF } from '../packages/crt/src/bdf.js'
import { Term } from '../packages/crt/src/term.js'
import { loadDoom } from '../packages/crt/src/doom.ts'

const g = globalThis as Record<string, unknown>
g.requestAnimationFrame = () => 0
g.cancelAnimationFrame = () => {}

let failed = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failed++
}

const root = new URL('..', import.meta.url)
const font = parseBDF(await Bun.file(new URL('packages/crt/fonts/ter-u16n.bdf', root)).text())
const wasm = new URL('app/public/doom/doom-v0.1.0-sfx.wasm', root).href

for (const [cols, rows] of [[80, 25], [44, 20]] as const) {
  const term = new Term(font, cols, rows)
  term.fb.fill(7)
  term.raw = true
  const game = await loadDoom(wasm, () => null)
  game.start(term)
  const ex = (game as unknown as { ex: { tickGame(): void } }).ex
  for (let i = 0; i < 70; i++) ex.tickGame()
  game.stop()

  const { fb, w, h, padX, padY } = term
  let inside = 0, margin = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = fb[y * w + x]!
      const inner = x >= padX && x < w - padX && y >= padY && y < h - padY
      if (inner && v > 0) inside++
      if (!inner && v !== 0) margin++
    }
  }
  check(`${cols}x${rows} (${w}x${h}): frame drawn`, inside > (w * h) / 10)
  check(`${cols}x${rows}: margins cleared`, margin === 0)

  const before = fb.slice()
  term.text(0, 0, 'XXXXXXXX')
  term.raster()
  check(`${cols}x${rows}: raster() is a no-op while raw`, fb.every((v, i) => v === before[i]))
  term.raw = false
  term.raster()
  check(`${cols}x${rows}: raster() draws cells after raw`, fb.some((v, i) => v !== before[i]))
}

// Quit Game from the menu: the module traps on exit, which the loop takes as the game ending.
{
  let t = 0
  const frames: ((t: number) => void)[] = []
  g.requestAnimationFrame = (f: (t: number) => void) => { frames.push(f); return frames.length }
  const run = (n: number) => { for (let i = 0; i < n; i++) frames.shift()?.((t += 1000 / 35)) }
  const term = new Term(font, 80, 25)
  term.raw = true
  const game = await loadDoom(wasm, () => null)
  let exited = 0
  game.onExit = () => exited++
  game.start(term)
  // The loop measures from the performance.now() taken in start().
  t = performance.now()
  const press = (k: string) => { game.keyDown(k); run(3); game.keyUp(k); run(3) }
  run(100)
  press('Escape')
  for (let i = 0; i < 5; i++) press('ArrowDown')
  press('Enter')
  check('menu quit: still running before Y', exited === 0)
  press('y')
  run(200)
  check('menu quit: Y ends the game once', exited === 1)
  check('menu quit: loop stopped', frames.length === 0)
}

// Sound: the menu sound reaches the player as a decoded DMX lump.
{
  const frames: ((t: number) => void)[] = []
  g.requestAnimationFrame = (f: (t: number) => void) => { frames.push(f); return frames.length }
  const started: { rate: number; length: number; gain: number; pan: number }[] = []
  const param = () => ({ value: 0 })
  const panners: { pan: { value: number } }[] = []
  const node = () => ({ connect: (n: unknown) => n, disconnect() {} })
  const ctx = {
    createBuffer: (_c: number, length: number, rate: number) => {
      const data = new Float32Array(length)
      return { length, sampleRate: rate, getChannelData: () => data }
    },
    createGain: () => ({ ...node(), gain: param() }),
    createStereoPanner: () => { const p = { ...node(), pan: param() }; panners.push(p); return p },
    createBufferSource: () => {
      const src = { ...node(), buffer: null as { length: number; sampleRate: number } | null, onended: null, stop() {}, gain: undefined as unknown,
        start() { started.push({ rate: src.buffer!.sampleRate, length: src.buffer!.length, gain: 0, pan: 0 }) } }
      return src
    },
  }
  const term = new Term(font, 80, 25)
  term.raw = true
  const game = await loadDoom(wasm, () => ({ ctx: ctx as unknown as AudioContext, node: node() as unknown as AudioNode }))
  game.start(term)
  // Game tics follow the real clock, so this runs in real time. Escape opens the menu, which plays DSSWTCHN.
  const play = async (ms: number) => {
    const until = performance.now() + ms
    while (performance.now() < until) {
      await Bun.sleep(1000 / 35)
      frames.shift()?.(performance.now())
    }
  }
  await play(500)
  game.keyDown('Escape')
  await play(200)
  game.keyUp('Escape')
  await play(300)
  game.stop()
  check('sound: opening the menu starts a sound', started.length > 0)
  check('sound: DMX decoded at 11025 Hz', started.some(s => s.rate === 11025 && s.length > 100))
  // The menu sound has no position, so DOOM sends NORM_SEP (128): centre, both channels.
  check('sound: menu sound panned centre', panners.length > 0 && panners.every(p => Math.abs(p.pan.value) < 0.01))
  console.log(`     pans: ${panners.map(p => p.pan.value.toFixed(3)).join(' ')}`)
}

if (failed) process.exit(1)
