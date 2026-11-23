import type * as Party from 'partykit/server'
import {
  applyMove,
  getMoves,
  newChessState,
  resultOf,
  sameSquare,
  type ChessState,
  type Color,
  type Move,
} from '../app/src/chess/rules'

/*
 * I used PartyKit here to get a working multiplayer room for the chess demo.
 * I haven't seen how you wire multiplayer into the graffiti and grid services,
 * so I left this as a standalone boilerplate instead of guessing at that part.
 *
 * The lobby handles online users and invites. Once an invite is accepted, both
 * clients join a room that owns the board, validates moves, and sends the same
 * state to both players.
 *
 * You can replace the lobby with the real follower and invite API, then keep
 * this room protocol or move it into your own realtime layer. The demo accepts
 * the browser supplied identity only for local testing; production should
 * verify the session on the server.
 */
const LOBBY_ROOM = 'chess-demo-lobby'

type ChessInvite = {
  inviteId: string
  gameId: string
  fromUserId: string
  toUserId: string
  status: 'pending' | 'accepted' | 'declined'
  requestedColor?: Color
  createdAt: string
}
type LobbyUser = { userId: string; username?: string; displayName?: string }
type LobbyPlayer = { user: LobbyUser; connection: Party.Connection }
type Player = { userId: string; userName: string; color: Color }
type JoinMessage = { type: 'join'; userId: string; userName?: string }
type MoveMessage = { type: 'move'; revision: number; move: Move }
type ClientMessage = JoinMessage | MoveMessage
type RematchRequest = { requestId: string; fromConnectionId: string; toConnectionId: string }

export default class Chess implements Party.Server {
  private state: ChessState = newChessState()
  private revision = 0
  private readonly players = new Map<string, Player>()
  private readonly rematchRequests = new Map<string, RematchRequest>()
  private readonly lobbyPlayers = new Map<string, LobbyPlayer>()
  private readonly pendingInvites = new Map<string, { fromConnectionId: string; invite: ChessInvite }>()

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection): void {
    connection.send(JSON.stringify({ type: 'ready', roomId: this.room.id }))
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection): void {
    if (typeof message !== 'string') return
    let input: Record<string, unknown>
    try {
      input = JSON.parse(message) as Record<string, unknown>
    } catch {
      this.error(sender, 'INVALID MESSAGE')
      return
    }

    if (this.room.id === LOBBY_ROOM) {
      this.lobbyMessage(input, sender)
      return
    }
    if (input.type === 'join') {
      this.join(input as unknown as JoinMessage, sender)
      return
    }
    if (input.type === 'move') this.move(input as unknown as MoveMessage, sender)
    if (input.type === 'rematch') this.rematch(input, sender)
    if (input.type === 'leave') this.leave(sender)
  }

  onClose(connection: Party.Connection): void {
    const player = this.players.get(connection.id)
    if (player) this.broadcastRoomEvent({ type: 'left', userId: player.userId, userName: player.userName }, connection.id)
    this.players.delete(connection.id)
    this.clearRematches(connection.id)
    this.lobbyPlayers.delete(connection.id)
    for (const [id, pending] of this.pendingInvites) {
      if (pending.fromConnectionId === connection.id) this.pendingInvites.delete(id)
    }
    if (this.room.id === LOBBY_ROOM) this.broadcastPresence()
    else this.broadcastState()
  }

  /*
   * This lobby is my local stand in for the friends and invite API. It only
   * handles presence, invite delivery, and the accept or decline response.
   * These handlers are the part to replace once your real API endpoints exist.
   */
  private lobbyMessage(input: Record<string, unknown>, sender: Party.Connection): void {
    if (input.type === 'lobby:join') {
      const user = input.user as LobbyUser | undefined
      if (!user || typeof user.userId !== 'string' || !user.userId.trim()) {
        this.lobbyError(sender, input.requestId, 'INVALID USER')
        return
      }
      const clean: LobbyUser = {
        userId: user.userId.trim().slice(0, 160),
        username: typeof user.username === 'string' ? user.username.trim().slice(0, 64) : undefined,
        displayName: typeof user.displayName === 'string' ? user.displayName.trim().slice(0, 64) : undefined,
      }
      this.lobbyPlayers.set(sender.id, { user: clean, connection: sender })
      sender.send(JSON.stringify({ type: 'lobby:joined', users: this.onlineUsers(clean.userId) }))
      this.broadcastPresence()
      return
    }

    const player = this.lobbyPlayers.get(sender.id)
    if (!player) {
      this.lobbyError(sender, input.requestId, 'JOIN REQUIRED')
      return
    }
    if (input.type === 'lobby:list') {
      sender.send(JSON.stringify({
        type: 'lobby:roster',
        requestId: input.requestId,
        users: this.onlineUsers(player.user.userId),
      }))
      return
    }
    if (input.type === 'lobby:invite') {
      this.sendLobbyInvite(input, player, sender)
      return
    }
    if (input.type === 'lobby:answer') {
      this.answerLobbyInvite(input, player, sender)
    }
  }

  private sendLobbyInvite(input: Record<string, unknown>, player: LobbyPlayer, sender: Party.Connection): void {
    const source = input.invite as Partial<ChessInvite> | undefined
    if (!source || typeof source.inviteId !== 'string' || typeof source.gameId !== 'string' || typeof source.toUserId !== 'string') {
      this.lobbyError(sender, input.requestId, 'INVALID INVITE')
      return
    }
    const recipient = [...this.lobbyPlayers.values()].find(item => item.user.userId === source.toUserId)
    if (!recipient || recipient.connection.id === sender.id) {
      this.lobbyError(sender, input.requestId, 'USER IS OFFLINE')
      return
    }
    const invite: ChessInvite = {
      inviteId: source.inviteId.slice(0, 80),
      gameId: source.gameId.slice(0, 80),
      fromUserId: player.user.userId,
      toUserId: recipient.user.userId,
      status: 'pending',
      requestedColor: source.requestedColor === 'white' || source.requestedColor === 'black' ? source.requestedColor : undefined,
      createdAt: new Date().toISOString(),
    }
    this.pendingInvites.set(invite.inviteId, { fromConnectionId: sender.id, invite })
    recipient.connection.send(JSON.stringify({ type: 'lobby:incoming', invite }))
    sender.send(JSON.stringify({ type: 'lobby:invite-sent', requestId: input.requestId, invite }))
  }

  private answerLobbyInvite(input: Record<string, unknown>, player: LobbyPlayer, sender: Party.Connection): void {
    const inviteId = typeof input.inviteId === 'string' ? input.inviteId : ''
    const pending = this.pendingInvites.get(inviteId)
    if (!pending || pending.invite.toUserId !== player.user.userId) {
      this.lobbyError(sender, input.requestId, 'INVITE NOT FOUND')
      return
    }
    const invite: ChessInvite = { ...pending.invite, status: input.accept === true ? 'accepted' : 'declined' }
    this.pendingInvites.delete(inviteId)
    const inviter = this.lobbyPlayers.get(pending.fromConnectionId)
    // Notify the inviter so a declined request can close its waiting game.
    inviter?.connection.send(JSON.stringify({ type: 'lobby:answer', invite }))
    sender.send(JSON.stringify({ type: 'lobby:answered', requestId: input.requestId, invite }))
  }

  private onlineUsers(exceptUserId: string): LobbyUser[] {
    const seen = new Set<string>()
    const users: LobbyUser[] = []
    for (const player of this.lobbyPlayers.values()) {
      if (player.user.userId === exceptUserId || seen.has(player.user.userId)) continue
      seen.add(player.user.userId)
      users.push(player.user)
    }
    return users
  }

  private broadcastPresence(): void {
    for (const player of this.lobbyPlayers.values()) {
      player.connection.send(JSON.stringify({
        type: 'lobby:presence',
        users: this.onlineUsers(player.user.userId),
      }))
    }
  }

  private lobbyError(connection: Party.Connection, requestId: unknown, message: string): void {
    connection.send(JSON.stringify({
      type: 'lobby:error',
      requestId: typeof requestId === 'string' ? requestId : undefined,
      error: message,
    }))
  }

  /*
   * After an invite is accepted, both clients connect to this room. I assign the
   * colors here and include the player names in each snapshot for the board UI.
   */
  private join(input: JoinMessage, sender: Party.Connection): void {
    if (this.players.has(sender.id)) {
      this.sendState(sender)
      return
    }
    if (this.players.size >= 2) {
      this.error(sender, 'ROOM FULL')
      return
    }
    const color: Color = [...this.players.values()].some(player => player.color === 'white') ? 'black' : 'white'
    const userId = input.userId.trim().slice(0, 160) || `guest-${sender.id}`
    const userName = typeof input.userName === 'string' && input.userName.trim()
      ? input.userName.trim().replace(/\s+/g, ' ').slice(0, 64)
      : userId
    this.players.set(sender.id, { userId, userName, color })
    this.broadcastState()
  }

  private leave(sender: Party.Connection): void {
    const player = this.players.get(sender.id)
    if (!player) return
    this.broadcastRoomEvent({ type: 'left', userId: player.userId, userName: player.userName }, sender.id)
    this.players.delete(sender.id)
    this.clearRematches(sender.id)
    this.broadcastState()
  }

  /*
   * Rematches use the same room after a finished game. I reset the board only
   * after the other player accepts, so declining keeps the finished result intact.
   */
  private rematch(input: Record<string, unknown>, sender: Party.Connection): void {
    const player = this.players.get(sender.id)
    if (!player || this.players.size !== 2 || !resultOf(this.state).over) return
    const action = input.action
    const requestId = typeof input.requestId === 'string' ? input.requestId.slice(0, 80) : ''
    if (!requestId) return
    if (action === 'request') {
      const opponent = [...this.players.keys()].find(id => id !== sender.id)
      if (!opponent) return
      this.rematchRequests.set(requestId, { requestId, fromConnectionId: sender.id, toConnectionId: opponent })
      const event = { type: 'rematch-request' as const, requestId, userId: player.userId, userName: player.userName }
      this.connection(opponent)?.send(JSON.stringify(event))
      return
    }
    if (action !== 'answer') return
    const pending = this.rematchRequests.get(requestId)
    if (!pending || pending.toConnectionId !== sender.id) return
    this.rematchRequests.delete(requestId)
    const requester = this.players.get(pending.fromConnectionId)
    if (!requester) return
    const accepted = input.accept === true
    this.connection(pending.fromConnectionId)?.send(JSON.stringify({
      type: 'rematch-result',
      requestId,
      accepted,
      userId: player.userId,
      userName: player.userName,
    }))
    if (accepted) {
      sender.send(JSON.stringify({
        type: 'rematch-result',
        requestId,
        accepted,
        userId: requester.userId,
        userName: requester.userName,
      }))
      this.state = newChessState()
      this.revision = 0
      this.broadcastState()
    }
  }

  private connection(id: string): Party.Connection | undefined {
    return [...this.room.getConnections()].find(connection => connection.id === id)
  }

  private broadcastRoomEvent(event: Record<string, unknown>, without?: string): void {
    const message = JSON.stringify(event)
    for (const connection of this.room.getConnections()) {
      if (connection.id !== without) connection.send(message)
    }
  }

  private clearRematches(connectionId: string): void {
    for (const [requestId, request] of this.rematchRequests) {
      if (request.fromConnectionId === connectionId || request.toConnectionId === connectionId) this.rematchRequests.delete(requestId)
    }
  }

  /*
   * The browser sends a move request, but the room decides whether it is legal.
   * The revision check stops an older client from applying a move over a newer
   * board. That server side validation should stay in the production version.
   */
  private move(input: MoveMessage, sender: Party.Connection): void {
    const player = this.players.get(sender.id)
    if (!player) {
      this.error(sender, 'JOIN REQUIRED')
      return
    }
    const status = this.players.size === 2 ? 'active' : 'waiting'
    if (status !== 'active') {
      this.error(sender, 'WAITING FOR OPPONENT')
      return
    }
    if (this.state.turn !== player.color) {
      this.error(sender, 'NOT YOUR TURN')
      return
    }
    if (input.revision !== this.revision) {
      this.error(sender, 'STALE POSITION')
      this.sendState(sender)
      return
    }
    const move = this.legalMove(input.move)
    if (!move) {
      this.error(sender, 'ILLEGAL MOVE')
      return
    }
    this.state = applyMove(this.state, move)
    this.revision++
    this.broadcastState()
  }

  private legalMove(request: Move): Move | null {
    const from = request.from
    const to = request.to
    if (!Number.isInteger(from?.row) || !Number.isInteger(from?.col) || !Number.isInteger(to?.row) || !Number.isInteger(to?.col)) return null
    const candidate = getMoves(this.state, from).find(move =>
      sameSquare(move.to, to)
      && (move.promotion ?? null) === (request.promotion ?? null)
      && (move.castle ?? null) === (request.castle ?? null)
      && (move.enPassant ?? false) === (request.enPassant ?? false))
    return candidate ?? null
  }

  private broadcastState(): void {
    for (const connection of this.room.getConnections()) this.sendState(connection)
  }

  private sendState(connection: Party.Connection): void {
    const player = this.players.get(connection.id)
    const result = resultOf(this.state)
    const status: 'waiting' | 'active' | 'finished' = result.over
      ? 'finished'
      : this.players.size === 2 ? 'active' : 'waiting'
    const white = [...this.players.values()].find(item => item.color === 'white')
    const black = [...this.players.values()].find(item => item.color === 'black')
    connection.send(JSON.stringify({
      type: 'state',
      snapshot: {
        gameId: this.room.id,
        revision: this.revision,
        state: this.state,
        whiteUserId: white?.userId ?? '',
        blackUserId: black?.userId ?? '',
        whiteName: white?.userName ?? '',
        blackName: black?.userName ?? '',
        playerColor: player?.color,
        status,
        result: result.over ? result.text : undefined,
      },
    }))
  }

  private error(connection: Party.Connection, message: string): void {
    connection.send(JSON.stringify({ type: 'error', error: message }))
  }
}
