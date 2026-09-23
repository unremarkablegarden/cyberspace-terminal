// System tools: date uname whoami hostname env which clear sleep true false motd.

import { readText, writeLines, type Program } from '@cyberspace/kernel'
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

export const motd: Program = async p => {
  try {
    writeLines(p.stdout, await readText('/etc/motd'))
  } catch {}
  return 0
}
