import type { ActivityResponse } from 'api-contracts/read-v6/types'
import { SETUP_DEPLOYED_BY } from '../../config/chainRobinhood'
import type { FeeEvent, FeeHistoryView, LedgerMintHint, LedgerWhy, StateCurrency } from '../fees/types'

const timestamp = (value: number | undefined): number | null => value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null

/** The NFT's mint, from its own ledger. First seen, a deposit and a vault registration are not a mint. */
export function ledgerOpenedAt(view: FeeHistoryView): number | null {
  if (view.phase === 'verified' || view.phase === 'cached') return timestamp(view.history.mintedAt.timestamp)
  if (view.phase === 'loading') return timestamp(view.mintedAt?.timestamp)
  if (view.phase === 'unclaimed-only') return timestamp(view.mintedAt?.timestamp) ?? timestamp(view.events?.find((event) => event.kind === 'mint')?.timestamp)
  return null
}

/**
 * The ledger's reasons for an inexact view whose settlements are still complete: the scan reached the head and found the
 * mint (functions/_lib/feesLedger.ts whyOf returns these only then), and only a settlement's fees are unknown. Every
 * other reason ('liquidity', 'unseen', 'before_floor', 'too_many', 'reading') is a ledger whose settlements do not prove
 * the NFT's liquidity, or a verdict with none.
 */
const COMPLETE_INEXACT: ReadonlySet<LedgerWhy> = new Set(['manual', 'native', 'shared'])

/** A final zero-liquidity interval, proved by this NFT's settlements. Missing state is never a close. */
export function ledgerClosedAt(view: FeeHistoryView): number | null {
  let events: ReadonlyArray<FeeEvent>
  if (view.phase === 'verified' || view.phase === 'cached') events = view.history.events
  // (2026-10-15, pack 7): every close is an owner's withdrawal ('manual'), so a closed NFT's view was never exact and the
  // chart waited on its closing history forever. A complete inexact ledger dates the close from the same settlements,
  // which must hold the mint, never go negative and sum to the state's zero.
  else if (view.phase === 'unclaimed-only' && view.reason === 'not_exact' && view.why !== undefined && COMPLETE_INEXACT.has(view.why) && view.events?.some((event) => event.kind === 'mint')) events = view.events
  else return null
  if (view.state.liquidity !== 0n) return null
  let liquidity = 0n
  let closed: number | null = null
  for (const event of events) {
    liquidity += event.liquidityDelta
    if (liquidity < 0n) return null
    if (liquidity > 0n) closed = null
    else if (event.liquidityDelta < 0n) closed = timestamp(event.timestamp)
  }
  return liquidity === 0n ? closed : null
}

/**
 * (2026-10-15, pack 7) A position minted before Domino's release: its ledger found no mint from SETUP_DEPLOY_BLOCK to the
 * head ('before_floor', decided only once the scan reached the head), so the NFT was minted before that block, at or
 * before SETUP_DEPLOYED_BY. A bound, never an opening time: it dates no "Opened" mark, and the chart draws the stored
 * window only when the bound is at or before its start (priceRange.ts historyLine). Null for anything else.
 */
export function ledgerOpenedBefore(view: FeeHistoryView): number | null {
  if (view.phase !== 'unclaimed-only' || view.reason !== 'not_exact' || view.why !== 'before_floor') return null
  if (view.mintedAt || view.events?.some((event) => event.kind === 'mint')) return null
  return SETUP_DEPLOYED_BY
}

export interface PoolPriceObservations {
  poolId: string
  currencies: readonly [StateCurrency, StateCurrency]
  opened: { t: number; sqrtPriceX96: string }
  current: { t: number; sqrtPriceX96: string }
}

/** Two actual block observations, independent of whether intervening fees can be qualified. */
export function ledgerPriceObservations(view: FeeHistoryView): PoolPriceObservations | null {
  if (view.phase !== 'verified' && view.phase !== 'loading' && view.phase !== 'unclaimed-only') return null
  const mint = view.phase === 'verified' ? view.history.mintedAt : view.mintedAt
  const state = view.state
  if (!mint?.sqrtPriceX96 || !state || mint.block > state.block || mint.timestamp >= state.timestamp) return null
  return { poolId: state.poolId, currencies: state.currencies, opened: { t: mint.timestamp, sqrtPriceX96: mint.sqrtPriceX96 }, current: { t: state.timestamp, sqrtPriceX96: state.sqrtPriceX96.toString() } }
}

/** A V2 mint for this exact chain + manager (DEX version) + NFT, or its identified vault's successor. */
interface PositionIdentity {
  chainId: number
  dex: 3 | 4
  tokenId: bigint | string
  vault: { address: string; role: 'root' | 'successor' } | null
}

function mints(answer: Pick<ActivityResponse, 'items'> | null, position: PositionIdentity) {
  if (!answer) return []
  const id = position.tokenId.toString()
  return answer.items.filter((item) => {
    if (item.chainId !== position.chainId) return false
    if (item.kind === 's1_action') return (item.action === 'create' || item.action === 'change_range') && item.tokenId === id && item.steps.some((step) => step.tokenId === id && step.pool.dex === position.dex)
    return item.kind === 'vault_execution' && item.action === 'mint' && item.successor?.tokenId === id && position.vault?.role === 'successor' && item.vault.toLowerCase() === position.vault.address.toLowerCase()
  })
}

export function activityOpenedAt(answer: Pick<ActivityResponse, 'items'> | null, position: PositionIdentity): number | null {
  const times = mints(answer, position).map((item) => timestamp(item.tx.snapshot.timestamp)).filter((time): time is number => time !== null)
  return times.length ? Math.min(...times) : null
}

export interface ActivityMint extends LedgerMintHint { timestamp: number }

/** Indexed evidence can date the price chart independently of fee accounting. The ledger verifies the NFT mint
 * on chain before using its block as a search boundary; this callback never qualifies financial figures. */
export function activityMint(answer: Pick<ActivityResponse, 'items'> | null, position: PositionIdentity): ActivityMint | null {
  const items = mints(answer, position).filter((item) => timestamp(item.tx.snapshot.timestamp) !== null).sort((a, b) => a.tx.snapshot.timestamp - b.tx.snapshot.timestamp)
  for (const item of items) {
    const block = Number(item.tx.snapshot.number)
    if (!Number.isSafeInteger(block) || block <= 0 || !/^0x[0-9a-f]{64}$/i.test(item.tx.hash)) continue
    return { tokenId: position.tokenId.toString(), block, tx: item.tx.hash.toLowerCase(), timestamp: item.tx.snapshot.timestamp }
  }
  return null
}
