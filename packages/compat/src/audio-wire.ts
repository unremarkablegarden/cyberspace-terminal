// Web Audio for programs in the worker.
// Browsers expose AudioContext on the page only, so the worker gets a stand-in (audio-proxy.ts) that records each call as an op, and the page (audio-host.ts) applies the ops to the terminal's own context.
// This file holds what both sides agree on: the node kinds, which properties and AudioParams each kind may touch, and the messages.
// The page checks every op against these tables, since a worker can post anything.

/** The node kinds a program can create, keyed by the name used in ops. */
export const NODES = {
  gain: { create: 'createGain', params: ['gain'], props: [], source: false },
  oscillator: { create: 'createOscillator', params: ['frequency', 'detune'], props: ['type'], source: true },
  bufferSource: {
    create: 'createBufferSource', params: ['playbackRate', 'detune'],
    props: ['buffer', 'loop', 'loopStart', 'loopEnd'], source: true,
  },
  biquad: { create: 'createBiquadFilter', params: ['frequency', 'detune', 'Q', 'gain'], props: ['type'], source: false },
  delay: { create: 'createDelay', params: ['delayTime'], props: [], source: false },
  panner: { create: 'createStereoPanner', params: ['pan'], props: [], source: false },
  compressor: {
    create: 'createDynamicsCompressor', params: ['threshold', 'knee', 'ratio', 'attack', 'release'],
    props: [], source: false,
  },
  shaper: { create: 'createWaveShaper', params: [], props: ['curve', 'oversample'], source: false },
  convolver: { create: 'createConvolver', params: [], props: ['buffer', 'normalize'], source: false },
} as const

export type NodeKind = keyof typeof NODES

/** AudioParam methods a program may call. `value` is the setter. */
export const PARAM_METHODS = [
  'value', 'setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime',
  'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime',
] as const

/** Handle 0 is the program's destination: a gain the page owns, one per run. */
export const DESTINATION = 0

/** A page-side object by handle, or one AudioParam of a node. */
export interface Ref { h: number; param?: string }

export type AudioOp =
  | { op: 'new'; id: number; kind: NodeKind; args: number[] }
  | { op: 'set'; id: number; key: string; value: unknown }
  | { op: 'param'; id: number; param: string; method: string; args: unknown[] }
  | { op: 'call'; id: number; method: 'start' | 'stop' | 'connect' | 'disconnect'; args: unknown[] }
  | { op: 'buffer'; id: number; rate: number; data: Float32Array[] }
  | { op: 'free'; id: number }

/**
 * The page context's clock at one instant.
 * The worker extrapolates currentTime from it while `state` is running.
 * `at` is epoch ms (timeOrigin + now()), since the page and the worker have different performance.now() origins.
 */
export interface AudioClock {
  state: 'running' | 'suspended'
  time: number
  at: number
  rate: number
}

/** Page to worker. */
export type AudioToWorker =
  | { t: 'audio-clock'; clock: AudioClock }
  | { t: 'audio-ended'; id: number }

/** What decodeAudioData hands back. The samples stay on the page. */
export interface DecodedMeta { length: number; rate: number; channels: number }

/** Epoch ms, comparable between the page and a worker. */
export const epochMs = (): number => performance.timeOrigin + performance.now()
