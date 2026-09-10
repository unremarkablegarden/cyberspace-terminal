// feed: the site's feed as a records console.
//
// A stack of fixed-width record boxes with one lit. Arrows move, Enter opens
// the record as the post and its thread, Escape closes it. U or F push a
// member's list as another FeedScreen on top, so Escape returns to the feed
// exactly as it was. R replies in an editor box, W opens the composer
// (write.ts). Pages come from the API; new posts are polled for and queued
// behind an `N NEW` banner rather than spliced into a list being read.
//
// Unsent writing does not live here: both composers hand every keystroke to
// FeedDrafts (feeddraft.ts), which the host backs with a store that outlives
// the program.
//
// Ported from the original web terminal's feed.ts. The one structural change:
// the Firestore service became REST calls and a client-side filter (feedutil).

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, Reveal, parseKeys, frame, hline, label, clear, cells, hangingWrap,
  ConfirmPopup, EditorPopup, PromptPopup, SelectPopup, TextPopup, RULE, YES_NO,
  NORMAL, BRIGHT, BOLD, DIM, BG,
  type Grid, type KeyInput, type Rect, type Screen, type Span, type TextLine,
} from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { SILENT, type ChatPictureHost, type ChatPictures, type Picture } from './chat.js'
import {
  keep, keepReply, toEntry, toProfile, toReply, when, OPEN_FILTER,
  type ApiPost, type ApiReply, type ApiUser, type FeedBlock, type FeedEntry, type FeedFilter,
  type FeedLink, type FeedProfile, type FeedReply, type PostDraft,
} from './feedutil.js'
import { WriteScreen, type FeedHost, type FeedSound } from './write.js'
import { FeedDrafts, type DraftStore, type ReplyDraft } from './feeddraft.js'
import { bioLines, fetchProfile, portraitFits, PFP_COLS, PFP_ROWS, type Portrait } from './bio.js'

/** Letter-spaced masthead. */
const TITLE = 'CYBERSPACE'
/** Entries per fetch. Four fill the pane. */
const PAGE = 20
/** Body rows a record may show in the list. Records are sized to their text up to this. */
const BODY_MAX = 4
/** Top rule and bottom rule. */
const FRAME_H = 2
/** Blank row between records. */
const GAP = 1
/** ASCII: both faces have it. */
const MORE = '...'
/** Blank cells either side of a code block's text, inside its field. */
const CODE_PAD = 1
/** U+258C, in both faces. */
const QUOTE_BAR = '▌'
/** U+2022, in both faces. */
const BULLET = '•'
/** U+2514 U+2500: box drawing, so a face that has the frame has this. */
const PARENT_MARK = '└─ '
const EOF = '~EOF~'
/** U+2B06/U+2B07, the pair the fonts patch in. */
const ARROWS = '⬆⬇'

const HINT: Span[] = [
  { text: ` ${ARROWS} `, inverse: true, attr: DIM },
  { text: ' Nav ' },
  { text: ' ↵ ', inverse: true, attr: DIM },
  { text: ' Read ' },
]
const HINT_OPEN: Span[] = [
  { text: ` ${ARROWS} `, inverse: true, attr: DIM },
  { text: ' Nav ' },
]
const HINT_LINKS: Span[] = [{ text: ' L ', inverse: true, attr: DIM }, { text: ' Links ' }]
const HINT_FIND: Span[] = [{ text: ' F ', inverse: true, attr: DIM }, { text: ' Find ' }]
const HINT_USER: Span[] = [{ text: ' U ', inverse: true, attr: DIM }, { text: ' User ' }]
const HINT_BIO: Span[] = [{ text: ' B ', inverse: true, attr: DIM }, { text: ' Bio ' }]
const HINT_REPLY: Span[] = [{ text: ' R ', inverse: true, attr: DIM }, { text: ' Reply ' }]
const HINT_WRITE: Span[] = [{ text: ' W ', inverse: true, attr: DIM }, { text: ' Write ' }]

/** Site limit on a reply, in characters. */
const REPLY_MAX = 32768
/** Replies fetched when an entry is opened. Two API pages. */
const REPLIES = 100
/** The API's page cap. */
const API_PAGE_MAX = 50
/** Pages pulled to refill a page the filter thinned. */
const MAX_ROUNDS = 4
/** Pages a restore may pull to reach the record the reader was on. */
const RESTORE_PAGES = 6
/** New-post poll interval. The read budget is 45 calls a minute. */
const POLL_MS = 60_000
/** How long COPIED stays on the status rule, in ms. */
const COPIED_MS = 1500

/** Popup hints are plain text: the inverse keycap belongs to the frame's own row. */
const POPUP_HINT = (...pairs: string[]): string => pairs.join('  ')

/** Bump when FeedSnapshot or FeedState changes. A mismatch is dropped. */
const STATE_VERSION = 2

type FeedModal = 'links' | 'find' | 'bio' | 'reply' | 'write'

/** Where one screen was: an index, an id and two numbers. Content is refetched. */
interface FeedSnapshot {
  author?: string
  sel: number
  open?: { id: string; scroll: number; sel: number }
  modal?: FeedModal
}

interface FeedState {
  v: number
  screens: FeedSnapshot[]
}

const EMPTY_DRAFT: PostDraft = { title: '', body: '', topics: '', blog: false, nsfw: false, vent: false }

const wrap = (text: string, width: number): string[] => hangingWrap('', text, width)

/** wrap, with each row's start offset in the source, so link runs can be rebased onto rows. */
function wrapAt(text: string, width: number): { text: string; at: number }[] {
  const usable = Math.max(1, width)
  const out: { text: string; at: number }[] = []
  let line = ''
  let lineAt = 0
  for (const m of text.matchAll(/\S+/g)) {
    let word = m[0]
    let at = m.index
    while (word.length > usable) {
      if (line) { out.push({ text: line, at: lineAt }); line = '' }
      out.push({ text: word.slice(0, usable), at })
      word = word.slice(usable)
      at += usable
    }
    if (!line) { line = word; lineAt = at }
    else if (line.length + 1 + word.length <= usable) line += ' ' + word
    else { out.push({ text: line, at: lineAt }); line = word; lineAt = at }
  }
  if (line) out.push({ text: line, at: lineAt })
  return out.length ? out : [{ text: '', at: 0 }]
}

/** A display row. `code` rows draw BRIGHT on the BG ground across `field` cells. */
interface Line {
  text: string
  attr: number
  code?: boolean
  /** Quote bars down the left: the `>` depth. */
  quote?: number
  /** Width of the code field, shared by every row of one block. */
  field?: number
  /** Runs of this row that are a link's words, drawn on a BG ground. */
  links?: { at: number; len: number }[]
}

/** One box in read mode: the post (card 0) or a reply. */
interface Card {
  username: string
  replyId?: string
  when: string
  footLeft?: string
  footRight?: string
  lines: Line[]
  /** Picture source, drawn under the text when the host has rasterised it. */
  image?: string
  links?: FeedLink[]
}

function bodyLinks(body: FeedBlock[]): FeedLink[] {
  const out: FeedLink[] = []
  for (const block of body) {
    if (typeof block !== 'string' && 'links' in block) out.push(...block.links)
  }
  return out
}

/** The first words of a body, for a caption quoting it. */
function firstText(body: FeedBlock[]): string {
  for (const block of body) {
    if (typeof block === 'string') { if (block) return block; continue }
    if ('text' in block) { if (block.text) return block.text; continue }
    if ('quote' in block) {
      const found = block.quote.find(q => q.text)
      if (found) return found.text
      continue
    }
    if ('list' in block) {
      const found = block.list.find(i => i.text)
      if (found) return found.text
      continue
    }
    if ('code' in block) {
      const found = block.code.find(l => l.trim())
      if (found) return found.trim()
    }
  }
  return ''
}

const BLANK: Line = { text: '', attr: NORMAL }

/** One block as rows. Code is cut at the edge, never folded: its line breaks are content. */
function blockLines(block: FeedBlock, width: number): Line[] {
  if (typeof block !== 'string' && 'code' in block) {
    // The field is the block's widest line plus padding, capped at the record.
    const longest = block.code.reduce((n, l) => Math.max(n, [...l].length), 0)
    const field = Math.min(width, longest + CODE_PAD * 2)
    return block.code.map(text => ({ text, attr: DIM, code: true, field }))
  }
  if (typeof block !== 'string' && 'rule' in block) {
    return [{ text: '─'.repeat(Math.max(1, width)), attr: DIM }]
  }
  if (typeof block !== 'string' && 'quote' in block) {
    const out: Line[] = []
    for (const para of block.quote) {
      const depth = para.depth ?? 1
      const room = Math.max(1, width - depth * 2)
      if (!para.text) { out.push({ text: '', attr: NORMAL, quote: depth }); continue }
      for (const line of hanging('', para.text, para.links, room)) out.push({ ...line, quote: depth })
    }
    return out
  }
  if (typeof block !== 'string' && 'list' in block) {
    const out: Line[] = []
    for (const item of block.list) {
      const head = '  '.repeat(item.depth ?? 0) + (item.n != null ? `${item.n}. ` : `${BULLET} `)
      out.push(...hanging(head, item.text, item.links, width))
    }
    return out
  }
  const text = typeof block === 'string' ? block : block.text
  const links = typeof block === 'string' ? undefined : block.links
  return hanging('', text, links, width)
}

/** Wrap under a head only the first row carries, marking link runs per row. */
function hanging(head: string, text: string, links: FeedLink[] | undefined, width: number): Line[] {
  const indent = ' '.repeat(head.length)
  const room = Math.max(1, width - head.length)
  return wrapAt(text, room).map(({ text: row, at }, i) => {
    const prefix = i === 0 ? head : indent
    const line: Line = { text: prefix + row, attr: NORMAL }
    if (!links?.length) return line
    const runs: { at: number; len: number }[] = []
    for (const link of links) {
      const from = Math.max(link.at, at)
      const to = Math.min(link.at + link.len, at + row.length)
      if (to > from) runs.push({ at: from - at + prefix.length, len: to - from })
    }
    if (runs.length) line.links = runs
    return line
  })
}

/** A body as rows, a blank between blocks. A picture is named here; read mode draws it. */
function bodyLines(body: FeedBlock[], image: string | undefined, width: number): Line[] {
  const out: Line[] = []
  for (const block of body) {
    if (out.length) out.push(BLANK)
    out.push(...blockLines(block, width))
  }
  if (image) {
    if (out.length) out.push(BLANK)
    out.push({ text: '[IMAGE]', attr: NORMAL })
  }
  return out
}

/** The list excerpt: up to BODY_MAX rows, trailing blank dropped. */
function excerpt(entry: FeedEntry, width: number): { lines: Line[]; more: boolean } {
  const all = bodyLines(entry.body, entry.image, width)
  const lines = all.slice(0, BODY_MAX)
  while (lines.length > 1 && !lines[lines.length - 1]!.code && lines[lines.length - 1]!.text === '') lines.pop()
  return { lines, more: all.length > lines.length }
}

/** Words, replies, bookmarks. A zero count is left out. */
function counts(entry: FeedEntry): string {
  const parts = [`${entry.words}W`]
  if (entry.replies) parts.push(`${entry.replies}R`)
  if (entry.bookmarks) parts.push(`${entry.bookmarks}B`)
  return parts.join(' ')
}

/** The program-wide pieces a screen shares with its children. */
interface FeedEnv {
  host: FeedHost
  pics?: ChatPictures
  filter: FeedFilter
  /** Park the whole stack of screens. Only the root calls it. */
  state(screens: FeedSnapshot[]): void
  draft(): PostDraft
  setDraft(d: PostDraft): void
  /** Unsent replies, by the post they answer. */
  reply(postId: string): ReplyDraft | null
  setReply(postId: string, d: ReplyDraft | null): void
}

class FeedScreen implements Screen {
  private entries: FeedEntry[] = []
  private sel = 0
  /** Body rows each record wants, by width and id. */
  private heights = new Map<string, number>()
  private listTops: number[] = []
  private listRows = 0
  private listKey = ''
  /** First visible virtual row of the stack. */
  private scroll = 0
  private open = false
  private cards: Card[] = []
  private cardTops: number[] = []
  private columnRows = 0
  private dividerRow = 0
  private readSel = 0
  private readScroll = 0
  /** Replies to the open entry, or null while they are still coming. */
  private openReplies: FeedReply[] | null = null
  private copied: ReturnType<typeof setTimeout> | null = null
  private replyCache = new Map<string, FeedReply[]>()
  /** Threads being fetched, so a restore joins the fetch setOpen started. */
  private replyLoads = new Map<string, Promise<void>>()
  /** Posts written since this screen loaded, waiting for N. */
  private queued: FeedEntry[] = []
  private poll: ReturnType<typeof setInterval> | null = null
  /** Next page cursor. Undefined before the first page, null at the end. */
  private cursor: string | null | undefined = undefined

  private status = ''
  private loading = false
  private bioLoading = false
  /** A reply just written, selected when the thread comes back with it. */
  private pendingReply?: string
  private posting = false
  private loaded = false
  private hasMore = true
  private failed = false

  /** The screenful landing a row at a time. */
  private print: Reveal
  private active = true
  private closed = false

  /** The member this list is narrowed to. Absent on the main feed. */
  private author?: string
  private quit: () => void
  private profile?: FeedProfile
  private profileRows: TextLine[] = []
  private portrait?: Portrait
  private cardWidth = 0
  private parent?: FeedScreen
  private child?: FeedScreen
  private modal?: FeedModal

  constructor(
    private env: FeedEnv,
    private done: () => void,
    opts: { author?: string; quit?: () => void; parent?: FeedScreen } = {},
  ) {
    this.author = opts.author
    this.parent = opts.parent
    this.quit = opts.quit ?? (() => this.env.host.pop())
    this.print = new Reveal({
      onTick: () => this.redraw(),
      onBlip: () => this.env.host.snd.blip(),
    })
  }

  private get host(): FeedHost { return this.env.host }
  private get snd(): FeedSound { return this.env.host.snd }

  /**
   * Begin, after the screen has been pushed: the first paint must land on the
   * program's grid, not the shell's. `snaps` is where the reader was, outermost
   * first; this screen takes the head and hands the tail to the list it opens.
   */
  async start(snaps: FeedSnapshot[] = []): Promise<void> {
    if (this.author) void this.loadProfile(this.author)
    await this.load()
    this.listen()

    const [mine, ...rest] = snaps
    if (mine) await this.restoreInto(mine)

    const next = rest[0]
    if (next?.author) {
      await this.showUser(next.author, { silent: true }).start(rest)
    } else if (mine?.modal) {
      this.restoreModal(mine.modal)
    }
  }

  /** Poll for new posts. Only the main feed; a member's list does not. */
  private listen(): void {
    if (this.author || this.closed || this.poll) return
    this.poll = setInterval(() => { void this.checkNew() }, POLL_MS)
  }

  /** Job control: no polling while stopped. */
  pause(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  resume(): void {
    this.listen()
  }

  private async checkNew(): Promise<void> {
    if (this.closed || this.loading) return
    let fresh: FeedEntry[]
    try {
      const page = await this.host.api.page<ApiPost>(`/v1/posts?limit=${PAGE}`)
      const have = new Set([...this.entries, ...this.queued].map(e => e.id))
      fresh = page.rows.filter(p => keep(p, this.env.filter) && !have.has(p.postId)).map(toEntry)
    } catch {
      // A failed poll is silent; the next one runs in a minute.
      return
    }
    if (this.closed || !fresh.length) return
    this.queued = [...fresh, ...this.queued]
    this.drawChrome()
  }

  /** Let the waiting posts in. The reader keeps their place unless they were at the top. */
  private loadNew(): void {
    if (!this.queued.length) {
      this.snd.beep(220, 0.04)
      return
    }
    const atTop = this.sel === 0
    this.entries = [...this.queued, ...this.entries]
    this.sel = atTop ? 0 : this.sel + this.queued.length
    this.queued = []
    this.heights.clear()
    this.centre()
    this.snd.blip(520, 0.09, 0)
    this.redraw()
  }

  /** Refetch the first page, for a post just published from here. */
  private async refresh(): Promise<void> {
    if (this.author || this.closed) return
    await this.checkNew()
    if (this.queued.length) this.loadNew()
  }

  private snapshot(): FeedSnapshot {
    const entry = this.entries[this.sel]
    return {
      author: this.author,
      sel: this.sel,
      open: this.open && entry ? { id: entry.id, scroll: this.readScroll, sel: this.readSel } : undefined,
      modal: this.modal,
    }
  }

  /** Park the stack from the root down. Only the root writes; a child asks its parent. */
  private save(): void {
    if (this.parent) { this.parent.save(); return }
    const screens: FeedSnapshot[] = []
    for (let s: FeedScreen | undefined = this; s; s = s.child) screens.push(s.snapshot())
    this.env.state(screens)
  }

  /**
   * Put one screen back. The record is found by index, pulling pages until it
   * exists; the open post is checked by id, since opening a different post
   * would be worse than opening none.
   */
  private async restoreInto(snap: FeedSnapshot): Promise<void> {
    for (let round = 0; round < RESTORE_PAGES; round++) {
      if (this.entries.length > snap.sel || !this.hasMore) break
      await this.load()
    }
    if (!this.entries.length) return

    this.sel = Math.max(0, Math.min(snap.sel, this.entries.length - 1))
    this.centre()

    if (snap.open && this.entries[this.sel]?.id === snap.open.id) {
      this.setOpen(true)
      await this.replyLoads.get(snap.open.id)
      this.buildCards()
      const max = Math.max(0, this.columnRows - this.pane.h)
      this.readScroll = Math.max(0, Math.min(snap.open.scroll, max))
      this.readSel = Math.max(0, Math.min(snap.open.sel, this.cards.length - 1))
    }
    this.redraw()
  }

  private restoreModal(modal: FeedModal): void {
    if (modal === 'links') this.openLinks()
    else if (modal === 'find') this.openFind()
    else if (modal === 'bio') void this.openBio()
    else if (modal === 'reply') this.openReply()
    else if (modal === 'write') this.openWrite()
  }

  // --- layout -----------------------------------------------------------------

  private get outer(): Rect {
    return { x: 0, y: 0, w: this.host.s.cols, h: this.host.s.rows }
  }

  /** Between the two rules, edge to edge. The records are the boxes. */
  private get pane(): Rect {
    return { x: 0, y: 1, w: this.host.s.cols, h: this.host.s.rows - 2 }
  }

  /** The pane cut off at however many rows the reveal has landed. */
  private printed(p: Rect): Rect {
    return this.print.count >= p.h ? p : { ...p, h: Math.max(0, this.print.count) }
  }

  /** Reveal the rows on screen, bounded by the screenful. */
  private printScreenful(rows: number, scroll: number): void {
    this.print.start(Math.min(this.pane.h, Math.max(0, rows - scroll)))
  }

  /** Two border columns and a pad either side. */
  private get bodyWidth(): number {
    return Math.max(1, this.pane.w - 4)
  }

  /** Record height: rules, title row if any, up to BODY_MAX excerpt rows. Cached by width and id. */
  private entryHeight(entry: FeedEntry): number {
    const key = `${this.bodyWidth}|${entry.id}`
    let rows = this.heights.get(key)
    if (rows === undefined) {
      const body = excerpt(entry, this.bodyWidth).lines.length
      rows = Math.max(1, (entry.title ? 1 : 0) + body)
      this.heights.set(key, rows)
    }
    return Math.min(rows + FRAME_H, this.pane.h)
  }

  /** Records that fit whole below `from`, for deciding when to fetch the next page. */
  private fits(from: number): number {
    let n = 0
    let y = 0
    for (let i = from; i < this.entries.length; i++) {
      const h = this.entryHeight(this.entries[i]!)
      if (y + h > this.pane.h) break
      y += h + GAP
      n++
    }
    return Math.max(1, n)
  }

  /** The member card above a member's list. Zero rows on the main feed or before the profile lands. */
  private get cardRows(): number {
    return this.profileRows.length ? this.profileRows.length + FRAME_H : 0
  }

  private get cardOffset(): number {
    return this.cardRows ? this.cardRows + GAP : 0
  }

  private layoutList(): void {
    if (this.cardWidth !== this.bodyWidth) this.buildCard()
    const key = `${this.bodyWidth}|${this.entries.length}|${this.cardRows}`
    if (key === this.listKey) return
    this.listKey = key
    this.listTops = []
    let y = this.cardOffset
    for (const entry of this.entries) {
      this.listTops.push(y)
      y += this.entryHeight(entry) + GAP
    }
    this.listRows = Math.max(0, y - GAP)
  }

  /** Fetch the member card. Failure is silence: a column with no card reads as a member with no bio. */
  private async loadProfile(who: string): Promise<void> {
    const profile = await fetchProfile(this.host.api, who)
    if (this.closed || !profile) return
    this.profile = profile
    this.portrait = this.portraitOf(profile)
    this.buildCard()
    this.centre()
    this.redraw()
    if (this.portrait) void this.loadPortrait(profile.picture!, this.portrait)
  }

  /** The picture's slot, held from the start so the box does not reflow when it lands. */
  private portraitOf(profile: FeedProfile): Portrait | undefined {
    const pics = this.env.pics
    if (!profile.picture || !pics) return undefined
    return { cols: PFP_COLS, rows: pics.slot(PFP_COLS, PFP_ROWS, 1) }
  }

  private portraitLoading = false

  /** A picture that cannot be read leaves its column blank. */
  private async loadPortrait(src: string, portrait: Portrait): Promise<void> {
    const pics = this.env.pics
    if (!pics || this.portraitLoading) return
    this.portraitLoading = true
    try {
      const pic = await pics.load(src, src, portrait.cols, PFP_ROWS)
      if (this.closed || this.portrait !== portrait) return
      portrait.lines = pic.lines
      this.buildCard()
      this.redraw()
    } catch (err) {
      console.error('feed: portrait failed', err)
    } finally {
      this.portraitLoading = false
    }
  }

  /**
   * Before each paint: the rows held here name bank slots, and the bank may
   * have freed them for other pictures. The lookup is what keeps them, and a
   * portrait that is gone is fetched again rather than drawn from stale rows.
   */
  private refreshPortrait(): void {
    const pics = this.env.pics
    const portrait = this.portrait
    const src = this.profile?.picture
    if (!pics || !portrait || !src) return
    const pic = pics.picture(src, portrait.cols, PFP_ROWS)
    if (pic?.lines === portrait.lines) return
    portrait.lines = pic?.lines
    this.buildCard()
    if (!pic) void this.loadPortrait(src, portrait)
  }

  private buildCard(): void {
    const p = this.profile
    this.cardWidth = this.bodyWidth
    this.profileRows = p ? bioLines(p, p.joined ? when(p.joined) : undefined, this.bodyWidth, this.portrait) : []
    this.listKey = ''
  }

  /**
   * Put the selected record in the middle of the pane, in rows, clamped at
   * both ends. The first record is the top of the page, so the member card is
   * never centred away.
   */
  private centre(): void {
    this.layoutList()
    const p = this.pane
    const sel = this.entries[this.sel]
    if (!sel || this.sel === 0) {
      this.scroll = 0
      return
    }
    const want = (this.listTops[this.sel] ?? 0) - Math.floor((p.h - this.entryHeight(sel)) / 2)
    const max = Math.max(0, this.listRows - p.h)
    this.scroll = Math.max(0, Math.min(want, max))
  }

  // --- data -------------------------------------------------------------------

  /**
   * One API page, filtered. Pulls further pages while the filter has thinned
   * this one below PAGE, up to MAX_ROUNDS, so a short page means the end.
   */
  private async fetchPage(): Promise<FeedEntry[]> {
    const out: FeedEntry[] = []
    const path = this.author
      ? `/v1/users/${encodeURIComponent(this.author)}/posts`
      : '/v1/posts'
    for (let round = 0; round < MAX_ROUNDS && out.length < PAGE && this.cursor !== null; round++) {
      const q = `limit=${PAGE}` + (this.cursor ? `&cursor=${encodeURIComponent(this.cursor)}` : '')
      const page = await this.host.api.page<ApiPost>(`${path}?${q}`)
      this.cursor = page.cursor
      out.push(...page.rows.filter(p => keep(p, this.env.filter)).map(toEntry))
    }
    return out
  }

  /** Fetch a page and append it. Guarded on `loading`: asking twice duplicates. */
  private async load(): Promise<void> {
    if (this.loading || !this.hasMore || this.closed) return
    // The first page prints; later ones land under a reader already moving.
    const opening = !this.loaded
    this.loading = true
    this.status = 'LOADING'
    this.drawChrome()
    this.snd.seek?.(2)

    try {
      const page = await this.fetchPage()
      if (this.closed) return
      this.entries.push(...page)
      if (this.cursor === null) this.hasMore = false
    } catch (err) {
      if (this.closed) return
      console.error('feed: page failed', err)
      if (!this.entries.length) this.failed = true
      this.hasMore = false
    } finally {
      this.loading = false
      this.loaded = true
      if (!this.closed) {
        this.status = this.hasMore ? '' : EOF
        if (opening) {
          this.layoutList()
          this.printScreenful(this.listRows, this.scroll)
        }
        this.redraw()
      }
    }
  }

  // --- input ------------------------------------------------------------------

  /** Arrows tick, Enter and Escape blip: the key click would be a second sound. */
  silentKey(e: KeyInput): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    return e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Escape'
  }

  onKey(e: KeyInput): boolean {
    if (this.closed) return false

    // Any key ends the reveal first: every scroll is measured against the whole column.
    this.print.finish()

    // The kernel aborts the process on ^C in raw mode; the byte still arrives.
    if (e.ctrlKey && e.key === 'c') { this.quit(); return true }
    if (e.ctrlKey || e.metaKey || e.altKey) return false

    if (e.key === 'Escape') {
      // The narrowest open thing closes: the entry, then this list, then the program.
      if (this.open) {
        this.setOpen(false)
      } else if (this.parent) {
        this.snd.blip(420, 0.09, 0)
        this.host.pop()
      } else {
        this.snd.blip(520, 0.09, 0)
        this.confirmQuit()
      }
      return true
    }

    switch (e.key) {
      case 'l': case 'L': this.openLinks(); return true
      case 'u': case 'U': this.openUser(); return true
      case 'n': case 'N': this.loadNew(); return true
      case 'f': case 'F': this.openFind(); return true
      case 'b': case 'B': void this.openBio(); return true
      case 'r': case 'R': this.openReply(); return true
      case 'w': case 'W': this.openWrite(); return true
    }

    if (e.key === 'Enter') {
      // Enter opens and Escape closes; Enter is not a toggle.
      if (this.open || !this.entries.length) {
        this.snd.beep(220, 0.04)
        return true
      }
      this.setOpen(true)
      return true
    }
    if (e.key === 'ArrowUp') {
      if (this.open) this.moveRead(-1)
      else this.move(-1)
      return true
    }
    if (e.key === 'ArrowDown') {
      if (this.open) this.moveRead(1)
      else this.move(1)
      return true
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      const step = Math.max(1, this.pane.h - 2) * (e.key === 'PageUp' ? -1 : 1)
      if (this.open) this.moveRead(step)
      else this.move(e.key === 'PageUp' ? -1 : 1)
      return true
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') return true
    return false
  }

  private setOpen(open: boolean): void {
    this.open = open
    this.readSel = 0
    this.readScroll = 0
    this.snd.blip(open ? 520 : 420, 0.09, 0)

    const id = this.entries[this.sel]?.id
    if (open && id) {
      // null means not here yet and drives the LOADING REPLIES divider.
      this.openReplies = this.replyCache.get(id) ?? null
      if (!this.openReplies) void this.loadReplies(id)
    } else {
      this.openReplies = null
    }

    this.buildCards()
    // While the replies are in flight the column is the post and the divider,
    // so the reveal is bounded by the screenful rather than the short column.
    if (open) this.printScreenful(this.openReplies ? this.columnRows : this.pane.h, 0)
    else { this.layoutList(); this.printScreenful(this.listRows, this.scroll) }
    this.redraw()
  }

  private loadReplies(id: string): Promise<void> {
    let load = this.replyLoads.get(id)
    if (!load) {
      load = this.fetchReplies(id).finally(() => this.replyLoads.delete(id))
      this.replyLoads.set(id, load)
    }
    return load
  }

  private async fetchReplies(id: string): Promise<void> {
    this.snd.seek?.(1)
    this.status = 'LOADING REPLIES'
    this.drawChrome()

    let list: FeedReply[] = []
    try {
      let cursor: string | null = null
      while (list.length < REPLIES) {
        const q = `limit=${API_PAGE_MAX}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
        const page: { rows: ApiReply[]; cursor: string | null } =
          await this.host.api.page<ApiReply>(`/v1/posts/${encodeURIComponent(id)}/replies?${q}`)
        list.push(...page.rows.filter(r => keepReply(r, this.env.filter)).map(toReply))
        cursor = page.cursor
        if (!cursor) break
      }
    } catch (err) {
      // An empty thread and an unreachable one look the same here.
      console.error('feed: replies failed', err)
    }
    if (this.closed) return
    this.replyCache.set(id, list)
    this.status = this.hasMore ? '' : EOF
    // Adopted only if this is still the entry on screen.
    if (this.open && this.entries[this.sel]?.id === id) {
      this.openReplies = list
      this.buildCards()
      if (this.pendingReply) {
        const i = this.cards.findIndex(c => c.replyId === this.pendingReply)
        this.pendingReply = undefined
        if (i > 0) this.showCard(i)
      }
    }
    this.redraw()
  }

  /** Select a card and scroll it on screen. A card taller than the pane shows from its top. */
  private showCard(i: number): void {
    const p = this.pane
    this.readSel = i
    const top = this.cardTops[i] ?? 0
    const h = this.cardHeight(i)
    const onScreen = top >= this.readScroll && top + h <= this.readScroll + p.h
    if (onScreen) return
    const want = h > p.h ? top : top + h - p.h
    this.readScroll = Math.max(0, Math.min(want, Math.max(0, this.columnRows - p.h)))
  }

  /** Lay the post and its replies out as a column of boxes in virtual rows. */
  private buildCards(): void {
    const entry = this.open ? this.entries[this.sel] : undefined
    this.cards = []
    this.cardTops = []
    this.columnRows = 0
    this.dividerRow = 0
    if (!entry) return

    const width = this.bodyWidth
    const paras = (body: FeedBlock[]): Line[] => bodyLines(body, undefined, width)
    const head: Line[] = entry.title
      ? [...wrap(entry.title, width).map(text => ({ text, attr: BRIGHT | BOLD })), BLANK]
      : []

    this.cards.push({
      username: entry.username,
      when: when(entry.at),
      footLeft: counts(entry),
      footRight: this.tags(entry) || undefined,
      lines: [...head, ...paras(entry.body)],
      image: this.drawable(entry.image),
      links: bodyLinks(entry.body),
    })
    for (const reply of this.openReplies ?? []) {
      this.cards.push({
        username: reply.username,
        replyId: reply.id,
        when: when(reply.at),
        lines: [...this.parentLines(reply, width), ...paras(reply.body)],
        image: this.drawable(reply.image),
        links: bodyLinks(reply.body),
      })
    }

    let y = 0
    for (let i = 0; i < this.cards.length; i++) {
      this.cardTops.push(y)
      y += this.cardHeight(i)
      // The thread header sits between the post and the first reply, in its own row.
      if (i === 0) {
        y += GAP
        this.dividerRow = y
        y += 1
      }
      y += GAP
    }
    this.columnRows = Math.max(0, y - GAP)
  }

  /** A picture the host can draw. Without a host, or after a failed read, the attachment is unnamed. */
  private drawable(src?: string): string | undefined {
    const pics = this.env.pics
    if (!pics || !src || pics.failed(src)) return undefined
    return src
  }

  /** The full width inside a card, one screen tall at most. */
  private get picBounds(): { cols: number; rows: number } {
    const p = this.pane
    return { cols: Math.max(1, p.w - 4), rows: Math.max(1, p.h - 2) }
  }

  /** The caption on a reply answering another reply: who, and the first of what they said. One row. */
  private parentLines(reply: FeedReply, width: number): Line[] {
    if (!reply.parentUsername) return []
    let text = `${PARENT_MARK}@${reply.parentUsername}`
    const parent = reply.parentId ? this.openReplies?.find(r => r.id === reply.parentId) : undefined
    const said = parent ? firstText(parent.body) : ''
    if (said) text += `: ${said}`
    return [{ text: this.elide(text, width, text.length > width), attr: DIM }, BLANK]
  }

  private dividerText(width: number): string {
    const replies = this.openReplies
    const head = replies === null
      ? '── LOADING REPLIES '
      : replies.length === 0
        ? '── NO REPLIES '
        : `── ${replies.length} ${replies.length === 1 ? 'REPLY' : 'REPLIES'} `
    return (head + '─'.repeat(Math.max(0, width - head.length))).slice(0, width)
  }

  /** Text rows plus, with a picture, a blank row and the picture's slot. */
  private cardBody(card: Card | undefined): number {
    if (!card) return 0
    const pics = this.env.pics
    const pic = card.image && pics ? pics.slot(this.picBounds.cols, this.picBounds.rows) + 1 : 0
    return card.lines.length + pic
  }

  private cardHeight(i: number): number {
    return this.cardBody(this.cards[i]) + 2
  }

  /**
   * Read mode scrolls the thread a row at a time and the selection follows
   * the focus line; when nothing can scroll the key moves the selection.
   */
  private moveRead(delta: number): void {
    const p = this.pane
    const max = Math.max(0, this.columnRows - p.h)
    const next = Math.max(0, Math.min(this.readScroll + delta, max))
    if (next !== this.readScroll) {
      this.readScroll = next
      this.readSel = this.focusCard()
      this.snd.tick()
      this.redraw()
      return
    }
    const sel = this.readSel + Math.sign(delta)
    if (sel < 0 || sel >= this.cards.length) {
      this.snd.beep(220, 0.04)
      return
    }
    this.readSel = sel
    this.snd.tick()
    this.redraw()
  }

  /** The last card that has started a third of the way down the pane. */
  private focusCard(): number {
    const focus = this.readScroll + Math.floor(this.pane.h / 3)
    let best = 0
    for (let i = 0; i < this.cards.length; i++) {
      if ((this.cardTops[i] ?? 0) > focus) break
      best = i
    }
    return best
  }

  private move(delta: number): void {
    const next = this.sel + delta
    if (next < 0) {
      this.snd.beep(220, 0.04)
      return
    }
    if (next >= this.entries.length) {
      // The end of what is loaded loads more; the move is retried when the page lands.
      if (this.hasMore && !this.loading) void this.load().then(() => this.move(delta))
      else this.snd.beep(220, 0.04)
      return
    }
    this.sel = next
    this.centre()
    this.snd.tick()
    this.redraw()
    // Fetch one screen before the end.
    if (this.hasMore && !this.loading && this.sel >= this.entries.length - this.fits(this.sel)) {
      void this.load()
    }
  }

  // --- drawing ----------------------------------------------------------------

  setActive(active: boolean): void {
    this.active = active
    if (!active) this.print.stop()
  }

  /** Repaint this screen when it is the one on top. */
  private redraw(): void {
    if (this.closed || !this.active) return
    this.draw(this.host.s)
    this.host.paint()
  }

  draw(term: Grid): void {
    if (this.closed) return
    // A repaint is a change of position, so the state is parked here.
    this.save()
    if (!this.active) return
    clear(term, this.outer)
    this.drawRules(term)
    this.drawChromeLabels(term)

    if (this.failed) { this.centred(term, 'FEED UNAVAILABLE'); return }
    if (!this.entries.length) {
      this.centred(term, this.loaded ? 'NO ENTRIES' : 'LOADING')
      return
    }
    if (this.open) this.drawOpen(term)
    else this.drawList(term)
    term.showCursor = false
  }

  private drawList(term: Grid): void {
    this.layoutList()
    const p = this.printed(this.pane)
    this.drawCard(term, p)
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!
      const r: Rect = {
        x: p.x,
        y: p.y + (this.listTops[i] ?? 0) - this.scroll,
        w: p.w,
        h: this.entryHeight(entry),
      }
      if (r.y >= p.y + p.h) break
      if (r.y + r.h <= p.y) continue
      this.drawRecord(term, r, entry, i === this.sel, p)
    }
  }

  /** The member card, single rule at DIM, scrolling with the column. */
  private drawCard(term: Grid, clip: Rect): void {
    if (!this.cardRows) return
    this.refreshPortrait()
    const r: Rect = { x: clip.x, y: clip.y - this.scroll, w: clip.w, h: this.cardRows }
    // The gap under the card is drawn as a rule: this is where the member's words stop.
    const rule = r.y + r.h
    if (rule >= clip.y && rule < clip.y + clip.h) hline(term, rule, -1, term.cols, DIM, 'single', clip)
    if (r.y >= clip.y + clip.h || r.y + r.h <= clip.y) return

    const inner = frame(term, r, DIM, 'single', clip)
    for (let i = 0; i < this.profileRows.length; i++) {
      const y = inner.y + i
      if (y >= clip.y + clip.h) break
      if (y < clip.y) continue
      const row = this.profileRows[i]!
      if (typeof row === 'string') term.text(inner.x + 1, y, row.slice(0, inner.w - 2), NORMAL)
      else if (!Array.isArray(row)) hline(term, y, r.x, r.x + r.w - 1, DIM, 'single', clip)
      else {
        let x = inner.x + 1
        const end = inner.x + inner.w - 1
        for (const span of row) {
          if (x >= end) break
          term.text(x, y, span.text.slice(0, end - x), span.attr ?? NORMAL)
          x += cells(span.text)
        }
      }
    }
  }

  /** One record. `lit` changes the border and the name only; body text is always NORMAL. */
  private drawRecord(term: Grid, r: Rect, entry: FeedEntry, lit: boolean, clip: Rect): void {
    const inner = lit ? frame(term, r, NORMAL, 'double', clip) : frame(term, r, DIM, 'single', clip)
    // In a member's own list the name is in the nameplate, not on every record.
    if (entry.username !== this.author) {
      label(term, r, `@${entry.username}`, { attr: lit ? BRIGHT | BOLD : NORMAL, clip })
    }
    label(term, r, when(entry.at), { align: 'right', clip })
    this.drawFoot(term, r, entry, clip)

    let y = inner.y
    let left = inner.h
    if (entry.title && left > 0) {
      if (y >= clip.y && y < clip.y + clip.h) {
        term.text(inner.x + 1, y, entry.title.slice(0, inner.w - 2), BRIGHT | BOLD)
      }
      y++
      left--
    }
    const { lines, more } = excerpt(entry, inner.w - 2)
    const shown = Math.min(left, lines.length)
    const cut = more || lines.length > shown
    for (let i = 0; i < shown; i++) {
      this.drawLine(term, inner, y + i, lines[i]!, clip, i === shown - 1 && cut)
    }
  }

  /** One body row inside `inner`, clipped. Code rows are inverse at DIM across their field. */
  private drawLine(term: Grid, inner: Rect, y: number, line: Line, clip: Rect, more = false): void {
    if (y < clip.y || y >= clip.y + clip.h) return
    const w = inner.w - 2

    if (!line.code) {
      const bars = line.quote ?? 0
      for (let d = 0; d < bars; d++) term.text(inner.x + 1 + d * 2, y, QUOTE_BAR, DIM)
      const x = inner.x + 1 + bars * 2
      const text = this.elide(line.text, w - bars * 2, more)
      term.text(x, y, text, line.attr)
      // Link runs are overdrawn with a BG ground, clipped to what was written.
      for (const run of line.links ?? []) {
        const at = Math.min(run.at, text.length)
        const len = Math.min(run.len, text.length - at)
        if (len > 0) term.text(x + at, y, text.slice(at, at + len), line.attr | BG)
      }
      return
    }

    const field = Math.min(line.field ?? w, w)
    let row = (' '.repeat(CODE_PAD) + line.text).slice(0, field).padEnd(field, ' ')
    if (more) row = row.slice(0, Math.max(0, field - MORE.length)) + MORE
    term.text(inner.x + 1, y, row, BRIGHT | BG)
  }

  private elide(line: string, width: number, truncated: boolean): string {
    if (!truncated) return line.slice(0, width)
    const room = width - MORE.length
    return line.slice(0, room).trimEnd() + MORE
  }

  /** Counts on the left, fixed width; topics on the right, ragged. */
  private drawFoot(term: Grid, r: Rect, entry: FeedEntry, clip: Rect): void {
    label(term, r, counts(entry), { edge: 'bottom', clip })
    const tags = this.tags(entry)
    if (tags) label(term, r, tags, { edge: 'bottom', align: 'right', clip })
  }

  private tags(entry: FeedEntry): string {
    const parts = entry.topics.map(t => `#${t}`)
    if (entry.nsfw) parts.unshift('NSFW')
    return parts.join(' ')
  }

  /** The open entry: the post and its replies as a scrolling column of boxes. */
  private drawOpen(term: Grid): void {
    const p = this.printed(this.pane)
    const dy = p.y + this.dividerRow - this.readScroll
    if (dy >= p.y && dy < p.y + p.h) term.text(p.x, dy, this.dividerText(p.w), NORMAL)

    const shown: string[] = []
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]!
      const r: Rect = {
        x: p.x,
        y: p.y + (this.cardTops[i] ?? 0) - this.readScroll,
        w: p.w,
        h: this.cardHeight(i),
      }
      if (r.y >= p.y + p.h) break
      if (r.y + r.h <= p.y) continue
      if (card.image) shown.push(card.image)
      this.paintCard(term, r, card, i === this.readSel, p)
    }
    // Only the pictures on the pane are loaded and kept; the bank is small.
    const pics = this.env.pics
    if (pics && shown.length) pics.ensure(shown, this.picBounds.cols, this.picBounds.rows)
  }

  private paintCard(term: Grid, r: Rect, card: Card, lit: boolean, clip: Rect): void {
    const inner = lit ? frame(term, r, NORMAL, 'double', clip) : frame(term, r, DIM, 'single', clip)
    // Every reply is signed. Only the post at the top of a member's own list goes without.
    if (card.replyId || card.username !== this.author) {
      label(term, r, `@${card.username}`, { attr: lit ? BRIGHT | BOLD : NORMAL, clip })
    }
    label(term, r, card.when, { align: 'right', clip })
    if (card.footLeft) label(term, r, card.footLeft, { edge: 'bottom', clip })
    if (card.footRight) label(term, r, card.footRight, { edge: 'bottom', align: 'right', clip })

    for (let i = 0; i < card.lines.length; i++) {
      const y = inner.y + i
      if (y >= clip.y + clip.h) break
      this.drawLine(term, inner, y, card.lines[i]!, clip)
    }

    // The picture under the text, on the text's left margin, a blank row between.
    const pics = this.env.pics
    if (card.image && pics) {
      const pic = pics.picture(card.image, this.picBounds.cols, this.picBounds.rows)
      if (pic) {
        const top = inner.y + card.lines.length + 1
        for (let i = 0; i < pic.lines.length; i++) {
          const y = top + i
          if (y < clip.y || y >= clip.y + clip.h) continue
          term.text(inner.x + 1, y, pic.lines[i]!, NORMAL)
        }
      }
    }
  }

  private centred(term: Grid, text: string): void {
    const p = this.pane
    term.text(p.x + Math.max(0, Math.floor((p.w - text.length) / 2)), p.y + Math.floor(p.h / 2), text)
    term.showCursor = false
  }

  /** A rule across the top and one across the bottom, no sides: the records are the boxes. */
  private drawRules(term: Grid): void {
    // One cell past both edges, so the end cells resolve to `─` rather than nubs.
    hline(term, 0, -1, term.cols)
    hline(term, term.rows - 1, -1, term.cols)
  }

  private drawChromeLabels(term: Grid): void {
    // The main list's masthead is an inverse field on the right; a member's list
    // names its member plain on the left, badges opposite.
    const masthead = !this.author
    label(
      term,
      this.outer,
      this.author ? `@${this.author}` : [{ text: ` ${TITLE} `, inverse: true, attr: BRIGHT | BOLD }],
      { attr: BRIGHT | BOLD, ...(masthead ? { align: 'right' as const } : {}) },
    )

    if (this.queued.length) {
      label(term, this.outer, [
        { text: `${ARROWS[0]} ${this.queued.length} NEW `, attr: BRIGHT },
        { text: ' N ', inverse: true, attr: DIM },
      ], masthead ? {} : { align: 'right' })
    } else if (masthead) {
      label(term, this.outer, 'FEED', { attr: BRIGHT | BOLD })
    }
    const badges = this.profile?.badges ?? []
    if (this.author && badges.length) {
      label(term, this.outer, badges.flatMap((b, i): Span[] => [
        ...(i ? [{ text: ' ' }] : []),
        { text: ` ${b} `, inverse: true, attr: DIM },
      ]), { align: 'right' })
    }
    if (this.status) label(term, this.outer, this.status, { edge: 'bottom' })

    // A key is advertised only when it would do something.
    const groups: Span[][] = [
      ...(this.links().length ? [HINT_LINKS] : []),
      ...(this.entries.length ? [HINT_REPLY] : []),
      ...(this.selectedAuthor() ? [HINT_BIO] : []),
      ...(this.userTarget() ? [HINT_USER] : []),
      HINT_FIND,
      HINT_WRITE,
      this.open ? HINT_OPEN : HINT,
    ]
    // The row is shared with the status on the left. Whole groups go from the
    // front (the situational keys) until the rest fits; the movement keys stay.
    const width = (g: Span[][]): number => g.flat().reduce((n, s) => n + cells(s.text), 2)
    const budget = term.cols - 2 - (this.status ? cells(this.status) + 4 : 0)
    while (groups.length > 1 && width(groups) > budget) groups.shift()
    label(term, this.outer, groups.flat(), { edge: 'bottom', align: 'right', max: budget })
  }

  /** Links on the open card or the selected record. */
  private links(): FeedLink[] {
    if (this.open) return this.cards[this.readSel]?.links ?? []
    const entry = this.entries[this.sel]
    return entry ? bodyLinks(entry.body) : []
  }

  private selectedAuthor(): string | undefined {
    return this.open ? this.cards[this.readSel]?.username : this.entries[this.sel]?.username
  }

  /** Whose list U would open, or nothing when it is the list already shown. */
  private userTarget(): string | undefined {
    const who = this.selectedAuthor()
    return who && who !== this.author ? who : undefined
  }

  /** Ask before leaving the program. Escape one level down does not ask. */
  private confirmQuit(): void {
    const popup = new ConfirmPopup({
      title: 'EXIT',
      lines: ['Quit the feed?'],
      hint: YES_NO,
      bounds: this.pane,
      shadow: true,
      onFeedback: (kind) => { if (kind !== 'inert') this.snd.blip(420, 0.09, 0) },
      onDone: (yes) => {
        this.host.pop()
        if (this.closed) return
        if (yes) this.quit()
      },
    })
    this.host.push(popup)
  }

  /**
   * Reply to the selected record or card. A thread is flat: every reply belongs
   * to the post, and answering a reply only decides who is told.
   */
  private openReply(): void {
    const entry = this.entries[this.sel]
    if (!entry || this.posting) {
      if (!entry) this.snd.beep(220, 0.12)
      return
    }
    const card = this.open ? this.cards[this.readSel] : undefined
    // A restored box answers the draft's parent: the cursor is on the record,
    // not on the card that was open when it was typed.
    const kept = this.env.reply(entry.id)
    const parent = card?.replyId
      ? { id: card.replyId, username: card.username }
      : kept?.parentId && kept.parentUsername
        ? { id: kept.parentId, username: kept.parentUsername }
        : undefined
    const to = parent?.username ?? entry.username

    this.modal = 'reply'
    this.host.push(new EditorPopup({
      title: 'REPLY',
      note: `to @${to}`,
      hint: POPUP_HINT('^S Post', 'ESC Cancel'),
      confirm: 'Sure? Y/N',
      initial: kept?.text,
      caret: 'end',
      maxLength: REPLY_MAX,
      bounds: this.pane,
      shadow: true,
      onFeedback: (kind) => {
        if (kind === 'reject') this.snd.beep(220, 0.04)
        else if (kind === 'submit') this.snd.blip(660, 0.06, 0)
        else if (kind === 'cancel') this.snd.blip(420, 0.09, 0)
      },
      onEdit: (text) => {
        this.env.setReply(entry.id, text.trim()
          ? { text, ...(parent && { parentId: parent.id, parentUsername: parent.username }) }
          : null)
      },
      onDone: (text) => {
        this.modal = undefined
        this.host.pop()
        // A cancel keeps the draft; only a sent reply drops it.
        if (text) void this.post(entry, text, parent)
      },
    }))
    this.save()
  }

  /** The composer, pushed like a modal. A publish refetches so the new post is at the top. */
  private openWrite(): void {
    if (this.posting) { this.snd.beep(220, 0.12); return }
    this.modal = 'write'
    this.host.push(new WriteScreen(this.host, {
      draft: this.env.draft(),
      onDraft: d => this.env.setDraft(d),
      done: (published) => {
        this.modal = undefined
        this.host.pop()
        if (this.closed) return
        if (published) void this.refresh()
      },
    }))
    this.save()
  }

  /** Send the reply, then refetch the thread and select it. */
  private async post(entry: FeedEntry, text: string, parent?: { id: string; username: string }): Promise<void> {
    this.posting = true
    this.status = 'POSTING'
    this.drawChrome()
    this.snd.seek?.(2)

    let id: string | undefined
    try {
      const r = await this.host.api.post<{ replyId?: string }>('/v1/replies', {
        postId: entry.id,
        content: text,
        ...(parent && { parentReplyId: parent.id }),
      })
      id = r.replyId
    } catch (err) {
      console.error('feed: reply failed', err)
    } finally {
      this.posting = false
    }
    if (this.closed) return

    if (!id) {
      this.status = 'POST FAILED'
      this.snd.beep(220, 0.12)
      this.redraw()
      return
    }
    entry.replies += 1
    this.env.setReply(entry.id, null)
    this.pendingReply = id
    this.replyCache.delete(entry.id)
    if (this.open) void this.loadReplies(entry.id)
    else this.setOpen(true)
  }

  private async openBio(): Promise<void> {
    const who = this.selectedAuthor()
    // Guarded so B held down cannot stack a box per repeat.
    if (!who || this.bioLoading) {
      if (!who) this.snd.beep(220, 0.12)
      return
    }
    this.bioLoading = true
    this.status = 'LOADING BIO'
    this.drawChrome()
    this.snd.seek?.(1)

    const profile = await fetchProfile(this.host.api, who)
    this.bioLoading = false
    if (this.closed) return

    this.status = this.hasMore ? '' : EOF
    if (!profile) {
      this.status = 'NO PROFILE'
      this.snd.beep(220, 0.12)
      this.drawChrome()
      return
    }
    // The status rule is outside the box: repainted before the push snapshots the grid.
    this.drawChrome()

    const width = Math.max(24, Math.min(56, this.pane.w - 10))
    const portrait = portraitFits(width) ? this.portraitOf(profile) : undefined
    if (portrait) {
      try {
        portrait.lines = (await this.env.pics!.load(profile.picture!, profile.picture!, portrait.cols, PFP_ROWS)).lines
      } catch (err) {
        console.error('feed: portrait failed', err)
      }
      if (this.closed) return
    }

    const site = profile.website?.url
    this.modal = 'bio'
    const popup = new TextPopup({
      title: `@${profile.username}`,
      note: profile.badges.length
        ? profile.badges.flatMap((b, i): Span[] => [
          ...(i ? [{ text: ' ' }] : []),
          { text: ` ${b} `, inverse: true, attr: DIM },
        ])
        : undefined,
      lines: bioLines(profile, profile.joined ? when(profile.joined) : undefined, width, portrait),
      hint: site ? POPUP_HINT('L Link', 'ESC Close') : POPUP_HINT('ESC Close'),
      // L copies the site and the box stays; the box reports it in its own rule.
      action: site
        ? { key: 'l', silent: true, run: () => { popup.say(this.copy(site)); this.host.paint() } }
        : undefined,
      bounds: this.pane,
      shadow: true,
      onFeedback: (kind) => {
        if (kind === 'edge') this.snd.beep(220, 0.04)
        else if (kind === 'move') this.snd.tick()
      },
      onDone: () => {
        this.modal = undefined
        this.host.pop()
      },
    })
    this.host.push(popup)
    this.save()
  }

  private openUser(): void {
    const who = this.userTarget()
    if (!who) {
      this.snd.beep(220, 0.12)
      return
    }
    void this.showUser(who).start()
  }

  private openFind(): void {
    this.modal = 'find'
    this.host.push(new PromptPopup({
      title: 'FIND USER',
      prefix: '@',
      hint: POPUP_HINT('↵ Open', 'ESC Cancel'),
      bounds: this.pane,
      shadow: true,
      suggest: prefix => this.host.api.searchUsers(prefix),
      onUpdate: () => this.host.paint(),
      onFeedback: (kind) => {
        if (kind === 'edge') this.snd.beep(220, 0.04)
        else if (kind === 'move') this.snd.tick()
      },
      onDone: (name) => {
        this.modal = undefined
        this.host.pop()
        const who = name?.trim().replace(/^@/, '')
        if (who) void this.showUser(who).start()
      },
    }))
    this.save()
  }

  /** That member's posts, as another feed pushed on top of this one. */
  private showUser(who: string, opts: { silent?: boolean } = {}): FeedScreen {
    if (!opts.silent) this.snd.blip(520, 0.09, 0)
    const screen = new FeedScreen(this.env, () => { this.child = undefined; this.save() }, {
      author: who,
      parent: this,
      quit: () => {
        this.host.pop()
        this.quit()
      },
    })
    this.child = screen
    this.host.push(screen)
    return screen
  }

  /** The links box: Enter copies. Following one would take the whole machine away. */
  private openLinks(): void {
    const links = this.links()
    if (!links.length) {
      this.snd.beep(220, 0.12)
      return
    }
    this.modal = 'links'
    this.host.push(new SelectPopup({
      silentChoose: true,
      title: `LINKS (${links.length})`,
      items: links.map(l => l.url),
      hint: POPUP_HINT('↵ Copy', 'ESC Close'),
      bounds: this.pane,
      shadow: true,
      onFeedback: (kind) => {
        if (kind === 'edge') this.snd.beep(220, 0.04)
        else if (kind === 'move') this.snd.tick()
      },
      onDone: (url) => {
        this.modal = undefined
        this.host.pop()
        if (url) { this.copy(url); this.redraw() }
      },
    }))
    this.save()
  }

  /** Put text on the clipboard and say so. Returns the status for a caller under a modal. */
  private copy(text: string): string {
    this.host.copy(text)
    this.status = 'COPIED'
    this.snd.blip(880, 0.06, 0)
    if (this.copied) clearTimeout(this.copied)
    this.copied = setTimeout(() => {
      this.copied = null
      if (this.status !== 'COPIED') return
      this.status = this.hasMore ? '' : EOF
      this.drawChrome()
    }, COPIED_MS)
    return this.status
  }

  /** Repaint the rules and labels only, for a status change under an unchanged list. */
  private drawChrome(): void {
    if (this.closed || !this.active) return
    const term = this.host.s
    this.drawRules(term)
    this.drawChromeLabels(term)
    this.host.paint()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.print.stop()
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    if (this.copied) clearTimeout(this.copied)
    this.copied = null
    this.done()
  }
}

const MODALS = new Set<FeedModal>(['links', 'find', 'bio', 'reply', 'write'])

/** The parked state, if it is this program's and the current shape. Every field is checked. */
function readState(raw: unknown): FeedState {
  const none: FeedState = { v: STATE_VERSION, screens: [] }
  if (!raw || typeof raw !== 'object') return none
  const state = raw as { v?: unknown; screens?: unknown }
  if (state.v !== STATE_VERSION || !Array.isArray(state.screens)) return none

  const out: FeedSnapshot[] = []
  for (const item of state.screens) {
    if (!item || typeof item !== 'object') break
    const s = item as Record<string, unknown>
    if (typeof s.sel !== 'number' || !Number.isFinite(s.sel)) break
    const open = s.open as Record<string, unknown> | undefined
    out.push({
      author: typeof s.author === 'string' ? s.author : undefined,
      sel: Math.max(0, Math.floor(s.sel)),
      open: open && typeof open.id === 'string'
        ? { id: open.id, scroll: Math.max(0, Number(open.scroll) || 0), sel: Math.max(0, Number(open.sel) || 0) }
        : undefined,
      modal: MODALS.has(s.modal as FeedModal) ? (s.modal as FeedModal) : undefined,
    })
  }
  // Only the root may be authorless; the stack is cut at the first bad entry.
  const bad = out.findIndex((s, i) => i > 0 && !s.author)
  const screens = bad === -1 ? out : out.slice(0, bad)

  return { v: STATE_VERSION, screens }
}

/** The reader's own filter, from their settings and lists. Failure opens the filter. */
async function loadFilter(api: ApiClient): Promise<{ filter: FeedFilter; blog: boolean }> {
  try {
    const [settings, me] = await Promise.all([
      api.get<{ filterNSFW?: boolean; showGuildPostsInFeed?: boolean; defaultPublicPost?: boolean }>('/v1/settings'),
      api.get<{ mutedUsers?: string[]; blockedUsers?: string[] }>('/v1/users/me'),
    ])
    return {
      filter: {
        hidden: new Set([...(me.mutedUsers ?? []), ...(me.blockedUsers ?? [])]),
        nsfw: settings.filterNSFW !== true,
        guilds: settings.showGuildPostsInFeed !== false,
      },
      blog: settings.defaultPublicPost === true,
    }
  } catch (err) {
    console.error('feed: settings failed', err)
    return { filter: OPEN_FILTER, blog: false }
  }
}

/**
 * feed [@user]. `store` holds unsent writing between runs; without one the
 * drafts last only as long as the page.
 */
export function feedProgram(
  api: ApiClient,
  snd: FeedSound = SILENT,
  pictures?: ChatPictureHost,
  store?: DraftStore,
): Program {
  return async (p: Proc) => {
    if (!p.tty) { p.err('feed: no tty\n'); return 1 }
    if (!api.authed) { p.err('feed: not logged in\n'); return 1 }
    const tty = p.tty
    const s = new Surface(tty.cols, tty.rows)
    const stack = new ScreenStack(s as never)
    const pics = pictures?.()
    let running = true

    const author = p.argv[1]?.replace(/^@/, '') || undefined
    const drafts = new FeedDrafts(store, api.username ?? '')
    const parked = readState(p.takeState())
    let screens: FeedSnapshot[] = parked.screens
    // A restore only fits the list it was parked from.
    if (screens[0] && (screens[0].author ?? undefined) !== author) screens = []

    const park = (): void => {
      p.setState({ v: STATE_VERSION, screens } satisfies FeedState)
    }

    const host: FeedHost = {
      s,
      snd,
      api,
      username: api.username,
      push: screen => { stack.push(screen); tty.paint(s.render()) },
      pop: () => { stack.pop(); s.invalidate(); tty.paint(s.render()) },
      paint: () => tty.paint(s.render()),
      copy: text => tty.copy(text),
    }
    const unwatchPics = pics?.onLoad(() => { stack.top?.draw?.(s); host.paint() })

    tty.setRaw()
    // These answer themselves with a tick or a blip, so the host suppresses the key click.
    tty.silence(['ArrowUp', 'ArrowDown', 'Enter', 'Escape'])
    p.out('\x1b[?1049h')
    s.invalidate()
    p.setResume(author ? `feed @${author}` : 'feed')

    try {
      const { filter, blog } = await loadFilter(api)
      const env: FeedEnv = {
        host,
        pics,
        filter,
        state: shot => { screens = shot; park() },
        // A fresh draft takes the member's default for the blog flag; a kept one has its own.
        draft: () => drafts.post() ?? { ...EMPTY_DRAFT, blog },
        setDraft: d => drafts.setPost(d),
        reply: id => drafts.reply(id),
        setReply: (id, d) => drafts.setReply(id, d),
      }
      const done = (): void => { running = false; p.stdin.interrupt?.() }
      const root = new FeedScreen(env, done, { author })
      // push() draws the root, and the draw parks a fresh state over `screens`.
      const restoring = screens
      host.push(root)
      void root.start(restoring)
      p.onStop = () => root.pause()
      p.onCont = () => { root.resume(); s.invalidate(); host.paint() }

      while (running) {
        const chunk = await p.stdin.read()
        if (chunk === null) break
        for (const k of parseKeys(dec.decode(chunk))) {
          if (!running) break
          stack.key(k)
          host.paint()
        }
      }
      return 0
    } finally {
      running = false
      // Pop what is left so every screen's dispose runs (timers, reveals).
      while (stack.active) stack.pop()
      // The debounced write would never fire once the program is gone.
      drafts.flush()
      unwatchPics?.()
      pics?.release()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
