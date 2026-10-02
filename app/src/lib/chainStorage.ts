/**
 * Names for what this page keeps in the browser, scoped to a chain (2026-10-01, the chain2 workstream, audit item G10).
 *
 * Why: the copies the page keeps are named without a chain (lib/walletMemory.ts `domino-wallet-v1:<owner>`,
 * lib/read/marketsPaint.ts, lib/read/cardSeries.ts). With a second chain served from the same origin, a wallet
 * remembered on one chain would be shown on the other for the same address, and Markets would paint the other chain's
 * list for a moment. Every key built here names its chain (`<base>:<chainId>:<parts…>`), and reading one removes the
 * unscoped keys the same thing was kept under before, so an old copy is never shown for a chain it may not belong to.
 * The Elysium section keeps its receipts this way. Part B (2026-10-01): lib/walletMemory.ts (domino-wallet-v2:4663),
 * lib/read/marketsPaint.ts (domino-markets-v2:4663) and lib/read/cardSeries.ts (domino-card-v2:4663:<series>) name
 * Robinhood Chain in their keys too. What they kept under their old names is Robinhood Chain's (the only chain they ever
 * read), so it moves to the new name the first time it is read (movedScoped) instead of being thrown away: nothing a
 * returning visitor sees changes, and the old name is gone after that read.
 *
 * Every access is guarded: a browser that refuses storage (a private window, a blocked origin) keeps nothing and the
 * page works without it. Values are strings; the caller validates what it reads back as untrusted.
 */

/** The storage these helpers take: the browser's localStorage, or a test's stand-in. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const PART = /^[a-z0-9-]+$/

/**
 * `<base>:<chainId>:<parts…>`, every part lowercase. `base` names the thing and its version (`domino-wallet-v2`); a part
 * that could break the key (an empty one, a colon, a space) is refused.
 */
export function chainKey(base: string, chainId: number, ...parts: readonly string[]): string {
  if (!PART.test(base) || !Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError('invalid storage key')
  const rest = parts.map((part) => part.toLowerCase())
  if (rest.some((part) => !/^[a-z0-9x._-]+$/.test(part))) throw new RangeError('invalid storage key part')
  return [base, String(chainId), ...rest].join(':')
}

/** `store`, or null where the browser refuses to give one. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The text kept under `key`, or null; the unscoped `legacy` keys of the same thing are removed first, never read. */
export function readScoped(store: KeyValueStore | null, key: string, legacy: readonly string[] = []): string | null {
  if (!store) return null
  try {
    for (const old of legacy) store.removeItem(old)
    return store.getItem(key)
  } catch {
    return null
  }
}

/** Keeps `value` under `key`; false where the browser refused (full, or storage blocked). */
export function writeScoped(store: KeyValueStore | null, key: string, value: string): boolean {
  if (!store) return false
  try {
    store.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function dropScoped(store: KeyValueStore | null, key: string): void {
  try {
    store?.removeItem(key)
  } catch {
    // Nothing kept is nothing lost.
  }
}

/** A storage that may not let go of keys (some tests' stand-ins): the move then copies and leaves the old name. */
export type MovableStore = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>

/**
 * The text kept under `key`; where there is none, the text an older name of the same copy kept (`legacy`, the chain's
 * own copy from before its name named the chain), moved to `key` first: written under `key`, then removed from
 * `legacy`. Where both are kept, `key`'s wins and `legacy` goes. Null when neither holds anything, or storage refuses.
 */
export function movedScoped(store: MovableStore | null, key: string, legacy: string): string | null {
  if (!store) return null
  let text: string | null
  let old: string | null
  try {
    text = store.getItem(key)
    old = store.getItem(legacy)
  } catch {
    return null
  }
  if (old === null) return text
  try {
    if (text === null) store.setItem(key, old)
    store.removeItem?.(legacy)
  } catch {
    // Full or blocked: the copy is read from its old name this time, and moved the next.
  }
  return text ?? old
}
