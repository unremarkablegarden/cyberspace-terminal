// One modal on an otherwise empty alt screen, shared by the programs that ask
// a single question and print the answer to the scrollback afterwards.

import { dec, type Proc } from '@cyberspace/kernel'
import { Surface, ScreenStack, parseKeys, type Screen } from '@cyberspace/tui'

/**
 * Open one box on a clean alt screen and take it down again.
 *
 * A Surface starts blank and the pty has no readback, so a box cannot be drawn
 * over the existing scrollback. It takes the alt screen while open, and the
 * outcome is printed to the scrollback after it closes.
 */
export async function box<T>(
  p: Proc,
  fallback: T,
  push: (s: Surface, stack: ScreenStack, done: (v: T) => void) => Screen,
): Promise<T> {
  const tty = p.tty!
  const s = new Surface(tty.cols, tty.rows)
  const stack = new ScreenStack(s as never)

  let value = fallback
  let settled = false
  // SelectPopup resolves on a timer, after flashing the selected row, by which
  // point this loop has parked in a read. Without the interrupt it would hold
  // the box open and swallow the next key.
  const done = (v: T): void => { value = v; settled = true; p.stdin.interrupt?.() }

  tty.setRaw()
  tty.silence(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])
  p.out('\x1b[?1049h')
  s.invalidate()
  try {
    stack.push(push(s, stack, done))
    tty.paint(s.render())
    while (!settled) {
      const chunk = await p.stdin.read()
      if (chunk === null) break
      for (const k of parseKeys(dec.decode(chunk))) {
        stack.key(k)
        tty.paint(s.render())
        if (settled) break
      }
    }
  } finally {
    p.out('\x1b[?1049l\x1b[?25h')
    tty.setCooked()
  }
  return value
}
