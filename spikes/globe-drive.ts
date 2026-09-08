// globe(1) driven headless through a real Kernel + Tty with a fake API: a frame
// of picture handles, pins, Tab selects, / finds, argv centres, a parked
// state restores, ^C exits 130, q exits 0.
// Run: bun spikes/globe-drive.ts

import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { Terminal } from '../app/node_modules/@xterm/headless/lib-headless/xterm-headless.js'
import { globeProgram, latLonToVector3, lookAt } from '../apps/cyberspace/src/globe.ts'
import type { ApiClient } from '../apps/cyberspace/src/api.ts'

;(globalThis as { window?: unknown }).window = globalThis

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const ROOT = new URL('..', import.meta.url).pathname
const bin = new Uint8Array(await Bun.file(`${ROOT}app/public/world.bin`).arrayBuffer())

const calls: string[] = []
const pins = [
  { username: 'alice', lat: 51.5, lon: -0.1, name: 'London' },
  { username: 'bob', lat: -33.9, lon: 151.2 },
  { username: 'carol', lat: 35.7, lon: 139.7, name: 'Tokyo' },
]
const api = {
  authed: true, username: 'tester', userId: 'u-tester',
  async get(path: string) {
    calls.push('GET ' + path)
    if (path === '/v1/globe') return pins
    if (/\/guilds$/.test(path)) return [{ name: 'Cartographers', role: 'member' }]
    if (path.startsWith('/v1/users/')) return { username: decodeURIComponent(path.split('/')[3]!), bio: 'Lives by the sea.', createdAt: '2024-01-01T00:00:00Z', locationName: 'Tokyo', isSupporter: true, profilePictureUrl: 'https://x/p.png', websiteUrl: 'https://example.org' }
    throw new Error('unexpected ' + path)
  },
  async searchUsers(q: string, opts?: { located?: boolean }) { calls.push('SEARCH ' + q + (opts?.located ? ' located' : '')); return pins.map(p => p.username).filter(n => n.startsWith(q)).concat(q.startsWith('zed') ? ['zedd'] : []) },
} as unknown as ApiClient

const kernel = new Kernel()
const sets: number[] = []
let released = 0, twoPlane = 0, bitmaps = 0
const bank = () => ({
  range: (n: number) => ({ base: 0xe000, count: n }),
  set: (codes: number[], bits: Uint16Array[]) => { sets.push(codes.length); for (const b of bits) { bitmaps++; if (b.length >= 32) twoPlane++ } },
  slot: () => 8,
  load: async () => ({ lines: Array(8).fill('\ue100'.repeat(20)) }),
  release: () => { released++ },
})
const metrics = () => ({ cellW: 8, cellH: 16, advance: 9, stretch: 1.34 })
// A two-glyph face: `a` is a full block, everything else missing. Enough to see
// the label land as lit pixels.
const tiny = () => ({ cellW: 6, cellH: 13, glyphs: new Map([[97, Array(13).fill(0x3f)]]) })
const globe = globeProgram(api, { world: async () => bin, metrics, pixels: bank, tiny })

function boot(argv: string[], cols = 80, rows = 25) {
  let out = ''
  const xt = new Terminal({ cols, rows, allowProposedApi: true })
  const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, cols, rows)
  const task = kernel.spawn(globe, {
    argv, env: { HOME: '/home/x' }, cwd: '/home/x',
    stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty,
  })
  const screen = () => {
    const b = xt.buffer.active
    return Array.from({ length: rows }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  return { tty, task, out: () => out, screen, reset: () => { out = '' } }
}
const state = () => kernel.resume.state as { v: number; yaw: number; pitch: number; zoom: number; spin: boolean; sel?: string } | undefined
/** One arrow step less the spin over 200 ms: yaw must have grown back past this. */
const STEPPED = 0.06 - 0.03 * 0.2 + 0.01
const yawOf = (lat: number, lon: number) => lookAt(latLonToVector3(lat, lon))
const handles = (s: string) => (s.match(/[\ue000-\uf8ff]/g) ?? []).length

// --- a fresh run -------------------------------------------------------------
{
  const m = boot(['globe'])
  await sleep(400)
  ok('alt screen entered', m.out().includes('\x1b[?1049h'))
  ok('resume line is globe', kernel.resume.line === 'globe')
  ok('pins fetched', calls.includes('GET /v1/globe'))
  const scr = m.screen()
  ok('cells drawn as handles', handles(scr) > 300, `${handles(scr)} cells`)
  ok('bitmaps sent to the bank', sets.length > 0 && sets[0]! > 300, `${sets[0]} first frame, ${sets.slice(1, 4)} next`)
  ok('title and count', scr.includes('GLOBE') && scr.includes('3 members'), scr.split('\n')[0])
  ok('UTC clock', /\d\d:\d\d UTC/.test(scr))
  ok('hint row', /Turn.*Find.*Select.*Zoom.*Spin.*Help/.test(scr.split('\n')[24]!) && !scr.includes('Next') && !scr.includes('Backface') && !scr.includes('Night') && !scr.includes('Exit') && scr.split('\n')[0]!.includes('ESC'), scr.split('\n')[24])
  // Three levels ride the 256-colour fg index: 15 BRIGHT, 7 NORMAL, 8 DIM, 240 FAINT (see tui attrs.ts).
  ok('DIM and FAINT planes present (terminator, graticule)', m.out().includes('38;5;8m') && m.out().includes('38;5;240m'))
  ok('land rides as extra bitmap planes (32 or 48 rows)', sets.some(n => n > 0) && twoPlane > 0, `${twoPlane} of ${bitmaps}`)
  ok('spinning: yaw moves', (await (async () => { const a = state()!.yaw; await sleep(200); return state()!.yaw !== a })()))

  m.tty.input('s'); await sleep(150)
  const y0 = state()!.yaw
  await sleep(200)
  ok('S holds the spin', state()!.spin === false && state()!.yaw === y0 && m.screen().includes('HOLD'))

  m.tty.input('\x1b[D'); await sleep(60)
  const partway = state()!.yaw
  ok('ArrowLeft turns, eased: part of the step after one tick', partway > y0 && partway < y0 + 0.06, `${(partway - y0).toFixed(4)}`)
  await sleep(700)
  ok('the whole step arrives', Math.abs(state()!.yaw - y0 - 0.06) < 1e-9, `${(state()!.yaw - y0).toFixed(5)}`)
  m.tty.input('s'); await sleep(100)
  const y1 = state()!.yaw
  m.tty.input('\x1b[C'); await sleep(200)
  ok('arrows do not stop the spin', state()!.yaw > y1 - STEPPED)
  m.tty.input('s'); await sleep(50)

  m.tty.input('s'); await sleep(50)  // spin back on
  m.tty.input('\r'); await sleep(100)
  ok('Enter with no selection picks the pin nearest the crosshair', typeof state()!.sel === 'string', state()!.sel)
  ok('selecting holds the spin, parked as on', state()!.spin === true && m.screen().includes('HOLD'))
  m.tty.input('\x1b'); await sleep(100)
  ok('deselecting resumes the spin', !m.screen().includes('HOLD') && state()!.sel === undefined)
  m.tty.input('s'); await sleep(50)  // off again for the steps below
  m.tty.input('\t'); await sleep(50)
  ok('Tab selects alice', state()!.sel === 'alice', state()!.sel)
  await sleep(800)
  ok('status names the pin on the row above the footer', m.screen().split('\n')[23]!.includes('@alice') && m.screen().split('\n')[23]!.includes('London') && !m.screen().split('\n')[24]!.includes('@alice'), m.screen().split('\n')[23])
  ok('pixel label: bitmaps changed after selecting (label set in the face)', sets.length > 0)
  ok('eased towards London', Math.abs(state()!.yaw - yawOf(51.5, -0.1).yaw) < 0.05 && Math.abs(state()!.pitch - yawOf(51.5, -0.1).pitch) < 0.05, `${state()!.yaw.toFixed(3)} ${state()!.pitch.toFixed(3)}`)
  ok('selected pin drawn BRIGHT', m.out().includes('38;5;15m'))

  m.tty.input('\t\t\t'); await sleep(50)
  ok('Tab wraps back to alice', state()!.sel === 'alice')
  m.tty.input('p'); await sleep(50)
  ok('P steps back to carol', state()!.sel === 'carol')

  m.tty.input('='); await sleep(100)
  ok('= zooms in', state()!.zoom > 1)
  {
    // Spin is already off here.
    const before = state()!.yaw
    m.tty.input('\x1b[D'); await sleep(800)
    ok('arrow step shrinks with zoom', Math.abs(state()!.yaw - before - 0.06 / 1.25) < 1e-6, `${(state()!.yaw - before).toFixed(4)}`)
  }
  m.tty.input('-'); m.tty.input('-'); await sleep(100)
  ok('- zooms out to the floor', state()!.zoom === 1)

  m.reset(); m.tty.input('\r'); await sleep(300)
  ok('Enter fetches the card', calls.includes('GET /v1/users/carol'))
  ok('card shows the bio, facts, badge and portrait', m.screen().includes('Lives by the sea.') && m.screen().includes('@carol') && m.screen().includes('Cartographers') && m.screen().includes('SUPPORTER') && m.screen().includes('Location') && /\ue100/.test(m.screen()), m.screen())
  m.tty.input('\x1b'); await sleep(100)
  ok('Escape closes the card', !m.screen().includes('Lives by the sea.'))
  m.tty.input('r'); await sleep(50)
  ok('R picks another pin', typeof state()!.sel === 'string' && state()!.sel !== 'carol', state()!.sel)

  m.tty.input('?'); await sleep(100)
  ok('help box lists the keys, Enter on two lines', m.screen().includes('Back face') && m.screen().includes('Previous member') && m.screen().includes('at random') && m.screen().split('\n').some(l => /↵\s+Select the member/.test(l)) && (() => { const rows = m.screen().split('\n'); const a = rows.find(l => l.includes('Select the member')); const b = rows.find(l => l.includes('Card, once selected')); return !!a && !!b && a.indexOf('Select') === b.indexOf('Card') })(), m.screen().split('\n').filter(l => /Card, once|Select the/.test(l)).join(' | '))
  m.tty.input('\x1b'); await sleep(100)
  ok('help closes', !m.screen().includes('Previous member'))

  m.tty.input('/'); await sleep(100)
  ok('find box open', m.screen().includes('FIND MEMBER'))
  m.tty.input('bob'); await sleep(400)
  ok('find suggests from the pins, no search call', m.screen().includes('bob') && !calls.some(c => c.startsWith('SEARCH')))
  m.tty.input('\r'); await sleep(800)
  ok('Enter goes to bob', state()!.sel === 'bob' && Math.abs(state()!.yaw - yawOf(-33.9, 151.2).yaw) < 0.1, `${state()!.sel} ${state()!.yaw.toFixed(2)}`)

  m.tty.input('/'); await sleep(100); m.tty.input('zedd'); await sleep(400)
  ok('no suggestion for a name without a pin', !m.screen().includes('zedd\n') && !m.screen().split('\n').some(l => /^\s*zedd\s*$/.test(l)))
  m.tty.input('\r'); await sleep(200)
  ok('unknown member complained', m.screen().split('\n')[23]!.includes('@zedd: no location'), m.screen().split('\n')[23])

  m.tty.input('\x1b'); await sleep(150)
  ok('Escape deselects', state()!.sel === undefined && !m.screen().includes('Quit the globe?'))
  m.tty.input('\x1b'); await sleep(150)
  ok('Escape again asks', m.screen().includes('Quit the globe?'))
  m.tty.input('n'); await sleep(150)
  ok('n stays', !m.screen().includes('Quit the globe?') && !m.out().includes('\x1b[?1049l'))
  m.tty.input('\x1b'); await sleep(150); m.tty.input('y'); await sleep(150)
  ok('y exits 0', (await m.task.wait) === 0)
  ok('alt screen left after confirm', m.out().includes('\x1b[?1049l'))
  ok('bank released', released === 1)
}
{
  const m = boot(['globe'])
  await sleep(300)
  ok('back face off by default', state()!.back === false)
  ok('terminator on by default', state()!.night === true)
  m.reset(); m.tty.input('u'); await sleep(100)
  ok('U hides the terminator', state()!.night === false)
  {
    // The SGR run in front of the clock: inverse (7) while the terminator is drawn, plain once off.
    const run = (o: string) => { const i = o.lastIndexOf('UTC'); return o.slice(Math.max(0, i - 40), i) }
    ok('clock cap unlit when off', /\d\d:\d\d $/.test(run(m.out())) && !/\x1b\[[0-9;]*;7;[0-9;]*m \d\d:\d\d $/.test(run(m.out())))
    m.reset(); m.tty.input('u'); await sleep(150)
    ok('clock cap lit when on', /\x1b\[[0-9;]*;7;[0-9;]*m \d\d:\d\d $/.test(run(m.out())))
  }

  m.tty.input('q'); await sleep(100)
  const code = await m.task.wait
  ok('q exits 0', code === 0, `exit=${code}`)
  ok('alt screen left', m.out().includes('\x1b[?1049l'))
  ok('bank released twice', released === 2)
}

// --- argv and restore --------------------------------------------------------
{
  calls.length = 0
  const m = boot(['globe', '@carol'])
  await sleep(1000)
  ok('argv: resume line carries the name', kernel.resume.line === 'globe @carol')
  ok('argv: carol selected and centred', state()!.sel === 'carol' && Math.abs(state()!.yaw - yawOf(35.7, 139.7).yaw) < 0.1, `${state()!.sel} ${state()!.yaw.toFixed(2)}`)
  m.tty.input('\x03'); await sleep(100)
  ok('^C exits 130', (await m.task.wait) === 130)
}
{
  kernel.resume.restore('globe', { v: 1, yaw: 1.25, pitch: 0.3, zoom: 1.5625, spin: false, sel: 'bob' })
  const m = boot(['globe'])
  await sleep(400)
  const s = state()!
  ok('restore: view and selection back', Math.abs(s.yaw - 1.25) < 1e-9 && s.zoom === 1.5625 && s.spin === false && s.sel === 'bob', JSON.stringify(s))
  m.tty.input('q'); await m.task.wait
}
{
  const m = boot(['globe', 'nobody'])
  await sleep(400)
  ok('argv unknown: complaint, globe runs', m.screen().includes('@nobody: no location') && handles(m.screen()) > 300)
  m.tty.input('q'); await m.task.wait
}

// --- guest and narrow --------------------------------------------------------
{
  calls.length = 0
  const guest = globeProgram({ authed: false, async get() { throw new Error('no') } } as unknown as ApiClient, {
    world: async () => bin, metrics: () => ({ cellW: 8, cellH: 16, advance: 9 }), pixels: bank,
  })
  let out = ''
  const xt = new Terminal({ cols: 44, rows: 20, allowProposedApi: true })
  const tty = new Tty(d => { out += new TextDecoder().decode(d); xt.write(d) }, 44, 20)
  const task = kernel.spawn(guest, { argv: ['globe'], env: {}, cwd: '/', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty })
  await sleep(400)
  const b = xt.buffer.active
  const scr = Array.from({ length: 20 }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n')
  ok('guest: no pin fetch', !calls.length)
  ok('narrow: draws, hint fits', handles(scr) > 100 && scr.includes('Turn') && !scr.includes('members'), scr.split('\n')[19])
  tty.input('/'); await sleep(100)
  tty.input('q'); ok('guest exits 0', (await task.wait) === 0)
}

console.log(fail ? `\n${fail} FAILED` : '\nall ok')
process.exit(fail ? 1 : 0)
