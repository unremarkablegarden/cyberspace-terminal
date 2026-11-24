import { newChessState, type ChessState, type Color, type Move } from './rules'

export interface MultiplayerFriend {
  userId: string
  username?: string
  displayName?: string
  /** Lobby only: in a game or not. */
  status?: 'idle' | 'playing'
  /** Lobby only: the game room while playing, for watching. */
  gameId?: string
}

export interface ChatLine {
  userId: string
  userName: string
  text: string
  /** ms since the epoch, server clock. */
  at: number
}

export interface LobbyView {
  /** Everyone else in the lobby. */
  users: MultiplayerFriend[]
  chat: ChatLine[]
  /** Empty while connected, else why not: `Connecting...`, a sign-in or connection error. */
  status: string
  /** True while the socket is opening, so the status is a wait rather than an error. */
  connecting?: boolean
  /** This player's uid, when signed in. */
  me?: string
}

export type ChessInviteStatus = 'pending' | 'accepted' | 'declined' | 'expired'

export interface ChessInvite {
  inviteId: string
  gameId: string
  fromUserId: string
  /** Sender's username, set by the server. */
  fromName?: string
  toUserId: string
  status: ChessInviteStatus
  requestedColor?: Color
  /** ms per side, 0 untimed. See chess/clock.ts. */
  timeMs?: number
  createdAt?: string
}

export interface ChessGameSnapshot {
  gameId: string
  revision: number
  state: ChessState
  /** Moves so far in UCI (`e2e4`, `e7e8q`). See chess/san.ts replay(). */
  moves?: string[]
  whiteUserId: string
  blackUserId: string
  whiteName?: string
  blackName?: string
  playerColor?: Color
  status: 'waiting' | 'active' | 'finished' | 'abandoned'
  result?: string
  /** Connections watching the game. */
  watchers?: number
  /** Remaining ms per side as of when the server sent the snapshot. Absent in untimed games. */
  clock?: { white: number; black: number; running: Color | null }
}

export type ChessRoomEvent =
  | { type: 'left'; userId: string; userName: string }
  | { type: 'rematch-request'; requestId: string; userId: string; userName: string }
  | { type: 'rematch-result'; requestId: string; accepted: boolean; userId: string; userName: string }
  | { type: 'chat'; line: ChatLine }
  | { type: 'notice'; text: string }

export interface ChessMultiplayerGame {
  readonly snapshot: ChessGameSnapshot
  readonly playerColor: Color
  submitMove(move: Move): Promise<ChessGameSnapshot>
  watch(listener: (snapshot: ChessGameSnapshot) => void): () => void
  watchRoomEvents(listener: (event: ChessRoomEvent) => void): () => void
  requestRematch(): void
  sendChat(text: string): void
  answerRematch(requestId: string, accept: boolean): void
  leave(): void
  close(): void
}

// Online play behind one interface, so the board screens do not depend on the transport.
// Friends come from the API (followers). Presence, invites and games go through the `chess` party of the world Worker.
export interface ChessMultiplayerTransport {
  listFriends(): Promise<MultiplayerFriend[]>
  sendInvite(userId: string, color: Color | 'random', timeMs: number): Promise<ChessInvite>
  openGame(invite: ChessInvite): Promise<ChessMultiplayerGame>
  watchInvites(listener: (invite: ChessInvite) => void): () => void
  watchInviteResults(listener: (invite: ChessInvite) => void): () => void
  answerInvite(inviteId: string, accept: boolean): Promise<ChessMultiplayerGame | null>
  /** Joins the lobby so invites can arrive. Called when Chess opens. */
  online?(): void
  /** Lobby players and chat, current value first and then on every change. */
  watchLobby?(listener: (view: LobbyView) => void): () => void
  sendLobbyChat?(text: string): void
  /** Marks this player as in game `gameId` in the lobby list, or as idle with null. */
  setPlaying?(gameId: string | null): void
  /** Opens a game as a watcher: snapshots and chat arrive, moves and chat are refused by the room. */
  watchGame?(gameId: string): Promise<ChessMultiplayerGame>
  /** False when no account is logged in. */
  signedIn?(): boolean
}

export class MultiplayerApiPendingError extends Error {
  constructor() {
    super('MULTIPLAYER API PENDING')
    this.name = 'MultiplayerApiPendingError'
  }
}

export class PendingChessMultiplayer implements ChessMultiplayerTransport {
  async listFriends(): Promise<MultiplayerFriend[]> {
    return []
  }

  async sendInvite(_userId: string, _color: Color | 'random', _timeMs: number): Promise<ChessInvite> {
    throw new MultiplayerApiPendingError()
  }

  async openGame(_invite: ChessInvite): Promise<ChessMultiplayerGame> {
    throw new MultiplayerApiPendingError()
  }

  watchInvites(_listener: (invite: ChessInvite) => void): () => void {
    return () => {}
  }

  watchInviteResults(_listener: (invite: ChessInvite) => void): () => void {
    return () => {}
  }

  async answerInvite(_inviteId: string, _accept: boolean): Promise<ChessMultiplayerGame | null> {
    throw new MultiplayerApiPendingError()
  }
}

/** The `chess` party of the world Worker. The room checks the Firebase token and takes the uid from it. */
async function partyUrl(base: string, room: string, auth: PartyAuth): Promise<string> {
  const token = await auth.token()
  if (!token) throw new Error('Session expired, log in again')
  const url = new URL(base, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/parties/chess/${encodeURIComponent(room)}`
  url.searchParams.set('token', token)
  url.searchParams.set('username', auth.username() ?? '')
  return url.toString()
}

interface PartyAuth {
  token(): Promise<string | null>
  username(): string | null
}

const LOBBY_ROOM = 'lobby'

function newId(prefix: string): string {
  const value = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return `${prefix}-${value.slice(0, 20)}`
}

type LobbyMessage = {
  type?: string
  requestId?: string
  users?: MultiplayerFriend[]
  chat?: ChatLine[]
  line?: ChatLine
  invite?: ChessInvite
  error?: string
}

/** Presence, chat and invite delivery. Connects on first use, not at boot. */
class PartyKitLobbyClient {
  private socket: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private users: MultiplayerFriend[] = []
  private chat: ChatLine[] = []
  /** The game room this player is in, or null. Sent again after a reconnect. */
  private playing: string | null = null
  private failure = ''
  private readonly lobbyListeners = new Set<(view: LobbyView) => void>()
  private readonly incomingInvites = new Map<string, ChessInvite>()
  private readonly inviteListeners = new Set<(invite: ChessInvite) => void>()
  private readonly resultListeners = new Set<(invite: ChessInvite) => void>()
  private readonly requests = new Map<string, {
    resolve: (value: LobbyMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    private baseUrl: string,
    private auth: PartyAuth,
    private profile: () => MultiplayerFriend | null,
  ) {}

  online(): void {
    this.failure = ''
    this.emit()
    void this.connect().catch((e: unknown) => {
      this.failure = e instanceof Error ? e.message : String(e)
      this.emit()
    })
  }

  watchLobby(listener: (view: LobbyView) => void): () => void {
    this.lobbyListeners.add(listener)
    listener(this.view())
    return () => this.lobbyListeners.delete(listener)
  }

  sendChat(text: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'lobby:chat', text }))
  }

  setPlaying(gameId: string | null): void {
    this.playing = gameId
    if (this.socket?.readyState === WebSocket.OPEN) this.sendStatus(this.socket)
  }

  private sendStatus(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: 'lobby:status', playing: !!this.playing, gameId: this.playing ?? undefined }))
  }

  /** Whether the lobby socket is open. */
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private view(): LobbyView {
    const me = this.profile()?.userId
    const connecting = !this.connected && !this.failure && !!this.profile()
    const status = this.connected ? '' : this.failure || (connecting ? 'Connecting...' : 'Log in first')
    return { users: this.connected ? this.users.filter(user => user.userId !== me) : [], chat: this.chat, status, connecting, me }
  }

  private emit(): void {
    const view = this.view()
    for (const listener of this.lobbyListeners) listener(view)
  }

  async listUsers(): Promise<MultiplayerFriend[]> {
    await this.connect()
    const response = await this.request({ type: 'lobby:list' })
    this.users = response.users ?? this.users
    const me = this.profile()?.userId
    return this.users.filter(user => user.userId !== me)
  }

  watchInvites(listener: (invite: ChessInvite) => void): () => void {
    this.inviteListeners.add(listener)
    return () => this.inviteListeners.delete(listener)
  }

  watchInviteResults(listener: (invite: ChessInvite) => void): () => void {
    this.resultListeners.add(listener)
    return () => this.resultListeners.delete(listener)
  }

  async sendInvite(toUserId: string, color: Color | 'random', timeMs: number): Promise<ChessInvite> {
    const profile = this.profile()
    if (!profile) throw new Error('Log in first')
    await this.connect()
    const invite: ChessInvite = {
      inviteId: newId('invite'),
      gameId: newId('chess'),
      fromUserId: profile.userId,
      toUserId,
      status: 'pending',
      requestedColor: color === 'random' ? undefined : color,
      timeMs,
      createdAt: new Date().toISOString(),
    }
    const response = await this.request({ type: 'lobby:invite', invite })
    if (!response.invite) throw new Error('INVITE WAS NOT ACKNOWLEDGED')
    return response.invite
  }

  async answerInvite(inviteId: string, accept: boolean): Promise<ChessInvite | null> {
    await this.connect()
    const response = await this.request({ type: 'lobby:answer', inviteId, accept })
    const invite = response.invite ?? this.incomingInvites.get(inviteId) ?? null
    this.incomingInvites.delete(inviteId)
    return invite
  }

  private connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.connecting) return this.connecting
    const profile = this.profile()
    if (!profile) return Promise.reject(new Error('Log in first'))

    this.connecting = partyUrl(this.baseUrl, LOBBY_ROOM, this.auth).then(address => new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(address)
      this.socket = socket
      let settled = false
      const fail = (error: Error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      }
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'lobby:join', user: profile }))
      })
      socket.addEventListener('message', event => {
        let message: LobbyMessage
        try {
          message = JSON.parse(String(event.data)) as LobbyMessage
        } catch {
          return
        }
        if (message.type === 'lobby:joined') {
          this.users = message.users ?? []
          this.chat = message.chat ?? []
          // A reconnect during a game restores the status the server lost with the old socket.
          if (this.playing) this.sendStatus(socket)
          this.emit()
          if (!settled) {
            settled = true
            resolve()
          }
          return
        }
        if (message.type === 'lobby:presence') {
          this.users = message.users ?? this.users
          this.emit()
          return
        }
        if (message.type === 'lobby:chat' && message.line) {
          this.chat = [...this.chat, message.line].slice(-50)
          this.emit()
          return
        }
        if (message.type === 'lobby:incoming' && message.invite) {
          this.incomingInvites.set(message.invite.inviteId, message.invite)
          for (const listener of this.inviteListeners) listener(message.invite)
          return
        }
        if (message.type === 'lobby:answer' && message.invite) {
          for (const listener of this.resultListeners) listener(message.invite)
          return
        }
        if (message.requestId) {
          const pending = this.requests.get(message.requestId)
          if (!pending) return
          clearTimeout(pending.timer)
          this.requests.delete(message.requestId)
          if (message.type === 'lobby:error') pending.reject(new Error(message.error ?? 'MULTIPLAYER REQUEST FAILED'))
          else pending.resolve(message)
        }
      })
      socket.addEventListener('error', () => fail(new Error('Lobby: connection failed')))
      socket.addEventListener('close', () => {
        fail(new Error('Lobby: connection closed'))
        if (this.socket === socket) this.socket = null
        this.connecting = null
        this.emit()
        // Reconnect while the lobby screen is watching, for a server restart or a dropped network.
        if (this.lobbyListeners.size) setTimeout(() => { if (this.lobbyListeners.size && !this.socket) this.online() }, 2000)
        for (const [id, pending] of this.requests) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Lobby: connection closed'))
          this.requests.delete(id)
        }
      })
    })).finally(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) this.connecting = null
    })
    return this.connecting
  }

  private async request(message: Record<string, unknown>): Promise<LobbyMessage> {
    await this.connect()
    const requestId = newId('request')
    return new Promise<LobbyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId)
        reject(new Error('MULTIPLAYER REQUEST TIMED OUT'))
      }, 8000)
      this.requests.set(requestId, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ ...message, requestId }))
    })
  }
}

/*
 * This represents one realtime game connection. The room sends authoritative
 * snapshots, while the browser sends requests and renders the state it receives.
 */
class PartyKitChessGame implements ChessMultiplayerGame {
  private current: ChessGameSnapshot
  private readonly listeners = new Set<(snapshot: ChessGameSnapshot) => void>()
  private readonly roomListeners = new Set<(event: ChessRoomEvent) => void>()
  private readonly pending: Array<{
    resolve: (snapshot: ChessGameSnapshot) => void
    reject: (error: Error) => void
  }> = []
  private socket: WebSocket
  private closed = false

  /** `hello` is the first message: `join` to take a seat, `watch` to watch. */
  constructor(address: string, initial: ChessGameSnapshot, hello: Record<string, unknown>) {
    this.current = initial
    this.socket = new WebSocket(address)
    this.socket.addEventListener('open', () => {
      this.socket.send(JSON.stringify(hello))
    })
    this.socket.addEventListener('message', event => this.receive(String(event.data)))
    this.socket.addEventListener('error', () => this.fail(new Error('Game: connection failed')))
    this.socket.addEventListener('close', () => this.fail(new Error('Game: connection closed')))
  }

  get snapshot(): ChessGameSnapshot {
    return this.current
  }

  get playerColor(): Color {
    return this.current.playerColor ?? 'white'
  }

  submitMove(move: Move): Promise<ChessGameSnapshot> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Game: not connected'))
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.socket.send(JSON.stringify({ type: 'move', revision: this.current.revision, move }))
    })
  }

  watch(listener: (snapshot: ChessGameSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.current)
    return () => this.listeners.delete(listener)
  }

  watchRoomEvents(listener: (event: ChessRoomEvent) => void): () => void {
    this.roomListeners.add(listener)
    return () => this.roomListeners.delete(listener)
  }

  sendChat(text: string): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'chat', text }))
  }

  requestRematch(): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'rematch', action: 'request', requestId: newId('rematch') }))
  }

  answerRematch(requestId: string, accept: boolean): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'rematch', action: 'answer', requestId, accept }))
  }

  leave(): void {
    if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'leave' }))
    this.close()
  }

  close(): void {
    this.closed = true
    this.fail(new Error('Game: closed'))
    this.socket.close()
    this.listeners.clear()
  }

  private receive(raw: string): void {
    let message: { type?: string; snapshot?: ChessGameSnapshot; error?: string }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    if (message.type === 'error') {
      this.fail(new Error(message.error ?? 'Move rejected'))
      return
    }
    if (message.type === 'left' || message.type === 'rematch-request' || message.type === 'rematch-result' || message.type === 'chat' || message.type === 'notice') {
      for (const listener of this.roomListeners) listener(message as ChessRoomEvent)
      return
    }
    if (message.type !== 'state' || !message.snapshot) return
    this.current = message.snapshot
    const waiting = this.pending.splice(0)
    for (const request of waiting) request.resolve(this.current)
    for (const listener of this.listeners) listener(this.current)
  }

  private fail(error: Error): void {
    if (this.closed && this.pending.length === 0) return
    const waiting = this.pending.splice(0)
    for (const request of waiting) request.reject(error)
  }
}

export interface PartyKitChessMultiplayerOptions {
  baseUrl: string
  /** Firebase ID token, the same one the API takes as Bearer. */
  token: () => Promise<string | null>
  profile: () => MultiplayerFriend | null
}

export class PartyKitChessMultiplayer implements ChessMultiplayerTransport {
  private lobby: PartyKitLobbyClient

  constructor(private options: PartyKitChessMultiplayerOptions) {
    this.lobby = new PartyKitLobbyClient(options.baseUrl, this.auth, () => this.profile())
  }

  private get auth(): PartyAuth {
    return { token: this.options.token, username: () => this.profile()?.username ?? null }
  }

  private profile(): MultiplayerFriend | null {
    return this.options.profile()
  }

  online(): void {
    this.lobby.online()
  }

  signedIn(): boolean {
    return !!this.profile()
  }

  /** Everyone in the lobby, not only followers. */
  async listFriends(): Promise<MultiplayerFriend[]> {
    if (!this.profile()) throw new Error('Log in first')
    return this.lobby.listUsers()
  }

  watchLobby(listener: (view: LobbyView) => void): () => void {
    return this.lobby.watchLobby(listener)
  }

  sendLobbyChat(text: string): void {
    this.lobby.sendChat(text)
  }

  setPlaying(gameId: string | null): void {
    this.lobby.setPlaying(gameId)
  }

  async sendInvite(userId: string, color: Color | 'random', timeMs: number): Promise<ChessInvite> {
    return this.lobby.sendInvite(userId, color, timeMs)
  }

  async openGame(invite: ChessInvite): Promise<ChessMultiplayerGame> {
    return this.connectGame(invite.gameId, { type: 'join', timeMs: invite.timeMs ?? 0 })
  }

  async watchGame(gameId: string): Promise<ChessMultiplayerGame> {
    return this.connectGame(gameId, { type: 'watch' })
  }

  private async connectGame(gameId: string, hello: Record<string, unknown>): Promise<ChessMultiplayerGame> {
    const initial: ChessGameSnapshot = {
      gameId,
      revision: 0,
      state: newChessState(),
      whiteUserId: '',
      blackUserId: '',
      status: 'waiting',
    }
    return new PartyKitChessGame(await partyUrl(this.options.baseUrl, gameId, this.auth), initial, hello)
  }

  watchInvites(listener: (invite: ChessInvite) => void): () => void {
    return this.lobby.watchInvites(listener)
  }

  watchInviteResults(listener: (invite: ChessInvite) => void): () => void {
    return this.lobby.watchInviteResults(listener)
  }

  async answerInvite(inviteId: string, accept: boolean): Promise<ChessMultiplayerGame | null> {
    const invite = await this.lobby.answerInvite(inviteId, accept)
    if (!accept) return null
    if (!invite) throw new Error('INVITE IS NO LONGER AVAILABLE')
    return this.openGame({ ...invite, status: 'accepted' })
  }
}
