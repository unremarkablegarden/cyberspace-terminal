// A modal of labelled fields, submitted together.
//
// The rows are the fields alone. A status rule and row appear under them only
// while there is a message to show, so a form with nothing to report is as
// tall as its fields.
//
// Submission is asynchronous: the box stays open while onSubmit runs, keys are
// held, and an error comes back as the status line with the caret returned to
// the field the caller names. A form that only collects values resolves at
// once with null.

import { NORMAL, BRIGHT, BOLD, DIM } from './attrs.js'
import type { Grid } from './surface.js'
import type { Screen } from './screen.js'
import type { KeyInput } from './keys.js'
import { cells, clear, frame, ground, hline, keyHint, label, shadow, type Rect, type Span } from './box.js'
import { InputLine } from './input.js'

export interface FormField {
  label: string
  value?: string
  /** Drawn in place of every character, as a password field does with `*`. */
  mask?: string
  maxLength?: number
}

export interface FormError {
  message: string
  /** Fields to blank, by index. */
  clear?: number[]
  /** Field to focus, by index. Defaults to the first cleared field, else the last. */
  focus?: number
}

export interface FormOptions {
  title: string
  fields: FormField[]
  /** Resolves null on success, or the error to show. */
  onSubmit: (values: string[]) => Promise<FormError | null>
  /** The values on success, null when dismissed. Called once. */
  onDone: (values: string[] | null) => void
  onFeedback?: (kind: 'move' | 'submit' | 'fail' | 'cancel' | 'edge' | 'inert', e: KeyInput) => void
  /** Repaint after onSubmit settles, which no key triggers. */
  onRepaint?: () => void
  /** Shown in the bottom rule. Defaults to ↵ OK  ESC Cancel. */
  hint?: string | Span[]
  /** Columns of text after the labels. */
  width?: number
  bounds?: Rect
  shadow?: boolean
}

const WIDTH = 24

export class FormPopup implements Screen {
  private inputs: InputLine[]
  private focus = 0
  private status = ''
  private busy = false
  private closed = false
  private labelW: number
  /** Where the last draw went. The box changes height with its status, so the old cells are cleared first. */
  private last?: Rect

  constructor(private opts: FormOptions) {
    this.labelW = opts.fields.reduce((n, f) => Math.max(n, cells(f.label)), 0) + 1
    this.inputs = opts.fields.map(f => {
      const input = new InputLine({ prompt: f.label.padEnd(this.labelW), maxLength: f.maxLength ?? 64, mask: f.mask })
      if (f.value) input.set(f.value)
      return input
    })
    // Start on the first empty field, so a prefilled form opens on what is missing.
    const empty = this.inputs.findIndex(i => !i.value)
    this.focus = empty === -1 ? this.inputs.length - 1 : empty
  }

  get values(): string[] {
    return this.inputs.map(i => i.value)
  }

  silentKey(e: KeyInput): boolean {
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    return e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab'
  }

  onKey(e: KeyInput): boolean {
    if (this.closed) return false
    if (e.key === 'Escape' || (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C'))) {
      this.opts.onFeedback?.('cancel', e)
      this.finish(null)
      return true
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    // Keys are consumed while the request is out, so nothing lands in a field
    // that is about to be cleared or closed.
    if (this.busy) {
      this.opts.onFeedback?.('inert', e)
      return true
    }
    const last = this.inputs.length - 1
    if (e.key === 'Tab' || e.key === 'ArrowDown') return this.move(this.focus === last ? 0 : this.focus + 1, e)
    if (e.key === 'ArrowUp') return this.move(this.focus === 0 ? last : this.focus - 1, e)
    if (e.key === 'Enter') {
      // Enter advances through the fields and submits from the last, so a form
      // is filled top to bottom without reaching for Tab. An empty field is
      // refused on the way.
      if (!this.inputs[this.focus].value) {
        this.opts.onFeedback?.('edge', e)
        return true
      }
      if (this.focus < last) return this.move(this.focus + 1, e)
      this.opts.onFeedback?.('submit', e)
      void this.submit()
      return true
    }
    if (this.inputs[this.focus].onKey(e)) {
      this.status = ''
      return true
    }
    return false
  }

  onPaste(text: string): boolean {
    if (this.closed || this.busy) return false
    return this.inputs[this.focus].insert(text)
  }

  private move(to: number, e: KeyInput): boolean {
    this.focus = to
    this.opts.onFeedback?.('move', e)
    return true
  }

  private async submit(): Promise<void> {
    this.busy = true
    this.status = ''
    this.opts.onRepaint?.()
    const values = this.values
    let error: FormError | null
    try {
      error = await this.opts.onSubmit(values)
    } catch (err) {
      error = { message: (err as Error)?.message ?? String(err) }
    }
    if (this.closed) return
    this.busy = false
    if (error === null) {
      this.finish(values)
      return
    }
    this.status = error.message
    for (const i of error.clear ?? []) this.inputs[i]?.clear()
    this.focus = error.focus ?? error.clear?.[0] ?? this.inputs.length - 1
    this.opts.onFeedback?.('fail', { key: '', ctrlKey: false, shiftKey: false, metaKey: false, altKey: false })
    this.opts.onRepaint?.()
  }

  private finish(values: string[] | null) {
    this.closed = true
    this.opts.onDone(values)
  }

  dispose() {
    this.closed = true
  }

  /** Where the box is drawn, so a caller can place its own output around it. */
  rect(term: Grid): Rect {
    const b = this.opts.bounds ?? { x: 0, y: 0, w: term.cols, h: term.rows }
    const hint = this.opts.hint
    const hintW = !hint ? 0 : typeof hint === 'string' ? cells(hint) : hint.reduce((n, s) => n + cells(s.text), 0)
    const w = Math.min(
      Math.max(16, b.w - 4),
      Math.max(this.labelW + (this.opts.width ?? WIDTH) + 4, cells(this.opts.title) + 6, hintW + 6),
    )
    // The fields and the two border rows; a rule and a row more while a status shows.
    const h = this.inputs.length + 2 + (this.status ? 2 : 0)
    return { x: b.x + Math.floor((b.w - w) / 2), y: b.y + Math.floor((b.h - h) / 2), w, h }
  }

  draw(term: Grid) {
    const r = this.rect(term)
    // One column and row more, which is where the shadow falls.
    if (this.last) clear(term, { ...this.last, w: this.last.w + 1, h: this.last.h + 1 })
    this.last = r
    clear(term, r)
    if (this.opts.shadow) shadow(term, r, this.opts.bounds)
    const inner = frame(term, r)
    label(term, r, this.opts.title, { attr: BRIGHT | BOLD })
    label(term, r, this.opts.hint ?? keyHint([['↵', 'OK'], ['ESC', 'Cancel']]), { edge: 'bottom', align: 'right' })

    // The focused field is drawn last so it leaves the caret.
    const field: Rect = { x: inner.x + 1, y: inner.y, w: inner.w - 2, h: 1 }
    this.inputs.forEach((input, i) => { if (i !== this.focus) input.draw(term, { ...field, y: inner.y + i }) })
    this.inputs[this.focus].draw(term, { ...field, y: inner.y + this.focus })
    term.showCursor = !this.busy

    if (this.status) {
      const y = inner.y + this.inputs.length
      hline(term, y, r.x, r.x + r.w - 1, NORMAL)
      term.text(inner.x + 1, y + 1, this.status.slice(0, inner.w - 2), this.busy ? DIM : NORMAL)
    }

    ground(term, r)
    term.dirty = true
  }
}
