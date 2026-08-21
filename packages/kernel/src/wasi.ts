// wasm32-wasi (Preview 1) processes. The normal home is a dedicated Worker:
// stdout streams back over postMessage and an interactive stdin blocks the
// worker on a SharedArrayBuffer ring, so programs can read the keyboard
// mid-run. Without Worker support the batch fallback runs inline: stdin is
// pre-read and an interactive tty is handed over empty.

import { WASI, WASIProcExit, OpenFile, File, ConsoleStdout } from '@bjorn3/browser_wasi_shim'
import { readAllBytes } from './pipe.js'
import type { Proc } from './proc.js'
import { createRing, RingWriter, STATE_EOF, STATE_KILLED } from './sabring.js'
import type { RunMessage, OutMessage } from './wasi.worker.js'

/** `\0asm` */
export function isWasm(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d
}

export function runWasi(p: Proc, wasm: Uint8Array): Promise<number> {
  return typeof Worker === 'function' ? runInWorker(p, wasm) : runInline(p, wasm)
}

async function runInWorker(p: Proc, wasm: Uint8Array): Promise<number> {
  // An interactive tty feeds the ring; a pipe or file is read in full up
  // front. No cross-origin isolation means no SharedArrayBuffer — then the
  // tty is handed over empty, as in the inline model.
  let ring: SharedArrayBuffer | undefined
  let stdin: Uint8Array | undefined
  if (p.stdin.isInteractive) {
    if (globalThis.crossOriginIsolated) ring = createRing()
  } else {
    stdin = await readAllBytes(p.stdin)
  }
  if (p.signal.aborted) return 130

  const worker = new Worker(new URL('./wasi.worker.ts', import.meta.url), { type: 'module' })
  const writer = ring ? new RingWriter(ring) : null

  return new Promise<number>(resolve => {
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      p.signal.removeEventListener('abort', onAbort)
      worker.terminate()
      // Unblock the keyboard pump's pending read.
      if (writer) p.stdin.interrupt?.()
      resolve(code)
    }
    const onAbort = (): void => {
      writer?.close(STATE_KILLED)
      finish(130)
    }
    p.signal.addEventListener('abort', onAbort)

    worker.onmessage = (e: MessageEvent<OutMessage>) => {
      const m = e.data
      if (m.t === 'out') p.stdout.write(m.d)
      else if (m.t === 'err') p.stderr.write(m.d)
      else if (m.t === 'exit') finish(m.code)
      else if (m.t === 'fault') {
        p.stderr.write(`${p.argv[0] ?? 'wasm'}: ${m.message}\n`)
        finish(1)
      }
    }
    worker.onerror = e => {
      p.stderr.write(`${p.argv[0] ?? 'wasm'}: ${e.message || 'worker failed'}\n`)
      finish(1)
    }

    // Keyboard pump: tty bytes into the ring until EOF or exit.
    if (writer) {
      void (async () => {
        for (;;) {
          const c = await p.stdin.read()
          if (settled) return
          if (c === null) { writer.close(STATE_EOF); return }
          await writer.writeAll(c)
        }
      })()
    }

    const msg: RunMessage = {
      wasm: wasm.slice().buffer as ArrayBuffer,
      argv: [...p.argv],
      env: Object.entries(p.env).map(([k, v]) => `${k}=${v}`),
      stdin: stdin ? (stdin.buffer as ArrayBuffer) : undefined,
      ring,
    }
    worker.postMessage(msg, msg.stdin ? [msg.wasm, msg.stdin] : [msg.wasm])
  })
}

async function runInline(p: Proc, wasm: Uint8Array): Promise<number> {
  // Batch model: a pipe or file is read in full before the run. An interactive
  // tty is handed over empty — blocking a synchronous program on a keyboard
  // that cannot wake it would hang the machine.
  const input = p.stdin.isInteractive ? new Uint8Array() : await readAllBytes(p.stdin)
  if (p.signal.aborted) return 130

  const args = [...p.argv]
  const env = Object.entries(p.env).map(([k, v]) => `${k}=${v}`)
  const fds = [
    new OpenFile(new File(input)),
    // The shim hands out views into wasm memory; copy before they go stale.
    new ConsoleStdout(d => p.stdout.write(d.slice())),
    new ConsoleStdout(d => p.stderr.write(d.slice())),
  ]

  const wasi = new WASI(args, env, fds, {})
  const module = await WebAssembly.compile(wasm.slice().buffer as ArrayBuffer)
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  })

  try {
    return wasi.start(instance as { exports: { memory: WebAssembly.Memory; _start: () => unknown } })
  } catch (e) {
    if (e instanceof WASIProcExit) return e.code
    throw e
  }
}
