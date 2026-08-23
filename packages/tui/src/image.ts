// Images on a text grid: the parts that need no browser.
//
// Sizing the block and converting pixels to cells happen here. Obtaining the
// pixels does not, since that needs a fetch and a decoder, which this package
// has neither of. Any caller with a Luma, from a canvas, a file or a test, has
// everything required.
//
// The rasterising algorithm is a registry entry rather than fixed here, since
// there is more than one way to draw an image on this display. See raster/index.

import { RASTERS, DEFAULT_RASTER } from './raster/index.js'
import type { CellMetrics, Halftone, Luma, RasterOptions } from './raster/index.js'

export type { CellMetrics, Halftone, Luma, RasterOptions, Raster, RasterName } from './raster/index.js'
export { RASTERS, DEFAULT_RASTER } from './raster/index.js'
export { resample, tone, unsharp, sampleAspect } from './raster/prep.js'

/** Options for a rasterise, named after the function most callers use. */
export type HalftoneOptions = RasterOptions

/**
 * The aspect of one dot, as height over width.
 *
 * fitImage works in dots, the finer of the two grids. The value describes the
 * cell rather than what is drawn in it, so it does not depend on which
 * rasteriser runs.
 */
export function dotAspect(m: CellMetrics): number {
  return (m.cellH / 4) / (m.advance / 2)
}

/**
 * Cell size for an image that keeps its aspect ratio within the space allowed.
 *
 * Neither a cell nor a dot is square: a 2x4 dot is 4.5 x 4 device pixels in the
 * 8x16 face and 6.5 x 6 in the 12x24, so a square image measures taller than it
 * is wide in dots. Inverting this squashes every image by roughly a quarter,
 * which reads as a poor photograph rather than as a bug.
 *
 * A W x H dot image is (W*dotW) x (H*dotH) physically, so preserving the true
 * ratio gives H = W * imgAspect / dotAspect. The result is in cells.
 */
export function fitImage(
  imgW: number, imgH: number, dots: number, maxCols: number, maxRows: number,
): { cols: number; rows: number } {
  const imgAspect = imgH / Math.max(1, imgW)
  let w = Math.max(2, maxCols * 2)
  let h = w * imgAspect / dots
  const limit = Math.max(4, maxRows * 4)
  if (h > limit) {
    h = limit
    w = h * dots / imgAspect
  }
  return {
    cols: Math.max(1, Math.min(maxCols, Math.round(w / 2))),
    rows: Math.max(1, Math.min(maxRows, Math.round(h / 4))),
  }
}

/**
 * Rasterise a luminance plane into a cols x rows block of cells.
 *
 * Pure and synchronous. opts.raster selects the algorithm; the active one is
 * used if it is omitted.
 */
export function halftone(
  m: CellMetrics, src: Luma, cols: number, rows: number, opts: HalftoneOptions = {},
): Halftone {
  return RASTERS[opts.raster ?? DEFAULT_RASTER](m, src, cols, rows, opts)
}

/** Fit and rasterise in one call, which is what most callers need. */
export function halftoneFit(
  m: CellMetrics, src: Luma, maxCols: number, maxRows: number,
  opts: HalftoneOptions = {},
): Halftone {
  const { cols, rows } = fitImage(src.w, src.h, dotAspect(m), maxCols, maxRows)
  return halftone(m, src, cols, rows, opts)
}
