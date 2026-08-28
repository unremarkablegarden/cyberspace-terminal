import { writeBin } from './write'

/**
 * The contents of ~/bin that belong to the machine rather than to the operator:
 * the manual, and the worked examples.
 *
 * Bundled at build time and rewritten on every boot, so the manual describes the
 * machine running it. The home directory is OPFS and persists, so a stale copy
 * would otherwise outlive the code it documents. Adding a file here is the only
 * step needed.
 *
 * They are ordinary writable files. A path table enforced across edit, rm, mv,
 * cp, touch and shell redirection would be six enforcement points for three
 * files, and the property that matters is that the text tracks the code, which
 * rewriting delivers on its own.
 */
const DOC = import.meta.glob('./doc/*.txt', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Extensionless, as `./examples/clock` runs one. */
const EXAMPLES = import.meta.glob('./examples/*.js', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export const installBin = (home: string): Promise<void> => writeBin(home, DOC, EXAMPLES)
