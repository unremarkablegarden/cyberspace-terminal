// Session persistence: restores the scrollback, working directory and job
// table after a reload.
//
// Only the serialised screen is stored, never a live object. A program holding
// listeners cannot be serialised, so each job records the command line that
// restarts it plus an opaque state blob; the jobs come back parked and the
// shell runs the line again when one is foregrounded. `circ` keeps its resume
// line pointed at the current room for this reason.
//
// This module holds the format, the validator and the shell loop. main.ts
// decides where the bytes are stored.

import type { Arrival } from './baud'
import { readText, writeLines, type Kernel, type ParkedJob, type Proc, type Tty } from '@cyberspace/kernel'
import { shellMain } from '@cyberspace/shell'
import { ENV } from './config'

/** Bump when the shape changes. A mismatch is discarded, never migrated. */
export const SESSION_VERSION = 2

/**
 * Maximum age of a session worth restoring.
 *
 * Deliberately the same as COLD_AFTER in config.ts, so a warm boot resumes and
 * a cold boot starts clean.
 */
export const SESSION_MAX_AGE = 10 * 60 * 1000

export interface TerminalSession {
  v: number
  /** Epoch ms, for SESSION_MAX_AGE. */
  at: number
  /**
   * Whose session this is, so a shared browser cannot restore one member's
   * scrollback for another. Empty string is the guest, and matches only the guest.
   */
  uid: string
  /** The screen serialised as ANSI, scrollback included. See @xterm/addon-serialize. */
  screen: string
  cwd: string
  /**
   * The job table. Each entry is the command line that brings the program
   * back, e.g. `circ hackers`, and the program's own state, stored verbatim and
   * never inspected here: the line restarts a program but cannot express where
   * inside itself it was, so the program defines its own format and reads it
   * back through takeState() when the line runs. Must be JSON-serialisable.
   */
  jobs: ParkedJob[]
  /** Index into `jobs` of the job that held the terminal, or null for the shell. */
  fg: number | null
}

/**
 * Validate a blob from storage. Returns null for anything unrecognised, which
 * starts the machine clean. Nothing here attempts to repair a bad session.
 */
export function parseSession(raw: unknown, uid: string, now: number): TerminalSession | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>

  if (s.v !== SESSION_VERSION) return null
  if (typeof s.uid !== 'string' || s.uid !== uid) return null
  if (typeof s.at !== 'number' || !Number.isFinite(s.at)) return null
  if (now - s.at > SESSION_MAX_AGE || s.at > now) return null

  if (typeof s.screen !== 'string' || typeof s.cwd !== 'string' || !s.cwd) return null
  if (!Array.isArray(s.jobs)) return null
  const jobs: ParkedJob[] = []
  for (const j of s.jobs as unknown[]) {
    if (!j || typeof j !== 'object') return null
    const e = j as Record<string, unknown>
    if (typeof e.name !== 'string' || !e.name || typeof e.line !== 'string' || !e.line) return null
    // Absent means the program stored no state.
    jobs.push({ name: e.name, line: e.line, state: e.state ?? null })
  }
  if (s.fg !== null && (typeof s.fg !== 'number' || !Number.isInteger(s.fg) || s.fg < 0 || s.fg >= jobs.length)) return null

  return {
    v: SESSION_VERSION,
    at: s.at,
    uid: s.uid,
    screen: s.screen,
    cwd: s.cwd,
    jobs,
    fg: s.fg as number | null,
  }
}

// --- the running session ------------------------------------------------------


export interface SessionHost {
  kernel: Kernel
  tty: Tty
  /** Whether the machine has been switched off. Ends the loop. */
  halted: () => boolean
  /** Wait for queued output to drain, so the motd is not written over it. */
  drained: () => Promise<void>
  /** Release the motd a line at a time; everything after it arrives by the character. */
  arrival?: (mode: Arrival) => void
  /** Called when the shell is about to read the tty, and input may be accepted. */
  open?: () => void
  /** Reports the running shell, for the parked session's cwd and for shutdown. */
  onShell: (shell: Proc | null, kill: (() => void) | null) => void
}

/**
 * Run one shell after another until the machine halts. A shell that exits is
 * replaced by a fresh one in the same working directory, as is one lost to a
 * reload.
 */
export async function runSession(host: SessionHost, saved: TerminalSession | null): Promise<void> {
  const { kernel, tty } = host
  let cwd = saved?.cwd ?? ENV.HOME
  // A restored screen already contains the motd, so the first shell skips it.
  let quiet = !!saved
  while (!host.halted()) {
    if (!quiet) {
      const motd = await readText('/etc/motd').catch(() => '')
      host.arrival?.('line')
      writeLines(tty.stdout, String(motd))
      await host.drained()
      host.arrival?.('char')
    }
    quiet = false
    host.open?.()
    const task = kernel.spawn(shellMain, {
      argv: ['sh'],
      env: { ...ENV, PWD: cwd },
      cwd,
      stdin: tty.stdin,
      stdout: tty.stdout,
      stderr: tty.stdout,
      tty,
    })
    host.onShell(task.proc, () => task.kill())
    await task.wait
    host.onShell(null, null)
    cwd = task.proc.env.PWD || ENV.HOME
    tty.stdout.write('\n')
  }
}
