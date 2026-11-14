// chess(0): the faceplate's small board game.
//
// The game has two screens: a title card with the machine and two-player
// choices, and the board itself. Both draw on the CRT grid through the screen
// stack, so they cover the pty without writing escape codes into it.
//
// The player is white and the machine is black. Arrow keys move a cursor over
// the board, Enter picks up a piece, and the squares the piece can reach are
// marked. Enter on a marked square plays the move. The rules and the machine
// search live in chess/rules.ts; this file only turns keys into moves and moves
// into cells.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { RENDER } from '@cyberspace/crt/config'
import {
  BG, BOLD, BRIGHT, DIM, MUTED, NORMAL, ScreenStack, clear, frame,
  type Grid, type KeyInput, type Rect, type Screen,
} from '@cyberspace/tui'
import { grid } from './grid'
import type { Overlay } from './input'
import {
  applyMove, chooseMachineMove, getMoves, getPiece, isCheck, newChessState,
  resultOf, sameSquare,
  type Move, type Piece, type Square,
} from './chess/rules'
import bishopSvg from './chess/svg/bishop.svg?raw'
import blackBishopSvg from './chess/svg/black-bishop.svg?raw'
import blackKingSvg from './chess/svg/black-king.svg?raw'
import blackKnightSvg from './chess/svg/black-knight.svg?raw'
import blackPawnSvg from './chess/svg/black-pawn.svg?raw'
import blackQueenSvg from './chess/svg/black-queen.svg?raw'
import blackRookSvg from './chess/svg/black-rook.svg?raw'
import kingSvg from './chess/svg/king.svg?raw'
import knightSvg from './chess/svg/knight.svg?raw'
import logoSvg from './chess/svg/logo.svg?raw'
import pawnSvg from './chess/svg/pawn.svg?raw'
import queenSvg from './chess/svg/queen.svg?raw'
import rookSvg from './chess/svg/rook.svg?raw'

type Mode = 'menu' | 'board'

const MENU = ['Play with Machine', 'Play with someone']
const MACHINE_DELAY = 350
const LOGO_W = 19
const LOGO_H = 10
type PieceArt = `${Piece['color']}-${Piece['kind']}`
type ArtName = 'logo' | PieceArt

const SVG_SOURCE: Record<ArtName, string> = {
  logo: logoSvg,
  'white-king': kingSvg,
  'white-queen': queenSvg,
  'white-rook': rookSvg,
  'white-bishop': bishopSvg,
  'white-knight': knightSvg,
  'white-pawn': pawnSvg,
  'black-king': blackKingSvg,
  'black-queen': blackQueenSvg,
  'black-rook': blackRookSvg,
  'black-bishop': blackBishopSvg,
  'black-knight': blackKnightSvg,
  'black-pawn': blackPawnSvg,
}

/** The game overlay. It is both the host's overlay and the screen on the stack. */
export class Chess implements Overlay, Screen {
  private stack: ScreenStack | null = null
  private cursorWas = true
  private mode: Mode = 'menu'
  private menuIndex = 0
  private state = newChessState()
  private cursor: Square = { row: 6, col: 4 }
  private selected: Square | null = null
  private moves: Move[] = []
  private thinking = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private note = ''
  private art: Partial<Record<ArtName, ImageBitmap>> = {}
  private artLoading = false
  private artLoaded = false

  constructor(private screen: CrtScreen, private snd: Sound) {}

  get open(): boolean {
    return !!this.stack?.active
  }

  /** Open the title card. The picker calls this after its own screen is gone. */
  start(): void {
    if (this.open || grid.locked) return
    this.ensureArt()
    this.stack ??= new ScreenStack(this.screen.term as never)
    grid.lock()
    this.cursorWas = RENDER.cursor
    RENDER.cursor = false
    this.mode = 'menu'
    this.menuIndex = 0
    this.note = ''
    this.snd.tick()
    this.stack.push(this)
  }

  /** Keys reach the overlay through Keyboard's route, as the config box and DOOM do. */
  key(k: KeyInput): void {
    this.stack?.key(k)
  }

  silentKey(k: KeyInput): boolean {
    if (k.metaKey || k.ctrlKey || k.altKey) return false
    return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'n', 'N'].includes(k.key)
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (this.mode === 'menu') return this.menuKey(e)
    return this.boardKey(e)
  }

  draw(term: Grid): void {
    clear(term, { x: 0, y: 0, w: term.cols, h: term.rows })
    if (this.mode === 'menu') this.drawMenu(term)
    else this.drawBoard(term)
    term.showCursor = false
    term.dirty = true
  }

  private menuKey(e: KeyInput): boolean {
    if (e.key === 'Escape') {
      this.close()
      return true
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const step = e.key === 'ArrowUp' ? -1 : 1
      this.menuIndex = (this.menuIndex + step + MENU.length) % MENU.length
      this.snd.tick()
      return true
    }
    if (e.key !== 'Enter') return false
    if (this.menuIndex === 0) {
      this.newGame()
      return true
    }
    // Keep the reserved second option on the title card.
    this.snd.beep(220, 0.04)
    return true
  }

  private boardKey(e: KeyInput): boolean {
    if (e.key === 'Escape') {
      this.toMenu()
      return true
    }
    if (e.key === 'n' || e.key === 'N') {
      this.newGame()
      return true
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.moveCursor(e.key)
      return true
    }
    if (e.key === 'Enter') {
      this.chooseSquare()
      return true
    }
    return false
  }

  private moveCursor(key: string): void {
    const step = key === 'ArrowUp' ? { row: -1, col: 0 }
      : key === 'ArrowDown' ? { row: 1, col: 0 }
      : key === 'ArrowLeft' ? { row: 0, col: -1 }
      : { row: 0, col: 1 }
    const row = Math.min(7, Math.max(0, this.cursor.row + step.row))
    const col = Math.min(7, Math.max(0, this.cursor.col + step.col))
    if (row === this.cursor.row && col === this.cursor.col) {
      this.snd.beep(220, 0.03)
      return
    }
    this.cursor = { row, col }
    this.snd.tick()
  }

  private chooseSquare(): void {
    if (this.thinking || resultOf(this.state).over) {
      this.snd.beep(220, 0.04)
      return
    }

    const piece = getPiece(this.state, this.cursor)
    if (this.selected) {
      const move = this.moves.find(candidate => sameSquare(candidate.to, this.cursor))
      if (move) {
        this.playMove(move)
        return
      }
      if (piece?.color === this.state.turn) {
        this.select(this.cursor)
        return
      }
      this.clearSelection()
      this.snd.beep(220, 0.04)
      return
    }

    if (piece?.color === this.state.turn) this.select(this.cursor)
    else this.snd.beep(220, 0.04)
  }

  private select(square: Square): void {
    if (this.selected && sameSquare(this.selected, square)) {
      this.clearSelection()
      return
    }
    this.selected = square
    this.moves = getMoves(this.state, square)
    this.snd.tick()
  }

  private clearSelection(): void {
    this.selected = null
    this.moves = []
  }

  private playMove(move: Move): void {
    this.state = applyMove(this.state, move)
    this.cursor = move.to
    this.clearSelection()
    this.snd.tick()

    const result = resultOf(this.state)
    if (result.over) {
      this.note = result.text
      return
    }
    if (this.state.turn === 'black') this.startMachine()
  }

  private startMachine(): void {
    this.thinking = true
    this.note = 'machine is thinking...'
    this.repaint()
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.open || this.mode !== 'board') return
      const move = chooseMachineMove(this.state)
      this.thinking = false
      if (!move) {
        this.note = resultOf(this.state).text
      } else {
        this.state = applyMove(this.state, move)
        this.cursor = move.to
        this.snd.tick()
        const result = resultOf(this.state)
        this.note = result.over ? result.text : ''
      }
      this.repaint()
    }, MACHINE_DELAY)
  }

  private newGame(): void {
    this.stopTimer()
    this.state = newChessState()
    this.cursor = { row: 6, col: 4 }
    this.clearSelection()
    this.thinking = false
    this.note = ''
    this.mode = 'board'
    this.snd.tick()
    this.repaint()
  }

  private toMenu(): void {
    this.stopTimer()
    this.mode = 'menu'
    this.thinking = false
    this.clearSelection()
    this.note = ''
    this.menuIndex = 0
    this.snd.blip(420, 0.09, 0)
    this.repaint()
  }

  private close(): void {
    this.stopTimer()
    while (this.stack?.active) this.stack.pop()
    grid.unlock()
    RENDER.cursor = this.cursorWas
    this.snd.blip(420, 0.09, 0)
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private repaint(): void {
    if (!this.open || this.stack?.top !== this) return
    this.screen.term.dirty = true
    this.draw(this.screen.term as never)
  }

  private ensureArt(): void {
    if (this.artLoading || this.artLoaded) return
    this.artLoading = true
    void Promise.all((Object.keys(SVG_SOURCE) as ArtName[]).map(async name => {
      const image = await loadSvg(name)
      if (image) this.art[name] = image
    })).finally(() => {
      this.artLoading = false
      this.artLoaded = true
      this.repaint()
    })
  }

  private drawMenu(term: Grid): void {
    const logoY = Math.max(1, Math.floor((term.rows - LOGO_H - 8) / 2))
    this.drawLogo(term, logoY)

    const nameY = logoY + LOGO_H + 1
    center(term, nameY, 'CHESS', BOLD | BRIGHT)
    const optionY = nameY + 2
    MENU.forEach((label, index) => {
      const text = ` ${label} `
      const x = Math.max(0, Math.floor((term.cols - text.length) / 2))
      term.text(x, optionY + index * 2, text, BOLD, index === this.menuIndex ? 1 : 0)
    })
    center(term, term.rows - 2, 'ARROWS move  ENTER choose  ESC close', MUTED)
  }

  private drawLogo(term: Grid, y: number): void {
    const width = Math.min(LOGO_W, term.cols)
    const height = Math.min(LOGO_H, term.rows - y)
    const x = Math.max(0, Math.floor((term.cols - width) / 2))
    const image = this.art.logo
    if (image) drawSvg(term, image, x, y, width, height, BOLD | BRIGHT)
  }

  private drawBoard(term: Grid): void {
    const wide = term.cols >= 76 && term.rows >= 24
    // Wide screens put controls and status beside the board.
    const large = wide && term.cols >= 120 && term.rows >= 36
    const squareH = large ? 3 : wide ? 2 : 1
    const metrics = term as Grid & { font?: { cellW: number; cellH: number }; advance?: number; stretch?: number }
    const cellW = metrics.font?.cellW ?? 8
    const cellH = metrics.font?.cellH ?? 16
    const advance = metrics.advance ?? cellW + 1
    const stretch = metrics.stretch ?? 1
    // Match each terminal square to the CRT's physical pixel aspect. An odd
    // width also gives every file label a true center cell.
    const idealSquareW = squareH * cellH * stretch / advance
    const squareW = wide ? Math.max(3, 2 * Math.round((idealSquareW - 1) / 2) + 1) : 2
    const boardW = squareW * 8 + 2
    const boardH = squareH * 8 + 2
    const gap = 2
    const margin = 1
    const panelW = wide ? Math.floor((term.cols - boardW - gap * 2 - margin * 2) / 2) : 0
    const board: Rect = {
      x: wide ? margin + panelW + gap : Math.max(2, Math.floor((term.cols - boardW) / 2)),
      y: Math.max(3, Math.floor((term.rows - boardH) / 2) - 1),
      w: boardW,
      h: boardH,
    }
    const filesY = board.y + board.h
    const statusY = filesY + 2
    center(term, wide ? board.y - 1 : 1, 'CHESS', BOLD | BRIGHT)

    clear(term, board)
    frame(term, board, NORMAL)
    const innerX = board.x + 1
    const innerY = board.y + 1
    for (let row = 0; row < 8; row++) {
      const y = innerY + row * squareH
      const rankY = y + Math.floor((squareH - 1) / 2)
      term.text(board.x - 2, rankY, String(8 - row), MUTED)
      for (let col = 0; col < 8; col++) {
        const x = innerX + col * squareW
        this.drawSquare(term, { row, col }, x, y, squareW, squareH)
      }
    }
    for (let col = 0; col < 8; col++) {
      const centerX = innerX + col * squareW + Math.floor((squareW - 1) / 2)
      term.put(centerX, filesY, 'abcdefgh'[col]!, MUTED)
    }

    const result = resultOf(this.state)
    if (wide) {
      this.drawControls(term, margin, board.y + 1, panelW)
      this.drawStatus(term, board.x + board.w + gap, board.y + 1, panelW, result)
      return
    }

    const turn = result.over ? result.text : this.note || `${this.state.turn} to move`
    center(term, statusY, turn, this.thinking ? MUTED : BOLD)
    if (!result.over && isCheck(this.state, this.state.turn)) {
      center(term, statusY + 1, 'check', BRIGHT)
    }
    center(term, term.rows - 2, result.over
      ? 'n new game  ESC menu'
      : 'ARROWS move  ENTER play  n new  ESC menu', MUTED)
  }

  private drawControls(term: Grid, x: number, y: number, width: number): void {
    term.text(x, y, 'CONTROLS', BOLD | BRIGHT)
    const items = [
      ['ARROWS', 'Move cursor'],
      ['ENTER', 'Select / play'],
      ['N', 'New game'],
      ['ESC', 'Menu'],
    ]
    let row = y + 2
    for (const [key, action] of items) {
      if (key.length <= width) term.text(x, row, key, BOLD)
      if (action.length <= width) term.text(x, row + 1, action, MUTED)
      row += 3
    }
  }

  private drawStatus(term: Grid, x: number, y: number, width: number, result: ReturnType<typeof resultOf>): void {
    term.text(x, y, 'STATUS', BOLD | BRIGHT)
    let row = y + 2
    const status = result.over ? result.text : this.note || `${this.state.turn} to move`
    row = writeLines(term, x, row, width, status.toUpperCase(), result.over ? BRIGHT : BOLD) + 1

    if (!result.over) {
      term.text(x, row, 'YOU     WHITE', MUTED)
      term.text(x, row + 1, 'MACHINE BLACK', MUTED)
      row += 3
    }
    if (!result.over && isCheck(this.state, this.state.turn)) {
      term.text(x, row, 'CHECK', BRIGHT)
      row += 2
    }

    term.text(x, row, 'CURSOR', MUTED)
    term.text(x, row + 1, squareName(this.cursor).toUpperCase(), BOLD)
  }

  private drawSquare(term: Grid, square: Square, x: number, y: number, width: number, height: number): void {
    const piece = getPiece(this.state, square)
    const selected = !!this.selected && sameSquare(this.selected, square)
    const target = this.moves.find(move => sameSquare(move.to, square))
    const cursor = sameSquare(this.cursor, square)
    const check = piece?.kind === 'king' && piece.color === this.state.turn && isCheck(this.state, this.state.turn)

    const dark = (square.row + square.col) % 2 === 1
    const focus = selected || cursor || check
    const squareAttr = dark ? BG : NORMAL
    const highlight = focus ? BOLD | BRIGHT
      : target ? ((square.row + square.col) % 2 ? DIM : MUTED)
      : null
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        term.put(x + dx, y + dy, ' ', highlight ?? squareAttr, highlight === null ? 0 : 1)
      }
    }
    if (piece) {
      const image = this.art[`${piece.color}-${piece.kind}`]
      if (image) {
        const pieceAttr = highlight ?? (piece.color === 'white' ? BOLD | BRIGHT : DIM)
        drawSvg(term, image, x, y, width, height, pieceAttr | (dark ? BG : 0), highlight === null ? 0 : 1)
      }
    }

  }
}

type BitmapGrid = Grid & {
  font?: { cellW: number; cellH: number }
  advance?: number
  stretch?: number
  putGlyph?: (x: number, y: number, bits: ArrayLike<number>, attr?: number, inv?: number) => void
}

interface GlyphSprite {
  cols: number
  rows: number
  cells: (Uint16Array | undefined)[]
}

const svgBitmaps = new Map<ArtName, Promise<ImageBitmap | undefined>>()
const spriteCache = new WeakMap<ImageBitmap, Map<string, GlyphSprite>>()

function loadSvg(name: ArtName): Promise<ImageBitmap | undefined> {
  const cached = svgBitmaps.get(name)
  if (cached) return cached
  const loading = (async (): Promise<ImageBitmap | undefined> => {
    let url: string | undefined
    try {
      const source = SVG_SOURCE[name].replace(/<svg\b([^>]*)>/, (_match, attributes: string) => {
        const view = attributes.replace(/\s+(?:width|height)="[^"]*"/g, '')
        return `<svg${view} width="256" height="256">`
      })
      url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
      const image = new Image()
      image.src = url
      await image.decode()
      return await createImageBitmap(image)
    } catch {
      return undefined
    } finally {
      if (url) URL.revokeObjectURL(url)
    }
  })()
  svgBitmaps.set(name, loading)
  return loading
}

function drawSvg(
  term: Grid, image: ImageBitmap, x: number, y: number, cols: number, rows: number,
  attr: number, inverse = 0,
): void {
  const surface = term as BitmapGrid
  const font = surface.font
  const putGlyph = surface.putGlyph
  if (!font || !putGlyph || font.cellW > 16 || typeof OffscreenCanvas === 'undefined') return

  const advance = surface.advance ?? font.cellW + 1
  const stretch = surface.stretch ?? 1
  const key = `${cols}x${rows}:${font.cellW}x${font.cellH}:${advance}:${stretch.toFixed(3)}`
  let cache = spriteCache.get(image)
  if (!cache) {
    cache = new Map()
    spriteCache.set(image, cache)
  }
  let sprite = cache.get(key)
  if (!sprite) {
    sprite = rasterSvg(image, cols, rows, font.cellW, font.cellH, advance, stretch)
    if (!sprite) return
    cache.set(key, sprite)
  }

  for (let cy = 0; cy < sprite.rows; cy++) {
    for (let cx = 0; cx < sprite.cols; cx++) {
      const bits = sprite.cells[cy * sprite.cols + cx]
      if (bits) putGlyph.call(surface, x + cx, y + cy, bits, attr, inverse)
    }
  }
}

function rasterSvg(
  image: ImageBitmap, cols: number, rows: number, cellW: number, cellH: number,
  advance: number, stretch: number,
): GlyphSprite | undefined {
  const pixelW = cols * advance
  const pixelH = rows * cellH
  if (!pixelW || !pixelH) return undefined

  const canvas = new OffscreenCanvas(pixelW, pixelH)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return undefined
  ctx.clearRect(0, 0, pixelW, pixelH)

  const pixelAspect = image.width / image.height * stretch
  const boxAspect = pixelW / pixelH
  const drawW = boxAspect > pixelAspect ? pixelH * pixelAspect : pixelW
  const drawH = boxAspect > pixelAspect ? pixelH : pixelW / pixelAspect
  ctx.drawImage(image, (pixelW - drawW) / 2, (pixelH - drawH) / 2, drawW, drawH)
  const pixels = ctx.getImageData(0, 0, pixelW, pixelH).data
  const cells: (Uint16Array | undefined)[] = new Array(cols * rows)

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bits = new Uint16Array(cellH)
      let lit = false
      for (let py = 0; py < cellH; py++) {
        const row = (cy * cellH + py) * pixelW + cx * advance
        let word = 0
        for (let px = 0; px < cellW; px++) {
          const i = (row + px) * 4
          if (pixels[i + 3]! > 64) word |= 1 << (cellW - px - 1)
        }
        if (advance > cellW) {
          const i = (row + cellW) * 4
          if (pixels[i + 3]! > 64) word |= 1
        }
        bits[py] = word
        lit ||= word !== 0
      }
      if (lit) cells[cy * cols + cx] = bits
    }
  }

  return { cols, rows, cells }
}

function squareName(square: Square): string {
  return `${'abcdefgh'[square.col]}${8 - square.row}`
}

function writeLines(term: Grid, x: number, y: number, width: number, text: string, attr: number): number {
  const limit = Math.max(1, width)
  let row = y
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= limit) {
      line = next
      continue
    }
    if (line) term.text(x, row++, line, attr)
    line = word.slice(0, limit)
  }
  if (line && row < term.rows) term.text(x, row++, line, attr)
  return row
}

function center(term: Grid, y: number, text: string, attr = NORMAL): void {
  if (y < 0 || y >= term.rows) return
  const x = Math.max(0, Math.floor((term.cols - text.length) / 2))
  term.text(x, y, text, attr)
}
