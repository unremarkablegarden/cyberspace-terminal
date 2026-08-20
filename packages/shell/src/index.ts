// The shell program: prompt loop, history, tab completion.

import { fs, paths, type Proc, type Program } from '@cyberspace/kernel'
import { Readline, type Completion } from './readline.js'
import { runLine, ShellExit, setHistoryBuiltin, builtinNames, type ShellState } from './run.js'

const HISTFILE = '.sh_history'
const HISTMAX = 500

export const shellMain: Program = async (p: Proc) => {
  if (!p.tty) {
    p.err('sh: interactive shell needs a tty\n')
    return 1
  }

  const sh: ShellState = {
    proc: p,
    vars: {},
    cwd: p.cwd,
    status: 0,
  }

  const rl = new Readline(p.tty, p.stdin, s => p.stdout.write(s), (line, cursor) =>
    complete(sh, line, cursor))

  const histPath = paths.join(p.env.HOME ?? '/', HISTFILE)
  try {
    const text = await fs.promises.readFile(histPath, 'utf8')
    rl.history = String(text).split('\n').filter(Boolean).slice(-HISTMAX)
  } catch {}

  setHistoryBuiltin((s, proc) => {
    rl.history.forEach((h, i) => proc.out(`${String(i + 1).padStart(5)}  ${h}\n`))
    void s
    return 0
  })

  for (;;) {
    const line = await rl.read(prompt(sh))
    if (line === null) {
      p.out('logout\n')
      return 0
    }
    const trimmed = line.trim()
    if (!trimmed) continue

    if (rl.history[rl.history.length - 1] !== trimmed) {
      rl.history.push(trimmed)
      if (rl.history.length > HISTMAX) rl.history.shift()
      void fs.promises.writeFile(histPath, rl.history.join('\n') + '\n').catch(() => {})
    }

    try {
      // Cooked while a job runs: line input with echo, ^C -> SIGINT.
      p.tty.setCooked()
      await runLine(sh, trimmed)
    } catch (e) {
      if (e instanceof ShellExit) return e.code
      p.err(`sh: ${(e as Error)?.message ?? e}\n`)
      sh.status = 1
    }
  }
}

function prompt(sh: ShellState): string {
  const user = sh.proc.env.USER ?? 'guest'
  const host = sh.proc.env.HOSTNAME ?? 'cyberspace'
  const home = sh.proc.env.HOME ?? ''
  let cwd = sh.cwd
  if (home && (cwd === home || cwd.startsWith(home + '/'))) cwd = '~' + cwd.slice(home.length)
  return `\x1b[1m${user}@${host}\x1b[0m:${cwd}$ `
}

async function complete(sh: ShellState, line: string, cursor: number): Promise<Completion> {
  const head = line.slice(0, cursor)
  const m = /(\S*)$/.exec(head)
  const word = m?.[1] ?? ''
  const isFirst = head.slice(0, head.length - word.length).trim() === ''

  let candidates: string[]
  let prefix = word

  if (isFirst && !word.includes('/')) {
    candidates = [...sh.proc.kernel.names(), ...builtinNames()]
      .sort()
      .filter(n => n.startsWith(word))
      .map(n => n + ' ')
  } else {
    const expanded = word.replace(/^~(?=\/|$)/, sh.proc.env.HOME ?? '')
    const abs = paths.resolve(sh.cwd, expanded || '.')
    const listDir = expanded.endsWith('/') || expanded === ''
    const dir = listDir ? abs : paths.dirname(abs)
    const base = listDir ? '' : paths.basename(abs)
    prefix = base
    let names: string[] = []
    try { names = await fs.promises.readdir(dir) } catch { return {} }
    candidates = []
    for (const name of names.sort()) {
      if (!name.startsWith(base)) continue
      if (name.startsWith('.') && !base.startsWith('.')) continue
      let full = name
      try {
        const st = await fs.promises.stat(paths.join(dir, name))
        if (st.isDirectory()) full += '/'
        else full += ' '
      } catch {}
      candidates.push(full)
    }
  }

  if (!candidates.length) return {}
  if (candidates.length === 1) return { insert: candidates[0].slice(prefix.length) }

  let common = candidates[0]
  for (const c of candidates) {
    while (!c.startsWith(common)) common = common.slice(0, -1)
  }
  common = common.replace(/[ /]$/, '')
  if (common.length > prefix.length) return { insert: common.slice(prefix.length) }
  return { list: candidates.map(c => c.trimEnd()) }
}
