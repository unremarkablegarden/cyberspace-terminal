// System tools: date uname whoami hostname env which clear sleep true false help.

import { readText, writeLines, type Program } from '@cyberspace/kernel'
import { builtinNames } from '@cyberspace/shell'
import { fsp } from './util.js'

export const date: Program = p => {
  p.out(new Date().toString() + '\n')
  return 0
}

export const uname: Program = p => {
  p.out(p.argv.includes('-a') ? `CYBERSPACE tube0 ${p.kernel.release} web\n` : 'CYBERSPACE\n')
  return 0
}

export const whoami: Program = p => {
  p.out((p.env.USER ?? 'guest') + '\n')
  return 0
}

export const hostname: Program = p => {
  p.out((p.env.HOSTNAME ?? 'cyberspace') + '\n')
  return 0
}

export const env: Program = p => {
  for (const [k, v] of Object.entries(p.env)) p.out(`${k}=${v}\n`)
  return 0
}

export const which: Program = async p => {
  let code = 0
  for (const name of p.argv.slice(1)) {
    if (p.kernel.resolveProgram(name)) {
      p.out(`/bin/${name}\n`)
      continue
    }
    let found = ''
    for (const dir of (p.env.PATH ?? '/bin').split(':')) {
      const path = dir + '/' + name
      if (await fsp.stat(path).catch(() => null)) { found = path; break }
    }
    if (found) p.out(found + '\n')
    else code = 1
  }
  return code
}

export const clear: Program = p => {
  p.out('\x1b[2J\x1b[H')
  return 0
}

export const sleep: Program = async p => {
  const secs = Number(p.argv[1])
  if (!Number.isFinite(secs) || secs < 0) { p.err('usage: sleep seconds\n'); return 1 }
  await new Promise<void>(res => {
    const t = setTimeout(res, secs * 1000)
    p.signal.addEventListener('abort', () => { clearTimeout(t); res() })
  })
  return p.signal.aborted ? 130 : 0
}

export const trueCmd: Program = () => 0
export const falseCmd: Program = () => 1

/**
 * The plumbing, listed under Shell rather than among the programs somebody came
 * here to run. Membership is by name, so a program registered later is listed
 * as a program without being named anywhere.
 */
const SHELL = new Set([
  'cat', 'clear', 'cp', 'date', 'echo', 'env', 'false', 'grep', 'head', 'hostname',
  'less', 'ls', 'mkdir', 'motd', 'mv', 'reboot', 'rm', 'rmdir', 'sh', 'sleep',
  'sort', 'tail', 'touch', 'true', 'uname', 'uniq', 'wc', 'which', 'whoami',
])

/** Not listed: help is what is being read, and nano and more are aliases. */
const HIDDEN = new Set(['help', 'nano', 'more'])

/** Names in rows, padded to the longest, filling the width of the terminal. */
function columns(out: (s: string) => void, names: string[], cols: number): void {
  const w = Math.max(...names.map(n => n.length)) + 2
  const per = Math.max(1, Math.floor((cols - 2) / w))
  for (let i = 0; i < names.length; i += per) {
    out('  ' + names.slice(i, i + per).map(s => s.padEnd(w)).join('').trimEnd() + '\n')
  }
}

export const help: Program = async p => {
  const cols = p.tty?.cols ?? 80
  const names = p.kernel.names().filter(n => !HIDDEN.has(n))
  // builtinNames() rather than a list here, so the two cannot drift.
  const shell = [...names.filter(n => SHELL.has(n)), ...builtinNames()].sort()

  p.out('Programs:\n')
  columns(s => p.out(s), names.filter(n => !SHELL.has(n)), cols)
  p.out('Shell:\n')
  columns(s => p.out(s), shell, cols)
  p.out('Own programs:\n  cd bin then less README.txt\n')
  p.out('Keys:\n  [UP/DOWN] recall\n  [TAB] complete\n  [CTRL-SHIFT-UP/DOWN] and [SHIFT-PGUP/PGDN] scroll\n')
  return 0
}

export const motd: Program = async p => {
  try {
    writeLines(p.stdout, await readText('/etc/motd'))
  } catch {}
  return 0
}
