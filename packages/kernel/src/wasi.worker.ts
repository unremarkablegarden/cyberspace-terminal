// The WASI process host. Runs one wasm program to completion and dies.
// Interactive stdin blocks right here on the SharedArrayBuffer ring, which is
// the whole reason this is a worker: WASI reads are synchronous, and the main
// thread cannot sleep.
//
// Files are staged, not bridged. The kernel reads the files named on the
// command line before the run and ships them here as an in-memory tree; a file
// opened for writing is posted back whole when its fd closes, and the kernel
// commits it. Enough for an editor (open, edit, :w) without a synchronous
// filesystem bridge into the worker.

import { WASI, WASIProcExit, OpenFile, OpenDirectory, PreopenDirectory, Directory, File, ConsoleStdout, Fd, Inode, wasi } from '@bjorn3/browser_wasi_shim'
import { RingReader } from './sabring.js'
import { pollOneoff } from './poll.js'

export interface StagedFile {
  /** Absolute path on the machine. */
  path: string
  data: ArrayBuffer
}

export interface RunMessage {
  wasm: ArrayBuffer
  argv: string[]
  env: string[]
  /** Pre-read stdin for the batch case; the ring replaces it when present. */
  stdin?: ArrayBuffer
  ring?: SharedArrayBuffer
  /** Directories that exist on the machine and are visible to the program. */
  dirs: string[]
  files: StagedFile[]
  /** Terminal size when stdio is a terminal. */
  tty?: { cols: number; rows: number }
}

export type OutMessage =
  | { t: 'out' | 'err'; d: Uint8Array }
  | { t: 'exit'; code: number }
  | { t: 'fault'; message: string }
  /** A file the program wrote, whole, on close. */
  | { t: 'file'; path: string; d: Uint8Array }
  /** The program asked for raw (true) or cooked (false) terminal input. */
  | { t: 'raw'; on: boolean }

const post = (m: OutMessage): void => (self as unknown as Worker).postMessage(m)
const dec = new TextDecoder()

/** A terminal-shaped stdin: character device, reads block on the ring. */
class RingStdin extends Fd {
  constructor(readonly reader: RingReader) {
    super()
  }

  override fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0) }
  }

  override fd_read(size: number): { ret: number; data: Uint8Array } {
    const data = this.reader.readBlocking(size)
    if (data === null) return { ret: wasi.ERRNO_INTR, data: new Uint8Array() }
    return { ret: 0, data }
  }
}

function join(dir: string, rel: string): string {
  const out = dir === '/' ? [] : dir.split('/').slice(1)
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/**
 * The staged tree, preopened as "/", plus the absolute path of every inode in
 * it (to name a written file on the way back) and each file's last known
 * bytes (to post back only changed ones).
 */
function buildTree(dirs: string[], files: StagedFile[]): { root: PreopenDirectory; paths: Map<Inode, string>; committed: Map<File, Uint8Array> } {
  const paths = new Map<Inode, string>()
  // Bytes as the machine has them, per file: staged at start, then as posted.
  const committed = new Map<File, Uint8Array>()
  const rootDir = new Directory(new Map())
  paths.set(rootDir, '/')
  const mkdirp = (path: string): Directory => {
    let dir = rootDir
    let at = ''
    for (const seg of path.split('/')) {
      if (!seg) continue
      at += '/' + seg
      const have = dir.contents.get(seg)
      if (have instanceof Directory) {
        dir = have
        continue
      }
      const next = new Directory(new Map())
      dir.contents.set(seg, next)
      paths.set(next, at)
      dir = next
    }
    return dir
  }
  for (const d of dirs) mkdirp(d)
  for (const f of files) {
    const i = f.path.lastIndexOf('/')
    const dir = mkdirp(f.path.slice(0, i))
    const file = new File(new Uint8Array(f.data))
    dir.contents.set(f.path.slice(i + 1), file)
    paths.set(file, f.path)
    committed.set(file, new Uint8Array(f.data))
  }
  const root = new PreopenDirectory('/', rootDir.contents)
  paths.set(root.dir, '/')
  return { root, paths, committed }
}

self.onmessage = async (e: MessageEvent<RunMessage>) => {
  const { wasm, argv, env, stdin, ring, dirs, files, tty } = e.data
  try {
    const stdinFd = ring
      ? new RingStdin(new RingReader(ring))
      : new OpenFile(new File(new Uint8Array(stdin ?? new ArrayBuffer(0))))
    const { root, paths, committed } = buildTree(dirs, files)
    const fds: (Fd | undefined)[] = [
      stdinFd,
      // The shim hands out views into wasm memory; copy before they go stale.
      new ConsoleStdout(d => post({ t: 'out', d: d.slice() })),
      new ConsoleStdout(d => post({ t: 'err', d: d.slice() })),
      root,
    ]

    // The shim logs every call unless debug is set false; undefined means on.
    const w = new WASI(argv, env, fds as Fd[], { debug: false })
    const imports = w.wasiImport
    let memory: WebAssembly.Memory | null = null
    const view = (): DataView => new DataView(memory!.buffer)

    // fds opened with write rights; their file goes back to the kernel on close.
    const writable = new Set<number>()
    const basePathOpen = imports.path_open
    imports.path_open = (fd: number, dirflags: number, pathPtr: number, pathLen: number, oflags: number, rightsBase: bigint, rightsInheriting: bigint, fdflags: number, outPtr: number) => {
      const ret = basePathOpen(fd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, outPtr)
      if (ret !== 0) return ret
      const v = view()
      const opened = v.getUint32(outPtr, true)
      const obj = fds[opened]
      const at = fds[fd]
      const dirPath = at instanceof OpenDirectory ? paths.get(at.dir) : undefined
      const abs = join(dirPath ?? '/', dec.decode(new Uint8Array(memory!.buffer, pathPtr, pathLen)))
      if (obj instanceof OpenFile) {
        if (!paths.has(obj.file)) paths.set(obj.file, abs)
        if (rightsBase & BigInt(wasi.RIGHTS_FD_WRITE)) writable.add(opened)
      } else if (obj instanceof OpenDirectory) {
        if (!paths.has(obj.dir)) paths.set(obj.dir, abs)
      }
      return ret
    }
    // A file is posted back only when its bytes differ from what the machine
    // holds: programs open read-write to probe for write permission.
    const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])
    const baseClose = imports.fd_close
    imports.fd_close = (fd: number) => {
      const obj = fds[fd]
      if (writable.delete(fd) && obj instanceof OpenFile) {
        const path = paths.get(obj.file)
        const known = committed.get(obj.file)
        if (path && !(known && same(known, obj.file.data))) {
          const d = obj.file.data.slice()
          committed.set(obj.file, d)
          post({ t: 'file', path, d })
        }
      }
      return baseClose(fd)
    }

    // The shim reports no rights on a directory, and wasi-libc's access()
    // answers W_OK from the directory's inheritable rights, so every file would
    // open read-only. Grant every right; the tree is the program's own copy.
    // Fdstat: filetype u8 at 0, flags u16 at 2, rights u64 at 8 and 16.
    const baseFdstat = imports.fd_fdstat_get
    imports.fd_fdstat_get = (fd: number, ptr: number) => {
      const ret = baseFdstat(fd, ptr)
      if (ret === 0 && fds[fd] instanceof OpenDirectory) {
        const v = view()
        v.setBigUint64(ptr + 8, 0x3fffffffn, true)
        v.setBigUint64(ptr + 16, 0x3fffffffn, true)
      }
      return ret
    }

    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    imports.poll_oneoff = (inPtr: number, outPtr: number, n: number, neventsPtr: number) =>
      pollOneoff(view(), inPtr, outPtr, n, neventsPtr, {
        ring: fd => (fds[fd] instanceof RingStdin ? (fds[fd] as RingStdin).reader : null),
        open: fd => fds[fd] !== undefined,
        sleep: ms => { Atomics.wait(sleeper, 0, 0, ms) },
      })

    // Terminal facts WASI has no call for. A program that does not import the
    // module is unaffected.
    const cyberspace = {
      tty_size: (ptr: number): number => {
        if (!tty) return -1
        const v = view()
        v.setUint16(ptr, tty.cols, true)
        v.setUint16(ptr + 2, tty.rows, true)
        return 0
      },
      tty_raw: (on: number): void => post({ t: 'raw', on: on !== 0 }),
    }

    const module = await WebAssembly.compile(wasm)
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: imports,
      cyberspace,
    })
    memory = instance.exports.memory as WebAssembly.Memory

    let code = 0
    try {
      code = w.start(instance as { exports: { memory: WebAssembly.Memory; _start: () => unknown } })
    } catch (err) {
      if (err instanceof WASIProcExit) code = err.code
      else throw err
    }
    post({ t: 'exit', code })
  } catch (err) {
    post({ t: 'fault', message: String((err as Error)?.message ?? err) })
  }
}
