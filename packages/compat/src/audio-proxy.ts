// The AudioContext stand-in installed in the program worker; see audio-wire.ts for the split.
// Every call is queued as an op, and the queue is posted to the page once per microtask.
// Reads the page would answer synchronously are served here: an AudioParam's value is the last value set, and currentTime is extrapolated from the last clock the page sent.
// Not provided: AnalyserNode, PeriodicWave, ScriptProcessorNode, AudioWorklet, media element and stream nodes, and the samples of a decoded buffer.

import {
  DESTINATION, epochMs,
  type AudioClock, type AudioOp, type AudioToWorker, type DecodedMeta, type NodeKind, type Ref,
} from './audio-wire.js'

export interface AudioLink {
  post(ops: AudioOp[]): void
  decode(id: number, bytes: ArrayBuffer): Promise<DecodedMeta>
  resume(): Promise<AudioClock>
}

let link: AudioLink | null = null
let clock: AudioClock = { state: 'suspended', time: 0, at: 0, rate: 48000 }
let queue: AudioOp[] = []
let nextId = 1

const contexts = new Set<ProxyContext>()

// Started sources are held until the page reports them ended, so onended fires for a source the program kept no reference to.
const playing = new Map<number, ScheduledNode>()

// A proxy the program has dropped frees its page-side object.
// The page then drops its reference only; a node that is still playing is kept alive by the browser.
const finalizer = new FinalizationRegistry<number>(id => send({ op: 'free', id }))

function send(op: AudioOp): void {
  if (!link) return
  if (!queue.length) queueMicrotask(flush)
  queue.push(op)
}

function flush(): void {
  const ops = queue
  queue = []
  if (ops.length) link?.post(ops)
}

function num(v: unknown, name: string): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new TypeError(`${name}: not a finite number`)
  return n
}

class ProxyParam {
  #value: number
  readonly defaultValue: number

  constructor(private owner: number, private name: string, value: number) {
    this.#value = value
    this.defaultValue = value
  }

  get ref(): Ref { return { h: this.owner, param: this.name } }

  get value(): number { return this.#value }
  set value(v: number) {
    this.#value = num(v, 'value')
    this.#call('value', [this.#value])
  }

  setValueAtTime(v: number, t: number): this { return this.#to(v, 'setValueAtTime', [v, t]) }
  linearRampToValueAtTime(v: number, t: number): this { return this.#to(v, 'linearRampToValueAtTime', [v, t]) }
  exponentialRampToValueAtTime(v: number, t: number): this { return this.#to(v, 'exponentialRampToValueAtTime', [v, t]) }
  setTargetAtTime(v: number, t: number, c: number): this { return this.#to(v, 'setTargetAtTime', [v, t, c]) }

  setValueCurveAtTime(curve: ArrayLike<number>, t: number, d: number): this {
    const copy = Float32Array.from(curve)
    if (copy.length) this.#value = copy[copy.length - 1]!
    this.#call('setValueCurveAtTime', [copy, num(t, 'startTime'), num(d, 'duration')])
    return this
  }

  cancelScheduledValues(t: number): this { this.#call('cancelScheduledValues', [num(t, 'cancelTime')]); return this }
  cancelAndHoldAtTime(t: number): this { this.#call('cancelAndHoldAtTime', [num(t, 'cancelTime')]); return this }

  // value reports the target of the last automation call; the page does not report the curve in between.
  #to(v: number, method: string, args: number[]): this {
    const nums = args.map((a, i) => num(a, i ? 'time' : 'value'))
    this.#value = nums[0]!
    this.#call(method, nums)
    return this
  }

  #call(method: string, args: unknown[]): void {
    send({ op: 'param', id: this.owner, param: this.name, method, args })
  }
}

function refOf(x: unknown): Ref {
  if (x instanceof ProxyNode) return { h: x.id }
  if (x instanceof ProxyParam) return x.ref
  throw new TypeError('connect: not an AudioNode or AudioParam')
}

class ProxyNode extends EventTarget {
  readonly id: number
  readonly context: ProxyContext
  channelCount = 2
  channelCountMode = 'max'
  channelInterpretation = 'speakers'

  constructor(context: unknown, kind: NodeKind | null, args: number[] = []) {
    super()
    if (!(context instanceof ProxyContext)) throw new TypeError('AudioNode: first argument must be an AudioContext')
    this.context = context
    if (kind === null) {
      this.id = DESTINATION
      return
    }
    this.id = nextId++
    send({ op: 'new', id: this.id, kind, args })
    finalizer.register(this, this.id)
  }

  get numberOfInputs(): number { return 1 }
  get numberOfOutputs(): number { return 1 }

  connect<T>(dest: T, output = 0, input = 0): T {
    send({ op: 'call', id: this.id, method: 'connect', args: [refOf(dest), output, input] })
    return dest
  }

  disconnect(...args: unknown[]): void {
    send({ op: 'call', id: this.id, method: 'disconnect', args: args.map(a => typeof a === 'number' ? a : refOf(a)) })
  }

  protected param(name: string, value: number): ProxyParam {
    return new ProxyParam(this.id, name, value)
  }

  protected prop(key: string, value: unknown): void {
    send({ op: 'set', id: this.id, key, value })
  }

  /** Constructor options: AudioParam names set the param's value, anything else is assigned as a property. */
  protected options(opts: Record<string, unknown> | undefined): void {
    if (!opts) return
    for (const [k, v] of Object.entries(opts)) {
      const target = (this as unknown as Record<string, unknown>)[k]
      if (target instanceof ProxyParam) target.value = v as number
      else if (k in this) (this as unknown as Record<string, unknown>)[k] = v
    }
  }
}

class DestinationNode extends ProxyNode {
  readonly maxChannelCount = 2
  constructor(context: ProxyContext) { super(context, null) }
  override get numberOfOutputs(): number { return 0 }
}

class ScheduledNode extends ProxyNode {
  onended: ((this: ScheduledNode, e: Event) => void) | null = null
  #started = false

  override get numberOfInputs(): number { return 0 }

  start(when = 0, ...rest: number[]): void {
    if (this.#started) throw new DOMException('start() called twice', 'InvalidStateError')
    this.#started = true
    this.beforeStart()
    playing.set(this.id, this)
    send({ op: 'call', id: this.id, method: 'start', args: [num(when, 'when'), ...rest.map(n => num(n, 'offset'))] })
  }

  stop(when = 0): void {
    if (!this.#started) throw new DOMException('stop() before start()', 'InvalidStateError')
    send({ op: 'call', id: this.id, method: 'stop', args: [num(when, 'when')] })
  }

  protected beforeStart(): void {}

  ended(): void {
    playing.delete(this.id)
    const e = new Event('ended')
    this.dispatchEvent(e)
    this.onended?.call(this, e)
  }
}

class GainNodeP extends ProxyNode {
  readonly gain: ProxyParam
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'gain')
    this.gain = this.param('gain', 1)
    this.options(opts)
  }
}

class OscillatorNodeP extends ScheduledNode {
  readonly frequency: ProxyParam
  readonly detune: ProxyParam
  #type = 'sine'
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'oscillator')
    this.frequency = this.param('frequency', 440)
    this.detune = this.param('detune', 0)
    this.options(opts)
  }
  get type(): string { return this.#type }
  set type(v: string) { this.#type = String(v); this.prop('type', this.#type) }
  setPeriodicWave(): void { throw new DOMException('PeriodicWave is not available to programs', 'NotSupportedError') }
}

class BufferSourceNodeP extends ScheduledNode {
  readonly playbackRate: ProxyParam
  readonly detune: ProxyParam
  #buffer: ProxyBuffer | null = null
  #loop = false
  #loopStart = 0
  #loopEnd = 0
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'bufferSource')
    this.playbackRate = this.param('playbackRate', 1)
    this.detune = this.param('detune', 0)
    this.options(opts)
  }
  get buffer(): ProxyBuffer | null { return this.#buffer }
  set buffer(b: ProxyBuffer | null) {
    if (b !== null && !(b instanceof ProxyBuffer)) throw new TypeError('buffer: not an AudioBuffer')
    this.#buffer = b
    b?.sync()
    this.prop('buffer', b ? { h: b.id } : null)
  }
  get loop(): boolean { return this.#loop }
  set loop(v: boolean) { this.#loop = !!v; this.prop('loop', this.#loop) }
  get loopStart(): number { return this.#loopStart }
  set loopStart(v: number) { this.#loopStart = num(v, 'loopStart'); this.prop('loopStart', this.#loopStart) }
  get loopEnd(): number { return this.#loopEnd }
  set loopEnd(v: number) { this.#loopEnd = num(v, 'loopEnd'); this.prop('loopEnd', this.#loopEnd) }
  // Samples written between assigning the buffer and start() are sent here; start() is where Web Audio reads them.
  protected override beforeStart(): void { this.#buffer?.sync() }
}

class BiquadNodeP extends ProxyNode {
  readonly frequency: ProxyParam
  readonly detune: ProxyParam
  readonly Q: ProxyParam
  readonly gain: ProxyParam
  #type = 'lowpass'
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'biquad')
    this.frequency = this.param('frequency', 350)
    this.detune = this.param('detune', 0)
    this.Q = this.param('Q', 1)
    this.gain = this.param('gain', 0)
    this.options(opts)
  }
  get type(): string { return this.#type }
  set type(v: string) { this.#type = String(v); this.prop('type', this.#type) }
}

class DelayNodeP extends ProxyNode {
  readonly delayTime: ProxyParam
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'delay', [num(opts?.maxDelayTime ?? 1, 'maxDelayTime')])
    this.delayTime = this.param('delayTime', 0)
    const { maxDelayTime: _, ...rest } = opts ?? {}
    this.options(rest)
  }
}

class PannerNodeP extends ProxyNode {
  readonly pan: ProxyParam
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'panner')
    this.pan = this.param('pan', 0)
    this.options(opts)
  }
}

class CompressorNodeP extends ProxyNode {
  readonly threshold: ProxyParam
  readonly knee: ProxyParam
  readonly ratio: ProxyParam
  readonly attack: ProxyParam
  readonly release: ProxyParam
  readonly reduction = 0
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'compressor')
    this.threshold = this.param('threshold', -24)
    this.knee = this.param('knee', 30)
    this.ratio = this.param('ratio', 12)
    this.attack = this.param('attack', 0.003)
    this.release = this.param('release', 0.25)
    this.options(opts)
  }
}

class ShaperNodeP extends ProxyNode {
  #curve: Float32Array | null = null
  #oversample = 'none'
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'shaper')
    this.options(opts)
  }
  get curve(): Float32Array | null { return this.#curve }
  set curve(v: ArrayLike<number> | null) {
    this.#curve = v ? Float32Array.from(v) : null
    this.prop('curve', this.#curve)
  }
  get oversample(): string { return this.#oversample }
  set oversample(v: string) { this.#oversample = String(v); this.prop('oversample', this.#oversample) }
}

class ConvolverNodeP extends ProxyNode {
  #buffer: ProxyBuffer | null = null
  #normalize = true
  constructor(context: unknown, opts?: Record<string, unknown>) {
    super(context, 'convolver')
    this.options(opts)
  }
  get buffer(): ProxyBuffer | null { return this.#buffer }
  set buffer(b: ProxyBuffer | null) {
    if (b !== null && !(b instanceof ProxyBuffer)) throw new TypeError('buffer: not an AudioBuffer')
    this.#buffer = b
    b?.sync()
    this.prop('buffer', b ? { h: b.id } : null)
  }
  get normalize(): boolean { return this.#normalize }
  set normalize(v: boolean) { this.#normalize = !!v; this.prop('normalize', this.#normalize) }
}

/**
 * A buffer the program fills holds its samples here and sends them to the page when a node first uses it, and again after any write.
 * A decoded buffer has its samples on the page only, so its channel data cannot be read.
 */
class ProxyBuffer {
  readonly id: number
  readonly length: number
  readonly sampleRate: number
  readonly numberOfChannels: number
  #data: Float32Array[] | null
  #sent = false

  /** `decoded` is the id the page stored the decoded buffer under. */
  constructor(opts: { length: number; sampleRate: number; numberOfChannels?: number }, decoded?: number) {
    this.id = decoded ?? nextId++
    this.length = Math.floor(num(opts.length, 'length'))
    this.sampleRate = num(opts.sampleRate, 'sampleRate')
    this.numberOfChannels = Math.floor(num(opts.numberOfChannels ?? 1, 'numberOfChannels'))
    if (this.length < 1 || this.numberOfChannels < 1 || this.numberOfChannels > 32) {
      throw new DOMException('AudioBuffer: length or channel count out of range', 'NotSupportedError')
    }
    this.#data = decoded !== undefined ? null : Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length))
    if (decoded !== undefined) this.#sent = true
    finalizer.register(this, this.id)
  }

  get duration(): number { return this.length / this.sampleRate }

  getChannelData(c: number): Float32Array {
    // The caller can write into the returned array, so the next use sends the samples again.
    this.#sent = false
    return this.#channel(c)
  }

  copyFromChannel(dest: Float32Array, c: number, start = 0): void {
    dest.set(this.#channel(c).subarray(start, start + dest.length))
  }

  copyToChannel(src: Float32Array, c: number, start = 0): void {
    this.#channel(c).set(src.subarray(0, this.length - start), start)
    this.#sent = false
  }

  sync(): void {
    if (this.#sent || !this.#data) return
    this.#sent = true
    send({ op: 'buffer', id: this.id, rate: this.sampleRate, data: this.#data.map(d => d.slice()) })
  }

  #channel(c: number): Float32Array {
    if (!this.#data) throw new DOMException('the samples of a decoded buffer are not available to programs', 'NotSupportedError')
    const d = this.#data[c]
    if (!d) throw new DOMException(`channel ${c} out of range`, 'IndexSizeError')
    return d
  }
}

class ProxyContext extends EventTarget {
  readonly destination: DestinationNode
  readonly baseLatency = 0
  readonly outputLatency = 0
  onstatechange: ((this: ProxyContext, e: Event) => void) | null = null
  #closed = false
  #last = 0

  constructor() {
    super()
    this.destination = new DestinationNode(this)
    contexts.add(this)
  }

  get sampleRate(): number { return clock.rate }

  get state(): string { return this.#closed ? 'closed' : clock.state }

  // Extrapolated from the page's last report; kept monotonic, since a new report can land slightly behind the estimate.
  get currentTime(): number {
    const t = clock.state === 'running' ? clock.time + (epochMs() - clock.at) / 1000 : clock.time
    this.#last = Math.max(this.#last, t)
    return this.#last
  }

  getOutputTimestamp(): { contextTime: number; performanceTime: number } {
    return { contextTime: this.currentTime, performanceTime: performance.now() }
  }

  createGain(): GainNodeP { return new GainNodeP(this) }
  createOscillator(): OscillatorNodeP { return new OscillatorNodeP(this) }
  createBufferSource(): BufferSourceNodeP { return new BufferSourceNodeP(this) }
  createBiquadFilter(): BiquadNodeP { return new BiquadNodeP(this) }
  createDelay(maxDelayTime = 1): DelayNodeP { return new DelayNodeP(this, { maxDelayTime }) }
  createStereoPanner(): PannerNodeP { return new PannerNodeP(this) }
  createDynamicsCompressor(): CompressorNodeP { return new CompressorNodeP(this) }
  createWaveShaper(): ShaperNodeP { return new ShaperNodeP(this) }
  createConvolver(): ConvolverNodeP { return new ConvolverNodeP(this) }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): ProxyBuffer {
    return new ProxyBuffer({ numberOfChannels, length, sampleRate })
  }

  decodeAudioData(
    bytes: ArrayBuffer,
    ok?: (b: ProxyBuffer) => void,
    fail?: (e: DOMException) => void,
  ): Promise<ProxyBuffer> {
    const id = nextId++
    const run = async (): Promise<ProxyBuffer> => {
      if (!link) throw new DOMException('no audio', 'NotSupportedError')
      if (!(bytes instanceof ArrayBuffer)) throw new TypeError('decodeAudioData: not an ArrayBuffer')
      const meta = await link.decode(id, bytes).catch((e: unknown) => {
        throw new DOMException((e as Error)?.message ?? 'decode failed', 'EncodingError')
      })
      return new ProxyBuffer({ length: meta.length, sampleRate: meta.rate, numberOfChannels: meta.channels }, id)
    }
    const p = run()
    p.then(b => ok?.(b), (e: DOMException) => fail?.(e))
    return p
  }

  async resume(): Promise<void> {
    if (!link || this.#closed) return
    audioClock(await link.resume())
  }

  // The page context is shared with the terminal, so a program cannot suspend it; this resolves and changes nothing.
  async suspend(): Promise<void> {}

  async close(): Promise<void> {
    if (this.#closed) return
    for (const node of playing.values()) {
      if (node.context === this) try { node.stop() } catch {}
    }
    this.#closed = true
    contexts.delete(this)
    this.#changed()
  }

  #changed(): void {
    const e = new Event('statechange')
    this.dispatchEvent(e)
    this.onstatechange?.call(this, e)
  }

  /** Called when the page reports a state change. */
  stateChanged(): void { if (!this.#closed) this.#changed() }
}

/** A clock report from the page. */
export function audioClock(c: AudioClock): void {
  const changed = c.state !== clock.state
  clock = c
  if (changed) for (const ctx of contexts) ctx.stateChanged()
}

/** Page messages for the stand-in. */
export function audioMessage(m: AudioToWorker): void {
  if (m.t === 'audio-clock') audioClock(m.clock)
  else playing.get(m.id)?.ended()
}

/**
 * Install the stand-in as the worker's Web Audio globals.
 * Under the standard names, so a program written for a page runs unchanged, including `instanceof` checks and `new GainNode(ctx)`.
 */
export function installAudio(initial: AudioClock, l: AudioLink): void {
  link = l
  clock = initial
  const globals: Record<string, unknown> = {
    AudioContext: ProxyContext,
    webkitAudioContext: ProxyContext,
    BaseAudioContext: ProxyContext,
    AudioNode: ProxyNode,
    AudioScheduledSourceNode: ScheduledNode,
    AudioDestinationNode: DestinationNode,
    AudioParam: ProxyParam,
    AudioBuffer: ProxyBuffer,
    GainNode: GainNodeP,
    OscillatorNode: OscillatorNodeP,
    AudioBufferSourceNode: BufferSourceNodeP,
    BiquadFilterNode: BiquadNodeP,
    DelayNode: DelayNodeP,
    StereoPannerNode: PannerNodeP,
    DynamicsCompressorNode: CompressorNodeP,
    WaveShaperNode: ShaperNodeP,
    ConvolverNode: ConvolverNodeP,
  }
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(self, name, { value, configurable: true, writable: true })
  }
}
