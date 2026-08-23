// cmail — C-Mail, as the machine at /terminal draws it.
//
// Two screens. The mailbox is an INDEX — mark, name, preview, and the clock
// anchored to the far side rather than sitting in the head, so the preview is
// cut short of it instead of having its last words silently overwritten.
//
// **A thread is two-sided, and draws no name at all.** Theirs is in the title
// rule and never changes; ours would be the machine telling us who we are on
// every line we wrote. Which SIDE a message is on carries the fact instead, so
// the seventeen-column nick head disappears rather than shrinking, and the
// clock goes into the box's own rule.
//
// **A box per TURN, not per message.** Somebody saying three things in a row is
// one turn, and three boxes for it would be a stack of chrome around one
// thought. Inside a single box the messages are divided by a rule in a
// container the reader already has; what the box marks is the handover.
//
// Arrival is two clocks, as in circ: the backlog prints by the line, new
// messages type at 2400 baud.

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
  printing, systemLines, type ChatMessage, type ChatSound,
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
/** `N ` or two blanks. */
const MARK_W = 2
const NAME_W = 16
/** The clock down the right margin: `12:34`, `Mon`, `05/09`. */
const TIME_W = 5
const GAP = 2
const MIN_PREVIEW = 18
const MAX_MSGS = 200
/** A turn's box, as a share of the pane. It is the container that moves. */
const DM_BODY = 2 / 3
/** Pitch of the boop opening a thread makes — circ retunes rooms with it too. */
const OPEN_HZ = 420
/** A week, in milliseconds — the line between a weekday and a date. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** The commands this program answers itself; the server resolves the rest. */
const LOCAL: LocalCommand[] = [
  { name: 'quit', usage: '/quit', summary: 'leave C-Mail' },
]
/** As dispatched, aliases included. Tab and the help box show only LOCAL. */
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

/** Break text to fit inside a box. */
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

export function cmailProgram(api: ApiClient, rtdb: string, snd: ChatSound = SILENT): Program {
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
    /** Which screen owns the grid. */
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

    /** Name column: what is left once the mark, clock and a preview are paid for. */
    const nameWidth = (): number => {
      const spare = listRect.w - MARK_W - GAP - TIME_W - GAP - MIN_PREVIEW
      return Math.min(NAME_W, Math.max(8, spare))
    }

    function drawIndex(): void {
      if (!running || mode !== 'index' || stack.active) return
      s.clear()
      frame(s, outer)
      hline(s, indexSplitY, 0, cols - 1)

      // BOLD and not BRIGHT|BOLD: the program's name is the one label true
      // wherever you are in it, so it wants weight rather than beam — the full
      // beam is spent on the correspondent beside it.
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
          // The bar is DIM: inverted, the attribute is the FIELD, and full beam
          // there would be a blazing patch in the middle of the row.
          s.text(listRect.x, y, (head + body).padEnd(listRect.w), on ? DIM : NORMAL, on ? 1 : 0)
          if (c.unreadCount > 0) s.text(listRect.x, y, mark, BRIGHT, on ? 1 : 0)
          // The name rides at BRIGHT out of the bar and drops to DIM|BOLD in
          // it — the same trade select.ts makes.
          s.text(listRect.x + MARK_W, y, name, on ? DIM | BOLD : BRIGHT, on ? 1 : 0)
          const when = whenLabel(c.lastMessageAt).padStart(TIME_W)
          s.text(listRect.x + listRect.w - TIME_W, y, when, DIM, on ? 1 : 0)
        }
      }

      hline(s, indexSplitY, 1, cols - 2)
      if (indexStatus) {
        s.text(cols - 4 - cells(indexStatus), indexSplitY, ` ${indexStatus} `, BRIGHT)
      }

      // Nothing here is typed into, so the caret has nowhere to be.
      s.showCursor = false
      paintNow()
    }

    const loadIndex = async (): Promise<void> => {
      // Hold the selection on the conversation, not the row: the sort moves.
      const wasOn = convs[cursor]?.conversationId
      try {
        // Folded on arrival: a name or a preview the grid cannot hold one cell
        // to the character costs every row after it a column. See plain.ts.
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
      // The list prints a line at a time, as a room's backlog does — once.
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
    /** Local-only lines, merged into the log by time. */
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
      content: bodyOf(m),
      action: m.isAction,
      deleted: m.deleted,
      blink: hasStyle(m.style, 'blink'),
    })

    // Speech types body only: the clock lives in a rule drawn up front.
    // An action still counts its head.
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
     * A rule with the clock set into it, on the side the box is against — so
     * times run down the outer margin of the conversation rather than through
     * it. Too narrow for a clock and it is a plain rule instead.
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

    /** One entry of a turn: the message, and how much has come off the wire. */
    interface Entry { m: ChatMessage; reveal: number }

    /**
     * The log, grouped rather than mapped: consecutive messages from the same
     * side are one turn. Anything that is not one side speaking closes the box
     * it lands in — a container drawn around a run of rows cannot have a hole.
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
          // Blink blanks the words; the box keeps its shape and line count.
          const blank = e.m.blink && !blink.on
          const body = (e.m.content ?? '').slice(0, e.reveal === Infinity ? undefined : e.reveal)
          for (const line of wrapBody(body, inner)) {
            out.push({
              text: pad + '│ ' + (blank ? '' : line).padEnd(inner) + ' │',
              attr: e.m.deleted ? DIM : NORMAL,
              spans: [
                { at: offset, len: 2, attr: DIM },
                { at: offset + w - 2, len: 2, attr: DIM },
              ],
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
      // The one still typing goes last whatever its clock says.
      const head = wire.head
      if (head) items.push({ at: head.timestamp ?? 0, m: head, reveal: wire.typed })

      for (const it of items) {
        if (it.m === undefined) {
          flush()
          out.push(...systemLines(it.s, logRect.w, 2))
          continue
        }
        // An action has no side: it stands alone, from the margin.
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
      if (!running || mode !== 'thread' || stack.active) return
      blink.sync(wire.blinking)
      s.clear()
      frame(s, outer)
      hline(s, threadSplitY, 0, cols - 1)

      // Budgeted against the program's own name at the other end of the rule:
      // a long correspondent would otherwise write over it and the corner.
      label(s, outer, `@${threadOther}`, {
        attr: BRIGHT | BOLD,
        max: cols - 4 - (cells(TITLE) + 2),
      })
      label(s, outer, TITLE, { align: 'right', attr: BOLD })
      label(s, outer, THREAD_HINT, { edge: 'bottom', align: 'right' })

      // Arrivals must not drag a scrolled-back view along.
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
        // The opening screenful prints by the line, oldest first.
        print.start(Math.min(threadLines().length, logRect.h))
        drawThread()
        return
      }
      const fresh = wire.receive(list)
      if (fresh.length) {
        // No mention chirp here: every line is addressed to you.
        snd.blip(900)
        wire.enqueue(fresh)
      }
      drawThread()
    }

    /** Resolve a name and open its conversation. False means no such member. */
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

    /** Tab on a `/word`: finish it, or say what it could have been. */
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

    /** Resolve a name from the compose box and narrate the attempt. */
    const write = async (who: string): Promise<void> => {
      indexStatus = 'looking up…'
      drawIndex()
      const ok = await openThread(who)
      if (!running) return
      if (!ok) {
        // One answer for "no such member" and "not somebody you can write to".
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
      // Any key ends the print, then means what it always means.
      reveal.finish()
      if (k.key === 'Escape' || (k.ctrlKey && k.key === 'c')) { askExit(drawIndex); return }
      if (k.ctrlKey && k.key === 'h') { openIndexHelp(); return }
      if (k.key === 'n' || k.key === 'N') { compose(); return }
      const move = (to: number): void => {
        const next = Math.max(0, Math.min(Math.max(0, convs.length - 1), to))
        if (next === cursor) snd.beep(220, 0.04)
        else {
          cursor = next
          // Moving on clears the last complaint.
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
      s.invalidate()
      void loadIndex()
    }

    const threadKey = (k: KeyInput): void => {
      // First: the scroll keys measure against the whole log.
      print.finish()
      // Ctrl-C asks; Escape goes back one level and does not.
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
        // The only locals are /quit and /exit.
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
    // These answer with a tick of their own; the host must not clack over it.
    tty.silence(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])
    p.out('\x1b[?1049h')
    s.invalidate()

    try {
      const wanted = p.argv[1]?.replace(/^@/, '')
      // A name that fails still lands in the mailbox, with the complaint.
      if (!wanted || !await openThread(wanted)) {
        if (wanted) {
          indexStatus = `no such member: @${wanted}`
          snd.beep(220, 0.12)
        }
        drawIndex()
        await loadIndex()
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
      leaveThread()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
