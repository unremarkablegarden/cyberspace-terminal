// The job switcher: CMD-K over the machine, on the CRT grid outside the pty.
// CTRL-K off a Mac, the platform's own modifier either way; see config.ts.
//
// The chord opens the list with the row after the current one selected; again
// moves down, with Shift up, and letting the modifier go takes the row. Any
// other key makes the list ordinary: arrows, digits and Enter choose, Escape
// leaves, Delete kills the selected job after a confirm. The switch itself is
// the kernel's (Jobs.switchTo); the shell picks it up at its prompt.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { RENDER } from '@cyberspace/crt/config'
import type { Job, Kernel } from '@cyberspace/kernel'
import { ConfirmPopup, MUTED, ScreenStack, SelectPopup, YES_NO, type KeyInput } from '@cyberspace/tui'
import { grid } from './grid'
import type { Overlay } from './input'

/** Programs offered as launchers when no job of theirs is running. */
const MAIN = ['feed', 'circ', 'cmail', 'globe']
const TITLE = 'PROGRAMS'
const GAP = 2

type Row = { kind: 'job'; job: Job } | { kind: 'launch'; name: string } | { kind: 'shell' }

export class JobPalette implements Overlay {
  private stack: ScreenStack | null = null
  private rows: Row[] = []
  private items: string[] = []
  /** Set by any key; from then on letting go of Cmd no longer chooses. */
  private sticky = false
  private cursorWas = true

  constructor(
    private screen: CrtScreen,
    private snd: Sound,
    private kernel: () => Kernel | null,
  ) {}

  get open(): boolean {
    return !!this.stack?.active
  }

  /** Cmd+K: open on the next row, or move the selection by `dir`. */
  step(dir: 1 | -1): void {
    if (this.open) {
      this.stack!.key(arrow(dir))
      return
    }
    const kernel = this.kernel()
    if (!kernel || grid.locked) return
    this.build(kernel)
    const jobs = kernel.jobs
    const here = jobs.fg ? this.rows.findIndex(r => r.kind === 'job' && r.job === jobs.fg) : this.rows.length - 1
    this.show((here + dir + this.rows.length) % this.rows.length)
  }

  /** Cmd let go: take the selected row, unless another key made the list ordinary. */
  release(): void {
    if (!this.open || this.sticky) return
    this.stack!.key({ key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })
  }

  key(k: KeyInput): void {
    this.sticky = true
    this.stack?.key(k)
  }

  silentKey(k: KeyInput): boolean {
    return !!this.stack?.top?.silentKey?.(k)
  }

  private build(kernel: Kernel): void {
    const jobs = kernel.jobs
    this.rows = jobs.list().map(job => ({ kind: 'job', job }) as Row)
    for (const name of MAIN) {
      if (!jobs.byName(name) && kernel.resolveProgram(name)) this.rows.push({ kind: 'launch', name })
    }
    this.rows.push({ kind: 'shell' })
    this.items = this.rows.map((r, i) => this.text(r, i))
  }

  private show(selected: number): void {
    const jobs = this.kernel()!.jobs
    const count = this.rows.length
    this.stack ??= new ScreenStack(this.screen.term as never)
    grid.lock()
    this.cursorWas = RENDER.cursor
    RENDER.cursor = false
    this.sticky = false
    this.snd.tick()

    const picker = new SelectPopup({
      title: TITLE,
      items: this.items,
      selected,
      keys: this.rows.map((_, i) => (i < 9 ? String(i + 1) : '')),
      hint: `1-${Math.min(9, count)} ⬆⬇ ↵  DEL kill`,
      shadow: true,
      decorate: (term, row, i, sel) => {
        if (sel) return
        const r = this.rows[i]!
        // The state column, and a launcher whole, read quieter than the jobs.
        const from = r.kind === 'launch' ? 0 : this.markCol()
        const s = this.items[i]!.slice(from)
        term.text(row.x + from, row.y, s.slice(0, Math.max(0, row.w - from)), MUTED)
      },
      onFeedback: kind => {
        if (kind === 'edge') this.snd.beep(220, 0.04)
        else if (kind === 'move') this.snd.tick()
        else if (kind === 'cancel') this.snd.blip(420, 0.09, 0)
      },
      onKey: (e, index) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return false
        const r = this.rows[index]
        if (r?.kind !== 'job') { this.snd.beep(220, 0.04); return true }
        this.confirmKill(r.job)
        return true
      },
      onDone: (item, index) => {
        this.hide()
        if (item === null) return
        const r = this.rows[index]!
        if (r.kind === 'job') { if (r.job !== jobs.fg) void jobs.switchTo(r.job) }
        else if (r.kind === 'launch') void jobs.switchTo({ launch: r.name })
        else void jobs.switchTo('shell')
      },
    })
    this.stack.push(picker)
  }

  private confirmKill(job: Job): void {
    const stack = this.stack!
    stack.push(new ConfirmPopup({
      title: 'KILL',
      lines: [job.line],
      hint: YES_NO,
      answer: 'yn',
      shadow: true,
      onFeedback: kind => { if (kind === 'cancel') this.snd.blip(420, 0.09, 0) },
      onDone: yes => {
        stack.pop()
        if (!yes) return
        const kernel = this.kernel()!
        kernel.jobs.kill(job)
        this.snd.beep(220, 0.06)
        // The list is narrower without the row, so the box is drawn afresh
        // rather than over its old frame. The selection stays put.
        const at = this.rows.findIndex(r => r.kind === 'job' && r.job === job)
        this.hide()
        this.build(kernel)
        this.show(Math.min(Math.max(at, 0), this.rows.length - 1))
        this.sticky = true
      },
    }))
  }

  private hide(): void {
    while (this.stack?.active) this.stack.pop()
    grid.unlock()
    RENDER.cursor = this.cursorWas
  }

  /** Column where the state mark starts, shared by every row so the marks line up. */
  private markCol(): number {
    return 1 + GAP + this.nameW() + GAP
  }

  private nameW(): number {
    return Math.max(...this.rows.map(r => label(r).length), 5)
  }

  /** `2  circ cyberspace   stopped`: key, line, state. */
  private text(r: Row, i: number): string {
    const key = i < 9 ? String(i + 1) : ' '
    const gap = ' '.repeat(GAP)
    const fg = this.kernel()?.jobs.fg
    const mark = r.kind !== 'job' ? '' : r.job === fg ? '·' : r.job.state
    return `${key}${gap}${label(r).padEnd(this.nameW())}${gap}${mark}`.trimEnd()
  }
}

const label = (r: Row): string =>
  r.kind === 'job' ? r.job.line : r.kind === 'launch' ? r.name : 'shell'

const arrow = (dir: 1 | -1): KeyInput =>
  ({ key: dir === 1 ? 'ArrowDown' : 'ArrowUp', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })
