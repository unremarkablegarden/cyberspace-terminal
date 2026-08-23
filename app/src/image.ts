// The faceplate's half of the image pipeline: takes pixels, returns handles.
//
// A pty carries characters, so the side that decodes an image also stores the
// bitmaps. What crosses the pty is one private-use code point per cell, each a
// handle on a bitmap held here. Programs write those handles as ordinary text
// and never see the pixels; vt.ts resolves them onto the gfx plane. See
// packages/tui/src/pict.ts.
//
// The only file in the machine that decodes an image. The kernel and userland
// stay off the DOM so the same kernel can run behind ssh; a faceplate with no
// decoder supplies none of this and callers print [IMG] instead.

import { PICT_LO, PICT_HI, halftoneFit, type CellMetrics, type Luma } from '@cyberspace/tui'

/** A rasterised picture, as rows of picture handles. `' '` is an unlit cell. */
export interface Picture {
  cols: number
  rows: number
  lines: string[]
}

export interface ChatPictures {
  /**
   * The picture for this source at this size, or undefined while it loads and
   * permanently if it cannot be read.
   *
   * Safe to call on every paint: the cache is here, so callers store nothing
   * and do not track font changes, eviction or in-flight requests.
   */
  get(src: string, maxCols: number, maxRows: number): Picture | undefined
  /** Called when a picture finishes loading. Returns an unsubscribe function. */
  onLoad(cb: () => void): () => void
  /**
   * As get(), but awaited. For callers with nothing to draw until the picture
   * arrives, such as view, where get()'s undefined-then-repaint does not fit.
   */
  load(src: string | Uint8Array, key: string, maxCols: number, maxRows: number): Promise<Picture>
  /**
   * Halftone a plane that is already luminance.
   *
   * Only the decode step needs a browser; everything after it is arithmetic.
   * Exposed separately so that path can be tested without a DOM, and so pixels
   * from a source other than a URL can be halftoned.
   */
  fromLuma(luma: Luma, key: string, maxCols: number, maxRows: number): Picture
  /** Release every bank slot this holder took. */
  release(): void
}

/** Longest axis kept before the box filter. More than this cannot show in the cells. */
const MAX_SIDE = 1024

/**
 * Slots in the bank, bounded by the size of the private use area. About two and
 * a half screenfuls; once full, get() returns undefined and callers name the
 * attachment instead of drawing it.
 */
const SLOTS = PICT_HI - PICT_LO + 1

/**
 * One bitmap per handle, shared by the faceplate and every holder.
 *
 * A single bank per machine, because vt.ts resolves handles without knowing
 * which program wrote them. Identical cells are deduplicated to one slot, which
 * is common in flat images and rare in dithered photographs.
 *
 * Slots are allocated from a stack. A program takes a scope, fills the tail and
 * releases it on quit. A scope released while a newer one is still open waits
 * rather than freeing its range, because a handle still on screen must keep
 * resolving to the same bitmap.
 */
class GlyphBank {
  private bits: (Uint16Array | undefined)[] = new Array(SLOTS).fill(undefined)
  private byKey = new Map<string, number>()
  private next = 0
  private scopes: Scope[] = []

  get(code: number): Uint16Array | undefined {
    const i = code - PICT_LO
    return i >= 0 && i < SLOTS ? this.bits[i] : undefined
  }

  open(): Scope {
    const scope = new Scope(this, this.next)
    this.scopes.push(scope)
    return scope
  }

  /** Store a bitmap and return its handle, or undefined when the bank is full. */
  intern(bitmap: Uint16Array): number | undefined {
    const key = String.fromCharCode(...bitmap)
    const seen = this.byKey.get(key)
    if (seen !== undefined) return seen
    if (this.next >= SLOTS) return undefined
    const code = PICT_LO + this.next++
    this.bits[code - PICT_LO] = bitmap
    this.byKey.set(key, code)
    return code
  }

  /** Number of slots allocated. Used as a scope's mark and as the stack top. */
  get used(): number { return this.next }

  /** Free every slot above `to`. Only called through a scope. */
  rewind(to: number): void {
    for (let i = to; i < this.next; i++) {
      const b = this.bits[i]
      if (b) this.byKey.delete(String.fromCharCode(...b))
      this.bits[i] = undefined
    }
    this.next = to
  }

  /** Close a scope, and any already-released scopes below it. */
  close(scope: Scope): void {
    scope.dead = true
    while (this.scopes.length && this.scopes[this.scopes.length - 1]!.dead) {
      this.rewind(this.scopes.pop()!.start)
    }
  }
}

/** One holder's claim on a contiguous range at the top of the bank. */
class Scope {
  dead = false
  constructor(private bank: GlyphBank, readonly start: number) {}
  get mark(): number { return this.bank.used }
  intern(bitmap: Uint16Array): number | undefined { return this.bank.intern(bitmap) }
  rewind(to: number): void { this.bank.rewind(to) }
  close(): void { this.bank.close(this) }
}

const BANK = new GlyphBank()

/** Resolve a handle to its bitmap. Called by vt.ts on every frame. */
export function pictureBits(code: number): Uint16Array | undefined {
  return BANK.get(code)
}

/**
 * Fetch an image and reduce it to a luminance plane.
 *
 * Uses createImageBitmap rather than new Image() with a 2d canvas. The CORS
 * requirement is the same, but a refused fetch reports the failure, whereas a
 * tainted canvas only throws at getImageData and cannot distinguish a missing
 * CORS header from a missing file. It also accepts bytes as well as a URL,
 * which view needs for local files.
 */
async function toLuma(src: string | Uint8Array): Promise<Luma> {
  const blob = typeof src === 'string'
    ? await (async () => {
      const res = await fetch(src, { mode: 'cors' })
      if (!res.ok) throw new Error(`image ${res.status}`)
      return res.blob()
    })()
    : new Blob([src as BlobPart])

  const bmp = await createImageBitmap(blob)
  // Capped before the box filter: averaging a 4000px original down takes seconds
  // and cannot resolve more detail than the cells hold.
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const px = ctx.getImageData(0, 0, w, h)

  const data = new Float32Array(w * h)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    // Rec.709 luma coefficients. The only colour decision in the pipeline.
    data[i] = (0.2126 * px.data[j]! + 0.7152 * px.data[j + 1]! + 0.0722 * px.data[j + 2]!) / 255
  }
  return { w, h, data }
}

/** Cell geometry, read on each call: F1 can change the font under a running program. */
function metricsOf(term: { font: { cellW: number; cellH: number }; advance: number }): CellMetrics {
  return { cellW: term.font.cellW, cellH: term.font.cellH, advance: term.advance }
}

/** Halftone a luminance plane to handles. Undefined when the bank is full. */
function toPicture(
  scope: Scope, m: CellMetrics, luma: Luma, maxCols: number, maxRows: number,
): Picture | undefined {
  const block = halftoneFit(m, luma, maxCols, maxRows)
  // A run that exhausts the bank releases what it allocated, rather than leaving
  // a partly-filled picture and orphaned slots.
  const mark = scope.mark
  const lines: string[] = []
  for (let y = 0; y < block.rows; y++) {
    let line = ''
    for (let x = 0; x < block.cols; x++) {
      const bits = block.cells[y * block.cols + x]
      if (!bits) { line += ' '; continue }
      const code = scope.intern(bits)
      if (code === undefined) { scope.rewind(mark); return undefined }
      line += String.fromCharCode(code)
    }
    lines.push(line)
  }
  return { cols: block.cols, rows: block.rows, lines }
}

/**
 * One program's view of the bank, with a cache keyed by font and target size so
 * a change to either re-rasterises without an explicit invalidation.
 *
 * One per program. release() frees the slots if nothing has been filed since
 * the scope was taken, which is the usual case.
 */
export function pictureHost(
  term: { font: { cellW: number; cellH: number }; advance: number },
): ChatPictures {
  const done = new Map<string, Picture>()
  const loading = new Set<string>()
  const failed = new Set<string>()
  const listeners = new Set<() => void>()
  const scope = BANK.open()

  const announce = (): void => { for (const cb of listeners) cb() }
  const keyOf = (m: CellMetrics, src: string, c: number, r: number): string =>
    `${m.advance}x${m.cellH}|${c}x${r}|${src}`

  /** Rasterise, store and cache. The only path by which a picture enters the cache. */
  const rasterise = (luma: Luma, key: string, maxCols: number, maxRows: number): Picture => {
    const m = metricsOf(term)
    const full = keyOf(m, key, maxCols, maxRows)
    const have = done.get(full)
    if (have) return have
    const pic = toPicture(scope, m, luma, maxCols, maxRows)
    if (!pic) throw new Error('no room')
    done.set(full, pic)
    return pic
  }

  const cached = (key: string, maxCols: number, maxRows: number): Picture | undefined =>
    done.get(keyOf(metricsOf(term), key, maxCols, maxRows))

  return {
    get(src, maxCols, maxRows) {
      if (!src || maxCols < 1 || maxRows < 1) return undefined
      const key = keyOf(metricsOf(term), src, maxCols, maxRows)
      const have = done.get(key)
      if (have) return have
      // Failures are cached like successes. get() is called on every paint, so an
      // uncached failure would refetch a refused image sixty times a second.
      if (loading.has(key) || failed.has(key)) return undefined

      loading.add(key)
      toLuma(src)
        .then(luma => { rasterise(luma, src, maxCols, maxRows) })
        .catch(() => { failed.add(key) })
        .finally(() => { loading.delete(key); announce() })
      return undefined
    },

    async load(src, key, maxCols, maxRows) {
      const have = cached(key, maxCols, maxRows)
      if (have) return have
      const pic = rasterise(await toLuma(src), key, maxCols, maxRows)
      announce()
      return pic
    },

    fromLuma(luma, key, maxCols, maxRows) {
      const pic = rasterise(luma, key, maxCols, maxRows)
      announce()
      return pic
    },

    onLoad(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },

    release() {
      done.clear()
      loading.clear()
      failed.clear()
      listeners.clear()
      scope.close()
    },
  }
}
