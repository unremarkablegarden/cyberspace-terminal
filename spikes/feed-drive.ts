// feed(1) driven headless through a real Kernel + Tty with a fake API: keys
// move, open, push a member's list, park state, and a parked state restores.
// Run: bun spikes/feed-drive.ts

import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Resume } from '../packages/kernel/src/resume.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { feedProgram } from '../apps/cyberspace/src/feed.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'

// Reveal schedules through window.setInterval; bun has no window.
;(globalThis as { window?: unknown }).window = globalThis

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const post = (n: number, author = 'alice') => ({
  postId: `p${n}`, authorId: `u-${author}`, authorUsername: author,
  title: `Post number ${n}`, content: `Body of post ${n} with a [link](https://example.com/${n}).`,
  topics: ['test'], repliesCount: n === 1 ? 1 : 0, createdAt: new Date(Date.now() - n * 60_000).toISOString(),
})
const posts = Array.from({ length: 5 }, (_, i) => post(i + 1, i % 2 ? 'bob' : 'alice'))

const calls: string[] = []
const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async get(path: string) {
    calls.push('GET ' + path)
    if (path === '/v1/settings') return { filterNSFW: false, defaultPublicPost: false }
    if (path === '/v1/users/me') return { mutedUsers: [], blockedUsers: [] }
    if (path.startsWith('/v1/users/')) return { username: decodeURIComponent(path.split('/')[3]), bio: 'A &amp; bio', createdAt: '2024-01-01T00:00:00Z' }
    throw new Error('unexpected ' + path)
  },
  async page(path: string) {
    calls.push('GET ' + path)
    if (path.startsWith('/v1/posts?')) return { rows: posts, cursor: null }
    if (/^\/v1\/users\/bob\/posts/.test(path)) return { rows: posts.filter(p => p.authorUsername === 'bob'), cursor: null }
    if (/^\/v1\/posts\/p1\/replies/.test(path)) {
      return { rows: [{ replyId: 'r1', authorUsername: 'carol', content: 'First reply here', createdAt: new Date().toISOString() }], cursor: null }
    }
    if (/\/replies/.test(path)) return { rows: [], cursor: null }
    throw new Error('unexpected ' + path)
  },
  async post(path: string, body: unknown) { calls.push('POST ' + path + ' ' + JSON.stringify(body)); return { replyId: 'r2' } },
} as unknown as ApiClient

const kernel = new Kernel()
// One resume slot shared by every run, as a job's would be.
let resume = new Resume()
// The host's draft store, in a variable so a run can be handed one already written.
let slot: string | null = null
const drafts = (): { post?: { d: { body: string } }; replies?: Record<string, { d: { text: string } }> } | null =>
  (slot ? JSON.parse(slot) : null)
const feed = feedProgram(api, undefined, undefined, { get: () => slot, set: v => { slot = v } })

function boot(argv: string[]) {
  let out = ''
  const xt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, 80, 24)
  const task = kernel.spawn(feed, {
    argv, env: { HOME: '/home/x' }, cwd: '/home/x',
    stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume,
  })
  // The raw stream is checked for control sequences; the screen for text, since
  // the diff renderer may split a label across writes.
  const screen = () => {
    const b = xt.buffer.active
    return Array.from({ length: 24 }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  return { tty, task, out: () => out, screen, reset: () => { out = '' } }
}
const state = () => resume.state as { v: number; screens: { author?: string; sel: number; open?: { id: string }; modal?: string }[] }

// --- a fresh run -------------------------------------------------------------
{
  const m = boot(['feed'])
  await sleep(1500)
  ok('alt screen entered', m.out().includes('\x1b[?1049h'))
  ok('resume line is feed', resume.line === 'feed')
  ok('first page fetched', calls.some(c => c.startsWith('GET /v1/posts?limit=')))
  ok('settings and me read', calls.includes('GET /v1/settings') && calls.includes('GET /v1/users/me'))
  ok('titles printed', m.screen().includes('Post number 1') && m.screen().includes('Post number 5'))
  ok('EOF shown beside the hint', m.screen().includes('~EOF~') && m.screen().includes('Nav'), JSON.stringify(m.screen().split('\n')[23]))

  m.tty.input('\x1b[B\x1b[B'); await sleep(100)
  ok('two ArrowDown select 2', state()?.screens[0]?.sel === 2, JSON.stringify(state()?.screens))

  m.tty.input('\x1b[A\x1b[A'); await sleep(100)
  m.reset(); m.tty.input('\r'); await sleep(700)
  ok('Enter opens p1', state()?.screens[0]?.open?.id === 'p1', JSON.stringify(state()?.screens))
  ok('replies fetched', calls.some(c => c.includes('/v1/posts/p1/replies')))
  ok('reply printed', m.screen().includes('First reply here'))
  ok('replies fetched once', calls.filter(c => c.includes('/v1/posts/p1/replies')).length === 1)
  ok('link text printed', m.screen().includes('link'))

  m.tty.input('\x1b'); await sleep(200)
  ok('Escape closes', state()?.screens[0]?.open === undefined)

  m.tty.input('\x1b[B'); await sleep(100)
  m.reset(); m.tty.input('u'); await sleep(1200)
  ok('U pushes bob list', state()?.screens.length === 2 && state()?.screens[1]?.author === 'bob', JSON.stringify(state()?.screens))
  ok('resume line stays feed (the stack is in the state)', resume.line === 'feed')
  ok('bob posts fetched', calls.some(c => c.startsWith('GET /v1/users/bob/posts')))
  ok('bob profile fetched', calls.includes('GET /v1/users/bob'))
  ok('only bob printed', m.screen().includes('Post number 2') && !m.screen().includes('Post number 1'))

  m.tty.input('\x1b'); await sleep(200)
  ok('Escape pops back', state()?.screens.length === 1)
  ok('resume line back to feed', resume.line === 'feed')

  // A reply: the draft is kept as it is typed, ^D asks instead of quitting, ^S posts.
  m.reset(); m.tty.input('r'); await sleep(300)
  ok('R opens the reply box', m.screen().includes('REPLY') && state()?.screens[0]?.modal === 'reply', JSON.stringify(state()?.screens))
  m.tty.input('a reply'); await sleep(600)
  ok('reply draft stored', drafts()?.replies?.p2?.d?.text === 'a reply', slot ?? '')
  m.reset(); m.tty.input('\x04'); await sleep(200)
  ok('^D asks rather than quitting', m.screen().includes('Sure?'))
  ok('^D stayed in the alt screen', !m.out().includes('\x1b[?1049l'))
  m.tty.input('n'); await sleep(200)
  ok('N returns to the text', m.screen().includes('a reply'))
  m.tty.input('\x1b'); await sleep(300)
  ok('Escape keeps the reply draft', drafts()?.replies?.p2?.d?.text === 'a reply')
  m.reset(); m.tty.input('r'); await sleep(300)
  ok('the box reopens with the draft', m.screen().includes('a reply'))
  m.tty.input('!'); await sleep(600)
  ok('the caret opens at the end', drafts()?.replies?.p2?.d?.text === 'a reply!', slot ?? '')
  m.tty.input('\x13'); await sleep(200)
  ok('^S asks', m.screen().includes('Sure?'))
  m.tty.input('y'); await sleep(800)
  ok('reply posted', calls.some(c => c.startsWith('POST /v1/replies') && c.includes('a reply!')),
    calls.filter(c => c.startsWith('POST')).join(' | '))
  ok('the posted draft is dropped', !drafts()?.replies?.p2, slot ?? '')

  // The post opened itself to show the new reply; close it again.
  m.tty.input('\x1b'); await sleep(300)

  m.reset(); m.tty.input('w'); await sleep(300)
  ok('W opens the composer', state()?.screens[0]?.modal === 'write', JSON.stringify(state()?.screens))
  m.tty.input('draft words'); await sleep(600)
  ok('composer draft stored', drafts()?.post?.d?.body === 'draft words', slot ?? '')
  m.reset(); m.tty.input('\x13'); await sleep(200)
  ok('^S asks before publishing', m.screen().includes('PUBLISH'))
  m.tty.input('n'); await sleep(200)
  m.reset(); m.tty.input('\x0e'); await sleep(200)
  ok('^N asks before saving a note', m.screen().includes('SAVE NOTE'))
  m.tty.input('n'); await sleep(200)
  m.tty.input('\x1b'); await sleep(200)
  ok('draft kept after leaving composer', drafts()?.post?.d?.body === 'draft words')
  ok('composer modal cleared', state()?.screens[0]?.modal === undefined)

  m.reset(); m.tty.input('\x1b'); await sleep(200)
  ok('Escape asks', m.screen().includes('Quit the feed?'))
  m.tty.input('n'); await sleep(200)
  ok('n stays', state()?.screens.length === 1 && !m.out().includes('\x1b[?1049l'))
  m.tty.input('\x1b'); await sleep(200); m.tty.input('y'); await sleep(300)
  const code = await m.task.wait
  ok('y exits 0', code === 0, `exit=${code}`)
  ok('alt screen left', m.out().includes('\x1b[?1049l'))
  ok('nothing published', !calls.some(c => c.startsWith('POST /v1/posts') || c.startsWith('POST /v1/notes')))
}

// --- restore ----------------------------------------------------------------
{
  calls.length = 0
  resume = new Resume()
  resume.restore('feed', {
    v: 2,
    screens: [{ sel: 1, open: { id: 'p2', scroll: 0, sel: 0 } }, { author: 'bob', sel: 1 }],
  })
  const m = boot(['feed'])
  await sleep(2000)
  const s = state()
  ok('stack restored', s?.screens.length === 2 && s.screens[1]?.author === 'bob', JSON.stringify(s?.screens))
  ok('inner selection restored', s?.screens[1]?.sel === 1)
  ok('open post restored underneath', s?.screens[0]?.open?.id === 'p2')
  ok('resume line stays feed', resume.line === 'feed')
  ok('bob list printed', m.screen().includes('Post number 4'))
  ok('restored replies fetched once', calls.filter(c => c.includes('/v1/posts/p2/replies')).length === 1)
  m.tty.input('\x03'); await sleep(300)
  const code = await m.task.wait
  ok('^C leaves at once', code === 0 || code === 130, `exit=${code}`)
  ok('alt screen left', m.out().includes('\x1b[?1049l'))
}

// --- a parked reply box comes back with its text -----------------------------
{
  calls.length = 0
  resume = new Resume()
  slot = JSON.stringify({ v: 1, user: 'tester', replies: { p2: { at: Date.now(), d: { text: 'kept text' } } } })
  resume.restore('feed', { v: 2, screens: [{ sel: 1, modal: 'reply' }] })
  const m = boot(['feed'])
  await sleep(2000)
  ok('reply box restored', m.screen().includes('REPLY'), JSON.stringify(state()?.screens))
  ok('the kept text is in it', m.screen().includes('kept text'))
  // The first ^C cancels the box, as it always did; the second leaves the feed.
  m.tty.input('\x03'); await sleep(200)
  m.tty.input('\x03'); await sleep(300)
  const code = await m.task.wait
  ok('^C leaves at once', code === 0 || code === 130, `exit=${code}`)
}

// --- another member's drafts are not shown -----------------------------------
{
  resume = new Resume()
  slot = JSON.stringify({ v: 1, user: 'someone-else', replies: { p2: { at: Date.now(), d: { text: 'not yours' } } } })
  const m = boot(['feed'])
  await sleep(1500)
  m.tty.input('r'); await sleep(300)
  ok('a stranger\'s draft is dropped', !m.screen().includes('not yours'))
  m.tty.input('\x03'); await sleep(200)
  m.tty.input('\x03'); await sleep(300)
  await m.task.wait
  slot = null
}

// --- a hand-started run inherits nothing; feed @user opens the list --------
{
  const m = boot(['feed', '@bob'])
  await sleep(1500)
  ok('argv author', resume.line === 'feed @bob')
  ok('argv list only bob', m.screen().includes('Post number 2') && !m.screen().includes('Post number 1'))
  ok('single screen', state()?.screens.length === 1 && state()?.screens[0]?.author === 'bob', JSON.stringify(state()?.screens))
  m.tty.input('\x1b'); await sleep(200); m.tty.input('y'); await sleep(300)
  const code = await m.task.wait
  ok('exit 0', code === 0, `exit=${code}`)
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
