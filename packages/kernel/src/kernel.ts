// Program registry, spawn, and boot-time filesystem seeding.

import { fs } from '@zenfs/core'
import type { Program, Proc, SpawnOptions, Task } from './proc.js'
import { basename, join, resolve } from './paths.js'
import { dec, type Sink } from './pipe.js'
import { isWasm, runWasi } from './wasi.js'
import { Resume } from './resume.js'
import { Jobs } from './jobs.js'

export class Kernel {
  readonly fs = fs.promises
  /** Release string, stamped by the host at boot. uname(1) reports it. */
  release = '0'
  /** Extra executable-file formats, tried after wasm and shebangs. */
  fileHandlers: ((path: string, data: Uint8Array) => Program | null)[] = []
  /** The job table. See jobs.ts. */
  readonly jobs = new Jobs()
  private programs = new Map<string, Program>()
  private nextPid = 1
  /** Tasks each process spawned on its own terminal, for stop() and cont(). */
  private children = new WeakMap<Proc, Set<Task>>()

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
   * Resolve a command word to something runnable: builtins by name, then files
   * (wasm binaries and shebang scripts) by path or $PATH search.
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

    // Shebang. #!builtin marks the /bin stubs for the registry programs.
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
    const resume = opts.resume ?? new Resume()

    let killed = false

    /**
     * Detach a killed process from the terminal.
     *
     * A JS function that ignores its abort signal cannot be stopped, but its
     * writes can. Without this, a program killed mid-enumeration keeps printing
     * over the prompt that replaced it. The sinks are gated rather than the
     * loop, since the loop belongs to the program and the terminal does not.
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
      setResume: line => { resume.line = line },
      setState: value => { resume.state = value },
      takeState: () => resume.takeState(),
    }
    const kids = new Set<Task>()
    this.children.set(proc, kids)
    const siblings = opts.parent ? this.children.get(opts.parent) : undefined
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

    const task: Task = {
      pid,
      proc,
      resume,
      wait: Promise.race([run, killedP]),
      kill() {
        killed = true
        ac.abort()
        opts.stdin.interrupt?.()
        resolveKill(130)
      },
      async stop() {
        for (const kid of kids) await kid.stop()
        await proc.onStop?.()
      },
      cont() {
        proc.onCont?.()
        for (const kid of kids) kid.cont()
      },
    }
    siblings?.add(task)
    void task.wait.then(() => siblings?.delete(task))
    return task
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
