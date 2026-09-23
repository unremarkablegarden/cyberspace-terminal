// Reading one line from the keyboard in raw mode, for password prompts.

import { dec } from './pipe.js'
import type { Proc } from './proc.js'

/** Read one line in raw mode. An empty mask hides input entirely. Null on ^C. */
export async function readLine(p: Proc, prompt: string, mask?: string): Promise<string | null> {
  const tty = p.tty
  if (!tty) return null
  p.out(prompt)
  tty.setRaw()
  let line = ''
  try {
    for (;;) {
      const chunk = await p.stdin.read()
      if (chunk === null) return line
      for (const ch of dec.decode(chunk)) {
        if (ch === '\x03') {
          tty.echo('\n')
          return null
        }
        if (ch === '\r' || ch === '\n') {
          tty.echo('\n')
          return line
        }
        if (ch === '\x7f' || ch === '\b') {
          if (line) {
            line = line.slice(0, -1)
            if (mask !== '') tty.echo('\b \b')
          }
          continue
        }
        if (ch >= ' ') {
          line += ch
          // Keystroke echo rather than program output: not rate-limited, no bleep.
          tty.echo(mask ?? ch)
        }
      }
    }
  } finally {
    tty.setCooked()
  }
}
