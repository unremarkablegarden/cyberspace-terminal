import { configure, fs, InMemory } from '@zenfs/core'
import { TextBuffer } from '../packages/tui/src/buffer.ts'
import { parseKeys } from '../packages/tui/src/keys.ts'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { edit } from '../packages/coreutils/src/edit.ts'

const UNDO = '\x1b[122;6u'
const REDO = '\x1b[121;6u'

// Buffer level: grouping and caret restore.
const buf = new TextBuffer()
const type = (s: string) => { for (const k of parseKeys(s)) buf.key(k) }
type('hello world')
type(UNDO)
console.log('word undone:', JSON.stringify(buf.text), buf.caret)
type(UNDO)
console.log('space undone:', JSON.stringify(buf.text))
type(REDO + REDO)
console.log('redo both:', JSON.stringify(buf.text), buf.caret)
type('\x7f\x7f\x7f')
console.log('after 3 backspaces:', JSON.stringify(buf.text))
type(UNDO)
console.log('backspaces one step:', JSON.stringify(buf.text))
type('\x19')
console.log('^Y redo:', JSON.stringify(buf.text))
type('!')
type(REDO)
console.log('edit clears redo:', JSON.stringify(buf.text))
buf.key({ key: 'Home', ctrlKey: false, shiftKey: false, metaKey: false, altKey: false })
type('\x0b')
console.log('^K:', JSON.stringify(buf.text))
type(UNDO)
console.log('^K undone:', JSON.stringify(buf.text), buf.caret)
let rejects = 0
const empty = new TextBuffer({ onReject: () => rejects++ })
for (const k of parseKeys(UNDO)) empty.key(k)
console.log('empty history rejects:', rejects === 1)

// Program level: edit takes the keys, MODIFIED clears when undone to saved.
await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })
await fs.promises.writeFile('/home/x/a.txt', 'abc')
const kernel = new Kernel()
let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 80, 24)
const task = kernel.spawn(edit, {
  argv: ['edit', 'a.txt'], env: { HOME: '/home/x' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty,
})
const tick = () => new Promise(r => setTimeout(r, 50))
await tick()
tty.input('xyz'); await tick()
console.log('modified:', out.includes('MODIFIED'))
out = ''
tty.input(UNDO); await tick()
console.log('undo to saved clears MODIFIED:', !out.includes('MODIFIED'))
tty.input('\x18'); await tick()
console.log('exit without asking:', await task.exit)
