import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { coreutils } from '../packages/coreutils/src/index.ts'
import { shellMain } from '../packages/shell/src/index.ts'
await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x/bin', { recursive: true })
for (const f of ['README.txt', 'Readme2.txt', 'notes']) await fs.promises.writeFile('/home/x/' + f, 'x')
const kernel = new Kernel(); kernel.registerAll(coreutils)
let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 80, 24)
kernel.spawn(shellMain, { argv: ['sh'], env: { HOME: '/home/x', USER: 'guest' }, cwd: '/home/x', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty })
const tick = () => new Promise(r => setTimeout(r, 60))
await tick()
const line = () => out.split('\n').pop()!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
tty.input('cat r\t'); await tick(); console.log('common:', JSON.stringify(line()))
tty.input('\t'); await tick(); console.log('list:', /README\.txt\s+Readme2\.txt/.test(out))
tty.input('\x15cat n\t'); await tick(); console.log('single:', JSON.stringify(line()))
tty.input('\x15cat readme.\t'); await tick(); console.log('mixed:', JSON.stringify(line()))
process.exit(0)
