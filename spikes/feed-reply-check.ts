// `feed -p <post> <reply>`, as inbox opens a reply, headless with a fake API:
// the screen must land on the reply, never reveal the post from its top first
// and then jump. Run: bun spikes/feed-reply-check.ts

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

const TITLE = 'The original post'
const LAST = 'Reply number 20'
const LIST = 'A post in the main feed'
const post = {
  postId: 'p1', authorId: 'u-alice', authorUsername: 'alice', title: TITLE,
  content: 'Body of the post.', topics: ['test'], repliesCount: 20, createdAt: new Date().toISOString(),
}
const replies = Array.from({ length: 20 }, (_, i) => ({
  replyId: `r${i + 1}`, authorUsername: 'carol', content: `Reply number ${i + 1}`,
  createdAt: new Date(Date.now() + i * 1000).toISOString(),
}))

// Each request answers after 150 ms, so the post and its replies arrive in separate frames.
const later = <T>(v: T) => new Promise<T>(r => setTimeout(() => r(v), 150))
const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async get(path: string) {
    if (path === '/v1/settings') return { filterNSFW: false, defaultPublicPost: false }
    if (path === '/v1/users/me') return { mutedUsers: [], blockedUsers: [] }
    if (path === '/v1/posts/p1') return later(post)
    throw new Error('unexpected ' + path)
  },
  async page(path: string) {
    if (/^\/v1\/posts\/p1\/replies/.test(path)) return later({ rows: replies, cursor: null })
    // The main feed, which `feed -p` opens beneath the post.
    if (path.startsWith('/v1/posts?')) return { rows: [{ ...post, postId: 'p0', title: LIST }], cursor: null }
    throw new Error('unexpected ' + path)
  },
} as unknown as ApiClient

const xt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
const screen = () => Array.from({ length: 24 }, (_, y) => xt.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
const frames: string[] = []
const tty = new Tty(d => xt.write(d, () => frames.push(screen())), 80, 24)
new Kernel().spawn(feedProgram(api), {
  argv: ['feed', '-p', 'p1', 'r20'], env: { HOME: '/home/x' }, cwd: '/home/x',
  stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume(),
})
await sleep(1500)

const early = frames.findIndex(f => f.includes(TITLE) && !f.includes(LAST))
ok('the post is not shown from its top before the reply', early === -1, early === -1 ? '' : `frame ${early} of ${frames.length}`)
ok('the main feed beneath never shows', !frames.some(f => f.includes(LIST)))
ok('the screen lands on the reply', screen().includes(LAST))
ok('LOADING while the thread is fetched', frames.some(f => f.includes('LOADING')))

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
