// Text tools: grep head tail sort uniq wc echo.

import type { Program } from '@cyberspace/kernel'
import { flags, inputText, toLines } from './util.js'

export const grep: Program = async p => {
  const { f, args } = flags(p, '')
  if (!args.length) { p.err('usage: grep [-inv] pattern [file...]\n'); return 2 }
  const [pattern, ...files] = args
  let re: RegExp
  try {
    re = new RegExp(pattern, f.has('i') ? 'i' : '')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), f.has('i') ? 'i' : '')
  }
  const lines = toLines(await inputText(p, files))
  let matched = 0
  lines.forEach((line, i) => {
    if (re.test(line) !== f.has('v')) {
      matched++
      p.out((f.has('n') ? `${i + 1}:` : '') + line + '\n')
    }
  })
  return matched ? 0 : 1
}

export const head: Program = async p => {
  const { args, n } = flags(p, 'n')
  const lines = toLines(await inputText(p, args))
  for (const line of lines.slice(0, n ?? 10)) p.out(line + '\n')
  return 0
}

export const tail: Program = async p => {
  const { args, n } = flags(p, 'n')
  const lines = toLines(await inputText(p, args))
  for (const line of lines.slice(-(n ?? 10))) p.out(line + '\n')
  return 0
}

export const sort: Program = async p => {
  const { f, args } = flags(p, '')
  let lines = toLines(await inputText(p, args)).sort()
  if (f.has('n')) lines = lines.sort((a, b) => Number(a) - Number(b))
  if (f.has('r')) lines.reverse()
  if (f.has('u')) lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1])
  for (const line of lines) p.out(line + '\n')
  return 0
}

export const uniq: Program = async p => {
  const { f, args } = flags(p, '')
  const lines = toLines(await inputText(p, args))
  let prev: string | null = null
  let count = 0
  const emit = () => {
    if (prev === null) return
    p.out((f.has('c') ? `${String(count).padStart(7)} ` : '') + prev + '\n')
  }
  for (const line of lines) {
    if (line === prev) { count++; continue }
    emit()
    prev = line
    count = 1
  }
  emit()
  return 0
}

export const wc: Program = async p => {
  const { f, args } = flags(p, '')
  const text = await inputText(p, args)
  const l = toLines(text).length
  const w = text.split(/\s+/).filter(Boolean).length
  const c = text.length
  const all = !f.has('l') && !f.has('w') && !f.has('c')
  const parts: string[] = []
  if (all || f.has('l')) parts.push(String(l).padStart(7))
  if (all || f.has('w')) parts.push(String(w).padStart(7))
  if (all || f.has('c')) parts.push(String(c).padStart(7))
  p.out(parts.join('') + '\n')
  return 0
}

export const echo: Program = p => {
  const av = p.argv.slice(1)
  const noNewline = av[0] === '-n'
  p.out((noNewline ? av.slice(1) : av).join(' ') + (noNewline ? '' : '\n'))
  return 0
}
