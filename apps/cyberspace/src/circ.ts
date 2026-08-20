// circ — cIRC chat client. Room state and sends go through the API; live
// messages arrive on an RTDB REST stream (EventSource, same idToken). Slash
// commands resolve server-side except /join, /rooms, /who, /quit.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import { Surface, parseKeys, NORMAL, BOLD, DIM } from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { bodyOf, followList, hhmm, wrapSpans, type MsgBody, type Span } from './chatui.js'

interface Room {
  id: string
  slug: string
  name: string
  onlineCount: number
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

const SIDEBAR_W = 14
const NARROW = 60
const MAX_MSGS = 200
const MAX_INPUT = 2048

export function circProgram(api: ApiClient, rtdb: string): Program {
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

    const cols = p.tty.cols
    const rows = p.tty.rows
    const wide = cols >= NARROW
    const logW = wide ? cols - SIDEBAR_W - 1 : cols
    const logH = rows - 2
    const s = new Surface(cols, rows)
    const me = (api.username ?? '').toLowerCase()

    let room: Room | null = null
    let rooms: Room[] = []
    let msgs = new Map<string, Msg>()
    let users: RoomUser[] = []
    let input = ''
    let scroll = 0 // lines above the bottom
    let heartbeatMs = 30000
    let lastActivity = Date.now()
    let running = true

    let stopStream: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null

    const system = (text: string): void => {
      const id = `local-${Date.now()}-${Math.random()}`
      msgs.set(id, { id, isSystem: true, content: text, timestamp: Date.now() })
      paint()
    }

    const ordered = (): Msg[] =>
      [...msgs.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

    const lineOf = (m: Msg): Span[] => {
      const time: Span = [`${hhmm(m.timestamp)} `, DIM]
      const body = bodyOf(m)
      if (m.isSystem) return [time, [`-- ${body}`, DIM]]
      if (m.deleted) return [time, [`<${m.username ?? '?'}> ${body}`, DIM]]
      const nick = m.username ?? '?'
      const mine = nick.toLowerCase() === me
      const mentioned = me !== '' && body.toLowerCase().includes(`@${me}`)
      if (m.isAction) return [time, [`* ${nick} `, BOLD], [body, mentioned ? BOLD : NORMAL]]
      return [
        time,
        [`<${nick}> `, mine ? DIM : BOLD],
        [body, mentioned ? BOLD : NORMAL],
      ]
    }

    const paint = (): void => {
      s.clear()

      // Header: room, online count.
      const title = room ? `#${room.slug}` : 'circ'
      let x = s.text(1, 0, title, BOLD)
      if (room?.name && room.name.toLowerCase() !== room.slug) {
        x = s.text(x + 2, 0, room.name, DIM)
      }
      const count = `${users.length} online`
      s.text(cols - count.length - 1, 0, count, DIM)

      // Log.
      const lines: Span[][] = []
      for (const m of ordered()) lines.push(...wrapSpans(lineOf(m), logW, 6))
      scroll = Math.min(scroll, Math.max(0, lines.length - logH))
      const top = Math.max(0, lines.length - logH - scroll)
      for (let i = 0; i < logH; i++) {
        const line = lines[top + i]
        if (!line) continue
        let lx = 0
        for (const [text, attr] of line) lx = s.text(lx, i + 1, text, attr)
      }

      // Sidebar.
      if (wide) {
        for (let y = 1; y < rows - 1; y++) s.put(logW, y, '|', DIM)
        users.slice(0, rows - 2).forEach((u, i) => {
          const idle = u.lastActivity !== null && Date.now() - u.lastActivity > 5 * 60_000
          s.text(logW + 2, i + 1, u.username.slice(0, SIDEBAR_W - 2), idle ? DIM : NORMAL)
        })
      }

      // Input line. Long input scrolls so the cursor stays visible.
      const prompt = '> '
      const room_ = cols - prompt.length - 1
      const shown = input.length > room_ ? input.slice(input.length - room_) : input
      s.text(0, rows - 1, prompt, BOLD)
      s.text(prompt.length, rows - 1, shown, NORMAL)
      s.cx = prompt.length + shown.length
      s.cy = rows - 1
      s.cursorVisible = true

      p.out(s.render())
    }

    const closeStream = (): void => {
      stopStream?.()
      stopStream = null
    }

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
          paint()
        })
    }

    const fetchUsers = async (): Promise<void> => {
      if (!room) return
      users = await api.get<RoomUser[]>(`/v1/circ/${room.id}/users`).catch(() => users)
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
      msgs = new Map()
    }

    const joinRoom = async (word: string): Promise<boolean> => {
      const slug = word.replace(/^#/, '').toLowerCase()
      const list = rooms.length ? rooms : await loadRooms()
      const next = list.find(r => r.slug.toLowerCase() === slug || r.id === slug)
      if (!next) {
        system(`no such room: #${slug}`)
        return false
      }
      try {
        const r = await api.post<{ heartbeatMs?: number }>(
          `/v1/circ/${next.id}/presence`, { lastActivity })
        if (r?.heartbeatMs) heartbeatMs = r.heartbeatMs
      } catch (e) {
        system(e instanceof ApiError ? e.message : 'cannot join room')
        return false
      }
      await leaveRoom()
      room = next
      scroll = 0
      void api.post(`/v1/circ/${next.id}/read`, {}).catch(() => {})
      connect(next.id)
      void fetchUsers()
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => { void beat(); void fetchUsers() }, heartbeatMs)
      paint()
      return true
    }

    const send = async (text: string): Promise<void> => {
      if (!room) return
      try {
        const r = await api.post<{ reply?: string }>(`/v1/circ/${room.id}`, { content: text })
        if (r?.reply) for (const line of r.reply.split('\n')) system(line)
      } catch (e) {
        system(e instanceof ApiError ? e.message : 'send failed')
      }
    }

    const showRooms = async (): Promise<void> => {
      const list = await loadRooms().catch(() => rooms)
      for (const r of list) system(`#${r.slug.padEnd(16)} ${r.onlineCount} online`)
    }

    const submit = (): void => {
      const text = input.trim()
      input = ''
      if (!text) { paint(); return }
      const [cmd, ...rest] = text.split(/\s+/)
      const word = cmd.toLowerCase()
      if (word === '/quit' || word === '/exit') { running = false; return }
      if (word === '/join' || word === '/j') {
        if (rest[0]) void joinRoom(rest[0])
        else system('usage: /join room')
        paint()
        return
      }
      if (word === '/rooms') { void showRooms(); paint(); return }
      if (word === '/who') {
        system(users.map(u => u.username).join(' ') || 'nobody here')
        return
      }
      void send(text)
      paint()
    }

    // --- run -----------------------------------------------------------------

    p.tty.setRaw()
    p.out('\x1b[?1049h')
    s.invalidate()
    paint()

    try {
      // No argument: the first listed room is the house default.
      const target = p.argv[1] ?? (await loadRooms().catch(() => []))[0]?.slug
      if (!target || !await joinRoom(target)) {
        await showRooms()
        system('/join room to enter, /quit to leave')
        paint()
      }

      while (running) {
        const chunk = await p.stdin.read()
        if (chunk === null) break
        lastActivity = Date.now()
        for (const k of parseKeys(dec.decode(chunk))) {
          if (k.ctrlKey && k.key === 'c') { running = false; break }
          if (k.key === 'Escape') { running = false; break }
          if (k.key === 'Enter') { submit(); continue }
          if (k.key === 'Backspace') { input = input.slice(0, -1); paint(); continue }
          if (k.ctrlKey && k.key === 'u') { input = ''; paint(); continue }
          if (k.key === 'PageUp') { scroll += Math.max(1, logH - 2); paint(); continue }
          if (k.key === 'PageDown') { scroll = Math.max(0, scroll - Math.max(1, logH - 2)); paint(); continue }
          if (!k.ctrlKey && !k.metaKey && k.key.length === 1 && input.length < MAX_INPUT) {
            input += k.key
            paint()
          }
        }
      }
      return 0
    } finally {
      running = false
      await leaveRoom()
      p.out('\x1b[?1049l\x1b[?25h')
      p.tty.setCooked()
    }
  }
}
