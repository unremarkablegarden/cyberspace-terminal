// BDF (Glyph Bitmap Distribution Format) parser.
//
// Returns fixed-size cell bitmaps, one word per row, bit (cellW-1) = leftmost
// pixel. Handles faces up to 16px wide.
//
// Also synthesises glyphs most bitmap faces lack: four arrows, six block
// elements, and all 256 Braille patterns.

/**
 * @typedef {Object} BitmapFont
 * @property {Map<number, Uint16Array>} glyphs codepoint -> one word per row,
 *   bit (cellW-1) = leftmost pixel
 * @property {number} cellW
 * @property {number} cellH
 */

/**
 * Which ENCODING values to keep from a face that is not ISO10646.
 *
 * glyphs is keyed by codepoint and the parser uses ENCODING directly, which only
 * holds for ISO10646 faces (declared by CHARSET_REGISTRY). For others only
 * 0x20-0x7E maps reliably; the rest is dropped rather than mapped to codepoints
 * it would draw wrongly.
 */
const unicodeOnly = code => code >= 0x20 && code <= 0x7e

/**
 * @param {string} text contents of a .bdf file
 * @returns {BitmapFont}
 */
export function parseBDF(text) {
  const lines = text.split('\n')
  const glyphs = new Map()

  let cellW = 8, cellH = 16, ascent = 12
  let code = -1
  let bbx = null
  let bitmap = null
  // Whether ENCODING can be read as a codepoint. See unicodeOnly. Absent
  // CHARSET_REGISTRY is treated as yes.
  let unicode = true

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    if (line.startsWith('FONTBOUNDINGBOX ')) {
      const [w, h, , yoff] = line.slice(16).split(/\s+/).map(Number)
      cellW = w; cellH = h; ascent = h + yoff
    } else if (line.startsWith('CHARSET_REGISTRY ')) {
      unicode = line.includes('ISO10646')
    } else if (line.startsWith('FONT_ASCENT ')) {
      ascent = Number(line.slice(12))
    } else if (line.startsWith('ENCODING ')) {
      code = Number(line.slice(9))
    } else if (line.startsWith('BBX ')) {
      bbx = line.slice(4).split(/\s+/).map(Number)
    } else if (line === 'BITMAP') {
      bitmap = []
    } else if (line === 'ENDCHAR') {
      if (code >= 0 && bbx && bitmap && (unicode || unicodeOnly(code))) {
        glyphs.set(code, placeGlyph(bbx, bitmap, cellW, cellH, ascent))
      }
      code = -1; bbx = null; bitmap = null
    } else if (bitmap && /^[0-9A-Fa-f]+$/.test(line)) {
      bitmap.push(parseInt(line, 16) >>> 0)
    }
  }

  // Hand-drawn first, then synthesised for the rest. Neither overrides a glyph
  // the face already has.
  const hand = PATCH[`${cellW}x${cellH}`] ?? []
  const drawn = new Set(hand.map(([c]) => c))
  for (const [c, rows] of hand) {
    if (!glyphs.has(c)) glyphs.set(c, placeRows(rows, cellH))
  }
  for (const [c, rows] of synth(glyphs, cellW, cellH)) {
    if (drawn.has(c) || glyphs.has(c)) continue
    glyphs.set(c, placeRows(rows, cellH))
  }

  return { glyphs, cellW, cellH }
}

/**
 * U+21B5 for an 8x16 cell. Stem down the right, rule along the bottom, barbs at
 * 45 degrees. Rows 4..12 of 16, matching the cap height of the synthesised
 * arrows.
 */
const RETURN_8 = [
  0x00, 0x00, 0x00, 0x00,
  0x02, 0x02, 0x02, 0x02,
  0x22, 0x42,
  0xff,
  0x40, 0x20,
]

/** Hand-drawn glyphs, keyed by cell size. Override the generated ones. */
const PATCH = {
  '8x16': [
    [0x21b5, RETURN_8],
  ],
}

/**
 * The same shapes generated for any cell size.
 *
 * Proportions: glyph on rows 4..18 of 24, head widening to the full cell, stem
 * half the cell. Scaled by ratio, so a 4x6 and a 16x32 cell get the same shape.
 *
 * The rightwards arrow puts its rule on whatever rows this face's own U+2500
 * lights, so `─⭢` joins across cells.
 */
function synth(glyphs, w, h) {
  const top = Math.round(h * 4 / 24)
  const bot = Math.max(top + 2, Math.round(h * 18 / 24))
  const full = (1 << w) - 1
  const half = h >> 1
  const rows = f => Array.from({ length: h }, (_, y) => f(y))
  // CP437 shades: a dither at n/4 coverage, rows staggered.
  const shade = n => rows(y => {
    let v = 0
    for (let x = 0; x < w; x++) {
      const on = n === 1 ? (x & 1) === 0 && (y & 1) === 0
        : n === 2 ? ((x + y) & 1) === 0
        : !((x & 1) === 1 && (y & 1) === 1)
      if (on) v |= 1 << (w - 1 - x)
    }
    return v
  })
  return [
    [0x2b06, vArrow(w, h, top, bot, true)],
    [0x2b07, vArrow(w, h, top, bot, false)],
    [0x2b62, rArrow(w, h, ruleRows(glyphs, h))],
    [0x21b5, ret(w, h, top, bot)],
    // Block elements. One correct drawing per cell size, so these are exact.
    [0x2588, rows(() => full)],
    [0x2580, rows(y => (y < half ? full : 0))],
    [0x2584, rows(y => (y >= half ? full : 0))],
    [0x2591, shade(1)],
    [0x2592, shade(2)],
    [0x2593, shade(3)],
    ...braille(w, h),
  ]
}

/**
 * All 256 Braille patterns, U+2800..28FF. Used by ./vector.js as a 2x4
 * bit-addressable framebuffer. Terminus has none of them.
 *
 * Drawn as filled rectangles tiling the cell: no gaps between adjacent lit dots.
 * A face with its own Braille keeps it, drawn as separated dots.
 */
function braille(w, h) {
  // row -> [left bit, right bit]. Matches DOT_BIT in vector.js.
  const DOT = [[0, 3], [1, 4], [2, 5], [6, 7]]
  const midX = w >> 1
  const out = []
  for (let pat = 0; pat < 256; pat++) {
    const rows = new Array(h).fill(0)
    for (let r = 0; r < 4; r++) {
      // Rows split 4 ways, remainder to the last, so the cell is fully covered.
      const y0 = Math.floor((r * h) / 4)
      const y1 = r === 3 ? h : Math.floor(((r + 1) * h) / 4)
      const left = (pat >> DOT[r][0]) & 1
      const right = (pat >> DOT[r][1]) & 1
      if (!left && !right) continue
      const bits = (left ? bitsFrom(w, 0, midX) : 0)
        | (right ? bitsFrom(w, midX, w - midX) : 0)
      for (let y = y0; y < y1; y++) rows[y] = bits
    }
    out.push([0x2800 + pat, rows])
  }
  return out
}

/** `count` lit columns from `from`, 0 = leftmost. Off-cell bits are dropped. */
function bitsFrom(w, from, count) {
  let v = 0
  for (let i = 0; i < count; i++) {
    const col = from + i
    if (col >= 0 && col < w) v |= 1 << (w - 1 - col)
  }
  return v
}

const centred = (w, ink) => bitsFrom(w, (w - ink) >> 1, ink)

/** Rows this face draws U+2500 on, for glyphs that join it. */
function ruleRows(glyphs, h) {
  const g = glyphs.get(0x2500)
  const lit = []
  if (g) for (let y = 0; y < Math.min(h, g.length); y++) if (g[y]) lit.push(y)
  // No U+2500: fall back to the middle of the cell.
  return lit.length ? lit : [Math.floor(h / 2)]
}

function vArrow(w, h, top, bot, up) {
  const rows = new Array(h).fill(0)
  const span = bot - top + 1
  const head = Math.min(Math.max(2, Math.ceil(w / 2)), Math.max(1, span - 1))
  const stem = Math.max(1, w >> 1)
  for (let i = 0; i < span; i++) {
    const y = up ? top + i : bot - i
    if (y < 0 || y >= h) continue
    // Head widens to the full cell, then the stem continues at half.
    rows[y] = i < head
      ? centred(w, Math.max(1, Math.round(w * (i + 1) / head)))
      : centred(w, stem)
  }
  return rows
}

function rArrow(w, h, rule) {
  const rows = new Array(h).fill(0)
  // Tip one column short of the edge, so consecutive cells do not fuse.
  const tip = Math.max(1, w - 2)
  for (const y of rule) rows[y] = bitsFrom(w, 0, tip + 1)
  const barb = Math.max(1, Math.round(w / 3))
  const first = rule[0], last = rule[rule.length - 1]
  for (let i = 1; i <= barb; i++) {
    if (first - i >= 0) rows[first - i] |= bitsFrom(w, tip - i, 1)
    if (last + i < h) rows[last + i] |= bitsFrom(w, tip - i, 1)
  }
  return rows
}

function ret(w, h, top, bot) {
  const rows = new Array(h).fill(0)
  const stemX = Math.max(1, w - 2)
  for (let y = top; y < bot; y++) rows[y] = bitsFrom(w, stemX, 1)
  rows[bot] = bitsFrom(w, 0, w)
  const barb = Math.max(1, Math.round(w / 3))
  for (let i = 1; i <= barb; i++) {
    if (bot - i >= 0) rows[bot - i] |= bitsFrom(w, i, 1)
    if (bot + i < h) rows[bot + i] |= bitsFrom(w, i, 1)
  }
  return rows
}

/** A glyph already in cell coordinates, padded to the cell height. */
function placeRows(rows, cellH) {
  const out = new Uint16Array(cellH)
  for (let y = 0; y < Math.min(rows.length, cellH); y++) out[y] = rows[y]
  return out
}

/** Position a glyph's bounding box inside the fixed character cell. */
function placeGlyph([w, h, xoff, yoff], rows, cellW, cellH, ascent) {
  const out = new Uint16Array(cellH)
  const mask = (1 << cellW) - 1
  // BDF pads each bitmap row to whole bytes and left-aligns the glyph, so pixel
  // 0 sits at bit (bytes*8 - 1). Shifting the padding off moves it to bit (w-1)
  // at any width. A 12px row is two bytes with the low nibble unused.
  const pad = Math.ceil(w / 8) * 8 - w
  // Then from bit (w-1) to bit (cellW-1-xoff).
  const shift = cellW - w - xoff
  const top = ascent - (yoff + h)

  for (let y = 0; y < h; y++) {
    const dy = top + y
    if (dy < 0 || dy >= cellH) continue
    const bits = (rows[y] || 0) >>> pad
    out[dy] = (shift >= 0 ? bits << shift : bits >>> -shift) & mask
  }
  return out
}
