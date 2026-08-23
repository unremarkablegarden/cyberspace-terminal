// Preparation shared by every rasteriser, before cells are chosen.
//
// Reducing an image to the size of a text grid is the same problem whatever is
// drawn afterwards, so the box filter, tone curve and local-contrast pass live
// here. Only the final step, choosing a glyph and beam level, differs between
// rasterisers.

import type { CellMetrics, Luma } from './index.js'

/**
 * Sample shape for a grid of sx x sy samples per cell, as height over width.
 *
 * This module and fitImage both use that direction. Inverting it squashes every
 * image by roughly a quarter, which reads as a poor photograph rather than a bug.
 *
 * A cell is `advance` device pixels wide and `cellH` tall, and each rasteriser
 * divides it into its own sample grid: cellW x cellH for pixel, 2 x 4 for
 * dot-based ones. The ratio of a sample's height to its width is therefore
 * (cellH/sy) / (advance/sx). Both grids give the same value for a given font,
 * 0.889 in the 8x16 face and 0.923 in the 12x24, since it describes the cell.
 */
export function sampleAspect(m: CellMetrics, sx: number, sy: number): number {
  return (m.cellH / sy) / (m.advance / sx)
}

/**
 * Average `src` down into a centred w x h box without distorting it.
 *
 * The image is fitted inside the box rather than filling it, so the reserved
 * block is exactly honoured and the image keeps its proportions. Remaining
 * space is left unlit.
 *
 * A box filter rather than point sampling: reducing a 1600px image to a few
 * hundred samples by taking one pixel each would discard 99% of the image and
 * keep whatever noise those pixels held.
 */
export function resample(src: Luma, w: number, h: number, aspect: number): Float32Array {
  const out = new Float32Array(w * h)
  const imgAspect = src.h / Math.max(1, src.w)

  // Largest rectangle within w x h that keeps the image's aspect. The same
  // relation as fitImage, applied to the sample box rather than the cell box.
  let dw = w
  let dh = dw * imgAspect / aspect
  if (dh > h) { dh = h; dw = dh * aspect / imgAspect }
  dw = Math.max(1, Math.round(dw))
  dh = Math.max(1, Math.round(dh))
  const ox = ((w - dw) / 2) | 0
  const oy = ((h - dh) / 2) | 0

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * src.h / dh)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * src.h / dh))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * src.w / dw)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * src.w / dw))
      let sum = 0, n = 0
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * src.w
        for (let xx = x0; xx < x1; xx++) { sum += src.data[row + xx]!; n++ }
      }
      out[(y + oy) * w + (x + ox)] = n ? sum / n : 0
    }
  }
  return out
}

/** Apply gamma and contrast around mid grey, in place. */
export function tone(plane: Float32Array, gamma: number, contrast: number) {
  for (let i = 0; i < plane.length; i++) {
    const g = Math.pow(plane[i]!, gamma)
    plane[i] = Math.min(1, Math.max(0, (g - 0.5) * contrast + 0.5))
  }
}

/**
 * Unsharp mask, in place: add back the difference between the image and a blur
 * of it.
 *
 * The only step here that affects apparent resolution rather than tone. At a
 * reduction to a few hundred samples the box filter removes edge detail first,
 * and restoring the difference makes the surviving edges carry it.
 *
 * Applied before quantising: afterwards the image is glyphs, and an edge either
 * fell on a cell boundary or did not.
 *
 * A separable box blur rather than a gaussian. At radius 2 on an image this
 * small the difference is one sample's weighting, and a box blur is two passes
 * of additions.
 */
export function unsharp(
  plane: Float32Array, w: number, h: number, amount: number, radius: number,
) {
  const r = Math.max(1, Math.round(radius))
  if (amount <= 0) return

  const tmp = new Float32Array(w * h)
  const blur = new Float32Array(w * h)

  // Horizontal pass, clamping at the edges so the border does not darken.
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) {
        sum += plane[row + Math.min(w - 1, Math.max(0, x + k))]!
      }
      tmp[row + x] = sum / (2 * r + 1)
    }
  }
  // Vertical pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) {
        sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]!
      }
      blur[y * w + x] = sum / (2 * r + 1)
    }
  }

  for (let i = 0; i < plane.length; i++) {
    const v = plane[i]! + amount * (plane[i]! - blur[i]!)
    plane[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }
}
