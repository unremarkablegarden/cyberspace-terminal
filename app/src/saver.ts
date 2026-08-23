// The screensaver. No idle timer is wired up yet, so nothing calls start();
// the settings and the screen itself are in place.

import type { CrtScreen } from '@cyberspace/crt'
import type { ScreenStack } from '@cyberspace/tui'
import { grid } from './grid'
import { saverPrefs, screenParams } from './prefs'

export class Screensaver {
  private up: { dispose(): void } | null = null
  private stack: ScreenStack | null = null

  constructor(private screen: CrtScreen, private blocked: () => boolean) {}

  async start(): Promise<void> {
    if (this.up || this.blocked() || grid.locked) return
    const { SaverScreen, pickSaver } = await import('@cyberspace/crt/saver')
    const { ScreenStack } = await import('@cyberspace/tui')
    if (this.up || this.blocked()) return

    this.stack ??= new ScreenStack(this.screen.term as never)
    grid.lock()
    const screen = new SaverScreen(
      this.screen.term as never,
      pickSaver(saverPrefs().saver),
      {
        setDecay: value => this.screen.crt.setParams({ decay: value ?? 0.6 }),
        // No fortune source on this machine. Savers that show one handle null.
        fortune: async () => null,
      },
      () => this.stop(),
    )
    this.up = screen
    this.stack.push(screen as never)
  }

  stop(): void {
    if (!this.up) return
    this.up = null
    this.stack?.pop()
    grid.unlock()
    // Savers change CRT parameters (decay in particular); restore the configured ones.
    this.screen.crt.setParams(screenParams())
  }
}
