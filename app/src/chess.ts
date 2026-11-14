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

type Mode = 'menu' | 'board'

const PAWN = [
  '.......#####.......',
  '.....#########.....',
  '....###########....',
  '....###########....',
  '......#######......',
  '........###........',
  '......#######......',
  '....###########....',
  '..###############..',
  '###################',
]
const PAWN_W = PAWN[0]!.length
const MENU = ['Play with Machine', 'Play with someone']
const MACHINE_DELAY = 350
/** Unicode chess pieces. The coverage face carries all twelve; see FALLBACK_FONT. */
const GLYPH: Record<Piece['color'], Record<Piece['kind'], string>> = {
  white: { king: '♔', queen: '♕', rook: '♖', bishop: '♗', knight: '♘', pawn: '♙' },
  black: { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' },
}

const glyphOf = (piece: Piece): string => GLYPH[piece.color][piece.kind]

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

  constructor(private screen: CrtScreen, private snd: Sound) {}

  get open(): boolean {
    return !!this.stack?.active
  }

  /** Open the title card. The picker calls this after its own screen is gone. */
  start(): void {
    if (this.open || grid.locked) return
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

  private drawMenu(term: Grid): void {
    const logoY = Math.max(1, Math.floor((term.rows - PAWN.length - 8) / 2))
    this.drawPawn(term, logoY)

    const nameY = logoY + PAWN.length + 1
    center(term, nameY, 'CHESS', BOLD | BRIGHT)
    const optionY = nameY + 2
    MENU.forEach((label, index) => {
      const text = ` ${label} `
      const x = Math.max(0, Math.floor((term.cols - text.length) / 2))
      term.text(x, optionY + index * 2, text, BOLD, index === this.menuIndex ? 1 : 0)
    })
    center(term, term.rows - 2, 'ARROWS move  ENTER choose  ESC close', MUTED)
  }

  /** Draw the logo as bitmaps so the CRT raster gives it the same pixel shape at every font size. */
  private drawPawn(term: Grid, y: number): void {
    const x = Math.max(0, Math.floor((term.cols - PAWN_W) / 2))
    const crt = term as Grid & {
      font?: { cellW: number; cellH: number }
      putGlyph?: (x: number, y: number, bits: ArrayLike<number>, attr?: number) => void
    }
    const font = crt.font
    const putGlyph = crt.putGlyph

    if (!font || !putGlyph) {
      PAWN.forEach((row, py) => term.text(x, y + py, row.replaceAll('#', '█').replaceAll('.', ' '), BOLD | BRIGHT))
      return
    }

    const cellW = Math.min(16, font.cellW)
    const pixels = new Uint16Array(font.cellH).fill((1 << cellW) - 1)
    PAWN.forEach((row, py) => {
      for (let px = 0; px < row.length; px++) {
        if (row[px] === '#') putGlyph.call(crt, x + px, y + py, pixels, BOLD | BRIGHT)
      }
    })
  }

  private drawBoard(term: Grid): void {
    const wide = term.cols >= 76 && term.rows >= 24
    // At 76x24 each side panel gets 18 columns; 120x36 unlocks a larger board.
    const large = wide && term.cols >= 120 && term.rows >= 36
    const squareW = large ? 6 : wide ? 4 : 2
    const squareH = large ? 3 : wide ? 2 : 1
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
    center(term, wide ? board.y - 2 : 1, 'CHESS', BOLD | BRIGHT)

    clear(term, board)
    frame(term, board, NORMAL)
    for (let row = 0; row < 8; row++) {
      const y = board.y + 1 + row * squareH
      term.text(board.x - 2, y + Math.floor(squareH / 2), String(8 - row), MUTED)
      for (let col = 0; col < 8; col++) {
        this.drawSquare(term, { row, col }, board.x + 1 + col * squareW, y, squareW, squareH)
      }
    }
    for (let col = 0; col < 8; col++) {
      term.put(board.x + 1 + col * squareW + Math.floor(squareW / 2), filesY, 'abcdefgh'[col]!, MUTED)
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
    row += 3

    if (!this.selected) return
    const piece = getPiece(this.state, this.selected)
    term.text(x, row, 'SELECTED', MUTED)
    row = writeLines(term, x, row + 1, width,
      `${squareName(this.selected)} ${piece?.color ?? ''} ${piece?.kind ?? ''}`.trim().toUpperCase(), BOLD) + 1

    if (!this.moves.length) {
      term.text(x, row, 'NO LEGAL MOVES', MUTED)
      return
    }

    term.text(x, row, `LEGAL MOVES ${this.moves.length}`, MUTED)
    const destinations = this.moves.slice(0, 12).map(move => squareName(move.to))
    if (this.moves.length > destinations.length) destinations.push(`+${this.moves.length - destinations.length}`)
    writeLines(term, x, row + 1, width, destinations.join(' ').toUpperCase(), BRIGHT)
  }

  private drawSquare(term: Grid, square: Square, x: number, y: number, width: number, height: number): void {
    const piece = getPiece(this.state, square)
    const selected = !!this.selected && sameSquare(this.selected, square)
    const target = this.moves.find(move => sameSquare(move.to, square))
    const cursor = sameSquare(this.cursor, square)
    const check = piece?.kind === 'king' && piece.color === this.state.turn && isCheck(this.state, this.state.turn)

    const dark = (square.row + square.col) % 2 === 1
    const focus = selected || cursor || check
    const marked = focus || !!target
    let attr = dark ? BG : NORMAL
    if (piece) attr |= piece.color === 'white' ? BOLD | BRIGHT : DIM
    if (target) attr = (dark ? BG : 0) | MUTED
    if (focus) attr = (dark ? BG : 0) | BOLD | BRIGHT
    const inverse = marked ? 1 : 0
    const pieceX = Math.floor(width / 2)
    const pieceY = Math.floor(height / 2)

    // BG shades dark squares; inverse fills legal destinations and focus squares.
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const glyph = piece && dx === pieceX && dy === pieceY ? glyphOf(piece) : ' '
        term.put(x + dx, y + dy, glyph, attr, inverse)
      }
    }
  }
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
