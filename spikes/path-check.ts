// Headless check of ~/bin on PATH: a program there runs by name and by path,
// a builtin of the same name is not shadowed, and which(1) finds it.
import { configure, fs, InMemory } from '@zenfs/core'
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { coreutils } from '../packages/coreutils/src/index.ts'

await configure({ mounts: { '/': InMemory } })
const HOME = '/home/guest'
const ENV = { USER: 'guest', HOME, PATH: `${HOME}/bin:/bin`, COLUMNS: '80', LINES: '25' }

const kernel = new Kernel()
kernel.registerAll(coreutils)
await kernel.seed()
await fs.promises.mkdir(HOME, { recursive: true })
await fs.promises.mkdir(`${HOME}/bin`)
await fs.promises.writeFile(`${HOME}/bin/mine`, 'MINE', { mode: 0o755 })
await fs.promises.writeFile(`${HOME}/bin/ls`, 'IMPOSTOR', { mode: 0o755 })

// The file handler stands in for the compat host: it reports what it was given.
let ran: string | null = null
kernel.fileHandlers.push((path, data) => {
  const text = new TextDecoder().decode(data)
  return text === 'MINE' || text === 'IMPOSTOR' ? () => { ran = `${path}:${text}`; return 0 } : null
})

let bad = 0
const ok = (name: string, cond: boolean) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`) }

const run = async (word: string, cwd = HOME) => {
  ran = null
  const prog = await kernel.resolveExec(word, cwd, ENV)
  if (prog) await prog({ argv: [word], env: ENV, cwd, kernel, out() {}, err() {} } as never)
  return ran
}

ok('a bare name resolves through ~/bin', await run('mine') === `${HOME}/bin/mine:MINE`)
ok('./mine resolves from inside ~/bin', await run('./mine', `${HOME}/bin`) === `${HOME}/bin/mine:MINE`)
ok('an absolute path resolves', await run(`${HOME}/bin/mine`) === `${HOME}/bin/mine:MINE`)
ok('an unknown word resolves to nothing', await kernel.resolveExec('nope', HOME, ENV) === null)

// ls is a builtin, so the file of that name in ~/bin must not run.
ok('a builtin is not shadowed by ~/bin', await run('ls') === null)
ok('and the file is still reachable by path', await run('./ls', `${HOME}/bin`) === `${HOME}/bin/ls:IMPOSTOR`)

const which = await kernel.resolveProgram('which')!
let out = ''
await which({ argv: ['which', 'mine'], env: ENV, cwd: HOME, kernel,
  out: (s: string) => { out += s }, err() {} } as never)
ok('which finds it on PATH', out.trim() === `${HOME}/bin/mine`)

process.exit(bad ? 1 : 0)
