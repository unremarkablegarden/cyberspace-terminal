import { configure, fs, InMemory } from '@zenfs/core'
import { mountPages } from '../apps/cyberspace/src/pagesfs.ts'
import { strerror } from '../packages/coreutils/src/util.ts'
const api = { pages: {
  listFiles: async () => [{ path: 'b.gif', size: 3 }, { path: 'index.html', size: 3 }],
  readText: async () => ({ content: 'abc' }),
  putFile: async () => { throw new Error('out of space — 5121KB of 5MB') },
  deleteFile: async () => { throw new Error('taken down by a moderator — frozen until reinstated') },
} } as any
await configure({ mounts: { '/': InMemory, '/home': InMemory } })
await fs.promises.mkdir('/home/guest'); await fs.promises.mkdir('/home/guest/public_html')
await mountPages(api, '/home/guest', () => true)
const P = '/home/guest/public_html'
const show = async (label: string, f: () => Promise<unknown>) => { try { await f(); console.log(label, '-> ok') } catch (e) { console.log(label, '->', strerror(e)) } }
await show('cat b.gif', () => fs.promises.readFile(`${P}/b.gif`))
await show('mv', () => fs.promises.rename(`${P}/index.html`, `${P}/x.html`))
await show('edit save', () => fs.promises.writeFile(`${P}/index.html`, 'new'))
await show('rm', () => fs.promises.unlink(`${P}/index.html`))
await show('edit bad.php', () => fs.promises.writeFile(`${P}/bad.php`, 'x'))
await show('cat missing', () => fs.promises.readFile(`${P}/nope.html`))
try { await fs.promises.unlink(`${P}/b.gif`) } catch (e: any) { console.log('raw rm:', JSON.stringify(e.message), e.code) }
