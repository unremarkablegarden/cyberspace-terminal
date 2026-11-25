// A member's card on a full-screen program, shared by globe and directory:
// the bio box (bio.ts) in a TextPopup, and the actions on the member, C-Mail,
// follow and poke.

import type { Proc } from '@cyberspace/kernel'
import { DIM, TextPopup, type Rect, type ScreenStack, type Span } from '@cyberspace/tui'
import { ApiError, type ApiClient } from './api.js'
import type { ChatSound } from './chat.js'
import { bioLines, fetchProfile, loadPortrait, type BioPictures } from './bio.js'
import { when, type FeedProfile } from './feedutil.js'

/** What the card needs of the program it opens over. */
export interface CardHost {
  api: ApiClient
  proc: Proc
  snd: ChatSound
  stack: ScreenStack
  /** Region the box is centred in. */
  bounds: Rect
  pics?: BioPictures
  /** Draw the screen and send it, unless a popup is up. */
  paint(): void
  /** Redraw the footer only, under an open popup. */
  footer(): void
  /** Send the surface as it stands. */
  flush(): void
  /** Mark the whole surface for redraw, after a popup is popped. */
  invalidate(): void
  /** The program's status line. '' clears it; 'LOADING' is drawn with a spinner. */
  status(text: string): void
  /** False once the program has exited. */
  live(): boolean
}

/** The member an action applies to. userId is absent on a profile without one. */
export interface Member {
  username: string
  userId?: string
}

/** Pages of the caller's following list read. 50 a page; a member past them is taken as not followed. */
const FOLLOW_PAGES = 10
/** Narrowest and widest card, in cells. */
const CARD_MIN = 24
const CARD_MAX = 56

const HINT_MAIL: Span[] = [{ text: ' C ', inverse: true, attr: DIM }, { text: ' C-Mail ' }]
const HINT_POKE: Span[] = [{ text: ' P ', inverse: true, attr: DIM }, { text: ' Poke ' }]
const HINT_CLOSE: Span[] = [{ text: ' ESC ', inverse: true, attr: DIM }, { text: ' Close ' }]
const hintFollow = (following: boolean | undefined): Span[] =>
  [{ text: ' F ', inverse: true, attr: DIM }, { text: following === undefined ? ' ... ' : following ? ' Unfollow ' : ' Follow ' }]

const failure = (err: unknown): string =>
  err instanceof ApiError ? (err.code === 'NO_CARRIER' ? 'NO CARRIER' : err.message.toUpperCase()) : 'ERROR'

export class MemberCard {
  /** The open card, while there is one. */
  card: { profile: FeedProfile; popup: TextPopup } | undefined
  /** userIds the caller follows. Undefined until the list is read. */
  private follows: Set<string> | undefined
  private reading: Promise<void> | undefined
  /** Members poked in this run: one poke each, whatever the server would allow. */
  private poked = new Set<string>()
  private loading = false

  constructor(private h: CardHost) {}

  /** Whether the caller follows this member. Undefined while the list is unread. */
  following(m: Member | undefined): boolean | undefined {
    return m?.userId && this.follows ? this.follows.has(m.userId) : undefined
  }

  /**
   * Read the caller's following list, once per run. The API has no flag for
   * a single member, so the list is paged through up to FOLLOW_PAGES.
   */
  readFollowing(): Promise<void> {
    if (!this.h.api.authed) return Promise.resolve()
    this.reading ??= (async () => {
      const ids = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < FOLLOW_PAGES; page++) {
        const res: { rows: { followedId?: string }[]; cursor: string | null } =
          await this.h.api.page<{ followedId?: string }>(`/v1/follows?type=following&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        for (const r of res.rows) if (r.followedId) ids.add(r.followedId)
        cursor = res.cursor
        if (!cursor) break
      }
      this.follows = ids
    })().catch(() => { this.reading = undefined })
    return this.reading
  }

  /** Footer groups for a member: the actions, and Close while the card is open. */
  hints(m: Member | undefined): Span[][] {
    const open = this.card !== undefined
    if (!this.h.api.authed) return open ? [HINT_CLOSE] : []
    return [HINT_MAIL, hintFollow(this.following(m)), HINT_POKE, ...(open ? [HINT_CLOSE] : [])]
  }

  /** An action's result, in the card's rule. Dropped when the card has closed meanwhile. */
  private report(text: string): void {
    if (!this.card) return
    this.card.popup.say(text)
    this.h.flush()
  }

  /** Redraw the footer under the card, which shows the follow state. */
  private refresh(): void {
    if (!this.card) return
    this.h.footer()
    this.h.flush()
  }

  async toggleFollow(m: Member): Promise<void> {
    const { api, snd } = this.h
    const was = this.following(m)
    if (was === undefined || !this.follows) { snd.beep(220, 0.04); return }
    const them = m.userId
    if (!them || them === api.userId) { snd.beep(220, 0.12); this.report(them ? 'THAT IS YOU' : 'NO ID'); return }
    snd.tick()
    try {
      if (was) {
        await api.delete(`/v1/follows/${encodeURIComponent(`${api.userId}_${them}`)}`)
        this.follows.delete(them)
        this.report('UNFOLLOWED')
      } else {
        await api.post('/v1/follows', { followedId: them })
        this.follows.add(them)
        this.report('FOLLOWING')
      }
      snd.blip(520, 0.09, 0)
    } catch (err) {
      // The list was stale or truncated; the error says what the state is.
      if (err instanceof ApiError && err.status === 409) this.follows.add(them)
      else if (err instanceof ApiError && err.status === 404 && was) this.follows.delete(them)
      snd.beep(220, 0.12)
      this.report(failure(err))
    }
    this.refresh()
  }

  async poke(m: Member): Promise<void> {
    const { api, snd } = this.h
    if (this.poked.has(m.username)) { snd.beep(220, 0.12); this.report('ALREADY POKED'); return }
    snd.tick()
    try {
      await api.post(`/v1/users/${encodeURIComponent(m.username)}/poke`, {})
      this.poked.add(m.username)
      snd.blip(520, 0.09, 0)
      this.report('POKED')
    } catch (err) {
      snd.beep(220, 0.12)
      this.report(failure(err))
    }
  }

  /**
   * C-Mail with the member: any card closes and the shell is asked to run
   * cmail as its own job. The program is stopped by the switch and comes back
   * through the switcher or its name. Under a shell without job control
   * there is nothing to switch to.
   */
  mail(m: Member): void {
    const { proc, snd, stack } = this.h
    if (this.card) {
      this.card = undefined
      stack.pop()
      this.h.invalidate()
    }
    if (!proc.kernel.jobs.fg) {
      this.h.status('cmail: no job control')
      snd.beep(220, 0.12)
      this.h.paint()
      return
    }
    void proc.kernel.jobs.switchTo({ launch: `cmail @${m.username}` })
  }

  /** The member's card, as feed's B box: bio beside the portrait, facts under a rule. */
  async open(username: string): Promise<void> {
    const { api, snd, stack, bounds } = this.h
    if (this.loading || this.card) return
    this.loading = true
    this.h.status('LOADING')
    this.h.paint()
    snd.tick()
    const profile = await fetchProfile(api, username)
    this.loading = false
    if (!this.h.live() || stack.active) return
    this.h.status('')
    if (!profile) {
      this.h.status('NO PROFILE')
      snd.beep(220, 0.12)
      this.h.paint()
      return
    }
    const width = Math.max(CARD_MIN, Math.min(CARD_MAX, bounds.w - 10))
    const portrait = await loadPortrait(this.h.pics, profile, width)
    if (!this.h.live() || stack.active) return
    const member: Member = { username: profile.username, userId: profile.userId }
    const site = profile.website?.url
    const popup: TextPopup = new TextPopup({
      title: `@${profile.username}`,
      note: profile.badges.length
        ? profile.badges.flatMap((b, i): Span[] => [
          ...(i ? [{ text: ' ' }] : []),
          { text: ` ${b} `, inverse: true, attr: DIM },
        ])
        : undefined,
      lines: bioLines(profile, profile.joined ? when(profile.joined) : undefined, width, portrait),
      // The card's other keys are on the program's footer beneath, see hints().
      hint: site ? 'L Link' : undefined,
      actions: [
        ...(site ? [{ key: 'l', silent: true, run: () => { this.h.proc.tty?.copy(site); popup.say('COPIED'); this.h.flush() } }] : []),
        ...(api.authed ? [
          { key: 'c', silent: true, run: () => this.mail(member) },
          { key: 'f', silent: true, run: () => { void this.toggleFollow(member) } },
          { key: 'p', silent: true, run: () => { void this.poke(member) } },
        ] : []),
      ],
      bounds,
      shadow: true,
      onFeedback: kind => {
        if (kind === 'edge') snd.beep(220, 0.04)
        else if (kind === 'move') snd.tick()
      },
      onDone: () => {
        this.card = undefined
        stack.pop()
        snd.blip(390, 0.07, 0)
        this.h.invalidate()
        this.h.paint()
      },
    })
    // The screen is drawn before the push, so the snapshot beneath carries the card's footer.
    this.card = { profile, popup }
    this.h.paint()
    stack.push(popup)
    this.h.flush()
    snd.blip(520, 0.09, 0)
    if (this.follows === undefined) {
      const mine = this.card
      void this.readFollowing().then(() => { if (this.card === mine) this.refresh() })
    }
  }
}
