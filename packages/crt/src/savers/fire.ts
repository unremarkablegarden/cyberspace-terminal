import { NORMAL, DIM, MUTED } from '../term.js'
import type { SaverSpec } from './common.js'

/**
 * A 4x4 ordered dither. Ordered rather than error-diffused, because a regular
 * screen reads as a deliberate treatment where a scattered one reads as noise.
 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/**
 * The DOOM fire effect at the beam's own resolution. Adapted from the member
 * program it began as, without the wind and douse keys, since any key on a
 * screensaver dismisses it.
 *
 * Drawn in characters this produced a bright gradient rather than a fire: over
 * 25 rows a flame starting hot never cools enough to taper, and half the beam
 * lit reads as a lamp. putGlyph avoids that, since a cell carries its own
 * bitmap and the grid is therefore cols*cellW by rows*cellH pixels, giving the
 * fire around 400 rows to die over. Heat is simulated at half resolution, to
 * bound the number of Math.random calls per frame, and dithered at full, so the
 * tone stays fine where the heat field is coarse.
 */
export const fire: SaverSpec = {
  name: 'fire', summary: 'burn it all down', fps: 30,
  make(term) {
    const { cellW, cellH } = term.font
    const W = (term.cols * cellW) >> 1, H = (term.rows * cellH) >> 1

    // Controls where the fire dies out. Mean decay is a third of a level per
    // row, so a source at 52 extinguishes about three quarters up the screen,
    // with enough variance for ragged tips.
    const MAX = 52
    const heat = new Uint8Array(W * H)

    // Sparks are not part of the original algorithm but are needed: the heat
    // field is smooth, and the motion that reads as burning comes from a few
    // elements moving faster than the rest.
    const sparks: { x: number; y: number; vy: number; life: number }[] = []

    // Maps heat to the proportion of the cell lit. At 1.7 the tips stay where
    // they are and the mid-flame drops from half lit to a third. Capped below 1
    // so even the fuel bed keeps some pixels dark, since a fully lit cell reads
    // as a solid bar.
    const TONE = new Float32Array(MAX + 1)
    for (let v = 0; v <= MAX; v++) TONE[v] = Math.min(0.8, Math.pow(v / MAX, 1.7))

    // putGlyph does not copy the bitmap it is given; the grid holds the
    // reference. The cells are therefore allocated once and rewritten in place.
    const bitmaps: Uint16Array[] = []
    for (let i = 0; i < term.cols * term.rows; i++) bitmaps.push(new Uint16Array(cellH))

    let t = 0

    return {
      frame(term) {
        t++

        // The fuel bed. A flat source produces a flat fire, so two slow sines at
        // unrelated frequencies drift the fuel along the grate, producing bright
        // columns that wander, rise further than their neighbours and collapse.
        // The floor keeps it continuous rather than a row of separate flames.
        const base = (H - 1) * W
        for (let x = 0; x < W; x++) {
          const a = Math.sin(x * 0.055 + t * 0.05)
          const b = Math.sin(x * 0.017 - t * 0.031)
          heat[base + x] = Math.round(MAX * (0.7 + 0.19 * a + 0.15 * b))
        }

        // The core algorithm. One rand call serves twice: its low bit decides
        // whether this cell cools, and its full value decides how far the flame
        // leans.
        for (let y = 1; y < H; y++) {
          const up = (y - 1) * W
          for (let x = 0; x < W; x++) {
            const v = heat[y * W + x]!
            if (!v) { heat[up + x] = 0; continue }
            const rand = (Math.random() * 3) | 0
            const dx = x - rand + 1
            if (dx < 0 || dx >= W) continue
            heat[up + dx] = v - (rand & 1)
          }
        }

        // Sparks are written into the heat field rather than drawn separately,
        // so the same dither lights them and they cool as they rise. Emitted
        // only from the hot parts of the bed, which is why they arrive in bursts.
        if (sparks.length < 24 && Math.random() < 0.5) {
          const x = (Math.random() * W) | 0
          if (heat[base + x]! > MAX * 0.75) {
            sparks.push({ x, y: H - 2, vy: 0.9 + Math.random() * 1.6, life: 1 })
          }
        }
        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i]!
          s.y -= s.vy
          s.x += (Math.random() - 0.5) * 1.4
          s.life -= 0.012
          if (s.y < 0 || s.x < 0 || s.x >= W || s.life <= 0) { sparks.splice(i, 1); continue }
          heat[(s.y | 0) * W + (s.x | 0)] = Math.min(MAX, MAX * s.life * 1.2)
        }

        // One bitmap per cell. Heat is sampled at half resolution, >>1 on both
        // axes, but thresholded at full, so the dither stays fine over a coarse
        // heat field.
        for (let cy = 0; cy < term.rows; cy++) {
          for (let cx = 0; cx < term.cols; cx++) {
            const bits = bitmaps[cy * term.cols + cx]!
            let any = 0, sum = 0

            for (let py = 0; py < cellH; py++) {
              const sy = ((cy * cellH + py) >> 1) * W
              let row = 0
              for (let px = 0; px < cellW; px++) {
                const tone = TONE[heat[sy + ((cx * cellW + px) >> 1)]!]!
                sum += tone
                if (tone > (BAYER[(py & 3) * 4 + (px & 3)]! + 0.5) / 16) {
                  row |= 1 << (cellW - 1 - px)
                }
              }
              bits[py] = row
              any |= row
            }

            if (!any) { term.put(cx, cy, 32, NORMAL); continue }
            // Three levels with NORMAL as the maximum: tone comes from how many
            // pixels are lit rather than how brightly, so the beam level only
            // indicates which part of the fire a cell belongs to.
            const mean = sum / (cellW * cellH)
            term.putGlyph(cx, cy, bits, mean > 0.62 ? NORMAL : mean > 0.3 ? MUTED : DIM)
          }
        }
      },
    }
  },
}
