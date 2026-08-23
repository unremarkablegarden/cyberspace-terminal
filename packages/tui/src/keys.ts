// stdin bytes -> key events, shaped like the DOM events TextBuffer grew up on.

export interface KeyInput {
  /** A single character, or a DOM-style name (Enter, ArrowUp, ...). */
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** From a CSI modifier parameter: xterm reports Shift+Arrow as `1;2A`. */
  shiftKey: boolean
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

const plain = (key: string, ctrl = false, shift = false): KeyInput =>
  ({ key, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: shift })

// CSI modifier parameter, one greater than a bitmask: 1 shift, 2 alt, 4 ctrl.
function modifiers(params: string): { shift: boolean; ctrl: boolean } {
  const n = Number(params.split(';')[1] ?? 1) - 1
  return { shift: (n & 1) !== 0, ctrl: (n & 4) !== 0 }
}

/** Decode one chunk. Escape sequences never split across reads in practice. */
export function parseKeys(text: string): KeyInput[] {
  const out: KeyInput[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\x1b') {
      const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(text.slice(i))
      if (m) {
        const mod = modifiers(m[1])
        // CSI u: `104;5u` is Ctrl+h — the codepoint is the first parameter.
        if (m[2] === 'u') {
          const code = Number(m[1].split(';')[0])
          if (code > 0) out.push(plain(String.fromCharCode(code), mod.ctrl, mod.shift))
          i += m[0].length
          continue
        }
        // A modified key carries its parameters: `1;2A` is Shift+Up. The table
        // is keyed by the bare form, so the first parameter is dropped.
        const bare = (m[1].includes(';') ? '' : m[1]) + m[2]
        const name = CSI[bare] ?? CSI[m[2]]
        if (name) out.push(plain(name, mod.ctrl, mod.shift))
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
