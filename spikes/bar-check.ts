// Checks the notice bar's queue, timeout and paint against a fake grid.
// Run: bun spikes/bar-check.ts

import { NoticeBar } from '../app/src/bar'

let failed = 0
const ok = (label: string, cond: boolean, extra?: unknown): void => {
  if (!cond) failed++
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`)
}

const cols = 40
let row = ''
let inverse = 0
const grid = {
  cols,
  put(x: number, y: number, code: number, _attr: number, inv: number) {
    if (y !== 0) throw new Error('bar wrote outside row 0')
    const cells = [...row.padEnd(cols)]
    cells[x] = String.fromCodePoint(code)
    row = cells.join('')
    inverse += inv
  },
}
const paint = (now: number): string => { row = ''; inverse = 0; bar.paint(grid, now); return row }

let tones = 0
let on = true
const bar = new NoticeBar('CTRL-I', () => tones++, () => on)

ok('nothing queued paints nothing', paint(0) === '' && !bar.up)

let opened = ''
bar.show({ text: '@bob poked you', line: 'feed @bob', onOpen: () => { opened = 'bob' } })
bar.show({ text: '@carol replied to you', line: 'feed -p P R' })
ok('first item up, whole row inverse', paint(1000).startsWith(' @bob poked you') && inverse === cols && bar.up, row)
ok('chord hint on the right', row.endsWith(' CTRL-I Open '), row)
ok('one tone per item', tones === 1)
ok('still up inside six seconds', paint(6999).includes('@bob') && tones === 1)
ok('next item after six seconds', paint(7001).includes('@carol') && tones === 2, row)

const item = bar.take()
item?.onOpen?.()
ok('take returns the item on screen and lowers the bar', item?.line === 'feed -p P R' && !bar.up)
ok('nothing left', paint(7100) === '')

for (let i = 0; i < 5; i++) bar.show({ text: `n${i}`, line: 'inbox' })
ok('a burst collapses to a count', paint(8000).includes('new; inbox') && bar.take()?.line === 'inbox', row)

bar.show({ text: 'x'.repeat(100), line: 'inbox' })
ok('long text is cut before the hint', paint(20000).endsWith(' CTRL-I Open ') && [...row].length === cols, row)
bar.clear()

on = false
bar.show({ text: 'muted', line: 'inbox' })
ok('switched off shows nothing', paint(30000) === '' && opened === '')

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
