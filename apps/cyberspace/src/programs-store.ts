// Joins ~/bin to the registry.
//
// A program is a file in ~/bin and the registry is a REST API, so the two are
// matched by name, which is what the API keys a member's programs on.
//
// This file holds every registry call the two screens need, so browse and
// publish contain no HTTP of their own.

import { dec, fs, paths, type Proc } from '@cyberspace/kernel'
import type { Runtime } from '@cyberspace/compat/classify'
import type { ApiClient, ApiPage } from './api.js'

/** One row of browse: a published program, the reader's own or another member's. */
export interface PublishedProgram {
  id: string
  name: string
  author: string
  description: string
  /** What it is written against. This machine runs all three. */
  runtime: Runtime
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
  /** The working copy. Empty when the registry holds the program and this machine has no local copy. */
  bytes: Uint8Array
  /** Read off the local file, or off the registry row when there is none. */
  runtime: Runtime
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
  /** Absent from APIs deployed before the field; absent means grid. */
  runtime?: Runtime
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
  runtime?: Runtime
  release: number
  encoding?: 'utf8' | 'base64'
  source: string
}

/** One release, fetched. */
export interface ProgramSource {
  id: string
  name: string
  author: string
  description: string
  runtime: Runtime
  release: number
  /** The release itself: source text for grid and pty, a wasm module for wasi. */
  bytes: Uint8Array
}

/** The kinds this machine can host, which is all of them. */
const RUNTIMES = 'web,term,wasm'

/** The gallery is sorted and filtered in memory, so it is fetched once. */
const BROWSE_LIMIT = 500
const PAGE = 50

/** The API's own cap. Mirrors LIMITS.PROGRAM_DESCRIPTION. */
export const DESCRIPTION_MAX = 256

const enc = new TextEncoder()

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Chunked: String.fromCharCode is applied to the array, and a 2 MB one overflows the stack. */
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

function unbase64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * Extract `description` from the module source, best-effort.
 *
 * A regex rather than a parser: reading the value properly would mean executing
 * the file, and publishing must not run the program. A description written in a
 * form this misses is not found, and publish refuses with the line to add.
 *
 * Two forms, because the two kinds have nowhere in common to put one: a grid
 * program's `description:` inside its object literal, and a program for this
 * machine, whose default export is a function, exporting the line beside it as
 * `export const description = '…'`.
 */
export function readDescription(source: string): string {
  const re = /(?:^|[\s{,])description\s*[:=]\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/
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
   * Paged because the route caps a page at 50, and followed by its cursor to
   * the end. The route filters rows its query could not — a taken-down
   * program, a kind this machine did not ask for — so a page can come back
   * short, or empty, with pages still behind it. A null cursor is the only
   * end marker.
   */
  async gallery(): Promise<PublishedProgram[]> {
    const rows: PublishedProgram[] = []
    let before: string | null = null
    while (rows.length < BROWSE_LIMIT) {
      const q = `/v1/programs?limit=${PAGE}&runtime=${RUNTIMES}${before ? `&before=${before}` : ''}`
      // Annotated because `before` is written from the answer and read into the
      // next request, which tsc cannot infer its way around.
      const page: ApiPage<Listing> = await this.api.page<Listing>(q)
      for (const r of page.rows) {
        rows.push({
          id: r.id,
          name: r.name,
          author: r.ownerUsername,
          description: r.description ?? '',
          runtime: r.runtime ?? 'web',
          release: r.release,
          publishedAt: r.publishedAt,
          mine: !!this.api.username && r.ownerUsername === this.api.username,
        })
      }
      // A cursor that has not moved would fetch the same page again, so it
      // ends the listing as a null one does.
      if (!page.cursor || page.cursor === before) break
      before = page.cursor
    }
    return rows
  }

  /**
   * One release of a published program, for reading before installing.
   *
   * `release` pins a version; without it the current one is served. Old
   * releases are immutable objects the registry never overwrites, so a pinned
   * fetch is exactly what went out under that number.
   */
  async fetch(id: string, release?: number): Promise<ProgramSource> {
    const q = release ? `?release=${release}` : ''
    const r = await this.api.get<SourceResult>(`/v1/programs/${id}/source${q}`)
    return {
      id: r.id,
      name: r.name,
      author: r.ownerUsername,
      description: r.description ?? '',
      runtime: r.runtime ?? 'web',
      release: r.release,
      bytes: r.encoding === 'base64' ? unbase64(r.source) : enc.encode(r.source),
    }
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
    // The classifier carries a JS parser (~130 KB), so it is loaded here rather
    // than imported at the top — the same reason guard.js is loaded on demand.
    const { classify, isWasm } = await import('@cyberspace/compat/classify')

    for (const name of names) {
      const path = paths.join(this.bin, name)
      const st = await fs.promises.stat(path).catch(() => null)
      if (!st || st.isDirectory()) continue

      const bytes: Uint8Array = await fs.promises.readFile(path).catch(() => new Uint8Array())
      const wasm = isWasm(bytes)
      // A binary has no description to read, so the registry's is all there is.
      const source = wasm ? '' : dec.decode(bytes)
      // What the file IS decides whether it can be published, not its mode.
      // OPFS keeps no permissions: @zenfs/dom rebuilds the index at 0o644 on
      // every reload, so an execute bit here survives one session at most. The
      // test that holds is the one the kernel applies before running a file: a
      // wasm module, or a module with a default export.
      const runtime = wasm ? 'wasm' : classify(source)
      if (!runtime) continue
      const r = byName.get(name)
      byName.delete(name)
      out.push({
        id: r?.id ?? '',
        name,
        path: this.rel(path),
        bytes,
        runtime,
        description: readDescription(source) || r?.description || '',
        release: r?.release ?? 0,
        published: r?.isPublished ?? false,
        takenDown: r?.takenDown ?? false,
        changed: await this.changed(bytes, r),
      })
    }

    for (const r of byName.values()) {
      out.push({
        id: r.id,
        name: r.name,
        path: this.rel(paths.join(this.bin, r.name)),
        bytes: new Uint8Array(),
        runtime: r.runtime ?? 'web',
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
  private async changed(bytes: Uint8Array, r?: Listing): Promise<boolean> {
    if (!r || r.release < 1) return false
    if (!r.hash) return true
    return await sha256(bytes) !== r.hash
  }

  /**
   * Publish the working copy as the next version.
   *
   * Returns `unchanged` rather than creating an identical version when the
   * working copy matches the release byte for byte, and `restored` when that
   * puts a recalled program back at its own version.
   */
  async publish(p: StoredProgram, note?: string): Promise<'published' | 'unchanged' | 'restored'> {
    // No local copy: this is a restore, and the bytes to send back are the ones
    // the registry already holds.
    const bytes = p.bytes.length ? p.bytes : (await this.fetch(p.id)).bytes
    const binary = p.runtime === 'wasm'
    const r = await this.api.post<{ release: number; unchanged?: boolean; restored?: boolean }>(
      '/v1/programs',
      {
        name: p.name,
        description: p.description,
        runtime: p.runtime,
        encoding: binary ? 'base64' : 'utf8',
        source: binary ? base64(bytes) : dec.decode(bytes),
        ...(note ? { note } : {}),
      },
    )
    return r.unchanged ? 'unchanged' : r.restored ? 'restored' : 'published'
  }

  /** Hide a published program. Members already holding a copy keep it. */
  async recall(id: string): Promise<void> {
    await this.api.delete(`/v1/programs/${id}`)
  }

  /**
   * Delete the registry record, releases and all.
   *
   * Recall hides a program and keeps its slot; this is what gives the slot back
   * against the member's program limit. Copies other members installed are
   * theirs and are unaffected.
   */
  async purge(id: string): Promise<void> {
    await this.api.delete(`/v1/programs/${id}?purge=1`)
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
