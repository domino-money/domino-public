import type { ActivityResponse } from 'api-contracts/read-v6/types'
import type { FeeHistoryView } from '../fees/types'

const timestamp = (value: number | undefined): number | null => value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null

/** The NFT's mint, from its own ledger. First seen, a deposit and a vault registration are not a mint. */
export function ledgerOpenedAt(view: FeeHistoryView): number | null {
  if (view.phase === 'verified' || view.phase === 'cached') return timestamp(view.history.mintedAt.timestamp)
  if (view.phase === 'unclaimed-only') return timestamp(view.events?.find((event) => event.kind === 'mint')?.timestamp)
  return null
}

/** A V2 mint for this exact chain + manager (DEX version) + NFT, or its identified vault's successor. */
export function activityOpenedAt(answer: Pick<ActivityResponse, 'items'> | null, position: {
  chainId: number
  dex: 3 | 4
  tokenId: bigint
  vault: { address: string; role: 'root' | 'successor' } | null
}): number | null {
  if (!answer) return null
  const id = position.tokenId.toString()
  const matches = answer.items.filter((item) => {
    if (item.chainId !== position.chainId) return false
    if (item.kind === 's1_action') return (item.action === 'create' || item.action === 'change_range') && item.tokenId === id && item.steps.some((step) => step.tokenId === id && step.pool.dex === position.dex)
    return item.kind === 'vault_execution' && item.action === 'mint' && item.successor?.tokenId === id && position.vault?.role === 'successor' && item.vault.toLowerCase() === position.vault.address.toLowerCase()
  })
  const times = matches.map((item) => timestamp(item.tx.snapshot.timestamp)).filter((time): time is number => time !== null)
  return times.length ? Math.min(...times) : null
}
