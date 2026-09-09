// ctx.run through the compat host: a program in screen mode hands the terminal
// to another program and gets its screen back; the broker's allowlist refuses
// the rest. Run: bun spikes/compat-run-check.ts

import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { runOnTty, allowedHandoff } from '../packages/kernel/src/handoff.ts'
import { runGridProgram } from '../packages/compat/src/host.ts'

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

const kernel = new Kernel()
let childArgv: string[] = []
kernel.register('cmail', async p => { childArgv = p.argv; p.out('MAILBOX\n'); return 7 })

let out = ''
const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 40, 12)
// The broker's side, as spawn.ts serves it: allowlist, then the kernel helper.
const broker = (p: any) => (name: string, argv: string[]) => {
  if (!allowedHandoff(name)) return Promise.reject(new Error('NO CARRIER'))
  return runOnTty(p, name, argv)
}
const seen: Record<string, unknown> = {}
const program = {
  async run(ctx: any) {
    ctx.pushScreen({ draw() {} })
    ctx.term.text(0, 0, 'GLOBE SCREEN')
    await ctx.sleep(60)
    seen.code = await ctx.run('cmail', ['@bob'])
    await ctx.sleep(60)
    try { await ctx.run('rm', ['-rf', '/']) } catch (e) { seen.refused = (e as Error).message }
    ctx.popScreen()
  },
}
const task = kernel.spawn((p: any) => runGridProgram({ run: broker(p) })(p, program), {
  argv: ['prog'], env: {}, cwd: '/', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty,
})
const code = await task.wait
ok('program exits 0', code === 0, `exit=${code}`)
ok('child exit code returned', seen.code === 7, `${seen.code}`)
ok('child got name and argv', childArgv.join(' ') === 'cmail @bob', childArgv.join(' '))
const leave = out.indexOf('\x1b[?1049l'), mail = out.indexOf('MAILBOX'), back = out.indexOf('\x1b[?1049h', leave)
ok('screen left before the child printed, re-entered after', leave >= 0 && mail > leave && back > mail, `${leave} ${mail} ${back}`)
ok('screen repainted after', out.lastIndexOf('GLOBE SCREEN') > back)
ok('names off the list are refused', seen.refused === 'NO CARRIER', `${seen.refused}`)
ok('rm never ran', !/rm:/.test(out))
console.log(fail ? `\n${fail} FAILED` : '\nall ok')
process.exit(fail ? 1 : 0)
