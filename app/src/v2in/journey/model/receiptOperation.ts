import type { FinalityFollow, OperationReceipt, OperationScope } from '../../../lib/confirmedOperations'
import { walletReadsFinality } from '../../../config/receiptSources'

/**
 * Added (2026-10-15, pack 8 review, L1): what New position tells the confirmation queue (lib/confirmedOperations.ts) of a
 * receipt its money client checked in a block, on a chain whose finality the wallet reads (config/receiptSources.ts: Base,
 * Arbitrum One). Every such receipt goes, with the view's own read and check (`follow`), so its one read at finality
 * still catches a block that left the chain or a transaction found in another block: main's follow
 * (v2in/journey/receiptFollow.ts) followed every included receipt off Robinhood Chain until final. Pack 8 told the queue
 * only of a receipt its reader decoded with a new NFT, so one it could not decode, or that named no NFT, was followed by
 * nothing. `tokenIds`: the NFT the receipt names (its summary, or else the position manager's own mint log), none when it
 * names none. Null where the edge reads finality (Robinhood Chain: read-v6 lists the action, and the view ends at
 * inclusion), and for a receipt with no hash or not in a block with success. Pure.
 */
export function journeyOperation<R>(input: {
  chainId: number
  owner: string
  positionManager: string
  hash: string | null
  receipt: { state: string; blockNumber: bigint; blockHash: string }
  tokenIds: readonly string[]
  follow: FinalityFollow<R>
}): (OperationScope & { chainId: number; wallet: string; receipt: OperationReceipt; follow: FinalityFollow<R> }) | null {
  const { receipt } = input
  if (!walletReadsFinality(input.chainId) || !input.hash || (receipt.state !== 'included' && receipt.state !== 'finalized')) return null
  return {
    chainId: input.chainId, wallet: input.owner, positionManager: input.positionManager, tokenIds: [...input.tokenIds],
    receipt: { transactionHash: input.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, state: receipt.state },
    follow: input.follow,
  }
}
