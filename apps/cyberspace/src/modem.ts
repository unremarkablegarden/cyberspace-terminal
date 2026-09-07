// The modem: what login(1) shows once the password is accepted, and what
// logout(1) prints on the way out. Hayes command echo and result codes, then a
// telnet-style connect.
//
// dial() writes through a caller-supplied line writer, so login can type it
// under its box on the alt screen; hangup() is program output on the
// scrollback. Killed mid-sequence (^C) either stops where it is; the session
// is already established or torn down by then, so nothing is lost.

import type { Proc } from '@cyberspace/kernel'
import type { ChatSound } from './chat.js'

export type LineWriter = (text: string) => Promise<void>

const HOST = 'cyberspace.online'
const NODE = '10.0.0.14'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** DTMF-like tones for the digits, one beep per digit. */
const DIAL_HZ = [941, 1336, 852, 1209, 697, 1477, 770, 1336, 852, 1477]

export async function dial(line: LineWriter, snd: ChatSound, username: string): Promise<void> {
  await line('ATDT 1-800-CYBERSPACE')
  for (const hz of DIAL_HZ) {
    snd.beep(hz, 0.06)
    await sleep(90)
  }
  await sleep(500)
  await line('RINGING')
  await sleep(700)
  // The V.32 handshake, compressed to three tones.
  snd.beep(1800, 0.25)
  await sleep(300)
  snd.beep(2100, 0.35)
  await sleep(400)
  snd.beep(1200, 0.12)
  await sleep(200)
  await line('CONNECT 9600/ARQ/V32/LAPM/V42BIS')
  await line('')
  await sleep(300)
  await line(`Trying ${NODE}...`)
  await sleep(250)
  await line(`Connected to ${HOST}.`)
  await line("Escape character is '^]'.")
  await line('')
  await sleep(350)
  await line(`Cyberspace Node 1 (${HOST}) (ttyp0)`)
  await line('')
  await sleep(200)
  await line(`login: ${username}`)
  await line('Password:')
  await sleep(450)
  await line(`Last login: ${stamp(new Date())} from ${NODE}`)
}

export async function hangup(p: Proc, snd: ChatSound): Promise<void> {
  p.out('logout\n')
  await sleep(300)
  p.out(`Connection closed by foreign host.\n`)
  await sleep(400)
  p.out('+++\n')
  await sleep(600)
  p.out('ATH\n')
  await sleep(300)
  p.out('OK\n')
  snd.beep(440, 0.08)
  await sleep(250)
  p.out('NO CARRIER\n')
}

/** ctime(3) without the year: `Mon Sep  7 14:47`, as last(1) prints it. */
function stamp(d: Date): string {
  const day = d.toLocaleDateString('en-US', { weekday: 'short' })
  const mon = d.toLocaleDateString('en-US', { month: 'short' })
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${day} ${mon} ${String(d.getDate()).padStart(2)} ${hhmm}`
}
