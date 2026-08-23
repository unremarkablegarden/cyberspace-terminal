import { fs } from '@zenfs/core'

/**
 * The skeleton home directory, bundled at build time. Equivalent to /etc/skel.
 *
 * Every file under skel/home/ is copied into a new home directory, preserving
 * its relative path. Adding a file there is the only step needed.
 */
// Two patterns because the glob skips dotfiles unless matched explicitly, and
// a home directory is mostly dotfiles.
const FILES = import.meta.glob(['./home/**/*', './home/**/.*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Relative path to contents, with the glob's './home/' prefix removed. */
export const SKEL: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, text]) => [path.replace('./home/', ''), text]),
)

/**
 * Copy the skeleton into `root`, writing only files that are not already there.
 *
 * A home directory persists across visits, so a file the operator has edited or
 * deleted is left alone.
 */
export async function installSkel(root: string): Promise<void> {
  for (const [rel, text] of Object.entries(SKEL)) {
    const path = `${root}/${rel}`
    const dir = path.slice(0, path.lastIndexOf('/'))
    if (dir !== root) await fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
    if (await fs.promises.stat(path).catch(() => null)) continue
    await fs.promises.writeFile(path, text).catch(() => {})
  }
}
