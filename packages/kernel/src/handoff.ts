// Running another program on the caller's terminal, then coming back.
//
// A full-screen program that wants C-Mail or the feed for a moment hands its
// tty over: the child gets the same stdio, tty, environment and directory, and
// the caller waits. The alternate screen is not touched here. Leaving it
// before and repainting after is the caller's, since only the caller knows
// what it had on the screen.

import type { Proc } from './proc.js'

/**
 * Programs a user program may hand the terminal to. Machine code calls
 * runOnTty() with any name; the list gates the brokered capability only, so a
 * published program cannot reach logout, shutdown or the shell this way.
 */
export const HANDOFF_PROGRAMS = ['cmail', 'circ', 'feed', 'globe', 'finger', 'browse'] as const

export function allowedHandoff(name: string): boolean {
  return (HANDOFF_PROGRAMS as readonly string[]).includes(name)
}

/**
 * Run `name` with `argv` on the caller's terminal and return its exit code.
 *
 * The caller is assumed to hold the tty raw, as every full-screen program
 * does: the tty goes cooked for the child, which sets its own mode, and comes
 * back raw. Rejects when no such program is registered. An abort on the
 * caller's signal is forwarded to the child as kill().
 */
export async function runOnTty(p: Proc, name: string, argv: string[] = []): Promise<number> {
  const prog = p.kernel.resolveProgram(name)
  if (!prog) throw new Error(`${name}: no such program`)
  p.tty?.setCooked()
  const task = p.kernel.spawn(prog, {
    argv: [name, ...argv], env: p.env, cwd: p.cwd,
    stdin: p.stdin, stdout: p.stdout, stderr: p.stderr, tty: p.tty,
    // So a stop or cont of the caller's job reaches the child.
    parent: p,
  })
  const kill = (): void => task.kill()
  p.signal.addEventListener('abort', kill, { once: true })
  try {
    return await task.wait
  } finally {
    p.signal.removeEventListener('abort', kill)
    p.tty?.setRaw()
  }
}
