// Shared furniture for the chat programs: span wrapping, timestamps,
// attachment placeholders, and the RTDB REST live stream.

import { NORMAL } from '@cyberspace/tui'
import type { ApiClient } from './api.js'

export type Span = [text: string, attr: number]

export const hhmm = (t?: number): string => {
  if (typeof t !== 'number') return '--:--'
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface MsgBody {
  content?: string
  eightballAnswer?: string
  fortuneText?: string
  gifUrl?: string
  imageUrl?: string
  audioAttachment?: { artist?: string; title?: string }
  style?: string | string[]
}

/** One message's tail: text plus any attachment placeholders. */
export function bodyOf(m: MsgBody): string {
  let text = m.style === 'art' ? '[ART]' : (m.content ?? '')
  if (m.eightballAnswer) text += ` ${m.eightballAnswer}`
  if (m.fortuneText) text += ` ${m.fortuneText}`
  if (m.audioAttachment) {
    const a = m.audioAttachment
    text += ` [song: ${[a.artist, a.title].filter(Boolean).join(' - ')}]`
  }
  if (m.gifUrl) text += ' [GIF]'
  if (m.imageUrl) text += ' [IMG]'
  return text.trim()
}

/** Wrap spans to width; continuation lines get a hanging indent. */
export function wrapSpans(spans: Span[], width: number, indent: number): Span[][] {
  const out: Span[][] = []
  let line: Span[] = []
  let used = 0
  const pad: Span = [' '.repeat(indent), NORMAL]

  const flush = (): void => {
    if (line.length) out.push(line)
    line = [pad]
    used = indent
  }

  for (const [text, attr] of spans) {
    for (const word of text.split(/(\s+)/)) {
      if (!word) continue
      if (used + word.length > width && used > indent) flush()
      // A word longer than the line hard-breaks.
      let w = word
      while (used + w.length > width) {
        const take = width - used
        line.push([w.slice(0, take), attr])
        w = w.slice(take)
        flush()
      }
      if (w && !(w.trim() === '' && used === indent)) {
        line.push([w, attr])
        used += w.length
      }
    }
  }
  if (line.length && (line.length > 1 || line[0] !== pad)) out.push(line)
  return out.length ? out : [[]]
}

/**
 * Follow one RTDB list via REST streaming. `id === null` is the initial full
 * value (an object of id -> raw, or null for empty). An expired token renews
 * through the ApiClient and reconnects. Returns a stop function.
 */
export function followList(
  api: ApiClient,
  url: (token: string) => string,
  onEvent: (id: string | null, data: Record<string, unknown> | null, snapshot: boolean) => void,
): () => void {
  let es: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const connect = async (renew: boolean): Promise<void> => {
    const token = await api.token(renew)
    if (!token || stopped) return

    const stream = new EventSource(url(token))
    es = stream

    const retry = (expired: boolean): void => {
      if (stopped || es !== stream) return
      stream.close()
      timer = setTimeout(() => { void connect(expired) }, 2000)
    }

    const onData = (snapshot: boolean) => (e: MessageEvent): void => {
      const { path, data } = JSON.parse(e.data as string) as
        { path: string; data: Record<string, unknown> | null }
      const seg = path.replace(/^\//, '').split('/')[0]
      // id null with snapshot: the full value (object of id -> raw, or null).
      // id null without: a root patch, an object of id -> partial fields.
      if (seg === '') onEvent(null, data, snapshot)
      else onEvent(seg, data, false)
    }

    stream.addEventListener('put', onData(true))
    stream.addEventListener('patch', onData(false))
    stream.addEventListener('auth_revoked', () => retry(true))
    stream.addEventListener('cancel', () => retry(false))
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) retry(false)
    }
  }

  void connect(false)

  return () => {
    stopped = true
    es?.close()
    if (timer) clearTimeout(timer)
  }
}
