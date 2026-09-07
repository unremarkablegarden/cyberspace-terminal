// Headless check of the export builtin: assignment, marking a name before it
// has a value, the bare listing, unset, and the one-shot prefix form.
import { configure, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { coreutils } from '../packages/coreutils/src/index.ts'
import { runLine, type ShellState } from '../packages/shell/src/run.ts'

await configure({ mounts: { '/': InMemory } })
const HOME = '/home/guest'
const kernel = new Kernel()
kernel.registerAll(coreutils)
await kernel.seed()

let out = ''
const env = { USER: 'guest', HOME, PATH: '/bin', COLUMNS: '80', LINES: '25' }
const sh: ShellState = {
  proc: {
    argv: ['sh'], env, cwd: HOME, kernel,
    stdin: { read: async () => null },
    stdout: { write: (s: string) => { out += s }, end() {} },
    stderr: { write: (s: string) => { out += s }, end() {} },
    out: (s: string) => { out += s },
    err: (s: string) => { out += s },
  } as never,
  vars: {},
  exported: new Set(Object.keys(env)),
  status: 0,
}

let bad = 0
const ok = (name: string, cond: boolean) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`) }
const run = async (line: string) => { out = ''; await runLine(sh, line); return out }

ok('export FOO=bar reaches a child', (await run('export FOO=bar; env')).includes('FOO=bar'))
ok('$FOO expands', (await run('echo $FOO')).trim() === 'bar')

await run('export BAZ')
ok('a marked name with no value is not in the environment', !(await run('env')).includes('BAZ='))
await run('BAZ=1')
ok('assignment after the mark reaches a child', (await run('env')).includes('BAZ=1'))

await run('QUX=2')
ok('an unmarked assignment stays out of the environment', !(await run('env')).includes('QUX=2'))
ok('an unmarked variable still expands', (await run('echo $QUX')).trim() === '2')
await run('export QUX')
ok('exporting an existing variable publishes it', (await run('env')).includes('QUX=2'))

const list = await run('export')
ok('bare export lists exported names', list.includes('export FOO="bar"') && list.includes('export HOME="/home/guest"'))
ok('bare export sorts', list.indexOf('export BAZ') < list.indexOf('export FOO'))
ok('export -p lists the same', (await run('export -p')) === list)
ok('a value with a quote is escaped', (await run(String.raw`export Q=a\"b` + '; export')).includes('export Q="a\\"b"'))

await run('unset FOO')
ok('unset clears the variable', (await run('echo $FOO')).trim() === '')
ok('unset clears the environment', !(await run('env')).includes('FOO=bar'))
await run('FOO=again')
ok('unset clears the export mark', !(await run('env')).includes('FOO=again'))

ok('a prefix assignment reaches only that command', (await run('PRE=1 env')).includes('PRE=1'))
ok('a prefix assignment is one-shot', !(await run('env')).includes('PRE=1'))

console.log(bad ? `${bad} failed` : 'all ok')
process.exitCode = bad ? 1 : 0
