// cmail — C-Mail, 1:1 messages. `cmail` lists conversations; `cmail user`
// opens one full-screen, live over the same RTDB stream circ uses. Sends and
// read markers go through the API.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import { Surface, parseKeys, NORMAL, BOLD, DIM } from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { bodyOf, followList, hhmm, wrapSpans, type MsgBody, type Span } from './chatui.js'

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

const MAX_MSGS = 200
const MAX_INPUT = 2048

const day = (t: number): string =>
  t ? new Date(t).toISOString().slice(5, 10) : '     '

export function cmailProgram(api: ApiClient, rtdb: string): Program {
  const base = rtdb.replace(/\/$/, '')

  return async (p: Proc) => {
    if (!api.authed) {
      p.err('cmail: not logged in\n')
      return 1
    }

    // List mode: no recipient named.
    if (!p.argv[1]) {
      let list: Conversation[]
      try {
        list = await api.get<Conversation[]>('/v1/cmail')
      } catch (e) {
        p.err(`cmail: ${e instanceof ApiError ? e.message : e}\n`)
        return 1
      }
      if (!list.length) {
        p.out('No mail.\n')
        return 0
      }
      for (const c of list) {
        const mark = c.unreadCount > 0 ? 'N' : ' '
        const snippet = c.lastMessage.replace(/\s+/g, ' ').slice(0, 40)
        const head = `${mark} ${c.otherUser.username.padEnd(18)} `
        if (c.unreadCount > 0) {
          p.out(`\x1b[1m${head}${day(c.lastMessageAt)}  ${snippet}\x1b[0m\n`)
        } else {
          p.out(`${head}\x1b[2m${day(c.lastMessageAt)}\x1b[0m  ${snippet}\n`)
        }
      }
      p.out('\x1b[2mcmail user opens a conversation.\x1b[0m\n')
      return 0
    }

    // Conversation mode.
    if (!p.tty) {
      p.err('cmail: no tty\n')
      return 1
    }
    if (typeof EventSource === 'undefined') {
      p.err('cmail: no event stream support\n')
      return 1
    }

    const who = p.argv[1]
    let convId: string
    let other: string
    try {
      const r = await api.post<{ conversationId: string; otherUser: { username: string } }>(
        '/v1/cmail', { recipientUsername: who })
      convId = r.conversationId
      other = r.otherUser.username
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        p.err(`cmail: ${who}: no such user\n`)
        return 1
      }
      p.err(`cmail: ${e instanceof ApiError ? e.message : e}\n`)
      return 1
    }

    const cols = p.tty.cols
    const rows = p.tty.rows
    const logH = rows - 2
    const s = new Surface(cols, rows)
    const me = (api.username ?? '').toLowerCase()

    const msgs = new Map<string, Msg>()
    let input = ''
    let scroll = 0
    let running = true

    const ordered = (): Msg[] =>
      [...msgs.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

    const lineOf = (m: Msg): Span[] => {
      const time: Span = [`${hhmm(m.timestamp)} `, DIM]
      const nick = m.senderUsername ?? '?'
      const body = bodyOf(m)
      if (m.deleted) return [time, [`<${nick}> ${body}`, DIM]]
      if (m.isAction) return [time, [`* ${nick} `, BOLD], [body, NORMAL]]
      return [time, [`<${nick}> `, nick.toLowerCase() === me ? DIM : BOLD], [body, NORMAL]]
    }

    const paint = (): void => {
      s.clear()

      s.text(1, 0, `mail: ${other}`, BOLD)

      const lines: Span[][] = []
      for (const m of ordered()) lines.push(...wrapSpans(lineOf(m), cols, 6))
      scroll = Math.min(scroll, Math.max(0, lines.length - logH))
      const top = Math.max(0, lines.length - logH - scroll)
      for (let i = 0; i < logH; i++) {
        const line = lines[top + i]
        if (!line) continue
        let lx = 0
        for (const [text, attr] of line) lx = s.text(lx, i + 1, text, attr)
      }

      const prompt = '> '
      const room = cols - prompt.length - 1
      const shown = input.length > room ? input.slice(input.length - room) : input
      s.text(0, rows - 1, prompt, BOLD)
      s.text(prompt.length, rows - 1, shown, NORMAL)
      s.cx = prompt.length + shown.length
      s.cy = rows - 1
      s.cursorVisible = true

      p.out(s.render())
    }

    // Debounced: the stream fires this per event, the endpoint is rate-limited.
    let readTimer: ReturnType<typeof setTimeout> | null = null
    const markRead = (): void => {
      if (readTimer) return
      readTimer = setTimeout(() => { readTimer = null }, 2000)
      void api.post(`/v1/cmail/${convId}/read`, {}).catch(() => {})
    }

    const stopStream = followList(
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
        paint()
      })

    const send = async (text: string): Promise<void> => {
      try {
        const r = await api.post<{ reply?: string }>(`/v1/cmail/${convId}`, { content: text })
        if (r?.reply) {
          const id = `local-${Date.now()}`
          msgs.set(id, { id, senderUsername: '--', content: r.reply, timestamp: Date.now() })
          paint()
        }
      } catch (e) {
        const id = `local-${Date.now()}`
        const text_ = e instanceof ApiError ? e.message : 'send failed'
        msgs.set(id, { id, senderUsername: '--', content: text_, timestamp: Date.now() })
        paint()
      }
    }

    p.tty.setRaw()
    p.out('\x1b[?1049h')
    s.invalidate()
    paint()
    markRead()

    try {
      while (running) {
        const chunk = await p.stdin.read()
        if (chunk === null) break
        for (const k of parseKeys(dec.decode(chunk))) {
          if (k.ctrlKey && k.key === 'c') { running = false; break }
          if (k.key === 'Escape') { running = false; break }
          if (k.key === 'Enter') {
            const text = input.trim()
            input = ''
            if (text === '/quit' || text === '/exit') { running = false; break }
            if (text) void send(text)
            paint()
            continue
          }
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
      stopStream()
      if (readTimer) { clearTimeout(readTimer); readTimer = null }
      markRead()
      p.out('\x1b[?1049l\x1b[?25h')
      p.tty.setCooked()
    }
  }
}
