import type { ActivityResponse } from 'api-contracts/read-v6/types'
import type { ConfirmedOperation } from '../../lib/confirmedOperations'
import { V2_CHAINS } from '../../v2/chains'
import type { ActivityPosition } from './activityModel'

export interface SessionActivity {
  proof: ConfirmedOperation
  tokenId: string
  chain: string
}

/** A verified setup receipt is useful immediately, even before the public index catches up.
 * Keep its provenance: observation time is not a block timestamp and inclusion is not finality.
 */
export function sessionActivity(wallet: string | null, proofs: readonly ConfirmedOperation[], indexed: readonly ActivityResponse['items'][number][], position?: ActivityPosition): SessionActivity[] {
  if (!wallet) return []
  return proofs.flatMap(proof => {
    if (proof.wallet !== wallet.toLowerCase() || proof.phase === 'reorged' || !proof.vault || !proof.positionManager) return []
    const chain = V2_CHAINS.find(item => item.chainId === proof.chainId)
    if (!chain) return []
    const event = proof.events.find(item => item.eventName === 'Initialized' && item.address.toLowerCase() === proof.vault
      && String(item.args.owner).toLowerCase() === proof.wallet && proof.tokenIds.includes(String(item.args.rootTokenId)))
    if (!event) return []
    const dex = Number(event.args.dex)
    if (dex !== 3 && dex !== 4) return []
    if (chain.uniswap[dex === 3 ? 'v3' : 'v4'].positionManager.toLowerCase() !== proof.positionManager) return []
    const tokenId = String(event.args.rootTokenId)
    if (position && (position.chainId !== proof.chainId || position.dex !== dex || position.tokenId !== tokenId)) return []
    // Another log from this transaction is not proof that this setup has reached the index.
    if (indexed.some(item => item.kind === 'vault_created' && item.chainId === proof.chainId
      && item.tx.hash.toLowerCase() === proof.hash && item.tx.snapshot.hash.toLowerCase() === proof.blockHash && item.tx.snapshot.number === proof.block
      && item.vault.toLowerCase() === proof.vault && item.owner.toLowerCase() === proof.wallet && item.dex === dex && item.rootTokenId === tokenId)) return []
    return [{ proof, tokenId, chain: chain.name }]
  }).sort((a, b) => b.proof.at - a.proof.at)
}

/** Immediate and indexed records share one visible limit and one pagination control. */
export function activityWindow<I, R>(immediate: readonly I[], rows: readonly R[], shown: number) {
  return { immediate: immediate.slice(0, shown), visible: rows.slice(0, Math.max(0, shown - immediate.length)), total: immediate.length + rows.length, hidden: immediate.length + rows.length > shown }
}
