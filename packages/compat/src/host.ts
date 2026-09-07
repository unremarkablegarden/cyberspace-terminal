// Runs a program written for the original /terminal: a default export of
// { name, description, run(ctx, args) } against a virtual cell grid.
//
// Two modes, selected by the screen stack. In line mode ctx.write and ctx.type
// map to SGR text on the pty. The first pushScreen enters the alternate screen,
// after which a ticker diffs the cell grid to ANSI every frame. popScreen to an
// empty stack returns to line mode.

import { dec, type Proc } from '@cyberspace/kernel'
import {
  Surface, parseKeys, InputLine, TextBuffer,
  type KeyInput, type InputOptions, type BufferOptions,
} from '@cyberspace/tui'
import {
  CellGrid, NORMAL, BRIGHT, BOLD, DIM, MUTED, FAINT, ALT, ITALIC, BG,
} from '@cyberspace/crt/term'
import {
  frame, label, hline, vline, clear, shadow, ground, inside, cells,
} from '@cyberspace/tui'

// The box helpers on ctx.tui; the input widgets are added per run below, so
// their clipboard can be bound to this program's ctx.copy.
const box = { frame, label, hline, vline, clear, shadow, ground, inside, cells }
import { DotCanvas, drawEdges, teapot } from './vector.js'
import { roll } from './roll.js'

class Aborted extends Error {}

export interface UserProgram {
  name?: string
  description?: string
  run(ctx: unknown, args: string[]): void | Promise<void>
}

/** Import a string of source as an ES module and hand back its default export. */
export async function importDefault(source: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const mod = await import(/* @vite-ignore */ url)
    return mod?.default
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A default export shaped like an original /terminal program, or null. */
export function asGridProgram(value: unknown): UserProgram | null {
  if (!value || typeof value !== 'object') return null
  return typeof (value as UserProgram).run === 'function' ? value as UserProgram : null
}

/** The position in the author's own source that a stack trace points at, or null. */
export function whereInSource(stack: string | undefined): string | null {
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
  /**
   * Fetch a remote image, returning its raw bytes. A program cannot reach the
   * network itself, so this is the only path in, and the host checks the URL
   * host against a whitelist before fetching. Absent when unconfigured.
   */
  image?(url: string): Promise<Uint8Array>
  /** Put text on the system clipboard, for the input widgets' copy and cut. */
  copy?(text: string): void
  version?: string
}

interface CompatScreen {
  onKey?(e: KeyInput): unknown
  draw?(): void
}

const SILENT_SND = {
  blip() {}, beep() {}, tick() {}, seek() {}, hiss() {},
}

/**
 * Run an imported grid program against a virtual cell grid.
 *
 * Takes the module's default export rather than its source: the guard and the
 * import belong to the file handler below, which has to look at what came back
 * before it knows this is the runner to use.
 */
export function runGridProgram(deps: CompatDeps): (p: Proc, program: UserProgram) => Promise<number> {
  return async (p, program) => {
    const cols = p.tty?.cols ?? (Number(p.env.COLUMNS) || 80)
    const rows = p.tty?.rows ?? (Number(p.env.LINES) || 25)

    const grid = new CellGrid({ cellW: 8, cellH: 16 }, cols, rows)
    const surface = new Surface(cols, rows)
    const screens: CompatScreen[] = []
    const ac = new AbortController()
    // ctx.type's rate and pitch, reset every run because they are locals.
    let cps = 240 // baud 2400
    let blipHz = 1400
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

    /**
     * The only paced output a compat program has. Everything else it writes is
     * instant, so this clock is the whole rate: characters owed since the start
     * are released every 8ms, and a batch the event loop delayed is paid back
     * on the next one rather than dropped.
     */
    const type = async (s: string, attr = NORMAL): Promise<void> => {
      const chars = [...s]
      const t0 = performance.now()
      let sent = 0
      while (sent < chars.length) {
        throwIfAborted()
        const due = Math.min(chars.length, Math.floor((performance.now() - t0) / 1000 * cps) + 1)
        while (sent < due) {
          const ch = chars[sent++]!
          write(ch, attr)
          if (ch !== ' ') deps.snd?.blip(blipHz)
        }
        if (sent < chars.length) await sleep(8)
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

    // Input widgets whose clipboard is bound to this program's ctx.copy, so an
    // app that uses them gets selection, copy, cut and paste with no wiring.
    const clip = (text: string) => deps.copy?.(text)
    const CtxInputLine = class extends InputLine {
      constructor(o: InputOptions = {}) { super({ clipboard: clip, ...o }) }
    }
    const CtxTextBuffer = class extends TextBuffer {
      constructor(o: BufferOptions = {}) { super({ clipboard: clip, ...o }) }
    }

    const ctx = {
      tui: { ...box, DotCanvas, drawEdges, teapot, InputLine: CtxInputLine, TextBuffer: CtxTextBuffer },
      copy: clip,
      attr: ATTR,
      gfx: {
        canvas(width: number, height: number): OffscreenCanvas {
          return new OffscreenCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)))
        },
      },
      // The host fetches the bytes after a whitelist check; decode stays here so
      // the program gets a bitmap to draw onto a gfx canvas.
      image: async (url: string): Promise<ImageBitmap> => {
        if (!deps.image) throw new Error('NO CARRIER')
        const bytes = await deps.image(url)
        return createImageBitmap(new Blob([bytes as BlobPart]))
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
      // 8N1: ten bits to a byte, so a baud is a tenth of a character.
      setBaud: (rate: number) => { cps = rate / 10 },
      setBlipHz: (hz: number) => { blipHz = hz },

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
    // A program of this kind draws; it does not transmit text. Its own ctx.type
    // is then the only thing that paces, as it is in the terminal these were
    // written for.
    p.tty?.setPaced(false)
    let pumping = true
    const pump = (async () => {
      while (pumping) {
        const chunk = await p.stdin.read()
        if (chunk === null) return
        for (const k of parseKeys(dec.decode(chunk))) {
          // Ctrl+C aborts; Ctrl+Shift+C is copy and belongs to the widget below.
          if (k.ctrlKey && !k.shiftKey && k.key === 'c') {
            ac.abort()
            return
          }
          const top = screens[screens.length - 1]
          // The whole KeyInput, so a widget sees Shift for selection and the
          // copy chord; the pump above still claims Ctrl+C for abort.
          top?.onKey?.(k)
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
      // The machine reporting a fault is machine output, so it paces.
      p.tty?.setPaced(true)
      p.err(`${p.argv[0]}: ${(e as Error)?.message ?? e}${at ? ` at ${at}` : ''}\n`)
      return 1
    } finally {
      clearInterval(ticker)
      pumping = false
      p.stdin.interrupt?.()
      leaveScreen()
      // Written before the terminal goes back to cooked, so the reset is part
      // of the program's own unpaced output and does not bleep on its way out.
      if (!inScreen && !screens.length) p.out('\x1b[0m')
      p.tty?.setCooked()
    }
  }
}
