// poll_oneoff for the WASI worker. The shim's own version takes a single
// clock subscription and spins on it; this one takes any mix of clock and fd
// subscriptions and sleeps on the stdin ring with Atomics.wait, which is what
// a program polling the keyboard with a timeout (an editor's Escape timer)
// needs. Layouts are WASI Preview 1: subscription 48 bytes, event 32 bytes.

import type { RingReader } from './sabring.js'
import { STATE_KILLED, STATE_OPEN } from './sabring.js'

const EVENTTYPE_CLOCK = 0
const EVENTTYPE_FD_READ = 1
const EVENTTYPE_FD_WRITE = 2
const CLOCK_ABSTIME = 1
const CLOCKID_REALTIME = 0
const HANGUP = 1
const ERRNO_SUCCESS = 0
const ERRNO_INVAL = 28
const ERRNO_INTR = 27
const ERRNO_BADF = 8

const SUB_SIZE = 48
const EVENT_SIZE = 32

export interface PollHost {
  /** The ring behind an fd, when that fd is the interactive stdin. */
  ring(fd: number): RingReader | null
  /** Whether the fd is open at all. */
  open(fd: number): boolean
  /** Block the thread for this many milliseconds. */
  sleep(ms: number): void
}

interface Sub {
  userdata: bigint
  type: number
  fd: number
  /** Clock subscriptions only: deadline in ms on performance.now()'s scale. */
  deadline: number
}

interface Ev {
  userdata: bigint
  error: number
  type: number
  nbytes: number
  flags: number
}

function nowMs(clockid: number): number {
  return clockid === CLOCKID_REALTIME ? Date.now() : performance.now()
}

function readSubs(view: DataView, ptr: number, n: number): Sub[] {
  const subs: Sub[] = []
  for (let i = 0; i < n; i++) {
    const at = ptr + i * SUB_SIZE
    const type = view.getUint8(at + 8)
    const sub: Sub = { userdata: view.getBigUint64(at, true), type, fd: 0, deadline: 0 }
    if (type === EVENTTYPE_CLOCK) {
      const clockid = view.getUint32(at + 16, true)
      const timeout = Number(view.getBigUint64(at + 24, true)) / 1e6
      const flags = view.getUint16(at + 40, true)
      // Absolute deadlines are on the subscription's clock; convert to a
      // relative wait, then onto the monotonic scale everything else uses.
      const rel = flags & CLOCK_ABSTIME ? timeout - nowMs(clockid) : timeout
      sub.deadline = performance.now() + Math.max(0, rel)
    } else {
      sub.fd = view.getUint32(at + 16, true)
    }
    subs.push(sub)
  }
  return subs
}

function writeEvents(view: DataView, ptr: number, evs: Ev[]): void {
  for (let i = 0; i < evs.length; i++) {
    const at = ptr + i * EVENT_SIZE
    const e = evs[i]
    view.setBigUint64(at, e.userdata, true)
    view.setUint16(at + 8, e.error, true)
    view.setUint8(at + 10, e.type)
    view.setBigUint64(at + 16, BigInt(e.nbytes), true)
    view.setUint16(at + 24, e.flags, true)
  }
}

/** Events that are ready without waiting. */
function ready(subs: Sub[], host: PollHost, now: number): Ev[] {
  const evs: Ev[] = []
  for (const s of subs) {
    const ev: Ev = { userdata: s.userdata, error: ERRNO_SUCCESS, type: s.type, nbytes: 0, flags: 0 }
    if (s.type === EVENTTYPE_CLOCK) {
      if (now >= s.deadline) evs.push(ev)
      continue
    }
    if (!host.open(s.fd)) {
      ev.error = ERRNO_BADF
      evs.push(ev)
      continue
    }
    const ring = host.ring(s.fd)
    if (s.type === EVENTTYPE_FD_WRITE || ring === null) {
      // Files and pipes pre-read into memory never block.
      evs.push(ev)
      continue
    }
    const n = ring.available()
    const state = ring.state()
    if (n > 0) {
      ev.nbytes = n
      evs.push(ev)
    } else if (state === STATE_KILLED) {
      ev.error = ERRNO_INTR
      evs.push(ev)
    } else if (state !== STATE_OPEN) {
      ev.flags = HANGUP
      evs.push(ev)
    }
  }
  return evs
}

/**
 * Returns a WASI errno; on success the event count is stored at neventsPtr.
 */
export function pollOneoff(
  view: DataView,
  inPtr: number,
  outPtr: number,
  n: number,
  neventsPtr: number,
  host: PollHost,
): number {
  if (n === 0) return ERRNO_INVAL
  const subs = readSubs(view, inPtr, n)
  for (const s of subs) {
    if (s.type !== EVENTTYPE_CLOCK && s.type !== EVENTTYPE_FD_READ && s.type !== EVENTTYPE_FD_WRITE) return ERRNO_INVAL
  }

  let evs = ready(subs, host, performance.now())
  if (evs.length === 0) {
    let deadline = Infinity
    let ring: RingReader | null = null
    for (const s of subs) {
      if (s.type === EVENTTYPE_CLOCK) deadline = Math.min(deadline, s.deadline)
      else if (s.type === EVENTTYPE_FD_READ) ring = host.ring(s.fd)
    }
    if (ring === null && deadline === Infinity) return ERRNO_INVAL
    const wait = deadline - performance.now()
    let timedOut = true
    if (ring) timedOut = !ring.waitReadable(wait)
    else host.sleep(wait)
    // Clock precision: a wait that ran out is treated as reaching the deadline
    // even if the clock reads a fraction under it, so the clock event fires
    // and the caller does not spin on a zero-length poll.
    evs = ready(subs, host, timedOut ? Math.max(performance.now(), deadline) : performance.now())
  }

  writeEvents(view, outPtr, evs)
  view.setUint32(neventsPtr, evs.length, true)
  return ERRNO_SUCCESS
}
