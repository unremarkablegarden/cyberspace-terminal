// edit — full-screen text editor, nano keys: ^O write, ^X exit, ^K cut line.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import { Surface, TextBuffer, drawBuffer, parseKeys, DIM, INVERSE, BOLD } from '@cyberspace/tui'
import { fsp, resolve } from './util.js'

export const edit: Program = async p => {
  if (!p.tty) {
    p.err('edit: no tty\n')
    return 1
  }
  const name = p.argv[1]
  if (!name) {
    p.err('usage: edit file\n')
    return 1
  }

  const path = resolve(p, name)
  let initial = ''
  try {
    initial = String(await fsp.readFile(path, 'utf8'))
  } catch {
    // New file.
  }

  const cols = p.tty.cols
  const rows = p.tty.rows
  const s = new Surface(cols, rows)
  const buf = new TextBuffer({ initial, width: cols })
  let saved = initial
  let notice = ''
  // '' = editing; 'exit' = the save-before-exit question is up.
  let asking = ''

  const paint = (): void => {
    s.clear()
    drawBuffer(s, buf, { x: 0, y: 0, w: cols, h: rows - 2 })
    const modified = buf.text !== saved
    const status = ` ${name}${modified ? '  [Modified]' : ''}`
    s.text(0, rows - 2, status.padEnd(cols), INVERSE)
    if (asking === 'exit') {
      s.text(0, rows - 1, 'Save modified buffer?  Y Yes  N No  ^C Cancel', BOLD)
      s.cursorVisible = false
    } else {
      s.text(0, rows - 1, notice || '^O Write  ^X Exit  ^K Cut Line', DIM)
      s.cursorVisible = true
    }
    p.out(s.render())
  }

  const write = async (): Promise<boolean> => {
    try {
      await fsp.writeFile(path, buf.text)
      saved = buf.text
      notice = `Wrote ${buf.text.length} bytes to ${name}`
      return true
    } catch (e) {
      notice = `edit: ${name}: write failed`
      void e
      return false
    }
  }

  p.tty.setRaw()
  p.out('\x1b[?1049h')
  s.invalidate()

  try {
    paint()
    for (;;) {
      const chunk = await p.stdin.read()
      if (chunk === null) return 0
      for (const k of parseKeys(dec.decode(chunk))) {
        notice = ''

        if (asking === 'exit') {
          if (k.key === 'y' && !k.ctrlKey) {
            if (await write()) return 0
            asking = ''
          } else if (k.key === 'n' && !k.ctrlKey) {
            return 0
          } else if ((k.ctrlKey && k.key === 'c') || k.key === 'Escape') {
            asking = ''
          }
          paint()
          continue
        }

        if (k.ctrlKey && k.key === 'o') {
          await write()
          paint()
          continue
        }
        if (k.ctrlKey && k.key === 'x') {
          if (buf.text === saved) return 0
          asking = 'exit'
          paint()
          continue
        }
        buf.key(k)
        paint()
      }
    }
  } finally {
    p.out('\x1b[?1049l\x1b[?25h')
    p.tty.setCooked()
  }
}
