// The OPFS home mount.
//
// Two workarounds over @zenfs/dom's WebAccess:
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

import { WebAccess, type WebAccessOptions } from '@zenfs/dom'
import type { OpfsWrite, OpfsWrote } from './opfs.worker'

let worker: Worker | undefined
let nextId = 1
const pending = new Map<number, (r: OpfsWrote) => void>()

function writeViaWorker(path: string, buffer: Uint8Array, offset: number) {
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
    worker!.postMessage({ id, path, buffer: buffer.slice(), offset } satisfies OpfsWrite)
  })
}

const hasCreateWritable = typeof FileSystemFileHandle !== 'undefined'
  && 'createWritable' in FileSystemFileHandle.prototype

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
    return fs
  },
}
