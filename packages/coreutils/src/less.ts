// less — page through a file, or through stdin.
//
// cat pours a file onto the scrollback at the line's rate, which is right for a
// short one and useless for anything long. A pager takes the grid instead,
// paints a screenful at a time and hands it back untouched.

import { dec, readAll, type Proc, type Program, readText } from '@cyberspace/kernel'
import { Surface, fold, parseKeys, DIM, BOLD } from '@cyberspace/tui'
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
  const view = rows - 1
  const s = new Surface(cols, rows)

  // Folded once, here: a row is what the keys move through, so it has to mean
  // the same thing on every paint.
  const lines = fold(text, cols).map(f => text.slice(f.start, f.start + f.len).replace(/\t/g, '    '))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  const max = Math.max(0, lines.length - view)
  let top = 0

  const paint = (): void => {
    s.clear()
    for (let i = 0; i < view; i++) {
      const line = lines[top + i]
      if (line === undefined) break
      s.text(0, i, line)
    }

    const end = top >= max
    const pct = lines.length <= view ? 'ALL' : end ? 'END' : `${Math.round((top / max) * 100)}%`
    const left = ` ${name ?? '(stdin)'} `
    const right = `SPACE b  g G   Q quit   ${pct} `
    const gap = Math.max(1, cols - left.length - right.length)
    s.text(0, rows - 1, (left + ' '.repeat(gap) + right).slice(0, cols).padEnd(cols),
           end ? DIM | BOLD : DIM, 1)
    s.showCursor = false
    p.tty!.paint(s.render())
  }

  const step = (delta: number): void => {
    const next = Math.min(max, Math.max(0, top + delta))
    if (next === top) return
    top = next
    paint()
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
        switch (k.key) {
          case 'q': case 'Q': case 'Escape': return 0
          case 'ArrowDown': case 'j': case 'Enter': step(1); break
          case 'ArrowUp': case 'k': step(-1); break
          case ' ': case 'f': case 'PageDown': step(view); break
          case 'b': case 'PageUp': step(-view); break
          case 'd': step(Math.floor(view / 2)); break
          case 'u': step(-Math.floor(view / 2)); break
          case 'g': case 'Home': step(-lines.length); break
          case 'G': case 'End': step(lines.length); break
          // Everything else is swallowed: an unhandled key would otherwise
          // reach a shell the reader cannot see.
        }
      }
    }
  } finally {
    p.out('\x1b[?1049l\x1b[?25h')
    p.tty.setCooked()
  }
}

/** No grid to take: behave as cat. */
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
