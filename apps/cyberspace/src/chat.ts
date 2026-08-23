// Message layout and type-out, shared by circ and cmail.
//
// The two programs differ only in where a message goes, so entry composition,
// the nick column and the type-out clock live here rather than being duplicated
// and drifting apart.
//
// Pictures and /art blocks are laid out as ordinary rows. Songs and GIFs are
// named rather than played; a GIF would need a frame clock to be worth drawing.

import {
  hangingWrap, plain, NORMAL, BRIGHT, DIM, BOLD, type LogLine, type LineSpan,
} from '@cyberspace/tui'

/** Width of the nick field. */
export const NICK_W = 10
/** Width of the fixed prefix, e.g. `12:34 alice      `, that a message hangs under. */
export const HEAD_W = 5 + 1 + NICK_W + 1

/** Characters per second: 2400 baud at ten bits per character. */
export const BAUD_CPS = 240
/** Frequency of the bleep played as characters are typed out. */
export const BLIP_HZ = 1400
const TICK_MS = 16
/**
 * Queue depth beyond which messages appear whole instead of typing out, so a
 * backlog that arrived while away is not retyped in real time.
 */
const MAX_PENDING = 4
/** Blink period in ms, matching the cursor's, so the two stay in step. */
export const BLINK_MS = 480

/** Solid-headed arrows: bdf.ts synthesises these for any face. */
export const ARROWS = '⬆⬇'
/** Operator sigil, drawn inside the nick field rather than before it. */
export const OP = '@'
/** Marker for an idle member in the online pane. */
export const ASLEEP = 'zZ'
/** Prefix for an action line, which runs from the margin: space, rule, arrow, space. */
export const ACTION_HEAD = ' ─⭢ '
/** Placeholder for an attachment that cannot be drawn. */
export const IMG = '[IMG]'

/**
 * Sounds a chat screen requests. The host implements them; this module produces
 * no audio itself.
 */
export interface ChatSound {
  /** Selection moved: a row of a list, a line of scrollback. */
  tick(): void
  /** Movement refused at an edge. */
  beep(hz?: number, dur?: number): void
  /** Characters were typed out. */
  blip(hz?: number, dur?: number, jitter?: number): void
}

export const SILENT: ChatSound = { tick() {}, beep() {}, blip() {} }

export interface ChatUser {
  username: string
  op?: boolean
  asleep?: boolean
}

export interface ChatMessage {
  id: string
  username?: string
  timestamp?: number
  content?: string
  action?: boolean
  system?: boolean
  deleted?: boolean
  blink?: boolean
  /** Attachments named rather than drawn: a song, a GIF, an unreadable picture. */
  attachment?: boolean
  /** A picture to halftone, if the host supplies a decoder. */
  imageUrl?: string
  /** An `/art` block, one row per line, already decoded. See chatui.artLines. */
  art?: string[]
}

/**
 * The nick as drawn. The operator sigil sits inside the nick field, so the text
 * column stays fixed and an operator's name has one character less room, rather
 * than every other line shifting across.
 *
 * Folded to one cell per character, like a message body: the field is padded by
 * code point, so a wide character would otherwise leave the text column ragged.
 */
export function nick(u: { username?: string; op?: boolean }): string {
  return (u.op ? OP : '') + plain(u.username ?? '?')
}

export function hhmm(at?: number): string {
  return new Date(at || Date.now()).toTimeString().slice(0, 5)
}

export function entryHead(m: ChatMessage): string {
  return `${hhmm(m.timestamp)} ${nick(m).slice(0, NICK_W).padEnd(NICK_W)} `
}

/**
 * The prefix and text of one entry. Used both by the type-out clock, which
 * counts against it, and by the renderer, which wraps it, so the two cannot
 * disagree about an entry's length.
 */
export function entryParts(m: ChatMessage): { head: string; body: string } {
  const said = m.content ?? ''
  const text = [said, m.attachment ? IMG : ''].filter(Boolean).join(' ')
  if (m.action) return { head: ACTION_HEAD, body: `${nick(m)} ${text}` }
  return { head: entryHead(m), body: text }
}

/**
 * Whether the text mentions the reader.
 *
 * Matches `@(\w+)` case-insensitively, the same pattern the web client uses, so
 * both agree on what counts as a mention. Tested against the message text, not
 * the drawn line, whose sigils and padding are presentation only.
 */
export function mentions(text: string, username: string): boolean {
  if (!username) return false
  const me = username.toLowerCase()
  for (const found of text.matchAll(/@(\w+)/g)) {
    if (found[1].toLowerCase() === me) return true
  }
  return false
}

export interface EntryOptions {
  /** Characters revealed so far, for a message still typing out. */
  reveal?: number
  /** Whether the text revealed so far mentions the reader. */
  namesMe?(said: string): boolean
  /** Blink phase. False is the half where blinking text is blank. */
  blinkOn?: boolean
  /** The halftoned picture, once requested and loaded. */
  picture?: Picture
}

/**
 * A picture as the layout sees it: rows of cells to place.
 *
 * Cell contents are the faceplate's concern. Here a picture row is a string, so
 * it never wraps, scrolls with the log and clips at the pane like any other
 * line. See app/src/image.ts.
 */
export interface Picture {
  cols: number
  rows: number
  lines: string[]
}

/**
 * How a screen requests a picture.
 *
 * The faceplate owns the decoder, cache and bank; a screen stores nothing. A
 * host without a decoder supplies none of this, and the attachment is named in
 * text instead.
 *
 * Laying out and loading are separate calls because a screen lays out every
 * entry it holds and draws one pane of them. Loading the rest would exhaust the
 * bank on pictures nobody can see.
 */
export interface ChatPictures {
  /** The picture at this size, if it is rasterised. A lookup, never a fetch. */
  picture(src: string, maxCols: number, maxRows: number): Picture | undefined
  /** The pictures on the pane: the ones worth loading and worth keeping. */
  ensure(srcs: Iterable<string | undefined>, maxCols: number, maxRows: number): void
  /** Whether this source could not be read. Still loading is not failure. */
  failed(src: string): boolean
  /** Called when a picture arrives and the screen needs repainting. Returns an unsubscribe. */
  onLoad(cb: () => void): () => void
  /** Release this screen's slots. Called once, on exit. */
  release(): void
}

/**
 * One scope per program run rather than per registration: a screen's pictures
 * belong to it, and it releases them on exit.
 */
export type ChatPictureHost = () => ChatPictures

/**
 * The rows a picture or art block adds under an entry.
 *
 * Indented to the text column so the picture starts where the words do. Drawn
 * at the attribute the rasteriser chose, since a picture carries its own
 * exposure, and never with the mention highlight, which would wash it out.
 */
function blockLines(lines: string[], indent: number, attr: number): LogLine[] {
  const pad = ' '.repeat(indent)
  return lines.map(text => ({ text: pad + text, attr }))
}

/** A system line, indented to the same gutter as messages. */
export function systemLines(text: string, width: number, indent = HEAD_W): LogLine[] {
  return hangingWrap(' '.repeat(indent), text, width).map(line => ({ text: line }))
}

/** One entry as drawn rows, wide layout: a 17-column gutter with the text hung under it. */
export function entryLines(m: ChatMessage, width: number, opts: EntryOptions = {}): LogLine[] {
  if (m.system) return systemLines(m.content ?? '', width)

  const reveal = opts.reveal ?? Infinity
  const { head, body } = entryParts(m)
  const said = body.slice(0, reveal - head.length)
  // Until the prefix has finished typing there is no text column to hang under.
  let wrapped = reveal < head.length
    ? [head.slice(0, reveal)]
    : hangingWrap(head, said, width)

  // A mention draws the whole entry on the modal background. Tested against the
  // text typed out so far, so the highlight appears on the character that
  // completes the name.
  const forMe = opts.namesMe?.(said) ?? false
  // Also bolded: the background is a sixth of the beam level of the text, so
  // weight carries the rest of the highlight.
  const lit = forMe ? BOLD : 0

  // Blink blanks the text only. The row count must not change with the phase.
  if (m.blink && opts.blinkOn === false) {
    wrapped = wrapped.map(l => l.slice(0, head.length))
  }

  // The name is spanned separately so it stands out; continuation rows have no
  // name. In an action it sits within the sentence rather than its own column,
  // so the span moves with it and carries the highlight weight.
  const name: LineSpan = m.action
    ? { at: head.length, len: nick(m).length, attr: BRIGHT | lit }
    : { at: 6, len: NICK_W, attr: BRIGHT }

  // The timestamp is drawn DIM so the name reads first. An action has no
  // timestamp; it runs from the margin.
  const spans = m.action ? [name] : [{ at: 0, len: 5, attr: DIM }, name]

  const rows: LogLine[] = wrapped.map((text, i) => ({
    text,
    attr: (m.deleted ? DIM : NORMAL) | lit,
    spans: i === 0 ? spans : undefined,
    bar: forMe,
    // The highlight covers the body and starts where the body does, for both
    // messages and actions, so continuation rows share one left edge.
    barFrom: head.length,
  }))

  // Nothing is hung under a prefix still typing out, or a picture would appear
  // before the name it belongs to.
  if (reveal < head.length) return rows

  const tail = tailLines(m, opts.picture, width, head.length)
  if (!tail.length) return rows
  // An image-only message has one row of prefix and no text, so the first row
  // of the block goes on it rather than below it.
  if (!body && rows.length === 1) {
    const first = tail.shift()!
    rows[0] = { ...rows[0]!, text: head + first.text.slice(head.length) }
    // The prefix keeps its attribute and the block rows keep theirs, using the
    // same span mechanism that already re-attributes the timestamp and name.
    rows[0]!.spans = [...(rows[0]!.spans ?? []), {
      at: head.length, len: Math.max(0, first.text.length - head.length), attr: first.attr ?? NORMAL,
    }]
  }
  return rows.concat(tail)
}

/**
 * The rows hung under an entry: an art block, then a picture.
 *
 * Merged onto the prefix row when the message has no text, which is the common
 * case for an attachment, so a small pane does not spend a row on a blank line.
 */
function tailLines(
  m: ChatMessage, picture: Picture | undefined, width: number, indent: number,
): LogLine[] {
  const out: LogLine[] = []
  if (m.art?.length) {
    const room = Math.max(1, width - indent)
    out.push(...blockLines(m.art.map(l => l.slice(0, room)), indent, NORMAL))
  }
  if (picture) out.push(...blockLines(picture.lines, indent, DIM))
  return out
}

/**
 * Narrow layout, for a pane under 60 columns.
 *
 * entryLines() hangs text under a 17-column gutter, which leaves only 24
 * columns of a 41-column pane at 44 columns wide. Here the prefix becomes a row
 * of its own with the text from the margin beneath it.
 */
export function narrowLines(m: ChatMessage, width: number, opts: EntryOptions = {}): LogLine[] {
  if (m.system) return systemLines(m.content ?? '', width, 0)
  if (m.action) return entryLines(m, width, opts)

  const reveal = opts.reveal ?? Infinity
  const { head, body } = entryParts(m)
  const said = body.slice(0, Math.max(0, reveal - head.length))
  const forMe = opts.namesMe?.(said) ?? false
  // At this width the mention highlight covers the prefix row only.
  const lit = forMe ? BOLD : 0

  const time = hhmm(m.timestamp)
  // Truncated to the pane rather than NICK_W: there is no text column to hold.
  const who = nick(m).slice(0, Math.max(1, width - time.length - 1))
  const rows: LogLine[] = [{
    text: `${time} ${who}`,
    attr: NORMAL | lit,
    spans: [
      { at: 0, len: time.length, attr: DIM | lit },
      { at: time.length + 1, len: who.length, attr: BRIGHT | lit },
    ],
    bar: forMe,
    barFrom: 0,
  }]
  if (reveal < head.length) return rows

  // From the margin, like the text: this layout has no gutter to hang under.
  const tail = tailLines(m, opts.picture, width, 0)

  // Blanked rather than dropped, so the row count does not change with the
  // blink phase. An attachment with no text is the exception: wrapping '' would
  // still yield a row, and a blank line above a picture wastes one in this pane.
  const blank = m.blink && opts.blinkOn === false
  if (said || !tail.length) {
    for (const line of hangingWrap('', said, width)) {
      rows.push({ text: blank ? '' : line, attr: NORMAL })
    }
  }
  return rows.concat(tail)
}

/**
 * The opening screenful, revealed a line at a time rather than typed.
 *
 * Typing a backlog at 2400 baud would take minutes, so the first snapshot runs
 * on Reveal's clock instead, oldest of the closing screenful first.
 *
 * Converges exactly: at count === height the slice equals what drawLog would
 * show, so nothing shifts when the clock stops.
 */
export function printing(lines: LogLine[], height: number, count: number): LogLine[] {
  if (count === Infinity) return lines
  // Two slices rather than a pair of indices: with fewer lines than the pane
  // holds, length - height is negative and would index from the end.
  return lines.slice(Math.max(0, lines.length - height)).slice(0, count)
}

export interface TypewriterOptions {
  /** The whole entry as one string, for the message being typed out. */
  text(m: ChatMessage): string
  /** A batch of characters came due and the log needs repainting. */
  onTick(): void
  /** One or more non-blank characters were emitted. */
  onBlip(): void
}

/**
 * Queue of messages waiting to type out, and the clock that releases them a
 * character at a time.
 *
 * Owns the set of seen ids as well as the queue: novelty is decided by id, not
 * by the list having grown.
 */
export class Typewriter {
  /** Messages that have finished typing out. */
  displayed: ChatMessage[] = []
  /** Queued messages; [0] is the one currently typing. */
  pending: ChatMessage[] = []
  /** Characters of pending[0] revealed so far. */
  typed = 0

  private seen = new Set<string>()
  private t0 = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(private opts: TypewriterOptions) {}

  /** The message currently typing, as far as it has been revealed. */
  get head(): ChatMessage | undefined {
    return this.pending[0]
  }

  /** Seed from a room's first snapshot, which is backlog rather than new messages. */
  prime(messages: ChatMessage[]): void {
    this.displayed = messages
    this.seen = new Set(messages.map(m => m.id))
  }

  /** Take a later snapshot and return the messages new in it. */
  receive(messages: ChatMessage[]): ChatMessage[] {
    const waiting = new Set(this.pending.map(m => m.id))
    const fresh = messages.filter(m => !this.seen.has(m.id))
    this.displayed = messages.filter(m => this.seen.has(m.id) && !waiting.has(m.id))
    this.seen = new Set([...messages.map(m => m.id), ...waiting])
    return fresh
  }

  /** Queue new messages and start the clock if it is not running. */
  enqueue(fresh: ChatMessage[]): void {
    if (!fresh.length || this.closed) return
    this.pending.push(...fresh)

    // Beyond the cap, overflow appears whole; the last few still type out.
    if (this.pending.length > MAX_PENDING) {
      this.displayed = [
        ...this.displayed,
        ...this.pending.splice(0, this.pending.length - MAX_PENDING),
      ]
      this.typed = 0
      this.t0 = Date.now()
      this.opts.onTick()
    }

    if (this.timer === null) this.start()
  }

  /** Whether anything on screen or queued is blinking. */
  get blinking(): boolean {
    return this.displayed.some(m => m.blink) || this.pending.some(m => m.blink)
  }

  private start(): void {
    this.t0 = Date.now()
    this.typed = 0
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  private tick(): void {
    const m = this.pending[0]
    if (!m) { this.stop(); return }
    const full = this.opts.text(m)
    // Emitted on a timer rather than one sleep per character: at 2400 baud a
    // character is due every 4.2ms, below timer resolution. Per-tick batches
    // hold the average rate.
    const due = Math.min(full.length, Math.floor((Date.now() - this.t0) / 1000 * BAUD_CPS) + 1)
    if (due <= this.typed) return

    // One bleep per batch. A batch of only whitespace is silent.
    if (/\S/.test(full.slice(this.typed, due))) this.opts.onBlip()
    this.typed = due

    if (this.typed >= full.length) {
      this.displayed = [...this.displayed, m]
      this.pending.shift()
      if (this.pending.length) { this.t0 = Date.now(); this.typed = 0 }
      else this.stop()
    }
    this.opts.onTick()
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.typed = 0
  }

  /** Reset for a different conversation. */
  reset(): void {
    this.stop()
    this.displayed = []
    this.pending = []
    this.seen.clear()
  }

  close(): void {
    this.closed = true
    this.stop()
    this.pending = []
  }
}

/** Drives the blink phase, running only while something on screen blinks. */
export class Blinker {
  /** False during the blank half of the cycle. */
  on = true
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private onPhase: () => void) {}

  /** Recomputed on every paint. */
  sync(wanted: boolean): void {
    if (wanted && this.timer === null) {
      this.timer = setInterval(() => {
        this.on = !this.on
        this.onPhase()
      }, BLINK_MS)
    } else if (!wanted && this.timer !== null) {
      this.stop()
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    // Stops on the lit phase, so nothing is left blank.
    this.on = true
  }
}
