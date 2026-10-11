import type { ConfirmedOperation, OperationReceipt, OperationScope } from '../../lib/confirmedOperations'
import type { FollowedReceipt } from '../journey/receiptFollow'

/** Continue only the exact inclusion verified by the original financial client, even after its screen closes. */
export function reconcileAutomationReceipt(operation: ConfirmedOperation, next: FollowedReceipt,
  record: (input: OperationScope & { chainId: number; wallet: string; receipt: OperationReceipt }) => unknown,
  reorg: (input: { chainId: number; wallet: string; hash: string; blockHash: string }) => unknown,
  current: ConfirmedOperation | null = operation): boolean {
  // An older in-flight read cannot revive or replace proof already superseded in the shared store.
  if (!current || current.chainId !== operation.chainId || current.wallet !== operation.wallet || current.hash !== operation.hash
    || current.blockHash !== operation.blockHash || current.block !== operation.block || current.phase !== 'included') return true
  const invalidate = () => reorg({ chainId: operation.chainId, wallet: operation.wallet, hash: operation.hash, blockHash: operation.blockHash })
  if (next.state === 'reorged' || next.state === 'reverted') { invalidate(); return true }
  if (next.state !== 'included' && next.state !== 'finalized') return false
  if (next.blockHash.toLowerCase() !== operation.blockHash || Number(next.blockNumber) !== operation.block
    || next.transactionHash?.toLowerCase() !== operation.hash) {
    // A replacement inclusion needs a new financial effect check.
    invalidate()
    return true
  }
  if (next.state !== 'finalized') return false
  record({ chainId: operation.chainId, wallet: operation.wallet, positionManager: operation.positionManager,
    tokenIds: operation.tokenIds, vault: operation.vault, receipt: { ...next, state: 'finalized', events: operation.events } })
  return true
}
