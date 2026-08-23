// Service worker updates. A new build's worker installs in the background and
// then waits: taking over mid-session would leave this page's JavaScript
// running against the next build's chunks. Two things promote it, both ending
// in a reload onto the new build — a visit where nobody has touched the machine
// yet, and reboot.

import { registerSW } from 'virtual:pwa-register'
import { store } from './store'

/** An update landing within this long of load still counts as arriving on a fresh visit. */
const GRACE_MS = 60_000
/** Shortest gap between two unattended promotions, so a worker that fails to activate cannot loop. */
const RETRY_MS = 30_000
/** Update check for a tab left open across a deploy. */
const POLL_MS = 60 * 60 * 1000
/** Shortest gap between the checks a returning tab triggers. */
const RETURN_MS = 15 * 60 * 1000
/** Reload regardless if the promoted worker has not taken control by then. */
const CONTROL_MS = 2000

/** Sends SKIP_WAITING to the waiting worker. Null until armUpdates runs. */
let apply: ((reload?: boolean) => Promise<void>) | null = null
let waiting = false
let touched = false
const loadedAt = Date.now()

/** Register the worker and watch for new builds. Call once, before the machine boots. */
export function armUpdates(): void {
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      waiting = true
      if (touched || Date.now() - loadedAt > GRACE_MS) return
      if (Date.now() - Number(store.get('lastUpdate', '0')) < RETRY_MS) return
      store.set('lastUpdate', String(Date.now()))
      promote()
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return
      // A precached page never asks the network for itself, so nothing else
      // would notice a deploy while the tab stays open.
      setInterval(() => void reg.update(), POLL_MS)
      let checked = Date.now()
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || Date.now() - checked < RETURN_MS) return
        checked = Date.now()
        void reg.update()
      })
    },
  })
  // Input means a session is under way, so the new build waits for reboot.
  const use = () => { touched = true }
  addEventListener('keydown', use, { once: true, capture: true })
  addEventListener('pointerdown', use, { once: true, capture: true })
}

/** True while a new build is installed and waiting for this page to give way. */
export function updateWaiting(): boolean {
  return waiting
}

/**
 * Reload, onto the waiting build if there is one. A reboot is the sanctioned
 * point for that swap, so it happens here rather than at the next fresh visit.
 */
export function rebootOnto(): void {
  if (!promote()) {
    location.reload()
    return
  }
  // The page reloads itself when the new worker takes control; this covers a
  // worker that never does, so a reboot always reboots.
  setTimeout(() => location.reload(), CONTROL_MS)
}

/** Hand over to the waiting worker. False when there is nothing waiting. */
function promote(): boolean {
  if (!waiting || !apply) return false
  waiting = false
  void apply()
  return true
}
