// The master key a member's home is encrypted under, and the wrap that lets
// it travel. WebCrypto only.
//
// One random AES-256-GCM key per account. It is never sent in the clear: the
// server holds it wrapped under a key derived from the login password
// (PBKDF2-SHA256, 600 000 iterations), and each device keeps it unwrapped in
// the same storage as the refresh token. login(1) has the typed password for
// the moment it takes to unwrap; nothing else ever does.

import { base64, unbase64 } from './hash.js'

export interface KeyStorage {
  get(): string | null
  set(value: string | null): void
}

/** The master key wrapped under the password-derived key, as the server stores it. */
export interface HomeWrap {
  salt: string
  iv: string
  wrapped: string
}

const PBKDF2_ITERATIONS = 600_000
const IV_BYTES = 12
const SALT_BYTES = 16

const enc = new TextEncoder()
const dec = new TextDecoder()

const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n))

const importAes = (raw: Uint8Array, usages: KeyUsage[] = ['encrypt', 'decrypt']): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, usages)

async function deriveKek(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** iv || AES-GCM(key, plain). */
async function gcmSeal(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = random(IV_BYTES)
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource))
  const out = new Uint8Array(iv.length + cipher.length)
  out.set(iv)
  out.set(cipher, iv.length)
  return out
}

/** Throws on a bad key or a modified ciphertext; GCM authenticates. */
async function gcmOpen(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  const iv = sealed.subarray(0, IV_BYTES) as BufferSource
  const cipher = sealed.subarray(IV_BYTES) as BufferSource
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher))
}

/** The raw key under the wrap, or null when the password does not fit it. */
export async function unwrapWith(password: string, wrap: HomeWrap): Promise<Uint8Array | null> {
  try {
    const kek = await deriveKek(password, unbase64(wrap.salt))
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(wrap.iv) as BufferSource }, kek, unbase64(wrap.wrapped) as BufferSource)
    return new Uint8Array(raw)
  } catch {
    return null
  }
}

export class HomeKey {
  // Private at runtime: the page shares its realm with untrusted user programs.
  #raw: Uint8Array | null = null
  #key: Promise<CryptoKey> | null = null

  constructor(private storage: KeyStorage) {
    const cached = storage.get()
    if (cached) this.#set(unbase64(cached), false)
  }

  /** A key is in hand: cached from an earlier login, or unwrapped in this one. */
  get present(): boolean {
    return this.#raw !== null
  }

  #set(raw: Uint8Array, store: boolean): void {
    this.#raw = raw
    this.#key = importAes(raw)
    if (store) this.storage.set(base64(raw))
  }

  /** A fresh master key for an account that has none. */
  create(): void {
    this.#set(random(32), true)
  }

  clear(): void {
    this.#raw = null
    this.#key = null
    this.storage.set(null)
  }

  /** Unwrap with the password; false when the password does not fit the wrap. */
  async unlock(password: string, wrap: HomeWrap): Promise<boolean> {
    const raw = await unwrapWith(password, wrap)
    if (raw) this.#set(raw, true)
    return raw !== null
  }

  /** Take a key unwrapped elsewhere (unwrapWith) as the key in hand. */
  adopt(raw: Uint8Array): void {
    this.#set(raw, true)
  }

  /** The key in hand, wrapped under this password with a fresh salt and IV. */
  async wrap(password: string): Promise<HomeWrap> {
    if (!this.#raw) throw new Error('home locked')
    const salt = random(SALT_BYTES)
    const iv = random(IV_BYTES)
    const kek = await deriveKek(password, salt)
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, this.#raw as BufferSource))
    return { salt: base64(salt), iv: base64(iv), wrapped: base64(wrapped) }
  }

  #need(): Promise<CryptoKey> {
    if (!this.#key) throw new Error('home locked')
    return this.#key
  }

  async seal(plain: Uint8Array): Promise<Uint8Array> {
    return gcmSeal(await this.#need(), plain)
  }

  async open(sealed: Uint8Array): Promise<Uint8Array> {
    return gcmOpen(await this.#need(), sealed)
  }

  async sealEntry(entry: unknown): Promise<string> {
    return base64(await this.seal(enc.encode(JSON.stringify(entry))))
  }

  async openEntry<T>(e: string): Promise<T> {
    return JSON.parse(dec.decode(await this.open(unbase64(e)))) as T
  }
}
