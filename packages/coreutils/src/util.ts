// Shared helpers for the tools.

import { fs, paths, readAll, type Proc, readText } from '@cyberspace/kernel'

export const fsp = fs.promises

export function resolve(p: Proc, arg: string): string {
  return paths.resolve(p.cwd, arg.replace(/^~(?=\/|$)/, p.env.HOME ?? '/'))
}

/** Split argv into flags (single-dash letters) and positional args. */
export function flags(p: Proc, spec: string): { f: Set<string>; args: string[]; n?: number } {
  const f = new Set<string>()
  const args: string[] = []
  let n: number | undefined
  const av = p.argv.slice(1)
  for (let i = 0; i < av.length; i++) {
    const a = av[i]
    if (a === '--') { args.push(...av.slice(i + 1)); break }
    if (a === '-n' && spec.includes('n')) { n = Number(av[++i]); continue }
    if (/^-\d+$/.test(a) && spec.includes('n')) { n = Number(a.slice(1)); continue }
    if (a.startsWith('-') && a.length > 1) {
      for (const c of a.slice(1)) f.add(c)
      continue
    }
    args.push(a)
  }
  return { f, args, n }
}

const ERRNO: Record<string, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EACCES: 'Permission denied',
  EIO: 'Input/output error',
}

/** The usual message for an errno. Anything else reports itself. */
export function strerror(e: unknown): string {
  const { code, message } = e as { code?: string; message?: string }
  if (code) return ERRNO[code] ?? code
  return message || 'Error'
}

/** Concatenated text of the given files, or stdin when none. */
export async function inputText(p: Proc, files: string[]): Promise<string> {
  if (!files.length) return readAll(p.stdin)
  let out = ''
  for (const file of files) {
    try {
      out += await readText(resolve(p, file))
    } catch (e) {
      throw new Error(`${file}: ${strerror(e)}`)
    }
  }
  return out
}

export function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
