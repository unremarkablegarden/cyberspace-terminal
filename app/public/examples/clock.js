// Takes the whole grid. Escape or Ctrl-C gives it back.

export default {
  name: 'clock',
  description: 'the time, in a box',

  async run(ctx) {
    let quit = false

    // A screen is any object with onKey. Returning true means
    // "handled".
    ctx.pushScreen({
      onKey: (e) => (e.key === 'Escape' ? (quit = true) : true),
    })

    const term = ctx.term
    const w = 24
    const box = { x: (term.cols - w) >> 1, y: 10, w, h: 5 }
    const full = { x: 0, y: 0, w: term.cols, h: term.rows }

    try {
      while (!quit) {
        ctx.tui.clear(term, full)
        // frame() draws the border and returns the inside of it.
        const inner = ctx.tui.frame(term, box, ctx.attr.DIM, 'double')
        // label() puts a blank either side, so the text is bare.
        ctx.tui.label(term, box, 'CLOCK', { attr: ctx.attr.DIM })

        const now = new Date().toLocaleTimeString()
        const x = inner.x + ((inner.w - now.length) >> 1)
        term.text(x, inner.y + 1, now, ctx.attr.BRIGHT)

        await ctx.sleep(250)
      }
    } finally {
      // Always. Ctrl-C throws out of sleep(), and a screen left
      // on the stack would still own the keyboard.
      ctx.popScreen()
    }
  },
}
