/**
 * Fees waiting in an owner's vault (2026-10-02; rugged97's spec rev3 §2.13, written for V2 after it happened in V1): an
 * owner closed a vault's root position, and the fees the automation had collected and not yet reinvested (the vault's
 * fee reserves) stayed in the vault with no screen to withdraw them. What the screens show of them and what a withdrawal
 * takes, worked out from the money client's read (finance/sequence.ts feeReserves). Pure, so every case is tested
 * (tests/fee-reserves.test.mjs); components/positions/FeeReserves.tsx asks it at each render.
 *
 * Rules (contracts/src/DominoVaultV4.sol withdrawFeeReserves, FeeAccounting.sol):
 * - a reserve is one balance of one fee source in one of the pool's two currencies, booked as `original` (fees as
 *   earned) and `charged` (units already charged, a swap's output): the vault pays both to its owner, no fee taken;
 * - the contract takes one (source, currency) per call, so a withdrawal is one row per balance above zero, each for
 *   exactly what the vault books;
 * - nothing here is a price: amounts are the tokens' own, never turned into USD.
 *
 * Plain strings and bigints: this module imports nothing of the wallet feature (tests/session.source-guard.test.mjs).
 */

/** One reserve, as the money client reads it. */
export interface ReserveLine {
  tokenId: bigint
  sourceId: string
  currency: string
  original: bigint
  charged: bigint
}

/** A vault the connected wallet owns, with every reserve of every position it ever registered. */
export interface VaultReserveView {
  vault: string
  rootTokenId: bigint
  paused: boolean
  rootPermissionValid: boolean
  baseCurrency: string
  quoteCurrency: string
  reserves: readonly ReserveLine[]
}

/** One withdrawal: what `withdrawFeeReserves(sourceId, currency, original, charged)` is called with. */
export interface ReserveWithdrawal {
  sourceId: string
  currency: string
  original: bigint
  charged: bigint
}

/** One token's amount waiting in a vault, all its reserves together. */
export interface ReserveTotal {
  currency: string
  amount: bigint
}

/** The automation's state, in the words a vault's row says it with. */
export type ReserveStatus = 'on' | 'paused' | 'stopped'

const lower = (text: string) => text.toLowerCase()

/** The withdrawals that take every reserve above zero, exactly as booked, in the order read (the root's first). */
export function withdrawals(view: Pick<VaultReserveView, 'reserves'>): ReserveWithdrawal[] {
  return view.reserves
    .filter((line) => line.original + line.charged > 0n)
    .map((line) => ({ sourceId: lower(line.sourceId), currency: lower(line.currency), original: line.original, charged: line.charged }))
}

/** Whether the vault holds any reserve above zero. */
export const holdsReserves = (view: Pick<VaultReserveView, 'reserves'>): boolean => view.reserves.some((line) => line.original + line.charged > 0n)

/**
 * Per token, what the vault holds for its owner: the base currency first, then the quote, each only when above zero.
 * A currency outside the pool's two is never one the contract books, and is left out.
 */
export function reserveTotals(view: Pick<VaultReserveView, 'reserves' | 'baseCurrency' | 'quoteCurrency'>): ReserveTotal[] {
  const order = [lower(view.baseCurrency), lower(view.quoteCurrency)]
  return order
    .filter((currency, index) => order.indexOf(currency) === index)
    .map((currency) => ({ currency, amount: view.reserves.filter((line) => lower(line.currency) === currency).reduce((sum, line) => sum + line.original + line.charged, 0n) }))
    .filter((total) => total.amount > 0n)
}

/** What the rows of `rows` pay, per token, in the order the tokens first appear. */
export function withdrawalTotals(rows: readonly ReserveWithdrawal[]): ReserveTotal[] {
  const totals = new Map<string, bigint>()
  for (const row of rows) totals.set(lower(row.currency), (totals.get(lower(row.currency)) ?? 0n) + row.original + row.charged)
  return [...totals].map(([currency, amount]) => ({ currency, amount })).filter((total) => total.amount > 0n)
}

/** Of an owner's vaults, those holding any reserve, in the order given (newest first). */
export const vaultsWithReserves = <T extends Pick<VaultReserveView, 'reserves'>>(vaults: readonly T[]): T[] => vaults.filter(holdsReserves)

/** On while it runs with its permission over the root; paused as its policy says; stopped once that permission is gone (a closed, burned or moved root). */
export function reserveStatus(view: Pick<VaultReserveView, 'paused' | 'rootPermissionValid'>): ReserveStatus {
  return view.paused ? 'paused' : view.rootPermissionValid ? 'on' : 'stopped'
}

/** The words a vault's row says its automation's state with. */
export const RESERVE_STATUS_TEXT: Readonly<Record<ReserveStatus, string>> = {
  on: 'Automation on',
  paused: 'Automation paused',
  stopped: 'Automation stopped',
}

const key = (row: Pick<ReserveWithdrawal, 'sourceId' | 'currency'>) => `${lower(row.sourceId)}|${lower(row.currency)}`

/**
 * Whether the vault, read again, books exactly what the owner reviewed: the same balances above zero, each with the same
 * amounts. Anything else (an automation run that used or added fees, a withdrawal already made from another tab, a part
 * of this one already in) is a new review, never a send of what was reviewed before.
 */
export function sameWithdrawals(reviewed: readonly ReserveWithdrawal[], now: readonly ReserveWithdrawal[]): boolean {
  if (reviewed.length !== now.length) return false
  const read = new Map(now.map((row) => [key(row), row]))
  return reviewed.every((row) => {
    const found = read.get(key(row))
    return found !== undefined && found.original === row.original && found.charged === row.charged
  })
}

// Removed on purpose 2026-10-02 (review of the fee withdrawal, finding 1): rowTaken, which said a step the wallet replaced
// had withdrawn its row when the vault's balance had dropped by it. An automation run spends a reserve on liquidity, and a
// fee credited raises one, with no withdrawal; whether a withdrawal happened is the vault's own record of it now
// (finance/sequence.ts withdrawalRecord).

/** The most withdrawals one batch carries (finance/sequence.ts FEE_WITHDRAWAL_BATCH_LIMIT): more go one transaction each. */
export const WITHDRAWAL_BATCH_LIMIT = 16

/** How a withdrawal goes: one batch for two rows or more with a wallet that executes batches atomically now, else one transaction per row. */
export function withdrawalPlan(rows: number, atomic: 'supported' | 'ready' | 'unsupported' | null): 'batch' | 'steps' {
  return rows >= 2 && rows <= WITHDRAWAL_BATCH_LIMIT && atomic === 'supported' ? 'batch' : 'steps'
}

/** The vaults a position's page shows: the one its read names, or those whose root is the page's NFT (one that no longer exists). */
export function vaultsFor<T extends Pick<VaultReserveView, 'vault' | 'rootTokenId'>>(vaults: readonly T[], filter: { vault?: string; root?: string }): T[] {
  return vaults.filter(
    (view) => (filter.vault === undefined || lower(view.vault) === lower(filter.vault)) && (filter.root === undefined || view.rootTokenId.toString() === filter.root),
  )
}

/* ---- What a screen holds of an owner's vaults across reads (2026-10-02, review findings 2, 6 and 8) ----
 *
 * The factory lists every vault an owner created (finance/sequence.ts ownedVaults); the first page of them is read at
 * once and the rest a page at a time after it, RESERVE_PAGE_GAP_MS apart, so a vault older than the sixteen newest is
 * looked in too. A vault whose read failed keeps the last good read of it on screen, and is asked again on its own,
 * while the page is visible, for as long as the page stays open: it used to drop out of the card, and stop being asked
 * after three tries. */

/** An owner's vaults as a screen holds them across reads, newest first. */
export interface ReserveHold<V extends Pick<VaultReserveView, 'vault'>> {
  /** Every vault the factory lists for the owner, newest first (one, on a position's page). */
  order: readonly string[]
  /** The last good read of each vault that had one. */
  views: ReadonlyMap<string, V>
  /** Vaults not read yet: the pages after the first. */
  unread: readonly string[]
  /** Vaults whose last read failed. */
  failed: readonly string[]
  /** The owner created more vaults than the factory's nonce is turned into addresses for (RESERVE_VAULT_CAP). */
  beyond: boolean
}

/** A first page read: every vault the factory lists, what this read found, which failed, which are not read yet. */
export interface ReserveListing<V> {
  order: readonly string[]
  vaults: readonly V[]
  failed: readonly string[]
  unread: readonly string[]
  beyond: boolean
}

const inOrderOf = (order: readonly string[], wanted: ReadonlySet<string>) => order.filter((vault) => wanted.has(vault))

/**
 * A first page read, over what was held before: every vault this read found replaces its earlier read, and one it did
 * not read (failed, or a later page) keeps the earlier read until its own read says otherwise. A vault the factory no
 * longer lists is let go.
 */
export function holdReserves<V extends Pick<VaultReserveView, 'vault'>>(before: ReserveHold<V> | null, listing: ReserveListing<V>): ReserveHold<V> {
  const order = listing.order.map(lower)
  const listed = new Set(order)
  const views = new Map([...(before?.views ?? new Map<string, V>())].filter(([vault]) => listed.has(vault)))
  for (const view of listing.vaults) views.set(lower(view.vault), view)
  return {
    order,
    views,
    unread: inOrderOf(order, new Set(listing.unread.map(lower))),
    failed: inOrderOf(order, new Set(listing.failed.map(lower))),
    beyond: listing.beyond,
  }
}

/** A later read of `asked` (a page not read yet, or vaults whose read failed): each found replaces its earlier read, and each that failed keeps it. */
export function holdMore<V extends Pick<VaultReserveView, 'vault'>>(held: ReserveHold<V>, asked: readonly string[], found: { vaults: readonly V[]; failed: readonly string[] }): ReserveHold<V> {
  const done = new Set(asked.map(lower))
  const views = new Map(held.views)
  for (const view of found.vaults) if (held.order.includes(lower(view.vault))) views.set(lower(view.vault), view)
  const failed = new Set([...held.failed.filter((vault) => !done.has(vault)), ...found.failed.map(lower)])
  return { ...held, views, unread: held.unread.filter((vault) => !done.has(vault)), failed: inOrderOf(held.order, failed) }
}

/** Every vault read so far, newest first. */
export const heldVaults = <V extends Pick<VaultReserveView, 'vault'>>(held: ReserveHold<V>): V[] =>
  held.order.flatMap((vault) => {
    const view = held.views.get(vault)
    return view ? [view] : []
  })

/** How many vaults are still to be checked: those not read yet, and those whose reads all failed so far. */
export const stillChecking = <V extends Pick<VaultReserveView, 'vault'>>(held: ReserveHold<V>): number =>
  held.unread.length + held.failed.filter((vault) => !held.views.has(vault)).length

/**
 * What to read next, and how soon: the next page not read yet, at once; else the vaults whose read failed, after
 * reserveReaskMs. Null when every vault was read.
 */
export function nextReserveRead<V extends Pick<VaultReserveView, 'vault'>>(held: ReserveHold<V>, page: number): { vaults: string[]; again: boolean } | null {
  if (held.unread.length > 0) return { vaults: held.unread.slice(0, page), again: false }
  if (held.failed.length > 0) return { vaults: held.failed.slice(0, page), again: true }
  return null
}

/** The wait before the next page of vaults is read, so an owner with many vaults spreads their reads out over time. */
export const RESERVE_PAGE_GAP_MS = 1_000

/** The waits before a failed read is asked again, one after the other; the last one repeats for as long as the page is open. */
export const RESERVE_REASK_MS: readonly number[] = [3_000, 12_000, 30_000, 60_000, 120_000]
export const reserveReaskMs = (attempt: number): number => RESERVE_REASK_MS[Math.min(Math.max(0, attempt), RESERVE_REASK_MS.length - 1)]
