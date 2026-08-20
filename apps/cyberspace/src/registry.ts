// The program registry: publish, browse, install, recall. All of it speaks
// /v1/programs on the API — the same registry the website terminal serves.

import { fs, paths, type Proc, type Program } from '@cyberspace/kernel'
import { ApiClient, ApiError } from './api.js'

interface Listing {
  id: string
  name: string
  ownerUsername: string
  description: string
  release: number
  publishedAt: number
  isPublished?: boolean
  takenDown?: boolean
}

interface SourceResult {
  id: string
  name: string
  ownerUsername: string
  description: string
  release: number
  source: string
}

const B = (s: string): string => `\x1b[1m${s}\x1b[0m`
const D = (s: string): string => `\x1b[2m${s}\x1b[0m`

function fail(p: Proc, name: string, e: unknown): number {
  p.err(`${name}: ${e instanceof ApiError ? e.message : String((e as Error)?.message ?? e)}\n`)
  return 1
}

function needsLogin(p: Proc, api: ApiClient, name: string): boolean {
  if (api.authed) return false
  p.err(`${name}: not logged in\n`)
  return true
}

/** `author/name` → the one listing, or null with the error printed. */
async function find(p: Proc, api: ApiClient, cmd: string, ref: string): Promise<Listing | null> {
  const m = /^([^/]+)\/([^/]+)$/.exec(ref)
  if (!m) {
    p.err(`${cmd}: use author/name\n`)
    return null
  }
  const rows = await api.get<Listing[]>(
    `/v1/programs?author=${encodeURIComponent(m[1])}&name=${encodeURIComponent(m[2])}`)
  if (!rows.length) {
    p.err(`${cmd}: ${ref}: not found\n`)
    return null
  }
  return rows[0]
}

/** The module's own description line, off the source. */
function readDescription(source: string): string {
  const m = /description\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(source)
  return m ? m[2].trim() : ''
}

export function registryPrograms(api: ApiClient): Record<string, Program> {
  // browse            — the gallery
  // browse author/name — print that program's source
  const browse: Program = async p => {
    if (needsLogin(p, api, 'browse')) return 1
    try {
      if (p.argv[1]) {
        const hit = await find(p, api, 'browse', p.argv[1])
        if (!hit) return 1
        const r = await api.get<SourceResult>(`/v1/programs/${hit.id}/source`)
        p.out(D(`# ${r.ownerUsername}/${r.name} v${r.release} — ${r.description}`) + '\n')
        p.out(r.source.endsWith('\n') ? r.source : r.source + '\n')
        return 0
      }
      const rows = await api.get<Listing[]>('/v1/programs?limit=50')
      if (!rows.length) {
        p.out('Nothing published.\n')
        return 0
      }
      for (const r of rows) {
        const ref = `${r.ownerUsername}/${r.name}`
        p.out(`${B(ref.padEnd(28))} ${D(`v${r.release}`)}  ${r.description}\n`)
      }
      p.out(D('browse author/name reads the source. install author/name puts it in ~/bin.') + '\n')
      return 0
    } catch (e) {
      return fail(p, 'browse', e)
    }
  }

  // install author/name — fetch the release into ~/bin, executable
  const install: Program = async p => {
    if (needsLogin(p, api, 'install')) return 1
    if (!p.argv[1]) {
      p.err('usage: install author/name\n')
      return 1
    }
    try {
      const hit = await find(p, api, 'install', p.argv[1])
      if (!hit) return 1
      const r = await api.get<SourceResult>(`/v1/programs/${hit.id}/source`)
      const home = p.env.HOME ?? '/home/guest'
      const dest = paths.join(home, 'bin', r.name)
      await fs.promises.mkdir(paths.join(home, 'bin')).catch(() => {})
      await fs.promises.writeFile(dest, r.source, { mode: 0o755 })
      p.out(`Installed ${r.name} v${r.release} in ~/bin.  ` + D('Read it first: browse ' + p.argv[1]) + '\n')
      return 0
    } catch (e) {
      return fail(p, 'install', e)
    }
  }

  // publish file [note...] — release the file under its basename
  const publish: Program = async p => {
    if (needsLogin(p, api, 'publish')) return 1
    if (!p.argv[1]) {
      p.err('usage: publish file [note]\n')
      return 1
    }
    const path = paths.resolve(p.cwd, p.argv[1])
    let source: string
    try {
      source = String(await fs.promises.readFile(path, 'utf8'))
    } catch {
      p.err(`publish: ${p.argv[1]}: No such file or directory\n`)
      return 1
    }
    const name = paths.basename(path)
    const description = readDescription(source)
    if (!description) {
      p.err('publish: no description found — add description: \'...\' to the program\n')
      return 1
    }
    const note = p.argv.slice(2).join(' ')
    try {
      const r = await api.post<{ name: string; release: number; unchanged?: boolean; restored?: boolean }>(
        '/v1/programs', { name, description, source, ...(note ? { note } : {}) })
      if (r.unchanged) p.out(`${r.name} v${r.release} is already published, unchanged.\n`)
      else if (r.restored) p.out(`Restored ${r.name} v${r.release}.\n`)
      else p.out(`Published ${r.name} v${r.release}.\n`)
      return 0
    } catch (e) {
      return fail(p, 'publish', e)
    }
  }

  // recall name — take your program out of the gallery
  const recall: Program = async p => {
    if (needsLogin(p, api, 'recall')) return 1
    if (!p.argv[1]) {
      p.err('usage: recall name\n')
      return 1
    }
    try {
      const mine = await api.get<Listing[]>('/v1/programs?mine=1')
      const hit = mine.find(r => r.name === p.argv[1])
      if (!hit) {
        p.err(`recall: ${p.argv[1]}: not one of your programs\n`)
        return 1
      }
      if (!hit.isPublished) {
        p.out(`${hit.name} is not published.\n`)
        return 0
      }
      const r = await api.delete<{ name: string }>(`/v1/programs/${hit.id}`)
      p.out(`Recalled ${r.name}.\n`)
      return 0
    } catch (e) {
      return fail(p, 'recall', e)
    }
  }

  return { browse, install, publish, recall }
}
