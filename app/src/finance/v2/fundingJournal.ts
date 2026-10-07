/** Public funding intent metadata only. Quotes, calldata, signatures and credentials never belong in this store. */
export interface FundingStorage {
  get(key: string): string | null
  put(key: string, value: string): void
  drop(key: string): void
  subscribe(listener: () => void): () => void
}

interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const PREFIX = 'domino.funding.v1:'
const KEY = /^domino\.funding\.v1:0x[0-9a-f]{40}:(4663|8453|42161)$/
const MAX_LENGTH = 24_000
const LOCAL_CHANGE = 'domino:funding-journal'
const unavailable = (): never => { throw new Error('funding_storage_unavailable') }

/** A failed read disables writes for this handle: an unread intent must never be overwritten by a new transfer. */
export function createFundingStorage(storage: StoragePort | null, watch: (listener: (key: string | null) => void) => () => void = () => () => {}, notify: (key: string) => void = () => {}): FundingStorage {
  let unreadable = storage === null
  const keyOf = (key: string) => { if (!KEY.test(key)) throw new Error('invalid_funding_storage_key'); return key }
  return {
    get(key) {
      keyOf(key)
      if (unreadable || !storage) return null
      try { return storage.getItem(key) }
      catch { unreadable = true; return null }
    },
    put(key, value) {
      keyOf(key)
      if (typeof value !== 'string' || value.length > MAX_LENGTH) throw new Error('invalid_funding_metadata')
      if (unreadable || !storage) return unavailable()
      try {
        storage.setItem(key, value)
        if (storage.getItem(key) !== value) return unavailable()
      } catch { unreadable = true; return unavailable() }
      notify(key)
    },
    drop(key) {
      keyOf(key)
      if (unreadable || !storage) return unavailable()
      try {
        storage.removeItem(key)
        if (storage.getItem(key) !== null) return unavailable()
      } catch { unreadable = true; return unavailable() }
      notify(key)
    },
    subscribe(listener) {
      return watch((key) => { if (key === null || key.startsWith(PREFIX)) listener() })
    },
  }
}

/** Notify other tabs and replacement coordinators in this tab, including a wallet result after its old UI unmounted. */
export function browserFundingStorage(): FundingStorage {
  let storage: StoragePort | null = null
  try { if (typeof window !== 'undefined') storage = window.localStorage }
  catch { /* An unavailable journal blocks sends; reading the UI itself can still continue. */ }
  return createFundingStorage(storage, (listener) => {
    if (typeof window === 'undefined') return () => {}
    const changed = (event: StorageEvent) => { if (event.storageArea === storage) listener(event.key) }
    const localChanged = (event: Event) => {
      const key = (event as CustomEvent<unknown>).detail
      if (typeof key === 'string' && KEY.test(key)) listener(key)
    }
    window.addEventListener('storage', changed)
    window.addEventListener(LOCAL_CHANGE, localChanged)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener(LOCAL_CHANGE, localChanged) }
  }, (key) => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LOCAL_CHANGE, { detail: key }))
  })
}

/** Web Locks provides cross-tab exclusion. Fail closed where unavailable; origin nonce guards remain independent. */
export async function withFundingLock<T>(owner: string, work: () => Promise<T>, busy: () => T, wait = false): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return busy()
  return navigator.locks.request(`domino-funding:${owner.toLowerCase()}`, { mode: 'exclusive', ...(wait ? {} : { ifAvailable: true }) }, async (lock) => lock ? work() : busy())
}
