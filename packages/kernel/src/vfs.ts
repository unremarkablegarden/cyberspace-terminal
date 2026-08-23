// Mount configuration is the host's job (the kernel must not know what OPFS
// is); this wraps ZenFS configure and file-backed stream helpers.

import { configure, fs } from '@zenfs/core'
import type { Source, Sink } from './pipe.js'
import { bytes, dec } from './pipe.js'

// The mounts object is host-defined; zenfs infers backend options from the
// literal, which the kernel cannot know. Hence the cast.
export async function mountAll(mounts: Record<string, unknown>): Promise<void> {
  await configure({ mounts: mounts as never, disableAccessChecks: true })
}

/** Source over a file's contents. */
export async function fileSource(path: string): Promise<Source> {
  const data: Uint8Array = await fs.promises.readFile(path)
  let done = false
  return {
    read() {
      if (done) return Promise.resolve(null)
      done = true
      return Promise.resolve(data.length ? data : null)
    },
  }
}

/** Sink that writes (or appends) to a file on end(). */
export async function fileSink(path: string, append: boolean): Promise<Sink> {
  // Truncate up front so the file changes even if nothing is written.
  if (!append) await fs.promises.writeFile(path, new Uint8Array())
  const parts: Uint8Array[] = []
  return {
    write(data) {
      parts.push(bytes(data))
    },
    end() {
      let len = 0
      for (const p of parts) len += p.length
      const buf = new Uint8Array(len)
      let o = 0
      for (const p of parts) { buf.set(p, o); o += p.length }
      return fs.promises.appendFile(path, buf)
    },
  }
}

/** A file as text. */
export async function readText(path: string): Promise<string> {
  return dec.decode(await fs.promises.readFile(path))
}
