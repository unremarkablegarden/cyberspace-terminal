// Feed markdown parser, mappers and filter. Run: bun spikes/feed-check.ts
import { toBlocks, toEntry, toReply, keep, splitImage, countWords, parseTopicLine, when } from '../apps/cyberspace/src/feedutil.ts'

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

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
