// The screensaver: the idle saver over whatever is running, and the
// `screensaver` picker. Both sit on a screen stack over the CRT grid under the
// grid lock, so main's frame loop leaves the cells to them; the xterm buffer
// stays authoritative and the next sync repairs the screen on release.
//
// Keys reach here through Keyboard's overlay routing, the same path as F1.
// The saver roster is a dynamic import: nothing of it is fetched until a saver
// runs.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { RENDER } from '@cyberspace/crt/config'
import type { KeyInput, Screen, ScreenStack } from '@cyberspace/tui'
import { grid } from './grid'
import { saverPrefs, screenParams, setSaverPrefs } from './prefs'

type SaverModule = typeof import('@cyberspace/crt/saver')
type TuiModule = typeof import('@cyberspace/tui')

/** Name column width in the picker, which the summaries are indented to. */
const NAME_W = 9
/** Width of the gutter carrying the `*` that marks the active saver, including its space. */
const MARK_W = 2

export class Screensaver {
  private stack: ScreenStack | null = null
  /** The idle saver, when up. The picker's preview is not this. */
  private idle: Screen | null = null
  /** The picker, when up. */
  private picker: Screen | null = null
  private loading = false
  /** RENDER.cursor as it was before the first screen went up, restored on release. */
  private cursorWas = true

  constructor(
    private screen: CrtScreen,
    private snd: Sound,
    /** Refuses the saver: the machine is halted, booting, or a shell is not yet reading. */
    private blocked: () => boolean,
  ) {}

  get open(): boolean {
    return this.idle !== null || this.picker !== null
  }

  /** Raise the idle saver. A no-op if one is up, the picker is open, or the grid is held. */
  async start(): Promise<void> {
    if (this.loading || this.open || this.blocked() || grid.locked) return
    this.loading = true
    try {
      const [saverMod, tui] = await this.load()
      // The import yielded; the machine may have moved on under it.
      if (this.open || this.blocked() || grid.locked) return
      this.acquire(tui)
      const screen = this.make(saverMod, saverPrefs().saver, () => this.stop())
      this.idle = screen
      this.stack!.push(screen)
    } catch {
      // A build that moved under an open tab. The prompt still works; the
      // saver just does not come up.
    } finally {
      this.loading = false
    }
  }

  /** Take the idle saver down. Answers whether there was one. */
  stop(): boolean {
    const screen = this.idle
    if (!screen) return false
    this.idle = null
    // Only if it is still the thing on top: a stale reference must not pop
    // someone else's screen.
    if (this.stack?.top === screen) this.stack.pop()
    this.snd.blip(420, 0.09, 0)
    this.release()
    return true
  }

  /**
   * The `screensaver` program: a list to arrow through. Space previews the
   * row, returning to the list on the waking key; Enter persists the choice
   * and moves the mark, Escape leaves. The idle timer and the off switch are
   * in CONFIG with the other settings.
   */
  async pick(): Promise<void> {
    if (this.open || grid.locked) return
    const [saverMod, tui] = await this.load()
    if (this.open || grid.locked) return
    const { SAVERS } = saverMod
    const { SelectPopup, MUTED, BOLD } = tui
    this.acquire(tui)
    await new Promise<void>(resolve => {
      const finish = () => {
        this.picker = null
        this.stack!.pop()
        this.snd.blip(420, 0.09, 0)
        this.release()
        resolve()
      }
      const current = saverPrefs().saver
      const rowText = (i: number, active: boolean) =>
        (active ? '* ' : '  ') + SAVERS[i]!.name.padEnd(NAME_W) + SAVERS[i]!.summary
      const items = SAVERS.map((s, i) => rowText(i, s.name === current))
      // The popup reads `items` every frame, so rewriting it in place moves the
      // mark as soon as Enter takes a new saver.
      const mark = (chosen: number) => {
        for (let i = 0; i < items.length; i++) items[i] = rowText(i, i === chosen)
      }
      const picker = new SelectPopup({
        title: 'SCREENSAVER',
        items,
        selected: Math.max(0, SAVERS.findIndex(s => s.name === current)),
        note: [{ text: 'ESC', attr: BOLD }],
        shadow: true,
        // The summaries are muted except on the selection bar, whose inversion
        // has to stay whole.
        decorate: (term, row, i, selected) => {
          if (selected) return
          const summary = SAVERS[i]!.summary
          const x = MARK_W + NAME_W
          term.text(row.x + x, row.y, summary.slice(0, Math.max(0, row.w - x)), MUTED)
        },
        onFeedback: kind => {
          if (kind === 'edge') this.snd.beep(220, 0.04)
          else if (kind === 'move') this.snd.tick()
        },
        onKey: (e, index) => {
          if (e.key !== ' ') return false
          // On top of the list, so the waking key lands back on it with the
          // row still under the bar.
          this.stack!.push(this.make(saverMod, SAVERS[index]!.name, () => this.stack!.pop()))
          return true
        },
        onDone: (item, index) => {
          if (item === null) return finish()
          setSaverPrefs({ saver: SAVERS[index]!.name })
          mark(index)
        },
      })
      this.picker = picker
      this.stack!.push(picker)
    })
  }

  /** Handle one key while open. Every key is swallowed, since the machine is covered. */
  key(k: KeyInput): void {
    this.stack?.key(k)
  }

  /** Whether the screen on top plays its own sound for this key, so the host skips the key click. */
  silentKey(k: KeyInput): boolean {
    return !!this.stack?.top?.silentKey?.(k)
  }

  private load(): Promise<[SaverModule, TuiModule]> {
    return Promise.all([import('@cyberspace/crt/saver'), import('@cyberspace/tui')])
  }

  private make(mod: SaverModule, name: string, onDismiss: () => void): Screen {
    return new mod.SaverScreen(
      this.screen.term as never,
      mod.pickSaver(name),
      {
        setDecay: value => this.screen.crt.setParams({ decay: value ?? screenParams().decay }),
      },
      onDismiss,
    )
  }

  private acquire(tui: TuiModule): void {
    this.stack ??= new tui.ScreenStack(this.screen.term as never)
    grid.lock()
    this.cursorWas = RENDER.cursor
    RENDER.cursor = false
  }

  private release(): void {
    grid.unlock()
    RENDER.cursor = this.cursorWas
    // Savers change CRT parameters (decay in particular); restore the configured ones.
    this.screen.crt.setParams(screenParams())
  }
}
