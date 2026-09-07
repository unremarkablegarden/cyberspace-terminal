// vim.wasm under the real WASI worker: opens a staged file, types, :wq, and
// the written file must come back. Also a fresh file and :q on an unmodified
// buffer. Run: tools/vim/build.sh && bun spikes/vim-check.ts
import { createRing, RingWriter } from '../packages/kernel/src/sabring.ts'
import type { RunMessage, OutMessage } from '../packages/kernel/src/wasi.worker.ts'

const dec = new TextDecoder()
const enc = new TextEncoder()
let fail = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

const wasm = await Bun.file(new URL('../app/public/wasm/vim.wasm', import.meta.url)).arrayBuffer()

interface Run { code: number; out: string; files: Map<string, string>; raws: boolean[]; ms: number }

/** Runs vim with the keys typed after the screen first paints. */
async function vim(argv: string[], keys: string, files: { path: string; text: string }[]): Promise<Run> {
  const ring = createRing()
  const writer = new RingWriter(ring)
  const worker = new Worker(new URL('../packages/kernel/src/wasi.worker.ts', import.meta.url))
  const out: string[] = []
  const got = new Map<string, string>()
  const raws: boolean[] = []
  const t0 = performance.now()
  let typed = false
  const code = await new Promise<number>(resolve => {
    const timer = setTimeout(() => { out.push('TIMEOUT'); resolve(-3) }, 15000)
    worker.onmessage = (e: MessageEvent<OutMessage>) => {
      const m = e.data
      if (m.t === 'out') {
        out.push(dec.decode(m.d))
        // The first paint marks the editor as up; keys follow a moment later.
        if (!typed) {
          typed = true
          setTimeout(() => writer.write(enc.encode(keys)), 1500)
        }
      } else if (m.t === 'err') out.push('ERR ' + dec.decode(m.d))
      else if (m.t === 'file') got.set(m.path, dec.decode(m.d))
      else if (m.t === 'raw') raws.push(m.on)
      else if (m.t === 'exit') { clearTimeout(timer); resolve(m.code) }
      else if (m.t === 'fault') { out.push('FAULT ' + m.message); clearTimeout(timer); resolve(-1) }
    }
    worker.onerror = e => { out.push('WORKER ' + e.message); resolve(-2) }
    const msg: RunMessage = {
      wasm: wasm.slice(0),
      argv,
      env: ['PWD=/home/guest', 'HOME=/home/guest', 'TERM=xterm', 'LINES=24', 'COLUMNS=80'],
      ring,
      dirs: ['/home/guest'],
      files: files.map(f => ({ path: f.path, data: enc.encode(f.text).buffer as ArrayBuffer })),
      tty: { cols: 80, rows: 24 },
    }
    worker.postMessage(msg)
  })
  worker.terminate()
  return { code, out: out.join(''), files: got, raws, ms: performance.now() - t0 }
}

// The skel vimrc itself, so a line that needs a runtime file is caught here.
const vimrc = { path: '/home/guest/.vimrc', text: await Bun.file(new URL('../app/src/skel/home/.vimrc', import.meta.url)).text() }

{
  const r = await vim(['vim', 'a.txt'], 'ggOhello\x1b:wq\r', [vimrc, { path: '/home/guest/a.txt', text: 'one\ntwo\n' }])
  check('edit + :wq exits 0', r.code === 0, `code ${r.code} in ${r.ms.toFixed(0)}ms`)
  check('written file posted back', r.files.get('/home/guest/a.txt') === 'hello\none\ntwo\n', JSON.stringify(r.files.get('/home/guest/a.txt')))
  check('no stray files (swap, viminfo)', [...r.files.keys()].every(k => k === '/home/guest/a.txt'), [...r.files.keys()].join(','))
  check('raw on at start, off at exit', r.raws[0] === true && r.raws[r.raws.length - 1] === false, r.raws.join(','))
  check('alt screen entered and left', /\x1b\[\?(1049|47)h/.test(r.out) && /\x1b\[\?(1049|47)l/.test(r.out))
  check('cursor addressing formatted', /\x1b\[\d+;\d+H/.test(r.out))
  if (r.code !== 0) console.log(r.out.slice(0, 300).replace(/\x1b/g, '^['), '...', r.out.slice(-300).replace(/\x1b/g, '^['))
}
{
  const r = await vim(['vim', 'new.txt'], 'inew file\x1b:wq\r', [vimrc])
  check('new file created', r.files.get('/home/guest/new.txt') === 'new file\n', JSON.stringify(r.files.get('/home/guest/new.txt')))
}
{
  const r = await vim(['vim', 'a.txt'], ':q\r', [vimrc, { path: '/home/guest/a.txt', text: 'one\n' }])
  check(':q without changes writes nothing', r.code === 0 && r.files.size === 0, `code ${r.code}, ${r.files.size} files`)
}
{
  const r = await vim(['vim'], ':!ls\r:q!\r', [vimrc])
  check(':!cmd fails without hanging', r.code === 0, `code ${r.code}`)
  check(':!cmd reports', /fork|shell|E\d+/i.test(r.out), r.out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, ' ').slice(-200))
}

console.log(fail ? `\n${fail} FAILED` : '\nall ok')
process.exit(fail ? 1 : 0)
