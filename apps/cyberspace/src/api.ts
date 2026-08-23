// Cyberspace API client. Talks to api.cyberspace.online: Bearer idToken,
// {data}/{error:{code,message}} envelopes, refresh via /v1/auth/refresh.
// Rate limits and content rules are enforced server-side.

export interface AuthStorage {
  get(): string | null
  set(value: string | null): void
}

/** What `page` returns; see it for what the cursor means. */
export interface ApiPage<T> {
  rows: T[]
  cursor: string | null
}

/** What every route answers with. `cursor` is on list responses only. */
interface Envelope<T> {
  data?: T
  cursor?: string | null
  error?: { code?: string; message?: string }
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message)
  }
}

export class ApiClient {
  username: string | null = null
  userId: string | null = null
  onAuthChange: ((username: string | null) => void) | null = null

  private idToken: string | null = null
  private refreshToken: string | null = null

  constructor(public base: string, private storage: AuthStorage) {
    this.refreshToken = storage.get()
  }

  get authed(): boolean {
    return this.idToken !== null
  }

  get hasSavedSession(): boolean {
    return this.refreshToken !== null
  }

  async login(email: string, password: string): Promise<string> {
    const r = await this.request<{ idToken: string; refreshToken: string }>(
      'POST', '/v1/auth/login', { email, password }, { auth: false })
    this.idToken = r.idToken
    this.refreshToken = r.refreshToken
    this.storage.set(r.refreshToken)
    await this.loadMe()
    return this.username ?? email
  }

  /** Silent boot-time resume from a saved refresh token. */
  async resume(): Promise<string | null> {
    if (!this.refreshToken) return null
    try {
      await this.refresh()
      await this.loadMe()
      return this.username
    } catch {
      this.logout()
      return null
    }
  }

  logout(): void {
    this.idToken = null
    this.refreshToken = null
    this.username = null
    this.userId = null
    this.storage.set(null)
    this.onAuthChange?.(null)
  }

  /**
   * idToken for direct RTDB reads, which live streams pass as ?auth=.
   * renew=true forces a refresh; call it when the database reports the token
   * has expired.
   */
  async token(renew = false): Promise<string | null> {
    if ((renew || !this.idToken) && this.refreshToken) {
      await this.refresh().catch(() => { this.logout() })
    }
    return this.idToken
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  /**
   * One page of a list route: the rows, and the cursor for the page behind it.
   *
   * `cursor` is null on the last page and is the only end marker. A route that
   * filters rows its query could not hands back a page that is short, or
   * empty, with pages still behind it, so a client follows the cursor rather
   * than stopping at the first short page. Pass it back verbatim as `before`.
   */
  async page<T>(path: string): Promise<ApiPage<T>> {
    const env = await this.envelope<T[]>('GET', path)
    return { rows: env.data ?? [], cursor: env.cursor ?? null }
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path)
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new ApiError('UNAUTHORIZED', 'not logged in', 401)
    const r = await this.request<{ idToken: string; refreshToken?: string }>(
      'POST', '/v1/auth/refresh', { refreshToken: this.refreshToken }, { auth: false, retry: false })
    this.idToken = r.idToken
    if (r.refreshToken) {
      this.refreshToken = r.refreshToken
      this.storage.set(r.refreshToken)
    }
  }

  private async loadMe(): Promise<void> {
    const me = await this.get<{ username?: string; userId?: string }>('/v1/users/me')
    this.username = me.username ?? null
    this.userId = me.userId ?? null
    this.onAuthChange?.(this.username)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean; retry?: boolean } = {},
  ): Promise<T> {
    return (await this.envelope<T>(method, path, body, opts)).data as T
  }

  /** The whole envelope, for the callers that need more of it than `data`. */
  private async envelope<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean; retry?: boolean } = {},
  ): Promise<Envelope<T>> {
    const { auth = true, retry = true } = opts
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth && this.idToken) headers['Authorization'] = `Bearer ${this.idToken}`

    let res: Response
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new ApiError('NO_CARRIER', 'NO CARRIER', 0)
    }

    if (res.status === 401 && auth && retry && this.refreshToken) {
      await this.refresh().catch(() => { this.logout() })
      if (this.idToken) return this.envelope<T>(method, path, body, { auth, retry: false })
    }

    const json = await res.json().catch(() => null) as Envelope<T> | null
    if (!res.ok) {
      throw new ApiError(
        json?.error?.code ?? 'ERROR',
        json?.error?.message ?? `${res.status} ${res.statusText}`,
        res.status,
      )
    }
    return json ?? {}
  }
  /**
   * Usernames matching an @-fragment, for autocomplete. Returns names only.
   * A fragment shorter than two characters returns empty.
   */
  async searchUsers(q: string): Promise<string[]> {
    if (q.length < 2) return []
    const rows = await this.get<{ username?: string }[]>(
      `/v1/search?type=users&limit=8&q=${encodeURIComponent(q)}`)
    return rows.map(r => r.username ?? '').filter(Boolean)
  }

}
