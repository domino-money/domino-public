/** One presentation collection, including historical NFTs already proved by the existing inventory. */
import { POSITION_MANAGER } from '../../lib/fees/constants'
import type { WalletAnswer } from '../../lib/walletPositions'
import { positionOfState } from '../../lib/walletCards'
import { feeFromPips } from '../../lib/read/screens/fee'
import { amountShown, cleanSymbol, withTerminalEvidence, withUsd, type PositionRowView, type TokenName } from './model'
import { chainDollar } from '../usd'
import { POSITION_VALUATIONS, type PositionValuations } from './valuation'
import { minimumPositionBlock, positionKey, positionObservation, type PositionIdentity, type PositionObservation } from './positionSync'
import { v2PositionHref } from '../route'
import type { Address } from '../../v2/types'
import { v2Chain } from '../../v2/chains'
import { createdPositionKey, type CreatedPosition } from './createdPositions'

/**
 * A known mint is visible immediately, but only indexed state can supply liquidity, balances or APR.
 *
 * Changed on purpose (2026-10-15, pack 8): a Robinhood Chain hint (kept since this pack) is drawn from the state reading
 * the list already asks for every row it shows (`observationOf`, ./positionSync.ts), at or past the receipt's block and
 * held by the hint's wallet, exactly as a row of the site's own inventory is (historicalPositionRows): nothing is taken
 * from the receipt. Until that reading arrives it is the same placeholder row as on Base and Arbitrum One.
 */
export function withCreatedPositions(rows: readonly PositionRowView[], creations: readonly CreatedPosition[], observationOf: (identity: PositionIdentity) => PositionObservation | null = positionObservation): PositionRowView[] {
  const merged = new Map(rows.map(row => [row.key, row]))
  for (const item of creations) {
    const key = createdPositionKey(item), old = merged.get(key)
    if (old?.status === 'live') continue
    const observed = item.chainId === 4663 && item.dex === 4 && item.positionManager.toLowerCase() === POSITION_MANAGER.toLowerCase()
      ? observationOf({ chainId: 4663, positionManager: POSITION_MANAGER, tokenId: item.tokenId }) : null
    if (observed && observed.block >= item.block && observed.position.owner.toLowerCase() === item.wallet.toLowerCase()) {
      const [row] = historicalPositionRows({ owner: item.wallet.toLowerCase(), block: observed.block, positions: [positionOfState(observed.position)], deposits: [] }, true, null, observationOf)
      if (row) { merged.set(key, { ...row, vault: old?.vault ?? null, family: old?.family ?? null }); continue }
    }
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

/**
 * These are frontend rows, not fabricated read-v6 snapshots (the historical answer has no block hash).
 *
 * Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1): each row carries what the one valuation reads
 * (model.ts RowReading): its pool mark, which the inventory has always read with the amounts, and when it was read
 * (`readAt`, ms: when this page read the answer, lib/walletPositions.ts walletAnswerAt; the state route's own reading
 * carries its block's time). No dollars are worked out here: mergePositionRows values the row that is shown. Its tokens
 * carry no price but the chain's own dollar (../usd.ts chainDollar), for a position read-v6 does not list.
 *
 * Changed on purpose 2026-10-14 (package V1, review): the reading also says when this page took it, by its own clock
 * (`seen`), which for the inventory's own reading is the very `readAt` (`local`: its `at` is this page's clock). The
 * chain's dollar is a constant, as current as the amounts it meets, so nothing but the reading can grow old; and since
 * nothing polls the inventory, a row that only it supplies drew half-hour-old dollars as current while the state route
 * was refused. With `seen` the row says "as of" once nothing newer has arrived for two minutes (model.ts usdAsOf).
 * `observationOf`: where the newest state reading of an NFT is looked up; the collection hands in one that changes with
 * every reading (OwnedRows.tsx), so its rows are worked out again when one arrives, also with no portfolio answer held.
 */
export function historicalPositionRows(answer: WalletAnswer | null, fresh: boolean, readAt: number | null = null, observationOf: (identity: PositionIdentity) => PositionObservation | null = positionObservation): PositionRowView[] {
  if (!answer) return []
  return answer.positions.map((original) => {
    const identity = { chainId: 4663, positionManager: POSITION_MANAGER, tokenId: original.tokenId }
    const observed = observationOf(identity)
    const useObserved = observed !== null && observed.block >= answer.block
    const position = useObserved ? positionOfState(observed.position) : original
    const block = useObserved ? observed.block : answer.block
    const pending = block < minimumPositionBlock(identity)
    const tokens = position.currencies.map((token): TokenName => ({ chainId: 4663, address: token.address as Address, label: cleanSymbol(token.symbol) ?? `${token.address.slice(0, 6)}…${token.address.slice(-4)}`, symbol: cleanSymbol(token.symbol) !== null, decimals: token.decimals, usd: chainDollar(4663, token.address) })) as [TokenName, TokenName]
    const liquidity = BigInt(position.liquidity)
    const inRange = position.tick !== null && position.tick >= position.tickLower && position.tick < position.tickUpper
    const at = useObserved ? observed.timestamp : readAt === null ? null : Math.floor(readAt / 1000)
    const seen = useObserved ? observed.seen : readAt
    return withTerminalEvidence({
      ...identity, chainId: 4663, key: positionKey(identity), block, chain: 'Robinhood Chain', dex: 4, dexName: 'Uniswap v4',
      href: v2PositionHref({ chainId: 4663, dex: 4, tokenId: BigInt(position.tokenId) }),
      status: 'live', tab: liquidity > 0n ? 'open' : 'closed', tokens, fee: feeFromPips(position.fee),
      state: liquidity === 0n ? 'closed' : inRange ? 'in-range' : 'out-of-range', unread: null,
      value: position.principal ? [amountShown(position.principal[0], tokens[0]), amountShown(position.principal[1], tokens[1])] : null,
      fees: position.unclaimedFees ? [amountShown(position.unclaimedFees[0], tokens[0]), amountShown(position.unclaimedFees[1], tokens[1])] : null,
      valueUsd: null, feesUsd: null, stale: pending ? 'Updating' : fresh || useObserved ? null : 'Last available reading',
      // The dollar is a constant: as current as the amounts it meets.
      reading: { sqrt: position.sqrtPriceX96, at, quotedAt: at, seen, quotedSeen: seen, ...(useObserved ? {} : { local: true as const }), liquidity: position.liquidity, dollar: true },
      vault: null, hooked: position.hooks !== '0x0000000000000000000000000000000000000000', family: null,
    })
  })
}

/**
 * One row per NFT from Robinhood Chain's two inventories, valued once (model.ts withUsd), as the row that is shown.
 *
 * Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1). Until then the row with the newer block won
 * whole, and the site's own inventory rows carried no dollars at all: a position in both lists said "USD unavailable"
 * whenever the inventory's reading was the newer one (every arrival at the list, every action, and for as long as the
 * state route was refused). Now the fields are joined: amounts, range, state and block from the newest reading; prices,
 * vault and family from read-v6; and the joined row is valued like any other. read-v6's own row stays whole when its
 * reading is the newest. V2 contributes family metadata without deleting older valid NFTs.
 */
export function mergePositionRows(historical: readonly PositionRowView[], current: readonly PositionRowView[], valuations: PositionValuations = POSITION_VALUATIONS): PositionRowView[] {
  const rows = new Map(historical.map((row) => [row.key, row]))
  for (const row of current) {
    const old = rows.get(row.key)
    if (old && old.block !== null && (row.block === null || row.block < old.block)) rows.set(row.key, joined(old, row))
    else rows.set(row.key, row)
  }
  return [...rows.values()].map((row) => withTerminalEvidence(withUsd(row, valuations)))
}

/**
 * The inventory's newer reading with read-v6's prices for the same two tokens, its vault and its family.
 *
 * Changed on purpose 2026-10-14 (package V1, review): one clock. The inventory's own reading is dated by this page's
 * clock (it names no time), and read-v6's prices were dated by their answer's `servedAt`, rugged's server's clock: on a
 * device three minutes off the two were "more than two minutes apart" and the row lost its dollars for as long as the
 * state route was refused. Beside such a reading the prices are dated by when their answer arrived here (`quotedSeen`),
 * the same clock; beside a state reading (the chain's clock) they keep `servedAt`, as on every other row.
 */
function joined(old: PositionRowView, row: PositionRowView): PositionRowView {
  const next = { ...old, vault: row.vault, family: row.family, stale: row.stale ?? old.stale }
  // read-v6 said nothing of this position's tokens (it could not read it): the inventory's own row, as it is.
  if (!old.tokens || !old.reading || !row.tokens || !row.reading) return next
  const listed = old.tokens.map((token) => row.tokens!.findIndex((one) => one.address === token.address))
  if (listed.some((index) => index < 0)) return next
  const tokens = old.tokens.map((token, i) => ({ ...token, usd: row.tokens![listed[i]].usd })) as [TokenName, TokenName]
  const { dollar: _dollar, ...reading } = old.reading
  const { quotedAt, quotedSeen } = row.reading
  return { ...next, tokens, reading: { ...reading, quotedAt: quotedAt === null || !reading.local ? quotedAt : quotedSeen === null ? null : Math.floor(quotedSeen / 1000), quotedSeen, missing: listed.map((index) => row.reading!.missing?.[index] ?? null) } }
}

export function positionCounts(rows: readonly PositionRowView[]) {
  return rows.reduce((counts, row) => { counts[row.tab]++; return counts }, { open: 0, closed: 0, pending: 0 })
}

/** Existing exact-fees transport is Robinhood V4 only; never send an unrelated NFT with the same numeric id. */
export const hasPositionApr = (row: PositionRowView): boolean => row.chainId === 4663 && row.dex === 4 && row.positionManager.toLowerCase() === POSITION_MANAGER.toLowerCase() && !row.hooked
