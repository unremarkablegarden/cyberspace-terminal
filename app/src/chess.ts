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
  BOLD, BRIGHT, MUTED, NORMAL, ScreenStack, clear, frame,
  type Grid, type KeyInput, type Rect, type Screen,
} from '@cyberspace/tui'
import { grid } from './grid'
import type { Overlay } from './input'
import {
  applyMove, chooseMachineMove, getMoves, getPiece, isCheck, newChessState,
  pieceLetter, resultOf, sameSquare,
  type Move, type Square,
} from './chess/rules'

type Mode = 'menu' | 'board'

const LOGO = [
  '  ____ _   _ _____ ____ ____  ',
  ' / ___| | | | ____/ ___/ ___| ',
  '| |   | |_| |  _| \\___ \\___ \\ ',
  '| |___|  _  | |___ ___) |__) |',
  ' \\____|_| |_|_____|____/____/ ',
]
const LOGO_W = Math.max(...LOGO.map(line => line.length))
const MENU = ['Play with Machine', 'Play with someone']
const MACHINE_DELAY = 350

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
    // The two-player chair is not wired yet. The row stays selected, so the list
    // does not pretend that something started.
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
    const logoY = Math.max(2, Math.floor(term.rows / 6))
    const logoX = Math.max(0, Math.floor((term.cols - LOGO_W) / 2))
    LOGO.forEach((line, row) => term.text(logoX, logoY + row, line, BOLD | BRIGHT))

    center(term, logoY + LOGO.length + 1, 'beta', MUTED)
    const optionY = logoY + LOGO.length + 4
    MENU.forEach((label, index) => {
      const text = ` ${label} `
      const x = Math.max(0, Math.floor((term.cols - text.length) / 2))
      term.text(x, optionY + index * 2, text, BOLD, index === this.menuIndex ? 1 : 0)
    })
    center(term, optionY + MENU.length * 2, 'two-player chess is not wired yet', MUTED)
    center(term, term.rows - 2, 'UP/DOWN  move     ENTER  choose     ESC  close', MUTED)
  }

  private drawBoard(term: Grid): void {
    const board: Rect = {
      x: Math.max(2, Math.floor((term.cols - 28) / 2)),
      y: Math.max(3, Math.floor((term.rows - 10) / 2) - 1),
      w: 26,
      h: 10,
    }
    const filesY = board.y + board.h
    const statusY = filesY + 2
    center(term, 1, 'C H E S S', BOLD | BRIGHT)

    clear(term, board)
    frame(term, board, NORMAL)
    for (let row = 0; row < 8; row++) {
      const y = board.y + 1 + row
      term.text(board.x - 2, y, String(8 - row), MUTED)
      for (let col = 0; col < 8; col++) {
        this.drawSquare(term, { row, col }, board.x + 1 + col * 3, y)
      }
    }
    for (let col = 0; col < 8; col++) {
      term.put(board.x + 2 + col * 3, filesY, 'abcdefgh'[col]!, MUTED)
    }

    const result = resultOf(this.state)
    const turn = result.over ? result.text : this.note || `${this.state.turn} to move`
    center(term, statusY, turn, this.thinking ? MUTED : BOLD)
    if (!result.over && isCheck(this.state, this.state.turn)) {
      center(term, statusY + 1, 'check', BRIGHT)
    }
    center(term, term.rows - 2, result.over
      ? 'n  new game     ESC  menu'
      : 'ARROWS  move     ENTER  select/move     n  new     ESC  menu', MUTED)
  }

  private drawSquare(term: Grid, square: Square, x: number, y: number): void {
    const piece = getPiece(this.state, square)
    const selected = !!this.selected && sameSquare(this.selected, square)
    const target = this.moves.find(move => sameSquare(move.to, square))
    const cursor = sameSquare(this.cursor, square)
    const check = piece?.kind === 'king' && piece.color === this.state.turn && isCheck(this.state, this.state.turn)

    let text = '   '
    let attr = NORMAL
    if (piece) {
      text = ` ${pieceLetter(piece)} `
      attr = piece.color === 'white' ? BOLD : NORMAL
    }
    if (target) {
      text = piece ? `!${pieceLetter(piece)}!` : ' * '
      attr = piece ? BOLD | BRIGHT : MUTED
    }
    if (selected && piece) {
      text = `[${pieceLetter(piece)}]`
      attr = BOLD | BRIGHT
    }
    if (check) {
      text = `!${pieceLetter(piece)}!`
      attr = BOLD | BRIGHT
    }
    if (cursor) attr |= BRIGHT
    term.text(x, y, text, attr, cursor ? 1 : 0)
  }
}

function center(term: Grid, y: number, text: string, attr = NORMAL): void {
  if (y < 0 || y >= term.rows) return
  const x = Math.max(0, Math.floor((term.cols - text.length) / 2))
  term.text(x, y, text, attr)
}
