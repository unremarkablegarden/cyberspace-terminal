// Headless check: the host moves a running shell's home and cwd by writing to
// its Proc, as main.ts does on login; prompt, pwd and cd follow.
import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { coreutils } from '../packages/coreutils/src/index.ts'
import { shellMain } from '../packages/shell/src/index.ts'

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/guest', { recursive: true })
await fs.promises.mkdir('/home/asdf22', { recursive: true })

const kernel = new Kernel()
kernel.registerAll(coreutils)
let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 80, 24)
const env = { USER: 'guest', HOME: '/home/guest', PWD: '/home/guest', PATH: '/bin', HOSTNAME: 'cs' }
const task = kernel.spawn(shellMain, { argv: ['sh'], env, cwd: '/home/guest', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty })
const p = task.proc
const tick = () => new Promise(r => setTimeout(r, 60))
const run = async (line: string) => { out = ''; tty.input(line + '\r'); await tick(); return out }

await tick()
let ok = 0, n = 0
const check = (name: string, cond: boolean) => { n++; if (cond) ok++; else console.log('FAIL', name, JSON.stringify(out)) }

check('guest pwd', (await run('pwd')).includes('/home/guest'))
Object.assign(p.env, { USER: 'asdf22', HOME: '/home/asdf22', PWD: '/home/asdf22' })
p.cwd = '/home/asdf22'
check('member pwd', (await run('pwd')).includes('/home/asdf22'))
check('prompt ~', out.includes('asdf22@cs\x1b[0m:~$'))
check('cd .. pwd', (await run('cd .. && pwd')).includes('/home\r\n') || out.includes('/home\n'))
check('cd home', (await run('cd && pwd')).includes('/home/asdf22'))
check('PWD follows', p.env.PWD === '/home/asdf22')
console.log(`${ok}/${n}`)
process.exit(ok === n ? 0 : 1)
