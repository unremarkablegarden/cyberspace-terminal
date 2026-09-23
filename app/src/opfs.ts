// The OPFS home mount.
//
// Three workarounds over @zenfs/dom's WebAccess:
//
// 1. WebAccess builds its index at mount time without inode numbers, so every
//    entry is ino 0. @zenfs/core keys its vnode cache by ino (zen-fs/core
//    #287), so overlapping opens on the mount share one vnode: the second
//    reader takes the first file's path and length and gets the wrong bytes,
//    or none. The shell writes ~/.sh_history without awaiting before running
//    each command, which guarantees the overlap. Unfixed upstream as of
//    @zenfs/dom 1.2.11 — remove this once _loadMetadata assigns inodes.
//
// 2. WebAccess writes through FileSystemFileHandle.createWritable, which
//    WebKit does not implement (Safari, every iOS browser). Its write primitive
//    is createSyncAccessHandle, worker-only, so writes go through
//    opfs.worker.ts (by path: Safari cannot clone a handle) when
//    createWritable is missing. Reads take this path too:
//    core updates atime on read, which dirties the vnode and syncs on close.
//
// 3. OPFS stores no permissions, and WebAccess gives every entry 0644 (files)
//    or 0777 (directories) at mount. Modes that differ from those are kept in
//    MODES_FILE at the OPFS root and applied after mount. See docs/design/vfs.md.

import { WebAccess, type WebAccessOptions } from '@zenfs/dom'
import type { OpfsWrite, OpfsWrote } from './opfs.worker'

let worker: Worker | undefined
let nextId = 1
const pending = new Map<number, (r: OpfsWrote) => void>()

function writeViaWorker(path: string, buffer: Uint8Array, offset: number, truncate = false) {
  if (!worker) {
    worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<OpfsWrote>) => {
      pending.get(e.data.id)?.(e.data)
      pending.delete(e.data.id)
    }
  }
  const id = nextId++
  return new Promise<number>((resolve, reject) => {
    pending.set(id, r => (r.error ? reject(new Error(r.error)) : resolve(r.size!)))
    // Copy: the caller's buffer may be a view over a shared or resizable ArrayBuffer.
    worker!.postMessage({ id, path, buffer: buffer.slice(), offset, truncate } satisfies OpfsWrite)
  })
}

const hasCreateWritable = typeof FileSystemFileHandle !== 'undefined'
  && 'createWritable' in FileSystemFileHandle.prototype

/** Mode index, relative to the OPFS root. Kept out of the ZenFS index, so it is not listed. */
const MODES_FILE = '/.modes'
/** Delay after the last metadata change before the index is written, in ms. */
const MODES_DEBOUNCE = 500

type Index = WebAccessFS['index']
type WebAccessFS = Awaited<ReturnType<typeof WebAccess.create>>

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

/** The permission bits WebAccess assigns at mount. */
const defaultMode = (mode: number): number => ((mode & S_IFMT) === S_IFDIR ? 0o777 : 0o644)

/** Path to permission bits, for every entry whose bits differ from defaultMode. */
function modesOf(index: Index): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [path, inode] of index) {
    if (path === '/') continue
    const perm = inode.mode & 0o7777
    if (perm !== defaultMode(inode.mode)) out[path] = perm
  }
  return out
}

async function readModes(root: FileSystemDirectoryHandle): Promise<Record<string, number>> {
  try {
    const file = await (await root.getFileHandle(MODES_FILE.slice(1))).getFile()
    return JSON.parse(await file.text()) as Record<string, number>
  } catch {
    return {}
  }
}

async function writeModes(root: FileSystemDirectoryHandle, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text)
  if (!hasCreateWritable) {
    await writeViaWorker(MODES_FILE, bytes, 0, true)
    return
  }
  const writable = await (await root.getFileHandle(MODES_FILE.slice(1), { create: true })).createWritable()
  await writable.write(bytes)
  await writable.close()
}

/**
 * Apply the stored modes, then rewrite the index after metadata changes.
 * The whole index is rescanned on each write, so renames and removals need no
 * bookkeeping of their own. Entries for paths that no longer exist are dropped
 * on the next write.
 */
async function keepModes(fs: WebAccessFS, root: FileSystemDirectoryHandle): Promise<void> {
  fs.index.delete(MODES_FILE)
  for (const [path, perm] of Object.entries(await readModes(root))) {
    const inode = fs.index.get(path)
    if (inode) inode.update({ mode: (inode.mode & S_IFMT) | perm })
  }
  let written = JSON.stringify(modesOf(fs.index))
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    const text = JSON.stringify(modesOf(fs.index))
    if (text === written) return
    written = text
    writeModes(root, text).catch(e => console.warn('opfs: mode index not written', e))
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(flush, MODES_DEBOUNCE)
  }
  for (const name of ['touch', 'createFile', 'mkdir', 'rename', 'unlink', 'rmdir'] as const) {
    const original = fs[name].bind(fs) as (...args: unknown[]) => Promise<unknown>
    ;(fs as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      try {
        return await original(...args)
      } finally {
        schedule()
      }
    }
  }
}

export const OpfsHome = {
  ...WebAccess,
  name: 'OpfsHome',
  async create(options: WebAccessOptions) {
    const fs = await WebAccess.create(options)
    let next = 1
    for (const [path, inode] of fs.index) {
      if (path === '/') continue // the root keeps rootIno 0
      inode.ino = next
      inode.data = next + 1
      inode.nlink ||= 1
      next += 2
    }
    if (!hasCreateWritable) {
      fs.write = async function (path: string, buffer: Uint8Array, offset: number) {
        const inode = this.index.get(path)
        if (!inode) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT', errno: 2 })
        if ((inode.mode & 0o170000) === 0o040000) return
        // The mount is the OPFS root, so the index path is the OPFS path.
        this._handles.delete(path) // cached handle would serve a stale File
        const size = await writeViaWorker(path, buffer, offset)
        inode.update({ size, mtimeMs: Date.now() })
        this.index.set(path, inode)
      }
    }
    await keepModes(fs, options.handle)
    return fs
  },
}
