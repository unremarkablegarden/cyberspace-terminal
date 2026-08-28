// A program is an export default with a run(). Everything you can
// reach arrives on ctx — nothing is imported.

export default {
  name: 'hello',
  description: 'says hello, slowly',

  async run(ctx, args) {
    const who = args[0] || ctx.username

    ctx.setBaud(1200)
    await ctx.typeln('HELLO, ' + who.toUpperCase(), ctx.attr.BRIGHT)
    await ctx.sleep(300)

    // Every await here throws if Ctrl-C is pressed, which is
    // what ends the program. Nothing to catch.
    for (let i = 3; i > 0; i--) {
      await ctx.typeln(i + '...', ctx.attr.DIM)
      await ctx.sleep(400)
    }

    ctx.snd.blip(880, 0.08)
    await ctx.typeln('...and that is a program.')
  },
}
