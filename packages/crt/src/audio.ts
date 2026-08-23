// Sound: sampled mechanical keys + procedural machine noise.
//
// Keys are samples (mechvibes, MIT — see the pack's ATTRIBUTION.txt); everything
// else (hum, flyback whine, beeps, the tube thunk) is synthesised, because it
// needs to be continuous or parameterised and samples would loop.

const ARROWS: Record<string, string> = {
  ArrowUp: 'arrup', ArrowDown: 'arrdown',
  ArrowLeft: 'arrleft', ArrowRight: 'arrright',
}

// Machine output emits blips, not keystrokes. Throttled so a fast type-out
// chatters rather than turning into a solid tone.
const BLIP_MS = 55

/** Loop period of the shared noise buffer. Short periods are audible. */
const NOISE_SEC = 3

const MASTER_GAIN = 0.45
const KEY_GAIN = 0.8
const BOOTUP_GAIN = 0.5

import { KEY_PACKS, DEFAULT_KEY_PACK } from './keypacks.js'

export type SoundChannel = 'background' | 'keys' | 'beeps'
const CHANNELS: SoundChannel[] = ['background', 'keys', 'beeps']

const CHANNEL_FADE = 0.02

export interface SoundAssets {
  /** Key sample URLs by group: `default` (variants) plus space/enter/del/arr*.
   *  Omitted to take the default board; see setKeyPack. */
  keys?: Record<string, string[]>
  /** The startup chime, scored under a cold boot. */
  bootupUrl?: string
}

export class Sound {
  ctx: AudioContext | null = null
  enabled = true
  loaded = false

  private assets: SoundAssets
  private pack = DEFAULT_KEY_PACK
  private buffers = new Map<string, AudioBuffer>()
  private lastTick = 0
  private running = false
  private master!: GainNode
  private bus!: Record<SoundChannel, GainNode>
  private levels: Record<SoundChannel, number> = { background: 1, keys: 1, beeps: 1 }
  private noise!: AudioBuffer
  private drones: AudioScheduledSourceNode[] = []
  private disposed = false

  private bootBuf: AudioBuffer | null = null
  private bootLoad: Promise<void> | null = null
  private bootSrc: AudioBufferSourceNode | null = null
  private bootGain: GainNode | null = null
  // The chime decodes for seconds; a skip in that window cancels via this flag.
  private bootWanted = false

  constructor(assets: SoundAssets) {
    this.assets = assets
  }

  // decodeAudioData works on a suspended context, so buffers warm up
  // immediately and only playback waits for a gesture.
  async load(): Promise<void> {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC || this.ctx || this.disposed) return
    this.ctx = new AC()

    this.master = this.ctx.createGain()
    this.master.gain.value = MASTER_GAIN
    this.master.connect(this.ctx.destination)

    this.bus = {} as Record<SoundChannel, GainNode>
    for (const name of CHANNELS) {
      const g = this.ctx.createGain()
      g.gain.value = this.levels[name]
      g.connect(this.master)
      this.bus[name] = g
    }

    this.noise = this.makeNoise()

    await this.loadPack(this.pack)
    this.loaded = true
  }

  /** The sample table in play: an explicit one from the host, or the pack. */
  private keys(): Record<string, string[]> {
    return this.assets.keys ?? KEY_PACKS[this.pack]?.urls ?? {}
  }

  /** Which board is on. */
  get keyPackName(): string {
    return this.pack
  }

  /**
   * Wear another board. Returns immediately and fetches behind itself, so the
   * first few keys after a switch are silent rather than late — a keyclick that
   * arrives after the letter is worse than one that never came.
   */
  setKeyPack(name: string): string {
    if (!KEY_PACKS[name] || this.assets.keys) return this.pack
    this.pack = name
    if (this.ctx) void this.loadPack(name)
    return this.pack
  }

  private async loadPack(name: string): Promise<void> {
    const urls = this.assets.keys
      ? [...new Set(Object.values(this.assets.keys).flat())]
      : [...new Set(Object.values(KEY_PACKS[name]?.urls ?? {}).flat() as string[])]
    await Promise.all(urls.map(async url => {
      if (this.buffers.has(url)) return
      const buf = await this.decode(url)
      if (buf) this.buffers.set(url, buf)
    }))
  }

  private async decode(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url)
      return await this.ctx!.decodeAudioData(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  /** The machine's permanent noise floor: fan, platters, hum, flyback whine. */
  start(): void {
    if (!this.ctx || this.running || this.disposed) return
    this.running = true
    const ctx = this.ctx
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const t = ctx.currentTime

    const fan = ctx.createBufferSource()
    fan.buffer = this.noise
    fan.loop = true
    const fanLP = ctx.createBiquadFilter()
    fanLP.type = 'lowpass'
    fanLP.frequency.value = 480
    fanLP.Q.value = 0.7
    const fanMotor = ctx.createBiquadFilter()
    fanMotor.type = 'peaking'
    fanMotor.frequency.value = 132
    fanMotor.Q.value = 3
    fanMotor.gain.value = 6
    const fanGain = ctx.createGain()
    fanGain.gain.setValueAtTime(0.0001, t)
    fanGain.gain.exponentialRampToValueAtTime(0.040, t + 1.5)
    fan.connect(fanLP).connect(fanMotor).connect(fanGain).connect(this.bus.background)
    // Random offset so the loops below never share a phase.
    fan.start(t, Math.random() * NOISE_SEC)

    const platter = ctx.createBufferSource()
    platter.buffer = this.noise
    platter.loop = true
    // Off-speed: 3.6s loop against the fan's 3, so they never line up.
    platter.playbackRate.value = 0.83
    const platterBP = ctx.createBiquadFilter()
    platterBP.type = 'bandpass'
    platterBP.frequency.value = 152
    platterBP.Q.value = 6
    const platterGain = ctx.createGain()
    platterGain.gain.setValueAtTime(0.0001, t)
    platterGain.gain.exponentialRampToValueAtTime(0.050, t + 2.2)
    platter.connect(platterBP).connect(platterGain).connect(this.bus.background)
    platter.start(t, Math.random() * NOISE_SEC)

    const hum = ctx.createOscillator()
    hum.type = 'sine'
    hum.frequency.value = 60
    const humGain = ctx.createGain()
    humGain.gain.setValueAtTime(0.0001, t)
    humGain.gain.exponentialRampToValueAtTime(0.010, t + 1.2)

    const whine = ctx.createOscillator()
    whine.type = 'triangle'
    whine.frequency.value = 15720
    const whineGain = ctx.createGain()
    whineGain.gain.setValueAtTime(0.0001, t)
    whineGain.gain.exponentialRampToValueAtTime(0.002, t + 1.8)

    hum.connect(humGain).connect(this.bus.background)
    whine.connect(whineGain).connect(this.bus.background)
    hum.start(t)
    whine.start(t)

    this.drones.push(fan, platter, hum, whine)
  }

  /** A short filtered noise burst — the building block for every mechanical hit. */
  private clack(at: number, freq: number, q: number, gain: number, dur: number): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const off = Math.random() * 0.4
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = freq
    bp.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    src.connect(bp).connect(g).connect(this.bus.beeps)
    src.start(at, off)
    src.stop(at + dur + 0.02)
  }

  private makeNoise(): AudioBuffer {
    const len = this.ctx!.sampleRate * NOISE_SEC
    const buf = this.ctx!.createBuffer(1, len, this.ctx!.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    return buf
  }

  // A suspended context does not advance its clock: scheduled work piles up and
  // fires as one blast when audio unlocks. One-shots check this and stay silent.
  private get live(): AudioContext | null {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.disposed) return null
    return ctx.state === 'running' ? ctx : null
  }

  /** Nudge a suspended context. Only an actual gesture lets it through. */
  resume(): void {
    if (!this.ctx || this.disposed) return
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
  }

  channel(name: SoundChannel): number {
    return this.levels[name]
  }

  setChannel(name: SoundChannel, level: number | boolean): number {
    const value = typeof level === 'boolean' ? (level ? 1 : 0)
      : Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
    this.levels[name] = value
    const g = this.bus?.[name]
    if (g && this.ctx) g.gain.setTargetAtTime(value, this.ctx.currentTime, CHANNEL_FADE)
    return value
  }

  private sample(group: string, gain = KEY_GAIN): void {
    if (!this.enabled || !this.levels.keys || !this.loaded || this.disposed || !this.ctx) return
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    const urls = this.keys()
    const choices = urls[group] || urls.default!
    const buf = this.buffers.get(choices[(Math.random() * choices.length) | 0]!)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    // Rate jitter so a long type-out never settles into an audible loop.
    src.playbackRate.value = 0.97 + Math.random() * 0.06
    const g = this.ctx.createGain()
    g.gain.value = gain
    src.connect(g).connect(this.bus.keys)
    src.start()
  }

  // A real keystroke. Never on auto-repeat: a switch clicks going down, not per
  // repeated character.
  key(e?: { repeat?: boolean; key?: string }): void {
    if (e?.repeat) return
    if (!e || !e.key) return this.sample('default')
    if (e.key === ' ') return this.sample('space')
    if (e.key === 'Enter') return this.sample('enter')
    if (e.key === 'Backspace' || e.key === 'Delete') return this.sample('del')
    const arrow = ARROWS[e.key]
    if (arrow) return this.sample(arrow)
    this.sample('default')
  }

  /** A character emitted by the machine — the movie-computer bleep. */
  blip(hz = 1400, dur = 0.030, jitter = 0.04): void {
    const ctx = this.live
    if (!ctx) return
    const now = performance.now()
    if (now - this.lastTick < BLIP_MS) return
    this.lastTick = now

    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = hz * (1 - jitter + Math.random() * jitter * 2)
    // Roll off the top: a buzz becomes a bleep. Cutoff tracks pitch.
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = hz * 1.86
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.040, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(lp).connect(g).connect(this.bus.beeps)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  /** One row moving under a selection. Pitch held exactly. */
  tick(): void {
    this.blip(2500, 0.030, 0)
  }

  /** Head seeks, randomly spaced — even spacing reads as a drum machine. */
  seek(count = 1): void {
    const ctx = this.live
    if (!ctx) return
    let at = ctx.currentTime
    for (let i = 0; i < count; i++) {
      this.clack(at, 1000 + Math.random() * 1000, 4, 0.05 + Math.random() * 0.05, 0.028)
      at += 0.02 + Math.random() * 0.055
    }
  }

  /** Broadband hiss — a tube with no signal on it. */
  hiss(dur = 0.2, gain = 0.10): void {
    const ctx = this.live
    if (!ctx) return
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.playbackRate.value = 0.9 + Math.random() * 0.3
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 900
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(hp).connect(g).connect(this.bus.beeps)
    src.start(t, Math.random() * NOISE_SEC)
    src.stop(t + dur + 0.02)
  }

  /** Degauss: the coil slammed with mains and left to decay, amplitude beating. */
  degauss(): void {
    const ctx = this.live
    if (!ctx) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(78, t)
    o.frequency.exponentialRampToValueAtTime(50, t + 1.0)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.26, t + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1)
    const beat = ctx.createOscillator()
    beat.type = 'sine'
    beat.frequency.setValueAtTime(38, t)
    beat.frequency.exponentialRampToValueAtTime(19, t + 1.0)
    const beatG = ctx.createGain()
    beatG.gain.value = 0.18
    beat.connect(beatG).connect(g.gain)
    o.connect(g).connect(this.bus.beeps)
    o.start(t); o.stop(t + 1.2)
    beat.start(t); beat.stop(t + 1.2)
  }

  /** The POST beep: a bare square wave into a small paper cone. */
  postBeep(freq = 330, dur = 0.62): void {
    const ctx = this.live
    if (!ctx) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = freq
    const cone = ctx.createBiquadFilter()
    cone.type = 'highpass'
    cone.frequency.value = 150
    const resonance = ctx.createBiquadFilter()
    resonance.type = 'peaking'
    resonance.frequency.value = 1000
    resonance.Q.value = 1.1
    resonance.gain.value = 6
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(0.085, t + 0.004)
    g.gain.setValueAtTime(0.085, t + dur - 0.004)
    g.gain.linearRampToValueAtTime(0.0001, t + dur)
    o.connect(cone).connect(resonance).connect(g).connect(this.bus.beeps)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  beep(freq = 880, dur = 0.09): void {
    const ctx = this.live
    if (!ctx) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.10, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.bus.beeps)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  /**
   * A machine of this era starting up: the switch, the transformer taking load,
   * platters to speed, heads unparking into seek chatter. The sustained fan and
   * whirr live in start(), ramping in underneath.
   */
  powerOn(): void {
    const ctx = this.live
    if (!ctx) return
    const t = ctx.currentTime

    this.clack(t, 2600, 2.5, 0.34, 0.030)
    this.clack(t + 0.035, 900, 1.6, 0.26, 0.070)

    const thump = ctx.createOscillator()
    thump.type = 'sine'
    thump.frequency.setValueAtTime(38, t + 0.06)
    thump.frequency.exponentialRampToValueAtTime(58, t + 0.30)
    const thumpG = ctx.createGain()
    thumpG.gain.setValueAtTime(0.0001, t + 0.06)
    thumpG.gain.exponentialRampToValueAtTime(0.30, t + 0.10)
    thumpG.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
    thump.connect(thumpG).connect(this.bus.beeps)
    thump.start(t + 0.06)
    thump.stop(t + 0.6)
    this.clack(t + 0.06, 170, 1.2, 0.30, 0.22)

    const spin = ctx.createBufferSource()
    spin.buffer = this.noise
    spin.loop = true
    const bearing = ctx.createBiquadFilter()
    bearing.type = 'bandpass'
    bearing.frequency.setValueAtTime(46, t + 0.30)
    bearing.frequency.exponentialRampToValueAtTime(152, t + 1.9)
    bearing.Q.value = 9
    const harmonic = ctx.createBiquadFilter()
    harmonic.type = 'peaking'
    harmonic.frequency.setValueAtTime(96, t + 0.30)
    harmonic.frequency.exponentialRampToValueAtTime(316, t + 1.9)
    harmonic.Q.value = 6
    harmonic.gain.value = 8
    const spinG = ctx.createGain()
    spinG.gain.setValueAtTime(0.0001, t + 0.30)
    spinG.gain.exponentialRampToValueAtTime(0.30, t + 1.1)
    spinG.gain.exponentialRampToValueAtTime(0.0001, t + 3.2)
    spin.connect(bearing).connect(harmonic).connect(spinG).connect(this.bus.beeps)
    spin.start(t + 0.30)
    spin.stop(t + 3.4)

    this.clack(t + 1.10, 1500, 3.0, 0.16, 0.040)
    for (const s of [1.42, 1.49, 1.58, 1.74, 1.79, 2.05]) {
      this.clack(t + s, 1100 + Math.random() * 900, 4, 0.055 + Math.random() * 0.05, 0.028)
    }
  }

  /** The recorded startup chime, under the whole cold boot. Never awaited. */
  async bootup(): Promise<void> {
    if (!this.ctx || this.disposed || !this.assets.bootupUrl) return
    if (!this.enabled || !this.levels.background) return
    this.bootWanted = true
    this.bootLoad ??= this.decode(this.assets.bootupUrl).then(buf => { this.bootBuf = buf })
    await this.bootLoad
    const ctx = this.live
    if (!ctx || !this.bootBuf || this.disposed || !this.bootWanted) return

    this.fadeBootSource()
    const src = ctx.createBufferSource()
    src.buffer = this.bootBuf
    const g = ctx.createGain()
    g.gain.value = BOOTUP_GAIN
    src.connect(g).connect(this.bus.background)
    src.start()
    src.onended = () => {
      if (this.bootSrc === src) { this.bootSrc = null; this.bootGain = null }
    }
    this.bootSrc = src
    this.bootGain = g
  }

  /** Cut the chime short — it outlasts the boot it scores. */
  stopBootup(): void {
    this.bootWanted = false
    this.fadeBootSource()
  }

  private fadeBootSource(): void {
    const src = this.bootSrc
    const g = this.bootGain
    this.bootSrc = null
    this.bootGain = null
    if (!src || !g || !this.ctx) return
    const t = this.ctx.currentTime
    try {
      g.gain.cancelScheduledValues(t)
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
      src.stop(t + 0.3)
    } catch {
      // already stopped
    }
  }

  /** The mirror of powerOn(), with the whole room fading to silence under it. */
  powerOff(): void {
    const ctx = this.live
    if (!ctx) return
    const t = ctx.currentTime

    this.clack(t, 900, 1.6, 0.26, 0.070)
    this.clack(t + 0.045, 2600, 2.5, 0.28, 0.030)

    // The 15.7kHz line whistle dropping away — what a CRT is remembered by.
    const whine = ctx.createOscillator()
    whine.type = 'triangle'
    whine.frequency.setValueAtTime(15720, t + 0.04)
    whine.frequency.exponentialRampToValueAtTime(1800, t + 0.60)
    const whineG = ctx.createGain()
    whineG.gain.setValueAtTime(0.008, t + 0.04)
    whineG.gain.exponentialRampToValueAtTime(0.0001, t + 0.66)
    whine.connect(whineG).connect(this.bus.beeps)
    whine.start(t + 0.04)
    whine.stop(t + 0.7)

    const thump = ctx.createOscillator()
    thump.type = 'sine'
    thump.frequency.setValueAtTime(56, t + 0.06)
    thump.frequency.exponentialRampToValueAtTime(34, t + 0.34)
    const thumpG = ctx.createGain()
    thumpG.gain.setValueAtTime(0.0001, t + 0.06)
    thumpG.gain.exponentialRampToValueAtTime(0.26, t + 0.11)
    thumpG.gain.exponentialRampToValueAtTime(0.0001, t + 0.60)
    thump.connect(thumpG).connect(this.bus.beeps)
    thump.start(t + 0.06)
    thump.stop(t + 0.65)

    const spin = ctx.createBufferSource()
    spin.buffer = this.noise
    spin.loop = true
    const bearing = ctx.createBiquadFilter()
    bearing.type = 'bandpass'
    bearing.frequency.setValueAtTime(152, t + 0.10)
    bearing.frequency.exponentialRampToValueAtTime(44, t + 1.5)
    bearing.Q.value = 9
    const spinG = ctx.createGain()
    spinG.gain.setValueAtTime(0.22, t + 0.10)
    spinG.gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
    spin.connect(bearing).connect(spinG).connect(this.bus.beeps)
    spin.start(t + 0.10, Math.random() * NOISE_SEC)
    spin.stop(t + 1.7)

    this.clack(t + 0.72, 1400, 3.0, 0.14, 0.040)

    const gain = this.master.gain
    gain.cancelScheduledValues(t)
    gain.setValueAtTime(gain.value, t + 0.05)
    gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
  }

  /** Undo powerOff()'s fade, for a cancel that stays on the page. */
  restoreLevel(): void {
    const ctx = this.live
    if (!ctx) return
    const gain = this.master.gain
    const t = ctx.currentTime
    gain.cancelScheduledValues(t)
    gain.setValueAtTime(Math.max(gain.value, 0.0001), t)
    gain.exponentialRampToValueAtTime(MASTER_GAIN, t + 0.35)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try { this.bootSrc?.stop() } catch {}
    this.bootSrc = null
    this.bootGain = null
    this.bootBuf = null
    for (const o of this.drones) {
      try { o.stop() } catch {}
      try { o.disconnect() } catch {}
    }
    this.drones = []
    this.buffers.clear()
    this.loaded = false
    this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}
