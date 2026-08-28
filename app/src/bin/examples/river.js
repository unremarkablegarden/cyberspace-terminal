// The 80x25 of cells is also a 160x100 bitmap. Escape gives it back.

export default {
  name: 'river',
  description: 'a river of stars, in braille',

  async run(ctx) {
    let quit = false
    ctx.pushScreen({
      onKey: (e) => (e.key === 'Escape' ? (quit = true) : true),
    })

    const c = new ctx.tui.DotCanvas(ctx.term)

    // [x, y, speed] — fast ones read as near, slow ones as far.
    const stars = []
    for (let i = 0; i < 140; i++) {
      const speed = 0.3 + Math.random() * 2
      stars.push([Math.random() * c.w, Math.random() * c.h, speed])
    }

    try {
      while (!quit) {
        c.clear()
        for (const s of stars) {
          s[0] -= s[2]
          if (s[0] < 0) { s[0] = c.w; s[1] = Math.random() * c.h }
          // A line to itself is one dot: the only way to set one.
          c.line(s[0], s[1], s[0], s[1])
        }
        c.blit(ctx.term, ctx.attr.BRIGHT)
        await ctx.sleep(40)
      }
    } finally {
      ctx.popScreen()
    }
  },
}
