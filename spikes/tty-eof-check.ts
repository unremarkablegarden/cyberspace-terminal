// ^D at the tty: EOF in cooked mode, a key in raw mode.
// Run: bun spikes/tty-eof-check.ts

import { Tty } from '../packages/kernel/src/tty.ts'

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dec = new TextDecoder()

const make = () => {
  let out = ''
  const tty = new Tty(d => { out += dec.decode(d) }, 80, 24)
  return { tty, out: () => out }
}

// --- cooked: termios rules ---------------------------------------------------
{
  const { tty } = make()
  const read = tty.stdin.read()
  tty.input('\x04')
  ok('cooked ^D at an empty line reads EOF', (await read) === null)
}

{
  const { tty } = make()
  const read = tty.stdin.read()
  tty.input('ab\x04')
  // ^D mid-line is swallowed; the line arrives only on Enter.
  tty.input('\r')
  ok('cooked ^D mid-line is swallowed', dec.decode((await read)!) === 'ab\n')
}

// --- raw: the program decides ------------------------------------------------
{
  const { tty } = make()
  tty.setRaw()
  const first = tty.stdin.read()
  tty.input('\x04')
  const got = await first
  ok('raw ^D arrives as a byte', got !== null && got.length === 1 && got[0] === 4,
    got === null ? 'EOF' : String(got))

  // The reader is still open: the next key arrives normally.
  const second = tty.stdin.read()
  tty.input('x')
  ok('the reader keeps reading after ^D', dec.decode((await second)!) === 'x')
}

// --- a job view carries its own mode ------------------------------------------
{
  const { tty } = make()
  const job = tty.view()
  tty.foreground(job)
  job.setRaw()
  const read = job.stdin.read()
  tty.input('\x04')
  const got = await read
  ok('a raw job view sees the byte', got !== null && got.length === 1 && got[0] === 4)

  job.setCooked()
  const eof = job.stdin.read()
  tty.input('\x04')
  await sleep(10)
  ok('the same view EOFs once cooked', (await eof) === null)
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
