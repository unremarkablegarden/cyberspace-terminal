// OPFS write path for WebKit. Safari has no FileSystemFileHandle.createWritable;
// its only write primitive is createSyncAccessHandle, available in dedicated
// workers only. The main thread posts a path (relative to the OPFS root; Safari
// cannot structured-clone a handle) and gets the resulting size back.

/** `truncate` cuts the file at the end of this write, for callers that replace the whole file. */
export type OpfsWrite = { id: number; path: string; buffer: Uint8Array; offset: number; truncate?: boolean }
export type OpfsWrote = { id: number; size?: number; error?: string }

type SyncHandle = { write(b: Uint8Array, o: { at: number }): number; truncate(size: number): void; flush(): void; getSize(): number; close(): void }
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }

async function resolve(path: string): Promise<SyncFileHandle> {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()!
  let dir = await navigator.storage.getDirectory()
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true })
  return (await dir.getFileHandle(name, { create: true })) as SyncFileHandle
}

self.onmessage = async (e: MessageEvent<OpfsWrite>) => {
  const { id, path, buffer, offset, truncate } = e.data
  try {
    const access = await (await resolve(path)).createSyncAccessHandle()
    try {
      access.write(buffer, { at: offset })
      if (truncate) access.truncate(offset + buffer.byteLength)
      access.flush()
      const size = access.getSize()
      postMessage({ id, size } satisfies OpfsWrote)
    } finally {
      access.close()
    }
  } catch (err) {
    postMessage({ id, error: String(err) } satisfies OpfsWrote)
  }
}
