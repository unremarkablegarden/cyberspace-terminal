// Runs a user program in its own realm. The source is imported and executed
// here, not on the page, so it cannot name window, document, the page globals,
// or localStorage; the session token lives on the page and never enters this
// worker. The capabilities a program is allowed (output, tty, sound, the /v1/
// API, feed, image bytes) cross back to the page as messages, brokered there.
//
// stdout, tty control and sound go out as fire-and-forget messages; api, feed
// and image are request/response, keyed by a call id. Keyboard bytes arrive as
// 'stdin' messages and drive a Source the program reads.

import type { Proc } from '@cyberspace/kernel'
import type { Source, Sink } from '@cyberspace/kernel'
import type { CellMetrics } from '@cyberspace/tui'
import {
  runGridProgram, importDefault, asGridProgram, whereInSource, type CompatDeps,
} from './host.js'

/** Main -> worker: start one program. */
export interface RunMessage {
  t: 'run'
  source: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  cols: number
  rows: number
  version?: string
  username?: string
  /** Which brokered capabilities the host wired, so the worker offers only those. */
  caps: { api: boolean; feed: boolean; image: boolean }
  /** The face's cell metrics; present when the page has a picture bank. */
  metrics?: CellMetrics
  /** Handles this run may assign bitmaps to. */
  pict?: { base: number; count: number }
}

/** Main -> worker, after the run has started. */
export type MainMessage =
  | RunMessage
  | { t: 'stdin'; d: Uint8Array }
  | { t: 'stdin-eof' }
  | { t: 'abort' }
  | { t: 'cap-result'; id: number; ok: true; value: unknown }
  | { t: 'cap-result'; id: number; ok: false; error: string }

/** Worker -> main. */
export type WorkerMessage =
  | { t: 'out'; d: string }
  | { t: 'err'; d: string }
  | { t: 'paint'; d: string }
  | { t: 'tty'; op: 'setRaw' | 'setCooked' | 'setPaced'; arg?: boolean }
  | { t: 'snd'; method: string; args: unknown[] }
  | { t: 'copy'; text: string }
  | { t: 'pict'; codes: number[]; bits: Uint16Array[] }
  | { t: 'cap'; id: number; kind: 'api.get' | 'api.post' | 'api.del' | 'feed.page' | 'feed.profile' | 'image'; args: unknown[] }
  | { t: 'exit'; code: number }
  | { t: 'fault'; message: string }

const post = (m: WorkerMessage): void => { (self as unknown as Worker).postMessage(m) }

// One request/response call to the page. Rejects if the host reports an error.
let nextId = 1
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
function call(kind: Extract<WorkerMessage, { t: 'cap' }>['kind'], args: unknown[]): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    post({ t: 'cap', id, kind, args })
  })
}

// stdin as a Source: keyboard bytes arrive as messages and are queued until the
// program reads them; a read with nothing queued waits for the next message.
class MessageStdin implements Source {
  readonly isInteractive = true
  #queue: Uint8Array[] = []
  #waiter: ((v: Uint8Array | null) => void) | null = null
  #closed = false

  push(d: Uint8Array): void {
    if (this.#closed) return
    if (this.#waiter) { const w = this.#waiter; this.#waiter = null; w(d) }
    else this.#queue.push(d)
  }

  close(): void {
    this.#closed = true
    if (this.#waiter) { const w = this.#waiter; this.#waiter = null; w(null) }
  }

  read(): Promise<Uint8Array | null> {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift()!)
    if (this.#closed) return Promise.resolve(null)
    return new Promise(res => { this.#waiter = res })
  }

  interrupt(): void { this.close() }
}

function sink(kind: 'out' | 'err'): Sink {
  return {
    write(data: Uint8Array | string): void {
      post({ t: kind, d: typeof data === 'string' ? data : new TextDecoder().decode(data) })
    },
    end(): void {},
  }
}

let stdin: MessageStdin | null = null
const ac = new AbortController()

self.onmessage = (e: MessageEvent<MainMessage>): void => {
  const m = e.data
  switch (m.t) {
    case 'run':
      void start(m)
      return
    case 'stdin':
      stdin?.push(m.d)
      return
    case 'stdin-eof':
      stdin?.close()
      return
    case 'abort':
      ac.abort()
      stdin?.close()
      return
    case 'cap-result': {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else p.reject(new Error(m.error))
      return
    }
  }
}

/** Broker deps: every capability is a message to the page. */
function brokerDeps(msg: RunMessage): CompatDeps {
  const deps: CompatDeps = {
    username: () => msg.username ?? msg.env.USER ?? 'guest',
    version: msg.version,
    snd: {
      blip: (hz, dur, jitter) => post({ t: 'snd', method: 'blip', args: [hz, dur, jitter] }),
      beep: (freq, dur) => post({ t: 'snd', method: 'beep', args: [freq, dur] }),
      tick: () => post({ t: 'snd', method: 'tick', args: [] }),
      seek: n => post({ t: 'snd', method: 'seek', args: [n] }),
      hiss: (dur, gain) => post({ t: 'snd', method: 'hiss', args: [dur, gain] }),
    },
    copy: text => post({ t: 'copy', text }),
  }
  if (msg.caps.api) {
    deps.api = {
      get: path => call('api.get', [path]),
      post: (path, body) => call('api.post', [path, body]),
      del: path => call('api.del', [path]),
    }
  }
  if (msg.caps.feed) {
    deps.feed = {
      page: (limit, after) => call('feed.page', [limit, after]) as Promise<Record<string, unknown>[]>,
      profile: username => call('feed.profile', [username]) as Promise<Record<string, unknown> | null>,
    }
  }
  if (msg.caps.image) {
    deps.image = url => call('image', [url]) as Promise<Uint8Array>
  }
  const metrics = msg.metrics
  if (metrics) {
    deps.pictures = () => ({
      metrics: () => metrics,
      // Reserved by the page at spawn, so the count asked here is already spent.
      range: () => msg.pict,
      set: (codes, bits) => post({ t: 'pict', codes, bits }),
      // The range is the page's; it releases it when the run ends.
      release: () => {},
    })
  }
  return deps
}

// The Proc a worker program sees. It carries stdio, the tty and the signal, but
// no kernel: an untrusted program gets the capability surface, never the machine.
function makeProc(msg: RunMessage, source: MessageStdin): Proc {
  const proc = {
    pid: 0,
    argv: msg.argv,
    env: msg.env,
    cwd: msg.cwd,
    stdin: source,
    stdout: sink('out'),
    stderr: sink('err'),
    signal: ac.signal,
    out: (s: string) => post({ t: 'out', d: s }),
    err: (s: string) => post({ t: 'err', d: s }),
    tty: {
      cols: msg.cols,
      rows: msg.rows,
      setRaw: () => post({ t: 'tty', op: 'setRaw' }),
      setCooked: () => post({ t: 'tty', op: 'setCooked' }),
      setPaced: (on: boolean) => post({ t: 'tty', op: 'setPaced', arg: on }),
      paint: (s: string) => post({ t: 'paint', d: s }),
      echo: (s: string) => post({ t: 'out', d: s }),
      silence: () => {},
      isSilent: () => false,
      get stdin() { return source },
    },
    setResume: () => {},
    setState: () => {},
    takeState: () => null,
  }
  // kernel is intentionally absent; the cast keeps the Proc type without it.
  return proc as unknown as Proc
}

async function start(msg: RunMessage): Promise<void> {
  stdin = new MessageStdin()
  const proc = makeProc(msg, stdin)
  const deps = brokerDeps(msg)

  let value: unknown
  try {
    value = await importDefault(msg.source)
  } catch (e) {
    const at = whereInSource((e as Error)?.stack)
    post({ t: 'fault', message: `${(e as Error)?.message ?? e}${at ? ` at ${at}` : ''}` })
    post({ t: 'exit', code: 1 })
    return
  }

  // A function default export is a program for this machine; an object with run()
  // is an original /terminal program on the grid.
  if (typeof value === 'function') {
    try {
      const code = await (value as (p: Proc) => Promise<number | void> | number | void)(proc) ?? 0
      post({ t: 'exit', code: typeof code === 'number' ? code : 0 })
    } catch (e) {
      if ((e as Error)?.name === 'Aborted') { post({ t: 'exit', code: 130 }); return }
      const at = whereInSource((e as Error)?.stack)
      post({ t: 'fault', message: `${(e as Error)?.message ?? e}${at ? ` at ${at}` : ''}` })
      post({ t: 'exit', code: 1 })
    }
    return
  }

  const grid = asGridProgram(value)
  if (!grid) {
    post({ t: 'fault', message: 'not a program (missing export default)' })
    post({ t: 'exit', code: 1 })
    return
  }
  const code = await runGridProgram(deps)(proc, grid)
  post({ t: 'exit', code })
}
