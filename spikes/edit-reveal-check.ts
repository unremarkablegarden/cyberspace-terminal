// edit(1) opening reveal, driven headless through a real Kernel + Tty: the
// text appears a line at a time, a key finishes it, the caret is hidden until
// then.

import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { edit } from '../packages/coreutils/src/edit.ts'

// Reveal schedules through window.setInterval; bun has no window.
;(globalThis as { window?: unknown }).window = globalThis

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })
const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
await fs.promises.writeFile('/home/x/f.txt', lines.join('\n'))

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const kernel = new Kernel()
let out = ''
const xt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, 80, 24)
const task = kernel.spawn(edit, {
  argv: ['edit', 'f.txt'], env: { HOME: '/home/x' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty,
})
const shown = () => {
  const b = xt.buffer.active
  let n = 0
  for (let y = 0; y < 24; y++) if (/line \d+/.test(b.getLine(y)?.translateToString(true) ?? '')) n++
  return n
}

await sleep(250)
const early = shown()
ok('partly revealed after 250ms', early > 0 && early < 22, String(early))
ok('caret hidden while revealing', out.includes('\x1b[?25l') && !out.includes('\x1b[?25h'))
await sleep(500)
ok('all 22 rows revealed after 750ms', shown() === 22, String(shown()))
ok('caret shown after the reveal', out.includes('\x1b[?25h'))
const blips = out.split('\x1b]777;blip\x1b\\').length - 1
ok('blips sent, one per batch', blips >= 2 && blips <= 22, String(blips))

tty.input('\x18')
await sleep(100)
await task.wait
ok('exits clean', true)
console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
