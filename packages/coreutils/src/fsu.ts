// File tools: ls cat cp mv rm mkdir rmdir touch tree chmod.

import { paths, type Proc, type Program } from '@cyberspace/kernel'
import { fsp, resolve, flags, inputText, strerror } from './util.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function modeString(mode: number, dir: boolean): string {
  let s = dir ? 'd' : '-'
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7
    s += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-')
  }
  return s
}

function dateString(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${hh}:${mm}`
}

export const ls: Program = async p => {
  const { f, args } = flags(p, '')
  const targets = args.length ? args : ['.']
  const showAll = f.has('a')
  const long = f.has('l')
  let code = 0

  for (let t = 0; t < targets.length; t++) {
    const target = resolve(p, targets[t])
    let st
    try {
      st = await fsp.stat(target)
    } catch {
      p.err(`ls: ${targets[t]}: No such file or directory\n`)
      code = 1
      continue
    }

    let names: string[]
    let base = target
    if (st.isDirectory()) {
      names = (await fsp.readdir(target)).sort()
      if (!showAll) names = names.filter(n => !n.startsWith('.'))
      if (targets.length > 1) p.out((t ? '\n' : '') + targets[t] + ':\n')
    } else {
      names = [paths.basename(target)]
      base = paths.dirname(target)
    }

    if (long) {
      for (const name of names) {
        const s = await fsp.stat(paths.join(base, name)).catch(() => null)
        if (!s) continue
        const dir = s.isDirectory()
        p.out(`${modeString(s.mode & 0o777, dir)} ${String(s.size).padStart(8)} ${dateString(s.mtimeMs)} ${name}${dir ? '/' : ''}\n`)
      }
    } else if (names.length) {
      const marked: string[] = []
      for (const name of names) {
        const s = await fsp.stat(paths.join(base, name)).catch(() => null)
        marked.push(s?.isDirectory() ? name + '/' : name)
      }
      const cols = p.tty?.cols ?? (Number(p.env.COLUMNS) || 80)
      const w = Math.max(...marked.map(n => n.length)) + 2
      const per = Math.max(1, Math.floor(cols / w))
      for (let i = 0; i < marked.length; i += per) {
        p.out(marked.slice(i, i + per).map(s => s.padEnd(w)).join('').trimEnd() + '\n')
      }
    }
  }
  return code
}

export const cat: Program = async p => {
  const { args } = flags(p, '')
  p.out(await inputText(p, args))
  return 0
}

async function copyTree(src: string, dst: string): Promise<void> {
  const st = await fsp.stat(src)
  if (st.isDirectory()) {
    await fsp.mkdir(dst).catch(() => {})
    for (const name of await fsp.readdir(src)) {
      await copyTree(paths.join(src, name), paths.join(dst, name))
    }
  } else {
    await fsp.writeFile(dst, await fsp.readFile(src))
  }
}

async function destFor(p: Proc, src: string, dst: string): Promise<string> {
  const st = await fsp.stat(dst).catch(() => null)
  return st?.isDirectory() ? paths.join(dst, paths.basename(src)) : dst
}

export const cp: Program = async p => {
  const { f, args } = flags(p, '')
  if (args.length < 2) { p.err('usage: cp [-r] source... dest\n'); return 1 }
  const dst = resolve(p, args[args.length - 1])
  for (const arg of args.slice(0, -1)) {
    const src = resolve(p, arg)
    const st = await fsp.stat(src).catch(() => null)
    if (!st) { p.err(`cp: ${arg}: No such file or directory\n`); return 1 }
    if (st.isDirectory() && !f.has('r')) { p.err(`cp: ${arg}: Is a directory\n`); return 1 }
    await copyTree(src, await destFor(p, src, dst))
  }
  return 0
}

export const mv: Program = async p => {
  const { args } = flags(p, '')
  if (args.length < 2) { p.err('usage: mv source... dest\n'); return 1 }
  const dst = resolve(p, args[args.length - 1])
  for (const arg of args.slice(0, -1)) {
    const src = resolve(p, arg)
    const to = await destFor(p, src, dst)
    try {
      await fsp.rename(src, to)
    } catch (e) {
      // EPERM is a mount refusing renames outright; anything else is
      // cross-mount, so copy then remove.
      if ((e as { code?: string })?.code === 'EPERM') {
        p.err(`mv: ${arg}: ${strerror(e)}\n`)
        return 1
      }
      await copyTree(src, to)
      await removeTree(src)
    }
  }
  return 0
}

async function removeTree(target: string): Promise<void> {
  const st = await fsp.stat(target)
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(target)) {
      await removeTree(paths.join(target, name))
    }
    await fsp.rmdir(target)
  } else {
    await fsp.unlink(target)
  }
}

export const rm: Program = async p => {
  const { f, args } = flags(p, '')
  if (!args.length) { p.err('usage: rm [-rf] file...\n'); return 1 }
  let code = 0
  for (const arg of args) {
    const target = resolve(p, arg)
    const st = await fsp.stat(target).catch(() => null)
    if (!st) {
      if (!f.has('f')) { p.err(`rm: ${arg}: No such file or directory\n`); code = 1 }
      continue
    }
    if (st.isDirectory() && !f.has('r')) {
      p.err(`rm: ${arg}: Is a directory\n`)
      code = 1
      continue
    }
    try {
      await removeTree(target)
    } catch (e) {
      p.err(`rm: ${arg}: ${strerror(e)}\n`)
      code = 1
    }
  }
  return code
}

export const mkdir: Program = async p => {
  const { f, args } = flags(p, '')
  if (!args.length) { p.err('usage: mkdir [-p] dir...\n'); return 1 }
  for (const arg of args) {
    const target = resolve(p, arg)
    if (f.has('p')) {
      let cur = ''
      for (const seg of target.split('/').filter(Boolean)) {
        cur += '/' + seg
        await fsp.mkdir(cur).catch(() => {})
      }
    } else {
      try {
        await fsp.mkdir(target)
      } catch {
        p.err(`mkdir: cannot create directory '${arg}'\n`)
        return 1
      }
    }
  }
  return 0
}

export const rmdir: Program = async p => {
  const { args } = flags(p, '')
  for (const arg of args) {
    try {
      await fsp.rmdir(resolve(p, arg))
    } catch {
      p.err(`rmdir: ${arg}: Directory not empty\n`)
      return 1
    }
  }
  return 0
}

export const touch: Program = async p => {
  const { args } = flags(p, '')
  for (const arg of args) {
    const target = resolve(p, arg)
    const exists = await fsp.stat(target).catch(() => null)
    if (!exists) await fsp.writeFile(target, new Uint8Array())
  }
  return 0
}

export const tree: Program = async p => {
  const { f, args } = flags(p, '')
  const all = f.has('a')
  let dirs = 0
  let files = 0
  let code = 0

  const walk = async (dir: string, indent: string): Promise<void> => {
    let names = (await fsp.readdir(dir)).sort()
    if (!all) names = names.filter(n => !n.startsWith('.'))
    const entries: { name: string; dir: boolean }[] = []
    for (const name of names) {
      const s = await fsp.stat(paths.join(dir, name)).catch(() => null)
      entries.push({ name, dir: !!s?.isDirectory() })
    }
    // Directories first, matching the legacy tree.
    entries.sort((a, b) => Number(b.dir) - Number(a.dir))
    for (let i = 0; i < entries.length; i++) {
      if (p.signal.aborted) return
      const { name, dir: isDir } = entries[i]
      const last = i === entries.length - 1
      p.out(`${indent}${last ? '└── ' : '├── '}${name}${isDir ? '/' : ''}\n`)
      if (isDir) {
        dirs++
        await walk(paths.join(dir, name), indent + (last ? '    ' : '│   '))
      } else {
        files++
      }
    }
  }

  for (const arg of args.length ? args : ['.']) {
    const target = resolve(p, arg)
    const st = await fsp.stat(target).catch(() => null)
    if (!st) { p.err(`tree: ${arg}: No such file or directory\n`); code = 1; continue }
    if (!st.isDirectory()) { p.err(`tree: ${arg}: Not a directory\n`); code = 1; continue }
    p.out(arg + '\n')
    await walk(target, '')
    if (p.signal.aborted) return 130
  }
  p.out(`\n${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}\n`)
  return code
}

const WHO: Record<string, number> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 }

/**
 * The new permission bits for `spec` applied to `mode`, or null when `spec` is
 * not a mode. Takes octal (1 to 4 digits) or comma-separated symbolic clauses,
 * [ugoa]*([-+=][rwxX]*)+. An empty who means `a`: there is no umask here.
 * X adds execute only to directories and to files that already have it.
 */
export function applyMode(spec: string, mode: number, dir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8)
  let perm = mode & 0o7777
  for (const clause of spec.split(',')) {
    const m = clause.match(/^([ugoa]*)((?:[-+=][rwxX]*)+)$/)
    if (!m) return null
    let mask = 0
    for (const c of m[1] || 'a') mask |= WHO[c]
    for (const [, op, letters] of m[2].matchAll(/([-+=])([rwxX]*)/g)) {
      let bits = 0
      for (const c of letters) {
        if (c === 'r') bits |= 4
        else if (c === 'w') bits |= 2
        else if (c === 'x' || dir || perm & 0o111) bits |= 1 // x, or X when it applies
      }
      const val = (bits * 0o111) & mask
      if (op === '+') perm |= val
      else if (op === '-') perm &= ~val
      else perm = (perm & ~mask) | val
    }
  }
  return perm
}

// argv is read directly: flags() would take a mode such as -x for a flag.
export const chmod: Program = async p => {
  const av = p.argv.slice(1)
  const recursive = av[0] === '-R'
  if (recursive) av.shift()
  const [spec, ...targets] = av
  if (!spec || !targets.length) { p.err('usage: chmod [-R] mode file...\n'); return 1 }
  if (applyMode(spec, 0, false) === null) { p.err(`chmod: invalid mode: '${spec}'\n`); return 1 }

  const change = async (path: string): Promise<void> => {
    const st = await fsp.stat(path)
    const dir = st.isDirectory()
    await fsp.chmod(path, applyMode(spec, st.mode, dir)!)
    if (recursive && dir) {
      for (const name of await fsp.readdir(path)) await change(paths.join(path, name))
    }
  }

  let code = 0
  for (const arg of targets) {
    try {
      await change(resolve(p, arg))
    } catch (e) {
      p.err(`chmod: ${arg}: ${strerror(e)}\n`)
      code = 1
    }
  }
  return code
}
