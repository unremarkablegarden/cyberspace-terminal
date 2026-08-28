// The program registry: publish, browse, install, recall, over /v1/programs.
// The same registry the website terminal serves.
//
// browse and publish are full-screen and live in their own files. This file
// holds the line-mode forms, which do not take the grid, so a program can be
// read, fetched or installed from a script or a pipe.

import { dec, fs, paths, type Proc, type Program } from '@cyberspace/kernel'
import { ApiClient, ApiError } from './api.js'
import { SILENT, type ChatSound } from './chat.js'
import { browseProgram } from './browse.js'
import { publishProgram } from './publish.js'
import { ProgramStore } from './programs-store.js'
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

/** A program named on the command line: `author/name`, or `author/name@2`. */
interface Ref {
  author: string
  name: string
  /** Undefined asks for the current release. */
  release?: number
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

/** Parse `author/name` or `author/name@3`. Null after printing the error. */
function parseRef(p: Proc, cmd: string, raw: string): Ref | null {
  const m = /^([^/@]+)\/([^/@]+)(?:@(\d+))?$/.exec(raw)
  if (!m) {
    p.err(`${cmd}: use author/name or author/name@version\n`)
    return null
  }
  const release = m[3] ? Number(m[3]) : undefined
  if (release !== undefined && release < 1) {
    p.err(`${cmd}: ${raw}: no such version\n`)
    return null
  }
  return { author: m[1]!, name: m[2]!, release }
}

/** Look up one `author/name` listing. Returns null after printing the error. */
async function find(p: Proc, api: ApiClient, cmd: string, ref: Ref): Promise<Listing | null> {
  const rows = await api.get<Listing[]>(
    `/v1/programs?author=${encodeURIComponent(ref.author)}&name=${encodeURIComponent(ref.name)}`)
  if (!rows.length) {
    p.err(`${cmd}: ${ref.author}/${ref.name}: not found\n`)
    return null
  }
  return rows[0]
}

export function registryPrograms(api: ApiClient, snd: ChatSound = SILENT): Record<string, Program> {
  const gallery = browseProgram(api, snd)

  // browse               list every published program
  // browse author/name    print that program's source
  // browse author/name@2  print an earlier version of it
  const browse: Program = async p => {
    if (!p.argv[1]) return gallery(p)
    if (needsLogin(p, api, 'browse')) return 1
    try {
      const ref = parseRef(p, 'browse', p.argv[1])
      if (!ref) return 1
      const hit = await find(p, api, 'browse', ref)
      if (!hit) return 1
      const r = await new ProgramStore(api, p).fetch(hit.id, ref.release)
      if (r.runtime === 'wasm') {
        p.err(`browse: ${r.name}: binary\n`)
        return 1
      }
      const source = dec.decode(r.bytes)
      p.out(D(`# ${r.author}/${r.name} v${r.release} — ${r.description}`) + '\n')
      p.out(source.endsWith('\n') ? source : source + '\n')
      return 0
    } catch (e) {
      return fail(p, 'browse', e)
    }
  }

  // install author/name    fetch the release into ~/bin, mode 755
  // install author/name@2   fetch that version instead of the current one
  const install: Program = async p => {
    if (needsLogin(p, api, 'install')) return 1
    if (!p.argv[1]) {
      p.err('usage: install author/name[@version]\n')
      return 1
    }
    try {
      const ref = parseRef(p, 'install', p.argv[1])
      if (!ref) return 1
      const hit = await find(p, api, 'install', ref)
      if (!hit) return 1
      const r = await new ProgramStore(api, p).fetch(hit.id, ref.release)
      // Refused before the file is written, as the gallery does: a program that
      // can never run should not sit in ~/bin looking installed. A wasm module
      // is not read — it has stdio and nothing else, and holds no JS to parse.
      if (r.runtime !== 'wasm') {
        const { inspect, refusalLines } = await import('@cyberspace/compat/guard')
        const hits = inspect(dec.decode(r.bytes))
        if (hits.length) {
          for (const line of refusalLines(r.name, hits)) p.err(line.text + '\n')
          return 1
        }
      }
      const home = p.env.HOME ?? '/home/guest'
      const dest = paths.join(home, 'bin', r.name)
      await fs.promises.mkdir(paths.join(home, 'bin')).catch(() => {})
      await fs.promises.writeFile(dest, r.bytes, { mode: 0o755 })
      // Recorded against the registry id, so browse marks the row installed.
      await rememberInstalled(home, hit.id, `bin/${r.name}`)
      const read = r.runtime === 'wasm' ? '' : '  ' + D('Read it first: browse ' + p.argv[1])
      p.out(`Installed ${r.name} v${r.release} in ~/bin — run it with ${r.name}.${read}\n`)
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
