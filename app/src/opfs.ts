// The OPFS home mount.
//
// @zenfs/dom's WebAccess builds its index at mount time without inode numbers,
// so every entry is ino 0. @zenfs/core keys its vnode cache by ino (zen-fs/core
// #287), so overlapping opens on the mount share one vnode: the second reader
// takes the first file's path and length and gets the wrong bytes, or none.
// The shell writes ~/.sh_history without awaiting before running each command,
// which guarantees the overlap. Unfixed upstream as of @zenfs/dom 1.2.11 —
// remove this once _loadMetadata assigns inodes.

import { WebAccess, type WebAccessOptions } from '@zenfs/dom'

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
    return fs
  },
}
