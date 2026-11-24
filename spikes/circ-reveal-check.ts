// circ's opening reveal, headless with a fake API and stream: the log must
// never be drawn whole and then hidden for the reveal, on a fresh start or on
// a stopped run resumed into another room. Run: bun spikes/circ-reveal-check.ts

import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Resume } from '../packages/kernel/src/resume.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { circProgram } from '../apps/cyberspace/src/circ.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'
import type { ChatPictures, ChatSound } from '../apps/cyberspace/src/chat.ts'

// Reveal schedules through window.setInterval; bun has no window.
;(globalThis as { window?: unknown }).window = globalThis
const now = Date.now()
const data: Record<string, unknown> = {}
for (let i = 0; i < 30; i++) data['m' + i] = { username: 'alice', content: 'line ' + i, message: 'line ' + i, text: 'line ' + i, timestamp: now - (30 - i) * 60_000 }
// Sends the room's snapshot 300 ms after connecting, as RTDB's first `put`.
class FakeES {
  fns: Record<string, (e: { data: string }) => void> = {}
  onerror: (() => void) | null = null
  constructor(public url: string) {
    setTimeout(() => this.fns.put?.({ data: JSON.stringify({ path: '/', data }) }), 300)
  }
  addEventListener(n: string, f: (e: { data: string }) => void): void { this.fns[n] = f }
  close(): void {}
}
;(globalThis as { EventSource?: unknown }).EventSource = FakeES
await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })
const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async get(path: string) {
    if (path === '/v1/circ') return [{ id: 'r1', slug: 'cyberspace', name: 'Cyberspace', onlineCount: 3 }, { id: 'r2', slug: 'other', name: 'Other', onlineCount: 1 }]
    if (/^\/v1\/circ\/r\d\/users$/.test(path)) return []
    if (path === '/v1/settings') return {}
    throw new Error('unexpected ' + path)
  },
  // Slow enough that a frame painted during the presence request is caught.
  async post() { await new Promise(r => setTimeout(r, 200)); return { heartbeatMs: 30000 } },
  async delete() { return null },
  async token() { return 'tok' },
} as unknown as ApiClient
const snd: ChatSound = { tick() {}, beep() {}, blip() {} }
const xt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
const frames: number[] = []
const tty = new Tty(d => xt.write(d, () => { const n = visible(); if (frames[frames.length - 1] !== n) frames.push(n) }), 80, 24)
const task = new Kernel().spawn(circProgram(api, 'https://rtdb.example.com', snd), {
  argv: ['circ', 'cyberspace'], env: { HOME: '/home/x' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume(),
})
const visible = () => Array.from({ length: 24 }, (_, y) => xt.buffer.active.getLine(y)?.translateToString(true) ?? '')
  .filter(l => /line \d+/.test(l)).length
let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
/** Visible line counts, one per frame that changed it, over 1.5 s. */
const watch = async (): Promise<number[]> => {
  frames.length = 0
  await new Promise(r => setTimeout(r, 1500))
  return [...frames]
}
/** Counts that only rise: no full log shown and then hidden for the reveal. */
const rising = (f: number[]) => f.every((n, i) => i === 0 || n >= f[i - 1]!)

const fresh = await watch()
ok('fresh start reveals from empty', fresh[0] === 0 && rising(fresh) && fresh.at(-1) === 20, fresh.join(' '))

// Resumed into another room, as the shell does for `circ other` from inbox.
await task.stop()
task.proc.onArgs?.(['circ', 'other'])
task.cont()
const other = await watch()
ok('resume into another room hides the old log', other[0] === 0 && rising(other) && other.at(-1) === 20, other.join(' '))

// Resumed into the same room: the log stays, with no second reveal.
await task.stop()
task.proc.onArgs?.(['circ', 'other'])
task.cont()
const same = await watch()
ok('resume into the same room keeps the log', same.join(' ') === '20', same.join(' '))

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
