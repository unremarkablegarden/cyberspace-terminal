import { STORE_PREFIX } from './config'

/** localStorage for the faceplate's own settings, namespaced by STORE_PREFIX. */
export const store = {
  get: (k: string, fallback: string) => localStorage.getItem(STORE_PREFIX + k) ?? fallback,
  set: (k: string, v: string) => localStorage.setItem(STORE_PREFIX + k, v),
  remove: (k: string) => localStorage.removeItem(STORE_PREFIX + k),
}
