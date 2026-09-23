// help: the registered programs in two groups, then the keys.

import { OSC_BLIP, type Program } from '@cyberspace/kernel'
import { builtinNames } from '@cyberspace/shell'

/**
 * The plumbing, listed under Shell rather than among the programs somebody came
 * here to run. Membership is by name, so a program registered later is listed
 * as a program without being named anywhere.
 */
const SHELL = new Set([
  'cat', 'chmod', 'clear', 'config', 'cp', 'date', 'echo', 'env', 'false', 'fg', 'grep', 'head', 'hostname',
  'kill', 'less', 'ls', 'mkdir', 'motd', 'mv', 'ps', 'reboot', 'rm', 'rmdir', 'sh', 'sleep',
  'sort', 'sudo', 'tail', 'touch', 'tree', 'true', 'uname', 'uniq', 'wc', 'which', 'whoami',
])

/** Not listed: help is what is being read, nano and more are aliases, reset is guest-only, make is the sudo joke. */
const HIDDEN = new Set(['help', 'nano', 'more', 'reset', 'make'])

/** Names in rows, padded to the longest, filling the width of the terminal. */
function columns(out: (s: string) => void, names: string[], cols: number): void {
  const w = Math.max(...names.map(n => n.length)) + 2
  const per = Math.max(1, Math.floor((cols - 2) / w))
  for (let i = 0; i < names.length; i += per) {
    out('  ' + names.slice(i, i + per).map(s => s.padEnd(w)).join('').trimEnd() + '\n')
  }
}

/** Delay between revealed help lines, in ms: 45 lines a second, the rate circ reveals a backlog at. */
const REVEAL_MS = 22

export const help: Program = async p => {
  const cols = p.tty?.cols ?? 80
  const names = p.kernel.names().filter(n => !HIDDEN.has(n))
  // builtinNames() rather than a list here, so the two cannot drift.
  const shell = [...names.filter(n => SHELL.has(n)), ...builtinNames()].sort()
  let text = ''
  const out = (s: string) => { text += s }

  out('Programs:\n')
  columns(out, names.filter(n => !SHELL.has(n)), cols)
  out('Shell:\n')
  columns(out, shell, cols)
  out('Own programs:\n  cd bin/docs then less README.txt\n')
  out('Keys:\n  [UP/DOWN] recall\n  [TAB] complete\n  [CTRL-SHIFT-UP/DOWN] and [SHIFT-PGUP/PGDN] scroll\n')
  out('Select, copy and paste (command line, edit, chat):\n')
  // The chords app/src/keys.ts encodes. Off a Mac, ^C stays SIGINT, so copy and cut take Shift.
  const mac = (p.env.OSTYPE ?? '').startsWith('darwin')
  out(mac
    ? '  [SHIFT-LEFT/RIGHT] select\n  [SHIFT-OPT-LEFT/RIGHT] select word\n  [SHIFT-CMD-LEFT/RIGHT] select to line edge\n'
      + '  [CMD-C] copy\n  [CMD-X] cut\n  [CMD-V] paste\n'
    : '  [SHIFT-LEFT/RIGHT] select\n  [CTRL-SHIFT-LEFT/RIGHT] select word\n  [SHIFT-HOME/END] select to line edge\n'
      + '  [CTRL-SHIFT-C] copy\n  [CTRL-SHIFT-X] cut\n  [CTRL-V] paste\n')

  const tty = p.tty
  if (!tty) { p.out(text); return 0 }
  // Unpaced output skips the per-character rate limit, so each line lands whole; the delay paces the lines.
  tty.setPaced(false)
  try {
    for (const line of text.split(/(?<=\n)/)) {
      if (p.signal.aborted) return 130
      p.out(line)
      tty.paint(OSC_BLIP)
      await new Promise(res => setTimeout(res, REVEAL_MS))
    }
  } finally {
    tty.setPaced(true)
  }
  return 0
}
