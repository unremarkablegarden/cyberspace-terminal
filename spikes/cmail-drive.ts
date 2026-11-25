// cmail(1) drawn headless through a real Kernel + Tty with a fake API, on the
// device itself and on a job view: the frame and hints are on the screen
// either way. A view foregrounded after the program's first paint used to lose
// that frame, and every later frame is a diff against it. Then a thread, fed
// through the fake stream: inline code in a message box.
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
// cmail refuses to start without one. The fake emits only what the test sends through `streams`.
const streams: FakeES[] = []
class FakeES {
  static CLOSED = 2
  readyState = 1
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  private on = new Map<string, (e: { data: string }) => void>()
  constructor(public url: string) { streams.push(this) }
  addEventListener(kind: string, fn: (e: { data: string }) => void): void { this.on.set(kind, fn) }
  emit(kind: string, data: unknown): void { this.on.get(kind)?.({ data: JSON.stringify(data) }) }
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
  async post(path: string) {
    if (path === '/v1/cmail') return { conversationId: 'c1', otherUser: { username: 'alice' } }
    return {}
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
  ok(`${where}: no rule above the hint (dropped in 0.9.8)`, !rows[22].startsWith('├'))
  ok(`${where}: both conversations listed`, screen.includes('@alice') && screen.includes('@bob'), '')
}

// A thread: `code` in a message box is drawn on the dim background, backticks removed, the box edge in place.
{
  let out = ''
  const xt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, 80, 24)
  kernel.spawn(cmailProgram(api, 'https://rtdb.example.com'), {
    argv: ['cmail', '@alice'], env: { HOME: '/home/x' }, cwd: '/home/x',
    stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume(),
  })
  await sleep(400)
  const stream = streams.find(es => es.url.includes('/dm_messages/c1.json'))
  ok('thread stream opened', !!stream)
  stream?.emit('put', { path: '/', data: { m1: { content: 'run `ls -la` now', username: 'alice', senderId: 'u1', timestamp: Date.now() - 60_000 } } })
  await sleep(1500)
  const rows = Array.from({ length: 24 }, (_, y) => xt.buffer.active.getLine(y)?.translateToString(true) ?? '')
  const row = rows.find(r => r.includes('run ls -la now'))
  ok('backticks removed in the box', !!row && !rows.some(r => r.includes('`')), rows.join('\n'))
  ok('box edge kept on the row', !!row && /│ run ls -la now +│/.test(row), row)
  ok('the run on the dim background', /48;5;\d+m[^\x1b]*ls -la/.test(out))
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
