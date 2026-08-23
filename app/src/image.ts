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
   * The picture for this source at this size, if it is rasterised.
   *
   * A lookup, never a fetch: a screen calls it while laying out every entry it
   * holds, most of which are off the pane. ensure() decides what is worth
   * loading. Safe to call on every paint, and callers store nothing.
   */
  picture(src: string, maxCols: number, maxRows: number): Picture | undefined
  /**
   * Declare the pictures the screen is about to draw.
   *
   * These are the ones kept when the bank has to make room, so a screen must
   * pass everything it can currently show. One load is started per call, which
   * is enough to fill a pane: a load that lands repaints the screen, and the
   * next call starts the next one.
   */
  ensure(srcs: Iterable<string | undefined>, maxCols: number, maxRows: number): void
  /** Whether this source was read and could not be decoded. Loading is not failure. */
  failed(src: string): boolean
  /** Called when a picture finishes loading. Returns an unsubscribe function. */
  onLoad(cb: () => void): () => void
  /**
   * Rasterise now, awaited. For callers with nothing to draw until the picture
   * arrives, such as view, where picture()-then-repaint does not fit.
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
 * Slots in the bank, bounded by the size of the private use area.
 *
 * A photograph halftoned to the width of the chat log costs about 860 of them,
 * so seven of them fill it. Slots are therefore reclaimed as pictures fall out
 * of use rather than held until the program exits.
 */
const SLOTS = PICT_HI - PICT_LO + 1

/**
 * One bitmap per handle, shared by the faceplate and every holder.
 *
 * A single bank per machine, because vt.ts resolves handles without knowing
 * which program wrote them. Identical bitmaps share one slot, which is common
 * in flat images and rare in dithered photographs.
 *
 * Slots are reference counted, one count per picture using them, and a freed
 * slot goes on a stack for the next picture. A handle keeps resolving to the
 * same bitmap for as long as any picture holding it is alive, so a slot cannot
 * change meaning under a row still on the screen.
 */
class GlyphBank {
  private bits: (Uint16Array | undefined)[] = new Array(SLOTS).fill(undefined)
  private byKey = new Map<string, number>()
  private refs = new Int32Array(SLOTS)
  private free: number[] = []
  /** Slots never yet used. Below this, a slot is either live or on `free`. */
  private next = 0

  get(code: number): Uint16Array | undefined {
    const i = code - PICT_LO
    return i >= 0 && i < SLOTS ? this.bits[i] : undefined
  }

  open(): Holder {
    return new Holder(this)
  }

  /**
   * Take a slot for each of one picture's distinct bitmaps.
   *
   * All or nothing: a picture that does not fit releases what it took, so the
   * caller can free something and ask again rather than leaving orphans.
   */
  alloc(distinct: Uint16Array[]): number[] | undefined {
    const codes: number[] = []
    for (const bitmap of distinct) {
      const key = String.fromCharCode(...bitmap)
      let code = this.byKey.get(key)
      if (code === undefined) {
        const slot = this.free.length ? this.free.pop()! : this.next < SLOTS ? this.next++ : undefined
        if (slot === undefined) {
          this.release(codes)
          return undefined
        }
        code = PICT_LO + slot
        this.bits[slot] = bitmap
        this.byKey.set(key, code)
      }
      const i = code - PICT_LO
      this.refs[i] = (this.refs[i] ?? 0) + 1
      codes.push(code)
    }
    return codes
  }

  /** Drop one picture's claim on these slots. */
  release(codes: Iterable<number>): void {
    for (const code of codes) {
      const i = code - PICT_LO
      if (i < 0 || i >= SLOTS) continue
      const left = (this.refs[i] ?? 0) - 1
      if (left < 0) continue
      this.refs[i] = left
      if (left > 0) continue
      const bitmap = this.bits[i]
      if (bitmap) this.byKey.delete(String.fromCharCode(...bitmap))
      this.bits[i] = undefined
      this.free.push(i)
    }
  }

  /** Slots currently held by a picture. */
  get live(): number { return this.next - this.free.length }
}

/** One holder's pictures. Closing it releases every slot they hold. */
class Holder {
  private taken = new Set<number[]>()
  constructor(private bank: GlyphBank) {}

  alloc(distinct: Uint16Array[]): number[] | undefined {
    const codes = this.bank.alloc(distinct)
    if (codes) this.taken.add(codes)
    return codes
  }

  free(codes: number[]): void {
    if (this.taken.delete(codes)) this.bank.release(codes)
  }

  close(): void {
    for (const codes of this.taken) this.bank.release(codes)
    this.taken.clear()
  }
}

const BANK = new GlyphBank()

/** Resolve a handle to its bitmap. Called by vt.ts on every frame. */
export function pictureBits(code: number): Uint16Array | undefined {
  return BANK.get(code)
}

/** Slots held across the machine, out of SLOTS. One photograph is about 860. */
export function pictureSlots(): number {
  return BANK.live
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

/** A picture and the slots it holds, which are released together. */
interface Held {
  pic: Picture
  codes: number[]
}

/** Halftone a luminance plane to handles. Undefined when the bank is full. */
function toPicture(
  holder: Holder, m: CellMetrics, luma: Luma, maxCols: number, maxRows: number,
): Held | undefined {
  const block = halftoneFit(m, luma, maxCols, maxRows)
  // Distinct bitmaps first, so the bank is asked once and either holds the whole
  // picture or none of it.
  const distinct: Uint16Array[] = []
  const nth = new Map<string, number>()
  const cell = new Int32Array(block.cols * block.rows).fill(-1)
  for (let i = 0; i < cell.length; i++) {
    const bits = block.cells[i]
    if (!bits) continue
    const key = String.fromCharCode(...bits)
    let n = nth.get(key)
    if (n === undefined) {
      n = distinct.length
      distinct.push(bits)
      nth.set(key, n)
    }
    cell[i] = n
  }

  const codes = holder.alloc(distinct)
  if (!codes) return undefined

  const lines: string[] = []
  for (let y = 0; y < block.rows; y++) {
    let line = ''
    for (let x = 0; x < block.cols; x++) {
      const n = cell[y * block.cols + x]!
      line += n < 0 ? ' ' : String.fromCharCode(codes[n]!)
    }
    lines.push(line)
  }
  return { pic: { cols: block.cols, rows: block.rows, lines }, codes }
}

/**
 * One program's view of the bank, with a cache keyed by font and target size so
 * a change to either re-rasterises without an explicit invalidation.
 *
 * The cache is bounded by the bank rather than by a count: when a picture will
 * not fit, the pictures the screen last asked to keep are the ones that stay.
 * One per program; release() frees every slot it took.
 */
export function pictureHost(
  term: { font: { cellW: number; cellH: number }; advance: number },
): ChatPictures {
  /** Insertion order is least-recently-wanted first, which is the eviction order. */
  const done = new Map<string, Held>()
  const loading = new Set<string>()
  /**
   * Sources that could not be read: gone, refused, or not an image. Keyed by
   * source rather than by size, since none of that changes with the geometry,
   * and permanent, because picture() is called on every paint and a retry loop
   * would refetch a dead URL sixty times a second.
   */
  const unreadable = new Set<string>()
  /** Keys named by the last ensure(). Never evicted: they are what is on screen. */
  const wanted = new Set<string>()
  const listeners = new Set<() => void>()
  const holder = BANK.open()

  const announce = (): void => { for (const cb of listeners) cb() }
  const keyOf = (m: CellMetrics, src: string, c: number, r: number): string =>
    `${m.advance}x${m.cellH}|${c}x${r}|${src}`

  const touch = (key: string, held: Held): Held => {
    done.delete(key)
    done.set(key, held)
    return held
  }

  /** Free the least recently wanted picture. False when everything held is on screen. */
  const evict = (): boolean => {
    for (const [key, held] of done) {
      if (wanted.has(key)) continue
      done.delete(key)
      holder.free(held.codes)
      return true
    }
    return false
  }

  /** Rasterise, store and cache. The only path by which a picture enters the cache. */
  const rasterise = (
    luma: Luma, src: string, maxCols: number, maxRows: number,
  ): Picture | undefined => {
    const m = metricsOf(term)
    const key = keyOf(m, src, maxCols, maxRows)
    const have = done.get(key)
    if (have) return touch(key, have).pic
    let made = toPicture(holder, m, luma, maxCols, maxRows)
    while (!made && evict()) made = toPicture(holder, m, luma, maxCols, maxRows)
    if (!made) return undefined
    touch(key, made)
    return made.pic
  }

  const start = (src: string, maxCols: number, maxRows: number): void => {
    const key = keyOf(metricsOf(term), src, maxCols, maxRows)
    loading.add(key)
    toLuma(src)
      .then(luma => { rasterise(luma, src, maxCols, maxRows) })
      .catch(() => { unreadable.add(src) })
      .finally(() => { loading.delete(key); announce() })
  }

  return {
    picture(src, maxCols, maxRows) {
      if (!src || maxCols < 1 || maxRows < 1) return undefined
      const key = keyOf(metricsOf(term), src, maxCols, maxRows)
      const have = done.get(key)
      return have ? touch(key, have).pic : undefined
    },

    ensure(srcs, maxCols, maxRows) {
      if (maxCols < 1 || maxRows < 1) return
      const m = metricsOf(term)
      wanted.clear()
      let next: string | undefined
      for (const src of srcs) {
        if (!src) continue
        const key = keyOf(m, src, maxCols, maxRows)
        wanted.add(key)
        const have = done.get(key)
        if (have) { touch(key, have); continue }
        if (!next && !unreadable.has(src) && !loading.has(key)) next = src
      }
      // One at a time: a room of photographs would otherwise open dozens of
      // sockets at once for the two or three pictures that fit on the pane.
      if (next && !loading.size) start(next, maxCols, maxRows)
    },

    failed(src) {
      return unreadable.has(src)
    },

    async load(src, key, maxCols, maxRows) {
      const pic = rasterise(await toLuma(src), key, maxCols, maxRows)
      if (!pic) throw new Error('no room')
      announce()
      return pic
    },

    fromLuma(luma, key, maxCols, maxRows) {
      const pic = rasterise(luma, key, maxCols, maxRows)
      if (!pic) throw new Error('no room')
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
      unreadable.clear()
      wanted.clear()
      listeners.clear()
      holder.close()
    },
  }
}
