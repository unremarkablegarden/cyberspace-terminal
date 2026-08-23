// Records which gallery rows this machine holds a copy of.
//
// Keyed by registry id rather than name, because two members can both publish a
// `clock` and marking one installed on account of the other would be wrong. The
// value is the local path, because a copy can be renamed, and deleting by the
// gallery's name would then miss it or remove the wrong file.
//
// Plain text rather than JSON so `cat ~/.programs` is readable.

import { fs, paths, readText } from '@cyberspace/kernel'

/** Registry id to the home-relative path it was installed at. */
export type Installed = Map<string, string>

const FILE = '.programs'

const pathOf = (home: string): string => paths.join(home, FILE)

/**
 * Read the index, dropping entries whose file no longer exists.
 *
 * A copy removed with rm stops counting as installed, and its gallery row
 * offers an install again. An unreadable index is treated as empty.
 */
export async function readInstalled(home: string): Promise<Installed> {
  const text = await readText(pathOf(home)).catch(() => '')
  const out: Installed = new Map()
  for (const raw of text.split('\n')) {
    // Trimmed before splitting, so a hand-indented line still parses.
    const line = raw.trim()
    const at = line.indexOf(' ')
    if (at < 1) continue
    const id = line.slice(0, at)
    const rel = line.slice(at + 1).trim()
    if (!id || !rel) continue
    const st = await fs.promises.stat(paths.join(home, rel)).catch(() => null)
    if (st) out.set(id, rel)
  }
  return out
}

/** Best-effort: a failure to record must not fail the install itself. */
export async function writeInstalled(home: string, index: Installed): Promise<void> {
  const body = [...index].map(([id, rel]) => `${id} ${rel}`).join('\n')
  await fs.promises.writeFile(pathOf(home), body ? body + '\n' : '').catch(() => {})
}

/** Record one installed copy. Re-reads first, so line-mode installs and the gallery agree. */
export async function rememberInstalled(home: string, id: string, rel: string): Promise<void> {
  const index = await readInstalled(home)
  index.set(id, rel)
  await writeInstalled(home, index)
}
