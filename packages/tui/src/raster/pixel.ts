// Draws an image as pixels rather than as characters.
//
// A cell can carry its own bitmap in the CRT's gfx plane, so the image is
// written to the beam framebuffer at the framebuffer's resolution rather than
// at a glyph vocabulary's: 8x16 samples per cell in the 8x16 face, against 2x4
// for a dot grid. Sixteen times the samples, with less code.
//
// Because the result is the same beam byte the text produces, the bloom,
// scanlines, phosphor and curvature apply to the image as they do to text; it
// is not composited over the terminal.
//
// The one-bit decision is taken from the website's ImageRaster.vue, so an image
// in circ and the same image in the feed are screened identically: an 8x8 Bayer
// matrix with a little value noise mixed in, with `dither` sliding the
// threshold between a flat 0.5 and that. Ordered rather than error-diffused,
// because a regular screen reads as a deliberate treatment where
// Floyd-Steinberg's scattering does not. The noise prevents the regularity
// forming visible cross-hatching.
//
// Two deviations from the shader, both forced. It takes Rec.601 luma from RGB
// and this receives a Rec.709 plane. Its bitDepth term is dropped: with
// `dither` at 0.75 the quantised term it blends can never cross the halfway
// point alone, so it has no effect on a one-bit output, where there are no
// intermediate values to interpolate.

import { DIM } from '../attrs.js'
import { resample, tone, unsharp, sampleAspect } from './prep.js'
import type { Raster, RasterOptions } from './index.js'

/**
 * ImageRaster.vue's defaults, kept rather than retuned, so this matches what the
 * website does to the same image.
 *
 * sharpen is the exception and is off. The web renders at 512px where detail is
 * available; this works at a few hundred samples, where the box filter is
 * destructive enough to justify sharpening, but ImageRaster does not do it and
 * this version stays faithful.
 */
const DEFAULTS = {
  // The shader's value. Exposure is reduced at the beam instead (see BEAM):
  // gamma darkens by discarding the bottom of the range, and past about 1.4 a
  // shadow falls below every threshold in the screen and clips to black.
  gamma: 1,
  contrast: 1,
  sharpen: 0,
  pixelSize: 1,
  dither: 0.75,
} satisfies RasterOptions

/**
 * The beam level images are drawn at. DIM is used here as an exposure setting
 * rather than in its usual sense of a secondary element.
 *
 * Measured: a screen full of text lights 14% of the beam, since a glyph is thin
 * strokes surrounded by unlit cell. A mid-grey image lights half its pixels. At
 * the same beam level as adjacent text, an image is therefore three to four
 * times as bright, which against a bloom tuned for sparse strokes reads as a
 * light source rather than a photograph.
 *
 * Applied here rather than as more gamma. Gamma darkens by discarding the
 * bottom of the tonal range: at 1.4 a shadow at 0.15 falls below every
 * threshold and clips to black. The beam level reduces the whole image by 27%
 * and costs no detail, since the same pixels are lit either way.
 */
const BEAM = DIM

/**
 * The 8x8 Bayer matrix, transcribed from the bayer8x8 branch chain in
 * ImageRaster.vue's fragment shader. Values 0..63; the shader divides by 64.
 */
const BAYER = new Uint8Array([
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
])

/**
 * How much noise is blended into the Bayer value, and its amplitude. Both are
 * the shader's: mix(bayerValue, random(...) * 0.1, 0.3).
 */
const NOISE_MIX = 0.3
const NOISE_SIZE = 0.1

/**
 * The noise is applied as zero-mean jitter, the one deliberate departure from
 * the shader.
 *
 * mix(bayer, noise, 0.3) blends toward a value in 0..0.1, which does two things
 * where only one was wanted. It breaks up the regularity, as intended, but it
 * also lowers the screen's mean from the Bayer matrix's 0.492 to 0.360. A
 * threshold averaging 0.360 lights 61% of a flat mid-grey field rather than
 * 50%, so the image is overexposed. mix also compresses the screen's range to
 * 0.7 of the matrix's, raising the darkest threshold so shadows clip to black.
 *
 * Centring the noise on zero corrects both: the matrix keeps its full 0..0.98
 * spread, the mean stays at mid grey, and the jitter is unchanged in strength.
 *
 * Neither effect is visible in the web client, where the value selects a point
 * between two theme colours on a themed background.
 */
const NOISE_BIAS = NOISE_SIZE / 2

/**
 * The shader's random(st), reproduced exactly. It is a hash rather than a random
 * number, so a given pixel always gets the same value and the image does not
 * shimmer when redrawn.
 *
 * Math.fround is required because GLSL's sin and fract are single precision and
 * this expression depends on it: at double precision the argument to sin is
 * large enough that its low bits, which are the whole output, differ. Without
 * it the result is still noise, but not the same noise as the web client's.
 */
function hash(x: number, y: number): number {
  const dot = Math.fround(Math.fround(x * 12.9898) + Math.fround(y * 78.233))
  const v = Math.fround(Math.fround(Math.sin(dot)) * 43758.5453123)
  return v - Math.floor(v)
}

export const pixel: Raster = (m, src, cols, rows, opts) => {
  const gamma = opts.gamma ?? DEFAULTS.gamma
  const contrast = opts.contrast ?? DEFAULTS.contrast
  const sharpen = opts.sharpen ?? DEFAULTS.sharpen
  const chunk = Math.max(1, Math.round(opts.pixelSize ?? DEFAULTS.pixelSize))
  const amount = opts.dither ?? DEFAULTS.dither

  const { cellW, cellH } = m
  const pw = cols * cellW
  const ph = rows * cellH

  // Sampled on the framebuffer's own grid. Only the cellW ink columns of each
  // cell are addressed; the 9th advance column is not a sample but a repeat of
  // the eighth, as VGA did to make box-drawing rules join.
  const plane = resample(src, pw, ph, sampleAspect(m, cellW, cellH))
  tone(plane, gamma, contrast)
  unsharp(plane, pw, ph, sharpen, 2)

  /** Pixel blocks: the shader floors the UV, so a block resolves to one tone. */
  const grey = (x: number, y: number): number => {
    if (chunk === 1) return plane[y * pw + x]!
    const x0 = Math.floor(x / chunk) * chunk
    const y0 = Math.floor(y / chunk) * chunk
    let sum = 0, n = 0
    for (let yy = y0; yy < Math.min(ph, y0 + chunk); yy++) {
      for (let xx = x0; xx < Math.min(pw, x0 + chunk); xx++, n++) sum += plane[yy * pw + xx]!
    }
    return n ? sum / n : 0
  }

  // One bitmap per cell, in the layout the font uses and putGlyph expects: one
  // word per row, bit (cellW-1) leftmost. undefined where nothing is lit, so an
  // empty cell shows whatever was painted beneath rather than a black rectangle.
  const cells: (Uint16Array | undefined)[] = new Array(cols * rows).fill(undefined)

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let bits: Uint16Array | undefined
      for (let y = 0; y < cellH; y++) {
        const py = cy * cellH + y
        let row = 0
        for (let x = 0; x < cellW; x++) {
          const px = cx * cellW + x

          const g = grey(px, py)
          // Bayer softened with value noise as the shader mixes them, then
          // re-centred on mid grey. See NOISE_BIAS.
          const bayer = BAYER[(py & 7) * 8 + (px & 7)]! / 64
          const noise = hash(px * 0.01, py * 0.01) * NOISE_SIZE - NOISE_BIAS
          const screen = bayer + noise * NOISE_MIX
          // dither 0 is a hard threshold at mid grey; 1 is the full screen.
          const threshold = 0.5 * (1 - amount) + screen * amount

          if (g >= threshold) row |= 1 << (cellW - 1 - x)
        }
        if (!row) continue
        if (!bits) bits = new Uint16Array(cellH)
        bits[y] = row
      }
      cells[cy * cols + cx] = bits
    }
  }

  // Exposure is chosen by the rasteriser rather than the caller.
  return { cols, rows, cells, attr: BEAM }
}
