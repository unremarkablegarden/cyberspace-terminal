// Renders the real /etc/motd for a member and for a guest, decoding the beam
// level back the way app/src/vt.ts does so the attributes can be eyeballed.
import { configure, fs, InMemory } from '@zenfs/core'
import { writeMotd } from '../app/src/motd.ts'
import { INDEX_LEVEL, BRIGHT, BOLD, DIM, MUTED, FAINT, NORMAL } from '../packages/tui/src/attrs.ts'

await configure({ mounts: { '/': InMemory } })
await fs.promises.mkdir('/etc')

const NAMES: Record<number, string> = { [BRIGHT]: 'BRIGHT', [DIM]: 'DIM', [MUTED]: 'MUTED', [FAINT]: 'FAINT', [NORMAL]: '' }
const mark = (s: string) => s.replace(/\x1b\[([\d;]*)m/g, (_, body) => {
  const parts = String(body).split(';').map(Number)
  const i = parts.indexOf(38)
  const level = i >= 0 ? INDEX_LEVEL[parts[i + 2]] ?? NORMAL : NORMAL
  const bits = [NAMES[level], parts.includes(1) ? 'BOLD' : ''].filter(Boolean).join('|')
  return bits ? `<${bits}>` : '<->'
})

for (const user of ['genghis_khan', null]) {
  await writeMotd(user)
  const text = await fs.promises.readFile('/etc/motd', 'utf8')
  console.log(`=== ${user ?? 'guest'} — ${text.length} bytes, longest line ${Math.max(...text.split('\n').map(l => l.length))} ===`)
  console.log(text.replace(/\x1b\[[\d;]*m/g, ''))
  console.log('--- attributes ---')
  console.log(mark(text).split('\n').slice(0, 8).join('\n'))
}
