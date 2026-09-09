// cmail(1) drawn headless through a real Kernel + Tty with a fake API, on the
// device itself and on a job view: the frame, rules and hints are on the screen
// either way. A view foregrounded after the program's first paint used to lose
// that frame, and every later frame is a diff against it.
// Run: bun spikes/cmail-drive.ts

import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Resume } from '../packages/kernel/src/resume.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { cmailProgram } from '../apps/cyberspace/src/cmail.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'

// Reveal schedules through window.setInterval; bun has no window.
;(globalThis as { window?: unknown }).window = globalThis
// cmail refuses to start without one; the fake never emits.
class FakeES {
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {}
  addEventListener(): void {}
  close(): void {}
}
;(globalThis as { EventSource?: unknown }).EventSource = FakeES

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const convs = [
  {
    conversationId: 'c1', otherUser: { userId: 'u1', username: 'alice' },
    lastMessage: 'See you at the thing tomorrow', lastMessageAt: Date.now() - 60_000, unreadCount: 2,
  },
  {
    conversationId: 'c2', otherUser: { userId: 'u2', username: 'bob' },
    lastMessage: 'ok', lastMessageAt: Date.now() - 3 * 86_400_000, unreadCount: 0,
  },
]

const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async get(path: string) {
    if (path === '/v1/cmail') return convs
    throw new Error('unexpected ' + path)
  },
  async token() { return 'tok' },
} as unknown as ApiClient

const kernel = new Kernel()

/** The mailbox as it stands on the screen after the list has loaded. */
async function mailbox(onJobView: boolean): Promise<string> {
  const xt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const root = new Tty(d => xt.write(d), 80, 24)
  const view = onJobView ? root.view() : null
  const tty = view ?? root
  if (view) root.foreground(view)
  kernel.spawn(cmailProgram(api, 'https://rtdb.example.com'), {
    argv: ['cmail'], env: { HOME: '/home/x' }, cwd: '/home/x',
    stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume(),
  })
  await sleep(600)
  const b = xt.buffer.active
  return Array.from({ length: 24 }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n')
}

for (const onJobView of [false, true]) {
  const where = onJobView ? 'job view' : 'device'
  const screen = await mailbox(onJobView)
  const rows = screen.split('\n')
  ok(`${where}: frame drawn`, rows[0].startsWith('┌') && rows[0].endsWith('┐')
    && rows[23].startsWith('└') && rows[23].endsWith('┘'))
  ok(`${where}: title and unread count`, rows[0].includes('C-MAIL') && rows[0].includes('UNREAD (1)'))
  ok(`${where}: hint in the bottom rule`, rows[23].includes('Read') && rows[23].includes('Exit'))
  ok(`${where}: split rule above the hint`, rows[22].startsWith('├') && rows[22].endsWith('┤'))
  ok(`${where}: both conversations listed`, screen.includes('@alice') && screen.includes('@bob'), '')
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
