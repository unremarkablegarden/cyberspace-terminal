import { RENDER } from '@cyberspace/crt/config'

/**
 * Number of holders that own the grid: effects, the config box, the screensaver.
 *
 * While any lock is held, main's frame loop skips the pty sync. The xterm buffer
 * stays authoritative, so the next sync repairs the whole screen.
 */
let locks = 0

export const grid = {
  get locked(): boolean { return locks > 0 },
  lock(): void { locks++ },
  unlock(): void { locks-- },
}

/** Run `fn` holding the grid lock with the caret hidden. Both are restored if it throws. */
export async function withGrid(fn: () => Promise<void>): Promise<void> {
  grid.lock()
  const cursor = RENDER.cursor
  RENDER.cursor = false
  try {
    await fn()
  } finally {
    grid.unlock()
    RENDER.cursor = cursor
  }
}
