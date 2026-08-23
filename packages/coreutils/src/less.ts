// less — page through a file, or through stdin.
//
// cat writes a file to the scrollback at the output rate, which is impractical
// for a long one. This takes the grid instead, paints a screenful at a time and
// restores the screen on exit.

import { dec, readAll, type Proc, type Program, readText } from '@cyberspace/kernel'
import { Surface, Pager, fold, parseKeys } from '@cyberspace/tui'
import { fsp, resolve } from './util.js'

export const less: Program = async p => {
  const name = p.argv[1]

  // No tty is not an error: `less file | head` and `cmd | less > out` both
  // mean cat, and that is what every pager does when its output is a pipe.
  if (!p.tty) return pour(p, name)

  let text: string
  if (name) {
    const path = resolve(p, name)
    const st = await fsp.stat(path).catch(() => null)
    if (!st) {
      p.err(`less: ${name}: No such file or directory\n`)
      return 1
    }
    if (st.isDirectory()) {
      p.err(`less: ${name}: Is a directory\n`)
      return 1
    }
    text = await readText(path)
  } else if (!p.stdin.isInteractive) {
    text = await readAll(p.stdin)
  } else {
    p.err('usage: less file\n')
    return 1
  }

  const cols = p.tty.cols
  const rows = p.tty.rows
  const s = new Surface(cols, rows)

  // Folded once, before the input loop, so a row means the same thing to the
  // navigation keys and to every paint.
  const lines = fold(text, cols).map(f => text.slice(f.start, f.start + f.len).replace(/\t/g, '    '))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  let done = false
  const pager = new Pager({
    lines,
    name: name ?? '(stdin)',
    onDone: () => { done = true },
  })

  const paint = (): void => {
    pager.draw(s)
    p.tty!.paint(s.render())
  }

  // Keys come from the terminal, never from stdin: under `cmd | less` stdin is
  // the pipe, and it is at EOF the moment the text has been read.
  const keys = p.stdin.isInteractive ? p.stdin : p.tty.stdin

  p.tty.setRaw()
  p.out('\x1b[?1049h')
  s.invalidate()

  try {
    paint()
    for (;;) {
      const chunk = await keys.read()
      if (chunk === null) return 0
      for (const k of parseKeys(dec.decode(chunk))) {
        if (k.ctrlKey && k.key === 'c') return 130
        pager.onKey(k)
        if (done) return 0
      }
      paint()
    }
  } finally {
    p.out('\x1b[?1049l\x1b[?25h')
    p.tty.setCooked()
  }
}

/** No grid available, so behave as cat. */
async function pour(p: Proc, name?: string): Promise<number> {
  if (!name) {
    p.out(await readAll(p.stdin))
    return 0
  }
  try {
    p.out(await readText(resolve(p, name)))
    return 0
  } catch {
    p.err(`less: ${name}: No such file or directory\n`)
    return 1
  }
}
