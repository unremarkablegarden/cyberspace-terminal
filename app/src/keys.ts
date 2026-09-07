// Key names -> terminal input bytes. Minimal set for now.

const NAMED: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  '§': '\x1b', // typed as text by the iPad soft keyboard; see aliasKey
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
}

// The CSI final byte for a movement key, for the modified forms below.
const MOVE_FINAL: Record<string, string> = {
  ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F',
}

// Copy and cut as CSI u, decoded by parseKeys as Ctrl+Shift+c / Ctrl+Shift+x
// (code 99 = 'c', 120 = 'x'; modifier 6 = 1 + shift(1) + ctrl(4)). Both the
// macOS Cmd chord and the Ctrl+Shift chord map here, so Ctrl+C stays SIGINT.
const COPY = '\x1b[99;6u'
const CUT = '\x1b[120;6u'

/**
 * A movement key with a modifier, as xterm's `CSI 1 ; mod final`. mod is one
 * greater than a bitmask: shift 1, ctrl 4. Alt is folded onto ctrl, since both
 * mean word granularity here and parseKeys decodes only shift and ctrl. Returns
 * null for a plain, unmodified key, which stays the short form in NAMED.
 */
function modifiedMove(key: string, shift: boolean, word: boolean): string | null {
  const final = MOVE_FINAL[key]
  if (!final) return null
  const mod = 1 + (shift ? 1 : 0) + (word ? 4 : 0)
  return mod > 1 ? `\x1b[1;${mod}${final}` : null
}

/** Encode by key name — shared by physical keys and the soft keyboard. */
export function encodeKeyName(key: string, ctrl = false): string | null {
  if (ctrl) {
    if (key.length !== 1) return null
    const c = key.toUpperCase().charCodeAt(0)
    if (c < 64 || c > 95) return null
    // ^H and ^J collide with BS and LF; CSI u keeps them distinguishable.
    if (c === 72 || c === 74) return `\x1b[${c + 32};5u`
    return String.fromCharCode(c - 64)
  }
  const named = NAMED[key]
  if (named) return named
  return key.length === 1 ? key : null
}

/**
 * Key aliases for keyboards without the key itself. iPad external keyboards
 * have no Escape and no F row (and Globe is invisible to the DOM), so:
 * § and Cmd+. -> Escape, Ctrl+Opt+digit -> F1..F9, Ctrl+Opt+0 -> F10.
 * The digit comes from e.code: with Option held e.key is the layout's
 * Option-layer character, not the digit.
 * Returns the canonical event, or the original when nothing applies.
 */
export function aliasKey(e: KeyboardEvent): KeyboardEvent {
  if (e.key === '§' || (e.key === '.' && e.metaKey && !e.ctrlKey && !e.altKey)) {
    return { ...eventFields(e), key: 'Escape', metaKey: false }
  }
  const digit = e.ctrlKey && e.altKey && !e.metaKey && /^Digit[0-9]$/.exec(e.code)?.[0].slice(5)
  if (digit) {
    return { ...eventFields(e), key: `F${digit === '0' ? 10 : digit}`, ctrlKey: false, altKey: false }
  }
  return e
}

// Only the fields the input layer reads; a spread over a real KeyboardEvent
// copies nothing (its properties live on the prototype).
const eventFields = (e: KeyboardEvent) =>
  ({
    key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey, altKey: e.altKey,
    preventDefault: () => e.preventDefault(),
  }) as KeyboardEvent

export function encodeKey(e: KeyboardEvent): string | null {
  // Cmd chords on macOS: the line-edge motion on a keyboard with no Home/End,
  // and copy/cut. Cmd+Shift+Left/Right selects to the line edge. Windows and
  // Linux have Home/End, and Super+arrow there is a window-manager shortcut the
  // page never sees. Every other Cmd chord stays with the browser.
  if (e.metaKey && !e.altKey && !e.ctrlKey) {
    if (e.key === 'ArrowLeft') return e.shiftKey ? '\x1b[1;2H' : NAMED.Home
    if (e.key === 'ArrowRight') return e.shiftKey ? '\x1b[1;2F' : NAMED.End
    if (e.key === 'c' || e.key === 'C') return COPY
    if (e.key === 'x' || e.key === 'X') return CUT
    return null
  }
  if (e.metaKey) return null

  // Ctrl+Shift+C / Ctrl+Shift+X are copy and cut where Ctrl+C must stay SIGINT.
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    if (e.key === 'c' || e.key === 'C') return COPY
    if (e.key === 'x' || e.key === 'X') return CUT
  }

  // Shift, Ctrl or Alt with a movement key: the modified CSI form, so the line
  // editors see the modifier and extend or word-jump the selection.
  const moved = modifiedMove(e.key, e.shiftKey, e.ctrlKey || e.altKey)
  if (moved) return moved

  // Option is a layer key on Mac and iPad layouts (Swedish Opt+2 = @); a
  // printable result is typed as itself. Anything else under Option is dropped.
  if (e.altKey) return e.key.length === 1 && !e.ctrlKey ? e.key : null
  return encodeKeyName(e.key, e.ctrlKey)
}
