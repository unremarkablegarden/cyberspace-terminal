// ./roll 2d6+1   ./roll d%

export default {
  name: 'roll',
  description: 'roll dice',

  async run(ctx, args) {
    // join('') not join(' '): "2d6 + 1" is the same as "2d6+1".
    const notation = args.join('') || 'd20'

    const result = ctx.chat.roll(notation)

    if (result.error) {
      ctx.snd.beep(220, 0.12)
      return ctx.typeln(notation + ': ' + result.error)
    }

    ctx.snd.blip(880, 0.06)
    await ctx.typeln(result.text, ctx.attr.BRIGHT)
  },
}
