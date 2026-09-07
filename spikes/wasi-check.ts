// WASI host checks: the worker end to end with the Go test program (staged
// file round trip, new file, tty_size, clock poll, raw toggle, blocking read
// on the ring) and poll_oneoff directly against a hand-built subscription.
// Run: spikes/wasitest/build.sh && bun spikes/wasi-check.ts
import { createRing, RingWriter, RingReader } from '../packages/kernel/src/sabring.ts'
import { pollOneoff } from '../packages/kernel/src/poll.ts'
import type { RunMessage, OutMessage } from '../packages/kernel/src/wasi.worker.ts'

let fail = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}
const dec = new TextDecoder()
const enc = new TextEncoder()

// --- poll_oneoff -----------------------------------------------------------

function subs(view: DataView, list: ({ clock: number } | { fd: number })[]): void {
  list.forEach((s, i) => {
    const at = i * 48
    view.setBigUint64(at, BigInt(i + 1), true)
    if ('clock' in s) {
      view.setUint8(at + 8, 0)
      view.setUint32(at + 16, 1, true) // monotonic
      view.setBigUint64(at + 24, BigInt(s.clock) * 1_000_000n, true)
      view.setUint16(at + 40, 0, true)
    } else {
      view.setUint8(at + 8, 1)
      view.setUint32(at + 16, s.fd, true)
    }
  })
}
{
  const sab = createRing()
  const reader = new RingReader(sab)
  const writer = new RingWriter(sab)
  const mem = new DataView(new ArrayBuffer(1024))
  const host = {
    ring: (fd: number) => (fd === 0 ? reader : null),
    open: (fd: number) => fd < 4,
    sleep: (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
  }
  const OUT = 512
  const NEV = 1000

  subs(mem, [{ fd: 0 }, { clock: 60 }])
  let t = performance.now()
  let ret = pollOneoff(mem, 0, OUT, 2, NEV, host)
  let dt = performance.now() - t
  check('poll: keyboard idle -> clock event after timeout', ret === 0 && mem.getUint32(NEV, true) === 1 && mem.getUint8(OUT + 10) === 0 && dt >= 55 && dt < 200, `${dt.toFixed(0)}ms`)

  writer.write(enc.encode('abc'))
  t = performance.now()
  ret = pollOneoff(mem, 0, OUT, 2, NEV, host)
  dt = performance.now() - t
  check('poll: bytes waiting -> fd_read event at once, nbytes 3', ret === 0 && mem.getUint32(NEV, true) === 1 && mem.getUint8(OUT + 10) === 1 && Number(mem.getBigUint64(OUT + 16, true)) === 3 && dt < 10)

  subs(mem, [{ fd: 0 }])
  ret = pollOneoff(mem, 0, OUT, 1, NEV, host)
  check('poll: fd only, bytes waiting -> ready', ret === 0 && mem.getUint32(NEV, true) === 1)

  reader.readBlocking(16)
  subs(mem, [{ clock: 20 }])
  t = performance.now()
  ret = pollOneoff(mem, 0, OUT, 1, NEV, host)
  dt = performance.now() - t
  check('poll: clock only sleeps without spinning', ret === 0 && dt >= 18 && dt < 100, `${dt.toFixed(0)}ms`)

  subs(mem, [{ fd: 0 }, { clock: 5000 }])
  writer.close()
  ret = pollOneoff(mem, 0, OUT, 2, NEV, host)
  check('poll: EOF -> fd_read event with hangup', ret === 0 && mem.getUint32(NEV, true) === 1 && mem.getUint8(OUT + 10) === 1 && mem.getUint16(OUT + 24, true) === 1)
}

// --- the worker with the Go program -----------------------------------------

const wasm = await Bun.file(new URL('./wasitest.wasm', import.meta.url)).arrayBuffer()
const ring = createRing()
const writer = new RingWriter(ring)
const worker = new Worker(new URL('../packages/kernel/src/wasi.worker.ts', import.meta.url))

const out: string[] = []
const files = new Map<string, string>()
const raws: boolean[] = []
const code = await new Promise<number>(resolve => {
  worker.onmessage = (e: MessageEvent<OutMessage>) => {
    const m = e.data
    if (m.t === 'out') out.push(dec.decode(m.d))
    else if (m.t === 'err') out.push('ERR ' + dec.decode(m.d))
    else if (m.t === 'file') files.set(m.path, dec.decode(m.d))
    else if (m.t === 'raw') {
      raws.push(m.on)
      if (m.on) setTimeout(() => writer.write(enc.encode('typed\n')), 30)
    } else if (m.t === 'exit') resolve(m.code)
    else if (m.t === 'fault') { out.push('FAULT ' + m.message); resolve(-1) }
  }
  worker.onerror = e => { out.push('WORKER ' + e.message); resolve(-2) }
  const msg: RunMessage = {
    wasm,
    argv: ['wasitest', 'a.txt', 'sub/new.txt'],
    env: ['PWD=/home/guest', 'TERM=xterm'],
    ring,
    dirs: ['/home/guest', '/home/guest/sub'],
    files: [{ path: '/home/guest/a.txt', data: enc.encode('one\n').buffer as ArrayBuffer }],
    tty: { cols: 80, rows: 24 },
  }
  worker.postMessage(msg)
})
worker.terminate()

const text = out.join('')
console.log(text.replace(/^/gm, '      | '))
check('worker: exit 0', code === 0, `code ${code}`)
check('worker: cwd from PWD', text.includes('cwd=/home/guest'))
check('worker: tty_size import', text.includes('tty=80x24'))
check('worker: staged file read', text.includes('read a.txt: 4 bytes'))
check('worker: written file posted back whole', files.get('/home/guest/a.txt') === 'one\nappended\n', JSON.stringify(files.get('/home/guest/a.txt')))
check('worker: created file posted with its path', files.get('/home/guest/sub/new.txt') === 'new file\n', JSON.stringify(files.get('/home/guest/sub/new.txt')))
check('worker: time.Sleep through poll_oneoff', /slept=(4[5-9]|[5-9]\d|1\d\d)ms/.test(text), text.match(/slept=\d+ms/)?.[0])
check('worker: raw on then off', raws.join(',') === 'true,false', raws.join(','))
check('worker: blocking read on the ring', text.includes('line="typed\\n"'))

console.log(fail ? `\n${fail} FAILED` : '\nall ok')
process.exit(fail ? 1 : 0)
