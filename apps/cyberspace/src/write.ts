// WRITE: a post, composed inside the feed. Pushed by feed's W key, not a
// registered program.
//
// Everything the /write page can make except what a character grid cannot
// hold: no attachments, no slug, no preview. The draft belongs to the feed
// program, which keeps it across the composer being opened and closed and in
// the parked session state, so leaving asks nothing. Only ^X (destroys) and
// ^P / ^S (write to the world) ask.

import type { Grid, KeyInput, Rect, Screen, Span } from '@cyberspace/tui'
import {
  ConfirmPopup, InputLine, TextBuffer, YES_NO, clear, drawBuffer, frame, hline, label,
  NORMAL, BRIGHT, BOLD, DIM,
} from '@cyberspace/tui'
import type { ApiClient } from './api.js'
import type { ChatSound } from './chat.js'
import { parseTopicLine, type PostDraft } from './feedutil.js'

/** Sounds the feed screens request. `seek` is the disk noise on a fetch. */
export interface FeedSound extends ChatSound {
  seek?(count?: number): void
}

/**
 * What a feed screen needs from the program that runs it: the grid it draws
 * into, the stack it pushes modals onto, and the API. Screens never hold the
 * tty; `paint` sends the grid.
 */
export interface FeedHost {
  s: Grid
  snd: FeedSound
  api: ApiClient
  username: string | null
  /** Push a modal and paint. */
  push(screen: Screen): void
  /** Pop the top screen, restoring the grid beneath, and paint. */
  pop(): void
  /** Send the grid to the terminal. */
  paint(): void
  copy(text: string): void
}

/** Site limits for a post, enforced server-side as well. */
const MAX_TITLE = 100
const MAX_BODY = 32768

type Field = 'title' | 'body' | 'topics' | 'flags'
/** Tab order, which is also the drawing order top to bottom. */
const FIELDS: Field[] = ['title', 'body', 'topics', 'flags']

const FLAGS = ['blog', 'nsfw', 'vent'] as const
type Flag = (typeof FLAGS)[number]

const FLAG_HELP: Record<Flag, string> = {
  blog: 'visible outside Cyberspace, and on your blog',
  nsfw: 'not safe for work; tag it',
  vent: 'adds the "vent" topic, which people can mute',
}

/** Columns the label gutter takes on the two one-line fields. */
const GUTTER = 8
const TITLE_HINT = '(Optional)'
const MORE = '...'

const trim = (text: string, width: number): string =>
  text.length <= width ? text : text.slice(0, Math.max(0, width - MORE.length)) + MORE

const HINT: Span[] = [
  { text: ' TAB ', inverse: true, attr: DIM },
  { text: ' Field ' },
  { text: ' ^X ', inverse: true, attr: DIM },
  { text: ' Clear ' },
  { text: ' ^S ', inverse: true, attr: DIM },
  { text: ' Note ' },
  { text: ' ^P ', inverse: true, attr: DIM },
  { text: ' Publish' },
]

/** ^X is the one dropped when the row is short: the two that write stay advertised. */
const HINT_NARROW: Span[] = [
  { text: ' TAB ', inverse: true, attr: DIM },
  { text: ' Field ' },
  { text: ' ^S ', inverse: true, attr: DIM },
  { text: ' Note ' },
  { text: ' ^P ', inverse: true, attr: DIM },
  { text: ' Post' },
]

/** Below this width the label gutter and the flag row stop fitting side by side. */
const NARROW = 60

export interface WriteOptions {
  draft: PostDraft
  /** Every change to the draft, for the program to keep. */
  onDraft(d: PostDraft): void
  /** Leaving, after a publish or on Escape. The caller pops. */
  done(published: boolean): void
}

export class WriteScreen implements Screen {
  private draft: PostDraft
  private title: InputLine
  private topics: InputLine
  private body: TextBuffer
  private field: Field = 'body'
  private flag = 0
  /** One line in the bottom rule: what happened, or why it did not. Cleared by the next edit. */
  private status = ''
  private busy = false
  private closed = false

  constructor(private host: FeedHost, private opts: WriteOptions) {
    this.draft = { ...opts.draft }
    const reject = (): void => this.host.snd.beep(220, 0.04)
    this.title = new InputLine({ prompt: '', maxLength: MAX_TITLE, placeholder: TITLE_HINT, onReject: reject })
    this.title.set(this.draft.title)
    // Three topics of fifty characters, commas, and room to be mid-word in a fourth.
    this.topics = new InputLine({ prompt: '', maxLength: 200, onReject: reject })
    this.topics.set(this.draft.topics)
    this.body = new TextBuffer({ initial: this.draft.body, maxLength: MAX_BODY, wrap: true, onReject: reject })
  }

  // --- layout -----------------------------------------------------------------

  private get outer(): Rect {
    return { x: 0, y: 0, w: this.host.s.cols, h: this.host.s.rows }
  }

  private get narrow(): boolean {
    return this.host.s.cols < NARROW
  }

  private get inner(): Rect {
    const r = this.outer
    return { x: r.x + 1, y: r.y + 1, w: Math.max(1, r.w - 2), h: Math.max(1, r.h - 2) }
  }

  private get titleRect(): Rect {
    const i = this.inner
    return { x: i.x + 1 + GUTTER, y: i.y, w: Math.max(1, i.w - 2 - GUTTER), h: 1 }
  }

  private get topicsRect(): Rect {
    const i = this.inner
    return { x: i.x + 1 + GUTTER, y: i.y + i.h - 2, w: Math.max(1, i.w - 2 - GUTTER), h: 1 }
  }

  /** Whatever the two one-line fields, two rules and the flag row leave. */
  private get bodyRect(): Rect {
    const i = this.inner
    const top = i.y + 2
    const bottom = i.y + i.h - 3
    return { x: i.x + 1, y: top, w: Math.max(1, i.w - 2), h: Math.max(1, bottom - top) }
  }

  private get flagRect(): Rect {
    const i = this.inner
    return { x: i.x + 1, y: i.y + i.h - 1, w: Math.max(1, i.w - 2), h: 1 }
  }

  // --- keys -------------------------------------------------------------------

  silentKey(e: KeyInput): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    return e.key === 'Tab' || e.key === 'Escape'
  }

  onKey(e: KeyInput): boolean {
    if (this.closed) return false

    // No key acts while a write is in flight: a second ^P would post twice.
    if (this.busy) {
      this.host.snd.beep(220, 0.04)
      return true
    }

    if (e.ctrlKey) {
      if (e.key === 'c') { this.quit(false); return true }
      if (e.key === 'p') { this.askPublish(); return true }
      if (e.key === 's') { this.askNote(); return true }
      if (e.key === 'x') { this.askClear(); return true }
      if (e.key === 'k' && this.field === 'body') {
        const used = this.body.killLine()
        if (used) this.touch()
        return used
      }
      return false
    }
    if (e.metaKey || e.altKey) return false

    if (e.key === 'Escape') { this.quit(false); return true }
    if (e.key === 'Tab') { this.move(e.shiftKey ? -1 : 1); return true }
    if (this.field === 'flags') return this.flagKey(e)

    if (this.field === 'body') {
      // Saved after the key, so the draft holds the text as it is now.
      const used = this.body.key(e)
      if (used) this.touch()
      return used
    }

    // A one-line field: Enter walks on.
    if (e.key === 'Enter') { this.move(1); return true }
    const line = this.field === 'title' ? this.title : this.topics
    if (line.onKey(e)) { this.touch(); return true }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return true
    return false
  }

  /** The toggles are a row stepped through with the arrows and flipped with Space or Enter. */
  private flagKey(e: KeyInput): boolean {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const next = this.flag + (e.key === 'ArrowLeft' ? -1 : 1)
      if (next < 0 || next >= FLAGS.length) { this.host.snd.beep(220, 0.04); return true }
      this.flag = next
      this.status = FLAG_HELP[FLAGS[this.flag]!]
      return true
    }
    if (e.key === ' ' || e.key === 'Enter') {
      const key = FLAGS[this.flag]!
      this.draft[key] = !this.draft[key]
      // Up for on, down for off.
      this.host.snd.blip(this.draft[key] ? 660 : 440, 0.05, 0)
      this.save()
      return true
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return true
    return false
  }

  private move(delta: number): void {
    const i = FIELDS.indexOf(this.field)
    this.field = FIELDS[(i + delta + FIELDS.length) % FIELDS.length]!
    this.status = this.field === 'flags' ? FLAG_HELP[FLAGS[this.flag]!] : ''
    this.host.snd.blip(520, 0.04, 0)
  }

  private touch(): void {
    this.status = ''
    this.save()
  }

  private save(): void {
    this.draft = {
      title: this.title.value,
      body: this.body.text,
      topics: this.topics.value,
      blog: this.draft.blog,
      nsfw: this.draft.nsfw,
      vent: this.draft.vent,
    }
    this.opts.onDraft(this.draft)
  }

  // --- the three questions ----------------------------------------------------

  private ask(title: string, lines: string[], go: () => void): void {
    this.host.push(new ConfirmPopup({
      title,
      lines,
      hint: YES_NO,
      shadow: true,
      onFeedback: (kind) => { if (kind !== 'inert') this.host.snd.blip(420, 0.09, 0) },
      onDone: (yes) => {
        this.host.pop()
        if (this.closed) return
        if (yes) go()
      },
    }))
  }

  private summary(withFlags: boolean): string[] {
    const topics = parseTopicLine(this.topics.value)
    const out: string[] = []
    if (withFlags) {
      out.push(`Blog ${this.draft.blog ? 'on' : 'off'}, NSFW ${this.draft.nsfw ? 'on' : 'off'}`
        + (this.draft.vent ? ', vent' : ''))
    } else if (this.draft.vent) {
      out.push('vent')
    }
    out.push(topics.length
      ? `${topics.length} topic${topics.length === 1 ? '' : 's'}: ${topics.join(', ')}`
      : 'no topics')
    return out
  }

  private askPublish(): void {
    if (!this.body.text.trim()) { this.host.snd.beep(220, 0.12); return }
    const who = this.host.username ? `@${this.host.username}` : 'the feed'
    this.ask('PUBLISH', [`Post to ${who}?`, ...this.summary(true)], () => { void this.run('publish') })
  }

  private askNote(): void {
    if (!this.body.text.trim()) { this.host.snd.beep(220, 0.12); return }
    // A note has no title and no flags on the API; the box says what is dropped.
    const lost: string[] = []
    if (this.title.value.trim()) lost.push('Title')
    if (this.draft.blog) lost.push('Blog')
    if (this.draft.nsfw) lost.push('NSFW')
    this.ask('SAVE NOTE', [
      'Save to your journal?',
      ...this.summary(false),
      ...(lost.length ? [`A note keeps no ${lost.join(', ')}.`] : []),
    ], () => { void this.run('note') })
  }

  private askClear(): void {
    if (!this.body.text.trim() && !this.title.value.trim() && !this.topics.value.trim()) {
      this.host.snd.beep(220, 0.12)
      return
    }
    this.ask('CLEAR', ['Throw this away?', 'It is not kept anywhere else.'], () => {
      this.wipe()
      this.host.snd.blip(420, 0.09, 0)
      this.status = 'cleared'
      this.redraw()
    })
  }

  private wipe(): void {
    this.title.clear()
    this.topics.clear()
    this.body.set('')
    this.draft = { title: '', body: '', topics: '', blog: this.draft.blog, nsfw: false, vent: false }
    this.opts.onDraft(this.draft)
  }

  /** Write it. A failure hands the composer back with everything still in it and the reason on the rule. */
  private async run(kind: 'publish' | 'note'): Promise<void> {
    this.busy = true
    this.status = kind === 'publish' ? 'POSTING' : 'SAVING'
    this.redraw()
    this.host.snd.seek?.(2)

    this.save()
    const topics = parseTopicLine(this.draft.topics)
    if (this.draft.vent) topics.push('vent')
    try {
      if (kind === 'publish') {
        await this.host.api.post('/v1/posts', {
          content: this.draft.body,
          ...(this.draft.title.trim() && { title: this.draft.title.trim() }),
          topics,
          isNSFW: this.draft.nsfw,
          isPublic: this.draft.blog,
        })
      } else {
        await this.host.api.post('/v1/notes', { content: this.draft.body, topics })
      }
    } catch (err) {
      this.busy = false
      if (this.closed) return
      this.host.snd.beep(220, 0.12)
      this.status = (err as Error).message || 'failed; your writing is still here'
      this.redraw()
      return
    }

    this.busy = false
    if (this.closed) return
    this.wipe()
    this.host.snd.blip(660, 0.06, 0)
    if (kind === 'publish') { this.quit(true); return }
    this.status = 'saved to your journal'
    this.redraw()
  }

  private quit(published: boolean): void {
    if (this.closed) return
    if (this.body.text || this.title.value || this.topics.value) this.save()
    this.closed = true
    this.host.snd.blip(420, 0.09, 0)
    this.opts.done(published)
  }

  dispose(): void {
    this.closed = true
  }

  // --- drawing ----------------------------------------------------------------

  private redraw(): void {
    if (this.closed) return
    this.draw(this.host.s)
    this.host.paint()
  }

  draw(term: Grid): void {
    if (this.closed) return
    const r = this.outer

    clear(term, r)
    const i = frame(term, r)
    label(term, r, 'WRITE', { attr: BRIGHT | BOLD })
    if (this.host.username) label(term, r, `@${this.host.username}`, { align: 'right' })
    label(term, r, this.narrow ? HINT_NARROW : HINT, { edge: 'bottom', align: 'right' })

    this.drawLine(term, 'TITLE', this.titleRect, this.title, this.field === 'title')
    this.drawLine(term, 'TOPICS', this.topicsRect, this.topics, this.field === 'topics')

    // Across the frame's own columns, so box.ts merges the ends into tees.
    hline(term, i.y + 1, r.x, r.x + r.w - 1)
    hline(term, i.y + i.h - 3, r.x, r.x + r.w - 1)

    drawBuffer(term, this.body, this.bodyRect)
    this.drawFlags(term)
    this.drawStatus(term)

    // The flag row's selection is the inverse bar, so no caret there.
    if (this.field === 'flags' || this.busy) {
      term.showCursor = false
    } else {
      term.showCursor = true
      if (this.field === 'title') this.title.draw(term, this.titleRect)
      else if (this.field === 'topics') this.topics.draw(term, this.topicsRect)
    }
  }

  private drawLine(term: Grid, name: string, r: Rect, line: InputLine, focus: boolean): void {
    term.text(r.x - GUTTER - 1, r.y, name.padEnd(GUTTER), focus ? BRIGHT : DIM)
    line.draw(term, r)
  }

  /**
   * The topics as the feed will show them, cut to `room`. Each topic is cut to
   * its own share so one long topic cannot hide the ones after it; below four
   * columns each the line is cut as a line instead.
   */
  private tagsText(room: number): string {
    const tags = parseTopicLine(this.topics.value).map(t => `#${t}`)
    if (!tags.length || room < 3) return ''
    const full = tags.join(' ')
    if (full.length <= room) return full

    const gaps = tags.length - 1
    let left = room - gaps
    if (Math.floor(left / tags.length) < 4) return trim(full, room)

    // Shortest first, each handing what it did not need to the ones still waiting.
    const width: number[] = new Array(tags.length).fill(0)
    const order = tags.map((_, n) => n).sort((a, b) => tags[a]!.length - tags[b]!.length)
    let waiting = tags.length
    for (const n of order) {
      const w = Math.min(tags[n]!.length, Math.floor(left / waiting))
      width[n] = w
      left -= w
      waiting--
    }
    return tags.map((t, n) => trim(t, width[n]!)).join(' ')
  }

  /** The three flag caps on the left, the topics on the right. */
  private drawFlags(term: Grid): void {
    const r = this.flagRect
    const gap = this.narrow ? 1 : 3

    const caps = FLAGS.map(key => ` [${this.draft[key] ? 'X' : ' '}] ${key.toUpperCase()} `)
    const need = caps.reduce((n, text) => n + text.length, 0) + gap * (caps.length - 1)

    const tags = this.tagsText(r.w - need - 1)
    let limit = r.x + r.w
    if (tags) {
      const at = r.x + r.w - tags.length
      term.text(at, r.y, tags, DIM)
      limit = at - 1
    }

    let x = r.x
    caps.forEach((text, n) => {
      if (x + text.length > limit) return
      const on = this.field === 'flags' && this.flag === n
      // Inverted, the attribute is the background, so the selected cap stays DIM.
      if (on) term.text(x, r.y, text, DIM | BOLD, 1)
      else term.text(x, r.y, text, this.draft[FLAGS[n]!] ? NORMAL : DIM)
      x += text.length + gap
    })
  }

  private drawStatus(term: Grid): void {
    if (!this.status) return
    const r = this.outer
    label(term, r, ` ${this.status} `.slice(0, Math.max(0, r.w - 24)), {
      edge: 'bottom',
      attr: this.busy ? BRIGHT : NORMAL,
    })
  }
}
