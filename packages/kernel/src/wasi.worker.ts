// The WASI process host. Runs one wasm program to completion and dies.
// Interactive stdin blocks right here on the SharedArrayBuffer ring, which is
// the whole reason this is a worker: WASI reads are synchronous, and the main
// thread cannot sleep.

import { WASI, WASIProcExit, OpenFile, File, ConsoleStdout, Fd, wasi } from '@bjorn3/browser_wasi_shim'
import { RingReader } from './sabring.js'

export interface RunMessage {
  wasm: ArrayBuffer
  argv: string[]
  env: string[]
  /** Pre-read stdin for the batch case; the ring replaces it when present. */
  stdin?: ArrayBuffer
  ring?: SharedArrayBuffer
}

export type OutMessage =
  | { t: 'out' | 'err'; d: Uint8Array }
  | { t: 'exit'; code: number }
  | { t: 'fault'; message: string }

const post = (m: OutMessage): void => (self as unknown as Worker).postMessage(m)

/** A terminal-shaped stdin: character device, reads block on the ring. */
class RingStdin extends Fd {
  constructor(private reader: RingReader) {
    super()
  }

  override fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0) }
  }

  override fd_read(size: number): { ret: number; data: Uint8Array } {
    const data = this.reader.readBlocking(size)
    if (data === null) return { ret: wasi.ERRNO_INTR, data: new Uint8Array() }
    return { ret: 0, data }
  }
}

self.onmessage = async (e: MessageEvent<RunMessage>) => {
  const { wasm, argv, env, stdin, ring } = e.data
  try {
    const stdinFd = ring
      ? new RingStdin(new RingReader(ring))
      : new OpenFile(new File(new Uint8Array(stdin ?? new ArrayBuffer(0))))
    const fds = [
      stdinFd,
      // The shim hands out views into wasm memory; copy before they go stale.
      new ConsoleStdout(d => post({ t: 'out', d: d.slice() })),
      new ConsoleStdout(d => post({ t: 'err', d: d.slice() })),
    ]

    const w = new WASI(argv, env, fds, {})
    const module = await WebAssembly.compile(wasm)
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: w.wasiImport,
    })

    let code = 0
    try {
      code = w.start(instance as { exports: { memory: WebAssembly.Memory; _start: () => unknown } })
    } catch (err) {
      if (err instanceof WASIProcExit) code = err.code
      else throw err
    }
    post({ t: 'exit', code })
  } catch (err) {
    post({ t: 'fault', message: String((err as Error)?.message ?? err) })
  }
}
