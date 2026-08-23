// Cold-start sequence, after the tube strikes (effects.ts):
//
//   banner()    CYBERSPACE in a box
//   post()      1984 firmware: memory count, device inventory, kernel load
//   probe()     the real machine, read off navigator/screen — this bit is true
//   services()  mounts and [ OK ] lines
//
// Draws directly onto the Term planes, paced by wall clock. The host must stop
// feeding the grid while this runs and repaint afterwards. Ctrl-C aborts via the
// signal, and the caller is responsible for the end state.

import { BRIGHT, BOLD, NORMAL } from './term.js'
import { Aborted } from './effects.js'
import type { Sound } from './audio.js'

interface BootTerm {
  cols: number
  rows: number
  cx: number
  cy: number
  dirty: boolean
  clear(): void
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
  text(x: number, y: number, str: string, attr?: number, inv?: number): number
  write(str: string, attr?: number): void
  newline(): void
}

// Firmware output is pitched lower than the shell's. The memory count sounds
// its own blip, since it overwrites in place rather than going through type().
const FIRMWARE_BLIP_HZ = 760

class BootCtx {
  private cps = 240
  private blipHz = 1400

  constructor(
    readonly term: BootTerm,
    readonly snd: Sound,
    private signal: AbortSignal,
  ) {}

  clear(): void {
    this.term.clear()
  }

  /** A baud is a bit; 8N1 puts ten on a character. */
  setBaud(baud: number): void { this.cps = baud / 10 }
  setBlipHz(hz: number): void { this.blipHz = hz }

  sleep(ms: number): Promise<void> {
    if (this.signal.aborted) return Promise.reject(new Aborted())
    return new Promise<void>((res, rej) => {
      const timer = setTimeout(() => { cleanup(); res() }, ms)
      const onAbort = () => { clearTimeout(timer); cleanup(); rej(new Aborted()) }
      const cleanup = () => this.signal.removeEventListener('abort', onAbort)
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // Wall-clock pacing: emit whatever elapsed time allows, then yield. A
  // throttled tab batches characters rather than stretching the sequence.
  async type(text: string, attr = NORMAL): Promise<void> {
    const chars = [...text]
    if (!chars.length) return
    const msPerChar = 1000 / this.cps
    const t0 = performance.now()
    let i = 0
    while (i < chars.length) {
      if (this.signal.aborted) throw new Aborted()
      const budget = Math.min(chars.length,
        Math.max(i + 1, Math.ceil((performance.now() - t0) / msPerChar)))
      while (i < budget) {
        const ch = chars[i++]!
        this.term.write(ch, attr)
        if (ch !== ' ') this.snd.blip(this.blipHz)
      }
      if (i < chars.length) await this.sleep(16)
    }
  }

  async typeln(text = '', attr = NORMAL): Promise<void> {
    await this.type(text, attr)
    this.term.newline()
    this.term.dirty = true
  }
}

// --- the banner --------------------------------------------------------------

/** A 5x5 face, with one entry per letter needed to spell CYBERSPACE. */
const GLYPHS: Record<string, string[]> = {
  C: ['█████',
      '█    ',
      '█    ',
      '█    ',
      '█████'],
  Y: ['█   █',
      ' █ █ ',
      '  █  ',
      '  █  ',
      '  █  '],
  B: ['████ ',
      '█   █',
      '████ ',
      '█   █',
      '████ '],
  E: ['█████',
      '█    ',
      '████ ',
      '█    ',
      '█████'],
  R: ['████ ',
      '█   █',
      '████ ',
      '█  █ ',
      '█   █'],
  S: ['█████',
      '█    ',
      '█████',
      '    █',
      '█████'],
  P: ['████ ',
      '█   █',
      '████ ',
      '█    ',
      '█    '],
  A: [' ███ ',
      '█   █',
      '█████',
      '█   █',
      '█   █'],
}

const GLYPH_H = 5

function bannerRows(word: string): string[] {
  const rows: string[] = []
  for (let r = 0; r < GLYPH_H; r++) {
    rows.push([...word]
      .map(ch => GLYPHS[ch]?.[r] ?? '     ')
      .join(' '))
  }
  return rows
}

function centre(text: string, width: number): string {
  const pad = Math.max(0, width - text.length)
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

/** Wrap lines in a double frame, padded, every row the same length. */
function boxed(lines: string[], padX = 2): string[] {
  const inner = Math.max(...lines.map(l => l.length)) + padX * 2
  const bar = '═'.repeat(inner)
  return [
    `╔${bar}╗`,
    ...lines.map(l => `║${' '.repeat(padX)}${l.padEnd(inner - padX * 2)}${' '.repeat(padX)}║`),
    `╚${bar}╝`,
  ]
}

// Boxed, CYBERSPACE is 65 columns, which does not fit a 44-column grid; the
// stacked CYBER / SPACE form needs 35. The years appear only with the wide
// strap, which would otherwise be wider than the stacked word.
function bannerLines(version: string, stacked: boolean): string[] {
  const word = stacked
    ? [...bannerRows('CYBER'), '', ...bannerRows('SPACE')]
    : bannerRows('CYBERSPACE')
  const innerW = Math.max(...word.map(l => l.length))
  const strap = stacked
    ? `CYBER/OS ${version}`
    : `CYBER/OS ${version}   ·   1984-${new Date().getFullYear()}`
  return boxed(['', ...word, '', centre(strap, innerW)])
}

async function banner(ctx: BootCtx, version: string): Promise<void> {
  // Measured rather than assumed: the test is whether the box and its shadow
  // column both fit.
  let lines = bannerLines(version, false)
  if (lines[0]!.length + 1 > ctx.term.cols) lines = bannerLines(version, true)

  const w = lines[0]!.length
  const x = Math.max(0, Math.floor((ctx.term.cols - w) / 2))
  const y = Math.max(0, Math.floor((ctx.term.rows - lines.length - 1) / 2))

  ctx.clear()
  for (let i = 0; i < lines.length; i++) {
    ctx.term.text(x, y + i, lines[i]!, BRIGHT | BOLD)
    // The shadow is drawn as the box grows rather than added afterwards.
    ctx.term.put(x + w, y + i + 1, '░')
    if (i === lines.length - 1) {
      for (let k = 1; k <= w; k++) ctx.term.put(x + k, y + i + 1, '░')
    }
    ctx.snd.blip(300 + i * 55, 0.03, 0)
    await ctx.sleep(38)
  }

  ctx.snd.postBeep(392, 0.42)
  await ctx.sleep(950)
  ctx.clear()
  await ctx.sleep(260)
}

// --- firmware ----------------------------------------------------------------

async function post(ctx: BootCtx): Promise<void> {
  ctx.setBlipHz(FIRMWARE_BLIP_HZ)

  // The POST beep plays with the first line, under the type-out.
  const year = new Date().getFullYear()
  ctx.snd.postBeep()
  await ctx.type('CYBERSPACE BIOS v2.11', BOLD)
  await ctx.typeln(`  (c) 1984-${year} UNREMARKABLE GARDEN INC.`, NORMAL)
  ctx.term.newline()
  await ctx.sleep(280)
  await ctx.typeln('MEMORY TEST : ', NORMAL)

  // Step back onto the line just ended and overwrite the count in place.
  ctx.term.cy--
  for (let k = 64; k <= 640; k += 64) {
    ctx.term.cx = 14
    ctx.term.write(String(k).padStart(3) + ' KB OK', NORMAL)
    ctx.snd.blip(FIRMWARE_BLIP_HZ)
    await ctx.sleep(75)
  }
  ctx.term.newline()
  await ctx.sleep(200)

  // A pause per device, so the sequence reads as probing rather than printing a list.
  ctx.snd.seek(3)
  await ctx.typeln('FIXED DISK  : ST-225  20MB  OK', NORMAL)
  await ctx.sleep(220)
  await ctx.typeln('SERIAL      : 2 PORTS', NORMAL)
  await ctx.sleep(180)
  await ctx.typeln('MODEM       : HAYES 2400 [READY]', NORMAL)
  await ctx.sleep(320)
  ctx.term.newline()
  await ctx.sleep(200)
  await ctx.typeln('boot: hd(0,a)/vmunix', NORMAL)
  await ctx.sleep(300)
  ctx.snd.seek(4)
  await ctx.typeln('LOADING KERNEL ...', NORMAL)
  await ctx.sleep(520)
  ctx.term.newline()
}

// --- the real machine --------------------------------------------------------

// Read locally, displayed only on this machine and sent nowhere. Every lookup is
// guarded, so a restricted browser costs one unknown line rather than the boot.
function specs(): [string, string][] {
  const out: [string, string][] = []
  const add = (label: string, read: () => string | undefined | null) => {
    let value: string | undefined | null
    try { value = read() } catch { value = null }
    out.push([label, value || 'unknown'])
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator

  add('host', () => location.hostname)
  add('arch', () => {
    const ua = nav?.userAgent ?? ''
    if (/arm64|aarch64/i.test(ua) || /Mac/.test(nav?.platform ?? '')) return 'arm64'
    if (/x86_64|x64|Win64|WOW64/i.test(ua)) return 'x86_64'
    return nav?.platform
  })
  add('cpu', () => {
    const n = nav?.hardwareConcurrency
    return n ? `${n} threads online` : undefined
  })
  add('memory', () => {
    const gb = (nav as Navigator & { deviceMemory?: number })?.deviceMemory
    return gb ? `${(gb * 1024 * 1024 * 1024).toLocaleString('en-US')} bytes` : undefined
  })
  add('display0', () =>
    `${screen.width}x${screen.height} @${window.devicePixelRatio || 1}x ${screen.colorDepth || 24}-bit`)
  add('gpu', gpu)
  add('locale', () => `${nav?.language || 'en-US'}.UTF-8`)
  add('timezone', () => Intl.DateTimeFormat().resolvedOptions().timeZone)

  return out
}

/** The renderer string, from a throwaway context rather than the CRT's own. */
function gpu(): string | undefined {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl') as WebGLRenderingContext | null
  const info = gl?.getExtension('WEBGL_debug_renderer_info')
  if (!gl || !info) return undefined
  const name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
  // Chrome answers with a sentence: "ANGLE (Apple, Apple M1 Pro, ...)".
  const angle = name.match(/^ANGLE \(([^,]+), ([^,)]+)/)
  return (angle ? angle[2]! : name).trim().slice(0, 46)
}

async function probe(ctx: BootCtx): Promise<void> {
  ctx.setBaud(4800)
  await ctx.typeln('probing machine ...', NORMAL)
  await ctx.sleep(200)

  // `  label     : ` is 14 columns. Truncated here, the only place that knows
  // the width; a wrapped value would overwrite the next label's row.
  const room = Math.max(8, ctx.term.cols - 14)
  for (const [label, value] of specs()) {
    await ctx.typeln(`  ${label.padEnd(10)}: ${value.slice(0, room)}`, NORMAL)
    await ctx.sleep(70)
  }
  ctx.term.newline()
  await ctx.sleep(240)
}

// --- userland ----------------------------------------------------------------

// The [ OK ] list is fabricated apart from the tty line, which reports the real
// grid. `[ OK ] ` is 7 columns, so the two longest lines have short forms for
// grids where they would otherwise wrap.
function targets(ctx: BootCtx): string[] {
  const { cols, rows } = ctx.term
  const narrow = cols - 7 < 43
  return [
    'spawn init (pid 1)',
    `start tty1 (vt320, ${cols}x${rows})`,
    narrow ? 'seed csprng from getRandomValues()'
           : 'seed csprng from crypto.getRandomValues()',
    'resolved cyberspace.online',
    narrow ? 'tls handshake  TLSv1.3'
           : 'tls handshake  TLSv1.3 ECDHE-RSA-AES256-GCM',
    'bind realtime socket',
    'firebase auth channel ready',
    'reached target network-online.target',
    'reached target multi-user.target',
  ]
}

async function services(ctx: BootCtx): Promise<void> {
  // A boot log scrolls faster than the shell's own output rate.
  ctx.setBaud(9600)

  ctx.snd.seek(3)
  // The dot leader runs as far as leaves room for the status on the same row.
  const leader = Math.max(20, Math.min(44, ctx.term.cols - 15))
  for (const mount of ['Mounting opfs on /home ', 'Mounting tmpfs on /tmp ']) {
    await ctx.typeln(mount.padEnd(leader, '.') + ' ok')
    await ctx.sleep(90)
  }
  ctx.term.newline()
  await ctx.sleep(180)

  for (const target of targets(ctx)) {
    await ctx.typeln(`[ OK ] ${target}`, NORMAL)
    await ctx.sleep(55)
  }
  await ctx.sleep(340)
}

// --- entry -------------------------------------------------------------------

/**
 * The boot sequence after the strike. Throws Aborted when skipped; the caller
 * handles the end state, stopping the chime, clearing and returning to the prompt.
 */
export async function bootSequence(
  term: BootTerm,
  snd: Sound,
  signal: AbortSignal,
  opts?: { version?: string },
): Promise<void> {
  const ctx = new BootCtx(term, snd, signal)
  await banner(ctx, opts?.version ?? '0.1')
  await post(ctx)
  await probe(ctx)
  await services(ctx)
}
