// circ's /emo picker driven headless through a real Kernel + Tty with a fake
// API: typing /emo opens it, Escape leaves the line as typed, Enter replaces the
// /emo with the kaomoji at the caret. Run: bun spikes/circ-emo.ts

import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Resume } from '../packages/kernel/src/resume.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { circProgram } from '../apps/cyberspace/src/circ.ts'
import { EMOTICONS } from '../apps/cyberspace/src/emo.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'
import type { ChatSound } from '../apps/cyberspace/src/chat.ts'

// Reveal schedules through window.setInterval; bun has no window.
;(globalThis as { window?: unknown }).window = globalThis
// circ refuses to start without one; the fake never emits.
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

const posts: string[] = []
const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async get(path: string) {
    if (path === '/v1/circ') return [{ id: 'r1', slug: 'cyberspace', name: 'Cyberspace', onlineCount: 1 }]
    if (path === '/v1/circ/r1/users') return []
    throw new Error('unexpected ' + path)
  },
  async post(path: string) { posts.push(path); return { heartbeatMs: 30000 } },
  async delete() { return null },
  async token() { return 'tok' },
} as unknown as ApiClient

const snd: ChatSound = { tick() {}, beep() {}, blip() {} }
const cols = 80, rows = 24
const xt = new Terminal({ cols, rows, allowProposedApi: true })
const tty = new Tty(d => xt.write(d), cols, rows)
new Kernel().spawn(circProgram(api, 'https://rtdb.example.com', snd), {
  argv: ['circ'], env: { HOME: '/home/x' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume(),
})
const line = (y: number) => xt.buffer.active.getLine(y)?.translateToString(true) ?? ''
const screen = () => Array.from({ length: rows }, (_, y) => line(y)).join('\n')
const inputRow = () => line(22)

await sleep(400)
tty.input('hi /emo'); await sleep(150)
ok('typing /emo opens the picker', screen().includes('EMO') && screen().includes(EMOTICONS[0]!.emoticon))
ok('no name column', !screen().includes('smile'))

tty.input('\x1b'); await sleep(150)
ok('Escape closes it', !screen().includes(EMOTICONS[1]!.emoticon))
ok('Escape leaves the line as typed', inputRow().includes('hi /emo'), JSON.stringify(inputRow()))

// Caret back past the /emo and forward again: not a typed character, no picker.
tty.input('\x1b[D\x1b[C'); await sleep(150)
ok('moving the caret does not reopen it', !screen().includes(EMOTICONS[1]!.emoticon))

// Not at a word start: a path ending in /emo is text.
tty.input('\x7f\x7f\x7f\x7f\x7f\x7f\x7fa/emo'); await sleep(150)
ok('/emo inside a word is text', !screen().includes(EMOTICONS[1]!.emoticon) && inputRow().includes('a/emo'))

// Caret mid-line: the kaomoji goes where the /emo was typed.
tty.input('\x7f\x7f\x7f\x7f\x7f' + 'a  b\x1b[D\x1b[D/emo'); await sleep(150)
tty.input('\x1b[B\x1b[B\r'); await sleep(500)
const want = `a ${EMOTICONS[2]!.emoticon} b`
ok('Enter inserts at the caret', inputRow().includes(want), JSON.stringify(inputRow()))
ok('nothing was sent', !posts.some(p => p === '/v1/circ/r1'))

console.log(fail ? `${fail} failed` : 'all ok')
process.exit(fail ? 1 : 0)
