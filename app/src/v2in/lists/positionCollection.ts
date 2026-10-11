/** One presentation collection, including historical NFTs already proved by the existing inventory. */
import { POSITION_MANAGER } from '../../lib/fees/constants'
import type { WalletAnswer } from '../../lib/walletPositions'
import { positionOfState } from '../../lib/walletCards'
import { feeFromPips } from '../../lib/read/screens/fee'
import { amountShown, cleanSymbol, withTerminalEvidence, type PositionRowView, type TokenName } from './model'
import { minimumPositionBlock, positionKey, positionObservation } from './positionSync'
import { v2PositionHref } from '../route'
import type { Address } from '../../v2/types'
import { v2Chain } from '../../v2/chains'
import { createdPositionKey, type CreatedPosition } from './createdPositions'

/** A known mint is visible immediately, but only indexed state can supply liquidity, balances or APR. */
export function withCreatedPositions(rows: readonly PositionRowView[], creations: readonly CreatedPosition[]): PositionRowView[] {
  const merged = new Map(rows.map(row => [row.key, row]))
  for (const item of creations) {
    const key = createdPositionKey(item), old = merged.get(key)
    if (old?.status === 'live') continue
    const chain = v2Chain(item.chainId)
    merged.set(key, { key, positionManager: item.positionManager, block: null, chainId: item.chainId, chain: chain.name,
      dex: item.dex, dexName: `Uniswap v${item.dex}`, tokenId: item.tokenId,
      href: v2PositionHref({ chainId: item.chainId, dex: item.dex, tokenId: BigInt(item.tokenId) }),
      status: 'not_read', tab: 'pending', state: 'unread', fee: feeFromPips(item.fee),
      tokens: item.tokens.map(token => ({ chainId: item.chainId, address: token.address.toLowerCase() as Address,
        label: cleanSymbol(token.symbol) ?? `${token.address.slice(0, 6)}…${token.address.slice(-4)}`, symbol: cleanSymbol(token.symbol) !== null, decimals: token.decimals, usd: null })) as [TokenName, TokenName],
      unread: 'Updating position details.', value: null, fees: null, valueUsd: null, feesUsd: null,
      stale: 'Updating', vault: old?.vault ?? null, hooked: false, family: old?.family ?? null })
  }
  return [...merged.values()]
}

/** These are frontend rows, not fabricated read-v6 snapshots (the historical answer has no block hash). */
export function historicalPositionRows(answer: WalletAnswer | null, fresh: boolean): PositionRowView[] {
  if (!answer) return []
  return answer.positions.map((original) => {
    const identity = { chainId: 4663, positionManager: POSITION_MANAGER, tokenId: original.tokenId }
    const observed = positionObservation(identity)
    const useObserved = observed !== null && observed.block >= answer.block
    const position = useObserved ? positionOfState(observed.position) : original
    const block = useObserved ? observed.block : answer.block
    const pending = block < minimumPositionBlock(identity)
    const tokens = position.currencies.map((token): TokenName => ({ chainId: 4663, address: token.address as Address, label: cleanSymbol(token.symbol) ?? `${token.address.slice(0, 6)}…${token.address.slice(-4)}`, symbol: cleanSymbol(token.symbol) !== null, decimals: token.decimals, usd: null })) as [TokenName, TokenName]
    const liquidity = BigInt(position.liquidity)
    const inRange = position.tick !== null && position.tick >= position.tickLower && position.tick < position.tickUpper
    return withTerminalEvidence({
      ...identity, chainId: 4663, key: positionKey(identity), block, chain: 'Robinhood Chain', dex: 4, dexName: 'Uniswap v4',
      href: v2PositionHref({ chainId: 4663, dex: 4, tokenId: BigInt(position.tokenId) }),
      status: 'live', tab: liquidity > 0n ? 'open' : 'closed', tokens, fee: feeFromPips(position.fee),
      state: liquidity === 0n ? 'closed' : inRange ? 'in-range' : 'out-of-range', unread: null,
      value: position.principal ? [amountShown(position.principal[0], tokens[0]), amountShown(position.principal[1], tokens[1])] : null,
      fees: position.unclaimedFees ? [amountShown(position.unclaimedFees[0], tokens[0]), amountShown(position.unclaimedFees[1], tokens[1])] : null,
      valueUsd: null, feesUsd: null, stale: pending ? 'Updating' : fresh || useObserved ? null : 'Last available reading',
      vault: null, hooked: position.hooks !== '0x0000000000000000000000000000000000000000', family: null,
    })
  })
}

/** Newer qualified evidence wins; V2 contributes family metadata without deleting older valid NFTs. */
export function mergePositionRows(historical: readonly PositionRowView[], current: readonly PositionRowView[]): PositionRowView[] {
  const rows = new Map(historical.map((row) => [row.key, row]))
  for (const row of current) {
    const old = rows.get(row.key)
    if (old && old.block !== null && (row.block === null || row.block < old.block)) rows.set(row.key, { ...old, vault: row.vault, family: row.family, stale: row.stale ?? old.stale })
    else rows.set(row.key, row)
  }
  return [...rows.values()]
}

export function positionCounts(rows: readonly PositionRowView[]) {
  return rows.reduce((counts, row) => { counts[row.tab]++; return counts }, { open: 0, closed: 0, pending: 0 })
}

/** Existing exact-fees transport is Robinhood V4 only; never send an unrelated NFT with the same numeric id. */
export const hasPositionApr = (row: PositionRowView): boolean => row.chainId === 4663 && row.dex === 4 && row.positionManager.toLowerCase() === POSITION_MANAGER.toLowerCase() && !row.hooked
