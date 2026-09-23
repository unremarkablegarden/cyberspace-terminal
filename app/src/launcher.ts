// launch(1): the programs worth opening, in a list styled like the CMD-K
// switcher, on the CRT grid outside the pty.
//
// Filters and tools (ls, grep, cat) are left out: the list is PROGRAMS, where
// installed on this machine, then the files in ~/bin, then LAST.
// The chosen line is queued with Jobs.launchAfter, so it runs as its own job once launch exits.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { RENDER } from '@cyberspace/crt/config'
import { fs, type Proc } from '@cyberspace/kernel'
import { MUTED, ScreenStack, SelectPopup, type KeyInput } from '@cyberspace/tui'
import { grid } from './grid'
import type { Overlay } from './input'
import { NEEDS_LOGIN } from './palette'

/** Shown in this order, each only when it resolves. */
const PROGRAMS: Launchable[] = [
  { line: 'login', summary: 'log in to cyberspace.online' },
  { line: 'inbox', summary: 'notifications and unread mail' },
  { line: 'feed', summary: 'posts' },
  { line: 'circ', summary: 'chat rooms' },
  { line: 'cmail', summary: 'direct messages' },
  { line: 'globe', summary: 'members on a wireframe Earth' },
  { line: 'browse', summary: 'published programs' },
  { line: 'edit', summary: 'text editor' },
  { line: 'vim', summary: 'text editor' },
  { line: 'doom', summary: 'DOOM (shareware)' },
  { line: 'tree', summary: 'the current directory as a tree' },
  { line: 'fortune', summary: 'a fortune cookie' },
  { line: 'changelog', summary: 'release notes' },
  { line: 'screensaver', summary: 'pick a screensaver' },
  { line: 'config', summary: 'font, screen, phosphor, sound' },
]
/** After ~/bin, the last row. */
const LAST: Launchable = { line: 'wardial', summary: 'scan an exchange for modems' }
const TITLE = 'LAUNCH'
const GAP = 2

export interface Launchable {
  /** The command line run on Enter. */
  line: string
  summary: string
  /** Shown but not selectable. */
  locked?: boolean
}

/** PROGRAMS that resolve on this machine, then ~/bin, then LAST. login only when logged out, the network programs locked until then. */
export async function launchables(p: Proc, authed: boolean): Promise<Launchable[]> {
  const out: Launchable[] = []
  for (const prog of PROGRAMS) {
    if (prog.line === 'login' && authed) continue
    if (!await p.kernel.resolveExec(prog.line, p.cwd, p.env)) continue
    out.push({ ...prog, locked: !authed && NEEDS_LOGIN.has(prog.line) })
  }
  const bin = `${p.env.HOME ?? '/'}/bin`
  const names = (await fs.promises.readdir(bin).catch(() => [] as string[])).sort()
  for (const name of names) {
    if (name.startsWith('.')) continue
    const st = await fs.promises.stat(`${bin}/${name}`).catch(() => null)
    if (!st || st.isDirectory()) continue
    // A registry program of the same name resolves before the path search, so the file needs its full path.
    const line = p.kernel.resolveProgram(name) ? `${bin}/${name}` : name
    out.push({ line, summary: '~/bin' })
  }
  if (await p.kernel.resolveExec(LAST.line, p.cwd, p.env)) out.push(LAST)
  return out
}

export class Launcher implements Overlay {
  private stack: ScreenStack | null = null
  private cursorWas = true

  constructor(private screen: CrtScreen, private snd: Sound) {}

  get open(): boolean {
    return !!this.stack?.active
  }

  key(k: KeyInput): void {
    this.stack?.key(k)
  }

  silentKey(k: KeyInput): boolean {
    return !!this.stack?.top?.silentKey?.(k)
  }

  /** Show the list. Resolves with the chosen line, or null on Escape. */
  pick(programs: Launchable[]): Promise<string | null> {
    this.stack ??= new ScreenStack(this.screen.term as never)
    grid.lock()
    this.cursorWas = RENDER.cursor
    RENDER.cursor = false
    this.snd.tick()

    const nameW = Math.max(...programs.map(a => a.line.length), 5)
    const summaryAt = 1 + GAP + nameW + GAP
    const items = programs.map((a, i) =>
      `${i < 9 ? String(i + 1) : ' '}${' '.repeat(GAP)}${a.line.padEnd(nameW)}${' '.repeat(GAP)}${a.summary}`)
    const selected = Math.max(0, programs.findIndex(a => !a.locked))

    return new Promise(resolve => {
      this.stack!.push(new SelectPopup({
        title: TITLE,
        items,
        selected,
        keys: programs.map((_, i) => (i < 9 ? String(i + 1) : '')),
        hint: `1-${Math.min(9, programs.length)} ⬆⬇ ↵  ESC`,
        shadow: true,
        disabled: i => !!programs[i]!.locked,
        decorate: (term, row, i, sel) => {
          if (sel || programs[i]!.locked) return
          // The summary reads quieter than the name, as the state column does in the switcher.
          const s = items[i]!.slice(summaryAt)
          term.text(row.x + summaryAt, row.y, s.slice(0, Math.max(0, row.w - summaryAt)), MUTED)
        },
        onFeedback: kind => {
          if (kind === 'edge') this.snd.beep(220, 0.04)
          else if (kind === 'move') this.snd.tick()
          else if (kind === 'cancel') this.snd.blip(420, 0.09, 0)
        },
        onDone: (item, index) => {
          while (this.stack?.active) this.stack.pop()
          grid.unlock()
          RENDER.cursor = this.cursorWas
          resolve(item === null ? null : programs[index]!.line)
        },
      }))
    })
  }
}
