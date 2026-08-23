// view(1): displays one image full-screen.
//
// Takes a URL or a path on the machine, halftones it to the grid, and exits on
// q, Escape or Enter.
//
// Lives in the faceplate rather than coreutils because decoding needs the DOM,
// which the kernel and userland avoid so the same kernel can run behind ssh.
// See app/src/image.ts.

import { fs } from '@zenfs/core'
import { dec, type Program } from '@cyberspace/kernel'
import { Surface, parseKeys, DIM, BOLD } from '@cyberspace/tui'
import type { ChatPictures } from './image'

/** Rows reserved at the bottom for the status line. */
const CHROME = 1

export function viewProgram(pictures: () => ChatPictures): Program {
  return async p => {
    const name = p.argv[1]
    if (!name) {
      p.err('usage: view file|url\n')
      return 1
    }
    if (!p.tty) {
      p.err('view: no tty\n')
      return 1
    }

    const pics = pictures()
    const remote = /^https?:\/\//i.test(name)
    const cols = p.tty.cols
    const rows = p.tty.rows
    const s = new Surface(cols, rows)

    p.out('Reading...')

    let pic
    try {
      if (remote) {
        pic = await pics.load(name, name, cols, rows - CHROME)
      } else {
        const path = name.startsWith('/') ? name : `${p.env.PWD ?? '/'}/${name}`.replace(/\/+/g, '/')
        const bytes = await fs.promises.readFile(path) as unknown as Uint8Array
        pic = await pics.load(bytes, path, cols, rows - CHROME)
      }
    } catch (err) {
      pics.release()
      p.err(`\r\x1b[2Kview: ${name}: ${err instanceof Error ? err.message : 'cannot read'}\n`)
      return 1
    }

    // Centred: the picture is fitted to the grid, not cropped to fill it, so
    // one axis is usually short of the full width or height.
    const ox = Math.max(0, Math.floor((cols - pic.cols) / 2))
    const oy = Math.max(0, Math.floor((rows - CHROME - pic.rows) / 2))

    const paint = (): void => {
      s.clear()
      for (let y = 0; y < pic.rows; y++) s.text(ox, oy + y, pic.lines[y] ?? '', DIM)
      const left = ` ${name} `
      const right = `${pic.cols}x${pic.rows}   Q quit `
      const gap = Math.max(1, cols - left.length - right.length)
      s.text(0, rows - 1, (left + ' '.repeat(gap) + right).slice(0, cols).padEnd(cols),
             DIM | BOLD, 1)
      s.showCursor = false
      p.tty!.paint(s.render())
    }

    p.tty.setRaw()
    // Clear the progress line before switching to the alt screen, so it does not
    // reappear on exit.
    p.out('\r\x1b[2K\x1b[?1049h')
    s.invalidate()

    try {
      paint()
      for (;;) {
        const chunk = await p.tty.stdin.read()
        if (chunk === null) return 0
        for (const k of parseKeys(dec.decode(chunk))) {
          if (k.ctrlKey && k.key === 'c') return 130
          if (k.key === 'q' || k.key === 'Q' || k.key === 'Escape' || k.key === 'Enter') return 0
        }
      }
    } finally {
      pics.release()
      p.out('\x1b[?1049l\x1b[?25h')
      p.tty.setCooked()
    }
  }
}
