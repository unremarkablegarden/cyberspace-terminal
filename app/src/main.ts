// Entry point for the web faceplate: wires the CRT canvas, the xterm parser,
// the rate limiter and the keyboard to a kernel booted in this page, then
// drives the whole thing from the render loop.

import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { mount, type CrtScreen } from '@cyberspace/crt'
import { RENDER, GRID } from '@cyberspace/crt/config'
import { Sound } from '@cyberspace/crt/audio'
import { standby, strike, implode, Aborted } from '@cyberspace/crt/effects'
import { bootSequence } from '@cyberspace/crt/boot'
import { loadFamily, loadFallback, familyOf } from '@cyberspace/crt/fonts'
import { Tty, bytes, type Proc, type Kernel } from '@cyberspace/kernel'
import { ApiClient } from '@cyberspace/apps'
import { fs } from '@zenfs/core'
import { syncTerm } from './vt'
import { Baud } from './baud'
import { VERSION } from './changelog'
import { API_URL, COLD_AFTER, COLS, CPS, ENV, HOME, MOBILE, ROWS, SOUNDS } from './config'
import { store } from './store'
import { grid, withGrid } from './grid'
import { pictureHost } from './image'
import { bootMachine } from './machine'
import { writeMotd } from './motd'
import { ConfigBox, restoreSettings } from './settings'
import { Screensaver } from './saver'
import { Scrollback } from './scrollback'
import { Keyboard } from './input'
import { parseSession, runSession, SESSION_VERSION, type TerminalSession } from './session'
import { armUpdates, rebootOnto, updateWaiting } from './update'

armUpdates()

RENDER.cursor = true
GRID.cols = COLS
GRID.rows = ROWS

const snd = new Sound({ bootupUrl: SOUNDS.bootup })

const api = new ApiClient(API_URL, {
  get: () => localStorage.getItem('csterm.auth'),
  set: v => (v ? localStorage.setItem('csterm.auth', v) : localStorage.removeItem('csterm.auth')),
})
api.onAuthChange = user => {
  ENV.USER = user ?? 'guest'
  void writeMotd(user)
}

/** The browser's file chooser. Resolves null when dismissed. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise(done => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    document.body.appendChild(input)
    const finish = (value: File | null) => { input.remove(); done(value) }
    input.addEventListener('cancel', () => finish(null), { once: true })
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true })
    input.click()
  })
}

const xt = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
const ser = new SerializeAddon()
xt.loadAddon(ser)

const scroll = new Scrollback(xt, ROWS, snd)
const tx = new Baud(data => { scroll.reset(); xt.write(data) }, CPS, 'char')
// Echo is written urgent so keystrokes never queue behind program output.
const tty = new Tty((data, urgent) => (urgent ? tx.now(data.slice()) : tx.write(data.slice())), COLS, ROWS)

xt.onBell(() => snd.beep(880, 0.09))

let halted = false
let killSession: (() => void) | null = null
/** The running shell, for the working directory a parked session keeps. */
let shell: Proc | null = null
/** The kernel, once it is up. Null while it is still booting. */
let machine: Kernel | null = null
/** Non-null only while the cold-boot sequence plays; ^C aborts it. */
let bootAbort: AbortController | null = null
/** Non-null only while the machine sits in standby; any key aborts it. */
let standbyAbort: AbortController | null = null

let screen: CrtScreen
let config: ConfigBox | null = null
let saver: Screensaver | null = null

const keyboard = new Keyboard({
  tty,
  tx,
  snd,
  scroll,
  config: () => config,
  skipBoot: () => {
    if (!bootAbort) return false
    bootAbort.abort()
    return true
  },
  powerOn: () => {
    if (!standbyAbort) return false
    standbyAbort.abort()
    return true
  },
})

/** Resolves once the rate limiter has released everything queued. */
function waitForDrain(): Promise<void> {
  return new Promise(res => {
    const poll = () => (tx.idle ? res() : setTimeout(poll, 60))
    poll()
  })
}

// --- halt and reboot ----------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

async function shutdownProgram(p: Proc): Promise<number> {
  p.out('\nTHE SYSTEM IS HALTED\n')
  await waitForDrain()
  halted = true
  await withGrid(() => implode(screen.term, snd))
  killSession?.()
  return 0
}

async function rebootProgram(p: Proc): Promise<number> {
  p.out('\nThe system is going down for reboot NOW.\n')
  p.out('SHUTTING DOWN ...\n')
  await waitForDrain()
  await sleep(300)
  p.out('SYNCING BUILD ...\n')
  await waitForDrain()
  snd.beep(880, 0.08)
  await sleep(400)
  halted = true
  await withGrid(() => implode(screen.term, snd))
  // Drop the mark that would make the reload a warm boot.
  store.remove('lastSeen')
  rebootOnto()
  return 0
}

// --- the parked session -------------------------------------------------------

/** Scrollback rows stored with a parked session, out of the 1000 xterm keeps. */
const SESSION_SCROLLBACK = 200

/**
 * Store the current screen and resume point so a refresh comes back to it.
 *
 * Called on the way out rather than on a timer: the screen changes on every
 * keystroke, and nothing needs saving that is not already rendered.
 */
function saveSession(): void {
  // Halted, or never booted. Removing the key stops a stale session making the
  // next reboot look like a flicker.
  if (halted || !machine || !shell) {
    store.remove('session')
    return
  }
  const blob: TerminalSession = {
    v: SESSION_VERSION,
    at: Date.now(),
    uid: api.userId ?? '',
    // excludeAltBuffer stores the shell scrollback underneath a full-screen
    // program rather than the program's own painting, which comes back when
    // the resume line runs the program again.
    screen: ser.serialize({
      scrollback: SESSION_SCROLLBACK,
      excludeAltBuffer: true,
      excludeModes: true,
    }),
    cwd: shell.env.PWD || HOME,
    resume: machine.resume.line,
    state: machine.resume.state,
  }
  try {
    store.set('session', JSON.stringify(blob))
  } catch {
    // Storage quota, or private mode. A session that cannot be saved is a cold boot.
    store.remove('session')
  }
}

/** The parked session, or null to come up clean. */
function loadSession(): TerminalSession | null {
  let raw: unknown = null
  try {
    raw = JSON.parse(store.get('session', 'null'))
  } catch {
    return null
  }
  return parseSession(raw, api.userId ?? '', Date.now())
}

// --- boot --------------------------------------------------------------------

let last = 0

const program = {
  async init(s: CrtScreen): Promise<void> {
    screen = s
    void snd.load()
    void loadFallback(s.term)

    restoreSettings(s, snd)
    config = new ConfigBox(s, snd)
    saver = new Screensaver(s, () => halted)

    // Load the saved font before the first paint, so no frame renders in the default.
    const savedFont = store.get('font', 'terminus-8x16')
    if (savedFont !== 'terminus-8x16') {
      await loadFamily(s.term, familyOf(savedFont)).catch(() => {})
      s.crt.setSource(s.term.w, s.term.h)
    }

    // Cold start: first visit, or away longer than COLD_AFTER.
    const cold = Date.now() - Number(store.get('lastSeen', '0')) > COLD_AFTER
    // The kernel boots while the animation plays. bootMachine never touches the grid.
    const kernelP = bootMachine({
      api,
      snd,
      host: { shutdown: shutdownProgram, reboot: rebootProgram },
      // Image decoding is faceplate-only, and the metrics depend on the font
      // loaded right now, which F1 can change under a running program.
      pictures: () => pictureHost(s.term),
      pickFile,
    })
    // Resumed under the boot animation, capped at 5s so a dead network cannot
    // hold up the prompt.
    const resumed = api.hasSavedSession
      ? Promise.race([api.resume(), new Promise<null>(res => setTimeout(() => res(null), 5000))])
      : Promise.resolve(null)

    if (cold) {
      const gate = new AbortController()
      const abort = new AbortController()
      standbyAbort = gate
      // One lock across standby and the boot: unlocking between them would let
      // a few frames of pty sync and a blinking cursor onto a dark screen.
      await withGrid(async () => {
        // Standby until a key or a tap. An AudioContext unlocks only on a user
        // gesture, so a cold boot taken unprompted plays none of its sequence.
        await standby(s.term, gate.signal)
        standbyAbort = null
        bootAbort = abort
        await snd.unlock()
        snd.powerOn()
        void snd.bootup()
        try {
          await strike(s.term, snd, abort.signal)
          await bootSequence(s.term, snd, abort.signal, { version: VERSION })
        } catch (err) {
          if (!(err instanceof Aborted)) throw err
          // Aborted by ^C rather than failed: stop the chime and clear to the prompt.
          snd.stopBootup()
          s.term.clear()
        }
      })
      standbyAbort = null
      bootAbort = null
    } else {
      snd.powerOn()
      await withGrid(() => strike(s.term, snd))
    }
    store.set('lastSeen', String(Date.now()))

    const kernel = await kernelP
    // The identity must resolve before loadSession runs: a parked scrollback is
    // restored only for the member it was saved by.
    await resumed
    await writeMotd(api.username)
    machine = kernel

    ;(globalThis as Record<string, unknown>).cs = {
      kernel, fs, tty, snd, screen, api, tx, xt, saver,
      dbg: {
        get lock() { return grid.locked },
        get halted() { return halted },
        get update() { return updateWaiting() },
      },
    }

    const saved = loadSession()
    if (saved) {
      // Written straight to the parser, bypassing the rate limiter: restoring a
      // screen is a repaint, not program output.
      xt.write(saved.screen + '\r\x1b[2K')
      kernel.resume.restore(saved.resume, saved.state)
    }
    void runSession({
      kernel,
      tty,
      halted: () => halted,
      drained: waitForDrain,
      onShell: (p, kill) => { shell = p; killSession = kill },
    }, saved)
  },

  frame(s: CrtScreen, t: number): void {
    // `t` is seconds since boot; Baud.drain takes milliseconds.
    const dt = last ? (t - last) * 1000 : 0
    last = t
    if (!grid.locked && !halted) {
      // drain() returns program output only, so echo does not trigger the blip.
      if (tx.drain(dt) > 0) snd.blip(1400)
      scroll.clamp()
      syncTerm(xt, s.term, scroll.back)
      // The render loop writes showCursor from RENDER.cursor every frame, so
      // this assignment is what lets a full-screen program hide the caret. It is
      // also hidden while scrolled back, where it would not mark the input point.
      s.term.showCursor = RENDER.cursor && tty.caret && scroll.back === 0
    }
  },

  key(_s: unknown, e: KeyboardEvent): void {
    keyboard.key(e)
  },
}

// rAF stops in a hidden tab, and xterm parses writes asynchronously, so the grid
// trails the parser by a tick. This interval keeps both advancing while hidden.
setInterval(() => {
  if (!document.hidden || grid.locked || halted || !screen) return
  tx.drain(1000)
  syncTerm(xt, screen.term, scroll.back)
}, 1000)

// Safari and mobile do not fire beforeunload, so pagehide is the reliable exit
// event. visibilitychange also covers a backgrounded tab discarded without
// being shown again.
window.addEventListener('pagehide', saveSession)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession()
})

window.addEventListener('paste', e => {
  const text = e.clipboardData?.getData('text')
  if (!text) return
  e.preventDefault()
  keyboard.paste(text)
})

const canvas = document.getElementById('tube') as HTMLCanvasElement

try {
  await mount(canvas, program)
  if (MOBILE) keyboard.wireSoftKeyboard(canvas)
  else canvas.addEventListener('pointerdown', () => keyboard.pointer())
} catch (err) {
  const fault = document.getElementById('fault')!
  fault.style.display = 'block'
  fault.textContent = 'THE TUBE DID NOT COME UP\n\n' + String((err as Error)?.stack ?? err)
  canvas.style.display = 'none'
}
