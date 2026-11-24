import type { Color } from './rules'

/** Sudden death, no increment. 0 is an untimed game. The world Worker's chess room accepts only these values. */
export const TIME_CONTROLS: { label: string; ms: number }[] = [
  { label: 'No clock', ms: 0 },
  { label: '1 min', ms: 60_000 },
  { label: '3 min', ms: 180_000 },
  { label: '5 min', ms: 300_000 },
  { label: '10 min', ms: 600_000 },
  { label: '20 min', ms: 1_200_000 },
]

export function timeLabel(ms: number): string {
  return TIME_CONTROLS.find(t => t.ms === ms)?.label ?? 'No clock'
}

/**
 * Both sides' remaining time. `white` and `black` are as of `at` (performance.now() ms);
 * only the `running` side counts down from there.
 */
export interface Clock {
  white: number
  black: number
  running: Color | null
  at: number
}

export function remaining(clock: Clock, color: Color, now = performance.now()): number {
  const base = clock[color]
  return Math.max(0, clock.running === color ? base - (now - clock.at) : base)
}

/** Stops the running side and starts `next`, or stops both when `next` is null. */
export function switchClock(clock: Clock, next: Color | null, now = performance.now()): Clock {
  const out = { ...clock, at: now, running: next }
  if (clock.running) out[clock.running] = remaining(clock, clock.running, now)
  return out
}

/** m:ss, and s.t under 10 s. Rounds up so 0:00 shows only at zero. */
export function formatClock(ms: number): string {
  if (ms < 10_000) return `${(Math.ceil(ms / 100) / 10).toFixed(1)}`
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
