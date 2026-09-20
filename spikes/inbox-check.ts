// Checks the notification tables and the polling service against a fake api.
// Run: bun spikes/inbox-check.ts

import { readFileSync } from 'node:fs'
import { InboxService, noticeTarget, noticeText, openLine, type Notice } from '../apps/cyberspace/src/inbox'
import type { ApiClient } from '../apps/cyberspace/src/api'

let failed = 0
const ok = (label: string, cond: boolean, extra?: unknown): void => {
  if (!cond) failed++
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`)
}

const n = (over: Partial<Notice>): Notice => ({
  id: 'n1', type: 'poke', actorUsername: 'bob', read: false, createdAt: '2026-09-20T10:00:00.000Z', ...over,
})

// Every type the API accepts has wording of its own.
const constants = readFileSync(new URL('../../cyberspace-api/src/lib/constants.ts', import.meta.url), 'utf8')
const block = constants.slice(constants.indexOf('NOTIFICATION_TYPES = new Set(['))
const types = [...block.slice(0, block.indexOf('])')).matchAll(/'([a-z_]+)'/g)].map(m => m[1]!)
ok('type list read from the API', types.length >= 30, types.length)
for (const type of types) {
  const text = noticeText(n({ type, reason: 'r' }))
  ok(`text: ${type}`, !text.includes('interacted with you') && !text.includes('undefined'), text)
}
ok('text: unknown type falls back', noticeText(n({ type: 'nope' })) === '@bob interacted with you')
ok('text: poke', noticeText(n({})) === '@bob poked you')
ok('text: chat room', noticeText(n({ type: 'chat_mention', targetId: 'lobby' })) === '@bob mentioned you in #lobby')
ok('text: system has no actor', noticeText(n({ type: 'system_ban_lifted', actorUsername: 'system' })) === 'Ban lifted.')

const target = (over: Partial<Notice>): string | null => noticeTarget(n(over))
ok('target: reply', target({ type: 'reply', targetId: 'P', metadata: { replyId: 'R' } }) === 'feed -p P R')
ok('target: thread_reply', target({ type: 'thread_reply', targetId: 'P', targetType: 'reply', metadata: { replyId: 'R' } }) === 'feed -p P R')
ok('target: reply_mention', target({ type: 'reply_mention', targetId: 'X', metadata: { postId: 'P', replyId: 'R' } }) === 'feed -p P R')
ok('target: bookmark post', target({ type: 'bookmark', targetId: 'P', targetType: 'post' }) === 'feed -p P')
ok('target: bookmark reply needs a lookup', target({ type: 'bookmark', targetId: 'R', targetType: 'reply' }) === null)
ok('target: post_mention', target({ type: 'post_mention', targetId: 'P' }) === 'feed -p P')
ok('target: new post', target({ type: 'new_post_friend', targetId: 'P' }) === 'feed -p P')
ok('target: guild thread', target({ type: 'guild_new_thread', targetId: 'P', metadata: { threadId: 'T' } }) === 'feed -p T')
ok('target: follower', target({ type: 'new_follower' }) === 'feed @bob')
ok('target: poke', target({}) === 'feed @bob')
ok('target: chat', target({ type: 'chat_mention', targetId: 'lobby' }) === 'circ lobby')
ok('target: mail', target({ type: 'dm_message', targetId: 'c1' }) === 'cmail @bob')
ok('target: graffiti', target({ type: 'graffiti_mention', targetId: 'graffiti' }) === null)
ok('target: system', target({ type: 'system_ban' }) === null)

// The service.
interface Fake { count: number; rows: Notice[]; fail: boolean; calls: string[] }
const prefs: { notifications: Record<string, boolean>; muted: string[] } = { notifications: {}, muted: [] }
const fake: Fake = { count: 0, rows: [], fail: false, calls: [] }
const api = {
  authed: true,
  userId: null,
  async get(path: string) {
    fake.calls.push(path)
    if (fake.fail) throw Object.assign(new Error('NO CARRIER'), { status: 0 })
    if (path.startsWith('/v1/replies/')) return { postId: 'P9' }
    if (path === '/v1/settings') return { notifications: prefs.notifications }
    if (path === '/v1/users/me') return { mutedUsers: prefs.muted, blockedUsers: [] }
    return { count: fake.count }
  },
  async page(path: string) {
    fake.calls.push(path)
    return { rows: fake.rows, cursor: null }
  },
} as unknown as ApiClient

ok('openLine resolves a reply bookmark',
  await openLine(api, n({ type: 'bookmark', targetId: 'R', targetType: 'reply' })) === 'feed -p P9 R')

let clock = 1_000_000
const notices: Notice[] = []
let counts = 0
let mailFront = false
const svc = new InboxService(api, 'https://rtdb.invalid', {
  onNotice: x => notices.push(x),
  onCounts: () => counts++,
  mailInFront: () => mailFront,
}, () => clock)

const at = (s: number): string => new Date(Date.UTC(2026, 8, 20, 10, 0, s)).toISOString()

fake.count = 2
fake.rows = [n({ id: 'b', createdAt: at(2) }), n({ id: 'a', createdAt: at(1) })]
await svc.poll()
ok('first poll announces nothing', notices.length === 0 && svc.count === 2, notices)

await svc.poll()
ok('steady count fetches no list', fake.calls.filter(c => c.startsWith('/v1/notifications?')).length === 1, fake.calls)

fake.count = 4
fake.rows = [n({ id: 'd', createdAt: at(4) }), n({ id: 'c', createdAt: at(3) }), ...fake.rows]
await svc.poll()
ok('a rise announces only the new rows, oldest first', notices.map(x => x.id).join() === 'c,d', notices.map(x => x.id))

fake.count = 1
await svc.poll()
ok('a fall announces nothing', notices.length === 2 && svc.count === 1)

svc.seen()
ok('seen() lowers the count', svc.count === 0)

fake.fail = true
const polls = (): number => fake.calls.filter(c => c.endsWith('/unread-count')).length
const before = polls()
await svc.poll()
await svc.poll()
ok('a network failure holds the next poll', polls() === before + 1, polls() - before)
clock += 5 * 60_000 + 1
fake.fail = false
await svc.poll()
ok('the hold ends after five minutes', polls() === before + 2)

// C-Mail events, shaped as the RTDB stream delivers them.
const mail = (svc as unknown as {
  mailEvent(id: string | null, data: unknown, snapshot: boolean, rest: string[]): void
}).mailEvent.bind(svc)
notices.length = 0
mail(null, { c1: { otherUsername: 'carol', unreadCount: 2 }, c2: { otherUsername: 'dave', unreadCount: 0 } }, true, [])
ok('snapshot sets the mail count without a notice', svc.mail === 2 && notices.length === 0)

mail(null, { 'c2/otherUsername': 'dave', 'c2/unreadCount': 1, 'c2/lastMessage': 'hi' }, false, [])
ok('a root patch of field paths raises a notice', svc.mail === 3 && notices.length === 1 && noticeText(notices[0]!) === '@dave sent you a C-Mail', notices)
ok('the notice opens the conversation', noticeTarget(notices[0]!) === 'cmail @dave')

mail('c1', 3, false, ['unreadCount'])
ok('a field event raises a notice', svc.mail === 4 && notices.length === 2 && notices[1]!.actorUsername === 'carol')

mail('c1', 0, false, ['unreadCount'])
ok('a read conversation lowers the count quietly', svc.mail === 1 && notices.length === 2)

mailFront = true
mail('c1', 1, false, ['unreadCount'])
ok('no notice while cmail is in front', svc.mail === 2 && notices.length === 2)

mail('c3', { otherUsername: 'erin', unreadCount: 1 }, false, [])
mailFront = false
mail('c3', null, false, [])
ok('a removed conversation leaves the count', svc.mail === 2, svc.mail)

// The member's switches, as read from the settings.
const loadPrefs = (svc as unknown as { loadPrefs(): Promise<void> }).loadPrefs.bind(svc)
prefs.muted = ['u-mallory']
await loadPrefs()
const had = notices.length
mail('c4', { otherUserId: 'u-mallory', otherUsername: 'mallory', unreadCount: 1 }, false, [])
ok('no notice from a muted member, the count kept', notices.length === had && svc.mail === 3, svc.mail)
prefs.notifications = { dm_message: false }
await loadPrefs()
mail('c1', 5, false, ['unreadCount'])
ok('no C-Mail notice with the type switched off', notices.length === had)
prefs.notifications = {}
await loadPrefs()
mail('c1', 6, false, ['unreadCount'])
ok('and one again with it back on', notices.length === had + 1)

svc.stop()
ok('stop clears the counts', svc.total === 0 && counts > 0)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
