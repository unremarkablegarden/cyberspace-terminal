// What a message looks like, once.
//
// `circ` and `cmail` share everything about a line except where it goes: what
// an entry is made of, the nick column, the wire that types a new one out. Two
// copies of this would disagree within a month in ways the reader would see —
// a name in a different column, an arrival at a different speed.
//
// Ported from the machine at /terminal. Pictures, songs and art are not here:
// this one has no image pipeline yet, so an attachment is named rather than
// drawn.

import {
  hangingWrap, plain, NORMAL, BRIGHT, DIM, BOLD, type LogLine, type LineSpan,
} from '@cyberspace/tui'

/** Width of the nick field. */
export const NICK_W = 10
/** `12:34 alice      ` — the fixed prefix a message is written under. */
export const HEAD_W = 5 + 1 + NICK_W + 1

/** Characters a second: 2400 baud, ten bits to the character. */
export const BAUD_CPS = 240
/** The bleep a character makes coming off the wire. */
export const BLIP_HZ = 1400
const TICK_MS = 16
/**
 * Messages queued before the wire gives up and lands them whole. A room that
 * has been talking while you were away is not worth retyping in real time.
 */
const MAX_PENDING = 4
/** Blink phase: the cursor's own 480ms, so the two stay in step. */
export const BLINK_MS = 480

/** Solid-headed arrows: bdf.ts synthesises these for any face. */
export const ARROWS = '⬆⬇'
/** The op sigil, inside the nick field rather than in front of it. */
export const OP = '@'
/** Somebody idle, in the online pane. */
export const ASLEEP = 'zZ'
/** An action runs from the margin: space, rule, arrow, space. */
export const ACTION_HEAD = ' ─⭢ '
/** A named attachment, where the picture cannot be drawn. */
export const IMG = '[IMG]'

/**
 * The sounds a chat screen has an opinion about. It makes none of its own — the
 * host owns the speaker, as it owns the tube.
 */
export interface ChatSound {
  /** A move: a row of a list, a line of scrollback. */
  tick(): void
  /** Nowhere to go. */
  beep(hz?: number, dur?: number): void
  /** A character off the wire. */
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
  /** Named, not drawn. */
  attachment?: boolean
}

/**
 * The name as it is written: the sigil is INSIDE the nick field, so the text
 * column stays where it is and an op's name has one character less room.
 * Shifting every other line over to make space would be the worse trade.
 *
 * Folded like a message body: the field is padded by code point, so a name the
 * grid cannot hold in one cell each would leave the text column ragged as well
 * as costing the row a cell.
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
 * The prefix and the text of one entry — the pair the type-out clock counts
 * against and the pair the renderer wraps. One function, so the two can never
 * disagree about how long an entry is.
 */
export function entryParts(m: ChatMessage): { head: string; body: string } {
  const said = m.content ?? ''
  const text = [said, m.attachment ? IMG : ''].filter(Boolean).join(' ')
  if (m.action) return { head: ACTION_HEAD, body: `${nick(m)} ${text}` }
  return { head: entryHead(m), body: text }
}

/**
 * Does this text say your name?
 *
 * `@(\w+)`, case-insensitively — the same shape the web client uses, so both
 * agree on what being mentioned is. Tested against what was SAID, never against
 * the drawn line: an op's sigil is decoration this side of the wire.
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
  /** Characters revealed so far, for a message still coming off the wire. */
  reveal?: number
  /** Answers whether the text revealed so far names the reader. */
  namesMe?(said: string): boolean
  /** Blink phase. False is the half of it where blinking text is not there. */
  blinkOn?: boolean
}

/** A system line, hung under the same gutter the talk is. */
export function systemLines(text: string, width: number, indent = HEAD_W): LogLine[] {
  return hangingWrap(' '.repeat(indent), text, width).map(line => ({ text: line }))
}

/**
 * One entry as drawn rows, wide layout: a 17-column gutter and the words hung
 * under it.
 */
export function entryLines(m: ChatMessage, width: number, opts: EntryOptions = {}): LogLine[] {
  if (m.system) return systemLines(m.content ?? '', width)

  const reveal = opts.reveal ?? Infinity
  const { head, body } = entryParts(m)
  const said = body.slice(0, reveal - head.length)
  // Before the head is through there is no text column to hang under yet.
  let wrapped = reveal < head.length
    ? [head.slice(0, reveal)]
    : hangingWrap(head, said, width)

  // Being named lights the whole entry from behind, on the same ground a modal
  // sits on — tested against what has actually been typed out, so the bar lands
  // on the character your name does.
  const forMe = opts.namesMe?.(said) ?? false
  // And thickens what it lights: the ground is a sixth of the beam the words
  // are drawn at, so the weight is the other half of the highlight.
  const lit = forMe ? BOLD : 0

  // Blink blanks the words only; line count must not change with the phase.
  if (m.blink && opts.blinkOn === false) {
    wrapped = wrapped.map(l => l.slice(0, head.length))
  }

  // Lift the name out of the wall of text; continuations have none. In an
  // action it sits inside the sentence instead of its own column, so the span
  // moves with it — and takes the weight, being inside the bar.
  const name: LineSpan = m.action
    ? { at: head.length, len: nick(m).length, attr: BRIGHT | lit }
    : { at: 6, len: NICK_W, attr: BRIGHT }

  // The clock goes the other way: it is the least interesting thing on the row,
  // so it sits at DIM and the eye starts at the name. An action has no clock —
  // it runs from the margin.
  const spans = m.action ? [name] : [{ at: 0, len: 5, attr: DIM }, name]

  return wrapped.map((text, i) => ({
    text,
    attr: (m.deleted ? DIM : NORMAL) | lit,
    spans: i === 0 ? spans : undefined,
    bar: forMe,
    // The bar covers the body and stops where the body starts, for talk and for
    // an action alike — continuations hang to the same column, so the block has
    // one straight left edge.
    barFrom: head.length,
  }))
}

/**
 * The third layout, for a room under 60 columns.
 *
 * `entryLines` hangs everything under a 17-column gutter, which is a fine trade
 * at 80 and a fatal one at 44: the pane there is 41, and 41 minus 17 leaves 24
 * columns to say anything in. So the prefix stops being a column and becomes a
 * line of its own, with the words from the margin underneath.
 */
export function narrowLines(m: ChatMessage, width: number, opts: EntryOptions = {}): LogLine[] {
  if (m.system) return systemLines(m.content ?? '', width, 0)
  if (m.action) return entryLines(m, width, opts)

  const reveal = opts.reveal ?? Infinity
  const { head, body } = entryParts(m)
  const said = body.slice(0, Math.max(0, reveal - head.length))
  const forMe = opts.namesMe?.(said) ?? false
  // At this width the mention bar is the head row only.
  const lit = forMe ? BOLD : 0

  const time = hhmm(m.timestamp)
  // Cut to the pane, not to NICK_W: no text column to hold in place here.
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

  // Blank rather than dropped: line count must not change with the phase.
  const blank = m.blink && opts.blinkOn === false
  for (const line of hangingWrap('', said, width)) {
    rows.push({ text: blank ? '' : line, attr: NORMAL })
  }
  return rows
}

/**
 * The opening screenful, printed by the LINE rather than typed.
 *
 * `Typewriter` is no use for a backlog: at 2400 baud a room's first screenful
 * would be several minutes of somebody else's evening being retyped in front of
 * you. So the first snapshot goes on Reveal's clock instead, oldest of the
 * closing screenful first — a terminal printing a backlog, which is what a room
 * looked like before anyone had a scrollback to hold one.
 *
 * It converges exactly: at `count = height` the slice IS the screenful drawLog
 * would have shown, so nothing jumps when the clock stops.
 */
export function printing(lines: LogLine[], height: number, count: number): LogLine[] {
  if (count === Infinity) return lines
  // Two slices rather than a pair of indices: with fewer lines than the pane
  // holds, `length - height` is negative and would count back from the end.
  return lines.slice(Math.max(0, lines.length - height)).slice(0, count)
}

export interface TypewriterOptions {
  /** The whole entry as one string, for the message on the wire. */
  text(m: ChatMessage): string
  /** A batch came due and the log needs repainting. */
  onTick(): void
  /** One or more non-blank characters were emitted. */
  onBlip(): void
}

/**
 * The wire: messages waiting their turn, and the clock that lets them through a
 * character at a time.
 *
 * It owns the window as well as the queue, because the two are one question — a
 * message is new because we have not seen its id, never because the list got
 * longer.
 */
export class Typewriter {
  /** Messages that have finished typing out. */
  displayed: ChatMessage[] = []
  /** Waiting their turn; `[0]` is the one arriving. */
  pending: ChatMessage[] = []
  /** Characters of `pending[0]` revealed so far. */
  typed = 0

  private seen = new Set<string>()
  private t0 = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(private opts: TypewriterOptions) {}

  /** The one still coming in, as far as it has got. */
  get head(): ChatMessage | undefined {
    return this.pending[0]
  }

  /** The first snapshot of a room. What it opens with is already history. */
  prime(messages: ChatMessage[]): void {
    this.displayed = messages
    this.seen = new Set(messages.map(m => m.id))
  }

  /** A later snapshot. Returns what is new in it. */
  receive(messages: ChatMessage[]): ChatMessage[] {
    const waiting = new Set(this.pending.map(m => m.id))
    const fresh = messages.filter(m => !this.seen.has(m.id))
    this.displayed = messages.filter(m => this.seen.has(m.id) && !waiting.has(m.id))
    this.seen = new Set([...messages.map(m => m.id), ...waiting])
    return fresh
  }

  /** Put new messages on the wire and make sure the clock is running. */
  enqueue(fresh: ChatMessage[]): void {
    if (!fresh.length || this.closed) return
    this.pending.push(...fresh)

    // Past the cap the overflow lands whole; the last few still type.
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

  /** Is anything on screen or on the wire blinking? */
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
    // Emit on a clock rather than sleeping per character: at 2400 baud one is
    // due every 4.2ms, below what a timer can honour. Catching up in per-tick
    // batches keeps the rate honest.
    const due = Math.min(full.length, Math.floor((Date.now() - this.t0) / 1000 * BAUD_CPS) + 1)
    if (due <= this.typed) return

    // One bleep per batch; pure whitespace is silent.
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

  /** Start over on a different conversation. */
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

/** The blink phase, running only while something on screen blinks. */
export class Blinker {
  /** False is the dark half. */
  on = true
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private onPhase: () => void) {}

  /** Re-decided on every paint. */
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
    // Lit, so nothing stops while invisible.
    this.on = true
  }
}
