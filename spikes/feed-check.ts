// Feed markdown parser, mappers, filter and the draft store.
// Run: bun spikes/feed-check.ts
import { toBlocks, toEntry, toReply, keep, splitImage, countWords, parseTopicLine, when } from '../apps/cyberspace/src/feedutil.ts'
import { FeedDrafts } from '../apps/cyberspace/src/feeddraft.ts'
import type { PostDraft } from '../apps/cyberspace/src/feedutil.ts'

let fail = 0
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  const ok = g === w
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n      got  ${g}\n      want ${w}`}`)
}

eq('plain paragraph', toBlocks('hello world'), ['hello world'])
eq('two paragraphs', toBlocks('a\n\nb'), ['a', 'b'])
eq('link offsets', toBlocks('see [the site](https://x.io) now'),
  [{ text: 'see the site now', links: [{ at: 4, len: 8, url: 'https://x.io' }] }])
eq('fence kept', toBlocks('intro\n```\nlet x = 1\n\n  y\n```\nafter'), ['intro', { code: ['let x = 1', '', '  y'] }, 'after'])
eq('unclosed fence', toBlocks('```\ncode'), [{ code: ['code'] }])
eq('list', toBlocks('- a\n- b\n  - c\n1. one\n2. two'),
  [{ list: [{ text: 'a' }, { text: 'b' }, { text: 'c', depth: 1 }, { text: 'one', n: 1 }, { text: 'two', n: 2 }] }])
eq('quote', toBlocks('> q1\n> q1b\n>\n> q2'), [{ quote: [{ text: 'q1 q1b', links: undefined, depth: 1 }, { text: '', depth: 1 }, { text: 'q2', links: undefined, depth: 1 }] }])
eq('rule', toBlocks('a\n\n---\n\nb'), ['a', { rule: true }, 'b'])
eq('setext not rule', toBlocks('Title\n---'), ['Title'])
eq('image still in text', toBlocks('x ![alt](https://a/b.png) y'), ['x [IMG] y'])
eq('bold stripped', toBlocks('**bold** and _it_'), ['bold and it'])
eq('nested label', toBlocks('[[wiki]](https://w)'), [{ text: '[wiki]', links: [{ at: 0, len: 6, url: 'https://w' }] }])

eq('splitImage inline', splitImage({}, 'a\n![p](https://img/x.png)\nb'), { src: 'https://img/x.png', rest: 'a\n\nb' })
eq('splitImage attachment', splitImage({ attachments: [{ type: 'image', src: 'https://i/a.jpg' }] }, 'c'), { src: 'https://i/a.jpg', rest: 'c' })
eq('splitImage http refused', splitImage({}, '![p](http://img/x.png)'), { rest: '![p](http://img/x.png)' })

eq('countWords', countWords('one [two](https://x) **three**'), 3)
eq('parseTopicLine', parseTopicLine('Hard-Ware!, music, music, a, b'), ['hard ware', 'music', 'a'])

const entry = toEntry({
  postId: 'p1', authorId: 'u1', authorUsername: 'bob', content: 'hi ![x](https://i/a.png)\n\nmore',
  title: 't', topics: ['a'], repliesCount: 2, bookmarksCount: 0, isNSFW: false, createdAt: '2026-09-07T10:00:00.000Z',
  attachments: [{ type: 'audio', src: 'dQw4w9WgXcQ', artist: 'A', title: 'B' }],
})
eq('toEntry', { ...entry, at: entry.at > 0 }, {
  id: 'p1', username: 'bob', title: 't', body: ['hi', 'more', { text: '[SONG: A - B]', links: [{ at: 0, len: 13, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] }],
  at: true, topics: ['a'], words: 3, replies: 2, bookmarks: 0, image: 'https://i/a.png', nsfw: undefined,
})
const reply = toReply({ replyId: 'r1', authorUsername: 'amy', content: 'yo', parentReplyId: 'r0', parentReplyAuthor: 'bob', createdAt: '2026-09-07T10:00:00.000Z' })
eq('toReply', { ...reply, at: reply.at > 0 }, { id: 'r1', username: 'amy', body: ['yo'], at: true, image: undefined, parentId: 'r0', parentUsername: 'bob' })

const f = { hidden: new Set(['u9']), nsfw: false, guilds: false }
eq('keep hidden', keep({ postId: 'x', authorId: 'u9' }, f), false)
eq('keep nsfw', keep({ postId: 'x', isNSFW: true }, f), false)
eq('keep guild', keep({ postId: 'x', isGuildThread: true }, f), false)
eq('keep ok', keep({ postId: 'x', authorId: 'u1' }, f), true)
eq('when today', /^\d\d:\d\d$/.test(when(Date.now())), true)
eq('when old', when(Date.parse('2024-01-02T03:04:05Z')), '2024-01-02')

// --- the draft store ----------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000
const draft = (body: string): PostDraft => ({ title: '', body, topics: '', blog: false, nsfw: false, vent: false })

/** A store, and a clock the test moves by hand. */
function slot(initial: string | null = null) {
  let v = initial
  let t = Date.parse('2026-09-10T12:00:00Z')
  return {
    store: { get: () => v, set: (next: string | null) => { v = next } },
    raw: () => v,
    blob: () => (v ? JSON.parse(v) : null),
    at: (days: number) => { t += days * DAY },
    now: () => t,
  }
}

{
  const s = slot()
  const d = new FeedDrafts(s.store, 'me', s.now)
  d.setPost(draft('half a post'))
  d.setReply('p1', { text: 'half a reply', parentId: 'r1', parentUsername: 'bob' })
  eq('nothing written before the flush', s.raw(), null)
  d.flush()
  eq('post kept', d.post()?.body, 'half a post')
  eq('reply kept', d.reply('p1')?.text, 'half a reply')
  eq('parent kept', d.reply('p1')?.parentUsername, 'bob')

  const back = new FeedDrafts(s.store, 'me', s.now)
  eq('post read back', back.post()?.body, 'half a post')
  eq('reply read back', back.reply('p1')?.text, 'half a reply')
  eq('a member with no draft has none', back.reply('p9'), null)
}

{
  const s = slot()
  const d = new FeedDrafts(s.store, 'me', s.now)
  d.setPost(draft('gone in a moment'))
  d.flush()
  eq('another member sees nothing', new FeedDrafts(s.store, 'you', s.now).post(), null)
  eq('a guest sees nothing', new FeedDrafts(s.store, '', s.now).post(), null)
}

{
  const s = slot('not json at all')
  eq('a malformed blob is dropped', new FeedDrafts(s.store, 'me', s.now).post(), null)
  const wrong = slot(JSON.stringify({ v: 99, user: 'me', post: { at: Date.now(), d: draft('x') }, replies: {} }))
  eq('another version is dropped', new FeedDrafts(wrong.store, 'me', wrong.now).post(), null)
}

{
  const s = slot()
  const d = new FeedDrafts(s.store, 'me', s.now)
  d.setPost(draft('written today'))
  d.setReply('p1', { text: 'also today' })
  d.flush()
  s.at(31)
  const old = new FeedDrafts(s.store, 'me', s.now)
  eq('a post older than 30 days is dropped', old.post(), null)
  eq('a reply older than 30 days is dropped', old.reply('p1'), null)
}

{
  const s = slot()
  const d = new FeedDrafts(s.store, 'me', s.now)
  d.setPost(draft(''))
  d.flush()
  eq('an empty post is not kept', s.raw(), null)
  d.setReply('p1', { text: '   ' })
  d.flush()
  eq('a blank reply is not kept', s.raw(), null)
}

{
  const s = slot()
  const d = new FeedDrafts(s.store, 'me', s.now)
  for (let i = 0; i < 14; i++) { d.setReply(`p${i}`, { text: `reply ${i}` }); s.at(1) }
  d.flush()
  const kept = Object.keys(s.blob().replies).sort()
  eq('ten replies kept', kept.length, 10)
  eq('the oldest four are gone', kept.includes('p0') || kept.includes('p3'), false)
  eq('the newest is kept', kept.includes('p13'), true)
}

{
  const s = slot()
  const d = new FeedDrafts(s.store, 'me', s.now)
  d.setPost(draft('the entry survives'))
  for (let i = 0; i < 4; i++) d.setReply(`p${i}`, { text: 'x'.repeat(40_000) })
  d.flush()
  eq('the blob is under the cap', s.raw()!.length < 128 * 1024, true)
  eq('the entry is the last to go', s.blob().post.d.body, 'the entry survives')
}

{
  const s = slot()
  const d = new FeedDrafts(s.store, 'me', s.now)
  d.setPost(draft('typed then thrown away'))
  d.flush()
  d.setPost(null)
  d.flush()
  eq('clearing the last draft empties the store', s.raw(), null)
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
