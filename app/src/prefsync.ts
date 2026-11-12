// Copies the F1 settings to the member's account and back, through the
// `terminal` field of /v1/settings (../api TERMINAL.md).
//
// Last writer wins on `at`, a write time in ms. A change made while logged in
// with sync on stamps `at` and is pushed PUSH_DELAY_MS later. On login and on a
// boot resume the account's record is applied when newer than this device's
// stamp, and this device's is pushed when newer. A change made while logged out
// is not stamped, so the account's settings replace it at the next login.

import type { ApiClient } from '@cyberspace/apps'
import { store } from './store'

/**
 * The stored keys that follow the account. The grid size is left out: it
 * suits the device's screen. SYNC_KEY is left out so each device keeps its own.
 */
const SYNCED = ['font', 'screen', 'crt.user', 'phosphor', 'phosphor.custom', 'sound', 'notices', 'screensaver']

/** Storage key of the settings box's sync row, `on` or `off`. */
export const SYNC_KEY = 'settings.sync'

/** Debounce for pushes, in ms. A knob held down writes on every step. */
const PUSH_DELAY_MS = 2000

/** The account's copy, as the API stores it. */
interface Remote { at: number; values: Record<string, string> }

export const syncEnabled = (): boolean => store.get(SYNC_KEY, 'on') !== 'off'

/** This device's stamp for `uid`, or 0. Stamps are per member so a second login on the device starts from 0. */
function stamp(uid: string): number {
  try {
    const s = JSON.parse(store.get('settings.at', '')) as { uid?: string; at?: number }
    return s.uid === uid && typeof s.at === 'number' ? s.at : 0
  } catch {
    return 0
  }
}

function setStamp(uid: string, at: number): void {
  store.set('settings.at', JSON.stringify({ uid, at }))
}

export class SettingsSync {
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Set while a pulled record is written, so those writes are not pushed back. */
  private pulling = false

  /** `apply` puts the stored settings into effect after a pull has replaced them. */
  constructor(private api: ApiClient, private apply: () => Promise<void>) {
    store.watch(key => this.changed(key))
    const previous = api.onAuthChange
    api.onAuthChange = user => {
      previous?.(user)
      if (user) void this.reconcile().catch(() => {})
    }
    // A resume can finish before this runs.
    if (api.authed) void this.reconcile().catch(() => {})
  }

  private changed(key: string): void {
    const uid = this.api.userId
    if (this.pulling || !uid || !this.api.authed || !syncEnabled()) return
    // Turning sync on makes this device's settings the account's.
    if (key !== SYNC_KEY && !SYNCED.includes(key)) return
    setStamp(uid, Date.now())
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.push(uid).catch(() => {}), PUSH_DELAY_MS)
  }

  private async reconcile(): Promise<void> {
    const uid = this.api.userId
    if (!uid || !syncEnabled()) return
    const remote = (await this.api.get<{ terminal?: Remote }>('/v1/settings')).terminal
    if (this.api.userId !== uid) return
    const local = stamp(uid)
    if (!remote) {
      if (!local) setStamp(uid, Date.now())
      await this.push(uid)
    } else if (remote.at > local) {
      this.pulling = true
      try {
        // A key missing from the record was at its default on the device that wrote it.
        for (const k of SYNCED) {
          const v = remote.values[k]
          if (typeof v === 'string') store.set(k, v)
          else store.remove(k)
        }
      } finally {
        this.pulling = false
      }
      setStamp(uid, remote.at)
      await this.apply()
    } else if (local > remote.at) {
      await this.push(uid)
    }
  }

  /**
   * A failed push is not retried here. The stamp stays newer than the
   * account's, so the next login or boot resume pushes again.
   */
  private async push(uid: string): Promise<void> {
    if (this.api.userId !== uid || !syncEnabled()) return
    const values: Record<string, string> = {}
    for (const k of SYNCED) {
      const v = store.get(k, '')
      if (v) values[k] = v
    }
    await this.api.patch('/v1/settings', { terminal: { at: stamp(uid), values } })
  }
}
