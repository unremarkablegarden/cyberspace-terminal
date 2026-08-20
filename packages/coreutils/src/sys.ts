// System tools: date uname whoami hostname env which clear sleep true false help.

import type { Program } from '@cyberspace/kernel'
import { fsp } from './util.js'

export const date: Program = p => {
  p.out(new Date().toString() + '\n')
  return 0
}

export const uname: Program = p => {
  p.out(p.argv.includes('-a') ? 'CYBERSPACE tube0 0.1 web\n' : 'CYBERSPACE\n')
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

export const help: Program = async p => {
  p.out('Programs:\n')
  const names = p.kernel.names()
  const cols = p.tty?.cols ?? 80
  const w = Math.max(...names.map(n => n.length)) + 2
  const per = Math.max(1, Math.floor((cols - 2) / w))
  for (let i = 0; i < names.length; i += per) {
    p.out('  ' + names.slice(i, i + per).map(s => s.padEnd(w)).join('').trimEnd() + '\n')
  }
  p.out('Shell builtins:\n  cd  pwd  export  unset  exit  history\n')
  return 0
}

export const motd: Program = async p => {
  try {
    p.out(String(await fsp.readFile('/etc/motd', 'utf8')))
  } catch {}
  return 0
}
