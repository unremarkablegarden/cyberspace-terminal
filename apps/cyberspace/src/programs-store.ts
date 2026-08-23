// Joins ~/bin to the registry.
//
// A program is a file in ~/bin and the registry is a REST API, so the two are
// matched by name, which is what the API keys a member's programs on.
//
// This file holds every registry call the two screens need, so browse and
// publish contain no HTTP of their own.

import { fs, paths, readText, type Proc } from '@cyberspace/kernel'
import type { ApiClient } from './api.js'

/** One row of browse: a published program, the reader's own or another member's. */
export interface PublishedProgram {
  id: string
  name: string
  author: string
  description: string
  release: number
  /** Epoch ms. */
  publishedAt: number
  /** True for the reader's own program, where browse shows the state instead of an install. */
  mine: boolean
}

/** One program the member holds, in the form the publish screen needs. */
export interface StoredProgram {
  /** The registry's id. Empty when the program has never been published. */
  id: string
  /** The basename, which is what the gallery shows. */
  name: string
  /** Home-relative path including the filename, e.g. `bin/starfield`. */
  path: string
  /** Empty when the registry holds the program and this machine has no local copy. */
  source: string
  description: string
  /** Highest version published; 0 if it never has been. */
  release: number
  /** Currently listed in the gallery. */
  published: boolean
  /** Frozen by a moderator: neither publishable nor restorable. */
  takenDown: boolean
  /** The working copy differs from the published source. */
  changed: boolean
}

interface Listing {
  id: string
  name: string
  ownerUsername: string
  description: string
  release: number
  publishedAt: number
  isPublished?: boolean
  takenDown?: boolean
  /** SHA-256 of the published source. Absent from APIs deployed before this field. */
  hash?: string | null
}

interface SourceResult {
  id: string
  name: string
  ownerUsername: string
  description: string
  release: number
  source: string
}

/** The gallery is sorted and filtered in memory, so it is fetched once. */
const BROWSE_LIMIT = 500
const PAGE = 50

/** The API's own cap. Mirrors LIMITS.PROGRAM_DESCRIPTION. */
const DESCRIPTION_MAX = 256

const enc = new TextEncoder()

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Extract `description` from the module source, best-effort.
 *
 * A regex rather than a parser: reading the value properly would mean executing
 * the file, and publishing must not run the program. A description written in a
 * form this misses is not found, and publish refuses with the line to add.
 */
export function readDescription(source: string): string {
  const re = /(?:^|[\s{,])description\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/
  const hit = source.match(re)
  if (!hit?.[2]) return ''
  // Unescapes only what a single-line string literal can carry; this reads a
  // label rather than reconstructing code.
  return hit[2]
    .replace(/\\n/g, ' ')
    .replace(/\\(['"`\\])/g, '$1')
    .trim()
    .slice(0, DESCRIPTION_MAX)
}

export class ProgramStore {
  constructor(private api: ApiClient, private p: Proc) {}

  private get home(): string {
    return this.p.env.HOME ?? '/home/guest'
  }

  private get bin(): string {
    return paths.join(this.home, 'bin')
  }

  /** Home-relative, matching StoredProgram.path and the installed index. */
  private rel(path: string): string {
    const home = this.home + '/'
    return path.startsWith(home) ? path.slice(home.length) : path
  }

  /**
   * Every published program, by every member.
   *
   * Paged because the route caps a page at 50. Stops at the first short page,
   * so the usual case is a single request.
   */
  async gallery(): Promise<PublishedProgram[]> {
    const rows: PublishedProgram[] = []
    let before: number | null = null
    while (rows.length < BROWSE_LIMIT) {
      const q = `/v1/programs?limit=${PAGE}${before ? `&before=${before}` : ''}`
      const page: Listing[] = await this.api.get<Listing[]>(q)
      for (const r of page) {
        rows.push({
          id: r.id,
          name: r.name,
          author: r.ownerUsername,
          description: r.description ?? '',
          release: r.release,
          publishedAt: r.publishedAt,
          mine: !!this.api.username && r.ownerUsername === this.api.username,
        })
      }
      if (page.length < PAGE) break
      const oldest = page[page.length - 1]?.publishedAt
      if (!oldest || oldest === before) break
      before = oldest
    }
    return rows
  }

  /** The source of a published program, for reading before installing. */
  async source(id: string): Promise<string> {
    const r = await this.api.get<SourceResult>(`/v1/programs/${id}/source`)
    return r.source
  }

  /**
   * The member's own programs, local files joined to registry rows by name.
   *
   * A local file the registry has never seen is a draft. A registry row with no
   * local file is listed too: it can still be recalled, and restoring it needs
   * only the source the registry already holds.
   */
  async list(): Promise<StoredProgram[]> {
    const [names, remote] = await Promise.all([
      fs.promises.readdir(this.bin).catch(() => [] as string[]),
      this.api.get<Listing[]>('/v1/programs?mine=1').catch(() => [] as Listing[]),
    ])
    const byName = new Map(remote.map(r => [r.name, r]))
    const out: StoredProgram[] = []

    for (const name of names) {
      const path = paths.join(this.bin, name)
      const st = await fs.promises.stat(path).catch(() => null)
      if (!st || st.isDirectory()) continue
      // Executables only. Home also holds plain text, which the API refuses.
      if (!((st.mode ?? 0) & 0o111)) continue

      const source = await readText(path).catch(() => '')
      const r = byName.get(name)
      byName.delete(name)
      out.push({
        id: r?.id ?? '',
        name,
        path: this.rel(path),
        source,
        description: readDescription(source) || r?.description || '',
        release: r?.release ?? 0,
        published: r?.isPublished ?? false,
        takenDown: r?.takenDown ?? false,
        changed: await this.changed(source, r),
      })
    }

    for (const r of byName.values()) {
      out.push({
        id: r.id,
        name: r.name,
        path: this.rel(paths.join(this.bin, r.name)),
        source: '',
        description: r.description ?? '',
        release: r.release,
        published: r.isPublished ?? false,
        takenDown: r.takenDown ?? false,
        // No local copy, so there is nothing to compare against the release.
        changed: false,
      })
    }

    return out
  }

  /**
   * Whether the working copy differs from the published source.
   *
   * Compares against the hash the API reports for the last release, so this
   * needs no extra request. An API deployed before that field existed returns
   * nothing, and every published program then reads as edited; the cost is a
   * publish the server answers with `unchanged`, which is already handled.
   */
  private async changed(source: string, r?: Listing): Promise<boolean> {
    if (!r || r.release < 1) return false
    if (!r.hash) return true
    return await sha256(source) !== r.hash
  }

  /**
   * Publish the working copy as the next version.
   *
   * Returns `unchanged` rather than creating an identical version when the
   * working copy matches the release byte for byte, and `restored` when that
   * puts a recalled program back at its own version.
   */
  async publish(p: StoredProgram, note?: string): Promise<'published' | 'unchanged' | 'restored'> {
    const source = p.source || await this.source(p.id)
    const r = await this.api.post<{ release: number; unchanged?: boolean; restored?: boolean }>(
      '/v1/programs',
      { name: p.name, description: p.description, source, ...(note ? { note } : {}) },
    )
    return r.unchanged ? 'unchanged' : r.restored ? 'restored' : 'published'
  }

  /** Hide a published program. Members already holding a copy keep it. */
  async recall(id: string): Promise<void> {
    await this.api.delete(`/v1/programs/${id}`)
  }

  /**
   * Restore a recalled program at the version it was recalled at.
   *
   * There is no dedicated endpoint. The registry restores rather than creates a
   * version when the source it receives matches the release byte for byte, so
   * restore is only offered on an unchanged program, where that holds.
   */
  async restore(p: StoredProgram): Promise<void> {
    await this.publish(p)
  }
}
