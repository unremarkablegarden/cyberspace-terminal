import { fs } from '@zenfs/core'

/**
 * Write `text` to `path` only when the bytes differ.
 *
 * An unconditional write on every boot bumps an mtime that `ls -l` shows, and
 * OPFS flushes writes asynchronously (docs/design/vfs.md), so rewriting an
 * unchanged file is a race for nothing.
 */
async function writeIfChanged(path: string, text: string, mode: number): Promise<void> {
  const current = await fs.promises.readFile(path, 'utf8').catch(() => null)
  if (current === text) return
  await fs.promises.writeFile(path, text, { mode }).catch(() => {})
}

/** Basename of a glob key or a path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Rebuild ~/bin's manual and examples under `home`.
 *
 * Takes the files rather than reading them, so index.ts owns the build-time
 * glob and this stays runnable outside vite.
 */
export async function writeBin(
  home: string,
  doc: Record<string, string>,
  examples: Record<string, string>,
): Promise<void> {
  const bin = `${home}/bin`
  await fs.promises.mkdir(bin).catch(() => {})
  await fs.promises.mkdir(`${bin}/examples`).catch(() => {})

  for (const [path, text] of Object.entries(doc)) {
    await writeIfChanged(`${bin}/${basename(path)}`, text, 0o644)
  }
  for (const [path, source] of Object.entries(examples)) {
    await writeIfChanged(`${bin}/examples/${basename(path).replace(/\.js$/, '')}`, source, 0o755)
  }
}
