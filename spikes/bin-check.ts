// Headless check of ~/bin: the manual and examples land, a second boot rewrites
// nothing, an edited doc comes back, and a file of the operator's own survives.
import { configure, fs, InMemory } from '@zenfs/core'
import { readdirSync, readFileSync } from 'node:fs'

// writeBin rather than installBin: index.ts holds the build-time glob, which
// only exists under vite, so the spike reads the same directories itself.
import { writeBin } from '../app/src/bin/write.ts'

const load = (dir: string) => Object.fromEntries(
  readdirSync(`app/src/bin/${dir}`).map(n => [n, readFileSync(`app/src/bin/${dir}/${n}`, 'utf8')]),
)
const DOC = load('doc')
const EXAMPLES = load('examples')
const installBin = (home: string) => writeBin(home, DOC, EXAMPLES)
const EXAMPLE_NAMES = Object.keys(EXAMPLES).map(n => n.replace(/\.js$/, '')).sort()

await configure({ mounts: { '/': InMemory } })
const HOME = '/home/guest'
await fs.promises.mkdir('/home')
await fs.promises.mkdir(HOME)

let bad = 0
const ok = (name: string, cond: boolean) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`) }

await installBin(HOME)
const docs = await fs.promises.readdir(`${HOME}/bin`)
ok('the three manual pages land', ['README.txt', 'API.txt', 'NETWORK.txt'].every(f => docs.includes(f)))
const examples = await fs.promises.readdir(`${HOME}/bin/examples`)
ok('six examples, extensionless', examples.length === 6 && !examples.some(n => n.endsWith('.js')))
ok('EXAMPLE_NAMES matches what landed', EXAMPLE_NAMES.join() === [...examples].sort().join())
ok('an example is executable', ((await fs.promises.stat(`${HOME}/bin/examples/clock`)).mode & 0o111) !== 0)

const readme = `${HOME}/bin/README.txt`
const before = (await fs.promises.stat(readme)).mtimeMs
await new Promise(r => setTimeout(r, 20))
await installBin(HOME)
ok('a second boot rewrites nothing', (await fs.promises.stat(readme)).mtimeMs === before)

await fs.promises.writeFile(readme, 'scribble')
await fs.promises.writeFile(`${HOME}/bin/mine`, 'export default () => 0')
await installBin(HOME)
ok('an edited manual page is restored', (await fs.promises.readFile(readme, 'utf8')).startsWith('CYBER/OS'))
ok("the operator's own program survives", await fs.promises.readFile(`${HOME}/bin/mine`, 'utf8') === 'export default () => 0')

const api = await fs.promises.readFile(`${HOME}/bin/API.txt`, 'utf8')
ok('the manual names both program shapes', api.includes('A WEB PROGRAM') && api.includes('A PROGRAM FOR THIS MACHINE'))
ok('and the wasm contract', api.includes('wasm32-wasi'))
process.exit(bad ? 1 : 0)
