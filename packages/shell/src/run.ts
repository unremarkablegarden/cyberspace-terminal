// Execute a parsed List: expansion, redirects, pipelines, builtins.

import {
  Pipe, fileSource, fileSink, fs, paths,
  type Proc, type Task, type Source, type Sink, type Program,
} from '@cyberspace/kernel'
import { parse, ParseError, type Cmd } from './parse.js'
import { expandWord, expandOne, type ExpandCtx } from './expand.js'

export class ShellExit {
  constructor(public code: number) {}
}

export interface ShellState {
  proc: Proc
  vars: Record<string, string>
  cwd: string
  status: number
}

const ctxOf = (sh: ShellState): ExpandCtx => ({
  vars: sh.vars,
  env: sh.proc.env,
  status: sh.status,
  cwd: sh.cwd,
})

export async function runLine(sh: ShellState, src: string): Promise<number> {
  let list
  try {
    list = parse(src)
  } catch (e) {
    if (e instanceof ParseError) {
      sh.proc.err(`sh: ${e.message}\n`)
      return (sh.status = 2)
    }
    throw e
  }

  for (const { op, pipeline } of list.items) {
    if (op === '&&' && sh.status !== 0) continue
    if (op === '||' && sh.status === 0) continue
    sh.status = await runPipeline(sh, pipeline.cmds)
  }
  return sh.status
}

async function runPipeline(sh: ShellState, cmds: Cmd[]): Promise<number> {
  // Pure assignment: set shell variables.
  if (cmds.length === 1 && !cmds[0].words.length) {
    for (const a of cmds[0].assigns) {
      sh.vars[a.name] = await expandOne(ctxOf(sh), a.value)
    }
    return 0
  }

  interface Stage {
    argv: string[]
    program: Program
    env: Record<string, string>
    redirs: { fd: 0 | 1 | 2; op: '>' | '>>' | '<'; path: string }[]
  }

  const stages: Stage[] = []
  for (const cmd of cmds) {
    const argv: string[] = []
    for (const w of cmd.words) argv.push(...await expandWord(ctxOf(sh), w))
    if (!argv.length) { sh.proc.err('sh: missing command\n'); return 2 }

    const env = { ...sh.proc.env }
    for (const a of cmd.assigns) env[a.name] = await expandOne(ctxOf(sh), a.value)

    const builtin = BUILTINS[argv[0]]
    const program = builtin
      ? (p: Proc) => builtin(sh, p)
      : await sh.proc.kernel.resolveExec(argv[0], sh.cwd, env)
    if (!program) {
      sh.proc.err(`sh: ${argv[0]}: command not found\n`)
      return 127
    }

    const redirs: Stage['redirs'] = []
    for (const r of cmd.redirs) {
      redirs.push({ fd: r.fd, op: r.op, path: paths.resolve(sh.cwd, await expandOne(ctxOf(sh), r.target)) })
    }
    stages.push({ argv, program, env, redirs })
  }

  // Wire the stages, then start them all.
  const tasks: Task[] = []
  const sinksToClose: Sink[] = []
  let prevOut: Source = sh.proc.stdin

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]
    const last = i === stages.length - 1

    let stdin: Source = i === 0 ? sh.proc.stdin : prevOut
    let stdout: Sink
    let nextIn: Source | null = null
    if (last) {
      stdout = sh.proc.stdout
    } else {
      const pipe = new Pipe()
      stdout = pipe
      nextIn = pipe
    }
    let stderr: Sink = sh.proc.stderr

    try {
      for (const r of st.redirs) {
        if (r.op === '<') stdin = await fileSource(r.path)
        else {
          const sink = await fileSink(r.path, r.op === '>>')
          sinksToClose.push(sink)
          if (r.fd === 2) stderr = sink
          else stdout = sink
        }
      }
    } catch (e) {
      sh.proc.err(`sh: ${(e as Error).message ?? e}\n`)
      for (const t of tasks) t.kill()
      return 1
    }

    const task = sh.proc.kernel.spawn(st.program, {
      argv: st.argv,
      env: st.env,
      cwd: sh.cwd,
      stdin,
      stdout,
      stderr,
      tty: sh.proc.tty,
    })
    // EOF the pipe into the next stage when this one exits.
    if (nextIn) {
      const pipe = stdout as Pipe
      void task.wait.then(() => pipe.end())
    }
    tasks.push(task)
    prevOut = nextIn ?? prevOut
  }

  // ^C kills the whole foreground pipeline.
  const tty = sh.proc.tty as { onSigint?: (() => void) | null } | undefined
  const prevSigint = tty?.onSigint
  if (tty) tty.onSigint = () => { for (const t of tasks) t.kill() }

  try {
    const codes = await Promise.all(tasks.map(t => t.wait))
    return codes[codes.length - 1]
  } finally {
    if (tty) tty.onSigint = prevSigint ?? null
    await Promise.all(sinksToClose.map(s => s.end()))
  }
}

// --- builtins -------------------------------------------------------------

type Builtin = (sh: ShellState, p: Proc) => Promise<number> | number

const BUILTINS: Record<string, Builtin> = {
  async cd(sh, p) {
    const target = p.argv[1] ? paths.resolve(sh.cwd, p.argv[1].replace(/^~(?=\/|$)/, p.env.HOME ?? '/')) : (p.env.HOME ?? '/')
    try {
      const st = await fs.promises.stat(target)
      if (!st.isDirectory()) { p.err(`cd: ${p.argv[1]}: Not a directory\n`); return 1 }
    } catch {
      p.err(`cd: ${p.argv[1]}: No such file or directory\n`)
      return 1
    }
    sh.cwd = target
    sh.proc.cwd = target
    return 0
  },

  pwd(sh, p) {
    p.out(sh.cwd + '\n')
    return 0
  },

  async export(sh, p) {
    for (const arg of p.argv.slice(1)) {
      const eq = arg.indexOf('=')
      if (eq > 0) sh.proc.env[arg.slice(0, eq)] = arg.slice(eq + 1)
      else if (sh.vars[arg] !== undefined) sh.proc.env[arg] = sh.vars[arg]
    }
    return 0
  },

  unset(sh, p) {
    for (const arg of p.argv.slice(1)) {
      delete sh.vars[arg]
      delete sh.proc.env[arg]
    }
    return 0
  },

  exit(sh, p) {
    throw new ShellExit(p.argv[1] ? Number(p.argv[1]) || 0 : sh.status)
  },

  history(sh, p) {
    void sh
    return 0 // replaced by the shell, which owns the history
  },
}

export function setHistoryBuiltin(fn: Builtin): void {
  BUILTINS['history'] = fn
}

export function builtinNames(): string[] {
  return Object.keys(BUILTINS)
}
