// edit — full-screen text editor. ^O write, ^X exit, ^K cut line. Without a file
// argument it opens an empty buffer and asks for the name at the first write.
//
// Framed like the other full-screen programs (circ, cmail, browse): the file
// name sits in the top rule, the key legend as inverse keycaps in the bottom
// rule, and the text between them.

import { dec, OSC_BLIP, type Proc, type Program, readText } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, ConfirmPopup, PromptPopup, ENTER_ESC, TextBuffer, Reveal,
  drawBuffer, parseKeys, frame, label, clear, cells, type Span, DIM, BOLD, BRIGHT,
} from '@cyberspace/tui'
import { fsp, resolve, strerror } from './util.js'

// The key legend, inverse keycaps then a plain label, as in circ and browse.
const HINT: Span[] = [
  { text: ' ^O ', inverse: true, attr: DIM },
  { text: ' Write ' },
  { text: ' ^K ', inverse: true, attr: DIM },
  { text: ' Cut ' },
  { text: ' ^X ', inverse: true, attr: DIM },
  { text: ' Exit' },
]

export const edit: Program = async p => {
  if (!p.tty) {
    p.err('edit: no tty\n')
    return 1
  }
  // Both empty for an untitled buffer, until the first write names it.
  let name = p.argv[1] ?? ''
  let path = name ? resolve(p, name) : ''
  let initial = ''
  // False until the file is on disk; the write box is titled by it.
  let exists = false
  if (path) {
    try {
      initial = await readText(path)
      exists = true
    } catch {}
  }

  const tty = p.tty
  const cols = tty.cols
  const rows = tty.rows
  const s = new Surface(cols, rows)
  const buf = new TextBuffer({ initial, width: cols, clipboard: t => tty.copy(t) })
  const stack = new ScreenStack(s as never)
  let saved = initial
  let notice = ''
  // True while a write is in flight. The status row shows Saving... for it,
  // since an OPFS write can take over a second and no key is read until it
  // returns.
  let saving = false
  // '' = editing; 'exit' = the save-before-exit question is up.
  let asking = ''

  // The opening screenful is released a line at a time, as circ prints its
  // backlog, with the same blip per batch.
  const print = new Reveal({ onTick: () => paint(), onBlip: () => tty.paint(OSC_BLIP) })

  const paint = (): void => {
    s.clear()
    const outer = { x: 0, y: 0, w: cols, h: rows }
    const text = { x: 1, y: 1, w: cols - 2, h: rows - 2 }
    frame(s, outer)
    drawBuffer(s, buf, text)
    // Rows not yet revealed are blanked after the draw rather than skipped in
    // it, so drawBuffer keeps its caret and scroll bookkeeping unchanged.
    if (print.count < text.h) {
      clear(s, { ...text, y: text.y + print.count, h: text.h - print.count })
    }

    // Top rule: the file name, and the live state on its right.
    const modified = buf.text !== saved
    const state = saving ? 'SAVING…' : modified ? 'MODIFIED' : ''
    const stateW = state ? cells(state) + 2 : 0
    label(s, outer, name || 'New Buffer', { attr: BRIGHT | BOLD, max: cols - 4 - stateW })
    if (state) label(s, outer, [{ text: state, attr: BOLD }], { align: 'right' })

    // Bottom rule: the key legend, or the exit question while it is up.
    if (asking === 'exit') {
      label(s, outer, [
        { text: 'Save modified buffer? ' },
        { text: ' Y ', inverse: true, attr: DIM }, { text: ' Yes ' },
        { text: ' N ', inverse: true, attr: DIM }, { text: ' No ' },
        { text: ' ESC ', inverse: true, attr: DIM }, { text: ' Cancel' },
      ], { edge: 'bottom', align: 'left', max: cols - 2 })
      s.showCursor = false
    } else {
      const hintW = HINT.reduce((n, x) => n + cells(x.text), 2)
      // Bottom-left: a transient notice while one stands, else the caret's line
      // and column. Line and total count hard lines, not folded rows.
      const head = buf.text.slice(0, buf.caret)
      const line = head ? head.split('\n').length : 1
      const total = buf.text ? buf.text.split('\n').length : 1
      const col = buf.caret - head.lastIndexOf('\n')
      const left = notice || `Ln ${line}/${total}  Col ${col}`
      label(s, outer, left, { edge: 'bottom', align: 'left', max: cols - 2 - hintW })
      label(s, outer, HINT, { edge: 'bottom', align: 'right' })
      // Hidden while revealing, as the caret would sit on a blank row.
      s.showCursor = !saving && !print.running
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

  // Set by a box's callback when the editor should exit once the loop resumes.
  let quit = false

  // Every write is confirmed, a new file included. The answer arrives on a
  // later stdin read, so the box cannot be awaited from the key loop; it
  // writes from its callback and the loop drops keys while `saving`.
  // `then` runs after a successful write (exit, for the save-on-exit path).
  const askWrite = (then?: () => void): void => {
    const done = (): void => {
      void write().then(ok => {
        paint()
        if (ok) then?.()
      })
    }
    if (!name) {
      // Untitled: the name first. An existing file then gets the overwrite
      // question, as it would have from the command line.
      stack.push(new PromptPopup({
        title: 'WRITE',
        prefix: 'File name: ',
        rows: 0,
        shadow: true,
        onDone: value => {
          stack.pop()
          s.invalidate()
          if (!value) { paint(); return }
          name = value
          path = resolve(p, value)
          void fsp.stat(path).then(() => true, () => false).then(there => {
            exists = there
            if (there) askWrite(then)
            else done()
          })
        },
      }))
      p.tty!.paint(s.render())
      return
    }
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
        done()
      },
    }))
    p.tty!.paint(s.render())
  }

  p.tty.setRaw()
  p.out('\x1b[?1049h')
  s.invalidate()
  // Frames drawn while stopped are dropped; back in the foreground, redraw.
  p.onCont = () => { s.invalidate(); paint() }

  try {
    // Folded at the text width, which drawBuffer sets on the first paint.
    buf.setWidth(cols - 2)
    print.start(Math.min(buf.rows().length, rows - 2))
    paint()
    for (;;) {
      const chunk = await p.stdin.read()
      if (chunk === null || quit) return 0
      for (const k of parseKeys(dec.decode(chunk))) {
        if (quit) return 0
        if (saving) continue
        // Any key finishes the reveal and then acts as it normally would.
        print.finish()
        if (stack.active) {
          stack.key(k)
          p.tty.paint(s.render())
          continue
        }
        notice = ''

        if (asking === 'exit') {
          if (k.key === 'y' && !k.ctrlKey) {
            if (name) {
              if (await write()) return 0
            } else {
              // The name comes through a box; the exit follows its write.
              asking = ''
              askWrite(() => { quit = true; p.stdin.interrupt?.() })
              continue
            }
            asking = ''
          } else if (k.key === 'n' && !k.ctrlKey) {
            return 0
          } else if ((k.ctrlKey && !k.shiftKey && k.key === 'c') || k.key === 'Escape') {
            asking = ''
          }
          paint()
          continue
        }

        if (k.ctrlKey && k.key === 'o') {
          askWrite()
          continue
        }
        // Ctrl+Shift+X is cut, handled by the buffer below; plain ^X exits.
        if (k.ctrlKey && !k.shiftKey && k.key === 'x') {
          if (buf.text === saved) return 0
          asking = 'exit'
          paint()
          continue
        }
        // Tab is a completion key in every other buffer, so TextBuffer drops
        // it; the editor is the one place a literal U+0009 belongs in the text.
        if (k.key === 'Tab' && !k.ctrlKey) buf.insert('\t')
        else buf.key(k)
        paint()
      }
    }
  } finally {
    print.stop()
    p.out('\x1b[?1049l\x1b[?25h')
    p.tty.setCooked()
  }
}
