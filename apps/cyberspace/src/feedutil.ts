// The feed's data shapes and the pure functions that produce them: markdown
// to display blocks, API records to entries, and the client-side filter.
//
// The API returns raw markdown. Blocks, word counts and the lifted-out picture
// are all derived here, and derived the same way for a post and a reply.

// --- types --------------------------------------------------------------------

/** A run of a link's words inside a block's text, by character offset. */
export interface FeedLink { at: number; len: number; url: string }

export interface FeedQuote { text: string; links?: FeedLink[]; depth?: number }

export interface FeedListItem { text: string; links?: FeedLink[]; depth?: number; n?: number }

/**
 * One run of a body. A bare string is a paragraph with no links; a paragraph
 * with links carries their offsets; the others are shapes drawn differently.
 */
export type FeedBlock =
  | string
  | { text: string; links: FeedLink[] }
  | { code: string[] }
  | { list: FeedListItem[] }
  | { quote: FeedQuote[] }
  | { rule: true }

export interface FeedEntry {
  id: string
  username: string
  title?: string
  body: FeedBlock[]
  /** ms since epoch. */
  at: number
  topics: string[]
  words: number
  replies: number
  bookmarks: number
  /** The one picture drawn under the text, if the post has one. */
  image?: string
  nsfw?: boolean
}

export interface FeedReply {
  id: string
  username: string
  body: FeedBlock[]
  at: number
  image?: string
  parentId?: string
  parentUsername?: string
}

export interface FeedProfile {
  username: string
  /** Only when set and different from the username. */
  displayName?: string
  bio?: string
  joined?: number
  serial?: number
  location?: string
  website?: { text: string; url: string }
  /** Guild names, primary first, with the role after it when not a plain member. */
  guilds?: string[]
  /** ADMIN, MOD, SUPPORTER, HACKER, resolved here. */
  badges: string[]
  /** The square profile picture. Supporters and admins only, as on the site. */
  picture?: string
}

export interface PostDraft {
  title: string
  body: string
  /** The typed line, comma-separated. parseTopicLine() turns it into the list. */
  topics: string
  blog: boolean
  nsfw: boolean
  vent: boolean
}

// --- API records --------------------------------------------------------------

export interface ApiAttachment {
  type?: string
  src?: string
  artist?: string
  title?: string
}

interface Attached {
  attachments?: ApiAttachment[]
  hasAudioAttachment?: boolean
}

export interface ApiPost extends Attached {
  postId: string
  authorId?: string
  authorUsername?: string
  content?: string
  title?: string
  topics?: string[]
  repliesCount?: number
  bookmarksCount?: number
  isNSFW?: boolean
  isGuildThread?: boolean
  createdAt?: string
}

export interface ApiReply extends Attached {
  replyId: string
  authorId?: string
  authorUsername?: string
  content?: string
  parentReplyId?: string
  parentReplyAuthor?: string
  createdAt?: string
}

export interface ApiUser {
  username?: string
  displayName?: string
  bio?: string
  createdAt?: string
  serialNumber?: number
  locationName?: string
  locationLatitude?: number
  locationLongitude?: number
  websiteUrl?: string
  websiteName?: string
  isSiteAdmin?: boolean
  isModerator?: boolean
  isSupporter?: boolean
  isHacker?: boolean
  profilePictureUrl?: string
}

/** What the reader has asked not to see. Read once when the program starts. */
export interface FeedFilter {
  /** Author ids on the reader's mute and block lists. */
  hidden: Set<string>
  nsfw: boolean
  guilds: boolean
}

export const OPEN_FILTER: FeedFilter = { hidden: new Set(), nsfw: true, guilds: true }

/** Whether the reader would see this post on the site's own feed. */
export function keep(post: ApiPost, f: FeedFilter): boolean {
  if (post.authorId && f.hidden.has(post.authorId)) return false
  if (post.isNSFW && !f.nsfw) return false
  if (post.isGuildThread && !f.guilds) return false
  return true
}

export function keepReply(reply: ApiReply, f: FeedFilter): boolean {
  return !(reply.authorId && f.hidden.has(reply.authorId))
}

const ms = (iso?: string): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

export function toEntry(post: ApiPost): FeedEntry {
  const content = post.content ?? ''
  const { src, rest } = splitImage(post, content)
  const body = toBlocks(rest)
  const attachment = attachmentLine(post)
  if (attachment) body.push(attachment)
  return {
    id: post.postId,
    username: post.authorUsername ?? 'unknown',
    title: post.title || undefined,
    body,
    at: ms(post.createdAt),
    topics: post.topics ?? [],
    // Counted before the picture is lifted out, so the number matches the web card.
    words: countWords(content),
    replies: post.repliesCount ?? 0,
    bookmarks: post.bookmarksCount ?? 0,
    image: src,
    nsfw: post.isNSFW || undefined,
  }
}

export function toReply(reply: ApiReply): FeedReply {
  const content = reply.content ?? ''
  const { src, rest } = splitImage(reply, content)
  const body = toBlocks(rest)
  const attachment = attachmentLine(reply)
  if (attachment) body.push(attachment)
  return {
    id: reply.replyId,
    username: reply.authorUsername ?? 'unknown',
    body,
    at: ms(reply.createdAt),
    image: src,
    ...(reply.parentReplyId && { parentId: reply.parentReplyId }),
    ...(reply.parentReplyAuthor && { parentUsername: reply.parentReplyAuthor }),
  }
}

/** Badges follow the profile header's rules. isSubscriber is not public, so SUPPORTER reads isSupporter only. */
export function toProfile(user: ApiUser, fallback: string): FeedProfile {
  const badges: string[] = []
  if (user.isSiteAdmin) badges.push('ADMIN')
  else if (user.isModerator) badges.push('MOD')
  if (user.isSupporter) badges.push('SUPPORTER')
  if (user.isHacker) badges.push('HACKER')

  const username = user.username ?? fallback
  const name = user.displayName?.trim()
  const joined = ms(user.createdAt)
  return {
    username,
    displayName: name && name !== username ? name : undefined,
    bio: user.bio ? decodeEntities(user.bio) : undefined,
    joined: joined || undefined,
    serial: user.serialNumber,
    location: user.locationName
      || (user.locationLatitude != null && user.locationLongitude != null
        ? `${user.locationLatitude}, ${user.locationLongitude}`
        : undefined),
    website: user.websiteUrl
      ? { text: user.websiteName || user.websiteUrl, url: user.websiteUrl }
      : undefined,
    badges,
    // The site shows the picture for supporters, subscribers and admins. The
    // API strips isSubscriber from another member's profile, so a subscriber
    // who is not also a supporter shows none here.
    picture: user.profilePictureUrl && (user.isSupporter || user.isSiteAdmin)
      ? user.profilePictureUrl
      : undefined,
  }
}

const WEEK_MS = 7 * 24 * 60 * 60_000

/** Today is a clock, this week a weekday and clock, older a date. */
export function when(at: number): string {
  if (!at) return ''
  const then = new Date(at)
  const now = new Date()
  const clock = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`
  if (then.toDateString() === now.toDateString()) return clock
  if (now.getTime() - at < WEEK_MS) return `${then.toDateString().slice(0, 3)} ${clock}`
  return then.toISOString().slice(0, 10)
}

// --- text ---------------------------------------------------------------------

/** Plain text from markdown, for a one-line excerpt. Whitespace collapsed, entities decoded. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // Images before links: the link rule would otherwise take the `[alt](url)` half.
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '[IMG]')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    // `&amp;` last, so `&amp;lt;` does not decode twice.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

/** Word count as the web card computes it. Code fences are counted; they are content. */
export function countWords(content?: string | null): number {
  if (!content) return 0
  const plainText = content
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .trim()
  if (!plainText) return 0
  return plainText.split(/\s+/).filter(word => word.length > 0).length
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/** Stored bios can carry character entities from the editor. Unknown names pass through. */
export function decodeEntities(input: string | null | undefined): string {
  if (!input) return ''
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      if (Number.isNaN(codePoint)) return match
      try { return String.fromCodePoint(codePoint) } catch { return match }
    }
    return NAMED[body.toLowerCase()] ?? match
  })
}

/** What a single topic may be, in characters. */
export const MAX_TOPIC_LENGTH = 50
/** Topics a post may carry, before the hidden `vent` slot. */
export const MAX_TOPICS = 3

/** One topic as typed: lowercased, hyphens to spaces, then letters, digits and spaces only. */
export function normalizeTopicText(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A comma-separated line to the topic list: cleaned, blanks and over-long dropped, deduped, capped. */
export function parseTopicLine(line: string): string[] {
  return line
    .split(',')
    .map(normalizeTopicText)
    .filter(t => t.length > 0 && t.length <= MAX_TOPIC_LENGTH)
    .filter((t, i, self) => self.indexOf(t) === i)
    .slice(0, MAX_TOPICS)
}

// --- markdown to blocks -------------------------------------------------------

/**
 * Fences come out first, before the blank-line split and stripMarkdown, both of
 * which destroy code: the split tears a block at its own empty lines and the
 * strip collapses indentation.
 */
export function toBlocks(content: string): FeedBlock[] {
  const out: FeedBlock[] = []
  let prose: string[] = []
  let code: string[] | null = null

  const flushProse = (): void => {
    for (const para of prose.join('\n').split(/\n\s*\n/)) out.push(...splitLists(para))
    prose = []
  }
  const flushCode = (lines: string[]): void => {
    while (lines.length && !lines[0]!.trim()) lines.shift()
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
    // The grid has no tab glyph.
    if (lines.length) out.push({ code: lines.map(l => l.replace(/\t/g, '  ')) })
  }

  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) flushCode(code)
      else flushProse()
      code = code ? null : []
      continue
    }
    if (code) code.push(line)
    else prose.push(line)
  }
  // An unclosed fence is still a code block.
  if (code) flushCode(code)
  flushProse()
  return out
}

/**
 * `[words](https://…)` with an optional title, and the leading `!` of an image.
 * The label allows one level of nested brackets, which `[[link]](url)` needs.
 */
const MD_LINK =
  /(!?)\[((?:[^[\]]|\[[^[\]]*\])+)\]\((https?:\/\/[^)\s]+?)(?:\s+"[^"]*")?\)/g

/** stripMarkdown without the trim, so a fragment keeps the space that separated it from a link. */
function stripFragment(s: string): string {
  if (!s) return ''
  const lead = /^\s/.test(s) ? ' ' : ''
  const tail = /\s$/.test(s) ? ' ' : ''
  const core = stripMarkdown(s)
  if (!core) return lead || tail ? ' ' : ''
  return lead + core + tail
}

/** One paragraph flattened, with its links marked where their words landed. */
function flattenInline(md: string): { text: string; links: FeedLink[] } {
  let text = ''
  const links: FeedLink[] = []
  let last = 0

  MD_LINK.lastIndex = 0
  for (const m of md.matchAll(MD_LINK)) {
    text += stripFragment(md.slice(last, m.index))
    last = m.index + m[0].length
    // An image still here is one the card is not drawing. Named, not linked.
    if (m[1]) { text += '[IMG]'; continue }
    const words = stripFragment(m[2]!).trim()
    if (words) links.push({ at: text.length, len: words.length, url: m[3]! })
    text += words
  }
  text += stripFragment(md.slice(last))
  text = collapse(text, links)
  return { text, links }
}

function toBlock(md: string): FeedBlock | null {
  const { text, links } = flattenInline(md)
  if (!text) return null
  return links.length ? { text, links } : text
}

/** Three or more of one mark. Only a rule when nothing precedes it in the paragraph. */
const RULE_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE_LINE = /^\s*(>+)\s?(.*)$/
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/

/**
 * Split a paragraph into the lists and quotes in it and the prose around them.
 * Lists come out before stripMarkdown sees them, which would delete the markers
 * and fuse the items. An unmarked line under an item or a quote continues it.
 */
function splitLists(para: string): FeedBlock[] {
  const out: FeedBlock[] = []
  let prose: string[] = []
  let items: FeedListItem[] | null = null
  let quotes: FeedQuote[] | null = null
  // One running number per depth, so a nested list restarts at 1.
  let counters: number[] = []

  const flushProse = (): void => {
    const block = prose.length ? toBlock(prose.join(' ')) : null
    if (block) out.push(block)
    prose = []
  }
  const flushList = (): void => {
    if (items?.length) out.push({ list: items })
    items = null
    counters = []
  }
  const flushQuote = (): void => {
    if (quotes?.length) out.push({ quote: quotes })
    quotes = null
  }
  const extend = (tail: { text: string; links?: FeedLink[] }, line: string): void => {
    const more = flattenInline(line)
    if (!more.text) return
    for (const link of more.links) link.at += tail.text.length + 1
    tail.text += ' ' + more.text
    if (more.links.length) tail.links = [...(tail.links ?? []), ...more.links]
  }

  for (const line of para.split('\n')) {
    if (RULE_LINE.test(line)) {
      // Setext heading: the words above stay, the underline goes.
      if (prose.some(l => l.trim())) continue
      flushQuote()
      flushList()
      flushProse()
      out.push({ rule: true })
      continue
    }

    const q = line.match(QUOTE_LINE)
    if (q) {
      if (!quotes) { flushProse(); flushList(); quotes = [] }
      const depth = Math.min(q[1]!.length, 4)
      const { text, links } = flattenInline(q[2]!)
      const tail = quotes[quotes.length - 1]
      if (!text) {
        if (tail?.text) quotes.push({ text: '', depth })
      } else if (tail && (tail.depth ?? 1) === depth && tail.text) {
        extend(tail, q[2]!)
      } else {
        quotes.push({ text, links: links.length ? links : undefined, depth })
      }
      continue
    }
    if (quotes) {
      const tail = quotes[quotes.length - 1]
      if (line.trim() && tail?.text) { extend(tail, line); continue }
      flushQuote()
      if (!line.trim()) continue
    }

    const m = line.match(LIST_ITEM)
    if (m) {
      if (!items) { flushProse(); items = [] }
      // Two spaces to a level; an odd count rounds down.
      const depth = Math.min(Math.floor(m[1]!.length / 2), 6)
      counters.length = depth + 1
      const ordered = m[3] !== undefined
      counters[depth] = ordered ? (counters[depth] ?? 0) + 1 : 0
      const { text, links } = flattenInline(m[4]!)
      items.push({
        text,
        links: links.length ? links : undefined,
        depth: depth || undefined,
        n: ordered ? counters[depth] : undefined,
      })
      continue
    }
    if (items) {
      const tail = items[items.length - 1]
      if (line.trim() && tail) { extend(tail, line); continue }
      flushList()
      continue
    }

    prose.push(line)
  }

  flushQuote()
  flushList()
  flushProse()
  return out
}

/** Squeeze runs of whitespace to one space, moving the link offsets with the text. */
function collapse(text: string, links: FeedLink[]): string {
  let out = ''
  const map = new Int32Array(text.length + 1)
  for (let i = 0; i < text.length; i++) {
    map[i] = out.length
    const ch = text[i]!
    if (/\s/.test(ch)) {
      if (out.length && !out.endsWith(' ')) out += ' '
    } else {
      out += ch
    }
  }
  map[text.length] = out.length

  const trimmed = out.trimEnd()
  const lead = out.length - out.trimStart().length
  for (const link of links) {
    const start = Math.min(map[link.at]!, trimmed.length)
    const end = Math.min(map[link.at + link.len]!, trimmed.length)
    link.at = Math.max(0, start - lead)
    link.len = Math.max(0, end - start)
  }
  return trimmed.slice(lead ? lead : 0)
}

/** Eleven of the URL-safe alphabet, which is a YouTube id. */
const YOUTUBE_ID = /^[\w-]{11}$/

function audioUrl(audio: { src?: string }): string | undefined {
  const src = audio.src?.trim()
  if (!src) return undefined
  if (src.startsWith('https://')) return src
  return YOUTUBE_ID.test(src) ? `https://www.youtube.com/watch?v=${src}` : undefined
}

/**
 * An attached track as a line the reader can copy the address of. The whole
 * token is the link, brackets included.
 */
function attachmentLine(post: Attached): FeedBlock | null {
  const audio = post.attachments?.find(a => a.type === 'audio')
  if (audio) {
    const name = [audio.artist, audio.title].filter(Boolean).join(' - ')
    const text = name ? `[SONG: ${name}]` : '[SONG]'
    const url = audioUrl(audio)
    return url ? { text, links: [{ at: 0, len: text.length, url }] } : text
  }
  if (post.hasAudioAttachment) return '[SONG]'
  return null
}

/** `![alt](https://… "title")`, the form the editor writes. */
const INLINE_IMAGE = /!\[[^\]]*\]\((https:\/\/[^)\s]+?)(?:\s+"[^"]*")?\)/

/**
 * The picture on a post and the content with it taken out. Attachments are
 * read first; posts in practice carry the image inline in the content. Only
 * the first image is lifted; any others stay as `[IMG]`. https only, since the
 * decoder needs a readable cross-origin fetch.
 */
export function splitImage(post: Attached, content: string): { src?: string; rest: string } {
  const attached = post.attachments?.find(a => a.type === 'image')?.src
  if (attached?.startsWith('https://')) return { src: attached, rest: content }
  const m = content.match(INLINE_IMAGE)
  if (!m || m.index === undefined) return { rest: content }
  return {
    src: m[1],
    rest: content.slice(0, m.index) + content.slice(m.index + m[0].length),
  }
}
