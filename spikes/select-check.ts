// Selection + clipboard behaviour of the shared text widgets.
// Run: bun spikes/select-check.ts
import { InputLine } from '../packages/tui/src/input.ts'
import { TextBuffer } from '../packages/tui/src/buffer.ts'
import type { KeyInput } from '../packages/tui/src/keys.ts'

let fail = 0
const eq = (label: string, got: unknown, want: unknown): void => {
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}
const K = (key: string, m: Partial<KeyInput> = {}): KeyInput =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m })
const type = (w: { onKey?(e: KeyInput): unknown; key?(e: KeyInput): unknown }, s: string): void => {
  for (const ch of s) (w.onKey ?? w.key!).call(w, K(ch))
}

// InputLine: shift+Home selects the line, copy captures it, a printable replaces it.
{
  let clip = ''
  const inp = new InputLine({ clipboard: t => { clip = t } })
  type(inp, 'hello world')
  inp.onKey(K('Home', { shiftKey: true }))
  inp.onKey(K('c', { ctrlKey: true, shiftKey: true }))
  eq('InputLine copy whole line', clip, 'hello world')
  inp.onKey(K('z'))
  eq('InputLine type replaces selection', inp.value, 'z')
}

// InputLine: shift+Left builds a selection, cut copies and removes it.
{
  let clip = ''
  const inp = new InputLine({ clipboard: t => { clip = t } })
  type(inp, 'abcdef')
  inp.onKey(K('ArrowLeft', { shiftKey: true }))
  inp.onKey(K('ArrowLeft', { shiftKey: true }))
  inp.onKey(K('x', { ctrlKey: true, shiftKey: true }))
  eq('InputLine cut copies', clip, 'ef')
  eq('InputLine cut deletes', inp.value, 'abcd')
}

// InputLine: ctrl+shift+Left selects a word.
{
  let clip = ''
  const inp = new InputLine({ clipboard: t => { clip = t } })
  type(inp, 'foo bar baz')
  inp.onKey(K('ArrowLeft', { ctrlKey: true, shiftKey: true }))
  inp.onKey(K('c', { ctrlKey: true, shiftKey: true }))
  eq('InputLine word select', clip, 'baz')
}

// InputLine: paste (insert) over a selection replaces it.
{
  const inp = new InputLine()
  type(inp, 'abcdef')
  inp.onKey(K('Home', { shiftKey: true }))
  inp.insert('XY')
  eq('InputLine paste replaces selection', inp.value, 'XY')
}

// TextBuffer: shift+End selects the first row, copy captures it, a printable replaces it.
{
  let clip = ''
  const buf = new TextBuffer({ initial: 'line one\nline two', clipboard: t => { clip = t } })
  buf.key(K('End', { shiftKey: true }))
  buf.key(K('c', { ctrlKey: true, shiftKey: true }))
  eq('TextBuffer copy row', clip, 'line one')
  buf.key(K('x'))
  eq('TextBuffer type replaces selection', buf.text, 'x\nline two')
}

// TextBuffer: cut removes the selection.
{
  let clip = ''
  const buf = new TextBuffer({ initial: 'hello', clipboard: t => { clip = t } })
  buf.key(K('End', { shiftKey: true }))
  buf.key(K('x', { ctrlKey: true, shiftKey: true }))
  eq('TextBuffer cut copies', clip, 'hello')
  eq('TextBuffer cut deletes', buf.text, '')
}

console.log(fail ? `\n${fail} FAILED` : '\nall ok')
if (fail) process.exit(1)
