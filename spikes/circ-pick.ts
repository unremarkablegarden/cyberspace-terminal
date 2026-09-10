// circ's online pane driven headless through a real Kernel + Tty with a fake
// API: ^U takes the pane, the arrows move the bar, Enter opens the member's
// card and C asks for C-Mail. Run: bun spikes/circ-pick.ts

import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Resume } from '../packages/kernel/src/resume.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { circProgram } from '../apps/cyberspace/src/circ.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'
import type { ChatPictures, ChatSound } from '../apps/cyberspace/src/chat.ts'
import { PFP_COLS } from '../apps/cyberspace/src/bio.ts'

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

const now = Date.now()
const everyone = [
  { username: 'alice', isChatAdmin: false, lastActivity: now },
  { username: 'bob', isChatAdmin: true, lastActivity: now },
  { username: 'carol', isChatAdmin: false, lastActivity: now - 30 * 60_000 },
]
let roster = everyone
const profiles: Record<string, Record<string, unknown>> = {
  alice: {
    userId: 'u-alice', username: 'alice', displayName: 'Alice',
    bio: 'Runs the night shift.', createdAt: '2021-03-04T00:00:00.000Z',
    isSupporter: true, profilePictureUrl: 'https://pics.example.com/alice.png',
    websiteUrl: 'https://alice.example.com',
  },
  // A picture the bank cannot read: the card must not hold a blank column for it.
  carol: {
    userId: 'u-carol', username: 'carol', bio: 'Keeps the lamps lit.',
    createdAt: '2022-01-09T00:00:00.000Z',
    isSupporter: true, profilePictureUrl: 'https://pics.example.com/carol.png',
  },
}

const calls: string[] = []
const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async get(path: string) {
    calls.push('GET ' + path)
    if (path === '/v1/circ') return [{ id: 'r1', slug: 'cyberspace', name: 'Cyberspace', onlineCount: 3 }]
    if (path === '/v1/circ/r1/users') return roster
    const who = path.match(/^\/v1\/users\/([a-z]+)$/)?.[1]
    if (who && profiles[who]) return profiles[who]
    if (path === '/v1/users/alice/guilds') return [{ name: 'Wire', role: 'member' }]
    if (path.endsWith('/guilds')) return []
    if (path.startsWith('/v1/users/')) { const e = new Error('not found') as Error & { status: number }; e.status = 404; throw e }
    throw new Error('unexpected ' + path)
  },
  // Short enough that a roster change lands inside the run.
  async post(path: string) { calls.push('POST ' + path); return { heartbeatMs: 400 } },
  async delete(path: string) { calls.push('DELETE ' + path); return null },
  async token() { return 'tok' },
} as unknown as ApiClient

// Enough of a bank for the portrait: circ asks for slots on every paint.
const pictures = (): ChatPictures => ({
  slot: (_c: number, r: number) => Math.min(r, 6),
  picture: () => undefined,
  failed: () => false,
  ensure: () => {},
  onLoad: () => () => {},
  load: async (src: string) => {
    if (src.includes('carol')) throw new Error('no room')
    return { lines: Array.from({ length: 6 }, () => '█'.repeat(20)) }
  },
  release: () => {},
} as unknown as ChatPictures)

let beeps = 0
const snd: ChatSound = { tick() {}, beep() { beeps++ }, blip() {} }

const kernel = new Kernel()

function boot(cols: number, rows: number) {
  let out = ''
  const xt = new Terminal({ cols, rows, allowProposedApi: true })
  const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, cols, rows)
  kernel.spawn(circProgram(api, 'https://rtdb.example.com', snd, pictures), {
    argv: ['circ'], env: { HOME: '/home/x' }, cwd: '/home/x',
    stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume(),
  })
  const line = (y: number) => xt.buffer.active.getLine(y)?.translateToString(true) ?? ''
  const screen = () => Array.from({ length: rows }, (_, y) => line(y)).join('\n')
  /** The pane row a name is drawn on, and whether its first cell is inverted. */
  const paneRow = (name: string) => {
    for (let y = 0; y < rows; y++) {
      const text = line(y)
      const at = text.indexOf(name, 60)
      if (at < 0) continue
      return { y, inverse: Boolean(xt.buffer.active.getLine(y)?.getCell(at)?.isInverse()) }
    }
    return null
  }
  return { tty, out: () => out, screen, line, paneRow, reset: () => { out = '' } }
}

// --- the pane, 80x24 ---------------------------------------------------------
{
  const m = boot(80, 24)
  await sleep(500)
  ok('roster in the pane', ['alice', '@bob', 'carol'].every(n => m.screen().includes(n)))
  ok('legend advertises the pane', m.line(23).includes('User') && m.line(23).includes('Scroll'))
  ok('caret shown while typing', m.out().lastIndexOf('\x1b[?25h') > m.out().lastIndexOf('\x1b[?25l'))

  m.reset(); m.tty.input('\x15'); await sleep(120)
  // The roster sorts operators first, so @bob heads the pane.
  ok('^U selects the first name', m.paneRow('@bob')?.inverse === true, JSON.stringify(m.paneRow('@bob')))
  ok('legend swaps to the pane keys',
    ['Pick', 'Bio', 'Mail', 'Back'].every(w => m.line(23).includes(w)), JSON.stringify(m.line(23)))
  ok('caret hidden while picking', m.out().includes('\x1b[?25l'))

  m.tty.input('\x1b[B'); await sleep(120)
  ok('ArrowDown moves the bar', m.paneRow('alice')?.inverse === true && m.paneRow('@bob')?.inverse === false)

  beeps = 0
  m.tty.input('\x1b[A\x1b[A'); await sleep(120)
  ok('ArrowUp refuses at the top', m.paneRow('@bob')?.inverse === true && beeps === 1, `beeps ${beeps}`)

  m.tty.input('\x1b'); await sleep(120)
  ok('Escape leaves the mode', m.paneRow('@bob')?.inverse === false && m.line(23).includes('Scroll'),
    JSON.stringify(m.line(23)))

  // The line takes keys again, and c is a character rather than C-Mail.
  m.tty.input('cx'); await sleep(120)
  ok('typing resumes', m.line(22).includes('cx'), JSON.stringify(m.line(22)))
  m.tty.input('\x7f\x7f'); await sleep(120)

  m.reset(); m.tty.input('\x15\x1b[B\r'); await sleep(400)
  const card = m.screen()
  ok('Enter opens the card', card.includes('@alice') && card.includes('Runs the night shift.'))
  ok('card has the picture column', card.includes('█'.repeat(20)))
  {
    const row = card.split('\n').find(r => r.includes('Runs the night shift.')) ?? ''
    const at = row.indexOf('Runs the night shift.')
    ok('the words sit beside it', at - row.lastIndexOf('│', at) > PFP_COLS, JSON.stringify(row))
  }
  ok('facts under the rule', card.includes('Joined') && card.includes('Wire'))
  ok('card hint offers the site', card.includes('L Link'))
  ok('the footer under the card keeps the pane keys',
    m.line(23).includes('Mail') && m.line(23).includes('Back'), JSON.stringify(m.line(23)))
  ok('profile fetched once', calls.filter(c => c === 'GET /v1/users/alice').length === 1)

  m.tty.input('\x1b'); await sleep(200)
  ok('Escape closes the card', !m.screen().includes('Runs the night shift.'))

  // A picture that cannot be read leaves no column: the words start at the edge.
  m.tty.input('\x1b[B\r'); await sleep(400)
  const bare = m.screen().split('\n').find(r => r.includes('Keeps the lamps lit.')) ?? ''
  const at = bare.indexOf('Keeps the lamps lit.')
  const edge = bare.lastIndexOf('│', at)
  // Box edge, two columns of padding, then the words.
  ok('an unreadable picture holds no column', at >= 0 && at - edge === 3, JSON.stringify(bare))
  ok('the status rule is clear under a card', !m.line(21).includes('LOADING'), JSON.stringify(m.line(21)))
  m.tty.input('\x1b'); await sleep(200)
  m.tty.input('\x1b[A'); await sleep(120)
  ok('the pane keeps the selection behind the card', m.paneRow('alice')?.inverse === true)

  m.tty.input('c'); await sleep(200)
  ok('C without job control reports it', m.screen().includes('cmail: no job control'),
    JSON.stringify(m.line(21)))

  roster = roster.filter(u => u.username !== 'alice')
  await sleep(700)
  ok('a member leaving hands the row on', m.paneRow('carol')?.inverse === true)

  roster = []
  await sleep(700)
  ok('an empty pane ends the mode', m.line(23).includes('Scroll'), JSON.stringify(m.line(23)))
}

// --- narrow, 44x20 -----------------------------------------------------------
{
  roster = everyone
  const m = boot(44, 20)
  await sleep(500)
  ok('narrow: no pane', !m.screen().includes('carol'))

  m.tty.input('\x15'); await sleep(150)
  ok('narrow: ^U opens the picker', m.screen().includes('ONLINE (3)') && m.screen().includes('alice'))

  m.tty.input('c'); await sleep(200)
  ok('narrow: C from the picker asks for cmail', m.screen().includes('cmail: no job control'))

  m.tty.input('\x15\x1b[B\r'); await sleep(700)
  ok('narrow: Enter opens the card', m.screen().includes('Runs the night shift.'))
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
