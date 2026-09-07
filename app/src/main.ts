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
import { API_URL, COLD_AFTER, COLS, CPS, ENV, MOBILE, ROWS, SOUNDS, STORE_PREFIX, TABLET, homeOf, pathOf } from './config'
import { store } from './store'
import { grid, withGrid } from './grid'
import { pictureHost } from './image'
import { bootMachine } from './machine'
import { writeMotd } from './motd'
import { ConfigBox, restoreSettings } from './settings'
import { Screensaver } from './saver'
import { saverPrefs } from './prefs'
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
  const home = homeOf(user)
  ENV.USER = user ?? 'guest'
  ENV.HOME = home
  ENV.PATH = pathOf(home)
  // The running shell keeps its own copy of the environment, so move it too:
  // the prompt is drawn from it on every line, and cwd is the shell's own.
  if (shell) {
    Object.assign(shell.env, { USER: ENV.USER, HOME: home, PATH: ENV.PATH, PWD: home })
    shell.cwd = home
  }
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
// A held key drops its repeat click; instead the screen change the repeat causes
// bleeps. repeatAt is the time of the last auto-repeat keydown, cleared on a
// fresh press, and REPEAT_BLIP_MS is how long after it an echo still counts as
// the repeat's doing (repeats arrive well inside it).
const REPEAT_BLIP_MS = 250
let repeatAt = 0
// Time of the last keydown. The caret is held solid for one blink period after
// it, so a moving cursor is never caught in its off phase.
let keyAt = 0

// Echo is written urgent so keystrokes never queue behind program output. Echo
// during the repeat window is a held key changing the screen, so it bleeps like
// output; a plain keystroke's echo does not, since repeatAt is 0 by then.
const tty = new Tty((data, urgent) => {
  if (urgent) {
    tx.now(data.slice())
    if (repeatAt && performance.now() - repeatAt < REPEAT_BLIP_MS) snd.blip(1400)
  } else {
    tx.write(data.slice())
  }
}, COLS, ROWS)
// Copy and cut reach the system clipboard here; the kernel has no DOM. Paste
// comes back the other way, through the window paste handler below.
tty.clipboard = text => { void navigator.clipboard?.writeText(text) }

xt.onBell(() => snd.beep(880, 0.09))

let halted = false
let killSession: (() => void) | null = null
/** The running shell, for the working directory a parked session keeps. */
let shell: Proc | null = null
/** The kernel, once it is up. Null while it is still booting. */
let machine: Kernel | null = null
/** Non-null only while the cold-boot sequence plays; ^C aborts it. */
let bootAbort: AbortController | null = null
/** Set once the shell is reading the tty. Typing during the boot is discarded. */
let live = false
/** Non-null only while the machine sits in standby; any key aborts it. */
let standbyAbort: AbortController | null = null

let screen: CrtScreen
let config: ConfigBox | null = null
let saver: Screensaver | null = null
/** Time of the last key or pointer press, for the idle screensaver. */
let lastActive = Date.now()

const keyboard = new Keyboard({
  tty,
  tx,
  snd,
  scroll,
  config: () => config,
  overlay: () => (config?.open ? config : saver?.open ? saver : null),
  activity: () => { lastActive = Date.now() },
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
  live: () => live,
  // A fresh press clears the window, so its echo does not bleep; a repeat opens
  // it, so the echo it causes does.
  markRepeat: repeat => {
    keyAt = performance.now()
    repeatAt = repeat ? keyAt : 0
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
  live = false
  await withGrid(() => implode(screen.term, snd))
  killSession?.()
  return 0
}

/** One raw keypress. True on y or Y; anything else, EOF or ^C is no. */
async function confirm(p: Proc, prompt: string): Promise<boolean> {
  const t = p.tty
  if (!t) return false
  p.out(prompt)
  await waitForDrain()
  t.setRaw()
  try {
    const chunk = await p.stdin.read()
    const ch = chunk ? String.fromCharCode(chunk[0]) : ''
    t.echo(ch >= ' ' ? ch + '\n' : '\n')
    return ch === 'y' || ch === 'Y'
  } finally {
    t.setCooked()
  }
}

/**
 * Factory state for a guest: every csterm.* key in localStorage, the OPFS home,
 * the service worker and its caches. Members log out first; their home is
 * theirs and the saved session would only be resumed.
 */
async function resetProgram(p: Proc): Promise<number> {
  if (api.authed) { p.err('reset: not while logged in\n'); return 1 }
  if (!(await confirm(p, 'Erase this machine and start as new? (y/N) '))) return 1
  p.out('ERASING ...\n')
  await waitForDrain()
  halted = true
  live = false
  for (const k of Object.keys(localStorage)) if (k.startsWith(STORE_PREFIX)) localStorage.removeItem(k)
  // keys() is missing from the DOM lib types, though every OPFS browser has it.
  const root = await navigator.storage.getDirectory() as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }
  for await (const name of root.keys()) await root.removeEntry(name, { recursive: true }).catch(() => {})
  for (const r of await navigator.serviceWorker?.getRegistrations() ?? []) await r.unregister()
  for (const c of await caches.keys()) await caches.delete(c)
  await withGrid(() => implode(screen.term, snd))
  location.reload()
  return 0
}

/** screensaver(1): the picker. Keys reach it through the overlay route, not the pty. */
async function screensaverProgram(p: Proc): Promise<number> {
  if (!p.tty) { p.err('screensaver: not a tty\n'); return 1 }
  await waitForDrain()
  await saver?.pick()
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
  live = false
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
    cwd: shell.env.PWD || ENV.HOME,
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
    saver = new Screensaver(s, snd, () => halted || !live)
    // The idle timer. Coarse on purpose: the timeout is in minutes.
    setInterval(() => {
      const prefs = saverPrefs()
      if (!prefs.enabled || saver?.open) return
      if (Date.now() - lastActive >= Math.max(1, prefs.minutes) * 60_000) void saver?.start()
    }, 5000)

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
      host: { shutdown: shutdownProgram, reboot: rebootProgram, reset: resetProgram, screensaver: screensaverProgram },
      // Image decoding is faceplate-only, and the metrics depend on the font
      // loaded right now, which F1 can change under a running program.
      pictures: () => pictureHost(s.term),
      pickFile,
    })
    // A kernel that fails while the animation plays would otherwise surface
    // only after standby ends on a keypress. Cut the animation; the await
    // below rethrows into the fault report.
    kernelP.catch(() => { standbyAbort?.abort(); bootAbort?.abort() })
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
      // Warm boot: no strike. The flash belongs to the power-on sequence only.
      snd.powerOn()
    }
    store.set('lastSeen', String(Date.now()))

    const kernel = await kernelP
    // The identity must resolve before loadSession runs: a parked scrollback is
    // restored only for the member it was saved by.
    await resumed
    await writeMotd(api.username)
    machine = kernel

    // Dev-only debug handle. A production page shares its realm with untrusted
    // user programs, so a live reference here is reachable by any of them; api
    // holds the session token and is left off even in dev.
    if (import.meta.env.DEV) {
      ;(globalThis as Record<string, unknown>).cs = {
        kernel, fs, tty, snd, screen, tx, xt, saver,
        dbg: {
          get lock() { return grid.locked },
          get halted() { return halted },
          get update() { return updateWaiting() },
        },
      }
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
      arrival: mode => { tx.mode = mode },
      open: () => { live = true },
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
      // Overrides this frame's blink phase; the loop resumes its own afterwards.
      if (performance.now() - keyAt < RENDER.blinkMs) s.term.cursorVisible = true
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
// Copy and cut are handled from the keyboard, through tty.copy above. The screen
// is a canvas with no DOM selection, so the browser's own copy would overwrite
// the clipboard with an empty string; refuse it and let the tty path write.
window.addEventListener('copy', e => e.preventDefault())
window.addEventListener('cut', e => e.preventDefault())
// iPad Safari fires no paste event unless an editable element has focus, and
// the tablet wires no soft-keyboard field. A hidden field holds focus so Cmd+V
// raises the paste event above; keys still bubble to the window handler, and
// the field itself takes no text. With a hardware keyboard attached iPadOS
// shows no on-screen keyboard for it.
if (TABLET) {
  const field = document.createElement('textarea')
  field.setAttribute('autocapitalize', 'off')
  field.setAttribute('autocomplete', 'off')
  field.setAttribute('autocorrect', 'off')
  field.setAttribute('spellcheck', 'false')
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none'
  document.body.appendChild(field)
  field.addEventListener('beforeinput', e => e.preventDefault())
  field.addEventListener('blur', () => setTimeout(() => field.focus(), 0))
  window.addEventListener('pointerup', () => field.focus())
  field.focus()
}

const canvas = document.getElementById('tube') as HTMLCanvasElement

try {
  await mount(canvas, program)
  if (MOBILE) keyboard.wireSoftKeyboard(canvas)
  else canvas.addEventListener('pointerdown', () => { saver?.stop(); keyboard.pointer() })
} catch (err) {
  const fault = document.getElementById('fault')!
  fault.style.display = 'block'
  fault.textContent = 'THE TUBE DID NOT COME UP\n\n' + String((err as Error)?.stack ?? err)
  canvas.style.display = 'none'
}
