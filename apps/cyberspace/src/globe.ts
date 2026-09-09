// globe(1): the members of the network on a wireframe Earth.
//
// The 110m country outlines (app/public/world.bin, baked by tools/globe.ts)
// and a 15 degree graticule are rotated, projected and drawn as lines. Three
// bitmaps in three levels stand in for the website's back-face fade: front
// outlines NORMAL, the terminator DIM, the front graticule and back outlines
// FAINT; the limb and the pins BRIGHT. Land is filled at the CRT's ground
// level as a second bitmap plane, under the lines pixel for pixel. Members with a location are pins; Tab
// walks them, the selected pin is larger, named in the status rule, and Enter
// opens the member's card.
//
// Drawn at the face's resolution through picture handles (tui pixels.ts,
// pict.ts), so the host must have a picture bank.
//
// Frames are paints, not machine output, so they cost nothing at the baud
// rate. The tick is 50 ms; the spin matches the site's 0.0005 rad per frame
// at 60 Hz.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, PromptPopup, TextPopup, ConfirmPopup, YES_NO, RULE, PixelCanvas, rotate, project,
  frame, label, cells, wrap, parseKeys, keyHint,
  NORMAL, BRIGHT, BOLD, DIM, FAINT,
  type CellMetrics, type P3, type View, type Span, type TextLine, type Rect, type PixelFont,
} from '@cyberspace/tui'
import { ApiError, type ApiClient } from './api.js'
import { SILENT, type ChatSound } from './chat.js'
import { bioLines, fetchProfile, portraitFits, PFP_COLS, PFP_ROWS, type Portrait } from './bio.js'
import { when, type FeedProfile } from './feedutil.js'

export interface GlobeDeps {
  /** The baked outline file. See tools/globe.ts for the format. */
  world: () => Promise<Uint8Array>
  /** Cell geometry, read every frame: F1 can change the font under a running program. */
  metrics: () => CellMetrics
  /** The picture bank: one scope per run, released on exit. */
  pixels: () => GlobePixels
  /**
   * The smallest bitmap face the host has, for the label over the selected
   * pin. Undefined until loaded, and the label is not drawn.
   */
  tiny?: () => PixelFont | undefined
}

/** The part of the host's picture bank the globe uses. See app/src/image.ts. */
export interface GlobePixels {
  range(count: number): { base: number; count: number } | undefined
  set(codes: number[], bits: Uint16Array[]): void
  /** A picture rasterised now, for the portrait on a member's card. */
  load(src: string, key: string, maxCols: number, maxRows: number): Promise<{ lines: string[] }>
  slot(maxCols: number, maxRows: number, ratio?: number): number
  release(): void
}

/**
 * Handles for one frame's cell bitmaps.
 *
 * A code keeps its bitmap until a frame no longer uses it, so a cell the
 * renderer left unchanged still names the right picture: a code is only
 * reassigned after a frame in which no cell carried it, and that frame
 * repainted every cell that had. The range therefore holds two frames' worth,
 * the cells on screen and the cells being drawn.
 */
class HandlePool {
  private byKey = new Map<string, number>()
  private free: number[] = []
  private used = new Set<string>()
  private fresh: { codes: number[]; bits: Uint16Array[] } = { codes: [], bits: [] }

  constructor(private host: GlobePixels, range: { base: number; count: number }) {
    for (let i = range.count - 1; i >= 0; i--) this.free.push(range.base + i)
  }

  begin(): void {
    this.used.clear()
    this.fresh = { codes: [], bits: [] }
  }

  /** The handle for this bitmap, or undefined when the range is exhausted. */
  code(bits: Uint16Array): number | undefined {
    const key = String.fromCharCode(...bits)
    this.used.add(key)
    const have = this.byKey.get(key)
    if (have !== undefined) return have
    const code = this.free.pop()
    if (code === undefined) return undefined
    this.byKey.set(key, code)
    this.fresh.codes.push(code)
    this.fresh.bits.push(bits)
    return code
  }

  /** Send the new bitmaps and free the codes this frame did not use. */
  end(): void {
    if (this.fresh.codes.length) this.host.set(this.fresh.codes, this.fresh.bits)
    for (const [key, code] of this.byKey) {
      if (this.used.has(key)) continue
      this.byKey.delete(key)
      this.free.push(code)
    }
  }
}

/** One row of GET /v1/globe. */
export interface GlobePin {
  username: string
  lat: number
  lon: number
  name?: string
}

interface Pin extends GlobePin {
  p: P3
}

interface GlobeState {
  v: number
  yaw: number
  pitch: number
  zoom: number
  spin: boolean
  /** Whether the far side of the sphere is drawn. */
  back: boolean
  /** Whether the day/night terminator is drawn. */
  night: boolean
  sel?: string
}

const STATE_VERSION = 1
const TICK_MS = 50
/** The site's 0.0005 rad per frame at 60 Hz, per tick here. */
const SPIN = 0.0005 * 60 * TICK_MS / 1000
/** Turn per arrow key press at zoom 1, radians. Divided by the zoom, so a press moves the view by the same fraction of the screen at any magnification. */
const STEP = 0.06
/** Ticks an ease to a pin takes. */
const EASE_TICKS = 12
/** Share of the outstanding arrow turn applied per tick: an exponential ease, 95% in about 8 ticks. */
const TURN_EASE = 0.3
/** Below this many radians (a twentieth of a degree) the rest of an arrow turn is applied at once. */
const TURN_DONE = 1e-3
const ZOOM_MIN = 1
const ZOOM_MAX = 16
const ZOOM_STEP = 1.25
/** Fraction of the remaining zoom (in log space) applied per tick, and the remainder applied whole. */
const ZOOM_EASE = TURN_EASE
const ZOOM_DONE = 1e-3
/** Eye distance in model units. See View. */
const FOCAL = 6
/** The site's opening view: Europe and Africa, tilted down from the north. */
const YAW0 = -1.7
const PITCH0 = 0.6
/** Below this width the hint keeps only the movement keys and the status is dropped. */
const NARROW = 60
/** Quantum of the baked coordinates, degrees. See tools/globe.ts. */
const Q = 180
const GRATICULE_STEP = 15
/** Suggestions the find box shows. */
const FIND_ROWS = 8
/** Crosshair arm, and the gap at its centre, in pixels. */
const CROSS_ARM = 7
const CROSS_GAP = 3
/** Pin radius in pixels. */
const PIN_RADIUS = 2.2
/** Pixels between the top of the selected pin and its label. */
const LABEL_GAP = 3
/** Segments in the limb circle. */
const LIMB_SEGMENTS = 180
/** Front-facing test on the unit sphere with the eye at z = -FOCAL: see front(). */
const HORIZON = -1 / FOCAL

const HINT_TURN: Span[] = [{ text: ' ←↑↓→ ', inverse: true, attr: DIM }, { text: ' Turn ' }]
const HINT_ZOOM: Span[] = [{ text: ' -= ', inverse: true, attr: DIM }, { text: ' Zoom ' }]
const HINT_SPIN: Span[] = [{ text: ' S ', inverse: true, attr: DIM }, { text: ' Spin ' }]
const HINT_FIND: Span[] = [{ text: ' / ', inverse: true, attr: DIM }, { text: ' Find ' }]
const HINT_CARD: Span[] = [{ text: ' ↵ ', inverse: true, attr: DIM }, { text: ' Card ' }]
const HINT_SELECT: Span[] = [{ text: ' ↵ ', inverse: true, attr: DIM }, { text: ' Select ' }]
const HINT_HELP: Span[] = [{ text: ' ? ', inverse: true, attr: DIM }, { text: ' Help ' }]
/** The footer while a member's card is open: the card's own keys, nothing else. */
const HINT_MAIL: Span[] = [{ text: ' C ', inverse: true, attr: DIM }, { text: ' C-Mail ' }]
const HINT_POKE: Span[] = [{ text: ' P ', inverse: true, attr: DIM }, { text: ' Poke ' }]
const HINT_CLOSE: Span[] = [{ text: ' ESC ', inverse: true, attr: DIM }, { text: ' Close ' }]
const hintFollow = (following: boolean | undefined): Span[] =>
  [{ text: ' F ', inverse: true, attr: DIM }, { text: following === undefined ? ' ... ' : following ? ' Unfollow ' : ' Follow ' }]
/** Pages of the caller's following list read to learn whether a member is followed. 50 a page. */
const FOLLOW_PAGES = 10
/** On the top rule, right, beside the clock: the cap alone says enough. */
const HINT_EXIT: Span[] = [{ text: ' ESC ', inverse: true, attr: DIM }]
const POPUP_HINT = (...pairs: string[]): string => pairs.join('  ')

/** The site's mapping (lib/globe/geo-lines.ts): +y north, lon 0 towards -x. */
export function latLonToVector3(lat: number, lon: number, r = 1): P3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return [-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)]
}

export interface World {
  /** Polylines on the unit sphere: the borders. */
  arcs: P3[][]
  /** Land as rings of those same points: outside ring first, then holes. */
  polygons: P3[][][]
}

/** The baked file (tools/globe.ts). */
export function decodeWorld(bytes: Uint8Array): World {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const n = dv.getUint16(at, true); at += 2
  const arcs: P3[][] = []
  for (let i = 0; i < n; i++) {
    const len = dv.getUint16(at, true); at += 2
    const arc: P3[] = []
    for (let j = 0; j < len; j++) {
      const lat = dv.getInt16(at, true) / Q; at += 2
      const lon = dv.getInt16(at, true) / Q; at += 2
      arc.push(latLonToVector3(lat, lon))
    }
    arcs.push(arc)
  }
  const polygons: P3[][][] = []
  const np = dv.getUint16(at, true); at += 2
  for (let i = 0; i < np; i++) {
    const nr = dv.getUint8(at); at += 1
    const rings: P3[][] = []
    for (let r = 0; r < nr; r++) {
      const nref = dv.getUint16(at, true); at += 2
      const ring: P3[] = []
      for (let k = 0; k < nref; k++) {
        const ref = dv.getInt16(at, true); at += 2
        const arc = ref >= 0 ? arcs[ref]! : [...arcs[~ref]!].reverse()
        // Arcs meet end to start; the shared point is kept once.
        for (let q = ring.length ? 1 : 0; q < arc.length; q++) ring.push(arc[q]!)
      }
      rings.push(ring)
    }
    polygons.push(rings)
  }
  return { arcs, polygons }
}

/** Parallels every 15 degrees from -75 to 75, meridians every 15 from -180. */
export function graticule(): P3[][] {
  const lines: P3[][] = []
  for (let lat = -90 + GRATICULE_STEP; lat < 90; lat += GRATICULE_STEP) {
    const ring: P3[] = []
    for (let i = 0; i <= 72; i++) ring.push(latLonToVector3(lat, i * 5 - 180))
    lines.push(ring)
  }
  for (let lon = -180; lon < 180; lon += GRATICULE_STEP) {
    const arc: P3[] = []
    for (let i = 0; i <= 36; i++) arc.push(latLonToVector3(i * 5 - 90, lon))
    lines.push(arc)
  }
  return lines
}

/**
 * Direction of the sun on the unit sphere at `at` (ms since epoch).
 *
 * Declination from the day of the year by the cosine approximation, subsolar
 * longitude from the UTC hour with the sun over the meridian at 12:00. The
 * equation of time (up to 16 minutes, 4 degrees) is left out.
 */
export function sunAt(at: number): P3 {
  const d = new Date(at)
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  const day = (at - start) / 86_400_000
  const decl = -23.44 * Math.cos(2 * Math.PI * (day + 10) / 365)
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  return latLonToVector3(decl, (12 - hours) * 15)
}

/** Degrees between terminator points; every other segment is drawn, so a dash is this long. */
const TERMINATOR_STEP = 2

/** The great circle 90 degrees from the sun, as a closed polyline. */
export function terminator(sun: P3): P3[] {
  // A vector across the sun's direction, then a third across both, so the
  // circle is traced in the plane normal to the sun.
  const up: P3 = Math.abs(sun[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u = norm(cross(sun, up))
  const v = cross(sun, u)
  const ring: P3[] = []
  for (let i = 0; i <= 360 / TERMINATOR_STEP; i++) {
    const t = i * TERMINATOR_STEP * Math.PI / 180
    const c = Math.cos(t), s = Math.sin(t)
    ring.push([u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s])
  }
  return ring
}

const cross = (a: P3, b: P3): P3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: P3): P3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * The yaw and pitch that bring point p to the centre of the view, facing the
 * eye. The rotation is yaw about y then pitch about x (see tui vector.ts):
 * yaw puts p in the y-z plane on the near side (z = -rho, rho the distance
 * from the y axis), and pitch then turns it onto the axis. rho is never
 * negative, so the pitch is within +-90 degrees.
 */
export function lookAt(p: P3): { yaw: number; pitch: number } {
  const rho = Math.hypot(p[0], p[2])
  return { yaw: Math.atan2(p[0], -p[2]), pitch: Math.atan2(-p[1], rho) }
}

/**
 * Fill the land: each polygon's rings are rotated, cut to the near hemisphere
 * and projected, then filled by the even-odd rule with one crossing list per
 * row. The cut is Sutherland-Hodgman against the plane z = HORIZON, so a
 * ring that runs round the back closes along a chord just inside the limb.
 */
export function fillPolygons(c: { w: number; h: number; hspan(y: number, x0: number, x1: number): void },
                      polygons: P3[][][], v: View, aspect: number): void {
  const r: P3 = [0, 0, 0]
  for (const rings of polygons) {
    const edges: number[] = []  // x0, y0, x1, y1 per edge, in canvas coordinates
    let top = Infinity, bottom = -Infinity
    for (const ring of rings) {
      // Cut in 3D first: an edge crossing the horizon is replaced by its front part.
      const out: [number, number][] = []
      let prev = rotate(ring[ring.length - 1]!, v, [0, 0, 0])
      for (const p of ring) {
        const cur = rotate(p, v, r)
        const pin = prev[2] < HORIZON, cin = cur[2] < HORIZON
        if (pin !== cin) {
          const t = (HORIZON - prev[2]) / (cur[2] - prev[2])
          const m: P3 = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t, HORIZON]
          out.push(project(m, v, aspect))
        }
        if (cin) out.push(project(cur, v, aspect))
        prev = [cur[0], cur[1], cur[2]]
      }
      for (let i = 0; i < out.length; i++) {
        const a = out[i]!, b = out[(i + 1) % out.length]!
        if (a[1] === b[1]) continue
        edges.push(a[0], a[1], b[0], b[1])
        top = Math.min(top, a[1], b[1])
        bottom = Math.max(bottom, a[1], b[1])
      }
    }
    if (!edges.length) continue
    const y0 = Math.max(0, Math.ceil(top - 0.5)), y1 = Math.min(c.h - 1, Math.floor(bottom - 0.5))
    if (y1 < y0) continue
    // Crossings of each row's centre line, bucketed by row.
    const rows: number[][] = Array.from({ length: y1 - y0 + 1 }, () => [])
    for (let e = 0; e < edges.length; e += 4) {
      const ax = edges[e]!, ay = edges[e + 1]!, bx = edges[e + 2]!, by = edges[e + 3]!
      const lo = Math.min(ay, by), hi = Math.max(ay, by)
      const ys = Math.max(y0, Math.ceil(lo - 0.5)), ye = Math.min(y1, Math.floor(hi - 0.5))
      for (let y = ys; y <= ye; y++) {
        const cy = y + 0.5
        if (cy < lo || cy >= hi) continue
        rows[y - y0]!.push(ax + (cy - ay) / (by - ay) * (bx - ax))
      }
    }
    for (let y = y0; y <= y1; y++) {
      const xs = rows[y - y0]!
      if (xs.length < 2) continue
      xs.sort((a, b) => a - b)
      for (let i = 0; i + 1 < xs.length; i += 2) c.hspan(y, Math.round(xs[i]!), Math.round(xs[i + 1]!))
    }
  }
}

/** OR `from` into `into`, row by row. */
const orInto = (into: Uint16Array, from: Uint16Array | undefined): void => {
  if (from) for (let i = 0; i < into.length; i++) into[i]! |= from[i]!
}

/** Shortest signed turn from a to b, radians. */
const turn = (a: number, b: number): number => wrapAngle(b - a)

/** The same angle within (-pi, pi], so a parked yaw stays bounded. */
const wrapAngle = (a: number): number => {
  let d = a % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d <= -Math.PI) d += 2 * Math.PI
  return d
}

/**
 * A rotated point on the unit sphere faces the eye when the line to the eye
 * leaves the surface outward: (eye - r) . r > 0 with the eye at (0, 0, -FOCAL),
 * which reduces to r.z < -1/FOCAL.
 */
const front = (r: P3): boolean => r[2] < HORIZON

function readState(raw: unknown): Partial<GlobeState> {
  if (!raw || typeof raw !== 'object') return {}
  const s = raw as Record<string, unknown>
  if (s.v !== STATE_VERSION) return {}
  const num = (k: string): number | undefined => typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] as number : undefined
  return {
    yaw: num('yaw'), pitch: num('pitch'), zoom: num('zoom'),
    spin: typeof s.spin === 'boolean' ? s.spin : undefined,
    back: typeof s.back === 'boolean' ? s.back : undefined,
    night: typeof s.night === 'boolean' ? s.night : undefined,
    sel: typeof s.sel === 'string' ? s.sel : undefined,
  }
}

const hhmm = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function globeProgram(api: ApiClient, deps: GlobeDeps, snd: ChatSound = SILENT): Program {
  return async (p: Proc) => {
    if (!p.tty) { p.err('globe: no tty\n'); return 1 }
    const pixels = deps.pixels()
    const tty = p.tty
    const cols = tty.cols
    const rows = tty.rows
    const s = new Surface(cols, rows)
    const stack = new ScreenStack(s as never)
    const narrow = cols < NARROW
    let want = p.argv[1]?.replace(/^@/, '') || undefined

    p.out('Reading...')
    let world: World
    try {
      world = decodeWorld(await deps.world())
    } catch {
      p.err('\r\x1b[2Kglobe: world.bin: cannot read\n')
      return 1
    }
    const grid = graticule()

    const parked = readState(p.takeState())
    let yaw = parked.yaw ?? YAW0
    let pitch = parked.pitch ?? PITCH0
    let zoom = parked.zoom ?? ZOOM_MIN
    /** Where the zoom keys have sent the view; tick() eases `zoom` towards it. */
    let zoomTarget = zoom
    let spin = parked.spin ?? true
    /** Spin was on when the selection was made, and returns when it is cleared. */
    let spinHeld = false
    let showBack = parked.back ?? false
    let showNight = parked.night ?? true
    let ease: { yaw: number; pitch: number; left: number } | null = null
    /** Arrow turns not yet applied, eased in by tick(). */
    let pendYaw = 0
    let pendPitch = 0
    let pins: Pin[] = []
    let sel = -1
    /** Screen positions of the front-facing pins from the last frame, by pin index. */
    let onScreen: { i: number; x: number; y: number }[] = []
    let status = ''
    let running = true
    let quit = false
    /** The open member card, while there is one. `following` is unknown until the list is read. */
    let card: { profile: FeedProfile; popup: TextPopup; following?: boolean } | undefined

    const outer: Rect = { x: 0, y: 0, w: cols, h: rows }
    const inner: Rect = { x: 1, y: 1, w: cols - 2, h: rows - 2 }
    // Two frames of cells at most, see HandlePool. A bank that cannot spare
    // that many is treated as none.
    const range = pixels.range(Math.min(4096, inner.w * inner.h * 2))
    if (!range) { pixels.release(); p.err('globe: no room in the picture bank\n'); return 1 }
    const pool = new HandlePool(pixels, range)
    let canvases: PixelCanvas[] = []
    let metrics: CellMetrics | undefined

    const park = (): void => {
      p.setState({
        // A held spin parks as on, so a restore holds it again for the restored selection.
        v: STATE_VERSION, yaw, pitch, zoom: zoomTarget, spin: spin || spinHeld, back: showBack, night: showNight,
        ...(sel >= 0 && { sel: pins[sel]!.username }),
      } satisfies GlobeState)
    }

    const paint = (): void => {
      if (stack.active) return
      draw()
      tty.paint(s.render())
    }

    /** Select a pin. The spin stops for the selection and resumes when it is cleared. */
    const select = (i: number): void => {
      if (sel < 0 && spin) { spinHeld = true; spin = false }
      sel = i
    }

    const deselect = (): void => {
      sel = -1
      if (spinHeld) spin = true
      spinHeld = false
    }

    /** Turn towards a pin over EASE_TICKS and select it. */
    const goTo = (i: number): void => {
      select(i)
      const at = lookAt(pins[i]!.p)
      ease = { yaw: at.yaw, pitch: at.pitch, left: EASE_TICKS }
      status = ''
    }

    const findPin = (name: string): number =>
      pins.findIndex(x => x.username.toLowerCase() === name.toLowerCase())

    const draw = (): void => {
      const m = deps.metrics()
      if (!metrics || m.cellW !== metrics.cellW || m.cellH !== metrics.cellH || m.advance !== metrics.advance || m.stretch !== metrics.stretch) {
        metrics = m
        canvases = [0, 1, 2, 3, 4, 5, 6].map(() => new PixelCanvas(m, inner.w, inner.h))
      }
      // Pins have planes of their own so they move by the pixel with the
      // sphere; a character in a cell would step by the cell.
      const [land, back, grat, mid, fore, marks, lit] = canvases as [PixelCanvas, PixelCanvas, PixelCanvas, PixelCanvas, PixelCanvas, PixelCanvas, PixelCanvas]
      for (const c of canvases) c.clear()
      const aspect = back.aspect

      // The sphere fits the shorter axis with a margin of one cell each side.
      // At the silhouette the perspective factor is 1, so the projected radius
      // equals scale.
      const cellH = back.h / inner.h, cellW = back.w / inner.w
      const fit = Math.min(back.h / 2 - cellH, (back.w / 2 - cellW) / aspect)
      const view: View = { yaw, pitch, scale: fit * zoom, ox: back.w / 2, oy: back.h / 2, focal: FOCAL }
      const ra: P3 = [0, 0, 0]
      const rb: P3 = [0, 0, 0]

      const polyline = (line: P3[], onFront: PixelCanvas | null, onBack: PixelCanvas | null, dotted = false): void => {
        let prev = rotate(line[0]!, view, ra)
        let prevFront = front(prev)
        let prevXY = project(prev, view, aspect)
        for (let i = 1; i < line.length; i++) {
          const cur = rotate(line[i]!, view, i & 1 ? rb : ra)
          const curFront = front(cur)
          const xy = project(cur, view, aspect)
          // A segment crossing the horizon is dropped rather than split.
          if (!dotted || i & 1) {
            if (prevFront && curFront) onFront?.line(prevXY[0], prevXY[1], xy[0], xy[1])
            else if (!prevFront && !curFront) onBack?.line(prevXY[0], prevXY[1], xy[0], xy[1])
          }
          prev = cur
          prevFront = curFront
          prevXY = xy
        }
      }

      for (const line of grid) polyline(line, grat, null)
      if (showNight) polyline(terminator(sunAt(Date.now())), mid, null, true)
      for (const line of world.arcs) polyline(line, fore, showBack ? back : null)
      fillPolygons(land, world.polygons, view, aspect)

      // The limb. With the eye at FOCAL the silhouette is the circle at depth
      // -1/FOCAL, which projects to a radius of scale * FOCAL / sqrt(FOCAL^2 - 1).
      // Drawn BRIGHT: the face's bloom on that level is the glow.
      const limb = view.scale * FOCAL / Math.sqrt(FOCAL * FOCAL - 1)
      for (let i = 0, px = 0, py = 0; i <= LIMB_SEGMENTS; i++) {
        const t = i * 2 * Math.PI / LIMB_SEGMENTS
        const x = view.ox + Math.cos(t) * limb * aspect, y = view.oy + Math.sin(t) * limb
        if (i) lit.line(px, py, x, y)
        px = x; py = y
      }

      // Pins, front side only: a filled dot, full bright; the selected one is
      // larger. Radius in pixels, narrowed in y by the aspect so the dot is
      // round on the face.
      const r: P3 = [0, 0, 0]
      const pinName = pins[sel]?.username ?? ''
      const at: { tag?: { x: number; y: number } } = {}
      onScreen = []
      pins.forEach((pin, i) => {
        rotate(pin.p, view, r)
        if (!front(r)) return
        const [x, y] = project(r, view, aspect)
        onScreen.push({ i, x, y })
        const c = i === sel ? lit : marks
        const rx = PIN_RADIUS * (i === sel ? 1.8 : 1)
        const ry = rx / aspect
        for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
          for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
            if ((dx / rx) ** 2 + (dy / ry) ** 2 <= 1) c.plot(x + dx, y + dy)
          }
        }
        if (i === sel) at.tag = { x, y: y - ry }
      })

      // The crosshair at the centre, the aim for Enter. Gone while a pin is
      // selected: the ease brings that pin to the same spot.
      if (sel < 0) {
        const cx = Math.round(view.ox), cy = Math.round(view.oy)
        mid.line(cx - CROSS_ARM, cy, cx - CROSS_GAP, cy)
        mid.line(cx + CROSS_GAP, cy, cx + CROSS_ARM, cy)
        const ay = Math.round(CROSS_ARM / aspect), gy = Math.max(1, Math.round(CROSS_GAP / aspect))
        mid.line(cx, cy - ay, cx, cy - gy)
        mid.line(cx, cy + gy, cx, cy + ay)
      }

      // The name over the selected pin, set in the small face on a cleared
      // patch so the lines beneath do not run through the letters.
      const tiny = deps.tiny?.()
      if (at.tag && tiny) {
        const w = cells(pinName) * tiny.cellW, h = tiny.cellH
        const x = Math.round(Math.min(Math.max(1, at.tag.x - w / 2), lit.w - w - 1))
        const y = Math.round(Math.max(1, at.tag.y - LABEL_GAP - h))
        for (const c of [land, back, grat, mid, fore, marks]) c.erase(x - 2, y - 1, w + 4, h + 2)
        lit.erase(x - 2, y - 1, w + 4, h + 2)
        lit.text(x, y, pinName, tiny)
      }

      s.clear()
      frame(s, outer, DIM)
      // A cell has one glyph level, and the CRT bitmap two planes under it:
      // faint and ground (crt cellgrid.js putGlyph). The cell takes the level
      // of its brightest plane; NORMAL lines join a BRIGHT cell's main plane,
      // where the step is small, while FAINT and DIM lines go to the faint
      // plane so a pin or coast does not light the graticule through it.
      const levels: [PixelCanvas, number][] = [[back, FAINT], [grat, FAINT], [mid, DIM], [fore, NORMAL], [marks, BRIGHT], [lit, BRIGHT]]
      const bright = (a: number): boolean => a === NORMAL || a === BRIGHT
      {
        pool.begin()
        for (let cy = 0; cy < inner.h; cy++) {
          for (let cx = 0; cx < inner.w; cx++) {
            let main: Uint16Array | undefined
            let dim: Uint16Array | undefined
            let attr = NORMAL
            for (const [c, a] of levels) {
              const b = c.cell(cx, cy)
              if (!b) continue
              if (bright(a)) {
                if (main) orInto(b, main)
                main = b
              } else {
                if (dim) orInto(b, dim)
                dim = b
              }
              attr = a
            }
            // A cell with only dim lines is drawn at their level outright.
            if (!main && dim) { main = dim; dim = undefined }
            const under = land.cell(cx, cy)
            let bits = main
            if (bits && (dim || under)) {
              const n = bits.length
              const all = new Uint16Array(n * 3)
              all.set(bits)
              if (dim) all.set(dim, n)
              if (under) all.set(under, n * 2)
              bits = all
            } else if (!bits && under) {
              bits = new Uint16Array(under.length * 2)
              bits.set(under, under.length)
            }
            if (!bits) continue
            const code = pool.code(bits)
            if (code !== undefined) s.put(inner.x + cx, inner.y + cy, code, attr)
          }
        }
        pool.end()
      }

      label(s, outer, 'GLOBE', { attr: BOLD })
      const count = api.authed ? `${pins.length} member${pins.length === 1 ? '' : 's'}` : ''
      label(s, outer, [
        ...(count && !narrow ? [{ text: count }, { text: '  ' }] : []),
        // The clock doubles as the terminator's switch: lit while it is drawn. U toggles it.
        { text: ` ${hhmm(Date.now())} UTC `, inverse: showNight, attr: showNight ? DIM : NORMAL },
        ...(spin ? [] : [{ text: '  ' }, { text: ' HOLD ', inverse: true, attr: DIM }]),
        { text: '  ' }, ...HINT_EXIT,
      ], { align: 'right' })

      const pin = pins[sel]
      const left = status || (pin
        ? `@${pin.username}  ${pin.lat.toFixed(1)},${pin.lon.toFixed(1)}${pin.name ? '  ' + pin.name : ''}`
        : '')
      // On the last row inside the frame, over the picture, so the footer keeps
      // its whole width. A blank each side separates it from the lines beneath.
      if (left) {
        const text = ` ${left} `.slice(0, inner.w)
        s.text(inner.x, inner.y + inner.h - 1, text, pin && !status ? BRIGHT | BOLD : NORMAL)
      }

      drawFooter(pin !== undefined)
      s.showCursor = false
      yaw = wrapAngle(yaw)
      park()
    }

    const tick = (): void => {
      if (!running) return
      if (ease) {
        const k = 1 / ease.left
        yaw += turn(yaw, ease.yaw) * k
        pitch += (ease.pitch - pitch) * k
        if (--ease.left <= 0) ease = null
      } else if (spin) {
        yaw += SPIN
      }
      if (pendYaw || pendPitch) {
        const dy = Math.abs(pendYaw) < TURN_DONE ? pendYaw : pendYaw * TURN_EASE
        const dp = Math.abs(pendPitch) < TURN_DONE ? pendPitch : pendPitch * TURN_EASE
        yaw += dy
        pendYaw -= dy
        const next = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + dp))
        pendPitch = next === pitch + dp ? pendPitch - dp : 0
        pitch = next
      }
      if (zoom !== zoomTarget) {
        const r = zoomTarget / zoom
        zoom = Math.abs(Math.log(r)) < ZOOM_DONE ? zoomTarget : zoom * r ** ZOOM_EASE
      }
      paint()
    }

    const openFind = (): void => {
      stack.push(new PromptPopup({
        title: 'FIND MEMBER',
        prefix: '@',
        hint: POPUP_HINT('↵ Go', 'ESC Cancel'),
        bounds: inner,
        shadow: true,
        // From the pins, the members the globe can go to: a name the index
        // knows but the map does not would only be refused on Enter.
        suggest: async prefix => {
          const q = prefix.toLowerCase()
          const starts = pins.filter(x => x.username.toLowerCase().startsWith(q))
          const within = pins.filter(x => !x.username.toLowerCase().startsWith(q) && x.username.toLowerCase().includes(q))
          return [...starts, ...within].slice(0, FIND_ROWS).map(x => x.username)
        },
        onUpdate: () => tty.paint(s.render()),
        onFeedback: kind => {
          if (kind === 'edge') snd.beep(220, 0.04)
          else if (kind === 'move') snd.tick()
        },
        onDone: name => {
          stack.pop()
          s.invalidate()
          const who = name?.trim().replace(/^@/, '')
          if (who) {
            const i = findPin(who)
            if (i >= 0) {
              goTo(i)
              snd.blip(520, 0.09, 0)
            } else {
              status = `@${who}: no location`
              snd.beep(220, 0.12)
            }
          }
          paint()
        },
      }))
      tty.paint(s.render())
    }

    /**
     * The bottom rule. With a card open only the card's keys are offered; the
     * rest of the time whole groups go from the front until the rest fits, and
     * the keys left out are in the help box (the row is full at 80 columns).
     */
    const drawFooter = (selected: boolean): void => {
      const groups: Span[][] = card
        ? api.authed ? [HINT_MAIL, hintFollow(card.following), HINT_POKE, HINT_CLOSE] : [HINT_CLOSE]
        : [
          HINT_TURN,
          ...(api.authed ? [HINT_FIND] : []),
          ...(selected ? [HINT_CARD] : pins.length ? [HINT_SELECT] : []),
          HINT_ZOOM, HINT_SPIN, HINT_HELP,
        ]
      const width = (g: Span[][]): number => g.flat().reduce((n, sp) => n + cells(sp.text), 2)
      const budget = cols - 2
      while (groups.length > 1 && width(groups) > budget) groups.shift()
      // Cleared first: the rule is redrawn in place when the follow state arrives.
      s.text(outer.x + 1, outer.y + outer.h - 1, '─'.repeat(outer.w - 2), DIM)
      label(s, outer, groups.flat(), { edge: 'bottom', align: 'right', max: budget })
    }

    /** The result of a card action, in the card's rule; the popup is gone if the card closed meanwhile. */
    const report = (text: string): void => {
      if (!card) return
      card.popup.say(text)
      tty.paint(s.render())
    }

    const failure = (err: unknown): string =>
      err instanceof ApiError ? (err.code === 'NO_CARRIER' ? 'NO CARRIER' : err.message.toUpperCase()) : 'ERROR'

    /**
     * Whether the caller follows this member: the API has no flag for it, so
     * the caller's following list is read, a page at a time, until the member
     * turns up or FOLLOW_PAGES pages are exhausted (then taken as not followed).
     */
    const readFollowing = async (userId: string): Promise<boolean> => {
      let cursor: string | null = null
      for (let page = 0; page < FOLLOW_PAGES; page++) {
        const res: { rows: { followedId?: string }[]; cursor: string | null } =
          await api.page<{ followedId?: string }>(`/v1/follows?type=following&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        if (res.rows.some(r => r.followedId === userId)) return true
        cursor = res.cursor
        if (!cursor) break
      }
      return false
    }

    const toggleFollow = async (): Promise<void> => {
      const c = card
      if (!c || c.following === undefined) { snd.beep(220, 0.04); return }
      const them = c.profile.userId
      if (!them || them === api.userId) { snd.beep(220, 0.12); report(them ? 'THAT IS YOU' : 'NO ID'); return }
      snd.tick()
      try {
        if (c.following) {
          await api.delete(`/v1/follows/${encodeURIComponent(`${api.userId}_${them}`)}`)
          c.following = false
          report('UNFOLLOWED')
        } else {
          await api.post('/v1/follows', { followedId: them })
          c.following = true
          report('FOLLOWING')
        }
        snd.blip(520, 0.09, 0)
      } catch (err) {
        // Already following: the list was stale, and the state is now known.
        if (err instanceof ApiError && err.status === 409) c.following = true
        else if (err instanceof ApiError && err.status === 404 && c.following) c.following = false
        snd.beep(220, 0.12)
        report(failure(err))
      }
      if (card === c) { drawFooter(true); tty.paint(s.render()) }
    }

    /** Members poked in this run: one poke each, whatever the server would allow. */
    const poked = new Set<string>()

    const poke = async (): Promise<void> => {
      const c = card
      if (!c) return
      if (poked.has(c.profile.username)) { snd.beep(220, 0.12); report('ALREADY POKED'); return }
      snd.tick()
      try {
        await api.post(`/v1/users/${encodeURIComponent(c.profile.username)}/poke`, {})
        poked.add(c.profile.username)
        snd.blip(520, 0.09, 0)
        report('POKED')
      } catch (err) {
        snd.beep(220, 0.12)
        report(failure(err))
      }
    }

    /**
     * C-Mail with the member: the card closes and the shell is asked to run
     * cmail as its own job. The globe is stopped by the switch and comes back
     * through the switcher or its name. Under a shell without job control
     * there is nothing to switch to.
     */
    const openMail = (username: string): void => {
      if (!card) return
      card = undefined
      stack.pop()
      if (!p.kernel.jobs.fg) {
        status = 'cmail: no job control'
        snd.beep(220, 0.12)
        paint()
        return
      }
      void p.kernel.jobs.switchTo({ launch: `cmail @${username}` })
    }

    let cardLoading = false
    /** The member's card, as feed's B box: bio beside the portrait, facts under a rule. */
    const openCard = async (pin: Pin): Promise<void> => {
      if (cardLoading) return
      cardLoading = true
      status = 'LOADING'
      paint()
      snd.blip(520, 0.09, 0)
      const profile = await fetchProfile(api, pin.username)
      cardLoading = false
      if (!running || stack.active) return
      status = ''
      if (!profile) {
        status = 'NO PROFILE'
        snd.beep(220, 0.12)
        paint()
        return
      }
      const width = Math.max(24, Math.min(56, inner.w - 10))
      let portrait: Portrait | undefined
      if (profile.picture && portraitFits(width)) {
        portrait = { cols: PFP_COLS, rows: pixels.slot(PFP_COLS, PFP_ROWS, 1) }
        try {
          portrait.lines = (await pixels.load(profile.picture, profile.picture, PFP_COLS, PFP_ROWS)).lines
        } catch (err) {
          console.error('globe: portrait failed', err)
        }
        if (!running || stack.active) return
      }
      const site = profile.website?.url
      const popup: TextPopup = new TextPopup({
        title: `@${profile.username}`,
        note: profile.badges.length
          ? profile.badges.flatMap((b, i): Span[] => [
            ...(i ? [{ text: ' ' }] : []),
            { text: ` ${b} `, inverse: true, attr: DIM },
          ])
          : undefined,
        lines: bioLines(profile, profile.joined ? when(profile.joined) : undefined, width, portrait),
        // The card's keys are advertised on the globe's footer beneath, see drawFooter.
        hint: site ? POPUP_HINT('L Link') : undefined,
        actions: [
          ...(site ? [{ key: 'l', silent: true, run: () => { tty.copy(site); popup.say('COPIED'); tty.paint(s.render()) } }] : []),
          ...(api.authed ? [
            { key: 'c', silent: true, run: () => openMail(profile.username) },
            { key: 'f', silent: true, run: () => { void toggleFollow() } },
            { key: 'p', silent: true, run: () => { void poke() } },
          ] : []),
        ],
        bounds: inner,
        shadow: true,
        onFeedback: kind => {
          if (kind === 'edge') snd.beep(220, 0.04)
          else if (kind === 'move') snd.tick()
        },
        onDone: () => {
          card = undefined
          stack.pop()
          s.invalidate()
          paint()
        },
      })
      card = { profile, popup }
      // The footer is drawn before the push, so the snapshot beneath carries it.
      paint()
      stack.push(popup)
      tty.paint(s.render())
      if (api.authed && profile.userId) {
        const mine = card
        readFollowing(profile.userId).then(following => {
          if (card !== mine) return
          mine.following = following
          drawFooter(true)
          tty.paint(s.render())
        }).catch(() => {})
      }
    }

    const confirmQuit = (): void => {
      stack.push(new ConfirmPopup({
        title: 'EXIT',
        lines: ['Quit the globe?'],
        hint: YES_NO,
        bounds: inner,
        shadow: true,
        onFeedback: kind => { if (kind !== 'inert') snd.blip(420, 0.09, 0) },
        onDone: yes => {
          stack.pop()
          s.invalidate()
          if (yes) quit = true
          else paint()
        },
      }))
      tty.paint(s.render())
    }

    const openHelp = (): void => {
      // A second line continues under the first's text, past the key column.
      const keys: [string, string, string?][] = [
        ['←↑↓→', 'Turn'], ['- =', 'Zoom out, in'], ['S', 'Spin on, off'], ['F', 'Back face on, off'],
        ['U', 'Day/night line on, off'], ['TAB  N', 'Next member'], ['P', 'Previous member'], ['R', 'A member at random'],
        ['/', 'Find a member'], ['↵', 'Select the member under the crosshair', 'Card, once selected'],
        ['ESC', 'Deselect; then exit'], ['Q', 'Exit'],
        ['C  F  P', 'On the card: C-Mail, follow or unfollow, poke'],
      ]
      const KEY_W = 6
      stack.push(new TextPopup({
        title: 'GLOBE',
        lines: keys.flatMap(([k, what, more]): TextLine[] => [
          keyHint([[k.padEnd(KEY_W), what]]),
          ...(more ? [' '.repeat(KEY_W + 1) + more] : []),
        ]),
        hint: POPUP_HINT('ESC Close'),
        bounds: inner,
        shadow: true,
        onFeedback: kind => { if (kind === 'edge') snd.beep(220, 0.04) },
        onDone: () => {
          stack.pop()
          s.invalidate()
          paint()
        },
      }))
      tty.paint(s.render())
    }

    const onKey = (k: { key: string; ctrlKey: boolean }): 'quit' | void => {
      if (k.key === 'q' || k.key === 'Q') return 'quit'
      if (k.key === 'Escape') {
        // A selection is undone first; a second Escape asks.
        if (sel >= 0) { deselect(); status = ''; paint(); return }
        confirmQuit()
        return
      }
      switch (k.key) {
        // Arrows drag the surface: left brings what is to the right into view.
        // The turn is queued and eased in by tick(); held keys add up.
        case 'ArrowLeft': pendYaw += STEP / zoomTarget; ease = null; break
        case 'ArrowRight': pendYaw -= STEP / zoomTarget; ease = null; break
        case 'ArrowUp': pendPitch -= STEP / zoomTarget; ease = null; break
        case 'ArrowDown': pendPitch += STEP / zoomTarget; ease = null; break
        // Zoom moves the target; tick() eases the view to it, so held keys add up.
        case '-': case '_':
          if (zoomTarget <= ZOOM_MIN) snd.beep(220, 0.04)
          zoomTarget = Math.max(ZOOM_MIN, zoomTarget / ZOOM_STEP)
          break
        case '=': case '+':
          if (zoomTarget >= ZOOM_MAX) snd.beep(220, 0.04)
          zoomTarget = Math.min(ZOOM_MAX, zoomTarget * ZOOM_STEP)
          break
        // Explicit, so a later deselect leaves the choice alone.
        case 's': case 'S': spin = !spin; spinHeld = false; break
        case 'f': case 'F': showBack = !showBack; break
        case 'u': case 'U': showNight = !showNight; break
        case 'Tab': case 'n': case 'N':
          if (!pins.length) { snd.beep(220, 0.04); break }
          snd.tick()
          goTo((sel + 1) % pins.length)
          break
        case 'p': case 'P':
          if (!pins.length) { snd.beep(220, 0.04); break }
          snd.tick()
          goTo((sel - 1 + pins.length) % pins.length)
          break
        case 'r': case 'R': {
          // Any pin but the current one.
          if (pins.length < 2 && !(pins.length === 1 && sel < 0)) { snd.beep(220, 0.04); break }
          let i = Math.floor(Math.random() * pins.length)
          if (i === sel) i = (i + 1) % pins.length
          snd.tick()
          goTo(i)
          break
        }
        case '/':
          if (!api.authed) { status = 'find: login'; snd.beep(220, 0.12); break }
          openFind()
          return
        case '?':
          openHelp()
          return
        case 'Enter': {
          if (sel >= 0) { void openCard(pins[sel]!); return }
          // Nearest front-facing pin to the crosshair.
          const ox = inner.w * (metrics?.advance ?? 1) / 2, oy = inner.h * (metrics?.cellH ?? 1) / 2
          let best = -1, bestD = Infinity
          for (const { i, x, y } of onScreen) {
            const d = (x - ox) ** 2 + (y - oy) ** 2
            if (d < bestD) { bestD = d; best = i }
          }
          if (best < 0) { snd.beep(220, 0.04); return }
          snd.tick()
          goTo(best)
          paint()
          return
        }
      }
      paint()
    }

    tty.setRaw()
    tty.silence(['Tab', 'Enter'])
    p.out('\r\x1b[2K\x1b[?1049h')
    s.invalidate()
    p.setResume(want ? `globe @${want}` : 'globe')

    let timer = setInterval(tick, TICK_MS)
    p.onStop = () => clearInterval(timer)
    p.onCont = () => {
      timer = setInterval(tick, TICK_MS)
      s.invalidate()
      paint()
    }
    // `globe @user` typed while this run exists: turn to the member. Before
    // the pins arrive the name waits for the load, as an argument does.
    p.onArgs = argv => {
      const who = argv[1]?.replace(/^@/, '')
      if (!who) return
      if (!pins.length) { want = who; return }
      const i = findPin(who)
      if (i >= 0) goTo(i)
      else { status = `@${who}: no location`; snd.beep(220, 0.12) }
      p.setResume(`globe @${who}`)
    }
    try {
      paint()
      if (api.authed) {
        api.get<GlobePin[]>('/v1/globe').then(rows => {
          if (!running) return
          pins = rows
            .filter(r => typeof r.username === 'string' && Number.isFinite(r.lat) && Number.isFinite(r.lon))
            .sort((a, b) => a.username.localeCompare(b.username))
            .map(r => ({ ...r, p: latLonToVector3(r.lat, r.lon) }))
          const first = want ?? parked.sel
          if (first) {
            const i = findPin(first)
            if (i >= 0) {
              // A parked selection is restored in place; an argument turns to it.
              if (want) goTo(i)
              else select(i)
            } else if (want) {
              status = `@${want}: no location`
              snd.beep(220, 0.12)
            }
          }
          paint()
        }).catch(() => {
          if (!running) return
          status = 'pins: NO CARRIER'
          paint()
        })
      } else {
        status = 'pins: login'
      }

      for (;;) {
        const chunk = await tty.stdin.read()
        if (chunk === null) return 0
        for (const k of parseKeys(dec.decode(chunk))) {
          if (k.ctrlKey && k.key === 'c') return 130
          if (stack.active) {
            stack.key(k)
            if (quit) return 0
            tty.paint(s.render())
            continue
          }
          if (onKey(k) === 'quit') return 0
        }
      }
    } finally {
      running = false
      clearInterval(timer)
      pixels?.release()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
