// `sudo rm -rf /`, ported from the old /terminal. Nothing is removed.
// The cascade is pty output and stays in scrollback. The meltdown draws on the CRT grid, then the machine cold boots.
// sudo(1) runs it for three exact command lines; it is not registered as a command. See packages/coreutils/src/sudo.ts.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { PHOSPHORS } from '@cyberspace/crt/config'
import { Aborted, implode, sleep } from '@cyberspace/crt/effects'
import { BOLD, BRIGHT, NORMAL } from '@cyberspace/crt/term'
import type { Proc, Program } from '@cyberspace/kernel'
import { DotCanvas, drawEdges, teapot } from '@cyberspace/tui'
import type { Baud } from './baud'
import { CPS } from './config'
import { withGrid } from './grid'
import { metricsOf } from './image'
import { phosphorTint } from './prefs'

export interface DoomsdayDeps {
  screen: CrtScreen
  snd: Sound
  tx: Baud
  /** Resolves once queued output has been released to the screen. */
  drained: () => Promise<void>
  /** Cold boot: drops the parked session and reloads. */
  reboot: () => void
}

/** Output rate for the cascade, 9600 baud. The rest runs at CPS. */
const CASCADE_CPS = 960

/** What is removed, in order, and the note after each. */
const victims = (home: string): [string, string][] => [
  ['/bin', 'done'],
  ['/usr', 'done'],
  ['/etc', 'done'],
  ['/etc/passwd', 'done'],
  ['/var/log/last-good-idea', 'done'],
  ['/var/spool/mail', 'done'],
  ['/tmp', 'done'],
  ['/lost+found', 'nothing found'],
  [home, 'done'],
  ['/dev/null', 'this may take a while'],
  ['/dev/urandom', 'done'],
  ['/dev/audio', 'done'],
  ['/usr/bin/circ', 'done'],
  ['/usr/bin/wardial', 'done'],
  ['/usr/games/fortune', 'done'],
  ['/usr/share/man/man1/rm.1', 'done'],
  ['/usr/share/doc/why', 'done'],
  ['/usr/lib/libc.so.6', 'done'],
  ['1984', 'done'],
  ['the ozone layer', 'done'],
  ['every teapot in /grid', 'done'],
  ['your reasons for doing this', 'done'],
  ['/proc/self', 'done'],
  ['/sbin/init', 'done'],
  ['rm', 'done'],
]

const LAST_WORDS = [
  'init: warning: /sbin/init has been removed',
  'init: respawning /sbin/init ... failed',
  'init: respawning /sbin/init ... failed',
  'init: respawning /sbin/init ... failed',
  'init: respawning too fast, disabling for 5 minutes',
  '',
  'EXT2-fs error (hd0a): ext2_check_descriptors: bitmap for group 0 not in group',
  'attempting to remount / read-only ... failed',
  'attempting to remount / read-only ... failed',
  'Out of memory: killed process 1 (init)',
]

const SKULL = [
  '        ██████████',
  '     ████████████████',
  '   ████████████████████',
  '  ██████████████████████',
  ' ████████████████████████',
  ' ████████████████████████',
  ' ███      ██████      ███',
  ' ███      ██████      ███',
  ' ███      ██████      ███',
  ' ████    ████████    ████',
  ' ████████████████████████',
  ' ███████████  ███████████',
  ' ██████████    ██████████',
  ' ████████████████████████',
  '  ██████████████████████',
  '   ██ ██ ██ ██ ██ ██ ██',
  '   ██ ██ ██ ██ ██ ██ ██',
  '    ██████████████████',
]

/** Snow characters. About a quarter are blanks, so the snow is not a solid lit field. */
const GARBAGE = ' ░▒▓█▀▄▌▐╬╣╠╦╩╫┼│─@#%&*+=<>?!/\\|~^:;·§¤     '

type Grid = CrtScreen['term']

export function doomsdayProgram(d: DoomsdayDeps): Program {
  return async (p: Proc) => {
    try {
      await cascade(p, d)
      await withGrid(() => meltdown(d, p.signal))
    } catch (e) {
      if (e instanceof Aborted) return 130
      throw e
    } finally {
      d.tx.cps = CPS
    }
    d.reboot()
    return 0
  }
}

async function cascade(p: Proc, d: DoomsdayDeps): Promise<void> {
  const { snd } = d
  const line = async (s: string, ms: number) => {
    p.out(s + '\n')
    await d.drained()
    await sleep(ms, p.signal)
  }

  d.tx.cps = CASCADE_CPS
  await line("rm: descending into '/'", 200)
  let removed = 0
  for (const [path, note] of victims(p.env.HOME ?? '/home')) {
    snd.seek(2 + ((Math.random() * 3) | 0))
    removed += 1 + ((Math.random() * 400000) | 0)
    await line(`removing ${path} `.padEnd(46, '.') + ` ${note}`, note === 'done' ? 70 : 700)
  }
  await sleep(200, p.signal)
  await line(`rm: ${removed.toLocaleString('en-US')} objects removed`, 400)
  await line("\nrm: cannot remove 'rm': it is currently removing 'rm'", 600)

  d.tx.cps = CPS
  p.out('\n')
  snd.klaxon(3)
  for (const s of LAST_WORDS) await line(s, s ? 220 : 400)
  await sleep(500, p.signal)

  snd.beep(180, 0.40)
  await line('\nSegmentation fault (core dumped)', 0)
  // The core dump goes out at once, not at the line rate.
  p.tty?.setPaced(false)
  try {
    p.out(Array.from({ length: 5 }, hexLine).join('\n') + '\n')
  } finally {
    p.tty?.setPaced(true)
  }
  snd.burst(300, 0.7, 0.26, 1.1)
  await sleep(600, p.signal)

  await line('\n\x1b[1mKernel panic - not syncing: VFS: unable to mount root fs on 00:00\x1b[0m', 0)
  await line('CPU: 0 PID: 1 Comm: init Not tainted 2.11-cyberspace #1', 0)
  snd.arc()
  await sleep(300, p.signal)
  await line('Rebooting in 30 seconds ...', 600)
}

/**
 * Snow, the skull, sparks with horizontal slips, snow, the teapot, then implode.
 * The phosphor steps through PHOSPHORS once per frame and is set back to the saved tint for the teapot and on exit.
 * implode takes no signal, so once it starts the sequence runs to the reboot.
 */
async function meltdown(d: DoomsdayDeps, signal: AbortSignal): Promise<void> {
  const { screen, snd } = d
  const term: Grid = screen.term
  const tints = Object.keys(PHOSPHORS)
  let frame = 0
  const strobe = () => screen.crt.setPhosphor(tints[frame++ % tints.length])
  const wait = (ms: number) => sleep(ms, signal)

  const art = Math.max(...SKULL.map(row => row.length))
  const x = Math.floor((term.cols - art) / 2)
  const y = Math.floor((term.rows - SKULL.length) / 2)
  const skull = (dx: number) => {
    for (let i = 0; i < SKULL.length; i++) term.text(x + dx, y + i, SKULL[i]!, BRIGHT | BOLD)
    term.dirty = true
  }

  try {
    for (let f = 0; f < 6; f++) {
      snow(term)
      strobe()
      snd.hiss(0.14, 0.13)
      snd.burst(200 + Math.random() * 900, 1.2, 0.13, 0.12)
      await wait(90)
    }

    term.clear()
    for (let i = 0; i < SKULL.length; i++) {
      term.text(x, y + i, SKULL[i]!, BRIGHT | BOLD)
      term.dirty = true
      strobe()
      snd.blip(120 + i * 46, 0.05, 0)
      await wait(55)
    }
    snd.degauss()

    // Every fifth frame the skull is redrawn 4 columns left or right.
    for (let f = 0; f < 20; f++) {
      strobe()
      if (f % 5 === 4) {
        term.clear()
        skull(Math.random() < 0.5 ? -4 : 4)
        snd.degauss()
      } else {
        sparks(term, 30)
        if (f % 2 === 0) snd.arc()
      }
      await wait(90)
    }

    for (let f = 0; f < 4; f++) {
      snow(term)
      strobe()
      snd.hiss(0.12, 0.14)
      await wait(70)
    }
    screen.crt.setPhosphor(phosphorTint())
    await spinTeapot(d, wait)

    await implode(term, snd)
  } finally {
    screen.crt.setPhosphor(phosphorTint())
    term.clear()
    term.dirty = true
  }
}

/** 92 frames at 45 ms, spinning up over the first 26. */
async function spinTeapot({ screen, snd }: DoomsdayDeps, wait: (ms: number) => Promise<void>): Promise<void> {
  const term: Grid = screen.term
  const dc = new DotCanvas(metricsOf(term), term.cols, term.rows)
  const model = teapot()
  const view = { yaw: 0, pitch: 0.40, scale: 26, ox: dc.w / 2, oy: dc.h / 2 + 4, focal: 7 }
  for (let f = 0; f < 92; f++) {
    view.yaw += 0.035 + 0.055 * Math.min(1, f / 26)
    term.clear()
    dc.clear()
    drawEdges(dc, model, view)
    dc.blit(term, BRIGHT)
    term.dirty = true
    if (f % 3 === 0) snd.blip(2100 + Math.sin(f / 7) * 300, 0.02, 0)
    await wait(45)
  }
  await wait(300)
}

function snow(term: Grid): void {
  for (let gy = 0; gy < term.rows; gy++) {
    for (let gx = 0; gx < term.cols; gx++) {
      term.put(gx, gy, GARBAGE[(Math.random() * GARBAGE.length) | 0]!, Math.random() < 0.3 ? BRIGHT : NORMAL)
    }
  }
  term.dirty = true
}

/** Overwrite `count` random cells, leaving the rest. */
function sparks(term: Grid, count: number): void {
  for (let i = 0; i < count; i++) {
    const gx = (Math.random() * term.cols) | 0
    const gy = (Math.random() * term.rows) | 0
    term.put(gx, gy, GARBAGE[(Math.random() * GARBAGE.length) | 0]!, Math.random() < 0.5 ? BRIGHT | BOLD : NORMAL)
  }
  term.dirty = true
}

function hexLine(): string {
  const addr = ((Math.random() * 0xffff) | 0).toString(16).padStart(4, '0')
  const bytes = Array.from({ length: 16 }, () => ((Math.random() * 256) | 0).toString(16).padStart(2, '0'))
  return `${addr}: ${bytes.join(' ')}`
}
