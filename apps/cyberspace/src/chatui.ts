// Shared furniture for the chat programs: span wrapping, timestamps,
// attachment placeholders, and the RTDB REST live stream.

import { NORMAL, plain } from '@cyberspace/tui'
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
  audioAttachment?: { artist?: string; title?: string; genre?: string }
  style?: string | string[]
}

/** A style arrives as one name or a chain of them. */
export const hasStyle = (style: string | string[] | undefined, name: string): boolean =>
  Array.isArray(style) ? style.includes(name) : style === name

/**
 * One message's body: its text plus any attachment placeholders.
 *
 * `drawn` lists what the caller renders itself. An attachment the screen is
 * about to draw must not also be named in the text, or it appears twice; the
 * name is the fallback for attachments that cannot be shown.
 *
 * Folded to one cell per character on the way out, because an emoji occupies
 * two cells here and one on the parser's side, which would misalign the row
 * permanently. See plain.ts.
 */
export interface BodyDrawn {
  /** The screen halftones `imageUrl` itself. */
  image?: boolean
  /** The screen lays the art out itself. */
  art?: boolean
}

export function bodyOf(m: MsgBody, drawn: BodyDrawn = {}): string {
  const art = hasStyle(m.style, 'art')
  if (art && drawn.art) return ''
  let text = art ? '[ART]' : (m.content ?? '')
  // The API writes these into the content as well as into the field.
  if (m.eightballAnswer && !text.includes(m.eightballAnswer)) text += ` ${m.eightballAnswer}`
  if (m.fortuneText && !text.includes(m.fortuneText)) text += ` ${m.fortuneText}`
  if (m.audioAttachment) {
    const a = m.audioAttachment
    const name = [a.artist, a.title].filter(Boolean).join(' - ')
    text += ` [SONG: ${name}${a.genre ? ` (${a.genre})` : ''}]`
  }
  if (m.gifUrl) text += ' [GIF]'
  // An attachment posted without a caption carries its own address as the body.
  // The picture stands for it; the address is never read out.
  if (m.imageUrl && text.trim() === m.imageUrl) text = ''
  if (m.imageUrl && !drawn.image) text += ' [IMG]'
  return plain(text.trim())
}

/**
 * The rows of an `/art` message.
 *
 * Art is drawn against a fixed width and carried as base64 in `content` rather
 * than as text, so it must not be wrapped, reflowed or folded. Rows wider than
 * the pane are truncated.
 */
export function artLines(m: MsgBody): string[] | undefined {
  if (!hasStyle(m.style, 'art') || !m.content) return undefined
  let text: string
  try {
    text = atob(m.content)
  } catch {
    // Not valid base64. Show the raw line rather than an empty message.
    return m.content.split('\n')
  }
  return text.replace(/\r/g, '').split('\n')
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
      // A word longer than the line is hard-broken.
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
