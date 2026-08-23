// changelog(1): prints the checked-in CHANGELOG.md as plain text.

import type { Program } from '@cyberspace/kernel'
import source from '../../CHANGELOG.md?raw'

/** No SGR: the pager writes text into cells, so escapes would land as glyphs. */
export function renderChangelog(md: string): string {
  const lines: string[] = []
  for (const line of md.split('\n')) {
    if (line.startsWith('# ')) continue
    if (line.startsWith('## ')) lines.push(line.slice(3))
    else lines.push(line.replace(/`/g, ''))
  }
  return lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '') + '\n'
}

/**
 * The release version: the last `## vX.Y` heading in CHANGELOG.md.
 *
 * tools/version.ts stamps this same value into every package.json.
 */
export const VERSION = [...source.matchAll(/^## v(\S+)/gm)].at(-1)?.[1] ?? '0'

const text = renderChangelog(source)

export const changelog: Program = p => {
  p.out(text)
  return 0
}
