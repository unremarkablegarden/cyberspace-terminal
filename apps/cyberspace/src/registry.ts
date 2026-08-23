// The program registry: publish, browse, install, recall, over /v1/programs.
// The same registry the website terminal serves.
//
// browse and publish are full-screen and live in their own files. This file
// holds the line-mode forms, which do not take the grid, so a program can be
// read, fetched or installed from a script or a pipe.

import { fs, paths, type Proc, type Program } from '@cyberspace/kernel'
import { ApiClient, ApiError } from './api.js'
import { SILENT, type ChatSound } from './chat.js'
import { browseProgram } from './browse.js'
import { publishProgram } from './publish.js'
import { rememberInstalled } from './installed.js'

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

/** Look up one `author/name` listing. Returns null after printing the error. */
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

export function registryPrograms(api: ApiClient, snd: ChatSound = SILENT): Record<string, Program> {
  const gallery = browseProgram(api, snd)

  // browse             list every published program
  // browse author/name print that program's source
  const browse: Program = async p => {
    if (!p.argv[1]) return gallery(p)
    if (needsLogin(p, api, 'browse')) return 1
    try {
      const hit = await find(p, api, 'browse', p.argv[1])
      if (!hit) return 1
      const r = await api.get<SourceResult>(`/v1/programs/${hit.id}/source`)
      p.out(D(`# ${r.ownerUsername}/${r.name} v${r.release} — ${r.description}`) + '\n')
      p.out(r.source.endsWith('\n') ? r.source : r.source + '\n')
      return 0
    } catch (e) {
      return fail(p, 'browse', e)
    }
  }

  // install author/name fetch the release into ~/bin, mode 755
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
      // Refused before the file is written, as the gallery does: a program that
      // can never run should not sit in ~/bin looking installed.
      const { inspect, refusalLines } = await import('@cyberspace/compat/guard')
      const hits = inspect(r.source)
      if (hits.length) {
        for (const line of refusalLines(r.name, hits)) p.err(line.text + '\n')
        return 1
      }
      const home = p.env.HOME ?? '/home/guest'
      const dest = paths.join(home, 'bin', r.name)
      await fs.promises.mkdir(paths.join(home, 'bin')).catch(() => {})
      await fs.promises.writeFile(dest, r.source, { mode: 0o755 })
      // Recorded against the registry id, so browse marks the row installed.
      await rememberInstalled(home, hit.id, `bin/${r.name}`)
      p.out(`Installed ${r.name} v${r.release} in ~/bin.  ` + D('Read it first: browse ' + p.argv[1]) + '\n')
      return 0
    } catch (e) {
      return fail(p, 'install', e)
    }
  }

  // recall name        remove the reader's own program from the gallery
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

  return { browse, install, recall, publish: publishProgram(api, snd) }
}
