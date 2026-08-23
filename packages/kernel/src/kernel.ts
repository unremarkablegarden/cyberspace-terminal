// Program registry, spawn, and boot-time filesystem seeding.

import { fs } from '@zenfs/core'
import type { Program, Proc, SpawnOptions, Task } from './proc.js'
import { basename, join, resolve } from './paths.js'
import { dec, type Sink } from './pipe.js'
import { isWasm, runWasi } from './wasi.js'

export class Kernel {
  readonly fs = fs.promises
  /** Extra executable-file formats, tried after wasm and shebangs. */
  fileHandlers: ((path: string, data: Uint8Array) => Program | null)[] = []
  private programs = new Map<string, Program>()
  private nextPid = 1

  register(name: string, program: Program): void {
    this.programs.set(name, program)
  }

  registerAll(programs: Record<string, Program>): void {
    for (const [name, p] of Object.entries(programs)) this.register(name, p)
  }

  names(): string[] {
    return [...this.programs.keys()].sort()
  }

  /** Program for a command word. Path forms resolve by basename. */
  resolveProgram(word: string): Program | null {
    return this.programs.get(word.includes('/') ? basename(word) : word) ?? null
  }

  /**
   * Resolve a command word to something runnable: builtins by name, then real
   * files — wasm binaries and shebang scripts — by path or $PATH search.
   */
  async resolveExec(word: string, cwd: string, env: Record<string, string>): Promise<Program | null> {
    if (!word.includes('/')) {
      const builtin = this.programs.get(word)
      if (builtin) return builtin
      for (const dir of (env.PATH ?? '/bin').split(':')) {
        const prog = await this.fileProgram(join(dir, word))
        if (prog) return prog
      }
      return null
    }
    return this.fileProgram(resolve(cwd, word))
  }

  private async fileProgram(path: string): Promise<Program | null> {
    const data: Uint8Array | null = await this.fs.readFile(path).catch(() => null)
    if (!data) return null

    if (isWasm(data)) {
      return p => runWasi(p, data)
    }

    // Shebang. `#!builtin` marks the /bin stubs for the registry programs.
    if (data[0] === 0x23 && data[1] === 0x21) {
      const line = dec.decode(data.subarray(2, Math.min(data.length, 256))).split('\n')[0].trim()
      if (line === 'builtin') return this.programs.get(basename(path)) ?? null
      const [interp, ...iargs] = line.split(/\s+/)
      const interpProg = this.programs.get(basename(interp))
      if (!interpProg) return null
      return p => interpProg({ ...p, argv: [interp, ...iargs, path, ...p.argv.slice(1)] })
    }

    for (const handler of this.fileHandlers) {
      const prog = handler(path, data)
      if (prog) return prog
    }
    return null
  }

  spawn(program: Program, opts: SpawnOptions): Task {
    const pid = this.nextPid++
    const ac = new AbortController()

    let killed = false

    /**
     * A killed process no longer owns the terminal.
     *
     * Nothing here can stop a JS function that ignores its abort signal from
     * running to the end of its loop — but it can stop it WRITING. Without this
     * a program killed mid-enumeration goes on printing over the prompt that
     * replaced it, which is the reader pressing Ctrl-C and watching it not
     * work. The sinks are gated rather than the loop, because the loop is the
     * program's business and the glass is not.
     */
    const gate = (sink: Sink): Sink => ({
      write(data) { if (!killed) sink.write(data) },
      end() { if (!killed) return sink.end() },
    })

    const stdout = gate(opts.stdout)
    const stderr = gate(opts.stderr)

    const proc: Proc = {
      pid,
      argv: opts.argv,
      env: { ...opts.env },
      cwd: opts.cwd,
      stdin: opts.stdin,
      stdout,
      stderr,
      signal: ac.signal,
      kernel: this,
      tty: opts.tty,
      out: s => stdout.write(s),
      err: s => stderr.write(s),
    }
    const run = (async () => {
      try {
        const code = await program(proc)
        return typeof code === 'number' ? code : 0
      } catch (e) {
        if (killed) return 130
        stderr.write(`${opts.argv[0] ?? '?'}: ${(e as Error)?.message ?? e}\n`)
        return 1
      }
    })()

    let resolveKill!: (code: number) => void
    const killedP = new Promise<number>(res => { resolveKill = res })

    return {
      pid,
      wait: Promise.race([run, killedP]),
      kill() {
        killed = true
        ac.abort()
        opts.stdin.interrupt?.()
        resolveKill(130)
      },
    }
  }

  /** Create the base tree and stamp /bin with one marker per program. */
  async seed(): Promise<void> {
    const f = this.fs
    for (const dir of ['/bin', '/tmp', '/etc', '/home', '/home/guest']) {
      await f.mkdir(dir).catch(() => {})
    }
    for (const name of this.names()) {
      await f.writeFile(`/bin/${name}`, '#!builtin\n', { mode: 0o755 }).catch(() => {})
    }
  }
}
