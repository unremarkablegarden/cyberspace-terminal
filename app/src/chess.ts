// chess(0): the faceplate's small board game.
//
// The game has two screens: a title card with the machine and two-player
// choices, and the board itself. Both draw on the CRT grid through the screen
// stack, so they cover the pty without writing escape codes into it.
//
// The player is white and the machine is black. Arrow keys move a cursor over
// the board, Enter picks up a piece, and the squares the piece can reach are
// marked. Enter on a marked square plays the move. The rules live in
// chess/rules.ts and the machine player in chess/engine.ts; this file
// turns keys into moves and moves into cells.

import type { CrtScreen } from '@cyberspace/crt'
import type { Sound } from '@cyberspace/crt/audio'
import { RENDER } from '@cyberspace/crt/config'
import {
  BG, BOLD, BRIGHT, DIM, FAINT, MUTED, NORMAL, InputLine, ScreenStack, SelectPopup, clear, drawLog, frame,
  cells, hangingWrap, shadow, type Grid, type KeyInput, type LogLine, type Rect, type Screen, type Span,
} from '@cyberspace/tui'
import { grid } from './grid'
import type { Overlay } from './input'
import {
  applyMove, getMoves, getPiece, isCheck, newChessState,
  resultOf, sameSquare, timeoutResult,
  type Color, type GameResult, type Move, type Piece, type Square,
} from './chess/rules'
import { TIME_CONTROLS, formatClock, remaining, switchClock, timeLabel, type Clock } from './chess/clock'
import { ChessEngine } from './chess/engine'
import {
  PendingChessMultiplayer,
  type ChessInvite,
  type ChessMultiplayerGame,
  type ChessMultiplayerTransport,
  type ChatLine,
  type ChessRoomEvent,
  type LobbyView,
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

type Mode = 'menu' | 'lobby' | 'board'

const MENU = ['Play with Machine', 'Play with someone']
const COLOR_MENU = ['Random', 'White', 'Black']
/** Index + 1 is the js-chess-engine level. */
const LEVEL_MENU = ['Easy', 'Medium', 'Hard', 'Expert', 'Master']
const MACHINE_DELAY = 350
/** Characters per chat line, about five rows of the side panel. The chess room cuts at the same length. */
const CHAT_MAX = 120
/** Chat lines kept for a game. The lobby keeps its own 50 on the server. */
const GAME_CHAT = 50
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
  /** js-chess-engine level, 1 to 5. Kept for the session so the picker reopens on the last choice. */
  private level = 3
  private gameMode: 'machine' | 'multiplayer' = 'machine'
  private multiplayerGame: ChessMultiplayerGame | null = null
  private stopWatchingMultiplayer: (() => void) | null = null
  private stopWatchingRoom: (() => void) | null = null
  private readonly incomingInviteIds = new Set<string>()
  private readonly pendingInvites = new Map<string, ChessInvite>()
  private activeInvite: ChessInvite | null = null
  private activeOpponentName = ''
  private whitePlayerName = 'White'
  private blackPlayerName = 'Black'
  private roomCard: ChessCard | null = null
  private endgameShown = false
  private state = newChessState()
  private cursor: Square = { row: 6, col: 4 }
  private selected: Square | null = null
  private moves: Move[] = []
  /** Where the machine's last move landed, filled FAINT. Cleared by the player's next move. */
  private lastMachineMove: Square | null = null
  private thinking = false
  private engine: ChessEngine | null = null
  private machineRequest = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Time control for the next game, ms per side. Kept for the session. */
  private timeMs = 0
  private clock: Clock | null = null
  /** A result the board cannot show: a loss on time. Null while the position decides. */
  private override: GameResult | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  /** Clock text at the last paint, so the ticker paints only when a digit changes. */
  private clockShown = ''
  /** Where the last board draw put the clock text, so the ticker can rewrite those cells alone. */
  private clockSlots: { x: number; y: number; w: number; text: () => string; attr: () => number }[] = []
  private waitingCard: ChessCard | null = null
  private note = ''
  private art: Partial<Record<ArtName, ImageBitmap>> = {}
  private lobby: LobbyView = { users: [], chat: [], status: '' }
  private lobbyIndex = 0
  private stopWatchingLobby: (() => void) | null = null
  private gameChat: ChatLine[] = []
  /** Set by draw: the chat line is on screen and InputLine.draw has placed term.cx/cy on its caret. */
  private inputShown = false
  /** False while a card or popup is stacked above. */
  private active = true
  private readonly chatInput = new InputLine({ prompt: '> ', maxLength: CHAT_MAX, placeholder: 'chat', onReject: () => this.snd.beep(220, 0.04) })
  private artLoading = false
  private artLoaded = false

  constructor(
    private screen: CrtScreen,
    private snd: Sound,
    private multiplayer: ChessMultiplayerTransport = new PendingChessMultiplayer(),
    private onInviteNotice?: (invite: ChessInvite) => void,
  ) {
    this.multiplayer.watchInvites(invite => this.receiveInvite(invite))
    this.multiplayer.watchInviteResults(invite => this.handleInviteResult(invite))
  }

  /** Resolves the pending play() when the game screen closes. */
  private onClosed: (() => void) | null = null

  /** chess(1): opens the title card and resolves when Chess closes. */
  play(): Promise<void> {
    this.start()
    if (!this.open) return Promise.resolve()
    return new Promise(resolve => { this.onClosed = resolve })
  }

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
    this.ticker ??= setInterval(() => this.tickClock(), 50)
    this.multiplayer.online?.()
    const pending = this.pendingInvites.values().next().value as ChessInvite | undefined
    if (pending) {
      this.pendingInvites.delete(pending.inviteId)
      this.showIncomingInvite(pending)
    }
  }

  /** Keys reach the overlay through Keyboard's route, as the config box and DOOM do. */
  key(k: KeyInput): void {
    this.stack?.key(k)
  }

  silentKey(k: KeyInput): boolean {
    if (k.metaKey || k.ctrlKey || k.altKey) return false
    return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(k.key)
  }

  openInvite(invite: ChessInvite): void {
    if (!this.open) this.start()
    if (!this.open) {
      this.pendingInvites.set(invite.inviteId, invite)
      return
    }
    this.pendingInvites.delete(invite.inviteId)
    this.showIncomingInvite(invite)
  }

  onKey(e: KeyInput): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (this.mode === 'menu') return this.menuKey(e)
    if (this.mode === 'lobby') return this.lobbyKey(e)
    return this.boardKey(e)
  }

  draw(term: Grid): void {
    clear(term, { x: 0, y: 0, w: term.cols, h: term.rows })
    this.inputShown = false
    if (this.mode === 'lobby') this.drawLobby(term)
    else if (this.mode !== 'board') this.drawMenu(term)
    else {
      this.drawBoard(term)
      this.writeClocks(term)
    }
    this.syncCursor()
    term.dirty = true
  }

  setActive(active: boolean): void {
    this.active = active
    this.syncCursor()
  }

  /** The CRT's blinking block cursor shows on the chat line only. The screen loop copies RENDER.cursor to term.showCursor every frame. */
  private syncCursor(): void {
    RENDER.cursor = this.open && this.active && this.inputShown
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
    if (this.multiplayer.signedIn?.() === false) {
      const back = () => {
        this.stack?.pop()
        this.repaint()
      }
      this.stack?.push(new ChessCard(this.snd, 'MULTIPLAYER', 'Log in first', ['Back'], 0, back, back))
      return true
    }
    this.enterLobby()
    return true
  }

  private lobbyKey(e: KeyInput): boolean {
    if (e.key === 'Escape') {
      if (this.chatInput.value) this.chatInput.clear()
      else this.leaveLobby()
      this.repaint()
      return true
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const count = this.lobby.users.length
      if (!count) {
        this.snd.beep(220, 0.04)
        return true
      }
      const next = this.lobbyIndex + (e.key === 'ArrowUp' ? -1 : 1)
      if (next < 0 || next >= count) this.snd.beep(220, 0.04)
      else {
        this.lobbyIndex = next
        this.snd.tick()
      }
      this.repaint()
      return true
    }
    if (e.key === 'Enter') {
      const text = this.chatInput.value.trim()
      if (text && this.lobby.status) {
        this.snd.beep(220, 0.04)
        return true
      }
      if (text) {
        this.multiplayer.sendLobbyChat?.(text)
        this.chatInput.clear()
        this.repaint()
        return true
      }
      const user = this.lobby.users[this.lobbyIndex]
      if (!user) this.snd.beep(220, 0.04)
      else this.openTimePicker('TIME', ms => this.sendMultiplayerInvite(user, ms), () => this.repaint())
      return true
    }
    const handled = this.chatInput.onKey(e)
    if (handled) this.repaint()
    return handled
  }

  private boardKey(e: KeyInput): boolean {
    const chatting = this.gameMode === 'multiplayer'
    if (e.key === 'Escape') {
      if (chatting && this.chatInput.value) {
        this.chatInput.clear()
        this.repaint()
        return true
      }
      this.openQuitConfirmation()
      return true
    }
    if (chatting && e.key === 'Enter' && this.chatInput.value.trim()) {
      this.multiplayerGame?.sendChat(this.chatInput.value.trim())
      this.chatInput.clear()
      this.repaint()
      return true
    }
    // Arrows stay with the board cursor; the chat line takes text and Backspace.
    if (chatting && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete')) {
      const handled = this.chatInput.onKey(e)
      if (handled) this.repaint()
      return handled
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
    if (this.thinking || this.result().over) {
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

  private result(): GameResult {
    return this.override ?? resultOf(this.state)
  }

  /** Runs every 50 ms while Chess is open: flags a machine game, rewrites the clock cells when a digit changes. */
  private tickClock(): void {
    if (this.mode !== 'board' || !this.clock?.running) return
    const running = this.clock.running
    // Online, the server flags and sends the result; the client only shows 0.0.
    if (this.gameMode === 'machine' && remaining(this.clock, running) <= 0) {
      this.clock = switchClock(this.clock, null)
      this.override = timeoutResult(this.state, running)
      this.stopMachine()
      this.note = this.override.text
      this.snd.beep(330, 0.2)
      this.showEndgame(this.override)
      return
    }
    if (this.clockText() !== this.clockShown) this.paintClocks()
  }

  /** Rewrites only the clock cells. A full repaint redraws every piece and is too slow at 10 per second. */
  private paintClocks(): void {
    if (!this.open || this.stack?.top !== this || this.mode !== 'board') return
    const term = this.screen.term as unknown as Grid
    this.writeClocks(term)
    term.dirty = true
  }

  private writeClocks(term: Grid): void {
    for (const slot of this.clockSlots) {
      for (let i = 0; i < slot.w; i++) term.put(slot.x + i, slot.y, ' ')
      term.text(slot.x, slot.y, slot.text().slice(0, slot.w), slot.attr())
    }
    this.clockShown = this.clockText()
  }

  private clockText(): string {
    if (!this.clock) return ''
    return `${formatClock(remaining(this.clock, 'white'))} ${formatClock(remaining(this.clock, 'black'))}`
  }

  /** After a move in a machine game: stop the mover, start the side to move, or stop both at the end. */
  private passClock(): void {
    if (this.clock) this.clock = switchClock(this.clock, this.result().over ? null : this.state.turn)
  }

  private openTimePicker(title: string, onPick: (ms: number) => void, onCancel: () => void): void {
    if (!this.stack) return
    this.stack.push(new SelectPopup({
      title,
      items: TIME_CONTROLS.map(t => t.label),
      selected: Math.max(0, TIME_CONTROLS.findIndex(t => t.ms === this.timeMs)),
      shadow: true,
      onFeedback: kind => {
        if (kind === 'move') this.snd.tick()
        else if (kind === 'edge') this.snd.beep(220, 0.04)
        else if (kind === 'cancel') this.snd.blip(420, 0.09, 0)
      },
      onDone: (item, index) => {
        this.stack?.pop()
        if (item === null) {
          onCancel()
          return
        }
        this.timeMs = TIME_CONTROLS[index]!.ms
        onPick(this.timeMs)
      },
    }))
  }

  private dismissWaiting(): void {
    if (this.waitingCard && this.stack?.top === this.waitingCard) this.stack.pop()
    this.waitingCard = null
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
        this.openLevelPicker()
      },
    }))
  }

  private openLevelPicker(): void {
    if (!this.stack) return
    this.stack.push(new SelectPopup({
      title: 'DIFFICULTY',
      items: LEVEL_MENU,
      selected: this.level - 1,
      shadow: true,
      onFeedback: kind => {
        if (kind === 'move') this.snd.tick()
        else if (kind === 'edge') this.snd.beep(220, 0.04)
        else if (kind === 'cancel') this.snd.blip(420, 0.09, 0)
      },
      onDone: (item, index) => {
        this.stack?.pop()
        if (item === null) {
          this.openColorPicker()
          return
        }
        this.level = index + 1
        this.openTimePicker('TIME', () => this.newGame(), () => this.openLevelPicker())
      },
    }))
  }

  private enterLobby(): void {
    this.mode = 'lobby'
    this.chatInput.clear()
    this.multiplayer.online?.()
    this.stopWatchingLobby?.()
    this.stopWatchingLobby = this.multiplayer.watchLobby?.(view => {
      this.lobby = view
      this.lobbyIndex = Math.max(0, Math.min(this.lobbyIndex, view.users.length - 1))
      this.repaint()
    }) ?? null
    this.snd.tick()
    this.repaint()
  }

  private leaveLobby(): void {
    this.stopWatchingLobby?.()
    this.stopWatchingLobby = null
    this.chatInput.clear()
    this.mode = 'menu'
    this.snd.blip(420, 0.09, 0)
  }

  private sendMultiplayerInvite(friend: MultiplayerFriend, timeMs: number): void {
    let card!: ChessCard
    const cancel = () => {
      this.stack?.pop()
      this.repaint()
    }
    const closeCard = () => {
      this.stack?.pop()
      this.repaint()
    }
    const name = friend.displayName ?? friend.username ?? friend.userId
    card = new ChessCard(this.snd, 'CHALLENGE', `Challenge ${name}? ${timeLabel(timeMs)}`, ['Send', 'Back'], 0, action => {
      if (action === 'Back') {
        cancel()
        return
      }
      void this.multiplayer.sendInvite(friend.userId, 'random', timeMs).then(invite => this.multiplayer.openGame(invite).then(game => ({ invite, game }))).then(({ invite, game }) => {
        if (!this.open || this.stack?.top !== card) return
        this.stack.pop()
        this.activeInvite = invite
        this.activeOpponentName = name
        this.startMultiplayerGame(game)
        // Until the other player joins: dismissed by the first active snapshot, a decline, or Cancel.
        const cancel = () => {
          this.waitingCard = null
          this.stack?.pop()
          this.toMenu()
        }
        this.waitingCard = new ChessCard(this.snd, 'CHALLENGE', `Waiting for ${name} to accept`, ['Cancel'], 0, cancel, cancel)
        this.stack.push(this.waitingCard)
      }).catch(() => {
        if (!this.open || this.stack?.top !== card) return
        this.stack.pop()
        this.stack.push(new ChessCard(this.snd, 'MULTIPLAYER', 'Player offline', ['Back'], 0, closeCard, closeCard))
      })
    }, cancel)
    this.stack?.push(card)
  }

  private receiveInvite(invite: ChessInvite): void {
    if (this.pendingInvites.has(invite.inviteId) || this.incomingInviteIds.has(invite.inviteId)) return
    if (this.open) {
      this.showIncomingInvite(invite)
      return
    }
    this.pendingInvites.set(invite.inviteId, invite)
    this.onInviteNotice?.(invite)
  }

  private showIncomingInvite(invite: ChessInvite): void {
    if (!this.open || this.incomingInviteIds.has(invite.inviteId)) return
    this.incomingInviteIds.add(invite.inviteId)
    const from = inviteFromName(invite)
    let card!: ChessCard
    const respond = (accept: boolean) => {
      if (this.stack?.top === card) this.stack.pop()
      if (accept) {
        this.activeInvite = invite
        this.activeOpponentName = from
      }
      void this.multiplayer.answerInvite(invite.inviteId, accept).then(game => {
        if (game && this.open) this.startMultiplayerGame(game)
      }).catch(() => {
        if (this.open) {
          const back = () => {
            this.stack?.pop()
            this.repaint()
          }
          this.stack?.push(new ChessCard(this.snd, 'CHESS INVITE', 'Invite expired', ['Back'], 0, back, back))
        }
      }).finally(() => this.incomingInviteIds.delete(invite.inviteId))
    }
    card = new ChessCard(this.snd, 'CHALLENGE', `${from} wants to play. ${timeLabel(invite.timeMs ?? 0)}`, ['Accept', 'Decline'], 0,
      option => respond(option === 'Accept'),
      () => respond(false))
    this.stack?.push(card)
  }

  private handleInviteResult(invite: ChessInvite): void {
    if (invite.status !== 'declined' || this.activeInvite?.inviteId !== invite.inviteId || !this.multiplayerGame) return
    this.dismissWaiting()
    // A declined request ends the inviter's waiting game instead of leaving it stalled.
    this.closeMultiplayerGame()
    this.activeInvite = null
    this.gameMode = 'machine'
    this.enterLobby()
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
    card = new ChessCard(this.snd, 'INVITE DECLINED', `${opponent} declined`, ['Back'], 0, close, close)
    this.stack?.push(card)
  }

  private handleRoomEvent(event: ChessRoomEvent): void {
    if (!this.multiplayerGame) return
    if (event.type === 'chat' || event.type === 'notice') {
      const line = event.type === 'chat' ? event.line : { userId: '', userName: '', text: event.text, at: Date.now() }
      this.gameChat = [...this.gameChat, line].slice(-GAME_CHAT)
      if (event.type === 'chat') this.snd.blip(1800, 0.02, 0)
      this.repaint()
      return
    }
    if (event.type === 'left') {
      const name = event.userName || event.userId
      this.closeMultiplayerGame()
      this.activeInvite = null
      this.activeOpponentName = ''
      this.gameMode = 'machine'
      this.enterLobby()
      this.thinking = false
      this.clearSelection()
      while (this.stack?.top && this.stack.top !== this) this.stack.pop()
      this.repaint()
      this.showRoomNotice('ROOM CLOSED', `${name} left`)
      return
    }
    if (event.type === 'rematch-request') {
      this.showRematchRequest(event)
      return
    }
    if (event.accepted) {
      while (this.stack?.top && this.stack.top !== this) this.stack.pop()
      this.roomCard = null
      this.endgameShown = false
      this.mode = 'board'
      this.note = ''
      this.clearSelection()
      this.repaint()
      return
    }
    if (this.roomCard && this.stack?.top === this.roomCard) this.stack.pop()
    this.roomCard = null
    const name = event.userName || event.userId
    this.closeMultiplayerGame()
    this.activeInvite = null
    this.activeOpponentName = ''
    this.gameMode = 'machine'
    this.enterLobby()
    this.thinking = false
    this.clearSelection()
    while (this.stack?.top && this.stack.top !== this) this.stack.pop()
    this.repaint()
    this.showRoomNotice('REMATCH DECLINED', `${name} declined the rematch`)
  }

  private showRematchRequest(event: Extract<ChessRoomEvent, { type: 'rematch-request' }>): void {
    if (this.roomCard || !this.multiplayerGame) return
    let card!: ChessCard
    const respond = (accept: boolean) => {
      if (!this.multiplayerGame) return
      this.multiplayerGame.answerRematch(event.requestId, accept)
      if (!accept) {
        if (this.stack?.top === card) this.stack.pop()
        this.roomCard = null
      }
    }
    card = new ChessCard(this.snd, 'REMATCH REQUEST', `${event.userName} wants a rematch.`, ['Accept', 'Decline'], 0,
      option => respond(option === 'Accept'),
      () => respond(false))
    this.roomCard = card
    this.stack?.push(card)
  }

  private requestRematch(): void {
    if (!this.multiplayerGame || this.roomCard) return
    this.multiplayerGame.requestRematch()
    const opponent = this.playerColor === 'white' ? this.blackPlayerName : this.whitePlayerName
    let card!: ChessCard
    const cancel = () => {
      if (this.stack?.top === card) this.stack.pop()
      this.toMenu()
    }
    card = new ChessCard(this.snd, 'REMATCH SENT', `Waiting for ${opponent} to accept.`, ['Cancel'], 0, cancel, cancel)
    this.roomCard = card
    this.stack?.push(card)
  }

  private showRoomNotice(title: string, message: string): void {
    let card!: ChessCard
    const close = () => {
      this.stack?.pop()
      this.repaint()
    }
    card = new ChessCard(this.snd, title, message, ['Back'], 0, close, close)
    this.stack?.push(card)
  }

  private playMove(move: Move): void {
    this.ownMoveSound()
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
    this.lastMachineMove = null
    this.clearSelection()
    this.passClock()

    const result = this.result()
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
      this.engine ??= new ChessEngine()
      const move = await this.engine.chooseMove(this.state, this.level)
      if (request !== this.machineRequest || !this.open || this.mode !== 'board') return
      this.thinking = false
      if (!move) {
        const result = this.result()
        this.note = result.text
        if (result.over) this.showEndgame(result)
      } else {
        this.state = applyMove(this.state, move)
        // The cursor stays where the player left it.
        this.lastMachineMove = move.to
        this.theirMoveSound()
        this.passClock()
        const result = this.result()
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
    this.override = null
    this.lastMachineMove = null
    this.clock = this.timeMs ? { white: this.timeMs, black: this.timeMs, running: 'white', at: performance.now() } : null
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
    this.clock = null
    this.override = null
    this.whitePlayerName = 'White'
    this.blackPlayerName = 'Black'
    this.mode = 'board'
    this.clearSelection()
    this.endgameShown = false
    this.cursor = { row: 6, col: 4 }
    this.stopWatchingRoom = game.watchRoomEvents(event => this.handleRoomEvent(event))
    let revision = game.snapshot.revision
    this.gameChat = []
    this.chatInput.clear()
    this.multiplayer.setPlaying?.(true)
    this.stopWatchingMultiplayer = game.watch(snapshot => {
      if (this.multiplayerGame !== game) return
      // A new revision with the turn back on this side is the opponent's move.
      if (snapshot.revision > revision && snapshot.state.turn === (snapshot.playerColor ?? game.playerColor)) this.theirMoveSound()
      revision = snapshot.revision
      this.state = snapshot.state
      this.clock = snapshot.clock ? { ...snapshot.clock, at: performance.now() } : null
      // The server's result covers a loss on time, which the position alone cannot show.
      this.override = snapshot.status === 'finished' && snapshot.result ? { over: true, text: snapshot.result } : null
      if (snapshot.status !== 'waiting') this.dismissWaiting()
      this.whitePlayerName = snapshot.whiteName ?? this.whitePlayerName
      this.blackPlayerName = snapshot.blackName ?? this.blackPlayerName
      this.playerColor = snapshot.playerColor ?? game.playerColor
      if (snapshot.playerColor === 'black' && this.cursor.row === 6 && this.cursor.col === 4) this.cursor = { row: 1, col: 4 }
      this.thinking = snapshot.status === 'waiting' || (snapshot.status === 'active' && snapshot.state.turn !== this.playerColor)
      const opponentName = this.activeOpponentName || (this.playerColor === 'white' ? this.blackPlayerName : this.whitePlayerName)
      this.note = snapshot.status === 'waiting'
        ? `waiting for ${shortPlayerName(opponentName)}...`
        : snapshot.status === 'active' && snapshot.state.turn !== this.playerColor
          ? `${shortPlayerName(opponentName)} is thinking...`
          : ''
      const result = this.result()
      if (result.over && !this.endgameShown) {
        this.note = result.text
        this.showEndgame(result)
      }
      this.repaint()
    })
    this.snd.tick()
    this.repaint()
  }

  // Square-wave beeps, not blips: blip shares the cursor tick's voice at 0.04 gain and is dropped within BLIP_MS of another blip.
  /** 880 Hz, 60 ms. The cursor tick is a 2500 Hz blip. */
  private ownMoveSound(): void {
    this.snd.beep(880, 0.06)
  }

  /** 440 Hz, 90 ms: an octave below the operator's own move and longer. */
  private theirMoveSound(): void {
    this.snd.beep(440, 0.09)
  }

  private toMenu(): void {
    const wasOnline = this.gameMode === 'multiplayer'
    this.closeMultiplayerGame(true)
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
    if (wasOnline) this.enterLobby()
    this.repaint()
  }

  private close(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.stopWatchingLobby?.()
    this.stopWatchingLobby = null
    this.closeMultiplayerGame()
    this.stopMachine()
    while (this.stack?.active) this.stack.pop()
    grid.unlock()
    RENDER.cursor = this.cursorWas
    this.snd.blip(420, 0.09, 0)
    this.onClosed?.()
    this.onClosed = null
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

  private closeMultiplayerGame(notifyLeave = false): void {
    if (this.multiplayerGame) this.multiplayer.setPlaying?.(false)
    this.stopWatchingMultiplayer?.()
    this.stopWatchingMultiplayer = null
    this.stopWatchingRoom?.()
    this.stopWatchingRoom = null
    if (notifyLeave) this.multiplayerGame?.leave()
    else this.multiplayerGame?.close()
    this.multiplayerGame = null
    this.roomCard = null
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
          term.put(x, button.y + 1, ' ', DIM | BOLD, 1)
        }
      }
      term.text(button.x + 2, button.y + 1, label, selected ? DIM | BOLD : MUTED, selected ? 1 : 0)
    })
    footer(term, [cap(ARROWS, 'Select'), cap('↵', 'Choose'), cap('ESC', 'Exit')])
  }

  private drawLobby(term: Grid): void {
    center(term, 1, 'CHESS LOBBY', BOLD | BRIGHT)
    const top = 3
    const inputY = term.rows - 4
    const narrow = term.cols < 60
    const listW = narrow ? term.cols - 4 : Math.min(28, Math.floor(term.cols / 3))
    const listH = narrow ? Math.min(6, Math.max(1, this.lobby.users.length)) : inputY - top - 1
    const list: Rect = { x: 2, y: top + 2, w: listW, h: listH }
    const chatX = narrow ? 2 : list.x + list.w + 3
    const chatTop = narrow ? list.y + list.h + 1 : top
    const chat: Rect = { x: chatX, y: chatTop + 2, w: term.cols - chatX - 2, h: Math.max(1, inputY - chatTop - 3) }

    term.text(2, top, 'PLAYERS', BOLD | BRIGHT)
    if (this.lobby.status) term.text(list.x, list.y, this.lobby.status.slice(0, list.w), MUTED)
    else if (!this.lobby.users.length) term.text(list.x, list.y, 'Nobody else here'.slice(0, list.w), MUTED)
    const first = Math.max(0, Math.min(this.lobbyIndex - list.h + 1, this.lobby.users.length - list.h))
    this.lobby.users.slice(first, first + list.h).forEach((user, i) => {
      const on = first + i === this.lobbyIndex
      const tag = user.status === 'playing' ? 'playing' : ''
      const name = (user.displayName ?? user.username ?? user.userId).slice(0, Math.max(1, list.w - tag.length - 2))
      const row = ` ${name}`.padEnd(list.w - tag.length - 1) + tag + ' '
      // DIM inverse with BOLD text, as SelectPopup marks its selected row.
      term.text(list.x, list.y + i, row.slice(0, list.w), on ? DIM | BOLD : tag ? MUTED : NORMAL, on ? 1 : 0)
    })

    term.text(chatX, chatTop, 'CHAT', BOLD | BRIGHT)
    drawLog(term, chat, chatLog(this.lobby.chat, this.lobby.me, chat.w))
    this.chatInput.draw(term, { x: chatX, y: inputY, w: chat.w, h: 1 })
    this.inputShown = true
    footer(term, this.chatInput.value
      ? [cap('↵', 'Send'), cap('ESC', 'Clear')]
      : [cap(ARROWS, 'Select'), cap('↵', 'Challenge'), cap('ESC', 'Back')])
  }

  /** In-game chat: log above the input line, both inside `r`. With one row, only the input line. */
  private drawGameChat(term: Grid, r: Rect): void {
    if (r.h < 1 || r.w < 8) return
    this.inputShown = true
    if (r.h === 1) {
      this.chatInput.draw(term, r)
      return
    }
    const me = this.playerColor === 'white' ? this.multiplayerGame?.snapshot.whiteUserId : this.multiplayerGame?.snapshot.blackUserId
    drawLog(term, { ...r, h: r.h - 1 }, chatLog(this.gameChat, me, r.w))
    this.chatInput.draw(term, { x: r.x, y: r.y + r.h - 1, w: r.w, h: 1 })
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
    const title = this.gameMode === 'multiplayer'
      ? `${shortPlayerName(this.whitePlayerName)} vs. ${shortPlayerName(this.blackPlayerName)}`
      : 'CHESS'
    center(term, wide ? board.y - 1 : 1, title, BOLD | BRIGHT)

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
      term.put(centerX, filesY, 'ABCDEFGH'[this.playerColor === 'white' ? col : 7 - col]!, MUTED)
    }

    const result = this.result()
    this.clockSlots = []
    if (wide) {
      this.drawStatus(term, board.x + board.w + gap, board.y + 1, panelW, result)
      // Online, the left panel is chat and the controls move to one hint row: beside a 2-row board the controls leave no room for chat.
      if (this.gameMode === 'multiplayer') {
        term.text(margin, board.y + 1, 'CHAT', BOLD | BRIGHT)
        this.drawGameChat(term, { x: margin, y: board.y + 3, w: panelW, h: board.h - 3 })
      }
      this.drawBoardFooter(term, result.over)
      return
    }

    if (this.clock) {
      const line = () => this.clock
        ? `WHITE ${formatClock(remaining(this.clock, 'white')).padStart(5)}   BLACK ${formatClock(remaining(this.clock, 'black')).padStart(5)}`
        : ''
      const w = line().length
      this.clockSlots.push({ x: Math.max(0, Math.floor((term.cols - w) / 2)), y: 2, w, text: line, attr: () => BOLD })
    }
    const turn = result.over ? result.text : this.note || `${this.state.turn} to move`
    center(term, statusY, `${turn}  (you are ${this.playerColor})`, this.thinking ? MUTED : BOLD)
    if (!result.over && isCheck(this.state, this.state.turn)) {
      center(term, statusY + 1, 'check', BRIGHT)
    }
    // Between the status rows and the hint row, input on the last of them.
    if (this.gameMode === 'multiplayer') {
      this.drawGameChat(term, { x: 2, y: statusY + 2, w: term.cols - 4, h: term.rows - 3 - (statusY + 2) + 1 })
    }
    this.drawBoardFooter(term, result.over)
  }

  private drawBoardFooter(term: Grid, over: boolean): void {
    if (this.chatInput.value) footer(term, [cap('↵', 'Send'), cap('ESC', 'Clear')])
    else if (over) footer(term, [cap('ESC', 'Quit')])
    else footer(term, [cap(ARROWS, 'Move'), cap('↵', 'Play'), cap('ESC', 'Quit')])
  }

  private drawStatus(term: Grid, x: number, y: number, width: number, result: ReturnType<typeof resultOf>): void {
    term.text(x, y, 'STATUS', MUTED)
    let row = y + 1
    const status = result.over ? result.text : this.note || `${this.state.turn} to move`
    row = writeLines(term, x, row, width, status.toUpperCase(), result.over ? BRIGHT : BOLD) + 1

    if (!result.over && isCheck(this.state, this.state.turn)) {
      term.text(x, row, 'CHECK', BRIGHT)
      row += 2
    }
    if (this.clock) {
      term.text(x, row, 'CLOCK', MUTED)
      for (const color of ['white', 'black'] as const) {
        row++
        this.clockSlots.push({
          x, y: row, w: Math.min(width, 12),
          text: () => this.clock ? `${color.toUpperCase().padEnd(6)}${formatClock(remaining(this.clock, color)).padStart(6)}` : '',
          attr: () => this.clock?.running === color ? BOLD | BRIGHT : MUTED,
        })
      }
      row += 2
    }

    term.text(x, row, 'CURSOR', MUTED)
    term.text(x, row + 1, squareName(this.cursor).toUpperCase(), BOLD)
    term.text(x, row + 3, `You are ${this.playerColor}`.slice(0, width), MUTED)
  }

  private showEndgame(result: GameResult): void {
    if (this.endgameShown) return
    this.endgameShown = true
    const match = /^(white|black) wins (by checkmate|on time)$/.exec(result.text)
    const winner = match?.[1] as Color | undefined
    const onTime = match?.[2] === 'on time'
    const title = !winner ? 'GAME OVER' : onTime ? 'TIME' : 'CHECKMATE'
    const winnerName = winner === 'white' ? this.whitePlayerName : winner === 'black' ? this.blackPlayerName : ''
    const message = winner
      ? `${winnerName} wins ${match![2]}. ${winner === this.playerColor ? 'You won!' : 'You lost!'}`
      : 'Draw game.'
    const restart = this.gameMode === 'multiplayer' ? () => this.requestRematch() : () => this.newGame()
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
    const resumeMachine = !resultCardUnderneath && this.mode === 'board' && !this.result().over && this.state.turn !== this.playerColor
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
    const machineMoved = !!this.lastMachineMove && sameSquare(this.lastMachineMove, square)
    const check = piece?.kind === 'king' && piece.color === this.state.turn && isCheck(this.state, this.state.turn)

    const dark = (square.row + square.col) % 2 === 1
    const squareAttr = dark ? BG : NORMAL
    // The picked-up piece and a king in check are full bright; the roaming cursor is DIM until Enter picks a piece.
    const highlight = selected || check ? BOLD | BRIGHT
      : cursor ? DIM | BOLD
      : target ? FAINT
      : machineMoved ? FAINT
      : null
    // The machine's last piece keeps its normal look on a FAINT field, through the glyph's faint plane rather than inverse.
    const faintField = machineMoved && highlight === FAINT && !target
    const marked = highlight !== null && !faintField
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        term.put(x + dx, y + dy, ' ', marked ? highlight : squareAttr, marked ? 1 : 0)
      }
    }
    const image = piece ? this.art[`${piece.color}-${piece.kind}`] : undefined
    if (piece && image) {
      // On the FAINT field a DIM black piece has too little contrast, so it is drawn bright; the outline style still tells the colours apart.
      const pieceAttr = marked ? highlight : faintField || piece.color === 'white' ? BOLD | BRIGHT : DIM
      const style = piece.color === 'white' ? 'solid' : 'outline'
      drawSvg(term, image, x, y, width, height,
        pieceAttr | (dark ? BG : 0), marked ? 1 : 0, style, faintField)
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
    // Border plus two blank columns each side.
    const messageLines = wrapText(this.message, Math.max(1, width - 6))
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
    // Centred in the panel, not the screen: the panel sits half a column left of screen centre.
    messageLines.forEach((line, index) => term.text(panel.x + Math.floor((panel.w - line.length) / 2), panel.y + 2 + index, line, BOLD | BRIGHT))

    const optionsY = panel.y + 3 + messageLines.length
    if (horizontal) {
      const row = labels.join('  ')
      let x = panel.x + Math.max(1, Math.floor((panel.w - row.length) / 2))
      labels.forEach((label, index) => {
        term.text(x, optionsY, label, index === this.selected ? DIM | BOLD : MUTED, index === this.selected ? 1 : 0)
        x += label.length + 2
      })
    } else {
      labels.forEach((label, index) => {
        term.text(panel.x + 2, optionsY + index, label, index === this.selected ? DIM | BOLD : MUTED, index === this.selected ? 1 : 0)
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
  attr: number, inverse = 0, style: PieceStyle = 'solid', faintField = false,
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

  // Three planes per cell (main, faint, ground; see CellGrid.putGlyph): every pixel the piece leaves unlit shows at FAINT.
  const full = (1 << font.cellW) - 1
  for (let cy = 0; cy < sprite.rows; cy++) {
    for (let cx = 0; cx < sprite.cols; cx++) {
      const bits = sprite.cells[cy * sprite.cols + cx]
      if (faintField) {
        const planes = new Uint16Array(font.cellH * 3)
        if (bits) planes.set(bits)
        planes.fill(full, font.cellH, font.cellH * 2)
        putGlyph.call(surface, x + cx, y + cy, planes, attr, 0)
      } else if (bits) putGlyph.call(surface, x + cx, y + cy, bits, attr, inverse)
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

function shortPlayerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 12) || 'Player'
}

function inviteFromName(invite: ChessInvite): string {
  return invite.fromName || invite.fromUserId
}

/**
 * Chat as log lines wrapped to `width`: the name on its own row (BOLD for this player), the text under it.
 * Consecutive lines from one sender share the name row. Server notices are MUTED with no name.
 */
function chatLog(lines: ChatLine[], me: string | undefined, width: number): LogLine[] {
  const out: LogLine[] = []
  let last = ''
  for (const line of lines) {
    if (line.userId && line.userId !== last) out.push({ text: line.userName.slice(0, width), attr: line.userId === me ? BOLD | BRIGHT : BOLD })
    last = line.userId
    // Cut again on display: the room enforces CHAT_MAX, but a line from an older room or a modified client may not.
    for (const text of hangingWrap('', line.text.slice(0, CHAT_MAX), width)) out.push({ text, attr: line.userId ? NORMAL : MUTED })
  }
  return out
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

/** Arrow keycap, as cIRC and feed print it. */
const ARROWS = '⬆⬇'

/** A key hint group: the key as an inverse DIM keycap, then its word. The style cIRC, feed and browse use on their frames. */
function cap(key: string, word: string): Span[] {
  return [{ text: ` ${key} `, inverse: true, attr: DIM }, { text: ` ${word} ` }]
}

/** Key hints on the bottom row, right-aligned. Groups are dropped from the left until the row fits, as cIRC does. */
function footer(term: Grid, groups: Span[][]): void {
  const kept = groups.slice()
  const width = () => kept.flat().reduce((n, span) => n + cells(span.text), 0)
  while (kept.length > 1 && width() > term.cols - 2) kept.shift()
  let x = Math.max(0, term.cols - 1 - width())
  const y = term.rows - 1
  for (const span of kept.flat()) {
    term.text(x, y, span.text, span.attr ?? NORMAL, span.inverse ? 1 : 0)
    x += cells(span.text)
  }
}
