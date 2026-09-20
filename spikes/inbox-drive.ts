// inbox(1) driven headless through a real Kernel + Tty and job table with a fake
// API: the list, tabs, unread filter, Enter hands off and marks read, rows with
// no target open a box, read-all, a parked state restores, q exits.
// Run: bun spikes/inbox-drive.ts

import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Resume } from '../packages/kernel/src/resume.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { inboxProgram } from '../apps/cyberspace/src/inboxui.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'
import type { Notice } from '../apps/cyberspace/src/inbox.ts'

;(globalThis as { window?: unknown }).window = globalThis

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const at = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()
const notes: Notice[] = [
  { id: 'n1', type: 'reply', actorUsername: 'bob', targetId: 'P1', targetType: 'post', read: false, createdAt: at(1), metadata: { replyId: 'R1' } },
  { id: 'n2', type: 'poke', actorUsername: 'carol', read: false, createdAt: at(2) },
  { id: 'n3', type: 'chat_mention', actorUsername: 'dave', targetId: 'lobby', read: true, createdAt: at(3), metadata: { messageContent: 'hey @tester' } },
  { id: 'n4', type: 'system_ban_lifted', actorUsername: 'system', read: false, createdAt: at(4) },
  { id: 'n5', type: 'bookmark', actorUsername: 'erin', targetId: 'R9', targetType: 'reply', read: false, createdAt: at(5) },
]

const calls: string[] = []
const api = {
  authed: true, username: 'tester', userId: null,
  async token() { return null },
  async get(path: string) {
    calls.push('GET ' + path)
    if (path === '/v1/cmail') {
      return [
        { conversationId: 'c1', otherUser: { username: 'frank' }, lastMessage: 'hello there', lastMessageAt: Date.now() - 30_000, unreadCount: 2 },
        { conversationId: 'c2', otherUser: { username: 'gina' }, lastMessage: 'old', lastMessageAt: Date.now() - 9e6, unreadCount: 0 },
      ]
    }
    if (path === '/v1/posts/P7') return { postId: 'P7', title: 'On modems', content: 'They **sing**.\n\n![pic](https://x.test/a.png)\n\n> Loudly.\n\n- one\n- two' }
    if (path === '/v1/replies/R9') return { postId: 'P9', content: 'a saved reply' }
    if (path === '/v1/replies/R1') return { postId: 'P1', content: 'I  agree\nwith this' }
    throw new Error('unexpected ' + path)
  },
  async page(path: string) {
    calls.push('GET ' + path)
    const q = new URL('http://x' + path).searchParams
    const types = q.get('type')?.split(',')
    // Every page empty with a cursor behind it: rows the server filtered out.
    if (types?.includes('guild_new_thread')) return { rows: [], cursor: 'c' + calls.length }
    let rows = notes.filter(n => !types || types.includes(n.type))
    if (q.get('read') === 'false') rows = rows.filter(n => !n.read)
    return { rows: rows.map(n => ({ ...n })), cursor: null }
  },
  async patch(path: string) { calls.push('PATCH ' + path); return {} },
  async post(path: string) {
    calls.push('POST ' + path)
    notes.forEach(n => { n.read = true })
    return { updated: 4, hasMore: false }
  },
} as unknown as ApiClient

const watchers = new Set<() => void>()
const counts = {
  count: 4, mail: 2,
  seen(n = 1) { this.count = Math.max(0, this.count - n); watchers.forEach(f => f()) },
  async poll() {},
  watch(fn: () => void) { watchers.add(fn); return () => { watchers.delete(fn) } },
}
const inbox = inboxProgram(api, undefined, () => counts)

const kernel = new Kernel()
let resume = new Resume()

function boot(parked?: unknown) {
  let out = ''
  const xt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, 80, 24)
  kernel.jobs.device(tty)
  const job = kernel.jobs.create('inbox')
  resume = job.resume
  if (parked) resume.restore('inbox', parked)
  // As the shell does: the terminal goes to the job before its process starts,
  // or the first full paint is written to a job that does not hold it.
  kernel.jobs.start(job)
  const task = kernel.spawn(inbox, {
    argv: ['inbox'], env: { HOME: '/home/x' }, cwd: '/home/x',
    stdin: job.tty.stdin, stdout: job.tty.stdout, stderr: job.tty.stdout, tty: job.tty, resume,
  })
  kernel.jobs.attach(job, [task])
  kernel.jobs.foreground(job)
  const screen = () => {
    const b = xt.buffer.active
    return Array.from({ length: 24 }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  return { tty, task, job, out: () => out, screen }
}
const state = () => resume.state as { v: number; tab: number; sel: number; unread: boolean } | undefined
const take = (): string => JSON.stringify(kernel.jobs.take())

{
  const m = boot()
  await sleep(800)
  const job = m.job
  ok('alt screen entered', m.out().includes('\x1b[?1049h'))
  ok('resume line', resume.line === 'inbox')
  ok('notifications listed', m.screen().includes('@bob replied to you') && m.screen().includes('Ban lifted.'))
  ok('unread mail sorted in on top', m.screen().indexOf('@frank sent you C-Mail (2): hello there') > 0 &&
    m.screen().indexOf('@frank') < m.screen().indexOf('@bob'))
  ok('read conversations left out', !m.screen().includes('@gina'))
  ok('title carries the unread total', m.screen().includes('INBOX (6)') && m.screen().includes('C-MAIL (2)'))
  ok('a reply is not fetched for the list', !calls.includes('GET /v1/replies/R1') && !m.screen().includes('I agree'))
  ok('a mention shows the text it carries', m.screen().includes('@dave mentioned you in #lobby: hey @tester'))
  ok('tabs drawn', m.screen().includes('REPLIES') && m.screen().includes('OTHER'))

  m.tty.input('\x1b[B'); await sleep(100)
  m.tty.input('p'); await sleep(400)
  ok('P opens the reply in a box, fetched once', m.screen().includes('I agree with this') && m.screen().includes('REPLY') &&
    calls.filter(c => c === 'GET /v1/replies/R1').length === 1)
  ok('P marks nothing read', !calls.some(c => c.startsWith('PATCH')))
  m.tty.input('\x1b'); await sleep(200)
  m.tty.input('\x1b[A'); await sleep(100)

  m.tty.input('\r'); await sleep(200)
  ok('Enter on mail hands off to cmail', take() === JSON.stringify({ launch: 'cmail @frank' }))
  ok('mail row is not patched', !calls.some(c => c.startsWith('PATCH')))
  ok('inbox stopped by the switch', job.state === 'stopped')
  kernel.jobs.foreground(job); await sleep(600)

  m.tty.input('\x1b[B'); await sleep(100)
  ok('cursor parked', state()?.sel === 1, JSON.stringify(state()))
  m.tty.input('\r'); await sleep(200)
  ok('Enter on a reply hands off to feed', take() === JSON.stringify({ launch: 'feed -p P1 R1' }))
  ok('the reply is marked read', calls.includes('PATCH /v1/notifications/n1') && counts.count === 3)
  notes[0]!.read = true
  kernel.jobs.foreground(job); await sleep(600)

  // Rows now: frank, bob, carol, dave, system, erin.
  m.tty.input('\x1b[B\x1b[B\x1b[B'); await sleep(100)
  m.tty.input('\r'); await sleep(300)
  ok('a row with no target opens a box', m.screen().includes('SYSTEM BAN LIFTED'))
  ok('and is marked read', calls.includes('PATCH /v1/notifications/n4'))
  ok('nothing queued for the shell', take() === 'undefined' || take() === 'null', take())
  m.tty.input('\x1b'); await sleep(200)
  ok('Escape closes the box', !m.screen().includes('SYSTEM BAN LIFTED'))

  m.tty.input('\x1b[B'); await sleep(100)
  m.tty.input('\r'); await sleep(300)
  ok('a reply bookmark resolves its post', calls.includes('GET /v1/replies/R9') && take() === JSON.stringify({ launch: 'feed -p P9 R9' }))
  kernel.jobs.foreground(job); await sleep(600)

  // A notification arrives while the list is open, with the cursor on erin's row.
  notes.unshift({ id: 'n0', type: 'poke', actorUsername: 'hal', read: false, createdAt: at(0) })
  counts.count++
  watchers.forEach(f => f())
  await sleep(600)
  ok('a new notification appears without a key', m.screen().includes('@hal poked you') && m.screen().includes('INBOX ('))
  m.tty.input('\r'); await sleep(300)
  ok('the selection stayed on its row', take() === JSON.stringify({ launch: 'feed -p P9 R9' }), take())
  kernel.jobs.foreground(job); await sleep(600)

  // A published entry: the row carries no text, P fetches the entry.
  notes.push({ id: 'n6', type: 'new_post_following', actorUsername: 'ivy', targetId: 'P7', targetType: 'post', read: true, createdAt: at(9) })
  m.tty.input('5'); await sleep(500)
  m.tty.input('p'); await sleep(400)
  ok('P on a published entry shows its title and text', calls.includes('GET /v1/posts/P7') &&
    m.screen().includes('On modems') && m.screen().includes('NEW ENTRY'))
  ok('markdown drawn as feed draws it, images left out', m.screen().includes('▌ Loudly.') && m.screen().includes('• one') &&
    !m.screen().includes('**') && !m.screen().includes('a.png') && !m.screen().includes('[IM'))
  m.tty.input('\x1b'); await sleep(200)
  m.tty.input('1'); await sleep(300)

  m.tty.input('\x1b[C'); await sleep(500)
  ok('Right moves to REPLIES', state()?.tab === 1 && calls.some(c => c.includes('type=reply,thread_reply')))
  ok('only replies listed', m.screen().includes('@bob replied') && !m.screen().includes('@carol') && !m.screen().includes('@frank'))

  {
    const n = calls.length
    m.tty.input('\x1b[D'); await sleep(200)
    ok('back to a tab already fetched costs no request', calls.length === n && m.screen().includes('@carol poked you'), calls.slice(n).join())
    m.tty.input('\x1b[C'); await sleep(200)
    ok('and forward again', calls.length === n && !m.screen().includes('@carol'))
  }

  m.tty.input('4'); await sleep(500)
  ok('4 is C-MAIL, with no notification request', state()?.tab === 3 && m.screen().includes('@frank') && !m.screen().includes('@bob'))

  const before = calls.length
  m.tty.input('7'); await sleep(900)
  const asked = calls.slice(before).filter(c => c.includes('guild_new_thread')).length
  ok('empty pages stop after a bounded fill', asked === 4 && !m.screen().includes('LOADING') && m.screen().includes('MORE'), `asked=${asked}`)
  m.tty.input('\x1b[B'); await sleep(400)
  ok('Down asks for one more page', calls.slice(before).filter(c => c.includes('guild_new_thread')).length === 5)

  m.tty.input('1'); await sleep(400)
  m.tty.input('u'); await sleep(500)
  ok('U lists unread only', state()?.unread === true && calls.some(c => c.includes('read=false')) && !m.screen().includes('@dave'))
  m.tty.input('u'); await sleep(500)

  m.tty.input('a'); await sleep(200)
  ok('A asks first', m.screen().includes('READ ALL') && !calls.some(c => c.startsWith('POST')))
  m.tty.input('y'); await sleep(700)
  ok('read-all posted and the count cleared', calls.includes('POST /v1/notifications/read-all') && counts.count === 0)

  m.tty.input('q'); await sleep(300)
  const code = await m.task.wait
  ok('q exits 0', code === 0, `exit=${code}`)
  ok('alt screen left', m.out().includes('\x1b[?1049l'))
  kernel.jobs.remove(job)
}

{
  const m = boot({ v: 2, tab: 5, sel: 0, unread: false })
  await sleep(800)
  ok('POKES listed from the parked tab', m.screen().includes('@carol poked you') && !m.screen().includes('@bob'))
  m.tty.input('\x1b'); await sleep(200)
  ok('Escape asks', m.screen().includes('Quit inbox?'))
  m.tty.input('y'); await sleep(300)
  await m.task.wait
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
