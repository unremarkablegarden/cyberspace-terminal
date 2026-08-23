// Session persistence: restores the scrollback, working directory and running
// program after a reload.
//
// Only the serialised screen is stored, never a live object. A program holding
// listeners cannot be serialised, so it records the command line that restarts
// it (`resume`) plus an opaque state blob, and the shell runs that line again.
// `circ` keeps its resume line pointed at the current room for this reason.
//
// This module holds the format, the validator and the shell loop. main.ts
// decides where the bytes are stored.

import { readText, type Kernel, type Proc, type Tty } from '@cyberspace/kernel'
import { shellMain } from '@cyberspace/shell'
import { ENV, HOME } from './config'

/** Bump when the shape changes. A mismatch is discarded, never migrated. */
export const SESSION_VERSION = 1

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
  /** Command line that brings the running program back, e.g. `circ hackers`. */
  resume: string | null
  /**
   * Program-defined state, stored verbatim and never inspected here.
   *
   * `resume` restarts a program but cannot express where inside itself it was,
   * so the program defines its own format. Handed back through takeState() when
   * the resume line runs. Must be JSON-serialisable.
   */
  state: unknown
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
  if (s.resume !== null && (typeof s.resume !== 'string' || !s.resume)) return null

  return {
    v: SESSION_VERSION,
    at: s.at,
    uid: s.uid,
    screen: s.screen,
    cwd: s.cwd,
    resume: s.resume as string | null,
    // Absent means the program stored no state.
    state: s.state ?? null,
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
  let cwd = saved?.cwd ?? HOME
  // A restored screen already contains the motd, so the first shell skips it.
  let quiet = !!saved
  while (!host.halted()) {
    if (!quiet) {
      const motd = await readText('/etc/motd').catch(() => '')
      tty.stdout.write(String(motd))
      await host.drained()
    }
    quiet = false
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
    cwd = task.proc.env.PWD || HOME
    tty.stdout.write('\n')
  }
}
