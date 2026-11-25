// directory(1) driven headless through a real Kernel + Tty with a fake API and
// a fake picture bank: the first screen waits for its pictures and is drawn
// tile by tile, arrows move and scroll with the next rows fetched ahead,
// / filters, S sorts, Enter opens the card, Esc closes it, C F P act on the
// card only, the state parks.
// Run: bun spikes/directory-drive.ts

import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Resume } from '../packages/kernel/src/resume.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { directoryProgram, type DirectoryEntry } from '../apps/cyberspace/src/directory.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'

;(globalThis as { window?: unknown }).window = globalThis

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// 40 members, m00 the oldest. m07 has a picture that cannot be read.
const rows: DirectoryEntry[] = Array.from({ length: 40 }, (_, i) => ({
  username: `m${String(i).padStart(2, '0')}`, userId: `u${i}`, picture: `https://x/${i}.png`,
  joined: 1_600_000_000_000 + i * 86_400_000, serial: i + 1,
}))

const calls: string[] = []
const posts: string[] = []
const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async page(path: string) {
    calls.push('PAGE ' + path)
    if (path.startsWith('/v1/follows')) return { rows: [{ followedId: 'u38' }], cursor: null }
    // The server's paging, at most 10 a page here so the grid has to read several.
    const u = new URL(path, 'http://x')
    const sort = u.searchParams.get('sort'), q = u.searchParams.get('q') ?? ''
    const offset = Number(u.searchParams.get('cursor') ?? 0), limit = Math.min(10, Number(u.searchParams.get('limit')))
    await sleep(30)
    let out = rows.filter(r => r.username.includes(q))
    if (sort === 'new' || sort === 'eman') out = out.reverse()
    if (sort === 'random') out = [...out].sort((a, b) => ((a.serial! * 7919 + Number(u.searchParams.get('seed'))) % 41) - ((b.serial! * 7919 + Number(u.searchParams.get('seed'))) % 41))
    const end = offset + limit
    return { rows: out.slice(offset, end), cursor: end < out.length ? String(end) : null }
  },
  async post(path: string, body: unknown) { posts.push(path + ' ' + JSON.stringify(body)); return {} },
  async delete(path: string) { posts.push('DELETE ' + path); return {} },
  async get(path: string) {
    calls.push('GET ' + path)
    if (/\/guilds$/.test(path)) return []
    if (path.startsWith('/v1/users/')) {
      const u = decodeURIComponent(path.split('/')[3]!)
      return { userId: 'u' + Number(u.slice(1)), username: u, bio: `Bio of ${u}.`, createdAt: '2024-01-01T00:00:00Z', isSupporter: true }
    }
    throw new Error('unexpected ' + path)
  },
} as unknown as ApiClient

// The bank: a picture is 12 cells of one handle per member, after 40 ms.
const loaded = new Map<string, string[]>()
const loads: string[] = []
let noRoomOnce = false
let ensured: string[] = []
let released = 0
const glyph = (src: string) => String.fromCodePoint(0xe000 + Number(src.match(/(\d+)\.png/)![1]))
const pics = () => ({
  picture: (src: string) => { const l = loaded.get(src); return l ? { cols: 12, rows: 6, lines: l } : undefined },
  // A square picture is half as many rows as columns, at most 6.
  slot: (c: number) => Math.min(6, Math.ceil(c / 2)),
  ensure: (srcs: Iterable<string | undefined>) => { ensured = [...srcs].filter(Boolean) as string[] },
  load: async (src: string | Uint8Array) => {
    const s = src as string
    loads.push(s)
    await sleep(40)
    if (s.endsWith('/7.png')) throw new Error('cors')
    // m11 does not fit the bank the first time: kept, and fetched again after a scroll.
    if (s.endsWith('/11.png') && !noRoomOnce) { noRoomOnce = true; throw new Error('no room') }
    const lines = Array(6).fill(glyph(s).repeat(12))
    loaded.set(s, lines)
    return { cols: 12, rows: 6, lines }
  },
  release: () => { released++ },
})

const sounds: string[] = []
const snd = {
  tick: () => sounds.push('tick'),
  beep: (hz = 0) => sounds.push(`beep ${hz}`),
  blip: (hz = 0) => sounds.push(`blip ${hz}`),
  seek: () => {},
}

const kernel = new Kernel()
const resume = new Resume()
// The host's per-program store, in memory.
const stored = new Map<string, Record<string, string>>()
const storage = {
  load: async (name: string) => ({ ...stored.get(name) }),
  save: async (name: string, data: Record<string, string>) => { stored.set(name, { ...data }) },
}
const dir = directoryProgram(api, pics, snd, storage)

function boot(cols = 80, rowsN = 25) {
  let out = ''
  const xt = new Terminal({ cols, rows: rowsN, allowProposedApi: true })
  const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, cols, rowsN)
  const task = kernel.spawn(dir, {
    argv: ['directory'], env: { HOME: '/home/x' }, cwd: '/home/x',
    stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume,
  })
  const screen = () => {
    const b = xt.buffer.active
    return Array.from({ length: rowsN }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  return { tty, task, out: () => out, screen }
}
const shown = (scr: string, i: number) => scr.includes(String.fromCodePoint(0xe000 + i))
const state = () => resume.state as { sort: string; sel?: string; query?: string }

const m = boot()
await sleep(60)
ok('first page read, newest first', calls.includes('PAGE /v1/directory?sort=new&limit=60&cursor=0'), calls.join(' | '))
ok('held while the first pictures load', !shown(m.screen(), 39) && m.screen().split('\n')[0]!.includes('LOADING'), m.screen().split('\n')[0])
// 80x25: 23 grid rows, the picture cut to 5 rows so 3 tile rows fit, 10 columns wide, 12 per tile, 6 a row; 2 more rows ahead.
ok('fetches LOADS at a time', loads.length === 6, String(loads.length))
await sleep(200)
ok('fetches the screen and two rows ahead, no further', loads.length === 30 && !loads.includes('https://x/9.png'), `${loads.length}`)
// m39..m22 on screen in the new sort; picture 39 first.
{
  let partial = false
  for (let t = 0; t < 40; t++) {
    const scr = m.screen()
    if (shown(scr, 39) && !shown(scr, 22)) partial = true
    if (shown(scr, 22)) break
    await sleep(10)
  }
  ok('first screen revealed tile by tile', partial)
}
await sleep(300)
{
  const scr = m.screen()
  ok('three rows of six tiles drawn with names', shown(scr, 39) && shown(scr, 22) && scr.includes('m39') && scr.includes('m22') && !shown(scr, 21), scr)
  ok('title, count, sort', scr.split('\n')[0]!.includes('DIRECTORY') && !scr.includes('members') && scr.includes(' NEW '))
  ok('no info line above the footer', !scr.includes('@m39'))
  ok('footer: sort, find, profile only', /S  Sort  \/  Find  ↵  Profile  ─┘$/.test(scr.split('\n')[24]!) && !/Move|NEW|C-Mail/.test(scr.split('\n')[24]!), scr.split('\n')[24])
  ok('arrived pictures named to the bank', ensured.length >= 10)
}

m.tty.input('\x1b[C'); await sleep(30)
ok('Right moves', state().sel === 'm38')
m.tty.input('\x1b[A'); await sleep(30)
ok('Up at the top row beeps', sounds.at(-1)?.startsWith('beep') === true)
m.tty.input('\x1b[B'); await sleep(30)
m.tty.input('\x1b[B'); await sleep(30)
m.tty.input('\x1b[B'); await sleep(30)
{
  const scr = m.screen()
  ok('Down past the screen scrolls one row', state().sel === 'm20' && shown(scr, 20) && !shown(scr, 39), state().sel)
  ok('the new row was drawn at once (fetched ahead)', shown(scr, 16))
}
await sleep(200)
ok('fetched ahead again after the scroll', loads.includes('https://x/5.png'))
ok('next pages read as the rows ahead reach the end of the list', calls.includes('PAGE /v1/directory?sort=new&limit=60&cursor=20'), calls.filter(c => c.startsWith('PAGE /v1/dir')).join(' | '))
m.tty.input('\x1b[6~'); await sleep(30)
ok('PageDown: m07 dropped on the way, so m01', state().sel === 'm01', state().sel)
await sleep(300)
ok('a picture that did not fit the bank is kept and fetched again', loads.filter(x => x.endsWith('/11.png')).length === 2 && m.screen().includes('m11'), String(loads.filter(x => x.endsWith('/11.png')).length))
await sleep(300)
m.tty.input('\x1b[F'); await sleep(30)
ok('End', state().sel === 'm00')
m.tty.input('\x1b[H'); await sleep(30)
ok('Home', state().sel === 'm39')

// Search: sent once the keys stop, filtered on the server.
m.tty.input('/'); await sleep(30)
{
  const before = calls.length
  m.tty.input('3'); m.tty.input('0'); await sleep(50)
  ok('no read while typing', calls.length === before)
  m.tty.input('\x7f'); await sleep(170)
  ok('search text stays beside LOADING while the search is read', /\/3 .*LOADING/.test(m.screen().split('\n')[0]!), m.screen().split('\n')[0])
  await sleep(130)
  const sent = calls.slice(before)
  ok('one read for the burst, with q', sent.filter(c => c.includes('cursor=0')).length === 1 && sent[0]!.includes('q=3'), sent.join(' | '))
}
{
  const scr = m.screen()
  ok('filters', scr.includes('m39') && scr.includes('m13') && !scr.includes('m20') && scr.split('\n')[0]!.includes('/3'), scr.split('\n')[0])
  ok('search footer', /Clear.*Profile/.test(scr.split('\n')[24]!) && !scr.split('\n')[24]!.includes('Move'), scr.split('\n')[24])
}
m.tty.input('\x7f'); m.tty.input('0'); m.tty.input('7'); await sleep(300)
ok('member with an unreadable picture is dropped', !m.screen().includes('m07') && m.screen().includes('No match'), m.screen().split('\n')[0])
m.tty.input('\x7f'); await sleep(300)
ok('Backspace widens', m.screen().includes('m30'))
m.tty.input('\x1b[C'); await sleep(30)
ok('arrows move while typing', state().sel === 'm20', state().sel)
m.tty.input('\x1b'); await sleep(100)
ok('Esc clears the search', !m.screen().split('\n')[0]!.includes('/0') && !state().query && m.screen().includes('m39'))

// Sort.
m.tty.input('s'); await sleep(30)
{
  const scr = m.screen()
  ok('S opens the sort box', scr.includes('SORT') && scr.includes('Newest first') && scr.includes('Random'), scr)
}
m.tty.input('\x1b[B'); m.tty.input('\r'); await sleep(200)
ok('choosing Oldest first sorts from the top', state().sort === 'old' && state().sel === 'm00' && m.screen().includes(' OLD ') && !m.screen().includes('Newest first'))
m.tty.input('s'); m.tty.input('\x1b'); await sleep(30)
ok('Esc leaves the order alone', state().sort === 'old' && !m.screen().includes('Newest first'))
m.tty.input('s'); m.tty.input('5'); await sleep(30)
ok('digit picks a row: RANDOM', state().sort === 'random' && m.screen().includes(' RANDOM '))
m.tty.input('s'); m.tty.input('1'); await sleep(200)
ok('...back to NEW', state().sort === 'new' && state().sel === 'm39')

// Card.
sounds.length = 0
m.tty.input('\r'); await sleep(150)
{
  const scr = m.screen()
  ok('Enter opens the card', calls.includes('GET /v1/users/m39') && scr.includes('@m39') && scr.includes('Bio of m39.'), scr)
  ok('open bleeps', sounds.includes('blip 520'), sounds.join(','))
  ok('card footer', /C-Mail.*Follow.*Poke.*Close/.test(scr.split('\n')[24]!) && !scr.split('\n')[24]!.includes('Sort'), scr.split('\n')[24])
}
m.tty.input('p'); await sleep(60)
ok('P on the card pokes', posts.includes('/v1/users/m39/poke {}') && m.screen().includes('POKED'))
m.tty.input('f'); await sleep(60)
ok('F on the card follows', posts.includes('/v1/follows {"followedId":"u39"}') && m.screen().split('\n')[24]!.includes('Unfollow'), m.screen().split('\n')[24])
sounds.length = 0
m.tty.input('\x1b'); await sleep(60)
ok('Esc closes, with a bleep', !m.screen().includes('Bio of m39.') && sounds.includes('blip 390'), sounds.join(','))
{
  const before = posts.length
  m.tty.input('p'); m.tty.input('f'); m.tty.input('c'); await sleep(60)
  ok('C F P do nothing on the grid', posts.length === before)
}

m.tty.input('q'); await sleep(60)
ok('q exits and releases the bank', released === 1 && m.out().includes('\x1b[?1049l'))

// A second run restores the parked sort and selection.
{
  const before = loads.length
  const reads = calls.filter(c => c.startsWith('PAGE /v1/directory')).length
  const r = boot()
  await sleep(600)
  ok('restored selection', state().sel === 'm39' && shown(r.screen(), 39))
  ok('pictures already in the bank are not fetched again', loads.length === before)
  ok('list pages come from the cache', calls.filter(c => c.startsWith('PAGE /v1/directory')).length === reads)
  r.tty.input('q'); await sleep(30)
}

// A fresh run with no parked state takes the sort chosen last.
{
  const pick = boot()
  await sleep(400)
  pick.tty.input('s'); pick.tty.input('3'); await sleep(100)
  pick.tty.input('q'); await sleep(50)
  const xt = new Terminal({ cols: 80, rows: 25, allowProposedApi: true })
  const tty = new Tty(d => xt.write(d), 80, 25)
  const fresh = new Resume()
  kernel.spawn(dir, { argv: ['directory'], env: { HOME: '/home/x' }, cwd: '/home/x', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: fresh })
  await sleep(400)
  ok('sort remembered across runs, in the program store', stored.get('directory')?.sort === 'name' && stored.get('directory')?.query === '' && (fresh.state as { sort?: string } | undefined)?.sort === 'name' && (xt.buffer.active.getLine(0)?.translateToString(true) ?? '').includes(' A-Z '), xt.buffer.active.getLine(0)?.translateToString(true))
  tty.input('q'); await sleep(30)
}

// The search is kept too.
{
  const a = boot()
  await sleep(400)
  a.tty.input('/'); a.tty.input('3'); await sleep(300)
  a.tty.input('q'); await sleep(50)
  ok('search stored', stored.get('directory')?.query === '3', JSON.stringify(stored.get('directory')))
  const xt = new Terminal({ cols: 80, rows: 25, allowProposedApi: true })
  const tty = new Tty(d => xt.write(d), 80, 25)
  kernel.spawn(dir, { argv: ['directory'], env: { HOME: '/home/x' }, cwd: '/home/x', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume() })
  await sleep(400)
  ok('search restored in a fresh run', (xt.buffer.active.getLine(0)?.translateToString(true) ?? '').includes('/3'), xt.buffer.active.getLine(0)?.translateToString(true))
  tty.input('\x1b'); await sleep(100)
  tty.input('q'); await sleep(30)
  ok('cleared search stored', stored.get('directory')?.query === '')
}

// A slow server: placeholder boxes while pictures load, LOADING while a page is read.
{
  const many: DirectoryEntry[] = Array.from({ length: 200 }, (_, i) => ({
    username: `s${String(i).padStart(3, '0')}`, userId: `s${i}`, picture: `https://y/${i}.png`, joined: 1 + i,
  }))
  const slowCalls: string[] = []
  const slowApi = {
    ...api,
    async page(path: string) {
      slowCalls.push(path)
      if (path.startsWith('/v1/follows')) return { rows: [], cursor: null }
      const u = new URL(path, 'http://x')
      const offset = Number(u.searchParams.get('cursor')), limit = Number(u.searchParams.get('limit'))
      await sleep(offset ? 400 : 20)
      const end = offset + limit
      return { rows: many.slice(offset, end), cursor: end < many.length ? String(end) : null }
    },
  } as unknown as ApiClient
  const slowPics = () => ({
    ...pics(),
    picture: (src: string) => { const l = loaded.get(src); return l ? { cols: 12, rows: 6, lines: l } : undefined },
    load: async (src: string | Uint8Array) => {
      const n = Number(String(src).match(/(\d+)\.png/)![1])
      // The first screen fast, the rest slow.
      await sleep(n < 18 ? 10 : 300)
      const lines = Array(6).fill(String.fromCodePoint(0xe100 + n).repeat(12))
      loaded.set(String(src), lines)
      return { cols: 12, rows: 6, lines }
    },
  })
  const prog = directoryProgram(slowApi, slowPics, snd)
  const xt = new Terminal({ cols: 80, rows: 25, allowProposedApi: true })
  let raw = ''
  const out = () => raw
  const tty = new Tty(d => { raw += new TextDecoder().decode(d); xt.write(d) }, 80, 25)
  kernel.spawn(prog, { argv: ['directory'], env: { HOME: '/home/x' }, cwd: '/home/x', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty, resume: new Resume() })
  const screen = () => Array.from({ length: 25 }, (_, y) => xt.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  await sleep(500)
  tty.input('\x1b[6~'); tty.input('\x1b[6~'); tty.input('\x1b[6~'); await sleep(60)
  {
    const scr = screen()
    ok('placeholder squares where pictures have not arrived: lit ground', /\x1b\[[0-9;]*48;5;\d+m {10}/.test(out()), '')
    ok('a page in flight: LOADING on the top rule', scr.split('\n')[0]!.includes('LOADING') && slowCalls.some(c => c.includes('cursor=60')), scr.split('\n')[0])
  }
  await sleep(600)
  ok('LOADING gone once the page is in', !screen().split('\n')[0]!.includes('LOADING'))
  tty.input('q'); await sleep(30)
}

console.log(fail ? `\n${fail} failed` : '\nall ok')
process.exit(fail ? 1 : 0)
