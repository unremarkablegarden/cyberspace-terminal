// The rasteriser contract and the registry of implementations.
//
// A rasteriser is a single function, so the interface and the list of
// implementations fit in one file. Adding one means a new file and a line in
// RASTERS; nothing else changes, since every caller holds a Halftone and does
// not know which rasteriser produced it.
//
// The registry is kept although only one is registered: a rasteriser involves
// choices of glyph set, contrast and error handling, and alternatives need to
// be comparable on the same image rather than replacing each other.

import { pixel } from './pixel.js'

/**
 * Cell geometry, the only thing a rasteriser needs from a terminal.
 *
 * Passed as measurements rather than a Term, so this package does not depend on
 * the faceplate.
 */
export interface CellMetrics {
  /** Ink columns in a cell. */
  cellW: number
  /** Rows in a cell. */
  cellH: number
  /** Cell pitch: cellW plus the spare join column. */
  advance: number
}

/**
 * An image rasterised to cells.
 *
 * Data rather than a draw() call, because the caller is a host that stores the
 * bitmaps and returns handles, not a program holding a grid. It also makes a
 * rasteriser testable without a terminal.
 *
 * One entry per cell, row-major. undefined marks a cell with nothing lit, which
 * shows whatever was beneath rather than drawing a black rectangle.
 */
export interface Halftone {
  /** Size in cells, the unit a caller laying out a screen works in. */
  cols: number
  rows: number
  /** One word per cell row, bit (cellW-1) leftmost, as putGlyph expects. */
  cells: (Uint16Array | undefined)[]
  /** The beam level the rasteriser selected. */
  attr: number
}

/** Luminance plane, 0..1, row-major. The input to every rasteriser. */
export interface Luma {
  w: number
  h: number
  data: Float32Array
}

export interface RasterOptions {
  /**
   * Applied as `luma ** gamma`. Below 1 lifts the midtones.
   *
   * Every option here is optional and each rasteriser sets its own defaults,
   * because the right preparation depends on what the image is about to be
   * quantised to: a gamma that suits a quarter of the available range
   * overexposes the same image across the full range.
   */
  gamma?: number
  /** Contrast around mid grey. High values posterise. */
  contrast?: number
  /** Unsharp mask strength; 0 disables it. See prep.ts. */
  sharpen?: number
  /** Pixel block size in the rasteriser's sample grid. 1 leaves the image unchanged. */
  pixelSize?: number
  /** 0 flat threshold, 1 all dither. */
  dither?: number
  /** Which rasteriser to use. Defaults to DEFAULT_RASTER. */
  raster?: RasterName
}

/**
 * Convert a luminance plane into a cols x rows block of cells.
 *
 * Pure and synchronous, with no DOM or network access, so it is testable
 * outside a browser and usable with pixels from any source.
 */
export type Raster = (
  m: CellMetrics, src: Luma, cols: number, rows: number, opts: RasterOptions,
) => Halftone

/**
 * The registered rasterisers.
 *
 * `pixel` draws the image at the framebuffer's own resolution, screened as the
 * website's ImageRaster.vue does. It is currently the only one.
 */
export const RASTERS = {
  pixel,
} satisfies Record<string, Raster>

export type RasterName = keyof typeof RASTERS

/** Used when a caller names no rasteriser. */
export const DEFAULT_RASTER: RasterName = 'pixel'
