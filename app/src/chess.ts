// chess(0): the faceplate's small board game.
//
// The game has two screens: a title card with the machine and two-player
// choices, and the board itself. Both draw on the CRT grid through the screen
// stack, so they cover the pty without writing escape codes into it.
//
// The player is white and the machine is black. Arrow keys move a cursor over
// the board, Enter picks up a piece, and the squares the piece can reach are
// marked. Enter on a marked square plays the move. The rules live in
// chess/rules.ts and the Stockfish bridge in chess/stockfish.ts; this file
// turns keys into moves and moves into cells.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { RENDER } from '@cyberspace/crt/config'
import {
  BG, BOLD, BRIGHT, DIM, MUTED, NORMAL, ScreenStack, SelectPopup, clear, frame,
  shadow, type Grid, type KeyInput, type Rect, type Screen,
} from '@cyberspace/tui'
import { grid } from './grid'
import type { Overlay } from './input'
import {
  applyMove, getMoves, getPiece, isCheck, newChessState,
  resultOf, sameSquare,
  type Color, type GameResult, type Move, type Piece, type Square,
} from './chess/rules'
import { StockfishEngine } from './chess/stockfish'
import {
  PendingChessMultiplayer,
  type ChessInvite,
  type ChessMultiplayerGame,
  type ChessMultiplayerTransport,
  type MultiplayerFriend,
} from './chess/multiplayer'
import chessLogoUrl from './chess/assets/chess-logo.png?url'
import bishopSvg from './chess/svg/bishop.svg?raw'
import blackBishopSvg from './chess/svg/black-bishop.svg?raw'
import blackKingSvg from './chess/svg/black-king.svg?raw'
import blackKnightSvg from './chess/svg/black-knight.svg?raw'
import blackPawnSvg from './chess/svg/black-pawn.svg?raw'
import blackQueenSvg from './chess/svg/black-queen.svg?raw'
import blackRookSvg from './chess/svg/black-rook.svg?raw'
import kingSvg from './chess/svg/king.svg?raw'
import knightSvg from './chess/svg/knight.svg?raw'
import pawnSvg from './chess/svg/pawn.svg?raw'
import queenSvg from './chess/svg/queen.svg?raw'
import rookSvg from './chess/svg/rook.svg?raw'

type Mode = 'menu' | 'board'

const MENU = ['Play with Machine', 'Play with someone']
const COLOR_MENU = ['Random', 'White', 'Black']
const MACHINE_DELAY = 350
type PieceArt = `${Piece['color']}-${Piece['kind']}`
type ArtName = 'logo' | PieceArt
type PieceStyle = 'solid' | 'outline'

const SVG_SOURCE: Record<PieceArt, string> = {
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
  private playerColor: Color = 'white'
  private gameMode: 'machine' | 'multiplayer' = 'machine'
  private multiplayerGame: ChessMultiplayerGame | null = null
  private stopWatchingMultiplayer: (() => void) | null = null
  private stopWatchingInvites: (() => void) | null = null
  private stopWatchingInviteResults: (() => void) | null = null
  private readonly incomingInviteIds = new Set<string>()
  private activeInvite: ChessInvite | null = null
  private activeOpponentName = ''
  private endgameShown = false
  private state = newChessState()
  private cursor: Square = { row: 6, col: 4 }
  private selected: Square | null = null
  private moves: Move[] = []
  private thinking = false
  private engine: StockfishEngine | null = null
  private machineRequest = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private note = ''
  private art: Partial<Record<ArtName, ImageBitmap>> = {}
  private artLoading = false
  private artLoaded = false

  constructor(
    private screen: CrtScreen,
    private snd: Sound,
    private multiplayer: ChessMultiplayerTransport = new PendingChessMultiplayer(),
  ) {}

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
    this.stopWatchingInvites?.()
    this.stopWatchingInvites = this.multiplayer.watchInvites(invite => this.showIncomingInvite(invite))
    this.stopWatchingInviteResults?.()
    this.stopWatchingInviteResults = this.multiplayer.watchInviteResults(invite => this.handleInviteResult(invite))
  }

  /** Keys reach the overlay through Keyboard's route, as the config box and DOOM do. */
  key(k: KeyInput): void {
    this.stack?.key(k)
  }

  silentKey(k: KeyInput): boolean {
    if (k.metaKey || k.ctrlKey || k.altKey) return false
    return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(k.key)
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (this.mode === 'menu') return this.menuKey(e)
    return this.boardKey(e)
  }

  draw(term: Grid): void {
    clear(term, { x: 0, y: 0, w: term.cols, h: term.rows })
    if (this.mode !== 'board') this.drawMenu(term)
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
      this.openColorPicker()
      return true
    }
    this.openPlayerPicker()
    return true
  }

  private boardKey(e: KeyInput): boolean {
    if (e.key === 'Escape') {
      this.openQuitConfirmation()
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
    const direction = this.playerColor === 'black' ? -1 : 1
    const row = Math.min(7, Math.max(0, this.cursor.row + step.row * direction))
    const col = Math.min(7, Math.max(0, this.cursor.col + step.col * direction))
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

  private openColorPicker(): void {
    if (!this.stack) return
    this.stack.push(new SelectPopup({
      title: 'PLAY AS',
      items: COLOR_MENU,
      selected: 0,
      shadow: true,
      onFeedback: kind => {
        if (kind === 'move') this.snd.tick()
        else if (kind === 'edge') this.snd.beep(220, 0.04)
        else if (kind === 'cancel') this.snd.blip(420, 0.09, 0)
      },
      onDone: (item, index) => {
        this.stack?.pop()
        if (item === null) {
          this.repaint()
          return
        }
        this.playerColor = index === 0
          ? (Math.random() < 0.5 ? 'white' : 'black')
          : index === 1 ? 'white' : 'black'
        this.newGame()
      },
    }))
  }

  private openPlayerPicker(): void {
    if (!this.stack) return
    let loading!: ChessCard
    const back = () => {
      this.stack?.pop()
      this.repaint()
    }
    loading = new ChessCard(this.snd, 'MULTIPLAYER', 'Loading your friends...', ['Back'], 0, back, back)
    this.stack.push(loading)
    void this.multiplayer.listFriends().then(friends => {
      if (!this.open || this.stack?.top !== loading) return
      this.stack.pop()
      const named = friends.filter(friend => friend.username || friend.displayName)
      if (!named.length) {
        this.stack.push(new FollowersCard(this.snd, back))
        return
      }
      this.stack.push(new SelectPopup({
        title: 'Your friends:',
        items: named.map(friend => friend.displayName ?? friend.username ?? ''),
        selected: 0,
        shadow: true,
        onFeedback: kind => {
          if (kind === 'move') this.snd.tick()
          else if (kind === 'edge') this.snd.beep(220, 0.04)
          else if (kind === 'cancel') this.snd.blip(420, 0.09, 0)
        },
        onDone: (_item, index) => {
          this.stack?.pop()
          const friend = named[index]
          if (!friend) {
            this.repaint()
            return
          }
          this.sendMultiplayerInvite(friend)
        },
      }))
    }).catch(() => {
      if (!this.open || this.stack?.top !== loading) return
      this.stack.pop()
      this.stack.push(new FollowersCard(this.snd, back))
    })
  }

  private sendMultiplayerInvite(friend: MultiplayerFriend): void {
    let card!: ChessCard
    const cancel = () => {
      this.stack?.pop()
      this.repaint()
    }
    const closeCard = () => {
      this.stack?.pop()
      this.repaint()
    }
    card = new ChessCard(this.snd, 'MULTIPLAYER', `Invite ${friend.displayName ?? friend.username ?? 'follower'}?`, ['Send', 'Back'], 0, action => {
      if (action === 'Back') {
        cancel()
        return
      }
      void this.multiplayer.sendInvite(friend.userId, 'random').then(invite => this.multiplayer.openGame(invite).then(game => ({ invite, game }))).then(({ invite, game }) => {
        if (!this.open || this.stack?.top !== card) return
        this.stack.pop()
        this.activeInvite = invite
        this.activeOpponentName = friend.displayName ?? friend.username ?? friend.userId
        this.startMultiplayerGame(game)
      }).catch(() => {
        if (!this.open || this.stack?.top !== card) return
        this.stack.pop()
        this.stack.push(new ChessCard(this.snd, 'MULTIPLAYER', 'Could not reach that player. Make sure they are online.', ['Back'], 0, closeCard, closeCard))
      })
    }, cancel)
    this.stack?.push(card)
  }

  private showIncomingInvite(invite: ChessInvite): void {
    if (!this.open || this.incomingInviteIds.has(invite.inviteId)) return
    this.incomingInviteIds.add(invite.inviteId)
    const from = invite.fromUserId.startsWith('demo:')
      ? `Demo ${invite.fromUserId.slice(5).replace(/[_-]+/g, ' ')}`
      : invite.fromUserId
    let card!: ChessCard
    const respond = (accept: boolean) => {
      if (this.stack?.top === card) this.stack.pop()
      if (accept) this.activeInvite = invite
      void this.multiplayer.answerInvite(invite.inviteId, accept).then(game => {
        if (game && this.open) this.startMultiplayerGame(game)
      }).catch(() => {
        if (this.open) {
          const back = () => {
            this.stack?.pop()
            this.repaint()
          }
          this.stack?.push(new ChessCard(this.snd, 'CHESS INVITE', 'This invite is no longer available.', ['Back'], 0, back, back))
        }
      }).finally(() => this.incomingInviteIds.delete(invite.inviteId))
    }
    card = new ChessCard(this.snd, 'CHESS INVITE', `${from} wants to play.`, ['Accept', 'Decline'], 0,
      option => respond(option === 'Accept'),
      () => respond(false))
    this.stack?.push(card)
  }

  private handleInviteResult(invite: ChessInvite): void {
    if (invite.status !== 'declined' || this.activeInvite?.inviteId !== invite.inviteId || !this.multiplayerGame) return
    // A declined request ends the inviter's waiting game instead of leaving it stalled.
    this.closeMultiplayerGame()
    this.activeInvite = null
    this.gameMode = 'machine'
    this.mode = 'menu'
    this.thinking = false
    this.clearSelection()
    const opponent = this.activeOpponentName || invite.toUserId
    this.activeOpponentName = ''
    this.repaint()
    let card!: ChessCard
    const close = () => {
      this.stack?.pop()
      this.repaint()
    }
    card = new ChessCard(this.snd, 'INVITE DECLINED', `${opponent} has declined your request to play Chess.`, ['Back'], 0, close, close)
    this.stack?.push(card)
  }

  private playMove(move: Move): void {
    if (this.gameMode === 'multiplayer' && this.multiplayerGame) {
      this.clearSelection()
      this.thinking = true
      this.note = 'sending move...'
      this.repaint()
      void this.multiplayerGame.submitMove(move).catch(() => {
        this.thinking = false
        this.note = 'move rejected'
        this.repaint()
      })
      return
    }
    this.state = applyMove(this.state, move)
    this.cursor = move.to
    this.clearSelection()
    this.snd.tick()

    const result = resultOf(this.state)
    if (result.over) {
      this.note = result.text
      this.showEndgame(result)
      return
    }
    if (this.gameMode === 'machine' && this.state.turn !== this.playerColor) this.startMachine()
    else this.repaint()
  }

  private startMachine(): void {
    const request = ++this.machineRequest
    this.thinking = true
    this.note = 'machine is thinking...'
    this.repaint()
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.open || this.mode !== 'board') return
      void this.playMachine(request)
    }, MACHINE_DELAY)
  }

  private async playMachine(request: number): Promise<void> {
    try {
      this.engine ??= new StockfishEngine()
      const move = await this.engine.chooseMove(this.state)
      if (request !== this.machineRequest || !this.open || this.mode !== 'board') return
      this.thinking = false
      if (!move) {
        const result = resultOf(this.state)
        this.note = result.text
        if (result.over) this.showEndgame(result)
      } else {
        this.state = applyMove(this.state, move)
        this.cursor = move.to
        this.snd.tick()
        const result = resultOf(this.state)
        this.note = result.over ? result.text : ''
        if (result.over) this.showEndgame(result)
      }
    } catch {
      if (request !== this.machineRequest) return
      this.thinking = false
      this.note = 'machine unavailable'
    }
    this.repaint()
  }

  private newGame(): void {
    this.closeMultiplayerGame()
    this.stopMachine()
    this.gameMode = 'machine'
    this.state = newChessState()
    this.cursor = { row: this.playerColor === 'white' ? 6 : 1, col: 4 }
    this.clearSelection()
    this.thinking = false
    this.note = ''
    this.mode = 'board'
    this.endgameShown = false
    this.snd.tick()
    if (this.state.turn !== this.playerColor) this.startMachine()
    else this.repaint()
  }

  private startMultiplayerGame(game: ChessMultiplayerGame): void {
    this.stopMachine()
    this.closeMultiplayerGame()
    this.multiplayerGame = game
    this.gameMode = 'multiplayer'
    this.mode = 'board'
    this.clearSelection()
    this.endgameShown = false
    this.cursor = { row: 6, col: 4 }
    this.stopWatchingMultiplayer = game.watch(snapshot => {
      if (this.multiplayerGame !== game) return
      this.state = snapshot.state
      this.playerColor = snapshot.playerColor ?? game.playerColor
      if (snapshot.playerColor === 'black' && this.cursor.row === 6 && this.cursor.col === 4) this.cursor = { row: 1, col: 4 }
      this.thinking = snapshot.status === 'waiting' || (snapshot.status === 'active' && snapshot.state.turn !== this.playerColor)
      this.note = snapshot.status === 'waiting'
        ? 'waiting for opponent...'
        : snapshot.status === 'active' && snapshot.state.turn !== this.playerColor
          ? 'opponent is thinking...'
          : ''
      const result = resultOf(snapshot.state)
      if (result.over && !this.endgameShown) {
        this.note = result.text
        this.showEndgame(result)
      }
      this.repaint()
    })
    this.snd.tick()
    this.repaint()
  }

  private toMenu(): void {
    this.closeMultiplayerGame()
    this.stopMachine()
    this.activeInvite = null
    this.activeOpponentName = ''
    this.gameMode = 'machine'
    this.mode = 'menu'
    this.thinking = false
    this.clearSelection()
    this.note = ''
    this.menuIndex = 0
    this.snd.blip(420, 0.09, 0)
    this.repaint()
  }

  private close(): void {
    this.stopWatchingInvites?.()
    this.stopWatchingInvites = null
    this.stopWatchingInviteResults?.()
    this.stopWatchingInviteResults = null
    this.closeMultiplayerGame()
    this.stopMachine()
    while (this.stack?.active) this.stack.pop()
    grid.unlock()
    RENDER.cursor = this.cursorWas
    this.snd.blip(420, 0.09, 0)
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private stopMachine(): void {
    this.machineRequest++
    this.stopTimer()
    this.engine?.dispose()
    this.engine = null
    this.thinking = false
  }

  private closeMultiplayerGame(): void {
    this.stopWatchingMultiplayer?.()
    this.stopWatchingMultiplayer = null
    this.multiplayerGame?.close()
    this.multiplayerGame = null
  }

  private repaint(): void {
    if (!this.open || this.stack?.top !== this) return
    this.screen.term.dirty = true
    this.draw(this.screen.term as never)
  }

  private ensureArt(): void {
    if (this.artLoading || this.artLoaded) return
    this.artLoading = true
    const names: ArtName[] = ['logo', ...(Object.keys(SVG_SOURCE) as PieceArt[])]
    void Promise.all(names.map(async name => {
      const image = await loadArt(name)
      if (image) this.art[name] = image
    })).finally(() => {
      this.artLoading = false
      this.artLoaded = true
      this.repaint()
    })
  }

  private drawMenu(term: Grid): void {
    const metrics = term as Grid & { font?: { cellW: number; cellH: number }; advance?: number; stretch?: number }
    const cellH = metrics.font?.cellH ?? 16
    const advance = metrics.advance ?? (metrics.font?.cellW ?? 8) + 1
    const stretch = metrics.stretch ?? 1
    const buttonHeight = 3
    const buttonGap = 1
    const optionRows = MENU.length * buttonHeight + (MENU.length - 1) * buttonGap
    const targetLogoRows = term.rows >= 32 ? 9 : term.rows >= 24 ? 7 : term.rows >= 18 ? 5 : 3
    const maxLogoRows = Math.max(3, term.rows - optionRows - 12)
    const logoRows = Math.min(targetLogoRows, maxLogoRows)
    const logoWidth = Math.min(Math.max(3, term.cols - 4), Math.round(logoRows * cellH * stretch / advance))
    const logoHeight = Math.min(logoRows, Math.max(3, Math.round(logoWidth * advance / (cellH * stretch))))
    const contentHeight = logoHeight + optionRows + 5
    const logoY = Math.max(0, Math.floor((term.rows - contentHeight) / 2))
    this.drawLogo(term, logoY, logoWidth, logoHeight)
    const titleY = logoY + logoHeight + 1
    center(term, titleY, 'CHESS', BOLD | BRIGHT)
    const optionY = titleY + 2
    const buttonWidth = Math.max(1, Math.min(term.cols - 4, Math.max(24, ...MENU.map(label => label.length + 8))))
    MENU.forEach((label, index) => {
      const selected = index === this.menuIndex
      const button: Rect = {
        x: Math.floor((term.cols - buttonWidth) / 2),
        y: optionY + index * (buttonHeight + buttonGap),
        w: buttonWidth,
        h: buttonHeight,
      }
      clear(term, button)
      frame(term, button, selected ? BOLD | BRIGHT : MUTED)
      if (selected) {
        for (let x = button.x + 1; x < button.x + button.w - 1; x++) {
          term.put(x, button.y + 1, ' ', BOLD | BRIGHT, 1)
        }
      }
      term.text(button.x + 2, button.y + 1, label, selected ? BOLD | BRIGHT : MUTED, selected ? 1 : 0)
    })
  }

  private drawLogo(term: Grid, y: number, logoWidth: number, logoHeight: number): void {
    const width = Math.min(logoWidth, term.cols)
    const height = Math.min(logoHeight, term.rows - y)
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
      term.text(board.x - 2, rankY, String(this.playerColor === 'white' ? 8 - row : row + 1), MUTED)
      for (let col = 0; col < 8; col++) {
        const x = innerX + col * squareW
        this.drawSquare(term, this.boardSquare(row, col), x, y, squareW, squareH)
      }
    }
    for (let col = 0; col < 8; col++) {
      const centerX = innerX + col * squareW + Math.floor((squareW - 1) / 2)
      term.put(centerX, filesY, 'abcdefgh'[this.playerColor === 'white' ? col : 7 - col]!, MUTED)
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
      ? 'ESC quit'
      : 'ARROWS move  ENTER play  ESC quit', MUTED)
  }

  private drawControls(term: Grid, x: number, y: number, width: number): void {
    term.text(x, y, 'CONTROLS', BOLD | BRIGHT)
    const items = [
      ['ARROWS', 'Move cursor'],
      ['ENTER', 'Select / play'],
      ['ESC', 'Quit'],
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
      const player = this.playerColor.toUpperCase()
      if (this.gameMode === 'multiplayer') {
        const opponent = this.playerColor === 'white' ? 'BLACK' : 'WHITE'
        term.text(x, row, `YOU      ${player}`, MUTED)
        term.text(x, row + 1, `OPPONENT ${opponent}`, MUTED)
      } else {
        term.text(x, row, `YOU     ${player}`, MUTED)
        const machine = this.playerColor === 'white' ? 'BLACK' : 'WHITE'
        term.text(x, row + 1, `MACHINE ${machine}`, MUTED)
      }
      row += 3
    }
    if (!result.over && isCheck(this.state, this.state.turn)) {
      term.text(x, row, 'CHECK', BRIGHT)
      row += 2
    }

    term.text(x, row, 'CURSOR', MUTED)
    term.text(x, row + 1, squareName(this.cursor).toUpperCase(), BOLD)
  }

  private showEndgame(result: GameResult): void {
    if (this.endgameShown) return
    this.endgameShown = true
    const winner = /^(white|black) wins by checkmate$/.exec(result.text)?.[1] as Color | undefined
    const title = winner ? 'Checkmate!' : 'Game over'
    const message = winner
      ? winner === this.playerColor ? 'You won!' : 'You lost!'
      : 'Draw!'
    const restart = this.gameMode === 'multiplayer' ? () => this.toMenu() : () => this.newGame()
    this.repaint()
    this.stack?.push(new ChessCard(this.snd, title, message, ['Play again', 'Quit'], 0, action => {
      this.stack?.pop()
      if (action === 'Play again') restart()
      else this.toMenu()
    }, () => this.openQuitConfirmation()))
  }

  private openQuitConfirmation(): void {
    if (!this.stack) return
    const resultCardUnderneath = this.stack.top instanceof ChessCard
    const resumeMachine = !resultCardUnderneath && this.mode === 'board' && !resultOf(this.state).over && this.state.turn !== this.playerColor
    if (resumeMachine) this.stopMachine()
    const resume = () => {
      if (resumeMachine && this.mode === 'board' && this.stack?.top === this) this.startMachine()
    }
    this.stack.push(new ChessCard(this.snd, 'QUIT GAME?', 'Are you sure you want to quit?', ['Yes', 'No'], 1, answer => {
      this.stack?.pop()
      if (answer === 'Yes') {
        if (resultCardUnderneath && this.stack?.top instanceof ChessCard) this.stack.pop()
        this.toMenu()
      } else {
        this.snd.tick()
        resume()
      }
    }, () => {
      this.stack?.pop()
      resume()
    }))
  }

  private boardSquare(row: number, col: number): Square {
    return this.playerColor === 'white'
      ? { row, col }
      : { row: 7 - row, col: 7 - col }
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
        const style = piece.color === 'white' ? 'solid' : 'outline'
        drawSvg(term, image, x, y, width, height,
          pieceAttr | (dark ? BG : 0), highlight === null ? 0 : 1, style)
      }
    }

  }
}

class ChessCard implements Screen {
  private selected: number

  constructor(
    private snd: Sound,
    private title: string,
    private message: string,
    private options: string[],
    selected: number,
    private choose: (option: string) => void,
    private cancel: () => void,
  ) { this.selected = selected }

  draw(term: Grid): void {
    const width = Math.max(1, Math.min(38, term.cols - 2))
    const messageLines = wrapText(this.message, Math.max(1, width - 4))
    const labels = this.options.map(option => `[ ${option} ]`)
    const horizontal = labels.join('  ').length <= width - 4
    const height = Math.max(1, Math.min(messageLines.length + (horizontal ? 6 : 5 + this.options.length), term.rows - 2))
    const panel: Rect = {
      x: Math.max(0, Math.floor((term.cols - width - 1) / 2)),
      y: Math.max(0, Math.floor((term.rows - height - 1) / 2)),
      w: width,
      h: height,
    }
    shadow(term, panel)
    clear(term, { x: panel.x + 1, y: panel.y + 1, w: panel.w - 2, h: panel.h - 2 })
    frame(term, panel, NORMAL)
    term.text(panel.x + 2, panel.y, this.title, BOLD | BRIGHT)
    messageLines.forEach((line, index) => center(term, panel.y + 2 + index, line, BOLD | BRIGHT))

    const optionsY = panel.y + 3 + messageLines.length
    if (horizontal) {
      const row = labels.join('  ')
      let x = panel.x + Math.max(1, Math.floor((panel.w - row.length) / 2))
      labels.forEach((label, index) => {
        term.text(x, optionsY, label, index === this.selected ? BOLD | BRIGHT : MUTED, index === this.selected ? 1 : 0)
        x += label.length + 2
      })
    } else {
      labels.forEach((label, index) => {
        term.text(panel.x + 2, optionsY + index, label, index === this.selected ? BOLD | BRIGHT : MUTED, index === this.selected ? 1 : 0)
      })
    }

    term.showCursor = false
    term.dirty = true
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (e.key === 'Escape') {
      this.snd.tick()
      this.cancel()
      return true
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
      this.selected = (this.selected + (forward ? 1 : -1) + this.options.length) % this.options.length
      this.snd.tick()
      return true
    }
    if (e.key === 'Enter') {
      this.choose(this.options[this.selected]!)
      return true
    }
    return false
  }
}

class FollowersCard implements Screen {
  constructor(private snd: Sound, private back: () => void) {}

  draw(term: Grid): void {
    const width = Math.max(1, Math.min(40, term.cols - 2))
    const height = Math.max(1, Math.min(14, term.rows - 2))
    const panel: Rect = {
      x: Math.max(0, Math.floor((term.cols - width - 1) / 2)),
      y: Math.max(0, Math.floor((term.rows - height - 1) / 2)),
      w: width,
      h: height,
    }
    shadow(term, panel)
    clear(term, { x: panel.x + 1, y: panel.y + 1, w: panel.w - 2, h: panel.h - 2 })
    frame(term, panel, NORMAL)
    term.text(panel.x + 2, panel.y, 'Your friends:', BOLD | BRIGHT)
    center(term, panel.y + Math.floor(panel.h / 2), 'NO API YET', MUTED)

    const button = '[ Back ]'
    term.text(panel.x + Math.floor((panel.w - button.length) / 2), panel.y + panel.h - 3, button, BOLD | BRIGHT, 1)
    term.showCursor = false
    term.dirty = true
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (e.key === 'Escape' || e.key === 'Enter') {
      this.snd.tick()
      this.back()
      return true
    }
    return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
  }
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= width) line = next
    else {
      if (line) lines.push(line)
      line = word.slice(0, width)
    }
  }
  if (line) lines.push(line)
  return lines
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

const artBitmaps = new Map<ArtName, Promise<ImageBitmap | undefined>>()
const spriteCache = new WeakMap<ImageBitmap, Map<string, GlyphSprite>>()

function loadArt(name: ArtName): Promise<ImageBitmap | undefined> {
  const cached = artBitmaps.get(name)
  if (cached) return cached
  const loading = (async (): Promise<ImageBitmap | undefined> => {
    let url: string | undefined
    try {
      const image = new Image()
      if (name === 'logo') {
        image.src = chessLogoUrl
      } else {
        const source = SVG_SOURCE[name].replace(/<svg\b([^>]*)>/, (_match, attributes: string) => {
          const view = attributes.replace(/\s+(?:width|height)="[^"]*"/g, '')
          return `<svg${view} width="256" height="256">`
        })
        url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
        image.src = url
      }
      await image.decode()
      return await createImageBitmap(image)
    } catch {
      return undefined
    } finally {
      if (url) URL.revokeObjectURL(url)
    }
  })()
  artBitmaps.set(name, loading)
  return loading
}

function drawSvg(
  term: Grid, image: ImageBitmap, x: number, y: number, cols: number, rows: number,
  attr: number, inverse = 0, style: PieceStyle = 'solid',
): void {
  const surface = term as BitmapGrid
  const font = surface.font
  const putGlyph = surface.putGlyph
  if (!font || !putGlyph || font.cellW > 16 || typeof OffscreenCanvas === 'undefined') return

  const advance = surface.advance ?? font.cellW + 1
  const stretch = surface.stretch ?? 1
  const key = `${cols}x${rows}:${font.cellW}x${font.cellH}:${advance}:${stretch.toFixed(3)}:${style}`
  let cache = spriteCache.get(image)
  if (!cache) {
    cache = new Map()
    spriteCache.set(image, cache)
  }
  let sprite = cache.get(key)
  if (!sprite) {
    sprite = rasterSvg(image, cols, rows, font.cellW, font.cellH, advance, stretch, style)
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
  advance: number, stretch: number, style: PieceStyle,
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
  const mask = new Uint8Array(pixelW * pixelH)
  for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3]! > 64 ? 1 : 0
  const cells: (Uint16Array | undefined)[] = new Array(cols * rows)

  const visible = (px: number, py: number): boolean => {
    const at = py * pixelW + px
    if (!mask[at]) return false
    if (style === 'solid') return true

    // Keep a two-pixel edge. The inside stays transparent so the checker
    // square reads as the dark side's fill.
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        if (!ox && !oy) continue
        const nx = px + ox
        const ny = py + oy
        if (nx < 0 || ny < 0 || nx >= pixelW || ny >= pixelH || !mask[ny * pixelW + nx]) return true
      }
    }
    return false
  }

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bits = new Uint16Array(cellH)
      let lit = false
      for (let py = 0; py < cellH; py++) {
        let word = 0
        for (let px = 0; px < cellW; px++) {
          if (visible(cx * advance + px, cy * cellH + py)) word |= 1 << (cellW - px - 1)
        }
        if (advance > cellW) {
          if (visible(cx * advance + cellW, cy * cellH + py)) word |= 1
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
