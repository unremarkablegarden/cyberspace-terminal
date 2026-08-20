import type { Source, Sink } from './pipe.js'
import type { TtyControl } from './tty.js'
import type { Kernel } from './kernel.js'

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
}

export interface Task {
  pid: number
  /** Resolves with the exit code. Never rejects. */
  wait: Promise<number>
  kill(): void
}
