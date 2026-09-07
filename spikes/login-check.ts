import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { coreutils } from '../packages/coreutils/src/index.ts'
import { shellMain } from '../packages/shell/src/index.ts'
import { cyberspacePrograms } from '../apps/cyberspace/src/programs.ts'
import { Surface } from '../packages/tui/src/surface.ts'
import { FormPopup } from '../packages/tui/src/form.ts'

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })
const kernel = new Kernel()
kernel.registerAll(coreutils)
const api: any = { username: null, hasSavedSession: false, login: async (e: string, pw: string) => {
  if (pw !== 'pw') throw Object.assign(new Error('401'), { status: 401 })
  api.username = 'asdf22'; return 'asdf22'
} }
kernel.registerAll(cyberspacePrograms(api))
let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 80, 24)
kernel.spawn(shellMain, { argv: ['sh'], env: { HOME: '/home/x', USER: 'guest' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty })
const tick = () => new Promise(r => setTimeout(r, 60))
await tick()
tty.input('login\r'); await tick()
console.log('alt up:', tty.alt, /\x1b\[\?1049h/.test(out))
out = ''
tty.input('\x03'); await tick()
console.log('^C leaves alt once:', (out.match(/1049l/g) ?? []).length === 1, 'alt down:', !tty.alt, 'prompt back:', /\$ $/.test(out))
out = ''
tty.input('\x03'); await tick()
console.log('^C at prompt sends no 1049l:', !/1049l/.test(out), 'no cursor home:', !/\x1b\[H/.test(out))

// The box itself, rendered on a Surface.
const rows = (s: Surface) => Array.from({ length: s.rows }, (_, y) => s.chars.slice(y * s.cols, (y + 1) * s.cols).join(''))
const s = new Surface(80, 24)
let done: string | null | undefined
const popup = new FormPopup({ title: 'LOGIN', fields: [{ label: 'login:', value: 'a@b.c' }, { label: 'Password:', mask: '*' }], onSubmit: async ([, pw]) => pw === 'pw' ? null : { message: 'Login incorrect', clear: [1] }, onDone: v => { done = v?.[0] ?? null } })
popup.draw(s)
const key = (k: string, ctrl = false) => popup.onKey({ key: k, ctrlKey: ctrl, shiftKey: false, metaKey: false, altKey: false })
for (const ch of 'xx') key(ch)
popup.draw(s)
console.log(rows(s).filter(r => r.trim()).join('\n'))
key('Enter'); await tick(); popup.draw(s)
console.log('--- after wrong password')
console.log(rows(s).filter(r => r.trim()).join('\n'))
for (const ch of 'pw') key(ch)
key('Enter'); await tick()
console.log('done:', done)
process.exit(0)
