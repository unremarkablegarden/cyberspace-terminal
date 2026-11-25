// directory(1): the members with a profile picture, as a grid of portraits.
//
// The list is GET /v1/directory, a page of PAGE at a time in the chosen order
// and filtered by the search on the server. The next page is read when the
// rows fetched ahead reach the end of what is loaded. Pages read are kept for
// CACHE_MS across runs, so reopening the program or going back to an order
// reads nothing. A search is sent SEARCH_MS after the last key.
//
// Pictures are fetched by this program, LOADS at a time, for the rows on
// screen and PREFETCH rows below, so a step down onto the next row finds it
// already drawn. The bank keeps what ensure() last named; only pictures that
// have arrived are named, so ensure() never starts a fetch of its own.
//
// The first screen is held until its pictures are in (or FIRST_WAIT_MS has
// passed), then drawn tile by tile, REVEAL_MS apart. A member whose picture
// cannot be read is dropped from the grid when the fetch fails. Enter opens
// the member's card (card.ts), which carries C-Mail, follow and poke.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, Spinner, TextPopup, ConfirmPopup, SelectPopup, YES_NO,
  frame, label, cells, parseKeys, keyHint,
  NORMAL, BRIGHT, BOLD, DIM, BG,
  type Rect, type Span, type TextLine,
} from '@cyberspace/tui'
import type { ApiClient } from './api.js'
import { SILENT, type ChatSound, type ChatPictures } from './chat.js'
import { MemberCard } from './card.js'

/** One row of GET /v1/directory. */
export interface DirectoryEntry {
  username: string
  userId: string
  picture: string
  /** ms since epoch, 0 when unknown. */
  joined: number
  serial?: number
}

/** The part of the host's picture bank the directory uses. See app/src/image.ts. */
export type DirectoryPixels = Pick<ChatPictures, 'picture' | 'slot' | 'load' | 'ensure' | 'release'>

type Sort = 'new' | 'old' | 'name' | 'eman' | 'random'
const SORTS: Sort[] = ['new', 'old', 'name', 'eman', 'random']
const SORT_LABEL: Record<Sort, string> = { new: 'NEW', old: 'OLD', name: 'A-Z', eman: 'Z-A', random: 'RANDOM' }
/** Rows of the sort box, in SORTS order. */
const SORT_ITEMS = ['Newest first', 'Oldest first', 'Name A-Z', 'Name Z-A', 'Random']

interface DirectoryState {
  v: number
  sort: Sort
  seed: number
  sel?: string
  query?: string
}

/** A list read so far: the rows in order, and the cursor of the next page, null after the last. */
interface Pages {
  at: number
  rows: DirectoryEntry[]
  cursor: string | null
}

const STATE_VERSION = 2
/** Rows per page read. Three screens or more at 80x25. */
const PAGE = 60
/** How long pages read are reused, ms. The server's list is as old as five minutes anyway. */
const CACHE_MS = 5 * 60_000
/** Quiet after the last search key before the search is sent, ms. */
const SEARCH_MS = 150
/** Picture box per tile, in cells, at most. The rows are the slot a square picture takes at this width. */
const THUMB_COLS = 12
const THUMB_ROWS = 8
/** Narrowest picture box. */
const THUMB_MIN_COLS = 4
/** Tile rows the grid holds at least: the picture shrinks until they fit. */
const MIN_ROWS = 3
/** Picture fetches in flight at once. */
const LOADS = 6
/** Rows below the screen whose pictures are fetched ahead. */
const PREFETCH = 2
/** Longest wait for the first screen's pictures before it is drawn anyway, ms. */
const FIRST_WAIT_MS = 6000
/** Between tiles of the first screen's reveal, ms. */
const REVEAL_MS = 25

const HINT_FIND: Span[] = [{ text: ' / ', inverse: true, attr: DIM }, { text: ' Find ' }]
const HINT_PROFILE: Span[] = [{ text: ' ↵ ', inverse: true, attr: DIM }, { text: ' Profile ' }]
const HINT_CLEAR: Span[] = [{ text: ' ESC ', inverse: true, attr: DIM }, { text: ' Clear ' }]
const HINT_EXIT: Span[] = [{ text: ' ESC ', inverse: true, attr: DIM }]
/** The current order is on the top rule, so the key is not labelled with it. */
const HINT_SORT: Span[] = [{ text: ' S ', inverse: true, attr: DIM }, { text: ' Sort ' }]

function readState(raw: unknown): Partial<DirectoryState> {
  if (!raw || typeof raw !== 'object') return {}
  const s = raw as Record<string, unknown>
  if (s.v !== STATE_VERSION) return {}
  return {
    sort: SORTS.includes(s.sort as Sort) ? s.sort as Sort : undefined,
    seed: typeof s.seed === 'number' ? s.seed >>> 0 : undefined,
    sel: typeof s.sel === 'string' ? s.sel : undefined,
    query: typeof s.query === 'string' ? s.query : undefined,
  }
}

/**
 * The store programs' localStorage is kept in, one per program name (the
 * compat host's `storage`; a file in the home on the web host). The order
 * and the search are kept there across runs. The parked state, which covers a
 * resume or a job switch, takes precedence. Absent on a host with none.
 */
export interface DirectoryStorage {
  load(name: string): Promise<Record<string, string>>
  save(name: string, data: Record<string, string>): Promise<void>
}

const STORE_NAME = 'directory'

/** Cut to `w` cells and centre in them. */
const centre = (text: string, w: number): string => {
  const t = text.length > w ? text.slice(0, w) : text
  return ' '.repeat(Math.floor((w - cells(t)) / 2)) + t
}

export function directoryProgram(api: ApiClient, pixels: () => DirectoryPixels, snd: ChatSound = SILENT, storage?: DirectoryStorage): Program {
  /** Lists read, by sort, seed and search. Shared by every run. */
  const cache = new Map<string, Pages>()
  return async (p: Proc) => {
    if (!p.tty) { p.err('directory: no tty\n'); return 1 }
    if (!api.authed) { p.err('directory: not logged in\n'); return 1 }
    const tty = p.tty
    const cols = tty.cols
    const rows = tty.rows
    const s = new Surface(cols, rows)
    const stack = new ScreenStack(s as never)
    const pics = pixels()

    const outer: Rect = { x: 0, y: 0, w: cols, h: rows }
    const inner: Rect = { x: 1, y: 1, w: cols - 2, h: rows - 2 }
    const grid = inner

    const parked = readState(p.takeState())
    const kept = await storage?.load(STORE_NAME).catch(() => ({} as Record<string, string>)) ?? {}
    const saved = kept.sort as Sort
    let sort: Sort = parked.sort ?? (SORTS.includes(saved) ? saved : 'new')
    /** Shuffle seed for random, sent with every page so they line up. A new run without a parked state gets a new shuffle. */
    let seed = parked.seed ?? Math.floor(Math.random() * 2 ** 32)
    let query = parked.query ?? kept.query ?? ''
    let searching = false
    /** The list for the current sort and search, as far as it is read. What the grid shows. */
    let list: Pages = { at: 0, rows: [], cursor: '0' }
    let view: DirectoryEntry[] = []
    /** A page read is in flight. */
    let fetching = false
    /** The last page read failed; nothing more is read until the list is replaced. */
    let listFailed = false
    /** Bumped when the list is replaced, so a page for the old one is dropped. */
    let gen = 0
    let searchTimer: ReturnType<typeof setTimeout> | undefined
    let sel = 0
    /** First grid row on screen. */
    let top = 0
    let status = 'LOADING'
    /** 'list' until the list arrives, 'first' while the first screen's pictures load, 'reveal' while it is drawn in. */
    let phase: 'list' | 'first' | 'reveal' | 'ready' = 'list'
    /** Tiles of the first screen drawn so far, during the reveal. */
    let revealed = 0
    let revealTimer: ReturnType<typeof setInterval> | undefined
    let firstTimer: ReturnType<typeof setTimeout> | undefined
    let running = true
    let quit = false
    const inflight = new Set<string>()
    const broken = new Set<string>()
    /** Pictures that did not fit the bank. Tried again after the next scroll, when the rows on screen have changed. */
    const full = new Set<string>()
    /** The first row of the last pump; `full` is cleared when it moves. */
    let pumpedTop = -1

    /**
     * Tile geometry, from the face's metrics: F1 can change the font under a
     * running program. A tile is its frame, the picture and the name under it.
     * Tile rows share the frame row between them, so a row costs the picture
     * plus 2, and the grid one more for the last bottom edge. The picture is
     * cut to MIN_ROWS rows' worth, and its width to what a square takes at
     * that height.
     */
    const layout = () => {
      const fit = Math.floor((grid.h - 1) / MIN_ROWS) - 2
      const picRows = Math.max(2, Math.min(THUMB_ROWS, pics.slot(THUMB_COLS, THUMB_ROWS, 1), fit))
      let thumbCols = THUMB_COLS
      while (thumbCols > THUMB_MIN_COLS && pics.slot(thumbCols, THUMB_ROWS, 1) > picRows) thumbCols--
      const tileW = thumbCols + 2
      const pitch = picRows + 2
      const perRow = Math.max(1, Math.floor(grid.w / tileW))
      const visRows = Math.max(1, Math.floor((grid.h - 1) / pitch))
      // Profile pictures are square (the site crops them to 128x128): this is the box one fills.
      const squareRows = Math.min(picRows, pics.slot(thumbCols, picRows, 1))
      return { thumbCols, picRows, squareRows, tileW, pitch, perRow, visRows, left: Math.floor((grid.w - perRow * tileW) / 2) }
    }
    type Layout = ReturnType<typeof layout>

    const picture = (e: DirectoryEntry, g: Layout) => pics.picture(e.picture, g.thumbCols, g.picRows)

    /** Tiles on the screen now, in view order. */
    const onScreen = (): DirectoryEntry[] => {
      const { perRow, visRows } = layout()
      return view.slice(top * perRow, (top + visRows) * perRow)
    }

    /**
     * Start fetches for the screen and the rows ahead, and name what has
     * arrived to the bank so it is kept.
     */
    const pump = (): void => {
      const g = layout()
      const { perRow, visRows, picRows, thumbCols } = g
      if (top !== pumpedTop) { full.clear(); pumpedTop = top }
      const end = (top + visRows + PREFETCH) * perRow
      if (end >= view.length) more()
      const want = view.slice(top * perRow, end)
      pics.ensure(want.filter(e => picture(e, g)).map(e => e.picture), thumbCols, picRows)
      for (const e of want) {
        if (inflight.size >= LOADS) break
        const src = e.picture
        if (inflight.has(src) || broken.has(src) || full.has(src) || picture(e, g)) continue
        inflight.add(src)
        pics.load(src, src, thumbCols, picRows)
          .catch((err: unknown) => {
            // A full bank is not the picture's fault: other programs' pictures and ranges share it.
            if (err instanceof Error && err.message === 'no room') { full.add(src); return }
            console.error('directory: picture failed', src, err)
            broken.add(src)
          })
          .finally(() => {
            inflight.delete(src)
            if (!running) return
            if (broken.has(src)) dropBroken()
            pump()
            landed()
          })
      }
    }

    /** Take members with an unreadable picture out of the grid. The selected member stays selected. */
    const dropBroken = (): void => {
      const was = view[sel]
      view = view.filter(e => !broken.has(e.picture))
      const i = was ? view.indexOf(was) : -1
      sel = i >= 0 ? i : Math.max(0, Math.min(sel, view.length - 1))
      const { perRow } = layout()
      top = Math.min(top, Math.floor(sel / perRow))
    }

    const firstDone = (): boolean => {
      const g = layout()
      return onScreen().every(e => full.has(e.picture) || picture(e, g))
    }

    const startReveal = (): void => {
      if (phase !== 'first') return
      clearTimeout(firstTimer)
      phase = 'reveal'
      status = ''
      revealed = 0
      const total = onScreen().length
      revealTimer = setInterval(() => {
        revealed++
        if (revealed >= total) finishReveal()
        paint()
      }, REVEAL_MS)
    }

    const finishReveal = (): void => {
      clearInterval(revealTimer)
      revealTimer = undefined
      if (phase === 'reveal') phase = 'ready'
    }

    /** A picture arrived or failed. */
    const landed = (): void => {
      if (phase === 'first') { if (firstDone()) startReveal(); return }
      if (phase !== 'reveal') paint()
    }

    const park = (): void => {
      p.setState({
        v: STATE_VERSION, sort, seed,
        ...(view[sel] && { sel: view[sel]!.username }),
        ...(query && { query }),
      } satisfies DirectoryState)
    }

    const spinner = new Spinner({ onTick: () => paint() })

    const paint = (): void => {
      if (stack.active) return
      draw()
      tty.paint(s.render())
    }

    const members = new MemberCard({
      api, proc: p, snd, stack, bounds: inner, pics,
      paint,
      footer: () => drawFooter(),
      flush: () => tty.paint(s.render()),
      invalidate: () => s.invalidate(),
      status: text => { status = text },
      live: () => running,
    })

    /** Scroll so the selection is on screen, and fetch for the new rows. */
    const reveal = (): void => {
      const { perRow, visRows } = layout()
      const row = Math.floor(sel / perRow)
      if (row < top) top = row
      else if (row >= top + visRows) top = row - visRows + 1
      pump()
    }

    /** What was last written to the store, so an unchanged list writes nothing. */
    let remembered = JSON.stringify({ sort: kept.sort ?? '', query: kept.query ?? '' })
    const remember = (): void => {
      const next = JSON.stringify({ sort, query })
      if (next === remembered) return
      remembered = next
      void storage?.save(STORE_NAME, { sort, query }).catch(() => {})
    }

    const listKey = (): string => `${sort}|${sort === 'random' ? seed : 0}|${query.trim().toLowerCase()}`

    /** Read the next page of the current list, unless one is in flight or the list is complete. */
    const more = (): void => {
      if (fetching || listFailed || list.cursor === null) return
      fetching = true
      const mine = gen
      const pages = list
      const params = new URLSearchParams({ sort, limit: String(PAGE), cursor: pages.cursor! })
      if (sort === 'random') params.set('seed', String(seed))
      if (query.trim()) params.set('q', query.trim())
      api.page<DirectoryEntry>(`/v1/directory?${params}`).then(res => {
        if (!running || mine !== gen) return
        fetching = false
        const rows = res.rows.filter(r => typeof r.username === 'string' && typeof r.picture === 'string' && r.picture)
        pages.rows.push(...rows)
        pages.cursor = res.cursor
        pages.at = Date.now()
        view.push(...rows.filter(e => !broken.has(e.picture)))
        if (status === 'LOADING') status = ''
        listed()
      }).catch(() => {
        if (!running || mine !== gen) return
        fetching = false
        listFailed = true
        status = 'directory: NO CARRIER'
        paint()
      })
      if (!view.length) status = 'LOADING'
      paint()
    }

    /**
     * Replace the list for a new sort or search, from the cache when it is
     * fresh. The selection goes to the first tile.
     */
    const relist = (): void => {
      remember()
      gen++
      fetching = false
      listFailed = false
      const key = listKey()
      const have = cache.get(key)
      if (!have || Date.now() - have.at > CACHE_MS) cache.set(key, { at: Date.now(), rows: [], cursor: '0' })
      list = cache.get(key)!
      view = list.rows.filter(e => !broken.has(e.picture))
      sel = 0
      top = 0
      if (status === 'LOADING') status = ''
      pump()
    }

    /** Rows arrived. The first rows of the run start the first screen's wait; later ones extend the grid. */
    const listed = (): void => {
      if (phase === 'list') {
        if (parked.sel) {
          const i = view.findIndex(x => x.username === parked.sel)
          if (i >= 0) sel = i
        }
        phase = 'first'
        status = 'LOADING'
        reveal()
        if (firstDone()) startReveal()
        else firstTimer = setTimeout(startReveal, FIRST_WAIT_MS)
        paint()
        return
      }
      pump()
      if (phase !== 'reveal') paint()
    }

    /** The search changed: sent once the keys stop. */
    const searchChanged = (): void => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => { if (running) { relist(); paint() } }, SEARCH_MS)
    }

    const drawTile = (e: DirectoryEntry, i: number, g: Layout): void => {
      const row = Math.floor(i / g.perRow) - top
      const col = i % g.perRow
      const x = grid.x + g.left + col * g.tileW
      const y = grid.y + row * g.pitch
      const on = i === sel
      if (on) frame(s, { x, y, w: g.tileW, h: g.pitch + 1 }, BRIGHT)
      const pic = picture(e, g)
      if (pic) {
        const dx = Math.floor((g.thumbCols - pic.cols) / 2)
        const dy = Math.floor((g.picRows - pic.rows) / 2)
        pic.lines.forEach((line, r) => s.text(x + 1 + dx, y + 1 + dy + r, line, NORMAL))
      } else {
        placeholder(x, y, g)
      }
      s.text(x + 1, y + 1 + g.picRows, centre(e.username, g.thumbCols), on ? BRIGHT | BOLD : DIM)
    }

    /**
     * The picture's box before the picture: the square it will fill, lit at
     * the ground level (BG, the popups' panel fill, the dimmest there is),
     * placed where drawTile centres it, so nothing moves when it lands.
     */
    const placeholder = (x: number, y: number, g: Layout): void => {
      s.fill({ x: x + 1, y: y + 1 + Math.floor((g.picRows - g.squareRows) / 2), w: g.thumbCols, h: g.squareRows }, ' ', BG)
    }

    const draw = (): void => {
      const g = layout()
      s.clear()
      frame(s, outer, DIM)

      if (phase === 'reveal' || phase === 'ready') {
        const first = top * g.perRow
        const last = Math.min(view.length, (top + g.visRows) * g.perRow)
        for (let i = first; i < last; i++) {
          if (phase === 'reveal' && i - first >= revealed) break
          drawTile(view[i]!, i, g)
        }
        // Slots on screen past the rows read, while more are on the way: empty boxes.
        if (phase === 'ready' && fetching) {
          const end = (top + g.visRows) * g.perRow
          for (let i = Math.max(first, view.length); i < end; i++) {
            const row = Math.floor(i / g.perRow) - top
            placeholder(grid.x + g.left + (i % g.perRow) * g.tileW, grid.y + row * g.pitch, g)
          }
        }
        if (!view.length && phase === 'ready' && list.cursor === null) s.text(grid.x + 1, grid.y, query ? 'No match' : 'No members', DIM)
      }

      // Beside the title: the search as typed, then a spinner while anything is read, then an action's result.
      const busy = status === 'LOADING' || fetching
      if (busy) spinner.start()
      else spinner.stop()
      const note: Span[] = [
        ...(searching || query
          ? [{ text: '  /', attr: DIM }, { text: query.slice(-(inner.w - 50)), attr: BRIGHT }, ...(searching ? [{ text: ' ', inverse: true }] : [])]
          : []),
        ...(busy ? [{ text: '  ' }, { text: spinner.text('LOADING'), attr: DIM }] : []),
        ...(status && status !== 'LOADING' ? [{ text: '  ' }, { text: status }] : []),
      ]
      label(s, outer, [{ text: 'DIRECTORY', attr: BOLD }, ...note])
      label(s, outer, [
        { text: ` ${SORT_LABEL[sort]} `, inverse: true, attr: DIM },
        { text: '  ' }, ...HINT_EXIT,
      ], { align: 'right' })

      drawFooter()
      s.showCursor = false
      park()
    }

    /**
     * The bottom rule: the card's keys while it is open, the search's while
     * typing, otherwise the grid's.
     * Groups go from the front until the rest fits.
     */
    const drawFooter = (): void => {
      const open = members.card?.profile
      const e = view[sel]
      const groups: Span[][] = open
        ? members.hints(open)
        : searching
          ? [HINT_CLEAR, HINT_PROFILE]
          : [HINT_SORT, HINT_FIND, ...(e ? [HINT_PROFILE] : [])]
      const width = (g: Span[][]): number => g.flat().reduce((n, sp) => n + cells(sp.text), 2)
      const budget = cols - 2
      while (groups.length > 1 && width(groups) > budget) groups.shift()
      s.text(outer.x + 1, outer.y + outer.h - 1, '─'.repeat(outer.w - 2), DIM)
      label(s, outer, groups.flat(), { edge: 'bottom', align: 'right', max: budget })
    }

    const confirmQuit = (): void => {
      stack.push(new ConfirmPopup({
        title: 'EXIT',
        lines: ['Quit the directory?'],
        hint: YES_NO,
        bounds: inner,
        shadow: true,
        onFeedback: kind => { if (kind !== 'inert') snd.blip(420, 0.09, 0) },
        onDone: yes => {
          stack.pop()
          s.invalidate()
          if (yes) quit = true
          else paint()
        },
      }))
      tty.paint(s.render())
    }

    /** The order, chosen from a list. Random chosen again is a new shuffle. */
    const openSort = (): void => {
      stack.push(new SelectPopup({
        title: 'SORT',
        items: SORT_ITEMS,
        selected: SORTS.indexOf(sort),
        keys: SORTS.map((_, i) => String(i + 1)),
        hint: '↵ Sort  ESC Cancel',
        bounds: inner,
        shadow: true,
        silentChoose: true,
        onFeedback: kind => {
          if (kind === 'edge') snd.beep(220, 0.04)
          else if (kind === 'move') snd.tick()
          else if (kind === 'cancel') snd.blip(390, 0.07, 0)
        },
        onDone: (item, i) => {
          stack.pop()
          s.invalidate()
          if (item !== null) {
            snd.blip(520, 0.09, 0)
            sort = SORTS[i]!
            if (sort === 'random') seed = Math.floor(Math.random() * 2 ** 32)
            relist()
          }
          paint()
        },
      }))
      tty.paint(s.render())
    }

    const openHelp = (): void => {
      const keys: [string, string][] = [
        ['←↑↓→', 'Move'], ['PGUP PGDN', 'A screen up, down'], ['HOME END', 'First, last'],
        ['↵', 'Profile'], ['C F P', 'On the profile: C-Mail, follow, poke'],
        ['S', 'Sort'], ['/', 'Find'], ['ESC', 'Clear the find; then exit'], ['Q', 'Exit'],
      ]
      stack.push(new TextPopup({
        title: 'DIRECTORY',
        lines: keys.map(([k, what]): TextLine => keyHint([[k.padEnd(9), what]])),
        hint: 'ESC Close',
        bounds: inner,
        shadow: true,
        onFeedback: kind => { if (kind === 'edge') snd.beep(220, 0.04) },
        onDone: () => {
          stack.pop()
          s.invalidate()
          paint()
        },
      }))
      tty.paint(s.render())
    }

    /** Move the selection to `to`, clamped. A move that goes nowhere beeps. */
    const moveTo = (to: number): void => {
      const next = Math.max(0, Math.min(view.length - 1, to))
      if (!view.length || next === sel) { snd.beep(220, 0.04); return }
      sel = next
      if (!searching) status = ''
      reveal()
    }

    /** Keys that move the selection, shared by the grid and the search line. True when handled. */
    const moveKey = (key: string): boolean => {
      const { perRow, visRows } = layout()
      const col = sel % perRow
      switch (key) {
        case 'ArrowLeft': if (col === 0) snd.beep(220, 0.04); else moveTo(sel - 1); return true
        case 'ArrowRight':
          if (col === perRow - 1 || sel === view.length - 1) snd.beep(220, 0.04)
          else moveTo(sel + 1)
          return true
        case 'ArrowUp': if (sel < perRow) snd.beep(220, 0.04); else moveTo(sel - perRow); return true
        // Onto the next row; a short last row takes its last tile.
        case 'ArrowDown':
          if (Math.floor(sel / perRow) === Math.floor((view.length - 1) / perRow)) snd.beep(220, 0.04)
          else moveTo(sel + perRow)
          return true
        case 'PageUp': moveTo(sel - perRow * visRows); return true
        case 'PageDown': moveTo(sel + perRow * visRows); return true
        case 'Home': moveTo(0); return true
        case 'End': moveTo(view.length - 1); return true
      }
      return false
    }

    const openCard = (): void => {
      const e = view[sel]
      if (!e) { snd.beep(220, 0.04); return }
      void members.open(e.username)
    }

    const searchKey = (k: { key: string; ctrlKey: boolean }): void => {
      if (moveKey(k.key)) { paint(); return }
      switch (k.key) {
        case 'Escape':
          searching = false
          if (query) { query = ''; clearTimeout(searchTimer); relist() }
          break
        case 'Enter':
          searching = false
          paint()
          openCard()
          return
        case 'Backspace':
          if (!query) { snd.beep(220, 0.04); break }
          query = query.slice(0, -1)
          searchChanged()
          break
        default:
          if (k.ctrlKey && k.key === 'u') { query = ''; searchChanged(); break }
          if (k.ctrlKey || [...k.key].length !== 1) return
          query += k.key
          searchChanged()
      }
      paint()
    }

    const onKey = (k: { key: string; ctrlKey: boolean }): 'quit' | void => {
      if (phase !== 'ready' && phase !== 'reveal') {
        if (k.key === 'q' || k.key === 'Q') return 'quit'
        if (k.key === 'Escape') confirmQuit()
        return
      }
      // A key during the reveal ends it.
      if (phase === 'reveal') finishReveal()
      if (searching) { searchKey(k); return }
      if (moveKey(k.key)) { paint(); return }
      switch (k.key) {
        case 'q': case 'Q': return 'quit'
        case 'Escape':
          if (query) { query = ''; relist(); break }
          confirmQuit()
          return
        case 'Enter': openCard(); return
        case 's': case 'S': openSort(); return
        case '/': searching = true; status = ''; break
        case '?': openHelp(); return
        default: return
      }
      paint()
    }

    tty.setRaw()
    tty.silence(['Enter'])
    p.out('\x1b[?1049h')
    s.invalidate()
    p.setResume('directory')

    p.onStop = () => {
      // Back from a stop, the screen is drawn whole.
      if (phase === 'reveal') finishReveal()
      spinner.stop()
    }
    p.onCont = () => {
      s.invalidate()
      paint()
      pump()
    }
    try {
      relist()
      // A list from the cache needs no read.
      if (view.length) listed()
      paint()

      for (;;) {
        const chunk = await tty.stdin.read()
        if (chunk === null) return 0
        for (const k of parseKeys(dec.decode(chunk))) {
          if (k.ctrlKey && k.key === 'c') return 130
          if (stack.active) {
            stack.key(k)
            if (quit) return 0
            tty.paint(s.render())
            continue
          }
          if (onKey(k) === 'quit') return 0
        }
      }
    } finally {
      running = false
      clearInterval(revealTimer)
      clearTimeout(firstTimer)
      clearTimeout(searchTimer)
      spinner.stop()
      pics.release()
      p.out('\x1b[?1049l\x1b[?25h')
      tty.setCooked()
    }
  }
}
