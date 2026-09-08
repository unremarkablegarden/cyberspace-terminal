// The machine's front page: the nameplate, who is logged in, and what to type.
//
// Written to /etc/motd rather than printed, so one file serves the first shell
// after boot (app/src/session.ts), a shell started by login(1), and motd(1).

import { fs } from '@zenfs/core'
import { BOLD, BRIGHT, FAINT, NORMAL, sgr } from '@cyberspace/tui'
import { COLS, MOBILE, TABLET } from './config'
import type { ChatPictures } from './image'
import { VERSION } from './changelog'

/**
 * The address is a prop. The original terminal read the visitor's real public IP
 * from a third-party echo service to print here; this project sends nothing to
 * one and collects no address, so a fixed string stands in.
 */
const CLIENT_IP = '10.0.0.14'

interface Span {
  text: string
  attr: number
}

/** Cells of padding either side of the plate's text. */
const PAD_X = 2

/**
 * The nameplate, and the drop shadow every panel in the TUI casts: a full block
 * down the right from the second row, an upper half block along the foot one
 * cell further right, so the corner turns rather than stacking.
 */
function plate(): Span[][] {
  const text = ['CYBER/OS', VERSION]
  const inner = Math.max(...text.map(s => s.length)) + PAD_X * 2
  const bar = '═'.repeat(inner)
  const rows = [
    `╔${bar}╗`,
    ...text.map(s => `║${' '.repeat(PAD_X)}${s.padEnd(inner - PAD_X * 2)}${' '.repeat(PAD_X)}║`),
    `╚${bar}╝`,
  ]
  const w = rows[0].length
  const face = BRIGHT | BOLD
  return [
    [{ text: rows[0], attr: face }],
    ...rows.slice(1).map(row => [
      { text: row, attr: face },
      { text: '█', attr: FAINT },
    ]),
    [{ text: ' ' + '▀'.repeat(w), attr: FAINT }],
  ]
}

/** The globe beside the nameplate, as picture handles. See app/src/image.ts. */
const GLOBE_SRC = '/globe.png'
/** The box the globe is fitted into: as tall as the plate, the welcome line and the first hint. */
const GLOBE_COLS = 30
const GLOBE_ROWS = 9

let pictures: ChatPictures | null = null

/** The host's picture bank, on a faceplate that has one. Held for the life of the machine. */
export function motdPictures(p: ChatPictures): void {
  pictures = p
}

/** The globe's rows, rasterised for the current font; none on a phone or without a bank. */
async function globe(): Promise<string[]> {
  if (MOBILE || !pictures) return []
  // The host caches by font and size, so a rewrite costs nothing while the
  // font stays and re-rasterises when F1 changes it.
  return pictures.load(GLOBE_SRC, GLOBE_SRC, GLOBE_COLS, GLOBE_ROWS).then(p => p.lines, () => [])
}

/** Hang the globe off the right edge, one cell in so the last column never wraps. */
function withGlobe(lines: Span[][], art: string[]): Span[][] {
  return lines.map((spans, i) => {
    const row = art[i]
    if (!row) return spans
    const used = spans.reduce((n, s) => n + s.text.length, 0)
    const gap = COLS - 1 - row.length - used
    if (gap < 1) return spans
    return [...spans, say(' '.repeat(gap)), { text: row, attr: NORMAL }]
  })
}

/** Bold marks anything that can be typed. The prose around it is not bold. */
const cmd = (text: string): Span => ({ text, attr: BOLD })
const say = (text: string): Span => ({ text, attr: NORMAL })

function welcome(user: string | null): Span[][] {
  const lines: Span[][] = [
    ...plate(),
    [],
    [
      { text: `Welcome to Cyberspace ${user ? '@' + user + ' ' : ''}`, attr: BOLD },
      say(`[${CLIENT_IP}]`),
    ],
    [],
  ]

  // F1 opens the config box from a keyboard the phone does not have. iPad
  // keyboards have no F row or Escape: the chords are in app/src/keys.ts.
  if (TABLET) lines.push([cmd('Ctrl-Opt-1'), say(' Config')], [cmd('§'), say(' Esc')])
  else if (!MOBILE) lines.push([cmd('F1'), say(' Config')])
  lines.push(
    user
      ? [say('Type '), cmd('help'), say(' for commands.')]
      : [say('Type '), cmd('login'), say(' to connect, '), cmd('help'), say(' for commands.')],
    [say('e.g. '), cmd('feed'), say(', '), cmd('circ'), say(', '), cmd('cmail'), say(', '),
     cmd('globe')],
    [],
    [say('To write your own programs;')],
    [cmd('cd bin/docs'), say(' then '), cmd('less README.txt'), say(' and '), cmd('less API.txt')],
    [say('User program repo: '), cmd('browse'), say(' and '), cmd('publish')],
    [],
    [say('Supporters can sync their home directory to the mainframe with '), cmd('sync'), say('.')],
    [say('For regular users files reside in local browser memory.')],
    [],
  )
  return lines
}

/**
 * The attributes cross a pty, so they are encoded the way a Surface encodes
 * them and decoded back exactly by app/src/vt.ts. A bare CSI 1 m would arrive
 * as BOLD|BRIGHT rather than BOLD, and FAINT has no plain SGR spelling at all.
 */
function render(lines: Span[][]): string {
  return lines
    .map(spans => spans.map(s => sgr(s.attr, 0) + s.text).join('') + '\x1b[0m\n')
    .join('')
}

/** Write /etc/motd. Called again whenever the logged-in user or the font changes. */
export async function writeMotd(user: string | null): Promise<void> {
  const lines = withGlobe(welcome(user), await globe())
  await fs.promises.writeFile('/etc/motd', render(lines)).catch(() => {})
}
