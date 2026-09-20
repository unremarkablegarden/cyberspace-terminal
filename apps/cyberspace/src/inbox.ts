// Notifications: the wording and routing tables, and the background service
// that polls for new ones. The list program is inboxui.ts.
//
// The API has no live channel for notifications, so the service polls
// /v1/notifications/unread-count. C-Mail never writes a notification; it is
// followed on user_conversations/<uid> and turned into a notice here.

import type { ApiClient } from './api.js'
import { followList } from './chatui.js'

export interface Notice {
  id: string
  type: string
  actorUsername?: string
  targetId?: string
  targetType?: 'post' | 'reply'
  read: boolean
  /** ISO 8601. */
  createdAt: string
  reason?: string
  metadata?: Record<string, unknown>
}

/** Id prefix of a notice made from a C-Mail unread count; the server has no such row. */
export const MAIL_ID = 'mail-'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const capabilities = (v: unknown): string =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').join(', ') : ''

/** What happened, without the actor. Wording is the website's. */
function verb(n: Notice): string {
  const m = n.metadata ?? {}
  switch (n.type) {
    case 'bookmark': return 'saved your entry'
    case 'reply': return 'replied to you'
    case 'thread_reply': return 'replied in a watched thread'
    case 'new_follower': return 'followed you'
    case 'unfollowed': return 'unfollowed you'
    case 'new_post_following':
    case 'new_post_friend': return 'published an entry'
    case 'poke': return 'poked you'
    case 'chat_mention': {
      const room = str(m.roomSlug) || str(n.targetId)
      return `mentioned you in ${room ? '#' + room : str(m.roomName) || 'chat'}`
    }
    case 'graffiti_mention': return 'mentioned you in graffiti'
    case 'post_mention': return 'mentioned you in a post'
    case 'reply_mention': return 'mentioned you in a reply'
    case 'dm_message': return 'sent you a C-Mail'
    case 'guild_new_thread': return `posted a new thread in ${str(m.guildName) || 'your guild'}`
    case 'guild_chat_message': return `posted in ${str(m.guildName) || 'your guild'} chat`
    case 'supporter_granted': return 'upgraded you to a supporter account'
    case 'supporter_removed': return 'removed your supporter status'
    case 'hacker_granted': return 'granted you hacker status'
    case 'hacker_removed': return 'removed your hacker status'
    case 'image_permission_granted': return 'granted you image permission'
    case 'image_permission_removed': return 'removed your image permission'
    case 'attachment_permission_granted': return 'granted you attachment permission'
    case 'attachment_permission_removed': return 'removed your attachment permission'
    case 'api_access_granted': return 'granted you API access'
    case 'api_access_removed': return 'removed your API access'
    case 'edit_access_granted': return 'granted you edit access'
    case 'edit_access_removed': return 'removed your edit access'
    case 'moderator_granted': {
      const caps = capabilities(m.addedPermissions)
      return caps ? `made you a moderator: ${caps}` : 'made you a moderator'
    }
    case 'moderator_removed': return 'removed your moderator status'
    case 'moderator_permissions_changed': {
      const added = capabilities(m.addedPermissions)
      const removed = capabilities(m.removedPermissions)
      if (added && !removed) return `granted you: ${added}`
      if (removed && !added) return `revoked: ${removed}`
      return 'updated your moderator permissions'
    }
    case 'gift_received': return `gave you ${giftMonths(m.months)} of supporter status`
    case 'gift_sent': return 'received your gift'
    default: return 'interacted with you'
  }
}

const giftMonths = (v: unknown): string =>
  typeof v === 'number' && v > 0 ? `${v} month${v === 1 ? '' : 's'}` : 'a gift'

/** Types the platform sends; they have no member behind them. */
function systemText(n: Notice): string | null {
  switch (n.type) {
    case 'system_ban': return `Account banned. ${n.reason || 'Rate limit exceeded'}.`
    case 'system_ban_lifted': return 'Ban lifted.'
    case 'rate_limit_warning': return `Rate limit warning. ${n.reason ?? ''}`.trim()
    case 'post_cooldown': return `Post held; saved as a note. ${n.reason ?? ''}`.trim()
    default: return null
  }
}

/** One line for a notice: `@actor did something`, or the platform's own text. */
export function noticeText(n: Notice): string {
  const sys = systemText(n)
  if (sys) return sys
  const actor = n.actorUsername && n.actorUsername !== 'system' ? `@${n.actorUsername}` : 'system'
  return `${actor} ${verb(n)}`
}

/**
 * The command line that opens what a notice points at, or null when there is
 * nothing to open here. A bookmark on a reply carries the reply id as its
 * target and no post id, so it needs `openLine` instead.
 */
export function noticeTarget(n: Notice): string | null {
  const m = n.metadata ?? {}
  const reply = str(m.replyId)
  const thread = (post: string): string | null =>
    post ? `feed -p ${post}${reply ? ` ${reply}` : ''}` : null
  switch (n.type) {
    case 'bookmark':
      if (n.targetType === 'reply') return null
      return thread(str(n.targetId))
    case 'reply':
    case 'thread_reply':
    case 'reply_mention':
      return thread(str(m.postId) || str(n.targetId))
    case 'post_mention':
    case 'new_post_following':
    case 'new_post_friend':
      return n.targetId ? `feed -p ${n.targetId}` : null
    case 'guild_new_thread': {
      const id = str(m.threadId) || str(n.targetId)
      return id ? `feed -p ${id}` : null
    }
    case 'new_follower':
    case 'unfollowed':
    case 'poke':
      return n.actorUsername ? `feed @${n.actorUsername}` : null
    case 'chat_mention':
    case 'guild_chat_message':
      return n.targetId ? `circ ${n.targetId}` : null
    case 'dm_message':
      return n.actorUsername ? `cmail @${n.actorUsername}` : null
    default:
      return null
  }
}

/** `noticeTarget`, plus the one case that needs a request to resolve. */
export async function openLine(api: ApiClient, n: Notice): Promise<string | null> {
  const line = noticeTarget(n)
  if (line || n.type !== 'bookmark' || n.targetType !== 'reply' || !n.targetId) return line
  try {
    const r = await api.get<{ postId?: string }>(`/v1/replies/${encodeURIComponent(n.targetId)}`)
    return r.postId ? `feed -p ${r.postId} ${n.targetId}` : null
  } catch {
    return null
  }
}

/** One row of user_conversations/<uid>, as far as the service reads it. */
interface MailRow {
  otherUserId?: string
  otherUsername?: string
  unreadCount?: number
}

export interface InboxHooks {
  /** A notice that arrived while the machine was up. */
  onNotice?(n: Notice): void
  /** `count` or `mail` changed. */
  onCounts?(): void
  /** True while C-Mail is in front; its own screen shows the message. */
  mailInFront?(): boolean
}

/** Newest rows fetched when the count rises; more than this collapses on the bar. */
const NEW_ROWS = 5
/** The member's preferences are read again after this many polls; a change on the site takes that long to show. */
const PREFS_EVERY = 10
/** No polling for this long after a request fails at the network. */
const HOLD_MS = 5 * 60_000

export class InboxService {
  /** Unread notifications, as the server counts them (capped at 101 there). */
  count = 0
  /** Unread C-Mail messages across all conversations. */
  mail = 0

  private lastSeen = ''
  private primed = false
  private holdUntil = 0
  private busy = false
  private stopMail: (() => void) | null = null
  private rows = new Map<string, MailRow>()
  /**
   * The member's own switches. The server applies them to what it lists and
   * counts, so notifications need nothing here; a C-Mail notice is made on this
   * side and is checked against them: the `dm_message` switch, and the muted
   * and blocked lists.
   */
  private mailOff = false
  private hidden = new Set<string>()
  private polls = 0

  constructor(
    private api: ApiClient,
    private rtdbUrl: string,
    /** Mutable: the machine sets onCounts, the faceplate adds the rest. */
    public hooks: InboxHooks = {},
    private now: () => number = Date.now,
  ) {}

  get total(): number {
    return this.count + this.mail
  }

  private watchers = new Set<() => void>()

  /** Called on every count change until the returned function is called. For a screen that shows a count. */
  watch(fn: () => void): () => void {
    this.watchers.add(fn)
    return () => { this.watchers.delete(fn) }
  }

  private changed(): void {
    this.hooks.onCounts?.()
    for (const fn of this.watchers) fn()
  }

  /** Settles when the counts of the current session are first known. */
  ready: Promise<void> = Promise.resolve()

  /** Call on login. The first poll announces nothing; a backlog is the motd's. */
  start(): void {
    this.stop()
    this.ready = Promise.all([this.poll(), this.mailCount(), this.loadPrefs()]).then(() => {})
    const uid = this.api.userId
    if (!uid) return
    this.stopMail = followList(
      this.api,
      token => `${this.rtdbUrl}/user_conversations/${uid}.json?auth=${token}`,
      (id, data, snapshot, rest) => this.mailEvent(id, data, snapshot, rest),
    )
  }

  stop(): void {
    this.stopMail?.()
    this.stopMail = null
    this.rows.clear()
    this.count = 0
    this.mail = 0
    this.lastSeen = ''
    this.primed = false
    this.holdUntil = 0
    this.mailOff = false
    this.hidden.clear()
    this.polls = 0
    this.changed()
  }

  /** One poll. The caller owns the timer and skips it while the tab is hidden. */
  async poll(): Promise<void> {
    if (this.busy || !this.api.authed || this.now() < this.holdUntil) return
    this.busy = true
    if (++this.polls % PREFS_EVERY === 0) void this.loadPrefs()
    try {
      const { count } = await this.api.get<{ count: number }>('/v1/notifications/unread-count')
      const rose = count > this.count
      if (count !== this.count) {
        this.count = count
        this.changed()
      }
      if (!this.primed || rose) await this.fetchNew()
      this.primed = true
    } catch (e) {
      if ((e as { status?: number }).status === 0) this.holdUntil = this.now() + HOLD_MS
    } finally {
      this.busy = false
    }
  }

  /** Unreachable settings leave the notices on, as the defaults are. */
  private async loadPrefs(): Promise<void> {
    try {
      const [settings, me] = await Promise.all([
        this.api.get<{ notifications?: Record<string, boolean> }>('/v1/settings'),
        this.api.get<{ mutedUsers?: string[]; blockedUsers?: string[] }>('/v1/users/me'),
      ])
      // Absent means enabled; only an explicit false switches a type off.
      this.mailOff = settings.notifications?.dm_message === false
      this.hidden = new Set([...(me.mutedUsers ?? []), ...(me.blockedUsers ?? [])])
    } catch {
      // Kept as they were.
    }
  }

  /**
   * The mail count by request, for the login line. The stream's first snapshot
   * carries the same number and replaces it; whichever lands first is shown.
   */
  private async mailCount(): Promise<void> {
    try {
      const rows = await this.api.get<{ unreadCount?: number }[]>('/v1/cmail')
      if (this.rows.size) return
      const mail = rows.reduce((n, r) => n + (r.unreadCount ?? 0), 0)
      if (mail !== this.mail) {
        this.mail = mail
        this.changed()
      }
    } catch {
      // The stream still delivers it.
    }
  }

  /** What login(1) and the motd say about the counts; empty when there is nothing. */
  lines(): string[] {
    const out: string[] = []
    if (this.mail > 0) out.push('You have C-Mail.')
    if (this.count > 0) out.push(`${this.count > 100 ? '100+' : this.count} ${this.count === 1 ? 'notification' : 'notifications'}.`)
    return out
  }

  /** A notification was marked read elsewhere on the machine. */
  seen(n = 1): void {
    this.count = Math.max(0, this.count - n)
    this.changed()
  }

  private async fetchNew(): Promise<void> {
    const { rows } = await this.api.page<Notice>(`/v1/notifications?read=false&limit=${NEW_ROWS}`)
    const fresh = rows.filter(r => r.createdAt > this.lastSeen)
    if (rows[0] && rows[0].createdAt > this.lastSeen) this.lastSeen = rows[0].createdAt
    if (!this.primed) return
    // Oldest first, so the bar shows them in the order they happened.
    for (const n of fresh.reverse()) this.hooks.onNotice?.(n)
  }

  /**
   * The API writes a recipient's row one field at a time, so an update arrives
   * as a root patch keyed `<cid>/<field>` or as an event at that path, as well
   * as whole rows in the first snapshot.
   */
  private mailEvent(id: string | null, data: unknown, snapshot: boolean, rest: string[]): void {
    const before = new Map([...this.rows].map(([cid, r]) => [cid, r.unreadCount ?? 0]))
    if (id !== null) {
      this.mailSet([id, ...rest], data)
    } else {
      if (snapshot) this.rows.clear()
      for (const [key, value] of Object.entries((data ?? {}) as Record<string, unknown>)) {
        this.mailSet(key.split('/'), value)
      }
    }

    let mail = 0
    for (const [cid, row] of this.rows) {
      const unread = row.unreadCount ?? 0
      mail += unread
      if (snapshot || unread <= (before.get(cid) ?? 0) || this.hooks.mailInFront?.()) continue
      if (this.mailOff || (row.otherUserId && this.hidden.has(row.otherUserId))) continue
      this.hooks.onNotice?.({
        id: `${MAIL_ID}${cid}-${this.now()}`,
        type: 'dm_message',
        actorUsername: row.otherUsername,
        targetId: cid,
        read: false,
        createdAt: new Date(this.now()).toISOString(),
      })
    }
    if (mail !== this.mail) {
      this.mail = mail
      this.changed()
    }
  }

  private mailSet(path: string[], value: unknown): void {
    const [cid, field] = path
    if (!cid) return
    if (!field) {
      if (value === null) this.rows.delete(cid)
      else this.rows.set(cid, { ...this.rows.get(cid), ...(value as MailRow) })
      return
    }
    if (path.length > 2) return
    this.rows.set(cid, { ...this.rows.get(cid), [field]: value })
  }
}
