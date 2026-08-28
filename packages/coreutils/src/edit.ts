// edit — full-screen text editor, nano keys: ^O write, ^X exit, ^K cut line.

import { dec, type Proc, type Program, readText } from '@cyberspace/kernel'
import { Surface, ScreenStack, ConfirmPopup, ENTER_ESC, TextBuffer, drawBuffer, parseKeys, DIM, BOLD, NORMAL } from '@cyberspace/tui'
import { fsp, resolve, strerror } from './util.js'

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
  // False until the file is on disk; the write box is titled by it.
  let exists = true
  try {
    initial = await readText(path)
  } catch {
    exists = false
  }

  const cols = p.tty.cols
  const rows = p.tty.rows
  const s = new Surface(cols, rows)
  const buf = new TextBuffer({ initial, width: cols })
  const stack = new ScreenStack(s as never)
  let saved = initial
  let notice = ''
  // True while a write is in flight. The status row shows Saving... for it,
  // since an OPFS write can take over a second and no key is read until it
  // returns.
  let saving = false
  // '' = editing; 'exit' = the save-before-exit question is up.
  let asking = ''

  const paint = (): void => {
    s.clear()
    drawBuffer(s, buf, { x: 0, y: 0, w: cols, h: rows - 2 })
    const modified = buf.text !== saved
    const status = ` ${name}${modified ? '  [Modified]' : ''}`
    s.text(0, rows - 2, status.padEnd(cols), DIM | BOLD, 1)
    if (saving) {
      s.text(0, rows - 1, 'Saving...', BOLD)
      s.showCursor = false
    } else if (asking === 'exit') {
      s.text(0, rows - 1, 'Save modified buffer?  Y Yes  N No  ^C Cancel', BOLD)
      s.showCursor = false
    } else {
      s.text(0, rows - 1, notice || '^O Write  ^X Exit  ^K Cut Line', DIM)
      s.showCursor = true
    }
    p.tty!.paint(s.render())
  }

  const write = async (): Promise<boolean> => {
    saving = true
    paint()
    try {
      await fsp.writeFile(path, buf.text)
      saved = buf.text
      exists = true
      notice = `Wrote ${buf.text.length} bytes to ${name}`
      return true
    } catch (e) {
      // A mount that forwards writes (public_html) puts the server's reason here.
      notice = `edit: ${name}: ${strerror(e)}`
      return false
    } finally {
      saving = false
    }
  }

  // Every write is confirmed, a new file included. The answer arrives on a
  // later stdin read, so the box cannot be awaited from the key loop; it
  // writes from its callback and the loop drops keys while `saving`.
  const askWrite = (): void => {
    stack.push(new ConfirmPopup({
      title: 'WRITE',
      lines: [`${exists ? 'Overwrite' : 'Write'} ${name}?`],
      hint: ENTER_ESC,
      answer: 'enter',
      shadow: true,
      onDone: yes => {
        stack.pop()
        s.invalidate()
        if (!yes) { paint(); return }
        void write().then(paint)
      },
    }))
    p.tty!.paint(s.render())
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
        if (saving) continue
        if (stack.active) {
          stack.key(k)
          p.tty.paint(s.render())
          continue
        }
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
          askWrite()
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
