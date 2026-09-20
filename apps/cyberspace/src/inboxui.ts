// inbox: one list of what happened elsewhere. Notifications from the API and
// conversations with unread C-Mail. Chat rooms with new messages are not
// listed: a busy room is always unread. A mention in one, or a message in the
// member's own guild chat, arrives as a notification. Enter
// asks the shell to run the program that shows the target (feed, cmail, circ)
// as its own job; this one is stopped by the switch.
//
// A notification is marked read when it is opened, not when the cursor lands
// on it: the mark is one request per row and the route allows 30 a minute.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, Reveal, parseKeys,
  frame, hline, label, cells, plain, wrap,
  ConfirmPopup, TextPopup, YES_NO,
  NORMAL, BRIGHT, BOLD, DIM,
  type Span, type Rect, type KeyInput, type Screen, type TextLine,
} from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { BLIP_HZ, SILENT, hhmm, type ChatSound } from './chat.js'
import { MAIL_ID, noticeText, openLine, type Notice } from './inbox.js'
import { previewLines } from './feed.js'
import { stripImages, toBlocks, type FeedBlock } from './feedutil.js'

const TITLE = 'INBOX'
/** Bump when the tab order changes: a parked tab is an index. */
const STATE_VERSION = 2
/** The unread marker: `N ` or two blanks. */
const MARK_W = 2
/** Width of the right-margin clock: `12:34`, `Mon` or `05/09`. */
const TIME_W = 5
const GAP = 2
const PAGE = 30
/**
 * Pages fetched in a row when they come back empty. The server filters after
 * its query (a type switched off in settings, a muted member), so a page can be
 * empty with a cursor behind it, and a long run of those would otherwise be
 * walked to the end before anything is drawn.
 */
const FILL_PAGES = 3
/** Rows from the end of the list at which the next page is fetched. */
const NEAR_END = 5
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

interface Tab {
  name: string
  /** Notification types listed; empty lists all of them. */
  types: string[]
  /** True when conversations with unread C-Mail are listed; they are not notifications. */
  mail: boolean
  /** False for a tab with nothing to ask the notifications route for. */
  fetch: boolean
}

const REPLIES = ['reply', 'thread_reply']
const MENTIONS = ['chat_mention', 'graffiti_mention', 'post_mention', 'reply_mention']
const ENTRIES = ['new_post_following', 'new_post_friend']
const GUILDS = ['guild_new_thread', 'guild_chat_message']
const OTHER = [
  'bookmark', 'new_follower', 'unfollowed',
  'supporter_granted', 'supporter_removed', 'hacker_granted', 'hacker_removed',
  'moderator_granted', 'moderator_removed', 'moderator_permissions_changed',
  'api_access_granted', 'api_access_removed', 'edit_access_granted', 'edit_access_removed',
  'image_permission_granted', 'image_permission_removed',
  'attachment_permission_granted', 'attachment_permission_removed',
  'system_ban', 'system_ban_lifted', 'post_cooldown', 'rate_limit_warning',
  'gift_received', 'gift_sent',
]

const TABS: Tab[] = [
  { name: 'ALL', types: [], mail: true, fetch: true },
  { name: 'REPLIES', types: REPLIES, mail: false, fetch: true },
  { name: 'MENTIONS', types: MENTIONS, mail: false, fetch: true },
  { name: 'C-MAIL', types: [], mail: true, fetch: false },
  { name: 'ENTRIES', types: ENTRIES, mail: false, fetch: true },
  { name: 'POKES', types: ['poke'], mail: false, fetch: true },
  { name: 'GUILDS', types: GUILDS, mail: false, fetch: true },
  { name: 'OTHER', types: OTHER, mail: false, fetch: true },
]

const HINT: Span[] = [
  { text: ' ↵ ', inverse: true, attr: DIM },
  { text: ' Open ' },
  { text: ' P ', inverse: true, attr: DIM },
  { text: ' Preview ' },
  { text: ' ←→ ', inverse: true, attr: DIM },
  { text: ' Tab ' },
  { text: ' U ', inverse: true, attr: DIM },
  { text: ' Unread ' },
  { text: ' A ', inverse: true, attr: DIM },
  { text: ' Read all ' },
  { text: ' ESC ', inverse: true, attr: DIM },
  { text: ' Exit' },
]

const HINT_NARROW: Span[] = [
  { text: ' ↵ ', inverse: true, attr: DIM },
  { text: ' Open ' },
  { text: ' ESC ', inverse: true, attr: DIM },
  { text: ' Exit' },
]

interface Row {
  notice: Notice
  /** Milliseconds, for the sort and the clock. */
  at: number
  text: string
  /** What was written, after the text. Absent when the notice carries none. */
  preview?: string
  /** Known without a request for the rows made here. */
  line?: string
}

interface MailConv {
  conversationId: string
  otherUser: { username: string; deleted?: boolean }
  lastMessage?: string
  lastMessageAt: number
  unreadCount: number
}

/** What the background service needs to hear so its counts follow this screen. */
export interface InboxCounts {
  count: number
  /** Unread C-Mail messages. */
  mail: number
  watch?(fn: () => void): () => void
  seen(n?: number): void
  poll(): Promise<void>
}

const oneLine = (text: unknown): string =>
  typeof text === 'string' ? plain(text).replace(/\s+/g, ' ').trim() : ''

/** The text a notification carries in its metadata. A reply's is not there; see replyPreview. */
function previewOf(n: Notice): string {
  const m = n.metadata ?? {}
  return oneLine(m.replyContent) || oneLine(m.postContent) || oneLine(m.messageContent)
}

/** Box titles for the types whose name reads badly as one. The rest use the type's own words. */
const BOX_TITLE: Record<string, string> = {
  new_post_following: 'NEW ENTRY',
  new_post_friend: 'NEW ENTRY',
  thread_reply: 'WATCHED THREAD',
  new_follower: 'FOLLOWER',
  dm_message: 'C-MAIL',
  guild_new_thread: 'GUILD THREAD',
  guild_chat_message: 'GUILD CHAT',
}

/** Rows of an entry shown in the preview box; the rest is in feed. */
const PREVIEW_ROWS = 14

/** A fetched reply or entry: markdown parsed as feed parses it, images left out. */
interface Fetched {
  title?: string
  body: FeedBlock[]
}

/** What a row is about, when its text is not in the notification and has to be fetched. */
function sourceOf(n: Notice): { kind: 'reply' | 'post'; id: string } | null {
  const m = n.metadata ?? {}
  const id = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (n.type) {
    case 'reply':
    case 'thread_reply':
      return id(m.replyId) ? { kind: 'reply', id: id(m.replyId) } : null
    case 'bookmark':
      if (!n.targetId) return null
      return { kind: n.targetType === 'reply' ? 'reply' : 'post', id: n.targetId }
    case 'new_post_following':
    case 'new_post_friend':
      return n.targetId ? { kind: 'post', id: n.targetId } : null
    case 'guild_new_thread': {
      const thread = id(m.threadId) || id(n.targetId)
      return thread ? { kind: 'post', id: thread } : null
    }
    default:
      return null
  }
}

function whenLabel(at: number): string {
  if (!at) return ''
  const then = new Date(at)
  const now = new Date()
  if (then.toDateString() === now.toDateString()) return hhmm(at)
  if (now.getTime() - at < WEEK_MS) return then.toDateString().slice(0, 3)
  return `${String(then.getDate()).padStart(2, '0')}/${String(then.getMonth() + 1).padStart(2, '0')}`
}

interface Parked { tab: number; sel: number; unread: boolean }

function readState(raw: unknown): Parked | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.v !== STATE_VERSION) return null
  const tab = Number(s.tab)
  const sel = Number(s.sel)
  if (!Number.isInteger(tab) || tab < 0 || tab >= TABS.length) return null
  if (!Number.isInteger(sel) || sel < 0) return null
  return { tab, sel, unread: s.unread === true }
}

export function inboxProgram(
  api: ApiClient, snd: ChatSound = SILENT, counts?: () => InboxCounts | null,
): Program {
  return async (p: Proc) => {
    if (!api.authed) { p.err('inbox: not logged in\n'); return 1 }
    if (!p.tty) { p.err('inbox: no tty\n'); return 1 }

    const tty = p.tty
    const cols = tty.cols
    const rows = tty.rows
    const s = new Surface(cols, rows)
    const stack = new ScreenStack(s as never)
    const outer: Rect = { x: 0, y: 0, w: cols, h: rows }
    const splitY = rows - 2
    const tabsY = 1
    const list: Rect = { x: 2, y: 3, w: cols - 4, h: splitY - 3 }

    let running = true
    let tab = 0
    let cursor = 0
    let unreadOnly = false
    let items: Row[] = []
    let extras: Row[] = []
    let next: string | null | undefined = undefined
    let loading = true
    let status = ''
    /** Bumped on every reload; a page that answers an older one is dropped. */
    let epoch = 0

    /**
     * Lists already fetched, by tab and unread filter, so changing tab costs no
     * request. Dropped whole when something may have changed on the server: the
     * unread count rose, read-all ran, or the program came back to the front.
     */
    const cache = new Map<string, { items: Row[]; next: string | null | undefined; sel: number }>()
    const cacheKey = (): string => `${tab}:${unreadOnly ? 'u' : 'a'}`
    /** Keep the list on screen for its tab. A list still loading is not complete enough to keep. */
    const stash = (): void => { if (!loading) cache.set(cacheKey(), { items, next, sel: cursor }) }
    /** Show the tab now selected: from the cache if it is there, else by request. */
    const show = (): void => {
      const hit = cache.get(cacheKey())
      if (!hit) { void reload(); return }
      // Cancels a request still out for the tab just left.
      epoch++
      items = hit.items
      next = hit.next
      cursor = Math.min(hit.sel, Math.max(0, hit.items.length - 1))
      loading = false
      status = ''
      draw()
    }

    /** What P fetched, by `kind:id`; null for one that could not be read. */
    const fetched = new Map<string, Fetched | null>()

    const reveal = new Reveal({ onTick: () => draw(), onBlip: () => snd.blip(BLIP_HZ) })
    const paintNow = (): void => { tty.paint(s.render()) }
    const open = (screen: Screen): void => { stack.push(screen); paintNow() }
    const close = (): void => { stack.pop(); s.invalidate(); draw() }
    const park = (): void => { p.setState({ v: STATE_VERSION, tab, sel: cursor, unread: unreadOnly }) }

    /** Notifications and the rows made here, newest first. */
    const shown = (): Row[] => {
      const made = TABS[tab]!.mail ? extras : []
      return [...items, ...made].sort((a, b) => b.at - a.at)
    }

    const capped = (n: number): string => (n > 99 ? '99+' : String(n))

    /** `INBOX (5)`: everything unread, notifications and C-Mail together. */
    const title = (): string => {
      const c = counts?.()
      const n = c ? c.count + c.mail : 0
      return n > 0 ? `${TITLE} (${capped(n)})` : TITLE
    }

    function drawTabs(): void {
      let x = list.x
      // The server counts unread notifications as one number, not by type, so
      // only the C-Mail tab has a count of its own.
      const mail = counts?.()?.mail ?? 0
      TABS.forEach((t, i) => {
        const own = !t.fetch && mail > 0 ? ` (${capped(mail)})` : ''
        const text = ` ${t.name}${own} `
        if (x + text.length > list.x + list.w) return
        s.text(x, tabsY, text, i === tab ? DIM | BOLD : NORMAL, i === tab ? 1 : 0)
        x += text.length + 1
      })
      hline(s, tabsY + 1, 0, cols - 1)
    }

    function draw(): void {
      if (!running || stack.active) return
      s.clear()
      frame(s, outer)
      label(s, outer, title(), { align: 'right', attr: BOLD })
      label(s, outer, cols >= 72 ? HINT : HINT_NARROW, { edge: 'bottom', align: 'right' })
      if (unreadOnly) label(s, outer, 'UNREAD ONLY')
      drawTabs()

      const all = shown()
      if (loading && !all.length) {
        s.text(list.x + ((list.w - 7) >> 1), list.y + (list.h >> 1), 'LOADING', DIM)
      } else if (!all.length) {
        const none = next ? 'None so far; ⬇ for older.' : unreadOnly ? 'Nothing unread.' : 'Nothing here.'
        s.text(list.x, list.y, none, DIM)
      } else {
        const count = Math.min(all.length, reveal.count)
        const first = Math.max(0, Math.min(cursor - (list.h >> 1), Math.max(0, all.length - list.h)))
        for (let i = 0; i < list.h; i++) {
          const row = all[first + i]
          if (!row || first + i >= count) break
          const on = first + i === cursor
          const y = list.y + i
          const unread = !row.notice.read
          const mark = (unread ? 'N' : '').padEnd(MARK_W)
          const room = Math.max(0, list.w - MARK_W - TIME_W - GAP)
          // Only what the row carries. A reply's text is a request of its own; P shows it.
          const body = (row.preview ? `${row.text}: ${row.preview}` : row.text).slice(0, room)
          // The bar is DIM: on an inverted row the attribute applies to the background.
          s.text(list.x, y, (mark + body).padEnd(list.w), on ? DIM : unread ? NORMAL : DIM, on ? 1 : 0)
          if (unread) s.text(list.x, y, mark, BRIGHT, on ? 1 : 0)
          // The member's name, as in the mailbox: BRIGHT|BOLD, DIM|BOLD inside the bar or on a read row.
          const who = /^@\S+/.exec(body)?.[0]
          if (who) s.text(list.x + MARK_W, y, who, on || !unread ? DIM | BOLD : BRIGHT | BOLD, on ? 1 : 0)
          s.text(list.x + list.w - TIME_W, y, whenLabel(row.at).padStart(TIME_W), DIM, on ? 1 : 0)
        }
      }

      hline(s, splitY, 0, cols - 1)
      const note = status || (loading ? 'LOADING' : next === null || !TABS[tab]!.fetch ? '~EOF~' : 'MORE')
      if (note) s.text(cols - 4 - cells(note), splitY, ` ${note} `, status ? BRIGHT : DIM)
      s.showCursor = false
      paintNow()
    }

    const query = (cursorId?: string): string => {
      const t = TABS[tab]!
      let q = `/v1/notifications?limit=${PAGE}`
      if (t.types.length) q += `&type=${t.types.join(',')}`
      if (unreadOnly) q += '&read=false'
      if (cursorId) q += `&cursor=${encodeURIComponent(cursorId)}`
      return q
    }

    const toRow = (n: Notice): Row => ({
      notice: n, at: Date.parse(n.createdAt) || 0, text: plain(noticeText(n)), preview: previewOf(n) || undefined,
    })

    const loadPage = async (): Promise<void> => {
      if (next === null || !TABS[tab]!.fetch) { next = null; return }
      const mine = epoch
      const page = await api.page<Notice>(query(next ?? undefined))
      if (mine !== epoch) return
      items.push(...page.rows.map(toRow))
      next = page.cursor
    }

    const loadExtras = async (): Promise<Row[]> => {
      const convs = await api.get<MailConv[]>('/v1/cmail').catch(() => [] as MailConv[])
      const mail = convs
        .filter(c => c.unreadCount > 0 && c.otherUser?.username && c.otherUser.deleted !== true)
        .map((c): Row => {
          const who = plain(c.otherUser.username)
          const notice: Notice = {
            id: MAIL_ID + c.conversationId, type: 'dm_message', actorUsername: who,
            targetId: c.conversationId, read: false, createdAt: new Date(c.lastMessageAt).toISOString(),
          }
          return {
            notice, at: c.lastMessageAt, line: `cmail @${who}`,
            text: `@${who} sent you C-Mail (${c.unreadCount})`,
            preview: oneLine(c.lastMessage) || undefined,
          }
        })
      return mail
    }

    /** Refetch the current tab from its first page. `keep` holds the cursor where it was. */
    const reload = async (keep = false): Promise<void> => {
      const mine = ++epoch
      const opening = !keep
      // Held by id: a row that arrives above the selection moves every index under it.
      const wasOn = keep ? shown()[cursor]?.notice.id : undefined
      items = []
      next = undefined
      loading = true
      if (!keep) cursor = 0
      draw()
      try {
        const [made] = await Promise.all([loadExtras(), loadPage()])
        if (mine !== epoch) return
        extras = made
        status = ''
      } catch (e) {
        if (mine !== epoch) return
        status = e instanceof ApiError ? e.message.toUpperCase() : 'NO CARRIER'
        next = null
      }
      // A parked cursor may sit past the first page, and a page may be empty.
      for (let i = 0; i < FILL_PAGES && running && mine === epoch && next && shown().length <= cursor; i++) {
        try { await loadPage() } catch { next = null }
      }
      if (mine !== epoch) return
      loading = false
      const moved = wasOn ? shown().findIndex(r => r.notice.id === wasOn) : -1
      if (moved >= 0) cursor = moved
      cursor = Math.min(cursor, Math.max(0, shown().length - 1))
      if (opening) reveal.start(Math.min(shown().length, list.h))
      draw()
    }

    const more = async (): Promise<void> => {
      if (loading || !next) return
      loading = true
      draw()
      try { await loadPage() } catch { next = null }
      loading = false
      draw()
    }

    const move = (by: number): void => {
      const all = shown()
      const to = Math.max(0, Math.min(all.length - 1, cursor + by))
      if (to === cursor) {
        // At the end of what is loaded: the pages behind it, if any.
        if (by > 0 && next) void more()
        else snd.beep(220, 0.04)
        return
      }
      cursor = to
      snd.tick()
      park()
      draw()
      if (all.length - cursor <= NEAR_END) void more()
    }

    const setTab = (to: number): void => {
      const n = (to + TABS.length) % TABS.length
      if (n === tab) return
      stash()
      tab = n
      snd.tick()
      park()
      show()
    }

    const markRead = (row: Row): void => {
      if (row.notice.read) return
      row.notice.read = true
      // The same notification fetched for another tab is a different object.
      for (const kept of cache.values()) {
        for (const r of kept.items) if (r.notice.id === row.notice.id) r.notice.read = true
      }
      // The rows made here are cleared by the program that opens them.
      if (row.line) return
      counts?.()?.seen()
      void api.patch(`/v1/notifications/${encodeURIComponent(row.notice.id)}`, {}).catch(() => {})
    }

    const detail = (row: Row): void => {
      const n = row.notice
      const lines: TextLine[] = [row.text]
      const width = Math.max(20, Math.min(60, cols - 10))
      const src = sourceOf(n)
      const got = src ? fetched.get(`${src.kind}:${src.id}`) : undefined
      if (row.preview) {
        lines.push('', ...wrap(row.preview, width))
      } else if (got) {
        if (got.title) lines.push('', [{ text: got.title.slice(0, width), attr: BRIGHT | BOLD }])
        const body = previewLines(got.body, width, PREVIEW_ROWS)
        if (body.length) lines.push('', ...body)
      }
      if (n.reason && !row.text.includes(n.reason)) lines.push('', n.reason)
      lines.push('', new Date(row.at).toString().slice(0, 21))
      open(new TextPopup({
        title: BOX_TITLE[n.type] ?? n.type.replace(/_/g, ' ').toUpperCase(),
        lines,
        hint: 'ESC Close',
        shadow: true,
        onDone: () => close(),
      }))
    }

    /** P: the row in a box, with the reply or entry it is about fetched if it carries no text. */
    const previewRow = async (): Promise<void> => {
      const row = shown()[cursor]
      if (!row) { snd.beep(220, 0.04); return }
      const src = row.preview ? null : sourceOf(row.notice)
      const key = src ? `${src.kind}:${src.id}` : ''
      if (src && !fetched.has(key)) {
        status = 'LOADING'
        draw()
        try {
          const path = src.kind === 'reply' ? 'replies' : 'posts'
          const r = await api.get<{ title?: string; content?: string }>(`/v1/${path}/${encodeURIComponent(src.id)}`)
          fetched.set(key, { title: oneLine(r.title) || undefined, body: toBlocks(stripImages(r.content ?? '')) })
        } catch {
          fetched.set(key, null)
        }
        status = ''
        if (!running || stack.active) return
        draw()
      }
      snd.blip(520, 0.09, 0)
      detail(row)
    }

    const openRow = async (): Promise<void> => {
      const row = shown()[cursor]
      if (!row) { snd.beep(220, 0.04); return }
      status = ''
      const line = row.line ?? await openLine(api, row.notice)
      if (!running) return
      markRead(row)
      if (!line) { snd.blip(520, 0.09, 0); detail(row); return }
      if (!p.kernel.jobs.fg) {
        status = 'NO JOB CONTROL'
        snd.beep(220, 0.12)
        draw()
        return
      }
      snd.blip(520, 0.09, 0)
      draw()
      void p.kernel.jobs.switchTo({ launch: line })
    }

    const readAll = (): void => {
      open(new ConfirmPopup({
        title: 'READ ALL',
        lines: ['Mark every notification read?'],
        hint: YES_NO,
        shadow: true,
        onDone: yes => {
          close()
          if (!yes) return
          status = 'MARKING'
          draw()
          void (async () => {
            try {
              // One call marks at most 5000; hasMore asks for another.
              let r: { hasMore?: boolean }
              do r = await api.post<{ hasMore?: boolean }>('/v1/notifications/read-all', {})
              while (r.hasMore && running)
              const c = counts?.()
              c?.seen(c.count)
              cache.clear()
              status = ''
              await reload(true)
            } catch (e) {
              status = e instanceof ApiError ? e.message.toUpperCase() : 'NO CARRIER'
              snd.beep(220, 0.12)
              draw()
            }
          })()
        },
      }))
    }

    const confirmQuit = (): void => {
      open(new ConfirmPopup({
        title: 'EXIT',
        lines: ['Quit inbox?'],
        hint: YES_NO,
        shadow: true,
        onDone: yes => { close(); if (yes) running = false },
      }))
    }

    const onKey = (k: KeyInput): void => {
      reveal.finish()
      if (k.ctrlKey && k.key === 'c') { running = false; return }
      if (k.ctrlKey || k.metaKey || k.altKey) return
      if (k.key === 'Escape') { snd.blip(520, 0.09, 0); confirmQuit(); return }
      if (k.key === 'q' || k.key === 'Q') { running = false; return }
      if (k.key === 'ArrowUp') { move(-1); return }
      if (k.key === 'ArrowDown') { move(1); return }
      if (k.key === 'PageUp') { move(-Math.max(1, list.h - 1)); return }
      if (k.key === 'PageDown') { move(Math.max(1, list.h - 1)); return }
      if (k.key === 'ArrowLeft') { setTab(tab - 1); return }
      if (k.key === 'ArrowRight' || k.key === 'Tab') { setTab(tab + 1); return }
      if (/^[1-9]$/.test(k.key) && Number(k.key) <= TABS.length) { setTab(Number(k.key) - 1); return }
      if (k.key === 'Enter') { void openRow(); return }
      if (k.key === 'u' || k.key === 'U') {
        stash()
        unreadOnly = !unreadOnly
        snd.tick()
        park()
        show()
        return
      }
      if (k.key === 'a' || k.key === 'A') { readAll(); return }
      if (k.key === 'p' || k.key === 'P') { void previewRow(); return }
    }

    tty.setRaw()
    // These play their own tick, so the host suppresses the key click.
    tty.silence(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Tab', 'Enter', 'Escape'])
    p.out('\x1b[?1049h')
    s.invalidate()
    p.setResume('inbox')

    // The service's counts changed. A rise is something new, so the list is
    // fetched again under the selection; a fall is a row read here or elsewhere
    // and only the title changes. Not while stopped: onCont reloads.
    const unread = (): number => { const c = counts?.(); return c ? c.count + c.mail : 0 }
    let known = unread()
    let stopped = false
    const unwatch = counts?.()?.watch?.(() => {
      const now = unread()
      const rose = now > known
      known = now
      if (stopped || !running) return
      if (rose) cache.clear()
      if (rose && !stack.active) void reload(true)
      else draw()
    })
    p.onStop = () => { stopped = true }

    // Back from the program a row opened: what was read there is read here.
    p.onCont = () => {
      stopped = false
      cache.clear()
      s.invalidate()
      void counts?.()?.poll()
      void reload(true)
    }

    try {
      const parked = readState(p.takeState())
      if (parked) { tab = parked.tab; cursor = parked.sel; unreadOnly = parked.unread }
      void reload(parked !== null)

      while (running) {
        const chunk = await p.stdin.read()
        if (chunk === null) break
        for (const k of parseKeys(dec.decode(chunk))) {
          if (stack.active) { stack.key(k); paintNow(); continue }
          onKey(k)
          if (!running) break
        }
      }
      return 0
    } finally {
      running = false
      epoch++
      unwatch?.()
      reveal.stop()
      while (stack.active) stack.pop()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
