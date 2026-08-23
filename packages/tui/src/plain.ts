// Folds text so the grid holds one code point per cell.
//
// A Surface allocates one cell per code point. The parser on the other side of
// the pty allocates one per grapheme, and two for CJK. So U+2764 U+FE0F is two
// cells here and one there, a joined emoji sequence is three here and one
// there, and a CJK character is one here and two there. Each case shifts the
// rest of that row in the host's buffer, and whatever the layout keeps at the
// right margin is lost: in circ, the divider and the outer border. The diff
// cannot repair it, because it compares against its own model of the row.
//
// Incoming text is therefore folded to one cell per cluster before it is drawn:
//
//   A cluster that is a single code point the grid can hold in one cell passes
//   through. Everything else becomes one symbol from the pool.
//
// The website does the same, substituting plain symbols for emoji it has no
// glyph for. No allowlist is needed: characters such as the card suits, stars
// and box shapes are already one cell and pass the rule.

/**
 * Replacement symbols for emoji.
 *
 * Blocks, geometric shapes and braille only. Every code point here falls in a
 * Unicode block the coverage font carries in full (2580..25FF, 2800..28FF), so
 * coverage follows from the ranges rather than needing to be checked per entry.
 * No box drawing: a box character arriving in a message would read as a broken
 * frame, which is the fault this module exists to prevent.
 */
const POOL = [...'▀▄█▌▐░▒▓■□▪▬▲△▼▽◆◇○●◐◑◘◙◢◣◤◥◦⣿⣤⡿']

/**
 * Ranges the host renders as two cells. Written as escapes, since CJK literals
 * in source cannot be checked by eye.
 */
const WIDE = new RegExp(
  '[\\u1100-\\u115F\\u2329\\u232A\\u2E80-\\u303E\\u3041-\\uA4CF\\uA960-\\uA97F'
  + '\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE10-\\uFE19\\uFE30-\\uFE6F'
  + '\\uFF00-\\uFF60\\uFFE0-\\uFFE6]')

/**
 * Ranges that occupy no cell: combining marks, joiners and variation selectors,
 * plus three the parser's table treats as zero-width where the Unicode
 * categories do not (an Arabic sign, the Hangul jamo fillers, and U+3040).
 * Determined by measurement.
 */
const ZERO = /[\p{M}\p{Cf}\u06DE\u1160-\u11FF\u3040]/u

/** Exactly one cell, and printable. */
export function oneCell(ch: string): boolean {
  const cp = ch.codePointAt(0)
  if (cp === undefined || cp > 0xffff) return false
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false
  return !WIDE.test(ch) && !ZERO.test(ch)
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

/**
 * Pool index for a cluster, as FNV-1a over its code points.
 *
 * Hashed rather than chosen at random, as the website does, because a message
 * here is redrawn every frame and a random choice would change the glyph on
 * each one. The same cluster must map to the same symbol every time and for
 * every viewer.
 */
function pick(cluster: string): string {
  let h = 0x811c9dc5
  for (const ch of cluster) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return POOL[h % POOL.length]!
}

/** Split into grapheme clusters, falling back to code points without Intl.Segmenter. */
function clusters(text: string): string[] {
  if (!segmenter) return [...text]
  const out: string[] = []
  for (const { segment } of segmenter.segment(text)) out.push(segment)
  return out
}

/**
 * Fold text to one cell per character.
 *
 * Normalised to NFC first, so a decomposed accented character becomes the
 * single code point the font carries rather than being replaced.
 */
export function plain(text: string): string {
  if (!text) return text
  const norm = text.normalize('NFC')
  // Pure ASCII needs no folding, which covers nearly every line, so the
  // segmenter is skipped.
  if (!/[^\x20-\x7e\t\n]/.test(norm)) return norm
  let out = ''
  for (const cluster of clusters(norm)) {
    if (cluster === '\n' || cluster === '\t') out += cluster
    else if ([...cluster].length === 1 && oneCell(cluster)) out += cluster
    else out += pick(cluster)
  }
  return out
}
