// Runs a program written for the original /terminal: a default export of
// { name, description, run(ctx, args) } against a virtual cell grid.
//
// Two modes, selected by the screen stack. In line mode ctx.write and ctx.type
// map to SGR text on the pty. The first pushScreen enters the alternate screen,
// after which a ticker diffs the cell grid to ANSI every frame. popScreen to an
// empty stack returns to line mode.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import { Surface, parseKeys } from '@cyberspace/tui'
import {
  CellGrid, NORMAL, BRIGHT, BOLD, DIM, MUTED, FAINT, ALT, ITALIC, BG,
} from '@cyberspace/crt/term'
import {
  frame, label, hline, vline, clear, shadow, ground, inside, cells,
} from '@cyberspace/tui'

// ctx.tui exposes the box helpers only. The module they come from also holds
// widgets, which are not offered to compat programs.
const box = { frame, label, hline, vline, clear, shadow, ground, inside, cells }
import { DotCanvas, drawEdges, teapot } from './vector.js'
import { roll } from './roll.js'

class Aborted extends Error {}

interface UserProgram {
  name?: string
  description?: string
  run(ctx: unknown, args: string[]): void | Promise<void>
}

/** Import a string of source as an ES module. */
async function importSource(source: string): Promise<UserProgram | null> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const mod = await import(/* @vite-ignore */ url)
    const program = mod?.default
    if (!program || typeof program !== 'object') return null
    if (typeof (program as UserProgram).run !== 'function') return null
    return program as UserProgram
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The position in the author's own source that a stack trace points at, or null. */
function whereInSource(stack: string | undefined): string | null {
  if (!stack) return null
  const hit = stack.match(/blob:[^\s)]*?:(\d+):(\d+)/)
  return hit ? `${hit[1]}:${hit[2]}` : null
}

const ATTR = { NORMAL, BRIGHT, BOLD, DIM, MUTED, FAINT, ALT, ITALIC, BG } as const

function sgrOf(attr: number): string {
  const parts: string[] = []
  if (attr & (BRIGHT | BOLD)) parts.push('1')
  if (attr & (DIM | MUTED | FAINT)) parts.push('2')
  return parts.length ? `\x1b[${parts.join(';')}m` : ''
}

export interface CompatDeps {
  username?: () => string
  /**
   * Authenticated access to the Cyberspace API, scoped to /v1/ paths. The
   * caller's identity and rate limits are enforced server-side, so this is
   * safe to hand to arbitrary published programs.
   */
  api?: {
    get(path: string): Promise<unknown>
    post(path: string, body?: unknown): Promise<unknown>
    del(path: string): Promise<unknown>
  }
  snd?: {
    blip(hz?: number, dur?: number, jitter?: number): void
    beep(freq?: number, dur?: number): void
    tick(): void
    seek(count?: number): void
    hiss(dur?: number, gain?: number): void
  }
  feed?: {
    page(limit?: number, after?: string): Promise<Record<string, unknown>[]>
    profile?(username: string): Promise<Record<string, unknown> | null>
  }
  version?: string
}

interface CompatScreen {
  onKey?(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): unknown
  draw?(): void
}

const SILENT_SND = {
  blip() {}, beep() {}, tick() {}, seek() {}, hiss() {},
}

export function runGridProgram(deps: CompatDeps): (p: Proc, source: string) => Promise<number> {
  return async (p, source) => {
    const cols = p.tty?.cols ?? (Number(p.env.COLUMNS) || 80)
    const rows = p.tty?.rows ?? (Number(p.env.LINES) || 25)

    // Checked before running. The import below evaluates a real ES module in
    // this page, so this check is the boundary; see guard.ts. Loaded on demand
    // because the parser is ~130 KB and only a program run needs it.
    try {
      const { inspect, refusalLines } = await import('./guard.js')
      const hits = inspect(source)
      if (hits.length) {
        for (const line of refusalLines(p.argv[0] ?? '?', hits)) p.err(line.text + '\n')
        return 1
      }
    } catch (e) {
      // A SyntaxError is treated as the program's. Source the guard cannot parse
      // but the engine can would be a bypass, so it is refused.
      p.err(`${p.argv[0]}: ${(e as Error)?.message ?? e}\n`)
      return 1
    }

    let program: UserProgram | null
    try {
      program = await importSource(source)
    } catch (e) {
      const at = whereInSource((e as Error)?.stack)
      p.err(`${p.argv[0]}: ${(e as Error)?.message ?? e}${at ? ` at ${at}` : ''}\n`)
      return 1
    }
    if (!program) {
      p.err(`${p.argv[0]}: not a program (missing export default { run })\n`)
      return 1
    }

    const grid = new CellGrid({ cellW: 8, cellH: 16 }, cols, rows)
    const surface = new Surface(cols, rows)
    const screens: CompatScreen[] = []
    const ac = new AbortController()
    let cps = 240 // baud 2400
    let inScreen = false

    const render = (): void => {
      if (!inScreen || !grid.dirty) return
      grid.dirty = false
      for (let i = 0; i < cols * rows; i++) {
        const code = grid.chars[i]
        surface.chars[i] = code === 0 ? ' ' : String.fromCodePoint(code || 32)
        // The same attribute byte on both sides: the Surface mirrors the cell grid.
        surface.attrs[i] = grid.attrs[i]
        surface.inv[i] = grid.inverse[i]
      }
      surface.cx = grid.cx
      surface.cy = grid.cy
      surface.showCursor = false
      p.tty?.paint(surface.render()) ?? p.out(surface.render())
    }

    const ticker = setInterval(render, 33)

    const throwIfAborted = (): void => {
      if (ac.signal.aborted || p.signal.aborted) throw new Aborted()
    }

    const sleep = (ms: number): Promise<void> =>
      new Promise((res, rej) => {
        throwIfAborted()
        const t = setTimeout(res, ms)
        const onAbort = () => { clearTimeout(t); rej(new Aborted()) }
        ac.signal.addEventListener('abort', onAbort, { once: true })
      })

    const lineWrite = (s: string, attr = NORMAL): void => {
      const code = sgrOf(attr)
      p.out(code + s + (code ? '\x1b[0m' : ''))
    }

    const write = (s: string, attr = NORMAL): void => {
      if (inScreen) grid.write(s, attr)
      else lineWrite(s, attr)
    }

    const type = async (s: string, attr = NORMAL): Promise<void> => {
      const delay = Math.max(2, 1000 / cps)
      for (const ch of s) {
        throwIfAborted()
        write(ch, attr)
        deps.snd?.blip(1400)
        await sleep(delay)
      }
    }

    const enterScreen = (): void => {
      if (inScreen) return
      inScreen = true
      p.out('\x1b[?1049h\x1b[?25l')
      surface.invalidate()
      grid.dirty = true
    }

    const leaveScreen = (): void => {
      if (!inScreen) return
      inScreen = false
      p.out('\x1b[?1049l\x1b[?25h')
    }

    const snd = deps.snd ?? SILENT_SND

    // API capability: /v1/ paths only, and inert when the host supplies no client.
    const apiPath = (path: unknown): string => {
      if (typeof path !== 'string' || !path.startsWith('/v1/')) {
        throw new Error('api: path must start with /v1/')
      }
      return path
    }
    const noApi = (): never => { throw new Error('NO CARRIER') }
    const apiCap = {
      get: (path: string) => deps.api ? deps.api.get(apiPath(path)) : noApi(),
      post: (path: string, body?: unknown) => deps.api ? deps.api.post(apiPath(path), body) : noApi(),
      del: (path: string) => deps.api ? deps.api.del(apiPath(path)) : noApi(),
    }

    const ctx = {
      tui: { ...box, DotCanvas, drawEdges, teapot },
      attr: ATTR,
      gfx: {
        canvas(width: number, height: number): OffscreenCanvas {
          return new OffscreenCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)))
        },
      },

      write,
      writeln: (s = '', attr = NORMAL) => write(s + '\n', attr),
      type,
      typeln: async (s = '', attr = NORMAL) => { await type(s + '\n', attr) },
      clear: () => {
        if (inScreen) grid.clear()
        else p.out('\x1b[2J\x1b[H')
      },
      sleep,
      setBaud: (rate: number) => { cps = Math.max(30, rate / 10) },
      setBlipHz: () => {},

      get term() { return grid },
      snd,
      pushScreen: (s: CompatScreen) => {
        screens.push(s)
        enterScreen()
      },
      popScreen: () => {
        screens.pop()
        if (!screens.length) leaveScreen()
      },

      api: apiCap,

      get username() { return deps.username?.() ?? p.env.USER ?? 'guest' },
      version: deps.version ?? '0.1',
      root: false,
      fortune: () => 'No fortunes.',

      get cwd() { return p.cwd },
      setCwd: () => {},

      chat: {
        defaultRoom: '#lobby',
        maxLength: 2048,
        artMaxLength: 4096,
        hideImages: false,
        rooms: async () => [],
        open: () => () => {},
        presence: () => () => {},
        enter: () => {},
        roll,
        searchUsers: async () => [],
        send: async (room: string, text: string) => {
          write(`[dry-run] chat.send(${room}) ${text}\n`, DIM)
        },
      },
      feed: {
        page: async (limit?: number, after?: string) => deps.feed?.page(limit, after) ?? [],
        byUser: async () => [],
        replies: async () => [],
        profile: async (username: string) => deps.feed?.profile?.(username) ?? null,
        watch: () => () => {},
        searchUsers: async () => [],
        formatTime: (at: number) => new Date(at).toLocaleString(),
        reply: async () => {
          write('[dry-run] feed.reply()\n', DIM)
          return ''
        },
      },

      get signal() { return ac.signal },
      setResume: () => {},
      setState: () => {},
      takeState: () => null,

      config: async () => {},
      cyclePhosphor: () => {},
      setDecay: () => {},
      toggleMute: () => {},
      toggleFullscreen: () => {},
      reboot: () => {},
      shutdown: () => {},
    }

    // ^C aborts from anywhere; every other key goes to the top screen.
    p.tty?.setRaw()
    let pumping = true
    const pump = (async () => {
      while (pumping) {
        const chunk = await p.stdin.read()
        if (chunk === null) return
        for (const k of parseKeys(dec.decode(chunk))) {
          if (k.ctrlKey && k.key === 'c') {
            ac.abort()
            return
          }
          const top = screens[screens.length - 1]
          top?.onKey?.({ key: k.key.length === 1 ? k.key : k.key, ctrlKey: k.ctrlKey, metaKey: false, altKey: false })
          grid.dirty = grid.dirty || true
        }
      }
    })()

    try {
      const args = p.argv.slice(1)
      await program.run(ctx, args)
      render()
      return 0
    } catch (e) {
      if (e instanceof Aborted) return 130
      const at = whereInSource((e as Error)?.stack)
      leaveScreen()
      p.err(`${p.argv[0]}: ${(e as Error)?.message ?? e}${at ? ` at ${at}` : ''}\n`)
      return 1
    } finally {
      clearInterval(ticker)
      pumping = false
      p.stdin.interrupt?.()
      leaveScreen()
      p.tty?.setCooked()
      if (!inScreen && !screens.length) p.out('\x1b[0m')
    }
  }
}

/** Kernel file handler for old-style JS programs, recognised by their default export. */
export function compatFileHandler(deps: CompatDeps): (path: string, data: Uint8Array) => Program | null {
  const run = runGridProgram(deps)
  return (_path, data) => {
    if (data.length < 2 || data[0] === 0) return null
    const head = dec.decode(data.subarray(0, Math.min(data.length, 4096)))
    if (!/export\s+default/.test(head)) return null
    const source = dec.decode(data)
    return p => run(p, source)
  }
}
