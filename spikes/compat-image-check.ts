// A compat program halftones a luma plane and draws it as picture handles.
// Run: bun spikes/compat-image-check.ts
import { Kernel } from '../packages/kernel/src/kernel.ts'
import { Tty } from '../packages/kernel/src/tty.ts'
import { runGridProgram } from '../packages/compat/src/host.ts'
import { pictureHost, pictureSlots, pictureBits } from '../app/src/image.ts'
import { PICT_LO, PICT_HI } from '../packages/tui/src/pict.ts'

let fail = 0
const eq = (label: string, got: unknown, want: unknown): void => {
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}
const isPict = (s: string) => [...s].every(c => { const n = c.codePointAt(0)!; return n >= PICT_LO && n <= PICT_HI })

// A noise plane: every cell rasterises to a different bitmap, so slot counts are exact.
const noise = (w: number, h: number) => {
  let seed = 7
  const data = new Float32Array(w * h)
  for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = (seed % 1000) / 1000 }
  return { w, h, data }
}

const term = { font: { cellW: 8, cellH: 16 }, advance: 9, stretch: 1.34 }

// Range API: a range at the top of the bank, bitmaps assigned by the owner.
{
  const host = pictureHost(term)
  eq('metrics stretch', host.metrics().stretch, 1.34)
  const r = host.range(4096)!
  eq('range granted', r.count, 4096)
  eq('range at the top', r.base + r.count, PICT_HI + 1)
  eq('reserved slots are not live', pictureSlots(), 0)
  const bits = new Uint16Array(16).fill(0xff)
  host.set([r.base, r.base + 1], [bits, bits])
  eq('set assigns inside the range', pictureBits(r.base) === bits, true)
  host.set([PICT_LO], [bits])
  eq('set ignores outside the range', pictureBits(PICT_LO), undefined)
  const other = pictureHost(term)
  eq('a second range fits below', other.range(1024)?.base, r.base - 1024)
  other.release()
  eq('picture below the range still fits', other.range(1024)?.base, r.base - 1024)
  other.release()
  host.release()
  eq('release clears the range', pictureBits(r.base), undefined)
  eq('release returns the slots', host.range(6400) !== undefined, true)
  host.release()
}

// Through the compat host: ctx.tui.fitImage + halftone(...).draw with a clip.
{
  const kernel = new Kernel()
  let out = ''
  const tty = new Tty(d => { out += new TextDecoder().decode(d) }, 40, 12)
  let released = false
  let sets = 0
  const run = runGridProgram({
    pictures: () => {
      const h = pictureHost(term)
      return {
        metrics: () => h.metrics(), range: n => h.range(n),
        set: (c, b) => { sets++; h.set(c, b) },
        release: () => { released = true; h.release() },
      }
    },
  })
  const seen: Record<string, unknown> = {}
  const program = {
    async run(ctx: any) {
      seen.fit = ctx.tui.fitImage(160, 80, new ctx.tui.DotCanvas(ctx.term, 1, 1).aspect, 20, 10)
      seen.aspect = new ctx.tui.DotCanvas(ctx.term, 1, 1).aspect
      const block = ctx.tui.halftone(ctx.term, noise(160, 80), 6, 3)
      ctx.pushScreen({ draw() {} })
      block.draw(ctx.term, 2, 1, ctx.attr.BRIGHT, { x: 0, y: 0, w: 40, h: 3 })
      const g = ctx.term
      // Frames larger than the range: every frame draws, the oldest are evicted and redraw.
      const frames = Array.from({ length: 12 }, (_, i) => ctx.tui.halftone(ctx.term, noise(1600 + i, 400), 100, 25))
      const setsBefore = sets
      for (const f of frames) f.draw(ctx.term, 0, 5)
      seen.frameSets = sets - setsBefore
      frames[0].draw(ctx.term, 0, 5)
      seen.reSet = sets - setsBefore
      const huge = ctx.tui.halftone(ctx.term, noise(4000, 1000), 200, 30)
      const before = sets
      huge.draw(ctx.term, 0, 5)
      seen.hugeSets = sets - before
      block.draw(ctx.term, 2, 1, ctx.attr.BRIGHT, { x: 0, y: 0, w: 40, h: 3 })
      seen.row1 = String.fromCodePoint(...Array.from(g.chars.slice(1 * 40 + 2, 1 * 40 + 8)))
      seen.row3 = String.fromCodePoint(...Array.from(g.chars.slice(3 * 40 + 2, 3 * 40 + 8)))
      seen.attr = g.attrs[1 * 40 + 2]
      await ctx.sleep(60)
      ctx.popScreen()
    },
  }
  const task = kernel.spawn((p: any) => run(p, program), {
    argv: ['galz'], env: {}, cwd: '/', stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stdout, tty,
  })
  const code = await task.wait
  eq('exit 0', code, 0)
  eq('fitImage keeps aspect', (seen.fit as any).rows <= 10 && (seen.fit as any).cols === 20, true)
  eq('aspect uses face stretch', Math.abs((seen.aspect as number) - (4 / 4.5) * 1.34) < 1e-6, true)
  eq('every frame sent bitmaps', seen.frameSets, 12)
  eq('evicted frame is sent again', seen.reSet, 13)
  eq('a block over the range never draws', seen.hugeSets, 0)
  eq('drawn row inside clip is handles', isPict(seen.row1 as string), true)
  eq('row past clip untouched', seen.row3, '      ')
  eq('attr carried', seen.attr, 1)
  eq('handles reached the pty', /[-]/.test(out), true)
  eq('released on exit', released, true)
  eq('bank empty after run', pictureSlots(), 0)
}

console.log(fail ? `${fail} FAILED` : 'all ok')
process.exit(fail ? 1 : 0)
