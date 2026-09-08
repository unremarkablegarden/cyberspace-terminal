// A member's card, shared by feed and globe: the bio beside the portrait,
// the facts under a rule, and the profile fetch that fills it.

import { BOLD, RULE, hangingWrap, wrap, type Span, type TextLine } from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { toProfile, type ApiUser, type FeedProfile } from './feedutil.js'

/** One fact under the bio: the head in bold on the first row, continuation rows indented under it. */
function fact(head: string, body: string, width: number): TextLine[] {
  return hangingWrap(head, body, width).map((row, i) =>
    i === 0 ? [{ text: head, attr: BOLD }, { text: row.slice(head.length) }] : row)
}

/** The profile picture's width in cells. The site shows 128px square; this is 20 cells by about 8 rows. */
export const PFP_COLS = 20
export const PFP_ROWS = 12
/** Blank between the picture and the words. */
export const PFP_GAP = 2
/** Narrowest words column worth putting a picture beside. */
const PFP_MIN_TEXT = 16

/**
 * The picture's place in a member's box: its size, and its rows once they
 * have arrived. Without rows the column is left blank at the same size, so
 * the box does not reflow when the picture lands.
 */
export interface Portrait {
  cols: number
  rows: number
  lines?: string[]
}

/** Whether a box this wide has room for the picture beside the words. */
export function portraitFits(width: number): boolean {
  return width >= PFP_COLS + PFP_GAP + PFP_MIN_TEXT
}

/**
 * A member's box: their words, then the facts under a rule. Bio paragraphs are
 * kept. With a portrait, the words sit to its right and the rule and facts run
 * full width under both.
 */
export function bioLines(p: FeedProfile, joined: string | undefined, width: number, portrait?: Portrait): TextLine[] {
  const pic = portrait && portraitFits(width) ? portrait : undefined
  const tw = pic ? width - pic.cols - PFP_GAP : width
  const out: TextLine[] = []
  if (p.displayName) out.push(...wrap(p.displayName, tw), '')
  if (p.bio) {
    for (const para of p.bio.split(/\n/)) {
      if (!para.trim()) {
        if (out[out.length - 1] !== '') out.push('')
        continue
      }
      out.push(...wrap(para, tw))
    }
  } else {
    out.push('NO BIO')
  }
  if (pic) {
    while (out.length < pic.rows) out.push('')
    for (let i = 0; i < out.length; i++) {
      const row = out[i]!
      const left = pic.lines?.[i] ?? ''
      const spans: Span[] = [{ text: left.padEnd(pic.cols) + ' '.repeat(PFP_GAP) }]
      if (typeof row === 'string') spans.push({ text: row })
      else if (Array.isArray(row)) spans.push(...row)
      out[i] = spans
    }
  }
  const facts: TextLine[] = []
  const serial = p.serial != null ? ` (#${p.serial})` : ''
  if (joined) facts.push(...fact('Joined   ', joined + serial, width))
  else if (serial) facts.push(...fact('Joined   ', serial.trim(), width))
  if (p.location) facts.push(...fact('Location ', p.location, width))
  if (p.website) facts.push(...fact('Website  ', p.website.text, width))
  if (p.guilds?.length) facts.push(...fact('Guilds   ', p.guilds.join(', '), width))
  if (facts.length) {
    if (out.length && out[out.length - 1] === '') out.pop()
    out.push(RULE, ...facts)
  }
  return out
}


/** The profile and guild names behind a card. Null when there is no such member. */
export async function fetchProfile(api: ApiClient, who: string): Promise<FeedProfile | null> {
  try {
    const path = `/v1/users/${encodeURIComponent(who)}`
    const [user, guilds] = await Promise.all([
      api.get<ApiUser>(path),
      // Names only: there is no guild page on the machine to follow them to.
      api.get<{ name?: string; role?: string }[]>(`${path}/guilds`).catch(() => []),
    ])
    const profile = toProfile(user, who)
    profile.guilds = guilds
      .filter(g => g.name)
      .map(g => g.role && g.role !== 'member' ? `${g.name} (${g.role})` : g.name!)
    return profile
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) console.error('profile failed', err)
    return null
  }
}
