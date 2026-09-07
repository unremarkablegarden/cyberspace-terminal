// wasm32-wasi (Preview 1) processes. The normal home is a dedicated Worker:
// stdout streams back over postMessage and an interactive stdin blocks the
// worker on a SharedArrayBuffer ring, so programs can read the keyboard
// mid-run. Files named on the command line are staged into the worker and
// written back on close (see wasi.worker.ts). Without Worker support the batch
// fallback runs inline: stdin is pre-read, an interactive tty is handed over
// empty, and there are no files.

import { WASI, WASIProcExit, OpenFile, File, ConsoleStdout } from '@bjorn3/browser_wasi_shim'
import { fs } from '@zenfs/core'
import { readAllBytes } from './pipe.js'
import type { Proc } from './proc.js'
import { basename, dirname, resolve } from './paths.js'
import { createRing, RingWriter, STATE_EOF, STATE_KILLED } from './sabring.js'
import type { RunMessage, OutMessage, StagedFile } from './wasi.worker.js'

/** `\0asm` */
export function isWasm(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d
}

/** Largest file staged into a process, in bytes. */
const STAGE_MAX = 8 * 1024 * 1024

export function runWasi(p: Proc, wasm: Uint8Array): Promise<number> {
  return typeof Worker === 'function' ? runInWorker(p, wasm) : runInline(p, wasm)
}

/**
 * What of the filesystem the program gets: the working directory and home,
 * every argument that names an existing file (with its bytes) or directory,
 * the parent of an argument that names nothing yet, so the program can create
 * it, and the program's own ~/.<name>rc. Arguments starting with '-' are taken
 * as options and skipped.
 */
async function stage(p: Proc): Promise<{ dirs: string[]; files: StagedFile[] }> {
  const dirs = new Set<string>([p.cwd])
  const files: StagedFile[] = []
  const seen = new Set<string>()
  const home = p.env.HOME
  const name = basename(p.argv[0] ?? '')
  const candidates = p.argv.slice(1).filter(a => a && !a.startsWith('-'))
  if (home && name) candidates.push(`${home}/.${name}rc`)
  for (const arg of candidates) {
    const path = resolve(p.cwd, arg)
    if (seen.has(path)) continue
    seen.add(path)
    const st = await fs.promises.stat(path).catch(() => null)
    if (st?.isDirectory()) {
      dirs.add(path)
    } else if (st?.isFile()) {
      if (st.size > STAGE_MAX) continue
      const data: Uint8Array = await fs.promises.readFile(path)
      files.push({ path, data: data.slice().buffer as ArrayBuffer })
    } else if (!st) {
      const parent = dirname(path)
      const pst = await fs.promises.stat(parent).catch(() => null)
      if (pst?.isDirectory()) dirs.add(parent)
    }
  }
  if (home && (await fs.promises.stat(home).catch(() => null))?.isDirectory()) dirs.add(home)
  return { dirs: [...dirs], files }
}

async function runInWorker(p: Proc, wasm: Uint8Array): Promise<number> {
  // An interactive tty feeds the ring; a pipe or file is read in full up front.
  // Without cross-origin isolation there is no SharedArrayBuffer, and the tty is
  // handed over empty as in the inline model.
  let ring: SharedArrayBuffer | undefined
  let stdin: Uint8Array | undefined
  if (p.stdin.isInteractive) {
    if (globalThis.crossOriginIsolated) ring = createRing()
  } else {
    stdin = await readAllBytes(p.stdin)
  }
  const { dirs, files } = await stage(p)
  if (p.signal.aborted) return 130

  const worker = new Worker(new URL('./wasi.worker.ts', import.meta.url), { type: 'module' })
  const writer = ring ? new RingWriter(ring) : null
  const name = p.argv[0] ?? 'wasm'
  const tty = p.tty

  return new Promise<number>(resolve => {
    let settled = false
    // Writes in flight; the exit code waits for them so `vim f; cat f` sees the file.
    const commits: Promise<void>[] = []
    let raw = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      p.signal.removeEventListener('abort', onAbort)
      worker.terminate()
      // Unblock the keyboard pump's pending read.
      if (writer) p.stdin.interrupt?.()
      if (raw) tty?.setCooked()
      void Promise.all(commits).then(() => resolve(code))
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
      else if (m.t === 'file') {
        commits.push(fs.promises.writeFile(m.path, m.d).catch((err: Error) => {
          p.stderr.write(`${name}: ${m.path}: ${err.message}\n`)
        }))
      } else if (m.t === 'raw') {
        raw = m.on
        if (!tty) return
        if (m.on) {
          tty.setRaw()
          // A program that takes the terminal raw is drawing a screen, not
          // printing text; its cursor moves are not paced or bleeped.
          tty.setPaced(false)
        } else {
          tty.setCooked()
        }
      } else if (m.t === 'fault') {
        p.stderr.write(`${name}: ${m.message}\n`)
        finish(1)
      }
    }
    worker.onerror = e => {
      p.stderr.write(`${name}: ${e.message || 'worker failed'}\n`)
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

    // TERM names the builtin termcap a curses-style program picks; LINES and
    // COLUMNS are the size fallback for one without the tty_size import.
    const env: Record<string, string> = { ...p.env, PWD: p.cwd }
    if (tty) Object.assign(env, { TERM: 'xterm', LINES: String(tty.rows), COLUMNS: String(tty.cols) })

    const msg: RunMessage = {
      wasm: wasm.slice().buffer as ArrayBuffer,
      argv: [...p.argv],
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      stdin: stdin ? (stdin.buffer as ArrayBuffer) : undefined,
      ring,
      dirs,
      files,
      tty: tty ? { cols: tty.cols, rows: tty.rows } : undefined,
    }
    const transfer = [msg.wasm, ...files.map(f => f.data)]
    if (msg.stdin) transfer.push(msg.stdin)
    worker.postMessage(msg, transfer)
  })
}

async function runInline(p: Proc, wasm: Uint8Array): Promise<number> {
  // Batch model: a pipe or file is read in full before the run. An interactive
  // tty is handed over empty, since blocking a synchronous program on a keyboard
  // that cannot wake it would hang the tab.
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

  const wasi = new WASI(args, env, fds, { debug: false })
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
