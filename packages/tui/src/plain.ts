// Text the grid can hold: one code point per cell, or the frame loses a column.
//
// A Surface gives one cell per CODE POINT. The parser on the other side of the
// wire gives one per GRAPHEME, and two to CJK. So `❤️` (U+2764 U+FE0F) is two
// cells here and one there, `👨‍👩` is three here and one there, `中` is one here
// and two there. Any of them shifts the rest of that row in the host's buffer,
// and what falls off the end is whatever the layout keeps at the right margin —
// in cIRC, the divider and the outer border. The diff never repairs it: it
// compares against its own model of the row, and its own model says the row is
// fine.
//
// So text off the wire is folded to one cell per cluster before it is drawn.
// The rule is the whole module:
//
//   A cluster that is a single code point the grid can hold in one cell passes
//   through. Everything else becomes one symbol from the pool.
//
// Which is also how the site does it — `emoji-replace` swaps emoji for plain
// period symbols rather than showing a face this machine has no glyph for. It
// needs no whitelist here: `♥ ☆ ✧ ◕ ┻ ━ ╯ ╭ ╮ ▽` are one cell already and pass
// the rule on their own.

/**
 * What an emoji becomes.
 *
 * Blocks, geometric shapes and braille only — every code point here is in a
 * Unicode block the coverage face carries whole (2580..25FF, 2800..28FF), so
 * coverage is a property of the ranges rather than a list to re-check. No box
 * drawing: a `┼` arriving in somebody's message would read as a broken frame,
 * which is the fault this module exists to prevent.
 */
const POOL = [...'▀▄█▌▐░▒▓■□▪▬▲△▼▽◆◇○●◐◑◘◙◢◣◤◥◦⣿⣤⡿']

/**
 * Two cells on the host's side. Written as escapes: a CJK literal in a source
 * file is a range nobody can check by eye.
 */
const WIDE = new RegExp(
  '[\\u1100-\\u115F\\u2329\\u232A\\u2E80-\\u303E\\u3041-\\uA4CF\\uA960-\\uA97F'
  + '\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE10-\\uFE19\\uFE30-\\uFE6F'
  + '\\uFF00-\\uFF60\\uFFE0-\\uFFE6]')

/**
 * No cells at all: combining marks, joiners, variation selectors — plus the
 * three the parser's own table zeroes that the Unicode categories do not
 * (an Arabic sign, the Hangul jamo fillers, and U+3040). Measured, not assumed.
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
 * The pool index for a cluster. FNV-1a over its code points.
 *
 * The site picks at random, because it substitutes once when the node mounts.
 * Here a message is redrawn on every frame, and a random pick would make the
 * glyph dance for as long as the line is on the glass. The same emoji has to
 * land on the same symbol every time, and on everyone's screen.
 */
function pick(cluster: string): string {
  let h = 0x811c9dc5
  for (const ch of cluster) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return POOL[h % POOL.length]!
}

/** Split into grapheme clusters, or code points where Intl cannot. */
function clusters(text: string): string[] {
  if (!segmenter) return [...text]
  const out: string[] = []
  for (const { segment } of segmenter.segment(text)) out.push(segment)
  return out
}

/**
 * Fold text to one cell per character.
 *
 * NFC first, so a decomposed `é` becomes the single code point the face carries
 * instead of being replaced along with the emoji.
 */
export function plain(text: string): string {
  if (!text) return text
  const norm = text.normalize('NFC')
  // Nothing outside plain ASCII means nothing to fold, which is nearly every
  // line: don't segment the whole log for it.
  if (!/[^\x20-\x7e\t\n]/.test(norm)) return norm
  let out = ''
  for (const cluster of clusters(norm)) {
    if (cluster === '\n' || cluster === '\t') out += cluster
    else if ([...cluster].length === 1 && oneCell(cluster)) out += cluster
    else out += pick(cluster)
  }
  return out
}
