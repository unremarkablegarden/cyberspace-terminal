// Bakes the 110m country outlines into app/public/world.bin for globe(1).
//
// Source is the world-atlas topojson in the main site's repo. The arcs are
// the wireframe: an arc is one border shared by the countries either side, so
// the arc list has every line once. The polygons are kept as lists of arc
// references, topojson's own encoding, so the land fill has rings without a
// second copy of the points. Names are dropped.
//
// Format, little-endian: u16 arc count, then per arc u16 point count followed
// by that many (i16 lat, i16 lon) pairs in degrees x 180. The quantum is 1/180
// of a degree, about 600 m, well under a dot at any zoom this display offers.
// Then u16 polygon count, and per polygon u8 ring count followed by each ring
// as u16 reference count and that many i16 arc references, where a negative
// reference ~i is arc i reversed. The first ring is the outside, the rest are
// holes.
//
// Run: bun tools/globe.ts

const ROOT = new URL('..', import.meta.url).pathname
const SRC = `${ROOT}../nuxt/public/world-atlas/countries-110m.json`
const OUT = `${ROOT}app/public/world.bin`
const Q = 180

interface Topology {
  transform: { scale: [number, number]; translate: [number, number] }
  arcs: number[][][]
  objects: { countries: { geometries: { type: string; arcs: number[][] | number[][][] }[] } }
}

const topo = await Bun.file(SRC).json() as Topology
const { scale, translate } = topo.transform

// Topojson arcs are delta-encoded quantised integers: each point is the sum of
// the deltas before it, then scaled and translated to degrees.
const arcs: [number, number][][] = topo.arcs.map(arc => {
  let x = 0, y = 0
  return arc.map(([dx, dy]) => {
    x += dx!
    y += dy!
    return [y * scale[1] + translate[1], x * scale[0] + translate[0]]
  })
})

// Every polygon of every feature, outside ring first. MultiPolygons flatten.
const polygons: number[][][] = []
for (const g of topo.objects.countries.geometries) {
  if (g.type === 'Polygon') polygons.push(g.arcs as number[][])
  else if (g.type === 'MultiPolygon') for (const poly of g.arcs as number[][][]) polygons.push(poly)
}
const refs = polygons.reduce((n, poly) => n + poly.reduce((m, r) => m + r.length, 0), 0)
const rings = polygons.reduce((n, poly) => n + poly.length, 0)

const points = arcs.reduce((n, a) => n + a.length, 0)
const buf = new ArrayBuffer(2 + arcs.length * 2 + points * 4 + 2 + polygons.length + rings * 2 + refs * 2)
const dv = new DataView(buf)
let at = 0
dv.setUint16(at, arcs.length, true); at += 2
for (const arc of arcs) {
  dv.setUint16(at, arc.length, true); at += 2
  for (const [lat, lon] of arc) {
    dv.setInt16(at, Math.round(lat * Q), true); at += 2
    dv.setInt16(at, Math.round(lon * Q), true); at += 2
  }
}

dv.setUint16(at, polygons.length, true); at += 2
for (const poly of polygons) {
  dv.setUint8(at, poly.length); at += 1
  for (const r of poly) {
    dv.setUint16(at, r.length, true); at += 2
    for (const ref of r) { dv.setInt16(at, ref, true); at += 2 }
  }
}

await Bun.write(OUT, buf)
console.log(`${arcs.length} arcs, ${points} points, ${polygons.length} polygons, ${rings} rings, ${buf.byteLength} bytes -> ${OUT}`)
