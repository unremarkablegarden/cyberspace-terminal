import { Terminal } from '@xterm/headless'
import { mount } from '@cyberspace/crt'
import { RENDER } from '@cyberspace/crt/config'
import { InMemory, fs } from '@zenfs/core'
import { WebAccess } from '@zenfs/dom'
import { Kernel, Tty, mountAll, bytes } from '@cyberspace/kernel'
import { coreutils } from '@cyberspace/coreutils'
import { shellMain } from '@cyberspace/shell'
import { syncTerm } from './vt'
import { encodeKey } from './keys'
import { Baud } from './baud'

const COLS = 80
const ROWS = 25
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

type \x1b[1mhelp\x1b[0m for programs.

`

const README = `This is your home directory. It lives in this browser and survives reloads.
Nothing here touches the network.

Try:
  echo hello > hi.txt
  cat hi.txt
  ls -l
  history
`

RENDER.cursor = true

async function bootMachine(tty: Tty): Promise<Kernel> {
  const kernel = new Kernel()
  kernel.registerAll(coreutils)
  kernel.register('sh', shellMain)

  const opfs = await navigator.storage.getDirectory()
  await mountAll({
    '/': InMemory,
    '/tmp': InMemory,
    '/bin': InMemory,
    '/home': { backend: WebAccess, handle: opfs },
  })
  await kernel.seed()

  await fs.promises.writeFile('/etc/motd', MOTD.replace(/\r?\n/g, '\n'))
  const readme = `${HOME}/README.txt`
  if (!(await fs.promises.stat(readme).catch(() => null))) {
    await fs.promises.writeFile(readme, README)
  }

  // Debug handle; also how the fs is poked at from the console.
  ;(globalThis as Record<string, unknown>).cs = { kernel, fs, tty }
  return kernel
}

async function session(kernel: Kernel, tty: Tty): Promise<void> {
  for (;;) {
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
    await task.wait
    tty.stdout.write('\n')
  }
}

const xt = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
const tx = new Baud(data => xt.write(data), 9600)
const tty = new Tty(data => tx.write(data.slice()), COLS, ROWS)

let last = 0
const program = {
  async init(): Promise<void> {
    const kernel = await bootMachine(tty)
    void session(kernel, tty)
  },
  frame(screen: any, t: number): void {
    const dt = last ? t - last : 0
    last = t
    tx.drain(dt)
    syncTerm(xt, screen.term)
  },
  key(_screen: any, e: KeyboardEvent): void {
    const s = encodeKey(e)
    if (s === null) return
    e.preventDefault()
    tty.input(bytes(s))
  },
}

const canvas = document.getElementById('tube') as HTMLCanvasElement

try {
  await mount(canvas, program)
} catch (err) {
  const fault = document.getElementById('fault')!
  fault.style.display = 'block'
  fault.textContent = 'THE TUBE DID NOT COME UP\n\n' + String((err as Error)?.stack ?? err)
  canvas.style.display = 'none'
}
