// globe(1) maths and data: world.bin decodes to the topojson's counts, every
// point is on the unit sphere, lookAt centres a point, the terminator is 90
// degrees from the sun, and the sun sits over the expected meridian.
// Run: bun spikes/globe-check.ts

import { decodeWorld, graticule, latLonToVector3, lookAt, sunAt, terminator } from '../apps/cyberspace/src/globe.ts'
import { PixelCanvas } from '../packages/tui/src/pixels.ts'
import { rotate } from '../packages/tui/src/vector.ts'
import type { P3, View } from '../packages/tui/src/vector.ts'

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps
const len = (p: P3) => Math.hypot(p[0], p[1], p[2])
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// --- data --------------------------------------------------------------------
const ROOT = new URL('..', import.meta.url).pathname
const topo = await Bun.file(`${ROOT}../nuxt/public/world-atlas/countries-110m.json`).json()
const bytes = new Uint8Array(await Bun.file(`${ROOT}app/public/world.bin`).arrayBuffer())
const { arcs: world, polygons } = decodeWorld(bytes)
ok('arc count matches topojson', world.length === topo.arcs.length, `${world.length}`)
ok('point count matches topojson', world.reduce((n, a) => n + a.length, 0) === topo.arcs.reduce((n: number, a: unknown[]) => n + a.length, 0))
ok('every point on the unit sphere', world.every(a => a.every(p => near(len(p), 1, 1e-9))))
ok('file is under 40 KB', bytes.byteLength < 40_000, `${bytes.byteLength}`)
{
  const feats = topo.objects.countries.geometries
  const want = feats.reduce((n: number, g: { type: string; arcs: unknown[] }) => n + (g.type === 'Polygon' ? 1 : g.arcs.length), 0)
  ok('polygon count matches the atlas', polygons.length === want, `${polygons.length}`)
  ok('every ring closes on itself', polygons.every(poly => poly.every(r => r[0]!.every((v, i) => Math.abs(v - r[r.length - 1]![i]!) < 1e-9))))
}

// Spot check: the first point of the first arc against a direct decode.
{
  const { scale, translate } = topo.transform
  const [dx, dy] = topo.arcs[0][0]
  const lat = dy * scale[1] + translate[1], lon = dx * scale[0] + translate[0]
  const want = latLonToVector3(Math.round(lat * 180) / 180, Math.round(lon * 180) / 180)
  ok('first point decodes', world[0]![0]!.every((v, i) => near(v, want[i]!, 1e-9)))
}

ok('graticule: 11 parallels + 24 meridians', graticule().length === 35)

// --- lookAt ------------------------------------------------------------------
const view = (yaw: number, pitch: number): View => ({ yaw, pitch, scale: 1, ox: 0, oy: 0, focal: 6 })
const spots: [number, number][] = [[0, 0], [51.5, -0.1], [-33.9, 151.2], [64.1, -21.9], [-90, 0], [90, 0], [0, 180], [-45, -170]]
let centred = true
for (const [lat, lon] of spots) {
  const p = latLonToVector3(lat, lon)
  const { yaw, pitch } = lookAt(p)
  const r = rotate(p, view(yaw, pitch), [0, 0, 0])
  const hit = near(r[0], 0, 1e-9) && near(r[1], 0, 1e-9) && near(r[2], -1, 1e-9)
  const inRange = Math.abs(pitch) <= Math.PI / 2 + 1e-9
  if (!hit || !inRange) { centred = false; console.log('   ', lat, lon, r, { yaw, pitch }) }
}
ok('lookAt centres each spot facing the eye, pitch within +-90', centred)

// --- land fill ---------------------------------------------------------------
{
  const { fillPolygons } = await import('../apps/cyberspace/src/globe.ts') as { fillPolygons: Function }
  const c = new PixelCanvas({ cellW: 8, cellH: 16, advance: 9, stretch: 1 }, 78, 23)
  const at = lookAt(latLonToVector3(10, 15))
  const v: View = { yaw: at.yaw, pitch: at.pitch, scale: 170, ox: c.w / 2, oy: c.h / 2, focal: 6 }
  fillPolygons(c, polygons, v, 1)
  const { project } = await import('../packages/tui/src/vector.ts')
  const lit = (lat: number, lon: number): boolean => {
    const [x, y] = project(rotate(latLonToVector3(lat, lon), v, [0, 0, 0]), v, 1)
    return c.lit(x, y)
  }
  const cellFull = (lat: number, lon: number): boolean => {
    const [x, y] = project(rotate(latLonToVector3(lat, lon), v, [0, 0, 0]), v, 1)
    return c.count(Math.floor(x / 9), Math.floor(y / 16)) === 128
  }
  ok('fill: Sahara cell fully land', cellFull(25, 10))
  ok('fill: Congo basin land', lit(0, 22))
  ok('fill: Arabian peninsula land (cut by the horizon)', lit(22, 45))
  ok('fill: Gulf of Guinea sea', !lit(-2, 2))
  ok('fill: mid-Atlantic sea', !lit(10, -30))
  ok('fill: Mediterranean sea', !lit(35, 18))
  ok('fill: back of the sphere empty', !lit(-25, 135))
}

// --- handedness: east is to the right ---------------------------------------
{
  const { project } = await import('../packages/tui/src/vector.ts')
  const mid = lookAt(latLonToVector3(45, -40))
  const v = view(mid.yaw, mid.pitch)
  const ny = project(rotate(latLonToVector3(40.7, -74), v, [0, 0, 0]), v, 1)
  const ldn = project(rotate(latLonToVector3(51.5, -0.1), v, [0, 0, 0]), v, 1)
  ok('New York projects left of London', ny[0] < ldn[0], `${ny[0].toFixed(3)} < ${ldn[0].toFixed(3)}`)
}

// --- sun and terminator ------------------------------------------------------
{
  const noon = Date.UTC(2026, 2, 20, 12, 0)  // equinox, noon UTC
  const s = sunAt(noon)
  const expect = latLonToVector3(0, 0)
  ok('equinox noon: sun over lat 0 lon 0 (within 1 degree)', dot(s, expect) > Math.cos(Math.PI / 180), `${s}`)
  const six = sunAt(Date.UTC(2026, 2, 20, 18, 0))
  ok('18:00 UTC: sun over lon -90', dot(six, latLonToVector3(0, -90)) > Math.cos(Math.PI / 180))
  const june = sunAt(Date.UTC(2026, 5, 21, 12, 0))
  const lat = Math.asin(june[1]) * 180 / Math.PI
  ok('solstice: declination near +23.4', Math.abs(lat - 23.44) < 0.5, lat.toFixed(2))

  const ring = terminator(s)
  ok('terminator: 181 points, all 90 degrees from the sun, on the sphere',
    ring.length === 181 && ring.every(p => near(dot(p, s), 0, 1e-9) && near(len(p), 1, 1e-9)))
}

console.log(fail ? `\n${fail} FAILED` : '\nall ok')
process.exit(fail ? 1 : 0)
