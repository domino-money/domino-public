/**
 * What this browser remembers of the wallet connection between visits (2026-10-01, audit C11, with the owner's OK):
 * which wallets the person disconnected here, so a reload does not connect them again (a shared computer stays
 * disconnected), and which one connected last, so a reload tries that one first.
 *
 * Wallet ids only: the rdns a wallet announces about itself (such as `io.metamask`), `injected` for a browser wallet
 * that announces nothing, or `walletConnect`. Never an address, an account, a network, a session or anything a wallet
 * returned. One key, bounded; storage that cannot be read or written is a browser that remembers nothing, as before.
 */

export const MEMORY_KEY = 'domino.wallet.v1'
/** An id as wallets announce them (EIP-6963 rdns), and nothing that could hold an address. */
const ID = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/
const MAX_IDS = 16

export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface Remembered {
  recent: string | null
  disconnected: string[]
}

const valid = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && !/0x[0-9a-fA-F]{6,}/.test(id)

export function walletMemory(storage: () => StoragePort | null) {
  function read(): Remembered {
    try {
      const value: unknown = JSON.parse(storage()?.getItem(MEMORY_KEY) ?? 'null')
      if (!value || typeof value !== 'object') return { recent: null, disconnected: [] }
      const { recent, disconnected } = value as { recent?: unknown; disconnected?: unknown }
      return {
        recent: valid(recent) ? recent : null,
        disconnected: Array.isArray(disconnected) ? disconnected.filter(valid).slice(0, MAX_IDS) : [],
      }
    } catch {
      return { recent: null, disconnected: [] }
    }
  }
  function write(next: Remembered) {
    try {
      const store = storage()
      if (!store) return
      if (next.recent === null && next.disconnected.length === 0) store.removeItem(MEMORY_KEY)
      else store.setItem(MEMORY_KEY, JSON.stringify({ recent: next.recent, disconnected: next.disconnected.slice(0, MAX_IDS) }))
    } catch {
      /* Refused storage (a private window, a full quota): nothing is remembered. */
    }
  }
  return {
    /** The wallet that connected last on this browser, if any. */
    recent: (): string | null => read().recent,
    /** Whether the person disconnected this wallet here and has not connected it again since. */
    disconnected: (id: string): boolean => read().disconnected.includes(id),
    /** A wallet connected: it is the recent one, and no longer kept disconnected. */
    connected(id: string) {
      if (!valid(id)) return
      const now = read()
      if (now.recent === id && !now.disconnected.includes(id)) return
      write({ recent: id, disconnected: now.disconnected.filter((other) => other !== id) })
    },
    /** The person disconnected these wallets here: a reload connects none of them until they connect one again. */
    disconnectedAll(ids: readonly string[]) {
      const now = read()
      write({ recent: now.recent, disconnected: [...new Set([...ids.filter(valid), ...now.disconnected])] })
    },
  }
}

const browserStorage = (): StoragePort | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export const memory = walletMemory(browserStorage)
