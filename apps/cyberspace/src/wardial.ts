// wardial(1): dial a block of numbers and list the ones a modem answers.
// Nothing is dialled; outcomes are drawn from OUTCOMES.

import type { Program } from '@cyberspace/kernel'
import type { ChatSound } from './chat.js'

/** 555 is the exchange reserved for fiction. */
const EXCHANGE = '555'

/** Relative weights, summing to 100. */
const OUTCOMES = [
  { weight: 62, text: 'NO ANSWER' },
  { weight: 20, text: 'BUSY' },
  { weight: 11, text: 'VOICE' },
  { weight: 5, text: 'CARRIER 1200' },
  { weight: 2, text: 'CARRIER 2400' },
] as const

const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function roll(): string {
  let r = Math.random() * 100
  for (const o of OUTCOMES) {
    if ((r -= o.weight) < 0) return o.text
  }
  return OUTCOMES[0].text
}

export function wardialProgram(snd: ChatSound): Program {
  return async p => {
    // Capped at 200 numbers; each takes 140-250 ms.
    const count = Math.min(Math.max(parseInt(p.argv[1] ?? '24', 10) || 24, 1), 200)
    const start = Math.floor(Math.random() * 9000) + 1000
    const pause = (ms: number) => new Promise<void>(res => {
      const t = setTimeout(res, ms)
      p.signal.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
    })

    p.out(`${BOLD}WARDIAL 1.4 - SCANNING ${EXCHANGE}-${start} .. ${EXCHANGE}-${start + count - 1}${RESET}\n\n`)
    const hits: string[] = []
    for (let i = 0; i < count; i++) {
      const line = `${EXCHANGE}-${start + i}  ${roll()}`
      const carrier = line.includes('CARRIER')
      snd.beep(1400 + Math.random() * 400, 0.03)
      await pause(140 + Math.random() * 110)
      if (p.signal.aborted) return 130
      p.out(carrier ? `  ${BOLD}${line}${RESET}\n` : `  ${line}\n`)
      if (carrier) {
        hits.push(line)
        snd.beep(1800, 0.1)
      }
    }

    if (!hits.length) {
      p.out('\nNO CARRIERS FOUND. TRY ANOTHER BLOCK.\n')
      return 0
    }
    p.out(`\n${BOLD}${hits.length} CARRIER${hits.length === 1 ? '' : 'S'} FOUND${RESET}\n`)
    for (const h of hits) p.out(`  ${h}\n`)
    return 0
  }
}
