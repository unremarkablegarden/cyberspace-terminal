// Key names -> terminal input bytes. Minimal set for now.

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

/** Encode by key name — shared by physical keys and the soft keyboard. */
export function encodeKeyName(key: string, ctrl = false): string | null {
  if (ctrl) {
    if (key.length !== 1) return null
    const c = key.toUpperCase().charCodeAt(0)
    return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : null
  }
  const named = NAMED[key]
  if (named) return named
  return key.length === 1 ? key : null
}

export function encodeKey(e: KeyboardEvent): string | null {
  if (e.metaKey || e.altKey) return null
  return encodeKeyName(e.key, e.ctrlKey)
}
