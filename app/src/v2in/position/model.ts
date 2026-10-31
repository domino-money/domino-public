/**
 * What the position page's Domino V2 parts draw and act on (Domino V2 integration, 2026-10-02):
 *   - a position from the page's own V1 chain read (Robinhood Chain v4, lib/walletPositions.ts WalletPosition), or
 *   - a position read-v6 lists (spec F7 rev2 §6.2 `portfolio.positions`: v3, Base, Arbitrum One, and vault members),
 * as ONE shape the actions take (`ActionPosition`), with raw amounts as bigint and addresses lowercase. The read-v6 parsing
 * is the S1 reference's (the former src/v2ui/s1/model.ts), copied. A position the index could not read is said so, never drawn as
 * zeros; a symbol is untrusted text; decimals are null when unread, never guessed.
 *
 * Pure: no React, no wallet.
 */
import type { ActivityResponse, ChainStatus, PortfolioResponse, Position as V6Position, S1Action } from 'api-contracts/read-v6/types'
import type { WalletPosition } from '../../lib/walletPositions'
import { ZERO_ADDRESS, type Address, type Dex, type PoolRef, type V2ChainId } from '../../v2/types'
import { exitVaultOf, protectionStanding } from '../autoexit/standing'
import { USD_SHOWN } from './constants'
import { cleanSymbol, type PositionToken } from './tokens'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const lower = (value: string): Address => value.toLowerCase() as Address
const pair = (values: readonly string[]): readonly [bigint, bigint] | null => (values.length === 2 ? [BigInt(values[0]), BigInt(values[1])] : null)

/** The vault that administers a position, and how: its armed `root` (in the wallet, the vault approved) or a `successor`. */
export interface PositionVault {
  address: Address
  role: 'root' | 'successor'
  /** The root's custody as read-v6 last read it: true armed, false disarmed or lost, null unknown. */
  armed: boolean | null
  /**
   * Added 2026-10-06 (the integration review, rugged-literal #1): the vault is Auto-exit's own and its Auto-exit is on or
   * paused on this root (../autoexit/standing.ts), as read-v6 lists it. Its exit needs the position's approval alone, so
   * only an action that moves that approval pauses it; one that keeps it (Collect fees, Withdraw to both tokens) does not.
   */
  exitLive: boolean
}

/** One position, as every action takes it. */
export interface ActionPosition {
  chainId: V2ChainId
  dex: Dex
  tokenId: bigint
  /** The NFT's holder as read (a successor's is its vault). */
  owner: Address
  pool: PoolRef
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** The pool's price and tick as read with the position; null when not read. */
  sqrtPriceX96: bigint | null
  tick: number | null
  vault: PositionVault | null
  /** Where these figures come from: the page's own V1 chain read, or read-v6. */
  source: 'chain' | 'read6'
}

export const hookedPool = (pool: PoolRef): boolean => pool.dex === 4 && pool.hooks.toLowerCase() !== ZERO_ADDRESS

/**
 * A position of V1's page (Robinhood Chain v4, the page's own chain read) as the actions take it; null when its pool's
 * currencies are not in the pool's own order or an address is malformed, so nothing is ever acted on from a guess.
 */
export function fromWalletPosition(position: WalletPosition, owner: string): ActionPosition | null {
  // The pool's order is by address (currency0 < currency1); V1's read may list the pair the other way round (2026-10-02:
  // the owner's USDG / UFG page offered nothing). The same token twice is no pool.
  const [c0, c1] = [...position.currencies].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : BigInt(x.address) > BigInt(y.address) ? 1 : 0))
  if (!ADDRESS.test(c0.address) || !ADDRESS.test(c1.address) || !ADDRESS.test(position.hooks) || !ADDRESS.test(owner)) return null
  if (BigInt(c0.address) >= BigInt(c1.address)) return null
  if (!/^[1-9][0-9]{0,77}$/.test(position.tokenId) || !/^(0|[1-9][0-9]{0,77})$/.test(position.liquidity)) return null
  return {
    chainId: 4663,
    dex: 4,
    tokenId: BigInt(position.tokenId),
    owner: lower(owner),
    pool: { dex: 4, currency0: lower(c0.address), currency1: lower(c1.address), fee: position.fee, tickSpacing: position.tickSpacing, hooks: lower(position.hooks) },
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: BigInt(position.liquidity),
    sqrtPriceX96: position.sqrtPriceX96 === null ? null : BigInt(position.sqrtPriceX96),
    tick: position.tick,
    vault: null,
    source: 'chain',
  }
}

/**
 * (QA round 2, WD-MAX) The page's own read of what the position holds, in the pool's order (V1's read may list its
 * currencies the other way round), for Withdraw's "In this position"; null when the read gave no amounts, or when its
 * currencies are not the pool's two (then nothing is drawn: a figure is never put beside the wrong token).
 */
export function heldInPoolOrder(position: Pick<WalletPosition, 'principal' | 'currencies'>, currency0: string): readonly [bigint, bigint] | null {
  const held = position.principal
  if (!held || !/^\d+$/.test(held[0]) || !/^\d+$/.test(held[1])) return null
  const amounts: readonly [bigint, bigint] = [BigInt(held[0]), BigInt(held[1])]
  const [first, second] = position.currencies.map((currency) => currency.address.toLowerCase())
  const pool0 = currency0.toLowerCase()
  if (first === pool0) return amounts
  return second === pool0 ? [amounts[1], amounts[0]] : null
}

/** The page's tokens as the book takes them (V1's chain read: symbol and decimals as read). */
export function tokensOfWalletPosition(position: WalletPosition): PositionToken[] {
  return position.currencies.map((token) => ({ address: lower(token.address), symbol: cleanSymbol(token.symbol), decimals: token.decimals }))
}

// ---------------------------------------------------------------------------
// read-v6 (the S1 reference's model, copied)
// ---------------------------------------------------------------------------

export interface V6PositionView {
  chainId: V2ChainId
  dex: Dex
  tokenId: bigint
  manager: Address
  /** `live`: read at `snapshotBlock`; `unavailable` / `not_read`: nothing of it is drawn but its identity. */
  status: 'live' | 'unavailable' | 'not_read'
  freshness: { status: 'fresh' | 'stale'; ageSeconds: number } | null
  snapshotBlock: number | null
  owner: Address | null
  pool: PoolRef | null
  tickLower: number | null
  tickUpper: number | null
  liquidity: bigint | null
  sqrtPriceX96: bigint | null
  tick: number | null
  inRange: boolean | null
  /** What a collect would pay now, per pool currency; what removing everything pays at the spot price. */
  feesOwed: readonly [bigint, bigint] | null
  principal: readonly [bigint, bigint] | null
  custody: { approved: Address | null; subscriber: Address | null }
  vault: { address: Address; role: 'root' | 'successor' } | null
}

export type LiveV6Position = V6PositionView & { status: 'live'; owner: Address; pool: PoolRef; tickLower: number; tickUpper: number; liquidity: bigint; sqrtPriceX96: bigint; tick: number; inRange: boolean }
export const isLive = (position: V6PositionView): position is LiveV6Position => position.status === 'live'

function positionOf(item: V6Position): V6PositionView {
  const base: V6PositionView = {
    chainId: item.chainId,
    dex: item.dex,
    tokenId: BigInt(item.tokenId),
    manager: lower(item.positionManager),
    status: item.state.status,
    freshness: null,
    snapshotBlock: null,
    owner: null,
    pool: null,
    tickLower: null,
    tickUpper: null,
    liquidity: null,
    sqrtPriceX96: null,
    tick: null,
    inRange: null,
    feesOwed: null,
    principal: null,
    custody: { approved: null, subscriber: null },
    vault: item.vault ? { address: lower(item.vault.address), role: item.vault.role } : null,
  }
  const state = item.state
  if (state.status === 'unavailable') return { ...base, freshness: { status: state.freshness.status, ageSeconds: state.freshness.ageSeconds }, snapshotBlock: state.snapshot.number }
  if (state.status !== 'live') return base
  return {
    ...base,
    freshness: { status: state.freshness.status, ageSeconds: state.freshness.ageSeconds },
    snapshotBlock: state.snapshot.number,
    owner: lower(state.owner),
    pool: { dex: state.pool.dex, currency0: lower(state.pool.currency0), currency1: lower(state.pool.currency1), fee: state.pool.fee, tickSpacing: state.pool.tickSpacing, hooks: lower(state.pool.hooks) },
    tickLower: state.tickLower,
    tickUpper: state.tickUpper,
    liquidity: BigInt(state.liquidity),
    sqrtPriceX96: BigInt(state.sqrtPriceX96),
    tick: state.tick,
    inRange: state.inRange,
    feesOwed: pair(state.feesOwed),
    principal: pair(state.principalAtSpot),
    custody: { approved: state.custody.approved === null ? null : lower(state.custody.approved), subscriber: state.custody.subscriber === null ? null : lower(state.custody.subscriber) },
  }
}

/** One position of a read-v6 answer, by chain, DEX and id; null when the answer does not list it. */
export function findPosition(answer: Pick<PortfolioResponse, 'positions'>, chainId: V2ChainId, dex: Dex, tokenId: bigint): V6PositionView | null {
  const item = answer.positions.find((one) => one.chainId === chainId && one.dex === dex && BigInt(one.tokenId) === tokenId)
  return item ? positionOf(item) : null
}

/** The tokens a read-v6 answer names on one chain, with their metadata as the index read it. */
export function tokensOf(answer: Pick<PortfolioResponse, 'tokens'>, chainId: V2ChainId): PositionToken[] {
  // Changed on purpose 2026-10-06: with its qualified USD price (read-v6 1.1.0-rc.1), while the page shows USD.
  return answer.tokens.filter((token) => token.chainId === chainId).map((token) => ({ address: lower(token.address), symbol: cleanSymbol(token.symbol), decimals: token.decimals, usd: USD_SHOWN && token.price ? token.price.usd : null }))
}

/** That chain's status in the answer (§6.2: shown before any of its values). */
export function chainStatusOf(answer: Pick<PortfolioResponse, 'chains'>, chainId: V2ChainId): ChainStatus | null {
  return answer.chains.find((chain) => chain.chainId === chainId) ?? null
}

/**
 * A position's vault as the actions take it, from read-v6: for its root, whether read-v6 last read it armed
 * (`custody.armed`; null when it does not say) and whether Auto-exit is on or paused on it (`exitLive`).
 */
export function positionVault(answer: Pick<PortfolioResponse, 'vaults' | 'mandates'>, chainId: V2ChainId, vault: Pick<PositionVault, 'address' | 'role'> | null): PositionVault | null {
  if (!vault) return null
  const found = vault.role === 'root' ? answer.vaults.find((one) => one.chainId === chainId && one.address.toLowerCase() === vault.address) : undefined
  const exit = found ? protectionStanding(found, answer.mandates ?? []) : null
  return { ...vault, armed: found ? found.custody.armed : null, exitLive: exit === 'on' || exit === 'paused' }
}

/**
 * (QA round 2, N49) Whether `vault` makes the position the root of Auto-exit's own vault, as the listing says
 * (../autoexit/standing.ts exitVaultOf: paused, with Auto-exit's module on or an order listed on its root). Its subscriber
 * is then that vault, and collecting fees leaves Auto-exit on, so V1's Collect fees and Close position say nothing of
 * stopping automation. False for a successor, a vault not listed, and any other vault.
 */
export function autoExitRootOf(answer: Pick<PortfolioResponse, 'vaults' | 'mandates'>, chainId: V2ChainId, vault: Pick<PositionVault, 'address' | 'role'> | null): boolean {
  if (!vault || vault.role !== 'root') return false
  const found = answer.vaults.find((one) => one.chainId === chainId && one.address.toLowerCase() === vault.address.toLowerCase())
  return found !== undefined && exitVaultOf(found, answer.mandates ?? [])
}

/** A read-v6 position as the actions take it: live only (anything else is not acted on). */
export function fromV6(position: V6PositionView, answer: Pick<PortfolioResponse, 'vaults' | 'mandates'>): ActionPosition | null {
  if (!isLive(position)) return null
  return {
    chainId: position.chainId,
    dex: position.dex,
    tokenId: position.tokenId,
    owner: position.owner,
    pool: position.pool,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: position.liquidity,
    sqrtPriceX96: position.sqrtPriceX96,
    tick: position.tick,
    vault: positionVault(answer, position.chainId, position.vault),
    source: 'read6',
  }
}

/**
 * A vault's reserves as read-v6 read them (rev3 §2.13, §5.6): the fees its automation collected and had not reinvested
 * yet, listed from `portfolio.vaults` (by owner), not from the root's NFT. `reserves` null when the vault state was not
 * read (never a zero made up).
 */
export interface VaultReserves {
  chainId: V2ChainId
  vault: Address
  reserves: readonly { token: Address; amount: bigint }[] | null
}

export function vaultReservesOf(answer: Pick<PortfolioResponse, 'vaults'>, chainId: V2ChainId, vault: Address): VaultReserves | null {
  const found = answer.vaults.find((one) => one.chainId === chainId && one.address.toLowerCase() === vault)
  if (!found) return null
  return {
    chainId: found.chainId,
    vault: lower(found.address),
    reserves: found.state.status === 'read' ? found.state.reserves.map((reserve) => ({ token: lower(reserve.token), amount: BigInt(reserve.total) })) : null,
  }
}

/** The S1 receipts of one position on one chain in an activity page (`s1_action` items naming it, as the new or the previous NFT). */
export function actionsOfPosition(answer: Pick<ActivityResponse, 'items'>, chainId: V2ChainId, tokenId: bigint): S1Action[] {
  return answer.items.filter((item): item is S1Action => item.kind === 's1_action' && item.chainId === chainId && (BigInt(item.tokenId) === tokenId || (item.previousTokenId !== null && BigInt(item.previousTokenId) === tokenId)))
}
