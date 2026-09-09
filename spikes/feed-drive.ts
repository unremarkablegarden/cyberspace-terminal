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
const feed = feedProgram(api)

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
const state = () => resume.state as { v: number; screens: { author?: string; sel: number; open?: { id: string }; modal?: string }[]; draft?: { body: string } }

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

  m.reset(); m.tty.input('w'); await sleep(200)
  m.tty.input('draft words'); await sleep(200)
  ok('composer draft parked', state()?.draft?.body === 'draft words', JSON.stringify(state()?.draft))
  m.tty.input('\x1b'); await sleep(200)
  ok('draft kept after leaving composer', state()?.draft?.body === 'draft words')

  m.reset(); m.tty.input('\x1b'); await sleep(200)
  ok('Escape asks', m.screen().includes('Quit the feed?'))
  m.tty.input('n'); await sleep(200)
  ok('n stays', state()?.screens.length === 1 && !m.out().includes('\x1b[?1049l'))
  m.tty.input('\x1b'); await sleep(200); m.tty.input('y'); await sleep(300)
  const code = await m.task.wait
  ok('y exits 0', code === 0, `exit=${code}`)
  ok('alt screen left', m.out().includes('\x1b[?1049l'))
  ok('no POST sent', !calls.some(c => c.startsWith('POST')))
}

// --- restore ----------------------------------------------------------------
{
  calls.length = 0
  resume = new Resume()
  resume.restore('feed', {
    v: 1,
    screens: [{ sel: 1, open: { id: 'p2', scroll: 0, sel: 0 } }, { author: 'bob', sel: 1 }],
    draft: { title: 't', body: 'parked body', topics: '', blog: false, nsfw: false, vent: false },
  })
  const m = boot(['feed'])
  await sleep(2000)
  const s = state()
  ok('stack restored', s?.screens.length === 2 && s.screens[1]?.author === 'bob', JSON.stringify(s?.screens))
  ok('inner selection restored', s?.screens[1]?.sel === 1)
  ok('open post restored underneath', s?.screens[0]?.open?.id === 'p2')
  ok('resume line stays feed', resume.line === 'feed')
  ok('draft restored', s?.draft?.body === 'parked body')
  ok('bob list printed', m.screen().includes('Post number 4'))
  ok('restored replies fetched once', calls.filter(c => c.includes('/v1/posts/p2/replies')).length === 1)
  m.tty.input('\x03'); await sleep(300)
  const code = await m.task.wait
  ok('^C leaves at once', code === 0 || code === 130, `exit=${code}`)
  ok('alt screen left', m.out().includes('\x1b[?1049l'))
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
