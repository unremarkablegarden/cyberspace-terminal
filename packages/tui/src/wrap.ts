// Word wrapping for prose drawn inside a box.
//
// Not fold(), which breaks at the column: correct for an editor buffer, where
// the caret must land on a real character, and wrong for a sentence. A line
// already short enough is returned unchanged rather than re-spaced.

/** Expand tabs to 8-column stops; the grid has no glyph for U+0009. */
function expandTabs(line: string): string {
  let out = ''
  for (const ch of line) {
    if (ch !== '\t') { out += ch; continue }
    out += ' '.repeat(8 - (out.length % 8))
  }
  return out
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = []

  for (const raw of text.split('\n')) {
    const para = raw.includes('\t') ? expandTabs(raw) : raw
    if (para.length <= width) { out.push(para); continue }

    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) { out.push(''); continue }

    let line = ''
    for (let word of words) {
      // A word longer than the column is broken at the margin rather than
      // allowed to overrun it. Usually a URL.
      while (word.length > width) {
        if (line) { out.push(line); line = '' }
        out.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else { out.push(line); line = word }
    }
    if (line) out.push(line)
  }

  return out
}
