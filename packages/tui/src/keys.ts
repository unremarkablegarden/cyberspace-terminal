// stdin bytes -> key events, shaped like the DOM events TextBuffer grew up on.

export interface KeyInput {
  /** A single character, or a DOM-style name (Enter, ArrowUp, ...). */
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

const CSI: Record<string, string> = {
  A: 'ArrowUp',
  B: 'ArrowDown',
  C: 'ArrowRight',
  D: 'ArrowLeft',
  H: 'Home',
  F: 'End',
  '3~': 'Delete',
  '5~': 'PageUp',
  '6~': 'PageDown',
  '1~': 'Home',
  '4~': 'End',
}

const plain = (key: string, ctrl = false): KeyInput =>
  ({ key, ctrlKey: ctrl, metaKey: false, altKey: false })

/** Decode one chunk. Escape sequences never split across reads in practice. */
export function parseKeys(text: string): KeyInput[] {
  const out: KeyInput[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\x1b') {
      const m = /^\x1b\[([0-9;]*[A-Za-z~])/.exec(text.slice(i))
      if (m) {
        const name = CSI[m[1]]
        if (name) out.push(plain(name))
        i += m[0].length
        continue
      }
      out.push(plain('Escape'))
      i++
      continue
    }
    if (c === '\r' || c === '\n') { out.push(plain('Enter')); i++; continue }
    if (c === '\t') { out.push(plain('Tab')); i++; continue }
    if (c === '\x7f' || c === '\b') { out.push(plain('Backspace')); i++; continue }
    const code = c.charCodeAt(0)
    if (code < 32) {
      out.push(plain(String.fromCharCode(code + 96), true))
      i++
      continue
    }
    out.push(plain(c))
    i++
  }
  return out
}
