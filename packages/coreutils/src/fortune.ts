// fortune: print a random cookie from FORTUNES.

import type { Program } from '@cyberspace/kernel'
import { wrap } from '@cyberspace/tui'
import { FORTUNES } from './fortunes.js'

export const randomFortune = (): string => FORTUNES[Math.floor(Math.random() * FORTUNES.length)]!

export const fortune: Program = p => {
  // The grid breaks an overlong line at the last column, mid-word; wrap() breaks between words.
  const width = Math.min(72, (p.tty?.cols ?? 80) - 4)
  // Blank lines around it on the terminal only, so a pipe (fortune | cowsay) gets the text alone.
  const pad = p.tty ? '\n' : ''
  p.out(pad)
  for (const line of wrap(randomFortune(), width)) p.out('  ' + line + '\n')
  p.out(pad)
  return 0
}
