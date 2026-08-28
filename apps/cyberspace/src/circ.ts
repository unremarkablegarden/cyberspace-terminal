// circ: the chat room screen. A framed log under a titled rule, the online pane
// beside it, a status rule, and the key legend across the foot.
//
// Room state and sends go through the API. Live messages arrive on an RTDB REST
// stream (EventSource, same idToken). Slash commands resolve server-side except
// /rooms, /who, /quit and /help; an unknown verb is refused here, because the
// server would post it as prose. Rooms are changed through the picker, opened
// with ^J or /rooms; there is no /join.
//
// Two arrival clocks, never running together. The opening screenful is revealed
// a line at a time (Reveal, 45 lines a second), since typing a backlog at 2400
// baud would take minutes. Messages arriving afterwards type out at 2400 baud.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, InputLine, Reveal, drawLog, drawList, parseKeys,
  frame, hline, vline, label, cells, clear, ground, plain,
  ConfirmPopup, SelectPopup, TextPopup, YES_NO,
  NORMAL, BRIGHT, BOLD, DIM,
  type LogLine, type Span, type Rect, type KeyInput, type Screen,
} from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { artLines, bodyOf, followList, hasStyle, type MsgBody } from './chatui.js'
import {
  ARROWS, ASLEEP, BLIP_HZ, Blinker, HEAD_W, SILENT, Typewriter, entryLines, entryParts,
  mentions, narrowLines, nick, printing, systemLines, type ChatMessage,
  type ChatPictureHost, type ChatSound, type ChatUser, type Picture,
} from './chat.js'
import { helpLines, routeSlash, slashNames, type LocalCommand } from './slash.js'

interface Room {
  id: string
  slug: string
  name: string
  onlineCount: number
  lastMessageAt?: number
}

interface RoomUser {
  username: string
  isChatAdmin: boolean
  lastActivity: number | null
}

interface Msg extends MsgBody {
  id: string
  username?: string
  timestamp?: number
  isAction?: boolean
  isSystem?: boolean
  deleted?: boolean
}

/** Width of the online pane, including its two border columns. */
const SIDEBAR_W = 16
/** Below this width the pane and gutter leave too few columns for the text. */
const NARROW = 60
const MAX_MSGS = 200
const IDLE_MS = 5 * 60_000
/** Maximum names offered in the completion box at once. */
const SUGGEST_MAX = 6
/** Debounce in ms before the name index is queried. */
const SUGGEST_MS = 250
/** Minimum fragment length before the index is worth querying. */
const SUGGEST_MIN = 2
/** Matches an @ at the end of the input line, capturing the fragment after it. */
const MENTION_RE = /(?:^|\s)@(\w*)$/
/** Pitch of the tone played on a room change. */
const ROOM_HZ = 420
/** Marker shown against a room with unread messages. */
const UNREAD = '+'
/** Blank columns between the longest room name and the member count. */
const GAP = 2

/** Commands this program handles itself; the server resolves the rest. */
const LOCAL: LocalCommand[] = [
  { name: 'rooms', usage: '/rooms', summary: 'list them' },
  { name: 'who', usage: '/who', summary: 'who is here' },
  { name: 'quit', usage: '/quit', summary: 'leave cIRC' },
]
/** Every dispatched name, aliases included. Tab and the help box show only LOCAL. */
const LOCAL_NAMES = ['rooms', 'who', 'quit', 'exit']
const SLASH = slashNames('chat', LOCAL)

/**
 * The key legend, drawn as inverse keycaps. Modal hints use plain text instead,
 * so a second row of caps does not compete with this one.
 */
const HINT: Span[] = [
  { text: ' ^H ', inverse: true, attr: DIM },
  { text: ' Help ' },
  { text: ' ^J ', inverse: true, attr: DIM },
  { text: ' Rooms ' },
  { text: ` ${ARROWS} `, inverse: true, attr: DIM },
  { text: ' Scroll ' },
  { text: ' ESC ', inverse: true, attr: DIM },
  { text: ' Exit' },
]

/** The legend for a narrow room, where there is no pane and Who joins the row. */
const HINT_NARROW: Span[] = [
  { text: ' ^H ', inverse: true, attr: DIM },
  { text: ' Help ' },
  { text: ' ^J ', inverse: true, attr: DIM },
  { text: ' Rooms ' },
  { text: ' ^U ', inverse: true, attr: DIM },
  { text: ' Who ' },
  { text: ' ESC ', inverse: true, attr: DIM },
]

const HELP = helpLines('chat', LOCAL)

/** Bump when ChatState changes. A mismatch discards the draft and nothing else. */
const STATE_VERSION = 1

/** State kept across a reload. Messages are refetched rather than stored. */
interface ChatState { v: number; draft: string }

function readState(raw: unknown): ChatState | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.v !== STATE_VERSION || typeof s.draft !== 'string') return null
  return { v: STATE_VERSION, draft: s.draft }
}

export function circProgram(
  api: ApiClient, rtdb: string, snd: ChatSound = SILENT, pictures?: ChatPictureHost,
): Program {
  const base = rtdb.replace(/\/$/, '')

  return async (p: Proc) => {
    if (!p.tty) {
      p.err('circ: no tty\n')
      return 1
    }
    if (!api.authed) {
      p.err('circ: not logged in\n')
      return 1
    }
    if (typeof EventSource === 'undefined') {
      p.err('circ: no event stream support\n')
      return 1
    }

    const tty = p.tty
    const cols = tty.cols
    const rows = tty.rows
    const narrow = cols < NARROW
    const me = (api.username ?? '').toLowerCase()

    const s = new Surface(cols, rows)
    const stack = new ScreenStack(s as never)
    const input = new InputLine({ maxLength: 2048 })

    // Rects are derived from cols/rows; a literal column count breaks on the
    // other screen size.
    const outer: Rect = { x: 0, y: 0, w: cols, h: rows }
    const splitX = cols - SIDEBAR_W
    const splitY = rows - 3
    const logRect: Rect = { x: 2, y: 1, w: narrow ? cols - 4 : splitX - 3, h: splitY - 1 }
    const sidebarRect: Rect = { x: splitX + 2, y: 1, w: SIDEBAR_W - 3, h: splitY - 1 }
    const inputRect: Rect = { x: 2, y: splitY + 1, w: cols - 4, h: 1 }

    let room: Room | null = null
    let rooms: Room[] = []
    const msgs = new Map<string, Msg>()
    let users: ChatUser[] = []
    /** Lines generated locally, merged into the log by timestamp. */
    let system: { text: string; at: number }[] = []
    let scroll = 0
    let lastLines = 0
    let status = ''
    let heartbeatMs = 30000
    let lastActivity = Date.now()
    let running = true
    let primed = false
    let switching = false
    /** Whether this room's roster has been revealed. Only the first one is. */
    let rostered = false

    let stopStream: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null

    /** The @-fragment being typed, the index's reply, and the cycle position. */
    let suggest: { frag: string; remote: string[]; index: number } | null = null
    let suggestTimer: ReturnType<typeof setTimeout> | null = null
    let suggestReq = 0

    const ordered = (): Msg[] =>
      [...msgs.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

    /**
     * The block an attachment is drawn in: as wide as the message column, so a
     * picture starts where the text does rather than being indented twice, and
     * as tall as the host's slot, so every attachment holds the same rows
     * whether or not its pixels have arrived.
     */
    const picBounds = (): { cols: number; rows: number } => {
      const cols = Math.max(1, narrow ? logRect.w : logRect.w - HEAD_W)
      const room = Math.max(1, logRect.h)
      return { cols, rows: pics ? pics.slot(cols, room) : room }
    }

    /** The halftoned picture for a message, if it is rasterised. Never a fetch. */
    const picture = (m: ChatMessage): Picture | undefined => {
      if (!pics || !m.imageUrl) return undefined
      const { cols, rows } = picBounds()
      return pics.picture(m.imageUrl, cols, rows)
    }

    /** Whether the screen expects to draw this attachment rather than name it. */
    const drawsPicture = (src?: string): boolean => Boolean(pics && src && !pics.failed(src))

    /** Where one message's picture rows sit in the log, as a half-open range. */
    interface PicSpan { src: string; from: number; to: number }

    /** One message in the form the line builders expect. */
    const asChat = (m: Msg): ChatMessage => ({
      id: m.id,
      username: m.username,
      timestamp: m.timestamp,
      // A picture the screen is about to draw is not also named in the text.
      content: bodyOf(m, { image: drawsPicture(m.imageUrl), art: true }),
      action: m.isAction,
      system: m.isSystem,
      deleted: m.deleted,
      blink: hasStyle(m.style, 'blink'),
      imageUrl: m.imageUrl,
      art: artLines(m),
    })

    const wire = new Typewriter({
      text: m => { const { head, body } = entryParts(m); return head + body },
      onTick: () => paint(),
      onBlip: () => snd.blip(BLIP_HZ),
    })

    // One bleep per batch of revealed lines, matching the shell's type-out.
    const print = new Reveal({ onTick: () => paint(), onBlip: () => snd.blip(BLIP_HZ) })

    // The roster reveals a name at a time, like the backlog. Silent while the
    // log is still revealing, since the two run together on entry and two
    // chattering clocks read as a fault.
    const roll = new Reveal({
      onTick: () => paint(),
      onBlip: () => { if (!print.running) snd.blip(BLIP_HZ) },
    })

    const blink = new Blinker(() => paint())

    // The picture scope is taken here and released in the finally. A picture
    // loads long after the line carrying it was drawn, so the screen repaints
    // when one arrives.
    const pics = pictures?.()
    const unwatchPics = pics?.onLoad(() => paint())

    // Server replies (/fortune, /8ball and the rest) arrive here, so they are
    // folded like a message body.
    const say = (text: string, complaint = false): void => {
      system.push({ text: plain(text), at: Date.now() })
      if (system.length > 40) system = system.slice(-40)
      if (complaint) snd.beep(220, 0.09)
      paint()
    }

    // Never the reader's own lines: /me and /8ball carry the author's name in the text.
    const namesMe = (m: ChatMessage, text: string): boolean =>
      (m.username ?? '').toLowerCase() !== me && mentions(text, me)

    const lineOf = (m: ChatMessage, reveal?: number): LogLine[] => {
      const opts = {
        reveal,
        namesMe: (said: string) => namesMe(m, said),
        blinkOn: blink.on,
        picture: picture(m),
        picRows: drawsPicture(m.imageUrl) ? picBounds().rows : 0,
      }
      return narrow ? narrowLines(m, logRect.w, opts) : entryLines(m, logRect.w, opts)
    }

    const logLines = (spans?: PicSpan[]): LogLine[] => {
      // Local lines are interleaved with the room's by timestamp.
      const entries: { at: number; src?: string; lines: () => LogLine[] }[] = [
        ...wire.displayed.map(m => ({ at: m.timestamp ?? 0, src: m.imageUrl, lines: () => lineOf(m) })),
        ...system.map(s => ({
          at: s.at,
          lines: () => systemLines(s.text, logRect.w, narrow ? 0 : undefined),
        })),
      ]
      entries.sort((a, b) => a.at - b.at)
      const out: LogLine[] = []
      const place = (src: string | undefined, from: number): void => {
        if (spans && src) spans.push({ src, from, to: out.length })
      }
      for (const e of entries) {
        const from = out.length
        out.push(...e.lines())
        place(e.src, from)
      }
      // Then the message still typing, as far as it has been revealed.
      const head = wire.head
      if (head) {
        const from = out.length
        out.push(...lineOf(head, wire.typed))
        place(head.imageUrl, from)
      }
      return out
    }

    /**
     * The room's roster in display order: idle members last, then operators
     * first, then alphabetical within each group.
     *
     * Idle sorts ahead of operator status, so an operator who left a window
     * open does not appear among the members actually present.
     */
    const roster = (rows: RoomUser[]): ChatUser[] => {
      const now = Date.now()
      return rows
        .map((r): ChatUser => ({
          // Folded once here rather than at each use: the pane, the Who box,
          // the mention index and /who all read this list.
          username: plain(r.username),
          op: r.isChatAdmin === true,
          // Absent from clients that never send one, which then read as awake
          // rather than filling the pane with idle markers.
          asleep: !!r.lastActivity && now - r.lastActivity > IDLE_MS,
        }))
        .sort((a, b) =>
          (a.asleep ? 1 : 0) - (b.asleep ? 1 : 0)
          || (b.op ? 1 : 0) - (a.op ? 1 : 0)
          || a.username.localeCompare(b.username))
    }

    /** One name in the online pane, with its idle marker. */
    const entry = (u: ChatUser): Span[] => {
      const name = { text: nick(u) }
      // Drawn DIM and after the name, so scanning the pane lands on names.
      return u.asleep ? [{ text: `${ASLEEP} `, attr: DIM }, name] : [name]
    }

    /**
     * Completion candidates in priority order: members present, in pane order;
     * then members who have spoken, most recent first; then names from the
     * site's index.
     */
    const suggestNames = (): string[] => {
      if (!suggest) return []
      const out: string[] = []
      const seen = new Set<string>()
      const add = (name: string | undefined, local: boolean): void => {
        const key = (name ?? '').toLowerCase()
        if (!key || seen.has(key)) return
        if (local && !key.startsWith(suggest!.frag)) return
        seen.add(key)
        out.push(name!)
      }
      for (const u of users) add(u.username, true)
      const said = wire.displayed
      for (let i = said.length - 1; i >= 0; i--) add(said[i].username, true)
      for (const name of suggest.remote) add(name, false)
      return out.slice(0, SUGGEST_MAX)
    }

    const suggestRect = (names: string[]): Rect | null => {
      if (!names.length) return null
      const widest = names.reduce((n, x) => Math.max(n, x.length), 0)
      const w = Math.min(logRect.w, Math.max(14, widest + 4))
      const h = Math.min(splitY - 1, names.length + 2)
      return { x: logRect.x, y: splitY - h, w, h }
    }

    const drawSuggest = (): void => {
      const names = suggestNames()
      const r = suggestRect(names)
      if (!r || !suggest) return

      // Cleared before framing, as the modals do: box drawing merges with
      // whatever is already in the cell, and the log beneath is full of text.
      clear(s, r)
      const inner = frame(s, r)
      label(s, r, 'NAMES', { attr: BRIGHT | BOLD })

      for (let i = 0; i < inner.h; i++) {
        const name = names[i]
        if (name === undefined) break
        const on = i === suggest.index
        // The whole row, so the selection reads as a bar rather than a ragged word.
        const text = ` ${name}`.padEnd(inner.w)
        // DIM with BOLD text: on an inverse cell the attribute applies to the
        // background, so BRIGHT would light the whole bar.
        s.text(inner.x, inner.y + i, text.slice(0, inner.w), on ? DIM | BOLD : NORMAL, on ? 1 : 0)
      }

      // Drawn last. Not on the screen stack, since it sits inside the log's own
      // rectangle, but it is a box over text and needs a background.
      ground(s, r)
    }

    /** Query the site's name index once typing has paused. */
    const askIndex = (frag: string): void => {
      if (suggestTimer !== null) clearTimeout(suggestTimer)
      suggestTimer = null
      const id = ++suggestReq
      if (frag.length < SUGGEST_MIN) return
      suggestTimer = setTimeout(() => {
        void api.searchUsers(frag).catch(() => [] as string[]).then((names) => {
          // Discarded if the fragment has moved on or the room has changed.
          if (id !== suggestReq || !running || !suggest) return
          suggest.remote = names
          paint()
        })
      }, SUGGEST_MS)
    }

    const closeSuggest = (): void => {
      if (suggestTimer !== null) clearTimeout(suggestTimer)
      suggestTimer = null
      suggest = null
    }

    /** Open, update or close the completion box to match the current input line. */
    const syncSuggest = (): void => {
      const found = MENTION_RE.exec(input.value)
      if (!found) { closeSuggest(); return }
      const frag = found[1].toLowerCase()
      if (suggest?.frag === frag) return
      // The previous index result is kept until its replacement arrives, so the
      // list does not empty and refill; local names narrow correctly meanwhile.
      suggest = { frag, remote: suggest?.remote ?? [], index: 0 }
      askIndex(frag)
    }

    const moveSuggest = (delta: number): void => {
      const names = suggestNames()
      if (!suggest || !names.length) return
      suggest.index = (suggest.index + delta + names.length) % names.length
      snd.tick()
      paint()
    }

    const acceptSuggest = (): void => {
      const names = suggestNames()
      const name = suggest ? names[suggest.index] : undefined
      const found = MENTION_RE.exec(input.value)
      if (!name || !found) { closeSuggest(); paint(); return }
      // Replaces the typed fragment only, leaving the @ and everything before it
      // untouched. The trailing space ends the completion.
      const typed = found[1].length
      input.set(input.value.slice(0, input.value.length - typed) + name + ' ')
      closeSuggest()
      paint()
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
      paint()
    }

    const paint = (): void => {
      if (!running) return
      // Stored here because every consumed key repaints, so no input path can
      // omit it. A field assignment rather than a serialise; the blob is read
      // when the session is written.
      p.setState({ v: STATE_VERSION, draft: input.value })
      // A modal holds the grid while open; painting beneath would erase it.
      if (stack.active) return
      blink.sync(wire.blinking)
      s.clear()

      frame(s, outer)
      if (!narrow) vline(s, splitX, 0, splitY)
      hline(s, splitY, 0, cols - 1)

      // Both labels vary with the room, and the rule also carries the pane's
      // junction and two corners, so widths are budgeted: a long slug or a
      // three-digit member count would otherwise overwrite the frame.
      const count = ` (${users.length})`
      // Right-anchored, so the count grows leftwards rather than over the
      // corner. Where the pane cannot hold the word too, the number is kept.
      const onlineMax = narrow ? cols - 4 : cols - 3 - splitX
      const online: Span[] = cells('ONLINE' + count) + 2 <= onlineMax
        ? [{ text: 'ONLINE', attr: BOLD }, { text: count }]
        : [{ text: count.trim(), attr: BOLD }]
      const onlineW = online.reduce((n, x) => n + cells(x.text), 2)

      // Wide layout stops at the junction. Narrow layout shares the rule between
      // both labels, and the room name is truncated first.
      label(s, outer, `#${(room?.slug ?? 'circ').toUpperCase()}`, {
        attr: BRIGHT | BOLD,
        max: narrow ? cols - 4 - onlineW : splitX - 2,
      })
      label(s, outer, narrow ? HINT_NARROW : HINT, { edge: 'bottom', align: 'right' })
      label(s, outer, online, { align: 'right', max: onlineMax })

      const picSpans: PicSpan[] = []
      const lines = logLines(picSpans)
      if (scroll > 0 && lines.length > lastLines) scroll += lines.length - lastLines
      lastLines = lines.length
      scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - logRect.h)))

      // Only the pictures on the pane are loaded, and they are the ones the bank
      // keeps: the log holds a hundred messages and the bank holds about seven
      // photographs. Same window as drawLog, which counts the scroll from the
      // bottom of the log.
      //
      // Bottom of the pane first. The log is drawn upwards from the last line,
      // so a picture that lands moves only the rows above it: read downwards,
      // every picture already drawn would be pushed up by the next one.
      if (pics) {
        const end = lines.length - scroll
        const top = end - logRect.h
        const { cols: pw, rows: ph } = picBounds()
        const shown = picSpans.filter(p => p.from < end && p.to > top).reverse()
        pics.ensure(shown.map(p => p.src), pw, ph)
      }

      drawLog(s, logRect, printing(lines, logRect.h, print.count), scroll)
      // Placeholder while the pane is empty. Cleared by the first feed(), which
      // sets primed.
      if (!primed) {
        s.text(logRect.x + Math.floor((logRect.w - 7) / 2),
          logRect.y + Math.floor(logRect.h / 2), 'LOADING', DIM)
      }

      drawSuggest()

      // roll.count is Infinity when no reveal is running, so the slice is the
      // whole list without a separate check.
      if (!narrow) {
        drawList(s, sidebarRect, users.slice(0, roll.count).map(u => ({ text: entry(u) })))
      }

      // Redraw the status rule, then the current activity on its right.
      hline(s, splitY, 1, cols - 2)
      if (status) s.text(cols - 4 - cells(status), splitY, ` ${status} `, BRIGHT)

      input.draw(s, inputRect)
      s.showCursor = true
      tty.paint(s.render())
    }

    // --- messages -------------------------------------------------------------

    const feed = (): void => {
      const list = ordered().map(asChat)
      if (!primed) {
        primed = true
        wire.prime(list)
        // The opening screenful is revealed a line at a time, oldest first.
        print.start(Math.min(logLines().length, logRect.h))
        paint()
        return
      }
      const fresh = wire.receive(list)
      if (fresh.length) {
        // A mention plays the tick tone, held longer.
        if (fresh.some(m => namesMe(m, m.content ?? ''))) snd.blip(2500, 0.06)
        else snd.blip(900)
      }
      wire.enqueue(fresh)
      paint()
    }

    const closeStream = (): void => { stopStream?.(); stopStream = null }

    const applyRaw = (id: string, raw: Record<string, unknown> | null): void => {
      if (raw === null) msgs.delete(id)
      else msgs.set(id, { ...(msgs.get(id) ?? {}), ...(raw as Partial<Msg>), id })
    }

    const trim = (): void => {
      if (msgs.size <= MAX_MSGS) return
      for (const m of ordered().slice(0, msgs.size - MAX_MSGS)) msgs.delete(m.id)
    }

    const connect = (roomId: string): void => {
      closeStream()
      stopStream = followList(
        api,
        token => `${base}/chat_messages/${encodeURIComponent(roomId)}.json` +
          `?orderBy=%22timestamp%22&limitToLast=100&auth=${encodeURIComponent(token)}`,
        (id, data, snapshot) => {
          if (id === null) {
            if (snapshot) msgs.clear()
            for (const [k, raw] of Object.entries(data ?? {})) {
              applyRaw(k, raw as Record<string, unknown> | null)
            }
          } else {
            applyRaw(id, data)
          }
          trim()
          feed()
        })
    }

    const fetchUsers = async (): Promise<void> => {
      if (!room) return
      const asked = room.id
      const rows = await api.get<RoomUser[]>(`/v1/circ/${asked}/users`).catch(() => null)
      // A roster request in flight across a room change belongs to the old room.
      if (room?.id !== asked) return
      if (rows) {
        users = roster(rows)
        // Revealed for a room's first roster only. This also runs on the
        // heartbeat, which must not reprint the pane every half minute.
        if (!rostered && !narrow) {
          rostered = true
          roll.start(Math.min(users.length, sidebarRect.h))
        }
      }
      paint()
    }

    const beat = async (): Promise<void> => {
      if (!room) return
      const r = await api.post<{ heartbeatMs?: number }>(
        `/v1/circ/${room.id}/presence`, { lastActivity }).catch(() => null)
      if (r?.heartbeatMs) heartbeatMs = r.heartbeatMs
    }

    const loadRooms = async (): Promise<Room[]> => {
      rooms = await api.get<Room[]>('/v1/circ')
      return rooms
    }

    const leaveRoom = async (): Promise<void> => {
      closeStream()
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
      if (room) {
        const id = room.id
        void api.post(`/v1/circ/${id}/read`, {}).catch(() => {})
        void api.delete(`/v1/circ/${id}/presence`).catch(() => {})
      }
      room = null
      users = []
      msgs.clear()
    }

    const joinRoom = async (word: string): Promise<boolean> => {
      const slug = word.replace(/^#/, '').toLowerCase()
      const list = rooms.length ? rooms : await loadRooms()
      const next = list.find(r => r.slug.toLowerCase() === slug || r.id === slug)
      if (!next) { say(`no such room: #${slug}`, true); return false }
      try {
        const r = await api.post<{ heartbeatMs?: number }>(
          `/v1/circ/${next.id}/presence`, { lastActivity })
        if (r?.heartbeatMs) heartbeatMs = r.heartbeatMs
      } catch (e) {
        say(e instanceof ApiError ? e.message : 'cannot join room', true)
        return false
      }
      // Room-change tone, suppressed on first entry.
      if (room) snd.blip(ROOM_HZ, 0.120, 0)
      await leaveRoom()
      room = next
      wire.reset()
      roll.stop()
      scroll = 0
      lastLines = 0
      system = []
      primed = false
      rostered = false
      void api.post(`/v1/circ/${next.id}/read`, {}).catch(() => {})
      connect(next.id)
      void fetchUsers()
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => { void beat(); void fetchUsers() }, heartbeatMs)
      // Points at the room currently being watched, so a reload returns there
      // rather than to the room the program was started with.
      p.setResume(`circ ${next.slug}`)
      // A room change replaces every line, so the diff has nothing to carry
      // over and one full repaint is cheaper.
      s.invalidate()
      paint()
      return true
    }

    const send = async (text: string): Promise<void> => {
      if (!room) return
      status = 'sending'
      paint()
      try {
        const r = await api.post<{ reply?: string }>(`/v1/circ/${room.id}`, { content: text })
        status = ''
        if (r?.reply) for (const line of r.reply.split('\n')) say(line)
      } catch (e) {
        status = 'send failed'
        snd.beep(220, 0.14)
        say(e instanceof ApiError ? e.message : 'send failed')
      }
      paint()
    }

    // --- modals --------------------------------------------------------------

    const open = (screen: Screen): void => {
      stack.push(screen)
      tty.paint(s.render())
    }

    const close = (): void => {
      stack.pop()
      s.invalidate()
      paint()
    }

    /** Drives a modal that animates between keystrokes; the stack only repaints on keys. */
    const repaint = (): void => {
      stack.top?.draw?.(s)
      tty.paint(s.render())
    }

    const openHelp = (): void => {
      open(new TextPopup({ title: 'COMMANDS', lines: HELP, onDone: () => close(), shadow: true }))
    }

    const openWho = (): void => {
      // Shares the sidebar's row builder, so the markers cannot drift apart.
      open(new TextPopup({
        title: `ONLINE (${users.length})`,
        lines: users.length ? users.map(entry) : [[{ text: 'nobody', attr: DIM }]],
        onDone: () => close(),
        shadow: true,
      }))
    }

    // Read markers come from RTDB directly; the API exposes no unread flag.
    const roomViews = async (): Promise<Record<string, { lastViewedAt?: number }>> => {
      if (!api.userId) return {}
      const token = await api.token()
      if (!token) return {}
      const r = await fetch(
        `${base}/chat_room_views/${encodeURIComponent(api.userId)}.json?auth=${encodeURIComponent(token)}`)
      if (!r.ok) return {}
      return (await r.json() as Record<string, { lastViewedAt?: number }> | null) ?? {}
    }

    const openRooms = async (): Promise<void> => {
      if (switching) return
      switching = true
      status = 'rooms…'
      paint()

      const [list, views] = await Promise.all([
        loadRooms().catch(() => rooms),
        roomViews().catch(() => ({} as Record<string, { lastViewedAt?: number }>)),
      ])

      switching = false
      status = ''
      if (!running) return
      if (!list.length) {
        status = 'no rooms'
        snd.beep(220, 0.12)
        paint()
        return
      }

      // The current room is never marked unread.
      const unread = (r: Room): boolean =>
        r.slug !== room?.slug &&
        (r.lastMessageAt ?? 0) > (views[r.id]?.lastViewedAt ?? 0)
      const heads = list.map(r => `#${r.slug.toUpperCase()}` + (unread(r) ? ` ${UNREAD}` : ''))
      const counts = list.map(r => r.onlineCount ? String(Math.min(r.onlineCount, 999)) : '')
      const headW = heads.reduce((n, h) => Math.max(n, h.length), 0)
      const countW = counts.reduce((n, c) => Math.max(n, c.length), 0)
      const rowW = countW ? headW + GAP + countW : headW

      open(new SelectPopup({
        title: 'ROOMS',
        hint: `${ARROWS} ↵`,
        items: heads.map((h, i) => (h + counts[i].padStart(rowW - h.length)).trimEnd()),
        selected: Math.max(0, list.findIndex(r => r.slug === room?.slug)),
        // Marker BOLD, count DIM. On the inverted row the attribute is the background.
        decorate: (g, row, i, on) => {
          const head = heads[i]
          const count = counts[i]
          if (head === undefined || count === undefined) return
          const inv = on ? 1 : 0
          const markX = head.length - 1
          const countX = rowW - count.length
          if (list[i] && unread(list[i]) && markX < row.w) {
            g.text(row.x + markX, row.y, UNREAD, on ? DIM | BOLD : BOLD, inv)
          }
          if (count && countX + count.length <= row.w) {
            g.text(row.x + countX, row.y, count, DIM, inv)
          }
        },
        // Drawn above the input divider so the line being typed stays visible.
        bounds: { x: 0, y: 0, w: cols, h: splitY },
        trimTop: 1,
        shadow: true,
        onRepaint: repaint,
        onFeedback: (kind) => {
          if (kind === 'edge') snd.beep(220, 0.04)
          else if (kind === 'move') snd.tick()
        },
        onDone: (_item, index) => {
          const picked = _item === null ? null : list[index]
          close()
          if (picked && picked.slug !== room?.slug) void joinRoom(picked.slug)
        },
      }))
    }

    const askQuit = (): void => {
      open(new ConfirmPopup({
        title: 'EXIT',
        lines: ['Quit cIRC?'],
        hint: YES_NO,
        onDone: (yes) => { close(); if (yes) running = false },
        shadow: true,
      }))
    }

    // --- keys ----------------------------------------------------------------

    const submit = (): void => {
      const text = input.value.trim()
      input.clear()
      closeSuggest()
      if (!text) { paint(); return }
      const route = routeSlash(text, 'chat', LOCAL_NAMES)
      if (route && 'unknown' in route) {
        say(`Unknown command: ${route.unknown} (try /help)`, true)
        return
      }
      if (route && 'help' in route) { openHelp(); return }
      if (route && 'local' in route) {
        switch (route.local) {
          case 'quit': case 'exit': running = false; return
          case 'rooms': void openRooms(); return
          case 'who':
            if (narrow) openWho()
            else say(users.map(u => u.username).join(' ') || 'nobody here')
            return
        }
      }
      void send(text)
      paint()
    }

    const onKey = (k: KeyInput): void => {
      if (stack.active) { stack.key(k); tty.paint(s.render()); return }

      // Any key finishes the backlog reveal and then acts as it normally would.
      print.finish()
      roll.finish()

      if (k.ctrlKey && k.key === 'c') { askQuit(); return }
      if (k.key === 'Escape') {
        if (suggest) { closeSuggest(); paint(); return }
        askQuit()
        return
      }
      if (k.ctrlKey && k.key === 'h') { openHelp(); return }
      if (k.ctrlKey && k.key === 'j') { void openRooms(); return }
      if (k.ctrlKey && k.key === 'u' && narrow) { openWho(); return }

      // While the names box is open it takes the arrows and Tab, which are its
      // whole interaction; an arrow scrolling the log would leave the cycle stuck.
      const names = suggestNames()
      if (names.length && !k.ctrlKey && !k.metaKey && !k.altKey) {
        if (k.key === 'ArrowUp') { moveSuggest(-1); return }
        if (k.key === 'ArrowDown') { moveSuggest(1); return }
        if (k.key === 'Tab' || k.key === 'Enter') { acceptSuggest(); return }
        if (k.key === 'Escape') { closeSuggest(); paint(); return }
      }

      if (k.key === 'Enter') { submit(); return }
      if (k.key === 'Tab') { completeSlash(); return }

      // Up and down always produce a response: a line of scrollback, or the
      // edge beep at the end of it.
      const page = Math.max(1, logRect.h - 2)
      const maxScroll = Math.max(0, lastLines - logRect.h)
      const move = (to: number): void => {
        const next = Math.max(0, Math.min(maxScroll, to))
        if (next === scroll) snd.beep(220, 0.04)
        else { scroll = next; snd.tick() }
        paint()
      }
      if (k.key === 'ArrowUp') { move(scroll + 1); return }
      if (k.key === 'ArrowDown') { move(scroll - 1); return }
      if (k.key === 'PageUp') { move(scroll + page); return }
      if (k.key === 'PageDown') { move(scroll - page); return }

      if (input.onKey(k)) { syncSuggest(); paint() }
    }

    // --- run -----------------------------------------------------------------

    tty.setRaw()
    // These play their own tick, so the host suppresses the key click.
    tty.silence(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])
    p.out('\x1b[?1049h')
    s.invalidate()
    paint()

    try {
      const parked = readState(p.takeState())
      if (parked?.draft) { input.set(parked.draft); paint() }

      const target = p.argv[1] ?? (await loadRooms().catch(() => []))[0]?.slug
      if (!target || !await joinRoom(target)) {
        say('/rooms to enter one, /quit to leave')
      }

      while (running) {
        const chunk = await p.stdin.read()
        if (chunk === null) break
        lastActivity = Date.now()
        for (const k of parseKeys(dec.decode(chunk))) {
          onKey(k)
          if (!running) break
        }
      }
      return 0
    } finally {
      running = false
      wire.close()
      print.stop()
      roll.stop()
      blink.stop()
      unwatchPics?.()
      pics?.release()
      await leaveRoom()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
