// Word expansion: $VAR / ${VAR} / $?, leading ~, pathname globs.
// No word splitting of expansions, no command substitution.

import { fs, paths } from '@cyberspace/kernel'
import type { Word } from './parse.js'

export interface ExpandCtx {
  vars: Record<string, string>
  env: Record<string, string>
  status: number
  cwd: string
}

function lookup(ctx: ExpandCtx, name: string): string {
  if (name === '?') return String(ctx.status)
  return ctx.vars[name] ?? ctx.env[name] ?? ''
}

const VAR = /\$(\?|[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g

function expandVars(ctx: ExpandCtx, text: string): string {
  return text.replace(VAR, (_, name: string) =>
    lookup(ctx, name.startsWith('{') ? name.slice(1, -1) : name))
}

const GLOB_CHARS = /[*?[]/

function globToRegExp(seg: string): RegExp | null {
  if (!GLOB_CHARS.test(seg)) return null
  let re = '^'
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2)
      if (end < 0) { re += '\\['; continue }
      let cls = seg.slice(i + 1, end)
      if (cls.startsWith('!')) cls = '^' + cls.slice(1)
      re += '[' + cls.replace(/\\/g, '\\\\') + ']'
      i = end
    } else re += c.replace(/[.+^${}()|\\\/]/g, '\\$&')
  }
  try { return new RegExp(re + '$') } catch { return null }
}

async function glob(cwd: string, pattern: string): Promise<string[]> {
  const abs = pattern.startsWith('/')
  const segs = (abs ? pattern.slice(1) : pattern).split('/').filter(s => s !== '')
  let bases = [abs ? '/' : cwd]
  let literalSoFar = abs ? '/' : ''

  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    const re = globToRegExp(seg)
    const next: string[] = []
    const nextLit: string[] = []
    for (let b = 0; b < bases.length; b++) {
      const base = bases[b]
      if (!re) {
        next.push(paths.join(base, seg))
        continue
      }
      let names: string[] = []
      try { names = await fs.promises.readdir(base) } catch { continue }
      for (const name of names.sort()) {
        if (name.startsWith('.') && !seg.startsWith('.')) continue
        if (re.test(name)) next.push(paths.join(base, name))
      }
    }
    void nextLit; void literalSoFar
    bases = next
    if (!bases.length) return []
  }

  // Only keep paths that exist (literal tail segments may not).
  const out: string[] = []
  for (const p of bases) {
    try { await fs.promises.stat(p); out.push(p) } catch {}
  }
  return out
}

/** Relativize glob results when the pattern was relative. */
function relativize(cwd: string, pattern: string, matches: string[]): string[] {
  if (pattern.startsWith('/')) return matches
  const prefix = cwd === '/' ? '/' : cwd + '/'
  return matches.map(m => (m.startsWith(prefix) ? m.slice(prefix.length) : m))
}

/** Expand one word to fields (globs may fan out; otherwise one field). */
export async function expandWord(ctx: ExpandCtx, word: Word): Promise<string[]> {
  let value = ''
  let pattern = ''
  let hasGlob = false

  for (let i = 0; i < word.segments.length; i++) {
    const seg = word.segments[i]
    let text = seg.text
    if (seg.quote !== 'single') text = expandVars(ctx, text)
    if (seg.quote === 'none' && i === 0 && text.startsWith('~')) {
      const home = ctx.env.HOME ?? '/'
      if (text === '~' || text.startsWith('~/')) text = home + text.slice(1)
    }
    value += text
    if (seg.quote === 'none') {
      if (GLOB_CHARS.test(text)) hasGlob = true
      pattern += text
    } else {
      // Quoted text never globs; escape it in the pattern.
      pattern += text.replace(/[*?[]/g, '\\$&')
    }
  }

  if (hasGlob) {
    const matches = await glob(ctx.cwd, pattern)
    if (matches.length) return relativize(ctx.cwd, pattern, matches)
  }
  return [value]
}

/** Expand to exactly one string (redirect targets, assignment values). */
export async function expandOne(ctx: ExpandCtx, word: Word): Promise<string> {
  const fields = await expandWord(ctx, word)
  return fields[0] ?? ''
}
