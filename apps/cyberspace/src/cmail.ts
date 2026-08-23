// cmail: direct messages. Two screens, a mailbox and a thread.
//
// The mailbox is an index: mark, name, preview, and the clock anchored to the
// right margin, so a long preview is truncated rather than overwritten.
//
// A thread draws no nick column. The correspondent's name is in the title rule
// and does not change, and which side a message is drawn on identifies the
// sender, so the seventeen-column nick head is dropped entirely and the clock
// moves into each box's rule.
//
// One box per turn rather than per message: consecutive messages from the same
// sender are grouped, divided by a rule inside the box. The box marks the
// handover between senders.
//
// Two arrival clocks, as in circ: the backlog is revealed a line at a time and
// new messages type out at 2400 baud.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, InputLine, Reveal, drawLog, parseKeys,
  frame, hline, label, cells, plain,
  ConfirmPopup, PromptPopup, TextPopup, YES_NO,
  NORMAL, BRIGHT, BOLD, DIM,
  type LogLine, type Span, type Rect, type KeyInput, type Screen,
} from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { bodyOf, followList, hasStyle, type MsgBody } from './chatui.js'
import {
  BLIP_HZ, Blinker, SILENT, Typewriter, entryLines, entryParts, hhmm,
  printing, systemLines, type ChatMessage, type ChatPictureHost, type ChatSound,
  type Picture,
} from './chat.js'
import { helpLines, routeSlash, slashNames, type LocalCommand } from './slash.js'

interface Conversation {
  conversationId: string
  otherUser: { userId: string; username: string }
  lastMessage: string
  lastMessageAt: number
  unreadCount: number
}

interface Msg extends MsgBody {
  id: string
  senderUsername?: string
  timestamp?: number
  isAction?: boolean
  deleted?: boolean
}

const TITLE = 'C-MAIL'
/** The unread marker: `N ` or two blanks. */
const MARK_W = 2
const NAME_W = 16
/** Width of the right-margin clock: `12:34`, `Mon` or `05/09`. */
const TIME_W = 5
const GAP = 2
const MIN_PREVIEW = 18
const MAX_MSGS = 200
/** Width of a turn's box as a fraction of the pane. */
const DM_BODY = 2 / 3
/** Pitch of the tone played when a thread opens. circ uses the same for room changes. */
const OPEN_HZ = 420
/** A week in milliseconds: the threshold between showing a weekday and a date. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Commands this program handles itself; the server resolves the rest. */
const LOCAL: LocalCommand[] = [
  { name: 'quit', usage: '/quit', summary: 'leave C-Mail' },
]
/** Every dispatched name, aliases included. Tab and the help box show only LOCAL. */
const LOCAL_NAMES = ['quit', 'exit']
const SLASH = slashNames('dm', LOCAL)

const INDEX_HINT: Span[] = [
  { text: ' ↵ ', inverse: true, attr: DIM },
  { text: ' Read ' },
  { text: ' N ', inverse: true, attr: DIM },
  { text: ' Write ' },
  { text: ' ⬆⬇ ', inverse: true, attr: DIM },
  { text: ' Nav ' },
  { text: ' ESC ', inverse: true, attr: DIM },
  { text: ' Exit' },
]

const THREAD_HINT: Span[] = [
  { text: ' ^H ', inverse: true, attr: DIM },
  { text: ' Help ' },
  { text: ' ⬆⬇ ', inverse: true, attr: DIM },
  { text: ' Scroll ' },
  { text: ' ESC ', inverse: true, attr: DIM },
  { text: ' Mailbox' },
]

/** Bump when MailState changes. A mismatch discards the draft and nothing else. */
const STATE_VERSION = 1

/** State kept across a reload. Messages are refetched rather than stored. */
interface MailState { v: number; draft: string }

function readState(raw: unknown): MailState | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.v !== STATE_VERSION || typeof s.draft !== 'string') return null
  return { v: STATE_VERSION, draft: s.draft }
}

const INDEX_HELP = [
  'The mailbox lists everyone you have written to,',
  'or who has written to you. N marks a conversation',
  'with something in it you have not read.',
  '',
  '↵     open the conversation',
  'N     write to somebody new',
  '⬆ ⬇   move',
  'ESC   leave C-Mail',
  '',
  'Inside a conversation, /help lists what you can',
  'type there.',
]

/** Today is a clock, this week a weekday, older a date. */
function whenLabel(at: number): string {
  if (!at) return ''
  const then = new Date(at)
  const now = new Date()
  if (then.toDateString() === now.toDateString()) return hhmm(at)
  if (now.getTime() - at < WEEK_MS) return then.toDateString().slice(0, 3)
  return `${String(then.getDate()).padStart(2, '0')}/${String(then.getMonth() + 1).padStart(2, '0')}`
}

/** Wrap text to fit inside a turn box. */
function wrapBody(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) { line = word; continue }
      if (line.length + 1 + word.length <= width) { line += ' ' + word; continue }
      out.push(line)
      line = word
    }
    out.push(line)
  }
  return out
}

export function cmailProgram(
  api: ApiClient, rtdb: string, snd: ChatSound = SILENT, pictures?: ChatPictureHost,
): Program {
  const base = rtdb.replace(/\/$/, '')

  return async (p: Proc) => {
    if (!api.authed) {
      p.err('cmail: not logged in\n')
      return 1
    }
    if (!p.tty) {
      p.err('cmail: no tty\n')
      return 1
    }
    if (typeof EventSource === 'undefined') {
      p.err('cmail: no event stream support\n')
      return 1
    }

    const tty = p.tty
    const cols = tty.cols
    const rows = tty.rows
    const s = new Surface(cols, rows)
    const stack = new ScreenStack(s as never)
    const outer: Rect = { x: 0, y: 0, w: cols, h: rows }

    let running = true
    /** Which of the two screens is currently drawn. */
    let mode: 'index' | 'thread' = 'index'

    const paintNow = (): void => { tty.paint(s.render()) }
    const open = (screen: Screen): void => { stack.push(screen); paintNow() }
    const close = (redraw: () => void): void => { stack.pop(); s.invalidate(); redraw() }

    // --- the mailbox ---------------------------------------------------------

    const indexSplitY = rows - 2
    const listRect: Rect = { x: 2, y: 1, w: cols - 4, h: indexSplitY - 1 }

    let convs: Conversation[] = []
    let cursor = 0
    let loading = true
    let indexStatus = ''
    const reveal = new Reveal({ onTick: () => drawIndex(), onBlip: () => snd.blip(BLIP_HZ) })

    /** Width of the name column: the pane less the mark, clock and preview. */
    const nameWidth = (): number => {
      const spare = listRect.w - MARK_W - GAP - TIME_W - GAP - MIN_PREVIEW
      return Math.min(NAME_W, Math.max(8, spare))
    }

    function drawIndex(): void {
      if (!running || mode !== 'index' || stack.active) return
      s.clear()
      frame(s, outer)
      hline(s, indexSplitY, 0, cols - 1)

      // BOLD rather than BRIGHT|BOLD: full brightness is reserved for the
      // correspondent's name beside it.
      label(s, outer, TITLE, { align: 'right', attr: BOLD })
      label(s, outer, INDEX_HINT, { edge: 'bottom', align: 'right' })
      const unread = convs.filter(c => c.unreadCount > 0).length
      if (unread) label(s, outer, `UNREAD (${unread})`)

      if (loading) {
        s.text(listRect.x, listRect.y, 'Reading mailbox…', DIM)
      } else if (!convs.length) {
        s.text(listRect.x, listRect.y, 'No mail. Press N to write to somebody.', DIM)
      } else {
        const nameW = nameWidth()
        const shown = Math.min(convs.length, reveal.count)
        const first = Math.max(0, Math.min(cursor - (listRect.h >> 1),
                                           Math.max(0, convs.length - listRect.h)))
        for (let i = 0; i < listRect.h; i++) {
          const c = convs[first + i]
          if (!c || first + i >= shown) break
          const on = first + i === cursor
          const y = listRect.y + i
          const mark = (c.unreadCount > 0 ? 'N' : '').padEnd(MARK_W)
          const name = `@${c.otherUser.username}`.slice(0, nameW).padEnd(nameW)
          const preview = (c.lastMessage ?? '').replace(/\s+/g, ' ')
          const head = mark + name + ' '.repeat(GAP)
          const body = preview.slice(0, Math.max(0, listRect.w - head.length - TIME_W - GAP))
          // The bar is DIM: on an inverted row the attribute applies to the
          // background, and full brightness would be a bright patch mid-row.
          s.text(listRect.x, y, (head + body).padEnd(listRect.w), on ? DIM : NORMAL, on ? 1 : 0)
          if (c.unreadCount > 0) s.text(listRect.x, y, mark, BRIGHT, on ? 1 : 0)
          // The name is BRIGHT outside the bar and DIM|BOLD inside it, as in
          // select.ts.
          s.text(listRect.x + MARK_W, y, name, on ? DIM | BOLD : BRIGHT, on ? 1 : 0)
          const when = whenLabel(c.lastMessageAt).padStart(TIME_W)
          s.text(listRect.x + listRect.w - TIME_W, y, when, DIM, on ? 1 : 0)
        }
      }

      hline(s, indexSplitY, 1, cols - 2)
      if (indexStatus) {
        s.text(cols - 4 - cells(indexStatus), indexSplitY, ` ${indexStatus} `, BRIGHT)
      }

      // Nothing on this screen takes input, so the caret is hidden.
      s.showCursor = false
      paintNow()
    }

    const loadIndex = async (): Promise<void> => {
      // Anchor the selection to the conversation id, not the row index: the sort moves.
      const wasOn = convs[cursor]?.conversationId
      try {
        // Folded on arrival: a name or preview with wide characters would cost
        // every row after it a column. See plain.ts.
        convs = (await api.get<Conversation[]>('/v1/cmail')).map(c => ({
          ...c,
          otherUser: { ...c.otherUser, username: plain(c.otherUser.username) },
          lastMessage: plain(c.lastMessage ?? ''),
        }))
      } catch (e) {
        convs = []
        p.err(`cmail: ${e instanceof ApiError ? e.message : e}\n`)
      }
      const opening = loading
      loading = false
      if (wasOn) {
        const moved = convs.findIndex(c => c.conversationId === wasOn)
        if (moved >= 0) cursor = moved
      }
      cursor = Math.min(cursor, Math.max(0, convs.length - 1))
      // The list is revealed a line at a time, as a room's backlog is, and only once.
      if (opening) reveal.start(Math.min(convs.length, listRect.h))
      drawIndex()
    }

    // --- a thread ------------------------------------------------------------

    const threadSplitY = rows - 3
    const logRect: Rect = { x: 2, y: 1, w: cols - 4, h: threadSplitY - 1 }
    const inputRect: Rect = { x: 2, y: threadSplitY + 1, w: cols - 4, h: 1 }
    const input = new InputLine({ maxLength: 2048 })

    let convId = ''
    let threadOther = ''
    let msgs = new Map<string, Msg>()
    /** Lines generated locally, merged into the log by timestamp. */
    let system: { text: string; at: number }[] = []
    let scroll = 0
    let lastLines = 0
    let status = ''
    let primed = false
    let stopStream: (() => void) | null = null
    let readTimer: ReturnType<typeof setTimeout> | null = null

    const ordered = (): Msg[] =>
      [...msgs.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

    const asChat = (m: Msg): ChatMessage => ({
      id: m.id,
      username: m.senderUsername,
      timestamp: m.timestamp,
      // A picture the box is about to draw is not also named in the text.
      content: bodyOf(m, { image: Boolean(pics && m.imageUrl) }),
      action: m.isAction,
      deleted: m.deleted,
      blink: hasStyle(m.style, 'blink'),
      imageUrl: m.imageUrl,
    })

    // A message types out its body only; the clock is drawn in the box rule
    // beforehand. An action still counts its prefix.
    const dmText = (m: ChatMessage): string => {
      const { head, body } = entryParts(m)
      return m.action ? head + body : body
    }

    const wire = new Typewriter({
      text: dmText,
      onTick: () => drawThread(),
      onBlip: () => snd.blip(BLIP_HZ),
    })
    const print = new Reveal({ onTick: () => drawThread(), onBlip: () => snd.blip(BLIP_HZ) })
    const blink = new Blinker(() => drawThread())

    // The picture scope is taken here and released in the finally. A picture
    // loads long after the box holding it was drawn, so the thread repaints
    // when one arrives.
    const pics = pictures?.()
    const unwatchPics = pics?.onLoad(() => drawThread())

    const say = (text: string, complaint = false): void => {
      system.push({ text: plain(text), at: Date.now() })
      if (system.length > 40) system = system.slice(-40)
      if (complaint) snd.beep(220, 0.09)
      scroll = 0
      drawThread()
    }

    const boxW = (): number => Math.max(4, Math.round(logRect.w * DM_BODY))
    const dmInner = (): number => Math.max(1, boxW() - 4)

    /**
     * A picture is sized to the turn box rather than the pane, since it is drawn
     * inside the box and one fitted to the log would be clipped by the box edge.
     */
    const picture = (m: ChatMessage): Picture | undefined => {
      if (!pics || !m.imageUrl) return undefined
      return pics.get(m.imageUrl, dmInner(), Math.max(1, logRect.h))
    }

    /**
     * A box rule with the clock set into it, on the side the box is aligned to,
     * so timestamps run down the outer margin. Falls back to a plain rule when
     * the box is too narrow for a clock.
     */
    const dmRule = (kind: 'top' | 'mid' | 'bottom', at: number, mine: boolean): string => {
      const w = boxW()
      const [l, r] = kind === 'top' ? ['┌', '┐'] : kind === 'mid' ? ['├', '┤'] : ['└', '┘']
      if (kind === 'bottom') return l + '─'.repeat(w - 2) + r
      const clock = ` ${hhmm(at)} `
      const fill = w - 2 - cells(clock) - 1
      if (fill < 1) return l + '─'.repeat(w - 2) + r
      return mine
        ? l + '─'.repeat(fill) + clock + '─' + r
        : l + '─' + clock + '─'.repeat(fill) + r
    }

    /** One entry of a turn: the message and how much of it has been revealed. */
    interface Entry { m: ChatMessage; reveal: number }

    /**
     * The log grouped into turns: consecutive messages from the same side share
     * one box. Anything that is not a message from one side closes the current
     * box, since a box cannot enclose a gap.
     */
    const threadLines = (): LogLine[] => {
      const out: LogLine[] = []
      const w = boxW()
      const inner = dmInner()
      const me = (api.username ?? '').toLowerCase()
      let turn: Entry[] = []
      let mine = false

      const flush = (): void => {
        if (!turn.length) return
        const offset = mine ? logRect.w - w : 0
        const pad = ' '.repeat(offset)
        turn.forEach((e, i) => {
          out.push({
            text: pad + dmRule(i === 0 ? 'top' : 'mid', e.m.timestamp ?? 0, mine),
            attr: DIM,
          })
          // Blink blanks the text; the box keeps its shape and row count.
          const blank = e.m.blink && !blink.on
          const body = (e.m.content ?? '').slice(0, e.reveal === Infinity ? undefined : e.reveal)
          const edges = [
            { at: offset, len: 2, attr: DIM },
            { at: offset + w - 2, len: 2, attr: DIM },
          ]
          for (const line of wrapBody(body, inner)) {
            out.push({
              text: pad + '│ ' + (blank ? '' : line).padEnd(inner) + ' │',
              attr: e.m.deleted ? DIM : NORMAL,
              spans: edges,
            })
          }
          // The picture is drawn inside the turn, below the text. DIM rather than
          // NORMAL: it matches both the exposure the rasteriser used and the
          // attribute of the box edges.
          const pic = e.reveal === Infinity ? picture(e.m) : undefined
          for (const line of pic?.lines ?? []) {
            out.push({
              text: pad + '│ ' + line.padEnd(inner) + ' │',
              attr: DIM,
              spans: edges,
            })
          }
        })
        out.push({ text: pad + dmRule('bottom', 0, mine), attr: DIM })
        turn = []
      }

      type Item =
        | { at: number; m: ChatMessage; reveal: number; s?: undefined }
        | { at: number; s: string; m?: undefined }
      const items: Item[] = [
        ...wire.displayed.map(m => ({ at: m.timestamp ?? 0, m, reveal: Infinity })),
        ...system.map(n => ({ at: n.at, s: n.text })),
      ]
      items.sort((a, b) => a.at - b.at)
      // The message still typing is always last, regardless of its timestamp.
      const head = wire.head
      if (head) items.push({ at: head.timestamp ?? 0, m: head, reveal: wire.typed })

      for (const it of items) {
        if (it.m === undefined) {
          flush()
          out.push(...systemLines(it.s, logRect.w, 2))
          continue
        }
        // An action has no side; it is drawn alone from the margin.
        if (it.m.action) {
          flush()
          out.push(...entryLines(it.m, logRect.w, { reveal: it.reveal, blinkOn: blink.on }))
          continue
        }
        const isMine = (it.m.username ?? '').toLowerCase() === me
        if (turn.length && isMine !== mine) flush()
        mine = isMine
        turn.push({ m: it.m, reveal: it.reveal })
      }
      flush()
      return out
    }

    function drawThread(): void {
      if (!running) return
      // Stored here because every consumed key repaints. A field assignment
      // rather than a serialise.
      p.setState({ v: STATE_VERSION, draft: input.value })
      if (mode !== 'thread' || stack.active) return
      blink.sync(wire.blinking)
      s.clear()
      frame(s, outer)
      hline(s, threadSplitY, 0, cols - 1)

      // Budgeted against the program name at the other end of the rule, which a
      // long correspondent name would otherwise overwrite along with the corner.
      label(s, outer, `@${threadOther}`, {
        attr: BRIGHT | BOLD,
        max: cols - 4 - (cells(TITLE) + 2),
      })
      label(s, outer, TITLE, { align: 'right', attr: BOLD })
      label(s, outer, THREAD_HINT, { edge: 'bottom', align: 'right' })

      // Compensated so an arriving message does not move a scrolled-back view.
      const lines = threadLines()
      if (scroll > 0 && lines.length > lastLines) scroll += lines.length - lastLines
      lastLines = lines.length
      scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - logRect.h)))
      drawLog(s, logRect, printing(lines, logRect.h, print.count), scroll)

      hline(s, threadSplitY, 1, cols - 2)
      if (status) s.text(cols - 4 - cells(status), threadSplitY, ` ${status} `, BRIGHT)

      input.draw(s, inputRect)
      s.showCursor = true
      paintNow()
    }

    const markRead = (): void => {
      if (readTimer || !convId) return
      readTimer = setTimeout(() => { readTimer = null }, 2000)
      void api.post(`/v1/cmail/${convId}/read`, {}).catch(() => {})
    }

    const feed = (): void => {
      const list = ordered().map(asChat)
      if (!primed) {
        primed = true
        wire.prime(list)
        // The opening screenful is revealed a line at a time, oldest first.
        print.start(Math.min(threadLines().length, logRect.h))
        drawThread()
        return
      }
      const fresh = wire.receive(list)
      if (fresh.length) {
        // No mention tone here: every message in a thread is addressed to the reader.
        snd.blip(900)
        wire.enqueue(fresh)
      }
      drawThread()
    }

    /** Resolve a name and open its conversation. Returns false if no such member. */
    const openThread = async (who: string): Promise<boolean> => {
      try {
        const r = await api.post<{ conversationId: string; otherUser: { username: string } }>(
          '/v1/cmail', { recipientUsername: who })
        convId = r.conversationId
        threadOther = plain(r.otherUser.username)
      } catch {
        return false
      }

      snd.blip(OPEN_HZ, 0.120, 0)
      msgs = new Map()
      system = []
      scroll = 0
      lastLines = 0
      status = ''
      primed = false
      input.clear()
      mode = 'thread'
      // A reload returns to the thread rather than the mailbox.
      p.setResume(`cmail @${threadOther}`)
      s.invalidate()
      drawThread()

      stopStream = followList(
        api,
        token => `${base}/dm_messages/${encodeURIComponent(convId)}.json` +
          `?orderBy=%22timestamp%22&limitToLast=100&auth=${encodeURIComponent(token)}`,
        (id, data, snapshot) => {
          if (id === null) {
            if (snapshot) msgs.clear()
            for (const [k, raw] of Object.entries(data ?? {})) {
              if (raw === null) msgs.delete(k)
              else msgs.set(k, { ...(msgs.get(k) ?? {}), ...(raw as Partial<Msg>), id: k })
            }
          } else if (data === null) {
            msgs.delete(id)
          } else {
            msgs.set(id, { ...(msgs.get(id) ?? {}), ...(data as Partial<Msg>), id })
          }
          while (msgs.size > MAX_MSGS) {
            const oldest = ordered()[0]
            if (!oldest) break
            msgs.delete(oldest.id)
          }
          markRead()
          feed()
        })
      markRead()
      return true
    }

    const leaveThread = (): void => {
      stopStream?.()
      stopStream = null
      if (readTimer) { clearTimeout(readTimer); readTimer = null }
      markRead()
      wire.reset()
      print.stop()
      blink.stop()
      convId = ''
    }

    const send = async (text: string): Promise<void> => {
      status = 'sending'
      scroll = 0
      drawThread()
      try {
        const r = await api.post<{ reply?: string }>(`/v1/cmail/${convId}`, { content: text })
        status = ''
        if (r?.reply) for (const line of r.reply.split('\n')) say(line)
      } catch (e) {
        status = 'send failed'
        snd.beep(220, 0.14)
        say(e instanceof ApiError ? e.message : 'send failed')
      }
      drawThread()
    }

    /** Tab on a /word: complete it, or list the possibilities. */
    const completeSlash = (): void => {
      const value = input.value
      if (!value.startsWith('/') || /\s/.test(value)) { snd.beep(220, 0.05); return }
      const fragment = value.slice(1).toLowerCase()
      const matches = SLASH.filter(n => n.startsWith(fragment)).sort()
      if (!matches.length) { snd.beep(220, 0.05); return }
      if (matches.length === 1) {
        input.set(`/${matches[0]} `)
      } else {
        let common = matches[0]
        for (const m of matches) {
          while (!m.startsWith(common)) common = common.slice(0, -1)
        }
        if (common.length > fragment.length) input.set(`/${common}`)
        else say(matches.map(m => `/${m}`).join('  '))
      }
      drawThread()
    }

    // --- keys ----------------------------------------------------------------

    const openThreadHelp = (): void => {
      open(new TextPopup({
        title: 'COMMANDS', lines: helpLines('dm', LOCAL),
        onDone: () => close(drawThread), shadow: true,
      }))
    }

    const askExit = (redraw: () => void): void => {
      open(new ConfirmPopup({
        title: 'EXIT',
        lines: ['Quit C-Mail?'],
        hint: YES_NO,
        onDone: (yes) => { close(redraw); if (yes) running = false },
        shadow: true,
      }))
    }

    /** Resolve a name from the compose box, reporting progress in the status rule. */
    const write = async (who: string): Promise<void> => {
      indexStatus = 'looking up…'
      drawIndex()
      const ok = await openThread(who)
      if (!running) return
      if (!ok) {
        // One message covers both "no such member" and "cannot be written to".
        indexStatus = `no such member: @${who}`
        snd.beep(220, 0.12)
        drawIndex()
        return
      }
      indexStatus = ''
    }

    const compose = (): void => {
      open(new PromptPopup({
        title: 'WRITE TO',
        prefix: '@',
        hint: [
          { text: ' ↵ ', inverse: true, attr: DIM },
          { text: ' Open ' },
          { text: ' ESC ', inverse: true, attr: DIM },
          { text: ' Cancel' },
        ],
        bounds: outer,
        suggest: value => api.searchUsers(value.replace(/^@/, '')).catch(() => []),
        onFeedback: (kind) => {
          if (kind === 'edge') snd.beep(220, 0.04)
          else if (kind === 'move') snd.tick()
          else if (kind === 'cancel') snd.blip(420, 0.09, 0)
        },
        onDone: (value) => {
          close(drawIndex)
          const who = (value ?? '').replace(/^@/, '').trim()
          if (who) void write(who)
        },
        shadow: true,
      }))
    }

    const openIndexHelp = (): void => {
      open(new TextPopup({
        title: TITLE, lines: INDEX_HELP, onDone: () => close(drawIndex), shadow: true,
      }))
    }

    const indexKey = (k: KeyInput): void => {
      // Any key finishes the reveal and then acts as it normally would.
      reveal.finish()
      if (k.key === 'Escape' || (k.ctrlKey && k.key === 'c')) { askExit(drawIndex); return }
      if (k.ctrlKey && k.key === 'h') { openIndexHelp(); return }
      if (k.key === 'n' || k.key === 'N') { compose(); return }
      const move = (to: number): void => {
        const next = Math.max(0, Math.min(Math.max(0, convs.length - 1), to))
        if (next === cursor) snd.beep(220, 0.04)
        else {
          cursor = next
          // Moving the selection clears the previous error.
          indexStatus = ''
          snd.tick()
        }
        drawIndex()
      }
      if (k.key === 'ArrowUp') { move(cursor - 1); return }
      if (k.key === 'ArrowDown') { move(cursor + 1); return }
      if (k.key === 'Enter') {
        const c = convs[cursor]
        if (c) void openThread(c.otherUser.username)
        else snd.beep(220, 0.04)
      }
    }

    const backToIndex = (): void => {
      leaveThread()
      mode = 'index'
      p.setResume('cmail')
      p.setState(null)
      s.invalidate()
      void loadIndex()
    }

    const threadKey = (k: KeyInput): void => {
      // Checked first: the scroll keys measure against the whole log.
      print.finish()
      // Ctrl-C asks for confirmation; Escape goes back one level without asking.
      if (k.ctrlKey && k.key === 'c') { askExit(drawThread); return }
      if (k.key === 'Escape') { backToIndex(); return }
      if (k.ctrlKey && k.key === 'h') { openThreadHelp(); return }
      if (k.key === 'Enter') {
        const text = input.value.trim()
        input.clear()
        if (!text) { drawThread(); return }
        const route = routeSlash(text, 'dm', LOCAL_NAMES)
        if (route && 'unknown' in route) {
          say(`Unknown command: ${route.unknown} (try /help)`, true)
          drawThread()
          return
        }
        if (route && 'help' in route) { openThreadHelp(); return }
        // The only local commands are /quit and /exit.
        if (route && 'local' in route) { running = false; return }
        void send(text)
        drawThread()
        return
      }
      if (k.key === 'Tab') { completeSlash(); return }
      const page = Math.max(1, logRect.h - 2)
      const maxScroll = Math.max(0, lastLines - logRect.h)
      const move = (to: number): void => {
        const next = Math.max(0, Math.min(maxScroll, to))
        if (next === scroll) snd.beep(220, 0.04)
        else { scroll = next; snd.tick() }
        drawThread()
      }
      if (k.key === 'ArrowUp') { move(scroll + 1); return }
      if (k.key === 'ArrowDown') { move(scroll - 1); return }
      if (k.key === 'PageUp') { move(scroll + page); return }
      if (k.key === 'PageDown') { move(scroll - page); return }
      if (input.onKey(k)) drawThread()
    }

    // --- run -----------------------------------------------------------------

    tty.setRaw()
    // These play their own tick, so the host suppresses the key click.
    tty.silence(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])
    p.out('\x1b[?1049h')
    s.invalidate()

    try {
      const parked = readState(p.takeState())
      p.setResume('cmail')

      const wanted = p.argv[1]?.replace(/^@/, '')
      // A name that fails to resolve still opens the mailbox, with the error shown.
      if (!wanted || !await openThread(wanted)) {
        if (wanted) {
          indexStatus = `no such member: @${wanted}`
          snd.beep(220, 0.12)
        }
        drawIndex()
        await loadIndex()
      } else if (parked?.draft) {
        input.set(parked.draft)
        drawThread()
      }

      while (running) {
        const chunk = await p.stdin.read()
        if (chunk === null) break
        for (const k of parseKeys(dec.decode(chunk))) {
          if (stack.active) { stack.key(k); paintNow(); continue }
          if (mode === 'index') indexKey(k)
          else threadKey(k)
          if (!running) break
        }
      }
      return 0
    } finally {
      running = false
      reveal.stop()
      wire.close()
      unwatchPics?.()
      pics?.release()
      leaveThread()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
