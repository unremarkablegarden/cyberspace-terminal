import { Terminal } from '@xterm/headless'
import { mount, type CrtScreen } from '@cyberspace/crt'
import { RENDER, GRID, PRESETS } from '@cyberspace/crt/config'
import { Sound } from '@cyberspace/crt/audio'
import { strike, implode } from '@cyberspace/crt/effects'
import { FONT_NAMES, familyOf, loadFamily, loadFallback } from '@cyberspace/crt/fonts'
import { SettingsOverlay, type SettingDef } from '@cyberspace/crt/settings'
import { softKeydownWanted, softInputKeys, SENTINEL } from '@cyberspace/crt/softkeys'
import { InMemory, fs } from '@zenfs/core'
import { WebAccess } from '@zenfs/dom'
import { Kernel, Tty, mountAll, bytes, type Proc } from '@cyberspace/kernel'
import { coreutils } from '@cyberspace/coreutils'
import { shellMain } from '@cyberspace/shell'
import { syncTerm } from './vt'
import { encodeKey, encodeKeyName } from './keys'
import { Baud } from './baud'

// Phones get the narrow grid; the soft keyboard is wired below.
const MOBILE = /mobi|android/i.test(navigator.userAgent)
const COLS = MOBILE ? 44 : 80
const ROWS = MOBILE ? 20 : 25
const HOME = '/home/guest'

const ENV = {
  USER: 'guest',
  HOME,
  HOSTNAME: 'cyberspace',
  PATH: '/bin',
  SHELL: '/bin/sh',
  TERM: 'xterm',
  COLUMNS: String(COLS),
  LINES: String(ROWS),
}

const MOTD = `\x1b[1mCYBERSPACE TERMINAL\x1b[0m 0.1
\x1b[2m${COLS}x${ROWS} TEXT  TUBE OK  HOME MOUNTED\x1b[0m

type \x1b[1mhelp\x1b[0m for programs.${MOBILE ? '' : '  \x1b[2mF1 config.\x1b[0m'}

`

const README = `This is your home directory. It lives in this browser and survives reloads.
Nothing here touches the network.

Try:
  echo hello > hi.txt
  cat hi.txt
  ls -l
  history
`

// --- persisted faceplate preferences ---------------------------------------

const store = {
  get: (k: string, fallback: string) => localStorage.getItem('csterm.' + k) ?? fallback,
  set: (k: string, v: string) => localStorage.setItem('csterm.' + k, v),
}

const BAUDS: Record<string, number> = { '2400': 2400, '9600': 9600, '38400': 38400, full: 1e7 }

// --- machinery --------------------------------------------------------------

RENDER.cursor = true
GRID.cols = COLS
GRID.rows = ROWS

const KEYS_BASE = '/sounds/cherry-mx-red-abs'
const snd = new Sound({
  keys: {
    default: [1, 2, 3, 4, 5].map(i => `${KEYS_BASE}/key${i}.wav`),
    space: [`${KEYS_BASE}/space.wav`],
    enter: [`${KEYS_BASE}/enter.wav`],
    del: [`${KEYS_BASE}/del.wav`],
    arrup: [`${KEYS_BASE}/arrup.wav`],
    arrdown: [`${KEYS_BASE}/arrdown.wav`],
    arrleft: [`${KEYS_BASE}/arrleft.wav`],
    arrright: [`${KEYS_BASE}/arrright.wav`],
  },
  bootupUrl: '/sounds/bootup.mp3',
})

const xt = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
const tx = new Baud(data => xt.write(data), BAUDS[store.get('baud', '9600')] ?? 9600)
const tty = new Tty(data => tx.write(data.slice()), COLS, ROWS)

xt.onBell(() => snd.beep(880, 0.09))

// While an effect or the config box owns the grid, the pty sync stays off; the
// xterm buffer is the source of truth, so the diff repairs everything after.
let gridLock = 0
let halted = false
let killSession: (() => void) | null = null

async function withGrid(fn: () => Promise<void>): Promise<void> {
  gridLock++
  const cursor = RENDER.cursor
  RENDER.cursor = false
  try {
    await fn()
  } finally {
    gridLock--
    RENDER.cursor = cursor
  }
}

function waitForDrain(): Promise<void> {
  return new Promise(res => {
    const poll = () => (tx.idle ? res() : setTimeout(poll, 60))
    poll()
  })
}

// --- kernel ------------------------------------------------------------------

async function bootMachine(): Promise<Kernel> {
  const kernel = new Kernel()
  kernel.registerAll(coreutils)
  kernel.register('sh', shellMain)
  kernel.register('shutdown', shutdownProgram)
  kernel.register('reboot', rebootProgram)

  const opfs = await navigator.storage.getDirectory()
  await mountAll({
    '/': InMemory,
    '/bin': InMemory,
    '/tmp': InMemory,
    '/home': { backend: WebAccess, handle: opfs },
  })
  await kernel.seed()

  await fs.promises.writeFile('/etc/motd', MOTD.replace(/\r?\n/g, '\n'))
  const readme = `${HOME}/README.txt`
  if (!(await fs.promises.stat(readme).catch(() => null))) {
    await fs.promises.writeFile(readme, README)
  }

  ;(globalThis as Record<string, unknown>).cs = { kernel, fs, tty, snd, screen }
  return kernel
}

async function shutdownProgram(p: Proc): Promise<number> {
  p.out('\nTHE SYSTEM IS HALTED\n')
  await waitForDrain()
  halted = true
  await withGrid(() => implode(screen.term, snd))
  killSession?.()
  return 0
}

async function rebootProgram(p: Proc): Promise<number> {
  p.out('\nrebooting...\n')
  await waitForDrain()
  halted = true
  await withGrid(() => implode(screen.term, snd))
  location.reload()
  return 0
}

async function session(kernel: Kernel): Promise<void> {
  while (!halted) {
    const motd = await fs.promises.readFile('/etc/motd', 'utf8').catch(() => '')
    tty.stdout.write(String(motd))
    const task = kernel.spawn(shellMain, {
      argv: ['sh'],
      env: { ...ENV },
      cwd: HOME,
      stdin: tty.stdin,
      stdout: tty.stdout,
      stderr: tty.stdout,
      tty,
    })
    killSession = () => task.kill()
    await task.wait
    killSession = null
    tty.stdout.write('\n')
  }
}

// --- faceplate settings ------------------------------------------------------

let overlay: SettingsOverlay | null = null

function buildSettings(screen: CrtScreen): SettingDef[] {
  let screenName = store.get('screen', 'sharp')
  let phosphor = store.get('phosphor', 'matrix')
  let fontName = store.get('font', 'terminus-8x16')
  let sound = store.get('sound', 'on')
  let baud = store.get('baud', '9600')

  return [
    {
      name: 'SCREEN',
      values: () => Object.keys(PRESETS),
      current: () => screenName,
      apply: v => {
        screenName = v
        store.set('screen', v)
        screen.crt.setParams(PRESETS[v as keyof typeof PRESETS])
      },
    },
    {
      name: 'PHOSPHOR',
      values: () => ['matrix', 'vt320', 'brutalist', 'bubblegum', 'white'],
      current: () => phosphor,
      apply: v => {
        phosphor = v
        store.set('phosphor', v)
        screen.crt.setPhosphor(v)
      },
    },
    {
      name: 'FONT',
      values: () => FONT_NAMES,
      current: () => fontName,
      apply: v => {
        fontName = v
        store.set('font', v)
        void loadFamily(screen.term, familyOf(v)).then(() => {
          screen.crt.setSource(screen.term.w, screen.term.h)
          overlay?.draw()
        })
      },
    },
    {
      name: 'SOUND',
      values: () => ['on', 'half', 'off'],
      current: () => sound,
      apply: v => {
        sound = v
        store.set('sound', v)
        const level = v === 'on' ? 1 : v === 'half' ? 0.5 : 0
        snd.setChannel('background', level)
        snd.setChannel('keys', level)
        snd.setChannel('beeps', level)
      },
    },
    {
      name: 'BAUD',
      values: () => Object.keys(BAUDS),
      current: () => baud,
      apply: v => {
        baud = v
        store.set('baud', v)
        tx.cps = BAUDS[v]
      },
    },
  ]
}

function restoreSettings(defs: SettingDef[]): void {
  for (const def of defs) {
    const v = def.current()
    if (def.values().includes(v)) def.apply(v)
  }
}

// --- input -------------------------------------------------------------------

let woken = false
function wake(): void {
  snd.resume()
  if (!woken) {
    woken = true
    snd.start()
  }
}

function handleKeyName(name: string, ctrl = false): void {
  if (overlay?.open) {
    overlay.key(name)
    if (!overlay.open) gridLock--
    return
  }
  const s = encodeKeyName(name, ctrl)
  if (s !== null) tty.input(bytes(s))
}

function toggleOverlay(): void {
  if (!overlay) return
  if (overlay.open) {
    overlay.hide()
    gridLock--
  } else {
    gridLock++
    overlay.toggle()
  }
}

function wireSoftKeyboard(canvas: HTMLCanvasElement): void {
  const field = document.createElement('textarea')
  field.setAttribute('autocapitalize', 'off')
  field.setAttribute('autocomplete', 'off')
  field.setAttribute('autocorrect', 'off')
  field.setAttribute('spellcheck', 'false')
  field.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;opacity:0;border:0;padding:0;' +
    'background:transparent;color:transparent;caret-color:transparent;z-index:10;resize:none'
  field.value = SENTINEL
  document.body.appendChild(field)

  const reset = () => {
    field.value = SENTINEL
    field.setSelectionRange(1, 1)
  }

  canvas.addEventListener('pointerdown', () => {
    wake()
    field.focus()
  })
  field.addEventListener('pointerdown', wake)

  field.addEventListener('keydown', e => {
    if (!softKeydownWanted(e)) return
    e.preventDefault()
    snd.key(e)
    handleKeyName(e.key, e.ctrlKey)
  })
  field.addEventListener('beforeinput', e => {
    e.preventDefault()
    const r = softInputKeys(e.inputType, (e as InputEvent).data)
    if (r.kind === 'keys') {
      for (const k of r.keys) {
        snd.key({ key: k })
        handleKeyName(k)
      }
    }
    reset()
  })
  field.addEventListener('input', reset)
}

// --- boot --------------------------------------------------------------------

let screen: CrtScreen
let last = 0

const program = {
  async init(s: CrtScreen): Promise<void> {
    screen = s
    void snd.load()
    void loadFallback(s.term)

    const defs = buildSettings(s)
    restoreSettings(defs)
    overlay = new SettingsOverlay(s.term, defs)

    // Restore a saved face before anything is on the glass.
    const savedFont = store.get('font', 'terminus-8x16')
    if (savedFont !== 'terminus-8x16') {
      await loadFamily(s.term, familyOf(savedFont)).catch(() => {})
      s.crt.setSource(s.term.w, s.term.h)
    }

    snd.powerOn()
    void snd.bootup()
    await withGrid(() => strike(s.term, snd))

    const kernel = await bootMachine()
    void session(kernel)
  },

  frame(s: CrtScreen, t: number): void {
    const dt = last ? t - last : 0
    last = t
    if (gridLock === 0 && !halted) {
      const sent = tx.drain(dt)
      // Bulk output chatters; a single echoed keystroke does not.
      if (sent >= 4) snd.blip(1400)
      syncTerm(xt, s.term)
    }
  },

  key(_s: unknown, e: KeyboardEvent): void {
    wake()
    if (e.key === 'F1') {
      e.preventDefault()
      toggleOverlay()
      return
    }
    if (overlay?.open) {
      e.preventDefault()
      snd.key(e)
      handleKeyName(e.key, e.ctrlKey)
      return
    }
    const str = encodeKey(e)
    if (str === null) return
    e.preventDefault()
    snd.key(e)
    tty.input(bytes(str))
  },
}

const canvas = document.getElementById('tube') as HTMLCanvasElement

try {
  await mount(canvas, program)
  if (MOBILE) wireSoftKeyboard(canvas)
  else canvas.addEventListener('pointerdown', wake)
} catch (err) {
  const fault = document.getElementById('fault')!
  fault.style.display = 'block'
  fault.textContent = 'THE TUBE DID NOT COME UP\n\n' + String((err as Error)?.stack ?? err)
  canvas.style.display = 'none'
}
