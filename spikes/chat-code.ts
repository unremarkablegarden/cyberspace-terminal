// Inline `code` in chat entries, wide and narrow layouts: backticks removed,
// the run spanned on the dim background, a lone backtick left as text.
// Run: bun spikes/chat-code.ts

import { entryLines, narrowLines, type ChatMessage } from '../apps/cyberspace/src/chat.ts'
import { BG } from '../packages/tui/src/attrs.ts'

let fail = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

const msg = (content: string): ChatMessage =>
  ({ username: 'ann', content, timestamp: Date.UTC(2026, 10, 25, 12, 0) }) as ChatMessage

for (const [name, lay, width] of [['wide', entryLines, 80], ['narrow', narrowLines, 40]] as const) {
  const rows = lay(msg('run `ls -la` now'), width, { code: true })
  const text = rows.map(r => r.text).join('\n')
  const coded = rows.flatMap(r => (r.spans ?? []).filter(sp => sp.attr & BG).map(sp => r.text.slice(sp.at, sp.at + sp.len)))
  ok(`${name}: backticks removed`, text.includes('run ls -la now') && !text.includes('`'), text)
  ok(`${name}: the run on the dim background`, coded.join('') === 'ls -la', JSON.stringify(coded))
  const lone = lay(msg('a ` b'), width, { code: true }).map(r => r.text).join('\n')
  ok(`${name}: a lone backtick stays`, lone.includes('a ` b'), lone)
  const off = lay(msg('run `ls`'), width, {}).map(r => r.text).join('\n')
  ok(`${name}: without the option, text as typed`, off.includes('`ls`'))
}

console.log(fail ? `\n${fail} failed` : '\nall ok')
process.exit(fail ? 1 : 0)
