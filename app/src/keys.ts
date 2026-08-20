// KeyboardEvent -> terminal input bytes. Minimal set for the spike.

const NAMED: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~',
}

export function encodeKey(e: KeyboardEvent): string | null {
  if (e.metaKey || e.altKey) return null
  if (e.ctrlKey) {
    if (e.key.length !== 1) return null
    const c = e.key.toUpperCase().charCodeAt(0)
    return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : null
  }
  const named = NAMED[e.key]
  if (named) return named
  return e.key.length === 1 ? e.key : null
}
