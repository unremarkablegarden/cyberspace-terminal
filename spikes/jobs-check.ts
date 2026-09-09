// Job control driven headless: the real shell over Kernel + Tty, a fake
// full-screen program that opts into stop/cont, and the real sleep and cat.
// Run: bun spikes/jobs-check.ts

import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { runOnTty } from '../packages/kernel/src/handoff.ts'
import type { Proc } from '../packages/kernel/src/proc.ts'
import { coreutils } from '../packages/coreutils/src/index.ts'
import { shellMain } from '../packages/shell/src/index.ts'

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/x', { recursive: true })

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

// A full-screen program: counts stop/cont, paints a frame on cont, reads keys.
const stops: number[] = []
const conts: number[] = []
const keys: string[] = []
/** argv seen by onArgs, with the cont count at the time. */
const args: { argv: string[]; conts: number }[] = []
let spawns = 0
let claimed: unknown = 'unset'
const tick = async (p: Proc): Promise<number> => {
  spawns++
  claimed = p.takeState()
  p.tty!.setRaw()
  p.out('\x1b[?1049h')
  // The first frame, painted before any await. A diffing renderer draws every
  // later frame against it, so it has to reach the terminal. See Jobs.start.
  p.tty!.paint('OPEN')
  p.setResume('tick')
  p.setState({ v: 1, n: spawns })
  p.onStop = () => { stops.push(p.pid) }
  p.onCont = () => { conts.push(p.pid); p.tty!.paint('FRAME') }
  p.onArgs = argv => { args.push({ argv, conts: conts.length }) }
  try {
    for (;;) {
      const c = await p.stdin.read()
      if (c === null) return 0
      const s = new TextDecoder().decode(c)
      keys.push(s)
      if (s === 'q') return 0
    }
  } finally {
    p.out('\x1b[?1049l')
    p.tty!.setCooked()
  }
}
// A parent that hands its tty to tick, for the nested stop.
const outer = async (p: Proc): Promise<number> => {
  p.tty!.setRaw()
  p.onStop = () => { stops.push(-p.pid) }
  return runOnTty(p, 'tick')
}

const kernel = new Kernel()
kernel.registerAll(coreutils)
kernel.register('tick', tick)
kernel.register('outer', outer)

let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 80, 24)
const env = { HOME: '/home/x', USER: 'guest', PATH: '/bin' }
const boot = () => kernel.spawn(shellMain, {
  argv: ['sh'], env, cwd: '/home/x', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty,
})
let shell = boot()
const settle = () => sleep(60)
const atPrompt = () => /\$ $/.test(strip(out))
const type = async (s: string) => { tty.input(s); await settle() }
const jobs = kernel.jobs

await settle()
ok('shell at a prompt', atPrompt())

// 1. ^Z stops a full-screen job.
{
  out = ''
  await type('tick\r')
  ok('tick is the foreground job', jobs.fg?.name === 'tick' && jobs.fg.state === 'fg')
  ok('alt screen up', tty.alt)
  ok('first frame reached the screen', out.includes('OPEN'), JSON.stringify(strip(out)))
  await type('\x1a')
  ok('alt screen left', !tty.alt && out.includes('\x1b[?1049l'))
  ok('Stopped line', strip(out).includes('[1]+ Stopped  tick'), JSON.stringify(strip(out)))
  ok('prompt back', atPrompt())
  ok('onStop once', stops.length === 1)
  ok('no foreground job', jobs.fg === null && jobs.list()[0]?.state === 'stopped')
}

// 2. Keys go to the shell, not the stopped job; fg brings it back.
{
  keys.length = 0
  await type('echo hi\r')
  ok('shell ran echo', strip(out).includes('\nhi'), JSON.stringify(strip(out)))
  ok('stopped job saw no keys', keys.length === 0)
  out = ''
  await type('fg\r')
  ok('alt screen re-entered', tty.alt && out.includes('\x1b[?1049h'))
  ok('onCont once, frame painted', conts.length === 1 && out.includes('FRAME'))
  await type('x')
  ok('keys reach the job again', keys.join('') === 'x')
}

// 3. One job per name: the name foregrounds the stopped job.
{
  await type('\x1a')
  ok('stopped again', jobs.fg === null && stops.length === 2)
  await type('tick extra\r')
  ok('same job, no second spawn', spawns === 1 && jobs.fg?.name === 'tick' && conts.length === 2)
  ok('onArgs saw the arguments, before onCont', args.length === 1 && args[0]!.argv.join(' ') === 'tick extra' && args[0]!.conts === 1, JSON.stringify(args))
  await type('q')
  ok('q exits it, table empty', jobs.list().length === 0 && atPrompt())
}

// 4. Generic freeze: sleep finishes stopped, cat holds its output.
{
  out = ''
  await type('sleep 0.2\r')
  await type('\x1a')
  ok('sleep stopped', strip(out).includes('Stopped  sleep 0.2'))
  await sleep(300)
  out = ''
  await type('\r')
  ok('Done notice at the next prompt', strip(out).includes('[1]  Done  sleep 0.2'), JSON.stringify(strip(out)))
  ok('table empty', jobs.list().length === 0)

  await type('cat\r')
  await type('\x1a')
  const job = jobs.list()[0]!
  ok('cat stopped', job.name === 'cat' && job.state === 'stopped')
  // Output written to a stopped job's terminal is held.
  job.tty.stdout.write('held\n')
  ok('held while stopped', !out.includes('held'))
  out = ''
  await type('fg\r')
  ok('flushed on fg', out.includes('held'))
  await type('\x04')
  await settle()
  ok('cat exits on ^D', jobs.list().length === 0 && atPrompt())
}

// 5. A host switch while the shell sits in readline keeps the half-typed line.
{
  await type('tick\r')
  await type('\x1a')
  const job = jobs.list()[0]!
  await type('ec')
  out = ''
  await jobs.switchTo(job)
  await settle()
  ok('switchTo foregrounds the job', jobs.fg === job && tty.alt)
  ok('request consumed', jobs.take() === null)
  await jobs.switchTo('shell')
  await settle()
  ok('back to the shell with a Stopped line', jobs.fg === null && strip(out).includes('Stopped  tick'))
  ok('half-typed line kept', /\$ ec$/.test(strip(out)), JSON.stringify(strip(out).slice(-20)))
  await type('ho ok\r')
  ok('and it runs', strip(out).includes('\nok'))
}

// 6. A launch from the host reads like a typed command.
{
  out = ''
  await jobs.switchTo({ launch: 'echo launched' })
  await settle()
  ok('launch echoed and ran', strip(out).includes('echo launched') && strip(out).includes('\nlaunched'))
}

// 6b. A launch while a job holds the terminal: stop, prompt, the line, the run.
{
  await type('tick\r')
  out = ''
  await jobs.switchTo({ launch: 'echo bg' })
  await settle()
  const s = strip(out)
  ok('stopped, prompted, echoed, ran', /Stopped  tick\r\n[^\n]*\$ echo bg\r\nbg\r\n/.test(s), JSON.stringify(s))
  ok('tick still stopped for the next test', jobs.list()[0]?.state === 'stopped')
}

// 7. Park and restore: a parked job spawns lazily with its state.
{
  const parked = jobs.park()
  ok('parked table has tick with state', parked.jobs.length === 1 && parked.jobs[0].line === 'tick' && (parked.jobs[0].state as { n: number }).n === 2 && parked.fg === null, JSON.stringify(parked))
  jobs.killAll()
  await settle()
  ok('killAll leaves a notice', jobs.list().length === 0)
  shell.kill()
  await shell.wait
  // A fresh shell over a restored table.
  const k2 = kernel
  // Arguments for a parked job replace its line and keep its state.
  k2.jobs.restore([{ name: 'tick', line: 'tick', state: { v: 1, n: 7 } }], null)
  {
    const job = k2.jobs.list()[0]!
    k2.jobs.args(job, ['tick', 'later'])
    ok('parked job takes the new line with its state', job.line === 'tick later' && (job.resume.parked as { n: number }).n === 7, JSON.stringify([job.line, job.resume.parked]))
    k2.jobs.remove(job)
    k2.jobs.takeNotes()
  }
  k2.jobs.restore(parked.jobs, 0)
  spawns = 0
  out = ''
  shell = boot()
  await settle()
  ok('restored job foregrounded on start', spawns === 1 && jobs.fg?.name === 'tick' && tty.alt)
  ok('state claimed once', JSON.stringify(claimed) === '{"v":1,"n":2}', JSON.stringify(claimed))
  await type('\x1a')
  ok('stopped, parked with the new state', jobs.park().jobs[0]?.line === 'tick')
}

// 8. exit with a stopped job is refused once; plain exit works.
{
  out = ''
  await type('exit\r')
  ok('refused', strip(out).includes('There are stopped jobs.'))
  await type('exit\r')
  const code = await shell.wait
  ok('second exit goes through and kills the job', code === 0 && jobs.list().length === 0)
  shell = boot()
  await settle()
  await type('exit 3\r')
  ok('exit 3 returns 3', (await shell.wait) === 3)
}

// 9. A stop reaches a child run on the parent's terminal.
{
  stops.length = 0
  shell = boot()
  await settle()
  await type('outer\r')
  ok('outer with tick as its child', jobs.fg?.name === 'outer' && spawns === 2)
  await type('\x1a')
  ok('child stopped before the parent', stops.length === 2 && stops[0]! > 0 && stops[1]! < 0, JSON.stringify(stops))
  await type('fg\r')
  await type('q')
  await settle()
  ok('child exits, outer exits', jobs.list().length === 0 && atPrompt())
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
