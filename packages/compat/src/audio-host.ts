// Applies a worker program's Web Audio ops to the terminal's context; see audio-wire.ts for the split.
// One host per run.
// Every op is checked against the tables in audio-wire.ts before it touches a real object: the node kinds, each kind's properties and AudioParams, and the AudioParam methods.
// Nothing else on the context is reachable, so a program cannot close or suspend the terminal's own audio.
// Web Audio throws on bad arguments where the program would have caught it; here the op is dropped.

import {
  NODES, PARAM_METHODS, DESTINATION, epochMs,
  type AudioClock, type AudioToWorker, type DecodedMeta, type NodeKind,
} from './audio-wire.js'

/** The page's side of a program's audio. Absent on a host with no sound. */
export interface CompatAudio {
  /** The context, and the node a program's output connects to, in any state. Null when there is no context. */
  graph(): { ctx: AudioContext; node: AudioNode } | null
  /** False while the terminal's sound is off; the run's output is muted. */
  enabled(): boolean
  /** Resume the context. Resolves when it runs or the attempt gives up. */
  unlock(): Promise<void>
}

type Entry =
  | { kind: NodeKind; node: AudioNode }
  | { kind: 'buffer'; buffer: AudioBuffer }

/** Live objects per run, nodes and buffers together. Ops past the cap are dropped. */
const MAX_OBJECTS = 4096
/** One buffer's samples, all channels: a minute of stereo at 48 kHz. */
const MAX_SAMPLES = 48000 * 60 * 2
/** Encoded bytes per decodeAudioData call. */
const MAX_DECODE = 32 * 1024 * 1024
/** Web Audio's limit for createDelay. */
const MAX_DELAY_SEC = 180
/** How often the clock is re-sent and the mute rechecked, in ms. */
const CLOCK_MS = 1000

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export class AudioHost {
  #out: CompatAudio
  #send: (m: AudioToWorker) => void
  #objects = new Map<number, Entry>()
  // Started and not yet ended, kept apart from #objects so a source the program has freed is still stopped by dispose().
  #playing = new Set<AudioScheduledSourceNode>()
  #ctx: AudioContext | null = null
  #dest: GainNode | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #onState = (): void => this.#tick()

  constructor(out: CompatAudio, send: (m: AudioToWorker) => void) {
    this.#out = out
    this.#send = send
  }

  clock(): AudioClock {
    const ctx = this.#out.graph()?.ctx
    if (!ctx) return { state: 'suspended', time: 0, at: epochMs(), rate: 48000 }
    return { state: ctx.state === 'running' ? 'running' : 'suspended', time: ctx.currentTime, at: epochMs(), rate: ctx.sampleRate }
  }

  /**
   * The run's destination gain, made on first use.
   * Connected to the host's node, so the terminal's channel level applies, and muted while the terminal's sound is off.
   */
  #graph(): { ctx: AudioContext; dest: GainNode } | null {
    if (this.#ctx && this.#dest) return { ctx: this.#ctx, dest: this.#dest }
    const g = this.#out.graph()
    if (!g) return null
    this.#ctx = g.ctx
    this.#dest = g.ctx.createGain()
    this.#dest.gain.value = this.#out.enabled() ? 1 : 0
    this.#dest.connect(g.node)
    g.ctx.addEventListener('statechange', this.#onState)
    this.#timer = setInterval(() => this.#tick(), CLOCK_MS)
    return { ctx: this.#ctx, dest: this.#dest }
  }

  #tick(): void {
    if (this.#dest) this.#dest.gain.value = this.#out.enabled() ? 1 : 0
    this.#send({ t: 'audio-clock', clock: this.clock() })
  }

  apply(ops: unknown): void {
    if (!Array.isArray(ops)) return
    const g = this.#graph()
    if (!g) return
    for (const op of ops) {
      try { this.#apply(g.ctx, g.dest, op as Record<string, unknown>) } catch {}
    }
  }

  #apply(ctx: AudioContext, dest: GainNode, o: Record<string, unknown>): void {
    if (!o || typeof o !== 'object') return
    const id = o.id
    if (!Number.isInteger(id) || (id as number) <= 0) return
    const key = id as number

    switch (o.op) {
      case 'new': {
        if (this.#objects.has(key) || this.#objects.size >= MAX_OBJECTS) return
        const kind = o.kind as NodeKind
        if (typeof kind !== 'string' || !Object.hasOwn(NODES, kind)) return
        const spec = NODES[kind]
        let node: AudioNode
        if (kind === 'delay') {
          const max = Array.isArray(o.args) && finite(o.args[0]) ? o.args[0] : 1
          node = ctx.createDelay(Math.min(MAX_DELAY_SEC, Math.max(0.001, max)))
        } else {
          node = (ctx[spec.create as keyof AudioContext] as () => AudioNode).call(ctx)
        }
        if (spec.source) {
          const src = node as AudioScheduledSourceNode
          src.onended = () => {
            this.#playing.delete(src)
            this.#send({ t: 'audio-ended', id: key })
          }
        }
        this.#objects.set(key, { kind, node })
        return
      }

      case 'set': {
        const e = this.#node(key)
        if (!e || typeof o.key !== 'string' || !(NODES[e.kind].props as readonly string[]).includes(o.key)) return
        let value = o.value
        if (o.key === 'buffer') {
          value = value === null ? null : this.#buffer(value)
          if (value === undefined) return
        } else if (o.key === 'curve') {
          if (value !== null && !(value instanceof Float32Array)) return
        } else if (!['string', 'number', 'boolean'].includes(typeof value)) {
          return
        }
        (e.node as unknown as Record<string, unknown>)[o.key] = value
        return
      }

      case 'param': {
        const e = this.#node(key)
        if (!e || typeof o.param !== 'string' || !(NODES[e.kind].params as readonly string[]).includes(o.param)) return
        const method = o.method as (typeof PARAM_METHODS)[number]
        if (!PARAM_METHODS.includes(method) || !Array.isArray(o.args)) return
        const args = o.args as unknown[]
        const curve = method === 'setValueCurveAtTime'
        if (!args.every((a, i) => curve && i === 0 ? a instanceof Float32Array : finite(a))) return
        const param = (e.node as unknown as Record<string, AudioParam>)[o.param]!
        if (method === 'value') param.value = args[0] as number
        else (param[method] as (...a: unknown[]) => void).apply(param, args)
        return
      }

      case 'call': {
        const e = this.#node(key)
        if (!e || !Array.isArray(o.args)) return
        const args = o.args as unknown[]
        switch (o.method) {
          case 'start':
          case 'stop':
            if (!NODES[e.kind].source || !args.every(finite)) return
            ;(e.node as AudioScheduledSourceNode & { start(...a: number[]): void })[o.method](...args as number[])
            if (o.method === 'start') this.#playing.add(e.node as AudioScheduledSourceNode)
            return
          case 'connect': {
            const target = this.#target(args[0], dest)
            const [out = 0, input = 0] = args.slice(1).map(Number)
            if (target instanceof AudioParam) e.node.connect(target, out)
            else if (target) e.node.connect(target, out, input)
            return
          }
          case 'disconnect': {
            const mapped = args.map(a => finite(a) ? a : this.#target(a, dest))
            if (mapped.some(a => a === null)) return
            ;(e.node.disconnect as (...a: unknown[]) => void).apply(e.node, mapped)
            return
          }
        }
        return
      }

      case 'buffer': {
        const rate = o.rate
        const data = o.data
        if (!finite(rate) || !Array.isArray(data) || !data.length || data.length > 32) return
        if (!data.every(d => d instanceof Float32Array && d.length === data[0].length)) return
        const chans = data as Float32Array<ArrayBuffer>[]
        const length = chans[0]!.length
        if (!length || length * chans.length > MAX_SAMPLES) return
        const had = this.#objects.get(key)
        // A rewrite of a buffer already sent is copied into the same AudioBuffer, so a source that holds it hears the new samples.
        let buffer = had?.kind === 'buffer' ? had.buffer : null
        if (had && !buffer) return
        if (!buffer || buffer.length !== length || buffer.numberOfChannels !== chans.length) {
          if (!had && this.#objects.size >= MAX_OBJECTS) return
          buffer = ctx.createBuffer(chans.length, length, rate)
          this.#objects.set(key, { kind: 'buffer', buffer })
        }
        chans.forEach((d, c) => buffer.copyToChannel(d, c))
        return
      }

      case 'free':
        // The real object is only dereferenced; a node still playing is kept alive by the browser until it ends.
        this.#objects.delete(key)
        return
    }
  }

  #node(id: number): { kind: NodeKind; node: AudioNode } | null {
    const e = this.#objects.get(id)
    return e && e.kind !== 'buffer' ? e as { kind: NodeKind; node: AudioNode } : null
  }

  #buffer(ref: unknown): AudioBuffer | undefined {
    const h = (ref as { h?: unknown })?.h
    const e = typeof h === 'number' ? this.#objects.get(h) : undefined
    return e?.kind === 'buffer' ? e.buffer : undefined
  }

  /** A connect or disconnect target: the run's destination, a node, or one of a node's AudioParams. */
  #target(ref: unknown, dest: GainNode): AudioNode | AudioParam | null {
    if (!ref || typeof ref !== 'object') return null
    const { h, param } = ref as { h?: unknown; param?: unknown }
    if (h === DESTINATION) return param === undefined ? dest : null
    const e = typeof h === 'number' ? this.#node(h) : null
    if (!e) return null
    if (param === undefined) return e.node
    if (typeof param !== 'string' || !(NODES[e.kind].params as readonly string[]).includes(param)) return null
    return (e.node as unknown as Record<string, AudioParam>)[param]!
  }

  async decode(id: unknown, bytes: unknown): Promise<DecodedMeta> {
    const g = this.#graph()
    if (!g) throw new Error('no audio')
    if (!Number.isInteger(id) || (id as number) <= 0 || this.#objects.has(id as number)) throw new Error('bad buffer id')
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_DECODE) throw new Error('decodeAudioData: input too large or not an ArrayBuffer')
    if (this.#objects.size >= MAX_OBJECTS) throw new Error('too many audio objects')
    const buffer = await g.ctx.decodeAudioData(bytes)
    this.#objects.set(id as number, { kind: 'buffer', buffer })
    return { length: buffer.length, rate: buffer.sampleRate, channels: buffer.numberOfChannels }
  }

  async resume(): Promise<AudioClock> {
    this.#graph()
    await this.#out.unlock()
    return this.clock()
  }

  /** Stop every source this run started and cut its output. */
  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#ctx?.removeEventListener('statechange', this.#onState)
    for (const src of this.#playing) {
      try { src.stop() } catch {}
    }
    this.#playing.clear()
    this.#objects.clear()
    try { this.#dest?.disconnect() } catch {}
    this.#dest = null
    this.#ctx = null
  }
}
