import type { ActivityResponse } from 'api-contracts/read-v6/types'
import type { FeeHistoryView, LedgerMintHint, StateCurrency } from '../fees/types'

const timestamp = (value: number | undefined): number | null => value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null

/** The NFT's mint, from its own ledger. First seen, a deposit and a vault registration are not a mint. */
export function ledgerOpenedAt(view: FeeHistoryView): number | null {
  if (view.phase === 'verified' || view.phase === 'cached') return timestamp(view.history.mintedAt.timestamp)
  if (view.phase === 'loading') return timestamp(view.mintedAt?.timestamp)
  if (view.phase === 'unclaimed-only') return timestamp(view.mintedAt?.timestamp) ?? timestamp(view.events?.find((event) => event.kind === 'mint')?.timestamp)
  return null
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
