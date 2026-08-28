import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { edit } from '../packages/coreutils/src/edit.ts'

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })
const kernel = new Kernel()
let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 80, 24)
const task = kernel.spawn(edit, {
  argv: ['edit', 'a.txt'], env: { HOME: '/home/x' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty,
})
const tick = () => new Promise(r => setTimeout(r, 50))
await tick()
tty.input('hello'); await tick()
tty.input('\x0f'); await tick()
console.log('asks:', /Write a\.txt\?/.test(out), 'not yet written:', !/Wrote/.test(out))
tty.input('\x1b'); await tick()
console.log('esc cancels:', !/Wrote/.test(out))
tty.input('\x0f'); await tick(); tty.input('\r'); await tick()
console.log('saving shown:', /Saving\.\.\./.test(out), 'wrote notice:', /Wrote \d+ bytes/.test(out))
tty.input('!'); await tick(); tty.input('\x0f'); await tick()
console.log('second asks overwrite:', /Overwrite a\.txt\?/.test(out))
tty.input('\r'); await tick()
console.log('file:', JSON.stringify(await fs.promises.readFile('/home/x/a.txt', 'utf8')))
tty.input('\x18'); await tick()
console.log('exit', await task.exit)
