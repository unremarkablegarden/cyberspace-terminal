import type { ApiClient } from '@cyberspace/apps'
import { newChessState, type ChessState, type Color, type Move } from './rules'

export interface MultiplayerFriend {
  userId: string
  username?: string
  displayName?: string
}

export type ChessInviteStatus = 'pending' | 'accepted' | 'declined' | 'expired'

export interface ChessInvite {
  inviteId: string
  gameId: string
  fromUserId: string
  toUserId: string
  status: ChessInviteStatus
  requestedColor?: Color
  createdAt?: string
}

export interface ChessGameSnapshot {
  gameId: string
  revision: number
  state: ChessState
  whiteUserId: string
  blackUserId: string
  playerColor?: Color
  status: 'waiting' | 'active' | 'finished' | 'abandoned'
  result?: string
}

export interface ChessMultiplayerGame {
  readonly snapshot: ChessGameSnapshot
  readonly playerColor: Color
  submitMove(move: Move): Promise<ChessGameSnapshot>
  watch(listener: (snapshot: ChessGameSnapshot) => void): () => void
  close(): void
}

export interface ChessMultiplayerTransport {
  listFriends(): Promise<MultiplayerFriend[]>
  sendInvite(userId: string, color: Color | 'random'): Promise<ChessInvite>
  openGame(invite: ChessInvite): Promise<ChessMultiplayerGame>
  watchInvites(listener: (invite: ChessInvite) => void): () => void
  watchInviteResults(listener: (invite: ChessInvite) => void): () => void
  answerInvite(inviteId: string, accept: boolean): Promise<ChessMultiplayerGame | null>
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

  async sendInvite(_userId: string, _color: Color | 'random'): Promise<ChessInvite> {
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

interface FollowRow {
  followerId?: string
  username?: string
  displayName?: string
}

export class CyberspaceChessMultiplayer implements ChessMultiplayerTransport {
  constructor(private api: ApiClient) {}

  async listFriends(): Promise<MultiplayerFriend[]> {
    if (!this.api.authed || !this.api.userId) return []
    const friends: MultiplayerFriend[] = []
    let cursor: string | null = null
    do {
      const query: string = `/v1/follows?type=followers&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page: { rows: FollowRow[]; cursor: string | null } = await this.api.page<FollowRow>(query)
      for (const row of page.rows) {
        if (!row.followerId || row.followerId === this.api.userId) continue
        friends.push({
          userId: row.followerId,
          username: row.username,
          displayName: row.displayName,
        })
      }
      cursor = page.cursor
    } while (cursor)
    return friends
  }

  async sendInvite(_userId: string, _color: Color | 'random'): Promise<ChessInvite> {
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

function partyUrl(base: string, room: string): string {
  const url = new URL(base, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const route = local ? `/party/${encodeURIComponent(room)}` : `/parties/main/${encodeURIComponent(room)}`
  url.pathname = `${url.pathname.replace(/\/$/, '')}${route}`
  return url.toString()
}

const LOBBY_ROOM = 'chess-demo-lobby'

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
  invite?: ChessInvite
  error?: string
}

class PartyKitLobbyClient {
  private socket: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private users: MultiplayerFriend[] = []
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
    private profile: () => MultiplayerFriend | null,
  ) {}

  async listUsers(): Promise<MultiplayerFriend[]> {
    await this.connect()
    const response = await this.request({ type: 'lobby:list' })
    this.users = response.users ?? this.users
    const me = this.profile()?.userId
    return this.users.filter(user => user.userId !== me)
  }

  watchInvites(listener: (invite: ChessInvite) => void): () => void {
    this.inviteListeners.add(listener)
    void this.connect().catch(() => {})
    return () => this.inviteListeners.delete(listener)
  }

  watchInviteResults(listener: (invite: ChessInvite) => void): () => void {
    this.resultListeners.add(listener)
    void this.connect().catch(() => {})
    return () => this.resultListeners.delete(listener)
  }

  async sendInvite(toUserId: string, color: Color | 'random'): Promise<ChessInvite> {
    const profile = this.profile()
    if (!profile) throw new Error('SIGN IN OR USE A DEMO IDENTITY')
    await this.connect()
    const invite: ChessInvite = {
      inviteId: newId('invite'),
      gameId: newId('chess'),
      fromUserId: profile.userId,
      toUserId,
      status: 'pending',
      requestedColor: color === 'random' ? undefined : color,
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
    if (!profile) return Promise.reject(new Error('NO MULTIPLAYER IDENTITY'))

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(partyUrl(this.baseUrl, LOBBY_ROOM))
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
          if (!settled) {
            settled = true
            resolve()
          }
          return
        }
        if (message.type === 'lobby:presence') {
          this.users = message.users ?? this.users
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
      socket.addEventListener('error', () => fail(new Error('PARTYKIT LOBBY CONNECTION FAILED')))
      socket.addEventListener('close', () => {
        fail(new Error('PARTYKIT LOBBY CONNECTION CLOSED'))
        if (this.socket === socket) this.socket = null
        this.connecting = null
        for (const [id, pending] of this.requests) {
          clearTimeout(pending.timer)
          pending.reject(new Error('PARTYKIT LOBBY CONNECTION CLOSED'))
          this.requests.delete(id)
        }
      })
    }).finally(() => {
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

class PartyKitChessGame implements ChessMultiplayerGame {
  private current: ChessGameSnapshot
  private readonly listeners = new Set<(snapshot: ChessGameSnapshot) => void>()
  private readonly pending: Array<{
    resolve: (snapshot: ChessGameSnapshot) => void
    reject: (error: Error) => void
  }> = []
  private socket: WebSocket
  private closed = false

  constructor(
    room: string,
    baseUrl: string,
    private userId: string,
    initial: ChessGameSnapshot,
  ) {
    this.current = initial
    this.socket = new WebSocket(partyUrl(baseUrl, room))
    this.socket.addEventListener('open', () => {
      this.socket.send(JSON.stringify({ type: 'join', userId }))
    })
    this.socket.addEventListener('message', event => this.receive(String(event.data)))
    this.socket.addEventListener('error', () => this.fail(new Error('PARTYKIT CONNECTION FAILED')))
    this.socket.addEventListener('close', () => this.fail(new Error('PARTYKIT CONNECTION CLOSED')))
  }

  get snapshot(): ChessGameSnapshot {
    return this.current
  }

  get playerColor(): Color {
    return this.current.playerColor ?? 'white'
  }

  submitMove(move: Move): Promise<ChessGameSnapshot> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('PARTYKIT CONNECTION NOT READY'))
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

  close(): void {
    this.closed = true
    this.fail(new Error('PARTYKIT GAME CLOSED'))
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
      this.fail(new Error(message.error ?? 'PARTYKIT MOVE REJECTED'))
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
  userId: () => string | null
  profile?: () => MultiplayerFriend | null
}

export class PartyKitChessMultiplayer implements ChessMultiplayerTransport {
  private lobby: PartyKitLobbyClient

  constructor(
    private friends: ChessMultiplayerTransport,
    private options: PartyKitChessMultiplayerOptions,
  ) {
    this.lobby = new PartyKitLobbyClient(options.baseUrl, () => this.profile())
  }

  private profile(): MultiplayerFriend | null {
    return this.options.profile?.() ?? (this.options.userId()
      ? { userId: this.options.userId()!, displayName: 'Cyberspace user' }
      : null)
  }

  async listFriends(): Promise<MultiplayerFriend[]> {
    const profile = this.profile()
    if (!profile) return []
    const online = await this.lobby.listUsers()
    if (profile.userId.startsWith('demo:')) return online
    let friends: MultiplayerFriend[] = []
    try {
      friends = await this.friends.listFriends()
    } catch {
      friends = []
    }
    const allowed = new Map(friends.map(friend => [friend.userId, friend]))
    return online.flatMap(peer => {
      const friend = allowed.get(peer.userId)
      return friend ? [{ ...peer, ...friend }] : []
    })
  }

  async sendInvite(userId: string, color: Color | 'random'): Promise<ChessInvite> {
    return this.lobby.sendInvite(userId, color)
  }

  async openGame(invite: ChessInvite): Promise<ChessMultiplayerGame> {
    const initial: ChessGameSnapshot = {
      gameId: invite.gameId,
      revision: 0,
      state: newChessState(),
      whiteUserId: '',
      blackUserId: '',
      status: 'waiting',
    }
    return new PartyKitChessGame(
      invite.gameId,
      this.options.baseUrl,
      this.options.userId() ?? 'guest',
      initial,
    )
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
