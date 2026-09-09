// The job table: every pipeline the shell has started and not yet seen exit.
//
// A job is in the foreground, stopped, or parked. Stopped means frozen in
// memory: its processes were told to stop (Proc.onStop), its terminal view is
// out of the foreground, and it waits. Parked means the process is gone and
// only the command line plus the program's own state remain, which is what a
// reload leaves behind; the shell spawns it again on its first foreground.
//
// One shell owns the table. The host (a switcher key) asks for a change
// through switchTo(); the shell picks the request up at its prompt.

import type { Proc, Task } from './proc.js'
import { Resume } from './resume.js'
import { basename } from './paths.js'
import { Tty, type JobTty } from './tty.js'

export type JobState = 'fg' | 'stopped' | 'parked'

/** What a session stores per job. */
export interface ParkedJob {
  name: string
  line: string
  state: unknown
}

export interface Job {
  /** %n. The lowest number free when the job started. */
  id: number
  /** Program name, the command word of the last stage. One job per name. */
  name: string
  state: JobState
  resume: Resume
  /** Empty while parked. */
  tasks: Task[]
  tty: JobTty
  /** The last stage's exit code. Never settles while parked. */
  exited: Promise<number>
  /** Settles when the job leaves the foreground by stop(). Re-armed on every foreground. */
  stopped: Promise<void>
  /** @internal */
  resolveStopped: () => void
  /** @internal */
  resolveExited: (code: number) => void
  /** The command line as typed, for ps and the Stopped line. */
  readonly line: string
}

/** What the host asks the shell to do next. */
export type JobRequest = { fg: Job } | { launch: string }

export class Jobs {
  /** The job holding the terminal, or null while the shell has it. */
  fg: Job | null = null
  /** The job `fg` without an argument means: the last one stopped or foregrounded. */
  current: Job | null = null

  private jobs: Job[] = []
  private owner: Proc | null = null
  private tty: Tty | null = null
  private pendingFg: Job | null = null
  private request: JobRequest | null = null
  private requestFns = new Set<() => void>()
  /** Lines for the shell to print before its next prompt: Done and Terminated. */
  private notes: string[] = []

  /**
   * The terminal the jobs run on. The host sets it before restoring a session;
   * the first shell's claim sets it otherwise.
   */
  device(tty: Tty): void {
    this.tty = tty
  }

  /**
   * Take ownership. False when another shell has the table, in which case the
   * caller runs without job control. Needs the device itself, not a view: a
   * shell that is itself a job cannot hand out the foreground.
   */
  claim(shell: Proc): boolean {
    // A killed owner may not have released yet; its successor takes over.
    if (this.owner && this.owner !== shell && !this.owner.signal.aborted) return false
    if (!(shell.tty instanceof Tty)) return false
    this.owner = shell
    this.tty = shell.tty
    return true
  }

  release(shell: Proc): void {
    if (this.owner === shell) this.owner = null
  }

  owns(shell: Proc): boolean {
    return this.owner === shell
  }

  list(): Job[] {
    return [...this.jobs]
  }

  byId(n: number): Job | undefined {
    return this.jobs.find(j => j.id === n)
  }

  byName(name: string): Job | undefined {
    return this.jobs.find(j => j.name === name)
  }

  /** A new job in the foreground state, its tasks to be attached by the shell. */
  create(line: string): Job {
    const job = this.make(basename(line.split(/\s+/)[0] ?? ''), line, 'fg')
    this.jobs.push(job)
    return job
  }

  /** Give a job its processes, after a spawn. Their exit settles `exited`. */
  attach(job: Job, tasks: Task[]): void {
    job.tasks = tasks
    void Promise.all(tasks.map(t => t.wait)).then(codes => {
      const code = codes[codes.length - 1] ?? 0
      // A job that ends while stopped leaves a notice; the shell is not waiting on it.
      if (job.state === 'stopped' && this.jobs.includes(job)) {
        this.notes.push(`[${job.id}]  Done  ${job.line}`)
        this.remove(job)
      }
      job.resolveExited(code)
    })
  }

  /**
   * Hand the terminal to a job whose processes are about to be spawned.
   *
   * A program draws its first frame in the synchronous part of its run, and a
   * view outside the foreground drops frames; the job's later frames are drawn
   * as a diff against that first one, so the screen would keep whatever the
   * dropped frame held, missing until something invalidated.
   *
   * `current` is left alone: it names the job `fg` without an argument brings
   * back, which is the last one stopped, not the one now starting.
   */
  start(job: Job): void {
    if (this.fg && this.fg !== job) throw new Error('jobs: foreground is taken')
    this.fg = job
    this.tty?.foreground(job.tty)
  }

  /** Put a job in the foreground. The shell awaits `exited` or `stopped` after this. */
  foreground(job: Job): void {
    // Already holds the terminal from start(); the shell calls both on a spawn.
    if (this.fg === job && job.state === 'fg') return
    if (this.fg && this.fg !== job) throw new Error('jobs: foreground is taken')
    const wasStopped = job.state === 'stopped'
    job.state = 'fg'
    this.fg = job
    this.current = job
    job.stopped = new Promise<void>(res => { job.resolveStopped = res })
    this.tty?.foreground(job.tty)
    if (wasStopped) for (const t of job.tasks) t.cont()
  }

  /**
   * Hand a job the argv of a line typed for it (Proc.onArgs). A parked job has
   * no process; its resume line is replaced so the respawn reads the new
   * arguments itself, with the parked state kept.
   */
  args(job: Job, argv: string[]): void {
    if (job.state === 'parked') {
      job.resume.restore(argv.join(' '), job.resume.parked)
      return
    }
    for (const t of job.tasks) t.proc.onArgs?.(argv)
  }

  /** Freeze the foreground job and give the terminal back to the shell. */
  async stop(job: Job): Promise<void> {
    if (job.state !== 'fg') return
    job.state = 'stopped'
    this.fg = null
    this.current = job
    for (const t of job.tasks) await t.stop()
    this.tty?.foreground(null)
    job.resolveStopped()
  }

  /** Forget a job. The shell calls it when the job's processes have exited. */
  remove(job: Job): void {
    const i = this.jobs.indexOf(job)
    if (i !== -1) this.jobs.splice(i, 1)
    if (this.fg === job) {
      this.fg = null
      this.tty?.foreground(null)
    }
    if (this.current === job) this.current = this.jobs[this.jobs.length - 1] ?? null
  }

  kill(job: Job): void {
    if (job.state === 'fg') {
      // The waiting shell sees `exited` settle and removes the job itself.
      for (const t of job.tasks) t.kill()
      return
    }
    for (const t of job.tasks) t.kill()
    this.notes.push(`[${job.id}]  Terminated  ${job.line}`)
    this.remove(job)
    if (!job.tasks.length) job.resolveExited(130)
  }

  killAll(): void {
    for (const job of this.list()) this.kill(job)
  }

  /** Notices accumulated since the last prompt, cleared by reading. */
  takeNotes(): string[] {
    return this.notes.splice(0)
  }

  // --- the session ------------------------------------------------------------

  /** Recreate a saved table as parked jobs. `fg` is an index into `entries`, or null for the shell. */
  restore(entries: ParkedJob[], fg: number | null): void {
    for (const e of entries) {
      const job = this.make(e.name, e.line, 'parked')
      job.resume.restore(e.line, e.state)
      this.jobs.push(job)
    }
    this.pendingFg = fg === null ? null : this.jobs[fg] ?? null
    this.current = this.pendingFg ?? this.jobs[this.jobs.length - 1] ?? null
  }

  /** Claimed once by the shell when it starts: the job to foreground before the first prompt. */
  takePendingFg(): Job | null {
    const job = this.pendingFg
    this.pendingFg = null
    return job
  }

  /** The table as a session stores it. A job that declared no resume line is omitted. */
  park(): { jobs: ParkedJob[]; fg: number | null } {
    const jobs: ParkedJob[] = []
    let fg: number | null = null
    for (const job of this.jobs) {
      const line = job.resume.line
      if (!line) continue
      if (job === this.fg) fg = jobs.length
      jobs.push({ name: job.name, line, state: job.resume.parked ?? null })
    }
    return { jobs, fg }
  }

  // --- the host ---------------------------------------------------------------

  /**
   * Switch, from outside the shell: to a job, to the shell, or to a fresh
   * command line. The foreground job is stopped first; the rest is queued for
   * the shell, which is told through onRequest and picks it up at its prompt.
   */
  async switchTo(target: Job | 'shell' | { launch: string }): Promise<void> {
    if (target === this.fg) return
    if (this.fg) await this.stop(this.fg)
    if (target === 'shell') return
    this.request = 'launch' in target ? { launch: target.launch } : { fg: target }
    for (const fn of this.requestFns) fn()
  }

  /** The queued request, cleared by reading. */
  take(): JobRequest | null {
    const r = this.request
    this.request = null
    return r
  }

  onRequest(fn: () => void): () => void {
    this.requestFns.add(fn)
    return () => { this.requestFns.delete(fn) }
  }

  private make(name: string, line: string, state: JobState): Job {
    if (!this.tty) throw new Error('jobs: no terminal')
    let id = 1
    while (this.jobs.some(j => j.id === id)) id++
    let resolveStopped = () => {}
    let resolveExited = (_code: number) => {}
    const resume = new Resume()
    const job: Job = {
      id, name, state, resume,
      tasks: [],
      tty: this.tty.view(),
      exited: new Promise<number>(res => { resolveExited = res }),
      stopped: new Promise<void>(res => { resolveStopped = res }),
      resolveStopped: () => resolveStopped(),
      resolveExited: code => resolveExited(code),
      get line() { return resume.line ?? line },
    }
    return job
  }
}
