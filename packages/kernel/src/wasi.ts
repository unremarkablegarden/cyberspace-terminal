// wasm32-wasi (Preview 1) processes, batch model: WASI is synchronous, so
// stdin is collected in full before the program starts and stdout streams out
// as it writes. Programs get stdio, args and env — no filesystem access yet;
// that arrives with the Worker-based runner.

import { WASI, WASIProcExit, OpenFile, File, ConsoleStdout } from '@bjorn3/browser_wasi_shim'
import { readAllBytes } from './pipe.js'
import type { Proc } from './proc.js'

/** `\0asm` */
export function isWasm(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d
}

export async function runWasi(p: Proc, wasm: Uint8Array): Promise<number> {
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
