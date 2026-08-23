// The gallery of published programs.
//
// Reading a program and running it are separated deliberately. The gallery
// executes nothing: S pages the source, Enter copies it into the reader's own
// ~/bin, and running it is a separate command at the prompt. There is no
// sandbox on this machine, since an imported program runs with the reader's
// session behind it, so the source is on screen before any of it can run. T is
// the one shortcut, and it applies the same guard an installed program gets.
//
// The full list is fetched once and sorted and filtered in memory, so a filter
// costs no request per keystroke.

import { dec, fs, paths, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, InputLine, Reveal, Pager, parseKeys, wrap,
  clear, frame, hline, label, RULE,
  ConfirmPopup, TextPopup, YES_NO,
  NORMAL, BRIGHT, BOLD, DIM,
  type Grid, type Rect, type Span, type TextLine, type KeyInput, type Screen,
} from '@cyberspace/tui'
import type { Runtime } from '@cyberspace/compat/classify'
import type { ApiClient } from './api.js'
import { SILENT, type ChatSound } from './chat.js'
import { ProgramStore, type PublishedProgram } from './programs-store.js'
import { readInstalled, writeInstalled, type Installed } from './installed.js'

/**
 * Version is shown but not offered as a sort key: it counts an author's
 * revisions rather than describing the program, and most entries sit at v1.
 */
type SortKey = 'name' | 'author' | 'publishedAt'

const NAME_W = 16
const AUTHOR_W = 13
const VER_W = 4
/** Fits the longest label KIND takes, `wasm`. */
const KIND_W = 4
const DATE_W = 10

/**
 * What the KIND column prints.
 *
 * Every row carries one rather than only the unusual kinds: a blank under a
 * heading reads as a fact nobody recorded, and this machine runs all three.
 */
const KIND: Record<Runtime, string> = { web: 'web', term: 'term', wasm: 'wasm' }

/** Said in the About box, where there is room to say what the kind means. */
const ABOUT_KIND: Record<Exclude<Runtime, 'web'>, string> = {
  term: 'Written for this machine. Not for the web terminal.',
  wasm: 'A wasm binary. Nothing to read; S shows nothing.',
}

/** Blank columns between the frame and the table, each side. */
const PAD = 1

/** Wrap width for the About box, narrower than the screen to keep lines readable. */
const ABOUT_W = 56

const BIN_DIR = 'bin'

/**
 * Key hints as inverse keycaps, matching feed and circ. Each cap carries the
 * key as printed on a keyboard, followed by a Title Case label.
 *
 * Labels are short because six hints and a count share eighty columns; the row
 * must not wrap.
 */
const HINT: Span[] = [
  { text: ' NAD ', inverse: true, attr: DIM },
  { text: ' Sort ' },
  { text: ' SPACE ', inverse: true, attr: DIM },
  { text: ' About ' },
  { text: ' S ', inverse: true, attr: DIM },
  { text: ' Src ' },
  { text: ' T ', inverse: true, attr: DIM },
  { text: ' Test ' },
  { text: ' ↵ ', inverse: true, attr: DIM },
  { text: ' Get ' },
]

/**
 * Offered only on a row the reader holds an installed copy of, never on their
 * own original. U unpublishes an original and rm removes a file; this key only
 * discards a copy that can be reinstalled from the same row.
 */
const HINT_HELD: Span[] = [
  { text: ' DEL ', inverse: true, attr: DIM },
  { text: ' Delete ' },
]

/** Offered only on the reader's own rows; there is nothing to unpublish otherwise. */
const HINT_MINE: Span[] = [
  { text: ' U ', inverse: true, attr: DIM },
  { text: ' Unpub ' },
]

/**
 * Drawn on the top rule, right, opposite the title: the bottom rule is already
 * full, and quitting belongs with the program's name rather than among the keys
 * that act on the list.
 */
const HINT_EXIT: Span[] = [
  { text: ' ESC ', inverse: true, attr: DIM },
  { text: ' Exit ' },
]

/** Shown while the filter is open, where every key is a character rather than a command. */
const HINT_FIND: Span[] = [
  { text: ' ↵ ', inverse: true, attr: DIM },
  { text: ' Apply ' },
  { text: ' ESC ', inverse: true, attr: DIM },
  { text: ' Clear ' },
]

/**
 * Fixed YYYY-MM-DD rather than the member's own format: this is a sortable
 * column, and a relative date cannot be compared by eye or aligned.
 */
function shortDate(at: number): string {
  if (!at) return '—'
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const cut = (text: string, width: number): string =>
  text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'

/** Returned by the gallery to ask the caller to run a program and then reopen it. */
interface TestRun { name: string; bytes: Uint8Array }

class BrowseScreen {
  private all: PublishedProgram[] = []
  private view: PublishedProgram[] = []
  private sort: SortKey = 'publishedAt'
  /** Default direction per sort key: descending for dates, ascending for names. */
  private desc = true
  private sel = 0
  private scroll = 0

  private filtering = false
  private filter = ''
  private input: InputLine

  /** Gallery id to the name that copy has in the reader's ~/bin. See installed.ts. */
  private installed: Installed = new Map()

  /**
   * Reveals the listing one row at a time, once, when the gallery first
   * arrives. Sorting and filtering reorder rows already on screen, so animating
   * those would make the list unreadable on every keystroke of a filter.
   */
  private reveal: Reveal

  private loaded = false
  private failed = false
  /** Failure text, wrapped under the headline. */
  private reason = ''
  /** Status message, shown above the bottom rule until the next keypress. */
  private status = ''

  /** Set by a key that ends the screen: quit, or a program to run before reopening. */
  done = false
  test: TestRun | null = null

  /**
   * End the screen, waking the key loop if it is blocked in a read.
   *
   * A key that ends the screen is seen on the next pass of the loop, but the
   * source fetch behind T resolves long after the loop has parked in
   * stdin.read(). The interrupt EOFs that pending read and leaves the queue
   * untouched.
   */
  private finish(): void {
    this.done = true
    this.p.stdin.interrupt?.()
  }

  constructor(
    private p: Proc,
    private s: Surface,
    private stack: ScreenStack,
    private store: ProgramStore,
    private snd: ChatSound,
  ) {
    this.input = new InputLine({ prompt: '/', maxLength: 64, onReject: () => snd.beep(220, 0.04) })
    this.reveal = new Reveal({
      onTick: () => this.paint(),
      // Output bleep rather than the selection tick: this is text arriving.
      onBlip: () => snd.blip(),
    })
  }

  private get home(): string {
    return this.p.env.HOME ?? '/home/guest'
  }

  // --- drawing --------------------------------------------------------------

  /**
   * Redraw immediately. Safe while a modal is open: a stacked screen holds the
   * grid, so this returns without erasing the box above it.
   */
  paint(): void {
    if (this.stack.active) return
    this.draw(this.s)
    this.p.tty?.paint(this.s.render())
  }

  draw(term: Grid): void {
    const outer: Rect = { x: 0, y: 0, w: term.cols, h: term.rows }
    clear(term, outer)
    const box = frame(term, outer)
    // The count sits beside the title but is not bold, so it reads as a fact
    // about the list rather than part of its name. Omitted until the list has
    // arrived, since (0) during loading would state a result that is not known yet.
    label(term, outer, [
      { text: 'USER PROGRAMS', attr: BRIGHT | BOLD },
      ...(this.loaded
        ? [{
            text: this.filter
              ? ` (${this.view.length} of ${this.all.length})`
              : ` (${this.all.length})`,
            attr: NORMAL,
          }]
        : []),
    ])
    label(term, outer, HINT_EXIT, { align: 'right' })

    if (this.failed) return this.problem(term)
    if (!this.loaded) return this.centred(term, 'LOADING')
    if (!this.all.length) return this.centred(term, 'NOTHING PUBLISHED YET')

    this.drawHeader(term, box, outer)
    this.drawRows(term, box)
    this.drawStatus(term, box, outer.y + outer.h - 1)
    this.drawHint(term, outer)

    // No caret outside the filter, which draws its own.
    term.showCursor = this.filtering
  }

  /** The headline, with the registry's own error text underneath. */
  private problem(term: Grid): void {
    const lines = wrap(this.reason, Math.min(64, term.cols - 8))
    const top = (term.rows >> 1) - Math.floor((lines.length + 2) / 2)
    const put = (y: number, text: string, attr: number) =>
      term.text(Math.max(0, (term.cols - text.length) >> 1), y, text, attr)

    put(top, 'GALLERY UNAVAILABLE', NORMAL)
    lines.forEach((line, i) => put(top + 2 + i, line, DIM))
    term.showCursor = false
  }

  private centred(term: Grid, text: string): void {
    term.text(Math.max(0, (term.cols - text.length) >> 1), term.rows >> 1, text, DIM)
    term.showCursor = false
  }

  /**
   * Column names in bold, with an arrow on the active sort key and a rule
   * beneath, so they do not read as the first row of the list.
   */
  private drawHeader(term: Grid, box: Rect, outer: Rect): void {
    const mark = (key: SortKey, text: string) =>
      this.sort === key ? `${text}${this.desc ? '⬇' : '⬆'}` : text

    const head = [
      ('  ' + mark('name', 'NAME')).padEnd(NAME_W),
      mark('author', 'AUTHOR').padEnd(AUTHOR_W),
      // Padding rather than a separator: a right-aligned number against a date
      // would read as a single field.
      'VER'.padStart(VER_W) + ' ',
      'KIND'.padEnd(KIND_W),
      mark('publishedAt', 'DATE').padEnd(DATE_W + 1),
      'DESCRIPTION',
    ].join(' ')

    term.text(box.x + PAD, box.y, cut(head, box.w - PAD * 2), BOLD)

    // Drawn across the outer width rather than the interior. box.ts merges
    // direction bits per cell, so running the rule into the frame's verticals
    // renders those cells as the junctions. Stopping short leaves a gap at each end.
    hline(term, box.y + 1, outer.x, outer.x + outer.w - 1, NORMAL)
  }

  private drawRows(term: Grid, box: Rect): void {
    const height = this.rows(term)

    if (this.sel < this.scroll) this.scroll = this.sel
    else if (this.sel >= this.scroll + height) this.scroll = this.sel - height + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.view.length - height)))

    for (let i = 0; i < height; i++) {
      // Rows that have not arrived yet. break rather than continue: rows land
      // top-down, so there is nothing below this one either.
      if (i >= this.reveal.count) break

      const p = this.view[this.scroll + i]
      if (!p) break
      // +2 for the heading row and the rule beneath it.
      const y = box.y + 2 + i
      const on = this.scroll + i === this.sel

      // Installed rows are marked with *, matching what ls shows for an
      // executable. Uninstalled rows get a blank rather than a second symbol:
      // the column is reserved either way, and a "not installed" mark would have
      // to be read on every row.
      const held = this.installed.has(p.id) || p.mine
      const row = [
        (held ? '* ' : '  ') + cut(p.name, NAME_W - 2).padEnd(NAME_W - 2),
        cut(p.author, AUTHOR_W).padEnd(AUTHOR_W),
        `v${p.release}`.padStart(VER_W) + ' ',
        KIND[p.runtime].padEnd(KIND_W),
        shortDate(p.publishedAt).padEnd(DATE_W + 1),
        // Not truncated here; the whole row passes through cut below, which
        // ellipsises at the box width. Space opens the full text.
        p.description,
      ].join(' ')

      // The selected row is drawn inverse, the only background available on a
      // one-bit display. On an inverse cell the attribute applies to the
      // background, so DIM keeps the bar from being the brightest thing on
      // screen and BOLD keeps the text legible against it.
      const w = box.w - PAD * 2
      term.text(box.x + PAD, y, cut(row, w).padEnd(w), on ? DIM | BOLD : NORMAL, on ? 1 : 0)
    }
  }

  /**
   * Response to the last keypress, on its own line above the bottom rule.
   *
   * Kept off the hint rule because these messages run to sentences (an install
   * confirmation is around 46 columns) and the hints already occupy five pairs.
   * label() does not clip and the caps are drawn second, so a shared row would
   * paint the hints over the message.
   */
  private drawStatus(term: Grid, box: Rect, bottom: number): void {
    if (!this.status) return
    const w = box.w - PAD * 2
    term.text(box.x + PAD, bottom - 1, cut(this.status, w), BRIGHT)
  }

  private drawHint(term: Grid, outer: Rect): void {
    if (this.filtering) {
      // The field is drawn within the rule, so the row must be cleared first or
      // the rule shows through the text.
      const w = Math.min(40, term.cols - 6)
      const y = outer.y + outer.h - 1
      term.text(2, y, ' '.repeat(w + 2), DIM)
      this.input.draw(term, { x: 2, y, w, h: 1 })
      label(term, outer, HINT_FIND, { edge: 'bottom', align: 'right' })
      return
    }

    const p = this.current
    label(term, outer, [
      ...HINT,
      ...(p && !p.mine && this.installed.has(p.id) ? HINT_HELD : []),
      ...(p?.mine ? HINT_MINE : []),
    ], { edge: 'bottom', align: 'right' })
  }

  /**
   * Rows available to the list: the interior less the header, its rule and the
   * status line above the bottom rule.
   *
   * The status line is reserved whether or not it has anything to show. Giving
   * the row to the list while empty and reclaiming it when filled would shift
   * every row on the keypress being answered.
   */
  private rows(term: Grid): number {
    return Math.max(1, term.rows - 5)
  }

  // --- data -----------------------------------------------------------------

  async load(): Promise<void> {
    try {
      // Both are needed: the gallery supplies the rows, the index marks which are installed.
      const [gallery, installed] = await Promise.all([
        this.store.gallery(),
        readInstalled(this.home).catch(() => new Map() as Installed),
      ])
      this.all = gallery
      this.installed = installed
      this.loaded = true
    } catch (err) {
      // The registry's own error text is kept; a bare "unavailable" is not diagnosable.
      this.failed = true
      this.reason = (err as Error)?.message ?? String(err)
    }
    this.apply()
    // Bounded by the visible rows rather than the length of the list.
    this.reveal.start(Math.min(this.view.length, this.rows(this.s)))
    this.paint()
  }

  /** Filter first, then sort what remains. */
  private apply(): void {
    const needle = this.filter.trim().toLowerCase()
    const rows = needle
      ? this.all.filter(p =>
          p.name.toLowerCase().includes(needle)
          || p.author.toLowerCase().includes(needle)
          || p.description.toLowerCase().includes(needle))
      : [...this.all]

    const key = this.sort
    rows.sort((a, b) => {
      const n = key === 'publishedAt'
        ? a.publishedAt - b.publishedAt
        : String(a[key]).localeCompare(String(b[key]), undefined, { sensitivity: 'base' })
      // Name breaks every tie, making the order total so a re-sort never shuffles
      // rows that compare equal.
      return (this.desc ? -n : n) || a.name.localeCompare(b.name)
    })

    this.view = rows
    this.sel = Math.min(this.sel, Math.max(0, rows.length - 1))
  }

  private setSort(key: SortKey): void {
    if (this.sort === key) {
      this.desc = !this.desc
    } else {
      this.sort = key
      // Dates default to newest first, names to A first.
      this.desc = key === 'publishedAt'
    }
    this.apply()
  }

  private move(delta: number): void {
    const next = Math.min(this.view.length - 1, Math.max(0, this.sel + delta))
    if (next === this.sel) {
      this.snd.beep(220, 0.04)
      return
    }
    this.sel = next
    this.status = ''
    this.snd.tick()
  }

  private get current(): PublishedProgram | null {
    return this.view[this.sel] ?? null
  }

  // --- actions --------------------------------------------------------------

  private open(screen: Screen): void {
    this.stack.push(screen)
    this.p.tty?.paint(this.s.render())
  }

  private close(): void {
    this.stack.pop()
    this.s.invalidate()
    this.paint()
  }

  /** Repaint the top of the screen stack. Used by the selected-row flash. */
  private repaintTop(): void {
    this.stack.top?.draw?.(this.s)
    this.p.tty?.paint(this.s.render())
  }

  /**
   * The program's own description, in a box.
   *
   * A box rather than an expanding row, which would push every row below it
   * down and move the next entry out from under the cursor. Nothing is fetched;
   * the text is already on the row.
   */
  private about(p: PublishedProgram): Promise<void> {
    const body = p.description || 'No description.'
    const lines: TextLine[] = [
      ...wrap(body, ABOUT_W),
      RULE,
      `By @${p.author}`,
      `Version ${p.release}, published ${shortDate(p.publishedAt)}`,
      ...(p.runtime === 'web' ? [] : [ABOUT_KIND[p.runtime]]),
    ]

    return new Promise(done => {
      this.open(new TextPopup({
        title: p.name.toUpperCase(),
        note: p.mine ? 'YOURS' : undefined,
        lines,
        hint: 'ESC Close',
        shadow: true,
        onFeedback: kind => {
          if (kind === 'inert' || kind === 'edge') this.snd.beep(220, 0.04)
          else this.snd.blip(420, 0.09, 0)
        },
        onDone: () => { this.close(); done() },
      }))
    })
  }

  private ask(title: string, lines: string[]): Promise<boolean> {
    return new Promise(done => {
      this.open(new ConfirmPopup({
        title,
        lines,
        hint: YES_NO,
        shadow: true,
        onFeedback: kind => {
          if (kind === 'inert') this.snd.beep(220, 0.04)
          else this.snd.blip(420, 0.09, 0)
        },
        onDone: yes => { this.close(); done(yes) },
      }))
    })
  }

  /**
   * Page the program's source. The step that puts the code on screen before
   * anything is installed.
   */
  private async preview(p: PublishedProgram): Promise<void> {
    if (p.runtime === 'wasm') {
      this.status = `${p.name} is a binary — nothing to read`
      this.snd.beep(220, 0.12)
      this.paint()
      return
    }
    this.status = 'reading…'
    this.paint()
    let source: string
    try {
      source = dec.decode((await this.store.fetch(p.id)).bytes)
    } catch (err) {
      this.status = (err as Error).message
      this.snd.beep(220, 0.12)
      this.paint()
      return
    }
    this.status = ''

    const lines = source.split('\n').flatMap(line => wrap(line, this.s.cols))
    await new Promise<void>(done => {
      this.open(new Pager({
        lines,
        name: `@${p.author}/${p.name} v${p.release}`,
        onFeedback: kind => { if (kind === 'edge') this.snd.beep(220, 0.04) },
        onDone: () => { this.close(); done() },
      }))
    })
  }

  /**
   * Run a program once without installing it.
   *
   * The program is not run from here: this screen holds the whole grid, so
   * anything it wrote to the scrollback would be hidden. The source is fetched
   * here, where there is somewhere to report progress, and handed back to the
   * caller, which leaves the alt screen, runs it on the bare terminal and
   * reopens the gallery.
   *
   * This runs another member's code with the reader's own session behind it.
   * Installing and running does the same; this only removes the intermediate
   * steps, which is why S sits beside it and why the guard applies either way.
   */
  private async runTest(p: PublishedProgram): Promise<void> {
    this.status = 'fetching…'
    this.paint()
    try {
      const r = await this.store.fetch(p.id)
      this.test = { name: p.name, bytes: r.bytes }
      this.finish()
    } catch (err) {
      this.status = (err as Error).message
      this.snd.beep(220, 0.12)
      this.paint()
    }
  }

  private async install(p: PublishedProgram): Promise<void> {
    if (p.mine) {
      this.status = 'this one is yours — it is already in ~/bin'
      this.paint()
      return
    }

    const dest = paths.join(this.home, BIN_DIR, p.name)

    // A name already in use is the reader's own file; overwriting it without
    // asking would discard their work.
    const existing = await fs.promises.stat(dest).catch(() => null)
    if (existing && !existing.isDirectory()) {
      const ok = await this.ask('OVERWRITE', [
        `You already have a program called ${p.name}.`,
        '',
        'Installing this one replaces yours.',
      ])
      if (!ok) {
        this.status = 'not installed'
        this.paint()
        return
      }
    }

    this.status = 'installing…'
    this.paint()
    try {
      const r = await this.store.fetch(p.id)
      // Refused before the file is written rather than at run time. The guard
      // would catch it either way, but a program that can never run should not
      // sit in ~/bin looking installed, and the reason is more useful now.
      // A wasm module is not read: it cannot reach the page, having stdio and
      // nothing else, and there is no JS in it to parse.
      if (r.runtime !== 'wasm') {
        const { inspect } = await import('@cyberspace/compat/guard')
        const hits = inspect(dec.decode(r.bytes))
        if (hits.length) {
          const first = hits[0]!
          this.status = `refused — ${first.line}:${first.col} ${first.name}, press S to read it`
          this.snd.beep(220, 0.12)
          this.paint()
          return
        }
      }
      await fs.promises.mkdir(paths.join(this.home, BIN_DIR)).catch(() => {})
      await fs.promises.writeFile(dest, r.bytes, { mode: 0o755 })
      // Recorded with the copy; this is what marks the row installed on the next open.
      this.installed.set(p.id, `${BIN_DIR}/${p.name}`)
      await writeInstalled(this.home, this.installed)
      this.status = `installed as ~/${BIN_DIR}/${p.name} — run it with ~/${BIN_DIR}/${p.name}`
      this.snd.blip(660, 0.06, 0)
    } catch (err) {
      this.status = (err as Error).message
      this.snd.beep(220, 0.12)
    }
    this.paint()
  }

  /**
   * Recall the reader's own program from the gallery.
   *
   * The same recall publish offers. Nothing is deleted: anyone who already
   * installed it keeps their copy, which the confirmation states.
   */
  private async unpublish(p: PublishedProgram): Promise<void> {
    const ok = await this.ask('UNPUBLISH', [
      `Take ${p.name} v${p.release} out of the gallery.`,
      '',
      'Nobody new can install it. Anyone who already',
      'did keeps their copy.',
      '',
      'You can publish it again whenever you like.',
    ])
    if (!ok) {
      this.status = 'still published'
      this.paint()
      return
    }

    this.status = 'unpublishing…'
    this.paint()
    try {
      await this.store.recall(p.id)
      this.all = this.all.filter(x => x.id !== p.id)
      this.apply()
      this.status = `${p.name} unpublished`
    } catch (err) {
      this.status = (err as Error).message
      this.snd.beep(220, 0.12)
    }
    this.paint()
  }

  /**
   * Delete the installed copy in ~/bin.
   *
   * Always a copy: the key is not offered on the reader's own program, so this
   * cannot remove the only version of anything, and Enter on the same row
   * reinstalls it. The confirmation is correspondingly brief.
   */
  private async uninstall(p: PublishedProgram): Promise<void> {
    const local = this.installed.get(p.id)
    if (!local) return

    const base = local.slice(local.lastIndexOf('/') + 1)
    const ok = await this.ask('DELETE', [
      `Remove ~/${local} from your home directory.`,
      '',
      base === p.name ? '' : `(installed from ${p.name})`,
      'You can install it again from here.',
    ].filter(line => line !== ''))
    if (!ok) {
      this.status = 'kept'
      this.paint()
      return
    }

    this.status = 'deleting…'
    this.paint()
    try {
      await fs.promises.unlink(paths.join(this.home, local)).catch(() => {})
      this.installed.delete(p.id)
      await writeInstalled(this.home, this.installed)
      this.status = `~/${local} deleted`
    } catch (err) {
      this.status = (err as Error).message
      this.snd.beep(220, 0.12)
    }
    this.paint()
  }

  // --- input ----------------------------------------------------------------

  silentKey(e: KeyInput): boolean {
    if (this.filtering) return false
    return ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)
  }

  /**
   * Synchronous, and every box is opened with void.
   *
   * A box is driven by the same key loop that opened it, so awaiting one here
   * would block the loop that has to deliver its keys and deadlock. An action
   * that ends the screen wakes the loop instead; see finish().
   */
  onKey(e: KeyInput): void {
    if (e.metaKey || e.altKey) return

    // Any key finishes the reveal and then acts as it normally would, rather
    // than being consumed to stop it and having to be pressed again. Checked
    // first: move() on a row that has not arrived would put the bar on an empty row.
    if (this.reveal.running) this.reveal.finish()

    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) return this.finish()

    // In filter mode every key is a character. That is why the sort keys are
    // single letters and the filter is a mode rather than an always-live field.
    if (this.filtering) {
      if (e.key === 'Enter') {
        this.filtering = false
        this.snd.blip(660, 0.06, 0)
        return this.paint()
      }
      if (e.key === 'Escape') {
        this.filtering = false
        this.filter = ''
        this.input.set('')
        this.apply()
        this.snd.blip(420, 0.09, 0)
        return this.paint()
      }
      if (this.input.onKey(e)) {
        this.filter = this.input.value
        this.apply()
      }
      return this.paint()
    }

    if (e.key === 'Escape' || e.key === 'q') return this.finish()
    if (e.key === '/') {
      this.filtering = true
      this.status = ''
      return this.paint()
    }

    if (e.key === 'ArrowDown' || e.key === 'j') { this.move(1); return this.paint() }
    if (e.key === 'ArrowUp' || e.key === 'k') { this.move(-1); return this.paint() }
    if (e.key === 'PageDown') { this.move(this.rows(this.s)); return this.paint() }
    if (e.key === 'PageUp') { this.move(-this.rows(this.s)); return this.paint() }
    if (e.key === 'Home') { this.move(-this.view.length); return this.paint() }
    if (e.key === 'End') { this.move(this.view.length); return this.paint() }

    // Both cases accepted: the hint rule prints the caps uppercase, so typing
    // what it shows should work. The sort keys are lowercase, so nothing collides.
    const key = e.key.toLowerCase()
    if (key === 'n') { this.setSort('name'); return this.paint() }
    if (key === 'a') { this.setSort('author'); return this.paint() }
    if (key === 'd') { this.setSort('publishedAt'); return this.paint() }

    const p = this.current
    if (e.key === ' ') {
      if (p) void this.about(p)
      return
    }
    if (key === 's') {
      if (p) void this.preview(p)
      return
    }
    if (key === 't') {
      if (p) void this.runTest(p)
      return
    }
    if (key === 'u') {
      if (p?.mine) void this.unpublish(p)
      else if (p) { this.status = 'not yours to unpublish'; this.paint() }
      return
    }
    // Backspace too: full keyboards send Delete and compact ones send Backspace
    // for the same physical key.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (p && !p.mine && this.installed.has(p.id)) void this.uninstall(p)
      else if (p?.mine) { this.status = 'your own — U unpublishes it, rm removes it'; this.paint() }
      else if (p) { this.status = 'not installed'; this.paint() }
      return
    }
    if (e.key === 'Enter') {
      if (p) void this.install(p)
      return
    }

    // Everything else is swallowed; an unhandled key would reach the shell
    // hidden behind this screen.
  }

  dispose(): void {
    this.reveal.stop()
  }
}

/**
 * Run a program once on the bare terminal.
 *
 * Written to /tmp rather than ~/bin, so an uninstalled program does not leave a
 * file among the reader's installed ones.
 */
async function runOnce(p: Proc, test: TestRun): Promise<void> {
  const path = paths.join('/tmp', test.name)
  await fs.promises.writeFile(path, test.bytes, { mode: 0o755 })
  try {
    const prog = await p.kernel.resolveExec(path, p.cwd, p.env)
    if (!prog) {
      p.err(`browse: ${test.name}: not a program\n`)
      return
    }
    const task = p.kernel.spawn(prog, {
      argv: [test.name],
      env: p.env,
      cwd: p.cwd,
      stdin: p.stdin,
      stdout: p.stdout,
      stderr: p.stderr,
      tty: p.tty,
    })
    const kill = () => task.kill()
    p.signal.addEventListener('abort', kill, { once: true })
    try {
      await task.wait
    } finally {
      p.signal.removeEventListener('abort', kill)
    }
  } finally {
    await fs.promises.unlink(path).catch(() => {})
  }
}

export function browseProgram(api: ApiClient, snd: ChatSound = SILENT): Program {
  return async p => {
    if (!api.authed) {
      p.err('browse: not logged in\n')
      return 1
    }
    const tty = p.tty
    if (!tty) {
      p.err('browse: no terminal\n')
      return 1
    }

    const store = new ProgramStore(api, p)
    p.setResume('browse')

    // A loop rather than a single screen because T runs a program and returns.
    // The program cannot run while the gallery holds the grid, so the alt screen
    // is left, the program runs on the bare terminal, and the gallery reopens.
    //
    // Ctrl-C during a test ends the whole command, as elsewhere: one abort
    // covers the run, so the program cannot be killed while keeping the gallery.
    for (;;) {
      const s = new Surface(tty.cols, tty.rows)
      const stack = new ScreenStack(s as never)
      const screen = new BrowseScreen(p, s, stack, store, snd)

      tty.setRaw()
      tty.silence(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])
      p.out('\x1b[?1049h')
      s.invalidate()

      try {
        screen.paint()
        void screen.load()
        while (!screen.done) {
          const chunk = await p.stdin.read()
          if (chunk === null) break
          for (const k of parseKeys(dec.decode(chunk))) {
            if (stack.active) {
              stack.key(k)
              tty.paint(s.render())
              continue
            }
            screen.onKey(k)
            if (screen.done) break
          }
        }
      } finally {
        screen.dispose()
        p.out('\x1b[?1049l\x1b[?25h')
        tty.setCooked()
      }

      const test = screen.test
      if (!test) return 0
      if (p.signal.aborted) return 130

      p.out(`\x1b[2mrunning ${test.name}…\x1b[0m\n`)
      await runOnce(p, test)
      if (p.signal.aborted) return 130

      // Hold the screen until a key. Written straight to the pty rather than
      // through the Surface, whose repaint would overwrite the output the
      // program just wrote to the scrollback.
      const hold = ' Any key returns to USER PROGRAMS '
      p.out(`\x1b[2m\x1b[7m${hold}\x1b[0m\n`)
      tty.setRaw()
      const key = await p.stdin.read()
      tty.setCooked()
      if (key === null || p.signal.aborted) return 130
    }
  }
}
