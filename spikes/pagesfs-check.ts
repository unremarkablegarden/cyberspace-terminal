// Headless check of PagesFS through the ZenFS vfs: one PUT per save, lazy
// text read, binary refusal, revert on failure, delete, rename refused.
import { configure, fs, InMemory } from '@zenfs/core'
import { mountPages, umountPages } from '../apps/cyberspace/src/pagesfs.ts'

const calls: string[] = []
let failNext = false
let siteExists = true
const store = new Map<string, Uint8Array>([
  ['index.html', new TextEncoder().encode('<h1>hi</h1>')],
  ['b.gif', new Uint8Array(10)],
])
const api = {
  pages: {
    listFiles: async () => [...store].map(([path, b]) => ({ path, size: b.length, lastModified: '', url: '' })),
    readText: async (path: string) => { calls.push('GET ' + path); return { path, content: new TextDecoder().decode(store.get(path)) } },
    createSite: async () => { calls.push('CREATE'); siteExists = true; return { url: '', hasIndex: true } },
    putFile: async (path: string, bytes: Uint8Array) => {
      calls.push(`PUT ${path} ${bytes.length}`)
      if (!siteExists) { const e: any = new Error('no site — mkdir ~/public_html'); e.status = 404; throw e }
      if (failNext) { failNext = false; throw new Error('out of space — 5121KB of 5MB') }
      store.set(path, bytes); return { path, size: bytes.length, url: '' }
    },
    deleteFile: async (path: string) => { calls.push('DELETE ' + path); store.delete(path) },
  },
} as any

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/guest')
await fs.promises.mkdir('/home/guest/public_html')
await fs.promises.writeFile('/home/guest/public_html/mine.txt', 'local')
await mountPages(api, '/home/guest', () => true)
const P = '/home/guest/public_html'
const ok = (c: boolean, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1 }

ok((await fs.promises.readdir('/home/guest')).includes('public_html'), 'ls ~ shows public_html')
const ls = await fs.promises.readdir(P)
ok(ls.includes('index.html') && ls.includes('b.gif') && ls.includes('mine.txt'), 'listing + local file: ' + ls.join())
ok((await fs.promises.readFile(`${P}/mine.txt`, 'utf8')) === 'local' && calls.length === 0, 'adopted file reads locally')
ok((await fs.promises.stat(`${P}/b.gif`)).size === 10, 'binary size from listing')

const text = await fs.promises.readFile(`${P}/index.html`, 'utf8')
ok(text === '<h1>hi</h1>' && calls.join() === 'GET index.html', 'lazy text fetch, once')
await fs.promises.readFile(`${P}/index.html`, 'utf8')
ok(calls.length === 1, 'second read is local')

let err = ''
await fs.promises.readFile(`${P}/b.gif`).catch(e => (err = e.message))
ok(/binary/.test(err), 'binary read refused: ' + err)

calls.length = 0
await fs.promises.writeFile(`${P}/index.html`, '<h1>new</h1>')
ok(calls.join() === 'PUT index.html 12', 'one PUT per save: ' + calls.join())
ok(new TextDecoder().decode(store.get('index.html')) === '<h1>new</h1>', 'server has new bytes')

calls.length = 0
await fs.promises.writeFile(`${P}/index.html`, '')
ok(calls.join() === 'PUT index.html 0', 'empty write still PUTs: ' + calls.join())

calls.length = 0
await fs.promises.mkdir(`${P}/about`)
await fs.promises.writeFile(`${P}/about/index.html`, 'x')
ok(calls.join() === 'PUT about/index.html 1', 'nested new file: ' + calls.join())

calls.length = 0
failNext = true
err = ''
await fs.promises.writeFile(`${P}/about/index.html`, 'yy').catch(e => (err = e.message))
ok(/out of space/.test(err), 'API error reaches the writer: ' + err)
ok((await fs.promises.readFile(`${P}/about/index.html`, 'utf8')) === 'yy', 'local keeps the refused bytes')
calls.length = 0
await fs.promises.writeFile(`${P}/about/index.html`, 'yy').catch(e => console.log('second save threw', e.message))
ok(calls.join() === 'PUT about/index.html 2' && store.has('about/index.html'), 'next save resends: ' + calls.join())

err = ''
await fs.promises.writeFile(`${P}/bad.php`, 'zz').catch(e => (err = e.message))
ok(/bad path/.test(err) && !(await fs.promises.readdir(P)).includes('bad.php'), 'disallowed extension refused: ' + err)

calls.length = 0
await fs.promises.writeFile(`${P}/local.txt`, 'a')
await fs.promises.unlink(`${P}/local.txt`)
ok(calls.join() === 'PUT local.txt 1,DELETE local.txt', 'saved then deleted: ' + calls.join())

siteExists = false
calls.length = 0
await fs.promises.writeFile(`${P}/first.txt`, 'f')
ok(calls.join() === 'PUT first.txt 1,CREATE,PUT first.txt 1', 'first save creates the site: ' + calls.join())
calls.length = 0
await fs.promises.writeFile(`${P}/index.html`, '<i>mine</i>')
ok(calls.join() === 'PUT index.html 11' && new TextDecoder().decode(store.get('index.html')) === '<i>mine</i>', 'index.html save keeps the bytes: ' + calls.join())

calls.length = 0
await fs.promises.writeFile(`${P}/index.html`, '')
await fs.promises.readFile(`${P}/index.html`)
ok(calls.join() === 'PUT index.html 0', 'emptying an unfetched file sends and stops fetching: ' + calls.join())

calls.length = 0
await fs.promises.unlink(`${P}/b.gif`)
ok(calls.join() === 'DELETE b.gif' && !store.has('b.gif'), 'unlink forwards DELETE')

err = ''
await fs.promises.rename(`${P}/index.html`, `${P}/old.html`).catch(e => (err = e.message + '|' + e.code))
ok(/not supported/.test(err) && /EPERM/.test(err), 'rename refused: ' + err)

umountPages('/home/guest')
ok((await fs.promises.readdir(P)).join() === 'mine.txt', 'umount leaves the directory as it was')
