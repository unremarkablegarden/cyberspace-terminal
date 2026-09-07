import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { edit } from '../packages/coreutils/src/edit.ts'

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })
await fs.promises.writeFile('/home/x/old.txt', 'old')
const kernel = new Kernel()
let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 80, 24)
const run = () => kernel.spawn(edit, { argv: ['edit'], env: { HOME: '/home/x' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty })
const tick = () => new Promise(r => setTimeout(r, 50))

// ^O on an untitled buffer asks for a name, writes a new file.
let task = run(); await tick()
console.log('new buffer:', /New Buffer/.test(out))
tty.input('hello'); await tick()
tty.input('\x0f'); await tick()
console.log('asks name:', /File name:/.test(out))
tty.input('new.txt\r'); await tick()
console.log('wrote:', /Wrote 5 bytes to new\.txt/.test(out), JSON.stringify(await fs.promises.readFile('/home/x/new.txt', 'utf8')))
tty.input('\x18'); await tick()
console.log('exit', await task.exit)

// A name that exists gets the overwrite question.
out = ''; task = run(); await tick()
tty.input('x'); await tick(); tty.input('\x0f'); await tick(); tty.input('old.txt\r'); await tick()
console.log('asks overwrite:', /Overwrite old\.txt\?/.test(out))
tty.input('\x1b'); await tick()
console.log('kept:', JSON.stringify(await fs.promises.readFile('/home/x/old.txt', 'utf8')))
tty.input('\x18'); await tick(); tty.input('n'); await tick()
console.log('exit', await task.exit)

// ^X Y on an untitled buffer: name, write, exit.
out = ''; task = run(); await tick()
tty.input('bye'); await tick(); tty.input('\x18'); await tick(); tty.input('y'); await tick()
console.log('asks name on exit:', /File name:/.test(out))
tty.input('bye.txt\r'); await tick()
console.log('exit', await task.exit, JSON.stringify(await fs.promises.readFile('/home/x/bye.txt', 'utf8')))
process.exit(0)
