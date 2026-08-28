// ~/public_html as a filesystem, mounted over the ordinary directory of that
// name while a supporter is logged in. The tree is in memory; every saved file
// goes to PUT /v1/pages/files/<path> and every unlink to DELETE, so edit(1),
// cp, rm and upload need no knowledge of the site. The site is created on the
// first save. Text is fetched from the bucket on first read; binaries are
// listed by size and refuse reads. Files the directory held before the mount
// are shown but not sent until saved again. Unmounted at logout, and the
// directory underneath is as it was.
//
// Where the PUT happens: ZenFS flushes a file as write() calls followed by one
// touch(path, inode) (vfs/vnode.js, sync()). write() marks the path dirty and
// the touch that follows sends the whole file, so a save costs one request
// however the writer chunked it. A touch whose size differs from the store's
// is a truncate and marks the file dirty too, or writing an empty file would
// never reach the server.
//
// A refused save is reported to the writer and the tree keeps the bytes the
// server refused; the next save sends them again. Nothing is rolled back:
// the vfs cache would go on serving the rejected bytes regardless.

import { ErrnoError, InMemoryStore, StoreFS, fs, vfs, type CreationOptions, type Inode, type InodeLike } from '@zenfs/core'
import { paths } from '@cyberspace/kernel'
import type { ApiClient } from './api.js'
import { isPagesText, normalisePagesPath, pagesContentType } from './pages.js'

const EPERM = 1 as ErrnoError['errno']
const EIO = 5 as ErrnoError['errno']

/**
 * An errno with the reason the tools print. The vfs rewrites `message` on the
 * way up (syscall, path) and on some paths drops it; `reason` survives as a
 * property, and coreutils' strerror reads it first.
 */
function refuse(errno: ErrnoError['errno'], reason: string): ErrnoError {
  return Object.assign(new ErrnoError(errno, reason), { reason })
}

/** The server's wording for a name the path rule refuses. */
const BAD_PATH = 'bad path — lowercase letters, digits, dot, dash, underscore; html css js txt gif jpg png mid'

const S_IFMT = 0o170000
const S_IFREG = 0o100000

const CREATE = { mode: 0o644, uid: 0, gid: 0 }
const MKDIR = { mode: 0o755, uid: 0, gid: 0 }

export class PagesFS extends StoreFS<InMemoryStore> {
  /** Listed but not yet fetched; the store holds only the size. */
  private pending = new Set<string>()
  /** Written since the last flush. */
  private dirty = new Set<string>()
  /** Files the server holds; an unlink of anything else needs no request. */
  private known = new Set<string>()
  /** Population and fetches write the store without a request. */
  private quiet = false

  constructor(private api: ApiClient) {
    super(new InMemoryStore(undefined, 'public_html'))
  }

  /** Site-relative path for a node, or null for a directory or an unsendable name. */
  private rel(path: string): string | null {
    return normalisePagesPath(path)
  }

  /** Register a listed object without its bytes. */
  async list(path: string, size: number): Promise<void> {
    this.quiet = true
    try {
      await this.mkdirs(paths.dirname(path))
      if (await super.exists(path)) await super.unlink(path)
      await super.createFile(path, CREATE)
      await super.touch(path, { size })
      this.pending.add(path)
      this.known.add(path)
    } finally {
      this.quiet = false
    }
  }

  /** Bring in a file the directory held before the mount: local until saved. */
  async adopt(path: string, data: Uint8Array): Promise<void> {
    this.quiet = true
    try {
      await this.mkdirs(paths.dirname(path))
      await super.createFile(path, CREATE)
      await this.replace(path, data)
    } finally {
      this.quiet = false
    }
  }

  private async mkdirs(dir: string): Promise<void> {
    if (dir === '/' || (await super.exists(dir))) return
    await this.mkdirs(paths.dirname(dir))
    await super.mkdir(dir, MKDIR)
  }

  private async bytesOf(path: string): Promise<Uint8Array> {
    const st = await super.stat(path)
    const buf = new Uint8Array(st.size)
    if (st.size) await super.read(path, buf, 0, st.size)
    return buf
  }

  private async replace(path: string, data: Uint8Array): Promise<void> {
    this.quiet = true
    try {
      await super.touch(path, { size: 0 })
      if (data.length) await super.write(path, data, 0)
      await super.touch(path, { size: data.length, mtimeMs: Date.now() })
    } finally {
      this.quiet = false
    }
  }

  override async read(path: string, buffer: Uint8Array, offset: number, end: number): Promise<void> {
    if (this.pending.has(path)) {
      const rel = this.rel(path)
      if (!rel || !isPagesText(rel)) throw refuse(EPERM, 'binary file')
      let text: string
      try {
        text = (await this.api.pages.readText(rel)).content
      } catch (e) {
        throw refuse(EIO, (e as Error).message)
      }
      await this.replace(path, new TextEncoder().encode(text))
      this.pending.delete(path)
    }
    return super.read(path, buffer, offset, end)
  }

  override async createFile(path: string, options: CreationOptions): Promise<Inode> {
    if (!this.quiet && !this.rel(path)) throw refuse(EPERM, BAD_PATH)
    return super.createFile(path, options)
  }

  override async write(path: string, data: Uint8Array, offset: number): Promise<void> {
    await super.write(path, data, offset)
    if (!this.quiet) this.dirty.add(path)
  }

  override async touch(path: string, metadata: Partial<InodeLike>): Promise<void> {
    if (!this.quiet && metadata.size !== undefined) {
      const st = await super.stat(path)
      if ((st.mode & S_IFMT) === S_IFREG && st.size !== metadata.size) {
        this.dirty.add(path)
        // Truncating a file never fetched: what is here now is the content.
        this.pending.delete(path)
      }
    }
    await super.touch(path, metadata)
    // A truncate touches the size alone and the writes are still to come; the
    // flush that closes a save carries the whole inode.
    if (this.quiet || metadata.mtimeMs === undefined || !this.dirty.has(path)) return
    this.dirty.delete(path)
    await this.flush(path)
  }

  private async flush(path: string): Promise<void> {
    const rel = this.rel(path)
    if (!rel) throw refuse(EPERM, BAD_PATH)
    const data = await this.bytesOf(path)
    try {
      await this.put(rel, data)
    } catch (e) {
      throw refuse(EIO, (e as Error).message)
    }
    this.pending.delete(path)
    this.known.add(path)
  }

  /** The first save creates the site; the server answers 404 until it exists. */
  private async put(rel: string, data: Uint8Array): Promise<void> {
    try {
      await this.api.pages.putFile(rel, data, pagesContentType(rel))
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e
      // createSite writes the default index.html; the caller's bytes replace it.
      await this.api.pages.createSite()
      await this.api.pages.putFile(rel, data, pagesContentType(rel))
    }
  }

  override async unlink(path: string): Promise<void> {
    await super.unlink(path)
    const rel = this.rel(path)
    if (!rel || !this.known.has(path)) return
    try {
      await this.api.pages.deleteFile(rel)
    } catch (e) {
      throw refuse(EIO, (e as Error).message)
    }
    this.known.delete(path)
    this.pending.delete(path)
  }

  override async rename(): Promise<void> {
    throw refuse(EPERM, 'not supported in public_html')
  }

  override renameSync(): void {
    throw refuse(EPERM, 'not supported in public_html')
  }
}

const mountPoint = (home: string): string => `${home}/public_html`

let mounted: string | null = null
let mounting: Promise<boolean> | null = null

/** Every file under `dir`, as [absolute path, relative path]. */
async function walk(dir: string, rel = ''): Promise<[string, string][]> {
  const out: [string, string][] = []
  for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    const abs = `${dir}/${name}`
    const r = rel ? `${rel}/${name}` : name
    const st = await fs.promises.stat(abs).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) out.push(...(await walk(abs, r)))
    else out.push([abs, r])
  }
  return out
}

/**
 * Mount the site over ~/public_html; true once it is mounted. What the
 * directory already holds is adopted as unsent; the site listing wins a name
 * clash. No site yet mounts an empty tree. Concurrent calls share one attempt.
 * `still` is asked again after the network round trip: a logout in the
 * meantime, or a host whose filesystems are not up, means no mount.
 */
export function mountPages(api: ApiClient, home: string, still: () => boolean): Promise<boolean> {
  const point = mountPoint(home)
  if (mounted === point) return Promise.resolve(true)
  if (mounting) return mounting
  mounting = (async () => {
    if (!still()) return false
    const files = await api.pages.listFiles().catch(e => {
      if ((e as { status?: number }).status === 404) return []
      throw e
    })
    const pfs = new PagesFS(api)
    await pfs.ready()
    for (const [abs, rel] of await walk(point)) {
      const data = await fs.promises.readFile(abs).catch(() => null)
      if (data) await pfs.adopt('/' + rel, data).catch(() => {})
    }
    for (const f of files) await pfs.list('/' + f.path, f.size).catch(() => {})
    if (!still()) return false
    await fs.promises.mkdir(point).catch(() => {})
    vfs.mount(point, pfs)
    mounted = point
    return true
  })().finally(() => { mounting = null })
  return mounting
}

export function umountPages(home: string): void {
  const point = mountPoint(home)
  if (mounted !== point) return
  vfs.umount(point)
  mounted = null
}
