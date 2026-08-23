import { registerSW } from 'virtual:pwa-register'
import { Terminal } from '@xterm/headless'
import { mount, type CrtScreen } from '@cyberspace/crt'
import { RENDER, GRID, PRESETS } from '@cyberspace/crt/config'
import { Sound } from '@cyberspace/crt/audio'
import { strike, implode, Aborted } from '@cyberspace/crt/effects'
import { bootSequence } from '@cyberspace/crt/boot'
import {
  FONT_ENTRIES, fontFace, fontLabel, familyOf, loadFamily, loadFallback,
} from '@cyberspace/crt/fonts'
import { SettingsOverlay, type Setting } from '@cyberspace/crt/settings'
import { KEY_PACK_NAMES, DEFAULT_KEY_PACK } from '@cyberspace/crt/keypacks'
import { CRT_CONTROLS } from '@cyberspace/crt/controls'
import { SAVER_NAMES, type ScreensaverPrefs } from '@cyberspace/crt/saverdefs'
import { softKeydownWanted, softInputKeys, SENTINEL } from '@cyberspace/crt/softkeys'
import { InMemory, fs } from '@zenfs/core'
import { Kernel, Tty, mountAll, bytes, type Proc, readText } from '@cyberspace/kernel'
import { coreutils } from '@cyberspace/coreutils'
import { shellMain } from '@cyberspace/shell'
import { ApiClient, circProgram, cmailProgram, cyberspacePrograms, registryPrograms } from '@cyberspace/apps'
import { compatFileHandler } from '@cyberspace/compat'
import { OpfsHome } from './opfs'
import { syncTerm } from './vt'
import { encodeKey, encodeKeyName } from './keys'
import { Baud } from './baud'

// Offline shell. A new worker downloads in the background and WAITS — it
// takes over on the next fresh visit, never under a live session.
registerSW({ immediate: true })

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

const motdText = (user: string | null) => `\x1b[1mCYBERSPACE TERMINAL\x1b[0m 0.1
\x1b[2m${COLS}x${ROWS} TEXT  TUBE OK  HOME MOUNTED${user ? '  LINK UP' : '  NO CARRIER'}\x1b[0m

Type \x1b[1mhelp\x1b[0m for commands.${user ? '' : '  Type \x1b[1mlogin\x1b[0m to connect.'}${MOBILE ? '' : '\n\x1b[1mF1\x1b[0m Config'}

`

const README = `Home directory. Persists in this browser. Files stay local.

Examples:
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

/**
 * The line, fixed. 2400 baud is ten bits a character, so 240 a second — the
 * rate the machine has always run at and no longer a thing to be told about.
 */
const CPS = 240

/** Levels the AUDIO rows offer, and what each is worth on the bus. */
const AUDIO_LEVELS: [string, number][] = [['off', 0], ['25%', 0.25], ['50%', 0.5], ['100%', 1]]
const levelLabel = (v: number): string =>
  AUDIO_LEVELS.reduce((best, [label, level]) =>
    Math.abs(level - v) < Math.abs(AUDIO_LEVELS.find(l => l[0] === best)![1] - v) ? label : best,
  AUDIO_LEVELS[0][0])

// --- machinery --------------------------------------------------------------

RENDER.cursor = true
GRID.cols = COLS
GRID.rows = ROWS

const snd = new Sound({ bootupUrl: '/sounds/bootup.mp3' })

// Public client config, same values any web client ships. Live chat reads
// stream straight from RTDB with the caller's idToken; writes go via the API.
const RTDB_URL = 'https://cyberspace-cyberspace-default-rtdb.europe-west1.firebasedatabase.app'

const api = new ApiClient('https://api.cyberspace.online', {
  get: () => localStorage.getItem('csterm.auth'),
  set: v => (v ? localStorage.setItem('csterm.auth', v) : localStorage.removeItem('csterm.auth')),
})
api.onAuthChange = user => {
  ENV.USER = user ?? 'guest'
  void writeMotd()
}

const xt = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
const tx = new Baud(data => xt.write(data), CPS, 'char')
// Echo is urgent: the operator's own keystrokes never queue behind output.
const tty = new Tty((data, urgent) => (urgent ? tx.now(data.slice()) : tx.write(data.slice())), COLS, ROWS)

xt.onBell(() => snd.beep(880, 0.09))

// While an effect or the config box owns the grid, the pty sync stays off; the
// xterm buffer is the source of truth, so the diff repairs everything after.
let gridLock = 0
let halted = false
let killSession: (() => void) | null = null
// Live only while the cold-boot sequence plays; ^C aborts it.
let bootAbort: AbortController | null = null

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
  // After coreutils: the network whoami (answers with the login) wins.
  kernel.registerAll(cyberspacePrograms(api))
  // The chat screens have opinions about sounds and make none of their own.
  const chatSnd = {
    tick: () => snd.tick(),
    beep: (hz?: number, dur?: number) => snd.beep(hz, dur),
    blip: (hz?: number, dur?: number, jitter?: number) => snd.blip(hz, dur, jitter),
  }
  kernel.register('circ', circProgram(api, RTDB_URL, chatSnd))
  kernel.register('cmail', cmailProgram(api, RTDB_URL, chatSnd))
  kernel.registerAll(registryPrograms(api))

  // Programs from the original /terminal, recognised by their export.
  kernel.fileHandlers.push(compatFileHandler({
    username: () => api.username ?? ENV.USER,
    version: '0.1',
    api: {
      get: path => api.get(path),
      post: (path, body) => api.post(path, body),
      del: path => api.delete(path),
    },
    snd: {
      blip: (hz, dur, jitter) => snd.blip(hz, dur, jitter),
      beep: (freq, dur) => snd.beep(freq, dur),
      tick: () => snd.tick(),
      seek: n => snd.seek(n),
      hiss: (dur, gain) => snd.hiss(dur, gain),
    },
    feed: {
      page: async (limit = 10) => {
        const posts = await api.get<Record<string, unknown>[]>(`/v1/posts?limit=${Math.min(50, limit)}`)
        return posts.map(post => ({
          username: post.authorUsername ?? '?',
          title: post.title ?? '',
          words: typeof post.content === 'string' ? post.content.split(/\s+/).filter(Boolean).length : 0,
          replies: post.replyCount ?? post.repliesCount ?? 0,
          at: post.createdAt,
        }))
      },
    },
  }))

  const opfs = await navigator.storage.getDirectory()
  await mountAll({
    '/': InMemory,
    '/bin': InMemory,
    '/tmp': InMemory,
    '/home': { backend: OpfsHome, handle: opfs },
  })
  await kernel.seed()

  await writeMotd()
  const readme = `${HOME}/README.txt`
  if (!(await fs.promises.stat(readme).catch(() => null))) {
    await fs.promises.writeFile(readme, README)
  }

  // Example programs from the original machine.
  await fs.promises.mkdir('/bin/examples').catch(() => {})
  for (const name of ['hello', 'roll', 'clock', 'river', 'news']) {
    void fetch(`/examples/${name}.js`)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(text => fs.promises.writeFile(`/bin/examples/${name}`, text, { mode: 0o755 }))
      .catch(() => {})
  }

  // Demo wasm cargo, installed in the background once fetched.
  void fetch('/wasm/cowsay.wasm')
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then(buf => fs.promises.writeFile('/bin/cowsay', new Uint8Array(buf), { mode: 0o755 }))
    .catch(() => {})

  ;(globalThis as Record<string, unknown>).cs = {
    kernel, fs, tty, snd, screen, api, tx, xt,
    dbg: { get lock() { return gridLock }, get halted() { return halted } },
  }
  return kernel
}

async function writeMotd(): Promise<void> {
  await fs.promises.writeFile('/etc/motd', motdText(api.username)).catch(() => {})
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
  p.out('\nThe system is going down for reboot NOW.\n')
  await waitForDrain()
  halted = true
  await withGrid(() => implode(screen.term, snd))
  location.reload()
  return 0
}

async function session(kernel: Kernel): Promise<void> {
  while (!halted) {
    const motd = await readText('/etc/motd').catch(() => '')
    tty.stdout.write(String(motd))
    await waitForDrain()
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

/** What the mixer is on, and the board under the keys. */
interface Audio { background: number; keys: number; beeps: number; pack: string }

function readAudio(): Audio {
  const fallback: Audio = { background: 1, keys: 1, beeps: 1, pack: DEFAULT_KEY_PACK }
  try {
    const saved = JSON.parse(store.get('sound', '')) as Partial<Audio>
    return { ...fallback, ...saved }
  } catch {
    return fallback
  }
}

function writeAudio(a: Audio): void {
  store.set('sound', JSON.stringify(a))
}

/**
 * The settings, rebuilt on every open rather than held.
 *
 * `current` is a getter throughout for the same reason: the truth is not the
 * screen's. A saved tube preset grows the SCREEN list, and the shell can move
 * any of this from underneath the box.
 */
function settings(screen: CrtScreen): Setting[] {
  const audio = readAudio()

  const channel = (name: 'background' | 'keys' | 'beeps'): Setting => ({
    label: name,
    values: AUDIO_LEVELS.map(([label]) => label),
    current: () => levelLabel(snd.channel(name)),
    select: (value) => {
      const level = AUDIO_LEVELS.find(([label]) => label === value)?.[1] ?? 0
      snd.setChannel(name, level)
      const next = readAudio()
      next[name] = level
      writeAudio(next)
      return value
    },
  })

  return [
    {
      // Labels, not names: a family and its bold and oblique cuts are one face
      // in three, and three rows saying 6x13 would be three rows saying the
      // same thing.
      label: 'FONT',
      values: FONT_ENTRIES.map(e => e.label),
      current: () => fontLabel(store.get('font', 'terminus-8x16')),
      // The one async setting — a face is fetched and parsed, and one that
      // fails to load answers with the face that is still up.
      select: async (label) => {
        const name = fontFace(label)
        try {
          await loadFamily(screen.term, familyOf(name))
          screen.crt.setSource(screen.term.w, screen.term.h)
          store.set('font', name)
          return label
        } catch {
          return fontLabel(store.get('font', 'terminus-8x16'))
        }
      },
    },
    {
      label: 'SCREEN',
      values: [...Object.keys(PRESETS), USER_PRESET],
      current: () => store.get('screen', 'sharp'),
      select: (value) => {
        store.set('screen', value)
        screen.crt.setParams(value === USER_PRESET ? userParams() : PRESETS[value as keyof typeof PRESETS])
        return value
      },
      // Only the member's own tube opens further. The other three are presets —
      // fixed alternatives with nothing inside them.
      tune: value => value !== USER_PRESET ? null : {
        title: USER_PRESET.toUpperCase(),
        groups: CRT_CONTROLS,
        get: key => userParams()[key] ?? 0,
        set: (key, v) => setUserParam(screen, key, v),
        reset: key => resetUserParam(screen, key),
      },
    },
    {
      label: 'PHOSPHOR',
      values: ['matrix', 'vt320', 'brutalist', 'bubblegum', 'white'],
      current: () => store.get('phosphor', 'matrix'),
      select: (value) => {
        store.set('phosphor', value)
        screen.crt.setPhosphor(value)
        return value
      },
    },
    {
      label: 'AUDIO',
      values: [],
      // A group has no single value, so the left pane reports the shape of the
      // three underneath it: their level where they agree, "mixed" where they
      // do not. Which one is where is the right pane's business.
      current: () => {
        const labels = (['background', 'keys', 'beeps'] as const).map(c => levelLabel(snd.channel(c)))
        return labels.every(l => l === labels[0]) ? labels[0] : 'mixed'
      },
      select: v => v,
      children: [
        channel('background'),
        channel('keys'),
        channel('beeps'),
        // Which board, not how loud — the odd row out in a group of three
        // levels. It sits under `keys` deliberately: that row is its volume.
        {
          label: 'keyboard',
          values: KEY_PACK_NAMES,
          current: () => snd.keyPackName,
          select: (value) => {
            const name = snd.setKeyPack(value)
            const next = readAudio()
            next.pack = name
            writeAudio(next)
            return name
          },
        },
      ],
    },
    {
      label: 'SCREENSAVER',
      values: [],
      // The left pane answers "is it on, and how patient" in one word; which
      // saver is the right pane's business.
      current: () => saverPrefs().enabled ? `${saverPrefs().minutes}min` : 'off',
      select: v => v,
      children: [
        {
          label: 'enabled',
          values: ['on', 'off'],
          current: () => saverPrefs().enabled ? 'on' : 'off',
          select: (v) => { setSaverPrefs({ enabled: v === 'on' }); return v },
        },
        {
          label: 'after',
          values: SAVER_MINUTES,
          current: () => String(saverPrefs().minutes),
          select: (v) => { setSaverPrefs({ minutes: Number(v) || 10 }); return v },
        },
        {
          label: 'saver',
          values: [...SAVER_NAMES],
          current: () => saverPrefs().saver,
          select: (v) => { setSaverPrefs({ saver: v }); return v },
        },
      ],
    },
  ]
}

// --- the screensaver ---------------------------------------------------------

const SAVER_MINUTES = ['1', '2', '5', '10', '15', '30']

function saverPrefs(): ScreensaverPrefs {
  const fallback: ScreensaverPrefs = { enabled: true, minutes: 10, saver: SAVER_NAMES[0] }
  try {
    return { ...fallback, ...JSON.parse(store.get('screensaver', '')) as Partial<ScreensaverPrefs> }
  } catch {
    return fallback
  }
}

function setSaverPrefs(patch: Partial<ScreensaverPrefs>): void {
  store.set('screensaver', JSON.stringify({ ...saverPrefs(), ...patch }))
}

/** The saver on the glass, and the clock that puts it there. */
let saverUp: { dispose(): void } | null = null
let saverStack: import('@cyberspace/tui').ScreenStack | null = null

async function startSaver(s: CrtScreen): Promise<void> {
  if (saverUp || overlay?.open || halted || gridLock !== 0) return
  const { SaverScreen, pickSaver } = await import('@cyberspace/crt/saver')
  const { ScreenStack } = await import('@cyberspace/tui')
  if (saverUp || overlay?.open || halted) return

  saverStack ??= new ScreenStack(s.term as never)
  gridLock++
  const decayWas = null as number | null
  const screen = new SaverScreen(
    s.term as never,
    pickSaver(saverPrefs().saver),
    {
      setDecay: value => s.crt.setParams({ decay: value ?? decayWas ?? 0.6 }),
      // No cookie jar on this machine yet; the saver says so for itself.
      fortune: async () => null,
    },
    () => stopSaver(),
  )
  saverUp = screen
  saverStack.push(screen as never)
}

function stopSaver(): void {
  if (!saverUp) return
  saverUp = null
  saverStack?.pop()
  gridLock--
  // Whatever the saver was holding the tube at, the prompt is not it.
  const preset = store.get('screen', 'sharp')
  screen?.crt.setParams(preset === USER_PRESET ? userParams() : PRESETS[preset as keyof typeof PRESETS] ?? PRESETS.sharp)
}

/** The member's own tube: the same twenty-odd numbers with them holding them. */
const USER_PRESET = 'user'

function userParams(): Record<string, number> {
  try {
    return JSON.parse(store.get('crt.user', '')) as Record<string, number>
  } catch {
    return { ...PRESETS.sharp }
  }
}

function setUserParam(screen: CrtScreen, key: string, value: number): void {
  const params = { ...userParams(), [key]: value }
  store.set('crt.user', JSON.stringify(params))
  // Turning a knob selects the tube it belongs to; anything else would be a
  // knob that moves nothing until you go and pick `user` yourself.
  store.set('screen', USER_PRESET)
  screen.crt.setParams(params)
}

function resetUserParam(screen: CrtScreen, key?: string): void {
  const base = PRESETS.sharp as Record<string, number>
  const params = key ? { ...userParams(), [key]: base[key] ?? 0 } : { ...base }
  store.set('crt.user', JSON.stringify(params))
  screen.crt.setParams(params)
}

/** Put the saved preferences on the machine at boot. */
function restoreSettings(screen: CrtScreen): void {
  const audio = readAudio()
  snd.setChannel('background', audio.background)
  snd.setChannel('keys', audio.keys)
  snd.setChannel('beeps', audio.beeps)
  snd.setKeyPack(audio.pack)

  const preset = store.get('screen', 'sharp')
  screen.crt.setParams(preset === USER_PRESET ? userParams() : PRESETS[preset as keyof typeof PRESETS] ?? PRESETS.sharp)
  screen.crt.setPhosphor(store.get('phosphor', 'matrix'))
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

/**
 * Every key clicks, once, here — before anything decides what it means.
 *
 * Escape, Shift on its way to a capital, a chord's Ctrl, an F-key, whatever the
 * browser takes for itself: it is a keyboard, and a key you press makes a noise
 * whether or not the machine does anything with it. Said once rather than at
 * each branch that handles a key, because a rule that cannot be forgotten beats
 * a dozen call sites that can — the old arrangement was silent wherever
 * somebody forgot, which is how Escape and the F-keys ended up mute.
 *
 * One exception: a key the thing on screen answers with a sound of its own. The
 * config box ticks as it moves and a chat log ticks as it scrolls; a clack on
 * top of that is one keypress making two noises.
 *
 * Auto-repeat is not exempted here — Sound.key drops it, because a switch
 * clicks going down and the characters after that are the controller's doing.
 */
function click(e: { key: string; repeat?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): void {
  if (overlay?.open) {
    const k = {
      key: e.key, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, metaKey: false, altKey: false,
    }
    if (!overlay.silentKey(k)) snd.key(e)
    return
  }
  if (tty.isSilent(e.key)) return
  snd.key(e)
}

function handleKeyName(name: string, ctrl = false, shift = false): void {
  if (overlay?.open) {
    const k = { key: name, ctrlKey: ctrl, shiftKey: shift, metaKey: false, altKey: false }
    overlay.key(k)
    if (!overlay.open) closeOverlay()
    return
  }
  const s = encodeKeyName(name, ctrl)
  if (s === null) return
  if (bootAbort && s === '\x03') {
    bootAbort.abort()
    return
  }
  if (s === '\x03') tx.flush()
  tty.input(bytes(s))
}

/** What the caret was doing before the box covered it. */
let cursorWas = true

function closeOverlay(): void {
  gridLock--
  RENDER.cursor = cursorWas
}

function toggleOverlay(): void {
  if (!overlay) return
  if (overlay.open) {
    overlay.hide()
    closeOverlay()
    return
  }
  gridLock++
  // Nothing in the box is typed into. The render loop writes showCursor from
  // RENDER.cursor on EVERY frame, so a screen that turns the caret off for
  // itself has it turned back on a frame later — this is the only switch that
  // holds.
  cursorWas = RENDER.cursor
  RENDER.cursor = false
  overlay.toggle()
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
    click(e)
    handleKeyName(e.key, e.ctrlKey, e.shiftKey)
  })
  field.addEventListener('beforeinput', e => {
    e.preventDefault()
    const r = softInputKeys(e.inputType, (e as InputEvent).data)
    if (r.kind === 'keys') {
      for (const k of r.keys) {
        click({ key: k })
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

    restoreSettings(s)
    overlay = new SettingsOverlay(s.term, () => settings(s))
    overlay.onFeedback = kind => {
      if (kind === 'edge') snd.beep(220, 0.04)
      // The same voice a screen closing has everywhere else here.
      else if (kind === 'cancel') snd.blip(420, 0.09, 0)
      else snd.tick()
    }

    // Restore a saved face before anything is on the glass.
    const savedFont = store.get('font', 'terminus-8x16')
    if (savedFont !== 'terminus-8x16') {
      await loadFamily(s.term, familyOf(savedFont)).catch(() => {})
      s.crt.setSource(s.term.w, s.term.h)
    }

    snd.powerOn()
    // Cold start: first visit, or long enough away that the machine was off.
    const cold = Date.now() - Number(store.get('lastSeen', '0')) > 10 * 60 * 1000
    // The machine boots under the animation; it never touches the grid.
    const kernelP = bootMachine()
    // The saved session resumes under the strike; a dead network never blocks boot.
    const resumed = api.hasSavedSession
      ? Promise.race([api.resume(), new Promise<null>(res => setTimeout(() => res(null), 5000))])
      : Promise.resolve(null)

    if (cold) {
      // The chime scores the boot; the fetch/decode runs under the strike.
      void snd.bootup()
      const abort = new AbortController()
      bootAbort = abort
      await withGrid(async () => {
        try {
          await strike(s.term, snd, abort.signal)
          await bootSequence(s.term, snd, abort.signal, { version: '0.1' })
        } catch (err) {
          if (!(err instanceof Aborted)) throw err
          // A skip, not a failure: kill the chime and land on the prompt.
          snd.stopBootup()
          s.term.clear()
        }
      })
      bootAbort = null
    } else {
      await withGrid(() => strike(s.term, snd))
    }
    store.set('lastSeen', String(Date.now()))

    const kernel = await kernelP
    await resumed
    await writeMotd()
    void session(kernel)
  },

  frame(s: CrtScreen, t: number): void {
    // The screen counts seconds since boot; the pacer counts milliseconds.
    const dt = last ? (t - last) * 1000 : 0
    last = t
    if (gridLock === 0 && !halted) {
      // What the machine said, which is the only thing that bleeps: drain()
      // does not count the echo under the operator's fingers.
      if (tx.drain(dt) > 0) snd.blip(1400)
      syncTerm(xt, s.term)
      // The loop above this wrote showCursor from RENDER.cursor; a full-screen
      // program that turned the caret off gets the last word.
      s.term.showCursor = RENDER.cursor && tty.caret
    }
  },

  key(_s: unknown, e: KeyboardEvent): void {
    wake()
    click(e)
    // ^C skips the cold boot. Kept out of the tty — no shell exists yet.
    if (bootAbort && e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      bootAbort.abort()
      return
    }
    if (e.key === 'F1') {
      e.preventDefault()
      toggleOverlay()
      return
    }
    if (overlay?.open) {
      e.preventDefault()
      handleKeyName(e.key, e.ctrlKey, e.shiftKey)
      return
    }
    const str = encodeKey(e)
    if (str === null) return
    e.preventDefault()
    // Stop means stop: whatever the line was still typing out goes with it.
    if (str === '\x03') tx.flush()
    tty.input(bytes(str))
  },
}

// rAF suspends in hidden tabs (and xterm parses writes asynchronously, so the
// grid always trails the parser by one tick). A slow interval keeps the
// machine advancing while nobody is looking.
setInterval(() => {
  if (!document.hidden || gridLock !== 0 || halted || !screen) return
  tx.drain(1000)
  syncTerm(xt, screen.term)
}, 1000)

window.addEventListener('paste', e => {
  const text = e.clipboardData?.getData('text')
  if (!text) return
  e.preventDefault()
  wake()
  if (overlay?.open) return
  tty.input(bytes(text.replace(/\r\n?/g, '\r')))
})

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
