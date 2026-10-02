/**
 * What this browser keeps about the wallets used on Domino, how long, and when it is forgotten (2026-10-01, platform
 * workstream, I6). Domino's servers keep none of it; the docs say so (lib/docs/pages/introduction.ts, Wallet and
 * sign-in).
 *
 * Kept, display only, so a screen paints at once and then reads again:
 *   - domino.kept.v1.owned.4663.<address>     a wallet's positions list (Your positions): a day
 *   - domino-wallet-v2:4663                   the Wallet card's tokens and balances, per address: a day (named
 *                                             domino-wallet-v1 until 2026-10-01; a copy under that name moves to this
 *                                             one when the card first reads it, and is aged and forgotten alike until then)
 *   - domino.kept.v1.receipts.4663.<address>  a signed-in wallet's receipts: 30 days, forgotten when the session ends
 *   - domino.kept.v1.managed.4663.<address>   a signed-in wallet's managed positions: 6 hours, the same
 *   - domino.kept.v1.tokens                   public token details (symbols and decimals): 30 days
 *   - domino-elysium-receipts-v1:<chain>:<address>  the second chain's section's receipts (chains/elysium/receipts.ts),
 *                                             each 30 days from when it was sent, like the receipts above (fix round 1)
 *
 * A copy older than its age is never shown; since 2026-10-01 it is also deleted the next time the site opens
 * (sweepCopies), not only when the screen that reads it opens again, and every wallet's copies are deleted as soon as
 * the wallet is disconnected here (forgetWallets). Clearing the site's data in the browser removes them all at once.
 * Until 2026-10-01 the positions list and the Wallet card kept a week, and stayed after a disconnect.
 *
 * Retired 2026-10-02 (RPC-SPEC §11.4: the fees replay is gone): the four public copies it kept, under the names in
 * RETIRED_KEYS, are deleted the next time the site opens. The fees ledger's own two (lib/fees/historyCache.ts, 7 days,
 * and lib/fees/readings.ts, 30 days) age themselves: public chain data, no address in them.
 *
 * Not here: what the money flows keep so a transaction is never sent twice (finance/: the nonce and route journals,
 * the setup recovery), which must outlive a reload and is theirs to clear, and the public pool figures the pages keep.
 * Nor the wallet control's own memory (src/wallet/memory.ts, domino.wallet.v1, 2026-10-01, audit C11): wallet ids
 * only, never an address, kept through a disconnect on purpose, so a wallet disconnected here stays disconnected.
 */
import { ROBINHOOD_ID } from '../config/chainIdentity'
import { chainKey } from './chainStorage'

export const KEPT_PREFIX = 'domino.kept.v1.'
/**
 * lib/walletMemory.ts WALLET_MEMORY_KEY (tests/wallet-holdings.test.mjs checks they are the same). Changed on purpose
 * 2026-10-01 (the chain2 workstream, part B, audit item G10): the name names its chain.
 */
export const WALLET_MEMORY = chainKey('domino-wallet-v2', ROBINHOOD_ID)
/** lib/walletMemory.ts LEGACY_WALLET_MEMORY_KEY: the name before, aged and forgotten as WALLET_MEMORY is until it moves. */
export const LEGACY_WALLET_MEMORY = 'domino-wallet-v1'
/** The Wallet card's copy on any chain of the registry (`domino-wallet-v2:<chain id>`), and the old name. */
const isWalletMemory = (key: string) => key === LEGACY_WALLET_MEMORY || /^domino-wallet-v2:[1-9][0-9]{0,15}$/.test(key)
/** The second chain's section's receipts, per chain and owner (chains/elysium/receipts.ts RECEIPTS_KEY, chainKey). */
const isSectionReceipts = (key: string) => /^domino-elysium-receipts-v1:[1-9][0-9]{0,15}:0x[0-9a-f]{40}$/.test(key)

/** What the retired fees replay kept (public chain data): deleted as the site opens (2026-10-02, RPC-SPEC §11.4). */
export const RETIRED_KEYS: readonly string[] = Object.freeze(['domino:public-fee-history:1', 'domino:fee-points:1', 'domino:pool-inits:1', 'domino:block-times:1'])

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** How long each kind of kept copy may be shown, by the kind in its name (the part after the prefix). */
export const KEPT_MAX_AGE_MS: Readonly<Record<string, number>> = Object.freeze({
  owned: DAY,
  receipts: 30 * DAY,
  managed: 6 * HOUR,
  tokens: 30 * DAY,
})
/** The Wallet card's copy: lib/walletMemory.ts WALLET_MEMORY_MAX_AGE_MS. */
export const WALLET_MEMORY_MAX_AGE_MS = DAY
/** Anything kept that names no kind above is let go after the longest of them. */
const LONGEST = Math.max(...Object.values(KEPT_MAX_AGE_MS))

export interface CopyStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** This browser's storage, or null where there is none to use. */
export function copyStorage(): CopyStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const keys = (storage: CopyStorage): string[] => Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null)

/** Whether something kept at `at` is past `maxAge` at `now` (or not a time at all). */
const past = (at: unknown, maxAge: number, now: number) => typeof at !== 'number' || !Number.isFinite(at) || now - at > maxAge || at - now > 60_000

/**
 * Deletes every kept copy that may no longer be shown: past its kind's age, unreadable, or from the future. Run once as
 * the site opens, off the page's first paint. Storage that is blocked or throws: nothing to do.
 */
export function sweepCopies(storage: CopyStorage | null = copyStorage(), now: number = Date.now()): number {
  if (!storage) return 0
  let removed = 0
  try {
    for (const key of keys(storage)) {
      if (RETIRED_KEYS.includes(key)) {
        storage.removeItem(key)
        removed += 1
      } else if (key.startsWith(KEPT_PREFIX)) {
        const kind = key.slice(KEPT_PREFIX.length).split('.')[0]
        let at: unknown = null
        try {
          at = (JSON.parse(storage.getItem(key) ?? 'null') as { at?: unknown } | null)?.at
        } catch {
          at = null
        }
        if (past(at, KEPT_MAX_AGE_MS[kind] ?? LONGEST, now)) {
          storage.removeItem(key)
          removed += 1
        }
      } else if (isSectionReceipts(key)) {
        // Each receipt by the time it was sent: those past the receipts' age go, and the key with the last of them.
        let list: unknown = null
        try {
          list = JSON.parse(storage.getItem(key) ?? 'null')
        } catch {
          list = null
        }
        const all = Array.isArray(list) ? list : []
        const kept = all.filter((entry) => !past((entry as { sentAt?: unknown } | null)?.sentAt, KEPT_MAX_AGE_MS.receipts, now))
        if (kept.length === 0) {
          storage.removeItem(key)
          removed += 1
        } else if (kept.length < all.length) {
          storage.setItem(key, JSON.stringify(kept))
          removed += all.length - kept.length
        }
      } else if (isWalletMemory(key)) {
        let all: { v?: unknown; wallets?: Record<string, { at?: unknown }> } | null = null
        try {
          all = JSON.parse(storage.getItem(key) ?? 'null')
        } catch {
          all = null
        }
        const wallets = all && all.v === 1 && all.wallets && typeof all.wallets === 'object' ? all.wallets : null
        const kept = wallets ? Object.entries(wallets).filter(([, entry]) => !past(entry?.at, WALLET_MEMORY_MAX_AGE_MS, now)) : []
        if (kept.length === 0) {
          storage.removeItem(key)
          removed += 1
        } else if (wallets && kept.length < Object.keys(wallets).length) {
          storage.setItem(key, JSON.stringify({ v: 1, wallets: Object.fromEntries(kept) }))
          removed += Object.keys(wallets).length - kept.length
        }
      }
    }
  } catch {
    // Blocked part way: what is left goes the next time.
  }
  return removed
}

/**
 * Deletes every wallet's copies: the positions lists, the Wallet card's tokens and balances, a signed-in wallet's
 * receipts and managed positions, and the second chain's section's receipts (fix round 1). The wallet control calls it when a wallet is disconnected here (not when a session
 * merely ends: the next sign-in of the same wallet paints from them at once). Public token details stay.
 */
export function forgetWallets(storage: CopyStorage | null = copyStorage()): void {
  if (!storage) return
  try {
    for (const key of keys(storage)) {
      if (/^domino\.kept\.v1\.(owned|receipts|managed)\./.test(key) || isWalletMemory(key) || isSectionReceipts(key)) storage.removeItem(key)
    }
  } catch {
    // Blocked: nothing was kept.
  }
}
