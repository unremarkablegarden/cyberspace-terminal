// POSIX path helpers. No node:path in the browser.

export function normalize(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return abs ? '/' + joined : joined || '.'
}

export function resolve(cwd: string, p: string): string {
  if (!p) return normalize(cwd)
  return normalize(p.startsWith('/') ? p : cwd + '/' + p)
}

export function join(...parts: string[]): string {
  return normalize(parts.join('/'))
}

export function dirname(p: string): string {
  const n = normalize(p)
  const i = n.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return n.slice(0, i)
}

export function basename(p: string): string {
  const n = normalize(p)
  const i = n.lastIndexOf('/')
  return i < 0 ? n : n.slice(i + 1)
}
