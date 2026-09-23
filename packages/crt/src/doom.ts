// DOOM on the tube: the doom.wasm engine (doomgeneric, 640x400) drawing into Term.fb.
//
// Each frame is converted to beam intensity and written straight into the framebuffer while Term.raw is set, so it goes through the same CRT passes and phosphor tint as text.
// The frame is scaled nearest-neighbour onto the area inside the margins; the composite maps the framebuffer onto a 4:3 face, which is DOOM's own display aspect.
//
// Loaded behind a dynamic import: nothing here or the 4.5 MB wasm behind it is fetched until `doom` runs.
// The module is GPL-2.0 with id's shareware WAD compiled in, built by tools/doom/build.sh; see app/public/doom/ATTRIBUTION.txt.
// Sound effects arrive through the module's `sound` imports as raw DMX lumps and are played by DoomAudio; there is no music.

import type { Term } from './term.js'

/** Engine tic, 35 Hz. DOOM counts its physics in tics. */
const TIC_MS = 1000 / 35
/** Largest frame delta fed to the tic accumulator, in ms, so a stalled tab does not replay its absence. */
const MAX_DT = 100
/** Tics run per animation frame at most. */
const MAX_CATCHUP = 2

/**
 * Luma weights over 256, flattened from Rec.601 (77/150/29).
 * At 77 the red health and ammo numerals come out at a third of the white ones and the status bar is unreadable.
 */
const LUMA_R = 96, LUMA_G = 112, LUMA_B = 48

/** Midtone lift. Below about 0.7 the bright end flattens and muzzle flashes stop reading. */
const GAMMA = 0.75

/** Beam byte for each luma value. */
const LUT = (() => {
  const lut = new Uint8Array(256)
  for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, GAMMA))
  return lut
})()

/**
 * KeyboardEvent.key to the module's exported KEY_* globals.
 * Any other single character goes in as its ASCII code (weapons, Y/N, cheats).
 * F-keys are absent: F1 belongs to the host, and save/load (F2/F3) do nothing in this build.
 */
const SPECIAL: Record<string, string> = {
  ArrowLeft: 'KEY_LEFTARROW',
  ArrowRight: 'KEY_RIGHTARROW',
  ArrowUp: 'KEY_UPARROW',
  ArrowDown: 'KEY_DOWNARROW',
  ',': 'KEY_STRAFE_L',
  '.': 'KEY_STRAFE_R',
  Control: 'KEY_FIRE',
  ' ': 'KEY_USE',
  Shift: 'KEY_SHIFT',
  Tab: 'KEY_TAB',
  Escape: 'KEY_ESCAPE',
  Enter: 'KEY_ENTER',
  Backspace: 'KEY_BACKSPACE',
  Alt: 'KEY_ALT',
}

/** Where DoomAudio plays: a running context and a node to connect to. Null while sound is off or locked. */
export type AudioOut = () => { ctx: AudioContext; node: AudioNode } | null

/** DMX sound lump: u16 format (3), u16 sample rate, u32 sample count, then unsigned 8-bit PCM. */
const DMX_HEADER = 8
/** DMX pads the samples with 16 bytes each side; the count includes both. */
const DMX_PAD = 16

interface Voice {
  src: AudioBufferSourceNode
  gain: GainNode
  pan: StereoPannerNode
}

/** Plays the engine's sound effects, one voice per engine channel. */
class DoomAudio {
  /** Decoded lumps by lump number. The WAD is fixed, so the cache is never invalidated. */
  private buffers = new Map<number, AudioBuffer | null>()
  private voices = new Map<number, Voice>()

  constructor(private out: AudioOut) {}

  start(channel: number, lumpnum: number, lump: Uint8Array, vol: number, sep: number): void {
    this.stop(channel)
    const out = this.out()
    if (!out) return
    const buf = this.decode(out.ctx, lumpnum, lump)
    if (!buf) return
    const src = out.ctx.createBufferSource()
    src.buffer = buf
    const gain = out.ctx.createGain()
    const pan = out.ctx.createStereoPanner()
    this.params(gain, pan, vol, sep)
    src.connect(gain).connect(pan).connect(out.node)
    const voice = { src, gain, pan }
    src.onended = () => { if (this.voices.get(channel) === voice) this.voices.delete(channel) }
    this.voices.set(channel, voice)
    src.start()
  }

  update(channel: number, vol: number, sep: number): void {
    const v = this.voices.get(channel)
    if (v) this.params(v.gain, v.pan, vol, sep)
  }

  stop(channel: number): void {
    const v = this.voices.get(channel)
    if (!v) return
    this.voices.delete(channel)
    v.src.onended = null
    v.src.stop()
    v.src.disconnect()
  }

  playing(channel: number): boolean {
    return this.voices.has(channel)
  }

  stopAll(): void {
    for (const channel of [...this.voices.keys()]) this.stop(channel)
  }

  /** vol 0-127, sep 0-254 with 128 centre (the engine clamps both). */
  private params(gain: GainNode, pan: StereoPannerNode, vol: number, sep: number): void {
    gain.gain.value = vol / 127
    pan.pan.value = Math.max(-1, Math.min(1, (sep - 127) / 127))
  }

  private decode(ctx: AudioContext, lumpnum: number, lump: Uint8Array): AudioBuffer | null {
    const cached = this.buffers.get(lumpnum)
    if (cached !== undefined) return cached
    let buf: AudioBuffer | null = null
    const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength)
    const ok = lump.byteLength >= DMX_HEADER && view.getUint16(0, true) === 3
    const rate = ok ? view.getUint16(2, true) : 0
    const count = ok ? view.getUint32(4, true) : 0
    // The same bounds Chocolate Doom checks before accepting a lump.
    if (rate > 0 && count > DMX_PAD * 2 && count <= lump.byteLength - DMX_HEADER) {
      const n = count - DMX_PAD * 2
      const start = DMX_HEADER + DMX_PAD
      // createBuffer takes 3000-768000 Hz, which covers DMX's 11025 and 22050.
      buf = ctx.createBuffer(1, n, rate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < n; i++) data[i] = (lump[start + i]! - 128) / 128
    }
    this.buffers.set(lumpnum, buf)
    return buf
  }
}

interface Exports {
  memory: WebAssembly.Memory
  initGame(): void
  tickGame(): void
  reportKeyDown(k: number): void
  reportKeyUp(k: number): void
}

/** Exported wasm globals arrive as WebAssembly.Global objects. */
function globalValue(v: unknown): number {
  return typeof v === 'number' ? v : Number((v as WebAssembly.Global).value)
}

/** The running game. Construct with loadDoom. */
export class DoomGame {
  private raf = 0
  private acc = 0
  private prev = 0
  private running = false
  private term: Term | null = null
  /** Source index per destination pixel, rebuilt when the framebuffer changes. See blit. */
  private mapFb: Uint8Array | null = null
  private mapX = new Int32Array(0)
  private mapY = new Int32Array(0)

  /**
   * Called once when the engine stops on its own.
   * The module has no quit import, so confirming Quit Game in DOOM's menu ends in a wasm trap; any trap is taken as the game ending.
   */
  onExit: (() => void) | null = null

  constructor(private ex: Exports, private keys: Map<string, number>, private audio: DoomAudio) {}

  /** Start ticking into `term`. The caller sets term.raw first. */
  start(term: Term): void {
    if (this.running) return
    this.running = true
    this.term = term
    this.ex.initGame()
    this.prev = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  /** Stop ticking. The engine keeps its state but is not restarted. */
  stop(): void {
    this.running = false
    this.term = null
    cancelAnimationFrame(this.raf)
    this.audio.stopAll()
  }

  /** Report a key press. False for a key DOOM has no use for. */
  keyDown(key: string): boolean {
    const k = this.code(key)
    if (k < 0) return false
    this.ex.reportKeyDown(k)
    return true
  }

  keyUp(key: string): boolean {
    const k = this.code(key)
    if (k < 0) return false
    this.ex.reportKeyUp(k)
    return true
  }

  private code(key: string): number {
    const special = this.keys.get(key)
    if (special !== undefined) return special
    return key.length === 1 ? key.charCodeAt(0) : -1
  }

  private loop = (t: number) => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    this.acc += Math.min(t - this.prev, MAX_DT)
    this.prev = t
    let ticked = 0
    while (this.acc >= TIC_MS && ticked < MAX_CATCHUP) {
      this.acc -= TIC_MS
      ticked++
      try {
        this.ex.tickGame()
      } catch {
        this.stop()
        this.onExit?.()
        return
      }
    }
    // Time past the catch-up cap is dropped rather than carried into the next frame.
    if (this.acc > TIC_MS) this.acc = 0
  }

  /** One engine frame into the framebuffer. Called by the module's drawFrame import. */
  blit(ptr: number, w: number, h: number): void {
    const term = this.term
    if (!term) return
    const { fb, w: tw, h: th, padX, padY } = term
    const dw = tw - padX * 2
    const dh = th - padY * 2
    if (dw <= 0 || dh <= 0) return

    // A font change replaces fb with a new size; the margins are cleared once per framebuffer.
    if (fb !== this.mapFb) {
      fb.fill(0)
      this.mapFb = fb
      this.mapX = new Int32Array(dw)
      this.mapY = new Int32Array(dh)
      for (let x = 0; x < dw; x++) this.mapX[x] = Math.floor((x + 0.5) * w / dw)
      for (let y = 0; y < dh; y++) this.mapY[y] = Math.floor((y + 0.5) * h / dh) * w
    }

    // A new view each frame: memory.grow detaches the old buffer.
    const src = new Uint32Array(this.ex.memory.buffer, ptr, w * h)
    const mapX = this.mapX
    for (let y = 0; y < dh; y++) {
      const row = this.mapY[y]!
      let d = (padY + y) * tw + padX
      for (let x = 0; x < dw; x++, d++) {
        // The module writes ARGB words; little-endian memory reads them as BGRA bytes.
        const p = src[row + mapX[x]!]!
        fb[d] = LUT[(((p >>> 16) & 255) * LUMA_R + ((p >>> 8) & 255) * LUMA_G + (p & 255) * LUMA_B) >>> 8]!
      }
    }
    term.dirty = true
  }
}

/** Fetch and instantiate the module at `url`. Frames and sounds start only after DoomGame.start. */
export async function loadDoom(url: string, out: AudioOut): Promise<DoomGame> {
  let memory: WebAssembly.Memory | null = null
  let width = 0
  let height = 0
  let game: DoomGame | null = null
  const audio = new DoomAudio(out)

  const text = new TextDecoder()
  const readString = (ptr: number, len: number) =>
    memory ? text.decode(new Uint8Array(memory.buffer, ptr, len)) : ''

  const imports: WebAssembly.Imports = {
    loading: {
      onGameInit: (w: number, h: number) => { width = w; height = h },
      // Reporting no WADs makes the module load the shareware WAD built into it.
      wadSizes: () => {},
      readWads: () => {},
    },
    ui: {
      drawFrame: (ptr: number) => { if (width && height) game?.blit(ptr, width, height) },
    },
    runtimeControl: {
      // i64 on the wasm side: a Number here traps on the first call.
      timeInMilliseconds: () => BigInt(Math.trunc(performance.now())),
    },
    console: {
      onInfoMessage: (ptr: number, len: number) => console.log(`[doom] ${readString(ptr, len)}`),
      onErrorMessage: (ptr: number, len: number) => console.error(`[doom] ${readString(ptr, len)}`),
    },
    sound: {
      // The lump is copied or decoded before this returns, so a view over the module's memory is enough.
      startSound: (channel: number, lumpnum: number, ptr: number, len: number, vol: number, sep: number) => {
        if (memory) audio.start(channel, lumpnum, new Uint8Array(memory.buffer, ptr, len), vol, sep)
      },
      stopSound: (channel: number) => audio.stop(channel),
      updateSoundParams: (channel: number, vol: number, sep: number) => audio.update(channel, vol, sep),
      isSoundPlaying: (channel: number) => (audio.playing(channel) ? 1 : 0),
    },
    // Newer wasi-libc reads the clock through WASI; upstream's shim covers only fd and exit calls.
    wasi_snapshot_preview1: {
      clock_time_get: (id: number, _precision: bigint, ptr: number) => {
        if (!memory) return 8
        const ms = id === 0 ? Date.now() : performance.now()
        new DataView(memory.buffer).setBigUint64(ptr, BigInt(Math.round(ms * 1e6)), true)
        return 0
      },
    },
    // Size 0 for every slot tells the module no save exists, so the load menu shows empty slots.
    gameSaving: {
      sizeOfSaveGame: () => 0,
      readSaveGame: () => 0,
      writeSaveGame: () => 0,
    },
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  // instantiateStreaming rejects a response not served as application/wasm; a dev server may not set it.
  const { instance } = res.headers.get('content-type')?.includes('application/wasm')
    ? await WebAssembly.instantiateStreaming(res, imports)
    : await WebAssembly.instantiate(await res.arrayBuffer(), imports)

  const ex = instance.exports as unknown as Exports
  memory = ex.memory
  const keys = new Map<string, number>()
  for (const [key, name] of Object.entries(SPECIAL)) {
    const g = (instance.exports as Record<string, unknown>)[name]
    if (g !== undefined) keys.set(key, globalValue(g))
  }
  game = new DoomGame(ex, keys, audio)
  return game
}

/** `doom --license`. GPL-2.0 section 3 wants the source offer to travel with the binary. */
export const LICENSE = [
  'DOOM (shareware) (C) 1993 Id Software, Inc. All rights reserved.',
  '',
  'The engine is doom.wasm, a WebAssembly build of doomgeneric, which',
  'descends from Chocolate Doom and from the DOOM source id Software',
  'released in 1997 under the GNU General Public License, version 2.',
  '',
  '  https://github.com/jacobenget/doom.wasm  (tag v0.1.0)',
  '',
  'The binary served here is that source with a sound effects module',
  'added. The changes and the build script are in tools/doom of',
  '',
  '  https://github.com/unremarkablegarden/cyberspace-terminal',
  '',
  'If either ever becomes unavailable, ask and the complete source',
  'will be provided.',
  '',
  'This program comes with ABSOLUTELY NO WARRANTY. It is free software,',
  'and you are welcome to redistribute it under the terms of the GPL:',
  '',
  '  https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
  '',
  "The shareware WAD is distributed under id Software's shareware terms,",
  'unmodified and at no charge. Full notice: /doom/ATTRIBUTION.txt',
]
