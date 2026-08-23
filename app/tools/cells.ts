// Does a row of the Surface occupy the same columns on the parser's side?
//
// It has to, and nothing else checks. A Surface allots one cell per code point;
// @xterm/headless allots one per grapheme and two to CJK, so a message carrying
// `❤️` or `中` puts the rest of its row in the wrong columns on the glass, and
// the frame loses whatever it keeps at the right margin. The diff cannot repair
// it — the diff compares against the Surface, and the Surface is the thing that
// is wrong.
//
//   cd app && bun tools/cells.ts
//
// It lives here because this is where the two meet: `app` is what pairs the
// Surface with the parser.

import { Terminal } from '@xterm/headless'
import { Surface, frame, vline, hline, drawLog, plain } from '@cyberspace/tui'

const COLS = 80
const ROWS = 24
const SPLIT_X = COLS - 16
const SPLIT_Y = ROWS - 3

/** Everything that has ever been a reason for a torn row. */
const HOSTILE = [
  'love it ❤️ really',
  'family 👨‍👩‍👧 photo',
  'flag 🇸🇪 and tone 👍🏽',
  '中文 in the middle',
  'café decomposed',
  'table flip ︵ and ︻ gun',
  'plain ascii, the control',
]

function draw(lines: string[], fold: boolean): Surface {
  const s = new Surface(COLS, ROWS)
  s.clear()
  frame(s, { x: 0, y: 0, w: COLS, h: ROWS })
  vline(s, SPLIT_X, 0, SPLIT_Y)
  hline(s, SPLIT_Y, 0, COLS - 1)
  drawLog(
    s,
    { x: 2, y: 1, w: SPLIT_X - 3, h: SPLIT_Y - 1 },
    lines.map(text => ({ text: fold ? plain(text) : text })),
  )
  return s
}

async function feed(ansi: string): Promise<Terminal> {
  const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  await new Promise<void>(done => t.write(ansi, done))
  return t
}

/**
 * Cells the parser does not agree with the Surface about.
 *
 * The whole row, not just the two frame columns. A cluster that folds shifts
 * the row LEFT, which leaves the border cell holding the value the first paint
 * put there — intact on the frame it arrived in, and gone the moment anything
 * else on that row changes. Comparing the row catches it when it happens rather
 * than a repaint later.
 */
async function holes(s: Surface): Promise<string[]> {
  const t = await feed(s.render())
  const buf = t.buffer.active
  const cell = buf.getNullCell()
  const bad: string[] = []
  for (let y = 1; y < SPLIT_Y; y++) {
    const line = buf.getLine(buf.baseY + y)
    for (let x = 0; x < COLS; x++) {
      line?.getCell(x, cell)
      const got = cell.getWidth() === 0 ? '' : (cell.getChars() || ' ')
      const want = s.chars[y * COLS + x]
      if (got !== want) {
        const frameCol = x === SPLIT_X || x === COLS - 1
        bad.push(`row ${y} col ${x}${frameCol ? ' (frame)' : ''}:`
          + ` want ${JSON.stringify(want)} got ${JSON.stringify(got)}`)
      }
    }
  }
  return bad
}

const raw = await holes(draw(HOSTILE, false))
const folded = await holes(draw(HOSTILE, true))

const frameOnly = (list: string[]) => list.filter(b => b.includes('(frame)'))

console.log(`unfolded: ${raw.length} cells adrift, ${frameOnly(raw).length} of them frame`)
for (const b of frameOnly(raw).slice(0, 6)) console.log('  ' + b)
console.log(`plain():  ${folded.length} cells adrift, ${frameOnly(folded).length} of them frame`)
for (const b of folded.slice(0, 8)) console.log('  ' + b)

if (!raw.length) console.log('\nNOTE: the unfolded case did not tear — the check proves nothing.')
if (folded.length) {
  console.log('\nFAIL')
  process.exit(1)
}
console.log('\nOK')
