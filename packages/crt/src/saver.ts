// Screensavers — the roster and the one screen that hosts them.
//
// Behind a dynamic import like ../doom.ts: commands/index.ts is static, so the
// command file is a stub and the shell's idle trigger imports this on first
// fire. Nothing here is fetched until a saver actually goes up.
//
// A saver is a plain frame function over the cell grid; SaverScreen owns the
// rAF loop, the fixed-step accumulator and the cleanup, so a saver never has
// to know how it is driven. Any key takes the whole thing down — that is what
// a screensaver is — and the screen stack's snapshot puts back whatever was
// underneath, which is the entire restore path.
//
// No colour, as everywhere on this tube: BRIGHT to DIM are beam levels, and
// where a saver needs more resolution than the cell grid it uses what the
// grid already carries — braille dots (`life`, `stars`, `dvd`) or per-cell
// bitmaps via putGlyph (`fire`), never a glyph a face might not have.

import { NORMAL, BRIGHT, DIM, MUTED } from './term.js'
import type { Screen, KeyInput } from '@cyberspace/tui'
import { DotCanvas } from './vector.js'
import { SAVER_NAMES } from './saverdefs.js'
import type { Term } from './term.js'

/** Break text on word boundaries to fit `width` columns. `fortune` needs it. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) { line = word; continue }
      if (line.length + 1 + word.length <= width) { line += ' ' + word; continue }
      out.push(line)
      line = word
    }
    out.push(line)
  }
  return out
}

export interface SaverDeps {
  /** The tube's phosphor persistence, for the savers that want a longer tail. */
  setDecay: (value: number | null) => void
  /** The cookie jar `fortune` reads from — one copy of the text, one cache. */
  fortune: () => Promise<string | null>
}

export interface Saver {
  /** One fixed step. `dt` is always 1/fps — the host owns the accumulator. */
  frame(term: Term, dt: number): void
  dispose?(): void
}

export interface SaverSpec {
  name: string
  /** One clause for the picker's right column. */
  summary: string
  /** Fixed simulation rate. The host never calls frame() faster or slower. */
  fps: number
  /**
   * Phosphor decay to hold while this saver is up, applied and released by the
   * host — a saver that exits still holding it would leave the prompt smeared.
   * Absolute, clamped to DECAY_MAX in crt.ts.
   */
  decay?: number
  make(term: Term, deps: SaverDeps): Saver
}

/** Every cell a space at NORMAL, cursor off. The canvas every saver starts on. */
function blank(term: Term) {
  for (let y = 0; y < term.rows; y++) {
    for (let x = 0; x < term.cols; x++) term.put(x, y, 32, NORMAL)
  }
  term.showCursor = false
}

const rnd = (n: number) => (Math.random() * n) | 0

// --- matrix ----------------------------------------------------------------

/**
 * cmatrix. One drop per column with a fractional speed; the head burns BRIGHT,
 * the cell behind it drops to NORMAL, a DIM flicker mutates mid-trail, and a
 * space erases the tail. The held decay is what streaks the heads — the CRT's
 * own persistence does what cmatrix fakes with a palette.
 */
const matrix: SaverSpec = {
  name: 'matrix', summary: 'digital rain', fps: 20, decay: 0.88,
  make(term) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=<>:;'
    const glyph = () => CHARS.charCodeAt(rnd(CHARS.length))
    const drop = () => ({
      y: -Math.random() * term.rows * 2,
      speed: 6 + Math.random() * 14, // rows per second
      len: 4 + rnd(term.rows * 0.6),
    })
    const drops = Array.from({ length: term.cols }, drop)

    return {
      frame(t, dt) {
        for (let x = 0; x < t.cols; x++) {
          const d = drops[x]!
          const prev = Math.floor(d.y)
          d.y += d.speed * dt
          const head = Math.floor(d.y)
          // Every row the head crossed this step, so a fast drop leaves no gap.
          for (let r = prev + 1; r <= head; r++) {
            t.put(x, r, glyph(), BRIGHT)
            t.put(x, r - 1, glyph(), NORMAL)
            t.put(x, r - ((d.len * 0.7) | 0), glyph(), DIM)
            t.put(x, r - d.len, 32, NORMAL)
          }
          if (head - d.len > t.rows) drops[x] = drop()
        }
      },
    }
  },
}

// --- pipes -----------------------------------------------------------------

/**
 * pipes.sh. Four pipes, alternating single and double box-drawing sets, beam
 * levels standing in for the original's colours. The corner table joins the
 * side a pipe came from with the side it leaves by, keyed oldDir*4+newDir.
 * Once the screen is good and tangled it wipes and starts over — the classic
 * reset.
 */
const pipes: SaverSpec = {
  name: 'pipes', summary: 'plumbing', fps: 30,
  make(term) {
    const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]
    const SINGLE = {
      v: 0x2502, h: 0x2500,
      corner: { 1: 0x250c, 3: 0x2510, 4: 0x2518, 6: 0x2510, 9: 0x2514, 11: 0x2518, 12: 0x2514, 14: 0x250c } as Record<number, number>,
    }
    const DOUBLE = {
      v: 0x2551, h: 0x2550,
      corner: { 1: 0x2554, 3: 0x2557, 4: 0x255d, 6: 0x2557, 9: 0x255a, 11: 0x255d, 12: 0x255a, 14: 0x2554 } as Record<number, number>,
    }
    const ATTRS = [BRIGHT, NORMAL, MUTED, DIM]
    const spawn = (i: number) => ({
      x: rnd(term.cols), y: rnd(term.rows), dir: rnd(4),
      set: i % 2 ? DOUBLE : SINGLE,
      attr: ATTRS[i % ATTRS.length]!,
    })
    let squad = [0, 1, 2, 3].map(spawn)
    let drawn = 0
    const RESET_AT = term.cols * term.rows * 1.5

    return {
      frame(t) {
        for (const p of squad) {
          // Two cells per step keeps it brisk at a lazy simulation rate.
          for (let s = 0; s < 2; s++) {
            let ch: number
            if (Math.random() < 0.18) {
              const next = (p.dir + (Math.random() < 0.5 ? 1 : 3)) % 4
              ch = p.set.corner[p.dir * 4 + next]!
              p.dir = next
            } else {
              ch = p.dir % 2 ? p.set.h : p.set.v
            }
            t.put(p.x, p.y, ch, p.attr)
            p.x = (p.x + DX[p.dir]! + t.cols) % t.cols
            p.y = (p.y + DY[p.dir]! + t.rows) % t.rows
            drawn++
          }
        }
        if (drawn > RESET_AT) {
          drawn = 0
          blank(t)
          squad = [0, 1, 2, 3].map(spawn)
        }
      },
    }
  },
}

// --- worms -----------------------------------------------------------------

/**
 * bsdgames worms. Each worm is a queue of cells on an eight-way random walk
 * biased straight ahead; the head is the only bright thing, the body settles
 * to NORMAL, and the tail erases itself. Wraps, as the original does.
 */
const worms: SaverSpec = {
  name: 'worms', summary: 'the worm farm', fps: 12,
  make(term) {
    const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1]
    const LEN = 11
    const N = Math.max(3, (term.cols / 14) | 0)
    const squad = Array.from({ length: N }, () => ({
      cells: [[rnd(term.cols), rnd(term.rows)]] as [number, number][],
      dir: rnd(8),
    }))

    return {
      frame(t) {
        for (const w of squad) {
          // Mostly straight, sometimes a nudge — never a U-turn, which is what
          // ±1 on an eight-way compass guarantees.
          const roll = Math.random()
          if (roll < 0.2) w.dir = (w.dir + 1) % 8
          else if (roll < 0.4) w.dir = (w.dir + 7) % 8
          const [hx, hy] = w.cells[w.cells.length - 1]!
          const nx = (hx + DX[w.dir]! + t.cols) % t.cols
          const ny = (hy + DY[w.dir]! + t.rows) % t.rows
          t.put(hx, hy, 111, NORMAL) // o — the old head joins the body
          t.put(nx, ny, 64, BRIGHT)  // @
          w.cells.push([nx, ny])
          if (w.cells.length > LEN) {
            const [tx, ty] = w.cells.shift()!
            t.put(tx, ty, 32, NORMAL)
          }
        }
      },
    }
  },
}

// --- rain ------------------------------------------------------------------

/**
 * bsdgames rain. Drops land at random and age through a splash — dot, ring,
 * spray — then erase themselves. Nothing accumulates; the storm is the same
 * size forever.
 */
const rain: SaverSpec = {
  name: 'rain', summary: 'a storm on the glass', fps: 10,
  make(term) {
    const drops: { x: number; y: number; age: number }[] = []
    const put = (t: Term, x: number, y: number, ch: number, attr: number) => t.put(x, y, ch, attr)

    return {
      frame(t) {
        for (let i = drops.length - 1; i >= 0; i--) {
          const d = drops[i]!
          d.age++
          switch (d.age) {
            case 1: put(t, d.x, d.y, 111, NORMAL); break             // o
            case 2: put(t, d.x, d.y, 79, BRIGHT); break              // O
            case 3:
              put(t, d.x, d.y, 32, NORMAL)
              put(t, d.x, d.y - 1, 124, DIM); put(t, d.x, d.y + 1, 124, DIM) // |
              put(t, d.x - 1, d.y, 45, DIM); put(t, d.x + 1, d.y, 45, DIM)   // -
              break
            case 4:
              put(t, d.x, d.y - 1, 32, NORMAL); put(t, d.x, d.y + 1, 32, NORMAL)
              put(t, d.x - 1, d.y, 32, NORMAL); put(t, d.x + 1, d.y, 32, NORMAL)
              drops.splice(i, 1)
              break
          }
        }
        for (let n = 1 + rnd(2); n > 0; n--) {
          const d = { x: rnd(term.cols), y: rnd(term.rows), age: 0 }
          drops.push(d)
          put(term, d.x, d.y, 46, DIM) // .
        }
      },
    }
  },
}

// --- stars -----------------------------------------------------------------

/**
 * The warp field, on the braille bitmap — the grid as 160x100 dots, the same
 * trick `examples/river` shows. Stars fly out of the centre with a short
 * streak from where they were last step, which is all the perspective needed.
 */
const stars: SaverSpec = {
  name: 'stars', summary: 'punch it', fps: 30,
  make(term) {
    const c = new DotCanvas(term)
    const N = 240
    const SPEED = 0.45 // fractions of z per second
    const spawn = () => ({
      x: Math.random() * 2 - 1, y: Math.random() * 2 - 1,
      z: 0.15 + Math.random() * 0.85,
    })
    const field = Array.from({ length: N }, spawn)
    const px = (s: { x: number; z: number }) => c.w / 2 + (s.x / s.z) * (c.w / 2)
    const py = (s: { y: number; z: number }) => c.h / 2 + (s.y / s.z) * (c.h / 2)

    return {
      frame(t, dt) {
        blank(t)
        c.clear()
        for (let i = 0; i < field.length; i++) {
          let s = field[i]!
          const ox = px(s), oy = py(s)
          s.z -= SPEED * dt
          if (s.z <= 0.05 || Math.abs(px(s)) > c.w * 2 || Math.abs(py(s)) > c.h * 2) {
            s = field[i] = spawn()
            c.line(px(s), py(s), px(s), py(s))
            continue
          }
          c.line(ox, oy, px(s), py(s))
        }
        c.blit(t, BRIGHT)
      },
    }
  },
}

// --- life ------------------------------------------------------------------

/**
 * Conway's Life on the grid-as-a-bitmap — 160 by 100 braille dots, nothing
 * else on the glass. Adapted from the member program it started as; the
 * GEN/POP readout and the SPACE/P bindings stayed behind, because a
 * screensaver is a picture and any key on one means wake. Wrapped edges, so a
 * glider off the right comes back on the left; a population that stops
 * changing is still lifes and blinkers and nothing else, which is the end of
 * the show, so it starts another one.
 */
const life: SaverSpec = {
  name: 'life', summary: 'conway, in braille', fps: 16,
  make(term) {
    const c = new DotCanvas(term)
    const W = c.w, H = c.h
    const DENSITY = 0.28
    let cells = new Uint8Array(W * H)
    let next = new Uint8Array(W * H)
    let lastPop = -1, stale = 0

    const soup = () => {
      for (let i = 0; i < cells.length; i++) cells[i] = Math.random() < DENSITY ? 1 : 0
      next.fill(0)
      lastPop = -1; stale = 0
    }
    soup()

    return {
      frame(t) {
        c.clear()
        let pop = 0
        for (let y = 0; y < H; y++) {
          const row = y * W
          for (let x = 0; x < W; x++) {
            if (cells[row + x]) { c.plot(x, y); pop++ }
          }
        }
        // blit leaves empty cells alone, so the grid is wiped first —
        // otherwise every dead dot stays lit and the board smears.
        blank(t)
        c.blit(t, BRIGHT)

        // A constant population is still lifes and blinkers and nothing else.
        if (pop === lastPop) stale++
        else stale = 0
        lastPop = pop
        if (stale > 80 || pop === 0) { soup(); return }

        for (let y = 0; y < H; y++) {
          const up = ((y + H - 1) % H) * W, mid = y * W, dn = ((y + 1) % H) * W
          for (let x = 0; x < W; x++) {
            const l = (x + W - 1) % W, r = (x + 1) % W
            const n = cells[up + l]! + cells[up + x]! + cells[up + r]!
              + cells[mid + l]! + cells[mid + r]!
              + cells[dn + l]! + cells[dn + x]! + cells[dn + r]!
            next[mid + x] = (n === 3 || (n === 2 && cells[mid + x])) ? 1 : 0
          }
        }
        const swap = cells; cells = next; next = swap
      },
    }
  },
}

// --- fire ------------------------------------------------------------------

/**
 * A 4x4 ordered dither. Ordered rather than error-diffused on purpose: what
 * makes the site's images read as a treatment rather than as damage is that
 * the screen is REGULAR, and the same is true of a fire made of dots.
 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/**
 * The DOOM fire, at the beam's own resolution — adapted from the member
 * program it started as, minus the wind and douse keys, because any key on a
 * screensaver means wake.
 *
 * Drawn in CHARACTERS this was a bright gradient with no fire in it: over 25
 * rows a flame starting hot never cools enough to taper, and half the beam
 * lit reads as a lamp. putGlyph is the way out — a cell carries its own
 * bitmap, so the grid is really cols*cellW by rows*cellH pixels, and at ~400
 * rows the fire has room to die. The heat is simulated at half resolution
 * (one Math.random per cell per frame is a budget) and dithered at full, so
 * the tone is fine even where the heat underneath it is blocky.
 */
const fire: SaverSpec = {
  name: 'fire', summary: 'burn it all down', fps: 30,
  make(term) {
    const { cellW, cellH } = term.font
    const W = (term.cols * cellW) >> 1, H = (term.rows * cellH) >> 1

    // Where the fire goes out. Mean decay is a third of a level per row, so a
    // source at 52 dies about three quarters up the screen, with enough
    // variance in the tail for ragged tips. The number to turn.
    const MAX = 52
    const heat = new Uint8Array(W * H)

    // Sparks are not part of the algorithm and the whole thing looks dead
    // without them: the fire is a smooth field, and what the eye reads as
    // BURNING is a few things moving faster than everything around them.
    const sparks: { x: number; y: number; vy: number; life: number }[] = []

    // Heat -> how much of the cell is lit. The exponent is the difference
    // between a fire and a lamp: 1.7 keeps the tips where they are and takes
    // the mid-flame from half lit to a third. Capped below 1 so even the fuel
    // bed keeps some pixels dark — a solid rectangle is a white bar, not a
    // fire.
    const TONE = new Float32Array(MAX + 1)
    for (let v = 0; v <= MAX; v++) TONE[v] = Math.min(0.8, Math.pow(v / MAX, 1.7))

    // putGlyph does NOT copy the bitmap it is handed — the grid holds the
    // reference — so the cells are allocated once and rewritten in place.
    const bitmaps: Uint16Array[] = []
    for (let i = 0; i < term.cols * term.rows; i++) bitmaps.push(new Uint16Array(cellH))

    let t = 0

    return {
      frame(term) {
        t++

        // The fuel bed. A flat source gives a flat fire: two slow sines at
        // unrelated frequencies drift the fuel along the grate instead, and
        // THAT is what makes tongues — bright columns that wander, rise
        // further than their neighbours, and collapse. The floor keeps it a
        // grate rather than a row of separate candles.
        const base = (H - 1) * W
        for (let x = 0; x < W; x++) {
          const a = Math.sin(x * 0.055 + t * 0.05)
          const b = Math.sin(x * 0.017 - t * 0.031)
          heat[base + x] = Math.round(MAX * (0.7 + 0.19 * a + 0.15 * b))
        }

        // The algorithm. rand does two jobs out of one call: the low bit is
        // whether this cell cools, and the whole of it is how far the flame
        // leans. Decay and turbulence, three lines.
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

        // Sparks live in the heat field rather than beside it, so they are
        // lit by the same dither and cool as they climb. Thrown from the hot
        // parts of the bed only, which is why they come in gusts.
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

        // One bitmap per cell. The heat is sampled at half resolution — >>1
        // on both axes — but thresholded at full, so the dither is fine even
        // though what it is dithering is not.
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
            // Three tiers, and NORMAL is the ceiling: the tone is carried by
            // how many pixels are lit, not by how hard they are driven — the
            // beam only says which part of the fire this is.
            const mean = sum / (cellW * cellH)
            term.putGlyph(cx, cy, bits, mean > 0.62 ? NORMAL : mean > 0.3 ? MUTED : DIM)
          }
        }
      },
    }
  },
}

// --- dvd -------------------------------------------------------------------

/**
 * The five-by-seven wordmark, one string per letter row, `#` for a lit dot.
 * Only the letters CYBERSPACE spends.
 */
const DVD_FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
}

/**
 * The bouncing logo. Everyone has waited for the corner hit; nobody has seen
 * one. On the braille bitmap rather than the cell grid — a wordmark hopping a
 * whole cell at a time reads as a cursor bug, and the dots are the only
 * resolution the tube has that moves smoothly. The mark changes intensity on
 * every wall it touches, which is all the colour cycling the glass can offer.
 */
const dvd: SaverSpec = {
  name: 'dvd', summary: 'waiting for the corner', fps: 30,
  make(term) {
    const c = new DotCanvas(term)
    const TEXT = 'CYBERSPACE'
    const STEP = 6 // five columns of letter, one of gap
    const W = TEXT.length * STEP - 1
    const H = 7
    const ATTRS = [BRIGHT, NORMAL, MUTED, DIM]
    let x = Math.random() * (c.w - W)
    let y = Math.random() * (c.h - H)
    let vx = 26, vy = 13 // dots per second
    let ai = 0

    return {
      frame(t, dt) {
        x += vx * dt
        y += vy * dt
        const mx = c.w - W, my = c.h - H
        if (x <= 0 || x >= mx) { vx = -vx; x = Math.min(mx, Math.max(0, x)); ai++ }
        if (y <= 0 || y >= my) { vy = -vy; y = Math.min(my, Math.max(0, y)); ai++ }

        blank(t)
        c.clear()
        for (let i = 0; i < TEXT.length; i++) {
          const glyph = DVD_FONT[TEXT[i]!]!
          for (let r = 0; r < H; r++) {
            const row = glyph[r]!
            for (let col = 0; col < row.length; col++) {
              if (row[col] === '#') c.plot((x | 0) + i * STEP + col, (y | 0) + r)
            }
          }
        }
        c.blit(t, ATTRS[ai % ATTRS.length]!)
      },
    }
  },
}

// --- fortune ---------------------------------------------------------------

/**
 * A random epigram, typed letter by letter into the middle of the glass, held
 * long enough to read, then replaced — inside a marquee of chasing bulbs
 * around the edge, every third one lit, ASCII the way a real tivoli sign is
 * bulbs. The same 629 cookies `fortune` prints — one copy of the text, one
 * cache. Deliberately silent: this one goes up on its own, and a machine
 * bleeping to itself in an empty room is a fault, not an easter egg.
 */
const fortune: SaverSpec = {
  name: 'fortune', summary: 'the cookie jar', fps: 30,
  make(term, deps) {
    let lines: string[] = []
    let x0 = 0, y0 = 0
    let li = 0, ci = 0
    let hold = 0
    let phase: 'loading' | 'typing' | 'holding' = 'loading'
    let disposed = false

    // The perimeter, walked clockwise from the top-left corner so the chase
    // actually travels around the frame instead of mirroring at the seams.
    const bulbs: [number, number][] = []
    for (let x = 0; x < term.cols; x++) bulbs.push([x, 0])
    for (let y = 1; y < term.rows; y++) bulbs.push([term.cols - 1, y])
    for (let x = term.cols - 2; x >= 0; x--) bulbs.push([x, term.rows - 1])
    for (let y = term.rows - 2; y >= 1; y--) bulbs.push([0, y])
    let tick = 0

    const load = () => {
      phase = 'loading'
      deps.fortune().then((text) => {
        if (disposed) return
        // Two columns and rows in from the marquee on each side.
        const width = Math.min(term.cols - 8, 62)
        lines = wrap(text ?? 'the jar is empty', width)
        const widest = lines.reduce((n, l) => Math.max(n, l.length), 0)
        x0 = Math.max(2, (term.cols - widest) >> 1)
        y0 = Math.max(2, (term.rows - lines.length) >> 1)
        li = ci = 0
        blank(term)
        phase = 'typing'
      })
    }
    load()

    return {
      frame(t) {
        // The lights run through every phase — a sign does not go dark
        // between fortunes.
        tick++
        const step = (tick / 4) | 0 // ~7 chases a second
        for (let i = 0; i < bulbs.length; i++) {
          const [bx, by] = bulbs[i]!
          const lit = (i + step) % 3 === 0
          t.put(bx, by, lit ? 111 : 46, lit ? BRIGHT : DIM) // o / .
        }

        if (phase === 'typing') {
          const line = lines[li]
          if (line === undefined) {
            phase = 'holding'
            hold = 30 * 7 // seven seconds to read it, in ticks
            return
          }
          if (ci < line.length) {
            t.put(x0 + ci, y0 + li, line.charCodeAt(ci), NORMAL)
            ci++
          } else {
            li++; ci = 0
          }
        } else if (phase === 'holding' && --hold <= 0) {
          load()
        }
      },
      dispose() { disposed = true },
    }
  },
}

// --- the roster ------------------------------------------------------------

export const SAVERS: SaverSpec[] = [
  matrix, pipes, worms, rain, stars, life, fire, dvd, fortune,
]

// The names module is what CONFIG lists without loading this one; a saver
// added above without a name there would be pickable nowhere.
if (SAVERS.length !== SAVER_NAMES.length
    || SAVERS.some((s, i) => s.name !== SAVER_NAMES[i])) {
  throw new Error('saver roster out of step with SAVER_NAMES in saverdefs.ts')
}

/** By name, with the first as the fallback for a stale or unknown pref. */
export function pickSaver(name: string): SaverSpec {
  return SAVERS.find(s => s.name === name) ?? SAVERS[0]!
}

// --- the host --------------------------------------------------------------

/**
 * The screen every saver runs inside: rAF with a fixed-step accumulator, the
 * doom.ts dt clamp so a backgrounded tab does not simulate its whole absence
 * in one frame, and any key down means dismissed.
 */
export class SaverScreen implements Screen {
  /** How Shell recognises one without importing the class. See Shell.startSaver. */
  readonly isSaver = true

  private saver: Saver
  private raf = 0
  private prev = 0
  private acc = 0
  private started = false
  private active = true
  private done = false

  constructor(
    private term: Term,
    private spec: SaverSpec,
    private deps: SaverDeps,
    /** Called once on the first key. The owner pops; dispose() cleans up. */
    private onDismiss: () => void,
  ) {
    this.saver = spec.make(term, deps)
  }

  draw(term: Term) {
    // Called on push, and again after any consumed key — by which point the
    // key has already dismissed us and there is nothing to repaint.
    if (this.started) return
    this.started = true
    blank(term)
    if (this.spec.decay !== undefined) this.deps.setDecay(this.spec.decay)
    this.prev = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  private loop = (t: number) => {
    if (this.done || !this.active) return
    this.raf = requestAnimationFrame(this.loop)
    const step = 1 / this.spec.fps
    // The clamp keeps a backgrounded tab from simulating its whole absence in
    // one frame, but it must clear the step — capped below it, a saver slower
    // than 10fps would never accumulate a full one and simply freeze.
    this.acc = Math.min(this.acc + (t - this.prev) / 1000, Math.max(0.1, step * 2))
    this.prev = t
    while (this.acc >= step) {
      this.acc -= step
      this.saver.frame(this.term, step)
    }
  }

  onKey(e: KeyInput): boolean {
    if (!this.done) this.onDismiss()
    // The waking key is spent waking. Combos go back to the browser — Cmd+R
    // should still reload — but they wake the machine on the way past.
    return !e.metaKey && !e.altKey
  }

  /** Covered by a modal: stop simulating until revealed. */
  setActive(active: boolean) {
    this.active = active
    cancelAnimationFrame(this.raf)
    if (active && !this.done && this.started) {
      this.prev = performance.now()
      this.acc = 0
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  dispose() {
    this.done = true
    cancelAnimationFrame(this.raf)
    // Give the phosphor back BEFORE the snapshot underneath repaints, or the
    // restored screen smears for a beat with nothing left running to explain it.
    if (this.spec.decay !== undefined) this.deps.setDecay(null)
    this.saver.dispose?.()
  }
}

// --- the picker ------------------------------------------------------------

/** Name column width in the picker — the summaries hang off it. */
const NAME_W = 9
/** The `*` gutter marking the saver currently in force, plus its space. */
const MARK_W = 2

/**
 * `screensaver`. A list to arrow through; Enter is both the test and the
 * choice — it persists the pick and runs it on the spot, and the waking key
 * lands back on the list. The idle timer and the off switch live in CONFIG,
 * where the other machine settings are.
 */
