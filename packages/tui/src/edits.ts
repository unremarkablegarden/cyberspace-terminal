// Caret and selection helpers over a single string, shared by the line editor,
// InputLine and TextBuffer so word motion and selection order are defined once.

/** Start of the word at or before pos: skip spaces left, then non-spaces left. */
export function wordLeft(str: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, str.length))
  while (i > 0 && /\s/.test(str[i - 1]!)) i--
  while (i > 0 && !/\s/.test(str[i - 1]!)) i--
  return i
}

/** End of the word at or after pos: skip spaces right, then non-spaces right. */
export function wordRight(str: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, str.length))
  while (i < str.length && /\s/.test(str[i]!)) i++
  while (i < str.length && !/\s/.test(str[i]!)) i++
  return i
}

/** Anchor and caret ordered low to high, or null when there is no selection. */
export function selRange(anchor: number | null, pos: number): [number, number] | null {
  if (anchor === null || anchor === pos) return null
  return anchor < pos ? [anchor, pos] : [pos, anchor]
}
