// Home sync: the home directory reconciled against an encrypted mirror on the
// server.
//
// Three states per path go through a three-way merge: local (hashed now), base
// (~/.sync, what this device last agreed with the server) and remote (the
// manifest, decrypted here). An edit beats a delete; two edits keep both, the
// remote one under a numbered copy. Nothing here loses bytes.
//
// A run is three phases in a fixed order: remote to local (pulls, conflict
// copies, deletes), then local to remote (blob uploads, one commit that
// replaces the manifest at the revision that was read), then ~/.sync once.
// Remote-to-local goes first so a conflict copy is on disk before the commit
// replaces the remote version. Every interrupted state lands on a row of the
// merge that resolves with no traffic on the next run.
//
// Every read of the home is sequential: overlapping opens on the OPFS mount
// have crossed files before (docs/design/vfs.md).

import { fs, paths, readText } from '@cyberspace/kernel'
import { ApiError, type ApiClient, type HomeEntry, type HomeManifest } from './api.js'
import { sha256 } from './hash.js'
import { HOME_QUOTA, isHomeExcluded, normaliseHomePath } from './home.js'
import { unwrapWith, type HomeKey, type HomeWrap } from './homekey.js'
import { walk } from './pagesfs.js'

const BASE_FILE = '.sync'
const MAX_TOMBSTONES = 256
const COMMIT_ATTEMPTS = 3

/** What ~/.sync records: path to plaintext hash, live and tombstoned. */
export interface Base {
  rev: number
  files: Map<string, string>
  dead: Map<string, string>
}

/** The decrypted manifest, keyed by path. */
export interface Remote {
  rev: number
  files: Map<string, { hash: string; blob: string; entry: HomeEntry }>
  dead: Map<string, { hash: string; at: number; entry: HomeEntry }>
}

/** The record sealed inside a manifest entry. */
interface Sealed {
  path: string
  hash: string
  /** Tombstones only. */
  at?: number
}

export interface Plan {
  push: string[]
  pull: string[]
  conflict: string[]
  delete: string[]
  tombstone: string[]
  /** Paths in push or pull whose other side had deleted them. */
  restore: string[]
}

export type Verb = 'sent' | 'received' | 'deleted' | 'restored' | 'conflict' | 'skipped'

export interface Line {
  verb: Verb
  path: string
  note?: string
}

export interface Report {
  lines: Line[]
}

const empty = (): Plan => ({ push: [], pull: [], conflict: [], delete: [], tombstone: [], restore: [] })

/**
 * The merge. Pure: every row of the table in docs/design/sync.md, and nothing
 * else. Base tombstones read as absent.
 */
export function reconcile(local: Map<string, string>, base: Base, remote: Remote): Plan {
  const plan = empty()
  const all = new Set([...local.keys(), ...base.files.keys(), ...remote.files.keys(), ...remote.dead.keys()])
  for (const path of all) {
    const l = local.get(path)
    const b = base.files.get(path)
    const r = remote.files.get(path)?.hash
    const t = remote.dead.get(path)?.hash
    if (b !== undefined) {
      if (l === b) {
        if (r === undefined) { if (l !== undefined) plan.delete.push(path) }
        else if (r !== l) plan.pull.push(path)
      } else if (l === undefined) {
        if (r === undefined) continue
        if (r === b) plan.tombstone.push(path)
        else { plan.pull.push(path); plan.restore.push(path) }
      } else {
        if (r === undefined) { plan.push.push(path); plan.restore.push(path) }
        else if (r === l) continue
        else if (r === b) plan.push.push(path)
        else plan.conflict.push(path)
      }
    } else if (l !== undefined) {
      if (r === undefined) {
        // A file identical to what was deleted elsewhere is the deletion
        // arriving late (a reinstalled skel file); anything else is new.
        if (t === l) plan.delete.push(path)
        else plan.push.push(path)
      } else if (r !== l) plan.conflict.push(path)
    } else if (r !== undefined) plan.pull.push(path)
  }
  return plan
}

/** Every syncable file under the home with its plaintext hash, plus the paths the rule refuses. */
export async function scan(home: string): Promise<{ files: Map<string, string>; refused: string[] }> {
  const files = new Map<string, string>()
  const refused: string[] = []
  for (const [abs, rel] of await walk(home)) {
    if (isHomeExcluded(rel)) continue
    if (normaliseHomePath(rel) !== rel) { refused.push(rel); continue }
    const bytes = await fs.promises.readFile(abs).catch(() => null)
    if (!bytes) continue
    files.set(rel, await sha256(bytes))
  }
  return { files, refused }
}

const baseOf = (home: string): string => paths.join(home, BASE_FILE)

/**
 * ~/.sync: `rev N`, then `<hash> <path>` per live file and
 * `deleted <hash> <path>` per tombstone. Unreadable is an empty base.
 */
export async function readBase(home: string): Promise<Base> {
  const base: Base = { rev: 0, files: new Map(), dead: new Map() }
  const text = await readText(baseOf(home)).catch(() => '')
  for (const raw of text.split('\n')) {
    const parts = raw.trim().split(/\s+/)
    if (parts[0] === 'rev' && parts.length === 2) base.rev = Number(parts[1]) || 0
    else if (parts[0] === 'deleted' && parts.length >= 3) base.dead.set(parts.slice(2).join(' '), parts[1]!)
    else if (parts.length >= 2 && /^[0-9a-f]{64}$/.test(parts[0]!)) base.files.set(parts.slice(1).join(' '), parts[0]!)
  }
  return base
}

export async function writeBase(home: string, base: Base): Promise<void> {
  const lines = [`rev ${base.rev}`]
  for (const [path, hash] of [...base.files].sort()) lines.push(`${hash}  ${path}`)
  for (const [path, hash] of [...base.dead].sort()) lines.push(`deleted ${hash}  ${path}`)
  // Written beside and renamed over, so a reader never sees a torn file.
  const tmp = baseOf(home) + '.tmp'
  await fs.promises.writeFile(tmp, lines.join('\n') + '\n')
  await fs.promises.rename(tmp, baseOf(home))
}

/** Paths ~/.sync knows, live or dead. The skel installer skips these. */
export async function syncedPaths(home: string): Promise<Set<string>> {
  const base = await readBase(home)
  return new Set([...base.files.keys(), ...base.dead.keys()])
}

/** No key in hand, or a server with data but no wrap for it: login puts both right. */
export class HomeLocked extends Error {
  constructor() { super('home locked; login again') }
}

/**
 * The key the wrap holds does not open the manifest. Only a client fault can
 * get here (login commits the wrap before anything is pushed under it), and
 * nothing anywhere can read those entries; `sync reset` discards them.
 */
export class HomeUnreadable extends Error {
  constructor() { super('home unreadable; sync reset discards the server copy') }
}

async function decrypt(key: HomeKey, m: HomeManifest): Promise<Remote> {
  const remote: Remote = { rev: m.rev, files: new Map(), dead: new Map() }
  for (const entry of m.files) {
    let s: Sealed
    try {
      s = await key.openEntry<Sealed>(entry.e)
    } catch {
      throw new HomeUnreadable()
    }
    if (entry.deleted) remote.dead.set(s.path, { hash: s.hash, at: s.at ?? 0, entry })
    else if (entry.blob) remote.files.set(s.path, { hash: s.hash, blob: entry.blob, entry })
  }
  return remote
}

const reason = (e: unknown): string => {
  const { reason, message } = e as { reason?: string; message?: string }
  return reason ?? message ?? String(e)
}

/** `<path>.1`, `<path>.2`, … the first name not taken. */
async function copyName(abs: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = `${abs}.${n}`
    if (!(await fs.promises.stat(candidate).catch(() => null))) return candidate
  }
}

async function writeFile(abs: string, bytes: Uint8Array): Promise<void> {
  // ZenFS opens a directory for writing without complaint; refuse it here.
  const st = await fs.promises.stat(abs).catch(() => null)
  if (st?.isDirectory()) throw new Error('is a directory')
  await fs.promises.mkdir(paths.dirname(abs), { recursive: true }).catch(() => {})
  await fs.promises.writeFile(abs, bytes)
}

let running: Promise<Report> | null = null

/**
 * One run. A second call while one is in flight shares it. Throws ApiError
 * (NO_CARRIER, 403, a commit that keeps failing) and HomeLocked; per-file
 * trouble is a `skipped` line and the run goes on.
 */
export function sync(api: ApiClient, key: HomeKey, home: string): Promise<Report> {
  if (running) return running
  running = run(api, key, home).finally(() => { running = null })
  return running
}

async function run(api: ApiClient, key: HomeKey, home: string): Promise<Report> {
  if (!key.present) throw new HomeLocked()
  // Blobs this run has uploaded, by plaintext hash, so a pass repeated after
  // a lost commit race does not seal and send them again.
  const uploaded = new Map<string, HomeEntry>()
  for (let attempt = 1; ; attempt++) {
    const lines: Line[] = []
    const done = await once(api, key, home, lines, uploaded)
    if (done || attempt === COMMIT_ATTEMPTS) return { lines }
  }
}

/** One pass; false when the commit lost a race and the whole pass should repeat. */
async function once(api: ApiClient, key: HomeKey, home: string, lines: Line[], uploaded: Map<string, HomeEntry>): Promise<boolean> {
  const skip = (path: string, note: string) => lines.push({ verb: 'skipped', path, note })
  const abs = (rel: string) => paths.join(home, rel)

  const { files: local, refused } = await scan(home)
  for (const path of refused) skip(path, 'bad path')
  let base = await readBase(home)
  const m = await api.home.manifest()
  // Nothing goes up under a key the server has no wrap for: a second device
  // would make its own key and never read it. Login commits the wrap.
  if (!m.key) throw new HomeLocked()
  // Deleting every file leaves tombstones; a manifest with no entries at all
  // is a reset (sync reset), and the base would otherwise read it as every
  // file deleted there. Start over: everything local is new.
  if (m.files.length === 0) base = { rev: 0, files: new Map(), dead: new Map() }
  const remote = await decrypt(key, m)
  const plan = reconcile(local, base, remote)
  const restored = new Set(plan.restore)
  // Paths that did not land: kept out of base so the next run tries again
  // rather than reading their absence as a deletion.
  const failed = new Set<string>()
  // The manifest going back: every remote entry by path, then the changes.
  const next = new Map<string, HomeEntry>()
  for (const [path, f] of remote.files) next.set(path, f.entry)
  for (const [path, d] of remote.dead) next.set(path, d.entry)

  // Phase 1: remote to local.
  const fetchPlain = async (path: string): Promise<Uint8Array> => {
    const r = remote.files.get(path)!
    const plain = await key.open(await api.home.readBlob(r.blob))
    if (await sha256(plain) !== r.hash) throw new Error('hash mismatch')
    return plain
  }
  for (const path of plan.pull) {
    try {
      await writeFile(abs(path), await fetchPlain(path))
      lines.push({ verb: restored.has(path) ? 'restored' : 'received', path })
    } catch (e) {
      failed.add(path)
      skip(path, reason(e))
    }
  }
  const copies: [string, string][] = []
  for (const path of plan.conflict) {
    try {
      const copy = await copyName(abs(path))
      await writeFile(copy, await fetchPlain(path))
      const rel = copy.slice(home.length + 1)
      copies.push([rel, path])
      lines.push({ verb: 'conflict', path, note: rel })
    } catch (e) {
      failed.add(path)
      skip(path, reason(e))
    }
  }
  for (const path of plan.delete) {
    await fs.promises.unlink(abs(path)).catch(() => {})
    lines.push({ verb: 'deleted', path })
  }

  // Phase 2: local to remote. A conflict copy carries the remote bytes, so its
  // entry reuses the remote blob; a push whose plaintext already exists under
  // another path reuses that blob too.
  const blobs = new Map<string, HomeEntry>(uploaded)
  for (const f of remote.files.values()) blobs.set(f.hash, f.entry)
  for (const [copy, path] of copies) {
    const r = remote.files.get(path)!
    next.set(copy, { blob: r.blob, size: r.entry.size, e: await key.sealEntry({ path: copy, hash: r.hash }) })
  }
  for (const path of [...plan.push, ...plan.conflict]) {
    if (failed.has(path)) continue
    try {
      const hash = local.get(path)!
      const known = blobs.get(hash)
      let blob: string, size: number
      if (known?.blob) ({ blob, size } = known as { blob: string; size: number })
      else {
        const plain = await fs.promises.readFile(abs(path))
        if (plain.length > HOME_QUOTA.maxBytesPerFile) throw new Error(`too big — ${Math.ceil(plain.length / 1024)}KB of ${HOME_QUOTA.maxBytesPerFile / 1024}KB`)
        const sealed = await key.seal(plain)
        blob = await sha256(sealed)
        size = sealed.length
        await api.home.putBlob(blob, sealed)
      }
      const entry: HomeEntry = { blob, size, e: await key.sealEntry({ path, hash }) }
      next.set(path, entry)
      blobs.set(hash, entry)
      uploaded.set(hash, entry)
      // A conflict already has its line; the push of the local side is part of it.
      if (plan.push.includes(path)) lines.push({ verb: restored.has(path) ? 'restored' : 'sent', path })
    } catch (e) {
      failed.add(path)
      skip(path, reason(e))
    }
  }
  const at = Date.now()
  for (const path of plan.tombstone) {
    next.set(path, { deleted: true, size: 0, e: await key.sealEntry({ path, hash: base.files.get(path)!, at }) })
    lines.push({ verb: 'deleted', path })
  }
  // Tombstones are capped; the oldest go first.
  const dead = [...next].filter(([, e]) => e.deleted)
  if (dead.length > MAX_TOMBSTONES) {
    const age = (path: string) => plan.tombstone.includes(path) ? at : remote.dead.get(path)?.at ?? 0
    dead.sort(([a], [b]) => age(a) - age(b))
    for (const [path] of dead.slice(0, dead.length - MAX_TOMBSTONES)) next.delete(path)
  }

  const changed = plan.push.length + plan.conflict.length + plan.tombstone.length > 0 || copies.length > 0
  let rev = remote.rev
  if (changed) {
    try {
      rev = (await api.home.commit(remote.rev, [...next.values()])).rev
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return false
      throw e
    }
  }

  // Phase 3: base. What is on disk now and agreed with the server, minus
  // anything that did not land.
  const out: Base = { rev, files: new Map(), dead: new Map() }
  for (const [path, f] of remote.files) if (!plan.delete.includes(path)) out.files.set(path, f.hash)
  for (const [path, d] of remote.dead) out.dead.set(path, d.hash)
  for (const path of plan.push) out.files.set(path, local.get(path)!)
  for (const path of plan.conflict) out.files.set(path, local.get(path)!)
  for (const [copy, path] of copies) out.files.set(copy, remote.files.get(path)!.hash)
  for (const path of plan.tombstone) { out.files.delete(path); out.dead.set(path, base.files.get(path)!) }
  for (const path of plan.delete) { out.files.delete(path); if (local.has(path)) out.dead.set(path, local.get(path)!) }
  for (const path of failed) out.files.delete(path)
  await writeBase(home, out)
  return true
}

/**
 * login(1): put the account's key in hand while the typed password is
 * available. No key on the server yet: make one (or keep the cached one) and
 * commit its wrap. A wrap the password opens: take it. A wrap it does not
 * open is a changed password: rewrap the cached key if it is the right one,
 * else `previous` asks the caller for the old password (rewrapHome).
 * A commit that loses the race to another device's first sync reads again.
 */
export async function unlockHome(api: ApiClient, key: HomeKey, password: string): Promise<'ok' | 'previous'> {
  // A key made here is kept only once its wrap is on the server; otherwise a
  // later run would push data nothing else can ever unwrap.
  let made = false
  const drop = () => { if (made) { key.clear(); made = false } }
  for (let attempt = 0; attempt < 2; attempt++) {
    const m = await api.home.manifest().catch(e => { drop(); throw e })
    if (!m.key) {
      if (!key.present) { key.create(); made = true }
      const landed = await commitWrap(api, m, await key.wrap(password)).catch(e => { drop(); throw e })
      if (landed) return 'ok'
      continue
    }
    drop()
    const raw = await unwrapWith(password, m.key)
    if (raw) { key.adopt(raw); return 'ok' }
    if (key.present && await opens(key, m)) {
      if (await commitWrap(api, m, await key.wrap(password))) return 'ok'
      continue
    }
    key.clear()
    return 'previous'
  }
  drop()
  return 'ok'
}

/**
 * sync reset: replace the server copy with nothing, at the revision read, and
 * keep the wrap. The next run pushes the whole local home. For a manifest the
 * key cannot open; local files are untouched.
 */
export async function resetHome(api: ApiClient, key: HomeKey): Promise<void> {
  if (!key.present) throw new HomeLocked()
  const m = await api.home.manifest()
  if (!m.key) throw new HomeLocked()
  await api.home.commit(m.rev, [])
}

/** The old password opens the wrap; the new one takes over. False when it does not. */
export async function rewrapHome(api: ApiClient, key: HomeKey, previous: string, password: string): Promise<boolean> {
  const m = await api.home.manifest()
  if (!m.key) return true
  if (!(await key.unlock(previous, m.key))) return false
  await commitWrap(api, m, await key.wrap(password))
  return true
}

/** Whether the key in hand reads this manifest. An empty manifest reads with any key. */
const opens = (key: HomeKey, m: HomeManifest): Promise<boolean> =>
  m.files.length === 0 ? Promise.resolve(true) : key.openEntry(m.files[0]!.e).then(() => true, () => false)

/** False on a revision race; anything else is thrown. */
async function commitWrap(api: ApiClient, m: HomeManifest, wrap: HomeWrap): Promise<boolean> {
  try {
    await api.home.commit(m.rev, m.files, wrap)
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return false
    throw e
  }
}
