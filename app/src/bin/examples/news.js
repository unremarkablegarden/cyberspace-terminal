// Reads the real feed. ./news 5 for five of them.

export default {
  name: 'news',
  description: 'titles from the feed',

  async run(ctx, args) {
    const n = Math.min(20, Number(args[0]) || 10)

    await ctx.typeln('NEWS ' + n, ctx.attr.BRIGHT)
    const posts = await ctx.feed.page(n)

    if (!posts.length) return ctx.typeln('nothing yet', ctx.attr.DIM)

    for (const p of posts) {
      const title = p.title || '(untitled)'
      await ctx.typeln('@' + p.username)
      await ctx.typeln('  ' + title.slice(0, 70))
      const stats = p.words + ' words, ' + p.replies + ' replies'
      await ctx.typeln('  ' + stats, ctx.attr.DIM)
    }
  },
}
