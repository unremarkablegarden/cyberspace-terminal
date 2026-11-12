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
  // `.` is `source` under its POSIX name.
  const shell = [...names.filter(n => SHELL.has(n)), ...builtinNames().filter(n => n !== '.')].sort()
  let text = ''
  const out = (s: string) => { text += s }

  out('Shell:\n')
  columns(out, shell, cols)
  out('Programs:\n')
  columns(out, names.filter(n => !SHELL.has(n)), cols)
  out("Aliases:\n  alias ll='ls -l', kept in ~/.shrc\n")
  const mac = (p.env.OSTYPE ?? '').startsWith('darwin')
  // Bindings in app/src/input.ts, scrollback.ts and keys.ts. A Mac keyboard has
  // no Page Up key: Fn-Up sends it. Ctrl-Opt-digit is the F-key alias in keys.ts.
  const keys = [
    'Keys:', '  [UP/DOWN] recall', '  [TAB] complete', '  [CTRL-SHIFT-UP/DOWN] scroll line',
    ...(mac
      ? ['  [SHIFT-FN-UP/DOWN] scroll page', '  [F1] or [CTRL-OPT-1] config', '  [CMD-K] switch job', '  [CMD-I] inbox', '  [CMD-.] escape']
      : ['  [SHIFT-PGUP/PGDN] scroll page', '  [F1] config', '  [CTRL-K] switch job', '  [CTRL-I] inbox']),
  ]
  // The key combinations app/src/keys.ts encodes. Off a Mac, ^C stays SIGINT, so copy and cut take Shift.
  const select = [
    'Select, copy and paste:',
    ...(mac
      ? ['  [SHIFT-LEFT/RIGHT] select', '  [SHIFT-OPT-LEFT/RIGHT] select word', '  [SHIFT-CMD-LEFT/RIGHT] select to line edge',
        '  [CMD-C] copy', '  [CMD-X] cut', '  [CMD-V] paste']
      : ['  [SHIFT-LEFT/RIGHT] select', '  [CTRL-SHIFT-LEFT/RIGHT] select word', '  [SHIFT-HOME/END] select to line edge',
        '  [CTRL-SHIFT-C] copy', '  [CTRL-SHIFT-X] cut', '  [CTRL-V] paste']),
    'Undo (edit, multi-line boxes):',
    mac ? '  [CMD-Z] undo  [SHIFT-CMD-Z] redo' : '  [CTRL-SHIFT-Z] undo  [CTRL-Y] redo',
  ]
  // Two columns when both fit the tty width, else one after the other (the 44-column phone grid).
  const left = Math.max(...keys.map(l => l.length)) + 2
  if (left + Math.max(...select.map(l => l.length)) <= cols) {
    for (let i = 0; i < Math.max(keys.length, select.length); i++) {
      out(((keys[i] ?? '').padEnd(left) + (select[i] ?? '')).trimEnd() + '\n')
    }
  } else {
    out([...keys, ...select].join('\n') + '\n')
  }

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
