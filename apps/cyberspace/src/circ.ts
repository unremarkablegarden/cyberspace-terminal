// circ — cIRC. The room as the machine at /terminal draws it: a framed log
// under a titled rule, the online pane beside it, a status rule, and the
// legend across the foot.
//
// Room state and sends go through the API; live messages arrive on an RTDB REST
// stream (EventSource, same idToken). Slash commands resolve server-side except
// /rooms, /who, /quit and /help; an unknown verb is refused here, since the
// server would post it as prose. Rooms change through the picker — ^J or
// /rooms — not a /join.
//
// Arrival is two clocks and they never run together. The opening screenful is
// PRINTED by the line (Reveal, 45 a second): a room's history is already
// history, and typing it out would be minutes of somebody else's evening
// retyped in front of you. What arrives after is TYPED at 2400 baud, because
// that is somebody talking.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, InputLine, Reveal, drawLog, drawList, parseKeys,
  frame, hline, vline, label, cells, clear, ground, plain,
  ConfirmPopup, SelectPopup, TextPopup, YES_NO,
  NORMAL, BRIGHT, BOLD, DIM,
  type LogLine, type Span, type Rect, type KeyInput, type Screen,
} from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { bodyOf, followList, hasStyle, type MsgBody } from './chatui.js'
import {
  ARROWS, ASLEEP, BLIP_HZ, Blinker, SILENT, Typewriter, entryLines, entryParts,
  mentions, narrowLines, nick, printing, systemLines, type ChatMessage,
  type ChatSound, type ChatUser,
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

/** The online pane, its two border columns included. */
const SIDEBAR_W = 16
/** Below this the pane and the gutter leave too little to say anything in. */
const NARROW = 60
const MAX_MSGS = 200
const IDLE_MS = 5 * 60_000
/** Names offered at once. */
const SUGGEST_MAX = 6
/** How long the typing has to pause before the index is asked. */
const SUGGEST_MS = 250
/** Shorter than this and the index has nothing useful to say. */
const SUGGEST_MIN = 2
/** An @ being typed at the end of the line, and the fragment after it. */
const MENTION_RE = /(?:^|\s)@(\w*)$/
/** Pitch of the boop a room change makes. */
const ROOM_HZ = 420
/** The mark on a room with something in it you have not read. */
const UNREAD = '+'
/** Blank columns between the longest room name and the head count. */
const GAP = 2

/** The commands this program answers itself; the server resolves the rest. */
const LOCAL: LocalCommand[] = [
  { name: 'rooms', usage: '/rooms', summary: 'list them' },
  { name: 'who', usage: '/who', summary: 'who is here' },
  { name: 'quit', usage: '/quit', summary: 'leave cIRC' },
]
/** As dispatched, aliases included. Tab and the help box show only LOCAL. */
const LOCAL_NAMES = ['rooms', 'who', 'quit', 'exit']
const SLASH = slashNames('chat', LOCAL)

/**
 * The legend. Inverse keycaps: the beam fills the cell and the glyph is the
 * hole left in it, which is the frame's own voice — a modal's hint is plain
 * text, and a second row of caps would compete with this one.
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

/** The same legend for a narrow room: no pane, so Who joins the row. */
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

export function circProgram(api: ApiClient, rtdb: string, snd: ChatSound = SILENT): Program {
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

    // Every rect off cols/rows: a literal column count is a bug on the other
    // screen size.
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
    /** Local-only lines, merged into the log by time. */
    let system: { text: string; at: number }[] = []
    let scroll = 0
    let lastLines = 0
    let status = ''
    let heartbeatMs = 30000
    let lastActivity = Date.now()
    let running = true
    let primed = false
    let switching = false
    /** Whether this room's roster has printed. Only the first one does. */
    let rostered = false

    let stopStream: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null

    /** The @ being typed, what the index said about it, and where the cycle is. */
    let suggest: { frag: string; remote: string[]; index: number } | null = null
    let suggestTimer: ReturnType<typeof setTimeout> | null = null
    let suggestReq = 0

    const ordered = (): Msg[] =>
      [...msgs.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

    /** The wire's shape, as the line builders want it. */
    const asChat = (m: Msg): ChatMessage => ({
      id: m.id,
      username: m.username,
      timestamp: m.timestamp,
      content: bodyOf(m),
      action: m.isAction,
      system: m.isSystem,
      deleted: m.deleted,
      blink: hasStyle(m.style, 'blink'),
    })

    const wire = new Typewriter({
      text: m => { const { head, body } = entryParts(m); return head + body },
      onTick: () => paint(),
      onBlip: () => snd.blip(BLIP_HZ),
    })

    // One bleep per BATCH of printed lines, as the shell's own type-out does it.
    const print = new Reveal({ onTick: () => paint(), onBlip: () => snd.blip(BLIP_HZ) })

    // The roster lands the same way the backlog does — a name at a time, coming
    // down the wire. Silent while the log is printing: the two run together on
    // entry, and one clock chattering is arrival, two is a fault.
    const roll = new Reveal({
      onTick: () => paint(),
      onBlip: () => { if (!print.running) snd.blip(BLIP_HZ) },
    })

    const blink = new Blinker(() => paint())

    // The server's own replies come through here — /fortune, /8ball and the
    // rest — so they are folded like a message body.
    const say = (text: string, complaint = false): void => {
      system.push({ text: plain(text), at: Date.now() })
      if (system.length > 40) system = system.slice(-40)
      if (complaint) snd.beep(220, 0.09)
      paint()
    }

    // Never your own lines: /me and /8ball carry the author's name in the text.
    const namesMe = (m: ChatMessage, text: string): boolean =>
      (m.username ?? '').toLowerCase() !== me && mentions(text, me)

    const lineOf = (m: ChatMessage, reveal?: number): LogLine[] => {
      const opts = { reveal, namesMe: (said: string) => namesMe(m, said), blinkOn: blink.on }
      return narrow ? narrowLines(m, logRect.w, opts) : entryLines(m, logRect.w, opts)
    }

    const logLines = (): LogLine[] => {
      // Local lines interleave with the room by time.
      const entries: { at: number; lines: () => LogLine[] }[] = [
        ...wire.displayed.map(m => ({ at: m.timestamp ?? 0, lines: () => lineOf(m) })),
        ...system.map(s => ({
          at: s.at,
          lines: () => systemLines(s.text, logRect.w, narrow ? 0 : undefined),
        })),
      ]
      entries.sort((a, b) => a.at - b.at)
      const out: LogLine[] = []
      for (const e of entries) out.push(...e.lines())
      // Then the one still coming in, as far as it has got.
      const head = wire.head
      if (head) out.push(...lineOf(head, wire.typed))
      return out
    }

    /**
     * The room's roster, in the order it is read.
     *
     * Sleepers sink to the bottom, and outrank the op sigil doing it: an op who
     * left a window open is not who you talk to, so sorting them up among the
     * people actually here would be worse than losing the tidy block of `@`s.
     * Above that line it is the order every IRC client has used since 1988 —
     * ops first, alphabetical within each group.
     */
    const roster = (rows: RoomUser[]): ChatUser[] => {
      const now = Date.now()
      return rows
        .map((r): ChatUser => ({
          // Folded here rather than at each use: the pane, the Who box, the
          // mention index and /who all read this list.
          username: plain(r.username),
          op: r.isChatAdmin === true,
          // Absent on a client that never sent one: those read as awake, which
          // is better than a pane full of sleepers.
          asleep: !!r.lastActivity && now - r.lastActivity > IDLE_MS,
        }))
        .sort((a, b) =>
          (a.asleep ? 1 : 0) - (b.asleep ? 1 : 0)
          || (b.op ? 1 : 0) - (a.op ? 1 : 0)
          || a.username.localeCompare(b.username))
    }

    /** A name in the online pane, and whether it has been sitting still. */
    const entry = (u: ChatUser): Span[] => {
      const name = { text: nick(u) }
      // DIM, and behind the name: the marker is a fact about somebody rather
      // than a thing they are doing, and skimming the pane for who is here
      // should land on names.
      return u.asleep ? [{ text: `${ASLEEP} `, attr: DIM }, name] : [name]
    }

    /**
     * Who to offer, in the order worth offering them.
     *
     * Present first, as the pane lists them; then whoever has spoken, most
     * recent first — in a room of regulars that is nearly always the person you
     * meant; then whatever the site's index answered with.
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

      // Blank before framing, as the modals do: box drawing merges with
      // whatever is in the cell, and the log underneath is full of text.
      clear(s, r)
      const inner = frame(s, r)
      label(s, r, 'NAMES', { attr: BRIGHT | BOLD })

      for (let i = 0; i < inner.h; i++) {
        const name = names[i]
        if (name === undefined) break
        const on = i === suggest.index
        // The whole row, so the selection is a bar rather than a ragged word.
        const text = ` ${name}`.padEnd(inner.w)
        // Dim field, thickened letters: on an inverse cell the attribute is the
        // FIELD, and BRIGHT there lights the whole bar.
        s.text(inner.x, inner.y + i, text.slice(0, inner.w), on ? DIM | BOLD : NORMAL, on ? 1 : 0)
      }

      // Last. It is not on the screen stack — it is drawn inside the log's own
      // rectangle — but it is a box floating over text, which is what a ground
      // is for.
      ground(s, r)
    }

    /** Ask the site's index, once the typing has paused. */
    const askIndex = (frag: string): void => {
      if (suggestTimer !== null) clearTimeout(suggestTimer)
      suggestTimer = null
      const id = ++suggestReq
      if (frag.length < SUGGEST_MIN) return
      suggestTimer = setTimeout(() => {
        void api.searchUsers(frag).catch(() => [] as string[]).then((names) => {
          // Stale if the fragment moved on, pointless if the room is gone.
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

    /** Read the line and open, update or close the box to match it. */
    const syncSuggest = (): void => {
      const found = MENTION_RE.exec(input.value)
      if (!found) { closeSuggest(); return }
      const frag = found[1].toLowerCase()
      if (suggest?.frag === frag) return
      // Whatever the index last said is kept until its replacement lands: a
      // list that empties and refills reads as broken, and the locals
      // underneath are already narrowing correctly.
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
      // Replace the typed fragment only: the `@` and everything before it stay
      // exactly as they are, and a trailing space means the next word is just a
      // word.
      const typed = found[1].length
      input.set(input.value.slice(0, input.value.length - typed) + name + ' ')
      closeSuggest()
      paint()
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
      paint()
    }

    const paint = (): void => {
      if (!running) return
      // A modal owns the grid while it is up; painting under it would erase it.
      if (stack.active) return
      blink.sync(wire.blinking)
      s.clear()

      frame(s, outer)
      if (!narrow) vline(s, splitX, 0, splitY)
      hline(s, splitY, 0, cols - 1)

      // Both labels in this rule are as wide as the room makes them, and the
      // rule also carries the pane's junction and two corners. Budget them or a
      // long slug — or a head count in the hundreds — writes over the frame.
      const count = ` (${users.length})`
      // Right-anchored, so the count grows leftwards as it widens rather than
      // over the corner. Where the pane is too narrow to hold the word as well,
      // the number is the fact worth keeping.
      const onlineMax = narrow ? cols - 4 : cols - 3 - splitX
      const online: Span[] = cells('ONLINE' + count) + 2 <= onlineMax
        ? [{ text: 'ONLINE', attr: BOLD }, { text: count }]
        : [{ text: count.trim(), attr: BOLD }]
      const onlineW = online.reduce((n, x) => n + cells(x.text), 2)

      // Wide: stop at the junction. Narrow: the two labels share the rule, so
      // the room name is what gives way.
      label(s, outer, `#${(room?.slug ?? 'circ').toUpperCase()}`, {
        attr: BRIGHT | BOLD,
        max: narrow ? cols - 4 - onlineW : splitX - 2,
      })
      label(s, outer, narrow ? HINT_NARROW : HINT, { edge: 'bottom', align: 'right' })
      label(s, outer, online, { align: 'right', max: onlineMax })

      const lines = logLines()
      if (scroll > 0 && lines.length > lastLines) scroll += lines.length - lastLines
      lastLines = lines.length
      scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - logRect.h)))
      drawLog(s, logRect, printing(lines, logRect.h, print.count), scroll)

      drawSuggest()

      // `roll.count` is Infinity when no reveal is running, so the slice is the
      // whole list without asking whether one is.
      if (!narrow) {
        drawList(s, sidebarRect, users.slice(0, roll.count).map(u => ({ text: entry(u) })))
      }

      // The status rule: redraw it, then what is happening on the right.
      hline(s, splitY, 1, cols - 2)
      if (status) s.text(cols - 4 - cells(status), splitY, ` ${status} `, BRIGHT)

      input.draw(s, inputRect)
      s.showCursor = true
      tty.paint(s.render())
    }

    // --- the wire ------------------------------------------------------------

    const feed = (): void => {
      const list = ordered().map(asChat)
      if (!primed) {
        primed = true
        wire.prime(list)
        // The opening screenful prints by the line, oldest first.
        print.start(Math.min(logLines().length, logRect.h))
        paint()
        return
      }
      const fresh = wire.receive(list)
      if (fresh.length) {
        // A mention chirps in the tick's voice, held longer.
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
      // A roster in flight when the room changed belongs to the room you left.
      if (room?.id !== asked) return
      if (rows) {
        users = roster(rows)
        // The first roster of a room only. This also runs on the heartbeat, and
        // a pane that reprinted itself every half minute is a fault, not arrival.
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
      // Room-change boop; not on first entry.
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
      // A room change swaps every line at once. One full repaint here is cheap,
      // and it is the only moment the diff has nothing worth carrying over.
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

    /** A modal animating between keystrokes — the stack only repaints on keys. */
    const repaint = (): void => {
      stack.top?.draw?.(s)
      tty.paint(s.render())
    }

    const openHelp = (): void => {
      open(new TextPopup({ title: 'COMMANDS', lines: HELP, onDone: () => close(), shadow: true }))
    }

    const openWho = (): void => {
      // Same row builder as the sidebar, so the markers cannot drift.
      open(new TextPopup({
        title: `ONLINE (${users.length})`,
        lines: users.length ? users.map(entry) : [[{ text: 'nobody', attr: DIM }]],
        onDone: () => close(),
        shadow: true,
      }))
    }

    // Read markers off the RTDB; the API has no unread flag.
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

      // Never marks the current room.
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
        // Mark BOLD, count DIM; on the inverted row the attr is the field.
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
        // Above the input divider: the line being typed stays visible.
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

      // Any key ends the backlog print, then means what it always means.
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

      // While the names box is up it owns the arrows and Tab: that is the whole
      // interaction, and an arrow that scrolled the log instead would be the
      // cycle you are in refusing to move.
      const names = suggestNames()
      if (names.length && !k.ctrlKey && !k.metaKey && !k.altKey) {
        if (k.key === 'ArrowUp') { moveSuggest(-1); return }
        if (k.key === 'ArrowDown') { moveSuggest(1); return }
        if (k.key === 'Tab' || k.key === 'Enter') { acceptSuggest(); return }
        if (k.key === 'Escape') { closeSuggest(); paint(); return }
      }

      if (k.key === 'Enter') { submit(); return }
      if (k.key === 'Tab') { completeSlash(); return }

      // Up and down always land on something that answers: a line of scrollback,
      // or a complaint at the end of it.
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
    // These answer with a tick of their own; the host must not clack over it.
    tty.silence(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])
    p.out('\x1b[?1049h')
    s.invalidate()
    paint()

    try {
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
      await leaveRoom()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
