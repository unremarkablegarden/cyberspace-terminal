// Execute a parsed List: expansion, redirects, pipelines, builtins.

import {
  Pipe, fileSource, fileSink, fs, paths,
  type Proc, type Task, type Source, type Sink, type Program, type Job,
} from '@cyberspace/kernel'
import { parse, ParseError, type Cmd } from './parse.js'
import { expandWord, expandOne, type ExpandCtx } from './expand.js'

export class ShellExit {
  constructor(public code: number) {}
}

/** Thrown out of a pipeline when its job was stopped; the rest of the list is abandoned. */
export class JobStopped {
  constructor(public job: Job) {}
}

/** Exit status of a stopped job, as bash reports it. */
export const STOPPED_STATUS = 148

export interface ShellState {
  proc: Proc
  vars: Record<string, string>
  /**
   * Names marked for export. A name can be marked before it has a value
   * (`export FOO` then `FOO=bar`), so the mark cannot live in proc.env.
   */
  exported: Set<string>
  status: number
  /**
   * Set by the exit builtin, read by runLine after the pipeline. The builtin
   * runs as a process, so a throw from it would be caught by the kernel and
   * reported as an error rather than ending the shell.
   */
  exiting?: number
  /** Whether the last `exit` was refused for stopped jobs; a second in a row goes through. */
  warnedJobs?: boolean
  /** Set by the fg builtin: the job to foreground once the fg pipeline itself has exited. */
  foregroundNext?: Job
}

/** Whether this shell has the job table, and so runs each pipeline as a job. */
export const jobControl = (sh: ShellState): boolean => sh.proc.kernel.jobs.owns(sh.proc)

/** The line ps and the Stopped notice print: the expanded words, stages joined by a pipe. */
const lineOf = (argvs: string[][]): string => argvs.map(a => a.join(' ')).join(' | ')

/** Set a shell variable, publishing it to the environment when it is exported. */
export function setVar(sh: ShellState, name: string, value: string): void {
  sh.vars[name] = value
  if (sh.exported.has(name)) sh.proc.env[name] = value
}

const ctxOf = (sh: ShellState): ExpandCtx => ({
  vars: sh.vars,
  env: sh.proc.env,
  status: sh.status,
  cwd: sh.proc.cwd,
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

  let sawExit = false
  for (const { op, pipeline } of list.items) {
    if (op === '&&' && sh.status !== 0) continue
    if (op === '||' && sh.status === 0) continue
    try {
      sh.status = await runPipeline(sh, pipeline.cmds)
    } catch (e) {
      if (!(e instanceof JobStopped)) throw e
      sh.status = STOPPED_STATUS
      break
    }
    if (sh.exiting !== undefined) {
      const code = sh.exiting
      sh.exiting = undefined
      sawExit = true
      if (refuseExit(sh)) break
      throw new ShellExit(code)
    }
    if (sh.foregroundNext) {
      const job = sh.foregroundNext
      sh.foregroundNext = undefined
      try {
        sh.status = await foregroundJob(sh, job)
      } catch (e) {
        if (!(e instanceof JobStopped)) throw e
        sh.status = STOPPED_STATUS
        break
      }
    }
  }
  // Any other command resets the exit refusal.
  if (!sawExit) sh.warnedJobs = false
  return sh.status
}

/**
 * The exit refusal: with jobs in the table the first `exit` is refused and the
 * second in a row goes through, killing them, as bash does. True when refused.
 */
export function refuseExit(sh: ShellState): boolean {
  const jobs = sh.proc.kernel.jobs
  if (!jobControl(sh) || !jobs.list().length) return false
  if (sh.warnedJobs) {
    jobs.killAll()
    return false
  }
  sh.warnedJobs = true
  sh.proc.err('There are stopped jobs.\n')
  return true
}

/**
 * Run a parked job's line again. Only the first pipeline of the line is the
 * job; the shell stored the line the program declared, which is one command.
 */
export async function runParked(sh: ShellState, job: Job): Promise<void> {
  const list = parse(job.line)
  const cmds = list.items[0]?.pipeline.cmds ?? []
  await runPipeline(sh, cmds, job)
}

/**
 * Run a pipeline. Under job control the pipeline is a job: its processes get
 * the job's terminal view and resume slot, and the shell waits for either the
 * exit or a stop. `job` is a parked job being spawned again; otherwise a job
 * is created for the pipeline.
 */
async function runPipeline(sh: ShellState, cmds: Cmd[], job?: Job): Promise<number> {
  // Pure assignment: set shell variables.
  if (cmds.length === 1 && !cmds[0].words.length) {
    for (const a of cmds[0].assigns) {
      setVar(sh, a.name, await expandOne(ctxOf(sh), a.value))
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
      : await sh.proc.kernel.resolveExec(argv[0], sh.proc.cwd, env)
    if (!program) {
      sh.proc.err(`sh: ${argv[0]}: command not found\n`)
      return 127
    }

    const redirs: Stage['redirs'] = []
    for (const r of cmd.redirs) {
      redirs.push({ fd: r.fd, op: r.op, path: paths.resolve(sh.proc.cwd, await expandOne(ctxOf(sh), r.target)) })
    }
    stages.push({ argv, program, env, redirs })
  }

  const jobs = sh.proc.kernel.jobs
  if (jobControl(sh) && !job) {
    // One job per program: the name runs again, the running job comes back.
    const existing = stages.length === 1 ? jobs.byName(paths.basename(stages[0].argv[0])) : undefined
    if (existing) {
      if (stages[0].argv.length > 1) jobs.args(existing, stages[0].argv)
      return foregroundJob(sh, existing)
    }
    job = jobs.create(lineOf(stages.map(s => s.argv)))
  }
  const tty = job ? job.tty : sh.proc.tty
  // The terminal goes to the job before its processes start. See Jobs.start.
  if (job) jobs.start(job)

  // Wire the stages, then start them all.
  const tasks: Task[] = []
  const sinksToClose: Sink[] = []
  // The job's view of the keyboard, when the shell's stdin is the keyboard.
  const ttyIn: Source = job && sh.proc.stdin.isInteractive ? job.tty.stdin : sh.proc.stdin
  let prevOut: Source = ttyIn

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]
    const last = i === stages.length - 1

    let stdin: Source = i === 0 ? ttyIn : prevOut
    let stdout: Sink
    let nextIn: Source | null = null
    if (last) {
      stdout = job ? job.tty.stdout : sh.proc.stdout
    } else {
      const pipe = new Pipe()
      stdout = pipe
      nextIn = pipe
    }
    let stderr: Sink = job ? job.tty.stdout : sh.proc.stderr

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
      for (const t of tasks) t.kill()
      // Drop the job before the message: it holds the terminal from the line
      // above, and remove() hands it back to the shell.
      if (job) jobs.remove(job)
      sh.proc.err(`sh: ${(e as Error).message ?? e}\n`)
      return 1
    }

    const task = sh.proc.kernel.spawn(st.program, {
      argv: st.argv,
      env: st.env,
      cwd: sh.proc.cwd,
      stdin,
      stdout,
      stderr,
      tty,
      resume: job?.resume,
    })
    // EOF the pipe into the next stage when this one exits.
    if (nextIn) {
      const pipe = stdout as Pipe
      void task.wait.then(() => pipe.end())
    }
    tasks.push(task)
    prevOut = nextIn ?? prevOut
  }

  if (job) {
    // ^C kills the job; ^Z stops it. The terminal is restored by
    // Tty.foreground(null) when the job leaves the foreground either way.
    job.tty.onSigint = () => { for (const t of tasks) t.kill() }
    job.tty.onSigtstp = () => { void jobs.stop(job) }
    jobs.attach(job, tasks)
    try {
      return await foregroundJob(sh, job)
    } finally {
      await Promise.all(sinksToClose.map(s => s.end()))
    }
  }

  // No job control: a nested shell, a script. ^C kills the pipeline and
  // restores the terminal.
  //
  // The kill alone is not enough for a full-screen program: killed mid-paint it
  // never reaches its own finally, so the alt screen and raw mode would outlive
  // it and leave the prompt invisible. Both calls are idempotent, so they cost
  // nothing when the program does clean up.
  const plain = tty as {
    onSigint?: (() => void) | null
    setCooked?: () => void
    paint?: (s: string) => void
    alt?: boolean
  } | undefined
  const prevSigint = plain?.onSigint
  if (plain) {
    plain.onSigint = () => {
      for (const t of tasks) t.kill()
      // Only when the alt screen is up: see Tty.alt.
      plain.paint?.(plain.alt ? '\x1b[?1049l\x1b[?25h' : '\x1b[?25h')
      plain.setCooked?.()
    }
  }

  try {
    const codes = await Promise.all(tasks.map(t => t.wait))
    return codes[codes.length - 1]
  } finally {
    if (plain) plain.onSigint = prevSigint ?? null
    await Promise.all(sinksToClose.map(s => s.end()))
  }
}

/**
 * Put a job in the foreground and wait. A parked job is spawned first. Returns
 * the exit code; throws JobStopped when the job was stopped instead, after
 * printing the Stopped line.
 */
export async function foregroundJob(sh: ShellState, job: Job): Promise<number> {
  const jobs = sh.proc.kernel.jobs
  if (job.state === 'parked') {
    job.state = 'fg'
    await runParked(sh, job)
    // runParked ran the whole foreground; a parked job that stopped again threw.
    return sh.status
  }
  jobs.foreground(job)
  const outcome = await Promise.race([
    job.exited.then(code => ({ code })),
    job.stopped.then(() => ({ stopped: true as const })),
  ])
  if ('stopped' in outcome) {
    sh.proc.out(`[${job.id}]+ Stopped  ${job.line}\n`)
    throw new JobStopped(job)
  }
  // The program has exited, so its resume point goes with the job: the next
  // bare `circ` opens on the default room.
  jobs.remove(job)
  return outcome.code
}

// --- builtins -------------------------------------------------------------

type Builtin = (sh: ShellState, p: Proc) => Promise<number> | number

const BUILTINS: Record<string, Builtin> = {
  async cd(sh, p) {
    const target = p.argv[1] ? paths.resolve(sh.proc.cwd, p.argv[1].replace(/^~(?=\/|$)/, p.env.HOME ?? '/')) : (p.env.HOME ?? '/')
    try {
      const st = await fs.promises.stat(target)
      if (!st.isDirectory()) { p.err(`cd: ${p.argv[1]}: Not a directory\n`); return 1 }
    } catch {
      p.err(`cd: ${p.argv[1]}: No such file or directory\n`)
      return 1
    }
    sh.proc.cwd = target
    // Published so the host can store it with the session, and so `echo $PWD`
    // agrees with `pwd`.
    sh.proc.env.PWD = target
    return 0
  },

  pwd(sh, p) {
    p.out(sh.proc.cwd + '\n')
    return 0
  },

  export(sh, p) {
    const names = p.argv.slice(1).filter(a => a !== '-p')
    if (!names.length) {
      for (const name of Object.keys(sh.proc.env).sort()) {
        p.out(`export ${name}="${sh.proc.env[name].replace(/(["\\])/g, '\\$1')}"\n`)
      }
      return 0
    }
    for (const arg of names) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(0, eq) : arg
      sh.exported.add(name)
      if (eq > 0) sh.vars[name] = arg.slice(eq + 1)
      // A name marked before it has a value publishes nothing now; the
      // assignment that follows goes through setVar and finds the mark.
      if (sh.vars[name] !== undefined) sh.proc.env[name] = sh.vars[name]
    }
    return 0
  },

  unset(sh, p) {
    for (const arg of p.argv.slice(1)) {
      sh.exported.delete(arg)
      delete sh.vars[arg]
      delete sh.proc.env[arg]
    }
    return 0
  },

  exit(sh, p) {
    sh.exiting = p.argv[1] ? Number(p.argv[1]) || 0 : sh.status
    return 0
  },

  fg(sh, p) {
    if (!jobControl(sh)) { p.err('fg: no job control\n'); return 1 }
    const jobs = sh.proc.kernel.jobs
    const word = p.argv[1]
    const job = word === undefined ? jobs.current : jobByWord(sh, word)
    if (!job) {
      p.err(word === undefined ? 'fg: no current job\n' : `fg: ${word}: no such job\n`)
      return 1
    }
    // fg itself is the foreground pipeline; the job goes up once fg is done.
    sh.foregroundNext = job
    return 0
  },

  ps(sh, p) {
    if (!jobControl(sh)) { p.err('ps: no job control\n'); return 1 }
    p.out('  PID STAT CMD\n')
    const row = (pid: number | null, stat: string, cmd: string) =>
      p.out(`${(pid === null ? '-' : String(pid)).padStart(5)} ${stat.padEnd(4)} ${cmd}\n`)
    row(sh.proc.pid, 'R', 'sh')
    for (const job of sh.proc.kernel.jobs.list()) {
      const stat = job.state === 'fg' ? 'R' : 'T'
      if (!job.tasks.length) { row(null, stat, job.line); continue }
      for (const t of job.tasks) row(t.pid, stat, t.proc.argv.join(' '))
    }
    return 0
  },

  kill(sh, p) {
    if (!jobControl(sh)) { p.err('kill: no job control\n'); return 1 }
    const word = p.argv[1]
    if (!word) { p.err('usage: kill pid | %job\n'); return 1 }
    const job = jobByWord(sh, word)
    if (!job) { p.err(`kill: ${word}: no such process\n`); return 1 }
    sh.proc.kernel.jobs.kill(job)
    return 0
  },

  history(sh, p) {
    void sh
    return 0 // replaced by the shell, which owns the history
  },
}

/** A job by `%n`, by pid, or by program name. */
function jobByWord(sh: ShellState, word: string): Job | undefined {
  const jobs = sh.proc.kernel.jobs
  if (word.startsWith('%')) return jobs.byId(Number(word.slice(1)))
  if (/^\d+$/.test(word)) {
    const pid = Number(word)
    return jobs.list().find(j => j.tasks.some(t => t.pid === pid))
  }
  return jobs.byName(word)
}

export function setHistoryBuiltin(fn: Builtin): void {
  BUILTINS['history'] = fn
}

export function builtinNames(): string[] {
  return Object.keys(BUILTINS)
}
