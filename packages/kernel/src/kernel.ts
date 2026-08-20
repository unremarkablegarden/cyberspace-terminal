// Program registry, spawn, and boot-time filesystem seeding.

import { fs } from '@zenfs/core'
import type { Program, Proc, SpawnOptions, Task } from './proc.js'
import { basename } from './paths.js'

export class Kernel {
  readonly fs = fs.promises
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

  spawn(program: Program, opts: SpawnOptions): Task {
    const pid = this.nextPid++
    const ac = new AbortController()

    const proc: Proc = {
      pid,
      argv: opts.argv,
      env: { ...opts.env },
      cwd: opts.cwd,
      stdin: opts.stdin,
      stdout: opts.stdout,
      stderr: opts.stderr,
      signal: ac.signal,
      kernel: this,
      tty: opts.tty,
      out: s => opts.stdout.write(s),
      err: s => opts.stderr.write(s),
    }

    let killed = false
    const run = (async () => {
      try {
        const code = await program(proc)
        return typeof code === 'number' ? code : 0
      } catch (e) {
        if (killed) return 130
        opts.stderr.write(`${opts.argv[0] ?? '?'}: ${(e as Error)?.message ?? e}\n`)
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
