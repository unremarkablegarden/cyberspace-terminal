import type { Source, Sink } from './pipe.js'
import type { TtyControl } from './tty.js'
import type { Kernel } from './kernel.js'
import type { Resume } from './resume.js'

export interface Proc {
  pid: number
  argv: string[]
  env: Record<string, string>
  cwd: string
  stdin: Source
  stdout: Sink
  stderr: Sink
  signal: AbortSignal
  kernel: Kernel
  /** Present when stdin/stdout is the terminal. */
  tty?: TtyControl
  /** Write a string to stdout. */
  out(s: string): void
  /** Write a string to stderr. */
  err(s: string): void

  /**
   * Declare the command line that would restart this program after a reload, or
   * null if it should not restart. Kept current as the program's target changes;
   * circ calls it on every room change.
   */
  setResume(line: string | null): void

  /**
   * Store whatever this program needs to resume at the same position. Opaque to
   * the kernel and read when the session is written rather than when this is
   * called, so it is cheap enough to call from a repaint. Must be JSON.
   */
  setState(value: unknown): void

  /**
   * The state stored by the previous run, returned once. Cleared by reading, so
   * a program started by hand starts clean.
   */
  takeState(): unknown

  /**
   * Job control. A program that holds streams or timers sets these; the shell
   * calls onStop when the job leaves the foreground and onCont when it comes
   * back. A program without them is frozen by the terminal alone: its reads
   * block and its output is buffered until it is foregrounded again.
   *
   * onCont must repaint: frames written while stopped were dropped.
   */
  onStop?: () => void | Promise<void>
  onCont?: () => void
  /**
   * The argv of a command line typed for this job while it exists, such as
   * `cmail @user` while cmail is stopped. Called before onCont, so the program
   * only records where the arguments point; onCont paints.
   */
  onArgs?: (argv: string[]) => void
}

export type Program = (p: Proc) => Promise<number | void> | number | void

export interface SpawnOptions {
  argv: string[]
  env: Record<string, string>
  cwd: string
  stdin: Source
  stdout: Sink
  stderr: Sink
  tty?: TtyControl
  /** Resume slot for this process. The shell passes its job's; a fresh one otherwise. */
  resume?: Resume
  /** The process running this one on its own terminal; stop and cont reach it through here. */
  parent?: Proc
}

export interface Task {
  pid: number
  /** The process itself, so a host can read back what it changed, such as env.PWD. */
  proc: Proc
  /** Resolves with the exit code. Never rejects. */
  wait: Promise<number>
  resume: Resume
  kill(): void
  /** Stop this process and every process it spawned on its terminal, children first. */
  stop(): Promise<void>
  /** Continue after stop(), this process first. */
  cont(): void
}
