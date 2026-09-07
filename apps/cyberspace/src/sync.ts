// sync(1): run the home sync now and say what moved.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import type { ApiClient } from './api.js'
import type { HomeKey } from './homekey.js'
import { resetHome, sync, type Report } from './homesync.js'

const VERB_W = 10

/** One raw keypress. True on y or Y; anything else, EOF or ^C is no. */
async function confirm(p: Proc, prompt: string): Promise<boolean> {
  const tty = p.tty
  if (!tty) return false
  p.out(prompt)
  tty.setRaw()
  try {
    const chunk = await p.stdin.read()
    const ch = chunk ? dec.decode(chunk)[0] ?? '' : ''
    tty.echo(ch >= ' ' ? ch + '\n' : '\n')
    return ch === 'y' || ch === 'Y'
  } finally {
    tty.setCooked()
  }
}

export function syncProgram(api: ApiClient, key: HomeKey): Program {
  return async p => {
    if (!api.authed) { p.err('sync: not logged in\n'); return 1 }
    if (!api.supporter) { p.err('sync: home sync is for supporters\n'); return 1 }
    const verb = p.argv[1]
    if (verb && verb !== 'reset') { p.err('usage: sync [reset]\n'); return 1 }
    let report: Report
    try {
      if (verb === 'reset') {
        if (!(await confirm(p, 'Discard the server copy? (y/N) '))) return 1
        await resetHome(api, key)
      }
      report = await sync(api, key, p.env.HOME ?? '/')
    } catch (e) {
      p.err(`sync: ${(e as Error).message ?? String(e)}\n`)
      return 1
    }
    if (!report.lines.length) { p.out('Up to date.\n'); return 0 }
    let files = 0, conflicts = 0, skipped = 0
    for (const l of report.lines) {
      const note = l.verb === 'conflict' ? ` -> ${l.note}` : l.note ? `  (${l.note})` : ''
      p.out(`${l.verb.padEnd(VERB_W)}${l.path}${note}\n`)
      if (l.verb === 'conflict') conflicts++
      else if (l.verb === 'skipped') skipped++
      else files++
    }
    const parts = [`${files} file${files === 1 ? '' : 's'}`]
    if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`)
    if (skipped) parts.push(`${skipped} skipped`)
    p.out(parts.join(', ') + '\n')
    return skipped ? 1 : 0
  }
}
