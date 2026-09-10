// Unsent writing: the entry in the composer and the reply in the box, kept
// outside the program so its exit does not take them.
//
// The feed already parks its position in the session state, but that blob goes
// with the job and is written only when the page hides. A draft has to outlive
// a killed tab, so it goes to the host's own store (localStorage on the web)
// as it is typed. A host with no store keeps drafts for the page's lifetime,
// as before.

import type { PostDraft } from './feedutil.js'

/** The host's key/value slot. Same shape as the one ApiClient and HomeKey take. */
export interface DraftStore {
  get(): string | null
  set(v: string | null): void
}

/** An unsent reply, and who it answers. */
export interface ReplyDraft {
  text: string
  parentId?: string
  parentUsername?: string
}

interface Kept<T> { at: number; d: T }

interface Blob {
  v: number
  /** The member who typed it. Another member's drafts are never shown. */
  user: string
  post?: Kept<PostDraft>
  replies: Record<string, Kept<ReplyDraft>>
}

const VERSION = 1
/** Replies kept, newest first. */
const REPLY_KEEP = 10
/** Age at which a draft is dropped, in ms. */
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
/** Cap on the serialised blob, in characters. Replies go before the entry does. */
const MAX_CHARS = 128 * 1024
/** Writes coalesced this long, in ms, so a keystroke is not a store round trip. */
const DEBOUNCE_MS = 400

const empty = (): Blob => ({ v: VERSION, user: '', replies: {} })

const blank = (d: PostDraft): boolean => !d.title && !d.body && !d.topics

/** The blob if it parses, is this version and belongs to `user`. Anything else is nothing. */
function read(raw: string | null, user: string, now: number): Blob {
  const none = { ...empty(), user }
  if (!raw) return none
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return none
  }
  if (!parsed || typeof parsed !== 'object') return none
  const b = parsed as Partial<Blob>
  if (b.v !== VERSION || b.user !== user) return none

  const out: Blob = { ...empty(), user }
  if (b.post && typeof b.post === 'object' && fresh(b.post.at, now)) {
    const d = b.post.d as Partial<PostDraft> | undefined
    if (d && typeof d.body === 'string') {
      out.post = {
        at: Number(b.post.at) || now,
        d: {
          title: str(d.title),
          body: d.body,
          topics: str(d.topics),
          blog: d.blog === true,
          nsfw: d.nsfw === true,
          vent: d.vent === true,
        },
      }
    }
  }
  const replies = (b.replies ?? {}) as Record<string, Partial<Kept<ReplyDraft>>>
  for (const [id, kept] of Object.entries(replies)) {
    const d = kept?.d as Partial<ReplyDraft> | undefined
    if (!d || typeof d.text !== 'string' || !d.text || !fresh(kept.at, now)) continue
    out.replies[id] = {
      at: Number(kept.at) || now,
      d: {
        text: d.text,
        ...(typeof d.parentId === 'string' && { parentId: d.parentId }),
        ...(typeof d.parentUsername === 'string' && { parentUsername: d.parentUsername }),
      },
    }
  }
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const fresh = (at: unknown, now: number): boolean => {
  const t = Number(at)
  return Number.isFinite(t) && now - t < MAX_AGE
}

/**
 * The drafts of one member, in one place.
 *
 * Every setter is called per keystroke; the write to the store is debounced and
 * flushed when the program ends.
 */
export class FeedDrafts {
  private blob: Blob
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(private store: DraftStore | undefined, user: string, private now = () => Date.now()) {
    this.blob = read(store?.get() ?? null, user, this.now())
  }

  post(): PostDraft | null {
    return this.blob.post?.d ?? null
  }

  setPost(d: PostDraft | null): void {
    if (!d || blank(d)) {
      if (!this.blob.post) return
      delete this.blob.post
    } else {
      this.blob.post = { at: this.now(), d: { ...d } }
    }
    this.touch()
  }

  reply(postId: string): ReplyDraft | null {
    return this.blob.replies[postId]?.d ?? null
  }

  setReply(postId: string, d: ReplyDraft | null): void {
    if (!d || !d.text.trim()) {
      if (!this.blob.replies[postId]) return
      delete this.blob.replies[postId]
    } else {
      this.blob.replies[postId] = { at: this.now(), d: { ...d } }
    }
    this.touch()
  }

  /** Write now. Called when the program ends, where a pending timer would never fire. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty) return
    this.dirty = false
    this.write()
  }

  private touch(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, DEBOUNCE_MS)
  }

  private write(): void {
    const store = this.store
    if (!store) return
    this.prune()
    const has = this.blob.post || Object.keys(this.blob.replies).length
    try {
      store.set(has ? JSON.stringify(this.blob) : null)
    } catch {
      // A full or refused store: the draft stays in the program and is lost
      // on the next reload.
    }
  }

  /** Newest replies first, then whatever fits the cap. The entry draft is the last to go. */
  private prune(): void {
    const order = Object.entries(this.blob.replies).sort((a, b) => b[1].at - a[1].at)
    let kept = order.slice(0, REPLY_KEEP)
    this.blob.replies = Object.fromEntries(kept)
    while (JSON.stringify(this.blob).length > MAX_CHARS && kept.length) {
      kept = kept.slice(0, -1)
      this.blob.replies = Object.fromEntries(kept)
    }
  }
}
