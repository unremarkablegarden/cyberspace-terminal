// doom(1). The game runs on the faceplate: it writes the CRT framebuffer directly and needs key releases, neither of which the pty carries.
// It holds the grid lock like the screensaver, and keys reach it through Keyboard's overlay route with key-ups forwarded.
// The engine is a dynamic import (packages/crt/src/doom.ts); nothing of it is fetched until `doom` runs.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { RENDER } from '@cyberspace/crt/config'
import type { Proc } from '@cyberspace/kernel'
import type { KeyInput } from '@cyberspace/tui'
import type { DoomGame } from '@cyberspace/crt/doom'
import { grid } from './grid'
import type { Overlay } from './input'

/** Upstream v0.1.0 with the sound module from tools/doom; see app/public/doom/ATTRIBUTION.txt. */
const DOOM_WASM = '/doom/doom-v0.1.0-sfx.wasm'

export class Doom implements Overlay {
  private game: DoomGame | null = null
  private quit: (() => void) | null = null

  constructor(
    private screen: CrtScreen,
    private snd: Sound,
    /** Resolves once queued output has been released to the screen. */
    private drained: () => Promise<void>,
  ) {}

  get open(): boolean {
    return this.game !== null
  }

  key(k: KeyInput): void {
    // ^C quits from anywhere, as does Quit Game in DOOM's menu (see DoomGame.onExit); Escape is DOOM's menu key, and DOOM binds Ctrl to fire and C to nothing.
    if (k.ctrlKey && (k.key === 'c' || k.key === 'C')) {
      this.quit?.()
      return
    }
    this.game?.keyDown(k.key)
  }

  keyUp(k: KeyInput): void {
    this.game?.keyUp(k.key)
  }

  /** Keys are game controls, so they make no click. F-keys still click: DOOM takes none of them. */
  silentKey(k: KeyInput): boolean {
    return !/^F\d/.test(k.key)
  }

  run = async (p: Proc): Promise<number> => {
    const { LICENSE, loadDoom } = await import('@cyberspace/crt/doom')
    const arg = p.argv[1]
    if (arg === '--license' || arg === '-l') {
      p.out(LICENSE.join('\n') + '\n')
      return 0
    }
    if (!p.tty) { p.err('doom: not a tty\n'); return 1 }
    if (this.open || grid.locked) { p.err('doom: screen busy\n'); return 1 }

    // The two lines the licence asks to travel with the binary.
    p.out('LOADING DOOM...\n(C) 1993 Id Software; engine GPL-2.0, no warranty\ndoom --license\n\n')
    await this.drained()
    this.snd.seek(6)

    let game: DoomGame
    try {
      // The beeps bus, so the F1 level for machine sounds also sets the game's.
      game = await loadDoom(DOOM_WASM, () => this.snd.output('beeps'))
    } catch (e) {
      this.snd.beep(220, 0.12)
      p.err(`doom: ${e instanceof Error ? e.message : String(e)}\n`)
      return 1
    }
    if (p.signal.aborted || grid.locked) return 130

    const term = this.screen.term
    const cursor = RENDER.cursor
    grid.lock()
    RENDER.cursor = false
    term.raw = true
    this.game = game
    game.start(term)
    await new Promise<void>(resolve => {
      const done = () => {
        p.signal.removeEventListener('abort', done)
        this.quit = null
        resolve()
      }
      this.quit = done
      game.onExit = done
      p.signal.addEventListener('abort', done, { once: true })
    })
    game.stop()
    this.game = null
    term.raw = false
    term.dirty = true
    RENDER.cursor = cursor
    grid.unlock()
    this.snd.blip(420, 0.09, 0)
    return p.signal.aborted ? 130 : 0
  }
}
