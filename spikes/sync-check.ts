// Headless check of home sync: every row of the merge table through
// reconcile(), then whole runs over a ZenFS mount against a fake server —
// first push, second run a no-op, a pull on a second device, a conflict, a
// deletion that stays deleted, a skel revival, an interrupted run, a refused
// path, and the key flows at login.
import { configure, fs, InMemory } from '@zenfs/core'
import { reconcile, sync, readBase, writeBase, syncedPaths, unlockHome, rewrapHome, resetHome, HomeUnreadable, type Base, type Remote } from '../apps/cyberspace/src/homesync.ts'
import { HomeKey } from '../apps/cyberspace/src/homekey.ts'
import { sha256 } from '../apps/cyberspace/src/hash.ts'
import { ApiError, type HomeEntry, type HomeManifest } from '../apps/cyberspace/src/api.ts'

const ok = (c: boolean, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1 }
const enc = new TextEncoder()
const dec = new TextDecoder()

// --- the table ------------------------------------------------------------------

const base = (files: Record<string, string> = {}): Base => ({ rev: 1, files: new Map(Object.entries(files)), dead: new Map() })
const remote = (files: Record<string, string> = {}, dead: Record<string, string> = {}): Remote => ({
  rev: 1,
  files: new Map(Object.entries(files).map(([p, h]) => [p, { hash: h, blob: 'b' + h, entry: { size: 0, e: '' } }])),
  dead: new Map(Object.entries(dead).map(([p, h]) => [p, { hash: h, at: 0, entry: { size: 0, e: '' } }])),
})
const local = (files: Record<string, string> = {}) => new Map(Object.entries(files))
const row = (name: string, l: Record<string, string>, b: Record<string, string>, r: Record<string, string>, d: Record<string, string>, want: Partial<Record<keyof ReturnType<typeof reconcile>, string[]>>) => {
  const plan = reconcile(local(l), base(b), remote(r, d))
  const got = Object.fromEntries(Object.entries(plan).filter(([, v]) => v.length))
  const w = Object.fromEntries(Object.entries(want).filter(([, v]) => v!.length))
  ok(JSON.stringify(got) === JSON.stringify(w), `table ${name}: ${JSON.stringify(got)}`)
}
const x = { x: 'a' }
row('a a a', x, x, x, {}, {})
row('b a a', { x: 'b' }, x, x, {}, { push: ['x'] })
row('a a b', x, x, { x: 'b' }, {}, { pull: ['x'] })
row('b a b', { x: 'b' }, x, { x: 'b' }, {}, {})
row('b a c', { x: 'b' }, x, { x: 'c' }, {}, { conflict: ['x'] })
row('a ∅ ∅', x, {}, {}, {}, { push: ['x'] })
row('∅ ∅ a', {}, {}, x, {}, { pull: ['x'] })
row('a ∅ a', x, {}, x, {}, {})
row('a ∅ b', x, {}, { x: 'b' }, {}, { conflict: ['x'] })
row('∅ a a', {}, x, x, {}, { tombstone: ['x'] })
row('a a T', x, x, {}, x, { delete: ['x'] })
row('a a ∅', x, x, {}, {}, { delete: ['x'] })
row('∅ a T', {}, x, {}, x, {})
row('∅ a b', {}, x, { x: 'b' }, {}, { pull: ['x'], restore: ['x'] })
row('b a T', { x: 'b' }, x, {}, x, { push: ['x'], restore: ['x'] })
row('a ∅ T(a)', x, {}, {}, x, { delete: ['x'] })
row('a ∅ T(h)', x, {}, {}, { x: 'h' }, { push: ['x'] })
row('∅ ∅ T', {}, {}, {}, x, {})

// --- a fake server ------------------------------------------------------------------

const blobs = new Map<string, Uint8Array>()
let doc: { rev: number; key: HomeManifest['key']; files: HomeEntry[] } = { rev: 0, key: null, files: [] }
const calls: string[] = []
let failCommits = 0
const api = {
  authed: true,
  supporter: true,
  username: 'asdf22',
  home: {
    manifest: async (): Promise<HomeManifest> => ({ ...doc, usage: { bytes: 0, files: 0 } }),
    readBlob: async (hash: string) => { calls.push('GET ' + hash.slice(0, 6)); const b = blobs.get(hash); if (!b) throw new ApiError('NOT_FOUND', 'no such blob', 404); return b },
    putBlob: async (hash: string, bytes: Uint8Array) => {
      calls.push('PUT ' + hash.slice(0, 6))
      if (await sha256(bytes) !== hash) throw new ApiError('VALIDATION_ERROR', 'hash mismatch', 400)
      blobs.set(hash, bytes)
      return { hash, size: bytes.length }
    },
    commit: async (base: number, files: HomeEntry[], key?: HomeManifest['key']) => {
      calls.push('COMMIT')
      if (failCommits > 0) { failCommits--; throw new ApiError('CONFLICT', 'out of date', 409) }
      if (base !== doc.rev) throw new ApiError('CONFLICT', 'out of date', 409)
      for (const f of files) if (!f.deleted && !blobs.has(f.blob!)) throw new ApiError('VALIDATION_ERROR', 'unknown hash', 400)
      doc = { rev: doc.rev + 1, key: key ?? doc.key, files }
      return { ...doc, usage: { bytes: 0, files: 0 } }
    },
  },
} as any

const keyStore = (): { get(): string | null; set(v: string | null): void } => { let v: string | null = null; return { get: () => v, set: n => { v = n } } }

// --- two devices --------------------------------------------------------------------

await configure({ mounts: { '/': InMemory, '/home': InMemory } })
const A = '/home/a', B = '/home/b'
for (const h of [A, B]) {
  await fs.promises.mkdir(h, { recursive: true })
  await fs.promises.mkdir(`${h}/bin/docs`, { recursive: true })
  await fs.promises.writeFile(`${h}/bin/docs/manual.txt`, 'manual')
  await fs.promises.writeFile(`${h}/README.txt`, 'welcome')
  await fs.promises.writeFile(`${h}/.profile`, 'export X=1')
  await fs.promises.writeFile(`${h}/.sh_history`, 'ls')
}
await fs.promises.mkdir(`${A}/notes`)
await fs.promises.writeFile(`${A}/notes/todo.txt`, 'one')
await fs.promises.writeFile(`${A}/bad name.txt`, 'x')
const read = (p: string) => fs.promises.readFile(p, 'utf8').catch(() => null)
const lines = (r: { lines: { verb: string; path: string; note?: string }[] }) => r.lines.map(l => `${l.verb} ${l.path}${l.note ? ' ' + l.note : ''}`).sort()

// Login on A: no key on the server yet.
const ka = new HomeKey(keyStore())
ok(await unlockHome(api, ka, 'hunter2') === 'ok' && doc.key !== null && doc.rev === 1, 'first login creates and commits the wrap')

let r = await sync(api, ka, A)
ok(lines(r).join() === ['sent .profile', 'sent README.txt', 'sent notes/todo.txt', 'skipped bad name.txt bad path'].sort().join(), 'first run pushes: ' + lines(r).join(' | '))
ok(doc.files.length === 3 && doc.files.every(f => f.blob && f.e && !f.e.includes('todo')), 'manifest holds 3 opaque entries')
ok(!blobs.has(await sha256(enc.encode('one'))) && [...blobs.values()].every(b => !dec.decode(b).includes('one')), 'blobs are ciphertext')
const baseA = await readBase(A)
ok(baseA.rev === 2 && baseA.files.size === 3 && !baseA.files.has('bad name.txt') && !baseA.files.has('.sh_history'), '.sync written: rev 2, 3 files, excluded and refused absent')
ok((await read(`${A}/.sync`))!.startsWith('rev 2\n'), '.sync is readable text')

calls.length = 0
r = await sync(api, ka, A)
ok(lines(r).join() === 'skipped bad name.txt bad path' && calls.length === 0, 'second run: no traffic but the manifest read')
await fs.promises.unlink(`${A}/bad name.txt`)

// Login on B with the password: unwraps the same key.
const kb = new HomeKey(keyStore())
ok(await unlockHome(api, kb, 'hunter2') === 'ok' && kb.present, 'second device unwraps with the password')
ok(await unlockHome(api, new HomeKey(keyStore()), 'wrong') === 'previous', 'wrong password on a fresh device: previous')

r = await sync(api, kb, B)
ok(lines(r).join() === ['received notes/todo.txt'].join(), 'B pulls what it lacks: ' + lines(r).join(' | '))
ok(await read(`${B}/notes/todo.txt`) === 'one', 'pulled bytes decrypt')

// Conflict: both edit todo.txt.
await fs.promises.writeFile(`${A}/notes/todo.txt`, 'A version')
await fs.promises.writeFile(`${B}/notes/todo.txt`, 'B version')
await sync(api, ka, A)
r = await sync(api, kb, B)
ok(lines(r).join() === 'conflict notes/todo.txt notes/todo.txt.1', 'conflict on B: ' + lines(r).join(' | '))
ok(await read(`${B}/notes/todo.txt`) === 'B version' && await read(`${B}/notes/todo.txt.1`) === 'A version', 'B keeps its own, the copy holds A')
r = await sync(api, ka, A)
ok(lines(r).join() === ['received notes/todo.txt', 'received notes/todo.txt.1'].join(), 'A receives both: ' + lines(r).join(' | '))
ok(await read(`${A}/notes/todo.txt`) === 'B version' && await read(`${A}/notes/todo.txt.1`) === 'A version', 'A now matches B')

// Deletion that stays deleted, across a skel reinstall.
await fs.promises.unlink(`${A}/README.txt`)
r = await sync(api, ka, A)
ok(lines(r).join() === 'deleted README.txt' && doc.files.some(f => f.deleted), 'A pushes a tombstone')
ok((await syncedPaths(A)).has('README.txt'), 'A .sync lists the dead path, so skel skips it')
r = await sync(api, kb, B)
ok(lines(r).join() === 'deleted README.txt' && await read(`${B}/README.txt`) === null, 'B deletes')
await fs.promises.writeFile(`${B}/README.txt`, 'welcome')   // a skel reinstall on a device with no .sync would do this
const baseB = await readBase(B); baseB.files.delete('README.txt'); baseB.dead.delete('README.txt'); await writeBase(B, baseB)
r = await sync(api, kb, B)
ok(lines(r).join() === 'deleted README.txt' && await read(`${B}/README.txt`) === null, 'a byte-identical revival is deleted again')
await fs.promises.writeFile(`${B}/README.txt`, 'my own readme')
r = await sync(api, kb, B)
ok(lines(r).join() === 'sent README.txt', 'a different file under the dead name pushes')

// Edit here, delete there: restored.
await fs.promises.writeFile(`${A}/README.txt`, 'my own readme')   // pull it first
await sync(api, ka, A)
await fs.promises.unlink(`${B}/README.txt`)
await sync(api, kb, B)
await fs.promises.writeFile(`${A}/README.txt`, 'edited after')
r = await sync(api, ka, A)
ok(lines(r).join() === 'restored README.txt', 'edit beats delete: ' + lines(r).join(' | '))

// Interrupted run: a commit that lands but no .sync written -> next run agrees, no traffic.
await fs.promises.writeFile(`${A}/notes/new.txt`, 'fresh')
const before = await read(`${A}/.sync`)
await sync(api, ka, A)
await fs.promises.writeFile(`${A}/.sync`, before!)
calls.length = 0
r = await sync(api, ka, A)
ok(!calls.includes('COMMIT') && !calls.some(c => c.startsWith('PUT')) && lines(r).join() === '', 'stale base after a landed commit: silent agreement')

// A commit race: 409 twice, third attempt lands.
await fs.promises.writeFile(`${A}/notes/race.txt`, 'r')
failCommits = 2
calls.length = 0
r = await sync(api, ka, A)
ok(calls.filter(c => c === 'COMMIT').length === 3 && lines(r).join() === 'sent notes/race.txt', '409 re-runs and lands on the third commit: ' + calls.join() + ' / ' + lines(r).join(' | '))

// A directory in the way of a pull is skipped, not fatal, and not recorded as base.
await fs.promises.writeFile(`${B}/blocker`, 'file on B')
await sync(api, kb, B)
await fs.promises.mkdir(`${A}/blocker`)
r = await sync(api, ka, A)
ok(lines(r).some(l => l.startsWith('skipped blocker')) && !(await readBase(A)).files.has('blocker'), 'pull blocked by a directory: skipped, kept out of base: ' + lines(r).join(' | '))

// Password change: cached key rewraps silently; a fresh device needs the previous password.
ok(await unlockHome(api, ka, 'newpass') === 'ok', 'cached key: new password rewraps')
const kc = new HomeKey(keyStore())
ok(await unlockHome(api, kc, 'newpass') === 'ok', 'fresh device unwraps with the new password')
const kd = new HomeKey(keyStore())
ok(await unlockHome(api, kd, 'newer') === 'previous', 'fresh device with a password the wrap does not know: previous')
ok(await rewrapHome(api, kd, 'wrong', 'newer') === false, 'wrong previous password refused')
ok(await rewrapHome(api, kd, 'newpass', 'newer') === true && kd.present, 'previous password unwraps and rewraps')
ok(await unlockHome(api, new HomeKey(keyStore()), 'newer') === 'ok', 'the new password now opens the wrap')

// A stale cached key (the other device won the first-sync race) is cleared rather than trusted.
const stale = new HomeKey(keyStore()); stale.create()
ok(await unlockHome(api, stale, 'nope') === 'previous' && !stale.present, 'stale cached key is dropped')
ok(await sync(api, stale, A).then(() => false, e => e.message.startsWith('home locked')), 'sync without a key: home locked')

// A key made at login is dropped when its wrap does not land.
const savedDoc = doc
doc = { rev: 7, key: null, files: [] }
let breakCommit = true
const realCommit = api.home.commit
api.home.commit = async (...a: any[]) => { if (breakCommit) throw new ApiError('INTERNAL_ERROR', 'Storage listing failed', 502); return realCommit(...a) }
const kn = new HomeKey(keyStore())
ok(await unlockHome(api, kn, 'pw').then(() => false, e => e.status === 502) && !kn.present, 'wrap commit fails: the made key is not kept')
breakCommit = false
ok(await sync(api, kn, A).then(() => false, e => e.message.startsWith('home locked')), 'no key in hand: locked')
const kk = new HomeKey(keyStore()); kk.create()
ok(await sync(api, kk, A).then(() => false, e => e.message.startsWith('home locked')), 'key in hand but no wrap on the server: locked, nothing pushed')
ok(doc.rev === 7 && doc.files.length === 0, 'nothing was pushed')

// Entries under a key the wrap does not hold: unreadable, and reset clears the way.
doc = savedDoc
const kz = new HomeKey(keyStore()); kz.create()
doc = { rev: doc.rev, key: await kz.wrap('zz'), files: doc.files }
const kw = new HomeKey(keyStore())
ok(await unlockHome(api, kw, 'zz') === 'ok', 'wrap unwraps')
ok(await sync(api, kw, A).then(() => false, e => e instanceof HomeUnreadable), 'entries under another key: unreadable')
await resetHome(api, kw)
r = await sync(api, kw, A)
ok(doc.files.length > 0 && lines(r).every(l => l.startsWith('sent ')) && doc.key !== null, 'after reset the local home is pushed whole, wrap kept: ' + lines(r).join(' | ') + ' files=' + doc.files.length)

console.log(process.exitCode ? 'FAILURES' : 'all ok')
